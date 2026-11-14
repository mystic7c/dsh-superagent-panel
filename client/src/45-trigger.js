/* LiveTriggerPage (contract §6.3): a filterable Thread list beside the selected Thread's detail. A wide page shows
   both panes; at ≤960 px of page width the page turns into one column and whether the route carries a thread key
   decides which pane is visible (the detail brings its own back button). The detail is 48-thread-detail.js's
   ThreadDetail — facts → evaluation (the latest decision lives there now) plus the message timeline — so this page only
   owns filtering, selection and the pane switch. */

import { API, Icon } from "./00-util.js"
import { when } from "./06-i18n.js"
import { Button, IconButton, Input, SegmentedControl, StatusText } from "./10-controls.js"
import { same, usePanel, usePanelData } from "./15-api.js"
import { EmptyState, ErrorState, Hint, Section, Skeleton, When } from "./20-widgets.js"
import { PAGE_TEXT, pt } from "./21-localtext.js"
import { remember } from "./25-router.js"
import { useLiveResource } from "./32-live-model.js"
import { ThreadDetail } from "./48-thread-detail.js"
import { React, h, useEffect, useRef, useState } from "./00-react.js"
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
  'trg.search': ['搜索线程', 'Search Threads'],
  'trg.searchPlaceholder': ['标题、来源或会话 key…', 'Title, source or chat key…'],
  'trg.repo': ['按仓库筛选', 'Filter by repository'],
  'trg.repoPlaceholder': ['仓库 ID…', 'Repository ID…'],
  'trg.reason': ['按原因筛选', 'Filter by reason'],
  'trg.reasonPlaceholder': ['原因关键字…', 'Reason keyword…'],
  'trg.from': ['开始日期', 'From date'],
  'trg.to': ['结束日期', 'To date'],
  'trg.pageInfo': ['{from}–{to} / 共 {total} 条', '{from}–{to} of {total}'],
  'trg.prev': ['上一页', 'Previous'],
  'trg.next': ['下一页', 'Next'],
  'trg.showAll': ['查看全部', 'Show all'],
  'trg.threadFallback.octo': ['Octo 会话', 'Octo conversation'],
  'trg.threadFallback.other': ['未命名线程', 'Untitled Thread'],
  'trg.noSelection': ['从左侧选择一个线程', 'Pick a Thread on the left'],
  'trg.noSelectionHint': ['选中线程后，这里会展示事实、评估过程与消息去向。',
    'Pick a Thread to see its facts, evaluation and where each message went.'],
})

export const THREAD_FILTERS = ['subscribed', 'recent', 'all']
/** Thread row state → shape + label: subscribed (has Tickets) ✓, active in the last 24h ring, otherwise the idle dot. */
export const THREAD_STATE = {
  subscribed: { state: 'done', labelKey: 'trg.status.subscribed' },
  recent: { state: 'ongoing', labelKey: 'trg.status.recent' },
  idle: { state: 'idle', labelKey: 'trg.status.idle' },
}
export const THREAD_SOURCE_ICON = { octo: 'message', gitlab: 'pull' }

export function threadViewOf(row) {
  return THREAD_STATE[row?.state] ?? THREAD_STATE.idle
}

/** Source id → its short label (Octo / GitLab); an unknown id stays readable as-is instead of showing a bare key. */
export function threadSourceLabel(t, source) {
  const key = `trg.source.${source}`
  const text = pt(t, key)
  return text === key ? String(source ?? '') : text
}

/**
 * A raw thread key (`octo:<hex>`) is a raw identifier and never becomes a list title (spec G2). When the engine had no
 * human title it stores the key as the title, so resolve the watched chat title from the status config instead, and
 * fall back to a generic noun (without the id) when even that is unknown.
 */
export function threadTitleOf(t, row, octoConfig) {
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
export const COMPACT_MAX_WIDTH = 960

export function triggerPageFrame() {
  return typeof document === 'undefined' ? null : document.querySelector('.sa-page')
}

/** Width of the page frame, or undefined while it has no measurable layout (not mounted yet, or a layout-less test). */
export function triggerPageWidth() {
  const width = triggerPageFrame()?.clientWidth
  return Number.isFinite(width) && width > 0 ? width : undefined
}

export function triggerViewportIsCompact() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(`(max-width: ${COMPACT_MAX_WIDTH}px)`).matches
}

/**
 * True while the page frame is ≤960 px: one column, and the route decides whether the list or the detail is shown.
 * 05-style.js already collapses `.sa-panes` with a CSS container query on `.sa-page`; this hook measures that same
 * element through a ResizeObserver so the pane switch and the CSS never disagree. `matchMedia` stays as the fallback
 * while the frame is not mounted yet (a deep link can render before the shell) or has no layout (jsdom/render-check).
 */
export function useCompactTriggerLayout() {
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
export function ThreadDetailView({ threadKey, showBack }) {
  return ThreadDetail({ key: threadKey, threadKey, id: threadKey, showBack })
}

/** ↑/↓/Home/End move focus between the row buttons; the row buttons themselves keep native Enter/Space activation.
    Only one row is in the Tab order (roving tabindex), so a 50-row page is one Tab stop, not fifty (WIG A4/P2). */
export function threadRowKeyDown(event) {
  const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
  const edge = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : ''
  if (!step && !edge) return
  const buttons = [...(event.currentTarget.closest('ul')?.querySelectorAll('button.sa-row-open') ?? [])]
  if (!buttons.length) return
  event.preventDefault()
  const index = buttons.indexOf(event.currentTarget)
  const target = edge === 'first' ? buttons[0]
    : edge === 'last' ? buttons[buttons.length - 1]
      : buttons[Math.max(0, Math.min(buttons.length - 1, index + step))]
  target?.focus()
}

/** One thread row: title, source icon + name, last activity, and the shape-coded state with its text. The open action
    is one real `<button>` whose `::after` covers the whole row (the `.sa-open` pattern), so the row is a list item with
    native semantics instead of a `<li role="button">` (P1/A4). */
export function ThreadListRow({ row, selected, onOpen, octoConfig, compact = false, tabbable = false }) {
  const { t } = usePanel()
  const view = threadViewOf(row)
  return h('li', {
    className: 'sa-row sa-row-openable',
    // `.sa-list .sa-row[role='button']` used to give every thread row its 8px inset; the row is a plain list item now,
    // so keep the same inset from the shared spacing token.
    style: { paddingLeft: 'var(--sa-sp-8)', paddingRight: 'var(--sa-sp-8)',
      ...(selected ? { background: 'var(--dsw-alias-interactive-bg-hover, var(--dsw-alias-bg-layer-2))' } : null) },
  },
  h('div', { className: 'sa-row-main' },
    h('div', { className: 'sa-row-title' },
      h('button', { type: 'button', className: 'sa-row-open sa-open', tabIndex: tabbable ? 0 : -1,
        'aria-current': selected ? 'true' : undefined, onClick: onOpen, onKeyDown: threadRowKeyDown },
      h('span', { className: 'sa-ellipsis' }, threadTitleOf(t, row, octoConfig)))),
    h('div', { className: 'sa-row-meta' },
      h('span', { className: 'sa-actions' },
        h(Icon, { name: THREAD_SOURCE_ICON[row.source] ?? 'message', size: 12 }),
        h('span', null, threadSourceLabel(t, row.source))),
      row.lastAt ? h(When, { at: row.lastAt }) : null,
      h(StatusText, { state: view.state }, pt(t, view.labelKey)))),
    compact ? h('span', { className: 'sa-row-chevron', 'aria-hidden': 'true' },
      h(Icon, { name: 'chevron-right', size: 14 })) : null)
}

export const TRG_PAGE_SIZE = 50
export const TRG_SCROLL_KEY = 'superagent-panel/trigger-scroll'

/** The panel scrolls inside `.sa-scroll`; remember the list position so opening a Ticket/Thread can return to it. */
export function triggerScrollTop() {
  try {
    const scroller = document.querySelector('.sa-scroll')
    const y = scroller ? scroller.scrollTop : window.scrollY
    return Number.isFinite(y) && y > 0 ? y : 0
  } catch { return 0 }
}
export function rememberTriggerScroll() {
  const y = triggerScrollTop()
  if (y > 0) try { sessionStorage.setItem(TRG_SCROLL_KEY, String(y)) } catch { /* private mode */ }
}
export function restoreTriggerScroll() {
  try {
    const y = Number(sessionStorage.getItem(TRG_SCROLL_KEY) ?? 0)
    if (!(y > 0)) return
    const scroller = document.querySelector('.sa-scroll')
    if (scroller) scroller.scrollTop = y
    else window.scrollTo(0, y)
  } catch { /* private mode */ }
}
// The filter is part of the same deep-link state as the text filters (A5): a reload/back must restore the visible
// slice, not silently drop back to the default one.
export const TRG_URL_KEYS = { filter: 'trgFilter', q: 'trgQ', repo: 'trgRepo', reason: 'trgReason', from: 'trgFrom',
  to: 'trgTo', offset: 'trgOffset' }
export function trgUrlState() {
  try {
    const params = new URLSearchParams(window.location.search)
    const offset = Number(params.get(TRG_URL_KEYS.offset) ?? 0)
    const filter = params.get(TRG_URL_KEYS.filter)
    return { filter: THREAD_FILTERS.includes(filter) ? filter : THREAD_FILTERS[0],
      q: params.get(TRG_URL_KEYS.q) || '', repo: params.get(TRG_URL_KEYS.repo) || '',
      reason: params.get(TRG_URL_KEYS.reason) || '', from: params.get(TRG_URL_KEYS.from) || '',
      to: params.get(TRG_URL_KEYS.to) || '', offset: Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0 }
  } catch { return { filter: THREAD_FILTERS[0], q: '', repo: '', reason: '', from: '', to: '', offset: 0 } }
}

/** A date input is local midnight; the API compares ISO instants, so widen the end date to its last millisecond. */
export function trgDayBound(value, end = false) {
  if (!value) return ''
  const date = new Date(`${value}T${end ? '23:59:59.999' : '00:00:00'}`)
  return Number.isNaN(date.getTime()) ? '' : date.toISOString()
}

export function LiveTriggerPage({ route }) {
  const { t, navigate } = usePanel()
  const compact = useCompactTriggerLayout()
  const initial = useRef(trgUrlState())
  const [filter, setFilter] = useState(initial.current.filter)
  const [query, setQuery] = useState(initial.current.q)
  const [q, setQ] = useState(initial.current.q)
  const [repo, setRepo] = useState(initial.current.repo)
  const [reason, setReason] = useState(initial.current.reason)
  const [from, setFrom] = useState(initial.current.from)
  const [to, setTo] = useState(initial.current.to)
  const [offset, setOffset] = useState(initial.current.offset)
  useEffect(() => {
    const timer = setTimeout(() => { setQ(query); setRepo(repo); setReason(reason) }, 300)
    return () => clearTimeout(timer)
  }, [query, repo, reason])
  useEffect(() => { setOffset(0) }, [filter, q, repo, reason, from, to])
  // Keep the filter (chip selection) plus the free-text filter in our own URL params; the host route (including the
  // selected Thread) is untouched.
  useEffect(() => {
    try {
      const url = new URL(window.location.href)
      if (filter !== THREAD_FILTERS[0]) url.searchParams.set(TRG_URL_KEYS.filter, filter)
      else url.searchParams.delete(TRG_URL_KEYS.filter)
      if (q) url.searchParams.set(TRG_URL_KEYS.q, q); else url.searchParams.delete(TRG_URL_KEYS.q)
      for (const [key, value] of [['repo', repo], ['reason', reason], ['from', from], ['to', to]]) {
        if (value) url.searchParams.set(TRG_URL_KEYS[key], value); else url.searchParams.delete(TRG_URL_KEYS[key])
      }
      if (offset > 0) url.searchParams.set(TRG_URL_KEYS.offset, String(offset))
      else url.searchParams.delete(TRG_URL_KEYS.offset)
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    } catch { /* private mode */ }
  }, [filter, q, repo, reason, from, to, offset])
  useEffect(() => {
    const restore = () => {
      const next = trgUrlState()
      setFilter(next.filter)
      setQuery(next.q); setQ(next.q); setRepo(next.repo); setReason(next.reason)
      setFrom(next.from); setTo(next.to); setOffset(next.offset)
    }
    window.addEventListener('popstate', restore)
    return () => window.removeEventListener('popstate', restore)
  }, [])
  const { data, error, reload } = useLiveResource('engine/threads',
    { filter, q, repo, reason, from: trgDayBound(from), to: trgDayBound(to, true), offset, limit: TRG_PAGE_SIZE })
  // AC-07: opening a Thread in the single-pane layout (or a Ticket from its detail) hides/replaces the list; the
  // position is remembered before that and restored when the list is shown again.
  const previousRouteId = useRef(route?.id)
  useEffect(() => {
    const had = previousRouteId.current
    const has = route?.id
    previousRouteId.current = has
    if (had && !has) window.requestAnimationFrame(restoreTriggerScroll)
    else if (!had && has) rememberTriggerScroll()
  }, [route?.id])
  useEffect(() => () => { rememberTriggerScroll() }, [])
  const restoredTriggerScroll = useRef(false)
  useEffect(() => {
    if (restoredTriggerScroll.current || !data) return
    restoredTriggerScroll.current = true
    window.requestAnimationFrame(restoreTriggerScroll)
  }, [data])
  // The watched-chat titles live on the shared status model; they turn a raw octo key into a readable list title.
  const { data: status } = usePanelData()
  const octoConfig = status?.config?.octo
  const routeId = route?.id
  const items = Array.isArray(data?.items) ? data.items : []
  const counts = data?.counts ?? {}
  const selected = routeId ?? items[0]?.key
  // One Tab stop for the whole list: the selected row (or the first one) is the tabbable row; ↑/↓/Home/End move
  // focus between rows so 50 rows do not add 50 tab stops (P2).
  const tabbableKey = items.some(row => row.key === selected) ? selected : items[0]?.key
  // While the 300ms debounce catches up the list still shows the previous result; expose that to assistive tech
  // instead of silently swapping rows under it (P3).
  const filtering = query !== q

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
    title: pt(t, 'trg.filterCount', { count: counts[value] ?? 0 }),
    description: pt(t, 'trg.filterCount', { count: counts[value] ?? 0 }) }))
  const total = Number.isFinite(data.total) ? data.total : items.length
  const pageFrom = items.length ? offset + 1 : 0
  const pageTo = Math.min(offset + items.length, total)
  const list = h('div', { className: 'sa-pane sa-pane-aside' },
    h(Section, { title: pt(t, 'trg.title'), count: total,
      action: h(IconButton, { icon: h(Icon, { name: 'refresh', size: 16 }), label: pt(t, 'trg.refresh'),
        onClick: () => { void reload() } }) },
      h(SegmentedControl, { options, value: filter, onChange: chooseFilter, label: pt(t, 'trg.filter'),
        className: 'sa-segmented-chips' }),
      h(Input, { value: query, placeholder: pt(t, 'trg.searchPlaceholder'), label: pt(t, 'trg.search'),
        onChange: event => setQuery(event?.target?.value ?? '') }),
      h(Input, { value: repo, placeholder: pt(t, 'trg.repoPlaceholder'), label: pt(t, 'trg.repo'),
        onChange: event => setRepo(event?.target?.value ?? '') }),
      h(Input, { value: reason, placeholder: pt(t, 'trg.reasonPlaceholder'), label: pt(t, 'trg.reason'),
        onChange: event => setReason(event?.target?.value ?? '') }),
      h(Input, { type: 'date', value: from, label: pt(t, 'trg.from'),
        onChange: event => setFrom(event?.target?.value ?? '') }),
      h(Input, { type: 'date', value: to, label: pt(t, 'trg.to'),
        onChange: event => setTo(event?.target?.value ?? '') }),
      error ? h(ErrorState, { error, onRetry: reload }) : null,
      h('div', { 'aria-busy': filtering ? 'true' : undefined },
        h('span', { className: 'sa-sr-only', role: 'status', 'aria-live': 'polite' }, filtering ? t('loading') : ''),
        items.length
          ? h('ul', { className: 'sa-list' }, items.map(row => h(ThreadListRow, { key: row.key, row, compact,
            // In the single-pane layout the first row is not "selected" until the route carries its key; a grey row
            // with no visible detail would otherwise promise a state the screen is not showing.
            selected: compact ? row.key === routeId : row.key === selected,
            tabbable: row.key === tabbableKey,
            onOpen: () => openThread(row.key), octoConfig })))
          : h(Hint, null, pt(t, 'trg.noneInFilter'))),
      items.length
        ? h('div', { className: 'sa-pagination' },
          h(Button, { variant: 'ghost', size: 'sm', disabled: offset <= 0,
            onClick: () => setOffset(Math.max(0, offset - TRG_PAGE_SIZE)) }, pt(t, 'trg.prev')),
          h('span', { className: 'sa-hint', role: 'status' }, pt(t, 'trg.pageInfo', { from: pageFrom, to: pageTo, total })),
          h(Button, { variant: 'ghost', size: 'sm', disabled: offset + items.length >= total,
            onClick: () => setOffset(offset + TRG_PAGE_SIZE) }, pt(t, 'trg.next')))
        : null))
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
