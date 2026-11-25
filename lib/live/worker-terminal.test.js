import test from 'node:test'
import assert from 'node:assert/strict'
import { openWorkerTerminal } from './worker-terminal.js'

/** Host ctx substitute: only the two services the action reads, both optional like they are on a real host. */
function fakeCtx({ agent = { session: { id: 'sess-1' } }, controller, agents } = {}) {
  const opened = []
  const writes = []
  const terminal = { id: 'term-1', pid: 4242,
    write: async data => { writes.push(String(data)) },
    close: async () => {} }
  const services = {
    agents: agents ?? { get: id => agent && id === 'sess-1' ? agent : undefined },
    terminalController: controller ?? { openForAgent: async (owner, request) => { opened.push({ owner, request }); return terminal } },
  }
  return { ctx: { get: name => services[name] }, opened, writes }
}

test('the takeover opens a terminal in the run worktree and resumes that conversation', async () => {
  const { ctx, opened, writes } = fakeCtx()
  const result = await openWorkerTerminal({ ctx, body: { sessionId: 'sess-1', cwd: '/wt/t-1', resume: 'sess-9' } })
  assert.equal(result.terminalId, 'term-1')
  assert.equal(result.pid, 4242)
  assert.equal(result.resumed, true)
  assert.equal(opened.length, 1)
  const request = opened[0].request
  assert.equal(request.cwd, '/wt/t-1')
  assert.equal(request.policy.mode, 'danger-full-access')
  assert.equal(request.title, 'Claude Code · sess-9')
  // The pty queues input, so the command is typed as if the person had: with the trailing Enter.
  assert.deepEqual(writes, ['claude --resume sess-9\r'])
})

test('without a resumable id the terminal still opens, on a fresh claude', async () => {
  const { ctx, opened, writes } = fakeCtx()
  const result = await openWorkerTerminal({ ctx, body: { sessionId: 'sess-1', cwd: '/wt/t-1', resume: '' } })
  assert.equal(result.resumed, false)
  assert.equal(opened[0].request.title, 'Claude Code')
  assert.deepEqual(writes, ['claude\r'])
})

test('a session id that is not a plain id is refused instead of reaching a shell', async () => {
  const { ctx, opened } = fakeCtx()
  for (const resume of ['sess-1; rm -rf /', '$(whoami)', 'a b', 'x'.repeat(200)]) {
    await assert.rejects(() => openWorkerTerminal({ ctx, body: { sessionId: 'sess-1', cwd: '/wt', resume } }),
      error => error.httpStatus === 400)
  }
  assert.equal(opened.length, 0)
})

test('no GUI session, no live agent and no terminal service are refusals, not crashes', async () => {
  const missing = fakeCtx({ agent: null })
  await assert.rejects(() => openWorkerTerminal({ ctx: missing.ctx, body: { sessionId: 'sess-1', cwd: '/wt' } }),
    error => error.httpStatus === 409 && /会话未在运行/.test(error.message))
  const offline = fakeCtx({ agents: { get: () => undefined } })
  await assert.rejects(() => openWorkerTerminal({ ctx: offline.ctx, body: { sessionId: 'sess-1', cwd: '/wt' } }),
    error => error.httpStatus === 409)
  await assert.rejects(() => openWorkerTerminal({ ctx: fakeCtx().ctx, body: {} }), error => error.httpStatus === 400)
  const noTerminal = { get: () => undefined }
  await assert.rejects(() => openWorkerTerminal({ ctx: noTerminal, body: { sessionId: 'sess-1' } }),
    error => error.httpStatus === 409 && /终端服务/.test(error.message))
})

test('a terminal that refuses to open becomes an explainable 409', async () => {
  const { ctx } = fakeCtx({ controller: { openForAgent: async () => { throw new Error('terminal/limit-reached') } } })
  await assert.rejects(() => openWorkerTerminal({ ctx, body: { sessionId: 'sess-1', cwd: '/wt' } }),
    error => error.httpStatus === 409 && /limit-reached/.test(error.message))
})

test('a terminal that opens but rejects the command is closed and reported', async () => {
  let closed = 0
  const controller = { openForAgent: async () => ({ id: 'term-2', pid: 7, write: async () => { throw new Error('user-control') },
    close: async () => { closed += 1 } }) }
  const { ctx } = fakeCtx({ controller })
  await assert.rejects(() => openWorkerTerminal({ ctx, body: { sessionId: 'sess-1', cwd: '/wt', resume: 'sess-9' } }),
    error => error.httpStatus === 409 && /手动运行 claude/.test(error.message))
  assert.equal(closed, 1)
})
