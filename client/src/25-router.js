/* Panel routes: one tab per domain page, records addressed by id/key. A deep-linked record (ticket id on
   overview/execution, thread key on trigger) is kept in the route; the location survives a page reload through
   sessionStorage. */

const TABS = ['overview', 'source', 'trigger', 'eval', 'execution', 'settings']
const HOME = { page: 'overview' }
const ROUTE_ID_MAX = 200

/** Keep a stored/linked route only when the page is one of ours; a record id is kept as a bounded string. */
function parseRoute(value) {
  const page = value?.page
  if (!TABS.includes(page)) return undefined
  const raw = value?.id
  const id = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, ROUTE_ID_MAX) : undefined
  // An optional run pins the run an Eval/source record points at; the detail scrolls to it without changing the page.
  const rawRun = value?.run
  const run = typeof rawRun === 'string' && rawRun.trim() ? rawRun.trim().slice(0, ROUTE_ID_MAX) : undefined
  return id ? { page, id, ...(run ? { run } : {}) } : { page }
}
const ROUTE_KEY = 'superagent-panel/route'
function initialLocation() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(ROUTE_KEY) ?? 'null')
    const route = parseRoute(stored?.route)
    if (route) return { route, stack: Array.isArray(stored.stack) ? stored.stack.flatMap(item => parseRoute(item) ?? []) : [] }
  } catch { /* route memory is a convenience */ }
  return { route: HOME, stack: [] }
}
function remember(location) {
  try { sessionStorage.setItem(ROUTE_KEY, JSON.stringify(location)) } catch { /* private mode: ignore */ }
}
/** Header back-button label: a record id reads as its noun, otherwise the destination tab. */
const routeLabel = (t, route) => route.id ? t(route.page === 'trigger' ? 'term.thread' : 'term.ticket') : t(`tab.${route.page}`)
const detailOf = (route, page) => route.page === page && route.id ? route.id : undefined
