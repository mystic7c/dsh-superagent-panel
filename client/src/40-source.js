/* LiveSourcePage (contract §6.2): one thin health line, then one card per Source with the three numbers that answer
   "did messages arrive, were any filtered, did they become Tickets", the reason a Source is off shown in place, and
   the one primary action plus one secondary. Under the Octo card every filtered message shows a human reason and
   keeps the original text folded. The page reads the shared status model (`usePanelData().data.sources`) and issues
   no request of its own. */

Object.assign(PAGE_TEXT, {
  'src.summary': ['启用中 {active}/{total} · 最近同步 {time}', '{active}/{total} enabled · synced {time}'],
  'src.summaryNoSync': ['启用中 {active}/{total} · 还没有同步记录', '{active}/{total} enabled · not synced yet'],
  'src.state.ready': ['正常', 'Ready'],
  'src.state.error': ['异常', 'Error'],
  'src.state.idle': ['空闲', 'Idle'],
  'src.state.off': ['未启用', 'Off'],
  'src.stat.received': ['24h 到达', 'Arrived (24h)'],
  'src.stat.filtered': ['24h 过滤', 'Filtered (24h)'],
  'src.stat.accepted': ['24h 接单', 'Accepted (24h)'],
  'src.stat.tickets': ['执行工单', 'Tickets'],
  'src.stat.mrOpen': ['待合并 MR', 'Open MRs'],
  'src.lastMessage': ['最近消息', 'Last message'],
  'src.groupIm': ['IM 消息源', 'IM sources'],
  'src.groupCode': ['GitLab 仓库', 'GitLab repositories'],
  'src.stat.deployed': ['UAT 已部署', 'Deployed to UAT'],
  'src.stat.failed': ['失败', 'Failed'],
  'src.action.filtered': ['查看被过滤', 'See filtered'],
  'src.action.uat': ['检查 UAT', 'Check UAT'],
  'src.action.project': ['打开项目', 'Open project'],
  'src.disabled': ['已禁用：在设置→来源打开「启用引擎」并保存。', 'Disabled: turn on “Engine enabled” under Settings → Source and save.'],
  'src.uatOk': ['UAT 正常（{status}）', 'UAT healthy ({status})'],
  'src.uatFail': ['UAT 检查失败：{error}', 'UAT check failed: {error}'],
  'src.filtered': ['被过滤消息', 'Filtered messages'],
  'src.filteredEmpty': ['最近 24 小时没有被过滤的消息。', 'No filtered messages in the last 24 hours.'],
  'src.raw': ['原始文本', 'Original text'],
  'src.reason.highRisk': ['命中高风险主题（生产 / DDL / 合并 / 密钥）', 'High-risk topic (production / DDL / merge / secret)'],
  'src.reason.sourceNotWatched': ['不在监听群', 'Chat is not watched'],
  'src.reason.senderNotAllowed': ['发送者不在允许名单', 'Sender is not in the allow list'],
  'src.reason.notText': ['不是文本消息', 'Not a text message'],
  'src.emptyTitle': ['还没有来源', 'No Source yet'],
  'src.emptyHint': ['先配置 Octo token 并添加一个监听群，消息会在这里出现。',
    'Connect the Octo token and add a watched group; its messages will show up here.'],
  'src.openSettings': ['打开设置', 'Open settings'],
  // ---- P1-1: the raw signal log (every candidate, including the filtered ones) -----------------------------------
  'src.signals': ['原始信号（最近）', 'Raw signals (recent)'],
  'src.signalsEmpty': ['最近没有原始信号。', 'No recent raw signals.'],
  'src.signalStatus.pending': ['待处理', 'Pending'], 'src.signalStatus.processed': ['已处理', 'Processed'],
  'src.signalStatus.ignored': ['已忽略', 'Ignored'], 'src.signalStatus.skipped': ['被过滤', 'Skipped'],
  'src.signalStatus.failed': ['失败', 'Failed'],
  'src.signalReplay': ['重放', 'Replay'],
  'src.signalReplayed': ['已重放（{status}）', 'Replayed ({status})'],
  'src.signalReplayTicket': ['已重放并新建工单', 'Replayed and created a Ticket'],
  'src.signalReason': ['原因：{reason}', 'Reason: {reason}'],
  'src.signalTicket': ['查看工单', 'Open Ticket'],
  'src.signalPreviewEmpty': ['（无文本）', '(no text)'],
  'src.signalsRefresh': ['刷新', 'Refresh'],
  // ---- P2-8: human quality labels on raw signals ----------------------------------------------------------------
  'src.labelsSummary': ['正确 {correct} · 误报 {falseWake} · 漏报 {missedWake}',
    '{correct} correct · {falseWake} false wake · {missedWake} missed'],
  'src.labelMenu': ['标注判定', 'Label this signal'],
  'src.labelSaved': ['已标注：{label}', 'Labelled: {label}'],
  'signalLabel.correct': ['正确', 'Correct'], 'signalLabel.false_wake': ['误报', 'False wake'],
  'signalLabel.missed_wake': ['漏报', 'Missed wake'], 'signalLabel.cleared': ['已清理', 'Cleared'],
})

/** Source health → the shared shape vocabulary: a healthy source reads as done (✓), a broken one as error (×), and
    an idle or switched-off one as the hollow idle circle. The label always comes from these PAGE_TEXT keys. */
const SOURCE_SHAPE = { ready: 'done', error: 'error', idle: 'idle', off: 'idle' }
// Octo is one Source; every repository gets its own `kind: 'execution'` card (`id: 'gitlab:<repoId>'`, contract §12).
const SOURCE_ICON = { source: 'message', octo: 'message', execution: 'pull', gitlab: 'pull' }
const sourceIconName = source => SOURCE_ICON[source?.kind] ?? SOURCE_ICON[source?.id] ?? 'inbox'
const isOctoSource = source => source?.id === 'octo' || source?.kind === 'source'
const isExecutionSource = source => source?.kind === 'execution' || String(source?.id ?? '').startsWith('gitlab')

function sourceStateView(source) {
  const key = Object.hasOwn(SOURCE_SHAPE, source?.state) ? source.state : 'idle'
  return { state: SOURCE_SHAPE[key], labelKey: `src.state.${key}` }
}

/** The three numbers per source kind (contract §4/§12 `sources[].stats`); a repository with failures shows a fourth. */
function sourceStatRows(source) {
  const stats = source?.stats ?? {}
  if (isOctoSource(source)) {
    return [['src.stat.received', stats.received], ['src.stat.filtered', stats.filtered], ['src.stat.accepted', stats.accepted]]
  }
  if (isExecutionSource(source)) {
    const rows = [['src.stat.tickets', stats.tickets], ['src.stat.mrOpen', stats.mrOpen], ['src.stat.deployed', stats.deployed]]
    if (Number(stats.failed) > 0) rows.push(['src.stat.failed', stats.failed])
    return rows
  }
  return []
}

/** The execution card's GitLab and repository facts (`source.config` plus the matching `config.repos` entry). */
function sourceRepoRows(t, source, repo) {
  const config = source?.config ?? {}
  const rows = []
  if (config.project) rows.push([pt(t, 'repo.project'), h('span', { className: 'sa-mono' }, String(config.project))])
  if (config.baseUrl) rows.push([pt(t, 'repo.baseUrl'), h(ExternalLink, { href: String(config.baseUrl), icon: null }, String(config.baseUrl))])
  if (config.targetBranch) rows.push([pt(t, 'repo.targetBranch'), h('span', { className: 'sa-mono' }, String(config.targetBranch))])
  rows.push([pt(t, 'repo.token'), config.tokenConfigured ? pt(t, 'repo.tokenConfigured') : pt(t, 'repo.tokenMissing')])
  if (repo?.repo) rows.push([pt(t, 'repo.localPath'), h('span', { className: 'sa-mono' }, String(repo.repo))])
  if (repo?.baseBranch || config.targetBranch) {
    rows.push([pt(t, 'repo.branches'), `${repo?.baseBranch ?? '—'} → ${config.targetBranch ?? '—'}`])
  }
  return rows
}

/** Verify/acceptance mode of one repository in one small line (`人工验收 · 合并后验收`). */
function sourceRepoModeHint(t, repo) {
  if (!repo) return ''
  return `${pt(t, 'repo.verifyMode')}：${repoVerifyModeText(t, repo.verifyMode)}`
    + ` · ${pt(t, 'repo.acceptance')}：${repoAcceptanceText(t, repo.acceptance)}`
}

/** One filter reason in the active language; an unknown code falls back to the host's own human text. */
function filteredReason(t, item) {
  const key = `src.reason.${item?.reasonCode ?? ''}`
  const text = pt(t, key)
  return text === key ? String(item?.reason ?? item?.reasonCode ?? '') : text
}

/** Thread label for a filtered message: the watched chat title when known, otherwise a short channel id. */
function filteredThread(source, item) {
  const key = String(item?.threadKey ?? '')
  const channelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key
  const title = channelId ? source?.config?.chatTitles?.[channelId] : undefined
  return title || (channelId ? shortId(channelId, 12) : key || '—')
}

/** Three equal-width statistics (`--sa-stats` scale in 05-style): label 12/tertiary over a 20/600 value. */
function SourceStats({ rows }) {
  const { t } = usePanel()
  return h('div', { className: 'sa-stats' }, rows.map(([labelKey, value]) =>
    h('div', { key: labelKey, className: 'sa-stat' },
      h('div', { className: 'sa-stat-label' }, pt(t, labelKey)),
      h('div', { className: 'sa-stat-value' }, String(value ?? 0)))))
}

/** Messages the Octo Source filtered out: thread, reason in plain words, and the raw text folded away. */
function FilteredMessages({ source, items }) {
  const { t } = usePanel()
  return h('ul', { className: 'sa-list' }, items.map(item => h('li', { key: item.id, className: 'sa-row' },
    h('div', { className: 'sa-row-main' },
      h('div', { className: 'sa-row-title' },
        h(StatusIcon, { state: 'idle', size: 14 }),
        h('span', { className: 'sa-ellipsis' }, filteredThread(source, item))),
      h('div', { className: 'sa-row-meta' },
        h('span', null, localized(t, source.title) || source.id),
        h('span', null, filteredReason(t, item)),
        item.at ? h(When, { at: item.at }) : null),
      item.text ? h(Folded, { summary: pt(t, 'src.raw') },
        h(ClampText, { text: item.text, limit: 480, lines: 8 })) : null))))
}

/** Signal status → the shared shape vocabulary; the label always comes from `src.signalStatus.*`. */
const SIGNAL_SHAPE = { pending: 'ongoing', processed: 'done', ignored: 'idle', skipped: 'warning', failed: 'error' }
const SIGNAL_TONE = { pending: 'info', processed: 'success', ignored: 'neutral', skipped: 'warning', failed: 'danger' }
/** Host skip codes → the same human reasons the filtered-message list already uses; an unknown code stays raw. */
const SIGNAL_REASON_KEYS = { 'chat-not-watched': 'src.reason.sourceNotWatched', sender: 'src.reason.senderNotAllowed',
  'sender-not-allowed': 'src.reason.senderNotAllowed', 'not-text': 'src.reason.notText', 'high-risk': 'src.reason.highRisk' }
function signalReasonText(t, item) {
  const code = item?.skipReason
  if (!code) return ''
  const key = SIGNAL_REASON_KEYS[String(code)]
  return key ? pt(t, key) : String(code)
}
/** A replayable signal is one the rules did not deliver (P1 §2.2): skipped, ignored or failed. */
const signalReplayable = item => ['skipped', 'ignored', 'failed'].includes(item?.status)
/** P2-8 label vocabulary: tone for the tag, label key for the text; unknown labels stay raw. */
const SIGNAL_LABEL_TONE = { correct: 'success', false_wake: 'warning', missed_wake: 'danger', cleared: 'neutral' }
const SIGNAL_LABEL_KEYS = { correct: 'signalLabel.correct', false_wake: 'signalLabel.false_wake',
  missed_wake: 'signalLabel.missed_wake', cleared: 'signalLabel.cleared' }
const SIGNAL_LABEL_ORDER = ['correct', 'false_wake', 'missed_wake', 'cleared']
const signalLabelText = (t, label) => {
  const key = SIGNAL_LABEL_KEYS[String(label ?? '')]
  return key ? pt(t, key) : String(label ?? '')
}

/** The raw signal log as rows: status, text preview, why it did not become a Ticket, and the one replay action. */
function RawSignalRows({ items, onReplay, onLabel, busy, labelBusy }) {
  const { t, navigate } = usePanel()
  return h('ul', { className: 'sa-list' }, items.map(item => {
    const status = String(item?.status ?? '')
    const reason = signalReasonText(t, item)
    const at = item?.receivedAt ?? item?.occurredAt
    const statusKey = `src.signalStatus.${status}`
    const statusLabel = pt(t, statusKey)
    const labels = Array.isArray(item?.labels) ? item.labels.filter(entry => entry && typeof entry === 'object') : []
    return h('li', { key: item.id, className: 'sa-row' },
      h(StatusIcon, { state: SIGNAL_SHAPE[status] ?? 'idle', size: 14, spin: false }),
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h(Tag, { tone: SIGNAL_TONE[status] ?? 'outline' }, statusLabel === statusKey ? status : statusLabel),
          h('span', { className: 'sa-ellipsis' }, String(item?.textPreview ?? '') || pt(t, 'src.signalPreviewEmpty'))),
        (item?.source || reason || at)
          ? h('div', { className: 'sa-row-meta' },
            item?.source ? h('span', { className: 'sa-mono' }, String(item.source)) : null,
            reason ? h('span', null, pt(t, 'src.signalReason', { reason })) : null,
            at ? h(When, { at }) : null,
            labels.length
              ? h('span', { className: 'sa-actions', style: { gap: 'var(--sa-sp-4)' } },
                labels.map((entry, index) => h(Tag, { key: entry.id ?? index,
                  tone: SIGNAL_LABEL_TONE[String(entry.label)] ?? 'outline', title: entry.note ? String(entry.note) : undefined },
                signalLabelText(t, entry.label))))
              : null)
          : null),
      h('div', { className: 'sa-row-actions' },
        item?.ticketId ? h(Button, { variant: 'ghost', size: 'sm',
          onClick: () => navigate({ page: 'execution', id: item.ticketId }) }, pt(t, 'src.signalTicket')) : null,
        signalReplayable(item) ? h(Button, { variant: 'outline', size: 'sm', icon: 'refresh', disabled: busy,
          onClick: () => onReplay(item) }, pt(t, 'src.signalReplay')) : null,
        // A host that returns `labels` supports the P2-8 endpoint; an older one gets no dead menu entry.
        Array.isArray(item?.labels) && typeof onLabel === 'function'
          ? h(Menu, { label: pt(t, 'src.labelMenu'), align: 'end',
            items: SIGNAL_LABEL_ORDER.map(label => ({ key: label, label: signalLabelText(t, label), disabled: labelBusy,
              onSelect: () => onLabel(item, label) })) })
          : null))
  }))
}

function LiveSourcePage() {
  const { t, navigate, notify } = usePanel()
  const { data, error, reload, actions } = usePanelData()
  const [uat, setUat] = useState()
  const [uatBusy, setUatBusy] = useState(false)
  const filteredRef = useRef(null)
  const poll = useAction(() => actions.poll({ dryRun: true }), { reload })
  const checkUat = async () => {
    setUatBusy(true)
    try { setUat(await actions.checkUat()) }
    catch (failure) { setUat({ ok: false, error: errorText(failure) }) }
    finally { setUatBusy(false) }
  }
  const focusFiltered = () => filteredRef.current?.scrollIntoView({ block: 'start' })
  // P1-1 raw signal log: a host with the endpoint answers; an older host 404s once and the section stays hidden
  // (the poll switches itself off on that first miss instead of retrying a route that will never exist).
  const [signalsOff, setSignalsOff] = useState(false)
  const signals = useLiveResource('engine/signals', { limit: 20 }, 30000, { enabled: !signalsOff })
  useEffect(() => { if (signals.error?.missing) setSignalsOff(true) }, [signals.error])
  const label = useAction(async (signal, labelId) => {
    await actions.labelSignal(signal.id, labelId)
    notify(pt(t, 'src.labelSaved', { label: signalLabelText(t, labelId) }))
  }, { reload: async () => { await Promise.all([reload(), signals.reload?.()]) } })
  const replay = useAction(async signal => {
    const result = await actions.replaySignal(signal.id)
    const ticket = result?.ticket
    if (ticket?.id) {
      notify(pt(t, 'src.signalReplayTicket'))
      navigate({ page: 'execution', id: ticket.id })
      return
    }
    notify(pt(t, 'src.signalReplayed', { status: result?.signal?.status ?? signal.status ?? '—' }))
  }, { reload: async () => { await Promise.all([reload(), signals.reload?.()]) } })

  if (!data) return error ? h(ErrorState, { error, onRetry: reload }) : h(Skeleton, { rows: 4 })

  const sources = Array.isArray(data.sources) ? data.sources : []
  const octo = sources.find(source => source.id === 'octo')
  // No Source at all, or Octo has neither a watched chat nor a token: nothing can arrive, so teach instead of showing
  // two empty cards. The token flag lives on the status config (the source payload has no token field of its own).
  const octoUnconfigured = Boolean(octo) && (octo.config?.watchChatIds ?? []).length === 0
    && data.config?.octo?.tokenConfigured !== true
  if (sources.length === 0 || octoUnconfigured) {
    return h(EmptyState, { icon: 'inbox', title: pt(t, 'src.emptyTitle'), hint: pt(t, 'src.emptyHint'),
      action: h(Button, { variant: 'primary', icon: h(Icon, { name: 'settings', size: 14 }),
        onClick: () => navigate({ page: 'settings', group: 'source' }) }, pt(t, 'src.openSettings')) })
  }

  const enabled = sources.filter(source => source.enabled).length
  const lastAt = sources.map(source => source.lastAt).filter(Boolean).sort().at(-1)
  const clock = lastAt ? (hhmmss(lastAt, t.lang) || '').slice(0, 5) : ''
  const summary = clock
    ? pt(t, 'src.summary', { active: enabled, total: sources.length, time: clock })
    : pt(t, 'src.summaryNoSync', { active: enabled, total: sources.length })
  const filtered = Array.isArray(octo?.filtered) ? octo.filtered : []
  const signalItems = Array.isArray(signals.data?.items) ? signals.data.items : []
  const labelCounts = signals.data?.counts?.labels ?? {}
  const labelTotal = SIGNAL_LABEL_ORDER.reduce((sum, label) => sum + (Number(labelCounts[label]) || 0), 0)
  // Two source classes (IM vs code repositories); each class renders its own section with a two-up card grid.
  const imSources = sources.filter(source => !isExecutionSource(source))
  const codeSources = sources.filter(isExecutionSource)
  // One execution card per repository (contract §12); the matching `repos` summary adds the local clone and modes.
  const repoOf = source => isExecutionSource(source) ? panelRepoOf(data, source.repoId) : undefined
  const isManual = source => repoOf(source)?.verifyMode === 'manual'

  const cardActions = (source) => {
    if (!isExecutionSource(source)) {
      return [
        // Unified action vocabulary (critique §3): 检查新消息 = dry-run poll, with the message icon and no
        // white primary fill, so it reads the same as the header action instead of a generic refresh button.
        h(Button, { key: 'poll', variant: 'outline', size: 'sm', icon: h(Icon, { name: 'message', size: 14 }),
          disabled: poll.busy || !source.enabled, onClick: () => { void poll.run() } }, pt(t, 'actions.checkNow')),
        h(Button, { key: 'filtered', variant: 'outline', size: 'sm', icon: h(Icon, { name: 'filter', size: 14 }),
          onClick: focusFiltered }, pt(t, 'src.action.filtered')),
      ]
    }
    const config = source.config ?? {}
    const projectUrl = config.baseUrl && config.project
      ? `${String(config.baseUrl).replace(/\/+$/, '')}/${config.project}` : ''
    return [
      // A `manual` repository has no UAT to check (contract §12.3); keep the project link as its one action.
      isManual(source) ? null
        : h(Button, { key: 'uat', variant: 'outline', size: 'sm', icon: h(Icon, { name: 'refresh', size: 14 }),
          disabled: uatBusy, onClick: () => { void checkUat() } }, pt(t, 'src.action.uat')),
      projectUrl ? h(ExternalLink, { key: 'project', href: projectUrl }, pt(t, 'src.action.project')) : null,
    ]
  }
  const uatResult = (source) => {
    if (!isExecutionSource(source) || isManual(source) || !uat) return null
    const label = uat.ok
      ? pt(t, 'src.uatOk', { status: uat.status ?? '—' })
      : pt(t, 'src.uatFail', { error: uat.error ?? uat.status ?? '—' })
    return h('div', { className: 'sa-actions' },
      h(StatusText, { state: uat.ok ? 'done' : 'error' }, label),
      uat.checkedAt ? h('span', { className: 'sa-row-meta' }, h(When, { at: uat.checkedAt })) : null)
  }
  const renderCard = (source) => {
    const view = sourceStateView(source)
    const repo = repoOf(source)
    const repoName = repo?.name ?? source.repoId
    const notes = []
    if (!source.enabled) notes.push(pt(t, 'src.disabled'))
    if (source.detail) notes.push(String(source.detail))
    const stats = sourceStatRows(source)
    const detailRows = isExecutionSource(source) ? sourceRepoRows(t, source, repo) : []
    return h('div', { key: source.id, className: 'sa-card' },
      h('div', { className: 'sa-card-head' },
        h('span', { className: 'sa-section-icon' }, h(Icon, { name: sourceIconName(source), size: 16 })),
        h('div', { className: 'sa-card-title' }, localized(t, source.title) || repoName || source.id),
        h(StatusText, { state: view.state }, pt(t, view.labelKey))),
      notes.length ? h(Hint, null, notes.join(' · ')) : null,
      // IM cards have no repository detail; let their two actions sit beside the stats instead of under them, so the
      // single-card row is not a full-width card with content only on the left.
      isExecutionSource(source)
        ? h(Fragment, null,
          stats.length ? h(SourceStats, { rows: stats }) : null,
          detailRows.length ? h(KeyValues, { rows: detailRows }) : null,
          repo ? h('p', { className: 'sa-hint' }, sourceRepoModeHint(t, repo)) : null,
          h('div', { className: 'sa-actions' }, cardActions(source)),
          uatResult(source))
        : h('div', { className: 'sa-card-row' },
          h('div', { className: 'sa-card-row-main' },
            stats.length ? h(SourceStats, { rows: stats }) : null,
            source.lastAt ? h('p', { className: 'sa-hint' }, pt(t, 'src.lastMessage'), ' · ', h(When, { at: source.lastAt })) : null),
          h('div', { className: 'sa-actions' }, cardActions(source))))
  }

  return h(Fragment, null,
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    h('p', { className: 'sa-hint', role: 'status' }, summary),
    h('div', { className: 'sa-source-groups' },
      imSources.length
        ? h(Section, { key: 'im', title: pt(t, 'src.groupIm') },
          h('div', { className: 'sa-cards-2' }, imSources.map(renderCard)))
        : null,
      codeSources.length
        ? h(Section, { key: 'code', title: pt(t, 'src.groupCode') },
          h('div', { className: 'sa-cards-2' }, codeSources.map(renderCard)))
        : null),
    octo ? h('div', { ref: filteredRef },
      h(Section, { title: pt(t, 'src.filtered'), count: filtered.length },
        filtered.length ? h(FilteredMessages, { source: octo, items: filtered }) : h(Hint, null, pt(t, 'src.filteredEmpty'))))
      : null,
    // The raw log is evidence, so it sits last and hides entirely while the host does not expose it.
    signals.data
      ? h(Section, { title: pt(t, 'src.signals'), count: signalItems.length,
        badge: labelTotal > 0
          ? h('span', { className: 'sa-hint' }, pt(t, 'src.labelsSummary', {
            correct: Number(labelCounts.correct) || 0, falseWake: Number(labelCounts.false_wake) || 0,
            missedWake: Number(labelCounts.missed_wake) || 0 }))
          : null,
        action: h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => { void signals.reload() } },
          pt(t, 'src.signalsRefresh')) },
        signalItems.length ? h(RawSignalRows, { items: signalItems, onReplay: item => { void replay.run(item) },
          onLabel: (item, labelId) => { void label.run(item, labelId) }, busy: replay.busy, labelBusy: label.busy })
          : h(Hint, null, pt(t, 'src.signalsEmpty')))
      : null)
}
