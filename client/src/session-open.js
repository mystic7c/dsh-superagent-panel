/* Jumping from a run to the DSH Session it executed in.
   `uiWorkspace.openSession` is the same call the sidebar row makes (dsh-client-ui-workspace/src/client/navigation.ts),
   but a bare call fails in two ways that look like this panel is broken:
   - it runs `sessions.retain()` synchronously, which throws `unknown session` while the Session list is still loading
     (phase !== 'ready') — i.e. right after a page load, when the panel is already clickable;
   - the Workspace controller drops a selection whose Session is archived (`clearArchivedCurrent`), so a finished run's
     Session would open and then bounce the reader back to the landing page.
   So: give the list a moment, restore an archived Session first, then hand the jump over. The list is only an
   early-warning device, never a gate: a Session it does not name yet (or names while still loading) must still reach
   the host, whose `retain` call is what actually decides — and whose refusal is the only accurate failure. */

export const SESSION_OPEN_UNSUPPORTED = 'session-open-unsupported'
export const SESSION_OPEN_UNAVAILABLE = 'session-open-unavailable'

const LIST_WAIT_MS = 6000

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
 * Build the panel's Session opener: the one action that leaves this panel for DSH's own conversation view.
 * Every service is read at call time, so a host that provides them late (or never) is handled per click.
 * @param {any} ctx client plugin context: `uiWorkspace`, `sessions` and `workspaces` are re-read on every call
 * @param {{ waitMs?: number }} [options] `waitMs` overrides the Session-list wait (tests)
 * @returns {(sessionId: string) => Promise<void>}
 */
export function createSessionOpener(ctx, options = {}) {
  const waitMs = typeof options.waitMs === 'number' ? options.waitMs : LIST_WAIT_MS
  return async function openSession(sessionId) {
    const workspace = ctx?.get?.('uiWorkspace')
    if (typeof workspace?.openSession !== 'function') throw openerError(SESSION_OPEN_UNSUPPORTED)
    // A selection made while the list is still loading is dropped by the host, so wait for it to settle — but a list
    // that stays pending, or that does not name this Session yet, is not a reason to refuse: the host is the authority
    // (it also knows Sessions this list has not projected), and its refusal is what the reader should be told about.
    await waitListState(ctx?.get?.('sessions'), sessionId, waitMs)
    try {
      const archived = ctx?.get?.('workspaces')?.list?.getSnapshot?.()?.archivedSessionIds
      if (Array.isArray(archived) && archived.includes(sessionId) && typeof workspace.unarchiveSession === 'function') {
        await workspace.unarchiveSession(sessionId)
      }
      workspace.openSession(sessionId)
    } catch (failure) {
      throw Object.assign(openerError(SESSION_OPEN_UNAVAILABLE), { cause: failure })
    }
  }
}

/**
 * User-facing text for a failure raised by {@link createSessionOpener}.
 * @param {unknown} failure
 * @param {(key: string) => string} t
 */
export function openSessionMessage(failure, t) {
  const code = failure && typeof failure === 'object' ? /** @type {any} */ (failure).code : undefined
  if (code === SESSION_OPEN_UNSUPPORTED) return t('openSessionUnsupported')
  if (code === SESSION_OPEN_UNAVAILABLE) return t('openSessionUnavailable')
  return failure instanceof Error ? failure.message : String(failure)
}
