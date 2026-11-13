/**
 * Safe writes for the handful of live.json switches the panel exposes. Everything else (tokens, repo paths, URLs)
 * stays file-only: the UI cannot point the executor at another repository or read a secret through this path.
 */
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { defaultLiveConfig } from './config.js'
import { normalizeRepos, normalizeGates } from './repos.js'

const FIELDS = {
  'executor.workflowMode': ['executor', 'workflowMode', 'workflow-mode'],
  'executor.implementer': ['executor', 'implementer', 'implementer'],
  enabled: [null, 'enabled', 'boolean'],
  paused: [null, 'paused', 'boolean'],
  // Split switches: intake keeps the source cursor, dispatch keeps the queue and leaves running work alone.
  pausedIntake: [null, 'pausedIntake', 'boolean'],
  pausedDispatch: [null, 'pausedDispatch', 'boolean'],
  pollSeconds: [null, 'pollSeconds', 'number'],
  'octo.allowAnyHuman': ['octo', 'allowAnyHuman', 'boolean'],
  'octo.allowSenderIds': ['octo', 'allowSenderIds', 'strings'],
  'executor.enabled': ['executor', 'enabled', 'boolean'],
  'executor.autoRun': ['executor', 'autoRun', 'boolean'],
  'executor.allowPush': ['executor', 'allowPush', 'boolean'],
  'executor.allowReply': ['executor', 'allowReply', 'boolean'],
  'executor.allowMerge': ['executor', 'allowMerge', 'boolean'],
  // Worker backend selection + optional CLI path/model (contract §13). CLI execution is still sandboxed by the adapter.
  'executor.workerBackend': ['executor', 'workerBackend', 'worker-backend'],
  'executor.workerModel': ['executor', 'workerModel', 'string'],
  'executor.workerCommand': ['executor', 'workerCommand', 'string'],
  // P1 multi-backend routing: the whole workers map and routing table are one atomic patch each.
  'executor.workers': ['executor', 'workers', 'workers'],
  'executor.routing': ['executor', 'routing', 'routing'],
  // The run timeout was file-only until an operator needed to raise it after a worker timeout.
  'executor.timeoutMs': ['executor', 'timeoutMs', 'timeout-ms'],
  // A silent worker is declared lost after this window; editable so an operator can shorten the hang.
  'executor.workerIdleTimeoutMs': ['executor', 'workerIdleTimeoutMs', 'worker-idle-ms'],
  // Repair budget 0..6 (default 2) shared by gate auto-repair and the staged review loop.
  'executor.maxRepairRounds': ['executor', 'maxRepairRounds', 'repair-budget'],
  // Independent acceptance backend for the staged review (CLI backends only).
  'executor.reviewer': ['executor', 'reviewer', 'reviewer'],
  // Agent preset for in-process DSH workers; empty means the host default.
  'executor.workerPreset': ['executor', 'workerPreset', 'preset'],
  'gitlab.createMr': ['gitlab', 'createMr', 'mr-mode'],
  'gitlab.verifySeconds': ['gitlab', 'verifySeconds', 'number'],
  // Group ↔ repository bindings (contract §12). Editable from Settings so a new intake group needs no file edit.
  'octo.watchChatIds': ['octo', 'watchChatIds', 'strings'],
  'octo.chatTitles': ['octo', 'chatTitles', 'string-map'],
  'octo.chatRepos': ['octo', 'chatRepos', 'string-map'],
  // Group confirmation loop (review prompts): who may answer and how long a prompt stays answerable.
  'review.enabled': ['review', 'enabled', 'boolean'],
  'review.scope': ['review', 'scope', 'review-scope'],
  'review.allowSenderIds': ['review', 'allowSenderIds', 'strings'],
  'review.expireHours': ['review', 'expireHours', 'hours'],
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const WORKER_BACKENDS = ['dsh', 'codex', 'claude']
const ROUTING_MODES = ['single', 'suggest', 'auto']
const WORK_TYPES = ['analysis', 'review', 'test', 'dev', 'docs', 'research', 'interactive']

/** One `executor.workers.<backend>` entry as the panel sends it: enabled plus an optional CLI command/model. */
function validateWorkerEntry(key, backend, value) {
  if (!isObject(value)) throw new Error(`${key}.${backend} must be an object`)
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`${key}.${backend}.enabled must be a boolean`)
  for (const field of ['command', 'model']) {
    if (value[field] !== undefined && (typeof value[field] !== 'string' || /[\r\n]/.test(value[field]))) {
      throw new Error(`${key}.${backend}.${field} must be a single-line string`)
    }
  }
}

/** The routing table: which backend takes which work type, the default/fallback backend and the mode. */
function validateRouting(key, value) {
  if (!isObject(value)) throw new Error(`${key} must be an object`)
  if (value.mode !== undefined && !ROUTING_MODES.includes(value.mode)) {
    throw new Error(`${key}.mode must be one of "single", "suggest" or "auto"`)
  }
  if (value.defaultBackend !== undefined && !WORKER_BACKENDS.includes(value.defaultBackend)) {
    throw new Error(`${key}.defaultBackend must be one of "dsh", "codex" or "claude"`)
  }
  if (value.fallback !== undefined && !(Array.isArray(value.fallback) && value.fallback.every(backend => WORKER_BACKENDS.includes(backend)))) {
    throw new Error(`${key}.fallback must be an array of worker backends`)
  }
  if (value.preferences !== undefined) {
    if (!Array.isArray(value.preferences)) throw new Error(`${key}.preferences must be an array`)
    for (const rule of value.preferences) {
      if (!isObject(rule) || !WORKER_BACKENDS.includes(rule.backend)) {
        throw new Error(`${key}.preferences[].backend must be a worker backend`)
      }
      if (!Array.isArray(rule.workTypes) || !rule.workTypes.every(type => WORK_TYPES.includes(type))) {
        throw new Error(`${key}.preferences[].workTypes must be an array of work types`)
      }
    }
  }
}

function validate(key, value, kind) {
  if (kind === 'workflow-mode' && !['off', 'auto', 'simple', 'planned'].includes(value)) throw new Error('invalid workflow mode')
  if (kind === 'implementer' && !['dsh', 'claude'].includes(value)) throw new Error('invalid implementer')
  if (kind === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  if (kind === 'number' && (!Number.isFinite(value) || value < 2)) throw new Error(`${key} must be a number >= 2`)
  if (kind === 'strings' && !(Array.isArray(value) && value.every(item => typeof item === 'string' && item))) {
    throw new Error(`${key} must be an array of non-empty strings`)
  }
  if (kind === 'mr-mode' && value !== 'api' && value !== 'push') throw new Error(`${key} must be "api" or "push"`)
  if (kind === 'worker-backend' && !['dsh', 'codex', 'claude'].includes(value)) {
    throw new Error(`${key} must be one of "dsh", "codex" or "claude"`)
  }
  if (kind === 'workers') {
    if (!isObject(value) || !Object.keys(value).length) throw new Error(`${key} must be a non-empty object`)
    for (const [backend, entry] of Object.entries(value)) {
      if (!WORKER_BACKENDS.includes(backend)) throw new Error(`${key} must only name "dsh", "codex" or "claude"`)
      validateWorkerEntry(key, backend, entry)
    }
  }
  if (kind === 'routing') validateRouting(key, value)
  if (kind === 'timeout-ms' && (!Number.isInteger(value) || value < 60_000 || value > 86_400_000)) {
    throw new Error(`${key} must be whole milliseconds between 60000 and 86400000`)
  }
  if (kind === 'worker-idle-ms' && (!Number.isInteger(value) || value < 60_000 || value > 3_600_000)) {
    throw new Error(`${key} must be whole milliseconds between 60000 and 3600000`)
  }
  if (kind === 'repair-budget' && (!Number.isInteger(value) || value < 0 || value > 6)) {
    throw new Error(`${key} must be a whole number between 0 and 6`)
  }
  // The reviewer is an independent run: a local CLI (codex/claude) or an in-process DSH session with read-only tools.
  if (kind === 'reviewer' && !['codex', 'claude', 'dsh'].includes(value)) {
    throw new Error(`${key} must be "codex", "claude" or "dsh"`)
  }
  if (kind === 'preset' && (typeof value !== 'string' || /[\r\n]/.test(value))) {
    throw new Error(`${key} must be a single-line string`)
  }
  if (kind === 'review-scope' && value !== 'all' && value !== 'uncertain') {
    throw new Error(`${key} must be "all" or "uncertain"`)
  }
  if (kind === 'hours' && (!Number.isFinite(value) || !Number.isInteger(value) || value < 1 || value > 168)) {
    throw new Error(`${key} must be an integer between 1 and 168`)
  }
  if (kind === 'string' && (typeof value !== 'string' || /[\r\n]/.test(value))) {
    throw new Error(`${key} must be a single-line string`)
  }
  if (kind === 'string-map') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${key} must be an object`)
    for (const [mapKey, mapValue] of Object.entries(value)) {
      if (!mapKey.trim() || typeof mapValue !== 'string' || !mapValue.trim()) {
        throw new Error(`${key} must map non-empty strings to non-empty strings`)
      }
    }
  }
}

/**
 * Merge an allow-listed patch into `<stateDir>/live.json`, write it atomically with mode 600 and return the result.
 * Unknown keys are rejected rather than silently ignored, so a UI typo never looks like a successful save.
 */
export async function updateLiveConfig(stateDir, patch) {
  if (!isObject(patch)) throw new Error('settings patch must be an object')
  const keys = Object.keys(patch)
  if (!keys.length) throw new Error('settings patch is empty')
  for (const key of keys) if (!FIELDS[key]) throw new Error(`unsupported setting: ${key}`)
  const file = join(stateDir, 'live.json')
  let raw = {}
  try { raw = JSON.parse(await readFile(file, 'utf8')) } catch { /* a missing/broken file is rebuilt from the patch */ }
  if (!isObject(raw)) raw = {}
  const applied = []
  for (const key of keys) {
    const [section, field, kind] = FIELDS[key]
    validate(key, patch[key], kind)
    if (section === null) {
      raw[field] = patch[key]
    } else {
      if (!isObject(raw[section])) raw[section] = {}
      raw[section][field] = patch[key]
    }
    applied.push(key)
  }
  await snapshotLiveConfig(stateDir, `settings: ${keys.join(', ')}`)
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const tmp = join(stateDir, `.live-${process.pid}-${Date.now()}.json`)
  await writeFile(tmp, `${JSON.stringify(raw, undefined, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
  return { applied, raw }
}

/**
 * Store one token in the file the configuration already names (mode 600, atomic replace). An empty token removes the
 * file (disconnect). The path comes from configuration, never from the request, so this can only ever write to a file
 * the operator declared.
 */
export async function saveTokenFile(file, token) {
  if (typeof file !== 'string' || !file.trim()) throw new Error('tokenFile is not configured')
  const target = resolve(file.trim())
  const value = typeof token === 'string' ? token.trim() : ''
  if (!value) {
    await rm(target, { force: true })
    return { configured: false }
  }
  if (/\s/.test(value)) throw new Error('token must not contain whitespace')
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${value}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, target)
  return { configured: true }
}

/** Store one repository's GitLab token in the file its live.json entry names. */
export async function saveRepoToken(repo, token) {
  const file = repo?.gitlab?.tokenFile
  if (typeof file !== 'string' || !file.trim()) throw new Error(`repository ${repo?.id ?? ''} has no tokenFile configured`)
  return saveTokenFile(file, token)
}

/** Store the Octo bot token in the file the live config names (the same token file octo.js reads). */
export async function saveOctoToken(config, token) {
  const file = config?.octo?.tokenFile
  if (typeof file !== 'string' || !file.trim()) throw new Error('octo.tokenFile is not configured')
  return saveTokenFile(file, token)
}


/** Write one live.json document atomically with mode 600. */
async function writeLiveJson(file, value) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
}

const REPO_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/
const asText = (value, label) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`)
  return value.trim()
}
const asUrl = (value, label, required = false) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text && !required) return undefined
  if (!/^https?:\/\/[^\s]+$/i.test(text)) throw new Error(`${label} 必须是 http(s) 地址`)
  return text
}

/**
 * Add one repository definition to live.json. Repository fields are file-only by design, so this is the one place the
 * host extends that block; token values still go through saveRepoToken. Existing repositories are kept and normalised,
 * so a legacy single-repository file becomes a real `repos` array the first time a second repo is added.
 */
export async function addRepoDefinition(stateDir, input, { makeDefault = false } = {}) {
  const file = join(stateDir, 'live.json')
  let raw = {}
  try { raw = JSON.parse(await readFile(file, 'utf8')) } catch { /* missing/broken files are rebuilt from defaults */ }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) raw = {}
  const defaults = defaultLiveConfig(stateDir)
  const merged = {
    ...defaults,
    ...raw,
    octo: { ...defaults.octo, ...(raw.octo ?? {}) },
    gitlab: { ...defaults.gitlab, ...(raw.gitlab ?? {}) },
    executor: { ...defaults.executor, ...(raw.executor ?? {}) },
    repos: Array.isArray(raw.repos) ? raw.repos : [],
  }
  const current = normalizeRepos(merged)
  const id = asText(input?.id, '仓库 id')
  if (!REPO_ID.test(id)) throw new Error('仓库 id 只能使用小写字母、数字、点、下划线或短横线')
  if (current.repos.some(repo => repo.id === id)) throw new Error(`仓库 ${id} 已存在`)
  const kind = input?.kind === 'oracle-ebs' ? 'oracle-ebs' : 'web'
  if (input?.kind !== undefined && !['web', 'oracle-ebs'].includes(input.kind)) throw new Error('仓库 kind 只能是 web 或 oracle-ebs')
  const localPath = resolve(asText(input?.repo, '本地路径'))
  if (!existsSync(localPath) || !statSync(localPath).isDirectory()) throw new Error(`本地路径不存在或不是目录：${localPath}`)
  const baseUrl = asUrl(input?.gitlab?.baseUrl, 'GitLab 地址', true)
  const project = asText(input?.gitlab?.project, 'GitLab 项目')
  const targetBranch = asText(input?.gitlab?.targetBranch, '目标分支')
  const baseBranch = asText(input?.baseBranch ?? merged.baseBranch, '基础分支')
  const verifyMode = input?.verifyMode === 'manual' ? 'manual' : kind === 'oracle-ebs' ? 'manual' : 'web-uat'
  const acceptance = input?.acceptance === 'merged' || verifyMode === 'manual' ? 'merged' : 'deployed'
  const uatUrl = asUrl(input?.gitlab?.uatUrl, 'UAT 地址')
  const healthUrl = asUrl(input?.gitlab?.healthUrl, '健康检查地址')
  const candidate = {
    id,
    name: typeof input?.name === 'string' && input.name.trim() ? input.name.trim() : id,
    kind,
    repo: localPath,
    baseBranch,
    featurePrefix: typeof input?.featurePrefix === 'string' && input.featurePrefix.trim() ? input.featurePrefix.trim() : 'feature/',
    verifyMode,
    acceptance,
    gitlab: {
      baseUrl,
      project,
      targetBranch,
      createMr: 'api',
      tokenFile: join(stateDir, `gitlab-${id}.token`),
      ...(uatUrl ? { uatUrl } : {}),
      ...(healthUrl ? { healthUrl } : {}),
    },
  }
  const next = normalizeRepos({ ...merged, repos: [...current.repos, candidate],
    defaultRepo: makeDefault ? id : current.defaultRepo })
  const saved = next.repos.find(repo => repo.id === id)
  if (!saved) throw new Error('仓库定义校验失败')
  raw.repos = next.repos
  raw.defaultRepo = next.defaultRepo
  await snapshotLiveConfig(stateDir, `add repository ${id}`)
  await writeLiveJson(file, raw)
  return { repo: saved, defaultRepo: next.defaultRepo }
}


/**
 * Validate an edited gate list before it is saved. Unlike the read path (which must keep old files readable), a save
 * never silently falls back to the default gates: an empty/invalid list, a duplicate name, a bad timeout or a path
 * escaping the repository is an error the panel shows the operator.
 */
function validateGateList(gates, repoPath) {
  if (!Array.isArray(gates) || !gates.length) throw new Error('闸门列表不能为空')
  const seen = new Set()
  const root = repoPath ? resolve(repoPath) : undefined
  for (const gate of gates) {
    if (!gate || typeof gate !== 'object' || Array.isArray(gate)) throw new Error('闸门必须是对象')
    const name = typeof gate.name === 'string' ? gate.name.trim() : ''
    if (!name) throw new Error('闸门名称不能为空')
    if (seen.has(name)) throw new Error(`闸门名称重复：${name}`)
    seen.add(name)
    if (typeof gate.command !== 'string' || !gate.command.trim()) throw new Error(`闸门 ${name} 缺少命令`)
    if (/[\r\n]/.test(gate.command)) throw new Error(`闸门 ${name} 的命令必须是单行`)
    if (gate.onFail !== undefined && !['manual', 'auto_repair'].includes(gate.onFail)) {
      throw new Error(`闸门 ${name} 的失败策略只能是 manual 或 auto_repair`)
    }
    if (gate.timeoutMs !== undefined && (!Number.isFinite(gate.timeoutMs) || gate.timeoutMs <= 0)) {
      throw new Error(`闸门 ${name} 的超时必须是正数毫秒`)
    }
    if (gate.cwd !== undefined) {
      if (typeof gate.cwd !== 'string' || !gate.cwd.trim()) throw new Error(`闸门 ${name} 的目录不能为空`)
      const cwd = gate.cwd.trim()
      if (cwd.startsWith('/') || /^[A-Za-z]:[\\/]/.test(cwd)) throw new Error(`闸门 ${name} 的目录必须是相对路径`)
      if (root) {
        const target = resolve(root, cwd)
        if (target !== root && !target.startsWith(`${root}${sep}`)) {
          throw new Error(`闸门 ${name} 的目录越出了仓库范围`)
        }
        // Lexical resolution alone lets `cwd: 'link'` out through a symlink; resolve both sides when they exist.
        if (target !== root) {
          let realRoot
          let realTarget
          try { realRoot = realpathSync(root) } catch { /* root may not exist yet in tests */ }
          try { realTarget = realpathSync(target) } catch { /* a missing gate dir fails at execution, not at save */ }
          if (realRoot && realTarget && realTarget !== realRoot && !realTarget.startsWith(`${realRoot}${sep}`)) {
            throw new Error(`闸门 ${name} 的目录越出了仓库范围`)
          }
        }
      }
    }
  }
  return gates
}

/**
 * Edit one existing repository definition by id (AC-10): the id and all history stay, `enabled:false` only stops new
 * intake/dispatch. Editable fields are deliberately narrow — the local path, project, target branch and gate list.
 * Returns the normalised saved repo and the new default repository id.
 */
export async function updateRepoDefinition(stateDir, repoId, input = {}) {
  if (!REPO_ID.test(String(repoId ?? ''))) throw new Error('仓库 id 不合法')
  if (!isObject(input)) throw new Error('仓库修改必须是一个对象')
  const file = join(stateDir, 'live.json')
  let raw = {}
  try { raw = JSON.parse(await readFile(file, 'utf8')) } catch { /* missing/broken files are rebuilt from defaults */ }
  if (!isObject(raw)) raw = {}
  const defaults = defaultLiveConfig(stateDir)
  const merged = {
    ...defaults, ...raw,
    octo: { ...defaults.octo, ...(raw.octo ?? {}) },
    gitlab: { ...defaults.gitlab, ...(raw.gitlab ?? {}) },
    executor: { ...defaults.executor, ...(raw.executor ?? {}) },
    repos: Array.isArray(raw.repos) ? raw.repos : [],
  }
  const current = normalizeRepos(merged)
  const existing = current.repos.find(repo => repo.id === repoId)
  if (!existing) throw new Error(`未知仓库：${repoId}`)
  const candidate = { ...existing }
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('仓库名称不能为空')
    candidate.name = input.name.trim().slice(0, 80)
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值')
    candidate.enabled = input.enabled
  }
  if (input.repo !== undefined) {
    if (typeof input.repo !== 'string' || !input.repo.trim()) throw new Error('本地路径不能为空')
    const localPath = resolve(input.repo.trim())
    if (!existsSync(localPath) || !statSync(localPath).isDirectory()) throw new Error(`本地路径不存在或不是目录：${localPath}`)
    candidate.repo = localPath
  }
  if (input.baseBranch !== undefined) {
    if (typeof input.baseBranch !== 'string' || !input.baseBranch.trim()) throw new Error('基础分支不能为空')
    candidate.baseBranch = input.baseBranch.trim()
  }
  if (input.verifyMode !== undefined) {
    if (!['manual', 'web-uat'].includes(input.verifyMode)) throw new Error('verifyMode 只能是 manual 或 web-uat')
    candidate.verifyMode = input.verifyMode
  }
  if (input.acceptance !== undefined) {
    if (!['merged', 'deployed'].includes(input.acceptance)) throw new Error('acceptance 只能是 merged 或 deployed')
    candidate.acceptance = input.acceptance
  }
  if (input.gates !== undefined) {
    validateGateList(input.gates, candidate.repo)
    candidate.gates = normalizeGates(input.gates, candidate.kind)
  }
  if (input.prepareCommand !== undefined) {
    if (typeof input.prepareCommand !== 'string' || /[\r\n]/.test(input.prepareCommand)) throw new Error('prepareCommand 必须是单行字符串')
    candidate.prepareCommand = input.prepareCommand.trim()
  }
  if (input.postGatesCommand !== undefined) {
    if (typeof input.postGatesCommand !== 'string' || /[\r\n]/.test(input.postGatesCommand)) throw new Error('postGatesCommand 必须是单行字符串')
    candidate.postGatesCommand = input.postGatesCommand.trim()
  }
  if (input.gitlab !== undefined) {
    if (!isObject(input.gitlab)) throw new Error('gitlab 必须是对象')
    const gitlab = { ...candidate.gitlab }
    if (input.gitlab.project !== undefined) {
      if (typeof input.gitlab.project !== 'string' || !input.gitlab.project.trim()) throw new Error('GitLab 项目不能为空')
      gitlab.project = input.gitlab.project.trim()
    }
    if (input.gitlab.baseUrl !== undefined) gitlab.baseUrl = asUrl(input.gitlab.baseUrl, 'GitLab 地址', true)
    if (input.gitlab.targetBranch !== undefined) {
      if (typeof input.gitlab.targetBranch !== 'string' || !input.gitlab.targetBranch.trim()) throw new Error('目标分支不能为空')
      gitlab.targetBranch = input.gitlab.targetBranch.trim()
    }
    candidate.gitlab = gitlab
  }
  // Keep the raw fields the editor does not own (tokenFile, chat bindings, …) by merging the normalised repo back.
  const repos = current.repos.map(repo => repo.id === repoId ? candidate : repo)
  const next = normalizeRepos({ ...merged, repos })
  const saved = next.repos.find(repo => repo.id === repoId)
  if (!saved) throw new Error('仓库定义校验失败')
  raw.repos = next.repos
  raw.defaultRepo = next.defaultRepo
  await snapshotLiveConfig(stateDir, `update repository ${repoId}`)
  await writeLiveJson(file, raw)
  return { repo: saved, defaultRepo: next.defaultRepo }
}

const HISTORY_LIMIT = 30
// Same-millisecond snapshots must still sort deterministically: the name suffix is a monotonic counter, not only
// random, otherwise list/restore can pick the wrong "previous" version in a busy test or a fast settings loop.
let snapshotSequence = 0

/**
 * Copy the current live.json into the local rollback history (mode 600). The history keeps configuration only; token
 * values live in separate files and are never copied here. Missing/broken live.json is a no-op.
 */
export async function snapshotLiveConfig(stateDir, label) {
  const file = join(stateDir, 'live.json')
  let config
  try { config = JSON.parse(await readFile(file, 'utf8')) } catch { return undefined }
  if (!isObject(config)) return undefined
  const dir = join(stateDir, 'live-history')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  const at = new Date().toISOString()
  snapshotSequence += 1
  const id = `${Date.now()}-${String(snapshotSequence).padStart(6, '0')}-${Math.random().toString(36).slice(2, 8)}.json`
  await writeFile(join(dir, id), `${JSON.stringify({ at, label: String(label ?? '').slice(0, 160), config }, null, 2)}\n`,
    { mode: 0o600 })
  await chmod(join(dir, id), 0o600)
  const names = (await readdir(dir)).filter(name => name.endsWith('.json')).sort().reverse()
  for (const name of names.slice(HISTORY_LIMIT)) await rm(join(dir, name), { force: true })
  return { id, at, label: String(label ?? '') }
}

/** Newest-first list of saved configuration versions; entries never contain token values. */
export async function listLiveConfigHistory(stateDir) {
  const dir = join(stateDir, 'live-history')
  let names
  try { names = await readdir(dir) } catch { return [] }
  const entries = []
  for (const id of names.filter(name => name.endsWith('.json'))) {
    try {
      const data = JSON.parse(await readFile(join(dir, id), 'utf8'))
      if (!isObject(data?.config)) continue
      entries.push({ id, at: data.at, label: data.label ?? '' })
    } catch { /* skip a corrupted snapshot; one bad file must not hide the rest */ }
  }
  return entries.sort((left, right) => String(right.at).localeCompare(String(left.at)))
}

/** Restore one snapshot; the current file is snapshotted first, so a restore is itself undoable. */
export async function restoreLiveConfig(stateDir, rawId) {
  const id = String(rawId ?? '')
  if (id !== basename(id) || !id.endsWith('.json')) throw new Error('invalid history id')
  const file = join(stateDir, 'live-history', id)
  const data = JSON.parse(await readFile(file, 'utf8'))
  if (!isObject(data?.config)) throw new Error('history entry has no config')
  await snapshotLiveConfig(stateDir, 'before restore')
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  await writeLiveJson(join(stateDir, 'live.json'), data.config)
  return { id, at: data.at, label: data.label ?? '' }
}
