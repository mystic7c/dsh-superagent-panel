/* Page-local bilingual text. Each page fragment appends its pairs here with `Object.assign(PAGE_TEXT, {...})` and reads
   them through `pt(t, key, values)`; shared keys still live in 06-i18n.js. Keeping page text in the page fragment avoids
   two agents editing one dictionary while they build different pages. */

import { translate } from "./06-i18n.js"
import { React, h } from "./00-react.js"
export const PAGE_TEXT = {}

/** Translate a page-local key (pair of [zh, en]) with `{name}` interpolation; falls back to the shared dictionary. */
export function pt(t, key, values) {
  const pair = PAGE_TEXT[key]
  const template = pair ? pair[t.lang === 'en' ? 1 : 0] : translate(t.lang, key)
  if (values === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}
