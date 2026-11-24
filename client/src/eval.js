/* Eval page (contract §6.4): the engine's decision history. A kind filter (every kind, always: a chip that vanished at
   zero count moved the other chips under the pointer) and a 24h window switch sit on top; counts live in the section
   header, so the pills stay stable and only the list changes. Each row leads with the message it judged, then the
   shape-coded outcome as a leading tag, the plain-language reason, strength and rule hit count on one meta line, and
   folds open to the rule-by-rule result plus the raw decision. Data: GET engine/decisions?kind=&window= (host
   increments, contract §4). */

import { API, Icon, clampPageOffset, plainTitle } from "./util.js"
import { reasonLabel, when } from "./i18n.js"
import { Button, IconButton, InfoTip, Input, SegmentedControl, StatusIcon, Switch, Tag } from "./controls.js"
import { same, stay, usePanel } from "./api.js"
import { EmptyState, ErrorState, Folded, Hint, RawValue, Section, Skeleton, When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { initialPageQuery, remember, rememberPageState } from "./router.js"
import { useLiveResource } from "./live-model.js"
import { decisionKindView, liveShortId } from "./live-ui.js"
import { ThreadRuleRows } from "./thread-detail.js"
import { apply } from "./apply.js"
import { Fragment, React, h, useCallback, useEffect, useRef, useState } from "./react.js"
Object.assign(PAGE_TEXT, {
  'ev.intro': ['引擎的每次判断：结果、原因、强度与命中规则。', 'Every judgement the engine made: outcome, reason, strength and matched rules.'],
  'ev.title': ['评估记录', 'Evaluations'],
  'ev.filterLabel': ['决定类型', 'Decision kind'],
  'ev.windowLabel': ['时间窗口', 'Time window'],
  'ev.windowAll': ['全部时间', 'All time'],
  'ev.window24h': ['24 小时', 'Last 24h'],
  'ev.refresh': ['刷新记录', 'Refresh'],
  'ev.search': ['搜索记录', 'Search evaluations'],
  'ev.searchPlaceholder': ['消息、原因或工单标题…', 'Message, reason or Ticket title…'],
  'ev.repo': ['仓库', 'Repository'],
  'ev.repoPlaceholder': ['全部仓库', 'All repositories'],
  'ev.emptyTitle': ['还没有评估记录。', 'No evaluation yet.'],
  'ev.emptyHint': ['触发一条消息后，这里会记录引擎为什么做/不做。', 'Send a message to a watched group; this page records why the engine did or did not take the work.'],
  'ev.emptyAction': ['去看触发页', 'Open Triggers'],
  'ev.empty24Title': ['过去 24 小时没有评估记录。', 'No evaluation in the last 24 hours.'],
  'ev.empty24Hint': ['把时间窗口切回「全部时间」可以看更早的历史记录。', 'Switch the time window back to all time to see earlier decisions.'],
  'ev.emptyFilterTitle': ['这个筛选条件下没有记录。', 'No decision matches this filter.'],
  'ev.emptyFilterHint': ['换个决定类型，或清除筛选。', 'Try another decision kind, or clear the filter.'],
  'ev.clearFilter': ['清除筛选', 'Clear filters'],
  'ev.openTicket': ['查看工单', 'Open Ticket'],
  'ev.sameDecision': ['相同判断 {count} 次', 'Same judgement ×{count}'],
  'ev.dismiss': ['忽略', 'Dismiss'],
  'ev.dismissHint': ['引擎还没有「忽略未完成评估」的接口，这里只展示记录，不会发请求。',
    'The engine has no endpoint to dismiss an unfinished Eval yet; this row is read-only.'],
  'ev.noReason': ['没有记录原因。', 'No reason recorded.'],
  'ev.noPreview': ['（没有消息内容）', '(no message content)'],
  'ev.detail': ['决定详情', 'Decision detail'],
  'ev.raw': ['原始决定', 'Raw decision'],
  'ev.noRules': ['这次评估没有记录规则结果。', 'This Eval recorded no rule results.'],
  'ev.offsetClamped': ['你打开的位置从第 {from} 条开始，超出共 {total} 条的范围；已显示最后一页。',
    'The link pointed to item {from}, beyond the {total} decisions recorded; the last page is shown instead.'],
  'ev.shadow': ['模型 {p} · {verdict}', 'Model {p} · {verdict}'],
  'ev.shadowAccept': ['倾向接单', 'leans accept'],
  'ev.shadowReject': ['倾向忽略', 'leans ignore'],
  'ev.shadowUncertain': ['不确定', 'uncertain'],
  'ev.shadowError': ['模型失败', 'model failed'],
  'ev.shadowRisk': ['风险 {p}', 'risk {p}'],
  'ev.shadowHint': ['shadow 模式：模型意见只记录，接单仍由规则决定。',
    'Shadow mode: the model opinion is recorded only; the rules still decide intake.'],
  'ev.human': ['人工：{answer}', 'Human: {answer}'],
  // `recorded` means the reply was kept but no Ticket was started (the rule gate still refused it): say so in the tag
  // instead of showing "人工：接单" on a row that produced nothing (critique 2026-11-11).
  'ev.humanRecorded': ['人工：{answer}（仅记录）', 'Human: {answer} (recorded)'],
  'ev.humanAccept': ['接单', 'accept'],
  'ev.humanIgnore': ['忽略', 'ignore'],
  'ev.modelHint': ['hybrid 模式：模型判定参与接单（repo_task 自动、risky 拦截、其余转人工）。',
    'Hybrid mode: the model takes part in intake (repo_task opens, risky blocks, the rest goes to review).'],
  'ev.reason': ['原因筛选', 'Reason'],
  'ev.reasonPlaceholder': ['原因关键字，如 rate-limit', 'Reason keyword, e.g. rate-limit'],
  'ev.from': ['开始日期', 'From date'],
  'ev.to': ['结束日期', 'To date'],
  // The phone filter row folds its secondary inputs behind this toggle (ui review A-02) and the date pair gets visible
  // 从/至 words instead of two unlabelled 年/月/日 boxes (A-03).
  'ev.moreFilters': ['更多筛选', 'More filters'],
  'ev.fromShort': ['从', 'From'],
  'ev.toShort': ['至', 'To'],
  'ev.viewLabel': ['评估视图', 'View'],
  // Two segmented groups both started with "全部" (result kind and view), which read as the same control on one row
  // (ui review P2-3). The view group names the dimension instead.
  'ev.viewAll': ['全部视图', 'All views'],
  'ev.viewDivergence': ['模型分歧', 'Model divergence'],
  'ev.viewOverride': ['人工改判', 'Human override'],
  'ev.pageInfo': ['{from}–{to} / 共 {total} 条', '{from}–{to} of {total}'],
  'ev.prev': ['上一页', 'Previous'],
  'ev.next': ['下一页', 'Next'],
  'ev.signal': ['原始信号', 'Signal'],
  'ev.thread': ['线程', 'Thread'],
  'ev.run': ['运行', 'Run'],
})

/** Endpoint `kind` values in display order; labels come from the shared decision vocabulary. */
export const EVAL_KINDS = ['all', 'accept', 'reopen', 'stop', 'ignore', 'unavailable']
export const evalKindLabel = (t, kind) => kind === 'all' ? pt(t, 'decisionFilter.all') : pt(t, `decision.${kind}`)

/** Strength vocabulary is closed; an unknown value falls back to the raw string instead of a missing key. */
export const EVAL_STRENGTHS = ['explicit', 'inferred']

/** Locale-correct percent formatting for the model probability (P2): `Intl` instead of hand-built `${round(p*100)}%`. */
export const EVAL_PERCENT_FORMAT = {
  en: new Intl.NumberFormat('en', { style: 'percent', maximumFractionDigits: 0 }),
  zh: new Intl.NumberFormat('zh-CN', { style: 'percent', maximumFractionDigits: 0 }),
}
export function evalPercent(t, value) {
  return (EVAL_PERCENT_FORMAT[t.lang] ?? EVAL_PERCENT_FORMAT.en).format(value)
}

/** Human label for the decision model's shadow verdict; unknown values stay visible as the raw string. */
export function evalShadowVerdict(t, verdict) {
  if (verdict === 'accept') return pt(t, 'ev.shadowAccept')
  if (verdict === 'reject') return pt(t, 'ev.shadowReject')
  if (verdict === 'uncertain') return pt(t, 'ev.shadowUncertain')
  return typeof verdict === 'string' ? verdict : ''
}

/** One tag per decision: the model's calibrated probability + the action it would have taken under the thresholds. */
export function evalModelTag(t, decision) {
  const shadow = decision?.shadow
  const model = shadow ?? decision?.model
  if (!model || typeof model !== 'object') return null
  const title = [pt(t, shadow ? 'ev.shadowHint' : 'ev.modelHint'), model.model, model.category, model.questions]
    .filter(Boolean).join(' · ')
  const risk = typeof model.riskP === 'number'
    ? ` · ${pt(t, 'ev.shadowRisk', { p: evalPercent(t, model.riskP) })}` : ''
  if (model.status !== 'ok') return h(Tag, { tone: 'quiet', title }, pt(t, 'ev.shadowError'))
  const probability = typeof model.p === 'number' ? evalPercent(t, model.p) : '?'
  const tone = model.verdict === 'accept' ? 'info' : model.verdict === 'reject' ? 'warning' : 'quiet'
  return h(Tag, { tone, title: `${title}${risk}` },
    pt(t, 'ev.shadow', { p: probability, verdict: evalShadowVerdict(t, model.verdict) }))
}

/** One message excerpt for the row title: the host's decision preview, or — for payloads/histories whose Trigger text
    is gone — the request title the reason already carries. Empty only when neither exists. */
export function evalMessagePreview(decision) {
  const preview = typeof decision.preview === 'string' ? decision.preview.trim() : ''
  if (preview) return preview
  return (Array.isArray(decision.reason) ? decision.reason : decision.reason ? [decision.reason] : [])
    .map(item => item && typeof item === 'object' && typeof item.values?.text === 'string' ? item.values.text.trim() : '')
    .filter(Boolean)
    .join(' / ')
}

/** Visible identity of a decision: what the row can show. Two decisions with the same identity are one judgement
    repeated (a re-evaluation or a duplicate accept), so the list folds them into one row with ×N instead of printing
    two rows the operator cannot tell apart. */
export function evalGroupKey(decision) {
  const rules = Array.isArray(decision.rules) ? decision.rules : []
  const hit = rules.filter(rule => rule.matched).length
  // A request can be judged more than once (re-evaluation, duplicate accept) and produce different Tickets. The group
  // identity is the request + judgement, not the Ticket id, so those rows collapse and every Ticket stays visible in
  // the row's ticket list instead of being hidden behind a separate ×N (C32).
  // A different signal, model opinion or human decision is different evidence, even when kind/reason/strength match.
  // Folding those rows hid the evidence behind the first record (review P2 AC-06).
  const model = decision.shadow ?? decision.model
  const human = decision.humanReview
  return JSON.stringify([decision.kind, decision.preview, decision.threadKey,
    decision.strength, hit, rules.length - hit, decision.reason ?? null,
    decision.signalId ?? null,
    model ? [model.status ?? null, model.verdict ?? null, model.model ?? null, model.riskP ?? null] : null,
    human ? [human.code ?? null, human.outcome ?? null, human.answer ?? null] : null])
}

/** Newest-first groups of decisions that differ only by time; order follows the first (newest) occurrence. */
export function groupEvalDecisions(items) {
  const groups = new Map()
  for (const decision of items) {
    const key = evalGroupKey(decision)
    const group = groups.get(key)
    if (group) { group.count += 1; group.decisions.push(decision) }
    else groups.set(key, { decision, count: 1, decisions: [decision] })

  }
  return [...groups.values()].map(group => ({ ...group,
    ticketIds: [...new Set(group.decisions.map(decision => decision.ticketId).filter(Boolean))] }))
}

/** One decision row: the message it judged as the title, the shape-coded outcome as a leading tag, then reason,
    strength, rule hit count and the Ticket link on one meta line, followed by the folded rule-by-rule result. */
export function evalDecisionRow(t, navigate, decision, count = 1, ticketIds = [], runLinks = []) {
  const view = decisionKindView(decision)
  const label = pt(t, view.labelKey)
  const kindLabel = label === view.labelKey ? String(view.kind) : label
  const rules = Array.isArray(decision.rules) ? decision.rules : []
  const hit = rules.filter(rule => rule.matched).length
  const miss = rules.length - hit
  const strength = decision.strength
    ? EVAL_STRENGTHS.includes(decision.strength) ? pt(t, `strength.${decision.strength}`) : String(decision.strength)
    : ''
  const reasons = Array.isArray(decision.reason) ? decision.reason : decision.reason ? [decision.reason] : []
  const reason = reasonLabel(t, decision.reason)
  const contextOnly = reasons.some(item => item && typeof item === 'object' && item.code === 'contextOnly')
  const preview = evalMessagePreview(decision)
  const unavailable = view.kind === 'unavailable'
  // The visible hint is the accessible description for the (disabled) dismiss action, so the reason is not title-only (A3).
  const dismissHintId = `sa-eval-dismiss-${decision.id ?? 'row'}`
  return h('li', { key: decision.id },
    h('div', { className: 'sa-row' },
      h(StatusIcon, { state: view.state, size: 16 }),
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h(Tag, { tone: view.tone }, kindLabel),
          count > 1 ? h(Tag, { tone: 'quiet', title: pt(t, 'ev.sameDecision', { count }) }, `×${count}`) : null,
          // One line, clipped to the space the tag leaves; flex-grow keeps the tag from being squeezed by long text.
          h('span', { style: { flex: '1 1 0%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            plainTitle(preview) || pt(t, 'ev.noPreview'))),
        h('div', { className: 'sa-row-meta' },
          // In-app navigation has no URL to point at, so these are real buttons, not `<a href="#">` fake links (A4).
          decision.threadKey
            ? h('button', { type: 'button', className: 'sa-mono sa-textlink',
              title: `${pt(t, 'ev.thread')} · ${decision.threadKey}`,
              onClick: () => navigate({ page: 'trigger', id: decision.threadKey }) },
            liveShortId(decision.threadKey, 10)) : null,
          decision.signalId
            ? h('button', { type: 'button', className: 'sa-mono sa-textlink',
              title: `${pt(t, 'ev.signal')} · ${decision.signalId}`,
              onClick: () => navigate({ page: 'source', id: decision.signalId }) },
            liveShortId(decision.signalId, 10)) : null,
          h('span', null, reason || pt(t, 'ev.noReason')),
          strength ? h(Tag, { tone: 'quiet' }, strength) : null,
          rules.length ? h('span', null, pt(t, 'thread.rulesHit', { hit, miss })) : null,
          decision.humanReview
            ? h(Tag, { tone: decision.humanReview.outcome === 'recorded' ? 'warning' : 'quiet',
              title: `${decision.humanReview.code} · ${decision.humanReview.outcome ?? ''}` },
              pt(t, decision.humanReview.outcome === 'recorded' ? 'ev.humanRecorded' : 'ev.human',
                { answer: pt(t, decision.humanReview.answer === 'accept' ? 'ev.humanAccept' : 'ev.humanIgnore') }))
            : null,
          evalModelTag(t, decision),
          decision.at ? h(When, { at: decision.at }) : null,
          ticketIds.length
            ? h(Fragment, null,
              ticketIds.map(id => h('button', { key: id, type: 'button', className: 'sa-mono sa-textlink', title: id,
                onClick: () => navigate({ page: 'execution', id }) }, liveShortId(id, 8))),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate({ page: 'execution', id: ticketIds[0] }) },
                pt(t, 'ev.openTicket')))
            : null,
          runLinks.length
            ? h('span', { className: 'sa-row-meta' },
              runLinks.map(link => h('button', { key: link.runId ?? link.ticketId, type: 'button',
                className: 'sa-mono sa-textlink',
                title: link.runId ? `${pt(t, 'ev.run')} · ${link.runId}` : link.ticketId,
                onClick: () => navigate({ page: 'execution', id: link.ticketId, ...(link.runId ? { run: link.runId } : {}) }) },
              link.runId ? `${pt(t, 'ev.run')} ${liveShortId(link.runId, 8)}` : liveShortId(link.ticketId, 8))))
            : null,
          contextOnly ? h('span', null, t('contextOnlyHint')) : null),
        unavailable ? h('p', { id: dismissHintId, className: 'sa-hint' }, pt(t, 'ev.dismissHint')) : null,
        h(Folded, { summary: rules.length ? pt(t, 'thread.rulesDetail') : pt(t, 'ev.detail') },
          rules.length ? h(ThreadRuleRows, { rules }) : h(Hint, null, pt(t, 'ev.noRules')),
          h(RawValue, { label: pt(t, 'ev.raw'), json: decision }))),
      unavailable ? h('div', { className: 'sa-row-actions' },
        h(Button, { variant: 'ghost', size: 'sm', disabled: true, 'aria-describedby': dismissHintId }, pt(t, 'ev.dismiss')),
        h(InfoTip, { text: pt(t, 'ev.dismissHint'), warn: true })) : null))
}

/** Empty state depends on whether there is no history at all, an empty 24h window, or a filter that matched nothing.
 *  An active filter wins over the counts: "模型分歧" (or any kind/repo/reason/search filter) with zero rows is a filter
 *  result, not an empty history, and saying "还没有评估记录…触发一条消息后" there sent people looking for messages that
 *  had already been recorded (U-07). */
export function evalEmptyState(t, navigate, counts, kind, range, setKind, setRange, clearAll, activeFilters = false) {
  const noRecords = (counts.all ?? 0) === 0
  if (activeFilters) {
    return h(EmptyState, { icon: 'filter', title: pt(t, 'ev.emptyFilterTitle'), hint: pt(t, 'ev.emptyFilterHint'),
      action: h(Button, { variant: 'outline', size: 'sm', onClick: () => { clearAll(); setKind('all'); setRange('all') } }, pt(t, 'ev.clearFilter')) })
  }
  if (noRecords && kind === 'all' && range === 'all') {
    return h(EmptyState, { icon: 'decision', title: pt(t, 'ev.emptyTitle'), hint: pt(t, 'ev.emptyHint'),
      action: h(Button, { variant: 'outline', size: 'sm', onClick: () => navigate({ page: 'trigger' }) }, pt(t, 'ev.emptyAction')) })
  }
  if (noRecords && range === '24h') {
    return h(EmptyState, { icon: 'clock', title: pt(t, 'ev.empty24Title'), hint: pt(t, 'ev.empty24Hint'),
      action: h(Button, { variant: 'outline', size: 'sm', onClick: () => setRange('all') }, pt(t, 'ev.windowAll')) })
  }
  return h(EmptyState, { icon: 'filter', title: pt(t, 'ev.emptyFilterTitle'), hint: pt(t, 'ev.emptyFilterHint'),
    action: h(Button, { variant: 'outline', size: 'sm', onClick: () => { clearAll(); setKind('all'); setRange('all') } }, pt(t, 'ev.clearFilter')) })
}

export const EVAL_URL_KEYS = { kind: 'evalKind', range: 'evalWindow', q: 'evalQ', repo: 'evalRepo',
  reason: 'evalReason', from: 'evalFrom', to: 'evalTo', view: 'evalView', offset: 'evalOffset' }
export const EVAL_PAGE_SIZE = 25
export const EVAL_SCROLL_KEY = 'superagent-panel/eval-scroll'
export const EVAL_VIEWS = ['all', 'divergence', 'override']
export const EVAL_RANGES = ['all', '24h']

/** Read one deep link back into the Eval filters (AC-07) without touching the host's own route parameters. */
const EVAL_DEFAULTS = { kind: 'all', range: 'all', q: '', repo: '', reason: '', from: '', to: '', view: 'all', offset: 0 }
export function evalUrlState(search) {
  try {
    const params = search ?? new URLSearchParams(window.location.search)
    const offset = Number(params.get(EVAL_URL_KEYS.offset) ?? 0)
    const kind = params.get(EVAL_URL_KEYS.kind)
    const range = params.get(EVAL_URL_KEYS.range)
    return { kind: EVAL_KINDS.includes(kind) ? kind : 'all', range: EVAL_RANGES.includes(range) ? range : 'all',
      q: params.get(EVAL_URL_KEYS.q) || '', repo: params.get(EVAL_URL_KEYS.repo) || '',
      reason: params.get(EVAL_URL_KEYS.reason) || '', from: params.get(EVAL_URL_KEYS.from) || '',
      to: params.get(EVAL_URL_KEYS.to) || '',
      view: EVAL_VIEWS.includes(params.get(EVAL_URL_KEYS.view)) ? params.get(EVAL_URL_KEYS.view) : 'all',
      offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0 }
  } catch { return { ...EVAL_DEFAULTS } }
}

export function rememberEvalFilters(next) {
  try {
    const url = new URL(window.location.href)
    for (const [key, param] of Object.entries(EVAL_URL_KEYS)) {
      const value = next[key]
      if (!value || value === 'all' || value === 0) url.searchParams.delete(param)
      else url.searchParams.set(param, String(value))
    }
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
  } catch { /* a host without history still keeps the in-memory filters */ }
}

/** A date input is local midnight; the API compares ISO instants, so widen the end date to its last millisecond. */
export function dateBound(value, end = false) {
  if (!value) return ''
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

/** R2-14: an offset from a pasted link (or a shrinking result set) can point past the end. Returns the last page's
    offset when that happens, and `undefined` when the requested offset is fine. */
export function clampEvalOffset(offset, total, pageSize = EVAL_PAGE_SIZE) {
  return clampPageOffset(offset, total, pageSize)
}

export function LiveEvalPage() {
  const { t, navigate } = usePanel()
  // R2-01/R2-08/R2-15: the URL (shared or reloaded link, offset included) wins; otherwise the tab's remembered slice,
  // with the load-time query string covering a host that consumed its own parameter before the panel mounted.
  const initial = useRef(initialPageQuery('eval', evalUrlState, EVAL_DEFAULTS))
  const [kind, setKind] = useState(initial.current.kind)
  const [range, setRange] = useState(initial.current.range)
  const [query, setQuery] = useState(initial.current.q)
  const [repo, setRepo] = useState(initial.current.repo)
  const [reason, setReason] = useState(initial.current.reason)
  const [from, setFrom] = useState(initial.current.from)
  const [to, setTo] = useState(initial.current.to)
  const [view, setView] = useState(initial.current.view)
  // Only meaningful on a phone, where the secondary filters are folded (style.js shows the toggle at ≤600).
  const [moreOpen, setMoreOpen] = useState(false)
  const [offset, setOffset] = useState(initial.current.offset)
  const [q, setQ] = useState(initial.current.q)
  const [repoFilter, setRepoFilter] = useState(initial.current.repo)
  const [reasonFilter, setReasonFilter] = useState(initial.current.reason)
  // Debounce only the free-text fields: one request per pause, while selects apply immediately.
  useEffect(() => {
    const timer = setTimeout(() => { setQ(query); setRepoFilter(repo); setReasonFilter(reason) }, 300)
    return () => clearTimeout(timer)
  }, [query, repo, reason])
  // Any filter change starts at the first page; otherwise a stale offset can land past the new total. The first mount
  // must keep the page restored from the URL, and a popstate restore must not be reset to page 1 (review P1 AC-07).
  const firstFilterRun = useRef(true)
  const restoringFilters = useRef(false)
  // Mirror for the []-deps popstate listener: comparing inside that closure would always see mount-time values.
  const currentSlice = useRef({ kind, range, q, repo: repoFilter, reason: reasonFilter, from, to, view })
  currentSlice.current = { kind, range, q, repo: repoFilter, reason: reasonFilter, from, to, view }
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return }
    // The popstate restore is consumed here, not by a timer: a later passive-effect flush could otherwise treat the
    // restored filters as a user change and throw the restored page away.
    if (restoringFilters.current) { restoringFilters.current = false; return }
    setOffset(0)
  }, [kind, range, q, repoFilter, reasonFilter, from, to, view])
  useEffect(() => {
    rememberEvalFilters({ kind, range, q, repo: repoFilter, reason: reasonFilter, from, to, view, offset })
    // R2-08: the URL only holds the current page's parameters (U-08), so the tab also remembers the slice.
    rememberPageState('eval', { kind, range, q, repo: repoFilter, reason: reasonFilter, from, to, view, offset })
  }, [kind, range, q, repoFilter, reasonFilter, from, to, view, offset])
  // Back/forward restores the filters from the URL; the host route keeps working because only our own params move.
  useEffect(() => {
    const restore = () => {
      const next = evalUrlState()
      // Only a slice that really changes is a restore; a same-URL popstate used to leave the flag set, so the next real
      // filter change skipped its reset to page 1 (review P3).
      const now = currentSlice.current
      if (next.kind !== now.kind || next.range !== now.range || next.q !== now.q || next.repo !== now.repo
        || next.reason !== now.reason || next.from !== now.from || next.to !== now.to || next.view !== now.view) {
        restoringFilters.current = true
      }
      setKind(next.kind); setRange(next.range); setQuery(next.q); setQ(next.q)
      setRepo(next.repo); setRepoFilter(next.repo); setReason(next.reason); setReasonFilter(next.reason)
      setFrom(next.from); setTo(next.to); setView(next.view); setOffset(next.offset)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  const { data, error, loading, reload } = useLiveResource('engine/decisions',
    { kind, window: range, q, repo: repoFilter, reason: reasonFilter,
      from: dateBound(from), to: dateBound(to, true), view, offset, limit: EVAL_PAGE_SIZE })
  const refresh = useCallback(() => { void reload() }, [reload])
  // Opening a Ticket/thread/signal leaves the page; remember where the list was so going back lands on the same row.
  const openFromEval = useCallback(route => {
    try {
      // The panel scrolls inside `.sa-scroll`, not the window; saving window.scrollY always restored 0 (review P1 AC-07).
      const scroller = document.querySelector('.sa-scroll')
      const y = scroller ? scroller.scrollTop : window.scrollY
      sessionStorage.setItem(EVAL_SCROLL_KEY, String(y))
    } catch { /* private mode */ }
    navigate(route)
  }, [navigate])
  const restoredScroll = useRef(false)
  useEffect(() => {
    if (restoredScroll.current || !data) return
    restoredScroll.current = true
    try {
      const y = Number(sessionStorage.getItem(EVAL_SCROLL_KEY) ?? 0)
      if (Number.isFinite(y) && y > 0) window.requestAnimationFrame(() => {
        const scroller = document.querySelector('.sa-scroll')
        if (scroller) scroller.scrollTop = y
        else window.scrollTo(0, y)
      })
    } catch { /* private mode */ }
  }, [data])
  // R2-14: an offset from a pasted link (or a shrinking result set) can point past the end. The list then rendered a
  // "filter matched nothing" empty state with no pagination, which is a lie: the filters are fine, the page is not.
  // Clamp to the last page once the total is known and say what happened instead.
  const loadedTotal = Number.isFinite(data?.total) ? data.total : (Array.isArray(data?.items) ? data.items.length : 0)
  // The note belongs to the offset that produced it: `from` is what the link asked for, `at` the page shown. A filter
  // change resets `offset` to 0, which no longer equals `at`, so the note clears itself instead of hanging above a
  // list that is already correct (review P3).
  const [clamped, setClamped] = useState(undefined)
  useEffect(() => {
    const lastPage = clampEvalOffset(offset, loadedTotal)
    if (!data || lastPage === undefined) return
    setClamped({ from: offset, at: lastPage })
    setOffset(lastPage)
  }, [data, loadedTotal, offset])
  const goOffset = next => { setClamped(undefined); setOffset(next) }
  if (loading && !data) return h(Skeleton, { rows: 5 })
  if (!data) return h(ErrorState, { error, onRetry: reload })

  const items = Array.isArray(data.items) ? data.items : []
  const counts = data.counts ?? {}
  const total = Number.isFinite(data.total) ? data.total : items.length
  const pageFrom = items.length ? offset + 1 : 0
  const pageTo = Math.min(offset + items.length, total)
  const hasPrev = offset > 0
  const hasNext = offset + items.length < total
  // Every kind keeps a pill even at zero: hiding it re-laid the row and slid the remaining chips under the pointer, so
  // "全部/接单/忽略" moved as the counts changed (user report 2026-11-23). A zero-count kind now selects an empty list
  // with its own empty state instead of disappearing. Counts stay in the section header, not in the pills (C11).
  const kindOptions = EVAL_KINDS.map(value => ({ value, label: evalKindLabel(t, value) }))

  return h(Fragment, null,
    h(Hint, null, pt(t, 'ev.intro')),
    h('div', { className: 'sa-filters' },
      // Three segmented rows in a single line read as one long run of chips: each keeps a visible caption on wide
      // layouts (the hidden below 760 is CSS, the accessible name still comes from `label`) — ui review P2.
      h('span', { className: 'sa-filter-group' },
        h('span', { className: 'sa-filter-group-label', 'aria-hidden': 'true' }, pt(t, 'ev.filterLabel')),
        h(SegmentedControl, { options: kindOptions, value: kind, onChange: setKind, label: pt(t, 'ev.filterLabel'),
          className: 'sa-segmented-chips' })),
      h('span', { className: 'sa-control-divider', 'aria-hidden': 'true' }),
      h('span', { className: 'sa-filter-group' },
        h('span', { className: 'sa-filter-group-label', 'aria-hidden': 'true' }, pt(t, 'ev.windowLabel')),
        h(SegmentedControl, { options: [{ value: 'all', label: pt(t, 'ev.windowAll') }, { value: '24h', label: pt(t, 'ev.window24h') }],
          value: range, onChange: setRange, label: pt(t, 'ev.windowLabel'), className: 'sa-segmented-chips' })),
      h('span', { className: 'sa-filter-group' },
        h('span', { className: 'sa-filter-group-label', 'aria-hidden': 'true' }, pt(t, 'ev.viewLabel')),
        h(SegmentedControl, { options: EVAL_VIEWS.map(value => ({ value, label: pt(t, `ev.view${value === 'all' ? 'All' : value === 'divergence' ? 'Divergence' : 'Override'}`) })),
          value: view, onChange: setView, label: pt(t, 'ev.viewLabel'), className: 'sa-segmented-chips' })),
      h(Input, { value: query, placeholder: pt(t, 'ev.searchPlaceholder'), label: pt(t, 'ev.search'),
        onChange: event => setQuery(event?.target?.value ?? '') }),
      h('button', { type: 'button', className: 'sa-textlink sa-filter-toggle',
        'aria-expanded': moreOpen ? 'true' : 'false',
        onClick: () => setMoreOpen(!moreOpen) }, pt(t, 'ev.moreFilters')),
      h('div', { className: 'sa-filter-extra', 'data-open': moreOpen ? 'true' : 'false' },
        h(Input, { value: repo, placeholder: pt(t, 'ev.repoPlaceholder'), label: pt(t, 'ev.repo'),
          onChange: event => setRepo(event?.target?.value ?? '') }),
        h(Input, { value: reason, placeholder: pt(t, 'ev.reasonPlaceholder'), label: pt(t, 'ev.reason'),
          onChange: event => setReason(event?.target?.value ?? '') }),
        h('div', { className: 'sa-date-range' },
          h('span', { className: 'sa-hint' }, pt(t, 'ev.fromShort')),
          h(Input, { type: 'date', value: from, label: pt(t, 'ev.from'),
            onChange: event => setFrom(event?.target?.value ?? '') }),
          h('span', { className: 'sa-hint' }, pt(t, 'ev.toShort')),
          h(Input, { type: 'date', value: to, label: pt(t, 'ev.to'),
            onChange: event => setTo(event?.target?.value ?? '') }))),
      h('div', { className: 'sa-actions' },
        h(IconButton, { icon: h(Icon, { name: 'refresh', size: 16 }), label: pt(t, 'ev.refresh'), title: pt(t, 'ev.refresh'), onClick: refresh }))),
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    h(Section, { title: pt(t, 'ev.title'), count: total },
      clamped && offset === clamped.at
        ? h(Hint, null, pt(t, 'ev.offsetClamped', { from: clamped.from + 1, total }))
        : null,
      items.length
        ? h(Fragment, null,
          h('ul', { className: 'sa-list' }, groupEvalDecisions(items).map(group =>
            evalDecisionRow(t, openFromEval, group.decision, group.count, group.ticketIds,
              group.decision.runs ?? []))),
          h('div', { className: 'sa-pagination' },
            h(Button, { variant: 'ghost', size: 'sm', disabled: !hasPrev,
              onClick: () => goOffset(Math.max(0, offset - EVAL_PAGE_SIZE)) }, pt(t, 'ev.prev')),
            h('span', { className: 'sa-hint', role: 'status' },
              pt(t, 'ev.pageInfo', { from: pageFrom, to: pageTo, total })),
            h(Button, { variant: 'ghost', size: 'sm', disabled: !hasNext,
              onClick: () => goOffset(offset + EVAL_PAGE_SIZE) }, pt(t, 'ev.next'))))
        : evalEmptyState(t, openFromEval, counts, kind, range, setKind, setRange, () => {
          setQuery(''); setRepo(''); setReason(''); setFrom(''); setTo(''); setView('all')
          setQ(''); setRepoFilter(''); setReasonFilter(''); setOffset(0)
        }, kind !== 'all' || view !== 'all' || Boolean(query.trim() || repoFilter || reasonFilter || from || to))))
}
