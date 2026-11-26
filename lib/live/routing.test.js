import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classifyIntent, classifyWorkType, enabledBackends, effectiveRouting, resolveRoute,
  botOf, deliverableOf, WORK_TYPES, CAPABILITIES } from './routing.js'

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

test('bot and deliverable follow the work type', () => {
  for (const type of WORK_TYPES) {
    assert.equal(botOf(type), ['analysis', 'review', 'research', 'interactive'].includes(type) ? 'read-only' : 'write')
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

test('effective routing keeps the enabled default backend and dedupes the fallback order', () => {
  const single = effectiveRouting(baseConfig())
  assert.equal(single.defaultBackend, 'dsh')
  assert.deepEqual(single.fallback, [])

  const multi = effectiveRouting(baseConfig({ workers: { dsh: {}, codex: {}, claude: {} },
    workerBackend: 'claude' }))
  assert.equal(multi.defaultBackend, 'claude')

  const explicit = effectiveRouting(baseConfig({ workers: { dsh: {}, codex: {} },
    routing: { defaultBackend: 'dsh', fallback: ['dsh', 'dsh'] } }))
  assert.equal(explicit.defaultBackend, 'dsh')
  assert.deepEqual(explicit.fallback, [])
})

test('routing applies the default backend and records why', () => {
  const route = resolveRoute({ ticket: ticketOf('功能测试验证：回归保存流程'), config: baseConfig({
    workers: { dsh: {}, codex: {}, claude: {} }, routing: { defaultBackend: 'codex' } }) })
  assert.equal(route.workType, 'test')
  assert.equal(route.bot, 'write')
  assert.equal(route.deliverable, 'change')
  assert.equal(route.backend, 'codex')
  assert.equal(route.applied, true)
  assert.equal(route.mode, 'default')
  assert.deepEqual(route.reason, { code: 'default' })
  assert.equal(route.execBackend, 'codex')
  assert.equal(route.execProfile, 'write')
  // 1.5.0: routing has no capability gating, so a route never carries an `unsupported` refusal.
  assert.equal('unsupported' in route, false)
})

test('a legacy routing mode and preference table is ignored, never honoured', () => {
  // The mode (single/suggest/auto) and the work-type preference table were removed in 1.4.0; an old live.json that
  // still carries them must load and route on the default backend alone.
  const route = resolveRoute({ ticket: ticketOf('实现：新增收款单页面'), config: baseConfig({
    workers: { dsh: {}, codex: {}, claude: {} },
    routing: { mode: 'suggest', defaultBackend: 'dsh',
      preferences: [{ workTypes: ['dev'], backend: 'claude' }] } }) })
  assert.equal(route.workType, 'dev')
  assert.equal(route.backend, 'dsh')
  assert.equal(route.execBackend, 'dsh')
  assert.equal(route.mode, 'default')
  assert.deepEqual(route.reason, { code: 'default' })
})

test('capability gating is gone: the required list is informational only', () => {
  // 1.5.0: the executing backend comes from the dispatched Bot, so routing no longer refuses a backend for a
  // missing capability. CAPABILITIES survives only as the preview's informational list.
  assert.deepEqual(CAPABILITIES, ['edit', 'exec', 'web'])
  const route = resolveRoute({ ticket: ticketOf('测试：跑一遍单测'), config: baseConfig() })
  assert.deepEqual(route.capabilities, ['edit', 'exec'])
  assert.equal('unsupported' in route, false)
  // An override naming a backend that is not enabled is ignored, and the reason stays a routing default.
  const ignored = resolveRoute({ ticket: ticketOf('测试：跑一遍单测'), config: baseConfig(), override: 'nope' })
  assert.equal(ignored.backend, 'dsh')
  assert.deepEqual(ignored.reason, { code: 'default' })
})

test('manual override wins and is recorded as manual', () => {
  const route = resolveRoute({ ticket: ticketOf('修复：保存校验'), config: baseConfig({
    workers: { dsh: {}, codex: {}, claude: {} }, routing: { defaultBackend: 'dsh' } }),
  override: 'claude' })
  assert.equal(route.backend, 'claude')
  assert.deepEqual(route.reason, { code: 'manual' })
  assert.equal(route.mode, 'manual')
  assert.equal(route.applied, true)
  assert.equal(route.execBackend, 'claude')
  // An override naming a disabled backend is ignored; routing decides.
  const ignored = resolveRoute({ ticket: ticketOf('修复：保存校验'), config: baseConfig({
    workers: { dsh: {} }, routing: { defaultBackend: 'dsh' } }), override: 'claude' })
  assert.equal(ignored.backend, 'dsh')
})

test('a manual backend override stands and is recorded as manual', () => {
  // Review AC-01: a manual choice must stand. 1.5.0 dropped the capability model, so the route only records the
  // operator's choice — the dispatched Bot decides the executing backend later.
  const route = resolveRoute({ ticket: ticketOf('修复网页登录问题，需要联网查文档'), config: baseConfig({
    workers: { claude: {}, dsh: {} }, routing: { defaultBackend: 'dsh' } }), override: 'claude' })
  assert.equal(route.backend, 'claude')
  assert.equal(route.execBackend, 'claude')
  assert.equal(route.mode, 'manual')
  assert.deepEqual(route.reason, { code: 'manual' })
  assert.equal(route.applied, true)
  assert.equal('unsupported' in route, false)

  // The same research work on codex is a plain manual run too.
  const codex = resolveRoute({ ticket: ticketOf('修复网页登录问题，需要联网查文档'), config: baseConfig({
    workers: { codex: {}, dsh: {} }, routing: { defaultBackend: 'dsh' } }), override: 'codex' })
  assert.equal(codex.backend, 'codex')
  assert.deepEqual(codex.reason, { code: 'manual' })
})

test('mixed intent keeps an explicit change request a code change', () => {
  // The three misclassifications from docs/product-review-2026-11.md: an analysis or research word must not
  // downgrade a Ticket that explicitly asks for a fix or an implementation.
  const fixWithTest = classifyIntent(ticketOf('修复网页登录失败并补测试'))
  assert.equal(fixWithTest.deliverable, 'change')
  assert.equal(fixWithTest.workType, 'dev')
  assert.equal(fixWithTest.bot, 'write')
  assert.deepEqual(fixWithTest.capabilities, ['edit', 'exec'])

  const implementSearch = classifyIntent(ticketOf('实现搜索功能'))
  assert.equal(implementSearch.deliverable, 'change')
  assert.equal(implementSearch.workType, 'dev')

  const fixAfterAnalysis = classifyIntent(ticketOf('修复订单保存问题，先分析原因'))
  assert.equal(fixAfterAnalysis.deliverable, 'change')
  assert.equal(fixAfterAnalysis.workType, 'dev')
  assert.equal(fixAfterAnalysis.explicitReadOnly, false)

  // An explicit web lookup is a capability, not a work type: the fix still edits files and needs the network.
  const fixWithWeb = classifyIntent(ticketOf('修复网页登录问题，需要联网查文档'))
  assert.equal(fixWithWeb.deliverable, 'change')
  assert.deepEqual(fixWithWeb.capabilities, ['edit', 'web'])
  // Both backends can carry the web requirement now, so the configured default keeps the Ticket.
  const routed = resolveRoute({ ticket: ticketOf('修复网页登录问题，需要联网查文档'), config: baseConfig({
    workers: { dsh: {}, claude: {} }, routing: { defaultBackend: 'claude' } }) })
  assert.equal(routed.backend, 'claude')
  assert.equal('unsupported' in routed, false)
})

test('explicit read-only stays a report even when a change word appears', () => {
  const readOnly = classifyIntent(ticketOf('修复方案：分析登录失败，不要修改代码'))
  assert.equal(readOnly.explicitReadOnly, true)
  assert.equal(readOnly.deliverable, 'report')
  assert.equal(readOnly.bot, 'read-only')
  assert.equal(readOnly.capabilities.includes('edit'), false)
  // A read-only report does not need the report tool: returning the final text is enough.
  assert.equal(readOnly.capabilities.includes('report'), false)
})

test('a quoted or noun use of 只读 does not turn a development Ticket read-only', () => {
  // Regression (ticket tkt_e3c4b7ce8ddd4399): the body quoted "只有一次 EBS 只读、不得再加第二次" as the stale wording
  // to unify, and that bare 只读 pinned a BI-02 implementation request to a report. Only a read-only *activity* counts.
  const quoted = classifyIntent(ticketOf('BI-00 收尾', '外币规则已修正，但 freeze.md 仍写“只有一次 EBS 只读、不得再加第二次”，'
    + '与当前保存路径的本位币查询冲突，需要统一；继续完成 BI-02'))
  assert.equal(quoted.explicitReadOnly, false)
  assert.equal(quoted.deliverable, 'change')
  assert.equal(quoted.workType, 'dev')
  assert.equal(quoted.bot, 'write')

  // A read-only input box or a --verify read-only check are feature nouns, not analysis requests.
  const input = classifyIntent(ticketOf('自建只读输入框并接入表单'))
  assert.equal(input.explicitReadOnly, false)
  assert.equal(input.deliverable, 'change')
  const verify = classifyIntent(ticketOf('新增 --verify 只读检查选项'))
  assert.equal(verify.explicitReadOnly, false)
  assert.equal(verify.deliverable, 'change')
  const mode = classifyIntent(ticketOf('新增只读模式开关'))
  assert.equal(mode.explicitReadOnly, false)
  assert.equal(mode.deliverable, 'change')

  // The real read-only phrasings still pin a report.
  for (const text of ['只读分析：检查登录失败原因', '本次只读，看看日志', '只读梳理 README 结构', '请做 read-only review']) {
    const intent = classifyIntent(ticketOf(text))
    assert.equal(intent.explicitReadOnly, true, text)
    assert.equal(intent.deliverable, 'report', text)
  }
})

test('an explicit read-only request stays read-only on the routed backend', () => {
  // Regression (review P1 AC-01): routing must never turn an explicit "只分析，不修改代码" Ticket into a write run,
  // even though the route is now always applied.
  const route = resolveRoute({ ticket: ticketOf('只分析，不修改代码：检查登录失败原因'), config: baseConfig() })
  assert.equal(route.deliverable, 'report')
  assert.equal(route.applied, true)
  assert.equal(route.execBackend, 'dsh')
  assert.equal(route.execProfile, 'read-only')
  // A change request is still a write run.
  const change = resolveRoute({ ticket: ticketOf('修复登录失败'), config: baseConfig() })
  assert.equal(change.execProfile, 'write')
})

test('a deliverable can be overridden by hand while the route stays read-only', () => {
  const report = resolveRoute({ ticket: ticketOf('实现：新增收款单页面'), config: baseConfig({
    workers: { dsh: {}, claude: {} }, routing: { defaultBackend: 'dsh' } }),
  deliverableOverride: 'report' })
  assert.equal(report.deliverable, 'report')
  assert.equal(report.bot, 'read-only')
  assert.equal(report.execProfile, 'read-only')
  assert.equal(report.applied, true)
  assert.equal(report.mode, 'manual')
  assert.deepEqual(report.reason, { code: 'manual', deliverable: 'report' })

  // The capabilities stay informational under a manual deliverable; nothing gates the route on them.
  const claudeOnly = resolveRoute({ ticket: ticketOf('实现搜索功能，需要联网查文档'), config: baseConfig({
    workers: { claude: {} }, routing: { defaultBackend: 'claude' } }) })
  assert.equal(claudeOnly.backend, 'claude')
  assert.deepEqual(claudeOnly.capabilities, ['edit', 'web'])
  assert.equal('unsupported' in claudeOnly, false)
})
