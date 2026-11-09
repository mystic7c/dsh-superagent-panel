/**
 * Route-level tests for the redesigned panel data contract (spec/impl-contract-2026-11.md §4).
 *
 * The routes live in the plugin entry (`index.js`), so these tests mount the real handler against a temporary state
 * directory: a seeded `live-state.json`, a disabled `live.json`, and fake request/response objects. That covers the
 * dispatch, status codes and 404 bodies that the unit tests on `Engine` methods cannot.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { apply } from '../../index.js'
import { emptyLiveState } from './state.js'

const run = promisify(execFile)

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

/** Mount the real plugin handler over a temporary state directory seeded with the panel fixture. `extra` may add
 * records to the seeded live document before the engine loads (P0 inbox/gate fixtures). */
async function startApi(t, extra, extraFiles = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'superagent-api-'))
  await writeFile(join(stateDir, 'octo.token'), 'bf_test\n')
  await writeFile(join(stateDir, 'gitlab.token'), 'glpat-test\n')
  const fakeCli = join(stateDir, 'fake-octo-cli')
  await writeFile(fakeCli, '#!/bin/sh\nprintf \'%s\\n\' \'{"ok":true,"data":[{"group_no":"chat-1","name":"SuperAgent"},{"group_no":"chat-2","name":"EBS"}]}\'\n')
  await chmod(fakeCli, 0o755)
  await writeFile(join(stateDir, 'live.json'), JSON.stringify({ enabled: false, paused: false,
    octo: { watchChatIds: [], allowAnyHuman: true, cliPath: fakeCli }, executor: { enabled: true },
    // Declare the repository explicitly so the fixture never depends on the default project setting.
    repos: [{ id: 'web-app', name: 'web-app', kind: 'web', repo: '/tmp/web-app' }] }))
  const state = emptyLiveState()
  seedState(state)
  if (typeof extra === 'function') extra(state)
  await writeFile(join(stateDir, 'live-state.json'), JSON.stringify(state))
  for (const [name, value] of Object.entries(extraFiles)) await writeFile(join(stateDir, name), JSON.stringify(value))
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
  // P0-5: the fixture's deployed ticket is the only blocking inbox item; nothing is broken yet.
  assert.deepEqual(status.inbox, { blocking: 1, system: 0, unread: 1 })
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
  assert.deepEqual(status.sources.map(source => source.id), ['octo', 'gitlab:web-app'])
  assert.equal(status.defaultRepo, 'web-app')
  assert.equal(status.repos.length, 1)
  assert.equal(status.repos[0].id, 'web-app')
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
  assert.equal(gitlab.repoId, 'web-app')
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
  assert.deepEqual(Object.keys(response.json).sort(),
    ['acceptance', 'activities', 'decision', 'route', 'routePreview', 'runs', 'thread', 'ticket', 'trigger'])
  assert.equal(response.json.ticket.id, 'tkt_wait')
  // Multi-backend routing: a terminal Ticket has no executed route and nothing to preview.
  assert.equal(response.json.route, null)
  assert.equal(response.json.routePreview, null)
  const active = await call(handler, 'GET', `${API}/engine/ticket/tkt_run`)
  assert.equal(active.status, 200)
  assert.equal(active.json.route, null)
  assert.equal(typeof active.json.routePreview.backend, 'string')
  assert.equal(typeof active.json.routePreview.workType, 'string')
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
  // Accepting settles the derived blocking item: the inbox is part of the status poll, not a separate cache.
  assert.equal(after.json.inbox.blocking, 0)
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
  const saved = await call(handler, 'POST', `${API}/engine/repo/web-app/token`, { token: 'new-token-123' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.repo.tokenConfigured, true)
  assert.equal(JSON.stringify(saved.json).includes('new-token-123'), false)
  assert.equal((await readFile(file, 'utf8')).trim(), 'new-token-123')
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.repos[0].tokenConfigured, true)
  assert.equal(status.json.sources.find(source => source.repoId === 'web-app').config.tokenConfigured, true)

  const unknown = await call(handler, 'POST', `${API}/engine/repo/nope/token`, { token: 'x' })
  assert.equal(unknown.status, 404)
  assert.match(unknown.json.error, /未知仓库/)

  const cleared = await call(handler, 'POST', `${API}/engine/repo/web-app/token`, { token: '' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.repo.tokenConfigured, false)
  await assert.rejects(() => stat(file))
})

test('POST engine/settings persists group→repository bindings and rejects inconsistent ones', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const applied = await call(handler, 'POST', `${API}/engine/settings`, {
    'octo.watchChatIds': ['chat-a'], 'octo.chatTitles': { 'chat-a': 'EBS 群' }, 'octo.chatRepos': { 'chat-a': 'web-app' },
  })
  assert.equal(applied.status, 200)
  assert.deepEqual(applied.json.config.octo.watchChatIds, ['chat-a'])
  assert.deepEqual(applied.json.config.octo.chatRepos, { 'chat-a': 'web-app' })
  const written = JSON.parse(await readFile(join(stateDir, 'live.json'), 'utf8'))
  assert.deepEqual(written.octo.chatRepos, { 'chat-a': 'web-app' })
  assert.deepEqual(written.octo.chatTitles, { 'chat-a': 'EBS 群' })

  const unknownRepo = await call(handler, 'POST', `${API}/engine/settings`, {
    'octo.watchChatIds': ['chat-a'], 'octo.chatRepos': { 'chat-a': 'nope' },
  })
  assert.equal(unknownRepo.status, 400)
  assert.match(unknownRepo.json.error, /未知仓库/)

  const unwatched = await call(handler, 'POST', `${API}/engine/settings`, { 'octo.chatRepos': { 'chat-b': 'web-app' } })
  assert.equal(unwatched.status, 400)
  assert.match(unwatched.json.error, /不在监听列表/)
})

test('unknown engine routes answer 404 with an error object', async (t) => {
  const { handler } = await startApi(t)
  const response = await call(handler, 'GET', `${API}/engine/nope`)
  assert.equal(response.status, 404)
  assert.ok(response.json.error)
})


test('GET engine/octo/groups lists groups through the configured CLI', async (t) => {
  const { handler } = await startApi(t)
  const response = await call(handler, 'GET', `${API}/engine/octo/groups`)
  assert.equal(response.status, 200)
  assert.deepEqual(response.json.groups.map(group => group.id), ['chat-1', 'chat-2'])
  assert.deepEqual(response.json.groups.map(group => group.name), ['SuperAgent', 'EBS'])
})

test('POST engine/octo/token stores and clears the Octo token file', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const saved = await call(handler, 'POST', `${API}/engine/octo/token`, { token: 'new-token' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.octo.tokenConfigured, true)
  assert.equal((await readFile(join(stateDir, 'octo.token'), 'utf8')).trim(), 'new-token')
  assert.equal((await stat(join(stateDir, 'octo.token'))).mode & 0o777, 0o600)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.config.octo.tokenSource, 'file')
  const cleared = await call(handler, 'POST', `${API}/engine/octo/token`, { token: '' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.octo.tokenConfigured, false)
  await assert.rejects(() => readFile(join(stateDir, 'octo.token')))
})


test('POST engine/eval/token stores and clears the decision-model token file', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const saved = await call(handler, 'POST', `${API}/engine/eval/token`, { token: 'sk-decision' })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.eval.decision.tokenConfigured, true)
  assert.equal(saved.json.eval.decision.tokenSource, 'file')
  assert.equal((await readFile(join(stateDir, 'decision.token'), 'utf8')).trim(), 'sk-decision')
  assert.equal((await stat(join(stateDir, 'decision.token'))).mode & 0o777, 0o600)
  // The redacted status reports readiness but never the token or its path.
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.eval.decision.tokenConfigured, true)
  assert.equal('tokenFile' in status.json.eval.decision, false)
  assert.equal(JSON.stringify(status.json).includes('sk-decision'), false)
  const cleared = await call(handler, 'POST', `${API}/engine/eval/token`, { token: '' })
  assert.equal(cleared.status, 200)
  assert.equal(cleared.json.eval.decision.tokenConfigured, false)
  await assert.rejects(() => readFile(join(stateDir, 'decision.token')))
})

test('POST engine/repos adds a repository, derives its token file and validates input', async (t) => {
  const { handler, stateDir } = await startApi(t)
  const local = await mkdtemp(join(tmpdir(), 'superagent-repo-'))
  t.after(() => rm(local, { recursive: true, force: true }))
  const created = await call(handler, 'POST', `${API}/engine/repos`, { repo: {
    id: 'new-repo', name: 'New Repo', kind: 'web', repo: local, baseBranch: 'dev',
    verifyMode: 'web-uat', acceptance: 'deployed',
    gitlab: { baseUrl: 'https://gitlab.example.com', project: 'group/new-repo', targetBranch: 'dev' },
  } })
  assert.equal(created.status, 200)
  assert.equal(created.json.repo.id, 'new-repo')
  assert.match(created.json.repo.gitlab.tokenFile, /gitlab-new-repo\.token$/)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.ok(status.json.config.repos.some(repo => repo.id === 'new-repo'))
  assert.equal(status.json.config.defaultRepo, 'web-app')
  const duplicate = await call(handler, 'POST', `${API}/engine/repos`, { repo: {
    id: 'new-repo', repo: local, gitlab: { baseUrl: 'https://gitlab.example.com', project: 'g/x', targetBranch: 'dev' },
  } })
  assert.equal(duplicate.status, 400)
  const badPath = await call(handler, 'POST', `${API}/engine/repos`, { repo: {
    id: 'bad-path', repo: '/definitely/missing/repo', gitlab: { baseUrl: 'https://gitlab.example.com', project: 'g/x', targetBranch: 'dev' },
  } })
  assert.equal(badPath.status, 400)
  assert.match(badPath.json.error, /本地路径/)
})


test('GET engine/settings/history lists versions and POST restore rolls one back', async (t) => {
  const { handler } = await startApi(t)
  const saved = await call(handler, 'POST', `${API}/engine/settings`, { enabled: true })
  assert.equal(saved.status, 200)
  const history = await call(handler, 'GET', `${API}/engine/settings/history`)
  assert.equal(history.status, 200)
  assert.ok(history.json.entries.length >= 1)
  assert.match(history.json.entries[0].label, /settings:/)
  const restored = await call(handler, 'POST', `${API}/engine/settings/history/${encodeURIComponent(history.json.entries[0].id)}/restore`)
  assert.equal(restored.status, 200)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.config.enabled, false)
})

/** Add one parked gate ticket + one failed ticket + an engine error to the base fixture (P0 inbox/gate tests). */
function seedGateAndFailure(state) {
  const at = hoursAgo(0.2)
  const pendingGate = { name: 'backend', command: 'mvn test', exitCode: 1, timedOut: false, durationMs: 1200,
    outputTail: 'Tests run: 3\nBUILD FAILURE', changedPaths: ['src/A.java'], at }
  state.tickets.tkt_gate = { id: 'tkt_gate', title: '闸门工单', status: 'gate-blocked', createdAt: at, updatedAt: at,
    runId: 'run_gate', pendingGate, links: { branch: 'feature/g', worktree: '/tmp/g' } }
  state.ticketOrder.push('tkt_gate')
  state.runs.push({ id: 'run_gate', ticketId: 'tkt_gate', status: 'waiting_for_human', startedAt: at,
    stopReason: 'gate_failed', pendingGate })
  state.tickets.tkt_fail = { id: 'tkt_fail', title: '失败工单', status: 'failed', createdAt: at, updatedAt: at, runId: 'run_fail' }
  state.ticketOrder.push('tkt_fail')
  state.runs.push({ id: 'run_fail', ticketId: 'tkt_fail', status: 'failed', startedAt: at, stopReason: 'worker_failed',
    error: 'worker failed: timeout' })
  state.lastError = 'octo poll failed'
}

test('GET engine/inbox derives the five kinds and supports read/resolve with blocking guard', async (t) => {
  const { handler } = await startApi(t, seedGateAndFailure)
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.deepEqual(status.json.inbox, { blocking: 2, system: 2, unread: 4 })
  const inbox = await call(handler, 'GET', `${API}/engine/inbox`)
  assert.equal(inbox.status, 200)
  assert.deepEqual(inbox.json.counts, { blocking: 2, system: 2, unread: 4 })
  // Blocking first (gate urgent before accept normal), then system by priority (engine high before failure normal).
  assert.deepEqual(inbox.json.items.map(item => item.kind), ['gate', 'accept', 'engine', 'failure'])
  const gate = inbox.json.items[0]
  assert.equal(gate.title, '闸门 backend 未通过，等待你处理')
  assert.match(gate.summary, /BUILD FAILURE/)
  assert.deepEqual(gate.refs, { ticketId: 'tkt_gate', runId: 'run_gate' })

  const read = await call(handler, 'POST', `${API}/engine/inbox/${gate.id}/read`)
  assert.equal(read.status, 200)
  assert.ok(Number.isFinite(Date.parse(read.json.item.readAt)))
  const readAgain = await call(handler, 'POST', `${API}/engine/inbox/${gate.id}/read`)
  assert.equal(readAgain.status, 200)
  assert.equal(readAgain.json.item.readAt, read.json.item.readAt)

  const blocked = await call(handler, 'POST', `${API}/engine/inbox/${gate.id}/resolve`, { action: 'manual' })
  assert.equal(blocked.status, 409)
  const failure = inbox.json.items.find(item => item.kind === 'failure')
  const resolved = await call(handler, 'POST', `${API}/engine/inbox/${failure.id}/resolve`, { action: 'manual', note: 'seen' })
  assert.equal(resolved.status, 200)
  assert.ok(Number.isFinite(Date.parse(resolved.json.item.resolvedAt)))
  assert.equal(resolved.json.item.resolvedAction, 'manual')

  const after = await call(handler, 'GET', `${API}/engine/inbox`)
  assert.deepEqual(after.json.items.map(item => item.kind), ['gate', 'accept', 'engine'])
  assert.deepEqual(after.json.counts, { blocking: 2, system: 1, unread: 2 })
  // Read state survives a refresh: the derived item is upserted, not recreated.
  assert.ok(after.json.items.find(item => item.kind === 'gate').readAt)
  const missing = await call(handler, 'POST', `${API}/engine/inbox/nope/read`)
  assert.equal(missing.status, 404)
})

test('POST engine/ticket/:id/gate validates the action and stops a parked gate', async (t) => {
  const { handler } = await startApi(t, seedGateAndFailure)
  // A parked gate is an attention state: the host stage counters must agree with the client's waiting group.
  const waiting = await call(handler, 'GET', `${API}/engine/tickets?stage=waiting`)
  assert.ok(waiting.json.items.some(ticket => ticket.id === 'tkt_gate'), JSON.stringify(waiting.json.items.map(ticket => ticket.id)))
  const invalid = await call(handler, 'POST', `${API}/engine/ticket/tkt_gate/gate`, { action: 'nope' })
  assert.equal(invalid.status, 400)
  const notParked = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/gate`, { action: 'release' })
  assert.equal(notParked.status, 409)
  assert.match(notParked.json.error, /not waiting for a gate decision/)
  const missing = await call(handler, 'POST', `${API}/engine/ticket/tkt_missing/gate`, { action: 'stop' })
  assert.equal(missing.status, 404)

  const stopped = await call(handler, 'POST', `${API}/engine/ticket/tkt_gate/gate`, { action: 'stop', note: 'abandon' })
  assert.equal(stopped.status, 200)
  assert.equal(stopped.json.run.stopReason, 'stopped')
  assert.equal(stopped.json.ticket.status, 'failed')
  const detail = await call(handler, 'GET', `${API}/engine/ticket/tkt_gate`)
  assert.equal(detail.json.ticket.status, 'failed')
  assert.equal(detail.json.runs[0].stopReason, 'stopped')
  assert.equal(detail.json.ticket.pendingGate, undefined)
  // The gate item is auto-resolved; the failed run becomes a non-blocking system item on the next poll.
  const status = await call(handler, 'GET', `${API}/engine/status`)
  assert.equal(status.json.inbox.blocking, 1)
})

// ---------------------------------------------------------------------------
// P1: signals, operation ledger, checkpoint resume and worker questions.
// ---------------------------------------------------------------------------

function seedSignalLog() {
  const at = hoursAgo(1)
  return {
    schemaVersion: 1,
    items: {
      sig_1: { id: 'sig_1', source: 'octo', type: 'message.received', externalId: 'chat-1:msg-1', scopeKey: 'octo:chat-1',
        entryPoint: 'sync', address: { channelId: 'chat-1', messageId: 'msg-1' }, occurredAt: at, receivedAt: at,
        candidate: { channelId: 'chat-1', fromUid: 'u1', text: '生产库执行 DDL', messageId: 'msg-1', seq: 1 },
        payload: { text: '生产库执行 DDL' }, status: 'skipped', skipReason: 'senderNotAllowed', attempts: 1, createdAt: at },
    },
    byKey: { 'octo|chat-1:msg-1': 'sig_1' },
  }
}

function seedOperations() {
  return {
    schemaVersion: 1,
    items: {
      op_1: { id: 'op_1', ticketId: 'tkt_wait', status: 'deployed', trigger: 'manual', startedAt: hoursAgo(0.5),
        steps: [{ name: 'worker', state: 'ok' }], trace: [{ type: 'tool_call', name: 'bash' }],
        handoff: { summary: '修复完成' }, checkpoint: { step: 'finish', phase: 'done' } },
    },
    order: ['op_1'],
  }
}

test('GET engine/signals reads the raw log and GET engine/signal/:id returns one fact', async (t) => {
  const { handler } = await startApi(t, undefined, { 'signal-log.json': seedSignalLog() })
  const list = await call(handler, 'GET', `${API}/engine/signals?status=skipped`)
  assert.equal(list.status, 200)
  assert.equal(list.json.items.length, 1)
  assert.equal(list.json.items[0].id, 'sig_1')
  assert.equal(list.json.items[0].skipReason, 'senderNotAllowed')
  const one = await call(handler, 'GET', `${API}/engine/signal/sig_1`)
  assert.equal(one.status, 200)
  assert.equal(one.json.signal.id, 'sig_1')
  assert.equal(one.json.decision, null)
  const missing = await call(handler, 'GET', `${API}/engine/signal/nope`)
  assert.equal(missing.status, 404)
})

test('POST engine/signal/:id/replay re-judges a skipped signal and records a decision', async (t) => {
  const { handler } = await startApi(t, undefined, { 'signal-log.json': seedSignalLog() })
  const replay = await call(handler, 'POST', `${API}/engine/signal/sig_1/replay`, {})
  assert.equal(replay.status, 200)
  assert.ok(replay.json.decision?.id)
  assert.ok(replay.json.decision?.pipelineVersion)
  assert.equal(replay.json.signal.decisionId, replay.json.decision.id)
  const missing = await call(handler, 'POST', `${API}/engine/signal/nope/replay`, {})
  assert.equal(missing.status, 404)
})

test('GET engine/operations exposes the full ledger and one operation', async (t) => {
  const { handler } = await startApi(t, undefined, { 'operations.json': seedOperations() })
  const list = await call(handler, 'GET', `${API}/engine/operations?ticketId=tkt_wait`)
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.items.map(run => run.id), ['op_1'])
  const one = await call(handler, 'GET', `${API}/engine/operation/op_1`)
  assert.equal(one.status, 200)
  assert.equal(one.json.operation.trace[0].name, 'bash')
  const missing = await call(handler, 'GET', `${API}/engine/operation/nope`)
  assert.equal(missing.status, 404)
})

test('resume/answer validate state and accept intents passes through', async (t) => {
  const { handler } = await startApi(t)
  const resume = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/resume`, {})
  assert.equal(resume.status, 409)
  const answerMissing = await call(handler, 'POST', `${API}/engine/ticket/tkt_missing/answer`, { answer: 'A' })
  assert.equal(answerMissing.status, 404)
  const empty = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/answer`, { answer: '  ' })
  assert.equal(empty.status, 400)
  const rejected = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/accept`, { ok: false, note: '缺证据',
    intents: ['no-evidence', 'bogus'] })
  assert.equal(rejected.status, 200)
  assert.equal(rejected.json.ticket.links.acceptance.ok, false)
})

// ---------------------------------------------------------------------------
// P2: per-Ticket automation and signal quality labels.
// ---------------------------------------------------------------------------

test('POST engine/ticket/:id/automation normalizes and validates the schedule', async (t) => {
  const { handler } = await startApi(t)
  const saved = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/automation`, {
    mode: 'heartbeat', enabled: true, intervalMinutes: 30, maxExecutions: 3,
  })
  assert.equal(saved.status, 200)
  assert.equal(saved.json.automation.mode, 'heartbeat')
  assert.equal(saved.json.automation.enabled, true)
  assert.equal(saved.json.automation.intervalMinutes, 30)
  assert.equal(saved.json.automation.maxExecutions, 3)
  assert.ok(Number.isFinite(Date.parse(saved.json.automation.nextAt)))
  assert.ok(Array.isArray(saved.json.ticket.activities))
  assert.ok(saved.json.ticket.activities.some(activity => /自动化/.test(activity.detail ?? '')))
  const invalid = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/automation`, { mode: 'schedule', enabled: true, at: '25:99' })
  assert.equal(invalid.status, 409)
  const missing = await call(handler, 'POST', `${API}/engine/ticket/tkt_missing/automation`, { mode: 'off' })
  assert.equal(missing.status, 404)
})

test('POST engine/signal/:id/label appends a quality label and counts it', async (t) => {
  const { handler } = await startApi(t, undefined, { 'signal-log.json': seedSignalLog() })
  const labeled = await call(handler, 'POST', `${API}/engine/signal/sig_1/label`, { label: 'false_wake', note: '不是给 agent 的活' })
  assert.equal(labeled.status, 200)
  assert.equal(labeled.json.signal.labels.length, 1)
  assert.equal(labeled.json.signal.labels[0].label, 'false_wake')
  assert.equal(labeled.json.signal.labels[0].note, '不是给 agent 的活')
  const list = await call(handler, 'GET', `${API}/engine/signals`)
  assert.equal(list.json.counts.labels.false_wake, 1)
  assert.equal(list.json.counts.labels.correct, 0)
  assert.equal(list.json.items[0].labels.length, 1)
  const invalid = await call(handler, 'POST', `${API}/engine/signal/sig_1/label`, { label: 'nope' })
  assert.equal(invalid.status, 409)
  const missing = await call(handler, 'POST', `${API}/engine/signal/nope/label`, { label: 'correct' })
  assert.equal(missing.status, 404)
})

// ---------------------------------------------------------------------------
// P2-9: run-quality metrics endpoint.
// ---------------------------------------------------------------------------

function seedMetricsOperations() {
  return {
    schemaVersion: 1,
    items: {
      op_ok: { id: 'op_ok', ticketId: 'tkt_wait', status: 'deployed', trigger: 'manual', startedAt: hoursAgo(2),
        completedAt: hoursAgo(1.9), stopReason: 'done' },
      op_fail: { id: 'op_fail', ticketId: 'tkt_run', status: 'failed', trigger: 'auto', startedAt: hoursAgo(1),
        completedAt: hoursAgo(0.95), stopReason: 'gate_failed', error: 'backend gate failed (exit 1)',
        repair: { attempts: 1, max: 1, status: 'exhausted' } },
    },
    order: ['op_ok', 'op_fail'],
  }
}

test('GET engine/metrics aggregates runs and rejects an unknown window', async (t) => {
  const { handler } = await startApi(t, undefined, { 'operations.json': seedMetricsOperations() })
  const metrics = await call(handler, 'GET', `${API}/engine/metrics?window=24h`)
  assert.equal(metrics.status, 200)
  assert.equal(metrics.json.window, '24h')
  assert.equal(metrics.json.runs.total, 2)
  assert.equal(metrics.json.runs.succeeded, 1)
  assert.equal(metrics.json.runs.failed, 1)
  assert.equal(metrics.json.runs.repaired, 1)
  assert.equal(metrics.json.runs.repairExhausted, 1)
  assert.equal(metrics.json.triggers.manual, 1)
  assert.equal(metrics.json.triggers.auto, 1)
  assert.equal(metrics.json.stopReasons.done, 1)
  assert.equal(metrics.json.failureReasons.length, 1)
  assert.match(metrics.json.failureReasons[0].reason, /backend gate failed/)
  assert.equal(metrics.json.cost.available, false)
  assert.ok(Number.isFinite(metrics.json.duration.avgMs))
  const all = await call(handler, 'GET', `${API}/engine/metrics?window=all`)
  assert.equal(all.status, 200)
  assert.equal(all.json.windowStart, undefined)
  const invalid = await call(handler, 'GET', `${API}/engine/metrics?window=bad`)
  assert.equal(invalid.status, 400)
})

// P1 §3.2: the on-demand diff behind the Ticket's "what changed" view.
// ---------------------------------------------------------------------------

test('GET engine/ticket/:id/diff reads the run worktree diff and 404s an unknown Ticket', async (t) => {
  const repo = await mkdtemp(join(tmpdir(), 'superagent-diff-route-'))
  const git = (...args) => run('git', args, { cwd: repo }).then(result => String(result.stdout).trim())
  t.after(async () => { await rm(repo, { recursive: true, force: true }) })
  await git('init', '-b', 'dev')
  await git('config', 'user.name', 'Test')
  await git('config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'a.txt'), 'one\n')
  await git('add', '-A')
  await git('commit', '-m', 'init')
  const baseSha = await git('rev-parse', 'HEAD')
  await writeFile(join(repo, 'a.txt'), 'one\ntwo\n')
  await writeFile(join(repo, 'b.txt'), 'new file\n')

  const { handler } = await startApi(t, (state) => {
    state.tickets.tkt_diff = { id: 'tkt_diff', title: 'diff 工单', status: 'ready', createdAt: hoursAgo(1),
      updatedAt: hoursAgo(1), origin: {} }
    state.ticketOrder = [...(state.ticketOrder ?? []), 'tkt_diff']
    state.runs = [
      { id: 'run_gone', ticketId: 'tkt_diff', status: 'dry-run', dryRun: true, startedAt: hoursAgo(2),
        worktree: `${repo}-cleaned`, baseSha, changedPaths: [] },
      { id: 'run_diff', ticketId: 'tkt_diff', status: 'dry-run', dryRun: true, startedAt: hoursAgo(1),
        worktree: repo, baseSha, changedPaths: ['a.txt', 'b.txt'] },
      ...(state.runs ?? [])]
  })

  const res = await call(handler, 'GET', `${API}/engine/ticket/tkt_diff/diff`)
  assert.equal(res.status, 200)
  assert.equal(res.json.available, true)
  assert.equal(res.json.runId, 'run_diff')
  assert.equal(res.json.baseSha, baseSha)
  assert.match(res.json.diff, /^\+two$/m)
  assert.match(res.json.diff, /b\/b\.txt/)
  assert.deepEqual(res.json.files.map(file => file.path).sort(), ['a.txt', 'b.txt'])

  // `?path=` narrows the response to the one file the panel's file row asked for.
  const one = await call(handler, 'GET', `${API}/engine/ticket/tkt_diff/diff?path=a.txt`)
  assert.equal(one.status, 200)
  assert.equal(one.json.path, 'a.txt')
  assert.deepEqual(one.json.files.map(file => file.path), ['a.txt'])
  assert.ok(!one.json.diff.includes('b/b.txt'))

  // A run whose worktree was cleaned up answers available:false with a reason instead of pretending nothing changed.
  const unavailable = await call(handler, 'GET', `${API}/engine/ticket/tkt_diff/diff?runId=run_gone`)
  assert.equal(unavailable.status, 200)
  assert.equal(unavailable.json.available, false)
  assert.equal(unavailable.json.reason, 'no-worktree')

  const missing = await call(handler, 'GET', `${API}/engine/ticket/tkt_missing/diff`)
  assert.equal(missing.status, 404)
})

// P2: "add a requirement and rerun" — the route validates the Ticket state before any run starts.
// ---------------------------------------------------------------------------

test('POST engine/ticket/:id/revision 404s an unknown Ticket and 409s a Ticket without a revision slot', async (t) => {
  const { handler } = await startApi(t, (state) => {
    // A parked question owns the Ticket: no revision slot (the answer flow is the way in).
    state.tickets.tkt_answer = { id: 'tkt_answer', title: '等待回答的工单', status: 'awaiting-answer',
      createdAt: hoursAgo(1), updatedAt: hoursAgo(1), origin: {} }
  })
  const missing = await call(handler, 'POST', `${API}/engine/ticket/tkt_missing/revision`, { text: '再改' })
  assert.equal(missing.status, 404)
  const empty = await call(handler, 'POST', `${API}/engine/ticket/tkt_wait/revision`, { text: '   ' })
  assert.equal(empty.status, 409)
  assert.match(empty.json.error, /不能为空/)
  // Validation fails before executeTicket is ever called for a Ticket that has no revision slot.
  const parked = await call(handler, 'POST', `${API}/engine/ticket/tkt_answer/revision`, { text: '再改' })
  assert.equal(parked.status, 409)
  assert.match(parked.json.error, /回答/)
})
