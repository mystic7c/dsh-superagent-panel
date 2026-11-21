/**
 * Worker profiles — the declarative "档位" layer of the worker-profiles spec (§4–§10).
 *
 * A profile is data, never code: the JSON schema below is the contract, unknown keys are dropped on
 * read (reported as `droppedKeys`, not fatal), and every capability a profile asks for must be
 * verified by a runtime probe (see `backend-capability.js`) before the profile is offered.
 *
 * The store lives next to `live.json` in the plugin state dir (`<stateDir>/worker-profiles.json`):
 * 0600, atomic temp+rename, and never a path inside a repository worktree (I7).
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileDurable } from './durable.js'
import { STAGES } from './workflow.js'

export const PROFILE_FILE_VERSION = 1
export const PROFILE_FILE_NAME = 'worker-profiles.json'
export const DEFAULT_PROFILE_ID = 'generalist'
export const PROFILE_BACKENDS = ['dsh', 'claude', 'codex']
export const PROFILE_CAPABILITIES = ['edit', 'exec', 'web']
export const PROFILE_EFFORTS = ['auto', 'low', 'medium', 'high']
export const PROFILE_ID_PATTERN = /^[a-z0-9-]{2,32}$/

export const PROFILE_LIMITS = Object.freeze({
  profiles: 32,
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

export const PROFILE_BUDGET = Object.freeze({
  timeoutMs: [60_000, 7_200_000],
  idleTimeoutMs: [60_000, 3_600_000],
  maxRepairRounds: [0, 6],
})

/** Stable key order: the file output and the digest must not depend on insertion order (§4.4.5). */
const PROFILE_KEYS = ['id', 'name', 'description', 'backend', 'model', 'preset', 'requires', 'tools', 'skills', 'prompt', 'budget', 'stages']

const BUILTIN_PROFILES = Object.freeze([
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
    description: '只读复核，产出报告。只能当阶段档位用（见 §10.2）。',
    backend: 'dsh',
    requires: Object.freeze([]),
  }),
])

export const BUILTIN_PROFILE_IDS = Object.freeze(BUILTIN_PROFILES.map(profile => profile.id))

export function isBuiltinProfile(id) {
  return BUILTIN_PROFILE_IDS.includes(id)
}

/** Fresh copies, so a caller can never mutate the built-in definitions. */
export function builtinProfiles() {
  return BUILTIN_PROFILES.map(profile => sortProfile(normalizeProfile(profile).profile))
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

/** Normalize one raw profile: whitelist, trim, lowercase, dedupe, truncate (§4.4.1–3). */
export function normalizeProfile(raw) {
  const dropped = []
  const truncated = []
  const source = isObject(raw) ? raw : {}
  const profile = {}

  for (const key of Object.keys(source)) if (!PROFILE_KEYS.includes(key)) dropped.push(key)

  if (source.id !== undefined) {
    const id = trimmed(source.id)
    profile.id = typeof id === 'string' ? id.toLowerCase() : id
  }
  if (source.name !== undefined) {
    profile.name = trimmed(source.name)
    if (clip(source.name, PROFILE_LIMITS.name)) truncated.push('name')
    if (profile.name) profile.name = profile.name.slice(0, PROFILE_LIMITS.name)
  }
  if (source.description !== undefined) {
    profile.description = trimmed(source.description)
    if (clip(source.description, PROFILE_LIMITS.description)) truncated.push('description')
    if (profile.description) profile.description = profile.description.slice(0, PROFILE_LIMITS.description)
  }
  if (source.backend !== undefined && typeof source.backend === 'string') profile.backend = source.backend.trim().toLowerCase()
  if (source.preset !== undefined) {
    const preset = trimmed(source.preset)
    if (preset) {
      profile.preset = preset.slice(0, PROFILE_LIMITS.preset)
      if (clip(preset, PROFILE_LIMITS.preset)) truncated.push('preset')
    }
  }
  if (isObject(source.model)) {
    const model = {}
    if (typeof source.model.provider === 'string' && source.model.provider.trim()) {
      const provider = source.model.provider.trim()
      model.provider = provider.slice(0, PROFILE_LIMITS.modelProvider)
      if (clip(provider, PROFILE_LIMITS.modelProvider)) truncated.push('model.provider')
    }
    if (typeof source.model.model === 'string' && source.model.model.trim()) {
      const name = source.model.model.trim()
      model.model = name.slice(0, PROFILE_LIMITS.model)
      if (clip(name, PROFILE_LIMITS.model)) truncated.push('model.model')
    }
    if (typeof source.model.reasoningEffort === 'string') {
      model.reasoningEffort = source.model.reasoningEffort.trim().toLowerCase()
    }
    for (const key of Object.keys(source.model)) {
      if (!['provider', 'model', 'reasoningEffort'].includes(key)) dropped.push(`model.${key}`)
    }
    if (Object.keys(model).length) profile.model = model
  } else if (source.model !== undefined) {
    dropped.push('model')
  }
  if (Array.isArray(source.requires)) {
    // Capabilities are a lowercase enum, so folding case here is a normalization, not a judgment.
    profile.requires = uniqueStrings(source.requires.map(capability => (
      typeof capability === 'string' ? capability.toLowerCase() : capability))).slice(0, PROFILE_LIMITS.requires)
    if (source.requires.length > PROFILE_LIMITS.requires) truncated.push('requires')
  } else if (source.requires !== undefined) {
    dropped.push('requires')
  }
  if (isObject(source.tools)) {
    const tools = {}
    if (Array.isArray(source.tools.deny)) {
      const deny = uniqueStrings(source.tools.deny).slice(0, PROFILE_LIMITS.deny).map(name => name.slice(0, PROFILE_LIMITS.denyName))
      if (deny.length) tools.deny = deny
      if (source.tools.deny.length > PROFILE_LIMITS.deny) truncated.push('tools.deny')
    }
    if (Array.isArray(source.tools.allowMcp)) {
      const allowMcp = uniqueStrings(source.tools.allowMcp).slice(0, PROFILE_LIMITS.allowMcp)
        .map(name => name.slice(0, PROFILE_LIMITS.allowMcpName))
      if (allowMcp.length) tools.allowMcp = allowMcp
      if (source.tools.allowMcp.length > PROFILE_LIMITS.allowMcp) truncated.push('tools.allowMcp')
    }
    for (const key of Object.keys(source.tools)) if (!['deny', 'allowMcp'].includes(key)) dropped.push(`tools.${key}`)
    if (Object.keys(tools).length) profile.tools = tools
  } else if (source.tools !== undefined) {
    dropped.push('tools')
  }
  if (isObject(source.skills)) {
    const skills = {}
    if (Array.isArray(source.skills.prefer)) {
      const prefer = uniqueStrings(source.skills.prefer).slice(0, PROFILE_LIMITS.prefer)
        .map(name => name.slice(0, PROFILE_LIMITS.preferName))
      if (prefer.length) skills.prefer = prefer
      if (source.skills.prefer.length > PROFILE_LIMITS.prefer) truncated.push('skills.prefer')
    }
    if (typeof source.skills.policy === 'string') skills.policy = source.skills.policy.trim().toLowerCase()
    for (const key of Object.keys(source.skills)) if (!['prefer', 'policy'].includes(key)) dropped.push(`skills.${key}`)
    if (Object.keys(skills).length) profile.skills = skills
  } else if (source.skills !== undefined) {
    dropped.push('skills')
  }
  if (isObject(source.prompt)) {
    const prompt = {}
    if (typeof source.prompt.role === 'string' && source.prompt.role.trim()) {
      const role = source.prompt.role.trim()
      prompt.role = role.slice(0, PROFILE_LIMITS.role)
      if (clip(role, PROFILE_LIMITS.role)) truncated.push('prompt.role')
    }
    if (Array.isArray(source.prompt.must)) {
      const must = uniqueStrings(source.prompt.must).slice(0, PROFILE_LIMITS.must)
        .map(item => item.slice(0, PROFILE_LIMITS.mustItem))
      if (must.length) prompt.must = must
      if (source.prompt.must.length > PROFILE_LIMITS.must) truncated.push('prompt.must')
    }
    for (const key of Object.keys(source.prompt)) if (!['role', 'must'].includes(key)) dropped.push(`prompt.${key}`)
    if (Object.keys(prompt).length) profile.prompt = prompt
  } else if (source.prompt !== undefined) {
    dropped.push('prompt')
  }
  if (isObject(source.budget)) {
    const budget = {}
    for (const [key, [min, max]] of Object.entries(PROFILE_BUDGET)) {
      const value = source.budget[key]
      if (value !== undefined) budget[key] = value
    }
    for (const key of Object.keys(source.budget)) if (!(key in PROFILE_BUDGET)) dropped.push(`budget.${key}`)
    if (Object.keys(budget).length) profile.budget = budget
  } else if (source.budget !== undefined) {
    dropped.push('budget')
  }
  if (Array.isArray(source.stages)) {
    profile.stages = uniqueStrings(source.stages).map(stage => stage.toLowerCase())
  } else if (source.stages !== undefined) {
    dropped.push('stages')
  }

  return { profile: sortProfile(profile), dropped, truncated }
}

/** Fixed key order (and fixed nested order) so the on-disk file and `configDigest` are reproducible. */
export function sortProfile(profile) {
  const source = isObject(profile) ? profile : {}
  const out = sortKeys(source, PROFILE_KEYS)
  if (isObject(out.model)) out.model = sortKeys(out.model, ['provider', 'model', 'reasoningEffort'])
  if (isObject(out.tools)) out.tools = sortKeys(out.tools, ['deny', 'allowMcp'])
  if (isObject(out.skills)) out.skills = sortKeys(out.skills, ['prefer', 'policy'])
  if (isObject(out.prompt)) out.prompt = sortKeys(out.prompt, ['role', 'must'])
  if (isObject(out.budget)) out.budget = sortKeys(out.budget, ['timeoutMs', 'idleTimeoutMs', 'maxRepairRounds'])
  return sortKeys(out, PROFILE_KEYS)
}

export function normalizeProfiles(rawProfiles) {
  const list = Array.isArray(rawProfiles) ? rawProfiles : []
  const droppedKeys = []
  const truncated = []
  const warnings = []
  const seen = new Set()
  const profiles = []
  for (const raw of list) {
    if (!isObject(raw)) {
      warnings.push('档位必须是对象，已忽略')
      continue
    }
    const { profile, dropped, truncated: cuts } = normalizeProfile(raw)
    droppedKeys.push(...dropped)
    truncated.push(...cuts)
    if (!profile.id) {
      warnings.push('档位缺少 id，已忽略')
      continue
    }
    if (seen.has(profile.id)) {
      warnings.push(`档位 id 重复：${profile.id}，已忽略后一条`)
      continue
    }
    seen.add(profile.id)
    profiles.push(profile)
  }
  return { profiles, droppedKeys: uniqueStrings(droppedKeys), truncated: uniqueStrings(truncated), warnings }
}

function fail(code, message, extra) {
  return { ok: false, code, message, ...(extra ?? {}) }
}

/**
 * Validate one normalized profile.
 *
 * `environment` carries what only the runtime knows: `capabilities` (verified probe result),
 * `backendState` ('verified' | 'unverified' | 'stale'), `backendEnabled`, `presetKnown`,
 * `effortSupported`. Omitting it validates the declaration only, which is what tests of the
 * schema/declaration layer need.
 */
export function validateProfile(candidate, environment = {}) {
  if (!isObject(candidate)) return fail('PROFILE_SCHEMA_INVALID', '档位必须是一个对象')
  const profile = sortProfile(candidate)

  if (typeof profile.id !== 'string' || !PROFILE_ID_PATTERN.test(profile.id)) {
    return fail('PROFILE_ID_INVALID', '档位 id 必须是小写 kebab（2–32 位字母数字或 -）')
  }
  if (typeof profile.name !== 'string' || !profile.name || profile.name.length > PROFILE_LIMITS.name) {
    return fail('PROFILE_SCHEMA_INVALID', `档位名称必填，且不超过 ${PROFILE_LIMITS.name} 字`)
  }
  if (profile.description !== undefined && (typeof profile.description !== 'string' || profile.description.length > PROFILE_LIMITS.description)) {
    return fail('PROFILE_SCHEMA_INVALID', `档位描述不超过 ${PROFILE_LIMITS.description} 字`)
  }
  if (!PROFILE_BACKENDS.includes(profile.backend)) {
    return fail('PROFILE_SCHEMA_INVALID', `后端必须是 ${PROFILE_BACKENDS.join(' / ')}`)
  }
  if (profile.model !== undefined) {
    const model = profile.model
    if (!isObject(model) || typeof model.provider !== 'string' || !model.provider
      || typeof model.model !== 'string' || !model.model) {
      return fail('PROFILE_SCHEMA_INVALID', 'model 需要成对的 provider 与 model')
    }
    if (model.provider.length > PROFILE_LIMITS.modelProvider || model.model.length > PROFILE_LIMITS.model) {
      return fail('PROFILE_SCHEMA_INVALID', 'model 的 provider/model 过长')
    }
    if (model.reasoningEffort !== undefined && !PROFILE_EFFORTS.includes(model.reasoningEffort)) {
      return fail('PROFILE_EFFORT_UNSUPPORTED', `reasoningEffort 只支持 ${PROFILE_EFFORTS.join(' / ')}`)
    }
  }
  if (profile.preset !== undefined && (typeof profile.preset !== 'string' || profile.preset.length > PROFILE_LIMITS.preset)) {
    return fail('PROFILE_SCHEMA_INVALID', `preset 不超过 ${PROFILE_LIMITS.preset} 字`)
  }
  if (profile.requires !== undefined) {
    if (!Array.isArray(profile.requires) || profile.requires.length > PROFILE_LIMITS.requires) {
      return fail('PROFILE_SCHEMA_INVALID', `requires 最多 ${PROFILE_LIMITS.requires} 项`)
    }
    for (const capability of profile.requires) {
      if (capability === 'report') {
        return fail('PROFILE_REQUIRES_NOT_CAPABILITY', 'report 是交付物，不是能力；不能写进 requires')
      }
      if (!PROFILE_CAPABILITIES.includes(capability)) {
        return fail('PROFILE_REQUIRES_UNKNOWN', `未知能力：${capability}（只支持 ${PROFILE_CAPABILITIES.join(' / ')}）`)
      }
    }
  }
  if (profile.tools !== undefined) {
    const tools = profile.tools
    if (!isObject(tools)) return fail('PROFILE_SCHEMA_INVALID', 'tools 必须是对象')
    if (tools.deny !== undefined && (!Array.isArray(tools.deny) || tools.deny.length > PROFILE_LIMITS.deny)) {
      return fail('PROFILE_SCHEMA_INVALID', `tools.deny 最多 ${PROFILE_LIMITS.deny} 项`)
    }
    if (tools.allowMcp !== undefined && (!Array.isArray(tools.allowMcp) || tools.allowMcp.length > PROFILE_LIMITS.allowMcp)) {
      return fail('PROFILE_SCHEMA_INVALID', `tools.allowMcp 最多 ${PROFILE_LIMITS.allowMcp} 项`)
    }
  }
  if (profile.skills !== undefined) {
    const skills = profile.skills
    if (!isObject(skills)) return fail('PROFILE_SCHEMA_INVALID', 'skills 必须是对象')
    if (skills.policy !== undefined && !['prompt', 'preset'].includes(skills.policy)) {
      return fail('PROFILE_SCHEMA_INVALID', 'skills.policy 只支持 prompt / preset')
    }
    if (skills.policy === 'preset' && !profile.preset) {
      return fail('PROFILE_SKILLS_PRESET_MISSING', 'skills.policy=preset 时必须显式指定 preset')
    }
    if (skills.prefer !== undefined && (!Array.isArray(skills.prefer) || skills.prefer.length > PROFILE_LIMITS.prefer)) {
      return fail('PROFILE_SCHEMA_INVALID', `skills.prefer 最多 ${PROFILE_LIMITS.prefer} 项`)
    }
  }
  if (profile.prompt !== undefined) {
    const prompt = profile.prompt
    if (!isObject(prompt)) return fail('PROFILE_PROMPT_INVALID', 'prompt 必须是对象')
    if (prompt.role !== undefined && (typeof prompt.role !== 'string' || prompt.role.length > PROFILE_LIMITS.role)) {
      return fail('PROFILE_PROMPT_INVALID', `prompt.role 不超过 ${PROFILE_LIMITS.role} 字`)
    }
    if (prompt.must !== undefined) {
      if (!Array.isArray(prompt.must) || prompt.must.length > PROFILE_LIMITS.must) {
        return fail('PROFILE_PROMPT_INVALID', `prompt.must 最多 ${PROFILE_LIMITS.must} 条`)
      }
      for (const item of prompt.must) {
        if (typeof item !== 'string' || !item || item.length > PROFILE_LIMITS.mustItem) {
          return fail('PROFILE_PROMPT_INVALID', `prompt.must 每条不超过 ${PROFILE_LIMITS.mustItem} 字`)
        }
      }
    }
  }
  if (profile.budget !== undefined) {
    const budget = profile.budget
    if (!isObject(budget)) return fail('PROFILE_BUDGET_INVALID', 'budget 必须是对象')
    for (const [key, [min, max]] of Object.entries(PROFILE_BUDGET)) {
      const value = budget[key]
      if (value === undefined) continue
      if (!Number.isInteger(value) || value < min || value > max) {
        return fail('PROFILE_BUDGET_INVALID', `budget.${key} 必须是 ${min}–${max} 的整数`)
      }
    }
  }
  if (profile.stages !== undefined) {
    const stages = profile.stages
    if (!Array.isArray(stages) || stages.length < 2 || stages.length > STAGES.length) {
      return fail('PROFILE_STAGES_INVALID', 'stages 至少 2 个阶段，且取自固定阶段表')
    }
    let cursor = -1
    for (const stage of stages) {
      const index = STAGES.indexOf(stage)
      if (index < 0 || index <= cursor) {
        return fail('PROFILE_STAGES_INVALID', 'stages 必须是 assess → plan → implement → gates → review 的有序子序列')
      }
      cursor = index
    }
    if (!stages.includes('implement') || !stages.includes('gates')) {
      return fail('PROFILE_STAGES_INVALID', 'stages 必须包含 implement 与 gates（只跑 review 请用作阶段档位）')
    }
  }

  if (environment.backendState === 'unverified') {
    return fail('PROFILE_BACKEND_UNVERIFIED', `后端 ${profile.backend} 尚未核验，先完成探针再保存`)
  }
  if (environment.backendState === 'stale') {
    return fail('PROFILE_BACKEND_STALE', `后端 ${profile.backend} 的核验证据已过期，请重新核验`)
  }
  if (environment.backendEnabled === false) {
    return fail('PROFILE_BACKEND_DISABLED', `后端 ${profile.backend} 未在 executor.workers 中启用`)
  }
  if (profile.preset && profile.backend !== 'dsh') {
    return fail('PROFILE_PRESET_UNKNOWN', 'preset 只对 dsh 档位生效')
  }
  if (environment.presetKnown === false) {
    return fail('PROFILE_PRESET_UNKNOWN', `宿主不存在 preset：${profile.preset}`)
  }
  if (profile.model?.reasoningEffort && profile.model.reasoningEffort !== 'auto' && environment.effortSupported === false) {
    return fail('PROFILE_EFFORT_UNSUPPORTED', `后端 ${profile.backend} 不支持 reasoningEffort`)
  }
  if (isObject(environment.capabilities)) {
    const missing = (profile.requires ?? []).filter(capability => environment.capabilities[capability] !== true)
    if (missing.length) {
      return fail('PROFILE_CAPABILITY_GAP', `后端 ${profile.backend} 缺少能力：${missing.join(', ')}`, { missing })
    }
  }
  return { ok: true, profile }
}

/** Verified capabilities only: a tool the host has but cannot use is not a capability (§3.6). */
export function capabilitiesOf(probe) {
  const unverified = new Set(Array.isArray(probe?.unverified) ? probe.unverified : [])
  const declared = isObject(probe?.capabilities) ? probe.capabilities : {}
  const out = {}
  for (const capability of PROFILE_CAPABILITIES) out[capability] = declared[capability] === true && !unverified.has(capability)
  return out
}

/** The execution parameters a profile contributes, with nothing defaulted (the caller owns defaults). */
export function paramsOfProfile(profile) {
  const budget = isObject(profile?.budget) ? profile.budget : {}
  const model = isObject(profile?.model) ? profile.model : undefined
  return {
    preset: typeof profile?.preset === 'string' ? profile.preset : undefined,
    model: model && typeof model.provider === 'string' && typeof model.model === 'string'
      ? { provider: model.provider, model: model.model }
      : undefined,
    reasoningEffort: typeof model?.reasoningEffort === 'string' ? model.reasoningEffort : undefined,
    denyTools: Array.isArray(profile?.tools?.deny) ? profile.tools.deny.slice() : undefined,
    allowMcp: Array.isArray(profile?.tools?.allowMcp) ? profile.tools.allowMcp.slice() : undefined,
    budget: {
      timeoutMs: Number.isInteger(budget.timeoutMs) ? budget.timeoutMs : undefined,
      idleTimeoutMs: Number.isInteger(budget.idleTimeoutMs) ? budget.idleTimeoutMs : undefined,
      maxRepairRounds: Number.isInteger(budget.maxRepairRounds) ? budget.maxRepairRounds : undefined,
    },
    stages: Array.isArray(profile?.stages) ? profile.stages.slice() : undefined,
  }
}

/**
 * Resolve one profile into the options a worker invocation receives (§9.1).
 *
 * `context` carries executor defaults and the run's own constraints: `denyTools` (the hard
 * blacklist), `preset`, the three budget defaults, `readOnly`, and verified `capabilities`.
 */
export function resolveProfile(profile, context = {}) {
  const params = paramsOfProfile(profile)
  const deny = [...new Set([...(context.denyTools ?? []), ...(params.denyTools ?? [])])]
  return {
    id: profile.id,
    backend: profile.backend,
    model: params.model,
    preset: params.preset ?? context.preset,
    denyTools: deny,
    allowMcp: params.allowMcp,
    readOnly: context.readOnly === true,
    systemPromptExtra: {
      role: profile.prompt?.role ?? '',
      must: Array.isArray(profile.prompt?.must) ? profile.prompt.must.slice() : [],
      skills: Array.isArray(profile.skills?.prefer) ? profile.skills.prefer.slice() : [],
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
 * Synthesize the transient ad-hoc profile for a ticket (§8.3). Deterministic: the same requirement
 * set and backend order always yield the same id, and the id is never offered for saving.
 *
 * @param {{requires?:string[], deliverable?:string, capabilities?:any, backendOrder?:string[], role?:string,
 *   preset?:string, model?:{provider:string, model:string, reasoningEffort?:string}}} [options]
 * @returns {object|null} a normalized transient profile, or null when no backend covers the requirement
 */
export function synthesizeProfile({
  requires = [],
  deliverable = 'change',
  capabilities,
  backendOrder = PROFILE_BACKENDS,
  role = '',
  preset,
  model,
} = {}) {
  const wanted = deliverable === 'report'
    ? []
    : [...new Set(requires.filter(capability => PROFILE_CAPABILITIES.includes(capability)))].sort()
  // `capabilities` may be one backend's verified set, or a map keyed by backend name (each built-in
  // independent). A backend missing from the map gets the flat form, which then simply lacks the keys.
  const capsOf = name => (isObject(capabilities) && isObject(capabilities[name]) ? capabilities[name] : capabilities)
  const backend = backendOrder.find(name =>
    PROFILE_BACKENDS.includes(name)
    && PROFILE_CAPABILITIES.every(capability => !wanted.includes(capability) || capsOf(name)?.[capability] === true))
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
  return sortProfile({
    id: `adhoc:${digestOf(fingerprint).slice(0, 8)}`,
    name: '现拉',
    description: '按工单需求临时合成，未保存为档位。',
    backend,
    requires: wanted,
    ...(preset ? { preset } : {}),
    ...(model ? { model } : {}),
    ...(rolePrefix ? { prompt: { role: rolePrefix } } : {}),
  })
}

function profileError(code, message, problems) {
  const error = /** @type {Error & {code:string, problems?:string[]}} */ (new Error(message))
  error.code = code
  if (problems) error.problems = problems
  return error
}

/** `executor.profilesFile` is a bare filename: a path here would let a repo reach outside the state dir. */
export function profilesFileOf(config) {
  const raw = config?.executor?.profilesFile
  if (raw === undefined || raw === null || raw === '') return { name: PROFILE_FILE_NAME, error: undefined }
  if (typeof raw !== 'string') return { name: PROFILE_FILE_NAME, error: 'executor.profilesFile 必须是文件名' }
  const name = raw.trim()
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name) || name.includes('..')) {
    return { name: PROFILE_FILE_NAME, error: 'executor.profilesFile 只能是 stateDir 下的文件名（不能带路径）' }
  }
  return { name, error: undefined }
}

export function profilesPath(stateDir, config) {
  return join(stateDir, profilesFileOf(config).name)
}

/**
 * Parse a profiles document. Unknown keys are reported, invalid profiles are dropped with a warning,
 * but a corrupt document or a newer version is refused as a whole (I2/I7; never silently fall back).
 */
export function parseProfilesDocument(raw) {
  const droppedKeys = []
  const truncated = []
  const warnings = []
  if (!isObject(raw)) {
    return { version: undefined, profiles: [], droppedKeys, truncated, warnings, error: '档位文件顶层必须是对象', code: 'PROFILE_FILE_CORRUPT' }
  }
  for (const key of Object.keys(raw)) if (!['version', 'profiles'].includes(key)) droppedKeys.push(key)
  const version = raw.version
  if (version === undefined) {
    return { version, profiles: [], droppedKeys, truncated, warnings, error: '档位文件缺少 version', code: 'PROFILE_FILE_CORRUPT' }
  }
  if (version !== PROFILE_FILE_VERSION) {
    return {
      version,
      profiles: [],
      droppedKeys,
      truncated,
      warnings,
      error: `档位文件版本 ${version} 比本插件支持的 ${PROFILE_FILE_VERSION} 新，请升级插件`,
      code: 'PROFILE_FILE_VERSION_UNSUPPORTED',
    }
  }
  const normalized = normalizeProfiles(raw.profiles)
  droppedKeys.push(...normalized.droppedKeys)
  truncated.push(...normalized.truncated)
  warnings.push(...normalized.warnings)
  const profiles = []
  for (const profile of normalized.profiles) {
    if (isBuiltinProfile(profile.id)) {
      warnings.push(`内置档位不可编辑，已忽略文件中的 ${profile.id}`)
      continue
    }
    const checked = validateProfile(profile)
    if (!checked.ok) {
      warnings.push(`档位 ${profile.id} 不合法：${checked.code} ${checked.message}`)
      continue
    }
    profiles.push(checked.profile)
  }
  if (profiles.length > PROFILE_LIMITS.profiles) {
    warnings.push(`档位最多 ${PROFILE_LIMITS.profiles} 个，多余的已忽略`)
    profiles.length = PROFILE_LIMITS.profiles
  }
  return { version, profiles, droppedKeys: uniqueStrings(droppedKeys), truncated: uniqueStrings(truncated), warnings, error: undefined, code: undefined }
}

/**
 * Read `<stateDir>/worker-profiles.json`. Missing file => built-ins only (not an error); a corrupt
 * or future-versioned file => `profiles: []` plus a code, so dispatch can refuse instead of
 * guessing. `stateDir` absent (tests, dry reads) returns built-ins without touching the disk.
 */
export function readProfiles(stateDir, config) {
  const { error: fileError } = profilesFileOf(config)
  const file = stateDir ? profilesPath(stateDir, config) : undefined
  const base = {
    file,
    exists: false,
    builtin: true,
    version: undefined,
    profiles: [],
    droppedKeys: [],
    truncated: [],
    warnings: [],
    error: fileError,
    code: fileError ? 'PROFILE_FILE_INVALID' : undefined,
  }
  if (!file) return { ...base, profiles: [...builtinProfiles(), ...[]] }
  if (!existsSync(file)) return { ...base, profiles: builtinProfiles() }
  let raw
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return { ...base, exists: true, builtin: false, profiles: [], error: '档位文件不是合法 JSON', code: 'PROFILE_FILE_CORRUPT' }
  }
  const parsed = parseProfilesDocument(raw)
  // A refused document must not silently degrade to the built-ins: dispatch sees the code and stops.
  return {
    ...base,
    exists: true,
    builtin: false,
    ...parsed,
    profiles: parsed.code ? [] : [...builtinProfiles(), ...parsed.profiles],
  }
}

/**
 * Validate and persist a profiles document. Throws an Error with `code` (`PROFILE_SCHEMA_INVALID`,
 * `PROFILE_DUPLICATE_ID`, `PROFILE_FILE_INVALID`) — the panel shows `code` + `message` inline.
 */
export async function writeProfiles(stateDir, config, document) {
  const { name, error: fileError } = profilesFileOf(config)
  if (fileError) throw profileError('PROFILE_FILE_INVALID', fileError)
  const normalized = normalizeProfiles(document?.profiles)
  const problems = [...normalized.warnings]
  if (normalized.droppedKeys.length) problems.push(`未知字段：${normalized.droppedKeys.join(', ')}`)
  if (normalized.truncated.length) problems.push(`超出上限：${normalized.truncated.join(', ')}`)
  const profiles = []
  const seen = new Set()
  for (const profile of normalized.profiles) {
    if (isBuiltinProfile(profile.id)) {
      problems.push(`内置档位不可编辑：${profile.id}（可复制为新档位）`)
      continue
    }
    if (seen.has(profile.id)) {
      problems.push(`档位 id 重复：${profile.id}`)
      continue
    }
    seen.add(profile.id)
    const checked = validateProfile(profile, document?.environment)
    if (!checked.ok) {
      problems.push(`${profile.id || '(缺少 id)'}：${checked.code} ${checked.message}`)
      continue
    }
    profiles.push(checked.profile)
  }
  if (profiles.length > PROFILE_LIMITS.profiles) problems.push(`档位最多 ${PROFILE_LIMITS.profiles} 个`)
  if (problems.length) {
    const code = problems.some(line => line.includes('重复')) ? 'PROFILE_DUPLICATE_ID' : 'PROFILE_SCHEMA_INVALID'
    throw profileError(code, problems.join('；'), problems)
  }
  const payload = { version: PROFILE_FILE_VERSION, profiles }
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, name)
  const temp = join(stateDir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  try {
    await writeFileDurable(temp, `${JSON.stringify(payload, undefined, 2)}\n`, { mode: 0o600 })
    await rename(temp, file)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return { ...payload, file }
}

/** Digest of the full profile set (built-ins included) for the dispatch cache key (§7.5). */
export function profilesDigest(profiles) {
  return digestOf((profiles ?? []).map(profile => sortProfile(profile)))
}
