import { createHash } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './repo.js'
import { RESUMABLE_ROLES, newWorkflow, resumeWorkflow, runWorkflow, blockedMessage } from './workflow.js'
import { REVIEW_JSON_MARKER } from './review-json.js'

// Hash tracked changes and untracked file bytes, not merely HEAD (workers do not commit).
export async function candidateDigest(cwd) {
  const hash = createHash('sha256')
  hash.update(await git(['rev-parse', 'HEAD'], cwd))
  hash.update(await git(['diff', 'HEAD', '--binary'], cwd))
  const files = (await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd, { trim: false })).split('\0').filter(Boolean).sort()
  for (const file of files) {
    hash.update(file)
    const path = join(cwd, file)
    if ((await lstat(path)).isSymbolicLink()) throw new Error('untracked symlink requires manual review')
    hash.update(await readFile(path))
  }
  return hash.digest('hex')
}
const objectSchema = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false })
const string = { type: 'string' }
const strings = { type: 'array', items: string }
export const SCHEMAS = {
  assess: objectSchema({ workflow: { type: 'string', enum: ['simple', 'planned'] }, reason: string }),
  plan: objectSchema({ summary: string, steps: strings, acceptanceCriteria: { type: 'array', items: objectSchema({ id: string, requirement: string, verification: string }) }, openQuestions: strings }),
  review: objectSchema({ verdict: { type: 'string', enum: ['passed', 'changes_requested', 'plan_invalid', 'blocked'] }, findings: strings, evidence: strings }),
}
/** A resume may only continue the staged workflow that is still in ticket.workflow, unchanged and stopped at its last stage. */
function assertResumable(workflow, { mode, requirementRevision, maxRepairs }) {
  if (!workflow || workflow.status !== 'blocked') throw new Error('workflow has no blocked stage to resume')
  if (workflow.mode !== mode) throw new Error(`workflow mode changed (${workflow.mode} -> ${mode}); run the workflow again`)
  if (workflow.requirementRevision !== requirementRevision) throw new Error('requirements changed since this workflow started; run the workflow again')
  const last = workflow.stages?.at(-1)
  const failed = last?.status === 'failed' && RESUMABLE_ROLES.includes(last.role)
  // A reviewer that used the last repair round is not a failure: continuing runs one more implement→gates→review round.
  const exhausted = last?.status === 'completed' && last.role === 'review' && last.result?.verdict === 'changes_requested'
  if (!failed && !exhausted) throw new Error('workflow has no replayable stage to resume')
  if (exhausted && (workflow.repairs ?? 0) >= maxRepairs) {
    throw new Error(`workflow repair budget exhausted (${workflow.repairs}/${maxRepairs}); raise executor.maxRepairRounds to continue`)
  }
}

/**
 * Verdict stages answer with one JSON object; a CLI or a DSH reviewer may still wrap it in a ```json fence or add a
 * short preamble. Accept the object inside, and keep the parse error when nothing is JSON.
 */
export function parseStageResult(text, role = 'review') {
  const raw = String(text ?? '').trim()
  const attempts = [raw]
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) attempts.push(fenced[1].trim())
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start >= 0 && end > start) attempts.push(raw.slice(start, end + 1))
  let failure
  for (const attempt of attempts) {
    try { return JSON.parse(attempt) } catch (error) { failure = error }
  }
  throw failure ?? new Error(`${role} returned no JSON`)
}

export async function executeWorkflow({ run, ticket, config, cwd, brief, task, cli, dsh, gates, persist, backend: routeBackend,
  profile: routeProfile, signal, digest = () => candidateDigest(cwd), resume = false, reviewer: reviewerOverride }) {
  const stopError = () => {
    const error = /** @type {any} */ (new Error('stop requested by an operator'))
    error.code = 'stopped'
    return error
  }
  if (signal?.aborted) throw stopError()
  const mode = config.executor.workflowMode
  // The repair budget is one executor setting shared by gate auto-repair and the staged review loop.
  const maxRepairs = Number.isFinite(config.executor?.maxRepairRounds) ? config.executor.maxRepairRounds : 2
  // AC-01: the executor's resolved route owns the implementation backend, not `executor.implementer`. A manual
  // backend/profile choice must not be overridden by the workflow's own configuration.
  const backend = routeBackend ?? config.executor.implementer ?? 'dsh'
  const implementProfile = routeProfile === 'read-only' ? 'read-only' : 'write'
  // The independent acceptance backend: review (and the analysis stages that feed it) run through this CLI worker.
  const reviewer = reviewerOverride ?? config.executor.reviewer ?? 'codex'
  for (const name of [backend, ...(mode === 'simple' ? [] : [reviewer])]) {
    if (config.executor.workers?.[name]?.enabled === false) throw new Error(`workflow backend disabled: ${name}`)
  }
  const requirementRevision = (ticket.revisions?.length ?? 0) + 1
  const existing = resume ? ticket.workflow : undefined
  if (resume) assertResumable(existing, { mode, requirementRevision, maxRepairs })
  if (existing) {
    run.workflow = existing
    // The new run inherits the evidence the resumed stages already produced: gates results and the implementation
    // summary would otherwise vanish from the run record (and the handoff) although the review re-uses them.
    const gatesStage = [...existing.stages].reverse().find(item => item.role === 'gates' && item.status === 'completed')
    if (Array.isArray(gatesStage?.result?.results)) run.gates = gatesStage.result.results
    const implemented = [...existing.stages].reverse().find(item => item.role === 'implement' && item.status === 'completed')
    if (implemented?.result?.summary && !run.worker) {
      run.worker = { text: implemented.result.summary, backend: implemented.backend, sessionId: implemented.sessionId }
    }
  } else {
    run.workflow = newWorkflow({ mode, requirementRevision })
    ticket.workflow = run.workflow
  }
  const invoke = async (role, input) => {
    // Staged execution is not one long worker call: the durable stop must reach each stage's worker/gate process and
    // must not start the next stage after a stop lands (review P1 AC-03).
    if (signal?.aborted) throw stopError()
    if (role === 'gates') {
      const result = await gates()
      if (signal?.aborted) throw stopError()
      return result
    }
    const selected = role === 'implement' ? backend : reviewer
    const options = config.executor.workers?.[selected] ?? {}
    const instructions = {
      assess: 'Read relevant source and tests. Assess complexity. Choose simple only for clear, bounded, low-risk changes; uncertainty, cross-module behavior, permissions or migrations require planned.',
      plan: 'Inspect source. Produce an actionable implementation plan with numbered acceptance criteria. Check original requirements. List only blocking questions in openQuestions. Do not modify files.',
      implement: 'Implement the original request according to the supplied plan and review feedback. Do not commit, push, merge or alter acceptance criteria. Return an implementation summary.',
      review: `Independently inspect actual source and diff against ORIGINAL requirements and plan. Verify each acceptance criterion using code and gate evidence. Do not trust implementer claims. Do not modify files. Missing evidence is blocked, never passed. ${REVIEW_JSON_MARKER}`,
    }
    const before = role === 'implement' ? null : await digest()
    const request = { cwd, systemPrompt: brief, task: `${instructions[role]}\n\n${task}\n\nStage inputs:\n${JSON.stringify(input)}`, timeoutMs: config.executor.timeoutMs,
      sessionId: `workflow-${run.id}-${role}-${run.workflow.stages.length}`, signal }
    const result = selected === 'dsh'
      // A DSH reviewer is the same in-process agent as an implementer, so the review role must also restrict its
      // tooling: readOnly denies the file-mutating tools and keeps Bash for inspection.
      ? await dsh({ ...request, model: config.executor.model,
        readOnly: role === 'implement' ? implementProfile === 'read-only' : true })
      : await cli({ ...request, backend: selected, model: options.model, command: options.command,
        profile: role === 'implement' ? implementProfile : 'read-only', outputSchema: SCHEMAS[role] })
    if (signal?.aborted) throw stopError()
    if (result.timedOut || result.error) throw new Error(result.error || `${role} timed out`)
    const stage = run.workflow.stages.at(-1)
    stage.backend = selected
    stage.sessionId = result.sessionId
    if (before && await digest() !== before) throw new Error(`${role} changed candidate`)
    if (role === 'implement') {
      run.worker = { ...result, backend: selected }
      return { summary: result.text }
    }
    return parseStageResult(result.text, role)
  }
  if (signal?.aborted) throw stopError()
  if (existing) await resumeWorkflow({ state: existing, invoke, persist, candidateDigest: digest, maxRepairs, signal })
  else await runWorkflow({ state: run.workflow, invoke, persist, candidateDigest: digest, maxRepairs, signal })
  if (signal?.aborted) throw stopError()
  if (run.workflow.status !== 'ready') throw new Error(`workflow blocked: ${blockedMessage(run.workflow)}`)
  ticket.workflowDigest = await digest()
  await persist()
}
