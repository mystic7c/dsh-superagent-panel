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
 * The call id shared by a `tool/call` and its `tool/result`. DSH puts it at the top level of a call and inside the
 * result message (`message.toolCallId`); older/other emitters may use `toolCallId` or `callId` directly.
 */
function toolCallIdOf(data) {
  const value = data?.callId ?? data?.toolCallId ?? data?.message?.toolCallId
  return typeof value === 'string' && value ? value : undefined
}

/** A tool call's own `timeoutMs` (the bash tool's execution bound), when it declared one. */
function declaredToolTimeoutMs(data) {
  const raw = data?.arguments
  if (raw === undefined || raw === null) return undefined
  let args = raw
  if (typeof raw === 'string') {
    try { args = JSON.parse(raw) } catch { return undefined }
  }
  const value = args?.timeoutMs
  return Number.isFinite(value) && value > 0 ? value : undefined
}

/** Extra time allowed past a declared tool timeout before an unanswered call is treated as a hung worker. */
const TOOL_RESULT_GRACE_MS = 15_000

/**
 * The worker must own every run it starts: a turn cannot close while a subagent it spawned is still running.
 *
 * `agent/turn-stopping` is the harness's own boundary hook — it is awaited before `turn/end` commits, and fresh
 * steering (such as a child result landing in the parent inbox) makes the loop run another step instead of closing.
 * Here we join live descendants first, so the "waiting for independent review" final message can never close a run
 * while the review is still in flight (tkt_969114d7aca74a45, 2026-11-09).
 *
 * `waitForChildren` joins progressing descendants without cancelling them; idle residents that need a later wake are
 * allowed through, otherwise a settled one-shot child would block completion forever.
 */
export async function joinChildrenBeforeTurnEnd({ subagents, payload, log = () => {} } = {}) {
  const agent = payload?.agent
  const signal = payload?.signal
  if (!agent || !subagents || typeof subagents.waitForChildren !== 'function') return { waited: false, joined: 0 }
  let waited = false
  let joined = 0
  for (let round = 0; round < 20; round += 1) {
    if (signal?.aborted) return { waited, joined, aborted: true }
    let running = false
    if (typeof subagents.listDescendants === 'function') {
      try {
        const rows = await subagents.listDescendants(agent.id, signal)
        running = rows.some(row => row?.kind === 'child' && row?.activity === 'running')
      } catch { running = true }
    } else {
      running = round === 0
    }
    if (!running) return { waited, joined }
    if (!waited) { waited = true; log('worker: turn is stopping with live subagents — joining them before closing') }
    try {
      const didJoin = await subagents.waitForChildren(agent)
      joined += 1
      if (didJoin === false) return { waited, joined }
    } catch (error) {
      log(`worker: joining subagents failed: ${error instanceof Error ? error.message : String(error)}`)
      return { waited, joined, error: true }
    }
  }
  log('worker: subagents are still running after the join limit; closing the turn anyway')
  return { waited, joined, exhausted: true }
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
 * @param {number} [options.idleTimeoutMs] settle as `worker_lost` when no event arrives for this long (an in-flight
 *   tool call keeps the window open until its own declared timeout)
 * @param {string} [options.sessionId]
 * @param {string} [options.reportFile] absolute JSONL report path; when set the worker registers the report tools
 *   (contract §6) and the result carries `report`
 * @param {(line:string)=>void} [options.log]
 * @returns {Promise<{sessionId:string, text:string, toolCalls:string[], reason:object|undefined, timedOut:boolean,
 *   error?:string, events:Array<{type:string, at:string, name?:string, summary?:string, state?:string}>,
 *   report?:{progress:Array<object>, artifacts:Array<object>, verify:Array<object>, question?:object}}>}
 */
export async function runWorker({ ctx, cwd, systemPrompt, task, model, timeoutMs = 1_500_000, idleTimeoutMs = 300_000,
  sessionId = `worker-${randomUUID().slice(0, 8)}`, reportFile, readOnly = false, log = () => {}, signal }) {
  const agents = ctx.get?.('agents') ?? ctx.agents
  if (!agents) throw new Error('worker: the host agents service is not available')
  const presets = ctx.get?.('agentPresets')
  const preset = presets ? await presets.resolve().catch(() => undefined) : undefined
  const presetId = preset?.id
  let stopChildren
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
    // The agent owns the runs it starts: wait for live subagents at the turn boundary instead of ending the turn
    // while they are still working (the harness re-reads its inbox after a joined child delivers its result).
    const subagents = agentCtx.get?.('subagents') ?? ctx.get?.('subagents')
    if (subagents && typeof agentCtx.on === 'function') {
      try {
        stopChildren = agentCtx.on('agent/turn-stopping', payload =>
          joinChildrenBeforeTurnEnd({ subagents, payload, log }).catch(error =>
            log(`worker: turn-stopping join failed: ${error instanceof Error ? error.message : String(error)}`)))
      } catch (error) { log(`worker: turn-stopping guard failed: ${error instanceof Error ? error.message : String(error)}`) }
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
  const offs = []
  let timer
  let idleTimer
  let offStop = () => {}
  try {
    try { ctx.get?.('approval')?.setPolicy(handle.agent, 'never') }
    catch (error) { log(`worker: approval policy failed: ${error instanceof Error ? error.message : String(error)}`) }

    let settle
    const done = new Promise((resolve) => { settle = resolve })
    let settled = false
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
    let lastEventAt = Date.now()
    // `tool/call` and its `tool/result` are the only events a long-running command produces; between them the session
    // is silent by design, so an in-flight call must suspend the idle deadline (tkt_2e6bcf59916d40df, 2026-11-12).
    const pendingTools = new Map()
    const workerIdOf = (value) => typeof value === 'string' ? value : value?.session?.id ?? value?.id
    const isWorkerScope = (value) => {
      const id = workerIdOf(value)
      return Boolean(id) && (id === liveSessionId || id === handle.agent.id)
    }
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(idleTimer)
      settle(value)
    }
    // Cooperative stop: the ticket's durable flag is polled by the executor, which aborts this signal. Cancelling the
    // host agent is the only way to stop a turn that is already running; the run keeps its worktree and steps.
    const stopNow = () => {
      if (settled) return
      record('error', undefined, 'stop requested', 'stopped')
      try { handle.agent.cancel?.('stop requested') } catch { /* best effort */ }
      finish({ error: 'stopped', stopped: true })
    }
    if (signal?.aborted) stopNow()
    else if (typeof signal?.addEventListener === 'function') {
      signal.addEventListener('abort', stopNow, { once: true })
      offStop = () => signal.removeEventListener('abort', stopNow)
    }
    const watch = (type, handler) => {
      if (typeof ctx.on !== 'function') return
      try { offs.push(ctx.on(type, handler)) }
      catch (error) { log(`worker: ${type} listener failed: ${error instanceof Error ? error.message : String(error)}`) }
    }
    // The idle watchdog is the last-resort signal: a host can end a worker without emitting `turn/end`, and without it
    // the `done` promise below only settles at the overall (25 minute) timeout while the run stays `working`.
    const lost = (summary) => {
      if (settled) return
      record('error', undefined, summary, 'worker_lost')
      finish({ error: 'worker_lost' })
    }
    const idleStepMs = Math.max(10, Math.min(30_000, Math.floor(idleTimeoutMs / 4) || 250))
    const armIdle = () => {
      clearTimeout(idleTimer)
      if (!(Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0)) return
      idleTimer = setTimeout(() => {
        if (settled) return
        const now = Date.now()
        if (pendingTools.size > 0) {
          // A tool whose `tool/call` arrived and whose `tool/result` has not is still working, not lost. Only once
          // every pending call has outlived its own declared timeout (plus a delivery grace) is the worker hung;
          // calls without a declared bound rely on the overall worker timeout.
          const pending = [...pendingTools.values()]
          const expired = pending.filter(call => call.deadline !== undefined && now >= call.deadline)
          if (expired.length < pending.length) { armIdle(); return }
          const names = [...new Set(pending.map(call => call.name).filter(Boolean))].join(', ') || 'unknown'
          try { handle.agent.cancel?.('worker tool timeout') } catch { /* best effort */ }
          lost(`worker lost: in-flight tool ${names} did not return within its timeout`)
          return
        }
        // Activity between two checks re-arms the same window instead of killing a worker that is still progressing.
        if (now - lastEventAt < idleTimeoutMs) { armIdle(); return }
        try { handle.agent.cancel?.('worker idle timeout') } catch { /* best effort */ }
        lost(`worker lost: no activity for ${Math.floor(idleTimeoutMs)}ms`)
      }, idleStepMs)
      idleTimer.unref?.()
    }
    // Host lifecycle signals settle immediately instead of waiting for the idle window: a disposed session/agent will
    // never deliver the missing `turn/end`.
    watch('session/disposed', (session) => {
      if (isWorkerScope(session)) lost('worker session ended before the turn reported turn/end')
    })
    watch('agent/disposed', (payload) => {
      const agent = payload?.agent ?? payload
      if (isWorkerScope(agent)) lost('worker agent was disposed before the turn reported turn/end')
    })
    watch('session/event', (session, event) => {
      if (!isWorkerScope(session)) return
      if (!event || typeof event.type !== 'string') return
      lastEventAt = Date.now()
      if (event.type === 'assistant/message') {
        const value = textOfMessage(event.data?.message?.content)
        if (value && value !== text) {
          text = value
          record('assistant', undefined, value)
        }
      } else if (event.type === 'tool/call') {
        if (event.data?.name && !toolCalls.includes(event.data.name)) toolCalls.push(event.data.name)
        const callId = toolCallIdOf(event.data)
        if (callId) {
          const timeoutMs = declaredToolTimeoutMs(event.data)
          pendingTools.set(callId, { name: event.data?.name,
            deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs + TOOL_RESULT_GRACE_MS })
        }
        record('tool_call', event.data?.name, argumentsSummary(event.data))
      } else if (event.type === 'tool/result' || event.type === 'tool/end') {
        const callId = toolCallIdOf(event.data)
        if (callId) pendingTools.delete(callId)
        record('tool_result', event.data?.name ?? event.data?.tool, resultSummary(event.data), event.data?.state)
      } else if (event.type === 'turn/end') {
        const reason = reasonSummary(event.data)
        record('turn_end', undefined, reason.summary ?? 'turn ended', reason.state)
        finish({ reason: event.data?.reason })
      } else if (event.type === 'error') {
        record('error', undefined, event.data?.message ?? event.message ?? 'worker error', 'failed')
      }
    })

    const timedOut = await new Promise((resolve) => {
      timer = setTimeout(() => resolve(true), Math.max(1, timeoutMs))
      timer.unref?.()
      done.then(() => resolve(false), () => resolve(false))
      const message = { id: randomUUID(), role: 'user', content: [{ type: 'text', text: task }], source: { kind: 'user' } }
      lastEventAt = Date.now()
      if (!settled) {
        try { handle.agent.followup(message) }
        catch (error) { finish({ error: error instanceof Error ? error.message : String(error) }) }
        if (!settled) armIdle()
      }
    })
    clearTimeout(timer)
    if (timedOut) {
      try { handle.agent.cancel?.('worker timed out') } catch { /* best effort */ }
      record('error', undefined, 'worker timed out', 'timeout')
      return withReport({ sessionId: liveSessionId, text, toolCalls, reason: undefined, timedOut: true, events })
    }
    const result = await done
    if (result?.error) {
      // The idle/lifecycle paths already recorded the `worker_lost` event; a plain error still gets its terminal row.
      if (result.error !== 'worker_lost' && result.error !== 'stopped') record('error', undefined, result.error, 'failed')
      return withReport({ sessionId: liveSessionId, text, toolCalls, reason: undefined, timedOut: false, error: result.error,
        ...(result.stopped ? { stopped: true } : {}), events })
    }
    return withReport({ sessionId: liveSessionId, text, toolCalls, reason: result?.reason, timedOut: false, events })
  } finally {
    clearTimeout(timer)
    clearTimeout(idleTimer)
    try { offStop() } catch { /* ignore */ }
    for (const release of offs) { try { release?.() } catch { /* ignore */ } }
    offs.length = 0
    if (typeof stopChildren === 'function') { try { stopChildren() } catch { /* ignore */ } }
    try { await handle.dispose?.() } catch { /* ignore */ }
  }
}
