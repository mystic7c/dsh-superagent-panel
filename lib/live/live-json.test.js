import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateLiveConfig, updateRepoDefinition, saveOctoToken, listLiveConfigHistory, restoreLiveConfig } from './live-json.js'
import { loadLiveConfig } from './config.js'

test('updateLiveConfig merges allow-listed switches atomically and keeps other keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: false, repo: '/repo',
      octo: { watchChatIds: ['chat-1'], allowAnyHuman: false }, executor: { enabled: false, allowPush: false } }))
    const result = await updateLiveConfig(dir, { enabled: true, paused: true, 'executor.autoRun': true, 'executor.allowMerge': true })
    assert.deepEqual(result.applied.sort(), ['enabled', 'executor.allowMerge', 'executor.autoRun', 'paused'])
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.enabled, true)
    assert.equal(saved.paused, true)
    assert.equal(saved.repo, '/repo')
    assert.deepEqual(saved.octo.watchChatIds, ['chat-1'])
    assert.equal(saved.executor.autoRun, true)
    assert.equal(saved.executor.allowMerge, true)
    assert.equal(saved.executor.allowPush, false)
    assert.equal((await stat(join(dir, 'live.json'))).mode & 0o777, 0o600)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('updateLiveConfig rejects unknown keys and bad values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await updateLiveConfig(dir, { 'executor.autoRun': false })
    await assert.rejects(() => updateLiveConfig(dir, { repo: '/evil' }), /unsupported setting/)
    await assert.rejects(() => updateLiveConfig(dir, { enabled: 'yes' }), /must be a boolean/)
    await assert.rejects(() => updateLiveConfig(dir, { paused: 'yes' }), /must be a boolean/)
    await assert.rejects(() => updateLiveConfig(dir, { 'gitlab.createMr': 'ssh' }), /must be "api" or "push"/)
    await assert.rejects(() => updateLiveConfig(dir, {}), /empty/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the two pause switches persist independently and read back through config', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: true, octo: { watchChatIds: ['chat-1'] } }))
    const result = await updateLiveConfig(dir, { pausedIntake: true, pausedDispatch: false })
    assert.deepEqual(result.applied.sort(), ['pausedDispatch', 'pausedIntake'])
    const loaded = loadLiveConfig(dir)
    assert.equal(loaded.config.pausedIntake, true)
    assert.equal(loaded.config.pausedDispatch, false)
    assert.equal(loaded.config.paused, false)
    // The legacy overall `paused` stays a separate flag, so an old panel that only knows it still pauses everything.
    assert.equal(loaded.config.enabled, true)
    await updateLiveConfig(dir, { pausedIntake: false, pausedDispatch: true })
    const again = loadLiveConfig(dir)
    assert.equal(again.config.pausedIntake, false)
    assert.equal(again.config.pausedDispatch, true)
    await assert.rejects(() => updateLiveConfig(dir, { pausedIntake: 'yes' }), /must be a boolean/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('a legacy single-repository file normalises to one id that keeps working after later edits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: true, repo: dir, baseBranch: 'develop',
      gitlab: { project: 'group/legacy-app', targetBranch: 'develop' }, octo: { chatRepos: { 'chat-1': 'legacy-app' } } }))
    const loaded = loadLiveConfig(dir)
    assert.equal(loaded.config.repos.length, 1)
    assert.equal(loaded.config.repos[0].id, 'legacy-app')
    assert.equal(loaded.config.defaultRepo, 'legacy-app')
    assert.deepEqual(loaded.config.octo.chatRepos, { 'chat-1': 'legacy-app' })
    const edited = await updateRepoDefinition(dir, 'legacy-app', { name: 'Legacy app', enabled: false })
    assert.equal(edited.repo.id, 'legacy-app')
    const reread = loadLiveConfig(dir)
    assert.equal(reread.config.repos[0].id, 'legacy-app')
    assert.equal(reread.config.repos[0].enabled, false)
    assert.deepEqual(reread.config.octo.chatRepos, { 'chat-1': 'legacy-app' })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('disabling the default repository keeps its id, binding and history readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: true, defaultRepo: 'web-app',
      octo: { chatRepos: { 'chat-1': 'web-app' } },
      repos: [{ id: 'web-app', name: 'Web app', repo: dir, baseBranch: 'develop', gitlab: { project: 'group/web-app' } }] }))
    await updateRepoDefinition(dir, 'web-app', { enabled: false })
    const loaded = loadLiveConfig(dir)
    assert.equal(loaded.config.defaultRepo, 'web-app')
    assert.equal(loaded.config.repos[0].enabled, false)
    assert.deepEqual(loaded.config.octo.chatRepos, { 'chat-1': 'web-app' })
    assert.equal((await listLiveConfigHistory(dir)).length, 1)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('worker backend fields are allow-listed and validated', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await updateLiveConfig(dir, { 'executor.workerBackend': 'codex', 'executor.workerModel': 'gpt-6-astra',
      'executor.workerCommand': '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.workerBackend, 'codex')
    assert.equal(saved.executor.workerModel, 'gpt-6-astra')
    assert.match(saved.executor.workerCommand, /codex$/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workerBackend': 'openai' }), /must be one of/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workerModel': 'a\nb' }), /single-line/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('saveOctoToken writes the configured token file with mode 600 and clears it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-octo-token-'))
  try {
    const file = join(dir, 'octo.token')
    const config = { octo: { tokenFile: file } }
    assert.deepEqual(await saveOctoToken(config, '  bf_new_token  '), { configured: true })
    assert.equal((await readFile(file, 'utf8')).trim(), 'bf_new_token')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    await assert.rejects(() => saveOctoToken(config, 'has space'), /whitespace/)
    assert.deepEqual(await saveOctoToken(config, ''), { configured: false })
    await assert.rejects(() => stat(file))
    await assert.rejects(() => saveOctoToken({ octo: {} }, 'x'), /octo.tokenFile/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('live.json writes leave a restorable history that never contains token files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-history-'))
  try {
    const file = join(dir, 'live.json')
    await writeFile(file, JSON.stringify({ enabled: false, pollSeconds: 10 }))
    await updateLiveConfig(dir, { enabled: true })
    await updateLiveConfig(dir, { pollSeconds: 30 })
    const entries = await listLiveConfigHistory(dir)
    assert.equal(entries.length, 2)
    assert.match(entries[0].label, /settings:/)
    const restored = await restoreLiveConfig(dir, entries[entries.length - 1].id)
    assert.equal(restored.at.endsWith('Z'), true)
    const config = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(config.enabled, false)
    assert.equal(config.pollSeconds, 10)
    const after = await listLiveConfigHistory(dir)
    assert.equal(after.length, 3) // restoring backs up the replaced version first
    await assert.rejects(() => restoreLiveConfig(dir, '../live.json'), /invalid history id/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('workers and routing patches are validated and saved atomically', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await updateLiveConfig(dir, {
      'executor.workers': { dsh: { enabled: true }, codex: { enabled: true, model: 'gpt-6-astra' }, claude: { enabled: true } },
      'executor.routing': { mode: 'suggest', defaultBackend: 'dsh', fallback: ['codex'],
        preferences: [{ workTypes: ['review', 'analysis'], backend: 'codex' }] },
    })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.workers.codex.model, 'gpt-6-astra')
    assert.equal(saved.executor.routing.mode, 'suggest')
    assert.deepEqual(saved.executor.routing.preferences, [{ workTypes: ['review', 'analysis'], backend: 'codex' }])
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.routing': { mode: 'later' } }), /must be one of/)
    await assert.rejects(() => updateLiveConfig(dir, {
      'executor.routing': { preferences: [{ workTypes: ['nope'], backend: 'codex' }] } }), /workTypes/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workers': { openai: { enabled: true } } }), /must only name/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('review settings are allow-listed, validated and saved', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    const result = await updateLiveConfig(dir, {
      'review.enabled': true,
      'review.scope': 'uncertain',
      'review.allowSenderIds': ['user-1', 'user-2'],
      'review.expireHours': 12,
    })
    assert.deepEqual(result.applied.sort(),
      ['review.allowSenderIds', 'review.enabled', 'review.expireHours', 'review.scope'])
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.review.enabled, true)
    assert.equal(saved.review.scope, 'uncertain')
    assert.deepEqual(saved.review.allowSenderIds, ['user-1', 'user-2'])
    assert.equal(saved.review.expireHours, 12)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.scope': 'everything' }), /must be "all" or "uncertain"/)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.expireHours': 0 }), /between 1 and 168/)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.expireHours': 200 }), /between 1 and 168/)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.allowSenderIds': ['ok', ''] }), /array of non-empty strings/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('executor.workerIdleTimeoutMs is editable between one and sixty minutes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-worker-idle-'))
  try {
    await updateLiveConfig(dir, { 'executor.workerIdleTimeoutMs': 600_000 })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.workerIdleTimeoutMs, 600_000)
    for (const invalid of [59_999, 3_600_001, '600000']) {
      await assert.rejects(() => updateLiveConfig(dir, { 'executor.workerIdleTimeoutMs': invalid }),
        /must be whole milliseconds between 60000 and 3600000/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('executor.timeoutMs is an editable setting with sane bounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-timeout-'))
  try {
    await updateLiveConfig(dir, { 'executor.timeoutMs': 3_600_000 })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.timeoutMs, 3_600_000)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.timeoutMs': 1_000 }), /whole milliseconds/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.timeoutMs': 90_000_000 }), /whole milliseconds/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.timeoutMs': '25' }), /whole milliseconds/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('workflow settings validate and survive config loading', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sa-workflow-config-'))
  try {
    await updateLiveConfig(dir, { 'executor.workflowMode': 'auto', 'executor.implementer': 'claude' })
    const { loadLiveConfig } = await import('./config.js')
    assert.equal(loadLiveConfig(dir).config.executor.workflowMode, 'auto')
    assert.equal(loadLiveConfig(dir).config.executor.implementer, 'claude')
    await assert.rejects(updateLiveConfig(dir, { 'executor.workflowMode': 'unknown' }))
    await assert.rejects(updateLiveConfig(dir, { 'executor.implementer': 'codex' }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})


// AC-10: editing keeps the id/history, disables only new work, and refuses a config it cannot honour instead of
// silently falling back to the built-in gates.
test('updateRepoDefinition edits name/gates/enabled and keeps the id and history', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({
      defaultRepo: 'web-app',
      repos: [{ id: 'web-app', name: 'Web app', kind: 'web', repo: dir, baseBranch: 'develop',
        gitlab: { project: 'group/web-app', targetBranch: 'develop' },
        gates: [{ name: 'lint', command: 'pnpm lint' }] }],
    }))
    const result = await updateRepoDefinition(dir, 'web-app', {
      name: 'Web app (edited)', enabled: false,
      gates: [{ name: 'lint', command: 'pnpm lint', cwd: '.', timeoutMs: 1000, onFail: 'auto_repair' }],
    })
    assert.equal(result.repo.id, 'web-app')
    assert.equal(result.repo.name, 'Web app (edited)')
    assert.equal(result.repo.enabled, false)
    assert.deepEqual(result.repo.gates, [{ name: 'lint', command: 'pnpm lint', timeoutMs: 1000,
      onFail: 'auto_repair', cwd: '.' }])
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.repos[0].id, 'web-app')
    assert.equal(saved.repos[0].enabled, false)
    assert.deepEqual(saved.repos[0].gitlab.project, 'group/web-app')
    assert.equal((await listLiveConfigHistory(dir)).length, 1)
    await restoreLiveConfig(dir, (await listLiveConfigHistory(dir))[0].id)
    const restored = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(restored.repos[0].name, 'Web app')
    assert.equal(restored.repos[0].gates[0].name, 'lint')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('updateRepoDefinition rejects escaping gates, duplicate names and empty lists without writing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({
      defaultRepo: 'web-app',
      repos: [{ id: 'web-app', name: 'Web app', kind: 'web', repo: dir, baseBranch: 'develop',
        gitlab: { project: 'group/web-app', targetBranch: 'develop' },
        gates: [{ name: 'lint', command: 'pnpm lint' }] }],
    }))
    const before = await readFile(join(dir, 'live.json'), 'utf8')
    await assert.rejects(updateRepoDefinition(dir, 'web-app', { gates: [] }), /不能为空/)
    await assert.rejects(updateRepoDefinition(dir, 'web-app', { gates: [{ name: 'lint', command: 'a' }, { name: 'lint', command: 'b' }] }), /重复/)
    await assert.rejects(updateRepoDefinition(dir, 'web-app', { gates: [{ name: 'lint', command: 'a', cwd: '../out' }] }), /越出/)
    await assert.rejects(updateRepoDefinition(dir, 'web-app', { gates: [{ name: 'lint', command: 'a', cwd: '/tmp' }] }), /相对路径/)
    await assert.rejects(updateRepoDefinition(dir, 'web-app', { gates: [{ name: 'lint', command: 'a', timeoutMs: -1 }] }), /超时/)
    // A symlink inside the repository that points outside it is an escape even though the lexical path is inside.
    const outside = await mkdtemp(join(tmpdir(), 'superagent-outside-'))
    try {
      await symlink(outside, join(dir, 'escape'))
      await assert.rejects(updateRepoDefinition(dir, 'web-app', { gates: [{ name: 'lint', command: 'a', cwd: 'escape' }] }), /越出/)
    } finally { await rm(outside, { recursive: true, force: true }) }
    await assert.rejects(updateRepoDefinition(dir, 'nope', { name: 'x' }), /未知仓库/)
    assert.equal(await readFile(join(dir, 'live.json'), 'utf8'), before)
    assert.equal((await listLiveConfigHistory(dir)).length, 0)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
