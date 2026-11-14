/* Local UI controls. Markup, class names, focus behavior and token usage follow the Harness panel controls the
   plugin renders beside; the plugin must not import host component packages, so the behavior is reproduced here.
   Signatures are frozen by spec/impl-contract-2026-11.md §3.1; pages only use these props.

   Written in JSX (compiled to the same `h` binding the build prelude defines), so files can migrate one at a time. */

import { Icon, cx } from "./00-util.js"
import { when } from "./06-i18n.js"
import { caller, same, stay, usePanel } from "./15-api.js"
import { React, h, useEffect, useLayoutEffect, useRef, useState } from "./00-react.js"
/** Six shape-coded states (contract §3.4). Color never carries the state alone: every state also has a shape. */
export const STATUS_STATES = ['done', 'ongoing', 'warning', 'error', 'idle', 'queued']

export function controlIcon(icon, size = 16) {
  if (icon === undefined || icon === null) return null
  return typeof icon === 'string' ? <Icon name={icon} size={size} /> : icon
}

/** Shape-coded state icon. `ongoing` spins by default; `spin` forces/forbids the rotation. */
export function StatusIcon({ state = 'idle', size = 16, spin, className }) {
  const key = STATUS_STATES.includes(state) ? state : 'idle'
  const spinning = spin === undefined ? key === 'ongoing' : spin
  const shape = key === 'done'
    ? [<circle key="c" cx={12} cy={12} r={9} />, <path key="p" d="M7.8 12.4l2.9 2.9 5.5-6.1" />]
    : key === 'ongoing'
      ? [<circle key="t" cx={12} cy={12} r={9} opacity={0.2} />, <path key="a" d="M12 3a9 9 0 0 1 9 9" />]
      : key === 'warning'
        ? [<path key="t" d="M12 3.8l9.2 16.4H2.8z" />, <path key="i" d="M12 9.6v4.6" />, <path key="d" d="M12 17.2h.01" />]
        : key === 'error'
          ? [<circle key="c" cx={12} cy={12} r={9} />, <path key="x" d="M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4" />]
          : key === 'queued'
            ? [<circle key="c" cx={12} cy={12} r={9} />, <path key="h" d="M12 7.2V12l3.2 2.1" />]
            : [<circle key="c" cx={12} cy={12} r={9} />]
  return <svg className={cx('sa-status-icon', spinning && 'sa-spin', className)} data-state={key} width={size} height={size}
    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"
    aria-hidden="true" focusable="false">{shape}</svg>
}

/** Shape + text; the only allowed way to show a state, so WCAG 1.4.1 holds. */
export function StatusText({ state = 'idle', children }) {
  return <span className="sa-status-text" data-state={STATUS_STATES.includes(state) ? state : 'idle'}>
    <StatusIcon state={state} size={14} />
    <span className="sa-status-label">{children}</span>
  </span>
}

export function Button({ variant = 'ghost', size = 'md', icon, className, children, type = 'button', ...rest }) {
  return <button type={type} className={cx('sa-btn', `sa-btn-${variant}`, `sa-btn-${size}`, className)} {...rest}>
    {icon !== undefined && icon !== null ? <span className="sa-btn-icon">{controlIcon(icon, size === 'sm' ? 14 : 16)}</span> : null}
    {children !== undefined && children !== null ? children : null}
  </button>
}

export function IconButton({ icon, label, onClick, disabled, title, variant = 'ghost', ...rest }) {
  return <button type="button" className="sa-icon-btn" data-variant={variant}
    aria-label={label ?? title} title={title ?? label} disabled={disabled} onClick={onClick} {...rest}>{controlIcon(icon, 16)}</button>
}

export function Tag({ tone = 'outline', title, children }) {
  return <span className="sa-tag" data-tone={tone} title={title}>{children}</span>
}

/** Page-level tab bar; clicking the active tab again re-emits it so callers can reset to the tab root. */
export function SegmentedTabs({ items, value, onChange, label, className }) {
  const list = useRef(null)
  const walk = (event) => {
    const index = items.findIndex(item => item.value === value)
    const steps = { ArrowRight: index + 1, ArrowLeft: index - 1, Home: 0, End: items.length - 1 }
    const next = steps[event.key]
    if (next === undefined) return
    event.preventDefault()
    const target = items[(next + items.length) % items.length]
    onChange(target.value)
    // Roving tabindex moves with the selection; focus must follow it or the user keeps typing into the old tab
    // (which is now tabindex=-1 and unselected).
    list.current?.querySelector(`button[data-value="${target.value}"]`)?.focus()
  }
  return <div ref={list} role="tablist" aria-label={label} className={cx('sa-tabs', className)} onKeyDown={walk}>
    {items.map(item => <button key={item.value} type="button" role="tab" id={item.id}
      aria-controls={item.panelId} aria-selected={item.value === value} data-value={String(item.value)}
      tabIndex={item.value === value ? 0 : -1}
      title={item.title} aria-keyshortcuts={item.shortcut}
      className="sa-tab" onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>
}

/** Secondary filter pills (contract §5.2): one radio group, arrow keys move and select, roving tabindex. */
export function SegmentedControl({ options = [], value, onChange, label, disabled, className }) {
  const list = useRef(null)
  const selectable = options.filter(option => !option.disabled && !disabled)
  const focusAt = (position) => {
    if (!selectable.length) return
    const option = selectable[(position + selectable.length) % selectable.length]
    const buttons = [...(list.current?.querySelectorAll('button') ?? [])]
    buttons.find(button => button.dataset.value === String(option.value))?.focus()
    if (option.value !== value) onChange(option.value)
  }
  const onKeyDown = (event) => {
    const current = selectable.findIndex(option => option.value === value)
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') { event.preventDefault(); focusAt(current + 1) }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') { event.preventDefault(); focusAt(current - 1) }
    else if (event.key === 'Home') { event.preventDefault(); focusAt(0) }
    else if (event.key === 'End') { event.preventDefault(); focusAt(selectable.length - 1) }
  }
  return <div ref={list} role="radiogroup" aria-label={label} className={cx('sa-segmented', className)} onKeyDown={onKeyDown}>
    {options.map(option => <button key={option.value} type="button" role="radio" aria-checked={option.value === value}
      data-value={String(option.value)} title={option.title} disabled={disabled || option.disabled}
      tabIndex={option.value === value || (value === undefined && option === selectable[0]) ? 0 : -1} className="sa-segment"
      onClick={() => { if (option.value !== value && !option.disabled && !disabled) onChange(option.value) }}>{option.label}
      {option.description ? <span className="sa-sr-only">{option.description}</span> : null}
    </button>)}
  </div>
}

/** Text input. `label` is turned into the accessible name instead of being spread onto the DOM as a stray attribute;
    identifier fields (repo, branch, ref, path) default to spellCheck=false so the browser stops underlining them. */
export function Input({ icon, className, inputRef, label, spellCheck, ...rest }) {
  return <span className={cx('sa-input', className)}>
    {icon !== undefined ? <span className="sa-input-icon">{controlIcon(icon, 14)}</span> : null}
    <input ref={inputRef} spellCheck={spellCheck ?? false} {...rest} aria-label={rest['aria-label'] ?? label} />
  </span>
}

export function Select({ options = [], value, onChange, label, className, disabled }) {
  return <select className={cx('sa-select', className)} value={value ?? ''} aria-label={label} disabled={disabled}
    onChange={event => onChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select>
}

/** Render the track only; the caller wraps it (and its visible text) in a `<label>`, so the text and the track form one
    hit target and a click on either toggles the switch natively. `label` is the accessible name for switch rows whose
    visible text lives outside the label (it may be omitted when the text is inside). */
export function Switch({ checked, onChange, label, className, disabled, inputRef }) {
  return <span className={cx('sa-switch', className)}>
    <input ref={inputRef} type="checkbox" role="switch" className="sa-switch-input"
      checked={Boolean(checked)} disabled={disabled} aria-label={typeof label === 'string' ? label : undefined}
      onChange={event => onChange(event.target.checked)} />
    <span className="sa-switch-track" aria-hidden="true"><span className="sa-switch-thumb" /></span>
  </span>
}

/** Accessible dialog with focus trapping, Escape/backdrop dismissal, and focus restoration. */
export function Modal({ open, onClose, title, closeLabel, description, footer, className, restoreTo, children }) {
  const dialog = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
  // Where focus goes on close. The opener is right for a click-opened dialog; a dialog opened by a keyboard shortcut
  // (Ctrl+K) has no opener, so search points this at its own header button instead of leaving focus on <body>.
  const restore = useRef(restoreTo)
  restore.current = restoreTo
  useEffect(() => {
    if (!open) return
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    dialog.current?.focus()
    const onKeyDown = (event) => {
      if (event.key === 'Escape') { event.stopPropagation(); close.current() }
      else if (event.key === 'Tab' && dialog.current) {
        const focusable = [...dialog.current.querySelectorAll('*')].filter(element =>
          element.matches('a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'))
        const first = focusable[0], last = focusable.at(-1), active = document.activeElement
        if (!first || !dialog.current.contains(active) || active === dialog.current || active === (event.shiftKey ? first : last)) {
          event.preventDefault()
          ;(event.shiftKey ? last : first)?.focus()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      // Focus goes back to whatever opened the dialog. A keyboard-opened dialog has no usable opener (the active
      // element was <body>), so it falls back to the explicit target the caller names — the search trigger for Ctrl+K.
      const fallback = typeof restore.current === 'function' ? restore.current() : restore.current
      const target = opener && opener !== document.body ? opener : fallback
      ;(target instanceof HTMLElement ? target : opener)?.focus()
    }
  }, [open])
  if (!open) return null
  return <div className="sa-modal-root" role="presentation">
    <div className="sa-modal-mask" aria-hidden="true" onClick={onClose} />
    <div ref={dialog} className={cx('sa-modal', className)} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}>
      <div className="sa-modal-header">
        <h2>{title}</h2>
        <button type="button" className="sa-modal-close" aria-label={closeLabel} onClick={onClose}><Icon name="close" size={14} /></button>
      </div>
      {description ? <p className="sa-modal-description">{description}</p> : null}
      {children !== undefined ? <div className="sa-modal-body">{children}</div> : null}
      {footer !== undefined ? <div className="sa-modal-footer">{footer}</div> : null}
    </div>
  </div>
}

/** Tooltip trigger for hover, keyboard focus and touch; positioned with fixed coordinates so it escapes scroll clips. */
export function InfoTip({ text, icon = 'question', warn }) {
  const anchor = useRef(null)
  const bubble = useRef(null)
  const [open, setOpen] = useState(false)
  useLayoutEffect(() => {
    const target = anchor.current, element = bubble.current
    if (!open || !target || !element) return
    const margin = 12, gap = 8
    const a = target.getBoundingClientRect(), b = element.getBoundingClientRect()
    const above = a.top - gap - b.height >= margin
    element.style.left = `${Math.max(margin, Math.min(a.left + a.width / 2 - b.width / 2, window.innerWidth - margin - b.width))}px`
    element.style.top = `${above ? a.top - gap - b.height : a.bottom + gap}px`
  }, [open])
  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    window.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close) }
  }, [open])
  return <>
    <button ref={anchor} type="button" className={warn ? 'sa-info sa-info-warn' : 'sa-info'} aria-label={text}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onBlur={() => setOpen(false)}
      onFocus={event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) }}
      onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation() } }}><Icon name={icon} size={14} /></button>
    {open ? <span ref={bubble} role="tooltip" className="sa-tooltip">{text}</span> : null}
  </>
}

/**
 * Lightweight disclosure row: the title leads, the collapsed one-line summary follows it, and the caret closes the
 * row (critique 2026-11-05 #22). The icon prop is kept for callers that need a leading glyph, but the overview no
 * longer passes a gear. `sa-disclosure-*` class hooks stay in place so the stylesheet owns the look.
 */
export function DisclosureRow({ icon, title, open, onToggle, collapsedContent, children }) {
  return <div className="sa-disclosure" data-open={open || undefined}>
    <button type="button" className="sa-disclosure-row" aria-expanded={open} onClick={onToggle}>
      {icon ? <span className="sa-disclosure-icon">{controlIcon(icon, 14)}</span> : null}
      <span className="sa-disclosure-title">{title}</span>
      {!open && collapsedContent
        ? <span className="sa-disclosure-summary" style={{ flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{collapsedContent}</span>
        : null}
      <span className="sa-disclosure-chevron" style={{ marginLeft: 'auto' }}>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} />
      </span>
    </button>
    {open ? children : null}
  </div>
}

/** Nearest ancestor whose horizontal overflow clips its children (the panel's `.sa-scroll`); the document otherwise. */
export function menuClipBounds(node) {
  const view = node?.ownerDocument?.defaultView
  const computed = (element) => (view?.getComputedStyle ? view.getComputedStyle(element) : undefined)
  let parent = node?.parentElement
  while (parent) {
    const overflowX = String(computed(parent)?.overflowX ?? '')
    if (/auto|scroll|hidden/.test(overflowX)) return parent.getBoundingClientRect()
    parent = parent.parentElement
  }
  const doc = node?.ownerDocument ?? document
  return (doc.scrollingElement ?? doc.documentElement).getBoundingClientRect()
}

export const MENU_ITEM_SELECTOR = '[role="menuitem"], [role="menuitemradio"]'

/** Overflow menu. A label + current value makes it a view picker (`text`); the default trigger is the ⋯ icon.
    Click outside / Escape close, ↑↓/Home/End move, Enter/Space select; `item.checked` turns the item into a radio
    choice (menuitemradio) and marks the current one. */
export function Menu({ label, items = [], iconName = 'more', align = 'end', text }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const [side, setSide] = useState(align === 'start' ? 'start' : 'end')
  const root = useRef(null)
  const trigger = useRef(null)
  const pop = useRef(null)
  // A menu near the left edge of the scroll container used to open leftwards (data-align=end) and lose every label to
  // the container's horizontal clip. Pick the side with room for the measured popover width; the requested side wins
  // when it fits. Measurements are side-independent, so this effect runs once per open and never toggles.
  useLayoutEffect(() => {
    const preferred = align === 'start' ? 'start' : 'end'
    if (!open) { setSide(preferred); return }
    const popEl = pop.current
    const rootEl = root.current
    if (!popEl || !rootEl) return
    const bounds = menuClipBounds(rootEl)
    const triggerRect = rootEl.getBoundingClientRect()
    const width = popEl.getBoundingClientRect().width || 184
    const fitsEnd = triggerRect.right - width >= bounds.left + 8
    const fitsStart = triggerRect.left + width <= bounds.right - 8
    const next = preferred === 'start'
      ? (fitsStart ? 'start' : fitsEnd ? 'end' : 'start')
      : (fitsEnd ? 'end' : fitsStart ? 'start' : 'end')
    setSide(current => current === next ? current : next)
  }, [open, align])
  useEffect(() => {
    if (!open) return
    const onPointer = (event) => { if (!root.current?.contains(event.target)) setOpen(false) }
    const onKey = (event) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', onPointer, true)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onPointer, true); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const nodes = [...(pop.current?.querySelectorAll(MENU_ITEM_SELECTOR) ?? [])].filter(node => !node.disabled)
    nodes[0]?.focus()
  }, [open])
  const choose = (item) => {
    if (item.disabled) return
    setOpen(false)
    trigger.current?.focus()
    if (item.onSelect) item.onSelect()
  }
  const move = (event, delta) => {
    const nodes = [...(pop.current?.querySelectorAll(MENU_ITEM_SELECTOR) ?? [])].filter(node => !node.disabled)
    if (!nodes.length) return
    event.preventDefault()
    const at = nodes.indexOf(document.activeElement)
    nodes[(at + delta + nodes.length) % nodes.length]?.focus()
  }
  const edge = (event, atEnd) => {
    const nodes = [...(pop.current?.querySelectorAll(MENU_ITEM_SELECTOR) ?? [])].filter(node => !node.disabled)
    if (!nodes.length) return
    event.preventDefault()
    ;(atEnd ? nodes.at(-1) : nodes[0])?.focus()
  }
  const onPopKeyDown = (event) => {
    if (event.key === 'ArrowDown') move(event, 1)
    else if (event.key === 'ArrowUp') move(event, -1)
    else if (event.key === 'Home') edge(event, false)
    else if (event.key === 'End') edge(event, true)
    else if (event.key === 'Tab') setOpen(false)
  }
  const triggerNode = text !== undefined
    ? <button ref={trigger} type="button" className="sa-btn sa-btn-outline sa-btn-sm sa-menu-picker"
      aria-label={label ?? t('moreActions')} aria-haspopup="menu" aria-expanded={open} title={label ?? t('moreActions')}
      onClick={() => setOpen(value => !value)}>
      <span className="sa-menu-picker-text">{text}</span>
      <Icon name="chevron-down" size={14} />
    </button>
    : <button ref={trigger} type="button" className="sa-icon-btn sa-menu-trigger" aria-label={label ?? t('moreActions')}
      aria-haspopup="menu" aria-expanded={open} title={label ?? t('moreActions')}
      onClick={() => setOpen(value => !value)}><Icon name={iconName} size={16} /></button>
  return <div ref={root} className="sa-menu">
    {triggerNode}
    {open ? <div ref={pop} role="menu" aria-label={label} className="sa-menu-pop" data-align={side} onKeyDown={onPopKeyDown}>
      {items.map(item => <button key={item.key} type="button" role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
        aria-checked={item.checked === undefined ? undefined : Boolean(item.checked)} disabled={item.disabled}
        title={item.title} className="sa-menu-item" onClick={() => choose(item)}>
        {item.icon !== undefined ? <span className="sa-menu-item-icon">{controlIcon(item.icon, 14)}</span> : null}
        <span className="sa-menu-item-label">
          <span>{item.label}</span>
          {/* A disabled entry explains itself in the menu itself instead of only in a hover title (A3). */}
          {item.note !== undefined ? <span className="sa-menu-item-note">{item.note}</span> : null}
        </span>
        {item.checked ? <span className="sa-menu-item-check"><Icon name="check" size={14} /></span> : null}
      </button>)}
    </div> : null}
  </div>
}

/** Copy a value, then confirm with a short live "copied" state (no modal, no toast). */
export function CopyButton({ value, label }) {
  const { t } = usePanel()
  const [copied, setCopied] = useState(false)
  const timer = useRef()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const text = String(value ?? '')
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
      else {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        document.execCommand('copy')
        area.remove()
      }
      setCopied(true)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), 1600)
    } catch { /* clipboard may be blocked by permissions; the value stays selectable */ }
  }
  const text = label ?? t('copy')
  // The button keeps the action as its accessible name; the copy result is announced through a live region so a
  // screen-reader user hears "copied" without the button (or the row) being renamed under them.
  return <>
    <Button variant="ghost" size="sm" className="sa-copy-btn" aria-label={text} title={text}
      icon={<Icon name={copied ? 'check' : 'copy'} size={14} />} onClick={() => { void copy() }}>
      {copied ? t('copied') : text}
    </Button>
    <span className="sa-sr-only" role="status" aria-live="polite">{copied ? t('copied') : ''}</span>
  </>
}
