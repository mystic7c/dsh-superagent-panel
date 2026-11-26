/**
 * Worker bots — the declarative "Bot" layer (worker-bots 1.5.0 §3).
 *
 * A bot is data, never code: id / name / description / whenToUse / prompt.role, plus optional
 * backend / model / preset / skills / budget. Since 1.5.0 a bot declares **no capability and no
 * permission**: whether its backend can run right now is the availability probe's answer
 * (`backend-capability.js`), and which bot receives a ticket is the decision model reading
 * `whenToUse`. Dangerous behaviour is stopped in the system layer (gates, sandbox, deny rules).
 *
 * The store lives next to `live.json` in the plugin state dir (`<stateDir>/worker-bots.json`):
 * 0600, atomic temp+rename, and never a path inside a repository worktree (I7).
 */
import { createHash, randomBytes } from 'node:crypto'
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { renameDurable, writeFileDurable } from './durable.js'
import { REPAIR_LIMIT } from './repair.js'

export const BOT_FILE_VERSION = 3
export const BOT_FILE_NAME = 'worker-bots.json'
export const DEFAULT_BOT_ID = 'generalist'
export const BOT_BACKENDS = ['dsh', 'claude', 'codex']
export const BOT_EFFORTS = ['auto', 'low', 'medium', 'high']
export const BOT_ID_PATTERN = /^[a-z0-9-]{2,32}$/

/** Built-in ids that were removed by a later contract. A stored reference to one loads as absent (§7.4). */
export const REMOVED_BOT_IDS = Object.freeze(['surgical'])

export const BOT_LIMITS = Object.freeze({
  bots: 32,
  name: 40,
  description: 120,
  whenToUse: 300,
  modelProvider: 64,
  model: 128,
  preset: 64,
  prefer: 16,
  preferName: 64,
  role: 2000,
})

export const BOT_BUDGET = Object.freeze({
  timeoutMs: [60_000, 7_200_000],
  idleTimeoutMs: [60_000, 3_600_000],
  maxRepairRounds: [0, REPAIR_LIMIT],
})

/**
 * Stable key order: the file output and every digest must not depend on insertion order (§4.4.5).
 * 1.5.0 drops `requires`, `tools` and `prompt.must`; an old store file that still carries them loads,
 * the keys are reported through `droppedKeys` and never written back.
 */
const BOT_KEYS = ['id', 'name', 'description', 'whenToUse', 'backend', 'model', 'preset', 'skills', 'prompt', 'budget']

const BUILTIN_BOTS = Object.freeze([
  Object.freeze({
    id: 'generalist',
    name: '通用',
    description: '跟随宿主后端与模型，等同默认行为。',
    whenToUse: '实现类的活：改代码、补测试、跑闸门都派给我。要跨多个文件、拿不准改哪里的活优先给我。只审不改的活交给审阅者。',
    backend: 'dsh',
  }),
  Object.freeze({
    id: 'reviewer',
    name: '审阅者',
    description: '只读复核，产出报告。',
    whenToUse: '只审不改的活：看一处改动有没有风险，判一份报告、方案或结论靠不靠谱。需要落盘改动的活别派给我。',
    backend: 'dsh',
  }),
])

export const BUILTIN_BOT_IDS = Object.freeze(BUILTIN_BOTS.map(bot => bot.id))

export function isBuiltinBot(id) {
  return BUILTIN_BOT_IDS.includes(id)
}

export function isRemovedBot(id) {
  return REMOVED_BOT_IDS.includes(id)
}

/** Fresh copies, so a caller can never mutate the built-in definitions. */
export function builtinBots() {
  return BUILTIN_BOTS.map(bot => sortBot(normalizeBot(bot).bot))
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function clip(value, max) {
  return typeof value === 'string' && value.length > max
}

function trimmed(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueStrings(list) {
  const seen = new Set()
  const out = []
  for (const item of list) {
    if (typeof item !== 'string') continue
    const value = item.trim()
    if (!value || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

function sortKeys(source, keys) {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

/** Canonical JSON: sorted keys, no whitespace, no `undefined` — digests must be reproducible. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item === undefined ? null : item)).join(',')}]`
  const entries = Object.keys(value)
    .filter(key => value[key] !== undefined)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
  return `{${entries.join(',')}}`
}

export function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

/** Normalize one raw bot: whitelist, trim, lowercase, dedupe, truncate (§4.4.1–3). */
export function normalizeBot(raw) {
  const dropped = []
  const truncated = []
  const source = isObject(raw) ? raw : {}
  const bot = {}

  for (const key of Object.keys(source)) if (!BOT_KEYS.includes(key)) dropped.push(key)

  if (source.id !== undefined) {
    const id = trimmed(source.id)
    bot.id = typeof id === 'string' ? id.toLowerCase() : id
  }
  if (source.name !== undefined) {
    bot.name = trimmed(source.name)
    if (clip(source.name, BOT_LIMITS.name)) truncated.push('name')
    if (bot.name) bot.name = bot.name.slice(0, BOT_LIMITS.name)
  }
  if (source.description !== undefined) {
    bot.description = trimmed(source.description)
    if (clip(source.description, BOT_LIMITS.description)) truncated.push('description')
    if (bot.description) bot.description = bot.description.slice(0, BOT_LIMITS.description)
  }
  if (source.whenToUse !== undefined) {
    const whenToUse = trimmed(source.whenToUse)
    if (whenToUse) {
      bot.whenToUse = whenToUse.slice(0, BOT_LIMITS.whenToUse)
      if (clip(whenToUse, BOT_LIMITS.whenToUse)) truncated.push('whenToUse')
    }
  }
  if (source.backend !== undefined && typeof source.backend === 'string') bot.backend = source.backend.trim().toLowerCase()
  if (source.preset !== undefined) {
    const preset = trimmed(source.preset)
    if (preset) {
      bot.preset = preset.slice(0, BOT_LIMITS.preset)
      if (clip(preset, BOT_LIMITS.preset)) truncated.push('preset')
    }
  }
  if (isObject(source.model)) {
    const model = {}
    if (typeof source.model.provider === 'string' && source.model.provider.trim()) {
      const provider = source.model.provider.trim()
      model.provider = provider.slice(0, BOT_LIMITS.modelProvider)
      if (clip(provider, BOT_LIMITS.modelProvider)) truncated.push('model.provider')
    }
    if (typeof source.model.model === 'string' && source.model.model.trim()) {
      const name = source.model.model.trim()
      model.model = name.slice(0, BOT_LIMITS.model)
      if (clip(name, BOT_LIMITS.model)) truncated.push('model.model')
    }
    if (typeof source.model.reasoningEffort === 'string') {
      model.reasoningEffort = source.model.reasoningEffort.trim().toLowerCase()
    }
    for (const key of Object.keys(source.model)) {
      if (!['provider', 'model', 'reasoningEffort'].includes(key)) dropped.push(`model.${key}`)
    }
    if (Object.keys(model).length) bot.model = model
  } else if (source.model !== undefined) {
    dropped.push('model')
  }
  if (isObject(source.skills)) {
    const skills = {}
    if (Array.isArray(source.skills.prefer)) {
      const prefer = uniqueStrings(source.skills.prefer).slice(0, BOT_LIMITS.prefer)
        .map(name => name.slice(0, BOT_LIMITS.preferName))
      if (prefer.length) skills.prefer = prefer
      if (source.skills.prefer.length > BOT_LIMITS.prefer) truncated.push('skills.prefer')
    }
    if (typeof source.skills.policy === 'string') skills.policy = source.skills.policy.trim().toLowerCase()
    for (const key of Object.keys(source.skills)) if (!['prefer', 'policy'].includes(key)) dropped.push(`skills.${key}`)
    if (Object.keys(skills).length) bot.skills = skills
  } else if (source.skills !== undefined) {
    dropped.push('skills')
  }
  if (isObject(source.prompt)) {
    const prompt = {}
    if (typeof source.prompt.role === 'string' && source.prompt.role.trim()) {
      const role = source.prompt.role.trim()
      prompt.role = role.slice(0, BOT_LIMITS.role)
      if (clip(role, BOT_LIMITS.role)) truncated.push('prompt.role')
    }
    for (const key of Object.keys(source.prompt)) if (key !== 'role') dropped.push(`prompt.${key}`)
    if (Object.keys(prompt).length) bot.prompt = prompt
  } else if (source.prompt !== undefined) {
    dropped.push('prompt')
  }
  if (isObject(source.budget)) {
    const budget = {}
    for (const key of Object.keys(BOT_BUDGET)) {
      const value = source.budget[key]
      if (value !== undefined) budget[key] = value
    }
    for (const key of Object.keys(source.budget)) if (!(key in BOT_BUDGET)) dropped.push(`budget.${key}`)
    if (Object.keys(budget).length) bot.budget = budget
  } else if (source.budget !== undefined) {
    dropped.push('budget')
  }
  return { bot: sortBot(bot), dropped, truncated }
}

/** Fixed key order (and fixed nested order) so the on-disk file is reproducible. */
export function sortBot(bot) {
  const source = isObject(bot) ? bot : {}
  const out = sortKeys(source, BOT_KEYS)
  if (isObject(out.model)) out.model = sortKeys(out.model, ['provider', 'model', 'reasoningEffort'])
  if (isObject(out.skills)) out.skills = sortKeys(out.skills, ['prefer', 'policy'])
  if (isObject(out.prompt)) out.prompt = sortKeys(out.prompt, ['role'])
  if (isObject(out.budget)) out.budget = sortKeys(out.budget, ['timeoutMs', 'idleTimeoutMs', 'maxRepairRounds'])
  return sortKeys(out, BOT_KEYS)
}

export function normalizeBots(rawBots) {
  const list = Array.isArray(rawBots) ? rawBots : []
  const droppedKeys = []
  const truncated = []
  const warnings = []
  const seen = new Set()
  const bots = []
  for (const raw of list) {
    if (!isObject(raw)) {
      warnings.push('Bot 必须是对象，已忽略')
      continue
    }
    const { bot, dropped, truncated: cuts } = normalizeBot(raw)
    droppedKeys.push(...dropped)
    truncated.push(...cuts)
    if (!bot.id) {
      warnings.push('Bot 缺少 id，已忽略')
      continue
    }
    if (seen.has(bot.id)) {
      warnings.push(`Bot id 重复：${bot.id}，已忽略后一条`)
      continue
    }
    seen.add(bot.id)
    bots.push(bot)
  }
  return { bots, droppedKeys: uniqueStrings(droppedKeys), truncated: uniqueStrings(truncated), warnings }
}

function fail(code, message, extra) {
  return { ok: false, code, message, ...(extra ?? {}) }
}

/**
 * Validate one normalized bot.
 *
 * `environment` carries what only the runtime knows: `backendEnabled`, the host's preset catalogue
 * (`presets`) and each model's real effort list (`efforts`). Omitting it validates the declaration
 * only. Since 1.5.0 there is no capability check: a bot never declares one.
 */
export function validateBot(candidate, environment = {}) {
  if (!isObject(candidate)) return fail('BOT_SCHEMA_INVALID', 'Bot 必须是一个对象')
  const bot = sortBot(candidate)

  if (typeof bot.id !== 'string' || !BOT_ID_PATTERN.test(bot.id)) {
    return fail('BOT_ID_INVALID', 'Bot id 必须是小写 kebab（2–32 位字母数字或 -）')
  }
  if (typeof bot.name !== 'string' || !bot.name || bot.name.length > BOT_LIMITS.name) {
    return fail('BOT_SCHEMA_INVALID', `Bot 名称必填，且不超过 ${BOT_LIMITS.name} 字`)
  }
  if (bot.description !== undefined && (typeof bot.description !== 'string' || bot.description.length > BOT_LIMITS.description)) {
    return fail('BOT_SCHEMA_INVALID', `Bot 描述不超过 ${BOT_LIMITS.description} 字`)
  }
  if (bot.whenToUse !== undefined && (typeof bot.whenToUse !== 'string' || bot.whenToUse.length > BOT_LIMITS.whenToUse)) {
    return fail('BOT_SCHEMA_INVALID', `什么时候派给它不超过 ${BOT_LIMITS.whenToUse} 字`)
  }
  if (!BOT_BACKENDS.includes(bot.backend)) {
    return fail('BOT_SCHEMA_INVALID', `后端必须是 ${BOT_BACKENDS.join(' / ')}`)
  }
  if (bot.model !== undefined) {
    const model = bot.model
    if (!isObject(model) || typeof model.provider !== 'string' || !model.provider
      || typeof model.model !== 'string' || !model.model) {
      return fail('BOT_SCHEMA_INVALID', 'model 需要成对的 provider 与 model')
    }
    if (model.provider.length > BOT_LIMITS.modelProvider || model.model.length > BOT_LIMITS.model) {
      return fail('BOT_SCHEMA_INVALID', 'model 的 provider/model 过长')
    }
    if (model.reasoningEffort !== undefined && !BOT_EFFORTS.includes(model.reasoningEffort)) {
      return fail('BOT_EFFORT_UNSUPPORTED', `reasoningEffort 只支持 ${BOT_EFFORTS.join(' / ')}`)
    }
  }
  if (bot.preset !== undefined && (typeof bot.preset !== 'string' || bot.preset.length > BOT_LIMITS.preset)) {
    return fail('BOT_SCHEMA_INVALID', `preset 不超过 ${BOT_LIMITS.preset} 字`)
  }
  if (bot.skills !== undefined) {
    const skills = bot.skills
    if (!isObject(skills)) return fail('BOT_SCHEMA_INVALID', 'skills 必须是对象')
    if (skills.policy !== undefined && !['prompt', 'preset'].includes(skills.policy)) {
      return fail('BOT_SCHEMA_INVALID', 'skills.policy 只支持 prompt / preset')
    }
    if (skills.policy === 'preset' && !bot.preset) {
      return fail('BOT_SKILLS_PRESET_MISSING', 'skills.policy=preset 时必须显式指定 preset')
    }
    if (skills.prefer !== undefined && (!Array.isArray(skills.prefer) || skills.prefer.length > BOT_LIMITS.prefer)) {
      return fail('BOT_SCHEMA_INVALID', `skills.prefer 最多 ${BOT_LIMITS.prefer} 项`)
    }
  }
  if (bot.prompt !== undefined) {
    const prompt = bot.prompt
    if (!isObject(prompt)) return fail('BOT_PROMPT_INVALID', 'prompt 必须是对象')
    if (prompt.role !== undefined && (typeof prompt.role !== 'string' || prompt.role.length > BOT_LIMITS.role)) {
      return fail('BOT_PROMPT_INVALID', `prompt.role 不超过 ${BOT_LIMITS.role} 字`)
    }
  }
  if (bot.budget !== undefined) {
    const budget = bot.budget
    if (!isObject(budget)) return fail('BOT_BUDGET_INVALID', 'budget 必须是对象')
    for (const [key, [min, max]] of Object.entries(BOT_BUDGET)) {
      const value = budget[key]
      if (value === undefined) continue
      if (!Number.isInteger(value) || value < min || value > max) {
        return fail('BOT_BUDGET_INVALID', `budget.${key} 必须是 ${min}–${max} 的整数`)
      }
    }
  }
  if (environment.backendEnabled === false) {
    return fail('BOT_BACKEND_DISABLED', `后端 ${bot.backend} 未在 executor.workers 中启用`)
  }
  if (bot.preset && bot.backend !== 'dsh') {
    return fail('BOT_PRESET_UNKNOWN', 'preset 只对 dsh Bot 生效')
  }
  if (environment.presetKnown === false) {
    return fail('BOT_PRESET_UNKNOWN', `宿主不存在 preset：${bot.preset}`)
  }
  if (bot.preset && Array.isArray(environment.presets) && !environment.presets.includes(bot.preset)) {
    return fail('BOT_PRESET_UNKNOWN', `宿主不存在 preset：${bot.preset}`)
  }
  const effort = bot.model?.reasoningEffort
  if (effort && effort !== 'auto') {
    if (environment.effortSupported === false) {
      return fail('BOT_EFFORT_UNSUPPORTED', `后端 ${bot.backend} 不支持 reasoningEffort`)
    }
    const modelKey = bot.model?.provider && bot.model?.model
      ? `${bot.model.provider}/${bot.model.model}` : undefined
    const accepted = modelKey && isObject(environment.efforts) ? environment.efforts[modelKey] : undefined
    if (Array.isArray(accepted) && !accepted.includes(effort)) {
      return fail('BOT_EFFORT_UNSUPPORTED', `模型 ${modelKey} 不支持 reasoningEffort：${effort}`)
    }
  }
  return { ok: true, bot }
}

/** The execution parameters a bot contributes, with nothing defaulted (the caller owns defaults). */
export function paramsOfBot(bot) {
  const budget = isObject(bot?.budget) ? bot.budget : {}
  const model = isObject(bot?.model) ? bot.model : undefined
  return {
    preset: typeof bot?.preset === 'string' ? bot.preset : undefined,
    model: model && typeof model.provider === 'string' && typeof model.model === 'string'
      ? { provider: model.provider, model: model.model }
      : undefined,
    reasoningEffort: typeof model?.reasoningEffort === 'string' ? model.reasoningEffort : undefined,
    budget: {
      timeoutMs: Number.isInteger(budget.timeoutMs) ? budget.timeoutMs : undefined,
      idleTimeoutMs: Number.isInteger(budget.idleTimeoutMs) ? budget.idleTimeoutMs : undefined,
      maxRepairRounds: Number.isInteger(budget.maxRepairRounds) ? budget.maxRepairRounds : undefined,
    },
  }
}

/**
 * Resolve one bot into the options a worker invocation receives (§5).
 *
 * `context` carries executor defaults and the run's own constraints: `denyTools` (the system's hard
 * deny list — not a bot property), `preset`, the three budget defaults and `readOnly` (a report run).
 */
export function resolveBot(bot, context = {}) {
  const params = paramsOfBot(bot)
  return {
    id: bot.id,
    backend: bot.backend,
    model: params.model,
    preset: params.preset ?? context.preset,
    denyTools: [...new Set(context.denyTools ?? [])],
    readOnly: context.readOnly === true,
    systemPromptExtra: {
      role: bot.prompt?.role ?? '',
      skills: Array.isArray(bot.skills?.prefer) ? bot.skills.prefer.slice() : [],
    },
    budget: {
      timeoutMs: params.budget.timeoutMs ?? context.timeoutMs,
      idleTimeoutMs: params.budget.idleTimeoutMs ?? context.idleTimeoutMs,
      maxRepairRounds: params.budget.maxRepairRounds ?? context.maxRepairRounds,
    },
  }
}

function botError(code, message, problems) {
  const error = /** @type {Error & {code:string, problems?:string[]}} */ (new Error(message))
  error.code = code
  if (problems) error.problems = problems
  return error
}

/** The bot file lives beside live.json, so it must not be able to replace any file the state directory already owns
 *  (its own default name `worker-bots.json` is the one legitimate occupant). */
// Every ledger the engine writes into the state dir: a Bot file with one of these names would overwrite live data on
// save (review P2 — the inbox/acceptance/signal ledgers were missing).
const RESERVED_STATE_FILES = new Set([
  'live.json', 'live-state.json', 'live-state.json.tmp', 'operations.json',
  'inbox.json', 'acceptance.json', 'signal-log.json',
  'shadow-samples.json', 'backend-verify.json', 'octo.token', 'decision.token',
  'live-history', 'runs', 'evidence', 'worktrees',
])

/** `executor.botsFile` is a bare filename: a path here would let a repo reach outside the state dir. */
export function botsFileOf(config) {
  const raw = config?.executor?.botsFile
  if (raw === undefined || raw === null || raw === '') return { name: BOT_FILE_NAME, error: undefined }
  if (typeof raw !== 'string') return { name: BOT_FILE_NAME, error: 'executor.botsFile 必须是文件名' }
  const name = raw.trim()
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return { name: BOT_FILE_NAME, error: 'executor.botsFile 只能是 stateDir 下的文件名（不能带路径）' }
  }
  // A bare filename was still enough to be catastrophic: pointing it at live.json made every Bot save rename a bot
  // document over the configuration and the tickets. Reserved names and token files are refused here.
  if (RESERVED_STATE_FILES.has(name.toLowerCase()) || /\.token$/i.test(name)) {
    return { name: BOT_FILE_NAME, error: `executor.botsFile 不能用 stateDir 的保留文件名：${name}` }
  }
  return { name, error: undefined }
}

export function botsPath(stateDir, config) {
  return join(stateDir, botsFileOf(config).name)
}

/**
 * Parse a bots document. Unknown keys are reported, invalid bots are dropped with a warning,
 * but a corrupt document or a newer version is refused as a whole (I2/I7; never silently fall back).
 * A version-2 document loads and reports `migrated: true`; the caller writes it back (§7.1).
 */
export function parseBotsDocument(raw) {
  const droppedKeys = []
  const truncated = []
  const warnings = []
  if (!isObject(raw)) {
    return { version: undefined, migrated: false, bots: [], droppedKeys, truncated, warnings, error: 'Bot 文件顶层必须是对象', code: 'BOT_FILE_CORRUPT' }
  }
  for (const key of Object.keys(raw)) if (!['version', 'bots'].includes(key)) droppedKeys.push(key)
  const version = raw.version
  if (version === undefined) {
    return { version, migrated: false, bots: [], droppedKeys, truncated, warnings, error: 'Bot 文件缺少 version', code: 'BOT_FILE_CORRUPT' }
  }
  if (version !== 2 && version !== BOT_FILE_VERSION) {
    // version 1 was the old 「档位」 file: the same shape under a different name, so the fix is a rename, not a migration.
    const error = version === 1
      ? '这是旧版档位文件（version 1）；Bot 文件已改名为 worker-bots.json，请重命名为该文件并用新版本重写'
      : `Bot 文件版本 ${version} 比本插件支持的 ${BOT_FILE_VERSION} 新，请升级插件`
    return { version, migrated: false, bots: [], droppedKeys, truncated, warnings, error, code: 'BOT_FILE_VERSION_UNSUPPORTED' }
  }
  const normalized = normalizeBots(raw.bots)
  droppedKeys.push(...normalized.droppedKeys)
  truncated.push(...normalized.truncated)
  warnings.push(...normalized.warnings)
  const bots = []
  for (const bot of normalized.bots) {
    if (isBuiltinBot(bot.id)) {
      warnings.push(`内置 Bot 不可编辑，已忽略文件中的 ${bot.id}`)
      continue
    }
    const checked = validateBot(bot)
    if (!checked.ok) {
      warnings.push(`Bot ${bot.id} 不合法：${checked.code} ${checked.message}`)
      continue
    }
    bots.push(checked.bot)
  }
  if (bots.length > BOT_LIMITS.bots) {
    warnings.push(`Bot 最多 ${BOT_LIMITS.bots} 个，多余的已忽略`)
    bots.length = BOT_LIMITS.bots
  }
  return {
    version, migrated: version === 2, bots,
    droppedKeys: uniqueStrings(droppedKeys), truncated: uniqueStrings(truncated), warnings,
    error: undefined, code: undefined,
  }
}

/**
 * Read `<stateDir>/worker-bots.json`. Missing file => built-ins only (not an error); a corrupt
 * or future-versioned file => `bots: []` plus a code, so dispatch can refuse instead of
 * guessing. `stateDir` absent (tests, dry reads) returns built-ins without touching the disk.
 */
export function readBots(stateDir, config) {
  const { error: fileError } = botsFileOf(config)
  const file = stateDir ? botsPath(stateDir, config) : undefined
  const base = {
    file,
    exists: false,
    builtin: true,
    version: undefined,
    legacy: false,
    bots: [],
    droppedKeys: [],
    truncated: [],
    warnings: [],
    error: fileError,
    code: fileError ? 'BOT_FILE_INVALID' : undefined,
  }
  if (!file) return { ...base, bots: [...builtinBots(), ...[]] }
  if (!existsSync(file)) return { ...base, bots: builtinBots() }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...base, exists: true, builtin: false, bots: [], error: 'Bot 文件不是合法 JSON', code: 'BOT_FILE_CORRUPT' }
  }
  const parsed = parseBotsDocument(raw)
  // A refused document must not silently degrade to the built-ins: dispatch sees the code and stops.
  return {
    ...base,
    exists: true,
    builtin: false,
    ...parsed,
    // `legacy` is what the engine's one-time migration looks at, before `bots` is merged with the built-ins.
    legacy: parsed.migrated === true,
    bots: parsed.code ? [] : [...builtinBots(), ...parsed.bots],
  }
}

/**
 * Migrate a version-2 store to version 3 (§7.1/§7.2): back the old file up as `<name>.bak`, then write
 * the normalized document back. `readBots` has already dropped (and warned about) bots that failed validation,
 * so the only way the rewrite itself can be refused is `writeBots` — and then the v2 file stays as it is.
 *
 * @returns {Promise<{migrated:boolean, backup?:string, droppedKeys?:string[], truncated?:string[], warnings?:string[], problems?:string[]}>}
 */
export async function migrateBots(stateDir, config) {
  const book = readBots(stateDir, config)
  if (!book.exists || book.code || !book.legacy) return { migrated: false }
  const custom = book.bots.filter(bot => !isBuiltinBot(bot.id))
  const backup = `${book.file}.bak`
  // The backup is written first, so a refused rewrite still leaves both the v2 file and its copy in place.
  if (existsSync(book.file)) copyFileSync(book.file, backup)
  try {
    await writeBots(stateDir, config, { bots: custom })
  } catch (error) {
    const problems = Array.isArray(error?.problems) ? error.problems : [`${error?.code ?? 'BOT_SCHEMA_INVALID'} ${error?.message ?? ''}`]
    return { migrated: false, problems }
  }
  return { migrated: true, backup, droppedKeys: book.droppedKeys, truncated: book.truncated, warnings: book.warnings }
}

/**
 * Validate and persist a bots document. Throws an Error with `code` (`BOT_SCHEMA_INVALID`,
 * `BOT_DUPLICATE_ID`, `BOT_FILE_INVALID`) — the panel shows `code` + `message` inline.
 */
export async function writeBots(stateDir, config, document) {
  const { name, error: fileError } = botsFileOf(config)
  if (fileError) throw botError('BOT_FILE_INVALID', fileError)
  const normalized = normalizeBots(document?.bots)
  const problems = [...normalized.warnings]
  if (normalized.droppedKeys.length) problems.push(`未知字段：${normalized.droppedKeys.join(', ')}`)
  if (normalized.truncated.length) problems.push(`超出上限：${normalized.truncated.join(', ')}`)
  const bots = []
  const seen = new Set()
  for (const bot of normalized.bots) {
    if (isBuiltinBot(bot.id)) {
      problems.push(`内置 Bot 不可编辑：${bot.id}（可复制为新 Bot）`)
      continue
    }
    if (seen.has(bot.id)) {
      problems.push(`Bot id 重复：${bot.id}`)
      continue
    }
    seen.add(bot.id)
    // Saving validates against the runtime facts of the bot's *own* backend. `environments` (per backend) wins over
    // the flat legacy `environment`.
    const base = isObject(document?.environment) ? document.environment : {}
    const perBackend = isObject(document?.environments) && isObject(document.environments[bot.backend])
      ? document.environments[bot.backend] : {}
    const checked = validateBot(bot, { ...base, ...perBackend,
      ...(Array.isArray(document?.botIds) ? { botIds: document.botIds } : {}),
      ...(Array.isArray(document?.presets) ? { presets: document.presets } : {}),
      ...(isObject(document?.efforts) ? { efforts: document.efforts } : {}) })
    if (!checked.ok) {
      problems.push(`${bot.id || '(缺少 id)'}：${checked.code} ${checked.message}`)
      continue
    }
    bots.push(checked.bot)
  }
  if (bots.length > BOT_LIMITS.bots) problems.push(`Bot 最多 ${BOT_LIMITS.bots} 个`)
  if (problems.length) {
    // Classify by the problem prefix, not by any occurrence of 重复: the normaliser also warns about dropped duplicate
    // ids, and a bot *named* 重复 must not look like one.
    const code = problems.some(line => line.startsWith('Bot id 重复')) ? 'BOT_DUPLICATE_ID' : 'BOT_SCHEMA_INVALID'
    throw botError(code, problems.join('；'), problems)
  }
  const payload = { version: BOT_FILE_VERSION, bots }
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, name)
  const temp = join(stateDir, `.${name}.${process.pid}.${Date.now()}.${randomBytes(6).toString('hex')}.tmp`)
  try {
    await writeFileDurable(temp, `${JSON.stringify(payload, undefined, 2)}\n`, { mode: 0o600 })
    await renameDurable(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return { ...payload, file }
}

/** Digest of the full bot set (built-ins included) for the dispatch cache key (§2.3). */
export function botsDigest(bots) {
  return digestOf((bots ?? []).map(bot => sortBot(bot)))
}
