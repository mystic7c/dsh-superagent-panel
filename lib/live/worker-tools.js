/**
 * Worker report tools (P1 contract §6): the four tools a Superagent worker may call to publish progress, artifacts,
 * verification hints and questions. Each call appends one JSON line to the run's report file
 * (`<stateDir>/runs/<runId>.report.jsonl`); the executor reads the file back into `run.report` and turns a question
 * into a parked run. The tools never touch the repository, the network or the engine state — writing the file is the
 * whole behaviour, so a worker keeps working even when the host cannot answer.
 *
 * Registration is best-effort: `@deepseek-ai/dsh-tools` is a peer dependency of the host, never a hard dependency of
 * this plugin. A missing module (node tests, a host without the tools package) is logged and skipped, and a failed
 * registration of one tool never prevents the other three.
 */
import { appendFile, mkdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Model-facing names of the report tools, in registration order. */
export const REPORT_TOOL_NAMES = [
  'superagent_report_progress',
  'superagent_report_artifact',
  'superagent_set_verify',
  'superagent_ask_human',
]

/** Package that owns `defineTool`; overridable through `deps.toolModule` for the failure-path test. */
const DEFAULT_TOOL_MODULE = '@deepseek-ai/dsh-tools'

/** Report event types the executor's `run.report` shape understands. */
const REPORT_EVENT_TYPES = ['progress', 'artifact', 'verify', 'question']

const errorMessage = (error) => error instanceof Error ? error.message : String(error)
const nonEmptyString = (value) => typeof value === 'string' && value.trim() !== ''
const clip = (value, max = 300) => {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Canonical tool output: one text block, so the model reads back what was recorded. */
const textContent = (value) => [{ type: 'text', text: String(value) }]

// ---------------------------------------------------------------------------
// Report file (JSON Lines)
// ---------------------------------------------------------------------------

/**
 * Append one report event as a JSON line, creating the parent directory first.
 * Never throws: a report is an observability side channel, so a bad path must not fail the tool call.
 * @param {string} reportFile absolute report path
 * @param {object} event `{type, ...fields}`; an unknown or malformed event is ignored
 * @returns {Promise<boolean>} whether the line was written
 */
export async function appendReportEvent(reportFile, event) {
  if (!nonEmptyString(reportFile) || !event || typeof event !== 'object') return false
  if (typeof event.type !== 'string' || !REPORT_EVENT_TYPES.includes(event.type)) return false
  try {
    await mkdir(dirname(reportFile), { recursive: true })
    await appendFile(reportFile, `${JSON.stringify(event)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** Take `at` from the event when it is a non-empty string, otherwise stamp read time. */
const atOf = (event) => nonEmptyString(event.at) ? event.at : new Date().toISOString()

/** Keep only non-empty string entries of an optional list. */
const stringsOf = (value) => Array.isArray(value)
  ? value.filter(item => nonEmptyString(item)).map(item => item.trim())
  : []

/**
 * Read the report file back into the executor's `run.report` shape.
 * Tolerates a missing file, unreadable file and malformed lines; an unknown event type is skipped.
 * @param {string} reportFile absolute report path
 * @returns {{progress:Array<{text:string,at:string}>, artifacts:Array<{path:string,note?:string,at:string}>,
 *   verify:Array<{name:string,command?:string,expectedOutput?:string,at:string}>,
 *   question?:{question:string,options?:string[],at:string}}}
 */
export function readWorkerReport(reportFile) {
  const report = { progress: [], artifacts: [], verify: [] }
  if (!nonEmptyString(reportFile)) return report
  let raw
  try { raw = readFileSync(reportFile, 'utf8') } catch { return report }
  for (const line of String(raw).split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let event
    try { event = JSON.parse(trimmed) } catch { continue }
    if (!event || typeof event !== 'object' || typeof event.type !== 'string') continue
    if (event.type === 'progress' && nonEmptyString(event.text)) {
      report.progress.push({ text: clip(event.text, 2000), at: atOf(event) })
    } else if (event.type === 'artifact' && nonEmptyString(event.path)) {
      report.artifacts.push({ path: String(event.path).trim(), ...nonEmptyString(event.note) ? { note: clip(event.note) } : {}, at: atOf(event) })
    } else if (event.type === 'verify' && nonEmptyString(event.name)) {
      report.verify.push({
        name: clip(event.name),
        ...nonEmptyString(event.command) ? { command: clip(event.command, 500) } : {},
        ...nonEmptyString(event.expectedOutput) ? { expectedOutput: clip(event.expectedOutput, 500) } : {},
        at: atOf(event),
      })
    } else if (event.type === 'question' && nonEmptyString(event.question)) {
      // Only the last question survives: the executor parks the run on it, and an earlier one was superseded.
      const options = stringsOf(event.options)
      report.question = { question: clip(event.question, 2000), ...options.length ? { options } : {}, at: atOf(event) }
    }
  }
  return report
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

/** `superagent_report_progress`: one short progress line the operator sees while the worker runs. */
const progressTool = (defineTool, reportFile) => defineTool({
  name: REPORT_TOOL_NAMES[0],
  description: 'Record one short progress line for this ticket run. Use it after a meaningful milestone so the '
    + 'operator can follow the work; it never changes the repository.',
  parameters: {
    text: { type: 'string', required: true, description: 'One-line progress update (what changed or what is next).' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
  async execute(args) {
    const text = nonEmptyString(args?.text) ? args.text.trim() : ''
    if (!text) return 'Rejected: progress text must be a non-empty string.'
    return await appendReportEvent(reportFile, { type: 'progress', text, at: new Date().toISOString() })
      ? `Recorded progress: ${clip(text)}`
      : 'Rejected: the run report file could not be written.'
  },
})

/** `superagent_report_artifact`: declare a file the change produced (the operator opens it directly). */
const artifactTool = (defineTool, reportFile) => defineTool({
  name: REPORT_TOOL_NAMES[1],
  description: 'Declare an artifact this change produced — the file an operator should open first (usually the '
    + 'changed source or test file).',
  parameters: {
    path: { type: 'string', required: true, description: 'Repository-relative or absolute file path.' },
    note: { type: 'string', description: 'Optional short note on what the file now contains.' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
  async execute(args) {
    const path = nonEmptyString(args?.path) ? args.path.trim() : ''
    if (!path) return 'Rejected: artifact path must be a non-empty string.'
    const note = nonEmptyString(args?.note) ? clip(args.note) : undefined
    return await appendReportEvent(reportFile, {
      type: 'artifact', path, ...note ? { note } : {}, at: new Date().toISOString(),
    })
      ? `Recorded artifact: ${path}`
      : 'Rejected: the run report file could not be written.'
  },
})

/** `superagent_set_verify`: declare a check the delivery must satisfy (a command and/or required output evidence). */
const verifyTool = (defineTool, reportFile) => defineTool({
  name: REPORT_TOOL_NAMES[2],
  description: 'Declare one verification the delivery should satisfy: a command that must exit 0, and/or a piece of '
    + 'output (`expectedOutput`) the gate output must contain as evidence. The executor runs the gates itself.',
  parameters: {
    name: { type: 'string', required: true, description: 'Short check name, e.g. "backend tests".' },
    command: { type: 'string', description: 'Optional shell command that must pass for this check.' },
    expectedOutput: { type: 'string', description: 'Optional string the command output must contain as proof.' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
  async execute(args) {
    const name = nonEmptyString(args?.name) ? clip(args.name) : ''
    if (!name) return 'Rejected: verify name must be a non-empty string.'
    const command = nonEmptyString(args?.command) ? clip(args.command, 500) : undefined
    const expectedOutput = nonEmptyString(args?.expectedOutput) ? clip(args.expectedOutput, 500) : undefined
    return await appendReportEvent(reportFile, {
      type: 'verify', name, ...command ? { command } : {}, ...expectedOutput ? { expectedOutput } : {}, at: new Date().toISOString(),
    })
      ? `Recorded verification: ${name}`
      : 'Rejected: the run report file could not be written.'
  },
})

/** `superagent_ask_human`: park the run on a question the operator must answer before it continues. */
const askHumanTool = (defineTool, reportFile) => defineTool({
  name: REPORT_TOOL_NAMES[3],
  description: 'Ask the operator a question that blocks delivery. The run parks until a person answers, then a new '
    + 'run resumes with the answer. Use it when the ticket is genuinely ambiguous, not for routine confirmation.',
  parameters: {
    question: { type: 'string', required: true, description: 'The question a person must answer to continue.' },
    options: { type: 'array', items: { type: 'string' }, description: 'Optional suggested answers the operator can pick.' },
  },
  output: { schema: { type: 'string' }, render: (_args, value) => textContent(value) },
  async execute(args) {
    const question = nonEmptyString(args?.question) ? clip(args.question, 2000) : ''
    if (!question) return 'Rejected: question must be a non-empty string.'
    const options = stringsOf(args?.options)
    return await appendReportEvent(reportFile, {
      type: 'question', question, ...options.length ? { options } : {}, at: new Date().toISOString(),
    })
      ? 'Recorded the question; the run will pause for an operator answer after this turn.'
      : 'Rejected: the run report file could not be written.'
  },
})

/** Builders in registry order; one builder failing never prevents the others from registering. */
const TOOL_BUILDERS = [progressTool, artifactTool, verifyTool, askHumanTool]

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Register the four report tools in one agent scope.
 *
 * Only acts when the scoped context exposes `tools.register` (the DSH tools service); `defineTool` comes from the
 * injected `deps.defineTool` (tests) or a dynamic import of the peer package. Every failure is logged, never thrown:
 * a worker without report tools still does the work, it just cannot publish a report or ask a question.
 *
 * @param {object} agentCtx the unpublished Agent scope passed to `agents.create({setup})`
 * @param {object} options `{reportFile, log, deps}`
 * @param {string} [options.reportFile] absolute report path; without it nothing is registered
 * @param {(line:string)=>void} [options.log]
 * @param {{defineTool?:Function, toolModule?:string}} [options.deps]
 * @returns {Promise<() => void>} disposer that unregisters every tool registered by this call
 */
export async function registerWorkerTools(agentCtx, { reportFile, log = () => {}, deps = {} } = {}) {
  const noop = () => {}
  const tools = agentCtx?.get?.('tools') ?? agentCtx?.tools
  if (!tools || typeof tools.register !== 'function') return noop
  if (!nonEmptyString(reportFile)) {
    log('worker: reportFile is missing, worker report tools are not registered')
    return noop
  }

  let defineTool = deps.defineTool
  if (typeof defineTool !== 'function') {
    const moduleName = nonEmptyString(deps.toolModule) ? deps.toolModule : DEFAULT_TOOL_MODULE
    try {
      const loaded = await import(moduleName)
      defineTool = loaded?.defineTool
    } catch (error) {
      log(`worker: ${moduleName} is unavailable, worker report tools are not registered: ${errorMessage(error)}`)
      return noop
    }
  }
  if (typeof defineTool !== 'function') {
    log('worker: defineTool is not exported by the tools package, worker report tools are not registered')
    return noop
  }

  const disposers = []
  for (const build of TOOL_BUILDERS) {
    try {
      const dispose = tools.register(build(defineTool, reportFile))
      if (typeof dispose === 'function') disposers.push(dispose)
    } catch (error) {
      log(`worker: registering a report tool failed: ${errorMessage(error)}`)
    }
  }
  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch { /* the agent scope may already be torn down */ }
    }
  }
}
