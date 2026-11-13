/**
 * The live engine: reads watched Octo conversations, turns human requests into Triggers/Decisions/Tickets, persists
 * cursors, and exposes a status surface for the panel plus a manual poll for dry runs.
 *
 * Two intake modes:
 * - `sync` (default for groups): pull the newest messages of each watched group and dedupe by message_seq. Group/thread
 *   events do not carry a channel id on this deployment, so message sync is the reliable channel-scoped source.
 * - `events`: the bot event queue; kept for deployments whose events do carry channel fields.
 *
 * Execution is owned by `executor.js`; this module only owns intake and evaluation.
 */
import { loadLiveConfig, redactedLiveConfig } from './config.js'
import { addRepoDefinition, updateRepoDefinition, listLiveConfigHistory, restoreLiveConfig, saveOctoToken as writeOctoToken } from './live-json.js'
import { LiveState, recordId } from './state.js'
import { InboxStore } from './inbox.js'
import { evaluate, buildRecords, EVAL_RULES, pipelineVersion } from './eval.js'
import { createSystemOneJudge, shadowOf, shadowErrorOf, verdictOf, JUDGE_QUESTIONS_VERSION } from './judge.js'
import { parseReviewCommand, newReviewCode, reviewNotification, reviewAck, reviewLabelOf, reviewScopeMatches,
  reviewAnswerable } from './reviews.js'
import { SignalStore } from './signals.js'
import { OperationStore, summarizeRun } from './operations.js'
import { AcceptanceStore } from './acceptance.js'
import { EvidenceStore } from './evidence.js'
import { appendActivity, activitiesOf } from './activities.js'
import { workerBrief } from './executor.js'
import { resolveRoute, routePreview as routePreviewOf, DELIVERABLES } from './routing.js'
import { repoOf, repoToken, repoSummary, ticketRepo, decorateTicket, configRepos } from './repos.js'
import { removeWorktree, deleteRemoteBranch } from './repo.js'
import { worktreeDiff } from './diff.js'
import { normalizeAutomation, nextRunAt, isDue, describeAutomation } from './schedule.js'
import { preview } from '../util.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_EVENTS = 100
/** One revision request is bounded so a pasted document cannot bloat the state document. */
const REVISION_MAX = 4000
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Ticket status → the five panel stage groups (contract §4). `pushed` is an in-flight state of the executor
 * (branch pushed, MR URL not observed yet), so it belongs with `working`; anything unknown stays visible there
 * instead of silently disappearing from every group.
 */
const STAGE_OF_STATUS = {
  queued: 'queued', ready: 'queued',
  working: 'working', merged: 'working', 'ci-pending': 'working', 'deploy-pending': 'working', pushed: 'working',
  deployed: 'waiting', 'mr-open': 'waiting', 'ci-passed': 'waiting',
  // P0-3: a parked gate blocks delivery and belongs to the attention group, not to "working".
  'gate-blocked': 'waiting',
  failed: 'failed', 'ci-failed': 'failed', 'deploy-failed': 'failed',
  closed: 'done',
  dismissed: 'done',
}
const STAGES = ['queued', 'working', 'waiting', 'failed', 'done']
const stageOf = status => STAGE_OF_STATUS[status] ?? 'working'
/** A person accepted a deployed Ticket on UAT; it leaves the "waiting for a human" queue but keeps its deploy record. */
const acceptedOf = ticket => ticket?.links?.acceptance?.ok === true

// ---------------------------------------------------------------------------
// Actionable inbox (P0 contract §1.4): five derived kinds, frozen dedupe keys.
// ---------------------------------------------------------------------------
const INBOX_PRIORITY_RANK = { urgent: 0, high: 1, normal: 2, info: 3 }
const ACCEPT_STATUSES = ['deployed', 'mr-open', 'ci-passed']
const FAILURE_STATUSES = ['failed', 'ci-failed', 'deploy-failed']

const DECISION_KINDS = ['accept', 'reopen', 'stop', 'ignore', 'unavailable']

/** Human text for the filter codes the rules engine writes on an ignored decision (contract §4 octo.filtered). */
const FILTER_REASON_TEXT = {
  contextOnly: '代码/SQL 片段（保存为后续请求的上下文）',
  highRisk: '命中高风险主题（生产 / DDL / 合并 / 密钥）',
  sourceNotWatched: '不在监听群',
  senderNotAllowed: '发送者不在允许名单',
  notText: '不是文本消息',
  // hybrid mode: the model gated a rule-accepted message. Every one of these stays replayable from the sources page
  // (replay re-runs the rules and is the operator's manual override).
  modelSkip: '模型判定不是仓库/工作区任务',
  modelRisk: '模型判定为高风险，转人工',
  modelUncertain: '模型判定不确定，转人工',
}

const CONTEXT_WINDOW_MS = 10 * 60 * 1000

// P1 §1/§2: bounds and enums shared by the raw-signal log and the acceptance ledger.
const SIGNAL_TEXT_MAX = 2000
const SIGNAL_STATUSES = ['pending', 'processed', 'ignored', 'skipped', 'failed']
const REPLAYABLE_SIGNAL_STATUSES = ['skipped', 'ignored', 'failed']
const ACCEPTANCE_INTENTS = ['unmet', 'new-idea', 'no-evidence']

// P2 §1.2: the Ticket automation scheduler ticks on its own short clock (independent of the Octo poll cadence).
const SCHEDULE_TICK_MS = 15_000
// P2 §2.3: an automatic verification may wake at most this many times for one MR head commit.
const MAX_AUTO_VERIFY = 3
// P2 §3.1: the human quality labels and their bounds.
const SIGNAL_LABELS = ['correct', 'false_wake', 'missed_wake', 'cleared']
const MAX_SIGNAL_LABELS = 50
const LABEL_COUNTS_WINDOW = 1000
const SIGNAL_NOTE_MAX = 300

// P2-9 run-quality rollup: frozen classification sets and bounds from the p2c contract §1.
const METRICS_WINDOWS = { '24h': DAY_MS, '7d': 7 * DAY_MS }
const METRICS_FAILED_STOP_REASONS = new Set(['error', 'timeout', 'worker_failed', 'no_changes', 'gate_failed',
  'prepare_failed', 'bootstrap_failed', 'guard_failed', 'commit_failed', 'push_failed', 'mr_failed'])
const METRICS_LEGACY_FAILED_STATUSES = new Set(['failed', 'ci-failed', 'deploy-failed'])
const METRICS_ERROR_MAX = 120
const METRICS_FAILURE_LIMIT = 5
const METRICS_COST_NOTE = '宿主未提供 token/成本数据'

/** Collapse whitespace and clip a human message for grouped failure reasons. */
function clipReason(value, max = METRICS_ERROR_MAX) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Nearest-rank percentile over an ascending array (0 for an empty one). */
function percentileOf(sorted, fraction) {
  if (!sorted.length) return 0
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))
  return sorted[index]
}

/** One run category (p2c §1), legacy rows included: no stopReason falls back to the status set. */
function runCategoryOf(run) {
  const stopReason = run?.stopReason
  if (stopReason === 'done') return 'succeeded'
  if (METRICS_FAILED_STOP_REASONS.has(stopReason)) return 'failed'
  if (stopReason === 'stopped') return 'stopped'
  if (stopReason === 'interrupted') return 'interrupted'
  if (stopReason === 'waiting_for_human') return 'parked'
  if (run?.status === 'running') return 'running'
  // Legacy runs have no stopReason at all; an unknown reason also falls back to the status rather than disappearing.
  return METRICS_LEGACY_FAILED_STATUSES.has(run?.status) ? 'failed' : 'succeeded'
}

/**
 * Stable external id for one source event (P1 §2.1): `octo` / `<chatId>:<messageId>` with the event id as the
 * fallback when a message has no message id. It is the dedupe key of the signal log, so it must be stable across polls.
 */
function signalExternalId({ channelId, messageId, eventId, seq, at }) {
  const scope = channelId !== undefined && channelId !== null && channelId !== '' ? String(channelId) : 'unknown'
  const ref = messageId ?? eventId ?? seq ?? at
  const tail = ref !== undefined && ref !== null && ref !== '' ? String(ref) : `unknown-${Date.now()}`
  return `${scope}:${tail}`
}

/** First filter code of a decision's reason list (what the panel shows as `skipReason` for an ignored signal). */
function decisionCodeOf(decision) {
  if (!Array.isArray(decision?.reason)) return undefined
  return decision.reason.find(item => item && typeof item.code === 'string' && item.code)?.code
}

const inWindow = (value, since) => typeof value === 'string' && value >= since

/** Latest ISO timestamp out of an array, or undefined when there is none. */
function latestOf(values) {
  let best
  for (const value of values) if (typeof value === 'string' && (!best || value > best)) best = value
  return best
}

/** Trigger/decision/ticket counts inside the 24h window (contract §4 flow24h). */
/**
 * Rule ledger for the overview: how many judged messages each policy rule passed in the 24h window. Computed from the
 * full decision store (the status payload only carries the latest 20 decisions), so the panel never undercounts.
 * → { judged, rules: [{ name, hits }] } (rules sorted by hits, then name).
 */
function rules24hOf(state, windowStart) {
  const counts = new Map()
  let judged = 0
  for (const decision of Object.values(state.decisions ?? {})) {
    if (!inWindow(decision.at, windowStart)) continue
    judged += 1
    for (const rule of Array.isArray(decision.rules) ? decision.rules : []) {
      const name = rule.name ?? rule.id
      if (!name) continue
      const entry = counts.get(name) ?? { hits: 0, blocked: 0 }
      if (rule.matched) entry.hits += 1
      else entry.blocked += 1
      counts.set(name, entry)
    }
  }
  // Interception-first: a rule that blocked something is the interesting row; ties fall back to pass volume.
  return { judged, rules: [...counts.entries()].map(([name, entry]) => ({ name, hits: entry.hits, blocked: entry.blocked }))
    .sort((left, right) => right.blocked - left.blocked || right.hits - left.hits
      || String(left.name).localeCompare(String(right.name))) }
}

function flowOf(state, windowStart) {
  const triggers = Object.values(state.triggers ?? {}).filter(trigger => inWindow(trigger.at, windowStart))
  const decisions = Object.values(state.decisions ?? {}).filter(decision => inWindow(decision.at, windowStart))
  const tickets = Object.values(state.tickets ?? {}).filter(ticket => inWindow(ticket.createdAt, windowStart))
  const accepted = decisions.filter(decision => decision.kind === 'accept').length
  const filtered = decisions.filter(decision => decision.kind === 'ignore').length
  // Outbound failures: the executor records `replyError` on a run when the Octo reply could not be sent.
  const dropped = (state.runs ?? []).filter(run => inWindow(run.startedAt, windowStart) && run.replyError).length
  return { windowStart, received: triggers.length, filtered, judged: decisions.length, accepted,
    tickets: tickets.length, dropped }
}

/** Ignored decisions in the window joined with the trigger text that was filtered out (contract §4 `sources[].filtered`). */
function filteredMessagesOf(state, windowStart) {
  return Object.values(state.decisions ?? {})
    .filter(decision => decision.kind === 'ignore' && inWindow(decision.at, windowStart))
    .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
    .slice(0, 20)
    .map(decision => {
      const triggerId = decision.triggerIds?.[0]
      const trigger = triggerId ? state.triggers?.[triggerId] : undefined
      const reason = Array.isArray(decision.reason) ? decision.reason[0] : undefined
      const code = reason?.code ?? 'unknown'
      return {
        id: trigger?.id ?? triggerId ?? decision.id,
        at: trigger?.at ?? decision.at,
        text: String(trigger?.text ?? ''),
        reasonCode: code,
        reason: FILTER_REASON_TEXT[code] ?? code,
        threadKey: decision.threadKey,
        decisionId: decision.id,
      }
    })
}

/** State of the Octo intake: off when live.json is disabled, error when it cannot poll, ready after a successful poll. */
function octoStatusOf(loaded, stored) {
  if (loaded.error) return { state: 'error', detail: loaded.error }
  if (!loaded.exists) return { state: 'off', detail: '配置文件缺失' }
  if (!loaded.config.enabled) return { state: 'off', detail: '自动触发未启用' }
  if (!loaded.tokens?.octo) return { state: 'error', detail: 'Octo token 未配置' }
  if (stored?.state === 'error') return { state: 'error', detail: stored.detail ?? '轮询失败' }
  return { state: stored?.state === 'ready' ? 'ready' : 'idle', ...(stored?.detail ? { detail: stored.detail } : {}) }
}

/** Execution-surface state for one repository: idle until the executor is on, error when MR creation has no token. */
function repoStatusOf(loaded, config, repo) {
  if (loaded.error) return { state: 'error', detail: loaded.error }
  if (!config.executor.enabled) return { state: 'idle', detail: '执行器未启用' }
  if (repo.gitlab.createMr === 'api' && !repoToken(loaded, repo)) {
    return { state: 'error', detail: `${repo.name} 的 GitLab token 未配置` }
  }
  return { state: 'ready' }
}

/** The source registry the panel renders (contract §4/§12: Octo plus one execution card per repository). */
function sourceStatuses(loaded, state, flow) {
  const config = loaded.config
  const repos = configRepos(config)
  const tickets = Object.values(state.tickets ?? {})
  const octo = octoStatusOf(loaded, state.sources?.octo)
  const octoCard = {
    id: 'octo',
    kind: 'source',
    title: { zh: 'Octo 群消息', en: 'Octo group' },
    state: octo.state,
    ...(octo.detail ? { detail: octo.detail } : {}),
    ...(state.sources?.octo?.at ? { lastAt: state.sources.octo.at } : {}),
    enabled: Boolean(config.enabled),
    config: {
      watchChatIds: config.octo.watchChatIds,
      chatTitles: config.octo.chatTitles,
      allowAnyHuman: config.octo.allowAnyHuman,
      allowSenderIds: config.octo.allowSenderIds,
      chatRepos: config.octo.chatRepos ?? {},
      defaultRepo: config.defaultRepo,
    },
    stats: { received: flow.received, filtered: flow.filtered, accepted: flow.accepted },
    filtered: filteredMessagesOf(state, flow.windowStart),
  }
  const repoCards = repos.map(repo => {
    const own = tickets.filter(ticket => ticketRepo(config, ticket)?.id === repo.id)
    const status = repoStatusOf(loaded, config, repo)
    const tokenConfigured = Boolean(repoToken(loaded, repo))
    const lastAt = latestOf(own.flatMap(ticket => [
      ticket.links?.verification?.at, ticket.links?.deployment?.uat?.checkedAt]))
    return {
      id: `gitlab:${repo.id}`,
      kind: 'execution',
      repoId: repo.id,
      title: { zh: repo.name, en: repo.name },
      state: status.state,
      ...(status.detail ? { detail: status.detail } : {}),
      ...(lastAt ? { lastAt } : {}),
      enabled: Boolean(config.executor.enabled),
      config: {
        project: repo.gitlab.project,
        baseUrl: repo.gitlab.baseUrl,
        targetBranch: repo.gitlab.targetBranch,
        tokenConfigured,
        ...repo.gitlab.uatUrl ? { uatUrl: repo.gitlab.uatUrl } : {},
        verifyMode: repo.verifyMode,
        acceptance: repo.acceptance,
      },
      stats: {
        tickets: own.length,
        mrOpen: own.filter(ticket => ['mr-open', 'ci-pending', 'ci-passed'].includes(ticket.status)).length,
        deployed: own.filter(ticket => ticket.status === 'deployed').length,
        failed: own.filter(ticket => stageOf(ticket.status) === 'failed').length,
      },
    }
  })
  return [octoCard, ...repoCards]
}

/** Stage used by counts and views: accepted tickets are done; manual repos wait for a person after the merge. */
function ticketStageOf(config, ticket) {
  if (ticket.links?.acceptance?.ok === true) return 'done'
  const repo = ticketRepo(config, ticket)
  if (repo?.acceptance === 'merged' && ticket.status === 'merged') return 'waiting'
  return stageOf(ticket.status)
}

/** The most recently created ticket: ticketOrder is creation order, so the last live id wins. */
function latestTicketOf(state) {
  const order = Array.isArray(state.ticketOrder) ? state.ticketOrder : []
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const ticket = state.tickets?.[order[index]]
    if (ticket) return ticket
  }
  return Object.values(state.tickets ?? {}).sort((left, right) =>
    String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))[0]
}

/** Last non-empty line of a gate's captured output, clipped for an inbox summary (contract §1.4). */
function lastLineOf(value, max = 160) {
  const lines = String(value ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  return preview(lines.at(-1) ?? '', max)
}

/** The repository of a ticket, or undefined for an absent/partial config: inbox derivation must never throw. */
function safeRepoOf(config, ticket) {
  if (!config || typeof config !== 'object' || (!config.gitlab && !Array.isArray(config.repos))) return undefined
  try { return ticketRepo(config, ticket) } catch { return undefined }
}

/** Latest run of one ticket (newest startedAt), used when a ticket does not name its current run. */
function latestRunOf(runs, ticket) {
  return runs.filter(run => run.ticketId === ticket.id)
    .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))[0]
}

/**
 * Derive the desired inbox from the live document (P0 contract §1.4). Pure: no writes, no throws on empty state or
 * a missing config. The six kinds and their dedupe keys are the contract: gate / accept / publish / failure / source /
 * engine (`publish` was added for a finished dry run whose next step — publishing the MR — needs a person).
 */
export function deriveInboxItems({ state, loaded, lastError, now = new Date().toISOString() } = {}) {
  const doc = state && typeof state === 'object' ? state : {}
  const config = loaded?.config
  const runs = Array.isArray(doc.runs) ? doc.runs : []
  const items = []
  for (const ticket of Object.values(doc.tickets ?? {})) {
    if (!ticket || typeof ticket !== 'object') continue
    const ticketId = ticket.id
    if (!ticketId) continue
    const title = String(ticket.title ?? ticketId)
    const repo = safeRepoOf(config, ticket)
    const run = (ticket.runId ? runs.find(candidate => candidate.id === ticket.runId) : undefined) ?? latestRunOf(runs, ticket)
    const runId = ticket.runId ?? run?.id
    const gate = ticket.pendingGate
    if (ticket.status === 'gate-blocked' && gate) {
      items.push({
        kind: 'gate',
        blocking: true,
        priority: 'urgent',
        title: `闸门 ${gate.name ?? ''} 未通过，等待你处理`,
        summary: lastLineOf(gate.outputTail),
        refs: { ticketId, ...(runId ? { runId } : {}) },
        dedupeKey: `gate:${ticketId}:${runId ?? 'none'}`,
      })
    }
    const acceptsMerged = repo?.acceptance === 'merged' && ticket.status === 'merged'
    if ((ACCEPT_STATUSES.includes(ticket.status) || acceptsMerged) && ticket.links?.acceptance?.ok !== true) {
      items.push({
        kind: 'accept',
        blocking: true,
        priority: 'normal',
        title: `工单「${title}」等待验收`,
        summary: [repo?.name ?? ticket.repoId, ticket.status].filter(Boolean).join(' · '),
        refs: { ticketId, ...(repo?.id ? { repoId: repo.id } : {}) },
        dedupeKey: `accept:${ticketId}`,
      })
    }
    // A dry run that finished is a human decision point, not a settled Ticket: without this item the overview desk
    // stayed silent while the only next step (publish the MR) lived on the execution page.
    if (ticket.status === 'ready' && ticket.links?.acceptance?.ok !== true
      && run?.dryRun === true && run?.status === 'dry-run') {
      items.push({
        kind: 'publish',
        blocking: true,
        priority: 'normal',
        title: `工单「${title}」干跑完成，等待你确认发布`,
        summary: [repo?.name ?? ticket.repoId].filter(Boolean).join(' · '),
        refs: { ticketId, ...(runId ? { runId } : {}) },
        dedupeKey: `publish:${ticketId}:${runId ?? 'none'}`,
      })
    }
    // A lost worker fails the run but keeps the Ticket retryable (`ready`, same worktree). It still needs a failure
    // item so the desk sees why the run died instead of waiting for a retry that nobody knows about.
    const workerLost = run?.stopReason === 'worker_lost' || run?.errorCode === 'worker_lost'
    if (FAILURE_STATUSES.includes(ticket.status) || (workerLost && ticket.status === 'ready')) {
      items.push({
        kind: 'failure',
        blocking: false,
        priority: 'normal',
        title: workerLost && ticket.status === 'ready' ? `工单「${title}」worker 失联，可重试` : `工单「${title}」执行失败`,
        summary: preview(run?.error ?? '', 160),
        refs: { ticketId, ...(runId ? { runId } : {}) },
        dedupeKey: `failure:${ticketId}:${runId ?? 'none'}`,
      })
    }
  }
  // Broken sources come from the same registry the panel renders (`status().sources`), so the two never disagree.
  let sources = []
  try {
    if (loaded && config && (config.gitlab || Array.isArray(config.repos))) {
      sources = sourceStatuses({ config, tokens: loaded.tokens ?? {} }, doc, flowOf(doc, new Date(Date.now() - DAY_MS).toISOString()))
    }
  } catch { sources = [] }
  for (const source of sources) {
    if (!source || source.enabled === false || source.state !== 'error') continue
    const name = typeof source.title === 'string' ? source.title : source.title?.zh ?? source.title?.en ?? source.id
    items.push({
      kind: 'source',
      blocking: false,
      priority: 'high',
      title: `${name} 来源异常`,
      summary: preview(source.detail ?? '', 160),
      refs: { ...(source.repoId ? { repoId: source.repoId } : {}), sourceId: source.id },
      dedupeKey: `source:${source.id}`,
    })
  }
  if (typeof lastError === 'string' && lastError.trim()) {
    items.push({
      kind: 'engine',
      blocking: false,
      priority: 'high',
      title: '引擎错误',
      summary: preview(lastError, 160),
      refs: {},
      dedupeKey: 'engine:last',
    })
  }
  return items
}

function idsOf() {
  return { triggerId: recordId('trg'), decisionId: recordId('dec'), ticketId: recordId('tkt') }
}

/** A candidate message from the event queue, after source filtering. */
function candidateOf(event, config) {
  const channelId = event.channelId
  if (channelId === undefined || channelId === null || channelId === '') return { skip: 'channel-missing' }
  const channelText = String(channelId)
  if (!config.octo.watchChatIds.includes(channelText)) return { skip: 'chat-not-watched' }
  return {
    eventId: event.eventId,
    messageId: event.messageId,
    seq: event.seq,
    fromUid: event.fromUid,
    channelId: channelText,
    channelType: typeof event.channelType === 'number' ? event.channelType : config.octo.channelType,
    contentType: event.contentType,
    text: event.text ?? '',
    at: event.at,
    threadTitle: config.octo.chatTitles?.[channelText],
    repoId: config.octo.chatRepos?.[channelText] ?? config.defaultRepo,
    ...idsOf(),
  }
}

/** A candidate message from one message-sync row (exported for the shadow-sample collector). */
export function candidateOfSync(message, config) {
  const channelId = message.channelId
  if (!channelId) return { skip: 'channel-missing' }
  const channelText = String(channelId)
  if (!config.octo.watchChatIds.includes(channelText)) return { skip: 'chat-not-watched' }
  if (!message.fromUid) return { skip: 'system-message' }
  if (message.contentType !== 1) return { skip: 'not-text' }
  if (config.octo.botUid && message.fromUid === config.octo.botUid) return { skip: 'bot-self' }
  // Octo robot accounts end with `_bot`; a group may contain other bots besides ours, and none should open tickets.
  if (/_bot$/.test(message.fromUid)) return { skip: 'bot-sender' }
  const prefix = config.octo.replyPrefix
  if (prefix && String(message.text ?? '').trim().startsWith(prefix)) return { skip: 'self-reply' }
  return {
    eventId: undefined,
    messageId: message.messageId,
    seq: message.messageSeq,
    fromUid: message.fromUid,
    channelId: channelText,
    channelType: Number.isFinite(message.channelType) ? message.channelType : config.octo.channelType,
    contentType: message.contentType,
    text: message.text ?? '',
    at: message.at,
    threadTitle: config.octo.chatTitles?.[channelText],
    repoId: config.octo.chatRepos?.[channelText] ?? config.defaultRepo,
    ...idsOf(),
  }
}

/** A disabled repository keeps its history but receives no new Tickets (intake filters here, dispatch in autoExecute). */
function repoAcceptsWork(config, repoId) {
  return repoOf(config, repoId)?.enabled !== false
}

/** Merge one record set into the engine document. */
function absorb(doc, records) {
  doc.threads = doc.threads ?? {}
  doc.triggers = doc.triggers ?? {}
  doc.decisions = doc.decisions ?? {}
  doc.tickets = doc.tickets ?? {}
  doc.ticketOrder = doc.ticketOrder ?? []
  for (const record of records) {
    const existing = doc.threads[record.thread.key]
    if (existing) existing.lastAt = record.thread.lastAt
    else doc.threads[record.thread.key] = record.thread
    doc.triggers[record.trigger.id] = record.trigger
    doc.decisions[record.decision.id] = record.decision
    if (record.ticket) {
      doc.tickets[record.ticket.id] = record.ticket
      doc.ticketOrder.push(record.ticket.id)
      // P1 §5: the activity log starts at creation, so every later status/run/gate row has a "where it began".
      appendActivity(record.ticket, {
        kind: 'created', actorKind: 'system', to: record.ticket.status,
        detail: `由 ${record.trigger?.source ?? '来源'} 请求创建：${preview(record.trigger?.text ?? record.ticket.title, 120)}`,
        refs: { triggerId: record.trigger?.id, decisionId: record.decision?.id },
      })
    }
  }
}

export class Engine {
  /**
   * @param {object} options
   * @param {string} options.stateDir
   * @param {(line:string)=>void} options.log
   * @param {object} [options.ctx] host context (agents service, logger) used by auto-run workers
   * @param {object} [options.deps] injection seam for tests: { loadConfig, createClient }
   */
  constructor({ stateDir, log, ctx, deps = {} }) {
    this.stateDir = stateDir
    // Host context is required by the DSH worker (agents service); auto-run must carry it exactly like manual runs.
    this.ctx = ctx
    this.log = log ?? (() => {})
    this.deps = deps
    this.state = new LiveState(stateDir)
    this.inbox = new InboxStore(stateDir)
    // P1 stores: the raw signal log, the full operation ledger and the acceptance rounds. The executor writes the
    // latter two through these instances (the engine only creates/loads them and owns the human-facing views).
    this.signals = new SignalStore(stateDir)
    this.operations = new OperationStore(stateDir)
    this.acceptance = new AcceptanceStore(stateDir)
    this.evidence = new EvidenceStore(stateDir)
    this.client = undefined
    this.clientToken = undefined
    this.timer = undefined
    this.verifyTimer = undefined
    this.scheduleTimer = undefined
    this.dispatchQueue = undefined
    this.polling = false
    // Shadow-mode decision model (judge.js): in-memory counters for the status surface. The per-decision answer is
    // persisted on `decision.shadow`; nothing here influences intake.
    this.judgeStats = { calls: 0, ok: 0, errors: 0, skipped: 0, lastAt: undefined, lastLatencyMs: undefined, lastError: undefined }
    // hybrid-mode counters (the model sits in the intake path, not after it): judged candidates + rule fallbacks.
    this.hybridStats = { calls: 0, fallbacks: 0 }
    // The reason shadow mode cannot call the model, logged once per transition instead of once per poll.
    this.judgeDisabledReason = undefined
    // P2-1 scheduler state: a re-entrancy flag for the tick and a per-Ticket set so one Ticket never runs twice at once.
    this.scheduleTicking = false
    this.scheduleDispatching = new Set()
    this.scheduleDispatchQueue = undefined
    this.lastStatus = { phase: 'starting' }
    this.started = false
  }

  async load() {
    await this.state.load()
    await this.inbox.load()
    await this.signals.load()
    const operations = await this.operations.load()
    await this.acceptance.load()
    try { await this.evidence.load() } catch { this.evidence = new EvidenceStore(this.stateDir) }
    await this.migrateOperations(operations)
    await this.reconcile()
    // Derive the actionable inbox once the interrupted/parked state is settled (contract §3.4).
    await this.refreshInbox()
  }

  /**
   * P1 §3.2: the first load after the upgrade seeds the operation ledger from the runs still living in
   * `live-state.json`. `doc.runs` keeps accepting index rows (`summarizeRun`) from the executor afterwards, so nothing
   * is rewritten here — the full objects simply gain a durable home the panel can read one Ticket at a time.
   */
  async migrateOperations(loaded) {
    const runs = Array.isArray(this.state.runs) ? this.state.runs.filter(run => run && run.id) : []
    if (!loaded?.created || !runs.length) return { migrated: 0 }
    await this.operations.saveAll(runs)
    this.log(`migrated ${runs.length} runs from live-state.json into operations.json`)
    return { migrated: runs.length }
  }

  // ---------------------------------------------------------------------------
  // P1-1 raw signals (contract §2): every candidate — accepted, ignored or filtered out — is persisted first, so
  // "why was this message not handled" and "handle it again with today's rules" are both answerable from data.
  // ---------------------------------------------------------------------------

  /**
   * Persist one candidate before interpretation (idempotent per source event: an already-recorded event is reused).
   * `raw` is the untouched intake row, used for the ids a skipped candidate never reached.
   * → the stored signal (New or existing) | undefined when the log cannot be written.
   */
  async recordSignal(candidate, entryPoint = 'sync', raw = {}) {
    if (!this.signals?.loaded) await this.signals.load()
    const source = 'octo'
    const channelId = candidate.channelId !== undefined && candidate.channelId !== null && candidate.channelId !== ''
      ? String(candidate.channelId)
      : raw.channelId !== undefined && raw.channelId !== null && raw.channelId !== ''
        ? String(raw.channelId) : undefined
    const messageId = candidate.messageId ?? raw.messageId
    const eventId = candidate.eventId ?? raw.eventId
    const seq = candidate.seq ?? raw.messageSeq ?? raw.seq
    const at = typeof candidate.at === 'string' && candidate.at
      ? candidate.at
      : typeof raw.at === 'string' && raw.at ? raw.at : undefined
    const externalId = signalExternalId({ channelId, messageId, eventId, seq, at })
    const existing = this.signals.byExternalId(source, externalId)
    if (existing) return existing
    const receivedAt = new Date().toISOString()
    const text = String(candidate.text ?? raw.text ?? '').slice(0, SIGNAL_TEXT_MAX)
    const address = {
      ...(channelId ? { channelId } : {}),
      ...(messageId !== undefined && messageId !== null && messageId !== '' ? { messageId: String(messageId) } : {}),
      ...(eventId !== undefined && eventId !== null && eventId !== '' ? { eventId: String(eventId) } : {}),
      ...(Number.isFinite(candidate.channelType) ? { channelType: candidate.channelType } : {}),
    }
    const signal = {
      id: recordId('sig'),
      source,
      type: entryPoint === 'events' ? 'event' : entryPoint === 'manual' ? 'manual' : 'message.received',
      externalId,
      scopeKey: `octo:${channelId ?? 'unknown'}`,
      entryPoint,
      address,
      ...(at ? { occurredAt: at } : {}),
      receivedAt,
      // The normalized candidate is what a replay re-evaluates: it survives the payload purge.
      candidate: {
        channelId: channelId ?? '',
        ...(Number.isFinite(candidate.channelType) ? { channelType: candidate.channelType } : {}),
        ...(candidate.fromUid !== undefined ? { fromUid: String(candidate.fromUid) } : {}),
        text,
        ...(address.messageId ? { messageId: address.messageId } : {}),
        ...(address.eventId ? { eventId: address.eventId } : {}),
        ...(seq !== undefined && seq !== null ? { seq } : {}),
        ...(candidate.repoId ? { repoId: candidate.repoId } : {}),
        ...(candidate.threadTitle ? { threadTitle: candidate.threadTitle } : {}),
      },
      payload: { text },
      status: candidate.skip ? 'skipped' : 'pending',
      ...(candidate.skip ? { skipReason: candidate.skip } : {}),
      attempts: 0,
      createdAt: receivedAt,
    }
    await this.signals.commit((state) => {
      state.items[signal.id] = signal
      state.byKey[`${source}|${externalId}`] = signal.id
    })
    return signal
  }

  /** Update one stored signal in place (serialized with the log's own writes); returns the updated row. */
  async markSignal(signal, patch = {}) {
    if (!signal?.id || !this.signals?.loaded) return undefined
    return this.signals.commit((state) => {
      const row = state.items[signal.id]
      if (!row) return undefined
      Object.assign(row, patch, { updatedAt: new Date().toISOString() })
      return row
    })
  }

  /** Record the evaluation outcome on the signal: a Ticket (accept) or the filter code that ignored it. */
  async recordSignalOutcome(signal, evaluation, built) {
    const accepted = evaluation?.kind === 'accept'
    const decision = built?.decision
    const reasonCode = accepted ? undefined : decisionCodeOf(decision)
    return this.markSignal(signal, {
      status: accepted ? 'processed' : 'ignored',
      attempts: (signal?.attempts ?? 0) + 1,
      ...(decision?.id ? { decisionId: decision.id } : {}),
      ...(built?.trigger?.id ? { triggerId: built.trigger.id } : {}),
      ...(reasonCode ? { skipReason: reasonCode } : {}),
      error: undefined,
    })
  }

  /** Record an evaluation/absorption failure on the signal instead of losing it with the poll's exception. */
  async failSignal(signal, error) {
    const message = error instanceof Error ? error.message : String(error)
    return this.markSignal(signal, {
      status: 'failed',
      error: message.slice(0, 500),
      attempts: (signal?.attempts ?? 0) + 1,
    })
  }

  // The signal log is evidence, not a lock: a disk problem there must not stop message intake or a Ticket.
  errorText(error) { return error instanceof Error ? error.message : String(error) }

  async recordSignalSafely(candidate, entryPoint, raw) {
    try { return await this.recordSignal(candidate, entryPoint, raw) }
    catch (error) { this.log(`record signal failed: ${this.errorText(error)}`); return undefined }
  }

  async recordSignalOutcomeSafely(signal, evaluation, built) {
    try { return await this.recordSignalOutcome(signal, evaluation, built) }
    catch (error) { this.log(`update signal ${signal?.id} failed: ${this.errorText(error)}`); return undefined }
  }

  async failSignalSafely(signal, error) {
    if (!signal) return undefined
    try { return await this.failSignal(signal, error) }
    catch (failure) { this.log(`mark signal ${signal.id} failed: ${this.errorText(failure)}`); return undefined }
  }

  /** Rebuild the normalized candidate a stored signal was recorded with (P1 §2.2 replay). */
  candidateOfSignal(signal, config) {
    const stored = signal?.candidate ?? {}
    const channelId = String(stored.channelId ?? signal?.address?.channelId ?? '')
    const ids = idsOf()
    return {
      channelId,
      channelType: Number.isFinite(stored.channelType) ? stored.channelType : signal?.address?.channelType,
      fromUid: stored.fromUid ?? signal?.address?.fromUid,
      text: stored.text ?? signal?.payload?.text ?? '',
      messageId: stored.messageId ?? signal?.address?.messageId,
      eventId: stored.eventId ?? signal?.address?.eventId,
      seq: stored.seq,
      at: signal?.occurredAt ?? signal?.receivedAt,
      threadTitle: stored.threadTitle ?? config?.octo?.chatTitles?.[channelId],
      repoId: stored.repoId ?? config?.octo?.chatRepos?.[channelId] ?? config?.defaultRepo,
      signalId: signal?.id,
      ...ids,
    }
  }

  /**
   * A run cannot survive a plugin reload / host restart: the worker agent and its event listener are gone. The P0
   * reconcile is deliberately gentle (contract §3.3): an interrupted run is marked `interrupted` (not failed) and its
   * Ticket goes back to `ready` so the operator can retry it, while work parked on a human (waiting_for_human runs,
   * gate-blocked tickets) is left exactly as it was.
   * → { runs, tickets, parked } (`parked` counts the runs still waiting for a human).
   */
  async reconcile() {
    const docRuns = Array.isArray(this.state.runs) ? this.state.runs : []
    // P1 §3: the full ledger is authoritative for run objects; `doc.runs` may already carry only index rows.
    const operationRuns = this.operations?.loaded ? this.operations.all() : []
    const operationById = new Map(operationRuns.map(run => [run.id, run]))
    const staleDoc = docRuns.filter(run => run.status === 'running')
    const staleOperations = operationRuns.filter(run => run.status === 'running')
    const working = Object.values(this.state.tickets ?? {}).filter(ticket => ticket.status === 'working')
    // A stop requested before the restart has no execution left to consume it (legacy `ready + stopRequested` included).
    const pendingStops = Object.values(this.state.tickets ?? {}).filter(ticket => ticket.stopRequested)
    const parkedIds = new Set([...docRuns, ...operationRuns]
      .filter(run => run.status === 'waiting_for_human').map(run => run.id))
    const parked = parkedIds.size
    if (!staleDoc.length && !staleOperations.length && !working.length && !pendingStops.length) {
      return { runs: 0, tickets: 0, parked }
    }
    const at = new Date().toISOString()
    const message = 'interrupted by a plugin reload or host restart'
    const marked = new Set()
    const markRun = (run) => {
      if (!run || marked.has(run)) return
      marked.add(run)
      run.status = 'interrupted'
      run.stopReason = 'interrupted'
      run.error = message
      run.interruption = { canResume: false, interruptedAt: at, reason: 'plugin reload' }
      run.steps = [...(run.steps ?? []), { name: 'reconcile', at, state: 'interrupted', message }]
    }
    // The full ledger first: those objects are what a resumed Ticket reads. After marking, `doc.runs` gets the thin
    // index row back (it must not duplicate the whole step list forever).
    for (const run of staleOperations) markRun(run)
    await this.state.atomic((doc) => {
      const runs = Array.isArray(doc.runs) ? doc.runs : (doc.runs = [])
      doc.runs = runs.map(run => {
        const operation = operationById.get(run?.id)
        if (operation) return summarizeRun(operation)
        if (run?.status !== 'running') return run
        // A legacy row without a ledger entry keeps its full shape (there is no other copy of it to fall back to).
        markRun(run)
        return run
      })
      for (const ticket of Object.values(doc.tickets ?? {})) {
        if (ticket.status === 'working') {
          ticket.status = 'ready'
          ticket.updatedAt = at
          const assignment = ticket.assignments?.at(-1)
          if (assignment) {
            assignment.state = 'ended'
            assignment.endedAt = at
            assignment.report = { state: 'interrupted', text: message, at }
          }
        }
        // No executor survives this reconcile pass, so a pending stop has nothing left to consume. Confirm it here:
        // otherwise the Ticket sticks at `ready` while the panel keeps showing "正在停止" and every retry returns 409.
        if (ticket.stopRequested) {
          ticket.stop = { ...ticket.stopRequested, confirmedAt: at, runId: ticket.runId ?? null, recovered: 'host restart' }
          delete ticket.stopRequested
          ticket.updatedAt = at
        }
      }
    })
    if (staleOperations.length) await this.operations.saveAll(staleOperations)
    this.log(`reconciled interrupted runs: ${Math.max(staleDoc.length, staleOperations.length)}, tickets: ${working.length}, parked: ${parked}`)
    return { runs: Math.max(staleDoc.length, staleOperations.length), tickets: working.length, parked }
  }

  /** Read live.json without ever throwing: inbox derivation must survive a missing or broken configuration. */
  safeConfig() {
    try {
      const loaded = this.readConfig()
      if (!loaded || typeof loaded !== 'object') return { exists: false, config: undefined, tokens: {}, error: undefined }
      return { exists: loaded.exists === true, config: loaded.config, tokens: loaded.tokens ?? {}, error: loaded.error }
    } catch {
      return { exists: false, config: undefined, tokens: {}, error: undefined }
    }
  }

  /** Last engine-level error; the inbox shows it until a poll clears it (contract §1.4 `engine`). */
  lastEngineError() {
    const error = this.state?.state?.lastError ?? this.lastStatus?.error
    return typeof error === 'string' && error.trim() ? error : undefined
  }

  /**
   * Recompute the desired inbox from the live document and persist only what changed (contract §1.4/§3.4).
   * Never throws on an empty document or a missing configuration: the panel polls this on its status clock.
   */
  async refreshInbox() {
    if (!this.inbox.loaded) await this.inbox.load()
    const now = new Date().toISOString()
    const loaded = this.safeConfig()
    const desired = deriveInboxItems({ state: this.state?.state, loaded, lastError: this.lastEngineError(), now })
    return this.inbox.refresh(desired, now)
  }

  /** Unresolved inbox items in panel order: blocking first, then priority, then newest first (contract §2). */
  inboxItems() {
    if (!this.inbox.loaded) return []
    const rank = item => INBOX_PRIORITY_RANK[item.priority] ?? INBOX_PRIORITY_RANK.normal
    return Object.values(this.inbox.items).filter(item => !item.resolvedAt)
      .sort((left, right) => Number(right.blocking === true) - Number(left.blocking === true)
        || rank(left) - rank(right)
        || String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
  }

  /** Counts used by both `inboxView()` and `status()` (contract §1.5). */
  inboxCounts() {
    const items = this.inboxItems()
    return {
      blocking: items.filter(item => item.blocking === true).length,
      system: items.filter(item => item.blocking !== true).length,
      unread: items.filter(item => !item.readAt).length,
    }
  }

  /** `GET engine/inbox` — unresolved items plus their counts (the endpoint refreshes first). */
  inboxView() {
    return { items: this.inboxItems(), counts: this.inboxCounts() }
  }

  /** `POST engine/inbox/:id/read` — mark read once; unknown ids return undefined (index maps to 404). */
  async readInbox(id) {
    if (!this.inbox.loaded) await this.inbox.load()
    return this.inbox.read(id)
  }

  /**
   * `POST engine/inbox/:id/resolve` — manual acknowledgement for a system item. A blocking item (gate/accept) can only
   * be settled by its real action, so it throws an error with `code='inbox-blocking'` (index maps it to 409).
   * Unknown ids return undefined (404); already-resolved items are returned untouched.
   */
  async resolveInbox(id, { action, note } = {}) {
    if (!this.inbox.loaded) await this.inbox.load()
    const item = this.inbox.get(id)
    if (!item) return undefined
    if (!item.resolvedAt && item.blocking === true) {
      const error = new Error('这是必须由动作解决的待办：请处理对应闸门或验收')
      error.code = 'inbox-blocking'
      error.status = 409
      throw error
    }
    return this.inbox.resolve(id, { action: action ?? 'manual', note })
  }

  /**
   * AC-11 `POST engine/config/test` — a fixed, read-only configuration probe. It checks the config file, Node runtime,
   * the local repository path, token presence (never its value) and one platform GET. It never runs a configured gate,
   * creates a Ticket, starts a worker or writes anything.
   */
  async testConfig({ repoId } = {}) {
    const loaded = this.readConfig()
    const config = loaded.config
    const id = typeof repoId === 'string' && repoId ? repoId : config.defaultRepo ?? config.repos?.[0]?.id
    // An explicitly requested id must resolve exactly; repoOf() falls back to the default repository and would
    // silently test the wrong one.
    const repo = typeof repoId === 'string' && repoId
      ? configRepos(config).find(item => item.id === repoId)
      : id ? repoOf(config, id) : undefined
    if (repoId && !repo) return { ok: false, error: `未知仓库：${repoId}`, checks: [] }
    const checks = []
    checks.push({ id: 'config', label: 'live.json', ok: loaded.exists === true && !loaded.error,
      detail: loaded.error ? String(loaded.error) : loaded.exists ? '可读' : '不存在' })
    const major = Number.parseInt(String(process.versions.node ?? '').split('.')[0], 10)
    checks.push({ id: 'node', label: 'Node.js', ok: Number.isFinite(major) && major >= 22,
      detail: process.versions.node })
    if (repo) {
      checks.push({ id: 'repo', label: '本地仓库', ok: existsSync(repo.repo), detail: repo.repo })
      const token = repoToken(loaded, repo)
      checks.push({ id: 'token', label: '平台令牌', ok: Boolean(token), skipped: !token,
        detail: token ? '已配置（值不回显）' : '未配置' })
      const project = repo.gitlab?.project
      const baseUrl = repo.gitlab?.baseUrl
      if (project && baseUrl) {
        const fetchFn = this.deps.fetchImpl ?? globalThis.fetch
        if (typeof fetchFn !== 'function') checks.push({ id: 'connection', label: '平台连接', ok: false, detail: 'fetch 不可用' })
        else {
          const startedAt = Date.now()
          try {
            const isGithub = /github\.com/i.test(String(baseUrl))
            const url = isGithub
              ? `https://api.github.com/repos/${project}`
              : `${String(baseUrl).replace(/\/+$/, '')}/api/v4/projects/${encodeURIComponent(project)}`
            const headers = isGithub ? { accept: 'application/vnd.github+json' } : { 'PRIVATE-TOKEN': token ?? '' }
            if (isGithub && token) headers.authorization = `Bearer ${token}`
            const response = await fetchFn(url, { headers, signal: AbortSignal.timeout(10_000) })
            checks.push({ id: 'connection', label: '平台连接', ok: response.ok === true,
              detail: `HTTP ${response.status} · ${Date.now() - startedAt}ms` })
          } catch (error) {
            checks.push({ id: 'connection', label: '平台连接', ok: false,
              detail: error instanceof Error ? error.message : String(error) })
          }
        }
      } else checks.push({ id: 'connection', label: '平台连接', ok: true, skipped: true, detail: '未配置项目地址' })
      checks.push({ id: 'enabled', label: '仓库启用', ok: repo.enabled !== false, detail: repo.enabled === false ? '已停用' : '启用' })
    }
    return { ok: checks.every(check => check.skipped || check.ok), checks, repoId: repo?.id ?? null,
      at: new Date().toISOString() }
  }

  readConfig() {
    return (this.deps.loadConfig ?? loadLiveConfig)(this.stateDir)
  }

  configView() {
    return redactedLiveConfig(this.readConfig())
  }

  /**
   * List the bot's groups for the settings picker. This only reads the Octo group list: it never polls messages,
   * writes cursors, or creates Tickets.
   */
  async listGroups() {
    const loaded = this.readConfig()
    if (!loaded.exists) throw new Error('live.json 不存在')
    if (!loaded.tokens?.octo) throw new Error('Octo token 未配置')
    const client = await this.ensureClient(loaded)
    if (!client) throw new Error('Octo token 未配置')
    const result = await client.listGroups()
    const groups = (Array.isArray(result?.groups) ? result.groups : [])
      .map(group => {
        const id = group?.groupNo ?? group?.spaceId
        if (id === undefined || id === null || String(id) === '') return undefined
        return { id: String(id), name: String(group?.name || id), ...(group?.spaceId ? { spaceId: String(group.spaceId) } : {}) }
      })
      .filter(Boolean)
    return { groups, identity: result?.identity }
  }

  /** Saved live.json versions, newest first; entries never contain token values. */
  settingsHistory() {
    return listLiveConfigHistory(this.stateDir)
  }

  /** Restore one saved version (the current version is snapshotted first) and reload the engine. */
  async restoreSettings(id) {
    const restored = await restoreLiveConfig(this.stateDir, id)
    await this.refresh()
    return restored
  }

  /** Add one repository definition to live.json and reload the engine config. */
  async addRepo(repo, options = {}) {
    const saved = await addRepoDefinition(this.stateDir, repo, options)
    await this.refresh()
    return saved
  }

  /**
   * Edit/disable one existing repository (AC-10). The id and history stay; `enabled:false` stops new intake and
   * dispatch while history queries and runs already in flight keep working. Returns the saved repo.
   */
  async updateRepo(id, input) {
    const saved = await updateRepoDefinition(this.stateDir, id, input)
    await this.refresh()
    return saved
  }

  /** Save the Octo bot token to the configured token file and rebuild the cached client on the next poll. */
  async setOctoToken(token) {
    const saved = await writeOctoToken(this.readConfig().config, token)
    this.client = undefined
    this.clientToken = undefined
    await this.refresh()
    return saved
  }

  async ensureClient(loaded) {
    if (!loaded.tokens.octo) {
      this.lastStatus = { phase: 'blocked', error: 'Octo token is not configured' }
      return undefined
    }
    if (this.client && this.clientToken === loaded.tokens.octo) return this.client
    const factory = this.deps.createClient
      ?? (async options => { const { createOctoClient } = await import('./octo.js'); return createOctoClient(options) })
    this.client = await factory({ cliPath: loaded.config.octo.cliPath, token: loaded.tokens.octo,
      warn: line => this.log(`octo: ${line}`) })
    this.clientToken = loaded.tokens.octo
    return this.client
  }

  /** Re-read live.json and start/stop the loop accordingly (used after the operator edits the file). */
  async refresh() {
    const loaded = this.readConfig()
    this.started = true
    clearTimeout(this.timer)
    this.timer = undefined
    // P2-1: Ticket automation runs on its own 15s clock; it survives enabled=false/paused (the tick decides), so a
    // settings save never leaves a due Ticket un-scheduled until the next plugin reload.
    this.scheduleAutomation()
    if (loaded.exists && loaded.config.enabled) {
      await this.schedule()
      await this.scheduleVerify()
      this.lastStatus = { phase: 'idle', detail: 'live.json enabled', at: new Date().toISOString() }
      return { enabled: true, pollSeconds: loaded.config.pollSeconds,
        verifySeconds: Math.min(...configRepos(loaded.config).map(repo => repo.gitlab.verifySeconds ?? 120)) }
    }
    this.lastStatus = { phase: 'disabled', detail: loaded.exists ? '引擎未启用' : '配置文件缺失' }
    return { enabled: false }
  }

  /** Start polling when live.json says enabled; otherwise the engine stays idle and only manual polls run. */
  async start() {
    await this.load()
    this.started = true
    this.scheduleAutomation()
    const loaded = this.readConfig()
    if (!loaded.exists || !loaded.config.enabled) {
      this.lastStatus = { phase: 'disabled', detail: loaded.exists ? '引擎未启用' : '配置文件缺失' }
      this.log(`engine idle: ${this.lastStatus.detail}`)
      return
    }
    await this.schedule()
    await this.scheduleVerify()
  }

  /** Periodically re-check open MRs: merged into dev + changed UAT fingerprint completes acceptance without a token. */
  async scheduleVerify() {
    clearTimeout(this.verifyTimer)
    this.verifyTimer = undefined
    const tick = async () => {
      try { await this.verifyOpenTickets() } catch (error) { this.log(`verify failed: ${error instanceof Error ? error.message : String(error)}`) }
      if (!this.started) return
      const config = this.readConfig().config
      if (!config.enabled) return
      this.verifyTimer = setTimeout(tick, Math.max(30,
        Math.min(...configRepos(config).map(repo => repo.gitlab.verifySeconds ?? 120))) * 1000)
      this.verifyTimer.unref?.()
    }
    this.verifyTimer = setTimeout(tick, 5_000)
    this.verifyTimer.unref?.()
  }

  /** Verify every ticket that has a pushed commit and an open/unfinished acceptance state. */
  async verifyOpenTickets() {
    const loaded = this.readConfig()
    // The operator paused the engine: keep the schedule alive but touch neither GitLab nor the tickets.
    if (loaded.config.paused === true) return []
    const verify = this.deps.verifyTicket ?? (await import('./executor.js')).verifyTicket
    // With a GitLab token the loop can also read MR pipelines / dev jobs; without one it stays on the token-free
    // signals (git ancestry + UAT asset/mtime + backend health) inside verifyTicket. A manual repository never
    // refreshes CI: there is nothing to observe, only the merge into its target branch matters.
    const refreshCi = this.deps.refreshTicketCi ?? (await import('./executor.js')).refreshTicketCi
    const config = loaded.config
    // A plugin reload can interrupt the executor after GitLab already has the branch/MR. Heal those orphaned Tickets
    // from the remote MR before the normal verification pass, otherwise they would stay failed forever.
    const reconcile = this.deps.reconcileTicketFromGitlab
      ?? (await import('./executor.js')).reconcileTicketFromGitlab
    const orphans = Object.values(this.state.tickets).filter(ticket => ['failed', 'pushed'].includes(ticket.status)
      && ticket.links?.branch && !ticket.links?.mergeRequest?.iid)
    for (const ticket of orphans) {
      try {
        const healed = await reconcile({ engine: this, ticketId: ticket.id })
        if (healed?.status) this.log(`reconciled ${ticket.id} from GitLab MR !${healed.mergeRequest?.iid}: ${ticket.status} -> ${healed.status}`)
      } catch (error) { this.log(`reconcile ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const openTickets = Object.values(this.state.tickets).filter(ticket => ticket.links?.commit
      && ['mr-open', 'ci-pending', 'merged', 'deploy-pending'].includes(ticket.status))
    const candidates = openTickets.filter(ticket => ticketRepo(config, ticket)?.verifyMode !== 'manual')
    const manualCandidates = openTickets.filter(ticket => ticketRepo(config, ticket)?.verifyMode === 'manual')
    const results = []
    // P2 §2.3: a draft/WIP MR is still being written — observing it would only report a half-finished state. Record why
    // it was not checked (so the panel can explain it) and never refresh CI / verify it.
    const isDraft = ticket => ticket.links?.mergeRequest?.workInProgress === true || ticket.links?.mergeRequest?.draft === true
    const drafts = [...manualCandidates, ...candidates].filter(isDraft)
    for (const ticket of drafts) {
      const autoVerify = ticket.links?.autoVerify
      const headSha = this.autoVerifyHeadSha(ticket)
      results.push({ ticketId: ticket.id, skipped: 'draft' })
      try {
        await this.updateAutoVerify(ticket.id, {
          headSha,
          // A draft wake is not an attempt: keep the per-head counter (reset to 0 when the head moved).
          count: autoVerify?.headSha === headSha ? Number(autoVerify.count) || 0 : 0,
          lastAt: new Date().toISOString(),
          skipped: 'draft',
        })
      } catch (error) { this.log(`auto-verify ${ticket.id} draft record failed: ${this.errorText(error)}`) }
    }
    for (const ticket of manualCandidates) {
      if (isDraft(ticket)) continue
      // A manual repository observes exactly one remote fact — whether its MR got merged — so the per-head wake-up
      // budget (meant for CI/UAT observation) does not apply: capping it parked MRs that were merged after the three
      // quick checks. The open-state filter above removes the Ticket as soon as it is merged/closed, which is the
      // natural stop; keep the attempt counter only for the panel's history.
      const headSha = this.autoVerifyHeadSha(ticket)
      const previous = ticket.links?.autoVerify
      const count = previous?.headSha === headSha ? (Number(previous.count) || 0) + 1 : 1
      try {
        await this.updateAutoVerify(ticket.id, { headSha, count, lastAt: new Date().toISOString(),
          lastSkipReason: undefined, skipped: undefined })
      } catch (error) { this.log(`auto-verify ${ticket.id} manual record failed: ${this.errorText(error)}`) }
      try {
        const result = await verify({ engine: this, ticketId: ticket.id })
        results.push({ ticketId: ticket.id, status: result.status, merged: result.verification?.merged })
        if (result.status !== ticket.status) this.log(`ticket ${ticket.id}: ${ticket.status} -> ${result.status}`)
        await this.completeAcceptanceOnVerify(ticket.id, result.status)
      } catch (error) { this.log(`verify ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const ticket of candidates) {
      if (isDraft(ticket)) continue
      // P2 §2.3: cap the automatic wake-ups per head commit; the attempt is persisted *before* touching GitLab.
      const attempt = await this.prepareAutoVerify(ticket)
      if (attempt?.skipped) { results.push({ ticketId: ticket.id, skipped: attempt.skipped }); continue }
      let ci
      if (ticket.links?.mergeRequest?.iid) {
        try { ci = await refreshCi({ engine: this, ticketId: ticket.id }) }
        catch (error) { this.log(`ci refresh ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`) }
      }
      try {
        const result = await verify({ engine: this, ticketId: ticket.id })
        results.push({ ticketId: ticket.id, status: result.status, merged: result.verification?.merged,
          ci: ci?.status ?? ci?.skipped })
        if (result.status !== ticket.status) this.log(`ticket ${ticket.id}: ${ticket.status} -> ${result.status}`)
        await this.completeAcceptanceOnVerify(ticket.id, result.status)
      } catch (error) { this.log(`verify ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return results
  }

  /** The commit an automatic verification is watching (MR head when known, else the pushed commit). */
  autoVerifyHeadSha(ticket) {
    return ticket.links?.mergeRequest?.headSha ?? ticket.links?.commit
  }

  /** Persist one `ticket.links.autoVerify` snapshot without clobbering concurrent link fields. */
  async updateAutoVerify(ticketId, patch) {
    return this.state.atomic((doc) => {
      const ticket = doc.tickets?.[ticketId]
      if (!ticket) return undefined
      const links = { ...(ticket.links ?? {}) }
      const autoVerify = { ...(links.autoVerify ?? {}), ...patch }
      if (patch.skipped === undefined) delete autoVerify.skipped
      if (patch.lastSkipReason === undefined) delete autoVerify.lastSkipReason
      links.autoVerify = autoVerify
      ticket.links = links
      return autoVerify
    })
  }

  /**
   * P2 §2.3: decide whether this automatic verification may run. `headSha` scopes the budget; a new head commit resets
   * it (a force-push deserves fresh observations), and reaching MAX_AUTO_VERIFY parks it with a visible reason.
   * → { skipped:'auto-verify-limit' } | { headSha, count } (the attempt has been persisted either way)
   */
  async prepareAutoVerify(ticket) {
    const headSha = this.autoVerifyHeadSha(ticket)
    const previous = ticket.links?.autoVerify
    const now = new Date().toISOString()
    if (previous?.headSha === headSha && (Number(previous.count) || 0) >= MAX_AUTO_VERIFY) {
      // Park it: no refreshCi/verify call, only the reason (logged once per head so the loop stays quiet).
      if (previous.lastSkipReason !== 'auto-verify-limit') {
        this.log(`auto-verify ${ticket.id} limit reached for ${headSha ?? 'unknown head'}`)
        try {
          await this.updateAutoVerify(ticket.id, { headSha, count: Number(previous.count) || MAX_AUTO_VERIFY,
            lastAt: now, lastSkipReason: 'auto-verify-limit' })
        } catch (error) { this.log(`auto-verify ${ticket.id} limit record failed: ${this.errorText(error)}`) }
      }
      return { skipped: 'auto-verify-limit', headSha }
    }
    const count = previous?.headSha === headSha ? (Number(previous.count) || 0) + 1 : 1
    await this.updateAutoVerify(ticket.id, { headSha, count, lastAt: now })
    return { headSha, count }
  }

  /** P1 §4.2: verification reaching a delivered state completes the open acceptance round (never throws). */
  async completeAcceptanceOnVerify(ticketId, status) {
    if (!['deployed', 'merged'].includes(status)) return undefined
    try { return await this.markAcceptanceDelivered(ticketId) }
    catch (error) { this.log(`acceptance ${ticketId} delivered failed: ${this.errorText(error)}`); return undefined }
  }

  async schedule() {
    clearTimeout(this.timer)
    const run = async () => {
      try {
        // Paused keeps the timer running so resuming needs no restart, but does not poll Octo.
        const polled = this.readConfig().config
        if (polled.paused !== true && polled.pausedIntake !== true) await this.pollOnce({ dryRun: false })
      } catch (error) { this.log(`engine poll failed: ${error instanceof Error ? error.message : String(error)}`) }
      if (!this.started) return
      const config = this.readConfig().config
      this.timer = setTimeout(run, Math.max(2, config.pollSeconds) * 1000)
      this.timer.unref?.()
    }
    this.timer = setTimeout(run, 1000)
    this.timer.unref?.()
  }

  // ---------------------------------------------------------------------------
  // P2-1 Ticket automation (contract §1.2): a Ticket can run itself on a heartbeat or once a day. Configuration lives
  // on the Ticket (`ticket.automation`); this scheduler only decides when a due one may start and records why not.
  // ---------------------------------------------------------------------------

  /** Create/replace the independent schedule timer (15s, unref); tick errors never kill the timer. */
  scheduleAutomation() {
    clearTimeout(this.scheduleTimer)
    const tick = async () => {
      try { await this.tickSchedules() }
      catch (error) { this.log(`schedule tick failed: ${this.errorText(error)}`) }
      if (!this.started) return
      this.scheduleTimer = setTimeout(tick, SCHEDULE_TICK_MS)
      this.scheduleTimer.unref?.()
    }
    this.scheduleTimer = setTimeout(tick, SCHEDULE_TICK_MS)
    this.scheduleTimer.unref?.()
  }

  /**
   * One scheduler pass: every due Ticket either becomes a run (persisted first, then executed asynchronously) or gets
   * its `lastSkipReason` written. Skip precedence is fixed by the contract so the panel explains one reason, not five.
   * → { dispatched:[ticketId], skipped:[{ticketId, reason}], busy? }
   */
  async tickSchedules(nowMs = Date.now()) {
    if (this.scheduleTicking) return { dispatched: [], skipped: [], busy: true }
    this.scheduleTicking = true
    try {
      const loaded = this.readConfig()
      const config = loaded.config
      const now = new Date(nowMs).toISOString()
      const due = Object.values(this.state.tickets ?? {})
        .filter(ticket => ticket && isDue(ticket.automation, nowMs))
      const dispatched = []
      const skipped = []
      const changes = []
      for (const ticket of due) {
        const automation = ticket.automation
        const reason = this.automationSkipReason(ticket, config)
        if (reason) {
          skipped.push({ ticketId: ticket.id, reason })
          // Only persist a change: a paused engine with a due Ticket would otherwise rewrite the document every tick.
          if (automation.lastSkipReason !== reason) changes.push({ ticketId: ticket.id, skipReason: reason })
          continue
        }
        const nextAt = nextRunAt(automation, nowMs)
        changes.push({ ticketId: ticket.id, dispatch: automation.mode, nextAt, at: now })
        // Keep the pre-attempt counters so a pause that lands after this tick can put the queued Ticket back exactly
        // where it was instead of silently consuming one execution (AC-02).
        dispatched.push({ ticketId: ticket.id, mode: automation.mode, restore: {
          executions: Number(automation.executions) || 0,
          nextAt: automation.nextAt,
          lastRunAt: automation.lastRunAt,
          lastTrigger: automation.lastTrigger,
        } })
      }
      if (changes.length) {
        // Persist the attempt *before* executing: a crash mid-run must not let the same heartbeat fire again blindly.
        await this.state.atomic((doc) => {
          for (const change of changes) {
            const ticket = doc.tickets?.[change.ticketId]
            if (!ticket) continue
            const automation = { ...(ticket.automation ?? {}) }
            if (change.skipReason) {
              automation.lastSkipReason = change.skipReason
            } else {
              automation.executions = (Number(automation.executions) || 0) + 1
              automation.lastRunAt = change.at
              automation.lastTrigger = change.dispatch
              if (change.nextAt) automation.nextAt = change.nextAt
              else delete automation.nextAt
              delete automation.lastSkipReason
            }
            ticket.automation = automation
            if (!change.skipReason) {
              appendActivity(ticket, { kind: 'run', actorKind: 'system',
                detail: `定时触发（${change.dispatch}）`, refs: { trigger: change.dispatch, at: change.at } })
            }
          }
        })
      }
      if (dispatched.length) this.queueScheduledRuns(dispatched)
      return { dispatched: dispatched.map(item => item.ticketId), skipped }
    } finally {
      this.scheduleTicking = false
    }
  }

  /** Fixed skip precedence for a due automation (never throws on a partial config). */
  automationSkipReason(ticket, config) {
    if (config?.paused === true) return 'paused'
    // Dispatch pause keeps the queue intact, but nothing may start while it is on (including scheduled Tickets).
    if (config?.pausedDispatch === true) return 'dispatch-paused'
    if (config?.executor?.enabled !== true) return 'executor-disabled'
    if (ticket.status === 'working') return 'working'
    if (ticket.status === 'gate-blocked' || ticket.status === 'awaiting-answer') return 'parked'
    // The executor for this Ticket is still running from a previous tick: report it like any other in-flight work.
    if (this.scheduleDispatching.has(ticket.id)) return 'working'
    const maxExecutions = ticket.automation?.maxExecutions
    if (Number.isFinite(maxExecutions) && (Number(ticket.automation?.executions) || 0) >= maxExecutions) return 'max-executions'
    let repo
    try { repo = ticketRepo(config, ticket) } catch { repo = undefined }
    if (!repo) return 'no-repo'
    // A disabled repository accepts no new work: skip before the attempt is persisted or a "定时触发" activity is
    // written, instead of counting an execution that the executor will refuse.
    if (repo.enabled === false) return 'repo-disabled'
    return undefined
  }

  /** Run dispatches serially, off the tick's call stack; the in-memory set keeps one Ticket from overlapping itself. */
  queueScheduledRuns(items) {
    for (const item of items) this.scheduleDispatching.add(item.ticketId)
    const run = async () => {
      for (const item of items) {
        try { await this.executeScheduledTicket(item.ticketId, item.mode, item.restore) }
        finally { this.scheduleDispatching.delete(item.ticketId) }
      }
    }
    const chain = (this.scheduleDispatchQueue ?? Promise.resolve()).then(run, run)
    this.scheduleDispatchQueue = chain.catch(() => {})
  }

  /** Call the executor with the automation mode as its trigger; failures are logged and never bubble into the timer. */
  async executeScheduledTicket(ticketId, mode, restore) {
    // Re-check the pause right before dispatch: the queue may have waited while an operator paused the panel, and a
    // due Ticket must not start just because it was already queued (review P1 AC-02).
    const config = this.readConfig?.()?.config ?? {}
    if (config.paused === true || config.pausedDispatch === true) {
      const reason = config.paused === true ? 'paused' : 'dispatch-paused'
      await this.state.atomic((doc) => {
        const ticket = doc.tickets?.[ticketId]
        if (!ticket) return
        const automation = { ...(ticket.automation ?? {}) }
        if (restore) {
          automation.executions = restore.executions
          if (restore.nextAt) automation.nextAt = restore.nextAt
          else delete automation.nextAt
          if (restore.lastRunAt) automation.lastRunAt = restore.lastRunAt
          else delete automation.lastRunAt
          if (restore.lastTrigger) automation.lastTrigger = restore.lastTrigger
          else delete automation.lastTrigger
        }
        automation.lastSkipReason = reason
        ticket.automation = automation
        // The attempt activity belongs to a run that never started; replace the last one if it is still the trigger.
        const last = ticket.activities?.at(-1)
        if (last?.kind === 'run' && last?.refs?.trigger) ticket.activities.pop()
      })
      this.log(`schedule ${ticketId} skipped: ${reason}`)
      return { skipped: reason }
    }
    const execute = this.deps.executeTicket ?? (await import('./executor.js')).executeTicket
    try {
      this.log(`schedule ticket ${ticketId} (${mode})`)
      const run = await execute({ ctx: this.ctx, engine: this, ticketId, dryRun: false, trigger: mode,
        log: line => this.log(`executor ${ticketId}: ${line}`) })
      this.log(`schedule ${ticketId}: ${run?.status ?? 'unknown'}`)
      return run
    } catch (error) {
      this.log(`schedule ${ticketId} failed: ${this.errorText(error)}`)
      return undefined
    }
  }

  /**
   * `POST engine/ticket/:id/automation` — merge the operator patch onto the Ticket's automation (P2 §1.2). An invalid
   * patch is rejected without touching the stored config; a valid one is persisted with an activity row for the log.
   * → { ticket, automation } | { missing:true } | { invalid:string }
   */
  async setTicketAutomation(ticketId, patch = {}) {
    const ticket = this.state.tickets?.[ticketId]
    if (!ticket) return { missing: true }
    const { automation, error } = normalizeAutomation(patch ?? {}, ticket.automation ?? {}, Date.now())
    if (error) return { invalid: error }
    const at = new Date().toISOString()
    await this.state.atomic((doc) => {
      const current = doc.tickets[ticketId]
      if (!current) return
      doc.tickets[ticketId] = { ...current, automation, updatedAt: at }
      appendActivity(doc.tickets[ticketId], {
        kind: 'status', actorKind: 'user',
        detail: `自动化：${describeAutomation(automation) || '关闭'}`,
        refs: { automation: { mode: automation.mode, enabled: automation.enabled } },
      })
    })
    const saved = this.state.tickets[ticketId]
    return saved ? { ticket: saved, automation: saved.automation ?? automation } : { missing: true }
  }

  stop() {
    this.started = false
    clearTimeout(this.timer)
    clearTimeout(this.verifyTimer)
    clearTimeout(this.scheduleTimer)
    this.timer = undefined
    this.verifyTimer = undefined
    this.scheduleTimer = undefined
    this.client = undefined
  }

  /** One poll pass, dispatching on the configured intake mode. */
  async pollOnce({ dryRun = true } = {}) {
    const loaded = this.readConfig()
    const mode = loaded.config.octo.intake === 'events' ? 'events' : 'sync'
    // The pause switches stop the live path only: a dry run never writes or acts, so it stays available for
    // diagnosis. `pausedIntake` must be checked here too — otherwise the manual poll endpoint still consumes messages
    // and advances the cursor while the UI says intake is paused (review finding AC-02).
    if (!dryRun && (loaded.config.paused === true || loaded.config.pausedIntake === true)) {
      return { error: 'paused', dryRun, mode, reason: loaded.config.paused === true ? 'paused' : 'intake' }
    }
    if (this.polling) return { skipped: 'busy', status: this.lastStatus }
    this.polling = true
    try {
      if (mode === 'sync') return await this.pollSync(loaded, { dryRun })
      return await this.pollEvents(loaded, { dryRun })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.lastStatus = { phase: 'error', mode, error: message, at: new Date().toISOString() }
      return { error: message, dryRun, mode }
    } finally {
      this.polling = false
    }
  }

  /** Earlier contextOnly messages (same thread, within 10 minutes) that a new request can absorb. */
  contextMessagesOf(threadKey, at, pendingRecords = []) {
    if (!threadKey || typeof at !== 'string') return []
    const since = new Date(Date.parse(at) - CONTEXT_WINDOW_MS).toISOString()
    const triggers = [...Object.values(this.state.triggers ?? {}), ...pendingRecords.map(record => record.trigger).filter(Boolean)]
    const decisions = new Map()
    for (const decision of [...Object.values(this.state.decisions ?? {}), ...pendingRecords.map(record => record.decision).filter(Boolean)]) {
      decisions.set(decision.id, decision)
    }
    const found = []
    for (const trigger of triggers) {
      if (!trigger || !Array.isArray(trigger.threads) || !trigger.threads.includes(threadKey)) continue
      if (trigger.at < since || trigger.at >= at) continue
      const decision = decisions.get(trigger.disposition?.decisionId)
      if (!decision || decision.kind !== 'ignore' || decision.contextUsedBy) continue
      if (!(decision.reason ?? []).some(item => item.code === 'contextOnly')) continue
      found.push({ id: trigger.id, at: trigger.at, text: String(trigger.text ?? ''), decision })
    }
    found.sort((left, right) => String(left.at).localeCompare(String(right.at)))
    return found.slice(-5)
  }

  /** Prepend earlier context to an accepted ticket and mark it used exactly once. */
  attachContext(pendingRecords, built) {
    const ticket = built.ticket
    if (!ticket) return
    const contexts = this.contextMessagesOf(built.thread?.key, built.trigger?.at, pendingRecords)
    if (!contexts.length) return
    ticket.body = `${contexts.map(context => context.text).join('\n\n')}\n\n---\n\n${ticket.body}`
    ticket.origin = { ...ticket.origin, contextTriggerIds: contexts.map(context => context.id) }
    for (const context of contexts) context.decision.contextUsedBy = ticket.id
  }

  // ---------------------------------------------------------------------------
  // Shadow decision model (eval.mode='shadow'): ask the model, store the answer, never act on it.
  // ---------------------------------------------------------------------------

  /**
   * Whether shadow mode can call the model, plus the operator-facing reason when it cannot. Pure: the status view
   * uses it on every poll, so it never creates a client or touches the network.
   */
  shadowReadiness(config, tokens) {
    const mode = config?.eval?.mode ?? 'rules'
    if (mode !== 'shadow' && mode !== 'hybrid') return { enabled: false, ready: false, reason: `eval.mode=${mode}` }
    const decision = config?.eval?.decision
    if (!decision?.endpoint || !decision?.model) {
      return { enabled: true, ready: false, reason: 'eval.decision.endpoint / model 未配置' }
    }
    if (!tokens?.decision) return { enabled: true, ready: false, reason: 'decision token 未配置（eval.decision.tokenFile）' }
    return { enabled: true, ready: true }
  }

  /** Resolve the judge client for this configuration; no `judge` means shadow mode is off or not fully configured. */
  judgeFor(loaded) {
    const readiness = this.shadowReadiness(loaded?.config, loaded?.tokens)
    if (!readiness.ready) return { reason: readiness.reason }
    const decision = loaded.config.eval.decision
    try {
      const createJudge = this.deps.createJudge ?? createSystemOneJudge
      return { judge: createJudge({ endpoint: decision.endpoint, model: decision.model, token: loaded.tokens.decision,
        timeoutMs: decision.timeoutMs, fetchImpl: this.deps.fetch }) }
    } catch (error) {
      return { reason: this.errorText(error) }
    }
  }

  /**
   * Ask the decision model about every evaluated record's trigger and store the answer as `decision.shadow`.
   * Intake never waits for a verdict: a failed call becomes an auditable error row and the rules' own decision is
   * untouched. Budget and parallelism come from `eval.decision` so one poll cannot stall on a slow endpoint.
   * → { judged, failed, skipped, model? } (counts only)
   */
  async attachShadow(records, loaded) {
    // hybrid judges before the decision; only shadow judges after it (otherwise a hybrid poll would ask twice).
    if ((loaded?.config?.eval?.mode ?? 'rules') !== 'shadow') return { judged: 0, failed: 0, skipped: 0, reason: 'shadow-mode-off' }
    const list = (Array.isArray(records) ? records : []).filter(record => record?.decision && record?.trigger)
    if (!list.length) return { judged: 0, failed: 0, skipped: 0 }
    const settings = loaded?.config?.eval?.decision ?? {}
    const { judge, reason } = this.judgeFor(loaded)
    if (!judge) {
      this.judgeStats.skipped += list.length
      // One line per reason change: a misconfigured shadow mode must not fill the host log every poll.
      if (this.judgeDisabledReason !== reason) {
        this.judgeDisabledReason = reason
        this.log(`shadow judge disabled: ${reason}`)
      }
      return { judged: 0, failed: 0, skipped: list.length, reason }
    }
    this.judgeDisabledReason = undefined
    const maxPerPoll = Number.isFinite(settings.maxPerPoll) ? Math.max(0, settings.maxPerPoll) : 10
    const concurrency = Math.max(1, Math.min(4, Number.isFinite(settings.concurrency) ? settings.concurrency : 2))
    const queue = list.slice(0, maxPerPoll)
    const skipped = list.length - queue.length
    let ok = 0
    let failed = 0
    let cursor = 0
    const worker = async () => {
      while (cursor < queue.length) {
        const record = queue[cursor++]
        const at = new Date().toISOString()
        this.judgeStats.calls += 1
        try {
          // Plain message text only: the judge's state must stay a string (see judge.js JUDGE_QUESTIONS_VERSION).
          const result = await judge.judge({ text: record.trigger.text })
          record.decision.shadow = shadowOf(result, { ruleKind: record.decision.kind,
            acceptAt: settings.acceptAt, rejectAt: settings.rejectAt, at })
          ok += 1
          this.judgeStats.ok += 1
          this.judgeStats.lastAt = at
          this.judgeStats.lastLatencyMs = result.latencyMs
        } catch (error) {
          failed += 1
          this.judgeStats.errors += 1
          this.judgeStats.lastAt = at
          this.judgeStats.lastError = this.errorText(error)
          record.decision.shadow = shadowErrorOf(error, { ruleKind: record.decision.kind, at })
          this.log(`shadow judge failed: ${this.errorText(error)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, () => worker()))
    if (skipped) {
      this.judgeStats.skipped += skipped
      this.log(`shadow judge skipped ${skipped} candidate(s) over the per-poll budget (eval.decision.maxPerPoll=${maxPerPoll})`)
    }
    return { judged: ok, failed, skipped, model: judge.model }
  }

  /**
   * Intake decision for one candidate. Rules always run first and own every non-accept outcome (R2/R3 are hard gates).
   * In hybrid mode an accepted candidate is additionally gated by the model category: `repo_task` opens, `risky` is
   * blocked, everything else becomes a reviewable ignore (replay from the sources page still overrides it). A judge
   * failure or an exhausted per-poll budget falls back to the rules' accept so an outage cannot silently stop intake.
   * → { evaluation, model?, modelDecision?, fallback? }
   */
  async evaluateForIntake(candidate, config, judge, budget) {
    const ruleEvaluation = evaluate(candidate, config)
    if (ruleEvaluation.kind !== 'accept') return { evaluation: ruleEvaluation }
    if ((config.eval?.mode ?? 'rules') !== 'hybrid') return { evaluation: ruleEvaluation }
    if (!judge || !budget || budget.left <= 0) {
      return { evaluation: ruleEvaluation, fallback: judge ? 'budget' : 'judge-unavailable' }
    }
    budget.left -= 1
    const settings = config.eval?.decision ?? {}
    const at = new Date().toISOString()
    this.hybridStats.calls += 1
    this.judgeStats.calls += 1
    try {
      const result = await judge.judge({ text: candidate.text })
      const category = result.answers?.category
      const probability = result.answers?.repoTask
      const risky = result.answers?.risky
      const riskAt = Number.isFinite(settings.riskAt) ? settings.riskAt : 0.5
      const model = {
        status: 'ok',
        model: result.model,
        questions: JUDGE_QUESTIONS_VERSION,
        ...(typeof category === 'string' ? { category } : {}),
        ...(typeof probability === 'number' ? { p: probability } : {}),
        ...(typeof risky === 'number' ? { riskP: risky } : {}),
        verdict: verdictOf(probability, { acceptAt: settings.acceptAt, rejectAt: settings.rejectAt }),
        ...(Number.isFinite(result.latencyMs) ? { latencyMs: result.latencyMs } : {}),
        at,
      }
      this.judgeStats.ok += 1
      this.judgeStats.lastAt = at
      this.judgeStats.lastLatencyMs = result.latencyMs
      const confidentAccept = category === 'repo_task' && typeof probability === 'number'
        && probability >= (settings.acceptAt ?? 0.5)
      const riskyHit = category === 'risky' || (typeof risky === 'number' && risky >= riskAt)
      if (confidentAccept && !riskyHit) return { evaluation: ruleEvaluation, model, modelDecision: 'accept' }
      const code = riskyHit ? 'modelRisk'
        : typeof category === 'string' && category !== 'repo_task' ? 'modelSkip'
          : typeof probability === 'number' && probability <= (settings.rejectAt ?? 0.2) ? 'modelSkip'
            : 'modelUncertain'
      const values = {
        ...(typeof category === 'string' ? { category } : {}),
        ...(typeof probability === 'number' ? { p: Math.round(probability * 100) / 100 } : {}),
        ...(typeof risky === 'number' ? { riskP: Math.round(risky * 100) / 100 } : {}),
      }
      return { evaluation: { kind: 'ignore', reason: [{ code, values }], rules: ruleEvaluation.rules }, model, modelDecision: code }
    } catch (error) {
      this.hybridStats.fallbacks += 1
      this.judgeStats.errors += 1
      this.judgeStats.lastAt = at
      this.judgeStats.lastError = this.errorText(error)
      this.log(`hybrid judge failed, falling back to rules: ${this.errorText(error)}`)
      return { evaluation: ruleEvaluation,
        model: { status: 'error', questions: JUDGE_QUESTIONS_VERSION, error: this.errorText(error).slice(0, 300), at },
        fallback: 'judge-error' }
    }
  }

  // ---------------------------------------------------------------------------
  // Evaluation review prompts (group confirmation loop). Pure text/label helpers live in reviews.js.
  // ---------------------------------------------------------------------------

  reviewSettingsOf(config) {
    const review = config?.review ?? {}
    return {
      enabled: review.enabled === true,
      scope: review.scope === 'uncertain' ? 'uncertain' : 'all',
      allowSenderIds: Array.isArray(review.allowSenderIds)
        ? review.allowSenderIds.filter(id => typeof id === 'string' && id) : [],
      expireHours: Number.isFinite(review.expireHours) && review.expireHours >= 1
        ? Math.min(24 * 7, review.expireHours) : 24,
    }
  }

  /** Review counts for the status surface (derived from the persisted review rows). */
  reviewCounts(state = this.state?.state) {
    const reviews = Object.values(state?.reviews ?? {})
    const counts = { total: reviews.length, pending: 0, sent: 0, answered: 0, expired: 0, failed: 0 }
    for (const review of reviews) if (counts[review.status] !== undefined) counts[review.status] += 1
    return counts
  }

  /** One review row for an evaluated decision (undefined when the scope skips it). */
  reviewRecordOf(built, config, settings, code, now = new Date()) {
    const decision = built?.decision
    const trigger = built?.trigger
    if (!decision || !trigger) return undefined
    const reasonCodes = (Array.isArray(decision.reason) ? decision.reason : []).map(item => item?.code).filter(Boolean)
    const record = {
      id: recordId('rev'),
      code,
      status: 'pending',
      decisionId: decision.id,
      signalId: decision.signalId ?? trigger.signalId,
      triggerId: trigger.id,
      ...(decision.ticketId ? { ticketId: decision.ticketId } : {}),
      chatId: trigger.channel?.address?.channelId ?? '',
      channelType: trigger.channel?.address?.channelType ?? config.octo?.channelType,
      textPreview: preview(trigger.text ?? '', 90),
      ruleKind: decision.kind,
      ruleCodes: reasonCodes,
      ...(decision.model ? { model: decision.model } : {}),
      ...(decision.model?.verdict ? { modelVerdict: decision.model.verdict } : {}),
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + settings.expireHours * 3600_000).toISOString(),
    }
    if (!record.chatId) return undefined
    return reviewScopeMatches(record, settings.scope) ? record : undefined
  }

  /** Persist new reviews and expire stale ones inside the poll's atomic write. */
  queueReviews(doc, records, now = new Date()) {
    if (!Array.isArray(records) || !records.length) return
    doc.reviews = doc.reviews ?? {}
    for (const record of records) doc.reviews[record.id] = record
    const nowMs = now.getTime()
    for (const review of Object.values(doc.reviews)) {
      if (review.status !== 'pending' && review.status !== 'sent') continue
      const expires = Date.parse(review.expiresAt ?? '')
      if (Number.isFinite(expires) && expires <= nowMs) review.status = 'expired'
    }
  }

  /** Send one prompt per review and persist sent/failed; never throws into the poll. */
  async sendReviewPrompts(records, client, config) {
    if (!Array.isArray(records) || !records.length) return { sent: 0, failed: 0 }
    if (typeof client?.sendText !== 'function') {
      await this.state.atomic((doc) => {
        doc.reviews = doc.reviews ?? {}
        for (const record of records) if (doc.reviews[record.id]) {
          doc.reviews[record.id] = { ...doc.reviews[record.id], status: 'failed', error: 'octo client unavailable' }
        }
      })
      return { sent: 0, failed: records.length }
    }
    const updates = []
    for (const record of records) {
      try {
        await client.sendText({ channelId: record.chatId, channelType: record.channelType ?? config.octo?.channelType,
          content: reviewNotification(record, config) })
        updates.push({ id: record.id, status: 'sent', sentAt: new Date().toISOString() })
      } catch (error) {
        updates.push({ id: record.id, status: 'failed', error: this.errorText(error).slice(0, 300) })
        this.log(`review ${record.code} send failed: ${this.errorText(error)}`)
      }
    }
    await this.state.atomic((doc) => {
      doc.reviews = doc.reviews ?? {}
      for (const update of updates) {
        if (doc.reviews[update.id]) doc.reviews[update.id] = { ...doc.reviews[update.id], ...update }
      }
    })
    return { sent: updates.filter(update => update.status === 'sent').length,
      failed: updates.filter(update => update.status === 'failed').length }
  }

  /** One short confirmation message back to the group; failures are only logged. */
  async sendReviewAck(record, answer, outcome, client, config) {
    if (typeof client?.sendText !== 'function') return
    try {
      await client.sendText({ channelId: record.chatId, channelType: record.channelType ?? config.octo?.channelType,
        content: reviewAck(record, answer, outcome) })
    } catch (error) { this.log(`review ack failed: ${this.errorText(error)}`) }
  }

  /**
   * Match one incoming message as an operator answer. A command-shaped message is always consumed (answered or
   * denied) so it can never become a new candidate/Ticket. → true when consumed.
   */
  async handleReviewCommand(input, config, client) {
    const settings = this.reviewSettingsOf(config)
    if (!settings.enabled) return false
    const command = parseReviewCommand(input?.text)
    if (!command) return false
    const chatId = String(input?.channelId ?? '')
    const fromUid = input?.fromUid
    const record = Object.values(this.state.state.reviews ?? {}).find(review => review.code === command.code
      && review.chatId === chatId && review.status !== 'answered' && review.status !== 'expired')
    if (!fromUid || !settings.allowSenderIds.includes(fromUid)) {
      if (record) await this.sendReviewAck(record, command.answer, { blocked: 'not-allowed' }, client, config)
      return true
    }
    if (!record) {
      // Unknown/foreign code: still consume the message, but tell the operator instead of staying silent.
      if (typeof client?.sendText === 'function') {
        try {
          await client.sendText({ channelId: chatId, channelType: config.octo?.channelType,
            content: `Superagent: 没找到可回复的评估 #${command.code}（可能已过期或不属于本群）` })
        } catch (error) { this.log(`review unknown-code ack failed: ${this.errorText(error)}`) }
      }
      return true
    }
    if (!reviewAnswerable(record)) {
      await this.sendReviewAck(record, command.answer, { blocked: 'expired' }, client, config)
      return true
    }
    const outcome = await this.applyReviewAnswer(record, command.answer, fromUid, config)
    await this.sendReviewAck(record, command.answer, outcome, client, config)
    return true
  }

  /** Apply one operator answer: replay a vetoed signal, start/dismiss a queued Ticket, record the signal label. */
  async applyReviewAnswer(record, answer, by, config) {
    const decision = this.state.decisions?.[record.decisionId]
    const ticket = record.ticketId ? this.state.tickets?.[record.ticketId] : undefined
    const outcome = { ...(record.ticketId ? { ticketId: record.ticketId } : {}) }
    let label
    if (decision) {
      if (answer === 'accept') {
        if (decision.kind === 'ignore') {
          // Rules-only replay is the manual override for a model veto; a rule hard gate still blocks (safety first).
          const replay = record.signalId ? await this.replaySignal(record.signalId) : undefined
          if (replay?.decision?.kind === 'accept' && replay.ticket) {
            outcome.ticketId = replay.ticket.id
            // The replay is rules-only, so an accept means the high-risk hard gate passed. The operator's explicit
            // 接单 starts the rebuilt Ticket the same way accepting a queued one does: executor.enabled is the gate,
            // autoRun is not (that only controls automatic dispatch of new Tickets).
            if (['queued', 'ready'].includes(replay.ticket.status) && config.executor?.enabled === true) {
              outcome.started = true
              void this.autoExecute([replay.ticket.id]).catch(error =>
                this.log(`review replay run ${replay.ticket.id} failed: ${this.errorText(error)}`))
            } else outcome.started = false
          } else outcome.blocked = 'high-risk'
        } else if (ticket) {
          if (['queued', 'ready'].includes(ticket.status) && config.executor?.enabled === true) {
            outcome.started = true
            // The operator explicitly accepted: run it now even though executor.autoRun is off (that is the gate).
            void this.autoExecute([ticket.id]).catch(error => this.log(`review run ${ticket.id} failed: ${this.errorText(error)}`))
          } else outcome.recordedOnly = true
        } else outcome.recordedOnly = true
      } else if (ticket && ['queued', 'ready', 'failed', 'ci-failed', 'deploy-failed'].includes(ticket.status)) {
        const dismissed = await this.dismissTicket({ ticketId: ticket.id, note: `operated by review ${record.code}` })
        if (dismissed?.cleanupFailed) outcome.blocked = 'cleanup'
        else outcome.dismissed = true
      } else if (ticket) outcome.blocked = 'running'
      else outcome.recordedOnly = true
      label = reviewLabelOf(decision.kind, answer)
    }
    const at = new Date().toISOString()
    const humanOutcome = outcome.blocked ?? (outcome.started ? 'started' : outcome.dismissed ? 'dismissed' : 'recorded')
    await this.state.atomic((doc) => {
      doc.reviews = doc.reviews ?? {}
      if (doc.reviews[record.id]) {
        doc.reviews[record.id] = { ...doc.reviews[record.id], status: 'answered', answer, answerAt: at,
          answeredBy: by, outcome: { ...outcome, kind: humanOutcome } }
      }
      if (doc.decisions?.[record.decisionId]) {
        doc.decisions[record.decisionId] = { ...doc.decisions[record.decisionId],
          humanReview: { code: record.code, answer, by, at, outcome: humanOutcome, ...(label ? { label } : {}) } }
      }
    })
    if (label && record.signalId) {
      try { await this.labelSignal(record.signalId, { label, note: `review ${record.code}: ${answer}` }) }
      catch (error) { this.log(`review label failed: ${this.errorText(error)}`) }
      outcome.reviewed = label
    }
    try { await this.refreshInbox() } catch { /* best effort */ }
    return outcome
  }

  /** Group message-sync intake: newest window per watched chat, deduped by message_seq. */
  async pollSync(loaded, { dryRun = false } = {}) {
    const config = loaded.config
    if (!loaded.exists) return { error: 'live.json not found', dryRun, mode: 'sync' }
    if (!dryRun && !config.enabled) return { error: 'live.json enabled=false', dryRun, mode: 'sync' }
    // The same guard runs for dry runs: "Check for new messages" must not report a healthy intake while a live
    // poll would be refused for the same configuration.
    if (config.octo.allowSenderIds.length === 0 && config.octo.allowAnyHuman !== true) {
      return { error: 'octo.allowSenderIds must list the humans allowed to trigger work, or octo.allowAnyHuman must be true', dryRun, mode: 'sync' }
    }
    const client = await this.ensureClient(loaded)
    if (!client) return { error: 'Octo token is not configured', dryRun, mode: 'sync' }

    const result = { mode: 'sync', dryRun, fetched: 0, accepted: [], ignored: [], skipped: [], initialized: [], cursors: {} }
    const records = []
    const mode = config.eval?.mode ?? 'rules'
    const hybrid = mode === 'hybrid'
    const judgeInfo = hybrid ? this.judgeFor(loaded) : {}
    if (hybrid && !judgeInfo.judge && this.judgeDisabledReason !== judgeInfo.reason) {
      this.judgeDisabledReason = judgeInfo.reason
      this.log(`hybrid judge disabled, falling back to rules: ${judgeInfo.reason}`)
    }
    const budget = { left: hybrid ? (Number.isFinite(config.eval?.decision?.maxPerPoll)
      ? Math.max(0, config.eval.decision.maxPerPoll) : 10) : 0 }
    const hybridResult = { judged: 0, ignored: 0, fallbacks: 0 }
    const reviewSettings = this.reviewSettingsOf(config)
    const reviewMode = reviewSettings.enabled && !dryRun
    const reviewQueue = []
    const reviewResult = { asked: 0, sent: 0, failed: 0, answered: 0 }
    const cursors = { ...(this.state.state.channelCursors ?? {}) }
    for (const chatId of config.octo.watchChatIds) {
      let batch
      try { batch = await client.syncMessages({ channelId: chatId, channelType: config.octo.channelType, limit: config.octo.syncLimit }) }
      catch (error) {
        result.error = error instanceof Error ? error.message : String(error)
        this.log(`sync ${chatId} failed: ${result.error}`)
        continue
      }
      const messages = (batch.messages ?? []).filter(message => Number.isFinite(message.messageSeq))
        .sort((left, right) => left.messageSeq - right.messageSeq)
      result.fetched += messages.length
      const maxSeq = messages.length ? messages.at(-1).messageSeq : undefined
      const previous = cursors[chatId]
      if (previous === undefined && !config.octo.backfill) {
        // First sight of this chat: remember where it is now instead of replaying its history.
        if (maxSeq !== undefined) cursors[chatId] = maxSeq
        result.initialized.push({ chatId, cursor: maxSeq ?? 0 })
        result.cursors[chatId] = cursors[chatId] ?? 0
        continue
      }
      const baseline = previous ?? 0
      for (const message of messages) {
        if (message.messageSeq <= baseline) continue
        const candidate = candidateOfSync(message, config)
        // Operator answers are consumed before intake: a command-shaped message must never become a candidate/Ticket.
        if (reviewMode && !candidate.skip) {
          const consumed = await this.handleReviewCommand(candidate, config, client)
          if (consumed) { reviewResult.answered += 1; continue }
        }
        // P1 §2.2: every candidate is recorded first — including the ones the filters are about to drop.
        const signal = dryRun ? undefined : await this.recordSignalSafely(candidate, 'sync', message)
        if (candidate.skip) { result.skipped.push({ seq: message.messageSeq, reason: candidate.skip }); continue }
        if (signal) candidate.signalId = signal.id
        let evaluation
        let built
        try {
          const outcome = await this.evaluateForIntake(candidate, config, judgeInfo.judge, budget)
          evaluation = outcome.evaluation
          built = buildRecords(candidate, evaluation, config, candidate.threadTitle)
          if (outcome.model) {
            built.decision = { ...built.decision, model: outcome.model, evalMode: 'hybrid',
              ...(outcome.model.status === 'ok' ? { actorKind: 'hybrid' } : {}) }
            if (outcome.model.status === 'ok') hybridResult.judged += 1
            if (outcome.modelDecision && outcome.modelDecision !== 'accept') hybridResult.ignored += 1
            if (outcome.fallback) hybridResult.fallbacks += 1
          } else if (outcome.fallback) hybridResult.fallbacks += 1
        } catch (error) {
          if (!dryRun) await this.failSignalSafely(signal, error)
          result.failed = [...(result.failed ?? []), { seq: message.messageSeq, error: error instanceof Error ? error.message : String(error) }]
          this.log(`sync ${chatId} message ${message.messageSeq} failed: ${error instanceof Error ? error.message : String(error)}`)
          continue
        }
        if (evaluation.kind === 'accept') this.attachContext(records, built)
        if (reviewMode) {
          const taken = new Set(Object.values(this.state.state.reviews ?? {}).map(item => item.code))
          for (const queued of reviewQueue) taken.add(queued.code)
          const record = this.reviewRecordOf(built, config, reviewSettings, newReviewCode(taken))
          if (record) reviewQueue.push(record)
        }
        records.push(built)
        if (signal) await this.recordSignalOutcomeSafely(signal, evaluation, built)
        if (evaluation.kind === 'accept') {
          result.accepted.push({ seq: message.messageSeq, sender: candidate.fromUid, title: candidate.text.slice(0, 80),
            ticketId: built.ticket?.id })
        } else result.ignored.push({ seq: message.messageSeq, sender: candidate.fromUid, reason: evaluation.reason })
      }
      if (maxSeq !== undefined) cursors[chatId] = Math.max(baseline, maxSeq)
      result.cursors[chatId] = cursors[chatId] ?? baseline
    }

    // Shadow mode asks the decision model only after the rules have finished judging every message of this poll;
    // hybrid mode already asked per accepted candidate inside the loop (attachShadow is a no-op there).
    const shadow = dryRun ? { judged: 0, failed: 0, skipped: 0, reason: 'dry-run' } : await this.attachShadow(records, loaded)
    result.shadow = shadow
    if (hybrid) result.hybrid = hybridResult

    if (dryRun) {
      this.lastStatus = { phase: 'dry-run', mode: 'sync', at: new Date().toISOString(), ...syncCounts(result), shadow: shadow.judged,
        ...(hybrid ? { hybrid: hybridResult.judged } : {}) }
      return result
    }
    await this.state.atomic((doc) => {
      // Drop cursors of chats that are no longer watched, so switching groups does not leave stale cursors behind.
      doc.channelCursors = Object.fromEntries(Object.entries({ ...(doc.channelCursors ?? {}), ...cursors })
        .filter(([chat]) => config.octo.watchChatIds.includes(chat)))
      absorb(doc, records.filter(record => !record.ticket || repoAcceptsWork(config, record.ticket.repoId)))
      this.queueReviews(doc, reviewQueue)
      doc.lastPollAt = new Date().toISOString()
      doc.lastError = undefined
      // Count only messages newer than the cursor; `fetched` repeats the newest window on every poll.
      doc.events.received += result.accepted.length + result.ignored.length + result.skipped.length
      doc.events.accepted += result.accepted.length
      doc.events.ignored += result.ignored.length
      doc.sources.octo = { state: result.error ? 'error' : 'ready', ...(result.error ? { detail: result.error } : {}),
        at: doc.lastPollAt }
    })
    if (reviewMode && reviewQueue.length) {
      const notice = await this.sendReviewPrompts(reviewQueue, client, config)
      reviewResult.asked = reviewQueue.length
      reviewResult.sent = notice.sent
      reviewResult.failed = notice.failed
    }
    if (reviewMode) result.reviews = reviewResult
    this.lastStatus = { phase: result.error ? 'error' : 'ok', mode: 'sync', at: new Date().toISOString(), ...syncCounts(result),
      shadow: shadow.judged, ...(shadow.skipped ? { shadowSkipped: shadow.skipped } : {}),
      ...(hybrid ? { hybrid: hybridResult.judged, hybridIgnored: hybridResult.ignored } : {}),
      ...(reviewMode ? { reviews: reviewResult.asked } : {}) }
    if (result.accepted.length || result.ignored.length) {
      this.log(`sync poll: fetched ${result.fetched}, accepted ${result.accepted.length}, ignored ${result.ignored.length}`)
    }
    if (config.executor.enabled && config.executor.autoRun && config.paused !== true && config.pausedDispatch !== true) {
      const ids = result.accepted.map(item => item.ticketId).filter(Boolean)
      if (ids.length) this.dispatchQueue = this.autoExecute(ids)
    }
    return result
  }

  /** Bot event-queue intake (kept for deployments whose events carry channel fields). */
  async pollEvents(loaded, { dryRun = false } = {}) {
    const config = loaded.config
    if (!loaded.exists) return this.finish({ error: 'live.json not found', dryRun, mode: 'events' })
    if (!dryRun && !config.enabled) return this.finish({ error: 'live.json enabled=false', dryRun, mode: 'events' })
    const client = await this.ensureClient(loaded)
    if (!client) return this.finish({ error: 'Octo token is not configured', dryRun, mode: 'events' })
    const cursor = this.state.cursor
    const batch = await client.pollEvents({ cursor, limit: MAX_EVENTS })
    const events = Array.isArray(batch.events) ? batch.events : []
    const result = { mode: 'events', dryRun, cursor, fetched: events.length, accepted: [], ignored: [], skipped: [], acked: 0, nextCursor: cursor }
    const records = []
    const mode = config.eval?.mode ?? 'rules'
    const hybrid = mode === 'hybrid'
    const judgeInfo = hybrid ? this.judgeFor(loaded) : {}
    if (hybrid && !judgeInfo.judge && this.judgeDisabledReason !== judgeInfo.reason) {
      this.judgeDisabledReason = judgeInfo.reason
      this.log(`hybrid judge disabled, falling back to rules: ${judgeInfo.reason}`)
    }
    const budget = { left: hybrid ? (Number.isFinite(config.eval?.decision?.maxPerPoll)
      ? Math.max(0, config.eval.decision.maxPerPoll) : 10) : 0 }
    const hybridResult = { judged: 0, ignored: 0, fallbacks: 0 }
    const reviewSettings = this.reviewSettingsOf(config)
    const reviewMode = reviewSettings.enabled && !dryRun
    const reviewQueue = []
    const reviewResult = { asked: 0, sent: 0, failed: 0, answered: 0 }
    let nextCursor = cursor
    for (const event of events) {
      nextCursor = Math.max(nextCursor, Number(event.eventId) || 0)
      const candidate = candidateOf(event, config)
      // Operator answers are consumed before intake: a command-shaped message must never become a candidate/Ticket.
      if (reviewMode && !candidate.skip) {
        const consumed = await this.handleReviewCommand(candidate, config, client)
        if (consumed) { reviewResult.answered += 1; continue }
      }
      // P1 §2.2: record the raw event before judging it; filtered events stay replayable.
      const signal = dryRun ? undefined : await this.recordSignalSafely(candidate, 'events', event)
      if (candidate.skip) { result.skipped.push({ eventId: event.eventId, reason: candidate.skip }); continue }
      if (signal) candidate.signalId = signal.id
      let evaluation
      let built
      try {
        const outcome = await this.evaluateForIntake(candidate, config, judgeInfo.judge, budget)
        evaluation = outcome.evaluation
        // Ignored candidates keep their trigger and decision so the panel can explain why nothing was done.
        built = buildRecords(candidate, evaluation, config, candidate.threadTitle)
        if (outcome.model) {
          built.decision = { ...built.decision, model: outcome.model, evalMode: 'hybrid',
            ...(outcome.model.status === 'ok' ? { actorKind: 'hybrid' } : {}) }
          if (outcome.model.status === 'ok') hybridResult.judged += 1
          if (outcome.modelDecision && outcome.modelDecision !== 'accept') hybridResult.ignored += 1
          if (outcome.fallback) hybridResult.fallbacks += 1
        } else if (outcome.fallback) hybridResult.fallbacks += 1
      } catch (error) {
        await this.failSignalSafely(signal, error)
        result.failed = [...(result.failed ?? []), { eventId: event.eventId, error: this.errorText(error) }]
        this.log(`event ${event.eventId} failed: ${this.errorText(error)}`)
        continue
      }
      if (evaluation.kind === 'accept') result.accepted.push({ eventId: event.eventId, messageId: candidate.messageId, title: candidate.text.slice(0, 80) })
      else result.ignored.push({ eventId: event.eventId, messageId: candidate.messageId, reason: evaluation.reason })
      if (evaluation.kind === 'accept') this.attachContext(records, built)
      if (reviewMode) {
        const taken = new Set(Object.values(this.state.state.reviews ?? {}).map(item => item.code))
        for (const queued of reviewQueue) taken.add(queued.code)
        const record = this.reviewRecordOf(built, config, reviewSettings, newReviewCode(taken))
        if (record) reviewQueue.push(record)
      }
      records.push(built)
      await this.recordSignalOutcomeSafely(signal, evaluation, built)
    }
    result.nextCursor = nextCursor
    // Shadow mode: same contract as the sync path — the rules decided already, the model's answer is only recorded.
    const shadow = dryRun ? { judged: 0, failed: 0, skipped: 0, reason: 'dry-run' } : await this.attachShadow(records, loaded)
    result.shadow = shadow
    if (hybrid) result.hybrid = hybridResult
    if (dryRun) {
      this.lastStatus = { phase: 'dry-run', mode: 'events', at: new Date().toISOString(), ...eventCounts(result), cursor,
        shadow: shadow.judged, ...(hybrid ? { hybrid: hybridResult.judged } : {}) }
      return result
    }
    await this.state.atomic((doc) => {
      absorb(doc, records.filter(record => !record.ticket || repoAcceptsWork(config, record.ticket.repoId)))
      this.queueReviews(doc, reviewQueue)
      doc.cursor = nextCursor
      doc.lastPollAt = new Date().toISOString()
      doc.lastError = undefined
      doc.events.received += events.length
      doc.events.accepted += result.accepted.length
      doc.events.ignored += result.ignored.length
      doc.sources.octo = { state: 'ready', detail: `event cursor ${nextCursor}`, at: doc.lastPollAt }
    })
    for (const event of events) {
      try { await client.ack(event.eventId); result.acked += 1 }
      catch (error) { this.log(`ack ${event.eventId} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    if (reviewMode && reviewQueue.length) {
      const notice = await this.sendReviewPrompts(reviewQueue, client, config)
      reviewResult.asked = reviewQueue.length
      reviewResult.sent = notice.sent
      reviewResult.failed = notice.failed
    }
    if (reviewMode) result.reviews = reviewResult
    this.lastStatus = { phase: 'ok', mode: 'events', at: new Date().toISOString(), ...eventCounts(result), cursor: nextCursor,
      shadow: shadow.judged, ...(shadow.skipped ? { shadowSkipped: shadow.skipped } : {}),
      ...(hybrid ? { hybrid: hybridResult.judged, hybridIgnored: hybridResult.ignored } : {}),
      ...(reviewMode ? { reviews: reviewResult.asked } : {}) }
    this.log(`event poll: fetched ${events.length}, accepted ${result.accepted.length}, ignored ${result.ignored.length}, cursor ${nextCursor}`)
    return result
  }

  /** Run newly accepted tickets through the executor, one at a time (worker → gates → publish when allowPush). */
  async autoExecute(ticketIds) {
    // `paused` is the legacy total switch (intake + dispatch). `pausedDispatch` keeps the queue but dispatches nothing,
    // and a pause that lands mid-queue stops the remaining tickets without touching the one already running.
    const dispatchPaused = () => { const now = this.readConfig().config
      return now.paused === true || now.pausedDispatch === true }
    if (dispatchPaused()) { this.log('auto-run skipped: dispatch paused'); return [] }
    const execute = this.deps.executeTicket ?? (await import('./executor.js')).executeTicket
    const dispatched = []
    for (const ticketId of ticketIds) {
      if (dispatchPaused()) { this.log(`auto-run ${ticketId} skipped: dispatch paused`); break }
      const ticketRepoId = this.state.tickets[ticketId]?.repoId
      if (!repoAcceptsWork(this.readConfig().config, ticketRepoId)) {
        this.log(`auto-run ${ticketId} skipped: repository disabled`); continue
      }
      try {
        this.log(`auto-run ticket ${ticketId}`)
        const run = await execute({ ctx: this.ctx, engine: this, ticketId, dryRun: false, trigger: 'auto',
          log: line => this.log(`executor ${ticketId}: ${line}`) })
        this.log(`auto-run ${ticketId}: ${run?.status ?? 'unknown'}`)
        dispatched.push(ticketId)
      } catch (error) {
        this.log(`auto-run ${ticketId} failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return dispatched
  }

  finish(result) {
    this.lastStatus = { phase: result.error ? 'error' : 'idle', ...(result.mode ? { mode: result.mode } : {}), ...(result.error ? { error: result.error } : {}) }
    return result
  }

  status() {
    const loaded = this.readConfig()
    const mode = loaded.config.octo.intake === 'events' ? 'events' : 'sync'
    const paused = loaded.config.paused === true
    const pausedIntake = paused || loaded.config.pausedIntake === true
    const pausedDispatch = paused || loaded.config.pausedDispatch === true
    const windowStart = new Date(Date.now() - DAY_MS).toISOString()
    const flow24h = flowOf(this.state.state, windowStart)
    // Runs that failed inside the 24h window: a run-level number, deliberately separate from the Ticket-stage count.
    const runs24hFailed = (this.state.runs ?? []).filter(run => run.status === 'failed'
      && run.startedAt && run.startedAt >= windowStart).length
    const config = loaded.config
    const tickets = Object.values(this.state.tickets)
    const stageCounts = { queued: 0, working: 0, waiting: 0, failed: 0, done: 0 }
    // Accepted tickets are done; manual repositories treat `merged` as waiting for a person (see ticketStageOf).
    for (const ticket of tickets) stageCounts[ticketStageOf(config, ticket)] += 1
    const waitingHuman = stageCounts.waiting
    const latest = latestTicketOf(this.state.state)
    const repos = configRepos(config)
    const verifySeconds = Math.min(...repos.map(repo => repo.gitlab.verifySeconds ?? 120))
    const shadow = this.shadowReadiness(config, loaded.tokens)
    return {
      engine: {
        phase: this.lastStatus.phase,
        mode,
        running: this.started,
        paused,
        pausedIntake,
        pausedDispatch,
        dryRunAvailable: true,
        cursor: this.state.cursor,
        channelCursors: this.state.state.channelCursors ?? {},
        lastPollAt: this.state.state.lastPollAt,
        lastError: this.state.state.lastError ?? this.lastStatus.error,
        autoVerifySeconds: verifySeconds,
        events: this.state.events,
        last: this.lastStatus,
      },
      config: redactedLiveConfig(loaded),
      counts: {
        threads: Object.keys(this.state.threads).length,
        triggers: Object.keys(this.state.triggers).length,
        decisions: Object.keys(this.state.decisions).length,
        tickets: tickets.length,
        runs: this.state.runs.length,
        // Tickets a human has to look at: deployed/mr-open/ci-passed (waiting) and failed states; a Ticket the
        // person already accepted on UAT is excluded from the waiting half.
        needsHuman: waitingHuman + stageCounts.failed,
        open: tickets.length - stageCounts.done,
      },
      // P0-5: the actionable inbox counts the new client prefers; `counts.needsHuman` keeps its old meaning for
      // older clients (contract §1.5).
      inbox: this.inboxCounts(),
      paused,
      load: { running: stageCounts.working, queued: stageCounts.queued, waiting: waitingHuman,
        failed: stageCounts.failed, paused, pausedIntake, pausedDispatch },
      flow24h,
      runs24hFailed,
      rules24h: rules24hOf(this.state.state, windowStart),
      sources: sourceStatuses(loaded, this.state.state, flow24h),
      repos: repos.map(repo => repoSummary(loaded, repo)),
      defaultRepo: config.defaultRepo,
      eval: {
        mode: config.eval?.mode ?? 'rules',
        rules: EVAL_RULES.map(rule => ({ ...rule })),
        // Shadow-mode judge (judge.js): configuration readiness + in-memory call counters. No secret is exposed.
        decision: {
          enabled: shadow.enabled,
          ready: shadow.ready,
          ...(shadow.reason ? { disabledReason: shadow.reason } : {}),
          endpointConfigured: !!config.eval?.decision?.endpoint,
          model: config.eval?.decision?.model ?? '',
          tokenConfigured: !!loaded.tokens?.decision,
          tokenSource: loaded.tokens?.decisionSource ?? null,
          timeoutMs: config.eval?.decision?.timeoutMs ?? 6000,
          acceptAt: config.eval?.decision?.acceptAt ?? 0.8,
          rejectAt: config.eval?.decision?.rejectAt ?? 0.2,
          riskAt: config.eval?.decision?.riskAt ?? 0.5,
          maxPerPoll: config.eval?.decision?.maxPerPoll ?? 10,
          questions: JUDGE_QUESTIONS_VERSION,
        },
        judge: { ...this.judgeStats },
        hybrid: { ...this.hybridStats },
      },
      // Group confirmation loop: settings + persisted row counts (pending/sent/answered/expired/failed).
      review: { ...this.reviewSettingsOf(config), counts: this.reviewCounts() },
      prompts: {
        workerBrief: latest ? workerBrief(latest, config, ticketRepo(config, latest)) : '',
        note: '内置提示词，随代码版本',
      },
      tickets: this.state.state.ticketOrder.slice(-20).reverse().map(id => this.state.tickets[id]).filter(Boolean)
        .map(ticket => decorateTicket(config, ticket)),
      runs: (this.state.runs ?? []).slice(0, 10),
      triggers: Object.values(this.state.triggers).sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
        .slice(0, 10).map(trigger => ({ id: trigger.id, at: trigger.at, text: trigger.text, seq: trigger.seq,
          channelId: trigger.channel?.address?.channelId ?? trigger.threads?.[0], actor: trigger.actor?.id,
          decision: trigger.disposition?.decisionId })),
      threads: Object.values(this.state.threads).sort((left, right) => (right.lastAt ?? '').localeCompare(left.lastAt ?? ''))
        .slice(0, 10).map(thread => ({ key: thread.key, title: thread.title, lastAt: thread.lastAt })),
      decisions: Object.values(this.state.decisions).sort((left, right) => (right.at ?? '').localeCompare(left.at ?? ''))
        .slice(0, 20).map(decision => ({ id: decision.id, at: decision.at, kind: decision.kind, strength: decision.strength,
          rules: decision.rules, reason: decision.reason, ticketId: decision.ticketId, threadKey: decision.threadKey })),
    }
  }

  /** Ticket ids in creation order without duplicates; ids missing from the document are skipped. */
  ticketIdsInOrder() {
    const seen = new Set()
    const ids = []
    for (const id of this.state.state.ticketOrder ?? []) {
      if (seen.has(id) || !this.state.tickets[id]) continue
      seen.add(id)
      ids.push(id)
    }
    // Tickets written outside ticketOrder (defensive) stay visible at the end.
    for (const id of Object.keys(this.state.tickets)) {
      if (seen.has(id)) continue
      seen.add(id)
      ids.push(id)
    }
    return ids
  }

  /** `GET engine/tickets?stage=` — raw tickets newest first plus per-stage counts (contract §4). */
  ticketsView({ stage = 'all' } = {}) {
    const loaded = this.readConfig()
    const config = loaded.config
    const tickets = this.ticketIdsInOrder().map(id => this.state.tickets[id]).reverse()
    const counts = { all: tickets.length, queued: 0, working: 0, waiting: 0, failed: 0, done: 0 }
    for (const ticket of tickets) counts[ticketStageOf(config, ticket)] += 1
    const items = (STAGES.includes(stage) ? tickets.filter(ticket => ticketStageOf(config, ticket) === stage) : tickets)
      .map(ticket => decorateTicket(config, ticket))
    return { items, counts, paused: config.paused === true,
      pausedIntake: config.pausedIntake === true, pausedDispatch: config.pausedDispatch === true }
  }

  /**
   * `POST engine/route` — preview routing for a draft Ticket without creating anything. The creation form calls this
   * while the operator types: it shows the automatic work type/deliverable/capabilities/backend and lets them override
   * the deliverable or backend. The same resolver runs again at execution time, so preview and run agree.
   */
  routePreview({ title = '', body = '', selection } = {}) {
    return routePreviewOf({ title, body, config: this.readConfig().config, selection })
  }

  /**
   * `GET engine/ticket/:id` — the ticket with its full runs (newest first, from the operation ledger; the thin
   * `doc.runs` index is the fallback for pre-P1 data), the trigger/decision that made it, its thread, its latest
   * acceptance record and its activity log (P1 §3.2/§4.2/§5).
   */
  ticketView(id) {
    const ticket = this.state.tickets?.[id]
    if (!ticket) return undefined
    const operationRuns = this.operations?.loaded ? this.operations.list({ ticketId: id, limit: 50 }) : []
    const runs = operationRuns.length
      ? operationRuns
      : (this.state.runs ?? []).filter(run => run.ticketId === id)
        .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
    const decision = this.decisionOfTicket(ticket)
    const trigger = this.triggerOfTicket(ticket, decision)
    const threadKey = ticket.origin?.threadKey ?? trigger?.threads?.[0] ?? decision?.threadKey
    const thread = threadKey ? this.state.threads?.[threadKey] ?? null : null
    const config = this.readConfig().config
    // Before the next run the panel can show who routing would pick (and with which profile); after a run the Ticket
    // carries the executed route instead. Terminal Tickets have nothing to preview.
    const terminal = ['closed', 'dismissed', 'deployed', 'merged'].includes(ticket.status)
    const selection = ticket.routeSelection && typeof ticket.routeSelection === 'object' ? ticket.routeSelection : {}
    const preview = terminal ? null : resolveRoute({ ticket, config, override: selection.backend,
      deliverableOverride: selection.deliverable })
    return {
      ticket: decorateTicket(config, ticket), runs, trigger: trigger ?? null, decision: decision ?? null, thread,
      acceptance: this.acceptance?.loaded ? this.acceptance.get(id) ?? null : null,
      activities: activitiesOf(ticket),
      delivery: deliverySummary(ticket),
      evidence: this.evidence?.get(id) ? { rounds: this.evidence.get(id).rounds.length,
        latest: this.evidence.get(id).rounds.at(-1)?.id } : null,
      route: ticket.route ?? null,
      routeSelection: Object.keys(selection).length ? selection : null,
      routePreview: preview
        ? { workType: preview.workType, profile: preview.profile, backend: preview.backend,
          deliverable: preview.deliverable, capabilities: preview.capabilities, mode: preview.mode,
          applied: preview.applied, reason: preview.reason, enabled: preview.enabled,
          deliverables: DELIVERABLES }
        : null,
    }
  }

  /**
   * `GET engine/ticket/:id/diff?runId=` — the run's worktree changes as a unified diff, read-only (P1 §3.2 evidence).
   * The worktree is the source of truth while it lives, so nothing is stored in the operation ledger; a Ticket whose
   * worktree was cleaned up answers `available:false` instead of pretending the run changed nothing.
   * → { ticketId, runId?, ...worktreeDiff } | undefined when the Ticket does not exist.
   */
  async ticketDiff(ticketId, { runId, path } = {}) {
    const ticket = this.state.tickets?.[ticketId]
    if (!ticket) return undefined
    const operationRuns = this.operations?.loaded ? this.operations.list({ ticketId, limit: 50 }) : []
    const runs = operationRuns.length
      ? operationRuns
      : (this.state.runs ?? []).filter(run => run.ticketId === ticketId)
        .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
    const wanted = typeof runId === 'string' && runId ? runs.find(run => run.id === runId) : undefined
    // A publish/verify run can be recorded without its own worktree fields; the Ticket still names the one it used.
    const run = wanted ?? runs.find(candidate => typeof candidate.worktree === 'string' && candidate.worktree) ?? runs[0]
    const worktree = (typeof run?.worktree === 'string' && run.worktree) || ticket.links?.worktree
    const result = await worktreeDiff({ worktree, baseSha: run?.baseSha, path })
    return { ticketId, ...(run?.id ? { runId: run.id } : {}), ...result }
  }

  // ---------------------------------------------------------------------------
  // P1-1 signal views and replay (contract §2.2). Missing stores/fields degrade to empty views; nothing throws.
  // ---------------------------------------------------------------------------

  /** `GET engine/signals?status&source&q&repo&reason&from&to&limit&offset` — newest-first raw facts plus counts. */
  signalsView({ status, source, q = '', repoId = '', reason = '', from = '', to = '', limit = 20, offset = 0 } = {}) {
    const all = this.signals?.loaded ? this.signals.all() : []
    const query = String(q ?? '').trim().toLowerCase()
    // The message body lives in `candidate.text`/`payload.text`; `textPreview` is only a derived row field, so searching
    // it alone made body-text queries return zero rows (review P2 AC-06).
    const searchable = signal => [signal.candidate?.text, signal.payload?.text, signal.textPreview,
      signal.candidate?.threadTitle, signal.source, signal.reason, signal.skipReason, signal.error]
      .map(value => (typeof value === 'string' ? value
        : value === undefined || value === null ? '' : JSON.stringify(value)))
      .join(' ').toLowerCase()
    const reasonQuery = String(reason ?? '').trim().toLowerCase()
    // AC-06: repository, reason and time range are applied with the text filters before counts and pagination, so the
    // page boundaries and `total` describe one intersection. A signal belongs to a repository through its Ticket.
    const scoped = (source ? all.filter(signal => signal.source === source) : all)
      .filter(signal => !from || String(signal.receivedAt ?? signal.occurredAt ?? '') >= String(from))
      .filter(signal => !to || String(signal.receivedAt ?? signal.occurredAt ?? '') <= String(to))
      .filter(signal => !repoId || this.repoIdOfSignal(signal) === repoId)
      .filter(signal => !reasonQuery || [signal.reason, signal.skipReason, signal.error]
        .some(value => JSON.stringify(value ?? '').toLowerCase().includes(reasonQuery)))
      .filter(signal => !query || searchable(signal).includes(query))
      .sort((left, right) => String(right.receivedAt ?? '').localeCompare(String(left.receivedAt ?? '')))
    const counts = { all: 0, pending: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 }
    for (const signal of scoped) {
      counts.all += 1
      if (Object.hasOwn(counts, signal.status)) counts[signal.status] += 1
    }
    // P2 §3.1: quality labels on the most recent signals — the panel's "correct/false wake/missed wake" header.
    counts.labels = this.labelCounts(all)
    const filtered = SIGNAL_STATUSES.includes(status) ? scoped.filter(signal => signal.status === status) : scoped
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20
    return {
      items: filtered.slice(start, start + size).map(signal => this.signalRow(signal)),
      total: filtered.length,
      counts,
      filters: { q: String(q ?? ''), source: String(source ?? ''), repoId: String(repoId ?? ''),
        reason: String(reason ?? ''), from: String(from ?? ''), to: String(to ?? ''), status: status ?? 'all' },
    }
  }

  /** The configured repository a decision belongs to: its own repoId first (ignored rows have no Ticket), then Ticket. */
  repoIdOfDecision(decision) {
    return repoIdOfDecision(this.state, this.readConfig().config, decision)
  }

  /** The configured repository a raw signal belongs to, via the Ticket its decision/trigger produced. */
  repoIdOfSignal(signal) {
    const ticketId = this.ticketIdOfSignal(signal)
    const ticket = ticketId ? this.state.tickets?.[ticketId] : undefined
    if (!ticket) return undefined
    try { return ticketRepo(this.readConfig().config, ticket).id } catch { return ticket.repoId }
  }

  /** Label histogram over the newest signals (all sources; only labeled rows count). */
  labelCounts(signals) {
    const labels = { correct: 0, false_wake: 0, missed_wake: 0, cleared: 0 }
    const recent = [...signals]
      .sort((left, right) => String(right.receivedAt ?? '').localeCompare(String(left.receivedAt ?? '')))
      .slice(0, LABEL_COUNTS_WINDOW)
    for (const signal of recent) {
      const rows = Array.isArray(signal.labels) ? signal.labels : []
      for (const row of rows) if (Object.hasOwn(labels, row?.label)) labels[row.label] += 1
    }
    return labels
  }

  /**
   * `POST engine/signal/:id/label` (P2 §3.1) — append one human quality label to a raw signal. Labels are append-only
   * and bounded; they never change the signal's classification, so a mislabel is corrected by adding another row.
   * → { signal } | { missing:true } | { invalid:string }
   */
  async labelSignal(signalId, { label, note } = {}) {
    if (!this.signals?.loaded) await this.signals.load()
    const signal = this.signals.get(signalId)
    if (!signal) return { missing: true }
    if (!SIGNAL_LABELS.includes(label)) return { invalid: `标注必须是 ${SIGNAL_LABELS.join(' / ')} 之一` }
    const entry = { id: recordId('lbl'), label, at: new Date().toISOString(), actorKind: 'user' }
    if (typeof note === 'string' && note.trim()) entry.note = note.trim().slice(0, SIGNAL_NOTE_MAX)
    const labels = [...(Array.isArray(signal.labels) ? signal.labels : []), entry].slice(-MAX_SIGNAL_LABELS)
    const updated = await this.markSignal(signal, { labels })
    return { signal: updated ?? signal }
  }

  /** One signal row for the sources page: preview text and the Ticket it did (or did not) become. */
  signalRow(signal) {
    const ticketId = this.ticketIdOfSignal(signal)
    return {
      id: signal.id,
      source: signal.source,
      type: signal.type,
      status: signal.status,
      ...(signal.skipReason ? { skipReason: signal.skipReason } : {}),
      ...(signal.occurredAt ? { occurredAt: signal.occurredAt } : {}),
      receivedAt: signal.receivedAt,
      textPreview: preview(signal.candidate?.text ?? signal.payload?.text ?? '', 160),
      ...(this.repoIdOfSignal(signal) ? { repoId: this.repoIdOfSignal(signal) } : {}),
      ...(signal.decisionId ? { decisionId: signal.decisionId } : {}),
      ...(ticketId ? { ticketId } : {}),
      labels: Array.isArray(signal.labels) ? signal.labels : [],
    }
  }

  /** The Ticket a signal is evidence of, if any (through its decision, else through the trigger it created). */
  ticketIdOfSignal(signal) {
    const decision = signal?.decisionId ? this.state.decisions?.[signal.decisionId] : undefined
    if (decision?.ticketId && this.state.tickets?.[decision.ticketId]) return decision.ticketId
    const triggerId = signal?.triggerId ?? decision?.triggerIds?.[0]
    if (!triggerId) return undefined
    const ticket = Object.values(this.state.tickets ?? {}).find(item => item.origin?.triggerId === triggerId)
    return ticket?.id
  }

  /** `GET engine/signal/:id` — the raw fact plus the decision/trigger/ticket it produced (each null when absent). */
  signalView(id) {
    const signal = this.signals?.loaded ? this.signals.get(id) : undefined
    if (!signal) return undefined
    const decision = signal.decisionId ? this.state.decisions?.[signal.decisionId] : undefined
    const triggerId = signal.triggerId ?? decision?.triggerIds?.[0]
    const trigger = triggerId ? this.state.triggers?.[triggerId] : undefined
    const ticketId = decision?.ticketId ?? this.ticketIdOfSignal(signal)
    const ticket = ticketId ? this.state.tickets?.[ticketId] : undefined
    return { signal, decision: decision ?? null, trigger: trigger ?? null, ticket: ticket ?? null }
  }

  /**
   * `POST engine/signal/:id/replay` — re-judge a skipped/ignored/failed signal with the *current* rules (P1 §2.2).
   * Only those three states are replayable; a replay that accepts creates the Ticket the first pass filtered out.
   * Idempotent per pipeline version: replaying the same signal twice returns the first replayed Decision instead of
   * building a second Ticket.
   * → { signal, decision, ticket? } | { missing:true } | { invalid:string }
   */
  async replaySignal(id) {
    if (!this.signals?.loaded) await this.signals.load()
    const signal = this.signals.get(id)
    if (!signal) return { missing: true }
    const version = pipelineVersion()
    // Idempotency first: a signal already re-judged by this pipeline returns that Decision (and Ticket), wherever its
    // status has since moved — so a double click can never build a second Ticket.
    const previous = Object.values(this.state.decisions ?? {})
      .find(decision => decision.actorKind === 'replay' && decision.signalId === id && decision.pipelineVersion === version)
    if (previous) {
      const ticket = previous.ticketId ? this.state.tickets?.[previous.ticketId] : undefined
      return { signal, decision: previous, ...(ticket ? { ticket } : {}) }
    }
    if (!REPLAYABLE_SIGNAL_STATUSES.includes(signal.status)) {
      return { invalid: `信号 ${id} 当前状态是 ${signal.status}，只有被过滤/忽略/失败的信号可以重放` }
    }
    const loaded = this.safeConfig()
    const config = loaded.config
    if (!config) return { invalid: 'live.json 不可用，无法重放信号' }
    const candidate = this.candidateOfSignal(signal, config)
    // The replay is a *new* judgement: it happens now (the original event time survives on the signal itself).
    candidate.at = new Date().toISOString()
    let evaluation
    let built
    try {
      evaluation = evaluate(candidate, config)
      built = buildRecords(candidate, evaluation, config, candidate.threadTitle)
    } catch (error) {
      await this.failSignalSafely(signal, error)
      return { invalid: `重放信号 ${id} 失败：${this.errorText(error)}` }
    }
    // The replay is a distinct actor from the automatic rules: same rules, but a human asked for this judgement.
    built.decision = { ...built.decision, actorKind: 'replay', signalId: signal.id, pipelineVersion: version,
      replayedAt: new Date().toISOString() }
    built.trigger = { ...built.trigger, evidenceEntryPoint: 'manual' }
    // A replayed accept must not create a second Ticket for a trigger that already produced one.
    const ownedTicket = signal.triggerId
      ? Object.values(this.state.tickets ?? {}).find(ticket => ticket.origin?.triggerId === signal.triggerId)
      : undefined
    if (evaluation.kind === 'accept' && ownedTicket) {
      built.decision = { ...built.decision, ticketId: ownedTicket.id }
      built.ticket = undefined
    }
    // Shadow mode records the model's opinion on the re-judged signal too; the replay itself still follows the rules.
    await this.attachShadow([built], loaded)
    await this.state.atomic((doc) => {
      if (repoAcceptsWork(config, built.ticket?.repoId)) absorb(doc, [built])
      const ticketId = built.ticket?.id ?? ownedTicket?.id
      const ticket = ticketId ? doc.tickets?.[ticketId] : undefined
      if (ticket) {
        appendActivity(ticket, {
          kind: 'trigger', actorKind: 'user', from: signal.status, to: evaluation.kind,
          detail: `重放原始信号 ${signal.id}（${version}）`,
          refs: { signalId: signal.id, decisionId: built.decision.id },
        })
      }
    })
    const updated = await this.markSignal(signal, {
      status: evaluation.kind === 'accept' ? 'processed' : 'ignored',
      attempts: (signal.attempts ?? 0) + 1,
      decisionId: built.decision.id,
      triggerId: built.trigger.id,
      ...(evaluation.kind === 'accept' ? {} : { skipReason: decisionCodeOf(built.decision) }),
      error: undefined,
    })
    const ticketId = built.ticket?.id ?? ownedTicket?.id
    const ticket = ticketId ? this.state.tickets?.[ticketId] : undefined
    return { signal: updated ?? signal, decision: built.decision, ...(ticket ? { ticket } : {}) }
  }

  /** `GET engine/operations?ticketId&limit` — full operation records, newest first (the status view stays light). */
  operationsView({ ticketId, status, limit = 20 } = {}) {
    if (!this.operations?.loaded) return { items: [] }
    return { items: this.operations.list({ ticketId, status, limit }) }
  }

  /** `GET engine/evidence/:ticketId` — durable delivery rounds (AC-08); survives worktree cleanup and ledger trimming. */
  evidenceView(ticketId) {
    return this.evidence?.get(ticketId) ?? undefined
  }

  /** `GET engine/evidence/:ticketId/compare?from=&to=` — file/gate/acceptance changes between two rounds (AC-09). */
  evidenceCompare(ticketId, from, to) {
    return this.evidence?.compare(ticketId, from, to) ?? undefined
  }

  /** `GET engine/operation/:id` — one full operation record (missing ids map to 404 in the entry point). */
  operationView(id) {
    const operation = this.operations?.loaded ? this.operations.get(id) : undefined
    return operation ? { operation } : undefined
  }

  // ---------------------------------------------------------------------------
  // P2-9 run-quality rollup (p2c §1): one snapshot over the operation/acceptance/signal ledgers for 24h/7d/all.
  // Token/cost data is not available from the host yet, so `cost` is a fixed "unavailable" placeholder.
  // ---------------------------------------------------------------------------

  /**
   * `GET engine/metrics?window=` — aggregate run quality over one window. Tolerates empty/missing ledgers and old
   * records (a run without `stopReason` falls back to its status), so the overview card can render before any data.
   * @param {{window?: '24h'|'7d'|'all'}} [options]
   */
  metricsView({ window = '24h' } = {}) {
    const selected = Object.hasOwn(METRICS_WINDOWS, window) || window === 'all' ? window : '24h'
    const windowMs = METRICS_WINDOWS[selected]
    const generatedAt = new Date().toISOString()
    const windowStart = windowMs === undefined ? undefined : new Date(Date.now() - windowMs).toISOString()
    const inWindow = value => !windowStart || (typeof value === 'string' && value !== '' && value >= windowStart)

    const tickets = this.state?.tickets ?? {}
    const runMap = new Map()
    for (const run of this.operations?.loaded ? this.operations.all() : []) {
      if (run && typeof run === 'object' && run.id) runMap.set(run.id, run)
    }
    const runs = [...runMap.values()].filter(run => inWindow(run.startedAt || run.completedAt))

    // --- runs: classification + trigger/stop-reason histograms ---------------------------------------------
    const runCounts = { total: runs.length, succeeded: 0, failed: 0, stopped: 0, interrupted: 0, parked: 0,
      running: 0, repaired: 0, repairSucceeded: 0, repairExhausted: 0 }
    const triggers = {}
    const stopReasons = {}
    const failures = new Map()
    const durationsByRepo = new Map()
    const durations = []
    const repoRows = new Map()
    for (const run of runs) {
      const category = runCategoryOf(run)
      runCounts[category] += 1
      const trigger = typeof run.trigger === 'string' && run.trigger ? run.trigger : 'manual'
      triggers[trigger] = (triggers[trigger] ?? 0) + 1
      const stopReason = typeof run.stopReason === 'string' && run.stopReason ? run.stopReason : 'unknown'
      stopReasons[stopReason] = (stopReasons[stopReason] ?? 0) + 1
      if (Number(run.repair?.attempts) > 0) runCounts.repaired += 1
      if (run.repair?.status === 'succeeded') runCounts.repairSucceeded += 1
      if (run.repair?.status === 'exhausted') runCounts.repairExhausted += 1
      // Failure modes: the error text of failed/stopped runs, grouped after whitespace collapse + clip 120.
      if (category === 'failed' || category === 'stopped') {
        const reason = clipReason(run.error) || (typeof run.stopReason === 'string' && run.stopReason) || 'unknown'
        const at = typeof run.completedAt === 'string' ? run.completedAt : run.startedAt
        const entry = failures.get(reason) ?? { reason, count: 0, lastAt: undefined }
        entry.count += 1
        if (typeof at === 'string' && (!entry.lastAt || at > entry.lastAt)) entry.lastAt = at
        failures.set(reason, entry)
      }
      // Duration only for runs that actually ended (parked/running have no meaningful elapsed time yet).
      let durationMs
      if (run.status !== 'running' && run.status !== 'waiting_for_human' && typeof run.completedAt === 'string') {
        const start = Date.parse(run.startedAt ?? '')
        const end = Date.parse(run.completedAt)
        if (Number.isFinite(start) && Number.isFinite(end) && end >= start) durationMs = end - start
      }
      if (durationMs !== undefined) durations.push(durationMs)
      // Per-repository rollup (the ticket owns repoId; a run whose ticket is gone counts as `default`).
      const ticket = run.ticketId ? tickets[run.ticketId] : undefined
      const repoId = typeof ticket?.repoId === 'string' && ticket.repoId ? ticket.repoId : 'default'
      const repo = repoRows.get(repoId) ?? { repoId, total: 0, failed: 0 }
      repo.total += 1
      if (category === 'failed') repo.failed += 1
      repoRows.set(repoId, repo)
      if (durationMs !== undefined) {
        if (!durationsByRepo.has(repoId)) durationsByRepo.set(repoId, [])
        durationsByRepo.get(repoId).push(durationMs)
      }
    }
    durations.sort((left, right) => left - right)
    const totalMs = durations.reduce((sum, value) => sum + value, 0)
    const duration = {
      avgMs: durations.length ? Math.round(totalMs / durations.length) : 0,
      p50Ms: percentileOf(durations, 0.5),
      p95Ms: percentileOf(durations, 0.95),
      totalMs,
    }
    const failureReasons = [...failures.values()]
      .sort((left, right) => right.count - left.count
        || String(right.lastAt ?? '').localeCompare(String(left.lastAt ?? ''))
        || String(left.reason).localeCompare(String(right.reason)))
      .slice(0, METRICS_FAILURE_LIMIT)
    const byRepo = [...repoRows.values()].map((row) => {
      const repoDurations = durationsByRepo.get(row.repoId) ?? []
      const rowTotal = repoDurations.reduce((sum, value) => sum + value, 0)
      return { ...row, ...(repoDurations.length ? { avgMs: Math.round(rowTotal / repoDurations.length) } : {}) }
    }).sort((left, right) => right.total - left.total || String(left.repoId).localeCompare(String(right.repoId)))

    // --- acceptance: rounds started in the window, then the human outcome -----------------------------------
    const acceptance = { rounds: 0, delivered: 0, failed: 0, errored: 0, accepted: 0, rejected: 0, avgRoundsToAccept: 0 }
    const acceptedRoundCounts = []
    for (const record of this.acceptance?.loaded ? this.acceptance.all() : []) {
      const rounds = Array.isArray(record?.rounds) ? record.rounds : []
      const windowRounds = rounds.filter(round => inWindow(round?.startedAt))
      acceptance.rounds += windowRounds.length
      for (const round of windowRounds) {
        if (round.status === 'delivered') acceptance.delivered += 1
        else if (round.status === 'failed') acceptance.failed += 1
        else if (round.status === 'errored') acceptance.errored += 1
      }
      // A human decision is a record-level fact (acceptedAt/rejectedAt); legacy records may only carry it on a round.
      const roundDecision = decision => rounds.some(round => round?.userDecision?.decision === decision && inWindow(round.startedAt))
      if (record?.status === 'accepted' && (!windowStart || inWindow(record.acceptedAt) || roundDecision('accepted'))) {
        acceptance.accepted += 1
        let acceptedRound = 0
        for (let index = rounds.length - 1; index >= 0; index -= 1) {
          if (rounds[index]?.userDecision?.decision === 'accepted') { acceptedRound = index + 1; break }
          if (index === 0 && !acceptedRound) acceptedRound = rounds.length || 1
        }
        acceptedRoundCounts.push(acceptedRound || 1)
      }
      if (record?.status === 'rejected' && (!windowStart || inWindow(record.rejectedAt) || roundDecision('rejected'))) {
        acceptance.rejected += 1
      }
    }
    if (acceptedRoundCounts.length) {
      const sum = acceptedRoundCounts.reduce((total, value) => total + value, 0)
      acceptance.avgRoundsToAccept = Math.round((sum / acceptedRoundCounts.length) * 100) / 100
    }

    // --- signals: raw facts plus their human quality labels ------------------------------------------------
    const signals = { total: 0, processed: 0, ignored: 0, skipped: 0, failed: 0,
      labels: { correct: 0, false_wake: 0, missed_wake: 0, cleared: 0 } }
    for (const signal of this.signals?.loaded ? this.signals.all() : []) {
      if (!inWindow(signal?.receivedAt)) continue
      signals.total += 1
      if (['processed', 'ignored', 'skipped', 'failed'].includes(signal.status)) signals[signal.status] += 1
      for (const label of Array.isArray(signal.labels) ? signal.labels : []) {
        if (Object.hasOwn(signals.labels, label?.label)) signals.labels[label.label] += 1
      }
    }

    return {
      window: selected,
      ...(windowStart ? { windowStart } : {}),
      generatedAt,
      runs: runCounts,
      duration,
      triggers,
      stopReasons,
      failureReasons,
      byRepo,
      acceptance,
      signals,
      cost: { available: false, note: METRICS_COST_NOTE },
    }
  }

  // ---------------------------------------------------------------------------
  // P1-3 acceptance rounds: the engine owns the human side (accept/reject/close/verify) of the ledger the executor
  // fills round by round; `ticketView.acceptance` is what the panel renders.
  // ---------------------------------------------------------------------------

  /** Mirror a human accept/reject onto the latest acceptance round (creating the record when the executor made none). */
  async recordAcceptanceDecision(ticketId, { ok = true, note, intents = [], at } = {}) {
    if (!this.acceptance?.loaded) return undefined
    const ticket = this.state.tickets?.[ticketId]
    const decision = ok ? 'accepted' : 'rejected'
    const when = typeof at === 'string' && at ? at : new Date().toISOString()
    const cleanNote = typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : undefined
    const cleanIntents = (Array.isArray(intents) ? intents : []).filter(value => ACCEPTANCE_INTENTS.includes(value)).slice(0, 5)
    return this.acceptance.update(ticketId, (record) => {
      record.status = decision
      if (ok) record.acceptedAt = when
      else record.rejectedAt = when
      const latest = Array.isArray(record.rounds) ? record.rounds.at(-1) : undefined
      if (latest) {
        latest.userDecision = {
          decision,
          at: when,
          ...(cleanNote ? { note: cleanNote } : {}),
          ...(cleanIntents.length ? { intents: cleanIntents } : {}),
        }
      }
      return record
    }, { requirement: typeof ticket?.title === 'string' ? ticket.title.slice(0, 500) : undefined })
  }

  /**
   * P1 §4.2: a successful verification (deployed/merged) completes the latest round. Guarded by `verifying`, so it is
   * idempotent no matter how many verification passes observe the same deployment.
   */
  async markAcceptanceDelivered(ticketId) {
    if (!this.acceptance?.loaded) return undefined
    const record = this.acceptance.get(ticketId)
    if (!record) return undefined
    const latest = Array.isArray(record.rounds) ? record.rounds.at(-1) : undefined
    if (!latest || latest.status !== 'verifying') return record
    return this.acceptance.update(ticketId, (current) => {
      const round = Array.isArray(current.rounds) ? current.rounds.at(-1) : undefined
      if (round && round.status === 'verifying') {
        round.status = 'delivered'
        round.completedAt = round.completedAt ?? new Date().toISOString()
      }
      return current
    })
  }

  /** `GET engine/search?q=` — cross-record lookup over the live state (tickets, threads, message text). */
  searchView(query = '') {
    const q = String(query ?? '').trim().toLowerCase()
    if (!q) return { query: '', tickets: [], threads: [], triggers: [], total: 0 }
    const match = value => String(value ?? '').toLowerCase().includes(q)
    const config = this.readConfig().config
    const tickets = this.ticketIdsInOrder().map(id => this.state.tickets[id]).filter(Boolean)
      .filter(ticket => match(ticket.title) || match(ticket.body))
      .sort((left, right) => String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? '')))
      .slice(0, 6)
      .map(ticket => ({ id: ticket.id, title: ticket.title ?? '', status: ticket.status ?? '',
        repoId: ticketRepo(config, ticket)?.id, updatedAt: ticket.updatedAt ?? ticket.createdAt }))
    const threads = Object.values(this.state.threads ?? {}).filter(thread => match(thread.title))
      .sort((left, right) => String(right.lastAt ?? '').localeCompare(String(left.lastAt ?? ''))).slice(0, 6)
      .map(thread => ({ key: thread.key, title: thread.title ?? thread.key,
        source: thread.source ?? String(thread.key ?? '').split(':')[0], lastAt: thread.lastAt }))
    const triggers = Object.values(this.state.triggers ?? {}).filter(trigger => match(trigger.text))
      .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? ''))).slice(0, 8)
      .map(trigger => ({ id: trigger.id, text: preview(trigger.text ?? '', 120), at: trigger.at,
        threadKey: trigger.threads?.[0], channelId: trigger.channel?.address?.channelId }))
    return { query: String(query), tickets, threads, triggers, total: tickets.length + threads.length + triggers.length }
  }

  /**
   * Ask one active Ticket to stop (P2 review §2): the flag is durable, the executor checks it at every stage boundary,
   * and the run/ticket keep what happened so far. Repeated requests are idempotent, and nothing after the check
   * (gates/commit/push/MR) runs for a stopped Ticket.
   */
  async requestStop(ticketId, { by, note } = {}) {
    const ticket = this.state.tickets[ticketId]
    if (!ticket) return { missing: true }
    const active = ['working', 'running', 'queued', 'preparing'].includes(ticket.status)
    // Repeating a stop that already landed is a no-op success, not a 409: a queued stop finalises immediately and a
    // restart reconciles a pending stop, so the operator (or a retried request) must see the settled state.
    if (!active) {
      if (ticket.status === 'ready' && ticket.stop) return { stopping: false, status: 'ready', ticket, alreadyStopped: true }
      return { invalid: `工单当前状态为 ${ticket.status}，没有可停止的执行` }
    }
    const running = ticket.status === 'working' || ticket.status === 'running'
    const at = new Date().toISOString()
    const requested = ticket.stopRequested && typeof ticket.stopRequested === 'object'
      ? ticket.stopRequested : { at, ...(by ? { by: String(by).slice(0, 120) } : {}),
        ...(note ? { note: String(note).slice(0, 500) } : {}) }
    // A queued Ticket has no worker to signal: stopping it means ending that queue entry now, not leaving a durable
    // request that no execution will ever consume. The confirmation is recorded so the UI cannot stay "stopping".
    if (ticket.status === 'queued') {
      ticket.stop = { ...requested, confirmedAt: at, runId: ticket.runId ?? null, mode: 'queued' }
      delete ticket.stopRequested
      ticket.status = 'ready'
      ticket.updatedAt = at
      appendActivity(ticket, { kind: 'run', actorKind: 'user', detail: '已停止排队中的工单', at,
        ...(ticket.runId ? { refs: { runId: ticket.runId } } : {}) })
      await this.state.save()
      this.log(`stop confirmed for queued ${ticketId}`)
      return { stopping: false, status: 'ready', ticket }
    }
    // Idempotent: a second request keeps the first timestamp/author (the panel may retry after a slow response).
    if (ticket.stopRequested) return { stopping: running, ticket }
    ticket.stopRequested = requested
    ticket.updatedAt = at
    appendActivity(ticket, { kind: 'run', actorKind: 'user', detail: '请求停止执行', at,
      refs: { runId: ticket.runId } })
    await this.state.save()
    this.log(`stop requested for ${ticketId}${running ? ' (running)' : ''}`)
    return { stopping: running, ticket }
  }

  /** Remove a pending stop request before retrying/resuming; a no-op when none exists. */
  clearStopRequest(ticketId) {
    const ticket = this.state.tickets[ticketId]
    if (!ticket || !ticket.stopRequested) return false
    delete ticket.stopRequested
    ticket.updatedAt = new Date().toISOString()
    return true
  }

  isStopRequested(ticketId) { return Boolean(this.state.tickets[ticketId]?.stopRequested) }

  /**
   * Record a human acceptance decision for a deployed Ticket (`POST engine/ticket/:id/accept`, contract §4 extension).
   * The deploy status and all its evidence stay untouched; `links.acceptance` is added, and an accepted Ticket also
   * best-effort removes its local worktree/feature branch, plus the remote feature branch once verify proved it merged
   * (`links.cleanup`; rejection keeps them for the next fix).
   * → { ticket, cleanup? } | { missing: true } | { invalid: string }
   */
  async acceptTicket({ ticketId, ok = true, note, intents } = {}) {
    const ticket = this.state.tickets?.[ticketId]
    if (!ticket) return { missing: true }
    const config = this.readConfig().config
    const repo = ticketRepo(config, ticket)
    const mode = repo?.acceptance ?? 'deployed'
    if (mode === 'merged') {
      const merged = ticket.status === 'merged' || ticket.links?.verification?.merged === true
      if (!merged) {
        return { invalid: `工单 ${ticketId} 当前状态是 ${ticket.status}，${repo?.name ?? '该仓库'} 需要 MR 合入 ${repo?.gitlab.targetBranch ?? '目标分支'} 后才能验收` }
      }
    } else if (ticket.status !== 'deployed') {
      return { invalid: `工单 ${ticketId} 当前状态是 ${ticket.status}，只有已部署 UAT 的工单可以验收` }
    }
    const acceptance = {
      ok: ok !== false,
      at: new Date().toISOString(),
      ...ticket.links?.verification?.at ? { verificationAt: ticket.links.verification.at } : {},
      ...typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 500) } : {},
    }
    const cleanIntents = Array.isArray(intents)
      ? intents.filter(value => ACCEPTANCE_INTENTS.includes(value)).slice(0, 5) : []
    // Acceptance is terminal for the local workspace: record the sign-off first, then best-effort clean the
    // worktree/branch. A cleanup failure must not roll back the human decision, so it is reported separately.
    await this.state.atomic((doc) => {
      const current = doc.tickets[ticketId]
      doc.tickets[ticketId] = { ...current, links: { ...current.links, acceptance } }
      appendActivity(doc.tickets[ticketId], {
        kind: 'acceptance', actorKind: 'user', from: current.status,
        to: acceptance.ok ? 'accepted' : 'rejected',
        detail: [acceptance.note, cleanIntents.length ? `intents: ${cleanIntents.join('/')}` : undefined].filter(Boolean).join(' · '),
        refs: { acceptanceAt: acceptance.at, ...(cleanIntents.length ? { intents: cleanIntents } : {}) },
      })
    })
    // P1 §4.2: mirror the human decision onto the acceptance round (the legacy `links.acceptance` above stays).
    await this.recordAcceptanceDecision(ticketId, { ok: acceptance.ok, note: acceptance.note, intents: cleanIntents,
      at: acceptance.at }).catch(error => this.log(`record acceptance ${ticketId} failed: ${this.errorText(error)}`))
    // AC-05/08: the human decision is its own evidence entry; the delivery round keeps its own gate/files facts.
    await this.evidence?.updateLatest(ticketId, {
      human: { decision: acceptance.ok ? 'accept' : 'reject', note: acceptance.note ?? '', at: acceptance.at },
      platform: { accepted: acceptance.ok === true },
    }).catch(error => this.log(`record evidence acceptance ${ticketId} failed: ${this.errorText(error)}`))
    let cleanup
    if (acceptance.ok) {
      const path = ticket.links?.worktree
      const branch = ticket.links?.branch
      if (repo && (path || branch)) {
        const remove = this.deps.removeWorktree ?? removeWorktree
        try {
          const result = await remove({ repo: repo.repo,
            path: path ?? (repo.worktreeRoot ? join(repo.worktreeRoot, ticketId) : undefined),
            branch, timeoutMs: 120_000 })
          cleanup = { ...result, at: acceptance.at }
          if (path && !result.worktreeRemoved && existsSync(path)) cleanup.failed = `无法删除工作树：${path}`
          else if (branch && !result.branchRemoved && !result.branchKept) cleanup.failed = `无法删除本地分支：${branch}`
        } catch (error) {
          cleanup = { failed: error instanceof Error ? error.message : String(error), at: acceptance.at }
        }
        // A merged feature branch is dead weight on origin (GitHub's auto-pr workflow already landed it). Deletion is
        // best-effort: a failure is recorded and logged, but never rolls back the human acceptance.
        if (repo?.repo && cleanup && ticket.links?.verification?.merged === true
          && typeof branch === 'string' && branch.startsWith('feature/')) {
          const removeRemote = this.deps.deleteRemoteBranch ?? deleteRemoteBranch
          try {
            const remote = await removeRemote({ repo: repo.repo, branch, timeoutMs: 120_000 })
            cleanup.remoteBranchDeleted = remote?.deleted === true
          } catch (error) {
            cleanup.remoteBranchError = this.errorText(error)
            this.log(`cleanup remote branch ${branch} failed: ${cleanup.remoteBranchError}`)
          }
        }
        await this.state.atomic((doc) => {
          const current = doc.tickets[ticketId]
          doc.tickets[ticketId] = { ...current, links: { ...current.links, cleanup } }
        })
      }
    }
    const current = this.state.tickets[ticketId]
    return { ticket: current ?? { ...ticket, links: { ...ticket.links, acceptance } }, cleanup }
  }

  /** Human decision to stop chasing a failed/unused Ticket: hide it from "needs you" and remove its local worktree/branch. */
  async dismissTicket({ ticketId, note } = {}) {
    const ticket = this.state.tickets?.[ticketId]
    if (!ticket) return { missing: true }
    const dismissable = ['failed', 'ci-failed', 'deploy-failed', 'queued', 'ready']
    if (!dismissable.includes(ticket.status)) {
      return { invalid: `工单 ${ticketId} 当前状态是 ${ticket.status}，只有失败或尚未开始的工单可以忽略` }
    }
    const dismissed = { at: new Date().toISOString(), ...typeof note === 'string' && note.trim() ? { note: note.trim().slice(0, 500) } : {} }
    // A dismissed Ticket has no further purpose: remove its local worktree and feature branch (the remote branch is
    // left alone — failed tickets normally never pushed). Cleanup failure aborts the dismissal so nothing is hidden
    // while its files linger on disk.
    const config = this.readConfig().config
    const repo = ticketRepo(config, ticket)
    let cleanup
    const path = ticket.links?.worktree
    const branch = ticket.links?.branch
    if (repo && (path || branch)) {
      const remove = this.deps.removeWorktree ?? removeWorktree
      try {
        cleanup = await remove({ repo: repo.repo, path: path ?? (repo.worktreeRoot ? join(repo.worktreeRoot, ticketId) : undefined),
          branch, timeoutMs: 120_000 })
      } catch (error) {
        return { cleanupFailed: `无法清理工单的工作树/分支：${error instanceof Error ? error.message : String(error)}` }
      }
      if (path && !cleanup.worktreeRemoved && existsSync(path)) {
        return { cleanupFailed: `无法删除工单工作树：${path}` }
      }
      if (branch && !cleanup.branchRemoved && !cleanup.branchKept) {
        return { cleanupFailed: `无法删除本地分支：${branch}` }
      }
    }
    await this.state.atomic((doc) => {
      const current = doc.tickets[ticketId]
      doc.tickets[ticketId] = { ...current, status: 'dismissed', stage: 'done', updatedAt: dismissed.at,
        links: { ...current.links, dismissed, ...cleanup ? { cleanup } : {} } }
      appendActivity(doc.tickets[ticketId], {
        kind: 'dismiss', actorKind: 'user', from: current.status, to: 'dismissed',
        detail: dismissed.note, refs: { dismissedAt: dismissed.at },
      })
    })
    // P1 §4.2: a dismissed Ticket closes its acceptance record (an absent record is created closed, so the panel can
    // still show "this delivery was abandoned" rather than a hole in the ledger).
    if (this.acceptance?.loaded) {
      await this.acceptance.update(ticketId, (record) => {
        record.status = 'closed'
        record.closedAt = record.closedAt ?? dismissed.at
        return record
      }, { requirement: typeof ticket.title === 'string' ? ticket.title.slice(0, 500) : undefined })
        .catch(error => this.log(`close acceptance ${ticketId} failed: ${this.errorText(error)}`))
    }
    return { ticket: this.state.tickets[ticketId], cleanup }
  }

  /**
   * Append one human requirement revision to a Ticket. The caller (the revision route) reruns the Ticket after this;
   * keeping revisions instead of rewriting `body` preserves the original request and hands the worker the new rules in
   * order. A Ticket that is running, parked on a question, ended or accepted has no revision slot.
   * → { ticket, revision } | { missing:true } | { invalid:string }
   */
  async addRevision(ticketId, text) {
    const ticket = this.state.tickets?.[ticketId]
    if (!ticket) return { missing: true }
    const value = typeof text === 'string' ? text.trim() : ''
    if (!value) return { invalid: '追加要求不能为空' }
    if (value.length > REVISION_MAX) return { invalid: `追加要求不能超过 ${REVISION_MAX} 个字符` }
    if (ticket.status === 'working') return { invalid: '工单正在执行，等这一轮结束后再追加要求' }
    if (ticket.status === 'awaiting-answer') return { invalid: '工单在等你回答 worker 的问题，请先用「回答」' }
    if (['dismissed', 'closed'].includes(ticket.status)) return { invalid: '工单已结束，不能再追加要求' }
    if (ticket.links?.acceptance?.ok === true) return { invalid: '工单已验收，不能再追加要求' }
    const at = new Date().toISOString()
    const revision = { id: recordId('rev'), at, text: value, actorKind: 'user' }
    await this.state.atomic((doc) => {
      const current = doc.tickets?.[ticketId]
      if (!current) return
      const next = { ...current,
        revisions: [...(Array.isArray(current.revisions) ? current.revisions : []), revision], updatedAt: at }
      appendActivity(next, { kind: 'revision', actorKind: 'user', from: current.status, to: current.status,
        detail: value, at, refs: { revisionId: revision.id } })
      doc.tickets[ticketId] = next
    })
    return { ticket: this.state.tickets[ticketId] ?? ticket, revision }
  }

  /** `GET engine/threads?filter=` — thread rows with trigger/decision/ticket counts (contract §4). */
  threadsView({ filter = 'all', q = '', repoId = '', reason = '', from = '', to = '', limit = 50, offset = 0 } = {}) {
    const windowStart = new Date(Date.now() - DAY_MS).toISOString()
    const query = String(q ?? '').trim().toLowerCase()
    const reasonQuery = String(reason ?? '').trim().toLowerCase()
    // AC-06: the Thread list filters by repository (through its Tickets), the latest decision's reason and the last
    // activity time before pagination, matching the Source and Eval pages.
    const threads = Object.values(this.state.threads ?? {})
      .filter(thread => !from || String(thread.lastAt ?? '') >= String(from))
      .filter(thread => !to || String(thread.lastAt ?? '') <= String(to))
      .sort((left, right) => String(right.lastAt ?? '').localeCompare(String(left.lastAt ?? '')))
    const counts = { all: 0, subscribed: 0, recent: 0, new: 0 }
    const config = this.readConfig?.()?.config
    const entries = []
    for (const thread of threads) {
      const triggers = this.triggersOfThread(thread.key)
      const decisions = this.decisionsOfThread(thread.key)
      const ticketIds = this.ticketIdsOfThread(thread.key)
      const latest = [...decisions].sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))[0]
      const reasonText = decisions.map(decision => JSON.stringify(decision.reason ?? '')).join(' ').toLowerCase()
      const repoIds = [...new Set(ticketIds.map(id => {
        const ticket = this.state.tickets?.[id]
        if (!ticket) return undefined
        try { return ticketRepo(config, ticket).id } catch { return ticket.repoId }
      }).filter(Boolean))]
      if (repoId && !repoIds.includes(repoId)) continue
      if (reasonQuery && !reasonText.includes(reasonQuery)) continue
      if (query && ![thread.title, thread.key, thread.source, reasonText]
        .some(value => String(value ?? '').toLowerCase().includes(query))) continue
      const subscribed = ticketIds.length > 0
      const recent = triggers.some(trigger => inWindow(trigger.at, windowStart))
      counts.all += 1
      if (subscribed) counts.subscribed += 1
      if (recent) { counts.recent += 1; counts.new += 1 }
      entries.push({
        subscribed,
        recent,
        row: {
          key: thread.key,
          title: thread.title,
          source: thread.source ?? thread.key.split(':')[0],
          lastAt: thread.lastAt,
          createdAt: thread.createdAt,
          triggerCount: triggers.length,
          decisionKind: latest?.kind ?? null,
          ...(repoIds.length ? { repoId: repoIds[0], repoIds } : {}),
          ...(latest?.reason ? { reason: latest.reason } : {}),
          ticketIds,
          state: subscribed ? 'subscribed' : recent ? 'recent' : 'idle',
        },
      })
    }
    // `recent` and `new` are the same 24h set (contract §4); they stay two names for the two client tabs.
    const filtered = entries.filter(entry => filter === 'subscribed' ? entry.subscribed
      : filter === 'recent' || filter === 'new' ? entry.recent
        : true).map(entry => entry.row)
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 200) : 50
    return { items: filtered.slice(start, start + size), total: filtered.length, counts,
      filters: { q: String(q ?? ''), repoId: String(repoId ?? ''), reason: String(reason ?? ''),
        from: String(from ?? ''), to: String(to ?? ''), filter } }
  }

  /** `GET engine/thread/:key` — thread facts plus triggers (asc), decisions (desc) and tickets (newest first). */
  threadView(key) {
    const thread = this.state.threads?.[key]
    if (!thread) return undefined
    const triggers = this.triggersOfThread(key)
      .sort((left, right) => String(left.at ?? '').localeCompare(String(right.at ?? '')))
    const decisions = this.decisionsOfThread(key)
      .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
    const tickets = this.ticketIdsOfThread(key).map(id => this.state.tickets[id]).filter(Boolean)
      .sort((left, right) => String(right.createdAt ?? '').localeCompare(String(left.createdAt ?? '')))
    const last = decisions[0]
    const channelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
    const facts = {
      source: thread.source ?? key.split(':')[0],
      key,
      channelId,
      title: thread.title,
      createdAt: thread.createdAt,
      lastAt: thread.lastAt,
      triggerCount: triggers.length,
      decisionCount: decisions.length,
      ticketCount: tickets.length,
      ...(last ? { lastDecision: { id: last.id, kind: last.kind, at: last.at } } : {}),
    }
    return { thread, triggers, decisions, tickets, facts }
  }

  /** `GET engine/decisions?kind=&window=&offset=&limit=` — decision history; counts ignore `kind` so tabs stay stable. */
  decisionsView({ kind = 'all', window = 'all', offset = 0, limit = 50,
    q = '', repoId = '', reason = '', from = '', to = '', view = 'all' } = {}) {
    const since = window === '24h' ? new Date(Date.now() - DAY_MS).toISOString() : ''
    const query = String(q ?? '').trim().toLowerCase()
    const reasonQuery = String(reason ?? '').trim().toLowerCase()
    const humanView = VIEW_FILTERS.includes(view) ? view : 'all'
    // AC-06: every filter runs before slicing, so `total` and the page boundaries describe the same intersection.
    const all = Object.values(this.state.decisions ?? {})
      .filter(decision => !since || inWindow(decision.at, since))
      .filter(decision => !from || String(decision.at ?? '') >= String(from))
      .filter(decision => !to || String(decision.at ?? '') <= String(to))
      // AC-06: an ignored decision has no Ticket, so the record's own repoId must win; only legacy records fall back
      // to the Ticket (and then the Ticket's repoId) instead of all being attributed to the default repository.
      .filter(decision => !repoId || repoIdOfDecision(this.state, this.readConfig().config, decision) === repoId)
      .filter(decision => !query || decisionSearchText(this.state, decision).includes(query))
      .filter(decision => !reasonQuery || decisionReasonText(decision).includes(reasonQuery))
      // AC-06: divergence is a real rule/model disagreement (a failed model call is not one); override is a human
      // decision that actually changed the outcome, not a reply that was merely recorded.
      .filter(decision => humanView === 'divergence' ? decisionModelConflict(decision)
        : humanView === 'override' ? decisionHumanOverride(decision) : true)
      .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')) ||
        String(left.id ?? '').localeCompare(String(right.id ?? '')))
    const counts = { all: all.length, accept: 0, reopen: 0, stop: 0, ignore: 0, unavailable: 0 }
    for (const decision of all) if (Object.hasOwn(counts, decision.kind)) counts[decision.kind] += 1
    const filtered = DECISION_KINDS.includes(kind) ? all.filter(decision => decision.kind === kind) : all
    const start = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
    const size = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 50
    // A decision row must show the message it judged, not only the outcome: resolve the trigger texts here so every
    // consumer of this endpoint (the Eval page) gets one line of context without a second request per row.
    const items = filtered.slice(start, start + size).map(decision => ({
      ...decision,
      preview: (Array.isArray(decision.triggerIds) ? decision.triggerIds : [])
        .map(triggerId => this.state.triggers?.[triggerId])
        .filter(Boolean)
        .map(trigger => preview(trigger.text ?? '', 140))
        .filter(Boolean)
        .join(' / '),
      // AC-07: an Eval row links to the run it caused, not only to the Ticket. The run index is newest-first, so the
      // first match per Ticket is the run to open.
      runs: [...new Set([decision.ticketId, ...(Array.isArray(decision.ticketIds) ? decision.ticketIds : [])]
        .filter(Boolean))].map(ticketId => {
          const run = (this.state.runs ?? []).find(candidate => candidate.ticketId === ticketId)
          return run ? { ticketId, runId: run.id, status: run.status, at: run.startedAt } : { ticketId }
        }),
    }))
    return { items, total: filtered.length, counts, filters: { q: String(q ?? ''), repoId: String(repoId ?? ''),
      reason: String(reason ?? ''), from: String(from ?? ''), to: String(to ?? ''), kind, window, view: humanView } }
  }

  triggersOfThread(threadKey) {
    return Object.values(this.state.triggers ?? {}).filter(trigger => (trigger.threads ?? []).includes(threadKey))
  }

  decisionsOfThread(threadKey) {
    return Object.values(this.state.decisions ?? {}).filter(decision => decision.threadKey === threadKey)
  }

  ticketIdsOfThread(threadKey) {
    const ids = []
    for (const ticket of Object.values(this.state.tickets ?? {})) {
      if (ticket.origin?.threadKey === threadKey) ids.push(ticket.id)
    }
    for (const decision of Object.values(this.state.decisions ?? {})) {
      if (decision.threadKey === threadKey && this.state.tickets?.[decision.ticketId]) ids.push(decision.ticketId)
    }
    return [...new Set(ids)]
  }

  decisionOfTicket(ticket) {
    const direct = ticket.origin?.decisionId ? this.state.decisions?.[ticket.origin.decisionId] : undefined
    if (direct) return direct
    return Object.values(this.state.decisions ?? {}).find(decision => decision.ticketId === ticket.id)
  }

  triggerOfTicket(ticket, decision) {
    const direct = ticket.origin?.triggerId ? this.state.triggers?.[ticket.origin.triggerId] : undefined
    if (direct) return direct
    const fromDecision = decision?.triggerIds?.[0] ? this.state.triggers?.[decision.triggerIds[0]] : undefined
    if (fromDecision) return fromDecision
    return Object.values(this.state.triggers ?? {}).find(trigger => trigger.disposition?.fanout?.includes(ticket.id))
  }
}

function eventCounts(result) {
  return { fetched: result.fetched, accepted: result.accepted.length, ignored: result.ignored.length, skipped: result.skipped.length, acked: result.acked }
}
function syncCounts(result) {
  return { fetched: result.fetched, accepted: result.accepted.length, ignored: result.ignored.length, skipped: result.skipped.length,
    initialized: result.initialized.length, cursors: result.cursors }
}

/** Create and load one engine instance; callers own start/stop. */
export async function createEngine(options) {
  const engine = new Engine(options)
  await engine.load()
  return engine
}/** Eval views that need more than a field filter; unknown values fall back to `all`. */
const VIEW_FILTERS = ['all', 'divergence', 'override']

/** The model opinion that actually ran, if it succeeded. A failed/absent model is never a divergence. */
function decisionModel(decision) {
  for (const model of [decision?.shadow, decision?.model]) {
    if (model && typeof model === 'object' && model.status === 'ok' && typeof model.verdict === 'string') return model
  }
  return undefined
}

/** True only when a successful model verdict clearly disagrees with the rule outcome. `uncertain` is not a conflict. */
function decisionModelConflict(decision) {
  const model = decisionModel(decision)
  if (!model || model.verdict === 'uncertain') return false
  const ruleAccept = decision.kind === 'accept'
  return (model.verdict === 'accept') !== ruleAccept
}

/** A human reply that changed the outcome (`started`/`dismissed`), not one kept as a record (`recorded`/blocked). */
function decisionHumanOverride(decision) {
  const review = decision?.humanReview
  return Boolean(review && (review.outcome === 'started' || review.outcome === 'dismissed'))
}

/**
 * AC-05: one place that separates what is actually known about delivery. A push-mode GitHub branch gives a create-PR
 * link, not a Pull Request; only an iid (or a platform refresh) proves one exists. Merge, deployment and the human
 * acceptance decision stay independent so a later stage can never overwrite an earlier one.
 */
function deliverySummary(ticket) {
  const links = ticket?.links ?? {}
  const mr = links.mergeRequest ?? {}
  const acceptance = links.acceptance?.ok === true
  // A local commit is not a push. `links.push` is written only after `git push` succeeded; a legacy Ticket that
  // already reached a pushed-or-later status is treated as pushed because its status proves the remote accepted it.
  const pushedStatuses = new Set(['pushed', 'mr-open', 'ci-pending', 'ci-passed', 'ci-failed', 'deploy-pending',
    'deployed', 'deploy-failed', 'merged', 'accepted', 'closed'])
  const push = links.push && typeof links.push === 'object' ? links.push : undefined
  const pushed = Boolean(push?.sha) || (Boolean(links.commit) && pushedStatuses.has(ticket?.status))
  const merged = ticket?.status === 'merged' || Boolean(links.mergedAt ?? ticket?.mergedAt) ||
    (mr.state === 'merged')
  // An explicit platform state (including `closed`) wins over the mere existence of an iid. Any `webUrl` without an
  // iid is only a create-PR entry (a `/pull/new/` link from a push), including legacy records that predate `mode`:
  // treating those as "PR created" was the original AC-05 symptom.
  const prState = merged || mr.state === 'merged' ? 'merged'
    : mr.state === 'closed' ? 'closed'
      : mr.iid ? 'open'
        : mr.webUrl ? 'waiting' : 'none'
  const deployment = links.deployment && typeof links.deployment === 'object' ? links.deployment : undefined
  const head = links.commit ?? mr.headSha ?? null
  // The recorded comparison wins: the deployment commit is the MR merge commit, while `head` is the feature branch.
  // Only a legacy record without the recorded boolean is compared through the pipeline's own branch sha.
  const matchesHead = typeof deployment?.matchesHead === 'boolean' ? deployment.matchesHead
    : Boolean(deployment?.commit && (deployment?.sha
      ? deployment.sha === deployment.commit
      : head && deployment.commit === head))
  // AC-05: a pipeline id is not a deployment. refreshTicketCi records the pipeline id for pending/failed pipelines too,
  // so only a successful pipeline tied to this exact commit may claim `deployed`; an unverified legacy record stays false.
  const deployedEvidence = Boolean(
    (deployment?.status === 'success' && matchesHead === true)
    || links.verification?.deployedAt
    || ticket?.status === 'deployed')
  return {
    pushed,
    pushedAt: push?.at ?? null,
    branch: links.branch ?? null,
    commit: links.commit ?? mr.headSha ?? null,
    pr: { state: prState, iid: mr.iid ?? null, webUrl: mr.webUrl ?? null, headSha: mr.headSha ?? null,
      pending: prState === 'waiting' },
    merged,
    deployed: deployedEvidence,
    deployment: deployment ? { pipelineId: deployment.pipelineId ?? deployment.id ?? null,
      status: deployment.status ?? deployment.state ?? null,
      commit: deployment.commit ?? null,
      matchesHead } : null,
    accepted: acceptance,
  }
}

function decisionReasonText(decision) {
  const parts = []
  const list = Array.isArray(decision?.reason) ? decision.reason : []
  for (const item of list) {
    if (typeof item === 'string') parts.push(item)
    else if (item && typeof item === 'object') {
      if (item.code) parts.push(String(item.code))
      if (item.label) parts.push(String(item.label))
      if (item.values) parts.push(Object.values(item.values).join(' '))
    }
  }
  return parts.join(' ').toLowerCase()
}

function decisionSearchText(state, decision) {
  const ticket = decision?.ticketId ? state.tickets?.[decision.ticketId] : undefined
  return [decision?.kind, decision?.reason ? decisionReasonText(decision) : '', ticket?.title, ticket?.repoId,
    ...(Array.isArray(decision?.triggerIds) ? decision.triggerIds.map(id => state.triggers?.[id]?.text ?? '') : [])]
    .filter(Boolean).join(' ').toLowerCase()
}

/**
 * AC-06: which configured repository a decision belongs to. The record's own `repoId` is authoritative — ignored
 * decisions have no Ticket, so resolving only through the Ticket would attribute every one of them to the default
 * repository. Legacy records without `repoId` still resolve through the Ticket (or its raw `repoId`).
 */
function repoIdOfDecision(state, config, decision) {
  if (decision?.repoId) return decision.repoId
  const ticket = decision?.ticketId ? state.tickets?.[decision.ticketId] : undefined
  if (!ticket) return undefined
  try { return ticketRepo(config, ticket).id } catch { return ticket.repoId }
}
