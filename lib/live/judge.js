/**
 * The decision-model seam (shadow mode, first landing step).
 *
 * A "System One" judge answers one typed question set about one message and returns calibrated probabilities.
 * The transport is deliberately the TypeSafe System One request shape, because the providers we evaluated all
 * accept it: Aliyun Model Studio `decision-model-preview` (Beijing / Singapore, System One compatible), TypeSafe
 * Jev (US hosted) and the open drop-ins (Kev, Von, OpenJev …). Switching providers is a configuration change
 * (`eval.decision.endpoint` / `model` / token), not a new code path.
 *
 * Rules still own intake. In `eval.mode='shadow'` the engine asks the judge the same question the rules just
 * answered and stores the answer on the Decision (`decision.shadow`) — it never changes kind, reason or Tickets.
 * Only after the thresholds are fitted on labelled messages may a later mode act on the model answer.
 */

/**
 * Version of the prompt contract (question wording *and* the state shape). Bump it when either changes: a stored
 * shadow row is only comparable to rows judged by the same contract.
 *
 * Two pilot findings shaped this contract (2026-11-08):
 * 1. State must stay one plain string: wrapping the message in `{ text, channel, threadTitle }` collapsed a clear
 *    request ("依据这个SQL，写一个视图…") from p=0.97 to p=0.09.
 * 2. "是不是工作请求" is the wrong question: it counted Octo-platform chores (查评论/改 Thread.md/改 system prompt/
 *    建 thread/排查 webhook) as work, so the model opened 12 false tickets on the 25-message golden set. A five-way
 *    choice that separates `repo_task` from `octo_platform` scored 24/25 on that set and 21/23 on the labelled real
 *    messages (open precision 100%). Hence the `ticket-v*` contract asks one `choice` question instead of the old noul.
 * 3. A real requirement ("需求：库存出入库流水表…新增 procedure Main_Bi…") was classified `context` (p=0.30) and
 *    dropped in production: the message is dense with table/procedure/parameter names, which the old `context`
 *    description invited. `ticket-v2` extends the `repo_task` description with "具体开发/数据交付需求（含需求说明、
 *    procedure/报表/接口、参数与定时规则）"; the same message now scores repo_task 0.97 with the golden/real sets
 *    unchanged (24/25 and 22/24).
 */
export const JUDGE_QUESTIONS_VERSION = 'ticket-v2'

/**
 * One typed question for every candidate. Keep it small: providers cap questions per request (Aliyun: 16) and every
 * extra question costs latency. The category carries both signals we need — `repo_task` is the ticket-worthy class
 * (p), `risky` is the high-risk probability (riskP) — so a second noul question is unnecessary.
 */
export const JUDGE_QUESTIONS = [
  {
    id: 'category',
    type: 'choice',
    instructions: '这条群消息应归为哪一类？',
    criteria: {
      repo_task: '需要改代码仓库/工作区/数据库，或提出具体的开发/数据交付需求（含需求说明、procedure/报表/接口、参数与定时规则）：代码、SQL、文档、配置、建视图、授权、导出数据、清理分支、重跑任务',
      octo_platform: 'Octo 平台内的操作：查信息/评论、改 Thread.md、改 system prompt、建 thread、排查 webhook',
      chat: '闲聊、致谢、确认、否定',
      context: '纯代码、SQL 或日志片段',
      risky: '生产 DDL/删除、合并发版、索取密钥等高风险操作',
    },
  },
]

/** The `questions` object of one request: id → {type, instructions, criteria}. */
export function judgeQuestionPayload() {
  return Object.fromEntries(JUDGE_QUESTIONS.map(question => [question.id, {
    type: question.type,
    instructions: question.instructions,
    ...(question.criteria ? { criteria: question.criteria } : {}),
  }]))
}

const clamp01 = value => Math.min(1, Math.max(0, value))

/** Coerce one answer to a 0..1 probability; undefined when the provider returned no usable number. */
function probabilityOf(answer) {
  if (!answer || typeof answer !== 'object') return undefined
  // `noul` is the documented field; `p` / `probability` are tolerated so a drop-in that renames the scalar still works.
  const value = answer.noul ?? answer.p ?? answer.probability
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : undefined
}

/** Probability of one `choice` option; falls back to the selected option when a provider omits probabilities. */
function choiceProbabilityOf(answer, option) {
  const probabilities = answer && typeof answer.probabilities === 'object' ? answer.probabilities : undefined
  const value = probabilities ? probabilities[option] : undefined
  if (typeof value === 'number' && Number.isFinite(value)) return clamp01(value)
  return answer?.choice === option ? 1 : undefined
}

function responseMessage(body) {
  if (!body || typeof body !== 'object') return ''
  const detail = body.error ?? body.message ?? body.msg
  if (typeof detail === 'string' && detail.trim()) return detail.trim().slice(0, 200)
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') return detail.message.trim().slice(0, 200)
  return ''
}

/**
 * Build one client for the configured endpoint. Throws on configuration errors (surfaced through the status view),
 * never on a missing API key here — the caller reads the token and passes it in, so the error can name the token.
 */
export function createSystemOneJudge({ endpoint, model, token, timeoutMs = 6000, fetchImpl } = /** @type {Record<string, any>} */ ({})) {
  if (typeof endpoint !== 'string' || !/^https?:\/\/\S+$/i.test(endpoint)) {
    throw new Error('eval.decision.endpoint 必须是 http(s) 地址')
  }
  if (typeof model !== 'string' || !model.trim()) throw new Error('eval.decision.model 未配置')
  if (typeof token !== 'string' || !token.trim()) throw new Error('decision token 未配置')
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前 Node 运行时不支持 fetch')
  const timeout = Math.max(100, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 6000)

  return {
    endpoint,
    model: model.trim(),
    /**
     * Ask the standard question set about one message. → { model, answers: {isRequest, isHighRisk?}, latencyMs, usage? }
     * Throws on transport failure, timeout or a response without the `isRequest` probability; the engine records that
     * as `decision.shadow.status='error'` and intake is unaffected.
     */
    async judge({ text, context } = /** @type {Record<string, any>} */ ({})) {
      const body = String(text ?? '').trim()
      if (!body) throw new Error('judge 需要非空文本')
      // Plain string only (see the state-shape note on JUDGE_QUESTIONS_VERSION). Prior messages are pasted in front,
      // separated by a rule, the same way a Ticket body receives its context; never serialise them as an object.
      const contextText = (Array.isArray(context) ? context : []).map(item => String(item ?? '').trim())
        .filter(Boolean).slice(-3)
      const state = contextText.length ? `${contextText.join('\n\n')}\n\n---\n\n${body}` : body
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeout)
      const startedAt = Date.now()
      try {
        const response = await doFetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token.trim()}` },
          body: JSON.stringify({
            model: model.trim(),
            state,
            questions: judgeQuestionPayload(),
          }),
          signal: controller.signal,
        })
        let body
        try { body = await response.json() } catch { body = undefined }
        if (!response.ok) {
          const detail = responseMessage(body)
          throw new Error(`judge HTTP ${response.status}${detail ? `：${detail}` : ''}`)
        }
        const answers = body?.answers
        const categoryAnswer = answers && typeof answers === 'object' ? answers.category : undefined
        const repoTask = choiceProbabilityOf(categoryAnswer, 'repo_task')
        if (repoTask === undefined) throw new Error('judge 响应里没有可用的 repo_task 概率')
        const risky = choiceProbabilityOf(categoryAnswer, 'risky')
        return {
          model: typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : model.trim(),
          answers: {
            category: typeof categoryAnswer?.choice === 'string' ? categoryAnswer.choice : undefined,
            repoTask,
            ...(risky === undefined ? {} : { risky }),
          },
          latencyMs: Date.now() - startedAt,
          ...(body?.usage ? { usage: body.usage } : {}),
          ...(body?.request_id ? { requestId: String(body.request_id) } : {}),
        }
      } catch (error) {
        if (error && (error.name === 'AbortError' || controller.signal.aborted)) {
          throw new Error(`judge 超时（${timeout}ms）`)
        }
        throw error
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Map one probability to the action the model would take under the configured thresholds. */
export function verdictOf(probability, { acceptAt = 0.8, rejectAt = 0.2 } = /** @type {Record<string, any>} */ ({})) {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return 'unknown'
  if (probability >= acceptAt) return 'accept'
  if (probability <= rejectAt) return 'reject'
  return 'uncertain'
}

/**
 * The record stored on a Decision in shadow mode. It keeps the rules' own outcome (`ruleKind`) next to the model
 * answer so the pilot can measure agreement without joining other files.
 */
export function shadowOf(result, { ruleKind, acceptAt = 0.8, rejectAt = 0.2, at } = /** @type {Record<string, any>} */ ({})) {
  // p is P(repo_task): the ticket-worthy class. riskP is P(risky): advisory only (R3 stays a rule gate).
  const probability = result?.answers?.repoTask
  const risky = result?.answers?.risky
  return {
    status: 'ok',
    at: at ?? new Date().toISOString(),
    model: result?.model ?? '',
    questions: JUDGE_QUESTIONS_VERSION,
    ...(ruleKind ? { ruleKind } : {}),
    ...(typeof result?.answers?.category === 'string' ? { category: result.answers.category } : {}),
    ...(typeof probability === 'number' ? { p: probability } : {}),
    ...(typeof risky === 'number' ? { riskP: risky } : {}),
    verdict: verdictOf(probability, { acceptAt, rejectAt }),
    ...(Number.isFinite(result?.latencyMs) ? { latencyMs: result.latencyMs } : {}),
    ...(result?.usage?.input_tokens ? { inputTokens: result.usage.input_tokens } : {}),
  }
}

/** The record stored when the judge could not answer: an auditable error row, never an intake failure. */
export function shadowErrorOf(error, { ruleKind, at } = /** @type {Record<string, any>} */ ({})) {
  return {
    status: 'error',
    at: at ?? new Date().toISOString(),
    ...(ruleKind ? { ruleKind } : {}),
    error: String(error instanceof Error ? error.message : error ?? 'unknown error').slice(0, 300),
  }
}
