import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyWorkType, enabledBackends, effectiveRouting, resolveRoute, capabilityGap,
  profileOf, deliverableOf, DEFAULT_PREFERENCES, WORK_TYPES } from './routing.js'

const baseConfig = overrides => ({
  enabled: true,
  executor: { enabled: true, workerBackend: 'dsh', ...overrides },
})

const ticketOf = (title, body = '') => ({ id: 'tkt_route', title, body, status: 'queued' })

test('classifyWorkType maps the operator vocabulary to work types', () => {
  assert.equal(classifyWorkType(ticketOf('需求分析：梳理收款单校验影响面')), 'analysis')
  assert.equal(classifyWorkType(ticketOf('功能测试验证：回归保存流程')), 'test')
  assert.equal(classifyWorkType(ticketOf('代码 review：检查审批流改动')), 'review')
  assert.equal(classifyWorkType(ticketOf('浏览器调研：看下新版 GitLab 的 API')), 'research')
  assert.equal(classifyWorkType(ticketOf('文档：补充 README 中的部署说明')), 'docs')
  assert.equal(classifyWorkType(ticketOf('修复：保存收款单时校验银行账户必填')), 'dev')
  // No keyword at all is development work, the common case.
  assert.equal(classifyWorkType(ticketOf('处理一下')), 'dev')
  // Research wins over a test word in the same sentence: network capability dominates the pipeline choice.
  assert.equal(classifyWorkType(ticketOf('调研并验证这个页面')), 'research')
})

test('profile and deliverable follow the work type', () => {
  for (const type of WORK_TYPES) {
    assert.equal(profileOf(type), ['analysis', 'review', 'research', 'interactive'].includes(type) ? 'read-only' : 'write')
    assert.equal(deliverableOf(type), ['analysis', 'review', 'research', 'interactive'].includes(type) ? 'report' : 'change')
  }
})

test('legacy single backend stays the only enabled backend', () => {
  assert.deepEqual(enabledBackends(baseConfig()), ['dsh'])
  assert.deepEqual(enabledBackends(baseConfig({ workerBackend: 'codex' })), ['codex'])
  assert.deepEqual(enabledBackends(baseConfig({ workers: { codex: { enabled: true }, claude: { enabled: true } } }))
    .sort(), ['claude', 'codex'])
  // All-disabled workers fall back to the legacy backend so the engine never has zero backends.
  assert.deepEqual(enabledBackends(baseConfig({ workers: { dsh: { enabled: false } } })), ['dsh'])
})

test('effective routing defaults: one backend is single, several suggest', () => {
  const single = effectiveRouting(baseConfig())
  assert.equal(single.mode, 'single')
  assert.equal(single.defaultBackend, 'dsh')
  assert.deepEqual(single.fallback, [])
  assert.deepEqual(single.preferences, DEFAULT_PREFERENCES)

  const multi = effectiveRouting(baseConfig({ workers: { dsh: {}, codex: {}, claude: {} },
    workerBackend: 'claude' }))
  assert.equal(multi.mode, 'suggest')
  assert.equal(multi.defaultBackend, 'claude')

  const explicit = effectiveRouting(baseConfig({ workers: { dsh: {}, codex: {} },
    routing: { mode: 'auto', defaultBackend: 'dsh', fallback: ['dsh', 'dsh'],
      preferences: [{ workTypes: ['test'], backend: 'codex' }] } }))
  assert.equal(explicit.mode, 'auto')
  assert.deepEqual(explicit.fallback, [])
  assert.deepEqual(explicit.preferences, [{ workTypes: ['test'], backend: 'codex' }])
})

test('auto routing applies the preference and records why', () => {
  const route = resolveRoute({ ticket: ticketOf('功能测试验证：回归保存流程'), config: baseConfig({
    workers: { dsh: {}, codex: {}, claude: {} }, routing: { mode: 'auto', defaultBackend: 'dsh' } }) })
  assert.equal(route.workType, 'test')
  assert.equal(route.profile, 'write')
  assert.equal(route.deliverable, 'change')
  assert.equal(route.backend, 'codex')
  assert.equal(route.applied, true)
  assert.deepEqual(route.reason, { code: 'preference', workType: 'test' })
  assert.equal(route.execBackend, 'codex')
  assert.equal(route.execProfile, 'write')
  assert.equal(route.unsupported, undefined)
})

test('suggest routing records the choice but keeps the default backend', () => {
  const route = resolveRoute({ ticket: ticketOf('实现：新增收款单页面'), config: baseConfig({
    workers: { dsh: {}, codex: {}, claude: {} }, routing: { mode: 'suggest', defaultBackend: 'dsh' } }) })
  assert.equal(route.workType, 'dev')
  assert.equal(route.backend, 'claude')
  assert.equal(route.applied, false)
  assert.equal(route.execBackend, 'dsh')
  assert.equal(route.execProfile, 'write')
})

test('capability constraints pick a backend that can do the work', () => {
  // Research needs the host web tools, so a Claude-only setup can only fall back to DSH.
  const research = resolveRoute({ ticket: ticketOf('浏览器调研：查最新版本'), config: baseConfig({
    workers: { claude: {}, dsh: {} }, routing: { mode: 'auto', defaultBackend: 'claude' } }) })
  assert.equal(research.backend, 'dsh')
  // Interactive work needs the report/question tools: only DSH has them.
  const interactive = resolveRoute({ ticket: ticketOf('需要确认：先讨论一下方案'), config: baseConfig({
    workers: { codex: {}, dsh: {} }, routing: { mode: 'auto', defaultBackend: 'codex' } }) })
  assert.equal(interactive.backend, 'dsh')
  // A test run needs command execution, so Claude is never chosen even when the default says so.
  const testRoute = resolveRoute({ ticket: ticketOf('测试：跑一遍单测'), config: baseConfig({
    workers: { claude: {} }, routing: { mode: 'auto', defaultBackend: 'claude' } }) })
  assert.equal(testRoute.backend, 'claude')
  assert.equal(testRoute.unsupported, 'missing-exec')
  assert.equal(capabilityGap('claude', 'test'), 'missing-exec')
})

test('manual override wins and is recorded as manual', () => {
  const route = resolveRoute({ ticket: ticketOf('修复：保存校验'), config: baseConfig({
    workers: { dsh: {}, codex: {}, claude: {} }, routing: { mode: 'auto', defaultBackend: 'dsh' } }),
  override: 'claude' })
  assert.equal(route.backend, 'claude')
  assert.deepEqual(route.reason, { code: 'manual' })
  assert.equal(route.mode, 'manual')
  assert.equal(route.applied, true)
  // An override naming a disabled backend is ignored; routing decides.
  const ignored = resolveRoute({ ticket: ticketOf('修复：保存校验'), config: baseConfig({
    workers: { dsh: {} }, routing: { mode: 'auto', defaultBackend: 'dsh' } }), override: 'claude' })
  assert.equal(ignored.backend, 'dsh')
})
