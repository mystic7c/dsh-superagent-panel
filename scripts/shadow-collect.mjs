#!/usr/bin/env node
/**
 * Collect shadow samples from the watched Octo groups (decision-model pilot, step 2).
 *
 *   node scripts/shadow-collect.mjs                         # latest 100 messages per watched group
 *   node scripts/shadow-collect.mjs --limit 200 --refresh   # re-judge everything, ignore cached answers
 *   node scripts/shadow-collect.mjs --json                  # print the whole sample document
 *
 * Each message becomes one sample with the rules' verdict and the model's calibrated answer side by side. Samples are
 * written to `<stateDir>/shadow-samples.json` (600); nothing in `live-state.json` changes, no Ticket is created.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadLiveConfig } from '../lib/live/config.js'
import { createOctoClient } from '../lib/live/octo.js'
import { createSystemOneJudge } from '../lib/live/judge.js'
import { collectShadowSamples, summarizeShadowSamples, shadowReviewRows, saveShadowSamples, loadShadowSamples }
  from '../lib/live/shadow.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法：node scripts/shadow-collect.mjs [--limit N] [--chat <id>]... [--refresh] [--json] [--review N]

  默认读取 live.json 里监听的每个群的最新 N 条消息（默认 100），用同一套 R2/R3 过滤与规则评估，
  再逐条问决策模型；结果写到 <stateDir>/shadow-samples.json。
  --refresh  不使用上次已获得的模型答案，全部重新询问
  --json     把完整样本文档打印到 stdout
  --review N 打印最值得人工标注的 N 条分歧（默认 20）`)
  process.exit(0)
}
const valueOf = (flag, fallback) => {
  const index = args.indexOf(flag)
  if (index < 0) return fallback
  const value = args[index + 1]
  return value === undefined || value.startsWith('--') ? fallback : value
}
const intOf = (flag, fallback) => {
  const value = Number(valueOf(flag, ''))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
const chats = []
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--chat' && args[index + 1] && !args[index + 1].startsWith('--')) chats.push(args[index + 1])
}
const limitPerChat = intOf('--limit', 100)
const reviewLimit = intOf('--review', 20)
const refresh = args.includes('--refresh')
const printJson = args.includes('--json')

const stateDir = process.env.DSH_SUPERAGENT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'superagent')
const loaded = loadLiveConfig(stateDir)
if (loaded.error) { console.error(`live.json 读取失败：${loaded.error}`); process.exit(1) }
if (!loaded.tokens?.octo) { console.error('Octo token 未配置（octo.tokenFile 或 OCTO_TOKEN）'); process.exit(1) }
const settings = loaded.config.eval?.decision ?? {}
if (!settings.endpoint || !settings.model) { console.error('eval.decision.endpoint / model 未配置，见 README「决策模型 shadow」'); process.exit(1) }
if (!loaded.tokens?.decision) { console.error(`decision token 未配置：${settings.tokenFile ?? 'decision.token'}`); process.exit(1) }

const client = createOctoClient({ cliPath: loaded.config.octo.cliPath, token: loaded.tokens.octo,
  warn: line => console.error(`octo: ${line}`) })
const judge = createSystemOneJudge({ endpoint: settings.endpoint, model: settings.model,
  token: loaded.tokens.decision, timeoutMs: settings.timeoutMs })
const previous = await loadShadowSamples(stateDir)

console.error(`collecting: ${chats.length ? chats.join(', ') : loaded.config.octo.watchChatIds.join(', ')} · limit ${limitPerChat}/群`)
const document = await collectShadowSamples({ loaded, client, judge, limitPerChat, chats, previous, refresh,
  concurrency: loaded.config.eval?.decision?.concurrency ?? 4, log: line => console.error(line) })
const file = await saveShadowSamples(stateDir, document)
const summary = summarizeShadowSamples(document.samples)
const review = shadowReviewRows(document.samples, { limit: reviewLimit })

console.error(`saved: ${file}`)
console.error(`samples ${document.stats.samples}（new ${document.stats.judged}, reused ${document.stats.reused}, errors ${document.stats.errors}）· skipped ${document.stats.skipped} · ${document.elapsedMs}ms`)
if (printJson) console.log(JSON.stringify(document, null, 2))
else console.log(JSON.stringify({ summary, review }, null, 2))
