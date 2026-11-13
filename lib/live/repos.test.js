import test from 'node:test'
import assert from 'node:assert/strict'
import { workflowResumable } from './repos.js'

const review = (status, verdict, extra = {}) => ({ role: 'review', status, result: verdict ? { verdict } : undefined, ...extra })
const ticket = (stages, patch = {}) => ({ status: 'failed', workflow: { status: 'blocked', repairs: 2, stages }, ...patch })

test('a failed review is replayable without spending the repair budget', () => {
  assert.equal(workflowResumable(ticket([review('failed')]), 2), true)
})

test('a rejected review continues only when the repair budget was raised', () => {
  const rejected = ticket([review('completed', 'changes_requested')])
  assert.equal(workflowResumable(rejected, 2), false)
  assert.equal(workflowResumable(rejected, 4), true)
  assert.equal(workflowResumable(ticket([review('completed', 'changes_requested')], { workflow: { status: 'blocked', repairs: 3, stages: [review('completed', 'changes_requested')] } }), 4), true)
  assert.equal(workflowResumable(ticket([review('completed', 'changes_requested')], { workflow: { status: 'blocked', repairs: 4, stages: [review('completed', 'changes_requested')] } }), 4), false)
})

test('nothing else is resumable: a passed review, a working ticket or no workflow', () => {
  assert.equal(workflowResumable(ticket([review('completed', 'passed')]), 6), false)
  assert.equal(workflowResumable(ticket([review('completed', 'changes_requested')], { status: 'working' }), 6), false)
  assert.equal(workflowResumable({ status: 'failed' }, 6), false)
  assert.equal(workflowResumable(ticket([review('completed', 'changes_requested')], { workflow: { status: 'ready', repairs: 2, stages: [] } }), 6), false)
})
