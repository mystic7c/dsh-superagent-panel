import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, titleOf, riskOf, isContextMessage } from './eval.js'

const config = {
  octo: { watchChatIds: ['chat-1'], allowSenderIds: [], channelType: 2 },
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
  const restricted = { ...config, octo: { ...config.octo, allowSenderIds: ['user-9'] } }
  const result = evaluate(candidate(), restricted)
  assert.equal(result.kind, 'ignore')
  assert.equal(result.reason[0].code, 'senderNotAllowed')
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
