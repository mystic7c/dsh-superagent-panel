/* Overview: the shift brief. It answers three operator questions in three bands — does anything need me (the desk),
   what changed since I last looked (funnel + policy ledger + since-last-look line), and is the system healthy and
   drifting anywhere (system pulse + watchlist) — then folds the engine's own state away at the bottom. Every new
   block is a cross-record rollup: no TicketRow list, no per-Source card, no settings field is repeated here.
   Data is the one status document from `usePanelData` (32-live-model); rows, the funnel and the problem derivation
   stay shared with the other pages (34-live-ui). Contract: spec/impl-contract-2026-11.md §6.1; round-2 critique:
   spec/…/.impeccable/critique/2026-11-05T10-56-46Z__superagent-panel.md (O1–O7). */

Object.assign(PAGE_TEXT, {
  'ov.needsYou': ['需要你处理', 'Needs you'],
  'ov.inboxError': ['待办列表加载失败，概览计数可能滞后；可重试。', 'The inbox failed to load; the desk count may be stale. Retry.'],
  'ov.activeProgress': ['{step} · 已运行 {elapsed}', '{step} · running {elapsed}'],
  'ov.elapsedLess': ['不到 1 分钟', '< 1 min'],
  'ov.elapsedMinutes': ['{count} 分钟', '{count} min'],
  'ov.elapsedHours': ['{hours} 小时 {minutes} 分', '{hours}h {minutes}m'],
  'ov.problems': ['系统问题', 'System problems'],
  'ov.flow24h': ['过去 24 小时', 'Last 24 hours'],
  'ov.runtime': ['运行状态', 'Runtime status'],
  'ov.idleTitle': ['现在没有需要你处理的事', 'Nothing needs you right now'],
  'ov.onlyCount': ['共 {count} 件需要你处理，打开执行页查看。', '{count} Tickets need you; open Execution.'],
  'ov.deskScope': ['需要你处理 = 等你签收；值得留意 = 无需你动作的漂移。',
    'Needs you = waiting for your sign-off; Worth a look = drift that needs no action.'],
  'ov.noFlow': ['暂无 24 小时数据', 'No 24-hour data yet'],
  'ov.paused': ['处理已暂停：不开始新的评估、派工或回复。', 'Processing is paused: no new Eval, dispatch or reply starts.'],
  'ov.resume': ['去执行页恢复', 'Resume on Execution'],
  'ov.runState': ['运行/暂停', 'Running / paused'],
  'ov.pollInterval': ['轮询间隔', 'Poll interval'],
  'ov.seconds': ['{value} 秒', '{value}s'],
  'ov.engineLastPoll': ['引擎最近轮询', 'Last engine poll'],
  'ov.cursor': ['群游标', 'Group cursor'],
  'ov.autoVerify': ['自动巡检', 'Auto check'],
  'ov.autoVerifyValue': ['每 {value} 秒', 'every {value}s'],
  'ov.counts': ['工单 / 运行 / 触发', 'Tickets / runs / triggers'],
  'ov.countsValue': ['{tickets} / {runs} / {triggers}', '{tickets} / {runs} / {triggers}'],
  'ov.configFile': ['配置文件', 'Config file'],
  'ov.summary': ['轮询每 {seconds} 秒 · 引擎最近轮询 {time}', 'Polls every {seconds}s · last engine poll {time}'],

  // ---- shift brief: system pulse -------------------------------------------------------------------------------
  'ov.pulse': ['系统脉搏', 'System pulse'],
  'ov.pulseEngine': ['引擎', 'Engine'],
  'ov.pulseSources': ['来源', 'Sources'],
  'ov.pulseExecutor': ['执行器', 'Executor'],
  'ov.pulseLifetime': ['累计', 'Lifetime'],
  'ov.running': ['正在执行', 'Running now'],
  'ov.pulseInFlight': ['在飞', 'In flight'],
  'ov.pulseNext': ['每 {seconds} 秒轮询 · 下次轮询 {remain} 秒后', 'Polls every {seconds}s · next in {remain}s'],
  'ov.pulseDue': ['每 {seconds} 秒轮询 · 正在轮询', 'Polls every {seconds}s · polling now'],
  'ov.pulsePaused': ['处理已暂停 · 不自动轮询', 'Paused · no automatic polling'],
  'ov.pulseOff': ['自动触发未开启', 'Automatic intake is off'],
  // Same denominator as the Source page ("已启用 1/3"): a disabled Source is configuration, not an incident.
  'ov.pulseSourcesValue': ['已启用 {active}/{total}', '{active}/{total} enabled'],
  'ov.pulseSourcesBad': [' · {count} 个异常', ' · {count} failing'],
  'ov.pulseExecutorIdle': ['空闲 · 无排队或运行中工单', 'Idle · nothing queued or running'],
  'ov.pulseExecutorOff': ['已停用（设置→运行）', 'Disabled (Settings → Runtime)'],
  'ov.pulseExecutorValue': ['执行中 {running} · 排队 {queued} · 等待你 {waiting} · 失败 {failed}',
    '{running} running · {queued} queued · {waiting} waiting · {failed} failed'],
  'ov.pulseLifetimeValue': ['读取 {received} · 接单 {accepted} · 忽略 {ignored}',
    '{received} read · {accepted} accepted · {ignored} ignored'],
  'ov.pulseActive': ['{count} 张 · {progress}', '{count} · {progress}'],
  'ov.pulseIdleActive': ['空闲 · 等待群消息', 'Idle · waiting for a group message'],

  // ---- shift brief: policy ledger ------------------------------------------------------------------------------
  'ov.rulesTitle': ['策略规则 · 近 24 小时（拦截 / 通过）', 'Policy rules · blocked / passed in the last 24h'],
  'ov.rulesEmpty': ['近 24 小时没有规则通过。', 'No rule passed in the last 24 hours.'],
  'ov.ruleValue': ['{name} · 拦截 {blocked} · 通过 {hits}', '{name} · {blocked} blocked · {hits} passed'],

  // ---- shift brief: worth a look -------------------------------------------------------------------------------
  'ov.watch': ['值得留意', 'Worth a look'],
  'ov.watchEmpty': ['没有发现需要留意的问题。', 'Nothing needs a second look.'],
  'ov.watchRuns': ['过去 24 小时 {count} 次执行失败', '{count} failed runs in the last 24 hours'],
  'ov.watchSameCause': ['，其中 {count} 次同一原因：{reason}', ', {count} of them share one cause: {reason}'],
  'ov.watchDismissed': ['{count} 张工单在失败后被忽略', '{count} Tickets were dismissed after a failed run'],
  'ov.watchSource': ['{name} 来源状态异常', '{name} is failing'],
  'ov.watchPoll': ['引擎轮询已滞后 {minutes} 分钟', 'Engine polling is {minutes} min behind'],
  'ov.watchOpen': ['查看', 'Open'],
  'ov.errorInterrupted': ['插件重载或宿主重启中断了执行', 'the run was interrupted by a plugin reload or host restart'],
  'ov.errorInternal': ['执行器内部错误（读取了空对象）', 'an executor internal error (read a missing object)'],
  'ov.errorNoChanges': ['worker 没有产生任何改动', 'the worker produced no changes'],

  // ---- shift brief: since the last look ------------------------------------------------------------------------
  'ov.since': ['上次查看 {time} · 之后 {decisions} 次评估 · {tickets} 张新工单 · {failures} 次执行失败',
    'Last look {time} · since then {decisions} Evals · {tickets} new Tickets · {failures} failed runs'],
  'ov.sinceNone': ['上次查看 {time} · 之后没有新的变化', 'Last look {time} · nothing new since'],

  // ---- actionable inbox (P0-5): the desk is the host's own blocking items, not a client-side status filter --------
  'ov.inboxGoTicket': ['去工单', 'Open Ticket'],
  'ov.inboxGoSource': ['去来源', 'Open Source'],

  // ---- P2-9 run quality (GET engine/metrics) ---------------------------------------------------------------------
  'ov.q.title': ['运行质量', 'Run quality'],
  'ov.q.empty': ['过去 24 小时没有运行。', 'No runs in the last 24 hours.'],
  'ov.q.kpi': ['运行 {runs} 次 · 成功率 {rate}% · 平均耗时 {avg}s · 自动修复 {repaired} 次',
    '{runs} runs · {rate}% succeeded · {avg}s avg · {repaired} auto-repairs'],
  'ov.q.failures': ['主要失败原因', 'Top failure causes'],
  'ov.q.failureCount': ['{count} 次', '{count}×'],
  'ov.q.triggers': ['触发：手动 {manual} · 自动 {auto} · 定时 {timed}',
    'Triggers: {manual} manual · {auto} automatic · {timed} timed'],
  'ov.q.acceptance': ['验收：{rounds} 轮 · 通过 {rate}%', 'Acceptance: {rounds} rounds · {rate}% passed'],
  'ov.q.openExecution': ['去执行页', 'Open Execution'],

  // ---- folded runtime details: a 30-group cursor row stays two lines until it is expanded ------------------------
  'ov.cursorMore': ['其余 {count} 个', '{count} more'],
  // The poll cadence can be absent on an older host: the summary cannot promise a number it does not have.
  'ov.summaryAlt': ['轮询间隔未知 · 更新于 {time}', 'Poll interval unknown · updated {time}'],
})

const OV_LAST_SEEN_KEY = 'superagent-panel/lastSeen'
const OV_DAY_MS = 86_400_000

/** The previous visit's wall clock, kept local to this profile; a private-mode failure just hides the line. */
function ovReadLastSeen() {
  try {
    const value = Number(JSON.parse(localStorage.getItem(OV_LAST_SEEN_KEY) ?? 'null'))
    return Number.isFinite(value) && value > 0 ? value : undefined
  } catch { return undefined }
}
function ovSaveLastSeen(value) {
  try { localStorage.setItem(OV_LAST_SEEN_KEY, JSON.stringify(value)) } catch { /* route memory already degrades the same way */ }
}

/** One clock tick per second, only for the overview: the next-poll countdown is the panel's heartbeat. */
function useOverviewNow(intervalMs = 1000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])
  return now
}

// The hand-built `MM-DD HH:mm` was the same string in both languages and bypassed the locale's digit/order rules.
const ovStampFormatter = lang => new Intl.DateTimeFormat(lang === 'en' ? 'en' : 'zh-CN',
  { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
function ovStamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return ovStampFormatter(PANEL_LANG).format(date)
}
const ovCount = (value, lang) => Number(value ?? 0).toLocaleString(lang === 'en' ? 'en' : 'zh-CN')
const ovClip = (value, limit = 64) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Inbox kind → the row's shape icon (the same icon family the other list rows use). Unknown kinds fall back to inbox. */
const OV_INBOX_ICON = { gate: 'blocked', accept: 'decision', publish: 'play', failure: 'alert-triangle', source: 'inbox',
  engine: 'shield' }
const ovInboxIcon = item => OV_INBOX_ICON[item?.kind] ?? 'inbox'
/** Where one inbox item lives: its Ticket when it names one, else its Source, else the execution queue. */
function ovInboxTarget(item) {
  const refs = item?.refs ?? {}
  if (refs.ticketId) return { page: 'execution', id: refs.ticketId }
  if (refs.sourceId) return { page: 'source' }
  return { page: 'execution' }
}
/** The row's one button says where it goes; a gate/accept item always names its Ticket. */
function ovInboxActionKey(item) {
  const refs = item?.refs ?? {}
  if (refs.ticketId) return 'ov.inboxGoTicket'
  if (refs.sourceId) return 'ov.inboxGoSource'
  return 'ov.watchOpen'
}

/** Policy ledger fallback for payloads without `rules24h`: per rule, how often it blocked vs passed in the last 24h.
    → { rows: [{ name, hits, blocked }], total } — the host computes the same shape over the full decision store. */
function ovRuleHits(decisions, now) {
  const counts = new Map()
  let total = 0
  for (const decision of Array.isArray(decisions) ? decisions : []) {
    if (Date.parse(decision?.at ?? '') < now - OV_DAY_MS) continue
    total += 1
    for (const rule of Array.isArray(decision.rules) ? decision.rules : []) {
      const name = rule?.name ?? rule?.id
      if (!name) continue
      const entry = counts.get(name) ?? { hits: 0, blocked: 0 }
      if (rule.matched) entry.hits += 1
      else entry.blocked += 1
      counts.set(name, entry)
    }
  }
  return { total, rows: [...counts.entries()].map(([name, entry]) => ({ name, hits: entry.hits, blocked: entry.blocked }))
    .sort((left, right) => right.blocked - left.blocked || right.hits - left.hits
      || String(left.name).localeCompare(String(right.name))) }
}

/** Known executor failures are shown in the operator's language; an unknown error stays clipped and raw. */
function ovErrorLabel(t, error) {
  const text = String(error ?? '')
  if (/interrupted by a plugin reload|host restart/i.test(text)) return pt(t, 'ov.errorInterrupted')
  if (/Cannot read propert|reading 'get'/i.test(text)) return pt(t, 'ov.errorInternal')
  if (/worker made no changes/i.test(text)) return pt(t, 'ov.errorNoChanges')
  return ovClip(text, 64)
}

/**
 * P2-9 run quality view model from `GET engine/metrics`: every field degrades to 0/[] so an older or partially filled
 * payload cannot break the page. Returns undefined when the payload has no runs block at all (older hosts).
 */
function ovQualityOf(t, metrics) {
  if (!metrics || typeof metrics !== 'object') return undefined
  const runs = metrics.runs && typeof metrics.runs === 'object' ? metrics.runs : undefined
  if (!runs) return undefined
  const count = value => Math.max(0, Number(value) || 0)
  const total = count(runs.total)
  const succeeded = count(runs.succeeded)
  const repaired = count(runs.repaired)
  const duration = metrics.duration && typeof metrics.duration === 'object' ? metrics.duration : {}
  const avgMs = count(duration.avgMs)
  const rate = total > 0 ? Math.round((succeeded / total) * 100) : 0
  const failures = (Array.isArray(metrics.failureReasons) ? metrics.failureReasons : [])
    .filter(item => item && typeof item === 'object' && count(item.count) > 0)
    .slice(0, 3)
    .map(item => ({ reason: String(item.reason ?? ''), count: count(item.count) }))
  const triggers = metrics.triggers && typeof metrics.triggers === 'object' ? metrics.triggers : {}
  const manual = count(triggers.manual)
  const automatic = count(triggers.auto)
  const timed = count(triggers.heartbeat) + count(triggers.schedule)
  const triggerText = manual + automatic + timed > 0
    ? pt(t, 'ov.q.triggers', { manual, auto: automatic, timed }) : ''
  const acceptance = metrics.acceptance && typeof metrics.acceptance === 'object' ? metrics.acceptance : {}
  const rounds = count(acceptance.rounds)
  const delivered = count(acceptance.delivered)
  const failedRounds = count(acceptance.failed) + count(acceptance.errored)
  const acceptanceRate = rounds > 0 ? Math.round((delivered / Math.max(1, delivered + failedRounds)) * 100) : 0
  const acceptanceText = rounds > 0 ? pt(t, 'ov.q.acceptance', { rounds, rate: acceptanceRate }) : ''
  return { total, rate, avgText: avgMs > 0 ? String(Math.round(avgMs / 100) / 10) : '0', repaired,
    failures, triggerText, acceptanceText }
}

/** Drift the calm page owes the operator: failed runs, tickets dismissed after a failure, a failing Source, a stale poll. */
function ovWatchItems(t, data, now, options = {}) {
  const out = []
  const runs = Array.isArray(data.runs) ? data.runs : []
  const failed = runs.filter(run => run.status === 'failed' && Date.parse(run.startedAt ?? '') >= now - OV_DAY_MS)
  // P2-9 fallback: the status poll only carries the last ten runs, so the host's own 24h counter is the floor when the
  // metrics endpoint is unavailable. With metrics present the quality card is the authoritative reading.
  const hostFailed = Number(data.runs24hFailed)
  const failedCount = !options.metricsAvailable && Number.isFinite(hostFailed) && hostFailed > failed.length
    ? Math.floor(hostFailed) : failed.length
  if (failedCount > 0) {
    const causes = new Map()
    for (const run of failed) {
      const key = ovClip(run.error ?? '', 64) || pt(t, 'shell.unknown')
      causes.set(key, (causes.get(key) ?? 0) + 1)
    }
    const [reason, count] = [...causes.entries()].sort((left, right) => right[1] - left[1])[0] ?? []
    out.push({ key: 'runs', state: 'error', page: 'execution',
      title: pt(t, 'ov.watchRuns', { count: failedCount })
        + (count > 1 ? pt(t, 'ov.watchSameCause', { count, reason: ovErrorLabel(t, reason) }) : '') })
  }
  const dismissed = (Array.isArray(data.tickets) ? data.tickets : []).filter(ticket => ticket.status === 'dismissed'
    && (Array.isArray(ticket.assignments) ? ticket.assignments : []).some(assignment => assignment?.report?.state === 'failed'))
  if (dismissed.length) {
    out.push({ key: 'dismissed', state: 'warning', page: 'execution', stage: 'dismissed',
      title: pt(t, 'ov.watchDismissed', { count: dismissed.length }) })
  }
  const failingSources = (Array.isArray(data.sources) ? data.sources : [])
    .filter(source => source.enabled !== false && source.state === 'error')
  for (const source of failingSources.slice(0, 1)) {
    out.push({ key: `source-${source.id}`, state: 'error', page: 'source',
      title: pt(t, 'ov.watchSource', { name: localizedText(source.title) || source.id }) })
  }
  const paused = data.paused === true || data.config?.paused === true || data.engine?.paused === true
  const pollSeconds = Number(data.config?.pollSeconds) || 10
  const lastPoll = Date.parse(data.engine?.lastPollAt ?? '')
  if (!paused && data.config?.enabled !== false && Number.isFinite(lastPoll)) {
    const behind = Math.floor((now - lastPoll) / 60_000)
    if (behind >= Math.max(2, Math.ceil(pollSeconds * 3 / 60))) {
      out.push({ key: 'poll', state: 'warning', page: 'source', title: pt(t, 'ov.watchPoll', { minutes: behind }) })
    }
  }
  return out.slice(0, 3)
}

/** What happened while the operator was away, counted from the records the status document already carries. */
function ovSince(t, data, lastSeen) {
  const decisions = (Array.isArray(data.decisions) ? data.decisions : []).filter(item => Date.parse(item.at ?? '') > lastSeen).length
  const tickets = (Array.isArray(data.tickets) ? data.tickets : []).filter(item => Date.parse(item.createdAt ?? '') > lastSeen).length
  const failures = (Array.isArray(data.runs) ? data.runs : []).filter(run => run.status === 'failed'
    && Date.parse(run.startedAt ?? '') > lastSeen).length
  const time = ovStamp(lastSeen)
  return {
    total: decisions + tickets + failures,
    text: decisions + tickets + failures === 0 ? pt(t, 'ov.sinceNone', { time })
      : pt(t, 'ov.since', { time, decisions, tickets, failures }),
  }
}

function LiveOverviewPage({ route }) {
  const { t, navigate, notify } = usePanel()
  const { data, error, reload, updatedAt, actions } = usePanelData()
  const poll = useAction(async () => {
    const result = await actions.poll({ dryRun: true })
    notify(pt(t, 'toast.pollDone', { accepted: result?.accepted?.length ?? 0, ignored: result?.ignored?.length ?? 0 }))
  }, { reload })
  const reloadConfig = useAction(async () => { await actions.reloadConfig(); notify(pt(t, 'toast.configReloaded')) }, { reload })
  // One action for the three switches that are one story: resume, enable intake and enable the executor together.
  const startAutomation = useAction(async () => {
    await actions.patchSettings({ paused: false, enabled: true, 'executor.enabled': true })
    notify(pt(t, 'automation.started'))
  }, { reload })
  const [runtimeOpen, setRuntimeOpen] = useState(false)
  // The page used to re-render every second just to keep a countdown fresh; only the pulse/countdown read this clock,
  // so a 5 s beat keeps it honest without repainting the whole desk each second (WIG P2).
  const now = useOverviewNow(5000)
  // The previous visit is read once (this render) and written after it: reading it in an effect would already see
  // the new value and every visit would claim "nothing new".
  const [lastSeen] = useState(ovReadLastSeen)
  useEffect(() => { ovSaveLastSeen(Date.now()) }, [])
  // P0 inbox (contract §3.6.5): the host derives the actionable items, the desk lists them verbatim. An older host
  // has no `inbox` field, so the resource stays disabled (no 404 polling) and every surface falls back to needsHuman.
  const inbox = useLiveResource('engine/inbox', {}, 30000, { enabled: Boolean(data?.inbox) })
  // P2-9 run quality: the aggregate lives behind GET engine/metrics. Without data (older host or a failed fetch) the
  // whole section stays hidden, and the existing 24h failure hint remains the fallback.
  const metricsResource = useLiveResource('engine/metrics', { window: '24h' }, 30000, { enabled: Boolean(data) })

  // A ticket id on the overview route is a deep link: the full detail replaces the desk, as on every other tab.
  if (route?.id) return h(TicketDetail, { id: route.id, page: 'overview' })
  // First paint only; a failed poll keeps the last good document on screen (§7: polling never flashes a skeleton).
  if (!data) return error ? h(ErrorState, { error, onRetry: () => { void reload() } }) : h(Skeleton, { rows: 4 })

  const engine = data.engine ?? {}
  const config = data.config ?? {}
  const counts = data.counts ?? {}
  const setup = setupStateOf(data)
  const health = globalHealth(data)
  const paused = data.paused === true || config.paused === true || engine.paused === true
  const engineEnabled = config.enabled === true
  const executorEnabled = config.executor?.enabled !== false
  const prerequisitesReady = setup.steps.slice(0, 3).every(step => step.done)
  const automationNeeded = paused || !engineEnabled || !executorEnabled
  const showAutomationBar = automationNeeded && prerequisitesReady
  // The header count and this block share one source (#19); the rows are the latest 20 Tickets, so the count can be
  // larger than the list — that difference is said explicitly instead of showing a contradiction.
  const legacyHumanCount = needsYouCount(data)
  const legacyTickets = needsHuman(data)
  // Actionable inbox (P0): when the host exposes `inbox`, the desk is its blocking items — one row per item, count =
  // rendered rows. Without the field the old status-derived needsHuman logic still runs unchanged.
  const inboxSupported = Boolean(data.inbox)
  const inboxItems = (Array.isArray(inbox.data?.items) ? inbox.data.items : [])
    .filter(item => item && typeof item === 'object' && !item.resolvedAt)
  const blockingItems = inboxItems.filter(item => item.blocking === true)
  const systemInboxItems = inboxItems.filter(item => item.blocking !== true)
  const humanCount = inboxSupported ? (blockingItems.length || Math.max(0, Number(data.inbox?.blocking ?? 0))) : legacyHumanCount
  // Best effort on read: marking one item read must never stop the navigation the person asked for.
  const readInboxItem = item => {
    if (!item?.id) return
    void Promise.resolve(actions.readInbox?.(item.id)).then(() => inbox.reload?.()).catch(() => {})
  }
  const openInboxItem = item => {
    if (!item) return
    readInboxItem(item)
    navigate(ovInboxTarget(item))
  }
  // Work that is actually moving stays visible as one pulse sentence; the Ticket rows, queue bar and pause control
  // belong to the Execution page (contract §6.1, critique O3).
  const runs = Array.isArray(data.runs) ? data.runs : []
  const hasHistory = Number(counts.received ?? 0) > 0 || Number(counts.tickets ?? 0) > 0
    || Number(engine.events?.received ?? 0) > 0
    || (Array.isArray(data.tickets) && data.tickets.length > 0)
  const activeTickets = (Array.isArray(data.tickets) ? data.tickets : [])
    .filter(ticket => { const view = ticketStatus(ticket); return view.group === 'working' && !view.needsHuman })
    .sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
  const runOf = ticket => runs.find(run => run.id === ticket.runId) ?? runs.find(run => run.ticketId === ticket.id)
  const elapsedText = value => {
    const started = Date.parse(value ?? '')
    if (!Number.isFinite(started)) return '—'
    const minutes = Math.max(0, Math.floor((now - started) / 60_000))
    if (minutes < 1) return pt(t, 'ov.elapsedLess')
    if (minutes < 60) return pt(t, 'ov.elapsedMinutes', { count: minutes })
    return pt(t, 'ov.elapsedHours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
  }
  const progressOf = ticket => {
    const run = runOf(ticket)
    const steps = Array.isArray(run?.steps) ? run.steps : []
    const current = [...steps].reverse().find(step => step.state === 'running') ?? steps.at(-1)
    const elapsed = elapsedText(run?.startedAt ?? ticket.updatedAt)
    return current ? pt(t, 'ov.activeProgress', { step: ticketStepLabel(t, current.name), elapsed }) : elapsed
  }
  // The one panel-wide "data updated" clock is the header's; the folded summary repeats the same client read time
  // without seconds, and the engine's own poll time lives only in the expanded KeyValues (#2/#23).
  const clock = hhmm(updatedAt, t.lang) || '—'
  const pollSeconds = config.pollSeconds
  const pollSecondsKnown = pollSeconds !== undefined && pollSeconds !== null && pollSeconds !== ''
  const cursorPairs = Object.entries(engine.channelCursors ?? {})
    .map(([chat, seq]) => `${config.octo?.chatTitles?.[chat] ?? String(chat).slice(0, 8)}@${seq}`)

  // The engine error and the paused switch are also derivable through `problemsOf`, but this page renders both as
  // their own state block right above the desk; listing them twice would say the same thing in two places (§4.2).
  const baseProblems = problemsOf(data).filter(problem => {
    if (engine.lastError && problem.key === 'engine-error') return false
    if (paused && problem.key === 'paused') return false
    // The automation bar / setup card already names the missing switch; do not repeat it as a system problem.
    if ((showAutomationBar || setup.done < setup.total) && problem.key === 'engine-off') return false
    return true
  })
  // P0 §3.6.5: the system-problems block merges the derived problems with the inbox's non-blocking items, deduped by
  // title so one failure is never reported twice (the inbox row keeps its own destination).
  const problems = [...baseProblems]
  const problemTitles = new Set(problems.map(problem => problem.title))
  for (const item of systemInboxItems) {
    const title = String(item.title ?? '')
    if (!title || problemTitles.has(title)) continue
    problemTitles.add(title)
    problems.push({ key: `inbox-${item.id}`, severity: item.priority === 'urgent' ? 'error' : 'warning',
      title, detail: item.summary ? String(item.summary) : '',
      action: { labelKey: ovInboxActionKey(item), kind: 'navigate', payload: ovInboxTarget(item) }, inbox: item })
  }
  const flow = data.flow24h
  const hasFlow = Boolean(flow) && ['received', 'filtered', 'judged', 'accepted', 'dropped']
    .some(name => Number(flow[name] ?? 0) > 0)

  // P2-9: the run-quality view model; undefined hides the section (old host / no metrics payload).
  const quality = ovQualityOf(t, metricsResource.data)

  // ---- system pulse: engine heartbeat, source ratio, executor load, lifetime selectivity, work in flight -------
  const pollSecondCount = Number(config.pollSeconds) || 10
  const lastPollMs = Date.parse(engine.lastPollAt ?? '')
  const remain = Number.isFinite(lastPollMs) ? Math.max(0, Math.ceil((lastPollMs + pollSecondCount * 1000 - now) / 1000)) : undefined
  const engineDetail = paused ? pt(t, 'ov.pulsePaused')
    : config.enabled === false ? pt(t, 'ov.pulseOff')
    : Number.isFinite(remain) ? (remain > 0 ? pt(t, 'ov.pulseNext', { seconds: pollSecondCount, remain })
      : pt(t, 'ov.pulseDue', { seconds: pollSecondCount }))
    : pt(t, 'ov.autoVerifyValue', { value: engine.autoVerifySeconds ?? '—' })
  const sources = Array.isArray(data.sources) ? data.sources : []
  // Same rule as the Source page: a Source is enabled only when it says so, so both pages agree on the denominator.
  // Only a failing/blocked Source is unhealthy: a repository card reads `idle` while the executor is switched off,
  // which is a configuration state, not an incident (critique risk: the ratio should not cry wolf).
  const enabledSources = sources.filter(source => source.enabled === true)
  const healthySources = enabledSources.filter(source => !['error', 'setup'].includes(source.state))
  const badSourceCount = enabledSources.length - healthySources.length
  const executorOff = data.config?.executor?.enabled === false
  const load = data.load ?? {}
  const loadTotal = ['running', 'queued', 'waiting', 'failed'].reduce((sum, key) => sum + Number(load[key] ?? 0), 0)
  const lifetime = engine.events ?? {}
  const activeText = activeTickets.length
    ? pt(t, 'ov.pulseActive', { count: activeTickets.length, progress: progressOf(activeTickets[0]) })
    : paused ? pt(t, 'ov.pulsePaused')
      : config.enabled === false ? pt(t, 'ov.pulseOff')
        : pt(t, 'ov.pulseIdleActive')
  const pulseRows = [
    [pt(t, 'ov.pulseEngine'), h('span', { className: 'sa-actions', style: { gap: 'var(--sa-sp-8)' } },
      h(StatusText, { state: health.state }, pt(t, health.labelKey)),
      h('span', { className: 'sa-hint' }, engineDetail))],
    [pt(t, 'ov.pulseSources'), h('span', null,
      pt(t, 'ov.pulseSourcesValue', { active: enabledSources.length, total: sources.length }),
      badSourceCount > 0 ? pt(t, 'ov.pulseSourcesBad', { count: badSourceCount }) : null)],
    [pt(t, 'ov.pulseExecutor'), loadTotal === 0 ? (executorOff ? pt(t, 'ov.pulseExecutorOff') : pt(t, 'ov.pulseExecutorIdle'))
      : pt(t, 'ov.pulseExecutorValue', { running: load.running ?? 0, queued: load.queued ?? 0,
        waiting: load.waiting ?? 0, failed: load.failed ?? 0 })],
    [pt(t, 'ov.pulseLifetime'), pt(t, 'ov.pulseLifetimeValue', { received: ovCount(lifetime.received, t.lang),
      accepted: ovCount(lifetime.accepted, t.lang), ignored: ovCount(lifetime.ignored, t.lang) })],
    [pt(t, 'ov.pulseInFlight'), activeText],
  ]

  // The host aggregates the whole decision store into `rules24h`; the status payload's latest-20 fallback only
  // covers older hosts or fixtures without the field.
  const ruleLedger = data.rules24h && Array.isArray(data.rules24h.rules)
    ? { total: Number(data.rules24h.judged ?? 0), rows: data.rules24h.rules.map(rule => ({ name: rule.name,
      hits: Number(rule.hits ?? 0), blocked: Number(rule.blocked ?? 0) })) }
    : ovRuleHits(data.decisions, now)
  const watch = ovWatchItems(t, data, now, { metricsAvailable: Boolean(quality) })
  const since = lastSeen ? ovSince(t, data, lastSeen) : undefined

  // P2-9 run quality card: KPI line, at most three failure causes (each jumps to Execution) and one small metric line.
  const qualitySection = quality
    ? h(Section, { id: 'sa-quality', title: pt(t, 'ov.q.title'),
      // One section-level jump replaces the identical per-row button a failure list used to repeat (WIG P3).
      action: quality.failures.length
        ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate({ page: 'execution' }) },
          pt(t, 'ov.q.openExecution'))
        : undefined },
      quality.total > 0
        ? h(Fragment, null,
          h('p', { style: { margin: '0 0 var(--sa-sp-8)', fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 } },
            pt(t, 'ov.q.kpi', { runs: quality.total, rate: quality.rate, avg: quality.avgText, repaired: quality.repaired })),
          quality.failures.length
            ? h('div', { style: { marginBottom: 'var(--sa-sp-8)' } },
              h('h3', { className: 'sa-ledger-title' }, pt(t, 'ov.q.failures')),
              h('ul', { className: 'sa-list' }, quality.failures.map((item, index) => h('li', { key: index, className: 'sa-row' },
                h(StatusIcon, { state: 'error', size: 14, spin: false }),
                h('div', { className: 'sa-row-main' },
                  h('div', { className: 'sa-row-title' }, h('span', { className: 'sa-ellipsis' }, item.reason || '—')),
                  h('div', { className: 'sa-row-meta' }, h(Tag, { tone: 'danger' }, pt(t, 'ov.q.failureCount', { count: item.count }))))))))
            : null,
          (quality.triggerText || quality.acceptanceText)
            ? h('p', { className: 'sa-hint' }, [quality.triggerText, quality.acceptanceText].filter(Boolean).join(' · '))
            : null)
        : h('div', { className: 'sa-actions', style: { padding: 'var(--sa-sp-4) 0' } },
          h(StatusIcon, { state: 'done', size: 16 }),
          h('span', { className: 'sa-hint' }, pt(t, 'ov.q.empty'))))
    : null

  const cursorMore = cursorPairs.slice(3)
  const runtimeRows = [
    [pt(t, 'ov.runState'), h(StatusText, { state: health.state }, pt(t, health.labelKey))],
    // A missing cadence used to render as "— 秒": show the dash itself, not a sentence around a placeholder.
    [pt(t, 'ov.pollInterval'), pollSecondsKnown ? pt(t, 'ov.seconds', { value: pollSeconds }) : '—'],
    [pt(t, 'ov.engineLastPoll'), engine.lastPollAt ? h(When, { at: engine.lastPollAt }) : '—'],
    [pt(t, 'ov.cursor'), cursorPairs.length
      ? h(Fragment, null, cursorPairs.slice(0, 3).join(' / '),
        cursorMore.length
          ? h(Folded, { summary: pt(t, 'ov.cursorMore', { count: cursorMore.length }) },
            h('span', { className: 'sa-mono' }, cursorMore.join(' / ')))
          : null)
      : String(engine.cursor ?? 0)],
    [pt(t, 'ov.autoVerify'), pt(t, 'ov.autoVerifyValue', { value: engine.autoVerifySeconds ?? '—' })],
    [pt(t, 'ov.counts'), pt(t, 'ov.countsValue', { tickets: counts.tickets ?? 0,
      runs: counts.runs ?? 0, triggers: counts.triggers ?? 0 })],
    [pt(t, 'ov.configFile'), h('span', { className: 'sa-mono' }, config.file || '—')],
  ]

  // `problemsOf` actions are already vocabulary-mapped; the page only wires the three kinds to their transport.
  const runProblem = (problem) => {
    // An inbox-backed problem is read the moment its destination is opened (best effort, never blocking).
    if (problem.inbox) readInboxItem(problem.inbox)
    const action = problem.action ?? {}
    if (action.kind === 'poll') { void poll.run(); return }
    if (action.kind === 'reloadConfig') { void reloadConfig.run(); return }
    if (action.kind === 'navigate') navigate(action.payload ?? { page: 'settings' })
  }

  // Idle is a positive message in one line (#14) with one next step (O1): inside the desk it never takes the space
  // of a section. `count` therefore stays undefined at zero (#8).
  const handled = Math.max(0, Number(counts.tickets ?? 0) - Number(counts.open ?? 0))
  const idleRow = h('div', { className: 'sa-actions', style: { padding: 'var(--sa-sp-4) 0' } },
    h(StatusIcon, { state: 'done', size: 16 }),
    h('span', { style: { flex: '0 1 auto', minWidth: 0, fontSize: 'var(--sa-fs-body)', lineHeight: 1.5,
      color: 'var(--dsw-alias-label-primary)' } }, pt(t, 'ov.idleTitle')),
    h(Button, { variant: 'outline', size: 'sm',
      onClick: () => navigate(handled > 0 ? { page: 'execution', stage: 'done' } : { page: 'source' }) },
    pt(t, handled > 0 ? 'actions.viewHandled' : 'actions.openSource')))

  // Legacy desk (hosts without `inbox`): the latest 20 status-derived Ticket rows; the count may exceed the list.
  const moreCount = legacyHumanCount - legacyTickets.length
  const legacyNeedsBody = legacyTickets.length
    ? h(Fragment, null,
      h('ul', { className: 'sa-list' }, legacyTickets.map(ticket =>
        h(TicketRow, { key: ticket.id, ticket, page: 'overview', actions, reload, compact: true, now }))),
      moreCount > 0 ? h('p', { className: 'sa-hint' }, pt(t, 'ov.onlyCount', { count: legacyHumanCount })) : null)
    : legacyHumanCount > 0
      ? h('p', { className: 'sa-hint' }, pt(t, 'ov.onlyCount', { count: legacyHumanCount }))
      : null
  // Inbox desk (P0): one row per blocking item — kind icon, title, summary and the one step that settles it (open the
  // Ticket or the Source). Count = rendered rows; a count without rows (list still loading) says so instead of lying.
  // The whole row used to be a click-only div: not focusable, not operable from the keyboard and not announced as a
  // control (WIG P1). The title is now a real button whose stretched overlay (`.sa-open::after`) covers the row, and
  // the explicit action button keeps its own clickable layer above it.
  const inboxRows = blockingItems.length
    ? h('ul', { className: 'sa-list' }, blockingItems.map(item => h('li', { key: item.id },
      h('div', { className: 'sa-row sa-row-openable' },
        h(Icon, { name: ovInboxIcon(item), size: 16 }),
        h('div', { className: 'sa-row-main' },
          h('div', { className: 'sa-row-title' },
            h('button', { type: 'button', className: 'sa-row-open sa-open',
              title: String(item.title ?? '') || undefined,
              'aria-label': `${String(item.title ?? '') || item.id} — ${pt(t, ovInboxActionKey(item))}`,
              onClick: () => openInboxItem(item) },
            h('span', { className: 'sa-ellipsis' }, String(item.title ?? '') || '—'))),
          item.summary ? h('div', { className: 'sa-row-meta' }, h('span', { className: 'sa-hint' }, String(item.summary))) : null),
        h('div', { className: 'sa-row-actions' },
          h(Button, { variant: 'outline', size: 'sm',
            onClick: () => openInboxItem(item) }, pt(t, ovInboxActionKey(item))))))))
    : humanCount > 0
      ? h('p', { className: 'sa-hint' }, pt(t, 'ov.onlyCount', { count: humanCount }))
      : null
  const needsBody = inboxSupported ? (inboxRows ?? idleRow) : (legacyNeedsBody ?? idleRow)
  // When the desk says "nothing needs you" while the right column reports failures, name the split once.
  const deskScope = watch.length
    ? h('p', { className: 'sa-hint', role: 'note' }, pt(t, 'ov.deskScope')) : null
  const needsBodyWithScope = h(Fragment, null, needsBody, deskScope)

  return h(Fragment, null,
    error ? h(ErrorState, { error, onRetry: () => { void reload() } }) : null,
    engine.lastError ? h(ErrorState, { error: String(engine.lastError), onRetry: () => { void poll.run() } }) : null,
    // P0-8: a failed inbox fetch is not allowed to silently empty the desk; say so and offer a retry.
    inbox.error && !inbox.data ? h('div', { className: 'sa-banner', role: 'alert',
      style: { display: 'flex', alignItems: 'center', gap: 'var(--sa-sp-8)', flexWrap: 'wrap' } },
      h(StatusIcon, { state: 'warning', size: 14 }),
      h('span', { style: { flex: '1 1 220px', minWidth: 0 } }, pt(t, 'ov.inboxError')),
      h(Button, { variant: 'ghost', size: 'sm', onClick: () => { void inbox.reload() } }, t('reload'))) : null,
    // One automation story, one primary action. When the three prerequisites are configured, it replaces both the
    // paused banner and the setup card (which otherwise repeated the same engine step in two places).
    showAutomationBar
      ? h(AutomationBar, { paused, engineEnabled, executorEnabled, onStart: () => startAutomation.run(),
        onCheck: () => { void poll.run() }, checkBusy: poll.busy, progress: setup })
      : paused ? h('div', { className: 'sa-banner',
        style: { display: 'flex', alignItems: 'center', gap: 'var(--sa-sp-8)', flexWrap: 'wrap' } },
        h(StatusIcon, { state: 'warning', size: 14 }),
        h('span', { style: { flex: '1 1 220px', minWidth: 0 } }, pt(t, 'ov.paused')),
        h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate({ page: 'execution' }) }, pt(t, 'ov.resume'))) : null,

    // First-run setup. The full card is for a quiet, empty workspace; once any history exists it stays one line so
    // work is never pushed below a tutorial. It disappears when the automation bar takes over the remaining step.
    setup.done < setup.total && !showAutomationBar
      ? !hasHistory && humanCount === 0 && activeTickets.length === 0
        ? h(SetupChecklist, { setup, onNavigate: navigate })
        : h(SetupBanner, { setup, onNavigate: navigate })
      : null,

    // 1. The desk. The global "check for new messages" action lives in the header, not in this section (#3).
    h(Section, { title: pt(t, 'ov.needsYou'), count: humanCount || undefined }, needsBodyWithScope),

    // 2. Work in flight: the pulse row only rolls up a count; the operator still needs the Ticket itself (title,
    //    repository, current step, age) without leaving Overview. Full queue stays on Execution.
    activeTickets.length ? h(Section, { title: pt(t, 'ov.running'), count: activeTickets.length,
      action: h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate({ page: 'execution' }) },
        pt(t, 'actions.openExecution')) },
      h(TicketList, { tickets: activeTickets, page: 'execution', actions, reload, now })) : null,

    // 3. System problems: each row keeps its own next step; an empty list hides the whole block.
    problems.length ? h(Section, { title: pt(t, 'ov.problems'), count: problems.length },
      h('ul', { className: 'sa-list' }, problems.map(problem => h('li', { key: problem.key },
        h('div', { className: 'sa-row' },
          h(StatusIcon, { state: problem.severity === 'error' ? 'error' : 'warning', size: 16 }),
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' }, h('span', null, problem.title)),
            problem.detail ? h('div', { className: 'sa-row-meta' },
              h(ClampText, { text: String(problem.detail), limit: 300, lines: 2 })) : null),
          h('div', { className: 'sa-row-actions' },
            problem.action ? h(Button, { variant: 'outline', size: 'sm',
              onClick: () => runProblem(problem) }, pt(t, problem.action.labelKey)) : null)))))) : null,

    // 4. The shift brief: what changed (funnel, policy ledger, since last look) on the left; what is true now
    //    (pulse, watchlist) on the right. One column below 1024 px.
    h('div', { className: 'sa-brief-grid' },
      h('div', { className: 'sa-brief-col' },
        since ? h('p', { className: 'sa-hint', role: 'status' }, since.text) : null,
        h(Section, { title: pt(t, 'ov.flow24h') },
          hasFlow ? h(FunnelBar, { flow }) : h(Hint, null, pt(t, 'ov.noFlow')),
          // The policy ledger is a second reading of the same window and stays visible even when the 24h flow is
          // empty but decisions exist (an empty funnel is not proof that nothing was judged).
          h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)', marginTop: 'var(--sa-sp-8)' } },
            h('h3', { className: 'sa-ledger-title' }, pt(t, 'ov.rulesTitle')),
            ruleLedger.rows.length
              ? h('div', { className: 'sa-ledger' }, ruleLedger.rows.map(row =>
                h(Tag, { key: row.name, tone: row.blocked > 0 ? 'warning' : 'outline' },
                  pt(t, 'ov.ruleValue', { name: row.name, blocked: row.blocked, hits: row.hits }))))
              : h('p', { className: 'sa-hint' }, pt(t, 'ov.rulesEmpty')))),

        // P2-9: run quality sits directly under the 24h funnel it summarises; hidden when metrics are unavailable.
        qualitySection),

      h('div', { className: 'sa-brief-col' },
        // Pulse: every fact is a rollup. The in-flight row deliberately says one sentence, never a TicketRow.
        h(Section, { title: pt(t, 'ov.pulse') }, h(KeyValues, { rows: pulseRows, className: 'sa-kv-inline' })),
        h(Section, { title: pt(t, 'ov.watch') },
          watch.length
            ? h('ul', { className: 'sa-list' }, watch.map(item => h('li', { key: item.key },
              h('div', { className: 'sa-row' },
                h(StatusIcon, { state: item.state, size: 16 }),
                h('div', { className: 'sa-row-main' }, h('div', { className: 'sa-row-title' }, h('span', null, item.title))),
                h('div', { className: 'sa-row-actions' },
                  h(Button, { variant: 'ghost', size: 'sm',
                    onClick: () => navigate({ page: item.page, ...(item.stage ? { stage: item.stage } : {}) }) },
                  pt(t, 'ov.watchOpen')))))))
            : h('div', { className: 'sa-actions', style: { padding: 'var(--sa-sp-4) 0' } },
              h(StatusIcon, { state: 'done', size: 16 }),
              h('span', { className: 'sa-hint' }, pt(t, 'ov.watchEmpty')))))),

    // 5. Secondary engine state, collapsed by default; the summary carries the poll cadence and the read time only.
    h(DisclosureRow, { title: pt(t, 'ov.runtime'), open: runtimeOpen,
      onToggle: () => setRuntimeOpen(open => !open),
      collapsedContent: h('span', { className: 'sa-hint' },
        pollSecondsKnown ? pt(t, 'ov.summary', { seconds: pollSeconds, time: clock })
          : pt(t, 'ov.summaryAlt', { time: clock })) },
      h(KeyValues, { rows: runtimeRows })))
}
