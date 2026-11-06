import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { updateLiveConfig } from './live-json.js'

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
