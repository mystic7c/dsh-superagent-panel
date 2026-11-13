import test from 'node:test'
import assert from 'node:assert/strict'
import { REVIEW_JSON_MARKER, reviewJsonFormatProvider, registerReviewJsonMode } from './review-json.js'

const reviewBody = (extra = {}) => ({ messages: [
  { role: 'system', content: 'You review a change.' },
  { role: 'user', content: `Assess the change. ${REVIEW_JSON_MARKER}` },
], ...extra })

test('review json mode only touches verdict requests, never normal turns', () => {
  assert.equal(reviewJsonFormatProvider.prepare({ body: { messages: [{ role: 'user', content: 'hello' }] } }), undefined)
  assert.deepEqual(reviewJsonFormatProvider.prepare({ body: reviewBody() }), { value: { type: 'json_object' } })
})

test('review json mode waits until the reviewer has seen a tool result', () => {
  // First exploration turn: the model must be free to call read/grep before answering, so JSON mode stays off.
  const tools = [{ type: 'function', function: { name: 'read' } }]
  assert.equal(reviewJsonFormatProvider.prepare({ body: reviewBody({ tools }) }), undefined)
  const withResult = reviewBody({ tools, messages: [
    { role: 'user', content: `Assess the change. ${REVIEW_JSON_MARKER}` },
    { role: 'tool', content: 'file contents' },
  ] })
  assert.deepEqual(reviewJsonFormatProvider.prepare({ body: withResult }), { value: { type: 'json_object' } })
})

test('review json mode registers response_format on the DeepSeek extension registry', () => {
  const calls = []
  const ctx = { get: name => name === 'deepseekLlmApiExtensions' ? { register: (...args) => calls.push(args) } : undefined }
  assert.equal(registerReviewJsonMode(ctx), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'response_format')
  assert.equal(calls[0][1], reviewJsonFormatProvider)
  // A host without the registry (another provider, older Harness) must not break the review.
  assert.equal(registerReviewJsonMode({ get: () => undefined }), false)
  assert.equal(registerReviewJsonMode({ get: () => ({ register: () => { throw new Error('boom') } }) }, () => {}), false)
})
