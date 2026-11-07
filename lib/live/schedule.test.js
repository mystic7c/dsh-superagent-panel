import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeAutomation, nextRunAt, nextDailyAt, isDue, describeAutomation } from './schedule.js'

const at = (iso) => Date.parse(iso)

test('normalizeAutomation keeps a valid heartbeat and computes the next run', () => {
  const { automation, error } = normalizeAutomation({ mode: 'heartbeat', enabled: true, intervalMinutes: 30 }, {}, at('2026-11-07T10:00:00+08:00'))
  assert.equal(error, undefined)
  assert.equal(automation.mode, 'heartbeat')
  assert.equal(automation.enabled, true)
  assert.equal(automation.intervalMinutes, 30)
  assert.equal(automation.nextAt, new Date(at('2026-11-07T10:00:00+08:00') + 30 * 60_000).toISOString())
})

test('normalizeAutomation clamps an out-of-range interval instead of throwing', () => {
  const { automation } = normalizeAutomation({ mode: 'heartbeat', enabled: true, intervalMinutes: 1 }, {})
  assert.equal(automation.intervalMinutes, 10)
  const { automation: huge } = normalizeAutomation({ mode: 'heartbeat', enabled: true, intervalMinutes: 99999 }, {})
  assert.equal(huge.intervalMinutes, 24 * 60)
})

test('nextDailyAt picks today when the clock time is still ahead and tomorrow otherwise', () => {
  const from = at('2026-11-07T09:00:00+08:00')
  const today = nextDailyAt('10:30', from)
  assert.equal(today, new Date(at('2026-11-07T10:30:00+08:00')).toISOString())
  const tomorrow = nextDailyAt('08:00', from)
  assert.equal(tomorrow, new Date(at('2026-11-08T08:00:00+08:00')).toISOString())
})

test('normalizeAutomation rejects a bad daily time with a message but keeps a usable default', () => {
  const { automation, error } = normalizeAutomation({ mode: 'schedule', enabled: true, at: '25:99' }, {})
  assert.match(error, /HH:mm/)
  assert.equal(automation.at, '09:00')
})

test('off/disabled never has a next run; isDue only fires at/after nextAt', () => {
  const off = normalizeAutomation({ mode: 'off', enabled: true }, {}).automation
  assert.equal(off.enabled, false)
  assert.equal(off.nextAt, undefined)
  const heartbeat = normalizeAutomation({ mode: 'heartbeat', enabled: true, intervalMinutes: 10 }, {}, at('2026-11-07T10:00:00+08:00')).automation
  assert.equal(isDue(heartbeat, at('2026-11-07T10:09:59+08:00')), false)
  assert.equal(isDue(heartbeat, at('2026-11-07T10:10:00+08:00')), true)
  assert.equal(nextRunAt(off), undefined)
})

test('an explicit null maxExecutions clears a previously stored cap', () => {
  const current = normalizeAutomation({ mode: 'heartbeat', enabled: true, intervalMinutes: 30, maxExecutions: 5 }, {}).automation
  assert.equal(current.maxExecutions, 5)
  const cleared = normalizeAutomation({ maxExecutions: null }, current).automation
  assert.equal(cleared.maxExecutions, undefined)
  const kept = normalizeAutomation({ intervalMinutes: 40 }, current).automation
  assert.equal(kept.maxExecutions, 5)
})

test('describeAutomation and maxExecutions round-trip', () => {
  const { automation } = normalizeAutomation({ mode: 'heartbeat', enabled: true, intervalMinutes: 120, maxExecutions: 3 }, { executions: 1 })
  assert.equal(automation.maxExecutions, 3)
  assert.equal(automation.executions, 1)
  assert.equal(describeAutomation(automation), '每 2 小时')
  assert.equal(describeAutomation(normalizeAutomation({ mode: 'schedule', enabled: true, at: '08:30' }, {}).automation), '每天 08:30')
})
