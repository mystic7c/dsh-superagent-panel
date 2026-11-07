/**
 * Raw-signal log (`signal-log.json`, P1 contract §2.1): facts the outside world produced, one row per event, stored
 * before any interpretation. The engine records every candidate here — including the ones it filters out — so
 * "why was this message not accepted" is answerable from data, and a skipped/ignored event can be replayed later.
 *
 * Storage follows `LiveState`/`InboxStore`: one JSON file, atomic temp+rename replace, serialized read-modify-write,
 * a corrupt file backed up instead of crashing the plugin. Retention is applied on save: payload text expires (7 days),
 * rows are capped per source scope (2000), and rows referenced by a decision/trigger (evidence) are exempt.
 */
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serial } from '../util.js'

const SCHEMA_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
const PAYLOAD_TTL_MS = 7 * DAY_MS
const MAX_PER_SCOPE = 2000

/** Fresh signal document. */
export function emptySignalState() {
  return { schemaVersion: SCHEMA_VERSION, items: {}, byKey: {} }
}

/** Stable dedupe key for one source event. */
export const signalKey = (source, externalId) => `${source}|${externalId}`

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const timeOf = value => {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** Keep payload text only while inside the TTL; the row's shape and evidence outlive the raw content. */
function sweepPayloads(items, nowMs) {
  let changed = false
  for (const item of Object.values(items)) {
    if (!item?.payload || item.payloadPurgedAt) continue
    // Evidence rows keep both the row and its raw payload: a decision/trigger points at them.
    if (item.decisionId || item.triggerId) continue
    if (nowMs - timeOf(item.receivedAt) < PAYLOAD_TTL_MS) continue
    item.payload = {}
    item.payloadPurgedAt = new Date(nowMs).toISOString()
    changed = true
  }
  return changed
}

/** Cap one scope, keeping evidence rows and the newest arrivals. */
function sweepScope(items, byKey, scopeKey, nowMs) {
  const rows = Object.values(items).filter(item => item.scopeKey === scopeKey)
  if (rows.length <= MAX_PER_SCOPE) return false
  const ordered = rows.sort((left, right) => timeOf(left.receivedAt) - timeOf(right.receivedAt))
  let changed = false
  let overflow = rows.length - MAX_PER_SCOPE
  for (const row of ordered) {
    if (overflow <= 0) break
    if (row.decisionId || row.triggerId) continue
    delete items[row.id]
    const key = signalKey(row.source, row.externalId)
    if (byKey[key] === row.id) delete byKey[key]
    overflow -= 1
    changed = true
  }
  return changed
}

/** Retention pass (payload TTL + per-scope cap). Returns whether the document changed. */
export function sweepSignals(doc, now = Date.now()) {
  const items = doc.items ?? (doc.items = {})
  const byKey = doc.byKey ?? (doc.byKey = {})
  let changed = sweepPayloads(items, now)
  const scopes = new Set(Object.values(items).map(item => item?.scopeKey).filter(Boolean))
  for (const scope of scopes) if (sweepScope(items, byKey, scope, now)) changed = true
  return changed
}

export class SignalStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'signal-log.json')
    this.state = undefined
    this.queue = serial()
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION
        || !isObject(parsed.items) || !isObject(parsed.byKey)) throw new Error('unexpected schema version')
      this.state = parsed
      return { created: false }
    } catch (error) {
      const corrupt = error && error.code !== 'ENOENT'
      if (corrupt) await copyFile(this.file, join(this.dir, `signal-log.corrupt-${Date.now()}.json`)).catch(() => {})
      this.state = emptySignalState()
      await this.save()
      return { created: true, corrupt }
    }
  }

  get loaded() { return Boolean(this.state) }
  get items() { return this.state?.items ?? {} }

  get(id) { return this.state?.items?.[id] }
  byExternalId(source, externalId) {
    const id = this.state?.byKey?.[signalKey(source, externalId)]
    return id ? this.state.items[id] : undefined
  }
  all() { return Object.values(this.items) }

  /** Serialized read-modify-write; retention runs before every persisted save. */
  async commit(mutate) {
    if (!this.state) throw new Error('SignalStore is not loaded')
    return this.queue(async () => {
      const result = await mutate(this.state)
      await this.save()
      return result
    })
  }

  async save() {
    sweepSignals(this.state, Date.now())
    const tmp = join(this.dir, `.signal-log-${process.pid}-${Date.now()}.json`)
    await writeFile(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
    await rename(tmp, this.file)
  }
}
