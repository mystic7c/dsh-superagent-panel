/**
 * One DSH worker agent per ticket. The worker is a normal live Agent created through the host `agents` service with the
 * ticket's worktree as its cwd: setup mounts the default agent preset, injects the ticket brief, and denies tools whose
 * answer cannot reach this process. The executor waits for the session's `turn/end` event (bounded by a timeout), then
 * reads the final assistant text and the tools used.
 *
 * This module never pushes, merges or touches the remote; the executor does that after verifying the worktree.
 */
import { randomUUID } from 'node:crypto'

/** Tools whose answers would be lost in this headless worker. */
const DENY_TOOLS = ['ask_user_question', 'exit_plan_mode', 'present', 'workflow', 'spawn_teammate',
  'team_task_create', 'team_task_update', 'wait_agent', 'create_goal', 'update_goal', 'schedule_create', 'schedule_update']

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
 * @param {(line:string)=>void} [options.log]
 * @returns {Promise<{sessionId:string, text:string, toolCalls:string[], reason:object|undefined, timedOut:boolean, error?:string}>}
 */
export async function runWorker({ ctx, cwd, systemPrompt, task, model, timeoutMs = 1_500_000, sessionId = `worker-${randomUUID().slice(0, 8)}`, log = () => {} }) {
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
          : undefined)
      } catch (error) { log(`worker: tool guard failed: ${error instanceof Error ? error.message : String(error)}`) }
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
    if (typeof ctx.on === 'function') {
      off = ctx.on('session/event', (session, event) => {
        if (!session || (session.id !== liveSessionId && session.id !== handle.agent.id)) return
        if (!event || typeof event.type !== 'string') return
        if (event.type === 'assistant/message') {
          const value = textOfMessage(event.data?.message?.content)
          if (value) text = value
        } else if (event.type === 'tool/call') {
          if (event.data?.name && !toolCalls.includes(event.data.name)) toolCalls.push(event.data.name)
        } else if (event.type === 'turn/end') {
          settle({ reason: event.data?.reason })
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
      return { sessionId: liveSessionId, text, toolCalls, reason: undefined, timedOut: true }
    }
    const result = await done
    if (result?.error) return { sessionId: liveSessionId, text, toolCalls, reason: undefined, timedOut: false, error: result.error }
    return { sessionId: liveSessionId, text, toolCalls, reason: result?.reason, timedOut: false }
  } finally {
    clearTimeout(timer)
    if (typeof off === 'function') { try { off() } catch { /* ignore */ } }
    try { await handle.dispose?.() } catch { /* ignore */ }
  }
}
