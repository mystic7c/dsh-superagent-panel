/**
 * Mutations behind the management panel: versioned settings saves with optimistic concurrency, processing
 * pause, Source allowlist sync, ticket retry/stop, decision dismiss, trigger requeue, thread unsubscribe,
 * prompt revisions, and the deployment check (which really probes the configured GitHub CLI).
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { now, id, clone, preview } from './util.js'
import { PromptError, defaultPrompts, previewPrompts, validatePrompts, defaultChanged } from './prompts.js'

const run = promisify(execFile)

/** An error the HTTP layer maps to a status with a structured payload. */
export class ActionError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra }
}
const bad = (message, extra) => { throw new ActionError(400, message, extra) }
const missing = (message = '记录不存在') => { throw new ActionError(404, message) }

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const plainText = (value) => typeof value === 'string' ? value : value?.zh ?? value?.en ?? ''
const str = (value, path, issues, { max = 400, required = true } = {}) => {
  if (value === undefined || value === null || value === '') { if (required) issues.push({ path, message: '必填' }); return '' }
  if (typeof value !== 'string') { issues.push({ path, message: '应为字符串' }); return '' }
  if (value.length > max) issues.push({ path, message: `不能超过 ${max} 个字符` })
  return value
}
const num = (value, path, issues, { min, max } = {}) => {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || Number.isNaN(value)) { issues.push({ path, message: '应为数字' }); return undefined }
  if (min !== undefined && value < min) issues.push({ path, message: `不能小于 ${min}` })
  if (max !== undefined && value > max) issues.push({ path, message: `不能大于 ${max}` })
  return value
}
const bool = (value, path, issues, fallback) => {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') { issues.push({ path, message: '应为布尔值' }); return fallback }
  return value
}
const strings = (value, path, issues) => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) { issues.push({ path, message: '应为字符串数组' }); return [] }
  return value
}

/** Validate one settings block and merge it into a candidate settings value (original values are not touched). */
export function validateSettingsBlock(block, value, current) {
  const candidate = clone(current)
  const issues = []
  if (block === 'pause') {
    if (!isObject(value)) bad('pause 必须是对象', { issues: [{ path: 'value', message: '应为对象' }] })
    candidate.paused = bool(value.paused, 'paused', issues, !!current.paused)
  } else if (block === 'eval') {
    if (!isObject(value)) bad('eval 必须是对象', { issues: [{ path: 'value', message: '应为对象' }] })
    const acceptMode = value.acceptMode ?? current.eval.acceptMode
    if (!['off', 'observe', 'auto'].includes(acceptMode)) issues.push({ path: 'acceptMode', message: '应为 off / observe / auto' })
    const timeoutSeconds = num(value.timeoutSeconds ?? current.eval.timeoutSeconds, 'timeoutSeconds', issues, { min: 60, max: 86_400 })
    let model = value.model === undefined ? current.eval.model : value.model
    if (model !== null) {
      if (!isObject(model) || typeof model.provider !== 'string' || typeof model.model !== 'string') issues.push({ path: 'model', message: '应为 { provider, model } 或 null' })
      else model = { provider: model.provider, model: model.model, ...model.reasoningEffort ? { reasoningEffort: String(model.reasoningEffort) } : {} }
    }
    candidate.eval = { acceptMode, timeoutSeconds, model }
  } else if (block === 'executor') {
    if (!isObject(value)) bad('executor 必须是对象', { issues: [{ path: 'value', message: '应为对象' }] })
    const previous = current.executor
    let workerModel = value.workerModel === undefined ? previous.workerModel : value.workerModel
    if (workerModel !== null) {
      if (!isObject(workerModel) || typeof workerModel.provider !== 'string' || typeof workerModel.model !== 'string') issues.push({ path: 'workerModel', message: '应为 { provider, model } 或 null' })
      else workerModel = { provider: workerModel.provider, model: workerModel.model, ...workerModel.reasoningEffort ? { reasoningEffort: String(workerModel.reasoningEffort) } : {} }
    }
    candidate.executor = {
      workerModel,
      maxWorkers: num(value.maxWorkers ?? previous.maxWorkers, 'maxWorkers', issues, { min: 1, max: 16 }) ?? previous.maxWorkers,
      directoryRoot: str(value.directoryRoot ?? previous.directoryRoot, 'directoryRoot', issues, { max: 500 }),
      prepare: str(value.prepare ?? previous.prepare, 'prepare', issues, { max: 2000, required: false }),
      blockedCommands: value.blockedCommands === undefined ? previous.blockedCommands : strings(value.blockedCommands, 'blockedCommands', issues),
    }
  } else if (block === 'policy') {
    if (!isObject(value)) bad('policy 必须是对象', { issues: [{ path: 'value', message: '应为对象' }] })
    const rules = Array.isArray(value.rules) ? value.rules : current.policy.rules
    const seen = new Set()
    const parsedRules = []
    for (const [index, rule] of rules.entries()) {
      if (!isObject(rule)) { issues.push({ path: `rules[${index}]`, message: '应为对象' }); continue }
      const ruleId = str(rule.id, `rules[${index}].id`, issues, { max: 60 })
      if (seen.has(ruleId)) issues.push({ path: `rules[${index}].id`, message: '重复的规则 id' })
      seen.add(ruleId)
      parsedRules.push({ id: ruleId, name: str(rule.name, `rules[${index}].name`, issues, { max: 120 }),
        instruction: str(rule.instruction, `rules[${index}].instruction`, issues, { max: 2000 }),
        enabled: bool(rule.enabled, `rules[${index}].enabled`, issues, true) })
    }
    const sources = {}
    for (const sourceId of ['github', 'feishu']) {
      const part = value.sources?.[sourceId] ?? current.policy.sources?.[sourceId] ?? { allowed: [], bots: [] }
      const rows = (key) => {
        const list = Array.isArray(part[key]) ? part[key] : []
        return list.flatMap((row, index) => isObject(row) && typeof row.id === 'string' && row.id.trim()
          ? [{ id: row.id.trim(), name: typeof row.name === 'string' ? row.name : row.id.trim() }]
          : (issues.push({ path: `sources.${sourceId}.${key}[${index}]`, message: '应为 { id, name }' }), []))
      }
      sources[sourceId] = { allowed: rows('allowed'), bots: rows('bots'), admission: part.admission ?? {} }
    }
    candidate.policy = { rules: parsedRules, sources }
  } else if (block.startsWith('source:')) {
    const sourceId = block.slice('source:'.length)
    if (!['github', 'feishu'].includes(sourceId)) bad(`未知设置块：${block}`)
    if (!isObject(value)) bad(`${block} 必须是对象`, { issues: [{ path: 'value', message: '应为对象' }] })
    const previous = current.sources?.[sourceId] ?? { enabled: true, config: {} }
    const config = { ...(previous.config ?? {}), ...(isObject(value.config) ? value.config : {}) }
    if (sourceId === 'github') {
      config.repository = str(config.repository, 'config.repository', issues, { max: 200, required: false })
      if (config.repository && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(config.repository)) issues.push({ path: 'config.repository', message: '应为 owner/name' })
      config.cli = str(config.cli, 'config.cli', issues, { max: 400, required: false })
      config.pollSeconds = num(config.pollSeconds, 'config.pollSeconds', issues, { min: 10, max: 3600 }) ?? 60
      config.readLimit = num(config.readLimit, 'config.readLimit', issues, { min: 1, max: 500 }) ?? 50
      const receive = isObject(config.receive) ? config.receive : {}
      config.receive = { issues: receive.issues !== false, pullRequests: receive.pullRequests !== false,
        comments: receive.comments !== false, ci: receive.ci === true }
    } else {
      config.cli = str(config.cli, 'config.cli', issues, { max: 400, required: false })
    }
    candidate.sources = { ...candidate.sources, [sourceId]: { enabled: bool(value.enabled, 'enabled', issues, previous.enabled !== false), config } }
  } else {
    bad(`未知设置块：${block}`)
  }
  if (issues.length) throw new ActionError(400, '设置校验未通过', { issues })
  return candidate
}

/** Structured diff between two settings documents, used for the save history list. */
export function settingsChanges(before, after) {
  const changes = []
  const ruleBefore = new Map((before.policy?.rules ?? []).map(rule => [rule.id, rule]))
  for (const rule of after.policy?.rules ?? []) {
    const old = ruleBefore.get(rule.id)
    if (!old) { changes.push({ code: 'ruleAdded', name: rule.name }); continue }
    if (old.name !== rule.name) changes.push({ code: 'ruleRenamed', from: old.name, to: rule.name })
    if (old.instruction !== rule.instruction) changes.push({ code: 'ruleInstruction', name: rule.name })
    if (!!old.enabled !== !!rule.enabled) changes.push({ code: rule.enabled ? 'ruleEnabled' : 'ruleDisabled', name: rule.name })
  }
  for (const old of before.policy?.rules ?? []) if (!(after.policy?.rules ?? []).some(rule => rule.id === old.id)) changes.push({ code: 'ruleRemoved', name: old.name })
  if (before.eval?.acceptMode !== after.eval?.acceptMode) changes.push({ code: 'mode', from: before.eval?.acceptMode, to: after.eval?.acceptMode })
  if (before.eval?.timeoutSeconds !== after.eval?.timeoutSeconds) changes.push({ code: 'timeout', from: before.eval?.timeoutSeconds, to: after.eval?.timeoutSeconds })
  if (JSON.stringify(before.eval?.model) !== JSON.stringify(after.eval?.model)) changes.push({ code: 'evalModel' })
  if (JSON.stringify(before.executor?.workerModel) !== JSON.stringify(after.executor?.workerModel)) changes.push({ code: 'executorModel' })
  if (before.executor?.maxWorkers !== after.executor?.maxWorkers) changes.push({ code: 'maxWorkers', from: before.executor?.maxWorkers, to: after.executor?.maxWorkers })
  if (before.paused !== after.paused) changes.push({ code: after.paused ? 'paused' : 'resumed' })
  if (before.executor?.directoryRoot !== after.executor?.directoryRoot) changes.push({ code: 'executionDirectory', from: before.executor?.directoryRoot, to: after.executor?.directoryRoot })
  if (before.executor?.prepare !== after.executor?.prepare) changes.push({ code: 'prepareCommand' })
  if (JSON.stringify(before.executor?.blockedCommands) !== JSON.stringify(after.executor?.blockedCommands)) changes.push({ code: 'blockedCommands', from: (before.executor?.blockedCommands ?? []).join(' '), to: (after.executor?.blockedCommands ?? []).join(' ') })
  for (const sourceId of ['github', 'feishu']) {
    const a = before.policy?.sources?.[sourceId] ?? {}, b = after.policy?.sources?.[sourceId] ?? {}
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      const removed = (a.allowed ?? []).filter(row => !(b.allowed ?? []).some(item => item.id === row.id))
      const added = (b.allowed ?? []).filter(row => !(a.allowed ?? []).some(item => item.id === row.id))
      if (added.length) changes.push({ code: 'sourceRowsAdded', source: sourceId, part: true, field: 'allowed', items: added.map(row => row.name ?? row.id) })
      if (removed.length) changes.push({ code: 'sourceRowsRemoved', source: sourceId, part: true, field: 'allowed', items: removed.map(row => row.name ?? row.id) })
      if (!added.length && !removed.length) changes.push({ code: 'sourceAdmission', source: sourceId, part: true })
    }
    const oldSource = before.sources?.[sourceId] ?? {}, newSource = after.sources?.[sourceId] ?? {}
    if (oldSource.enabled !== newSource.enabled) changes.push({ code: newSource.enabled ? 'sourceEnabled' : 'sourceDisabled', source: sourceId })
    for (const field of Object.keys(newSource.config ?? {})) {
      if (JSON.stringify(oldSource.config?.[field]) !== JSON.stringify(newSource.config?.[field])) {
        changes.push({ code: 'sourceField', source: sourceId, part: true, field, from: oldSource.config?.[field], to: newSource.config?.[field] })
      }
    }
  }
  return changes
}

/** Save one settings block against its revision. Returns `{ revision, restarting, context_delivery }`. */
export async function saveSettings(host, block, value, revision) {
  if (typeof revision !== 'number') bad('缺少 revision')
  if (host.store.revision(block) !== revision) throw new ActionError(409, '设置已变化，请重新载入后再保存。')
  const store = host.store
  const before = clone(store.settings)
  const candidate = validateSettingsBlock(block, value, before)
  if (JSON.stringify(candidate) === JSON.stringify(before)) {
    return { saved: true, revision: store.revision(block), policy_changed: false, restarting: false, context_delivery: 'pending' }
  }
  const changes = settingsChanges(before, candidate)
  const policyChanged = ['policy', 'eval', 'source:github', 'source:feishu'].includes(block)
  // Account fields change the CLI identity/repository the Sources use; an enable switch alone does not need a re-check.
  const accountFields = ['repository', 'cli']
  const restarting = block.startsWith('source:') && (() => {
    const sourceId = block.slice('source:'.length)
    const old = before.sources?.[sourceId]?.config ?? {}, next = candidate.sources?.[sourceId]?.config ?? {}
    return accountFields.some(field => JSON.stringify(old[field]) !== JSON.stringify(next[field]))
  })()
  const edit = (state) => {
    Object.assign(state.settings, candidate)
    state.revisions = { ...state.revisions, global: (state.revisions.global ?? 0) + 1 }
    state.revisions[block] = (state.revisions[block] ?? 0) + 1
    state.meta = { ...state.meta, policyVersion: policyChanged ? `${state.meta?.policyVersion ?? 'pol_1'}` : state.meta?.policyVersion }
    state.settingsHistory = [{ revision: state.revisions.global, savedAt: now(), source: 'panel', block,
      policyVersion: state.meta?.policyVersion ?? 'pol_1', policyChanged, notified: [], changes }, ...(state.settingsHistory ?? [])].slice(0, 30)
    if (block === 'pause') state.executor = { ...state.executor, paused: candidate.paused }
    // Source account changes re-run the deployment check like the prototype's restart path, without a restart here.
    if (restarting) state.setupCache = { ...(state.setupCache ?? {}), dirty: true }
  }
  await store.atomic(edit)
  if (restarting) await host.recheckSetup?.()
  return { saved: true, revision: store.revision(block), policy_changed: policyChanged, restarting, context_delivery: 'pending' }
}

/** Re-read a Source's allowlist (labels) and report the current policy summary. */
export async function syncSource(host, sourceId) {
  if (!['github', 'feishu'].includes(sourceId)) bad(`未知来源：${sourceId}`)
  const store = host.store
  const labels = {}
  for (const row of store.settings.policy.sources?.[sourceId]?.allowed ?? []) labels[row.id] = row.name ?? row.id
  for (const row of store.settings.policy.sources?.[sourceId]?.bots ?? []) labels[row.id] = row.name ?? row.id
  await store.atomic((state) => {
    state.sources[sourceId] = { ...(state.sources[sourceId] ?? {}), labels, sync: { state: 'ready', detail: `名单已同步（${Object.keys(labels).length} 个账号）`, at: now() } }
  })
  return { policy: { rules: (store.settings.policy.rules ?? []).map(rule => ({ id: rule.id, name: rule.name, enabled: !!rule.enabled })),
    allowed: Object.fromEntries(Object.entries(store.settings.policy.sources ?? {}).map(([id, part]) => [id, (part.allowed ?? []).length])) } }
}

/** Pause or resume processing; recorded as its own `pause` block so concurrent edits stay valid. */
export async function setPaused(host, paused) {
  const store = host.store
  const before = clone(store.settings)
  if (!!paused === !!before.paused) return { paused: !!paused }
  const candidate = clone(before)
  candidate.paused = !!paused
  await store.atomic((state) => {
    state.settings.paused = !!paused
    state.executor = { ...state.executor, paused: !!paused }
    state.revisions = { ...state.revisions, pause: (state.revisions.pause ?? 0) + 1, global: (state.revisions.global ?? 0) + 1 }
    state.settingsHistory = [{ revision: state.revisions.global, savedAt: now(), source: 'panel', block: 'pause',
      policyVersion: state.meta?.policyVersion ?? 'pol_1', policyChanged: false, notified: [],
      changes: [{ code: paused ? 'paused' : 'resumed' }] }, ...(state.settingsHistory ?? [])].slice(0, 30)
  })
  return { paused: !!paused }
}

/** Retry a ticket waiting on a failed delivery or a blocked/failed report: it returns to the executor queue. */
export async function retryTicket(host, ticketId) {
  const store = host.store
  const ticket = store.tickets[ticketId]
  if (!ticket) missing('工单不存在')
  await store.atomic((state) => {
    const target = state.tickets[ticketId]
    delete target.delivery
    target.inputs = [...(target.inputs ?? []), { id: id('inp'), kind: 'note', at: now(), text: '由管理面板重试：回到执行器队列。' }]
    target.assignments = [...(target.assignments ?? []), { id: id('asg'), state: 'pending' }]
    target.updatedAt = now()
    state.executor = { ...state.executor, queued: (state.executor?.queued ?? 0) + 1 }
  })
  return { retried: true }
}

/** Stop an open ticket; it ends `by: human` with the outcome that a person stopped it. */
export async function stopTicket(host, ticketId) {
  const store = host.store
  if (!store.tickets[ticketId]) missing('工单不存在')
  await store.atomic((state) => {
    const target = state.tickets[ticketId]
    target.ends = { at: now(), by: 'human', outcome: 'stopped', reason: '由人在管理面板停止' }
    target.updatedAt = now()
  })
  return { stopped: true }
}

/** Dismiss the problem shown for an unavailable decision. */
export async function dismissDecision(host, decisionId) {
  const store = host.store
  if (!store.decisions[decisionId]) missing('决策不存在')
  await store.atomic((state) => { state.decisions[decisionId].dismissed = true })
  return { dismissed: true }
}

/** Send a trigger back to Eval: it leaves its source filter and returns to the thread's pending queue. */
export async function requeueTrigger(host, triggerId) {
  const store = host.store
  const trigger = store.triggers[triggerId]
  if (!trigger) missing('触发不存在')
  await store.atomic((state) => {
    const target = state.triggers[triggerId]
    delete target.filtered
    target.disposition = { ...(target.disposition ?? {}), requeued: true, fanout: [], decisionId: undefined }
    const thread = target.threads?.[0] ? state.threads[target.threads[0]] : undefined
    if (thread) {
      thread.pending = [...new Set([...(thread.pending ?? []), triggerId])]
      thread.lastAt = now()
    }
  })
  return { queued: true }
}

/** Stop following a thread: open tickets subscribed to it drop the subscription (the thread keeps its history). */
export async function unsubscribeThread(host, key) {
  const store = host.store
  if (!store.threads[key]) missing('线程不存在')
  let removed = false
  await store.atomic((state) => {
    const thread = state.threads[key]
    if (!thread) return
    removed = (thread.subscriptions ?? []).length > 0
    for (const ticketId of thread.subscriptions ?? []) {
      const ticket = state.tickets[ticketId]
      if (!ticket) continue
      ticket.threads = (ticket.threads ?? []).filter(item => item !== key)
      ticket.updatedAt = now()
    }
    thread.subscriptions = []
    thread.context = []
  })
  return { removed, thread: key, context_delivery: 'injected' }
}

/** Save a prompt configuration against its base revision. */
export async function savePrompts(host, config, baseRevision, limit = 100_000) {
  const store = host.store
  const prompts = store.prompts ?? { revision: 0, config: defaultPrompts(), history: [] }
  if (prompts.revision !== baseRevision) throw new ActionError(409, '提示词版本已变化，请先对比最新版本。')
  let parsed
  try {
    parsed = validatePrompts(config, prompts.config, limit)
  } catch (error) {
    if (error instanceof PromptError) throw new ActionError(400, '提示词校验未通过', { issues: [{ path: error.values.part ?? error.values.name ?? '', message: error.code }] })
    throw error
  }
  await store.atomic((state) => {
    const current = state.prompts ?? { revision: 0, config: defaultPrompts(), history: [] }
    const revision = current.revision + 1
    state.prompts = { revision, baseRevision: revision, config: parsed, builtIns: current.builtIns ?? {},
      history: [{ revision, savedAt: now(), source: 'panel', config: clone(parsed) }, ...(current.history ?? [])].slice(0, 30) }
  })
  return { revision: store.prompts.revision, context_delivery: 'injected' }
}

/** Preview both role prompts for a submitted configuration without saving it. */
export function previewPromptsFor(host, config) {
  const store = host.store
  let parsed
  try {
    parsed = validatePrompts(config, store.prompts?.config, 100_000)
  } catch (error) {
    if (error instanceof PromptError) throw new ActionError(400, '提示词校验未通过', { issues: [{ path: error.values.part ?? error.values.name ?? '', message: error.code }] })
    throw error
  }
  const environment = environmentSection(host)
  const policy = policySection(store.settings)
  return previewPrompts(parsed, environment, policy)
}

/** The execution environment block: the variables a ticket directory reads, from current settings. */
export function environmentSection(host) {
  const settings = host.store.settings
  const variables = host.environment ?? []
  const lines = variables.map(variable => `${variable.name}=${variable.value ?? '<未配置>'}`).join('\n')
  return `Execution environment (from this installation's settings; it takes precedence over any repository or account named
elsewhere in these instructions; an empty value means that part is not configured here). The prepare command of a
ticket directory reads the same variables:\n${lines}`
}
/** The orchestrator-only Policy section, filled from the current settings. */
export function policySection(settings) {
  const rules = (settings.policy.rules ?? []).filter(rule => rule.enabled)
    .map(({ id: ruleId, name, instruction }) => `- ${String(name).replace(/\s*\n\s*/g, ' ')} (${ruleId}): ${String(instruction).replace(/\s*\n\s*/g, ' ')}`)
  const head = `## Policy\nPolicy version ${'pol_1'}; accept mode ${settings.eval.acceptMode}. The accept mode and the rules decide proactive candidates only: an explicit request is routed as dispatch says, in any mode and whatever the rules.`
  const part = rules.length ? `The enabled rules, by name and id:\n${rules.join('\n')}` : 'No rule is enabled: a proactive candidate can only be ignored.'
  return { key: rules.length ? 'runtime/policy' : 'runtime/policy/none', text: `${head}\n${part}` }
}

/** Deployment check: probe the configured GitHub CLI for identity and push access; record the result. */
export async function setupCheck(host) {
  const store = host.store
  const config = store.settings.sources?.github?.config ?? {}
  const result = { problem: null, feishuProblem: null, accounts: null }
  const probe = async (argv, timeout = 8000) => {
    const { stdout } = await run(argv[0], argv.slice(1), { timeout, maxBuffer: 1024 * 1024 })
    return String(stdout)
  }
  if (!config.repository) {
    result.problem = { code: 'repositoryUnset', values: { detail: 'GitHub 来源没有配置仓库' }, place: 'github' }
  } else if (!config.cli) {
    result.problem = { code: 'agentCliUnset', values: { detail: 'GitHub 来源没有配置 CLI' }, place: 'github' }
  } else {
    let login
    try {
      const output = await probe([config.cli, 'api', 'user'])
      login = JSON.parse(output).login
      if (typeof login !== 'string') throw new Error('unexpected response')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      result.problem = { code: /ENOENT|not found|no such file/i.test(message) ? 'agentCliMissing' : 'agentCliSignedOut',
        values: { detail: message.split('\n')[0], output: message.slice(0, 2000) }, place: 'github' }
    }
    if (login) {
      try {
        const output = await probe([config.cli, 'api', `repos/${config.repository}`, '--jq', '{name: .full_name, push: .permissions.push}'])
        const access = JSON.parse(output)
        if (access.push !== true) result.problem = { code: 'repositoryReadOnly', values: { detail: '当前 CLI 身份没有推送权限', account: login, repository: access.name }, place: 'github' }
        else {
          const facts = store.sources?.feishu?.facts
          result.accounts = { repository: access.name, agent: login, feishu: facts?.appId
            ? { appId: plainText(facts.appId), brand: plainText(facts.brand) || 'feishu', botId: plainText(facts.botId), name: plainText(facts.name) }
            : null }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        result.problem = { code: 'repositoryUnreadable', values: { detail: message.split('\n')[0], account: login, repository: config.repository }, place: 'github' }
      }
    }
  }
  // Feishu needs a bot CLI; the panel can only verify that one is configured, not that it is signed in.
  if (!store.settings.sources?.feishu?.config?.cli) result.feishuProblem = { code: 'feishuCliUnset', values: { detail: '飞书来源没有配置机器人 CLI' }, place: 'feishu' }
  const checkedAt = now()
  await store.atomic((state) => {
    state.setupCache = { ...result, checkedAt, dirty: false }
    if (result.accounts) {
      state.sources.github = { ...(state.sources.github ?? {}), health: { state: 'ready', detail: `已连接 ${result.accounts.repository}（${result.accounts.agent}）`, at: checkedAt },
        facts: { repository: { zh: result.accounts.repository, en: result.accounts.repository }, agent: { zh: result.accounts.agent, en: result.accounts.agent } } }
    } else if (result.problem) {
      state.sources.github = { ...(state.sources.github ?? {}), health: { state: 'error', detail: result.problem.values.detail, at: checkedAt } }
    }
  })
  return { restarting: true, checkedAt }
}

/** Reset the document to a fresh demo seed. */
export async function resetDemo(host) {
  // The seed carries its own deployment facts; re-probing the real CLI here would replace a demo with a live failure.
  await host.store.reset()
  host.refreshEnvironment?.()
  host.refreshSetup?.()
  return { reset: true }
}

export { preview, defaultChanged }
