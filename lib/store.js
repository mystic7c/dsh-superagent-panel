/**
 * Durable state for the Superagent management panel: one JSON document under the configured state directory,
 * written atomically (temp file + rename) and serialized so two panel actions cannot interleave a
 * read-modify-write. A missing or unreadable document starts as an **empty** document (this panel only shows the
 * real live engine; demo data is no longer seeded), and a corrupt document is kept beside the new one as
 * `state.corrupt-<time>.json` rather than silently deleted.
 */
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { serial } from './util.js'
import { emptyState } from './seed.js'

export const SCHEMA_VERSION = 1

export class Store {
  /** @param {string} dir state directory; `state.json` is the document inside it. */
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'state.json')
    this.state = undefined
    this.queue = serial()
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    let raw
    try {
      raw = await readFile(this.file, 'utf8')
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code !== 'ENOENT') throw error
      this.state = emptyState()
      await this.save()
      return { seeded: false, empty: true }
    }
    try {
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== SCHEMA_VERSION) throw new Error('unexpected schema version')
      this.state = parsed
      return { seeded: false }
    } catch (error) {
      const backup = join(this.dir, `state.corrupt-${Date.now()}.json`)
      await copyFile(this.file, backup).catch(() => {})
      this.state = emptyState()
      await this.save()
      return { seeded: false, empty: true, corrupt: true, backup, error: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Serialize a read-modify-write against the document and persist the result before resolving. */
  async atomic(mutate) {
    if (!this.state) throw new Error('Superagent state is not loaded')
    return this.queue(async () => {
      const result = await mutate(this.state)
      await this.save()
      return result
    })
  }

  async save() {
    const text = `${JSON.stringify(this.state, undefined, 2)}\n`
    const tmp = join(this.dir, `.state-${process.pid}-${Date.now()}.json`)
    await writeFile(tmp, text, { mode: 0o600 })
    await rename(tmp, this.file)
    // The enclosing directory's existence was ensured at load; fsync is left to the OS rename guarantees here.
    return { file: this.file, bytes: text.length, dir: dirname(this.file) }
  }

  /** Current settings value (never undefined after load). */
  get settings() { return this.state.settings }

  /** Monotonic revision of one settings block (`eval`, `executor`, `pause`, `policy`, `source:<id>`). */
  revision(block) { return this.state.revisions?.[block] ?? 0 }

  /** Bump a block revision and the document-wide revision; returns the new block revision. */
  bump(block) {
    const revisions = this.state.revisions ??= {}
    this.state.revisions = { ...revisions, [block]: (revisions[block] ?? 0) + 1, global: (revisions.global ?? 0) + 1 }
    return this.state.revisions[block]
  }

  /** Append one settings history entry, keeping the newest 30. */
  recordSettings(entry) {
    this.state.settingsHistory = [entry, ...(this.state.settingsHistory ?? [])].slice(0, 30)
  }

  /** Replace the document with an empty document (the legacy demo reset action keeps working as a clean reset). */
  async reset() {
    return this.atomic(state => {
      const empty = emptyState()
      for (const key of Object.keys(state)) delete state[key]
      Object.assign(state, empty)
    })
  }

  get sources() { return this.state.sources ?? {} }
  get prompts() { return this.state.prompts }
  get outgoing() { return this.state.outgoing ?? [] }
  get meta() { return this.state.meta ?? {} }
  get setupCache() { return this.state.setupCache ?? {} }
  get settingsHistory() { return this.state.settingsHistory ?? [] }
  get executor() { return this.state.executor ?? { running: 0 } }
  get demo() { return this.state.demo === true }
  get tickets() { return this.state.tickets ?? {} }
  get threads() { return this.state.threads ?? {} }
  get triggers() { return this.state.triggers ?? {} }
  get decisions() { return this.state.decisions ?? {} }
  get ticketOrder() { return this.state.ticketOrder ?? [] }
}
