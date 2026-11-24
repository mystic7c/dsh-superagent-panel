/**
 * Worker bots — the declarative "Bot" layer of the worker-bots spec (§4–§10).
 *
 * A bot is data, never code: the JSON schema below is the contract, unknown keys are dropped on
 * read (reported as `droppedKeys`, not fatal), and every capability a bot asks for must be
 * verified by a runtime probe (see `backend-capability.js`) before the bot is offered.
 *
 * The store lives next to `live.json` in the plugin state dir (`<stateDir>/worker-bots.json`):
 * 0600, atomic temp+rename, and never a path inside a repository worktree (I7).
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { renameDurable, writeFileDurable } from './durable.js'
import { STAGES } from './workflow.js'
import { REPAIR_LIMIT } from './repair.js'

export const BOT_FILE_VERSION = 2
export const BOT_FILE_NAME = 'worker-bots.json'
export const DEFAULT_BOT_ID = 'generalist'
export const BOT_BACKENDS = ['dsh', 'claude', 'codex']
export const BOT_CAPABILITIES = ['edit', 'exec', 'web']
export const BOT_EFFORTS = ['auto', 'low', 'medium', 'high']
export const BOT_ID_PATTERN = /^[a-z0-9-]{2,32}$/

export const BOT_LIMITS = Object.freeze({
  bots: 32,
  name: 40,
  description: 400,
  modelProvider: 64,
  model: 128,
  preset: 64,
  requires: 3,
  deny: 32,
  denyName: 64,
  allowMcp: 16,
  allowMcpName: 128,
  prefer: 16,
  preferName: 64,
  role: 2000,
  must: 16,
  mustItem: 200,
})

export const BOT_BUDGET = Object.freeze({
  timeoutMs: [60_000, 7_200_000],
  idleTimeoutMs: [60_000, 3_600_000],
  maxRepairRounds: [0, REPAIR_LIMIT],
})

/** Stage entries may be a bare name (`"implement"`) or an object naming a stage-level bot / budget (§10.2). */
const STAGE_KEYS = ['stage', 'bot', 'budget']

/** Stable key order: the file output and the digest must not depend on insertion order (§4.4.5). */
const BOT_KEYS = ['id', 'name', 'description', 'backend', 'model', 'preset', 'requires', 'tools', 'skills', 'prompt', 'budget', 'stages']

const BUILTIN_BOTS = Object.freeze([
  Object.freeze({
    id: 'generalist',
    name: '通用',
    description: '跟随宿主后端与模型，等同 v1.0.7 默认行为。',
    backend: 'dsh',
    requires: Object.freeze(['edit', 'exec']),
  }),
  Object.freeze({
    id: 'surgical',
    name: '小修',
    description: '简单改动：implement → gates，不跑 plan 与 review。',
    backend: 'dsh',
    requires: Object.freeze(['edit', 'exec']),
    stages: Object.freeze(['implement', 'gates']),
  }),
  Object.freeze({
    id: 'reviewer',
    name: '审阅者',
    description: '只读复核，产出报告。只能放在阶段位，不能当主 Bot。',
    backend: 'dsh',
    requires: Object.freeze([]),
  }),
])

export const BUILTIN_BOT_IDS = Object.freeze(BUILTIN_BOTS.map(bot => bot.id))

export function isBuiltinBot(id) {
  return BUILTIN_BOT_IDS.includes(id)
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

/** Canonical JSON: sorted keys, no whitespace, no `undefined` — the ad-hoc fingerprint (§8). */
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
  if (Array.isArray(source.requires)) {
    // Capabilities are a lowercase enum, so folding case here is a normalization, not a judgment.
    bot.requires = uniqueStrings(source.requires.map(capability => (
      typeof capability === 'string' ? capability.toLowerCase() : capability))).slice(0, BOT_LIMITS.requires)
    if (source.requires.length > BOT_LIMITS.requires) truncated.push('requires')
  } else if (source.requires !== undefined) {
    dropped.push('requires')
  }
  if (isObject(source.tools)) {
    const tools = {}
    if (Array.isArray(source.tools.deny)) {
      const deny = uniqueStrings(source.tools.deny).slice(0, BOT_LIMITS.deny).map(name => name.slice(0, BOT_LIMITS.denyName))
      if (deny.length) tools.deny = deny
      if (source.tools.deny.length > BOT_LIMITS.deny) truncated.push('tools.deny')
    }
    if (Array.isArray(source.tools.allowMcp)) {
      const allowMcp = uniqueStrings(source.tools.allowMcp).slice(0, BOT_LIMITS.allowMcp)
        .map(name => name.slice(0, BOT_LIMITS.allowMcpName))
      if (allowMcp.length) tools.allowMcp = allowMcp
      if (source.tools.allowMcp.length > BOT_LIMITS.allowMcp) truncated.push('tools.allowMcp')
    }
    for (const key of Object.keys(source.tools)) if (!['deny', 'allowMcp'].includes(key)) dropped.push(`tools.${key}`)
    if (Object.keys(tools).length) bot.tools = tools
  } else if (source.tools !== undefined) {
    dropped.push('tools')
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
    if (Array.isArray(source.prompt.must)) {
      const must = uniqueStrings(source.prompt.must).slice(0, BOT_LIMITS.must)
        .map(item => item.slice(0, BOT_LIMITS.mustItem))
      if (must.length) prompt.must = must
      if (source.prompt.must.length > BOT_LIMITS.must) truncated.push('prompt.must')
    }
    for (const key of Object.keys(source.prompt)) if (!['role', 'must'].includes(key)) dropped.push(`prompt.${key}`)
    if (Object.keys(prompt).length) bot.prompt = prompt
  } else if (source.prompt !== undefined) {
    dropped.push('prompt')
  }
  if (isObject(source.budget)) {
    const budget = {}
    for (const [key, [min, max]] of Object.entries(BOT_BUDGET)) {
      const value = source.budget[key]
      if (value !== undefined) budget[key] = value
    }
    for (const key of Object.keys(source.budget)) if (!(key in BOT_BUDGET)) dropped.push(`budget.${key}`)
    if (Object.keys(budget).length) bot.budget = budget
  } else if (source.budget !== undefined) {
    dropped.push('budget')
  }
  if (Array.isArray(source.stages)) {
    const stages = normalizeStages(source.stages)
    if (stages.length) bot.stages = stages
  } else if (source.stages !== undefined) {
    dropped.push('stages')
  }

  return { bot: sortBot(bot), dropped, truncated }
}

/** The stage names of a bot's `stages` list, whether its entries are names or §10.2 objects. */
export function stageNamesOf(stages) {
  if (!Array.isArray(stages)) return undefined
  return stages.map(entry => (typeof entry === 'string' ? entry : entry?.stage)).filter(name => typeof name === 'string')
}

/** The §10.2 stage-level bot for one stage name, when the bot declares one. */
export function stageBotOf(stages, name) {
  if (!Array.isArray(stages)) return undefined
  const entry = stages.find(item => item && typeof item === 'object' && item.stage === name && typeof item.bot === 'string')
  return entry?.bot
}

/** Canonical stage list: names stay names (the common case), §10.2 objects keep a sorted shape. */
function normalizeStages(list) {
  const out = []
  for (const entry of list) {
    if (typeof entry === 'string' && entry.trim()) {
      const name = entry.trim().toLowerCase()
      if (!out.some(item => stageName(item) === name)) out.push(name)
      continue
    }
    if (!isObject(entry)) continue
    const stage = typeof entry.stage === 'string' ? entry.stage.trim().toLowerCase() : ''
    if (!stage) continue
    const item = { stage }
    if (typeof entry.bot === 'string' && entry.bot.trim()) item.bot = entry.bot.trim().toLowerCase()
    if (isObject(entry.budget)) {
      const budget = {}
      for (const key of Object.keys(BOT_BUDGET)) if (entry.budget[key] !== undefined) budget[key] = entry.budget[key]
      if (Object.keys(budget).length) item.budget = budget
    }
    if (out.some(previous => stageName(previous) === stage)) continue
    out.push(item)
  }
  return out
}

function stageName(entry) {
  return typeof entry === 'string' ? entry : entry?.stage
}

/** Fixed key order (and fixed nested order) so the on-disk file and `configDigest` are reproducible. */
export function sortBot(bot) {
  const source = isObject(bot) ? bot : {}
  const out = sortKeys(source, BOT_KEYS)
  if (isObject(out.model)) out.model = sortKeys(out.model, ['provider', 'model', 'reasoningEffort'])
  if (isObject(out.tools)) out.tools = sortKeys(out.tools, ['deny', 'allowMcp'])
  if (isObject(out.skills)) out.skills = sortKeys(out.skills, ['prefer', 'policy'])
  if (isObject(out.prompt)) out.prompt = sortKeys(out.prompt, ['role', 'must'])
  if (isObject(out.budget)) out.budget = sortKeys(out.budget, ['timeoutMs', 'idleTimeoutMs', 'maxRepairRounds'])
  if (Array.isArray(out.stages)) {
    out.stages = out.stages.map(entry => (isObject(entry) ? sortKeys(entry, STAGE_KEYS) : entry))
  }
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
 * `environment` carries what only the runtime knows: `capabilities` (verified probe result),
 * `backendState` ('verified' | 'unverified' | 'stale'), `backendEnabled`, and the host's own catalogues —
 * `presets` (every preset id the host offers) and `efforts` (model key `provider/model` → effort ids the
 * model actually accepts, §9.3). The legacy booleans `presetKnown` / `effortSupported` still work for
 * callers that only know one answer. Omitting all of it validates the declaration only, which is what
 * tests of the schema/declaration layer need.
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
  if (bot.requires !== undefined) {
    if (!Array.isArray(bot.requires) || bot.requires.length > BOT_LIMITS.requires) {
      return fail('BOT_SCHEMA_INVALID', `requires 最多 ${BOT_LIMITS.requires} 项`)
    }
    for (const capability of bot.requires) {
      if (capability === 'report') {
        return fail('BOT_REQUIRES_NOT_CAPABILITY', 'report 是交付物，不是能力；不能写进 requires')
      }
      if (!BOT_CAPABILITIES.includes(capability)) {
        return fail('BOT_REQUIRES_UNKNOWN', `未知能力：${capability}（只支持 ${BOT_CAPABILITIES.join(' / ')}）`)
      }
    }
  }
  if (bot.tools !== undefined) {
    const tools = bot.tools
    if (!isObject(tools)) return fail('BOT_SCHEMA_INVALID', 'tools 必须是对象')
    if (tools.deny !== undefined && (!Array.isArray(tools.deny) || tools.deny.length > BOT_LIMITS.deny)) {
      return fail('BOT_SCHEMA_INVALID', `tools.deny 最多 ${BOT_LIMITS.deny} 项`)
    }
    if (tools.allowMcp !== undefined && (!Array.isArray(tools.allowMcp) || tools.allowMcp.length > BOT_LIMITS.allowMcp)) {
      return fail('BOT_SCHEMA_INVALID', `tools.allowMcp 最多 ${BOT_LIMITS.allowMcp} 项`)
    }
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
    if (prompt.must !== undefined) {
      if (!Array.isArray(prompt.must) || prompt.must.length > BOT_LIMITS.must) {
        return fail('BOT_PROMPT_INVALID', `prompt.must 最多 ${BOT_LIMITS.must} 条`)
      }
      for (const item of prompt.must) {
        if (typeof item !== 'string' || !item || item.length > BOT_LIMITS.mustItem) {
          return fail('BOT_PROMPT_INVALID', `prompt.must 每条不超过 ${BOT_LIMITS.mustItem} 字`)
        }
      }
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
  if (bot.stages !== undefined) {
    const stages = bot.stages
    if (!Array.isArray(stages) || stages.length < 2 || stages.length > STAGES.length) {
      return fail('BOT_STAGES_INVALID', 'stages 至少 2 个阶段，且取自固定阶段表')
    }
    const names = stageNamesOf(stages)
    let cursor = -1
    for (const stage of names) {
      const index = STAGES.indexOf(stage)
      if (index < 0 || index <= cursor) {
        return fail('BOT_STAGES_INVALID', 'stages 必须是 assess → plan → implement → gates → review 的有序子序列')
      }
      cursor = index
    }
    if (!names.includes('implement') || !names.includes('gates')) {
      return fail('BOT_STAGES_INVALID', 'stages 必须包含 implement 与 gates（只跑 review 请用作阶段 Bot）')
    }
    // §10.2: a stage-level bot must exist and carry that bot's own stage budget inside §6's ranges.
    for (const entry of stages) {
      if (!isObject(entry)) continue
      if (typeof entry.stage !== 'string' || !STAGES.includes(entry.stage)) {
        return fail('BOT_STAGES_INVALID', '阶段对象必须有合法的 stage')
      }
      if (entry.bot !== undefined) {
        if (typeof entry.bot !== 'string' || !BOT_ID_PATTERN.test(entry.bot)) {
          return fail('BOT_STAGES_INVALID', `阶段 ${entry.stage} 的 bot 必须是合法的 Bot id`)
        }
        if (Array.isArray(environment.botIds) && !environment.botIds.includes(entry.bot)) {
          return fail('BOT_STAGES_INVALID', `阶段 ${entry.stage} 引用了不存在的 Bot：${entry.bot}`)
        }
        if (entry.bot === bot.id) {
          return fail('BOT_STAGES_INVALID', `阶段 ${entry.stage} 引用了自身；留空表示用整单 Bot`)
        }
      }
      if (entry.budget !== undefined) {
        if (!isObject(entry.budget)) return fail('BOT_BUDGET_INVALID', `阶段 ${entry.stage} 的 budget 必须是对象`)
        for (const [key, [min, max]] of Object.entries(BOT_BUDGET)) {
          const value = entry.budget[key]
          if (value === undefined) continue
          if (!Number.isInteger(value) || value < min || value > max) {
            return fail('BOT_BUDGET_INVALID', `阶段 ${entry.stage} 的 budget.${key} 必须是 ${min}–${max} 的整数`)
          }
        }
      }
    }
  }

  if (environment.backendState === 'unverified') {
    return fail('BOT_BACKEND_UNVERIFIED', `后端 ${bot.backend} 尚未核验，先完成探针再保存`)
  }
  if (environment.backendState === 'stale') {
    return fail('BOT_BACKEND_STALE', `后端 ${bot.backend} 的核验证据已过期，请重新核验`)
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
  if (isObject(environment.capabilities)) {
    const missing = (bot.requires ?? []).filter(capability => environment.capabilities[capability] !== true)
    if (missing.length) {
      return fail('BOT_CAPABILITY_GAP', `后端 ${bot.backend} 缺少能力：${missing.join(', ')}`, { missing })
    }
  }
  return { ok: true, bot }
}

/** Verified capabilities only: a tool the host has but cannot use is not a capability (§3.6). */
export function capabilitiesOf(probe) {
  const unverified = new Set(Array.isArray(probe?.unverified) ? probe.unverified : [])
  const declared = isObject(probe?.capabilities) ? probe.capabilities : {}
  // A fallback "probe" is the routing table's opinion, not an observation (§3.2): it authorizes nothing, so an
  // unprobed backend reports no capability at all and can only explain a refusal.
  const observed = probe?.source !== 'fallback'
  const out = {}
  for (const capability of BOT_CAPABILITIES) {
    out[capability] = observed && declared[capability] === true && !unverified.has(capability)
  }
  return out
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
    denyTools: Array.isArray(bot?.tools?.deny) ? bot.tools.deny.slice() : undefined,
    allowMcp: Array.isArray(bot?.tools?.allowMcp) ? bot.tools.allowMcp.slice() : undefined,
    budget: {
      timeoutMs: Number.isInteger(budget.timeoutMs) ? budget.timeoutMs : undefined,
      idleTimeoutMs: Number.isInteger(budget.idleTimeoutMs) ? budget.idleTimeoutMs : undefined,
      maxRepairRounds: Number.isInteger(budget.maxRepairRounds) ? budget.maxRepairRounds : undefined,
    },
    stages: Array.isArray(bot?.stages) ? bot.stages.slice() : undefined,
  }
}

/**
 * Resolve one bot into the options a worker invocation receives (§9.1).
 *
 * `context` carries executor defaults and the run's own constraints: `denyTools` (the hard
 * blacklist), `preset`, the three budget defaults, `readOnly`, and verified `capabilities`.
 */
export function resolveBot(bot, context = {}) {
  const params = paramsOfBot(bot)
  const deny = [...new Set([...(context.denyTools ?? []), ...(params.denyTools ?? [])])]
  return {
    id: bot.id,
    backend: bot.backend,
    model: params.model,
    preset: params.preset ?? context.preset,
    denyTools: deny,
    allowMcp: params.allowMcp,
    readOnly: context.readOnly === true,
    systemPromptExtra: {
      role: bot.prompt?.role ?? '',
      must: Array.isArray(bot.prompt?.must) ? bot.prompt.must.slice() : [],
      skills: Array.isArray(bot.skills?.prefer) ? bot.skills.prefer.slice() : [],
    },
    budget: {
      timeoutMs: params.budget.timeoutMs ?? context.timeoutMs,
      idleTimeoutMs: params.budget.idleTimeoutMs ?? context.idleTimeoutMs,
      maxRepairRounds: params.budget.maxRepairRounds ?? context.maxRepairRounds,
    },
    stages: params.stages,
    capability: Array.isArray(context.capabilities) ? context.capabilities.slice() : context.capabilities,
  }
}

/**
 * Synthesize the transient ad-hoc bot for a ticket (§8.3). Deterministic: the same requirement
 * set and backend order always yield the same id, and the id is never offered for saving.
 *
 * @param {{requires?:string[], deliverable?:string, capabilities?:any, backendOrder?:string[], role?:string,
 *   preset?:string, model?:{provider:string, model:string, reasoningEffort?:string}}} [options]
 * @returns {object|null} a normalized transient bot, or null when no backend covers the requirement
 */
export function synthesizeBot({
  requires = [],
  deliverable = 'change',
  capabilities,
  backendOrder = BOT_BACKENDS,
  role = '',
  preset,
  model,
} = {}) {
  const wanted = deliverable === 'report'
    ? []
    : [...new Set(requires.filter(capability => BOT_CAPABILITIES.includes(capability)))].sort()
  // `capabilities` may be one backend's verified set, or a map keyed by backend name (each built-in
  // independent). A backend missing from the map gets the flat form, which then simply lacks the keys.
  const capsOf = name => (isObject(capabilities) && isObject(capabilities[name]) ? capabilities[name] : capabilities)
  const backend = backendOrder.find(name =>
    BOT_BACKENDS.includes(name)
    && BOT_CAPABILITIES.every(capability => !wanted.includes(capability) || capsOf(name)?.[capability] === true))
  if (!backend) return null
  const rolePrefix = typeof role === 'string' ? role.trim().slice(0, 500) : ''
  const fingerprint = {
    requires: wanted,
    backend,
    model: model ?? null,
    preset: preset ?? null,
    rolePrefix,
    deliverable,
  }
  return sortBot({
    id: `adhoc:${digestOf(fingerprint).slice(0, 8)}`,
    name: '现拉',
    description: '按工单需求临时合成，未保存为 Bot。',
    backend,
    requires: wanted,
    ...(preset ? { preset } : {}),
    ...(model ? { model } : {}),
    ...(rolePrefix ? { prompt: { role: rolePrefix } } : {}),
  })
}

function botError(code, message, problems) {
  const error = /** @type {Error & {code:string, problems?:string[]}} */ (new Error(message))
  error.code = code
  if (problems) error.problems = problems
  return error
}

/** The bot file lives beside live.json, so it must not be able to replace any file the state directory already owns
 *  (its own default name `worker-bots.json` is the one legitimate occupant). */
const RESERVED_STATE_FILES = new Set([
  'live.json', 'live-state.json', 'operations.json',
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
 */
export function parseBotsDocument(raw) {
  const droppedKeys = []
  const truncated = []
  const warnings = []
  if (!isObject(raw)) {
    return { version: undefined, bots: [], droppedKeys, truncated, warnings, error: 'Bot 文件顶层必须是对象', code: 'BOT_FILE_CORRUPT' }
  }
  for (const key of Object.keys(raw)) if (!['version', 'bots'].includes(key)) droppedKeys.push(key)
  const version = raw.version
  if (version === undefined) {
    return { version, bots: [], droppedKeys, truncated, warnings, error: 'Bot 文件缺少 version', code: 'BOT_FILE_CORRUPT' }
  }
  if (version !== BOT_FILE_VERSION) {
    // version 1 was the old 「档位」 file: the same shape under a different name, so the fix is a rename, not a migration.
    const error = version === 1
      ? '这是旧版档位文件（version 1）；Bot 文件已改名为 worker-bots.json 且 version 为 2，请重命名并改 version 后重试'
      : `Bot 文件版本 ${version} 比本插件支持的 ${BOT_FILE_VERSION} 新，请升级插件`
    return { version, bots: [], droppedKeys, truncated, warnings, error, code: 'BOT_FILE_VERSION_UNSUPPORTED' }
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
  return { version, bots, droppedKeys: uniqueStrings(droppedKeys), truncated: uniqueStrings(truncated), warnings, error: undefined, code: undefined }
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
    bots: parsed.code ? [] : [...builtinBots(), ...parsed.bots],
  }
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
    // Saving validates against the runtime facts of the bot's *own* backend: a claude bot must not be judged
    // by the DSH tool surface. `environments` (per backend) wins over the flat legacy `environment`.
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

/** Digest of the full bot set (built-ins included) for the dispatch cache key (§7.5). */
export function botsDigest(bots) {
  return digestOf((bots ?? []).map(bot => sortBot(bot)))
}
