/* Sessions page: the CLI workers' conversations, left list + right terminal, the same shape the Host's own chat gives.
   A Claude Code run has no DSH Session to open, so this page is where its conversation lives: pick a run's session on
   the left, the live `claude --resume` terminal fills the right. The terminal is the panel's own (xterm) — the Host only
   supplies the PTY through `POST engine/workers/terminal`. */

import { shortId } from "./util.js"
import { when } from "./i18n.js"
import { Button } from "./controls.js"
import { useAction, usePanel, usePanelData } from "./api.js"
import { EmptyState, Hint, Section } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { RunTerminalPane } from "./terminal.js"
import { React, h, useCallback, useEffect, useRef, useState } from "./react.js"

Object.assign(PAGE_TEXT, {
  'sessions.title': ['会话', 'Sessions'],
  'sessions.hint': ['这里列出 Claude Code CLI worker 跑过的会话。选一条，右边就是它的终端：接管会恢复当时的对话，'
    + '可以接着问。', "Each Claude Code CLI worker run left a session here. Pick one: the terminal on the right resumes "
    + 'its conversation, so you can keep going where the run stopped.'],
  'sessions.empty': ['还没有 Claude Code CLI 运行的会话', 'No Claude Code CLI session yet'],
  'sessions.emptyHint': ['把设置里的 worker 后端切到「Claude Code CLI（本机）」，跑一张票，这里就会出现它的会话。',
    'Set the worker backend to Claude Code CLI and run one ticket; its session shows up here.'],
  'sessions.pick': ['从左边选一个会话', 'Pick a session on the left'],
  'sessions.open': ['打开终端', 'Open terminal'],
  'sessions.reopen': ['重新连接', 'Reconnect'],
  'sessions.opened': ['终端已就绪', 'Terminal ready'],
  'sessions.needsGui': ['先在这个界面上打开任意一个会话，终端要挂在它下面', 'Open any Session in this interface first: the terminal hangs under it'],
  'sessions.worktree': ['工作区', 'Worktree'],
  'sessions.run': ['运行', 'Run'],
  'sessions.ticket': ['工单', 'Ticket'],
  'sessions.session': ['会话', 'Session'],
  'sessions.unsaved': ['这个会话没有可续接的 id，接管会开一个新的 Claude Code', 'This session has no resumable id, so takeover starts a fresh Claude Code'],
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

const ticketOf = (tickets, id) => Array.isArray(tickets)
  ? tickets.find(ticket => ticket?.id === id)
  : tickets?.[id]

export function SessionsList({ rows, selected, onPick }) {
  return <ul className="sa-session-list">
    {rows.map(row => <li key={row.sessionId}>
      <button type="button" className="sa-session-row" aria-current={row.sessionId === selected ? 'true' : undefined}
        onClick={() => onPick(row.sessionId)}>
        <span className="sa-session-main">
          <span className="sa-session-ticket">{row.title || row.ticketId || row.runId}</span>
          <span className="sa-mono sa-hint">{shortId(row.sessionId)}</span>
        </span>
        <span className="sa-session-meta">{when(row.at)}</span>
      </button>
    </li>)}
  </ul>
}

/** The right half: the resumed Claude Code terminal, or the one button that opens it. */
export function SessionTerminal({ row, terminalId, onOpen, busy, t }) {
  if (terminalId !== undefined) {
    return <RunTerminalPane inline sessionId={row.guiSessionId} terminalId={terminalId}
      title={`${pt(t, 'sessions.session')} ${shortId(row.sessionId)}`} onClose={undefined} />
  }
  return <Section title={pt(t, 'sessions.session')} icon="session">
    <dl className="sa-kv">
      <dt>{pt(t, 'sessions.session')}</dt>
      <dd className="sa-mono">{row.sessionId || '—'}</dd>
      <dt>{pt(t, 'sessions.worktree')}</dt>
      <dd className="sa-mono">{row.worktree || '—'}</dd>
      <dt>{pt(t, 'sessions.ticket')}</dt>
      <dd>{row.ticketId || '—'}</dd>
    </dl>
    {row.resumable ? null : <Hint>{pt(t, 'sessions.unsaved')}</Hint>}
    <Button variant="primary" size="sm" className="sa-session-open" disabled={busy} onClick={() => void onOpen(row)}>
      {pt(t, 'sessions.open')}
    </Button>
  </Section>
}

export function LiveSessionsPage({ route }) {
  const { t, notify, currentSessionId, call } = usePanel()
  const { data } = usePanelData()
  const rows = claudeSessions(data?.runs).map(row => ({
    ...row,
    title: ticketOf(data?.tickets, row.ticketId)?.title ?? '',
  }))
  const [opened, setOpened] = useState({})
  const [picked, setPicked] = useState('')
  const selected = route?.id && rows.some(row => row.sessionId === route.id) ? route.id : (picked || rows[0]?.sessionId || '')
  const row = rows.find(item => item.sessionId === selected)
  const guiSessionId = currentSessionId()
  const { run: open, busy } = useAction(async target => {
    if (!guiSessionId) {
      notify(pt(t, 'sessions.needsGui'))
      return false
    }
    const result = await call('POST engine/workers/terminal', {
      body: { sessionId: guiSessionId, cwd: target.worktree, resume: target.resumable ? target.sessionId : '' },
    })
    const terminalId = String(result?.terminalId ?? '')
    if (!terminalId) return false
    setOpened(current => ({ ...current, [target.sessionId]: terminalId }))
    notify(pt(t, 'sessions.opened'))
    return true
  })
  const openRow = useCallback(target => open(target), [open])
  // Arriving from a run row ("在终端接管") means "show me the terminal now", not "show me a button".
  const auto = useRef('')
  useEffect(() => {
    if (route?.open !== '1' || row === undefined || opened[selected] !== undefined) return
    if (auto.current === selected) return
    auto.current = selected
    void openRow(row)
  }, [route?.open, row, opened, selected, openRow])

  if (rows.length === 0) {
    return <div className="sa-page">
      <EmptyState icon="session" title={pt(t, 'sessions.empty')} hint={pt(t, 'sessions.emptyHint')} />
    </div>
  }
  return <div className="sa-page">
    <p className="sa-hint sa-page-hint">{pt(t, 'sessions.hint')}</p>
    <div className="sa-sessions">
      <div className="sa-sessions-list">
        <SessionsList rows={rows} selected={selected} onPick={setPicked} />
      </div>
      <div className="sa-sessions-pane" data-session={selected}>
        {row === undefined
          ? <EmptyState icon="session" title={pt(t, 'sessions.pick')} />
          : <SessionTerminal row={{ ...row, guiSessionId }} terminalId={opened[selected]} onOpen={openRow}
            busy={busy} t={t} />}
      </div>
    </div>
  </div>
}
