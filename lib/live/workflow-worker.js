import { createHash } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './repo.js'
import { RESUMABLE_ROLES, newWorkflow, resumeWorkflow, runWorkflow, blockedMessage } from './workflow.js'

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

/** The candidate changes a reviewer must see. Claude's read-only profile grants file tools only, so the diff travels in
    the prompt; the reviewer still reads the files themselves, it just does not have to guess what changed. */
async function candidateDiff(cwd, limit = 40_000) {
  try {
  const stat = await git(['diff', 'HEAD', '--stat'], cwd)
  const diff = await git(['diff', 'HEAD'], cwd)
  const untracked = (await git(['ls-files', '--others', '--exclude-standard'], cwd)).trim()
  return [`Changed files:\n${stat.trim() || '(HEAD only)'}`, untracked ? `Untracked files:\n${untracked}` : '',
    `Diff (${diff.length > limit ? `first ${limit} of ${diff.length} chars` : `${diff.length} chars`}):\n${diff.slice(0, limit)}`
  ].filter(Boolean).join('\n\n')
  } catch (error) {
    // A cwd without git history (unit-test fixtures) still reviews; the digest gate remains authoritative.
    return `(diff unavailable: ${error?.message ?? error})`
  }
}

export async function executeWorkflow({ run, ticket, config, cwd, brief, task, cli, dsh, gates, persist, digest = () => candidateDigest(cwd), resume = false, reviewer: reviewerOverride }) {
  const mode = config.executor.workflowMode
  // The repair budget is one executor setting shared by gate auto-repair and the staged review loop.
  const maxRepairs = Number.isFinite(config.executor?.maxRepairRounds) ? config.executor.maxRepairRounds : 2
  const backend = config.executor.implementer ?? 'dsh'
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
    if (role === 'gates') return gates()
    const selected = role === 'implement' ? backend : reviewer
    const options = config.executor.workers?.[selected] ?? {}
    const instructions = {
      assess: 'Read relevant source and tests. Assess complexity. Choose simple only for clear, bounded, low-risk changes; uncertainty, cross-module behavior, permissions or migrations require planned.',
      plan: 'Inspect source. Produce an actionable implementation plan with numbered acceptance criteria. Check original requirements. List only blocking questions in openQuestions. Do not modify files.',
      implement: 'Implement the original request according to the supplied plan and review feedback. Do not commit, push, merge or alter acceptance criteria. Return an implementation summary.',
      review: 'Independently inspect actual source and diff against ORIGINAL requirements and plan. Verify each acceptance criterion using code and gate evidence. Do not trust implementer claims. Do not modify files. Missing evidence is blocked, never passed.',
    }
    const before = role === 'implement' ? null : await digest()
    // The review gets the candidate diff explicitly so a file-tools-only reviewer can still see what changed.
    const diff = role === 'review' ? `\n\nCandidate diff:\n${await candidateDiff(cwd)}` : ''
    const request = { cwd, systemPrompt: brief, task: `${instructions[role]}\n\n${task}${diff}\n\nStage inputs:\n${JSON.stringify(input)}`, timeoutMs: config.executor.timeoutMs,
      sessionId: `workflow-${run.id}-${role}-${run.workflow.stages.length}` }
    const result = selected === 'dsh'
      ? await dsh({ ...request, model: config.executor.model })
      : await cli({ ...request, backend: selected, model: options.model, command: options.command,
        profile: role === 'implement' ? 'write' : 'read-only', outputSchema: SCHEMAS[role] })
    if (result.timedOut || result.error) throw new Error(result.error || `${role} timed out`)
    const stage = run.workflow.stages.at(-1)
    stage.backend = selected
    stage.sessionId = result.sessionId
    if (before && await digest() !== before) throw new Error(`${role} changed candidate`)
    if (role === 'implement') {
      run.worker = { ...result, backend: selected }
      return { summary: result.text }
    }
    return JSON.parse(result.text)
  }
  if (existing) await resumeWorkflow({ state: existing, invoke, persist, candidateDigest: digest, maxRepairs })
  else await runWorkflow({ state: run.workflow, invoke, persist, candidateDigest: digest, maxRepairs })
  if (run.workflow.status !== 'ready') throw new Error(`workflow blocked: ${blockedMessage(run.workflow)}`)
  ticket.workflowDigest = await digest()
  await persist()
}
