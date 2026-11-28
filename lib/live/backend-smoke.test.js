import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { readBackendVerify } from './backend-capability.js'
import { runBackendSmoke, smokeArgs, SMOKE_TIMEOUT_MS } from './backend-smoke.js'

/** A fake CLI process: `emit` controls stdout and the exit code, so success/failure/timeout stay deterministic. */
function fakeSpawn({ output = '', code = 0, hang = false } = {}) {
  return () => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => { child.killed = true }
    setTimeout(() => {
      if (hang) return
      if (output) child.stdout.write(output)
      child.emit('close', code)
    }, 5)
    return child
  }
}

/** A real executable for the version probe (`<cli> --version`), so cliVersionOf resolves without network or PATH. */
function fakeCli(version = '1.2.3') {
  const dir = mkdtempSync(join(tmpdir(), 'smoke-cli-'))
  const file = join(dir, 'claude')
  writeFileSync(file, `#!/bin/sh\necho ${version}\n`)
  chmodSync(file, 0o755)
  return file
}

test('smokeArgs pins the read-only one-line run for each CLI', () => {
  assert.deepEqual(smokeArgs('claude'), ['-p', 'Reply with exactly: ok', '--output-format', 'text'])
  const codex = smokeArgs('codex')
  assert.equal(codex[0], 'exec')
  assert.ok(codex.includes('--skip-git-repo-check'))
  assert.ok(codex.includes('read-only'))
  assert.equal(smokeArgs('dsh'), undefined)
})

test('a CLI that answers records versioned evidence (§4)', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'smoke-state-'))
  const command = fakeCli('2.1.329')
  const result = await runBackendSmoke('claude', {
    config: { executor: { workers: { claude: { command } } } }, stateDir, spawnImpl: fakeSpawn({ output: 'ok\n' }),
  })
  assert.equal(result.ok, true)
  const ledger = readBackendVerify(stateDir)
  assert.equal(ledger.backends.claude.version, '2.1.329')
  assert.equal(ledger.backends.claude.command, command)
})

test('a non-zero exit is a failure and records no evidence', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'smoke-state-'))
  const command = fakeCli()
  const result = await runBackendSmoke('claude', {
    config: { executor: { workers: { claude: { command } } } }, stateDir, spawnImpl: fakeSpawn({ code: 3, output: 'nope' }),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /退出码 3/)
  assert.deepEqual(readBackendVerify(stateDir).backends, {})
})

test('a silent CLI is killed at the deadline, and the last line says why', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'smoke-state-'))
  const command = fakeCli()
  const startedAt = Date.now()
  const result = await runBackendSmoke('claude', {
    config: { executor: { workers: { claude: { command } } } }, stateDir, spawnImpl: fakeSpawn({ hang: true }), timeoutMs: 40,
  })
  assert.equal(result.ok, false)
  assert.ok(Date.now() - startedAt < 2000)
  assert.match(result.reason, /超过 0 秒没有回答/)
  assert.deepEqual(readBackendVerify(stateDir).backends, {})
  assert.equal(SMOKE_TIMEOUT_MS, 60000)
})

test('a missing CLI never spawns and records nothing', async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'smoke-state-'))
  const result = await runBackendSmoke('codex', {
    config: { executor: { workers: { codex: { command: join(tmpdir(), 'no-such-codex-binary') } } } },
    stateDir, spawnImpl: fakeSpawn(),
  })
  assert.equal(result.ok, false)
  assert.match(result.reason, /CLI 不在/)
  assert.deepEqual(readBackendVerify(stateDir).backends, {})
})
