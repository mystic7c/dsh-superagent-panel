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
 * Pilot finding (2026-11-08): wrapping the message in `{ text, channel, threadTitle }` collapsed a clear request
 * ("依据这个SQL，写一个视图…") from p=0.97 to p=0.09, while the same text alone scored 0.97. The model reads the state
 * literally, so the state stays one plain string; metadata must never ride along.
 */
export const JUDGE_QUESTIONS_VERSION = 'request-v2'

/**
 * The typed questions asked for every candidate. Keep it small: providers cap questions per request (Aliyun: 16)
 * and every extra question costs latency. `isRequest` is the one the rules are weak at (R1 accepts any text);
 * `isHighRisk` is a second opinion on R3 and is stored only for comparison.
 */
export const JUDGE_QUESTIONS = [
  {
    id: 'isRequest',
    type: 'noul',
    instructions: '这条群消息是不是一条需要在本项目里执行的工作请求？明确要求修改、开发、修复、创建、删除或调整内容的算工作请求；闲聊、致谢、确认收到、通知、纯代码或 SQL 片段本身不算。',
    criteria: { true: '要求在本项目里做具体工作', false: '闲聊、通知、确认收到或纯代码片段' },
  },
  {
    id: 'isHighRisk',
    type: 'noul',
    instructions: '这条消息是否要求生产环境操作、EBS 基表 DML、合并/发版/打 tag，或索取密码、密钥、token？',
    criteria: { true: '命中生产、DDL/DML、合并发版或密钥', false: '普通功能修改或非高风险请求' },
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
function probabilityOf(answers, id) {
  const answer = answers && typeof answers === 'object' ? answers[id] : undefined
  if (!answer || typeof answer !== 'object') return undefined
  // `noul` is the documented field; `p` / `probability` are tolerated so a drop-in that renames the scalar still works.
  const value = answer.noul ?? answer.p ?? answer.probability
  return typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : undefined
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
export function createSystemOneJudge({ endpoint, model, token, timeoutMs = 6000, fetchImpl } = {}) {
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
    async judge({ text, context } = {}) {
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
        const isRequest = probabilityOf(answers, 'isRequest')
        if (isRequest === undefined) throw new Error('judge 响应里没有可用的 isRequest 概率')
        const isHighRisk = probabilityOf(answers, 'isHighRisk')
        return {
          model: typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : model.trim(),
          answers: { isRequest, ...(isHighRisk === undefined ? {} : { isHighRisk }) },
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
export function verdictOf(probability, { acceptAt = 0.8, rejectAt = 0.2 } = {}) {
  if (typeof probability !== 'number' || !Number.isFinite(probability)) return 'unknown'
  if (probability >= acceptAt) return 'accept'
  if (probability <= rejectAt) return 'reject'
  return 'uncertain'
}

/**
 * The record stored on a Decision in shadow mode. It keeps the rules' own outcome (`ruleKind`) next to the model
 * answer so the pilot can measure agreement without joining other files.
 */
export function shadowOf(result, { ruleKind, acceptAt = 0.8, rejectAt = 0.2, at } = {}) {
  const probability = result?.answers?.isRequest
  return {
    status: 'ok',
    at: at ?? new Date().toISOString(),
    model: result?.model ?? '',
    questions: JUDGE_QUESTIONS_VERSION,
    ...(ruleKind ? { ruleKind } : {}),
    ...(typeof probability === 'number' ? { p: probability } : {}),
    ...(typeof result?.answers?.isHighRisk === 'number' ? { riskP: result.answers.isHighRisk } : {}),
    verdict: verdictOf(probability, { acceptAt, rejectAt }),
    ...(Number.isFinite(result?.latencyMs) ? { latencyMs: result.latencyMs } : {}),
    ...(result?.usage?.input_tokens ? { inputTokens: result.usage.input_tokens } : {}),
  }
}

/** The record stored when the judge could not answer: an auditable error row, never an intake failure. */
export function shadowErrorOf(error, { ruleKind, at } = {}) {
  return {
    status: 'error',
    at: at ?? new Date().toISOString(),
    ...(ruleKind ? { ruleKind } : {}),
    error: String(error instanceof Error ? error.message : error ?? 'unknown error').slice(0, 300),
  }
}
