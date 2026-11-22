/**
 * Profile dispatch (worker-bots spec §7–§8, P2). The acceptance criteria this file pins: AC1 (a default config
 * with an empty profile store dispatches exactly like v1.0.7), AC4 (an explicit choice that cannot run refuses the
 * Ticket), AC5 (a model answer that is null, invalid, late or over budget degrades instead of guessing), AC6 (the
 * candidate set is real: unverified backends and uncovered capabilities drop out), AC7 (ad-hoc synthesis is
 * deterministic, complete, and off when disabled).
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { clearDispatchCache, dispatchCacheSize, dispatchSummary, requiresOf, resolveDispatch, validateChoice }
  from './dispatch.js'
import { builtinProfiles } from './worker-profile.js'

const VERSION = '1.0.14'

function probe({ web = true, source = 'probe' } = {}) {
  return {
    backend: 'dsh',
    preset: 'generalist',
    capabilities: { edit: true, exec: true, web },
    unverified: web ? [] : ['web'],
    source,
    evidence: { backend: 'dsh', version: VERSION, preset: 'generalist', tools: ['write', 'bash'] },
    verifiedAt: '2026-01-01T00:00:00.000Z',
  }
}

function config(overrides = {}) {
  return {
    executor: {
      profile: 'generalist',
      dispatch: { mode: 'rules', adhoc: true, cacheSeconds: 600, maxPerPoll: 10,
        adhocOrder: ['dsh'], rules: [], ...overrides.dispatch },
      ...overrides.executor,
    },
    eval: { decision: { endpoint: 'https://example.test/v1/chat/completions', model: 'm', timeoutMs: 1000 } },
  }
}

function context(overrides = {}) {
  return {
    probes: { dsh: probe() },
    versions: { dsh: VERSION },
    enabledBackends: ['dsh'],
    workType: 'dev',
    deliverable: 'change',
    repoId: 'ebs',
    decisionToken: 'tok',
    pollMs: 60_000,
    ...overrides,
  }
}

function ticket(overrides = {}) {
  return { id: 't1', title: '修复工单', body: '改一处小问题', repoId: 'ebs', ...overrides }
}

function choose(answer) {
  return async () => ({ ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(answer) } }] }) })
}

function reset() { clearDispatchCache() }

test('requiresOf: report work needs no capability, change work always needs edit (§8.2)', () => {
  assert.deepEqual(requiresOf({ deliverable: 'report', workType: 'dev' }), [])
  assert.deepEqual(requiresOf({ deliverable: 'change', workType: 'dev' }), ['edit'])
  assert.deepEqual(requiresOf({ deliverable: 'change', workType: 'test' }), ['edit', 'exec'])
  assert.deepEqual(requiresOf({ deliverable: 'change', workType: 'research' }), ['edit', 'web'])
})

test('validateChoice is strict: only profile/confidence/reason, only real candidates (§7.2)', () => {
  const ids = ['generalist', 'surgical']
  assert.deepEqual(validateChoice({ profile: 'surgical', confidence: 0.8, reason: '小修' }, ids),
    { profile: 'surgical', confidence: 0.8, reason: '小修' })
  assert.equal(validateChoice({ profile: null, confidence: 0.2, reason: '都不合适' }, ids).profile, null)
  assert.throws(() => validateChoice({ profile: 'reviewer', confidence: 0.5, reason: 'x' }, ids), /候选集/)
  assert.throws(() => validateChoice({ profile: 'surgical', confidence: 1.5, reason: 'x' }, ids), /confidence/)
  assert.throws(() => validateChoice({ profile: 'surgical', confidence: 0.5, reason: '' }, ids), /reason/)
  assert.throws(() => validateChoice({ profile: 'surgical', confidence: 0.5, reason: 'x', extra: 1 }, ids), /多余字段/)
})

test('AC1: the default config with the built-in store dispatches generalist as source default', async () => {
  reset()
  let called = 0
  const result = await resolveDispatch(ticket(), config(), builtinProfiles(),
    context({ fetchImpl: async () => { called += 1; return choose({})( ) } }))
  assert.equal(called, 0, 'rules mode must never call the model')
  assert.equal(result.profileId, 'generalist')
  assert.equal(result.source, 'default')
  assert.deepEqual(result.capability, ['edit', 'exec', 'web'])
  assert.equal(result.capabilitySource, 'probe')
  assert.match(result.reason, /默认档位 generalist/)
  assert.equal(dispatchSummary(result), 'generalist')
})

test('AC4: an explicit profile that cannot run refuses the Ticket instead of substituting one', async () => {
  reset()
  const result = await resolveDispatch(ticket({ profileOverride: 'nope' }), config(), builtinProfiles(), context())
  assert.equal(result.profileId, 'nope')
  assert.equal(result.source, 'explicit')
  assert.equal(result.degraded, 'explicit-unusable')
  assert.match(result.reason, /手动指定/)

  const unavailable = await resolveDispatch(ticket({ profileOverride: 'generalist' }), config(), builtinProfiles(),
    context({ probes: { dsh: probe({ source: 'fallback' }) } }))
  assert.equal(unavailable.source, 'explicit')
  assert.equal(unavailable.degraded, 'explicit-unusable')
  assert.match(unavailable.reason, /未核验|不合法/)
})

test('a usable explicit profile wins and says who chose it', async () => {
  reset()
  const result = await resolveDispatch(ticket({ profileOverride: 'surgical' }), config(), builtinProfiles(), context())
  assert.equal(result.profileId, 'surgical')
  assert.equal(result.source, 'explicit')
  assert.equal(result.degraded, undefined)
})

test('a dispatch rule wins before the model, and rules mode never touches the network (§7.4)', async () => {
  reset()
  let called = 0
  const profiled = [...builtinProfiles(), { id: 'deployer', backend: 'dsh', name: 'deploy', requires: ['exec'] }]
  const result = await resolveDispatch(ticket(), config({ dispatch: {
    rules: [{ profile: 'deployer', keywords: ['修复'] }, { profile: 'generalist' }] } }), profiled,
  context({ fetchImpl: async () => { called += 1; return { ok: true, status: 200, json: async () => ({}) } } }))
  assert.equal(called, 0)
  assert.equal(result.profileId, 'deployer')
  assert.equal(result.source, 'rule')
  assert.match(result.reason, /规则 #1 命中/)
})

test('AC6: unverified backends and uncovered capabilities drop out of the candidate set', async () => {
  reset()
  const needsWeb = [...builtinProfiles(), { id: 'webby', backend: 'dsh', name: 'web', requires: ['web'] }]
  const result = await resolveDispatch(ticket(), config({ dispatch: { rules: [{ profile: 'webby' }] } }), needsWeb,
    context({ probes: { dsh: probe({ web: false, source: 'fallback' }) } }))
  // A probe that never ran makes one backend unverified. The routing table is a refusal note, not evidence (§3.2),
  // so neither the declared default nor ad-hoc synthesis may run on it: the Ticket refuses (§3.7, I3, I9).
  assert.deepEqual(result.candidates, [])
  assert.equal(result.profileId, null)
  assert.match(result.reason, /没有可用档位/)

  reset()
  // A probe that ran and reports no web capability is authoritative: a research Ticket cannot use anything here.
  const research = await resolveDispatch(ticket({ title: '调研' }),
    config({ dispatch: { mode: 'auto', rules: [] } }), needsWeb,
    context({ workType: 'research', probes: { dsh: probe({ web: false }) } }))
  assert.ok(!research.candidates.includes('webby'), 'webby needs web and the probe does not grant it')
  assert.equal(research.profileId, null)
  assert.match(research.reason, /没有可用档位/)
})

test('AC5: the model answer is used only when it is valid; every other answer degrades (§7.2)', async () => {
  reset()
  const model = config({ executor: { dispatch: { mode: 'model', rules: [] } } })

  const good = await resolveDispatch(ticket(), model, builtinProfiles(),
    context({ fetchImpl: choose({ profile: 'surgical', confidence: 0.9, reason: '小修' }) }))
  assert.equal(good.profileId, 'surgical')
  assert.equal(good.source, 'model')
  assert.match(good.reason, /决策模型选择 surgical（置信度 0.9）/)

  reset()
  const invalid = await resolveDispatch(ticket(), model, builtinProfiles(),
    context({ fetchImpl: choose({ profile: 'generalist', confidence: 2, reason: 'x' }) }))
  assert.equal(invalid.profileId, 'generalist')
  assert.equal(invalid.source, 'default')
  assert.equal(invalid.degraded, 'model')

  reset()
  const none = await resolveDispatch(ticket(), model, builtinProfiles(),
    context({ fetchImpl: choose({ profile: null, confidence: 0.3, reason: '都不合适' }) }))
  assert.equal(none.profileId, 'generalist')
  assert.equal(none.degraded, 'model-null')

  reset()
  const failed = await resolveDispatch(ticket(), model, builtinProfiles(),
    context({ fetchImpl: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }) } }))
  assert.equal(failed.profileId, 'generalist')
  assert.equal(failed.degraded, 'model')
})

test('AC5: the per-poll budget stops a poll loop from calling the model again (§7.4)', async () => {
  reset()
  const model = config({ executor: { dispatch: { mode: 'model', rules: [], cacheSeconds: 0, maxPerPoll: 1 } } })
  let called = 0
  const fetchImpl = async () => { called += 1; return { ok: true, status: 200,
    json: async () => ({ choices: [{ message: { content: '{"profile":null,"confidence":0.1,"reason":"x"}' } }] }) } }
  const first = await resolveDispatch(ticket({ title: 'a' }), model, builtinProfiles(), context({ fetchImpl }))
  const second = await resolveDispatch(ticket({ title: 'b' }), model, builtinProfiles(), context({ fetchImpl }))
  assert.equal(called, 1)
  assert.equal(second.degraded, 'model')
  assert.equal(first.degraded, 'model-null')
})

test('AC5: repeated tickets reuse one cached answer inside cacheSeconds (§7.4)', async () => {
  reset()
  const model = config({ executor: { dispatch: { mode: 'model', rules: [] } } })
  let called = 0
  const fetchImpl = choose({ profile: 'surgical', confidence: 0.7, reason: '小修' })
  const counting = async (...args) => { called += 1; return fetchImpl(...args) }
  await resolveDispatch(ticket(), model, builtinProfiles(), context({ fetchImpl: counting }))
  await resolveDispatch(ticket(), model, builtinProfiles(), context({ fetchImpl: counting }))
  assert.equal(called, 1)
  assert.equal(dispatchCacheSize(), 1)
})

test('AC7: ad-hoc synthesis is deterministic and records the whole profile', async () => {
  reset()
  const result = await resolveDispatch(ticket(), config(), [], context())
  assert.equal(result.source, 'adhoc')
  assert.match(result.profileId, /^adhoc:[0-9a-f]{8}$/)
  assert.equal(result.resolved.id, result.profileId)
  assert.equal(result.resolved.backend, 'dsh')
  assert.deepEqual(result.synthesizedFrom, { requires: ['edit'], deliverable: 'change' })

  reset()
  const again = await resolveDispatch(ticket(), config(), [], context())
  assert.equal(again.profileId, result.profileId, 'same input, same ad-hoc id')
})

test('AC7: adhoc=false refuses instead of synthesizing a profile (§8.1)', async () => {
  reset()
  const result = await resolveDispatch(ticket(), config({ dispatch: { adhoc: false } }), [], context())
  assert.equal(result.profileId, null)
  assert.match(result.reason, /adhoc 已关闭/)
  assert.equal(dispatchSummary(result), result.reason)
})

test('the default layer cannot run work its backend cannot do (§7.1/§8.1)', async () => {
  reset()
  const cli = { id: 'cli-default', name: 'CLI', backend: 'claude', requires: ['edit'] }
  const model = config({ executor: { profile: 'cli-default' } })
  // Nothing probed the CLI backend: it is not a candidate, so the default refuses rather than trusting the table.
  const unprobed = await resolveDispatch(ticket(), model, [cli], context({ workType: 'research', probes: {} }))
  assert.equal(unprobed.profileId, null)

  // Probed, and genuinely without web: research work still cannot land on the default, so ad-hoc takes over on a
  // backend whose probe covers the work.
  const probed = await resolveDispatch(ticket(), model, [cli],
    context({ workType: 'research', probes: { dsh: probe(), claude: probe({ web: false }) },
      enabledBackends: ['dsh', 'claude'] }))
  assert.notEqual(probed.profileId, 'cli-default')
  assert.equal(probed.source, 'adhoc')
  assert.match(probed.reason, /现拉/)
})

test('a refusal says whether ad-hoc was off or had no backend for the work (§8.1)', async () => {
  reset()
  const cli = { id: 'cli-default', name: 'CLI', backend: 'claude', requires: ['edit'] }
  const model = config({ executor: { profile: 'cli-default', dispatch: { adhoc: true, adhocOrder: ['claude'] } } })
  const result = await resolveDispatch(ticket(), model, [cli],
    context({ workType: 'research', probes: {}, enabledBackends: ['claude'] }))
  assert.equal(result.profileId, null)
  assert.match(result.reason, /现拉找不到可用后端/)
})
