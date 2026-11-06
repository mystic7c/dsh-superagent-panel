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
import { LiveState, recordId } from './state.js'
import { evaluate, buildRecords, EVAL_RULES } from './eval.js'
import { workerBrief } from './executor.js'
import { repoToken, repoSummary, ticketRepo, decorateTicket, configRepos } from './repos.js'
import { removeWorktree } from './repo.js'
import { preview } from '../util.js'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_EVENTS = 100
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
  failed: 'failed', 'ci-failed': 'failed', 'deploy-failed': 'failed',
  closed: 'done',
  dismissed: 'done',
}
const STAGES = ['queued', 'working', 'waiting', 'failed', 'done']
const stageOf = status => STAGE_OF_STATUS[status] ?? 'working'
/** A person accepted a deployed Ticket on UAT; it leaves the "waiting for a human" queue but keeps its deploy record. */
const acceptedOf = ticket => ticket?.links?.acceptance?.ok === true

const DECISION_KINDS = ['accept', 'reopen', 'stop', 'ignore', 'unavailable']

/** Human text for the filter codes the rules engine writes on an ignored decision (contract §4 octo.filtered). */
const FILTER_REASON_TEXT = {
  contextOnly: '代码/SQL 片段（保存为后续请求的上下文）',
  highRisk: '命中高风险主题（生产 / DDL / 合并 / 密钥）',
  sourceNotWatched: '不在监听群',
  senderNotAllowed: '发送者不在允许名单',
  notText: '不是文本消息',
}

const CONTEXT_WINDOW_MS = 10 * 60 * 1000

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
  if (!loaded.exists) return { state: 'off', detail: 'live.json 不存在' }
  if (!loaded.config.enabled) return { state: 'off', detail: 'live.json 未启用' }
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

/** A candidate message from one message-sync row. */
function candidateOfSync(message, config) {
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
    if (record.ticket) { doc.tickets[record.ticket.id] = record.ticket; doc.ticketOrder.push(record.ticket.id) }
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
    this.client = undefined
    this.clientToken = undefined
    this.timer = undefined
    this.verifyTimer = undefined
    this.dispatchQueue = undefined
    this.polling = false
    this.lastStatus = { phase: 'starting' }
    this.started = false
  }

  async load() {
    await this.state.load()
    await this.reconcile()
  }

  /**
   * A run cannot survive a plugin reload / host restart: the worker agent and its event listener are gone.
   * Mark such runs failed on startup instead of leaving working tickets that will never progress.
   */
  async reconcile() {
    const stale = (this.state.runs ?? []).filter(run => run.status === 'running')
    const working = Object.values(this.state.tickets).filter(ticket => ticket.status === 'working')
    if (!stale.length && !working.length) return { runs: 0, tickets: 0 }
    const at = new Date().toISOString()
    await this.state.atomic((doc) => {
      for (const run of doc.runs ?? []) {
        if (run.status !== 'running') continue
        run.status = 'failed'
        run.error = 'interrupted by a plugin reload or host restart'
        run.steps = [...(run.steps ?? []), { name: 'reconcile', at, state: 'failed', message: run.error }]
      }
      for (const ticket of Object.values(doc.tickets ?? {})) {
        if (ticket.status !== 'working') continue
        ticket.status = 'failed'
        ticket.updatedAt = at
        const assignment = ticket.assignments?.at(-1)
        if (assignment) {
          assignment.state = 'ended'
          assignment.endedAt = at
          assignment.report = { state: 'failed', text: 'interrupted by a plugin reload or host restart', at }
        }
      }
    })
    this.log(`reconciled interrupted runs: ${stale.length}, tickets: ${working.length}`)
    return { runs: stale.length, tickets: working.length }
  }

  readConfig() {
    return (this.deps.loadConfig ?? loadLiveConfig)(this.stateDir)
  }

  configView() {
    return redactedLiveConfig(this.readConfig())
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
    if (loaded.exists && loaded.config.enabled) {
      await this.schedule()
      await this.scheduleVerify()
      this.lastStatus = { phase: 'idle', detail: 'live.json enabled', at: new Date().toISOString() }
      return { enabled: true, pollSeconds: loaded.config.pollSeconds,
        verifySeconds: Math.min(...configRepos(loaded.config).map(repo => repo.gitlab.verifySeconds ?? 120)) }
    }
    this.lastStatus = { phase: 'disabled', detail: loaded.exists ? 'live.json enabled=false' : 'live.json not found' }
    return { enabled: false }
  }

  /** Start polling when live.json says enabled; otherwise the engine stays idle and only manual polls run. */
  async start() {
    await this.load()
    this.started = true
    const loaded = this.readConfig()
    if (!loaded.exists || !loaded.config.enabled) {
      this.lastStatus = { phase: 'disabled', detail: loaded.exists ? 'live.json enabled=false' : 'live.json not found' }
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
    const candidates = Object.values(this.state.tickets).filter(ticket => ticket.links?.commit
      && ['mr-open', 'ci-pending', 'merged', 'deploy-pending'].includes(ticket.status)
      && ticketRepo(config, ticket)?.verifyMode !== 'manual')
    const manualCandidates = Object.values(this.state.tickets).filter(ticket => ticket.links?.commit
      && ['mr-open', 'ci-pending'].includes(ticket.status)
      && ticketRepo(config, ticket)?.verifyMode === 'manual')
    const results = []
    for (const ticket of manualCandidates) {
      try {
        const result = await verify({ engine: this, ticketId: ticket.id })
        results.push({ ticketId: ticket.id, status: result.status, merged: result.verification?.merged })
        if (result.status !== ticket.status) this.log(`ticket ${ticket.id}: ${ticket.status} -> ${result.status}`)
      } catch (error) { this.log(`verify ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    for (const ticket of candidates) {
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
      } catch (error) { this.log(`verify ${ticket.id} failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    return results
  }

  async schedule() {
    clearTimeout(this.timer)
    const run = async () => {
      try {
        // Paused keeps the timer running so resuming needs no restart, but does not poll Octo.
        if (this.readConfig().config.paused !== true) await this.pollOnce({ dryRun: false })
      } catch (error) { this.log(`engine poll failed: ${error instanceof Error ? error.message : String(error)}`) }
      if (!this.started) return
      const config = this.readConfig().config
      this.timer = setTimeout(run, Math.max(2, config.pollSeconds) * 1000)
      this.timer.unref?.()
    }
    this.timer = setTimeout(run, 1000)
    this.timer.unref?.()
  }

  stop() {
    this.started = false
    clearTimeout(this.timer)
    clearTimeout(this.verifyTimer)
    this.timer = undefined
    this.verifyTimer = undefined
    this.client = undefined
  }

  /** One poll pass, dispatching on the configured intake mode. */
  async pollOnce({ dryRun = true } = {}) {
    const loaded = this.readConfig()
    const mode = loaded.config.octo.intake === 'events' ? 'events' : 'sync'
    // The pause switch stops the live path only: a dry run never writes or acts, so it stays available for diagnosis.
    if (!dryRun && loaded.config.paused === true) return { error: 'paused', dryRun, mode }
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

  /** Group message-sync intake: newest window per watched chat, deduped by message_seq. */
  async pollSync(loaded, { dryRun = false } = {}) {
    const config = loaded.config
    if (!loaded.exists) return { error: 'live.json not found', dryRun, mode: 'sync' }
    if (!dryRun && !config.enabled) return { error: 'live.json enabled=false', dryRun, mode: 'sync' }
    if (!dryRun && config.octo.allowSenderIds.length === 0 && !config.octo.allowAnyHuman) {
      return { error: 'octo.allowSenderIds must list the humans allowed to trigger work, or octo.allowAnyHuman must be true', dryRun, mode: 'sync' }
    }
    const client = await this.ensureClient(loaded)
    if (!client) return { error: 'Octo token is not configured', dryRun, mode: 'sync' }

    const result = { mode: 'sync', dryRun, fetched: 0, accepted: [], ignored: [], skipped: [], initialized: [], cursors: {} }
    const records = []
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
        if (candidate.skip) { result.skipped.push({ seq: message.messageSeq, reason: candidate.skip }); continue }
        const evaluation = evaluate(candidate, config)
        const built = buildRecords(candidate, evaluation, config, candidate.threadTitle)
        if (evaluation.kind === 'accept') this.attachContext(records, built)
        records.push(built)
        if (evaluation.kind === 'accept') {
          result.accepted.push({ seq: message.messageSeq, sender: candidate.fromUid, title: candidate.text.slice(0, 80),
            ticketId: built.ticket?.id })
        } else result.ignored.push({ seq: message.messageSeq, sender: candidate.fromUid, reason: evaluation.reason })
      }
      if (maxSeq !== undefined) cursors[chatId] = Math.max(baseline, maxSeq)
      result.cursors[chatId] = cursors[chatId] ?? baseline
    }

    if (dryRun) {
      this.lastStatus = { phase: 'dry-run', mode: 'sync', at: new Date().toISOString(), ...syncCounts(result) }
      return result
    }
    await this.state.atomic((doc) => {
      // Drop cursors of chats that are no longer watched, so switching groups does not leave stale cursors behind.
      doc.channelCursors = Object.fromEntries(Object.entries({ ...(doc.channelCursors ?? {}), ...cursors })
        .filter(([chat]) => config.octo.watchChatIds.includes(chat)))
      absorb(doc, records)
      doc.lastPollAt = new Date().toISOString()
      doc.lastError = undefined
      // Count only messages newer than the cursor; `fetched` repeats the newest window on every poll.
      doc.events.received += result.accepted.length + result.ignored.length + result.skipped.length
      doc.events.accepted += result.accepted.length
      doc.events.ignored += result.ignored.length
      doc.sources.octo = { state: result.error ? 'error' : 'ready', ...(result.error ? { detail: result.error } : {}),
        at: doc.lastPollAt }
    })
    this.lastStatus = { phase: result.error ? 'error' : 'ok', mode: 'sync', at: new Date().toISOString(), ...syncCounts(result) }
    if (result.accepted.length || result.ignored.length) {
      this.log(`sync poll: fetched ${result.fetched}, accepted ${result.accepted.length}, ignored ${result.ignored.length}`)
    }
    if (config.executor.enabled && config.executor.autoRun && config.paused !== true) {
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
    let nextCursor = cursor
    for (const event of events) {
      nextCursor = Math.max(nextCursor, Number(event.eventId) || 0)
      const candidate = candidateOf(event, config)
      if (candidate.skip) { result.skipped.push({ eventId: event.eventId, reason: candidate.skip }); continue }
      const evaluation = evaluate(candidate, config)
      if (evaluation.kind === 'accept') result.accepted.push({ eventId: event.eventId, messageId: candidate.messageId, title: candidate.text.slice(0, 80) })
      else result.ignored.push({ eventId: event.eventId, messageId: candidate.messageId, reason: evaluation.reason })
      // Ignored candidates keep their trigger and decision so the panel can explain why nothing was done.
      const built = buildRecords(candidate, evaluation, config, candidate.threadTitle)
      if (evaluation.kind === 'accept') this.attachContext(records, built)
      records.push(built)
    }
    result.nextCursor = nextCursor
    if (dryRun) {
      this.lastStatus = { phase: 'dry-run', mode: 'events', at: new Date().toISOString(), ...eventCounts(result), cursor }
      return result
    }
    await this.state.atomic((doc) => {
      absorb(doc, records)
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
    this.lastStatus = { phase: 'ok', mode: 'events', at: new Date().toISOString(), ...eventCounts(result), cursor: nextCursor }
    this.log(`event poll: fetched ${events.length}, accepted ${result.accepted.length}, ignored ${result.ignored.length}, cursor ${nextCursor}`)
    return result
  }

  /** Run newly accepted tickets through the executor, one at a time (worker → gates → publish when allowPush). */
  async autoExecute(ticketIds) {
    // Paused: do not dispatch new work. A pause that lands mid-queue also stops the remaining tickets.
    if (this.readConfig().config.paused === true) { this.log('auto-run skipped: paused'); return [] }
    const execute = this.deps.executeTicket ?? (await import('./executor.js')).executeTicket
    const dispatched = []
    for (const ticketId of ticketIds) {
      if (this.readConfig().config.paused === true) { this.log(`auto-run ${ticketId} skipped: paused`); break }
      try {
        this.log(`auto-run ticket ${ticketId}`)
        const run = await execute({ ctx: this.ctx, engine: this, ticketId, dryRun: false,
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
    return {
      engine: {
        phase: this.lastStatus.phase,
        mode,
        running: this.started,
        paused,
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
      paused,
      load: { running: stageCounts.working, queued: stageCounts.queued, waiting: waitingHuman,
        failed: stageCounts.failed, paused },
      flow24h,
      runs24hFailed,
      rules24h: rules24hOf(this.state.state, windowStart),
      sources: sourceStatuses(loaded, this.state.state, flow24h),
      repos: repos.map(repo => repoSummary(loaded, repo)),
      defaultRepo: config.defaultRepo,
      eval: { mode: config.eval.mode, rules: EVAL_RULES.map(rule => ({ ...rule })) },
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
    return { items, counts, paused: config.paused === true }
  }

  /** `GET engine/ticket/:id` — the ticket with its runs (newest first), the trigger/decision that made it and its thread. */
  ticketView(id) {
    const ticket = this.state.tickets?.[id]
    if (!ticket) return undefined
    const runs = (this.state.runs ?? []).filter(run => run.ticketId === id)
      .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
    const decision = this.decisionOfTicket(ticket)
    const trigger = this.triggerOfTicket(ticket, decision)
    const threadKey = ticket.origin?.threadKey ?? trigger?.threads?.[0] ?? decision?.threadKey
    const thread = threadKey ? this.state.threads?.[threadKey] ?? null : null
    const config = this.readConfig().config
    return { ticket: decorateTicket(config, ticket), runs, trigger: trigger ?? null, decision: decision ?? null, thread }
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
   * Record a human acceptance decision for a deployed Ticket (`POST engine/ticket/:id/accept`, contract §4 extension).
   * The deploy status and all its evidence stay untouched; `links.acceptance` is added, and an accepted Ticket also
   * best-effort removes its local worktree/feature branch (`links.cleanup`; rejection keeps them for the next fix).
   * → { ticket, cleanup? } | { missing: true } | { invalid: string }
   */
  async acceptTicket({ ticketId, ok = true, note } = {}) {
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
    // Acceptance is terminal for the local workspace: record the sign-off first, then best-effort clean the
    // worktree/branch. A cleanup failure must not roll back the human decision, so it is reported separately.
    await this.state.atomic((doc) => {
      const current = doc.tickets[ticketId]
      doc.tickets[ticketId] = { ...current, links: { ...current.links, acceptance } }
    })
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
    })
    return { ticket: this.state.tickets[ticketId], cleanup }
  }

  /** `GET engine/threads?filter=` — thread rows with trigger/decision/ticket counts (contract §4). */
  threadsView({ filter = 'all' } = {}) {
    const windowStart = new Date(Date.now() - DAY_MS).toISOString()
    const threads = Object.values(this.state.threads ?? {})
      .sort((left, right) => String(right.lastAt ?? '').localeCompare(String(left.lastAt ?? '')))
    const counts = { all: threads.length, subscribed: 0, recent: 0, new: 0 }
    const entries = threads.map(thread => {
      const triggers = this.triggersOfThread(thread.key)
      const decisions = this.decisionsOfThread(thread.key)
      const ticketIds = this.ticketIdsOfThread(thread.key)
      const subscribed = ticketIds.length > 0
      const recent = triggers.some(trigger => inWindow(trigger.at, windowStart))
      if (subscribed) counts.subscribed += 1
      if (recent) { counts.recent += 1; counts.new += 1 }
      const latest = [...decisions].sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))[0]
      return {
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
          ticketIds,
          state: subscribed ? 'subscribed' : recent ? 'recent' : 'idle',
        },
      }
    })
    // `recent` and `new` are the same 24h set (contract §4); they stay two names for the two client tabs.
    const items = entries.filter(entry => filter === 'subscribed' ? entry.subscribed
      : filter === 'recent' || filter === 'new' ? entry.recent
        : true).map(entry => entry.row)
    return { items, counts }
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
  decisionsView({ kind = 'all', window = 'all', offset = 0, limit = 50 } = {}) {
    const since = window === '24h' ? new Date(Date.now() - DAY_MS).toISOString() : ''
    const all = Object.values(this.state.decisions ?? {})
      .filter(decision => !since || inWindow(decision.at, since))
      .sort((left, right) => String(right.at ?? '').localeCompare(String(left.at ?? '')))
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
    }))
    return { items, total: filtered.length, counts }
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
}
