/* Eval page (contract §6.4): the engine's decision history. A kind filter (all, the non-zero kinds and the active kind;
   counts live only in the section header, so no zero-count pill is rendered) and a 24h window switch sit on top; each
   row leads with the message it judged, then the shape-coded outcome as a leading tag, the plain-language reason,
   strength and rule hit count on one meta line, and folds open to the rule-by-rule result plus the raw decision.
   Data: GET engine/decisions?kind=&window= (host increments, contract §4). */

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
  'ev.more': ['共 {total} 条，只显示最近 {shown} 条。', '{total} decisions in total; showing the latest {shown}.'],
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
  'ev.viewLabel': ['评估视图', 'View'],
  'ev.viewAll': ['全部', 'All'],
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
const EVAL_KINDS = ['all', 'accept', 'reopen', 'stop', 'ignore', 'unavailable']
const evalKindLabel = (t, kind) => kind === 'all' ? pt(t, 'decisionFilter.all') : pt(t, `decision.${kind}`)

/** Strength vocabulary is closed; an unknown value falls back to the raw string instead of a missing key. */
const EVAL_STRENGTHS = ['explicit', 'inferred']

/** Human label for the decision model's shadow verdict; unknown values stay visible as the raw string. */
function evalShadowVerdict(t, verdict) {
  if (verdict === 'accept') return pt(t, 'ev.shadowAccept')
  if (verdict === 'reject') return pt(t, 'ev.shadowReject')
  if (verdict === 'uncertain') return pt(t, 'ev.shadowUncertain')
  return typeof verdict === 'string' ? verdict : ''
}

/** One tag per decision: the model's calibrated probability + the action it would have taken under the thresholds. */
function evalModelTag(t, decision) {
  const shadow = decision?.shadow
  const model = shadow ?? decision?.model
  if (!model || typeof model !== 'object') return null
  const title = [pt(t, shadow ? 'ev.shadowHint' : 'ev.modelHint'), model.model, model.category, model.questions]
    .filter(Boolean).join(' · ')
  const risk = typeof model.riskP === 'number'
    ? ` · ${pt(t, 'ev.shadowRisk', { p: `${Math.round(model.riskP * 100)}%` })}` : ''
  if (model.status !== 'ok') return h(Tag, { tone: 'quiet', title }, pt(t, 'ev.shadowError'))
  const probability = typeof model.p === 'number' ? `${Math.round(model.p * 100)}%` : '?'
  const tone = model.verdict === 'accept' ? 'info' : model.verdict === 'reject' ? 'warning' : 'quiet'
  return h(Tag, { tone, title: `${title}${risk}` },
    pt(t, 'ev.shadow', { p: probability, verdict: evalShadowVerdict(t, model.verdict) }))
}

/** One message excerpt for the row title: the host's decision preview, or — for payloads/histories whose Trigger text
    is gone — the request title the reason already carries. Empty only when neither exists. */
function evalMessagePreview(decision) {
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
function evalGroupKey(decision) {
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
function groupEvalDecisions(items) {
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
function evalDecisionRow(t, navigate, decision, count = 1, ticketIds = [], runLinks = []) {
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
  return h('li', { key: decision.id },
    h('div', { className: 'sa-row' },
      h(StatusIcon, { state: view.state, size: 16 }),
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h(Tag, { tone: view.tone }, kindLabel),
          count > 1 ? h(Tag, { tone: 'quiet', title: pt(t, 'ev.sameDecision', { count }) }, `×${count}`) : null,
          // One line, clipped to the space the tag leaves; flex-grow keeps the tag from being squeezed by long text.
          h('span', { style: { flex: '1 1 0%', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            preview || pt(t, 'ev.noPreview'))),
        h('div', { className: 'sa-row-meta' },
          decision.threadKey
            ? h('a', { href: '#', className: 'sa-mono sa-inline-link', title: `${pt(t, 'ev.thread')} · ${decision.threadKey}`,
              onClick: event => { event.preventDefault(); navigate({ page: 'trigger', id: decision.threadKey }) } },
            liveShortId(decision.threadKey, 10)) : null,
          decision.signalId
            ? h('a', { href: '#', className: 'sa-mono sa-inline-link', title: `${pt(t, 'ev.signal')} · ${decision.signalId}`,
              onClick: event => { event.preventDefault(); navigate({ page: 'source', id: decision.signalId }) } },
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
              ticketIds.map(id => h('a', { key: id, href: '#', className: 'sa-mono sa-inline-link', title: id,
                onClick: event => { event.preventDefault(); navigate({ page: 'execution', id }) } }, liveShortId(id, 8))),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate({ page: 'execution', id: ticketIds[0] }) },
                pt(t, 'ev.openTicket')))
            : null,
          runLinks.length
            ? h('span', { className: 'sa-row-meta' },
              runLinks.map(link => h('a', { key: link.runId ?? link.ticketId, href: '#', className: 'sa-mono sa-inline-link',
                title: link.runId ? `${pt(t, 'ev.run')} · ${link.runId}` : link.ticketId,
                onClick: event => { event.preventDefault()
                  navigate({ page: 'execution', id: link.ticketId, ...(link.runId ? { run: link.runId } : {}) }) } },
              link.runId ? `${pt(t, 'ev.run')} ${liveShortId(link.runId, 8)}` : liveShortId(link.ticketId, 8))))
            : null,
          contextOnly ? h('span', null, t('contextOnlyHint')) : null),
        unavailable ? h('p', { className: 'sa-hint' }, pt(t, 'ev.dismissHint')) : null,
        h(Folded, { summary: rules.length ? pt(t, 'thread.rulesDetail') : pt(t, 'ev.detail') },
          rules.length ? h(ThreadRuleRows, { rules }) : h(Hint, null, pt(t, 'ev.noRules')),
          h(RawValue, { label: pt(t, 'ev.raw'), json: decision }))),
      unavailable ? h('div', { className: 'sa-row-actions' },
        h(Button, { variant: 'ghost', size: 'sm', disabled: true, title: pt(t, 'ev.dismissHint') }, pt(t, 'ev.dismiss')),
        h(InfoTip, { text: pt(t, 'ev.dismissHint'), warn: true })) : null))
}

/** Empty state depends on whether there is no history at all, an empty 24h window, or an empty kind filter. */
function evalEmptyState(t, navigate, counts, kind, range, setKind, setRange, clearAll) {
  const noRecords = (counts.all ?? 0) === 0
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

const EVAL_URL_KEYS = { kind: 'evalKind', range: 'evalWindow', q: 'evalQ', repo: 'evalRepo',
  reason: 'evalReason', from: 'evalFrom', to: 'evalTo', view: 'evalView', offset: 'evalOffset' }
const EVAL_PAGE_SIZE = 25
const EVAL_SCROLL_KEY = 'superagent-panel/eval-scroll'
const EVAL_VIEWS = ['all', 'divergence', 'override']

/** Read one deep link back into the Eval filters (AC-07) without touching the host's own route parameters. */
function evalUrlState() {
  try {
    const params = new URLSearchParams(window.location.search)
    const offset = Number(params.get(EVAL_URL_KEYS.offset) ?? 0)
    return { kind: params.get(EVAL_URL_KEYS.kind) || 'all', range: params.get(EVAL_URL_KEYS.range) || 'all',
      q: params.get(EVAL_URL_KEYS.q) || '', repo: params.get(EVAL_URL_KEYS.repo) || '',
      reason: params.get(EVAL_URL_KEYS.reason) || '', from: params.get(EVAL_URL_KEYS.from) || '',
      to: params.get(EVAL_URL_KEYS.to) || '',
      view: EVAL_VIEWS.includes(params.get(EVAL_URL_KEYS.view)) ? params.get(EVAL_URL_KEYS.view) : 'all',
      offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0 }
  } catch { return { kind: 'all', range: 'all', q: '', repo: '', reason: '', from: '', to: '', view: 'all', offset: 0 } }
}

function rememberEvalFilters(next) {
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
function dateBound(value, end = false) {
  if (!value) return ''
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

function LiveEvalPage() {
  const { t, navigate } = usePanel()
  const initial = useRef(evalUrlState())
  const [kind, setKind] = useState(initial.current.kind)
  const [range, setRange] = useState(initial.current.range)
  const [query, setQuery] = useState(initial.current.q)
  const [repo, setRepo] = useState(initial.current.repo)
  const [reason, setReason] = useState(initial.current.reason)
  const [from, setFrom] = useState(initial.current.from)
  const [to, setTo] = useState(initial.current.to)
  const [view, setView] = useState(initial.current.view)
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
  useEffect(() => {
    if (firstFilterRun.current) { firstFilterRun.current = false; return }
    if (restoringFilters.current) { restoringFilters.current = false; return }
    setOffset(0)
  }, [kind, range, q, repoFilter, reasonFilter, from, to, view])
  useEffect(() => {
    rememberEvalFilters({ kind, range, q, repo: repoFilter, reason: reasonFilter, from, to, view, offset })
  }, [kind, range, q, repoFilter, reasonFilter, from, to, view, offset])
  // Back/forward restores the filters from the URL; the host route keeps working because only our own params move.
  useEffect(() => {
    const restore = () => {
      const next = evalUrlState()
      restoringFilters.current = true
      setKind(next.kind); setRange(next.range); setQuery(next.q); setQ(next.q)
      setRepo(next.repo); setRepoFilter(next.repo); setReason(next.reason); setReasonFilter(next.reason)
      setFrom(next.from); setTo(next.to); setView(next.view); setOffset(next.offset)
      // If the restored URL equals the current state no filter effect runs; clear the guard so the next real change
      // still resets the page.
      setTimeout(() => { restoringFilters.current = false }, 0)
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
  if (loading && !data) return h(Skeleton, { rows: 5 })
  if (!data) return h(ErrorState, { error, onRetry: reload })

  const items = Array.isArray(data.items) ? data.items : []
  const counts = data.counts ?? {}
  const total = Number.isFinite(data.total) ? data.total : items.length
  const pageFrom = items.length ? offset + 1 : 0
  const pageTo = Math.min(offset + items.length, total)
  const hasPrev = offset > 0
  const hasNext = offset + items.length < total
  // A kind earns a pill only when it can produce a list: `all`, every non-zero kind, and the active kind (so switching
  // the window never traps a selection on a hidden kind). Counts stay in the section header, not in the pills (C11).
  const kindOptions = EVAL_KINDS
    .filter(value => value === 'all' || value === kind || (counts[value] ?? 0) > 0)
    .map(value => ({ value, label: evalKindLabel(t, value) }))

  return h(Fragment, null,
    h(Hint, null, pt(t, 'ev.intro')),
    h('div', { className: 'sa-filters' },
      h(SegmentedControl, { options: kindOptions, value: kind, onChange: setKind, label: pt(t, 'ev.filterLabel'),
        className: 'sa-segmented-chips' }),
      h('span', { className: 'sa-control-divider', 'aria-hidden': 'true' }),
      h(SegmentedControl, { options: [{ value: 'all', label: pt(t, 'ev.windowAll') }, { value: '24h', label: pt(t, 'ev.window24h') }],
        value: range, onChange: setRange, label: pt(t, 'ev.windowLabel'), className: 'sa-segmented-chips' }),
      h(SegmentedControl, { options: EVAL_VIEWS.map(value => ({ value, label: pt(t, `ev.view${value === 'all' ? 'All' : value === 'divergence' ? 'Divergence' : 'Override'}`) })),
        value: view, onChange: setView, label: pt(t, 'ev.viewLabel'), className: 'sa-segmented-chips' }),
      h(Input, { value: query, placeholder: pt(t, 'ev.searchPlaceholder'), label: pt(t, 'ev.search'),
        onChange: event => setQuery(event?.target?.value ?? '') }),
      h(Input, { value: repo, placeholder: pt(t, 'ev.repoPlaceholder'), label: pt(t, 'ev.repo'),
        onChange: event => setRepo(event?.target?.value ?? '') }),
      h(Input, { value: reason, placeholder: pt(t, 'ev.reasonPlaceholder'), label: pt(t, 'ev.reason'),
        onChange: event => setReason(event?.target?.value ?? '') }),
      h(Input, { type: 'date', value: from, label: pt(t, 'ev.from'),
        onChange: event => setFrom(event?.target?.value ?? '') }),
      h(Input, { type: 'date', value: to, label: pt(t, 'ev.to'),
        onChange: event => setTo(event?.target?.value ?? '') }),
      h('div', { className: 'sa-actions' },
        h(IconButton, { icon: h(Icon, { name: 'refresh', size: 16 }), label: pt(t, 'ev.refresh'), title: pt(t, 'ev.refresh'), onClick: refresh }))),
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    h(Section, { title: pt(t, 'ev.title'), count: total },
      items.length
        ? h(Fragment, null,
          h('ul', { className: 'sa-list' }, groupEvalDecisions(items).map(group =>
            evalDecisionRow(t, openFromEval, group.decision, group.count, group.ticketIds,
              group.decision.runs ?? []))),
          h('div', { className: 'sa-pagination' },
            h(Button, { variant: 'ghost', size: 'sm', disabled: !hasPrev,
              onClick: () => setOffset(Math.max(0, offset - EVAL_PAGE_SIZE)) }, pt(t, 'ev.prev')),
            h('span', { className: 'sa-hint', role: 'status' },
              pt(t, 'ev.pageInfo', { from: pageFrom, to: pageTo, total })),
            h(Button, { variant: 'ghost', size: 'sm', disabled: !hasNext,
              onClick: () => setOffset(offset + EVAL_PAGE_SIZE) }, pt(t, 'ev.next'))))
        : evalEmptyState(t, openFromEval, counts, kind, range, setKind, setRange, () => {
          setQuery(''); setRepo(''); setReason(''); setFrom(''); setTo(''); setView('all')
          setQ(''); setRepoFilter(''); setReasonFilter(''); setOffset(0)
        })))
}
