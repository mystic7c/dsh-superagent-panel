// Verifies that every literal translation key used by the client fragments exists in the dictionaries.
// Dynamic keys (`t(\`tab.${page}\`)`) are skipped; the check is a safety net, not a proof of coverage.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'client', 'src')
// The bundle prelude provides React and these hooks; the checker repeats it so fragments can be evaluated.
const PRELUDE = `
const React = { createElement: () => null, useState: () => [], useEffect: () => {}, useRef: () => ({}), useMemo: () => ({}), Component: class {},
  useCallback: () => {}, useLayoutEffect: () => {}, useContext: () => undefined, createContext: () => ({}), Fragment: {} }
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useContext, createContext, Fragment } = React
const h = React.createElement
`
const load = (names) => {
  const text = names.map(name => readFileSync(join(src, name), 'utf8')).join('\n')
  const factory = new Function(`${PRELUDE}${text}\nreturn { DICTS, TEXT, PAGE_TEXT }`)
  return factory()
}
// Load every fragment in build order so `Object.assign(PAGE_TEXT, ...)` contributions are visible.
const order = readdirSync(src).filter(name => name.endsWith('.js')).sort()
const { DICTS, PAGE_TEXT } = load(order)

const fragments = order.filter(name => name !== '06-i18n.js' && name !== '21-localtext.js')
const used = new Map()
for (const name of fragments) {
  const text = readFileSync(join(src, name), 'utf8')
  const patterns = [/\bt\(\s*'([^']+)'/g, /\bpt\(\s*t\s*,\s*'([^']+)'/g, /\bvalueLabel\(\s*t\s*,\s*'([^']+)'/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!used.has(match[1])) used.set(match[1], new Set())
      used.get(match[1]).add(name)
    }
  }
}
const localKeys = new Set(Object.keys(PAGE_TEXT))
const missing = []
for (const [key, files] of used) {
  // `valueLabel(t, group, key)` contributes bare group names; a group is valid when any `${group}.` key exists.
  const isGroup = Object.keys(DICTS.zh).some(name => name.startsWith(`${key}.`))
  if (!(key in DICTS.zh) && !(key in DICTS.en) && !localKeys.has(key) && !isGroup) missing.push([key, [...files].join(', ')])
}
// PAGE_TEXT pairs must be bilingual arrays.
const malformed = Object.entries(PAGE_TEXT).filter(([, pair]) => !Array.isArray(pair) || pair.length !== 2).map(([key]) => key)
// Both dictionaries must have the same keys.
const onlyZh = Object.keys(DICTS.zh).filter(key => !(key in DICTS.en))
const onlyEn = Object.keys(DICTS.en).filter(key => !(key in DICTS.zh))

if (missing.length) {
  console.error(`Missing keys (${missing.length}):`)
  for (const [key, files] of missing.sort()) console.error(`  ${key}  ← ${files}`)
}
if (malformed.length) console.error('Malformed PAGE_TEXT pairs:', malformed.join(', '))
if (onlyZh.length) console.error('Keys only in zh:', onlyZh.join(', '))
if (onlyEn.length) console.error('Keys only in en:', onlyEn.join(', '))
const failures = missing.length + malformed.length + onlyZh.length + onlyEn.length
console.log(`${failures ? 'FAIL' : 'OK'}: ${used.size} literal keys used, ${Object.keys(DICTS.zh).length} shared keys, ${localKeys.size} page-local keys`)
process.exit(failures ? 1 : 0)
