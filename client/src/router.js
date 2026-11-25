/* Panel routes: one tab per domain page, records addressed by id/key. A deep-linked record (ticket id on
   overview/execution, thread key on trigger) is kept in the route. The location survives a reload twice: the URL
   fragment is the shareable copy (`#sa={"page":...,"id":...}`), sessionStorage is the fallback for hosts that rewrite
   or strip the fragment. */

import { readHashState, writeHashState } from "./util.js"
import { when } from "./i18n.js"
import { Panel, same } from "./api.js"
import { App, Header } from "./shell.js"
import { React, h } from "./react.js"
export const TABS = ['overview', 'source', 'trigger', 'eval', 'bots', 'execution', 'sessions', 'settings']
export const HOME = { page: 'overview' }
export const ROUTE_ID_MAX = 200
export const ROUTE_KEY = 'superagent-panel/route'
/** This panel's fragment prefix. Any other fragment belongs to the host SPA and is neither read nor overwritten. */
export const ROUTE_HASH = 'sa'
/** Optional in-view route fields (execution `stage`, settings `group`/`focus`) are bounded strings, so a pasted link
    restores the same view and a crafted fragment cannot grow the route without limit. */
export const ROUTE_FIELD_MAX = 120
export const ROUTE_FIELDS_MAX = 8
export const CORE_ROUTE_KEYS = new Set(['page', 'id', 'run'])
export const ROUTE_FIELD_KEY = /^[a-zA-Z][\w.-]{0,23}$/

/** Keep the non-core keys a page put on the route (in-view filters/sections) without accepting arbitrary values. */
export function routeFields(value) {
  const fields = {}
  if (!value || typeof value !== 'object') return fields
  let kept = 0
  for (const [key, raw] of Object.entries(value)) {
    if (kept >= ROUTE_FIELDS_MAX) break
    if (CORE_ROUTE_KEYS.has(key) || !ROUTE_FIELD_KEY.test(key) || typeof raw !== 'string' || !raw.trim()) continue
    fields[key] = raw.trim().slice(0, ROUTE_FIELD_MAX)
    kept += 1
  }
  return fields
}

/** Keep a stored/linked route only when the page is one of ours; a record id is kept as a bounded string. */
export function parseRoute(value) {
  const page = value?.page
  if (!TABS.includes(page)) return undefined
  const raw = value?.id
  const id = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, ROUTE_ID_MAX) : undefined
  // An optional run pins the run an Eval/source record points at; the detail scrolls to it without changing the page.
  const rawRun = value?.run
  const run = typeof rawRun === 'string' && rawRun.trim() ? rawRun.trim().slice(0, ROUTE_ID_MAX) : undefined
  const fields = routeFields(value)
  // A pinned run only makes sense with the record it belongs to (unchanged pre-deep-link behaviour).
  return { page, ...(id ? { id } : {}), ...(id && run ? { run } : {}), ...fields }
}

/** Same screen: page, record id and pinned run all match (decides whether a stored back stack belongs to a link). */
export const sameRoute = (a, b) => Boolean(a && b) && a.page === b.page
  && (a.id ?? '') === (b.id ?? '') && (a.run ?? '') === (b.run ?? '')

/** Same route value including the in-view fields: used to ignore a `hashchange` that does not move the panel. */
export function routeEquivalent(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const key of keys) {
    if (String(a?.[key] ?? '') !== String(b?.[key] ?? '')) return false
  }
  return true
}

/** The route in the address bar, when the fragment is this panel's; `undefined` for the host's own fragments. */
export const routeFromHash = () => parseRoute(readHashState(ROUTE_HASH))

/* Captured once, when the bundle is evaluated (i.e. on a real page load), so the initial hash is read before the host's
   router has a chance to rewrite it. The panel can remount inside the host SPA later; by then the tab's sessionStorage
   copy is newer (the host may have stripped our fragment), so the link is released after the first mount and every later
   mount falls back to the remembered route. */
export const LINKED_ROUTE = routeFromHash()
export let linkedRoutePending = Boolean(LINKED_ROUTE)
/** Set once App has mounted: subsequent mounts prefer the in-tab route memory over the page-load fragment. */
export function releaseLinkedRoute() { linkedRoutePending = false }

export function initialLocation() {
  let stored
  try { stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') } catch { stored = undefined }
  const route = parseRoute(stored?.route)
  const stack = Array.isArray(stored?.stack) ? stored.stack.flatMap(item => parseRoute(item) ?? []) : []
  // A shared link wins on a cold open; a reload of a screen this panel itself linked keeps its back stack.
  if (linkedRoutePending && LINKED_ROUTE) return { route: LINKED_ROUTE, stack: route && sameRoute(route, LINKED_ROUTE) ? stack : [] }
  return route ? { route, stack } : { route: HOME, stack: [] }
}
export function remember(location) {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch { /* private mode: ignore */ }
  // Mirror the route into the panel's own fragment so a reload or a pasted URL lands on the same screen. replaceState
  // keeps the host's history untouched; if the host strips the fragment, sessionStorage above still carries the route.
  writeHashState(ROUTE_HASH, location.route)
}
/** Header back-button label: a record id reads as its noun, otherwise the destination tab. */
export const routeLabel = (t, route) => route.id ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)
export const detailOf = (route, page) => route.page === page && route.id ? route.id : undefined

/* U-08: filters are view state of ONE page, not of the panel. Each page declares the query parameters it owns, and a
   tab switch deletes the parameters of the other pages (their prefixes are ours, so a host parameter is never touched). */
export const PAGE_QUERY_KEYS = {
  overview: [],
  source: ['srcQ', 'srcStatus', 'srcRepo', 'srcReason', 'srcFrom', 'srcTo', 'srcOffset'],
  trigger: ['trgFilter', 'trgQ', 'trgRepo', 'trgReason', 'trgFrom', 'trgTo', 'trgOffset'],
  eval: ['evalKind', 'evalWindow', 'evalQ', 'evalRepo', 'evalReason', 'evalFrom', 'evalTo', 'evalView', 'evalOffset'],
  execution: [],
  settings: [],
}
const OWNED_QUERY_KEYS = new Set(Object.values(PAGE_QUERY_KEYS).flat())

/* R2-15: the URL as it was when the bundle was evaluated. A host may consume its own parameter (an invite token) and
   rewrite the search string before the panel mounts; reading the location then would drop a shared filter link. */
export const INITIAL_SEARCH = (() => { try { return window.location.search } catch { return '' } })()
const initialSearchPending = new Set(TABS)

/** The query parameters a page should read on its first mount. The live URL wins whenever it carries one of this
    page's parameters; a page whose parameters the host stripped may fall back once to the copy captured at load. */
export function firstQueryParams(page) {
  let live
  try { live = new URLSearchParams(window.location.search) } catch { live = new URLSearchParams() }
  const keys = PAGE_QUERY_KEYS[page] ?? []
  if (!keys.length || keys.some(key => live.has(key)) || !initialSearchPending.has(page)) return live
  initialSearchPending.delete(page)
  try {
    const initial = new URLSearchParams(INITIAL_SEARCH)
    return keys.some(key => initial.has(key)) ? initial : live
  } catch { return live }
}

/* R2-08: filters belong to one page (U-08), so leaving a tab prunes them from the URL. Each page also remembers its
   last slice here, per tab, so coming back restores the filters and the page instead of resetting to the first page. */
export const PAGE_STATE_KEY = 'superagent-panel/page-state'
export function rememberPageState(page, values) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PAGE_STATE_KEY) ?? '{}')
    const all = raw && typeof raw === 'object' ? raw : {}
    all[page] = values
    sessionStorage.setItem(PAGE_STATE_KEY, JSON.stringify(all))
  } catch { /* private mode: the in-memory state still works */ }
}
export function recallPageState(page) {
  try {
    const raw = JSON.parse(sessionStorage.getItem(PAGE_STATE_KEY) ?? '{}')
    const value = raw && typeof raw === 'object' ? raw[page] : undefined
    return value && typeof value === 'object' ? value : undefined
  } catch { return undefined }
}
/** A page's first-mount filter state: a URL that carries the page's parameters wins (shared link), otherwise the
    remembered slice, otherwise the documented defaults. */
export function initialPageQuery(page, fromParams, defaults) {
  const params = firstQueryParams(page)
  const keys = PAGE_QUERY_KEYS[page] ?? []
  const fromUrl = fromParams(params)
  if (!keys.some(key => params.has(key))) {
    const remembered = recallPageState(page)
    if (remembered) return { ...defaults, ...fromUrl, ...remembered }
  }
  return { ...defaults, ...fromUrl }
}
/** Drop the query parameters that belong to other pages; the `#sa` fragment and host parameters are kept. replaceState
    is deliberate: a cleanup must not fire the routing events a real navigation would (no hashchange/popstate). */
export function prunePageQuery(page) {
  try {
    const allowed = new Set(PAGE_QUERY_KEYS[page] ?? [])
    const url = new URL(window.location.href)
    let changed = false
    for (const key of [...url.searchParams.keys()]) {
      if (allowed.has(key) || !OWNED_QUERY_KEYS.has(key)) continue
      url.searchParams.delete(key)
      changed = true
    }
    if (!changed) return false
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
    return true
  } catch { return false }
}
