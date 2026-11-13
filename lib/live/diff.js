/**
 * Read-only unified diff for the panel's "what changed" view.
 *
 * The executor deliberately does not persist the patch: while the run keeps its worktree, the worktree is the source
 * of truth, and storing every patch would bloat the operation ledger. So the panel asks this module for the diff of
 * one Ticket's worktree against the run's base commit. Everything here is read-only, shell-free (execFile with argv
 * arrays) and capped — an operator must be able to read what the worker did without the host becoming a file server.
 *
 * Two git behaviours matter:
 *  - `git diff <base>` compares the working tree (staged + unstaged) to that commit, so it also covers changes the
 *    executor committed on the branch after the base.
 *  - untracked files never appear in that diff, so they are rendered one by one through `git diff --no-index`.
 */
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parseStatus, sensitivePath } from './repo.js'

const exec = promisify(execFile)

/** Caps that keep one huge generated file from freezing the panel or the response. */
export const DIFF_LIMITS = {
  bytes: 200_000,      // total patch text returned
  fileBytes: 60_000,   // one file's section
  files: 60,           // sections
  fileSize: 512_000,   // untracked file read from disk (bigger ones are reported as omitted, not read)
}

const TRUNCATED_MARK = '\n# … diff 已截断（文件过大）\n'

function gitText(cwd, args, { allowExitCodes = [0], maxBuffer = 16 * 1024 * 1024, timeoutMs = 20_000 } = {}) {
  return exec('git', args, { cwd, timeout: timeoutMs, maxBuffer,
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } })
    .then(({ stdout }) => String(stdout))
    .catch((error) => {
      if (allowExitCodes.includes(error?.code)) return String(error.stdout ?? '')
      throw error
    })
}

/** Split one `diff --git` blob into per-file sections (the header line starts every section). */
function sectionsOf(text) {
  const raw = String(text ?? '')
  if (!raw.trim()) return []
  return raw.split(/^(?=diff --git )/m).filter(section => section.startsWith('diff --git '))
}

/**
 * Repository-relative path of one section. Parsed from the `---`/`+++` lines rather than the `diff --git` header so a
 * filename with spaces does not split into an ambiguous a/b pair; a new file's `--- /dev/null` loses to its `+++ b/x`,
 * a deleted file's `+++ /dev/null` loses to its `--- a/x`.
 */
function sectionPath(section) {
  const lines = String(section ?? '').split('\n')
  const side = prefix => lines.find(line => line.startsWith(prefix))?.slice(4).trim()
  const strip = value => value && value !== '/dev/null'
    ? value.replace(/^[ab]\//, '') : undefined
  const added = strip(side('+++ '))
  if (added) return added
  const removed = strip(side('--- '))
  if (removed) return removed
  // A binary patch still carries both sides; fall back to the header only when neither side survives.
  const match = /^diff --git (?:a\/)?(.+?) (?:b\/)?(.+)$/.exec(String(section ?? '').split('\n', 1)[0] ?? '')
  return match ? match[2].trim() : undefined
}

/**
 * Remove whole sections whose file is secret-looking. Screening only the file list would keep the section body, which
 * for a private key or a certificate bundle *is* the secret. Returns the kept text and how many sections were dropped,
 * so a persisted evidence pack can mark itself incomplete instead of pretending the patch is whole.
 */
export function filterSensitiveSections(value) {
  const text = String(value ?? '')
  if (!text.includes('diff --git ')) return { text, removed: 0 }
  const kept = []
  let removed = 0
  for (const chunk of text.split(/(?=^diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) { kept.push(chunk); continue }
    const file = sectionPath(chunk)
    if (file && sensitivePath(file)) { removed += 1; continue }
    kept.push(chunk)
  }
  return { text: kept.join(''), removed }
}

/** Added/removed line counts of one section (headers excluded, binary diffs flagged). */
function statsOf(section) {
  let additions = 0
  let deletions = 0
  let binary = false
  for (const line of String(section ?? '').split('\n')) {
    if (line.startsWith('Binary files ')) binary = true
    else if (line.startsWith('+++ ') || line.startsWith('--- ')) continue
    else if (line.startsWith('+')) additions += 1
    else if (line.startsWith('-')) deletions += 1
  }
  return { additions, deletions, binary }
}

/** Cut a section at a line boundary at most `limit` characters long. */
function cutAtLine(text, limit) {
  const value = String(text ?? '')
  if (value.length <= limit) return value
  const head = value.slice(0, limit)
  const newline = head.lastIndexOf('\n')
  return newline > 0 ? head.slice(0, newline + 1) : head
}

/**
 * Diff one worktree against its base commit, read-only.
 * `path` narrows the result to one repository-relative file (the panel's per-file dialog); it only ever matches a path
 * git itself reported, so it cannot be used to read an arbitrary file.
 * → { available, reason?, worktree?, path?, baseSha, baseMissing?, diff, files[], bytes, truncated, omitted }
 * `available:false` reasons: no-worktree | not-a-worktree | git-failed.
 */
export async function worktreeDiff({ worktree, baseSha, path: onlyPath, limits } = {}) {
  const caps = { ...DIFF_LIMITS, ...(limits ?? {}) }
  if (typeof worktree !== 'string' || !worktree.trim()) return { available: false, reason: 'no-worktree' }
  const path = resolve(worktree)
  if (!existsSync(path)) return { available: false, reason: 'no-worktree', worktree: path }
  const wanted = typeof onlyPath === 'string' && onlyPath.trim() && onlyPath.length <= 1024 ? onlyPath.trim() : undefined
  let inside
  try {
    inside = (await gitText(path, ['rev-parse', '--is-inside-work-tree'])).trim()
  } catch {
    return { available: false, reason: 'not-a-worktree', worktree: path }
  }
  if (inside !== 'true') return { available: false, reason: 'not-a-worktree', worktree: path }

  // Tracked changes: base commit → working tree. A vanished base (garbage-collected history) falls back to HEAD so the
  // operator still sees the uncommitted part, and the response says the base was missing rather than pretending.
  let tracked = ''
  let base = typeof baseSha === 'string' && baseSha.trim() ? baseSha.trim() : undefined
  try {
    tracked = await gitText(path, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff',
      ...(base ? [base] : [])])
  } catch {
    try {
      tracked = await gitText(path, ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', 'HEAD'])
      base = undefined
    } catch {
      return { available: false, reason: 'git-failed', worktree: path }
    }
  }

  // Untracked files: rendered as new-file sections; forbidden paths (secrets, tool state) are omitted on purpose.
  let omitted = 0
  const untracked = []
  try {
    const status = await gitText(path, ['status', '--porcelain', '-z', '--untracked-files=all'])
    for (const entry of parseStatus(status).filter(item => item.status === '??')) {
      const relative = String(entry.path ?? '')
      if (wanted && relative !== wanted) continue
      if (!relative || sensitivePath(relative)) { omitted += 1; continue }
      const absolute = resolve(path, relative)
      if (absolute !== path && !absolute.startsWith(path + sep)) { omitted += 1; continue }
      let size
      try { size = statSync(absolute).size } catch { continue }
      if (size > caps.fileSize) { omitted += 1; continue }
      try {
        const piece = await gitText(path, ['-c', 'core.quotePath=false', 'diff', '--no-index', '--no-color',
          '--', '/dev/null', relative], { allowExitCodes: [0, 1] })
        if (piece.trim()) untracked.push(piece)
      } catch { omitted += 1 }
    }
  } catch {
    // An untracked listing that fails only loses the new files; the tracked part is still worth showing.
  }

  const all = [...sectionsOf(tracked), ...untracked]
  // Per-file mode: keep exactly the requested file (an unknown/missing path yields an empty patch, not a 404).
  const scoped = wanted ? all.filter(section => sectionPath(section) === wanted) : all
  const kept = []
  const files = []
  let remaining = Math.max(1000, caps.bytes)
  let truncated = false
  for (const section of scoped) {
    const file = sectionPath(section)
    // A tracked secret-looking path (e.g. a committed local secret or key) is hidden here as well.
    if (file && sensitivePath(file)) { omitted += 1; continue }
    if (kept.length >= Math.max(1, caps.files)) { omitted += 1; truncated = true; continue }
    const stats = statsOf(section)
    let piece = section
    let wasCut = false
    if (piece.length > caps.fileBytes) { piece = cutAtLine(piece, caps.fileBytes) + TRUNCATED_MARK; wasCut = true; truncated = true }
    if (piece.length > remaining) {
      if (remaining < 2000) { omitted += 1; truncated = true; continue }
      piece = cutAtLine(piece, remaining) + TRUNCATED_MARK
      remaining = 0
      wasCut = true
      truncated = true
    } else {
      remaining -= piece.length
    }
    kept.push(piece.endsWith('\n') ? piece : `${piece}\n`)
    if (file) files.push({ path: file, additions: stats.additions, deletions: stats.deletions,
      digest: createHash('sha256').update(section).digest('hex').slice(0, 16),
      ...(stats.binary ? { binary: true } : {}), ...(wasCut ? { truncated: true } : {}) })
  }

  const diff = kept.join('')
  return { available: true, worktree: path, ...(wanted ? { path: wanted } : {}), baseSha: base ?? null,
    ...(base === undefined && baseSha ? { baseMissing: true } : {}),
    diff, files, bytes: Buffer.byteLength(diff), truncated, omitted }
}
