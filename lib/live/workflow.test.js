import test from 'node:test'
import assert from 'node:assert/strict'
import { newWorkflow, runWorkflow } from './workflow.js'
const plan = { acceptanceCriteria: [{ id: 'AC1' }] }
const execute = (state, invoke, extra = {}) => runWorkflow({ state, invoke, persist: async () => {}, candidateDigest: async () => 'sha', ...extra })
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
