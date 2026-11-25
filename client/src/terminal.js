/* The Claude Code TUI inside the panel.
 *
 * The Host owns the process and the terminal view model (`ctx.webTerminals`); the only thing missing was a screen, so
 * this module is the screen: xterm.js wired to a `TerminalView` the same way the Host's own sidebar wires it — mount the
 * DOM lifetime, write each render frame, acknowledge it after xterm parsed it, and send typed bytes back.
 *
 * xterm is bundled into this plugin (the Web module loader only shares React and a few DSH packages), which is the price
 * of showing a real TUI here instead of in the Host's right Sidebar. */

import xtermCss from '@xterm/xterm/css/xterm.css'
import { h, useEffect, useLayoutEffect, useMemo, useRef, useState } from './react.js'
import { usePanel } from './api.js'

/** Apply one render frame to an emulator: a snapshot replaces the screen (and the Host's grid), output appends.
 *
 *  Exported for the test: the acknowledge hook is what keeps the Host stream moving, so a frame silently dropped here
 *  would look like a frozen terminal. */
export function applyRenderFrame(terminal, render, done) {
  if (render?.frame === undefined) return false
  const next = { revision: render.revision, frame: render.frame }
  if (next.frame.type === 'snapshot') {
    terminal.reset()
    terminal.resize(next.frame.info.cols, next.frame.info.rows)
    terminal.write(next.frame.screen, done)
  } else {
    terminal.write(next.frame.data, done)
  }
  return true
}

/** Clamp the emulator grid to what the Host accepted, then tell it about our size. */
export function fitGrid(terminal, fit, state, view) {
  const size = fit.proposeDimensions()
  const environment = state?.environment
  if (size === undefined || environment === undefined) return false
  const cols = Math.min(size.cols, environment.maxCols)
  const rows = Math.min(size.rows, environment.maxRows)
  if (cols < 2 || rows < 1) return false
  terminal.resize(cols, rows)
  view.resize(cols, rows)
  return true
}

/** Load the emulator on first use: it is ~300 KB of parser and a screen, and nothing else in the panel needs it.
 *  It is also why the checker scripts can import this module in Node — xterm's UMD wrapper wants a browser. */
function useEmulator() {
  const [kit, setKit] = useState(undefined)
  useEffect(() => {
    let live = true
    void Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]).then(([core, fit]) => {
      if (live) setKit({ Terminal: core.Terminal, FitAddon: fit.FitAddon })
    }).catch(() => { /* a bundle without xterm shows the title bar and the error line instead of a screen */ })
    return () => { live = false }
  }, [])
  return kit
}

/** Re-render on every observable change of the view and read the state during render: the store hands its listener no
 *  argument, so subscribing a counter is what actually survives a snapshot the store swaps in place. */
function useTerminalState(view) {
  const [, bump] = useState(0)
  useEffect(() => {
    if (view === undefined) return undefined
    let live = true
    const sync = () => { if (live) bump(count => count + 1) }
    const off = view.state.subscribe(sync)
    sync()
    return () => { live = false; if (typeof off === 'function') off() }
  }, [view])
  return view?.state.getSnapshot()
}

/** One live terminal: a toolbar with its title and control, and the screen itself. */
export function RunTerminalPane({ sessionId, terminalId, title, onClose, inline = false }) {
  const { t, terminalView } = usePanel()
  const view = useMemo(() => terminalView?.(sessionId, terminalId), [terminalView, sessionId, terminalId])
  const state = useTerminalState(view)
  const kit = useEmulator()
  const screen = useRef(null)
  const emulator = useRef(undefined)
  const fitter = useRef(undefined)
  const lastRevision = useRef(0)
  const live = useRef({ state, view })
  live.current = { state, view }

  // The DOM lifetime is the view's: mounting attaches (or creates) the terminal, detaching leaves the process alive.
  useEffect(() => view?.mount(), [view])

  // The Host opened this terminal a moment ago and this window's roster was already cached, so the first lookup misses
  // it. Ask again a few times instead of showing "missing": the roster catches up on its own within a couple of frames.
  const retries = useRef(0)
  useEffect(() => {
    if (view === undefined || state?.issue !== 'missingTerminal' || retries.current >= 8) return undefined
    retries.current += 1
    const timer = setTimeout(() => { void view.refresh() }, 350)
    return () => clearTimeout(timer)
  }, [view, state])

  useLayoutEffect(() => {
    const node = screen.current
    if (view === undefined || node === null || kit === undefined) return undefined
    const terminal = new kit.Terminal({
      minimumContrastRatio: 4.5,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: view.state.getSnapshot()?.environment?.scrollback ?? 1000,
    })
    const fit = new kit.FitAddon()
    terminal.loadAddon(fit)
    terminal.open(node)
    emulator.current = terminal
    fitter.current = fit
    lastRevision.current = 0
    const input = terminal.onData(data => view.write(data, true))
    const measure = () => {
      const { state: liveState, view: liveView } = live.current
      if (liveView === undefined || liveState?.writable !== true) return
      if (node.clientWidth === 0 || node.clientHeight === 0) return
      fitGrid(terminal, fit, liveState, liveView)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    measure()
    return () => {
      observer.disconnect()
      input.dispose()
      terminal.dispose()
      emulator.current = undefined
      fitter.current = undefined
    }
  }, [view, kit])

  useLayoutEffect(() => {
    const terminal = emulator.current
    const render = state?.render
    if (terminal === undefined || render === undefined || render.revision <= lastRevision.current) return
    lastRevision.current = render.revision
    applyRenderFrame(terminal, render, () => view.acknowledge(render.revision))
  }, [state?.render, view])

  useLayoutEffect(() => {
    const terminal = emulator.current
    if (terminal === undefined) return
    // Input follows the Host's writability: a terminal the person took over stays read-only for this pane.
    terminal.options.disableStdin = state?.writable !== true
    const fit = fitter.current
    if (state?.writable === true && fit !== undefined && screen.current?.clientWidth) fitGrid(terminal, fit, state, view)
  }, [state?.writable, state?.info?.cols, state?.info?.rows, view])

  const phase = state?.phase ?? 'loading'
  const problem = state?.error ?? state?.issue
  return <section className={inline ? 'sa-terminal is-inline' : 'sa-terminal'} data-phase={phase}>
    <style>{xtermCss}</style>
    <header className="sa-terminal-bar">
      <span className="sa-terminal-title" translate="no">{title ?? t('runTerminalTitle')}</span>
      <span className="sa-hint">{t(`runTerminalPhase.${phase}`)}</span>
      <span className="sa-terminal-spacer" />
      <button type="button" className="sa-terminal-close" onClick={() => { void view?.close?.(); onClose?.() }}>
        {t('runTerminalClose')}
      </button>
    </header>
    <div className="sa-terminal-screen" ref={screen} />
    {problem === undefined ? null : <p className="sa-error sa-terminal-error">{String(problem)}</p>}
  </section>
}
