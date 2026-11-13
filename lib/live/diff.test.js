import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { worktreeDiff } from './diff.js'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', args, { cwd }).then(result => String(result.stdout).trim())

/** A committed base plus whatever the test writes afterwards. Returns the repo path and its base commit. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'superagent-diff-'))
  await git(root, 'init', '-b', 'dev')
  await git(root, 'config', 'user.name', 'Test')
  await git(root, 'config', 'user.email', 'test@example.com')
  await writeFile(join(root, 'base.txt'), 'one\n')
  await git(root, 'add', '-A')
  await git(root, 'commit', '-m', 'init')
  const baseSha = await git(root, 'rev-parse', 'HEAD')
  return { root, baseSha }
}

test('worktreeDiff renders tracked and untracked changes and hides forbidden paths', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'base.txt'), 'one\ntwo\n')
    await writeFile(join(f.root, 'new.txt'), 'hello\n')
    await writeFile(join(f.root, '.env'), 'SECRET=1\n')
    await writeFile(join(f.root, 'huge.txt'), 'x'.repeat(2000))
    const result = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha,
      limits: { fileSize: 512, fileBytes: 60_000, bytes: 200_000 } })
    assert.equal(result.available, true)
    assert.equal(result.baseSha, f.baseSha)
    assert.match(result.diff, /^\+two$/m)
    assert.match(result.diff, /new file mode[\s\S]*?b\/new\.txt/)
    // A local secret and an oversized untracked file are omitted, not printed.
    assert.ok(!result.diff.includes('SECRET'))
    assert.equal(result.omitted, 2)
    assert.deepEqual(result.files.map(file => file.path).sort(), ['base.txt', 'new.txt'])
    assert.equal(result.files.find(file => file.path === 'base.txt').additions, 1)
    assert.equal(result.truncated, false)

    // Per-file mode (the panel's file-row dialog): only the requested file's section comes back.
    const one = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha, path: 'base.txt' })
    assert.equal(one.path, 'base.txt')
    assert.deepEqual(one.files.map(file => file.path), ['base.txt'])
    assert.ok(!one.diff.includes('b/new.txt'))
    const untrackedOne = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha, path: 'new.txt' })
    assert.deepEqual(untrackedOne.files.map(file => file.path), ['new.txt'])
    assert.match(untrackedOne.diff, /new file mode/)
    const unknown = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha, path: 'not/a/file.txt' })
    assert.equal(unknown.available, true)
    assert.equal(unknown.diff, '')
    assert.deepEqual(unknown.files, [])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('worktreeDiff hides private keys that are tracked and untracked', async () => {
  const f = await fixture()
  try {
    await mkdir(join(f.root, 'certs'), { recursive: true })
    await writeFile(join(f.root, 'certs', 'service.key'), '-----BEGIN PRIVATE KEY-----\nMIIsecret\n')
    await git(f.root, 'add', '-A')
    await git(f.root, 'commit', '-m', 'local key material')
    await writeFile(join(f.root, 'deploy.pem'), '-----BEGIN CERTIFICATE-----\nzzz\n')
    const result = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha })
    assert.equal(result.available, true)
    assert.doesNotMatch(result.diff, /BEGIN PRIVATE KEY|MIIsecret|BEGIN CERTIFICATE/)
    assert.doesNotMatch(result.diff, /certs\/service\.key|deploy\.pem/)
    assert.deepEqual(result.files, [])
    assert.equal(result.omitted, 2)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('worktreeDiff caps one section and the whole patch, and says so', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'base.txt'), Array.from({ length: 80 }, (_, index) => `line ${index}`).join('\n') + '\n')
    const result = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha,
      limits: { fileBytes: 200, bytes: 200 } })
    assert.equal(result.available, true)
    assert.equal(result.truncated, true)
    assert.match(result.diff, /diff 已截断/)
    assert.ok(result.bytes > 0)
    assert.equal(result.files[0].truncated, true)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('worktreeDiff reports a clean worktree as an empty diff', async () => {
  const f = await fixture()
  try {
    const result = await worktreeDiff({ worktree: f.root, baseSha: f.baseSha })
    assert.equal(result.available, true)
    assert.equal(result.diff, '')
    assert.deepEqual(result.files, [])
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('worktreeDiff falls back to HEAD when the base commit is gone', async () => {
  const f = await fixture()
  try {
    await writeFile(join(f.root, 'base.txt'), 'one\nuncommitted\n')
    const result = await worktreeDiff({ worktree: f.root, baseSha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
    assert.equal(result.available, true)
    assert.equal(result.baseMissing, true)
    assert.match(result.diff, /\+uncommitted/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('worktreeDiff explains a missing or non-git worktree instead of throwing', async () => {
  const missing = join(tmpdir(), `superagent-diff-missing-${Date.now()}`)
  assert.deepEqual(await worktreeDiff({ worktree: missing }),
    { available: false, reason: 'no-worktree', worktree: resolve(missing) })
  const plain = await mkdtemp(join(tmpdir(), 'superagent-diff-plain-'))
  try {
    assert.deepEqual(await worktreeDiff({ worktree: plain }),
      { available: false, reason: 'not-a-worktree', worktree: resolve(plain) })
  } finally { await rm(plain, { recursive: true, force: true }) }
})
