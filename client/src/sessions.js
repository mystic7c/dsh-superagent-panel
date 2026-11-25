/* Sessions page: the CLI workers' conversations, left list + right conversation, the same shape the Host's own chat
   gives. A Claude Code run has no DSH Session to open, so this page is where its conversation lives: pick a run's
   session on the left and keep talking to it on the right.

   The right half is a chat, not a terminal: each message is one `claude -p --resume <id>` turn (`POST
   engine/workers/chat`), and the turn's stream — the assistant text plus the tool calls it made — is rendered as a
   reply. The real TUI stays one button away for the cases a chat box cannot express. */

import { shortId } from "./util.js"
import { when } from "./i18n.js"
import { Button } from "./controls.js"
import { useAction, usePanel, usePanelData } from "./api.js"
import { EmptyState, Hint, MarkdownLite, Section } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { RunTerminalPane } from "./terminal.js"
import { React, h, useCallback, useEffect, useRef, useState } from "./react.js"

Object.assign(PAGE_TEXT, {
  'sessions.title': ['会话', 'Sessions'],
  'sessions.hint': ['这里列出 Claude Code CLI worker 跑过的会话。选一条，右边接着聊：会话是真的那条，之前的上下文还在。',
    "Each Claude Code CLI worker run left a session here. Pick one and keep talking on the right: it is the same "
    + 'session, so the earlier context is still there.'],
  'sessions.empty': ['还没有 Claude Code CLI 运行的会话', 'No Claude Code CLI session yet'],
  'sessions.emptyHint': ['把设置里的 worker 后端切到「Claude Code CLI（本机）」，跑一张票，这里就会出现它的会话。',
    'Set the worker backend to Claude Code CLI and run one ticket; its session shows up here.'],
  'sessions.pick': ['从左边选一个会话', 'Pick a session on the left'],
  'sessions.opened': ['终端已就绪', 'Terminal ready'],
  'sessions.needsGui': ['先在这个界面上打开任意一个会话，终端要挂在它下面', 'Open any Session in this interface first: the terminal hangs under it'],
  'sessions.worktree': ['工作区', 'Worktree'],
  'sessions.run': ['运行', 'Run'],
  'sessions.ticket': ['工单', 'Ticket'],
  'sessions.session': ['会话', 'Session'],
  'sessions.unsaved': ['这个会话没有可续接的 id，接管会开一个新的 Claude Code',
    'This session has no resumable id, so takeover starts a fresh Claude Code'],
  'sessions.start': ['这是这条 CLI 会话的续聊。下面的消息会接着它原来的上下文，历史存在本机 Claude Code 里。',
    'This continues the CLI session. Your messages pick up its existing context; the history lives in local Claude Code.'],
  'sessions.placeholder': ['与 Claude 聊天', 'Talk to Claude'],
  'sessions.send': ['发送', 'Send'],
  'sessions.sending': ['正在回复…', 'Replying…'],
  'sessions.steps': ['完成 {count} 步 · {seconds}s', '{count} steps · {seconds}s'],
  'sessions.stepsNone': ['完成 · {seconds}s', 'Done · {seconds}s'],
  'sessions.stepsOnly': ['{count} 步', '{count} steps'],
  'sessions.failed': ['这次没跑完：{reason}', 'This turn did not finish: {reason}'],
  'sessions.toTerminal': ['在终端里打开', 'Open in terminal'],
  'sessions.toChat': ['返回对话', 'Back to chat'],
  'sessions.noWorktree': ['这条会话没有记录工作区，没法接着聊', 'This session recorded no worktree, so it cannot be continued'],
})

/** A Claude Code session id: only a UUID is safe to resume — `claude --resume <value>` treats anything else as a
    session *title*, so a synthesized worker id would look for someone else's conversation. */
export const RESUMABLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The CLI conversations among the engine's runs, newest first, one row per session (a repair round shares its
    primary turn's session, so it must not become a second row). */
export function claudeSessions(runs) {
  const seen = new Set()
  const rows = []
  for (const run of Array.isArray(runs) ? runs : []) {
    const worker = run?.worker
    if (worker?.backend !== 'claude') continue
    const sessionId = typeof worker.sessionId === 'string' ? worker.sessionId.trim() : ''
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    rows.push({
      sessionId,
      resumable: RESUMABLE.test(sessionId),
      worktree: typeof run.worktree === 'string' ? run.worktree : '',
      ticketId: typeof run.ticketId === 'string' ? run.ticketId : '',
      runId: typeof run.id === 'string' ? run.id : '',
      status: typeof run.status === 'string' ? run.status : '',
      at: run.endedAt ?? run.startedAt ?? run.createdAt ?? '',
    })
  }
  return rows
}

/** The one line above a reply: how much the turn did and how long it took, or why it stopped. Above `MarkdownLite`
    because the stream's own text says what changed, not how many steps it took to get there. */
export function chatSummary(message, text) {
  if (message?.error) return text('sessions.failed', { reason: message.error })
  // A turn read back from Claude Code's own history carries no duration: say what it did, not how fast.
  if (typeof message?.ms !== 'number') {
    return message?.toolCalls ? text('sessions.stepsOnly', { count: message.toolCalls }) : ''
  }
  const seconds = Math.max(1, Math.round(message.ms / 1000))
  return message?.toolCalls ? text('sessions.steps', { count: message.toolCalls, seconds })
    : text('sessions.stepsNone', { seconds })
}

const ticketOf = (tickets, id) => Array.isArray(tickets)
  ? tickets.find(ticket => ticket?.id === id)
  : tickets?.[id]

export function SessionsList({ rows, selected, onPick, text }) {
  return <ul className="sa-session-list">
    {rows.map(row => <li key={row.sessionId}>
      <button type="button" className="sa-session-row" aria-current={row.sessionId === selected ? 'true' : undefined}
        onClick={() => onPick(row.sessionId)}>
        <span className="sa-session-main">
          <span className="sa-session-ticket">{row.title || row.ticketId || row.runId}</span>
          <span className="sa-mono sa-hint">{shortId(row.sessionId)}</span>
        </span>
        <span className="sa-session-meta">{when(row.at, text.lang)}</span>
      </button>
    </li>)}
  </ul>
}

/** One conversation: the messages so far, the input, and the way into the real TUI. */
export function SessionChat({ row, thread, draft, busy, onDraft, onSend, onTerminal, text }) {
  const input = useRef(/** @type {any} */ (null))
  const body = useRef(/** @type {any} */ (null))
  const messages = thread?.messages ?? []
  const summaryText = message => chatSummary(message, (key, values) => pt(text, key, values))
  // A reply arrives long after it was asked for: keep the newest line in view instead of at the top of the scroll.
  useEffect(() => {
    const node = body.current
    if (node) node.scrollTop = node.scrollHeight
  }, [messages.length, busy])
  return <Section title={`${pt(text, 'sessions.session')} ${shortId(row.sessionId)}`} icon="session"
    action={<Button variant="ghost" size="sm" className="sa-session-terminal" disabled={busy}
      onClick={() => void onTerminal(row)}>{pt(text, 'sessions.toTerminal')}</Button>}>
    {row.resumable ? null : <Hint>{pt(text, 'sessions.unsaved')}</Hint>}
    <div className="sa-chat">
      <div className="sa-chat-body" ref={body}>
        <p className="sa-hint sa-chat-start">{pt(text, 'sessions.start')}</p>
        {messages.map((message, index) => message.role === 'user'
          ? <div key={index} className="sa-chat-row is-user">
            <div className="sa-chat-bubble">{message.text}</div>
          </div>
          : <div key={index} className="sa-chat-row is-agent">
            {summaryText(message) ? <p className="sa-chat-meta">{summaryText(message)}</p> : null}
            {message.text ? <div className="sa-chat-reply"><MarkdownLite text={message.text} /></div> : null}
          </div>)}
        {busy ? <div className="sa-chat-row is-agent">
          <p className="sa-chat-meta">{pt(text, 'sessions.sending')}</p>
        </div> : null}
      </div>
      <form className="sa-chat-input" onSubmit={event => { event.preventDefault(); void onSend() }}>
        <textarea ref={input} className="sa-chat-text" rows={2} value={draft}
          placeholder={pt(text, 'sessions.placeholder')} disabled={busy || !row.resumable}
          onChange={event => onDraft(event.target.value)}
          onKeyDown={event => {
            // Enter sends, Shift+Enter breaks the line — a chat box, not a document editor. An IME is the exception:
            // the Enter that commits a candidate (isComposing, or the legacy keyCode 229) must reach the IME, or the
            // half-composed message is sent and the candidate is never committed.
            if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent?.isComposing || event.keyCode === 229) return
            event.preventDefault()
            void onSend()
          }} />
        <Button variant="primary" size="sm" className="sa-chat-send" type="submit"
          disabled={busy || !row.resumable || !draft.trim()}>{pt(text, 'sessions.send')}</Button>
      </form>
    </div>
  </Section>
}

export function LiveSessionsPage({ route }) {
  const { t, notify, currentSessionId, call } = usePanel()
  const { data } = usePanelData()
  const rows = claudeSessions(data?.runs).map(row => ({
    ...row,
    title: ticketOf(data?.tickets, row.ticketId)?.title ?? '',
  }))
  const [picked, setPicked] = useState('')
  const [terminal, setTerminal] = useState('')
  const [drafts, setDrafts] = useState({})
  const [threads, setThreads] = useState({})
  const [sending, setSending] = useState({})
  const selected = route?.id && rows.some(row => row.sessionId === route.id) ? route.id : (picked || rows[0]?.sessionId || '')
  const row = rows.find(item => item.sessionId === selected)
  const guiSessionId = currentSessionId()
  const busy = sending[selected] === true
  const { run: openTerminal } = useAction(async target => {
    if (!guiSessionId) {
      notify(pt(t, 'sessions.needsGui'))
      return false
    }
    const result = await call('POST engine/workers/terminal', {
      body: { sessionId: guiSessionId, cwd: target.worktree, resume: target.resumable ? target.sessionId : '' },
    })
    const terminalId = String(result?.terminalId ?? '')
    if (!terminalId) return false
    setTerminal(terminalId)
    return true
  })
  // The conversation is not this page's: Claude Code keeps the record, so opening a session shows its history.
  const loaded = useRef({})
  useEffect(() => {
    if (row === undefined || loaded.current[row.sessionId] === true) return
    loaded.current[row.sessionId] = true
    void (async () => {
      try {
        const history = await call('GET engine/workers/transcript', { query: { sessionId: row.sessionId } })
        const messages = Array.isArray(history?.messages) ? history.messages : []
        if (messages.length === 0) return
        setThreads(current => current[row.sessionId] === undefined
          ? { ...current, [row.sessionId]: { messages } }
          : current)
      } catch {
        // No history to show is not an error worth a toast: the chat box still works from here.
        loaded.current[row.sessionId] = false
      }
    })()
  }, [call, row])
  const send = useCallback(async () => {
    if (row === undefined || busy) return false
    const message = String(drafts[row.sessionId] ?? '').trim()
    if (!message) return false
    const started = Date.now()
    setDrafts(current => ({ ...current, [row.sessionId]: '' }))
    setThreads(current => ({
      ...current,
      [row.sessionId]: { messages: [...(current[row.sessionId]?.messages ?? []), { role: 'user', text: message }] },
    }))
    setSending(current => ({ ...current, [row.sessionId]: true }))
    try {
      const result = await call('POST engine/workers/chat', {
        body: { sessionId: row.resumable ? row.sessionId : '', cwd: row.worktree, message },
        // A turn may edit files and run tests: give it longer than a normal write before calling it dead.
        timeoutMs: 900000,
      })
      setThreads(current => ({
        ...current,
        [row.sessionId]: {
          messages: [...(current[row.sessionId]?.messages ?? []), {
            role: 'assistant',
            text: String(result?.text ?? ''),
            toolCalls: Number(result?.toolCalls ?? 0),
            ms: Date.now() - started,
            error: typeof result?.error === 'string' && result.error ? result.error : undefined,
          }],
        },
      }))
      return true
    } catch (error) {
      // A refused or failed turn still belongs in the conversation: the person needs to see why.
      setThreads(current => ({
        ...current,
        [row.sessionId]: {
          messages: [...(current[row.sessionId]?.messages ?? []), {
            role: 'assistant', text: '', toolCalls: 0, ms: Date.now() - started,
            error: error instanceof Error ? error.message : String(error),
          }],
        },
      }))
      return false
    } finally {
      setSending(current => ({ ...current, [row.sessionId]: false }))
    }
  }, [busy, call, drafts, row])

  if (rows.length === 0) {
    return <div className="sa-page">
      <EmptyState icon="session" title={pt(t, 'sessions.empty')} hint={pt(t, 'sessions.emptyHint')} />
    </div>
  }
  return <div className="sa-page">
    <p className="sa-hint sa-page-hint">{pt(t, 'sessions.hint')}</p>
    <div className="sa-sessions">
      <div className="sa-sessions-list">
        <SessionsList rows={rows} selected={selected} onPick={setPicked} text={t} />
      </div>
      <div className="sa-sessions-pane" data-session={selected}>
        {row === undefined
          ? <EmptyState icon="session" title={pt(t, 'sessions.pick')} />
          : terminal
            ? <div className="sa-session-terminal-pane">
              <div className="sa-session-terminal-bar">
                <Button variant="ghost" size="sm" className="sa-session-back"
                  onClick={() => setTerminal('')}>{pt(t, 'sessions.toChat')}</Button>
              </div>
              <RunTerminalPane inline sessionId={guiSessionId} terminalId={terminal}
                title={`${pt(t, 'sessions.session')} ${shortId(row.sessionId)}`} onClose={() => setTerminal('')} />
            </div>
            : <SessionChat row={row} thread={threads[row.sessionId]} draft={drafts[row.sessionId] ?? ''}
              busy={busy} text={t}
              onDraft={value => setDrafts(current => ({ ...current, [row.sessionId]: value }))}
              onSend={send} onTerminal={openTerminal} />}
      </div>
    </div>
  </div>
}
