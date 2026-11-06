/**
 * Route-level tests for the redesigned panel data contract (spec/impl-contract-2026-11.md §4).
 *
 * The routes live in the plugin entry (`index.js`), so these tests mount the real handler against a temporary state
 * directory: a seeded `live-state.json`, a disabled `live.json`, and fake request/response objects. That covers the
 * dispatch, status codes and 404 bodies that the unit tests on `Engine` methods cannot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../../index.js'
import { emptyLiveState } from './state.js'

const HOUR_MS = 3_600_000
const hoursAgo = (hours) => new Date(Date.now() - Math.round(hours * HOUR_MS)).toISOString()
const API = '/superagent/api'

/** One thread pair, three trigger/decision pairs, and tickets across waiting/working/done. */
function seedState(state) {
  const first = { key: 'octo:chat-1', source: 'octo', title: 'SuperAgent', createdAt: hoursAgo(3), lastAt: hoursAgo(1) }
  const second = { key: 'octo:chat-2', source: 'octo', title: '其他群', createdAt: hoursAgo(31), lastAt: hoursAgo(30) }
  state.threads = { [first.key]: first, [second.key]: second }
  state.triggers = {
    trg_ok: { id: 'trg_ok', source: 'octo', at: hoursAgo(1), threads: [first.key], human: true, text: '修复：应收发票列表列顺序',
      disposition: { decisionId: 'dec_ok', fanout: ['tkt_wait'] } },
    trg_risk: { id: 'trg_risk', source: 'octo', at: hoursAgo(2), threads: [first.key], human: true, text: '生产库执行 DDL 并合并到 dev',
      disposition: { decisionId: 'dec_risk', fanout: [] } },
    trg_old: { id: 'trg_old', source: 'octo', at: hoursAgo(30), threads: [second.key], human: true, text: '旧消息',
      disposition: { decisionId: 'dec_old', fanout: ['tkt_done'] } },
  }
  state.decisions = {
    dec_ok: { id: 'dec_ok', triggerIds: ['trg_ok'], threadKey: first.key, at: hoursAgo(1), kind: 'accept', strength: 'explicit',
      rules: [], ticketId: 'tkt_wait' },
    dec_risk: { id: 'dec_risk', triggerIds: ['trg_risk'], threadKey: first.key, at: hoursAgo(2), kind: 'ignore', strength: 'explicit',
      rules: [], reason: [{ code: 'highRisk' }] },
    dec_old: { id: 'dec_old', triggerIds: ['trg_old'], threadKey: second.key, at: hoursAgo(30), kind: 'accept', strength: 'explicit',
      rules: [], ticketId: 'tkt_done' },
  }
  state.tickets = {
    tkt_wait: { id: 'tkt_wait', title: '修复：应收发票列表列顺序', status: 'deployed', createdAt: hoursAgo(1), updatedAt: hoursAgo(0.5),
      origin: { threadKey: first.key, triggerId: 'trg_ok', decisionId: 'dec_ok' }, links: { verification: { at: hoursAgo(0.5) } } },
    tkt_run: { id: 'tkt_run', title: '处理中的需求', status: 'ci-pending', createdAt: hoursAgo(2), updatedAt: hoursAgo(2),
      origin: { threadKey: first.key } },
    tkt_done: { id: 'tkt_done', title: '已关闭工单', status: 'closed', createdAt: hoursAgo(30), updatedAt: hoursAgo(30),
      origin: { threadKey: second.key, triggerId: 'trg_old', decisionId: 'dec_old' } },
  }
  state.ticketOrder = ['tkt_done', 'tkt_run', 'tkt_wait']
  state.runs = [{ id: 'run_reply', ticketId: 'tkt_wait', status: 'mr-open', startedAt: hoursAgo(0.4) }]
  state.sources = { octo: { state: 'ready', at: hoursAgo(0.1) }, gitlab: { state: 'idle' } }
}

function fakeContext() {
  const disposers = []
  const context = {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') disposers.push(dispose)
    },
    webServer: {
      register(route) {
        context.handler = route.handler
        return () => { context.handler = undefined }
      },
    },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    handler: undefined,
  }
  return { context, disposers }
}

/** Mount the real plugin handler over a temporary state directory seeded with the panel fixture. */
async function startApi(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'superagent-api-'))
  await writeFile(join(stateDir, 'octo.token'), 'bf_test\n')
  await writeFile(join(stateDir, 'gitlab.token'), 'glpat-test\n')
  await writeFile(join(stateDir, 'live.json'), JSON.stringify({ enabled: false, paused: false,
    octo: { watchChatIds: [], allowAnyHuman: true }, executor: { enabled: true } }))
  const state = emptyLiveState()
  seedState(state)
  await writeFile(join(stateDir, 'live-state.json'), JSON.stringify(state))
  const { context, disposers } = fakeContext()
  await apply(context, { stateDir })
  assert.equal(typeof context.handler, 'function')
  t.after(async () => {
    for (const dispose of disposers.reverse()) { try { dispose() } catch { /* already disposed */ } }
    await rm(stateDir, { recursive: true, force: true })
  })
  return { handler: context.handler, stateDir }
}

async function call(handler, method, path, body) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const out = { status: 0, json: undefined, raw: '' }
  const req = {
    method,
    url: path,
    headers: { host: '127.0.0.1:56897', 'x-superagent-request': '1' },
    async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
  }
  const res = {
    writeHead(status) { out.status = status },
    end(text) {
      out.raw = text === undefined ? '' : String(text)
      try { out.json = JSON.parse(out.raw) } catch { out.json = undefined }
    },
  }
  await handler(req, res)
  return out
}

test('GET engine/status serves the contract §4 increments', async (t) => {
  const { handler } = await startApi(t)
  const response = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(response.status, 200)
  const status = response.json
  assert.equal(status.paused, false)
  assert.equal(status.engine.paused, false)
  assert.equal(status.config.paused, false)
  assert.deepEqual(status.counts, { threads: 2, triggers: 3, decisions: 3, tickets: 3, runs: 1, needsHuman: 1, open: 2 })
  assert.deepEqual(status.load, { running: 1, queued: 0, waiting: 1, failed: 0, paused: false })
  const { windowStart, ...flow } = status.flow24h
  assert.ok(Number.isFinite(Date.parse(windowStart)))
  assert.deepEqual(flow, { received: 2, filtered: 1, judged: 2, accepted: 1, tickets: 2, dropped: 0 })
  // Run-level failures are counted separately from Ticket stages; the fixture's only run is mr-open.
  assert.equal(status.runs24hFailed, 0)
test('GET engine/search finds tickets and threads in the live state', async (t) => {
  const { handler } = await startApi(t)
  const tickets = await call(handler, 'GET', `${API}/engine/search?q=${encodeURIComponent('发票')}`)
  assert.equal(tickets.status, 200)
  assert.ok(tickets.json.tickets.some(ticket => ticket.id === 'tkt_wait'), JSON.stringify(tickets.json))
  assert.equal(tickets.json.total, tickets.json.tickets.length + tickets.json.threads.length + tickets.json.triggers.length)
  const threads = await call(handler, 'GET', `${API}/engine/search?q=${encodeURIComponent('SuperAgent')}`)
  assert.ok(threads.json.threads.some(thread => thread.key === 'octo:chat-1'), JSON.stringify(threads.json))
  const empty = await call(handler, 'GET', `${API}/engine/search?q=`)
  assert.deepEqual(empty.json, { query: '', tickets: [], threads: [], triggers: [], total: 0 })
})

  // The overview's policy ledger comes from the full decision store, not the 20-decision status payload.
  assert.equal(status.rules24h.judged, 2)
  assert.ok(Array.isArray(status.rules24h.rules))
  for (const rule of status.rules24h.rules) {
    assert.equal(typeof rule.name, 'string')
    assert.equal(typeof rule.hits, 'number')
    assert.equal(typeof rule.blocked, 'number')
  }
  // live.json is disabled here, so the intake is off while the GitLab surface (token + executor) is ready.
  assert.deepEqual(status.sources.map(source => source.id), ['octo', 'gitlab:demo-legacy-repo'])
  assert.equal(status.defaultRepo, 'demo-legacy-repo')
  assert.equal(status.repos.length, 1)
  assert.equal(status.repos[0].id, 'demo-legacy-repo')
  assert.equal(status.repos[0].verifyMode, 'web-uat')
  const [octo, gitlab] = status.sources
  assert.equal(octo.kind, 'source')
  assert.equal(octo.state, 'off')
  assert.equal(octo.enabled, false)
  assert.deepEqual(octo.stats, { received: 2, filtered: 1, accepted: 1 })
  assert.equal(octo.filtered.length, 1)
  assert.equal(octo.filtered[0].id, 'trg_risk')
  assert.equal(octo.filtered[0].reasonCode, 'highRisk')
  assert.equal(gitlab.kind, 'execution')
  assert.equal(gitlab.repoId, 'demo-legacy-repo')
  assert.equal(gitlab.state, 'ready')
  assert.equal(gitlab.enabled, true)
  assert.deepEqual(gitlab.stats, { tickets: 3, mrOpen: 1, deployed: 1, failed: 0 })
  assert.equal(gitlab.config.tokenConfigured, true)
  assert.equal(status.eval.mode, 'rules')
  assert.deepEqual(status.eval.rules.map(rule => rule.id), ['R1', 'R2', 'R3'])
  assert.match(status.prompts.workerBrief, /tkt_wait/)
  assert.equal(status.prompts.note, '内置提示词，随代码版本')
})

test('GET engine/tickets returns raw tickets and filters by stage', async (t) => {
  const { handler } = await startApi(t)
  const all = await call(handler, 'GET', `${API}/engine/tickets`)
  assert.equal(all.status, 200)
  assert.deepEqual(all.json.counts, { all: 3, queued: 0, working: 1, waiting: 1, failed: 0, done: 1 })
  assert.deepEqual(all.json.items.map(ticket => ticket.id), ['tkt_wait', 'tkt_run', 'tkt_done'])
  assert.equal(all.json.items[0].title, '修复：应收发票列表列顺序')
  assert.equal(all.json.paused, false)
  const waiting = await call(handler, 'GET', `${API}/engine/tickets?stage=waiting`)
  assert.equal(waiting.status, 200)
  assert.deepEqual(waiting.json.items.map(ticket => ticket.id), ['tkt_wait'])
  const failed = await call(handler, 'GET', `${API}/engine/tickets?stage=failed`)
  assert.deepEqual(failed.json.items, [])
})

test('GET engine/ticket/:id returns the detail object and 404 for unknown ids', async (t) => {
  const { handler } = await startApi(t)
  const response = await call(handler, 'GET', `${API}/engine/ticket/tkt_wait`)
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.json).sort(), ['decision', 'runs', 'thread', 'ticket', 'trigger'])
  assert.equal(response.json.ticket.id, 'tkt_wait')
  assert.deepEqual(response.json.runs.map(run => run.id), ['run_reply'])
  assert.equal(response.json.trigger.id, 'trg_ok')
  assert.equal(response.json.decision.id, 'dec_ok')
  assert.equal(response.json.thread.key, 'octo:chat-1')
  const missing = await call(handler, 'GET', `${API}/engine/ticket/tkt_missing`)
  assert.equal(missing.status, 404)
  assert.match(missing.json.error, /未知工单/)
})

test('GET engine/threads lists threads and filters subscribed/recent', async (t) => {
  const { handler } = await startApi(t)
  const all = await call(handler, 'GET', `${API}/engine/threads`)
  assert.equal(all.status, 200)
  assert.deepEqual(all.json.counts, { all: 2, subscribed: 2, recent: 1, new: 1 })
  assert.deepEqual(all.json.items.map(row => row.key), ['octo:chat-1', 'octo:chat-2'])
  assert.equal(all.json.items[0].triggerCount, 2)
  assert.equal(all.json.items[0].decisionKind, 'accept')
  assert.deepEqual([...all.json.items[0].ticketIds].sort(), ['tkt_run', 'tkt_wait'])
  const recent = await call(handler, 'GET', `${API}/engine/threads?filter=recent`)
  assert.deepEqual(recent.json.items.map(row => row.key), ['octo:chat-1'])
  const subscribed = await call(handler, 'GET', `${API}/engine/threads?filter=subscribed`)
  assert.equal(subscribed.json.items.length, 2)
})

test('GET engine/thread/:key returns facts/timeline and 404 for unknown keys', async (t) => {
  const { handler } = await startApi(t)
  const key = encodeURIComponent('octo:chat-1')
  const response = await call(handler, 'GET', `${API}/engine/thread/${key}`)
  assert.equal(response.status, 200)
  assert.deepEqual(Object.keys(response.json).sort(), ['decisions', 'facts', 'thread', 'tickets', 'triggers'])
  assert.equal(response.json.thread.key, 'octo:chat-1')
  assert.deepEqual(response.json.triggers.map(trigger => trigger.id), ['trg_risk', 'trg_ok'])
  assert.deepEqual(response.json.decisions.map(decision => decision.id), ['dec_ok', 'dec_risk'])
  assert.deepEqual(response.json.tickets.map(ticket => ticket.id), ['tkt_wait', 'tkt_run'])
  assert.equal(response.json.facts.channelId, 'chat-1')
  assert.equal(response.json.facts.triggerCount, 2)
  const missing = await call(handler, 'GET', `${API}/engine/thread/${encodeURIComponent('octo:missing')}`)
  assert.equal(missing.status, 404)
  assert.match(missing.json.error, /未知线程/)
})

test('GET engine/decisions filters by kind/window and paginates', async (t) => {
  const { handler } = await startApi(t)
  const all = await call(handler, 'GET', `${API}/engine/decisions`)
  assert.equal(all.status, 200)
  assert.deepEqual(all.json.counts, { all: 3, accept: 2, reopen: 0, stop: 0, ignore: 1, unavailable: 0 })
  assert.equal(all.json.total, 3)
  assert.deepEqual(all.json.items.map(decision => decision.id), ['dec_ok', 'dec_risk', 'dec_old'])
  const ignored = await call(handler, 'GET', `${API}/engine/decisions?kind=ignore`)
  assert.equal(ignored.json.total, 1)
  assert.deepEqual(ignored.json.items.map(decision => decision.id), ['dec_risk'])
  const recent = await call(handler, 'GET', `${API}/engine/decisions?window=24h`)
  assert.equal(recent.json.total, 2)
  assert.deepEqual(recent.json.items.map(decision => decision.id), ['dec_ok', 'dec_risk'])
  const page = await call(handler, 'GET', `${API}/engine/decisions?offset=1&limit=1`)
  assert.deepEqual(page.json.items.map(decision => decision.id), ['dec_risk'])
  assert.equal(page.json.total, 3)
})

test('POST engine/ticket/:id/accept records human sign-off and clears the human queue', async (t) => {
  const { handler } = await startApi(t)
  const before = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(before.json.counts.needsHuman, 1)
  assert.equal(before.json.load.waiting, 1)

  const accepted = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/accept`, { ok: true, note: 'UAT 验收通过' })
  assert.equal(accepted.status, 200)
  const acceptance = accepted.json.ticket.links.acceptance
  assert.equal(acceptance.ok, true)
  assert.ok(Number.isFinite(Date.parse(acceptance.at)))
  assert.equal(acceptance.verificationAt, before.json.tickets.find(ticket => ticket.id === 'tkt_wait').links.verification.at)
  assert.equal(acceptance.note, 'UAT 验收通过')

  const after = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(after.json.counts.needsHuman, 0)
  assert.equal(after.json.load.waiting, 0)
  const detail = await call(handler, 'GET', `${API}/engine/ticket/tkt_wait`)
  assert.equal(detail.json.ticket.links.acceptance.ok, true)
  // The deployment record itself is untouched: a person signed off, nothing was re-deployed.
  assert.equal(detail.json.ticket.status, 'deployed')
  assert.equal(detail.json.ticket.links.verification.merged, undefined)
})

test('POST engine/ticket/:id/accept rejects non-deployed tickets and unknown ids', async (t) => {
  const { handler } = await startApi(t)
  const notDeployed = await call(handler, 'POST', `${API}/engine/ticket/tkt_run/accept`, { ok: true })
  assert.equal(notDeployed.status, 409)
  assert.match(notDeployed.json.error, /只有已部署 UAT 的工单可以验收/)
  const missing = await call(handler, 'POST', `${API}/engine/ticket/tkt_missing/accept`, { ok: true })
  assert.equal(missing.status, 404)
  assert.match(missing.json.error, /未知工单/)
})

test('a rejected acceptance keeps the ticket in the human queue', async (t) => {
  const { handler } = await startApi(t)
  const rejected = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/accept`, { ok: false })
  assert.equal(rejected.status, 200)
  assert.equal(rejected.json.ticket.links.acceptance.ok, false)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.counts.needsHuman, 1)
  assert.equal(status.json.load.waiting, 1)
})

test('POST engine/settings persists paused and every read reflects it immediately', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const saved = await call(handler, 'POST', `${API}/engine/settings`, { paused: true })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.json.applied, ['paused'])
  assert.equal(saved.json.config.paused, true)
  assert.equal(JSON.parse(await readFile(join(stateDir, 'live.json'), 'utf8')).paused, true)

  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.paused, true)
  assert.equal(status.json.engine.paused, true)
  assert.equal(status.json.load.paused, true)
  assert.equal(status.json.config.paused, true)
  assert.equal((await call(handler, 'GET', `${API}/engine/tickets`)).json.paused, true)

  const poll = await call(handler, 'POST', `${API}/engine/poll`, { dryRun: false })
  assert.equal(poll.status, 200)
  assert.equal(poll.json.error, 'paused')
})

test('POST engine/repo/:id/token stores and clears a repository token without returning it', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const file = join(stateDir, 'gitlab.token')
  const saved = await call(handler, 'POST', `${API}/engine/repo/demo-legacy-repo/token`, { token: 'new-token-123' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.repo.tokenConfigured, true)
  assert.equal(JSON.stringify(saved.json).includes('new-token-123'), false)
  assert.equal((await readFile(file, 'utf8')).trim(), 'new-token-123')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.repos[0].tokenConfigured, true)
  assert.equal(status.json.sources.find(source => source.repoId === 'demo-legacy-repo').config.tokenConfigured, true)

  const unknown = await call(handler, 'POST', `${API}/engine/repo/nope/token`, { token: 'x' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.json.error, /未知仓库/)

  const cleared = await call(handler, 'POST', `${API}/engine/repo/demo-legacy-repo/token`, { token: '' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.repo.tokenConfigured, false)
  await assert.rejects(() => stat(file))
})

test('POST engine/settings persists group→repository bindings and rejects inconsistent ones', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const applied = await call(handler, 'POST', `${API}/engine/settings`, {
    'octo.watchChatIds': ['chat-a'], 'octo.chatTitles': { 'chat-a': 'EBS 群' }, 'octo.chatRepos': { 'chat-a': 'demo-legacy-repo' },
  })
  assert.equal(applied.status, 200)
  assert.deepEqual(applied.json.config.octo.watchChatIds, ['chat-a'])
  assert.deepEqual(applied.json.config.octo.chatRepos, { 'chat-a': 'demo-legacy-repo' })
  const written = JSON.parse(await readFile(join(stateDir, 'live.json'), 'utf8'))
  assert.deepEqual(written.octo.chatRepos, { 'chat-a': 'demo-legacy-repo' })
  assert.deepEqual(written.octo.chatTitles, { 'chat-a': 'EBS 群' })

  const unknownRepo = await call(handler, 'POST', `${API}/engine/settings`, {
    'octo.watchChatIds': ['chat-a'], 'octo.chatRepos': { 'chat-a': 'nope' },
  })
  assert.equal(unknownRepo.status, 400)
  assert.match(unknownRepo.json.error, /未知仓库/)

  const unwatched = await call(handler, 'POST', `${API}/engine/settings`, { 'octo.chatRepos': { 'chat-b': 'demo-legacy-repo' } })
  assert.equal(unwatched.status, 400)
  assert.match(unwatched.json.error, /不在监听列表/)
})

test('unknown engine routes answer 404 with an error object', async (t) => {
  const { handler } = await startApi(t)
  const response = await call(handler, 'GET', `${API}/engine/nope`)
  assert.equal(response.status, 404)
  assert.ok(response.json.error)
})
