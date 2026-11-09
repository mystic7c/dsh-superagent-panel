/**
 * Worker routing (P1): which backend runs one Ticket, with which profile.
 *
 * One Ticket used to read a single `executor.workerBackend`. With several backends enabled the executor now asks this
 * module instead: it classifies the Ticket's work type from the request text, applies the operator's preferences (or
 * the built-in capability-based defaults), and checks the backend actually has the capability that work type needs.
 *
 * The capability table is code, not configuration: it mirrors what each adapter can really do today. `read-only`
 * profiles are enforced by the adapter (Codex `-s read-only`, Claude `--permission-mode plan`, DSH tool guard);
 * network/report capabilities are the reasons only DSH can take research or interactive work.
 */

export const WORKER_BACKENDS = ['dsh', 'codex', 'claude']
export const ROUTING_MODES = ['single', 'suggest', 'auto']
export const WORK_TYPES = ['analysis', 'review', 'test', 'dev', 'docs', 'research', 'interactive']
export const ROUTE_PROFILES = ['read-only', 'write']

/** Work types that deliver a written report instead of a code change (no commit/push; Ticket ends `closed`). */
const REPORT_TYPES = new Set(['analysis', 'review', 'research', 'interactive'])

/** What each backend can do in this plugin today. Keep in sync with worker.js / worker-cli.js. */
export const BACKEND_CAPABILITIES = {
  dsh: { edit: true, exec: true, web: true, report: true },
  codex: { edit: true, exec: true, web: false, report: false },
  claude: { edit: true, exec: false, web: false, report: false },
}

/** Capability a work type requires. Everything else only needs file edit access. */
const REQUIRED_CAPABILITY = { research: 'web', interactive: 'report', test: 'exec' }

export const profileOf = workType => REPORT_TYPES.has(workType) ? 'read-only' : 'write'
export const deliverableOf = workType => REPORT_TYPES.has(workType) ? 'report' : 'change'

/** First matching rule wins; a Ticket that matches nothing is treated as development work (the common case). */
const WORK_TYPE_RULES = [
  ['research', /(调研|查资料|查一下资料|搜索|搜一下|联网|浏览器|网页|官网|最新版本|文档链接|look up|search|browse|web)/iu],
  ['interactive', /(需要确认|请确认|待确认|先讨论|讨论一下|给个建议|你来决定|需要你决定|confirm)/iu],
  ['review', /(review|审查|评审|代码质量|检查代码|过一遍代码|code review)/iu],
  ['test', /(测试|验证|回归|复现|单测|跑一遍|自测|test|verify|regression)/iu],
  ['docs', /(文档|readme|注释|说明文档|documentation)/iu],
  ['analysis', /(分析|梳理|评估|方案|影响面|排查|定位|梳理一下|analy[sz]e|analysis|assess)/iu],
]

/** Classify one Ticket from its title and body. Pure and cheap: no model call in P1. */
export function classifyWorkType(ticket) {
  const text = `${ticket?.title ?? ''}\n${ticket?.body ?? ''}`
  for (const [type, pattern] of WORK_TYPE_RULES) if (pattern.test(text)) return type
  return 'dev'
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

/** Why one backend cannot take one work type; undefined when it can. */
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
 * `applied` says whether the decision changes execution: `auto` and `manual` apply it; `suggest` only records it and
 * keeps running the default backend (so enabling routing never changes execution silently).
 *
 * @returns {object} route record: {workType, profile, deliverable, backend, reason, mode, applied, execBackend,
 *   execProfile, unsupported?, enabled}
 */
export function resolveRoute({ ticket, config, override } = {}) {
  const enabled = enabledBackends(config)
  const routing = effectiveRouting(config)
  const workType = classifyWorkType(ticket)
  const profile = profileOf(workType)
  const deliverable = deliverableOf(workType)
  const manual = WORKER_BACKENDS.includes(override) && enabled.includes(override) ? override : undefined
  const preferred = routing.preferences.find(rule =>
    Array.isArray(rule.workTypes) && rule.workTypes.includes(workType) && enabled.includes(rule.backend))?.backend
  const candidates = [manual, preferred, routing.defaultBackend, ...routing.fallback, ...enabled].filter(Boolean)
  const chosen = candidates.find(backend => !capabilityGap(backend, workType)) ?? routing.defaultBackend
  const applied = Boolean(manual) || routing.mode === 'auto'
  const reason = manual ? { code: 'manual' }
    : preferred && chosen === preferred ? { code: 'preference', workType }
      : chosen === routing.defaultBackend ? { code: 'default' }
        : { code: 'fallback' }
  return {
    workType,
    profile,
    deliverable,
    backend: chosen,
    reason,
    mode: manual ? 'manual' : routing.mode,
    applied,
    execBackend: applied ? chosen : routing.defaultBackend,
    execProfile: applied ? profile : 'write',
    ...(capabilityGap(chosen, workType) ? { unsupported: capabilityGap(chosen, workType) } : {}),
    enabled,
  }
}

/** Short English log line for one route; the panel renders its own localized labels from `reason.code`. */
export function routeSummary(route) {
  const applied = route.applied ? '' : ' (suggested, not applied)'
  return `${route.workType}/${route.profile} -> ${route.backend}${applied}`
}
