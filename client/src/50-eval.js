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
})

/** Endpoint `kind` values in display order; labels come from the shared decision vocabulary. */
const EVAL_KINDS = ['all', 'accept', 'reopen', 'stop', 'ignore', 'unavailable']
const evalKindLabel = (t, kind) => kind === 'all' ? pt(t, 'decisionFilter.all') : pt(t, `decision.${kind}`)

/** Strength vocabulary is closed; an unknown value falls back to the raw string instead of a missing key. */
const EVAL_STRENGTHS = ['explicit', 'inferred']

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
  return JSON.stringify([decision.kind, decision.preview, decision.threadKey,
    decision.strength, hit, rules.length - hit, decision.reason ?? null])
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
function evalDecisionRow(t, navigate, decision, count = 1, ticketIds = []) {
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
            ? h('span', { className: 'sa-mono sa-hint', title: decision.threadKey }, liveShortId(decision.threadKey, 10)) : null,
          h('span', null, reason || pt(t, 'ev.noReason')),
          strength ? h(Tag, { tone: 'quiet' }, strength) : null,
          rules.length ? h('span', null, pt(t, 'thread.rulesHit', { hit, miss })) : null,
          decision.at ? h(When, { at: decision.at }) : null,
          ticketIds.length
            ? h(Fragment, null,
              ticketIds.map(id => h('a', { key: id, href: '#', className: 'sa-mono sa-inline-link', title: id,
                onClick: event => { event.preventDefault(); navigate({ page: 'execution', id }) } }, liveShortId(id, 8))),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => navigate({ page: 'execution', id: ticketIds[0] }) },
                pt(t, 'ev.openTicket')))
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
function evalEmptyState(t, navigate, counts, kind, range, setKind, setRange) {
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
    action: h(Button, { variant: 'outline', size: 'sm', onClick: () => { setKind('all'); setRange('all') } }, pt(t, 'ev.clearFilter')) })
}

function LiveEvalPage() {
  const { t, navigate } = usePanel()
  const [kind, setKind] = useState('all')
  const [range, setRange] = useState('all')
  const { data, error, loading, reload } = useLiveResource('engine/decisions', { kind, window: range })
  const refresh = useCallback(() => { void reload() }, [reload])
  if (loading && !data) return h(Skeleton, { rows: 5 })
  if (!data) return h(ErrorState, { error, onRetry: reload })

  const items = Array.isArray(data.items) ? data.items : []
  const counts = data.counts ?? {}
  const total = Number.isFinite(data.total) ? data.total : items.length
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
      h('div', { className: 'sa-actions' },
        h(IconButton, { icon: h(Icon, { name: 'refresh', size: 16 }), label: pt(t, 'ev.refresh'), title: pt(t, 'ev.refresh'), onClick: refresh }))),
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    h(Section, { title: pt(t, 'ev.title'), count: items.length },
      items.length
        ? h(Fragment, null,
          total > items.length ? h(Hint, null, pt(t, 'ev.more', { total, shown: items.length })) : null,
          h('ul', { className: 'sa-list' }, groupEvalDecisions(items).map(group =>
            evalDecisionRow(t, navigate, group.decision, group.count, group.ticketIds))))
        : evalEmptyState(t, navigate, counts, kind, range, setKind, setRange)))
}
