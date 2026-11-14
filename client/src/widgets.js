/* Shared, context-aware widgets: section headers, key/value blocks, safe Markdown, confirmation actions, the page
   head, empty/error/loading states, the save bar, raw-value folding and the glossary. Signatures are frozen by
   spec/impl-contract-2026-11.md §3.2; pages only use these props.

   Written in JSX (compiled to the same `h` binding the build prelude defines). */

import { Icon, cx, hhmmss, isExternal, safeHttpUrl } from "./util.js"
import { GLOSSARY, GLOSSARY_VALUES, errorText, fullTime, readableMarkers, translate, when } from "./i18n.js"
import { inlines, markdownBlocks } from "./markdown.js"
import { Button, CopyButton, IconButton, InfoTip, Modal, STATUS_STATES, StatusIcon, StatusText, Tag, controlIcon } from "./controls.js"
import { same, useAction, usePanel } from "./api.js"
import { Fragment, React, h, useState } from "./react.js"
/** Relative time with an absolute tooltip; the only timestamp renderer pages need. */
export function When({ at }) {
  const { t } = usePanel()
  return <time dateTime={at} title={fullTime(at, t.lang)}>{when(at, t.lang)}</time>
}

export function Section({ title, count, icon, hint, action, badge, id, children }) {
  return <section className="sa-section" id={id}>
    <h2 className="sa-section-title">
      {icon ? <span className="sa-section-icon">{controlIcon(icon, 15)}</span> : null}
      <span className="sa-section-name">{title}</span>
      {count !== undefined && count !== null
        ? <span className="sa-count" data-empty={Number(count) === 0 ? 'true' : undefined}>{count}</span> : null}
      {hint ? <InfoTip text={hint} /> : null}
      {badge ?? null}
      {action ? <span className="sa-section-action">{action}</span> : null}
    </h2>
    {children}
  </section>
}

export function Hint({ children }) { return <p className="sa-hint">{children}</p> }

export function KeyValues({ rows, className }) {
  return <dl className={className ? `sa-kv ${className}` : 'sa-kv'}>
    {rows.map(([key, value], index) => <div key={index} style={{ display: 'contents' }}>
      <dt>{key}</dt><dd>{value}</dd>
    </div>)}
  </dl>
}

export function Inlines({ parts, depth = 0 }) {
  return <>{parts.map((part, index) => part.kind === 'bold' ? <strong key={index}>{part.text}</strong>
    : part.kind === 'code' ? <code key={index} className="sa-code" translate="no">{part.text}</code>
    // Link labels can carry their own inline markup (`[`file.sql`](path)`); parse the label instead of printing its
    // backticks literally. An autolinked URL's label is the URL itself, so a second parse yields the same link again:
    // nested rendering therefore stops after one level. Without that stop a bare URL recursed until the heap died.
    : part.kind === 'link' ? depth > 0 ? part.text
      : <a key={index} className="sa-inline-link" href={part.url} title={part.url} target="_blank" rel="noopener noreferrer">
        <Inlines parts={inlines(part.text)} depth={depth + 1} />
      </a>
    // A repository-relative target (a changed file, a spec doc) has no URL inside the app shell: show the label as
    // reference text with the target in the tooltip instead of linking somewhere that 404s.
    : part.kind === 'ref' ? <span key={index} className="sa-code" title={part.url} translate="no">
      {depth > 0 ? part.text : <Inlines parts={inlines(part.text)} depth={depth + 1} />}
    </span>
    : <Fragment key={index}>{part.text}</Fragment>)}</>
}

/** Render a safe Markdown subset; raw HTML is shown as text. Fenced code gets its own block with a copy control. */
export function MarkdownLite({ text }) {
  return <div className="sa-md">{markdownBlocks(text).map((block, index) => {
    if (block.kind === 'code') {
      return <div key={index} className="sa-md-code">
        <div className="sa-md-code-head">
          <span className="sa-md-code-lang">{block.lang || 'code'}</span>
          <CopyButton value={block.text} />
        </div>
        <pre className="sa-md-pre" translate="no">{block.text}</pre>
      </div>
    }
    if (block.kind === 'list') {
      const List = block.ordered ? 'ol' : 'ul'
      return <List key={index}>
        {block.items.map((item, at) => <li key={at}><Inlines parts={inlines(item)} /></li>)}
      </List>
    }
    // Markdown headings keep their rank in the document outline: the page already owns h2, so `#`/`##` land on h3 and
    // deeper levels step down from there instead of every heading collapsing into a styled paragraph.
    if (block.kind === 'heading') {
      const Heading = `h${Math.min(6, 2 + (block.level ?? 2))}`
      return <Heading key={index} className="sa-md-heading"><Inlines parts={inlines(block.text)} /></Heading>
    }
    return <p key={index}><Inlines parts={inlines(block.text)} /></p>
  })}</div>
}

export function ClampText({ text, limit = 480, lines = 8 }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const long = String(text ?? '').length > limit || String(text ?? '').split('\n').length > lines
  return <>
    <div className={long && !open ? `sa-event-text sa-clamp-${lines}` : 'sa-event-text'}>
      <Inlines parts={inlines(readableMarkers(t, text))} />
    </div>
    {long ? <button type="button" className="sa-textlink sa-more" aria-expanded={open}
      onClick={() => setOpen(!open)}>{open ? t('collapse') : t('expand')}</button> : null}
  </>
}

/** Destructive/irreversible action behind a confirmation dialog that states the consequence. `confirmLabel` names the
    action on the button ("Publish MR", "Delete branch and ignore"); the generic "Confirm" is only the fallback. */
export function ConfirmButton({ label, title, message, confirmLabel, onConfirm, variant = 'ghost', icon }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const confirm = useAction(onConfirm)
  return <>
    <Button variant={variant} size="sm" icon={controlIcon(icon, 14)} onClick={() => setOpen(true)}>{label}</Button>
    <Modal open={open} onClose={() => setOpen(false)} title={title} closeLabel={t('close')} description={message}
      footer={<>
        <Button variant="ghost" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant={variant === 'danger' ? 'danger' : 'primary'} disabled={confirm.busy}
          onClick={() => { void confirm.run().then(done => { if (done) setOpen(false) }) }}>{confirmLabel ?? t('confirm')}</Button>
      </>} />
  </>
}

/** External link; new tab only for links that leave this origin. Anything that is not a plain http(s) URL
    (javascript:, data:, vbscript:, …) renders as inert text: URLs here come from operator config and GitLab/Octo
    payloads, so an unchecked scheme would be a stored-XSS sink. */
export function ExternalLink({ href, children, icon = 'external' }) {
  const safe = safeHttpUrl(href)
  if (!safe) return <span className="sa-inline-link">{children}</span>
  const external = isExternal(safe)
  return <a className="sa-inline-link" href={safe} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
    {icon ? <Icon name={icon} size={13} /> : null}{icon ? ' ' : null}{children}
  </a>
}

/** Legacy loading/error line; new code uses ErrorState/Skeleton. */
export function LoadState({ error, loading }) {
  const { t } = usePanel()
  if (error) return <p className="sa-error" role="alert">{errorText(error)}</p>
  return loading ? <Hint>{t('loading')}</Hint> : null
}

/** Detail-page head: back (route history), 20/600 title, meta line and actions. `showBack` is false for a detail
    rendered as a master-detail pane, where there is no list route to return to. */
export function PageHead({ title, meta, actions, showBack = true, headRef }) {
  const { back, backLabel, t } = usePanel()
  return <div ref={headRef} className="sa-page-head">
    {showBack ? <div className="sa-page-head-top">
      <Button variant="ghost" size="sm" icon={<Icon name="chevron-left" size={14} />} onClick={back}>{backLabel || t('back')}</Button>
    </div> : null}
    <div className="sa-page-head-main">
      <h2 className="sa-page-head-title">{title}</h2>
      {actions ? <div className="sa-page-head-actions">{actions}</div> : null}
    </div>
    {meta ? <div className="sa-page-head-meta">{meta}</div> : null}
  </div>
}

/** Positive empty state: one teaching sentence plus one next step. `state` ('done') tints it as a success message. */
export function EmptyState({ icon = 'inbox', title, hint, action, state }) {
  return <div className="sa-empty" data-state={state}>
    {icon ? <span className="sa-empty-icon">
      {state ? <StatusIcon state={state} size={20} spin={false} /> : <Icon name={icon} size={20} />}
    </span> : null}
    <div className="sa-empty-body">
      <p className="sa-empty-title">{title}</p>
      {hint ? <p className="sa-empty-hint">{hint}</p> : null}
    </div>
    {action ? <div className="sa-empty-action">{action}</div> : null}
  </div>
}

/** Plain-language error with a retry and a folded raw value (never a bare stack trace). */
export function ErrorState({ error, onRetry }) {
  const { t } = usePanel()
  const message = error instanceof Error ? error.message : String(error ?? '')
  const raw = error instanceof Error ? (error.stack || error.message) : message
  return <div className="sa-error-state" role="alert">
    <StatusIcon state="error" size={16} />
    <div className="sa-error-state-body">
      <p className="sa-error-state-title">{message || t('unknown')}</p>
      <p className="sa-error-state-hint">{t('errorHint')}</p>
      {raw && raw !== message ? <Folded summary={t('rawError')}><pre className="sa-pre" translate="no">{raw}</pre></Folded> : null}
    </div>
    {onRetry ? <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} onClick={onRetry}>{t('retry')}</Button> : null}
  </div>
}

export const SKELETON_WIDTHS = ['100%', '92%', '78%', '86%', '64%', '72%']
/** Section-level loading skeleton; polled data keeps its old render, so this is first paint only. */
export function Skeleton({ rows = 3, variant = 'section' }) {
  const { t } = usePanel()
  const count = Math.max(1, Math.min(12, Number(rows) || 3))
  return <div className={cx('sa-skeleton', `sa-skeleton-${variant}`)} role="status" aria-busy="true" aria-label={t('loading')}>
    {variant === 'section' ? <div className="sa-skeleton-line sa-skeleton-title" style={{ width: '34%' }} /> : null}
    {Array.from({ length: count }, (_, index) => <div key={index} className="sa-skeleton-line"
      style={{ width: SKELETON_WIDTHS[index % SKELETON_WIDTHS.length] }} />)}
  </div>
}

/** Block-level save bar: invisible while clean, explicit while dirty/saving/saved/error (contract §6.6). */
export function SaveBar({ state, savedAt, error, onSave, onRetry, onDiscard, dirty }) {
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
    ? [onSave ? <Button key="save" variant="primary" size="sm" onClick={onSave}>{t('save')}</Button> : null,
      onDiscard ? <Button key="discard" variant="ghost" size="sm" onClick={onDiscard}>{t('discard')}</Button> : null]
    : current === 'saving'
      ? [<Button key="saving" variant="primary" size="sm" disabled icon={<StatusIcon state="ongoing" size={14} />}>{t('saving')}</Button>]
      : current === 'error'
        ? [retry ? <Button key="retry" variant="outline" size="sm" icon={<Icon name="refresh" size={14} />} onClick={retry}>{t('retry')}</Button> : null,
          onDiscard ? <Button key="discard" variant="ghost" size="sm" onClick={onDiscard}>{t('discard')}</Button> : null]
        : []
  return <div className="sa-savebar" data-state={current}>
    <span className="sa-savebar-text" role="status" aria-live="polite">{message}</span>
    <div className="sa-savebar-actions">{actions}</div>
  </div>
}

/** Monospace raw value (ids, paths, gate codes, JSON): copyable and folded by default. */
export function RawValue({ label, text, json, openLabel }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const value = json === undefined || json === null ? String(text ?? '') : typeof json === 'string' ? json : JSON.stringify(json, null, 2)
  if (!value) return null
  const firstLine = value.split('\n')[0]
  return <div className="sa-raw">
    <div className="sa-raw-head">
      {label ? <span className="sa-raw-label">{label}</span> : null}
      <code className="sa-mono sa-raw-preview" title={firstLine}>{firstLine}</code>
      <CopyButton value={value} label={t('copy')} />
      <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t('collapse') : (openLabel ?? t('expand'))}
      </Button>
    </div>
    {open ? <pre className="sa-pre sa-raw-body" translate="no">{value}</pre> : null}
  </div>
}

/** Lightweight disclosure row for secondary content. */
export function Folded({ summary, children }) {
  return <details className="sa-folded">
    <summary className="sa-folded-summary"><Icon name="chevron-right" size={14} /><span>{summary}</span></summary>
    <div className="sa-folded-body">{children}</div>
  </details>
}

/** Page-head ? button: renders the glossary + status legend dialog. */
export function GlossaryButton() {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  return <>
    <IconButton icon={<Icon name="question" size={16} />} label={t('glossary')} title={t('glossary')}
      variant="outline" onClick={() => setOpen(true)} />
    <GlossaryModal open={open} onClose={() => setOpen(false)} />
  </>
}

/** Glossary + state legend, all content from i18n.js (GLOSSARY / GLOSSARY_VALUES / term.* / meaning.* / legend.*). */
export function GlossaryModal({ open, onClose }) {
  const { t } = usePanel()
  return <Modal open={open} onClose={onClose} title={t('glossary')} closeLabel={t('close')} description={t('glossaryIntro')}
    className="sa-glossary-modal">
    <section className="sa-glossary-section">
      <h3 className="sa-glossary-heading">{t('legendTitle')}</h3>
      <ul className="sa-legend">
        {STATUS_STATES.map(state => <li key={state}><StatusText state={state}>{t(`legend.${state}`)}</StatusText></li>)}
      </ul>
    </section>
    <section className="sa-glossary-section">
      <table className="sa-glossary">
        <thead>
          <tr>
            <th>{t('glossaryChinese')}</th>
            <th>{t('glossaryEnglish')}</th>
            <th>{t('glossaryMeaning')}</th>
          </tr>
        </thead>
        <tbody>
          {Object.entries(GLOSSARY).flatMap(([group, keys]) => [
            <tr key={`group-${group}`} className="sa-glossary-group"><th colSpan={3}>{t(`glossaryGroup.${group}`)}</th></tr>,
            ...keys.map(term => <tr key={term}>
              <td>{translate('zh', `term.${term}`)}</td>
              <td>{translate('en', `term.${term}`)}</td>
              <td>{t(`meaning.${term}`)}</td>
            </tr>),
          ])}
        </tbody>
      </table>
    </section>
    <section className="sa-glossary-section">
      <h3 className="sa-glossary-heading">{t('glossaryValues')}</h3>
      {Object.entries(GLOSSARY_VALUES).map(([group, keys]) => <div key={group} className="sa-glossary-values">
        <span className="sa-glossary-values-label">{t(`term.${group}`)}</span>
        <span className="sa-glossary-values-list">
          {keys.map(key => <Tag key={key} tone="quiet" title={translate('en', key)}>{translate(t.lang, key)}</Tag>)}
        </span>
      </div>)}
    </section>
  </Modal>
}
