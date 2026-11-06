/** Small helpers shared by the Superagent host half: time, ids, text, paging, and safe JSON. */
import { randomUUID } from 'node:crypto'

export const now = () => new Date().toISOString()
export const ago = (ms) => new Date(Date.now() - ms).toISOString()
export const HOUR = 3_600_000
export const DAY = 86_400_000

/** Stable, readable id for stored records: `<prefix>_<16 hex>`. */
export const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`

export const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value))

/** Bilingual text for demo data; both languages are always present. */
export const text = (zh, en) => ({ zh, en })

export const reason = (code, values) => values ? { code, values } : { code }

/** First non-empty line, clipped for list previews. */
export function preview(value, max = 160) {
  const line = String(value ?? '').replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Compare ISO timestamps lexicographically (they are normalized). */
export const newestFirst = (a, b) => (b.at ?? b.updatedAt ?? b.lastAt ?? '').localeCompare(a.at ?? a.updatedAt ?? a.lastAt ?? '')
export const oldestFirst = (a, b) => (a.at ?? '').localeCompare(b.at ?? '')

/** Slice one page and report whether more remains. */
export function page(items, offset = 0, limit = 20) {
  const start = Number.isFinite(offset) && offset > 0 ? offset : 0
  const size = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20
  return { items: items.slice(start, start + size), total: items.length, next_offset: start + size < items.length ? start + size : null }
}

/** Serialize writes so concurrent route handlers cannot interleave a read-modify-write. */
export function serial() {
  let tail = Promise.resolve()
  return (task) => {
    const run = tail.then(task, task)
    tail = run.catch(() => {})
    return run
  }
}
