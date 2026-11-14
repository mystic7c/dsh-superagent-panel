// Verifies that every literal translation key used by the client fragments exists in the dictionaries.
// Dynamic keys (`t(\`tab.${page}\`)`) are skipped; the check is a safety net, not a proof of coverage.
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = join(root, 'client', 'src')

import { loadClient } from './client-exports.mjs'

// The client modules are ESM now, so they are loaded through the same bundling path as the shipped artifact.
const stubReact = { Component: class {}, Fragment: {}, createContext: () => ({}), createElement: () => null,
  useCallback: () => {}, useContext: () => undefined, useEffect: () => {}, useLayoutEffect: () => {},
  useMemo: () => ({}), useRef: () => ({}), useState: () => [] }
const { DICTS, PAGE_TEXT } = loadClient({ DICTS: '06-i18n.js', PAGE_TEXT: '21-localtext.js' }, { react: stubReact })
const order = readdirSync(src).filter(name => name.endsWith('.js')).sort()
const fragments = order.filter(name => !['06-i18n.js', '21-localtext.js', '00-react.js', 'index.js'].includes(name))
const used = new Map()
const definitions = new Map()
const duplicateKeys = []
for (const name of fragments) {
  const text = readFileSync(join(src, name), 'utf8')
  const patterns = [/\bt\(\s*'([^']+)'/g, /\bpt\(\s*t\s*,\s*'([^']+)'/g, /\bvalueLabel\(\s*t\s*,\s*'([^']+)'/g]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      if (!used.has(match[1])) used.set(match[1], new Set())
      used.get(match[1]).add(name)
    }
  }
  // A conditional key (`pt(t, flag ? 'a' : 'b')`) is invisible to the direct-string patterns above; both branches are
  // real keys, so collect them as well (this is how a missing `repos.enable` pair slipped through before).
  const ternary = [/\bpt\(\s*t\s*,\s*[^?\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g,
    /\bt\(\s*[^?\n]*\?\s*'([^']+)'\s*:\s*'([^']+)'/g]
  for (const pattern of ternary) {
    for (const match of text.matchAll(pattern)) {
      for (const key of [match[1], match[2]]) {
        if (!used.has(key)) used.set(key, new Set())
        used.get(key).add(name)
      }
    }
  }
  // PAGE_TEXT is one flat namespace assembled with Object.assign; a key defined twice silently drops the first
  // definition. Only scan inside the `Object.assign(PAGE_TEXT, { … })` blocks: other `'key': [` maps in the same
  // fragment (status shapes, provider labels) are deliberately separate namespaces.
  const local = new Set()
  let inBlock = false
  for (const line of text.split('\n')) {
    if (!inBlock && /^Object\.assign\(PAGE_TEXT,\s*\{\s*$/.test(line)) { inBlock = true; continue }
    if (inBlock && /^\}\)\s*$/.test(line)) { inBlock = false; continue }
    if (!inBlock) continue
    for (const match of line.matchAll(/^ {2}'([a-z][\w.-]*)':\s*\[/g)) {
      const key = match[1]
      if (local.has(key)) duplicateKeys.push([key, `${name} (defined twice)`])
      else if (definitions.has(key)) duplicateKeys.push([key, `${definitions.get(key)} + ${name}`])
      else { local.add(key); definitions.set(key, name) }
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
if (duplicateKeys.length) {
  console.error(`Duplicate PAGE_TEXT keys (${duplicateKeys.length}):`)
  for (const [key, where] of duplicateKeys.sort()) console.error(`  ${key}  ← ${where}`)
}
if (malformed.length) console.error('Malformed PAGE_TEXT pairs:', malformed.join(', '))
if (onlyZh.length) console.error('Keys only in zh:', onlyZh.join(', '))
if (onlyEn.length) console.error('Keys only in en:', onlyEn.join(', '))
const failures = missing.length + duplicateKeys.length + malformed.length + onlyZh.length + onlyEn.length
console.log(`${failures ? 'FAIL' : 'OK'}: ${used.size} literal keys used, ${Object.keys(DICTS.zh).length} shared keys, ${localKeys.size} page-local keys`)
process.exit(failures ? 1 : 0)
