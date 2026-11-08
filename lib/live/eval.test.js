import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, titleOf, riskOf, isContextMessage, buildRecords, pipelineVersion, EVAL_RULES } from './eval.js'

const config = {
  octo: { watchChatIds: ['chat-1'], allowSenderIds: [], allowAnyHuman: true, channelType: 2 },
  gitlab: { targetBranch: 'dev' },
  baseBranch: 'dev',
}

const candidate = (over = {}) => ({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
  text: '修复：收款单保存时校验银行账户必填', eventId: 10, messageId: 20, at: '2026-11-04T03:00:00.000Z', ...over })

test('R1 accepts a human text message in a watched chat', () => {
  const result = evaluate(candidate(), config)
  assert.equal(result.kind, 'accept')
  assert.equal(result.rules.find(rule => rule.id === 'R1').matched, true)
  assert.deepEqual(result.reason[0].code, 'explicitRequest')
})

test('R2 ignores chats outside the watch list', () => {
  const result = evaluate(candidate({ channelId: 'chat-2' }), config)
  assert.equal(result.kind, 'ignore')
  assert.equal(result.reason[0].code, 'sourceNotWatched')
})

test('R2 ignores a sender outside the allow list when one is configured', () => {
  const restricted = { ...config, octo: { ...config.octo, allowSenderIds: ['user-9'], allowAnyHuman: false } }
  const result = evaluate(candidate(), restricted)
  assert.equal(result.kind, 'ignore')
  assert.equal(result.reason[0].code, 'senderNotAllowed')
})

test('allowAnyHuman wins over a non-empty sender list; an empty list with it off allows nobody', () => {
  const any = { ...config, octo: { ...config.octo, allowSenderIds: ['user-9'], allowAnyHuman: true } }
  assert.equal(evaluate(candidate({ fromUid: 'stranger' }), any).kind, 'accept')
  const closed = { ...config, octo: { ...config.octo, allowSenderIds: [], allowAnyHuman: false } }
  assert.equal(evaluate(candidate({ fromUid: 'stranger' }), closed).reason[0].code, 'senderNotAllowed')
})

test('manual tickets bypass the sender gate but keep the risk rules', () => {
  const closed = { ...config, octo: { ...config.octo, allowSenderIds: ['user-9'], allowAnyHuman: false } }
  assert.equal(evaluate(candidate({ manual: true }), closed).kind, 'accept')
  assert.equal(evaluate(candidate({ manual: true, text: '执行生产 DDL 并合并到 dev' }), closed).reason[0].code, 'highRisk')
})

test('R2 ignores empty and non-text messages', () => {
  assert.equal(evaluate(candidate({ text: '   ' }), config).reason[0].code, 'notText')
  assert.equal(evaluate(candidate({ contentType: 2, text: '' }), config).reason[0].code, 'notText')
})

test('R3 blocks high-risk requests with a stable reason', () => {
  for (const text of ['执行生产 DDL 并合并到 dev', '把 deploy 的密码发我', '发版并打 tag', 'update AP_INVOICES_ALL 基表']) {
    const result = evaluate(candidate({ text }), config)
    assert.equal(result.kind, 'ignore', text)
    assert.equal(result.reason[0].code, 'highRisk', text)
  }
})

test('R3 lets a normal fix through', () => {
  assert.equal(riskOf('修复收款单银行账户必填校验'), undefined)
  assert.equal(evaluate(candidate({ text: '修复收款单银行账户必填校验' }), config).kind, 'accept')
})

test('R3 matches prod/production as words, never inside an object name', () => {
  // Regression: /prod(uction)?/ without boundaries blocked Cux_Mtl_Sale_Products_Rpt as "production".
  for (const text of ['Cux_Mtl_Sale_Products_Rpt 数据传 BI', 'plsql/packages/apps/CUX_MTL_SALE_PRODUCTS_RPT.pkb',
    '新增 procedure Main_Bi', '查询 PRODUCT_ID / PROD_ID 两列']) {
    assert.equal(riskOf(text), undefined, text)
    assert.equal(evaluate(candidate({ text }), config).kind, 'accept', text)
  }
  for (const text of ['在 prod 环境执行 DDL', 'PRODUCTION 库发版', '生产库操作', 'prod环境', '连接 eBS_prod 库']) {
    assert.equal(evaluate(candidate({ text }), config).reason[0].code, 'highRisk', text)
  }
})

test('titleOf strips mentions, takes the first line and caps length', () => {
  assert.equal(titleOf('@DSH_BOT 修复：银行账户必填\n更多细节'), '修复：银行账户必填')
  assert.equal(titleOf('\n\n  '), '未命名请求')
  assert.equal(titleOf('a'.repeat(100)).length, 64)
})

test('SQL/code snippets become context, while explicit requests and risky SQL still behave', () => {
  const sql = 'SELECT Gcc.Segment1 公司,\n       Hou.Name 公司名称,\n       Gjh.Period_Name 期间\nFROM GL_JE_HEADERS Gjh'
  const context = evaluate(candidate({ text: sql }), config)
  assert.equal(context.kind, 'ignore')
  assert.equal(context.reason[0].code, 'contextOnly')
  assert.equal(context.rules.find(rule => rule.id === 'R1').matched, false)
  assert.equal(isContextMessage(sql), true)
  assert.equal(isContextMessage('```sql\nselect 1 from dual\n```'), true)
  assert.equal(isContextMessage('依据这个SQL，写一个视图。要求：字段名用英文'), false)
  assert.equal(evaluate(candidate({ text: '依据这个SQL，写一个视图。要求：字段名用英文' }), config).kind, 'accept')
  // Risky DML stays highRisk (it must not be silently absorbed as harmless context).
  assert.equal(evaluate(candidate({ text: 'update AP_INVOICES_ALL 基表' }), config).reason[0].code, 'highRisk')
})

// ---------------------------------------------------------------------------
// P1 §2.2: decisions are versioned and carry per-rule verdicts, the raw signal id and the acting rule set.
// ---------------------------------------------------------------------------

const builtCandidate = (over = {}) => ({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
  text: '修复：收款单保存时校验银行账户必填', eventId: 10, messageId: 20, at: '2026-11-04T03:00:00.000Z',
  triggerId: 'trg_1', decisionId: 'dec_1', ticketId: 'tkt_1', signalId: 'sig_1', ...over })

test('pipelineVersion is stable and derived from the rule ids', () => {
  const version = pipelineVersion()
  assert.match(version, /^rules-v2/)
  assert.equal(version, pipelineVersion())
  for (const rule of EVAL_RULES) assert.ok(version.includes(rule.id), version)
})

test('buildRecords versioned decision: rules, verdicts, signalId and actorKind', () => {
  const candidate = builtCandidate()
  const built = buildRecords(candidate, evaluate(candidate, config), config)
  const { decision } = built
  assert.equal(decision.kind, 'accept')
  assert.equal(decision.actorKind, 'rule')
  assert.equal(decision.signalId, 'sig_1')
  assert.equal(decision.pipelineVersion, pipelineVersion())
  // The legacy `rules` array is preserved next to the new verdicts.
  assert.deepEqual(decision.rules.map(rule => rule.id), ['R2', 'R3', 'R1'])
  assert.deepEqual(decision.verdicts.map(verdict => verdict.id), decision.rules.map(rule => rule.id))
  for (const verdict of decision.verdicts) {
    assert.deepEqual(Object.keys(verdict).sort(), ['effect', 'id', 'matched', 'name', 'reason'])
    assert.ok(['accept', 'ignore', 'observe'].includes(verdict.effect))
  }
  const verdictOf = (result, ruleId) => result.decision.verdicts.find(verdict => verdict.id === ruleId)
  assert.equal(verdictOf(built, 'R1').effect, 'accept')
  assert.equal(verdictOf(built, 'R2').effect, 'accept')
  // A high-risk request: R3 blocks (effect ignore), R1 never runs.
  const risky = builtCandidate({ text: '执行生产 DDL 并合并到 dev' })
  const riskBuilt = buildRecords(risky, evaluate(risky, config), config)
  assert.equal(riskBuilt.decision.kind, 'ignore')
  assert.equal(verdictOf(riskBuilt, 'R3').effect, 'ignore')
  // Context-only snippets stay an observation (R1 unmatched, nothing blocked).
  const context = builtCandidate({ text: 'SELECT 1 FROM dual\nFROM GL_JE_HEADERS\nJOIN GL_JE_LINES ON 1=1\nWHERE period = 1' })
  const contextBuilt = buildRecords(context, evaluate(context, config), config)
  assert.equal(verdictOf(contextBuilt, 'R1').effect, 'observe')
})

test('buildRecords only sets signalId when the caller has one (manual tickets have no raw signal)', () => {
  const manual = builtCandidate({ signalId: undefined })
  const built = buildRecords(manual, evaluate(manual, config), config)
  assert.equal('signalId' in built.decision, false)
  assert.equal(built.decision.actorKind, 'rule')
})
