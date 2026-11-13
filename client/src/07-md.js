/* A small, safe Markdown subset for ticket bodies and messages: headings, lists, paragraphs, bold, inline code and
   http(s) links. Raw HTML is never interpreted; every string ends up as React text. */

const LINK_PATTERN = /(https?:\/\/[^\s<>()]+)/g
function linkify(text) {
  const parts = []
  let last = 0
  for (const match of String(text ?? '').matchAll(LINK_PATTERN)) {
    if (match.index > last) parts.push({ kind: 'text', text: String(text).slice(last, match.index) })
    parts.push({ kind: 'link', text: match[0], url: match[0] })
    last = match.index + match[0].length
  }
  if (last < String(text ?? '').length) parts.push({ kind: 'text', text: String(text).slice(last) })
  return parts.length ? parts : [{ kind: 'text', text: String(text ?? '') }]
}
/** Split inline Markdown (`**bold**`, ``code``, `[text](url)` and bare URLs) into renderable parts. A relative
    target keeps its label as a reference instead of becoming a dead link inside the app shell. */
function inlines(text) {
  const parts = []
  const source = String(text ?? '')
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>()]+)/g
  let last = 0
  for (const match of source.matchAll(pattern)) {
    if (match.index > last) parts.push({ kind: 'text', text: source.slice(last, match.index) })
    if (match[1] !== undefined) parts.push({ kind: 'bold', text: match[1] })
    else if (match[2] !== undefined) parts.push({ kind: 'code', text: match[2] })
    else if (match[3] !== undefined) {
      const target = match[4]
      parts.push(/^https?:\/\//i.test(target) || target.startsWith('#')
        ? { kind: 'link', text: match[3], url: target }
        : { kind: 'ref', text: match[3], url: target })
    }
    else parts.push({ kind: 'link', text: match[5], url: match[5] })
    last = match.index + match[0].length
  }
  if (last < source.length) parts.push({ kind: 'text', text: source.slice(last) })
  if (!parts.length) parts.push({ kind: 'text', text: source })
  return parts
}
/** A pasted SQL/program dump is often un-fenced. Detect it so the transcript stays readable instead of wrapping it as
    prose: long lines plus SQL keywords, or several code marks on multiple lines. */
const CODE_SQL = /\b(SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY|HAVING|INSERT INTO|UPDATE|DELETE FROM|CREATE|ALTER|DROP|BEGIN|DECLARE|COMMIT)\b/i
function looksLikeCode(value) {
  const text = String(value ?? '')
  const lines = text.split('\n')
  const longLine = lines.some(line => line.length > 120)
  const sqlHits = (text.match(/\b(SELECT|FROM|WHERE|JOIN|GROUP BY|ORDER BY|INSERT INTO|UPDATE|DELETE FROM|CREATE|ALTER|DROP|BEGIN|END)\b/gi) ?? []).length
  const marks = [/;\s*$/m, /--\s/, /^\s{2,}\S/m, /[{}]/, /=>|::/].filter(pattern => pattern.test(text)).length
  if (longLine && (sqlHits >= 2 || marks >= 2)) return true
  if (lines.length >= 4 && (sqlHits >= 3 || marks >= 2)) return true
  // A short SQL statement (two or three lines) is still code when it opens with a SQL keyword and carries several.
  if (lines.length >= 2 && /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|BEGIN)\b/i.test(text) && sqlHits >= 2) return true
  return false
}

/** Split a message into headings, ordered/unordered lists, fenced code blocks and paragraphs. */
function markdownBlocks(text) {
  const blocks = []
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  let paragraph = []
  let list
  let fence
  const flush = () => {
    if (!paragraph.length) return
    const text = paragraph.join('\n').trim()
    paragraph = []
    if (looksLikeCode(text)) blocks.push({ kind: 'code', lang: /^\s*SELECT\b/i.test(text) ? 'sql' : '', text })
    else blocks.push({ kind: 'p', text })
  }
  const flushList = () => { if (list) { blocks.push(list); list = undefined } }
  const flushFence = () => {
    if (!fence) return
    blocks.push({ kind: 'code', lang: fence.lang, text: fence.lines.join('\n') })
    fence = undefined
  }
  for (const line of lines) {
    // Fenced code (``` or ~~~) is rendered as a block: ticket bodies carry SQL, worker reports carry tables.
    const mark = /^\s*(`{3,}|~{3,})\s*([\w#+.-]*)\s*$/.exec(line)
    if (mark) {
      if (fence) flushFence()
      else { flush(); flushList(); fence = { lang: mark[2] || '', lines: [] } }
      continue
    }
    if (fence) { fence.lines.push(line); continue }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    // Ordered markers: `1.` and `1)` need a space (so "2.5 倍" stays prose), the Chinese `1、` may follow directly.
    const ordered = /^\s*(\d+)(?:[.)]\s+|、\s*)(.+)$/.exec(line)
    // The level travels with the block so the renderer can keep the document outline instead of flattening every
    // heading into one styled paragraph.
    if (heading) { flush(); flushList(); blocks.push({ kind: 'heading', level: heading[1].length, text: heading[2] }) }
    else if (bullet) { flush(); if (!list || list.ordered) { flushList(); list = { kind: 'list', ordered: false, items: [] } } list.items.push(bullet[1]) }
    else if (ordered) { flush(); if (!list || !list.ordered) { flushList(); list = { kind: 'list', ordered: true, items: [] } } list.items.push(ordered[2]) }
    else if (!line.trim()) { flush(); flushList() }
    else { flushList(); paragraph.push(line) }
  }
  flush()
  flushList()
  flushFence()
  return blocks
}
