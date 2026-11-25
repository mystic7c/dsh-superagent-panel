/**
 * Chat with a Claude Code conversation: one message in, one non-interactive CLI turn out (`claude -p --resume`), the
 * same stream the worker parses, rendered as a conversation instead of a terminal screen.
 *
 * Why not the TUI in a PTY: the panel wants a conversation (bubbles, markdown, tool steps), and scraping xterm for it
 * is guesswork. The CLI's stream-json *is* the conversation — it already carries the assistant text and every tool call
 * — so the panel renders that and the person keeps a normal chat box. The terminal stays available as an escape hatch.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runCliWorker } from './worker-cli.js'

/** One chat turn may edit files and read a repo; ten minutes is long enough for that and short enough to fail visibly. */
export const CHAT_TIMEOUT_MS = 600_000
/** A person typing a message, not a fuzzer: keep the prompt bounded so one request cannot grow the argv without limit. */
export const CHAT_MESSAGE_MAX = 20_000

const CLAUDE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A refusal the panel can explain; the host maps `httpStatus` onto the response. */
function refusal(status, message) {
  const error = /** @type {Error & { httpStatus?: number }} */ (new Error(message))
  error.httpStatus = status
  return error
}

/** How much of an existing conversation the page loads: enough to recognise it, not a paging product. */
export const TRANSCRIPT_LIMIT = 40

/**
 * The JSONL Claude Code keeps for one session, or '' when this machine has no such session yet. The id is unique, so
 * the project directory (a slug derived from the cwd) does not have to be re-derived here — asking for the id alone is
 * enough and cannot pick up the wrong conversation.
 */
export function transcriptFile(sessionId, home = homedir()) {
  if (!CLAUDE_SESSION_ID.test(sessionId)) return ''
  const root = join(home, '.claude', 'projects')
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return ''
  }
  for (const name of names) {
    const file = join(root, name, `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return ''
}

const textOf = content => typeof content === 'string'
  ? content
  : (Array.isArray(content) ? content.filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text).join('\n\n') : '')

/**
 * The conversation so far, oldest first: what a person would see if the page had been open the whole time. Only the
 * turns a person reads are kept — the thinking blocks, attachments, sidechains and tool results stay in the file.
 *
 * @returns {{ messages: Array<{ role: string, text: string, toolCalls: number, at: string }>, total: number,
 *   file: string }}
 */
export function readTranscript({ sessionId, limit = TRANSCRIPT_LIMIT, home = homedir() } = /** @type {any} */ ({})) {
  // A read never refuses: an id this machine does not know simply has no history to show.
  const file = transcriptFile(typeof sessionId === 'string' ? sessionId.trim() : '', home)
  const messages = []
  if (file) {
    // A tool call and its result are two file lines; the reply the person remembers is the text after them, so the
    // tool uses are counted until that text arrives and then reported with it.
    let pendingSteps = 0
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      let entry
      try {
        entry = JSON.parse(line)
      } catch {
        continue
      }
      if (entry?.isMeta === true || entry?.isSidechain === true) continue
      const content = entry?.message?.content
      if (entry?.type === 'user') {
        const text = textOf(content)
        if (text.trim()) messages.push({ role: 'user', text: text.trim(), toolCalls: 0,
          at: typeof entry.timestamp === 'string' ? entry.timestamp : '' })
        continue
      }
      if (entry?.type !== 'assistant') continue
      if (Array.isArray(content)) pendingSteps += content.filter(block => block?.type === 'tool_use').length
      const text = textOf(content).trim()
      if (!text) continue
      messages.push({ role: 'assistant', text, toolCalls: pendingSteps,
        at: typeof entry.timestamp === 'string' ? entry.timestamp : '' })
      pendingSteps = 0
    }
  }
  const total = messages.length
  return { messages: messages.slice(-Math.max(1, limit)), total, file }
}

/** The conversation's working directory: a real directory, never a crafted path with something appended to it. */
export function chatDirectory(cwd) {
  if (typeof cwd !== 'string' || !cwd.trim()) throw refusal(400, '缺少工作区路径：这条会话要在它的工作区里继续')
  const path = cwd.trim()
  try {
    if (!statSync(path).isDirectory()) throw new Error('not a directory')
  } catch {
    throw refusal(400, `工作区不存在：${path}`)
  }
  return path
}

/** The session to continue: a Claude Code UUID, or empty for a brand-new conversation. Anything else is refused —
    `claude --resume <value>` treats an unknown value as a session *title* and could open someone else's history. */
export function chatSession(sessionId) {
  const value = typeof sessionId === 'string' ? sessionId.trim() : ''
  if (!value) return ''
  if (!CLAUDE_SESSION_ID.test(value)) throw refusal(400, '会话标识格式不正确')
  return value
}

/** The message the person typed, bounded and non-empty. */
export function chatMessage(message) {
  const value = typeof message === 'string' ? message.trim() : ''
  if (!value) throw refusal(400, '消息不能为空')
  if (value.length > CHAT_MESSAGE_MAX) throw refusal(400, `消息太长（上限 ${CHAT_MESSAGE_MAX} 字）`)
  return value
}

/**
 * @param {{ body?: any, signal?: AbortSignal, log?: (line: string) => void,
 *   run?: typeof runCliWorker }} options
 * @returns {Promise<{ sessionId: string, text: string, toolCalls: number, events: any[], error?: string,
 *   timedOut: boolean, backend: string, exitCode: number | null }>}
 */
export async function chatWithClaude({ body, signal, log = () => {}, run = runCliWorker }) {
  const cwd = chatDirectory(body?.cwd)
  const resume = chatSession(body?.sessionId)
  const message = chatMessage(body?.message)
  const model = typeof body?.model === 'string' && body.model.trim() ? body.model.trim() : undefined
  // A chat turn is the same agent the worker is: it may read, edit and run. It is not a review turn (no schema) and
  // not a plan turn (no read-only tool set) — the person asked for work, not for a verdict.
  const result = await run({
    backend: 'claude',
    cwd,
    systemPrompt: '你是这个仓库里的编码助手。回答用中文，直接、简洁；需要改代码就改，改完说明改了什么。',
    task: message,
    model,
    reasoningEffort: undefined,
    sessionId: undefined,
    bot: 'write',
    resume: resume || undefined,
    outputSchema: undefined,
    timeoutMs: CHAT_TIMEOUT_MS,
    command: typeof body?.command === 'string' && body.command.trim() ? body.command.trim() : undefined,
    log,
    signal,
    onTrace: undefined,
  })
  // `toolCalls` from the worker is the set of tool *names* it used; a chat reply wants the number of steps it took.
  const steps = Array.isArray(result.events)
    ? result.events.filter(entry => entry?.type === 'tool_call').length
    : 0
  return {
    sessionId: result.sessionId,
    text: result.text,
    toolCalls: steps,
    events: result.events,
    error: result.error,
    timedOut: result.timedOut === true,
    backend: 'claude',
    exitCode: result.exitCode ?? null,
  }
}
