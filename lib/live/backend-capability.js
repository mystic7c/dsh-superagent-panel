/**
 * Backend availability (worker-bots 1.5.0 §4).
 *
 * Dispatch asks exactly one hard question about a backend: can it run a bot **right now**?
 *   - `dsh`        — the preset resolves in-process (free, no subprocess);
 *   - CLI backends — a smoke run for the *current* CLI version is on record in `<stateDir>/backend-verify.json`.
 *
 * Four states, each with one sentence of reason: `available` joins the candidates, `unverified`
 * (no evidence), `checking` (version changed, old evidence is stale) and `missing` (CLI not found)
 * do not. Capabilities are no longer probed: a bot never declares one, and the tool surface is a
 * contract with the worker, not a sandbox (§5).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveCliCommand } from './worker-cli.js'
import { writeFileDurable } from './durable.js'

export const BACKEND_VERIFY_FILE = 'backend-verify.json'
export const BACKEND_VERIFY_VERSION = 1
export const AVAILABILITY_STATES = Object.freeze(['available', 'unverified', 'checking', 'missing'])
/** Why dispatch skipped a backend — the four reasons the execution page and the settings cards show. */
export const AVAILABILITY_REASONS = Object.freeze({
  available: '派单可用',
  unverified: '没有冒烟证据',
  checking: '版本变了，复核中',
  missing: 'CLI 不在',
})

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** `<cli> --version` is a subprocess: cache it briefly so a save or a bots view does not spawn one per card. */
const VERSION_TTL_MS = 30_000
/** @type {Map<string, {at:number, version?:string, missing:boolean, error?:string}>} */
const versionCache = new Map()

export function clearVersionCache() {
  versionCache.clear()
}

/** The CLI command an executor backend runs (`executor.workers.<backend>.command`, legacy `workerCommand`). */
/**
 * The command the executor will actually start. It must be the same resolution the worker uses — Codex prefers the
 * app-bundle binary over PATH — otherwise the panel probes one binary and the run uses another, and their versions
 * disagree forever (`0.171.0` vs `0.171.0-alpha.13.2` burned a whole smoke round).
 */
export function cliCommandOf(config, backend) {
  if (backend === 'dsh') return 'dsh'
  const declared = config?.executor?.workers?.[backend]?.command
  const legacy = config?.executor?.workerCommand
  const configured = typeof declared === 'string' && declared.trim() ? declared : legacy
  return resolveCliCommand(backend, configured)
}

function executableOf(command) {
  return String(command ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * Read one CLI's version. `missing` (ENOENT) is the only state that means "the CLI is not on this
 * machine"; a binary that exists but will not answer `--version` is reported without a version.
 */
export function cliVersionOf(command, { exec = spawnSync, cache = true } = {}) {
  const executable = executableOf(command)
  if (!executable) return { missing: true, error: '未配置 CLI 命令' }
  const cached = cache ? versionCache.get(executable) : undefined
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return { ...cached, executable }
  let result
  try {
    result = exec(executable, ['--version'], { encoding: 'utf8', timeout: 3000 })
  } catch (error) {
    result = { error: /** @type {any} */ (error) }
  }
  const missing = result?.error?.code === 'ENOENT'
  const text = `${result?.stdout ?? ''} ${result?.stderr ?? ''}`.trim()
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][\w.]+)?/)
  const value = { at: Date.now(), missing, ...(match ? { version: match[0] } : {}), ...(result?.error ? { error: result.error.message } : {}) }
  if (cache) versionCache.set(executable, value)
  return { ...value, executable, ...(text ? { raw: text.slice(0, 200) } : {}) }
}

/** DSH: available when the preset resolves in-process. No subprocess, no tool-name reading. */
async function dshAvailability({ ctx, preset }) {
  const service = ctx?.get?.('agentPresets')
  if (!service) return { state: 'unverified', reason: '宿主未暴露 agentPresets，无法确认预设能解析' }
  if (!preset) return { state: 'available', reason: '使用宿主默认预设' }
  let resolved
  let listed
  try {
    resolved = typeof service.resolve === 'function' ? await service.resolve(preset) : undefined
  } catch {
    resolved = undefined
  }
  if (resolved) return { state: 'available', reason: `预设 ${preset} 可解析` }
  try {
    const list = typeof service.list === 'function' ? await service.list() : undefined
    listed = (Array.isArray(list) ? list : []).map(item => (typeof item === 'string' ? item : item?.id))
  } catch {
    listed = undefined
  }
  if (Array.isArray(listed) && listed.includes(preset)) return { state: 'available', reason: `预设 ${preset} 可解析` }
  return { state: 'missing', reason: `预设 ${preset} 不存在` }
}

/** CLI: the persisted smoke row is the evidence, and it is only valid for the CLI version it was run on. */
function cliAvailability({ backend, config, stateDir, ledger, version }) {
  const command = cliCommandOf(config, backend)
  /** @type {any} */
  const probe = version ? { missing: false, version, executable: executableOf(command) } : cliVersionOf(command)
  if (probe.missing) return { state: 'missing', reason: `CLI 不在：${probe.executable || command}`, cliPath: command }
  const base = { cliPath: probe.executable || command, ...(probe.version ? { version: probe.version } : {}) }
  const entry = ledger?.backends?.[backend]
  if (!isObject(entry)) {
    return { ...base, state: 'unverified', reason: '没有冒烟证据（保存后端后会自动核验一次）' }
  }
  if (!probe.version) {
    return { ...base, state: 'unverified', reason: `无法读取 CLI 版本（${probe.executable} --version）` }
  }
  if (entry.version !== probe.version) {
    return { ...base, state: 'checking',
      reason: `CLI 版本已从 ${entry.version ?? '未知'} 变为 ${probe.version}，旧证据失效，复核期间跳过派单` }
  }
  return { ...base, state: 'available', reason: `冒烟证据有效（CLI ${probe.version}）`,
    ...(typeof entry.verifiedAt === 'string' ? { verifiedAt: entry.verifiedAt } : {}) }
}

/**
 * One backend's availability.
 *
 * @param {{backend?:string, ctx?:any, config?:any, stateDir?:string, preset?:string, version?:string,
 *   ledger?:object}} [options] `version`/`ledger` are test seams (skip the subprocess / the file).
 * @returns {Promise<{backend:string, state:string, reason:string, cliPath?:string, version?:string,
 *   verifiedAt?:string, preset?:string}>}
 */
export async function availabilityOf({ backend = 'dsh', ctx, config, stateDir, preset, version, ledger } = {}) {
  if (backend === 'dsh') {
    const answer = await dshAvailability({ ctx, preset })
    return { backend, ...answer, ...(preset ? { preset } : {}) }
  }
  const book = ledger ?? readBackendVerify(stateDir)
  return { backend, ...cliAvailability({ backend, config, stateDir, ledger: book, version }) }
}

/** The availability of the backend *a bot* would run on (a dsh bot may pin its preset). */
export async function botAvailability(bot, options = {}) {
  return availabilityOf({
    ...options,
    backend: bot?.backend ?? 'dsh',
    preset: bot?.backend === 'dsh' ? bot?.preset : undefined,
  })
}

/** Read the persisted smoke-evidence ledger; a missing or corrupt file is simply empty. */
export function readBackendVerify(stateDir) {
  const file = stateDir ? join(stateDir, BACKEND_VERIFY_FILE) : undefined
  const empty = { file, version: BACKEND_VERIFY_VERSION, backends: {} }
  if (!file || !existsSync(file)) return empty
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    if (!isObject(raw) || raw.version !== BACKEND_VERIFY_VERSION || !isObject(raw.backends)) return empty
    return { file, version: BACKEND_VERIFY_VERSION, backends: raw.backends }
  } catch {
    return empty
  }
}

/** A smoke run is needed on first sight of a CLI version, and again after the version changes (§4). */
export function needsSmoke(ledger, backend, version) {
  const entry = ledger?.backends?.[backend]
  if (!entry) return true
  if (!version) return false
  return entry.version !== version
}

/**
 * Persist one smoke result. Evidence is version + timestamp + command + a short output summary; no
 * credentials, no environment, no full transcript. `capabilities` is accepted and stored for older
 * ledger readers but is no longer consulted by dispatch.
 */
export async function recordSmoke(stateDir, backend, evidence) {
  if (!stateDir) throw new Error('recordSmoke: stateDir is required')
  const ledger = readBackendVerify(stateDir)
  const entry = {
    backend,
    version: evidence?.version,
    verifiedAt: evidence?.verifiedAt ?? new Date().toISOString(),
    command: evidence?.command,
    summary: evidence?.summary,
    capabilities: evidence?.capabilities,
  }
  ledger.backends[backend] = entry
  const payload = { version: BACKEND_VERIFY_VERSION, backends: ledger.backends }
  await writeFileDurable(join(stateDir, BACKEND_VERIFY_FILE), `${JSON.stringify(payload, undefined, 2)}\n`, { mode: 0o600 })
  return entry
}
