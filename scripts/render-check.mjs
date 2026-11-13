// Headless render check for the panel (no browser, no CDP).
//
// Loads the real client fragments with React + jsdom from the local harness, feeds them fixtures built from the
// real engine state (read-only: state.load() never reconciles or writes), and walks the acceptance flow:
// overview -> 去验收 -> ticket detail -> 验收通过 -> back to the desk.
//
//   node scripts/render-check.mjs
//
// It depends on /tmp/sa-harness (jsdom + react + react-dom), which the desktop image provides for verification.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const harness = join('/tmp', 'sa-harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const React = requireHarness('react')
const ReactDOM = requireHarness('react-dom/client')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'http://127.0.0.1:1/', pretendToBeVisual: true })
const { window } = dom
window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {} })
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
global.window = window
global.document = window.document
global.HTMLElement = window.HTMLElement
global.sessionStorage = window.sessionStorage
global.location = window.location
global.ResizeObserver = window.ResizeObserver
try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }) } catch { /* node keeps its own */ }

// ---- fixtures from the real live state (read-only) ---------------------------------------------------------------
const { Engine } = await import('../lib/live/engine.js')
const stateDir = process.env.DSH_SUPERAGENT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'superagent')
const engine = new Engine({ stateDir, log: () => {} })
await engine.state.load()
// Real in-flight work must not leak into these checks: while a gate runs, the Ticket under review is `working`
// and live-state keeps only the thin run index row (steps stripped by summarizeRun), so the overview pulse
// sentence degrades to a bare duration and "overview surfaces in-progress work" flips red for a reason the
// diff never caused. The fixtures below pin the rows these checks read, so drop the in-flight originals first.
const IN_FLIGHT_STATUSES = new Set(['working', 'running', 'ci-pending', 'merged', 'deploy-pending'])
for (const ticket of Object.values(engine.state.tickets ?? {})) {
  if (!IN_FLIGHT_STATUSES.has(ticket?.status)) continue
  delete engine.state.tickets[ticket.id]
  if (Array.isArray(engine.state.state?.ticketOrder)) {
    engine.state.state.ticketOrder = engine.state.state.ticketOrder.filter(id => id !== ticket.id)
  }
}
if (Array.isArray(engine.state.state?.runs)) {
  engine.state.state.runs = engine.state.state.runs.filter(run => !IN_FLIGHT_STATUSES.has(run?.status))
}
// Repository ids/projects come from this machine's live.json, so the checks below never assume specific
// project names; only the machine that runs the check needs them configured.
const { loadLiveConfig } = await import('../lib/live/config.js')
const { configRepos } = await import('../lib/live/repos.js')
const loadedLive = loadLiveConfig(stateDir)
const liveRepos = configRepos(loadedLive.config)
const primaryRepoId = liveRepos[0]?.id ?? 'repo-1'
const defaultRepoId = loadedLive.config.defaultRepo ?? primaryRepoId
const repoLabels = liveRepos.map(repo => repo.gitlab.project || repo.id)
const nowIso = new Date().toISOString()
// Always inject the walkthrough Ticket. The old guard skipped it whenever the operator's real state happened to hold
// another pending acceptance, which changed which inbox row the detail walkthrough opened (and broke it entirely when
// that row did not exist). Fixture data must not depend on the operator's inbox.
{
  const demoId = 'tkt_demo_accept'
  engine.state.tickets[demoId] = {
    id: demoId, title: '演示：验收按钮流程',
    body: 'UC-DEMO-001：检查验收按钮把工单移出待处理。\n\nSELECT Gcc.Segment1 公司, Hou.Name 公司名称, Gjh.Period_Name 期间\nFROM Gl_Je_Headers Gjh, Gl_Je_Batches Gbh, Gl_Je_Lines Gjl\nWHERE Gjh.Je_Batch_Id = Gbh.Je_Batch_Id AND Gjh.Je_Header_Id = Gjl.Je_Header_Id;',
    status: 'deployed', repoId: primaryRepoId, createdAt: nowIso, updatedAt: nowIso, assignments: [],
    origin: { threadKey: 'octo:demo', actor: 'demo' },
    revisions: [{ id: 'rev_demo', at: nowIso, text: '演示：BI 表改到 CUX schema' }],
    links: { branch: 'feature/tkt_demo_accept', commit: 'demo1234', worktree: '/tmp/demo',
      verification: { merged: true, changed: true, at: nowIso, uat: { ok: true, status: 200, checkedAt: nowIso } },
      mergeRequest: { iid: 1, webUrl: 'https://example.test/mr/1', state: 'merged' },
      deployment: { status: 'success', deployJob: { name: 'deploy_dev', status: 'success' } } },
  }
  engine.state.state.ticketOrder.push(demoId)
  const stepNames = ['prepare-worktree', 'worker', 'changed-paths', 'bootstrap:pnpm', 'gate:standards', 'gate:backend',
    'gate:frontend', 'commit', 'push', 'merge-request']
  const steps = stepNames.map((name, index) => ({ name,
    at: new Date(Date.now() - (10 - index) * 60_000).toISOString(), state: 'ok', exitCode: 0 }))
  // The run recorded the phase it handed the Ticket off at (`ci-pending`) and finished there; the Ticket went on to
  // merge and deploy. Its row must read that phase as history, never as a live CI spinner.
  engine.state.runs.unshift({ id: 'run_demo', ticketId: demoId, status: 'ci-pending', stopReason: 'done', startedAt: nowIso,
    completedAt: nowIso, endedAt: nowIso,
    steps, worker: { text: '## 改动内容\n\n1、修复验收流程。\n2、补充演示列表。' }, changedPaths: ['demo/one/File.java', 'demo/one/Service.java', 'demo/one/Validator.java', 'demo/two/FileTest.java', 'demo/two/ServiceTest.java', 'docs/spec-a.md', 'docs/spec-b.md', 'docs/push.md'],
    gates: [{ name: 'standards', exitCode: 0 }, { name: 'demo-deploy', exitCode: 0 }] })
  // An older round: the changes section must describe the newest run, not the first one.
  engine.state.runs.push({ id: 'run_demo_old', ticketId: demoId, status: 'dry-run', dryRun: true,
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), completedAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    steps: [], worker: { text: '旧一轮的总结不应该出现在改动内容里' }, changedPaths: [] })
}
// A working Ticket makes the "in progress" desk block and header count deterministic for this check.
const demoWorkId = 'tkt_demo_running'
engine.state.tickets[demoWorkId] = {
  id: demoWorkId, title: '演示：正在执行的工单', body: 'UC-DEMO-002：检查概览是否显示执行中的工单。',
  status: 'working', repoId: primaryRepoId, createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(), runId: 'run_demo_working', assignments: [],
  origin: { threadKey: 'octo:demo', actor: 'demo' },
  links: { branch: 'feature/tkt_demo_running', mergeRequest: null, pipeline: null },
}
engine.state.state.ticketOrder.push(demoWorkId)
engine.state.runs.unshift({ id: 'run_demo_working', ticketId: demoWorkId, status: 'running',
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  steps: [{ name: 'prepare-worktree', state: 'ok', at: new Date(Date.now() - 5 * 60_000).toISOString() },
    { name: 'export-repo', state: 'running', at: new Date(Date.now() - 2 * 60_000).toISOString() }] })

// A finished dry run: ready to publish, so the detail page must lead with 发布 MR (rerun stays in the ⋯ menu).
const demoReadyId = 'tkt_demo_ready'
engine.state.tickets[demoReadyId] = {
  id: demoReadyId, title: '演示：干跑完成待发布', body: 'UC-DEMO-003：干跑完成，等待确认发布。',
  status: 'ready', repoId: primaryRepoId, createdAt: nowIso, updatedAt: nowIso, runId: 'run_demo_ready', assignments: [],
  origin: { threadKey: 'octo:demo', actor: 'demo' },
  links: { branch: 'feature/tkt_demo_ready', worktree: '/tmp/demo-ready' },
}
engine.state.state.ticketOrder.push(demoReadyId)
engine.state.runs.unshift({ id: 'run_demo_ready', ticketId: demoReadyId, status: 'dry-run', dryRun: true,
  startedAt: nowIso, completedAt: nowIso,
  steps: [{ name: 'prepare-worktree', state: 'ok', at: nowIso }, { name: 'worker', state: 'ok', at: nowIso },
    { name: 'changed-paths', state: 'ok', at: nowIso }, { name: 'gate:standards', state: 'ok', at: nowIso },
    { name: 'finish', state: 'ok', at: nowIso }] })

// A deterministic "worth a look" fixture: the Overview watchlist only renders when the derived state flags something.
// Deriving that from the operator's real state made the split-note assertion flip red and green for the same build
// (an inbox with no recent failure simply has an empty watchlist). Pin one failed run and one dismissed-after-failure
// Ticket into the in-memory state instead, so the watchlist and its split note are always on screen. Nothing is written.
const failedAt = new Date(Date.now() - 45 * 60_000).toISOString()
const fixtureFailure = '演示：闸门 standards 未通过'
engine.state.runs.unshift({ id: 'run_demo_failed', ticketId: 'tkt_demo_accept', status: 'failed', startedAt: failedAt,
  completedAt: failedAt, endedAt: failedAt, error: fixtureFailure, stopReason: 'gate-failed',
  steps: [{ name: 'gate:standards', state: 'failed', at: failedAt, exitCode: 1 }],
  worker: { text: '闸门 standards 未通过' } })
const demoDismissedId = 'tkt_demo_dismissed'
engine.state.tickets[demoDismissedId] = {
  id: demoDismissedId, title: '演示：失败后被忽略的工单', body: 'UC-DEMO-004：失败后由人放弃，检查执行页的已忽略切片。',
  status: 'dismissed', repoId: primaryRepoId, createdAt: failedAt, updatedAt: failedAt,
  assignments: [{ at: failedAt, report: { state: 'failed', reason: fixtureFailure } }],
  origin: { threadKey: 'octo:demo', actor: 'demo' }, links: {},
}
engine.state.state.ticketOrder.push(demoDismissedId)

// AC-08/09 fixture: a Ticket with two persisted rounds. The first file list was truncated/redacted and the baseline
// moved, so the detail card must show incompleteness and must not report the missing files as deletions.
engine.evidence.documents.set('tkt_demo_accept', {
  ticketId: 'tkt_demo_accept', updatedAt: nowIso,
  rounds: [
    { id: 'ev_demo_old', ticketId: 'tkt_demo_accept', runId: 'run_demo_old', round: 1,
      at: '2026-11-01T00:00:00.000Z', branch: 'feature/tkt_demo_accept', baseSha: 'base-old-1', headSha: 'head-old-1',
      files: [{ path: 'demo/one/File.java', digest: 'aaaa' }], filesOmitted: 3, filesRedacted: 1,
      patch: { text: 'diff --git a/demo/one/File.java', truncated: true, bytes: 120 },
      gates: [{ name: 'standards', state: 'passed', at: '2026-11-01T00:00:00.000Z', codeFingerprint: 'fp-old' }],
      acceptance: { requirements: ['UC-DEMO-001'] },
      platform: { pushed: true, pr: 'waiting', prUrl: 'https://example.test/pull/new/feature/tkt_demo_accept' } },
    { id: 'ev_demo_new', ticketId: 'tkt_demo_accept', runId: 'run_demo', round: 2,
      at: '2026-11-02T00:00:00.000Z', branch: 'feature/tkt_demo_accept', baseSha: 'base-new-2', headSha: 'head-new-2',
      files: [{ path: 'demo/one/File.java', digest: 'aaaa' }, { path: 'demo/one/Service.java', digest: 'bbbb' }],
      gates: [{ name: 'standards', state: 'passed', at: '2026-11-01T00:00:00.000Z', codeFingerprint: 'fp-old' },
        { name: 'demo-deploy', state: 'failed', at: '2026-11-02T00:00:00.000Z' }],
      acceptance: { requirements: ['UC-DEMO-001', 'UC-DEMO-005'] },
      platform: { pushed: true, pr: 'merged', merged: true } },
  ],
})

engine.lastStatus = { phase: 'ok', mode: 'sync', at: new Date().toISOString() }
engine.started = true
// P0: the panel now reads the derived inbox; build it from the same fixture state. Saving is stubbed so this read-only
// check never writes inbox.json into the operator's real state directory.
await engine.inbox.load()
engine.inbox.save = async () => {}
await engine.refreshInbox()
const fixtures = {
  status: engine.status(),
  tickets: engine.ticketsView({}),
  threads: engine.threadsView({}),
  decisions: engine.decisionsView({}),
  inbox: engine.inboxView(),
}
// Inject one shadow row so the Eval page's model tag is exercised even when the operator's state has no shadow data.
// It is an in-memory fixture only; nothing is written.
if (Array.isArray(fixtures.decisions.items) && fixtures.decisions.items.length) {
  const shadowed = fixtures.decisions.items[0]
  shadowed.shadow = { status: 'ok', at: nowIso, model: 'decision-model-preview', questions: 'request-v1',
    ruleKind: shadowed.kind, p: 0.93, riskP: 0.04, verdict: 'accept', latencyMs: 12 }
  // AC-07: the Eval row must link the run it caused, not only the Ticket; pin one so the render assertion is stable.
  shadowed.runs = [{ ticketId: 'tkt_demo_accept', runId: 'run_demo_accept', status: 'done', at: nowIso }]
}
const detailOf = id => engine.ticketView(id)
const threadOf = key => engine.threadView(key)

function recalcStatus() {
  const tickets = Object.values(engine.state.tickets)
  const waiting = tickets.filter(ticket => ticket.status === 'deployed' || ticket.status === 'mr-open' || ticket.status === 'ci-passed')
    .filter(ticket => ticket.links?.acceptance?.ok !== true).length
  const failed = tickets.filter(ticket => ['failed', 'ci-failed', 'deploy-failed'].includes(ticket.status)).length
  fixtures.status.counts.needsHuman = waiting + failed
  fixtures.status.load.waiting = waiting
  fixtures.tickets = engine.ticketsView({})
  fixtures.status.tickets = tickets.slice().reverse()
}

const calls = []
// Captured by the mock so AC-01 (manual override submit) and AC-03 (stop UI) can assert the actual request.
let lastCreateRequest = null
let lastStopId = null
// AC-07 deep-link probe: set just before the source-page remount so earlier checks still see the real (empty) log.
let signalFixture
window.fetch = global.fetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1:1')
  const method = String(init.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${url.pathname}${url.search}`)
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  const p = url.pathname.replace('/superagent/api/', '')
  if (method === 'GET' && p === 'engine/status') return json(fixtures.status)
  if (method === 'GET' && p === 'engine/tickets') return json(fixtures.tickets)
  if (method === 'GET' && p === 'engine/inbox') return json(fixtures.inbox)
  if (method === 'GET' && p === 'engine/signals') {
    return json(signalFixture
      ? { items: [signalFixture], total: 1, counts: { all: 1, pending: 0, processed: 1, ignored: 0, skipped: 0, failed: 0 } }
      : { items: [], total: 0, counts: { all: 0, pending: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 } })
  }
  if (method === 'GET' && p === 'engine/metrics') return json({
    // Aligned with the deterministic failed run injected above: the quality card and the watchlist must not contradict
    // each other (a 0-failure card next to a "1 execution failed" watch row would).
    window: '24h', generatedAt: new Date().toISOString(),
    runs: { total: 3, succeeded: 1, failed: 1, stopped: 0, interrupted: 0, parked: 0, running: 1, repaired: 0, repairSucceeded: 0, repairExhausted: 0 },
    duration: { avgMs: 120000, p50Ms: 120000, p95Ms: 120000, totalMs: 120000 }, triggers: { manual: 1 },
    stopReasons: { done: 1, 'gate-failed': 1 }, failureReasons: [{ reason: fixtureFailure, count: 1 }], byRepo: [],
    acceptance: { rounds: 0, delivered: 0, failed: 0, errored: 0, accepted: 0, rejected: 0, avgRoundsToAccept: 0 },
    signals: { total: 0, processed: 0, ignored: 0, skipped: 0, failed: 0, labels: { correct: 0, false_wake: 0, missed_wake: 0, cleared: 0 } },
    cost: { available: false, note: 'not available in this check' },
  })
  const readItem = /^engine\/inbox\/([^/]+)\/read$/.exec(p)
  if (method === 'POST' && readItem) {
    const item = fixtures.inbox.items.find(candidate => candidate.id === decodeURIComponent(readItem[1]))
    if (item) item.readAt = new Date().toISOString()
    return json({ item })
  }
  const diffRoute = /^engine\/ticket\/([^/]+)\/diff$/.exec(p)
  if (method === 'GET' && diffRoute) {
    const file = url.searchParams.get('path') ?? 'demo/one/File.java'
    return json({ ticketId: decodeURIComponent(diffRoute[1]), runId: 'run_demo', baseSha: 'abc12345', available: true,
      path: file, bytes: 68, truncated: false, omitted: 0, files: [{ path: file, additions: 1, deletions: 0 }],
      diff: `diff --git a/${file} b/${file}\nindex 1111111..2222222 100644\n--- a/${file}\n+++ b/${file}\n@@ -1 +1,2 @@\n old line\n+new line\n` })
  }
  const signalRoute = /^engine\/signal\/([^/]+)$/.exec(p)
  if (method === 'GET' && signalRoute) {
    const id = decodeURIComponent(signalRoute[1])
    if (id === 'sig_gone') {
      return new Response(JSON.stringify({ error: 'signal not found' }), { status: 404,
        headers: { 'content-type': 'application/json' } })
    }
    return json({ signal: { id: 'sig_demo', status: 'processed', source: 'octo', receivedAt: nowIso,
      candidate: { text: '修复网页登录问题，需要联网查文档' }, scopeKey: 'octo:chat-demo', ticketId: 'tkt_demo_accept' },
    decision: { id: 'dec_demo' }, trigger: { threads: ['octo:chat-demo'] }, ticket: { id: 'tkt_demo_accept' } })
  }
  const evidenceCompare = /^engine\/evidence\/([^/]+)\/compare$/.exec(p)
  if (method === 'GET' && evidenceCompare) {
    return json(engine.evidenceCompare(decodeURIComponent(evidenceCompare[1]),
      url.searchParams.get('from') ?? undefined, url.searchParams.get('to') ?? undefined) ?? {})
  }
  const evidenceRoute = /^engine\/evidence\/([^/]+)$/.exec(p)
  if (method === 'GET' && evidenceRoute) return json(engine.evidenceView(decodeURIComponent(evidenceRoute[1])) ?? {})
  if (method === 'GET' && p.startsWith('engine/ticket/')) {
    const id = decodeURIComponent(p.slice('engine/ticket/'.length))
    return json(detailOf(id))
  }
  if (method === 'GET' && p === 'engine/threads') return json(fixtures.threads)
  if (method === 'GET' && p.startsWith('engine/thread/')) return json(threadOf(decodeURIComponent(p.slice('engine/thread/'.length))))
  if (method === 'GET' && p === 'engine/decisions') return json(fixtures.decisions)
  if (method === 'GET' && p === 'engine/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const has = value => String(value ?? '').toLowerCase().includes(q)
    const tickets = fixtures.tickets.items.filter(ticket => has(ticket.title) || has(ticket.body)).slice(0, 6)
      .map(ticket => ({ id: ticket.id, title: ticket.title, status: ticket.status, updatedAt: ticket.updatedAt }))
    const threads = fixtures.threads.items.filter(thread => has(thread.title)).slice(0, 6)
      .map(thread => ({ key: thread.key, title: thread.title, source: thread.source, lastAt: thread.lastAt }))
    const triggers = (fixtures.status.triggers ?? []).filter(trigger => has(trigger.text)).slice(0, 8)
    return json({ query: q, tickets, threads, triggers, total: tickets.length + threads.length + triggers.length })
  }
  const revisionRoute = /^engine\/ticket\/([^/]+)\/revision$/.exec(p)
  if (method === 'POST' && revisionRoute) return json({ started: true, dryRun: true })
  const accept = /^engine\/ticket\/([^/]+)\/accept$/.exec(p)
  if (method === 'POST' && accept) {
    const id = decodeURIComponent(accept[1])
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const acceptance = { ok: body.ok !== false, at: new Date().toISOString() }
    engine.state.tickets[id] = { ...engine.state.tickets[id], links: { ...engine.state.tickets[id].links, acceptance } }
    recalcStatus()
    // P0: accepting settles the derived accept item; drop it from the fixture inbox as the next refresh would.
    fixtures.inbox.items = fixtures.inbox.items.filter(item => !(item.refs?.ticketId === id && item.blocking === true))
    fixtures.inbox.counts = {
      blocking: fixtures.inbox.items.filter(item => item.blocking === true).length,
      system: fixtures.inbox.items.filter(item => item.blocking !== true).length,
      unread: fixtures.inbox.items.filter(item => !item.readAt).length,
    }
    fixtures.status.inbox = { ...fixtures.inbox.counts }
    return json({ ticket: engine.state.tickets[id] })
  }
  if (method === 'POST' && p === 'engine/ticket') {
    lastCreateRequest = init.body ? JSON.parse(String(init.body)) : {}
    return json({ ticket: { id: 'tkt_render_created', title: lastCreateRequest.title, body: lastCreateRequest.body,
      status: 'queued', repoId: primaryRepoId, routeSelection: lastCreateRequest.route, createdAt: nowIso, updatedAt: nowIso } })
  }
  const stopRoute = /^engine\/ticket\/([^/]+)\/stop$/.exec(p)
  if (method === 'POST' && stopRoute) {
    const id = decodeURIComponent(stopRoute[1])
    const ticket = engine.state.tickets[id]
    if (!ticket) return new Response(JSON.stringify({ error: '未知工单' }), { status: 404, headers: { 'content-type': 'application/json' } })
    lastStopId = id
    // Keep the state mutation in memory: the render check must not write the real state directory.
    ticket.stopRequested = { at: nowIso, by: 'render-check' }
    ticket.updatedAt = nowIso
    return json({ ticket: engine.ticketView(id)?.ticket ?? ticket, stopping: true })
  }
  if (method === 'POST' && p === 'engine/route') {
    // Same three dimensions the host returns: deliverable / capabilities / backend, plus the manual selection echo.
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const selection = body.selection ?? {}
    const deliverable = selection.deliverable ?? 'change'
    const backend = selection.backend ?? 'dsh'
    return json({
      route: { workType: deliverable === 'report' ? 'analysis' : 'dev',
        profile: deliverable === 'report' ? 'read-only' : 'write', deliverable,
        capabilities: deliverable === 'report' ? ['exec'] : ['edit', 'exec'], backend,
        reason: { code: selection.backend || selection.deliverable ? 'manual' : 'default' },
        mode: selection.backend || selection.deliverable ? 'manual' : 'single',
        applied: Boolean(selection.backend || selection.deliverable), execBackend: backend,
        execProfile: deliverable === 'report' ? 'read-only' : 'write' },
      options: { backends: ['dsh', 'codex'], deliverables: ['change', 'report'] },
    })
  }
  if (method === 'POST' && p === 'engine/poll') return json({ fetched: 0, accepted: [], ignored: [], skipped: [], dryRun: true })
  // AC-10: saving one repository edit answers with the saved summary and the config view, exactly like the Host; the
  // fixture is mutated in memory only so the check never writes live.json.
  const repoEditRoute = /^engine\/repo\/([^/]+)$/.exec(p)
  if (method === 'POST' && repoEditRoute) {
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const patch = body.patch ?? body
    const list = Array.isArray(fixtures.status.repos) ? fixtures.status.repos : []
    const repo = list.find(item => item.id === decodeURIComponent(repoEditRoute[1]))
    if (repo) Object.assign(repo, patch)
    fixtures.status.config = { ...(fixtures.status.config ?? {}), repos: list }
    return json({ repo, config: fixtures.status.config })
  }
  return json({})
}

// ---- load the real client fragments ----------------------------------------------------------------------------
const prelude = `
const React = require('react')
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useContext, createContext, Fragment } = React
const h = React.createElement
`
const files = readdirSync(join(root, 'client', 'src')).filter(name => name.endsWith('.js') && name !== '90-apply.js').sort()
const source = files.map(name => readFileSync(join(root, 'client', 'src', name), 'utf8')).join('\n')
const factory = new Function('require', prelude + source + '\nreturn { App, translate, DICTS, PAGE_TEXT, MarkdownLite, PANEL_CSS, settingsPatchOf }')
const { App, translate, DICTS, PAGE_TEXT, MarkdownLite, PANEL_CSS, settingsPatchOf } = factory(id => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})

const t = (key, values) => {
  const pair = PAGE_TEXT[key]
  let template = pair ? pair[0] : (DICTS.zh[key] ?? DICTS.zh[key] ?? key)
  if (values === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}
t.lang = 'zh'

const errors = []
const originalError = console.error
console.error = (...args) => { errors.push(args.map(a => a?.stack ?? String(a)).join(' ')); originalError(...args) }
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rootElement = window.document.getElementById('root')
console.log('STEP mount')
const rootDom = ReactDOM.createRoot(rootElement)
rootDom.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
console.log('STEP rendered')

const text = () => rootElement.textContent
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) console.log(`FAIL ${name} ${detail}`) }
// A few assertions genuinely depend on this machine's configuration or history (repositories, octo bindings, decisions,
// threads). On a fresh DSH_HOME they cannot hold; SKIP them and keep the gate green instead of failing for a reason the
// change under review did not cause. Skips are printed and counted in the summary, never as failures.
const skipped = []
const skip = (name, reason) => { skipped.push({ name, reason }); console.log(`SKIP ${name} — ${reason}`) }
const octoCard = (fixtures.status.sources ?? []).find(source => source.id === 'octo')
const sourcePageReady = (fixtures.status.sources ?? []).length > 0
  && !(octoCard && (octoCard.config?.watchChatIds ?? []).length === 0 && fixtures.status.config?.octo?.tokenConfigured !== true)
const uatReady = Boolean((fixtures.status.repos ?? []).find(repo => repo.id === primaryRepoId)?.uatUrl)
const evalReady = (fixtures.decisions.items ?? []).length > 0
const threadReady = (fixtures.threads.items ?? []).length > 0
const twoReposConfigured = liveRepos.length >= 2
const ebsConfigured = liveRepos.some(repo => repo.id === 'ebs')
const clickByText = (label, selector = 'button') => {
  const node = [...rootElement.querySelectorAll(selector)].find(el => (el.textContent ?? '').trim() === label)
  if (!node) return undefined
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return node
}

console.log('STEP checks')
check('overview shows the desk', text().includes('需要你处理'), text().slice(0, 120))
{
  // User data may quote any phrase: this Ticket's own title quotes 数据更新于 17:21, and it renders as an in-flight
  // row. Assert the page chrome (everything outside list rows) so a Ticket body can never fake a second status line
  // or a retired label.
  const chrome = rootElement.cloneNode(true)
  chrome.querySelectorAll('.sa-list').forEach(node => node.remove())
  const chromeText = chrome.textContent ?? ''
  check('overview shows one updated-at and no stale wording',
    (chromeText.match(/数据更新于/g) ?? []).length <= 1 && !/立即轮询|上次检查|待处理/.test(chromeText),
    chromeText.slice(0, 260))
  check('overview no longer duplicates the executor load block',
  ![...rootElement.querySelectorAll('.sa-main .sa-section-title')].some(node => (node.textContent ?? '').trim() === '执行器'),
  [...rootElement.querySelectorAll('.sa-main .sa-section-title')].map(node => (node.textContent ?? '').trim()).join(','))
{
  const deskWithWork = text()
  const runningSection = [...rootElement.querySelectorAll('.sa-main section')]
    .find(section => (section.querySelector('.sa-section-title')?.textContent ?? '').includes('正在执行'))
  check('overview lists the in-flight Ticket itself, not only a pulse rollup',
    Boolean(runningSection) && Boolean(runningSection.querySelector('.sa-row-open'))
      && (runningSection.textContent ?? '').includes('演示：正在执行的工单'),
    runningSection?.textContent?.slice(0, 260) ?? 'no section')
  check('overview surfaces in-progress work as one pulse sentence',
    deskWithWork.includes('系统脉搏') && deskWithWork.includes('在飞')
      && /(已运行 \d+ 分钟|不到 1 分钟)/.test(deskWithWork),
    deskWithWork.slice(0, 500))
  check('overview adds pulse, watchlist and a policy ledger instead of copying another page',
    deskWithWork.includes('值得留意') && deskWithWork.includes('策略规则'), deskWithWork.slice(0, 900))
  check('policy ledger leads with interceptions, not pass rates',
    deskWithWork.includes('拦截') && deskWithWork.includes('通过'), deskWithWork.slice(0, 900))
  const watchSection = [...rootElement.querySelectorAll('.sa-main section')]
    .find(section => (section.querySelector('.sa-section-title')?.textContent ?? '').includes('值得留意'))
  const watchRows = watchSection?.querySelectorAll('.sa-list .sa-row').length ?? 0
  check('overview lists the injected failure under the worth-a-look block',
    watchRows >= 1 && /过去 24 小时 \d+ 次执行失败/.test(watchSection?.textContent ?? ''),
    `rows=${watchRows} · ${watchSection?.textContent?.slice(0, 200) ?? 'no section'}`)
  check('overview names the needs-you vs worth-a-look split when both are on screen',
    watchRows >= 1 && deskWithWork.includes('需要你处理 = ') && deskWithWork.includes('无需你动作'),
    deskWithWork.slice(0, 700))
  check('overview funnel no longer treats 过滤 as a stage or says 丢弃',
    !deskWithWork.includes('丢弃') && (/仅作上下文/.test(deskWithWork) || !deskWithWork.includes('1\n过滤')),
    deskWithWork.slice(0, 500))
  check('overview brief is a two-column block', Boolean(rootElement.querySelector('.sa-brief-grid .sa-brief-col')),
    String(rootElement.querySelectorAll('.sa-brief-grid .sa-brief-col').length))
  const headerText = rootElement.querySelector('.sa-global-status')?.textContent ?? ''
  check('header shows the running count', /执行中\s*\d+/.test(headerText), headerText)
  // Mobile header geometry: the overflow trigger must ride the title row (full-width there), never the status row —
  // if it moved back into .sa-head-tools its 40px hit area would sit on the status line again (see 05-style.js 600px).
  const head = rootElement.querySelector('.sa-head')
  const titleRow = head?.querySelector('.sa-head-title')
  const toolsRow = head?.querySelector('.sa-head-tools')
  const mobileTrigger = head?.querySelector('.sa-mobile-tools .sa-menu-trigger')
  check('mobile overflow trigger rides the title row, not the status row',
    Boolean(mobileTrigger) && Boolean(titleRow?.contains(mobileTrigger)) && !toolsRow?.contains(mobileTrigger),
    `trigger=${Boolean(mobileTrigger)} inTitle=${Boolean(titleRow?.contains(mobileTrigger))}`)
  const mobileHeadCss = PANEL_CSS.slice(PANEL_CSS.indexOf('.sa-head-title { flex: 1 0 100%; }'))
  check('mobile header reserves the 44px trigger column beside the status line',
    /\.sa-head-tools\s*\{\s*padding-right:\s*calc\(40px \+ var\(--sa-sp-4\)\);\s*\}/.test(mobileHeadCss),
    mobileHeadCss.slice(0, 260))
}
}
// P0: the desk lists derived inbox items; an accept item's row action is 去工单. Pick the demo row explicitly so a
// real state with parked gates cannot change which ticket this walkthrough opens.
const inboxButtons = [...rootElement.querySelectorAll('button')].filter(node => (node.textContent ?? '').trim() === '去工单')
const acceptButtons = inboxButtons.filter(node => (node.closest('li')?.textContent ?? '').includes('演示：验收按钮流程'))
check('inbox desk offers 去工单 for a pending acceptance', acceptButtons.length >= 1, `buttons=${acceptButtons.length}`)
acceptButtons[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
// The evidence card fetches the Host comparison after the rounds load; give that round-trip one more tick.
await sleep(400)
check('去验收 opens the ticket detail', text().includes('阶段链路') && text().includes('权限依据'),
  text().slice(0, 200))
{
  const pageHead = rootElement.querySelector('.sa-page-head')
  const acceptCtas = [...(pageHead?.querySelectorAll('button') ?? [])]
    .filter(node => (node.textContent ?? '').trim() === '去验收')
  check('ticket header keeps one 去验收 action', acceptCtas.length === 1,
    JSON.stringify(acceptCtas.map(node => node.className)))
}
{
  const detailText = text()
  const sectionTitles = [...rootElement.querySelectorAll('.sa-main .sa-section-title')]
    .map(node => (node.textContent ?? '').trim().replace(/\s+/g, '').replace(/\d+$/, ''))
  const order = ['改动内容', '验收', '阶段链路', '闸门结果', '运行记录', '时间线']
  const positions = order.map(label => sectionTitles.indexOf(label))
  check('detail sections follow the requested order', positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
    JSON.stringify({ sectionTitles, positions }))
  // A settled run keeps its hand-off phase as history: the row says 交付时 and the CI spinner is gone (the Ticket has
  // already deployed and been accepted, no CI is pending).
  const firstRunRow = rootElement.querySelector('#sa-ticket-runs .sa-row')
  check('a delivered run names the phase it handed off at',
    /交付时：等待 CI/.test(firstRunRow?.textContent ?? ''), firstRunRow?.textContent?.slice(0, 160) ?? 'no run row')
  check('a settled run never keeps the CI spinner turning',
    Boolean(firstRunRow) && !firstRunRow.querySelector('.sa-spin'), firstRunRow?.innerHTML?.slice(0, 200) ?? 'no run row')
  check('changes section carries the changed files and worker summary', /改动文件/.test(detailText) && /执行总结/.test(detailText), detailText.slice(0, 300))
  // Wide layout: the worker summary is the left reading column, the files/request are the right evidence column.
  check('changes section reads summary left, files right', Boolean(rootElement.querySelector('.sa-changes-grid .sa-changes-main .sa-md'))
    && Boolean(rootElement.querySelector('.sa-changes-grid .sa-changes-side .sa-list')),
    String(rootElement.querySelectorAll('.sa-changes-grid > *').length))
  check('worker summary renders an ordered list', rootElement.querySelectorAll('.sa-md ol li').length >= 1,
    String(rootElement.querySelectorAll('.sa-md ol li').length))
  check('the worker summary comes from the newest run, not the first',
    /修复验收流程/.test(detailText) && !/旧一轮的总结/.test(detailText), detailText.slice(0, 300))
  check('the worker summary names the run it came from', /执行总结（来自运行/.test(detailText), detailText.slice(0, 200))
  check('pasted SQL body renders as a code block, not prose', rootElement.querySelectorAll('.sa-md-pre').length >= 1,
    String(rootElement.querySelectorAll('.sa-md-pre').length))
  check('detail nav keeps all seven jumps (automation included, activities folded into the timeline) in a dedicated cluster', rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length === 7,
  String(rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length))
check('long ticket detail offers in-page jump navigation', rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length === 7,
  String(rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length))
check('jump nav names the automation block', [...rootElement.querySelectorAll('.sa-detail-jump')].some(node => (node.textContent ?? '').trim() === '自动化'),
  [...rootElement.querySelectorAll('.sa-detail-jump')].map(node => node.textContent).join(','))
// The automation block is a folded setting, and saving only appears once the form differs from the stored config.
const automationSection = rootElement.querySelector('#sa-automation')
check('automation is a folded setting, not an always-open card', Boolean(automationSection?.querySelector('details > summary')),
  automationSection?.textContent?.slice(0, 80) ?? 'no section')
check('automation save is hidden while the form matches the stored config',
  ![...rootElement.querySelectorAll('#sa-automation button')].some(node => (node.textContent ?? '').trim() === '保存自动化'),
  automationSection?.textContent?.slice(0, 120) ?? 'no section')
// P1-7 activities no longer own a second timeline section; when the host sends them they fold inside the timeline.
const timelineSection = rootElement.querySelector('#sa-ticket-timeline')
check('activities no longer own a second timeline section', !sectionTitles.includes('活动'), JSON.stringify(sectionTitles))
check('any activity fold lives inside the timeline',
  [...rootElement.querySelectorAll('.sa-detail-jumps')].length === 1
  && [...rootElement.querySelectorAll('details > summary')].filter(node => /宿主活动记录|Host activity/.test(node.textContent ?? ''))
    .every(node => node.closest('#sa-ticket-timeline')),
  timelineSection?.textContent?.slice(0, 120) ?? 'no timeline')
check('empty gate results no longer own a section', !sectionTitles.includes('闸门结果') || Boolean(detailText.match(/失败策略|通过/)),
  JSON.stringify(sectionTitles))
// The gate section must render the gates the run actually recorded. A fixed standards/backend/frontend list printed
// three dashes for a repository that configures its own names while the rail above said "闸门 2/2".
check('gate results name the gates the run recorded, including repository-defined ones',
  /规范/.test(rootElement.querySelector('#sa-ticket-gates')?.textContent ?? '')
  && /demo-deploy/.test(rootElement.querySelector('#sa-ticket-gates')?.textContent ?? ''),
  rootElement.querySelector('#sa-ticket-gates')?.textContent?.slice(0, 220) ?? 'no gate section')
check('delivery evidence marks a truncated file list instead of counting deletions',
  /证据不完整/.test(detailText) && /不当作删除/.test(detailText), detailText.slice(-600))
check('delivery evidence refuses to confirm additions from an incomplete round',
  /无法确认新增/.test(detailText) && /Service\.java/.test(detailText), detailText.slice(-600))
check('delivery evidence warns that the baseline changed',
  /基线已变化/.test(detailText) && /base-old/.test(detailText), detailText.slice(-600))
check('delivery evidence names a gate that is still failing',
  /仍未通过/.test(detailText) && /demo-deploy/.test(detailText), detailText.slice(-600))
check('delivery evidence flags gate results reused from older code',
  /沿用了旧代码/.test(detailText) && /standards/.test(detailText), detailText.slice(-600))
check('delivery evidence compares acceptance requirements across rounds',
  /UC-DEMO-005/.test(detailText), detailText.slice(-600))
check('a truncated patch is visible on the evidence card',
  /patch 已截断/.test(detailText), detailText.slice(-600))
check('stage rail prints results, not truncated ids',
  !/[a-z]{3}_[a-z0-9]{2}…/.test(rootElement.querySelector('#sa-ticket-stages')?.textContent ?? ''),
  rootElement.querySelector('#sa-ticket-stages')?.textContent?.slice(0, 160) ?? 'no rail')
{
  const changes = rootElement.querySelector('#sa-ticket-changes')
  const changeText = changes?.textContent ?? ''
  const fold = changes?.querySelector('details')
  check('changes lists files before the folded request', Boolean(fold)
    && changeText.indexOf('改动文件') >= 0 && changeText.indexOf('改动文件') < changeText.indexOf('需求'),
    changeText.slice(0, 300))
}
check('sign-off note and the action cluster ride on the title row',
  Boolean(rootElement.querySelector('.sa-page-head-actions .sa-page-head-note'))
  && Boolean(rootElement.querySelector('.sa-page-head-actions [aria-haspopup="menu"]')),
  rootElement.querySelector('.sa-page-head-actions')?.textContent?.slice(0, 120) ?? 'no head actions')
const filesToggle = [...rootElement.querySelectorAll('.sa-changes-side button')].find(node => /显示更多/.test(node.textContent ?? ''))
const fileRows = () => rootElement.querySelectorAll('.sa-changes-side .sa-file-diff').length
check('a long changed-file list starts compact with a show-more control', Boolean(filesToggle) && fileRows() === 5, `rows=${fileRows()}`)
filesToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(300)
check('show more reveals every changed file',
  fileRows() === 8 && [...rootElement.querySelectorAll('.sa-changes-side button')].some(node => (node.textContent ?? '').trim() === '收起'),
  `rows=${fileRows()}`)
const collapseFiles = [...rootElement.querySelectorAll('.sa-changes-side button')].find(node => (node.textContent ?? '').trim() === '收起')
collapseFiles?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(300)
check('the changed-file list collapses again', fileRows() === 5, `rows=${fileRows()}`)
// P1 §3.2: every changed file row opens that file's own patch (one on-demand request per click).
const fileDiffButtons = () => [...rootElement.querySelectorAll('.sa-changes-side .sa-file-diff')]
check('every changed file row is a diff entry point', fileDiffButtons().length === 5, `rows=${fileDiffButtons().length}`)
fileDiffButtons()[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(400)
const diffModal = rootElement.querySelector('.sa-diff-modal')
check('clicking a file opens its own patch dialog', Boolean(diffModal?.querySelector('.sa-diff')), diffModal?.textContent?.slice(0, 160) ?? 'no dialog')
check('the dialog is scoped to the clicked file',
  (diffModal?.textContent ?? '').includes('demo/one/File.java') && !(diffModal?.textContent ?? '').includes('demo/two/FileTest.java'),
  diffModal?.textContent?.slice(0, 200) ?? 'no dialog')
check('the per-file request carries the clicked path',
  calls.some(call => call === 'GET /superagent/api/engine/ticket/tkt_demo_accept/diff?path=demo%2Fone%2FFile.java'),
  calls.filter(call => call.includes('/diff')).join(','))
check('the patch colours added lines and names the file header',
  rootElement.querySelectorAll('.sa-diff-modal .sa-diff-add').length >= 1
  && rootElement.querySelectorAll('.sa-diff-modal .sa-diff-file').length >= 1,
  `adds=${rootElement.querySelectorAll('.sa-diff-modal .sa-diff-add').length} files=${rootElement.querySelectorAll('.sa-diff-modal .sa-diff-file').length}`)
check('the patch dialog summarises files, counts and the run',
  /1 个文件/.test(diffModal?.textContent ?? '') && /\+1/.test(diffModal?.textContent ?? '') && /运行 run_demo/.test(diffModal?.textContent ?? ''),
  diffModal?.textContent?.slice(0, 200) ?? 'no dialog')
rootElement.querySelector('.sa-diff-modal .sa-modal-close')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(200)
check('the patch dialog closes again', !rootElement.querySelector('.sa-diff-modal'), 'dialog still open')
  // P2: append a requirement and rerun. The form is part of the changes section, the history stays readable, and a
  // submit posts the revision (the host starts the dry run from there).
  const revisionInput = rootElement.querySelector('#sa-ticket-changes .sa-revision-input')
  check('detail offers an add-requirement form', Boolean(revisionInput), revisionInput ? 'present' : 'missing')
  check('revision history renders the earlier requirement', /修订历史（1）/.test(rootElement.querySelector('#sa-ticket-changes')?.textContent ?? ''),
    rootElement.querySelector('#sa-ticket-changes')?.textContent?.slice(-200) ?? 'no changes section')
  if (revisionInput) {
    // jsdom cannot type; call the controlled handler directly (identified by React's props key) so the form sees the
    // same onChange a person would trigger.
    const propsKey = Object.keys(revisionInput).find(key => key.startsWith('__reactProps$'))
    if (propsKey) revisionInput[propsKey].onChange?.({ target: { value: 'BI 表改到 CUX schema' } })
    else {
      const nativeValue = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set
      nativeValue?.call(revisionInput, 'BI 表改到 CUX schema')
      revisionInput.dispatchEvent(new window.Event('input', { bubbles: true }))
    }
  }
  await sleep(200)
  const rerunButton = [...rootElement.querySelectorAll('#sa-ticket-changes button')]
    .find(node => (node.textContent ?? '').trim() === '追加并重跑')
  check('the rerun button enables once a requirement is typed', Boolean(rerunButton) && rerunButton.disabled !== true,
    String(rerunButton?.disabled))
  rerunButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  check('adding a requirement posts the revision',
    calls.some(call => call === 'POST /superagent/api/engine/ticket/tkt_demo_accept/revision'),
    calls.filter(call => call.includes('/revision')).join(','))
  check('the rerun is announced in the toast', /已追加要求，开始干跑重跑/.test(text()), text().slice(-200))
check('ticket id is copyable from the detail head', Boolean(rootElement.querySelector('.sa-page-head-meta .sa-copy-btn')),
    rootElement.querySelector('.sa-page-head-meta')?.textContent?.slice(0, 120) ?? '')
  check('repository name is not duplicated with its id', !/仓库名称[\s\S]{0,80}仓库 ID/.test(detailText), 'repo block')
  check('acceptance is shown once in the detail', (detailText.match(/已验收/g) ?? []).length <= 1,
    String((detailText.match(/已验收/g) ?? []).length))
  check('UAT card merges deploy job and status into one row', !detailText.includes('部署状态') && /部署\s*deploy_dev/.test(detailText), 'deploy rows')
  check('MR uses the MR # notation', /MR #\d+/.test(detailText) && !/!\d+/.test(detailText), 'MR label')
  check('rail gate result is a pass count', /通过|\d+\/\d+/.test(detailText) && /\d+\/\d+/.test(detailText), 'gate count')
  check('detail action bar is one primary plus an overflow menu',
    Boolean(rootElement.querySelector('.sa-main [aria-haspopup="menu"]')), 'menu trigger')
  const timeline = detailText.slice(detailText.indexOf('时间线'))
  check('timeline has no duplicated running/ok pairs', (timeline.match(/准备工作树/g) ?? []).length <= 1, String((timeline.match(/准备工作树/g) ?? []).length))
  const firstActor = rootElement.querySelector('.sa-timeline .sa-event-actor')
  check('timeline rows start with an absolute time', Boolean(firstActor && /\d{1,2}:\d{2}/.test(firstActor.textContent ?? '')), firstActor?.textContent?.slice(0, 80))
  check('timeline no longer prints 40-char SHAs', !/[0-9a-f]{40}/.test(timeline), 'sha')
  const timelineEvents = () => rootElement.querySelectorAll('.sa-timeline .sa-event').length
  const collapsedEvents = timelineEvents()
  const expandButton = [...rootElement.querySelectorAll('.sa-main button')].find(node => /展开全部/.test(node.textContent ?? ''))
  check('timeline collapses long histories by default', collapsedEvents <= 8 && Boolean(expandButton), `events=${collapsedEvents}`)
  expandButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  check('timeline expands to the full history', timelineEvents() > collapsedEvents, `after=${timelineEvents()}`)
  const collapseButton = [...rootElement.querySelectorAll('.sa-main button')].find(node => (node.textContent ?? '').trim() === '收起')
  collapseButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  check('timeline can collapse again', timelineEvents() === collapsedEvents, `back=${timelineEvents()}`)
  writeFileSync('/tmp/render-detail.txt', detailText)
}
check('detail shows the acceptance card', text().includes('验收'), text().slice(0, 200))
if (uatReady) check('detail offers the UAT link', text().includes('打开 UAT'), text().slice(0, 300))
else skip('detail offers the UAT link', 'no uatUrl configured for the primary repository')
const passButton = clickByText('验收通过')
check('acceptance button exists', Boolean(passButton))
await sleep(500)
const confirm = [...rootElement.querySelectorAll('.sa-modal button')].find(node => (node.textContent ?? '').trim() === '确定')
check('acceptance asks for confirmation', Boolean(confirm))
confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1600)
check('acceptance is recorded on the ticket', text().includes('已验收') && text().includes('确认验收通过') === false, text().slice(0, 240))
// O15: an accepted Ticket is done; its primary action must not invite another dry run.
const primaryLabels = [...rootElement.querySelectorAll('.sa-main .sa-btn-primary')].map(node => (node.textContent ?? '').trim())
check('accepted ticket has no dry-run primary action', !primaryLabels.includes('干跑执行'), JSON.stringify(primaryLabels))
const acceptCall = calls.find(call => call.includes('/accept'))
check('acceptance posts to engine/ticket/:id/accept', Boolean(acceptCall), String(acceptCall))

// Back to the desk: the accepted ticket must be gone from "needs you" and the count must drop.
const back = rootElement.querySelector('.sa-page-head button')
back?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const deskText = text()
// Other tickets (e.g. the two failed ones in real state) stay in "needs you", so count the accept actions rather than
// assuming an empty desk after one acceptance.
// The accepted Ticket must disappear from the derived desk. The demo row is the deterministic signal; other real
// items (parked gates, failures) may legitimately remain.
check('accepted ticket leaves the human queue', !deskText.includes('演示：验收按钮流程'), deskText.slice(0, 300))

// Non-acceptance actions must confirm visibly: the page-level poll emits a toast.
const pollButton = [...rootElement.querySelectorAll('button')]
  .find(node => (node.getAttribute('aria-label') ?? '') === '检查新消息')
pollButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(800)
check('header poll action reports a dry-run check', /检查完成/.test(text()) && /干跑/.test(text()), text().slice(-220))

// Multi-repository UI: the source page groups IM vs code; repository facts/tokens moved to their own Repositories tab,
// while Settings keeps only the link and the manual-ticket repository picker.
clickByText('来源')
await sleep(1000)
const sourceText = text()
if (sourcePageReady) {
  check('source page shows both repositories', repoLabels.every(label => sourceText.includes(label)), sourceText.slice(0, 260))
  check('source page groups IM and code repositories', sourceText.includes('IM 消息源') && sourceText.includes('GitLab 仓库'), sourceText.slice(0, 260))
  check('source cards use the two-up grid', rootElement.querySelectorAll('.sa-cards-2').length >= 2,
    String(rootElement.querySelectorAll('.sa-cards-2').length))
} else {
  for (const name of ['source page shows both repositories', 'source page groups IM and code repositories', 'source cards use the two-up grid']) {
    skip(name, 'octo is not configured on this machine, so the source page renders its empty state')
  }
}
clickByText('设置')
await sleep(900)
clickByText('运行', '.sa-settings-nav button')
await sleep(900)
const settingsText = text()
// O18: each group carries a real H2 that mirrors its left-nav label; the generic section-title class stays out of it.
const settingsTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('settings groups carry an H2 heading that mirrors the navigation label',
  settingsTitles.length === 1 && settingsTitles[0] === '运行', JSON.stringify(settingsTitles))
check('run group no longer carries the repository list', !settingsText.includes('本地路径') && !settingsText.includes('前往仓库页管理'), settingsText.slice(0, 260))
// The worker backend and its capability matrix were moved out of the run group into their own Worker group, so the
// run group no longer competes with them for the operator's attention.
check('run group no longer carries the worker backend or capability matrix',
  !settingsText.includes('Worker 后端') && !settingsText.includes('运行后端能力'), settingsText.slice(0, 400))
if (ebsConfigured) {
  const repoSelect = [...rootElement.querySelectorAll('select')]
    .find(select => [...select.options].some(option => option.value === 'ebs'))
  check('manual ticket form offers the ebs repository', Boolean(repoSelect), String(repoSelect?.value))
} else skip('manual ticket form offers the ebs repository', 'no ebs repository configured on this machine')
// The run timeout is editable (it used to be file-only, so a timed-out Ticket could not be retried with more time).
const timeoutInput = rootElement.querySelector('.sa-main input[aria-label="执行超时"]')
check('run timeout is editable from the run group',
  Boolean(timeoutInput) && timeoutInput.type === 'number' && Number(timeoutInput.max) === 1440,
  timeoutInput ? `${timeoutInput.type} ${timeoutInput.value}/${timeoutInput.min}-${timeoutInput.max}` : 'missing')
clickByText('Worker', '.sa-settings-nav button')
await sleep(800)
const workerText = text()
const workerTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('worker settings patch retains workflow fields', JSON.stringify(settingsPatchOf('worker', { 'executor.workflowMode': 'auto', 'executor.implementer': 'claude', 'executor.reviewer': 'claude', 'executor.workerPreset': 'cordis' })) === JSON.stringify({ 'executor.workflowMode': 'auto', 'executor.implementer': 'claude', 'executor.reviewer': 'claude', 'executor.workerPreset': 'cordis' }))
check('worker group exposes staged workflow and implementer controls', workerText.includes('自动评估难度') && workerText.includes('Codex 规划与独立验收') && Boolean(rootElement.querySelector('select[aria-label="实现后端"]')))
// A control without a visible label is not discoverable (regression: the reviewer/preset fields shipped unlabelled).
check('staged workflow controls carry visible labels',
  ['分阶段执行', '实现后端', '独立验收后端', 'Worker 预设（DSH）'].every(label => workerText.includes(label))
    && Boolean(rootElement.querySelector('select[aria-label="独立验收后端"]'))
    && Boolean(rootElement.querySelector('input[aria-label="Worker 预设（DSH）"]')),
  workerText.slice(0, 400))
check('staged backend options follow the enabled backends',
  [...rootElement.querySelectorAll('.sa-main select[aria-label="实现后端"] option')].map(option => option.value).join(',') === 'dsh,claude'
    && [...rootElement.querySelectorAll('.sa-main select[aria-label="独立验收后端"] option')].map(option => option.value).join(',') === 'codex,claude,dsh',
  JSON.stringify([...rootElement.querySelectorAll('.sa-main select[aria-label="独立验收后端"] option')].map(option => option.value)))
check('worker group is its own H2 group', workerTitles.length === 1 && workerTitles[0] === 'Worker', JSON.stringify(workerTitles))
check('worker group carries the routing mode control',
  Boolean(rootElement.querySelector('.sa-main select[aria-label="路由模式"]')),
  JSON.stringify([...rootElement.querySelectorAll('.sa-main select')].map(select => select.getAttribute('aria-label'))))
check('worker group lists every backend with its own enable switch',
  ['DSH（进程内）', 'Codex CLI（本机）', 'Claude Code CLI（本机）'].every(label => workerText.includes(label))
    && rootElement.querySelectorAll('.sa-main .sa-switch-row').length >= 3,
  String(rootElement.querySelectorAll('.sa-main .sa-switch-row').length))
check('worker group carries the work-type preference table',
  workerText.includes('任务类型偏好') && workerText.includes('需求分析') && workerText.includes('代码 review')
    && workerText.includes('功能测试验证'), workerText.slice(0, 800))
check('worker group carries the capability matrix', workerText.includes('运行后端能力')
  && workerText.includes('流式事件') && workerText.includes('工具调用审批'), workerText.slice(0, 600))
check('capability matrix highlights the saved backend',
  Boolean(rootElement.querySelector('.sa-capabilities tr[data-current="true"]')), workerText.slice(0, 300))
clickByText('写权限', '.sa-settings-nav button')
await sleep(800)
const writeText = text()
const writeTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('write group is its own H2 group', writeTitles.length === 1 && writeTitles[0] === '写权限', JSON.stringify(writeTitles))
check('write group holds the three executor write permissions',
  writeText.includes('允许推送分支') && writeText.includes('允许回群消息') && writeText.includes('允许合并 MR'), writeText.slice(0, 400))
check('the merge permission is marked as high risk', writeText.includes('高危'), writeText.slice(0, 400))
const navLabels = [...rootElement.querySelectorAll('.sa-settings-nav .sa-settings-group')]
  .map(node => (node.textContent ?? '').trim()).filter(Boolean)
check('settings rail separates writable groups from reference groups',
  navLabels.slice(0, 6).join('/') === '来源/评估确认/运行/Worker/写权限/仓库'
    && navLabels.slice(6).join('/') === '评估/提示词'
    && Boolean(rootElement.querySelector('.sa-settings-nav-sep')) && text().includes('参考'), JSON.stringify(navLabels))
clickByText('评估确认', '.sa-settings-nav button')
await sleep(800)
const reviewSettingsText = text()
check('review group configures the operator allow-list, scope and expiry',
  reviewSettingsText.includes('启用评估确认') && reviewSettingsText.includes('允许回复的操作人')
    && reviewSettingsText.includes('回复有效期') && reviewSettingsText.includes('确认范围'),
  reviewSettingsText.slice(0, 500))
clickByText('来源', '.sa-settings-nav button')
await sleep(900)
const sourceSettingsText = text()
const outlineHeaderIcons = [...rootElement.querySelectorAll('.sa-head .sa-icon-btn[data-variant="outline"]')]
check('header icon actions use the outline variant', outlineHeaderIcons.length >= 2, String(outlineHeaderIcons.length))
check('source settings offer group→repository bindings', sourceSettingsText.includes('自动接单群') && sourceSettingsText.includes('添加绑定'),
  sourceSettingsText.slice(0, 300))

// Repositories settings group: all repository facts, gates, token status and the write-only token editor live here,
// in the Settings left navigation rather than a top-level tab.
clickByText('仓库', '.sa-settings-nav button')
await sleep(900)
const reposText = text()
check('repositories group lists every repository', repoLabels.every(label => reposText.includes(label)), reposText.slice(0, 400))
check('repositories group uses the two-up card grid', rootElement.querySelectorAll('.sa-main .sa-cards-2').length >= 1,
  String(rootElement.querySelectorAll('.sa-main .sa-cards-2').length))
check('repositories group carries the default repository summary', new RegExp(`${liveRepos.length} 个仓库 · 默认仓库 ${defaultRepoId}`).test(reposText), reposText.slice(0, 200))
check('repositories group shows gates and clone path', reposText.includes('闸门') && reposText.includes('本地路径'), reposText.slice(0, 300))
check('repositories group absorbs the deployment facts', reposText.includes('部署与限制') && reposText.includes('live.json'), reposText.slice(0, 500))
if (twoReposConfigured) {
  const tokenInputs = [...rootElement.querySelectorAll('.sa-main input[type="password"]')]
  check('repositories group offers a GitLab token editor', tokenInputs.length >= 2, `inputs=${tokenInputs.length}`)
} else skip('repositories group offers a GitLab token editor', 'only one repository (or none) configured on this machine')
check('token editor has a save button', [...rootElement.querySelectorAll('.sa-main button')]
  .some(button => (button.textContent ?? '').trim() === '保存令牌'))
check('repository card offers the read-only configuration test',
  [...rootElement.querySelectorAll('.sa-main button')].some(button => (button.textContent ?? '').trim() === '测试配置'))
const editRepoButton = [...rootElement.querySelectorAll('.sa-main button')]
  .find(button => (button.textContent ?? '').trim() === '编辑')
editRepoButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(120)
check('repository edit previews the diff before saving',
  text().includes('保存前差异') && text().includes('尚未修改'), text().slice(-500))
// AC-10: gates are edited field by field (not one JSON blob) and a command/cwd/timeout/policy change must surface in
// the pre-save diff even when the gate count is unchanged.
const addGate = [...rootElement.querySelectorAll('.sa-modal button')]
  .find(button => (button.textContent ?? '').trim() === '添加闸门')
const gateNameInput = rootElement.querySelector('.sa-modal input[aria-label="闸门名称"]')
const gateCommandInput = rootElement.querySelector('.sa-modal input[aria-label="命令"]')
check('repository gate editor exposes per-gate fields and add/remove controls',
  Boolean(gateNameInput) && Boolean(gateCommandInput) && Boolean(addGate)
  && [...rootElement.querySelectorAll('.sa-modal button')].some(button => /删除这个闸门/.test(button.textContent ?? '')),
  rootElement.querySelector('.sa-modal')?.textContent?.slice(-300) ?? 'no modal')
if (gateNameInput && gateCommandInput) {
  const setGate = (node, value) => {
    node.value = value
    const key = Object.keys(node).find(name => name.startsWith('__reactProps'))
    node[key].onChange({ target: { value } })
  }
  setGate(gateNameInput, 'render-gate')
  setGate(gateCommandInput, 'echo changed')
  await sleep(80)
  check('a gate field change appears in the pre-save diff',
    /闸门「render-gate」/.test(text()) && /echo changed/.test(text()), text().slice(-400))
  // AC-10: the saved edit must survive a reload — the card previously kept showing the old name-only projection and
  // the reopened editor came back empty.
  const saveRepoButton = [...rootElement.querySelectorAll('.sa-modal button')]
    .find(button => (button.textContent ?? '').trim() === '保存')
  saveRepoButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  check('saving a repository edit keeps the edited gate on the card', text().includes('render-gate'), text().slice(-400))
  const reopenRepoButton = [...rootElement.querySelectorAll('.sa-main button')]
    .find(button => (button.textContent ?? '').trim() === '编辑')
  reopenRepoButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  const reopenedGates = [...rootElement.querySelectorAll('.sa-modal input[aria-label="闸门名称"]')].map(node => node.value)
  check('the reopened repository editor shows the saved gate fields',
    reopenedGates.includes('render-gate'), JSON.stringify(reopenedGates))
}
const cancelRepo = [...rootElement.querySelectorAll('.sa-modal button, .sa-dialog button')]
  .find(button => /取消|关闭/.test((button.textContent ?? '').trim()))
cancelRepo?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(80)

// Eval page (O9): the row leads with the judged message, and no English reason code leaks.
clickByText('概览')
await sleep(700)
clickByText('评估')
await sleep(1000)
const evalText = text()
if (evalReady) {
  check('eval rows lead with the judged message', /依据这个SQL|SELECT Gcc|修复：|报表/.test(evalText), evalText.slice(0, 500))
  check('eval rows no longer leak a raw reason key', !/contextOnly/.test(evalText), evalText.slice(0, 500))
  check('eval keeps the rule-by-rule fold', evalText.includes('逐条规则'), evalText.slice(0, 300))
  check('eval ticket short codes are links', rootElement.querySelectorAll('.sa-main .sa-row-meta a.sa-mono').length >= 1,
    String(rootElement.querySelectorAll('.sa-main .sa-row-meta a.sa-mono').length))
  check('eval rows identify their thread or ticket', rootElement.querySelectorAll('.sa-main .sa-row-meta .sa-mono').length >= 1,
    String(rootElement.querySelectorAll('.sa-main .sa-row-meta .sa-mono').length))
  check('eval rows show the shadow model opinion', evalText.includes('模型 93%') && evalText.includes('倾向接单'),
    evalText.slice(0, 500))
  check('eval rows link directly to the run they caused', evalText.includes('运行 run_demo'), evalText.slice(0, 500))
  // One filter idiom on every page: kind, time window and the divergence/override view are segmented chip groups.
  check('eval filters keep chip groups for kind, window and view',
    rootElement.querySelectorAll('.sa-main .sa-filters .sa-segment').length >= 4
    && rootElement.querySelectorAll('.sa-main .sa-filters .sa-segmented-chips').length === 3,
    JSON.stringify({ chips: rootElement.querySelectorAll('.sa-main .sa-filters .sa-segment').length,
      groups: rootElement.querySelectorAll('.sa-main .sa-filters .sa-segmented-chips').length }))
  // AC-06/07: text/repository/reason/date filters are real controls, and the page can leave the first result page.
  const evalFilterInputs = [...rootElement.querySelectorAll('.sa-main .sa-filters input')]
  check('eval offers reason and date-range filters', evalFilterInputs.length >= 3,
    JSON.stringify(evalFilterInputs.map(input => input.getAttribute('type') ?? 'text')))
  check('eval has server-side pagination controls', Boolean(rootElement.querySelector('.sa-main .sa-pagination'))
    && rootElement.querySelectorAll('.sa-main .sa-pagination button').length === 2,
    rootElement.querySelector('.sa-main .sa-pagination')?.textContent ?? 'no pagination')
  // A deep link restores the filter state instead of only the page: changing the view writes it into the URL.
  const divergenceChip = [...rootElement.querySelectorAll('.sa-main .sa-filters button')]
    .find(button => (button.textContent ?? '').trim() === '模型分歧')
  divergenceChip?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  check('eval filters are written into the URL', new window.URL(window.location.href).searchParams.get('evalView') === 'divergence',
    new window.URL(window.location.href).search)
  const allViewChip = [...rootElement.querySelectorAll('.sa-main .sa-filters button')]
    .find(button => (button.textContent ?? '').trim() === '全部')
  allViewChip?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(100)
} else {
  for (const name of ['eval rows lead with the judged message', 'eval rows no longer leak a raw reason key',
    'eval keeps the rule-by-rule fold', 'eval ticket short codes are links', 'eval rows identify their thread or ticket',
    'eval rows show the shadow model opinion', 'eval filters are one row of chips (kind + time window)']) {
    skip(name, 'no decisions in this state, so the Eval page has no rows to check')
  }
}
// Execution ledger (round 4): evidence rail, stage filters, done summary, in-place manual Ticket.
clickByText('执行')
await sleep(1200)
const execText = text()
check('execution list uses the ledger wrapper', Boolean(rootElement.querySelector('.sa-exec-queue')), execText.slice(0, 300))
const evidence = [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-evidence')].map(node => (node.textContent ?? '').trim()).filter(Boolean)
check('execution rows carry an evidence rail', evidence.length >= 1 && /MR #|原因：|待你|本轮|分钟|分/.test(evidence.join(' ')),
  JSON.stringify(evidence.slice(0, 4)))
check('execution rows put their actions at the row end', rootElement.querySelectorAll('.sa-exec-queue .sa-row-actions').length
  === rootElement.querySelectorAll('.sa-exec-queue .sa-row').length, String(rootElement.querySelectorAll('.sa-exec-queue .sa-row').length))
check('stage filter keeps the counts for every stage', ['排队', '执行中', '等你处理', '失败', '已结束', '已忽略'].every(label => execText.includes(label)),
  execText.slice(0, 500))
check('execution ledger has a column header', ['工单', '证据', '操作'].every(label => (rootElement.querySelector('.sa-queue-head')?.textContent ?? '').includes(label)),
  rootElement.querySelector('.sa-queue-head')?.textContent ?? '')
const queueHead = rootElement.querySelector('.sa-queue-head')
const queueSectionTitle = queueHead?.closest('.sa-section')?.querySelector('.sa-section-title')
check('execution column header sits under its group title',
  Boolean(queueHead) && queueHead.previousElementSibling === queueSectionTitle,
  queueHead?.parentElement?.className ?? 'no header')
const loadLegend = rootElement.querySelector('.sa-loadbar-meta')
check('executor load bar carries the stage legend', Boolean(loadLegend) &&
  ['执行中', '排队', '等你处理', '失败'].every(label => (loadLegend.textContent ?? '').includes(label)),
  loadLegend?.textContent ?? 'no legend')
check('executor band shows the last run', /最近一次执行/.test(execText), execText.slice(0, 400))
// The queue's control row: stage chips carry the counts, and grouping/ordering are labelled pickers (not a second
// filter row) with the current choice spelled out on the button.
const stageWords = /全部|等你处理|失败|执行中|排队|已结束|已忽略/
const stageButtons = [...rootElement.querySelectorAll('.sa-main .sa-list-bar .sa-segment')]
  .filter(button => stageWords.test(button.textContent ?? ''))
check('execution offers seven stage chips with counts (the dismissed slice included)',
  stageButtons.length === 7 && /全部/.test(stageButtons[0]?.textContent ?? ''),
  JSON.stringify(stageButtons.map(button => (button.textContent ?? '').trim())))
check('stage chips print each stage count inside the chip', /全部\s*\d+/.test(stageButtons[0]?.textContent ?? ''),
  String(stageButtons[0]?.textContent))
// The Overview's "failed then dismissed" watch item deep-links this slice; it must be a real filter, not a dead chip.
const dismissedChip = stageButtons.find(button => /已忽略/.test(button.textContent ?? ''))
dismissedChip?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(300)
check('the dismissed chip filters the ended history and stays selected',
  dismissedChip?.getAttribute('aria-checked') === 'true'
  && /失败后由人放弃的工单/.test(rootElement.querySelector('.sa-main')?.textContent ?? ''),
  `${dismissedChip?.getAttribute('aria-checked')} · ${rootElement.querySelector('.sa-main')?.textContent?.slice(0, 120)}`)
rootElement.querySelector('.sa-main .sa-list-bar .sa-segment')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(200)
const viewPickers = [...rootElement.querySelectorAll('.sa-main .sa-list-bar .sa-menu-picker')]
const viewText = viewPickers.map(node => (node.textContent ?? '').replace(/\s+/g, '')).join(' ')
check('view bar states grouping and ordering as labelled pickers',
  viewPickers.length === 2 && /分组按阶段/.test(viewText) && /排序最近更新/.test(viewText), viewText)
check('view bar keeps the include-ended switch', Boolean(rootElement.querySelector('.sa-main .sa-list-bar .sa-switch')), '')
check('view pickers open a menu with the other choice', viewPickers.every(node => node.getAttribute('aria-haspopup') === 'menu'),
  JSON.stringify(viewPickers.map(node => node.getAttribute('aria-haspopup'))))
const doneBadge = [...rootElement.querySelectorAll('.sa-exec-queue .sa-section-title .sa-hint')]
  .map(node => (node.textContent ?? '').trim()).find(label => /已验收/.test(label))
check('done group states its accepted/dismissed split', /已验收.*已忽略/.test(doneBadge ?? ''), String(doneBadge))
// A finished dry run publishes from the primary slot; the rerun it used to lead with stays in the ⋯ menu.
const readyRow = [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')]
  .find(row => (row.textContent ?? '').includes('演示：干跑完成待发布'))
check('the execution queue lists the finished dry run', Boolean(readyRow),
  [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')].map(row => (row.textContent ?? '').slice(0, 32)).join(' | '))
readyRow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const readyPrimary = [...rootElement.querySelectorAll('.sa-page-head-actions .sa-btn-primary')].map(node => (node.textContent ?? '').trim())
check('a finished dry run makes 发布 MR the primary action', readyPrimary.includes('发布 MR'), JSON.stringify(readyPrimary))
rootElement.querySelector('.sa-page-head-actions [aria-haspopup="menu"]')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(300)
const readyMenu = rootElement.querySelector('[role="menu"]')?.textContent ?? ''
check('the rerun stays available in the ··· menu', readyMenu.includes('干跑执行') && !readyMenu.includes('发布 MR'),
  readyMenu.slice(0, 200))
rootElement.ownerDocument.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(300)
clickByText('执行')
await sleep(1000)
clickByText('手工建单')
await sleep(800)
const manualModal = rootElement.querySelector('.sa-modal')
check('manual Ticket opens in place, without leaving Execution', Boolean(manualModal)
  && Boolean(manualModal.querySelector('input')) && /建单/.test(manualModal.textContent ?? ''), (manualModal?.textContent ?? '').slice(0, 160))
// AC-01: the form previews the automatic judgement and saves a manual override; the two dimensions are separate.
const routeSelects = [...(manualModal?.querySelectorAll('select') ?? [])]
const deliverableSelect = routeSelects.find(select => [...select.options].some(option => option.value === 'report'))
const backendSelect = routeSelects.find(select => [...select.options].some(option => option.value === 'codex'))
check('manual Ticket form separates deliverable and backend', Boolean(deliverableSelect) && Boolean(backendSelect),
  routeSelects.map(select => [...select.options].map(option => option.value).join(',')).join(' | '))
if (manualModal && deliverableSelect && backendSelect) {
  const titleInput = manualModal.querySelector('input')
  // The dialog is a React portal, so a DOM-dispatched input event does not reach the root's delegated listener.
  // Drive the controlled prop directly instead: this is what a real keystroke calls.
  const setControlled = (node, value) => {
    node.value = value
    const key = Object.keys(node).find(name => name.startsWith('__reactProps'))
    node[key].onChange({ target: { value } })
  }
  setControlled(titleInput, '修复网页登录失败并补测试')
  await sleep(1200)
  const previewText = manualModal.textContent ?? ''
  check('creating a Ticket previews deliverable, capabilities and backend',
    /自动判断/.test(previewText) && /代码改动/.test(previewText) && /改文件/.test(previewText) && /dsh/.test(previewText),
    previewText.slice(-260))
  setControlled(deliverableSelect, 'report')
  await sleep(900)
  const overridden = manualModal.textContent ?? ''
  check('a manual deliverable is previewed as a read-only report', /只读报告/.test(overridden) && /只读/.test(overridden),
    overridden.slice(-260))
  setControlled(backendSelect, 'codex')
  await sleep(900)
  check('the override selection reaches the preview request',
    calls.some(entry => /engine\/route/.test(entry)), calls.filter(entry => /engine\/route/.test(entry)).join(' | '))
  // AC-01: previewing is not saving — submit the form and assert the manual override actually travels with the create.
  const createButton = [...manualModal.querySelectorAll('button')].find(button => (button.textContent ?? '').trim() === '建单')
  createButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(900)
  check('submitting the manual form sends the chosen deliverable and backend',
    lastCreateRequest?.route?.deliverable === 'report' && lastCreateRequest?.route?.backend === 'codex',
    JSON.stringify(lastCreateRequest))
  check('a created Ticket closes the in-place manual form', !rootElement.querySelector('.sa-modal'), 'modal still open')
}
if (!rootElement.querySelector('.sa-modal')) { clickByText('手工建单'); await sleep(800) }
rootElement.ownerDocument.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(500)
check('manual Ticket modal closes with Escape', !rootElement.querySelector('.sa-modal'), 'modal still open')

// AC-03: while a run is active the stop entry sits in the header, states "正在停止" only after the request is recorded,
// and never pretends the worker has already finished.
console.log('STEP stop a running Ticket')
clickByText('执行')
await sleep(1000)
const runningRow = [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')]
  .find(row => (row.textContent ?? '').includes('演示：正在执行的工单'))
check('the execution queue lists the running Ticket', Boolean(runningRow),
  [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')].map(row => (row.textContent ?? '').slice(0, 32)).join(' | '))
runningRow?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const headerStop = [...rootElement.querySelectorAll('.sa-page-head-actions button')]
  .find(button => (button.textContent ?? '').trim() === '停止工单')
check('the running Ticket exposes stop in the header, not only the ··· menu', Boolean(headerStop),
  [...rootElement.querySelectorAll('.sa-page-head-actions button')].map(button => (button.textContent ?? '').trim()).join(' | '))
headerStop?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(400)
const stopDialog = rootElement.querySelector('.sa-modal')
check('stop asks for confirmation and says the completed work is kept',
  /请求停止这个工单/.test(stopDialog?.textContent ?? '') && /已完成的动作会保留/.test(stopDialog?.textContent ?? ''),
  (stopDialog?.textContent ?? '').slice(0, 200))
const stopConfirm = [...(stopDialog?.querySelectorAll('button') ?? [])].find(button => /^(确认|确定)$/.test((button.textContent ?? '').trim()))
stopConfirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const stoppedText = text()
check('the stop request is recorded for this Ticket', lastStopId === 'tkt_demo_running', String(lastStopId))
check('the panel shows 正在停止 while the worker is still finishing the current stage',
  stoppedText.includes('正在停止'), stoppedText.slice(0, 500))
check('the header stop entry leaves once the request is pending', ![...rootElement.querySelectorAll('.sa-page-head-actions button')]
  .some(button => (button.textContent ?? '').trim() === '停止工单'), 'stop still offered')

// Regression: a bare URL autolinks to itself, so the inline renderer must not re-parse that label forever.
{
  const probeRoot = window.document.createElement('div')
  window.document.body.appendChild(probeRoot)
  const probe = ReactDOM.createRoot(probeRoot)
  probe.render(React.createElement(MarkdownLite, { text: '见 https://example.com/a 说明' }))
  await sleep(80)
  const links = [...probeRoot.querySelectorAll('a')]
  check('a bare URL renders as one link without recursing',
    links.length === 1 && links[0].getAttribute('href') === 'https://example.com/a', `${links.length} links`)
}

clickByText('触发')
await sleep(1000)
const triggerText = text()
if (threadReady) {
  check('thread filter uses the same chips', rootElement.querySelectorAll('.sa-main .sa-pane-aside .sa-segment').length === 3,
    String(rootElement.querySelectorAll('.sa-main .sa-pane-aside .sa-segment').length))
  const threadSections = [...rootElement.querySelectorAll('.sa-main .sa-section-title')]
    .map(node => (node.textContent ?? '').trim().replace(/\d+$/, ''))
  check('thread detail no longer repeats a separate decision section',
    !threadSections.includes('决定') && threadSections.includes('评估过程') && threadSections.includes('消息时间线'),
    JSON.stringify(threadSections))
  check('thread detail keeps the ticket jump in the evaluation flow', /打开工单/.test(triggerText), triggerText.slice(0, 400))
  check('thread timeline renders messages through the Markdown renderer', rootElement.querySelectorAll('.sa-event-text .sa-md').length >= 1,
    String(rootElement.querySelectorAll('.sa-event-text .sa-md').length))
  check('thread key is copyable from the detail head', Boolean(rootElement.querySelector('.sa-page-head-meta .sa-copy-btn')),
    rootElement.querySelector('.sa-page-head-meta')?.textContent?.slice(0, 120) ?? '')
} else {
  for (const name of ['thread filter uses the same chips', 'thread detail no longer repeats a separate decision section',
    'thread detail keeps the ticket jump in the evaluation flow', 'thread timeline renders messages through the Markdown renderer',
    'thread key is copyable from the detail head']) {
    skip(name, 'no threads in this state, so the Triggers page has no detail to check')
  }
}
// Global search (C13): Ctrl+K opens the palette with a focused input; Escape closes it. Query typing is exercised in
// the real browser (jsdom's old focus/selection polyfill breaks synthetic input events in render-check).
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
await sleep(600)
const searchModal = rootElement.querySelector('.sa-modal')
const searchInput = searchModal?.querySelector('input')
// jsdom has no frame loop, so the field's focus-on-open is skipped there; the real browser check covers focus.
const searchInputFocused = rootElement.ownerDocument.activeElement === searchInput
check('Ctrl+K opens the search palette with an input', Boolean(searchModal) && Boolean(searchInput),
  JSON.stringify({ modal: Boolean(searchModal), input: Boolean(searchInput), focused: searchInputFocused }))
check('search palette starts with the keyword hint', /输入关键词/.test(searchModal?.textContent ?? ''),
  (searchModal?.textContent ?? '').slice(0, 200))
rootElement.ownerDocument.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(400)
check('Escape closes the search palette', !rootElement.querySelector('.sa-modal'), 'modal still open')

// Keyboard shortcut: Alt+3 jumps to Eval, Alt+1 returns to the desk.
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '4', altKey: true, bubbles: true }))
await sleep(700)
const shortcutTab = [...rootElement.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim()
check('Alt+4 switches to the Eval tab', shortcutTab === '评估', String(shortcutTab))
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }))
await sleep(700)
const shortcutBack = [...rootElement.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim()
check('Alt+1 returns to the Overview tab', shortcutBack === '概览', String(shortcutBack))

// Sticky chrome: header + six tabs are outside the body scroller, and a route change starts at the top.
check('header and six tabs live in the fixed topbar', rootElement.querySelectorAll('.sa-topbar [role="tab"]').length === 6
  && Boolean(rootElement.querySelector('.sa-topbar .sa-head')), String(rootElement.querySelectorAll('.sa-topbar [role="tab"]').length))
check('page body is the only scrolling container', Boolean(rootElement.querySelector('.sa-scroll > .sa-main')),
  'missing .sa-scroll > .sa-main')
const scroller = rootElement.querySelector('.sa-scroll')
scroller.scrollTop = 240
clickByText('来源')
await sleep(900)
check('route change resets the body scroll', scroller.scrollTop === 0, String(scroller.scrollTop))
const sourceFilterInputs = [...rootElement.querySelectorAll('.sa-main .sa-filters input')]
check('source offers repository, reason and date-range filters',
  sourceFilterInputs.length >= 4 && sourceFilterInputs.filter(input => input.getAttribute('type') === 'date').length === 2,
  JSON.stringify(sourceFilterInputs.map(input => input.getAttribute('aria-label') ?? input.getAttribute('type'))))
const selectedTab = rootElement.querySelector('[role="tab"][aria-selected="true"]')
selectedTab?.focus()
selectedTab?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
await sleep(500)
const focusedTab = rootElement.ownerDocument.activeElement
check('arrow keys move focus with the selected tab', focusedTab?.getAttribute('role') === 'tab'
  && focusedTab.getAttribute('aria-selected') === 'true', `${focusedTab?.textContent?.trim()} / ${focusedTab?.getAttribute('aria-selected')}`)
clickByText('概览')
await sleep(600)

// Push mode: the executor can only push a branch and GitHub's auto-pr workflow opens the PR, so links.mergeRequest
// has a webUrl but no iid. The MR card must still show the PR link and keep the merged state, never "还没有合并请求".
console.log('STEP push fixture')
const demoPushId = 'tkt_demo_push'
engine.state.tickets[demoPushId] = {
  id: demoPushId, title: '演示：push 模式 PR 链接', body: 'UC-DEMO-004：push 模式只记录 PR 创建链接。',
  status: 'merged', repoId: primaryRepoId, createdAt: nowIso, updatedAt: nowIso, assignments: [],
  origin: { threadKey: 'octo:demo', actor: 'demo' },
  links: { branch: 'feature/tkt_demo_push', commit: 'demo5678',
    verification: { merged: true, at: nowIso },
    mergeRequest: { webUrl: 'https://github.com/owner/repo/pull/new/feature/tkt_demo_push' } },
}
engine.state.state.ticketOrder.push(demoPushId)
window.sessionStorage.setItem('superagent-panel/route',
  JSON.stringify({ route: { page: 'execution', id: demoPushId }, stack: [] }))
console.log('STEP push remount')
rootDom.unmount()
const pushRoot = ReactDOM.createRoot(rootElement)
pushRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
console.log('STEP push rendered')
const pushText = rootElement.textContent ?? ''
check('a legacy push record with only a /pull/new/ URL waits for the PR instead of claiming one exists',
  pushText.includes('已推送，等待创建 PR') && !pushText.includes('PR 已创建') && !pushText.includes('还没有合并请求'),
  pushText.slice(0, 400))
check('push-mode MR card keeps the merged state after the PR entry link', pushText.includes('已合入目标分支'), pushText.slice(0, 400))

// AC-07 deep link: the Eval log links to page/source?id=<signalId>. The raw row may be filtered out or already
// cleaned up, so the page must resolve the signal and either locate it or say plainly that its text is gone.
console.log('STEP source deep link')
fixtures.status.sources = [{ id: 'octo', kind: 'source', title: 'Octo', enabled: true, state: 'ready',
  lastAt: nowIso, stats: { received: 1, accepted: 1, ignored: 0, skipped: 0 },
  config: { watchChatIds: ['chat-demo'], chatTitles: { 'chat-demo': '演示群' } } }]
signalFixture = { id: 'sig_demo', source: 'octo', status: 'processed', occurredAt: nowIso, receivedAt: nowIso,
  textPreview: '修复网页登录问题，需要联网查文档', ticketId: 'tkt_demo_accept', labels: [] }
pushRoot.unmount()
window.sessionStorage.setItem('superagent-panel/source-scroll', '180')
window.sessionStorage.setItem('superagent-panel/route',
  JSON.stringify({ route: { page: 'source', id: 'sig_demo' }, stack: [{ page: 'eval' }] }))
const sourceRoot = ReactDOM.createRoot(rootElement)
sourceRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
const locatedText = rootElement.textContent ?? ''
check('a signal deep link renders the located-signal card with its text',
  locatedText.includes('定位的原始信号') && locatedText.includes('修复网页登录问题'), locatedText.slice(0, 400))
check('the located signal links to its Ticket and Thread',
  locatedText.includes('查看工单') && locatedText.includes('查看线程'), locatedText.slice(0, 400))
check('the located signal is highlighted in the raw list',
  Boolean(rootElement.querySelector('#sa-signal-sig_demo.sa-row-focus')), locatedText.slice(0, 400))
check('returning to a deep-linked page scrolls to the located signal, not a stale list position',
  Boolean(rootElement.querySelector('#sa-located-signal')) && Boolean(rootElement.querySelector('#sa-signal-sig_demo')),
  locatedText.slice(0, 300))
check('a focused source deep link does not restore the stale list offset',
  rootElement.querySelector('.sa-scroll')?.scrollTop === 0, String(rootElement.querySelector('.sa-scroll')?.scrollTop))

// AC-07 return position: a source list refresh must restore the remembered offset, not jump to the top.
console.log('STEP source scroll restore')
sourceRoot.unmount()
window.sessionStorage.setItem('superagent-panel/source-scroll', '180')
window.sessionStorage.setItem('superagent-panel/route', JSON.stringify({ route: { page: 'source' }, stack: [] }))
const sourceListRoot = ReactDOM.createRoot(rootElement)
sourceListRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
check('a source refresh restores the remembered list offset',
  rootElement.querySelector('.sa-scroll')?.scrollTop === 180, String(rootElement.querySelector('.sa-scroll')?.scrollTop))
sourceListRoot.unmount()

// A signal that was cleaned up must be reported as unavailable, never rendered as an empty page.
console.log('STEP cleaned-up signal link')
signalFixture = undefined
sourceRoot.unmount()
window.sessionStorage.setItem('superagent-panel/route',
  JSON.stringify({ route: { page: 'source', id: 'sig_gone' }, stack: [{ page: 'eval' }] }))
const goneRoot = ReactDOM.createRoot(rootElement)
goneRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(800)
const goneText = rootElement.textContent ?? ''
check('a cleaned-up signal says its text is unavailable',
  goneText.includes('已不在信号日志中') && goneText.includes('原文不可用'), goneText.slice(0, 400))
goneRoot.unmount()

// AC-07 return position: the Trigger list lives in the same `.sa-scroll`; opening a Thread and coming back must land
// on the remembered row, not at the top.
console.log('STEP trigger scroll restore')
fixtures.threads = { items: [{ key: 'octo:chat-demo', title: '演示线程', source: 'octo', lastAt: nowIso,
  triggerCount: 1, ticketIds: [], state: 'recent' }], total: 1,
counts: { all: 1, subscribed: 0, recent: 1, new: 1 } }
window.sessionStorage.setItem('superagent-panel/trigger-scroll', '180')
window.sessionStorage.setItem('superagent-panel/route', JSON.stringify({ route: { page: 'trigger' }, stack: [] }))
const triggerRoot = ReactDOM.createRoot(rootElement)
triggerRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
const triggerScroller = rootElement.querySelector('.sa-scroll')
check('trigger list restores the remembered scroll position on return',
  triggerScroller?.scrollTop === 180, String(triggerScroller?.scrollTop))
triggerRoot.unmount()

// AC-06/07: a refresh (or a pasted link) restores the eval filters, the result page and the list position; back/forward
// updates the view in place. The mock ignores the params, so assert the request and the restored controls, not the rows.
console.log('STEP eval deep link restore')
window.history.replaceState(null, '', '/?evalView=divergence&evalQ=DDL&evalOffset=25')
window.sessionStorage.setItem('superagent-panel/eval-scroll', '180')
window.sessionStorage.setItem('superagent-panel/route', JSON.stringify({ route: { page: 'eval' }, stack: [] }))
const evalDeepRoot = ReactDOM.createRoot(rootElement)
evalDeepRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(1000)
const deepQuery = [...rootElement.querySelectorAll('.sa-main .sa-filters input')]
  .find(input => input.getAttribute('placeholder') === '消息、原因或工单标题…')
const deepViewChip = [...rootElement.querySelectorAll('.sa-main .sa-filters button')]
  .find(button => (button.textContent ?? '').trim() === '模型分歧')
check('an eval deep link restores the text filter and the divergence view',
  deepQuery?.value === 'DDL' && deepViewChip?.getAttribute('aria-checked') === 'true',
  JSON.stringify({ q: deepQuery?.value, view: deepViewChip?.getAttribute('aria-checked') }))
const deepRequest = calls.filter(entry => /engine\/decisions\?/.test(entry)).at(-1) ?? ''
check('the restored eval page asks the server for the saved offset and query',
  /q=DDL/.test(deepRequest) && /offset=25/.test(deepRequest) && /view=divergence/.test(deepRequest), deepRequest)
check('the eval list restores its scroll position after a refresh',
  rootElement.querySelector('.sa-scroll')?.scrollTop === 180, String(rootElement.querySelector('.sa-scroll')?.scrollTop))
window.history.replaceState(null, '', '/?evalView=override&evalOffset=0')
window.dispatchEvent(new window.PopStateEvent('popstate'))
await sleep(700)
const overrideChip = [...rootElement.querySelectorAll('.sa-main .sa-filters button')]
  .find(button => (button.textContent ?? '').trim() === '人工改判')
check('back/forward restores the eval view in place', overrideChip?.getAttribute('aria-checked') === 'true',
  overrideChip?.getAttribute('aria-checked') ?? 'missing')
evalDeepRoot.unmount()
window.history.replaceState(null, '', '/')
window.sessionStorage.removeItem('superagent-panel/eval-scroll')

check('no render/runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '))
const failed = checks.filter(item => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks, skipped, calls: [...new Set(calls)].slice(0, 20) }, null, 2))
// The gate only keeps the tail of a command's output (executor.js OUTPUT_TAIL = 4000 bytes), and the JSON above is
// ~40KB, so a failing assertion's `FAIL` line would be cut away. Repeat the failure summary AFTER the JSON so the
// evidence the repair worker receives names the failed checks instead of showing only the payload's tail.
if (failed.length) {
  console.log(`FAILED ${failed.length}/${checks.length}: ${failed.map(item => item.name).join(' | ')}`)
  for (const item of failed.slice(0, 3)) console.log(`DETAIL ${item.name}: ${String(item.detail).slice(-500)}`)
}
if (skipped.length) console.log(`SKIPPED ${skipped.length}: ${skipped.map(item => item.name).join(' | ')}`)
try { triggerRoot?.unmount?.(); sourceListRoot?.unmount?.(); sourceRoot?.unmount?.(); goneRoot?.unmount?.(); pushRoot?.unmount?.(); rootDom.unmount(); dom.window.close() } catch { /* best effort */ }
process.exit(failed.length === 0 ? 0 : 1)
