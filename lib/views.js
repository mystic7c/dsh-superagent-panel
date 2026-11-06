/**
 * Read-only projections consumed by the management panel. Everything here is derived from the persisted
 * document; no view mutates state. Shapes follow `spec/api-contract.md` v2 (which mirrors the research
 * prototype's view builders), with derivation notes where this implementation keeps a simpler stored record.
 */
import { page, newestFirst, preview, HOUR, DAY, clone } from './util.js'
import { defaultPrompts, defaultChanged, BUILT_IN } from './prompts.js'

const OPEN_STAGES = new Set(['person', 'working', 'idle'])
const dayAgo = () => new Date(Date.now() - DAY).toISOString()
const anyProblem = (facts) => Object.values(facts ?? {}).some(fact => fact?.problem)

/** Classify a ticket from its stored fields; the first matching rule wins. */
export function ticketStage(ticket) {
  if (ticket.ends) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const latest = ticket.assignments?.at(-1)
  const report = latest?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  if (report === 'blocked' || report === 'failed') return { stage: 'person', action: report }
  if (!latest || latest.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || latest.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}
export const liveTicket = (ticket) => ticketStage(ticket).stage !== 'ended'
export const canRetry = (ticket) => !ticket.ends && (!!ticket.delivery || ['blocked', 'failed'].includes(ticketStage(ticket).action))

const threadOf = (store, key) => store.threads?.[key]
function threadTitle(store, key) {
  const thread = threadOf(store, key)
  if (thread?.title) return thread.title
  const trigger = Object.values(store.triggers ?? {}).find(item => item.threads?.[0] === key)
  return trigger ? preview(trigger.text, 80) : key
}
function actorView(store, trigger) {
  const actor = trigger?.actor ?? { source: '', id: '', name: undefined }
  const source = store.settings?.policy?.sources?.[actor.source]
  const entry = [...(source?.allowed ?? []), ...(source?.bots ?? [])].find(item => item.id === actor.id)
  const name = entry?.name ?? actor.name ?? actor.id
  return { source: actor.source, id: actor.id, name: typeof name === 'string' ? { zh: name, en: name } : name, human: trigger?.human !== false }
}

/** One message with where it went and the action a person may take on it. */
export function triggerView(host, trigger, decisions) {
  const { store } = host
  const home = threadOf(store, trigger.threads?.[0])
  const disposition = trigger.disposition ?? {}
  const decision = disposition.decisionId ? store.decisions[disposition.decisionId]
    : (decisions ?? Object.values(store.decisions)).filter(item => item.triggerIds?.includes(trigger.id)).at(-1)
  const queued = !!home?.pending?.includes(trigger.id)
  const evaluating = !!home?.evaluating?.triggerIds?.includes(trigger.id)
  const delivered = (home?.subscriptions ?? []).length > 0 && !decision
  const settled = !!decision && !['stop', 'unavailable'].includes(decision.kind) && !(decision.reason ?? []).some(item => item.code === 'routed')
  const decided = !!disposition.acked?.length || settled
  const unjudged = !!disposition.filtered || decision?.kind === 'unavailable' || delivered || !!(disposition.fanout?.length && !decided)
  return {
    id: trigger.id, source: trigger.source, actor: actorView(store, trigger), human: trigger.human !== false,
    addresses: trigger.addressed ?? undefined, at: trigger.at, text: trigger.text, preview: preview(trigger.text),
    ...trigger.url ? { url: trigger.url } : {}, threads: trigger.threads ?? [], actions: { requeue: trigger.human !== false && !queued && !evaluating && unjudged },
    disposition: { queued, evaluating, delivered, filtered: disposition.filtered, fanout: disposition.fanout ?? [],
      handbacks: disposition.handbacks ?? [], decision: decision ? { id: decision.id, outcome: decisionOutcome(decision), reason: decision.reason ?? [], ticketId: decision.ticketId } : undefined },
  }
}

function decisionOutcome(decision) {
  return decision.kind === 'ignore' && decision.audit?.wouldAccept ? 'wouldAccept' : decision.kind
}
export function decisionView(host, decision) {
  const { store } = host
  const rulesById = new Map((store.settings.policy.rules ?? []).map(rule => [rule.id, rule]))
  const thread = threadOf(store, decision.threadKey)
  const texts = (decision.triggerIds ?? []).flatMap(triggerId => { const trigger = store.triggers[triggerId]; return trigger ? [preview(trigger.text)] : [] })
  return { id: decision.id, kind: decision.kind, outcome: decisionOutcome(decision), reason: decision.reason ?? [], at: decision.at,
    strength: decision.strength ?? 'explicit', ...decision.ticketId ? { ticketId: decision.ticketId } : {}, triggerIds: decision.triggerIds ?? [],
    thread: decision.threadKey, ...thread ? { threadTitle: thread.title ?? threadKey(store, decision.threadKey) } : {},
    rules: decision.ruleAssessments
      ? decision.ruleAssessments.map(assessed => ({ id: assessed.ruleId, name: rulesById.get(assessed.ruleId)?.name ?? assessed.ruleId,
        matched: assessed.matched, reason: assessed.reason }))
      : (decision.rules ?? []).map(rule => ({ id: rule.id, name: rule.name ?? rulesById.get(rule.id)?.name ?? rule.id, matched: true,
        reason: '评估命中' })),
    ...decision.audit?.direction ? { direction: decision.audit.direction } : {},
    ...decision.dismissed ? { dismissed: true } : {},
    preview: texts.join(' / '),
    ...decision.ticketId && store.tickets[decision.ticketId] ? { ticketTitle: store.tickets[decision.ticketId].title } : {} }
}
const threadKey = (store, key) => key

/** A ticket's display line: stage, why it waits, and its links. */
export function ticketRow(host, ticket) {
  const { store } = host
  const stage = ticketStage(ticket)
  const latest = ticket.assignments?.at(-1)
  const summary = latest?.report?.text ?? ''
  const note = stage.stage !== 'person' ? undefined
    : stage.action === 'answer' ? { text: preview(ticket.attention?.text ?? ''), error: false }
    : stage.action === 'delivery' ? { text: preview(ticket.delivery?.error ?? ''), error: true }
    : stage.action === 'blocked' || stage.action === 'failed' ? { text: preview(summary.split('\n')[0] ?? ''), error: stage.action === 'failed' }
    : undefined
  const threads = (ticket.threads ?? []).map(key => {
    const thread = threadOf(store, key)
    return { key, title: thread?.title ?? key, ...thread?.facts ? { facts: thread.facts } : {}, ...thread?.url ? { url: thread.url } : {} }
  })
  const originTrigger = store.triggers[ticket.origin?.triggerId]
  const source = threads[0]?.key?.split(':')[0]
  const reply = threads[0]?.url ? { source, url: threads[0].url, label: source === 'feishu' ? '在飞书中回复' : '在 GitHub 中回复' } : undefined
  return { id: ticket.id, title: ticket.title, state: liveTicket(ticket) ? 'open' : 'ended', ...stage, ...note ? { note } : {},
    actions: { retry: canRetry(ticket), stop: liveTicket(ticket) },
    strength: ticket.origin?.strength ?? 'explicit',
    ...ticket.ends ? { ended: { ...ticket.ends, reason: ticket.ends.reason } } : {},
    ...ticket.attention ? { attention: { question: ticket.attention.text, at: ticket.attention.at } } : {},
    assignments: ticket.assignments?.length ?? 0, inputs: ticket.inputs?.length ?? 0,
    undelivered: ticket.delivery ? 1 : 0,
    ...ticket.delivery?.error ? { deliveryError: ticket.delivery.error } : {},
    sessionId: ticket.executorSession ?? '',
    directory: ticket.executionDirectory ?? '',
    summary,
    createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
    threads,
    ...reply ? { reply } : {},
    ...originTrigger ? { actor: actorView(store, originTrigger) } : {} }
}

/** Thread lifecycle: poll error, evaluating, queued, subscribed by an open ticket, dormant, or unsubscribed. */
export function threadStage(host, thread) {
  const { store } = host
  if (thread.meta?.pollError) return 'error'
  if (thread.evaluating) return 'evaluating'
  if ((thread.pending ?? []).length) return 'queued'
  const tickets = (thread.subscriptions ?? []).map(id => store.tickets[id]).filter(Boolean)
  if (tickets.some(liveTicket)) return 'subscribed'
  return (thread.subscriptions ?? []).length ? 'dormant' : 'unsubscribed'
}
export function threadSummary(host, thread) {
  const { store } = host
  const triggers = Object.values(store.triggers ?? {}).filter(trigger => trigger.threads?.[0] === thread.key).sort((a, b) => a.at.localeCompare(b.at))
  const latestTrigger = triggers.at(-1)
  const tickets = (thread.subscriptions ?? []).map(id => {
    const ticket = store.tickets[id]
    return { id, title: ticket?.title ?? id, state: !ticket ? 'unknown' : liveTicket(ticket) ? 'open' : 'ended' }
  })
  return { key: thread.key, source: thread.key.split(':')[0], title: thread.title ?? thread.key,
    stage: threadStage(host, thread),
    latest: latestTrigger ? { actor: actorView(store, latestTrigger), human: latestTrigger.human !== false, at: latestTrigger.at,
      preview: preview(latestTrigger.text, 120) } : undefined,
    lastAt: thread.lastAt ?? thread.createdAt, createdAt: thread.createdAt,
    subscriptions: (thread.subscriptions ?? []).length, tickets,
    ...thread.evaluating ? { evaluating: { id: thread.evaluating.id, strength: thread.evaluating.strength ?? 'explicit',
      triggers: thread.evaluating.triggerIds?.length ?? 0, startedAt: thread.evaluating.startedAt, deadline: thread.evaluating.deadline } } : {},
    pending: (thread.pending ?? []).length,
    ...thread.meta?.pollError ? { pollError: thread.meta.pollError } : {},
    ...thread.url ? { url: thread.url } : {},
    facts: thread.facts ?? {},
    ...anyProblem(thread.facts) ? { problem: true } : {} }
}
export function ticketSummaryLine(host, ticket) { return ticketRow(host, ticket) }

/** 24-hour trigger stats per source and overall, counted from the trigger records themselves. */
export function flowStats(store) {
  const since = dayAgo()
  const triggers = Object.values(store.triggers ?? {})
  const arrived = triggers.filter(trigger => trigger.at >= since)
  const received = arrived.length
  const filtered = arrived.filter(trigger => trigger.filtered).length
  const decided = Object.values(store.decisions ?? {}).filter(decision => decision.at >= since)
  const accepted = decided.filter(decision => ['accept', 'reopen'].includes(decision.kind)).length
  return { received, filtered, triggers: received - filtered, judged: decided.length, accepted,
    evaluating: Object.values(store.threads ?? {}).filter(thread => thread.evaluating).length,
    dropped: (store.outgoing ?? []).length }
}

/** Health map shown in `GET state`: concrete Source checks plus the runtime's own checks. */
export function healthMap(host) {
  const { store } = host
  const sources = store.sources ?? {}
  return {
    github: sources.github?.health ?? { state: 'idle', detail: '未配置' },
    feishu: sources.feishu?.health ?? { state: 'idle', detail: '未配置' },
    runtime: { state: 'ready', detail: '管理服务运行中' },
    models: { state: 'ready', detail: host.modelDetail ?? '模型服务可用' },
    assessment: { state: 'ready', detail: '最近 24 小时完成 ' + Object.values(store.decisions ?? {}).filter(d => d.at >= dayAgo()).length + ' 次评估' },
    evals: { state: 'ready', detail: '没有未决定的评估' },
    history: { state: 'ready', detail: '设置与提示词历史可读' },
  }
}

export function stateView(host) {
  const { store } = host
  const open = Object.values(store.tickets ?? {}).filter(liveTicket)
  return {
    setup: host.setup,
    load: { running: store.executor?.running ?? 0, queued: open.filter(ticket => ticketStage(ticket).action === 'queued').length,
      maxWorkers: store.settings.executor.maxWorkers, idle: open.filter(ticket => ticketStage(ticket).stage === 'idle').length },
    masterId: host.masterId ?? null,
    paused: !!store.settings.paused,
    health: healthMap(host),
    demo: store.demo === true,
  }
}

export function overviewView(host) {
  const { store } = host
  const open = Object.values(store.tickets ?? {}).filter(liveTicket)
  const person = open.filter(ticket => ticketStage(ticket).stage === 'person').map(ticket => ticketRow(host, ticket))
  const problems = []
  if (host.setup?.problem) problems.push({ kind: 'setup', ...host.setup.problem })
  const running = Object.keys(store.sources ?? {}).filter(id => store.settings.sources?.[id]?.enabled !== false)
  if (!running.length) problems.push({ kind: 'no-source' })
  const policy = store.settings.policy
  if (!Object.values(policy.sources ?? {}).some(part => (part.allowed ?? []).length > 0)) problems.push({ kind: 'no-allowed' })
  for (const [id, source] of Object.entries(store.sources ?? {})) {
    if (store.settings.sources?.[id]?.enabled === false) continue
    if (source.health?.state === 'error') problems.push({ kind: 'source-error', source: { id, title: sourceTitle(id), health: source.health } })
  }
  if (store.settings.paused) problems.push({ kind: 'executor-paused' })
  const health = healthMap(host)
  for (const [name, item] of Object.entries(health)) {
    if (item.state === 'error' && name !== 'github' && name !== 'feishu' && name !== 'evals') problems.push({ kind: 'runtime-error', name, detail: item.detail })
  }
  for (const [key, thread] of Object.entries(store.threads ?? {})) {
    if (thread.evaluating && thread.evaluating.deadline < new Date().toISOString()) problems.push({ kind: 'eval-overdue', thread: threadSummary(host, thread) })
  }
  for (const decision of Object.values(store.decisions ?? {})) {
    if (decision.kind !== 'unavailable' || decision.dismissed) continue
    const thread = store.threads[decision.threadKey]
    const newer = Object.values(store.decisions).some(item => item.threadKey === decision.threadKey && item.at > decision.at && item.kind !== 'unavailable')
    if (!thread || newer || thread.evaluating || (thread.pending ?? []).length) continue
    problems.push({ kind: 'eval-unavailable', decisionId: decision.id, thread: threadSummary(host, thread), reason: decision.reason ?? [], triggerId: decision.triggerIds?.[0] ?? '' })
  }
  for (const outgoing of store.outgoing ?? []) {
    problems.push({ kind: 'outgoing', outgoing: { id: outgoing.id, channel: outgoing.channel, text: preview(outgoing.text), attempts: outgoing.attempts, error: outgoing.error } })
  }
  return { problems, person, executor: stateView(host).load, flow: flowStats(store), policyVersion: store.meta?.policyVersion ?? 'pol_1' }
}

const sourceTitle = (id) => ({ zh: id === 'github' ? 'GitHub' : '飞书', en: id === 'github' ? 'GitHub' : 'Feishu' })

export function sourcesView(host) {
  const { store } = host
  return Object.entries(store.sources ?? {}).map(([id, source]) => {
    const config = store.settings.sources?.[id]?.config ?? {}
    const triggers = Object.values(store.triggers ?? {}).filter(trigger => trigger.source === id && trigger.at >= dayAgo())
    const filtered = triggers.filter(trigger => trigger.filtered)
    const stats = { received: triggers.length, filtered: filtered.length,
      lastAt: triggers.map(trigger => trigger.at).sort().at(-1) ?? '' }
    const state = host.setup?.problem && !host.setup?.accounts ? 'setup'
      : store.settings.sources?.[id]?.enabled === false ? 'off'
      : source.health?.state === 'error' ? 'error'
      : source.health?.state === 'starting' ? 'starting'
      : 'ready'
    const dropped = (store.outgoing ?? []).filter(item => item.channel?.source === id && (!item.at || item.at >= dayAgo())).map((item, index) => {
      const ticket = store.tickets[item.ticketId]
      const channel = item.channel
      return { id: item.id ?? `out_${index}`, kind: 'reply', channel, preview: preview(item.text), dropped: item.error,
        ...item.at ? { at: item.at } : {},
        ...ticket ? { ticket: { id: ticket.id, title: ticket.title } } : {}, ...channel?.thread ? { thread: channel.thread } : {} }
    })
    return { id, title: sourceTitle(id), installed: true, enabled: store.settings.sources?.[id]?.enabled !== false, state,
      health: [{ name: id, ...(source.health ?? { state: 'idle', detail: '' }) }, ...(source.sync ? [{ name: `sync:${id}`, ...source.sync }] : [])],
      ...host.setup?.problem && id === host.setup.problem.place ? { problem: host.setup.problem } : {},
      stats, filtered: filtered.sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5).map(trigger => ({ id: trigger.id, at: trigger.at,
        actor: actorView(store, trigger), human: trigger.human !== false, preview: preview(trigger.text), reason: trigger.filtered,
        ...trigger.threads?.[0] ? { thread: trigger.threads[0] } : {} })),
      dropped, config }
  })
}

export function searchView(host, query) {
  const { store } = host
  const value = String(query ?? '').trim()
  if (!value) return { tickets: [], items: [], threads: [] }
  const lower = value.toLowerCase()
  const matches = (text) => String(text ?? '').toLowerCase().includes(lower)
  const tickets = Object.values(store.tickets ?? {}).filter(ticket => matches(ticket.title) || (ticket.threads ?? []).some(key => matches(key)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 10)
    .map(ticket => ({ id: ticket.id, title: ticket.title, stage: ticketStage(ticket).stage }))
  const threads = Object.values(store.threads ?? {}).filter(thread => matches(thread.title) || matches(thread.key))
    .slice(0, 10).map(thread => ({ key: thread.key, title: thread.title ?? thread.key }))
  const items = Object.values(store.triggers ?? {}).filter(trigger => matches(trigger.text) || matches(trigger.id) || matches(trigger.url))
    .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 20).map(trigger => {
      const row = triggerView(host, trigger)
      const home = threadOf(store, trigger.threads?.[0])
      return { ...row, threadTitle: home ? home.title : undefined, ...trigger.filtered && !home ? { filtered: trigger.filtered } : {} }
    })
  return { tickets, threads, items }
}

export function threadListView(host, filter, offset, limit) {
  const { store } = host
  const since = dayAgo()
  const all = Object.values(store.threads ?? {})
  const kept = all.filter(thread => {
    if (filter === 'all') return true
    if (filter === 'recent') return (thread.lastAt ?? thread.createdAt) >= since
    if (filter === 'subscribed') return (thread.subscriptions ?? []).some(id => store.tickets[id] && liveTicket(store.tickets[id]))
    return !!thread.evaluating || (thread.pending ?? []).length > 0
  }).sort((a, b) => (b.lastAt ?? b.createdAt ?? '').localeCompare(a.lastAt ?? a.createdAt ?? ''))
  const paged = page(kept, offset, limit)
  return { ...paged, items: paged.items.map(thread => threadSummary(host, thread)) }
}

export function threadDetailView(host, key, before, limit = 20) {
  const { store } = host
  const thread = store.threads?.[key]
  if (!thread) return undefined
  const triggers = Object.values(store.triggers ?? {}).filter(trigger => trigger.threads?.[0] === key).sort((a, b) => a.at.localeCompare(b.at))
  const cut = before ? triggers.filter(trigger => `${trigger.at}|${trigger.id}` < before) : triggers
  const shown = cut.slice(Math.max(0, cut.length - limit))
  const decisions = Object.values(store.decisions ?? {}).filter(decision => decision.threadKey === key).sort((a, b) => b.at.localeCompare(a.at))
  return {
    ...threadSummary(host, thread),
    facts: thread.facts ?? {},
    ...thread.url ? { url: thread.url } : {},
    context: thread.context ?? [],
    correlated: (thread.correlated ?? []).map(other => ({ key: other, title: threadTitle(store, other) })),
    tickets: (thread.subscriptions ?? []).flatMap(ticketId => { const ticket = store.tickets[ticketId]; return ticket ? [ticketRow(host, ticket)] : [] }),
    decisions: decisions.slice(0, 20).map(decision => decisionView(host, decision)),
    timeline: shown.map(trigger => triggerView(host, trigger, decisions)),
    earlier: cut.length > shown.length && shown.length ? `${shown[0].at}|${shown[0].id}` : null,
    meta: Object.fromEntries(Object.entries(thread.meta ?? {}).filter(([, value]) => typeof value === 'string')),
  }
}

export function decisionListView(host, kind, offset, limit, window) {
  const { store } = host
  const since = window === '24h' ? dayAgo() : ''
  const kinds = kind === 'all' ? undefined : kind === 'work' ? ['accept', 'reopen'] : kind === 'stop' ? ['stop'] : kind === 'ignore' ? ['ignore'] : kind === 'unavailable' ? ['unavailable'] : undefined
  const all = Object.values(store.decisions ?? {}).filter(decision => (!since || decision.at >= since) && (!kinds || kinds.includes(decision.kind)))
    .sort((a, b) => b.at.localeCompare(a.at))
  const paged = page(all, offset, limit)
  return { ...paged, items: paged.items.map(decision => decisionView(host, decision)) }
}

export function ticketListView(host, filter, offset, limit) {
  const { store } = host
  const all = Object.values(store.tickets ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const kept = all.filter(ticket => filter === 'open' ? liveTicket(ticket) : ticketStage(ticket).stage === filter)
  const paged = page(kept, offset, limit)
  return { ...paged, items: paged.items.map(ticket => ticketRow(host, ticket)) }
}

export function ticketDetailView(host, id) {
  const { store } = host
  const ticket = store.tickets?.[id]
  if (!ticket) return undefined
  const originTrigger = store.triggers[ticket.origin?.triggerId]
  const decision = ticket.origin?.decisionId ? store.decisions[ticket.origin.decisionId] : undefined
  const home = threadOf(store, ticket.origin?.threadKey)
  const facts = []
  if (originTrigger?.addressed) facts.push({ name: 'addressed', value: originTrigger.addressed })
  const source = store.settings.policy.sources?.[home?.key?.split(':')[0]]
  const sender = originTrigger?.actor?.id
  const senderName = sender ? [...(source?.allowed ?? []), ...(source?.bots ?? [])].find(item => item.id === sender)?.name : undefined
  if (senderName) facts.push({ name: 'sender', value: senderName })
  if ((decision?.rules ?? []).length) facts.push({ name: 'rules', value: decision.rules })
  if (!originTrigger?.addressed) facts.push({ name: 'admission', value: 'listedUnaddressed' })
  const inputs = (ticket.inputs ?? []).slice().reverse().map(input => {
    const trigger = input.triggerId ? store.triggers[input.triggerId] : undefined
    return { ...input, delivered: !(ticket.delivery && ticket.delivery.inputId === input.id),
      ...trigger ? { trigger: { id: trigger.id, actor: actorView(store, trigger), human: trigger.human !== false,
        preview: preview(trigger.text), thread: trigger.threads?.[0] } } : {} }
  })
  const timeline = Object.values(store.triggers ?? {}).filter(trigger => (ticket.threads ?? []).includes(trigger.threads?.[0]))
    .sort((a, b) => a.at.localeCompare(b.at)).slice(-20).map(trigger => triggerView(host, trigger))
  return {
    ticket: ticketRow(host, ticket),
    body: ticket.body ?? '',
    authorization: { scope: ticket.origin?.scope ?? '', policyVersion: ticket.origin?.policyVersion ?? '',
      strength: decision?.strength ?? 'explicit',
      via: originTrigger?.addressed ? 'addressed' : 'admission',
      actor: actorView(store, originTrigger), rules: decision?.rules ?? [],
      ...senderName ? { sender: senderName } : {}, ...originTrigger?.addressed ? {} : { cell: 'listedUnaddressed' } },
    ...decision ? { decision: decisionView(host, decision) } : {},
    facts,
    inputs,
    subscriptions: (ticket.threads ?? []).flatMap(key => {
      const thread = threadOf(store, key)
      return thread ? [{ key, title: thread.title ?? key, context: !(thread.subscriptions ?? []).includes(ticket.id) }] : []
    }),
    assignments: (ticket.assignments ?? []).map(assignment => ({ id: assignment.id, state: assignment.state,
      executor: assignment.executor ?? '', startedAt: assignment.startedAt ?? '', ...assignment.endedAt ? { endedAt: assignment.endedAt } : {},
      ...assignment.report ? { report: assignment.report } : {} })),
    timeline,
    environment: host.environment ?? [],
    paused: !!store.settings.paused,
    ...canRetry(ticket) ? {} : {},
  }
}

/** Settings page: versioned blocks, per-source forms and policy facts, environment variables. */
export function settingsView(host) {
  const { store } = host
  const settings = store.settings
  const sourceRow = (id) => {
    const instance = settings.sources?.[id] ?? { enabled: false, config: {} }
    const source = store.sources?.[id] ?? {}
    const policy = settings.policy.sources?.[id] ?? { allowed: [], bots: [] }
    return { id, kind: id, title: sourceTitle(id), description: sourceDescription(id), installed: true, enabled: instance.enabled !== false,
      value: { enabled: instance.enabled !== false, config: instance.config ?? {} }, revision: store.revision(`source:${id}`),
      restarts: id === 'github' ? ['repository', 'cli'] : ['cli'],
      fields: sourceFields(id), facts: source.facts ?? {}, labels: source.labels ?? {},
      ...host.setup?.problem && host.setup.problem.place === id ? { problem: host.setup.problem } : {},
      policy: { fields: [{ key: 'allowed', label: { zh: '允许发起工作的人', en: 'Allowed senders' }, type: 'rows',
          columns: [{ key: 'id', label: { zh: '账号', en: 'Account' } }, { key: 'name', label: { zh: '名称', en: 'Name' } }] },
        { key: 'bots', label: { zh: '机器人', en: 'Bots' }, type: 'rows',
          columns: [{ key: 'id', label: { zh: '账号', en: 'Account' } }, { key: 'name', label: { zh: '名称', en: 'Name' } }] }],
        explicit: true,
        sync: { label: '同步名单', ready: true, health: source.sync } } }
  }
  return {
    revision: store.revision('global'),
    policyVersion: store.meta?.policyVersion ?? 'pol_1',
    pause: { revision: store.revision('pause'), value: { paused: !!settings.paused } },
    blocks: { eval: { revision: store.revision('eval'), value: settings.eval }, executor: { revision: store.revision('executor'), value: settings.executor } },
    policy: { revision: store.revision('policy'), rules: (settings.policy.rules ?? []).map(rule => ({ id: rule.id, name: rule.name, enabled: !!rule.enabled, instruction: rule.instruction })),
      allowed: Object.fromEntries(Object.entries(settings.policy.sources ?? {}).map(([id, part]) => [id, (part.allowed ?? []).length])),
      read: 'settings/policy', value: clone(settings.policy) },
    sources: [sourceRow('github'), sourceRow('feishu')],
    environment: { root: settings.executor.directoryRoot, variables: host.environment ?? [] },
  }
}

const sourceDescription = (id) => id === 'github'
  ? { zh: '监听一个 GitHub 仓库的 Issue、PR、评论与默认分支 CI，并把请求变成工单。', en: 'Watch one GitHub repository for issues, pull requests, comments and default-branch CI, and turn requests into tickets.' }
  : { zh: '监听机器人所在群里的消息，并把对话中的请求变成工单。', en: 'Watch the chats the bot has joined and turn requests there into tickets.' }
function sourceFields(id) {
  if (id === 'github') return [
    { key: 'repository', label: { zh: '仓库', en: 'Repository' }, type: 'text', placeholder: 'owner/name', required: true },
    { key: 'cli', label: { zh: 'gh 命令', en: 'gh command' }, type: 'text', placeholder: 'gh', description: { zh: '以哪个 GitHub CLI 身份读取与推送。', en: 'Which GitHub CLI identity reads and pushes.' } },
    { key: 'pollSeconds', label: { zh: '轮询间隔（秒）', en: 'Poll interval (s)' }, type: 'number' },
    { key: 'readLimit', label: { zh: '单次读取上限', en: 'Read limit per poll' }, type: 'number' },
    { key: 'receive', label: { zh: '接收范围', en: 'Receive' }, type: 'boolean' },
  ]
  return [{ key: 'cli', label: { zh: '机器人 CLI', en: 'Bot CLI' }, type: 'text', placeholder: 'lark-cli', required: true }]
}

export function historyView(host) {
  const { store } = host
  const items = (store.settingsHistory ?? []).map((entry, index, all) => ({ revision: entry.revision, savedAt: entry.savedAt,
    source: entry.source, block: entry.block, policyVersion: entry.policyVersion, policyChanged: !!entry.policyChanged,
    notified: entry.notified ?? [], changes: entry.changes ?? (index < all.length - 1 ? null : null) }))
  return { current: store.revision('global'), policyVersion: store.meta?.policyVersion ?? 'pol_1', items }
}

/** Prompt page: saved configuration, its history, built-in parts, and the changes an upgrade made to defaults. */
export function promptsView(host, revision) {
  const { store } = host
  const prompts = store.prompts ?? { revision: 0, config: defaultPrompts(), history: [] }
  const history = prompts.history ?? []
  const wanted = revision === undefined || !Number.isFinite(revision) ? prompts.revision : revision
  const entry = history.find(item => item.revision === wanted)
  const defaults = defaultPrompts()
  const config = wanted === prompts.revision ? prompts.config : (entry?.config ?? (wanted === 0 ? defaults : undefined))
  if (!config) return { notFound: true, revision: prompts.revision, baseRevision: prompts.revision, defaults,
    config: prompts.config, saved: false, history: history.slice(0, 20), defaultChanges: [], builtIn: [], skills: [], sections: {} }
  return { revision: wanted, current: prompts.revision, baseRevision: prompts.baseRevision ?? prompts.revision,
    defaults, config,
    saved: JSON.stringify(config) === JSON.stringify(defaults),
    history: history.slice(0, 20),
    defaultChanges: defaultChanged(config, prompts.builtIns ?? {}),
    builtIn: Object.entries(BUILT_IN).map(([key, value]) => ({ key, roles: [...value.roles], placeholders: [...(value.placeholders ?? [])], text: value.text })),
    skills: Object.entries(config.skills ?? {}).map(([name, text]) => ({ name, text })),
    sections: { communication: config.communication, scope: config.scope, delivery: config.delivery } }
}

export function modelsView(models) {
  return models
}

export { HOUR, newestFirst, preview }
