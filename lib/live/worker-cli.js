/**
 * External CLI worker backends (Codex CLI / Claude Code CLI). The DSH worker (worker.js) stays the default; these
 * adapters let a ticket run in a local CLI session and return the same shape ({sessionId,text,toolCalls,timedOut,...}).
 *
 * Security posture: the executor still owns git (commit/push/MR) and gates. Codex runs in its `workspace-write` sandbox
 * with network access disabled. Claude runs as the local Claude Code itself — its own tools, settings, MCP servers and
 * model config, with no tool allow-list or deny-list — because a restricted subset is not what delegating to Claude Code
 * means; a read-only turn is the exception and keeps plan mode. Both run with the ticket worktree as cwd, never
 * shell-expanded.
 */
import { spawn as defaultSpawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

/**
 * Reasoning-effort argv for one CLI backend (§9.3). `auto`/absent means no flag; Claude Code 2.1.329 supports
 * `--effort low|medium|high`. Codex's equivalent key is not verified yet, so it gets no flag (never a guess).
 */
export function effortArgs(backend, effort) {
  if (typeof effort !== 'string' || !effort || effort === 'auto') return []
  if (backend === 'claude' && ['low', 'medium', 'high'].includes(effort)) return ['--effort', effort]
  return []
}

/**
 * Argv for one non-interactive CLI turn (exported for tests). `bot='read-only'` keeps the CLI from writing.
 * `resume` continues one existing Claude Code conversation (repair rounds, and the same id an operator can open in a
 * terminal with `claude --resume <id>`); Codex has no verified equivalent, so it gets no resume flag.
 */
const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function cliInvocation(backend, { cwd, systemPrompt, task, model, lastFile, bot, schemaFile, reasoningEffort, resume }) {
  const readOnly = bot === 'read-only'
  const effort = effortArgs(backend, reasoningEffort)
  if (backend === 'claude') {
    const args = ['-p', task,
      '--output-format', 'stream-json',
      '--verbose',
      // Only a UUID is resumed: a run that lost its stream falls back to a synthetic `worker-xxxxxxxx` id, and
      // `--resume` treats an unknown value as a session *title* lookup, which would silently pick someone else's.
      ...CLAUDE_SESSION_ID.test(String(resume ?? '').trim()) ? ['--resume', String(resume).trim()] : [],
      // A write turn runs with the CLI's own tools and its own settings: that is the point of delegating to Claude Code,
      // so nothing is granted piecemeal and nothing is denied. Bypassing permissions is how a non-interactive turn gets
      // Bash/web/sub-agents at all — with `-p` any unapproved tool would otherwise be refused, not prompted.
      // Delivery stays with the executor regardless: the worker is handed a worktree, and commit/push/MR/gates remain
      // its own steps. A read-only turn keeps plan mode, so a review cannot edit the worktree.
      ...readOnly
        ? ['--permission-mode', 'plan', '--allowedTools', 'Read,Glob,Grep,Bash']
        : ['--permission-mode', 'bypassPermissions'],
      ...typeof systemPrompt === 'string' && systemPrompt.trim()
        ? ['--append-system-prompt', systemPrompt] : [],
      ...effort]
    // Claude Code enforces the same verdict schema the Codex path already uses; without it a review turn is free text.
    if (schemaFile) args.push('--json-schema', readFileSync(schemaFile, 'utf8'))
    if (model) args.push('--model', model)
    return args
  }
  const prompt = `${systemPrompt}\n\n---\n\n${task}`
  const args = ['exec', '--skip-git-repo-check', '-C', cwd,
    // read-only analysis/review never gets write access; development runs stay in workspace-write.
    '-s', readOnly ? 'read-only' : 'workspace-write',
    '--ephemeral',
    '--json',
    '-o', lastFile,
    '-c', 'approval_policy="never"',
    '-c', 'sandbox_workspace_write.network_access=false']
  if (schemaFile) args.push('--output-schema', schemaFile)
  if (model) args.push('-m', model)
  args.push(...effort)
  args.push(prompt)
  return args
}

/** Run one CLI process, bounded by timeoutMs; stdout/stderr are capped so a runaway CLI cannot exhaust memory.
 *  `onStdout` receives each raw chunk before the cap trims it, which is how a live trace follows the stream. */
export function runProcess({ command, args, cwd, timeoutMs, spawnImpl = defaultSpawn, maxStdout = 8_000_000, signal,
  onStdout }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({ code: 130, signal: 'SIGTERM', stdout: '', stderr: '', timedOut: false, aborted: true })
      return
    }
    let child
    try {
      // The CLI starts its own tool processes; run it in its own group so a stop can kill the whole tree (AC-03).
      // Unix-only: Windows has no negative-pid group kill, and detached would open a new console.
      child = spawnImpl(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32' })
    } catch (error) {
      if (/** @type {any} */ (error)?.code === 'ENOENT') reject(new Error(`CLI not found: ${command}`))
      else reject(error)
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let aborted = false
    let settled = false
    let timer
    let killTimer
    let hardTimer
    // Kill the CLI's process group, not just the direct child: its tool subprocesses write to the worktree too.
    const killTree = (signalName) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signalName)
        else child.kill(signalName)
      } catch { /* already gone */ }
    }
    const onAbort = () => {
      if (settled) return
      aborted = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => killTree('SIGKILL'), 3_000)
      killTimer.unref?.()
      // Settlement must not depend on 'close': a tool subprocess outside the group can hold the pipes open forever,
      // which would hang the worker invocation and keep the Ticket claim.
      hardTimer = setTimeout(() => finish(130, 'SIGTERM'), 10_000)
      hardTimer.unref?.()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const finish = (code, signalName) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardTimer)
      // The CLI closing first is not proof its process group is gone: a tool subprocess that ignores SIGTERM would
      // escape if the escalation timer were cleared here, so keep it armed for a stopped/timed-out tree (AC-03).
      if (!aborted && !timedOut) clearTimeout(killTimer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ code, signal: signalName, stdout, stderr, timedOut, ...(aborted ? { aborted: true } : {}) })
    }
    // Keep the TAIL when the cap is hit: Claude's stream-json emits one `thinking_tokens` event per token (hundreds of
    // bytes each), so a long review can cross the cap, and the `result` line holding the verdict is the very last one.
    child.stdout?.on('data', chunk => {
      const text = String(chunk)
      stdout += text
      if (stdout.length > maxStdout) stdout = stdout.slice(-maxStdout)
      // A throwing observer must not take the process down: the run continues, the trace just misses one entry.
      if (typeof onStdout === 'function') { try { onStdout(text) } catch { /* observer is best effort */ } }
    })
    child.stderr?.on('data', chunk => { if (stderr.length < 200_000) stderr += String(chunk) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(killTimer)
      clearTimeout(hardTimer)
      signal?.removeEventListener?.('abort', onAbort)
      if (/** @type {any} */ (error)?.code === 'ENOENT') reject(new Error(`CLI not found: ${command}`))
      else reject(error)
    })
    child.on('close', finish)
    timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      killTimer = setTimeout(() => killTree('SIGKILL'), 3_000)
      killTimer?.unref?.()
      hardTimer = setTimeout(() => finish(124, 'SIGKILL'), 10_000)
      hardTimer?.unref?.()
    }, Math.max(1_000, timeoutMs ?? 1_500_000))
    timer.unref?.()
  })
}

// ---------------------------------------------------------------------------
// Normalised worker events (P0 contract §1.1/§3.5): the CLI streams are parsed into {type,name,summary,state} entries,
// bounded at 80 and clipped to 300-character summaries, so the executor can store them as run.trace.
// ---------------------------------------------------------------------------

const TRACE_LIMIT = 80
const TRACE_SUMMARY_LIMIT = 300

const jsonOf = (value) => { try { return JSON.stringify(value) ?? '' } catch { return String(value) } }

const clipSummary = (value) => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : jsonOf(value)
  return text.length > TRACE_SUMMARY_LIMIT ? `${text.slice(0, TRACE_SUMMARY_LIMIT - 1)}…` : text
}

/** Keep only the newest entries while parsing, so a long stream cannot grow the event list without limit. */
function pushEvent(events, event) {
  events.push(event)
  if (events.length > TRACE_LIMIT) events.splice(0, events.length - TRACE_LIMIT)
}

/** Add the contract `at` timestamp and clip summaries; no structured events means an empty trace. */
function traceEvents(events) {
  return (Array.isArray(events) ? events : []).slice(-TRACE_LIMIT).map(event => ({
    type: event.type,
    at: new Date().toISOString(),
    ...event.name === undefined || event.name === null || event.name === '' ? {} : { name: String(event.name) },
    ...event.summary === undefined || event.summary === null || event.summary === '' ? {} : { summary: clipSummary(event.summary) },
    ...event.state === undefined || event.state === null || event.state === '' ? {} : { state: String(event.state) },
  }))
}

/** Last structured final message from a Claude Code `--output-format stream-json` stream. */
export function parseClaudeStream(stdout) {
  let sessionId
  let text = ''
  let result
  const toolCalls = []
  const events = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (event.session_id) sessionId = event.session_id
    if (event.type === 'assistant' && event.message?.content) {
      for (const block of Array.isArray(event.message.content) ? event.message.content : []) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          const value = block.text.trim()
          text = block.text.trim()
          if (value) pushEvent(events, { type: 'assistant', summary: value })
        }
        if (block?.type === 'tool_use' && typeof block.name === 'string') {
          if (!toolCalls.includes(block.name)) toolCalls.push(block.name)
          pushEvent(events, { type: 'tool_call', name: block.name,
            summary: typeof block.input === 'string' ? block.input : jsonOf(block.input) })
        }
      }
    }
    if (event.type === 'result') {
      result = event
      if (typeof event.result === 'string' && event.result.trim()) text = event.result.trim()
      // Structured output (`--json-schema`) carries the verdict object even when `result` is absent.
      else if (event.structured_output && typeof event.structured_output === 'object') text = JSON.stringify(event.structured_output)
      pushEvent(events, event.is_error === true
        ? { type: 'error', summary: event.result || 'claude CLI reported an error' }
        : { type: 'turn_end', summary: event.result || 'turn completed', state: 'completed' })
    }
  }
  return { sessionId, text, toolCalls, isError: result?.is_error === true, result, events }
}

/** Last structured message/tool list from a Codex `exec --json` stream (the -o file is the final fallback). */
export function parseCodexStream(stdout, lastMessage) {
  let sessionId
  let text = ''
  let isError = false
  const toolCalls = []
  const events = []
  for (const line of String(stdout ?? '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (event.type === 'thread.started' && event.thread_id) sessionId = event.thread_id
    if (event.type === 'turn.failed' || event.type === 'error') {
      isError = true
      pushEvent(events, { type: 'error', summary: event.message ?? event.error?.message ?? 'codex turn failed' })
    }
    if (event.type === 'turn.completed') pushEvent(events, { type: 'turn_end', summary: 'turn completed', state: 'completed' })
    const item = event.item
    if (!item || event.type !== 'item.completed') continue
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      text = item.text.trim()
      if (text) pushEvent(events, { type: 'assistant', summary: text })
    }
    if (item.type === 'command_execution' && !toolCalls.includes('bash')) toolCalls.push('bash')
    if (item.type === 'file_change' && !toolCalls.includes('edit')) toolCalls.push('edit')
    if (item.type === 'mcp_tool_call' && typeof item.tool === 'string' && !toolCalls.includes(item.tool)) toolCalls.push(item.tool)
    if (item.type === 'command_execution') {
      pushEvent(events, { type: 'tool_call', name: 'bash', summary: item.command ?? item.command_line ?? '' })
    } else if (item.type === 'file_change') {
      pushEvent(events, { type: 'tool_call', name: 'edit', summary: jsonOf(item.changes ?? '') })
    } else if (item.type === 'mcp_tool_call' && typeof item.tool === 'string') {
      pushEvent(events, { type: 'tool_call', name: item.tool, summary: jsonOf(item.arguments ?? item.result ?? '') })
    }
  }
  if (!text && typeof lastMessage === 'string') {
    text = lastMessage.trim()
    if (text) pushEvent(events, { type: 'assistant', summary: text })
  }
  return { sessionId, text, toolCalls, isError, events }
}

/** One line of a CLI stream → the trace entries it carries. The final parse re-reads the whole stream; this only lets
 *  the run view show progress while the CLI is still working. */
export function streamedEvents(backend, line) {
  const trimmed = String(line ?? '').trim()
  if (!trimmed.startsWith('{')) return []
  const parsed = backend === 'codex' ? parseCodexStream(trimmed) : parseClaudeStream(trimmed)
  // `at` is stamped by the run trace sink at the moment it stores the entry, so a streamed entry carries none.
  return traceEvents(parsed.events).map(({ at, ...entry }) => entry)
}

/** Run one ticket turn in a local CLI. Resolves the same worker shape the DSH worker returns. */
export async function runCliWorker({ backend, cwd, systemPrompt, task, model, reasoningEffort, command, timeoutMs = 1_500_000,
  sessionId, resume, bot, outputSchema, log = /** @type {(line: string) => void} */ (() => {}),
  spawnImpl = defaultSpawn, signal, onTrace }) {
  if (!WORKER_BACKENDS.includes(backend) || backend === 'dsh') throw new Error(`unsupported CLI worker backend: ${backend}`)
  const cli = resolveCliCommand(backend, command)
  const modelName = typeof model === 'string' ? model.trim() : ''
  const tempDir = mkdtempSync(join(tmpdir(), 'superagent-worker-'))
  const lastFile = join(tempDir, 'last-message.txt')
  const schemaFile = outputSchema ? join(tempDir, 'schema.json') : undefined
  if (schemaFile) writeFileSync(schemaFile, JSON.stringify(outputSchema))
  const args = cliInvocation(backend, { cwd, systemPrompt, task, model: modelName, lastFile, bot, schemaFile, reasoningEffort,
    resume })
  // Live trace: hand each completed JSON line to the caller while the process runs, so a CLI turn is not a black box
  // until it exits. The authoritative event list still comes from the full parse below.
  let pending = ''
  const emit = entry => { if (typeof onTrace === 'function') { try { onTrace(entry) } catch { /* trace is best effort */ } } }
  const onStdout = chunk => {
    pending += chunk
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) for (const event of streamedEvents(backend, line)) emit(event)
  }
  try {
    log(`worker-cli: ${backend}${bot ? ` (${bot})` : ''}${resume ? ` resume ${resume}` : ''} ${cli} (${args.length} args)`)
    const proc = await runProcess({ command: cli, args, cwd, timeoutMs, spawnImpl, signal, onStdout })
    // A CLI that exits without a trailing newline leaves its last event (usually the `result`) in the buffer.
    for (const line of pending.split('\n')) for (const event of streamedEvents(backend, line)) emit(event)
    pending = ''
    let lastMessage = ''
    if (backend === 'codex') {
      try { lastMessage = readFileSync(lastFile, 'utf8') } catch { /* no -o file on a failed turn */ }
    }
    const parsed = backend === 'codex' ? parseCodexStream(proc.stdout, lastMessage) : parseClaudeStream(proc.stdout)
    const error = proc.aborted ? 'stopped'
      : proc.timedOut ? undefined
        : proc.code === 0 ? (parsed.isError ? `${backend} CLI reported an error: ${parsed.text || 'unknown error'}`
          : parsed.text ? undefined
            // A silent empty answer is a CLI/stream problem, not a verdict: say so instead of letting JSON.parse say it.
            : `${backend} CLI returned no result text (stdout ${proc.stdout.length} bytes): ${String(proc.stderr).trim().slice(-300) || String(proc.stdout).trim().slice(-300) || 'empty stream'}`)
          : `${backend} CLI exited with code ${proc.code}: ${String(proc.stderr).trim().slice(-600) || String(proc.stdout).trim().slice(-600)}`
    return { sessionId: parsed.sessionId ?? sessionId ?? `worker-${randomUUID().slice(0, 8)}`,
      text: parsed.text ?? '', toolCalls: parsed.toolCalls ?? [], reason: { backend, exitCode: proc.code },
      timedOut: proc.timedOut, backend, exitCode: proc.code, error, events: traceEvents(parsed.events),
      // A CLI worker has no host tool registry, so it can never produce a report; the key stays for shape parity.
      report: undefined }
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}
