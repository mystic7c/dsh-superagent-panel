/** Store-level tests for the P1 data files: signal log, operation ledger and acceptance rounds. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SignalStore, emptySignalState, sweepSignals, signalKey } from './signals.js'
import { OperationStore, summarizeRun } from './operations.js'
import { AcceptanceStore, emptyAcceptanceRecord, checkFromGate } from './acceptance.js'

const tempDir = async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

const signal = (id, overrides = {}) => ({
  id, source: 'octo', type: 'message.received', externalId: `chat:${id}`, scopeKey: 'octo:chat',
  entryPoint: 'sync', receivedAt: new Date().toISOString(), candidate: { channelId: 'chat', text: 'hi' },
  payload: { text: 'hi' }, status: 'processed', attempts: 1, createdAt: new Date().toISOString(), ...overrides,
})

test('SignalStore round-trips, dedupes by external id and keeps read evidence', async (t) => {
  const dir = await tempDir(t)
  const store = new SignalStore(dir)
  assert.equal((await store.load()).created, true)
  await store.commit(doc => {
    const item = signal('sig_a')
    doc.items[item.id] = item
    doc.byKey[signalKey(item.source, item.externalId)] = item.id
  })
  const reloaded = new SignalStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get('sig_a').payload.text, 'hi')
  assert.equal(reloaded.byExternalId('octo', 'chat:sig_a').id, 'sig_a')
})

test('signal retention purges expired payloads but keeps evidence rows', () => {
  const doc = emptySignalState()
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
  doc.items.evidence = signal('evidence', { receivedAt: old, decisionId: 'dec_1' })
  doc.items.plain = signal('plain', { receivedAt: old })
  assert.equal(sweepSignals(doc), true)
  assert.equal(doc.items.plain.payload.text, undefined)
  assert.ok(doc.items.plain.payloadPurgedAt)
  assert.equal(doc.items.evidence.payload.text, 'hi')
})

test('signal retention caps one scope but exempts decision/trigger evidence', () => {
  const doc = emptySignalState()
  const now = Date.now()
  for (let index = 0; index < 2002; index += 1) {
    const item = signal(`sig_${index}`, { receivedAt: new Date(now - index * 1000).toISOString(),
      ...(index % 500 === 0 ? { decisionId: `dec_${index}` } : {}) })
    doc.items[item.id] = item
    doc.byKey[signalKey(item.source, item.externalId)] = item.id
  }
  sweepSignals(doc, now)
  const rows = Object.values(doc.items).filter(item => item.scopeKey === 'octo:chat')
  assert.ok(rows.length <= 2000, `rows=${rows.length}`)
  assert.ok(rows.some(item => item.id === 'sig_0' && item.decisionId), 'evidence row survived')
})

test('OperationStore saves full runs and lists by ticket; summaries keep the index small', async (t) => {
  const dir = await tempDir(t)
  const store = new OperationStore(dir)
  await store.load()
  await store.save({ id: 'op_1', ticketId: 'tkt_1', status: 'done', startedAt: new Date(Date.now() - 1000).toISOString(),
    trigger: 'manual', steps: [{ name: 'worker' }], trace: [{ type: 'tool_call' }], checkpoint: { step: 'finish', phase: 'done' } })
  await store.save({ id: 'op_2', ticketId: 'tkt_2', status: 'failed', startedAt: new Date().toISOString(), error: 'boom' })
  const reloaded = new OperationStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get('op_1').trace.length, 1)
  assert.deepEqual(reloaded.list({ ticketId: 'tkt_1' }).map(run => run.id), ['op_1'])
  assert.deepEqual(reloaded.list().map(run => run.id), ['op_2', 'op_1'])
  const summary = summarizeRun(reloaded.get('op_1'))
  assert.deepEqual(Object.keys(summary).sort(), ['id', 'startedAt', 'status', 'ticketId', 'trigger'])
})

test('AcceptanceStore creates/updates one record per ticket and gate checks map status', async (t) => {
  const dir = await tempDir(t)
  const store = new AcceptanceStore(dir)
  await store.load()
  const record = await store.update('tkt_1', current => {
    current.status = 'verifying'
    current.rounds.push({ id: 'rnd_1', roundIndex: 1, trigger: 'manual', status: 'verifying', startedAt: new Date().toISOString(),
      plan: [{ id: 'chk_1', name: 'backend', required: true, verifierType: 'program', command: 'mvn test' }],
      checks: [checkFromGate({ name: 'backend', required: true }, { exitCode: 0, durationMs: 12, output: 'ok' })] })
    return current
  }, { requirement: '什么算完成' })
  assert.equal(record.rounds[0].checks[0].status, 'passed')
  assert.equal(record.requirement, '什么算完成')
  const reloaded = new AcceptanceStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get('tkt_1').rounds[0].plan[0].name, 'backend')
  assert.equal(checkFromGate({ name: 'x' }, { timedOut: true }).status, 'errored')
  assert.deepEqual(emptyAcceptanceRecord('t').rounds, [])
})

test('a store load never resets state on a permission error', async (t) => {
  const dir = await tempDir(t)
  const store = new SignalStore(dir)
  await store.load()
  await store.commit(doc => {
    const item = signal('sig_perm')
    doc.items[item.id] = item
    doc.byKey[signalKey(item.source, item.externalId)] = item.id
  })
  const file = join(dir, 'signal-log.json')
  await chmod(file, 0o000)
  await assert.rejects(() => new SignalStore(dir).load(), error => error.code === 'EACCES')
  await chmod(file, 0o600)
  const reloaded = new SignalStore(dir)
  await reloaded.load()
  assert.equal(reloaded.get('sig_perm').payload.text, 'hi')
})
