/* Jumping from a run to the DSH Session it executed in.
   `uiWorkspace.openSession` is the same call the sidebar row makes (dsh-client-ui-workspace/src/client/navigation.ts),
   but a bare call fails in two ways that look like this panel is broken:
   - it runs `sessions.retain()` synchronously, which throws `unknown session` while the Session list is still loading
     (phase !== 'ready') — i.e. right after a page load, when the panel is already clickable;
   - the Workspace controller drops a selection whose Session is archived (`clearArchivedCurrent`), so a finished run's
     Session would open and then bounce the reader back to the landing page.
   So: give the list a moment, restore an archived Session first, then hand the jump over. The list is only an
   early-warning device, never a gate: a Session it does not name yet (or names while still loading) must still reach
   the host, whose `retain` call is what actually decides — and whose refusal is the only accurate failure.
   The host decides from the same list it projects (`sessions.retain` → `resolveTarget`: a Session that is neither
   resident nor in `summaries` is `unknown session`), and a Session a live run opened a moment ago may not be in that
   pull yet. So a refusal asks the catalog for a fresh pull (the implementation has `refresh()` even though the
   documented face does not), buys one short wait for the push that names it, then makes one more attempt; when the list
   never names it, the host's own reason travels with the message instead of a guess about loading. */

export const SESSION_OPEN_UNSUPPORTED = 'session-open-unsupported'
export const SESSION_OPEN_UNAVAILABLE = 'session-open-unavailable'

const LIST_WAIT_MS = 6000
/** A run that is still going creates its Session seconds before the reader clicks; the second look is short. */
const RETRY_WAIT_MS = 3000

/** @param {string} code @returns {Error & { code: string }} */
function openerError(code) {
  const failure = new Error(code)
  return Object.assign(failure, { code })
}

/**
 * What the Session list knows about `sessionId` right now: `ready` (listed, or a list shape we cannot read),
 * `missing` (the list is ready without it: deleted), `loading`, or `unknown` (no list service).
 * @param {{ list?: any } | undefined} sessions
 * @param {string} sessionId
 * @returns {'ready' | 'missing' | 'loading' | 'unknown'}
 */
function listState(sessions, sessionId) {
  const snapshot = sessions?.list?.getSnapshot?.()
  if (!snapshot || typeof snapshot !== 'object') return 'unknown'
  if (snapshot.phase !== 'ready') return 'loading'
  const byId = snapshot.byId
  if (!byId || typeof byId !== 'object') return 'ready'
  return byId[sessionId] === undefined ? 'missing' : 'ready'
}

/**
 * Resolve as soon as the list stops loading, or on the timeout with whatever state it reached.
 * @param {{ list?: any } | undefined} sessions
 * @param {string} sessionId
 * @param {number} timeoutMs
 * @returns {Promise<'ready' | 'missing' | 'loading' | 'unknown'>}
 */
function waitListState(sessions, sessionId, timeoutMs) {
  const list = sessions?.list
  const state = listState(sessions, sessionId)
  if (state !== 'loading') return Promise.resolve(state)
  if (typeof list?.subscribe !== 'function' || typeof list?.getSnapshot !== 'function') return Promise.resolve(state)
  return new Promise(resolve => {
    let done = false
    let stop = () => {}
    let timer
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      resolve(value)
    }
    stop = list.subscribe(() => {
      const next = listState(sessions, sessionId)
      if (next !== 'loading') finish(next)
    })
    if (!done) timer = setTimeout(() => finish(listState(sessions, sessionId)), timeoutMs)
  })
}

/**
 * Wait until the list names `sessionId`, giving a push that is still in flight its chance.
 * The public Session face has no `refresh` (`sessions.list` is Host-pushed), so waiting is the only lever; the state
 * "ready with the row absent" is also what the Host's own `retain` reads, hence the retry only pays off after a push.
 * @param {{ list?: any } | undefined} sessions
 * @param {string} sessionId
 * @param {number} timeoutMs
 * @returns {Promise<boolean>} whether the list named it
 */
function waitListed(sessions, sessionId, timeoutMs) {
  const listed = () => listState(sessions, sessionId) === 'ready'
  if (listed()) return Promise.resolve(true)
  const list = sessions?.list
  if (typeof list?.subscribe !== 'function') return Promise.resolve(false)
  return new Promise(resolve => {
    let done = false
    let stop = () => {}
    let timer
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      stop()
      resolve(value)
    }
    stop = list.subscribe(() => { if (listed()) finish(true) })
    if (!done) timer = setTimeout(() => finish(listed()), timeoutMs)
  })
}

/**
 * Ask the client's Session catalog for a fresh `session.list` pull, when this build exposes one.
 * The documented face has no `refresh` (`sessions.list` is Host-pushed, and its own comment says the client only waits),
 * while the implementation does: `service.refresh()` → `manager.refreshList()`. A Session a WORKING run created can be
 * on disk without ever reaching a push — the pull is then the only lever this panel has. Absence is not an error: the
 * wait that follows still gives a push its chance, and the host's refusal stays the accurate failure.
 * @param {{ refresh?: any } | undefined} sessions
 * @returns {Promise<boolean>} whether a pull was requested
 */
async function refreshList(sessions) {
  if (typeof sessions?.refresh !== 'function') return false
  try {
    await sessions.refresh()
    return true
  } catch {
    return false
  }
}

/**
 * Build the panel's Session opener: the one action that leaves this panel for DSH's own conversation view.
 * Every service is read at call time, so a host that provides them late (or never) is handled per click.
 * @param {any} ctx client plugin context: `uiWorkspace`, `sessions` and `workspaces` are re-read on every call
 * @param {{ waitMs?: number, retryMs?: number }} [options] `waitMs`/`retryMs` override the two waits (tests)
 * @returns {(sessionId: string) => Promise<void>}
 */
export function createSessionOpener(ctx, options = {}) {
  const waitMs = typeof options.waitMs === 'number' ? options.waitMs : LIST_WAIT_MS
  const retryMs = typeof options.retryMs === 'number' ? options.retryMs : RETRY_WAIT_MS
  return async function openSession(sessionId) {
    const workspace = ctx?.get?.('uiWorkspace')
    if (typeof workspace?.openSession !== 'function') throw openerError(SESSION_OPEN_UNSUPPORTED)
    // A selection made while the list is still loading is dropped by the host, so wait for it to settle — but a list
    // that stays pending, or that does not name this Session yet, is not a reason to refuse: the host is the authority
    // (it also knows Sessions this list has not projected), and its refusal is what the reader should be told about.
    await waitListState(ctx?.get?.('sessions'), sessionId, waitMs)
    const open = async () => {
      const archived = ctx?.get?.('workspaces')?.list?.getSnapshot?.()?.archivedSessionIds
      if (Array.isArray(archived) && archived.includes(sessionId) && typeof workspace.unarchiveSession === 'function') {
        await workspace.unarchiveSession(sessionId)
      }
      workspace.openSession(sessionId)
    }
    let failure
    try {
      await open()
      return
    } catch (refusal) {
      failure = refusal
    }
    // A Session a WORKING run created can be on disk before the list names it, and the Host's retain decides from that
    // same list (`sessions.retain` → `resolveTarget`) — which never learns about it when nothing pushed the row. Ask for
    // a fresh pull first, then wait for the row, then try once more; a list that never names it is telling the truth,
    // and the Host's own words are what the reader gets.
    const sessions = ctx?.get?.('sessions')
    await refreshList(sessions)
    if (!await waitListed(sessions, sessionId, retryMs)) {
      throw Object.assign(openerError(SESSION_OPEN_UNAVAILABLE), { cause: failure })
    }
    try {
      await open()
    } catch (second) {
      throw Object.assign(openerError(SESSION_OPEN_UNAVAILABLE), { cause: second })
    }
  }
}

/**
 * User-facing text for a failure raised by {@link createSessionOpener}.
 * @param {unknown} failure
 * @param {(key: string, values?: Record<string, any>) => string} t
 */
export function openSessionMessage(failure, t) {
  const code = failure && typeof failure === 'object' ? /** @type {any} */ (failure).code : undefined
  if (code === SESSION_OPEN_UNSUPPORTED) return t('openSessionUnsupported')
  if (code === SESSION_OPEN_UNAVAILABLE) {
    const text = t('openSessionUnavailable')
    const cause = /** @type {any} */ (failure).cause
    // The host's own words, because "not in the list" alone cannot tell a deleted Session from a stale projection.
    const reason = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
    return reason.trim() ? `${text}${t('openSessionReason', { reason: reason.trim() })}` : text
  }
  return failure instanceof Error ? failure.message : String(failure)
}
