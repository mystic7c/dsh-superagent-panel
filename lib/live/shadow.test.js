import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectShadowSamples, summarizeShadowSamples, shadowReviewRows, saveShadowSamples, loadShadowSamples,
  shadowSampleKey, SHADOW_SAMPLES_NAME } from './shadow.js'

const config = {
  baseBranch: 'dev',
  gitlab: { targetBranch: 'dev' },
  octo: { watchChatIds: ['chat-1'], channelType: 2, allowSenderIds: [], allowAnyHuman: true, botUid: '',
    replyPrefix: 'Superagent:', chatTitles: { 'chat-1': 'SuperAgent' } },
  eval: { mode: 'shadow', decision: { endpoint: 'https://judge.example/v1/systemone', model: 'fake-model',
    timeoutMs: 1000, acceptAt: 0.8, rejectAt: 0.2 } },
}
const loaded = { exists: true, config, tokens: { octo: 'tok', decision: 'dtok' }, error: undefined }

const message = (seq, over = {}) => ({ messageSeq: seq, messageId: 9000 + seq, fromUid: 'user-1', channelId: 'chat-1',
  channelType: 2, contentType: 1, text: `修复：第 ${seq} 条请求`, at: '2026-11-08T03:00:00.000Z', ...over })

/** Fake judge keyed by text fragment; records every call so reuse can be asserted. */
function fakeJudge(rules = [['修复', { p: 0.95, riskP: 0.02, latencyMs: 11 }],
  ['生产', { p: 0.99, riskP: 0.9, latencyMs: 13 }], ['SELECT', { p: 0.05, riskP: 0.02, latencyMs: 7 }],
  ['收到', { p: 0.02, riskP: 0.01, latencyMs: 5 }]]) {
  const calls = []
  return {
    calls,
    model: 'fake-model',
    async judge({ text }) {
      calls.push(text)
      const hit = rules.find(([fragment]) => text.includes(fragment))
      if (!hit) throw new Error(`unexpected text: ${text}`)
      const [fragment, answer] = hit
      return { model: 'fake-model', answers: { category: answer.p >= 0.8 ? 'repo_task' : 'chat',
        repoTask: answer.p, risky: answer.riskP }, latencyMs: answer.latencyMs, usage: { input_tokens: fragment.length } }
    },
  }
}

const fakeClient = messages => ({ async syncMessages() { return { messages } } })

async function dir() { return mkdtemp(join(tmpdir(), 'superagent-shadow-')) }

test('collection filters exactly like intake and judges the rest into samples', async () => {
  const judge = fakeJudge()
  const messages = [
    message(1),                                                        // accept
    message(2, { fromUid: 'dsh_bot' }),                                // bot-sender → skipped
    message(3, { contentType: 2, text: '' }),                          // not-text → skipped
    message(4, { text: '执行生产 DDL 并合并到 dev' }),                  // highRisk → ignore
    message(5, { text: 'SELECT Gcc.Segment1 FROM GL_JE_HEADERS JOIN GL_JE_LINES' }), // contextOnly → ignore
  ]
  const document = await collectShadowSamples({ loaded, client: fakeClient(messages), judge, limitPerChat: 100 })
  assert.equal(document.model, 'fake-model')
  assert.equal(document.questions, 'ticket-v2')
  assert.equal(document.samples.length, 3)
  assert.deepEqual(document.skipped.map(item => item.reason).sort(), ['bot-sender', 'not-text'])
  const bySeq = new Map(document.samples.map(sample => [sample.seq, sample]))
  assert.deepEqual(bySeq.get(1).rule, { kind: 'accept', codes: ['explicitRequest'] })
  assert.equal(bySeq.get(1).model.status, 'ok')
  assert.equal(bySeq.get(1).model.p, 0.95)
  assert.equal(bySeq.get(1).model.verdict, 'accept')
  assert.equal(bySeq.get(1).model.latencyMs, 11)
  assert.deepEqual(bySeq.get(4).rule.codes, ['highRisk'])
  assert.equal(bySeq.get(4).model.riskP, 0.9)
  assert.deepEqual(bySeq.get(5).rule.codes, ['contextOnly'])
  assert.equal(bySeq.get(5).model.verdict, 'reject')
  assert.equal(judge.calls.length, 3)
  assert.deepEqual(document.stats, { messages: 5, samples: 3, skipped: 2, judged: 3, reused: 0, errors: 0, ok: 3 })
  // A later run reuses cached answers for the same message and question set (zero API calls).
  const second = await collectShadowSamples({ loaded, client: fakeClient(messages), judge, previous: document })
  assert.equal(second.stats.reused, 3)
  assert.equal(second.stats.judged, 0)
  assert.equal(judge.calls.length, 3)
  // --refresh asks again.
  const refreshed = await collectShadowSamples({ loaded, client: fakeClient(messages), judge, previous: second, refresh: true })
  assert.equal(refreshed.stats.judged, 3)
  assert.equal(judge.calls.length, 6)
})

test('a failing judge call becomes an error sample and never aborts the collection', async () => {
  const judge = { model: 'fake-model', async judge({ text }) {
    if (text.includes('生产')) throw new Error('provider exploded')
    return { model: 'fake-model', answers: { category: 'repo_task', repoTask: 0.9, risky: 0.1 }, latencyMs: 3 }
  } }
  const document = await collectShadowSamples({ loaded, client: fakeClient([message(1), message(2, { text: '生产 DDL' })]), judge })
  assert.equal(document.samples.length, 2)
  const failed = document.samples.find(sample => sample.model.status === 'error')
  assert.match(failed.model.error, /provider exploded/)
  assert.equal(document.stats.errors, 1)
  assert.equal(document.stats.ok, 1)
})

test('an unreadable group is recorded as a skipped row instead of failing the run', async () => {
  const client = { async syncMessages({ channelId }) {
    if (channelId === 'chat-1') throw new Error('octo cli timeout')
    return { messages: [message(1, { channelId: 'chat-2' })], identity: {} }
  } }
  const failingLoaded = { ...loaded, config: { ...config, octo: { ...config.octo, watchChatIds: ['chat-1', 'chat-2'],
    chatTitles: { 'chat-2': 'EBS' } } } }
  const document = await collectShadowSamples({ loaded: failingLoaded, client, judge: fakeJudge() })
  assert.equal(document.samples.length, 1)
  assert.equal(document.samples[0].chatId, 'chat-2')
  const failure = document.skipped.find(item => item.reason === 'octo-error')
  assert.match(failure.error, /octo cli timeout/)
})

test('an empty watch list is an actionable error', async () => {
  await assert.rejects(() => collectShadowSamples({ loaded: { config: { ...config, octo: { ...config.octo, watchChatIds: [] } } },
    client: fakeClient([]), judge: fakeJudge() }), /监听群/)
})

const sample = (over = {}) => ({
  key: over.key ?? 'chat-1:1', chatId: 'chat-1', chatTitle: 'SuperAgent', at: '2026-11-08T03:00:00.000Z',
  seq: 1, text: '修复：银行账户必填',
  rule: { kind: 'accept', codes: ['explicitRequest'] },
  model: { status: 'ok', model: 'fake-model', questions: 'ticket-v2', p: 0.95, riskP: 0.02, verdict: 'accept', latencyMs: 10 },
  ...over,
})

test('summarizeShadowSamples cross-tabs the rules against the model and shapes the numbers', () => {
  const samples = [
    sample(),
    sample({ key: 'chat-1:2', seq: 2, text: '收到，谢谢', rule: { kind: 'accept', codes: ['explicitRequest'] },
      model: { ...sample().model, p: 0.02, verdict: 'reject', latencyMs: 20 } }),
    sample({ key: 'chat-1:3', seq: 3, text: '执行生产 DDL', rule: { kind: 'ignore', codes: ['highRisk'] },
      model: { ...sample().model, p: 0.99, riskP: 0.9, verdict: 'accept', latencyMs: 30 } }),
    sample({ key: 'chat-1:4', seq: 4, text: 'SELECT 1', rule: { kind: 'ignore', codes: ['contextOnly'] },
      model: { ...sample().model, p: 0.1, verdict: 'reject', latencyMs: 40 } }),
    sample({ key: 'chat-1:5', seq: 5, model: { status: 'error', model: 'fake-model', questions: 'ticket-v2', error: 'boom' } }),
  ]
  const summary = summarizeShadowSamples(samples)
  assert.equal(summary.total, 5)
  assert.equal(summary.ok, 4)
  assert.equal(summary.errors, 1)
  assert.deepEqual(summary.rule, { accept: 3, ignore: 2 })
  assert.deepEqual(summary.matrix.accept, { accept: 1, reject: 1, uncertain: 0, error: 1 })
  assert.deepEqual(summary.matrix.ignore, { accept: 1, reject: 1, uncertain: 0, error: 0 })
  assert.equal(summary.evaluated.acceptAgreementPct, 33.3)
  assert.equal(summary.byRuleCode.highRisk.accept, 1)
  assert.equal(summary.risk.samples, 4)
  assert.equal(summary.risk.high, 1)
  assert.equal(summary.latency.p50, 20)
  assert.equal(summary.latency.max, 40)
  assert.equal(summary.pBins.find(bin => bin.label === '90–100%').count, 2)
})

test('shadowReviewRows surfaces the disagreements a human should label', () => {
  const rows = shadowReviewRows([
    sample(),                                                                                        // agreement
    sample({ key: 'chat-1:2', seq: 2, rule: { kind: 'accept', codes: ['explicitRequest'] },
      model: { ...sample().model, p: 0.02, verdict: 'reject' } }),                                   // false wake
    sample({ key: 'chat-1:3', seq: 3, rule: { kind: 'ignore', codes: ['highRisk'] },
      model: { ...sample().model, p: 0.99, riskP: 0.2, verdict: 'accept' } }),                       // risk disagreement
    sample({ key: 'chat-1:4', seq: 4, rule: { kind: 'ignore', codes: ['contextOnly'] },
      model: { ...sample().model, p: 0.9, verdict: 'accept' } }),                                    // context disagreement
  ])
  assert.equal(rows.length, 3)
  assert.ok(rows.every(row => row.why.length > 0))
  assert.equal(rows[0].key, 'chat-1:3') // rule-high-risk vs model-low-risk scores highest
  assert.ok(rows.map(row => row.key).includes('chat-1:2'))
})

test('saveShadowSamples writes atomically at 600 and loadShadowSamples tolerates damage', async () => {
  const stateDir = await dir()
  try {
    const file = await saveShadowSamples(stateDir, { schemaVersion: 1, samples: [sample()], skipped: [] })
    assert.equal(file, join(stateDir, SHADOW_SAMPLES_NAME))
    const raw = await readFile(file, 'utf8')
    assert.match(raw, /"samples"/)
    const loadedBack = await loadShadowSamples(stateDir)
    assert.equal(loadedBack.samples.length, 1)
    assert.equal(loadedBack.samples[0].key, 'chat-1:1')
    await writeFile(file, '{broken')
    assert.deepEqual(await loadShadowSamples(stateDir), { samples: [], skipped: [] })
    assert.deepEqual(await loadShadowSamples(join(stateDir, 'nope')), { samples: [], skipped: [] })
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('shadowSampleKey prefers the message id and falls back to the sequence', () => {
  assert.equal(shadowSampleKey('chat-1', { messageId: 'm-1', messageSeq: 3 }), 'chat-1:m-1')
  assert.equal(shadowSampleKey('chat-1', { messageSeq: 3 }), 'chat-1:3')
})
