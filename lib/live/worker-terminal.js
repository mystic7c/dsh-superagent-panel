/**
 * "Open this run's Claude Code conversation in a terminal": the host opens an Agent terminal for the GUI Session the
 * panel is shown in, at the run's worktree, and types the `claude` command into it. From there it is the real Claude
 * Code TUI — the person watches it, and their first keystroke takes the terminal away from the agent, exactly like a
 * terminal tab they opened themselves.
 *
 * The resume id is never interpolated unchecked: it becomes part of a shell command line, so only the character set a
 * Claude Code session id actually uses is accepted.
 */

const RESUME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/** A refusal the panel can explain; the host maps `httpStatus` onto the response. */
function refusal(status, message) {
  const error = /** @type {Error & { httpStatus?: number }} */ (new Error(message))
  error.httpStatus = status
  return error
}

/**
 * @param {{ ctx: any, body?: any, signal?: AbortSignal,
 *   log?: (line: string) => void }} options
 * @returns {Promise<{ terminalId: string, pid: number, resumed: boolean, reused: boolean }>}
 */
export async function openWorkerTerminal({ ctx, body, signal, log = () => {} }) {
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : ''
  if (!sessionId) throw refusal(400, '缺少会话标识：终端要挂在当前 DSH 会话下')
  const cwd = typeof body?.cwd === 'string' && body.cwd.trim() ? body.cwd.trim() : undefined
  const requested = typeof body?.resume === 'string' ? body.resume.trim() : ''
  if (requested && !RESUME_PATTERN.test(requested)) throw refusal(400, '会话标识格式不正确')
  const agents = ctx?.get?.('agents')
  const controller = ctx?.get?.('terminalController')
  if (typeof agents?.get !== 'function' || typeof controller?.openForAgent !== 'function') {
    throw refusal(409, '当前 DSH 没有终端服务：升级 DSH 后再试')
  }
  const agent = agents.get(sessionId)
  if (!agent) throw refusal(409, '会话未在运行：先在界面上打开这个会话再接管终端')
  const title = requested ? `Claude Code · ${requested.slice(0, 8)}` : 'Claude Code'
  // A second click on the same run comes back to the terminal already running it, instead of burning another of the
  // Host's few agent terminals and starting a second Claude Code on one conversation.
  const existing = (() => {
    try { return (controller.list?.(sessionId) ?? []).find(info => info.origin === 'agent' && info.title === title) } catch { return undefined }
  })()
  if (existing !== undefined) return { terminalId: String(existing.id), pid: 0, resumed: Boolean(requested), reused: true }
  let terminal
  try {
    terminal = await controller.openForAgent(agent, {
      title,
      ...(cwd ? { cwd } : {}),
      cols: 120,
      rows: 32,
      // The CLI needs the network (its model API) and the worktree; a confined mode would break it in ways the person
      // would have to debug inside the terminal.
      policy: { mode: 'danger-full-access', workspaceRoot: cwd ?? agent.session?.cwd ?? process.cwd(), sessionId },
      preferredShells: ['zsh', 'bash', 'sh'],
    }, signal ?? new AbortController().signal)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw refusal(409, `打不开终端：${message}`)
  }
  // The pty queues input until the shell reads it, so this does not race shell start-up; keep the trailing CR so the
  // command runs without the person pressing Enter on a command they did not type.
  const command = requested ? `claude --resume ${requested}\r` : 'claude\r'
  try {
    await terminal.write(command)
  } catch (error) {
    log(`worker-terminal: write failed: ${error instanceof Error ? error.message : String(error)}`)
    await Promise.resolve(terminal.close?.()).catch(() => {})
    throw refusal(409, '终端已打开但没能输入命令：请在终端里手动运行 claude')
  }
  log(`worker-terminal: opened ${terminal.id}${requested ? ` resuming ${requested}` : ''}`)
  return { terminalId: String(terminal.id), pid: Number(terminal.pid) || 0, resumed: Boolean(requested), reused: false }
}
