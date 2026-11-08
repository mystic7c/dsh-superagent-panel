#!/usr/bin/env node
/**
 * Smoke-test the System One decision model without touching engine state.
 *
 *   node scripts/judge-smoke.mjs                                   # one built-in request
 *   node scripts/judge-smoke.mjs --text "修复：收款单保存时校验银行账户必填"
 *   DSH_SUPERAGENT_STATE_DIR=/path/to/state node scripts/judge-smoke.mjs
 *
 * It reads live.json and the decision token from the state directory (the same files the engine reads), prints the
 * raw answers and the shadow record that would be stored, then exits. Nothing is written.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadLiveConfig } from '../lib/live/config.js'
import { createSystemOneJudge, shadowOf, JUDGE_QUESTIONS_VERSION } from '../lib/live/judge.js'

const args = process.argv.slice(2)
if (args.includes('--help') || args.includes('-h')) {
  console.log('用法：node scripts/judge-smoke.mjs [--text "消息正文"]')
  process.exit(0)
}
const flagIndex = args.indexOf('--text')
const freeText = args.filter(argument => !argument.startsWith('--'))
const text = flagIndex >= 0 ? args[flagIndex + 1] : freeText[0]
const message = typeof text === 'string' && text.trim() ? text.trim() : '修复：收款单保存时校验银行账户必填'

const stateDir = process.env.DSH_SUPERAGENT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'superagent')
const loaded = loadLiveConfig(stateDir)
if (loaded.error) {
  console.error(`live.json 读取失败：${loaded.error}`)
  process.exit(1)
}
const settings = loaded.config.eval?.decision ?? {}
if (!settings.endpoint || !settings.model) {
  console.error('未配置 eval.decision.endpoint / model，见 README「决策模型 shadow」一节')
  process.exit(1)
}
if (!loaded.tokens.decision) {
  console.error(`decision token 未配置：${settings.tokenFile}`)
  process.exit(1)
}

const judge = createSystemOneJudge({ endpoint: settings.endpoint, model: settings.model,
  token: loaded.tokens.decision, timeoutMs: settings.timeoutMs })
console.log(`stateDir : ${stateDir}`)
console.log(`endpoint : ${settings.endpoint}`)
console.log(`model    : ${settings.model}`)
console.log(`questions: ${JUDGE_QUESTIONS_VERSION}`)
console.log(`text     : ${message}`)
const started = Date.now()
try {
  const result = await judge.judge({ text: message })
  console.log(`latency  : ${result.latencyMs}ms（整个调用 ${Date.now() - started}ms）`)
  console.log(`answers  : ${JSON.stringify(result.answers)}`)
  const shadow = shadowOf(result, { ruleKind: 'unknown', acceptAt: settings.acceptAt, rejectAt: settings.rejectAt })
  console.log(`shadow   :\n${JSON.stringify(shadow, null, 2)}`)
} catch (error) {
  console.error(`judge 调用失败：${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
