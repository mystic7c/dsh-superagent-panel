/**
 * Bot dispatch (worker-bots 1.5.0 §2). This file pins the rewritten contract:
 *
 *   - explicit (ticket override, then repo) never calls the model, and an id missing from the store falls
 *     through silently; a declared bot whose backend is down still runs (the executor owns that refusal);
 *   - candidates are exactly the bots whose backend is available *right now* — the probe is injected here, so
 *     no backend is ever spawned;
 *   - zero candidates degrade to `executor.bot` with `no-candidate`, one candidate needs no model call, and
 *     everything above needs exactly one call, cached by (candidate ids, their whenToUse, ticket digest);
 *   - every answer that is not `{botId, because}` in the candidate set degrades with its own code.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DISPATCH_DEGRADED,
  DISPATCH_SOURCES,
  callPickModel,
  clearDispatchCache,
  dispatchCacheKey,
  dispatchCacheSize,
  dispatchRequestOf,
  dispatchSummary,
  interpretPick,
  resolveDispatch,
} from './dispatch.js'

const ENDPOINT = 'https://decision.test/v1/chat/completions'

/** A bot is data: id/name/backend/whenToUse. Nothing on it declares a capability any more. */
function bot(id, overrides = {}) {
  return { id, name: `Bot ${id}`, backend: 'dsh', description: `${id} 的说明`, whenToUse: `${id} 适合的活`, ...overrides }
}

/** The three bots most tests use; generalist exists so every degradation lands on a predictable default. */
function threeBots() {
  return [bot('generalist'), bot('a'), bot('b')]
}

function config({ bot: defaultBot = 'generalist', dispatch = {}, decision = {}, repos = [] } = {}) {
  return {
    executor: { bot: defaultBot, dispatch: { maxPerPoll: 10, ...dispatch } },
    eval: { decision: { endpoint: ENDPOINT, model: 'picker-model', timeoutMs: 1000, ...decision } },
    repos,
  }
}

function ticket(overrides = {}) {
  return { id: 't1', title: '修一个 bug', body: '改一行代码', repoId: 'ebs', ...overrides }
}

function options(overrides = {}) {
  return { repoId: 'ebs', decisionToken: 'tok', ...overrides }
}

/** Injected availability: everything is available unless the map says otherwise. */
function probeOf(states = {}) {
  return async item => {
    const state = states[item.id] ?? 'available'
    return { state, reason: `${item.id} is ${state}` }
  }
}

function answerOf(content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  return async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) })
}

function counting(fetchImpl) {
  let calls = 0
  return {
    calls: () => calls,
    fetchImpl: async (...args) => { calls += 1; return fetchImpl(...args) },
  }
}

function reset() { clearDispatchCache() }

test('the source and degradation vocabularies are fixed and frozen', () => {
  assert.deepEqual([...DISPATCH_SOURCES], ['explicit-repo', 'explicit-ticket', 'pick', 'default'])
  assert.deepEqual([...DISPATCH_DEGRADED],
    ['pick-unavailable', 'pick-failed', 'pick-invalid', 'pick-none', 'no-candidate'])
  assert.ok(Object.isFrozen(DISPATCH_SOURCES))
  assert.ok(Object.isFrozen(DISPATCH_DEGRADED))
  assert.equal(new Set(DISPATCH_DEGRADED).size, DISPATCH_DEGRADED.length)
})

test('interpretPick accepts exactly {botId, because} in the candidate set', () => {
  const ids = ['a', 'b']
  assert.deepEqual(interpretPick('{"botId":"a","because":"小修"}', ids), { ok: true, botId: 'a', because: '小修' })
  // The answer may be wrapped in prose; the first complete JSON object is the answer.
  assert.deepEqual(interpretPick('先说明一下 {"botId":null,"because":"都不合适"} 以上', ids),
    { ok: true, botId: null, because: '都不合适' })
  // Braces inside a string are part of the string, not a nested object.
  assert.deepEqual(interpretPick('{"botId":"b","because":"处理 {花括号} 工单"}', ids),
    { ok: true, botId: 'b', because: '处理 {花括号} 工单' })
  // because is trimmed and capped, so a chatty model cannot blow up the run record.
  const long = interpretPick(JSON.stringify({ botId: 'a', because: `  ${'x'.repeat(300)}  ` }), ids)
  assert.equal(long.because, 'x'.repeat(200))
})

test('interpretPick: every malformed answer is pick-failed, an unknown id is pick-invalid', () => {
  const ids = ['a', 'b']
  const failed = [
    '',
    '完全不是 JSON',
    '[]',
    '{"botId": "a",}',
    '{"botId":"a"}',
    '{"botId":"a","because":"   "}',
    '{"botId":"a","because":"x","extra":1}',
    '{"botId":"a","because":123}',
  ]
  for (const content of failed) {
    const answer = interpretPick(content, ids)
    assert.equal(answer.ok, false, content)
    assert.equal(answer.degraded, 'pick-failed', content)
  }
  assert.equal(interpretPick('{"botId":"ghost","because":"x"}', ids).degraded, 'pick-invalid')
  assert.equal(interpretPick('{"botId":1,"because":"x"}', ids).degraded, 'pick-invalid')
})

test('dispatchCacheKey covers candidate ids, their whenToUse and the ticket', () => {
  const list = [bot('a'), bot('b')]
  const key = dispatchCacheKey({ title: '修 bug', body: '正文' }, list)
  assert.equal(key, dispatchCacheKey({ title: '修 bug', body: '正文' }, [bot('a'), bot('b')]))
  assert.notEqual(key, dispatchCacheKey({ title: '修 bug' }, [bot('a'), bot('b', { whenToUse: '换了' })]))
  assert.notEqual(key, dispatchCacheKey({ title: '修 bug', body: '正文' }, [bot('a')]))
  assert.notEqual(key, dispatchCacheKey({ title: '修 bug', body: '改了正文' }, list))
  // A bot without whenToUse is the empty string, not a hole in the key.
  assert.equal(dispatchCacheKey({ title: 't' }, [bot('a', { whenToUse: undefined })]),
    dispatchCacheKey({ title: 't' }, [bot('a', { whenToUse: '' })]))
})

test('dispatchRequestOf sends identity, self-description and a bounded ticket', () => {
  const list = [
    { id: 'a', name: '甲', description: '说明甲', whenToUse: '甲适合的活' },
    { id: 'b', name: '乙' },
  ]
  const request = dispatchRequestOf({ title: '短标题', body: '短正文' }, list)
  assert.deepEqual(request, {
    ticket: { title: '短标题', body: '短正文' },
    candidates: [
      { id: 'a', name: '甲', description: '说明甲', whenToUse: '甲适合的活' },
      { id: 'b', name: '乙', description: '', whenToUse: '' },
    ],
  })
  assert.equal('truncated' in request.ticket, false)

  const long = dispatchRequestOf({ title: 't'.repeat(500), body: 'b'.repeat(5000) }, list)
  assert.equal(long.ticket.truncated, true)
  assert.equal(long.ticket.title.length, 400)
  assert.equal(long.ticket.body.length, 4000)
  assert.equal(dispatchRequestOf(undefined, []).ticket.title, '')
})

test('callPickModel makes one chat-completions call and returns the raw content', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"botId":"a","because":"x"}' } }] }) }
  }
  const payload = { ticket: { title: 't' }, candidates: [] }
  const content = await callPickModel({ endpoint: ENDPOINT, model: 'picker', token: 'tok', payload, fetchImpl })
  assert.equal(content, '{"botId":"a","because":"x"}')
  const [{ url, init }] = calls
  assert.equal(url, ENDPOINT)
  assert.equal(init.method, 'POST')
  assert.equal(init.headers.authorization, 'Bearer tok')
  assert.equal(init.headers['content-type'], 'application/json')
  const body = JSON.parse(init.body)
  assert.equal(body.model, 'picker')
  assert.equal(body.temperature, 0)
  assert.equal(body.messages.length, 2)
  assert.deepEqual(JSON.parse(body.messages[1].content), payload)
  assert.match(body.messages[0].content, /派单器/)

  let unauthenticated
  await callPickModel({ endpoint: ENDPOINT, model: 'picker', payload, fetchImpl: async (_url, init) => {
    unauthenticated = init
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"botId":null,"because":"x"}' } }] }) }
  } })
  assert.equal('authorization' in unauthenticated.headers, false)
})

test('callPickModel tags HTTP, empty, timeout and network failures', async () => {
  const call = fetchImpl => callPickModel({ endpoint: ENDPOINT, model: 'picker', payload: {}, timeoutMs: 1000, fetchImpl })
  await assert.rejects(call(async () => ({ ok: false, status: 503, text: async () => 'down' })), error => {
    assert.equal(error.code, 'MODEL_HTTP')
    assert.match(error.message, /HTTP 503：down/)
    return true
  })
  await assert.rejects(call(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '   ' } }] }) })),
    { code: 'MODEL_EMPTY' })
  await assert.rejects(call(async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error }),
    { code: 'MODEL_TIMEOUT' })
  await assert.rejects(call(async () => { throw new Error('ECONNREFUSED') }), /ECONNREFUSED/)
})

test('resolveDispatch probes every bot with ctx/config/stateDir and the injected CLI version', async () => {
  reset()
  const seen = []
  const probe = async (item, settings) => { seen.push({ id: item.id, ...settings }); return { state: 'available' } }
  const cfg = config()
  const ctx = { tag: 'ctx' }
  await resolveDispatch(ticket(), cfg, [bot('generalist'), bot('cli', { backend: 'claude' })], options({
    probe, ctx, stateDir: '/tmp/state', versions: { claude: '2.1.0' },
  }))
  assert.equal(seen.length, 2)
  assert.equal(seen[0].id, 'generalist')
  assert.equal(seen[0].ctx, ctx)
  assert.equal(seen[0].config, cfg)
  assert.equal(seen[0].stateDir, '/tmp/state')
  assert.equal('version' in seen[0], false)
  assert.equal(seen[1].version, '2.1.0')

  // A probe that answers nothing is unverified, with an empty reason, and is reported as skipped.
  reset()
  const partial = await resolveDispatch(ticket(), config(), [bot('generalist'), bot('a')], options({
    probe: async item => (item.id === 'a' ? {} : { state: 'available' }),
  }))
  assert.deepEqual(partial.skipped, [{ id: 'a', backend: 'dsh', state: 'unverified', reason: '' }])
})

test('explicit layer: the ticket choice beats the repo choice, and neither calls the model', async () => {
  reset()
  const model = counting(answerOf({ botId: 'a', because: '模型选 a' }))
  const cfg = config({ repos: [{ id: 'ebs', bot: 'b' }] })
  const fromTicket = await resolveDispatch(ticket({ botOverride: 'a' }), cfg, threeBots(),
    options({ probe: probeOf(), fetchImpl: model.fetchImpl }))
  assert.equal(fromTicket.source, 'explicit-ticket')
  assert.equal(fromTicket.botId, 'a')
  assert.equal(fromTicket.because, '工单手动指定')
  assert.equal(fromTicket.degraded, null)
  assert.equal(fromTicket.cacheHit, false)

  const fromRepo = await resolveDispatch(ticket(), cfg, threeBots(),
    options({ probe: probeOf(), fetchImpl: model.fetchImpl }))
  assert.equal(fromRepo.source, 'explicit-repo')
  assert.equal(fromRepo.botId, 'b')
  assert.equal(fromRepo.because, '仓库 ebs 指定')
  assert.equal(model.calls(), 0, 'the explicit layer never spends a model call')
})

test('explicit layer: an id missing from the store falls through silently', async () => {
  reset()
  const model = counting(answerOf({ botId: 'b', because: '模型选 b' }))
  const cfg = config({ repos: [{ id: 'ebs', bot: 'ghost-repo' }] })
  const result = await resolveDispatch(ticket({ botOverride: 'ghost-ticket' }), cfg, threeBots(),
    options({ probe: probeOf(), fetchImpl: model.fetchImpl }))
  assert.equal(result.source, 'pick')
  assert.equal(result.botId, 'b')
  assert.equal(model.calls(), 1)
})

test('explicit layer: a bot whose backend is down still runs, and the skip is recorded', async () => {
  reset()
  const model = counting(async () => { throw new Error('the model must not be called') })
  const result = await resolveDispatch(ticket({ botOverride: 'reviewer' }), config(),
    [bot('generalist'), bot('reviewer', { backend: 'claude' })],
    options({ probe: probeOf({ reviewer: 'missing' }), fetchImpl: model.fetchImpl }))
  assert.equal(result.source, 'explicit-ticket')
  assert.equal(result.botId, 'reviewer')
  assert.deepEqual(result.candidates, ['generalist'])
  assert.deepEqual(result.skipped, [{ id: 'reviewer', backend: 'claude', state: 'missing', reason: 'reviewer is missing' }])
  assert.equal(model.calls(), 0)
})

test('exactly one available candidate is the pick, with no model call', async () => {
  reset()
  const model = counting(async () => { throw new Error('the model must not be called') })
  const result = await resolveDispatch(ticket(), config(), threeBots(), options({
    probe: probeOf({ a: 'unverified', b: 'checking' }), fetchImpl: model.fetchImpl,
  }))
  assert.equal(model.calls(), 0)
  assert.equal(result.source, 'pick')
  assert.equal(result.botId, 'generalist')
  assert.equal(result.because, '只有这一个可用 Bot，未调模型')
  assert.deepEqual(result.candidates, ['generalist'])
  assert.deepEqual(result.skipped.map(item => [item.id, item.state]),
    [['a', 'unverified'], ['b', 'checking']])
  assert.equal(result.cacheHit, false)
  assert.equal(result.degraded, null)
})

test('a pick sends every candidate whenToUse and the ticket to the decision model once', async () => {
  reset()
  let sent
  const fetchImpl = async (url, init) => {
    sent = { url, init, body: JSON.parse(init.body) }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '{"botId":"b","because":"b 更合适"}' } }] }) }
  }
  const result = await resolveDispatch(ticket({ title: '修 bug', body: '改一行' }), config(), threeBots(),
    options({ probe: probeOf(), fetchImpl, decisionToken: 'tok-9' }))
  assert.equal(result.source, 'pick')
  assert.equal(result.botId, 'b')
  assert.equal(result.because, 'b 更合适')
  assert.equal(result.reason, 'b 更合适')
  assert.equal(result.cacheHit, false)
  assert.equal(sent.url, ENDPOINT)
  assert.equal(sent.init.headers.authorization, 'Bearer tok-9')
  assert.equal(sent.body.model, 'picker-model')
  assert.equal(sent.body.temperature, 0)
  assert.match(sent.body.messages[0].content, /派单器/)
  const request = JSON.parse(sent.body.messages[1].content)
  assert.deepEqual(request.ticket, { title: '修 bug', body: '改一行' })
  assert.deepEqual(request.candidates.map(candidate => candidate.id), ['generalist', 'a', 'b'])
  assert.equal(request.candidates[2].whenToUse, 'b 适合的活')
  assert.equal(request.candidates[2].description, 'b 的说明')
})

test('the pick cache is free on a hit, and cacheSeconds: 0 turns both directions off', async () => {
  reset()
  const cached = counting(answerOf({ botId: 'a', because: '选 a' }))
  const first = await resolveDispatch(ticket(), config(), threeBots(),
    options({ probe: probeOf(), fetchImpl: cached.fetchImpl }))
  const second = await resolveDispatch(ticket(), config(), threeBots(),
    options({ probe: probeOf(), fetchImpl: cached.fetchImpl }))
  assert.equal(cached.calls(), 1)
  assert.equal(first.cacheHit, false)
  assert.equal(second.cacheHit, true)
  assert.equal(second.botId, 'a')
  assert.equal(second.because, '选 a')
  assert.equal(dispatchCacheSize(), 1)

  reset()
  const uncached = counting(answerOf({ botId: 'a', because: '选 a' }))
  const cfg = config({ dispatch: { cacheSeconds: 0 } })
  await resolveDispatch(ticket(), cfg, threeBots(), options({ probe: probeOf(), fetchImpl: uncached.fetchImpl }))
  await resolveDispatch(ticket(), cfg, threeBots(), options({ probe: probeOf(), fetchImpl: uncached.fetchImpl }))
  assert.equal(uncached.calls(), 2)
  assert.equal(dispatchCacheSize(), 0)
})

test('a changed whenToUse or ticket bypasses the cache instead of replaying the old pick', async () => {
  reset()
  let picked = 'a'
  const model = counting(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify({ botId: picked, because: `选 ${picked}` }) } }] }),
  }))
  const list = threeBots()
  const run = title => resolveDispatch(ticket({ title }), config(), list,
    options({ probe: probeOf(), fetchImpl: model.fetchImpl }))

  assert.equal((await run('同一单')).botId, 'a')
  list[2].whenToUse = '改了描述，专门接 b 的活'
  picked = 'b'
  const afterWhenToUse = await run('同一单')
  assert.equal(afterWhenToUse.botId, 'b')
  assert.equal(afterWhenToUse.cacheHit, false)
  assert.equal(model.calls(), 2)
  assert.equal((await run('同一单')).cacheHit, true, 'the new key is cached too')

  const afterTicket = await run('另一单')
  assert.equal(afterTicket.cacheHit, false)
  assert.equal(model.calls(), 3)
})

test('the per-poll budget stops a polling loop after maxPerPoll calls', async () => {
  reset()
  const model = counting(answerOf({ botId: 'a', because: '选 a' }))
  const cfg = config({ dispatch: { cacheSeconds: 0, maxPerPoll: 1 } })
  const first = await resolveDispatch(ticket({ title: '第一单' }), cfg, threeBots(),
    options({ probe: probeOf(), fetchImpl: model.fetchImpl }))
  const second = await resolveDispatch(ticket({ title: '第二单' }), cfg, threeBots(),
    options({ probe: probeOf(), fetchImpl: model.fetchImpl }))
  assert.equal(model.calls(), 1)
  assert.equal(first.source, 'pick')
  assert.equal(second.source, 'default')
  assert.equal(second.degraded, 'pick-unavailable')
  assert.equal(second.botId, 'generalist')
  assert.match(second.reason, /额度/)
})

test('pick-none: the model says no bot fits, so the default runs and the reason is kept', async () => {
  reset()
  const result = await resolveDispatch(ticket(), config(), threeBots(), options({
    probe: probeOf(), fetchImpl: answerOf({ botId: null, because: '这单不是代码活' }),
  }))
  assert.equal(result.source, 'default')
  assert.equal(result.degraded, 'pick-none')
  assert.equal(result.botId, 'generalist')
  assert.match(result.reason, /决策模型认为都不合适/)
  assert.match(result.reason, /这单不是代码活/)
  assert.match(result.reason, /回退 generalist/)
})

test('pick-failed: a malformed answer degrades instead of guessing, and is never cached', async () => {
  const contents = ['不是 JSON', '{"botId":"a",}', '{"botId":"a"}', '[]']
  for (const content of contents) {
    reset()
    const result = await resolveDispatch(ticket(), config(), threeBots(), options({
      probe: probeOf(), fetchImpl: answerOf(content),
    }))
    assert.equal(result.source, 'default', content)
    assert.equal(result.degraded, 'pick-failed', content)
    assert.equal(result.botId, 'generalist')
    assert.match(result.reason, /决策模型调用失败/)
    assert.equal(dispatchCacheSize(), 0, 'a failed call leaves no cache entry')
  }
})

test('pick-invalid: an id outside the candidate set is refused, not snapped to the closest bot', async () => {
  reset()
  const result = await resolveDispatch(ticket(), config(), threeBots(), options({
    probe: probeOf({ a: 'missing' }), fetchImpl: answerOf({ botId: 'a', because: '猜的' }),
  }))
  assert.equal(result.source, 'default')
  assert.equal(result.degraded, 'pick-invalid')
  assert.equal(result.botId, 'generalist')
  assert.match(result.reason, /候选之外/)
})

test('pick-unavailable: missing settings, HTTP, empty, timeout and network all degrade before a pick', async () => {
  reset()
  for (const decision of [{ endpoint: '' }, { model: '' }]) {
    const { fetchImpl, calls } = counting(answerOf({ botId: 'a', because: 'x' }))
    const result = await resolveDispatch(ticket(), config({ decision }), threeBots(),
      options({ probe: probeOf(), fetchImpl }))
    assert.equal(calls(), 0, 'unconfigured model is not called')
    assert.equal(result.source, 'default')
    assert.equal(result.degraded, 'pick-unavailable')
    assert.equal(result.botId, 'generalist')
    assert.match(result.reason, /决策模型未配置/)
  }

  const failures = [
    [async () => ({ ok: false, status: 500, text: async () => 'boom' }), /HTTP 500：boom/],
    [answerOf(''), /返回空内容/],
    [async () => { const error = new Error('aborted'); error.name = 'AbortError'; throw error }, /超时/],
    [async () => { throw new Error('ECONNREFUSED') }, /模型调用失败：ECONNREFUSED/],
  ]
  for (const [fetchImpl, pattern] of failures) {
    reset()
    const result = await resolveDispatch(ticket(), config(), threeBots(), options({ probe: probeOf(), fetchImpl }))
    assert.equal(result.source, 'default')
    assert.equal(result.degraded, 'pick-unavailable', String(pattern))
    assert.equal(result.botId, 'generalist')
    assert.match(result.reason, pattern)
  }
})

test('no candidate: every backend is skipped, the default bot still runs, and the reason says why', async () => {
  reset()
  const result = await resolveDispatch(ticket(), config(), threeBots(), options({
    probe: probeOf({ generalist: 'unverified', a: 'missing', b: 'checking' }),
  }))
  assert.equal(result.source, 'default')
  assert.equal(result.degraded, 'no-candidate')
  assert.equal(result.botId, 'generalist')
  assert.deepEqual(result.candidates, [])
  assert.deepEqual(result.skipped.map(item => item.state), ['unverified', 'missing', 'checking'])
  assert.deepEqual(result.skipped.map(item => item.id), ['generalist', 'a', 'b'])
  assert.match(result.reason, /没有后端可用的 Bot/)
  assert.match(result.reason, /回退 generalist/)

  // An empty store has nothing to fall back to: the record still says why.
  const empty = await resolveDispatch(ticket(), config(), [], options({ probe: probeOf() }))
  assert.equal(empty.botId, null)
  assert.equal(empty.picked, null)
  assert.equal(empty.degraded, 'no-candidate')
  assert.match(empty.reason, /没有后端可用的 Bot/)

  // executor.bot that is not in the store falls back to the first available bot definition.
  const ghost = await resolveDispatch(ticket(), config({ bot: 'ghost' }), [bot('a'), bot('b')],
    options({ probe: probeOf({ a: 'missing', b: 'missing' }) }))
  assert.equal(ghost.botId, 'a')
})

test('the result record carries the full dispatch contract and a config digest', async () => {
  reset()
  const cfg = config()
  const result = await resolveDispatch(ticket(), cfg, threeBots(),
    options({ probe: probeOf(), fetchImpl: answerOf({ botId: 'b', because: '选 b' }) }))
  assert.deepEqual(Object.keys(result).sort(),
    ['because', 'botId', 'cacheHit', 'candidates', 'configDigest', 'degraded', 'picked', 'reason', 'skipped', 'source'])
  assert.equal(result.picked, 'b')
  assert.equal(result.botId, 'b')
  assert.equal(result.reason, '选 b')
  assert.equal(result.because, '选 b')
  assert.equal(result.cacheHit, false)
  assert.equal(result.degraded, null)
  assert.deepEqual(result.candidates, ['generalist', 'a', 'b'])
  assert.deepEqual(result.skipped, [])
  assert.match(result.configDigest, /^[0-9a-f]{64}$/)

  // The digest covers the bot store, so changing a whenToUse is a different config — and a different cache key.
  const changed = await resolveDispatch(ticket(), cfg,
    [bot('generalist'), bot('a'), bot('b', { whenToUse: '换了' })],
    options({ probe: probeOf(), fetchImpl: answerOf({ botId: 'b', because: '选 b' }) }))
  assert.notEqual(changed.configDigest, result.configDigest)
})

test('dispatchSummary is one log line naming the pick, its source and any degradation', () => {
  assert.equal(dispatchSummary({ source: 'pick', picked: 'a', degraded: null, cacheHit: false }), 'a <- pick')
  assert.equal(dispatchSummary({ source: 'default', botId: 'generalist', degraded: 'pick-none' }),
    'generalist <- default [pick-none]')
  assert.equal(dispatchSummary({ source: 'pick', picked: 'a', cacheHit: true }), 'a <- pick (cache)')
  assert.equal(dispatchSummary({}), '(none) <- ?')
  assert.equal(dispatchSummary(null), '(none) <- ?')
})
