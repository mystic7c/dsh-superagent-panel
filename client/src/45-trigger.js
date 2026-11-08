/* LiveTriggerPage (contract §6.3): a filterable Thread list beside the selected Thread's detail. A wide page shows
   both panes; at ≤960 px of page width the page turns into one column and whether the route carries a thread key
   decides which pane is visible (the detail brings its own back button). The detail is 48-thread-detail.js's
   ThreadDetail — facts → evaluation (the latest decision lives there now) plus the message timeline — so this page only
   owns filtering, selection and the pane switch. */

Object.assign(PAGE_TEXT, {
  'trg.title': ['线程', 'Threads'],
  'trg.filter': ['线程筛选', 'Thread filter'],
  'trg.filter.subscribed': ['已订阅', 'Subscribed'],
  'trg.filter.recent': ['24h 新触发', 'New in 24h'],
  'trg.filter.all': ['全部', 'All'],
  'trg.filterCount': ['{count} 条', '{count}'],
  'trg.refresh': ['刷新线程', 'Refresh threads'],
  'trg.status.subscribed': ['已订阅', 'Subscribed'],
  'trg.status.recent': ['24h 有新触发', 'New in 24h'],
  'trg.status.idle': ['无新触发', 'Quiet'],
  'trg.source.octo': ['Octo 群', 'Octo group'],
  'trg.source.gitlab': ['GitLab', 'GitLab'],
  'trg.emptyTitle': ['还没有线程', 'No Thread yet'],
  'trg.emptyHint': ['去来源页配置一个来源并触发一条消息，线程会出现在这里。',
    'Set up a Source and send one message; Threads will appear here.'],
  'trg.emptyAction': ['去来源页', 'Open Source'],
  'trg.noneInFilter': ['这个筛选下没有线程。', 'No Thread matches this filter.'],
  'trg.showAll': ['查看全部', 'Show all'],
  'trg.threadFallback.octo': ['Octo 会话', 'Octo conversation'],
  'trg.threadFallback.other': ['未命名线程', 'Untitled Thread'],
  'trg.noSelection': ['从左侧选择一个线程', 'Pick a Thread on the left'],
  'trg.noSelectionHint': ['选中线程后，这里会展示事实、评估过程与消息去向。',
    'Pick a Thread to see its facts, evaluation and where each message went.'],
})

const THREAD_FILTERS = ['subscribed', 'recent', 'all']
/** Thread row state → shape + label: subscribed (has Tickets) ✓, active in the last 24h ring, otherwise the idle dot. */
const THREAD_STATE = {
  subscribed: { state: 'done', labelKey: 'trg.status.subscribed' },
  recent: { state: 'ongoing', labelKey: 'trg.status.recent' },
  idle: { state: 'idle', labelKey: 'trg.status.idle' },
}
const THREAD_SOURCE_ICON = { octo: 'message', gitlab: 'pull' }

function threadViewOf(row) {
  return THREAD_STATE[row?.state] ?? THREAD_STATE.idle
}

/** Source id → its short label (Octo / GitLab); an unknown id stays readable as-is instead of showing a bare key. */
function threadSourceLabel(t, source) {
  const key = `trg.source.${source}`
  const text = pt(t, key)
  return text === key ? String(source ?? '') : text
}

/**
 * A raw thread key (`octo:<hex>`) is a raw identifier and never becomes a list title (spec G2). When the engine had no
 * human title it stores the key as the title, so resolve the watched chat title from the status config instead, and
 * fall back to a generic noun (without the id) when even that is unknown.
 */
function threadTitleOf(t, row, octoConfig) {
  const key = String(row?.key ?? '')
  const title = typeof row?.title === 'string' ? row.title.trim() : ''
  const rawKeyTitle = !title || title === key || /^[a-z][a-z0-9]*:[0-9a-f]{6,}$/i.test(title)
  if (!rawKeyTitle) return title
  const channelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : ''
  const chatTitle = channelId ? octoConfig?.chatTitles?.[channelId] : undefined
  if (chatTitle) return chatTitle
  return row?.source === 'octo' ? pt(t, 'trg.threadFallback.octo') : pt(t, 'trg.threadFallback.other')
}

/** The page frame the panel renders into. The viewport is the wrong measure inside a DSH rail (sidebar + right rail
    decide how much room the page actually has), so the hook measures this element instead. */
const COMPACT_MAX_WIDTH = 960

function triggerPageFrame() {
  return typeof document === 'undefined' ? null : document.querySelector('.sa-page')
}

/** Width of the page frame, or undefined while it has no measurable layout (not mounted yet, or a layout-less test). */
function triggerPageWidth() {
  const width = triggerPageFrame()?.clientWidth
  return Number.isFinite(width) && width > 0 ? width : undefined
}

function triggerViewportIsCompact() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`).matches
}

/**
 * True while the page frame is ≤960 px: one column, and the route decides whether the list or the detail is shown.
 * 05-style.js already collapses `.sa-panes` with a CSS container query on `.sa-page`; this hook measures that same
 * element through a ResizeObserver so the pane switch and the CSS never disagree. `matchMedia` stays as the fallback
 * while the frame is not mounted yet (a deep link can render before the shell) or has no layout (jsdom/render-check).
 */
function useCompactTriggerLayout() {
  const [compact, setCompact] = useState(() => {
    const width = triggerPageWidth()
    return width === undefined ? triggerViewportIsCompact() : width <= COMPACT_MAX_WIDTH
  })
  useEffect(() => {
    if (typeof window === 'undefined') return undefined
    let frameId
    let frameViaRaf = false
    let observer
    let media
    let mediaChange
    let disposed = false
    const refresh = () => {
      const width = triggerPageWidth()
      if (width !== undefined) setCompact(width <= COMPACT_MAX_WIDTH)
      else setCompact(triggerViewportIsCompact())
    }
    const observePage = () => {
      const page = triggerPageFrame()
      if (!page) return false
      refresh()
      // A layout-less environment (jsdom) provides a no-op ResizeObserver; clientWidth stays 0 there, so refresh()
      // keeps the viewport fallback instead of treating "no layout" as a narrow page.
      if (typeof window.ResizeObserver === 'function') {
        observer = new window.ResizeObserver(refresh)
        observer.observe(page)
      }
      return true
    }
    // The shell mounts `.sa-page` above this page; a deep link can run this effect before that frame exists, so retry on
    // the next few animation frames and then keep the viewport fallback.
    let attempts = 0
    const attach = () => {
      if (disposed || observePage()) return
      attempts += 1
      if (attempts > 8) return
      if (typeof window.requestAnimationFrame === 'function') {
        frameViaRaf = true
        frameId = window.requestAnimationFrame(attach)
      } else {
        frameId = window.setTimeout(attach, 100)
      }
    }
    attach()
    if (typeof window.matchMedia === 'function') {
      media = window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`)
      mediaChange = () => { if (triggerPageWidth() === undefined) setCompact(media.matches) }
      if (typeof media.addEventListener === 'function') media.addEventListener('change', mediaChange)
      else if (typeof media.addListener === 'function') media.addListener(mediaChange)
    }
    return () => {
      disposed = true
      if (frameId !== undefined) {
        if (frameViaRaf) window.cancelAnimationFrame(frameId)
        else window.clearTimeout(frameId)
      }
      observer?.disconnect?.()
      if (media && mediaChange) {
        if (typeof media.removeEventListener === 'function') media.removeEventListener('change', mediaChange)
        else if (typeof media.removeListener === 'function') media.removeListener(mediaChange)
      }
    }
  }, [])
  return compact
}

/**
 * 48-thread-detail's `ThreadDetail` reads its thread key from a `key` prop, but React reserves `key` on elements and
 * never hands it to the component. Calling it as a plain render function from this thin, stable wrapper passes the
 * value through while still giving every hook a stable owner. The aliases keep it working if the detail's prop is
 * renamed to `threadKey`/`id` while this page is being wired up.
 */
function ThreadDetailView({ threadKey, showBack }) {
  return ThreadDetail({ key: threadKey, threadKey, id: threadKey, showBack })
}

/** One thread row: title, source icon + name, last activity, and the shape-coded state with its text. */
function ThreadListRow({ row, selected, onOpen, octoConfig, compact = false }) {
  const { t } = usePanel()
  const view = threadViewOf(row)
  return h('li', {
    className: 'sa-row',
    role: 'button',
    tabIndex: 0,
    'aria-current': selected ? 'true' : undefined,
    onClick: onOpen,
    onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen() } },
    style: selected ? { background: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))' } : undefined,
  },
  h('div', { className: 'sa-row-main' },
    h('div', { className: 'sa-row-title' }, h('span', { className: 'sa-ellipsis' }, threadTitleOf(t, row, octoConfig))),
    h('div', { className: 'sa-row-meta' },
      h('span', { className: 'sa-actions' },
        h(Icon, { name: THREAD_SOURCE_ICON[row.source] ?? 'message', size: 12 }),
        h('span', null, threadSourceLabel(t, row.source))),
      row.lastAt ? h(When, { at: row.lastAt }) : null,
      h(StatusText, { state: view.state }, pt(t, view.labelKey)))),
    compact ? h('span', { className: 'sa-row-chevron', 'aria-hidden': 'true' },
      h(Icon, { name: 'chevron-right', size: 14 })) : null)
}

function LiveTriggerPage({ route }) {
  const { t, navigate } = usePanel()
  const compact = useCompactTriggerLayout()
  const [filter, setFilter] = useState('subscribed')
  const { data, error, reload } = useLiveResource('engine/threads', { filter })
  // The watched-chat titles live on the shared status model; they turn a raw octo key into a readable list title.
  const { data: status } = usePanelData()
  const octoConfig = status?.config?.octo
  const routeId = route?.id
  const items = Array.isArray(data?.items) ? data.items : []
  const counts = data?.counts ?? {}
  const selected = routeId ?? items[0]?.key

  const chooseFilter = (value) => {
    if (value === filter) return
    setFilter(value)
    // A filter change resets the selection so the detail follows the visible list instead of a hidden thread.
    if (routeId) navigate({ page: 'trigger' }, true)
  }
  // In the narrow layout the detail is hidden unless the route carries an id, and the first row is already the
  // implicit selection; opening it must still promote it to the route so the single-pane detail appears.
  const openThread = (key) => {
    if (key !== selected || (compact && !routeId)) navigate({ page: 'trigger', id: key })
  }

  if (data !== undefined && (counts.all ?? 0) === 0) {
    return h(EmptyState, { icon: 'inbox', title: pt(t, 'trg.emptyTitle'), hint: pt(t, 'trg.emptyHint'),
      action: h(Button, { variant: 'primary', icon: h(Icon, { name: 'inbox', size: 14 }),
        onClick: () => navigate({ page: 'source' }) }, pt(t, 'trg.emptyAction')) })
  }
  if (data === undefined) return error ? h(ErrorState, { error, onRetry: reload }) : h(Skeleton, { rows: 4 })

  const options = THREAD_FILTERS.map(value => ({ value, label: pt(t, `trg.filter.${value}`),
    title: pt(t, 'trg.filterCount', { count: counts[value] ?? 0 }) }))
  const list = h('div', { className: 'sa-pane sa-pane-aside' },
    h(Section, { title: pt(t, 'trg.title'), count: items.length,
      action: h(IconButton, { icon: h(Icon, { name: 'refresh', size: 16 }), label: pt(t, 'trg.refresh'),
        onClick: () => { void reload() } }) },
      h(SegmentedControl, { options, value: filter, onChange: chooseFilter, label: pt(t, 'trg.filter'),
        className: 'sa-segmented-chips' }),
      error ? h(ErrorState, { error, onRetry: reload }) : null,
      items.length
        ? h('ul', { className: 'sa-list' }, items.map(row => h(ThreadListRow, { key: row.key, row, compact,
          // In the single-pane layout the first row is not "selected" until the route carries its key; a grey row
          // with no visible detail would otherwise promise a state the screen is not showing.
          selected: compact ? row.key === routeId : row.key === selected,
          onOpen: () => openThread(row.key), octoConfig })))
        : h(Hint, null, pt(t, 'trg.noneInFilter'))))
  const detail = h('div', { className: 'sa-pane' },
    selected
      ? h(ThreadDetailView, { threadKey: selected, showBack: compact })
      : h(EmptyState, { icon: 'message', title: pt(t, 'trg.noSelection'), hint: pt(t, 'trg.noSelectionHint'),
        action: (counts.all ?? 0) > 0
          ? h(Button, { variant: 'outline', size: 'sm', onClick: () => chooseFilter('all') }, pt(t, 'trg.showAll'))
          : null }))
  const showList = !compact || !routeId
  const showDetail = !compact || Boolean(routeId)
  return h('div', { className: 'sa-panes' }, showList ? list : null, showDetail ? detail : null)
}
