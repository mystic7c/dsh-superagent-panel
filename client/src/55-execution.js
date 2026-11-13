/* Execution page (contract §6.5): executor load, the pause/resume confirmation that states the consequence, a
   manual Ticket entry that opens a dialog in place, and Tickets grouped by stage. Round 4 gives the finished history
   its history shape: a stage filter fed by the host's own per-stage counts, a one-line summary on the "ended" group,
   and a "recent 10 / show all" cap so a long history cannot become an unbounded wall. Round 8 (2026-11-08) folds the
   filters and the view options into one control row: stage chips carry their counts, grouping and ordering are two
   labelled pickers that state the current choice, and the include-ended switch closes the row. A deep-linked Ticket id
   renders the full detail instead of the list. Data: GET engine/tickets (host increments, contract §4) plus the shared
   status model for the executor load and the paused flag. */

// Same attention order as TICKET_GROUP_ORDER (P0 §3.6.3): waiting → failed → working → queued → done.
// `dismissed` is not a lifecycle stage: it is the cleanup slice of the finished history (a person dropped the Ticket),
// kept as its own stage because "what did we abandon after a failed run" is a question the Overview points here with.
const EXEC_STAGES = ['all', 'waiting', 'failed', 'working', 'queued', 'done', 'dismissed']
const EXEC_DONE_RECENT = 10
// P1-8: the execution list's view state survives a page switch inside the same browser session.
const EXEC_VIEW_KEY = 'superagent-panel/exec-view'
const EXEC_VIEW_DEFAULTS = { groupBy: 'stage', sort: 'updated', showDone: true }
function execReadView() {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(EXEC_VIEW_KEY) ?? 'null') ?? {}
    return { groupBy: parsed.groupBy === 'repo' ? 'repo' : 'stage',
      sort: parsed.sort === 'created' ? 'created' : 'updated', showDone: parsed.showDone !== false }
  } catch { return { ...EXEC_VIEW_DEFAULTS } }
}
function execSaveView(view) {
  try { sessionStorage.setItem(EXEC_VIEW_KEY, JSON.stringify(view)) } catch { /* private mode keeps the in-memory view */ }
}
/** Newest-first by the chosen timestamp; a Ticket without the field falls back to the other one, never to "now". */
function execSortTickets(tickets, sort) {
  const field = sort === 'created' ? 'createdAt' : 'updatedAt'
  return [...tickets].sort((left, right) => String(right?.[field] ?? right?.createdAt ?? '')
    .localeCompare(String(left?.[field] ?? left?.createdAt ?? '')))
}

Object.assign(PAGE_TEXT, {
  'ex.executor': ['执行器', 'Executor'],
  'ex.executorDisabled': ['执行器未启用：到设置→运行打开「启用执行器」并保存，新工单才会执行。',
    'The executor is off: turn on “Executor enabled” under Settings → Runtime and save.'],
  'ex.pauseTitle': ['暂停处理？', 'Pause processing?'],
  'ex.pauseConfirm': ['暂停后不再开始新的评估、派工或回复；正在运行的执行器会完成当前一轮。',
    'Pausing stops new Evals, dispatches and replies; a running executor finishes its current turn.'],
  'ex.resumeTitle': ['恢复处理？', 'Resume processing?'],
  'ex.resumeConfirm': ['恢复后引擎重新开始轮询群消息、评估请求并派工。',
    'Resuming restarts polling, Eval and dispatch.'],
  'ex.createTicket': ['手工建单', 'Create a Ticket'],
  'ex.createHint': ['本地填写标题与正文，会真实写入 live 状态并加入执行队列。',
    'Fill in a title and body here; it writes to the live state and queues the Ticket.'],
  'ex.tickets': ['工单', 'Tickets'],
  'ex.refresh': ['刷新工单', 'Refresh Tickets'],
  'ex.filterLabel': ['按阶段筛选', 'Filter by stage'],
  'ex.filterAll': ['全部', 'All'],
  'ex.recentLabel': ['最近一次执行', 'Last run'],
  'ex.recentOk': ['运行成功', 'Run succeeded'],
  'ex.recentFailed': ['运行失败', 'Run failed'],
  'ex.recentWaiting': ['闸门等待你处理', 'A gate needs you'],
  'ex.recentTicket': ['查看工单', 'Open Ticket'],
  'ex.runs24hFailed': ['24 小时运行失败 {count} 次', '{count} failed runs in 24h'],
  'ex.runs24hLink': ['去看概览', 'View overview'],
  'ex.colStatus': ['状态', 'Status'],
  'ex.colTicket': ['工单', 'Ticket'],
  'ex.colEvidence': ['证据', 'Evidence'],
  'ex.colActions': ['操作', 'Actions'],
  'ex.stageQueued': ['排队', 'Queued'],
  'ex.stageWorking': ['执行中', 'Working'],
  'ex.stageWaiting': ['等你处理', 'Waiting on you'],
  'ex.stageFailed': ['失败', 'Failed'],
  'ex.stageDone': ['已结束', 'Ended'],
  'ex.stageDismissed': ['已忽略', 'Dismissed'],
  'ex.dismissedNote': ['失败后由人放弃的工单，不会再执行；点开可看当时的失败原因。',
    'Tickets a person dropped after a failed run. They never run again; open one for the failure that preceded it.'],
  'ex.doneSummary': ['共 {total} 张：{accepted} 已验收、{dismissed} 已忽略；其中 {retried} 张在失败重试后完成',
    '{total} Tickets: {accepted} accepted, {dismissed} dismissed; {retried} completed after a failed-run retry'],
  'ex.doneShowAll': ['查看全部（{count}）', 'Show all ({count})'],
  'ex.doneCollapse': ['收起', 'Collapse'],
  'ex.stageEmptyTitle': ['这个阶段还没有工单。', 'No Tickets in this stage yet.'],
  'ex.stageEmptyAction': ['显示全部工单', 'Show all Tickets'],
  'ex.emptyTitle': ['还没有工单。', 'No Ticket yet.'],
  'ex.emptyHint': ['在群里发一条需求，或在这里手工建单测试链路。',
    'Send a request in the group, or create a Ticket right here to test the pipeline.'],
  // ---- P1-8: view options (persisted in sessionStorage) ----------------------------------------------------------
  'ex.groupByLabel': ['分组方式', 'Group by'],
  'ex.groupByShort': ['分组', 'Group by'],
  'ex.groupByStageShort': ['按阶段', 'Stage'],
  'ex.groupByRepoShort': ['按仓库', 'Repository'],
  'ex.groupByStage': ['按阶段', 'By stage'],
  'ex.groupByRepo': ['按仓库', 'By repository'],
  'ex.sortLabel': ['排序', 'Sort by'],
  'ex.sortUpdated': ['最近更新', 'Last updated'],
  'ex.sortCreated': ['最近创建', 'Newest'],
  'ex.showDone': ['显示已结束', 'Show ended'],
  'ex.showDoneGroup': ['展开已结束（{count}）', 'Show ended ({count})'],
  'ex.clearFilters': ['清除筛选', 'Clear filters'],
  'ex.filterEmptyTitle': ['没有符合当前筛选的工单。', 'No Tickets match the current filter.'],
  'ex.noRepo': ['（未指定仓库）', '(No repository)'],
  'ex.toolbarLabel': ['列表视图选项', 'List view options'],
})

/** The finished group's one line: accepted sign-offs, dismissed Tickets, and Tickets that completed after a failed
    run was retried. The three numbers overlap on purpose (a retried Ticket is normally also accepted): they annotate
    the same history, they are not a partition of it. */
function execDoneSummary(t, doneTickets) {
  const list = Array.isArray(doneTickets) ? doneTickets : []
  const hasFailedRun = ticket => (Array.isArray(ticket.assignments) ? ticket.assignments : [])
    .some(assignment => assignment?.report?.state === 'failed')
  const accepted = list.filter(ticket => ticket.links?.acceptance?.ok === true).length
  const dismissed = list.filter(ticket => ticket.status === 'dismissed').length
  const retried = list.filter(ticket => hasFailedRun(ticket)
    && (ticket.status === 'merged' || ticket.status === 'deployed' || ticket.links?.acceptance?.ok === true)).length
  return pt(t, 'ex.doneSummary', { total: list.length, accepted, dismissed, retried })
}

/** List view: executor strip, pause confirmation, manual entry, stage filter, then the stage groups. */
function ExecutionQueuePage({ route }) {
  const { t, notify, navigate } = usePanel()
  const model = usePanelData()
  const list = useLiveResource('engine/tickets', {})
  // A stage may arrive as a route (the Overview's "failed then dismissed" watch item deep-links here); a stale or
  // unknown value falls back to the whole queue instead of trapping the page on an empty slice.
  const routeStage = route?.stage && EXEC_STAGES.includes(route.stage) ? route.stage : 'all'
  const [stage, setStage] = useState(routeStage)
  useEffect(() => {
    if (route?.stage && EXEC_STAGES.includes(route.stage)) setStage(route.stage)
  }, [route?.stage])
  // The stage filter is in-view state, so mirror it into the route object the shell already keeps: back/forward then
  // restores the visible slice instead of resetting it (A5). Replacing the entry keeps filtering out of the history
  // stack. (A reload still narrows the route to page/id in 25-router.js, so it falls back to the whole queue.)
  const chooseStage = value => {
    setStage(value)
    navigate({ page: 'execution', ...(value === 'all' ? {} : { stage: value }) }, true)
  }
  const [manualOpen, setManualOpen] = useState(false)
  const [doneExpanded, setDoneExpanded] = useState(false)
  const [execView, setExecView] = useState(execReadView)
  const updateView = patch => setExecView(previous => {
    const next = { ...previous, ...patch }
    execSaveView(next)
    return next
  })
  const status = model.data
  const paused = Boolean(status && (status.paused === true || status.config?.paused === true || status.engine?.paused === true))
  const engineEnabled = status?.config?.enabled === true
  const executorEnabled = status?.config?.executor?.enabled !== false
  const automationNeeded = Boolean(status) && (paused || !engineEnabled || !executorEnabled)
  const automationReady = Boolean(status?.config?.octo?.tokenConfigured
    && (status?.config?.octo?.watchChatIds ?? []).length > 0
    && (status?.config?.repos ?? []).length > 0)
  const barShown = Boolean(status) && automationNeeded && automationReady
  const setup = status ? setupStateOf(status) : undefined
  const reloadBoth = useCallback(async () => { await Promise.all([model.reload(), list.reload()]) }, [model.reload, list.reload])
  const poll = useAction(() => model.actions.poll(), { reload: reloadBoth })
  const startAutomation = useAction(async () => {
    await model.actions.patchSettings({ paused: false, enabled: true, 'executor.enabled': true })
    notify(pt(t, 'automation.started'))
  }, { reload: reloadBoth })

  if (!status && !model.error) return h(Skeleton, { rows: 5 })
  if (!status) return h(ErrorState, { error: model.error, onRetry: model.reload })

  const tickets = Array.isArray(list.data?.items) ? list.data.items : []
  const loadingList = !list.data && !list.error
  // The host already counted every stage (`ticketsView().counts`); the pills must never disagree with the list, so a
  // host that omits a count falls back to counting the rows it did send.
  // The status poll carries the last 10 runs; the execution band shows the newest one on the right so "is it alive,
  // when did it last move" is answered without opening a Ticket (C18).
  const recentRun = Array.isArray(status.runs) && status.runs.length
    ? [...status.runs].sort((left, right) => String(right.startedAt ?? right.at ?? '').localeCompare(String(left.startedAt ?? left.at ?? '')))[0]
    : null
  const recentRunFailed = recentRun?.status === 'failed'
  // A run parked on a failing gate is neither success nor failure: say what it waits for (P0-3).
  const recentRunWaiting = recentRun?.status === 'waiting_for_human'
  const recentRunTone = recentRunFailed ? 'danger' : recentRunWaiting ? 'warning' : 'success'
  const recentRunKey = recentRunFailed ? 'ex.recentFailed' : recentRunWaiting ? 'ex.recentWaiting' : 'ex.recentOk'
  const counts = list.data?.counts ?? {}
  // The host counts lifecycle stages; `dismissed` is a slice of the ended history, so its count comes from the rows.
  const countOf = group => group === 'dismissed'
    ? tickets.filter(ticket => ticket.status === 'dismissed').length
    : Number.isFinite(counts[group]) ? counts[group]
      : group === 'all' ? tickets.length : tickets.filter(ticket => ticketStatus(ticket).group === group).length
  const EXEC_STAGE_LABEL = { queued: 'ex.stageQueued', working: 'ex.stageWorking', waiting: 'ex.stageWaiting',
    failed: 'ex.stageFailed', done: 'ex.stageDone', dismissed: 'ex.stageDismissed' }
  // Each chip carries its own count: the filter row is the one place that answers "how much of the queue is in this
  // slice", so the number never has to be repeated by a section heading.
  const stageOptions = EXEC_STAGES.map(group => ({
    value: group,
    label: h(Fragment, null,
      h('span', null, pt(t, group === 'all' ? 'ex.filterAll' : EXEC_STAGE_LABEL[group])),
      h('span', { className: 'sa-chip-count', 'data-zero': countOf(group) === 0 ? 'true' : undefined }, countOf(group))),
  }))
  // Filtering is client-side: one fetch already carries every stage, so switching a pill never refetches.
  const sorted = execSortTickets(tickets, execView.sort)
  const inStageBase = stage === 'all' ? sorted
    : stage === 'dismissed' ? sorted.filter(ticket => ticket.status === 'dismissed')
      : sorted.filter(ticket => ticketStatus(ticket).group === stage)
  // P1-8: "show ended" hides the finished group but an explicit stage filter for it always wins, and the group keeps a
  // reveal entry below the list so history is never unreachable. The dismissed slice lives inside the ended history.
  const doneAllowed = execView.showDone || stage === 'done' || stage === 'dismissed'
  const inStage = doneAllowed ? inStageBase : inStageBase.filter(ticket => ticketStatus(ticket).group !== 'done')
  const doneTickets = inStageBase.filter(ticket => ticketStatus(ticket).group === 'done')
  const recentDone = doneExpanded ? doneTickets : doneTickets.slice(0, EXEC_DONE_RECENT)
  const shownTickets = doneTickets.length > recentDone.length
    ? [...inStage.filter(ticket => ticketStatus(ticket).group !== 'done'), ...recentDone]
    : inStage
  // The summary describes the whole finished history even while only the newest 10 rows are rendered.
  // The done group's own count is folded into the summary ("共 6 张 · …"), so the Section does not print a bare 6
  // right next to it; the other groups keep their count badge.
  const groupNotes = { done: h('span', { className: 'sa-hint' }, execDoneSummary(t, doneTickets)) }
  const groupCounts = { done: false }
  const queueHeader = h('div', { className: 'sa-queue-head' },
    h('span', { 'aria-hidden': 'true' }),
    h('span', null, pt(t, 'ex.colTicket')),
    h('span', null, pt(t, 'ex.colEvidence')),
    h('span', null, pt(t, 'ex.colActions')))
  const doneOverflow = doneTickets.length > EXEC_DONE_RECENT
  const emptyState = h(Section, { title: pt(t, 'ex.tickets'), count: 0 },
    h(EmptyState, { icon: 'inbox', title: pt(t, 'ex.emptyTitle'), hint: pt(t, 'ex.emptyHint'),
      action: h(Button, { variant: 'outline', size: 'sm', icon: 'plus', onClick: () => setManualOpen(true) },
        pt(t, 'ex.createTicket')) }))
  const clearFilters = () => { chooseStage('all'); updateView({ showDone: true }) }
  const stageEmptyState = h(Section, { title: pt(t, 'ex.tickets'), count: 0 },
    h(EmptyState, { icon: 'filter', title: pt(t, 'ex.filterEmptyTitle'),
      action: h(Button, { variant: 'outline', size: 'sm', onClick: clearFilters }, pt(t, 'ex.clearFilters')) }))
  // Repository grouping (P1-8): the same rows, batched by the repository a Ticket belongs to. Groups follow the
  // sorted ticket order, so the newest work still leads inside each repository.
  const repoGroupsOf = list => {
    const groups = []
    const byKey = new Map()
    for (const ticket of list) {
      const repoId = ticket.repoId ?? ''
      const key = repoId || '__none'
      if (!byKey.has(key)) {
        const name = ticket.repoName ?? panelRepoOf(status, ticket.repoId)?.name ?? repoId ?? pt(t, 'ex.noRepo')
        const group = { key, name: String(name || pt(t, 'ex.noRepo')), tickets: [] }
        byKey.set(key, group)
        groups.push(group)
      }
      byKey.get(key).tickets.push(ticket)
    }
    return groups
  }
  // One control row for the queue. The stage filter leads because it is how the queue is read; grouping, ordering and
  // the include-ended switch are chrome on top of it, so they close the row behind a divider. Everything the bar does
  // is spelled out on the controls themselves (count in the chip, current choice on the picker) instead of as form
  // labels floating before a control, which is what made the old two-row toolbar read as a settings form.
  const listBar = tickets.length
    ? h('div', { className: 'sa-list-bar' },
      h('div', { className: 'sa-list-stage' },
        h(SegmentedControl, { options: stageOptions, value: stage, onChange: chooseStage, label: pt(t, 'ex.filterLabel'),
          className: 'sa-segmented-chips' })),
      h('div', { className: 'sa-viewbar', role: 'group', 'aria-label': pt(t, 'ex.toolbarLabel') },
        h(Menu, { label: pt(t, 'ex.groupByLabel'),
          text: h(Fragment, null,
            h('span', { className: 'sa-menu-picker-label' }, pt(t, 'ex.groupByShort')),
            pt(t, execView.groupBy === 'repo' ? 'ex.groupByRepoShort' : 'ex.groupByStageShort')),
          items: [
            { key: 'stage', label: pt(t, 'ex.groupByStage'), checked: execView.groupBy === 'stage',
              onSelect: () => updateView({ groupBy: 'stage' }) },
            { key: 'repo', label: pt(t, 'ex.groupByRepo'), checked: execView.groupBy === 'repo',
              onSelect: () => updateView({ groupBy: 'repo' }) },
          ] }),
        h(Menu, { label: pt(t, 'ex.sortLabel'),
          text: h(Fragment, null,
            h('span', { className: 'sa-menu-picker-label' }, pt(t, 'ex.sortLabel')),
            pt(t, execView.sort === 'created' ? 'ex.sortCreated' : 'ex.sortUpdated')),
          items: [
            { key: 'updated', label: pt(t, 'ex.sortUpdated'), checked: execView.sort === 'updated',
              onSelect: () => updateView({ sort: 'updated' }) },
            { key: 'created', label: pt(t, 'ex.sortCreated'), checked: execView.sort === 'created',
              onSelect: () => updateView({ sort: 'created' }) },
          ] }),
        h('span', { className: 'sa-control-divider', 'aria-hidden': 'true' }),
        h('label', { className: 'sa-switch-field' },
          h('span', { className: 'sa-switch-label' }, pt(t, 'ex.showDone')),
          h(Switch, { checked: execView.showDone, onChange: value => updateView({ showDone: value }),
            className: 'sa-switch-compact' }))))
    : null
  const queueBody = stage === 'dismissed'
    ? h('div', { className: 'sa-exec-queue' },
      h(Section, { title: pt(t, 'ex.stageDismissed'), count: inStage.length,
        badge: h('span', { className: 'sa-hint' }, pt(t, 'ex.dismissedNote')) },
        queueHeader,
        h(TicketList, { tickets: inStage, page: 'execution', actions: model.actions, reload: reloadBoth })))
    : execView.groupBy === 'repo'
    ? h('div', { className: 'sa-exec-queue' },
      repoGroupsOf(inStage).map((group, index) => h(Section, { key: group.key, title: group.name, count: group.tickets.length },
        index === 0 ? queueHeader : null,
        h(TicketList, { tickets: group.tickets, page: 'execution', actions: model.actions, reload: reloadBoth }))))
    : h(Fragment, null,
      h(TicketGroups, { tickets: shownTickets, page: 'execution', actions: model.actions, reload: reloadBoth,
        className: 'sa-exec-queue', groupNotes, groupCounts, header: queueHeader }),
      doneOverflow ? h('div', { className: 'sa-actions' },
        h(Button, { variant: 'outline', size: 'sm', 'aria-expanded': doneExpanded,
          onClick: () => setDoneExpanded(value => !value) },
          pt(t, doneExpanded ? 'ex.doneCollapse' : 'ex.doneShowAll', { count: doneTickets.length }))) : null)
  const pauseConfirm = h(ConfirmButton, {
    label: paused ? pt(t, 'resumeProcessing') : pt(t, 'pauseProcessing'),
    title: paused ? pt(t, 'ex.resumeTitle') : pt(t, 'ex.pauseTitle'),
    message: paused ? pt(t, 'ex.resumeConfirm') : pt(t, 'ex.pauseConfirm'),
    variant: paused ? 'primary' : 'outline',
    icon: paused ? 'play' : 'pause',
    onConfirm: async () => {
      await model.actions.pause(!paused)
      notify(pt(t, paused ? 'toast.resumeDone' : 'toast.pauseDone'))
      await reloadBoth()
    },
  })

  const refreshButton = h(IconButton, { icon: h(Icon, { name: 'refresh', size: 16 }), label: pt(t, 'ex.refresh'),
    title: pt(t, 'ex.refresh'), onClick: () => { void reloadBoth() } })

  return h(Fragment, null,
    automationNeeded && automationReady
      ? h(AutomationBar, { paused, engineEnabled, executorEnabled, onStart: () => startAutomation.run(),
        onCheck: () => { void poll.run() }, checkBusy: poll.busy, compact: true, progress: setup })
      : null,
    h(Section, { title: pt(t, 'ex.executor'),
      badge: paused && !barShown ? h(Tag, { tone: 'warning' }, pt(t, 'loadbarPaused')) : null,
      action: h('span', { className: 'sa-actions' }, refreshButton, automationNeeded && automationReady ? null : pauseConfirm) },
      h('div', { className: 'sa-executor-band' },
        h('div', { className: 'sa-executor-load-col' }, h(ExecutorLoad, { load: status.load })),
        h('div', { className: 'sa-executor-recent' },
          recentRun ? h(Fragment, null,
            h('span', { className: 'sa-hint' }, pt(t, 'ex.recentLabel')),
            h(When, { at: recentRun.startedAt ?? recentRun.at }),
            h(Tag, { tone: recentRunTone }, pt(t, recentRunKey)),
            // P1-2 (optional): how the run was started — manual / automatic / retry / resume.
            runTriggerLabel(t, recentRun) ? h(Tag, { tone: 'outline' }, runTriggerLabel(t, recentRun)) : null,
            recentRun.error
              ? h(Fragment, null,
                // The failure cause stays visible; the raw error is supplementary detail behind a real focusable InfoTip
                // rather than a hover-only title (A3).
                h('span', { className: 'sa-hint' },
                  pt(t, 'row.evidenceCause', { cause: failureLabel(t, String(recentRun.error)) })),
                h(InfoTip, { text: String(recentRun.error), warn: true }))
              : null,
            // In-app navigation has no URL to point at, so these are real buttons, not `<a href="#">` fake links (A4).
            recentRun.ticketId
              ? h('button', { type: 'button', className: 'sa-textlink',
                onClick: () => navigate({ page: 'execution', id: recentRun.ticketId }) },
              pt(t, 'ex.recentTicket'))
              : null) : null,
          h('button', { type: 'button', className: 'sa-textlink',
            onClick: () => navigate({ page: 'overview' }) },
          pt(t, 'ex.runs24hFailed', { count: Number(status.runs24hFailed ?? 0) }) + ' →'))),
      status.config?.executor?.enabled === false && !barShown ? h(Hint, null, pt(t, 'ex.executorDisabled')) : null,
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'outline', size: 'sm', icon: 'plus', onClick: () => setManualOpen(true) },
          pt(t, 'ex.createTicket')),
        h('span', { className: 'sa-hint' }, pt(t, 'ex.createHint'))),
      status.engine?.lastError ? h(ErrorState, { error: status.engine.lastError, onRetry: () => { void poll.run() } }) : null),
    list.error ? h(ErrorState, { error: list.error, onRetry: list.reload }) : null,
    listBar,
    loadingList ? h(Skeleton, { rows: 5 })
      : !list.data ? null
        : !tickets.length ? emptyState
          : !inStage.length ? stageEmptyState
            : h(Fragment, null,
              queueBody,
              !execView.showDone && stage !== 'done' && doneTickets.length
                ? h('div', { className: 'sa-actions' },
                  h(Button, { variant: 'outline', size: 'sm', onClick: () => updateView({ showDone: true }) },
                    pt(t, 'ex.showDoneGroup', { count: doneTickets.length })))
                : null),
    h(Modal, { open: manualOpen, onClose: () => setManualOpen(false), title: pt(t, 'ex.createTicket'),
      closeLabel: t('close'), description: pt(t, 'ex.createHint') },
      h(ManualTicketForm, { heading: false, onDone: () => { setManualOpen(false); void reloadBoth() },
        onCancel: () => setManualOpen(false) })))
}

/** A deep-linked Ticket renders the full detail on this tab; otherwise the stage-grouped queue (a `stage` route
    arrives from the Overview's watch items, which deep-link the dismissed slice). */
function LiveExecutionPage({ route }) {
  return route?.id ? h(TicketDetail, { id: route.id, page: 'execution', focusRun: route.run }) : h(ExecutionQueuePage, { route })
}
