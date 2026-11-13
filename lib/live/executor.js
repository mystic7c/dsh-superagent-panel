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
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { readToken } from './config.js'
import { recordId } from './state.js'
import {
  prepareWorktree, assertSafeWorktree, changedPaths, commitAll, pushBranch, hasChanges, git,
} from './repo.js'
import { runWorker } from './worker.js'
import { runCliWorker, workerBackendOf } from './worker-cli.js'
import { resolveRoute } from './routing.js'
import { createGitlabClient, summarizeJobs, pipelineStatusOf } from './gitlab.js'
import { repoOf, ticketRepo, repoToken, configRepos, workflowResumable } from './repos.js'
import { OperationStore, summarizeRun } from './operations.js'
import { AcceptanceStore, checkFromGate } from './acceptance.js'
import { appendActivity } from './activities.js'

const OUTPUT_TAIL = 4000

/** Run one shell command with a timeout, capturing a bounded tail of stdout+stderr. */
export function runCommand(command, { cwd, timeoutMs = 600_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...env } })
    let output = ''
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, output: output.slice(-OUTPUT_TAIL), durationMs: Date.now() - startedAt })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      settle({ exitCode: 124, timedOut: true })
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.on('error', error => settle({ exitCode: 127, error: error.message }))
    child.on('close', code => settle({ exitCode: code ?? 1, timedOut: false }))
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
      timeoutMs: gate.timeoutMs ?? settings?.executor?.gateTimeoutMs ?? 600_000 }
  }
  return map
}

/**
 * Effective command of one gate: the dry-run variant in a dry run, and — for `passChangedFiles` gates — the executor's
 * own changed-path list appended as argv. Both gate phases (run and publish) must build the command the same way, or a
 * `--changed`-style gate receives no files and fails before running (the publish path used to skip this).
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

/** Worker prompt: the project rules an executor session must follow, plus the ticket's boundaries. */
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

// ---------------------------------------------------------------------------
// Run bookkeeping shared by executeTicket / resumeTicket / publishTicket (P0 contract §1.1). Every step refreshes
// `leaseAt`; a success ends with stopReason='done', a failure carries a machine-readable stopReason/errorCode pair.
// ---------------------------------------------------------------------------

const TRACE_LIMIT = 80
const TRACE_SUMMARY_LIMIT = 300
const TRACE_TYPES = new Set(['assistant', 'tool_call', 'tool_result', 'turn_end', 'error'])

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

/** UI phase of one step name (contract §7 checkpoint phases). */
function phaseOfStep(name, detail = {}) {
  if (name === 'resume:checkpoint') return detail.phase ?? 'gates'
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

/** Final handoff of a run: worker summary (front 300 chars) + changed paths. */
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
 */
function linkMergeRequest(ticket, mr, { mode, pending, headSha } = {}) {
  const sha = headSha ?? ticket.links?.commit
  const mergeRequest = {
    ...(ticket.links?.mergeRequest ?? {}),
    ...(mr ?? {}),
    ...(mode ? { mode } : {}),
    ...(pending !== undefined ? { pending } : {}),
    ...(sha ? { headSha: sha } : {}),
  }
  ticket.links = { ...ticket.links, mergeRequest }
  if (sha && ticket.links?.pipeline) {
    ticket.links = { ...ticket.links, pipeline: { ...ticket.links.pipeline, headSha: sha } }
  }
}

/** Mark the run finished: completion time, handoff and the Ticket-level status activity. */
function markRunComplete({ run, ticket, to, summary, detail, nextAction }) {
  const at = new Date().toISOString()
  run.completedAt = at
  writeHandoff(run, { summary: summary ?? run.worker?.text ?? run.error, nextAction })
  if (to) {
    addActivity(ticket, { kind: 'status', actorKind: 'system', from: 'working', to,
      detail: detail ?? `run ${run.stopReason ?? run.status}`, at, refs: { runId: run.id } })
  }
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
function acceptanceCheck(gate, result) {
  const onFail = onFailOf(gate)
  if (!result) {
    return { id: recordId('chk'), name: gate.name, required: gate.required !== false, verifierType: 'program', onFail,
      status: 'skipped' }
  }
  const check = checkFromGate(gate, { exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
    output: result.output })
  check.onFail = onFail
  // A timed-out gate or one whose command could not start is an infrastructure error, not a failing gate.
  if (result.timedOut || result.exitCode === 127) check.status = 'errored'
  const missingEvidence = Boolean(gate.requireOutput) && !String(result.output ?? '').includes(gate.requireOutput)
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

/** `release` of a parked gate: the checks that failed are skipped with a note, the round is completed. */
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

/** Newest-first most recent interrupted run of one Ticket (operation ledger first, state index as fallback). */
async function interruptedRunOf(engine, ticket) {
  const operations = await ensureStore(engine, 'operations', OperationStore)
  if (operations && typeof operations.get === 'function') {
    if (ticket.runId) {
      const preferred = operations.get(ticket.runId)
      if (preferred?.status === 'interrupted') return preferred
    }
    if (typeof operations.list === 'function') {
      const found = operations.list({ ticketId: ticket.id, limit: 20 }).find(run => run.status === 'interrupted')
      if (found) return found
    }
  }
  const runs = (engine.state?.runs ?? []).filter(run => run.ticketId === ticket.id)
  if (ticket.runId) {
    const preferred = runs.find(run => run.id === ticket.runId)
    if (preferred?.status === 'interrupted') return preferred
  }
  return runs
    .slice()
    .sort((left, right) => String(right.startedAt ?? '').localeCompare(String(left.startedAt ?? '')))
    .find(run => run.status === 'interrupted')
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
function createRunRecorder({ engine, ticket, ticketId, run, log = () => {}, label = 'executor' }) {
  const step = (name, detail) => {
    const at = new Date().toISOString()
    run.steps = run.steps ?? []
    run.steps.push({ name, at, ...detail })
    run.leaseAt = at
    run.checkpoint = checkpointOf(run, name, detail ?? {}, at)
    log(`${label} ${ticketId}: ${name}${detail && detail.state ? ` ${detail.state}` : ''}`)
  }
  const persist = async () => {
    const operations = await ensureStore(engine, 'operations', OperationStore)
    if (operations) await operations.save(run)
    await engine.state.atomic((doc) => {
      doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket }
      // The ledger holds the full operation; the state document keeps only the light index row. Without a ledger
      // (bare test engine) the full run stays in the state document so the resume paths keep working.
      const entry = operations ? summarizeRun(run) : run
      doc.runs = [entry, ...(doc.runs ?? []).filter(item => item.id !== run.id)].slice(0, 100)
    })
  }
  return { step, persist }
}

const REPAIR_LIMIT = 3

/** Configured automatic repair round cap (contract §1.1: 0..3, default 1). */
function repairMaxOf(config) {
  const value = config?.executor?.maxRepairRounds
  if (!Number.isFinite(value)) return 1
  return Math.max(0, Math.min(REPAIR_LIMIT, Math.floor(value)))
}

/** Failed gates of one gate phase, joined with their repository configuration (onFail / repairHint). */
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

/** Repair worker task: the original worker task plus the failed gate evidence and the configured repair hint. */
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
 * Run every gate of the repository on the worktree and collect the evidence. Returns `{ gates, failure }` when a gate
 * fails (the caller parks the run for a human) and `{ gates, error }` when the dependency bootstrap itself broke (a
 * fatal bootstrap_failed, not a human gate decision). A fresh worktree has no node_modules, so the frontend gate needs
 * a pnpm install first — the same condition applies to executeTicket and to a `resume retry`.
 */
async function runGatePhase({ repo, config, command, cwd, paths, dryRun, step }) {
  const commands = gateCommands(repo, config)
  const gateNames = (repo.gates ?? []).map(gate => gate.name)
  const gates = []
  if (gateNames.includes('frontend')) {
    step('bootstrap:pnpm', { state: 'running', command: 'pnpm install --frozen-lockfile' })
    const bootstrap = await command('pnpm install --frozen-lockfile', { cwd, timeoutMs: config.executor.gateTimeoutMs })
    step('bootstrap:pnpm', { state: bootstrap.exitCode === 0 ? 'ok' : 'failed', exitCode: bootstrap.exitCode })
    if (bootstrap.exitCode !== 0) {
      return { gates, error: { code: 'bootstrap_failed', message: `pnpm install failed (exit ${bootstrap.exitCode})` } }
    }
  }
  for (const name of gateNames) {
    const spec = commands[name]
    if (!spec) continue
    // A fresh worktree has untracked new files; `--changed`-style git diff would miss them. Passing the executor's
    // own changed-path list makes the gate validate exactly what the worker changed.
    const gateCommand = gateCommandFor(spec, { paths, dryRun })
    step(`gate:${name}`, { state: 'running', command: gateCommand })
    const result = await command(gateCommand, { cwd, timeoutMs: spec.timeoutMs })
    const missingEvidence = Boolean(spec.requireOutput) && !String(result.output ?? '').includes(spec.requireOutput)
    gates.push({ name, command: gateCommand, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs,
      output: result.output, ...missingEvidence ? { missingEvidence: true } : {} })
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

/** Park a run on a failed gate: a human decides through resumeTicket; nothing is committed or pushed. */
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

/** Shared catch body: mark the run/Ticket failed and record the contract stopReason/errorCode pair. */
function failRun({ run, ticket, error, step }) {
  const message = messageOf(error)
  const code = error instanceof StageError ? error.code : (run.errorCode ?? 'error')
  // A worker that vanished is infrastructure, not a bad change: keep the worktree and leave the Ticket retryable so a
  // fresh run can resume on the same branch instead of the executor waiting on a `working` Ticket forever.
  const retryable = code === 'worker_lost'
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
 * Shared finalize segment of the pipeline: post-gates export, dry-run/allowPush exits, worktree guard, commit, push,
 * merge request and the final Ticket status. executeTicket and resumeTicket both call this — never duplicate it.
 * Every fatal step throws a StageError so the caller's failRun records the contract code.
 */
async function finishPipeline({ engine, loaded, config, repo, ticket, run, worktree, dryRun, allowPush, token, deps, step,
  persist, ticketEnv }) {
  const command = deps.runCommand ?? runCommand
  const pathsOf = deps.changedPaths ?? changedPaths
  const changes = deps.hasChanges ?? hasChanges
  const commit = deps.commitAll ?? commitAll
  const safe = deps.assertSafeWorktree ?? assertSafeWorktree
  const push = deps.pushBranch ?? pushBranch
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient

  if (!dryRun && repo.postGatesCommand) {
    step('export-repo', { state: 'running', command: repo.postGatesCommand })
    const exported = await command(repo.postGatesCommand, { cwd: worktree.path, timeoutMs: config.executor.timeoutMs,
      env: { ...ticketEnv, SUPERAGENT_CHANGED_PATHS: JSON.stringify(run.changedPaths ?? []) } })
    step('export-repo', { state: exported.exitCode === 0 ? 'ok' : 'failed', exitCode: exported.exitCode })
    if (exported.exitCode !== 0) throw new StageError('bootstrap_failed', `postGatesCommand failed (exit ${exported.exitCode})`)
    run.changedPaths = await pathsOf(worktree.path, worktree.baseSha)
  }

  if (ticket.workflow && (!ticket.workflowDigest || ticket.workflowDigest !== await (deps.candidateDigest ?? candidateDigest)(worktree.path))) throw new StageError('review_stale', 'Workflow evidence is missing or stale; rerun the workflow')

  if (dryRun) {
    run.status = 'dry-run'
    ticket.status = 'ready'
    run.stopReason = 'done'
    step('finish', { state: 'ok', detail: 'dry run: gates passed, nothing pushed' })
    markRunComplete({ run, ticket, to: 'ready', detail: 'dry run finished: gates passed, nothing pushed' })
    return
  }
  if (!allowPush) {
    run.status = 'gates-passed'
    ticket.status = 'ready'
    run.stopReason = 'done'
    step('finish', { state: 'ok', detail: 'executor.allowPush=false: push skipped' })
    markRunComplete({ run, ticket, to: 'ready', detail: 'gates passed; push skipped (allowPush=false)',
      nextAction: 'publish or enable executor.allowPush to deliver' })
    return
  }

  try {
    await safe({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix, baseSha: worktree.baseSha,
      extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
  } catch (error) { throw new StageError('guard_failed', messageOf(error)) }

  if (await changes(worktree.path)) {
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
  let pushed
  let mr
  if (mrMode === 'push') {
    try {
      pushed = await push({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix,
        pushOptions: usesPushOptionMr(repo) ? pushOptionsFor(ticket, repo) : [] })
    } catch (error) { throw new StageError('push_failed', messageOf(error)) }
    run.push = pushed
    if (pushed.sha) ticket.links = { ...ticket.links, commit: pushed.sha }
    step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
    await persist()
    mr = pushed.mergeRequest
    if (mr?.webUrl) step('merge-request', { state: 'ok', webUrl: mr.webUrl, mode: 'push' })
    else step('merge-request', { state: 'pending', detail: usesPushOptionMr(repo)
      ? 'MR created via push options; GitLab did not print its URL'
      : 'branch pushed; the remote printed no create-PR link' })
    linkMergeRequest(ticket, mr, { mode: 'push', pending: !mr?.webUrl, headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
  } else {
    try {
      pushed = await push({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix })
    } catch (error) { throw new StageError('push_failed', messageOf(error)) }
    run.push = pushed
    if (pushed.sha) ticket.links = { ...ticket.links, commit: pushed.sha }
    step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
    await persist()
    const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
    try {
      mr = await gitlab.createMergeRequest({ sourceBranch: worktree.branch, targetBranch: repo.gitlab.targetBranch,
        title: `Superagent: ${ticket.title}`, description: mergeRequestDescription(ticket, run) })
      step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl })
      linkMergeRequest(ticket, mr, { mode: 'api', headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
      await persist()
    } catch (error) {
      // The branch is already pushed: an MR API failure is recorded but does not undo the delivery.
      run.mergeRequestError = messageOf(error)
      run.stopReason = 'mr_failed'
      run.errorCode = 'mr_failed'
      step('merge-request', { state: 'failed', message: run.mergeRequestError })
    }
  }
  const ciObservable = Boolean(token) && repo.gitlab.ci !== false
  const opened = Boolean(ticket.links?.mergeRequest?.webUrl || ticket.links?.mergeRequest?.iid)
  ticket.status = opened ? (ciObservable ? 'ci-pending' : 'mr-open') : 'pushed'
  run.status = ticket.status
  if (!run.errorCode) run.stopReason = 'done'
  markRunComplete({ run, ticket, to: ticket.status, detail: `delivered: ${ticket.status}` })
  await persist()
  if (opened && config.executor.allowReply) await replyToSource(engine, config, loaded, ticket, run, repo)
}

/** Execute one ticket end to end. Returns the final run record (parked when a gate or a question needs a human). */
export async function executeTicket({ ctx, engine, ticketId, dryRun = false, trigger = 'manual', extraContext,
  backend: backendOverride, resumeWorkflow = false, log = () => {}, deps = {} }) {
  const prepare = deps.prepareWorktree ?? prepareWorktree
  const workerRun = deps.runWorker ?? runWorker
  const cliRun = deps.runCliWorker ?? runCliWorker
  const command = deps.runCommand ?? runCommand
  const pathsOf = deps.changedPaths ?? changedPaths
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  // Routing decides who executes and with which profile; `suggest` records the decision but keeps the default backend.
  const route = resolveRoute({ ticket, config, override: backendOverride })
  const execBackend = route.execBackend
  const execProfile = route.execProfile
  const backendOptions = config.executor.workers?.[execBackend] ?? {}
  // In-process DSH workers honor a repository preset, else the executor default; empty means the host default.
  const workerPreset = repo.workerPreset ?? config.executor.workerPreset
  const token = repoToken(loaded, repo)
  const ticketEnv = ticketEnvOf(ticket, repo)
  if (ticket.status === 'working') throw new Error(`ticket ${ticketId} is already working`)
  if (!dryRun && !config.executor.enabled) throw new Error('executor.enabled is false in live.json')
  const allowPush = !dryRun && config.executor.allowPush === true
  const runId = recordId('run')
  const at = new Date().toISOString()
  const reportFile = await prepareReportFile(engine, runId)
  const run = { id: runId, ticketId, dryRun, trigger, status: 'running', startedAt: at, leaseAt: at, steps: [],
    worktree: undefined, branch: undefined, mergeRequest: undefined, pipeline: undefined, error: undefined,
    repair: { attempts: 0, max: repairMaxOf(config), status: 'none' } }
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId, run, log })
  const fail = (code, message) => { run.stopReason = code; run.errorCode = code; return new StageError(code, message) }

  // The route is part of the run record and of the Ticket: the panel shows who was suggested, who actually ran, and why.
  run.route = { workType: route.workType, profile: route.profile, deliverable: route.deliverable,
    backend: route.backend, reason: route.reason, mode: route.mode, applied: route.applied,
    execBackend, execProfile, ...(route.unsupported ? { unsupported: route.unsupported } : {}) }
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
    // A routed backend that lacks the capability the work type needs cannot run: fail loudly instead of silently
    // handing the Ticket to a worker that will do the wrong thing.
    if (route.applied && route.unsupported) {
      throw fail('route_unsupported', `backend ${route.backend} cannot run ${route.workType}: ${route.unsupported}`)
    }
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
        prepared = await command(repo.prepareCommand, { cwd: worktree.path, timeoutMs: config.executor.timeoutMs, env: ticketEnv })
      } catch (error) { throw fail('prepare_failed', messageOf(error)) }
      step('prepare-repo', { state: prepared.exitCode === 0 ? 'ok' : 'failed', exitCode: prepared.exitCode })
      if (prepared.exitCode !== 0) throw fail('prepare_failed', `prepareCommand failed (exit ${prepared.exitCode})`)
    }

    if (config.executor.workflowMode && config.executor.workflowMode !== 'off') {
      delete ticket.workflowDigest
      const resumed = resumeWorkflow === true && Boolean(ticket.workflow)
      if (resumed) {
        // Gates are not re-run on resume, so record what the worktree currently changes for the run's diff view.
        run.changedPaths = await pathsOf(worktree.path, worktree.baseSha)
        const failed = [...ticket.workflow.stages].reverse().find(item => item?.status === 'failed')
        step('workflow:resume', { state: 'running', from: failed?.role, round: ticket.workflow.repairs })
      }
      await executeWorkflow({ run, ticket, config, cwd: worktree.path,
        brief: workerBrief(ticket, config, repo), task: workerTask(ticket, repo, extraContext ?? answerContext(ticket)),
        cli: cliRun, dsh: options => workerRun({ ctx, ...options, preset: workerPreset }),
        reviewer: repo.reviewer ?? config.executor.reviewer, persist,
        digest: deps.candidateDigest ? () => deps.candidateDigest(worktree.path) : undefined,
        resume: resumed,
        gates: async () => {
          const paths = await pathsOf(worktree.path, worktree.baseSha)
          run.changedPaths = paths
          const phase = await runGatePhase({ repo, config, command, cwd: worktree.path, paths, dryRun, step })
          run.gates = phase.gates
          await recordAcceptanceRound({ engine, ticket, run, repo, gates: phase.gates,
            outcome: phase.error || phase.failure ? 'parked' : 'completed' })
          return { passed: paths.length > 0 && !phase.error && !phase.failure, results: phase.gates }
        } })
      if (resumed) step('workflow:resume', { state: 'ok', completed: ticket.workflow.stages.length })
      await finishPipeline({ engine, loaded, config, repo, ticket, run, worktree, dryRun, allowPush, token, deps, step, persist, ticketEnv })
      return run
    }

    step('worker', { state: 'running', sessionId: undefined, backend: execBackend, profile: execProfile })
    const brief = workerBrief(ticket, config, repo)
    const readOnlyInstruction = execProfile === 'read-only'
      ? '\n\n---\nREAD-ONLY RUN: do not modify any file. Do the analysis/review/research and return the complete result as your final message; the executor delivers it as the Ticket report.'
      : ''
    const task = `${workerTask(ticket, repo, extraContext ?? answerContext(ticket))}${readOnlyInstruction}`
    const workerSessionId = `worker-${ticketId}-${runId.slice(-6)}`
    // One worker turn on the same worktree; automatic repair rounds reuse the routed backend and profile.
    // The primary turn is the only one that gets the report file (a repair turn reports through run.repairs).
    const invokeWorker = ({ sessionId = workerSessionId, turnTask = task, repair = false } = {}) => (
      execBackend === 'dsh'
        ? workerRun({ ctx, cwd: worktree.path, systemPrompt: brief, task: turnTask, model: config.executor.model,
          preset: workerPreset,
          timeoutMs: config.executor.timeoutMs, idleTimeoutMs: config.executor.workerIdleTimeoutMs, sessionId,
          readOnly: execProfile === 'read-only', log,
          ...(reportFile && !repair ? { reportFile } : {}) })
        : cliRun({ backend: execBackend, cwd: worktree.path, systemPrompt: brief, task: turnTask,
          model: backendOptions.model || config.executor.workerModel,
          command: backendOptions.command || config.executor.workerCommand,
          profile: execProfile, timeoutMs: config.executor.timeoutMs, sessionId, log })
    )
    let worker
    try { worker = await invokeWorker() } catch (error) { throw fail('worker_failed', messageOf(error)) }
    run.worker = { sessionId: worker.sessionId, timedOut: worker.timedOut, text: worker.text, toolCalls: worker.toolCalls,
      backend: worker.backend ?? execBackend, profile: execProfile }
    // The worker's normalised events live in run.trace only; run.worker keeps the historical fields.
    const trace = traceOf(worker.events)
    if (trace.length) run.trace = trace
    run.report = normalizeReport(worker.report)
    if (worker.usage !== undefined && worker.usage !== null) run.usage = worker.usage
    ticket.sessionId = worker.sessionId
    step('worker', { state: worker.timedOut || worker.error ? 'failed' : 'ok', sessionId: worker.sessionId,
      timedOut: worker.timedOut, error: worker.error, toolCalls: worker.toolCalls, backend: run.worker.backend,
      profile: execProfile })
    if (worker.timedOut) throw fail('timeout', 'worker timed out')
    // The watchdog settles a worker whose session/agent ended (or went idle) without a `turn/end`: fail fast instead of
    // leaving the run `working` until the 25-minute timeout, and let the Ticket be retried on the same worktree.
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

    // Gate phase with the contract's automatic repair loop (P2-2 §1.2): a failing gate whose configuration opts in
    // (`onFail: 'auto_repair'`) gets up to `executor.maxRepairRounds` extra worker turns on the same worktree.
    const repairMax = run.repair.max
    let gatePhase = await runGatePhase({ repo, config, command, cwd: worktree.path, paths, dryRun, step })
    let repairError
    while (gatePhase.failure) {
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
      gatePhase = await runGatePhase({ repo, config, command, cwd: worktree.path, paths, dryRun, step })
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

    await finishPipeline({ engine, loaded, config, repo, ticket, run,
      worktree: { path: worktree.path, branch: worktree.branch, baseSha: worktree.baseSha },
      dryRun, allowPush, token, deps, step, persist, ticketEnv })
    return run
  } catch (error) {
    failRun({ run, ticket, error, step })
    return run
  } finally {
    await persist().catch(() => {})
  }
}

/**
 * Human decision on a parked gate (P0-3). `retry` re-runs every gate on the same worktree (and parks again when one
 * fails), `release` records the skip and finalizes without re-running gates, `stop` ends the Ticket as failed.
 * Both finalize paths reuse finishPipeline — the pipeline is never duplicated.
 * @returns {Promise<{run:object, ticket:object}|{missing:true}|{invalid:string}>}
 */
export async function resumeTicket({ engine, ticketId, action, note, log = () => {}, deps = {} }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (!['stop', 'retry', 'release'].includes(action)) return { invalid: `unknown gate action: ${action}` }
  if (ticket.status !== 'gate-blocked') return { invalid: `ticket ${ticketId} is not waiting for a gate decision` }
  const run = await runOf(engine, ticket)
  if (!run) return { invalid: `run ${ticket.runId} not found` }
  if (!run.pendingGate) return { invalid: `run ${run.id} has no pending gate` }
  const repo = ticketRepo(config, ticket)
  if (!repo) return { invalid: `ticket ${ticketId} has no repository configured` }
  const token = repoToken(loaded, repo)
  const ticketEnv = ticketEnvOf(ticket, repo)
  const at = new Date().toISOString()
  run.trigger = 'resume'
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

  let baseSha
  try { baseSha = await (deps.git ?? git)(['rev-parse', `origin/${repo.baseBranch}`], repo.repo) } catch { baseSha = undefined }
  run.baseSha = run.baseSha ?? baseSha
  const worktree = { path: run.worktree, branch: run.branch, baseSha: run.baseSha }

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
        paths, dryRun, step })
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
    await finishPipeline({ engine, loaded, config, repo, ticket, run, worktree, dryRun, allowPush, token, deps, step,
      persist, ticketEnv })
    return { run, ticket }
  } catch (error) {
    failRun({ run, ticket, error, step })
    return { run, ticket }
  } finally {
    await persist().catch(() => {})
  }
}

/**
 * Answer a parked worker question (P1-4): record the Q/A pair on the Ticket, then re-run the whole ticket with the
 * answer appended to the worker task (a headless worker has no resumable session, so the ticket restarts).
 * @returns {Promise<{ticket:object, run:object}|{missing:true}|{invalid:string}>}
 */
export async function answerTicket({ engine, ticketId, answer, log = () => {}, deps = {} }) {
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (ticket.status !== 'awaiting-answer') return { invalid: `ticket ${ticketId} is not waiting for an answer` }
  const text = typeof answer === 'string' ? answer.trim() : ''
  if (!text) return { invalid: 'answer is required' }
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
  const loaded = engine.readConfig()
  const config = loaded.config
  // The engine owns the host context; the caller may override it (tests / alternate hosts) through deps.ctx.
  const ctx = deps.ctx ?? engine.ctx ?? {}
  const run = await executeTicket({ ctx, engine, ticketId, dryRun: false, trigger: 'resume', log, deps })
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
  if (!workflowResumable(ticket, config?.executor?.maxRepairRounds ?? 2)) return undefined
  const run = await runOf(engine, ticket)
  return run?.status === 'failed' ? run : undefined
}

/**
 * Resume one Ticket without starting its staged workflow over. Two cases share this entry point:
 * - an interrupted run (plugin reload/host restart) keeps its checkpoint fast path, as before;
 * - a failed run whose workflow is blocked at its last, replayable stage (implement/review) continues from the
 *   inputs that stage's key recorded, so completed assess/plan/implement/gates evidence is not redone.
 * @returns {Promise<{run:object, ticket:object}|{missing:true}|{invalid:string}>}
 */
export async function resumeInterruptedTicket({ engine, ticketId, log = () => {}, deps = {} }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (ticket.status === 'working') return { invalid: `ticket ${ticketId} is already working` }
  const previous = await interruptedRunOf(engine, ticket)
  const revivable = previous ? undefined : await resumableWorkflowOf(engine, ticket, config)
  if (!previous && !revivable) {
    // Say why a blocked staged workflow will not continue (budget exhausted, stale evidence, nothing replayable).
    if (ticket.workflow?.status === 'blocked') {
      return { invalid: `ticket ${ticketId} workflow blocked: ${blockedMessage(ticket.workflow)}` }
    }
    return { invalid: `ticket ${ticketId} has no interrupted run` }
  }
  const repo = ticketRepo(config, ticket)
  if (!repo) return { invalid: `ticket ${ticketId} has no repository configured` }
  const dryRun = (previous ?? revivable).dryRun === true
  if (!dryRun && !config.executor.enabled) return { invalid: 'executor.enabled is false in live.json' }
  if (!previous) {
    const ctx = deps.ctx ?? engine.ctx ?? {}
    const run = await executeTicket({ ctx, engine, ticketId, dryRun, trigger: 'resume', resumeWorkflow: true, log, deps })
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
  const run = await executeTicket({ ctx, engine, ticketId, dryRun, trigger: 'resume', log, deps })
  return { run, ticket: engine.state.tickets[ticketId] ?? ticket }
}

/** Fast checkpoint resume: new run on the existing worktree, re-run gates (idempotent) then finalize. */
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
  }
  const allowPush = !dryRun && config.executor.allowPush === true
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId: ticket.id, run, log })
  const fail = (code, message) => { run.stopReason = code; run.errorCode = code; return new StageError(code, message) }
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
      paths, dryRun, step })
    run.gates = gatePhase.gates
    await recordAcceptanceRound({ engine, ticket, run, repo, gates: gatePhase.gates,
      outcome: gatePhase.error ? 'errored' : gatePhase.failure ? 'parked' : 'completed' })
    if (gatePhase.error) throw fail(gatePhase.error.code, gatePhase.error.message)
    if (gatePhase.failure) {
      await parkOnGateFailure({ ticket, run, failure: gatePhase.failure, paths, step, persist })
      return { run, ticket }
    }
    await finishPipeline({ engine, loaded, config, repo, ticket, run,
      worktree: { path: run.worktree, branch: run.branch, baseSha: run.baseSha },
      dryRun, allowPush, token, deps, step, persist, ticketEnv })
    return { run, ticket }
  } catch (error) {
    failRun({ run, ticket, error, step })
    return { run, ticket }
  } finally {
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

/** Refresh the CI status of a ticket's MR and (once merged) the dev pipeline it triggered. */
export async function refreshTicketCi({ engine, ticketId, deps = {} }) {
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
    try {
      const pipelines = await gitlab.listPipelines({ ref: repo.gitlab.targetBranch, perPage: 20 })
      const branch = [...pipelines].sort((left, right) => Number(right.id) - Number(left.id))[0]
      if (branch) {
        const jobs = await gitlab.listPipelineJobs(branch.id).catch(() => [])
        const deploy = jobs.find(job => job.stage === 'deploy' || /deploy/i.test(job.name))
        patch.deployment = { pipelineId: branch.id, status: branch.status, webUrl: branch.webUrl,
          deployJob: deploy ? { name: deploy.name, status: deploy.status, webUrl: deploy.webUrl } : null }
        if (deploy?.status === 'success') {
          status = 'deployed'
          // A green deploy job is not proof the GUI answers; record one reachability check of the UAT URL.
          patch.deployment.uat = await checkUat(repo.gitlab.uatUrl, deps.fetchImpl)
        } else if (deploy?.status === 'failed' || branch.status === 'failed') status = 'deploy-failed'
        else status = 'deploy-pending'
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

/** Manually inject a ticket (used before the Octo group message exists, and by tests). */
export async function injectTicket({ engine, title, body, channelId, repoId, fromUid = 'manual' }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const repos = configRepos(config)
  const repo = repoId ? repos.find(item => item.id === repoId) : undefined
  if (repoId && !repo) throw new Error(`unknown repoId: ${repoId}`)
  const targetRepo = repo ?? repos.find(item => item.id === config.defaultRepo) ?? repos[0]
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
  records.ticket.title = String(title).slice(0, 64)
  records.ticket.body = String(body ?? title)
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
  return records.ticket
}

export { git, recordId, readToken }


/**
 * Publish an already-executed ticket without running the worker again: re-run the gates on the existing worktree,
 * commit/push the feature branch and open the merge request. Used after a dry run has produced reviewed changes.
 * Publishing is an explicit human action, so a failing gate fails the run directly (gate_failed) — it never parks.
 */
export async function publishTicket({ ctx, engine, ticketId, log = () => {}, deps = {}, commitMessage }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  const token = repoToken(loaded, repo)
  if (!config.executor.enabled) throw new Error('executor.enabled is false in live.json')
  if (!config.executor.allowPush) throw new Error('executor.allowPush is false in live.json')
  const mrMode = repo.gitlab.createMr === 'push' ? 'push' : 'api'
  if (mrMode === 'api' && !token) throw new Error(`gitlab token is not configured for ${repo.name} (set gitlab.createMr=push to open the MR without an API token)`)
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const branch = ticket.links?.branch ?? `${repo.featurePrefix}${ticketId}`
  const cwd = ticket.links?.worktree ?? `${repo.worktreeRoot}/${ticketId}`
  const runId = recordId('run')
  const startedAt = new Date().toISOString()
  const run = { id: runId, ticketId, dryRun: false, publish: true, trigger: 'publish', status: 'running', startedAt,
    leaseAt: startedAt, steps: [], branch, worktree: cwd }
  const { step, persist } = createRunRecorder({ engine, ticket, ticketId, run, log, label: 'publish' })
  const startedFrom = ticket.status
  ticket.status = 'working'
  ticket.updatedAt = startedAt
  addActivity(ticket, { kind: 'run', actorKind: 'system', from: startedFrom, to: 'working',
    detail: `publish ${runId}`, at: startedAt, refs: { runId } })
  await persist()
  try {
    const baseSha = await git(['rev-parse', `origin/${repo.baseBranch}`], repo.repo).catch(() => undefined)
    run.baseSha = baseSha
    const commands = gateCommands(repo, config)
    // Publishing re-runs the gates on the existing worktree, so it needs the same changed-path list the run phase
    // computed: without it, `passChangedFiles` gates (e.g. the EBS deploy/access scripts) are invoked with no files.
    const pathsOf = deps.changedPaths ?? changedPaths
    let paths = await pathsOf(cwd, baseSha).catch(() => [])
    const repairMax = repairMaxOf(config)
    // A publish repair edits files, so it always runs with the write profile on the routed backend.
    const publishRoute = resolveRoute({ ticket, config })
    const workerBackend = publishRoute.execBackend
    const backendOptions = config.executor.workers?.[workerBackend] ?? {}
    const brief = workerBrief(ticket, config, repo, { repair: true })
    const task = workerTask(ticket, repo, answerContext(ticket))
    const invokeRepairWorker = ({ sessionId, turnTask }) => (
      workerBackend === 'dsh'
        ? (deps.runWorker ?? runWorker)({ ctx, cwd, systemPrompt: brief, task: turnTask,
          model: config.executor.model, timeoutMs: config.executor.timeoutMs, sessionId, log })
        : (deps.runCliWorker ?? runCliWorker)({ backend: workerBackend, cwd, systemPrompt: brief, task: turnTask,
          model: backendOptions.model || config.executor.workerModel,
          command: backendOptions.command || config.executor.workerCommand,
          profile: 'write', timeoutMs: config.executor.timeoutMs, sessionId, log })
    )
    const runGates = async () => {
      const gates = []
      let failure
      for (const name of repo.gates.map(gate => gate.name)) {
        const spec = commands[name]
        if (!spec) continue
        const gateCommand = gateCommandFor(spec, { paths })
        step(`gate:${name}`, { state: 'running', command: gateCommand })
        const result = await (deps.runCommand ?? runCommand)(gateCommand, { cwd, timeoutMs: spec.timeoutMs })
        const missingEvidence = Boolean(spec.requireOutput) && !String(result.output ?? '').includes(spec.requireOutput)
        gates.push({ name, command: gateCommand, exitCode: result.exitCode, timedOut: result.timedOut,
          durationMs: result.durationMs, output: result.output, ...missingEvidence ? { missingEvidence: true } : {} })
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

    let gatePhase = await runGates()
    // A publish failure is not a dead end: the failed gate evidence goes back to the worker, which repairs the
    // worktree, and the gates are re-run — the same closed loop the run phase has, but owned by publish because a
    // person already asked for this delivery. Tooling failures are repairable here as well (the repair brief allows
    // scripts/local/ except the credential module).
    run.repair = { attempts: 0, max: repairMax, status: 'none' }
    let repairError
    while (gatePhase.failure) {
      run.gates = gatePhase.gates
      const failures = failedGatesOf({ repo, gatePhase })
      if (isErroredGate(gatePhase.failure) || repairMax <= 0 || run.repair.attempts >= repairMax) break
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
      throw new StageError('gate_failed', `${failure.name} gate failed (${failure.missingEvidence === true
        ? 'missing evidence' : `exit ${failure.exitCode}`})`)
    }
    try {
      await (deps.assertSafeWorktree ?? assertSafeWorktree)({ cwd, branch, featurePrefix: repo.featurePrefix, baseSha,
        extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
    } catch (error) { throw new StageError('guard_failed', messageOf(error)) }
    if (ticket.workflow && (!ticket.workflowDigest || ticket.workflowDigest !== await (deps.candidateDigest ?? candidateDigest)(cwd))) throw new StageError('review_stale', 'Workflow evidence is missing or stale; rerun the workflow')
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
    let mr
    if (mrMode === 'push') {
      let pushed
      try {
        pushed = await (deps.pushBranch ?? pushBranch)({ cwd, branch, featurePrefix: repo.featurePrefix,
          pushOptions: usesPushOptionMr(repo) ? pushOptionsFor(ticket, repo) : [] })
      } catch (error) { throw new StageError('push_failed', messageOf(error)) }
      run.push = pushed
      mr = pushed.mergeRequest
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
      step('merge-request', { state: mr?.webUrl ? 'ok' : 'pending', webUrl: mr?.webUrl, mode: 'push' })
      ticket.links = { ...ticket.links, branch, worktree: cwd }
      linkMergeRequest(ticket, mr, { mode: 'push', pending: !mr?.webUrl, headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
      ticket.status = 'mr-open'
      run.status = 'mr-open'
    } else {
      let pushed
      try {
        pushed = await (deps.pushBranch ?? pushBranch)({ cwd, branch, featurePrefix: repo.featurePrefix })
      } catch (error) { throw new StageError('push_failed', messageOf(error)) }
      run.push = pushed
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
      const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
      try {
        mr = await gitlab.createMergeRequest({ sourceBranch: branch, targetBranch: repo.gitlab.targetBranch,
          title: `Superagent: ${ticket.title}`, description: mergeRequestDescription(ticket, run, repo) })
      } catch (error) {
        // An already-open MR for the same branch is not a failure of this publish.
        const message = messageOf(error)
        if (/already exists|open merge request/i.test(message)) {
          const existing = await gitlab.listMergeRequests({ sourceBranch: branch, state: 'opened' }).catch(() => [])
          mr = existing?.[0]
        }
        if (!mr) throw new StageError('mr_failed', message)
      }
      ticket.links = { ...ticket.links, branch, worktree: cwd }
      linkMergeRequest(ticket, mr, { mode: 'api', headSha: pushed.sha ?? mr?.sha ?? ticket.links?.commit })
      ticket.status = repo.gitlab.ci === false ? 'mr-open' : 'ci-pending'
      run.status = ticket.status
      run.mergeRequest = mr
      step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl })
    }
    run.stopReason = 'done'
    const mrUrl = ticket.links?.mergeRequest?.webUrl
    markRunComplete({ run, ticket, to: ticket.status,
      summary: mrUrl ? `MR: ${mrUrl}` : `branch ${branch} pushed`,
      detail: `published: ${ticket.status}` })
    if (config.executor.allowReply) await replyToSource(engine, config, loaded, ticket, run, repo)
    return run
  } catch (error) {
    failRun({ run, ticket, error, step })
    return run
  } finally {
    await persist().catch(() => {})
  }
}


/** Has this branch commit reached the deploy branch? Uses git only, so it works without a GitLab token. */
export async function checkMerged({ repo, baseBranch, sha, deps = {} }) {
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
export async function verifyTicket({ engine, ticketId, deps = {} }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
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
    if (ticket.links?.mergeRequest?.iid && token) {
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
    ticket.links = { ...ticket.links, verification, ...patch }
    ticket.status = status
    ticket.updatedAt = verification.at
    await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
    return { status, verification }
  }

  const uat = await uatFingerprint({ url: repo.gitlab.uatUrl, fetchImpl: deps.fetchImpl })
  const health = await uatFingerprint({ url: repo.gitlab.healthUrl, fetchImpl: deps.fetchImpl })
  const before = ticket.links?.verification
  const capture = !before || !before.baselineLastModified
  const baselineHash = before?.baselineHash ?? (merged.merged ? undefined : uat.hash)
  const baselineLastModified = before?.baselineLastModified ?? (capture && !merged.merged ? uat.lastModified : undefined)
  const baselineEtag = before?.baselineEtag ?? (capture && !merged.merged ? uat.etag : undefined)
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
    else if (changed) status = 'deployed'
    else status = 'deploy-pending'
  }
  ticket.links = { ...ticket.links, verification }
  ticket.status = status
  ticket.updatedAt = verification.at
  await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
  return { status, verification }
}


/**
 * Heal a Ticket whose local run was interrupted after the GitLab side had already happened: look the MR up by source
 * branch (including deleted source branches), reattach its link and move the Ticket to the truthful status.
 */
export async function reconcileTicketFromGitlab({ engine, ticketId, deps = {} }) {
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
  const token = repoToken(loaded, repo)
  if (!token) return { skipped: 'no-token' }
  const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
  const mergeRequests = await gitlab.listMergeRequests({ sourceBranch: branch, state: 'all' })
  if (!Array.isArray(mergeRequests) || !mergeRequests.length) return { skipped: 'no-mr' }
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
  await engine.state.atomic((doc) => {
    const current = doc.tickets[ticketId]
    doc.tickets[ticketId] = { ...current, status, updatedAt: at, links }
  })
  return { ticket: { ...ticket, status, links }, mergeRequest, status }
}
