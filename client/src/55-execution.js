/* Execution page (contract §6.5): executor load, the pause/resume confirmation that states the consequence, a
   manual Ticket entry that opens a dialog in place, and Tickets grouped by stage. Round 4 gives the finished history
   its history shape: a stage filter fed by the host's own per-stage counts, a one-line summary on the "ended" group,
   and a "recent 10 / show all" cap so a long history cannot become an unbounded wall. A deep-linked Ticket id renders
   the full detail instead of the list. Data: GET engine/tickets (host increments, contract §4) plus the shared status
   model for the executor load and the paused flag. */

const EXEC_STAGES = ['all', 'queued', 'working', 'waiting', 'failed', 'done']
const EXEC_DONE_RECENT = 10

Object.assign(PAGE_TEXT, {
  'ex.executor': ['执行器', 'Executor'],
  'ex.executorDisabled': ['执行器未启用（live.json 的 executor.enabled 为 false），新工单只会排队。',
    'The executor is off (executor.enabled is false in live.json); new Tickets only queue up.'],
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
  'ex.recentTicket': ['查看工单', 'Open Ticket'],
  'ex.runs24hFailed': ['24 小时运行失败 {count} 次', '{count} failed runs in 24h'],
  'ex.runs24hLink': ['去看概览', 'View overview'],
  'ex.colStatus': ['状态', 'Status'],
  'ex.colTicket': ['工单', 'Ticket'],
  'ex.colEvidence': ['证据', 'Evidence'],
  'ex.colActions': ['操作', 'Actions'],
  'ex.stageQueued': ['排队', 'Queued'],
  'ex.stageWorking': ['执行中', 'Running'],
  'ex.stageWaiting': ['等待你', 'Waiting on you'],
  'ex.stageFailed': ['失败工单', 'Failed Tickets'],
  'ex.stageDone': ['已结束', 'Ended'],
  'ex.doneSummary': ['共 {total} 张 · {accepted} 已验收 · {dismissed} 已忽略，其中 {retried} 张重试后完成',
    '{total} total · {accepted} accepted · {dismissed} dismissed, {retried} of them completed after a retry'],
  'ex.doneShowAll': ['查看全部（{count}）', 'Show all ({count})'],
  'ex.doneCollapse': ['收起', 'Collapse'],
  'ex.stageEmptyTitle': ['这个阶段还没有工单。', 'No Tickets in this stage yet.'],
  'ex.stageEmptyAction': ['显示全部工单', 'Show all Tickets'],
  'ex.emptyTitle': ['还没有工单。', 'No Ticket yet.'],
  'ex.emptyHint': ['在群里发一条需求，或在这里手工建单测试链路。',
    'Send a request in the group, or create a Ticket right here to test the pipeline.'],
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
function ExecutionQueuePage() {
  const { t, notify, navigate } = usePanel()
  const model = usePanelData()
  const list = useLiveResource('engine/tickets', {})
  const [stage, setStage] = useState('all')
  const [manualOpen, setManualOpen] = useState(false)
  const [doneExpanded, setDoneExpanded] = useState(false)
  const status = model.data
  const paused = Boolean(status && (status.paused === true || status.config?.paused === true || status.engine?.paused === true))
  const reloadBoth = useCallback(async () => { await Promise.all([model.reload(), list.reload()]) }, [model.reload, list.reload])
  const poll = useAction(() => model.actions.poll(), { reload: reloadBoth })

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
  const counts = list.data?.counts ?? {}
  const countOf = group => Number.isFinite(counts[group]) ? counts[group]
    : group === 'all' ? tickets.length : tickets.filter(ticket => ticketStatus(ticket).group === group).length
  const EXEC_STAGE_LABEL = { queued: 'ex.stageQueued', working: 'ex.stageWorking', waiting: 'ex.stageWaiting',
    failed: 'ex.stageFailed', done: 'ex.stageDone' }
  const stageOptions = EXEC_STAGES.map(group => ({
    value: group,
    label: `${pt(t, group === 'all' ? 'ex.filterAll' : EXEC_STAGE_LABEL[group])} ${countOf(group)}`,
  }))
  // Filtering is client-side: one fetch already carries every stage, so switching a pill never refetches.
  const inStage = stage === 'all' ? tickets : tickets.filter(ticket => ticketStatus(ticket).group === stage)
  const doneTickets = inStage.filter(ticket => ticketStatus(ticket).group === 'done')
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
  const stageEmptyState = h(Section, { title: pt(t, `group.${stage}`), count: 0 },
    h(EmptyState, { icon: 'filter', title: pt(t, 'ex.stageEmptyTitle'),
      action: h(Button, { variant: 'outline', size: 'sm', onClick: () => setStage('all') },
        pt(t, 'ex.stageEmptyAction')) }))
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
    h(Section, { title: pt(t, 'ex.executor'),
      badge: paused ? h(Tag, { tone: 'warning' }, pt(t, 'loadbarPaused')) : null,
      action: h('span', { className: 'sa-actions' }, refreshButton, pauseConfirm) },
      h('div', { className: 'sa-executor-band' },
        h('div', { className: 'sa-executor-load-col' }, h(ExecutorLoad, { load: status.load, labels: false })),
        h('div', { className: 'sa-executor-recent' },
          recentRun ? h(Fragment, null,
            h('span', { className: 'sa-hint' }, pt(t, 'ex.recentLabel')),
            h(When, { at: recentRun.startedAt }),
            h(Tag, { tone: recentRunFailed ? 'danger' : 'success' },
              pt(t, recentRunFailed ? 'ex.recentFailed' : 'ex.recentOk')),
            recentRun.error
              ? h('span', { className: 'sa-hint', title: String(recentRun.error) },
                pt(t, 'row.evidenceCause', { cause: failureLabel(t, String(recentRun.error)) }))
              : null,
            recentRun.ticketId
              ? h('a', { href: '#', className: 'sa-inline-link',
                onClick: event => { event.preventDefault(); navigate({ page: 'execution', id: recentRun.ticketId }) } },
                pt(t, 'ex.recentTicket'))
              : null) : null,
          h('a', { href: '#', className: 'sa-inline-link',
            onClick: event => { event.preventDefault(); navigate({ page: 'overview' }) } },
            pt(t, 'ex.runs24hFailed', { count: Number(status.runs24hFailed ?? 0) }) + ' →'))),
      status.config?.executor?.enabled === false ? h(Hint, null, pt(t, 'ex.executorDisabled')) : null,
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'outline', size: 'sm', icon: 'plus', onClick: () => setManualOpen(true) },
          pt(t, 'ex.createTicket')),
        h('span', { className: 'sa-hint' }, pt(t, 'ex.createHint'))),
      status.engine?.lastError ? h(ErrorState, { error: status.engine.lastError, onRetry: () => { void poll.run() } }) : null),
    list.error ? h(ErrorState, { error: list.error, onRetry: list.reload }) : null,
    tickets.length
      ? h('div', { className: 'sa-filters' },
        // `sa-segmented-wide` lets six counted pills use the row's full width (05-style.js); the default 480px cap is
        // tuned for the two-or-three-pill filters elsewhere.
        h(SegmentedControl, { options: stageOptions, value: stage, onChange: setStage, label: pt(t, 'ex.filterLabel'),
          className: 'sa-segmented-wide' }))
      : null,
    loadingList ? h(Skeleton, { rows: 5 })
      : !list.data ? null
        : !tickets.length ? emptyState
          : !inStage.length ? stageEmptyState
            : h(Fragment, null,
              h(TicketGroups, { tickets: shownTickets, page: 'execution', actions: model.actions, reload: reloadBoth,
                className: 'sa-exec-queue', groupNotes, groupCounts, header: queueHeader }),
              doneOverflow ? h('div', { className: 'sa-actions' },
                h(Button, { variant: 'outline', size: 'sm', onClick: () => setDoneExpanded(value => !value) },
                  pt(t, doneExpanded ? 'ex.doneCollapse' : 'ex.doneShowAll', { count: doneTickets.length }))) : null),
    h(Modal, { open: manualOpen, onClose: () => setManualOpen(false), title: pt(t, 'ex.createTicket'),
      closeLabel: t('close'), description: pt(t, 'ex.createHint') },
      h(ManualTicketForm, { heading: false, onDone: () => { setManualOpen(false); void reloadBoth() } })))
}

/** A deep-linked Ticket renders the full detail on this tab; otherwise the stage-grouped queue. */
function LiveExecutionPage({ route }) {
  return route?.id ? h(TicketDetail, { id: route.id, page: 'execution' }) : h(ExecutionQueuePage)
}
