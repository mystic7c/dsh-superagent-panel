/* Panel model: one status document the six pages consume, plus a generic resource poller and the full engine
   action set. Pages must never poll `engine/status` themselves — App owns exactly one model (30-shell) and hands
   it down through PanelState, so a 30s tick updates the header and every page together. */

/** Actions over the live engine. Every page calls these instead of building its own fetch calls. */
function useEngineActions(call) {
  return useMemo(() => ({
    poll: ({ dryRun = true } = {}) => call('POST engine/poll', { body: { dryRun } }),
    reloadConfig: () => call('POST engine/reload'),
    checkUat: async () => (await call('POST engine/uat-check')).uat,
    // Draft routing preview (AC-01): same resolver as execution, no Ticket/run/write side effects.
    previewRoute: ({ title, body, selection } = {}) => call('POST engine/route',
      { body: { title, body, ...(selection ? { selection } : {}) } }),
    // `repoId` routes a manual Ticket to one of the configured repositories (contract §12.2); omitted = defaultRepo.
    // `route` persists a manual deliverable/backend choice; the host validates it and never bypasses capability limits.
    createTicket: ({ title, body, repoId, route }) => call('POST engine/ticket',
      { body: { title, body, ...(repoId ? { repoId } : {}), ...(route ? { route } : {}) } }),
    runTicket: (id, { dryRun = true, wait = false } = {}) => call('POST engine/ticket/:id/run', { id, body: { dryRun, wait } }),
    publishTicket: (id, commitMessage) => call('POST engine/ticket/:id/publish', { id, body: commitMessage ? { commitMessage } : {} }),
    refreshCi: (id) => call('POST engine/ticket/:id/ci', { id }),
    verifyTicket: (id) => call('POST engine/ticket/:id/verify', { id }),
    // Human acceptance of a deployed UAT build: records the sign-off so the ticket leaves "needs you". P1 adds
    // `intents` (unmet / new-idea / no-evidence) to a rejection so the executor knows why the round was sent back.
    acceptTicket: (id, { ok = true, note, intents } = {}) => call('POST engine/ticket/:id/accept',
      { id, body: { ok, note, ...(Array.isArray(intents) && intents.length ? { intents } : {}) } }),
    // P1 (§9): replay one filtered/failed raw signal through the current rules.
    replaySignal: (id) => call('POST engine/signal/:id/replay', { id }),
    // P1 §3.2: the on-demand worktree diff behind the Ticket detail's "view diff".
    ticketDiff: (id, { runId, path } = {}) => call('GET engine/ticket/:id/diff',
      { id, query: { ...(runId ? { runId } : {}), ...(path ? { path } : {}) } }),
    // Append one human requirement revision; the host starts a dry-run rerun on the same worktree.
    addRevision: (id, text) => call('POST engine/ticket/:id/revision', { id, body: { text } }),
    // P1 (§7): resume an interrupted run from its checkpoint (the host falls back to re-running the whole Ticket).
    resumeTicket: (id) => call('POST engine/ticket/:id/resume', { id }),
    // AC-02/03: cooperative stop. The host records the request and the executor stops at the next stage boundary.
    stopTicket: (id, { note } = {}) => call('POST engine/ticket/:id/stop', { id, body: { ...(note ? { note } : {}) } }),
    // P1 (§6.2): answer a parked question; the host re-runs the Ticket with every previous answer in context.
    answerTicket: (id, answer) => call('POST engine/ticket/:id/answer', { id, body: { answer } }),
    // P1 (§8.1): recent raw signals, read by the Source page (status/source/limit are optional filters).
    loadSignals: ({ status, source, limit } = {}) => call('GET engine/signals', { query: { status, source, limit } }),
    // P2-1: one Ticket's automation config (mode/enabled/intervalMinutes/at/maxExecutions patch; the host normalises).
    setAutomation: (id, patch) => call('POST engine/ticket/:id/automation', { id, body: patch ?? {} }),
    // P2-8: human quality label on one raw signal (correct | false_wake | missed_wake | cleared).
    labelSignal: (id, label, note) => call('POST engine/signal/:id/label',
      { id, body: { label, ...(note === undefined ? {} : { note }) } }),
    // Actionable inbox (P0 contract §2): read one item, resolve a non-blocking one, and fetch the list for the
    // overview. A blocking item can only be settled by its real action (gate/accept), never by resolveInbox.
    readInbox: (id) => call('POST engine/inbox/:id/read', { id }),
    resolveInbox: (id, { action, note } = {}) => call('POST engine/inbox/:id/resolve', { id, body: { action, note } }),
    loadInbox: () => call('GET engine/inbox'),
    // The three human decisions on a parked gate (P0-3): release skips the gate and delivers, retry re-runs the
    // gates, stop fails the Ticket. The host answers { run, ticket }.
    gateAction: (id, action, note) => call('POST engine/ticket/:id/gate',
      { id, body: { action, ...(note === undefined ? {} : { note }) } }),
    // Hide a failed/unused Ticket and clean its local worktree + branch (host does the cleanup before dismissing).
    dismissTicket: (id, note) => call('POST engine/ticket/:id/dismiss', { id, body: note ? { note } : {} }),
    patchSettings: (patch) => call('POST engine/settings', { body: patch }),
    // Store one repository's GitLab token in the token file live.json declares for it (never echoed back).
    saveRepoToken: (repoId, token) => call('POST engine/repo/:id/token', { id: repoId, body: { token } }),
    // AC-11: read-only probe; the server runs no configured gate and writes nothing.
    testConfig: repoId => call('POST engine/config/test', { body: { repoId } }),
    // Store the Octo bot token in the file live.json declares; same no-echo contract as the repo token.
    saveOctoToken: (token) => call('POST engine/octo/token', { body: { token } }),
    // Read-only list of the bot's Octo groups, used by the settings picker.
    listOctoGroups: () => call('GET engine/octo/groups'),
    // Add one repository definition to live.json; the token is saved separately on the repo card.
    addRepo: (repo, { makeDefault = false } = {}) => call('POST engine/repos', { body: { repo, makeDefault } }),
    updateRepo: (repoId, patch) => call('POST engine/repo/:id', { id: repoId, body: { patch } }),
    // Saved live.json versions and rollback; entries are configuration-only (no token values).
    settingsHistory: () => call('GET engine/settings/history'),
    restoreSettings: id => call(`POST engine/settings/history/${encodeURIComponent(id)}/restore`),
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
 * `options.enabled` (default true) keeps a hook unconditionally mounted while the endpoint is optional: a disabled
 * resource resolves `undefined` without a request, so an older host without `engine/inbox` is never 404-polled.
 * → { data, error, loading, reload }; a failed refresh keeps the last good data so the view does not flash.
 */
function useLiveResource(route, params, intervalMs = 30000, options = {}) {
  const { call } = usePanel()
  const enabled = options.enabled !== false
  const request = params ?? {}
  const key = `${route}|${JSON.stringify(request)}`
  const load = useCallback(() => {
    if (!enabled) return Promise.resolve(undefined)
    const pathNames = [...route.matchAll(/:(\w+)/g)].map(match => match[1])
    const query = Object.fromEntries(Object.entries(request).filter(([name]) => !pathNames.includes(name)))
    return call(`GET ${route}`, { ...request, query })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `key` is the stable identity of params
  }, [call, route, key, enabled])
  const { data, error, reload } = usePoll(load, [load], intervalMs)
  return { data, error, loading: data === undefined && !error, reload }
}
