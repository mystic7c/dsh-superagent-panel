/**
 * The engine's own durable document (`live-state.json`), separate from the demo state that the panel ships with.
 * One JSON file, atomic replace, serialized read-modify-write; the Octo cursor lives here so a restart continues
 * where the previous poll stopped instead of replaying every queued event.
 */
import { mkdir, readFile, rm, copyFile } from 'node:fs/promises'
import { renameDurable, writeFileDurable } from './durable.js'
import { join } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { serial } from '../util.js'

const SCHEMA_VERSION = 1

/** Fresh engine document: empty domain collections plus engine bookkeeping. */
export function emptyLiveState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    cursor: 0,
    // Event ids consumed by the events intake. The cursor is a numeric high-water mark, so a UUID/opaque event id never
    // moves it; without this bounded memory a re-fetch after a failed ack judged the same events again and again.
    handledEvents: [],
    // Per-chat message_seq cursors used by the sync intake; first sight initializes a chat instead of replaying it.
    channelCursors: {},
    lastPollAt: undefined,
    lastError: undefined,
    events: { received: 0, accepted: 0, ignored: 0 },
    sources: {
      octo: { state: 'idle', detail: '未启动', at: undefined },
      gitlab: { state: 'idle', detail: '未配置 token', at: undefined },
    },
    threads: {},
    triggers: {},
    decisions: {},
    tickets: {},
    ticketOrder: [],
    runs: [],
  }
}

export class LiveState {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'live-state.json')
    this.state = undefined
    this.queue = serial()
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION) throw new Error('unexpected schema version')
      this.state = parsed
      return { created: false }
    } catch (error) {
      // Only a missing file is "no state yet". A permission/IO error must not be mistaken for corruption: resetting
      // here would overwrite a perfectly good live-state.json just because the read was temporarily denied.
      if (error && typeof error.code === 'string' && error.code !== 'ENOENT') throw error
      const corrupt = Boolean(error && error.code !== 'ENOENT')
      if (corrupt) await copyFile(this.file, join(this.dir, `live-state.corrupt-${Date.now()}.json`)).catch(() => {})
      this.state = emptyLiveState()
      await this.save()
      return { created: true, corrupt }
    }
  }

  async atomic(mutate) {
    if (!this.state) throw new Error('LiveState is not loaded')
    return this.queue(async () => {
      const result = await mutate(this.state)
      await this.save()
      return result
    })
  }

  /**
   * Mark this document dead: the engine that owned it was stopped, so a run finishing afterwards must not write its
   * stale copy of the whole document over what the next engine loaded (that is how an `interrupted` run flipped back
   * to `dry-run` after a plugin reload). Mutations still land in memory; only the disk write is dropped.
   */
  close() { this.closed = true }

  async save() {
    if (this.closed) return
    // N2-05: a pid+millisecond name collides for two writers in the same millisecond, and a failed write used to leave
    // a 0-byte `.live-state-*.json` behind that no reader ever cleaned up. Random suffix + best-effort removal on error.
    const tmp = join(this.dir, `.live-state-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}.json`)
    try {
      await writeFileDurable(tmp, `${JSON.stringify(this.state, undefined, 2)}\n`, { mode: 0o600 })
      await renameDurable(tmp, this.file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  }

  get cursor() { return this.state.cursor ?? 0 }
  get threads() { return this.state.threads }
  get triggers() { return this.state.triggers }
  get decisions() { return this.state.decisions }
  get tickets() { return this.state.tickets }
  get runs() { return this.state.runs }
  get sources() { return this.state.sources }
  get events() { return this.state.events }
}

/** Stable short id for engine records (triggers, tickets, decisions). */
export const recordId = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`
