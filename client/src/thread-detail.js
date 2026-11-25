/* Thread detail (spec 6.3): the conversation of one Thread — facts, every message with where it went, the Tickets it
   produced, and one way into the evaluation log. The decision ledger (outcome, strength, rule by rule, model opinion)
   belongs to the Eval page alone: printing it here as well made the same records readable in two places and answered
   "why" twice. This page answers "what was said, and where did each message end up". Data: GET engine/thread/:key (host
   increments, contract §4); the page decides which thread is selected. */

import { Icon, shortId } from "./util.js"
import { actorName, readableMarkers, reasonLabel, translate, when } from "./i18n.js"
import { Button, CopyButton, InfoTip, StatusIcon, Tag } from "./controls.js"
import { same, stay, usePanel, usePanelData } from "./api.js"
import { EmptyState, ErrorState, Folded, Hint, KeyValues, MarkdownLite, PageHead, Section, Skeleton, When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { useLiveResource } from "./live-model.js"
import { TicketStatusTag, dispositionView } from "./live-ui.js"
import { Fragment, React, h, useState } from "./react.js"
Object.assign(PAGE_TEXT, {
  'thread.octoConversation': ['Octo 会话', 'Octo conversation'],
  'thread.copyKey': ['复制线程 key', 'Copy thread key'],
  'thread.messageFull': ['展开完整消息（{count} 字）', 'Show full message ({count} chars)'],
  'thread.openEval': ['查看评估记录（{count}）', 'See the evaluation log ({count})'],
  // The message timeline keeps the newest three events in view (the detail used to run 2.8 screens tall); the full
  // history stays one keyboard-reachable click away, exactly like the Ticket detail timeline.
  'thread.timelineShowAll': ['展开全部（{count} 条消息）', 'Show all ({count} messages)'],
  'thread.timelineCollapse': ['收起', 'Collapse'],
  'thread.noSelectionHint': ['选中线程后，这里会展示事实、消息去向与产生的工单。',
    'Pick a Thread to see its facts, where each message went and the Tickets it produced.'],
})

/** Raw thread keys look like `octo:<hex>`; they are identifiers, never a human title (G2). */
export const RAW_THREAD_KEY = /^[a-z][a-z0-9]*:[0-9a-f]{6,}$/i
export const threadChatIdOf = value => { const parts = String(value ?? '').split(':'); return parts.length > 1 ? parts.slice(1).join(':') : '' }

/**
 * Human title for a thread: the stored title when it is a real title, otherwise the watched chat's configured name,
 * otherwise a generic "Octo conversation". The full key is never used here — it only appears in the raw-value fold.
 */
export function threadDisplayTitle(t, thread, threadKey, chatTitles) {
  const raw = typeof thread?.title === 'string' ? thread.title.trim() : ''
  const looksRaw = !raw || raw === threadKey || RAW_THREAD_KEY.test(raw)
  if (!looksRaw) return raw
  const chatId = threadChatIdOf(threadKey || raw)
  const named = chatId && chatTitles ? chatTitles[chatId] : undefined
  return named || pt(t, 'thread.octoConversation')
}

/** Tone for a disposition label; the shape comes from `dispositionView`. */
export function dispositionTone(state) {
  if (state === 'done') return 'success'
  if (state === 'ongoing') return 'info'
  if (state === 'warning') return 'warning'
  if (state === 'error') return 'danger'
  return 'outline'
}

/** One rule row inside the folded evaluation detail. */
export function ThreadRuleRows({ rules }) {
  const { t } = usePanel()
  return h('ul', { className: 'sa-rules' },
    (rules ?? []).map((rule, index) => h('li', { key: rule.id ?? index, className: 'sa-rule' },
      h('div', null,
        h('div', { className: 'sa-rule-title' }, `${rule.id ?? ''} ${rule.name ?? ''}`.trim()),
        rule.reason ? h('div', { className: 'sa-rule-preview' }, rule.reason) : null),
      h(Tag, { tone: rule.matched ? 'success' : 'neutral' }, rule.matched ? pt(t, 'ruleMatched') : pt(t, 'ruleNotMatched')))))
}

/** Message timeline: vertical axis, shape-coded dots, one disposition tag and the decision's own one-line reason per
    message. The reason answers this page's question ("where did it go, and why"); the graded ledger — strength, rule by
    rule, model opinion — is on the Eval page, which the facts section links to. Only the newest three messages render
    until 展开全部 is pressed; the disclosure is a native button, so it is keyboard reachable. */
export const THREAD_TIMELINE_RECENT = 3

/** A raw 32-hex member id is an id, not a name: show a short, readable label and keep the full value in the title. */
export function actorDisplay(t, actor) {
  const name = actorName(t, actor)
  const raw = String(name ?? '')
  if (/^[0-9a-f]{16,}$/i.test(raw)) return { text: shortId(raw, 8), title: raw }
  return { text: name, title: actor?.id && actor.id !== name ? String(actor.id) : undefined }
}

export function ThreadTimeline({ triggers, decisions }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState(false)
  if (!triggers.length) return h(Hint, null, pt(t, 'thread.noMessages'))
  const byId = new Map(decisions.map(decision => [decision.id, decision]))
  const ordered = [...triggers].sort((left, right) => String(left.at ?? '').localeCompare(String(right.at ?? '')))
  const folded = ordered.length > THREAD_TIMELINE_RECENT
  const shown = expanded || !folded ? ordered : ordered.slice(-THREAD_TIMELINE_RECENT)
  return h(Fragment, null,
    h('ol', { className: 'sa-timeline' }, shown.map(trigger => {
      const decision = byId.get(trigger.disposition?.decisionId)
      const view = dispositionView(trigger, decision)
      const actor = actorDisplay(t, trigger.actor)
      return h('li', { key: trigger.id, className: 'sa-event' },
        h('div', { className: 'sa-event-actor' },
          h(StatusIcon, { state: view.state, size: 14 }),
          // The short id is the visible label; the full raw id stays available through a real focusable InfoTip instead
          // of a hover-only title, so keyboard/screen-reader users get it too (A3).
          h('span', null, actor.text),
          actor.title ? h(InfoTip, { text: actor.title }) : null,
          h(When, { at: trigger.at })),
        h('div', { className: 'sa-event-text' }, (() => {
          const message = readableMarkers(t, trigger.text ?? '')
          // Same renderer as the Ticket body: SQL becomes a code block with copy instead of plain clamped text. Long
          // messages start folded so one pasted statement cannot turn the thread into a wall.
          return message.length > 320
            ? h(Folded, { summary: pt(t, 'thread.messageFull', { count: message.length }) }, h(MarkdownLite, { text: message }))
            : h(MarkdownLite, { text: message })
        })()),
        h('div', { className: 'sa-event-foot' },
          h(Tag, { tone: dispositionTone(view.state) }, pt(t, view.labelKey)),
          decision ? h('span', { className: 'sa-hint' }, reasonLabel(t, decision.reason)) : null))
    })),
    folded
      ? h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-8)' } },
        h(Button, { variant: 'ghost', size: 'sm', 'aria-expanded': expanded,
          icon: h(Icon, { name: expanded ? 'chevron-up' : 'chevron-down', size: 14 }),
          onClick: () => setExpanded(value => !value) },
        expanded ? pt(t, 'thread.timelineCollapse') : pt(t, 'thread.timelineShowAll', { count: ordered.length })))
      : null)
}

/**
 * Full thread detail. The prop is `threadKey` (an `id` alias is accepted for callers that came from a route), never
 * `key`: React reserves `key` on elements and would swallow it before the component sees it.
 * Renders PageHead + 事实 → 产生的工单 → 消息时间线; errors keep the last data and offer a retry.
 */
export function ThreadDetail(props) {
  const { t, navigate } = usePanel()
  const model = usePanelData()
  const threadKey = props?.threadKey ?? props?.id
  // Without a key the route would encode `undefined` and poll `engine/thread/undefined` every 30s for a 404.
  const { data, error, loading, reload } = useLiveResource('engine/thread/:key', { key: threadKey }, 30000,
    { enabled: Boolean(threadKey) })
  if (!threadKey) return h(EmptyState, { icon: 'inbox', title: pt(t, 'thread.noSelection'), hint: pt(t, 'thread.noSelectionHint') })
  if (error && !data) return h(ErrorState, { error, onRetry: reload })
  if (loading) return h(Skeleton, { rows: 4 })
  const thread = data?.thread ?? {}
  const triggers = Array.isArray(data?.triggers) ? data.triggers : []
  const decisions = Array.isArray(data?.decisions) ? data.decisions : []
  const tickets = Array.isArray(data?.tickets) ? data.tickets : []
  const factRows = [
    [pt(t, 'thread.fieldSource'), thread.source ?? '—'],
    [pt(t, 'thread.fieldCreated'), thread.createdAt ? h(When, { at: thread.createdAt }) : '—'],
    [pt(t, 'thread.fieldLast'), thread.lastAt ? h(When, { at: thread.lastAt }) : '—'],
    [pt(t, 'thread.fieldTriggers'), String(triggers.length)],
    [pt(t, 'thread.fieldTickets'), String(tickets.length)],
  ]
  const chatTitles = model?.data?.config?.octo?.chatTitles ?? {}
  const openTicket = id => navigate({ page: 'execution', id })
  return h(Fragment, null,
    h(PageHead, { title: threadDisplayTitle(t, thread, threadKey, chatTitles), showBack: props?.showBack !== false,
      meta: h(Fragment, null,
        h('span', { className: 'sa-mono', translate: 'no' }, thread.source ?? ''),
        threadKey ? h(CopyButton, { value: threadKey, label: pt(t, 'thread.copyKey') }) : null,
        h(When, { at: thread.lastAt ?? thread.createdAt })) }),
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    h(Section, { title: pt(t, 'thread.facts') },
      // Label and value stay on one line between 600–960 px (the shared `.sa-kv-inline` rule): the five facts are short
      // values, and the stacked form alone made the compact detail ~90 px taller than it needed to be.
      h(KeyValues, { rows: factRows, className: 'sa-kv-inline' }),
      // One handoff instead of a second copy of the ledger: the Eval page filters itself to this Thread.
      decisions.length
        ? h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-8)' } },
          h(Button, { variant: 'ghost', size: 'sm', icon: h(Icon, { name: 'decision', size: 14 }),
            onClick: () => navigate({ page: 'eval', thread: threadKey }) },
          pt(t, 'thread.openEval', { count: decisions.length })))
        : null),
    tickets.length
      ? h(Section, { title: pt(t, 'thread.tickets'), count: tickets.length },
        h('ul', { className: 'sa-list' }, tickets.map(ticket => h('li', { key: ticket.id, className: 'sa-row' },
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' },
              h(TicketStatusTag, { ticket }),
              h('span', { className: 'sa-ellipsis' }, ticket.title ?? ticket.id)),
            h('div', { className: 'sa-row-actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => openTicket(ticket.id) },
                pt(t, 'thread.openTicket'))))))))
      : h(Section, { title: pt(t, 'thread.tickets') }, h(Hint, null, pt(t, 'thread.noTicketProduced'))),
    h(Section, { title: pt(t, 'thread.timeline'), count: triggers.length }, h(ThreadTimeline, { triggers, decisions })))
}
