/**
 * Append-only activity log for one Ticket (P1 contract §5). Stored on `ticket.activities` (bounded) so a single
 * `live-state.json` write carries the history with the entity; every writer (engine intake, executor, human actions)
 * uses `appendActivity` so the shape and the cap stay identical.
 *
 * The log answers "why is this Ticket like this": actor kind is recorded at write time (a deleted user/agent still
 * leaves "a person did it"), and `detail` is bounded so a run summary cannot bloat the state document.
 */
import { randomUUID } from 'node:crypto'

export const ACTIVITY_KINDS = ['created', 'status', 'trigger', 'run', 'gate', 'acceptance', 'reply', 'dismiss', 'comment', 'resume', 'answer']
const MAX_ACTIVITIES = 50
const MAX_DETAIL = 300

const clip = value => {
  if (value === undefined || value === null) return undefined
  const text = String(value).replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text
}

/**
 * Append one activity to a Ticket (mutates in place; callers persist the Ticket afterwards).
 * → the created activity, or undefined for a missing Ticket.
 * entry: { kind, actorKind:'agent'|'system'|'user', from?, to?, detail?, at?, refs? }
 */
export function appendActivity(ticket, entry = {}) {
  if (!ticket || typeof ticket !== 'object') return undefined
  const activity = {
    id: `act_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    kind: ACTIVITY_KINDS.includes(entry.kind) ? entry.kind : 'status',
    actorKind: ['agent', 'system', 'user'].includes(entry.actorKind) ? entry.actorKind : 'system',
    at: typeof entry.at === 'string' && entry.at ? entry.at : new Date().toISOString(),
  }
  if (entry.from !== undefined && entry.from !== null) activity.from = String(entry.from)
  if (entry.to !== undefined && entry.to !== null) activity.to = String(entry.to)
  const detail = clip(entry.detail)
  if (detail) activity.detail = detail
  if (entry.refs && typeof entry.refs === 'object') activity.refs = entry.refs
  const list = Array.isArray(ticket.activities) ? ticket.activities : []
  ticket.activities = [...list, activity].slice(-MAX_ACTIVITIES)
  return activity
}

/** Newest-first copy of a Ticket's activities (up to `limit`). */
export function activitiesOf(ticket, limit = MAX_ACTIVITIES) {
  const list = Array.isArray(ticket?.activities) ? ticket.activities : []
  const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), MAX_ACTIVITIES) : MAX_ACTIVITIES
  return [...list].slice(-size).reverse()
}
