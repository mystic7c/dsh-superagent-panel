/* Panel routes: one tab per domain page, records addressed by id/key. A deep-linked record (ticket id on
   overview/execution, thread key on trigger) is kept in the route. The location survives a reload twice: the URL
   fragment is the shareable copy (`#sa={"page":...,"id":...}`), sessionStorage is the fallback for hosts that rewrite
   or strip the fragment. */

const TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings']
const HOME = { page: 'overview' }
const ROUTE_ID_MAX = 200
const ROUTE_KEY = 'superagent-panel/route'
/** This panel's fragment prefix. Any other fragment belongs to the host SPA and is neither read nor overwritten. */
const ROUTE_HASH = 'sa'
/** Optional in-view route fields (execution `stage`, settings `group`/`focus`) are bounded strings, so a pasted link
    restores the same view and a crafted fragment cannot grow the route without limit. */
const ROUTE_FIELD_MAX = 120
const ROUTE_FIELDS_MAX = 8
const CORE_ROUTE_KEYS = new Set(['page', 'id', 'run'])
const ROUTE_FIELD_KEY = /^[a-zA-Z][\w.-]{0,23}$/

/** Keep the non-core keys a page put on the route (in-view filters/sections) without accepting arbitrary values. */
function routeFields(value) {
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
function parseRoute(value) {
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
const sameRoute = (a, b) => Boolean(a && b) && a.page === b.page
  && (a.id ?? '') === (b.id ?? '') && (a.run ?? '') === (b.run ?? '')

/** Same route value including the in-view fields: used to ignore a `hashchange` that does not move the panel. */
function routeEquivalent(a, b) {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  for (const key of keys) {
    if (String(a?.[key] ?? '') !== String(b?.[key] ?? '')) return false
  }
  return true
}

/** The route in the address bar, when the fragment is this panel's; `undefined` for the host's own fragments. */
const routeFromHash = () => parseRoute(readHashState(ROUTE_HASH))

/* Captured once, when the bundle is evaluated (i.e. on a real page load), so the initial hash is read before the host's
   router has a chance to rewrite it. The panel can remount inside the host SPA later; by then the tab's sessionStorage
   copy is newer (the host may have stripped our fragment), so the link is released after the first mount and every later
   mount falls back to the remembered route. */
const LINKED_ROUTE = routeFromHash()
let linkedRoutePending = Boolean(LINKED_ROUTE)
/** Set once App has mounted: subsequent mounts prefer the in-tab route memory over the page-load fragment. */
function releaseLinkedRoute() { linkedRoutePending = false }

function initialLocation() {
  let stored
  try { stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null') } catch { stored = undefined }
  const route = parseRoute(stored?.route)
  const stack = Array.isArray(stored?.stack) ? stored.stack.flatMap(item => parseRoute(item) ?? []) : []
  // A shared link wins on a cold open; a reload of a screen this panel itself linked keeps its back stack.
  if (linkedRoutePending && LINKED_ROUTE) return { route: LINKED_ROUTE, stack: route && sameRoute(route, LINKED_ROUTE) ? stack : [] }
  return route ? { route, stack } : { route: HOME, stack: [] }
}
function remember(location) {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch { /* private mode: ignore */ }
  // Mirror the route into the panel's own fragment so a reload or a pasted URL lands on the same screen. replaceState
  // keeps the host's history untouched; if the host strips the fragment, sessionStorage above still carries the route.
  writeHashState(ROUTE_HASH, location.route)
}
/** Header back-button label: a record id reads as its noun, otherwise the destination tab. */
const routeLabel = (t, route) => route.id ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)
const detailOf = (route, page) => route.page === page && route.id ? route.id : undefined
