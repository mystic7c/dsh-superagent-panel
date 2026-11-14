/* Client entry: registers the sidebar icon and the main management panel. Everything is guarded so a registration
   problem can never blank the Web boot; the panel then reports the host as unreachable instead. */

import { LOCALE_NS, PANEL_ID, SuperagentIcon } from "./00-util.js"
import { DICTS, detectLang, translate, useTranslator } from "./06-i18n.js"
import { App, PanelBoundary } from "./30-shell.js"
import { React, h, useCallback } from "./00-react.js"
export const inject = ['slots', 'locale']

export function SidebarIcon({ size }) {
  return h(SuperagentIcon, { size })
}

export function Mounted({ ctx }) {
  const t = useTranslator(ctx)
  const openSession = useCallback(async (sessionId) => {
    const workspace = ctx.get?.('uiWorkspace')
    if (workspace?.openSession) { workspace.openSession(sessionId); return }
    throw new Error('这个 Harness 版本没有 uiWorkspace 服务，无法打开 Session。')
  }, [ctx])
  return h(App, { openSession, t })
}

export function apply(ctx) {
  // Dictionaries are optional: the panel has its own translator, but registering them lets the host's locale service
  // resolve our namespace for titles and any future surface that reads it.
  try {
    const locale = ctx.get?.('locale')
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
    ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: LOCALE_NS }, () => h(PanelBoundary, null, h(Mounted, { ctx }))))
  } catch (error) {
    console.error('superagent panel failed to register', error)
  }
}
