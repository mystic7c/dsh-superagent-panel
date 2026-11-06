import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from './store.js'

test('a fresh store is empty and is not demo-seeded', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-store-'))
  try {
    const store = new Store(dir)
    const result = await store.load()
    assert.equal(store.demo, false)
    assert.equal(result.seeded, false)
    assert.equal(result.empty, true)
    assert.deepEqual(store.tickets, {})
    assert.deepEqual(store.threads, {})
    assert.deepEqual(store.triggers, {})
    assert.deepEqual(store.sources, {})
    assert.equal(store.ticketOrder.length, 0)
    assert.ok(store.settings)
    assert.ok(store.prompts)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('reset clears everything instead of restoring demo content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-store-'))
  try {
    const store = new Store(dir)
    await store.load()
    await store.atomic((doc) => { doc.tickets.tkt_demo = { id: 'tkt_demo', title: 'demo' }; doc.ticketOrder.push('tkt_demo') })
    await store.reset()
    assert.equal(store.demo, false)
    assert.deepEqual(store.tickets, {})
    assert.equal(store.ticketOrder.length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
