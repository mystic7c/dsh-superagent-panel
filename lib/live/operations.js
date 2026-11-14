/**
 * Operation ledger (`operations.json`, P1 contract §3): the full append-only record of every executor run, kept out of
 * `live-state.json` so a long trace cannot bloat the document the panel polls. `live-state.json` keeps a small index
 * row per run (`summarizeRun`), which is what the status payload and lists read; the full object (steps, trace, gates,
 * report, checkpoint) lives here and is read on demand for one Ticket.
 *
 * Same storage contract as the other stores: atomic temp+rename, serialized writes, corrupt-file backup, bounded size.
 */
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { writeFileDurable } from './durable.js'
import { join } from 'node:path'
import { serial } from '../util.js'

const SCHEMA_VERSION = 1
const MAX_OPERATIONS = 500

export function emptyOperationState() {
  return { schemaVersion: SCHEMA_VERSION, items: {}, order: [] }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const timeOf = value => {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/** The small index row written to `live-state.json` (`doc.runs`) instead of the full operation. */
export function summarizeRun(run) {
  if (!run || typeof run !== 'object') return undefined
  const summary = {
    id: run.id,
    ticketId: run.ticketId,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.trigger ? { trigger: run.trigger } : {}),
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(run.dryRun ? { dryRun: true } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt } : {}),
    ...(run.error ? { error: run.error } : {}),
  }
  return summary
}

export class OperationStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'operations.json')
    this.state = undefined
    this.queue = serial()
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION
        || !isObject(parsed.items) || !Array.isArray(parsed.order)) throw new Error('unexpected schema version')
      this.state = parsed
      return { created: false }
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code !== 'ENOENT') throw error
      const corrupt = Boolean(error && error.code !== 'ENOENT')
      if (corrupt) await copyFile(this.file, join(this.dir, `operations.corrupt-${Date.now()}.json`)).catch(() => {})
      this.state = emptyOperationState()
      await this.write()
      return { created: true, corrupt }
    }
  }

  get loaded() { return Boolean(this.state) }
  get(id) { return this.state?.items?.[id] }
  all() { return this.state?.order?.map(id => this.state.items[id]).filter(Boolean) ?? [] }

  /** Newest-first operations, optionally narrowed to one Ticket/status. */
  list({ ticketId, status, limit = 20 } = /** @type {Record<string, any>} */ ({})) {
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 20
    return this.all()
      .filter(run => (!ticketId || run.ticketId === ticketId) && (!status || run.status === status))
      .sort((left, right) => timeOf(right.startedAt) - timeOf(left.startedAt))
      .slice(0, size)
  }

  /** Upsert one operation; `order` is the retention order (oldest first). */
  async save(run) {
    if (!this.state) throw new Error('OperationStore is not loaded')
    return this.queue(async () => {
      if (!run || typeof run !== 'object' || !run.id) return undefined
      if (!this.state.items[run.id]) this.state.order.push(run.id)
      this.state.items[run.id] = run
      // Cap the ledger. Keep recent operations even if they are the only evidence of a Ticket's latest run.
      while (this.state.order.length > MAX_OPERATIONS) {
        const drop = this.state.order.shift()
        delete this.state.items[drop]
      }
      await this.write()
      return run
    })
  }

  async saveAll(runs) {
    if (!this.state) throw new Error('OperationStore is not loaded')
    return this.queue(async () => {
      for (const run of Array.isArray(runs) ? runs : []) {
        if (!run || typeof run !== 'object' || !run.id) continue
        if (!this.state.items[run.id]) this.state.order.push(run.id)
        this.state.items[run.id] = run
      }
      while (this.state.order.length > MAX_OPERATIONS) {
        const drop = this.state.order.shift()
        delete this.state.items[drop]
      }
      await this.write()
      return this.state
    })
  }

  async write() {
    const tmp = join(this.dir, `.operations-${process.pid}-${Date.now()}.json`)
    await writeFileDurable(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
    await rename(tmp, this.file)
  }
}
