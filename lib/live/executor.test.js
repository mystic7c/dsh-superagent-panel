import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeTicket, resumeTicket, answerTicket, resumeInterruptedTicket, gateCommands, workerBrief, workerTask,
  mergeRequestDescription, runCommand, refreshTicketCi, injectTicket, publishTicket, checkUat, commitMessageFor,
  uatFingerprint, checkMerged, verifyTicket, reconcileTicketFromGitlab, usesPushOptionMr } from './executor.js'
import { OperationStore } from './operations.js'
import { normalizeRepos } from './repos.js'
import { deriveInboxItems } from './engine.js'
import { readFile } from 'node:fs/promises'

const config = {
  enabled: true,
  repo: '/tmp/repo', baseBranch: 'dev', featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', pollSeconds: 10,
  octo: { watchChatIds: ['chat-1'], channelType: 2, allowSenderIds: [], allowAnyHuman: true, cliPath: '/bin/true' },
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
    state: { tickets: doc.tickets, get runs() { return doc.runs }, atomic: async (mutate) => mutate(doc) },
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
  // A revision round carries the human requirements in order and tells the worker to keep the previous attempt.
  const revised = workerTask({ title: 't', body: '原始需求', revisions: [
    { id: 'rev_1', at: '2026-11-08T00:00:00.000Z', text: 'BI 表改到 CUX' },
    { id: 'rev_2', at: '2026-11-08T00:01:00.000Z', text: '参数名保持 p_Ledger_Id' },
  ] })
  assert.match(revised, /追加要求/)
  assert.match(revised, /1\. BI 表改到 CUX/)
  assert.match(revised, /2\. 参数名保持 p_Ledger_Id/)
  assert.match(revised, /上一轮的改动已留在当前工作树里/)
  assert.ok(revised.indexOf('原始需求') < revised.indexOf('BI 表改到 CUX'))
  // Older revisions stay bounded: the worker gets the last ten, never the whole history.
  const many = Array.from({ length: 15 }, (_, index) => ({ text: `rev ${index}` }))
  const bounded = workerTask({ title: 't', revisions: many })
  assert.ok(!bounded.includes('rev 4'))
  assert.match(bounded, /rev 14/)
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
  assert.equal(run.stopReason, 'done')
  assert.equal(run.errorCode, undefined)
  assert.ok(run.leaseAt)
  assert.equal(run.trace, undefined)
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

test('a failing gate parks the ticket for a human instead of failing it', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps({ runCommand: async (command) => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false,
    durationMs: 7, output: command.includes('mvn') ? 'BUILD FAILURE' : 'ok' }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(run.errorCode, 'gate_failed')
  assert.equal(run.pendingGate.name, 'backend')
  assert.equal(run.pendingGate.exitCode, 1)
  assert.equal(run.pendingGate.timedOut, false)
  assert.match(run.pendingGate.outputTail, /BUILD FAILURE/)
  assert.deepEqual(run.pendingGate.changedPaths, ['ebs/ebs-ar/src/main/java/X.java'])
  assert.ok(run.pendingGate.at)
  assert.ok(run.leaseAt)
  assert.equal(ticket.status, 'gate-blocked')
  assert.deepEqual(ticket.pendingGate, run.pendingGate)
  assert.equal(ticket.assignments.at(-1).report.state, 'waiting')
  assert.match(ticket.assignments.at(-1).report.text, /backend/)
  assert.ok(run.steps.some(entry => entry.name === 'awaiting-human' && entry.gate === 'backend'))
  // Evidence only: nothing was committed or pushed while the gate was red.
  assert.equal(fake.calls.pushes.length, 0)
  assert.equal(fake.calls.commits.length, 0)
  assert.equal(run.gates.at(-1).name, 'backend')
  assert.equal(run.gates.at(-1).exitCode, 1)
})

test('worker timeout marks the run failed with stopReason=timeout', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps({ runWorker: async () => ({ sessionId: 'worker-x', timedOut: true, text: '', toolCalls: [] }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /timed out/)
  assert.equal(run.stopReason, 'timeout')
  assert.equal(run.errorCode, 'timeout')
})

test('worker_lost fails the run but keeps the ticket retryable and raises a failure inbox todo', async () => {
  const { engine, ticket } = makeEngine()
  const workerCalls = []
  const localConfig = { ...config, executor: { ...config.executor, workerIdleTimeoutMs: 120_000 } }
  engine.readConfig = () => ({ exists: true, config: localConfig, tokens: { octo: 'tok', gitlab: undefined }, error: undefined })
  const fake = fakeDeps({ runWorker: async (options) => {
    workerCalls.push(options)
    return { sessionId: 'worker-lost', timedOut: false, text: '', toolCalls: [], error: 'worker_lost',
      events: [{ type: 'error', at: '2026-11-12T00:00:00.000Z', state: 'worker_lost' }] }
  } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })

  // The watchdog window is forwarded from config, not hard-coded in the executor.
  assert.equal(workerCalls.length, 1)
  assert.equal(workerCalls[0].idleTimeoutMs, 120_000)
  assert.equal(run.status, 'failed')
  assert.equal(run.stopReason, 'worker_lost')
  assert.equal(run.errorCode, 'worker_lost')
  assert.match(run.error, /without reporting turn\/end/)
  const workerStep = run.steps.filter(step => step.name === 'worker').at(-1)
  assert.equal(workerStep.state, 'failed')
  assert.equal(workerStep.error, 'worker_lost')
  assert.equal(run.steps.find(step => step.name === 'error').retryable, true)

  // Retryable: the Ticket leaves `working`, keeps its branch/worktree, and can be executed again.
  assert.equal(ticket.status, 'ready')
  assert.equal(ticket.links.branch, 'feature/tkt_test')
  assert.equal(ticket.links.worktree, '/tmp/wt/tkt_test')
  assert.equal(ticket.assignments.at(-1).state, 'ended')
  assert.ok(ticket.activities.some(activity => activity.kind === 'run' && /worker 失联/.test(activity.detail ?? '')))
  assert.ok(ticket.activities.some(activity => activity.kind === 'status' && activity.to === 'ready'))
  assert.equal(fake.calls.commits.length, 0)
  assert.equal(fake.calls.pushes.length, 0)

  // The failure is visible on the desk even though the Ticket is retryable (`ready`).
  const items = deriveInboxItems({ state: { tickets: engine.state.tickets, runs: engine.state.runs },
    loaded: { config: localConfig } })
  const failure = items.find(item => item.kind === 'failure')
  assert.ok(failure)
  assert.match(failure.title, /worker 失联，可重试/)
  assert.match(failure.summary, /turn\/end/)
  assert.deepEqual(failure.refs, { ticketId: ticket.id, runId: run.id })
  assert.equal(failure.dedupeKey, `failure:${ticket.id}:${run.id}`)
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

test('a GitHub remote is pushed without GitLab MR push options and records the create-PR link', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...config,
    gitlab: { ...config.gitlab, baseUrl: 'https://github.com', createMr: 'push', ci: false },
    executor: { ...config.executor, enabled: true, allowPush: true } }, tokens: { octo: 'tok' }, error: undefined })
  const fake = fakeDeps()
  const pushedWith = []
  fake.deps.pushBranch = async (options) => {
    pushedWith.push(options.pushOptions)
    return { pushed: true, branch: options.branch, sha: 'deadbeef',
      mergeRequest: { webUrl: 'https://github.com/owner/repo/pull/new/feature/tkt_test', created: false } }
  }
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'mr-open')
  assert.equal(ticket.status, 'mr-open')
  // GitHub ignores merge_request.* options (and rejected option-bearing pushes once), so nothing is passed.
  assert.deepEqual(pushedWith[0], [])
  assert.equal(ticket.links.mergeRequest.webUrl, 'https://github.com/owner/repo/pull/new/feature/tkt_test')
  // GitLab remotes keep the push-option path untouched.
  assert.equal(usesPushOptionMr({ gitlab: { baseUrl: 'https://code.mlamp.cn' } }), true)
  assert.equal(usesPushOptionMr({ gitlab: { baseUrl: 'https://github.com' } }), false)
  assert.equal(usesPushOptionMr({}), true)
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
    listMergeRequestPipelines: async () => [{ id: 11, status: 'success', sha: 'abc123' }],
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

test('a gate that validates no changed object parks instead of passing silently', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: multiConfig, tokens: { octo: 'tok', repoTokens: { ebs: 'glpat' } },
    error: undefined })
  const fake = fakeDeps({ runCommand: async () => ({ exitCode: 0, timedOut: false, durationMs: 5,
    output: '没有可部署的对象文件（跳过 2 个非对象文件）。' }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(run.pendingGate.name, 'ebs-deploy')
  assert.equal(run.pendingGate.exitCode, 0)
  assert.equal(ticket.status, 'gate-blocked')
  assert.equal(ticket.pendingGate.name, 'ebs-deploy')
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

// ---------------------------------------------------------------------------
// P0: worker trace, stopReason branches and the gate park → human decision flow.
// ---------------------------------------------------------------------------

/** Execute one non-dry ticket whose backend gate fails, leaving it parked for a human. */
async function parkTicket({ tokens = { octo: 'tok', gitlab: 'glpat-test' }, runCommand: gateCommand, worker, stateDir, trigger } = {}) {
  const { engine, ticket, doc } = makeEngine()
  if (stateDir) engine.stateDir = stateDir
  engine.readConfig = () => ({ exists: true, config, tokens, error: undefined })
  const fake = fakeDeps({
    runWorker: async () => worker ?? { sessionId: 'worker-tkt_test', timedOut: false, text: '改了 validator', toolCalls: ['bash'] },
    runCommand: gateCommand ?? (async (command) => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false, durationMs: 4,
      output: command.includes('mvn') ? 'BUILD FAILURE' : 'ok' })),
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, trigger, deps: fake.deps })
  // persist() replaces the ticket entry with a copy, so resume tests must use the persisted object.
  return { engine, ticket: engine.state.tickets[ticket.id], doc, run, fake }
}

/** Deps for resumeTicket: every external action succeeds. */
function resumeDeps(overrides = {}) {
  const calls = { commands: [], pushes: [], commits: [] }
  return {
    calls,
    deps: {
      git: async () => 'basesha',
      runCommand: async (command) => { calls.commands.push(command); return { exitCode: 0, timedOut: false, durationMs: 4, output: 'ok' } },
      changedPaths: async () => ['ebs/ebs-ar/src/main/java/X.java'],
      hasChanges: async () => true,
      commitAll: async () => { calls.commits.push(true); return { sha: 'deadbeef', subject: 'fix: x' } },
      assertSafeWorktree: async () => ({ paths: [] }),
      pushBranch: async () => { calls.pushes.push(true); return { pushed: true, branch: 'feature/tkt_test', sha: 'deadbeef' } },
      createGitlabClient: () => fakeGitlab({ mr: { iid: 7, webUrl: 'https://gitlab.example/mr/7', state: 'opened' } }),
      ...overrides,
    },
  }
}

test('worker events land in run.trace, bounded at 80 and clipped to 300 characters', async () => {
  const { engine, ticket } = makeEngine()
  const events = []
  for (let index = 0; index < 120; index += 1) {
    events.push({ type: index % 4 === 0 ? 'assistant' : 'tool_call', at: new Date().toISOString(),
      ...index % 4 === 0 ? {} : { name: `tool_${index}` }, summary: 'x'.repeat(500) })
  }
  events.push({ type: 'bogus', summary: 'must be dropped' })
  const fake = fakeDeps({ runWorker: async () => ({ sessionId: 'worker-trace', timedOut: false, text: 'done',
    toolCalls: ['bash'], events }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.trace.length, 80)
  assert.ok(run.trace.every(event => ['assistant', 'tool_call', 'tool_result', 'turn_end', 'error'].includes(event.type)))
  assert.ok(run.trace.every(event => typeof event.summary !== 'string' || event.summary.length <= 300))
  assert.equal(run.trace.at(-1).name, 'tool_119')
  // run.worker keeps the historical fields only; the events are not duplicated there.
  assert.equal(run.worker.events, undefined)
  assert.equal(run.worker.text, 'done')
  assert.deepEqual(run.worker.toolCalls, ['bash'])
})

test('a run without worker events has no trace field', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps({ runWorker: async () => ({ sessionId: 'w', timedOut: false, text: 'done', toolCalls: [] }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.trace, undefined)
})

test('failure codes map to the contract stopReason values', async () => {
  // prepare fails
  const prepare = makeEngine()
  const prepareDeps = fakeDeps({ prepareWorktree: async () => { throw new Error('worktree already exists') } })
  const prepareRun = await executeTicket({ ctx: {}, engine: prepare.engine, ticketId: prepare.ticket.id, dryRun: true,
    deps: prepareDeps.deps })
  assert.equal(prepareRun.status, 'failed')
  assert.equal(prepareRun.stopReason, 'prepare_failed')
  assert.equal(prepareRun.errorCode, 'prepare_failed')
  assert.match(prepareRun.error, /worktree already exists/)

  // worker reports an error
  const worker = makeEngine()
  const workerDeps = fakeDeps({ runWorker: async () => ({ sessionId: 'w', timedOut: false, text: '', toolCalls: [],
    error: 'provider exploded' }) })
  const workerRun = await executeTicket({ ctx: {}, engine: worker.engine, ticketId: worker.ticket.id, dryRun: true,
    deps: workerDeps.deps })
  assert.equal(workerRun.stopReason, 'worker_failed')

  // no changes
  const none = makeEngine()
  const noneDeps = fakeDeps({ changedPaths: async () => [] })
  const noneRun = await executeTicket({ ctx: {}, engine: none.engine, ticketId: none.ticket.id, dryRun: true, deps: noneDeps.deps })
  assert.equal(noneRun.stopReason, 'no_changes')

  // a broken dependency bootstrap is fatal (not a human gate decision)
  const boot = makeEngine()
  const bootDeps = fakeDeps({ runCommand: async command => ({ exitCode: command.includes('pnpm install') ? 1 : 0,
    timedOut: false, durationMs: 2, output: 'ERR_PNPM' }) })
  const bootRun = await executeTicket({ ctx: {}, engine: boot.engine, ticketId: boot.ticket.id, dryRun: true, deps: bootDeps.deps })
  assert.equal(bootRun.status, 'failed')
  assert.equal(bootRun.stopReason, 'bootstrap_failed')
  assert.equal(boot.ticket.status, 'failed')

  // the worktree guard refuses the push
  const guard = makeEngine()
  const guardDeps = fakeDeps({ assertSafeWorktree: async () => { throw new Error('refusing to push forbidden path: .env') } })
  const guardRun = await executeTicket({ ctx: {}, engine: guard.engine, ticketId: guard.ticket.id, dryRun: false,
    deps: { ...guardDeps.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(guardRun.status, 'failed')
  assert.equal(guardRun.stopReason, 'guard_failed')
})

test('resumeTicket rejects unknown tickets, non-parked tickets and unknown actions', async () => {
  const { engine, ticket } = makeEngine()
  assert.deepEqual(await resumeTicket({ engine, ticketId: 'tkt_nope', action: 'retry' }), { missing: true })
  assert.match((await resumeTicket({ engine, ticketId: ticket.id, action: 'retry' })).invalid, /not waiting for a gate/)
  assert.match((await resumeTicket({ engine, ticketId: ticket.id, action: 'explode' })).invalid, /unknown gate action/)
})

test('resumeTicket is invalid when the parked run is gone or has no pending gate', async () => {
  const { engine, ticket, doc } = await parkTicket()
  const originalRunId = ticket.runId
  ticket.runId = 'run_missing'
  assert.match((await resumeTicket({ engine, ticketId: ticket.id, action: 'retry' })).invalid, /not found/)
  ticket.runId = originalRunId
  delete doc.runs[0].pendingGate
  assert.match((await resumeTicket({ engine, ticketId: ticket.id, action: 'retry' })).invalid, /no pending gate/)
})

test('resume retry re-runs every gate and parks again while the gate is still red', async () => {
  const { engine, ticket, run: parked } = await parkTicket()
  const resume = resumeDeps({ runCommand: async (command) => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false,
    durationMs: 4, output: command.includes('mvn') ? 'still failing' : 'ok' }) })
  const result = await resumeTicket({ engine, ticketId: ticket.id, action: 'retry', deps: resume.deps })
  assert.equal(result.run, parked)
  assert.equal(parked.status, 'waiting_for_human')
  assert.equal(parked.stopReason, 'gate_failed')
  assert.equal(parked.pendingGate.name, 'backend')
  assert.equal(parked.pendingGate.outputTail, 'still failing')
  assert.equal(ticket.status, 'gate-blocked')
  assert.equal(ticket.pendingGate.name, 'backend')
  const names = parked.steps.map(entry => entry.name)
  assert.ok(names.includes('gate:re-run'))
  assert.ok(names.includes('resume:retry'))
  assert.ok(names.filter(name => name === 'awaiting-human').length >= 2)
  assert.equal(resume.calls.pushes.length, 0)
  // The retry reused the worktree but re-ran the dependency bootstrap and every gate.
  assert.ok(parked.steps.filter(entry => entry.name === 'bootstrap:pnpm').length >= 2)
  assert.ok(parked.steps.filter(entry => entry.name === 'gate:standards').length >= 2)
  assert.ok(parked.steps.filter(entry => entry.name === 'gate:backend').length >= 2)
})

test('resume retry finalizes the run when the gates now pass', async () => {
  const { engine, ticket, run: parked } = await parkTicket()
  const resume = resumeDeps()
  const result = await resumeTicket({ engine, ticketId: ticket.id, action: 'retry', deps: resume.deps })
  assert.equal(result.ticket, ticket)
  assert.equal(parked.status, 'ci-pending')
  assert.equal(parked.stopReason, 'done')
  assert.equal(parked.errorCode, undefined)
  assert.equal(parked.pendingGate, undefined)
  assert.equal(ticket.status, 'ci-pending')
  assert.equal(ticket.pendingGate, undefined)
  assert.equal(ticket.links.mergeRequest.iid, 7)
  assert.equal(resume.calls.pushes.length, 1)
  assert.equal(resume.calls.commits.length, 1)
  assert.ok(parked.steps.some(entry => entry.name === 'merge-request'))
  assert.ok(parked.leaseAt)
})

test('resume release skips the gates, records the skip and finalizes', async () => {
  const { engine, ticket, run: parked } = await parkTicket()
  const resume = resumeDeps()
  const result = await resumeTicket({ engine, ticketId: ticket.id, action: 'release', note: '测试环境闸门豁免',
    deps: resume.deps })
  assert.equal(result.run, parked)
  assert.equal(parked.status, 'ci-pending')
  assert.equal(parked.stopReason, 'done')
  assert.ok(parked.pendingGate.released.at)
  assert.equal(parked.pendingGate.released.note, '测试环境闸门豁免')
  assert.equal(ticket.pendingGate, undefined)
  assert.equal(resume.calls.commands.length, 0)
  // The failing evidence of the first run is still on the run record.
  assert.equal(parked.gates.find(gate => gate.name === 'backend').exitCode, 1)
  assert.equal(resume.calls.pushes.length, 1)
  assert.ok(parked.steps.some(entry => entry.name === 'resume:release'))
})

test('resume stop ends the ticket as stopped and keeps the gate evidence on the run', async () => {
  const { engine, ticket, run: parked } = await parkTicket()
  const result = await resumeTicket({ engine, ticketId: ticket.id, action: 'stop', note: '不修了',
    deps: resumeDeps().deps })
  assert.equal(result.run, parked)
  assert.equal(parked.status, 'failed')
  assert.equal(parked.stopReason, 'stopped')
  assert.equal(parked.errorCode, 'stopped')
  assert.match(parked.error, /不修了/)
  assert.equal(parked.pendingGate.name, 'backend')
  assert.equal(parked.pendingGate.released, undefined)
  assert.equal(ticket.status, 'failed')
  assert.equal(ticket.pendingGate, undefined)
  assert.equal(ticket.assignments.at(-1).state, 'ended')
  assert.equal(ticket.assignments.at(-1).report.state, 'stopped')
  assert.ok(parked.steps.some(entry => entry.name === 'resume:stop'))
})

test('a dry-run ticket parks on a gate failure and its retry still ends as a dry run', async () => {
  const { engine, ticket } = makeEngine()
  const failing = fakeDeps({ runCommand: async command => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false,
    durationMs: 4, output: 'BUILD FAILURE' }) })
  const parked = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: failing.deps })
  assert.equal(parked.status, 'waiting_for_human')
  assert.equal(parked.dryRun, true)
  const resume = resumeDeps()
  const result = await resumeTicket({ engine, ticketId: ticket.id, action: 'retry', deps: resume.deps })
  assert.equal(result.run.status, 'dry-run')
  assert.equal(result.run.stopReason, 'done')
  assert.equal(result.ticket.status, 'ready')
  assert.equal(resume.calls.pushes.length, 0)
})

test('publishTicket fails (never parks) on a red gate and records gate_failed', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pubgate', status: 'ready',
    links: { branch: 'feature/tkt_pubgate', worktree: '/tmp/wt/tkt_pubgate', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps({ runCommand: async command => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false,
    durationMs: 5, output: 'BUILD FAILURE' }) })
  const run = await publishTicket({ engine, ticketId: ticket.id,
    deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(run.status, 'failed')
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(run.errorCode, 'gate_failed')
  assert.equal(run.pendingGate, undefined)
  assert.equal(ticket.status, 'failed')
  assert.equal(ticket.pendingGate, undefined)
  assert.ok(run.leaseAt)
  assert.ok(run.steps.some(entry => entry.name === 'error'))
})

// ---------------------------------------------------------------------------
// P1 (contract §3.2/§4.2/§6.2/§7): operation ledger, worker report/answer, acceptance rounds, checkpoints.
// ---------------------------------------------------------------------------

/** Temp state dir so the executor creates the real OperationStore / AcceptanceStore. */
async function withStateDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'executor-p1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** makeEngine with a state dir: the executor persists to the real P1 stores, like the host engine does. */
function p1Engine(stateDir, overrides = {}) {
  const made = makeEngine(overrides)
  made.engine.stateDir = stateDir
  return made
}

function questionedWorker() {
  return async () => ({
    sessionId: 'worker-question',
    timedOut: false,
    text: '',
    toolCalls: [],
    report: {
      progress: [{ text: '分析依赖' }],
      artifacts: [{ path: 'ebs/ebs-ar/src/main/java/X.java', note: 'edit' }],
      verify: [{ name: '单测', command: 'mvn test' }],
      question: { question: '选 A 还是 B?', options: ['A', 'B'] },
    },
  })
}

test('a run writes the full operation ledger, the index row, the trigger, checkpoint and handoff', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket, doc } = p1Engine(dir)
  const seen = []
  const fake = fakeDeps({ runWorker: async (options) => {
    seen.push(options)
    return { sessionId: 'worker-tkt_test', timedOut: false, text: '改了 validator 并跑了单测', toolCalls: ['bash'] }
  } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, trigger: 'auto', deps: fake.deps })
  assert.equal(run.trigger, 'auto')
  assert.equal(run.stopReason, 'done')
  assert.ok(run.completedAt)
  // handoff: worker summary front + changed paths
  assert.match(run.handoff.summary, /^改了 validator/)
  assert.deepEqual(run.handoff.changedPaths, ['ebs/ebs-ar/src/main/java/X.java'])
  assert.ok(run.handoff.summary.length <= 301)
  // checkpoint of the last step
  assert.equal(run.checkpoint.step, 'finish')
  assert.equal(run.checkpoint.phase, 'done')
  assert.equal(run.checkpoint.worktree, '/tmp/wt/tkt_test')
  assert.equal(run.checkpoint.branch, 'feature/tkt_test')
  assert.equal(run.checkpoint.baseSha, 'abc123')
  assert.deepEqual(run.checkpoint.changedPaths, ['ebs/ebs-ar/src/main/java/X.java'])
  // the worker got the per-run report file path
  assert.ok(seen[0].reportFile.endsWith(`/runs/${run.id}.report.jsonl`))
  // full operation in the ledger, light index row in the state document
  const stored = engine.operations.get(run.id)
  assert.ok(stored)
  assert.equal(stored.status, 'dry-run')
  assert.equal(stored.trigger, 'auto')
  assert.ok(Array.isArray(stored.steps) && stored.steps.length > 0)
  assert.ok(stored.handoff)
  assert.equal(doc.runs[0].id, run.id)
  assert.equal(doc.runs[0].stopReason, 'done')
  assert.equal(doc.runs[0].steps, undefined)
  // activities: run start + terminal status
  assert.ok(ticket.activities.some(activity => activity.kind === 'run'))
  assert.ok(ticket.activities.some(activity => activity.to === 'ready'))
})

test('a worker question parks the ticket as awaiting-answer without gates, commit or push', async () => {
  const { engine, ticket } = makeEngine()
  const fake = fakeDeps({ runWorker: questionedWorker() })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.stopReason, 'waiting_for_human')
  assert.equal(run.pendingQuestion.question, '选 A 还是 B?')
  assert.deepEqual(run.pendingQuestion.options, ['A', 'B'])
  assert.equal(run.report.progress.length, 1)
  assert.equal(run.report.artifacts.length, 1)
  assert.equal(run.report.verify.length, 1)
  assert.equal(run.gates, undefined)
  assert.equal(ticket.status, 'awaiting-answer')
  assert.equal(ticket.pendingQuestion.question, '选 A 还是 B?')
  assert.ok(ticket.activities.some(activity => activity.to === 'awaiting-answer'))
  assert.ok(run.steps.some(entry => entry.name === 'awaiting-answer'))
  assert.equal(run.checkpoint.phase, 'worker')
  assert.equal(fake.calls.pushes.length, 0)
  assert.equal(fake.calls.commits.length, 0)
  assert.equal(fake.calls.commands.length, 0)
})

test('answerTicket records the answer, clears the question and re-runs with the Q/A context', async () => {
  const { engine, ticket } = makeEngine()
  const asked = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fakeDeps({ runWorker: questionedWorker() }).deps })
  assert.equal(asked.status, 'waiting_for_human')
  const parkedTicket = engine.state.tickets[ticket.id]
  parkedTicket.answers = Array.from({ length: 19 }, (_, index) => ({
    at: new Date().toISOString(), question: `旧问题 ${index}`, answer: `旧回答 ${index}`,
  }))
  engine.readConfig = () => ({ exists: true,
    config: { ...config, executor: { ...config.executor, allowPush: false } }, tokens: { octo: 'tok' }, error: undefined })
  const seen = []
  const answerDeps = fakeDeps({ runWorker: async (options) => {
    seen.push(options.task)
    return { sessionId: 'worker-tkt_test', timedOut: false, text: 'done', toolCalls: [] }
  } })
  const result = await answerTicket({ engine, ticketId: ticket.id, answer: '选 A', deps: answerDeps.deps })
  assert.ok(result.run)
  assert.equal(result.run.trigger, 'resume')
  assert.equal(result.run.status, 'gates-passed')
  assert.equal(result.ticket.status, 'ready')
  assert.equal(result.ticket.answers.length, 20)
  assert.equal(result.ticket.answers.at(-1).answer, '选 A')
  assert.equal(result.ticket.answers.at(-1).question, '选 A 还是 B?')
  assert.equal(result.ticket.pendingQuestion, undefined)
  assert.ok(result.ticket.activities.some(activity => activity.kind === 'answer'))
  assert.match(seen[0], /此前的提问与回答/)
  assert.match(seen[0], /问：选 A 还是 B\?/)
  assert.match(seen[0], /答：选 A/)
  // second answer is invalid (the ticket is not awaiting anymore)
  assert.match((await answerTicket({ engine, ticketId: ticket.id, answer: 'x', deps: answerDeps.deps })).invalid,
    /not waiting for an answer/)
  assert.deepEqual(await answerTicket({ engine, ticketId: 'tkt_nope', answer: 'x' }), { missing: true })
})

test('the worker report is bounded (progress 50 / artifacts 50 / verify 20)', async () => {
  const { engine, ticket } = makeEngine()
  const report = {
    progress: Array.from({ length: 80 }, (_, index) => ({ text: `p${index}` })),
    artifacts: Array.from({ length: 80 }, (_, index) => ({ path: `f${index}` })),
    verify: Array.from({ length: 30 }, (_, index) => ({ name: `v${index}` })),
  }
  const fake = fakeDeps({ runWorker: async () => ({ sessionId: 'w', timedOut: false, text: 'ok', toolCalls: [], report }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.report.progress.length, 50)
  assert.equal(run.report.artifacts.length, 50)
  assert.equal(run.report.verify.length, 20)
  assert.equal(run.report.question, undefined)
})

test('gate results are written as an acceptance round; a parked gate stays verifying', async (t) => {
  const dir = await withStateDir(t)
  const passed = p1Engine(dir)
  const run = await executeTicket({ ctx: {}, engine: passed.engine, ticketId: passed.ticket.id, dryRun: true,
    trigger: 'manual', deps: fakeDeps().deps })
  const record = passed.engine.acceptance.get(passed.ticket.id)
  assert.ok(record)
  assert.equal(record.rounds.length, 1)
  const round = record.rounds[0]
  assert.equal(round.runId, run.id)
  assert.equal(round.trigger, 'manual')
  assert.equal(round.roundIndex, 1)
  assert.equal(round.status, 'delivered')
  assert.ok(round.completedAt)
  assert.deepEqual(round.plan.map(item => item.name), ['standards', 'backend', 'frontend'])
  assert.ok(round.plan.every(item => item.verifierType === 'program'))
  assert.ok(round.checks.every(check => check.status === 'passed'))
  assert.equal(record.status, 'delivered')
})

test('a parked gate round stays verifying and release skips the failed check', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = await parkTicket({ stateDir: dir })
  const parked = engine.acceptance.get(ticket.id)
  assert.equal(parked.rounds.length, 1)
  assert.equal(parked.rounds[0].status, 'verifying')
  assert.equal(parked.rounds[0].checks.find(check => check.name === 'backend').status, 'failed')
  const resume = resumeDeps()
  await resumeTicket({ engine, ticketId: ticket.id, action: 'release', note: '测试环境放行', deps: resume.deps })
  const record = engine.acceptance.get(ticket.id)
  assert.equal(record.rounds.length, 1)
  const round = record.rounds[0]
  assert.equal(round.status, 'delivered')
  assert.ok(round.completedAt)
  const backend = round.checks.find(check => check.name === 'backend')
  assert.equal(backend.status, 'skipped')
  assert.equal(backend.note, 'released by human')
  assert.equal(record.status, 'delivered')
  // release never re-runs gates
  assert.equal(resume.calls.commands.length, 0)
})

test('retry opens a new acceptance round and keeps the parked one as evidence', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = await parkTicket({ stateDir: dir })
  assert.equal(engine.acceptance.get(ticket.id).rounds[0].status, 'verifying')
  await resumeTicket({ engine, ticketId: ticket.id, action: 'retry', deps: resumeDeps().deps })
  const record = engine.acceptance.get(ticket.id)
  assert.equal(record.rounds.length, 2)
  assert.equal(record.rounds[0].status, 'verifying')
  assert.equal(record.rounds[1].trigger, 'resume')
  assert.equal(record.rounds[1].status, 'delivered')
  assert.equal(record.rounds[1].roundIndex, 2)
})

test('a broken gate bootstrap records an errored acceptance round', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = p1Engine(dir)
  const fake = fakeDeps({ runCommand: async command => ({ exitCode: command.includes('pnpm install') ? 1 : 0,
    timedOut: false, durationMs: 2, output: 'ERR_PNPM' }) })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.stopReason, 'bootstrap_failed')
  const round = engine.acceptance.get(ticket.id).rounds[0]
  assert.equal(round.status, 'errored')
  assert.ok(round.checks.every(check => check.status === 'skipped'))
})

test('publish records trigger=publish, its gate round and a handoff', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = p1Engine(dir, { ticket: { id: 'tkt_pub_p1', status: 'ready',
    links: { branch: 'feature/tkt_pub_p1', worktree: '/tmp/wt/tkt_pub_p1', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps()
  const run = await publishTicket({ engine, ticketId: ticket.id,
    deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(run.trigger, 'publish')
  assert.equal(run.stopReason, 'done')
  assert.ok(run.handoff.summary)
  assert.equal(engine.operations.get(run.id).trigger, 'publish')
  const round = engine.acceptance.get(ticket.id).rounds[0]
  assert.equal(round.trigger, 'publish')
  assert.equal(round.status, 'delivered')
  assert.equal(round.runId, run.id)
})

test('a publish with a red gate fails directly and records a failed round', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = p1Engine(dir, { ticket: { id: 'tkt_pub_p1b', status: 'ready',
    links: { branch: 'feature/tkt_pub_p1b', worktree: '/tmp/wt/tkt_pub_p1b', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps({ runCommand: async command => ({ exitCode: command.includes('mvn') ? 1 : 0, timedOut: false,
    durationMs: 4, output: 'BUILD FAILURE' }) })
  const run = await publishTicket({ engine, ticketId: ticket.id,
    deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(run.pendingGate, undefined)
  const round = engine.acceptance.get(ticket.id).rounds[0]
  assert.equal(round.status, 'failed')
  assert.equal(round.checks.find(check => check.name === 'backend').status, 'failed')
})

test('resumeInterruptedTicket resumes a gates checkpoint as a new run on the same worktree', async (t) => {
  const dir = await withStateDir(t)
  const worktreeDir = await mkdtemp(join(tmpdir(), 'executor-resume-wt-'))
  t.after(() => rm(worktreeDir, { recursive: true, force: true }))
  const { engine, ticket, doc } = p1Engine(dir)
  const operations = new OperationStore(dir)
  await operations.load()
  engine.operations = operations
  const interrupted = { id: 'run_interrupted', ticketId: ticket.id, trigger: 'manual', status: 'interrupted',
    startedAt: '2026-11-07T00:00:00.000Z', worktree: worktreeDir, branch: 'feature/tkt_test', baseSha: 'abc123',
    changedPaths: ['ebs/ebs-ar/src/main/java/X.java'], steps: [], dryRun: false,
    checkpoint: { step: 'gate:backend', phase: 'gates', worktree: worktreeDir, branch: 'feature/tkt_test',
      baseSha: 'abc123', changedPaths: ['ebs/ebs-ar/src/main/java/X.java'], at: '2026-11-07T00:01:00.000Z' } }
  await operations.save(interrupted)
  ticket.status = 'ready'
  ticket.runId = interrupted.id
  doc.runs = [{ id: interrupted.id, ticketId: ticket.id, status: 'interrupted', startedAt: interrupted.startedAt }]
  await engine.state.atomic((state) => { state.tickets[ticket.id] = { ...state.tickets[ticket.id], ...ticket } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, allowPush: false } },
    tokens: { octo: 'tok' }, error: undefined })
  const resume = resumeDeps()
  const result = await resumeInterruptedTicket({ engine, ticketId: ticket.id, deps: resume.deps })
  assert.ok(result.run)
  assert.notEqual(result.run.id, interrupted.id)
  assert.equal(result.run.trigger, 'resume')
  assert.equal(result.run.status, 'gates-passed')
  assert.equal(result.ticket.status, 'ready')
  assert.equal(result.run.worktree, worktreeDir)
  assert.deepEqual(result.run.changedPaths, ['ebs/ebs-ar/src/main/java/X.java'])
  assert.ok(result.run.steps.some(entry => entry.name === 'resume:checkpoint'))
  // the interrupted run stays interrupted, the new run is in the ledger
  assert.equal(engine.operations.get(interrupted.id).status, 'interrupted')
  assert.ok(engine.operations.get(result.run.id))
  assert.equal(engine.operations.get(result.run.id).trigger, 'resume')
})

test('resumeInterruptedTicket re-runs the whole ticket when the checkpoint is not resumable', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket, doc } = p1Engine(dir)
  const operations = new OperationStore(dir)
  await operations.load()
  engine.operations = operations
  const interrupted = { id: 'run_interrupted2', ticketId: ticket.id, trigger: 'manual', status: 'interrupted',
    startedAt: '2026-11-07T00:00:00.000Z', steps: [], dryRun: false,
    checkpoint: { step: 'worker', phase: 'worker', at: '2026-11-07T00:01:00.000Z' } }
  await operations.save(interrupted)
  ticket.status = 'ready'
  ticket.runId = interrupted.id
  doc.runs = [{ id: interrupted.id, ticketId: ticket.id, status: 'interrupted', startedAt: interrupted.startedAt }]
  await engine.state.atomic((state) => { state.tickets[ticket.id] = { ...state.tickets[ticket.id], ...ticket } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, allowPush: false } },
    tokens: { octo: 'tok' }, error: undefined })
  const fake = fakeDeps()
  const result = await resumeInterruptedTicket({ engine, ticketId: ticket.id, deps: fake.deps })
  assert.ok(result.run)
  assert.notEqual(result.run.id, interrupted.id)
  assert.equal(result.run.trigger, 'resume')
  assert.ok(result.run.worker) // the worker ran again: full re-execution
  assert.ok(result.run.steps.some(entry => entry.name === 'worker'))
  assert.equal(engine.operations.get(interrupted.id).status, 'interrupted')
})

test('resumeInterruptedTicket rejects missing tickets and tickets without an interrupted run', async () => {
  const { engine, ticket } = makeEngine()
  assert.deepEqual(await resumeInterruptedTicket({ engine, ticketId: 'tkt_nope' }), { missing: true })
  assert.match((await resumeInterruptedTicket({ engine, ticketId: ticket.id })).invalid, /no interrupted run/)
})

// ---------------------------------------------------------------------------
// P2 §2.1/§2.2: MR head sha, stale pipelines and draft/WIP verification.
// ---------------------------------------------------------------------------

test('refreshTicketCi adopts only the pipeline built for the MR head commit', async () => {
  const { engine, ticket } = ciEngine()
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'https://gitlab.example/mr/7', sha: 'head-1' },
    mrPipelines: [{ id: 11, status: 'failed', sha: 'old-1' }, { id: 12, status: 'success', sha: 'head-1' }],
  })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(result.status, 'ci-passed')
  assert.equal(result.stale, undefined)
  assert.equal(ticket.status, 'ci-passed')
  assert.equal(ticket.links.mergeRequest.headSha, 'head-1')
  assert.equal(ticket.links.pipeline.id, 12)
  assert.equal(ticket.links.pipeline.headSha, 'head-1')
  assert.equal(ticket.links.pipeline.stale, undefined)
})

test('refreshTicketCi falls back to diffRefs.headSha when the MR omits sha', async () => {
  const { engine, ticket } = ciEngine()
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'u', diffRefs: { headSha: 'head-2' } },
    mrPipelines: [{ id: 11, status: 'success', sha: 'head-2' }],
  })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(ticket.links.mergeRequest.headSha, 'head-2')
  assert.equal(result.status, 'ci-passed')
})

test('refreshTicketCi marks a newer pipeline for another commit as stale without touching the ticket status', async () => {
  const { engine, ticket } = ciEngine()
  ticket.status = 'ci-pending'
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'u', sha: 'head-1' },
    mrPipelines: [{ id: 11, status: 'success', sha: 'head-1' }, { id: 12, status: 'failed', sha: 'head-2' }],
  })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(result.stale, true)
  assert.equal(result.status, 'ci-pending')
  assert.equal(ticket.status, 'ci-pending')
  assert.equal(ticket.links.pipeline.id, undefined)
  assert.equal(ticket.links.pipeline.headSha, 'head-1')
  assert.equal(ticket.links.pipeline.stale.headSha, 'head-1')
  assert.equal(ticket.links.pipeline.stale.latestSha, 'head-2')
  assert.ok(ticket.links.pipeline.stale.at)
})

test('refreshTicketCi marks stale when only an unrelated-commit pipeline exists', async () => {
  const { engine, ticket } = ciEngine()
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'u', sha: 'head-1' },
    mrPipelines: [{ id: 12, status: 'failed', sha: 'head-2' }],
  })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(result.stale, true)
  assert.equal(result.status, 'ci-pending')
  assert.equal(ticket.links.pipeline.stale.latestSha, 'head-2')
})

test('refreshTicketCi clears a previous stale marker once a matching pipeline arrives', async () => {
  const { engine, ticket } = ciEngine()
  ticket.links.pipeline = { id: 9, status: 'failed', headSha: 'head-1',
    stale: { headSha: 'head-1', latestSha: 'head-2', at: '2026-11-07T00:00:00.000Z' } }
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'u', sha: 'head-1' },
    mrPipelines: [{ id: 11, status: 'success', sha: 'head-1' }],
  })
  const result = await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(result.stale, undefined)
  assert.equal(result.status, 'ci-passed')
  assert.equal(ticket.links.pipeline.stale, undefined)
  assert.equal(ticket.links.pipeline.id, 11)
})

test('refreshTicketCi persists the MR title and draft flag for later verification', async () => {
  const { engine, ticket } = ciEngine()
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'u', sha: 'head-1', title: 'Draft: feat: x', workInProgress: true },
    mrPipelines: [{ id: 11, status: 'success', sha: 'head-1' }],
  })
  await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(ticket.links.mergeRequest.title, 'Draft: feat: x')
  assert.equal(ticket.links.mergeRequest.workInProgress, true)
  // ... and the next verification pass skips the draft instead of judging it (the persisted copy is what it reads).
  const persisted = engine.state.tickets[ticket.id]
  const result = await verifyTicket({ engine, ticketId: ticket.id, deps: { fetchImpl: async () => { throw new Error('no fetch') } } })
  assert.deepEqual(result, { status: persisted.status, skipped: 'draft' })
  assert.equal(engine.state.tickets[ticket.id].links.mergeRequest.draft, true)
})

test('a push-mode run records the MR head sha and the pipeline head sha', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config: { ...config, gitlab: { ...config.gitlab, createMr: 'push' },
    executor: { ...config.executor, enabled: true, allowPush: true } }, tokens: { octo: 'tok' }, error: undefined })
  ticket.links = { ...ticket.links, pipeline: { id: 5, status: 'pending' } }
  const fake = fakeDeps()
  fake.deps.pushBranch = async options => ({ pushed: true, branch: options.branch, sha: 'abc123',
    mergeRequest: { iid: 1, webUrl: 'https://gitlab.example/mr/1' } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false, deps: fake.deps })
  assert.equal(run.stopReason, 'done')
  assert.equal(ticket.links.mergeRequest.headSha, 'abc123')
  assert.equal(ticket.links.pipeline.headSha, 'abc123')
})

test('an api-mode run records the pushed commit as the MR head sha', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ exists: true, config, tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps()
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: false,
    deps: { ...fake.deps, createGitlabClient: () => fakeGitlab({ mr: { iid: 7, webUrl: 'u', state: 'opened', sha: 'gitlab-sha' } }) } })
  assert.equal(run.stopReason, 'done')
  assert.equal(ticket.links.mergeRequest.headSha, 'deadbeef')
  assert.equal(ticket.links.mergeRequest.iid, 7)
})

test('publishTicket records the head sha on the MR link', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pub_head', status: 'ready',
    links: { branch: 'feature/tkt_pub_head', worktree: '/tmp/wt/tkt_pub_head', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...config, executor: { ...config.executor, enabled: true, allowPush: true } },
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  const fake = fakeDeps()
  const run = await publishTicket({ engine, ticketId: ticket.id,
    deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(run.stopReason, 'done')
  assert.equal(ticket.links.mergeRequest.headSha, 'deadbeef')
})

test('verifyTicket skips a draft / WIP merge request without merge or UAT checks', async () => {
  const cases = [
    { id: 'tkt_draft_wip', mergeRequest: { iid: 9, workInProgress: true, title: 'feat: x' } },
    { id: 'tkt_draft_title', mergeRequest: { iid: 9, title: 'Draft: feat: x' } },
    { id: 'tkt_wip_title', mergeRequest: { iid: 9, title: 'WIP: fix' } },
    { id: 'tkt_wip_lower', mergeRequest: { iid: 9, title: ' wip:lower' } },
  ]
  for (const item of cases) {
    const ticket = { id: item.id, status: 'mr-open', links: { commit: 'abc123', mergeRequest: item.mergeRequest } }
    const engine = {
      state: { tickets: { [ticket.id]: ticket }, atomic: async (mutate) => mutate({ tickets: { [ticket.id]: ticket } }) },
      readConfig: () => ({ config, tokens: { gitlab: 'glpat-test' }, error: undefined }),
    }
    const calls = []
    const deps = {
      git: async (...args) => { calls.push(['git', ...args]); throw new Error('git must not run for a draft') },
      fetchImpl: async () => { calls.push(['fetch']); throw new Error('UAT must not be fetched for a draft') },
      createGitlabClient: () => { calls.push(['gitlab']); throw new Error('gitlab must not be called for a draft') },
    }
    const result = await verifyTicket({ engine, ticketId: ticket.id, deps })
    assert.deepEqual(result, { status: 'mr-open', skipped: 'draft' })
    assert.equal(ticket.links.mergeRequest.draft, true)
    assert.deepEqual(calls, [])
  }
})

test('verifyTicket still verifies a non-draft MR title', async () => {
  const ticket = { id: 'tkt_non_draft', status: 'mr-open',
    links: { commit: 'abc123', mergeRequest: { iid: 9, title: 'feat: x' } } }
  const engine = {
    state: { tickets: { [ticket.id]: ticket }, atomic: async (mutate) => mutate({ tickets: { [ticket.id]: ticket } }) },
    readConfig: () => ({ config: { ...config, gitlab: { ...config.gitlab, targetBranch: 'dev', uatUrl: 'https://uat.example/' } }, tokens: {}, error: undefined }),
  }
  const deps = {
    git: async (args) => { if (args[0] === 'merge-base') throw new Error('exit 1'); return 'devsha' },
    fetchImpl: async () => ({ status: 200, text: async () => '<html></html>' }),
  }
  const result = await verifyTicket({ engine, ticketId: ticket.id, deps })
  assert.equal(result.skipped, undefined)
  assert.equal(result.status, 'mr-open')
})

test('refreshTicketCi clears the recorded draft flag once GitLab reports the MR ready', async () => {
  const { engine, ticket } = ciEngine()
  ticket.links.mergeRequest = { ...ticket.links.mergeRequest, workInProgress: true, draft: true, headSha: 'head-1' }
  const gitlab = fakeGitlab({
    mr: { iid: 7, state: 'opened', webUrl: 'u', sha: 'head-1', title: 'feat: x', workInProgress: false },
    mrPipelines: [{ id: 11, status: 'success', sha: 'head-1' }],
  })
  await refreshTicketCi({ engine, ticketId: ticket.id,
    deps: { createGitlabClient: () => gitlab, fetchImpl: async () => ({ status: 200 }) } })
  assert.equal(ticket.links.mergeRequest.workInProgress, false)
  assert.equal(ticket.links.mergeRequest.draft, undefined)
})

// ---------------------------------------------------------------------------
// P2b §1: gate onFail / automatic repair rounds.
// ---------------------------------------------------------------------------

/** makeEngine whose repository declares its own gates (so onFail/repairHint reach the executor). */
function repairEngine({ gates, maxRepairRounds = 1, allowPush = false, stateDir } = {}) {
  const repo = {
    id: 'main',
    name: 'main',
    kind: 'web',
    repo: '/tmp/repo',
    baseBranch: 'dev',
    featurePrefix: 'feature/',
    worktreeRoot: '/tmp/wt',
    verifyMode: 'web-uat',
    acceptance: 'deployed',
    gates: gates ?? [
      { name: 'standards', command: 'python3 scripts/standards_check.py' },
      { name: 'backend', command: 'cd ebs && mvn -B -ntp test', onFail: 'auto_repair', repairHint: '检查银行账户必填校验' },
      { name: 'frontend', command: 'pnpm lint' },
    ],
    gitlab: { baseUrl: 'https://gitlab.example', project: 'g/p', targetBranch: 'dev', createMr: 'api', ci: true },
    protectedPaths: [],
    workerInstructions: [],
  }
  const localConfig = { ...config, repos: [repo], defaultRepo: 'main',
    executor: { ...config.executor, allowPush, maxRepairRounds } }
  const made = makeEngine()
  if (stateDir) made.engine.stateDir = stateDir
  made.engine.readConfig = () => ({ exists: true, config: localConfig,
    tokens: { octo: 'tok', gitlab: 'glpat-test' }, error: undefined })
  return made
}

/** Worker script: one reply per turn, the last one repeats. */
function scriptedWorkers(workers) {
  const calls = []
  return {
    calls,
    runWorker: async (options) => {
      calls.push(options)
      const reply = workers[Math.min(calls.length - 1, workers.length - 1)]
      return typeof reply === 'function' ? reply(options) : reply
    },
  }
}

const mainWorker = { sessionId: 'worker-main', timedOut: false, text: '首轮改动', toolCalls: ['bash'],
  events: [{ type: 'assistant', summary: '首轮' }] }
/** Repair turn: echoes the session id the executor generated (a real worker's session id does the same). */
const repairWorker = (options) => ({ sessionId: options?.sessionId ?? 'worker-repair', timedOut: false,
  text: '已修复校验', toolCalls: ['edit'], events: [{ type: 'assistant', summary: 'repair fix' }] })

/** Gate script: the mvn gate fails a given number of times (or forever / with a timeout). */
function gateScript({ mvnFailures = 1, timeout = false } = {}) {
  const calls = []
  let mvnRuns = 0
  return {
    calls,
    runCommand: async (command) => {
      calls.push(command)
      if (command.includes('mvn')) {
        mvnRuns += 1
        const failing = mvnRuns <= mvnFailures
        if (timeout && failing) return { exitCode: 124, timedOut: true, durationMs: 9, output: 'gate timed out' }
        return {
          exitCode: failing ? 1 : 0,
          timedOut: false,
          durationMs: 5,
          output: failing ? 'BUILD FAILURE: bank account validation missing' : 'BUILD SUCCESS',
        }
      }
      return { exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }
    },
  }
}

test('auto_repair fixes a failing gate, reruns the gates and succeeds (acceptance delivered)', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = repairEngine({ stateDir: dir, maxRepairRounds: 1 })
  const workers = scriptedWorkers([mainWorker,
    (options) => ({ ...repairWorker(options),
      events: Array.from({ length: 100 }, (_, index) => ({ type: 'assistant', summary: `repair ${index}` })) })])
  const gates = gateScript({ mvnFailures: 1 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'dry-run')
  assert.equal(run.stopReason, 'done')
  assert.equal(run.pendingGate, undefined)
  assert.equal(run.repairs.length, 1)
  assert.equal(run.repairs[0].round, 1)
  assert.match(run.repairs[0].sessionId, /^worker-tkt_test-repair-1-/)
  assert.deepEqual(run.repairs[0].gates, [{ name: 'backend', exitCode: 1, timedOut: false }])
  assert.deepEqual(run.repair, { attempts: 1, max: 1, status: 'succeeded' })
  // The repair worker ran on the same worktree with the failure context and the repair hint.
  assert.equal(workers.calls.length, 2)
  assert.equal(workers.calls[1].cwd, '/tmp/wt/tkt_test')
  assert.match(workers.calls[1].sessionId, /repair-1/)
  assert.match(workers.calls[1].task, /只修复/)
  assert.match(workers.calls[1].task, /backend/)
  assert.match(workers.calls[1].task, /BUILD FAILURE/)
  assert.match(workers.calls[1].task, /检查银行账户必填校验/)
  assert.match(workers.calls[1].task, /首轮改动|处理这个/)
  // The full operation ledger carries the repair summary and the round records.
  const stored = engine.operations.get(run.id)
  assert.deepEqual(stored.repair, { attempts: 1, max: 1, status: 'succeeded' })
  assert.equal(stored.repairs.length, 1)
  // Repair events joined the bounded trace; run.worker still describes the first turn only.
  assert.equal(run.trace.length, 80)
  assert.ok(run.trace.some(event => event.summary === 'repair 99'))
  assert.equal(run.worker.text, '首轮改动')
  // Activity: one per repair round + the final success.
  assert.ok(ticket.activities.some(activity => /自动修复第 1 轮/.test(activity.detail ?? '')))
  assert.ok(ticket.activities.some(activity => /自动修复成功/.test(activity.detail ?? '')))
  // Acceptance round carries onFail and the repair summary; the final checks are the re-run gates.
  const round = engine.acceptance.get(ticket.id).rounds[0]
  assert.equal(round.status, 'delivered')
  assert.deepEqual(round.repair, { attempts: 1, max: 1, status: 'succeeded' })
  assert.equal(round.plan.find(item => item.name === 'backend').onFail, 'auto_repair')
  assert.equal(round.plan.find(item => item.name === 'standards').onFail, 'manual')
  assert.equal(round.checks.find(item => item.name === 'backend').onFail, 'auto_repair')
  assert.ok(round.checks.every(check => check.status === 'passed'))
})

test('auto_repair exhausts two rounds on a still-red gate and parks', async () => {
  const { engine, ticket } = repairEngine({ maxRepairRounds: 2 })
  const workers = scriptedWorkers([mainWorker, repairWorker])
  const gates = gateScript({ mvnFailures: 99 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.repair.attempts, 2)
  assert.equal(run.repair.max, 2)
  assert.equal(run.repair.status, 'exhausted')
  assert.equal(run.repairs.length, 2)
  assert.deepEqual(run.repairs.map(item => item.round), [1, 2])
  assert.equal(run.pendingGate.name, 'backend')
  assert.equal(ticket.status, 'gate-blocked')
  assert.equal(workers.calls.length, 3) // main + two repair turns
  assert.ok(ticket.activities.some(activity => /自动修复耗尽/.test(activity.detail ?? '')))
})

test('a gate that does not opt in to auto_repair parks without a repair turn', async () => {
  const { engine, ticket } = repairEngine({ maxRepairRounds: 3, gates: [
    { name: 'standards', command: 'python3 scripts/standards_check.py' },
    { name: 'backend', command: 'cd ebs && mvn -B -ntp test' }] })
  const workers = scriptedWorkers([mainWorker])
  const gates = gateScript({ mvnFailures: 99 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.repair.attempts, 0)
  assert.equal(run.repair.status, 'none')
  assert.equal(run.repairs, undefined)
  assert.equal(workers.calls.length, 1)
  assert.equal(run.pendingGate.name, 'backend')
})

test('an errored (timed-out) gate is never auto-repaired', async () => {
  const { engine, ticket } = repairEngine({ maxRepairRounds: 3, gates: [
    { name: 'backend', command: 'cd ebs && mvn -B -ntp test', onFail: 'auto_repair' }] })
  const workers = scriptedWorkers([mainWorker])
  const gates = gateScript({ mvnFailures: 1, timeout: true })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.repair.status, 'none')
  assert.equal(run.pendingGate.timedOut, true)
  assert.equal(workers.calls.length, 1)
})

test('a failed repair worker parks immediately and records the repair error', async () => {
  const { engine, ticket } = repairEngine({ maxRepairRounds: 2 })
  const workers = scriptedWorkers([mainWorker,
    { sessionId: 'worker-repair-1', timedOut: false, text: '', toolCalls: [], error: 'provider exploded' }])
  const gates = gateScript({ mvnFailures: 99 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.repair.attempts, 1)
  assert.equal(run.repair.status, 'failed')
  assert.match(run.pendingGate.repairError, /provider exploded/)
  assert.equal(workers.calls.length, 2) // no second repair attempt
  assert.ok(ticket.activities.some(activity => /自动修复失败/.test(activity.detail ?? '')))
})

test('a timed-out repair worker parks immediately with the timeout as the repair error', async () => {
  const { engine, ticket } = repairEngine({ maxRepairRounds: 2 })
  const workers = scriptedWorkers([mainWorker,
    { sessionId: 'worker-repair-1', timedOut: true, text: '', toolCalls: [] }])
  const gates = gateScript({ mvnFailures: 99 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.equal(run.repair.status, 'failed')
  assert.match(run.pendingGate.repairError, /timed out/)
  assert.equal(workers.calls.length, 2)
})

test('executor.maxRepairRounds=0 disables automatic repair', async () => {
  const { engine, ticket } = repairEngine({ maxRepairRounds: 0 })
  const workers = scriptedWorkers([mainWorker, repairWorker])
  const gates = gateScript({ mvnFailures: 99 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  assert.deepEqual(run.repair, { attempts: 0, max: 0, status: 'none' })
  assert.equal(workers.calls.length, 1)
})

test('resume retry never triggers an automatic repair round', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = repairEngine({ stateDir: dir, maxRepairRounds: 0 })
  const workers = scriptedWorkers([mainWorker])
  const gates = gateScript({ mvnFailures: 99 })
  const parked = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(parked.status, 'waiting_for_human')
  const workerCalls = workers.calls.length
  const resume = resumeDeps({ runCommand: async (command) => ({ exitCode: command.includes('mvn') ? 1 : 0,
    timedOut: false, durationMs: 1, output: 'still failing' }) })
  const current = engine.state.tickets[ticket.id]
  const result = await resumeTicket({ engine, ticketId: current.id, action: 'retry', deps: resume.deps })
  assert.equal(result.run.status, 'waiting_for_human')
  assert.equal(workers.calls.length, workerCalls) // the retry path never asks a repair worker
  const rounds = engine.acceptance.get(ticket.id).rounds
  assert.deepEqual(rounds.at(-1).repair, { attempts: 0, max: 0, status: 'none' })
})

test('publishTicket repairs a failing gate before giving up (publish closed loop)', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = repairEngine({ stateDir: dir, allowPush: true, gates: [
    { name: 'backend', command: 'cd ebs && mvn -B -ntp test', onFail: 'auto_repair', repairHint: 'hint' }] })
  ticket.status = 'ready'
  ticket.links = { branch: 'feature/tkt_test', worktree: '/tmp/wt/tkt_test', mergeRequest: null }
  const tasks = []
  const fake = fakeDeps({
    runCommand: async () => ({ exitCode: 1, timedOut: false, durationMs: 1, output: 'BUILD FAILURE' }),
    runWorker: async ({ task }) => { tasks.push(task); return { sessionId: 'repair-w', timedOut: false, text: '修了', toolCalls: [] } },
  })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: fake.deps })
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(tasks.length, 1)
  assert.match(tasks[0], /BUILD FAILURE/)
  assert.match(tasks[0], /repairHint|hint/)
  assert.equal(run.repairs.length, 1)
  assert.deepEqual(run.repair, { attempts: 1, max: 1, status: 'exhausted' })
  const round = engine.acceptance.get(ticket.id).rounds[0]
  assert.equal(round.status, 'failed')
  assert.deepEqual(round.repair, { attempts: 1, max: 1, status: 'exhausted' })
})

test('a park after a manual gate decision records repair status none in the round', async (t) => {
  const dir = await withStateDir(t)
  const { engine, ticket } = repairEngine({ stateDir: dir, maxRepairRounds: 1, gates: [
    { name: 'backend', command: 'cd ebs && mvn -B -ntp test' }] })
  const workers = scriptedWorkers([mainWorker])
  const gates = gateScript({ mvnFailures: 99 })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true,
    deps: fakeDeps({ runWorker: workers.runWorker, runCommand: gates.runCommand }).deps })
  assert.equal(run.status, 'waiting_for_human')
  const round = engine.acceptance.get(ticket.id).rounds[0]
  assert.equal(round.status, 'verifying')
  assert.deepEqual(round.repair, { attempts: 0, max: 1, status: 'none' })
  assert.equal(round.checks.find(item => item.name === 'backend').onFail, 'manual')
})

// Regression: the publish path used to run `passChangedFiles` gates without the changed paths, so the EBS deploy gate
// failed at argument parsing ("未指定任何文件") before touching the database.
function deployRepoConfig() {
  return normalizeRepos({
    ...config,
    gitlab: { ...config.gitlab, project: 'g/ebs', targetBranch: 'develop' },
    repos: [{ id: 'ebs', name: 'ebs', kind: 'oracle-ebs', repo: '/tmp/repo', baseBranch: 'develop',
      featurePrefix: 'feature/', worktreeRoot: '/tmp/wt', verifyMode: 'manual', acceptance: 'merged',
      gates: [{ name: 'ebs-deploy', command: 'python3 scripts/local/deploy_object.py',
        dryRunCommand: 'python3 scripts/local/deploy_object.py --dry-run', passChangedFiles: true,
        requireOutput: '待部署对象' }],
      gitlab: { baseUrl: 'https://gitlab.example', project: 'g/ebs', targetBranch: 'develop', createMr: 'api' } }],
  })
}

test('publishTicket passes the changed paths to passChangedFiles gates', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pubpaths', status: 'ready',
    links: { branch: 'feature/tkt_pubpaths', worktree: '/tmp/wt/tkt_pubpaths', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: deployRepoConfig(), tokens: { octo: 'tok', gitlab: 'glpat-test' },
    error: undefined })
  const commands = []
  const fake = fakeDeps({ runCommand: async command => {
    commands.push(command)
    return { exitCode: 0, timedOut: false, durationMs: 5, output: '待部署对象 1 个' }
  } })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  // An oracle-ebs repository has no CI pipeline: a successful publish lands on mr-open.
  assert.equal(run.status, 'mr-open')
  const deploy = commands.find(command => command.includes('deploy_object.py'))
  assert.ok(deploy)
  assert.match(deploy, /deploy_object\.py 'ebs\/ebs-ar\/src\/main\/java\/X\.java'/)
  assert.equal(run.gates[0].command, deploy)
  assert.equal(run.gates[0].missingEvidence, undefined)
  assert.equal(run.stopReason, 'done')
})

test('publishTicket fails when a gate does not print its required evidence', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pubevidence', status: 'ready',
    links: { branch: 'feature/tkt_pubevidence', worktree: '/tmp/wt/tkt_pubevidence', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: deployRepoConfig(), tokens: { octo: 'tok', gitlab: 'glpat-test' },
    error: undefined })
  const fake = fakeDeps({ runCommand: async () => ({ exitCode: 0, timedOut: false, durationMs: 5, output: 'nothing useful' }) })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(run.status, 'failed')
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(run.gates[0].missingEvidence, true)
  assert.equal(fake.calls.pushes.length, 0)
})

// Publish closed loop: a failing gate goes back to the worker, which repairs the worktree, and the gates re-run.
test('publishTicket hands a failed gate to the worker and publishes after the repair', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pubrepair', status: 'ready',
    links: { branch: 'feature/tkt_pubrepair', worktree: '/tmp/wt/tkt_pubrepair', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...deployRepoConfig(),
    executor: { ...deployRepoConfig().executor, maxRepairRounds: 1 } }, tokens: { octo: 'tok', gitlab: 'glpat-test' },
    error: undefined })
  const commands = []
  const repairTasks = []
  const fake = fakeDeps({
    runCommand: async command => {
      commands.push(command)
      // First publish attempt fails the way the real EBS deploy gate did; the repaired attempt passes.
      return commands.length === 1
        ? { exitCode: 1, timedOut: false, durationMs: 5, output: "ORA-00955: name is already used by an existing object" }
        : { exitCode: 0, timedOut: false, durationMs: 5, output: '待部署对象 1 个' }
    },
    runWorker: async ({ task }) => {
      repairTasks.push(task)
      return { sessionId: 'worker-publish-repair', timedOut: false, text: '已把部署脚本改为幂等并重跑闸门', toolCalls: ['edit'] }
    },
  })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(repairTasks.length, 1)
  assert.match(repairTasks[0], /OR[A]-00955/)
  assert.match(repairTasks[0], /ebs-deploy/)
  assert.equal(run.repair.status, 'succeeded')
  assert.equal(run.repairs.length, 1)
  assert.equal(run.repairs[0].text, '已把部署脚本改为幂等并重跑闸门')
  assert.equal(commands.length, 2)
  assert.equal(fake.calls.pushes.length, 1)
  assert.equal(run.status, 'mr-open')
})

test('publishTicket stops after the repair budget and reports gate_failed without pushing', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pubrepair2', status: 'ready',
    links: { branch: 'feature/tkt_pubrepair2', worktree: '/tmp/wt/tkt_pubrepair2', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...deployRepoConfig(),
    executor: { ...deployRepoConfig().executor, maxRepairRounds: 1 } }, tokens: { octo: 'tok', gitlab: 'glpat-test' },
    error: undefined })
  const fake = fakeDeps({ runCommand: async () => ({ exitCode: 1, timedOut: false, durationMs: 5, output: 'still broken' }) })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(run.status, 'failed')
  assert.equal(run.stopReason, 'gate_failed')
  assert.equal(run.repair.status, 'exhausted')
  assert.equal(run.repairs.length, 1)
  assert.equal(fake.calls.pushes.length, 0)
  assert.equal(ticket.status, 'failed')
})

test('publishTicket skips the worker when maxRepairRounds is 0', async () => {
  const { engine, ticket } = makeEngine({ ticket: { id: 'tkt_pubrepair0', status: 'ready',
    links: { branch: 'feature/tkt_pubrepair0', worktree: '/tmp/wt/tkt_pubrepair0', mergeRequest: null } } })
  engine.readConfig = () => ({ exists: true, config: { ...deployRepoConfig(),
    executor: { ...deployRepoConfig().executor, maxRepairRounds: 0 } }, tokens: { octo: 'tok', gitlab: 'glpat-test' },
    error: undefined })
  let workers = 0
  const fake = fakeDeps({
    runCommand: async () => ({ exitCode: 1, timedOut: false, durationMs: 5, output: 'broken' }),
    runWorker: async () => { workers += 1; return { sessionId: 'w', timedOut: false, text: '', toolCalls: [] } },
  })
  const run = await publishTicket({ engine, ticketId: ticket.id, deps: { ...fake.deps, createGitlabClient: () => fakeGitlab() } })
  assert.equal(workers, 0)
  assert.equal(run.status, 'failed')
  assert.equal(run.repair.attempts, 0)
  assert.equal(run.repair.status, 'none')
})

test('workerBrief can allow tooling edits on a repair round but never credentials', () => {
  const repair = workerBrief({ id: 'tkt_x', title: 't' }, config, undefined, { repair: true })
  assert.match(repair, /REPAIR ROUND/)
  assert.match(repair, /scripts\/local\//)
  assert.match(repair, /oracle_connect\.py/)
  assert.doesNotMatch(workerBrief({ id: 'tkt_x', title: 't' }, config), /REPAIR ROUND/)
})

test('auto routing runs a preferred CLI backend and records the route', async () => {
  const { engine, ticket } = makeEngine({ ticket: { title: '修复：保存收款单时校验银行账户必填', body: '修复保存校验' } })
  engine.readConfig = () => ({ exists: true, error: undefined, tokens: { octo: undefined, gitlab: undefined },
    config: { ...config, executor: { ...config.executor,
      workers: { dsh: {}, codex: {}, claude: {} },
      routing: { mode: 'auto', defaultBackend: 'dsh', preferences: [{ workTypes: ['dev'], backend: 'claude' }] } } } })
  const calls = []
  const { deps } = fakeDeps({
    runCliWorker: async options => { calls.push(options); return { sessionId: 'worker-cli', text: 'implemented', timedOut: false,
      toolCalls: ['edit'], backend: options.backend } },
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps })
  assert.equal(run.route.workType, 'dev')
  assert.equal(run.route.applied, true)
  assert.equal(run.route.backend, 'claude')
  assert.deepEqual(run.route.reason, { code: 'preference', workType: 'dev' })
  assert.equal(run.worker.backend, 'claude')
  assert.equal(run.worker.profile, 'write')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].backend, 'claude')
  assert.equal(calls[0].profile, 'write')
  assert.equal(ticket.route.backend, 'claude')
})

test('suggest routing records the preference but still runs the default backend', async () => {
  const { engine, ticket } = makeEngine({ ticket: { title: '修复：保存收款单时校验银行账户必填', body: '修复保存校验' } })
  engine.readConfig = () => ({ exists: true, error: undefined, tokens: { octo: undefined, gitlab: undefined },
    config: { ...config, executor: { ...config.executor,
      workers: { dsh: {}, codex: {}, claude: {} },
      routing: { mode: 'suggest', defaultBackend: 'dsh', preferences: [{ workTypes: ['dev'], backend: 'claude' }] } } } })
  const calls = []
  const { deps } = fakeDeps({
    runCliWorker: async options => { calls.push(options); return { sessionId: 'worker-cli', text: 'implemented', timedOut: false,
      toolCalls: [], backend: options.backend } },
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps })
  assert.equal(run.route.backend, 'claude')
  assert.equal(run.route.applied, false)
  assert.equal(run.worker.backend, 'dsh')
  // The default backend here is the in-process DSH worker, so no CLI was started at all.
  assert.equal(calls.length, 0)
})

test('a report-type Ticket delivered by a read-only backend closes with its report', async () => {
  const { engine, ticket } = makeEngine({ ticket: { title: '代码 review：检查审批流改动', body: 'review 审批流' } })
  engine.readConfig = () => ({ exists: true, error: undefined, tokens: { octo: undefined, gitlab: undefined },
    config: { ...config, executor: { ...config.executor,
      workers: { dsh: {}, codex: {} },
      routing: { mode: 'auto', defaultBackend: 'dsh', preferences: [{ workTypes: ['review'], backend: 'codex' }] } } } })
  const calls = []
  const { deps, calls: fakeCalls } = fakeDeps({
    changedPaths: async () => [],
    runCliWorker: async options => { calls.push(options); return { sessionId: 'worker-cli', text: '没有发现阻塞问题', timedOut: false,
      toolCalls: [], backend: options.backend } },
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps })
  assert.equal(run.route.workType, 'review')
  assert.equal(run.route.profile, 'read-only')
  assert.equal(run.route.deliverable, 'report')
  assert.equal(run.worker.backend, 'codex')
  assert.equal(calls[0].profile, 'read-only')
  assert.equal(run.status, 'closed')
  assert.equal(ticket.status, 'closed')
  assert.equal(ticket.links.report.text, '没有发现阻塞问题')
  assert.equal(ticket.links.report.backend, 'codex')
  // No gates, commit or push for a report-only delivery.
  assert.equal(fakeCalls.commands.length, 0)
  assert.equal(fakeCalls.commits.length, 0)
  assert.equal(fakeCalls.pushes.length, 0)
})

test('a manual backend override wins over routing', async () => {
  const { engine, ticket } = makeEngine({ ticket: { title: '修复：保存校验', body: '修复' } })
  engine.readConfig = () => ({ exists: true, error: undefined, tokens: { octo: undefined, gitlab: undefined },
    config: { ...config, executor: { ...config.executor,
      workers: { dsh: {}, codex: {}, claude: {} },
      routing: { mode: 'auto', defaultBackend: 'dsh' } } } })
  const calls = []
  const { deps } = fakeDeps({
    runCliWorker: async options => { calls.push(options); return { sessionId: 'worker-cli', text: 'implemented', timedOut: false,
      toolCalls: [], backend: options.backend } },
  })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, backend: 'claude', deps })
  assert.equal(run.route.mode, 'manual')
  assert.deepEqual(run.route.reason, { code: 'manual' })
  assert.equal(run.route.backend, 'claude')
  assert.equal(run.worker.backend, 'claude')
  assert.equal(calls[0].backend, 'claude')
})

test('planned workflow invokes independent Codex stages and cannot push rejected work', async () => {
  for (const verdict of ['passed', 'blocked']) {
    const { engine, ticket } = makeEngine()
    engine.readConfig = () => ({ config: { ...config, executor: { ...config.executor, workflowMode: 'planned', implementer: 'dsh' } }, tokens: {} })
    const sessions = []
    const fake = fakeDeps({ candidateDigest: async () => 'candidate', runCliWorker: async options => {
      sessions.push(options.sessionId)
      assert.equal(options.profile, 'read-only')
      const result = options.outputSchema.properties.verdict
        ? { verdict, findings: [], evidence: ['gates'] }
        : { summary: 'plan', steps: ['implement'], acceptanceCriteria: [{ id: 'AC1', requirement: 'fix', verification: 'test' }], openQuestions: [] }
      return { text: JSON.stringify(result), sessionId: options.sessionId }
    } })
    const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
    assert.equal(run.status, verdict === 'passed' ? 'dry-run' : 'failed', run.error)
    assert.equal(sessions.length, 2)
    assert.notEqual(sessions[0], sessions[1])
    assert.equal(fake.calls.pushes.length, 0)
    assert.equal(ticket.workflow.status, verdict === 'passed' ? 'ready' : 'blocked')
  }
})

// executor.reviewer moves the analysis and final review stages to another CLI backend.
test('planned workflow honors executor.reviewer for assessment, planning and review', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ config: { ...config,
    executor: { ...config.executor, workflowMode: 'planned', implementer: 'dsh', reviewer: 'claude' } }, tokens: {} })
  const calls = []
  const fake = fakeDeps({ candidateDigest: async () => 'candidate', runCliWorker: async options => {
    calls.push(options.backend)
    const result = options.outputSchema.properties.verdict
      ? { verdict: 'passed', findings: [], evidence: ['gates'] }
      : { summary: 'plan', steps: ['implement'], acceptanceCriteria: [{ id: 'AC1', requirement: 'fix', verification: 'test' }], openQuestions: [] }
    return { text: JSON.stringify(result), sessionId: options.sessionId }
  } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(run.status, 'dry-run', run.error)
  // planned mode skips assessment: planning and review are the two CLI stages.
  assert.deepEqual(calls, ['claude', 'claude'])
  assert.equal(ticket.workflow.stages.find(stage => stage.role === 'review').backend, 'claude')
})

// P1-5: a staged workflow that stopped at its review continues there — implement and gates are not redone.
test('resuming a blocked workflow re-runs only the failed review and delivers', async () => {
  const { engine, ticket } = makeEngine()
  engine.readConfig = () => ({ config: { ...config,
    executor: { ...config.executor, workflowMode: 'planned', implementer: 'dsh' } }, tokens: {} })
  const planResult = { summary: 'plan', steps: ['implement'],
    acceptanceCriteria: [{ id: 'AC1', requirement: 'fix', verification: 'test' }], openQuestions: [] }
  let implementRuns = 0
  const first = fakeDeps({ candidateDigest: async () => 'candidate',
    runWorker: async () => { implementRuns += 1; return { sessionId: 'worker-1', timedOut: false, text: 'done' } },
    runCliWorker: async options => {
      if (options.outputSchema.properties.verdict) throw new Error('codex usage limit')
      return { text: JSON.stringify(planResult), sessionId: options.sessionId }
    } })
  const failed = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: first.deps })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /usage limit/)
  assert.equal(ticket.workflow.stages.at(-1).role, 'review')
  assert.equal(ticket.workflow.stages.at(-1).status, 'failed')
  const stoppedAt = ticket.workflow.stages.length

  const reviews = []
  const second = fakeDeps({ candidateDigest: async () => 'candidate',
    runWorker: async () => { implementRuns += 1; return { sessionId: 'worker-2', timedOut: false, text: 'done' } },
    runCliWorker: async options => { reviews.push(options.sessionId)
      return { text: JSON.stringify({ verdict: 'passed', findings: [], evidence: ['gates'] }), sessionId: options.sessionId } } })
  const run = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, resumeWorkflow: true, deps: second.deps })
  assert.equal(run.status, 'dry-run', run.error)
  assert.equal(implementRuns, 1, 'implement must not run again on resume')
  assert.equal(reviews.length, 1, 'only the review re-runs')
  assert.equal(ticket.workflow.status, 'ready')
  const saved = engine.state.tickets[ticket.id]
  assert.equal(saved.workflow.stages.length, stoppedAt)
  assert.equal(saved.workflowDigest, 'candidate')
  // The resumed run inherits the gates evidence and implementation summary instead of showing an empty run.
  assert.equal(run.gates.length, 3)
  assert.equal(run.worker.text, 'done')
  assert.ok(run.steps.some(step => step.name === 'workflow:resume'))
})

// A reviewer that rejects every round spends the budget: the run says why instead of "workflow blocked: blocked", and
// the workflow can continue once executor.maxRepairRounds is raised.
test('a workflow that spent its repair budget explains why and continues after the budget is raised', async () => {
  const { engine, ticket } = makeEngine()
  const workflowConfig = maxRepairRounds => ({ config: { ...config,
    executor: { ...config.executor, workflowMode: 'planned', implementer: 'dsh', maxRepairRounds } }, tokens: {} })
  engine.readConfig = () => workflowConfig(2)
  const planResult = { summary: 'plan', steps: ['implement'],
    acceptanceCriteria: [{ id: 'AC1', requirement: 'fix', verification: 'test' }], openQuestions: [] }
  let implementationRuns = 0
  let reviews = 0
  let verdict = 'changes_requested'
  const fake = fakeDeps({ candidateDigest: async () => 'candidate',
    runWorker: async () => { implementationRuns += 1; return { sessionId: `worker-${implementationRuns}`, timedOut: false, text: 'done' } },
    runCliWorker: async options => {
      if (!options.outputSchema.properties.verdict) return { text: JSON.stringify(planResult), sessionId: options.sessionId }
      reviews += 1
      const result = { verdict, findings: verdict === 'changes_requested' ? ['P1 keeps failing'] : [], evidence: ['gates'] }
      return { text: JSON.stringify(result), sessionId: options.sessionId }
    } })
  const failed = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: fake.deps })
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /workflow blocked: review still requested changes after 2 repair round/)
  assert.equal(ticket.workflow.reason, 'review_changes_requested')
  assert.equal(ticket.workflow.detail, 'review still requested changes after 2 repair round(s) (1 findings); raise executor.maxRepairRounds to keep repairing')
  assert.equal(implementationRuns, 3)
  assert.equal(reviews, 3)

  // With the budget still spent, the host refuses and repeats the readable reason instead of "no interrupted run".
  const refused = await resumeInterruptedTicket({ engine, ticketId: ticket.id, deps: fake.deps })
  assert.match(refused.invalid, /workflow blocked: review still requested changes after 2 repair round/)

  engine.readConfig = () => workflowConfig(4)
  verdict = 'passed'
  const resumed = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, resumeWorkflow: true, deps: fake.deps })
  assert.equal(resumed.status, 'dry-run', resumed.error)
  assert.equal(implementationRuns, 4, 'one more repair round runs the implementer')
  assert.equal(reviews, 4, 'the next review runs once')
  assert.equal(ticket.workflow.status, 'ready')
  assert.equal(ticket.workflow.repairs, 3)
  assert.ok(resumed.steps.some(step => step.name === 'workflow:resume'))
})
