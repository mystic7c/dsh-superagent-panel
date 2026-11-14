/* Small utilities shared by the Superagent panel: class names, icons, time/format helpers, and a safe Markdown subset.
   Plain script text inside the bundle factory; see scripts/build-client.mjs. */

import { timeLocale, when } from "./i18n.js"
import { StatusIcon } from "./controls.js"
import { RawValue } from "./widgets.js"
import { React, h } from "./react.js"
export const PANEL_ID = 'superagent'
export const LOCALE_NS = 'superagent'
export const API = '/superagent/api'
export const PAGE_SIZE = 20

export const cx = (...names) => names.filter(Boolean).join(' ')

/* Icon set copied in behavior from the host's own controls but drawn here: the plugin must not import the host's
   component packages, and `currentColor` keeps icons consistent with the active theme. Icons are stroke paths on a
   24×24 grid; the shape itself carries meaning where color is only supplementary (see StatusIcon). */
export const ICON_PATHS = {
  'chevron-left': 'M15 5l-7 7 7 7',
  'chevron-right': 'M9 5l7 7-7 7',
  'chevron-down': 'M5 9l7 7 7-7',
  'chevron-up': 'M5 15l7-7 7 7',
  search: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4',
  question: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
  close: 'M6 6l12 12M18 6L6 18',
  settings: 'M4 7h10M18 7h2M4 17h4M12 17h8M16 5v4M10 15v4',
  refresh: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5',
  external: 'M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5',
  session: 'M4 5h16v14H4zM8 10l3 2-3 2M13 15h3',
  stop: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM9.5 9.5h5v5h-5z',
  pause: 'M9 6v12M15 6v12',
  play: 'M8 5l11 7-11 7z',
  unsubscribe: 'M6 16v-5a6 6 0 0 1 10-4.5M18 11v5l2 2H8M10 20h4M4 4l16 16',
  dismiss: 'M4 4l16 16M9.9 5.2A9 9 0 0 1 21 12a12 12 0 0 1-2.4 3.2M6.3 6.4A12 12 0 0 0 3 12c2 4 5.5 6 9 6 1.4 0 2.7-.3 3.9-.9',
  review: 'M9 4h6v3H9zM7 5H5v15h14V5h-2M9 13l2 2 4-4',
  diff: 'M5 8h8M9 4v8M5 16h8',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3.5 4v4h4M12 8v4l3 2',
  shield: 'M12 3l7 3v6c0 4.2-2.9 7.6-7 9-4.1-1.4-7-4.8-7-9V6z',
  decision: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12.5l2.5 2.5 4.5-5',
  message: 'M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-5 4V6a1 1 0 0 1 1-1z',
  inbox: 'M4 13l2.5-8h11l2.5 8M4 13v6h16v-6M4 13h5l1 2h4l1-2h5',
  hash: 'M10 4L8 20M16 4l-2 16M5 9h15M4 15h15',
  filter: 'M4 5h16l-6 7.5V18l-4 2v-7.5z',
  user: 'M12 4a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM4 20c1.5-3.5 4.5-5 8-5s6.5 1.5 8 5',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7.5v5.5M12 16.5h.01',
  queue: 'M4 6h16M4 12h16M4 18h10',
  blocked: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM5.6 5.6l12.8 12.8',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  copy: 'M9 9h10v11H9zM5 15V4h10',
  pull: 'M7 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM7 8v8M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM17 16V9a2 2 0 0 0-2-2h-4M13 5l-2 2 2 2',
  robot: 'M12 3v3M8 8h8a3 3 0 0 1 3 3v5a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-5a3 3 0 0 1 3-3zM9 13h.01M15 13h.01M10 17h4',
  // Redesign additions (contract §3.3): state shapes and menu affordances.
  check: 'M5 12.5l4.5 4.5L19 7',
  x: 'M6 6l12 12M18 6L6 18',
  'circle-check': 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM8.5 12.5l2.5 2.5 4.5-5',
  'alert-triangle': 'M12 4l9 16H3zM12 10v4.5M12 17.3h.01',
  circle: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z',
  more: 'M5.2 12h1.2M11.4 12h1.2M17.6 12h1.2',
}

export function Icon({ name, size = 16 }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
    strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }, h('path', { d: ICON_PATHS[name] ?? ICON_PATHS.alert }))
}

/** The sidebar entry's icon: a small agent head with a tool, colored with the current sidebar state. */
export function SuperagentIcon({ size }) {
  return h('svg', { width: size, height: size, viewBox: '0 0 64 64', fill: 'none', 'aria-hidden': 'true', style: { display: 'block' } },
    h('rect', { x: 8, y: 20, width: 34, height: 26, rx: 8, fill: 'currentColor', opacity: 0.9 }),
    h('rect', { x: 14, y: 26, width: 22, height: 13, rx: 5, fill: 'var(--dsw-alias-bg-base, transparent)' }),
    h('circle', { cx: 21, cy: 32.5, r: 2.4, fill: 'currentColor' }),
    h('circle', { cx: 29, cy: 32.5, r: 2.4, fill: 'currentColor' }),
    h('path', { d: 'M25 15v5', stroke: 'currentColor', strokeWidth: 2.6, strokeLinecap: 'round' }),
    h('circle', { cx: 25, cy: 14, r: 2.4, fill: 'currentColor' }),
    h('path', { d: 'M48 35l8 8-5 5-8-8z', fill: 'currentColor', opacity: 0.75 }),
    h('path', { d: 'M8 50h30', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round', opacity: 0.35 }))
}

/* ---------- shared formatting helpers (contract §3.3; pages and shell-data use these instead of local copies) ---------- */

/** First `len` characters of an opaque id (`tkt_1b6f9c…`) for inline labels; long ids alone belong in RawValue. */
export function shortId(value, len = 6) {
  const text = String(value ?? '')
  if (!text) return ''
  return text.length <= len ? text : `${text.slice(0, len)}…`
}

/** Absolute wall-clock time (hh:mm:ss) for "更新于/已保存于" lines; invalid or empty input renders as ''. */
export function hhmmss(value, lang) {
  if (value === undefined || value === null || value === '') return ''
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString(timeLocale(lang), { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

/** Wall-clock time (hh:mm) for the 30-second status surfaces: seconds imply a precision the poll does not have. */
export function hhmm(value, lang) {
  return hhmmss(value, lang).slice(0, 5)
}

/** True when a link leaves this origin; such links open in a new tab with rel=noopener. */
export function isExternal(url) {
  if (typeof url !== 'string' || url === '') return false
  try {
    const base = typeof location === 'undefined' ? 'http://localhost' : location.origin
    const target = new URL(url, base)
    if (target.protocol !== 'http:' && target.protocol !== 'https:') return false
    return typeof location === 'undefined' || target.origin !== location.origin
  } catch { return false }
}

/** Only an absolute http(s) URL may be written into an href. Everything else (javascript:, data:, relative paths)
    is rendered as inert text: URLs shown here come from live.json, GitLab and Octo payloads. */
export function safeHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : ''
}

/* ---------- shareable URL state (deep links) ----------
   The panel lives inside a host SPA that owns the address bar, so it only ever claims a fragment of its own
   (`#<prefix>=<json>`; anything else belongs to the host). Reads and writes are best-effort: an opaque origin can
   throw on history, and a host is free to rewrite the URL at any moment, which must never break the panel. */

/** Longest fragment this panel agrees to decode: a route is a few hundred characters, so anything bigger is not ours. */
export const HASH_STATE_MAX = 4096

/** Build the fragment for `value`; the exact string is also what `writeHashState` compares against and returns. */
export function hashStateFragment(prefix, value) {
  return `#${prefix}=${encodeURIComponent(JSON.stringify(value))}`
}

/** Decode the JSON object stored by this panel under `#<prefix>=`; `undefined` for a foreign, absent or corrupt one. */
export function readHashState(prefix) {
  try {
    if (typeof location === 'undefined') return undefined
    const hash = String(location.hash ?? '')
    const marker = `#${prefix}=`
    if (!hash.startsWith(marker) || hash.length > HASH_STATE_MAX) return undefined
    const value = JSON.parse(decodeURIComponent(hash.slice(marker.length)))
    return value && typeof value === 'object' ? value : undefined
  } catch { return undefined }
}

/** Rewrite the panel's fragment in place and return it, or `undefined` when the URL was left alone. `replaceState`
    (never hash assignment) keeps the host's back/forward entries untouched; a non-empty fragment that is not ours is
    the host's own state and is preserved rather than overwritten. */
export function writeHashState(prefix, value) {
  try {
    if (typeof location === 'undefined' || typeof history === 'undefined' || typeof history.replaceState !== 'function') return undefined
    const marker = `#${prefix}=`
    const current = String(location.hash ?? '')
    if (current && !current.startsWith(marker)) return undefined
    const next = hashStateFragment(prefix, value)
    if (current === next) return next
    history.replaceState(history.state, '', `${location.pathname}${location.search}${next}`)
    return next
  } catch { return undefined }
}
