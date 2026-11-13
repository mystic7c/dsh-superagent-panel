/** Durable fixed workflow. The host owns side effects; agents only return stage artifacts. */
export const STAGES = ['assess', 'plan', 'implement', 'gates', 'review']

/**
 * Stages whose failure can be continued where it stopped. assess/plan are cheap to redo and gates have their own
 * park/retry path, so only a worker stage is worth replaying from its recorded inputs.
 */
export const RESUMABLE_ROLES = ['implement', 'review']

export function newWorkflow({ mode = 'auto', requirementRevision = 1 } = {}) {
  if (!['auto', 'simple', 'planned'].includes(mode)) throw new Error('invalid workflow mode')
  return { version: 1, mode, requirementRevision, status: 'pending', stages: [], repairs: 0 }
}
function validate(role, result) {
  if (!result || typeof result !== 'object') throw new Error(`${role}: missing structured result`)
  if (role === 'assess' && !['simple', 'planned'].includes(result.workflow)) throw new Error('invalid assessment')
  if (role === 'plan' && (!Array.isArray(result.acceptanceCriteria) || !result.acceptanceCriteria.length)) throw new Error('plan requires acceptance criteria')
  if (role === 'review' && !['passed', 'changes_requested', 'plan_invalid', 'blocked'].includes(result.verdict)) throw new Error('invalid review verdict')
  if (role === 'plan') {
    const ids = result.acceptanceCriteria.map(item => item?.id)
    if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) throw new Error('invalid acceptance IDs')
  }
  return result
}

/** The last failed stage, with the input its key recorded — everything a resume needs to replay it. */
export function failedStageOf(state) {
  const item = [...(state?.stages ?? [])].reverse().find(entry => entry?.status === 'failed')
  if (!item) return null
  let key
  try { key = JSON.parse(item.key) } catch { key = undefined }
  return { item, role: item.role, input: key?.input ?? {} }
}

/**
 * One stage item. Completed items with the same key are reused (a repair round may ask for the same artifact again);
 * a failed one is retried in place so a resumed stage never leaves two entries for the same key in the record.
 */
function makeStage({ state, invoke, persist }) {
  return async (role, input) => {
    const key = JSON.stringify({ role, revision: state.requirementRevision, round: state.repairs, input })
    const previous = state.stages.find(item => item.key === key && item.status === 'completed')
    if (previous) return previous.result
    const failed = state.stages.find(item => item.key === key && item.status === 'failed')
    const item = failed ?? { key, role, status: 'running', startedAt: new Date().toISOString() }
    if (failed) {
      item.status = 'running'
      item.startedAt = new Date().toISOString()
      delete item.endedAt
      delete item.error
      delete item.result
    } else {
      state.stages.push(item)
    }
    state.status = role
    await persist(state)
    try {
      item.result = validate(role, await invoke(role, input))
      item.status = 'completed'
      item.endedAt = new Date().toISOString()
      await persist(state)
      return item.result
    } catch (error) {
      item.status = 'failed'
      item.error = String(error.message ?? error)
      state.status = 'blocked'
      await persist(state)
      throw error
    }
  }
}

/**
 * Delivery loop: implement → gates → independent review, repairing while the reviewer rejects and the budget allows.
 * `pendingReview` continues after a failed review (its gates evidence and digest) instead of implementing again.
 */
async function deliver({ state, stage, plan, feedback = null, pendingReview = null, candidateDigest, persist, maxRepairs }) {
  let pending = pendingReview
  // Every stop records why, so the host error and the panel can say what actually happened instead of "blocked: blocked".
  const blocked = (reason, detail) => { state.status = 'blocked'; state.reason = reason; state.detail = detail }
  for (;;) {
    let digest
    let gates
    if (pending) {
      digest = pending.digest
      gates = pending.gates
      pending = null
    } else {
      if (plan?.openQuestions?.length) {
        blocked('plan_open_questions', `plan needs answers before work can start (${plan.openQuestions.length} open question(s))`)
        break
      }
      await stage('implement', { plan, feedback })
      digest = await candidateDigest()
      gates = await stage('gates', { digest })
      if (gates.passed !== true) {
        const failed = (gates?.results ?? []).filter(item => item && (item.exitCode !== 0 || item.timedOut)).map(item => item.name)
        blocked('gates_failed', failed.length ? `gates failed: ${failed.join(', ')}` : 'gates did not pass')
        break
      }
      if (!plan) { state.status = 'ready'; break }
    }
    const review = await stage('review', { plan, gates, digest })
    if (await candidateDigest() !== digest) {
      blocked('candidate_changed', 'candidate changed after the review; run the workflow again')
      break
    }
    if (review.verdict === 'passed') { state.status = 'ready'; state.reviewedDigest = digest; break }
    if (review.verdict === 'blocked') { blocked('review_blocked', 'review reported blocked'); break }
    if (state.repairs >= maxRepairs) {
      const count = Array.isArray(review.findings) ? review.findings.length : 0
      blocked('review_changes_requested', `review still requested changes after ${state.repairs} repair round(s)${count ? ` (${count} findings)` : ''}; raise executor.maxRepairRounds to keep repairing`)
      break
    }
    state.repairs += 1
    feedback = review
    if (review.verdict === 'plan_invalid') plan = await stage('plan', { previousPlan: plan, feedback })
    await persist(state)
  }
}

/** One line the host and the panel can show for a blocked workflow (reason codes stay machine-readable on `state.reason`). */
export function blockedMessage(workflow) {
  if (!workflow) return 'blocked'
  return workflow.detail || workflow.reason || workflow.status || 'blocked'
}

/** Persist before and after every await. An interrupted stage is retried, completed stages reused. */
export async function runWorkflow({ state, invoke, persist, candidateDigest, maxRepairs = 2 }) {
  const stage = makeStage({ state, invoke, persist })
  const assessment = state.mode === 'auto' ? await stage('assess', {}) : { workflow: state.mode }
  const plan = assessment.workflow === 'planned' ? await stage('plan', { assessment }) : null
  await deliver({ state, stage, plan, feedback: null, candidateDigest, persist, maxRepairs })
  await persist(state)
  return state
}

/**
 * Continue a blocked workflow from its failed stage instead of running it again. A failed review is replayed with the
 * gates evidence and digest its key recorded; a failed implement is replayed with the plan and feedback it was given.
 * The candidate must still hash to the gated digest, otherwise the gates evidence is stale and nothing is resumed.
 */
export async function resumeWorkflow({ state, invoke, persist, candidateDigest, maxRepairs = 2 }) {
  if (state.status !== 'blocked') throw new Error('workflow is not blocked')
  const failed = failedStageOf(state)
  const stage = makeStage({ state, invoke, persist })
  if (!failed) {
    // The reviewer used the last repair round. Continuing means one more implement→gates→review round on the same
    // tree; it needs budget left, so the host refuses until executor.maxRepairRounds was raised.
    const last = state.stages.at(-1)
    if (last?.role !== 'review' || last.status !== 'completed' || last.result?.verdict !== 'changes_requested') {
      throw new Error('workflow has no replayable stage to resume')
    }
    if ((state.repairs ?? 0) >= maxRepairs) {
      throw new Error(`workflow repair budget exhausted (${state.repairs}/${maxRepairs}); raise executor.maxRepairRounds to continue`)
    }
    const { plan, gates, digest } = JSON.parse(last.key).input ?? {}
    if (!plan || !gates || !digest) throw new Error('completed review stage is missing its evidence; run the workflow again')
    if (await candidateDigest() !== digest) throw new Error('candidate changed since the reviewed gates; run the workflow again')
    state.repairs += 1
    delete state.reason
    delete state.detail
    await deliver({ state, stage, plan, feedback: last.result, candidateDigest, persist, maxRepairs })
    await persist(state)
    return state
  }
  if (state.stages.at(-1) !== failed.item) throw new Error('workflow has stages after the failed one; run the workflow again')
  if (!RESUMABLE_ROLES.includes(failed.role)) throw new Error(`workflow cannot resume a failed ${failed.role} stage`)
  delete state.reason
  delete state.detail
  if (failed.role === 'review') {
    const { plan, gates, digest } = failed.input
    if (!plan || !gates || !digest) throw new Error('failed review stage is missing its evidence; run the workflow again')
    if (await candidateDigest() !== digest) throw new Error('candidate changed since the gated review; run the workflow again')
    await deliver({ state, stage, plan, feedback: null, pendingReview: { gates, digest }, candidateDigest, persist, maxRepairs })
  } else {
    const { plan = null, feedback = null } = failed.input
    await deliver({ state, stage, plan, feedback, candidateDigest, persist, maxRepairs })
  }
  await persist(state)
  return state
}
