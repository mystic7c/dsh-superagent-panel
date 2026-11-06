import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTicket, gateCommands, workerBrief, workerTask, mergeRequestDescription, runCommand,
  refreshTicketCi, injectTicket, publishTicket, checkUat, commitMessageFor, uatFingerprint, checkMerged, verifyTicket,
  reconcileTicketFromGitlab } from './executor.js'
import { readFile } from 'node:fs/promises'

const config = {
  enabled: true,
  repo: '/tmp/repo', baseBranch: 'dev', featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', pollSeconds: 10,
  octo: { watchChatIds: ['chat-1'], channelType: 2, allowSenderIds: [], cliPath: '/bin/true' },
  gitlab: { baseUrl: 'https://gitlab.example', project: 'g/p', targetBranch: 'dev', createMr: 'api' },
  eval: { mode: 'rules' },
  executor: { enabled: true, allowPush: true, allowReply: false, gates: ['standards', 'backend', 'frontend'],
    timeoutMs: 60_000, gateTimeoutMs: 60_000, model: null },
}

function makeEngine(overrides = {}) {
  const ticket = {
    id: 'tkt_test', title: '银行账户必填校验', body: '修复：保存收款单时校验银行账户必填', status: 'queued',
    createdAt: '2026-11-04T00:00:00.000Z', updatedAt: '2026-11-04T00:00:00.000Z', assignments: [],
    origin: { channelId: 'chat-1', channelType: 2, triggerId: 'trg_1', decisionId: 'dec_1', threadKey: 'octo:chat-1' },
    links: { branch: null, mergeRequest: null, pipeline: null }, ...overrides.ticket,
  }
  const doc = { tickets: { [ticket.id]: ticket }, runs: [] }
  const engine = {
    readConfig: () => ({ exists: true, config, tokens: { octo: 'tok', gitlab: undefined }, error: undefined }),
    state: { tickets: doc.tickets, runs: doc.runs, atomic: async (mutate) => mutate(doc) },
  }
  return { engine, ticket, doc }
}

function fakeDeps(overrides = {}) {
  const calls = { commands: [], pushes: [], commits: [] }
  return {
    calls,
    deps: {
      prepareWorktree: async () => ({ path: '/tmp/wt/tkt_test', branch: 'feature/tkt_test', baseFound: true, baseSha: 'abc123',
        reused: false }),
      runWorker: async () => ({ sessionId: 'worker-tkt_test', timedOut: false, text: '改了 validator 并跑了单测', toolCalls: ['bash', 'edit'] }),
      changedPaths: async () => ['ebs/ebs-ar/src/main/java/X.java'],
      runCommand: async (command) => { calls.commands.push(command); return { exitCode: 0, timedOut: false, durationMs: 5, output: 'ok' } },
      hasChanges: async () => true,
      commitAll: async () => { calls.commits.push(true); return { sha: 'deadbeef', subject: 'fix: x' } },
      assertSafeWorktree: async () => ({ paths: [] }),
      pushBranch: async () => { calls.pushes.push(true); return { pushed: true, branch: 'feature/tkt_test', sha: 'deadbeef' } },
      ...overrides,
    },
  }
}

test('gate commands mirror the CI checks', () => {
  const commands = gateCommands(config)
  assert.match(commands.standards.command, /standards_check\.py/)
  assert.match(commands.backend.command, /mvn -B -ntp test/)
  assert.match(commands.frontend.command, /pnpm lint/)
})

test('worker brief carries hard boundaries and the ticket', () => {
  const brief = workerBrief({ id: 'tkt_x', title: 't' }, config)
  assert.match(brief, /git push/)
  assert.match(brief, /never run production or EBS DDL\/DML/)
  assert.match(brief, /db\/apps\//)
  assert.match(brief, /tkt_x/)
  assert.match(workerTask({ title: 't', body: 'b' }), /不要提交、不要推送/)
})

test('runCommand captures output and times out', async () => {
  const ok = await runCommand('echo hello', { cwd: process.cwd() })
  assert.equal(ok.exitCode, 0)
  assert.match(ok.output, /hello/)
  const slow = await runCommand('sleep 2', { cwd: process.cwd(), timeoutMs: 100 })
  assert.equal(slow.timedOut, true)
  assert.equal(slow.exitCode, 124)
})

test('a dry run stops after gates: no push, no MR, ticket ready', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps()
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'dry-run')
  assert.equal(ticket.status, 'ready')
  assert.equal(fake.calls.pushes.length, 0)
  assert.equal(fake.calls.commits.length, 0)
  assert.ok(fake.calls.commands.some(command => command.includes('pnpm install')))
  assert.ok(fake.calls.commands.some(command => command.includes('standards_check')))
  const names = run.steps.map(step => step.name)
  for (const name of ['prepare-worktree', 'worker', 'changed-paths', 'gate:standards', 'gate:backend', 'gate:frontend']) {
    assert.ok(names.includes(name), name)
  }
})

test('a failing gate stops before any commit or push and marks the ticket failed', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps({ runCommand: async (command) => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false, durationMs: 1,
    output: command.includes('mvn') ? 'BUILD FAILURE' : 'ok' }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /backend gate failed/)
  assert.equal(ticket.status, 'failed')
  assert.equal(fake.calls.pushes.length, 0)
  assert.equal(ticket.assignments.at(-1).report.state, 'failed')
})

test('worker timeout marks the ticket failed', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps({ runWorker: async () => ({ sessionId: 'worker-x', timedOut: true, text: '', toolCalls: [] }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /timed out/)
})

test('allowPush=false runs gates but neither commits nor pushes', async () => {
  const { engine, ticket } = makeEngine()
  const localConfig = { ...config, executor: { ...config.executor, allowPush: false } }
  engine.readConfig = () => ({ exists: true, config: localConfig, tokens: { octo: 'tok', gitlab: undefined } })
  const fake = fakeDeps()
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'gates-passed')
  assert.equal(ticket.status, 'ready')
  assert.equal(fake.calls.pushes.length, 0)
})

test('executor.enabled=false refuses a non-dry run', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: false } },
    tokens: { octo: 'tok', gitlab: undefined } })
  await assert.rejects(() => executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fakeDeps().deps }),
    /executor\.enabled is false/)
})

test('a successful push-mode run commits, pushes with MR options and records the MR URL', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...config,
    gitlab: { ...config.gitlab, createMr: 'push' }, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok' }, error: undefined })
  const fake = fakeDeps()
  const pushedWith = []
  fake.deps.pushBranch = async (options) => {
    pushedWith.push(options.pushOptions)
    return { pushed: true, branch: options.branch, sha: 'deadbeef',
      mergeRequest: { webUrl: 'https://gitlab.example/mr/9', iid: 9 } }
  }
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'mr-open')
  assert.equal(ticket.status, 'mr-open')
  assert.equal(pushedWith.length, 1)
  assert.ok(pushedWith[0].includes('merge_request.create'))
  assert.ok(pushedWith[0].some(option => option.startsWith('merge_request.target=dev')))
  assert.equal(ticket.links.mergeRequest.webUrl, 'https://gitlab.example/mr/9')
  assert.equal(ticket.links.branch, 'feature/tkt_test')
  assert.equal(ticket.links.commit, 'deadbeef')
})

test('API mode without a token fails before pushing so no token-less half-publish happens', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps()
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /gitlab token is not configured/)
  assert.equal(fake.calls.pushes.length, 0)
})

test('merge request description names the ticket, gates and worker summary', () => {
  const description = mergeRequestDescription({ id: 'tkt_x', body: 'req' },
    { gates: [{ name: 'standards', exitCode: 0 }, { name: 'backend', exitCode: 0 }], worker: { text: 'done' } })
  assert.match(description, /tkt_x/)
  assert.match(description, /standards: exit 0/)
  assert.match(description, /done/)
  assert.match(description, /禁止自动合并/)
})

test('injectTicket creates a manual ticket through the same rules', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'executor-inject-'))
  try {
    const { engine, doc } = makeEngine()
    engine.readConfig = () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined })
    const ticket = await injectTicket({ engine, title: '修复银行账户必填', body: '保存收款单时校验银行账户必填' })
    assert.ok(ticket.id.startsWith('tkt_'))
    assert.equal(ticket.status, 'queued')
    assert.ok(doc.tickets[ticket.id])
    await assert.rejects(() => injectTicket({ engine, title: '生产 DDL', body: '执行生产 DDL' }), /highRisk/)
    const text = await readFile(join(stateDir, 'nope'), 'utf8').catch(() => '')
    assert.equal(text, '')
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('refreshTicketCi without an MR or token is a no-op', async () => {
  const { engine } = makeEngine()
  assert.deepEqual(await refreshTicketCi({ engine, ticketId: 'tkt_test' }), { skipped: 'no-mr' })
})

// ---------------------------------------------------------------------------
// CI / deployment tracking and the publish path (fake GitLab client).
// ---------------------------------------------------------------------------

function fakeGitlab({ mr = { iid: 7, webUrl: 'https://gitlab.example/mr/7', state: 'merged', mergeStatus: 'can_be_merged' },
  mrPipelines = [{ id: 11, status: 'success', webUrl: 'https://gitlab.example/p/11' }],
  jobs = { 11: [{ id: 1, name: 'backend-test', stage: 'test', status: 'success' }] },
  branchPipelines = [{ id: 21, status: 'success', webUrl: 'https://gitlab.example/p/21' }], branchJobs = [] } = {}) {
  const calls = { pipelines: [], jobs: [] }
  return {
    calls,
    getMergeRequest: async () => mr,
    listMergeRequestPipelines: async () => mrPipelines,
    listPipelineJobs: async (id) => { calls.jobs.push(id); return jobs[id] ?? branchJobs.filter(() => id === 21) },
    listPipelines: async (query) => { calls.pipelines.push(query); return branchPipelines },
    createMergeRequest: async () => mr,
    listMergeRequests: async () => [],
  }
}

function ciEngine() {
  const ticket = { id: 'tkt_ci', title: 't', body: 'b', status: 'ci-pending', assignments: [],
    links: { branch: 'feature/tkt_ci', mergeRequest: { iid: 7, webUrl: 'https://gitlab.example/mr/7', state: 'opened' } } }
  const doc = { tickets: { [ticket.id]: ticket } }
  return {
    ticket,
    engine: {
      readConfig: () => ({ exists: true, config, tokens: { gitlab: 'glpat-test' }, error: undefined }),
      state: { tickets: doc.tickets, atomic: async mutate => mutate(doc) },
    },
  }
}

test('a merged MR is followed into the dev pipeline and its deploy job marks the ticket deployed', async () => {
  const { engine, ticket } = ciEngine()
  const gitlab = fakeGitlab({ branchJobs: [{ id: 2, name: 'deploy_dev', stage: 'deploy', status: 'success' }] })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id, deps: { createGitlabClient: () => gitlab,
    fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(result.status, 'deployed')
  assert.equal(ticket.links.deployment.deployJob.status, 'success')
  assert.equal(ticket.status, 'deployed')
  assert.deepEqual(gitlab.calls.pipelines[0], { ref: 'dev', perPage: 20 })
})

test('a failed deploy job marks the ticket deploy-failed, and a closed MR is closed', async () => {
  const merged = ciEngine()
  const gitlab = fakeGitlab({ branchJobs: [{ id: 2, name: 'deploy_dev', stage: 'deploy', status: 'failed' }] })
  const failed = await refreshTicketCi({ engine: merged.engine, ticketId: merged.ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(failed.status, 'deploy-failed')
  const closed = ciEngine()
  closed.ticket.links.mergeRequest = { iid: 7, state: 'opened' }
  const closedResult = await refreshTicketCi({ engine: closed.engine, ticketId: closed.ticket.id,
    deps: { createGitlabClient: () => fakeGitlab({ mr: { iid: 7, state: 'closed', webUrl: 'u' } }),
      fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(closedResult.status, 'closed')
})

test('an open MR pipeline failure marks the ticket ci-failed', async () => {
  const { engine, ticket } = ciEngine()
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => fakeGitlab({ mr: { iid: 7, state: 'opened', webUrl: 'u' },
      mrPipelines: [{ id: 11, status: 'failed' }] }), fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(result.status, 'ci-failed')
  assert.equal(ticket.status, 'ci-failed')
})

test('publishTicket re-runs gates on the existing worktree, pushes and opens an MR', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pub', status: 'ready',
    links: { branch: 'feature/tkt_pub', worktree: '/tmp/wt/tkt_pub', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps()
  const gitlab = fakeGitlab()
  const run = await publishTicket({ engine, ticketId: ticket.id,
    deps: { ...fake.deps, createGitlabClient: () => gitlab } })
  assert.equal(run.status, 'ci-pending')
  assert.equal(ticket.status, 'ci-pending')
  assert.equal(ticket.links.mergeRequest.iid, 7)
  assert.equal(fake.calls.pushes.length, 1)
})

test('publishTicket refuses without token or push permission', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pub2', status: 'ready' } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: false } },
    tokens: { gitlab: 'glpat-test' }, error: undefined })
  await assert.rejects(() => publishTicket({ engine, ticketId: ticket.id }), /allowPush is false/)
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: {}, error: undefined })
  await assert.rejects(() => publishTicket({ engine, ticketId: ticket.id }), /gitlab token is not configured/)
})

test('the UAT check records reachability, and a failure keeps deploy success but marks uat not ok', async () => {
  const ok = await checkUat('https://uat.example/', async () => ({ status: 200 }))
  assert.equal(ok.ok, true)
  assert.equal(ok.status, 200)
  const redirected = await checkUat('https://uat.example/', async () => ({ status: 302 }))
  assert.equal(redirected.ok, true)
  const failed = await checkUat('https://uat.example/', async () => { throw new Error('ECONNREFUSED') })
  assert.equal(failed.ok, false)
  assert.match(failed.error, /ECONNREFUSED/)
  const missing = await checkUat('', async () => ({ status: 200 }))
  assert.equal(missing.ok, false)

  const { engine, ticket } = ciEngine()
  const gitlab = fakeGitlab({ branchJobs: [{ id: 2, name: 'deploy_dev', stage: 'deploy', status: 'success' }] })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => { throw new Error('down') } } })
  assert.equal(result.status, 'deployed')
  assert.equal(ticket.links.deployment.uat.ok, false)
})

test('a successful run replies to the originating Octo chat when allowReply is true', async () => {
  const { engine, ticket } = makeEngine()
  const sent = []
  engine.ensureClient = async () => ({ sendText: async (message) => { sent.push(message) } })
  engine.readConfig = () => ({ exists: true, config: { ...config,
    executor: { ...config.executor, enabled: true, allowPush: true, allowReply: true } },
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps()
  const gitlab = fakeGitlab({ mr: { iid: 7, webUrl: 'https://gitlab.example/mr/7', state: 'opened' } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false,
    deps: { ...fake.deps, createGitlabClient: () => gitlab } })
  assert.equal(run.status, 'ci-pending')
  assert.equal(sent.length, 1)
  assert.match(sent[0].content, /MR: https:\/\/gitlab\.example\/mr\/7/)
  assert.equal(sent[0].channelId, 'chat-1')
})

test('a push-mode publish creates the MR without an API token', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pub3', status: 'ready',
    links: { branch: 'feature/tkt_pub3', worktree: '/tmp/wt/tkt_pub3', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...config,
    gitlab: { ...config.gitlab, createMr: 'push' }, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok' }, error: undefined })
  const fake = fakeDeps()
  fake.deps.pushBranch = async (options) => ({ pushed: true, branch: options.branch, sha: 'abc',
    mergeRequest: { webUrl: 'https://gitlab.example/mr/10' } })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: fake.deps })
  assert.equal(run.status, 'mr-open')
  assert.equal(ticket.status, 'mr-open')
  assert.equal(ticket.links.mergeRequest.webUrl, 'https://gitlab.example/mr/10')
})

test('commit subject follows the repo style and takes the scope from UC/AC ids', () => {
  assert.equal(commitMessageFor({ title: '修复：保存收款单时校验银行账户必填', body: 'UC-AR-RCPT-001 AC-AR-RCPT-029' }),
    'fix(ar): 保存收款单时校验银行账户必填')
  assert.equal(commitMessageFor({ title: '实现付款单导出', body: 'UC-AP-PAY-002' }), 'feat(ap): 付款单导出')
  assert.equal(commitMessageFor({ commitMessage: 'chore: manual' }), 'chore: manual')
})

// ---------------------------------------------------------------------------
// Token-free acceptance: merge detection + UAT fingerprint + verifyTicket.
// ---------------------------------------------------------------------------

const html = (build) => `<html><head><script src="/web-app/assets/index-${build}.js"></script></head><body>app</body></html>`

test('uatFingerprint hashes asset references and changes with a new build', async () => {
  const fetchOf = (content) => async () => ({ status: 200, text: async () => content })
  const first = await uatFingerprint({ url: 'https://uat.example/', fetchImpl: fetchOf(html('a1')) })
  const same = await uatFingerprint({ url: 'https://uat.example/', fetchImpl: fetchOf(html('a1')) })
  const next = await uatFingerprint({ url: 'https://uat.example/', fetchImpl: fetchOf(html('b2')) })
  assert.equal(first.ok, true)
  assert.equal(first.assets, 1)
  assert.equal(first.hash, same.hash)
  assert.notEqual(first.hash, next.hash)
  const down = await uatFingerprint({ url: 'https://uat.example/', fetchImpl: async () => ({ status: 503, text: async () => '' }) })
  assert.equal(down.ok, false)
})

test('checkMerged asks git whether the commit is an ancestor of the deploy branch', async () => {
  const calls = []
  const deps = { git: async (args) => { calls.push(args.join(' ')); return '' } }
  const merged = await checkMerged({ repo: '/repo', baseBranch: 'dev', sha: 'abc123', deps })
  assert.equal(merged.merged, true)
  assert.ok(calls[0].startsWith('fetch origin dev'))
  const notMerged = await checkMerged({ repo: '/repo', baseBranch: 'dev', sha: 'abc123',
    deps: { git: async (args) => { if (args[0] === 'merge-base') throw new Error('exit 1'); return args[0] === 'rev-parse' ? 'devsha' : '' } } })
  assert.equal(notMerged.merged, false)
  assert.equal(notMerged.devSha, 'devsha')
})

test('verifyTicket records the baseline, then reports deployed once dev has the commit and UAT changed', async () => {
  const ticket = { id: 'tkt_verify', status: 'mr-open', links: { commit: 'abc123' } }
  const engine = {
    state: { tickets: { [ticket.id]: ticket }, atomic: async (mutate) => mutate({ tickets: { [ticket.id]: ticket } }) },
    readConfig: () => ({ config: { ...config, repo: '/repo', gitlab: { ...config.gitlab, targetBranch: 'dev', uatUrl: 'https://uat.example/' } }, tokens: {} }),
  }
  let merged = false
  const deps = {
    git: async (args) => {
      if (args[0] === 'merge-base') { if (!merged) throw new Error('exit 1'); return '' }
      if (args[0] === 'rev-parse') return 'devsha'
      return ''
    },
    fetchImpl: async () => ({ status: 200, text: async () => html('a1') }),
  }
  const baseline = await verifyTicket({ engine, ticketId: ticket.id, deps })
  assert.equal(baseline.verification.merged, false)
  assert.ok(baseline.verification.baselineHash)
  assert.equal(ticket.status, 'mr-open')

  merged = true
  deps.fetchImpl = async () => ({ status: 200, text: async () => html('b2') })
  const deployed = await verifyTicket({ engine, ticketId: ticket.id, deps })
  assert.equal(deployed.verification.merged, true)
  assert.equal(deployed.verification.changed, true)
  assert.equal(deployed.status, 'deployed')
  assert.equal(ticket.status, 'deployed')
})

test('a deploy that only refreshes the web dist mtime still counts as deployed', async () => {
  const ticket = { id: 'tkt_mtime', status: 'mr-open', links: { commit: 'abc123' } }
  const engine = {
    state: { tickets: { [ticket.id]: ticket }, atomic: async (mutate) => mutate({ tickets: { [ticket.id]: ticket } }) },
    readConfig: () => ({ config: { ...config, repo: '/repo', gitlab: { ...config.gitlab, targetBranch: 'dev',
      uatUrl: 'https://uat.example/', healthUrl: 'https://uat.example/api/actuator/health' } }, tokens: {} }),
  }
  let merged = false
  let lastModified = 'Tue, 03 Nov 2026 10:35:49 GMT'
  const response = (text, modified) => ({ status: 200, text: async () => text,
    headers: { get: name => name.toLowerCase() === 'last-modified' ? modified : undefined } })
  const deps = {
    git: async (args) => { if (args[0] === 'merge-base') { if (!merged) throw new Error('exit 1'); return '' } return args[0] === 'rev-parse' ? 'devsha' : '' },
    fetchImpl: async (url) => response(String(url).includes('actuator') ? '{"status":"UP"}' : html('a1'), lastModified),
  }
  const baseline = await verifyTicket({ engine, ticketId: ticket.id, deps })
  assert.equal(baseline.verification.baselineLastModified, lastModified)
  assert.equal(baseline.status, 'mr-open')

  merged = true
  lastModified = 'Wed, 04 Nov 2026 04:30:00 GMT'
  const result = await verifyTicket({ engine, ticketId: ticket.id, deps })
  assert.equal(result.verification.changed, true)
  assert.equal(result.verification.health.status, 200)
  assert.equal(result.status, 'deployed')
})

test('allowMerge merges a green MR and then follows the dev pipeline', async () => {
  const { engine, ticket } = ciEngine()
  engine.readConfig = () => ({ exists: true, config: { ...config,
    executor: { ...config.executor, allowMerge: true } }, tokens: { gitlab: 'glpat-test' }, error: undefined })
  const calls = []
  const gitlab = {
    getMergeRequest: async () => ({ iid: 7, state: 'opened', sha: 'abc123', webUrl: 'https://gitlab.example/mr/7' }),
    listMergeRequestPipelines: async () => [{ id: 11, status: 'success' }],
    listPipelineJobs: async (id) => { calls.push(id); return [] },
    mergeMergeRequest: async (iid, options) => { calls.push({ iid, options }); return { iid, state: 'merged',
      webUrl: 'https://gitlab.example/mr/7', mergeStatus: 'merged' } },
    listPipelines: async () => [{ id: 21, status: 'running', webUrl: 'https://gitlab.example/p/21' }],
  }
  const result = await refreshTicketCi({ engine, ticketId: ticket.id, deps: { createGitlabClient: () => gitlab } })
  assert.equal(result.autoMerge.state, 'merged')
  assert.equal(ticket.links.autoMerge.state, 'merged')
  assert.equal(ticket.links.mergeRequest.state, 'merged')
  assert.equal(result.status, 'deploy-pending')
  const mergeCall = calls.find(call => typeof call === 'object')
  assert.deepEqual(mergeCall, { iid: 7, options: { sha: 'abc123', mergeWhenPipelineSucceeds: false, removeSourceBranch: true } })
})

// ---------------------------------------------------------------------------
// Multi-repository execution (#12): manual verification + per-repo gates.
// ---------------------------------------------------------------------------

const manualRepo = { id: 'ebs', name: 'ebs', kind: 'oracle-ebs', repo: '/tmp/ebs', baseBranch: 'develop', featurePrefix: 'feature/',
  worktreeRoot: '/tmp/wt', verifyMode: 'manual', acceptance: 'merged', prepareCommand: 'python3 scripts/local/export_cux_objects.py',
  postGatesCommand: 'python3 scripts/local/export_cux_objects.py',
  gates: [{ name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py',
    dryRunCommand: 'python3 scripts/local/deploy_object.py --dry-run', passChangedFiles: true,
    requireOutput: '待部署对象', timeoutMs: 1_800_000 }],
  gitlab: { baseUrl: 'https://gitlab.example', project: 'group/project-b', targetBranch: 'develop', createMr: 'api', ci: false } }
const multiConfig = { ...config, repos: [manualRepo], defaultRepo: 'ebs' }

test('per-repository gates expose the deploy command and a safe dry-run preview', () => {
  const commands = gateCommands(manualRepo)
  assert.equal(commands['ebs-deploy'].command, 'python3 scripts/local/deploy_object.py')
  assert.equal(commands['ebs-deploy'].passChangedFiles, true)
  assert.equal(commands['ebs-deploy'].requireOutput, '待部署对象')
  // A dry run must never deploy: it uses the preview command and skips prepare/post hooks.
  const calls = []
  const engine = {
    readConfig: () => ({ exists: true, config: multiConfig, tokens: { octo: 'tok', repoTokens: { ebs: 'glpat' } }, error: undefined }),
    state: { tickets: { tkt_ebs: { id: 'tkt_ebs', title: 'CUX 包体加日志', repoId: 'ebs', status: 'queued', assignments: [] } }, runs: [],
      atomic: async (mutate) => mutate({ tickets: {}, runs: [] }) },
  }
  const briefs = []
  return executeTicket({ ctx: {}, engine, ticketId: 'tkt_ebs', dryRun: true, deps: {
    prepareWorktree: async () => ({ path: '/tmp/wt/tkt_ebs', branch: 'feature/tkt_ebs', baseSha: 'abc' }),
    runWorker: async (options) => { briefs.push(options.systemPrompt); return { sessionId: 's', timedOut: false, text: 'done', toolCalls: [] } },
    changedPaths: async () => ['plsql/packages/apps/CUX_X.pkb'],
    runCommand: async (command) => { calls.push(command); return { exitCode: 0, timedOut: false, durationMs: 5,
      output: command.includes('deploy_object') ? '待部署对象 1 个' : 'ok' } },
    hasChanges: async () => false,
    commitAll: async () => ({ sha: 'sha', subject: 'x' }),
    assertSafeWorktree: async () => ({ paths: [] }),
    pushBranch: async () => ({ pushed: true, branch: 'feature/tkt_ebs', sha: 'sha' }),
  } }).then((run) => {
    assert.deepEqual(calls, ["python3 scripts/local/deploy_object.py --dry-run 'plsql/packages/apps/CUX_X.pkb'"])
    assert.equal(run.status, 'dry-run')
    assert.match(briefs[0], /AGENTS\.md/)
    assert.match(briefs[0], /Oracle EBS R12/)
    assert.match(briefs[0], /Do NOT run the repository's deployment or export scripts/)
  })
})

test('manual-repo verification only observes the merge and never calls the UAT surface', async () => {
  const ticket = { id: 'tkt_manual', title: 'CUX 包体', repoId: 'ebs', status: 'mr-open',
    links: { commit: 'abc123', mergeRequest: { iid: 12 } } }
  const engine = {
    state: { tickets: { [ticket.id]: ticket }, atomic: async (mutate) => mutate({ tickets: { [ticket.id]: ticket } }) },
    readConfig: () => ({ config: multiConfig, tokens: { repoTokens: { ebs: 'glpat' } } }),
  }
  let mergeBases = 0
  const deps = {
    git: async (args) => { if (args[0] === 'merge-base') { mergeBases += 1; throw new Error('exit 1') } return args[0] === 'rev-parse' ? 'devsha' : '' },
    fetchImpl: async () => { throw new Error('UAT must not be fetched for a manual repository') },
    createGitlabClient: () => ({ getMergeRequest: async () => ({ state: 'merged', webUrl: 'https://gitlab.example/mr/12' }) }),
  }
  const result = await verifyTicket({ engine, ticketId: ticket.id, deps })
  assert.equal(result.status, 'merged')
  assert.equal(result.verification.mode, 'manual')
  assert.equal(result.verification.merged, true)
  assert.equal(ticket.status, 'merged')
  assert.equal(mergeBases, 1)
})

test('injectTicket accepts a repoId and refuses an unknown one', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'superagent-inject-'))
  try {
    const engine = {
      readConfig: () => ({ exists: true, config: multiConfig, tokens: { octo: 'tok', repoTokens: { ebs: 'glpat' } }, error: undefined }),
      state: { tickets: {}, runs: [], atomic: async (mutate) => mutate({ tickets: {}, threads: {}, triggers: {}, decisions: {}, ticketOrder: [] }) },
    }
    const ticket = await injectTicket({ engine, title: 'CUX 包体加日志', body: '只改 plsql/packages/apps/CUX_X.pkb', repoId: 'ebs' })
    assert.equal(ticket.repoId, 'ebs')
    await assert.rejects(() => injectTicket({ engine, title: 'x', body: 'y', repoId: 'nope' }), /unknown repoId/)
  } finally { await rm(stateDir, { recursive: true, force: true }) }
})

test('a CLI backend runs the CLI worker instead of the DSH agent', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor,
    workerBackend: 'codex', workerModel: 'gpt-6-astra', workerCommand: '/opt/codex' } },
    tokens: { octo: 'tok', gitlab: undefined } })
  const seen = []
  const fake = fakeDeps({ runCliWorker: async options => {
    seen.push(options)
    return { sessionId: 'cli-worker', text: 'cli summary', toolCalls: ['edit'], backend: 'codex', timedOut: false }
  } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'dry-run')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].backend, 'codex')
  assert.equal(seen[0].model, 'gpt-6-astra')
  assert.equal(seen[0].command, '/opt/codex')
  assert.equal(seen[0].cwd, '/tmp/wt/tkt_test')
  assert.equal(run.worker.backend, 'codex')
  assert.equal(run.worker.sessionId, 'cli-worker')
})

test('reconcileTicketFromGitlab reattaches a merged MR lost to an interrupted run', async () => {
  const ticket = { id: 'tkt_orphan', title: '孤儿工单', status: 'failed', repoId: 'ebs',
    links: { branch: 'feature/tkt_orphan', mergeRequest: null } }
  const engine = {
    readConfig: () => ({ exists: true, config: { ...config, repos: [manualRepo], defaultRepo: 'ebs' },
      tokens: { repoTokens: { ebs: 'tok' } }, error: undefined }),
    state: { tickets: { [ticket.id]: ticket },
      atomic: async (mutate) => mutate({ tickets: { [ticket.id]: ticket } }) },
  }
  let queried
  const deps = { createGitlabClient: () => ({ listMergeRequests: async options => {
    queried = options
    return [{ iid: 6, state: 'merged', webUrl: 'https://gitlab.example/mr/6', sha: 'afb1a84', targetBranch: 'develop' }]
  } }) }
  const result = await reconcileTicketFromGitlab({ engine, ticketId: ticket.id, deps })
  assert.equal(queried.sourceBranch, 'feature/tkt_orphan')
  assert.equal(result.status, 'merged')
  assert.equal(result.ticket.links.mergeRequest.iid, 6)
  assert.equal(result.ticket.links.commit, 'afb1a84')
  assert.equal(result.ticket.links.verification.merged, true)
  assert.equal(result.ticket.links.verification.targetBranch, 'develop')
  assert.equal(result.ticket.links.reconciled.previousStatus, 'failed')
})

test('reconcileTicketFromGitlab is a no-op without a token or branch', async () => {
  const ticket = { id: 'tkt_orphan', status: 'failed', repoId: 'ebs', links: { branch: 'feature/tkt_orphan' } }
  const engine = { readConfig: () => ({ config: { ...config, repos: [manualRepo], defaultRepo: 'ebs' },
    tokens: { repoTokens: {} } }), state: { tickets: { [ticket.id]: ticket }, atomic: async () => {} } }
  assert.equal((await reconcileTicketFromGitlab({ engine, ticketId: ticket.id })).skipped, 'no-token')
})

test('a gate that validates no changed object fails instead of passing silently', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: multiConfig, tokens: { octo: 'tok', repoTokens: { ebs: 'glpat' } },
    error: undefined })
  const fake = fakeDeps({ runCommand: async () => ({ exitCode: 0, timedOut: false, durationMs: 5,
    output: '没有可部署的对象文件（跳过 2 个非对象文件）。' }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /did not validate any changed object/)
})

test('ebs deploy and access gates both receive the exact changed files', async () => {
  const accessRepo = { ...manualRepo, gates: [
    { name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py',
      dryRunCommand: 'python3 scripts/local/deploy_object.py --dry-run', passChangedFiles: true,
      requireOutput: '待部署对象', timeoutMs: 1_800_000 },
    { name: 'ebs-access', command: 'python3 scripts/local/apply_sql_script.py',
      dryRunCommand: 'python3 scripts/local/apply_sql_script.py --dry-run', passChangedFiles: true,
      requireOutput: 'ACCESS 脚本', timeoutMs: 600_000 },
  ] }
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...multiConfig, repos: [accessRepo] },
    tokens: { octo: 'tok', repoTokens: { ebs: 'glpat' } }, error: undefined })
  const commands = []
  const fake = fakeDeps({
    changedPaths: async () => ['ddl/views/apps/V.sql', 'sql/V_ACCESS.sql'],
    runCommand: async command => { commands.push(command); return { exitCode: 0, timedOut: false, durationMs: 5,
      output: command.includes('apply_sql_script') ? 'ACCESS 脚本 1 个' : '待部署对象 1 个' } },
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'dry-run')
  assert.equal(commands.length, 2)
  assert.match(commands[0], /deploy_object\.py --dry-run 'ddl\/views\/apps\/V\.sql' 'sql\/V_ACCESS\.sql'/)
  assert.match(commands[1], /apply_sql_script\.py --dry-run 'ddl\/views\/apps\/V\.sql' 'sql\/V_ACCESS\.sql'/)
})

test('an access-only change passes deploy with zero objects and runs the access gate', async () => {
  const accessRepo = { ...manualRepo, gates: [
    { name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py',
      dryRunCommand: 'python3 scripts/local/deploy_object.py --dry-run', passChangedFiles: true,
      requireOutput: '待部署对象', timeoutMs: 1_800_000 },
    { name: 'ebs-access', command: 'python3 scripts/local/apply_sql_script.py',
      dryRunCommand: 'python3 scripts/local/apply_sql_script.py --dry-run', passChangedFiles: true,
      requireOutput: 'ACCESS 脚本', timeoutMs: 600_000 },
  ] }
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...multiConfig, repos: [accessRepo] },
    tokens: { octo: 'tok', repoTokens: { ebs: 'glpat' } }, error: undefined })
  const commands = []
  const fake = fakeDeps({
    changedPaths: async () => ['sql/V_ACCESS.sql'],
    runCommand: async command => { commands.push(command); return { exitCode: 0, timedOut: false, durationMs: 5,
      output: command.includes('apply_sql_script') ? 'ACCESS 脚本 1 个' : '待部署对象 0 个（没有需要部署的数据库对象）' } },
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'dry-run')
  assert.equal(commands.length, 2)
})
