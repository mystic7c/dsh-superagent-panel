import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renameDurable, syncDirectory, writeFileDurable } from './durable.js'

async function dir() { return mkdtemp(join(tmpdir(), 'superagent-durable-')) }

test('writeFileDurable writes the bytes and leaves a synced file behind', async () => {
  const stateDir = await dir()
  try {
    const file = join(stateDir, 'state.json')
    await writeFileDurable(file, '{"ok":true}\n', { mode: 0o600 })
    assert.equal(await readFile(file, 'utf8'), '{"ok":true}\n')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('renameDurable replaces the target and fsyncs the parent directory (review P3)', async () => {
  const stateDir = await dir()
  try {
    const tmp = join(stateDir, '.state-tmp.json')
    const file = join(stateDir, 'state.json')
    await writeFile(tmp, '{"v":2}\n')
    await renameDurable(tmp, file)
    // The rename landed and the directory itself was fsynced, so the new name survives a crash after this returns.
    assert.equal(await readFile(file, 'utf8'), '{"v":2}\n')
    await assert.rejects(() => stat(tmp), /ENOENT/)
    // syncDirectory must actually open the directory (a no-op would not raise for a path that does not exist).
    await syncDirectory(stateDir)
    await assert.rejects(() => syncDirectory(join(stateDir, 'missing')), /ENOENT/)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})
