import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateLiveConfig, updateRepoDefinition, addRepoDefinition, saveOctoToken, listLiveConfigHistory, restoreLiveConfig } from './live-json.js'
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
    await assert.rejects(() => updateLiveConfig(dir, { repo: '/evil' }), /不支持的设置项/)
    await assert.rejects(() => updateLiveConfig(dir, { enabled: 'yes' }), /必须是布尔值/)
    await assert.rejects(() => updateLiveConfig(dir, { paused: 'yes' }), /必须是布尔值/)
    await assert.rejects(() => updateLiveConfig(dir, { 'gitlab.createMr': 'ssh' }), /只能是 api 或 push/)
    await assert.rejects(() => updateLiveConfig(dir, {}), /不能为空/)
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
    await assert.rejects(() => updateLiveConfig(dir, { pausedIntake: 'yes' }), /必须是布尔值/)
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
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workerBackend': 'openai' }), /只能是/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workerModel': 'a\nb' }), /单行字符串/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})


test('repair budget is allow-listed and the removed worker preset is rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await updateLiveConfig(dir, { 'executor.maxRepairRounds': 4 })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.maxRepairRounds, 4)
    // `executor.workerPreset` was removed in 1.4.0: the panel no longer offers it, so a patch naming it is a typo.
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workerPreset': 'cordis' }), /不支持的设置项/)
    await updateLiveConfig(dir, { 'executor.maxRepairRounds': 0 })
    assert.equal(JSON.parse(await readFile(join(dir, 'live.json'), 'utf8')).executor.maxRepairRounds, 0)
    // The ceiling is the same 6 the executor and the bot budget read; it used to be a live-json-only number.
    await updateLiveConfig(dir, { 'executor.maxRepairRounds': 6 })
    assert.equal(JSON.parse(await readFile(join(dir, 'live.json'), 'utf8')).executor.maxRepairRounds, 6)
    for (const invalid of [-1, 7, 1.5, '3']) {
      await assert.rejects(() => updateLiveConfig(dir, { 'executor.maxRepairRounds': invalid }), /0–6 之间的整数/, String(invalid))
    }
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


test('history entries carry the old and new value of the field they changed (R2-04)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-history-diff-'))
  try {
    const file = join(dir, 'live.json')
    await writeFile(file, JSON.stringify({ enabled: false, pollSeconds: 10 }))
    await updateLiveConfig(dir, { enabled: true })
    await updateLiveConfig(dir, { pollSeconds: 30 })
    const entries = await listLiveConfigHistory(dir)
    assert.equal(entries.length, 2)
    // Newest snapshot was taken before `pollSeconds` changed; its "after" side is the file on disk now.
    assert.deepEqual(entries[0].changes, [{ key: 'pollSeconds', before: '10', after: '30' }])
    assert.equal(entries[0].changesTruncated, false)
    // The older snapshot's "after" side is the next newer snapshot, so it shows the `enabled` flip only.
    assert.deepEqual(entries[1].changes, [{ key: 'enabled', before: 'false', after: 'true' }])
    // History rows stay configuration-only and never grow a token field.
    assert.equal(Object.prototype.hasOwnProperty.call(entries[0], 'config'), false)
    // A long value is clipped on the server, so the payload cannot be blown up by one pasted command.
    await writeFile(file, JSON.stringify({ enabled: true, pollSeconds: 30,
      executor: { workerCommand: 'x'.repeat(3000) } }))
    await updateLiveConfig(dir, { 'executor.autoRun': true })
    // The snapshot taken before `autoRun` still holds the long command; its value side is clipped, not dropped.
    const withCommand = (await listLiveConfigHistory(dir))
      .flatMap(entry => entry.changes)
      .find(change => change.key === 'executor.workerCommand')
    assert.ok(withCommand)
    const longSide = withCommand.before.length > 1000 ? withCommand.before : withCommand.after
    assert.equal(longSide.length, 2001)
    assert.ok(longSide.endsWith('…'))
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
      'executor.routing': { defaultBackend: 'dsh', fallback: ['codex'] },
    })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.workers.codex.model, 'gpt-6-astra')
    assert.equal(saved.executor.routing.defaultBackend, 'dsh')
    assert.deepEqual(saved.executor.routing.fallback, ['codex'])
    // The removed mode shows up as an unknown key and is ignored by the loader instead of failing the save.
    await updateLiveConfig(dir, { 'executor.routing': { mode: 'suggest', defaultBackend: 'dsh' } })
    assert.equal(loadLiveConfig(dir).config.executor.routing.mode, undefined)
    assert.equal(loadLiveConfig(dir).config.executor.routing.defaultBackend, 'dsh')
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.routing': { defaultBackend: 'later' } }), /只能是/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.workers': { openai: { enabled: true } } }), /只能包含/)
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
    await assert.rejects(() => updateLiveConfig(dir, { 'review.scope': 'everything' }), /只能是 all 或 uncertain/)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.expireHours': 0 }), /1–168 之间的整数/)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.expireHours': 200 }), /1–168 之间的整数/)
    await assert.rejects(() => updateLiveConfig(dir, { 'review.allowSenderIds': ['ok', ''] }), /非空字符串数组/)
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
        /60000–3600000 之间的整数毫秒/)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('executor.timeoutMs is an editable setting with sane bounds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-timeout-'))
  try {
    await updateLiveConfig(dir, { 'executor.timeoutMs': 3_600_000 })
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.timeoutMs, 3_600_000)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.timeoutMs': 1_000 }), /整数毫秒/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.timeoutMs': 90_000_000 }), /整数毫秒/)
    await assert.rejects(() => updateLiveConfig(dir, { 'executor.timeoutMs': '25' }), /整数毫秒/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

// Staged execution is gone: there are no workflow settings to validate.

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

test('a repository add racing a settings save keeps both writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: true, executor: { enabled: true },
      repos: [{ id: 'web-app', name: 'Web app', kind: 'web', repo: dir, baseBranch: 'develop',
        gitlab: { project: 'group/web-app', targetBranch: 'develop' } }] }))
    // add/update/restore used to be bare read-modify-write: a settings save in the same tick read the file first and
    // wrote its own snapshot back, silently dropping the new repository. All writers share one queue now.
    const otherRepo = await mkdtemp(join(tmpdir(), 'superagent-live-json-repo-'))
    try {
    const add = addRepoDefinition(dir, { id: 'ebs-app', repo: otherRepo, baseBranch: 'develop',
      gitlab: { baseUrl: 'https://gitlab.example.com', project: 'group/ebs-app', targetBranch: 'develop' } })
    const save = updateLiveConfig(dir, { 'executor.maxRepairRounds': 2 })
    const [added, savedPatch] = await Promise.all([add, save])
    assert.equal(added.repo.id, 'ebs-app')
    assert.deepEqual(savedPatch.applied, ['executor.maxRepairRounds'])
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.deepEqual(saved.repos.map(repo => repo.id).sort(), ['ebs-app', 'web-app'])
    assert.equal(saved.executor.maxRepairRounds, 2)
    assert.deepEqual((await readdir(dir)).filter(name => name.endsWith('.tmp')), [])
    // The history is written by the same queue, so both snapshots are complete documents.
    const snapshots = (await readdir(join(dir, 'live-history'))).filter(name => name.endsWith('.json'))
    assert.equal(snapshots.length, 2)
    } finally { await rm(otherRepo, { recursive: true, force: true }) }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('updateLiveConfig refuses to overwrite a corrupt live.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-livejson-'))
  try {
    const file = join(dir, 'live.json')
    await writeFile(file, '{ broken')
    await assert.rejects(() => updateLiveConfig(dir, { enabled: true }), /无法读取或不是合法 JSON/)
    assert.equal(await readFile(file, 'utf8'), '{ broken')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('two concurrent settings saves both land and leave no temp file behind (D2-01)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: true, executor: { enabled: true } }))
    // Two settings groups saved back to back (two clicks, or two panel tabs): each used to read the same old file and
    // the loser's temp file collided on the pid+millisecond name, turning one save into a 500 and dropping its key.
    const results = await Promise.all([
      updateLiveConfig(dir, { 'executor.timeoutMs': 900_000 }),
      updateLiveConfig(dir, { 'executor.maxRepairRounds': 3 }),
    ])
    assert.deepEqual(results.map(result => result.applied).flat().sort(),
      ['executor.maxRepairRounds', 'executor.timeoutMs'])
    const saved = JSON.parse(await readFile(join(dir, 'live.json'), 'utf8'))
    assert.equal(saved.executor.timeoutMs, 900_000)
    assert.equal(saved.executor.maxRepairRounds, 3)
    assert.equal(saved.executor.enabled, true)
    const files = await readdir(dir)
    assert.deepEqual(files.filter(name => name.startsWith('.live-')), [])
    // Both snapshots are complete configurations, never a half-written one.
    assert.equal((await listLiveConfigHistory(dir)).length, 2)
    const snapshots = (await readdir(join(dir, 'live-history'))).filter(name => name.endsWith('.json'))
    assert.equal(snapshots.length, 2)
    for (const name of snapshots) {
      const data = JSON.parse(await readFile(join(dir, 'live-history', name), 'utf8'))
      assert.equal(data.config.executor.enabled, true)
    }
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('pollSeconds / gitlab.verifySeconds are capped so a long value cannot storm the timers (review P2)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({ enabled: false }))
    // setTimeout treats a delay above 2^31-1 ms as "fire now": a hand-edited hour-long poll became a busy loop.
    await assert.rejects(() => updateLiveConfig(dir, { pollSeconds: 3_601 }), /必须是 2–3600/)
    await assert.rejects(() => updateLiveConfig(dir, { 'gitlab.verifySeconds': 86_401 }), /必须是 30–86400/)
    // Below the engine's tick floor the reader used to round up silently; the editor now refuses the value instead.
    await assert.rejects(() => updateLiveConfig(dir, { 'gitlab.verifySeconds': 20 }), /必须是 30–86400/)
    const saved = await updateLiveConfig(dir, { pollSeconds: 3_600, 'gitlab.verifySeconds': 86_400 })
    assert.deepEqual(saved.applied.sort(), ['gitlab.verifySeconds', 'pollSeconds'])
    const loaded = loadLiveConfig(dir)
    assert.equal(loaded.config.pollSeconds, 3_600)
    assert.equal(loaded.config.gitlab.verifySeconds, 86_400)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('updateRepoDefinition refuses branch names git would read as options (review P3)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'superagent-live-json-'))
  try {
    await writeFile(join(dir, 'live.json'), JSON.stringify({
      defaultRepo: 'web-app',
      repos: [{ id: 'web-app', name: 'Web app', kind: 'web', repo: dir, baseBranch: 'develop',
        gitlab: { project: 'group/web-app', targetBranch: 'develop' } }],
    }))
    const before = await readFile(join(dir, 'live.json'), 'utf8')
    // `git fetch origin <baseBranch>` hands the value to git as an argument; `--upload-pack=…` ran a command.
    await assert.rejects(() => updateRepoDefinition(dir, 'web-app', { baseBranch: '--upload-pack=touch /tmp/pwn' }),
      /基础分支不合法/)
    await assert.rejects(() => updateRepoDefinition(dir, 'web-app', { baseBranch: 'has space' }), /基础分支不合法/)
    await assert.rejects(() => updateRepoDefinition(dir, 'web-app', { gitlab: { targetBranch: '-oProxyCommand=x' } }),
      /目标分支不合法/)
    assert.equal(await readFile(join(dir, 'live.json'), 'utf8'), before)
    const edited = await updateRepoDefinition(dir, 'web-app', { baseBranch: 'release/1.1.9' })
    assert.equal(edited.repo.baseBranch, 'release/1.1.9')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('the default bot is a settings patch and must be a Bot id', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'live-json-bot-'))
  const result = await updateLiveConfig(dir, { 'executor.bot': 'reviewer' })
  assert.deepEqual(result.applied, ['executor.bot'])
  assert.equal(JSON.parse(await readFile(join(dir, 'live.json'), 'utf8')).executor.bot, 'reviewer')
  await assert.rejects(() => updateLiveConfig(dir, { 'executor.bot': 'Reviewer' }),
    /必须是 Bot id/)
  await assert.rejects(() => updateLiveConfig(dir, { 'executor.bot': '' }), /必须是 Bot id/)
})
