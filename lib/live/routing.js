/**
 * Worker routing (P1/P3): which backend runs one Ticket, with which profile and deliverable.
 *
 * The old classifier read the first matching keyword in the title/body. That put "修复登录问题，先分析原因" into a
 * read-only analysis run and "实现搜索功能" into research, because the incidental word won over the request's actual
 * deliverable. Routing now answers three separate questions:
 *
 *   1. deliverable — does this Ticket owe a code change or a written report?
 *   2. capabilities — does the work need file edits, command execution, web access and/or the report/question tools?
 *   3. backend — which enabled worker can supply every required capability?
 *
 * An explicit "只分析 / 不要修改 / read-only" still pins the deliverable to a report; an explicit change verb
 * (修复/实现/新增/…) wins over incidental analysis/research words, so a fix that also asks for a test or a web lookup is
 * still a code change. Capability checks are code, not configuration: they mirror what each adapter can really do.
 */

export const WORKER_BACKENDS = ['dsh', 'codex', 'claude']
export const ROUTING_MODES = ['single', 'suggest', 'auto']
export const WORK_TYPES = ['analysis', 'review', 'test', 'dev', 'docs', 'research', 'interactive']
export const ROUTE_PROFILES = ['read-only', 'write']
export const DELIVERABLES = ['change', 'report']
export const CAPABILITIES = ['edit', 'exec', 'web', 'report']

/** Work types that deliver a written report instead of a code change (no commit/push; Ticket ends `closed`). */
const REPORT_TYPES = new Set(['analysis', 'review', 'research', 'interactive'])

/** What each backend can do in this plugin today. Keep in sync with worker.js / worker-cli.js. */
export const BACKEND_CAPABILITIES = {
  dsh: { edit: true, exec: true, web: true, report: true },
  codex: { edit: true, exec: true, web: false, report: false },
  claude: { edit: true, exec: false, web: false, report: false },
}

/** Capability a work type needs on its own; the full list also includes the deliverable's edit/report requirement. */
const REQUIRED_CAPABILITY = { research: 'web', interactive: 'report', test: 'exec' }

export const profileOf = workType => REPORT_TYPES.has(workType) ? 'read-only' : 'write'
export const deliverableOf = workType => REPORT_TYPES.has(workType) ? 'report' : 'change'

/**
 * The operator explicitly wants a report, no matter which change words the request also contains. "先分析原因"
 * (analyze first) is not this: only words that forbid the edit ("只分析", "不要修改") pin the deliverable.
 */
const READ_ONLY_INTENT = /(只(?:做|要|需)?(?:分析|调研|评估|阅读|看看|查看)|仅(?:做|需)?(?:分析|调研|评估|阅读)|不要(?:修改|改动|动代码|改代码|实现)|无需(?:修改|改动)|不(?:修改|改|动)(?:任何)?代码|只读|read[-\s]?only|no code changes?|do not (?:modify|change|edit)|analysis only)/iu

/** Explicit change verbs. Any one of them makes the deliverable a code change, whatever else the text says. */
const CHANGE_INTENT = /(修复|修正|修好|修一下|实现|新增|添加|增加|开发|构建|编写|改造|重构|接入|支持|优化|调整|加上|补上|补齐|落地|迁移|升级|替换|删除|移除|fix|implement|add|build|refactor|migrate|upgrade|support|replace|remove)/iu

/** The worker must reach the network / look up external documentation (not merely contain the word 搜索). */
const WEB_CAPABILITY = /(联网|上网|查(?:一下)?(?:资料|文档|官网|文档链接)|查阅(?:文档|资料)|搜索(?:一下)?(?:资料|文档|网页)|浏览器|官网|最新(?:版本|文档)|look up|search the web|browse|latest docs?|documentation link)/iu

/** The worker must run commands (tests, builds, repro scripts). */
const EXEC_CAPABILITY = /(测试|验证|回归|复现|单测|跑一遍|自测|编译|构建|执行|运行|命令|脚本|test|verify|regression|build|compile|run (?:the )?(?:tests?|build|command)|mvn|pnpm|npm)/iu

const DOCS_INTENT = /(文档|readme|注释|说明文档|documentation)/iu

/** First matching rule wins for a request that does not ask for a code change. */
const REPORT_RULES = [
  ['research', /(调研|查资料|查一下资料|搜索|搜一下|联网|浏览器|网页|官网|最新版本|文档链接|look up|search|browse|web)/iu],
  ['interactive', /(需要确认|请确认|待确认|先讨论|讨论一下|给个建议|你来决定|需要你决定|confirm)/iu],
  ['review', /(review|审查|评审|代码质量|检查代码|过一遍代码|code review)/iu],
  ['test', /(测试|验证|回归|复现|单测|跑一遍|自测|test|verify|regression)/iu],
  ['docs', DOCS_INTENT],
  ['analysis', /(分析|梳理|评估|方案|影响面|排查|定位|梳理一下|analy[sz]e|analysis|assess)/iu],
]

const textOf = ticket => `${ticket?.title ?? ''}\n${ticket?.body ?? ''}`

/**
 * Classify one Ticket into the three dimensions routing cares about.
 *
 * @returns {{workType:string, deliverable:string, profile:string, capabilities:string[], explicitReadOnly:boolean}}
 */
export function classifyIntent(ticket) {
  const text = textOf(ticket)
  const explicitReadOnly = READ_ONLY_INTENT.test(text)
  const change = !explicitReadOnly && CHANGE_INTENT.test(text)
  let workType
  if (explicitReadOnly) {
    workType = REPORT_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'analysis'
  } else if (change) {
    workType = 'dev'
  } else {
    workType = REPORT_RULES.find(([, pattern]) => pattern.test(text))?.[0] ?? 'dev'
  }
  const deliverable = explicitReadOnly ? 'report' : change ? 'change' : deliverableOf(workType)
  const capabilities = new Set()
  if (deliverable === 'change') capabilities.add('edit')
  if (WEB_CAPABILITY.test(text)) capabilities.add('web')
  if (EXEC_CAPABILITY.test(text)) capabilities.add('exec')
  // Only an interactive Ticket needs the report/question tool: a read-only review can simply return its final text.
  if (workType === 'interactive') capabilities.add('report')
  return { workType, deliverable, profile: deliverable === 'report' ? 'read-only' : 'write',
    capabilities: CAPABILITIES.filter(capability => capabilities.has(capability)), explicitReadOnly }
}

/** Classify one Ticket's work type from its title and body. Kept for callers that only need the type. */
export function classifyWorkType(ticket) {
  return classifyIntent(ticket).workType
}

/**
 * Built-in preferences when live.json declares none: capability first, then the operator's intent.
 * DSH owns anything that needs the host's network or the report/question tools; Codex can run commands, so it takes
 * verification; Claude only edits files, so implementation work lands there.
 */
export const DEFAULT_PREFERENCES = [
  { workTypes: ['research', 'interactive'], backend: 'dsh' },
  { workTypes: ['analysis', 'review', 'test'], backend: 'codex' },
  { workTypes: ['dev', 'docs'], backend: 'claude' },
]

/** Backends enabled today: the legacy single backend, or every listed `executor.workers.<backend>` not disabled. */
export function enabledBackends(config) {
  const executor = config?.executor ?? {}
  const legacy = WORKER_BACKENDS.includes(executor.workerBackend) ? executor.workerBackend : 'dsh'
  if (!executor.workers || typeof executor.workers !== 'object') return [legacy]
  const enabled = WORKER_BACKENDS.filter(backend =>
    Object.prototype.hasOwnProperty.call(executor.workers, backend) && executor.workers[backend]?.enabled !== false)
  return enabled.length ? enabled : [legacy]
}

/** Effective routing block: file values when valid, otherwise legacy-compatible defaults. */
export function effectiveRouting(config) {
  const enabled = enabledBackends(config)
  const executor = config?.executor ?? {}
  const raw = executor.routing && typeof executor.routing === 'object' ? executor.routing : {}
  const legacy = WORKER_BACKENDS.includes(executor.workerBackend) ? executor.workerBackend : 'dsh'
  const mode = ROUTING_MODES.includes(raw.mode) ? raw.mode : enabled.length > 1 ? 'suggest' : 'single'
  const defaultBackend = enabled.includes(raw.defaultBackend) ? raw.defaultBackend
    : enabled.includes(legacy) ? legacy : enabled[0]
  const fallback = (Array.isArray(raw.fallback) ? raw.fallback : [])
    .filter((backend, index, list) => enabled.includes(backend) && backend !== defaultBackend && list.indexOf(backend) === index)
    .slice(0, 2)
  const preferences = Array.isArray(raw.preferences) ? raw.preferences : DEFAULT_PREFERENCES
  return { mode, defaultBackend, fallback, preferences: preferences.filter(rule => rule && rule.backend) }
}

/** The capability a work type needs, or undefined when it only needs edits. */
export function requiredCapability(workType) {
  return REQUIRED_CAPABILITY[workType]
}

/** Capabilities one intent requires: its deliverable plus every capability the request text named. */
export function requiredCapabilities(intent) {
  const capabilities = new Set(intent?.capabilities ?? [])
  if (intent?.deliverable === 'change') capabilities.add('edit')
  if (intent?.workType === 'interactive') capabilities.add('report')
  return CAPABILITIES.filter(capability => capabilities.has(capability))
}

/** Every capability one backend is missing for this intent. */
export function capabilityGaps(backend, intent) {
  const have = BACKEND_CAPABILITIES[backend]
  if (!have) return ['unknown-backend']
  return requiredCapabilities(intent).filter(capability => have[capability] !== true)
}

/** Why one backend cannot take one work type; undefined when it can. (Legacy single-capability check.) */
export function capabilityGap(backend, workType) {
  const capabilities = BACKEND_CAPABILITIES[backend]
  if (!capabilities) return 'unknown-backend'
  const required = requiredCapability(workType)
  return required && capabilities[required] !== true ? `missing-${required}` : undefined
}

/**
 * Decide the route of one Ticket.
 *
 * `override` is an operator-chosen backend (manual reassign); it always wins and is recorded as `manual`.
 * `deliverableOverride` is an operator-chosen deliverable (change|report); it cannot escape capability checks.
 * `applied` says whether the decision changes execution: `auto` and `manual` apply it; `suggest` only records it and
 * keeps running the default backend (so enabling routing never changes execution silently).
 *
 * @returns {object} route record: {workType, profile, deliverable, capabilities, backend, reason, mode, applied,
 *   execBackend, execProfile, unsupported?, enabled}
 */
export function resolveRoute({ ticket, config, override, deliverableOverride } = {}) {
  const enabled = enabledBackends(config)
  const routing = effectiveRouting(config)
  const intent = classifyIntent(ticket)
  const manualDeliverable = DELIVERABLES.includes(deliverableOverride) ? deliverableOverride : undefined
  const deliverable = manualDeliverable ?? intent.deliverable
  // Choosing a deliverable by hand changes the profile, not only the label: a report run must stay read-only.
  const workType = deliverable === intent.deliverable ? intent.workType
    : deliverable === 'report' ? (REPORT_TYPES.has(intent.workType) ? intent.workType : 'analysis')
      : (intent.workType === 'analysis' ? 'dev' : intent.workType)
  const profile = deliverable === 'report' ? 'read-only' : 'write'
  const effectiveIntent = { ...intent, workType, deliverable, profile }
  const required = requiredCapabilities(effectiveIntent)
  const manual = WORKER_BACKENDS.includes(override) && enabled.includes(override) ? override : undefined
  const preferred = routing.preferences.find(rule =>
    Array.isArray(rule.workTypes) && rule.workTypes.includes(workType) && enabled.includes(rule.backend))?.backend
  const candidates = [manual, preferred, routing.defaultBackend, ...routing.fallback, ...enabled].filter(Boolean)
  // A manual backend is never silently swapped: it runs (and is reported) as chosen, and the capability gap travels
  // with it so the preview shows the problem and the executor rejects the run instead of using another backend.
  const manualGaps = manual ? capabilityGaps(manual, effectiveIntent) : []
  const chosen = manual ?? candidates.find(backend => capabilityGaps(backend, effectiveIntent).length === 0)
    ?? routing.defaultBackend
  const applied = Boolean(manual) || Boolean(manualDeliverable) || routing.mode === 'auto'
  const reason = manual || manualDeliverable
    ? { code: 'manual', ...(manualDeliverable ? { deliverable: manualDeliverable } : {}) }
    : preferred && chosen === preferred ? { code: 'preference', workType }
      : chosen === routing.defaultBackend ? { code: 'default' }
        : { code: 'fallback' }
  const gaps = manual ? manualGaps : capabilityGaps(chosen, effectiveIntent)
  return {
    workType,
    profile,
    deliverable,
    capabilities: required,
    backend: chosen,
    reason,
    mode: manual || manualDeliverable ? 'manual' : routing.mode,
    applied,
    execBackend: applied ? chosen : routing.defaultBackend,
    // A mode that does not apply routing may keep the default backend, but it can never turn an explicit "只分析 /
    // 不要修改" request into a write run: the operator's read-only constraint is part of the request, not a suggestion.
    execProfile: applied ? profile : intent.explicitReadOnly ? 'read-only' : 'write',
    ...(gaps.length ? { unsupported: gaps.map(capability => capability === 'unknown-backend' ? capability : `missing-${capability}`).join(',') } : {}),
    enabled,
  }
}

/**
 * Preview one draft Ticket's route without creating anything. Shared by the Host preview endpoint and the creation
 * response so the panel's "what will run" and the run itself are produced by one resolver.
 */
export function routePreview({ title = '', body = '', config, selection } = {}) {
  const chosen = selection && typeof selection === 'object' ? selection : {}
  const preview = resolveRoute({
    ticket: { title: String(title ?? ''), body: String(body ?? '') },
    config,
    override: chosen.backend,
    deliverableOverride: chosen.deliverable,
  })
  return {
    route: { workType: preview.workType, profile: preview.profile, deliverable: preview.deliverable,
      capabilities: preview.capabilities, backend: preview.backend, reason: preview.reason, mode: preview.mode,
      applied: preview.applied, execBackend: preview.execBackend, execProfile: preview.execProfile,
      ...(preview.unsupported ? { unsupported: preview.unsupported } : {}) },
    selection: Object.keys(chosen).length ? chosen : null,
    options: { backends: preview.enabled, deliverables: DELIVERABLES },
    enabled: preview.enabled,
  }
}

/** Short English log line for one route; the panel renders its own localized labels from `reason.code`. */
export function routeSummary(route) {
  const applied = route.applied ? '' : ' (suggested, not applied)'
  const capabilities = Array.isArray(route.capabilities) && route.capabilities.length
    ? ` [${route.capabilities.join('+')}]` : ''
  return `${route.workType}/${route.deliverable}/${route.profile}${capabilities} -> ${route.backend}${applied}`
}
