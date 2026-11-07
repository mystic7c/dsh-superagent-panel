/**
 * Ticket-level automation (P2-1): a Ticket may run itself on a fixed interval (heartbeat) or once a day at a local
 * clock time (schedule). This module owns the pure config/next-run math so the engine, the HTTP endpoint and the
 * client agree on the same shape and on the same "when is the next run" answer. It never runs anything.
 */

export const AUTOMATION_MODES = ['off', 'heartbeat', 'schedule']
export const DEFAULT_HEARTBEAT_MINUTES = 60
export const MIN_HEARTBEAT_MINUTES = 10
export const MAX_HEARTBEAT_MINUTES = 24 * 60
export const MAX_EXECUTIONS_LIMIT = 10_000

const TIME_OF_DAY = /^([01]?\d|2[0-3]):([0-5]\d)$/

const intInRange = (value, min, max, fallback) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.floor(number)))
}

/** Next local occurrence of `HH:mm` strictly after `fromMs` (today if still ahead, otherwise tomorrow). */
export function nextDailyAt(at, fromMs = Date.now()) {
  const match = TIME_OF_DAY.exec(String(at ?? ''))
  if (!match) return undefined
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const from = new Date(fromMs)
  const next = new Date(fromMs)
  next.setHours(hours, minutes, 0, 0)
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1)
  return next.toISOString()
}

/** Next run after `fromMs` for a normalized automation config. `off`/disabled returns undefined. */
export function nextRunAt(automation, fromMs = Date.now()) {
  if (!automation || automation.enabled !== true || automation.mode === 'off') return undefined
  if (automation.mode === 'heartbeat') {
    const minutes = intInRange(automation.intervalMinutes, MIN_HEARTBEAT_MINUTES, MAX_HEARTBEAT_MINUTES, DEFAULT_HEARTBEAT_MINUTES)
    return new Date(fromMs + minutes * 60_000).toISOString()
  }
  if (automation.mode === 'schedule') return nextDailyAt(automation.at, fromMs)
  return undefined
}

/**
 * Merge an operator patch onto the stored automation and normalise every field.
 * Invalid values fall back to the current value (or a default), never throw, so a half-typed form cannot crash a save.
 * → { automation, error? } (error is a human message for the endpoint; the automation still reflects the merge)
 */
export function normalizeAutomation(patch = {}, current = {}, nowMs = Date.now()) {
  const mode = AUTOMATION_MODES.includes(patch.mode) ? patch.mode : (current.mode ?? 'off')
  const enabled = typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled === true
  const intervalMinutes = intInRange(patch.intervalMinutes ?? current.intervalMinutes,
    MIN_HEARTBEAT_MINUTES, MAX_HEARTBEAT_MINUTES, current.intervalMinutes ?? DEFAULT_HEARTBEAT_MINUTES)
  const at = TIME_OF_DAY.test(String(patch.at ?? current.at ?? '')) ? String(patch.at ?? current.at) : (current.at ?? '')
  // An explicit null/empty in the patch means "unlimited" and must clear a previously stored cap; only an absent
  // field inherits the current value.
  const hasMaxExecutions = Object.prototype.hasOwnProperty.call(patch, 'maxExecutions')
  const maxExecutionsRaw = hasMaxExecutions ? patch.maxExecutions : current.maxExecutions
  const maxExecutions = maxExecutionsRaw === null || maxExecutionsRaw === '' || maxExecutionsRaw === undefined
    ? null
    : intInRange(maxExecutionsRaw, 1, MAX_EXECUTIONS_LIMIT, current.maxExecutions ?? null)
  const executions = Math.max(0, Number(current.executions ?? 0) || 0)
  const automation = {
    mode,
    enabled: mode === 'off' ? false : enabled,
    ...(mode === 'heartbeat' ? { intervalMinutes } : {}),
    ...(mode === 'schedule' ? { at: at || '09:00' } : {}),
    ...(maxExecutions !== null ? { maxExecutions } : {}),
    executions,
    ...(current.nextAt && patch.resetNext !== true ? { nextAt: current.nextAt } : {}),
    ...(current.lastRunAt ? { lastRunAt: current.lastRunAt } : {}),
    ...(current.lastSkipReason ? { lastSkipReason: current.lastSkipReason } : {}),
    ...(current.lastTrigger ? { lastTrigger: current.lastTrigger } : {}),
  }
  // Recompute the next run whenever the schedule definition changed or the config was just enabled.
  const changed = patch.mode !== undefined || patch.enabled !== undefined || patch.intervalMinutes !== undefined
    || patch.at !== undefined || automation.nextAt === undefined
  if (automation.enabled && changed) {
    const next = nextRunAt(automation, nowMs)
    if (next) automation.nextAt = next
  }
  if (!automation.enabled) delete automation.nextAt
  const error = mode === 'schedule' && !at && patch.at !== undefined
    ? '每天执行的时间格式必须是 HH:mm（00:00–23:59）'
    : undefined
  return { automation, error }
}

/** Is this automation due at `nowMs`? (a Ticket still needs the engine's other skip checks). */
export function isDue(automation, nowMs = Date.now()) {
  if (!automation || automation.enabled !== true || automation.mode === 'off' || !automation.nextAt) return false
  const next = Date.parse(automation.nextAt)
  return Number.isFinite(next) && next <= nowMs
}

/** One-line description used by the panel/status views. */
export function describeAutomation(automation) {
  if (!automation || automation.enabled !== true || automation.mode === 'off') return ''
  if (automation.mode === 'heartbeat') {
    const minutes = automation.intervalMinutes ?? DEFAULT_HEARTBEAT_MINUTES
    return minutes % 60 === 0 ? `每 ${minutes / 60} 小时` : `每 ${minutes} 分钟`
  }
  return `每天 ${automation.at ?? '09:00'}`
}

/** Why a due automation did not start (P2-1 skip reasons, also shown in the panel). */
export const SKIP_REASONS = {
  paused: '处理已暂停',
  'executor-disabled': '执行器未启用',
  working: '工单正在执行',
  parked: '工单在等人/等回答',
  'max-executions': '已达到执行次数上限',
  due: '已到执行时间',
}
