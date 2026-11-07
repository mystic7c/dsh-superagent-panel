import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  REPORT_TOOL_NAMES, appendReportEvent, readWorkerReport, registerWorkerTools,
} from './worker-tools.js'

/** One throwaway state dir per test, removed by the test hook. */
async function dir(t) {
  const stateDir = await mkdtemp(join(tmpdir(), 'superagent-worker-tools-'))
  t.after(() => rm(stateDir, { recursive: true, force: true }))
  return stateDir
}

/** Fake tools service: records definitions and counts disposer calls. */
function fakeTools({ registerThrows = false } = {}) {
  const state = { registered: [], disposed: 0 }
  return {
    state,
    tools: {
      register(definition) {
        if (registerThrows) throw new Error('registry is closed')
        state.registered.push(definition)
        return () => { state.disposed += 1 }
      },
    },
  }
}

/** Fake `defineTool`: the identity function, so a registered definition is the options object itself. */
function fakeDefineTool(options) { return options }

const agentCtxOf = (tools) => ({ get: name => name === 'tools' ? tools : undefined })

test('REPORT_TOOL_NAMES lists the four contract tool names in registration order', () => {
  assert.deepEqual(REPORT_TOOL_NAMES, [
    'superagent_report_progress',
    'superagent_report_artifact',
    'superagent_set_verify',
    'superagent_ask_human',
  ])
})

test('append then read round-trips every report event type', async (t) => {
  const stateDir = await dir(t)
  const reportFile = join(stateDir, 'runs', 'run_1.report.jsonl')
  assert.equal(await appendReportEvent(reportFile, { type: 'progress', text: 'half done', at: '2026-11-07T00:00:00.000Z' }), true)
  assert.equal(await appendReportEvent(reportFile, { type: 'artifact', path: 'src/a.js', note: 'new export' }), true)
  assert.equal(await appendReportEvent(reportFile, { type: 'verify', name: 'backend tests', command: 'pnpm test', expectedOutput: 'tests passed' }), true)
  assert.equal(await appendReportEvent(reportFile, { type: 'question', question: 'A 还是 B？', options: ['A', 'B'] }), true)

  const report = readWorkerReport(reportFile)
  assert.deepEqual(report.progress, [{ text: 'half done', at: '2026-11-07T00:00:00.000Z' }])
  assert.equal(report.artifacts.length, 1)
  assert.equal(report.artifacts[0].path, 'src/a.js')
  assert.equal(report.artifacts[0].note, 'new export')
  assert.ok(report.artifacts[0].at)
  assert.deepEqual(report.verify.map(check => check.name), ['backend tests'])
  assert.equal(report.verify[0].command, 'pnpm test')
  assert.equal(report.verify[0].expectedOutput, 'tests passed')
  assert.equal(report.question.question, 'A 还是 B？')
  assert.deepEqual(report.question.options, ['A', 'B'])
  assert.equal((await readFile(reportFile, 'utf8')).trim().split('\n').length, 4)
})

test('readWorkerReport tolerates a missing file and an absent path', () => {
  const missing = join(tmpdir(), 'superagent-worker-tools-not-there', 'none.jsonl')
  assert.deepEqual(readWorkerReport(missing), { progress: [], artifacts: [], verify: [] })
  assert.deepEqual(readWorkerReport(undefined), { progress: [], artifacts: [], verify: [] })
})

test('readWorkerReport skips malformed lines, unknown event types and non-object JSON', async (t) => {
  const stateDir = await dir(t)
  const reportFile = join(stateDir, 'report.jsonl')
  await writeFile(reportFile, [
    'not json at all',
    '[]',
    '"a string"',
    JSON.stringify({ type: 'unknown', text: 'ignored' }),
    JSON.stringify({ text: 'no type' }),
    JSON.stringify({ type: 'progress', text: '' }),
    JSON.stringify({ type: 'artifact' }),
    JSON.stringify({ type: 'verify', name: '' }),
    '   ',
    JSON.stringify({ type: 'progress', text: 'kept' }),
    '',
  ].join('\n'))

  const report = readWorkerReport(reportFile)
  assert.deepEqual(report.progress.map(item => item.text), ['kept'])
  assert.ok(report.progress[0].at)
})

test('only the last question survives and its options are cleaned', async (t) => {
  const stateDir = await dir(t)
  const reportFile = join(stateDir, 'report.jsonl')
  await appendReportEvent(reportFile, { type: 'question', question: 'first?', options: ['x'] })
  await appendReportEvent(reportFile, { type: 'question', question: 'second?', options: ['A', '', '  ', 'B', 7] })
  const report = readWorkerReport(reportFile)
  assert.equal(report.question.question, 'second?')
  assert.deepEqual(report.question.options, ['A', 'B'])
})

test('appendReportEvent creates nested directories and rejects malformed events without throwing', async (t) => {
  const stateDir = await dir(t)
  const reportFile = join(stateDir, 'a', 'b', 'c', 'report.jsonl')
  assert.equal(await appendReportEvent(reportFile, { type: 'progress', text: 'ok' }), true)
  assert.equal(await appendReportEvent(undefined, { type: 'progress', text: 'ok' }), false)
  assert.equal(await appendReportEvent('', { type: 'progress', text: 'ok' }), false)
  assert.equal(await appendReportEvent(reportFile, null), false)
  assert.equal(await appendReportEvent(reportFile, { text: 'no type' }), false)
  assert.equal(await appendReportEvent(reportFile, { type: 'nope', text: 'x' }), false)
  assert.equal((await readFile(reportFile, 'utf8')).trim().split('\n').length, 1)
})

test('appendReportEvent reports false when the report path cannot be written', async (t) => {
  const stateDir = await dir(t)
  const blocker = join(stateDir, 'blocker')
  await writeFile(blocker, 'not a directory')
  assert.equal(await appendReportEvent(join(blocker, 'report.jsonl'), { type: 'progress', text: 'x' }), false)
})

test('registerWorkerTools registers four tools through the agent scope and disposes them', async (t) => {
  const stateDir = await dir(t)
  const reportFile = join(stateDir, 'report.jsonl')
  const { state, tools } = fakeTools()
  const calls = []
  const dispose = await registerWorkerTools(agentCtxOf(tools), {
    reportFile,
    deps: { defineTool: options => { calls.push(options.name); return options } },
  })

  assert.deepEqual(calls, REPORT_TOOL_NAMES)
  assert.deepEqual(state.registered.map(tool => tool.name), REPORT_TOOL_NAMES)
  assert.equal(state.registered[0].parameters.text.required, true)
  assert.deepEqual(state.registered[0].output.render(null, 'x'), [{ type: 'text', text: 'x' }])
  assert.equal(typeof state.registered[0].execute, 'function')

  assert.equal(typeof dispose, 'function')
  assert.equal(state.disposed, 0)
  dispose()
  assert.equal(state.disposed, 4)
  dispose()
  assert.equal(state.disposed, 4)
})

test('registerWorkerTools does nothing when the agent scope has no tools.register', async (t) => {
  const stateDir = await dir(t)
  const logs = []
  let defineToolCalls = 0
  const dispose = await registerWorkerTools(agentCtxOf({ guard: () => {} }), {
    reportFile: join(stateDir, 'report.jsonl'),
    log: line => logs.push(line),
    deps: { defineTool: options => { defineToolCalls += 1; return options } },
  })
  assert.equal(defineToolCalls, 0)
  assert.deepEqual(logs, [])
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('registerWorkerTools does nothing without a reportFile', async (t) => {
  const stateDir = await dir(t)
  const { state, tools } = fakeTools()
  const logs = []
  let defineToolCalls = 0
  await registerWorkerTools(agentCtxOf(tools), {
    reportFile: undefined,
    log: line => logs.push(line),
    deps: { defineTool: options => { defineToolCalls += 1; return options } },
  })
  assert.equal(defineToolCalls, 0)
  assert.equal(state.registered.length, 0)
  assert.match(logs[0], /reportFile is missing/)
  assert.deepEqual(await readdir(stateDir), [])
})

test('one failing definition does not prevent the other report tools from registering', async (t) => {
  const stateDir = await dir(t)
  const { state, tools } = fakeTools()
  const logs = []
  const dispose = await registerWorkerTools(agentCtxOf(tools), {
    reportFile: join(stateDir, 'report.jsonl'),
    log: line => logs.push(line),
    deps: {
      defineTool: options => {
        if (options.name === REPORT_TOOL_NAMES[1]) throw new Error('boom')
        return options
      },
    },
  })
  assert.deepEqual(state.registered.map(tool => tool.name), [REPORT_TOOL_NAMES[0], REPORT_TOOL_NAMES[2], REPORT_TOOL_NAMES[3]])
  assert.ok(logs.some(line => /registering a report tool failed: boom/.test(line)))
  dispose()
  assert.equal(state.disposed, 3)
})

test('a throwing tools.register is logged per tool and never escapes', async (t) => {
  const stateDir = await dir(t)
  const { tools } = fakeTools({ registerThrows: true })
  const logs = []
  const dispose = await registerWorkerTools(agentCtxOf(tools), {
    reportFile: join(stateDir, 'report.jsonl'),
    log: line => logs.push(line),
    deps: { defineTool: fakeDefineTool },
  })
  assert.equal(logs.filter(line => /registering a report tool failed/.test(line)).length, 4)
  assert.doesNotThrow(() => dispose())
})

test('a failed dynamic import of the tools package is only logged', async (t) => {
  const stateDir = await dir(t)
  const { state, tools } = fakeTools()
  const logs = []
  const dispose = await registerWorkerTools(agentCtxOf(tools), {
    reportFile: join(stateDir, 'report.jsonl'),
    log: line => logs.push(line),
    deps: { toolModule: '@deepseek-ai/dsh-tools-does-not-exist-in-this-repo' },
  })
  assert.equal(state.registered.length, 0)
  assert.match(logs[0], /is unavailable, worker report tools are not registered/)
  assert.equal(typeof dispose, 'function')
  dispose()
})

test('registered tools append report lines and reject empty arguments without writing', async (t) => {
  const stateDir = await dir(t)
  const reportFile = join(stateDir, 'runs', 'run_2.report.jsonl')
  const { state, tools } = fakeTools()
  await registerWorkerTools(agentCtxOf(tools), { reportFile, deps: { defineTool: fakeDefineTool } })
  const [progress, artifact, verify, ask] = state.registered
  const readLines = async () => (await readFile(reportFile, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length

  assert.match(await progress.execute({ text: ' worker started ' }), /Recorded progress: worker started/)
  assert.match(await artifact.execute({ path: 'src/a.js', note: 'fix' }), /Recorded artifact: src\/a\.js/)
  assert.match(await verify.execute({ name: 'backend', command: 'pnpm test', expectedOutput: 'ok' }), /Recorded verification: backend/)
  assert.match(await ask.execute({ question: 'pick one', options: ['A'] }), /pause for an operator answer/)
  assert.equal(await readLines(), 4)

  assert.match(await progress.execute({ text: '   ' }), /Rejected: progress text/)
  assert.match(await artifact.execute({}), /Rejected: artifact path/)
  assert.match(await verify.execute({ name: '' }), /Rejected: verify name/)
  assert.match(await ask.execute({ question: undefined }), /Rejected: question/)
  assert.equal(await readLines(), 4)

  const report = readWorkerReport(reportFile)
  assert.deepEqual(report.progress.map(item => item.text), ['worker started'])
  assert.equal(report.artifacts[0].note, 'fix')
  assert.equal(report.verify[0].command, 'pnpm test')
  assert.deepEqual(report.question.options, ['A'])
})
