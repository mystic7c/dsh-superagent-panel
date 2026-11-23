import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_BOT_IDS, DEFAULT_BOT_ID, BOT_FILE_NAME, builtinBots, canonicalJson, capabilitiesOf,
  digestOf, isBuiltinBot, normalizeBots, paramsOfBot, parseBotsDocument, botsDigest, botsFileOf,
  readBots, resolveBot, sortBot, synthesizeBot, validateBot, writeBots,
} from './worker-bot.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'superagent-bots-'))
}

function baseBot(overrides = {}) {
  return { id: 'dsh-dev', name: 'DSH 开发', backend: 'dsh', requires: ['edit', 'exec'], ...overrides }
}

test('built-ins are the three documented bots and cannot be mutated by callers', () => {
  assert.deepEqual(BUILTIN_BOT_IDS, ['generalist', 'surgical', 'reviewer'])
  const bots = builtinBots()
  assert.deepEqual(bots.map(bot => bot.id), ['generalist', 'surgical', 'reviewer'])
  assert.deepEqual(bots[1].stages, ['implement', 'gates'])
  assert.equal(bots[0].backend, 'dsh')
  bots[0].requires.push('web')
  assert.deepEqual(builtinBots()[0].requires, ['edit', 'exec'])
  assert.equal(isBuiltinBot('generalist'), true)
  assert.equal(isBuiltinBot('custom'), false)
  assert.equal(DEFAULT_BOT_ID, 'generalist')
})

test('canonicalJson sorts keys, drops undefined and is stable across key orders', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
  assert.match(digestOf({ a: 1 }), /^[a-f0-9]{64}$/)
})

test('normalizeBots keeps known keys, reports unknown ones and lowercases identifiers', () => {
  const { bots, droppedKeys, truncated, warnings } = normalizeBots([{
    ID: 'ignored',
    id: ' DSH-Dev ',
    name: ' DSH 开发 ',
    backend: 'DSH',
    model: { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'HIGH', temperature: 1 },
    requires: ['edit', 'Edit', 'exec'],
    tools: { deny: ['present', 'present'], regex: 'x' },
    skills: { policy: 'Prompt', prefer: ['ponytail'] },
    budget: { timeoutMs: 900_000, gateTimeoutMs: 1 },
    unknown: true,
  }])
  assert.equal(warnings.length, 0)
  assert.deepEqual(droppedKeys.sort(), ['ID', 'budget.gateTimeoutMs', 'model.temperature', 'tools.regex', 'unknown'])
  assert.deepEqual(truncated, [])
  const bot = bots[0]
  assert.equal(bot.id, 'dsh-dev')
  assert.equal(bot.name, 'DSH 开发')
  assert.equal(bot.backend, 'dsh')
  assert.deepEqual(bot.requires, ['edit', 'exec'])
  assert.deepEqual(bot.tools.deny, ['present'])
  assert.equal(bot.skills.policy, 'prompt')
  assert.deepEqual(bot.model, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
  assert.deepEqual(bot.budget, { timeoutMs: 900_000 })
  // Stable key order for configDigest reproducibility.
  assert.deepEqual(Object.keys(bot), ['id', 'name', 'backend', 'model', 'requires', 'tools', 'skills', 'budget'])
})

test('normalizeBots drops non-objects, duplicate ids and truncates over-limit arrays', () => {
  const { bots, truncated, warnings } = normalizeBots([
    null,
    { name: '缺 id' },
    baseBot({ id: 'dup' }),
    baseBot({ id: 'dup' }),
    baseBot({ id: 'many', requires: ['edit', 'exec', 'web', 'edit'], tools: { deny: Array.from({ length: 40 }, (_, i) => `t${i}`) } }),
  ])
  assert.deepEqual(bots.map(bot => bot.id), ['dup', 'many'])
  assert.ok(warnings.some(line => line.includes('必须是对象')))
  assert.ok(warnings.some(line => line.includes('缺少 id')))
  assert.ok(warnings.some(line => line.includes('重复')))
  assert.ok(truncated.includes('tools.deny'))
})

test('validateBot accepts the built-ins and reports the documented error codes', () => {
  for (const bot of builtinBots()) {
    const result = validateBot(bot)
    assert.equal(result.ok, true, bot.id)
  }
  const cases = [
    [{ id: 'A' }, 'BOT_ID_INVALID'],
    [{ id: 'ok', name: '' }, 'BOT_SCHEMA_INVALID'],
    [baseBot({ backend: 'gemini' }), 'BOT_SCHEMA_INVALID'],
    [baseBot({ requires: ['report'] }), 'BOT_REQUIRES_NOT_CAPABILITY'],
    [baseBot({ requires: ['deploy'] }), 'BOT_REQUIRES_UNKNOWN'],
    [baseBot({ preset: 'creator', backend: 'claude' }), 'BOT_PRESET_UNKNOWN'],
    [baseBot({ skills: { policy: 'preset' } }), 'BOT_SKILLS_PRESET_MISSING'],
    [baseBot({ budget: { timeoutMs: 1000 } }), 'BOT_BUDGET_INVALID'],
    [baseBot({ stages: ['plan', 'gates', 'review'] }), 'BOT_STAGES_INVALID'],
    [baseBot({ stages: ['assess', 'plan', 'review'] }), 'BOT_STAGES_INVALID'],
    [baseBot({ stages: ['github', 'implement', 'gates'] }), 'BOT_STAGES_INVALID'],
    [baseBot({ stages: ['review', 'implement', 'gates'] }), 'BOT_STAGES_INVALID'],
    [baseBot({ stages: ['implement'] }), 'BOT_STAGES_INVALID'],
    [baseBot({ model: { provider: 'p' } }), 'BOT_SCHEMA_INVALID'],
    [baseBot({ model: { provider: 'p', model: 'm', reasoningEffort: 'turbo' } }), 'BOT_EFFORT_UNSUPPORTED'],
    [baseBot({ prompt: { must: ['x'.repeat(201)] } }), 'BOT_PROMPT_INVALID'],
  ]
  for (const [bot, code] of cases) {
    const result = validateBot(bot)
    assert.equal(result.ok, false, code)
    assert.equal(result.code, code, JSON.stringify(bot))
  }
})

test('validateBot checks the runtime environment: unverified/stale/disabled/gap/preset/effort', () => {
  const verifiedDsh = { backendState: 'verified', backendEnabled: true, capabilities: { edit: true, exec: true, web: false } }
  assert.equal(validateBot(baseBot(), verifiedDsh).ok, true)
  assert.equal(validateBot(baseBot({ requires: ['web'] }), verifiedDsh).code, 'BOT_CAPABILITY_GAP')
  assert.deepEqual(validateBot(baseBot({ requires: ['web'] }), verifiedDsh).missing, ['web'])
  assert.equal(validateBot(baseBot(), { backendState: 'unverified' }).code, 'BOT_BACKEND_UNVERIFIED')
  assert.equal(validateBot(baseBot(), { backendState: 'stale' }).code, 'BOT_BACKEND_STALE')
  assert.equal(validateBot(baseBot(), { backendEnabled: false }).code, 'BOT_BACKEND_DISABLED')
  assert.equal(validateBot(baseBot({ preset: 'creator' }), { presetKnown: false }).code, 'BOT_PRESET_UNKNOWN')
  assert.equal(validateBot(baseBot({ model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    { effortSupported: false }).code, 'BOT_EFFORT_UNSUPPORTED')
  // auto never fails on a backend that has no effort knob.
  assert.equal(validateBot(baseBot({ model: { provider: 'p', model: 'm', reasoningEffort: 'auto' } }),
    { effortSupported: false }).ok, true)
})

test('capabilitiesOf only trusts verified capabilities', () => {
  // A declared capability without an `unverified` entry is verified.
  assert.deepEqual(capabilitiesOf({ capabilities: { edit: true, exec: true, web: true } }), { edit: true, exec: true, web: true })
  assert.deepEqual(capabilitiesOf({
    capabilities: { edit: true, exec: true, web: true },
    unverified: ['web'],
  }), { edit: true, exec: true, web: false })
  assert.deepEqual(capabilitiesOf({ capabilities: { edit: true }, unverified: [] }), { edit: true, exec: false, web: false })
  // A fallback probe declares everything but is all unverified, so it grants nothing.
  assert.deepEqual(capabilitiesOf({ capabilities: { edit: true, exec: true, web: true },
    unverified: ['edit', 'exec', 'web'], source: 'fallback' }), { edit: false, exec: false, web: false })
})

test('paramsOfBot drops an incomplete model pair and exposes nothing it does not know', () => {
  assert.deepEqual(paramsOfBot({ id: 'x', backend: 'dsh', model: { provider: 'p' } }), {
    preset: undefined, model: undefined, reasoningEffort: undefined, denyTools: undefined, allowMcp: undefined,
    budget: { timeoutMs: undefined, idleTimeoutMs: undefined, maxRepairRounds: undefined }, stages: undefined,
  })
})

test('resolveBot stacks deny tools and lets the bot budget win over executor defaults', () => {
  const bot = baseBot({
    preset: 'creator',
    tools: { deny: ['present', 'workflow'], allowMcp: ['gitlab'] },
    prompt: { role: '只改目标仓库', must: ['先跑单测'] },
    skills: { prefer: ['ponytail'] },
    budget: { timeoutMs: 900_000, maxRepairRounds: 4 },
    stages: ['implement', 'gates'],
  })
  const resolved = resolveBot(bot, {
    denyTools: ['ask_user_question', 'present'], preset: 'standard', timeoutMs: 1_500_000,
    idleTimeoutMs: 300_000, maxRepairRounds: 2, readOnly: true, capabilities: ['edit', 'exec'],
  })
  assert.equal(resolved.id, 'dsh-dev')
  assert.equal(resolved.preset, 'creator')
  // The hard blacklist is a union: a bot can only add, never remove (§4.3).
  assert.deepEqual(resolved.denyTools, ['ask_user_question', 'present', 'workflow'])
  assert.deepEqual(resolved.allowMcp, ['gitlab'])
  assert.equal(resolved.readOnly, true)
  assert.deepEqual(resolved.budget, { timeoutMs: 900_000, idleTimeoutMs: 300_000, maxRepairRounds: 4 })
  assert.deepEqual(resolved.stages, ['implement', 'gates'])
  assert.deepEqual(resolved.systemPromptExtra, { role: '只改目标仓库', must: ['先跑单测'], skills: ['ponytail'] })
  assert.deepEqual(resolved.capability, ['edit', 'exec'])
})

test('synthesizeBot is deterministic, picks the first backend that covers the requirement set and refuses gaps', () => {
  const capabilities = { dsh: { edit: true, exec: true, web: false }, claude: { edit: true, exec: false, web: false } }
  const first = synthesizeBot({ requires: ['exec', 'edit'], deliverable: 'change', capabilities: capabilities.dsh })
  const second = synthesizeBot({ requires: ['edit', 'exec', 'edit'], deliverable: 'change', capabilities: capabilities.dsh })
  assert.equal(first.id, second.id)
  assert.match(first.id, /^adhoc:[a-f0-9]{8}$/)
  assert.equal(first.backend, 'dsh')
  assert.deepEqual(first.requires, ['edit', 'exec'])
  assert.equal(BOT_FILE_NAME, 'worker-bots.json')
  // A report deliverable needs no capability at all; the first enabled backend is fine.
  assert.deepEqual(synthesizeBot({ deliverable: 'report', capabilities: capabilities.dsh }).requires, [])
  // Nothing covers exec on claude, so the next backend in the order is chosen; with none left: null.
  assert.equal(synthesizeBot({ requires: ['exec'], capabilities: capabilities.claude,
    backendOrder: ['claude'] }), null)
  assert.equal(synthesizeBot({ requires: ['exec'], capabilities: { edit: true, exec: false, web: false },
    backendOrder: ['claude', 'dsh'] }), null)
  // Per-backend map: claude cannot exec, so the order skips it for dsh.
  const byBackend = { claude: { edit: true, exec: false, web: false }, dsh: { edit: true, exec: true, web: false } }
  assert.equal(synthesizeBot({ requires: ['exec'], capabilities: byBackend,
    backendOrder: ['claude', 'dsh'] }).backend, 'dsh')
  assert.equal(synthesizeBot({ requires: ['edit'], capabilities: byBackend,
    backendOrder: ['claude', 'dsh'] }).backend, 'claude')
  // A different role prefix is a different transient bot.
  assert.notEqual(synthesizeBot({ requires: ['edit'], capabilities: capabilities.dsh, role: '只读复核' }).id, first.id)
})

test('botsFileOf accepts only a bare filename (I7: no repo-controlled path)', () => {
  assert.equal(botsFileOf({}).name, BOT_FILE_NAME)
  assert.equal(botsFileOf({ executor: { botsFile: 'team.json' } }).name, 'team.json')
  assert.ok(botsFileOf({ executor: { botsFile: '../worker-bots.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'sub/dir.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: '.hidden' } }).error)
  // A bare filename could still name a state file: writing bots to live.json replaced the config and the tickets.
  // Its own default name stays the one legitimate occupant of the state directory.
  assert.equal(botsFileOf({ executor: { botsFile: 'worker-bots.json' } }).name, 'worker-bots.json')
  assert.ok(botsFileOf({ executor: { botsFile: 'live.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'LIVE.JSON' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'live-state.json' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'gitlab.token' } }).error)
  assert.ok(botsFileOf({ executor: { botsFile: 'octo.token' } }).error)
  assert.equal(botsFileOf({ executor: { botsFile: 'bots.json' } }).name, 'bots.json')
})

test('readBots: missing file or no state dir means built-ins, not an error', () => {
  assert.deepEqual(readBots(undefined, {}).bots.map(bot => bot.id), BUILTIN_BOT_IDS)
  assert.equal(readBots('/tmp/does-not-exist-superagent', {}).code, undefined)
  assert.equal(readBots('/tmp/does-not-exist-superagent', {}).exists, false)
  assert.equal(readBots('/tmp/does-not-exist-superagent', {}).builtin, true)
})

test('readBots keeps usable bots, drops invalid ones and reports dropped keys', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, BOT_FILE_NAME), JSON.stringify({
      version: 2,
      bots: [
        { id: 'team', name: '团队', backend: 'dsh', requires: ['edit'], extra: 1 },
        { id: 'broken', name: '坏', backend: 'gemini' },
        { id: 'generalist', name: '想改内置', backend: 'dsh' },
      ],
    }))
    const book = readBots(dir, {})
    assert.deepEqual(book.bots.map(bot => bot.id), [...BUILTIN_BOT_IDS, 'team'])
    assert.deepEqual(book.droppedKeys, ['extra'])
    assert.ok(book.warnings.some(line => line.includes('broken')))
    assert.ok(book.warnings.some(line => line.includes('内置 Bot 不可编辑')))
    assert.equal(book.code, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readBots refuses a corrupt or future-versioned file instead of silently falling back', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, BOT_FILE_NAME)
    await writeFile(file, '{ not json')
    assert.equal(readBots(dir, {}).code, 'BOT_FILE_CORRUPT')
    // Refused, not silently replaced by the built-ins (I2).
    assert.deepEqual(readBots(dir, {}).bots, [])
    await writeFile(file, JSON.stringify({ version: 9, bots: [] }))
    const future = readBots(dir, {})
    assert.equal(future.code, 'BOT_FILE_VERSION_UNSUPPORTED')
    assert.match(future.error, /升级/)
    assert.deepEqual(future.bots, [])
    // The old 「档位」 file (version 1) is refused with a rename hint instead of being read as a Bot file (§4.6).
    await writeFile(file, JSON.stringify({ version: 1, bots: [] }))
    const legacy = readBots(dir, {})
    assert.equal(legacy.code, 'BOT_FILE_VERSION_UNSUPPORTED')
    assert.match(legacy.error, /worker-bots\.json/)
    assert.deepEqual(legacy.bots, [])
    // version 2 is current, so an empty file is a working (if empty) store.
    await writeFile(file, JSON.stringify({ version: 2, bots: [] }))
    assert.equal(readBots(dir, {}).code, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeBots validates, persists 0600 JSON and round-trips', async () => {
  const dir = await tempDir()
  try {
    const written = await writeBots(dir, {}, { bots: [baseBot()] })
    assert.deepEqual(written.bots.map(bot => bot.id), ['dsh-dev'])
    const raw = JSON.parse(await readFile(join(dir, BOT_FILE_NAME), 'utf8'))
    assert.deepEqual(raw, { version: 2, bots: [baseBot()] })
    const book = readBots(dir, {})
    assert.deepEqual(book.bots.map(bot => bot.id), [...BUILTIN_BOT_IDS, 'dsh-dev'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeBots rejects invalid bots, unknown keys, built-in ids and path-like filenames', async () => {
  const dir = await tempDir()
  try {
    await assert.rejects(writeBots(dir, {}, { bots: [baseBot({ requires: ['report'] })] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('BOT_REQUIRES_NOT_CAPABILITY'))
    await assert.rejects(writeBots(dir, {}, { bots: [{ ...baseBot(), extra: true }] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('未知字段'))
    await assert.rejects(writeBots(dir, {}, { bots: [{ id: 'generalist', name: '通用', backend: 'dsh' }] }),
      error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('内置 Bot'))
    await assert.rejects(writeBots(dir, {}, {
      bots: [baseBot({ id: 'aa' }), baseBot({ id: 'aa' })],
    }), error => error.code === 'BOT_DUPLICATE_ID')
    await assert.rejects(writeBots(dir, { executor: { botsFile: '../x.json' } }, { bots: [] }),
      error => error.code === 'BOT_FILE_INVALID')
    // AC-B1: a backend with no probe/smoke evidence cannot be saved as a bot.
    await assert.rejects(writeBots(dir, {}, {
      bots: [baseBot({ id: 'guest' })], environment: { backendState: 'unverified' },
    }), error => error.code === 'BOT_SCHEMA_INVALID' && error.problems[0].includes('BOT_BACKEND_UNVERIFIED'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A store can hold bots for several backends: each one is validated against its own backend's evidence, so an
// unverified claude bot must not be judged by (nor rescued by) the DSH probe.
test('writeBots validates each bot against its own backend environment', async () => {
  const dir = await tempDir()
  try {
    const bot = baseBot()
    await assert.rejects(writeBots(dir, {}, {
      bots: [{ ...bot, backend: 'claude' }],
      environments: { dsh: { backendState: 'verified' }, claude: { backendState: 'unverified' } },
    }), error => error.code === 'BOT_SCHEMA_INVALID'
      && error.problems[0].includes('BOT_BACKEND_UNVERIFIED'))
    const written = await writeBots(dir, {}, {
      bots: [bot], environments: { dsh: { backendState: 'verified', capabilities: { edit: true, exec: true } } },
    })
    assert.deepEqual(written.bots.map(item => item.id), ['dsh-dev'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('botsDigest is stable across key order so the dispatch cache key is reproducible', () => {
  const a = botsDigest([baseBot(), sortBot({ backend: 'dsh', name: '通用', id: 'generalist', requires: ['edit', 'exec'] })])
  const b = botsDigest([sortBot({ requires: ['edit', 'exec'], id: 'generalist', name: '通用', backend: 'dsh' }), baseBot()])
  assert.notEqual(a, b) // array order is part of the digest
  assert.equal(botsDigest([baseBot()]), botsDigest([sortBot(baseBot())]))
})

test('parseBotsDocument reports a missing version as corrupt', () => {
  assert.equal(parseBotsDocument({ bots: [] }).code, 'BOT_FILE_CORRUPT')
  assert.equal(parseBotsDocument([]).code, 'BOT_FILE_CORRUPT')
})

test('§9.3: save-time validation uses the host catalogues when they are supplied', () => {
  const base = { id: 'tuned', name: '调优', backend: 'dsh' }
  const verified = { backendState: 'verified', capabilities: { edit: true, exec: true, web: true } }

  const unknownPreset = validateBot({ ...base, preset: 'ghost' }, { ...verified, presets: ['standard', 'planner'] })
  assert.equal(unknownPreset.code, 'BOT_PRESET_UNKNOWN')
  assert.equal(validateBot({ ...base, preset: 'planner' }, { ...verified, presets: ['standard', 'planner'] }).ok, true)

  const model = { provider: 'deepseek', model: 'deepseek-chat' }
  const tooDeep = validateBot({ ...base, model: { ...model, reasoningEffort: 'high' } },
    { ...verified, efforts: { 'deepseek/deepseek-chat': ['low', 'medium'] } })
  assert.equal(tooDeep.code, 'BOT_EFFORT_UNSUPPORTED')
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'medium' } },
    { ...verified, efforts: { 'deepseek/deepseek-chat': ['low', 'medium'] } }).ok, true)
  // A model the host could not resolve makes no claim: the declaration passes, the panel shows no evidence either way.
  assert.equal(validateBot({ ...base, model: { ...model, reasoningEffort: 'high' } }, verified).ok, true)
})

test('§10.2: stage entries keep their stage-level bot and budget through normalization', () => {
  const [bot] = normalizeBots([{ id: 'staged', name: '分阶段', backend: 'dsh', requires: ['edit'],
    stages: [{ stage: 'implement' }, { stage: 'gates' }, { budget: { timeoutMs: 600000 }, stage: 'review', bot: 'rechecker' }] }]).bots
  assert.deepEqual(bot.stages, [{ stage: 'implement' }, { stage: 'gates' },
    { stage: 'review', bot: 'rechecker', budget: { timeoutMs: 600000 } }])
  // Stable key order inside a stage object keeps the file and the digest reproducible.
  assert.deepEqual(Object.keys(sortBot(bot).stages.at(-1)), ['stage', 'bot', 'budget'])
})

test('§10.2: stage validation refuses unknown bots, self references and out-of-range budgets', () => {
  const verified = { backendState: 'verified', capabilities: { edit: true, exec: true, web: true } }
  const base = { id: 'staged', name: '分阶段', backend: 'dsh', requires: ['edit'], stages: ['implement', 'gates', 'review'] }
  const withStages = stages => ({ ...base, stages })
  assert.equal(validateBot(withStages(['implement', 'gates', 'review']), verified).ok, true)
  assert.equal(validateBot(withStages(['implement', { stage: 'gates' }, { stage: 'review', bot: 'rechecker' }]),
    { ...verified, botIds: ['staged', 'rechecker'] }).ok, true)
  assert.equal(validateBot(withStages(['implement', 'gates', { stage: 'review', bot: 'ghost' }]),
    { ...verified, botIds: ['staged'] }).code, 'BOT_STAGES_INVALID')
  assert.equal(validateBot(withStages(['implement', 'gates', { stage: 'review', bot: 'staged' }]), verified).code,
    'BOT_STAGES_INVALID')
  assert.equal(validateBot(withStages(['implement', 'gates', { stage: 'review', budget: { timeoutMs: 10 } }])).code,
    'BOT_BUDGET_INVALID')
  // A stage name outside the fixed table is refused even when its entry is an object.
  assert.equal(validateBot(withStages(['implement', 'gates', { stage: 'deploy' }])).code, 'BOT_STAGES_INVALID')
})
