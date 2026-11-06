/* Panel model: one status document the six pages consume, plus a generic resource poller and the full engine
   action set. Pages must never poll `engine/status` themselves — App owns exactly one model (30-shell) and hands
   it down through PanelState, so a 30s tick updates the header and every page together. */

/** Actions over the live engine. Every page calls these instead of building its own fetch calls. */
function useEngineActions(call) {
  return useMemo(() => ({
    poll: ({ dryRun = true } = {}) => call('POST engine/poll', { body: { dryRun } }),
    reloadConfig: () => call('POST engine/reload'),
    checkUat: async () => (await call('POST engine/uat-check')).uat,
    // `repoId` routes a manual Ticket to one of the configured repositories (contract §12.2); omitted = defaultRepo.
    createTicket: ({ title, body, repoId }) => call('POST engine/ticket', { body: { title, body, ...(repoId ? { repoId } : {}) } }),
    runTicket: (id, { dryRun = true, wait = false } = {}) => call('POST engine/ticket/:id/run', { id, body: { dryRun, wait } }),
    publishTicket: (id, commitMessage) => call('POST engine/ticket/:id/publish', { id, body: commitMessage ? { commitMessage } : {} }),
    refreshCi: (id) => call('POST engine/ticket/:id/ci', { id }),
    verifyTicket: (id) => call('POST engine/ticket/:id/verify', { id }),
    // Human acceptance of a deployed UAT build: records the sign-off so the ticket leaves "needs you".
    acceptTicket: (id, { ok = true, note } = {}) => call('POST engine/ticket/:id/accept', { id, body: { ok, note } }),
    // Hide a failed/unused Ticket and clean its local worktree + branch (host does the cleanup before dismissing).
    dismissTicket: (id, note) => call('POST engine/ticket/:id/dismiss', { id, body: note ? { note } : {} }),
    patchSettings: (patch) => call('POST engine/settings', { body: patch }),
    // Store one repository's GitLab token in the token file live.json declares for it (never echoed back).
    saveRepoToken: (repoId, token) => call('POST engine/repo/:id/token', { id: repoId, body: { token } }),
    pause: (paused) => call('POST engine/settings', { body: { paused } }),
    // Kept for callers of the old single-key setter; new code should use patchSettings.
    updateSetting: (key, value) => call('POST engine/settings', { body: { [key]: value } }),
  }), [call])
}

/**
 * The panel status model (GET engine/status), polled once by App.
 * → { data, error, reload, updatedAt, actions }; `updatedAt` is the last successful read, even when the payload
 * did not change (the envelope stamps every poll so a heartbeat is visible in the header).
 */
function usePanelModel(intervalMs = 30000) {
  const { call } = usePanel()
  const actions = useEngineActions(call)
  const load = useCallback(() => call('GET engine/status').then(status => ({ status, at: new Date().toISOString() })), [call])
  const { data: envelope, error, reload } = usePoll(load, [load], intervalMs)
  return useMemo(() => ({ data: envelope?.status, error, reload, updatedAt: envelope?.at, actions }),
    [envelope, error, reload, actions])
}

/**
 * Generic read-only resource poller for lists and details: GET `route` with `params`.
 * `params` fills both the `:placeholders` and the query string (an unknown query key is ignored by the host), so
 * a page can pass `{ filter }`, `{ kind, window }`, `{ id }` or `{ key }` uniformly.
 * → { data, error, loading, reload }; a failed refresh keeps the last good data so the view does not flash.
 */
function useLiveResource(route, params, intervalMs = 30000) {
  const { call } = usePanel()
  const request = params ?? {}
  const key = `${route}|${JSON.stringify(request)}`
  const load = useCallback(() => {
    const pathNames = [...route.matchAll(/:(\w+)/g)].map(match => match[1])
    const query = Object.fromEntries(Object.entries(request).filter(([name]) => !pathNames.includes(name)))
    return call(`GET ${route}`, { ...request, query })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable identity of params
  }, [call, route, key])
  const { data, error, reload } = usePoll(load, [load], intervalMs)
  return { data, error, loading: data === undefined && !error, reload }
}
