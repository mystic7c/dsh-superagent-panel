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
  writeFileSync(join(dir, 'worktree-demo', 'worker-bots.json'), JSON.stringify({ version: 3, bots: [] }))
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
const repoLabels = liveRepos.map(repo => repo.name || repo.id)
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
    // 1.5.0 Bots v3: the run keeps a snapshot of the bot it ran (id/name/backend) and the dispatch record that picked
    // it. `dispatch` is the single place the row reads source/because/candidates/degraded from.
    bot: { id: 'generalist', name: '通用', backend: 'dsh' },
    dispatch: { source: 'pick', picked: 'generalist', candidates: ['generalist', 'reviewer'],
      because: '这次是验收流程修复，generalist 的覆盖面最广', cacheHit: true, configDigest: 'digest-demo' },
    steps, worker: { text: '## 改动内容\n\n1、修复验收流程。\n2、补充演示列表。', backend: 'dsh',
      sessionId: 'worker-tkt_demo_accept-abc123' }, changedPaths: ['demo/one/File.java', 'demo/one/Service.java', 'demo/one/Validator.java', 'demo/two/FileTest.java', 'demo/two/ServiceTest.java', 'docs/spec-a.md', 'docs/spec-b.md', 'docs/push.md'],
    gates: [{ name: 'standards', exitCode: 0 }, { name: 'demo-deploy', exitCode: 0 }] })
  // An older round: the changes section must describe the newest run, not the first one. It ran through a CLI worker,
  // which leaves a thread id of its own — the run row must not offer to open that as a Harness Session.
  engine.state.runs.push({ id: 'run_demo_old', ticketId: demoId, status: 'dry-run', dryRun: true,
    startedAt: new Date(Date.now() - 30 * 60_000).toISOString(), completedAt: new Date(Date.now() - 29 * 60_000).toISOString(),
    // No bot had an available backend on this round: the row must name the fallback, the skipped candidate and why —
    // a degraded dispatch is never silent (§2.4).
    bot: { id: 'generalist', name: '通用', backend: 'dsh' },
    dispatch: { source: 'default', picked: 'generalist', candidates: [], degraded: 'no-candidate',
      skipped: [{ id: 'mine', backend: 'codex', state: 'missing', reason: 'CLI 不在' }],
      because: '没有后端可用的 Bot，回退 generalist', configDigest: 'digest-demo' },
    steps: [], worker: { text: '旧一轮的总结不应该出现在改动内容里', backend: 'codex', sessionId: 'thread-demo-old' },
    changedPaths: [] })
  // A Claude Code run keeps a resumable conversation in its worktree, so its row can hand it to a sidebar terminal;
  // no other backend can, which is what the row checks below pin down. Oldest of the three, so nothing above changes.
  engine.state.runs.push({ id: 'run_demo_claude', ticketId: demoId, status: 'dry-run', dryRun: true,
    startedAt: new Date(Date.now() - 40 * 60_000).toISOString(), completedAt: new Date(Date.now() - 39 * 60_000).toISOString(),
    repoId: primaryRepoId, worktree: '/tmp/superagent-worktrees/tkt_demo_accept',
    // A repository may name its own bot in repos[].bot: that is an explicit choice, so it beats the pick and the
    // judge model is never called.
    bot: { id: 'generalist', name: '通用', backend: 'dsh' },
    dispatch: { source: 'explicit-repo', picked: 'generalist', candidates: ['generalist'],
      because: `仓库 ${primaryRepoId} 指定`, configDigest: 'digest-demo' },
    steps: [], worker: { text: 'Claude Code 跑过一轮', backend: 'claude',
      sessionId: '11111111-2222-3333-4444-555555555555',
      // A human rerun that continued an earlier conversation: the row must say so (1.1.17).
      resumedFrom: '99999999-8888-7777-6666-555555555555' }, changedPaths: [] })
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
  // A finished dry run normally has a patch; without one the detail has no changes form to type a revision into.
  changedPaths: ['demo/ready/File.java'],
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
// C-13: the UAT check is per repository, so both the request body and the answer are asserted.
let lastUatBody = null
// AC-07 deep-link probe: set just before the source-page remount so earlier checks still see the real (empty) log.
let signalFixture
window.fetch = global.fetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1:1')
  const method = String(init.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${url.pathname}${url.search}`)
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  const p = url.pathname.replace('/superagent/api/', '')
  // A route that never answers: the transport must give up on abort instead of hanging the polling queue forever.
  if (p === 'hang') {
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('The operation was aborted.')))
    })
  }
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
  if (method === 'POST' && p === 'engine/uat-check') {
    lastUatBody = init.body ? JSON.parse(String(init.body)) : null
    // A status nobody else can produce: whichever card shows "299" is the card that was actually checked.
    return json({ uat: { ok: true, status: 299, checkedAt: new Date().toISOString() } })
  }
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
  riskChangesOf, prunePageQuery, RawSignalRows, Panel, signalReasonText, failureLabel, runTriggerLabel, repoFactRows,
  openLinkedPanel, openLinkedPanelWhenReady, initialPageQuery, rememberPageState,
  hostOfUrl, hostName, reasonLabel, publishableStatusOf, primaryActionOf, ticketStatus, clampEvalOffset, Menu,
  ticketDismissable, HistoryChanges, requestIsTitle, durationText, ConfirmButton, Modal, ticketVisibleJumps,
  AutomationBar, failureReasonTextOf, LiveSettingsPage, PanelState, BotsCard, ApiError, apiCall, ThreadDetail, usePanel,
  PanelProvider,
  botToForm, formToBot,
  applyRenderFrame, fitGrid, claudeSessions, chatSummary,
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
  usePanel: 'api.js',
  PanelProvider: 'api.js',
  signalReasonText: 'source.js',
  failureLabel: 'live-ui.js',
  runTriggerLabel: 'live-ui.js',
  repoFactRows: 'settings.js',
  initialPageQuery: 'router.js',
  rememberPageState: 'router.js',
  hostOfUrl: 'util.js',
  hostName: 'util.js',
  reasonLabel: 'i18n.js',
  publishableStatusOf: 'live-ui.js',
  primaryActionOf: 'live-ui.js',
  ticketStatus: 'live-ui.js',
  ticketDismissable: 'ticket-detail.js',
  requestIsTitle: 'ticket-detail.js',
  ticketVisibleJumps: 'ticket-detail.js',
  durationText: 'overview.js',
  ConfirmButton: 'widgets.js',
  Modal: 'controls.js',
  HistoryChanges: 'settings.js',
  AutomationBar: 'live-ui.js',
  failureReasonTextOf: 'overview.js',
  LiveSettingsPage: 'settings.js',
  BotsCard: 'settings.js',
  botToForm: 'settings.js',
  formToBot: 'settings.js',
  applyRenderFrame: 'terminal.js',
  fitGrid: 'terminal.js',
  claudeSessions: 'sessions.js',
  RESUMABLE: 'sessions.js',
  chatSummary: 'sessions.js',
  PanelState: 'api.js',
  ApiError: 'api.js',
  apiCall: 'api.js',
  ThreadDetail: 'thread-detail.js',
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
/** Page-local text the way a page fragment reads it (PAGE_TEXT first, then the shared dictionary). */
const localText = (translateTo, key, values) => {
  const pair = PAGE_TEXT[key]
  let template = pair ? pair[0] : (DICTS.zh[key] ?? key)
  if (values === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}

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
check('去验收 opens the ticket detail', text().includes('权限依据') && text().includes('验收'),
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
  const order = ['改动内容', '验收', '闸门结果', '运行记录', '时间线']
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
  // The Claude Code run left a conversation behind: the row offers to reopen it in a sidebar terminal. A Codex or DSH
  // run has nothing to resume (a thread id is not a Claude session), so those rows keep no such control.
  const claudeRunRow = rootElement.querySelector('#sa-run-run_demo_claude')
  check('a Claude Code run offers to continue its conversation in the panel',
    Boolean(claudeRunRow?.querySelector('.sa-run-chat')), claudeRunRow?.textContent?.slice(0, 160) ?? 'no run row')
  check('a run that continued an earlier conversation says so',
    /续接上一轮/.test(claudeRunRow?.querySelector('.sa-row-title')?.textContent ?? ''),
    claudeRunRow?.querySelector('.sa-row-title')?.textContent?.slice(0, 160) ?? 'no run row')
  check('a run that started fresh does not claim to have continued anything',
    !/续接上一轮/.test(rootElement.querySelector('#sa-run-run_demo .sa-row-title')?.textContent ?? ''),
    rootElement.querySelector('#sa-run-run_demo .sa-row-title')?.textContent?.slice(0, 160) ?? 'no run row')
  check('a Codex run never offers to continue a Claude conversation',
    Boolean(cliRunRow) && !cliRunRow.querySelector('.sa-run-chat'), cliRunRow?.textContent?.slice(0, 160) ?? 'no run row')
  check('a DSH run never offers to continue a Claude conversation',
    Boolean(rootElement.querySelector('#sa-run-run_demo')) && !rootElement.querySelector('#sa-run-run_demo .sa-run-chat'),
    rootElement.querySelector('#sa-run-run_demo .sa-row-title')?.textContent?.slice(0, 160) ?? 'no run row')
  // §2.5: the row says which bot ran, which of the three dispatch layers chose it (explicit repo / explicit ticket /
  // judge pick / default), what the judge was offered and answered, and whether a cached answer skipped the model.
  const botRow = rootElement.querySelector('#sa-run-run_demo .sa-run-bot')
  check('a run names the bot that ran it and which layer chose it (§2.5)',
    Boolean(botRow) && /generalist/.test(botRow.textContent ?? '') && /2 挑选 · 决策模型/.test(botRow.textContent ?? ''),
    botRow?.textContent?.slice(0, 200) ?? 'no bot row')
  check('a picked dispatch shows its candidates, the reason and the cache tag (§2.5)',
    /候选：generalist、reviewer/.test(botRow?.textContent ?? '') && /理由：这次是验收流程修复/.test(botRow?.textContent ?? '')
      && /缓存命中，未调模型/.test(botRow?.textContent ?? ''),
    botRow?.textContent?.slice(0, 300) ?? 'no bot row')
  check('a degraded dispatch names the fallback, the skipped candidate and why (§2.4)',
    /没有后端可用的 Bot，已回退默认 Bot/.test(cliRunRow?.textContent ?? '')
      && /3 默认 · executor.bot/.test(cliRunRow?.textContent ?? '')
      && /未进候选：mine（CLI 不在）/.test(cliRunRow?.textContent ?? '')
      && /候选：无（后端都不可用）/.test(cliRunRow?.textContent ?? ''),
    cliRunRow?.textContent?.slice(0, 300) ?? 'no run row')
  check('an explicit repository choice says so instead of claiming a model pick',
    /1 显式 · 仓库指定/.test(claudeRunRow?.textContent ?? '') && /理由：仓库 /.test(claudeRunRow?.textContent ?? ''),
    claudeRunRow?.textContent?.slice(0, 200) ?? 'no run row')
  check('a repository bot file is reported as ignored, with both paths (§4.1/AC12)',
    /仓库里的 Bot 文件已忽略/.test(detailText) && /worktree-demo\/worker-bots\.json/.test(detailText), detailText.slice(0, 600))
  // 1.5.0: the rerun choices are the store's real bot ids, and the bot that already ran this ticket is left out.
  const rerunPick = rootElement.querySelector('#sa-run-run_demo select[aria-label]')
  check('the rerun picker offers the store’s other bots and not the one that ran (§7.6)',
    Boolean(rerunPick) && [...rerunPick.options].some(option => option.value === 'reviewer')
      && ![...rerunPick.options].some(option => option.value === 'generalist'),
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
  check('detail nav keeps every jump (request, automation and the timeline included) in a dedicated cluster', rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length === 7,
  String(rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length))
{
  // jsdom has no layout, so the sticky bar (which appears once the head scrolls under the nav) is forced by stubbing the
  // two rects its measure() reads. The menu used to stay behind in the scrolled-away head: the primary action moved into
  // the sticky bar and verify/CI/publish/retry became unreachable without scrolling back up.
  // The client schedules that measurement on the bare `requestAnimationFrame`; jsdom exposes it on the window, not on the
  // scope the bundle is evaluated in.
  const hadRaf = typeof globalThis.requestAnimationFrame === 'function'
  if (!hadRaf) {
    globalThis.requestAnimationFrame = callback => setTimeout(() => callback(Date.now()), 0)
    globalThis.cancelAnimationFrame = id => clearTimeout(id)
  }
  const headNode = rootElement.querySelector('.sa-page-head')
  const scrollNode = rootElement.querySelector('.sa-scroll')
  const restore = []
  const rectFor = (node, rect) => {
    const original = node.getBoundingClientRect
    restore.push(() => { node.getBoundingClientRect = original })
    node.getBoundingClientRect = () => ({ ...rect, x: rect.left, y: rect.top, toJSON() { return rect } })
  }
  if (headNode && scrollNode) {
    rectFor(headNode, { top: -400, bottom: -40, height: 360, left: 0, right: 900, width: 900 })
    rectFor(scrollNode, { top: 0, bottom: 700, height: 700, left: 0, right: 900, width: 900 })
    scrollNode.dispatchEvent(new window.Event('scroll', { bubbles: false }))
    for (let i = 0; i < 4; i += 1) await sleep(20)
  }
  const bar = rootElement.querySelector('.sa-detail-nav .sa-detail-context-action')
  check('the scrolled-away head hands the ⋯ menu to the sticky bar, not just the primary action',
    Boolean(bar?.querySelector('.sa-menu-trigger')),
    bar?.textContent?.slice(0, 120) ?? 'no sticky action cluster')
  check('the head and the sticky bar never both carry the ⋯ menu',
    rootElement.querySelectorAll('.sa-menu-trigger').length >= 1
    && !(rootElement.querySelector('.sa-page-head .sa-menu-trigger') && bar?.querySelector('.sa-menu-trigger')),
    String(rootElement.querySelectorAll('.sa-menu-trigger').length))
  // Back to the head on screen: measure() ignores a zero-height head, so restoring the real rects alone would leave the
  // bar stuck for every later assertion on the page head.
  if (headNode && scrollNode) {
    const visible = { top: 0, bottom: 360, height: 360, left: 0, right: 900, width: 900 }
    headNode.getBoundingClientRect = () => ({ ...visible, x: 0, y: 0, toJSON() { return visible } })
    scrollNode.dispatchEvent(new window.Event('scroll', { bubbles: false }))
    for (let i = 0; i < 4; i += 1) await sleep(20)
  }
  for (const undo of restore) undo()
  if (!hadRaf) { delete globalThis.requestAnimationFrame; delete globalThis.cancelAnimationFrame }
}
check('long ticket detail offers in-page jump navigation', rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length === 7,
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
// The overflow files live in their own region that is present but `hidden` while collapsed, so aria-expanded and the
// rendered state agree (audit B round two).
const filesMore = () => rootElement.querySelector('#sa-changed-files-more')
const fileRows = () => rootElement.querySelectorAll('#sa-changed-files .sa-file-diff').length
const allFileRows = () => rootElement.querySelectorAll('.sa-changes-side .sa-file-diff').length
check('a long changed-file list starts compact with a show-more control',
  Boolean(filesToggle) && fileRows() === 5 && filesMore()?.hidden === true,
  `rows=${fileRows()} more=${Boolean(filesMore())} hidden=${filesMore()?.hidden}`)
filesToggle?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(300)
check('show more reveals every changed file',
  allFileRows() === 8 && filesMore()?.hidden === false
    && [...rootElement.querySelectorAll('.sa-changes-side button')].some(node => (node.textContent ?? '').trim() === '收起'),
  `rows=${allFileRows()} hidden=${filesMore()?.hidden}`)
const collapseFiles = [...rootElement.querySelectorAll('.sa-changes-side button')].find(node => (node.textContent ?? '').trim() === '收起')
collapseFiles?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(300)
check('the changed-file list collapses again', fileRows() === 5 && filesMore()?.hidden === true,
  `rows=${fileRows()} hidden=${filesMore()?.hidden}`)
// P1 §3.2: every changed file row opens that file's own patch (one on-demand request per click).
const fileDiffButtons = () => [...rootElement.querySelectorAll('.sa-changes-side .sa-file-diff')]
check('every changed file row is a diff entry point', fileDiffButtons().length === 8,
  `rows=${fileDiffButtons().length}`)
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
  // Same shape as the file list: recent events in the always-visible list, the older ones in a region that is
  // `hidden` while collapsed.
  const timelineEvents = () => rootElement.querySelectorAll('.sa-timeline .sa-event').length
  const recentEvents = () => rootElement.querySelectorAll('#sa-timeline-events .sa-event').length
  const moreEvents = () => rootElement.querySelector('#sa-timeline-more')
  const collapsedEvents = recentEvents()
  const expandButton = [...rootElement.querySelectorAll('.sa-main button')].find(node => /展开全部/.test(node.textContent ?? ''))
  check('timeline collapses long histories by default',
    collapsedEvents <= 8 && moreEvents()?.hidden === true && Boolean(expandButton),
    `events=${collapsedEvents} hidden=${moreEvents()?.hidden}`)
  expandButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  check('timeline expands to the full history', timelineEvents() > collapsedEvents && moreEvents()?.hidden === false,
    `after=${timelineEvents()} hidden=${moreEvents()?.hidden}`)
  const collapseButton = [...rootElement.querySelectorAll('.sa-main button')].find(node => (node.textContent ?? '').trim() === '收起')
  collapseButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  check('timeline can collapse again', recentEvents() === collapsedEvents && moreEvents()?.hidden === true,
    `back=${recentEvents()} hidden=${moreEvents()?.hidden}`)
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
// The desk is read from the list route explicitly: the head's first button is not guaranteed to be the back link on a
// detail page, and this check is about what the desk derives, not about the affordance.
if (rootElement.querySelector('#sa-ticket-changes')) {
  window.location.hash = `#sa=${encodeURIComponent(JSON.stringify({ page: 'execution' }))}`
  window.dispatchEvent(new window.HashChangeEvent('hashchange'))
  await sleep(800)
}
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
  // The intake ledger is the page's main body: one record per message, and no second copy of the filtered messages.
  check('source page drops the duplicate filtered-message section', !/被过滤消息/.test(sourceText), sourceText.slice(0, 260))
  check('source page leads with the signal ledger', sourceText.indexOf('原始信号') < sourceText.indexOf('IM 消息源'),
    JSON.stringify({ signals: sourceText.indexOf('原始信号'), im: sourceText.indexOf('IM 消息源') }))
  check('source cards use the two-up grid', rootElement.querySelectorAll('.sa-cards-2').length >= 2,
    String(rootElement.querySelectorAll('.sa-cards-2').length))
  // C-13: one repository's check used to be rendered on every repository card and asked the host for "whatever repo has
  // a UAT url". The clicked card must carry the answer, and no other card may.
  const sourceCards = () => [...rootElement.querySelectorAll('.sa-main .sa-cards-2 .sa-card')]
  // The card to check is whichever execution card actually offers the action (a `manual` repository has no UAT).
  const uatButtonOf = (card) => [...card.querySelectorAll('button')]
    .find(node => (node.textContent ?? '').trim() === '检查 UAT')
  const checkedCard = sourceCards().find(card => { const button = uatButtonOf(card); return Boolean(button) && !button.disabled })
  const checkedRepo = checkedCard
    ? liveRepos.find(repo => (checkedCard.textContent ?? '').includes(repo.gitlab.project || repo.id)) : undefined
  const cardUat = checkedCard ? uatButtonOf(checkedCard) : undefined
  if (!checkedCard || !checkedRepo) skip('the UAT answer lands on the repository that was checked', 'no repository card offers an enabled UAT check')
  else {
    const lastRepo = checkedRepo
    const lastCard = checkedCard
    cardUat.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(500)
    check('the UAT request names the clicked repository', lastUatBody?.repoId === lastRepo.id,
      `${JSON.stringify(lastUatBody)} disabled=${cardUat.disabled} uat=${calls.filter(call => call.includes('uat')).join(',')}`)
    check('the UAT answer lands on the repository that was checked',
      (lastCard.textContent ?? '').includes('299') && sourceCards()
        .filter(card => card !== lastCard).every(card => !(card.textContent ?? '').includes('299')),
      sourceCards().map(card => (card.textContent ?? '').slice(0, 90)).join(' | '))
  }
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
// 手工建单 is an Execution action: Settings no longer carries a second copy of the form, so this group must not offer
// a repository picker at all (the Execution modal check below covers the surviving one).
check('the run group offers no second manual-ticket form',
  !settingsText.includes('手工建单（测试）') && ![...rootElement.querySelectorAll('.sa-main select')]
    .some(select => [...select.options].some(option => option.value === 'ebs')),
  settingsText.slice(0, 400))
// The run timeout is editable (it used to be file-only, so a timed-out Ticket could not be retried with more time).
const timeoutInput = rootElement.querySelector('.sa-main input[aria-label="执行超时"]')
check('run timeout is editable from the run group',
  Boolean(timeoutInput) && timeoutInput.type === 'number' && Number(timeoutInput.max) === 1440,
  timeoutInput ? `${timeoutInput.type} ${timeoutInput.value}/${timeoutInput.min}-${timeoutInput.max}` : 'missing')
clickByText('Worker', '.sa-settings-nav button')
await sleep(800)
const workerText = text()
const workerTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('worker settings patch sends the enablement and routing tables it edits',
  JSON.stringify(settingsPatchOf('worker', { 'executor.workers': { dsh: { enabled: true } }, 'executor.routing': { defaultBackend: 'dsh' } }))
    === JSON.stringify({ 'executor.workers': { dsh: { enabled: true } }, 'executor.routing': { defaultBackend: 'dsh' } }))
// 1.3.0 removed staged execution: the worker group must not grow those three controls back.
check('worker group has no staged-execution controls',
  !/分阶段执行|实现后端|独立验收后端/.test(workerText)
    && !rootElement.querySelector('select[aria-label="实现后端"]')
    && !rootElement.querySelector('select[aria-label="独立验收后端"]'),
  workerText.slice(0, 400))
// 1.4.0 deleted the preset picker, the routing mode and the work-type preference table: one backend choice, no tables
// the operator has to fill in.
check('worker group no longer offers a preset, a routing mode or work-type preferences',
  !/Worker 预设|路由模式|任务类型偏好/.test(workerText)
    && !rootElement.querySelector('input[aria-label="Worker 预设（DSH）"]')
    && !rootElement.querySelector('select[aria-label="路由模式"]'),
  workerText.slice(0, 600))
check('worker group is its own H2 group', workerTitles.length === 1 && workerTitles[0] === 'Worker', JSON.stringify(workerTitles))
check('worker group lists every backend with its own enable switch',
  ['DSH（进程内）', 'Codex CLI（本机）', 'Claude Code CLI（本机）'].every(label => workerText.includes(label))
    && rootElement.querySelectorAll('.sa-main .sa-switch-row').length >= 3,
  String(rootElement.querySelectorAll('.sa-main .sa-switch-row').length))
check('worker group keeps one default backend and no fallback backend',
  workerText.includes('默认后端') && workerText.includes('没有「降级后端」了')
    && !rootElement.querySelector('select[aria-label="降级后端（可选）"]'), workerText.slice(0, 600))
// 1.5.0 deleted the capability matrix and the 降级后端 select: the only hard fact about a backend is whether it can
// take work right now, and that answer lives on the Bot page next to the backend card (§4).
check('worker group carries no capability matrix and no fallback select',
  !workerText.includes('运行后端能力') && !workerText.includes('流式事件')
    && !rootElement.querySelector('.sa-capabilities'), workerText.slice(0, 600))
clickByText('写权限', '.sa-settings-nav button')
await sleep(800)
const writeText = text()
const writeTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('write group is its own H2 group', writeTitles.length === 1 && writeTitles[0] === '写权限', JSON.stringify(writeTitles))
check('write group holds the three executor write permissions',
  writeText.includes('允许推送分支') && writeText.includes('允许回群消息') && writeText.includes('允许合并 MR'), writeText.slice(0, 400))
check('the merge permission is marked as high risk', writeText.includes('高危'), writeText.slice(0, 400))
// 1.5.0 replaced the editable dispatch rules with a read-only 派单 group: it explains how the bot is decided, not how to
// configure it. The two editable facts it points at are the default bot (Bot page) and backend availability (Worker).
clickByText('派单', '.sa-settings-nav button')
await sleep(800)
const dispatchText = text()
const dispatchTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('dispatch group is its own read-only H2 group',
  dispatchTitles.length === 1 && dispatchTitles[0] === '派单'
    && !rootElement.querySelector('.sa-main .sa-savebar'), JSON.stringify({ dispatchTitles }))
check('dispatch group explains candidates, pick, no-model, fallback, danger and explicit choice',
  ['候选：所有 Bot 里', '挑选：一次模型调用', '不调模型', '失败怎么办', '危险行为在哪拦', '两种显式指定']
    .every(fact => dispatchText.includes(fact)), dispatchText.slice(0, 500))
check('dispatch group points at the Bot page and the Worker group instead of editing anything here',
  dispatchText.includes('打开 Bot 页') && dispatchText.includes('在「Bot」页改')
    && dispatchText.includes('后端可用性在「Worker」组看'), dispatchText.slice(0, 500))
check('dispatch group no longer describes probes, rules or capability declarations as editable facts',
  !/分派规则|探针|能力声明可编辑/.test(dispatchText), dispatchText.slice(0, 500))
// Back to 写权限: the U-06 two-step saves below drive that group's switches.
clickByText('写权限', '.sa-settings-nav button')
await sleep(800)

const navLabels = [...rootElement.querySelectorAll('.sa-settings-nav .sa-settings-group')]
  .map(node => (node.textContent ?? '').trim()).filter(Boolean)
check('settings rail separates writable groups from reference groups',
  navLabels.slice(0, 6).join('/') === '来源/评估确认/运行/Worker/写权限/仓库'
    && navLabels.slice(6).join('/') === '评估/派单/提示词'
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
const repoRowCount = rootElement.querySelectorAll('.sa-main .sa-repo-list .sa-repo-row').length
check('repositories group lists repositories as rows, not cards',
  repoRowCount === liveRepos.length && rootElement.querySelectorAll('.sa-main .sa-repo-list .sa-card').length === 0,
  `${repoRowCount}/${liveRepos.length}`)
check('repositories group carries the default repository summary', new RegExp(`${liveRepos.length} 个仓库 · 默认仓库 ${defaultRepoId}`).test(reposText), reposText.slice(0, 200))
check('repositories group shows gates and clone path', reposText.includes('闸门') && reposText.includes('本地路径'), reposText.slice(0, 300))
check('repositories group absorbs the deployment facts',
  reposText.includes('配置文件与路径') && reposText.includes('live.json'), reposText.slice(0, 500))
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
  // The machine payload moved out of the UI for good: the rule table is the evidence, the JSON is not.
  check('eval no longer dumps the raw decision payload', !/原始决定|Raw decision/.test(evalText), evalText.slice(0, 300))
  check('eval ticket short codes open their ticket', rootElement.querySelectorAll('.sa-main .sa-row-meta button.sa-mono.sa-textlink').length >= 1,
    String(rootElement.querySelectorAll('.sa-main .sa-row-meta button.sa-mono.sa-textlink').length))
  check('eval rows identify their thread or ticket', rootElement.querySelectorAll('.sa-main .sa-row-meta .sa-mono').length >= 1,
    String(rootElement.querySelectorAll('.sa-main .sa-row-meta .sa-mono').length))
  check('eval rows show the shadow model opinion', evalText.includes('模型 93%') && evalText.includes('倾向接单'),
    evalText.slice(0, 500))
  // One way in instead of a run-id short link beside a ticket link (ui audit B). The two buttons that used to sit here
  // (查看工单 / 查看运行) opened the same page, so only one remains and it carries the run focus (user report 2026-11-26).
  check('eval rows offer one way into the Ticket they caused',
    evalText.includes('查看工单') && !evalText.includes('查看运行'), evalText.slice(0, 500))
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
    'eval keeps the rule-by-rule fold', 'eval no longer dumps the raw decision payload',
    'eval ticket short codes open their ticket', 'eval rows identify their thread or ticket',
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
// The header labels the whole ledger, so it leads it: it used to sit inside the first group (and under that group's
// title), where it read as a caption for 已结束 alone (review fix 1.1.8).
check('execution column header leads the ledger, above the group titles',
  Boolean(queueHead) && !queueHead.closest('.sa-section')
    && (queueHead.nextElementSibling?.classList.contains('sa-section')
      || queueHead.nextElementSibling?.nextElementSibling?.classList.contains('sa-section')),
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
// The ended history had three reveals (a switch, a 展开已结束 button, and a 查看全部 cap button); the switch is now the
// only include-control and the cap reveal says what it adds (review A, round 1.2.2).
check('the include-ended switch is the only ended reveal',
  /显示已结束/.test(rootElement.querySelector('.sa-main .sa-list-bar')?.textContent ?? '')
  && ![...rootElement.querySelectorAll('.sa-main button')].some(node => /展开已结束|查看全部（/.test(node.textContent ?? '')),
  rootElement.querySelector('.sa-main .sa-list-bar')?.textContent?.slice(0, 120) ?? 'no view bar')
check('manual ticket entry sits in the executor header, not in a row of its own',
  Boolean([...rootElement.querySelectorAll('.sa-main .sa-section-action button')]
    .find(node => (node.textContent ?? '').trim() === '手工建单')), '')
check('view pickers open a menu with the other choice', viewPickers.every(node => node.getAttribute('aria-haspopup') === 'menu'),
  JSON.stringify(viewPickers.map(node => node.getAttribute('aria-haspopup'))))
const doneBadge = [...rootElement.querySelectorAll('.sa-exec-queue .sa-section-title .sa-hint')]
  .map(node => (node.textContent ?? '').trim()).find(label => /已验收/.test(label))
check('done group states its accepted/dismissed split', /已验收.*已忽略/.test(doneBadge ?? ''), String(doneBadge))
// A finished dry run publishes from the primary slot; the rerun it used to lead with stays in the ⋯ menu.
const readyRow = [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')]
  .find(row => (row.textContent ?? '').includes('演示：干跑完成待发布'))
check('the execution row is opened by a button that holds its main column (U-02)',
  Boolean(readyRow?.querySelector('button.sa-row-open > .sa-row-main .sa-row-title')),
  readyRow?.querySelector('.sa-row-open')?.outerHTML?.slice(0, 240) ?? 'no row')
check('the execution queue lists the finished dry run', Boolean(readyRow),
  [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')].map(row => (row.textContent ?? '').slice(0, 32)).join(' | '))
readyRow?.querySelector('.sa-row-open')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const readyPrimary = [...rootElement.querySelectorAll('.sa-page-head-actions .sa-btn-primary')].map(node => (node.textContent ?? '').trim())
check('a finished dry run makes 发布 MR the primary action', readyPrimary.includes('发布 MR'), JSON.stringify(readyPrimary))
// C-14: the detail page is keyed by the Ticket id. Opening another Ticket in place used to reuse the same mounted
// detail, so the previous Ticket's drafts came back on a Ticket they were never written for.
{
  const openRow = async (title) => {
    const row = [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-openable')]
      .find(node => (node.textContent ?? '').includes(title))
    row?.querySelector('.sa-row-open')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(1200)
  }
  const leaveDetail = async () => {
    rootElement.querySelector('.sa-page-head button')?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(1200)
  }
  const draftOf = () => rootElement.querySelector('#sa-ticket-changes .sa-revision-input')
  const draft = draftOf()
  if (!draft) skip('a detail draft does not come back with the previous Ticket', 'the fixture Ticket has no changes form')
  else {
    const propsKey = Object.keys(draft).find(key => key.startsWith('__reactProps$'))
    propsKey ? draft[propsKey].onChange?.({ target: { value: '草稿：只属于 tkt_demo_ready' } }) : undefined
    await sleep(120)
    check('a detail draft is accepted on the current Ticket', (draftOf()?.value ?? '') !== '', draftOf()?.value ?? 'no value')
    await leaveDetail()
    await openRow('演示：正在执行的工单')
    await leaveDetail()
    await openRow('演示：干跑完成待发布')
    const focused = document.activeElement
    check('a route change moves focus to the new page title (U-04)',
      Boolean(focused?.classList?.contains('sa-page-head-title') || focused?.classList?.contains('sa-title')),
      String(focused?.className ?? focused?.tagName ?? 'none'))
    check('a detail page keeps the panel h1 as the only h1 (U-03)',
      rootElement.querySelectorAll('h1').length === 1
        && Boolean(rootElement.querySelector('.sa-head h1.sa-title'))
        && Boolean(rootElement.querySelector('.sa-page-head h2.sa-page-head-title')),
      `h1 count=${rootElement.querySelectorAll('h1').length}`)
    const carried = draftOf()?.value ?? ''
    check('a detail draft does not come back with the previous Ticket', carried === '', JSON.stringify(carried))
  }
}

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
{
  const described = manualModal?.getAttribute('aria-describedby')
  const sentence = described ? rootElement.querySelector(`#${described}`) : null
  check('a dialog announces its consequence sentence (U-01)',
    Boolean(described) && Boolean(sentence) && (sentence.textContent ?? '').trim().length > 0,
    JSON.stringify({ described, sentence: sentence?.textContent?.slice(0, 80) ?? null }))
  check('an open dialog locks the page scroll behind it (U-01)', document.body.style.overflow === 'hidden',
    `overflow=${document.body.style.overflow}`)
}
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
check('closing the last dialog releases the page scroll (U-01)', document.body.style.overflow === '',
  `overflow=${document.body.style.overflow}`)

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
  // The detail is a conversation, not a second ledger: facts and the timeline (each message opens the Ticket it
  // produced). The graded decision ledger lives on the Eval page, which the facts section links to.
  check('thread detail no longer repeats a separate decision section',
    !threadSections.includes('决定') && !threadSections.includes('评估过程') && threadSections.includes('线程信息') &&
      threadSections.includes('消息时间线'), JSON.stringify(threadSections))
  check('thread detail links to the Eval ledger instead of copying it', /查看评估记录/.test(triggerText), triggerText.slice(0, 400))
  check('thread detail keeps the ticket jump in the evaluation flow', /打开工单/.test(triggerText), triggerText.slice(0, 400))
  // The produced-Tickets list said the same thing as the messages, so the jump moved onto the message row itself.
  check('the ticket jump sits on the timeline row, not in a second list',
    !threadSections.includes('产生的工单') && Boolean(rootElement.querySelector('.sa-event-foot .sa-event-actions button')),
    JSON.stringify(threadSections))
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

// Bots moved out of Settings into their own tab: the tab order is the promise that it sits just left of 执行.
const tabLabels = [...rootElement.querySelectorAll('.sa-topbar [role="tab"]')].map(node => (node.textContent ?? '').trim())
check('the Bot tab sits immediately left of the execution tab', tabLabels.indexOf('Bot') === tabLabels.indexOf('执行') - 1, tabLabels.join('|'))
clickByText('Bot', '.sa-topbar [role="tab"]')
await sleep(700)
const botsTabText = rootElement.querySelector('.sa-main')?.textContent ?? ''
// 1.5.0 renamed the sections into real headings (Bot / 后端与派单): the page is now the store line, the list, one
// backend card per CLI and the pending section — this walkthrough only proves the surface is mounted, since the fetch
// stub answers every engine endpoint with `{}` and the detailed contract is pinned by the bots-group block above.
check('the Bot tab carries the v3 bot surface: store line, built-ins, backend cards, new-bot action',
  /Bot 文件/.test(botsTabText) && /内置 Bot/.test(botsTabText) && /后端与派单/.test(botsTabText)
    && /新建 Bot/.test(botsTabText) && /没有证据|派单可用/.test(botsTabText)
    && !/Bot 列表|后端核验状态|运行后端能力/.test(botsTabText), botsTabText.slice(0, 240))
check('Settings no longer carries a Bot group', ![...rootElement.querySelectorAll('.sa-settings-nav button')]
  .some(node => (node.textContent ?? '').trim() === 'Bot'))
// Keyboard shortcut: Alt+4 jumps to Eval, Alt+1 returns to the desk.
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '4', altKey: true, bubbles: true }))
await sleep(700)
const shortcutTab = [...rootElement.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim()
check('Alt+4 switches to the Eval tab', shortcutTab === '评估', String(shortcutTab))
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }))
await sleep(700)
const shortcutBack = [...rootElement.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim()
check('Alt+1 returns to the Overview tab', shortcutBack === '概览', String(shortcutBack))

// Sticky chrome: header + eight tabs are outside the body scroller, and a route change starts at the top.
check('header and eight tabs live in the fixed topbar', rootElement.querySelectorAll('.sa-topbar [role="tab"]').length === 8
  && Boolean(rootElement.querySelector('.sa-topbar .sa-head')), String(rootElement.querySelectorAll('.sa-topbar [role="tab"]').length))
check('page body is the only scrolling container', Boolean(rootElement.querySelector('.sa-scroll > .sa-main')),
  'missing .sa-scroll > .sa-main')
const scroller = rootElement.querySelector('.sa-scroll')
scroller.scrollTop = 240
clickByText('来源')
await sleep(900)
check('route change resets the body scroll', scroller.scrollTop === 0, String(scroller.scrollTop))
const sourceFilterInputs = [...rootElement.querySelectorAll('.sa-main .sa-filters input')]
// An empty ledger shows no filter row: four inputs and six chips over zero rows read as a broken page. Once anything
// arrived (or a filter is already set) the full row is back, with the repository, reason and date fields the page
// promises.
const emptySourceLedger = /最近没有原始信号/.test(rootElement.querySelector('.sa-main')?.textContent ?? '')
check('source offers repository, reason and date-range filters',
  emptySourceLedger
    ? sourceFilterInputs.length === 0
    : sourceFilterInputs.length >= 4 && sourceFilterInputs.filter(input => input.getAttribute('type') === 'date').length === 2,
  JSON.stringify({ emptyLedger: emptySourceLedger,
    inputs: sourceFilterInputs.map(input => input.getAttribute('aria-label') ?? input.getAttribute('type')) }))
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

// 1.1.13: a Claude Code worker's conversation is a page of its own — the sessions tab lists the CLI sessions and puts
// the resumed terminal beside them. jsdom has no PTY, so this pins the list, the pick and the open control.
console.log('STEP sessions')
check('a Claude Code session list keeps one row per session, not one per run',
  JSON.stringify(claudeSessions([{ id: 'a', worker: { backend: 'claude', sessionId: 'x' } },
    { id: 'b', worker: { backend: 'claude', sessionId: 'x' } },
    { id: 'c', worker: { backend: 'codex', sessionId: 'y' } }]).map(row => row.runId)) === '["a"]')
check('only a UUID-shaped session id is resumed (a synthesized id would match a session title)',
  JSON.stringify(claudeSessions([{ id: 'a', worker: { backend: 'claude', sessionId: 'worker-deadbeef' } },
    { id: 'b', worker: { backend: 'claude', sessionId: '11111111-2222-3333-4444-555555555555' } }])
    .map(row => row.resumable)) === '[false,true]')
pushRoot.unmount()
window.sessionStorage.setItem('superagent-panel/route',
  JSON.stringify({ route: { page: 'sessions', id: '11111111-2222-3333-4444-555555555555' }, stack: [] }))
const sessionsRoot = ReactDOM.createRoot(rootElement)
sessionsRoot.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
const sessionRows = [...rootElement.querySelectorAll('.sa-session-row')]
check('the sessions tab lists the Claude Code worker session',
  sessionRows.length === 1
    && (rootElement.querySelector('.sa-sessions-pane')?.getAttribute('data-session') ?? '')
      === '11111111-2222-3333-4444-555555555555',
  `${sessionRows.length} row(s) · ${rootElement.querySelector('.sa-sessions-pane')?.getAttribute('data-session') ?? 'no selection'}`)
check('a picked session is a conversation: the same session, a chat box, and the way into the TUI',
  Boolean(rootElement.querySelector('.sa-chat')) && Boolean(rootElement.querySelector('.sa-chat-text'))
    && Boolean(rootElement.querySelector('.sa-chat-send')) && Boolean(rootElement.querySelector('.sa-session-terminal')),
  rootElement.querySelector('.sa-sessions-pane')?.textContent?.slice(0, 200) ?? 'no pane')
check('the chat says it continues the CLI session instead of starting over',
  Boolean(rootElement.querySelector('.sa-chat-start')), rootElement.querySelector('.sa-chat-start')?.textContent ?? 'missing')
check('a reply states how many steps it took, and a failed turn states why',
  chatSummary({ toolCalls: 2, ms: 13000 }, (key, values) => localText(t, key, values)) === '完成 2 步 · 13s'
    && chatSummary({ toolCalls: 0, ms: 4200 }, (key, values) => localText(t, key, values)) === '完成 · 4s'
    && chatSummary({ error: 'claude exited with code 1', ms: 900 }, (key, values) => localText(t, key, values))
      === '这次没跑完：claude exited with code 1'
    // A turn read back from Claude Code's history has no duration: report its steps, never a made-up "1s".
    && chatSummary({ toolCalls: 3 }, (key, values) => localText(t, key, values)) === '3 步'
    && chatSummary({ toolCalls: 0 }, (key, values) => localText(t, key, values)) === '',
  chatSummary({ toolCalls: 2, ms: 13000 }, (key, values) => localText(t, key, values)))
check('the sessions tab sits between execution and settings',
  [...rootElement.querySelectorAll('[role="tab"]')].map(node => node.textContent).join(',')
    === '概览,来源,触发,评估,Bot,执行,会话,设置',
  [...rootElement.querySelectorAll('[role="tab"]')].map(node => node.textContent).join(','))
check('the sessions page no longer floats a terminal over the ticket',
  rootElement.querySelectorAll('.sa-terminal').length === 0)
sessionsRoot.unmount()

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
  const unknownFailure = failureLabel(t, 'TypeError: something exploded deep inside')
  check('an unknown error leads with a Chinese conclusion (U-11)',
    unknownFailure.startsWith('其他原因'), JSON.stringify({ unknownFailure }))

  // U-09: the run trigger is a state, not a button, and every value the host emits has a Chinese label.
  const triggerLabels = ['manual', 'auto', 'retry', 'resume'].map(trigger => runTriggerLabel(t, { trigger }))
  check('every run trigger maps to a Chinese label, and resume reads as a state (U-09)',
    triggerLabels.join('/') === '手动/自动/重试/恢复触发', JSON.stringify(triggerLabels))

  // U-10: the remote address is named after the host (a GitHub repository is not a "GitLab 地址"), and a repository
  // without a token says what still works instead of implying it is broken.
  // The rows moved to the Settings → Repositories card when the Source page stopped repeating configuration.
  const githubRows = repoFactRows(t,
    { baseUrl: 'https://github.com/org/app', project: 'org/app', repo: '/src/app', tokenConfigured: false })
  const gitlabRows = repoFactRows(t,
    { baseUrl: 'https://gitlab.example.com', project: 'grp/app', repo: '/src/app', tokenConfigured: true })
  const rowLabelOf = (rows, label) => rows.some(row => row[0] === label)
  check('the remote address is named after its host and a token-less repository says what still works (U-10)',
    rowLabelOf(githubRows, 'GitHub 地址') && rowLabelOf(gitlabRows, 'GitLab 地址')
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

  // P3: notify(text, 'error') used to drop the second argument, so a failed save and a saved save looked identical.
  const toastHost = document.createElement('div')
  document.body.appendChild(toastHost)
  const toastRoot = ReactDOM.createRoot(toastHost)
  const Notifier = ({ tone }) => {
    const { notify } = usePanel()
    React.useEffect(() => { notify('保存失败：服务不可用', tone) }, [tone])
    return null
  }
  toastRoot.render(React.createElement(PanelProvider,
    { t, call: async () => ({}), navigate() {}, back() {}, openSession: async () => {} },
    React.createElement(Notifier, { tone: 'error' })))
  await sleep(120)
  const failedToast = toastHost.querySelector('.sa-toast')
  check('a failed action is announced as an alert, not as a status line (P3)',
    failedToast?.className === 'sa-toast sa-toast-error' && failedToast?.getAttribute('role') === 'alert',
    `${failedToast?.className} role=${failedToast?.getAttribute('role')}`)
  toastRoot.unmount()
  toastHost.remove()
  check('the error toast has its own rule so the colour is not a class with no style (P3)',
    /\.sa-toast-error\s*\{[^}]*--sa-danger-text/.test(PANEL_CSS), PANEL_CSS.includes('.sa-toast-error'))

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
      // A delivery that failed after the push is exactly what a person has to publish again.
      && publishableStatusOf({ status: 'ci-failed' }) && publishableStatusOf({ status: 'deploy-failed' })
      && publishableStatusOf({ status: 'closed' })
      && !publishableStatusOf({ status: 'ci-pending' }) && !publishableStatusOf({}),
    JSON.stringify(['ready', 'failed', 'pushed', 'ci-failed', 'deploy-failed', 'closed', 'queued', 'ci-pending',
      undefined].map(status => [status ?? 'none', publishableStatusOf({ status })])))

  // A failed delivery's row offers re-delivery: publish (gates, commit, push, fresh MR) is the whole recovery, so the
  // row must not send the operator to a diagnosis page with no way out.
  check('a failed delivery re-delivers from the row (redeliver -> publish)',
    primaryActionOf({ status: 'deploy-failed', links: {} }, ticketStatus({ status: 'deploy-failed' }))?.kind === 'publish'
      && primaryActionOf({ status: 'ci-failed', links: {} }, ticketStatus({ status: 'ci-failed' }))?.kind === 'publish',
    JSON.stringify(['deploy-failed', 'ci-failed'].map(status =>
      [status, primaryActionOf({ status, links: {} }, ticketStatus({ status }))?.labelKey])))

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

  // §13.2/AC-B1: the Bot page keeps the two built-ins on top as read-only rows, shows every backend's *dispatch*
  // availability — available / unverified / checking / missing, each with its reason and CLI path, never a capability
  // matrix — and one bot's recent performance. Saving sends the v3 fields only; the host's error code is shown in
  // place, next to the sentence, never swallowed.
  {
    const BOT_KEYS = ['id', 'name', 'description', 'whenToUse', 'backend', 'model', 'preset', 'skills', 'prompt', 'budget']
    const BUILTIN_IDS = ['generalist', 'reviewer']
    const bot = (id, name, extra = {}) => ({ id, name, description: '', whenToUse: '通用改动', backend: 'dsh', ...extra })
    const stored = [
      bot('generalist', '通用', { description: '默认 Bot，覆盖面最广', whenToUse: '没有更合适的 Bot 时兜底' }),
      bot('reviewer', '审阅者', { description: '只看不改', whenToUse: '只需要评审结论的工单' }),
      bot('mine', '我的 Bot', {
        description: '只做最小改动', whenToUse: '小修小补的验收流程改动', backend: 'claude',
        preset: 'default', model: { provider: 'anthropic', model: 'claude-sonnet' },
        skills: { prefer: ['ponytail'], policy: 'prompt' }, prompt: { role: '只做最小改动' },
        budget: { timeoutMs: 600000, maxIdleMs: 300000, maxRepairs: 2 },
      }),
    ]
    // No backend CLI exists in CI, so availability is injected the way the host reports it rather than probed: dsh is
    // ready, claude has no smoke evidence, codex has no CLI at all. `checking` gets its own remount below — that is
    // the state right after a CLI upgrade, when an old smoke row no longer proves anything.
    const backendsOf = dshState => ({
      dsh: { state: dshState, reason: dshState === 'available' ? '预设解析成功' : '版本变了，复核期间不派单',
        ...(dshState === 'available' ? { verifiedAt: nowIso } : {}) },
      claude: { state: 'unverified', reason: '没有冒烟证据', cliPath: '/usr/local/bin/claude' },
      codex: { state: 'missing', reason: 'CLI 不在', cliPath: '/opt/codex' },
    })
    const store = dshState => ({ file: join(stateDir, 'worker-bots.json'), exists: true, builtin: false, version: 3,
      bots: stored, backends: backendsOf(dshState), enabledBackends: ['dsh'] })
    // 最近表现 comes from the runs each id actually executed; a Bot with no runs must say so instead of showing zeros.
    const stats = {
      bots: { mine: { runs: 4, passed: 3, passRate: 0.75, avgRepairs: 0.5, gatePassRate: 1, medianMs: 65000,
        lastAt: nowIso } },
      pending: [{ id: 'adhoc:9f2c', count: 3, name: '临时冒烟', description: '1.4 时代现拉的冒烟 Bot',
        whenToUse: '跑冒烟测试', backend: 'dsh', role: '只跑冒烟，不改代码' }],
      generatedAt: nowIso,
    }
    // 谁会把活派给它 reads live.json (repos[].bot and executor.bot), not the bot itself: a Bot never declares its own
    // claimants, which is why the detail pane is the only place that answer can come from.
    const config = { executor: { bot: 'generalist' },
      repos: [{ id: primaryRepoId, bot: 'mine' }, { id: 'repo-other', bot: 'generalist' }] }
    // §5.4: the advanced editor offers what the host says it can run — named presets, provider → model rows, and the
    // discovered skills. The stub mirrors a real DSH catalogue; the CLI backends expose nothing, which is the point.
    const catalog = {
      dsh: {
        presets: ['standard', 'minimal'],
        providers: [
          { provider: 'deepseek', name: 'DeepSeek', models: [
            { id: 'deepseek-v4', name: 'DeepSeek V4' }, { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] },
          { provider: 'zai', name: 'Z.ai', models: [{ id: 'glm-4.7', name: 'GLM-4.7' }] },
        ],
        skills: [{ name: 'ponytail', description: '最简解法' }, { name: 'review', description: '评审' }],
      },
      claude: { presets: [], providers: [], skills: [] },
      codex: { presets: [], providers: [], skills: [] },
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = ReactDOM.createRoot(host)
    const lists = []
    const panel = { t, call: async () => ({}), navigate() {}, notify() {}, back() {}, openSession() {}, backLabel: '' }
    const actions = {
      bots: async () => store('available'),
      botStats: async () => stats,
      botCatalog: async () => catalog,
      config: async () => config,
      saveBots: async list => {
        lists.push(list)
        // Mirrors the host: a built-in id in the payload is refused wholesale (it used to come from the display list).
        const builtinIds = list.filter(item => BUILTIN_IDS.includes(item.id)).map(item => item.id)
        if (builtinIds.length) {
          throw new ApiError(`内置 Bot 不可编辑：${builtinIds.join('；')}`, 400,
            { code: 'BOT_SCHEMA_INVALID', problems: builtinIds.map(id => `内置 Bot 不可编辑：${id}`) })
        }
        // A pasted paragraph over the v3 limit is a schema error now, not an "unverified backend": backends are a
        // runtime fact and no longer gate a save.
        if (list.some(item => String(item.whenToUse ?? '').length > 300)) {
          throw new ApiError('什么时候派给它不超过 300 字', 400,
            { code: 'BOT_SCHEMA_INVALID', problems: ['whenToUse 超过 300 字'] })
        }
        return { ...store('available'), bots: list }
      },
      verifyBotBackend: async () => ({}),
    }
    const renderBots = nextActions => root.render(React.createElement(Panel.Provider, { value: panel },
      React.createElement(PanelState.Provider,
        { value: { data: fixtures.status, error: undefined, reload: async () => {}, actions: nextActions } },
        React.createElement(BotsCard))))
    renderBots(actions)
    await sleep(180)
    const botsText = () => host.textContent ?? ''
    const detailPane = () => host.querySelector('.sa-bots-detail')
    const editorEl = () => host.querySelector('.sa-bots-editor')
    const editorText = () => editorEl()?.textContent ?? ''
    const rowOf = name => [...host.querySelectorAll('.sa-bot-row')]
      .find(node => (node.textContent ?? '').includes(name))
    const backendRow = id => [...host.querySelectorAll('.sa-row')]
      .find(row => (row.querySelector('.sa-row-title')?.textContent ?? '').startsWith(id))
    const openRow = async name => {
      rowOf(name)?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await sleep(160)
    }
    const clickIn = async (scope, label, delay = 160) => {
      [...(scope?.querySelectorAll('button') ?? [])]
        .find(node => (node.textContent ?? '').trim() === label)
        ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      await sleep(delay)
    }
    const setValue = (element, value) => {
      const key = element ? Object.keys(element).find(name => name.startsWith('__reactProps$')) : undefined
      if (key) element[key].onChange?.({ target: { value } })
    }
    check('the bots group lists the store file and the saved bots',
      /Bot 文件/.test(botsText()) && /worker-bots\.json/.test(botsText())
        && /通用/.test(botsText()) && /我的 Bot/.test(botsText()), botsText().slice(0, 240))
    // A built-in is a fixed row: it opens read-only, offers copy and duplicate, and never grows edit/delete controls.
    check('a built-in Bot opens read-only and offers copy but not edit or delete (§4.5/§13.2)',
      /内置/.test(detailPane()?.querySelector('.sa-tag')?.textContent ?? '')
        && /复制为 JSON/.test(detailPane()?.textContent ?? '') && /另存为副本/.test(detailPane()?.textContent ?? '')
        && !/删除/.test(detailPane()?.textContent ?? '')
        && [...(detailPane()?.querySelectorAll('button') ?? [])].every(node => (node.textContent ?? '').trim() !== '编辑'),
      detailPane()?.textContent?.slice(0, 200) ?? 'no detail pane')
    // The only hard fact about a backend is whether it can take work right now; three of the four states are "skip",
    // each with the reason the operator has to act on (AC-B1).
    check('only an available backend reads as ready, and the others say why they are skipped (AC-B1)',
      /派单可用/.test(backendRow('dsh')?.textContent ?? '')
        && /没有冒烟证据/.test(backendRow('claude')?.textContent ?? '')
        && /CLI 不在/.test(backendRow('codex')?.textContent ?? ''),
      [backendRow('dsh'), backendRow('claude'), backendRow('codex')]
        .map(row => row?.textContent?.slice(0, 80) ?? 'missing').join(' | '))
    check('an unavailable backend names its CLI path and offers 核验',
      /\/usr\/local\/bin\/claude/.test(backendRow('claude')?.textContent ?? '')
        && /CLI：\/opt\/codex/.test(backendRow('codex')?.textContent ?? '')
        && [...(backendRow('codex')?.querySelectorAll('button') ?? [])]
          .some(node => (node.textContent ?? '').trim() === '核验'),
      backendRow('codex')?.textContent?.slice(0, 200) ?? 'no codex row')
    check('the Bot page carries no capability matrix',
      !host.querySelector('.sa-capabilities') && !/运行后端能力|能力：edit/.test(botsText()), botsText().slice(0, 300))
    // The list identifies a Bot; the right pane owns its tags and actions, so none of them are printed twice.
    const firstRow = host.querySelector('.sa-bot-row')
    check('the store list identifies a Bot without repeating its tag row',
      /通用/.test(firstRow?.textContent ?? '') && /generalist/.test(firstRow?.textContent ?? '')
        && !/内置/.test(firstRow?.textContent ?? '') && !firstRow?.querySelector('button'),
      firstRow?.textContent?.slice(0, 120) ?? 'no row')
    await openRow('我的 Bot')
    check('picking a Bot swaps the right pane to that Bot’s declarations (§5)',
      /只做最小改动/.test(detailPane()?.textContent ?? '') && /小修小补/.test(detailPane()?.textContent ?? '')
        && /预设/.test(detailPane()?.textContent ?? '') && /default/.test(detailPane()?.textContent ?? '')
        && /anthropic · claude-sonnet/.test(detailPane()?.textContent ?? ''),
      detailPane()?.textContent?.slice(0, 300) ?? 'no detail pane')
    // Preset, model, skills and budget are inherited from 设置 → 运行: the pane reports them, an input would duplicate a
    // setting that has exactly one home.
    check('the detail pane reports the inherited budget and offers no input for it',
      /预算（只读，继承自设置）/.test(detailPane()?.textContent ?? '') && /跟随设置/.test(detailPane()?.textContent ?? '')
        && detailPane()?.querySelectorAll('input, select, textarea').length === 0,
      detailPane()?.textContent?.slice(0, 300) ?? 'no detail pane')
    check('the detail pane says who sends this Bot work',
      /仓库指定：/.test(detailPane()?.textContent ?? '') && (detailPane()?.textContent ?? '').includes(primaryRepoId)
        && /工单手动指定/.test(detailPane()?.textContent ?? ''),
      detailPane()?.textContent?.slice(0, 400) ?? 'no detail pane')
    check('recent performance is read from real runs',
      /最近 4 单/.test(detailPane()?.textContent ?? '') && /75%/.test(detailPane()?.textContent ?? '')
        && /100%/.test(detailPane()?.textContent ?? '') && /1 分/.test(detailPane()?.textContent ?? ''),
      detailPane()?.textContent?.slice(0, 400) ?? 'no detail pane')
    // An ad-hoc id that ran three times is worth turning into a real Bot; clicking it prefills the editor instead of
    // saving a hidden `adhoc:` id that the next run would still not find.
    check('an ad-hoc bot that ran three times is listed under 待沉淀 (§5.6)',
      /待沉淀/.test(botsText()) && /adhoc:9f2c/.test(botsText()) && /临时冒烟/.test(botsText())
        && /跑过 3 次/.test(botsText()), botsText().slice(-500))
    const pendingRow = [...host.querySelectorAll('.sa-row')].find(row => /adhoc:9f2c/.test(row.textContent ?? ''))
    await clickIn(pendingRow, '编辑')
    check('clicking a pending bot prefills the new-Bot editor instead of saving a hidden id (§5.6)',
      // The pane title (新建 Bot) sits outside `.sa-bots-editor`, so the button label is what identifies create mode.
      /创建/.test(editorText())
        && [...(editorEl()?.querySelectorAll('input') ?? [])].some(input => input.value === '临时冒烟')
        && [...(editorEl()?.querySelectorAll('textarea') ?? [])].some(input => input.value === '跑冒烟测试'),
      editorText().slice(0, 240) || 'no editor')
    await clickIn(editorEl(), '取消')
    await openRow('我的 Bot')
    await clickIn(detailPane(), '编辑')
    const editorControls = () => [...host.querySelectorAll(
      '.sa-bots-editor input:not([type="checkbox"]), .sa-bots-editor select, .sa-bots-editor textarea')]
    // Five questions only: who it is, one line, when to send it work, which backend, and how it behaves. Preset/model/
    // skills live behind the advanced row; the capability switches, tools and budget inputs of the old editor are gone.
    // NOTE: BotsCard passes the 高级设置 label as DisclosureRow *children* instead of `title`, so the collapsed row
    // renders without a visible label (reported as a UI bug) — this pins the structure, not the missing text.
    const advancedRow = () => host.querySelector('.sa-bots-editor .sa-disclosure-row')
    check('the bot editor is five human fields plus a collapsed advanced row (§5)',
      /名称/.test(editorText()) && /一句话说明/.test(editorText()) && /什么时候派给它/.test(editorText())
        && /角色提示词/.test(editorText())
        && editorControls().length === 5
        && host.querySelectorAll('.sa-bots-editor input[type="checkbox"]').length === 0
        && host.querySelectorAll('.sa-bots-editor .sa-field-grid').length === 1
        && advancedRow()?.getAttribute('aria-expanded') === 'false',
      `${editorControls().length} controls :: ${editorText().slice(0, 240)}`)
    check('the editor says what is actually inherited instead of naming a settings page that lacks it',
      /DSH 的预设与 Skill 跟随宿主默认/.test(editorText()) && /设置 → Worker/.test(editorText())
        && !/设置 → 运行/.test(editorText()), editorText().slice(-220))
    host.querySelector('.sa-bots-editor .sa-disclosure-row')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(140)
    // This Bot runs on Claude, so the preset select is greyed out and says why; model stays a free-text CLI id.
    // The backend select comes first; the preset is the greyed one for a CLI bot.
    const presetSelect = () => [...host.querySelectorAll('.sa-bots-editor select')].find(select => select.disabled)
    check('opening 高级设置 reveals the overrides without switching to a different editor',
      host.querySelectorAll('.sa-bots-editor .sa-field-grid').length === 2 && editorControls().length === 9
        && /偏好 Skill/.test(editorText()) && /Skill 策略/.test(editorText()),
      `${editorControls().length} controls`)
    check('a CLI backend greys out the preset and keeps a free-text model id (§5.4)',
      presetSelect()?.disabled === true && /预设只有 DSH 后端有/.test(editorText())
        && host.querySelectorAll('.sa-bots-editor input[type="checkbox"]').length === 0,
      `${presetSelect()?.disabled} :: ${editorText().slice(-200)}`)
    // The DOM maxLength stops typing, not a paste from a script; the host is the authority and its code must land on
    // screen verbatim (§13.2).
    setValue(host.querySelector('.sa-bots-editor textarea[aria-label="什么时候派给它"]'), '长'.repeat(301))
    await sleep(120)
    await clickIn(editorEl(), '保存', 180)
    check('a rejected save shows the host error code in place (§13.2)',
      /BOT_SCHEMA_INVALID/.test(editorText()) && /300 字/.test(editorText()), editorText().slice(-300))
    const afterReject = lists.at(-1) ?? []
    const legacy = afterReject.find(item => item.id === 'mine')
    // 1.5.0 dropped requires/tools/stages/capabilities from the contract: a save must not carry fields the host would
    // drop anyway, and must keep the advanced overrides the editor still exposes. NOTE: the five-field editor has no
    // budget control and formToBot never emits `budget`, so editing a 1.4 Bot silently deletes a stored override
    // (reported as a UI bug) — the assertions below cover what the editor does own.
    check('a save sends only the v3 fields and keeps the advanced overrides',
      legacy !== undefined && Object.keys(legacy).every(key => BOT_KEYS.includes(key))
        && legacy.preset === 'default'
        && legacy.model?.provider === 'anthropic' && legacy.skills?.prefer?.[0] === 'ponytail'
        && legacy.prompt?.role === '只做最小改动',
      JSON.stringify({ keys: Object.keys(legacy ?? {}), model: legacy?.model, preset: legacy?.preset }).slice(0, 260))
    check('a save sends no host-added or retired keys (§4.2)',
      afterReject.every(item => !('capabilities' in item) && !('environment' in item)
        && !('requires' in item) && !('tools' in item) && !('stages' in item) && !('ruleWarnings' in item)),
      JSON.stringify(afterReject.map(item => Object.keys(item))).slice(0, 260))
    check('a save never sends a built-in Bot back to the host (1.2.5)',
      afterReject.every(item => !BUILTIN_IDS.includes(item.id)),
      JSON.stringify(afterReject.map(item => item.id)).slice(0, 200))
    await clickIn(editorEl(), '取消')
    await openRow('我的 Bot')
    await clickIn(detailPane(), '编辑')
    // Renaming edits the row it opened: the id is derived (never typed), so the store must still hold exactly one Bot.
    const renameInput = [...host.querySelectorAll('.sa-bots-editor input')].find(node => node.value === '我的 Bot')
    if (!renameInput) skip('renaming a Bot replaces it instead of adding a second one', 'the name input was not found')
    else {
      setValue(renameInput, '我的 Bot 2')
      await sleep(120)
      await clickIn(editorEl(), '保存', 180)
      const renamed = lists.at(-1) ?? []
      check('renaming a Bot replaces it instead of adding a second one (P2)',
        renamed.some(item => item.id === 'mine' && item.name === '我的 Bot 2')
          && renamed.filter(item => item.id === 'mine').length === 1
          && !renamed.some(item => BUILTIN_IDS.includes(item.id)),
        JSON.stringify(renamed.map(item => [item.id, item.name])))
    }
    // Remount with dsh in `checking`: after a CLI upgrade the old smoke row proves nothing, so the backend is skipped
    // until 核验 runs again — never quietly treated as ready.
    root.unmount()
    const checkingRoot = ReactDOM.createRoot(host)
    checkingRoot.render(React.createElement(Panel.Provider, { value: panel },
      React.createElement(PanelState.Provider,
        { value: { data: fixtures.status, error: undefined, reload: async () => {},
          actions: { ...actions, bots: async () => store('checking') } } },
        React.createElement(BotsCard))))
    await sleep(180)
    check('a backend whose CLI version changed is skipped while it is re-checked (AC-B1)',
      /版本变了，复核期间不派单/.test(botsText()) && !/派单可用/.test(botsText()),
      backendRow('dsh')?.textContent?.slice(0, 160) ?? 'no dsh row')
    // Create a Bot end to end: the draw is derived from the name, and the payload carries the v3 fields only — this is
    // the path that used to fail against the real host because it still carried the three built-ins (1.2.5).
    await clickIn(host, '新建 Bot')
    check('creating a Bot asks only for the five fields, not a capability matrix (§5)',
      /创建/.test(editorText()) && editorControls().length === 5
        && host.querySelectorAll('.sa-bots-editor input[type="checkbox"]').length === 0,
      `${editorControls().length} controls :: ${editorText().slice(0, 200)}`)
    // A new Bot defaults to DSH, so the advanced section now offers the host catalogue: a preset picker, a
    // provider → model pair of selects, and the discovered skills as checkboxes.
    host.querySelector('.sa-bots-editor .sa-disclosure-row')
      ?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await sleep(140)
    const advancedSelects = () => [...host.querySelectorAll('.sa-bots-editor select')]
    const skillBoxes = () => [...host.querySelectorAll('.sa-bots-editor input[type="checkbox"]')]
    // Selects, in DOM order: backend, preset, provider, model, skill policy. The model select stays disabled until a
    // provider is chosen, which is what makes a provider/model pair impossible to half-fill.
    check('a DSH bot picks its preset and model from the host catalogue (§5.4)',
      advancedSelects().length === 5 && advancedSelects()[1].disabled === false
        && advancedSelects()[2].options.length === 3 && advancedSelects()[3].disabled === true
        && skillBoxes().length === 2,
      `${advancedSelects().length} selects, ${skillBoxes().length} skills :: ${editorText().slice(-240)}`)
    setValue(advancedSelects()[2], 'deepseek')
    await sleep(120)
    check('choosing a provider narrows the model list to that provider',
      advancedSelects()[3].disabled === false
        && [...advancedSelects()[3].options].some(option => option.textContent === 'DeepSeek V4 Pro'),
      [...(advancedSelects()[3]?.options ?? [])].map(option => option.textContent).join('|'))
    setValue(advancedSelects()[3], 'deepseek-v4-pro')
    await sleep(120)
    skillBoxes()[0]?.click()
    await sleep(120)
    setValue([...host.querySelectorAll('.sa-bots-editor input')].find(input => input.maxLength === 40), '探针 Bot')
    setValue(host.querySelector('.sa-bots-editor textarea[aria-label="什么时候派给它"]'), '只跑冒烟测试')
    await sleep(120)
    await clickIn(editorEl(), '创建', 200)
    const created = lists.at(-1) ?? []
    const minted = created.find(item => item.name === '探针 Bot')
    check('creating a Bot sends a v3 Bot with a derived id and no built-ins (1.2.5)',
      Boolean(minted) && /^[a-z0-9-]{2,32}$/.test(String(minted?.id ?? ''))
        && minted?.whenToUse === '只跑冒烟测试'
        && Object.keys(minted ?? {}).every(key => BOT_KEYS.includes(key))
        && !created.some(item => BUILTIN_IDS.includes(item.id)),
      JSON.stringify(created.map(item => [item.id, item.name])).slice(0, 240))
    check('a catalogue pick reaches the save as a real provider/model pair plus the chosen skill (§5.4)',
      minted?.model?.provider === 'deepseek' && minted?.model?.model === 'deepseek-v4-pro'
        && Array.isArray(minted?.skills?.prefer) && minted.skills.prefer.includes('ponytail'),
      JSON.stringify({ model: minted?.model, skills: minted?.skills }))
    checkingRoot.unmount()
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

// ---- batch 3 (U-01…U-06): the contract the checks above cannot see in a DOM diff -------------------------------
{
  // U-02: DESIGN.md §Rows forbids a stretched ::after hit area; the row's own button carries the main column instead.
  check('no stretched row overlay is left in the stylesheet (U-02)',
    !/\.sa-open::after/.test(PANEL_CSS) && !/\.sa-open:focus-visible\s*\{[^}]*outline:\s*none/.test(PANEL_CSS)
      && /\.sa-row-open\s*\{[^}]*align-items:\s*stretch/.test(PANEL_CSS),
    'sa-open::after / focus outline:none / align-items still shipped')
  // U-05: brand colour is the tab underline's alone — the switch and the settings rail use a neutral active fill.
  const switchRule = PANEL_CSS.match(/\.sa-switch-input:checked \+ \.sa-switch-track \{[^}]*\}/)?.[0] ?? ''
  const railRule = PANEL_CSS.match(/\.sa-settings-nav \.sa-settings-group\[aria-current='true'\]\s*\{[^}]*\}/)?.[0] ?? ''
  check('the brand colour only marks the current tab (U-05)',
    Boolean(switchRule) && Boolean(railRule) && !/brand-primary/.test(switchRule) && !/brand-primary/.test(railRule),
    JSON.stringify({ switchRule, railRule }))
  check('disabled controls share one opacity (U-06)',
    !/opacity:\s*0\.(55|72)/.test(PANEL_CSS) && /\.sa-btn:disabled \{[^}]*opacity: 0\.4/.test(PANEL_CSS),
    'more than one disabled opacity still shipped')
  check('the signal disclosure trigger reads as a control (U-06)',
    /\.sa-signal-toggle \{[^}]*cursor: pointer/.test(PANEL_CSS) && /\.sa-signal-toggle:focus-visible/.test(PANEL_CSS),
    'no cursor/focus ring for .sa-signal-toggle')
  check('the patch body keeps the 12px mono floor (U-06)',
    /\.sa-diff pre \{[^}]*--sa-fs-meta/.test(PANEL_CSS), 'diff body still at the 11px caption size')
  // U-03: a Ticket whose body only repeats its title must not print the same paragraph twice.
  check('a Ticket whose body is its title does not repeat it (U-03)',
    requestIsTitle({ title: '修一下登录', body: '修一下登录 ' }) === true
      && requestIsTitle({ title: '修一下登录', body: '修一下登录，并补一条断言。' }) === false,
    'requestIsTitle does not separate the repeated case')
  // U-03: the section jump disappears with the section it scrolls to.
  const repeatedJumps = ticketVisibleJumps({ title: '修一下登录', body: '修一下登录' }, false)
  const distinctJumps = ticketVisibleJumps({ title: '修一下登录', body: '补一条断言' }, false)
  check('the request jump disappears with the request section (U-03)',
    !repeatedJumps.some(jump => jump.id === 'sa-ticket-request')
      && distinctJumps.some(jump => jump.id === 'sa-ticket-request'),
    JSON.stringify(repeatedJumps.map(jump => jump.id)))
  // U-06: 659.9s is a number, not a duration; an old run's already-labelled cause must not be labelled twice.
  check('a long average run time reads as a duration (U-06)',
    durationText(659900) === '11m' && durationText(45000) === '45s' && durationText(90000) === '1m 30s',
    JSON.stringify([durationText(659900), durationText(45000), durationText(90000)]))
  const repeated = failureReasonTextOf(t, '其他原因：没有可用档位：没有可用档位：没有已保存的档位覆盖 edit')
  check('a cause stored with a repeated segment is collapsed before it is labelled (U-06)',
    (repeated.match(/没有可用档位/g) ?? []).length === 1 && (repeated.match(/其他原因/g) ?? []).length === 1,
    repeated)
}
{
  // U-05: the destructive confirmations all pass `variant="danger"`; ConfirmButton is what turns that into the tone.
  const confirmHost = document.createElement('div')
  document.body.appendChild(confirmHost)
  const confirmRoot = ReactDOM.createRoot(confirmHost)
  confirmRoot.render(React.createElement(Panel.Provider,
    { value: { t, call: async () => ({}), navigate() {}, notify() {} } },
    React.createElement(ConfirmButton, { label: '打回', title: '打回这张工单？', message: '会记录打回原因',
      confirmLabel: '确认打回', variant: 'danger', onConfirm: async () => true })))
  await sleep(150)
  confirmHost.querySelector('button')?.click()
  await sleep(150)
  const confirmButton = [...confirmHost.querySelectorAll('.sa-modal button')]
    .find(button => (button.textContent ?? '').trim() === '确认打回')
  check('a destructive confirmation confirms in the danger tone (U-05)',
    Boolean(confirmButton?.classList.contains('sa-btn-danger')),
    String(confirmButton?.className ?? 'no confirm button'))
  confirmRoot.unmount()
  confirmHost.remove()
}

// A request that never answers used to leave the polling queue pending forever: no error, no next attempt.
{
  // Raced against a 2s stop so a transport that really hangs fails this check instead of stalling the whole run.
  const settled = await Promise.race([
    apiCall(t, 'hang', 'GET', undefined, { timeoutMs: 40 }).then(() => 'resolved', failure => failure),
    sleep(2000).then(() => 'still pending'),
  ])
  check('a request that never answers times out instead of freezing the poller (P2)',
    settled !== 'still pending' && settled !== 'resolved' && settled?.status === 0
      && settled?.details?.timeout === true && settled?.details?.unreachable === true,
    typeof settled === 'string' ? settled : JSON.stringify({ status: settled?.status, details: settled?.details, message: settled?.message }))
}
{
  // No thread selected means no request: the route used to encode `undefined` and poll `engine/thread/undefined`.
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = ReactDOM.createRoot(host)
  const before = calls.length
  root.render(React.createElement(Panel.Provider,
    { value: { t, call: async () => ({}), navigate() {}, notify() {}, back() {}, backLabel: '' } },
    React.createElement(PanelState.Provider,
      { value: { data: fixtures.status, error: undefined, reload: async () => {}, actions: {} } },
      React.createElement(ThreadDetail, {}))))
  await sleep(300)
  const asked = calls.slice(before)
  check('a thread detail without a selection asks for nothing (P2)',
    !asked.some(call => call.includes('thread/undefined')), JSON.stringify(asked.slice(0, 4)))
  root.unmount()
  host.remove()
}

// The panel's own terminal screen: the Host stream only advances when every render frame is written AND acknowledged,
// so the frame path is worth driving without a browser.
{
  const writes = []
  const fake = {
    reset: () => writes.push('reset'),
    resize: (cols, rows) => writes.push(`resize ${cols}x${rows}`),
    write: (data, done) => { writes.push(`write ${String(data).slice(0, 7)}`); done() },
  }
  const snapshot = { revision: 4, frame: { type: 'snapshot', screen: 'screen-bytes', info: { cols: 100, rows: 30 } } }
  const applied = applyRenderFrame(fake, snapshot, () => writes.push('ack 4'))
  check('a snapshot frame replaces the screen, matches the Host grid and acknowledges it',
    applied && writes.join(' | ') === 'reset | resize 100x30 | write screen- | ack 4', writes.join(' | '))
  writes.length = 0
  applyRenderFrame(fake, { revision: 5, frame: { type: 'output', data: 'later-bytes' } }, () => writes.push('ack 5'))
  check('an output frame appends without resetting the screen',
    writes.join(' | ') === 'write later-b | ack 5', writes.join(' | '))
  const grid = []
  const fitted = fitGrid({ resize: (cols, rows) => grid.push(`term ${cols}x${rows}`) },
    { proposeDimensions: () => ({ cols: 220, rows: 80 }) },
    { environment: { maxCols: 200, maxRows: 60 } },
    { resize: (cols, rows) => grid.push(`host ${cols}x${rows}`) })
  check('the emulator grid is clamped to what the Host accepts and reported back',
    fitted && grid.join(' | ') === 'term 200x60 | host 200x60', grid.join(' | '))
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
