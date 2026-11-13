/* Panel shell: page header with the global health summary, the six page tabs, route dispatch and one panel-level
   error boundary. App owns the single `usePanelModel()` poll; PanelState hands it to every page.

   Written in JSX (compiled to the same `h` binding the build prelude defines). */

Object.assign(PAGE_TEXT, {
  'search.title': ['搜索', 'Search'],
  'search.placeholder': ['搜索工单、线程或消息…', 'Search Tickets, Threads or messages…'],
  'search.hint': ['输入关键词，搜索工单标题/正文、线程名称与消息文本。',
    'Type a keyword to search Ticket titles/bodies, Thread titles and message text.'],
  'search.searching': ['搜索中…', 'Searching…'],
  'search.noResults': ['没有找到匹配项。', 'Nothing matched.'],
  'search.tickets': ['工单', 'Tickets'],
  'search.threads': ['线程', 'Threads'],
  'search.triggers': ['消息', 'Messages'],
  'search.showCount': ['{count} 条', '{count}'],
  'search.resultCount': ['找到 {count} 条结果', '{count} results'],
  'actions.search': ['搜索', 'Search'],
  'actions.more': ['更多操作', 'More actions'],
  'shell.scrollLabel': ['页面内容', 'Page content'],
})

/** The shared language for non-hook code (class components, pure helpers): pages set it from `t.lang` on render. */
let PANEL_LANG = 'zh'
const shellText = (zh, en) => PANEL_LANG === 'en' ? en : zh

/** Engine phase + paused flag → the one-line health the header shows. */
function globalHealth(data) {
  const engine = data?.engine ?? {}
  const paused = data?.paused === true || data?.config?.paused === true || engine.paused === true
  if (engine.phase === 'error') return { state: 'error', labelKey: 'shell.error' }
  if (engine.phase === 'blocked') return { state: 'warning', labelKey: 'shell.blocked' }
  if (paused) return { state: 'warning', labelKey: 'shell.paused' }
  if (['idle', 'ok', 'dry-run', 'starting'].includes(engine.phase)) return { state: 'ongoing', labelKey: 'shell.running' }
  return { state: 'idle', labelKey: 'shell.stopped' }
}

/** `运行中 · 需要你处理 2 件 · 数据更新于 12:31`; the only "data updated" line in the panel (title = full time). */
function GlobalStatus() {
  const { t, navigate } = usePanel()
  const { data, error, reload, updatedAt } = usePanelData()
  if (!data) {
    return <div className="sa-global-status" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sa-sp-8)',
      fontSize: 'var(--sa-fs-meta)', color: 'var(--sa-label-tertiary)', minWidth: 0 }}>
      <StatusIcon state="idle" size={14} spin={false} />
      <span>{error ? pt(t, 'shell.unknown') : pt(t, 'shell.loading')}</span>
      {error ? <Button variant="ghost" size="sm" onClick={() => { void reload() }}>{pt(t, 'actions.refreshStatus')}</Button> : null}
    </div>
  }
  const health = globalHealth(data)
  // P0: the header count follows the derived inbox when the host exposes it; older hosts keep the status-derived count.
  const pending = data.inbox ? Number(data.inbox.blocking ?? 0) : needsYouCount(data)
  const active = Number(data.load?.running ?? 0)
  const setup = setupStateOf(data)
  // When only the last switch (engine) is left, Overview owns the single "start automation" action; a second
  // "配置 3/4" chip would compete with it. Keep the chip while prerequisites or the repository step are missing.
  const onlyEnginePending = data.config?.enabled !== true && setup.done === setup.total - 1
  // Seconds belong to the detail views; the status document is refreshed every 30s, so the header reads HH:mm only.
  const clock = hhmm(updatedAt, t.lang) || '—'
  // Outside the live region below: the poll rewrites this every 30s, and announcing the timestamp would interrupt the
  // reader on a fixed cadence without telling it anything new. The full time stays available on hover (`title`).
  const updated = <span aria-hidden="true" title={fullTime(updatedAt, t.lang) || undefined}>
    {pt(t, 'dataUpdatedAt', { time: clock })}
  </span>
  // Only the sentence whose text actually changes ("运行中 · 需要你处理 2 件") is a live region, so updates are announced
  // when the state or the counts move and not on every poll. inline-flex reproduces the flex gap inside the status line.
  const sentence = <span role="status" aria-live="polite"
    style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--sa-sp-8)' }}>
    <span>{pt(t, health.labelKey)}</span>
    <span aria-hidden="true">·</span>
    <span className={pending > 0 ? 'sa-status-pending' : undefined}>{pt(t, 'shell.pending', { count: pending })}</span>
    {active > 0 ? <span aria-hidden="true">·</span> : null}
    {active > 0 ? <span>{pt(t, 'shell.active', { count: active })}</span> : null}
  </span>
  return <div className="sa-global-status" title={error ? errorText(error) : undefined}
    style={{ display: 'flex', alignItems: 'center', gap: 'var(--sa-sp-8)', flexWrap: 'wrap',
      fontSize: 'var(--sa-fs-meta)', color: 'var(--sa-label-tertiary)', minWidth: 0 }}>
    <StatusIcon state={health.state} size={14} spin={health.state === 'ongoing'} />
    {sentence}
    <span aria-hidden="true">·</span>
    {updated}
    {setup.done < setup.total && !onlyEnginePending
      ? <>
        <span aria-hidden="true">·</span>
        <button type="button" className="sa-setup-chip" onClick={() => navigate({ page: 'overview' })}>
          {pt(t, 'shell.setupChip', { done: setup.done, total: setup.total })}
        </button>
      </>
      : null}
    {error ? <Button variant="ghost" size="sm" onClick={() => { void reload() }}>{pt(t, 'actions.refreshStatus')}</Button> : null}
  </div>
}

/** Cross-record search palette: tickets, threads and message text in one query, opened with Ctrl/Cmd+K or `/`. */
function GlobalSearch({ open, onClose }) {
  const { t, navigate, call } = usePanel()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(undefined)
  const [failure, setFailure] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)
  useEffect(() => {
    if (!open) { setQuery(''); setResult(undefined); setFailure(undefined); setBusy(false); return undefined }
    // Focus the field once the dialog has mounted. Guarded by rAF: a layout-less environment (jsdom render-check) has
    // no frame loop and its focus polyfill throws on synthetic focus, while every real browser focuses as intended.
    if (typeof requestAnimationFrame !== 'function') return undefined
    const handle = requestAnimationFrame(() => inputRef.current?.focus())
    return () => cancelAnimationFrame(handle)
  }, [open])
  useEffect(() => {
    if (!open) return undefined
    const text = query.trim()
    if (!text) { setResult(undefined); setFailure(undefined); setBusy(false); return undefined }
    let active = true
    setBusy(true)
    const timer = setTimeout(async () => {
      try {
        const value = await call('GET engine/search', { query: { q: text } })
        if (!active) return
        setResult(value)
        setFailure(undefined)
      } catch (error) {
        if (active) setFailure(error)
      } finally {
        if (active) setBusy(false)
      }
    }, 220)
    return () => { active = false; clearTimeout(timer) }
  }, [open, query, call])
  // Picking a result closes the palette; Modal's unmount cleanup would hand focus back to the header search button and
  // strand a keyboard user outside the screen they just opened (section B :113). Move focus to the page body instead:
  // the named scroll region announces the new screen, and a single Tab reaches the first control of the new page
  // (usually its back button/title action) without re-tabbing the whole chrome.
  const go = route => {
    navigate(route)
    onClose()
    if (typeof requestAnimationFrame !== 'function') return
    requestAnimationFrame(() => document.querySelector('.sa-scroll')?.focus())
  }
  const groups = result ? [
    { key: 'tickets', titleKey: 'search.tickets', items: result.tickets ?? [], render: ticket => <button
      key={ticket.id} type="button" className="sa-row sa-row-openable"
      onClick={() => go({ page: 'execution', id: ticket.id })}>
      <StatusIcon state={ticketStatus(ticket).state} size={14} />
      <div className="sa-row-main">
        <div className="sa-row-title"><span className="sa-ellipsis">{ticket.title || ticket.id}</span></div>
        <div className="sa-row-meta">
          <Tag tone={ticketStatus(ticket).tone}>{pt(t, ticketStatus(ticket).labelKey)}</Tag>
          {ticket.updatedAt ? <When at={ticket.updatedAt} /> : null}
        </div>
      </div>
    </button> },
    { key: 'threads', titleKey: 'search.threads', items: result.threads ?? [], render: thread => <button
      key={thread.key} type="button" className="sa-row sa-row-openable"
      onClick={() => go({ page: 'trigger', id: thread.key })}>
      <Icon name="message" size={14} />
      <div className="sa-row-main">
        <div className="sa-row-title"><span className="sa-ellipsis">{thread.title || thread.key}</span></div>
        <div className="sa-row-meta">{thread.source ? <Tag tone="outline">{String(thread.source)}</Tag> : null}
          {thread.lastAt ? <When at={thread.lastAt} /> : null}</div>
      </div>
    </button> },
    { key: 'triggers', titleKey: 'search.triggers', items: result.triggers ?? [], render: trigger => <button
      key={trigger.id} type="button" className="sa-row sa-row-openable"
      onClick={() => go(trigger.threadKey ? { page: 'trigger', id: trigger.threadKey } : { page: 'trigger' })}>
      <Icon name="message" size={14} />
      <div className="sa-row-main">
        <div className="sa-row-title"><span className="sa-ellipsis">{trigger.text || trigger.id}</span></div>
        {trigger.at ? <div className="sa-row-meta"><When at={trigger.at} /></div> : null}
      </div>
    </button> },
  ].filter(group => group.items.length) : []
  // A6: the palette's async result needs a live region. Announce only the settled outcome (N results / nothing matched)
  // — never the result list itself — and stay silent while a newer query is in flight or an error owns `role=alert`.
  const found = result ? Number(result.total ?? groups.reduce((sum, group) => sum + group.items.length, 0)) : 0
  const announcement = !busy && !failure && result
    ? (found > 0 ? pt(t, 'search.resultCount', { count: found }) : pt(t, 'search.noResults'))
    : ''
  const body = !query.trim()
    ? <Hint>{pt(t, 'search.hint')}</Hint>
    : failure
      ? <p className="sa-error" role="alert">{errorText(failure)}</p>
      : busy && !result
        ? <Hint>{pt(t, 'search.searching')}</Hint>
        : result && result.total === 0
          ? <Hint>{pt(t, 'search.noResults')}</Hint>
          : <div className="sa-search-groups">{groups.map(group => <section key={group.key} className="sa-section">
            <h3 className="sa-ledger-title">{pt(t, group.titleKey)}
              <span className="sa-count" data-empty={group.items.length === 0 ? 'true' : undefined}>
                {pt(t, 'search.showCount', { count: group.items.length })}
              </span>
            </h3>
            <div className="sa-list">{group.items.map(group.render)}</div>
          </section>)}</div>
  return <Modal open={open} onClose={onClose} title={pt(t, 'search.title')} closeLabel={t('close')} className="sa-search-modal"
    // Ctrl+K has no opener element; Esc must hand focus back to the search trigger, not to <body>.
    restoreTo={() => document.getElementById('sa-search-trigger')}>
    <form role="search" aria-label={pt(t, 'search.title')} onSubmit={event => event.preventDefault()}>
      <Input inputRef={inputRef} icon="search" className="sa-input-full" type="search" name="q" autoComplete="off"
        value={query} placeholder={pt(t, 'search.placeholder')} aria-label={pt(t, 'search.placeholder')}
        aria-busy={busy ? 'true' : undefined}
        onChange={event => setQuery(event.target.value)} />
    </form>
    <div className="sa-modal-body" aria-busy={busy ? 'true' : undefined}>{body}
      <span className="sa-sr-only" role="status" aria-live="polite">{announcement}</span>
    </div>
  </Modal>
}

/** Page header: title, the one global status line, the two fixed status actions (check / refresh), then the glossary. */
function Header({ onOpenSearch }) {
  const { t, notify } = usePanel()
  const model = usePanelData()
  const [glossaryOpen, setGlossaryOpen] = useState(false)
  const poll = useAction(async () => {
    const result = await model.actions.poll({ dryRun: true })
    notify(pt(t, 'toast.pollDone', { accepted: result?.accepted?.length ?? 0, ignored: result?.ignored?.length ?? 0 }))
  }, { reload: model.reload })
  return <>
    <header className="sa-head">
      <div className="sa-head-title">
        <h1 className="sa-title">{t('title')}</h1>
        {/* Phones get one overflow trigger instead of four unlabeled 28px icons; the same actions remain reachable. */}
        <div className="sa-mobile-tools">
          <Menu label={pt(t, 'actions.more')} iconName="more" items={[
            { key: 'search', label: pt(t, 'actions.search'), onSelect: onOpenSearch },
            { key: 'check', label: pt(t, 'actions.checkNow'), disabled: poll.busy, onSelect: () => { void poll.run() } },
            { key: 'refresh', label: pt(t, 'actions.refreshStatus'), onSelect: () => { void model.reload() } },
            { key: 'glossary', label: t('glossary'), onSelect: () => setGlossaryOpen(true) },
          ]} />
        </div>
      </div>
      <div className="sa-head-tools" style={{ display: 'flex', alignItems: 'center', gap: 'var(--sa-sp-8)', flexWrap: 'wrap' }}>
        <GlobalStatus />
        <IconButton id="sa-search-trigger" icon={<Icon name="search" size={16} />} label={pt(t, 'actions.search')}
          title={`${pt(t, 'actions.search')} · Ctrl+K`} variant="outline" onClick={onOpenSearch} />
        <IconButton icon={<Icon name="message" size={16} />} label={pt(t, 'actions.checkNow')}
          title={pt(t, 'actions.checkNow')} variant="outline" disabled={poll.busy} aria-busy={poll.busy ? 'true' : undefined}
          onClick={() => { void poll.run() }} />
        <IconButton icon={<Icon name="refresh" size={16} />} label={pt(t, 'actions.refreshStatus')}
          title={pt(t, 'actions.refreshStatus')} variant="outline" onClick={() => { void model.reload() }} />
        <IconButton icon={<Icon name="question" size={16} />} label={t('glossary')} title={t('glossary')}
          variant="outline" onClick={() => setGlossaryOpen(true)} />
      </div>
    </header>
    <GlossaryModal open={glossaryOpen} onClose={() => setGlossaryOpen(false)} />
  </>
}

/** Route → the page component for that tab. Pages receive the route as a prop (detail id included). */
function pageView(page) {
  switch (page) {
    case 'source': return LiveSourcePage
    case 'trigger': return LiveTriggerPage
    case 'eval': return LiveEvalPage
    case 'execution': return LiveExecutionPage
    case 'settings': return LiveSettingsPage
    case 'overview': default: return LiveOverviewPage
  }
}

function Pages({ route }) {
  useEffect(() => { document.getElementById(`sa-tab-${route.page}`)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }) }, [route.page])
  const Page = pageView(route.page)
  return <div className="sa-main" id="sa-page" role="tabpanel" aria-labelledby={`sa-tab-${route.page}`}>
    <Page route={route} />
  </div>
}

/** Keep one page crash from blanking the whole panel: show the error text and a reload button instead. */
class PanelBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { console.error('superagent panel crashed', error, info) }
  render() {
    if (this.state.error) {
      return <div className="sa-main" style={{ padding: 'var(--sa-sp-24)' }}>
        <p className="sa-error" role="alert">{shellText('面板渲染出错：', 'The panel failed to render: ') + String(this.state.error?.message ?? this.state.error)}</p>
        <p className="sa-hint">{shellText('这是页面级错误；刷新后若仍出现，把上面的文字发给 Superagent。',
          'This is a page-level error. If it persists after a refresh, send the text above to Superagent.')}</p>
        <Button variant="outline" onClick={() => location.reload()}>{shellText('刷新页面', 'Reload page')}</Button>
      </div>
    }
    return this.props.children
  }
}

/** Inside the provider: the one status poll, then the page frame that every tab shares. */
function PanelShell({ location, openTab }) {
  const { t } = usePanel()
  PANEL_LANG = t.lang
  const model = usePanelModel(30000)
  const [searchOpen, setSearchOpen] = useState(false)
  const scroller = useRef(null)
  // A route change starts the new page at its top: the body scroll must never inherit the previous page's offset
  // (tab-hopping from a 3-screen Ticket back to Overview used to land mid-page).
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = 0
  }, [location.route.page, location.route.id])
  // Ctrl/Cmd+K opens the search palette; `/` does too when the user is not typing in a field.
  useEffect(() => {
    const onKeyDown = event => {
      const target = event.target
      const typing = target instanceof HTMLElement
        && Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
      if (((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') || (event.key === '/' && !typing)) {
        event.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
  // Alt+1..6 switches tabs without leaving the keyboard; the tab title/aria-keyshortcuts make it discoverable.
  useEffect(() => {
    const onKeyDown = event => {
      if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      const index = Number(event.key) - 1
      if (!Number.isInteger(index) || index < 0 || index >= TABS.length) return
      event.preventDefault()
      openTab(TABS[index])
      // Selection moves with the shortcut, so focus must follow: otherwise the selected tab is tabindex=-1 and the
      // keyboard focus sits on a tab the user is no longer on (real-click arrow keys already keep the two in sync).
      document.getElementById(`sa-tab-${TABS[index]}`)?.focus()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [openTab])
  return <PanelState.Provider value={model}>
    <div className="sa-page">
      <div className="sa-column">
        {/* The header and the six tabs are the panel's permanent chrome: they live in a fixed topbar and only the page
            body scrolls, so the tab bar never disappears under the window edge. */}
        <div className="sa-topbar">
          <Header onOpenSearch={() => setSearchOpen(true)} />
          {TABS.length > 1 ? <div className="sa-filters">
            <SegmentedTabs items={TABS.map((value, index) => ({ value, label: t(`tab.${value}`), id: `sa-tab-${value}`,
              panelId: 'sa-page', title: `${t(`tab.${value}`)} · Alt+${index + 1}`, shortcut: `Alt+${index + 1}` }))}
              value={location.route.page} onChange={openTab} label={t('pageLabel')} />
          </div> : null}
        </div>
        {/* The body is the only scroll container, and a plain overflow div is not keyboard-scrollable in Safari: make it a
            named region so it can take focus and arrow keys/page keys reach the page body. */}
        <div ref={scroller} className="sa-scroll" tabIndex={0} role="region" aria-label={pt(t, 'shell.scrollLabel')}>
          <PanelBoundary><Pages route={location.route} /></PanelBoundary>
        </div>
        <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
      </div>
    </div>
  </PanelState.Provider>
}

/** Root panel component: route history above the single status poll and the provider that shares it. */
function App({ openSession, t }) {
  const [location, setLocation] = useState(initialLocation)
  useEffect(() => { remember(location) }, [location])
  // The page-load fragment only seeds this first mount. A later remount inside the host SPA reads the remembered route
  // instead, so a fragment the host stripped or rewrote after boot cannot drag the panel back to an older screen.
  useEffect(() => { releaseLinkedRoute() }, [])
  // Deep links: a pasted URL or a host rewrite of `#sa=…` moves the panel in place, without a reload. Our own writes go
  // through replaceState and never fire `hashchange`, so this cannot loop with `remember`. A foreign fragment (the host
  // SPA's own state) is ignored, and a known page without a record resets to that tab's root. Compared with the whole
  // route value so an in-view field (execution stage, settings group) from a shared link is applied too.
  useEffect(() => {
    const onHashChange = () => {
      const route = routeFromHash()
      if (!route) return
      setLocation(current => routeEquivalent(current.route, route) ? current : { route, stack: [] })
    }
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])
  const move = useCallback(next => setLocation(current => next(current)), [])
  const navigate = useCallback((route, replace = false) => move(current => ({ route,
    stack: replace ? current.stack : [...current.stack, current.route].slice(-20) })), [move])
  // A deep-linked detail can arrive with an empty history (sessionStorage route memory or a cold open). Its back
  // control must return to its own tab list, not to the home tab — and the label must say so (critique O12).
  const back = useCallback(() => move(current => current.stack.length
    ? { route: current.stack.at(-1), stack: current.stack.slice(0, -1) }
    : { route: current.route.id ? { page: current.route.page } : HOME, stack: [] }), [move])
  const openTab = useCallback(tab => move(() => ({ stack: [], route: { page: tab } })), [move])
  return <PanelProvider t={t} openSession={openSession} navigate={navigate} back={back} route={location.route}
    backLabel={routeLabel(t, location.stack.at(-1) ?? (location.route.id ? { page: location.route.page } : HOME))}>
    <PanelShell location={location} openTab={openTab} />
  </PanelProvider>
}
