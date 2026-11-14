/**
 * Shadow-sample collection for the decision-model pilot (landing plan step 2).
 *
 * The engine's shadow mode only judges *new* messages, and a quiet group produces no data. This module judges the
 * latest window of every watched group instead — the same candidate filters and the same rules the engine uses — and
 * stores one sample per message in a sidecar file (`<stateDir>/shadow-samples.json`). It never touches
 * `live-state.json`, never creates a Ticket, and never changes a rule. The samples are what the pilot compares and
 * labels: rules' verdict on one side, the model's calibrated probability on the other.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { writeFileDurable } from './durable.js'
import { join } from 'node:path'
import { candidateOfSync } from './engine.js'
import { evaluate } from './eval.js'
import { JUDGE_QUESTIONS_VERSION, verdictOf } from './judge.js'
import { preview } from '../util.js'

export const SHADOW_SAMPLES_NAME = 'shadow-samples.json'
export const SHADOW_SAMPLES_SCHEMA = 1
const SAMPLE_TEXT_MAX = 4000

const errorTextOf = error => error instanceof Error ? error.message : String(error ?? 'unknown error')

/** Stable identity of one message across collection runs (message id when present, seq otherwise). */
export function shadowSampleKey(chatId, message) {
  return `${chatId}:${message?.messageId ?? message?.messageSeq ?? 'unknown'}`
}

/** Rule side of one sample: the decision kind plus the reason codes the Eval page also shows. */
function ruleSideOf(evaluation) {
  return {
    kind: evaluation.kind,
    codes: (Array.isArray(evaluation.reason) ? evaluation.reason : [])
      .map(item => item && typeof item === 'object' ? item.code : undefined)
      .filter(Boolean),
  }
}

/** Run `worker` over `items` with at most `limit` concurrent calls (ordered output is not required). */
async function mapLimit(items, limit, worker) {
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      await worker(items[index], index)
    }
  })
  await Promise.all(workers)
}

/**
 * Judge the latest window of every watched group and return the sample document.
 *
 * `previous` (the last saved document) lets a re-run reuse model answers already obtained for the same message and
 * question set — collecting twice only pays for new messages, unless `refresh` is set.
 *
 * → { collectedAt, model, questions, elapsed..., chats, samples, skipped, stats }
 *
 * @param {any} [options]
 */
export async function collectShadowSamples({ loaded, client, judge, limitPerChat = 100, chats, previous,
  refresh = false, concurrency = 4, log = /** @type {(line: string) => void} */ (() => {}) } = {}) {
  const config = loaded?.config
  if (!config) throw new Error('live.json 不可用')
  const watched = (Array.isArray(chats) && chats.length ? chats : config.octo.watchChatIds).filter(Boolean)
  if (!watched.length) throw new Error('没有监听群（octo.watchChatIds 为空）')
  if (typeof client?.syncMessages !== 'function') throw new Error('Octo client 不可用')
  const settings = config.eval?.decision ?? {}
  const modelName = judge?.model ?? settings.model ?? ''
  const questions = JUDGE_QUESTIONS_VERSION
  const previousByKey = new Map((Array.isArray(previous?.samples) ? previous.samples : []).map(sample => [sample.key, sample]))
  const samples = []
  const skipped = []
  const pending = []
  const reused = []
  const startedAt = Date.now()

  for (const chatId of watched) {
    let batch
    try {
      batch = await client.syncMessages({ channelId: chatId, channelType: config.octo.channelType, limit: limitPerChat })
    } catch (error) {
      log(`读取群 ${chatId} 失败：${errorTextOf(error)}`)
      skipped.push({ chatId, reason: 'octo-error', error: errorTextOf(error).slice(0, 200) })
      continue
    }
    const messages = (Array.isArray(batch?.messages) ? batch.messages : [])
      .filter(message => message && Number.isFinite(message.messageSeq))
      .sort((left, right) => left.messageSeq - right.messageSeq)
    for (const message of messages) {
      const candidate = candidateOfSync(message, config)
      if (candidate.skip) { skipped.push({ chatId, seq: message.messageSeq, reason: candidate.skip }); continue }
      let evaluation
      try { evaluation = evaluate(candidate, config) } catch (error) {
        skipped.push({ chatId, seq: message.messageSeq, reason: 'eval-error', error: errorTextOf(error).slice(0, 200) })
        continue
      }
      const key = shadowSampleKey(chatId, message)
      const sample = {
        key,
        chatId,
        chatTitle: config.octo.chatTitles?.[chatId] ?? chatId,
        messageId: message.messageId === undefined || message.messageId === null ? undefined : String(message.messageId),
        seq: message.messageSeq,
        fromUid: message.fromUid,
        at: message.at,
        text: String(message.text ?? '').slice(0, SAMPLE_TEXT_MAX),
        rule: ruleSideOf(evaluation),
        questions,
      }
      const before = previousByKey.get(key)
      // A human label is ground truth about the message, not about the model answer: it survives re-judging with a
      // newer question set. Losing it here would silently empty the validation set every time the prompt changes.
      if (before?.label) {
        sample.label = before.label
        if (before.labeledAt) sample.labeledAt = before.labeledAt
      }
      const canReuse = refresh !== true && before?.model?.status === 'ok' && before.model.model === modelName
        && before.questions === questions
      if (canReuse) {
        sample.model = { ...before.model }
        reused.push(key)
      } else {
        pending.push(sample)
      }
      samples.push(sample)
    }
  }

  let errors = 0
  await mapLimit(pending, concurrency, async sample => {
    try {
      const result = await judge.judge({ text: sample.text })
      const probability = result.answers?.repoTask
      sample.model = {
        status: 'ok',
        model: result.model ?? modelName,
        questions,
        ...(typeof result.answers?.category === 'string' ? { category: result.answers.category } : {}),
        p: probability,
        ...(typeof result.answers?.risky === 'number' ? { riskP: result.answers.risky } : {}),
        verdict: verdictOf(probability, { acceptAt: settings.acceptAt, rejectAt: settings.rejectAt }),
        ...(Number.isFinite(result.latencyMs) ? { latencyMs: result.latencyMs } : {}),
        at: new Date().toISOString(),
      }
    } catch (error) {
      errors += 1
      sample.model = { status: 'error', model: modelName, questions, error: errorTextOf(error).slice(0, 300),
        at: new Date().toISOString() }
      log(`judge 失败（${sample.key}）：${errorTextOf(error)}`)
    }
  })

  samples.sort((left, right) => left.chatId.localeCompare(right.chatId) || left.seq - right.seq)
  const ok = samples.filter(sample => sample.model?.status === 'ok').length
  return {
    schemaVersion: SHADOW_SAMPLES_SCHEMA,
    collectedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    model: modelName,
    endpoint: settings.endpoint ?? '',
    questions,
    acceptAt: settings.acceptAt ?? 0.8,
    rejectAt: settings.rejectAt ?? 0.2,
    limitPerChat,
    chats: watched,
    samples,
    skipped,
    stats: { messages: samples.length + skipped.length, samples: samples.length, skipped: skipped.length,
      judged: pending.length - errors, reused: reused.length, errors, ok },
  }
}

const pct = (count, total) => total > 0 ? Math.round((count / total) * 1000) / 10 : 0

/** Cross-tab of rule outcome (accept / ignore) against the model's three-way verdict, plus risk and latency shape. */
export function summarizeShadowSamples(samples) {
  const list = Array.isArray(samples) ? samples : []
  const matrix = { accept: { accept: 0, reject: 0, uncertain: 0, error: 0 }, ignore: { accept: 0, reject: 0, uncertain: 0, error: 0 } }
  const byRuleCode = {}
  const pBins = [
    { label: '0–10%', from: 0, to: 0.1, count: 0 },
    { label: '10–30%', from: 0.1, to: 0.3, count: 0 },
    { label: '30–50%', from: 0.3, to: 0.5, count: 0 },
    { label: '50–70%', from: 0.5, to: 0.7, count: 0 },
    { label: '70–90%', from: 0.7, to: 0.9, count: 0 },
    { label: '90–100%', from: 0.9, to: 1.000001, count: 0 },
  ]
  const risk = { samples: 0, high: 0, low: 0 }
  const latencies = []
  let ok = 0
  let errors = 0
  const labels = {}
  const ruleByCode = {}
  const ruleByKind = { accept: 0, ignore: 0 }
  for (const sample of list) {
    if (sample.label) labels[sample.label] = (labels[sample.label] ?? 0) + 1
    const kind = sample?.rule?.kind === 'accept' ? 'accept' : 'ignore'
    ruleByKind[kind] += 1
    for (const code of Array.isArray(sample?.rule?.codes) ? sample.rule.codes : []) {
      ruleByCode[code] = (ruleByCode[code] ?? 0) + 1
      byRuleCode[code] = byRuleCode[code] ?? { accept: 0, reject: 0, uncertain: 0, error: 0 }
    }
    const status = sample?.model?.status
    if (status === 'ok') {
      ok += 1
      const verdict = ['accept', 'reject', 'uncertain'].includes(sample.model.verdict) ? sample.model.verdict : 'uncertain'
      matrix[kind][verdict] += 1
      for (const code of Array.isArray(sample?.rule?.codes) ? sample.rule.codes : []) byRuleCode[code][verdict] += 1
      if (typeof sample.model.p === 'number') {
        const bin = pBins.find(item => sample.model.p >= item.from && sample.model.p < item.to)
        if (bin) bin.count += 1
      }
      if (typeof sample.model.riskP === 'number') {
        risk.samples += 1
        if (sample.model.riskP >= 0.5) risk.high += 1
        else risk.low += 1
      }
      if (Number.isFinite(sample.model.latencyMs)) latencies.push(sample.model.latencyMs)
    } else if (status === 'error') {
      errors += 1
      matrix[kind].error += 1
      for (const code of Array.isArray(sample?.rule?.codes) ? sample.rule.codes : []) byRuleCode[code].error += 1
    } else {
      matrix[kind].error += 1
    }
  }
  latencies.sort((left, right) => left - right)
  // Nearest-rank percentile over the sorted list (p50 of four values is the lower middle one, p95 the max).
  const at = fraction => latencies.length ? latencies[Math.min(latencies.length - 1, Math.ceil(fraction * latencies.length) - 1)] : undefined
  return {
    total: list.length,
    ok,
    errors,
    rule: ruleByKind,
    matrix,
    // Accepted-by-rules messages the model would reject are the false-wake candidates; the reverse direction is where
    // the rules' filter (high risk / context) and the model can disagree for a good reason, so read it with `codes`.
    evaluated: {
      ruleAcceptModelAccept: matrix.accept.accept,
      ruleAcceptModelReject: matrix.accept.reject,
      ruleAcceptModelUncertain: matrix.accept.uncertain,
      acceptAgreementPct: pct(matrix.accept.accept, ruleByKind.accept),
      ruleIgnoreModelAccept: matrix.ignore.accept,
      ignoreModelAcceptPct: pct(matrix.ignore.accept, ruleByKind.ignore),
    },
    byRuleCode,
    pBins,
    risk,
    labels,
    latency: { count: latencies.length, p50: at(0.5), p95: at(0.95), max: latencies.at(-1) },
  }
}

/**
 * The labelled-free review queue: the rows where the two judges disagree or one of them is unsure, most interesting
 * first. Each row carries the message preview and both answers, so a human can label it without opening anything.
 */
export function shadowReviewRows(samples, { limit = 40 } = {}) {
  const rows = []
  for (const sample of Array.isArray(samples) ? samples : []) {
    const ruleKind = sample?.rule?.kind
    const codes = Array.isArray(sample?.rule?.codes) ? sample.rule.codes : []
    const model = sample?.model
    if (model?.status !== 'ok') continue
    const p = model.p
    const riskP = model.riskP
    const why = []
    let score = 0
    if (ruleKind === 'accept' && model.verdict === 'reject') { why.push('规则接单、模型判为不是活'); score = 2 + (1 - p) }
    if (ruleKind === 'accept' && model.verdict === 'uncertain') { why.push('规则接单、模型不确定'); score = 1.5 }
    if (ruleKind === 'ignore' && codes.includes('contextOnly') && model.verdict === 'accept') { why.push('规则当成上下文、模型判为请求'); score = 2 + p }
    if (ruleKind === 'ignore' && codes.includes('highRisk') && typeof riskP === 'number' && riskP < 0.5) {
      why.push('规则判高风险、模型风险低'); score = 2.5 + (1 - riskP)
    }
    if (ruleKind !== 'ignore' && typeof riskP === 'number' && riskP >= 0.8) { why.push('规则未拦风险、模型风险高'); score = 2.5 + riskP }
    if (!why.length) continue
    rows.push({ key: sample.key, chatTitle: sample.chatTitle, at: sample.at, text: preview(sample.text, 120),
      rule: ruleKind, codes, p, riskP, verdict: model.verdict, why: why.join('；'), score })
  }
  return rows.sort((left, right) => right.score - left.score || String(right.at).localeCompare(String(left.at))).slice(0, limit)
}

/** Atomic 600 write of the sample document. */
export async function saveShadowSamples(stateDir, document) {
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const file = join(stateDir, SHADOW_SAMPLES_NAME)
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFileDurable(tmp, `${JSON.stringify(document, undefined, 2)}\n`, { mode: 0o600 })
  await rename(tmp, file)
  return file
}

/** Load the last sample document; a missing or broken file yields an empty one instead of failing the CLI. */
export async function loadShadowSamples(stateDir) {
  try {
    const parsed = JSON.parse(await readFile(join(stateDir, SHADOW_SAMPLES_NAME), 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.samples)) return { samples: [], skipped: [] }
    return parsed
  } catch { return { samples: [], skipped: [] } }
}
