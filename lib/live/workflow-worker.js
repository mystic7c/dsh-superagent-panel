import { createHash } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from './repo.js'
import { RESUMABLE_ROLES, newWorkflow, resumeWorkflow, runWorkflow } from './workflow.js'

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
function assertResumable(workflow, { mode, requirementRevision }) {
  if (!workflow || workflow.status !== 'blocked') throw new Error('workflow has no blocked stage to resume')
  if (workflow.mode !== mode) throw new Error(`workflow mode changed (${workflow.mode} -> ${mode}); run the workflow again`)
  if (workflow.requirementRevision !== requirementRevision) throw new Error('requirements changed since this workflow started; run the workflow again')
  const last = workflow.stages?.at(-1)
  if (!last || last.status !== 'failed') throw new Error('workflow has no failed stage to resume')
  if (!RESUMABLE_ROLES.includes(last.role)) throw new Error(`workflow cannot resume a failed ${last.role} stage`)
}

export async function executeWorkflow({ run, ticket, config, cwd, brief, task, cli, dsh, gates, persist, digest = () => candidateDigest(cwd), resume = false }) {
  const mode = config.executor.workflowMode
  const backend = config.executor.implementer ?? 'dsh'
  for (const name of [backend, ...(mode === 'simple' ? [] : ['codex'])]) {
    if (config.executor.workers?.[name]?.enabled === false) throw new Error(`workflow backend disabled: ${name}`)
  }
  const requirementRevision = (ticket.revisions?.length ?? 0) + 1
  const existing = resume ? ticket.workflow : undefined
  if (resume) assertResumable(existing, { mode, requirementRevision })
  if (existing) run.workflow = existing
  else {
    run.workflow = newWorkflow({ mode, requirementRevision })
    ticket.workflow = run.workflow
  }
  const invoke = async (role, input) => {
    if (role === 'gates') return gates()
    const selected = role === 'implement' ? backend : 'codex'
    const options = config.executor.workers?.[selected] ?? {}
    const instructions = {
      assess: 'Read relevant source and tests. Assess complexity. Choose simple only for clear, bounded, low-risk changes; uncertainty, cross-module behavior, permissions or migrations require planned.',
      plan: 'Inspect source. Produce an actionable implementation plan with numbered acceptance criteria. Check original requirements. List only blocking questions in openQuestions. Do not modify files.',
      implement: 'Implement the original request according to the supplied plan and review feedback. Do not commit, push, merge or alter acceptance criteria. Return an implementation summary.',
      review: 'Independently inspect actual source and diff against ORIGINAL requirements and plan. Verify each acceptance criterion using code and gate evidence. Do not trust implementer claims. Do not modify files. Missing evidence is blocked, never passed.',
    }
    const before = role === 'implement' ? null : await digest()
    const request = { cwd, systemPrompt: brief, task: `${instructions[role]}\n\n${task}\n\nStage inputs:\n${JSON.stringify(input)}`, timeoutMs: config.executor.timeoutMs,
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
  if (existing) await resumeWorkflow({ state: existing, invoke, persist, candidateDigest: digest })
  else await runWorkflow({ state: run.workflow, invoke, persist, candidateDigest: digest })
  if (run.workflow.status !== 'ready') throw new Error(`workflow blocked: ${run.workflow.reason ?? run.workflow.status}`)
  ticket.workflowDigest = await digest()
  await persist()
}
