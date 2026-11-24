/**
 * Executor orchestration for one ticket: worktree → DSH worker agent → local gates → commit/push → merge request →
 * pipeline tracking. Every mutating action is gated by live.json (`executor.enabled`, `executor.allowPush`) and the
 * worktree guards in repo.js; the executor is the only place that pushes or opens an MR, never the worker itself.
 */
import { executeWorkflow, candidateDigest } from './workflow-worker.js'
import { blockedMessage } from './workflow.js'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, realpath, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { readToken } from './config.js'
import { recordId } from './state.js'
import {
  prepareWorktree, assertSafeWorktree, changedPaths, commitAll, pushBranch, hasChanges, headSha, git, remoteBranchSha,
} from './repo.js'
import { runWorker } from './worker.js'
import { runCliWorker, workerBackendOf } from './worker-cli.js'
import { readBots, paramsOfBot, resolveBot, stageNamesOf, validateBot } from './worker-bot.js'
import { probeBackend } from './backend-capability.js'
import { resolveDispatch, environmentOf } from './dispatch.js'
import { botPromptSections } from './prompts.js'
import { resolveRoute, routePreview as routePreviewOf, enabledBackends, WORKER_BACKENDS, DELIVERABLES } from './routing.js'
import { referenceContext } from './references.js'
import { createGitlabClient, summarizeJobs, pipelineStatusOf } from './gitlab.js'
import { createGithubClient, isGithubRepo } from './github.js'
import { worktreeDiff } from './diff.js'
import { repoOf, ticketRepo, repoToken, configRepos, workflowResumable } from './repos.js'
import { REPAIR_LIMIT, repairBudgetOf } from './repair.js'
import { OperationStore, summarizeRun } from './operations.js'
import { AcceptanceStore, checkFromGate } from './acceptance.js'
import { appendActivity } from './activities.js'

const OUTPUT_TAIL = 4000

// One mutating action per Ticket at a time. The engine dispatches runs from several paths (queue, poll, resume,
// manual buttons); without a synchronous claim two of them can both pass the status check and share a worktree.
const TICKET_CLAIMS = new Map()

// Chinese action phrases for the busy conflict message (the raw claim key is an internal English phrase).
const CLAIM_ACTION_TEXT = {
  executing: '正在执行',
  resuming: '正在恢复执行',
  answering: '正在记录回答并重新执行',
  'refreshing CI': '正在刷新 CI',
  publishing: '正在发布 MR',
  verifying: '正在核对合并/UAT',
}

/** The user-facing conflict message for one Ticket whose claim is held by `action`. */
export function ticketBusyMessage(ticketId, action) {
  return `工单 ${ticketId} ${CLAIM_ACTION_TEXT[action] ?? '正在处理'}，请等这次操作结束再试。`
}

/** The in-flight action for one Ticket, if any. The Host checks this before starting work so a conflict answers 409. */
export function ticketBusyAction(ticketId) {
  return TICKET_CLAIMS.get(ticketId)
}

async function withTicketClaim(ticketId, action, work) {
  if (!ticketId) return work()
  const running = TICKET_CLAIMS.get(ticketId)
  if (running) {
    // A second click (or a poll and a click) lands here. This is a user-visible conflict, not a server fault: the API
    // turns `httpStatus` into the response status and the panel shows the message as-is.
    throw Object.assign(new Error(ticketBusyMessage(ticketId, running)),
      { name: 'TicketBusyError', code: 'ticket_busy', httpStatus: 409 })
  }
  TICKET_CLAIMS.set(ticketId, action)
  try {
    return await work()
  } finally {
    TICKET_CLAIMS.delete(ticketId)
  }
}

/**
 * Run one shell command with a timeout, capturing a bounded tail of stdout+stderr.
 * @param {any} [command]
 * @param {any} [options]
 */
export function runCommand(command, { cwd, timeoutMs = 600_000, env = {}, signal, requireOutput } = {}) {
  if (signal?.aborted) return Promise.resolve({ exitCode: 130, aborted: true, timedOut: false, output: '', durationMs: 0 })
  return new Promise((resolve) => {
    const startedAt = Date.now()
    // A gate is `bash -lc "<script>"`, which starts its own children (mvn/pnpm). Killing only bash would leave those
    // children writing to the worktree, so the command runs in its own process group and every kill targets the group
    // (review P1 AC-03). Unix-only: Windows has no negative-pid group kill.
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32' })
    let output = ''
    let markerSeen = false
    let settled = false
    let aborted = false
    let timedOut = false
    let forceTimer
    let hardTimer
    const killTree = (signalName) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signalName)
        else child.kill(signalName)
      } catch { /* already gone */ }
    }
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(forceTimer)
      clearTimeout(hardTimer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({ ...result, ...(aborted ? { aborted: true } : {}), ...(requireOutput ? { markerSeen } : {}),
        output: output.slice(-OUTPUT_TAIL),
        durationMs: Date.now() - startedAt })
    }
    // A stop request kills the running gate/prepare command; the executor then sees `aborted` and stops before the
    // next action instead of continuing to commit or push (review finding AC-03).
    const onAbort = () => {
      aborted = true
      killTree('SIGTERM')
      forceTimer = setTimeout(() => killTree('SIGKILL'), 2_000)
      forceTimer.unref?.()
      // Settlement cannot wait on 'close': a daemonised grandchild holding fd 1 would keep the claim forever.
      hardTimer = setTimeout(() => settle({ exitCode: 130 }), 10_000)
      hardTimer.unref?.()
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })
    const timer = setTimeout(() => {
      timedOut = true
      killTree('SIGTERM')
      // Give the group a bounded grace period to exit, then force it. Never report the timeout before the group is
      // gone: a "timed out" gate whose child is still writing would let the worktree change after confirmation.
      forceTimer = setTimeout(() => killTree('SIGKILL'), 2_000)
      forceTimer.unref?.()
      hardTimer = setTimeout(() => settle({ exitCode: 124, timedOut: true }), 10_000)
      hardTimer.unref?.()
    }, Math.max(1000, timeoutMs))
    // Keep a bounded rolling log (a chatty gate can write tens of MB in one run) and remember whether the
    // requireOutput marker was ever seen, so a marker printed early is not reported as missing evidence.
    const absorb = chunk => {
      const text = chunk.toString()
      if (requireOutput && !markerSeen) markerSeen = (output + text).includes(requireOutput)
      output = (output + text).slice(-OUTPUT_TAIL * 2)
    }
    child.stdout.on('data', absorb)
    child.stderr.on('data', absorb)
    child.on('error', error => settle({ exitCode: 127, error: error.message }))
    // A killed child closes with a signal-derived code; report the same 130 as the pre-aborted path.
    child.on('close', code => settle({ exitCode: aborted ? 130 : timedOut ? 124 : code ?? 1, timedOut: timedOut && !aborted }))
  })
}

/** Quote one path as a single shell argument (gate commands run through bash -lc). */
const shellArg = value => `'${String(value).replace(/'/g, `'\\''`)}'`

/** One repository's gates, keyed by name (frozen order in `repo.gates`). */
export function gateCommands(repo, config) {
  // Legacy callers pass the whole config: use its first/legacy repository.
  const target = repo?.gates ? repo : configRepos(repo ?? config)[0]
  const settings = repo?.gates ? config : repo
  const map = {}
  for (const gate of target?.gates ?? []) {
    map[gate.name] = { command: gate.command, ...gate.dryRunCommand ? { dryRunCommand: gate.dryRunCommand } : {},
      ...gate.passChangedFiles === true ? { passChangedFiles: true } : {},
      ...gate.requireOutput ? { requireOutput: gate.requireOutput } : {},
      ...gate.cwd ? { cwd: gate.cwd } : {},
      timeoutMs: gate.timeoutMs ?? settings?.executor?.gateTimeoutMs ?? 600_000 }
  }
  return map
}

/**
 * Effective command of one gate: the dry-run variant in a dry run, and — for `passChangedFiles` gates — the executor's
 * own changed-path list appended as argv. Both gate phases (run and publish) must build the command the same way, or a
 * `--changed`-style gate receives no files and fails before running (the publish path used to skip this).
   * @param {any} [spec]
   * @param {any} [options]
 */
export function gateCommandFor(spec, { paths = [], dryRun = false } = {}) {
  const base = dryRun && spec.dryRunCommand ? spec.dryRunCommand : spec.command
  return spec.passChangedFiles ? `${base}${paths.length ? ` ${paths.map(shellArg).join(' ')}` : ''}` : base
}

/** Resolve the repository of one ticket plus its token; every repo-scoped action goes through this. */
export function repoContext(engine, ticket) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const repo = ticketRepo(config, ticket) ?? config.repos[0]
  return { loaded, config, repo, token: repoToken(loaded, repo) }
}

/** Previous name for callers that only have a repository id. */
export function repoById(config, id) { return repoOf(config, id) }

/**
 * Worker prompt: the project rules an executor session must follow, plus the ticket's boundaries.
 * @param {any} [ticket]
 * @param {any} [config]
 * @param {any} [repo]
 * @param {any} [options]
 */
export function workerBrief(ticket, config, repo, options = {}) {
  const target = repo ?? configRepos(config)[0] ?? {}
  const kind = target.kind === 'oracle-ebs'
    ? 'Oracle EBS R12 export mirror (DDL / PLSQL / Forms / Java source exported from UAT)'
    : 'Oracle EBS channel layer (Java 21 + Spring Boot + React/TS)'
  const gates = (target.gates ?? []).map(gate => `\`${gate.command}\``).join('、') || '(none)'
  const lines = [
    `You are the Superagent worker for one ticket in the ${target.name ?? target.id} repository (${kind}).`,
    'Follow the repository rules: read AGENTS.md (and AGENT.md when present) before editing; they override your habits.',
    'Make the smallest compatible change. Add or adjust tests / specs where the repository standards require it.',
    `Do NOT run the repository's deployment or export scripts yourself — the executor runs the gates after you: ${gates}.`,
    'You are in an isolated git worktree on a feature branch. HARD BOUNDARIES: never run git push, git merge, git tag, gh/glab, deployment scripts, or write to the protected branch; never run production or EBS DDL/DML. Never touch .env*, secrets/, db/apps/, node_modules/, logs/, or any path the repository marks protected — including committed credential scripts.',
    'Do not create commits; the executor commits and pushes after reviewing the diff. Leave the changes in the working tree.',
    ...(target.workerInstructions ?? []),
    // A repair round may have to fix the tool that failed, not only the object under test. Credentials stay off-limits.
    ...(options.repair === true
      ? ['REPAIR ROUND: this run is fixing a gate failure. When the evidence shows the failure is in the repository\'s'
        + ' deployment/authorisation tooling, you may edit scripts under scripts/local/ (never oracle_connect.py or any'
        + ' credential file). Do not run those scripts; the executor re-runs the gates afterwards.']
      : []),
    // The worker owns every run it starts: the harness holds the turn open until subagents it spawned settle, so a
    // "waiting for independent review" message cannot become the final summary (tkt_969114d7aca74a45, 2026-11-09).
    'You may spawn subagents for an independent review. You own every run you start: the run waits for them to finish before the turn closes, and their results land back in your inbox — do not give your final summary while they are still running; incorporate their results, then finish.',
    'Finish with a short final message: what you changed, which gates you ran and their result, and any remaining risk.',
    `Ticket: ${ticket.id} — ${ticket.title}`,
    `Base: ${target.baseBranch ?? config.baseBranch} (origin/${target.baseBranch ?? config.baseBranch}); you are on the ticket's feature worktree already.`,
  ]
  return lines.join('\n')
}

/** Ticket body plus provenance (revisions and any earlier Q/A context) as the worker's user message. */
export function workerTask(ticket, repo, extraContext) {
  const revisions = Array.isArray(ticket?.revisions) ? ticket.revisions.slice(-10) : []
  const revisionBlock = revisions.length
    ? ['追加要求（按编号顺序执行；上一轮的改动已留在当前工作树里，请保留并在此基础上修改，不要丢弃或重做已满足的部分）：',
      ...revisions.map((revision, index) => `${index + 1}. ${String(revision?.text ?? '').trim()}`)].join('\n')
    : ''
  return [
    `处理这个 ${repo?.name ?? 'Superagent'} 工单：${ticket.title}`,
    '',
    ticket.body ? `原始请求：\n${ticket.body}` : '',
    '',
    revisionBlock,
    '',
    typeof extraContext === 'string' && extraContext.trim() ? extraContext.trim() : '',
    '',
    '要求：按仓库规范完成改动；不要提交、不要推送、不要合并，也不要运行导出/部署脚本（执行器会跑相应闸门）。',
  ].filter(Boolean).join('\n')
}

/**
 * The full context a worker gets: the caller's extra context (answers, repair notes) plus the report/body of every
 * Ticket this one references. Kept separate from `workerTask` so the reference lookup never changes its pure contract.
 */
export function workerContext(engine, ticket, extraContext) {
  const own = typeof extraContext === 'string' ? extraContext.trim() : ''
  return [own, referenceContext(engine, ticket)].filter(Boolean).join('\n\n')
}

// ---------------------------------------------------------------------------
// Run bookkeeping shared by executeTicket / resumeTicket / publishTicket (P0 contract §1.1). Every step refreshes
// `leaseAt`; a success ends with stopReason='done', a failure carries a machine-readable stopReason/errorCode pair.
// ---------------------------------------------------------------------------

const TRACE_LIMIT = 80
const TRACE_SUMMARY_LIMIT = 300
const TRACE_TYPES = new Set(['assistant', 'tool_call', 'tool_result', 'turn_end', 'error'])

/** §12 E4: persist a running trace at most once per 500 ms, or earlier once 8 entries are waiting. */
function liveTraceSink({ run, persist, log = /** @type {(line: string) => void} */ (() => {}) }) {
  const buffer = []
  let timer
  let pending = 0
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = undefined }
    if (!buffer.length) return
    const entries = buffer.splice(0, buffer.length)
    pending = 0
    run.trace = [...(run.trace ?? []), ...entries].slice(-TRACE_LIMIT)
    Promise.resolve(persist()).catch(error => log(`executor: trace persist failed: ${messageOf(error)}`))
  }
  return {
    push(entry) {
      const [clean] = traceOf([entry])
      if (!clean) return
      buffer.push(clean)
      pending += 1
      if (pending >= 8) { flush(); return }
      if (!timer) { timer = setTimeout(flush, 500); timer.unref?.() }
    },
    stop() { flush() },
  }
}

/** Failure tagged with the run stopReason code; the shared catch body copies it onto run.stopReason/errorCode. */
class StageError extends Error {
  constructor(code, message) { super(message); this.name = 'StageError'; this.code = code }
}

const messageOf = error => error instanceof Error ? error.message : String(error)

const safeJson = (value) => { try { return JSON.stringify(value) ?? '' } catch { return String(value) } }

/** Clip one trace summary to the contract limit (≤300 characters). */
const clipSummary = (value) => {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : safeJson(value)
  return text.length > TRACE_SUMMARY_LIMIT ? `${text.slice(0, TRACE_SUMMARY_LIMIT - 1)}…` : text
}

/** Normalise worker events into `run.trace`: known types only, at most 80 entries, summaries clipped. */
export function traceOf(events) {
  if (!Array.isArray(events)) return []
  const fallbackAt = new Date().toISOString()
  return events
    .filter(event => event && TRACE_TYPES.has(event.type))
    .slice(-TRACE_LIMIT)
    .map(event => ({
      type: event.type,
      at: typeof event.at === 'string' && event.at ? event.at : fallbackAt,
      ...event.name === undefined || event.name === null || event.name === '' ? {} : { name: String(event.name) },
      ...event.summary === undefined || event.summary === null || event.summary === '' ? {} : { summary: clipSummary(event.summary) },
      ...event.state === undefined || event.state === null || event.state === '' ? {} : { state: String(event.state) },
    }))
}

// ---------------------------------------------------------------------------
// P1 helpers: operation ledger / acceptance rounds / activities / checkpoints / worker report (contract §3–§7).
// The engine owns the stores when it can (T1 creates them on load); the executor creates them lazily from
// `engine.stateDir` when the engine has not, and degrades to the state document when no directory is available
// (unit tests with a bare fake engine).
// ---------------------------------------------------------------------------

const storeReadiness = new WeakMap()

/** Resolve one engine store: injected one first, else lazily create + load it from `engine.stateDir`. */
async function ensureStore(engine, key, Ctor) {
  if (!engine) return undefined
  let store = engine[key]
  if (!store || typeof store.save !== 'function') {
    if (typeof engine.stateDir !== 'string' || !engine.stateDir || typeof Ctor !== 'function') return undefined
    store = new Ctor(engine.stateDir)
    engine[key] = store
  }
  if (store.loaded === true || typeof store.load !== 'function') return store
  let ready = storeReadiness.get(store)
  if (!ready) {
    ready = store.load().then(() => store)
    storeReadiness.set(store, ready)
  }
  return ready
}

/** Append one activity, never letting the log break a run. */
function addActivity(ticket, entry) {
  try { return appendActivity(ticket, entry) } catch { return undefined }
}

/** Directory of the worker report files plus the per-run report path (created and reset before the worker starts). */
async function prepareReportFile(engine, runId) {
  if (typeof engine?.stateDir !== 'string' || !engine.stateDir) return undefined
  try {
    const dir = join(engine.stateDir, 'runs')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const file = join(dir, `${runId}.report.jsonl`)
    await rm(file, { force: true })
    return file
  } catch { return undefined }
}

/** Earlier Q/A pairs as worker context, so a re-run after an answer does not repeat the question. */
function answerContext(ticket) {
  const answers = Array.isArray(ticket?.answers) ? ticket.answers.slice(-10) : []
  if (!answers.length) return undefined
  const lines = ['此前的提问与回答：']
  for (const entry of answers) {
    const question = typeof entry?.question === 'string' ? entry.question
      : typeof entry?.question?.question === 'string' ? entry.question.question : ''
    if (question) lines.push(`问：${question}`)
    if (typeof entry?.answer === 'string' && entry.answer.trim()) lines.push(`答：${entry.answer.trim()}`)
  }
  return lines.length > 1 ? lines.join('\n') : undefined
}

/**
 * UI phase of one step name (contract §7 checkpoint phases).
 * @param {any} [name]
 * @param {any} [detail]
 */
function phaseOfStep(name, detail = {}) {
  if (name === 'resume:checkpoint') return detail.phase ?? 'gates'
  // A stopped run keeps the phase it actually reached (AC-04): writing `done` made a stopped ticket look complete and
  // blocked the checkpoint resume that the UI offers.
  if (name === 'stop') return detail.phase ?? 'gates'
  if (/^prepare/.test(name)) return 'prepare'
  if (name === 'worker' || name === 'awaiting-answer') return 'worker'
  if (name === 'changed-paths') return 'changes'
  if (name.startsWith('gate') || name === 'bootstrap:pnpm' || name === 'awaiting-human' || name === 'export-repo'
    || name === 'resume:retry' || name === 'resume:release') return 'gates'
  if (name === 'commit') return 'commit'
  if (name === 'push') return 'push'
  if (name === 'merge-request') return 'mr'
  return 'done'
}

/** Current checkpoint of a run: enough to rebuild the run without the worker when the host restarts. */
function checkpointOf(run, name, detail, at) {
  const checkpoint = { step: name, phase: phaseOfStep(name, detail), at }
  if (run.worktree) checkpoint.worktree = run.worktree
  if (run.branch) checkpoint.branch = run.branch
  if (run.baseSha) checkpoint.baseSha = run.baseSha
  if (Array.isArray(run.changedPaths)) checkpoint.changedPaths = [...run.changedPaths]
  return checkpoint
}

/** Worker report → bounded `run.report` (progress 50 / artifacts 50 / verify 20, text clipped). */
function normalizeReport(report) {
  if (!report || typeof report !== 'object') return undefined
  const at = new Date().toISOString()
  const timeOf = value => typeof value === 'string' && value ? value : at
  const list = value => Array.isArray(value) ? value : []
  const progress = list(report.progress).slice(0, 50)
    .filter(entry => entry && typeof entry.text === 'string' && entry.text.trim())
    .map(entry => ({ text: entry.text.trim().slice(0, 1000), at: timeOf(entry.at) }))
  const artifacts = list(report.artifacts).slice(0, 50)
    .filter(entry => entry && typeof entry.path === 'string' && entry.path.trim())
    .map(entry => ({ path: entry.path.trim().slice(0, 1000),
      ...typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note.trim().slice(0, 500) } : {},
      at: timeOf(entry.at) }))
  const verify = list(report.verify).slice(0, 20)
    .filter(entry => entry && typeof entry.name === 'string' && entry.name.trim())
    .map(entry => ({ name: entry.name.trim().slice(0, 500),
      ...typeof entry.command === 'string' && entry.command.trim() ? { command: entry.command.trim().slice(0, 1000) } : {},
      ...typeof entry.expectedOutput === 'string' && entry.expectedOutput.trim()
        ? { expectedOutput: entry.expectedOutput.trim().slice(0, 500) } : {},
      at: timeOf(entry.at) }))
  const question = report.question && typeof report.question === 'object'
    && typeof report.question.question === 'string' && report.question.question.trim()
    ? {
      question: report.question.question.trim().slice(0, 2000),
      ...Array.isArray(report.question.options)
        ? { options: report.question.options.filter(option => typeof option === 'string').slice(0, 20) } : {},
      at: timeOf(report.question.at),
    }
    : undefined
  return { progress, artifacts, verify, ...(question ? { question } : {}) }
}

/**
 * Final handoff of a run: worker summary (front 300 chars) + changed paths.
 * @param {any} [run]
 * @param {any} [options]
 */
function writeHandoff(run, { summary, nextAction } = {}) {
  const text = clipSummary(typeof summary === 'string' ? summary : '')
  const handoff = { summary: text || clipSummary(`run ${run.stopReason ?? run.status ?? 'finished'}`) }
  if (Array.isArray(run.changedPaths) && run.changedPaths.length) handoff.changedPaths = [...run.changedPaths]
  if (typeof nextAction === 'string' && nextAction.trim()) handoff.nextAction = clipSummary(nextAction)
  run.handoff = handoff
}

/**
 * Link the merge request with the head commit it points at (P2 §2.2): a CI check can then tell whether a pipeline
 * belongs to this MR head. When the Ticket already carries a pipeline, its `headSha` is kept in sync too.
   * @param {any} [ticket]
   * @param {any} [mr]
   * @param {any} [options]
 */
function linkMergeRequest(ticket, mr, { mode, pending, headSha } = {}) {
  const sha = headSha ?? ticket.links?.commit
  const previous = ticket.links?.mergeRequest
  // A different MR is a new delivery. The previous merge's deployment, auto-merge, pipeline and verification describe
  // the old commit: kept, `autoMerge.state='merged'` would stop the new MR from ever merging, and a stale
  // `verification.merged=true` would report this delivery as accepted before it landed.
  const replaced = Boolean(previous?.iid) && Boolean(mr?.iid) && previous.iid !== mr.iid
  const kept = replaced
    ? Object.fromEntries(Object.entries(ticket.links ?? {})
      .filter(([key]) => !['deployment', 'autoMerge', 'pipeline', 'verification'].includes(key)))
    : (ticket.links ?? {})
  const mergeRequest = {
    ...(replaced ? {} : previous ?? {}),
    ...(mr ?? {}),
    ...(mode ? { mode } : {}),
    ...(pending !== undefined ? { pending } : {}),
    ...(sha ? { headSha: sha } : {}),
  }
  ticket.links = { ...kept, mergeRequest }
  if (sha && ticket.links?.pipeline) {
    ticket.links = { ...ticket.links, pipeline: { ...ticket.links.pipeline, headSha: sha } }
  }
}

/**
 * AC-04: open a merge request only after looking the source branch up. The create call may have succeeded before a
 * lost response, so a retry adopts the existing MR instead of opening a duplicate; a failed lookup is "unknown", never
 * "no MR exists". A duplicate error from a concurrent create is reconciled by the same looked-up state.
 */
async function openOrAdoptMergeRequest({ gitlab, sourceBranch, targetBranch, title, description, headSha }) {
  let existing
  try {
    existing = await gitlab.listMergeRequests({ sourceBranch, state: 'all' })
  } catch (error) {
    throw new StageError('mr_lookup_failed',
      `cannot verify existing merge requests; refusing to create a duplicate: ${messageOf(error)}`)
  }
  // An opened MR always covers this head (it picks the push up). A merged one only does while it still points at the
  // head — once the branch moved past the merge, its commits already reached the target and these newer ones need their
  // own MR, or the delivery can never land (a failure after the merge is exactly that case).
  const headOf = item => item?.sha ?? item?.diffRefs?.headSha
  const adopt = (existing ?? []).find(item => item.state === 'opened')
    ?? (existing ?? []).find(item => item.state === 'merged' && (!headSha || !headOf(item) || headOf(item) === headSha))
  if (adopt) return { mr: adopt, adopted: true }
  try {
    return { mr: await gitlab.createMergeRequest({ sourceBranch, targetBranch, title, description }), adopted: false }
  } catch (error) {
    // The create may have landed even though the response was lost; a re-query decides. A failed re-query stays an
    // error: nothing is created blindly on top of an unknown remote state.
    if (!/already exists|open merge request/i.test(messageOf(error))) throw error
    let opened
    try { opened = await gitlab.listMergeRequests({ sourceBranch, state: 'opened' }) }
    catch (lookupError) {
      throw new StageError('mr_lookup_failed',
        `cannot verify existing merge requests; refusing to create a duplicate: ${messageOf(lookupError)}`)
    }
    if (!opened?.[0]) throw error
    return { mr: opened[0], adopted: true }
  }
}

/** Durable evidence that the branch reached the remote; a local commit alone is not a push. */
function pushEvidence(pushed, repo) {
  return { at: new Date().toISOString(), branch: pushed?.branch, sha: pushed?.sha,
    remote: repo?.gitlab?.baseUrl ?? null, mode: repo?.gitlab?.createMr === 'push' ? 'push' : 'api' }
}

/**
 * Read the worktree HEAD; a git failure is `undefined`, never a guessed SHA.
 * @param {any} [cwd]
 * @param {any} [deps]
 */
function headOf(cwd, deps = /** @type {any} */ ({})) {
  return (deps.headSha ?? headSha)(cwd).catch(() => undefined)
}

/**
 * Read origin/<branch>; an unreadable remote is `{ checked:false }`, never "absent" (AC-04).
 * @param {any} options
 */
function remoteHeadOf({ cwd, branch, deps = /** @type {any} */ ({}) }) {
  return (deps.remoteBranchSha ?? remoteBranchSha)({ cwd, branch }).catch(() => ({ checked: false }))
}

/** Retire the durable request once its result is confirmed, so a resume cannot replay it. */
function clearPushRequest(ticket) {
  if (!ticket.links?.pushRequest) return false
  const links = { ...ticket.links }
  delete links.pushRequest
  ticket.links = links
  return true
}

/** Save the confirmed push outcome (remote-visible progress) and retire the pending request. */
function recordPushDelivered(ticket, pushed, repo) {
  ticket.links = { ...ticket.links, ...(pushed?.sha ? { commit: pushed.sha } : {}), push: pushEvidence(pushed, repo) }
  clearPushRequest(ticket)
}

/**
 * AC-04: a remote action is persisted as a request *before* it runs and as a result *after* it returns. If the process
 * dies between the two, the request survives with no result; a resume must ask the remote what happened instead of
 * repeating the action (a duplicate push, or worse a duplicate MR). States:
 *   none      – nothing pending
 *   delivered – the remote already has this HEAD; push evidence written, request cleared
 *   stale     – the requested commit is remote but HEAD moved; evidence kept, the new HEAD still needs a push
 *   absent    – the remote is readable and does not have it; retrying is safe
 *   unknown   – the remote cannot be read; the caller must not retry blindly
 */
async function reconcilePendingPush({ ticket, cwd, branch, head, repo, deps = /** @type {any} */ ({}), persist }) {
  const request = ticket.links?.pushRequest
  if (!request || typeof request !== 'object') return { state: 'none' }
  // Always ask the remote first: even a request previously marked `not-visible` may have landed during a replication
  // delay, and treating that as absent would push the same commit again.
  const remote = await remoteHeadOf({ cwd, branch, deps })
  if (!remote.checked) {
    ticket.links = { ...ticket.links, pushRequest: { ...request, state: 'unknown', checkedAt: new Date().toISOString() } }
    await persist().catch(() => {})
    return { state: 'unknown', request: ticket.links.pushRequest }
  }
  if (head && remote.sha === head) {
    const pushed = { pushed: true, branch, sha: head, reconciled: true }
    recordPushDelivered(ticket, pushed, repo)
    await persist().catch(() => {})
    return { state: 'delivered', pushed }
  }
  if (request.sha && remote.sha === request.sha) {
    // The requested commit reached the remote but HEAD has moved since: keep the evidence and still push the new HEAD.
    recordPushDelivered(ticket, { pushed: true, branch, sha: request.sha, reconciled: true }, repo)
    await persist().catch(() => {})
    return { state: 'stale' }
  }
  clearPushRequest(ticket)
  await persist().catch(() => {})
  return { state: 'absent', remote }
}

/**
 * Record → push → confirm, shared by the normal delivery and the manual publish. A lost response is reconciled from the
 * remote SHA; an unreadable remote leaves `unknown` and throws instead of pushing again (AC-04).
 */
async function deliverPush({ ticket, cwd, branch, repo, deps = /** @type {any} */ ({}), persist, pushOptions = [] }) {
  const requestSha = await headOf(cwd, deps)
  const mode = repo?.gitlab?.createMr === 'push' ? 'push' : 'api'
  ticket.links = { ...ticket.links, pushRequest: { at: new Date().toISOString(), branch, sha: requestSha, mode, state: 'requested' } }
  await persist()
  let result
  try {
    result = await (deps.pushBranch ?? pushBranch)({ cwd, branch, featurePrefix: repo.featurePrefix, pushOptions })
  } catch (error) {
    const remote = await remoteHeadOf({ cwd, branch, deps })
    if (remote.checked && requestSha && remote.sha === requestSha) {
      // The remote already has this exact commit: the push succeeded and only its response was lost.
      result = { pushed: true, branch, sha: requestSha, reconciled: true }
    } else {
      ticket.links = { ...ticket.links, pushRequest: { ...ticket.links.pushRequest,
        state: remote.checked ? 'not-visible' : 'unknown', ...(remote.sha ? { remoteSha: remote.sha } : {}),
        error: messageOf(error), checkedAt: new Date().toISOString() } }
      await persist().catch(() => {})
      throw new StageError('push_failed', remote.checked
        ? `push failed and origin/${branch} does not contain HEAD: ${messageOf(error)}`
        : `push failed and the remote state is unknown (not re-pushed blindly): ${messageOf(error)}`)
    }
  }
  recordPushDelivered(ticket, result, repo)
  await persist()
  return result
}

/**
 * Mark the run finished: completion time, handoff and the Ticket-level status activity.
 * @param {any} options
 */
function markRunComplete({ run, ticket, to, summary, detail, nextAction }) {
  const at = new Date().toISOString()
  run.completedAt = at
  writeHandoff(run, { summary: summary ?? run.worker?.text ?? run.error, nextAction })
  if (to) {
    addActivity(ticket, { kind: 'status', actorKind: 'system', from: 'working', to,
      detail: detail ?? `run ${run.stopReason ?? run.status}`, at, refs: { runId: run.id } })
  }
}

/** Refuse to continue a resumed/published run whose Ticket has a pending stop request (AC-03). */
function assertNotStopped(engine, ticketId) {
  const stopped = engine?.disposed === true || (typeof engine?.isStopRequested === 'function'
    ? engine.isStopRequested(ticketId)
    : Boolean(engine?.state?.tickets?.[ticketId]?.stopRequested))
  if (stopped) throw new StageError('stopped', 'stop requested by an operator')
}

/** Configured repair policy of one gate: only an explicit 'auto_repair' opts in (default manual). */
const onFailOf = gate => (gate?.onFail === 'auto_repair' ? 'auto_repair' : 'manual')

/** Round plan from the repository gates (frozen `program` verifier only). */
function acceptancePlan(repo) {
  return (repo.gates ?? []).map(gate => ({
    id: gate.name,
    name: gate.name,
    required: gate.required !== false,
    verifierType: 'program',
    command: gate.command,
    onFail: onFailOf(gate),
  }))
}

/** One check for one gate result; a gate that never ran stays `skipped`. */
function evidenceMissing(spec, result) {
  if (!spec?.requireOutput) return false
  const marker = spec.requireOutput
  if (result?.markerSeen === true) return false
  if (result?.markerSeen === false) return true
  return !String(result?.output ?? '').includes(marker)
}

function acceptanceCheck(gate, result) {
  const onFail = onFailOf(gate)
  if (!result) {
    return { id: recordId('chk'), name: gate.name, required: gate.required !== false, verifierType: 'program', onFail,
      status: 'skipped' }
  }
  const check = /** @type {any} */ (checkFromGate(gate, { exitCode: result.exitCode, timedOut: result.timedOut,
    durationMs: result.durationMs, output: result.output }))
  check.onFail = onFail
  // A timed-out gate or one whose command could not start is an infrastructure error, not a failing gate.
  if (result.timedOut || result.exitCode === 127) check.status = 'errored'
  const missingEvidence = evidenceMissing(gate, result)
  if (missingEvidence) {
    check.status = 'failed'
    check.note = `missing evidence: ${gate.requireOutput}`
  }
  return check
}

/** Checks of the current round: every planned gate, with the evidence collected so far. */
function acceptanceChecks(repo, gates) {
  const byName = new Map((gates ?? []).map(gate => [gate.name, gate]))
  return (repo.gates ?? []).map(gate => acceptanceCheck(gate, byName.get(gate.name)))
}

/** Completed-round status: a failed check wins over an errored one; everything else delivered. */
function roundStatusOf(checks) {
  if (checks.some(check => check.status === 'failed')) return 'failed'
  if (checks.some(check => check.status === 'errored')) return 'errored'
  return 'delivered'
}

/**
 * Append one acceptance round after the gate phase. `outcome`: 'completed' (gates ran to the end),
 * 'parked' (the round stays verifying for the human decision) or 'errored' (the dependency bootstrap broke).
 */
/**
 * @param {any} options
 */
async function recordAcceptanceRound({ engine, ticket, run, repo, gates, outcome, repair }) {
  const acceptance = await ensureStore(engine, 'acceptance', AcceptanceStore)
  if (!acceptance || typeof acceptance.update !== 'function') return undefined
  const now = new Date().toISOString()
  const plan = acceptancePlan(repo)
  const checks = acceptanceChecks(repo, gates)
  const round = {
    id: recordId('acc'),
    roundIndex: 0,
    runId: run.id,
    trigger: run.trigger ?? 'manual',
    status: 'verifying',
    startedAt: run.startedAt ?? now,
    plan,
    checks,
    // Automatic repair summary of the run that produced this round (0/0/none when the path never repairs).
    repair: { attempts: repair?.attempts ?? 0, max: repair?.max ?? 0, status: repair?.status ?? 'none' },
  }
  if (outcome === 'completed') {
    round.status = roundStatusOf(checks)
    round.completedAt = now
  } else if (outcome === 'errored') {
    round.status = 'errored'
    round.completedAt = now
  }
  try {
    return await acceptance.update(ticket.id, (record) => {
      round.roundIndex = (Array.isArray(record.rounds) ? record.rounds.length : 0) + 1
      record.rounds = [...(Array.isArray(record.rounds) ? record.rounds : []), round].slice(-50)
      if (!['accepted', 'rejected', 'closed'].includes(record.status)) {
        record.status = round.status === 'delivered' ? 'delivered' : round.status === 'errored' ? 'errored' : 'verifying'
      }
      return record
    }, { requirement: ticket.title })
  } catch { return undefined }
}

/**
 * `release` of a parked gate: the checks that failed are skipped with a note, the round is completed.
 * @param {any} options
 */
async function releaseAcceptanceRound({ engine, ticket, run, note }) {
  const acceptance = await ensureStore(engine, 'acceptance', AcceptanceStore)
  if (!acceptance || typeof acceptance.update !== 'function') return undefined
  const now = new Date().toISOString()
  try {
    return await acceptance.update(ticket.id, (record) => {
      const rounds = Array.isArray(record.rounds) ? record.rounds : []
      let index = -1
      for (let cursor = rounds.length - 1; cursor >= 0; cursor -= 1) {
        if (rounds[cursor].runId === run.id) { index = cursor; break }
      }
      if (index < 0) {
        for (let cursor = rounds.length - 1; cursor >= 0; cursor -= 1) {
          if (rounds[cursor].status === 'verifying') { index = cursor; break }
        }
      }
      if (index < 0) return record
      const round = { ...rounds[index] }
      round.checks = (Array.isArray(round.checks) ? round.checks : []).map(check =>
        check.status === 'failed' || check.status === 'errored'
          ? { ...check, status: 'skipped', note: 'released by human' } : check)
      round.status = roundStatusOf(round.checks)
      round.completedAt = round.completedAt ?? now
      rounds[index] = round
      record.rounds = rounds
      if (!['accepted', 'rejected', 'closed'].includes(record.status)) {
        record.status = round.status === 'delivered' ? 'delivered' : 'verifying'
      }
      return record
    })
  } catch { return undefined }
}

/** The full run a Ticket points at (operation ledger first; the state document may only hold the index row). */
async function runOf(engine, ticket) {
  const operations = await ensureStore(engine, 'operations', OperationStore)
  if (operations && ticket?.runId && typeof operations.get === 'function') {
    const stored = operations.get(ticket.runId)
    if (stored) return stored
  }
  return (engine.state?.runs ?? []).find(item => item.id === ticket?.runId)
}

/** Newest-first most recent resumable run (interrupted by a restart, or stopped by a person) of one Ticket. */
const RESUMABLE_RUN_STATUSES = new Set(['interrupted', 'stopped'])
async function resumableRunOf(engine, ticket) {
  const operations = await ensureStore(engine, 'operations', OperationStore)
  if (operations && typeof operations.get === 'function') {
    if (ticket.runId) {
      const preferred = operations.get(ticket.runId)
      if (RESUMABLE_RUN_STATUSES.has(preferred?.status)) return preferred
    }
    if (typeof operations.list === 'function') {
      const found = operations.list({ ticketId: ticket.id, limit: 20 })
        .find(run => RESUMABLE_RUN_STATUSES.has(run.status))
      if (found) return found
    }
  }
  const runs = (engine.state?.runs ?? []).filter(run => run.ticketId === ticket.id)
  if (ticket.runId) {
    const preferred = runs.find(run => run.id === ticket.runId)
    if (RESUMABLE_RUN_STATUSES.has(preferred?.status)) return preferred
  }
  return runs
    .slice()
    .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
    .find(run => RESUMABLE_RUN_STATUSES.has(run.status))
}

/** The repository configuration a run actually executed with (AC-10: survives a later config edit). */
function repoSnapshot(repo) {
  if (!repo) return undefined
  return {
    id: repo.id,
    name: repo.name,
    kind: repo.kind,
    enabled: repo.enabled !== false,
    repo: repo.repo,
    baseBranch: repo.baseBranch,
    targetBranch: repo.gitlab?.targetBranch,
    project: repo.gitlab?.project,
    verifyMode: repo.verifyMode,
    acceptance: repo.acceptance,
    createMr: repo.gitlab?.createMr,
    ci: repo.gitlab?.ci !== false,
    gateNames: Array.isArray(repo.gates) ? repo.gates.map(gate => gate.name) : [],
  }
}

/** Env for repository commands: scripts can scope their work to the objects this Ticket actually mentions. */
function ticketEnvOf(ticket, repo) {
  return {
    SUPERAGENT_TICKET_ID: ticket.id,
    SUPERAGENT_TICKET_TITLE: String(ticket.title ?? ''),
    SUPERAGENT_TICKET_BODY: String(ticket.body ?? ''),
    SUPERAGENT_REPO_ID: String(repo.id ?? ''),
  }
}

/**
 * Step logger + atomic persist shared by every run. Each step refreshes `leaseAt` and the checkpoint (reconcile /
 * resume evidence); each persist writes the full operation to the external ledger and the index row to the state doc.
 */
function createRunRecorder({ engine, ticket, ticketId, run, log = /** @type {(line: string) => void} */ (() => {}), label = 'executor' }) {
  const step = (name, detail) => {
    const at = new Date().toISOString()
    /** @type {any[]} */
    const steps = run.steps ?? []
    run.steps = steps
    steps.push({ name, at, ...detail })
    run.leaseAt = at
    run.checkpoint = checkpointOf(run, name, detail ?? {}, at)
    log(`${label} ${ticketId}: ${name}${detail && detail.state ? ` ${detail.state}` : ''}`)
  }
  const persist = async () => {
    // A plugin reload may stop this engine while the run is in flight: `reconcile()` already marked it interrupted in
    // the document the next engine loaded, and writing this stale whole-document copy would undo that (D2-05).
    if (engine?.disposed === true) return
    const operations = await ensureStore(engine, 'operations', OperationStore)
    if (operations) await operations.save(run)
    await engine.state.atomic((doc) => {
      // The in-flight copy predates any automation/updatedAt edit; only the run's own fields may win over the
      // document (otherwise flipping a schedule during a run silently reverts it on the next persist).
      const { automation: _staleAutomation, updatedAt: _staleUpdatedAt, ...runFields } = ticket
      doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...runFields, updatedAt: new Date().toISOString() }
      // The ledger holds the full operation; the state document keeps only the light index row. Without a ledger
      // (bare test engine) the full run stays in the state document so the resume paths keep working.
      const entry = operations ? summarizeRun(run) : run
      doc.runs = [entry, ...(doc.runs ?? []).filter(item => item.id !== run.id)].slice(0, 100)
    })
  }
  return { step, persist }
}

/**
 * Failed gates of one gate phase, joined with their repository configuration (onFail / repairHint).
 * @param {any} options
 */
function failedGatesOf({ repo, gatePhase }) {
  const configured = new Map((repo.gates ?? []).map(gate => [gate.name, gate]))
  return (gatePhase.gates ?? [])
    .filter(item => item.exitCode !== 0 || item.missingEvidence === true)
    .map(item => ({ name: item.name, command: item.command, exitCode: item.exitCode,
      timedOut: item.timedOut === true, durationMs: item.durationMs, output: item.output,
      gate: configured.get(item.name) ?? {} }))
}

/** A timed-out gate or one whose command could not start is an infrastructure error: never auto-repaired. */
const isErroredGate = failure => failure?.timedOut === true || failure?.exitCode === 127

/**
 * Repair worker task: the original worker task plus the failed gate evidence and the configured repair hint.
 * @param {any} options
 */
function repairTaskOf({ task, failures }) {
  const lines = ['', '上一轮闸门失败，请只修复下列问题：不要提交、不要推送、不要合并，也不要运行导出/部署脚本。']
  for (const failure of failures) {
    lines.push('', `闸门 ${failure.name}：exit ${failure.exitCode}${failure.timedOut ? '（超时）' : ''}`)
    const output = String(failure.output ?? '')
    if (output) lines.push('失败输出（末尾 4000 字）：', output.slice(-4000))
    if (failure.gate?.repairHint) lines.push(`修复提示：${failure.gate.repairHint}`)
  }
  return `${task}\n${lines.join('\n')}`
}

/**
 * Resolve symlinks for the deepest existing ancestor of a path, then re-append the segments that do not exist yet.
 * `realpath` alone rejects a configured gate directory the worker is about to create; a string-only prefix check misses
 * a symlink created inside the worktree (review P1 AC-10).
 */
async function realCandidate(path) {
  let current = resolve(path)
  const suffix = []
  for (;;) {
    try {
      return join(await realpath(current), ...suffix)
    } catch {
      const parent = dirname(current)
      if (parent === current) return resolve(path)
      suffix.unshift(basename(current))
      current = parent
    }
  }
}

/** True when `candidate` really lives under `root` after symlinks are resolved on both sides. */
async function insideRealRoot(root, candidate) {
  const realRoot = await realCandidate(root)
  const real = await realCandidate(candidate)
  return real === realRoot || real.startsWith(`${realRoot}${sep}`)
}

/**
 * The dependency bootstrap a fresh worktree needs before the frontend gate can run. Shared by the run gates, a gate
 * resume and publish: publish used to skip it, so the frontend gate failed on a checkout without node_modules at the
 * very step before the commit.
 * → {} when nothing was needed or it succeeded | { error } with code `stopped` / `bootstrap_failed`
 */
async function runGateBootstrap({ repo, config, command, cwd, dryRun, step, signal }) {
  const gateNames = (repo.gates ?? []).map(gate => gate.name)
  if (!gateNames.includes('frontend')) return {}
  step('bootstrap:pnpm', { state: 'running', command: 'pnpm install --frozen-lockfile' })
  const bootstrap = await command('pnpm install --frozen-lockfile', { cwd, timeoutMs: config.executor.gateTimeoutMs, signal })
  if (bootstrap.aborted) {
    // The step was opened as `running`; a stop leaves it there forever unless the terminal state is recorded, which
    // made an interrupted bootstrap look like it was still installing to anything reading the run record.
    step('bootstrap:pnpm', { state: 'stopped', aborted: true, exitCode: bootstrap.exitCode,
      detail: 'stop requested during pnpm bootstrap' })
    return { error: { code: 'stopped', message: 'stop requested during pnpm bootstrap' } }
  }
  if (bootstrap.exitCode !== 0 && dryRun) {
    // A dry run rehearses the gates, it does not bootstrap a toolchain: a dependency install that cannot run (no
    // pnpm, no lockfile, no network) is carried into the verdict as a warning, and a gate that then misses its
    // node_modules fails as an ordinary gate failure — a human decision — instead of killing the run with a fatal
    // `bootstrap_failed` the operator can only fix by editing live.json.
    step('bootstrap:pnpm', { state: 'warn', exitCode: bootstrap.exitCode,
      detail: 'dry run: dependency install failed, gates run anyway' })
    return {}
  }
  step('bootstrap:pnpm', { state: bootstrap.exitCode === 0 ? 'ok' : 'failed', exitCode: bootstrap.exitCode })
  if (bootstrap.exitCode !== 0) {
    return { error: { code: 'bootstrap_failed', message: `pnpm install failed (exit ${bootstrap.exitCode})` } }
  }
  return {}
}

/**
 * Run every gate of the repository on the worktree and collect the evidence. Returns `{ gates, failure }` when a gate
 * fails (the caller parks the run for a human) and `{ gates, error }` when the dependency bootstrap itself broke (a
 * fatal bootstrap_failed, not a human gate decision). A fresh worktree has no node_modules, so the frontend gate needs
 * a pnpm install first — the same condition applies to executeTicket and to a `resume retry`.
 */
async function runGatePhase({ repo, config, command, cwd, paths, dryRun, step, signal }) {
  const commands = gateCommands(repo, config)
  const gateNames = (repo.gates ?? []).map(gate => gate.name)
  const gates = []
  const bootstrap = await runGateBootstrap({ repo, config, command, cwd, dryRun, step, signal })
  if (bootstrap.error) return { gates, error: bootstrap.error }
  for (const name of gateNames) {
    const spec = commands[name]
    if (!spec) continue
    // A fresh worktree has untracked new files; `--changed`-style git diff would miss them. Passing the executor's
    // own changed-path list makes the gate validate exactly what the worker changed.
    const gateCommand = gateCommandFor(spec, { paths, dryRun })
    // A configured gate directory must stay inside the worktree. live-json.js rejects escapes at save time; this is
    // the runtime backstop for a config file edited by hand or a symlink that appeared later.
    const root = resolve(cwd)
    const gateCwd = spec.cwd ? resolve(root, spec.cwd) : root
    if (!(await insideRealRoot(root, gateCwd))) {
      return { gates, error: { code: 'invalid_gate_cwd', message: `gate ${name} cwd escapes the worktree: ${spec.cwd}` } }
    }
    step(`gate:${name}`, { state: 'running', command: gateCommand, ...(spec.cwd ? { cwd: spec.cwd } : {}) })
    const result = await command(gateCommand, { cwd: gateCwd, timeoutMs: spec.timeoutMs, signal,
      ...(spec.requireOutput ? { requireOutput: spec.requireOutput } : {}) })
    if (result.aborted) {
      step(`gate:${name}`, { state: 'stopped', aborted: true, exitCode: result.exitCode,
        detail: `stop requested during gate ${name}` })
      return { gates, error: { code: 'stopped', message: `stop requested during gate ${name}` } }
    }
    const missingEvidence = evidenceMissing(spec, result)
    gates.push({ name, command: gateCommand, at: new Date().toISOString(),
      state: result.exitCode === 0 && !missingEvidence ? 'passed' : 'failed',
      exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
      output: result.output, ...(typeof result.markerSeen === 'boolean' ? { markerSeen: result.markerSeen } : {}),
      ...(missingEvidence ? { missingEvidence: true } : {}) })
    step(`gate:${name}`, { state: result.exitCode === 0 && !missingEvidence ? 'ok' : 'failed', exitCode: result.exitCode,
      timedOut: result.timedOut, durationMs: result.durationMs,
      ...missingEvidence ? { detail: `missing evidence: ${spec.requireOutput}` } : {} })
    if (result.exitCode !== 0 || missingEvidence) {
      return { gates, failure: { name, command: gateCommand, exitCode: result.exitCode, timedOut: result.timedOut,
        durationMs: result.durationMs, output: result.output } }
    }
  }
  return { gates }
}

/**
 * Park a run on a failed gate: a human decides through resumeTicket; nothing is committed or pushed.
 * @param {any} options
 */
async function parkOnGateFailure({ ticket, run, failure, paths, step, persist, repairError }) {
  const at = new Date().toISOString()
  run.gates = run.gates ?? []
  run.status = 'waiting_for_human'
  run.stopReason = 'gate_failed'
  run.errorCode = 'gate_failed'
  run.pendingGate = {
    name: failure.name,
    command: failure.command,
    exitCode: failure.exitCode,
    timedOut: failure.timedOut === true,
    ...Number.isFinite(failure.durationMs) ? { durationMs: failure.durationMs } : {},
    outputTail: String(failure.output ?? ''),
    changedPaths: [...paths],
    ...repairError ? { repairError: clipSummary(String(repairError)).slice(0, 500) } : {},
    at,
  }
  ticket.status = 'gate-blocked'
  ticket.pendingGate = run.pendingGate
  ticket.updatedAt = at
  const assignment = ticket.assignments?.at(-1)
  if (assignment) assignment.report = { state: 'waiting', text: `等待人工处理闸门 ${failure.name}`, at }
  addActivity(ticket, { kind: 'gate', actorKind: 'system', from: 'working', to: 'gate-blocked',
    detail: `闸门 ${failure.name} 未通过 (exit ${failure.exitCode}${failure.timedOut ? ', timeout' : ''})`,
    at, refs: { runId: run.id } })
  step('awaiting-human', { state: 'waiting', gate: failure.name })
  await persist()
}

/**
 * Shared catch body: mark the run/Ticket failed and record the contract stopReason/errorCode pair.
 * @param {any} options
 */
function failRun({ run, ticket, error, step, engine }) {
  const message = messageOf(error)
  const code = error instanceof StageError ? error.code : (run.errorCode ?? 'error')
  // A worker that vanished is infrastructure, not a bad change: keep the worktree and leave the Ticket retryable so a
  // fresh run can resume on the same branch instead of the executor waiting on a `working` Ticket forever.
  const retryable = code === 'worker_lost'
  // A stop request addressed the run that just ended; leaving it armed made the next run stop in `checkStop` before it
  // did any work (only the stopped path cleared it through confirmStopOnAuthoritative).
  const stateTicket = engine?.state?.tickets?.[ticket.id]
  if (ticket.stopRequested || stateTicket?.stopRequested) {
    delete ticket.stopRequested
    if (stateTicket) {
      engine?.clearStopRequest?.(ticket.id)
      delete stateTicket.stopRequested
    }
  }
  run.status = 'failed'
  run.error = message
  run.stopReason = code
  run.errorCode = code
  ticket.status = retryable ? 'ready' : 'failed'
  ticket.updatedAt = new Date().toISOString()
  const assignment = ticket.assignments?.at(-1)
  if (assignment) {
    assignment.state = 'ended'
    assignment.endedAt = ticket.updatedAt
    assignment.report = { state: 'failed', text: message.slice(0, 2000), at: ticket.updatedAt }
  }
  step('error', { state: 'failed', message, ...(retryable ? { retryable: true } : {}) })
  if (retryable) {
    addActivity(ticket, { kind: 'run', actorKind: 'system',
      detail: 'worker 失联：run 判失败，工单保持可重试并保留 worktree', refs: { runId: run.id } })
  }
  markRunComplete({ run, ticket, to: ticket.status, summary: message, detail: `run failed: ${code}${retryable ? ' (retryable)' : ''}` })
}

/**
 * Record a stop confirmation on the authoritative Ticket and clear the durable request there. `persist()` merges the
 * captured ticket into a *fresh* copy of the state entry, so deleting `stopRequested` only on the captured object
 * leaves the request armed and the panel stuck on "正在停止" (review P1 AC-03).
 */
function confirmStopOnAuthoritative(engine, ticketId, ticket, run, at = new Date().toISOString()) {
  const stateTicket = engine?.state?.tickets?.[ticketId]
  const requested = stateTicket?.stopRequested && typeof stateTicket.stopRequested === 'object'
    ? stateTicket.stopRequested
    : (ticket?.stopRequested && typeof ticket.stopRequested === 'object' ? ticket.stopRequested : {})
  ticket.stop = { ...requested, confirmedAt: at, runId: run.id }
  delete ticket.stopRequested
  if (stateTicket) {
    engine?.clearStopRequest?.(ticketId)
    delete stateTicket.stopRequested
  }
  return ticket.stop
}

/**
 * AC-03/04: one stop finalisation shared by the first run, a gate resume and a checkpoint resume. Confirming a stop
 * must clear the durable request, record the confirmation and the resumable worktree, and freeze the stopped round as
 * evidence — otherwise the panel keeps showing "正在停止" after the child already exited.
 */
async function finalizeStoppedRun({ engine, ticket, run, repo, step, persist, detail }) {
  const at = new Date().toISOString()
  run.status = 'stopped'
  run.stopReason = 'stopped'
  run.stoppedAt = at
  // `persist()` replaces the state entry with a copy, so the stop request may only exist on the authoritative record.
  // Read it there for the audit facts, and clear it there too — otherwise the panel keeps showing "正在停止".
  confirmStopOnAuthoritative(engine, ticket.id, ticket, run, at)
  ticket.status = 'ready'
  ticket.updatedAt = at
  const assignment = ticket.assignments?.at(-1)
  if (assignment) {
    assignment.state = 'ended'
    assignment.endedAt = at
    assignment.report = { state: 'stopped', text: '已按人工请求停止；工作树与已完成步骤保留', at }
  }
  step('stop', { state: 'ok', message: 'stopped by an operator', at,
    phase: detail?.phase ?? run.checkpoint?.phase, worktree: run.worktree, branch: run.branch,
    baseSha: run.baseSha, changedPaths: run.changedPaths })
  addActivity(ticket, { kind: 'run', actorKind: 'human', detail, at, refs: { runId: run.id } })
  await persist().catch(() => {})
  // The stopped round is evidence too: the next round must be comparable even after the worktree is gone.
  await recordDeliveryEvidence({ engine, ticket, run, repo })
}

/**
 * AC-08: freeze one bounded, sanitised evidence round before the worktree can be removed. A failure to record evidence
 * never fails a delivery that already happened — the panel reports the missing round instead of inventing one.
 */
async function recordDeliveryEvidence({ engine, ticket, run, repo }) {
  if (engine?.disposed === true) return
  if (typeof engine?.evidence?.record !== 'function') return
  let patch
  let diffFiles = []
  try {
    const diff = /** @type {any} */ (await worktreeDiff({ worktree: run.worktree ?? ticket.links?.worktree,
      baseSha: run.baseSha, limits: { bytes: 24_000, files: 60 } }))
    if (diff?.available) {
      // `worktreeDiff` returns the patch under `diff` (not `text`); the per-file digests catch a second edit of the
      // same path, which a path-only list cannot show.
      patch = { text: diff.diff, truncated: diff.truncated === true, omitted: diff.omitted, bytes: diff.bytes }
      diffFiles = Array.isArray(diff.files) ? diff.files : []
    }
  } catch { /* the worktree may already be gone; the round still records files/gates */ }
  const fileMap = new Map(diffFiles.map(file => [file.path, file]))
  for (const path of run.changedPaths ?? []) if (!fileMap.has(path)) fileMap.set(path, { path })
  const mr = ticket.links?.mergeRequest ?? {}
  const prState = mr.state === 'merged' ? 'merged'
    : mr.state === 'closed' ? 'closed'
      : mr.iid ? 'open' : mr.webUrl ? 'waiting' : 'none'
  // The plan's acceptance criteria are the requirements; falling back to the gate names would relabel gates as
  // requirements (review finding AC-09).
  const planOfRun = (run.workflow?.stages ?? []).filter(stage => stage.role === 'plan' && stage.result).at(-1)?.result
  const codeFingerprint = run.workflowDigest ?? run.headSha ?? ticket.links?.commit ?? ticket.links?.push?.sha
  const requirements = Array.isArray(planOfRun?.acceptanceCriteria) && planOfRun.acceptanceCriteria.length
    ? planOfRun.acceptanceCriteria.map(item => `${item.id ?? ''} ${item.requirement ?? ''}`.trim()).filter(Boolean)
    : (ticket.revisions ?? []).map(revision => String(revision?.text ?? '').trim()).filter(Boolean)
  try {
    await engine.evidence.record(ticket.id, {
      id: `ev_${run.id}`,
      runId: run.id,
      at: new Date().toISOString(),
      branch: run.branch,
      baseSha: run.baseSha,
      headSha: ticket.links?.commit ?? mr.headSha,
      files: [...fileMap.values()],
      patch,
      // Tie every gate result to the tree it validated; a later code change invalidates this evidence.
      gates: (run.gates ?? []).map(gate => ({ ...gate,
        ...(gate.codeFingerprint ? {} : { codeFingerprint }) })),
      workerSummary: run.worker?.text ?? run.handoff?.summary,
      acceptance: { requirements },
      platform: { pushed: Boolean(ticket.links?.push), pr: { state: prState, iid: mr.iid, webUrl: mr.webUrl },
        merged: ticket.status === 'merged' || mr.state === 'merged',
        // A deployment is only claimed when the ticket really reached that state (AC-05), never from a stray record.
        deployed: ticket.status === 'deployed',
        ...(ticket.links?.deployment?.commit ? { deployCommit: ticket.links.deployment.commit } : {}),
        ...(ticket.links?.deployment?.sha ? { deployedSha: ticket.links.deployment.sha } : {}),
        ...(typeof ticket.links?.deployment?.matchesHead === 'boolean'
          ? { matchesHead: ticket.links.deployment.matchesHead } : {}),
        ...(ticket.links?.deployment ? { deployment: ticket.links.deployment } : {}),
        accepted: ticket.links?.acceptance?.ok === true },
    })
  } catch (error) { engine.log?.(`record delivery evidence ${ticket.id} failed: ${messageOf(error)}`) }
}

/**
 * Shared finalize segment of the pipeline: post-gates export, dry-run/allowPush exits, worktree guard, commit, push,
 * merge request and the final Ticket status. executeTicket and resumeTicket both call this — never duplicate it.
 * Every fatal step throws a StageError so the caller's failRun records the contract code.
 */
async function finishPipeline({ engine, loaded, config, repo, ticket, run, worktree, dryRun, allowPush, token, deps, step,
  persist, ticketEnv, checkStop = () => {}, stopRequested = () => false, signal }) {
  const command = deps.runCommand ?? runCommand
  const pathsOf = deps.changedPaths ?? changedPaths
  const changes = deps.hasChanges ?? hasChanges
  const commit = deps.commitAll ?? commitAll
  const safe = deps.assertSafeWorktree ?? assertSafeWorktree
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient

  // AC-03: every mutating segment re-checks the durable stop flag. A stop that arrives during the export must not
  // continue into commit/push, and a stop between push and MR must keep the pushed evidence instead of throwing.
  checkStop()
  if (!dryRun && repo.postGatesCommand) {
    step('export-repo', { state: 'running', command: repo.postGatesCommand })
    const exported = await command(repo.postGatesCommand, { cwd: worktree.path, timeoutMs: config.executor.timeoutMs,
      signal, env: { ...ticketEnv, SUPERAGENT_CHANGED_PATHS: JSON.stringify(run.changedPaths ?? []) } })
    step('export-repo', { state: exported.exitCode === 0 ? 'ok' : 'failed', exitCode: exported.exitCode })
    if (exported.aborted) throw new StageError('stopped', 'stop requested during postGatesCommand')
    if (exported.exitCode !== 0) throw new StageError('bootstrap_failed', `postGatesCommand failed (exit ${exported.exitCode})`)
    run.changedPaths = await pathsOf(worktree.path, worktree.baseSha)
  }

  // The review-evidence rule belongs to the staged shape. `run.workflow` exists only when THIS run implemented and
  // delivered through a workflow, so that is the precondition: a plain run (workflowMode off, or a report/read-only
  // route) has no evidence to compare, and a workflow an earlier round left on the Ticket must stay inert for it —
  // otherwise the leftover record (blocked at plan, never digested) fails every later run after the gates and before
  // commit/push. The record itself is preserved: a staged round decides whether to replace or resume it.
  if (run.workflow?.status === 'ready' && (!ticket.workflowDigest || ticket.workflowDigest !== await (deps.candidateDigest ?? candidateDigest)(worktree.path))) throw new StageError('review_stale', 'Workflow evidence is missing or stale; rerun the workflow')

  if (dryRun) {
    run.status = 'dry-run'
    ticket.status = 'ready'
    run.stopReason = 'done'
    step('finish', { state: 'ok', detail: 'dry run: gates passed, nothing pushed' })
    markRunComplete({ run, ticket, to: 'ready', detail: 'dry run finished: gates passed, nothing pushed' })
    await persist()
    // A dry run is a delivery rehearsal: keep its gate evidence so the next round can be compared with it.
    await recordDeliveryEvidence({ engine, ticket, run, repo })
    return
  }
  if (!allowPush) {
    // D2-06: `allowPush` decides whether the work leaves the machine, not whether it happens. A real run with push
    // disabled still guards and commits locally, so "gates passed, not pushed" is a delivered local commit a human can
    // publish later — not a dirty worktree whose work only exists until the next run overwrites it.
    checkStop()
    try {
      await safe({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix, baseSha: worktree.baseSha,
        extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
    } catch (error) { throw new StageError('guard_failed', messageOf(error)) }
    checkStop()
    if (await changes(worktree.path)) {
      let commitResult
      try {
        commitResult = await commit({ cwd: worktree.path, message: commitMessageFor(ticket), authorName: 'Superagent',
          authorEmail: 'superagent@local' })
      } catch (error) { throw new StageError('commit_failed', messageOf(error)) }
      run.commit = commitResult
      ticket.links = { ...ticket.links, commit: commitResult.sha }
      step('commit', { state: 'ok', sha: commitResult.sha })
      await persist()
    }
    run.status = 'gates-passed'
    ticket.status = 'ready'
    run.stopReason = 'done'
    step('finish', { state: 'ok', detail: 'executor.allowPush=false: committed locally, push skipped' })
    markRunComplete({ run, ticket, to: 'ready', detail: 'gates passed; committed locally; push skipped (allowPush=false)',
      nextAction: 'enable executor.allowPush and publish, or dismiss the Ticket' })
    await persist()
    await recordDeliveryEvidence({ engine, ticket, run, repo })
    return
  }

  checkStop()
  try {
    await safe({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix, baseSha: worktree.baseSha,
      extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
  } catch (error) { throw new StageError('guard_failed', messageOf(error)) }

  checkStop()
  const workingChanges = await changes(worktree.path)
  if (workingChanges) {
    let commitResult
    try {
      commitResult = await commit({ cwd: worktree.path, message: commitMessageFor(ticket), authorName: 'Superagent',
        authorEmail: 'superagent@local' })
    } catch (error) { throw new StageError('commit_failed', messageOf(error)) }
    run.commit = commitResult
    ticket.links = { ...ticket.links, commit: commitResult.sha }
    step('commit', { state: 'ok', sha: commitResult.sha })
    // Persist remote-visible progress as it happens: a plugin reload after this point must not lose the commit.
    await persist()
  }

  const mrMode = repo.gitlab.createMr === 'push' ? 'push' : 'api'
  if (mrMode === 'api' && !token) {
    throw new StageError('mr_failed', `gitlab token is not configured for ${repo.name} (set gitlab.createMr=push to open the MR without an API token)`)
  }
  checkStop()
  // AC-04: a resumed delivery must reconcile before retrying. Local push evidence is only reused when the remote still
  // has that exact HEAD (or the remote cannot be read); a missing branch is pushed again instead of assumed delivered.
  const head = await headOf(worktree.path, deps)
  const pendingPush = await reconcilePendingPush({ ticket, cwd: worktree.path, branch: worktree.branch, head, repo, deps, persist })
  if (pendingPush.state === 'unknown') {
    throw new StageError('push_failed',
      `a previous push to origin/${worktree.branch} has an unknown result; reconcile it before retrying`)
  }
  const priorPush = ticket.links?.push && typeof ticket.links.push === 'object' ? ticket.links.push : undefined
  const readRemote = () => remoteHeadOf({ cwd: worktree.path, branch: worktree.branch, deps })
  const localSaysPushed = !workingChanges && Boolean(priorPush?.sha) && Boolean(head) && head === priorPush.sha
  let reusePush = localSaysPushed
  if (localSaysPushed) {
    const remote = await readRemote()
    if (remote.checked && remote.sha !== head) reusePush = false
  }
  let pushed
  let mr
  // Record the request before the remote action, then the confirmed result: a lost response is never mistaken for
  // "nothing happened", so a resume can reconcile the remote SHA instead of blindly pushing again.
  const pushAndReconcile = async (pushOptions = []) => {
    const result = await deliverPush({ ticket, cwd: worktree.path, branch: worktree.branch, repo, deps, persist, pushOptions })
    pushed = result
    run.push = result
    step('push', { state: 'ok', branch: result.branch, sha: result.sha,
      ...(result.reconciled ? { detail: 'push response lost; remote HEAD reconciled' } : {}) })
    await persist()
    return result
  }
  // A reused push with no MR yet still has to run the API branch; only skip the whole delivery step when the MR is known.
  const reuseWithoutMr = reusePush && mrMode === 'api' && !ticket.links?.mergeRequest?.iid
  // A stored MR carries this delivery only while it is opened, still points at HEAD, or predates `state` (older
  // tickets). A merged MR the branch has moved past and a closed MR cannot: the merge already took the older commits
  // into the target branch, so re-delivering after a failure needs a fresh MR.
  const storedMr = ticket.links?.mergeRequest
  const storedMrHead = storedMr?.sha ?? storedMr?.diffRefs?.headSha ?? storedMr?.headSha
  const reusableStoredMr = !storedMr?.iid || !storedMr.state || storedMr.state === 'opened'
    || (storedMr.state === 'merged' && (!head || !storedMrHead || storedMrHead === head))
  const needsNewMr = mrMode === 'api' && Boolean(storedMr?.iid) && !reusableStoredMr
  if (reusePush && !reuseWithoutMr && !needsNewMr) {
    pushed = priorPush
    run.push = { ...priorPush, reused: true }
    run.changedPaths = run.changedPaths ?? []
    ticket.links = { ...ticket.links, commit: priorPush.sha }
    clearPushRequest(ticket)
    step('push', { state: 'ok', detail: 'HEAD already pushed; reused remote evidence', sha: priorPush.sha })
    await persist()
    if (mrMode === 'api' && ticket.links?.mergeRequest?.iid) {
      mr = ticket.links.mergeRequest
      step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl, detail: 'already opened' })
    }
  } else if (mrMode === 'push') {
    pushed = await pushAndReconcile(usesPushOptionMr(repo) ? pushOptionsFor(ticket, repo) : [])
    mr = pushed.mergeRequest
    // The push already happened and its evidence is saved; a stop arriving now skips the MR step but must not throw
    // the delivery away or make the panel pretend the branch was never pushed.
    if (stopRequested()) {
      step('merge-request', { state: 'skipped', detail: 'stop requested after push; MR step skipped' })
    } else if (mr?.webUrl) step('merge-request', { state: 'ok', webUrl: mr.webUrl, mode: 'push' })
    else step('merge-request', { state: 'pending', detail: usesPushOptionMr(repo)
      ? 'MR created via push options; GitLab did not print its URL'
      : 'branch pushed; the remote printed no create-PR link' })
    linkMergeRequest(ticket, mr, { mode: 'push', pending: !mr?.webUrl, headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
  } else {
    // No reused evidence: this HEAD still needs its own push (a new commit, or the MR API never got a chance).
    if (!reusePush) {
      pushed = await pushAndReconcile()
    } else {
      pushed = priorPush
      run.push = { ...priorPush, reused: true }
      clearPushRequest(ticket)
      step('push', { state: 'ok', detail: 'HEAD already pushed; reused remote evidence', sha: priorPush.sha })
    }
    const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
    try {
      if (stopRequested()) {
        step('merge-request', { state: 'skipped', detail: 'stop requested after push; MR step skipped' })
      } else {
        // The API call may have succeeded before a lost response. Look the source branch up first, so a resume adopts
        // that MR instead of opening a duplicate. A failed lookup is *not* "no MR exists": it must not create one.
        const opened = await openOrAdoptMergeRequest({ gitlab, sourceBranch: worktree.branch,
          targetBranch: repo.gitlab.targetBranch, title: `Superagent: ${ticket.title}`,
          description: mergeRequestDescription(ticket, run), headSha: pushed.sha })
        mr = opened.mr
        step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl,
          ...(opened.adopted ? { detail: 'adopted existing merge request' } : {}) })
        linkMergeRequest(ticket, mr, { mode: 'api', headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
        await persist()
      }
    } catch (error) {
      // The branch is already pushed: an MR failure is recorded but does not undo the delivery.
      run.mergeRequestError = messageOf(error)
      run.stopReason = 'mr_failed'
      run.errorCode = 'mr_failed'
      if (error?.code === 'mr_lookup_failed') {
        // Unknown is a first-class state: keep the create entry and an explicit unverified marker for the operator.
        run.mergeRequestUnknown = true
        ticket.links = { ...ticket.links, mergeRequest: { ...(ticket.links?.mergeRequest ?? {}), pending: true,
          unverified: true, headSha: pushed?.sha ?? ticket.links?.commit } }
        step('merge-request', { state: 'unknown', message: run.mergeRequestError })
        await persist().catch(() => {})
      } else {
        // The branch is on the remote but no MR exists: record the failure on the Ticket as well, otherwise the run
        // reads as a finished delivery and its evidence claims success (the panel only had run.errorCode to go on).
        run.mergeRequestUnconfirmed = true
        ticket.links = { ...ticket.links, mergeRequest: { ...(ticket.links?.mergeRequest ?? {}), pending: true,
          unverified: true, error: run.mergeRequestError, headSha: pushed?.sha ?? ticket.links?.commit } }
        step('merge-request', { state: 'failed', message: run.mergeRequestError })
        await persist().catch(() => {})
      }
    }
  }
  const ciObservable = Boolean(token) && repo.gitlab.ci !== false
  const opened = Boolean(ticket.links?.mergeRequest?.webUrl || ticket.links?.mergeRequest?.iid)
  // Adopting an already-merged MR must not drag a delivered ticket back to ci-pending/mr-open: the merge is the
  // strongest fact this path can learn, and re-stamping it as pending made merged tickets look unmerged.
  const mergedNow = mr?.state === 'merged' || ticket.links?.verification?.merged === true
  // `merged` is a fact this pass must have learned. Keeping it just because the Ticket said so left a re-linked Ticket
  // labelled merged while its new MR was still opened (the verification link above was cleared, the status was not).
  if (ticket.status === 'deployed') ticket.status = 'deployed'
  else if (mergedNow) ticket.status = 'merged'
  else ticket.status = opened ? (ciObservable ? 'ci-pending' : 'mr-open') : 'pushed'
  // A create that failed is an MR failure, not a delivered run: the Ticket keeps its pushed branch, the run does not
  // claim success, and the panel can offer a retry.
  run.status = run.mergeRequestUnconfirmed ? 'failed' : ticket.status
  if (!run.errorCode) run.stopReason = 'done'
  markRunComplete({ run, ticket, to: ticket.status, detail: `delivered: ${ticket.status}` })
  await persist()
  // Evidence is written while the worktree still exists, then survives its cleanup and the ledger window (AC-08).
  await recordDeliveryEvidence({ engine, ticket, run, repo })
  // A stop that arrived after the push skipped the MR: the delivery still ended here, so confirm the stop on the
  // authoritative entry instead of leaving the durable request armed for the next run.
  if (stopRequested()) {
    confirmStopOnAuthoritative(engine, ticket.id, ticket, run)
    await persist()
  }
  if (opened && config.executor.allowReply) await replyToSource(engine, config, loaded, ticket, run, repo)
}

/**
 * Probe the backends the candidate bots could use (worker-bots spec §3.6). P2 ships the in-process DSH
 * backend only: every other backend has no probe, stays `unverified`, and is therefore never a dispatch candidate.
 * Tools depend on the agent preset, so the probe is keyed `backend|preset` with the backend's default as fallback.
 */
async function probesForRun({ ctx, bots, fallbackPreset, backends = ['dsh'], stateDir }) {
  const presets = new Set()
  if (fallbackPreset) presets.add(fallbackPreset)
  for (const bot of bots) {
    if (typeof bot?.preset === 'string' && bot.preset) presets.add(bot.preset)
  }
  const probes = {}
  // Every enabled backend gets a probe: a CLI backend's evidence is its smoke ledger (§3.5), and without a probe it
  // stays `unverified` and cannot be dispatched onto (§3.7).
  for (const backend of backends) {
    probes[backend] = await probeBackend({ backend, ctx, stateDir,
      ...(backend === 'dsh' ? { preset: fallbackPreset } : {}) })
  }
  for (const preset of presets) {
    if (preset !== fallbackPreset) probes[`dsh|${preset}`] = await probeBackend({ backend: 'dsh', ctx, preset, stateDir })
  }
  return probes
}

/** The durable `run.bot` record (§7.5): who ran it, from which layer, why, and what the bot can do. */
function botRecordOf(result, at, backend) {
  if (!result) return undefined
  return {
    id: result.botId ?? null,
    ...(backend ? { backend } : {}),
    source: result.source,
    reason: result.reason,
    ...(result.degraded ? { degraded: result.degraded } : {}),
    candidates: Array.isArray(result.candidates) ? result.candidates.slice() : [],
    capability: Array.isArray(result.capability) ? result.capability.slice() : [],
    capabilitySource: result.capabilitySource ?? 'fallback',
    ...(result.verifiedAt ? { verifiedAt: result.verifiedAt } : {}),
    configDigest: result.configDigest,
    resolvedAt: at,
    ...(result.synthesizedFrom ? { synthesizedFrom: result.synthesizedFrom } : {}),
    ...(result.resolved ? { resolved: result.resolved } : {}),
  }
}

/** Execute one ticket end to end. Returns the final run record (parked when a gate or a question needs a human). */
export async function executeTicket(options) {
  return withTicketClaim(options.ticketId, 'executing', () => executeTicketInner(options))
}

/**
 * @param {any} options
 */
async function executeTicketInner({ ctx, engine, ticketId, dryRun = false, trigger = 'manual', extraContext,
  backend: backendOverride, deliverable: deliverableOverride, bot: botOverride,
  resumeWorkflow = false, log = () => {}, deps = /** @type {any} */ ({}) }) {
  const prepare = deps.prepareWorktree ?? prepareWorktree
  const workerRun = deps.runWorker ?? runWorker
  const cliRun = deps.runCliWorker ?? runCliWorker
  const command = deps.runCommand ?? runCommand
  const pathsOf = deps.changedPaths ?? changedPaths
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  // A confirmed stop (queued, or landing right before dispatch) must not be undone by an automatic dispatch: only an
  // explicit manual/resume/revise run is the operator starting over, so it clears the marker and proceeds (AC-03).
  const explicitRun = trigger === 'manual' || trigger === 'resume' || trigger === 'revise'
  if (ticket.stop && !explicitRun) {
    return { id: undefined, ticketId, dryRun, trigger, status: 'skipped', stopReason: 'stop-requested', steps: [] }
  }
  if (ticket.stop) delete ticket.stop
  // Finished work: a dismissed/closed Ticket keeps its automation object, and the scheduler refuses it too. Only an
  // explicit human run (manual/resume/revise) is the operator deciding to execute it again.
  if (!explicitRun && (ticket.status === 'dismissed' || ticket.status === 'closed')) {
    return { id: undefined, ticketId, dryRun, trigger, status: 'skipped', stopReason: 'ticket-finished', steps: [] }
  }
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  if (repo.enabled === false) throw new Error(`repository disabled: ${repo.id}`)
  // Routing decides who executes and with which bot; `suggest` records the decision but keeps the default backend.
  // A manual selection saved at creation time is the Ticket's default; a per-run override (reassign) wins over it.
  const selection = ticket.routeSelection && typeof ticket.routeSelection === 'object' ? ticket.routeSelection : {}
  const route = resolveRoute({ ticket, config, override: backendOverride ?? selection.backend,
    deliverableOverride: deliverableOverride ?? selection.deliverable })
  const execBackend = route.execBackend
  const execProfile = route.execProfile
  const backendOptions = config.executor.workers?.[execBackend] ?? {}
  // Worker bot ("Bot", worker-bots spec §4–§8): dispatch decides which bot runs this Ticket and the
  // decision is recorded on the run (`run.bot`) with its source and reason. Whatever the bot does not declare
  // falls through to the executor defaults, which keeps v1.0.x behaviour intact (AC1).
  const botBook = readBots(engine.stateDir, config)
  if (botBook.code) log(`executor: worker bots unusable (${botBook.code}): ${botBook.error}`)
  const probes = await probesForRun({ ctx, bots: botBook.bots,
    fallbackPreset: repo.workerPreset ?? config.executor.workerPreset, backends: enabledBackends(config),
    stateDir: engine.stateDir })
  const dispatched = await resolveDispatch(botOverride ? { ...ticket, botOverride } : ticket, config,
    botBook.bots, {
      probes,
      enabledBackends: enabledBackends(config),
      workType: route.workType,
      deliverable: route.deliverable,
      repoId: repo.id,
      source: ticket.source,
      decisionToken: loaded.tokens?.decision,
    })
  log(`executor: bot ${dispatched.botId ?? '(none)'} from ${dispatched.source}: ${dispatched.reason}`)
  // An ad-hoc decision carries the full synthesized bot (`resolved`); a saved one is looked up in the store.
  const bot = dispatched.botId
    ? dispatched.resolved ?? botBook.bots.find(item => item.id === dispatched.botId)
    : undefined
  const resolvedBot = bot ? resolveBot(bot, {
    preset: repo.workerPreset ?? config.executor.workerPreset,
    timeoutMs: config.executor.timeoutMs,
    idleTimeoutMs: config.executor.workerIdleTimeoutMs,
    readOnly: execProfile === 'read-only',
  }) : undefined
  const botParams = bot ? paramsOfBot(bot) : undefined
  const workerPreset = resolvedBot?.preset
  const workerModel = resolvedBot?.model ?? config.executor.model
  const reasoningEffort = botParams?.reasoningEffort
  const botDenyTools = resolvedBot?.denyTools
  const botAllowMcp = resolvedBot?.allowMcp
  const botSections = resolvedBot ? botPromptSections(resolvedBot.systemPromptExtra) : []
  const botStages = resolvedBot?.stages
  const workerTimeoutMs = resolvedBot?.budget.timeoutMs ?? config.executor.timeoutMs
  const workerIdleTimeoutMs = resolvedBot?.budget.idleTimeoutMs ?? config.executor.workerIdleTimeoutMs
  const maxRepairRounds = resolvedBot?.budget.maxRepairRounds
  const token = repoToken(loaded, repo)
  const ticketEnv = ticketEnvOf(ticket, repo)
  if (ticket.status === 'working') throw new Error(`ticket ${ticketId} is already working`)
  if (!dryRun && !config.executor.enabled) throw new Error('executor.enabled is false in live.json')
  const allowPush = !dryRun && config.executor.allowPush === true
  const runId = recordId('run')
  const at = new Date().toISOString()
  const reportFile = await prepareReportFile(engine, runId)
  const run = { id: runId, ticketId, dryRun, trigger, status: 'running', startedAt: at, leaseAt: at, steps: [],
    repo: repoSnapshot(repo),
    worktree: undefined, branch: undefined, mergeRequest: undefined, pipeline: undefined, error: undefined,
    repair: { attempts: 0, max: maxRepairRounds ?? repairBudgetOf(config), status: 'none' } }
  // §7.5: every run states which bot ran it, where that choice came from, and why. A refusal is recorded too, so
  // the panel can show a degraded decision instead of an unexplained failure.
  run.botId = dispatched.botId ?? null
  run.bot = botRecordOf(dispatched, at, bot?.backend)
  if (botOverride) run.botOverride = botOverride
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId, run, log })
  const fail = (code, message) => { run.stopReason = code; run.errorCode = code; return new StageError(code, message) }
  // §12: a run's trace is visible while it runs, including when an operator kills it (E5). The worker pushes events as
  // they happen; the final trace below replaces this streamed copy with the authoritative one.
  const liveTrace = liveTraceSink({ run, persist, log })
  // Stop is cooperative and cancellable: a durable flag is polled into an AbortSignal that ends the current worker or
  // shell command, while `checkStop` guards the gaps. Nothing after this point — repair, gates, commit, push, PR — runs
  // for a stopped Ticket. A queued Ticket stops before its worker.
  // A stopped engine (plugin reload) ends its in-flight runs too: reconcile() already marked them interrupted, so
  // finishing normally would rewrite the document the next engine owns (D2-05).
  const stopRequested = () => engine?.disposed === true || (typeof engine.isStopRequested === 'function'
    ? engine.isStopRequested(ticketId)
    : Boolean(engine.state?.tickets?.[ticketId]?.stopRequested))
  const checkStop = () => { if (stopRequested()) throw fail('stopped', 'stop requested by an operator') }
  // Stops must reach the process that is currently running, not just the next stage boundary. The controller is
  // aborted by a short poll of the durable stop flag and is threaded into the worker (agent.cancel / CLI SIGTERM) and
  // into every shell command; `checkStop` stays as the boundary guard. A stop is idempotent.
  const controller = new AbortController()
  const signal = controller.signal
  const stopPollMs = deps.stopPollMs ?? 200
  let stopTimer
  if (stopRequested()) controller.abort()
  else {
    stopTimer = setInterval(() => { if (stopRequested()) controller.abort() }, stopPollMs)
    stopTimer.unref?.()
  }

  // The route is part of the run record and of the Ticket: the panel shows who was suggested, who actually ran, and why.
  run.route = { workType: route.workType, bot: route.bot, deliverable: route.deliverable,
    capabilities: route.capabilities, backend: route.backend, reason: route.reason, mode: route.mode,
    applied: route.applied, execBackend, execProfile, ...(route.unsupported ? { unsupported: route.unsupported } : {}) }
  ticket.route = { ...run.route, at }

  const startedFrom = ticket.status
  ticket.status = 'working'
  ticket.updatedAt = at
  ticket.runId = runId
  if (!ticket.assignments) ticket.assignments = []
  ticket.assignments.push({ id: runId, state: 'running', startedAt: at, report: { state: 'progress', text: '执行器已启动', at } })
  addActivity(ticket, { kind: 'run', actorKind: 'system', from: startedFrom, to: 'working',
    detail: `run ${runId} (${trigger})`, at, refs: { runId } })
  await persist()

  try {
    // No usable bot is a refusal, not a default: starting work under a different bot than the one asked for
    // would silently change the run's constraints (§7.1). An explicit override that did not apply is the same refusal
    // even though the record keeps its id — running it would misreport what constrained the worker (AC4).
    // A store that cannot be read is a refusal, not an implicit "use the built-in bots" (§4.1): a corrupt or too-new
    // file is the operator's to repair, and running under bots nobody could see would hide it.
    if (botBook.code) {
      throw fail(botBook.code, `${botBook.error ?? 'Bot 文件不可用'}（${botBook.file ?? 'worker-bots.json'}）`)
    }
    if (!dispatched.botId) throw fail('DISPATCH_DEGRADED', `没有可用 Bot：${dispatched.reason}`)
    if (dispatched.source === 'explicit' && dispatched.degraded === 'explicit-unusable') {
      throw fail('DISPATCH_DEGRADED', `指定的 Bot 不可用：${dispatched.reason}`)
    }
    // A routed backend that lacks the capability the work type needs cannot run: fail loudly instead of silently
    // handing the Ticket to a worker that will do the wrong thing.
    if (route.applied && route.unsupported) {
      throw fail('route_unsupported', `backend ${route.backend} cannot run ${route.workType}: ${route.unsupported}`)
    }
  // §10.2: a stage may name another bot (and its own budget). The stage bot is judged by the same rules as the
  // whole-ticket bot — probe-verified backend, enabled, capabilities — and contributes only that stage's worker params.
  const stageBots = {}
  for (const entry of (resolvedBot?.stages ?? [])) {
    if (!entry || typeof entry !== 'object' || typeof entry.bot !== 'string') continue
    const stageBot = botBook.bots.find(item => item.id === entry.bot)
    if (!stageBot) throw fail('BOT_STAGES_INVALID', `阶段 ${entry.stage} 引用了不存在的 Bot：${entry.bot}`)
    const checked = validateBot(stageBot, environmentOf(stageBot, { probes, enabledBackends: enabledBackends(config) }))
    if (!checked.ok) throw fail(checked.code, `阶段 ${entry.stage} 的 Bot ${entry.bot}：${checked.message}`)
    const resolvedStageBot = resolveBot(stageBot, {
      preset: repo.workerPreset ?? config.executor.workerPreset,
      timeoutMs: config.executor.timeoutMs,
      idleTimeoutMs: config.executor.workerIdleTimeoutMs,
      readOnly: entry.stage !== 'implement',
    })
    stageBots[entry.stage] = {
      id: stageBot.id,
      backend: stageBot.backend,
      model: resolvedStageBot.model,
      preset: resolvedStageBot.preset,
      reasoningEffort: paramsOfBot(stageBot).reasoningEffort,
      denyTools: resolvedStageBot.denyTools,
      allowMcp: resolvedStageBot.allowMcp,
      // A stage budget overrides the §6 chain for that stage only (stage > stage bot > whole-ticket bot > executor).
      timeoutMs: entry.budget?.timeoutMs ?? resolvedStageBot.budget.timeoutMs,
      idleTimeoutMs: entry.budget?.idleTimeoutMs ?? resolvedStageBot.budget.idleTimeoutMs,
    }
  }
    checkStop()
    step('prepare-worktree', { state: 'running' })
    let worktree
    try {
      worktree = await prepare({ repo: repo.repo, worktreeRoot: repo.worktreeRoot, baseBranch: repo.baseBranch,
        featurePrefix: repo.featurePrefix, ticketId })
    } catch (error) { throw fail('prepare_failed', messageOf(error)) }
    run.worktree = worktree.path
    run.branch = worktree.branch
    run.baseSha = worktree.baseSha
    ticket.links = { ...ticket.links, branch: worktree.branch, worktree: worktree.path }
    step('prepare-worktree', { state: 'ok', branch: worktree.branch, path: worktree.path, reused: worktree.reused })
    await persist()

    if (!dryRun && repo.prepareCommand) {
      step('prepare-repo', { state: 'running', command: repo.prepareCommand })
      let prepared
      try {
        prepared = await command(repo.prepareCommand, { cwd: worktree.path, timeoutMs: config.executor.timeoutMs, env: ticketEnv,
          signal })
      } catch (error) { throw fail('prepare_failed', messageOf(error)) }
      step('prepare-repo', { state: prepared.exitCode === 0 ? 'ok' : 'failed', exitCode: prepared.exitCode })
      if (prepared.aborted) throw fail('stopped', 'stop requested during prepareCommand')
      if (prepared.exitCode !== 0) throw fail('prepare_failed', `prepareCommand failed (exit ${prepared.exitCode})`)
    }

    checkStop()
    // AC-01: the staged workflow exists to implement a code change. A manual report/read-only route must not enter it,
    // and the resolved backend — not the configured implementer — is the one that gets write access.
    const staged = config.executor.workflowMode && config.executor.workflowMode !== 'off'
      && route.deliverable === 'change' && execProfile === 'write'
    // A referenced Ticket's report belongs in both execution shapes; resolve it once, before the branch.
    const taskContext = workerContext(engine, ticket, extraContext ?? answerContext(ticket))
    if (staged) {
      delete ticket.workflowDigest
      const resumed = resumeWorkflow === true && Boolean(ticket.workflow)
      if (resumed) {
        // Gates are not re-run on resume, so record what the worktree currently changes for the run's diff view.
        run.changedPaths = await pathsOf(worktree.path, worktree.baseSha)
        const failed = [...ticket.workflow.stages].reverse().find(item => item?.status === 'failed')
        step('workflow:resume', { state: 'running', from: failed?.role, round: ticket.workflow.repairs })
      }
      // A bot's repair budget wins over executor.maxRepairRounds (§6); everything else keeps the old defaults.
      const workflowConfig = maxRepairRounds === undefined ? config
        : { ...config, executor: { ...config.executor, maxRepairRounds } }
      await executeWorkflow({ run, ticket, config: workflowConfig, cwd: worktree.path, backend: execBackend, bot: execProfile,
        brief: workerBrief(ticket, config, repo), task: workerTask(ticket, repo, taskContext),
        cli: cliRun,
        dsh: options => workerRun({ ctx, ...options,
          preset: options.preset ?? workerPreset,
          model: options.model ?? workerModel,
          timeoutMs: options.timeoutMs ?? workerTimeoutMs,
          idleTimeoutMs: options.idleTimeoutMs ?? workerIdleTimeoutMs,
          reasoningEffort: options.reasoningEffort ?? reasoningEffort,
          denyTools: options.denyTools ?? botDenyTools,
          allowMcp: options.allowMcp ?? botAllowMcp }),
        stages: stageNamesOf(botStages),
        stageBots,
        promptSections: botSections, allowMcp: botAllowMcp,
        persist, signal,
        reviewer: repo.reviewer ?? config.executor.reviewer, resume: resumed,
        digest: deps.candidateDigest ? () => deps.candidateDigest(worktree.path) : undefined,
        gates: async () => {
          const paths = await pathsOf(worktree.path, worktree.baseSha)
          run.changedPaths = paths
          const phase = await runGatePhase({ repo, config, command, cwd: worktree.path, paths, dryRun, step, signal })
          run.gates = phase.gates
          await recordAcceptanceRound({ engine, ticket, run, repo, gates: phase.gates,
            outcome: phase.error || phase.failure ? 'parked' : 'completed' })
          return { passed: paths.length > 0 && !phase.error && !phase.failure, results: phase.gates }
        } })
      if (resumed) step('workflow:resume', { state: 'ok', completed: ticket.workflow.stages.length })
      assertNotStopped(engine, ticket.id)
      await finishPipeline({ engine, loaded, config, repo, ticket, run, worktree, dryRun, allowPush, token, deps, step, persist,
        ticketEnv, signal, checkStop, stopRequested })
      return run
    }

    step('worker', { state: 'running', sessionId: undefined, backend: execBackend, bot: execProfile })
    const brief = workerBrief(ticket, config, repo)
    const readOnlyInstruction = execProfile === 'read-only'
      ? '\n\n---\nREAD-ONLY RUN: do not modify any file. Do the analysis/review/research and return the complete result as your final message; the executor delivers it as the Ticket report.'
      : ''
    const task = `${workerTask(ticket, repo, taskContext)}${readOnlyInstruction}`
    const workerSessionId = `worker-${ticketId}-${runId.slice(-6)}`
    // One worker turn on the same worktree; automatic repair rounds reuse the routed backend and bot.
    // The primary turn is the only one that gets the report file (a repair turn reports through run.repairs).
    const invokeWorker = ({ sessionId = workerSessionId, turnTask = task, repair = false } = {}) => (
      execBackend === 'dsh'
        ? workerRun({ ctx, cwd: worktree.path, systemPrompt: brief, task: turnTask, model: workerModel,
          preset: workerPreset, reasoningEffort, denyTools: botDenyTools,
          promptSections: botSections, allowMcp: botAllowMcp,
          timeoutMs: workerTimeoutMs, idleTimeoutMs: workerIdleTimeoutMs, sessionId,
          readOnly: execProfile === 'read-only', log, signal,
          onTrace: entry => liveTrace.push(entry),
          // A repair round continues the primary turn's session (the host loads it back): it starts from what it just
          // read and wrote instead of meeting the repository for the first time again.
          resume: repair ? run.worker?.sessionId : undefined,
          ...(reportFile && !repair ? { reportFile } : {}) })
        : cliRun({ backend: execBackend, cwd: worktree.path, systemPrompt: brief, task: turnTask,
          model: botParams?.model?.model ?? (backendOptions.model || config.executor.workerModel),
          reasoningEffort,
          command: backendOptions.command || config.executor.workerCommand,
          bot: execProfile, timeoutMs: workerTimeoutMs, sessionId, log, signal })
    )
    let worker
    try { worker = await invokeWorker() } catch (error) { liveTrace.stop(); throw fail('worker_failed', messageOf(error)) }
    liveTrace.stop()
    run.worker = { sessionId: worker.sessionId, timedOut: worker.timedOut, text: worker.text, toolCalls: worker.toolCalls,
      backend: worker.backend ?? execBackend, bot: execProfile }
    // The worker's normalised events live in run.trace only; run.worker keeps the historical fields.
    const trace = traceOf(worker.events)
    if (trace.length) run.trace = trace
    run.report = normalizeReport(worker.report)
    if (worker.usage !== undefined && worker.usage !== null) run.usage = worker.usage
    ticket.sessionId = worker.sessionId
    step('worker', { state: worker.timedOut || worker.error ? 'failed' : 'ok', sessionId: worker.sessionId,
      timedOut: worker.timedOut, error: worker.error, toolCalls: worker.toolCalls, backend: run.worker.backend,
      bot: execProfile })
    if (worker.timedOut) throw fail('timeout', 'worker timed out')
    // The watchdog settles a worker whose session/agent ended (or went idle) without a `turn/end`: fail fast instead of
    // leaving the run `working` until the 25-minute timeout, and let the Ticket be retried on the same worktree.
    if (worker.error === 'stopped' || worker.stopped) throw fail('stopped', 'stop requested during the worker turn')
    if (worker.error === 'worker_lost') throw fail('worker_lost', 'worker exited without reporting turn/end')
    if (worker.error) throw fail('worker_failed', worker.error)

    if (run.report?.question?.question) {
      // The worker needs a human decision before it can continue: park (no gates, no commit, no push).
      const askedAt = new Date().toISOString()
      const question = run.report.question.question
      run.status = 'waiting_for_human'
      run.stopReason = 'waiting_for_human'
      run.pendingQuestion = { ...run.report.question, at: run.report.question.at ?? askedAt }
      ticket.status = 'awaiting-answer'
      ticket.pendingQuestion = run.pendingQuestion
      ticket.updatedAt = askedAt
      const assignment = ticket.assignments?.at(-1)
      if (assignment) assignment.report = { state: 'waiting', text: `等待回答：${question.slice(0, 2000)}`, at: askedAt }
      addActivity(ticket, { kind: 'status', actorKind: 'agent', from: 'working', to: 'awaiting-answer',
        detail: `worker 提问：${question}`, at: askedAt, refs: { runId } })
      step('awaiting-answer', { state: 'waiting', question: question.slice(0, 200) })
      await persist()
      return run
    }

    let paths = await pathsOf(worktree.path, worktree.baseSha)
    run.changedPaths = paths
    step('changed-paths', { state: paths.length ? 'ok' : 'failed', count: paths.length })
    // Report-type work (analysis/review/research/interactive) delivers a written answer, not a commit. With no file
    // changes the Ticket ends `closed` and the run keeps the report; a worker that did change files still goes through
    // gates and delivery like any change run.
    if (!paths.length && route.deliverable === 'report') {
      const at = new Date().toISOString()
      run.deliverable = 'report'
      run.status = 'closed'
      run.stopReason = 'report_delivered'
      ticket.status = 'closed'
      ticket.links = { ...ticket.links, report: { text: String(worker.text ?? '').slice(0, 20_000),
        backend: run.worker.backend, workType: route.workType, at } }
      markRunComplete({ run, ticket, to: 'closed', detail: `${route.workType} report delivered (${run.worker.backend})` })
      step('report-delivered', { state: 'ok', workType: route.workType, backend: run.worker.backend })
      await persist()
      // "Every delivery" includes a report: base/head may be empty, but the worker summary, route and acceptance
      // requirements still belong in the durable evidence pack (AC-08).
      await recordDeliveryEvidence({ engine, ticket, run, repo })
      if (config.executor.allowReply) {
        try {
          const client = await engine.ensureClient(loaded)
          if (client) {
            await client.sendText({ channelId: ticket.origin?.channelId,
              channelType: ticket.origin?.channelType ?? config.octo.channelType,
              content: `Superagent: ${ticket.title}\n${String(worker.text ?? '').slice(0, 1200)}\n状态：${route.workType} 完成（无代码改动）` })
            addActivity(ticket, { kind: 'reply', actorKind: 'agent', detail: '已回复来源会话', refs: { runId } })
          }
        } catch (error) { run.replyError = error instanceof Error ? error.message : String(error) }
      }
      return run
    }
    if (!paths.length) throw fail('no_changes', 'worker made no changes')
    checkStop()

    // Gate phase with the contract's automatic repair loop (P2-2 §1.2): a failing gate whose configuration opts in
    // (`onFail: 'auto_repair'`) gets up to `executor.maxRepairRounds` extra worker turns on the same worktree.
    const repairMax = run.repair.max
    let gatePhase = await runGatePhase({ repo, config, command, cwd: worktree.path, paths, dryRun, step, signal })
    let repairError
    while (gatePhase.failure) {
      assertNotStopped(engine, ticket.id)
      run.gates = gatePhase.gates
      const failures = failedGatesOf({ repo, gatePhase })
      const repairable = failures.length > 0 && failures.every(item => item.gate?.onFail === 'auto_repair')
      // A timed-out/broken gate is never auto-repaired; manual gates and an exhausted budget park right away.
      if (isErroredGate(gatePhase.failure) || repairMax <= 0 || !repairable || run.repair.attempts >= repairMax) break
      const round = run.repair.attempts + 1
      const sessionId = `worker-${ticketId}-repair-${round}-${runId.slice(-6)}`
      const startedAt = new Date().toISOString()
      const gateNames = failures.map(item => item.name)
      step(`repair:worker:${round}`, { state: 'running', sessionId, gates: gateNames })
      addActivity(ticket, { kind: 'run', actorKind: 'system',
        detail: `自动修复第 ${round} 轮（gate: ${gateNames.join(', ')}）`, at: startedAt, refs: { runId } })
      let repairWorker
      try {
        repairWorker = await invokeWorker({ sessionId, turnTask: repairTaskOf({ task, failures }), repair: true })
      } catch (error) {
        repairWorker = { sessionId, timedOut: false, error: messageOf(error), text: '', toolCalls: [], events: [] }
      }
      // Repair events join the same bounded trace; the repair record itself keeps at most three rounds.
      const repairEvents = traceOf(repairWorker.events)
      if (repairEvents.length) run.trace = [...(run.trace ?? []), ...repairEvents].slice(-TRACE_LIMIT)
      run.repairs = [...(run.repairs ?? []), {
        round,
        startedAt,
        sessionId: repairWorker.sessionId ?? sessionId,
        text: String(repairWorker.text ?? ''),
        toolCalls: Array.isArray(repairWorker.toolCalls) ? [...repairWorker.toolCalls] : [],
        gates: failures.map(item => ({ name: item.name, exitCode: item.exitCode, timedOut: item.timedOut === true })),
      }].slice(-REPAIR_LIMIT)
      run.repair = { attempts: round, max: repairMax, status: 'none' }
      const repairFailed = repairWorker.timedOut === true || Boolean(repairWorker.error)
      step(`repair:worker:${round}`, { state: repairFailed ? 'failed' : 'ok', sessionId: run.repairs.at(-1).sessionId,
        timedOut: repairWorker.timedOut === true, error: repairWorker.error,
        backend: repairWorker.backend ?? execBackend })
      await persist()
      if (repairFailed) {
        repairError = repairWorker.timedOut === true
          ? 'repair worker timed out'
          : `repair worker failed: ${repairWorker.error}`
        break
      }
      // The repair may have added files; a gate that takes a changed-file list must see them on the re-run.
      const refreshed = await pathsOf(worktree.path, worktree.baseSha)
      if (refreshed.length) { paths = refreshed; run.changedPaths = paths }
      gatePhase = await runGatePhase({ repo, config, command, cwd: worktree.path, paths, dryRun, step, signal })
    }
    run.gates = gatePhase.gates
    // Final repair summary (contract §1.2.4): succeeded / failed / exhausted / none.
    const repairAttempts = run.repair.attempts
    const repairStatus = repairError || gatePhase.error
      ? repairAttempts > 0 ? 'failed' : 'none'
      : gatePhase.failure ? repairAttempts > 0 ? 'exhausted' : 'none'
        : repairAttempts > 0 ? 'succeeded' : 'none'
    run.repair = { attempts: repairAttempts, max: repairMax, status: repairStatus }
    if (repairStatus === 'succeeded') {
      addActivity(ticket, { kind: 'run', actorKind: 'system', detail: `自动修复成功（第 ${repairAttempts} 轮）`,
        refs: { runId } })
    }
    await recordAcceptanceRound({ engine, ticket, run, repo, gates: gatePhase.gates,
      outcome: gatePhase.error ? 'errored' : gatePhase.failure ? 'parked' : 'completed', repair: run.repair })
    if (gatePhase.error) {
      if (repairStatus === 'failed') {
        addActivity(ticket, { kind: 'run', actorKind: 'system', detail: '自动修复后闸门仍无法运行（errored）',
          refs: { runId } })
      }
      throw fail(gatePhase.error.code, gatePhase.error.message)
    }
    if (gatePhase.failure) {
      if (repairStatus === 'exhausted') {
        addActivity(ticket, { kind: 'run', actorKind: 'system',
          detail: `自动修复耗尽（${repairAttempts}/${repairMax} 轮）`, refs: { runId } })
      } else if (repairStatus === 'failed') {
        addActivity(ticket, { kind: 'run', actorKind: 'system', detail: `自动修复失败，转人工处理（${repairError}）`,
          refs: { runId } })
      }
      // A failed gate is a human decision, not a run failure: park the Ticket and keep the worktree + evidence.
      await parkOnGateFailure({ ticket, run, failure: gatePhase.failure, paths, step, persist,
        ...(repairError ? { repairError } : {}) })
      return run
    }

    checkStop()
    await finishPipeline({ engine, loaded, config, repo, ticket, run,
      worktree: { path: worktree.path, branch: worktree.branch, baseSha: worktree.baseSha },
      dryRun, allowPush, token, deps, step, persist, ticketEnv, checkStop, signal, stopRequested })
    return run
  } catch (error) {
    // A requested stop is not a failure: keep the worktree and the steps that did run, and leave a resumable Ticket.
    if (error?.code === 'stopped') {
      await finalizeStoppedRun({ engine, ticket, run, repo, step, persist, detail: '已停止执行（保留工作树）' })
      return run
    }
    failRun({ run, ticket, error, step, engine })
    await persist().catch(() => {})
    await recordDeliveryEvidence({ engine, ticket, run, repo })
    return run
  } finally {
    clearInterval(stopTimer)
    await persist().catch(() => {})
  }
}

/**
 * Human decision on a parked gate (P0-3). `retry` re-runs every gate on the same worktree (and parks again when one
 * fails), `release` records the skip and finalizes without re-running gates, `stop` ends the Ticket as failed.
 * Both finalize paths reuse finishPipeline — the pipeline is never duplicated.
 * @returns {Promise<{run:object, ticket:object}|{missing:true}|{invalid:string}>}
 */
export async function resumeTicket(options) {
  return withTicketClaim(options.ticketId, 'resuming', () => resumeTicketInner(options))
}

  /** @param {any} options */
async function resumeTicketInner({ engine, ticketId, action, note, log = () => {}, deps = /** @type {any} */ ({}) }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (!['stop', 'retry', 'release'].includes(action)) return { invalid: `unknown gate action: ${action}` }
  if (ticket.status !== 'gate-blocked') return { invalid: `ticket ${ticketId} is not waiting for a gate decision` }
  engine.clearStopRequest?.(ticketId)
  const run = await runOf(engine, ticket)
  if (!run) return { invalid: `run ${ticket.runId} not found` }
  if (!run.pendingGate) return { invalid: `run ${run.id} has no pending gate` }
  const repo = ticketRepo(config, ticket)
  if (!repo) return { invalid: `ticket ${ticketId} has no repository configured` }
  const token = repoToken(loaded, repo)
  const ticketEnv = ticketEnvOf(ticket, repo)
  const at = new Date().toISOString()
  run.trigger = 'resume'
  // A resumed run keeps the `run.bot` its original run decided: continuing with a different bot would change
  // the constraints the parked work was produced under (§7.6).
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId, run, log })
  const assignment = ticket.assignments?.at(-1)
  const dryRun = run.dryRun === true
  const allowPush = !dryRun && config.executor.allowPush === true

  if (action === 'stop') {
    run.status = 'failed'
    run.stopReason = 'stopped'
    run.errorCode = 'stopped'
    run.error = `stopped by human: ${note ?? ''}`.trimEnd()
    ticket.status = 'failed'
    ticket.updatedAt = at
    // The run keeps pendingGate as evidence; the Ticket no longer reads it (it is not gate-blocked anymore).
    delete ticket.pendingGate
    if (assignment) {
      assignment.state = 'ended'
      assignment.endedAt = at
      assignment.report = { state: 'stopped', text: run.error, at }
    }
    step('resume:stop', { state: 'stopped', ...(note ? { note } : {}) })
    addActivity(ticket, { kind: 'resume', actorKind: 'user', from: 'gate-blocked', to: 'failed',
      detail: `stopped by human${note ? `: ${note}` : ''}`, at, refs: { runId: run.id } })
    markRunComplete({ run, ticket, to: 'failed', summary: run.error, detail: 'stopped by human' })
    await persist()
    return { run, ticket }
  }

  // Stopping a parked Ticket stays available with the executor off (it only ends a run). Retrying or releasing one
  // re-enters the pipeline for real — release even pushes and opens the MR — so the switch applies before any state
  // is touched: a refusal leaves the Ticket parked, the worktree and the failing evidence intact.
  if (!dryRun && !config.executor.enabled) return { invalid: 'executor.enabled is false in live.json' }

  let baseSha
  try { baseSha = await (deps.git ?? git)(['rev-parse', `origin/${repo.baseBranch}`], repo.repo) } catch { baseSha = undefined }
  run.baseSha = run.baseSha ?? baseSha
  const worktree = { path: run.worktree, branch: run.branch, baseSha: run.baseSha }
  // The resumed gate is an active phase too (AC-03): poll the durable request so a long gate/repair stops promptly.
  const stopController = new AbortController()
  const signal = stopController.signal
  // The run recorder replaces the authoritative ticket object on every persist, so the object captured above goes
  // stale. Read the durable request through the engine; a captured `ticket.stopRequested` would miss the API's write
  // after the first persist (review P1 AC-03).
  // A stopped engine (plugin reload) ends its in-flight runs too: reconcile() already marked them interrupted, so
  // finishing normally would rewrite the document the next engine owns (D2-05).
  const stopRequested = () => engine?.disposed === true || (typeof engine.isStopRequested === 'function'
    ? engine.isStopRequested(ticketId)
    : Boolean(engine.state.tickets[ticketId]?.stopRequested))
  const checkStop = () => {
    if (stopRequested()) throw new StageError('stopped', 'stop requested by an operator')
  }
  const stopTimer = setInterval(() => { if (stopRequested()) stopController.abort() }, deps.stopPollMs ?? 200)
  stopTimer.unref?.()

  try {
    if (action === 'retry') {
      step('gate:re-run', { state: 'running', gates: (repo.gates ?? []).map(gate => gate.name) })
      step('resume:retry', { state: 'running', ...(note ? { note } : {}) })
      run.pendingGate = undefined
      delete ticket.pendingGate
      run.status = 'running'
      // The gate failure is being retried: the run is no longer a gate_failed run unless it parks again.
      run.stopReason = undefined
      run.errorCode = undefined
      ticket.status = 'working'
      ticket.updatedAt = at
      if (assignment) assignment.report = { state: 'progress', text: '恢复执行：重试闸门', at }
      addActivity(ticket, { kind: 'resume', actorKind: 'user', from: 'gate-blocked', to: 'working',
        detail: `retry gates${note ? `: ${note}` : ''}`, at, refs: { runId: run.id } })
      await persist()
      const paths = run.changedPaths ?? []
      const gatePhase = await runGatePhase({ repo, config, command: deps.runCommand ?? runCommand, cwd: worktree.path,
        paths, dryRun, step, signal })
      run.gates = gatePhase.gates
      await recordAcceptanceRound({ engine, ticket, run, repo, gates: gatePhase.gates,
        outcome: gatePhase.error ? 'errored' : gatePhase.failure ? 'parked' : 'completed' })
      if (gatePhase.error) throw new StageError(gatePhase.error.code, gatePhase.error.message)
      if (gatePhase.failure) {
        await parkOnGateFailure({ ticket, run, failure: gatePhase.failure, paths, step, persist })
        return { run, ticket }
      }
    } else {
      // release: the human accepts the gates that already ran; record the skip and go straight to the finalize segment.
      run.pendingGate = { ...run.pendingGate, released: { at, ...(note ? { note } : {}) } }
      step('resume:release', { state: 'running', gate: run.pendingGate.name, ...(note ? { note } : {}) })
      run.status = 'running'
      run.stopReason = undefined
      run.errorCode = undefined
      ticket.status = 'working'
      ticket.updatedAt = at
      delete ticket.pendingGate
      if (assignment) assignment.report = { state: 'progress', text: `恢复执行：放行闸门 ${run.pendingGate.name}`, at }
      addActivity(ticket, { kind: 'resume', actorKind: 'user', from: 'gate-blocked', to: 'working',
        detail: `released gate ${run.pendingGate.name}${note ? `: ${note}` : ''}`, at, refs: { runId: run.id } })
      await releaseAcceptanceRound({ engine, ticket, run, note })
      await persist()
    }
    checkStop()
    await finishPipeline({ engine, loaded, config, repo, ticket, run, worktree, dryRun, allowPush, token, deps, step,
      persist, ticketEnv, checkStop, stopRequested, signal })
    return { run, ticket }
  } catch (error) {
    if (error?.code === 'stopped') {
      await finalizeStoppedRun({ engine, ticket, run, repo, step, persist, detail: '已停止恢复执行（保留工作树）' })
      return { run, ticket }
    }
    failRun({ run, ticket, error, step, engine })
    return { run, ticket }
  } finally {
    clearInterval(stopTimer)
    await persist().catch(() => {})
  }
}

/**
 * Answer a parked worker question (P1-4): record the Q/A pair on the Ticket, then re-run the whole ticket with the
 * answer appended to the worker task (a headless worker has no resumable session, so the ticket restarts).
 * @returns {Promise<{ticket:object, run:object}|{missing:true}|{invalid:string}>}
 */
export async function answerTicket(options) {
  return withTicketClaim(options.ticketId, 'answering', () => answerTicketInner(options))
}

  /** @param {any} options */
async function answerTicketInner({ engine, ticketId, answer, log = () => {}, deps = /** @type {any} */ ({}) }) {
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (ticket.status !== 'awaiting-answer') {
    return { invalid: `工单 ${ticketId} 当前状态是 ${ticket.status}，只有正在等待回答的工单可以提交回答` }
  }
  const text = typeof answer === 'string' ? answer.trim() : ''
  if (!text) return { invalid: '请先填写回答' }
  const loaded = engine.readConfig()
  const config = loaded.config
  // Answering restarts the ticket end to end, so it is a real run: refuse before the Q/A pair is recorded, or a
  // rejected answer would leave the Ticket advanced to `ready` with no run behind it.
  const previous = await runOf(engine, ticket)
  const dryRun = previous?.dryRun === true
  if (!dryRun && !config.executor.enabled) return { invalid: 'executor.enabled is false in live.json' }
  const at = new Date().toISOString()
  const pending = ticket.pendingQuestion
  const question = typeof pending?.question === 'string' ? pending.question
    : typeof ticket.pendingQuestion === 'string' ? ticket.pendingQuestion : ''
  const answers = Array.isArray(ticket.answers) ? ticket.answers.slice(-19) : []
  answers.push({ at, question, answer: text.slice(0, 2000) })
  ticket.answers = answers
  delete ticket.pendingQuestion
  ticket.status = 'ready'
  ticket.updatedAt = at
  addActivity(ticket, { kind: 'answer', actorKind: 'user', from: 'awaiting-answer', to: 'ready',
    detail: text, at, refs: { ticketId } })
  await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
  // The engine owns the host context; the caller may override it (tests / alternate hosts) through deps.ctx.
  const ctx = deps.ctx ?? engine.ctx ?? {}
  // Answering a parked question must not turn a dry-run ticket into a real push run: resume with the parked run's mode.
  const run = await executeTicketInner({ ctx, engine, ticketId, dryRun, trigger: 'resume', log, deps })
  return { ticket: engine.state.tickets[ticketId] ?? ticket, run }
}

/**
 * Resume an interrupted Ticket (P1-5) from its checkpoint. When the interrupted run had reached the gates (or later),
 * a new run re-runs the gates on the same worktree and finalizes — the worker is not asked to redo the change.
 * Otherwise the ticket is executed end to end again.
 * @returns {Promise<{run:object, ticket:object}|{missing:true}|{invalid:string}>}
 */
/** Failed run of a blocked staged workflow that stopped at a stage worth replaying — the "continue" path for tickets. */
async function resumableWorkflowOf(engine, ticket, config) {
  if (!workflowResumable(ticket, repairBudgetOf(config))) return undefined
  const run = await runOf(engine, ticket)
  return run?.status === 'failed' ? run : undefined
}

export async function resumeInterruptedTicket(options) {
  return withTicketClaim(options.ticketId, 'resuming', () => resumeInterruptedTicketInner(options))
}

  /** @param {any} options */
async function resumeInterruptedTicketInner({ engine, ticketId, log = () => {}, deps = /** @type {any} */ ({}) }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (ticket.status === 'working') return { invalid: `ticket ${ticketId} is already working` }
  engine.clearStopRequest?.(ticketId)
  const previous = await resumableRunOf(engine, ticket)
  const revivable = previous ? undefined : await resumableWorkflowOf(engine, ticket, config)
  if (!previous && !revivable) {
    // Say why a blocked staged workflow will not continue (budget exhausted, stale evidence, nothing replayable).
    if (ticket.workflow?.status === 'blocked') {
      return { invalid: `ticket ${ticketId} workflow blocked: ${blockedMessage(ticket.workflow)}` }
    }
    return { invalid: `ticket ${ticketId} has no interrupted or stopped run` }
  }
  const repo = ticketRepo(config, ticket)
  if (!repo) return { invalid: `ticket ${ticketId} has no repository configured` }
  const dryRun = (previous ?? revivable).dryRun === true
  if (!dryRun && !config.executor.enabled) return { invalid: 'executor.enabled is false in live.json' }

  if (!previous) {
    // A blocked staged workflow continues from the stage its key recorded instead of starting over.
    const ctx = deps.ctx ?? engine.ctx ?? {}
    const run = await executeTicketInner({ ctx, engine, ticketId, dryRun, trigger: 'resume', resumeWorkflow: true, log, deps })
    return { run, ticket: engine.state.tickets[ticketId] ?? ticket }
  }

  const checkpoint = previous.checkpoint
  const resumablePhases = ['gates', 'commit', 'push', 'mr']
  const worktreePath = checkpoint?.worktree
  let worktreeExists = false
  if (worktreePath) {
    try {
      worktreeExists = deps.worktreeExists ? await deps.worktreeExists(worktreePath) : existsSync(worktreePath)
    } catch { worktreeExists = false }
  }
  if (!ticket.workflow && resumablePhases.includes(checkpoint?.phase) && worktreeExists) {
    return resumeFromCheckpoint({ engine, loaded, config, repo, ticket, previous, checkpoint, dryRun, deps, log })
  }
  // No usable checkpoint: let the executor rebuild the worktree by running the ticket again from the start.
  const ctx = deps.ctx ?? engine.ctx ?? {}
  const run = await executeTicketInner({ ctx, engine, ticketId, dryRun, trigger: 'resume', log, deps })
  return { run, ticket: engine.state.tickets[ticketId] ?? ticket }
}

/**
 * Fast checkpoint resume: new run on the existing worktree, re-run gates (idempotent) then finalize.
 * @param {any} options
 */
async function resumeFromCheckpoint({ engine, loaded, config, repo, ticket, previous, checkpoint, dryRun, deps, log }) {
  const token = repoToken(loaded, repo)
  const ticketEnv = ticketEnvOf(ticket, repo)
  const runId = recordId('run')
  const at = new Date().toISOString()
  const paths = Array.isArray(checkpoint.changedPaths) ? [...checkpoint.changedPaths]
    : Array.isArray(previous.changedPaths) ? [...previous.changedPaths] : []
  const run = {
    id: runId,
    ticketId: ticket.id,
    dryRun,
    trigger: 'resume',
    status: 'running',
    startedAt: at,
    leaseAt: at,
    steps: [],
    worktree: checkpoint.worktree,
    branch: checkpoint.branch ?? previous.branch,
    baseSha: checkpoint.baseSha ?? previous.baseSha,
    changedPaths: paths,
    repo: repoSnapshot(repo),
  }
  const allowPush = !dryRun && config.executor.allowPush === true
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId: ticket.id, run, log })
  const fail = (code, message) => { run.stopReason = code; run.errorCode = code; return new StageError(code, message) }
  // Stop is cooperative and cancellable: a durable flag is polled into an AbortSignal that ends the current worker or
  // shell command, while `checkStop` guards the gaps. Nothing after this point — repair, gates, commit, push, PR — runs
  // for a stopped Ticket. A queued Ticket stops before its worker.
  // A stopped engine (plugin reload) ends its in-flight runs too: reconcile() already marked them interrupted, so
  // finishing normally would rewrite the document the next engine owns (D2-05).
  const stopRequested = () => engine?.disposed === true || (typeof engine.isStopRequested === 'function'
    ? engine.isStopRequested(ticket.id)
    : Boolean(engine.state?.tickets?.[ticket.id]?.stopRequested))
  const checkStop = () => { if (stopRequested()) throw fail('stopped', 'stop requested by an operator') }
  // Stops must reach the process that is currently running, not just the next stage boundary. The controller is
  // aborted by a short poll of the durable stop flag and is threaded into the worker (agent.cancel / CLI SIGTERM) and
  // into every shell command; `checkStop` stays as the boundary guard. A stop is idempotent.
  const controller = new AbortController()
  const signal = controller.signal
  const stopPollMs = deps.stopPollMs ?? 200
  let stopTimer
  if (stopRequested()) controller.abort()
  else {
    stopTimer = setInterval(() => { if (stopRequested()) controller.abort() }, stopPollMs)
    stopTimer.unref?.()
  }
  const startedFrom = ticket.status
  ticket.status = 'working'
  ticket.updatedAt = at
  ticket.runId = runId
  if (!ticket.assignments) ticket.assignments = []
  ticket.assignments.push({ id: runId, state: 'running', startedAt: at,
    report: { state: 'progress', text: `从检查点恢复（${checkpoint.phase}）`, at } })
  addActivity(ticket, { kind: 'resume', actorKind: 'system', from: startedFrom, to: 'working',
    detail: `resume from checkpoint ${checkpoint.phase} (previous run ${previous.id})`, at, refs: { runId } })
  await persist()
  try {
    step('resume:checkpoint', { state: 'running', phase: checkpoint.phase, previousRunId: previous.id })
    // The old checkpoint may sit after the gates: re-run them first so a half-finished delivery is never pushed.
    const gatePhase = await runGatePhase({ repo, config, command: deps.runCommand ?? runCommand, cwd: run.worktree,
      paths, dryRun, step, signal })
    run.gates = gatePhase.gates
    await recordAcceptanceRound({ engine, ticket, run, repo, gates: gatePhase.gates,
      outcome: gatePhase.error ? 'errored' : gatePhase.failure ? 'parked' : 'completed' })
    if (gatePhase.error) throw fail(gatePhase.error.code, gatePhase.error.message)
    if (gatePhase.failure) {
      await parkOnGateFailure({ ticket, run, failure: gatePhase.failure, paths, step, persist })
      return { run, ticket }
    }
    checkStop()
    await finishPipeline({ engine, loaded, config, repo, ticket, run,
      worktree: { path: run.worktree, branch: run.branch, baseSha: run.baseSha },
      dryRun, allowPush, token, deps, step, persist, ticketEnv, checkStop, stopRequested, signal })
    return { run, ticket }
  } catch (error) {
    // A checkpoint resume is an active execution phase too (AC-03): a stop here must be confirmed, not failed.
    if (error?.code === 'stopped') {
      await finalizeStoppedRun({ engine, ticket, run, repo, step, persist, detail: '已停止恢复执行（保留工作树）' })
      return { run, ticket }
    }
    failRun({ run, ticket, error, step, engine })
    return { run, ticket }
  } finally {
    clearInterval(stopTimer)
    await persist().catch(() => {})
  }
}

/** Repo-style commit subject: `fix(ar): <summary>` derived from the ticket (scope from UC/AC ids), overridable. */
export function commitMessageFor(ticket) {
  if (typeof ticket.commitMessage === 'string' && ticket.commitMessage.trim()) return ticket.commitMessage.trim()
  const text = `${ticket.title ?? ''}\n${ticket.body ?? ''}`
  const scope = /(?:UC|AC)-([A-Za-z]{2,4})-/.exec(text)?.[1]?.toLowerCase()
  const type = /^\s*(?:feat|feature|实现|新增|新功能)/i.test(ticket.title ?? '') || /需求|新增功能/.test(ticket.body ?? '') ? 'feat' : 'fix'
  let summary = String(ticket.title ?? 'Superagent change')
    .replace(/^\s*(?:修复|fix|feat|feature|新增|实现)[:：]\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  if (type === 'feat') summary = summary.replace(/^(?:实现|新增)\s*/, '').trim()
  return `${type}${scope ? `(${scope})` : ''}: ${summary}`
}

/** GitLab push options that create the MR during the push (no API token needed). */
export function pushOptionsFor(ticket, repo) {
  const title = String(ticket.title ?? 'Superagent ticket').replace(/[\r\n]+/g, ' ').slice(0, 120)
  return [
    'merge_request.create',
    `merge_request.target=${repo.gitlab.targetBranch}`,
    `merge_request.title=Superagent: ${title}`,
    `merge_request.description=Superagent ticket ${ticket.id}`,
    'merge_request.remove_source_branch',
  ]
}

/**
 * Whether the remote consumes GitLab `merge_request.*` push options.
 *
 * GitHub ignores them and only prints a create-pull-request link (`.../pull/new/<branch>`), so a GitHub-hosted
 * repository is pushed plainly: the options cannot create an MR there, and GitHub's receive-pack rejected
 * option-bearing pushes with a server-side unpack error ("no voting servers succeeded") while the same branch
 * pushed fine without options. `.github/workflows/auto-pr.yml` opens the PR on the branch push instead, and
 * `parseMergeRequestFromPush` records the printed link as a pending MR.
 */
export function usesPushOptionMr(repo) {
  return !/github\.com/i.test(String(repo?.gitlab?.baseUrl ?? ''))
}

/** Description body for the merge request: ticket, source, gates and worker summary. */
export function mergeRequestDescription(ticket, run, repo) {
  const gates = (run.gates ?? []).map(gate => `- ${gate.name}: exit ${gate.exitCode}${gate.timedOut ? ' (timeout)' : ''}`).join('\n')
  return [
    `Superagent ticket: ${ticket.id}`,
    ...(repo ? [`Repository: ${repo.name} (${repo.gitlab.project})`] : []),
    '',
    '## 原始请求',
    ticket.body || '(empty)',
    '',
    '## 本地闸门',
    gates || '(none)',
    '',
    '## Worker 总结',
    run.worker?.text || '(no summary)',
    '',
    '> 由 Superagent 执行器自动创建；请人工评审后合并。禁止自动合并。',
  ].join('\n')
}

/** Reply the outcome to the originating Octo thread. */
async function replyToSource(engine, config, loaded, ticket, run, repo) {
  try {
    const client = await engine.ensureClient(loaded)
    if (!client) return
    const mr = ticket.links?.mergeRequest
    const lines = [
      `Superagent: ${ticket.title}`,
      mr?.webUrl ? `MR: ${mr.webUrl}` : 'MR: 未创建（缺少 GitLab token）',
      run.gates?.length ? `闸门：${run.gates.map(gate => `${gate.name}=${gate.exitCode === 0 ? '通过' : '失败'}`).join(' ')}` : undefined,
      repo?.verifyMode === 'manual'
        ? '状态：等待人工评审与合并；合并后在面板确认验收。'
        : '状态：等待人工评审与合并，合并后 dev 流水线会自动部署 UAT。',
    ].filter(Boolean)
    await client.sendText({ channelId: ticket.origin?.channelId, channelType: ticket.origin?.channelType ?? config.octo.channelType,
      content: lines.join('\n') })
    addActivity(ticket, { kind: 'reply', actorKind: 'agent', detail: '已回复来源会话', refs: { runId: run.id } })
  } catch (error) {
    run.replyError = error instanceof Error ? error.message : String(error)
  }
}

/** One bounded reachability check of the UAT surface; never throws. */
export async function checkUat(url, fetchImpl) {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'uatUrl is not configured', checkedAt: new Date().toISOString() }
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch is unavailable', checkedAt: new Date().toISOString() }
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    return { ok: response.status >= 200 && response.status < 400, status: response.status, url, checkedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url, checkedAt }
  }
}

export async function refreshTicketCi(options) {
  return withTicketClaim(options.ticketId, 'refreshing CI', () => refreshTicketCiInner(options))
}

/**
 * Refresh the CI status of a ticket's MR and (once merged) the dev pipeline it triggered.
 * @param {any} options
 */
async function refreshTicketCiInner({ engine, ticketId, deps = /** @type {any} */ ({}) }) {
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket?.links?.mergeRequest?.iid) return { skipped: 'no-mr' }
  const repo = ticketRepo(config, ticket)
  // A manual repository has no CI pipeline to observe; its MR is tracked by verifyTicket/checkMerged instead.
  if (!repo || repo.verifyMode === 'manual' || repo.gitlab.ci === false) return { skipped: 'no-ci' }
  const token = repoToken(loaded, repo)
  if (!token) return { skipped: 'no-token' }
  const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
  let mr = await gitlab.getMergeRequest(ticket.links.mergeRequest.iid)
  // The exact commit the MR points at: `sha` on most endpoints, `diff_refs.head_sha` when GitLab omits it.
  const headSha = mr.sha ?? mr.diffRefs?.headSha
  const pipelines = await gitlab.listMergeRequestPipelines(ticket.links.mergeRequest.iid)
  // Only a pipeline built for this very commit may judge the Ticket. A newer pipeline for another commit (e.g. a later
  // push on the source branch) is recorded as `pipeline.stale` instead of silently overwriting the CI conclusion.
  const matching = headSha ? pipelines.filter(item => item.sha === headSha) : pipelines
  const latest = pipelineStatusOf(matching)
  const newerUnmatched = headSha
    ? pipelines.filter(item => item.sha && item.sha !== headSha
      && (!latest.pipelineId || Number(item.id) > Number(latest.pipelineId)))
    : []
  const mrPatch = {
    ...(ticket.links?.mergeRequest ?? {}),
    iid: mr.iid,
    webUrl: mr.webUrl,
    state: mr.state,
    ...(mr.mergeStatus !== undefined ? { mergeStatus: mr.mergeStatus } : {}),
    ...(mr.title !== undefined ? { title: mr.title } : {}),
    ...(headSha ? { headSha } : {}),
    // Known booleans always overwrite, so a draft that was marked ready is no longer treated as a draft.
    ...(typeof mr.workInProgress === 'boolean' ? { workInProgress: mr.workInProgress } : {}),
  }
  // GitLab saying "not a draft anymore" also clears the flag recorded by an earlier verification pass.
  if (mr.workInProgress === false) delete mrPatch.draft
  if (newerUnmatched.length) {
    const at = new Date().toISOString()
    const newest = newerUnmatched.reduce((current, candidate) => (
      Number(candidate.id) > Number(current.id) ? candidate : current))
    ticket.links = {
      ...ticket.links,
      mergeRequest: mrPatch,
      pipeline: { ...(ticket.links?.pipeline ?? {}), ...(headSha ? { headSha } : {}),
        stale: { headSha, latestSha: newest.sha, at } },
    }
    ticket.updatedAt = at
    await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
    return { mergeRequest: mr, pipeline: latest, status: ticket.status, stale: true }
  }
  const jobs = latest.pipelineId ? await gitlab.listPipelineJobs(latest.pipelineId).catch(() => []) : []
  const summary = summarizeJobs(jobs)
  const patch = {
    mergeRequest: mrPatch,
    pipeline: latest.pipelineId
      ? { id: latest.pipelineId, status: latest.status,
        webUrl: matching.find(item => item.id === latest.pipelineId)?.webUrl,
        ...(headSha ? { headSha } : {}), failed: summary.failed, running: summary.running, total: summary.total }
      : null,
  }
  // Optional auto-merge: only after the MR pipeline is green, and only when the operator enabled allowMerge.
  // GitLab's merge API performs the merge; the dev pipeline then deploys UAT by itself.
  // Auto-merge only exists for repositories with a real CI gate; manual repos always need a human merge.
  if (repo.verifyMode === 'web-uat' && config.executor.allowMerge && mr.state === 'opened' && latest.status === 'success'
      && !['requested', 'merged'].includes(ticket.links?.autoMerge?.state)) {
    try {
      const merged = await gitlab.mergeMergeRequest(mr.iid, { sha: mr.sha, mergeWhenPipelineSucceeds: false, removeSourceBranch: true })
      mr = merged
      patch.mergeRequest = { ...patch.mergeRequest, state: merged.state, mergeStatus: merged.mergeStatus }
      patch.autoMerge = { state: merged.state === 'merged' ? 'merged' : 'requested', iid: merged.iid, at: new Date().toISOString() }
    } catch (error) {
      patch.autoMerge = { state: 'failed', iid: mr.iid, at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error) }
    }
  }
  let status = latest.status === 'success' ? 'ci-passed' : latest.status === 'failed' ? 'ci-failed' : 'ci-pending'
  if (mr.state === 'merged') {
    status = 'merged'
    // After a merge into the deploy branch, the branch pipeline is what deploys UAT; follow it to the deploy job.
    // Only a pipeline built for this MR's merge commit may count: the newest target-branch pipeline can belong to a
    // later, unrelated merge (review P1 AC-05).
    try {
      const mergeSha = mr.mergeCommitSha ?? mr.merge_commit_sha ?? ticket.links?.mergeRequest?.mergeCommitSha
      const pipelines = await gitlab.listPipelines({ ref: repo.gitlab.targetBranch, perPage: 20 })
      const branch = mergeSha ? pipelines.find(item => item.sha === mergeSha) : undefined
      if (branch) {
        const jobs = await gitlab.listPipelineJobs(branch.id).catch(() => [])
        const deploy = jobs.find(job => job.stage === 'deploy' || /deploy/i.test(job.name))
        patch.deployment = { pipelineId: branch.id, status: branch.status, webUrl: branch.webUrl,
          // Tie the deployment to the exact merge commit; `matchesHead` records the comparison, not a copied SHA.
          commit: mergeSha, sha: branch.sha, matchesHead: branch.sha === mergeSha,
          deployJob: deploy ? { name: deploy.name, status: deploy.status, webUrl: deploy.webUrl } : null,
          at: new Date().toISOString() }
        if (deploy?.status === 'success') {
          status = 'deployed'
          // A green deploy job is not proof the GUI answers; record one reachability check of the UAT URL.
          patch.deployment.uat = await checkUat(repo.gitlab.uatUrl, deps.fetchImpl)
        } else if (deploy?.status === 'failed' || branch.status === 'failed') status = 'deploy-failed'
        else status = 'deploy-pending'
      } else {
        // No verified pipeline: keep the merged state and say why deployment is unproven instead of claiming it.
        patch.deployment = { commit: mergeSha ?? null, sha: null, matchesHead: false, at: new Date().toISOString(),
          state: mergeSha ? 'waiting-for-pipeline' : 'unknown',
          ...(mergeSha ? {} : { reason: 'merge commit sha is unavailable' }) }
      }
    } catch (error) {
      patch.deploymentError = error instanceof Error ? error.message : String(error)
    }
  } else if (mr.state === 'closed') status = 'closed'
  ticket.status = status
  ticket.links = { ...ticket.links, ...patch }
  ticket.updatedAt = new Date().toISOString()
  await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
  return { mergeRequest: mr, pipeline: latest, ...(patch.deployment ? { deployment: patch.deployment } : {}),
    ...(patch.autoMerge ? { autoMerge: patch.autoMerge } : {}), status }
}

/**
 * Manually inject a ticket (used before the Octo group message exists, and by tests).
 * @param {any} options
 */
export async function injectTicket({ engine, title, body, channelId, repoId, fromUid = 'manual', route: selection }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const repos = configRepos(config)
  const repo = repoId ? repos.find(item => item.id === repoId) : undefined
  if (repoId && !repo) throw new Error(`unknown repoId: ${repoId}`)
  const targetRepo = repo ?? repos.find(item => item.id === config.defaultRepo) ?? repos[0]
  // A disabled repository keeps its id and history but receives no new work, manually or from a group.
  if (targetRepo?.enabled === false) throw new Error(`repository disabled: ${targetRepo.id}`)
  const { evaluate, buildRecords } = await import('./eval.js')
  const candidate = {
    eventId: Date.now(), messageId: `manual-${Date.now()}`, fromUid,
    channelId: channelId ?? config.octo.watchChatIds[0],
    channelType: config.octo.channelType, contentType: 1,
    text: body ?? title, at: new Date().toISOString(),
    repoId: targetRepo.id,
    triggerId: recordId('trg'), decisionId: recordId('dec'), ticketId: recordId('tkt'),
  }
  const evaluation = evaluate({ ...candidate, manual: true, text: `${title}\n${body ?? ''}` }, config)
  if (evaluation.kind !== 'accept') throw new Error(`manual ticket rejected: ${evaluation.reason[0]?.code}`)
  const records = buildRecords({ ...candidate, text: `${title}\n${body ?? ''}` }, evaluation, config)
  records.ticket.title = String(title).slice(0, 160)
  records.ticket.body = String(body ?? title)
  // Persist the operator's manual choice on the Ticket (not just in this request): the preview shown at creation, the
  // follow-up run and every later rerun must agree on the deliverable/backend the operator selected.
  const chosen = normalizeRouteSelection(selection, config)
  if (chosen) /** @type {any} */ (records.ticket).routeSelection = chosen
  await engine.state.atomic((doc) => {
    doc.threads = doc.threads ?? {}
    doc.triggers = doc.triggers ?? {}
    doc.decisions = doc.decisions ?? {}
    doc.tickets = doc.tickets ?? {}
    doc.ticketOrder = doc.ticketOrder ?? []
    doc.threads[records.thread.key] = doc.threads[records.thread.key] ?? records.thread
    doc.triggers[records.trigger.id] = records.trigger
    doc.decisions[records.decision.id] = records.decision
    doc.tickets[records.ticket.id] = records.ticket
    doc.ticketOrder.push(records.ticket.id)
  })
  const preview = routePreviewOf({ title: records.ticket.title, body: records.ticket.body, config,
    selection: /** @type {any} */ (records.ticket).routeSelection })
  return { ...records.ticket, routePreview: preview.route }
}

/** Keep only the fields a manual routing choice may set, so arbitrary request bodies cannot leak into state. */
function normalizeRouteSelection(selection, config) {
  if (!selection || typeof selection !== 'object') return undefined
  const chosen = {}
  if (WORKER_BACKENDS.includes(selection.backend) && enabledBackends(config).includes(selection.backend)) {
    chosen.backend = selection.backend
  }
  if (DELIVERABLES.includes(selection.deliverable)) chosen.deliverable = selection.deliverable
  return Object.keys(chosen).length ? chosen : undefined
}

export { git, recordId, readToken }


/**
 * Ticket states `publishTicket` accepts. A delivery that failed after the branch was pushed — its MR pipeline red, its
 * deploy job red, or its MR closed — is exactly the case a human has to publish again, so those states stay publishable
 * and re-delivery opens a fresh merge request.
 */
export const PUBLISHABLE_STATUSES = ['ready', 'failed', 'pushed', 'ci-failed', 'deploy-failed', 'closed']

/**
 * Publish an already-executed ticket without running the worker again: re-run the gates on the existing worktree,
 * commit/push the feature branch and open the merge request. Used after a dry run has produced reviewed changes.
 * Publishing is an explicit human action, so a failing gate fails the run directly (gate_failed) — it never parks.
 */
export async function publishTicket(options) {
  return withTicketClaim(options.ticketId, 'publishing', () => publishTicketInner(options))
}

  /** @param {any} options */
async function publishTicketInner({ ctx, engine, ticketId, log = () => {}, deps = /** @type {any} */ ({}), commitMessage }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  // Publish commits and pushes, so it must never start over a live run or a ticket that is already delivered.
  if (!PUBLISHABLE_STATUSES.includes(ticket.status)) {
    throw new Error(`ticket ${ticketId} is not publishable (status ${ticket.status})`)
  }
  // An explicit human action (publish / verify) always wins over a queued stop marker.
  if (ticket.stop) delete ticket.stop
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  if (repo.enabled === false) throw new Error(`repository disabled: ${repo.id}`)
  const token = repoToken(loaded, repo)
  if (!config.executor.enabled) throw new Error('executor.enabled is false in live.json')
  if (!config.executor.allowPush) {
    throw new Error('未允许推送：改动已保留在工作树里；请在「设置 → 执行器」里打开「允许推送」后再发布，或忽略并清理这张工单。')
  }
  const mrMode = repo.gitlab.createMr === 'push' ? 'push' : 'api'
  if (mrMode === 'api' && !token) throw new Error(`gitlab token is not configured for ${repo.name} (set gitlab.createMr=push to open the MR without an API token)`)
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const branch = ticket.links?.branch ?? `${repo.featurePrefix}${ticketId}`
  const cwd = ticket.links?.worktree ?? `${repo.worktreeRoot}/${ticketId}`
  const runId = recordId('run')
  const startedAt = new Date().toISOString()
  const run = { id: runId, ticketId, dryRun: false, publish: true, trigger: 'publish', status: 'running', startedAt,
    leaseAt: startedAt, steps: [], branch, worktree: cwd, repo: repoSnapshot(repo) }
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId, run, log, label: 'publish' })
  const startedFrom = ticket.status
  ticket.status = 'working'
  ticket.updatedAt = startedAt
  addActivity(ticket, { kind: 'run', actorKind: 'system', from: startedFrom, to: 'working',
    detail: `publish ${runId}`, at: startedAt, refs: { runId } })
  await persist()
  const checkStop = () => assertNotStopped(engine, ticket.id)
  // A stopped engine (plugin reload) ends its in-flight runs too: reconcile() already marked them interrupted, so
  // finishing normally would rewrite the document the next engine owns (D2-05).
  const stopRequested = () => engine?.disposed === true || (typeof engine.isStopRequested === 'function'
    ? engine.isStopRequested(ticket.id)
    : Boolean(engine.state?.tickets?.[ticket.id]?.stopRequested))
  const controller = new AbortController()
  const signal = controller.signal
  const stopPollMs = deps.stopPollMs ?? 200
  let stopTimer
  if (stopRequested()) controller.abort()
  else {
    stopTimer = setInterval(() => { if (stopRequested()) controller.abort() }, stopPollMs)
    stopTimer.unref?.()
  }
  try {
    checkStop()
    const baseSha = await git(['rev-parse', `origin/${repo.baseBranch}`], repo.repo).catch(() => undefined)
    run.baseSha = baseSha
    const commands = gateCommands(repo, config)
    // Publishing re-runs the gates on the existing worktree, so it needs the same changed-path list the run phase
    // computed: without it, `passChangedFiles` gates (e.g. the EBS deploy/access scripts) are invoked with no files.
    const pathsOf = deps.changedPaths ?? changedPaths
    // A publish whose changed paths are unknown runs the file-list gates blind, so surface it instead of `[]`.
    let paths = await pathsOf(cwd, baseSha).catch(error => {
      engine.log?.(`publish ${ticket.id}: changed paths unavailable (${messageOf(error)}), file gates get no input`)
      return []
    })
    const repairMax = repairBudgetOf(config)
    // A publish repair edits files, so it always runs with the write bot on the routed backend.
    const publishRoute = resolveRoute({ ticket, config })
    const workerBackend = publishRoute.execBackend
    const backendOptions = config.executor.workers?.[workerBackend] ?? {}
    const brief = workerBrief(ticket, config, repo, { repair: true })
    const task = workerTask(ticket, repo, workerContext(engine, ticket, answerContext(ticket)))
    const invokeRepairWorker = ({ sessionId, turnTask }) => (
      workerBackend === 'dsh'
        ? (deps.runWorker ?? runWorker)({ ctx, cwd, systemPrompt: brief, task: turnTask,
          model: config.executor.model, timeoutMs: config.executor.timeoutMs, sessionId, log, signal })
        : (deps.runCliWorker ?? runCliWorker)({ backend: workerBackend, cwd, systemPrompt: brief, task: turnTask,
          model: backendOptions.model || config.executor.workerModel,
          command: backendOptions.command || config.executor.workerCommand,
          bot: 'write', timeoutMs: config.executor.timeoutMs, sessionId, log, signal })
    )
    const runGates = async () => {
      const gates = []
      let failure
      // Same dependency bootstrap as the run phase: a fresh worktree has no node_modules, so the frontend gate used to
      // fail at publish time (after the worker already finished) on a checkout that installs nothing.
      const bootstrap = await runGateBootstrap({ repo, config, command: deps.runCommand ?? runCommand, cwd,
        dryRun: false, step, signal })
      if (bootstrap.error) {
        if (bootstrap.error.code === 'stopped') {
          return { gates, failure: { name: 'bootstrap:pnpm', command: 'pnpm install --frozen-lockfile',
            exitCode: 130, timedOut: false, durationMs: 0, output: '', aborted: true } }
        }
        throw new StageError('bootstrap_failed', bootstrap.error.message)
      }
      for (const name of repo.gates.map(gate => gate.name)) {
        const spec = commands[name]
        if (!spec) continue
        const gateCommand = gateCommandFor(spec, { paths })
        const root = resolve(cwd)
        const gateCwd = spec.cwd ? resolve(root, spec.cwd) : root
        // A string prefix lets a directory symlink inside the worktree point the gate outside it; validate the real
        // path exactly like runGatePhase does (review P1 AC-10).
        if (!(await insideRealRoot(root, gateCwd))) {
          throw new StageError('gate_failed', `gate ${name} cwd escapes the worktree: ${spec.cwd}`)
        }
        step(`gate:${name}`, { state: 'running', command: gateCommand, ...(spec.cwd ? { cwd: spec.cwd } : {}) })
        const result = await (deps.runCommand ?? runCommand)(gateCommand, { cwd: gateCwd, timeoutMs: spec.timeoutMs, signal,
          ...(spec.requireOutput ? { requireOutput: spec.requireOutput } : {}) })
        if (result.aborted) {
          step(`gate:${name}`, { state: 'stopped', aborted: true, exitCode: 130,
            detail: `stop requested during gate ${name}` })
          return { gates, failure: { name, command: gateCommand, exitCode: 130, timedOut: false,
            durationMs: result.durationMs, output: result.output, aborted: true } }
        }
        const missingEvidence = evidenceMissing(spec, result)
        gates.push({ name, command: gateCommand, at: new Date().toISOString(), exitCode: result.exitCode,
          timedOut: result.timedOut, durationMs: result.durationMs, output: result.output,
          ...missingEvidence ? { missingEvidence: true } : {} })
        step(`gate:${name}`, { state: result.exitCode === 0 && !missingEvidence ? 'ok' : 'failed',
          exitCode: result.exitCode, ...missingEvidence ? { detail: `missing evidence: ${spec.requireOutput}` } : {} })
        if (result.exitCode !== 0 || missingEvidence) {
          failure = { name, command: gateCommand, exitCode: result.exitCode, timedOut: result.timedOut === true,
            durationMs: result.durationMs, output: result.output, missingEvidence }
          break
        }
      }
      return { gates, failure }
    }

    checkStop()
    let gatePhase = await runGates()
    // A publish failure is not a dead end: the failed gate evidence goes back to the worker, which repairs the
    // worktree, and the gates are re-run — the same closed loop the run phase has, but owned by publish because a
    // person already asked for this delivery. Tooling failures are repairable here as well (the repair brief allows
    // scripts/local/ except the credential module).
    run.repair = { attempts: 0, max: repairMax, status: 'none' }
    let repairError
    while (gatePhase.failure) {
      assertNotStopped(engine, ticket.id)
      run.gates = gatePhase.gates
      const failures = failedGatesOf({ repo, gatePhase })
      // Only gates explicitly configured onFail:auto_repair may be repaired here; manual gates must park for a human.
      const repairable = failures.length > 0 && failures.every(item => onFailOf(item.gate) === 'auto_repair')
      if (isErroredGate(gatePhase.failure) || repairMax <= 0 || !repairable || run.repair.attempts >= repairMax) break
      const round = run.repair.attempts + 1
      const sessionId = `worker-${ticketId}-publish-repair-${round}-${runId.slice(-6)}`
      const repairStartedAt = new Date().toISOString()
      const gateNames = failures.map(item => item.name)
      step(`repair:worker:${round}`, { state: 'running', sessionId, gates: gateNames })
      addActivity(ticket, { kind: 'run', actorKind: 'system',
        detail: `发布失败自动修复第 ${round} 轮（gate: ${gateNames.join(', ')}）`, at: repairStartedAt, refs: { runId } })
      let repairWorker
      try {
        repairWorker = await invokeRepairWorker({ sessionId, turnTask: repairTaskOf({ task, failures }) })
      } catch (error) {
        repairWorker = { sessionId, timedOut: false, error: messageOf(error), text: '', toolCalls: [], events: [] }
      }
      const repairEvents = traceOf(repairWorker.events)
      if (repairEvents.length) run.trace = [...(run.trace ?? []), ...repairEvents].slice(-TRACE_LIMIT)
      run.repairs = [...(run.repairs ?? []), {
        round,
        startedAt: repairStartedAt,
        sessionId: repairWorker.sessionId ?? sessionId,
        text: String(repairWorker.text ?? ''),
        toolCalls: Array.isArray(repairWorker.toolCalls) ? [...repairWorker.toolCalls] : [],
        gates: failures.map(item => ({ name: item.name, exitCode: item.exitCode, timedOut: item.timedOut === true })),
      }].slice(-REPAIR_LIMIT)
      run.repair = { attempts: round, max: repairMax, status: 'none' }
      const repairFailed = repairWorker.timedOut === true || Boolean(repairWorker.error)
      step(`repair:worker:${round}`, { state: repairFailed ? 'failed' : 'ok',
        sessionId: run.repairs.at(-1).sessionId, timedOut: repairWorker.timedOut === true,
        error: repairWorker.error, backend: repairWorker.backend ?? workerBackend })
      await persist()
      if (repairFailed) {
        repairError = repairWorker.timedOut === true ? 'repair worker timed out'
          : `repair worker failed: ${repairWorker.error}`
        break
      }
      // The repair may have added files; a passChangedFiles gate must see them on the re-run.
      const refreshed = await pathsOf(cwd, baseSha).catch(() => paths)
      if (refreshed.length) paths = refreshed
      gatePhase = await runGates()
    }
    run.gates = gatePhase.gates
    const repairAttempts = run.repair.attempts
    run.repair = { attempts: repairAttempts, max: repairMax,
      status: repairError ? 'failed' : gatePhase.failure ? (repairAttempts > 0 ? 'exhausted' : 'none')
        : repairAttempts > 0 ? 'succeeded' : 'none' }
    if (run.repair.status === 'succeeded') {
      addActivity(ticket, { kind: 'run', actorKind: 'system', detail: `发布失败自动修复成功（第 ${repairAttempts} 轮）`,
        refs: { runId } })
    }
    // Publishing is an explicit human action: the round records the published gate results, a failure never parks.
    await recordAcceptanceRound({ engine, ticket, run, repo, gates: gatePhase.gates,
      outcome: 'completed', repair: run.repair })
    if (gatePhase.failure) {
      const failure = gatePhase.failure
      if (failure.aborted) throw new StageError('stopped', 'stop requested during a publish gate')
      throw new StageError('gate_failed', `${failure.name} gate failed (${failure.missingEvidence === true
        ? 'missing evidence' : `exit ${failure.exitCode}`})`)
    }
    checkStop()
    try {
      await (deps.assertSafeWorktree ?? assertSafeWorktree)({ cwd, branch, featurePrefix: repo.featurePrefix, baseSha,
        extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
    } catch (error) { throw new StageError('guard_failed', messageOf(error)) }
    // The workflow evidence rule only applies while the workflow shape is configured and the Ticket carries a
    // reviewed workflow. A blocked record left by an earlier, now-disabled round is preserved and must not block a
    // publish: the same leftover that failed every plain run after its gates (m00292).
    const workflowOn = Boolean(config.executor.workflowMode) && config.executor.workflowMode !== 'off'
    if (workflowOn && ticket.workflow?.status === 'ready'
      && (!ticket.workflowDigest || ticket.workflowDigest !== await (deps.candidateDigest ?? candidateDigest)(cwd))) throw new StageError('review_stale', 'Workflow evidence is missing or stale; rerun the workflow')
    checkStop()
    if (await (deps.hasChanges ?? hasChanges)(cwd)) {
      let commitResult
      try {
        commitResult = await (deps.commitAll ?? commitAll)({ cwd, message: commitMessage ?? commitMessageFor(ticket),
          authorName: 'Superagent', authorEmail: 'superagent@local' })
      } catch (error) { throw new StageError('commit_failed', messageOf(error)) }
      run.commit = commitResult
      ticket.links = { ...ticket.links, commit: commitResult.sha }
      step('commit', { state: 'ok', sha: commitResult.sha })
    }
    checkStop()
    let mr
    // AC-04: the manual publish shares the delivery path with a normal run — reconcile a leftover request, then record
    // the request before pushing and the result after it. A branch already pushed at this HEAD is reused, not re-pushed.
    const cwdHead = await headOf(cwd, deps)
    const pendingPush = await reconcilePendingPush({ ticket, cwd, branch, head: cwdHead, repo, deps, persist })
    if (pendingPush.state === 'unknown') {
      throw new StageError('push_failed', `a previous push to origin/${branch} has an unknown result; reconcile it before retrying`)
    }
    // Reusing the local push evidence is only safe while the remote still points at this HEAD: after a deleted or
    // force-pushed branch the publish would skip the push and open an MR for a commit the remote never got.
    const remoteHead = cwdHead && ticket.links?.push?.sha === cwdHead
      ? await (deps.remoteBranchSha ?? remoteBranchSha)({ cwd, branch }) : undefined
    const reusePushed = remoteHead?.checked && remoteHead.sha === cwdHead
      ? { ...ticket.links.push, reused: true } : undefined
    if (mrMode === 'push') {
      const pushed = reusePushed ?? await deliverPush({ ticket, cwd, branch, repo, deps, persist,
        pushOptions: usesPushOptionMr(repo) ? pushOptionsFor(ticket, repo) : [] })
      run.push = pushed
      mr = pushed.mergeRequest
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha,
        ...(reusePushed ? { detail: 'HEAD already pushed; reused remote evidence' } : {}) })
      step('merge-request', { state: mr?.webUrl ? 'ok' : 'pending', webUrl: mr?.webUrl, mode: 'push' })
      ticket.links = { ...ticket.links, branch, worktree: cwd }
      linkMergeRequest(ticket, mr, { mode: 'push', pending: !mr?.webUrl, headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
      ticket.status = 'mr-open'
      run.status = 'mr-open'
    } else {
      const pushed = reusePushed ?? await deliverPush({ ticket, cwd, branch, repo, deps, persist })
      run.push = pushed
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha,
        ...(reusePushed ? { detail: 'HEAD already pushed; reused remote evidence' } : {}) })
      const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
      try {
        if (stopRequested()) {
          step('merge-request', { state: 'skipped', detail: 'stop requested after push; MR step skipped' })
          throw new StageError('stopped', 'stop requested after push')
        }
        // Same query-first rule as the normal delivery: the branch is already pushed, the create may have landed before
        // a lost response, and a failed lookup must never create a duplicate (review P1 AC-04).
        const opened = await openOrAdoptMergeRequest({ gitlab, sourceBranch: branch,
          targetBranch: repo.gitlab.targetBranch, title: `Superagent: ${ticket.title}`,
          description: mergeRequestDescription(ticket, run, repo), headSha: pushed.sha })
        mr = opened.mr
        step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl,
          ...(opened.adopted ? { detail: 'adopted existing merge request' } : {}) })
      } catch (error) {
        if (error?.code === 'stopped') {
          ticket.links = { ...ticket.links, branch, worktree: cwd }
          ticket.status = 'pushed'
          run.status = 'pushed'
          run.stopReason = 'done'
          // Confirming on the authoritative entry keeps the next run from aborting on a stale request.
          confirmStopOnAuthoritative(engine, ticket.id, ticket, run)
          markRunComplete({ run, ticket, to: 'pushed', detail: 'branch pushed; MR skipped after stop request' })
          await persist()
          await recordDeliveryEvidence({ engine, ticket, run, repo })
          return run
        }
        if (error?.code === 'mr_lookup_failed') {
          // Unknown is a state, not an excuse to create: keep the pushed branch and mark the MR unverified so the next
          // verify/publish can reconcile it, instead of failing the delivery or duplicating the create (AC-04).
          run.mergeRequestError = messageOf(error)
          run.mergeRequestUnknown = true
          run.errorCode = 'mr_failed'
          ticket.links = { ...ticket.links, branch, worktree: cwd,
            mergeRequest: { ...(ticket.links?.mergeRequest ?? {}), pending: true, unverified: true,
              headSha: pushed.sha ?? ticket.links?.commit } }
          ticket.status = 'pushed'
          run.status = 'pushed'
          step('merge-request', { state: 'unknown', message: run.mergeRequestError })
          markRunComplete({ run, ticket, to: 'pushed', summary: run.mergeRequestError,
            detail: 'branch pushed; MR state unknown' })
          await persist()
          await recordDeliveryEvidence({ engine, ticket, run, repo })
          return run
        }
        // Keep the old contract: a create that did not succeed is an MR failure, not a generic run failure.
        throw new StageError('mr_failed', messageOf(error))
      }
      ticket.links = { ...ticket.links, branch, worktree: cwd }
      linkMergeRequest(ticket, mr, { mode: 'api', headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
      // An adopted MR may already be merged: recording ci-pending made the panel offer a merge that already happened
      // and the auto-verify chase a closed MR.
      ticket.status = mr?.state === 'merged' ? 'merged' : repo.gitlab.ci === false ? 'mr-open' : 'ci-pending'
      run.status = ticket.status
      run.mergeRequest = mr
      step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl })
    }
    run.stopReason = 'done'
    const mrUrl = ticket.links?.mergeRequest?.webUrl
    markRunComplete({ run, ticket, to: ticket.status,
      summary: mrUrl ? `MR: ${mrUrl}` : `branch ${branch} pushed`,
      detail: `published: ${ticket.status}` })
    await persist()
    // AC-08: the manual publish path is a delivery too; without this the evidence pack misses it entirely.
    await recordDeliveryEvidence({ engine, ticket, run, repo })
    // A stop that arrived while the MR was being opened still finishes the delivery, but must be confirmed here so the
    // durable request cannot make the panel show "正在停止" or abort the next run (AC-03 completion/stop race).
    if (stopRequested()) {
      const at = new Date().toISOString()
      confirmStopOnAuthoritative(engine, ticketId, ticket, run, at)
      step('stop', { state: 'ok', message: 'stopped by an operator', at,
        phase: run.checkpoint?.phase, worktree: run.worktree, branch: run.branch,
        baseSha: run.baseSha, changedPaths: run.changedPaths })
      await persist()
      return run
    }
    if (config.executor.allowReply) await replyToSource(engine, config, loaded, ticket, run, repo)
    return run
  } catch (error) {
    // A requested stop is not a failure: keep the worktree and the steps that did run, and leave a resumable Ticket.
    if (error?.code === 'stopped') {
      const at = new Date().toISOString()
      run.status = 'stopped'
      run.stopReason = 'stopped'
      run.stoppedAt = at
      // Confirmed only after the worker/gate really ended; keep the request facts so "stopped" is auditable and the
      // Ticket is immediately runnable again instead of aborting the next run on the stale marker.
      confirmStopOnAuthoritative(engine, ticketId, ticket, run, at)
      ticket.status = 'ready'
      ticket.updatedAt = at
      const assignment = ticket.assignments?.at(-1)
      if (assignment) {
        assignment.state = 'ended'
        assignment.endedAt = at
        assignment.report = { state: 'stopped', text: '已按人工请求停止；工作树与已完成步骤保留', at }
      }
      step('stop', { state: 'ok', message: 'stopped by an operator', at,
        phase: run.checkpoint?.phase, worktree: run.worktree, branch: run.branch,
        baseSha: run.baseSha, changedPaths: run.changedPaths })
      addActivity(ticket, { kind: 'run', actorKind: 'human', detail: '已停止执行（保留工作树）', at, refs: { runId } })
      await persist().catch(() => {})
      // The stopped round is evidence too: the next round must be comparable even after the worktree is gone.
      await recordDeliveryEvidence({ engine, ticket, run, repo })
      return run
    }
    failRun({ run, ticket, error, step, engine })
    await persist().catch(() => {})
    await recordDeliveryEvidence({ engine, ticket, run, repo })
    return run
  } finally {
    clearInterval(stopTimer)
    await persist().catch(() => {})
  }
}


/**
 * Has this branch commit reached the deploy branch? Uses git only, so it works without a GitLab token.
 * @param {any} options
 */
export async function checkMerged({ repo, baseBranch, sha, deps = /** @type {any} */ ({}) }) {
  const runGit = deps.git ?? git
  try {
    await runGit(['fetch', 'origin', baseBranch], repo, { timeoutMs: 60_000 })
    const devSha = await runGit(['rev-parse', `origin/${baseBranch}`], repo)
    const merged = await runGit(['merge-base', '--is-ancestor', sha, `origin/${baseBranch}`], repo)
      .then(() => true).catch(() => false)
    return { merged, devSha, sha }
  } catch (error) {
    return { merged: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Fingerprint the UAT surface from its HTML asset references. A new deployment changes those references, so the
 * fingerprint gives token-free evidence that the UAT build actually changed (200 alone cannot show that).
   * @param {any} [options]
 */
export async function uatFingerprint({ url, fetchImpl, timeoutMs = 15_000 } = {}) {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'uatUrl is not configured', checkedAt: new Date().toISOString() }
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch is unavailable', checkedAt: new Date().toISOString() }
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    const text = typeof response.text === 'function' ? await response.text() : ''
    if (response.status < 200 || response.status >= 400) return { ok: false, status: response.status, url, checkedAt }
    const assets = [...String(text).matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]).sort()
    const hash = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
    const header = name => (response.headers && typeof response.headers.get === 'function'
      ? response.headers.get(name) : undefined)
    // The deploy replaces the web dist on every pipeline, so index.html's mtime (and ETag) changes even when the
    // frontend sources produce identical asset names. That makes Last-Modified a deployment signal for backend fixes.
    return { ok: true, status: response.status, url, hash, assets: assets.length,
      lastModified: header('last-modified') ?? undefined, etag: header('etag') ?? undefined, checkedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url, checkedAt }
  }
}

/**
 * Verify one ticket against its repository:
 * - `web-uat`: token-free merge + UAT fingerprint + health check, as before.
 * - `manual`: only observe the MR/merge into the target branch; a person accepts the result on the panel.
 */
export async function verifyTicket(options) {
  return withTicketClaim(options.ticketId, 'verifying', () => verifyTicketInner(options))
}

  /** @param {any} options */
async function verifyTicketInner({ engine, ticketId, deps = /** @type {any} */ ({}) }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  // A dismissed/closed Ticket is an end state a person chose: a platform observation must not resurrect it as merged
  // or deployed (the panel then offered "验收" again for work somebody had explicitly dropped).
  if (ticket.status === 'dismissed' || ticket.status === 'closed') {
    return { status: ticket.status, verification: ticket.links?.verification ?? null, skipped: 'terminal-status' }
  }
  // An explicit human action (publish / verify) always wins over a queued stop marker.
  if (ticket.stop) delete ticket.stop
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  const token = repoToken(loaded, repo)
  // P2 §2.2: a draft/WIP merge request is not ready for verification. Record the flag and skip the merge/UAT judgement
  // (a draft never deploys, so treating it as untouched is truthful and avoids burning the auto-verify budget).
  const linkedMr = ticket.links?.mergeRequest
  const draftTitle = typeof linkedMr?.title === 'string' && /^\s*(draft|wip)[:\s]/i.test(linkedMr.title)
  if (linkedMr && (linkedMr.workInProgress === true || draftTitle)) {
    const at = new Date().toISOString()
    ticket.links = { ...ticket.links, mergeRequest: { ...linkedMr, draft: true } }
    ticket.updatedAt = at
    await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
    return { status: ticket.status, skipped: 'draft' }
  }
  let sha = ticket.links?.commit
  if (!sha && ticket.links?.worktree) {
    sha = await git(['rev-parse', 'HEAD'], ticket.links.worktree).catch(() => undefined)
    if (sha) ticket.links = { ...ticket.links, commit: sha }
  }
  const merged = sha
    ? await checkMerged({ repo: repo.repo, baseBranch: repo.gitlab.targetBranch, sha, deps })
    : { merged: false, error: 'ticket has no commit sha yet' }

  if (repo.verifyMode === 'manual') {
    // With a GitLab token the MR state is authoritative (covers squash/merge commits); git ancestry is the fallback.
    let mrState
    const patch = {}
    const makeGitlab = deps.createGitlabClient ?? createGitlabClient
    if (isGithubRepo(repo) && ticket.links?.branch) {
      // A `/pull/new/` creation link is not a PR. Ask GitHub (read-only) whether the branch already has one; a
      // query failure leaves the waiting state in place instead of inventing a number.
      try {
        const github = (deps.createGithubClient ?? createGithubClient)({ repo: repo.gitlab.project,
          token: process.env.GITHUB_TOKEN, fetchImpl: deps.fetchImpl })
        const pulls = await github.listPullRequests({ sourceBranch: ticket.links.branch, state: 'all' })
        const found = pulls.find(pull => pull.state === 'merged') ?? pulls.find(pull => pull.state === 'opened')
          ?? pulls.find(pull => pull.state === 'closed')
        if (found) {
          mrState = found.state
          patch.mergeRequest = { ...ticket.links.mergeRequest, iid: found.iid, webUrl: found.webUrl,
            state: found.state, title: found.title, mode: 'github', pending: false }
        }
      } catch (error) {
        patch.mergeRequestError = error instanceof Error ? error.message : String(error)
      }
    } else if (ticket.links?.mergeRequest?.iid && token) {
      try {
        const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
        const mr = await gitlab.getMergeRequest(ticket.links.mergeRequest.iid)
        mrState = mr?.state
        patch.mergeRequest = { ...ticket.links.mergeRequest, state: mr.state, webUrl: mr.webUrl ?? ticket.links.mergeRequest.webUrl }
      } catch (error) {
        patch.mergeRequestError = error instanceof Error ? error.message : String(error)
      }
    }
    const isMerged = Boolean(merged.merged || mrState === 'merged')
    const verification = { merged: isMerged, sha, devSha: merged.devSha, mode: 'manual', at: new Date().toISOString(),
      ...(merged.error ? { mergeError: merged.error } : {}), ...(mrState ? { mergeRequestState: mrState } : {}) }
    let status = ticket.status
    if (isMerged) status = 'merged'
    else if (mrState === 'closed') status = 'closed'
    else if ((mrState === 'opened' || mrState === 'open') && ticket.status === 'pushed') status = 'mr-open'
    ticket.links = { ...ticket.links, verification, ...patch }
    ticket.status = status
    ticket.updatedAt = verification.at
    await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
    // AC-05: a later platform confirmation is appended to the delivery evidence, not mistaken for a new round.
    await engine.evidence?.updateLatest?.(ticketId, { platform: {
      ...(patch.mergeRequest?.iid ? { pr: { state: mrState ?? 'open', iid: patch.mergeRequest.iid,
        webUrl: patch.mergeRequest.webUrl } } : {}),
      merged: isMerged,
    } }).catch(error => engine.log?.(`verify evidence ${ticketId} failed: ${messageOf(error)}`))
    return { status, verification }
  }

  const uat = await uatFingerprint({ url: repo.gitlab.uatUrl, fetchImpl: deps.fetchImpl })
  const health = await uatFingerprint({ url: repo.gitlab.healthUrl, fetchImpl: deps.fetchImpl })
  const before = ticket.links?.verification
  const capture = !before || !before.baselineLastModified
  // Merged before any pre-merge fingerprint was stored (MR merged between verify ticks): take this observation as the
  // baseline and count it as the deployment, otherwise `changed` can never become true and /accept stays blocked.
  const baselineMissing = !before?.baselineHash && !before?.baselineLastModified && !before?.baselineEtag
  const firstAfterMerge = merged.merged === true && baselineMissing
  const baselineHash = before?.baselineHash ?? (merged.merged && !firstAfterMerge ? undefined : uat.hash)
  const baselineLastModified = before?.baselineLastModified
    ?? (capture && (!merged.merged || firstAfterMerge) ? uat.lastModified : undefined)
  const baselineEtag = before?.baselineEtag ?? (capture && (!merged.merged || firstAfterMerge) ? uat.etag : undefined)
  const changed = Boolean(
    (baselineHash && uat.hash && baselineHash !== uat.hash)
    || (baselineLastModified && uat.lastModified && baselineLastModified !== uat.lastModified)
    || (baselineEtag && uat.etag && baselineEtag !== uat.etag))
  const verification = { merged: merged.merged, sha, devSha: merged.devSha, uat, health,
    baselineHash, baselineLastModified, baselineEtag, changed,
    at: new Date().toISOString(), ...(merged.error ? { mergeError: merged.error } : {}) }
  let status = ticket.status
  if (merged.merged) {
    if (!uat.ok) status = 'deploy-pending'
    else if (changed || firstAfterMerge) status = 'deployed'
    else status = 'deploy-pending'
  }
  ticket.links = { ...ticket.links, verification }
  ticket.status = status
  ticket.updatedAt = verification.at
  await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
  // AC-05: deployment evidence is appended to the delivery round; the code snapshot stays the delivery commit.
  await engine.evidence?.updateLatest?.(ticketId, { platform: {
    merged: merged.merged, deployed: status === 'deployed', deployCommit: ticket.links?.deployment?.commit,
  } }).catch(error => engine.log?.(`verify evidence ${ticketId} failed: ${messageOf(error)}`))
  return { status, verification }
}


// A Ticket that never got an MR is retried on a widening clock instead of every verify tick: orphan detection matches
// nearly every failed Ticket, so a fixed 2-minute retry meant one platform API call per failed Ticket forever (and a
// rate-limited token fails the healthy verifications too).
const RECONCILE_BASE_MS = 10 * 60 * 1000
const RECONCILE_MAX_MS = 12 * 60 * 60 * 1000
const RECONCILE_MAX_ATTEMPTS = 8

/** Record one fruitless reconcile pass so the next attempt waits (and stop after RECONCILE_MAX_ATTEMPTS). */
async function recordReconcileMiss(engine, ticketId) {
  let next
  const at = new Date()
  await engine.state.atomic((doc) => {
    const current = doc.tickets?.[ticketId]
    if (!current) return
    const attempts = (Number(current.links?.reconcile?.attempts) || 0) + 1
    const delay = Math.min(RECONCILE_BASE_MS * 2 ** Math.min(attempts - 1, 10), RECONCILE_MAX_MS)
    next = { attempts, nextAt: new Date(at.getTime() + delay).toISOString(), lastAt: at.toISOString(),
      ...(attempts >= RECONCILE_MAX_ATTEMPTS ? { exhausted: true } : {}) }
    doc.tickets[ticketId] = { ...current, links: { ...(current.links ?? {}), reconcile: next } }
  })
  return next
}

/**
 * Whether the orphan heal should look at this Ticket now: no recorded miss, or its backoff has elapsed.
 * Exported so the engine's sweep and this pass share one rule.
 */
export function reconcileDue(ticket, now = Date.now()) {
  const state = ticket?.links?.reconcile
  if (state?.exhausted === true) return false
  const nextAt = Date.parse(state?.nextAt ?? '')
  return !Number.isFinite(nextAt) || nextAt <= now
}

/**
 * Heal a Ticket whose local run was interrupted after the GitLab side had already happened: look the MR up by source
 * branch (including deleted source branches), reattach its link and move the Ticket to the truthful status.
 */
export async function reconcileTicketFromGitlab({ engine, ticketId, deps = /** @type {any} */ ({}) }) {
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (ticket.links?.mergeRequest?.iid) return { skipped: 'has-mr' }
  const branch = ticket.links?.branch
  if (typeof branch !== 'string' || !branch) return { skipped: 'no-branch' }
  const repo = ticketRepo(config, ticket)
  if (!repo) return { skipped: 'no-repo' }
  const gitlabToken = repoToken(loaded, repo)
  const githubToken = isGithubRepo(repo) ? process.env.GITHUB_TOKEN : undefined
  const token = isGithubRepo(repo) ? githubToken : gitlabToken
  if (!token && !isGithubRepo(repo)) return { skipped: 'no-token' }
  let mergeRequests
  try {
    mergeRequests = isGithubRepo(repo)
      ? await (deps.createGithubClient ?? createGithubClient)({ repo: repo.gitlab.project, token,
        fetchImpl: deps.fetchImpl }).listPullRequests({ sourceBranch: branch, state: 'all' })
      : await makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
        .listMergeRequests({ sourceBranch: branch, state: 'all' })
  } catch (error) {
    return { skipped: 'error', error: messageOf(error), reconcile: await recordReconcileMiss(engine, ticketId) }
  }
  if (!Array.isArray(mergeRequests) || !mergeRequests.length) {
    return { skipped: 'no-mr', reconcile: await recordReconcileMiss(engine, ticketId) }
  }
  const merged = mergeRequests.find(mr => mr.state === 'merged')
  const open = mergeRequests.find(mr => mr.state === 'opened')
  const mr = merged ?? open ?? mergeRequests[0]
  const status = mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'mr-open'
  const at = new Date().toISOString()
  const mergeRequest = { iid: mr.iid, webUrl: mr.webUrl, state: mr.state, mode: 'api', reconciled: true }
  const links = { ...(ticket.links ?? {}), mergeRequest,
    ...(mr.sha ? { commit: mr.sha } : {}),
    ...(status === 'merged' ? { verification: { ...(ticket.links?.verification ?? {}), merged: true,
      sha: mr.sha ?? ticket.links?.commit, targetBranch: mr.targetBranch ?? repo.gitlab.targetBranch, at, reconciled: true } } : {}),
    reconciled: { at, source: 'gitlab-mr', previousStatus: ticket.status } }
  // The heal answered the question: drop the backoff so a later re-link starts from a clean slate.
  delete links.reconcile
  await engine.state.atomic((doc) => {
    const current = doc.tickets[ticketId]
    doc.tickets[ticketId] = { ...current, status, updatedAt: at, links }
  })
  return { ticket: { ...ticket, status, links }, mergeRequest, status }
}
