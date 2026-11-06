import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runWorker } from './worker.js'

/** Build a fake host context that records create/setup/followup/dispose calls. */
function fakeHost({ reply = () => [], timeoutOnFollowup = false } = {}) {
  const state = { created: undefined, setupCtx: undefined, prompts: [], guards: [], policies: [], disposed: 0, cancelled: 0, followedUp: 0 }
  const handlers = []
  const session = { id: 'worker-test-1' }
  const agent = {
    id: 'worker-test-1',
    session,
    followup(message) {
      state.followedUp += 1
      state.lastMessage = message
      if (timeoutOnFollowup) return
      for (const event of reply()) {
        setImmediate(() => { for (const handler of [...handlers]) handler(session, event) })
      }
    },
    cancel(cause) { state.cancelled += 1; state.cancelCause = cause },
  }
  const handle = { agent, dispose: async () => { state.disposed += 1 } }
  const ctx = {
    get(name) {
      if (name === 'agents') return { create: async options => { state.created = options; state.setupCtx = options.setup; return handle } }
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }), mount: async (_agentCtx, id) => { state.mounted = id } }
      if (name === 'approval') return { setPolicy: (_agent, policy) => { state.policies.push(policy) } }
      return undefined
    },
    on(type, handler) { handlers.push(handler); return () => { const index = handlers.indexOf(handler); if (index >= 0) handlers.splice(index, 1) } },
  }
  const agentCtx = {
    get(name) {
      if (name === 'systemPrompt') return { section: section => state.prompts.push(section) }
      if (name === 'tools') return { guard: guard => state.guards.push(guard) }
      return undefined
    },
  }
  return { ctx, agentCtx, state, handlers }
}

const assistant = (text) => ({ type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text }] } } })
const tool = (name) => ({ type: 'tool/call', data: { turn: 1, step: 1, name } })
const turnEnd = () => ({ type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })

test('runs one turn, injects the brief, collects text and tool calls, disposes the agent', async () => {
  const host = fakeHost({ reply: () => [assistant('修复完成，三闸门通过'), tool('bash'), tool('edit'), turnEnd()] })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  await host.state.setupCtx(host.agentCtx)
  assert.equal(result.text, '修复完成，三闸门通过')
  assert.deepEqual(result.toolCalls, ['bash', 'edit'])
  assert.equal(result.timedOut, false)
  assert.equal(host.state.mounted, 'standard')
  assert.equal(host.state.prompts[0].name, 'superagent:worker')
  assert.equal(host.state.prompts[0].text, 'BRIEF')
  assert.equal(host.state.policies[0], 'never')
  assert.equal(host.state.created.meta.cwd, '/tmp/wt')
  assert.equal(host.state.lastMessage.content[0].text, 'TASK')
  assert.equal(host.state.disposed, 1)
  assert.equal(host.handlers.length, 0)
})

test('tool guard denies headless-only tools', async () => {
  const host = fakeHost({ reply: () => [turnEnd()] })
  await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  await host.state.setupCtx(host.agentCtx)
  const guard = host.state.guards[0]
  assert.match(guard({ name: 'ask_user_question' }), /unavailable/)
  assert.equal(guard({ name: 'bash' }), undefined)
})

test('a timeout cancels the agent and reports timedOut', async () => {
  const host = fakeHost({ timeoutOnFollowup: true })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 30 })
  assert.equal(result.timedOut, true)
  assert.equal(host.state.cancelled, 1)
  assert.equal(host.state.disposed, 1)
  assert.equal(host.handlers.length, 0)
})

test('missing agents service fails fast', async () => {
  await assert.rejects(() => runWorker({ ctx: { get: () => undefined }, cwd: '/tmp', systemPrompt: '', task: '' }),
    /agents service is not available/)
})
