/* LiveSourcePage (contract §6.2): one thin health line, the intake ledger (one record per message — verdict, human
   reason, replay and quality label), then one card per Source with the three numbers that answer "did messages
   arrive, were any filtered, did they become Tickets". The skipped messages are a status filter of that one ledger,
   not a second list. The page reads the shared status model (`usePanelData().data.sources`) and issues no request of
   its own for it. */

import { API, Icon, clampPageOffset, hostName, hostOfUrl, hhmm, scrollPanelTo } from "./util.js"
import { errorText, localized, translate, when } from "./i18n.js"
import { Button, InfoTip, Input, Menu, SegmentedControl, StatusIcon, StatusText, Tag } from "./controls.js"
import { same, stay, useAction, usePanel, usePanelData } from "./api.js"
import { EmptyState, ErrorState, ExternalLink, Hint, Section, Skeleton, When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { useLiveResource } from "./live-model.js"
import { initialPageQuery, rememberPageState } from "./router.js"
import { setupStateOf } from "./setup.js"
import { engineOn, AutomationBar, executorOn, panelRepoOf } from "./live-ui.js"
import { Fragment, React, h, useCallback, useEffect, useRef, useState } from "./react.js"
Object.assign(PAGE_TEXT, {
  // The panel head already shows "数据更新于 HH:MM"; repeating the same clock here under a second name made it look
  // like a different measurement (ui review P2-4).
  'src.summary': ['已启用 {active}/{total} · 上次同步成功 {time}', '{active}/{total} enabled · last sync {time}'],
  'src.summaryNoSync': ['已启用 {active}/{total} · 还没有同步记录', '{active}/{total} enabled · not synced yet'],
  'src.state.ready': ['正常', 'Ready'],
  'src.state.error': ['异常', 'Error'],
  'src.state.idle': ['空闲', 'Idle'],
  'src.state.off': ['未启用', 'Off'],
  // U-10: without a token CI, deploy and MR observation are all unavailable, so a card that only reads the local path
  // must not claim "正常" — that label hid exactly the part that was not working.
  'src.state.localOnly': ['本地可用', 'Local only'],
  'src.localOnlyNote': ['未配置 token：不影响本地只读，但无法观测 CI / 部署、也无法建 MR。',
    'No token: local read-only work still runs, but CI, deploys and merge requests are unobservable.'],
  'src.stat.received': ['24h 到达', 'Arrived (24h)'],
  'src.stat.filtered': ['24h 过滤', 'Filtered (24h)'],
  'src.stat.accepted': ['24h 接单', 'Accepted (24h)'],
  'src.stat.tickets': ['执行工单', 'Tickets'],
  'src.stat.mrOpen': ['待合并 MR', 'Open MRs'],
  'src.lastMessage': ['最近消息', 'Last message'],
  'src.groupIm': ['IM 消息源', 'IM sources'],
  'src.groupCode': ['代码仓库', 'Code repositories'],
  'src.stat.deployed': ['UAT 已部署', 'Deployed to UAT'],
  'src.stat.failed': ['失败', 'Failed'],
  'src.action.filtered': ['查看被过滤', 'See filtered'],
  'src.action.uat': ['检查 UAT', 'Check UAT'],
  'src.action.project': ['打开项目', 'Open project'],
  'src.action.manage': ['管理仓库', 'Manage repository'],
  'src.checkNeedsToken': ['先保存 Octo token 才能检查新消息。', 'Save the Octo token before checking for messages.'],
  'src.disabled': ['已禁用：打开「启用引擎」（设置→来源）并保存。',
    'Disabled: turn on “Engine enabled” under Settings → Source and save.'],
  // A repository card is enabled by the executor switch, not the engine switch: say the switch that actually enables it.
  // The repo itself is on; do not call it "disabled" while only the executor is off.
  'src.disabledRepo': ['执行器未启用：打开「启用执行器」（设置→运行）并保存。',
    'Executor off: turn on “Executor enabled” under Settings → Runtime and save.'],
  'src.uatOk': ['UAT 正常（{status}）', 'UAT healthy ({status})'],
  'src.uatFail': ['UAT 检查失败：{error}', 'UAT check failed: {error}'],
  'src.reason.highRisk': ['命中高风险主题（生产 / DDL / 合并 / 密钥）', 'High-risk topic (production / DDL / merge / secret)'],
  'src.reason.sourceNotWatched': ['不在监听群', 'Chat is not watched'],
  'src.reason.senderNotAllowed': ['发送者不在允许名单', 'Sender is not in the allow list'],
  'src.reason.notText': ['不是文本消息', 'Not a text message'],
  'src.reason.channelMissing': ['缺少群 ID，无法匹配监听群', 'No chat id, so it matches no watched chat'],
  'src.reason.chatNotWatched': ['不在监听群', 'Chat is not watched'],
  'src.reason.systemMessage': ['系统消息（没有发送者）', 'System message (no sender)'],
  'src.reason.botSender': ['发送者是机器人', 'Sender is a bot'],
  'src.reason.botSelf': ['本机器人自己发出的消息', 'Sent by this bot itself'],
  'src.reason.selfReply': ['以回复前缀开头的自身消息', 'Own message starting with the reply prefix'],
  'src.reason.contextOnly': ['仅作为上下文送到执行器，没有单独开单', 'Context only: passed to the executor, no Ticket of its own'],
  'src.reason.modelSkip': ['模型判断这不是本仓库的任务', 'The model judged this is not a task for this repository'],
  'src.reason.modelRisk': ['模型判断属于高风险', 'The model judged this high risk'],
  'src.reason.modelUncertain': ['模型不确定，留给人工', 'The model was unsure, so a person decides'],
  'src.reasonUnknown': ['未识别原因（技术标识：{code}）', 'Unrecognised reason (code: {code})'],
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
  // U-05: the expandable row shows the body once — open, the preview span collapses into this control instead of
  // repeating the first 160 characters above the full text.
  'src.signalCollapse': ['收起', 'Collapse'],
  'src.signalsRefresh': ['刷新', 'Refresh'],
  'src.signalSearch': ['搜索原始信号', 'Search raw signals'],
  'src.signalRepo': ['按仓库筛选', 'Filter by repository'],
  'src.signalRepoPlaceholder': ['仓库 ID…', 'Repository ID…'],
  'src.signalReasonFilter': ['按原因筛选', 'Filter by reason'],
  'src.signalReasonPlaceholder': ['原因关键字…', 'Reason keyword…'],
  'src.signalFrom': ['开始日期', 'From date'],
  'src.signalTo': ['结束日期', 'To date'],
  'src.signalSearchPlaceholder': ['文本、来源或原因…', 'Text, source or reason…'],
  'src.signalFilter': ['信号状态', 'Signal status'],
  'src.signalPageInfo': ['{from}–{to} / 共 {total} 条', '{from}–{to} of {total}'],
  'src.prev': ['上一页', 'Previous'],
  'src.next': ['下一页', 'Next'],
  // ---- P2-8: human quality labels on raw signals ----------------------------------------------------------------
  'src.labelsSummary': ['正确 {correct} · 误报 {falseWake} · 漏报 {missedWake}',
    '{correct} correct · {falseWake} false wake · {missedWake} missed'],
  'src.labelMenu': ['标注判定', 'Label this signal'],
  // ---- P1 AC-07: a signal deep link from the Eval log; the row may be filtered out or already cleaned up ----
  'src.focusTitle': ['定位的原始信号', 'Located signal'],
  'src.focusMissing': ['这条原始信号已不在信号日志中（可能已清理），原文不可用。',
    'This signal is no longer in the raw log (it may have been cleared), so its text is unavailable.'],
  'src.focusMissingHint': ['它关联的工单或线程可能仍然可用。', 'Any Ticket or Thread it produced may still be available.'],
  'src.focusOffPage': ['这条信号不在当前筛选结果中，下面是它的记录。',
    'This signal is not in the current filter result; its record is shown below.'],
  'src.focusOpenThread': ['查看线程', 'Open Thread'],
  'src.focusClear': ['清除定位', 'Clear link'],
  'src.focusMissingTag': ['不可用', 'unavailable'],
  'src.labelSaved': ['已标注：{label}', 'Labelled: {label}'],
  'signalLabel.correct': ['正确', 'Correct'], 'signalLabel.false_wake': ['误报', 'False wake'],
  'signalLabel.missed_wake': ['漏报', 'Missed wake'], 'signalLabel.cleared': ['已清理', 'Cleared'],
})

/** Source health → the shared shape vocabulary: a healthy source reads as done (✓), a broken one as error (×), and
    an idle or switched-off one as the hollow idle circle. The label always comes from these PAGE_TEXT keys. */
export const SOURCE_SHAPE = { ready: 'done', error: 'error', idle: 'idle', off: 'idle' }
// Octo is one Source; every repository gets its own `kind: 'execution'` card (`id: 'gitlab:<repoId>'`, contract §12).
export const SOURCE_ICON = { source: 'message', octo: 'message', execution: 'pull', gitlab: 'pull' }
export const sourceIconName = source => SOURCE_ICON[source?.kind] ?? SOURCE_ICON[source?.id] ?? 'inbox'
export const isOctoSource = source => source?.id === 'octo' || source?.kind === 'source'
export const isExecutionSource = source => source?.kind === 'execution' || String(source?.id ?? '').startsWith('gitlab')

export function sourceStateView(source) {
  const key = Object.hasOwn(SOURCE_SHAPE, source?.state) ? source.state : 'idle'
  return { state: SOURCE_SHAPE[key], labelKey: `src.state.${key}` }
}

/** The three numbers per source kind (contract §4/§12 `sources[].stats`); a repository with failures shows a fourth. */
export function sourceStatRows(source) {
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

/** Three equal-width statistics (`--sa-stats` scale in 05-style): label 12/tertiary over a 20/600 value. */
export function SourceStats({ rows }) {
  const { t } = usePanel()
  return h('div', { className: 'sa-stats' }, rows.map(([labelKey, value]) =>
    h('div', { key: labelKey, className: 'sa-stat' },
      h('div', { className: 'sa-stat-label' }, pt(t, labelKey)),
      h('div', { className: 'sa-stat-value' }, String(value ?? 0)))))
}

/** Signal status → the shared shape vocabulary; the label always comes from `src.signalStatus.*`. */
export const SIGNAL_SHAPE = { pending: 'ongoing', processed: 'done', ignored: 'idle', skipped: 'warning', failed: 'error' }
export const SIGNAL_TONE = { pending: 'info', processed: 'success', ignored: 'neutral', skipped: 'warning', failed: 'danger' }
/** Host skip codes → human reasons. A row can carry a candidate skip (`bot-sender`, `chat-not-watched`, …) or a rule
    decision code (`sourceNotWatched`, `modelSkip`, …), so both spellings are mapped; an unknown code is labelled as
    unrecognised instead of leaking the identifier as the visible reason (U-11). */
export const SIGNAL_REASON_KEYS = {
  'channel-missing': 'src.reason.channelMissing',
  'chat-not-watched': 'src.reason.chatNotWatched',
  'system-message': 'src.reason.systemMessage',
  'not-text': 'src.reason.notText', notText: 'src.reason.notText',
  'bot-self': 'src.reason.botSelf',
  'bot-sender': 'src.reason.botSender',
  'self-reply': 'src.reason.selfReply',
  'high-risk': 'src.reason.highRisk', highRisk: 'src.reason.highRisk',
  contextOnly: 'src.reason.contextOnly',
  sourceNotWatched: 'src.reason.sourceNotWatched',
  sender: 'src.reason.senderNotAllowed', 'sender-not-allowed': 'src.reason.senderNotAllowed',
  senderNotAllowed: 'src.reason.senderNotAllowed',
  modelSkip: 'src.reason.modelSkip', modelRisk: 'src.reason.modelRisk', modelUncertain: 'src.reason.modelUncertain',
  ignore: 'src.reason.contextOnly',
}
/** True when the host code is one this build knows how to phrase; used by the row to decide whether to add a code hint. */
export const signalReasonKnown = code => Object.hasOwn(SIGNAL_REASON_KEYS, String(code ?? ''))
export function signalReasonText(t, item) {
  const code = item?.skipReason
  if (!code) return ''
  const key = SIGNAL_REASON_KEYS[String(code)]
  return key ? pt(t, key) : pt(t, 'src.reasonUnknown', { code: String(code) })
}
/** A replayable signal is one the rules did not deliver (P1 §2.2): skipped, ignored or failed. */
export const signalReplayable = item => ['skipped', 'ignored', 'failed'].includes(item?.status)
/** P2-8 label vocabulary: tone for the tag, label key for the text; unknown labels stay raw. */
export const SIGNAL_LABEL_TONE = { correct: 'success', false_wake: 'warning', missed_wake: 'danger', cleared: 'neutral' }
export const SIGNAL_LABEL_KEYS = { correct: 'signalLabel.correct', false_wake: 'signalLabel.false_wake',
  missed_wake: 'signalLabel.missed_wake', cleared: 'signalLabel.cleared' }
export const SIGNAL_LABEL_ORDER = ['correct', 'false_wake', 'missed_wake', 'cleared']
export const signalLabelText = (t, label) => {
  const key = SIGNAL_LABEL_KEYS[String(label ?? '')]
  return key ? pt(t, key) : String(label ?? '')
}

/** The raw signal log as rows: status, text preview, why it did not become a Ticket, and the one replay action. */
export function RawSignalRows({ items, onReplay, onLabel, busy, labelBusy, focusId, onOpenTicket }) {
  const { t, navigate } = usePanel()
  // U-05: the host only sends a 160-char preview, so a long message could never be read. The row stays one line when
  // collapsed (same row height as before) and expands in place; the open row is component state, never the URL.
  const [openId, setOpenId] = useState('')
  const toggleRow = id => setOpenId(current => (current === id ? '' : id))
  return h('ul', { className: 'sa-list' }, items.map(item => {
    const status = String(item?.status ?? '')
    const reason = signalReasonText(t, item)
    const at = item?.receivedAt ?? item?.occurredAt
    const statusKey = `src.signalStatus.${status}`
    const statusLabel = pt(t, statusKey)
    const labels = Array.isArray(item?.labels) ? item.labels.filter(entry => entry && typeof entry === 'object') : []
    const preview = String(item?.textPreview ?? '')
    // `text` is only sent when the body is longer than the preview, so short rows keep today's plain one-liner.
    const full = typeof item?.text === 'string' && item.text ? item.text : preview
    const expandable = Boolean(full) && full !== preview
    const open = expandable && openId === item.id
    return h('li', { key: item.id, id: `sa-signal-${item.id}`,
      className: item.id === focusId ? 'sa-row sa-row-focus' : 'sa-row' },
      h(StatusIcon, { state: SIGNAL_SHAPE[status] ?? 'idle', size: 14, spin: false }),
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h(Tag, { tone: SIGNAL_TONE[status] ?? 'outline' }, statusLabel === statusKey ? status : statusLabel),
          expandable
            // A real button: a span with role=button is not focusable in older Safari and had no accessible role in some
            // screen readers (audit P2).
            ? h('button', { type: 'button',
              className: open ? 'sa-signal-text sa-signal-text-open' : 'sa-ellipsis sa-signal-toggle',
              title: full, 'aria-expanded': open ? 'true' : 'false',
              onClick: () => toggleRow(item.id) },
            open ? pt(t, 'src.signalCollapse') : (preview || pt(t, 'src.signalPreviewEmpty')))
            : h('span', { className: 'sa-ellipsis' }, preview || pt(t, 'src.signalPreviewEmpty'))),
        (item?.source || reason || at)
          ? h('div', { className: 'sa-row-meta' },
            item?.source ? h('span', { className: 'sa-mono', translate: 'no' }, String(item.source)) : null,
            reason ? h('span', null, pt(t, 'src.signalReason', { reason })) : null,
            at ? h(When, { at }) : null,
            labels.length
              ? h('span', { className: 'sa-actions', style: { gap: 'var(--sa-sp-4)' } },
                labels.map((entry, index) => h(Tag, { key: entry.id ?? index,
                  tone: SIGNAL_LABEL_TONE[String(entry.label)] ?? 'outline', title: entry.note ? String(entry.note) : undefined },
                signalLabelText(t, entry.label))))
              : null)
          : null),
      open
        ? h('p', { className: 'sa-signal-full' }, full)
        : null,
      h('div', { className: 'sa-row-actions' },
        item?.ticketId ? h(Button, { variant: 'ghost', size: 'sm',
          onClick: () => (onOpenTicket ? onOpenTicket(item.ticketId) : navigate({ page: 'execution', id: item.ticketId })) },
        pt(t, 'src.signalTicket')) : null,
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

/** A date input is local midnight; the API compares ISO instants, so widen the end date to its last millisecond. */
export function srcDayBound(value, end = false) {
  if (!value) return ''
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export const SRC_SCROLL_KEY = 'superagent-panel/source-scroll'

/** The panel scrolls inside `.sa-scroll`, not the window; saving window.scrollY always restored 0 (review P1 AC-07). */
export function sourceScrollTop() {
  try {
    const scroller = document.querySelector('.sa-scroll')
    const y = scroller ? scroller.scrollTop : window.scrollY
    return Number.isFinite(y) && y > 0 ? y : 0
  } catch { return 0 }
}
export function rememberSourceScroll() {
  const y = sourceScrollTop()
  if (y > 0) try { sessionStorage.setItem(SRC_SCROLL_KEY, String(y)) } catch { /* private mode */ }
}
export function restoreSourceScroll() {
  try {
    const y = Number(sessionStorage.getItem(SRC_SCROLL_KEY) ?? 0)
    if (!(y > 0)) return
    const scroller = document.querySelector('.sa-scroll')
    if (scroller) scroller.scrollTop = y
    else window.scrollTo(0, y)
  } catch { /* private mode */ }
}

/** P1 AC-07: the Eval log links here with a signal id. The raw row may be filtered out of the current page or already
    cleaned up, so the link answers with a located-signal card (or an explicit cleaned-up notice) instead of nothing. */
export function LocatedSignal({ view, missing, offPage, onClear, onOpenTicket, onOpenThread }) {
  const { t } = usePanel()
  const signal = view?.signal ?? {}
  const status = String(signal.status ?? '')
  const reason = signalReasonText(t, signal)
  const at = signal.receivedAt ?? signal.occurredAt
  const ticketId = view?.ticket?.id ?? signal.ticketId
  const threadKey = view?.trigger?.threads?.[0] ?? signal.scopeKey
  if (missing) {
    return h('div', { className: 'sa-card', id: 'sa-located-signal' },
      h('div', { className: 'sa-card-head' },
        h('span', { className: 'sa-card-title' }, pt(t, 'src.focusTitle')),
        h(Tag, { tone: 'warning' }, pt(t, 'src.focusMissingTag'))),
      h(Hint, null, pt(t, 'src.focusMissing')),
      h('p', { className: 'sa-hint' }, pt(t, 'src.focusMissingHint')),
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'ghost', size: 'sm', onClick: onClear }, pt(t, 'src.focusClear'))))
  }
  const statusKey = `src.signalStatus.${status}`
  const statusLabel = pt(t, statusKey)
  return h('div', { className: 'sa-card', id: 'sa-located-signal' },
    h('div', { className: 'sa-card-head' },
      h(StatusIcon, { state: SIGNAL_SHAPE[status] ?? 'idle', size: 14 }),
      h('span', { className: 'sa-card-title' }, pt(t, 'src.focusTitle')),
      h(Tag, { tone: SIGNAL_TONE[status] ?? 'outline' }, statusLabel === statusKey ? status : statusLabel)),
    h('div', { className: 'sa-row-title' },
      String(signal.textPreview ?? signal.candidate?.text ?? signal.payload?.text ?? '') || pt(t, 'src.signalPreviewEmpty')),
    h('div', { className: 'sa-row-meta' },
      signal.source ? h('span', { className: 'sa-mono', translate: 'no' }, String(signal.source)) : null,
      reason ? h('span', null, pt(t, 'src.signalReason', { reason })) : null,
      at ? h(When, { at }) : null),
    offPage ? h(Hint, null, pt(t, 'src.focusOffPage')) : null,
    h('div', { className: 'sa-actions' },
      ticketId ? h(Button, { variant: 'outline', size: 'sm', onClick: () => onOpenTicket(ticketId) },
        pt(t, 'src.signalTicket')) : null,
      threadKey ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => onOpenThread(threadKey) },
        pt(t, 'src.focusOpenThread')) : null,
      h(Button, { variant: 'ghost', size: 'sm', onClick: onClear }, pt(t, 'src.focusClear'))))
}

export function LiveSourcePage({ route }) {
  const { t, navigate, notify } = usePanel()
  const focusId = typeof route?.id === 'string' && route.id.trim() ? route.id.trim() : ''
  const { data, error, reload, actions } = usePanelData()
  // Keyed by repo id: one shared slot meant a UAT check started on one repository card answered for all of them.
  const [uat, setUat] = useState({})
  // Which repository is being checked, not a single global flag: one card's spinner used to grey out every card's UAT
  // button (review P3).
  const [uatBusy, setUatBusy] = useState('')
  const poll = useAction(() => actions.poll({ dryRun: true }), { reload })
  const startAutomation = useAction(async () => {
    await actions.patchSettings({ paused: false, enabled: true, 'executor.enabled': true })
    notify(pt(t, 'automation.started'))
  }, { reload })
  const checkUat = async (repoId) => {
    if (!repoId) return
    setUatBusy(repoId)
    try { const result = await actions.checkUat(repoId); setUat(previous => ({ ...previous, [repoId]: result })) }
    catch (failure) { setUat(previous => ({ ...previous, [repoId]: { ok: false, error: errorText(failure) } })) }
    finally { setUatBusy(current => current === repoId ? '' : current) }
  }
  // P1-1 raw signal log: a host with the endpoint answers; an older host 404s once and the section stays hidden
  // (the poll switches itself off on that first miss instead of retrying a route that will never exist).
  const [signalsOff, setSignalsOff] = useState(false)
  // R2-01/R2-08/R2-15: a URL that carries this page's parameters wins (a shared or reloaded link, including the page
  // offset); otherwise the tab's remembered slice is restored, and the query string captured at load time covers a host
  // that consumed its own parameter before the panel mounted.
  const srcInitial = useRef(initialPageQuery('source', params => {
    const offset = Number(params.get('srcOffset') ?? 0)
    const status = params.get('srcStatus') || 'all'
    return { q: params.get('srcQ') || '', status: Object.hasOwn(SIGNAL_SHAPE, status) ? status : 'all',
      repo: params.get('srcRepo') || '', reason: params.get('srcReason') || '',
      from: params.get('srcFrom') || '', to: params.get('srcTo') || '',
      offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0 }
  }, { q: '', status: 'all', repo: '', reason: '', from: '', to: '', offset: 0 }))
  const [sigQuery, setSigQuery] = useState(srcInitial.current.q)
  const [sigQ, setSigQ] = useState(srcInitial.current.q)
  const [sigStatus, setSigStatus] = useState(srcInitial.current.status)
  // `sigRepo`/`sigReason` are the applied filters (request + URL); the inputs keep their own state so the 300 ms
  // debounce covers every text field. Re-setting the applied value to itself only debounced `sigQuery`, so typing in
  // either text field fired one request per keystroke (review P3).
  const [sigRepo, setSigRepo] = useState(srcInitial.current.repo)
  const [sigReason, setSigReason] = useState(srcInitial.current.reason)
  const [sigRepoInput, setSigRepoInput] = useState(srcInitial.current.repo)
  const [sigReasonInput, setSigReasonInput] = useState(srcInitial.current.reason)
  const [sigFrom, setSigFrom] = useState(srcInitial.current.from)
  const [sigTo, setSigTo] = useState(srcInitial.current.to)
  const [sigOffset, setSigOffset] = useState(srcInitial.current.offset)
  const signalsRef = useRef(null)
  useEffect(() => {
    const timer = setTimeout(() => { setSigQ(sigQuery); setSigRepo(sigRepoInput); setSigReason(sigReasonInput) }, 300)
    return () => clearTimeout(timer)
  }, [sigQuery, sigRepoInput, sigReasonInput])
  // A filter change starts at the first page, unless the offset was just restored from the URL or this tab's memory.
  // A popstate restore rewrites the whole slice; without the flag this effect undoes the restored page right away and
  // back/forward always landed on 1–20 (review P2). eval.js consumes the same flag.
  const firstSignalFilterRun = useRef(true)
  const restoringSignalFilters = useRef(false)
  // Mirror for the []-deps popstate listener, which cannot read the current state through its closure.
  const currentSignalSlice = useRef({ sigQ, sigStatus, sigRepo, sigReason, sigFrom, sigTo })
  currentSignalSlice.current = { sigQ, sigStatus, sigRepo, sigReason, sigFrom, sigTo }
  useEffect(() => {
    if (firstSignalFilterRun.current) { firstSignalFilterRun.current = false; return }
    if (restoringSignalFilters.current) { restoringSignalFilters.current = false; return }
    setSigOffset(0)
  }, [sigQ, sigStatus, sigRepo, sigReason, sigFrom, sigTo])
  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      if (sigQ) url.searchParams.set('srcQ', sigQ); else url.searchParams.delete('srcQ')
      if (sigStatus !== 'all') url.searchParams.set('srcStatus', sigStatus); else url.searchParams.delete('srcStatus')
      for (const [key, param, value] of [['srcRepo', 'srcRepo', sigRepo], ['srcReason', 'srcReason', sigReason],
        ['srcFrom', 'srcFrom', sigFrom], ['srcTo', 'srcTo', sigTo]]) {
        if (value) url.searchParams.set(key, value); else url.searchParams.delete(param)
      }
      if (sigOffset > 0) url.searchParams.set('srcOffset', String(sigOffset)); else url.searchParams.delete('srcOffset')
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    } catch { /* private mode */ }
    // R2-08: the URL only holds the current page's parameters (U-08), so the tab also remembers the slice.
    rememberPageState('source', { q: sigQ, status: sigStatus, repo: sigRepo, reason: sigReason,
      from: sigFrom, to: sigTo, offset: sigOffset })
  }, [sigQ, sigStatus, sigRepo, sigReason, sigFrom, sigTo, sigOffset])
  useEffect(() => {
    const restore = () => {
      try {
        const params = new URLSearchParams(window.location.search)
        const status = params.get('srcStatus') || 'all'
        const next = { q: params.get('srcQ') || '', status: Object.hasOwn(SIGNAL_SHAPE, status) ? status : 'all',
          repo: params.get('srcRepo') || '', reason: params.get('srcReason') || '',
          from: params.get('srcFrom') || '', to: params.get('srcTo') || '' }
        const now = currentSignalSlice.current
        if (next.q !== now.sigQ || next.status !== now.sigStatus || next.repo !== now.sigRepo
          || next.reason !== now.sigReason || next.from !== now.sigFrom || next.to !== now.sigTo) {
          restoringSignalFilters.current = true
        }
        setSigQuery(params.get('srcQ') || ''); setSigQ(params.get('srcQ') || '')
        setSigStatus(Object.hasOwn(SIGNAL_SHAPE, status) ? status : 'all')
        setSigRepo(params.get('srcRepo') || ''); setSigRepoInput(params.get('srcRepo') || '')
        setSigReason(params.get('srcReason') || ''); setSigReasonInput(params.get('srcReason') || '')
        setSigFrom(params.get('srcFrom') || ''); setSigTo(params.get('srcTo') || '')
        const offset = Number(params.get('srcOffset') ?? 0)
        setSigOffset(Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0)
      } catch { /* ignore */ }
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  const signals = useLiveResource('engine/signals', { q: sigQ,
    status: sigStatus === 'all' ? undefined : sigStatus, repo: sigRepo, reason: sigReason,
    from: srcDayBound(sigFrom), to: srcDayBound(sigTo, true), offset: sigOffset, limit: 20 },
  30000, { enabled: !signalsOff })
  // AC-07: a link from the Eval log carries a signal id; resolve it even when the current filter/page does not hold it.
  const focus = useLiveResource('engine/signal/:id', { id: focusId }, 30000, { enabled: Boolean(focusId) })
  const leaveTo = useCallback(next => { rememberSourceScroll(); navigate(next) }, [navigate])
  // Leaving the page (a Ticket/Thread link or a tab switch) remembers the list position; coming back restores it unless
  // the route asks for one specific signal, which scrolls there instead.
  useEffect(() => () => { rememberSourceScroll() }, [])
  const restoredSourceScroll = useRef(false)
  useEffect(() => {
    if (restoredSourceScroll.current || !signals.data || focusId) return
    restoredSourceScroll.current = true
    window.requestAnimationFrame(restoreSourceScroll)
  }, [signals.data, focusId])
  const scrolledFocus = useRef('')
  useEffect(() => {
    if (!focusId || !focus.data || scrolledFocus.current === focusId) return
    const node = document.getElementById(`sa-signal-${focusId}`) ?? document.getElementById('sa-located-signal')
    if (!node) return
    scrolledFocus.current = focusId
    // U-01: keep the jump inside the panel's scroller; the host frame is not ours to move.
    scrollPanelTo(node, { align: 'center' })
  }, [focusId, focus.data, signals.data])
  useEffect(() => { if (signals.error?.missing) setSignalsOff(true) }, [signals.error])
  // An offset from a link (or a shrinking result set) can point past the end: the log then rendered "no signals yet"
  // with the pager unmounted, so there was no way back to a real page (review P2).
  const signalTotal = Number.isFinite(Number(signals.data?.total))
    ? Number(signals.data.total) : (signals.data ? (signals.data.items ?? []).length : undefined)
  useEffect(() => {
    if (signalTotal === undefined) return
    const lastPage = clampPageOffset(sigOffset, signalTotal, 20)
    if (lastPage !== undefined) setSigOffset(lastPage)
  }, [signalTotal, sigOffset])
  // Any narrowing at all keeps the filters on screen even at zero rows: that is a filter result, not an empty ledger.
  const signalFilterActive = Boolean(String(sigQ ?? '').trim() || sigStatus !== 'all' || sigRepo || sigReason || sigFrom || sigTo)
  const label = useAction(async (signal, labelId) => {
    await actions.labelSignal(signal.id, labelId)
    notify(pt(t, 'src.labelSaved', { label: signalLabelText(t, labelId) }))
  }, { reload: async () => { await Promise.all([reload(), signals.reload?.()]) } })
  // The Octo card's 查看被过滤 action now filters the one ledger instead of scrolling to a duplicate list of the same rows.
  const showFiltered = () => {
    setSigStatus('skipped')
    scrollPanelTo(signalsRef.current)
  }
  const replay = useAction(async signal => {
    const result = await actions.replaySignal(signal.id)
    const ticket = result?.ticket
    if (ticket?.id) {
      notify(pt(t, 'src.signalReplayTicket'))
      leaveTo({ page: 'execution', id: ticket.id })
      return
    }
    notify(pt(t, 'src.signalReplayed', { status: result?.signal?.status ?? signal.status ?? '—' }))
  }, { reload: async () => { await Promise.all([reload(), signals.reload?.()]) } })

  if (!data) return error ? h(ErrorState, { error, onRetry: reload }) : h(Skeleton, { rows: 4 })

  const sources = Array.isArray(data.sources) ? data.sources : []
  const octo = sources.find(source => source.id === 'octo')
  const paused = data.paused === true || data.config?.paused === true || data.engine?.paused === true
  const engineEnabled = engineOn(data.config)
  const executorEnabled = executorOn(data.config)
  const automationNeeded = paused || !engineEnabled || !executorEnabled
  const automationReady = Boolean(data.config?.octo?.tokenConfigured
    && (data.config?.octo?.watchChatIds ?? []).length > 0
    && (data.config?.repos ?? []).length > 0)
  const showAutomationBar = automationNeeded && automationReady
  const setup = setupStateOf(data)
  // No Source at all, or Octo has neither a watched chat nor a token: nothing can arrive, so teach instead of showing
  // two empty cards. The token flag lives on the status config (the source payload has no token field of its own).
  const octoUnconfigured = Boolean(octo) && (octo.config?.watchChatIds ?? []).length === 0
    && data.config?.octo?.tokenConfigured !== true
  if (sources.length === 0 || octoUnconfigured) {
    return h(EmptyState, { icon: 'inbox', title: pt(t, 'src.emptyTitle'), hint: pt(t, 'src.emptyHint'),
      action: h(Button, { variant: 'primary', icon: h(Icon, { name: 'settings', size: 14 }),
        onClick: () => navigate({ page: 'settings', group: 'source' }) }, pt(t, 'src.openSettings')) })
  }

  const signalItems = Array.isArray(signals.data?.items) ? signals.data.items : []
  const labelCounts = signals.data?.counts?.labels ?? {}
  const labelTotal = SIGNAL_LABEL_ORDER.reduce((sum, label) => sum + (Number(labelCounts[label]) || 0), 0)
  // Two source classes (IM vs code repositories); each class renders its own section with a two-up card grid.
  const imSources = sources.filter(source => !isExecutionSource(source))
  // U-10: `normalizeRepos` synthesizes one placeholder repository even when live.json binds none, and counting it made
  // a freshly installed panel read "已启用 2/2" (same cause as B1). A card without a local path or a project is not a
  // repository the page can report on, so it is neither rendered nor counted.
  const codeSources = sources.filter(isExecutionSource).filter(source => {
    const repo = panelRepoOf(data, source.repoId)
    return Boolean(String(source.config?.project ?? '').trim() || String(repo?.repo ?? '').trim())
  })
  const counted = [...imSources, ...codeSources]
  const enabled = counted.filter(source => source.enabled).length
  // ISO strings sort lexically only while they share a timezone offset; parse before comparing.
  const lastAt = counted.map(source => source.lastAt).filter(item => Number.isFinite(Date.parse(item)))
    .sort((left, right) => Date.parse(left) - Date.parse(right)).at(-1)
  const clock = lastAt ? hhmm(lastAt, t.lang) : ''
  const summary = clock
    ? pt(t, 'src.summary', { active: enabled, total: counted.length, time: clock })
    : pt(t, 'src.summaryNoSync', { active: enabled, total: counted.length })
  // One execution card per repository (contract §12); the matching `repos` summary adds the local clone and modes.
  const repoOf = source => isExecutionSource(source) ? panelRepoOf(data, source.repoId) : undefined
  const isManual = source => repoOf(source)?.verifyMode === 'manual'

  const cardActions = (source) => {
    if (!isExecutionSource(source)) {
      return [
        // Unified action vocabulary (critique §3): 检查新消息 = dry-run poll, with the message icon and no
        // white primary fill, so it reads the same as the header action instead of a generic refresh button.
        // Dry run is the one intake action that stays meaningful while the engine is off, as long as a token exists.
        h(Fragment, { key: 'poll' },
          h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'message', size: 14 }),
            disabled: poll.busy || (!source.enabled && data.config?.octo?.tokenConfigured !== true),
            onClick: () => { void poll.run() } }, pt(t, 'actions.checkNow')),
          // A disabled control still has to say why: the reason is a focusable tip, not a title tooltip (A3).
          !source.enabled && data.config?.octo?.tokenConfigured !== true
            ? h(InfoTip, { text: pt(t, 'src.checkNeedsToken'), warn: true }) : null),
        // The ledger is the only list of filtered messages now: the card action narrows its status filter instead of
        // scrolling to a second copy of the same rows.
        h(Button, { key: 'filtered', variant: 'outline', size: 'sm', icon: h(Icon, { name: 'filter', size: 14 }),
          onClick: showFiltered }, pt(t, 'src.action.filtered')),
      ]
    }
    const config = source.config ?? {}
    const projectUrl = config.baseUrl && config.project
      ? `${String(config.baseUrl).replace(/\/+$/, '')}/${config.project}` : ''
    return [
      // A `manual` repository has no UAT to check (contract §12.3); keep the project link as its one action.
      isManual(source) ? null
        : h(Button, { key: 'uat', variant: 'outline', size: 'sm', icon: h(Icon, { name: 'refresh', size: 14 }),
          disabled: uatBusy === source.repoId || !source.repoId, onClick: () => { void checkUat(source.repoId) } },
          pt(t, 'src.action.uat')),
      projectUrl ? h(ExternalLink, { key: 'project', href: projectUrl }, pt(t, 'src.action.project')) : null,
      h(Button, { key: 'manage', variant: 'ghost', size: 'sm',
        onClick: () => navigate({ page: 'settings', group: 'repos' }) }, pt(t, 'src.action.manage')),
    ]
  }
  const uatResult = (source) => {
    const checked = uat[source.repoId]
    if (!isExecutionSource(source) || isManual(source) || !checked) return null
    const label = checked.ok
      ? pt(t, 'src.uatOk', { status: checked.status ?? '—' })
      : pt(t, 'src.uatFail', { error: checked.error ?? checked.status ?? '—' })
    return h('div', { className: 'sa-actions' },
      h(StatusText, { state: checked.ok ? 'done' : 'error' }, label),
      checked.checkedAt ? h('span', { className: 'sa-row-meta' }, h(When, { at: checked.checkedAt })) : null)
  }
  const renderCard = (source) => {
    const view = sourceStateView(source)
    const repo = repoOf(source)
    const repoName = repo?.name ?? source.repoId
    const notes = []
    // Every disabled Source says so on its own card: the page-level automation bar explains the pause, not which
    // Sources are switched off, and two cards reading only "空闲" looked like healthy repositories (critique 2026-11-11).
    // U-10: `ready` only means the local path is readable. Say what is missing (the token) instead of a green "正常".
    const localOnly = isExecutionSource(source) && source.state === 'ready' && source.config?.tokenConfigured === false
    if (localOnly) notes.push(pt(t, 'src.localOnlyNote'))
    if (source.detail && (!showAutomationBar || source.enabled)) notes.push(String(source.detail))
    const stats = sourceStatRows(source)
    return h('div', { key: source.id, className: 'sa-card' },
      h('div', { className: 'sa-card-head' },
        h('span', { className: 'sa-section-icon' }, h(Icon, { name: sourceIconName(source), size: 16 })),
        h('div', { className: 'sa-card-title' }, localized(t, source.title) || repoName || source.id),
        h(StatusText, { state: view.state }, pt(t, localOnly ? 'src.state.localOnly' : view.labelKey))),
      notes.length ? h(Hint, null, notes.join(' · ')) : null,
      // IM cards have no repository detail; let their two actions sit beside the stats instead of under them, so the
      // single-card row is not a full-width card with content only on the left.
      isExecutionSource(source)
        ? h(Fragment, null,
          stats.length ? h(SourceStats, { rows: stats }) : null,
          h('div', { className: 'sa-actions' }, cardActions(source)),
          uatResult(source))
        : h('div', { className: 'sa-card-row' },
          h('div', { className: 'sa-card-row-main' },
            stats.length ? h(SourceStats, { rows: stats }) : null,
            source.lastAt ? h('p', { className: 'sa-hint' }, pt(t, 'src.lastMessage'), ' · ', h(When, { at: source.lastAt })) : null),
          h('div', { className: 'sa-actions' }, cardActions(source))))
  }

  // The intake ledger comes first: repository cards are configuration summaries, the signals are the work record.
  const groups = h('div', { className: 'sa-source-groups' },
    imSources.length
      ? h(Section, { key: 'im', title: pt(t, 'src.groupIm') },
        h('div', { className: 'sa-cards-2' }, imSources.map(renderCard)))
      : null,
    codeSources.length
      ? h(Section, { key: 'code', title: pt(t, 'src.groupCode') },
        h('div', { className: 'sa-cards-2' }, codeSources.map(renderCard)))
      : null)
  const pageOff = !engineEnabled ? pt(t, 'src.disabled')
    : !executorEnabled ? pt(t, 'src.disabledRepo') : null
  return h(Fragment, null,
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    h('p', { className: 'sa-hint', role: 'status' }, summary),
    pageOff ? h(Hint, null, pageOff) : null,
    showAutomationBar
      ? h(AutomationBar, { paused, engineEnabled, executorEnabled, onStart: () => startAutomation.run(),
        progress: setup })
      : null,
    focusId && (focus.data || focus.error?.missing)
      ? h(LocatedSignal, { view: focus.data, missing: Boolean(focus.error?.missing),
        offPage: Boolean(focus.data) && !signalItems.some(item => item.id === focusId),
        onClear: () => navigate({ page: 'source' }, true),
        onOpenTicket: id => leaveTo({ page: 'execution', id }),
        onOpenThread: key => leaveTo({ page: 'trigger', id: key }) })
      : null,
    // The ledger is this page's job — what arrived and what happened to it — so it renders before the configuration
    // cards, and hides entirely while the host does not expose it. The section itself must not vanish while the first
    // load is pending or a poll failed, so it keeps its heading and renders a skeleton or the retryable error (P2).
    signalsOff
      ? null
      : h('div', { ref: signalsRef, 'aria-busy': signals.loading ? 'true' : undefined },
        h(Section, { title: pt(t, 'src.signals'),
          count: signalTotal,
          badge: signals.data && labelTotal > 0
            ? h('span', { className: 'sa-hint' }, pt(t, 'src.labelsSummary', {
              correct: Number(labelCounts.correct) || 0, falseWake: Number(labelCounts.false_wake) || 0,
              missedWake: Number(labelCounts.missed_wake) || 0 }))
            : null,
          action: h(Button, { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => { void signals.reload() } },
            pt(t, 'src.signalsRefresh')) },
          // Nothing recorded and nothing filtered: the rows of inputs would only be a wall of controls over an empty
          // list (ui review P1). The first message brings the filters back.
          signalTotal === 0 && !signalFilterActive
            ? null
            : h('div', { className: 'sa-filters' },
            h(Input, { value: sigQuery, placeholder: pt(t, 'src.signalSearchPlaceholder'), label: pt(t, 'src.signalSearch'),
              onChange: event => setSigQuery(event?.target?.value ?? '') }),
            h(Input, { value: sigRepoInput, placeholder: pt(t, 'src.signalRepoPlaceholder'), label: pt(t, 'src.signalRepo'),
              onChange: event => setSigRepoInput(event?.target?.value ?? '') }),
            h(Input, { value: sigReasonInput, placeholder: pt(t, 'src.signalReasonPlaceholder'), label: pt(t, 'src.signalReasonFilter'),
              onChange: event => setSigReasonInput(event?.target?.value ?? '') }),
            h(Input, { type: 'date', value: sigFrom, label: pt(t, 'src.signalFrom'),
              onChange: event => setSigFrom(event?.target?.value ?? '') }),
            h(Input, { type: 'date', value: sigTo, label: pt(t, 'src.signalTo'),
              onChange: event => setSigTo(event?.target?.value ?? '') }),
            h(SegmentedControl, { options: [
              { value: 'all', label: pt(t, 'decisionFilter.all') },
              ...Object.keys(SIGNAL_SHAPE).map(value => ({ value, label: pt(t, `src.signalStatus.${value}`) }))],
            value: sigStatus, onChange: setSigStatus, label: pt(t, 'src.signalFilter'), className: 'sa-segmented-chips' }),
            sigFrom && sigTo && sigFrom > sigTo
              ? h('p', { className: 'sa-hint', role: 'status', style: { flexBasis: '100%' } }, t('dateRangeReversed'))
              : null),
          signals.error ? h(ErrorState, { error: signals.error, onRetry: signals.reload }) : null,
          !signals.data
            ? signals.error ? null : h(Skeleton, { rows: 3 })
            : signalItems.length ? h(Fragment, null,
              h(RawSignalRows, { items: signalItems, onReplay: item => { void replay.run(item) },
                onLabel: (item, labelId) => { void label.run(item, labelId) }, busy: replay.busy, labelBusy: label.busy,
                focusId, onOpenTicket: id => leaveTo({ page: 'execution', id }) }),
              h('div', { className: 'sa-pagination' },
                h(Button, { variant: 'ghost', size: 'sm', disabled: sigOffset <= 0,
                  onClick: () => setSigOffset(Math.max(0, sigOffset - 20)) }, pt(t, 'src.prev')),
                h('span', { className: 'sa-hint', role: 'status' }, pt(t, 'src.signalPageInfo', {
                  from: sigOffset + 1, to: Math.min(sigOffset + signalItems.length, signalTotal ?? signalItems.length),
                  total: signalTotal ?? signalItems.length })),
                h(Button, { variant: 'ghost', size: 'sm', disabled: sigOffset + signalItems.length >= (signalTotal ?? signalItems.length),
                  onClick: () => setSigOffset(sigOffset + 20) }, pt(t, 'src.next'))))
              : h(Hint, null, pt(t, 'src.signalsEmpty')))),
    groups)
}
