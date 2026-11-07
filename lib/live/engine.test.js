import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LiveState, emptyLiveState } from './state.js'
import { Engine } from './engine.js'
import { normalizeRepos } from './repos.js'
import { pipelineVersion } from './eval.js'
import { emptyAcceptanceRecord } from './acceptance.js'
import { summarizeRun } from './operations.js'

async function dir() { return mkdtemp(join(tmpdir(), 'superagent-engine-')) }

const baseConfig = {
  enabled: true, repo: '/tmp/repo', baseBranch: 'dev', featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', pollSeconds: 10,
  octo: { cliPath: '/bin/true', tokenFile: '', intake: 'events', watchChatIds: ['chat-1'], channelType: 2, allowSenderIds: [], allowAnyHuman: true,
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
    const config = { ...syncConfig, octo: { ...syncConfig.octo, allowSenderIds: [], allowAnyHuman: false } }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const refused = await engine.pollOnce({ dryRun: false })
    assert.match(refused.error, /allowSenderIds/)
    const dryRefused = await engine.pollOnce({ dryRun: true })
    assert.match(dryRefused.error, /allowSenderIds/)
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

test('load reconciles interrupted runs gently instead of marking them failed (P0 §3.3)', async () => {
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
    const run = reloaded.state.runs[0]
    assert.equal(run.status, 'interrupted')
    assert.equal(run.stopReason, 'interrupted')
    assert.match(run.error, /interrupted/)
    assert.deepEqual(run.interruption, { canResume: false, interruptedAt: run.interruption.interruptedAt, reason: 'plugin reload' })
    assert.ok(Number.isFinite(Date.parse(run.interruption.interruptedAt)))
    assert.equal(run.steps.at(-1).name, 'reconcile')
    assert.equal(run.steps.at(-1).state, 'interrupted')
    // A working Ticket goes back to ready so the operator can retry it; its assignment is closed, not failed.
    assert.equal(reloaded.state.tickets.tkt_stale.status, 'ready')
    assert.equal(reloaded.state.tickets.tkt_stale.assignments[0].state, 'ended')
    assert.equal(reloaded.state.tickets.tkt_stale.assignments[0].report.state, 'interrupted')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('reconcile keeps human-parked runs and gate-blocked tickets and reports parked count', async () => {
  const stateDir = await dir()
  try {
    const deps = {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => fakeClient([]),
    }
    const engine = new Engine({ stateDir, log: () => {}, deps })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.runs = [
        { id: 'run_live', ticketId: 'tkt_live', status: 'running', steps: [] },
        { id: 'run_parked', ticketId: 'tkt_gate', status: 'waiting_for_human', gate: 'standards', steps: [] },
      ]
      doc.tickets = {
        tkt_live: { id: 'tkt_live', title: '进行中', status: 'working', assignments: [] },
        tkt_gate: { id: 'tkt_gate', title: '闸门中', status: 'gate-blocked', runId: 'run_parked',
          pendingGate: { name: 'standards', command: 'pnpm lint', exitCode: 1, timedOut: false, outputTail: 'lint failed',
            changedPaths: ['a.js'], at: hoursAgo(1) } },
        tkt_closed: { id: 'tkt_closed', title: '已关闭', status: 'closed' },
      }
    })
    const result = await engine.reconcile()
    assert.deepEqual(result, { runs: 1, tickets: 1, parked: 1 })
    assert.equal(engine.state.runs.find(item => item.id === 'run_live').status, 'interrupted')
    assert.equal(engine.state.runs.find(item => item.id === 'run_parked').status, 'waiting_for_human')
    assert.equal(engine.state.tickets.tkt_gate.status, 'gate-blocked')
    assert.equal(engine.state.tickets.tkt_gate.pendingGate.name, 'standards')
    assert.equal(engine.state.tickets.tkt_closed.status, 'closed')
    // Nothing to reconcile on a second pass: no extra write and the parked count still reports.
    assert.deepEqual(await engine.reconcile(), { runs: 0, tickets: 0, parked: 1 })
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

const multiRepoConfig = () => ({ ...panelConfig, defaultRepo: 'web-app',
  octo: { ...panelConfig.octo, watchChatIds: ['chat-1', 'chat-ebs'],
    chatRepos: { 'chat-1': 'web-app', 'chat-ebs': 'ebs' } },
  repos: [
    { id: 'web-app', name: 'web-app', kind: 'web', repo: '/repo/web-app', baseBranch: 'dev', featurePrefix: 'feature/',
      worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed', gates: ['standards'],
      gitlab: { baseUrl: 'https://gitlab.example', project: 'g/web-app', targetBranch: 'dev', tokenFile: '/tmp/ml.token',
        createMr: 'api', uatUrl: 'https://uat.example/', healthUrl: 'https://uat.example/health', verifySeconds: 120 } },
    { id: 'ebs', name: 'ebs', kind: 'oracle-ebs', repo: '/repo/ebs', baseBranch: 'develop', featurePrefix: 'feature/',
      worktreeRoot: '/tmp/wt', verifyMode: 'manual', acceptance: 'merged',
      prepareCommand: 'python3 scripts/local/export_cux_objects.py',
      postGatesCommand: 'python3 scripts/local/export_cux_objects.py',
      gates: [{ name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py --changed --base develop' }],
      gitlab: { baseUrl: 'https://gitlab.example', project: 'group/project-b', targetBranch: 'develop',
        tokenFile: '/tmp/ebs.token', createMr: 'api', ci: false } },
  ] })

test('multi-repo status: one execution card per repository, manual merges wait for a person, acceptance clears it', async () => {
  const stateDir = await dir()
  try {
    const config = multiRepoConfig()
    const tokens = { octo: 'tok', gitlab: 'tok-ml', repoTokens: { 'web-app': 'tok-ml', ebs: 'tok-ebs' } }
    const engine = new Engine({ stateDir, log: () => {}, deps: { loadConfig: () => ({ exists: true, config, tokens, error: undefined }) } })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = {
        tkt_web: { id: 'tkt_web', title: 'web 工单', status: 'deployed', repoId: 'web-app', createdAt: hoursAgo(1), updatedAt: hoursAgo(1),
          origin: { threadKey: 'octo:chat-1' }, links: { verification: { at: hoursAgo(1), merged: true } } },
        tkt_ebs: { id: 'tkt_ebs', title: 'ebs 工单', status: 'merged', repoId: 'ebs', createdAt: hoursAgo(2), updatedAt: hoursAgo(2),
          origin: { threadKey: 'octo:chat-ebs' }, links: { verification: { at: hoursAgo(2), merged: true } } },
      }
      doc.ticketOrder = ['tkt_ebs', 'tkt_web']
      doc.threads = { 'octo:chat-1': { key: 'octo:chat-1', title: 'SuperAgent', createdAt: hoursAgo(3), lastAt: hoursAgo(1) } }
    })
    const status = engine.status()
    assert.deepEqual(status.repos.map(repo => repo.id), ['web-app', 'ebs'])
    assert.equal(status.repos[1].verifyMode, 'manual')
    assert.deepEqual(status.sources.map(source => source.id), ['octo', 'gitlab:web-app', 'gitlab:ebs'])
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
    const tokens = { octo: 'tok', gitlab: 'tok-ml', repoTokens: { 'web-app': 'tok-ml', ebs: 'tok-ebs' } }
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
        repoId: 'web-app', origin: { threadKey: 'octo:chat-1' },
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
        repoId: 'web-app', origin: { threadKey: 'octo:chat-1' }, links: { branch: 'feature/tkt_clean' } } }
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
    const config = { ...baseConfig, repos: [{ id: 'web-app', name: 'web-app', repo: '/tmp/repo', baseBranch: 'dev',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'web-app' }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      removeWorktree: async args => { calls.push(args); return { worktreeRemoved: true, branchRemoved: true, branchKept: false } },
    } })
    await engine.load()
    const ticket = { id: 'tkt_accept', title: 't', status: 'deployed', repoId: 'web-app',
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
    const config = { ...baseConfig, repos: [{ id: 'web-app', name: 'web-app', repo: '/tmp/repo', baseBranch: 'dev',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'web-app' }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      removeWorktree: async () => { calls += 1; return { worktreeRemoved: true, branchRemoved: true } },
    } })
    await engine.load()
    const ticket = { id: 'tkt_reject', title: 't', status: 'deployed', repoId: 'web-app',
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
    const config = { ...baseConfig, repos: [{ id: 'web-app', name: 'web-app', repo: '/tmp/repo', baseBranch: 'dev',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'web-app' }
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      removeWorktree: async () => { throw new Error('worktree busy') },
    } })
    await engine.load()
    const ticket = { id: 'tkt_busy', title: 't', status: 'deployed', repoId: 'web-app',
      links: { branch: 'feature/tkt_busy', worktree: '/tmp/wt/tkt_busy' } }
    await engine.state.atomic(doc => { doc.tickets[ticket.id] = ticket })
    const result = await engine.acceptTicket({ ticketId: ticket.id, ok: true })
    assert.equal(result.ticket.links.acceptance.ok, true)
    assert.equal(result.cleanup.failed, 'worktree busy')
    assert.equal(result.ticket.links.cleanup.failed, 'worktree busy')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P0-5 actionable inbox: five derived kinds, frozen dedupe keys, read/resolve/auto-resolve.
// ---------------------------------------------------------------------------

const inboxConfig = () => normalizeRepos({
  ...panelConfig,
  enabled: true,
  paused: false,
  executor: { ...panelConfig.executor, enabled: true, autoRun: false },
  repos: [
    { id: 'web-app', name: 'web-app', kind: 'web', repo: '/repo/web-app', baseBranch: 'dev', featurePrefix: 'feature/',
      worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
      gitlab: { baseUrl: 'https://gitlab.example', project: 'g/web-app', targetBranch: 'dev', createMr: 'api',
        tokenFile: '/tmp/none.token' } },
    { id: 'ebs', name: 'ebs', kind: 'oracle-ebs', repo: '/repo/ebs', baseBranch: 'develop', featurePrefix: 'feature/',
      worktreeRoot: '/tmp/wt', verifyMode: 'manual', acceptance: 'merged',
      gitlab: { baseUrl: 'https://gitlab.example', project: 'g/ebs', targetBranch: 'develop', createMr: 'api',
        tokenFile: '/tmp/ebs.token' } },
  ],
  defaultRepo: 'web-app',
  octo: { ...panelConfig.octo, watchChatIds: ['chat-1'], chatTitles: { 'chat-1': 'SuperAgent' } },
})

// The first repository has no token on purpose: that is the "broken source" the inbox has to surface.
const inboxTokens = { octo: 'tok', repoTokens: { ebs: 'tok-ebs' } }

async function seedInboxState(engine) {
  await engine.state.atomic((doc) => {
    const pendingGate = { name: 'standards', command: 'pnpm lint', exitCode: 1, timedOut: false, durationMs: 1200,
      outputTail: '> lint\nfirst line\n最后一行：lint 失败', changedPaths: ['src/a.js'], at: hoursAgo(1) }
    doc.tickets = {
      tkt_gate: { id: 'tkt_gate', title: '闸门工单', status: 'gate-blocked', runId: 'run_gate', createdAt: hoursAgo(1),
        updatedAt: hoursAgo(1), pendingGate, links: { acceptance: { ok: false, at: hoursAgo(2) } } },
      tkt_accept: { id: 'tkt_accept', title: '部署工单', status: 'deployed', repoId: 'web-app', createdAt: hoursAgo(2), links: {} },
      tkt_merged: { id: 'tkt_merged', title: '合并工单', status: 'merged', repoId: 'ebs', createdAt: hoursAgo(3), links: {} },
      tkt_fail: { id: 'tkt_fail', title: '失败工单', status: 'failed', repoId: 'web-app', runId: 'run_fail',
        createdAt: hoursAgo(4), links: {} },
      tkt_norun: { id: 'tkt_norun', title: '无运行失败', status: 'failed', createdAt: hoursAgo(4.5), links: {} },
      tkt_acked: { id: 'tkt_acked', title: '已验收', status: 'deployed', repoId: 'web-app', createdAt: hoursAgo(5),
        links: { acceptance: { ok: true, at: hoursAgo(5) } } },
      tkt_dismissed: { id: 'tkt_dismissed', title: '已忽略', status: 'dismissed', createdAt: hoursAgo(6), links: {} },
    }
    doc.ticketOrder = Object.keys(doc.tickets)
    doc.runs = [
      { id: 'run_gate', ticketId: 'tkt_gate', status: 'waiting_for_human', stopReason: 'gate_failed', errorCode: 'gate_failed',
        startedAt: hoursAgo(1), pendingGate },
      { id: 'run_fail', ticketId: 'tkt_fail', status: 'failed', stopReason: 'worker_failed', errorCode: 'worker_failed',
        error: 'worker crashed: exit 1', startedAt: hoursAgo(4) },
    ]
    doc.lastError = 'octo sync failed: timeout'
    doc.sources = { octo: { state: 'ready', at: hoursAgo(0.1) }, gitlab: { state: 'idle' } }
  })
}

function seededInboxEngine(config = inboxConfig(), tokens = inboxTokens) {
  const stateDir = dir()
  return stateDir.then(async (dirPath) => {
    const engine = new Engine({ stateDir: dirPath, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens, error: undefined }),
    } })
    await engine.load()
    await seedInboxState(engine)
    await engine.refreshInbox()
    return { engine, stateDir: dirPath }
  })
}

test('refreshInbox derives the five kinds with frozen dedupe keys and a stable order (P0 §1.4)', async () => {
  const { engine, stateDir } = await seededInboxEngine()
  try {
    const view = engine.inboxView()
    const byKey = new Map(view.items.map(item => [item.dedupeKey, item]))
    assert.equal(byKey.size, view.items.length)

    const gate = byKey.get('gate:tkt_gate:run_gate')
    assert.ok(gate)
    assert.equal(gate.kind, 'gate')
    assert.equal(gate.blocking, true)
    assert.equal(gate.priority, 'urgent')
    assert.equal(gate.title, '闸门 standards 未通过，等待你处理')
    assert.equal(gate.summary, '最后一行：lint 失败')
    assert.deepEqual(gate.refs, { ticketId: 'tkt_gate', runId: 'run_gate' })

    const accept = byKey.get('accept:tkt_accept')
    assert.ok(accept)
    assert.equal(accept.kind, 'accept')
    assert.equal(accept.blocking, true)
    assert.equal(accept.priority, 'normal')
    assert.equal(accept.title, '工单「部署工单」等待验收')
    assert.equal(accept.summary, 'web-app · deployed')
    assert.deepEqual(accept.refs, { ticketId: 'tkt_accept', repoId: 'web-app' })
    // A repo whose acceptance happens after the merge also waits for a person even though the MR is merged.
    assert.equal(byKey.get('accept:tkt_merged').summary, 'ebs · merged')
    // Accepted / dismissed tickets never produce an accept item.
    assert.equal(byKey.has('accept:tkt_acked'), false)
    assert.equal(byKey.has('accept:tkt_dismissed'), false)

    const failure = byKey.get('failure:tkt_fail:run_fail')
    assert.equal(failure.kind, 'failure')
    assert.equal(failure.blocking, false)
    assert.equal(failure.priority, 'normal')
    assert.equal(failure.title, '工单「失败工单」执行失败')
    assert.equal(failure.summary, 'worker crashed: exit 1')
    // No current run → the contract's `none` fallback keeps the key stable.
    assert.equal(byKey.get('failure:tkt_norun:none').summary, '')

    const source = byKey.get('source:gitlab:web-app')
    assert.equal(source.kind, 'source')
    assert.equal(source.blocking, false)
    assert.equal(source.priority, 'high')
    assert.equal(source.title, 'web-app 来源异常')
    assert.match(source.summary, /GitLab token/)
    assert.deepEqual(source.refs, { repoId: 'web-app', sourceId: 'gitlab:web-app' })

    const engineItem = byKey.get('engine:last')
    assert.equal(engineItem.kind, 'engine')
    assert.equal(engineItem.blocking, false)
    assert.equal(engineItem.priority, 'high')
    assert.equal(engineItem.title, '引擎错误')
    assert.equal(engineItem.summary, 'octo sync failed: timeout')
    assert.deepEqual(engineItem.refs, {})

    // Ordering: blocking first, then priority rank, then newest created first inside one rank.
    const firstSystem = view.items.findIndex(item => item.blocking !== true)
    assert.ok(firstSystem > 0)
    assert.equal(view.items.slice(0, firstSystem).every(item => item.blocking === true), true)
    assert.equal(view.items.slice(firstSystem).every(item => item.blocking !== true), true)
    assert.equal(view.items[0].dedupeKey, 'gate:tkt_gate:run_gate')
    const systemPriorities = view.items.slice(firstSystem).map(item => item.priority)
    assert.deepEqual([...new Set(systemPriorities)], ['high', 'normal'])
    assert.equal(view.items.at(-1).priority, 'normal') // the failure item is the lowest-ranked system row

    // Counts: blocking = gate + two acceptances, system = two failures + source + engine.
    assert.deepEqual(view.counts, { blocking: 3, system: 4, unread: 7 })
    assert.deepEqual(engine.status().inbox, view.counts)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('inbox read is idempotent, blocking items refuse manual resolve, refresh does not recreate resolved items', async () => {
  const { engine, stateDir } = await seededInboxEngine()
  try {
    const failure = engine.inbox.byKey('failure:tkt_fail:run_fail')
    const gate = engine.inbox.byKey('gate:tkt_gate:run_gate')
    assert.equal(await engine.readInbox('ibx_missing'), undefined)

    const read = await engine.readInbox(failure.id)
    assert.ok(read.readAt)
    const again = await engine.readInbox(failure.id)
    assert.equal(again.readAt, read.readAt) // idempotent: no second timestamp
    assert.equal(engine.inboxCounts().unread, 6)

    // Contract §2: a blocking item can only be settled by its action (index maps this error to 409).
    await assert.rejects(() => engine.resolveInbox(gate.id, { action: 'manual' }),
      error => error.code === 'inbox-blocking' && error.status === 409)
    assert.equal(engine.inbox.get(gate.id).resolvedAt, undefined)

    const resolved = await engine.resolveInbox(failure.id, { action: 'manual', note: 'seen' })
    assert.equal(resolved.resolvedAction, 'manual')
    assert.ok(resolved.resolvedAt)
    assert.equal(engine.inboxView().items.some(item => item.id === failure.id), false)
    // The condition still holds, but the manual resolve survives the next derivation.
    await engine.refreshInbox()
    const still = engine.inbox.get(failure.id)
    assert.equal(still.resolvedAt, resolved.resolvedAt)
    assert.equal(engine.inboxView().items.some(item => item.id === failure.id), false)
    assert.equal(await engine.resolveInbox('ibx_missing'), undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a cleared condition auto-resolves its item on disk and content updates keep readAt', async () => {
  const { engine, stateDir } = await seededInboxEngine()
  try {
    const accept = engine.inbox.byKey('accept:tkt_accept')
    const readAt = (await engine.readInbox(accept.id)).readAt
    await engine.state.atomic((doc) => {
      doc.tickets.tkt_accept.links = { acceptance: { ok: true, at: new Date().toISOString() } }
    })
    await engine.refreshInbox()
    const resolved = engine.inbox.get(accept.id)
    assert.ok(resolved) // auto resolve keeps the row as evidence instead of deleting it
    assert.equal(resolved.resolvedAction, 'auto')
    assert.ok(resolved.resolvedAt)
    assert.equal(resolved.readAt, readAt)
    assert.equal(engine.inboxView().items.some(item => item.dedupeKey === 'accept:tkt_accept'), false)

    const engineItem = engine.inbox.byKey('engine:last')
    const engineReadAt = (await engine.readInbox(engineItem.id)).readAt
    const id = engineItem.id
    const createdAt = engineItem.createdAt
    await engine.state.atomic((doc) => { doc.lastError = 'octo sync failed: rate limited' })
    await engine.refreshInbox()
    const updated = engine.inbox.byKey('engine:last')
    assert.equal(updated.id, id)
    assert.equal(updated.createdAt, createdAt)
    assert.equal(updated.summary, 'octo sync failed: rate limited')
    assert.equal(updated.readAt, engineReadAt)
    assert.ok(updated.updatedAt)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('refreshInbox writes nothing when the derived set is unchanged', async () => {
  const { engine, stateDir } = await seededInboxEngine()
  try {
    const saves = []
    const original = engine.inbox.save.bind(engine.inbox)
    engine.inbox.save = async () => { saves.push(1); return original() }
    const result = await engine.refreshInbox()
    assert.deepEqual(result, { changed: false, created: 0, updated: 0, resolved: 0 })
    assert.deepEqual(saves, [])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('refreshInbox tolerates an empty state and a missing or unreadable config', async () => {
  const stateDir = await dir()
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => { throw new Error('live.json unreadable') },
    } })
    await assert.doesNotReject(() => engine.load())
    assert.deepEqual(engine.inboxView(), { items: [], counts: { blocking: 0, system: 0, unread: 0 } })
    assert.deepEqual(await engine.refreshInbox(), { changed: false, created: 0, updated: 0, resolved: 0 })
    assert.equal(await engine.readInbox('ibx_x'), undefined)

    // A partial config (no gitlab/repos) must not produce a source item or throw.
    const partial = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: {}, tokens: {} }),
    } })
    await partial.load()
    assert.deepEqual(partial.inboxView().items, [])
    assert.deepEqual(partial.inboxView().counts, { blocking: 0, system: 0, unread: 0 })
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P1-1 raw signals (contract §2): every candidate is stored before/after interpretation, and can be replayed.
// ---------------------------------------------------------------------------

const signalConfig = (over = {}) => ({
  ...baseConfig, enabled: true,
  octo: { ...baseConfig.octo, watchChatIds: ['chat-1'], allowAnyHuman: true, chatTitles: { 'chat-1': 'SuperAgent' } },
  ...over,
})

async function eventsEngine(stateDir, events, over = {}) {
  const client = fakeClient(events)
  const engine = new Engine({ stateDir, log: () => {}, deps: {
    loadConfig: () => ({ exists: true, config: signalConfig(over), tokens: { octo: 'tok' }, error: undefined }),
    createClient: async () => client,
  } })
  await engine.load()
  return { engine, client }
}

test('every intake candidate becomes a signal — accepted, ignored and skipped (P1 §2.2)', async () => {
  const stateDir = await dir()
  try {
    const { engine } = await eventsEngine(stateDir, [
      groupEvent({ eventId: 201, messageId: 9201 }),
      groupEvent({ eventId: 202, messageId: 9202, text: '执行生产 DDL 并合并到 dev' }),
      groupEvent({ eventId: 203, messageId: 9203, channelId: undefined, channelType: undefined }),
    ])
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.accepted.length, 1)
    assert.equal(result.ignored.length, 1)
    assert.equal(result.skipped.length, 1)
    const signals = engine.signals.all()
    assert.equal(signals.length, 3)
    // Accepted: processed, with both ids, and the decision points back at the signal.
    const accepted = signals.find(signal => signal.status === 'processed')
    assert.equal(accepted.entryPoint, 'events')
    assert.equal(accepted.type, 'event')
    assert.equal(accepted.externalId, 'chat-1:9201')
    assert.equal(accepted.scopeKey, 'octo:chat-1')
    assert.equal(accepted.occurredAt, '2026-11-04T03:00:00.000Z')
    const decision = engine.state.decisions[accepted.decisionId]
    assert.equal(decision.signalId, accepted.id)
    assert.equal(decision.actorKind, 'rule')
    assert.equal(decision.pipelineVersion, pipelineVersion())
    assert.equal(decision.kind, 'accept')
    const ticket = engine.state.tickets[decision.ticketId]
    assert.ok(ticket)
    assert.equal(accepted.triggerId, ticket.origin.triggerId)
    // Ignored by the rules: still recorded, with the filter code the panel shows as the reason.
    const ignored = signals.find(signal => signal.status === 'ignored')
    assert.equal(ignored.skipReason, 'highRisk')
    assert.equal(engine.state.decisions[ignored.decisionId].kind, 'ignore')
    // Filtered before evaluation (DM with no channel): kept as a skipped fact, never evaluated.
    const skipped = signals.find(signal => signal.status === 'skipped')
    assert.equal(skipped.skipReason, 'channel-missing')
    assert.equal(skipped.decisionId, undefined)
    assert.equal(skipped.entryPoint, 'events')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('sync intake records only new messages and keeps the static skip reasons', async () => {
  const stateDir = await dir()
  try {
    let messages = [syncedMessage(101)]
    const client = fakeSyncClient(() => messages)
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...signalConfig(),
        octo: { ...signalConfig().octo, intake: 'sync', allowSenderIds: ['user-1'] } }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    await engine.pollOnce({ dryRun: false }) // initializes chat-1 at 101, records nothing
    assert.equal(engine.signals.all().length, 0)
    messages = [syncedMessage(101), syncedMessage(102), syncedMessage(103, { fromUid: '' }), syncedMessage(104)]
    const result = await engine.pollOnce({ dryRun: false })
    assert.equal(result.accepted.length, 2)
    assert.equal(result.skipped.length, 1)
    const signals = engine.signals.all()
    assert.deepEqual(signals.map(signal => signal.status).sort(), ['processed', 'processed', 'skipped'])
    for (const signal of signals) {
      assert.equal(signal.entryPoint, 'sync')
      assert.equal(signal.type, 'message.received')
      assert.equal(signal.scopeKey, 'octo:chat-1')
      assert.match(signal.externalId, /^chat-1:81\d\d$/)
    }
    assert.equal(signals.find(signal => signal.status === 'skipped').skipReason, 'system-message')
    // Re-seeing the same source event reuses the row instead of duplicating it (idempotent by external id).
    const first = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '同一事件', messageId: 9099, channelType: 2 }, 'sync', { channelId: 'chat-1', messageId: 9099 })
    const second = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '同一事件', messageId: 9099, channelType: 2 }, 'sync', { channelId: 'chat-1', messageId: 9099 })
    assert.equal(first.id, second.id)
    assert.equal(engine.signals.byExternalId('octo', 'chat-1:9099').id, first.id)
    assert.equal(engine.signals.all().filter(signal => signal.externalId === 'chat-1:9099').length, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a dry run reports candidates without writing a single signal row', async () => {
  const stateDir = await dir()
  try {
    const { engine } = await eventsEngine(stateDir, [groupEvent()])
    const result = await engine.pollOnce({ dryRun: true })
    assert.equal(result.accepted.length, 1)
    assert.equal(engine.signals.all().length, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('signalsView filters/counts/pages and signalView joins the decision, trigger and ticket', async () => {
  const stateDir = await dir()
  try {
    const { engine } = await eventsEngine(stateDir, [
      groupEvent({ eventId: 301, messageId: 9301 }),
      groupEvent({ eventId: 302, messageId: 9302, text: '执行生产 DDL' }),
      groupEvent({ eventId: 303, messageId: 9303, channelId: undefined, channelType: undefined }),
    ])
    await engine.pollOnce({ dryRun: false })
    const view = engine.signalsView({})
    assert.equal(view.total, 3)
    assert.deepEqual(view.counts, { all: 3, pending: 0, processed: 1, ignored: 1, skipped: 1, failed: 0,
      labels: { correct: 0, false_wake: 0, missed_wake: 0, cleared: 0 } })
    assert.equal(engine.signalsView({ status: 'skipped' }).items.length, 1)
    assert.equal(engine.signalsView({ status: 'skipped' }).counts.all, 3)
    assert.equal(engine.signalsView({ source: 'other' }).total, 0)
    assert.equal(engine.signalsView({ status: 'pending' }).total, 0)
    assert.equal(engine.signalsView({ limit: 1 }).items.length, 1)
    assert.equal(engine.signalsView({ limit: 1 }).total, 3)
    assert.equal(engine.signalsView({ limit: 1, offset: 1 }).items[0].id, view.items[1].id)
    // A row carries the preview + the filter reason + the ticket it became.
    const ignoredRow = engine.signalsView({ status: 'ignored' }).items[0]
    assert.equal(ignoredRow.skipReason, 'highRisk')
    assert.ok(ignoredRow.textPreview.includes('生产 DDL'))
    const acceptedRow = engine.signalsView({ status: 'processed' }).items[0]
    assert.ok(acceptedRow.ticketId)
    assert.ok(acceptedRow.decisionId)
    // signalView: full join, with nulls for the parts a skipped signal never produced.
    const acceptedSignal = engine.signals.get(acceptedRow.id)
    const one = engine.signalView(acceptedRow.id)
    assert.equal(one.signal.id, acceptedRow.id)
    assert.equal(one.decision.id, acceptedRow.decisionId)
    assert.equal(one.trigger.id, acceptedSignal.triggerId)
    assert.equal(one.ticket.id, acceptedRow.ticketId)
    const skippedRow = engine.signalsView({ status: 'skipped' }).items[0]
    assert.deepEqual(engine.signalView(skippedRow.id), { signal: engine.signals.get(skippedRow.id), decision: null, trigger: null, ticket: null })
    assert.equal(engine.signalView('sig_missing'), undefined)
    // ticketView gained the acceptance record (none yet) and the activity log (creation at least).
    const detail = engine.ticketView(acceptedRow.ticketId)
    assert.equal(detail.acceptance, null)
    assert.ok(detail.activities.some(activity => activity.kind === 'created'))
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('replay re-judges a skipped signal, creates the Ticket once and is idempotent per pipeline version', async () => {
  const stateDir = await dir()
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...signalConfig(), enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
    } })
    await engine.load()
    const signal = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '修复：重放后应建单', messageId: 'msg-r1', channelType: 2, skip: 'senderNotAllowed' }, 'sync', {})
    const replay = await engine.replaySignal(signal.id)
    assert.equal(replay.missing, undefined)
    assert.equal(replay.invalid, undefined)
    assert.equal(replay.decision.actorKind, 'replay')
    assert.equal(replay.decision.signalId, signal.id)
    assert.equal(replay.decision.pipelineVersion, pipelineVersion())
    assert.equal(replay.decision.kind, 'accept')
    assert.ok(replay.ticket)
    assert.equal(replay.ticket.title, '修复：重放后应建单')
    assert.equal(replay.ticket.origin.channelId, 'chat-1')
    const trigger = engine.state.triggers[replay.decision.triggerIds[0]]
    assert.equal(trigger.evidenceEntryPoint, 'manual')
    assert.equal(engine.signals.get(signal.id).status, 'processed')
    assert.equal(engine.signals.get(signal.id).decisionId, replay.decision.id)
    // The Ticket gets a replay activity on top of its creation row.
    const activities = engine.ticketView(replay.ticket.id).activities
    assert.ok(activities.some(activity => activity.kind === 'created'))
    assert.ok(activities.some(activity => activity.kind === 'trigger' && activity.actorKind === 'user'))
    // Idempotent: the same signal/version returns the same decision and never builds a second Ticket.
    const again = await engine.replaySignal(signal.id)
    assert.equal(again.decision.id, replay.decision.id)
    assert.equal(Object.keys(engine.state.tickets).length, 1)
    assert.equal(Object.keys(engine.state.decisions).length, 1)
    // Only skipped/ignored/failed are replayable; unknown ids are missing.
    const pending = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '还在评估', messageId: 'msg-p', channelType: 2 }, 'sync', {})
    assert.match((await engine.replaySignal(pending.id)).invalid, /只有被过滤/)
    assert.deepEqual(await engine.replaySignal('sig_missing'), { missing: true })
    // A failed signal is replayable too (marking it failed must not make it a dead end).
    const failed = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '修复：失败后重放', messageId: 'msg-f', channelType: 2, skip: 'not-text' }, 'sync', {})
    await engine.failSignal(failed, new Error('evaluate crashed'))
    assert.equal(engine.signals.get(failed.id).status, 'failed')
    assert.equal(engine.signals.get(failed.id).error, 'evaluate crashed')
    const recovered = await engine.replaySignal(failed.id)
    assert.equal(recovered.decision.kind, 'accept')
    assert.equal(engine.signals.get(failed.id).status, 'processed')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P1-2 operation ledger (contract §3.2): migration on first load, views read the full run.
// ---------------------------------------------------------------------------

test('load migrates legacy runs into the operation ledger and the views read the full record', async () => {
  const stateDir = await dir()
  try {
    const state = new LiveState(stateDir)
    await state.load()
    await state.atomic((doc) => {
      doc.tickets = { tkt_ops: { id: 'tkt_ops', title: '台账工单', status: 'mr-open', createdAt: hoursAgo(1), origin: {} } }
      doc.ticketOrder = ['tkt_ops']
      doc.runs = [
        { id: 'run_old', ticketId: 'tkt_ops', status: 'mr-open', startedAt: hoursAgo(1), steps: [{ name: 'worker', state: 'ok' }],
          trace: [{ type: 'tool_call', name: 'bash' }] },
        { id: 'run_new', ticketId: 'tkt_ops', status: 'ci-pending', startedAt: hoursAgo(0.5) },
      ]
    })
    const deps = { loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }) }
    const engine = new Engine({ stateDir, log: () => {}, deps })
    await engine.load()
    assert.equal(engine.operations.all().length, 2)
    assert.equal(engine.operationView('run_old').operation.trace[0].name, 'bash')
    assert.equal(engine.operationView('nope'), undefined)
    assert.deepEqual(engine.operationsView({ ticketId: 'tkt_ops' }).items.map(run => run.id), ['run_new', 'run_old'])
    assert.equal(engine.operationsView({ limit: 1 }).items.length, 1)
    // ticketView prefers the full ledger over the thin doc.runs index.
    assert.deepEqual(engine.ticketView('tkt_ops').runs.map(run => run.id), ['run_new', 'run_old'])
    // The migration is one-shot: the ledger file now exists, a reload does not write it again.
    const reloaded = new Engine({ stateDir, log: () => {}, deps })
    await reloaded.load()
    assert.equal(reloaded.operations.all().length, 2)
    assert.equal(reloaded.operationView('run_old').operation.steps[0].name, 'worker')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('ticketView falls back to doc.runs when the ledger has no entry, and exposes acceptance + activities', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const fallback = engine.ticketView('tkt_wait')
    assert.deepEqual(fallback.runs.map(run => run.id), ['run_reply', 'run_verify'])
    assert.equal(fallback.acceptance, null)
    assert.ok(Array.isArray(fallback.activities))
    // Once the ledger has an operation for the Ticket, that full record wins.
    await engine.operations.save({ id: 'run_op', ticketId: 'tkt_wait', status: 'deployed', trigger: 'manual',
      startedAt: hoursAgo(0.1), trace: [{ type: 'tool_call', name: 'bash' }] })
    const detail = engine.ticketView('tkt_wait')
    assert.deepEqual(detail.runs.map(run => run.id), ['run_op'])
    assert.equal(detail.runs[0].trace[0].name, 'bash')
    // Acceptance is served from its own store when the executor/engine wrote a round.
    const record = emptyAcceptanceRecord('tkt_wait', { requirement: '验收：列顺序' })
    await engine.acceptance.save(record)
    assert.equal(engine.ticketView('tkt_wait').acceptance.status, 'unverified')
    assert.equal(engine.ticketView('tkt_wait').acceptance.requirement, '验收：列顺序')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P1-3 acceptance rounds + P1-7 activities (contract §4.2/§5) from the engine's human actions.
// ---------------------------------------------------------------------------

function deployedEngine(stateDir) {
  const config = { ...baseConfig, repos: [{ id: 'web-app', name: 'web-app', repo: '/tmp/repo', baseBranch: 'dev',
    featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'web-uat', acceptance: 'deployed',
    gitlab: { ...baseConfig.gitlab } }], defaultRepo: 'web-app' }
  return new Engine({ stateDir, log: () => {}, deps: {
    loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
    removeWorktree: async () => ({ worktreeRemoved: true, branchRemoved: true, branchKept: false }),
  } })
}

const acceptanceRound = (over = {}) => ({ id: 'rnd_1', roundIndex: 1, trigger: 'auto', status: 'delivered',
  startedAt: hoursAgo(1), completedAt: hoursAgo(0.5), plan: [], checks: [], ...over })

test('acceptTicket writes the human decision onto the latest acceptance round and into the activity log', async () => {
  const stateDir = await dir()
  try {
    const engine = deployedEngine(stateDir)
    await engine.load()
    const ticket = { id: 'tkt_acc', title: '验收工单', status: 'deployed', repoId: 'web-app', links: {} }
    await engine.state.atomic((doc) => { doc.tickets[ticket.id] = ticket; doc.ticketOrder = [ticket.id] })
    const record = emptyAcceptanceRecord(ticket.id)
    record.status = 'delivered'
    record.rounds = [acceptanceRound()]
    await engine.acceptance.save(record)
    const result = await engine.acceptTicket({ ticketId: ticket.id, ok: true, note: 'UAT 通过', intents: ['unmet', 'bogus'] })
    assert.equal(result.ticket.links.acceptance.ok, true)
    const stored = engine.acceptance.get(ticket.id)
    assert.equal(stored.status, 'accepted')
    assert.ok(Number.isFinite(Date.parse(stored.acceptedAt)))
    assert.deepEqual(stored.rounds[0].userDecision, { decision: 'accepted', at: stored.acceptedAt, note: 'UAT 通过',
      intents: ['unmet'] })
    assert.ok(engine.ticketView(ticket.id).activities.some(activity =>
      activity.kind === 'acceptance' && activity.actorKind === 'user' && activity.to === 'accepted'))
    // Rejection lands on the same record shape (and keeps the delivered round status for the counterfactual history).
    const second = { id: 'tkt_rej', title: '打回工单', status: 'deployed', repoId: 'web-app', links: {} }
    await engine.state.atomic((doc) => { doc.tickets[second.id] = second; doc.ticketOrder.push(second.id) })
    await engine.acceptance.save({ ...emptyAcceptanceRecord(second.id), status: 'delivered', rounds: [acceptanceRound()] })
    await engine.acceptTicket({ ticketId: second.id, ok: false, note: '缺证据', intents: ['no-evidence'] })
    const rejected = engine.acceptance.get(second.id)
    assert.equal(rejected.status, 'rejected')
    assert.ok(Number.isFinite(Date.parse(rejected.rejectedAt)))
    assert.equal(rejected.rounds[0].userDecision.decision, 'rejected')
    assert.deepEqual(rejected.rounds[0].userDecision.intents, ['no-evidence'])
    assert.equal(rejected.rounds[0].status, 'delivered')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('dismissTicket closes the acceptance record and appends a dismiss activity', async () => {
  const stateDir = await dir()
  try {
    const engine = deployedEngine(stateDir)
    await engine.load()
    const ticket = { id: 'tkt_close', title: '关闭工单', status: 'failed', repoId: 'web-app', links: {} }
    await engine.state.atomic((doc) => { doc.tickets[ticket.id] = ticket; doc.ticketOrder = [ticket.id] })
    await engine.acceptance.save({ ...emptyAcceptanceRecord(ticket.id), status: 'failed', rounds: [acceptanceRound({ status: 'failed' })] })
    const result = await engine.dismissTicket({ ticketId: ticket.id, note: '不修了' })
    assert.equal(result.ticket.status, 'dismissed')
    const record = engine.acceptance.get(ticket.id)
    assert.equal(record.status, 'closed')
    assert.ok(Number.isFinite(Date.parse(record.closedAt)))
    const activities = engine.ticketView(ticket.id).activities
    assert.ok(activities.some(activity => activity.kind === 'dismiss' && activity.to === 'dismissed'))
    assert.equal(activities[0].kind, 'dismiss')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a successful verification moves the latest verifying round to delivered, exactly once (P1 §4.2)', async () => {
  const stateDir = await dir()
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
      verifyTicket: async () => ({ status: 'deployed', verification: { merged: false } }),
    } })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = { tkt_dep: { id: 'tkt_dep', status: 'mr-open', links: { commit: 'abc' } } }
      doc.ticketOrder = ['tkt_dep']
    })
    await engine.acceptance.save({ ...emptyAcceptanceRecord('tkt_dep'), status: 'verifying',
      rounds: [acceptanceRound({ status: 'verifying', completedAt: undefined })] })
    await engine.verifyOpenTickets()
    const stored = engine.acceptance.get('tkt_dep')
    assert.equal(stored.rounds[0].status, 'delivered')
    assert.ok(Number.isFinite(Date.parse(stored.rounds[0].completedAt)))
    const completedAt = stored.rounds[0].completedAt
    await engine.markAcceptanceDelivered('tkt_dep')
    assert.equal(engine.acceptance.get('tkt_dep').rounds[0].completedAt, completedAt)
    // A record that never had a verifying round is untouched; a missing record returns undefined.
    await engine.acceptance.save({ ...emptyAcceptanceRecord('tkt_plain'), status: 'failed', rounds: [acceptanceRound({ status: 'failed' })] })
    assert.equal(engine.acceptance.get('tkt_plain').rounds[0].status, 'failed')
    await engine.markAcceptanceDelivered('tkt_plain')
    assert.equal(engine.acceptance.get('tkt_plain').rounds[0].status, 'failed')
    assert.equal(await engine.markAcceptanceDelivered('tkt_none'), undefined)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('auto-run dispatches with trigger auto so the ledger can tell automatic work apart', async () => {
  const stateDir = await dir()
  try {
    const triggers = []
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false, paused: false,
        executor: { enabled: true, autoRun: true, allowPush: true, gates: [] } }, tokens: { octo: 'tok' }, error: undefined }),
      executeTicket: async (args) => { triggers.push(args.trigger); return { status: 'mr-open' } },
    } })
    await engine.load()
    await engine.autoExecute(['tkt_auto'])
    assert.deepEqual(triggers, ['auto'])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('reconcile mirrors an interrupted run into the operation ledger and keeps doc.runs as the thin index', async () => {
  const stateDir = await dir()
  try {
    const deps = { loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }) }
    const engine = new Engine({ stateDir, log: () => {}, deps })
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.runs = [{ id: 'run_live', ticketId: 'tkt_live', status: 'running', steps: [] }]
      doc.tickets = { tkt_live: { id: 'tkt_live', status: 'working', assignments: [] } }
    })
    await engine.operations.save({ id: 'run_live', ticketId: 'tkt_live', status: 'running', startedAt: hoursAgo(0.2),
      trigger: 'manual', steps: [{ name: 'worker', state: 'running' }] })
    const result = await engine.reconcile()
    assert.equal(result.runs, 1)
    assert.equal(result.tickets, 1)
    const operation = engine.operations.get('run_live')
    assert.equal(operation.status, 'interrupted')
    assert.equal(operation.stopReason, 'interrupted')
    assert.equal(operation.interruption.reason, 'plugin reload')
    assert.equal(operation.steps.at(-1).name, 'reconcile')
    const index = engine.state.runs.find(run => run.id === 'run_live')
    assert.deepEqual(index, summarizeRun(operation))
    assert.equal(index.steps, undefined)
    assert.equal(engine.state.tickets.tkt_live.status, 'ready')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P2-1 Ticket automation (contract §1.2): config on the Ticket, a 15s scheduler, fixed skip precedence.
// ---------------------------------------------------------------------------

/** A due heartbeat automation: nextAt in the past, so one tick must fire it. */
const dueAutomation = (over = {}) => ({ mode: 'heartbeat', enabled: true, intervalMinutes: 60, executions: 0,
  nextAt: hoursAgo(0.1), ...over })

function scheduleEngine(stateDir, { config = {}, calls = [], observed = [] } = {}) {
  const effective = {
    ...panelConfig, ...config,
    executor: { ...panelConfig.executor, autoRun: false, ...(config.executor ?? {}) },
  }
  const engine = new Engine({ stateDir, log: () => {}, deps: {
    loadConfig: () => ({ exists: true, config: effective, tokens: panelTokens, error: undefined }),
    executeTicket: async (args) => {
      calls.push(args)
      const automation = engine.state.tickets[args.ticketId]?.automation
      observed.push({ executions: automation?.executions, nextAt: automation?.nextAt })
      return { status: 'mr-open' }
    },
  } })
  return engine
}

async function seedScheduledTicket(engine, over = {}) {
  await engine.state.atomic((doc) => {
    doc.tickets = {
      tkt_sched: { id: 'tkt_sched', title: '调度工单', status: 'ready', createdAt: hoursAgo(2), updatedAt: hoursAgo(2),
        links: {}, automation: dueAutomation(), ...over },
    }
    doc.ticketOrder = ['tkt_sched']
  })
  return engine.state.tickets.tkt_sched
}

test('setTicketAutomation normalizes, persists and logs an activity (P2 §1.2)', async () => {
  const { engine, stateDir } = await seededPanelEngine()
  try {
    const saved = await engine.setTicketAutomation('tkt_run', {
      mode: 'heartbeat', enabled: true, intervalMinutes: 30, maxExecutions: 3,
    })
    assert.equal(saved.missing, undefined)
    assert.equal(saved.invalid, undefined)
    assert.equal(saved.automation.mode, 'heartbeat')
    assert.equal(saved.automation.enabled, true)
    assert.equal(saved.automation.intervalMinutes, 30)
    assert.equal(saved.automation.maxExecutions, 3)
    assert.equal(saved.automation.executions, 0)
    assert.ok(Number.isFinite(Date.parse(saved.automation.nextAt)))
    assert.equal(saved.ticket.automation.mode, 'heartbeat')
    assert.ok(Number.isFinite(Date.parse(saved.ticket.updatedAt)))
    const activity = saved.ticket.activities.at(-1)
    assert.equal(activity.kind, 'status')
    assert.equal(activity.actorKind, 'user')
    assert.match(activity.detail, /自动化：每 30 分钟/)
    // An invalid daily time is rejected without touching the stored config.
    const before = engine.state.tickets.tkt_run.automation
    const invalid = await engine.setTicketAutomation('tkt_run', { mode: 'schedule', enabled: true, at: '25:99' })
    assert.match(invalid.invalid, /HH:mm/)
    assert.deepEqual(engine.state.tickets.tkt_run.automation, before)
    // Daily mode gets a real next occurrence; off clears it and disables.
    const daily = await engine.setTicketAutomation('tkt_run', { mode: 'schedule', enabled: true, at: '08:30' })
    assert.equal(daily.automation.at, '08:30')
    assert.ok(Number.isFinite(Date.parse(daily.automation.nextAt)))
    assert.match(daily.ticket.activities.at(-1).detail, /自动化：每天 08:30/)
    const off = await engine.setTicketAutomation('tkt_run', { mode: 'off' })
    assert.equal(off.automation.mode, 'off')
    assert.equal(off.automation.enabled, false)
    assert.equal(off.automation.nextAt, undefined)
    assert.match(off.ticket.activities.at(-1).detail, /自动化：关闭/)
    assert.deepEqual(await engine.setTicketAutomation('tkt_missing', { mode: 'off' }), { missing: true })
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('tickSchedules dispatches a due Ticket with the mode as trigger and persists the attempt first (P2 §1.2)', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const observed = []
    const engine = scheduleEngine(stateDir, { calls, observed })
    await engine.load()
    await seedScheduledTicket(engine)
    const result = await engine.tickSchedules()
    assert.deepEqual(result.dispatched, ['tkt_sched'])
    assert.deepEqual(result.skipped, [])
    await engine.scheduleDispatchQueue
    assert.equal(calls.length, 1)
    assert.equal(calls[0].ticketId, 'tkt_sched')
    assert.equal(calls[0].trigger, 'heartbeat')
    assert.equal(calls[0].dryRun, false)
    // The attempt was persisted before the executor saw it (executions already 1, nextAt already moved).
    assert.deepEqual(observed, [{ executions: 1, nextAt: engine.state.tickets.tkt_sched.automation.nextAt }])
    const automation = engine.state.tickets.tkt_sched.automation
    assert.equal(automation.executions, 1)
    assert.equal(automation.lastTrigger, 'heartbeat')
    assert.ok(Number.isFinite(Date.parse(automation.lastRunAt)))
    assert.ok(Date.parse(automation.nextAt) > Date.now())
    assert.equal(automation.lastSkipReason, undefined)
    const runActivity = engine.state.tickets.tkt_sched.activities.at(-1)
    assert.equal(runActivity.kind, 'run')
    assert.match(runActivity.detail, /定时触发（heartbeat）/)
    // Not due until nextAt: a second tick (or a rapid double tick) never re-dispatches it.
    assert.deepEqual((await engine.tickSchedules()).dispatched, [])
    await engine.scheduleDispatchQueue
    assert.equal(calls.length, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('tickSchedules is re-entrancy safe and never overlaps one Ticket with itself (P2 §1.2)', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const engine = scheduleEngine(stateDir, { calls })
    await engine.load()
    await seedScheduledTicket(engine)
    const [first, second] = await Promise.all([engine.tickSchedules(), engine.tickSchedules()])
    // One pass wins (persists + dispatches), the other reports busy instead of dispatching twice.
    const busy = [first, second].filter(result => result.busy === true)
    const active = [first, second].filter(result => result.busy !== true)
    assert.equal(busy.length, 1)
    assert.deepEqual(active[0].dispatched, ['tkt_sched'])
    await engine.scheduleDispatchQueue
    assert.equal(calls.length, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('tickSchedules applies the fixed skip precedence and records lastSkipReason (P2 §1.2)', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const engine = scheduleEngine(stateDir, { config: { paused: true }, calls })
    await engine.load()
    const original = await seedScheduledTicket(engine)
    const paused = await engine.tickSchedules()
    assert.deepEqual(paused.dispatched, [])
    assert.deepEqual(paused.skipped, [{ ticketId: 'tkt_sched', reason: 'paused' }])
    assert.equal(engine.state.tickets.tkt_sched.automation.lastSkipReason, 'paused')
    // Skip does not move nextAt, so resuming can still fire it.
    assert.equal(engine.state.tickets.tkt_sched.automation.nextAt, original.automation.nextAt)
    assert.equal(engine.state.tickets.tkt_sched.automation.executions, 0)
    await engine.scheduleDispatchQueue
    assert.equal(calls.length, 0)
    // Same reason again: nothing changed, so the skip is reported without an extra document write.
    const skipWritesBefore = await readFile(engine.state.file, 'utf8')
    await engine.tickSchedules()
    await engine.scheduleDispatchQueue
    assert.equal(await readFile(engine.state.file, 'utf8'), skipWritesBefore)

    // executor-disabled wins next.
    const disabled = scheduleEngine(stateDir, { config: { executor: { enabled: false } }, calls })
    await disabled.load()
    assert.deepEqual((await disabled.tickSchedules()).skipped, [{ ticketId: 'tkt_sched', reason: 'executor-disabled' }])

    // working / parked statuses.
    for (const [status, reason] of [['working', 'working'], ['gate-blocked', 'parked'], ['awaiting-answer', 'parked']]) {
      const statusDir = await dir()
      try {
        const statusEngine = scheduleEngine(statusDir, { calls })
        await statusEngine.load()
        await seedScheduledTicket(statusEngine, { status })
        assert.deepEqual((await statusEngine.tickSchedules()).skipped,
          [{ ticketId: 'tkt_sched', reason }], status)
      } finally { await rm(statusDir, { recursive: true, force: true }) }
    }

    // Execution cap: no further automatic runs once executions reached maxExecutions.
    const cappedDir = await dir()
    try {
      const capped = scheduleEngine(cappedDir, { calls })
      await capped.load()
      await seedScheduledTicket(capped, { automation: dueAutomation({ maxExecutions: 2, executions: 2 }) })
      assert.deepEqual((await capped.tickSchedules()).skipped, [{ ticketId: 'tkt_sched', reason: 'max-executions' }])
      assert.equal(capped.state.tickets.tkt_sched.automation.lastSkipReason, 'max-executions')
      await capped.scheduleDispatchQueue
      assert.equal(calls.length, 0)
    } finally { await rm(cappedDir, { recursive: true, force: true }) }
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('the schedule timer lives across start/refresh and is cleared by stop (P2 §1.2)', async (t) => {
  const stateDir = await dir()
  t.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: true }, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => fakeClient([]),
    } })
    await engine.start()
    assert.ok(engine.scheduleTimer)
    const scheduled = engine.scheduleTimer
    await engine.refresh()
    assert.ok(engine.scheduleTimer)
    assert.notEqual(engine.scheduleTimer, scheduled)
    engine.stop()
    assert.equal(engine.scheduleTimer, undefined)
    assert.equal(engine.started, false)
  } finally {
    t.mock.timers.reset()
    await rm(stateDir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// P2-7 automatic verification: draft MRs are left alone and the wake-ups per head are capped.
// ---------------------------------------------------------------------------

function autoVerifyEngine(stateDir, calls) {
  return new Engine({ stateDir, log: () => {}, deps: {
    loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false, paused: false }, tokens: { octo: 'tok' }, error: undefined }),
    verifyTicket: async ({ ticketId, engine }) => {
      const autoVerify = engine.state.tickets[ticketId]?.links?.autoVerify
      calls.push({ kind: 'verify', ticketId, count: autoVerify?.count })
      return { status: 'mr-open' }
    },
    refreshTicketCi: async ({ ticketId }) => {
      calls.push({ kind: 'ci', ticketId })
      return { status: 'ci-pending' }
    },
  } })
}

test('verifyOpenTickets skips draft/WIP MRs and records why (P2 §2.3)', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const engine = autoVerifyEngine(stateDir, calls)
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = {
        tkt_draft: { id: 'tkt_draft', status: 'mr-open', links: { commit: 'aaa',
          mergeRequest: { iid: 7, headSha: 'sha-1', workInProgress: true } } },
        tkt_wip: { id: 'tkt_wip', status: 'mr-open', links: { commit: 'bbb',
          mergeRequest: { iid: 8, headSha: 'sha-2', draft: true } } },
        tkt_ok: { id: 'tkt_ok', status: 'mr-open', links: { commit: 'ccc',
          mergeRequest: { iid: 9, headSha: 'sha-3' } } },
      }
    })
    const results = await engine.verifyOpenTickets()
    // Only the ready MR is refreshed/verified; both drafts are skipped.
    assert.deepEqual(calls, [{ kind: 'ci', ticketId: 'tkt_ok' }, { kind: 'verify', ticketId: 'tkt_ok', count: 1 }])
    for (const [ticketId, headSha] of [['tkt_draft', 'sha-1'], ['tkt_wip', 'sha-2']]) {
      const autoVerify = engine.state.tickets[ticketId].links.autoVerify
      assert.equal(autoVerify.skipped, 'draft')
      assert.equal(autoVerify.headSha, headSha)
      assert.equal(autoVerify.count, 0)
      assert.ok(Number.isFinite(Date.parse(autoVerify.lastAt)))
      assert.ok(results.some(result => result.ticketId === ticketId && result.skipped === 'draft'))
    }
    // The ready Ticket's attempt is recorded before the executor observes it.
    assert.equal(engine.state.tickets.tkt_ok.links.autoVerify.count, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('automatic verification wakes at most 3 times per head and resets on a new head (P2 §2.3)', async () => {
  const stateDir = await dir()
  try {
    const calls = []
    const engine = autoVerifyEngine(stateDir, calls)
    await engine.load()
    await engine.state.atomic((doc) => {
      doc.tickets = { tkt_auto: { id: 'tkt_auto', status: 'mr-open', links: { commit: 'aaa',
        mergeRequest: { iid: 7, headSha: 'sha-1' } } } }
    })
    // Three attempts happen, each persisted with the rising counter before verification.
    for (const expected of [1, 2, 3]) {
      await engine.verifyOpenTickets()
      assert.equal(engine.state.tickets.tkt_auto.links.autoVerify.count, expected)
      assert.equal(calls.filter(call => call.kind === 'verify').at(-1).count, expected)
    }
    const attempts = calls.length
    const parked = await engine.verifyOpenTickets()
    assert.equal(calls.length, attempts) // no refreshCi and no verify after the cap
    assert.ok(parked.some(result => result.ticketId === 'tkt_auto' && result.skipped === 'auto-verify-limit'))
    const parkedVerify = engine.state.tickets.tkt_auto.links.autoVerify
    assert.equal(parkedVerify.count, 3)
    assert.equal(parkedVerify.lastSkipReason, 'auto-verify-limit')
    // A force-push (new head) is fresh evidence: the budget resets to one attempt.
    await engine.state.atomic((doc) => {
      doc.tickets.tkt_auto.links.mergeRequest = { iid: 7, headSha: 'sha-2' }
    })
    await engine.verifyOpenTickets()
    const reset = engine.state.tickets.tkt_auto.links.autoVerify
    assert.equal(reset.headSha, 'sha-2')
    assert.equal(reset.count, 1)
    assert.equal(reset.lastSkipReason, undefined)
    assert.equal(calls.at(-1).count, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------
// P2-8 signal quality labels (contract §3.1): append-only human labels plus a histogram.
// ---------------------------------------------------------------------------

test('labelSignal validates, appends bounded labels and never touches the classification (P2 §3.1)', async () => {
  const stateDir = await dir()
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
    } })
    await engine.load()
    const signal = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '标注测试', messageId: 'm-label', channelType: 2 }, 'sync', {})
    const labeled = await engine.labelSignal(signal.id, { label: 'false_wake', note: '  不是给 agent 的活  ' })
    assert.equal(labeled.missing, undefined)
    assert.equal(labeled.signal.id, signal.id)
    const [first] = labeled.signal.labels
    assert.match(first.id, /^lbl_/)
    assert.equal(first.label, 'false_wake')
    assert.equal(first.note, '不是给 agent 的活')
    assert.equal(first.actorKind, 'user')
    assert.ok(Number.isFinite(Date.parse(first.at)))
    // Labels are metadata only: status/classification is untouched.
    assert.equal(labeled.signal.status, signal.status)
    // An unknown label is rejected without appending; an unknown signal is missing.
    const invalid = await engine.labelSignal(signal.id, { label: 'nope' })
    assert.match(invalid.invalid, /correct/)
    assert.equal(engine.signals.get(signal.id).labels.length, 1)
    assert.deepEqual(await engine.labelSignal('sig_missing', { label: 'correct' }), { missing: true })
    // A long note is clipped to 300 chars; the row stays append-only.
    const long = await engine.labelSignal(signal.id, { label: 'correct', note: 'x'.repeat(500) })
    assert.equal(long.signal.labels.at(-1).note.length, 300)
    assert.equal(long.signal.labels.length, 2)
    // The cap keeps the newest 50 rows.
    for (let index = 0; index < 55; index += 1) await engine.labelSignal(signal.id, { label: 'cleared' })
    assert.equal(engine.signals.get(signal.id).labels.length, 50)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('signalsView exposes per-row labels and counts quality labels over recent signals (P2 §3.1)', async () => {
  const stateDir = await dir()
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config: { ...baseConfig, enabled: false }, tokens: { octo: 'tok' }, error: undefined }),
    } })
    await engine.load()
    const first = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '第一条', messageId: 'm-1', channelType: 2 }, 'sync', {})
    const second = await engine.recordSignal({ channelId: 'chat-1', fromUid: 'user-1', contentType: 1,
      text: '第二条', messageId: 'm-2', channelType: 2 }, 'sync', {})
    await engine.labelSignal(first.id, { label: 'false_wake' })
    await engine.labelSignal(second.id, { label: 'correct' })
    await engine.labelSignal(second.id, { label: 'missed_wake' })
    const view = engine.signalsView()
    const row = view.items.find(item => item.id === second.id)
    assert.deepEqual(row.labels.map(label => label.label), ['correct', 'missed_wake'])
    assert.deepEqual(view.counts.labels, { correct: 1, false_wake: 1, missed_wake: 1, cleared: 0 })
    // The histogram counts all recent signals, independent of the status tab; unlabeled rows contribute nothing.
    assert.deepEqual(engine.signalsView({ status: 'pending' }).counts.labels,
      { correct: 1, false_wake: 1, missed_wake: 1, cleared: 0 })
    assert.ok(view.items.every(item => Array.isArray(item.labels)))
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})
