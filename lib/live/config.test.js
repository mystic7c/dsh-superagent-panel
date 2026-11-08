import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadLiveConfig, redactedLiveConfig, readToken, defaultLiveConfig } from './config.js'

async function dir() { return mkdtemp(join(tmpdir(), 'superagent-config-')) }

test('missing live.json yields disabled defaults', async () => {
  const stateDir = await dir()
  try {
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.exists, false)
    assert.equal(loaded.config.enabled, false)
    assert.equal(loaded.config.paused, false)
    assert.equal(loaded.config.baseBranch, 'dev')
    assert.equal(loaded.config.octo.watchChatIds.length, 0)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('reads values, merges defaults and resolves token files', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'octo.token'), ' bf_test\n')
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ enabled: true, paused: true, repo: '/tmp/repo',
      octo: { watchChatIds: ['chat-1', ''], tokenFile: join(stateDir, 'octo.token') },
      gitlab: { targetBranch: 'dev' }, executor: { enabled: false, gates: ['backend', 'bogus'], timeoutMs: 1000 } }))
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.exists, true)
    assert.equal(loaded.config.enabled, true)
    assert.equal(loaded.config.paused, true)
    assert.equal(loaded.config.repo, '/tmp/repo')
    assert.deepEqual(loaded.config.octo.watchChatIds, ['chat-1'])
    assert.equal(loaded.config.executor.enabled, false)
    assert.deepEqual(loaded.config.executor.gates, ['backend'])
    assert.equal(loaded.config.executor.timeoutMs, defaultLiveConfig(stateDir).executor.timeoutMs)
    assert.equal(loaded.tokens.octo, 'bf_test')
    assert.equal(loaded.tokens.octoSource, 'file')
    assert.equal(loaded.tokens.gitlab, undefined)
    const view = redactedLiveConfig(loaded)
    assert.equal(view.paused, true)
    assert.equal(view.octo.tokenConfigured, true)
    assert.equal(view.octo.tokenSource, 'file')
    assert.equal(view.octo.tokenFile, undefined)
    assert.equal(JSON.stringify(view).includes('bf_test'), false)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('invalid JSON reports an error without throwing', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'live.json'), '{not json')
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.exists, true)
    assert.match(loaded.error, /not valid JSON/)
    assert.equal(loaded.config.enabled, false)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('readToken returns undefined for missing or empty files', async () => {
  const stateDir = await dir()
  try {
    assert.equal(readToken(join(stateDir, 'nope')), undefined)
    await writeFile(join(stateDir, 'empty'), '  \n')
    assert.equal(readToken(join(stateDir, 'empty')), undefined)
    await writeFile(join(stateDir, 'ok'), 'abc\n')
    assert.equal(readToken(join(stateDir, 'ok')), 'abc')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a repos array becomes two normalised repositories with their own gates and tokens', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'gitlab.token'), 'token-ml\n')
    await writeFile(join(stateDir, 'gitlab-ebs.token'), 'token-ebs\n')
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({
      enabled: true,
      defaultRepo: 'web-app',
      octo: { chatRepos: { 'chat-ml': 'web-app', 'chat-ebs': 'ebs', 'chat-unknown': 'nope' } },
      repos: [
        { id: 'web-app', name: 'web-app', repo: '/repo/web-app', baseBranch: 'dev', featurePrefix: 'feature/',
          gitlab: { project: 'group/project-a', targetBranch: 'dev', tokenFile: join(stateDir, 'gitlab.token'),
            uatUrl: 'https://uat.example/', healthUrl: 'https://uat.example/health', verifySeconds: 120 } },
        { id: 'ebs', name: 'ebs', kind: 'oracle-ebs', repo: '/repo/ebs', baseBranch: 'develop', featurePrefix: 'feature/',
          gitlab: { project: 'group/project-b', targetBranch: 'develop', tokenFile: join(stateDir, 'gitlab-ebs.token'), ci: false },
          prepareCommand: 'python3 scripts/local/export_cux_objects.py',
          postGatesCommand: 'python3 scripts/local/export_cux_objects.py',
          gates: [{ name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py --changed --base develop',
            dryRunCommand: 'python3 scripts/local/deploy_object.py --changed --base develop --dry-run', timeoutMs: 1_800_000 }] },
      ],
    }))
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.config.repos.length, 2)
    assert.equal(loaded.config.defaultRepo, 'web-app')
    // Unknown chat bindings are dropped instead of silently routing a ticket to a missing repository.
    assert.deepEqual(loaded.config.octo.chatRepos, { 'chat-ml': 'web-app', 'chat-ebs': 'ebs' })
    const [ml, ebs] = loaded.config.repos
    assert.equal(ml.verifyMode, 'web-uat')
    assert.equal(ml.acceptance, 'deployed')
    assert.equal(ml.gates[0].name, 'standards')
    assert.equal(ml.gitlab.uatUrl, 'https://uat.example/')
    assert.equal(ebs.kind, 'oracle-ebs')
    assert.equal(ebs.verifyMode, 'manual')
    assert.equal(ebs.acceptance, 'merged')
    assert.equal(ebs.gitlab.targetBranch, 'develop')
    assert.equal(ebs.gitlab.ci, false)
    assert.equal(ebs.gates[0].name, 'ebs-deploy')
    assert.match(ebs.gates[0].dryRunCommand, /--dry-run/)
    assert.equal(ebs.prepareCommand, 'python3 scripts/local/export_cux_objects.py')
    assert.equal(loaded.tokens.repoTokens['web-app'], 'token-ml')
    assert.equal(loaded.tokens.repoTokens.ebs, 'token-ebs')

    const view = redactedLiveConfig(loaded)
    assert.deepEqual(view.repos.map(repo => repo.id), ['web-app', 'ebs'])
    assert.equal(view.repos[1].tokenConfigured, true)
    assert.equal(view.repos[1].verifyMode, 'manual')
    assert.equal(view.repos[1].repo, '/repo/ebs')
    // Legacy single-repository fields mirror the first repository and never expose token file paths.
    assert.equal(view.repo, '/repo/web-app')
    assert.equal(view.gitlab.project, 'group/project-a')
    assert.equal('tokenFile' in view.gitlab, false)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a legacy single-repository file still yields one normalised repository with the UAT surface', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'gitlab.token'), 'legacy\n')
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ repo: '/repo/legacy', baseBranch: 'dev',
      gitlab: { project: 'g/p', targetBranch: 'dev', uatUrl: 'https://uat.legacy/', healthUrl: 'https://uat.legacy/health' } }))
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.config.repos.length, 1)
    assert.equal(loaded.config.repos[0].id, 'p')
    assert.equal(loaded.config.repos[0].gitlab.uatUrl, 'https://uat.legacy/')
    assert.equal(loaded.config.defaultRepo, 'p')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('executor worker backend is merged, defaulted and redacted', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ executor: {
      workerBackend: 'codex', workerModel: 'gpt-6-astra', workerCommand: '/opt/codex' } }))
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.config.executor.workerBackend, 'codex')
    assert.equal(loaded.config.executor.workerModel, 'gpt-6-astra')
    assert.equal(loaded.config.executor.workerCommand, '/opt/codex')
    assert.equal(redactedLiveConfig(loaded).executor.workerBackend, 'codex')

    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ executor: { workerBackend: 'nope' } }))
    assert.equal(loadLiveConfig(stateDir).config.executor.workerBackend, 'dsh')
    await writeFile(join(stateDir, 'live.json'), '{}')
    assert.equal(loadLiveConfig(stateDir).config.executor.workerBackend, 'dsh')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('decision model config merges, defaults the token file and redacts the secret', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'decision.token'), 'sk-decision\n')
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ eval: { mode: 'shadow', decision: {
      endpoint: 'https://judge.example/v1/systemone', model: ' decision-model-preview ', timeoutMs: 2500,
      acceptAt: 0.85, rejectAt: 0.15, maxPerPoll: 4, concurrency: 3 } } }))
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.config.eval.mode, 'shadow')
    assert.equal(loaded.config.eval.decision.endpoint, 'https://judge.example/v1/systemone')
    assert.equal(loaded.config.eval.decision.model, 'decision-model-preview')
    assert.equal(loaded.config.eval.decision.timeoutMs, 2500)
    assert.equal(loaded.config.eval.decision.acceptAt, 0.85)
    assert.equal(loaded.config.eval.decision.rejectAt, 0.15)
    assert.equal(loaded.config.eval.decision.maxPerPoll, 4)
    assert.equal(loaded.config.eval.decision.concurrency, 3)
    // The token file defaults into the state directory and is read from there.
    assert.equal(loaded.config.eval.decision.tokenFile, join(stateDir, 'decision.token'))
    assert.equal(loaded.tokens.decision, 'sk-decision')
    assert.equal(loaded.tokens.decisionSource, 'file')
    const view = redactedLiveConfig(loaded)
    assert.equal(view.eval.mode, 'shadow')
    assert.equal(view.eval.decision.tokenConfigured, true)
    assert.equal(view.eval.decision.tokenSource, 'file')
    assert.equal('tokenFile' in view.eval.decision, false)
    assert.equal(JSON.stringify(view).includes('sk-decision'), false)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('invalid eval values fall back to the defaults instead of being trusted', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ eval: { mode: 'bogus', decision: {
      endpoint: 7, model: 7, timeoutMs: 10, acceptAt: 2, rejectAt: -1, maxPerPoll: -3, concurrency: 9 } } }))
    const loaded = loadLiveConfig(stateDir)
    const defaults = defaultLiveConfig(stateDir).eval.decision
    assert.equal(loaded.config.eval.mode, 'rules')
    assert.equal(loaded.config.eval.decision.endpoint, defaults.endpoint)
    assert.equal(loaded.config.eval.decision.model, defaults.model)
    assert.equal(loaded.config.eval.decision.timeoutMs, defaults.timeoutMs)
    assert.equal(loaded.config.eval.decision.acceptAt, defaults.acceptAt)
    assert.equal(loaded.config.eval.decision.rejectAt, defaults.rejectAt)
    assert.equal(loaded.config.eval.decision.maxPerPoll, defaults.maxPerPoll)
    // Out-of-range values are clamped to the documented bounds instead of being written through.
    assert.equal(loaded.config.eval.decision.concurrency, 4)
    // DECISION_TOKEN is the environment fallback, mirroring OCTO_TOKEN / GITLAB_TOKEN.
    delete process.env.DECISION_TOKEN
    process.env.DECISION_TOKEN = 'sk-env'
    try {
      await writeFile(join(stateDir, 'live.json'), '{}')
      const fromEnv = loadLiveConfig(stateDir)
      assert.equal(fromEnv.tokens.decision, 'sk-env')
      assert.equal(fromEnv.tokens.decisionSource, 'env')
    } finally { delete process.env.DECISION_TOKEN }
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('hybrid mode and riskAt are merged for the intake gate', async () => {
  const stateDir = await dir()
  try {
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ eval: { mode: 'hybrid', decision: {
      endpoint: 'https://judge.example/v1/systemone', model: 'decision-model-preview',
      acceptAt: 0.9, rejectAt: 0.1, riskAt: 0.6, maxPerPoll: 5 } } }))
    const loaded = loadLiveConfig(stateDir)
    assert.equal(loaded.config.eval.mode, 'hybrid')
    assert.equal(loaded.config.eval.decision.acceptAt, 0.9)
    assert.equal(loaded.config.eval.decision.rejectAt, 0.1)
    assert.equal(loaded.config.eval.decision.riskAt, 0.6)
    assert.equal(loaded.config.eval.decision.maxPerPoll, 5)
    // An out-of-range riskAt falls back to the default instead of being trusted.
    await writeFile(join(stateDir, 'live.json'), JSON.stringify({ eval: { mode: 'hybrid', decision: { riskAt: 7 } } }))
    assert.equal(loadLiveConfig(stateDir).config.eval.decision.riskAt, 0.5)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})
