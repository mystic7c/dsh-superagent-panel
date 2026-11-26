/**
 * Backend availability (worker-bots 1.5.0 §4). What dispatch asks of a backend, pinned here:
 *
 *   - dsh is available when the preset resolves in-process — no subprocess, no capability probing;
 *   - a CLI backend needs a smoke row for the *current* version, so a version bump turns `available`
 *     into `checking` instead of silently reusing stale evidence;
 *   - `--version` is cached for 30s because a save or a bots view would otherwise spawn one CLI per card.
 *
 * Everything subprocess-shaped is injected (`exec`, `version`) or landed in a temp `stateDir`, so the
 * file never spawns a CLI or touches the user's real state.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AVAILABILITY_REASONS,
  AVAILABILITY_STATES,
  BACKEND_VERIFY_FILE,
  BACKEND_VERIFY_VERSION,
  availabilityOf,
  botAvailability,
  clearVersionCache,
  cliCommandOf,
  cliVersionOf,
  needsSmoke,
  readBackendVerify,
  recordSmoke,
} from './backend-capability.js'

function config({ workers = {}, workerCommand } = {}) {
  return { executor: { workers, ...(workerCommand ? { workerCommand } : {}) } }
}

function tempDir() {
  return mkdtemp(join(tmpdir(), 'dsh-backend-capability-'))
}

/** The shape the host exposes as the `agentPresets` service. */
function hostOf(service) {
  return { get: name => (name === 'agentPresets' ? service : undefined) }
}

test('the four availability states and their shared reasons are fixed', () => {
  assert.deepEqual([...AVAILABILITY_STATES], ['available', 'unverified', 'checking', 'missing'])
  assert.deepEqual({ ...AVAILABILITY_REASONS }, {
    available: '派单可用', unverified: '没有冒烟证据', checking: '版本变了，复核中', missing: 'CLI 不在',
  })
  assert.ok(Object.isFrozen(AVAILABILITY_STATES))
  assert.ok(Object.isFrozen(AVAILABILITY_REASONS))
  assert.equal(BACKEND_VERIFY_FILE, 'backend-verify.json')
  assert.equal(BACKEND_VERIFY_VERSION, 1)
})

test('cliCommandOf prefers the worker command, then the legacy one, then the backend name', () => {
  assert.equal(cliCommandOf(config({ workers: { claude: { command: '  /opt/claude  ' } } }), 'claude'), '/opt/claude')
  // A backend that never declared its own command still runs the executor-wide one.
  assert.equal(cliCommandOf(config({ workerCommand: ' dsh  ' }), 'claude'), 'dsh')
  assert.equal(cliCommandOf(config(), 'claude'), 'claude')
  // Blank strings and non-strings are not commands.
  assert.equal(cliCommandOf(config({ workers: { claude: { command: '   ' } }, workerCommand: '' }), 'claude'), 'claude')
  assert.equal(cliCommandOf(config({ workers: { claude: { command: 42 } } }), 'claude'), 'claude')
  assert.equal(cliCommandOf(undefined, 'dsh'), 'dsh')
})

test('cliVersionOf runs `<exe> --version` and reads the version from stdout or stderr', () => {
  clearVersionCache()
  const calls = []
  const exec = (file, args, options) => {
    calls.push({ file, args, options })
    return { stdout: `claude 2.1.7 (build abc)`, stderr: '' }
  }
  const result = cliVersionOf('/opt/workers/claude --dangerously-skip-permissions', { exec })
  assert.deepEqual(calls, [{ file: '/opt/workers/claude', args: ['--version'], options: { encoding: 'utf8', timeout: 3000 } }])
  assert.equal(result.version, '2.1.7')
  assert.equal(result.missing, false)
  assert.equal(result.executable, '/opt/workers/claude')
  assert.match(result.raw, /claude 2\.1\.7/)

  // Some CLIs print the version on stderr only.
  const stderr = cliVersionOf('gemini', { exec: () => ({ stdout: '', stderr: 'gemini v0.9.0\n' }), cache: false })
  assert.equal(stderr.version, '0.9.0')

  // No version string at all: the CLI exists, it just would not tell us which version.
  const silent = cliVersionOf('quiet', { exec: () => ({ stdout: 'ok', stderr: '' }), cache: false })
  assert.deepEqual([silent.missing, silent.version], [false, undefined])
})

test('cliVersionOf: only ENOENT means the CLI is not on this machine', () => {
  clearVersionCache()
  const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })
  const missing = cliVersionOf('claude', { exec: () => ({ error: enoent }) })
  assert.equal(missing.missing, true)
  assert.equal(missing.version, undefined)
  assert.equal(missing.error, 'spawn claude ENOENT')

  // A binary that exists but fails to answer is not "missing" — it is a version we cannot read.
  const broken = cliVersionOf('claude', { exec: () => ({ error: new Error('exit 1'), stdout: '' }), cache: false })
  assert.equal(broken.missing, false)

  // A throwing exec is an error result, not an exception bubbling into the executor.
  const thrown = cliVersionOf('claude', { exec: () => { throw new Error('spawn is broken') }, cache: false })
  assert.equal(thrown.missing, false)
  assert.equal(thrown.error, 'spawn is broken')

  // An empty command never reaches the shell.
  let ran = false
  const empty = cliVersionOf('   ', { exec: () => { ran = true } })
  assert.deepEqual([empty.missing, ran], [true, false])
  assert.equal(empty.error, '未配置 CLI 命令')
})

test('cliVersionOf caches by executable for 30s so a bots view spawns one CLI, not one per card', t => {
  clearVersionCache()
  t.mock.timers.enable({ apis: ['Date'] })
  const calls = []
  const exec = () => { calls.push(Date.now()); return { stdout: 'claude 2.1.7' } }

  assert.equal(cliVersionOf('claude', { exec }).version, '2.1.7')
  // A second card within the window reuses the answer; the executable is still reported.
  const cached = cliVersionOf('claude', { exec })
  assert.equal(cached.version, '2.1.7')
  assert.equal(cached.executable, 'claude')
  assert.equal(calls.length, 1)

  t.mock.timers.tick(30_001)
  assert.equal(cliVersionOf('claude', { exec }).version, '2.1.7')
  assert.equal(calls.length, 2, 'a version read 30s ago is re-read')

  // cache:false is the escape hatch a smoke run uses to see the version right now.
  const fresh = cliVersionOf('claude', { exec, cache: false })
  assert.equal(fresh.version, '2.1.7')
  assert.equal(calls.length, 3)
  // …and it does not overwrite the cache used by the cards.
  assert.equal(cliVersionOf('claude', { exec }).version, '2.1.7')
  assert.equal(calls.length, 3)
})

test('dsh: no agentPresets service means the preset cannot be confirmed', async () => {
  assert.deepEqual(await availabilityOf({ backend: 'dsh' }), {
    backend: 'dsh', state: 'unverified', reason: '宿主未暴露 agentPresets，无法确认预设能解析',
  })
  // A host without that service is the same answer, with or without a preset to check.
  assert.equal((await availabilityOf({ backend: 'dsh', ctx: { get: () => undefined }, preset: 'coder' })).state, 'unverified')
})

test('dsh: no preset is the host default, a resolving preset is available', async () => {
  const service = {
    resolve: async name => (name === 'coder' ? { id: 'coder' } : undefined),
    list: async () => ['generalist'],
  }
  const ctx = hostOf(service)
  assert.deepEqual(await availabilityOf({ backend: 'dsh', ctx }), {
    backend: 'dsh', state: 'available', reason: '使用宿主默认预设',
  })
  // The pinned preset is part of the record so the settings card can say why.
  assert.deepEqual(await availabilityOf({ backend: 'dsh', ctx, preset: 'coder' }), {
    backend: 'dsh', state: 'available', reason: '预设 coder 可解析', preset: 'coder',
  })
})

test('dsh: a preset resolve cannot see falls back to list(), then to missing', async () => {
  const throwing = {
    resolve: async () => { throw new Error('preset not found') },
    list: async () => [{ id: 'generalist' }, { id: 'listed' }],
  }
  // resolve() rejects but list() still knows the preset: available on the list evidence.
  assert.equal((await availabilityOf({ backend: 'dsh', ctx: hostOf(throwing), preset: 'listed' })).state, 'available')
  // Unknown to both: the preset does not exist on this host.
  assert.deepEqual(await availabilityOf({ backend: 'dsh', ctx: hostOf(throwing), preset: 'ghost' }), {
    backend: 'dsh', state: 'missing', reason: '预设 ghost 不存在', preset: 'ghost',
  })
  // A service without resolve/list at all is "cannot confirm", not a crash.
  assert.equal((await availabilityOf({ backend: 'dsh', ctx: hostOf({}), preset: 'coder' })).state, 'missing')
})

test('CLI: no smoke evidence is unverified, with the CLI and version on the record', async () => {
  const cfg = config({ workers: { claude: { command: '/opt/workers/claude' } } })
  assert.deepEqual(await availabilityOf({ backend: 'claude', config: cfg, version: '2.1.7', ledger: { backends: {} } }), {
    backend: 'claude', cliPath: '/opt/workers/claude', version: '2.1.7',
    state: 'unverified', reason: '没有冒烟证据（保存后端后会自动核验一次）',
  })
})

test('CLI: evidence for the same version is available and keeps its timestamp', async () => {
  const cfg = config({ workers: { claude: { command: '/opt/workers/claude' } } })
  const ledger = { backends: { claude: { version: '2.1.7', verifiedAt: '2026-01-02T03:04:05.000Z' } } }
  assert.deepEqual(await availabilityOf({ backend: 'claude', config: cfg, version: '2.1.7', ledger }), {
    backend: 'claude', cliPath: '/opt/workers/claude', version: '2.1.7',
    state: 'available', reason: '冒烟证据有效（CLI 2.1.7）', verifiedAt: '2026-01-02T03:04:05.000Z',
  })
  // Evidence without a timestamp still proves the version; the record just has no verifiedAt.
  const bare = await availabilityOf({ backend: 'claude', config: cfg, version: '2.1.7', ledger: { backends: { claude: { version: '2.1.7' } } } })
  assert.equal(bare.state, 'available')
  assert.equal('verifiedAt' in bare, false)
})

test('CLI: a version bump turns old evidence into checking, and older evidence without a version says 未知', async () => {
  const cfg = config({ workers: { claude: { command: '/opt/workers/claude' } } })
  const bumped = await availabilityOf({
    backend: 'claude', config: cfg, version: '2.2.0',
    ledger: { backends: { claude: { version: '2.1.7', verifiedAt: '2026-01-02T03:04:05.000Z' } } },
  })
  assert.equal(bumped.state, 'checking')
  assert.equal(bumped.reason, 'CLI 版本已从 2.1.7 变为 2.2.0，旧证据失效，复核期间跳过派单')
  assert.equal('verifiedAt' in bumped, false, 'stale evidence is not shown as valid')

  const unknown = await availabilityOf({
    backend: 'claude', config: cfg, version: '2.2.0', ledger: { backends: { claude: { verifiedAt: 'x' } } },
  })
  assert.equal(unknown.state, 'checking')
  assert.match(unknown.reason, /已从 未知 变为 2\.2\.0/)
})

test('CLI: a missing CLI is missing, and an unreadable version is unverified', async () => {
  clearVersionCache()
  // availabilityOf has no exec seam: prime the 30s version cache with the injected probe instead of
  // spawning anything, then let availabilityOf consume the cached answer.
  const enoent = Object.assign(new Error('spawn /opt/workers/claude ENOENT'), { code: 'ENOENT' })
  cliVersionOf('/opt/workers/claude', { exec: () => ({ error: enoent }) })
  const cfg = config({ workers: { claude: { command: '/opt/workers/claude --flag' } } })
  const missing = await availabilityOf({ backend: 'claude', config: cfg, ledger: { backends: {} } })
  assert.equal(missing.state, 'missing')
  assert.equal(missing.reason, 'CLI 不在：/opt/workers/claude')

  // A CLI that runs but prints no version has no version to match the evidence against.
  clearVersionCache()
  cliVersionOf('/opt/workers/claude', { exec: () => ({ stdout: 'no version here' }) })
  const unreadable = await availabilityOf({
    backend: 'claude', config: cfg, ledger: { backends: { claude: { version: '2.1.7' } } },
  })
  assert.equal(unreadable.state, 'unverified')
  assert.equal(unreadable.reason, '无法读取 CLI 版本（/opt/workers/claude --version）')
  assert.equal(unreadable.cliPath, '/opt/workers/claude')
})

test('CLI: availabilityOf reads backend-verify.json from stateDir when no ledger is injected', async () => {
  const dir = await tempDir()
  try {
    assert.equal(readBackendVerify(dir).backends.claude, undefined)
    const cfg = config({ workers: { claude: { command: '/opt/workers/claude' } } })
    // Nothing recorded yet: unverified, exactly as an in-memory empty ledger.
    assert.equal((await availabilityOf({ backend: 'claude', config: cfg, stateDir: dir, version: '2.1.7' })).state, 'unverified')
    await recordSmoke(dir, 'claude', { version: '2.1.7', verifiedAt: '2026-02-03T00:00:00.000Z', command: 'claude --version' })
    // The caller's `version` is the CLI as it is now; the ledger is what was proven then.
    const current = await availabilityOf({ backend: 'claude', config: cfg, stateDir: dir, version: '2.1.7' })
    assert.equal(current.state, 'available')
    assert.equal(current.verifiedAt, '2026-02-03T00:00:00.000Z')
    assert.equal((await availabilityOf({ backend: 'claude', config: cfg, stateDir: dir, version: '2.2.0' })).state, 'checking')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('botAvailability asks about the bot\'s backend, pinning a dsh preset only for dsh', async () => {
  const service = {
    resolve: async name => (name === 'coder' ? { id: 'coder' } : undefined),
    list: async () => [],
  }
  const ctx = hostOf(service)
  assert.deepEqual(await botAvailability({ backend: 'dsh', preset: 'coder' }, { ctx }), {
    backend: 'dsh', state: 'available', reason: '预设 coder 可解析', preset: 'coder',
  })
  // A bot without a backend is a dsh bot on the host default preset.
  assert.deepEqual(await botAvailability({}, { ctx }), {
    backend: 'dsh', state: 'available', reason: '使用宿主默认预设',
  })
  // A CLI bot's `preset` is not a dsh preset and must not be resolved as one.
  const cli = await botAvailability({ backend: 'claude', preset: 'coder' },
    { config: config({ workers: { claude: { command: '/opt/workers/claude' } } }), version: '2.1.7', ledger: { backends: {} } })
  assert.equal(cli.state, 'unverified')
  assert.equal('preset' in cli, false)
  // A bot pinning a preset the host does not know cannot dispatch.
  const unknown = await botAvailability({ backend: 'dsh', preset: 'ghost' }, { ctx })
  assert.equal(unknown.state, 'missing')
})

test('readBackendVerify: a missing, corrupt or old-version file is simply empty', async () => {
  assert.deepEqual(readBackendVerify(undefined), { file: undefined, version: BACKEND_VERIFY_VERSION, backends: {} })
  const dir = await tempDir()
  try {
    assert.deepEqual(readBackendVerify(dir), { file: join(dir, BACKEND_VERIFY_FILE), version: BACKEND_VERIFY_VERSION, backends: {} })
    const file = join(dir, BACKEND_VERIFY_FILE)
    const cases = ['{ not json', '[]', 'null', JSON.stringify({ version: 0, backends: { claude: {} } }),
      JSON.stringify({ version: BACKEND_VERIFY_VERSION, backends: [] }), JSON.stringify({ version: BACKEND_VERIFY_VERSION })]
    for (const raw of cases) {
      await writeFile(file, raw)
      assert.deepEqual(readBackendVerify(dir).backends, {}, raw)
    }
    await writeFile(file, `${JSON.stringify({ version: BACKEND_VERIFY_VERSION, backends: { claude: { version: '2.1.7' } } })}\n`)
    assert.deepEqual(readBackendVerify(dir).backends, { claude: { version: '2.1.7' } })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('needsSmoke: first sight yes, a changed version yes, the proven version no', () => {
  assert.equal(needsSmoke({ backends: {} }, 'claude', '2.1.7'), true)
  assert.equal(needsSmoke(undefined, 'claude', '2.1.7'), true)
  assert.equal(needsSmoke({ backends: { claude: { version: '2.1.7' } } }, 'claude', '2.1.7'), false)
  assert.equal(needsSmoke({ backends: { claude: { version: '2.1.7' } } }, 'claude', '2.2.0'), true)
  // A version we cannot read does not become a reason to re-run a smoke that already passed.
  assert.equal(needsSmoke({ backends: { claude: { version: '2.1.7' } } }, 'claude', undefined), false)
  assert.equal(needsSmoke({ backends: {} }, 'claude', undefined), true)
})

test('recordSmoke persists one evidence row per backend and keeps the others', async () => {
  await assert.rejects(recordSmoke(undefined, 'claude', { version: '2.1.7' }), /stateDir is required/)
  const dir = await tempDir()
  try {
    const entry = await recordSmoke(dir, 'claude', {
      version: '2.1.7', verifiedAt: '2026-03-04T05:06:07.000Z', command: 'claude --version',
      summary: 'printed 2.1.7', capabilities: ['read'],
    })
    assert.deepEqual(entry, {
      backend: 'claude', version: '2.1.7', verifiedAt: '2026-03-04T05:06:07.000Z',
      command: 'claude --version', summary: 'printed 2.1.7', capabilities: ['read'],
    })
    const file = join(dir, BACKEND_VERIFY_FILE)
    const onDisk = JSON.parse(await readFile(file, 'utf8'))
    assert.equal(onDisk.version, BACKEND_VERIFY_VERSION)
    assert.deepEqual(onDisk.backends.claude, entry)
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'evidence is a private file')

    await recordSmoke(dir, 'gemini', { version: '0.9.0' })
    const merged = readBackendVerify(dir)
    assert.deepEqual(Object.keys(merged.backends).sort(), ['claude', 'gemini'])
    assert.equal(merged.backends.claude.version, '2.1.7', 'recording one backend does not drop another')
    // verifiedAt is stamped when the caller does not pass one.
    assert.match(merged.backends.gemini.verifiedAt, /^\d{4}-\d{2}-\d{2}T/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
