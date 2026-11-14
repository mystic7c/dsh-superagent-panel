/* Same-origin client for the host management API, polling helpers, and the panel's shared React contexts.
   The live panel reads everything through the engine's own endpoints (32-live-model); the provider therefore
   only owns transport, routing helpers and the toast — it no longer polls a global `state` document. */

import { API } from "./util.js"
import { PANEL_CSS } from "./style.js"
import { errorText } from "./i18n.js"
import { React, createContext, h, useCallback, useContext, useEffect, useMemo, useRef, useState } from "./react.js"
export class ApiError extends Error {
  constructor(message, status, details = {}) { super(message); this.status = status; this.details = details }
  get issues() { return this.details.issues ?? [] }
  get missing() { return this.status === 404 && !this.details.unreachable }
}

/** Call one management endpoint; every request is marked so the host can refuse cross-site posts. */
export async function apiCall(t, path, method, body) {
  let response
  try {
    response = await fetch(`${API}/${path}`, { method, headers: { 'x-superagent-request': '1', ...body === undefined ? {} : { 'content-type': 'application/json' } },
      body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(t('offline'), 0, { unreachable: true })
  }
  const text = await response.text()
  let value
  try { value = text ? JSON.parse(text) : {} } catch { value = undefined }
  if (!response.ok) {
    const failure = value ?? {}
    const issues = Array.isArray(failure.issues) ? failure.issues : []
    const message = typeof failure.error === 'string' ? failure.error
      : !text && response.status === 404 ? t('hostNotRunning')
      : response.status >= 500 ? t('serverError', { status: response.status })
      : t('requestFailed', { status: response.status })
    throw new ApiError(message, response.status, { issues, ...text ? {} : { unreachable: true } })
  }
  return value
}

/** Build the typed route caller used by every view: `call('GET engine/ticket/:id', { id })`. */
export function caller(t) {
  return (route, ...rest) => {
    const [method, pattern] = route.split(' ')
    const request = rest[0] ?? {}
    const path = pattern.replace(/:(\w+)/g, (_match, name) => encodeURIComponent(String(request[name])))
    const query = Object.entries(request.query ?? {}).filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => `${name}=${encodeURIComponent(String(value))}`).join('&')
    return apiCall(t, query ? `${path}?${query}` : path, method, request.body)
  }
}

export const HIDDEN_FACTOR = 6
export const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b)
/** Poll one endpoint while mounted, backing off while the document is hidden and keeping the last good value. */
export function usePoll(load, deps, intervalMs = 5000) {
  const [state, setState] = useState({})
  const loader = useRef(load)
  loader.current = load
  const refresh = useRef(async () => {})
  useEffect(() => {
    let active = true
    let timer
    let queue = Promise.resolve()
    const once = async () => {
      clearTimeout(timer)
      try {
        const value = await loader.current()
        if (active) setState(previous => same(previous.data, value) ? (previous.error ? { data: previous.data } : previous) : { data: value })
      } catch (failure) {
        if (active) setState(previous => ({ ...previous, error: failure instanceof Error ? failure : new Error(String(failure)) }))
      } finally {
        if (active) timer = setTimeout(run, document.hidden ? intervalMs * HIDDEN_FACTOR : intervalMs)
      }
    }
    const run = () => (queue = queue.then(once))
    const shown = () => { if (!document.hidden) void run() }
    refresh.current = run
    void run()
    document.addEventListener('visibilitychange', shown)
    return () => { active = false; clearTimeout(timer); document.removeEventListener('visibilitychange', shown) }
  }, [...deps, intervalMs])
  const reload = useCallback(() => refresh.current(), [])
  return { data: state.data, error: state.error, reload }
}

/** Panel context: transport, router helpers and the shared toast; page data lives in PanelState (32-live-model). */
export const Panel = createContext(undefined)
export const PanelState = createContext(undefined)
export function usePanel() {
  const value = useContext(Panel)
  if (!value) throw new Error('Superagent panel rendered outside its provider')
  return value
}
export function usePanelData() {
  const value = useContext(PanelState)
  if (!value) throw new Error('Superagent panel rendered outside its provider')
  return value
}
/** Wrap an async action with re-entrancy protection, busy state, optional reload, and a toast on failure. */
export function useAction(action, options = {}) {
  const { notify } = usePanel()
  const [busy, setBusy] = useState(false)
  const running = useRef(false)
  const run = async (...args) => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    try { await action(...args); await options.reload?.(); return true }
    catch (failure) { notify(errorText(failure)); return false }
    finally { running.current = false; setBusy(false) }
  }
  return { run, busy }
}

export function Toast({ text, toastKey, onDone, holdMs = 4000 }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => { const timer = setTimeout(() => done.current(), holdMs + 1000); return () => clearTimeout(timer) }, [toastKey, holdMs])
  return h('div', { className: 'sa-toast', role: 'status' }, text)
}

export const stay = () => {}
export const noSession = async () => {}
/**
 * One provider for the whole panel: the typed caller, routing callbacks, session opener and the toast.
 * `route` is passed down as well so a page can tell a list view from a deep-linked detail view.
 */
export function PanelProvider({ t, openSession = noSession, navigate = stay, back = stay, backLabel = '', route, children }) {
  const copy = useRef(t)
  copy.current = t
  const call = useMemo(() => caller(key => copy.current(key)), [])
  const [toast, setToast] = useState()
  const notify = useCallback(text => setToast({ text, id: Date.now() }), [])
  const context = useMemo(() => ({ t, call, navigate, back, backLabel, openSession, notify, route }),
    [t, call, navigate, back, backLabel, openSession, notify, route])
  return h(Panel.Provider, { value: context },
    h('style', null, PANEL_CSS),
    children,
    toast && h(Toast, { key: toast.id, toastKey: toast.id, text: toast.text, onDone: () => setToast(undefined) }))
}
