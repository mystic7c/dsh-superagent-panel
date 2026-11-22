/**
 * Backend capability probe — where a backend's edit/exec/web capabilities come from (§3).
 *
 * The capability table in `routing.js` is a hint, never evidence: a bot may only require a
 * capability that a runtime probe (DSH, in-process) or a dated smoke run (Claude/Codex, CLI)
 * actually observed. Everything unobserved is `unverified` and cannot satisfy a bot.
 *
 * DSH is probed in-process from the preset's tool set, cached per (preset, host version) for the
 * lifetime of the process. CLI backends need a smoke run, whose evidence is persisted in
 * `<stateDir>/backend-verify.json` and invalidated whenever the CLI version changes.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileDurable } from './durable.js'
import { BACKEND_CAPABILITIES } from './routing.js'
import { BOT_CAPABILITIES, capabilitiesOf } from './worker-bot.js'

export const BACKEND_VERIFY_FILE = 'backend-verify.json'
export const BACKEND_VERIFY_VERSION = 1

/** Tool-name → capability map for the DSH backend (the only thing a probe reads). */
export const TOOL_CAPABILITIES = Object.freeze({
  edit: ['write', 'edit', 'multi_edit', 'multiedit', 'apply_patch', 'notebook_edit'],
  exec: ['bash'],
  web: ['web_search', 'web_fetch'],
})

/** @type {Map<string, object>} */
const probeCache = new Map()

export function clearProbeCache() {
  probeCache.clear()
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Names from the shapes a preset or tool service may expose; `undefined` means "cannot tell". */
export function toolNamesOf(source) {
  if (!source) return undefined
  const candidates = [
    source.toolNames,
    source.tools,
    source.agent?.tools,
    source.preset?.tools,
    source.definition?.tools,
  ]
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const names = candidate.map(item => (typeof item === 'string' ? item : item?.name)).filter(name => typeof name === 'string')
      if (names.length) return names
    }
    if (isObject(candidate)) {
      const names = Object.keys(candidate).filter(name => candidate[name] !== false)
      if (names.length) return names
    }
  }
  return undefined
}

/** Ask the host tools service about each tool name it could hold. `resolve(context)` is deliberately
 *  not an option: it needs a live Agent and a signal, and calling it bare rejects — an unawaited
 *  rejection exits the host, which is exactly how 1.0.16 died on the Bot page. */
function serviceToolNames(ctx) {
  const tools = ctx?.get?.('tools') ?? ctx?.tools
  if (!tools) return undefined
  const names = new Set()
  for (const method of ['definitions', 'schemas']) {
    try {
      const listed = tools[method]?.()
      if (!Array.isArray(listed)) continue
      for (const item of listed) {
        const name = typeof item === 'string' ? item : item?.name
        if (typeof name === 'string') names.add(name)
      }
    } catch { /* a probing failure is an unverified capability, never a crash */ }
  }
  if (typeof tools.get === 'function') {
    for (const candidates of Object.values(TOOL_CAPABILITIES)) {
      for (const name of candidates) {
        try {
          if (tools.get(name)) names.add(name)
        } catch { /* a probing failure is an unverified capability, never a crash */ }
      }
    }
  }
  return names.size ? [...names] : undefined
}

async function readiness(web, method) {
  try {
    const value = typeof web?.[method] === 'function' ? await web[method]() : web?.[method]
    return value === true || (isObject(value) && value.ready === true)
  } catch {
    return false
  }
}

/**
 * The running host's version, when it can be known (§3.7): probes are cached per version and a change makes the
 * previous evidence `stale`. This host exposes no version service, so the caller may inject one (`ctx.hostVersion`)
 * and the operator can pin one with `DSH_VERSION`; otherwise the version stays undefined and nothing claims a
 * version it cannot name.
 */
export function hostVersionOf(ctx) {
  const injected = ctx?.hostVersion
  if (typeof injected === 'function') {
    try {
      const value = injected()
      if (typeof value === 'string' && value.trim()) return value.trim()
    } catch { /* an injected resolver that throws is no version at all */ }
  }
  if (typeof injected === 'string' && injected.trim()) return injected.trim()
  const fromEnv = globalThis?.process?.env?.DSH_VERSION
  return typeof fromEnv === 'string' && fromEnv.trim() ? fromEnv.trim() : undefined
}

/** A fallback result: declared capabilities only, all unverified, never usable for a bot.
 *
 * @param {string} backend
 * @param {{preset?:string, version?:string, reason?:string}} [options]
 */
export function fallbackProbe(backend, { preset, version, reason } = {}) {
  const declared = BACKEND_CAPABILITIES[backend] ?? {}
  const capabilities = {}
  for (const capability of BOT_CAPABILITIES) capabilities[capability] = declared[capability] === true
  return {
    backend,
    preset,
    capabilities,
    unverified: BOT_CAPABILITIES.slice(),
    source: 'fallback',
    evidence: { backend, ...(version ? { version } : {}), ...(preset ? { preset } : {}), ...(reason ? { reason } : {}) },
    verifiedAt: new Date().toISOString(),
  }
}

/**
 * Probe the in-process DSH backend: read the preset's tool set, then ask the web service whether the
 * search/fetch providers behind the web tools are actually ready.
 *
 * @param {{ctx?:any, preset?:string, version?:string}} [options]
 */
export async function probeDsh({ ctx, preset, version } = {}) {
  const requested = typeof preset === 'string' && preset.trim() ? preset.trim() : undefined
  const presets = ctx?.get?.('agentPresets')
  if (!presets || typeof presets.resolve !== 'function') {
    return fallbackProbe('dsh', { preset: requested, version, reason: 'agentPresets.resolve 不可用' })
  }
  let resolved
  try {
    resolved = await presets.resolve(requested)
  } catch {
    resolved = undefined
  }
  if (!resolved) {
    return fallbackProbe('dsh', { preset: requested, version, reason: requested ? `preset 不存在：${requested}` : 'preset 解析失败' })
  }
  const presetId = resolved.id ?? requested
  const names = toolNamesOf(resolved) ?? serviceToolNames(ctx)
  if (!names) {
    return fallbackProbe('dsh', { preset: presetId, version, reason: '宿主未暴露工具清单，无法探测能力' })
  }
  const present = new Set(names)
  const capabilities = {}
  for (const capability of BOT_CAPABILITIES) {
    capabilities[capability] = TOOL_CAPABILITIES[capability].some(name => present.has(name))
  }
  const unverified = []
  const web = ctx?.get?.('web')
  if (capabilities.web) {
    const ready = (await readiness(web, 'searchReady')) && (!present.has('web_fetch') || (await readiness(web, 'fetchReady')))
    if (!ready) {
      capabilities.web = false
      unverified.push('web')
    }
  } else {
    unverified.push('web')
  }
  const evidence = {
    backend: 'dsh',
    ...(version ? { version } : {}),
    ...(presetId ? { preset: presetId } : {}),
    tools: names.slice(0, 40),
    ...(present.has('web_search') || present.has('web_fetch')
      ? { providers: { search: await readiness(web, 'searchReady'), fetch: await readiness(web, 'fetchReady') } }
      : {}),
  }
  return {
    backend: 'dsh',
    preset: presetId,
    capabilities,
    unverified,
    source: 'probe',
    evidence,
    verifiedAt: new Date().toISOString(),
  }
}

/**
 * Probe a backend. DSH is in-process and cached per (preset, host version); Claude/Codex require an
 * explicit smoke run, so without one they only ever get a fallback result.
 *
 * @param {{backend?:string, ctx?:any, preset?:string, version?:string, force?:boolean, smoke?:object}} [options]
 */
export async function probeBackend({ backend = 'dsh', ctx, preset, version, force = false, smoke } = {}) {
  const known = version ?? hostVersionOf(ctx)
  if (backend !== 'dsh') {
    if (isObject(smoke)) return smokeProbeOf(backend, smoke)
    // The persisted ledger is the only evidence a CLI backend ever has (§3.5): a recorded smoke run, per version.
    const entry = ctx?.stateDir ? readBackendVerify(ctx.stateDir).backends?.[backend] : undefined
    if (isObject(entry)) return smokeProbeOf(backend, entry)
    return fallbackProbe(backend, { version: known, reason: '缺少 smoke 证据' })
  }
  const key = `dsh|${preset ?? ''}|${known ?? ''}`
  if (!force && probeCache.has(key)) return probeCache.get(key)
  const result = await probeDsh({ ctx, preset, version: known })
  probeCache.set(key, result)
  return result
}

/** Turn one recorded smoke run into a probe result. `evidence.version` is what makes it go stale later. */
function smokeProbeOf(backend, entry) {
  const capabilities = isObject(entry.capabilities) ? entry.capabilities : {}
  const unverified = BOT_CAPABILITIES.filter(capability => capabilities[capability] !== true)
  return {
    backend,
    capabilities: Object.fromEntries(BOT_CAPABILITIES.map(capability => [capability, capabilities[capability] === true])),
    unverified,
    source: 'smoke',
    evidence: { backend, ...(entry.version ? { version: entry.version } : {}),
      ...(entry.command ? { command: entry.command } : {}), ...(entry.summary ? { smoke: entry.summary } : {}) },
    verifiedAt: entry.verifiedAt ?? new Date().toISOString(),
  }
}

/**
 * A probe result becomes `verified` only with evidence; a version change makes it `stale` (§3.7).
 *
 * @param {object} probe
 * @param {{version?:string}} [options]
 */
export function capabilityStateOf(probe, { version } = {}) {
  if (!probe || probe.source === 'fallback') return 'unverified'
  if (version && probe.evidence?.version && probe.evidence.version !== version) return 'stale'
  return 'verified'
}

export function verifiedAtOf(probe) {
  return typeof probe?.verifiedAt === 'string' ? probe.verifiedAt : undefined
}

export const probeCapabilities = capabilitiesOf

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

/** A smoke run is needed on first sight of a CLI version, and again after the version changes (§3.5). */
export function needsSmoke(ledger, backend, version) {
  const entry = ledger?.backends?.[backend]
  if (!entry) return true
  if (!version) return false
  return entry.version !== version
}

/**
 * Persist one smoke result. Evidence is version + timestamp + command + a short output summary; no
 * credentials, no environment, no full transcript.
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
