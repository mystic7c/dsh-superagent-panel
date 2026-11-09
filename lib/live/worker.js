/**
 * One DSH worker agent per ticket. The worker is a normal live Agent created through the host `agents` service with the
 * ticket's worktree as its cwd: setup mounts the default agent preset, injects the ticket brief, and denies tools whose
 * answer cannot reach this process. The executor waits for the session's `turn/end` event (bounded by a timeout), then
 * reads the final assistant text and the tools used.
 *
 * This module never pushes, merges or touches the remote; the executor does that after verifying the worktree.
 */
import { randomUUID } from 'node:crypto'
import { readWorkerReport, registerWorkerTools } from './worker-tools.js'

/** Tools whose answers would be lost in this headless worker. */
const DENY_TOOLS = ['ask_user_question', 'exit_plan_mode', 'present', 'workflow', 'spawn_teammate',
  'team_task_create', 'team_task_update', 'wait_agent', 'create_goal', 'update_goal', 'schedule_create', 'schedule_update']

/** File-mutating tools denied in a read-only run (analysis/review/research). Bash stays usable for read-only commands. */
const READ_ONLY_TOOLS = ['write', 'edit', 'multi_edit', 'multiedit', 'apply_patch', 'notebook_edit']

/** Provider/model override, when configured. */
function agentOptions(model) {
  if (!model || typeof model.provider !== 'string' || typeof model.model !== 'string') return undefined
  return { provider: model.provider, model: model.model }
}

/** Extract text from one assistant message content array. */
function textOfMessage(content) {
  if (!Array.isArray(content)) return ''
  return content.filter(block => block && block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n').trim()
}

// ---------------------------------------------------------------------------
// Normalised worker events (P0 contract §1.1/§3.5): the executor copies them into run.trace. Bounded at 80 entries,
// every summary clipped to 300 characters, so a long session cannot grow the run record without limit.
// ---------------------------------------------------------------------------

const TRACE_LIMIT = 80
const SUMMARY_LIMIT = 300

const jsonOf = (value) => { try { return JSON.stringify(value) ?? '' } catch { return String(value) } }

/** Clip one event summary to the contract limit (≤300 characters). */
function clipSummary(value) {
  const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : jsonOf(value)
  return text.length > SUMMARY_LIMIT ? `${text.slice(0, SUMMARY_LIMIT - 1)}…` : text
}

/** One-line summary of a tool call's arguments. */
function argumentsSummary(data) {
  const raw = data?.arguments ?? data?.input ?? data?.args
  if (raw === undefined || raw === null) return ''
  return typeof raw === 'string' ? raw : jsonOf(raw)
}

/** One-line summary of a tool result/output. */
function resultSummary(data) {
  const raw = data?.output ?? data?.result ?? data?.content ?? data?.message
  if (raw === undefined || raw === null) return ''
  return typeof raw === 'string' ? raw : jsonOf(raw)
}

/** Summary/state derived from one turn/end `reason`. */
function reasonSummary(data) {
  const reason = data?.reason
  if (reason === undefined || reason === null) return {}
  if (typeof reason === 'string') return { summary: reason }
  return { summary: reason.kind ?? jsonOf(reason), ...reason.kind ? { state: reason.kind } : {} }
}

/**
 * Create and run one worker turn.
 * @param {object} options
 * @param {import('@deepseek-ai/cordis').Context} options.ctx host plugin context
 * @param {string} options.cwd ticket worktree (the worker's working directory)
 * @param {string} options.systemPrompt brief appended to the worker's system prompt
 * @param {string} options.task the user message that states the concrete task
 * @param {object} [options.model] {provider, model}
 * @param {number} [options.timeoutMs]
 * @param {string} [options.sessionId]
 * @param {string} [options.reportFile] absolute JSONL report path; when set the worker registers the report tools
 *   (contract §6) and the result carries `report`
 * @param {(line:string)=>void} [options.log]
 * @returns {Promise<{sessionId:string, text:string, toolCalls:string[], reason:object|undefined, timedOut:boolean,
 *   error?:string, events:Array<{type:string, at:string, name?:string, summary?:string, state?:string}>,
 *   report?:{progress:Array<object>, artifacts:Array<object>, verify:Array<object>, question?:object}}>}
 */
export async function runWorker({ ctx, cwd, systemPrompt, task, model, timeoutMs = 1_500_000, sessionId = `worker-${randomUUID().slice(0, 8)}`, reportFile, readOnly = false, log = () => {} }) {
  const agents = ctx.get?.('agents') ?? ctx.agents
  if (!agents) throw new Error('worker: the host agents service is not available')
  const presets = ctx.get?.('agentPresets')
  const preset = presets ? await presets.resolve().catch(() => undefined) : undefined
  const presetId = preset?.id
  // A model must be selected for prompt assembly (persona prefixes interpolate {{model}}), so fall back to the host default.
  const defaults = ctx.get?.('agentDefaultModel')
  const selected = agentOptions(model) ?? defaults?.currentSelection?.() ?? undefined

  const setup = async (agentCtx) => {
    if (presets && presetId) {
      await presets.mount(agentCtx, presetId).catch(error =>
        log(`worker: preset mount failed: ${error instanceof Error ? error.message : String(error)}`))
    }
    const prompt = agentCtx.get?.('systemPrompt')
    if (prompt && systemPrompt) {
      try { prompt.section({ name: 'superagent:worker', order: 160, text: systemPrompt }) }
      catch (error) { log(`worker: system prompt failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    const tools = agentCtx.get?.('tools')
    if (tools) {
      try {
        tools.guard(({ name }) => DENY_TOOLS.includes(name)
          ? `${name} is unavailable in this worker: its response belongs to another interface. Report the question in your final message instead.`
          : readOnly && READ_ONLY_TOOLS.includes(name)
            ? `${name} is unavailable in this read-only run: report the finding in your final message instead of changing files.`
            : undefined)
      } catch (error) { log(`worker: tool guard failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    // Report tools are optional on purpose (P1 contract §6): a host without @deepseek-ai/dsh-tools still runs the
    // worker, it just cannot publish a report or ask a question. Registration is scoped to this agent and disposed
    // with it, so nothing leaks into another ticket's session.
    if (reportFile) {
      try { await registerWorkerTools(agentCtx, { reportFile, log }) }
      catch (error) { log(`worker: report tools are unavailable: ${error instanceof Error ? error.message : String(error)}`) }
    }
  }

  const handle = await agents.create({ sessionId,
    meta: { cwd, ...(presetId ? { agentPreset: presetId } : {}) },
    ...(selected ? { agentOptions: selected } : {}), setup })
  const liveSessionId = handle.agent.session?.id ?? handle.agent.id ?? sessionId
  let off
  let timer
  try {
    try { ctx.get?.('approval')?.setPolicy(handle.agent, 'never') }
    catch (error) { log(`worker: approval policy failed: ${error instanceof Error ? error.message : String(error)}`) }

    let settle
    const done = new Promise((resolve) => { settle = resolve })
    let text = ''
    const toolCalls = []
    const events = []
    const record = (type, name, summary, state) => {
      const entry = { type, at: new Date().toISOString() }
      if (name !== undefined && name !== null && name !== '') entry.name = String(name)
      if (summary !== undefined && summary !== null && summary !== '') entry.summary = clipSummary(summary)
      if (state !== undefined && state !== null && state !== '') entry.state = String(state)
      events.push(entry)
      if (events.length > TRACE_LIMIT) events.splice(0, events.length - TRACE_LIMIT)
    }
    // Read the report once per exit path; without a reportFile the field stays absent so old consumers are unchanged.
    const withReport = (value) => reportFile
      ? { ...value, report: readWorkerReport(reportFile) }
      : value
    if (typeof ctx.on === 'function') {
      off = ctx.on('session/event', (session, event) => {
        if (!session || (session.id !== liveSessionId && session.id !== handle.agent.id)) return
        if (!event || typeof event.type !== 'string') return
        if (event.type === 'assistant/message') {
          const value = textOfMessage(event.data?.message?.content)
          if (value && value !== text) {
            text = value
            record('assistant', undefined, value)
          }
        } else if (event.type === 'tool/call') {
          if (event.data?.name && !toolCalls.includes(event.data.name)) toolCalls.push(event.data.name)
          record('tool_call', event.data?.name, argumentsSummary(event.data))
        } else if (event.type === 'tool/result' || event.type === 'tool/end') {
          record('tool_result', event.data?.name ?? event.data?.tool, resultSummary(event.data), event.data?.state)
        } else if (event.type === 'turn/end') {
          const reason = reasonSummary(event.data)
          record('turn_end', undefined, reason.summary ?? 'turn ended', reason.state)
          settle({ reason: event.data?.reason })
        } else if (event.type === 'error') {
          record('error', undefined, event.data?.message ?? event.message ?? 'worker error', 'failed')
        }
      })
    }

    const timedOut = await new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(1, timeoutMs))
      timer.unref?.()
      done.then(() => resolve(false), () => resolve(false))
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: task }], source: { kind: 'user' } }
      try { handle.agent.followup(message) }
      catch (error) { settle({ error: error instanceof Error ? error.message : String(error) }) }
    })
    clearTimeout(timer)
    if (timedOut) {
      try { handle.agent.cancel?.('worker timed out') } catch { /* best effort */ }
      record('error', undefined, 'worker timed out', 'timeout')
      return withReport({ sessionId: liveSessionId, text, toolCalls, reason: undefined, timedOut: true, events })
    }
    const result = await done
    if (result?.error) {
      record('error', undefined, result.error, 'failed')
      return withReport({ sessionId: liveSessionId, text, toolCalls, reason: undefined, timedOut: false, error: result.error, events })
    }
    return withReport({ sessionId: liveSessionId, text, toolCalls, reason: result?.reason, timedOut: false, events })
  } finally {
    clearTimeout(timer)
    if (typeof off === 'function') { try { off() } catch { /* ignore */ } }
    try { await handle.dispose?.() } catch { /* ignore */ }
  }
}
