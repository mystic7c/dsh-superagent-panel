import test from 'node:test'
import assert from 'node:assert/strict'
import { newWorkflow, resumeWorkflow, runWorkflow } from './workflow.js'
const plan = { acceptanceCriteria: [{ id: 'AC1' }] }
const execute = (state, invoke, extra = {}) => runWorkflow({ state, invoke, persist: async () => {}, candidateDigest: async () => 'sha', ...extra })
const resume = (state, invoke, extra = {}) => resumeWorkflow({ state, invoke, persist: async () => {}, candidateDigest: async () => 'sha', ...extra })
test('planned workflow requires gates then independent review', async () => {
  const roles = []
  const state = await execute(newWorkflow({ mode: 'planned' }), async role => {
    roles.push(role)
    return role === 'plan' ? plan : role === 'gates' ? { passed: true } : role === 'review' ? { verdict: 'passed' } : {}
  })
  assert.deepEqual(roles, ['plan', 'implement', 'gates', 'review'])
  assert.equal(state.reviewedDigest, 'sha')
})
test('invalid reviewer output never passes', async () => {
  const state = newWorkflow({ mode: 'planned' })
  await assert.rejects(execute(state, async role => role === 'plan' ? plan : role === 'gates' ? { passed: true } : {}))
  assert.equal(state.status, 'blocked')
})
test('failed gates prevent review and delivery', async () => {
  const state = await execute(newWorkflow({ mode: 'planned' }), async role => {
    assert.notEqual(role, 'review')
    return role === 'plan' ? plan : {}
  })
  assert.equal(state.status, 'blocked')
})
test('repair budget terminates repeated rejection', async () => {
  const state = await execute(newWorkflow({ mode: 'planned' }), async role => role === 'plan' ? plan : role === 'gates' ? { passed: true } : role === 'review' ? { verdict: 'changes_requested' } : {})
  assert.equal(state.repairs, 2)
  assert.equal(state.status, 'blocked')
})

test('candidate mutation during review invalidates success', async () => {
  let digest = 'before'
  const state = await execute(newWorkflow({ mode: 'planned' }), async role => {
    if (role === 'review') { digest = 'after'; return { verdict: 'passed' } }
    return role === 'plan' ? plan : role === 'gates' ? { passed: true } : {}
  }, { candidateDigest: async () => digest })
  assert.equal(state.status, 'blocked')
  assert.equal(state.reason, 'candidate_changed')
})

// P1-5: a staged workflow stopped at a worker stage continues there instead of running assess/plan/implement again.
test('resume re-runs only the failed review and keeps its record in place', async () => {
  const state = newWorkflow({ mode: 'planned' })
  await assert.rejects(execute(state, async role => {
    if (role === 'review') throw new Error('codex usage limit')
    return role === 'plan' ? plan : role === 'gates' ? { passed: true } : {}
  }), /usage limit/)
  const stopped = { stages: state.stages.length, reviewKeys: state.stages.filter(item => item.role === 'review').map(item => item.key) }
  const calls = []
  await resume(state, async (role, input) => {
    calls.push([role, input])
    return { verdict: 'passed' }
  })
  assert.deepEqual(calls.map(([role]) => role), ['review'])
  assert.deepEqual(calls[0][1].digest, 'sha')
  assert.equal(state.status, 'ready')
  assert.equal(state.stages.length, stopped.stages)
  assert.deepEqual(state.stages.filter(item => item.role === 'review').map(item => item.key), stopped.reviewKeys)
  assert.deepEqual(state.stages.at(-1).result, { verdict: 'passed' })
})

test('resume refuses a candidate that changed after the gated review', async () => {
  const state = newWorkflow({ mode: 'planned' })
  await assert.rejects(execute(state, async role => {
    if (role === 'review') throw new Error('codex usage limit')
    return role === 'plan' ? plan : role === 'gates' ? { passed: true } : {}
  }))
  await assert.rejects(resume(state, async () => ({ verdict: 'passed' }), { candidateDigest: async () => 'changed' }),
    /candidate changed/)
  assert.equal(state.status, 'blocked')
})

test('resume re-implements after a failed implement with the inputs it was given', async () => {
  const state = newWorkflow({ mode: 'planned' })
  await assert.rejects(execute(state, async role => {
    if (role === 'implement') throw new Error('worker lost')
    return role === 'plan' ? plan : {}
  }), /worker lost/)
  assert.equal(state.stages.at(-1).role, 'implement')
  const calls = []
  await resume(state, async (role, input) => {
    calls.push([role, input])
    return role === 'gates' ? { passed: true } : role === 'review' ? { verdict: 'passed' } : {}
  })
  assert.deepEqual(calls.map(([role]) => role), ['implement', 'gates', 'review'])
  assert.deepEqual(calls[0][1], { plan, feedback: null })
  assert.equal(state.stages.filter(item => item.role === 'implement').length, 1)
  assert.equal(state.status, 'ready')
})

test('resume requires a blocked workflow that stopped at a replayable stage', async () => {
  const empty = newWorkflow({ mode: 'planned' })
  await assert.rejects(resume(empty, async () => ({})), /not blocked/)
  const ready = await execute(newWorkflow({ mode: 'planned' }), async role => role === 'plan' ? plan
    : role === 'gates' ? { passed: true } : role === 'review' ? { verdict: 'passed' } : {})
  await assert.rejects(resume(ready, async () => ({})), /not blocked/)
})

// A stop must say why: the host error used to read "workflow blocked: blocked" with no reason at all.
test('a blocked workflow records a reason and a readable detail', async () => {
  const rejected = await execute(newWorkflow({ mode: 'planned' }), async role => role === 'plan' ? plan
    : role === 'gates' ? { passed: true } : role === 'review' ? { verdict: 'changes_requested', findings: ['P1', 'P2'] } : {})
  assert.equal(rejected.reason, 'review_changes_requested')
  assert.match(rejected.detail, /after 2 repair round\(s\) \(2 findings\)/)

  const gateFailure = await execute(newWorkflow({ mode: 'planned' }), async role => role === 'plan' ? plan
    : role === 'gates' ? { passed: false, results: [{ name: 'backend', exitCode: 1 }] } : {})
  assert.equal(gateFailure.reason, 'gates_failed')
  assert.match(gateFailure.detail, /backend/)

  const questions = await execute(newWorkflow({ mode: 'planned' }), async role => role === 'plan'
    ? { ...plan, openQuestions: ['which branch?'] } : {})
  assert.equal(questions.reason, 'plan_open_questions')
  assert.match(questions.detail, /1 open question/)
})

// The last review used the budget: the stop is not a failure but there is nothing left to replay, so continuing needs
// a raised budget and then runs the next implement→gates→review round (nothing completed is redone).
test('resume continues a workflow whose last repair round was rejected', async () => {
  const state = newWorkflow({ mode: 'planned' })
  await execute(state, async role => role === 'plan' ? plan
    : role === 'gates' ? { passed: true } : role === 'review' ? { verdict: 'changes_requested' } : {})
  assert.equal(state.status, 'blocked')
  assert.equal(state.repairs, 2)
  await assert.rejects(resume(state, async () => ({ verdict: 'passed' })), /budget exhausted/)
  const calls = []
  await resume(state, async (role, input) => {
    calls.push([role, input])
    return role === 'gates' ? { passed: true } : role === 'implement' ? { summary: 'fixed' } : { verdict: 'passed' }
  }, { maxRepairs: 4 })
  assert.deepEqual(calls.map(([role]) => role), ['implement', 'gates', 'review'])
  assert.equal(state.status, 'ready')
  assert.equal(state.repairs, 3)
  assert.equal(state.stages.filter(item => item.role === 'implement').length, 4)
  assert.deepEqual(state.stages.filter(item => item.role === 'review').map(item => item.result.verdict),
    ['changes_requested', 'changes_requested', 'changes_requested', 'passed'])
})

test('resume refuses a rejected review whose candidate changed afterwards', async () => {
  const state = newWorkflow({ mode: 'planned' })
  let digest = 'sha'
  await execute(state, async role => {
    if (role === 'review') { digest = 'mutated'; return { verdict: 'changes_requested' } }
    return role === 'plan' ? plan : role === 'gates' ? { passed: true } : {}
  }, { candidateDigest: async () => digest })
  digest = 'sha'
  await assert.rejects(resume(state, async () => ({ verdict: 'passed' }), { candidateDigest: async () => 'elsewhere', maxRepairs: 4 }),
    /candidate changed/)
})
