/**
 * One real smoke run for a CLI backend: start the CLI non-interactively with a trivial prompt, wait for it to answer,
 * and only then record evidence. Availability without evidence is a guess; this is the one place the guess is tested.
 *
 * The run is read-only and cheap (a single short reply), but it does spend a model call — so it happens once per CLI
 * version, on 核验 or when the engine starts with a CLI backend enabled and no valid evidence.
 */
import { spawn as defaultSpawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { cliVersionOf } from './backend-capability.js'
import { resolveCliCommand, workerEnv } from './worker-cli.js'

/** A CLI answering this is the evidence; "ok" anywhere is enough, models add words around it. */
const SMOKE_PROMPT = 'Reply with exactly: ok'
export const SMOKE_TIMEOUT_MS = 60_000

/** Argv that proves this backend can run without touching a repository. Exported so tests pin the shape. */
export function smokeArgs(backend) {
  if (backend === 'claude') return ['-p', SMOKE_PROMPT, '--output-format', 'text']
  if (backend === 'codex') return ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only',
    '-c', 'approval_policy="never"', SMOKE_PROMPT]
  return undefined
}

/** Run one CLI to completion with a deadline; capture stdout+stderr and whether it had to be killed. */
function runOnce(command, args, { spawnImpl, env, cwd, timeoutMs }) {
  return new Promise(resolve => {
    let child
    try {
      child = spawnImpl(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ code: null, timedOut: false, output: '', error })
      return
    }
    let output = ''
    let settled = false
    const done = value => { if (!settled) { settled = true; clearTimeout(timer); resolve(value) } }
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      done({ code: null, timedOut: true, output })
    }, timeoutMs)
    child.stdout?.on('data', chunk => { output += String(chunk) })
    child.stderr?.on('data', chunk => { output += String(chunk) })
    child.on('error', error => done({ code: null, timedOut: false, output, error }))
    child.on('close', code => done({ code: typeof code === 'number' ? code : null, timedOut: false, output }))
  })
}

/**
 * Probe one CLI backend and, on success, persist the evidence for the version that answered.
 *
 * @param {'claude'|'codex'} backend
 * @param {{ config?: any, stateDir?: string, timeoutMs?: number, spawnImpl?: Function, env?: any, cwd?: string }} [options]
 * @returns {Promise<{ ok: boolean, reason: string, version?: string, command?: string, summary?: string }>}
 */
export async function runBackendSmoke(backend, { config, stateDir, timeoutMs = SMOKE_TIMEOUT_MS,
  spawnImpl = defaultSpawn, env = workerEnv(), cwd = tmpdir() } = {}) {
  const args = smokeArgs(backend)
  if (!args) return { ok: false, reason: `后端 ${backend} 没有冒烟命令` }
  const command = resolveCliCommand(backend, config?.executor?.workers?.[backend]?.command)
  const version = /** @type {{ missing?: boolean, version?: string, executable?: string }} */ (cliVersionOf(command, { cache: false }))
  if (version.missing) return { ok: false, reason: `CLI 不在：${version.executable || command}` }
  const startedAt = Date.now()
  const run = await runOnce(command, args, { spawnImpl, env, cwd, timeoutMs })
  if (run.timedOut) {
    const tail = run.output.trim().split('\n').slice(-1)[0] ?? ''
    return { ok: false, version: version.version,
      reason: `CLI 超过 ${Math.round(timeoutMs / 1000)} 秒没有回答${tail ? `：${tail.slice(0, 160)}` : ''}` }
  }
  if (run.error) return { ok: false, reason: `CLI 无法启动：${run.error.message}`, version: version.version }
  if (run.code !== 0) {
    const tail = run.output.trim().split('\n').slice(-1)[0] ?? ''
    return { ok: false, reason: `CLI 退出码 ${run.code}${tail ? `：${tail.slice(0, 160)}` : ''}`, version: version.version }
  }
  const summary = run.output.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''
  // A zero exit is the CLI's claim; the answer is the proof the model behind it works.
  if (!/ok/i.test(run.output)) return { ok: false, reason: 'CLI 没有回答约定的 ok', version: version.version }
  const evidence = {
    backend,
    version: version.version,
    verifiedAt: new Date().toISOString(),
    command,
    summary: `${summary} (${Date.now() - startedAt} ms)`,
  }
  if (stateDir) {
    const { recordSmoke } = await import('./backend-capability.js')
    await recordSmoke(stateDir, backend, evidence)
  }
  return { ok: true, reason: `冒烟通过（CLI ${version.version ?? '未知'}）`, version: version.version, command, summary }
}
