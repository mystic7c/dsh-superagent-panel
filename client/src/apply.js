/* Client entry: registers the sidebar icon and the main management panel. Everything is guarded so a registration
   problem can never blank the Web boot; the panel then reports the host as unreachable instead. */

import { LOCALE_NS, PANEL_ID, SuperagentIcon } from "./util.js"
import { DICTS, detectLang, translate, useTranslator } from "./i18n.js"
import { App, PanelBoundary } from "./shell.js"
import { createSessionOpener } from "./session-open.js"
import { LINKED_ROUTE, linkedRoutePending } from "./router.js"
import { React, h, useCallback } from "./react.js"
// `layout` is deliberately NOT injected: a host that predates that service (or any host where it is unavailable) must
// still load this plugin, or the sidebar entry disappears altogether. The service is re-read on every retry tick
// instead, so a late-provided layout still opens a shared `#sa=…` link.
export const inject = ['slots', 'locale']

export function SidebarIcon({ size }) {
  return h(SuperagentIcon, { size })
}

export function Mounted({ ctx }) {
  const t = useTranslator(ctx)
  const openSession = useCallback(createSessionOpener(ctx), [ctx])
  return h(App, { openSession, t })
}

/** Client half: the sidebar icon plus the panel in the `main` slot.
 *
 * @param {DSH.ClientPluginContext} ctx
 */
export function apply(ctx) {
  // Dictionaries are optional: the panel has its own translator, but registering them lets the host's locale service
  // resolve our namespace for titles and any future surface that reads it.
  try {
    const locale = /** @type {{ register: (namespace: string, language: string, dict: any) => void } | undefined} */ (
      ctx.get?.('locale'))
    if (locale?.register) {
      locale.register(LOCALE_NS, 'zh-CN', DICTS.zh)
      locale.register(LOCALE_NS, 'zh', DICTS.zh)
      locale.register(LOCALE_NS, 'en', DICTS.en)
      locale.register(LOCALE_NS, 'en-US', DICTS.en)
    }
  } catch { /* dictionary registration is best effort */ }
  try {
    ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 8,
      label: () => translate(detectLang(ctx), 'title'),
    }, SidebarIcon))
  } catch (error) {
    console.error('superagent sidebar entry failed to register', error)
  }
  try {
    ctx.slots.inject('main', () => {
      ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, () => h(PanelBoundary, null, h(Mounted, { ctx })))
    })
  } catch (error) {
    console.error('superagent panel failed to register', error)
  }
  // Opening the panel is a separate, retried step: the main key is only selectable once `register` has committed, and a
  // throw here must never take the registration down with it.
  try {
    const dispose = openLinkedPanelWhenReady(ctx)
    if (dispose) ctx.effect(() => dispose, 'superagent: linked panel')
  } catch (error) {
    console.error('superagent linked panel failed to open', error)
  }
}

export const OPEN_LINKED_RETRY_MS = 120
export const OPEN_LINKED_RETRY_LIMIT = 17

function layoutOf(ctx) {
  try { return ctx.get?.('layout') ?? ctx.layout } catch { return undefined }
}

/** A page load that carried one of our `#sa=…` links lands on the host's default view: the host activates a main panel
 * only when a person clicks the sidebar icon, and a reload forgets which panel was open. The route itself is kept by
 * the panel (router.js reads the fragment at load), so opening the panel for that one case restores the shared view.
 * Returns whether the selection was accepted; the layout service is optional, so an older host simply stays put. */
export function openLinkedPanel(ctx, { route = LINKED_ROUTE } = {}) {
  if (!route) return false
  const layout = layoutOf(ctx)
  if (typeof layout?.selectPanel !== 'function') return false
  try {
    layout.selectPanel(PANEL_ID)
    return true
  } catch { return false }
}

/** Open the linked panel and keep trying while the deep link is still pending.
 *
 * Why retry: `selectPanel` throws while our `main` key is not registered yet, and registration commits asynchronously
 * after this plugin's slot callback returns — so the first attempt (right after apply) usually loses that race. The
 * window is short: the panel's own mount calls `releaseLinkedRoute()`, so a successful open ends the loop. If the host
 * boots and restores its own selection anyway, one observation puts the panel back once and then stops watching.
 *
 * @returns a disposer that clears the timer and the observation, or undefined when there is nothing to do.
 */
export function openLinkedPanelWhenReady(ctx, {
  isPending = () => linkedRoutePending,
  route = LINKED_ROUTE,
  intervalMs = OPEN_LINKED_RETRY_MS,
  limit = OPEN_LINKED_RETRY_LIMIT,
} = {}) {
  if (!isPending() || !route) return undefined
  let attempts = 0
  let timer
  let unsubscribe
  const stop = () => {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined }
    if (unsubscribe) { unsubscribe(); unsubscribe = undefined }
  }
  /** The host may commit its own landing panel after our selection lands; restore ours once, then stop watching. */
  const watchOnce = () => {
    const layout = layoutOf(ctx)
    if (typeof layout?.panelInfo?.subscribe !== 'function') return
    try {
      unsubscribe = layout.panelInfo.subscribe(() => {
        if (!isPending()) { stop(); return }
        let active
        try { active = layout.panelInfo.getSnapshot?.()?.activePanelId } catch { active = PANEL_ID }
        if (active === PANEL_ID) return
        stop()
        if (!isPending()) return
        openLinkedPanel(ctx, { route })
      })
    } catch { unsubscribe = undefined }
  }
  const attempt = () => {
    timer = undefined
    if (!isPending()) { stop(); return }
    if (openLinkedPanel(ctx, { route })) { watchOnce(); return }
    attempts += 1
    if (attempts >= limit) return
    timer = setTimeout(attempt, intervalMs)
  }
  attempt()
  return stop
}
