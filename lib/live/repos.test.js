import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGates, normalizeRepo } from './repos.js'

test('an explicit empty gate list means no gates, a missing list gets the defaults', () => {
  // `[]` used to fall back to the standard gates, so "this repository runs no gates" was not configurable (review H17).
  assert.deepEqual(normalizeGates([], 'web'), [])
  assert.ok(normalizeGates(undefined, 'web').length > 0)
})
