import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateLiveConfig, saveOctoToken, listLiveConfigHistory, restoreLiveConfig } from './live-json.js'

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
