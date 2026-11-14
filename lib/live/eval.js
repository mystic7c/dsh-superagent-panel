/**
 * Rule-based evaluation for the pilot: decide whether an inbound Octo message becomes a Ticket, and with what
 * title/body. Deliberately deterministic and auditable — the first real run must be explainable in the panel.
 * An LLM assessment can be added behind `eval.mode='llm'` later without changing the intake contract.
 */

/** Rules shown in the panel's Eval page; ids are stable and stored on every Decision. */
export const EVAL_RULES = [
  { id: 'R1', name: '群内明确请求', description: '配置监听的群里，人类发送的文本消息视为明确请求，直接接单。' },
  { id: 'R2', name: '来源与身份过滤', description: '非文本、空消息、机器人自身、未在监听群或发送者白名单外的消息不接单。' },
  { id: 'R3', name: '高风险主题', description: '生产操作、EBS 基表 DML、合并/发版/打 tag、密钥等高风险请求不自动执行，转人工。' },
]

/**
 * Semantic version of the rule set. Bump it whenever a rule's *content* changes (a pattern, its order, its meaning),
 * not just its id: replay is idempotent per pipeline version, so without a bump a replay after a rule fix would
 * return the earlier Decision (and its ignore) instead of re-judging the signal with the fixed rules.
 */
const RULES_VERSION = 'rules-v2'

/**
 * Version of the rule pipeline that judged a Decision (P1 contract §2.2). It is derived from the rule set itself, so
 * a Decision re-judged by newer rules can be told apart from one produced by the current rules (which is what makes
 * replay idempotent: one replayed Decision per signal per pipeline version).
 */
export function pipelineVersion() {
  return `${RULES_VERSION}:${EVAL_RULES.map(rule => rule.id).join('+')}`
}

/** Reasons that name a filter: an unmatched rule with such a reason blocked the candidate (contract §2.2 verdicts). */
const IGNORE_EFFECT = /高风险|过滤/

/** Per-rule verdicts: the same rows as `rules`, plus the effect that rule applies (`accept`/`ignore`/`observe`). */
function verdictsOf(rules) {
  return (Array.isArray(rules) ? rules : []).map((rule) => {
    const matched = rule.matched === true
    const reason = String(rule.reason ?? '')
    return {
      id: rule.id,
      name: rule.name,
      matched,
      reason,
      effect: matched ? 'accept' : IGNORE_EFFECT.test(reason) ? 'ignore' : 'observe',
    }
  })
}

const RISK_PATTERNS = [
  // "prod"/"production" must be a whole token, never the prefix of an identifier: "Cux_Mtl_Sale_Products_Rpt" and
  // "PROD_ID" are object names, while "生产", "prod 环境", "PRODUCTION 库" and "eBS_prod" still mean production.
  // (\b alone would miss "eBS_prod": `_` counts as a word character, so there is no boundary before "prod".)
  /生产|(?<![A-Za-z])prod(?:uction)?(?![\w])/i,
  /\bDDL\b|\bDML\b|基表|drop\s+table|truncate/i,
  /合并到|merge\s+(request|branch)|发版|上线|发布|打\s*tag|push\s+to\s+(dev|main|master)/i,
  /密码|口令|token|密钥|secret|private\s*key/i,
]

const REQUEST_WORDS = /(请|帮我|麻烦|写|创建|新建|生成|修改|改|修复|实现|新增|删除|调整|优化|添加|补充|要求|需要|处理|开发|迁移|查一下|核对|验证|上线|部署)/i
const SQL_HEAD = /^(?:select|with|insert|update|delete|merge|create|alter|drop|begin|declare)\b/i

/**
 * A code/SQL snippet is context, not a task: it should not become its own Ticket. The next explicit request in the
 * same group gets this text prepended by the engine (so "依据这个 SQL…" still sees the SQL).
 */
export function isContextMessage(text) {
  const value = String(text ?? '').trim()
  if (!value) return false
  if (REQUEST_WORDS.test(value)) return false
  const unfenced = value.replace(/^```[a-z]*\s*/i, '').trim()
  if (/^```/.test(value)) return true
  if (SQL_HEAD.test(unfenced)) return true
  const sqlHits = (unfenced.match(/\b(select|from|where|join|left join|group by|order by|having|union|rownum|case when)\b/gi) ?? []).length
  return sqlHits >= 3
}

/** Extract a short ticket title from the first meaningful line. */
export function titleOf(text) {
  const first = String(text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
  const cleaned = first.replace(/^@\S+\s*/g, '').replace(/\s+/g, ' ').trim()
  return (cleaned || '未命名请求').slice(0, 160)
}

/** Human-readable first blocking risk, if any. */
export function riskOf(text) {
  const match = RISK_PATTERNS.find(pattern => pattern.test(String(text ?? '')))
  return match ? match.source : undefined
}

/**
 * Evaluate one normalized inbound event against the pilot rules.
 * @returns {{kind:'accept'|'ignore', reason:{code:string,values?:object}[], rules:{id:string,name:string,matched:boolean,reason:string}[]}}
 */
export function evaluate(candidate, config) {
  const text = String(candidate.text ?? '').trim()
  const watched = config.octo.watchChatIds.includes(candidate.channelId)
  // Precedence is explicit and shared with the poll guard: "any human" wins; otherwise the sender must be listed.
  // An empty list with "any human" off allows nobody, so a dry run cannot pretend a live poll would accept it.
  // Manual tickets are an operator action and bypass the sender gate, but keep R1–R3 (including high-risk).
  const allowAnyHuman = config.octo.allowAnyHuman === true
  const allowSenderIds = Array.isArray(config.octo.allowSenderIds) ? config.octo.allowSenderIds : []
  const senderAllowed = candidate.manual === true || allowAnyHuman || allowSenderIds.includes(candidate.fromUid)
  const rules = []
  const reason = []
  /** @type {(code: string, values?: any) => {kind: 'ignore', reason: any[], rules: any[]}} */
  const ignore = (code, values) => {
    reason.push(values ? { code, values } : { code })
    return { kind: 'ignore', reason, rules }
  }

  rules.push({ id: 'R2', name: '来源与身份过滤', matched: watched && senderAllowed && !!text, reason: '监听群内的人类文本消息' })
  if (!watched) return ignore('sourceNotWatched', { channel: candidate.channelId ?? 'unknown' })
  if (!senderAllowed) return ignore('senderNotAllowed', { sender: candidate.fromUid ?? 'unknown' })
  if (!text) return ignore('notText', { type: String(candidate.contentType ?? 'unknown') })

  const risk = riskOf(text)
  rules.push({ id: 'R3', name: '高风险主题', matched: !risk, reason: risk ? `命中高风险主题：${risk}` : '未命中生产/DDL/合并/密钥等高风险主题' })
  if (risk) return ignore('highRisk', { pattern: risk })

  if (isContextMessage(text)) {
    rules.push({ id: 'R1', name: '群内明确请求', matched: false, reason: '仅上下文，等待同一群里后续的明确请求' })
    return ignore('contextOnly', { kind: 'code' })
  }

  rules.push({ id: 'R1', name: '群内明确请求', matched: true, reason: '来自监听群的人类请求，按明确请求接单' })
  reason.push({ code: 'explicitRequest', values: { text: titleOf(text) } })
  return { kind: 'accept', reason, rules }
}

/** Build the domain records for one accepted candidate (trigger + thread + decision + ticket). */
export function buildRecords(candidate, evaluation, config, threadTitle) {
  const at = candidate.at ?? new Date().toISOString()
  const threadKey = `octo:${candidate.channelId}`
  const triggerId = candidate.triggerId
  const decisionId = candidate.decisionId
  const ticketId = candidate.ticketId
  const thread = { key: threadKey, source: 'octo', title: threadTitle || threadKey, createdAt: at, lastAt: at }
  const trigger = {
    id: triggerId, source: 'octo', at, threads: [threadKey], human: true,
    actor: { source: 'octo', id: candidate.fromUid ?? 'unknown', name: { zh: candidate.fromUid ?? '未知', en: candidate.fromUid ?? 'unknown' } },
    text: candidate.text, eventId: candidate.eventId, messageId: candidate.messageId, seq: candidate.seq,
    channel: { source: 'octo', thread: candidate.channelId, channelType: candidate.channelType,
      address: { channelId: candidate.channelId, channelType: candidate.channelType } },
    disposition: { decisionId, fanout: evaluation.kind === 'accept' ? [ticketId] : [], acked: [] },
  }
  const decision = {
    id: decisionId, threadKey, triggerIds: [triggerId], at, kind: evaluation.kind,
    ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
    reason: evaluation.reason, rules: evaluation.rules, verdicts: verdictsOf(evaluation.rules),
    strength: 'explicit', policyVersion: 'octo-pilot-v1',
    // P1 §2.2: which pipeline judged this, which raw signal it came from, and that a rule (not an LLM/replay) did it.
    pipelineVersion: pipelineVersion(), actorKind: 'rule',
    ...(candidate.signalId ? { signalId: candidate.signalId } : {}),
    ...(evaluation.kind === 'accept' ? { ticketId } : {}),
  }
  const ticket = evaluation.kind !== 'accept' ? undefined : {
    id: ticketId,
    // Which repository this Ticket targets. Legacy records without it fall back to the default repository.
    ...candidate.repoId ? { repoId: candidate.repoId } : {},
    title: titleOf(candidate.text),
    body: candidate.text,
    createdAt: at,
    updatedAt: at,
    source: 'octo',
    status: 'queued',
    stage: 'queued',
    scope: candidate.repoId ?? config.repos?.[0]?.id ?? '',
    baseBranch: config.baseBranch,
    targetBranch: config.gitlab.targetBranch,
    origin: { triggerId, decisionId, threadKey, eventId: candidate.eventId, messageId: candidate.messageId,
      channelId: candidate.channelId, channelType: candidate.channelType, actor: candidate.fromUid,
      reason: evaluation.reason },
    assignments: [],
    links: { branch: null, mergeRequest: null, pipeline: null },
    runId: null,
  }
  return { thread, trigger, decision, ticket }
}
