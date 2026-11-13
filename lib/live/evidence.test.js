import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EvidenceStore, compareRounds, sanitizeRound, sanitizeText, EVIDENCE_LIMITS } from './evidence.js'

const dir = () => mkdtemp(join(tmpdir(), 'superagent-evidence-'))

test('evidence keeps bounded sanitised rounds across a reload and survives worktree cleanup', async () => {
  const stateDir = await dir()
  try {
    const store = new EvidenceStore(stateDir, { limits: { rounds: 3 } })
    await store.load()
    await store.record('tkt_1', { id: 'ev_1', runId: 'run_1', at: '2026-11-01T00:00:00.000Z', branch: 'feature/tkt_1',
      baseSha: 'base', headSha: 'head',
      files: [{ path: '.env.local' }, { path: 'secrets/token.txt' }, { path: 'src/A.java', additions: 2 },
        { path: 'src/.env.example' }],
      patch: { text: 'diff\n-PASSWORD=hunter2\n+API_KEY=abcd\nnormal line', truncated: false },
      gates: [{ name: 'backend', command: 'mvn verify', state: 'passed', exitCode: 0, durationMs: 12 }],
      workerSummary: 'done. token=abc',
      acceptance: { requirements: ['backend'] },
      platform: { pushed: true, pr: { state: 'waiting', webUrl: 'https://x/pull/new/1' }, merged: false, deployed: false, accepted: false } })
    const round = store.get('tkt_1').rounds[0]
    // Any `.env*` path is dropped, including the harmless example: path-based screening errs on the safe side.
    assert.deepEqual(round.files.map(file => file.path), ['src/A.java'])
    // Three `.env*`/secret paths were screened out; the round says so instead of silently losing them.
    assert.equal(round.filesRedacted, 3)
    assert.doesNotMatch(round.patch.text, /hunter2|abcd/)
    assert.match(round.patch.text, /redacted/)
    assert.doesNotMatch(round.workerSummary, /abc$/)
    assert.equal(round.platform.pr, 'waiting')
    assert.equal(round.platform.prUrl, 'https://x/pull/new/1')
    assert.equal(round.platform.pushed, true)
    assert.equal(round.gates[0].command, 'mvn verify')
    const reloaded = new EvidenceStore(stateDir, { limits: { rounds: 3 } })
    await reloaded.load()
    assert.equal(reloaded.get('tkt_1').rounds.length, 1)
    // Round cap: the oldest is dropped, the latest is readable.
    for (let index = 2; index <= 5; index += 1) {
      await reloaded.record('tkt_1', { id: `ev_${index}`, runId: `run_${index}`, at: `2026-11-0${index}T00:00:00.000Z`, files: [] })
    }
    assert.deepEqual(reloaded.get('tkt_1').rounds.map(item => item.id), ['ev_3', 'ev_4', 'ev_5'])
    assert.equal((await readdir(join(stateDir, 'evidence'))).filter(name => name.endsWith('.tmp')).length, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('delivery evidence stays readable after the operation ledger passes its retention window', async () => {
  const stateDir = await dir()
  try {
    const store = new EvidenceStore(stateDir)
    await store.load()
    await store.record('tkt_1', { id: 'ev_1', runId: 'run_1', files: [{ path: 'A.java' }] })
    // operations.js keeps at most 500 runs; evidence is a separate file, so a long ledger must not evict it.
    const items = {}
    const order = []
    for (let index = 0; index < 500; index += 1) {
      const id = `op_${index}`
      items[id] = { id, ticketId: 'tkt_1', status: 'done' }
      order.push(id)
    }
    await writeFile(join(stateDir, 'operations.json'), JSON.stringify({ schemaVersion: 1, items, order }))
    const reloaded = new EvidenceStore(stateDir)
    await reloaded.load()
    assert.equal(reloaded.get('tkt_1').rounds[0].id, 'ev_1')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a damaged evidence file is skipped, not fatal', async () => {
  const stateDir = await dir()
  try {
    await mkdir(join(stateDir, 'evidence'), { recursive: true })
    await writeFile(join(stateDir, 'evidence', 'broken.json'), '{broken')
    const store = new EvidenceStore(stateDir)
    await store.load()
    assert.equal(store.list().length, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a syntactically valid but malformed evidence file is normalised and marked, not a crash', async () => {
  const stateDir = await dir()
  try {
    await mkdir(join(stateDir, 'evidence'), { recursive: true })
    await writeFile(join(stateDir, 'evidence', 'missing-rounds.json'), JSON.stringify({ ticketId: 'tkt_schema' }))
    await writeFile(join(stateDir, 'evidence', 'bad-rounds.json'), JSON.stringify({ ticketId: 'tkt_text', rounds: 'nope' }))
    const store = new EvidenceStore(stateDir)
    await store.load()
    assert.deepEqual(store.get('tkt_schema').rounds, [])
    assert.equal(store.get('tkt_schema').recovered, true)
    assert.deepEqual(store.get('tkt_text').rounds, [])
    const listed = store.list()
    assert.deepEqual(listed.map(item => item.ticketId).sort(), ['tkt_schema', 'tkt_text'])
    assert.ok(listed.every(item => item.rounds === 0 && item.recovered === true))
    // The repaired in-memory document still accepts a new round instead of throwing on `rounds.push`.
    await store.record('tkt_schema', { id: 'ev_new', runId: 'run_new', files: [] })
    assert.equal(store.get('tkt_schema').rounds.length, 1)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('compareRounds reports file, gate and acceptance changes without claiming a fix', () => {
  const previous = sanitizeRound({ id: 'a', at: '2026-11-01T00:00:00.000Z', files: [{ path: 'A.java' }, { path: 'B.java' }],
    gates: [{ name: 'backend', state: 'failed' }, { name: 'lint', state: 'passed' }], acceptance: { requirements: ['backend'] } })
  const current = sanitizeRound({ id: 'b', at: '2026-11-02T00:00:00.000Z', files: [{ path: 'A.java', additions: 4 }, { path: 'C.java' }],
    gates: [{ name: 'backend', state: 'passed' }, { name: 'lint', state: 'passed' }],
    acceptance: { requirements: ['backend', 'frontend'] } })
  const diff = compareRounds(previous, current)
  assert.deepEqual(diff.files.added, ['C.java'])
  assert.deepEqual(diff.files.removed, ['B.java'])
  assert.deepEqual(diff.files.changed, ['A.java'])
  assert.deepEqual(diff.gates, [{ name: 'backend', from: 'failed', to: 'passed' }])
  assert.deepEqual(diff.acceptance.added, ['frontend'])
  assert.equal(compareRounds(previous, undefined), undefined)
})

test('patch and summary caps stay visible when truncated', () => {
  const long = 'x'.repeat(EVIDENCE_LIMITS.patchBytes + 100)
  const round = sanitizeRound({ id: 'ev', ticketId: 'tkt', patch: { text: long }, workerSummary: 'y'.repeat(5000) })
  assert.equal(round.patch.truncated, true)
  assert.ok(Buffer.byteLength(round.patch.text, 'utf8') <= EVIDENCE_LIMITS.patchBytes)
  assert.ok(round.patch.bytes <= EVIDENCE_LIMITS.patchBytes)
  assert.equal(round.workerSummary.length, EVIDENCE_LIMITS.text)
  assert.equal(sanitizeText('a\nAuthorization: Bearer x'), 'a\nAuthorization: [redacted]')
})

test('JSON credentials and multi-byte patches are redacted and byte-bounded', () => {
  const secret = sanitizeRound({ id: 'ev', patch: { text: 'normal\n{"password": "example-secret"}\nclient_secret: abc123' } })
  assert.doesNotMatch(secret.patch.text, /example-secret|abc123/)
  assert.match(secret.patch.text, /redacted/)
  const wide = sanitizeRound({ id: 'ev', patch: { text: '中'.repeat(20_000) } })
  assert.equal(wide.patch.truncated, true)
  assert.ok(Buffer.byteLength(wide.patch.text, 'utf8') <= EVIDENCE_LIMITS.patchBytes)
})

test('a sensitive path removes its whole patch section, not just its file row', async () => {
  const text = [
    'diff --git a/certs/service.key b/certs/service.key',
    '--- a/certs/service.key',
    '+++ b/certs/service.key',
    '@@ -0,0 +1,2 @@',
    '+-----BEGIN PRIVATE KEY-----',
    '+MIIsecret',
    'diff --git a/src/A.java b/src/A.java',
    '--- a/src/A.java',
    '+++ b/src/A.java',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '',
  ].join('\n')
  const round = sanitizeRound({ id: 'ev_1', files: [{ path: 'certs/service.key' }, { path: 'src/A.java' }], patch: { text } })
  assert.doesNotMatch(round.patch.text, /BEGIN PRIVATE KEY|MIIsecret/)
  assert.doesNotMatch(round.patch.text, /certs\/service\.key/)
  assert.match(round.patch.text, /src\/A\.java/)
  assert.equal(round.filesRedacted, 1)
  assert.equal(round.patch.redacted, 1)

  // The redaction survives persistence and a later human decision, without stacking markers or counts.
  const stateDir = await dir()
  try {
    const store = new EvidenceStore(stateDir)
    await store.load()
    await store.record('tkt_1', round)
    await store.updateLatest('tkt_1', { human: { decision: 'accepted', at: '2026-11-02T00:00:00.000Z' } })
    const reloaded = new EvidenceStore(stateDir)
    await reloaded.load()
    const persisted = reloaded.get('tkt_1').rounds[0]
    assert.equal(persisted.patch.redacted, 1)
    assert.equal((persisted.patch.text.match(/敏感路径/g) ?? []).length, 1)
    assert.doesNotMatch(persisted.patch.text, /MIIsecret/)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('updateLatest keeps the confirmed PR id/url after a human decision', async () => {
  const stateDir = await dir()
  try {
    const store = new EvidenceStore(stateDir)
    await store.load()
    await store.record('tkt_1', { id: 'ev_1', runId: 'run_1', at: '2026-11-01T00:00:00.000Z',
      platform: { pushed: true, pr: 'waiting', prUrl: 'https://x/pull/new/1' } })
    const updated = await store.updateLatest('tkt_1', { platform: { pr: 'open', prIid: 9,
      prUrl: 'https://github.com/o/r/pull/9' }, human: { decision: 'accepted', at: '2026-11-02T00:00:00.000Z' } })
    assert.equal(updated.platform.pr, 'open')
    assert.equal(updated.platform.prIid, 9)
    assert.equal(updated.platform.prUrl, 'https://github.com/o/r/pull/9')
    assert.equal(updated.human.decision, 'accepted')
    const reloaded = new EvidenceStore(stateDir)
    await reloaded.load()
    assert.equal(reloaded.get('tkt_1').rounds.at(-1).platform.prIid, 9)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('updateLatest keeps the omitted/redacted file markers of an already-sanitised round', async () => {
  const stateDir = await dir()
  try {
    const store = new EvidenceStore(stateDir)
    await store.load()
    // Exactly the cap of kept files, plus one over the cap and one secret path: both markers are set on each round.
    const base = Array.from({ length: EVIDENCE_LIMITS.files }, (_, index) => ({ path: `src/F${index}.java` }))
    await store.record('tkt_1', { id: 'ev_1', runId: 'run_1', at: '2026-11-01T00:00:00.000Z', baseSha: 'base-1',
      headSha: 'head-1', files: [...base, { path: 'src/Extra1.java' }, { path: 'secrets/token.txt' }] })
    await store.record('tkt_1', { id: 'ev_2', runId: 'run_2', at: '2026-11-02T00:00:00.000Z', baseSha: 'base-2',
      headSha: 'head-2', files: [...base.slice(0, -1), { path: 'src/NewFile.java' }, { path: 'src/Extra2.java' },
        { path: 'secrets/token.txt' }] })
    const latest = store.get('tkt_1').rounds.at(-1)
    assert.equal(latest.filesOmitted, 1)
    assert.equal(latest.filesRedacted, 1)
    // Attaching a human decision re-sanitises the round: the counts must survive and stay idempotent.
    const updated = await store.updateLatest('tkt_1', { human: { decision: 'accepted', at: '2026-11-03T00:00:00.000Z' } })
    assert.equal(updated.filesOmitted, 1)
    assert.equal(updated.filesRedacted, 1)
    const reloaded = new EvidenceStore(stateDir)
    await reloaded.load()
    const persisted = reloaded.get('tkt_1').rounds.at(-1)
    assert.equal(persisted.filesOmitted, 1)
    assert.equal(persisted.filesRedacted, 1)
    // An incomplete list must not be compared as if it were complete: the extra files stay uncertain, not added.
    const diff = reloaded.compare('tkt_1', 'ev_1', 'ev_2')
    assert.equal(diff.incomplete.previous.fileList, false)
    assert.equal(diff.incomplete.current.fileList, false)
    assert.deepEqual(diff.files.added, [])
    assert.deepEqual(diff.files.removed, [])
    assert.deepEqual(diff.filesUncertain.added, ['src/NewFile.java'])
    assert.deepEqual(diff.filesUncertain.removed, ['src/F199.java'])
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('the same path with a different digest still counts as changed', () => {
  const previous = sanitizeRound({ id: 'a', files: [{ path: 'src/A.java', digest: 'aaaaaaaaaaaaaaaa' }] })
  const current = sanitizeRound({ id: 'b', files: [{ path: 'src/A.java', digest: 'bbbbbbbbbbbbbbbb' }] })
  assert.deepEqual(compareRounds(previous, current).files.changed, ['src/A.java'])
})

test('a failed atomic write leaves no tmp file behind', async () => {
  const stateDir = await dir()
  try {
    // The target path is a directory, so rename(tmp, file) fails; the cleanup must remove the tmp file.
    await mkdir(join(stateDir, 'evidence', 'tkt_1.json'), { recursive: true })
    const store = new EvidenceStore(stateDir)
    await store.load()
    await assert.rejects(() => store.record('tkt_1', { id: 'ev_1', at: '2026-11-01T00:00:00.000Z' }))
    assert.equal((await readdir(join(stateDir, 'evidence'))).filter(name => name.endsWith('.tmp')).length, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('the evidence pack keeps the deployed code version and the gate code fingerprint', () => {
  const round = sanitizeRound({ id: 'ev', ticketId: 'tkt',
    gates: [{ name: 'backend', state: 'passed', codeFingerprint: 'cafebabe', missingEvidence: false }],
    platform: { pushed: true, pr: 'open', prIid: 9, merged: true, deployed: true,
      deployCommit: 'merge-123', deployedSha: 'merge-123', matchesHead: true,
      deployment: { pipelineId: 42, state: 'success', sha: 'merge-123', commit: 'merge-123' } } })
  assert.equal(round.platform.deployCommit, 'merge-123')
  assert.equal(round.platform.deployedSha, 'merge-123')
  assert.equal(round.platform.matchesHead, true)
  assert.equal(round.platform.deployment.pipelineId, 42)
  assert.equal(round.gates[0].codeFingerprint, 'cafebabe')
})

test('a truncated file list is marked and never reads as deletions', () => {
  const many = Array.from({ length: EVIDENCE_LIMITS.files + 3 }, (_, index) => ({ path: `src/File${index}.java` }))
  const round = sanitizeRound({ id: 'ev', files: many })
  assert.equal(round.files.length, EVIDENCE_LIMITS.files)
  assert.equal(round.filesOmitted, 3)
  const previous = { id: 'a', baseSha: 'base-1', headSha: 'head-1', files: [{ path: 'A.java' }], filesOmitted: 3,
    gates: [{ name: 'backend', state: 'passed', at: '2026-11-01T00:00:00.000Z', codeFingerprint: 'old' }] }
  const current = { id: 'b', baseSha: 'base-2', headSha: 'head-2', files: [{ path: 'A.java' }, { path: 'C.java' }],
    gates: [{ name: 'backend', state: 'passed', at: '2026-11-01T00:00:00.000Z', codeFingerprint: 'old' },
      { name: 'lint', state: 'failed' }] }
  const diff = compareRounds(previous, current)
  // The previous list was truncated, so C.java may have existed there: it is uncertain, not an addition.
  assert.deepEqual(diff.files.added, [])
  assert.deepEqual(diff.filesUncertain.added, ['C.java'])
  assert.deepEqual(diff.files.removed, [])
  assert.equal(diff.incomplete.previous.fileList, false)
  assert.equal(diff.baseline.changed, true)
  assert.deepEqual(diff.gatesReused, ['backend'])
  assert.deepEqual(diff.gatesStale, ['backend'])
  assert.deepEqual(diff.gatesUnfinished, [{ name: 'lint', state: 'failed' }])
})

test('a truncated current file list does not read as deletions either', () => {
  const previous = { id: 'a', files: [{ path: 'A.java' }, { path: 'B.java' }] }
  const current = { id: 'b', files: [{ path: 'A.java' }], filesOmitted: 1 }
  const diff = compareRounds(previous, current)
  assert.deepEqual(diff.files.removed, [])
  assert.deepEqual(diff.filesUncertain.removed, ['B.java'])
})

test('two identical rounds claim no file changes', () => {
  const files = [{ path: 'src/A.java', digest: 'aaaaaaaaaaaaaaaa' }]
  const previous = sanitizeRound({ id: 'a', runId: 'run_1', at: '2026-11-01T00:00:00.000Z', files,
    gates: [{ name: 'backend', state: 'passed', codeFingerprint: 'aaaa' }] })
  const current = sanitizeRound({ id: 'b', runId: 'run_2', at: '2026-11-02T00:00:00.000Z', files,
    gates: [{ name: 'backend', state: 'passed', codeFingerprint: 'aaaa' }] })
  const diff = compareRounds(previous, current)
  assert.deepEqual(diff.files, { added: [], removed: [], changed: [] })
  assert.deepEqual(diff.gates, [])
  assert.deepEqual(diff.acceptance, { added: [], removed: [] })
})
