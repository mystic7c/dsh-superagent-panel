/* Shared, context-aware widgets: section headers, key/value blocks, safe Markdown, confirmation actions, the page
   head, empty/error/loading states, the save bar, raw-value folding and the glossary. Signatures are frozen by
   spec/impl-contract-2026-11.md §3.2; pages only use these props. */

/** Relative time with an absolute tooltip; the only timestamp renderer pages need. */
function When({ at }) {
  const { t } = usePanel()
  return h('time', { dateTime: at, title: fullTime(at, t.lang) }, when(at, t.lang))
}

function Section({ title, count, icon, hint, action, badge, id, children }) {
  return h('section', { className: 'sa-section', id },
    h('h2', { className: 'sa-section-title' },
      icon ? h('span', { className: 'sa-section-icon' }, controlIcon(icon, 15)) : null,
      h('span', { className: 'sa-section-name' }, title),
      count !== undefined && count !== null
        ? h('span', { className: 'sa-count', 'data-empty': Number(count) === 0 ? 'true' : undefined }, count) : null,
      hint ? h(InfoTip, { text: hint }) : null,
      badge ?? null,
      action ? h('span', { className: 'sa-section-action' }, action) : null),
    children)
}

function Hint({ children }) { return h('p', { className: 'sa-hint' }, children) }

function KeyValues({ rows, className }) {
  return h('dl', { className: className ? `sa-kv ${className}` : 'sa-kv' },
    rows.map(([key, value], index) => h('div', { key: index, style: { display: 'contents' } },
      h('dt', null, key), h('dd', null, value))))
}

function Inlines({ parts, depth = 0 }) {
  return h(Fragment, null, parts.map((part, index) => part.kind === 'bold' ? h('strong', { key: index }, part.text)
    : part.kind === 'code' ? h('code', { key: index, className: 'sa-code', translate: 'no' }, part.text)
    // Link labels can carry their own inline markup (`[`file.sql`](path)`); parse the label instead of printing its
    // backticks literally. An autolinked URL's label is the URL itself, so a second parse yields the same link again:
    // nested rendering therefore stops after one level. Without that stop a bare URL recursed until the heap died.
    : part.kind === 'link' ? depth > 0 ? part.text
      : h('a', { key: index, className: 'sa-inline-link', href: part.url, title: part.url, target: '_blank', rel: 'noopener noreferrer' },
        h(Inlines, { parts: inlines(part.text), depth: depth + 1 }))
    // A repository-relative target (a changed file, a spec doc) has no URL inside the app shell: show the label as
    // reference text with the target in the tooltip instead of linking somewhere that 404s.
    : part.kind === 'ref' ? h('span', { key: index, className: 'sa-code', title: part.url, translate: 'no' },
      depth > 0 ? part.text : h(Inlines, { parts: inlines(part.text), depth: depth + 1 }))
    : h(Fragment, { key: index }, part.text)))
}

/** Render a safe Markdown subset; raw HTML is shown as text. Fenced code gets its own block with a copy control. */
function MarkdownLite({ text }) {
  return h('div', { className: 'sa-md' }, markdownBlocks(text).map((block, index) => {
    if (block.kind === 'code') {
      return h('div', { key: index, className: 'sa-md-code' },
        h('div', { className: 'sa-md-code-head' },
          h('span', { className: 'sa-md-code-lang' }, block.lang || 'code'),
          h(CopyButton, { value: block.text })),
        h('pre', { className: 'sa-md-pre', translate: 'no' }, block.text))
    }
    if (block.kind === 'list') return h(block.ordered ? 'ol' : 'ul', { key: index },
      block.items.map((item, at) => h('li', { key: at }, h(Inlines, { parts: inlines(item) }))))
    // Markdown headings keep their rank in the document outline: the page already owns h2, so `#`/`##` land on h3 and
    // deeper levels step down from there instead of every heading collapsing into a styled paragraph.
    if (block.kind === 'heading') {
      return h(`h${Math.min(6, 2 + (block.level ?? 2))}`, { key: index, className: 'sa-md-heading' }, h(Inlines, { parts: inlines(block.text) }))
    }
    return h('p', { key: index }, h(Inlines, { parts: inlines(block.text) }))
  }))
}

function ClampText({ text, limit = 480, lines = 8 }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const long = String(text ?? '').length > limit || String(text ?? '').split('\n').length > lines
  return h(Fragment, null,
    h('div', { className: long && !open ? `sa-event-text sa-clamp-${lines}` : 'sa-event-text' },
      h(Inlines, { parts: inlines(readableMarkers(t, text)) })),
    long ? h('button', { type: 'button', className: 'sa-textlink sa-more', 'aria-expanded': open,
      onClick: () => setOpen(!open) }, open ? t('collapse') : t('expand')) : null)
}

/** Destructive/irreversible action behind a confirmation dialog that states the consequence. `confirmLabel` names the
    action on the button ("Publish MR", "Delete branch and ignore"); the generic "Confirm" is only the fallback. */
function ConfirmButton({ label, title, message, confirmLabel, onConfirm, variant = 'ghost', icon }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const confirm = useAction(onConfirm)
  return h(Fragment, null,
    h(Button, { variant, size: 'sm', icon: controlIcon(icon, 14), onClick: () => setOpen(true) }, label),
    h(Modal, { open, onClose: () => setOpen(false), title, closeLabel: t('close'), description: message,
      footer: h(Fragment, null,
        h(Button, { variant: 'ghost', onClick: () => setOpen(false) }, t('cancel')),
        h(Button, { variant: variant === 'danger' ? 'danger' : 'primary', disabled: confirm.busy,
          onClick: () => { void confirm.run().then(done => { if (done) setOpen(false) }) } }, confirmLabel ?? t('confirm'))) }))
}

/** External link; new tab only for links that leave this origin. Anything that is not a plain http(s) URL
    (javascript:, data:, vbscript:, …) renders as inert text: URLs here come from operator config and GitLab/Octo
    payloads, so an unchecked scheme would be a stored-XSS sink. */
function ExternalLink({ href, children, icon = 'external' }) {
  const safe = safeHttpUrl(href)
  if (!safe) return h('span', { className: 'sa-inline-link' }, children)
  const external = isExternal(safe)
  return h('a', { className: 'sa-inline-link', href: safe, target: external ? '_blank' : undefined, rel: external ? 'noopener noreferrer' : undefined },
    icon ? h(Icon, { name: icon, size: 13 }) : null, icon ? ' ' : null, children)
}

/** Legacy loading/error line; new code uses ErrorState/Skeleton. */
function LoadState({ error, loading }) {
  const { t } = usePanel()
  if (error) return h('p', { className: 'sa-error', role: 'alert' }, errorText(error))
  return loading ? h(Hint, null, t('loading')) : null
}

/** Detail-page head: back (route history), 20/600 title, meta line and actions. `showBack` is false for a detail
    rendered as a master-detail pane, where there is no list route to return to. */
function PageHead({ title, meta, actions, showBack = true, headRef }) {
  const { back, backLabel, t } = usePanel()
  return h('div', { ref: headRef, className: 'sa-page-head' },
    showBack ? h('div', { className: 'sa-page-head-top' },
      h(Button, { variant: 'ghost', size: 'sm', icon: h(Icon, { name: 'chevron-left', size: 14 }), onClick: back }, backLabel || t('back'))) : null,
    h('div', { className: 'sa-page-head-main' },
      h('h2', { className: 'sa-page-head-title' }, title),
      actions ? h('div', { className: 'sa-page-head-actions' }, actions) : null),
    meta ? h('div', { className: 'sa-page-head-meta' }, meta) : null)
}

/** Positive empty state: one teaching sentence plus one next step. `state` ('done') tints it as a success message. */
function EmptyState({ icon = 'inbox', title, hint, action, state }) {
  return h('div', { className: 'sa-empty', 'data-state': state },
    icon ? h('span', { className: 'sa-empty-icon' },
      state ? h(StatusIcon, { state, size: 20, spin: false }) : h(Icon, { name: icon, size: 20 })) : null,
    h('div', { className: 'sa-empty-body' },
      h('p', { className: 'sa-empty-title' }, title),
      hint ? h('p', { className: 'sa-empty-hint' }, hint) : null),
    action ? h('div', { className: 'sa-empty-action' }, action) : null)
}

/** Plain-language error with a retry and a folded raw value (never a bare stack trace). */
function ErrorState({ error, onRetry }) {
  const { t } = usePanel()
  const message = error instanceof Error ? error.message : String(error ?? '')
  const raw = error instanceof Error ? (error.stack || error.message) : message
  return h('div', { className: 'sa-error-state', role: 'alert' },
    h(StatusIcon, { state: 'error', size: 16 }),
    h('div', { className: 'sa-error-state-body' },
      h('p', { className: 'sa-error-state-title' }, message || t('unknown')),
      h('p', { className: 'sa-error-state-hint' }, t('errorHint')),
      raw && raw !== message ? h(Folded, { summary: t('rawError') }, h('pre', { className: 'sa-pre', translate: 'no' }, raw)) : null),
    onRetry ? h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'refresh', size: 14 }), onClick: onRetry }, t('retry')) : null)
}

const SKELETON_WIDTHS = ['100%', '92%', '78%', '86%', '64%', '72%']
/** Section-level loading skeleton; polled data keeps its old render, so this is first paint only. */
function Skeleton({ rows = 3, variant = 'section' }) {
  const { t } = usePanel()
  const count = Math.max(1, Math.min(12, Number(rows) || 3))
  return h('div', { className: cx('sa-skeleton', `sa-skeleton-${variant}`), role: 'status', 'aria-busy': 'true', 'aria-label': t('loading') },
    variant === 'section' ? h('div', { className: 'sa-skeleton-line sa-skeleton-title', style: { width: '34%' } }) : null,
    Array.from({ length: count }, (_, index) => h('div', { key: index, className: 'sa-skeleton-line',
      style: { width: SKELETON_WIDTHS[index % SKELETON_WIDTHS.length] } })))
}

/** Block-level save bar: invisible while clean, explicit while dirty/saving/saved/error (contract §6.6). */
function SaveBar({ state, savedAt, error, onSave, onRetry, onDiscard, dirty }) {
  const { t } = usePanel()
  const current = state ?? (dirty ? 'dirty' : 'idle')
  if (current === 'idle') return null
  const retry = onRetry ?? onSave
  const savedTime = hhmmss(savedAt, t.lang) || (savedAt === undefined || savedAt === null ? '' : String(savedAt))
  const message = current === 'saving' ? t('saving')
    : current === 'saved' ? (savedTime ? t('savebarSavedAt', { time: savedTime }) : t('saved'))
      : current === 'error' ? t('savebarFailed', { error: errorText(error) })
        : t('savebarDirty')
  const actions = current === 'dirty'
    ? [onSave ? h(Button, { key: 'save', variant: 'primary', size: 'sm', onClick: onSave }, t('save')) : null,
      onDiscard ? h(Button, { key: 'discard', variant: 'ghost', size: 'sm', onClick: onDiscard }, t('discard')) : null]
    : current === 'saving'
      ? [h(Button, { key: 'saving', variant: 'primary', size: 'sm', disabled: true, icon: h(StatusIcon, { state: 'ongoing', size: 14 }) }, t('saving'))]
      : current === 'error'
        ? [retry ? h(Button, { key: 'retry', variant: 'outline', size: 'sm', icon: h(Icon, { name: 'refresh', size: 14 }), onClick: retry }, t('retry')) : null,
          onDiscard ? h(Button, { key: 'discard', variant: 'ghost', size: 'sm', onClick: onDiscard }, t('discard')) : null]
        : []
  return h('div', { className: 'sa-savebar', 'data-state': current },
    h('span', { className: 'sa-savebar-text', role: 'status', 'aria-live': 'polite' }, message),
    h('div', { className: 'sa-savebar-actions' }, actions))
}

/** Monospace raw value (ids, paths, gate codes, JSON): copyable and folded by default. */
function RawValue({ label, text, json, openLabel }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const value = json === undefined || json === null ? String(text ?? '') : typeof json === 'string' ? json : JSON.stringify(json, null, 2)
  if (!value) return null
  const firstLine = value.split('\n')[0]
  return h('div', { className: 'sa-raw' },
    h('div', { className: 'sa-raw-head' },
      label ? h('span', { className: 'sa-raw-label' }, label) : null,
      h('code', { className: 'sa-mono sa-raw-preview', title: firstLine }, firstLine),
      h(CopyButton, { value, label: t('copy') }),
      h(Button, { variant: 'ghost', size: 'sm', 'aria-expanded': open, onClick: () => setOpen(!open) },
        open ? t('collapse') : (openLabel ?? t('expand')))),
    open ? h('pre', { className: 'sa-pre sa-raw-body', translate: 'no' }, value) : null)
}

/** Lightweight disclosure row for secondary content. */
function Folded({ summary, children }) {
  return h('details', { className: 'sa-folded' },
    h('summary', { className: 'sa-folded-summary' }, h(Icon, { name: 'chevron-right', size: 14 }), h('span', null, summary)),
    h('div', { className: 'sa-folded-body' }, children))
}

/** Page-head ? button: renders the glossary + status legend dialog. */
function GlossaryButton() {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  return h(Fragment, null,
    h(IconButton, { icon: h(Icon, { name: 'question', size: 16 }), label: t('glossary'), title: t('glossary'),
      variant: 'outline', onClick: () => setOpen(true) }),
    h(GlossaryModal, { open, onClose: () => setOpen(false) }))
}

/** Glossary + state legend, all content from 06-i18n.js (GLOSSARY / GLOSSARY_VALUES / term.* / meaning.* / legend.*). */
function GlossaryModal({ open, onClose }) {
  const { t } = usePanel()
  return h(Modal, { open, onClose, title: t('glossary'), closeLabel: t('close'), description: t('glossaryIntro'),
    className: 'sa-glossary-modal' },
    h('section', { className: 'sa-glossary-section' },
      h('h3', { className: 'sa-glossary-heading' }, t('legendTitle')),
      h('ul', { className: 'sa-legend' }, STATUS_STATES.map(state =>
        h('li', { key: state }, h(StatusText, { state }, t(`legend.${state}`)))))),
    h('section', { className: 'sa-glossary-section' },
      h('table', { className: 'sa-glossary' },
        h('thead', null, h('tr', null,
          h('th', null, t('glossaryChinese')), h('th', null, t('glossaryEnglish')), h('th', null, t('glossaryMeaning')))),
        h('tbody', null, Object.entries(GLOSSARY).flatMap(([group, keys]) => [
          h('tr', { key: `group-${group}`, className: 'sa-glossary-group' }, h('th', { colSpan: 3 }, t(`glossaryGroup.${group}`))),
          ...keys.map(term => h('tr', { key: term },
            h('td', null, translate('zh', `term.${term}`)),
            h('td', null, translate('en', `term.${term}`)),
            h('td', null, t(`meaning.${term}`)))),
        ])))),
    h('section', { className: 'sa-glossary-section' },
      h('h3', { className: 'sa-glossary-heading' }, t('glossaryValues')),
      ...Object.entries(GLOSSARY_VALUES).map(([group, keys]) => h('div', { key: group, className: 'sa-glossary-values' },
        h('span', { className: 'sa-glossary-values-label' }, t(`term.${group}`)),
        h('span', { className: 'sa-glossary-values-list' },
          keys.map(key => h(Tag, { key, tone: 'quiet', title: translate('en', key) }, translate(t.lang, key))))))))
}
