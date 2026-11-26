/**
 * Bot dispatch (worker-bots 1.5.0 §2): three layers, at most one model call.
 *
 *   1. explicit — `repos[].bot` or `ticket.botOverride` names the bot: the operator knows better than the
 *      model and this layer never calls one. A declared bot that does not exist falls through; a declared
 *      bot whose backend is down still runs (the executor refuses with a clear reason, nothing is swapped
 *      behind the operator's back).
 *   2. pick — candidates are every bot whose backend is available *right now* (`backend-capability.js`);
 *      one model call reads each bot's own `whenToUse` plus the ticket and answers `{botId, because}`.
 *      Skipped without a call when the explicit layer hit, when exactly one bot is available, or on a cache hit.
 *   3. default — `executor.bot`, with the degradation recorded on the run when the pick could not happen.
 *
 * The capability model is gone: a bot never declares what it can do, and the picker never filters on it.
 * The dangerous behaviour is stopped by the gates / sandbox / deny rules, not by dispatch metadata.
 */
import { botAvailability } from './backend-capability.js'
import { DEFAULT_BOT_ID, botsDigest, digestOf } from './worker-bot.js'

/** Where the chosen bot came from — the execution page renders one label per source. */
export const DISPATCH_SOURCES = Object.freeze(['explicit-repo', 'explicit-ticket', 'pick', 'default'])
/** Why the pick could not happen. Every code degrades to `executor.bot` and stays visible on the run (§2.4). */
export const DISPATCH_DEGRADED = Object.freeze(['pick-unavailable', 'pick-failed', 'pick-invalid', 'pick-none', 'no-candidate'])

const DEGRADED_TEXT = {
  'pick-unavailable': '决策模型不可用',
  'pick-failed': '决策模型调用失败',
  'pick-invalid': '决策模型返回了候选之外的 Bot',
  'pick-none': '决策模型认为都不合适',
  'no-candidate': '没有后端可用的 Bot',
}

const MODEL_SYSTEM = `你是派单器。下面每个 Bot 都写了自己「什么时候派给它」，工作单的标题与正文也在下面。
只回答这一单该派给哪个 Bot。只返回一个 JSON 对象：
{"botId": "候选里的一个 id", "because": "一句话理由，不超过 100 字"}
如果都不合适，返回 {"botId": null, "because": "为什么都不合适"}。
只能从候选里选，不要编造 id，不要输出 JSON 以外的任何内容。`

const MODEL_CACHE_MAX = 500
const BUDGET_WINDOW_MS = 60_000

/** @type {Map<string, {at:number, botId:string|null, because:string}>} */
const pickCache = new Map()
/** @type {Map<string, Promise<any>>} */
const inFlight = new Map()
const budget = { windowStart: 0, used: 0 }

export function clearDispatchCache() {
  pickCache.clear()
  inFlight.clear()
  budget.windowStart = 0
  budget.used = 0
}

export function dispatchCacheSize() {
  return pickCache.size
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Cache key = digest(candidate ids, their whenToUse, ticket digest) — §2.3. */
export function dispatchCacheKey(ticket, candidates) {
  return digestOf({
    candidates: candidates.map(bot => bot.id),
    whenToUse: candidates.map(bot => bot.whenToUse ?? ''),
    ticket: digestOf({ title: ticket.title ?? '', body: ticket.body ?? '' }),
  })
}

/** What the model is told: every candidate's identity and self-description, plus the ticket (bounded). */
export function dispatchRequestOf(ticket, candidates) {
  const title = String(ticket?.title ?? '')
  const body = String(ticket?.body ?? '')
  return {
    ticket: {
      title: title.slice(0, 400),
      body: body.slice(0, 4000),
      ...(title.length > 400 || body.length > 4000 ? { truncated: true } : {}),
    },
    candidates: candidates.map(bot => ({
      id: bot.id,
      name: bot.name,
      description: bot.description ?? '',
      whenToUse: bot.whenToUse ?? '',
    })),
  }
}

function firstJsonObject(text) {
  const source = String(text ?? '')
  const start = source.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Turn the model's answer into a pick, or into the one degradation code that says why it isn't one.
 * An id outside the candidate set is `pick-invalid` — never "the closest bot".
 *
 * @returns {{ok:true, botId:string|null, because:string} | {ok:false, degraded:string, reason:string}}
 */
export function interpretPick(content, candidateIds) {
  const json = firstJsonObject(content)
  if (!json) return { ok: false, degraded: 'pick-failed', reason: '模型输出里没有 JSON' }
  let value
  try {
    value = JSON.parse(json)
  } catch {
    return { ok: false, degraded: 'pick-failed', reason: '模型输出不是合法 JSON' }
  }
  if (!isObject(value)) return { ok: false, degraded: 'pick-failed', reason: '模型输出的不是对象' }
  const keys = Object.keys(value).sort()
  if (keys.length !== 2 || keys[0] !== 'because' || keys[1] !== 'botId') {
    return { ok: false, degraded: 'pick-failed', reason: '模型输出必须恰好包含 botId 与 because' }
  }
  if (typeof value.because !== 'string' || !value.because.trim()) {
    return { ok: false, degraded: 'pick-failed', reason: '模型没有给 because' }
  }
  const because = value.because.trim().slice(0, 200)
  if (value.botId === null) return { ok: true, botId: null, because }
  if (typeof value.botId !== 'string' || !candidateIds.includes(value.botId)) {
    return { ok: false, degraded: 'pick-invalid', reason: `模型选择了候选之外的 Bot：${String(value.botId)}` }
  }
  return { ok: true, botId: value.botId, because }
}

/**
 * One chat-completions call; the only network hop dispatch ever makes.
 * @param {{endpoint?:string, model?:string, token?:string, payload?:any, timeoutMs?:number,
 *   fetchImpl?:Function, signal?:AbortSignal}} options
 * @returns {Promise<string>}
 */
export async function callPickModel({ endpoint, model, token, payload, timeoutMs = 6000, fetchImpl = fetch, signal } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) signal.addEventListener('abort', onAbort, { once: true })
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ model, temperature: 0, messages: [
        { role: 'system', content: MODEL_SYSTEM },
        { role: 'user', content: JSON.stringify(payload) },
      ] }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = typeof response.text === 'function' ? String(await response.text()).slice(0, 300) : ''
      const error = /** @type {any} */ (new Error(`决策模型返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`))
      error.code = 'MODEL_HTTP'
      throw error
    }
    const body = await response.json()
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) {
      const error = /** @type {any} */ (new Error('决策模型返回空内容'))
      error.code = 'MODEL_EMPTY'
      throw error
    }
    return content
  } catch (error) {
    if (/** @type {any} */ (error)?.name === 'AbortError') {
      const timeout = /** @type {any} */ (new Error(`Bot 分派超时（${timeoutMs}ms）`))
      timeout.code = 'MODEL_TIMEOUT'
      throw timeout
    }
    throw error
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', onAbort)
  }
}

function modelSettings(config, ctx) {
  const decision = config?.eval?.decision ?? {}
  return {
    endpoint: typeof decision.endpoint === 'string' ? decision.endpoint.trim() : '',
    model: typeof decision.model === 'string' ? decision.model.trim() : '',
    timeoutMs: Number.isFinite(decision.timeoutMs) && decision.timeoutMs >= 500 ? decision.timeoutMs : 6000,
    token: ctx?.decisionToken,
  }
}

/** Ask the decision model once, with cache, in-flight reuse and the per-window call budget. */
async function pickByModel({ ticket, candidates, config, ctx }) {
  const dispatchConfig = config?.executor?.dispatch ?? {}
  const cacheSeconds = Number.isFinite(dispatchConfig.cacheSeconds) ? dispatchConfig.cacheSeconds : 600
  const maxPerPoll = Number.isFinite(dispatchConfig.maxPerPoll) ? dispatchConfig.maxPerPoll : 10
  const key = dispatchCacheKey(ticket, candidates)
  if (cacheSeconds > 0) {
    const hit = pickCache.get(key)
    if (hit && Date.now() - hit.at < cacheSeconds * 1000) {
      return { ok: true, botId: hit.botId, because: hit.because, cacheHit: true }
    }
  }
  const settings = modelSettings(config, ctx)
  if (!settings.endpoint || !settings.model) {
    return { ok: false, degraded: 'pick-unavailable', reason: '决策模型未配置（eval.decision.endpoint/model）' }
  }
  const now = Date.now()
  if (now - budget.windowStart >= BUDGET_WINDOW_MS) {
    budget.windowStart = now
    budget.used = 0
  }
  if (budget.used >= maxPerPoll) {
    return { ok: false, degraded: 'pick-unavailable', reason: '本轮轮询的模型调用额度已用完' }
  }
  if (inFlight.has(key)) {
    const shared = await inFlight.get(key)
    return { ...shared, cacheHit: false }
  }
  budget.used += 1
  const attempt = (async () => {
    try {
      const content = await callPickModel({
        endpoint: settings.endpoint,
        model: settings.model,
        token: settings.token,
        payload: dispatchRequestOf(ticket, candidates),
        timeoutMs: settings.timeoutMs,
        fetchImpl: ctx?.fetchImpl,
      })
      const interpreted = interpretPick(content, candidates.map(bot => bot.id))
      if (!interpreted.ok) {
        const failure = /** @type {any} */ (interpreted)
        return { ok: false, degraded: failure.degraded, reason: failure.reason }
      }
      if (cacheSeconds > 0) {
        pickCache.set(key, { at: Date.now(), botId: interpreted.botId, because: interpreted.because })
        if (pickCache.size > MODEL_CACHE_MAX) pickCache.delete(pickCache.keys().next().value)
      }
      return { ok: true, botId: interpreted.botId, because: interpreted.because }
    } catch (error) {
      const code = /** @type {any} */ (error)?.code
      if (code === 'MODEL_HTTP' || code === 'MODEL_TIMEOUT' || code === 'MODEL_EMPTY') {
        return { ok: false, degraded: 'pick-unavailable', reason: /** @type {Error} */ (error).message }
      }
      // A fetch rejection is "the model is unreachable"; a malformed answer is a failed call, not an unavailable one.
      return { ok: false, degraded: 'pick-unavailable', reason: `模型调用失败：${/** @type {Error} */ (error)?.message ?? error}` }
    } finally {
      inFlight.delete(key)
    }
  })()
  inFlight.set(key, attempt)
  return { ...(await attempt), cacheHit: false }
}

function resultOf({ source, picked, because, candidates, skipped = [], cacheHit = false, degraded = null, configDigest }) {
  return {
    botId: picked ?? null,
    picked: picked ?? null,
    source,
    reason: because,
    because,
    candidates,
    skipped,
    cacheHit,
    degraded: degraded ?? null,
    configDigest,
  }
}

/** The bot that takes over when the pick cannot happen: `executor.bot`, else the first bot that exists. */
function defaultBotOf(config, bots) {
  const id = config?.executor?.bot ?? DEFAULT_BOT_ID
  return bots.find(bot => bot.id === id) ?? bots.find(bot => bot.id === DEFAULT_BOT_ID) ?? bots[0]
}

/**
 * Resolve one Ticket's bot.
 *
 * @param {{title?:string, body?:string, botOverride?:string}} ticket
 * @param {any} config live config
 * @param {any[]} bots every bot in the store (built-ins included)
 * @param {{ctx?:any, stateDir?:string, repoId?:string, decisionToken?:string, fetchImpl?:Function,
 *   versions?:Record<string,string>, probe?:Function}} [options] `probe`/`versions` are test seams.
 * @returns {Promise<object>} the run.dispatch record (see resultOf)
 */
export async function resolveDispatch(ticket, config, bots, options = {}) {
  const list = Array.isArray(bots) ? bots.filter(bot => isObject(bot) && typeof bot.id === 'string') : []
  const configDigest = digestOf({
    bots: botsDigest(list),
    bot: config?.executor?.bot ?? DEFAULT_BOT_ID,
    dispatch: config?.executor?.dispatch,
  })
  const probe = options.probe ?? botAvailability
  const checks = []
  for (const bot of list) {
    const answer = await probe(bot, {
      ctx: options.ctx,
      config,
      stateDir: options.stateDir,
      ...(options.versions?.[bot.backend] ? { version: options.versions[bot.backend] } : {}),
    })
    checks.push({ bot, state: answer?.state ?? 'unverified', reason: answer?.reason ?? '' })
  }
  const candidates = checks.filter(check => check.state === 'available').map(check => check.bot)
  const candidateIds = candidates.map(bot => bot.id)
  const skipped = checks.filter(check => check.state !== 'available')
    .map(check => ({ id: check.bot.id, backend: check.bot.backend, state: check.state, reason: check.reason }))

  // 1. Explicit: the ticket's manual choice, then the repository's. An id that is not in the store falls through
  //    (a removed built-in was already dropped at load, §7.4) instead of failing the run.
  const overrideId = typeof ticket?.botOverride === 'string' ? ticket.botOverride.trim().toLowerCase() : ''
  const repoBotId = typeof config?.repos?.find?.(repo => repo.id === options.repoId)?.bot === 'string'
    ? config.repos.find(repo => repo.id === options.repoId).bot : ''
  for (const [id, source] of [[overrideId, 'explicit-ticket'], [repoBotId, 'explicit-repo']]) {
    if (!id) continue
    const bot = list.find(item => item.id === id)
    if (!bot) continue
    return resultOf({ source, picked: bot.id, candidates: candidateIds, skipped, configDigest,
      because: source === 'explicit-ticket' ? '工单手动指定' : `仓库 ${options.repoId ?? ''} 指定`.trim() })
  }

  const defaultBot = defaultBotOf(config, list)

  // No backend can run anything: the default Bot is still the answer (§2.4), and the operator sees why.
  if (!candidates.length) {
    return resultOf({ source: 'default', picked: defaultBot?.id, candidates: [], skipped, configDigest,
      degraded: 'no-candidate',
      because: `${DEGRADED_TEXT['no-candidate']}${defaultBot ? `，回退 ${defaultBot.id}` : ''}` })
  }

  // 2. One candidate needs no model call.
  if (candidates.length === 1) {
    return resultOf({ source: 'pick', picked: candidates[0].id, candidates: candidateIds, skipped, configDigest,
      because: '只有这一个可用 Bot，未调模型' })
  }

  // 3. Pick.
  const subject = { title: String(ticket?.title ?? ''), body: String(ticket?.body ?? '') }
  const choice = await pickByModel({ ticket: subject, candidates, config, ctx: options })
  if (choice.ok && choice.botId) {
    return resultOf({ source: 'pick', picked: choice.botId, candidates: candidateIds, skipped, configDigest,
      cacheHit: choice.cacheHit === true, because: choice.because })
  }
  if (choice.ok && choice.botId === null) {
    return resultOf({ source: 'default', picked: defaultBot?.id, candidates: candidateIds, skipped, configDigest,
      degraded: 'pick-none', cacheHit: choice.cacheHit === true,
      because: `${DEGRADED_TEXT['pick-none']}：${choice.because}${defaultBot ? `，回退 ${defaultBot.id}` : ''}` })
  }
  return resultOf({ source: 'default', picked: defaultBot?.id, candidates: candidateIds, skipped, configDigest,
    degraded: choice.degraded, because: `${DEGRADED_TEXT[choice.degraded] ?? '派单失败'}：${choice.reason}${defaultBot ? `，回退 ${defaultBot.id}` : ''}` })
}

/** One English log line; the panel renders its own localized labels from source/degraded. */
export function dispatchSummary(result) {
  const picked = result?.picked ?? result?.botId ?? '(none)'
  return `${picked} <- ${result?.source ?? '?'}${result?.degraded ? ` [${result.degraded}]` : ''}${result?.cacheHit ? ' (cache)' : ''}`
}
