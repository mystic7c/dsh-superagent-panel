/**
 * Safe writes for the handful of live.json switches the panel exposes. Everything else (tokens, repo paths, URLs)
 * stays file-only: the UI cannot point the executor at another repository or read a secret through this path.
 */
import { readFile, writeFile, rename, mkdir, chmod, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { join } from 'node:path'

const FIELDS = {
  enabled: [null, 'enabled', 'boolean'],
  paused: [null, 'paused', 'boolean'],
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
  'gitlab.createMr': ['gitlab', 'createMr', 'mr-mode'],
  'gitlab.verifySeconds': ['gitlab', 'verifySeconds', 'number'],
  // Group ↔ repository bindings (contract §12). Editable from Settings so a new intake group needs no file edit.
  'octo.watchChatIds': ['octo', 'watchChatIds', 'strings'],
  'octo.chatTitles': ['octo', 'chatTitles', 'string-map'],
  'octo.chatRepos': ['octo', 'chatRepos', 'string-map'],
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

function validate(key, value, kind) {
  if (kind === 'boolean' && typeof value !== 'boolean') throw new Error(`${key} must be a boolean`)
  if (kind === 'number' && (!Number.isFinite(value) || value < 2)) throw new Error(`${key} must be a number >= 2`)
  if (kind === 'strings' && !(Array.isArray(value) && value.every(item => typeof item === 'string' && item))) {
    throw new Error(`${key} must be an array of non-empty strings`)
  }
  if (kind === 'mr-mode' && value !== 'api' && value !== 'push') throw new Error(`${key} must be "api" or "push"`)
  if (kind === 'worker-backend' && !['dsh', 'codex', 'claude'].includes(value)) {
    throw new Error(`${key} must be one of "dsh", "codex" or "claude"`)
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
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const tmp = join(stateDir, `.live-${process.pid}-${Date.now()}.json`)
  await writeFile(tmp, `${JSON.stringify(raw, undefined, 2)}\n`, { mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, file)
  return { applied, raw }
}

/**
 * Store one repository's GitLab token in the file its live.json entry names (mode 600, atomic replace).
 * An empty token removes the file (disconnect). The path comes from configuration, never from the request, so this
 * endpoint can only ever write to a token file the operator already declared.
 */
export async function saveRepoToken(repo, token) {
  const file = repo?.gitlab?.tokenFile
  if (typeof file !== 'string' || !file.trim()) throw new Error(`repository ${repo?.id ?? ''} has no tokenFile configured`)
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
