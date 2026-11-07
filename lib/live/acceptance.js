/**
 * Acceptance ledger (`acceptance.json`, P1 contract §4): the delivery-verification history of one Ticket, one record
 * per Ticket and one round per executor attempt. The executor appends a round from the gate results (program checks);
 * the human decision (accepted / rejected / overridden) is written onto that round, so "how many rounds did it take
 * and why was each rejected" survives retries. The Ticket's legacy `links.acceptance` stays for compatibility.
 */
import { mkdir, readFile, rename, writeFile, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
import { serial } from '../util.js'
import { recordId } from './state.js'

const SCHEMA_VERSION = 1

export function emptyAcceptanceState() {
  return { schemaVersion: SCHEMA_VERSION, items: {} }
}

/** A fresh record for one Ticket. */
export function emptyAcceptanceRecord(ticketId, { requirement } = {}) {
  return {
    ticketId,
    ...(typeof requirement === 'string' && requirement.trim() ? { requirement: requirement.trim().slice(0, 500) } : {}),
    status: 'unverified',
    rounds: [],
  }
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Build the plan/check shapes from a repository gate list and executor results (both stores stay dumb). */
export function checkFromGate(gate, result) {
  const name = String(gate?.name ?? result?.name ?? 'gate')
  return {
    id: recordId('chk'),
    name,
    required: gate?.required !== false,
    verifierType: 'program',
    status: result?.timedOut ? 'errored' : (result?.exitCode === 0 ? 'passed' : 'failed'),
    ...(result?.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
    ...(result?.timedOut ? { timedOut: true } : {}),
    ...(result?.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
    ...(typeof result?.output === 'string' && result.output ? { outputTail: result.output.slice(-4000) } : {}),
    at: new Date().toISOString(),
  }
}

export class AcceptanceStore {
  constructor(dir) {
    this.dir = dir
    this.file = join(dir, 'acceptance.json')
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
      const corrupt = error && error.code !== 'ENOENT'
      if (corrupt) await copyFile(this.file, join(this.dir, `acceptance.corrupt-${Date.now()}.json`)).catch(() => {})
      this.state = emptyAcceptanceState()
      await this.write()
      return { created: true, corrupt }
    }
  }

  get loaded() { return Boolean(this.state) }
  get(ticketId) { return this.state?.items?.[ticketId] }
  all() { return Object.values(this.state?.items ?? {}) }

  /** Upsert one record (serialized) and return it. */
  async save(record) {
    if (!this.state) throw new Error('AcceptanceStore is not loaded')
    if (!record || typeof record !== 'object' || !record.ticketId) return undefined
    return this.queue(async () => {
      this.state.items[record.ticketId] = record
      await this.write()
      return record
    })
  }

  /** Replace one record through a mutator; creates a fresh record when missing. */
  async update(ticketId, mutate, { requirement } = {}) {
    if (!this.state) throw new Error('AcceptanceStore is not loaded')
    return this.queue(async () => {
      const current = this.state.items[ticketId] ?? emptyAcceptanceRecord(ticketId, { requirement })
      const next = await mutate(current)
      this.state.items[ticketId] = next ?? current
      await this.write()
      return this.state.items[ticketId]
    })
  }

  async write() {
    const tmp = join(this.dir, `.acceptance-${process.pid}-${Date.now()}.json`)
    await writeFile(tmp, `${JSON.stringify(this.state)}\n`, { mode: 0o600 })
    await rename(tmp, this.file)
  }
}
