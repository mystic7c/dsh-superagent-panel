/**
 * The actionable-inbox document (`inbox.json`), separate from `live-state.json`: a durable list of "needs you"
 * items derived from the live engine (failed gates, pending acceptances, finished dry runs waiting for publish, failures, broken sources, engine errors).
 *
 * Storage rules (P0 contract §1.3):
 * - one JSON file per state directory, atomic temp+rename replace, serialized read-modify-write (like `LiveState`);
 * - an item is identified by its `dedupeKey`: the same key updates the existing row instead of duplicating it, and
 *   `readAt`/`resolvedAt` survive an update;
 * - a key that is no longer derived is resolved (`resolvedAt`, `resolvedAction='auto'`) instead of being deleted;
 * - retention is bounded on save (90 days for resolved rows, 500 rows total) so the file cannot grow forever.
 */
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { renameDurable, writeFileDurable } from './durable.js'
import { join } from 'node:path'
import { serial } from '../util.js'
import { recordId } from './state.js'

const SCHEMA_VERSION = 1
const MAX_ITEMS = 500
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_RESOLVED_AGE_MS = 90 * DAY_MS

/** Fresh inbox document: only the schema marker and the id-keyed item map. */
export function emptyInboxState() {
  return { schemaVersion: SCHEMA_VERSION, items: {} }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Did the complaint change since the operator resolved it? A different failure text or a new Ticket is a new event. */
function changedSinceResolve(existing, fields) {
  const resolvedAt = Date.parse(existing.resolvedAt ?? '')
  if (!Number.isFinite(resolvedAt)) return false
  const headline = ['kind', 'title', 'summary']
  if (headline.some(field => String(existing[field] ?? '') !== String(fields[field] ?? ''))) return true
  // `refs.at` (or any timestamp inside refs) newer than the resolve is the derived record's own "this happened again".
  const refs = isObject(fields.refs) ? fields.refs : {}
  const at = Date.parse(String(refs.at ?? refs.updatedAt ?? refs.lastAt ?? ''))
  return Number.isFinite(at) && at > resolvedAt
}

/** Sort key for eviction: resolved rows go first, then the oldest rows. */
const staleFirst = (left, right) => (left.resolvedAt ? 0 : 1) - (right.resolvedAt ? 0 : 1)
  || Date.parse(left.updatedAt ?? left.createdAt ?? '') - Date.parse(right.updatedAt ?? right.createdAt ?? '')

/**
 * Merge one derived desired list into the document. Pure apart from the mutation of `doc.items`; returns whether
 * anything changed so the caller can skip the disk write on an unchanged refresh.
 */
export function applyDesiredInbox(doc, desired, now = new Date().toISOString()) {
  const items = doc.items ?? (doc.items = {})
  const byKey = new Map()
  for (const item of Object.values(items)) {
    if (item?.dedupeKey && !byKey.has(item.dedupeKey)) byKey.set(item.dedupeKey, item)
  }
  const wanted = new Map()
  for (const entry of Array.isArray(desired) ? desired : []) {
    if (entry?.dedupeKey) wanted.set(entry.dedupeKey, entry)
  }
  const result = { changed: false, created: 0, updated: 0, resolved: 0, reopened: 0 }
  for (const [key, want] of wanted) {
    const fields = {
      kind: want.kind,
      blocking: want.blocking === true,
      priority: want.priority ?? 'normal',
      title: String(want.title ?? ''),
      summary: String(want.summary ?? ''),
      refs: isObject(want.refs) ? want.refs : {},
    }
    const existing = byKey.get(key)
    if (!existing) {
      const item = { id: recordId('ibx'), ...fields, dedupeKey: key, createdAt: now }
      items[item.id] = item
      // The resolve loop below compares against `byKey`: a fresh row must be the canonical one, not a stale copy.
      byKey.set(key, item)
      result.changed = true
      result.created += 1
      continue
    }
    // The loop below overwrites the item, so what the operator resolved is captured first: a resolved row has to be
    // compared against its resolved state, not against the write that is happening now.
    const resolvedBefore = existing.resolvedAt ? { ...existing } : undefined
    let touched = false
    for (const [field, value] of Object.entries(fields)) {
      if (JSON.stringify(existing[field]) === JSON.stringify(value)) continue
      existing[field] = value
      touched = true
    }
    // An upsert still never resurrects a *read* item, but a resolved one comes back when the condition is new:
    // `resolvedAction === 'auto'` means it disappeared and this is a fresh occurrence of it (even with identical
    // text), and a manual resolve only covers the complaint the operator actually saw, so a changed headline or a
    // newer refs timestamp is a new event. Without this a once-resolved failure stayed hidden for the whole 90-day
    // retention — its dedupeKey is stable — with no way to bring it back.
    const reopen = Boolean(resolvedBefore)
      && (resolvedBefore.resolvedAction === 'auto' || (touched && changedSinceResolve(resolvedBefore, fields)))
    if (reopen) {
      // A new occurrence is unread again: resolving it used to leave the whole row silent in the "needs you" count.
      delete existing.resolvedAt
      delete existing.resolvedAction
      delete existing.readAt
      result.reopened += 1
      result.changed = true
    }
    if (touched) {
      existing.updatedAt = now
      result.changed = true
      result.updated += 1
    } else if (reopen) existing.updatedAt = now
  }
  for (const item of Object.values(items)) {
    if (item.resolvedAt) continue
    // `byKey` keeps the first row per key, so a duplicate row can never be the one the wanted loop updates. Resolve
    // every row that is not the canonical row for its key; otherwise the duplicate stayed open forever.
    const canonical = item.dedupeKey ? byKey.get(item.dedupeKey) : undefined
    // The live row is the canonical one of a key that is still derived; every other row is stale.
    if (canonical === item && wanted.has(item.dedupeKey)) continue
    item.resolvedAt = now
    item.resolvedAction = 'auto'
    result.changed = true
    result.resolved += 1
  }
  return result
}

export class InboxStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'inbox.json')
    this.state = undefined
    this.queue = serial()
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION || !isObject(parsed.items)) {
        throw new Error('unexpected schema version')
      }
      this.state = parsed
      return { created: false }
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code !== 'ENOENT') throw error
      const corrupt = Boolean(error && error.code !== 'ENOENT')
      if (corrupt) await copyFile(this.file, join(this.dir, `inbox.corrupt-${Date.now()}.json`)).catch(() => {})
      this.state = emptyInboxState()
      await this.save()
      return { created: true, corrupt }
    }
  }

  get loaded() { return Boolean(this.state) }
  get items() { return this.state?.items ?? {} }

  /** One item by id, or undefined. */
  get(id) { return this.state?.items?.[id] }

  /** One item by its dedupeKey, or undefined. */
  byKey(dedupeKey) {
    return Object.values(this.items).find(item => item.dedupeKey === dedupeKey)
  }

  /**
   * Upsert the derived desired set and auto-resolve missing keys. Writes only when something changed, so the panel's
   * status poll (which calls it) does not touch the disk every second.
   */
  async refresh(desired, now = new Date().toISOString()) {
    if (!this.state) throw new Error('InboxStore is not loaded')
    return this.queue(async () => {
      const result = applyDesiredInbox(this.state, desired, now)
      if (result.changed) await this.save()
      return result
    })
  }

  /** Mark one item read. Idempotent: an already-read item is returned without writing, unknown ids yield undefined. */
  async read(id, now = new Date().toISOString()) {
    if (!this.state) throw new Error('InboxStore is not loaded')
    return this.queue(async () => {
      const item = this.state.items[id]
      if (!item) return undefined
      if (item.readAt) return { ...item }
      item.readAt = now
      await this.save()
      return { ...item }
    })
  }

  /** Manually resolve one item. Already-resolved rows are returned untouched; unknown ids yield undefined. */
  async resolve(id, { action = 'manual', now = new Date().toISOString() } = {}) {
    if (!this.state) throw new Error('InboxStore is not loaded')
    return this.queue(async () => {
      const item = this.state.items[id]
      if (!item) return undefined
      if (item.resolvedAt) return { ...item }
      item.resolvedAt = now
      item.resolvedAction = typeof action === 'string' && action ? action : 'manual'
      await this.save()
      return { ...item }
    })
  }

  /** Serialized arbitrary mutation (used by tests and future writers); saves only when `mutate` returns true. */
  async atomic(mutate) {
    if (!this.state) throw new Error('InboxStore is not loaded')
    return this.queue(async () => {
      const result = await mutate(this.state)
      if (result !== false) await this.save()
      return result
    })
  }

  /** Bound retention before writing: resolved rows older than 90 days, then the oldest rows beyond 500. */
  prune(now = Date.now()) {
    const items = this.state?.items ?? {}
    const cutoff = now - MAX_RESOLVED_AGE_MS
    for (const [id, item] of Object.entries(items)) {
      const resolved = Date.parse(item?.resolvedAt ?? '')
      if (Number.isFinite(resolved) && resolved < cutoff) delete items[id]
    }
    const ids = Object.keys(items)
    if (ids.length <= MAX_ITEMS) return
    const ordered = ids.map(id => items[id]).sort(staleFirst)
    for (const item of ordered.slice(0, ids.length - MAX_ITEMS)) delete items[item.id]
  }

  async save() {
    this.prune()
    const tmp = join(this.dir, `.inbox-${process.pid}-${Date.now()}.json`)
    await writeFileDurable(tmp, `${JSON.stringify(this.state, undefined, 2)}\n`, { mode: 0o600 })
    await renameDurable(tmp, this.file)
  }
}
