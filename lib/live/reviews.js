/**
 * Evaluation review prompt (group-confirmation loop).
 *
 * Every evaluated candidate (accepted, ignored by the rules, or vetoed by the model) becomes one short review
 * message in its source group: "回复「接单 A12」或「忽略 A12」". The operator's reply is the ground truth for the
 * intake policy: it is mapped onto the existing signal labels (correct / false_wake / missed_wake) and stored on the
 * Decision as `humanReview`, so the rule/model comparison keeps getting better data.
 *
 * This module is pure: code generation, command parsing, notification/ack text, label mapping. Engine state changes
 * (create review, apply answer) stay in engine.js.
 */

/** Alphabet omits 0/O/1/I so a code read from a phone is unambiguous. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export const REVIEW_CODE_LENGTH = 4

/** Answer words accepted from the operator (both orders: "接单 A12" and "A12 接单"). */
const ACCEPT_WORDS = '接单|接受|开单|通过|做'
const IGNORE_WORDS = '忽略|不接|不做|跳过|不要'
const CODE = `[${CODE_ALPHABET}]{${REVIEW_CODE_LENGTH}}`
const CODE_RE = new RegExp(CODE)
const COMMAND_RE = new RegExp(
  `^\\s*(?:[#＃]?(${CODE})\\s*(${ACCEPT_WORDS}|${IGNORE_WORDS})|(${ACCEPT_WORDS}|${IGNORE_WORDS})\\s*[#＃]?(${CODE}))\\s*$`, 'i')

/**
 * Parse one operator reply. → { answer:'accept'|'ignore', code } | undefined
 * Only an exact command shape is accepted; normal chat ("接单这事我看看") must keep flowing as a normal message.
 */
export function parseReviewCommand(text) {
  const value = String(text ?? '').trim()
  if (!value) return undefined
  const match = COMMAND_RE.exec(value)
  if (!match) return undefined
  const code = (match[1] ?? match[4] ?? '').toUpperCase()
  if (!CODE_RE.test(code)) return undefined
  const word = (match[2] ?? match[3] ?? '').trim()
  const answer = new RegExp(`^(${ACCEPT_WORDS})$`, 'i').test(word) ? 'accept' : 'ignore'
  return { answer, code }
}

/** True when the text looks like a review command (used to keep command chatter out of normal intake). */
export function isReviewCommand(text) {
  return parseReviewCommand(text) !== undefined
}

/** A fresh short code that does not collide with any code still present in the review map. */
export function newReviewCode(taken = new Set()) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    let code = ''
    for (let i = 0; i < REVIEW_CODE_LENGTH; i += 1) {
      code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
    }
    if (!taken.has(code)) return code
  }
  throw new Error('review code space exhausted')
}

const clampText = (value, max) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** One short line for the model side of a notification. */
function modelTextOf(model) {
  if (!model) return '未调用'
  if (model.status === 'error') return '调用失败'
  if (model.status !== 'ok') return '未调用'
  const probability = typeof model.p === 'number' ? `p=${model.p.toFixed(2)}` : 'p=?'
  const risk = typeof model.riskP === 'number' ? ` risk=${model.riskP.toFixed(2)}` : ''
  const verdict = model.verdict === 'accept' ? '建议接单' : model.verdict === 'reject' ? '建议忽略' : '不确定'
  return `${model.category ?? '?'} ${probability}${risk} → ${verdict}`
}

/** One short line for the rules side of a notification. */
function ruleTextOf(record) {
  if (record.ruleKind === 'accept') return '接单'
  const codes = Array.isArray(record.ruleCodes) ? record.ruleCodes : []
  return `忽略（${codes.join(' / ') || '过滤'}）`
}

/** The exact group message a review prompt sends. */
export function reviewNotification(record, config = {}) {
  const lines = [`Superagent: 评估 #${record.code}`, `消息：${record.textPreview}`]
  lines.push(`规则：${ruleTextOf(record)} · 模型：${modelTextOf(record.model)}`)
  if (record.ticketId) {
    lines.push(config?.executor?.autoRun === true
      ? `工单：${record.ticketId}（已按原规则自动执行）`
      : `工单：${record.ticketId}（已排队，等你确认后执行）`)
  }
  lines.push(`回复「接单 ${record.code}」或「忽略 ${record.code}」`)
  return lines.join('\n')
}

/** The confirmation message sent after an operator answer was applied. */
export function reviewAck(record, answer, outcome = {}) {
  const head = `${record.code} ${answer === 'accept' ? '已接单' : '已忽略'}`
  const details = []
  if (outcome.ticketId && answer === 'accept') details.push(`工单 ${outcome.ticketId}${outcome.started ? ' 已开始执行' : ' 已建单'}`)
  if (outcome.dismissed) details.push(`工单 ${outcome.ticketId} 已撤销`)
  if (outcome.blocked === 'high-risk') details.push('规则判定高风险，未自动建单，请人工处理')
  if (outcome.blocked === 'running') details.push('工单已在执行/已合入，无法撤销，意见已记录')
  if (outcome.blocked === 'not-allowed') details.push('只允许指定操作人回复确认')
  if (outcome.blocked === 'expired') details.push('该评估已过期')
  if (outcome.blocked === 'cleanup') details.push('撤销时清理工作树失败，请到面板处理')
  if (outcome.recordedOnly) details.push('意见已记录，等待你在面板处理')
  if (outcome.reviewed) details.push(`已写入信号标签 ${outcome.reviewed}`)
  return `Superagent: ${head}${details.length ? `；${details.join('；')}` : ''}`
}

/**
 * Map one operator answer onto the existing signal-label vocabulary.
 * engineKind: the decision kind the rules produced (accept = opened a Ticket, ignore = nothing done).
 */
export function reviewLabelOf(engineKind, answer) {
  if (engineKind === 'accept') return answer === 'accept' ? 'correct' : 'false_wake'
  return answer === 'accept' ? 'missed_wake' : 'correct'
}

/** Review rows that should be asked under the configured scope. */
export function reviewScopeMatches(record, scope = 'all') {
  if (scope !== 'uncertain') return true
  const codes = Array.isArray(record.ruleCodes) ? record.ruleCodes
    : Array.isArray(record.reasonCodes) ? record.reasonCodes : []
  return codes.some(code => String(code).startsWith('model')) || record.modelVerdict === 'reject'
}

/** Whether a stored review is still answerable. */
export function reviewAnswerable(record, now = new Date()) {
  if (!record || record.status === 'answered') return false
  if (record.status === 'expired') return false
  const expires = Date.parse(record.expiresAt ?? '')
  return !Number.isFinite(expires) || expires > now.getTime()
}
