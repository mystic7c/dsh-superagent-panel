/* Local UI controls. Markup, class names, focus behavior and token usage follow the Harness panel controls the
   plugin renders beside; the plugin must not import host component packages, so the behavior is reproduced here.
   Signatures are frozen by spec/impl-contract-2026-11.md §3.1; pages only use these props. */

/** Six shape-coded states (contract §3.4). Color never carries the state alone: every state also has a shape. */
const STATUS_STATES = ['done', 'ongoing', 'warning', 'error', 'idle', 'queued']

function controlIcon(icon, size = 16) {
  if (icon === undefined || icon === null) return null
  return typeof icon === 'string' ? h(Icon, { name: icon, size }) : icon
}

/** Shape-coded state icon. `ongoing` spins by default; `spin` forces/forbids the rotation. */
function StatusIcon({ state = 'idle', size = 16, spin, className }) {
  const key = STATUS_STATES.includes(state) ? state : 'idle'
  const spinning = spin === undefined ? key === 'ongoing' : spin
  const shape = key === 'done'
    ? [h('circle', { key: 'c', cx: 12, cy: 12, r: 9 }), h('path', { key: 'p', d: 'M7.8 12.4l2.9 2.9 5.5-6.1' })]
    : key === 'ongoing'
      ? [h('circle', { key: 't', cx: 12, cy: 12, r: 9, opacity: 0.2 }), h('path', { key: 'a', d: 'M12 3a9 9 0 0 1 9 9' })]
      : key === 'warning'
        ? [h('path', { key: 't', d: 'M12 3.8l9.2 16.4H2.8z' }), h('path', { key: 'i', d: 'M12 9.6v4.6' }), h('path', { key: 'd', d: 'M12 17.2h.01' })]
        : key === 'error'
          ? [h('circle', { key: 'c', cx: 12, cy: 12, r: 9 }), h('path', { key: 'x', d: 'M8.8 8.8l6.4 6.4M15.2 8.8l-6.4 6.4' })]
          : key === 'queued'
            ? [h('circle', { key: 'c', cx: 12, cy: 12, r: 9 }), h('path', { key: 'h', d: 'M12 7.2V12l3.2 2.1' })]
            : [h('circle', { key: 'c', cx: 12, cy: 12, r: 9 })]
  return h('svg', { className: cx('sa-status-icon', spinning && 'sa-spin', className), 'data-state': key, width: size, height: size,
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
    'aria-hidden': 'true', focusable: 'false' }, shape)
}

/** Shape + text; the only allowed way to show a state, so WCAG 1.4.1 holds. */
function StatusText({ state = 'idle', children }) {
  return h('span', { className: 'sa-status-text', 'data-state': STATUS_STATES.includes(state) ? state : 'idle' },
    h(StatusIcon, { state, size: 14 }), h('span', { className: 'sa-status-label' }, children))
}

function Button({ variant = 'ghost', size = 'md', icon, className, children, type = 'button', ...rest }) {
  return h('button', { type, className: cx('sa-btn', `sa-btn-${variant}`, `sa-btn-${size}`, className), ...rest },
    icon !== undefined && icon !== null ? h('span', { className: 'sa-btn-icon' }, controlIcon(icon, size === 'sm' ? 14 : 16)) : null,
    children !== undefined && children !== null ? children : null)
}

function IconButton({ icon, label, onClick, disabled, title, variant = 'ghost' }) {
  return h('button', { type: 'button', className: 'sa-icon-btn', 'data-variant': variant,
    'aria-label': label ?? title, title: title ?? label, disabled, onClick }, controlIcon(icon, 16))
}

function Tag({ tone = 'outline', title, children }) {
  return h('span', { className: 'sa-tag', 'data-tone': tone, title }, children)
}

function Pill({ active, onClick, children, title }) {
  return h('button', { type: 'button', className: cx('sa-pill', active && 'sa-pill-active'), 'aria-pressed': active,
    onClick, title }, children)
}

/** Page-level tab bar; clicking the active tab again re-emits it so callers can reset to the tab root. */
function SegmentedTabs({ items, value, onChange, label, className }) {
  const list = useRef(null)
  const [more, setMore] = useState()
  const measure = useCallback(() => {
    const element = list.current
    if (!element) return
    const start = element.scrollLeft > 1
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1
    setMore(start && end ? 'both' : start ? 'start' : end ? 'end' : undefined)
  }, [])
  useEffect(() => {
    measure()
    if (!list.current || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(list.current)
    for (const tab of list.current.children) observer.observe(tab)
    return () => observer.disconnect()
  }, [measure, items.length])
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
  return h('div', { ref: list, role: 'tablist', 'aria-label': label, className: cx('sa-tabs', className), 'data-more': more,
    onScroll: measure, onKeyDown: walk }, items.map(item => h('button', { key: item.value, type: 'button', role: 'tab', id: item.id,
      'aria-controls': item.panelId, 'aria-selected': item.value === value, 'data-value': String(item.value),
      tabIndex: item.value === value ? 0 : -1,
      title: item.title, 'aria-keyshortcuts': item.shortcut,
      className: 'sa-tab', onClick: () => onChange(item.value) }, item.label)))
}

/** Secondary filter pills (contract §5.2): one radio group, arrow keys move and select, roving tabindex. */
function SegmentedControl({ options = [], value, onChange, label, disabled, className }) {
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
  return h('div', { ref: list, role: 'radiogroup', 'aria-label': label, className: cx('sa-segmented', className), onKeyDown },
    options.map(option => h('button', { key: option.value, type: 'button', role: 'radio', 'aria-checked': option.value === value,
      'data-value': String(option.value), title: option.title, disabled: disabled || option.disabled,
      tabIndex: option.value === value || (value === undefined && option === selectable[0]) ? 0 : -1, className: 'sa-segment',
      onClick: () => { if (option.value !== value && !option.disabled && !disabled) onChange(option.value) } }, option.label)))
}

function Input({ icon, className, inputRef, ...rest }) {
  return h('span', { className: cx('sa-input', className) }, icon !== undefined ? h('span', { className: 'sa-input-icon' }, controlIcon(icon, 14)) : null,
    h('input', { ref: inputRef, ...rest }))
}

function Select({ options = [], value, onChange, label, className, disabled }) {
  return h('select', { className: cx('sa-select', className), value: value ?? '', 'aria-label': label, disabled,
    onChange: event => onChange(event.target.value) },
    options.map(option => h('option', { key: option.value, value: option.value, disabled: option.disabled }, option.label)))
}

function Switch({ checked, onChange, label, className, disabled }) {
  return h('button', { type: 'button', role: 'switch', 'aria-checked': checked, 'aria-label': label,
    className: cx('sa-switch', className), disabled, onClick: () => onChange(!checked) }, h('span', { className: 'sa-switch-thumb' }))
}

/** Accessible dialog with focus trapping, Escape/backdrop dismissal, and focus restoration. */
function Modal({ open, onClose, title, closeLabel, description, footer, className, children }) {
  const dialog = useRef(null)
  const close = useRef(onClose)
  close.current = onClose
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
    return () => { document.removeEventListener('keydown', onKeyDown); opener?.focus() }
  }, [open])
  if (!open) return null
  return h('div', { className: 'sa-modal-root', role: 'presentation' },
    h('div', { className: 'sa-modal-mask', 'aria-hidden': 'true', onClick: onClose }),
    h('div', { ref: dialog, className: cx('sa-modal', className), role: 'dialog', 'aria-modal': 'true', 'aria-label': title, tabIndex: -1 },
      h('div', { className: 'sa-modal-header' }, h('h2', null, title),
        h('button', { type: 'button', className: 'sa-modal-close', 'aria-label': closeLabel, onClick: onClose }, h(Icon, { name: 'close', size: 14 }))),
      description ? h('p', { className: 'sa-modal-description' }, description) : null,
      children !== undefined ? h('div', { className: 'sa-modal-body' }, children) : null,
      footer !== undefined ? h('div', { className: 'sa-modal-footer' }, footer) : null))
}

/** Tooltip trigger for hover, keyboard focus and touch; positioned with fixed coordinates so it escapes scroll clips. */
function InfoTip({ text, icon = 'question', warn }) {
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
  return h(Fragment, null,
    h('button', { ref: anchor, type: 'button', className: warn ? 'sa-info sa-info-warn' : 'sa-info', 'aria-label': text,
      onMouseEnter: () => setOpen(true), onMouseLeave: () => setOpen(false), onBlur: () => setOpen(false),
      onFocus: event => { if (event.currentTarget.matches(':focus-visible')) setOpen(true) },
      onKeyDown: event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation() } } }, h(Icon, { name: icon, size: 14 })),
    open ? h('span', { ref: bubble, role: 'tooltip', className: 'sa-tooltip' }, text) : null)
}

/**
 * Lightweight disclosure row: the title leads, the collapsed one-line summary follows it, and the caret closes the
 * row (critique 2026-11-05 #22). The icon prop is kept for callers that need a leading glyph, but the overview no
 * longer passes a gear. `sa-disclosure-*` class hooks stay in place so the stylesheet owns the look.
 */
function DisclosureRow({ icon, title, open, onToggle, collapsedContent, children }) {
  return h('div', { className: 'sa-disclosure', 'data-open': open || undefined },
    h('div', { className: 'sa-disclosure-row', role: 'button', tabIndex: 0, 'aria-expanded': open, onClick: onToggle,
      onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle() } } },
      icon ? h('span', { className: 'sa-disclosure-icon' }, controlIcon(icon, 14)) : null,
      h('span', { className: 'sa-disclosure-title' }, title),
      !open && collapsedContent
        ? h('span', { className: 'sa-disclosure-summary', style: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden',
          textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, collapsedContent)
        : null,
      h('span', { className: 'sa-disclosure-chevron', style: { marginLeft: 'auto' } },
        h(Icon, { name: open ? 'chevron-up' : 'chevron-down' }))),
    open ? children : null)
}

/** ⋯ overflow menu: click outside / Escape close, ↑↓/Home/End move, Enter/Space select. */
function Menu({ label, items = [], iconName = 'more', align = 'end' }) {
  const { t } = usePanel()
  const [open, setOpen] = useState(false)
  const root = useRef(null)
  const trigger = useRef(null)
  const pop = useRef(null)
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
    const nodes = [...(pop.current?.querySelectorAll('[role="menuitem"]') ?? [])].filter(node => !node.disabled)
    nodes[0]?.focus()
  }, [open])
  const choose = (item) => {
    if (item.disabled) return
    setOpen(false)
    trigger.current?.focus()
    if (item.onSelect) item.onSelect()
  }
  const move = (event, delta) => {
    const nodes = [...(pop.current?.querySelectorAll('[role="menuitem"]') ?? [])].filter(node => !node.disabled)
    if (!nodes.length) return
    event.preventDefault()
    const at = nodes.indexOf(document.activeElement)
    nodes[(at + delta + nodes.length) % nodes.length]?.focus()
  }
  const edge = (event, atEnd) => {
    const nodes = [...(pop.current?.querySelectorAll('[role="menuitem"]') ?? [])].filter(node => !node.disabled)
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
  return h('div', { ref: root, className: 'sa-menu' },
    h('button', { ref: trigger, type: 'button', className: 'sa-icon-btn sa-menu-trigger', 'aria-label': label ?? t('moreActions'),
      'aria-haspopup': 'menu', 'aria-expanded': open, title: label ?? t('moreActions'),
      onClick: () => setOpen(value => !value) }, h(Icon, { name: iconName, size: 16 })),
    open ? h('div', { ref: pop, role: 'menu', 'aria-label': label, className: 'sa-menu-pop', 'data-align': align === 'start' ? 'start' : 'end',
      onKeyDown: onPopKeyDown },
      items.map(item => h('button', { key: item.key, type: 'button', role: 'menuitem', disabled: item.disabled,
        title: item.title, className: 'sa-menu-item', onClick: () => choose(item) },
        item.icon !== undefined ? h('span', { className: 'sa-menu-item-icon' }, controlIcon(item.icon, 14)) : null,
        h('span', null, item.label)))) : null)
}

/** Copy a value, then confirm with a short live "copied" state (no modal, no toast). */
function CopyButton({ value, label }) {
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
  return h(Button, { variant: 'ghost', size: 'sm', className: 'sa-copy-btn', 'aria-label': text, title: text,
    icon: h(Icon, { name: copied ? 'check' : 'copy', size: 14 }), onClick: () => { void copy() } },
    copied ? t('copied') : text)
}
