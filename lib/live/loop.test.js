/**
 * Full-loop integration: a group message enters through the sync intake, becomes a Ticket, and the executor drives a
 * real git worktree through worker → changed paths → gates → dry-run evidence. Only the Octo client, the worker agent
 * and the gate commands are faked; git/worktree/state are real, so the seams between the modules are exercised.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Engine } from './engine.js'
import { executeTicket } from './executor.js'
import { prepareWorktree } from './repo.js'

const run = promisify(execFile)
const git = (cwd, ...args) => run('git', args, { cwd }).then(result => String(result.stdout).trim())

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'superagent-loop-'))
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

test('a group message becomes a ticket and the executor produces dry-run evidence on a real worktree', async () => {
  const f = await fixture()
  const stateDir = await mkdtemp(join(tmpdir(), 'superagent-loop-state-'))
  const config = {
    enabled: true, repo: f.repo, baseBranch: 'dev', featurePrefix: 'feature/', worktreeRoot: f.worktreeRoot, pollSeconds: 10,
    octo: { intake: 'sync', cliPath: '/bin/true', tokenFile: '', watchChatIds: ['chat-1'], chatTitles: {},
      channelType: 2, allowSenderIds: ['user-1'], allowAnyHuman: false, requireMention: false, botName: 'DSH_BOT',
      botUid: '', syncLimit: 100, backfill: true, replyPrefix: 'Superagent:' },
    gitlab: { baseUrl: 'https://gitlab.example', project: 'g/p', targetBranch: 'dev', createMr: 'push' },
    eval: { mode: 'rules' },
    executor: { enabled: true, allowPush: false, allowReply: false, gates: [], timeoutMs: 60_000, gateTimeoutMs: 60_000, model: null },
  }
  const messages = [{ messageSeq: 301, messageId: 301, fromUid: 'user-1', channelId: 'chat-1', channelType: 2,
    contentType: 1, text: '修复：保存收款单时校验银行账户必填', at: new Date().toISOString() }]
  const client = { syncMessages: async () => ({ messages, identity: { bot_kind: 'user_bot' } }) }
  try {
    const engine = new Engine({ stateDir, log: () => {}, deps: {
      loadConfig: () => ({ exists: true, config, tokens: { octo: 'tok' }, error: undefined }),
      createClient: async () => client,
    } })
    await engine.load()
    const poll = await engine.pollOnce({ dryRun: false })
    assert.equal(poll.mode, 'sync')
    assert.equal(poll.accepted.length, 1)
    const ticket = Object.values(engine.state.tickets)[0]
    assert.ok(ticket)
    assert.equal(ticket.origin.channelId, 'chat-1')
    assert.equal(ticket.status, 'queued')

    const result = await executeTicket({ ctx: {}, engine, ticketId: ticket.id, dryRun: true, deps: {
      prepareWorktree,
      runWorker: async ({ cwd }) => {
        await mkdir(join(cwd, 'ebs'), { recursive: true })
        await writeFile(join(cwd, 'ebs', 'BankAccountFix.java'), 'class BankAccountFix {}\n')
        return { sessionId: 'worker-loop', timedOut: false, text: 'added the missing required check', toolCalls: ['edit'] }
      },
      runCommand: async () => ({ exitCode: 0, timedOut: false, durationMs: 1, output: 'ok' }),
    } })
    assert.equal(result.status, 'dry-run')
    assert.equal(ticket.status, 'ready')
    assert.ok(result.changedPaths.includes('ebs/BankAccountFix.java'))
    assert.equal(await git(result.worktree, 'rev-parse', '--abbrev-ref', 'HEAD'), result.branch)
    assert.equal(await git(f.repo, 'status', '--porcelain'), '')
    assert.ok(result.steps.some(step => step.name === 'worker' && step.state === 'ok'))
    assert.ok(result.steps.some(step => step.name === 'changed-paths' && step.state === 'ok'))
  } finally {
    await rm(f.root, { recursive: true, force: true })
    await rm(stateDir, { recursive: true, force: true })
  }
})
