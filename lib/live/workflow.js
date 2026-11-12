/** Durable fixed workflow. The host owns side effects; agents only return stage artifacts. */
export const STAGES = ['assess', 'plan', 'implement', 'gates', 'review']
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
/** Persist before and after every await. An interrupted stage is retried, completed stages reused. */
export async function runWorkflow({ state, invoke, persist, candidateDigest, maxRepairs = 2 }) {
  const stage = async (role, input) => {
    const key = JSON.stringify({ role, revision: state.requirementRevision, round: state.repairs, input })
    const previous = state.stages.find(item => item.key === key && item.status === 'completed')
    if (previous) return previous.result
    const item = { key, role, status: 'running', startedAt: new Date().toISOString() }
    state.stages.push(item)
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
  const assessment = state.mode === 'auto' ? await stage('assess', {}) : { workflow: state.mode }
  let plan = assessment.workflow === 'planned' ? await stage('plan', { assessment }) : null
  let feedback = null
  for (;;) {
    if (plan?.openQuestions?.length) { state.status = 'blocked'; break }
    await stage('implement', { plan, feedback })
    const digest = await candidateDigest()
    const gates = await stage('gates', { digest })
    if (gates.passed !== true) { state.status = 'blocked'; break }
    if (!plan) { state.status = 'ready'; break }
    const review = await stage('review', { plan, gates, digest })
    if (await candidateDigest() !== digest) { state.status = 'blocked'; state.reason = 'candidate_changed'; break }
    if (review.verdict === 'passed') { state.status = 'ready'; state.reviewedDigest = digest; break }
    if (review.verdict === 'blocked' || state.repairs >= maxRepairs) { state.status = 'blocked'; break }
    state.repairs += 1
    feedback = review
    if (review.verdict === 'plan_invalid') plan = await stage('plan', { previousPlan: plan, feedback })
    await persist(state)
  }
  await persist(state)
  return state
}
