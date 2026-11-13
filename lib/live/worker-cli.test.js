import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliInvocation, parseClaudeStream, parseCodexStream, resolveCliCommand, runCliWorker, runProcess,
  workerBackendOf } from './worker-cli.js'

/** Minimal child_process substitute: records the invocation and feeds scripted stdout/stderr. */
function fakeSpawn({ code = 0, stdout = '', stderr = '', hang = false, onSpawn } = {}) {
  const calls = []
  const spawn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    let closed = false
    const close = (exitCode, signal) => { if (closed) return; closed = true; child.emit('close', exitCode, signal) }
    child.kill = () => { close(null, 'SIGTERM'); return true }
    process.nextTick(() => {
      onSpawn?.({ command, args, options })
      child.stdout.end(stdout)
      child.stderr.end(stderr)
      if (!hang) setImmediate(() => close(code, null))
    })
    return child
  }
  return { spawn, calls }
}

test('workerBackendOf falls back to dsh for absent or unknown values', () => {
  assert.equal(workerBackendOf(undefined), 'dsh')
  assert.equal(workerBackendOf({ executor: {} }), 'dsh')
  assert.equal(workerBackendOf({ executor: { workerBackend: 'nope' } }), 'dsh')
  assert.equal(workerBackendOf({ executor: { workerBackend: 'codex' } }), 'codex')
})

test('resolveCliCommand honours the configured path and otherwise picks claude / bundled codex', () => {
  assert.equal(resolveCliCommand('claude', '/custom/claude'), '/custom/claude')
  assert.equal(resolveCliCommand('claude', ''), 'claude')
  assert.match(resolveCliCommand('codex', ''), /codex$/)
})

test('Codex invocation runs non-interactive in the worktree with sandbox and no network', () => {
  const args = cliInvocation('codex', { cwd: '/wt/ticket', systemPrompt: 'BRIEF', task: 'TASK', model: 'gpt-6-astra', lastFile: '/tmp/last' })
  assert.equal(args[0], 'exec')
  assert.ok(args.includes('-C') && args[args.indexOf('-C') + 1] === '/wt/ticket')
  assert.ok(args.includes('--skip-git-repo-check'))
  assert.ok(args.includes('--ephemeral'))
  assert.ok(args.includes('--json'))
  assert.ok(args.includes('-s') && args[args.indexOf('-s') + 1] === 'workspace-write')
  assert.ok(args.includes('approval_policy="never"'))
  assert.ok(args.includes('sandbox_workspace_write.network_access=false'))
  assert.ok(args.includes('-o') && args[args.indexOf('-o') + 1] === '/tmp/last')
  assert.ok(args.includes('-m') && args[args.indexOf('-m') + 1] === 'gpt-6-astra')
  const prompt = args.at(-1)
  assert.match(prompt, /BRIEF/)
  assert.match(prompt, /TASK/)
})

test('Claude invocation grants file tools and Bash, and carries the brief as a system append', () => {
  const args = cliInvocation('claude', { cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK', model: 'deepseek-flash[1m]' })
  assert.ok(args.includes('-p') && args[args.indexOf('-p') + 1] === 'TASK')
  assert.ok(args.includes('--output-format') && args[args.indexOf('--output-format') + 1] === 'stream-json')
  assert.ok(args.includes('--verbose'))
  assert.ok(args.includes('--permission-mode') && args[args.indexOf('--permission-mode') + 1] === 'acceptEdits')
  const allowed = args[args.indexOf('--allowedTools') + 1]
  assert.equal(allowed, 'Read,Edit,Write,Glob,Grep,Bash')
  const denied = args[args.indexOf('--disallowedTools') + 1]
  assert.doesNotMatch(denied, /Bash/)
  // A read-only review keeps the plan profile, which blocks edits, but may still run git diff and tests.
  const review = cliInvocation('claude', { cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK', profile: 'read-only' })
  assert.equal(review[review.indexOf('--permission-mode') + 1], 'plan')
  assert.equal(review[review.indexOf('--allowedTools') + 1], 'Read,Glob,Grep,Bash')
  assert.ok(args.includes('--append-system-prompt') && args[args.indexOf('--append-system-prompt') + 1] === 'BRIEF')
  // A review schema goes to Claude as inline JSON text: --json-schema takes the schema, not a file path.
  const schemaPath = join(tmpdir(), `superagent-claude-schema-${process.pid}.json`)
  writeFileSync(schemaPath, JSON.stringify({ type: 'object' }))
  try {
    const withSchema = cliInvocation('claude', { cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK', schemaFile: schemaPath })
    assert.equal(withSchema[withSchema.indexOf('--json-schema') + 1], '{"type":"object"}')
  } finally { rmSync(schemaPath, { force: true }) }
  assert.ok(args.includes('--model') && args[args.indexOf('--model') + 1] === 'deepseek-flash[1m]')
})

test('Claude stream parsing keeps the final result, session id and tool names', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1', tools: ['Bash'] }),
    JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [
      { type: 'text', text: 'working' }, { type: 'tool_use', name: 'Read', input: {} }, { type: 'tool_use', name: 'Edit', input: {} }] } }),
    JSON.stringify({ type: 'assistant', session_id: 'sess-1', message: { content: [{ type: 'text', text: 'done' }] } }),
    JSON.stringify({ type: 'result', session_id: 'sess-1', result: 'FINAL', is_error: false }),
  ].join('\n')
  const parsed = parseClaudeStream(stdout)
  assert.equal(parsed.sessionId, 'sess-1')
  assert.equal(parsed.text, 'FINAL')
  assert.deepEqual(parsed.toolCalls, ['Read', 'Edit'])
  assert.equal(parsed.isError, false)
})

test('Claude structured output is used when the result event carries no text', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-3' }),
    JSON.stringify({ type: 'result', session_id: 'sess-3', is_error: false,
      structured_output: { verdict: 'passed', findings: [], evidence: ['gates'] } }),
  ].join('\n')
  const parsed = parseClaudeStream(stdout)
  assert.equal(parsed.text, JSON.stringify({ verdict: 'passed', findings: [], evidence: ['gates'] }))
})

test('Codex stream parsing keeps the final agent message and command/file tools', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'file_change', changes: [] } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n')
  const parsed = parseCodexStream(stdout, 'LAST')
  assert.equal(parsed.sessionId, 'thread-1')
  assert.equal(parsed.text, 'DONE')
  assert.deepEqual(parsed.toolCalls, ['bash', 'edit'])
  assert.equal(parseCodexStream('', 'LAST').text, 'LAST')
})

test('runCliWorker returns the Codex final message, tools and session', async () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-9' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm test' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STREAMED' } }),
  ].join('\n')
  const fake = fakeSpawn({ stdout, onSpawn: ({ args }) => writeFileSync(args[args.indexOf('-o') + 1], 'FINAL FILE') })
  const result = await runCliWorker({ backend: 'codex', cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.equal(result.backend, 'codex')
  assert.equal(result.sessionId, 'thread-9')
  assert.equal(result.text, 'STREAMED')
  assert.deepEqual(result.toolCalls, ['bash'])
  assert.equal(result.exitCode, 0)
  assert.equal(result.error, undefined)
  // P1 contract §6.1: a CLI worker has no host tool registry, so its report is always undefined (shape parity).
  assert.equal('report' in result, true)
  assert.equal(result.report, undefined)
  assert.equal(fake.calls[0].command, resolveCliCommand('codex', ''))
  assert.equal(fake.calls[0].options.cwd, '/wt')
})

test('runCliWorker returns the Claude result and session', async () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2' }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write' }] } }),
    JSON.stringify({ type: 'result', session_id: 'sess-2', result: 'OK', is_error: false }),
  ].join('\n')
  const fake = fakeSpawn({ stdout })
  const result = await runCliWorker({ backend: 'claude', cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.equal(result.backend, 'claude')
  assert.equal(result.sessionId, 'sess-2')
  assert.equal(result.text, 'OK')
  assert.deepEqual(result.toolCalls, ['Write'])
  assert.equal(result.report, undefined)
})

test('a missing CLI fails with a message naming the command', async () => {
  const spawn = () => { throw Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }
  await assert.rejects(() => runCliWorker({ backend: 'codex', cwd: '/wt', systemPrompt: 'B', task: 'T',
    spawnImpl: spawn }), /CLI not found/)
})

test('a non-zero CLI exit becomes a worker error with stderr tail', async () => {
  const fake = fakeSpawn({ code: 2, stderr: 'permission denied' })
  const result = await runCliWorker({ backend: 'claude', cwd: '/wt', systemPrompt: 'B', task: 'T',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.match(result.error, /claude CLI exited with code 2/)
  assert.match(result.error, /permission denied/)
})

test('runProcess keeps the stream tail when the stdout cap is reached', async () => {
  // Claude emits one thinking_tokens event per token; the verdict is the LAST line, so the cap must drop the head.
  const filler = Array.from({ length: 20 }, (_, i) => JSON.stringify({ type: 'system', subtype: 'thinking_tokens', n: i }))
  const verdict = JSON.stringify({ type: 'result', result: '{"verdict":"passed"}', is_error: false })
  const fake = fakeSpawn({ stdout: [...filler, verdict].join('\n') })
  const proc = await runProcess({ command: 'claude', args: [], cwd: '/wt', timeoutMs: 5_000, spawnImpl: fake.spawn, maxStdout: 300 })
  assert.ok(proc.stdout.endsWith(verdict))
  assert.doesNotMatch(proc.stdout, /"n":0\b/)
})

test('a CLI that exits 0 without result text is reported instead of failing JSON parse', async () => {
  const fake = fakeSpawn({ stdout: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-2' }) })
  const result = await runCliWorker({ backend: 'claude', cwd: '/wt', systemPrompt: 'B', task: 'T',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.equal(result.text, '')
  assert.match(result.error, /claude CLI returned no result text/)
})

test('a timed-out CLI is killed and reported as timedOut', async () => {
  const fake = fakeSpawn({ hang: true })
  const proc = await runProcess({ command: 'claude', args: [], cwd: '/wt', timeoutMs: 1, spawnImpl: fake.spawn })
  assert.equal(proc.timedOut, true)
}).timeout?.(5_000)

// ---------------------------------------------------------------------------
// P0 contract §3.5: normalised CLI events for run.trace.
// ---------------------------------------------------------------------------

test('Claude stream parsing produces normalised events (assistant, tool_call, turn_end)', () => {
  const stdout = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-1' }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'working' }, { type: 'tool_use', name: 'Read', input: { file_path: '/a' } }] } }),
    JSON.stringify({ type: 'result', session_id: 'sess-1', result: 'FINAL', is_error: false }),
  ].join('\n')
  const parsed = parseClaudeStream(stdout)
  assert.deepEqual(parsed.events.map(event => event.type), ['assistant', 'tool_call', 'turn_end'])
  assert.equal(parsed.events[1].name, 'Read')
  assert.match(parsed.events[1].summary, /file_path/)
  assert.equal(parsed.events.at(-1).summary, 'FINAL')
})

test('Codex stream parsing produces normalised command/file tool events', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm test' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'DONE' } }),
    JSON.stringify({ type: 'turn.completed', usage: {} }),
  ].join('\n')
  const parsed = parseCodexStream(stdout)
  assert.deepEqual(parsed.events.map(event => event.type), ['tool_call', 'assistant', 'turn_end'])
  assert.equal(parsed.events[0].name, 'bash')
  assert.equal(parsed.events[0].summary, 'pnpm test')
  assert.equal(parsed.events[1].summary, 'DONE')
})

test('runCliWorker returns the normalised events alongside the historical fields', async () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 'thread-9' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm test' } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'STREAMED' } }),
  ].join('\n')
  const fake = fakeSpawn({ stdout, onSpawn: ({ args }) => writeFileSync(args[args.indexOf('-o') + 1], 'FINAL FILE') })
  const result = await runCliWorker({ backend: 'codex', cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.deepEqual(result.events.map(event => event.type), ['tool_call', 'assistant'])
  assert.ok(result.events.every(event => typeof event.at === 'string'))
  // The historical return fields are untouched.
  assert.equal(result.text, 'STREAMED')
  assert.equal(result.sessionId, 'thread-9')
})

test('a CLI stream without structured events returns events: []', async () => {
  const fake = fakeSpawn({ stdout: 'plain text progress, no json' })
  const result = await runCliWorker({ backend: 'claude', cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.deepEqual(result.events, [])
  assert.equal(result.text, '')
})

test('CLI events are capped at 80 and clipped to 300-character summaries', async () => {
  const lines = []
  for (let index = 0; index < 100; index += 1) {
    lines.push(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: `step ${index} ${'y'.repeat(400)}` }] } }))
  }
  const fake = fakeSpawn({ stdout: lines.join('\n') })
  const result = await runCliWorker({ backend: 'claude', cwd: '/wt', systemPrompt: 'BRIEF', task: 'TASK',
    timeoutMs: 5_000, spawnImpl: fake.spawn })
  assert.equal(result.events.length, 80)
  assert.ok(result.events.every(event => (event.summary ?? '').length <= 300))
})
