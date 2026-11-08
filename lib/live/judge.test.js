import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSystemOneJudge, judgeQuestionPayload, verdictOf, shadowOf, shadowErrorOf,
  JUDGE_QUESTIONS, JUDGE_QUESTIONS_VERSION } from './judge.js'

const ENDPOINT = 'https://judge.example/compatible-mode/v1/systemone'
const BASE = { endpoint: ENDPOINT, model: 'decision-model-preview', token: 'sk-test' }

/** Fetch double that records the request and answers with one JSON body (or a custom response). */
function fakeFetch({ status = 200, body, respond } = {}) {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) })
    if (respond) return respond({ url, init })
    return { ok: status >= 200 && status < 300, status, async json() { return body } }
  }
  return { calls, fetchImpl }
}

const categoryAnswer = over => ({
  model: 'decision-model-preview',
  answers: { category: { type: 'choice', choice: 'repo_task', confidence: 0.9,
    probabilities: { repo_task: 0.93, octo_platform: 0.03, chat: 0.01, context: 0.01, risky: 0.08, ...over } } },
  usage: { input_tokens: 120 },
  request_id: 'req-1',
})

test('one request asks the five-way category question and parses repo_task / risky', async () => {
  const { calls, fetchImpl } = fakeFetch({ body: categoryAnswer() })
  const judge = createSystemOneJudge({ ...BASE, fetchImpl })
  const result = await judge.judge({ text: '修复：收款单保存时校验银行账户必填' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, ENDPOINT)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer sk-test')
  assert.equal(calls[0].body.model, 'decision-model-preview')
  assert.equal(calls[0].body.state, '修复：收款单保存时校验银行账户必填')
  const questions = calls[0].body.questions
  assert.deepEqual(Object.keys(questions), ['category'])
  assert.equal(questions.category.type, 'choice')
  assert.equal(questions.category.instructions.length > 0, true)
  assert.deepEqual(Object.keys(questions.category.criteria).sort(),
    ['chat', 'context', 'octo_platform', 'repo_task', 'risky'])
  // The parsed answer keeps the calibrated probabilities the decision needs.
  assert.equal(result.answers.repoTask, 0.93)
  assert.equal(result.answers.risky, 0.08)
  assert.equal(result.answers.category, 'repo_task')
  assert.equal(result.model, 'decision-model-preview')
  assert.equal(result.requestId, 'req-1')
  assert.equal(Number.isFinite(result.latencyMs), true)
  assert.deepEqual(result.usage, { input_tokens: 120 })
})

test('state stays a plain message string even when callers pass metadata', async () => {
  const { calls, fetchImpl } = fakeFetch({ body: categoryAnswer() })
  const judge = createSystemOneJudge({ ...BASE, fetchImpl })
  // Pilot finding: a metadata object in state collapsed a clear request from 0.97 to 0.09, so metadata is dropped.
  await judge.judge({ text: '修复银行账户必填', channel: 'chat-1', threadTitle: 'SuperAgent' })
  assert.equal(calls[0].body.state, '修复银行账户必填')
  // Prior messages are pasted in front as plain text, most recent three at most.
  await judge.judge({ text: '依据这个SQL，写一个视图', context: ['旧消息1', 'SELECT 1 FROM dual'] })
  assert.equal(calls[1].body.state, '旧消息1\n\nSELECT 1 FROM dual\n\n---\n\n依据这个SQL，写一个视图')
})

test('a choice without probabilities falls back to the selected option', async () => {
  const { fetchImpl } = fakeFetch({ body: { answers: { category: { type: 'choice', choice: 'repo_task' } } } })
  const judge = createSystemOneJudge({ ...BASE, fetchImpl })
  const result = await judge.judge({ text: '修复 bug' })
  assert.equal(result.answers.repoTask, 1)
  assert.equal(result.answers.risky, undefined)
})

test('a provider error is surfaced with its own message', async () => {
  const { fetchImpl } = fakeFetch({ status: 401, body: { error: { message: 'invalid api key' } } })
  const judge = createSystemOneJudge({ ...BASE, fetchImpl })
  await assert.rejects(() => judge.judge({ text: 'hello' }), /judge HTTP 401：invalid api key/)
})

test('a response without the category answer is an error, not a silent default', async () => {
  const { fetchImpl } = fakeFetch({ body: { answers: { category: { type: 'choice', choice: 'chat', probabilities: { chat: 0.9 } } } } })
  const judge = createSystemOneJudge({ ...BASE, fetchImpl })
  await assert.rejects(() => judge.judge({ text: 'hello' }), /repo_task/)
})

test('the request aborts at the configured timeout', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  const judge = createSystemOneJudge({ ...BASE, timeoutMs: 100, fetchImpl })
  await assert.rejects(() => judge.judge({ text: '慢慢回的消息' }), /judge 超时（100ms）/)
})

test('configuration mistakes fail fast and name the setting', () => {
  assert.throws(() => createSystemOneJudge({ ...BASE, endpoint: 'not-a-url' }), /endpoint/)
  assert.throws(() => createSystemOneJudge({ ...BASE, model: '' }), /model/)
  assert.throws(() => createSystemOneJudge({ ...BASE, token: '' }), /token/)
})

test('verdictOf maps calibrated probabilities to accept / reject / uncertain', () => {
  assert.equal(verdictOf(0.9), 'accept')
  assert.equal(verdictOf(0.8), 'accept')
  assert.equal(verdictOf(0.5), 'uncertain')
  assert.equal(verdictOf(0.2), 'reject')
  assert.equal(verdictOf(0.1), 'reject')
  assert.equal(verdictOf(undefined), 'unknown')
  assert.equal(verdictOf(0.6, { acceptAt: 0.9, rejectAt: 0.4 }), 'uncertain')
})

test('shadowOf stores the rules outcome next to the model category', () => {
  const result = { model: 'decision-model-preview', answers: { category: 'repo_task', repoTask: 0.93, risky: 0.41 },
    latencyMs: 42, usage: { input_tokens: 99 } }
  const shadow = shadowOf(result, { ruleKind: 'accept', acceptAt: 0.8, rejectAt: 0.2, at: '2026-11-08T00:00:00.000Z' })
  assert.equal(shadow.status, 'ok')
  assert.equal(shadow.at, '2026-11-08T00:00:00.000Z')
  assert.equal(shadow.questions, JUDGE_QUESTIONS_VERSION)
  assert.equal(shadow.ruleKind, 'accept')
  assert.equal(shadow.category, 'repo_task')
  assert.equal(shadow.p, 0.93)
  assert.equal(shadow.riskP, 0.41)
  assert.equal(shadow.verdict, 'accept')
  assert.equal(shadow.latencyMs, 42)
  assert.equal(shadow.inputTokens, 99)
})

test('shadowErrorOf is a bounded error row, never a failed intake', () => {
  const shadow = shadowErrorOf(new Error('x'.repeat(500)), { ruleKind: 'ignore', at: '2026-11-08T00:00:00.000Z' })
  assert.equal(shadow.status, 'error')
  assert.equal(shadow.ruleKind, 'ignore')
  assert.equal(shadow.error.length, 300)
})

test('the exported question payload is one stable choice question', () => {
  assert.equal(JUDGE_QUESTIONS.length, 1)
  assert.match(JUDGE_QUESTIONS_VERSION, /^ticket-v\d+$/)
  const payload = judgeQuestionPayload()
  assert.deepEqual(Object.keys(payload), ['category'])
  assert.equal(payload.category.type, 'choice')
  assert.equal(payload.category.criteria.repo_task.length > 0, true)
})
