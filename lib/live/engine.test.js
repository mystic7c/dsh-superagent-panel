import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveState, emptyLiveState } from './state.js'
import { Engine } from './engine.js'

async function dir() { return mkdtemp(join(tmpdir(), 'superagent-engine-')) }

const baseConfig = {
  enabled: true, repo: '/tmp/repo', baseBranch: 'dev', featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', pollSeconds: 10,
  octo: { cliPath: '/bin/true', tokenFile: '', intake: 'events', watchChatIds: ['chat-1'], channelType: 2, allowSenderIds: [],
    requireMention: false, syncLimit: 100, backfill: false, replyPrefix: 'Superagent:' },
  gitlab: { baseUrl: 'https://gitlab.example', project: 'g/p', targetBranch: 'dev', createMr: 'api' },
  eval: { mode: 'rules' }, executor: { enabled: false },
}

function fakeClient(events) {
  const calls = { poll: [], ack: [], send: [] }
  return {
    calls,
    async pollEvents(options) { calls.poll.push(options); return { events, identity: { bot_kind: 'user_bot' } } },
    async ack(id) { calls.ack.push(id); return { acknowledged: true } },
    async sendText(message) { calls.send.push(message); return { raw: {} } },
  }
}

const groupEvent = (over = {}) => ({ eventId: 101, eventType: 'message', messageId: 9001, seq: 3, fromUid: 'user-1',
  channelId: 'chat-1', channelType: 2, contentType: 1, text: '修复：收款单银行账户必填校验', at: '2026-11-04T03:00:00.000Z', ...over })

test('dry run reports matches without acking, writing or advancing the cursor', async () => {
  const stateDir = await dir()
  try {
    const client = fakeClient([groupEvent()])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: baseConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const result = await engine.pollOnce({ dryRun: true })
    assert.equal(result.fetched, 1)
    assert.equal(result.accepted.length, 1)
    assert.equal(result.acked, 0)
    assert.deepEqual(client.calls.ack, [])
    assert.equal(engine.state.cursor, 0)
    assert.equal(Object.keys(engine.state.tickets).length, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a live poll creates thread/trigger/decision/ticket, acks every event and persists the cursor', async () => {
  const stateDir = await dir()
  try {
    const client = fakeClient([groupEvent(), groupEvent({ eventId: 102, messageId: 9002, fromUid: 'bot', text: '生产 DDL 请执行' })])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: baseConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.accepted.length, 1)
    assert.equal(result.ignored.length, 1)
    assert.equal(result.acked, 2)
    assert.deepEqual(client.calls.ack, [101, 102])
    assert.equal(engine.state.cursor, 102)
    assert.equal(Object.keys(engine.state.threads).length, 1)
    assert.equal(Object.keys(engine.state.triggers).length, 2)
    assert.equal(Object.keys(engine.state.tickets).length, 1)
    const ticket = Object.values(engine.state.tickets)[0]
    assert.equal(ticket.status, 'queued')
    assert.equal(ticket.targetBranch, 'dev')
    assert.equal(ticket.origin.channelId, 'chat-1')
    const reloaded = new LiveState(stateDir)
    await reloaded.load()
    assert.equal(reloaded.cursor, 102)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('events without a channel id are skipped and acked (DM noise)', async () => {
  const stateDir = await dir()
  try {
    const client = fakeClient([groupEvent({ eventId: 103, channelId: undefined, channelType: undefined })])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: baseConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.skipped.length, 1)
    assert.equal(result.skipped[0].reason, 'channel-missing')
    assert.equal(result.acked, 1)
    assert.equal(engine.state.cursor, 103)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('disabled live.json refuses a live poll but allows a dry run', async () => {
  const stateDir = await dir()
  try {
    const client = fakeClient([groupEvent()])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const refused = await engine.pollOnce({ dryRun: false })
    assert.match(refused.error, /enabled=false/)
    assert.deepEqual(client.calls.poll, [])
    const dry = await engine.pollOnce({ dryRun: true })
    assert.equal(dry.accepted.length, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('state stores an empty document and serializes atomic writes', async () => {
  const stateDir = await dir()
  try {
    const state = new LiveState(stateDir)
    await state.load()
    assert.deepEqual(Object.keys(state.tickets), [])
    await Promise.all([state.atomic(doc => { doc.cursor = 5 }), state.atomic(doc => { doc.events.received += 1 })])
    assert.equal(state.cursor, 5)
    assert.equal(state.events.received, 1)
    const text = await readFile(state.file, 'utf8')
    assert.equal(JSON.parse(text).cursor, 5)
    assert.equal(emptyLiveState().schemaVersion, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Sync intake (group message sync) — the mode used for the DSH_BOT group.
// ---------------------------------------------------------------------------

const syncConfig = { ...baseConfig, octo: { ...baseConfig.octo, intake: 'sync', allowSenderIds: ['user-1'],
  chatTitles: { 'chat-1': 'SuperAgent' } } }

const syncedMessage = (seq, over = {}) => ({ messageSeq: seq, messageId: 8000 + seq, fromUid: 'user-1',
  channelId: 'chat-1', channelType: 2, contentType: 1, text: `修复：第 ${seq} 条请求`, at: '2026-11-04T03:00:00.000Z', ...over })

function fakeSyncClient(messages) {
  const calls = { sync: [] }
  return {
    calls,
    async syncMessages(options) { calls.sync.push(options); return { messages: messages(), identity: { bot_kind: 'user_bot' } } },
  }
}

test('sync intake initializes each watched chat instead of replaying its history', async () => {
  const stateDir = await dir()
  try {
    const client = fakeSyncClient(() => [syncedMessage(101), syncedMessage(102), syncedMessage(103)])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: syncConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.mode, 'sync')
    assert.equal(result.initialized.length, 1)
    assert.equal(result.initialized[0].cursor, 103)
    assert.equal(result.accepted.length, 0)
    assert.deepEqual(engine.state.state.channelCursors, { 'chat-1': 103 })
    assert.equal(Object.keys(engine.state.tickets).length, 0)
    assert.deepEqual(client.calls.sync[0], { channelId: 'chat-1', channelType: 2, limit: 100 })
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('sync intake turns only messages newer than the cursor into tickets', async () => {
  const stateDir = await dir()
  try {
    let messages = [syncedMessage(101)]
    const client = fakeSyncClient(() => messages)
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: syncConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    await engine.pollOnce({ dryRun: false }) // initialize at 101
    messages = [syncedMessage(101), syncedMessage(102), syncedMessage(103)]
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.accepted.length, 2)
    assert.equal(Object.keys(engine.state.tickets).length, 2)
    assert.equal(engine.state.state.channelCursors['chat-1'], 103)
    const ticket = Object.values(engine.state.tickets)[0]
    assert.equal(ticket.origin.channelId, 'chat-1')
    assert.equal(ticket.title.startsWith('修复：第'), true)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('sync intake skips system, non-text, bot and self-reply messages', async () => {
  const stateDir = await dir()
  try {
    const messages = [
      syncedMessage(101),
      syncedMessage(102, { fromUid: '' }),
      syncedMessage(103, { contentType: 2, text: '' }),
      syncedMessage(104, { fromUid: 'bot-uid' }),
      syncedMessage(99, { fromUid: 'helper_bot' }),
      syncedMessage(105, { text: 'Superagent: 已提交 MR' }),
      syncedMessage(106, { fromUid: 'user-1' }),
    ]
    const client = fakeSyncClient(() => messages)
    const config = { ...syncConfig, octo: { ...syncConfig.octo, botUid: 'bot-uid' } }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    await engine.pollOnce({ dryRun: false }) // initialize at 106
    messages.push(syncedMessage(107))
    messages.push(syncedMessage(108, { fromUid: '' }))
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.accepted.length, 1) // only 107
    assert.equal(engine.state.state.channelCursors['chat-1'], 108)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('sync intake refuses a live poll without a sender allowlist', async () => {
  const stateDir = await dir()
  try {
    const client = fakeSyncClient(() => [syncedMessage(101)])
    const config = { ...syncConfig, octo: { ...syncConfig.octo, allowSenderIds: [] } }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const refused = await engine.pollOnce({ dryRun: false })
    assert.match(refused.error, /allowSenderIds/)
    assert.deepEqual(client.calls.sync, [])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('sync dry run fetches and reports without persisting cursors', async () => {
  const stateDir = await dir()
  try {
    const client = fakeSyncClient(() => [syncedMessage(101), syncedMessage(102)])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: syncConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const result = await engine.pollOnce({ dryRun: true })
    assert.equal(result.dryRun, true)
    assert.equal(result.fetched, 2)
    assert.equal(result.initialized.length, 1)
    assert.deepEqual(engine.state.state.channelCursors, {})
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('refresh follows live.json without reloading the plugin', async () => {
  const stateDir = await dir()
  const previous = { enabled: false }
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: previous.enabled }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => fakeClient([]),
    } })
    await engine.load()
    assert.equal((await engine.refresh()).enabled, false)
    assert.equal(engine.lastStatus.phase, 'disabled')
    previous.enabled = true
    assert.equal((await engine.refresh()).enabled, true)
    assert.ok(engine.timer)
    previous.enabled = false
    assert.equal((await engine.refresh()).enabled, false)
    assert.equal(engine.timer, undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('load marks runs and tickets left working by a plugin reload as failed', async () => {
  const stateDir = await dir()
  try {
    const deps = {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => fakeClient([]),
    }
    const engine = new Engine({ stateDir, log: () => {}, deps })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.runs = [{ id: 'run_stale', ticketId: 'tkt_stale', status: 'running', steps: [] }]
      doc.tickets = { tkt_stale: { id: 'tkt_stale', status: 'working', assignments: [{ state: 'running' }] } }
    })
    const reloaded = new Engine({ stateDir, log: () => {}, deps })
    await reloaded.load()
    assert.equal(reloaded.state.runs[0].status, 'failed')
    assert.match(reloaded.state.runs[0].error, /interrupted/)
    assert.equal(reloaded.state.runs[0].steps.at(-1).name, 'reconcile')
    assert.equal(reloaded.state.tickets.tkt_stale.status, 'failed')
    assert.equal(reloaded.state.tickets.tkt_stale.assignments[0].state, 'ended')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('verifyOpenTickets only checks tickets with a commit and an open acceptance state', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const deps = {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => fakeClient([]),
      verifyTicket: async ({ ticketId }) => { calls.push(ticketId); return { status: 'merged', verification: { merged: true } } },
    }
    const engine = new Engine({ stateDir, log: () => {}, deps })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = {
        tkt_a: { id: 'tkt_a', status: 'mr-open', links: { commit: 'aaa' } },
        tkt_b: { id: 'tkt_b', status: 'deployed', links: { commit: 'bbb' } },
        tkt_c: { id: 'tkt_c', status: 'mr-open', links: {} },
        tkt_d: { id: 'tkt_d', status: 'deploy-pending', links: { commit: 'ddd' } },
      }
    })
    const results = await engine.verifyOpenTickets()
    assert.deepEqual(calls.sort(), ['tkt_a', 'tkt_d'])
    assert.equal(results.length, 2)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('verifyOpenTickets refreshes GitLab CI first when a token is configured', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const deps = {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined }),
      createClient: async () => fakeClient([]),
      refreshTicketCi: async ({ ticketId }) => { calls.push(`ci:${ticketId}`); return { status: 'ci-passed' } },
      verifyTicket: async ({ ticketId }) => { calls.push(`verify:${ticketId}`); return { status: 'ci-passed', verification: { merged: false } } },
    }
    const engine = new Engine({ stateDir, log: () => {}, deps })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = { tkt_ci_loop: { id: 'tkt_ci_loop', status: 'ci-pending', links: { commit: 'abc', mergeRequest: { iid: 7 } } } }
    })
    await engine.verifyOpenTickets()
    assert.deepEqual(calls, ['ci:tkt_ci_loop', 'verify:tkt_ci_loop'])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('autoRun dispatches accepted tickets through the executor', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const config = { ...baseConfig, enabled: true, executor: { enabled: true, autoRun: true, allowPush: true,
      gates: [], timeoutMs: 60_000, gateTimeoutMs: 60_000 },
      octo: { ...baseConfig.octo, intake: 'sync', allowSenderIds: ['user-1'], backfill: true } }
    const client = { syncMessages: async () => ({ messages: [syncedMessage(301)], identity: { bot_kind: 'user_bot' } }) }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
      executeTicket: async ({ ticketId, dryRun }) => { calls.push({ ticketId, dryRun }); return { status: 'mr-open' } },
    } })
    await engine.load()
    await engine.pollOnce({ dryRun: false })
    await engine.dispatchQueue
    assert.equal(calls.length, 1)
    assert.equal(calls[0].dryRun, false)
    assert.equal(calls[0].ticketId, Object.keys(engine.state.tickets)[0])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Paused switch (contract §4): live polling, verification and auto-run stop; dry runs keep working.
// ---------------------------------------------------------------------------

test('a paused engine refuses live polls but still runs dry polls', async () => {
  const stateDir = await dir()
  try {
    const client = fakeClient([groupEvent()])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, paused: true }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const refused = await engine.pollOnce({ dryRun: false })
    assert.deepEqual(refused, { error: 'paused', dryRun: false, mode: 'events' })
    assert.deepEqual(client.calls.poll, [])
    const dry = await engine.pollOnce({ dryRun: true })
    assert.equal(dry.accepted.length, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a paused engine skips verifyOpenTickets and auto execution', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, paused: true,
        executor: { enabled: true, autoRun: true, allowPush: true, gates: [] } }, tokens: { octo: 'tok', gitlab: 'glpat' }, error: undefined }),
      verifyTicket: async ({ ticketId }) => { calls.push(`verify:${ticketId}`); return { status: 'deployed' } },
      refreshTicketCi: async ({ ticketId }) => { calls.push(`ci:${ticketId}`); return { status: 'deployed' } },
      executeTicket: async ({ ticketId }) => { calls.push(`run:${ticketId}`); return { status: 'mr-open' } },
    } })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = { tkt_paused: { id: 'tkt_paused', status: 'ci-pending', links: { commit: 'abc', mergeRequest: { iid: 7 } } } }
      doc.ticketOrder = ['tkt_paused']
    })
    assert.deepEqual(await engine.verifyOpenTickets(), [])
    assert.deepEqual(await engine.autoExecute(['tkt_paused']), [])
    assert.deepEqual(calls, [])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('the automatic schedule skips polling while paused and keeps the timer alive', async (t) => {
  const stateDir = await dir()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const client = fakeClient([groupEvent()])
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: true, paused: true }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    await engine.start()
    assert.ok(engine.timer)
    t.mock.timers.tick(1000)
    assert.deepEqual(client.calls.poll, [])
    assert.ok(engine.timer)
  } finally {
    t.mock.timers.reset()
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Panel data contract (contract §4): status increments and the read-only collection views.
// ---------------------------------------------------------------------------

const HOUR_MS = 3_600_000
const hoursAgo = (hours) => new Date(Date.now() - Math.round(hours * HOUR_MS)).toISOString()

const panelConfig = {
  ...baseConfig,
  enabled: true,
  paused: false,
  octo: { ...baseConfig.octo, watchChatIds: ['chat-1'], chatTitles: { 'chat-1': 'SuperAgent' }, allowAnyHuman: true },
  gitlab: { ...baseConfig.gitlab, project: 'g/p', baseUrl: 'https://gitlab.example', targetBranch: 'dev', uatUrl: 'https://uat.example' },
  executor: { enabled: true, autoRun: true, allowPush: true, gates: [], timeoutMs: 60_000, gateTimeoutMs: 60_000 },
}
const panelTokens = { octo: 'tok', gitlab: 'glpat-test' }

/** Two threads, three trigger/decision pairs, and tickets across every stage group. */
async function seedPanelState(engine) {
  await engine.state.atomic((doc) => {
    const first = { key: 'octo:chat-1', source: 'octo', title: 'SuperAgent', createdAt: hoursAgo(3), lastAt: hoursAgo(1) }
    const second = { key: 'octo:chat-2', source: 'octo', title: '其他群', createdAt: hoursAgo(31), lastAt: hoursAgo(30) }
    const trigger = (id, at, threadKey, text, decisionId, fanout) => ({ id, source: 'octo', at, threads: [threadKey], human: true,
      text, disposition: { decisionId, fanout } })
    const decision = (id, triggerId, at, threadKey, kind, ticketId, code) => ({ id, triggerIds: [triggerId], threadKey, at, kind,
      strength: 'explicit', rules: [], ...(ticketId ? { ticketId } : {}), ...(code ? { reason: [{ code }] } : {}) })
    doc.threads = { [first.key]: first, [second.key]: second }
    doc.triggers = {
      trg_ok: trigger('trg_ok', hoursAgo(1), first.key, '修复：应收发票列表列顺序', 'dec_ok', ['tkt_wait']),
      trg_risk: trigger('trg_risk', hoursAgo(2), first.key, '生产库执行 DDL 并合并到 dev', 'dec_risk', []),
      trg_old: trigger('trg_old', hoursAgo(30), second.key, '旧消息', 'dec_old', ['tkt_done']),
    }
    doc.decisions = {
      dec_ok: decision('dec_ok', 'trg_ok', hoursAgo(1), first.key, 'accept', 'tkt_wait'),
      dec_risk: decision('dec_risk', 'trg_risk', hoursAgo(2), first.key, 'ignore', undefined, 'highRisk'),
      dec_old: decision('dec_old', 'trg_old', hoursAgo(30), second.key, 'accept', 'tkt_done'),
    }
    doc.tickets = {
      tkt_wait: { id: 'tkt_wait', title: '修复：应收发票列表列顺序', status: 'deployed', createdAt: hoursAgo(1), updatedAt: hoursAgo(0.5),
        origin: { threadKey: first.key, triggerId: 'trg_ok', decisionId: 'dec_ok' }, links: { verification: { at: hoursAgo(0.5) } } },
      tkt_run: { id: 'tkt_run', title: '处理中的需求', status: 'working', createdAt: hoursAgo(2), updatedAt: hoursAgo(2),
        origin: { threadKey: first.key } },
      tkt_fail: { id: 'tkt_fail', title: '失败工单', status: 'failed', createdAt: hoursAgo(41), updatedAt: hoursAgo(41),
        origin: { threadKey: second.key } },
      tkt_done: { id: 'tkt_done', title: '已关闭工单', status: 'closed', createdAt: hoursAgo(30), updatedAt: hoursAgo(30),
        origin: { threadKey: second.key, triggerId: 'trg_old', decisionId: 'dec_old' } },
    }
    doc.ticketOrder = ['tkt_fail', 'tkt_done', 'tkt_run', 'tkt_wait']
    doc.runs = [
      { id: 'run_reply', ticketId: 'tkt_wait', status: 'mr-open', startedAt: hoursAgo(0.4), replyError: 'octo send failed' },
      { id: 'run_verify', ticketId: 'tkt_wait', status: 'deployed', startedAt: hoursAgo(0.6) },
      { id: 'run_old', ticketId: 'tkt_done', status: 'deployed', startedAt: hoursAgo(30) },
    ]
    doc.sources = { octo: { state: 'ready', at: hoursAgo(0.1) }, gitlab: { state: 'idle' } }
  })
}

async function seededPanelEngine() {
  const stateDir = await dir()
  const config = { ...panelConfig }
  const engine = new Engine({ stateDir, log: () => {}, deps: {
    loadConfig: () => ({ exists: true, config, tokens: panelTokens, error: undefined }),
  } })
  await engine.load()
  await seedPanelState(engine)
  return { engine, stateDir, config }
}

test('status reports the contract §4 increments derived from the document', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const status = engine.status()
    assert.equal(status.paused, false)
    assert.equal(status.engine.paused, false)
    assert.equal(status.config.paused, false)
    assert.deepEqual(status.counts, { threads: 2, triggers: 3, decisions: 3, tickets: 4, runs: 3, needsHuman: 2, open: 3 })
    assert.deepEqual(status.load, { running: 1, queued: 0, waiting: 1, failed: 1, paused: false })
    assert.ok(Number.isFinite(Date.parse(status.flow24h.windowStart)))
    assert.ok(status.flow24h.windowStart <= new Date().toISOString())
    const { windowStart, ...flow } = status.flow24h
    assert.deepEqual(flow, { received: 2, filtered: 1, judged: 2, accepted: 1, tickets: 2, dropped: 1 })
    assert.equal(status.eval.mode, 'rules')
    assert.deepEqual(status.eval.rules.map(rule => rule.id), ['R1', 'R2', 'R3'])
    assert.match(status.prompts.workerBrief, /Ticket: tkt_wait — 修复：应收发票列表列顺序/)
    assert.equal(status.prompts.note, '内置提示词，随代码版本')
    // Existing status fields stay reachable and keep their shape.
    assert.equal(status.engine.phase, engine.lastStatus.phase)
    assert.equal(status.tickets.length, 4)
    assert.equal(status.runs.length, 3)
    assert.equal(status.triggers.length, 3)
    assert.equal(status.threads.length, 2)
    assert.equal(status.decisions.length, 3)

    assert.equal(status.sources.length, 2)
    const [octo, gitlab] = status.sources
    assert.equal(octo.id, 'octo')
    assert.equal(octo.kind, 'source')
    assert.equal(octo.state, 'ready')
    assert.equal(octo.enabled, true)
    assert.deepEqual(octo.stats, { received: 2, filtered: 1, accepted: 1 })
    assert.deepEqual(octo.config, { watchChatIds: ['chat-1'], chatTitles: { 'chat-1': 'SuperAgent' },
      allowAnyHuman: true, allowSenderIds: [], chatRepos: {}, defaultRepo: undefined })
    assert.deepEqual(octo.filtered, [{ id: 'trg_risk', at: engine.state.triggers.trg_risk.at,
      text: '生产库执行 DDL 并合并到 dev', reasonCode: 'highRisk', reason: '命中高风险主题（生产 / DDL / 合并 / 密钥）',
      threadKey: 'octo:chat-1', decisionId: 'dec_risk' }])
    assert.equal(gitlab.id, 'gitlab:p')
    assert.equal(gitlab.repoId, 'p')
    assert.equal(gitlab.kind, 'execution')
    assert.equal(gitlab.state, 'ready')
    assert.equal(gitlab.enabled, true)
    assert.deepEqual(gitlab.stats, { tickets: 4, mrOpen: 0, deployed: 1, failed: 1 })
    assert.equal(gitlab.config.tokenConfigured, true)
    assert.equal(gitlab.lastAt, engine.state.tickets.tkt_wait.links.verification.at)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a paused config is reflected immediately by status, load and tickets', async () => {
  const stateDir = await dir()
  try {
    const holder = { paused: false }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...panelConfig, paused: holder.paused }, tokens: panelTokens, error: undefined }),
    } })
    await engine.load()
    assert.equal(engine.status().paused, false)
    assert.equal(engine.ticketsView().paused, false)
    holder.paused = true
    const paused = engine.status()
    assert.equal(paused.paused, true)
    assert.equal(paused.engine.paused, true)
    assert.equal(paused.config.paused, true)
    assert.equal(paused.load.paused, true)
    assert.equal(engine.ticketsView().paused, true)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('ticketsView groups raw tickets into the five stage groups', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const all = engine.ticketsView()
    assert.deepEqual(all.counts, { all: 4, queued: 0, working: 1, waiting: 1, failed: 1, done: 1 })
    assert.deepEqual(all.items.map(ticket => ticket.id), ['tkt_wait', 'tkt_run', 'tkt_done', 'tkt_fail'])
    assert.deepEqual(engine.ticketsView({ stage: 'waiting' }).items.map(ticket => ticket.id), ['tkt_wait'])
    assert.deepEqual(engine.ticketsView({ stage: 'working' }).items.map(ticket => ticket.id), ['tkt_run'])
    assert.deepEqual(engine.ticketsView({ stage: 'failed' }).items.map(ticket => ticket.id), ['tkt_fail'])
    assert.deepEqual(engine.ticketsView({ stage: 'done' }).items.map(ticket => ticket.id), ['tkt_done'])
    assert.deepEqual(engine.ticketsView({ stage: 'queued' }).items, [])
    // An unknown stage is lenient and behaves like `all` instead of hiding every ticket.
    assert.equal(engine.ticketsView({ stage: 'bogus' }).items.length, 4)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('ticketView joins runs, trigger, decision and thread; unknown ids return undefined', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const detail = engine.ticketView('tkt_wait')
    assert.equal(detail.ticket.id, 'tkt_wait')
    assert.deepEqual(detail.runs.map(run => run.id), ['run_reply', 'run_verify'])
    assert.equal(detail.trigger.id, 'trg_ok')
    assert.equal(detail.decision.id, 'dec_ok')
    assert.equal(detail.thread.key, 'octo:chat-1')
    assert.equal(engine.ticketView('tkt_missing'), undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('threadsView filters subscribed/recent threads and counts every view', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const all = engine.threadsView()
    assert.deepEqual(all.counts, { all: 2, subscribed: 2, recent: 1, new: 1 })
    assert.deepEqual(all.items.map(row => row.key), ['octo:chat-1', 'octo:chat-2'])
    assert.deepEqual(Object.keys(all.items[0]).sort(),
      ['createdAt', 'decisionKind', 'key', 'lastAt', 'source', 'state', 'ticketIds', 'title', 'triggerCount'])
    assert.equal(all.items[0].triggerCount, 2)
    assert.equal(all.items[0].decisionKind, 'accept')
    assert.equal(all.items[0].state, 'subscribed')
    assert.equal(all.items[0].source, 'octo')
    assert.deepEqual([...all.items[0].ticketIds].sort(), ['tkt_run', 'tkt_wait'])
    assert.equal(all.items[1].triggerCount, 1)
    assert.deepEqual([...all.items[1].ticketIds].sort(), ['tkt_done', 'tkt_fail'])
    assert.deepEqual(engine.threadsView({ filter: 'recent' }).items.map(row => row.key), ['octo:chat-1'])
    assert.deepEqual(engine.threadsView({ filter: 'new' }).items.map(row => row.key), ['octo:chat-1'])
    assert.equal(engine.threadsView({ filter: 'subscribed' }).items.length, 2)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('threadView returns facts plus ordered triggers/decisions/tickets; unknown keys return undefined', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const detail = engine.threadView('octo:chat-1')
    assert.equal(detail.thread.title, 'SuperAgent')
    assert.deepEqual(detail.triggers.map(trigger => trigger.id), ['trg_risk', 'trg_ok'])
    assert.deepEqual(detail.decisions.map(decision => decision.id), ['dec_ok', 'dec_risk'])
    assert.deepEqual(detail.tickets.map(ticket => ticket.id), ['tkt_wait', 'tkt_run'])
    assert.equal(detail.facts.source, 'octo')
    assert.equal(detail.facts.channelId, 'chat-1')
    assert.equal(detail.facts.triggerCount, 2)
    assert.equal(detail.facts.decisionCount, 2)
    assert.equal(detail.facts.ticketCount, 2)
    assert.deepEqual(detail.facts.lastDecision, { id: 'dec_ok', kind: 'accept', at: engine.state.decisions.dec_ok.at })
    assert.equal(engine.threadView('octo:missing'), undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('decisionsView filters by kind/window and paginates while counts stay tab-stable', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const all = engine.decisionsView()
    assert.deepEqual(all.counts, { all: 3, accept: 2, reopen: 0, stop: 0, ignore: 1, unavailable: 0 })
    assert.equal(all.total, 3)
    assert.deepEqual(all.items.map(decision => decision.id), ['dec_ok', 'dec_risk', 'dec_old'])
    const accepted = engine.decisionsView({ kind: 'accept' })
    assert.equal(accepted.total, 2)
    assert.deepEqual(accepted.items.map(decision => decision.id), ['dec_ok', 'dec_old'])
    assert.equal(accepted.counts.all, 3)
    const recent = engine.decisionsView({ window: '24h' })
    assert.equal(recent.total, 2)
    assert.deepEqual(recent.counts, { all: 2, accept: 1, reopen: 0, stop: 0, ignore: 1, unavailable: 0 })
    const page = engine.decisionsView({ offset: 1, limit: 1 })
    assert.deepEqual(page.items.map(decision => decision.id), ['dec_risk'])
    assert.equal(page.total, 3)
    assert.equal(engine.decisionsView({ kind: 'reopen' }).total, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// Multi-repository execution surface (#12).
// ---------------------------------------------------------------------------

const multiRepoConfig = () => ({ ...panelConfig, defaultRepo: 'demo-legacy-repo',
  octo: { ...panelConfig.octo, watchChatIds: ['chat-1', 'chat-ebs'],
    chatRepos: { 'chat-1': 'demo-legacy-repo', 'chat-ebs': 'ebs' } },
  repos: [
    { id: 'demo-legacy-repo', name: 'demo-legacy-repo', kind: 'web', repo: '/repo/demo-legacy-repo', baseBranch: 'dev', featurePrefix: 'feature/',
      worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed', gates: ['standards'],
      gitlab: { baseUrl: 'https://gitlab.example', project: 'g/demo-legacy-repo', targetBranch: 'dev', tokenFile: '/tmp/ml.token',
        createMr: 'api', uatUrl: 'https://uat.example/', healthUrl: 'https://uat.example/health', verifySeconds: 120 } },
    { id: 'ebs', name: 'ebs', kind: 'oracle-ebs', repo: '/repo/ebs', baseBranch: 'develop', featurePrefix: 'feature/',
      worktreeRoot: '/tmp/wt', verifyMode: 'manual', acceptance: 'merged',
      prepareCommand: 'python3 scripts/local/export_cux_objects.py',
      postGatesCommand: 'python3 scripts/local/export_cux_objects.py',
      gates: [{ name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py --changed --base develop' }],
      gitlab: { baseUrl: 'https://gitlab.example', project: 'bpit/ebs', targetBranch: 'develop',
        tokenFile: '/tmp/ebs.token', createMr: 'api', ci: false } },
  ] })

test('multi-repo status: one execution card per repository, manual merges wait for a person, acceptance clears it', async () => {
  const stateDir = await dir()
  try {
    const config = multiRepoConfig()
    const tokens = { octo: 'tok', gitlab: 'tok-ml', repoTokens: { 'demo-legacy-repo': 'tok-ml', ebs: 'tok-ebs' } }
    const engine = new Engine({ stateDir, log: () => {}, deps: { loadConfig: () => ({ exists: true, config, tokens, error: undefined }) } })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = {
        tkt_web: { id: 'tkt_web', title: 'web 工单', status: 'deployed', repoId: 'demo-legacy-repo', createdAt: hoursAgo(1), updatedAt: hoursAgo(1),
          origin: { threadKey: 'octo:chat-1' }, links: { verification: { at: hoursAgo(1), merged: true } } },
        tkt_ebs: { id: 'tkt_ebs', title: 'ebs 工单', status: 'merged', repoId: 'ebs', createdAt: hoursAgo(2), updatedAt: hoursAgo(2),
          origin: { threadKey: 'octo:chat-ebs' }, links: { verification: { at: hoursAgo(2), merged: true } } },
      }
      doc.ticketOrder = ['tkt_ebs', 'tkt_web']
      doc.threads = { 'octo:chat-1': { key: 'octo:chat-1', title: 'SuperAgent', createdAt: hoursAgo(3), lastAt: hoursAgo(1) } }
    })
    const status = engine.status()
    assert.deepEqual(status.repos.map(repo => repo.id), ['demo-legacy-repo', 'ebs'])
    assert.equal(status.repos[1].verifyMode, 'manual')
    assert.deepEqual(status.sources.map(source => source.id), ['octo', 'gitlab:demo-legacy-repo', 'gitlab:ebs'])
    // A merged manual-repo ticket still needs a person, so both tickets count as waiting.
    assert.equal(status.counts.needsHuman, 2)
    assert.equal(status.load.waiting, 2)
    assert.equal(status.tickets.find(ticket => ticket.id === 'tkt_ebs').repoName, 'ebs')
    assert.equal(status.tickets.find(ticket => ticket.id === 'tkt_ebs').repoAcceptance, 'merged')

    const accepted = await engine.acceptTicket({ ticketId: 'tkt_ebs', ok: true })
    assert.equal(accepted.ticket.links.acceptance.ok, true)
    const after = engine.status()
    assert.equal(after.counts.needsHuman, 1)
    assert.equal(after.load.waiting, 1)
    // Rejecting before the merge is over is still refused by the same rule.
    const bad = await engine.acceptTicket({ ticketId: 'tkt_web', ok: true })
    assert.equal(bad.invalid, undefined) // deployed web ticket is acceptable
    const notReady = await engine.acceptTicket({ ticketId: 'tkt_unknown', ok: true })
    assert.equal(notReady.missing, true)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('routes an Octo chat to its repository and stamps the ticket', async () => {
  const stateDir = await dir()
  try {
    const config = multiRepoConfig()
    const tokens = { octo: 'tok', gitlab: 'tok-ml', repoTokens: { 'demo-legacy-repo': 'tok-ml', ebs: 'tok-ebs' } }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens, error: undefined }),
      createClient: async () => ({
        syncMessages: async () => ({ messages: [
          { channelId: 'chat-ebs', messageSeq: 7, fromUid: 'u1', contentType: 1, text: 'CUX 包体加一个日志', at: hoursAgo(0.1) }] }),
      }),
    } })
    await engine.load()
    await engine.state.atomic((doc) => { doc.channelCursors = { 'chat-ebs': 6 } })
    const result = await engine.pollSync({ exists: true, config, tokens }, { dryRun: false })
    assert.equal(result.accepted.length, 1)
    const ticket = Object.values(engine.state.tickets)[0]
    assert.equal(ticket.repoId, 'ebs')
  } finally { await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('auto-run forwards the host context to the executor (worker needs it)', async () => {
  const stateDir = await dir()
  try {
    const ctx = { id: 'host-ctx', get: name => ({ name }) }
    const seen = []
    const engine = new Engine({ stateDir, ctx, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...panelConfig, paused: false, executor: { ...panelConfig.executor, enabled: true, autoRun: true } },
        tokens: panelTokens, error: undefined }),
      executeTicket: async options => { seen.push(options); return { status: 'mr-open' } },
    } })
    await engine.load()
    await engine.autoExecute(['tkt_ctx'])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].ctx, ctx)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a SQL snippet is merged as context into the next explicit request', async () => {
  const stateDir = await dir()
  try {
    const messages = [
      syncedMessage(201, { at: '2026-11-04T02:58:00.000Z',
        text: 'SELECT Gcc.Segment1 公司,\n       Hou.Name 公司名称,\n       Gjh.Period_Name 期间' }),
      syncedMessage(202, { text: '依据这个SQL，写一个视图。要求：\n1、字段名用英文' }),
    ]
    const client = fakeSyncClient(() => messages)
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: syncConfig, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    await engine.state.atomic((doc) => { doc.channelCursors = { 'chat-1': 200 } })
    const result = await engine.pollSync({ exists: true, config: syncConfig, tokens: { octo: 'tok' } }, { dryRun: false })
    assert.equal(result.accepted.length, 1)
    assert.equal(result.ignored.length, 1)
    assert.equal(result.ignored[0].reason[0].code, 'contextOnly')
    const ticket = Object.values(engine.state.tickets)[0]
    assert.match(ticket.title, /依据这个SQL/)
    assert.match(ticket.body, /SELECT Gcc\.Segment1/)
    assert.match(ticket.body, /依据这个SQL/)
    assert.ok(ticket.body.indexOf('SELECT Gcc.Segment1') < ticket.body.indexOf('依据这个SQL'))
    assert.equal(ticket.origin.contextTriggerIds.length, 1)
    const contextDecision = Object.values(engine.state.decisions).find(decision => decision.kind === 'ignore')
    assert.equal(contextDecision.contextUsedBy, ticket.id)
  } finally { await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) }
})

test('a failed Ticket can be dismissed from the human queue; a deployed one cannot', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const dismissed = await engine.dismissTicket({ ticketId: 'tkt_fail', note: '重复工单' })
    assert.equal(dismissed.ticket.status, 'dismissed')
    assert.equal(dismissed.ticket.links.dismissed.note, '重复工单')
    assert.equal(engine.ticketsView({ stage: 'done' }).items.some(ticket => ticket.id === 'tkt_fail'), true)
    assert.equal(engine.ticketsView({ stage: 'failed' }).items.some(ticket => ticket.id === 'tkt_fail'), false)
    const invalid = await engine.dismissTicket({ ticketId: 'tkt_wait' })
    assert.ok(invalid.invalid)
    assert.equal((await engine.dismissTicket({ ticketId: 'nope' })).missing, true)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('dismissing a Ticket removes its worktree and local branch before hiding it', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: panelConfig, tokens: panelTokens, error: undefined }),
      removeWorktree: async options => { calls.push(options); return { worktreeRemoved: true, branchRemoved: true, branchKept: false } },
    } })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = { tkt_clean: { id: 'tkt_clean', title: '失败工单', status: 'failed', createdAt: hoursAgo(1), updatedAt: hoursAgo(1),
        repoId: 'demo-legacy-repo', origin: { threadKey: 'octo:chat-1' },
        links: { branch: 'feature/tkt_clean', worktree: '/tmp/wt/tkt_clean' } } }
      doc.ticketOrder = ['tkt_clean']
    })
    const result = await engine.dismissTicket({ ticketId: 'tkt_clean', note: '重复' })
    assert.equal(result.ticket.status, 'dismissed')
    assert.deepEqual(result.cleanup, { worktreeRemoved: true, branchRemoved: true, branchKept: false })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].path, '/tmp/wt/tkt_clean')
    assert.equal(calls[0].branch, 'feature/tkt_clean')
    assert.equal(result.ticket.links.cleanup.worktreeRemoved, true)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a cleanup failure keeps the Ticket visible instead of dismissing it silently', async () => {
  const stateDir = await dir()
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: panelConfig, tokens: panelTokens, error: undefined }),
      removeWorktree: async () => ({ worktreeRemoved: false, branchRemoved: false, branchKept: false }),
    } })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = { tkt_clean: { id: 'tkt_clean', title: '失败工单', status: 'failed', createdAt: hoursAgo(1), updatedAt: hoursAgo(1),
        repoId: 'demo-legacy-repo', origin: { threadKey: 'octo:chat-1' }, links: { branch: 'feature/tkt_clean' } } }
      doc.ticketOrder = ['tkt_clean']
    })
    const result = await engine.dismissTicket({ ticketId: 'tkt_clean' })
    assert.match(result.cleanupFailed, /无法删除本地分支/)
    assert.equal(engine.state.tickets.tkt_clean.status, 'failed')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('acceptance records the sign-off then cleans the local worktree and branch', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const config = { ...baseConfig, repos: [{ id: 'demo-legacy-repo', name: 'demo-legacy-repo', repo: '/tmp/repo', baseBranch: 'dev',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'demo-legacy-repo' }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      removeWorktree: async args => { calls.push(args); return { worktreeRemoved: true, branchRemoved: true, branchKept: false } },
    } })
    await engine.load()
    const ticket = { id: 'tkt_accept', title: 't', status: 'deployed', repoId: 'demo-legacy-repo',
      links: { branch: 'feature/tkt_accept', worktree: '/tmp/wt/tkt_accept' } }
    await engine.state.atomic(doc => { doc.tickets[ticket.id] = ticket })
    const result = await engine.acceptTicket({ ticketId: ticket.id, ok: true, note: 'UAT OK' })
    assert.equal(result.ticket.links.acceptance.ok, true)
    assert.deepEqual(calls, [{ repo: '/tmp/repo', path: '/tmp/wt/tkt_accept', branch: 'feature/tkt_accept', timeoutMs: 120_000 }])
    assert.equal(result.cleanup.worktreeRemoved, true)
    assert.equal(result.ticket.links.cleanup.worktreeRemoved, true)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a rejected acceptance keeps the worktree for the next fix', async () => {
  const stateDir = await dir()
  try {
    let calls = 0
    const config = { ...baseConfig, repos: [{ id: 'demo-legacy-repo', name: 'demo-legacy-repo', repo: '/tmp/repo', baseBranch: 'dev',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'demo-legacy-repo' }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      removeWorktree: async () => { calls += 1; return { worktreeRemoved: true, branchRemoved: true } },
    } })
    await engine.load()
    const ticket = { id: 'tkt_reject', title: 't', status: 'deployed', repoId: 'demo-legacy-repo',
      links: { branch: 'feature/tkt_reject', worktree: '/tmp/wt/tkt_reject' } }
    await engine.state.atomic(doc => { doc.tickets[ticket.id] = ticket })
    const result = await engine.acceptTicket({ ticketId: ticket.id, ok: false })
    assert.equal(result.ticket.links.acceptance.ok, false)
    assert.equal(calls, 0)
    assert.equal(result.cleanup, undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('acceptance survives a cleanup failure and reports it', async () => {
  const stateDir = await dir()
  try {
    const config = { ...baseConfig, repos: [{ id: 'demo-legacy-repo', name: 'demo-legacy-repo', repo: '/tmp/repo', baseBranch: 'dev',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'demo-legacy-repo' }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      removeWorktree: async () => { throw new Error('worktree busy') },
    } })
    await engine.load()
    const ticket = { id: 'tkt_busy', title: 't', status: 'deployed', repoId: 'demo-legacy-repo',
      links: { branch: 'feature/tkt_busy', worktree: '/tmp/wt/tkt_busy' } }
    await engine.state.atomic(doc => { doc.tickets[ticket.id] = ticket })
    const result = await engine.acceptTicket({ ticketId: ticket.id, ok: true })
    assert.equal(result.ticket.links.acceptance.ok, true)
    assert.equal(result.cleanup.failed, 'worktree busy')
    assert.equal(result.ticket.links.cleanup.failed, 'worktree busy')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})
