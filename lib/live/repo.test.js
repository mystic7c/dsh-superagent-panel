import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { prepareWorktree, removeWorktree, changedPaths, forbiddenPath, commitAll, pushBranch, assertSafeWorktree,
  assertFeatureBranch, assertTicketId, parseStatus, RepoError, parseMergeRequestFromPush } from './repo.js'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', args, { cwd }).then(result => String(result.stdout).trim())

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'superagent-repo-'))
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  const worktreeRoot = join(root, 'worktrees')
  await git(root, 'init', '--bare', origin)
  await git(root, 'init', '-b', 'dev', repo)
  await git(repo, 'config', 'user.name', 'Test')
  await git(repo, 'config', 'user.email', 'test@example.com')
  await writeFile(join(repo, 'README.md'), 'hello\n')
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-m', 'init')
  await git(repo, 'remote', 'add', 'origin', origin)
  await git(repo, 'push', '-u', 'origin', 'dev')
  return { root, origin, repo, worktreeRoot }
}

test('prepareWorktree creates a feature worktree from origin/dev and reuses it', async () => {
  const f = await fixture()
  try {
    const first = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test001' })
    assert.equal(first.branch, 'feature/tkt_test001')
    assert.equal(first.reused, false)
    assert.equal(await git(first.path, 'rev-parse', '--abbrev-ref', 'HEAD'), 'feature/tkt_test001')
    const second = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test001' })
    assert.equal(second.reused, true)
    assert.equal(second.path, first.path)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('changedPaths sees committed and uncommitted paths, and forbiddenPath catches secrets', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test002' })
    await mkdir(join(prepared.path, 'ebs'), { recursive: true })
    await writeFile(join(prepared.path, 'ebs', 'Validator.java'), 'class Validator {}\n')
    await writeFile(join(prepared.path, '.env'), 'SECRET=1\n')
    const paths = await changedPaths(prepared.path, prepared.baseSha)
    assert.ok(paths.includes('ebs/Validator.java'))
    assert.ok(paths.includes('.env'))
    assert.equal(forbiddenPath(paths), '.env')
    assert.equal(forbiddenPath(['ebs/Validator.java']), undefined)
    assert.match(parseStatus('?? a.txt\0')[0].path, /a\.txt/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('changedPaths keeps the first character of the first modified path', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test005' })
    await writeFile(join(prepared.path, 'README.md'), 'changed\n')
    const paths = await changedPaths(prepared.path, prepared.baseSha)
    assert.ok(paths.includes('README.md'), JSON.stringify(paths))
    assert.equal(paths.find(path => path !== 'README.md'), undefined)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('changedPaths refuses a forbidden path that is the first status entry', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test006' })
    // `.env` sorts first in git status; the status column is a leading space that must not be trimmed away.
    await writeFile(join(prepared.path, '.env'), 'SECRET=1\n')
    const paths = await changedPaths(prepared.path, prepared.baseSha)
    assert.ok(paths.includes('.env'), JSON.stringify(paths))
    assert.equal(forbiddenPath(paths), '.env')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('commitAll and pushBranch push a feature branch to the remote', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test003' })
    await writeFile(join(prepared.path, 'fix.txt'), 'fixed\n')
    await assertSafeWorktree({ cwd: prepared.path, branch: prepared.branch, featurePrefix: 'feature/', baseSha: prepared.baseSha })
    const commit = await commitAll({ cwd: prepared.path, message: 'EBS-999: fix: test change' })
    assert.equal(commit.subject, 'EBS-999: fix: test change')
    const pushed = await pushBranch({ cwd: prepared.path, branch: prepared.branch, featurePrefix: 'feature/' })
    assert.equal(pushed.pushed, true)
    const remoteBranches = await git(f.origin, 'branch', '--list')
    assert.match(remoteBranches, /feature\/tkt_test003/)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('assertSafeWorktree refuses forbidden paths and protected branches', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test004' })
    await writeFile(join(prepared.path, '.flyway-args.txt'), 'password\n')
    await assert.rejects(() => assertSafeWorktree({ cwd: prepared.path, branch: prepared.branch, featurePrefix: 'feature/', baseSha: prepared.baseSha }),
      error => error instanceof RepoError && error.code === 'forbidden-path')
    assert.throws(() => assertFeatureBranch('dev', 'feature/'), /protected/)
    assert.throws(() => assertFeatureBranch('feature/../dev', 'feature/'), /unsafe/)
    assert.throws(() => assertTicketId('bad id!'), /unsafe/)
    assert.equal(assertTicketId('tkt_ok-1'), 'tkt_ok-1')
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('parseMergeRequestFromPush extracts created and new-MR URLs', () => {
  assert.deepEqual(parseMergeRequestFromPush('remote: View merge request for feature/x: https://gitlab.example/g/p/-/merge_requests/42\n'),
    { webUrl: 'https://gitlab.example/g/p/-/merge_requests/42', iid: 42 })
  const created = parseMergeRequestFromPush('remote: https://gitlab.example/g/p/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx')
  assert.equal(created.created, false)
  assert.match(created.webUrl, /merge_requests\/new/)
  assert.equal(parseMergeRequestFromPush('nothing here'), undefined)
})

test('pushBranch dry run shows push options and never touches the remote', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_test007' })
    await writeFile(join(prepared.path, 'readme.txt'), 'x\n')
    const dry = await pushBranch({ cwd: prepared.path, branch: prepared.branch, featurePrefix: 'feature/', dryRun: true,
      pushOptions: ['merge_request.create', 'merge_request.target=dev'] })
    assert.equal(dry.dryRun, true)
    assert.ok(dry.argv.includes('-o'))
    assert.ok(dry.argv.includes('merge_request.create'))
    assert.ok(dry.argv.includes('merge_request.target=dev'))
    assert.equal(await git(f.origin, 'branch', '--list').then(result => result.includes('tkt_test007')), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})

test('removeWorktree deletes the worktree and its local feature branch', async () => {
  const f = await fixture()
  try {
    const prepared = await prepareWorktree({ repo: f.repo, worktreeRoot: f.worktreeRoot, baseBranch: 'dev',
      featurePrefix: 'feature/', ticketId: 'tkt_cleanup' })
    const result = await removeWorktree({ repo: f.repo, path: prepared.path, branch: prepared.branch })
    assert.deepEqual(result, { worktreeRemoved: true, branchRemoved: true, branchKept: false })
    assert.equal(await git(f.repo, 'show-ref', '--verify', '--quiet', `refs/heads/${prepared.branch}`).then(() => true, () => false), false)
  } finally { await rm(f.root, { recursive: true, force: true }) }
})
