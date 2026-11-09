import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseReviewCommand, isReviewCommand, newReviewCode, reviewNotification, reviewAck, reviewLabelOf,
  reviewScopeMatches, reviewAnswerable, REVIEW_CODE_LENGTH } from './reviews.js'

test('parseReviewCommand accepts both answer-first and code-first spellings', () => {
  assert.deepEqual(parseReviewCommand('接单 A7K2'), { answer: 'accept', code: 'A7K2' })
  assert.deepEqual(parseReviewCommand('忽略 A7K2'), { answer: 'ignore', code: 'A7K2' })
  assert.deepEqual(parseReviewCommand('A7K2 接单'), { answer: 'accept', code: 'A7K2' })
  assert.deepEqual(parseReviewCommand('a7k2 忽略'), { answer: 'ignore', code: 'A7K2' })
  assert.deepEqual(parseReviewCommand('接受 #A7K2'), { answer: 'accept', code: 'A7K2' })
  assert.deepEqual(parseReviewCommand('  跳过 a7k2  '), { answer: 'ignore', code: 'A7K2' })
  assert.deepEqual(parseReviewCommand('不接 A7K2'), { answer: 'ignore', code: 'A7K2' })
})

test('parseReviewCommand ignores normal chat and malformed codes', () => {
  assert.equal(parseReviewCommand('接单这事我看看'), undefined)
  assert.equal(parseReviewCommand('接单 A12'), undefined)      // 3-char code
  assert.equal(parseReviewCommand('接单 A7K2X'), undefined)    // 5-char code
  assert.equal(parseReviewCommand('这个需求看着像工单'), undefined)
  assert.equal(parseReviewCommand(''), undefined)
  assert.equal(isReviewCommand('接单 A7K2'), true)
  assert.equal(isReviewCommand('收到'), false)
})

test('newReviewCode is uppercase, unambiguous and unique against taken codes', () => {
  const code = newReviewCode()
  assert.equal(code.length, REVIEW_CODE_LENGTH)
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/)
  const taken = new Set(['AAAA'])
  const next = newReviewCode(taken)
  assert.notEqual(next, 'AAAA')
})

const record = over => ({
  code: 'A7K2', textPreview: '修复：收款单保存时校验银行账户必填', ruleKind: 'accept', ruleCodes: ['explicitRequest'],
  ...(over ?? {}),
})

test('reviewNotification carries the verdict, the model opinion and the reply instruction', () => {
  const accepted = reviewNotification(record({ ticketId: 'tkt_1' }), { executor: { autoRun: false } })
  assert.match(accepted, /Superagent: 评估 #A7K2/)
  assert.match(accepted, /消息：修复：收款单保存时校验银行账户必填/)
  assert.match(accepted, /规则：接单/)
  assert.match(accepted, /模型：未调用/)
  assert.match(accepted, /工单：tkt_1（已排队，等你确认后执行）/)
  assert.match(accepted, /回复「接单 A7K2」或「忽略 A7K2」/)

  const vetoed = reviewNotification(record({ ruleKind: 'ignore', ruleCodes: ['modelSkip'],
    model: { status: 'ok', category: 'chat', p: 0.12, riskP: 0.01, verdict: 'reject' } }))
  assert.match(vetoed, /规则：忽略（modelSkip）/)
  assert.match(vetoed, /模型：chat p=0.12 risk=0.01 → 建议忽略/)
})

test('reviewAck explains what happened to the Ticket', () => {
  assert.match(reviewAck(record(), 'accept', { ticketId: 'tkt_1', started: true }), /已接单；工单 tkt_1 已开始执行/)
  assert.match(reviewAck(record(), 'accept', { ticketId: 'tkt_1', started: false }), /已接单；工单 tkt_1 已建单/)
  assert.match(reviewAck(record(), 'ignore', { ticketId: 'tkt_1', dismissed: true }), /已忽略；工单 tkt_1 已撤销/)
  assert.match(reviewAck(record(), 'accept', { blocked: 'high-risk' }), /规则判定高风险/)
  assert.match(reviewAck(record(), 'ignore', { blocked: 'not-allowed' }), /只允许指定操作人/)
  assert.match(reviewAck(record(), 'accept', { recordedOnly: true }), /意见已记录/)
  assert.match(reviewAck(record(), 'ignore', { recordedOnly: true, reviewed: 'correct' }), /已写入信号标签 correct/)
})

test('reviewLabelOf maps the operator answer onto the signal label vocabulary', () => {
  assert.equal(reviewLabelOf('accept', 'accept'), 'correct')
  assert.equal(reviewLabelOf('accept', 'ignore'), 'false_wake')
  assert.equal(reviewLabelOf('ignore', 'accept'), 'missed_wake')
  assert.equal(reviewLabelOf('ignore', 'ignore'), 'correct')
})

test('reviewScopeMatches narrows to model vetoes and uncertainty', () => {
  assert.equal(reviewScopeMatches(record(), 'all'), true)
  assert.equal(reviewScopeMatches(record(), 'uncertain'), false)
  assert.equal(reviewScopeMatches(record({ ruleKind: 'ignore', ruleCodes: ['modelSkip'] }), 'uncertain'), true)
  assert.equal(reviewScopeMatches(record({ ruleCodes: ['explicitRequest'], modelVerdict: 'reject' }), 'uncertain'), true)
})

test('reviewAnswerable handles answered/expired rows', () => {
  const now = new Date('2026-11-09T10:00:00Z')
  assert.equal(reviewAnswerable({ status: 'sent', expiresAt: '2026-11-10T10:00:00Z' }, now), true)
  assert.equal(reviewAnswerable({ status: 'answered', expiresAt: '2026-11-10T10:00:00Z' }, now), false)
  assert.equal(reviewAnswerable({ status: 'expired', expiresAt: '2026-11-10T10:00:00Z' }, now), false)
  assert.equal(reviewAnswerable({ status: 'sent', expiresAt: '2026-11-09T09:00:00Z' }, now), false)
})
