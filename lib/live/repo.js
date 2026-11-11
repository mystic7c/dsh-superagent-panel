/**
 * Git worktree management and branch guards for the executor. All commands run through execFile (no shell), so ticket
 * titles can never become shell syntax. The forbidden-branch checks here are the last line of defence: even if a model
 * asks to push to dev, the executor refuses before touching the remote.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

const run = promisify(execFile)

/** Branches the executor must never push to or commit on. */
export const PROTECTED_BRANCHES = ['dev', 'develop', 'main', 'master']

/** A refusal raised before any destructive git operation; `code` is stable for the panel and tests. */
export class RepoError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

/** File patterns the executor refuses to push: secrets, generated output, local tool state, EBS write scripts. */
export const FORBIDDEN_PATH_PATTERNS = [
  /(^|\/)\.env($|\.)/, /(^|\/)secrets\//, /(^|\/)\.flyway-args\.txt$/, /(^|\/)node_modules\//,
  /(^|\/)logs\//, /(^|\/)graphify-out\//, /(^|\/)\.DS_Store$/, /(^|\/)\.history\//,
  /^db\/apps\//,
]

/** Run one git command in `cwd`; returns trimmed stdout. */
export async function git(args, cwd, { timeoutMs = 120_000, trim = true } = {}) {
  const { stdout } = await run('git', args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
  const text = String(stdout)
  // Porcelain -z output starts with a status column that can be a space; trimming would corrupt the first path.
  return trim ? text.trim() : text
}

/** Assert that `repo` is a git work tree and return its top-level path. */
export async function ensureRepo(repo) {
  if (typeof repo !== 'string' || !repo) throw new RepoError('repo-unset', 'repo path is not configured')
  let top
  try { top = await git(['rev-parse', '--show-toplevel'], repo, { timeoutMs: 20_000 }) }
  catch { throw new RepoError('repo-invalid', `${repo} is not a git work tree`) }
  return top
}

/** Validate a ticket id used as a branch/worktree name; keeps names filesystem- and git-safe. */
export function assertTicketId(ticketId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,48}$/.test(ticketId)) throw new RepoError('ticket-id', `unsafe ticket id: ${ticketId}`)
  return ticketId
}

/** Validate a feature branch name and refuse protected branches. */
export function assertFeatureBranch(branch, featurePrefix) {
  if (typeof branch !== 'string' || !branch) throw new RepoError('branch-name', 'branch name is empty')
  if (PROTECTED_BRANCHES.some(protectedName => branch === protectedName || branch.startsWith(`${protectedName}/`))) {
    throw new RepoError('branch-protected', `refusing to use protected branch ${branch}`)
  }
  if (!branch.startsWith(featurePrefix)) throw new RepoError('branch-prefix', `branch ${branch} does not start with ${featurePrefix}`)
  if (!/^[A-Za-z0-9._/-]{3,120}$/.test(branch) || branch.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw new RepoError('branch-name', `unsafe branch name: ${branch}`)
  }
  return branch
}

/**
 * Create (or reuse) one ticket worktree based on the current remote base branch.
 * @returns {{path:string, branch:string, baseRef:string, baseSha:string, reused:boolean}}
 */
export async function prepareWorktree({ repo, worktreeRoot, baseBranch, featurePrefix, ticketId, timeoutMs = 180_000 }) {
  assertTicketId(ticketId)
  await ensureRepo(repo)
  const branch = assertFeatureBranch(`${featurePrefix}${ticketId}`, featurePrefix)
  await mkdir(worktreeRoot, { recursive: true })
  // git reports canonical paths; resolve the symlinked macOS /var path so an existing worktree is detected.
  const root = realpathSync(worktreeRoot)
  const path = join(root, ticketId)
  let baseRef = `origin/${baseBranch}`
  let baseSha
  try {
    await git(['fetch', 'origin', baseBranch], repo, { timeoutMs })
    baseSha = await git(['rev-parse', baseRef], repo)
  } catch {
    baseRef = baseBranch
    baseSha = await git(['rev-parse', baseRef], repo)
  }
  const listed = await git(['worktree', 'list', '--porcelain'], repo)
  const existing = listed.split('\n\n').find(block => block.includes(`\nworktree ${path}`) || block.startsWith(`worktree ${path}`))
  if (existing) {
    const currentBranch = (existing.split('\n').find(line => line.startsWith('branch refs/heads/')) ?? '').replace('branch refs/heads/', '')
    if (currentBranch !== branch) throw new RepoError('worktree-conflict', `worktree ${path} exists on branch ${currentBranch}, expected ${branch}`)
    return { path, branch, baseRef, baseSha, reused: true }
  }
  const branchExists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo).then(() => true, () => false)
  if (branchExists) await git(['worktree', 'add', path, branch], repo, { timeoutMs })
  else await git(['worktree', 'add', '-b', branch, path, baseRef], repo, { timeoutMs })
  return { path, branch, baseRef, baseSha, reused: false }
}

/** Remove a ticket worktree and (optionally) its local branch; report whether each one actually disappeared. */
export async function removeWorktree({ repo, path, branch, keepBranch = false, timeoutMs = 120_000 }) {
  await ensureRepo(repo)
  let worktreeRemoved = false
  let branchRemoved = false
  let branchKept = false
  if (typeof path === 'string' && path) {
    try { await git(['worktree', 'remove', '--force', path], repo, { timeoutMs }); worktreeRemoved = true } catch { /* already gone */ }
    if (!worktreeRemoved && !existsSync(path)) worktreeRemoved = true
  }
  if (keepBranch) branchKept = Boolean(branch)
  else if (typeof branch === 'string' && branch) {
    if (PROTECTED_BRANCHES.includes(branch)) branchKept = true
    else {
      try {
        await git(['branch', '-D', branch], repo, { timeoutMs })
        branchRemoved = true
      } catch { /* already gone or checked out elsewhere */ }
      if (!branchRemoved) {
        const exists = await git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], repo).then(() => true, () => false)
        if (!exists) branchRemoved = true
      }
    }
  }
  return { worktreeRemoved, branchRemoved, branchKept }
}

/** Parse `git status --porcelain=v1 -z` into [{status, path, originalPath?}] (renames are split by NUL). */
export function parseStatus(raw) {
  const parts = String(raw ?? '').split('\0').filter(Boolean)
  const entries = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = entry.slice(3)
    if (status.includes('R') || status.includes('C')) {
      const originalPath = parts[index + 1]
      if (originalPath !== undefined) index += 1
      entries.push({ status, path, originalPath })
    } else entries.push({ status, path })
  }
  return entries
}

/** Every path the ticket touched: committed since base, staged, unstaged and untracked. */
export async function changedPaths(cwd, baseSha) {
  const paths = new Set()
  const status = parseStatus(await git(['status', '--porcelain=v1', '-z'], cwd, { trim: false }))
  for (const entry of status) {
    // An untracked directory is reported as `?? dir/`; expand it below so path guards see the files.
    if (entry.status.trim() === '??') continue
    paths.add(entry.path)
    if (entry.originalPath) paths.add(entry.originalPath)
  }
  for (const path of (await git(['ls-files', '--others', '--exclude-standard', '-z'], cwd, { trim: false })).split('\0').filter(Boolean)) paths.add(path)
  if (baseSha) {
    try {
      for (const path of (await git(['diff', '--name-only', `${baseSha}...HEAD`], cwd)).split('\n').filter(Boolean)) paths.add(path)
    } catch { /* base unknown: status alone is enough to block secrets */ }
  }
  return [...paths].sort()
}

/** Return the first forbidden path, or undefined when every path is allowed. `extraPatterns` adds repository rules. */
export function forbiddenPath(paths, extraPatterns = []) {
  const patterns = extraPatterns.length ? [...FORBIDDEN_PATH_PATTERNS, ...extraPatterns] : FORBIDDEN_PATH_PATTERNS
  for (const path of paths) if (patterns.some(pattern => pattern.test(path))) return path
  return undefined
}

/** Current branch name of a worktree. */
export async function currentBranch(cwd) {
  return git(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
}

/** Whether the worktree has any change (staged, unstaged or untracked). */
export async function hasChanges(cwd) {
  return (await git(['status', '--porcelain=v1', '-z'], cwd)).length > 0
}

/** Stage everything and commit; returns {sha, subject}. */
export async function commitAll({ cwd, message, authorName = 'Superagent', authorEmail = 'superagent@local' }) {
  const safe = String(message ?? '').trim()
  if (!safe) throw new RepoError('commit-message', 'commit message is empty')
  await git(['add', '-A'], cwd)
  await git(['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', safe], cwd)
  return { sha: await git(['rev-parse', 'HEAD'], cwd), subject: safe.split('\n')[0] }
}

/**
 * Extract the merge-request URL GitLab prints after a push-option creation (or the new-MR URL).
 *
 * GitHub has no push-option MR creation: it ignores the `merge_request.*` options and prints a
 * "Create a pull request ... visiting: https://github.com/<owner>/<repo>/pull/new/<branch>" line instead.
 * That URL is not an existing PR, so it is returned as a pending MR (`created: false`): the Ticket then
 * reaches `mr-open`/`ci-pending` instead of the in-flight `pushed`, which keeps it visible to the
 * manual-repository verification loop (a person still has to open and merge the PR).
 */
export function parseMergeRequestFromPush(output) {
  const text = String(output ?? '')
  const created = /(https?:\/\/[^\s]+\/-\/merge_requests\/(\d+))/.exec(text)
  if (created) return { webUrl: created[1], iid: Number(created[2]) }
  const create = /(https?:\/\/[^\s]*\/merge_requests\/new\?[^\s]*)/.exec(text)
  if (create) return { webUrl: create[1], iid: undefined, created: false }
  // GitHub: `pull/new/<branch>` is the create-PR page; strip trailing punctuation the remote may append.
  const githubCreate = /(https?:\/\/[^\s]+\/pull\/new\/[^\s]+)/.exec(text)
  if (githubCreate) return { webUrl: githubCreate[1].replace(/[.,;:)\]]+$/, ''), iid: undefined, created: false }
  return undefined
}

/** Push one feature branch; refuses protected branches and force pushes. `pushOptions` map to `git push -o` flags. */
export async function pushBranch({ cwd, branch, featurePrefix, dryRun = false, timeoutMs = 180_000, pushOptions = [] }) {
  assertFeatureBranch(branch, featurePrefix)
  const options = pushOptions.flatMap(option => ['-o', String(option)])
  if (dryRun) return { dryRun: true, argv: ['git', 'push', '-u', 'origin', branch, ...options] }
  const { stdout, stderr } = await run('git', ['push', '-u', 'origin', branch, ...options], { cwd, timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024 })
  const output = `${String(stdout)}\n${String(stderr)}`
  return { pushed: true, branch, sha: await git(['rev-parse', 'HEAD'], cwd), output,
    mergeRequest: parseMergeRequestFromPush(output) }
}

/** Full local safeguard for one prepared ticket: no protected branch, no forbidden paths. */
export async function assertSafeWorktree({ cwd, branch, featurePrefix, baseSha, extraPatterns = [] }) {
  assertFeatureBranch(branch, featurePrefix)
  const current = await currentBranch(cwd)
  if (current !== branch) throw new RepoError('branch-mismatch', `worktree is on ${current}, expected ${branch}`)
  const paths = await changedPaths(cwd, baseSha)
  const forbidden = forbiddenPath(paths, extraPatterns)
  if (forbidden) throw new RepoError('forbidden-path', `refusing to push forbidden path: ${forbidden}`)
  return { branch, paths }
}
