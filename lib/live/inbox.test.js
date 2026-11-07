import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InboxStore, emptyInboxState, applyDesiredInbox } from './inbox.js'

async function dir() { return mkdtemp(join(tmpdir(), 'superagent-inbox-')) }

const desired = (key, over = {}) => ({ kind: 'failure', blocking: false, priority: 'normal',
  title: `标题 ${key}`, summary: `摘要 ${key}`, refs: {}, dedupeKey: key, ...over })

test('a fresh store writes schemaVersion 1 and an empty item map', async () => {
  const stateDir = await dir()
  try {
    const store = new InboxStore(stateDir)
    const result = await store.load()
    assert.equal(result.created, true)
    assert.equal(result.corrupt, false)
    assert.deepEqual(emptyInboxState(), { schemaVersion: 1, items: {} })
    const parsed = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(parsed.schemaVersion, 1)
    assert.deepEqual(parsed.items, {})
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('refresh upserts by dedupeKey, keeps readAt/resolvedAt, and auto-resolves missing keys', async () => {
  const stateDir = await dir()
  try {
    const store = new InboxStore(stateDir)
    await store.load()
    const first = await store.refresh([desired('failure:t1:r1'), desired('source:gitlab:p', { kind: 'source', priority: 'high' })])
    assert.equal(first.created, 2)
    assert.equal(Object.keys(store.items).length, 2)
    const item = store.byKey('failure:t1:r1')
    assert.match(item.id, /^ibx_[0-9a-f]{16}$/)
    assert.ok(item.createdAt)
    assert.equal(item.updatedAt, undefined)

    // Mark read + manually resolve, then re-derive the same key: status must survive the upsert.
    await store.read(item.id, '2026-11-07T00:00:00.000Z')
    const readBack = await store.read(item.id)
    assert.equal(readBack.readAt, '2026-11-07T00:00:00.000Z')

    // Content change keeps the row id/createdAt and stamps updatedAt.
    const second = await store.refresh([desired('failure:t1:r1', { summary: '新的摘要' })])
    assert.equal(second.updated, 1)
    assert.equal(second.resolved, 1) // source key vanished
    const updated = store.byKey('failure:t1:r1')
    assert.equal(updated.id, item.id)
    assert.equal(updated.createdAt, item.createdAt)
    assert.equal(updated.summary, '新的摘要')
    assert.equal(updated.readAt, '2026-11-07T00:00:00.000Z')
    const source = store.byKey('source:gitlab:p')
    assert.equal(source.resolvedAction, 'auto')
    assert.ok(source.resolvedAt)

    // A resolved row is not physically deleted and keeps its resolution on an identical refresh.
    const third = await store.refresh([desired('failure:t1:r1', { summary: '新的摘要' })])
    assert.equal(third.changed, false)
    assert.equal(store.byKey('source:gitlab:p').resolvedAt, source.resolvedAt)
    assert.equal(Object.keys(store.items).length, 2)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('refresh is a no-op (no write, no timestamp churn) when the derived set is unchanged', async () => {
  const stateDir = await dir()
  try {
    const store = new InboxStore(stateDir)
    await store.load()
    const saves = []
    const original = store.save.bind(store)
    store.save = async () => { saves.push(1); return original() }
    await store.refresh([desired('engine:last')])
    assert.equal(saves.length, 1)
    const before = await readFile(store.file, 'utf8')
    const result = await store.refresh([desired('engine:last')])
    assert.deepEqual(result, { changed: false, created: 0, updated: 0, resolved: 0 })
    assert.equal(saves.length, 1)
    assert.equal(await readFile(store.file, 'utf8'), before)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('read and resolve are idempotent and serialized; unknown ids return undefined', async () => {
  const stateDir = await dir()
  try {
    const store = new InboxStore(stateDir)
    await store.load()
    await store.refresh([desired('a'), desired('b')])
    const [a, b] = Object.values(store.items)
    assert.equal(await store.read('missing'), undefined)
    assert.equal(await store.resolve('missing'), undefined)

    const reads = await Promise.all([store.read(a.id), store.read(a.id)])
    assert.equal(reads[0].readAt, reads[1].readAt)
    const resolved = await Promise.all([store.resolve(b.id), store.resolve(b.id, { action: 'manual' })])
    assert.equal(resolved[0].resolvedAt, resolved[1].resolvedAt)
    assert.equal(resolved[0].resolvedAction, 'manual')
    const persisted = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(persisted.items[a.id].readAt, reads[0].readAt)
    assert.equal(persisted.items[b.id].resolvedAt, resolved[0].resolvedAt)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('save bounds retention: resolved rows older than 90 days and totals beyond 500', async () => {
  const stateDir = await dir()
  try {
    const store = new InboxStore(stateDir)
    await store.load()
    const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000).toISOString()
    const recent = new Date().toISOString()
    await store.atomic(doc => {
      doc.items.ibx_oldresolved = { id: 'ibx_oldresolved', dedupeKey: 'old:resolved', kind: 'engine', blocking: false,
        priority: 'info', title: 'old', summary: '', refs: {}, createdAt: old, resolvedAt: old, resolvedAction: 'auto' }
      doc.items.ibx_oldopen = { id: 'ibx_oldopen', dedupeKey: 'old:open', kind: 'engine', blocking: false,
        priority: 'info', title: 'open', summary: '', refs: {}, createdAt: old }
      doc.items.ibx_recent = { id: 'ibx_recent', dedupeKey: 'recent', kind: 'engine', blocking: false,
        priority: 'info', title: 'recent', summary: '', refs: {}, createdAt: recent }
      return true
    })
    assert.equal(store.items.ibx_oldresolved, undefined) // resolved and older than 90 days
    assert.ok(store.items.ibx_oldopen) // unresolved rows are not dropped for age alone
    assert.ok(store.items.ibx_recent)

    // The hard cap keeps the 500 newest rows (resolved rows are evicted before open ones).
    await store.atomic(doc => {
      for (let index = 0; index < 505; index += 1) {
        doc.items[`ibx_${String(index).padStart(16, '0')}`] = { id: `ibx_${String(index).padStart(16, '0')}`,
          dedupeKey: `bulk:${index}`, kind: 'engine', blocking: false, priority: 'info', title: `bulk ${index}`,
          summary: '', refs: {}, createdAt: recent }
      }
      return true
    })
    assert.equal(Object.keys(store.items).length, 500)
    const parsed = JSON.parse(await readFile(store.file, 'utf8'))
    assert.equal(Object.keys(parsed.items).length, 500)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a corrupt inbox file is backed up and replaced by an empty document', async () => {
  const stateDir = await dir()
  try {
    const store = new InboxStore(stateDir)
    await writeFile(store.file, '{ not json', 'utf8')
    const result = await store.load()
    assert.equal(result.created, true)
    assert.equal(result.corrupt, true)
    const files = await readdir(stateDir)
    assert.equal(files.some(name => name.startsWith('inbox.corrupt-')), true)
    assert.deepEqual(store.items, {})
    assert.equal(await store.read('missing'), undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('applyDesiredInbox is pure enough to unit-test the merge rules', () => {
  const doc = emptyInboxState()
  const now = '2026-11-07T00:00:00.000Z'
  const first = applyDesiredInbox(doc, [desired('k1')], now)
  assert.equal(first.created, 1)
  const [item] = Object.values(doc.items)
  assert.equal(item.createdAt, now)
  item.readAt = '2026-11-07T01:00:00.000Z'
  const second = applyDesiredInbox(doc, [desired('k1', { blocking: true })], '2026-11-07T02:00:00.000Z')
  assert.equal(second.updated, 1)
  assert.equal(item.blocking, true)
  assert.equal(item.updatedAt, '2026-11-07T02:00:00.000Z')
  assert.equal(item.readAt, '2026-11-07T01:00:00.000Z')
  // Duplicated keys inside one derived list collapse to one item.
  applyDesiredInbox(doc, [desired('k2'), desired('k2', { title: 'later' })], now)
  assert.equal(Object.values(doc.items).filter(entry => entry.dedupeKey === 'k2').length, 1)
  assert.equal(doc.items[Object.values(doc.items).find(entry => entry.dedupeKey === 'k2').id].title, 'later')
})
