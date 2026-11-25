import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CHAT_MESSAGE_MAX, chatWithClaude } from './worker-chat.js'

const SESSION = '11111111-2222-3333-4444-555555555555'

/** The claude CLI is never spawned here: `run` records the call and returns the shape runCliWorker returns. The step
    count the chat reports comes from the stream (one `tool_call` entry per tool use), not from the worker's
    name-deduplicated `toolCalls` list. */
function fakeRun(answer = '好的') {
  const calls = []
  const events = [{ type: 'tool_call', summary: 'Read README.md' }, { type: 'tool_call', summary: 'Edit a.js' },
    { type: 'assistant', summary: answer }, { type: 'turn_end', summary: 'done' }]
  const run = async options => {
    calls.push(options)
    return { sessionId: options.resume ?? SESSION, text: answer, toolCalls: ['Read', 'Edit'], events,
      timedOut: false, exitCode: 0 }
  }
  return { calls, run }
}

const worktree = mkdtempSync(join(tmpdir(), 'sa-chat-'))
test.after(() => rmSync(worktree, { recursive: true, force: true }))

test('one message becomes one resumed CLI turn in that worktree', async () => {
  const { calls, run } = fakeRun()
  const result = await chatWithClaude({ body: { sessionId: SESSION, cwd: worktree, message: '  看下 README  ' }, run })
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.equal(call.backend, 'claude')
  assert.equal(call.cwd, worktree)
  assert.equal(call.task, '看下 README')
  assert.equal(call.resume, SESSION)
  // A chat turn works like the worker does: it may edit files, and it is not a review (no schema) turn.
  assert.equal(call.bot, 'write')
  assert.equal(result.text, '好的')
  assert.equal(result.toolCalls, 2)
  assert.equal(result.backend, 'claude')
})

test('a conversation without an id starts a new one', async () => {
  const { calls, run } = fakeRun()
  await chatWithClaude({ body: { cwd: worktree, message: '你好' }, run })
  assert.equal(calls[0].resume, undefined)
})

test('an id that is not a UUID never reaches --resume', async () => {
  for (const sessionId of ['worker-abc', 'sess-1', 'sess-1; rm -rf /', '11111111-2222']) {
    const { calls, run } = fakeRun()
    await assert.rejects(() => chatWithClaude({ body: { sessionId, cwd: worktree, message: '你好' }, run }),
      error => error.httpStatus === 400 && /会话标识格式不正确/.test(error.message), sessionId)
    assert.equal(calls.length, 0)
  }
})

test('the message and the directory are checked before anything spawns', async () => {
  for (const [body, pattern] of [
    [{ cwd: worktree, message: '   ' }, /消息不能为空/],
    [{ message: '你好' }, /缺少工作区路径/],
    [{ cwd: join(worktree, 'nope'), message: '你好' }, /工作区不存在/],
    [{ cwd: worktree, message: 'x'.repeat(CHAT_MESSAGE_MAX + 1) }, /消息太长/],
  ]) {
    const { calls, run } = fakeRun()
    await assert.rejects(() => chatWithClaude({ body, run }),
      error => error.httpStatus === 400 && pattern.test(error.message), JSON.stringify(body).slice(0, 40))
    assert.equal(calls.length, 0)
  }
})

test('a CLI that fails still reports its own error instead of pretending to answer', async () => {
  const run = async () => ({ sessionId: SESSION, text: '', toolCalls: 0, events: [], timedOut: false, exitCode: 1,
    error: 'worker-cli: claude exited with code 1' })
  const result = await chatWithClaude({ body: { sessionId: SESSION, cwd: worktree, message: '你好' }, run })
  assert.equal(result.text, '')
  assert.match(result.error, /exited with code 1/)
  assert.equal(result.exitCode, 1)
})
