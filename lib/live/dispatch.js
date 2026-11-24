/**
 * Worker-bot dispatch (worker-bots spec §7–§8, P2).
 *
 * One question: which bot runs this Ticket? Four layers decide, in a fixed order — an explicit override, a
 * dispatch rule, the decision model, the default — and every layer is allowed to *refuse* only at the last one. The
 * rules layer is fully offline: `dispatch.mode='rules'` must never touch the network (§7.4). The decision model gets
 * a ticket summary and the candidate list and answers one strict JSON object; its answer can only pick a candidate,
 * never invent a bot, change a gate or raise a budget (§7.2/§7.3).
 *
 * The module keeps the model cache and the per-poll call budget in memory: both exist to stop a rule change or a
 * poll loop from burning money, and both are process-local by design.
 */
import { capabilityStateOf, hostVersionOf } from './backend-capability.js'
import {
  DEFAULT_BOT_ID, BOT_BACKENDS, BOT_CAPABILITIES, capabilitiesOf, canonicalJson, digestOf,
  isBuiltinBot, botsDigest, synthesizeBot, validateBot,
} from './worker-bot.js'

/** Where a dispatch decision came from (§7.5). */
export const DISPATCH_SOURCES = Object.freeze(['explicit', 'rule', 'model', 'default', 'adhoc'])

/** Reasons a decision is not the ideal one; surfaced in the panel, never silent (§7.5). */
export const DISPATCH_DEGRADED = Object.freeze(['explicit-unusable', 'model', 'model-null'])

const MODEL_MESSAGE_LIMIT = 200
const MODEL_SYSTEM = [
  '你是 Superagent 的 Bot 分派器。给定一个工单和一组候选 Bot，选择最合适的一个。',
  '只返回一个 JSON 对象，不要解释、不要代码块：{"bot":"<候选 id 或 null>","confidence":0-1 的小数,"reason":"不超过 200 字的中文理由"}。',
  '如果没有任何候选合适，bot 返回 null。不要返回其他键，不要编造候选 id。',
].join('\n')

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const unique = list => [...new Set(list)]

/** The capabilities a Ticket's work needs from its worker (§8.2): report work needs none, change work needs edit. */
export function requiresOf({ deliverable = 'change', workType = 'dev' } = {}) {
  if (deliverable === 'report') return []
  const needs = new Set(['edit'])
  if (workType === 'test') needs.add('exec')
  if (workType === 'research') needs.add('web')
  return [...needs].sort()
}

/** One backend's verified capability set; a missing probe is `unverified`, never the routing table (§3.2). */
export function capabilitiesOfBackend(ctx, backend) {
  return capabilitiesOf(ctx?.probes?.[backend])
}

/**
 * The probe that applies to one bot: tools depend on the agent preset, so `ctx.probes` may key a probe as
 * `backend|preset` and fall back to the backend's default probe.
 */
function probeFor(ctx, backend, preset) {
  const probes = ctx?.probes ?? {}
  return (preset ? probes[`${backend}|${preset}`] : undefined) ?? probes[backend]
}

/** The runtime facts a bot is judged against (§3.7): exported so a stage-level bot is judged exactly like a
 *  dispatch candidate (same probe, same version rule, same enabled set). */
export function environmentOf(bot, ctx) {
  return environmentFor(bot, ctx)
}

function environmentFor(bot, ctx) {
  const backend = bot?.backend
  const probe = probeFor(ctx, backend, typeof bot?.preset === 'string' ? bot.preset : undefined)
  // A smoke row for another CLI version is stale (§3.7), so the version belongs to the state, not to the probe alone.
  // The probe was recorded against the host version (probeBackend falls back to hostVersionOf), so judging it with
  // only `ctx.versions` used to leave `version` undefined and the stale guard could never fire.
  const backendState = capabilityStateOf(probe, { version: ctx?.versions?.[backend] ?? hostVersionOf(ctx) })
  return {
    capabilities: capabilitiesOf(probe),
    backendState,
    ...(Array.isArray(ctx?.enabledBackends) ? { backendEnabled: ctx.enabledBackends.includes(backend) } : {}),
    ...(isObject(ctx?.effortSupported) ? { effortSupported: ctx.effortSupported[backend] } : {}),
  }
}

/** The payload the model receives (§7.2): ticket summary plus the eligible candidates only. */
export function dispatchRequestOf(ticket, subject, candidates) {
  const botById = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const title = String(ticket?.title ?? '')
  const body = String(ticket?.body ?? '')
  // §18 Q3: the model sees a bounded excerpt; say so instead of pretending it read the whole ticket.
  const truncated = title.length > 400 || body.length > 4000
  return {
    ticket: {
      title: title.slice(0, 400),
      body: body.slice(0, 4000),
      ...(truncated ? { truncated: true } : {}),
      repo: subject.repoId ?? '',
      workType: subject.workType ?? '',
      deliverable: subject.deliverable ?? '',
    },
    candidates: candidates.map(candidate => {
      const bot = botById.get(candidate.id)?.bot ?? {}
      return {
        id: candidate.id,
        name: bot.name ?? candidate.id,
        capabilities: (bot.requires ?? []).slice(),
        notes: String(bot.description ?? '').slice(0, 200),
        cost: bot.backend,
      }
    }),
  }
}

function stripFence(text) {
  const raw = String(text ?? '').trim()
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  return fenced?.[1]?.trim() ?? raw
}

/** First balanced object in a string; a chatty model may wrap the JSON in prose. */
function firstJsonObject(text) {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text[index]
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
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Strict answer contract (§7.2): exactly `bot`, `confidence`, `reason`; the bot must be one of the offered
 * candidates (or null). Anything else is a model failure, not a hint to guess.
 * @returns {{bot:string|null, confidence:number, reason:string}}
 */
export function validateChoice(value, candidateIds) {
  if (!isObject(value)) throw new Error('Bot 分派模型没有返回 JSON 对象')
  const keys = Object.keys(value)
  if (keys.some(key => !['bot', 'confidence', 'reason'].includes(key))) {
    throw new Error(`Bot 分派模型返回了多余字段：${keys.filter(key => !['bot', 'confidence', 'reason'].includes(key)).join(', ')}`)
  }
  if (keys.length !== 3) throw new Error('Bot 分派模型必须返回 bot / confidence / reason 三个字段')
  const bot = value.bot
  if (bot !== null && !(typeof bot === 'string' && candidateIds.includes(bot))) {
    throw new Error('Bot 分派模型选择了不在候选集里的 Bot')
  }
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)
    || value.confidence < 0 || value.confidence > 1) {
    throw new Error('Bot 分派模型的 confidence 必须是 0–1 的数字')
  }
  if (typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > MODEL_MESSAGE_LIMIT) {
    throw new Error(`Bot 分派模型的 reason 必须非空且不超过 ${MODEL_MESSAGE_LIMIT} 字`)
  }
  return { bot, confidence: value.confidence, reason: value.reason.trim() }
}

/**
 * One model call, no retry (§7.2). Throws on transport/parse/shape failure; the caller degrades to layer 4.
 * @param {{endpoint?: any, model?: any, token?: any, payload?: any, timeoutMs?: number, fetchImpl?: any, signal?: any}} options
 */
export async function callDispatchModel({ endpoint, model, token, payload, timeoutMs = 6000, fetchImpl, signal } = {}) {
  if (typeof endpoint !== 'string' || !/^https?:\/\/\S+$/i.test(endpoint)) throw new Error('eval.decision.endpoint 未配置')
  if (typeof model !== 'string' || !model.trim()) throw new Error('eval.decision.model 未配置')
  if (typeof token !== 'string' || !token.trim()) throw new Error('decision token 未配置（eval.decision.tokenFile）')
  const doFetch = fetchImpl ?? globalThis.fetch
  if (typeof doFetch !== 'function') throw new Error('当前 Node 运行时不支持 fetch')
  const timeout = Math.max(100, Number.isFinite(timeoutMs) ? Math.floor(timeoutMs) : 6000)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  if (signal) signal.addEventListener('abort', () => controller.abort(), { once: true })
  try {
    const response = await doFetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.trim()}` },
      body: JSON.stringify({ model: model.trim(), temperature: 0,
        messages: [{ role: 'system', content: MODEL_SYSTEM },
          { role: 'user', content: JSON.stringify(payload) }] }),
      signal: controller.signal,
    })
    const body = await response.json().catch(() => undefined)
    if (!response.ok) throw new Error(`Bot 分派 HTTP ${response.status}`)
    const content = body?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('Bot 分派模型没有返回内容')
    const json = firstJsonObject(stripFence(content))
    if (!json) throw new Error('Bot 分派模型没有返回 JSON')
    return JSON.parse(json)
  } catch (error) {
    if (error?.name === 'AbortError' || controller.signal.aborted) throw new Error(`Bot 分派超时（${timeout}ms）`)
    throw error
  } finally {
    clearTimeout(timer)
  }
}

// --- cache + per-poll budget (§7.4) ---------------------------------------------------------------

const modelCache = new Map()
const inFlight = new Map()
let budget = { windowStart: 0, used: 0 }

/** Test/ops hook: forget every cached model answer and the current poll budget. */
export function clearDispatchCache() {
  modelCache.clear()
  inFlight.clear()
  budget = { windowStart: 0, used: 0 }
}

export function dispatchCacheSize() {
  return modelCache.size
}

function eligibleByBudget(ctx, maxPerPoll) {
  const now = typeof ctx?.now === 'function' ? ctx.now() : Date.now()
  const pollMs = Math.max(1000, Number.isFinite(ctx?.pollMs) ? ctx.pollMs : 60_000)
  if (now - budget.windowStart >= pollMs) budget = { windowStart: now, used: 0 }
  return budget.used < maxPerPoll
}

function spendBudget() { budget.used += 1 }

/** Cache key: the ticket's dispatchable identity plus the bot set digest (§7.4). */
export function dispatchCacheKey(subject, botsDigestValue) {
  const parts = [subject.title, subject.repoId ?? '', subject.workType ?? '', subject.deliverable ?? '', botsDigestValue]
  return digestOf(parts.join('\n'))
}

async function modelChoice({ payload, key, ctx, config, maxPerPoll }) {
  const dispatch = config?.executor?.dispatch ?? {}
  const cacheSeconds = Number.isFinite(dispatch.cacheSeconds) ? dispatch.cacheSeconds : 600
  if (cacheSeconds > 0) {
    const hit = modelCache.get(key)
    if (hit && Date.now() - hit.at < cacheSeconds * 1000) return { value: hit.value }
  }
  // Out of this poll's model calls: the decision layer degrades to 'model', which §7.5 allows; the next poll retries.
  if (!eligibleByBudget(ctx, maxPerPoll)) return { degraded: 'model', reason: '本轮轮询的模型调用额度已用完' }
  if (inFlight.has(key)) return { value: await inFlight.get(key) }
  const decision = config?.eval?.decision ?? {}
  const call = callDispatchModel({
    endpoint: decision.endpoint,
    model: decision.model,
    token: ctx?.decisionToken,
    timeoutMs: decision.timeoutMs,
    fetchImpl: ctx?.fetchImpl,
    signal: ctx?.signal,
    payload,
  })
  spendBudget()
  inFlight.set(key, call)
  try {
    const value = await call
    if (cacheSeconds > 0) modelCache.set(key, { at: Date.now(), value })
    return { value }
  } finally {
    inFlight.delete(key)
  }
}

// --- candidate set + selection --------------------------------------------------------------------

/** Bots eligible for dispatch: verified backend, valid declaration, and their own requirements met (§7.1). */
export function dispatchCandidates(bots, ctx) {
  const candidates = []
  for (const bot of Array.isArray(bots) ? bots : []) {
    if (!bot || typeof bot.id !== 'string') continue
    const environment = environmentFor(bot, ctx)
    if (environment.backendState !== 'verified') continue
    const validated = validateBot(bot, environment)
    if (!validated.ok) continue
    const caps = environment.capabilities
    if ((bot.requires ?? []).some(capability => caps[capability] !== true)) continue
    candidates.push({ id: bot.id, bot, environment, capabilities: caps,
      capabilityNames: BOT_CAPABILITIES.filter(capability => caps[capability] === true) })
  }
  return candidates
}

function ruleMatches(rule, subject) {
  if (Array.isArray(rule.workTypes) && rule.workTypes.length && !rule.workTypes.includes(subject.workType)) return false
  if (Array.isArray(rule.repos) && rule.repos.length && !rule.repos.includes(subject.repoId)) return false
  if (Array.isArray(rule.sources) && rule.sources.length && !rule.sources.includes(subject.source)) return false
  if (typeof rule.deliverable === 'string' && rule.deliverable && rule.deliverable !== subject.deliverable) return false
  if (Array.isArray(rule.keywords) && rule.keywords.length) {
    const haystack = subject.text.toLowerCase()
    if (!rule.keywords.some(keyword => typeof keyword === 'string' && keyword && haystack.includes(keyword.toLowerCase()))) {
      return false
    }
  }
  return true
}

function describeRule(rule) {
  const parts = []
  if (rule.workTypes?.length) parts.push(`workTypes=${rule.workTypes.join('/')}`)
  if (rule.keywords?.length) parts.push(`keywords=${rule.keywords.join('/')}`)
  if (rule.repos?.length) parts.push(`repos=${rule.repos.join('/')}`)
  if (rule.sources?.length) parts.push(`sources=${rule.sources.join('/')}`)
  if (rule.deliverable) parts.push(`deliverable=${rule.deliverable}`)
  return parts.join(', ') || '无条件'
}

/** The explicit overrides, in the order §7.1 lists them (executor.bot is the default layer, not explicit). */
function explicitLayers(ticket, config, subject) {
  const layers = []
  if (typeof ticket?.botOverride === 'string' && ticket.botOverride.trim()) {
    layers.push({ id: ticket.botOverride.trim(), label: '手动指定' })
  }
  if (typeof ticket?.backendOverride === 'string' && ticket.backendOverride) {
    // All three built-ins are DSH bots (§4.5), so only a DSH override has a bot to map to.
    const builtin = ticket.backendOverride === 'dsh' ? 'generalist' : undefined
    if (builtin) layers.push({ id: builtin, label: `后端 ${ticket.backendOverride} 映射为内置 Bot` })
  }
  const repo = (config?.repos ?? []).find(item => item.id === subject.repoId)
  if (repo && typeof repo.bot === 'string' && repo.bot) layers.push({ id: repo.bot, label: `仓库 ${repo.id} 指定` })
  const chatRepoId = config?.octo?.chatRepos?.[ticket?.origin?.channelId]
  const chatRepo = chatRepoId ? (config.repos ?? []).find(item => item.id === chatRepoId) : undefined
  if (chatRepo?.bot) layers.push({ id: chatRepo.bot, label: `来源会话映射的仓库 ${chatRepo.id} 指定` })
  const seen = new Set()
  return layers.filter(layer => { if (seen.has(layer.id)) return false; seen.add(layer.id); return true })
}

/** @param {{botId: any, source: any, reason: any, degraded?: any, candidates: any[], capability?: any, probe?: any, configDigest: any, resolved?: any, synthesizedFrom?: any}} decision */
function resultOf({ botId, source, reason, degraded, candidates, capability, probe, configDigest, resolved, synthesizedFrom }) {
  return {
    botId,
    source,
    reason,
    ...(degraded ? { degraded } : {}),
    candidates: candidates.map(candidate => candidate.id),
    capability: capability ?? [],
    capabilitySource: probe?.source ?? 'fallback',
    ...(probe?.verifiedAt ? { verifiedAt: probe.verifiedAt } : {}),
    configDigest,
    ...(resolved ? { resolved } : {}),
    ...(synthesizedFrom ? { synthesizedFrom } : {}),
  }
}

/**
 * Resolve which bot runs one Ticket (§7.1). `ctx` carries the runtime facts the pure layers cannot know:
 * `probes` (one ProbeResult per backend), `versions`, `enabledBackends`, `workType`, `deliverable`, `repoId`,
 * `source`, `decisionToken`, `fetchImpl`, `now`, `pollMs`.
 *
 * Never throws for a missing bot: refusal is expressed as `botId: null` plus `reason` so the executor can
 * fail the run with an auditable record instead of an exception without context.
 */
export async function resolveDispatch(ticket, config, bots, ctx = {}) {
  const subject = {
    title: String(ticket?.title ?? ''),
    text: `${String(ticket?.title ?? '')}\n${String(ticket?.body ?? '')}`,
    workType: ctx.workType ?? ticket?.workType ?? 'dev',
    deliverable: ctx.deliverable ?? ticket?.deliverable ?? 'change',
    repoId: ctx.repoId ?? ticket?.repoId,
    source: ctx.source ?? ticket?.source,
  }
  const list = Array.isArray(bots) ? bots : []
  const configDigest = digestOf({
    bots: botsDigest(list),
    dispatch: config?.executor?.dispatch ?? {},
    bot: config?.executor?.bot ?? DEFAULT_BOT_ID,
  })
  const validated = dispatchCandidates(list, ctx)
  const requires = requiresOf(subject)
  const capsOf = backend => capabilitiesOfBackend(ctx, backend)
  const covers = candidate => requires.every(capability => candidate.capabilities[capability] === true)
  // The candidate set is "could run THIS ticket": a bot the work type cannot use is not a candidate (§7.1).
  const candidates = validated.filter(covers)
  const byId = new Map(candidates.map(candidate => [candidate.id, candidate]))
  const validatedById = new Map(validated.map(candidate => [candidate.id, candidate]))
  // §18 Q8: a bot that requires nothing (the `reviewer`, or a report-only bot) is a stage tool, not a whole-ticket
  // pick — it never joins the automatic set (model/default). An explicit choice may still name it.
  const auto = candidates.filter(candidate => (candidate.bot.requires ?? []).length > 0)
  const autoById = new Map(auto.map(candidate => [candidate.id, candidate]))

  // Layer 1 — explicit overrides. An explicit bot that cannot run is a refusal, never a silent substitution (§7.1).
  for (const layer of explicitLayers(ticket, config, subject)) {
    const declared = list.find(bot => bot.id === layer.id)
    if (!declared) {
      return resultOf({ botId: layer.id, source: 'explicit', degraded: 'explicit-unusable',
        reason: `${layer.label}的 Bot ${layer.id} 不存在`, candidates, configDigest })
    }
    const candidate = validatedById.get(layer.id)
    if (!candidate) {
      return resultOf({ botId: layer.id, source: 'explicit', degraded: 'explicit-unusable',
        reason: `${layer.label}的 Bot ${layer.id} 不可用（后端未核验或声明不合法）`, candidates, configDigest })
    }
    if (!covers(candidate)) {
      return resultOf({ botId: layer.id, source: 'explicit', degraded: 'explicit-unusable',
        reason: `${layer.label}的 Bot ${layer.id} 缺少本次工作需要的能力：${requires.join(', ')}`, candidates, configDigest })
    }
    return resultOf({ botId: layer.id, source: 'explicit', reason: `${layer.label}：${layer.id}`,
      candidates, capability: candidate.capabilityNames, probe: probeFor(ctx, candidate.bot.backend, candidate.bot.preset), configDigest })
  }

  // Layer 2 — rules, in order, first full match. Fully offline.
  const rules = Array.isArray(config?.executor?.dispatch?.rules) ? config.executor.dispatch.rules : []
  for (const [index, rule] of rules.entries()) {
    if (!rule || typeof rule.bot !== 'string') continue
    const candidate = byId.get(rule.bot)
    if (!candidate || !covers(candidate)) continue
    if (!ruleMatches(rule, subject)) continue
    return resultOf({ botId: rule.bot, source: 'rule',
      reason: `规则 #${index + 1} 命中（${describeRule(rule)}）`, candidates,
      capability: candidate.capabilityNames, probe: probeFor(ctx, candidate.bot.backend, candidate.bot.preset), configDigest })
  }

  // Layer 3 — the decision model. `rules` mode never calls it; an empty candidate set skips straight to layer 4.
  const mode = config?.executor?.dispatch?.mode ?? 'rules'
  let degraded
  if (mode !== 'rules' && auto.length) {
    const maxPerPoll = Number.isFinite(config?.executor?.dispatch?.maxPerPoll)
      ? config.executor.dispatch.maxPerPoll : 10
    const key = dispatchCacheKey(subject, botsDigest(list))
    const payload = dispatchRequestOf(ticket, subject, auto)
    try {
      const answer = await modelChoice({ payload, key, ctx, config, maxPerPoll })
      if (answer.degraded) {
        degraded = answer.degraded
      } else {
        const choice = validateChoice(answer.value, auto.map(candidate => candidate.id))
        if (choice.bot === null) {
          degraded = 'model-null'
        } else {
          const candidate = autoById.get(choice.bot)
          if (candidate && covers(candidate)) {
            return resultOf({ botId: choice.bot, source: 'model',
              reason: `决策模型选择 ${choice.bot}（置信度 ${choice.confidence}）：${choice.reason}`, candidates,
              capability: candidate.capabilityNames, probe: probeFor(ctx, candidate.bot.backend, candidate.bot.preset), configDigest })
          }
          degraded = 'model'
        }
      }
    } catch {
      degraded = 'model'
    }
  }

  // Layer 4a — the default bot (§5.3: missing config yields generalist / source 'default'). Only a verified probe
  // makes a bot a candidate (§3.7): a backend nothing probed is `unverified`, and the conservative table in
  // routing.js may explain a refusal but never authorize a run (§3.2, I3, I9).
  const defaultId = config?.executor?.bot ?? DEFAULT_BOT_ID
  const declaredDefault = list.find(bot => bot?.id === defaultId)
  const fallback = autoById.get(defaultId)
  if (fallback && covers(fallback)) {
    return resultOf({ botId: defaultId, source: 'default',
      reason: `默认 Bot ${defaultId}（executor.bot）`, degraded, candidates,
      capability: fallback.capabilityNames, probe: probeFor(ctx, fallback.bot.backend, fallback.bot.preset), configDigest })
  }

  // Layer 4b — ad-hoc, only when enabled and no saved bot covers the work (§8). Capabilities come from the same
  // probes as layer 4a: an unprobed backend cannot be synthesized onto (its table row is a refusal note, not evidence).
  if (config?.executor?.dispatch?.adhoc === true) {
    // A synthesized Bot runs on a backend the same way a saved one does, so it needs the same verified probe: stale
    // smoke evidence used to slip through here because only capabilities were consulted.
    const versionOf = backend => ctx?.versions?.[backend] ?? hostVersionOf(ctx)
    const order = (config.executor.dispatch.adhocOrder ?? ['dsh'])
      .filter(backend => ctx?.enabledBackends?.includes(backend) ?? BOT_BACKENDS.includes(backend))
      .filter(backend => capabilityStateOf(probeFor(ctx, backend), { version: versionOf(backend) }) === 'verified')
    const capsFor = backend => capabilitiesOfBackend(ctx, backend)
    const capsByBackend = Object.fromEntries(BOT_BACKENDS.map(backend => [backend, capsFor(backend)]))
    const synthesized = synthesizeBot({
      requires, deliverable: subject.deliverable, capabilities: capsByBackend, backendOrder: order,
      role: String(ticket?.title ?? '').slice(0, 500) || `按 ${subject.workType} 处理这件事`,
    })
    if (synthesized) {
      return resultOf({ botId: synthesized.id, source: 'adhoc',
        reason: degraded === 'model-null'
          ? `模型没有选出 Bot；没有已保存的 Bot 覆盖 ${requires.join(', ') || '本次工作'}，现拉 ${synthesized.id}`
          : `没有已保存的 Bot 覆盖 ${requires.join(', ') || '本次工作'}，现拉 ${synthesized.id}`,
        degraded, candidates, capability: BOT_CAPABILITIES.filter(capability => capsFor(synthesized.backend)[capability] === true),
        probe: probeFor(ctx, synthesized.backend, synthesized.preset), configDigest, resolved: synthesized,
        synthesizedFrom: { requires, deliverable: subject.deliverable } })
    }
  }

  // An unknown `executor.bot` under a healthy store means the config points at a bot that was never saved.
  // That must not refuse every ticket: the pre-bot behaviour (P1) is to run with the legacy settings, and the
  // substitution is recorded so the panel can show it (§5.3). An empty/unreadable store still refuses.
  if (!declaredDefault && defaultId !== DEFAULT_BOT_ID && list.some(bot => isBuiltinBot(bot?.id))) {
    return resultOf({ botId: defaultId, source: 'default', degraded: degraded ?? 'explicit-unusable',
      reason: `默认 Bot ${defaultId} 不存在，退回旧行为（executor.bot）`, candidates, configDigest })
  }

  const want = requires.join(', ') || '本次工作'
  const adhocOn = config?.executor?.dispatch?.adhoc === true
  return resultOf({ botId: null, source: 'default', degraded: degraded ?? 'explicit-unusable',
    reason: `没有可用 Bot：没有已保存的 Bot 覆盖 ${want}，且${adhocOn ? '现拉找不到可用后端（dispatch.adhocOrder）' : ' dispatch.adhoc 已关闭'}`,
    candidates, configDigest })
}

/** Human-readable one-line summary for the panel and `run.bot.reason` (§7.5). */
export function dispatchSummary(result) {
  if (!result) return ''
  if (!result.botId) return result.reason ?? '没有可用 Bot'
  const degraded = result.degraded ? `（降级：${result.degraded}）` : ''
  return `${result.botId}${degraded}`
}

export { canonicalJson }
