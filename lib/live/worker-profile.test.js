import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BUILTIN_PROFILE_IDS, DEFAULT_PROFILE_ID, PROFILE_FILE_NAME, builtinProfiles, canonicalJson, capabilitiesOf,
  digestOf, isBuiltinProfile, normalizeProfiles, paramsOfProfile, parseProfilesDocument, profilesDigest, profilesFileOf,
  readProfiles, resolveProfile, sortProfile, synthesizeProfile, validateProfile, writeProfiles,
} from './worker-profile.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'superagent-profiles-'))
}

function baseProfile(overrides = {}) {
  return { id: 'dsh-dev', name: 'DSH 开发', backend: 'dsh', requires: ['edit', 'exec'], ...overrides }
}

test('built-ins are the three documented profiles and cannot be mutated by callers', () => {
  assert.deepEqual(BUILTIN_PROFILE_IDS, ['generalist', 'surgical', 'reviewer'])
  const profiles = builtinProfiles()
  assert.deepEqual(profiles.map(profile => profile.id), ['generalist', 'surgical', 'reviewer'])
  assert.deepEqual(profiles[1].stages, ['implement', 'gates'])
  assert.equal(profiles[0].backend, 'dsh')
  profiles[0].requires.push('web')
  assert.deepEqual(builtinProfiles()[0].requires, ['edit', 'exec'])
  assert.equal(isBuiltinProfile('generalist'), true)
  assert.equal(isBuiltinProfile('custom'), false)
  assert.equal(DEFAULT_PROFILE_ID, 'generalist')
})

test('canonicalJson sorts keys, drops undefined and is stable across key orders', () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] }), '{"a":[2,{"c":3}],"b":1}')
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }))
  assert.match(digestOf({ a: 1 }), /^[a-f0-9]{64}$/)
})

test('normalizeProfiles keeps known keys, reports unknown ones and lowercases identifiers', () => {
  const { profiles, droppedKeys, truncated, warnings } = normalizeProfiles([{
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
  const profile = profiles[0]
  assert.equal(profile.id, 'dsh-dev')
  assert.equal(profile.name, 'DSH 开发')
  assert.equal(profile.backend, 'dsh')
  assert.deepEqual(profile.requires, ['edit', 'exec'])
  assert.deepEqual(profile.tools.deny, ['present'])
  assert.equal(profile.skills.policy, 'prompt')
  assert.deepEqual(profile.model, { provider: 'deepseek', model: 'deepseek-v4', reasoningEffort: 'high' })
  assert.deepEqual(profile.budget, { timeoutMs: 900_000 })
  // Stable key order for configDigest reproducibility.
  assert.deepEqual(Object.keys(profile), ['id', 'name', 'backend', 'model', 'requires', 'tools', 'skills', 'budget'])
})

test('normalizeProfiles drops non-objects, duplicate ids and truncates over-limit arrays', () => {
  const { profiles, truncated, warnings } = normalizeProfiles([
    null,
    { name: '缺 id' },
    baseProfile({ id: 'dup' }),
    baseProfile({ id: 'dup' }),
    baseProfile({ id: 'many', requires: ['edit', 'exec', 'web', 'edit'], tools: { deny: Array.from({ length: 40 }, (_, i) => `t${i}`) } }),
  ])
  assert.deepEqual(profiles.map(profile => profile.id), ['dup', 'many'])
  assert.ok(warnings.some(line => line.includes('必须是对象')))
  assert.ok(warnings.some(line => line.includes('缺少 id')))
  assert.ok(warnings.some(line => line.includes('重复')))
  assert.ok(truncated.includes('tools.deny'))
})

test('validateProfile accepts the built-ins and reports the documented error codes', () => {
  for (const profile of builtinProfiles()) {
    const result = validateProfile(profile)
    assert.equal(result.ok, true, profile.id)
  }
  const cases = [
    [{ id: 'A' }, 'PROFILE_ID_INVALID'],
    [{ id: 'ok', name: '' }, 'PROFILE_SCHEMA_INVALID'],
    [baseProfile({ backend: 'gemini' }), 'PROFILE_SCHEMA_INVALID'],
    [baseProfile({ requires: ['report'] }), 'PROFILE_REQUIRES_NOT_CAPABILITY'],
    [baseProfile({ requires: ['deploy'] }), 'PROFILE_REQUIRES_UNKNOWN'],
    [baseProfile({ preset: 'creator', backend: 'claude' }), 'PROFILE_PRESET_UNKNOWN'],
    [baseProfile({ skills: { policy: 'preset' } }), 'PROFILE_SKILLS_PRESET_MISSING'],
    [baseProfile({ budget: { timeoutMs: 1000 } }), 'PROFILE_BUDGET_INVALID'],
    [baseProfile({ stages: ['plan', 'gates', 'review'] }), 'PROFILE_STAGES_INVALID'],
    [baseProfile({ stages: ['assess', 'plan', 'review'] }), 'PROFILE_STAGES_INVALID'],
    [baseProfile({ stages: ['github', 'implement', 'gates'] }), 'PROFILE_STAGES_INVALID'],
    [baseProfile({ stages: ['review', 'implement', 'gates'] }), 'PROFILE_STAGES_INVALID'],
    [baseProfile({ stages: ['implement'] }), 'PROFILE_STAGES_INVALID'],
    [baseProfile({ model: { provider: 'p' } }), 'PROFILE_SCHEMA_INVALID'],
    [baseProfile({ model: { provider: 'p', model: 'm', reasoningEffort: 'turbo' } }), 'PROFILE_EFFORT_UNSUPPORTED'],
    [baseProfile({ prompt: { must: ['x'.repeat(201)] } }), 'PROFILE_PROMPT_INVALID'],
  ]
  for (const [profile, code] of cases) {
    const result = validateProfile(profile)
    assert.equal(result.ok, false, code)
    assert.equal(result.code, code, JSON.stringify(profile))
  }
})

test('validateProfile checks the runtime environment: unverified/stale/disabled/gap/preset/effort', () => {
  const verifiedDsh = { backendState: 'verified', backendEnabled: true, capabilities: { edit: true, exec: true, web: false } }
  assert.equal(validateProfile(baseProfile(), verifiedDsh).ok, true)
  assert.equal(validateProfile(baseProfile({ requires: ['web'] }), verifiedDsh).code, 'PROFILE_CAPABILITY_GAP')
  assert.deepEqual(validateProfile(baseProfile({ requires: ['web'] }), verifiedDsh).missing, ['web'])
  assert.equal(validateProfile(baseProfile(), { backendState: 'unverified' }).code, 'PROFILE_BACKEND_UNVERIFIED')
  assert.equal(validateProfile(baseProfile(), { backendState: 'stale' }).code, 'PROFILE_BACKEND_STALE')
  assert.equal(validateProfile(baseProfile(), { backendEnabled: false }).code, 'PROFILE_BACKEND_DISABLED')
  assert.equal(validateProfile(baseProfile({ preset: 'creator' }), { presetKnown: false }).code, 'PROFILE_PRESET_UNKNOWN')
  assert.equal(validateProfile(baseProfile({ model: { provider: 'p', model: 'm', reasoningEffort: 'high' } }),
    { effortSupported: false }).code, 'PROFILE_EFFORT_UNSUPPORTED')
  // auto never fails on a backend that has no effort knob.
  assert.equal(validateProfile(baseProfile({ model: { provider: 'p', model: 'm', reasoningEffort: 'auto' } }),
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

test('paramsOfProfile drops an incomplete model pair and exposes nothing it does not know', () => {
  assert.deepEqual(paramsOfProfile({ id: 'x', backend: 'dsh', model: { provider: 'p' } }), {
    preset: undefined, model: undefined, reasoningEffort: undefined, denyTools: undefined, allowMcp: undefined,
    budget: { timeoutMs: undefined, idleTimeoutMs: undefined, maxRepairRounds: undefined }, stages: undefined,
  })
})

test('resolveProfile stacks deny tools and lets the profile budget win over executor defaults', () => {
  const profile = baseProfile({
    preset: 'creator',
    tools: { deny: ['present', 'workflow'], allowMcp: ['gitlab'] },
    prompt: { role: '只改目标仓库', must: ['先跑单测'] },
    skills: { prefer: ['ponytail'] },
    budget: { timeoutMs: 900_000, maxRepairRounds: 4 },
    stages: ['implement', 'gates'],
  })
  const resolved = resolveProfile(profile, {
    denyTools: ['ask_user_question', 'present'], preset: 'standard', timeoutMs: 1_500_000,
    idleTimeoutMs: 300_000, maxRepairRounds: 2, readOnly: true, capabilities: ['edit', 'exec'],
  })
  assert.equal(resolved.id, 'dsh-dev')
  assert.equal(resolved.preset, 'creator')
  // The hard blacklist is a union: a profile can only add, never remove (§4.3).
  assert.deepEqual(resolved.denyTools, ['ask_user_question', 'present', 'workflow'])
  assert.deepEqual(resolved.allowMcp, ['gitlab'])
  assert.equal(resolved.readOnly, true)
  assert.deepEqual(resolved.budget, { timeoutMs: 900_000, idleTimeoutMs: 300_000, maxRepairRounds: 4 })
  assert.deepEqual(resolved.stages, ['implement', 'gates'])
  assert.deepEqual(resolved.systemPromptExtra, { role: '只改目标仓库', must: ['先跑单测'], skills: ['ponytail'] })
  assert.deepEqual(resolved.capability, ['edit', 'exec'])
})

test('synthesizeProfile is deterministic, picks the first backend that covers the requirement set and refuses gaps', () => {
  const capabilities = { dsh: { edit: true, exec: true, web: false }, claude: { edit: true, exec: false, web: false } }
  const first = synthesizeProfile({ requires: ['exec', 'edit'], deliverable: 'change', capabilities: capabilities.dsh })
  const second = synthesizeProfile({ requires: ['edit', 'exec', 'edit'], deliverable: 'change', capabilities: capabilities.dsh })
  assert.equal(first.id, second.id)
  assert.match(first.id, /^adhoc:[a-f0-9]{8}$/)
  assert.equal(first.backend, 'dsh')
  assert.deepEqual(first.requires, ['edit', 'exec'])
  assert.equal(PROFILE_FILE_NAME, 'worker-profiles.json')
  // A report deliverable needs no capability at all; the first enabled backend is fine.
  assert.deepEqual(synthesizeProfile({ deliverable: 'report', capabilities: capabilities.dsh }).requires, [])
  // Nothing covers exec on claude, so the next backend in the order is chosen; with none left: null.
  assert.equal(synthesizeProfile({ requires: ['exec'], capabilities: capabilities.claude,
    backendOrder: ['claude'] }), null)
  assert.equal(synthesizeProfile({ requires: ['exec'], capabilities: { edit: true, exec: false, web: false },
    backendOrder: ['claude', 'dsh'] }), null)
  // Per-backend map: claude cannot exec, so the order skips it for dsh.
  const byBackend = { claude: { edit: true, exec: false, web: false }, dsh: { edit: true, exec: true, web: false } }
  assert.equal(synthesizeProfile({ requires: ['exec'], capabilities: byBackend,
    backendOrder: ['claude', 'dsh'] }).backend, 'dsh')
  assert.equal(synthesizeProfile({ requires: ['edit'], capabilities: byBackend,
    backendOrder: ['claude', 'dsh'] }).backend, 'claude')
  // A different role prefix is a different transient profile.
  assert.notEqual(synthesizeProfile({ requires: ['edit'], capabilities: capabilities.dsh, role: '只读复核' }).id, first.id)
})

test('profilesFileOf accepts only a bare filename (I7: no repo-controlled path)', () => {
  assert.equal(profilesFileOf({}).name, PROFILE_FILE_NAME)
  assert.equal(profilesFileOf({ executor: { profilesFile: 'team.json' } }).name, 'team.json')
  assert.ok(profilesFileOf({ executor: { profilesFile: '../worker-profiles.json' } }).error)
  assert.ok(profilesFileOf({ executor: { profilesFile: 'sub/dir.json' } }).error)
  assert.ok(profilesFileOf({ executor: { profilesFile: '.hidden' } }).error)
})

test('readProfiles: missing file or no state dir means built-ins, not an error', () => {
  assert.deepEqual(readProfiles(undefined, {}).profiles.map(profile => profile.id), BUILTIN_PROFILE_IDS)
  assert.equal(readProfiles('/tmp/does-not-exist-superagent', {}).code, undefined)
  assert.equal(readProfiles('/tmp/does-not-exist-superagent', {}).exists, false)
  assert.equal(readProfiles('/tmp/does-not-exist-superagent', {}).builtin, true)
})

test('readProfiles keeps usable profiles, drops invalid ones and reports dropped keys', async () => {
  const dir = await tempDir()
  try {
    await writeFile(join(dir, PROFILE_FILE_NAME), JSON.stringify({
      version: 1,
      profiles: [
        { id: 'team', name: '团队', backend: 'dsh', requires: ['edit'], extra: 1 },
        { id: 'broken', name: '坏', backend: 'gemini' },
        { id: 'generalist', name: '想改内置', backend: 'dsh' },
      ],
    }))
    const book = readProfiles(dir, {})
    assert.deepEqual(book.profiles.map(profile => profile.id), [...BUILTIN_PROFILE_IDS, 'team'])
    assert.deepEqual(book.droppedKeys, ['extra'])
    assert.ok(book.warnings.some(line => line.includes('broken')))
    assert.ok(book.warnings.some(line => line.includes('内置档位不可编辑')))
    assert.equal(book.code, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('readProfiles refuses a corrupt or future-versioned file instead of silently falling back', async () => {
  const dir = await tempDir()
  try {
    const file = join(dir, PROFILE_FILE_NAME)
    await writeFile(file, '{ not json')
    assert.equal(readProfiles(dir, {}).code, 'PROFILE_FILE_CORRUPT')
    // Refused, not silently replaced by the built-ins (I2).
    assert.deepEqual(readProfiles(dir, {}).profiles, [])
    await writeFile(file, JSON.stringify({ version: 2, profiles: [] }))
    const future = readProfiles(dir, {})
    assert.equal(future.code, 'PROFILE_FILE_VERSION_UNSUPPORTED')
    assert.match(future.error, /升级/)
    assert.deepEqual(future.profiles, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeProfiles validates, persists 0600 JSON and round-trips', async () => {
  const dir = await tempDir()
  try {
    const written = await writeProfiles(dir, {}, { profiles: [baseProfile()] })
    assert.deepEqual(written.profiles.map(profile => profile.id), ['dsh-dev'])
    const raw = JSON.parse(await readFile(join(dir, PROFILE_FILE_NAME), 'utf8'))
    assert.deepEqual(raw, { version: 1, profiles: [baseProfile()] })
    const book = readProfiles(dir, {})
    assert.deepEqual(book.profiles.map(profile => profile.id), [...BUILTIN_PROFILE_IDS, 'dsh-dev'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('writeProfiles rejects invalid profiles, unknown keys, built-in ids and path-like filenames', async () => {
  const dir = await tempDir()
  try {
    await assert.rejects(writeProfiles(dir, {}, { profiles: [baseProfile({ requires: ['report'] })] }),
      error => error.code === 'PROFILE_SCHEMA_INVALID' && error.problems[0].includes('PROFILE_REQUIRES_NOT_CAPABILITY'))
    await assert.rejects(writeProfiles(dir, {}, { profiles: [{ ...baseProfile(), extra: true }] }),
      error => error.code === 'PROFILE_SCHEMA_INVALID' && error.problems[0].includes('未知字段'))
    await assert.rejects(writeProfiles(dir, {}, { profiles: [{ id: 'generalist', name: '通用', backend: 'dsh' }] }),
      error => error.code === 'PROFILE_SCHEMA_INVALID' && error.problems[0].includes('内置档位'))
    await assert.rejects(writeProfiles(dir, {}, {
      profiles: [baseProfile({ id: 'aa' }), baseProfile({ id: 'aa' })],
    }), error => error.code === 'PROFILE_DUPLICATE_ID')
    await assert.rejects(writeProfiles(dir, { executor: { profilesFile: '../x.json' } }, { profiles: [] }),
      error => error.code === 'PROFILE_FILE_INVALID')
    // AC-B1: a backend with no probe/smoke evidence cannot be saved as a profile.
    await assert.rejects(writeProfiles(dir, {}, {
      profiles: [baseProfile({ id: 'guest' })], environment: { backendState: 'unverified' },
    }), error => error.code === 'PROFILE_SCHEMA_INVALID' && error.problems[0].includes('PROFILE_BACKEND_UNVERIFIED'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// A store can hold profiles for several backends: each one is validated against its own backend's evidence, so an
// unverified claude profile must not be judged by (nor rescued by) the DSH probe.
test('writeProfiles validates each profile against its own backend environment', async () => {
  const dir = await tempDir()
  try {
    const profile = baseProfile()
    await assert.rejects(writeProfiles(dir, {}, {
      profiles: [{ ...profile, backend: 'claude' }],
      environments: { dsh: { backendState: 'verified' }, claude: { backendState: 'unverified' } },
    }), error => error.code === 'PROFILE_SCHEMA_INVALID'
      && error.problems[0].includes('PROFILE_BACKEND_UNVERIFIED'))
    const written = await writeProfiles(dir, {}, {
      profiles: [profile], environments: { dsh: { backendState: 'verified', capabilities: { edit: true, exec: true } } },
    })
    assert.deepEqual(written.profiles.map(item => item.id), ['dsh-dev'])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('profilesDigest is stable across key order so the dispatch cache key is reproducible', () => {
  const a = profilesDigest([baseProfile(), sortProfile({ backend: 'dsh', name: '通用', id: 'generalist', requires: ['edit', 'exec'] })])
  const b = profilesDigest([sortProfile({ requires: ['edit', 'exec'], id: 'generalist', name: '通用', backend: 'dsh' }), baseProfile()])
  assert.notEqual(a, b) // array order is part of the digest
  assert.equal(profilesDigest([baseProfile()]), profilesDigest([sortProfile(baseProfile())]))
})

test('parseProfilesDocument reports a missing version as corrupt', () => {
  assert.equal(parseProfilesDocument({ profiles: [] }).code, 'PROFILE_FILE_CORRUPT')
  assert.equal(parseProfilesDocument([]).code, 'PROFILE_FILE_CORRUPT')
})

test('§9.3: save-time validation uses the host catalogues when they are supplied', () => {
  const base = { id: 'tuned', name: '调优', backend: 'dsh' }
  const verified = { backendState: 'verified', capabilities: { edit: true, exec: true, web: true } }

  const unknownPreset = validateProfile({ ...base, preset: 'ghost' }, { ...verified, presets: ['standard', 'planner'] })
  assert.equal(unknownPreset.code, 'PROFILE_PRESET_UNKNOWN')
  assert.equal(validateProfile({ ...base, preset: 'planner' }, { ...verified, presets: ['standard', 'planner'] }).ok, true)

  const model = { provider: 'deepseek', model: 'deepseek-chat' }
  const tooDeep = validateProfile({ ...base, model: { ...model, reasoningEffort: 'high' } },
    { ...verified, efforts: { 'deepseek/deepseek-chat': ['low', 'medium'] } })
  assert.equal(tooDeep.code, 'PROFILE_EFFORT_UNSUPPORTED')
  assert.equal(validateProfile({ ...base, model: { ...model, reasoningEffort: 'medium' } },
    { ...verified, efforts: { 'deepseek/deepseek-chat': ['low', 'medium'] } }).ok, true)
  // A model the host could not resolve makes no claim: the declaration passes, the panel shows no evidence either way.
  assert.equal(validateProfile({ ...base, model: { ...model, reasoningEffort: 'high' } }, verified).ok, true)
})
