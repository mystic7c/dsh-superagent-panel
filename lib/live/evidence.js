/**
 * Durable, bounded, sanitised delivery evidence (AC-08/AC-09).
 *
 * The operation ledger is a 500-entry working window and the worktree is deleted after delivery, so neither can answer
 * "what exactly did round 3 ship and which gate failed?". This store keeps one small JSON document per Ticket with the
 * last few delivery rounds: base/head, changed-file summary, an optional truncated patch, gate commands/results,
 * the worker summary, acceptance requirements, the human decision and platform delivery facts. It is written at
 * delivery time (before cleanup) and updated when a person accepts/rejects, so later rounds can be compared.
 *
 * Sanitising is deliberate: secret-looking paths are dropped, token/password lines are redacted and every free-text
 * field is clipped, so the evidence directory is safe to read from the panel and small enough to survive forever.
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { writeFileDurable } from './durable.js'
import { join } from 'node:path'
import { filterSensitiveSections } from './diff.js'
import { sensitivePath } from './repo.js'

export const EVIDENCE_LIMITS = {
  rounds: 20,        // delivery rounds kept per Ticket
  files: 200,        // changed-file entries kept per round
  patchBytes: 24_000,
  text: 4_000,       // one summary/reason field
  path: 400,
}

const SECRET_LINE = /(["']?(?:token|password|passwd|secret|api[_-]?key|authorization|bearer|client[_-]?secret|private[_-]?key)["']?\s*[:=])/i
// Marks a patch whose secret-path sections were dropped. `updateLatest` re-sanitises the text that already carries it,
// so it is stripped before counting again (never count the same redaction twice, never stack two markers).
const REDACTION_MARK = /^# … 已移除 \d+ 个敏感路径 diff 段（未写入证据）\n/
const redactionNote = count => `# … 已移除 ${count} 个敏感路径 diff 段（未写入证据）\n`

function clip(value, limit = EVIDENCE_LIMITS.text) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
  if (!text) return ''
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
}

/** Cut a UTF-8 string at a byte budget (never split a character); the ellipsis is included in the budget. */
function clipBytes(value, limit) {
  const text = String(value ?? '')
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= limit) return { text, truncated: false, bytes: buffer.length }
  const marker = '…'
  const markerBytes = Buffer.byteLength(marker)
  const budget = Math.max(0, limit - markerBytes)
  let end = Math.min(buffer.length, budget)
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
  return { text: `${buffer.subarray(0, end).toString('utf8')}${marker}`, truncated: true,
    bytes: Buffer.byteLength(buffer.subarray(0, end).toString('utf8')) + markerBytes }
}

/** Redact whole lines that carry credentials; never try to parse them (a wrong parse leaks the value). */
export function sanitizeText(value, limit = EVIDENCE_LIMITS.text) {
  const lines = String(value ?? '').split('\n').map(line => {
    if (!SECRET_LINE.test(line)) return line
    const index = line.search(/[:=]/)
    return index >= 0 ? `${line.slice(0, index + 1)} [redacted]` : '[redacted]'
  })
  return clip(lines.join('\n'), limit)
}

const secretPath = path => sensitivePath(path)

function cleanFiles(files) {
  const seen = new Set()
  const out = []
  // A silently shortened list made a later round look as if the missing files had been deleted (review P2 AC-08/09).
  // Count what the cap and the secret screen dropped so the round can say its file list is incomplete.
  let omitted = 0
  let redacted = 0
  for (const file of Array.isArray(files) ? files : []) {
    const path = clip(typeof file === 'string' ? file : file?.path, EVIDENCE_LIMITS.path).trim()
    if (!path || seen.has(path)) continue
    if (secretPath(path)) { redacted += 1; continue }
    if (out.length >= EVIDENCE_LIMITS.files) { omitted += 1; continue }
    seen.add(path)
    out.push({
      path,
      ...(typeof file === 'object' && file?.status ? { status: clip(file.status, 20) } : {}),
      ...(Number.isFinite(file?.additions) ? { additions: file.additions } : {}),
      ...(Number.isFinite(file?.deletions) ? { deletions: file.deletions } : {}),
      ...(typeof file?.digest === 'string' && file.digest ? { digest: clip(file.digest, 64) } : {}),
    })
  }
  return { files: out, omitted, redacted }
}

function cleanGates(gates) {
  return (Array.isArray(gates) ? gates : []).slice(0, 40).map(gate => ({
    name: clip(gate?.name, 120),
    ...(gate?.command ? { command: sanitizeText(gate.command, 500) } : {}),
    state: clip(gate?.state ?? gate?.status ?? 'unknown', 30),
    ...(Number.isFinite(gate?.exitCode) ? { exitCode: gate.exitCode } : {}),
    ...(Number.isFinite(gate?.durationMs) ? { durationMs: gate.durationMs } : {}),
    ...(gate?.timedOut === true ? { timedOut: true } : {}),
    ...(gate?.missingEvidence === true ? { missingEvidence: true } : {}),
    // The code fingerprint ties a gate result to the exact tree it ran against, so a later round cannot inherit an
    // expired pass (review P1 AC-08/AC-09).
    ...(gate?.codeFingerprint ? { codeFingerprint: clip(gate.codeFingerprint, 64) } : {}),
    ...(gate?.at ? { at: clip(gate.at, 40) } : {}),
    ...(gate?.output ? { output: sanitizeText(gate.output, 800) } : {}),
  }))
}

/** Normalise one round, dropping secrets and clipping every free-text field. */
export function sanitizeRound(round = {}) {
  // A secret-looking path must drop the whole diff section, not only its row in the file list: for a key or a
  // certificate bundle the section body is the secret itself.
  const sections = filterSensitiveSections(String(round?.patch?.text ?? '').replace(REDACTION_MARK, ''))
  const carried = value => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
  const redactedSections = sections.removed + carried(round?.patch?.redacted)
  const patch = clipBytes(sanitizeText(redactedSections > 0
    ? `${redactionNote(redactedSections)}${sections.text}` : sections.text, Number.MAX_SAFE_INTEGER),
  EVIDENCE_LIMITS.patchBytes)
  const cleanedFiles = cleanFiles(round.files)
  // `updateLatest` re-sanitises an already-sanitised round to attach a human/platform decision. The dropped counts
  // cannot be recomputed from the cleaned list, so carry the earlier markers forward: otherwise an incomplete file
  // list would read as complete and a later comparison could infer files as added or deleted.
  const filesOmitted = cleanedFiles.omitted + carried(round?.filesOmitted)
  const filesRedacted = cleanedFiles.redacted + carried(round?.filesRedacted)
  const rawPr = round?.platform?.pr
  const prState = typeof rawPr === 'string' ? rawPr : clip(rawPr?.state ?? 'none', 30)
  const prIid = round?.platform?.prIid ?? (rawPr && typeof rawPr === 'object' ? rawPr.iid : undefined)
  const prUrl = round?.platform?.prUrl ?? (rawPr && typeof rawPr === 'object' ? rawPr.webUrl : undefined)
  return {
    id: clip(round.id, 120) || `ev_${Date.now()}`,
    ticketId: clip(round.ticketId, 120),
    ...(round.runId ? { runId: clip(round.runId, 120) } : {}),
    round: Number.isFinite(round.round) ? round.round : undefined,
    at: clip(round.at, 40) || new Date().toISOString(),
    ...(round.branch ? { branch: clip(round.branch, 200) } : {}),
    ...(round.baseSha ? { baseSha: clip(round.baseSha, 64) } : {}),
    ...(round.headSha ? { headSha: clip(round.headSha, 64) } : {}),
    files: cleanedFiles.files,
    ...(filesOmitted > 0 ? { filesOmitted } : {}),
    ...(filesRedacted > 0 ? { filesRedacted } : {}),
    patch: patch.text
      ? { text: patch.text, truncated: round?.patch?.truncated === true || patch.truncated,
        bytes: patch.bytes, ...(redactedSections > 0 ? { redacted: redactedSections } : {}),
        ...(Number.isFinite(round?.patch?.omitted) ? { omitted: round.patch.omitted } : {}) }
      : undefined,
    gates: cleanGates(round.gates),
    workerSummary: sanitizeText(round.workerSummary),
    acceptance: {
      requirements: (Array.isArray(round?.acceptance?.requirements) ? round.acceptance.requirements : [])
        .slice(0, 60).map(item => sanitizeText(item, 300)),
      ...(round?.acceptance?.gate ? { gate: clip(round.acceptance.gate, 200) } : {}),
    },
    ...(round.human ? { human: { decision: clip(round.human.decision, 30), note: sanitizeText(round.human.note),
      at: clip(round.human.at, 40) } } : {}),
    platform: {
      pushed: round?.platform?.pushed === true,
      pr: prState,
      ...(prIid ? { prIid } : {}),
      ...(prUrl ? { prUrl: clip(prUrl, 500) } : {}),
      // Keep the exact code version behind a deployment: dropping deployCommit was review finding P1 AC-08/AC-09.
      ...(round?.platform?.deployCommit ? { deployCommit: clip(round.platform.deployCommit, 64) } : {}),
      ...(round?.platform?.deployedSha ? { deployedSha: clip(round.platform.deployedSha, 64) } : {}),
      ...(typeof round?.platform?.matchesHead === 'boolean' ? { matchesHead: round.platform.matchesHead } : {}),
      ...(round?.platform?.deployment && typeof round.platform.deployment === 'object' ? {
        deployment: {
          ...(round.platform.deployment.pipelineId !== undefined ? { pipelineId: round.platform.deployment.pipelineId } : {}),
          ...(round.platform.deployment.state ? { state: clip(round.platform.deployment.state, 40) } : {}),
          ...(round.platform.deployment.sha ? { sha: clip(round.platform.deployment.sha, 64) } : {}),
          ...(round.platform.deployment.commit ? { commit: clip(round.platform.deployment.commit, 64) } : {}),
        },
      } : {}),
      merged: round?.platform?.merged === true,
      deployed: round?.platform?.deployed === true,
      accepted: round?.platform?.accepted === true,
    },
  }
}

function roundKey(round) {
  return round.runId ? `run:${round.runId}` : `at:${round.at}:${round.round ?? 0}`
}

const gatePassed = state => state === 'passed' || state === 'skipped'

/** Whether a round's file list is complete enough to infer additions and deletions from it. */
function completenessOf(round) {
  return {
    fileList: !((round?.filesOmitted ?? 0) > 0 || (round?.filesRedacted ?? 0) > 0),
    filesOmitted: round?.filesOmitted ?? 0,
    filesRedacted: round?.filesRedacted ?? 0,
    patchTruncated: round?.patch?.truncated === true,
  }
}

/**
 * Compare two rounds: file additions/removals/changes, gate result changes, reused/stale gate results and acceptance
 * requirement changes (AC-09). Additions/deletions are only claimed when the side they would be inferred against has a
 * complete file list — a truncated or redacted list must never read as "these files disappeared".
 */
export function compareRounds(previous, current) {
  if (!previous || !current) return undefined
  const filesOf = round => new Map((round.files ?? []).map(file => [file.path, file]))
  const before = filesOf(previous)
  const after = filesOf(current)
  const incomplete = { previous: completenessOf(previous), current: completenessOf(current) }
  const addedAll = [...after.keys()].filter(path => !before.has(path))
  const removedAll = [...before.keys()].filter(path => !after.has(path))
  const changed = [...after.keys()].filter(path => before.has(path) && JSON.stringify(before.get(path)) !== JSON.stringify(after.get(path)))
  const added = incomplete.previous.fileList ? addedAll : []
  const removed = incomplete.current.fileList ? removedAll : []
  const gatesBefore = new Map((previous.gates ?? []).map(gate => [gate.name, gate]))
  const gatesAfter = new Map((current.gates ?? []).map(gate => [gate.name, gate]))
  const names = [...new Set([...gatesBefore.keys(), ...gatesAfter.keys()])]
  const gates = names
    .map(name => ({ name, from: gatesBefore.get(name)?.state ?? 'absent', to: gatesAfter.get(name)?.state ?? 'absent' }))
    .filter(gate => gate.from !== gate.to)
  const gateRows = names.map(name => ({ name, before: gatesBefore.get(name), after: gatesAfter.get(name) }))
  // A gate whose state and timestamp are identical in both rounds was not rerun; if the code moved between the rounds,
  // that reused result belongs to the old tree and must not be presented as a pass for this one.
  const codeChanged = Boolean(previous.headSha && current.headSha && previous.headSha !== current.headSha)
  const reused = gateRows.filter(row => Boolean(row.before && row.after && row.before.at && row.after.at
    && row.before.at === row.after.at && row.before.state === row.after.state)).map(row => row.name)
  const requirementsOf = round => new Set(round?.acceptance?.requirements ?? [])
  const reqBefore = requirementsOf(previous)
  const reqAfter = requirementsOf(current)
  return {
    from: previous.id,
    to: current.id,
    baseline: { from: previous.baseSha ?? null, to: current.baseSha ?? null,
      changed: Boolean(previous.baseSha && current.baseSha && previous.baseSha !== current.baseSha) },
    incomplete,
    files: { added, removed, changed },
    filesUncertain: {
      added: incomplete.previous.fileList ? [] : addedAll,
      removed: incomplete.current.fileList ? [] : removedAll,
    },
    gates,
    gatesNotRun: [...gatesBefore.keys()].filter(name => !gatesAfter.has(name)),
    gatesReused: reused,
    gatesStale: codeChanged ? reused : [],
    gatesUnfinished: [...gatesAfter.entries()].filter(([, gate]) => !gatePassed(gate.state))
      .map(([name, gate]) => ({ name, state: gate.state ?? 'unknown' })),
    acceptance: {
      added: [...reqAfter].filter(item => !reqBefore.has(item)),
      removed: [...reqBefore].filter(item => !reqAfter.has(item)),
    },
  }
}

/**
 * AC-08: a readable JSON file is not automatically a usable evidence document. A hand-edited/corrupted file may lack
 * `rounds`; normalising here keeps every reader (`get`/`list`/`compare`/the API) total and marks the loss instead of
 * throwing a TypeError out of the panel.
 */
function normalizeEvidenceDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || typeof doc.ticketId !== 'string') return undefined
  const rounds = Array.isArray(doc.rounds) ? doc.rounds.filter(round => round && typeof round === 'object') : []
  const normalized = { ...doc, rounds }
  if (!Array.isArray(doc.rounds) || rounds.length !== doc.rounds.length) normalized.recovered = true
  return normalized
}

export class EvidenceStore {
  constructor(stateDir, { limits } = {}) {
    this.dir = join(stateDir, 'evidence')
    this.limits = { ...EVIDENCE_LIMITS, ...(limits ?? {}) }
    this.loaded = false
    this.documents = new Map()
  }

  fileOf(ticketId) {
    return join(this.dir, `${String(ticketId).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120)}.json`)
  }

  async load() {
    await mkdir(this.dir, { recursive: true })
    this.documents = new Map()
    for (const name of await readdir(this.dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const doc = normalizeEvidenceDocument(JSON.parse(await readFile(join(this.dir, name), 'utf8')))
        if (doc) this.documents.set(doc.ticketId, doc)
      } catch { /* a damaged evidence file is skipped, never fatal for the engine */ }
    }
    this.loaded = true
    return this
  }

  get(ticketId) {
    const doc = this.documents.get(ticketId)
    return doc ? { ...doc, rounds: [...doc.rounds] } : undefined
  }

  list() {
    return [...this.documents.values()].map(doc => ({ ticketId: doc.ticketId, updatedAt: doc.updatedAt,
      rounds: doc.rounds.length, ...(doc.recovered ? { recovered: true } : {}) }))
      .sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)))
  }

  /** Append or replace one round (same runId replaces, so a retry of the same run does not create noise). */
  async record(ticketId, round, { updatedAt } = {}) {
    await mkdir(this.dir, { recursive: true })
    const clean = sanitizeRound({ ...round, ticketId })
    const doc = this.documents.get(ticketId) ?? { ticketId, rounds: [], updatedAt: clean.at }
    const key = roundKey(clean)
    const rounds = doc.rounds.filter(item => roundKey(item) !== key)
    rounds.push(clean)
    rounds.sort((left, right) => String(left.at).localeCompare(String(right.at)))
    doc.rounds = rounds.slice(-this.limits.rounds)
    // A human decision touches the record without inventing a new delivery round: `at` keeps the delivery time,
    // while `updatedAt` (the list's sort key) moves to the moment of the touch.
    doc.updatedAt = updatedAt ?? clean.at
    const file = this.fileOf(ticketId)
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    try {
      await writeFileDurable(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
      await rename(tmp, file)
    } finally {
      // A failed write/rename must not leave a `.tmp` file behind for the next load to count as evidence.
      await rm(tmp, { force: true }).catch(() => {})
    }
    this.documents.set(ticketId, doc)
    return clean
  }

  /** Human decision/platform updates attach to the latest round (never invent a delivery round). */
  async updateLatest(ticketId, patch = {}) {
    const doc = this.documents.get(ticketId)
    const latest = doc?.rounds?.at(-1)
    if (!latest) return undefined
    return this.record(ticketId, {
      ...latest,
      human: patch.human ?? latest.human,
      platform: { ...(latest.platform ?? {}), ...(patch.platform ?? {}) },
      acceptance: { ...(latest.acceptance ?? {}), ...(patch.acceptance ?? {}) },
    }, { updatedAt: new Date().toISOString() })
  }

  compare(ticketId, fromId, toId) {
    const doc = this.documents.get(ticketId)
    if (!doc) return undefined
    const from = fromId ? doc.rounds.find(round => round.id === fromId) : doc.rounds.at(-2)
    const to = toId ? doc.rounds.find(round => round.id === toId) : doc.rounds.at(-1)
    if (!from || !to) return undefined
    return { ...compareRounds(from, to), missing: doc.rounds.length < 2 || undefined }
  }
}
