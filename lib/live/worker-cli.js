/**
 * External CLI worker backends (Codex CLI / Claude Code CLI). The DSH worker (worker.js) stays the default; these
 * adapters let a ticket run in a local CLI session and return the same shape ({sessionId,text,toolCalls,timedOut,...}).
 *
 * Security posture: the executor still owns git (commit/push/MR) and gates. Codex runs in its `workspace-write` sandbox
 * with network access disabled; Claude gets file tools only (Bash/network/agent tools are denied). Both run with the
 * ticket worktree as cwd, never shell-expanded.
 */
import { spawn as defaultSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const WORKER_BACKENDS = ['dsh', 'codex', 'claude']

/** Configured backend, or 'dsh' for the historical default and unknown values. */
export function workerBackendOf(config) {
  const backend = config?.executor?.workerBackend
  return WORKER_BACKENDS.includes(backend) ? backend : 'dsh'
}

/** Codex CLI is bundled inside the desktop apps on macOS; prefer those over a PATH lookup. */
const CODEX_APP_CANDIDATES = [
  '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
  '/Applications/OctoBuddy.app/Contents/Resources/runtime/node/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
]

/** Explicit live.json override first, then PATH, then known app bundles (Codex only). */
export function resolveCliCommand(backend, configured) {
  if (typeof configured === 'string' && configured.trim()) return configured.trim()
  if (backend === 'claude') return 'claude'
  return CODEX_APP_CANDIDATES.find(candidate => existsSync(candidate)) ?? 'codex'
}

/** Argv for one non-interactive CLI turn (exported for tests). */
export function cliInvocation(backend, { cwd, systemPrompt, task, model, lastFile }) {
  if (backend === 'claude') {
    const args = ['-p', task,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Edit,Write,Glob,Grep',
      '--disallowedTools', 'Bash,WebFetch,WebSearch,Task,Workflow,SendMessage,Skill,NotebookEdit,EnterWorktree,ExitWorktree,CronCreate,CronDelete,CronList,ScheduleWakeup,Monitor,ListAgents,TaskStop,ToolSearch,ReportFindings',
      '--append-system-prompt', systemPrompt]
    if (model) args.push('--model', model)
    return args
  }
  const prompt = `${systemPrompt}\n\n---\n\n${task}`
  const args = ['exec', '--skip-git-repo-check', '-C', cwd,
    '-s', 'workspace-write',
    '--ephemeral',
    '--json',
    '-o', lastFile,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false']
  if (model) args.push('-m', model)
  args.push(prompt)
  return args
}

/** Run one CLI process, bounded by timeoutMs; stdout/stderr are capped so a runaway CLI cannot exhaust memory. */
export function runProcess({ command, args, cwd, timeoutMs, spawnImpl = defaultSpawn }) {
  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawnImpl(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      if (error?.code === 'ENOENT') reject(new Error(`CLI not found: ${command}`))
      else reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let timer
    let killTimer
    const finish = (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      resolve({ code, signal, stdout, stderr, timedOut })
    }
    child.stdout?.on('data', chunk => { if (stdout.length < 8_000_000) stdout += String(chunk) })
    child.stderr?.on('data', chunk => { if (stderr.length < 200_000) stderr += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      if (error?.code === 'ENOENT') reject(new Error(`CLI not found: ${command}`))
      else reject(error)
    })
    child.on('close', finish)
    timer = setTimeout(() => {
      timedOut = true
      try { child.kill('SIGTERM') } catch { /* best effort */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* best effort */ } }, 3_000)
    }, Math.max(1_000, timeoutMs ?? 1_500_000))
    timer.unref?.()
    killTimer?.unref?.()
  })
}

/** Last structured final message from a Claude Code `--output-format stream-json` stream. */
export function parseClaudeStream(stdout) {
  let sessionId
  let text = ''
  let result
  const toolCalls = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (event.session_id) sessionId = event.session_id
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') text = block.text.trim()
        if (block?.type === 'tool_use' && typeof block.name === 'string' && !toolCalls.includes(block.name)) toolCalls.push(block.name)
      }
    }
    if (event.type === 'result') {
      result = event
      if (typeof event.result === 'string' && event.result.trim()) text = event.result.trim()
    }
  }
  return { sessionId, text, toolCalls, isError: result?.is_error === true, result }
}

/** Last structured message/tool list from a Codex `exec --json` stream (the -o file is the final fallback). */
export function parseCodexStream(stdout, lastMessage) {
  let sessionId
  let text = ''
  let isError = false
  const toolCalls = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id
    if (event.type === 'turn.failed' || event.type === 'error') isError = true
    const item = event.item
    if (!item || event.type !== 'item.completed') continue
    if (item.type === 'agent_message' && typeof item.text === 'string') text = item.text.trim()
    if (item.type === 'command_execution' && !toolCalls.includes('bash')) toolCalls.push('bash')
    if (item.type === 'file_change' && !toolCalls.includes('edit')) toolCalls.push('edit')
    if (item.type === 'mcp_tool_call' && typeof item.tool === 'string' && !toolCalls.includes(item.tool)) toolCalls.push(item.tool)
  }
  if (!text && typeof lastMessage === 'string') text = lastMessage.trim()
  return { sessionId, text, toolCalls, isError }
}

/** Run one ticket turn in a local CLI. Resolves the same worker shape the DSH worker returns. */
export async function runCliWorker({ backend, cwd, systemPrompt, task, model, command, timeoutMs = 1_500_000,
  sessionId, log = () => {}, spawnImpl = defaultSpawn }) {
  if (!WORKER_BACKENDS.includes(backend) || backend === 'dsh') throw new Error(`unsupported CLI worker backend: ${backend}`)
  const cli = resolveCliCommand(backend, command)
  const modelName = typeof model === 'string' ? model.trim() : ''
  const tempDir = mkdtempSync(join(tmpdir(), 'superagent-worker-'))
  const lastFile = join(tempDir, 'last-message.txt')
  const args = cliInvocation(backend, { cwd, systemPrompt, task, model: modelName, lastFile })
  try {
    log(`worker-cli: ${backend} ${cli} (${args.length} args)`)
    const proc = await runProcess({ command: cli, args, cwd, timeoutMs, spawnImpl })
    let lastMessage = ''
    if (backend === 'codex') {
      try { lastMessage = readFileSync(lastFile, 'utf8') } catch { /* no -o file on a failed turn */ }
    }
    const parsed = backend === 'codex' ? parseCodexStream(proc.stdout, lastMessage) : parseClaudeStream(proc.stdout)
    const error = proc.timedOut ? undefined
      : proc.code === 0 ? (parsed.isError ? `${backend} CLI reported an error: ${parsed.text || 'unknown error'}` : undefined)
        : `${backend} CLI exited with code ${proc.code}: ${String(proc.stderr).trim().slice(-600) || String(proc.stdout).trim().slice(-600)}`
    return { sessionId: parsed.sessionId ?? sessionId ?? `worker-${randomUUID().slice(0, 8)}`,
      text: parsed.text ?? '', toolCalls: parsed.toolCalls ?? [], reason: { backend, exitCode: proc.code },
      timedOut: proc.timedOut, backend, exitCode: proc.code, error }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
