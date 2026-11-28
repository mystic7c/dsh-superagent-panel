import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BOT_BACKENDS, BOT_BUDGET, BOT_EFFORTS, BOT_FILE_NAME, BOT_FILE_VERSION, BOT_ID_PATTERN, BOT_LIMITS,
  BUILTIN_BOT_IDS, DEFAULT_BOT_ID, REMOVED_BOT_IDS, botsDigest, botsFileOf, builtinBots, canonicalJson,
  digestOf, isBuiltinBot, isRemovedBot, migrateBots, normalizeBot, normalizeBots, paramsOfBot,
  parseBotsDocument, readBots, resolveBot, sortBot, validateBot, writeBots,
} from './worker-bot.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'superagent-bots-'))
}

function baseBot(overrides = {}) {
  return { id: 'dsh-dev', name: 'DSH 开发', backend: 'dsh', ...overrides }
}

test('built-ins are exactly generalist and reviewer and cannot be mutated by callers', () => {
  // 1.5.0 重写了 Bot 契约：内置只剩两个，surgical 退场（见下一个用例）。
  assert.deepEqual(BUILTIN_BOT_IDS, ['generalist', 'reviewer'])
  const bots = builtinBots()
  assert.deepEqual(bots.map(bot => bot.id), ['generalist', 'reviewer'])
  assert.deepEqual(bots.map(bot => bot.backend), ['dsh', 'dsh'])
  // 键序固定，面板深比较与摘要才稳定。
  assert.deepEqual(Object.keys(bots[0]), ['id', 'name', 'description', 'whenToUse', 'backend'])
  // 每次返回副本：调用方改到手的内置定义，不能污染下一次读取。
  bots[0].name = '被改掉的名字'
  bots[0].whenToUse = '被改掉的场景'
  assert.notEqual(builtinBots()[0].name, '被改掉的名字')
  assert.notEqual(builtinBots()[0].whenToUse, '被改掉的场景')
  assert.equal(isBuiltinBot('generalist'), true)
  assert.equal(isBuiltinBot('reviewer'), true)
  assert.equal(isBuiltinBot('custom'), false)
  assert.equal(DEFAULT_BOT_ID, 'generalist')
  assert.equal(BOT_FILE_NAME, 'worker-bots.json')
  // 内置定义自己必须过校验：名单改小时最容易忘的就是这一条。
  for (const bot of builtinBots()) assert.equal(validateBot(bot).ok, true, bot.id)
})

test('the v3 contract numbers live in BOT_LIMITS / BOT_BUDGET instead of scattered magic values', () => {
  assert.equal(BOT_FILE_VERSION, 3)
  assert.deepEqual([BOT_LIMITS.description, BOT_LIMITS.whenToUse], [120, 300])
  assert.deepEqual(BOT_BUDGET.timeoutMs, [60_000, 7_200_000])
  assert.deepEqual(BOT_BUDGET.idleTimeoutMs, [60_000, 3_600_000])
  assert.deepEqual(BOT_BUDGET.maxRepairRounds, [0, 6])
  assert.deepEqual(BOT_BACKENDS, ['dsh', 'claude', 'codex'])
  assert.deepEqual(BOT_EFFORTS, ['auto', 'low', 'medium', 'high'])
  assert.equal(BOT_ID_PATTERN.test('dsh-dev'), true)
  assert.equal(BOT_ID_PATTERN.test('Dsh-Dev'), false)
  assert.equal(BOT_ID_PATTERN.test('a'), false)
})

test('surgical is history: no longer built-in, but still recognised as removed', () => {
  assert.deepEqual(REMOVED_BOT_IDS, ['surgical'])
  assert.equal(isRemovedBot('surgical'), true)
  assert.equal(isRemovedBot('generalist'), false)
  assert.equal(BUILTIN_BOT_IDS.includes('surgical'), false)
  assert.equal(isBuiltinBot('surgical'), false)
  // 已移除的 id 仍能满足 id 格式，所以「不能再用」只能由 isRemovedBot 决定，不能指望正则拦。
  assert.equal(BOT_ID_PATTERN.test('surgical'), true)
})

test('normalizeBot drops the retired fields (requires / tools / prompt.must) and reports their keys', () => {
  const { bot, dropped, truncated } = normalizeBot({
    id: ' DSH-Dev ',
    name: ' DSH 开发 ',
    description: ' 一句话 ',
    whenToUse: ' 派给我 ',
    backend: 'DSH',
    model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'HIGH', temperature: 1 },
    requires: ['edit', 'exec'],
    tools: { deny: ['present'] },
    skills: { prefer: ['ponytail', 'ponytail', ' '], policy: 'Prompt', extra: true },
    prompt: { role: '只改目标仓库', must: ['先跑单测'] },
    budget: { timeoutMs: 900_000, gateTimeoutMs: 1 },
    unknown: true,
  })
  // 旧契约的字段不是「合法但被忽略」而是「未知键」：面板与迁移都靠这份清单解释自己丢了什么。
  assert.deepEqual(dropped.sort(), [
    'budget.gateTimeoutMs', 'model.temperature', 'prompt.must', 'requires', 'skills.extra', 'tools', 'unknown',
  ])
  assert.deepEqual(truncated, [])
  assert.equal(bot.id, 'dsh-dev')
  assert.equal(bot.name, 'DSH 开发')
  assert.equal(bot.description, '一句话')
  assert.equal(bot.whenToUse, '派给我')
  assert.equal(bot.backend, 'dsh')
  assert.equal(bot.requires, undefined)
  assert.equal(bot.tools, undefined)
  assert.deepEqual(bot.model, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
  assert.deepEqual(bot.skills, { prefer: ['ponytail'], policy: 'prompt' })
  assert.deepEqual(bot.prompt, { role: '只改目标仓库' })
  assert.deepEqual(bot.budget, { timeoutMs: 900_000 })
  assert.deepEqual(Object.keys(bot),
    ['id', 'name', 'description', 'whenToUse', 'backend', 'model', 'skills', 'prompt', 'budget'])
})

test('normalizeBot truncates over-limit text and reports the field so a save can refuse it', () => {
  const { bot, truncated } = normalizeBot({
    id: 'long-bot', name: 'N'.repeat(41), description: 'D'.repeat(130), whenToUse: 'W'.repeat(320),
    backend: 'dsh', prompt: { role: 'R'.repeat(2001) },
  })
  assert.equal(bot.name.length, BOT_LIMITS.name)
  assert.equal(bot.description.length, BOT_LIMITS.description)
  assert.equal(bot.whenToUse.length, BOT_LIMITS.whenToUse)
  assert.equal(bot.prompt.role.length, BOT_LIMITS.role)
  assert.deepEqual(truncated, ['name', 'description', 'whenToUse', 'prompt.role'])
  // 只写空白的 whenToUse 等于没写：读回时不能变成一个「有值但空」的键。
  assert.equal(normalizeBot({ id: 'no-hint', name: 'n', backend: 'dsh', whenToUse: '   ' }).bot.whenToUse, undefined)
})

test('validateBot still enforces the description / whenToUse limits even though normalization truncates', () => {
  // 归一化会截断，但截断只服务于「读旧文件」：保存路径必须拒绝，否则运营以为存下的全文其实被切了。
  assert.equal(validateBot({ id: 'long-desc', name: 'n', backend: 'dsh', description: 'D'.repeat(121) }).code,
    'BOT_SCHEMA_INVALID')
  assert.equal(validateBot({ id: 'long-hint', name: 'n', backend: 'dsh', whenToUse: 'W'.repeat(301) }).code,
    'BOT_SCHEMA_INVALID')
  assert.equal(validateBot({ id: 'not-a-string', name: 'n', backend: 'dsh', description: 42 }).code,
    'BOT_SCHEMA_INVALID')
  // 边界值本身可以通过：上限是含端点的。
  assert.equal(validateBot({
    id: 'exact-limit', name: 'n', backend: 'dsh',
    description: 'D'.repeat(BOT_LIMITS.description), whenToUse: 'W'.repeat(BOT_LIMITS.whenToUse),
  }).ok, true)
})

test('a CLI bot names its model by id alone; DSH still requires provider + model', () => {
  assert.equal(validateBot(baseBot({ backend: 'claude', model: { model: 'claude-sonnet-4-5' } })).ok, true)
  assert.equal(validateBot(baseBot({ model: { model: 'deepseek-v4' } })).ok, false)
  assert.equal(validateBot(baseBot({ model: { provider: 'deepseek', model: 'deepseek-v4' } })).ok, true)
  assert.equal(validateBot(baseBot({ model: { provider: '', model: 'deepseek-v4' } })).ok, false)
})

test('validateBot reports the v3 codes only: capability and evidence codes are gone', () => {
  const cases = [
    [{ id: 'DSH_Dev', name: 'x', backend: 'dsh' }, 'BOT_ID_INVALID'],
    [{ id: 'no-name', backend: 'dsh' }, 'BOT_SCHEMA_INVALID'],
    [{ id: 'no-backend', name: 'x' }, 'BOT_SCHEMA_INVALID'],
    [baseBot({ backend: 'gemini' }), 'BOT_SCHEMA_INVALID'],
    [baseBot({ model: { provider: 'deepseek' } }), 'BOT_SCHEMA_INVALID'],
    // DSH 通过宿主 provider 走模型，成对是硬要求；CLI 只认模型 id（executor 用 `--model`）。
    [baseBot({ model: { model: 'deepseek-v4' } }), 'BOT_SCHEMA_INVALID'],
    [baseBot({ backend: 'claude', model: { provider: 'p' } }), 'BOT_SCHEMA_INVALID'],
    [baseBot({ model: { provider: 'p', model: 'm', reasoningEffort: 'turbo' } }), 'BOT_EFFORT_UNSUPPORTED'],
    // preset 是 dsh 专属：换后端就得自己用 BackendSession 表达。
    [baseBot({ preset: 'creator', backend: 'claude' }), 'BOT_PRESET_UNKNOWN'],
    [baseBot({ skills: { policy: 'preset' } }), 'BOT_SKILLS_PRESET_MISSING'],
    [baseBot({ prompt: { role: 'R'.repeat(2001) } }), 'BOT_PROMPT_INVALID'],
    [baseBot({ budget: { timeoutMs: 1000 } }), 'BOT_BUDGET_INVALID'],
    [baseBot({ budget: { maxRepairRounds: 7 } }), 'BOT_BUDGET_INVALID'],
    [baseBot({ budget: { idleTimeoutMs: 1 } }), 'BOT_BUDGET_INVALID'],
  ]
  for (const [bot, code] of cases) assert.equal(validateBot(bot).code, code, JSON.stringify(bot))
  assert.equal(validateBot(baseBot(), { backendEnabled: false }).code, 'BOT_BACKEND_DISABLED')
  // requires / tools / prompt.must 已被 sortBot 丢弃，不再触发任何 REQUIRES/CAPABILITY 错误。
  assert.equal(validateBot({
    id: 'legacy-bot', name: '旧 Bot', backend: 'dsh',
    requires: ['deploy'], tools: { deny: ['present'] }, prompt: { must: ['先读文档'] },
  }).ok, true)
})

test('§9.3: save-time validation uses the host catalogues when they are supplied', () => {
  const base = { id: 'tuned-bot', name: '调优', backend: 'dsh' }
  const presets = ['standard', 'planner']
  assert.equal(validateBot({ ...base, preset: 'ghost' }, { presets }).code, 'BOT_PRESET_UNKNOWN')
  assert.equal(validateBot({ ...base, preset: 'planner' }, { presets }).ok, true)
  assert.equal(validateBot({ ...base, preset: 'planner' }, { presetKnown: false }).code, 'BOT_PRESET_UNKNOWN')

  const model = { provider: 'deepseek', model: 'deepseek-chat' }
  const efforts = { 'deepseek/deepseek-chat': ['low', 'medium'] }
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'high' } }, { efforts }).code,
    'BOT_EFFORT_UNSUPPORTED')
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'medium' } }, { efforts }).ok, true)
  // auto 永远不查目录：不是每个后端都有 effort 旋钮。
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'auto' } }, { efforts }).ok, true)
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'high' } }, { effortSupported: false }).code,
    'BOT_EFFORT_UNSUPPORTED')
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'auto' } }, { effortSupported: false }).ok, true)
})

test('normalizeBots drops non-objects, missing ids and duplicates, and merges dropped keys', () => {
  const { bots, droppedKeys, warnings } = normalizeBots([
    null,
    { name: '缺 id' },
    baseBot({ id: 'DUP' }),
    baseBot({ id: 'dup', name: '后一条' }),
    baseBot({ id: 'team-bot', tools: { deny: [] }, stages: [{}] }),
  ])
  assert.deepEqual(bots.map(bot => bot.id), ['dup', 'team-bot'])
  assert.equal(bots[0].name, 'DSH 开发')
  assert.deepEqual(droppedKeys, ['tools', 'stages'])
  assert.ok(warnings.some(line => line.includes('必须是对象')))
  assert.ok(warnings.some(line => line.includes('缺少 id')))
  assert.ok(warnings.some(line => line.includes('重复')))
})

test('a retired stages declaration loads and is dropped by normalization', () => {
  // 分期执行已退场；老库里留着 stages 的文件必须还能读（键丢掉，不报错）。
  const { bots, droppedKeys } = normalizeBots([{ id: 'staged-bot', name: '分阶段', backend: 'dsh',
    stages: [{ stage: 'implement' }, { stage: 'gates' }] }])
  assert.equal(bots[0].stages, undefined)
  assert.ok(droppedKeys.includes('stages'))
  assert.equal(validateBot(bots[0]).ok, true)
})

test('paramsOfBot exposes exactly the execution parameters and drops an incomplete model pair', () => {
  assert.deepEqual(paramsOfBot({
    id: 'p-bot', name: 'p', backend: 'dsh', preset: 'creator',
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'low' },
    budget: { timeoutMs: 60_000, maxRepairRounds: 0 },
  }), {
    preset: 'creator', model: { provider: 'deepseek', model: 'deepseek-chat' }, reasoningEffort: 'low',
    budget: { timeoutMs: 60_000, idleTimeoutMs: undefined, maxRepairRounds: 0 },
  })
  // A CLI model needs no provider: the executor passes `.model` straight to `--model`.
  assert.deepEqual(paramsOfBot({ id: 'q-bot', name: 'q', backend: 'claude', model: { model: 'sonnet' } }), {
    preset: undefined, model: { model: 'sonnet' }, reasoningEffort: undefined,
    budget: { timeoutMs: undefined, idleTimeoutMs: undefined, maxRepairRounds: undefined },
  })
  // reasoningEffort 不进模型对；provider-only is not a declared model.
  assert.deepEqual(paramsOfBot({ id: 'r-bot', name: 'r', backend: 'claude', model: { provider: 'p' } }), {
    preset: undefined, model: undefined, reasoningEffort: undefined,
    budget: { timeoutMs: undefined, idleTimeoutMs: undefined, maxRepairRounds: undefined },
  })
})

test('resolveBot carries the execution facts only and lets the bot budget win over executor defaults', () => {
  const bot = baseBot({
    description: '改代码', whenToUse: '仓库里的实现任务', preset: 'creator',
    prompt: { role: '只改目标仓库' }, skills: { prefer: ['ponytail', 'caveman'] },
    model: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'high' },
    budget: { timeoutMs: 900_000, idleTimeoutMs: 120_000, maxRepairRounds: 4 },
  })
  const resolved = resolveBot(bot, {
    denyTools: ['present', 'ask_user_question', 'present'], preset: 'standard', timeoutMs: 1_500_000,
    idleTimeoutMs: 300_000, maxRepairRounds: 2, readOnly: true, capabilities: ['edit', 'exec'],
  })
  assert.deepEqual(resolved, {
    id: 'dsh-dev', backend: 'dsh', model: { provider: 'deepseek', model: 'deepseek-chat' },
    // Bot 自己的 preset 赢过上下文里的默认值。
    preset: 'creator',
    // 调用方的硬黑名单只增不减，重复项并掉。
    denyTools: ['present', 'ask_user_question'], readOnly: true,
    systemPromptExtra: { role: '只改目标仓库', skills: ['ponytail', 'caveman'] },
    budget: { timeoutMs: 900_000, idleTimeoutMs: 120_000, maxRepairRounds: 4 },
  })
  // 契约收窄后的形状本身是断言的一部分：capability / allowMcp / reasoningEffort 都不从这里出去。
  assert.deepEqual(Object.keys(resolved).sort(),
    ['backend', 'budget', 'denyTools', 'id', 'model', 'preset', 'readOnly', 'systemPromptExtra'])

  // 没有 prompt / skills 的 Bot 不编造段落；readOnly 只认真正的 true。
  const bare = resolveBot({ id: 'bare-bot', name: '裸 Bot', backend: 'claude' }, { readOnly: 'true', preset: 'standard' })
  assert.deepEqual(bare, {
    id: 'bare-bot', backend: 'claude', model: undefined, preset: 'standard', denyTools: [], readOnly: false,
    systemPromptExtra: { role: '', skills: [] },
    budget: { timeoutMs: undefined, idleTimeoutMs: undefined, maxRepairRounds: undefined },
  })
  // 上下文只填 Bot 没声明的预算字段（maxRepairRounds: 0 是有效值，不能被当成没填）。
  const fromContext = resolveBot({ id: 'quiet-bot', name: 'q', backend: 'dsh', budget: { maxRepairRounds: 0 } },
    { timeoutMs: 1_500_000, idleTimeoutMs: 300_000, maxRepairRounds: 3 })
  assert.deepEqual(fromContext.budget, { timeoutMs: 1_500_000, idleTimeoutMs: 300_000, maxRepairRounds: 0 })
  // systemPromptExtra 是副本：运行时改它不能改掉 Bot 定义。
  resolved.systemPromptExtra.skills.push('extra')
  assert.deepEqual(bot.skills.prefer, ['ponytail', 'caveman'])
})

test('botsFileOf accepts only a bare filename (I7: no repo-controlled path)', () => {
  assert.equal(botsFileOf({}).name, BOT_FILE_NAME)
  assert.equal(botsFileOf({ executor: { botsFile: 'team.json' } }).name, 'team.json')
  assert.ok(botsFileOf({ executor: { botsFile: '../worker-bots.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'sub/dir.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: '.hidden' } }).error)
  // 裸文件名仍可能撞上状态文件：把 Bot 写进 live.json 就等于改配置和工单。
  assert.equal(botsFileOf({ executor: { botsFile: 'worker-bots.json' } }).name, 'worker-bots.json')
  assert.ok(botsFileOf({ executor: { botsFile: 'live.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'LIVE.JSON' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'live-state.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'gitlab.token' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'octo.token' } }).error)
  assert.equal(botsFileOf({ executor: { botsFile: 'bots.json' } }).name, 'bots.json')
})

test('canonicalJson sorts keys, drops undefined and is stable across key orders', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
  assert.match(digestOf({ a: 1 }), /^[a-f0-9]{64}$/)
})

test('botsDigest is stable across key order but not across array order (dispatch cache key)', () => {
  const other = baseBot({ id: 'other-bot', name: '另一个', backend: 'claude' })
  assert.equal(botsDigest([baseBot()]), botsDigest([sortBot(baseBot())]))
  assert.notEqual(botsDigest([baseBot(), other]), botsDigest([other, baseBot()]))
})

test('parseBotsDocument marks v2 as migrated and v3 as current', () => {
  const v2 = parseBotsDocument({ version: 2, bots: [{ id: 'team-bot', name: '团队 Bot', backend: 'dsh' }], extra: true })
  assert.equal(v2.migrated, true)
  assert.equal(v2.version, 2)
  assert.equal(v2.code, undefined)
  assert.deepEqual(v2.bots.map(bot => bot.id), ['team-bot'])
  assert.deepEqual(v2.droppedKeys, ['extra'])
  const v3 = parseBotsDocument({ version: 3, bots: [] })
  assert.equal(v3.migrated, false)
  assert.equal(v3.version, 3)
  assert.equal(v3.code, undefined)
})

test('parseBotsDocument refuses corrupt, v1 and future files, and ignores built-in ids in the file', () => {
  assert.equal(parseBotsDocument([]).code, 'BOT_FILE_CORRUPT')
  assert.equal(parseBotsDocument({ bots: [] }).code, 'BOT_FILE_CORRUPT')
  const v1 = parseBotsDocument({ version: 1, bots: [] })
  assert.equal(v1.code, 'BOT_FILE_VERSION_UNSUPPORTED')
  assert.match(v1.error, /worker-bots\.json/)
  assert.match(v1.error, /改名/)
  const future = parseBotsDocument({ version: 4, bots: [] })
  assert.equal(future.code, 'BOT_FILE_VERSION_UNSUPPORTED')
  assert.match(future.error, /升级插件/)

  // 文件里写着内置 id：不覆盖内置定义，只报警并跳过（内置只由代码定义）。
  const withBuiltin = parseBotsDocument({ version: 3, bots: [
    { id: 'generalist', name: '想改内置', backend: 'dsh' },
    { id: 'team-bot', name: '团队 Bot', backend: 'dsh' },
    { id: 'broken-bot', name: '坏 Bot', backend: 'gemini' },
  ] })
  assert.deepEqual(withBuiltin.bots.map(bot => bot.id), ['team-bot'])
  assert.ok(withBuiltin.warnings.some(line => line.includes('内置 Bot 不可编辑')))
  assert.ok(withBuiltin.warnings.some(line => line.includes('BOT_SCHEMA_INVALID')))
})

test('parseBotsDocument caps the file at BOT_LIMITS.bots', () => {
  const bots = Array.from({ length: BOT_LIMITS.bots + 1 }, (_, index) => (
    { id: `bot-${index}`, name: `Bot ${index}`, backend: 'dsh' }))
  const parsed = parseBotsDocument({ version: 3, bots })
  assert.equal(parsed.bots.length, BOT_LIMITS.bots)
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0], new RegExp(`最多 ${BOT_LIMITS.bots} 个`))
})

test('readBots: no state dir or no file means built-ins, not an error', () => {
  assert.deepEqual(readBots(undefined, {}).bots.map(bot => bot.id), BUILTIN_BOT_IDS)
  assert.equal(readBots(undefined, {}).builtin, true)
  assert.equal(readBots(undefined, {}).legacy, false)
  const missing = readBots('/tmp/does-not-exist-superagent', {})
  assert.equal(missing.exists, false)
  assert.equal(missing.builtin, true)
  assert.equal(missing.code, undefined)
  assert.deepEqual(missing.bots.map(bot => bot.id), BUILTIN_BOT_IDS)
})

test('readBots flags a v2 file as legacy and merges valid custom bots over the built-ins', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, BOT_FILE_NAME), JSON.stringify({ version: 2, bots: [
      { id: 'team-bot', name: '团队 Bot', whenToUse: '团队任务', backend: 'dsh', requires: ['edit'] },
      { id: 'broken-bot', name: '坏 Bot', backend: 'gemini' },
    ] }))
    const book = readBots(dir, {})
    assert.equal(book.code, undefined)
    assert.equal(book.version, 2)
    // legacy 是「引擎该迁移了」的信号，读出来的 Bot 已经可用。
    assert.equal(book.legacy, true)
    assert.deepEqual(book.bots.map(bot => bot.id), [...BUILTIN_BOT_IDS, 'team-bot'])
    assert.deepEqual(book.droppedKeys, ['requires'])
    assert.ok(book.warnings.some(line => line.includes('broken-bot')))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBots refuses a corrupt or unsupported file instead of silently falling back', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, BOT_FILE_NAME)
    await writeFile(file, '{ not json')
    const corrupt = readBots(dir, {})
    assert.equal(corrupt.code, 'BOT_FILE_CORRUPT')
    assert.equal(corrupt.exists, true)
    assert.equal(corrupt.builtin, false)
    // 拒绝时不给内置：派单看到 code 就停，而不是假装「只有内置可用」（I2）。
    assert.deepEqual(corrupt.bots, [])
    assert.deepEqual(readBots(dir, {}).bots, [])
    await writeFile(file, JSON.stringify({ version: 9, bots: [] }))
    const future = readBots(dir, {})
    assert.equal(future.code, 'BOT_FILE_VERSION_UNSUPPORTED')
    assert.match(future.error, /升级/)
    assert.deepEqual(future.bots, [])
    // version 1 是旧的「档位」文件：拒绝并提示改名，而不是当成 Bot 文件读。
    await writeFile(file, JSON.stringify({ version: 1, bots: [] }))
    const legacyFile = readBots(dir, {})
    assert.equal(legacyFile.code, 'BOT_FILE_VERSION_UNSUPPORTED')
    assert.match(legacyFile.error, /worker-bots\.json/)
    // 一个空的 v3 文件是能用的库。
    await writeFile(file, JSON.stringify({ version: 3, bots: [] }))
    const empty = readBots(dir, {})
    assert.equal(empty.code, undefined)
    assert.equal(empty.legacy, false)
    assert.deepEqual(empty.bots.map(bot => bot.id), BUILTIN_BOT_IDS)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeBots persists a 0600 v3 document with a trailing newline and round-trips it', async () => {
  const dir = await tempDir()
  try {
    // id 大小写归一化是保存的一部分：面板传来的 'DSH-Dev' 和小写的 'dsh-dev' 是同一个 Bot。
    const written = await writeBots(dir, {}, { bots: [baseBot({ id: 'DSH-Dev' })] })
    const expected = { version: 3, bots: [{ id: 'dsh-dev', name: 'DSH 开发', backend: 'dsh' }] }
    assert.deepEqual(written, { ...expected, file: join(dir, BOT_FILE_NAME) })
    const raw = await readFile(join(dir, BOT_FILE_NAME), 'utf8')
    assert.equal(raw, `${JSON.stringify(expected, undefined, 2)}\n`)
    // 0600：Bot 定义带着模型与 prompt，不该让同机其他用户读。
    assert.equal((await stat(join(dir, BOT_FILE_NAME))).mode & 0o777, 0o600)
    const book = readBots(dir, {})
    assert.equal(book.version, 3)
    assert.equal(book.legacy, false)
    assert.deepEqual(book.bots.map(bot => bot.id), [...BUILTIN_BOT_IDS, 'dsh-dev'])
    // 覆盖写也成功：同一个库可以反复保存。
    await writeBots(dir, {}, { bots: [] })
    assert.deepEqual(readBots(dir, {}).bots.map(bot => bot.id), BUILTIN_BOT_IDS)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeBots rejects over-limit text, unknown keys, built-in ids, duplicates and path-like filenames', async () => {
  const dir = await tempDir()
  try {
    await assert.rejects(writeBots(dir, {}, { bots: [baseBot({ description: 'D'.repeat(121) })] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('超出上限'))
    await assert.rejects(writeBots(dir, {}, { bots: [{ ...baseBot(), extra: true }] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('未知字段'))
    await assert.rejects(writeBots(dir, {}, { bots: [{ id: 'generalist', name: '通用', backend: 'dsh' }] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('内置 Bot'))
    await assert.rejects(writeBots(dir, {}, { bots: [baseBot({ id: 'aa' }), baseBot({ id: 'AA' })] }),
      error => error.code === 'BOT_DUPLICATE_ID')
    await assert.rejects(writeBots(dir, {}, { bots: [baseBot({ budget: { timeoutMs: 1 } })] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('BOT_BUDGET_INVALID'))
    await assert.rejects(writeBots(dir, { executor: { botsFile: '../x.json' } }, { bots: [] }),
      error => error.code === 'BOT_FILE_INVALID')
    // 拒绝时不落文件：失败的保存不能留下半份库。
    await assert.rejects(readFile(join(dir, BOT_FILE_NAME), 'utf8'), { code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 一个库可以给多个后端存 Bot：每个只按自己后端的现场校验，claude 的禁用不能被 dsh 的证据救回来。
test('writeBots validates each bot against its own backend environment', async () => {
  const dir = await tempDir()
  try {
    await assert.rejects(writeBots(dir, {}, {
      bots: [baseBot({ backend: 'claude' })],
      environments: { dsh: { backendEnabled: true }, claude: { backendEnabled: false } },
    }), error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('BOT_BACKEND_DISABLED'))
    const written = await writeBots(dir, {}, {
      bots: [baseBot()], environments: { dsh: { backendEnabled: true, presets: ['standard'] } },
    })
    assert.deepEqual(written.bots.map(bot => bot.id), ['dsh-dev'])
    // 宿主目录同样是保存闸门：不在目录里的 preset 存不进去。
    await assert.rejects(writeBots(dir, {}, { bots: [baseBot({ preset: 'ghost' })], presets: ['standard'] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('BOT_PRESET_UNKNOWN'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migrateBots backs a v2 file up, rewrites it as v3 and never migrates twice', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, BOT_FILE_NAME)
    const before = JSON.stringify({ version: 2, bots: [
      { id: 'generalist', name: '文件里的通用', backend: 'dsh' },
      { id: 'team-bot', name: '团队 Bot', whenToUse: '团队任务', backend: 'dsh', requires: ['edit'] },
    ] })
    await writeFile(file, before)
    const result = await migrateBots(dir, {})
    assert.equal(result.migrated, true)
    assert.equal(result.backup, `${file}.bak`)
    // .bak 是迁移前那一份（原样拷贝），回滚靠它。
    assert.equal(await readFile(`${file}.bak`, 'utf8'), before)
    const rewritten = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(rewritten.version, 3)
    // 内置定义不落文件：文件里只有运营自建的 Bot。
    assert.deepEqual(rewritten.bots.map(bot => bot.id), ['team-bot'])
    const book = readBots(dir, {})
    assert.equal(book.version, 3)
    assert.equal(book.legacy, false)
    assert.deepEqual(book.bots.map(bot => bot.id), [...BUILTIN_BOT_IDS, 'team-bot'])
    // 幂等：第二次读到 v3 就什么都不做，也不再动 .bak。
    assert.deepEqual(await migrateBots(dir, {}), { migrated: false })
    assert.equal((await stat(`${file}.bak`)).size, Buffer.byteLength(before))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('migrateBots leaves the file alone when there is nothing safe to migrate', async () => {
  const dir = await tempDir()
  try {
    // 没有文件 → 内置就够用。
    assert.deepEqual(await migrateBots(dir, {}), { migrated: false })
    const file = join(dir, BOT_FILE_NAME)
    // 版本太新：不动盘，也不写 .bak（不替用户做决定）。
    await writeFile(file, JSON.stringify({ version: 4, bots: [] }))
    assert.deepEqual(await migrateBots(dir, {}), { migrated: false })
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 4)
    await assert.rejects(readFile(`${file}.bak`, 'utf8'), { code: 'ENOENT' })
    // 坏 JSON 同理：先修文件，不猜。
    await writeFile(file, '{ not json')
    assert.deepEqual(await migrateBots(dir, {}), { migrated: false })
    assert.equal(await readFile(file, 'utf8'), '{ not json')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// 注意：v2 里的非法 Bot 在 readBots 阶段就被 validateBot 过滤掉了，migrateBots 再校验的是同一批「已通过」的
// Bot，所以「校验失败就拒绝迁移」这条分支实际走不到。这里断言真实行为：迁移成功，非法 Bot 只留在 .bak 里。
// （拒绝能力本身在 writeBots 上仍然有效，见下方第二个断言。）
test('a v2 file with an invalid bot still migrates; its .bak is the only copy of that bot', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, BOT_FILE_NAME)
    await writeFile(file, JSON.stringify({ version: 2, bots: [
      { id: 'good-bot', name: '好 Bot', backend: 'dsh' },
      { id: 'broken-bot', name: '坏 Bot', backend: 'dsh', budget: { timeoutMs: 1 } },
    ] }))
    const result = await migrateBots(dir, {})
    assert.equal(result.migrated, true)
    assert.ok(result.warnings.some(line => line.includes('BOT_BUDGET_INVALID')))
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).bots.map(bot => bot.id), ['good-bot'])
    assert.deepEqual(JSON.parse(await readFile(`${file}.bak`, 'utf8')).bots.map(bot => bot.id),
      ['good-bot', 'broken-bot'])
    await assert.rejects(writeBots(dir, {}, {
      bots: [{ id: 'broken-bot', name: '坏 Bot', backend: 'dsh', budget: { timeoutMs: 1 } }],
    }), error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('BOT_BUDGET_INVALID'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
