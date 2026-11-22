// Headless render check for the panel (no browser, no CDP).
//
// Loads the real client fragments with React + jsdom, feeds them fixtures built from the engine state
// (read-only: state.load() never reconciles or writes), and walks the acceptance flow:
// overview -> 去验收 -> ticket detail -> 验收通过 -> back to the desk.
//
//   npm ci            # once, installs jsdom/react/react-dom (devDependencies)
//   node scripts/render-check.mjs
//
// It needs no desktop app, no CDP and no operator state: when DSH_SUPERAGENT_STATE_DIR is unset or empty the
// script builds its own fixture state under a temp dir, so a clean clone can run the same 170+ checks.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { loadClient } from './client-exports.mjs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir, tmpdir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const requireRepo = createRequire(join(root, 'package.json'))
let JSDOM, React, ReactDOM, esbuild
try {
  ;({ JSDOM } = requireRepo('jsdom'))
  React = requireRepo('react')
  ReactDOM = requireRepo('react-dom/client')
  esbuild = requireRepo('esbuild')
} catch (error) {
  console.error('render-check needs jsdom + react + react-dom + esbuild: run `npm ci` in the repo root first.')
  console.error(String(error?.message ?? error))
  process.exit(2)
}

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

// ---- state: always the committed fixture unless an operator asks otherwise -------------------------------------
const { Engine } = await import('../lib/live/engine.js')
// The gate must read the same state on every machine: a clean clone, CI and an operator's laptop all build the same
// throw-away temp dir from the committed fixture, so the check set and the row counts cannot drift with whatever is in
// ~/.dsh/superagent. (Before 1.0.6 the operator's real live.json was picked up silently: a machine with 42 decisions
// and CI with 1 ran different checks and the local gate went green on a red CI.)
// DSH_SUPERAGENT_STATE_DIR still works, but only as an explicit debugging escape hatch — it prints a warning, because
// its results are no longer comparable with CI.
const requestedStateDir = process.env.DSH_SUPERAGENT_STATE_DIR
let stateDir
if (requestedStateDir && existsSync(join(requestedStateDir, 'live.json'))) {
  stateDir = requestedStateDir
  console.warn(`[render-check] 用外部状态目录 ${requestedStateDir}（结果可能与 CI 不同；CI 跑的是自带 fixture）`)
} else {
  if (requestedStateDir) console.warn(`[render-check] ${requestedStateDir} 里没有 live.json，改用自带 fixture`)
  stateDir = prepareFixtureState()
}
function prepareFixtureState () {
  const dir = mkdtempSync(join(tmpdir(), 'sa-render-'))
  const fixture = readFileSync(join(root, 'test', 'fixtures', 'live.json'), 'utf8').split('@STATE@').join(dir)
  writeFileSync(join(dir, 'live.json'), fixture)
  // Stand-in remote credentials. Without a token the Settings write-permission group disables 允许合并 MR, which skipped
  // the U-06 two-step confirmation checks on a clean clone — a coverage hole that had nothing to do with credentials.
  writeFileSync(join(dir, 'gitlab.token'), 'fixture-gitlab-token\n')
  writeFileSync(join(dir, 'octo.token'), 'fixture-octo-token\n')
  // A repository may carry its own worker-bots.json; the engine must ignore it (§4.1) and the detail page must say so.
  mkdirSync(join(dir, 'worktree-demo'), { recursive: true })
  writeFileSync(join(dir, 'worktree-demo', 'worker-bots.json'), JSON.stringify({ version: 2, bots: [] }))
  console.log(`STATE fixture ${dir}`)
  return dir
}
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
    links: { branch: 'feature/tkt_demo_accept', commit: 'demo1234', worktree: join(stateDir, 'worktree-demo'),
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
    bot: { id: 'generalist', source: 'default', reason: '默认 Bot generalist（executor.bot）',
      candidates: ['generalist'], capability: ['edit', 'exec'], capabilitySource: 'probe', verifiedAt: nowIso,
      configDigest: 'digest-demo', resolvedAt: nowIso },
    steps, worker: { text: '## 改动内容\n\n1、修复验收流程。\n2、补充演示列表。', backend: 'dsh',
      sessionId: 'worker-tkt_demo_accept-abc123' }, changedPaths: ['demo/one/File.java', 'demo/one/Service.java', 'demo/one/Validator.java', 'demo/two/FileTest.java', 'demo/two/ServiceTest.java', 'docs/spec-a.md', 'docs/spec-b.md', 'docs/push.md'],
    gates: [{ name: 'standards', exitCode: 0 }, { name: 'demo-deploy', exitCode: 0 }] })
  // An older round: the changes section must describe the newest run, not the first one. It ran through a CLI worker,
  // which leaves a thread id of its own — the run row must not offer to open that as a Harness Session.
  engine.state.runs.push({ id: 'run_demo_old', ticketId: demoId, status: 'dry-run', dryRun: true,
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), completedAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    bot: { id: 'surgical', source: 'rule', reason: '规则 #1 命中（workTypes=dev）', degraded: 'model',
      candidates: ['surgical'], capability: ['edit'], capabilitySource: 'fallback', configDigest: 'digest-demo',
      resolvedAt: nowIso },
    steps: [], worker: { text: '旧一轮的总结不应该出现在改动内容里', backend: 'codex', sessionId: 'thread-demo-old' },
    changedPaths: [] })
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
// N2-03 fixture: a failed Ticket shows up as a non-blocking inbox item, which the Overview merges into 系统问题 —
// a row that must carry the same cleanup entry as the desk.
const demoFailedId = 'tkt_demo_failed'
engine.state.tickets[demoFailedId] = {
  id: demoFailedId, title: '演示：失败的工单', body: 'UC-DEMO-006：失败后等待人工处理。',
  status: 'failed', repoId: primaryRepoId, createdAt: failedAt, updatedAt: failedAt,
  assignments: [{ at: failedAt, report: { state: 'failed', reason: fixtureFailure } }],
  origin: { threadKey: 'octo:demo', actor: 'demo' }, links: {},
}
engine.state.state.ticketOrder.push(demoFailedId)
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
// Intake history (one thread, its trigger message and the rule decision) is what makes the Eval and Triggers pages
// render rows at all. Real machines carry it; a clean clone does not, so seed one neutral record set. The text is
// deliberately synthetic — these checks must read the same on any machine.
{
  const threadKey = 'octo:fixture-group-a'
  const at = new Date(Date.now() - 5 * 60_000).toISOString()
  engine.state.threads[threadKey] = {
    key: threadKey, source: 'octo', title: '演示群 A', createdAt: at, lastAt: at }
  engine.state.triggers.trg_fixture = {
    id: 'trg_fixture', source: 'octo', at, threads: [threadKey], human: true,
    actor: { source: 'octo', id: 'demo', name: { zh: '演示', en: 'demo' } },
    text: '依据这个SQL，把报表导出的金额列补上合计行。',
    eventId: 1, messageId: 'fixture-1',
    channel: { source: 'octo', thread: 'fixture-group-a', channelType: 2,
      address: { channelId: 'fixture-group-a', channelType: 2 } },
    disposition: { decisionId: 'dec_fixture', fanout: ['tkt_demo_accept'], acked: [] },
  }
  engine.state.decisions.dec_fixture = {
    id: 'dec_fixture', threadKey, triggerIds: ['trg_fixture'], at,
    kind: 'accept', strength: 'explicit',
    reason: [{ code: 'explicitRequest', values: { text: '依据这个SQL，把报表导出的金额列补上合计行。' } }],
    rules: [
      { id: 'R1', name: '群内明确请求', matched: true, reason: '来自监听群的人类请求' },
      { id: 'R2', name: '来源与身份过滤', matched: true, reason: '监听群内的人类文本消息' },
      { id: 'R3', name: '高风险主题', matched: true, reason: '未命中高风险主题' },
    ],
    ticketId: 'tkt_demo_accept',
    runs: [{ runId: 'run_demo', ticketId: 'tkt_demo_accept' }],
    shadow: { status: 'ok', model: 'demo-judge', category: 'request', verdict: 'accept', probability: 0.93, riskP: 0.2 },
  }
}
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
// U-06 (N3): the confirmation must send the draft it re-reads, so the check asserts the patch body itself.
let lastSettingsBody = null
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
  if (method === 'POST' && p === 'engine/settings') {
    try { lastSettingsBody = init.body ? JSON.parse(String(init.body)) : null } catch { lastSettingsBody = null }
    return json({})
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
        bot: deliverable === 'report' ? 'read-only' : 'write', deliverable,
        capabilities: deliverable === 'report' ? ['exec'] : ['edit', 'exec'], backend,
        reason: { code: selection.backend || selection.deliverable ? 'manual' : 'default' },
        mode: selection.backend || selection.deliverable ? 'manual' : 'single',
        applied: Boolean(selection.backend || selection.deliverable), execBackend: backend,
        execBot: deliverable === 'report' ? 'read-only' : 'write' },
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

// ---- load the real client modules ------------------------------------------------------------------------------
const { App, translate, DICTS, PAGE_TEXT, MarkdownLite, diffPlaceholderKey, PANEL_CSS, settingsPatchOf,
  setupStateOf, globalHealth, evalEmptyState,
  // U-05…U-11 (one source of truth for the wording): the risk-change diff, the page query whitelist, the signal body
  // row component, the reason/failure vocabulary and the source/repo label projections.
  riskChangesOf, prunePageQuery, RawSignalRows, Panel, signalReasonText, failureLabel, runTriggerLabel, sourceRepoRows,
  workflowBlockedDetail, openLinkedPanel, openLinkedPanelWhenReady, initialPageQuery, rememberPageState,
  hostOfUrl, hostName, reasonLabel, publishableStatusOf, clampEvalOffset, Menu, ticketDismissable, HistoryChanges,
  AutomationBar, failureReasonTextOf, LiveSettingsPage, PanelState, BotsCard, ApiError,
  botPreview, botToForm, formToBot,
  createSessionOpener, openSessionMessage,
  inject: pluginInject } = loadClient({
  App: 'shell.js',
  translate: 'i18n.js',
  DICTS: 'i18n.js',
  PAGE_TEXT: 'localtext.js',
  MarkdownLite: 'widgets.js',
  diffPlaceholderKey: 'ticket-detail.js',
  PANEL_CSS: 'style.js',
  settingsPatchOf: 'settings.js',
  // Pure projections the checks below drive directly, without a second panel mount.
  setupStateOf: 'setup.js',
  globalHealth: 'shell.js',
  evalEmptyState: 'eval.js',
  riskChangesOf: 'settings.js',
  prunePageQuery: 'router.js',
  RawSignalRows: 'source.js',
  Panel: 'api.js',
  signalReasonText: 'source.js',
  failureLabel: 'live-ui.js',
  workflowBlockedDetail: 'live-ui.js',
  runTriggerLabel: 'live-ui.js',
  sourceRepoRows: 'source.js',
  initialPageQuery: 'router.js',
  rememberPageState: 'router.js',
  hostOfUrl: 'util.js',
  hostName: 'util.js',
  reasonLabel: 'i18n.js',
  publishableStatusOf: 'live-ui.js',
  ticketDismissable: 'ticket-detail.js',
  HistoryChanges: 'settings.js',
  AutomationBar: 'live-ui.js',
  failureReasonTextOf: 'overview.js',
  LiveSettingsPage: 'settings.js',
  BotsCard: 'settings.js',
  botPreview: 'settings.js',
  botToForm: 'settings.js',
  formToBot: 'settings.js',
  PanelState: 'api.js',
  ApiError: 'api.js',
  clampEvalOffset: 'eval.js',
  Menu: 'controls.js',
  openLinkedPanel: 'apply.js',
  openLinkedPanelWhenReady: 'apply.js',
  createSessionOpener: 'session-open.js',
  openSessionMessage: 'session-open.js',
  inject: 'apply.js',
}, { react: React })

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
const waitFor = async (predicate, { timeout = 20_000, step = 50, reason = 'condition' } = {}) => {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (predicate()) return true
    await sleep(step)
  }
  console.log(`WAIT ${reason} timed out after ${timeout}ms`)
  return false
}
const rootElement = window.document.getElementById('root')
// The host's `uiWorkspace.openSession` is the only way the panel can navigate to a Session, so the spy records every
// id the panel asks the host to open; the checks below assert both the id and which runs may offer the link at all.
const openedSessions = []
console.log('STEP mount')
const rootDom = ReactDOM.createRoot(rootElement)
rootDom.render(React.createElement(App, { openSession: async sessionId => { openedSessions.push(String(sessionId)) }, t }))
// The panel paints an empty shell first and fills it from the host API, so wait for the data instead of for a fixed
// delay. A flat 900 ms was enough on a laptop but not always on a CI runner, where the late first render cascaded into
// 53 unrelated failures (the inbox, the desk actions and everything reached through them). Polling keeps the gate about
// behaviour rather than about machine speed; the timeout still fails loudly if the panel genuinely never loads.
await waitFor(
  () => Boolean(rootElement.querySelector('.sa-page')) && !rootElement.querySelector('.sa-skeleton, [aria-busy="true"]'),
  { reason: 'panel first data load' })
await sleep(150)
console.log('STEP rendered')

const text = () => rootElement.textContent
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) console.log(`FAIL ${name} ${detail}`) }
// A few assertions genuinely depend on this machine's configuration or history (repositories, octo bindings, decisions,
// threads). On a fresh DSH_HOME they cannot hold; SKIP them and keep the gate green instead of failing for a reason the
// change under review did not cause. Skips are printed and counted in the summary, never as failures.
const skipped = []
const skip = (name, reason) => { skipped.push({ name, reason }); console.log(`SKIP ${name} — ${reason}`) }
// The gate must be hermetic: it reads the committed fixture in a temp dir, never the operator's ~/.dsh/superagent.
// Silently picking up the operator's live.json is what let a red CI pass a green local gate at 1.0.4 — same command,
// different state, different row counts, different check outcome. DSH_SUPERAGENT_STATE_DIR is an explicit opt-out.
const operatorStateDir = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'superagent')
check('the gate runs on its own fixture state unless an operator opts in (hermetic)',
  Boolean(requestedStateDir) || stateDir !== operatorStateDir,
  `stateDir=${stateDir} operatorStateDir=${operatorStateDir}`)
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
  // N2-03: a failure-class inbox item is non-blocking, so it renders in 系统问题; that row needs the cleanup entry too.
  const problemRow = [...rootElement.querySelectorAll('.sa-row')]
    .find(node => /演示：失败的工单/.test(node.textContent ?? ''))
  check('a failed Ticket in 系统问题 offers 忽略并清理 (N2-03)',
    Boolean(problemRow) && /忽略并清理/.test(problemRow.textContent ?? ''),
    problemRow ? problemRow.textContent.slice(0, 160) : 'no failed row')
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
  // if it moved back into .sa-head-tools its 40px hit area would sit on the status line again (see style.js 600px).
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
  // The run ID is the way into the executor's own conversation: a DSH run names a Session this UI can open, while a
  // CLI run only leaves a thread id of its own, so that row keeps the copy button instead of a dead link.
  const sessionLink = rootElement.querySelector('#sa-run-run_demo .sa-runid-open')
  const cliRunRow = rootElement.querySelector('#sa-run-run_demo_old')
  check('a DSH run shows its run ID as a Session link', Boolean(sessionLink), sessionLink?.textContent ?? 'no link')
  check('a CLI run never offers a Harness Session link', Boolean(cliRunRow) && !cliRunRow.querySelector('.sa-runid-open')
    && Boolean(cliRunRow.querySelector('.sa-copy-btn')), cliRunRow?.textContent?.slice(0, 120) ?? 'no run row')
  // §7.5/§13.1: the row says which bot ran, who chose it, and what evidence backs its capabilities.
  const botRow = rootElement.querySelector('#sa-run-run_demo .sa-run-bot')
  check('a run names the bot that ran it and why (§7.5)',
    Boolean(botRow) && /generalist/.test(botRow.textContent ?? '') && /默认 Bot/.test(botRow.textContent ?? ''),
    botRow?.textContent?.slice(0, 160) ?? 'no bot row')
  check('the capability line names its source and when it was verified (§13.1)',
    /能力：edit, exec（探针/.test(botRow?.textContent ?? ''), botRow?.textContent?.slice(0, 200) ?? 'no bot row')
  check('a synthesised or degraded dispatch is marked and never folded away (§13.1)',
    /降级/.test(cliRunRow?.textContent ?? '') && /指定的 Bot 不可用|本次分派预算|决策模型/.test(cliRunRow?.textContent ?? '')
      || /降级/.test(cliRunRow?.textContent ?? ''),
    cliRunRow?.textContent?.slice(0, 200) ?? 'no run row')
  check('an unverified capability source is flagged on the row (§13.1)',
    /未核验/.test(cliRunRow?.textContent ?? ''), cliRunRow?.textContent?.slice(0, 200) ?? 'no run row')
  check('a repository bot file is reported as ignored, with both paths (§4.1/AC12)',
    /仓库里的 Bot 文件已忽略/.test(detailText) && /worktree-demo\/worker-bots\.json/.test(detailText), detailText.slice(0, 600))
  const rerunPick = rootElement.querySelector('#sa-run-run_demo select[aria-label]')
  check('the detail page offers a rerun under another bot (§7.6)',
    Boolean(rerunPick) && [...rerunPick.options].some(option => option.value === 'surgical'),
    [...(rerunPick?.options ?? [])].map(option => option.value).join(','))
  sessionLink?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(150)
  check('clicking the run ID asks the host to open the executor Session',
    openedSessions.at(-1) === 'worker-tkt_demo_accept-abc123', JSON.stringify(openedSessions))
  // The jump has to survive the two states a plain `uiWorkspace.openSession` call does not: a page load whose Session
  // list is still pending (retain throws `unknown session`) and a finished run whose Session was archived (the
  // Workspace controller clears that selection again). Both were seen live against the desktop app.
  {
    const events = []
    const listeners = new Set()
    const list = {
      snapshot: { phase: 'pending', byId: {} },
      getSnapshot() { return this.snapshot },
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      ready(id) {
        this.snapshot = { phase: 'ready', byId: { [id]: { id } } }
        for (const fn of listeners) fn()
      },
    }
    const services = {
      uiWorkspace: {
        openSession(id) { events.push(`open:${id}`) },
        async unarchiveSession(id) { events.push(`unarchive:${id}`) },
      },
      sessions: { list },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: ['worker-demo'] }) } },
    }
    const opening = createSessionOpener({ get: name => services[name] }, { waitMs: 2000 })('worker-demo')
    check('the Session opener waits for a list that is still loading', events.length === 0, JSON.stringify(events))
    list.ready('worker-demo')
    await opening
    check('the Session opener unarchives first, then opens the executor Session',
      JSON.stringify(events) === JSON.stringify(['unarchive:worker-demo', 'open:worker-demo']), JSON.stringify(events))
  }
  {
    // A run that is still going creates its Session seconds before the reader clicks it, and the Host's retain decides
    // from the same list it pushes: the first attempt refuses the Session as unknown, the push that names it arrives a
    // moment later, and the second attempt lands. Refusing outright here is the false negative a WORKING run produced.
    const events = []
    const listeners = new Set()
    let snapshot = { phase: 'ready', byId: {} }
    const list = {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
      push() { snapshot = { phase: 'ready', byId: { 'worker-new': { id: 'worker-new' } } }; for (const fn of listeners) fn() },
    }
    const services = {
      uiWorkspace: {
        openSession(id) {
          if (snapshot.byId[id] === undefined) throw new Error(`unknown session ${id}`)
          events.push(`open:${id}`)
        },
      },
      sessions: { list },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    setTimeout(() => list.push(), 30)
    await createSessionOpener({ get: name => services[name] }, { waitMs: 20, retryMs: 2000 })('worker-new')
    check('a Session a live run just created is opened once the list push names it',
      JSON.stringify(events) === JSON.stringify(['open:worker-new']), JSON.stringify(events))
  }
  {
    // A run that is STILL going can leave its Session on disk with no push at all, so the page's list stays stale for
    // its whole life and the Host's retain keeps refusing a Session that exists. The catalog's implementation `refresh()`
    // is the lever: one fresh pull, then the jump lands without waiting for a push that never comes.
    const events = []
    const listeners = new Set()
    let snapshot = { phase: 'ready', byId: {} }
    const list = {
      getSnapshot: () => snapshot,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    }
    const services = {
      uiWorkspace: {
        openSession(id) {
          if (snapshot.byId[id] === undefined) throw new Error(`unknown session ${id}`)
          events.push(`open:${id}`)
        },
      },
      sessions: {
        list,
        async refresh() {
          events.push('refresh')
          snapshot = { phase: 'ready', byId: { 'worker-stale': { id: 'worker-stale' } } }
          for (const fn of listeners) fn()
        },
      },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    await createSessionOpener({ get: name => services[name] }, { waitMs: 20, retryMs: 20 })('worker-stale')
    check('a stale list is pulled again before the Session jump gives up',
      JSON.stringify(events) === JSON.stringify(['refresh', 'open:worker-stale']), JSON.stringify(events))
  }
  {
    // A pull that still does not name the Session is a refusal like any other: one refresh, no second open, and the
    // host's words survive into the message.
    const events = []
    const services = {
      uiWorkspace: {
        openSession(id) { events.push(`open:${id}`); throw new Error(`unknown session ${id}`) },
      },
      sessions: {
        list: { getSnapshot: () => ({ phase: 'ready', byId: {} }), subscribe: () => () => {} },
        async refresh() { events.push('refresh') },
      },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    const failure = await createSessionOpener({ get: name => services[name] }, { waitMs: 20, retryMs: 20 })('worker-void')
      .then(() => undefined, error => error)
    check('a pull that still misses the Session reports unavailable, quoting the host',
      failure?.message === 'session-open-unavailable'
        && events.filter(event => event === 'refresh').length === 1
        && events.filter(event => event === 'open:worker-void').length === 1
        && String(openSessionMessage(failure, t)).includes('unknown session worker-void'),
      JSON.stringify({ events, message: String(failure?.message) }))
  }
  {
    const services = {
      uiWorkspace: { openSession() { throw new Error('unknown session worker-gone') } },
      sessions: {
        list: { getSnapshot: () => ({ phase: 'ready', byId: {} }), subscribe: () => () => {} },
      },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    const failure = await createSessionOpener({ get: name => services[name] }, { waitMs: 20, retryMs: 20 })('worker-gone')
      .then(() => undefined, error => error)
    check('a Session the list never names reports the unavailable code',
      failure?.message === 'session-open-unavailable', String(failure?.message))
    check('the unavailable message quotes the host reason, so a stale list is not read as a deleted Session',
      String(openSessionMessage(failure, t)).includes('unknown session worker-gone'), String(openSessionMessage(failure, t)))
  }
  {
    const services = {
      uiWorkspace: { openSession() { throw new Error('unknown session worker-gone') } },
      sessions: { list: { getSnapshot: () => ({ phase: 'pending', byId: {} }), subscribe: () => () => {} } },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    const failure = await createSessionOpener({ get: name => services[name] }, { waitMs: 20 })('worker-gone')
      .then(() => undefined, error => error)
    check('a Session the host refuses reports the unavailable code instead of navigating',
      failure?.message === 'session-open-unavailable', String(failure?.message))
    check('the unavailable failure reads as a sentence, not as a code',
      String(openSessionMessage(failure, t)).includes('会话列表'), String(openSessionMessage(failure, t)))
    const missing = await createSessionOpener({ get: () => undefined }, { waitMs: 20 })('worker-gone')
      .then(() => undefined, error => error)
    check('a host without uiWorkspace reports the unsupported code',
      missing?.message === 'session-open-unsupported', String(missing?.message))
  }
  {
    // A Session the client's list does not name yet is the host's call, not this panel's: the list can lag behind a
    // Session the executor just created, and refusing there is a false negative the reader cannot act on.
    const calls = []
    const services = {
      uiWorkspace: { openSession: id => calls.push(id) },
      sessions: { list: { getSnapshot: () => ({ phase: 'ready', byId: {} }) } },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    await createSessionOpener({ get: name => services[name] }, { waitMs: 20 })('worker-unlisted')
    check('a Session missing from the client list still reaches the host',
      calls.join(',') === 'worker-unlisted', JSON.stringify(calls))
  }
  {
    const calls = []
    const services = {
      uiWorkspace: { openSession: id => calls.push(id) },
      sessions: { list: { getSnapshot: () => ({ phase: 'pending', byId: {} }) } },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    await createSessionOpener({ get: name => services[name] }, { waitMs: 20 })('worker-late')
    check('a Session list that never becomes ready still hands the jump to the host',
      calls.join(',') === 'worker-late', JSON.stringify(calls))
  }
  {
    const calls = []
    const services = {
      uiWorkspace: { openSession: id => calls.push(id) },
      sessions: { list: { getSnapshot: () => ({ phase: 'ready' }) } },
      workspaces: { list: { getSnapshot: () => ({ archivedSessionIds: [] }) } },
    }
    await createSessionOpener({ get: name => services[name] }, { waitMs: 20 })('worker-plain')
    check('a Session list this host cannot describe never blocks the jump',
      calls.join(',') === 'worker-plain', JSON.stringify(calls))
  }
  check('detail nav keeps all eight jumps (request, automation and the timeline included) in a dedicated cluster', rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length === 8,
  String(rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length))
check('long ticket detail offers in-page jump navigation', rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length === 8,
  String(rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length))
check('jump nav names the request block (R2-09)', [...rootElement.querySelectorAll('.sa-detail-jump')].some(node => (node.textContent ?? '').trim() === '需求'),
  [...rootElement.querySelectorAll('.sa-detail-jump')].map(node => node.textContent).join(','))
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
{
  // U-01: `scrollIntoView` scrolls every scrollable ancestor, including the host frame the panel is mounted in, so a
  // section jump used to drag the whole DSH shell. Stand in a host frame that follows the browser API and fail if the
  // panel reaches for it at all: the jump must move only the panel's own `.sa-scroll`.
  const hostFrame = { scrollTop: 0 }
  let scrollCalls = 0
  const originalScrollIntoView = window.Element.prototype.scrollIntoView
  window.Element.prototype.scrollIntoView = function () { scrollCalls += 1; hostFrame.scrollTop += 184.5 }
  const jumpButtons = [...rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump')]
  const acceptanceJump = jumpButtons.find(node => (node.textContent ?? '').trim() === '验收')
  acceptanceJump?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  check('a section jump scrolls the panel scroller, never a host ancestor (U-01)',
    Boolean(acceptanceJump) && scrollCalls === 0 && hostFrame.scrollTop === 0,
    `jump=${Boolean(acceptanceJump)} calls=${scrollCalls} hostScrollTop=${hostFrame.scrollTop}`)
  window.Element.prototype.scrollIntoView = originalScrollIntoView
}
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
  // R2-09: the request is promoted to its own expanded section above the changes, instead of a disclosure folded
  // into the right-hand column of "what changed".
  const request = rootElement.querySelector('#sa-ticket-request')
  const changes = rootElement.querySelector('#sa-ticket-changes')
  const requestFirst = Boolean(request && changes
    && (request.compareDocumentPosition(changes) & window.Node.DOCUMENT_POSITION_FOLLOWING))
  check('the request is its own expanded section above the changes (R2-09)',
    Boolean(request) && Boolean(request.querySelector('.sa-md')) && !request.querySelector('details') && requestFirst,
    request?.textContent?.slice(0, 120) ?? 'no request section')
  const foldedRequest = changes
    ? [...changes.querySelectorAll('details summary')].some(node => (node.textContent ?? '').trim() === '需求')
    : false
  check('changes no longer folds the request away (R2-09)',
    Boolean(changes) && !foldedRequest && (changes.textContent ?? '').indexOf('改动文件') >= 0,
    changes?.textContent?.slice(0, 200) ?? 'no changes section')
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
const confirm = [...rootElement.querySelectorAll('.sa-modal button')]
  .find(node => /验收通过/.test((node.textContent ?? '').trim()))
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
  check('source page groups IM and code repositories', sourceText.includes('IM 消息源') && sourceText.includes('代码仓库'), sourceText.slice(0, 260))
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
  navLabels.slice(0, 7).join('/') === '来源/评估确认/运行/Worker/Bot/写权限/仓库'
    && navLabels.slice(7).join('/') === '评估/提示词'
    && Boolean(rootElement.querySelector('.sa-settings-nav-sep')) && text().includes('参考'), JSON.stringify(navLabels))

// U-06: turning on a permission is not a one-step save. The save bar expands a plain-language change list first and
// the write happens only from that confirmation — a merge cannot be undone by turning the switch back off.
const settingsWrites = () => calls.filter(call => call === 'POST /superagent/api/engine/settings').length
const pushSwitch = rootElement.querySelector('.sa-main .sa-switch-row input[aria-label="允许推送分支"]')
const writesBefore = settingsWrites()
if (pushSwitch && !pushSwitch.disabled) {
  pushSwitch.click()
  await sleep(150)
  clickByText('保存', '.sa-savebar button')
  await sleep(200)
  const riskNode = rootElement.querySelector('.sa-risk')
  const riskText = riskNode ? riskNode.textContent : ''
  check('a high-risk save asks for a confirmation and writes nothing yet (U-06)',
    Boolean(riskNode) && riskText.includes('这次保存会改变高风险设置') && riskText.includes('确认后才会写入') && (riskText.includes('允许推送分支：执行器可以推分支到远端并建 MR')
        || riskText.includes('不再允许推送分支：执行器只到闸门为止'))
      && settingsWrites() === writesBefore, riskText.slice(0, 300))
  // N3: the confirmation must read the draft again at the moment of the click. Flip a second high-risk switch while
  // the list is open: the click must not write anything, and the list has to refresh to the new change set before a
  // second confirmation is accepted.
  const mergeSwitch = rootElement.querySelector('.sa-main .sa-switch-row input[aria-label="允许合并 MR"]')
  if (mergeSwitch && !mergeSwitch.disabled) {
    mergeSwitch.click()
    await sleep(150)
    clickByText('确认保存', '.sa-risk button')
    await sleep(250)
    const refreshedText = rootElement.querySelector('.sa-risk')?.textContent ?? ''
    check('confirming a stale change list re-reads the draft and asks again (U-06)',
      Boolean(rootElement.querySelector('.sa-risk')) && settingsWrites() === writesBefore
        && refreshedText.includes('推送分支') && refreshedText.includes('合并 MR'),
      JSON.stringify({ writes: settingsWrites() - writesBefore, text: refreshedText.slice(0, 240) }))
  } else {
    skip('confirming a stale change list re-reads the draft and asks again (U-06)',
      'no second writable high-risk switch on this machine')
  }
  clickByText('取消', '.sa-risk button')
  await sleep(150)
  check('cancelling the confirmation keeps the draft and writes nothing (U-06)',
    !rootElement.querySelector('.sa-risk') && settingsWrites() === writesBefore
      && Boolean(rootElement.querySelector('.sa-savebar')), String(settingsWrites() - writesBefore))
  // N3 (the other half): a field changed after the list was drawn is part of the write. The old one-step patch would
  // have dropped it.
  clickByText('保存', '.sa-savebar button')
  await sleep(250)
  const writesBeforeConfirm = settingsWrites()
  const replySwitch = rootElement.querySelector('.sa-main .sa-switch-row input[aria-label="允许回群消息"]')
  const replyWasOn = Boolean(replySwitch?.checked)
  if (replySwitch) {
    replySwitch.click()
    await sleep(150)
    clickByText('确认保存', '.sa-risk button')
    await sleep(300)
  }
  const confirmedBody = lastSettingsBody ?? {}
  check('the confirmation writes the draft it re-reads, including edits made after the list opened (U-06)',
    Boolean(replySwitch) && settingsWrites() === writesBeforeConfirm + 1
      && confirmedBody['executor.allowReply'] === !replyWasOn, JSON.stringify(confirmedBody).slice(0, 300))
  clickByText('放弃', '.sa-savebar button')
  await sleep(400)
} else {
  skip('a high-risk save asks for a confirmation and writes nothing yet (U-06)', 'no writable push switch on this machine')
  skip('confirming a stale change list re-reads the draft and asks again (U-06)', 'no writable push switch on this machine')
  skip('cancelling the confirmation keeps the draft and writes nothing (U-06)', 'no writable push switch on this machine')
  skip('the confirmation writes the draft it re-reads, including edits made after the list opened (U-06)', 'no writable push switch on this machine')
}

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
  check('eval ticket short codes open their ticket', rootElement.querySelectorAll('.sa-main .sa-row-meta button.sa-mono.sa-textlink').length >= 1,
    String(rootElement.querySelectorAll('.sa-main .sa-row-meta button.sa-mono.sa-textlink').length))
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
    'eval keeps the rule-by-rule fold', 'eval ticket short codes open their ticket', 'eval rows identify their thread or ticket',
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
readyRow?.querySelector('.sa-row-open')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
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
{
  // U-04: a `select` with only an `aria-label` looks like an unlabelled box on screen. Both controls need a visible
  // label, and the accessible name has to stay the same (screen readers and the checks above rely on it).
  const fieldLabels = [...(manualModal?.querySelectorAll('.sa-route-field .sa-field-head') ?? [])]
    .map(node => (node.textContent ?? '').trim())
  check('manual Ticket form labels both selects visibly (U-04)',
    fieldLabels.includes('交付目标') && fieldLabels.includes('执行后端')
    && deliverableSelect?.getAttribute('aria-label') === '交付目标'
    && backendSelect?.getAttribute('aria-label') === '执行后端',
    JSON.stringify({ fields: fieldLabels, deliverable: deliverableSelect?.getAttribute('aria-label'),
      backend: backendSelect?.getAttribute('aria-label') }))
}
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
runningRow?.querySelector('.sa-row-open')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
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
const stopConfirm = [...(stopDialog?.querySelectorAll('button') ?? [])]
  .find(button => /终止工单|^(确认|确定)$/.test((button.textContent ?? '').trim()))
stopConfirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const stoppedText = text()
check('the stop request is recorded for this Ticket', lastStopId === 'tkt_demo_running', String(lastStopId))
check('the panel shows 正在停止 while the worker is still finishing the current stage',
  stoppedText.includes('正在停止'), stoppedText.slice(0, 500))
check('the header stop entry leaves once the request is pending', ![...rootElement.querySelectorAll('.sa-page-head-actions button')]
  .some(button => (button.textContent ?? '').trim() === '停止工单'), 'stop still offered')

// Regression: a diff read that settles without data (the Ticket is gone) must not stay on "reading the diff" forever.
{
  const expectations = [
    ['a read in flight', {}, 'ticket.diffLoading'],
    ['a settled read with no data', { path: 'src/a.js', gone: true }, 'ticket.diffTicketGone'],
    ['a loaded diff', { path: 'src/a.js', data: { available: true } }, null],
    ['a failed read', { error: new Error('boom') }, null],
  ]
  for (const [label, state, expected] of expectations) {
    check(`diff dialog placeholder for ${label}`, diffPlaceholderKey(state) === expected,
      `${String(diffPlaceholderKey(state))} ≠ ${String(expected)}`)
  }
}

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
check('a merged legacy push record no longer claims it is waiting for the PR',
  !pushText.includes('已推送，等待创建 PR') && !pushText.includes('PR 已创建') && pushText.includes('已合入目标分支'),
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
// The mock answers every decisions request from one fixture (it ignores `offset`/`limit`), so page 2 only exists when
// the fixture claims enough rows. A clean checkout has a single seeded decision, which made offset=25 genuinely out of
// range there: R2-14 correctly clamped it to the last page, and the real-state-only run hid that. Give the fixture a
// page-2-sized total for this step so the restore path is exercised in every state.
const decisionsTotalBefore = fixtures.decisions.total
fixtures.decisions.total = 100
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
fixtures.decisions.total = decisionsTotalBefore
window.history.replaceState(null, '', '/')
window.sessionStorage.removeItem('superagent-panel/eval-scroll')

// R2-14: a link to page 2 that is past the end of the current result set must clamp to the last page and say so. The
// fixture below is the empty-state shape CI sees (one recorded decision), so offset=25 is out of range on every machine.
console.log('STEP eval out-of-range deep link')
const decisionsForClamp = fixtures.decisions
fixtures.decisions = { items: [], total: 1, counts: {} }
window.history.replaceState(null, '', '/?evalOffset=25')
window.sessionStorage.setItem('superagent-panel/route', JSON.stringify({ route: { page: 'eval' }, stack: [] }))
const clampRoot = ReactDOM.createRoot(rootElement)
clampRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
const clampText = rootElement.textContent ?? ''
const clampRequest = calls.filter(entry => /engine\/decisions\?/.test(entry)).at(-1) ?? ''
check('an out-of-range eval deep link clamps to the last page and says so (R2-14)',
  clampText.includes('已显示最后一页') && clampText.includes('共 1 条'), clampText.slice(0, 300))
check('the clamped eval page refetches from the last page instead of leaving the list empty (R2-14)',
  /offset=0/.test(clampRequest) && !/offset=25/.test(clampRequest), clampRequest)
clampRoot.unmount()

// The empty result set is not "clamped": there is no last page to go back to, so the page shows the empty state and
// keeps working (no clamp loop, no request storm). This is the CI shape too, made explicit rather than inherited.
fixtures.decisions = { items: [], total: 0, counts: {} }
const emptyRoot = ReactDOM.createRoot(rootElement)
emptyRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
const emptyText = rootElement.textContent ?? ''
const emptyRequests = calls.filter(entry => /engine\/decisions\?/.test(entry))
check('an empty result set with a deep-linked offset renders the empty state, not a phantom page (R2-14)',
  emptyText.includes('还没有评估记录。') && emptyRequests.at(-1) !== undefined
  && !emptyText.includes('已显示最后一页'), emptyText.slice(0, 300))
emptyRoot.unmount()
fixtures.decisions = decisionsForClamp
window.history.replaceState(null, '', '/')

// ---- pure projections: states the fixtures cannot reach -----------------------------------------------------------
console.log('STEP pure projections')
{
  // B1: `normalizeRepos` always hands the client one repository, so counting entries claimed "bind a repository" was
  // done on a fresh install. Only a repository with a local path or a remote project counts.
  const placeholder = setupStateOf({ config: { repos: [{ id: 'repo-1', repo: '', project: '' }],
    octo: { tokenConfigured: true, watchChatIds: ['chat-1'], allowAnyHuman: true }, enabled: false } })
  const bound = setupStateOf({ config: { repos: [{ id: 'repo-1', repo: '/src/app', project: 'group/app' }],
    octo: { tokenConfigured: true, watchChatIds: ['chat-1'], allowAnyHuman: true }, enabled: false } })
  check('the setup card does not tick “bind a repository” for the placeholder repo (B1)',
    placeholder.steps.find(step => step.key === 'repo')?.done === false && placeholder.done === 2
    && bound.steps.find(step => step.key === 'repo')?.done === true,
    JSON.stringify({ placeholder: placeholder.done, bound: bound.done }))

  // U-03/B8: a stopped or booting engine must never read 运行中; a start failure keeps its error state.
  const health = phase => globalHealth({ engine: { phase }, config: { enabled: phase !== 'dry-run' } })
  check('header health never calls a stopped engine 运行中 (U-03)',
    globalHealth({ engine: { phase: 'dry-run' }, config: { enabled: false } }).labelKey === 'shell.stopped'
    && globalHealth({ engine: { phase: 'idle' }, config: { enabled: false } }).labelKey === 'shell.stopped',
    JSON.stringify({ dry: globalHealth({ engine: { phase: 'dry-run' }, config: { enabled: false } }),
      idle: globalHealth({ engine: { phase: 'idle' }, config: { enabled: false } }) }))
  check('header health calls a booting engine 启动中, not 运行中 (B8)',
    health('starting').labelKey === 'shell.starting'
    && globalHealth({ engine: { phase: 'error', error: 'engine start failed: boom' },
      config: { enabled: true } }).labelKey === 'shell.error'
    && health('idle').labelKey === 'shell.running',
    JSON.stringify({ starting: health('starting'), error: globalHealth({ engine: { phase: 'error' },
      config: { enabled: true } }), idle: health('idle') }))

  // U-07: a filter that matched nothing says so; it never claims there is no evaluation history.
  const filtered = evalEmptyState(t, () => {}, { all: 5, accept: 5 }, 'accept', 'all', () => {}, () => {}, () => {},
    true)
  const unfiltered = evalEmptyState(t, () => {}, { all: 0, accept: 0 }, 'all', 'all', () => {}, () => {}, () => {})
  check('an empty eval filter names the filter, not an empty history (U-07)',
    filtered?.props?.title === '这个筛选条件下没有记录。'
    && unfiltered?.props?.title !== '这个筛选条件下没有记录。',
    JSON.stringify({ filtered: filtered?.props?.title, unfiltered: unfiltered?.props?.title }))

  // U-02: a `#sa=…` page load opens the panel through the host's layout service. That service is optional on purpose:
  // injecting it would keep the whole plugin (sidebar icon included) from activating on a host that lacks it, so the
  // service is re-read on every retry tick instead. `selectPanel` also throws until our `main` key is registered, so
  // the open is retried while the link is still unclaimed.
  const openedPanels = []
  const layoutHost = { get: name => (name === 'layout' ? { selectPanel: id => openedPanels.push(id) } : undefined) }
  const openedDirect = openLinkedPanel(layoutHost, { route: { page: 'source' } })
  const openedWithoutHost = openLinkedPanel({}, { route: { page: 'source' } })
  const openedWithoutRoute = openLinkedPanel(layoutHost, {})
  // Product semantics, not a detail: the panel opens itself only for a page load that carried one of our `#sa=…`
  // links. With no link in the URL the module-level `LINKED_ROUTE` is null, so the retry loop must not even start —
  // otherwise a plain load would steal focus from whatever the person was reading.
  const idleRuns = openLinkedPanelWhenReady(layoutHost)
  check('a shared panel link opens the panel, and a host without a layout service keeps the plugin active (U-02)',
    pluginInject.join() === 'slots,locale' && openedDirect === true && openedWithoutHost === false
    && openedWithoutRoute === false && idleRuns === undefined && openedPanels.length === 1
    && openedPanels[0] === 'superagent',
    JSON.stringify({ inject: pluginInject, openedPanels, openedDirect, openedWithoutHost, openedWithoutRoute,
      idleRuns: idleRuns === undefined ? 'no attempt' : 'started' }))

  // The retry loop: the key is not registered yet, so the first attempts throw; it must stop as soon as the panel
  // claims the link (or the link stops being pending), and it must never keep a timer alive afterwards.
  const retryCalls = []
  let retryThrows = 2
  const retryLayout = { selectPanel: id => { retryCalls.push(id); if (retryThrows-- > 0) throw new Error('main key not registered') } }
  const stopRetry = openLinkedPanelWhenReady({ get: () => retryLayout },
    { isPending: () => true, route: { page: 'eval' }, intervalMs: 10, limit: 8 })
  await sleep(120)
  stopRetry?.()
  const retried = retryCalls.length
  await sleep(60)
  const afterDispose = retryCalls.length

  const stopCalls = []
  let pendingStop = true
  const neverLayout = { selectPanel: () => { stopCalls.push(1); throw new Error('main key not registered') } }
  const releaseStop = openLinkedPanelWhenReady({ get: () => neverLayout },
    { isPending: () => pendingStop, route: { page: 'eval' }, intervalMs: 10, limit: 20 })
  await sleep(15)
  pendingStop = false
  await sleep(80)
  const stoppedAt = stopCalls.length
  await sleep(50)
  const stoppedAfter = stopCalls.length
  releaseStop?.()

  check('opening a shared panel retries while the key is unregistered and stops once the link is claimed (U-02)',
    retried === 3 && afterDispose === retried && stoppedAt < 20 && stoppedAfter === stoppedAt,
    JSON.stringify({ retried, afterDispose, stoppedAt, stoppedAfter }))

  // Soft dependency: a host that provides `layout` only after the first tick (a slow boot) must still open the linked
  // panel — reading the service once at apply time would miss it forever.
  const latePanels = []
  const lateCalls = []
  const lateCtx = { get: name => {
    if (name !== 'layout') return undefined
    lateCalls.push(1)
    return lateCalls.length === 1 ? undefined : { selectPanel: id => latePanels.push(id) }
  } }
  const stopLate = openLinkedPanelWhenReady(lateCtx,
    { isPending: () => true, route: { page: 'eval' }, intervalMs: 10, limit: 8 })
  await sleep(80)
  stopLate?.()
  check('a layout service that appears late still opens the shared panel (U-02)',
    latePanels.length === 1 && latePanels[0] === 'superagent' && lateCalls.length >= 2,
    JSON.stringify({ lateCalls: lateCalls.length, latePanels }))

  // U-11: host enums reach the panel as identifiers. Every skip code and every known failure gets Chinese wording, and
  // an unrecognised English message leads with a Chinese conclusion instead of dumping its raw text in the row.
  const reasonSamples = {
    botSender: signalReasonText(t, { skipReason: 'bot-sender' }),
    modelSkip: signalReasonText(t, { skipReason: 'modelSkip' }),
    unknown: signalReasonText(t, { skipReason: 'no-such-code' })
  }
  check('raw signal rows phrase host skip codes in Chinese (U-11)',
    reasonSamples.botSender === '发送者是机器人' && reasonSamples.modelSkip === '模型判断这不是本仓库的任务'
      && reasonSamples.unknown === '未识别原因（技术标识：no-such-code）',
    JSON.stringify(reasonSamples))
  const blockedFailure = failureLabel(t, 'ticket tkt_1 workflow blocked: review still requested changes after 2 rounds')
  const unknownFailure = failureLabel(t, 'TypeError: something exploded deep inside')
  check('a workflow block and an unknown error lead with a Chinese conclusion (U-11)',
    blockedFailure.includes('分阶段流程被阻塞') && blockedFailure.includes('独立审查仍要求修改')
      && unknownFailure.startsWith('其他原因')
      && workflowBlockedDetail(t, 'review still requested changes') === '独立审查仍要求修改（返工轮次已用完）',
    JSON.stringify({ blockedFailure, unknownFailure }))

  // U-09: the run trigger is a state, not a button, and every value the host emits has a Chinese label.
  const triggerLabels = ['manual', 'auto', 'retry', 'resume'].map(trigger => runTriggerLabel(t, { trigger }))
  check('every run trigger maps to a Chinese label, and resume reads as a state (U-09)',
    triggerLabels.join('/') === '手动/自动/重试/恢复触发', JSON.stringify(triggerLabels))

  // U-10: the remote address is named after the host (a GitHub repository is not a "GitLab 地址"), and a repository
  // without a token says what still works instead of implying it is broken.
  const githubRows = sourceRepoRows(t,
    { config: { baseUrl: 'https://github.com/org/app', project: 'org/app', tokenConfigured: false } },
    { repo: '/src/app' })
  const gitlabRows = sourceRepoRows(t,
    { config: { baseUrl: 'https://gitlab.example.com', project: 'grp/app', tokenConfigured: true } },
    { repo: '/src/app' })
  const rowLabelOf = (rows, label) => rows.some(row => row[0] === label)
  check('the remote address is named after its host and a token-less repository says what still works (U-10)',
    rowLabelOf(githubRows, 'GitHub 地址') && rowLabelOf(gitlabRows, 'GitLab 地址')
      && githubRows.some(row => row[1] === '令牌未配置（不影响本地只读）')
      && !rowLabelOf(githubRows, 'GitLab 地址')
      // R2-05: the project row follows the same host, so one card never pairs "GitLab 项目" with "GitHub 地址".
      && rowLabelOf(githubRows, 'GitHub 项目') && rowLabelOf(gitlabRows, 'GitLab 项目'),
    JSON.stringify({ github: githubRows.map(row => row[0]), gitlab: gitlabRows.map(row => row[0]) }))

  // R2-05: one helper decides the host name every card reads, so no surface can disagree with the URL beside it.
  check('repository wording follows the hosting provider (R2-05)',
    hostOfUrl('https://github.com/org/app') === 'github' && hostName('github') === 'GitHub'
      && hostOfUrl('https://gitlab.example.com/grp/app') === 'gitlab' && hostName('gitlab') === 'GitLab',
    JSON.stringify({ github: hostName(hostOfUrl('https://github.com/a')),
      gitlab: hostName(hostOfUrl('https://gitlab.b')) }))

  // R2-01/R2-08/R2-15: a shared link wins on a cold open, and a tab whose URL was pruned on the way out restores the
  // slice it remembers instead of snapping back to page one.
  const restoreHref = window.location.href
  const readSourceQuery = params => ({ offset: Number(params.get('srcOffset') ?? 0) || 0,
    q: params.get('srcQ') ?? '' })
  try {
    window.history.replaceState(null, '', '/?srcOffset=40&srcQ=needle#sa=%7B%22page%22%3A%22source%22%7D')
    const fromUrl = initialPageQuery('source', readSourceQuery, { offset: 0, q: '' })
    rememberPageState('source', { offset: 20, q: 'remembered' })
    window.history.replaceState(null, '', '/#sa=%7B%22page%22%3A%22source%22%7D')
    const fromStore = initialPageQuery('source', readSourceQuery, { offset: 0, q: '' })
    check('a shared link keeps its filter, and a pruned tab restores the slice it remembered (R2-01/R2-08/R2-15)',
      fromUrl.offset === 40 && fromUrl.q === 'needle'
        && fromStore.offset === 20 && fromStore.q === 'remembered',
      JSON.stringify({ fromUrl, fromStore }))
  } finally {
    window.history.replaceState(null, '', restoreHref)
    try { window.sessionStorage.removeItem('superagent-panel/page-state') } catch { /* ignore */ }
  }

  // R2-02: the eval page renders the same reason codes the source page does; every model verdict has words of its own.
  const modelReasons = ['modelSkip', 'modelRisk', 'modelUncertain', 'highRisk'].map(code => reasonLabel(t, { code }))
  check('model verdicts and filter reasons read as Chinese on every page (R2-02)',
    modelReasons[0] === '模型判断这不是本仓库的任务' && modelReasons[1] === '模型判断属于高风险'
      && modelReasons[2] === '模型不确定，留给人工' && modelReasons[3].startsWith('命中高风险主题'),
    JSON.stringify(modelReasons))

  // R2-03: four numbers need four labelled buckets; the old label named three.
  check('the judge counter labels all four numbers (R2-03)',
    t('st.judgeCalls') === '模型调用（总计 / 成功 / 失败 / 跳过）', t('st.judgeCalls'))

  // R2-06: "no thread matched this filter" is not "no source configured", and it offers a way out of the filter.
  check('an empty thread filter names the filter and offers to clear it (R2-06)',
    t('trg.noneInFilter').includes('没有符合当前筛选') && t('trg.clearFilter') === '清除筛选',
    JSON.stringify({ none: t('trg.noneInFilter'), clear: t('trg.clearFilter') }))

  // R2-07: a zero-failure window is a statement, not a link into an unfiltered list of older failures.
  check('the 24h failure counter has a non-clickable zero state (R2-07)',
    t('ex.runs24hNone') === '24 小时没有运行失败', t('ex.runs24hNone'))

  // R2-11: the banner says how much is left instead of presenting a frozen 3/4 fraction.
  check('the setup banner says how many steps are left (R2-11)',
    t('setup.banner', { remaining: 1 }) === '还有 1 项待配置', t('setup.banner', { remaining: 1 }))
  // R2-11's real surface is AutomationBar (the banner is hidden while automation is on): assert the rendered line,
  // not only the dictionary, so a fix aimed at the wrong component fails here.
  const barHost = document.createElement('div')
  document.body.appendChild(barHost)
  const barRoot = ReactDOM.createRoot(barHost)
  const renderBar = progress => barRoot.render(React.createElement(Panel.Provider,
    { value: { t, call: async () => ({}), navigate() {}, notify() {} } },
    React.createElement(AutomationBar, { paused: false, engineEnabled: false, executorEnabled: false,
      onStart() {}, onCheck() {}, progress })))
  renderBar({ done: 3, total: 4 })
  await sleep(80)
  const barText = barHost.textContent ?? ''
  check('AutomationBar prints the setup progress as a countdown, not a fraction (R2-11)',
    /还有 1 项待配置/.test(barText) && !/3\/4|配置 3/.test(barText), barText.slice(0, 160))
  renderBar({ done: 4, total: 4 })
  await sleep(80)
  check('AutomationBar drops the setup line once every step is done (R2-11)',
    !/项待配置/.test(barHost.textContent ?? ''), (barHost.textContent ?? '').slice(0, 160))
  barRoot.unmount()
  barHost.remove()

  // R2-12: credentials are 令牌/未配置, chats are 群 ID — one vocabulary across settings, sources and tickets.
  check('credentials and chats use one vocabulary (R2-12)',
    t('st.octoToken') === 'Octo 令牌' && t('st.tokenMissing') === '令牌未配置'
      && !String(t('st.bindingsHint') ?? '').includes('chatId')
      && !String(t('st.chatIdPlaceholder') ?? '').includes('chatId'),
    JSON.stringify({ octo: t('st.octoToken'), missing: t('st.tokenMissing'),
      hint: t('st.bindingsHint'), placeholder: t('st.chatIdPlaceholder') }))

  // R2-10: a queued Ticket has not run yet, so the publish entry is withheld until the server would accept it.
  check('the publish entry waits for a publishable Ticket status (R2-10)',
    publishableStatusOf({ status: 'ready' }) && publishableStatusOf({ status: 'failed' })
      && publishableStatusOf({ status: 'pushed' }) && !publishableStatusOf({ status: 'queued' })
      && !publishableStatusOf({ status: 'ci-pending' }) && !publishableStatusOf({}),
    JSON.stringify(['ready', 'failed', 'pushed', 'queued', 'ci-pending', undefined]
      .map(status => [status ?? 'none', publishableStatusOf({ status })])))

  // R2-14: an offset past the end is a page problem, not an empty filter; the helper keeps the last real page.
  check('an out-of-range eval offset clamps to the last page (R2-14)',
    clampEvalOffset(1000, 30) === 25 && clampEvalOffset(30, 30) === 25 && clampEvalOffset(50, 30) === 25
      && clampEvalOffset(25, 30) === undefined && clampEvalOffset(0, 30) === undefined
      && clampEvalOffset(0, 0) === undefined,
    JSON.stringify({ far: clampEvalOffset(1000, 30), edge: clampEvalOffset(30, 30),
      valid: clampEvalOffset(25, 30), empty: clampEvalOffset(0, 0) }))

  // D2-09: the dismissal entry is no longer limited to `failed` — a dry run, a real run with push disabled, a queued
  // stub and a question nobody will answer all reach the same cleanup path.
  check('dismissal covers finished-but-undelivered Tickets, not only failures (D2-09)',
    ['failed', 'ci-failed', 'deploy-failed', 'queued', 'ready', 'awaiting-answer'].every(status => ticketDismissable({ status }))
      && ['deployed', 'merged', 'dismissed', 'closed', 'ci-pending'].every(status => !ticketDismissable({ status })),
    JSON.stringify([...['failed', 'ready', 'awaiting-answer', 'deployed', 'ci-pending']].map(status => [status, ticketDismissable({ status })])))

  // R2-04: a history row explains what changed. Old and new values, booleans spelled out, long values folded behind
  // an explicit "show full value" control instead of being dumped into the row.
  const historyHost = document.createElement('div')
  document.body.appendChild(historyHost)
  const historyRoot = ReactDOM.createRoot(historyHost)
  const historyEntry = { id: 'hist_1', at: new Date().toISOString(), label: 'settings: executor',
    changes: [{ key: 'executor.timeoutMs', before: '600000', after: '900000' },
      { key: 'executor.autoRun', before: 'false', after: 'true' }], changesTruncated: false }
  const renderHistory = open => historyRoot.render(React.createElement(Panel.Provider,
    { value: { t, call: async () => ({}), navigate() {}, notify() {} } },
    React.createElement(HistoryChanges, { t, entry: historyEntry, open, onToggle() {} })))
  renderHistory(false)
  await sleep(80)
  const historyClosed = historyHost.textContent ?? ''
  renderHistory(true)
  await sleep(80)
  const historyOpen = historyHost.textContent ?? ''
  check('history rows offer the changed fields as a toggle (R2-04)',
    /查看改动（2）/.test(historyClosed) && !/900000/.test(historyClosed), historyClosed.slice(0, 120))
  check('history rows spell out the old and new value, booleans included (R2-04)',
    /600000/.test(historyOpen) && /900000/.test(historyOpen) && /开/.test(historyOpen) && /关/.test(historyOpen)
      && historyOpen.indexOf('600000') < historyOpen.indexOf('900000'),
    historyOpen.slice(0, 200))
  const longEntry = { id: 'hist_2', at: new Date().toISOString(), label: 'settings: executor.workerCommand',
    changes: [{ key: 'executor.workerCommand', before: '', after: `node ${'x'.repeat(160)}` }], changesTruncated: false }
  historyRoot.render(React.createElement(Panel.Provider,
    { value: { t, call: async () => ({}), navigate() {}, notify() {} } },
    React.createElement(HistoryChanges, { t, entry: longEntry, open: true, onToggle() {} })))
  await sleep(80)
  const longButton = [...historyHost.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === '展开全文')
  check('a long history value is truncated with a way to expand it (R2-04)',
    Boolean(longButton) && !/x{100}/.test(historyHost.textContent ?? ''), historyHost.textContent?.slice(0, 120) ?? 'no row')
  longButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  check('expanding a long history value shows it whole (R2-04)',
    /x{100}/.test(historyHost.textContent ?? ''), String((historyHost.textContent ?? '').length))
  historyRoot.unmount()
  historyHost.remove()

  // N2-04: metric failure causes are stop reasons/codes; the brief must read them as causes, and an unknown code must
  // be named as a technical id rather than passed off as a sentence.
  check('failure causes read in Chinese, including stop reasons (N2-04)',
    failureReasonTextOf(t, 'stopped') === '人工终止' && failureReasonTextOf(t, 'worker_lost') === 'worker 失联',
    JSON.stringify([failureReasonTextOf(t, 'stopped'), failureReasonTextOf(t, 'worker_lost')]))
  check('a workflow-blocked cause is spelled out, not shown as an English blob (N2-04)',
    /分阶段流程被阻塞/.test(failureReasonTextOf(t, 'workflow blocked: review still requested changes after 6 repair round(s) (7 findings)')),
    failureReasonTextOf(t, 'workflow blocked: review still requested changes after 6 repair round(s) (7 findings)'))
  check('an unknown failure code is labelled as a technical id (N2-04)',
    failureReasonTextOf(t, 'mystery_code') === '技术标识：mystery_code', failureReasonTextOf(t, 'mystery_code'))


  // N2-06: a cold open of Settings has no data on the first frame (the panel is still fetching status while the page
  // mounts). R2-04's per-entry Hook used to sit after the skeleton return, so the second frame changed the Hook count
  // and React threw #310 — invisible to the checks above, which mount the app with data already loaded. Mount the real
  // page through both frames and fail on any render error.
  class ColdBoundary extends React.Component {
    constructor(props) { super(props); this.state = { error: null } }
    static getDerivedStateFromError(error) { return { error } }
    render() { return this.state.error ? React.createElement('div', { className: 'sa-cold-failed' }) : this.props.children }
  }
  const coldHost = document.createElement('div')
  document.body.appendChild(coldHost)
  const coldRoot = ReactDOM.createRoot(coldHost)
  const coldBoundary = React.createRef()
  const coldActions = new Proxy({}, { get: () => async () => ({}) })
  const coldPanel = { t, call: async () => ({}), navigate() {}, notify() {}, back() {}, openSession() {},
    backLabel: '', route: { page: 'settings' } }
  const renderCold = stateValue => coldRoot.render(
    React.createElement(ColdBoundary, { ref: coldBoundary },
      React.createElement(Panel.Provider, { value: coldPanel },
        React.createElement(PanelState.Provider, { value: stateValue },
          React.createElement(LiveSettingsPage, { route: { page: 'settings', group: 'source' } })))))
  const coldError = () => coldBoundary.current?.state?.error ?? null
  renderCold({ data: undefined, error: undefined, reload: async () => {}, actions: coldActions })
  await sleep(120)
  check('cold-open Settings renders its first frame without a Hook error (N2-06)',
    !coldError() && Boolean(coldHost.querySelector('.sa-skeleton')), String(coldError()?.message ?? coldHost.textContent?.slice(0, 80)))
  renderCold({ data: fixtures.status, error: undefined, reload: async () => {}, actions: coldActions })
  await sleep(160)
  check('cold-open Settings keeps rendering once data arrives (N2-06)',
    !coldError() && !coldHost.querySelector('.sa-skeleton') && /设置|来源|执行器/.test(coldHost.textContent ?? ''),
    String(coldError()?.message ?? coldHost.textContent?.slice(0, 160)))
  coldRoot.unmount()
  coldHost.remove()

  // §13.2/AC-B1: the bots group lists the store, keeps the built-ins on top and refuses to save against an
  // unverified backend — the error code is shown in place, next to the sentence, never swallowed.
  {
    const builtin = (id, name) => ({ id, name, description: '', backend: 'dsh', requires: [], stages: ['implement', 'gates'] })
    const stored = [builtin('generalist', '通用'), builtin('surgical', '小修'), builtin('reviewer', '审阅者'),
      { id: 'mine', name: '我的 Bot', backend: 'dsh', requires: ['edit'], tools: { deny: ['write'] },
        skills: { prefer: ['ponytail'] }, prompt: { role: '只做最小改动' }, stages: ['implement', 'gates'] }]
    const backendsOf = state => ({ dsh: { backend: 'dsh', state, source: state === 'unverified' ? 'fallback' : 'probe',
      capabilities: { edit: true, exec: true, web: false }, verifiedAt: state === 'verified' ? nowIso : undefined },
    claude: { backend: 'claude', state: 'unverified', source: 'fallback', capabilities: { edit: true, exec: false, web: false } },
    codex: { backend: 'codex', state: 'unverified', source: 'fallback', capabilities: { edit: true, exec: true, web: false } } })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = ReactDOM.createRoot(host)
    const lists = []
    const panel = { t, call: async () => ({}), navigate() {}, notify() {}, back() {}, openSession() {}, backLabel: '' }
    const renderBots = (state, actions) => root.render(React.createElement(Panel.Provider, { value: panel },
      React.createElement(PanelState.Provider, { value: { data: fixtures.status, error: undefined, reload: async () => {}, actions } },
        React.createElement(BotsCard))))
    const store = state => ({ file: join(stateDir, 'worker-bots.json'), exists: true, builtin: false, version: 2,
      bots: stored, backends: backendsOf(state), enabledBackends: ['dsh'],
      ruleWarnings: [{ code: 'DISPATCH_RULE_BOT_UNKNOWN', index: 1, bot: 'ghost' }] })
    renderBots('unverified', { bots: async () => store('unverified'),
      saveBots: async list => { lists.push(list); throw new ApiError('后端 dsh 未核验', 400,
        { code: 'BOT_BACKEND_UNVERIFIED', problems: ['bot mine: backend dsh is unverified'] }) },
      verifyBotBackend: async () => ({}) })
    await sleep(160)
    const botsText = () => host.textContent ?? ''
    check('the bots group lists the store and marks the built-ins (§13.2)',
      /通用/.test(botsText()) && /我的 Bot/.test(botsText()) && /内置/.test(botsText()), botsText().slice(0, 200))
    check('an unverified backend is shown as unverified, not as ready (AC-B1)',
      /未核验/.test(botsText()) && /dsh/.test(botsText()), botsText().slice(0, 240))
    const firstRow = host.querySelector('.sa-bot-row')
    check('a built-in bot offers copy but not edit or delete (§4.5/§13.2)',
      /内置/.test(firstRow?.textContent ?? '') && /复制内置/.test(firstRow?.textContent ?? '')
        && !/删除/.test(firstRow?.textContent ?? '') && [...firstRow.querySelectorAll('button')]
          .every(node => (node.textContent ?? '').trim() !== '编辑'),
      firstRow?.textContent?.slice(0, 160) ?? 'no row')
    check('a dispatch rule pointing at a missing bot is reported (§5.1)',
      /分派规则 #1/.test(botsText()) && /ghost/.test(botsText()), botsText().slice(0, 300))
    const newButton = [...host.querySelectorAll('button')].find(node => (node.textContent ?? '').trim() === '新建 Bot')
    newButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(120)
    const modalText = () => [...host.querySelectorAll('.sa-bot-modal')].map(node => node.textContent).join('')
    check('the editor previews what the bot would get (§13.2)',
      /预览它能拿到什么/.test(modalText()) && /禁止的工具/.test(modalText()), modalText().slice(0, 240))
    check('the editor warns that an unverified backend cannot be saved (AC-B1)',
      /未核验/.test(modalText()), modalText().slice(0, 240))
    const saveButton = [...host.querySelectorAll('.sa-bot-modal button')]
      .find(node => (node.textContent ?? '').trim() === '保存')
    saveButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(160)
    check('a rejected save shows the host error code in place (§13.2)',
      /BOT_BACKEND_UNVERIFIED/.test(botsText()), botsText().slice(0, 300))
    const afterReject = lists.at(-1) ?? []
    check('a save sends the store without host-added keys (§4.2)',
      afterReject.every(bot => !('capabilities' in bot) && !('environment' in bot)),
      JSON.stringify(afterReject.map(bot => Object.keys(bot))).slice(0, 200))
    // A verified backend accepts the same store: remount so the group loads the verified evidence.
    root.unmount()
    const verifiedRoot = ReactDOM.createRoot(host)
    verifiedRoot.render(React.createElement(Panel.Provider, { value: panel },
      React.createElement(PanelState.Provider, { value: { data: fixtures.status, error: undefined, reload: async () => {},
        actions: { bots: async () => store('verified'), saveBots: async list => ({ ...store('verified'), bots: list }),
          verifyBotBackend: async () => ({}) } } },
        React.createElement(BotsCard))))
    await sleep(160)
    check('a verified backend renders as verified (§13.2)', /已核验/.test(botsText()), botsText().slice(0, 240))
    verifiedRoot.unmount()
    host.remove()
  }

  const menuHost = document.createElement('div')
  document.body.appendChild(menuHost)
  const menuRoot = ReactDOM.createRoot(menuHost)
  menuRoot.render(React.createElement(Panel.Provider,
    { value: { t, call: async () => ({}), navigate() {}, notify() {} } },
    React.createElement(Menu, { label: '更多操作', items: [
      { key: 'ci', label: '刷新 CI', onSelect() {}, disabled: true, title: '没有 MR' },
      { key: 'stop', label: '停止工单', onSelect() {}, disabled: false },
    ] })))
  await sleep(120)
  menuHost.querySelector('.sa-menu-trigger')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(120)
  const disabledMenuItems = [...menuHost.querySelectorAll('.sa-menu-item')].filter(node => node.disabled)
  check('a disabled menu entry also carries aria-disabled (R2-13)',
    disabledMenuItems.length >= 1 && disabledMenuItems.every(node => node.getAttribute('aria-disabled') === 'true'),
    JSON.stringify(disabledMenuItems.map(node => node.getAttribute('aria-disabled'))))
  menuRoot.unmount()
  menuHost.remove()

  // U-08: filters belong to the page that owns them. Switching tabs drops the previous page's parameters while the
  // shareable fragment and the host's own parameters survive. Every key a page actually writes must be in the
  // whitelist: `evalWindow` shipped as `evalRange` once, so the Eval range survived a tab switch forever.
  const restoreUrl = window.location.href
  const allFilterParams = ['srcQ=needle', 'srcStatus=skipped', 'srcOffset=20',
    'trgFilter=recent', 'trgQ=thread', 'evalKind=accept', 'evalWindow=24h', 'evalView=divergence', 'evalOffset=25']
  window.history.replaceState(null, '', `/?${allFilterParams.join('&')}&host=keep#sa=%7B%22page%22%3A%22eval%22%7D`)
  const pruned = prunePageQuery('execution')
  const afterPrune = `${window.location.search}|${window.location.hash}`
  window.history.replaceState(null, '', `/?${allFilterParams.join('&')}`)
  const keptEval = prunePageQuery('eval')
  const afterEval = window.location.search
  window.history.replaceState(null, '', '/?srcQ=needle&host=keep#sa=x')
  const keptOwn = prunePageQuery('source')
  const afterKeep = window.location.search
  window.history.replaceState(null, '', restoreUrl)
  check('a page keeps only the query parameters it owns (U-08)',
    pruned === true && afterPrune === '?host=keep|#sa=%7B%22page%22%3A%22eval%22%7D'
      && keptEval === true
      && afterEval === '?evalKind=accept&evalWindow=24h&evalView=divergence&evalOffset=25'
      && keptOwn === false && afterKeep === '?srcQ=needle&host=keep',
    JSON.stringify({ afterPrune, afterEval, afterKeep }))

  // U-05: a raw signal longer than the 160-character preview opens in place — no dialog, no navigation, and the
  // closed row keeps its single-line height.
  const longBody = `${'这是一条很长的群消息，'.repeat(4)}完整内容只在这里出现。`
  const previewText = `预览段：${longBody.slice(0, 20)}…`
  const signalHost = document.createElement('div')
  document.body.appendChild(signalHost)
  const signalRoot = ReactDOM.createRoot(signalHost)
  signalRoot.render(React.createElement(Panel.Provider, { value: { t, call: async () => ({}), navigate() {}, notify() {} } },
    React.createElement(RawSignalRows, {
      items: [{ id: 'sig_demo', source: 'octo', status: 'skipped', skipReason: 'not-text',
        receivedAt: new Date().toISOString(), textPreview: previewText, text: longBody, labels: [] }],
      onReplay() {}, onLabel() {}, busy: false, labelBusy: false, focusId: ''
    })))
  await sleep(150)
  const signalToggle = signalHost.querySelector('.sa-signal-toggle')
  const signalClosed = signalHost.querySelectorAll('.sa-signal-full').length
  const previewWhileClosed = signalHost.textContent.includes(previewText)
  if (signalToggle) signalToggle.click()
  await sleep(150)
  const signalOpened = signalHost.querySelector('.sa-signal-full')
  const openTitle = signalHost.querySelector('.sa-signal-text-open')
  // N2: open, the row shows the body once. The preview span collapses into a 「收起」 control — keeping it above the
  // full paragraph repeated the first 160 characters, which read like the same message had been posted twice.
  const previewWhileOpen = signalHost.textContent.includes(previewText)
  check('a long raw signal opens in place instead of staying truncated (U-05)',
    Boolean(signalToggle) && signalClosed === 0 && Boolean(signalOpened) && previewWhileClosed
      && signalOpened.textContent === longBody && !previewWhileOpen
      && openTitle?.textContent === '收起',
    JSON.stringify({ previewWhileClosed, previewWhileOpen, titleWhileOpen: openTitle?.textContent ?? null }))
  signalRoot.unmount()
  signalHost.remove()
}

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
