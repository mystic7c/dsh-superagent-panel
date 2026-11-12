import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runWorker, joinChildrenBeforeTurnEnd } from './worker.js'

/** Build a fake host context that records create/setup/followup/dispose calls. */
function fakeHost({ reply = () => [], timeoutOnFollowup = false, subagents, setupOnCreate = false } = {}) {
  const state = { created: undefined, setupCtx: undefined, prompts: [], guards: [], policies: [], disposed: 0, cancelled: 0,
    followedUp: 0, turnStopping: [], turnStoppingHistory: [] }
  const handlers = []
  const byType = new Map()
  const emit = (type, ...args) => { for (const handler of [...(byType.get(type) ?? [])]) handler(...args) }
  const session = { id: 'worker-test-1' }
  const agent = {
    id: 'worker-test-1',
    session,
    followup(message) {
      state.followedUp += 1
      state.lastMessage = message
      if (timeoutOnFollowup) return
      for (const event of reply()) {
        setImmediate(() => emit('session/event', session, event))
      }
    },
    cancel(cause) { state.cancelled += 1; state.cancelCause = cause },
  }
  const handle = { agent, dispose: async () => { state.disposed += 1 } }
  const ctx = {
    get(name) {
      if (name === 'agents') return { create: async options => {
        state.created = options
        state.setupCtx = options.setup
        if (setupOnCreate) await options.setup(agentCtx)
        return handle
      } }
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }), mount: async (_agentCtx, id) => { state.mounted = id } }
      if (name === 'approval') return { setPolicy: (_agent, policy) => { state.policies.push(policy) } }
      return undefined
    },
    on(type, handler) {
      handlers.push(handler)
      if (!byType.has(type)) byType.set(type, new Set())
      byType.get(type).add(handler)
      return () => {
        const index = handlers.indexOf(handler)
        if (index >= 0) handlers.splice(index, 1)
        byType.get(type)?.delete(handler)
      }
    },
  }
  const agentCtx = {
    get(name) {
      if (name === 'systemPrompt') return { section: section => state.prompts.push(section) }
      if (name === 'tools') return { guard: guard => state.guards.push(guard) }
      if (name === 'subagents') return subagents
      return undefined
    },
    on(type, handler) {
      if (type !== 'agent/turn-stopping') return () => {}
      state.turnStopping.push(handler)
      state.turnStoppingHistory.push(handler)
      return () => {
        const index = state.turnStopping.indexOf(handler)
        if (index >= 0) state.turnStopping.splice(index, 1)
      }
    },
  }
  return { ctx, agentCtx, state, handlers, agent, session, emit }
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
  // Team/workflow tools stay denied (their result would belong to another interface); subagents are allowed because
  // the turn boundary now joins them before the turn may close (2026-11-09).
  for (const name of ['workflow', 'wait_agent', 'spawn_teammate', 'create_goal']) {
    assert.match(guard({ name }), /unavailable/, name)
  }
  for (const name of ['subagent', 'subagent_fork', 'list_agents', 'send_message']) {
    assert.equal(guard({ name }), undefined, name)
  }
  assert.equal(guard({ name: 'bash' }), undefined)
  // P1 report tools must stay visible: they are the worker's only sanctioned way to publish a report.
  for (const name of ['superagent_report_progress', 'superagent_report_artifact', 'superagent_set_verify', 'superagent_ask_human']) {
    assert.equal(guard({ name }), undefined)
  }
})

test('the worker registers a turn-stopping join for its subagents and cleans it up', async () => {
  const calls = { lists: 0, waits: 0 }
  let running = 1
  const subagents = {
    async listDescendants() {
      calls.lists += 1
      return running > 0 ? [{ kind: 'child', activity: 'running', id: 'child-1', hasChildren: false }] : []
    },
    async waitForChildren() { calls.waits += 1; running = 0; return true },
  }
  const host = fakeHost({ reply: () => [turnEnd()], subagents, setupOnCreate: true })
  await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  assert.equal(host.state.turnStopping.length, 0) // disposer released the listener
  assert.equal(host.state.turnStoppingHistory.length, 1)
  const listener = host.state.turnStoppingHistory[0]
  const result = await listener({ agent: host.agent, signal: new AbortController().signal })
  assert.equal(calls.waits, 1)
  assert.equal(calls.lists, 2)
  assert.equal(result.joined, 1)
})

test('joinChildrenBeforeTurnEnd() stays out of the way when no child is running', async () => {
  const calls = { lists: 0, waits: 0 }
  const subagents = {
    async listDescendants() { calls.lists += 1; return [] },
    async waitForChildren() { calls.waits += 1; return true },
  }
  const result = await joinChildrenBeforeTurnEnd({ subagents, payload: { agent: { id: 'a' }, signal: new AbortController().signal } })
  assert.deepEqual(result, { waited: false, joined: 0 })
  assert.equal(calls.lists, 1)
  assert.equal(calls.waits, 0)
})

test('joinChildrenBeforeTurnEnd() lets idle resident children through', async () => {
  const subagents = {
    async listDescendants() { return [{ kind: 'child', activity: 'running', id: 'child-1', hasChildren: false }] },
    async waitForChildren() { return false },
  }
  const result = await joinChildrenBeforeTurnEnd({ subagents, payload: { agent: { id: 'a' }, signal: new AbortController().signal } })
  assert.equal(result.waited, true)
  assert.equal(result.joined, 1)
})

test('joinChildrenBeforeTurnEnd() returns early on abort and missing services', async () => {
  assert.deepEqual(await joinChildrenBeforeTurnEnd({}), { waited: false, joined: 0 })
  const controller = new AbortController()
  controller.abort()
  const subagents = { async waitForChildren() { throw new Error('must not be called') },
    async listDescendants() { throw new Error('must not be called') } }
  assert.deepEqual(await joinChildrenBeforeTurnEnd({ subagents, payload: { agent: { id: 'a' }, signal: controller.signal } }),
    { waited: false, joined: 0, aborted: true })
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

// ---------------------------------------------------------------------------
// P0 contract §3.5: normalised events for run.trace.
// ---------------------------------------------------------------------------

const toolResult = (name, output) => ({ type: 'tool/result', data: { turn: 1, step: 1, name, output } })

test('collects normalised events for assistant text, tool calls/results and turn end', async () => {
  const host = fakeHost({ reply: () => [
    assistant('first'), tool('bash'), toolResult('bash', 'exit 0'),
    { type: 'tool/call', data: { name: 'edit', arguments: { path: '/tmp/wt/a.js' } } },
    assistant('final answer'), turnEnd(),
  ] })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  const types = result.events.map(event => event.type)
  assert.deepEqual(types, ['assistant', 'tool_call', 'tool_result', 'tool_call', 'assistant', 'turn_end'])
  assert.equal(result.events[0].summary, 'first')
  assert.equal(result.events[1].name, 'bash')
  assert.equal(result.events[2].name, 'bash')
  assert.equal(result.events[2].summary, 'exit 0')
  assert.equal(result.events[3].name, 'edit')
  assert.match(result.events[3].summary, /a\.js/)
  assert.equal(result.events.at(-1).state, 'completed')
  assert.ok(result.events.every(event => typeof event.at === 'string' && event.at))
})

test('only records an assistant event when the text actually changes', async () => {
  const host = fakeHost({ reply: () => [assistant('same'), assistant('same'), turnEnd()] })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  assert.equal(result.events.filter(event => event.type === 'assistant').length, 1)
  assert.equal(result.text, 'same')
})

test('worker events are capped at 80 with 300-character summaries', async () => {
  const replies = []
  for (let index = 0; index < 100; index += 1) replies.push(assistant(`step ${index} ${'x'.repeat(400)}`))
  replies.push(turnEnd())
  const host = fakeHost({ reply: () => replies })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  assert.equal(result.events.length, 80)
  assert.equal(result.events.at(-1).type, 'turn_end')
  assert.ok(result.events.every(event => (event.summary ?? '').length <= 300))
  assert.ok(result.text.startsWith('step 99'))
})

test('a timeout keeps the collected events and appends a terminal error event', async () => {
  const host = fakeHost({ timeoutOnFollowup: true })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 25 })
  assert.equal(result.timedOut, true)
  assert.ok(Array.isArray(result.events))
  assert.equal(result.events.at(-1).type, 'error')
  assert.equal(result.events.at(-1).state, 'timeout')
})

// ---------------------------------------------------------------------------
// Executor watchdog: a worker that dies without `turn/end` must not hold the run `working` until the overall timeout.
// ---------------------------------------------------------------------------

test('a worker that emits no event for idleTimeoutMs settles as worker_lost', async () => {
  const host = fakeHost({ timeoutOnFollowup: true })
  const started = Date.now()
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, idleTimeoutMs: 40 })
  assert.equal(result.error, 'worker_lost')
  assert.equal(result.timedOut, false)
  assert.ok(Date.now() - started < 2000, 'idle watchdog fired before the overall timeout')
  assert.equal(host.state.cancelled, 1)
  assert.match(host.state.cancelCause, /idle/)
  assert.equal(result.events.at(-1).type, 'error')
  assert.equal(result.events.at(-1).state, 'worker_lost')
  assert.match(result.events.at(-1).summary, /no activity for 40ms/)
  assert.equal(result.events.filter(event => event.type === 'error').length, 1)
  assert.equal(host.handlers.length, 0)
  assert.equal(host.state.disposed, 1)
})

test('activity inside the window re-arms the idle watchdog instead of killing the worker', async () => {
  const host = fakeHost({ timeoutOnFollowup: true })
  const started = Date.now()
  const pending = runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, idleTimeoutMs: 120 })
  // One event 60ms in must push the deadline out: the worker cannot be declared lost before ~180ms.
  setTimeout(() => host.emit('session/event', host.session, assistant('still working')), 60)
  const result = await pending
  const elapsed = Date.now() - started
  assert.equal(result.error, 'worker_lost')
  assert.ok(elapsed >= 150, `idle timer was re-armed after the event (elapsed ${elapsed}ms)`)
  assert.ok(result.events.some(event => event.type === 'assistant' && event.summary === 'still working'))
  assert.equal(result.events.filter(event => event.type === 'error').length, 1)
})

test('a normal turn/end is unaffected by a short idle window', async () => {
  const host = fakeHost({ reply: () => [assistant('done'), turnEnd()] })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, idleTimeoutMs: 40 })
  assert.equal(result.error, undefined)
  assert.equal(result.timedOut, false)
  assert.equal(result.events.at(-1).type, 'turn_end')
  assert.equal(host.state.cancelled, 0)
})

test('a disposed worker session settles as worker_lost without waiting for the idle window', async () => {
  const host = fakeHost({ timeoutOnFollowup: true })
  const pending = runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, idleTimeoutMs: 5000 })
  setImmediate(() => host.emit('session/disposed', host.session))
  const result = await pending
  assert.equal(result.error, 'worker_lost')
  assert.equal(result.timedOut, false)
  assert.equal(result.events.at(-1).state, 'worker_lost')
  assert.match(result.events.at(-1).summary, /session ended/)
  assert.equal(host.state.cancelled, 0)
})

test('a disposed worker agent settles as worker_lost too', async () => {
  const host = fakeHost({ timeoutOnFollowup: true })
  const pending = runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, idleTimeoutMs: 5000 })
  setImmediate(() => host.emit('agent/disposed', { agent: host.agent }))
  const result = await pending
  assert.equal(result.error, 'worker_lost')
  assert.match(result.events.at(-1).summary, /agent was disposed/)
  assert.equal(host.handlers.length, 0)
})

// ---------------------------------------------------------------------------
// P1 contract §6: the worker's JSONL report (written by the report tools) comes back as `result.report`.
// ---------------------------------------------------------------------------

/** Fresh state dir for a report file, removed by the test hook. */
async function reportDir(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'superagent-worker-report-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  return stateDir
}

const reportLine = (event) => `${JSON.stringify(event)}\n`

test('a report written during the turn is returned as result.report', async (t) => {
  const reportFile = join(await reportDir(t), 'run_1.report.jsonl')
  const host = fakeHost({ reply: () => {
    appendFileSync(reportFile, reportLine({ type: 'progress', text: 'half done' }))
    appendFileSync(reportFile, reportLine({ type: 'artifact', path: 'src/a.js', note: 'fix' }))
    appendFileSync(reportFile, reportLine({ type: 'question', question: '选 A 还是 B?', options: ['A', 'B'] }))
    return [assistant('done'), turnEnd()]
  } })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, reportFile })
  assert.equal(result.timedOut, false)
  assert.deepEqual(result.report.progress.map(item => item.text), ['half done'])
  assert.equal(result.report.artifacts[0].path, 'src/a.js')
  assert.equal(result.report.verify.length, 0)
  assert.equal(result.report.question.question, '选 A 还是 B?')
  assert.deepEqual(result.report.question.options, ['A', 'B'])
})

test('a timed-out worker still returns the report it wrote before hanging', async (t) => {
  const reportFile = join(await reportDir(t), 'run_2.report.jsonl')
  writeFileSync(reportFile, reportLine({ type: 'progress', text: 'started' }))
  const host = fakeHost({ timeoutOnFollowup: true })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 25, reportFile })
  assert.equal(result.timedOut, true)
  assert.deepEqual(result.report.progress.map(item => item.text), ['started'])
})

test('a missing report file reads back as an empty report instead of failing', async (t) => {
  const reportFile = join(await reportDir(t), 'never-written.report.jsonl')
  const host = fakeHost({ reply: () => [turnEnd()] })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5000, reportFile })
  assert.deepEqual(result.report, { progress: [], artifacts: [], verify: [] })
})

test('without a reportFile the result omits report entirely', async () => {
  const host = fakeHost({ reply: () => [turnEnd()] })
  const result = await runWorker({ ctx: host.ctx, cwd: '/tmp/wt', systemPrompt: 'BRIEF', task: 'TASK', timeoutMs: 5000 })
  assert.equal('report' in result, false)
})
