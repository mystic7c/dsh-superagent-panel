import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeGates, normalizeRepo } from './repos.js'

test('an explicit empty gate list means no gates, a missing list gets the defaults', () => {
  // `[]` used to fall back to the standard gates, so "this repository runs no gates" was not configurable (review H17).
  assert.deepEqual(normalizeGates([], 'web'), [])
  assert.ok(normalizeGates(undefined, 'web').length > 0)
})

test('an old repositories[].workerPreset is ignored, not carried into the normalized repo', () => {
  // The per-repository preset was removed with executor.workerPreset in 1.4.0; only a Bot may name a preset now.
  const repo = normalizeRepo({ id: 'web-app', repo: '/tmp/web-app', workerPreset: 'creator' }, {}, 0)
  assert.equal(repo.id, 'web-app')
  assert.equal(repo.workerPreset, undefined)
})
