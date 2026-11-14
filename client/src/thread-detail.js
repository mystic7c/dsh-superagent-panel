/* Thread detail (spec 6.3): the three-stage reading — facts → evaluation → timeline. 评估过程 now also carries the
   latest decision (its reason and Ticket jump) and folds consecutive identical decisions into one row, while the
   message timeline shows only where each message went (queued / evaluating / delivered / fanout / filtered) — the same
   outcome is no longer printed a third time. Data: GET engine/thread/:key (host increments, contract §4); the page
   decides which thread is selected. */

import { Icon, shortId } from "./util.js"
import { actorName, readableMarkers, reasonLabel, translate, when } from "./i18n.js"
import { Button, CopyButton, InfoTip, StatusIcon, Tag } from "./controls.js"
import { same, stay, usePanel, usePanelData } from "./api.js"
import { EmptyState, ErrorState, Folded, Hint, KeyValues, MarkdownLite, PageHead, RawValue, Section, Skeleton, When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { useLiveResource } from "./live-model.js"
import { TicketStatusTag, decisionKindView, dispositionView } from "./live-ui.js"
import { Fragment, React, h, useState } from "./react.js"
Object.assign(PAGE_TEXT, {
  'thread.octoConversation': ['Octo 会话', 'Octo conversation'],
  'thread.copyKey': ['复制线程 key', 'Copy thread key'],
  'thread.messageFull': ['展开完整消息（{count} 字）', 'Show full message ({count} chars)'],
  // 评估过程 collapses runs of identical decisions; a lone decision keeps its old row. The count in 展开全部 is the
  // number of runs, not of decisions, so the button never promises rows that are already on screen.
  'thread.evalShowAll': ['展开全部（{count}）', 'Show all ({count})'],
  'thread.evalCollapse': ['收起', 'Collapse'],
  'thread.groupDetail': ['组内 {count} 条：时间与规则', 'All {count} in this run: time and rules'],
  'thread.groupTickets': ['产生的其他工单（{count}）', 'Other produced Tickets ({count})'],
  // The message timeline keeps the newest three events in view (the detail used to run 2.8 screens tall); the full
  // history stays one keyboard-reachable click away, exactly like the Ticket detail timeline.
  'thread.timelineShowAll': ['展开全部（{count} 条消息）', 'Show all ({count} messages)'],
  'thread.timelineCollapse': ['收起', 'Collapse'],
  // The standalone 决定 section is gone, so the pane's empty hint no longer promises one.
  'thread.noSelectionHint': ['选中线程后，这里会展示事实、评估过程与消息去向。',
    'Pick a Thread to see its facts, evaluation and where each message went.'],
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

/** `decision.reason` is a Reason[] but old state can hold one Reason or a bare string; normalise before reading it. */
export function threadReasons(decision) {
  const reason = decision?.reason
  return reason === undefined || reason === null ? [] : Array.isArray(reason) ? reason : [reason]
}

/** The first reason code of a decision — the key a run of identical decisions shares. */
export function threadFirstReasonCode(decision) {
  const [first] = threadReasons(decision)
  if (first === undefined || first === null) return ''
  return typeof first === 'string' ? first : String(first.code ?? '')
}

/** Strength tag shared by both row shapes; an unknown strength stays readable as its raw value. */
export function threadStrengthTag(t, strength) {
  if (!strength) return null
  const key = `strength.${strength}`
  const label = pt(t, key)
  return h(Tag, { tone: 'outline' }, label === key ? String(strength) : label)
}

/**
 * Consecutive decisions (newest first) with the same kind and the same first reason code read as one run: the engine
 * re-evaluates the same message several times and used to print one full row per pass (C4). A run of one keeps the
 * original single-decision row.
 */
export function threadDecisionGroups(decisions) {
  const groups = []
  for (const decision of decisions) {
    // `decisionKindView` resolves `outcome` when an old record has no `kind`, so grouping and the row tag agree.
    const kind = decisionKindView(decision).kind
    const code = threadFirstReasonCode(decision)
    const previous = groups.at(-1)
    if (previous && previous.kind === kind && previous.code === code) previous.decisions.push(decision)
    else groups.push({ key: decision.id, kind, code, decisions: [decision] })
  }
  return groups
}

/** The original single-decision row: result, strength, time, reason, rule count and the rule-by-rule fold. The first
    row also carries the latest decision's Ticket jump (the removed 决定 section used to own it). */
export function ThreadDecisionRow({ decision, latestTicket, openTicket }) {
  const { t } = usePanel()
  const view = decisionKindView(decision)
  const rules = Array.isArray(decision.rules) ? decision.rules : []
  const hit = rules.filter(rule => rule.matched).length
  const miss = rules.length - hit
  return h('div', { className: 'sa-row-main' },
    h('div', { className: 'sa-row-title' },
      h(StatusIcon, { state: view.state, size: 14 }),
      h('span', null, pt(t, view.labelKey)),
      threadStrengthTag(t, decision.strength),
      h(When, { at: decision.at }),
      latestTicket ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => openTicket(latestTicket.id) },
        pt(t, 'thread.openTicket')) : null),
    h('p', { className: 'sa-hint' }, reasonLabel(t, decision.reason) || '—'),
    h('div', { className: 'sa-row-meta' }, pt(t, 'thread.rulesHit', { hit, miss })),
    rules.length ? h(Folded, { summary: pt(t, 'thread.rulesDetail') }, h(ThreadRuleRows, { rules })) : null)
}

/** One run of identical decisions: result tag, ×N, the newest time and the shared reason on one line; the fold lists
    every decision in the run with its own time and rule detail, so no rule hit is lost. */
export function ThreadDecisionRunRow({ group, latestTicket, openTicket }) {
  const { t } = usePanel()
  const latest = group.decisions[0]
  const view = decisionKindView(latest)
  const count = group.decisions.length
  return h('div', { className: 'sa-row-main' },
    h('div', { className: 'sa-row-title' },
      h(Tag, { tone: view.tone }, pt(t, view.labelKey)),
      h(Tag, { tone: 'quiet', title: pt(t, 'thread.groupDetail', { count }) }, `×${count}`),
      threadStrengthTag(t, latest.strength),
      h(When, { at: latest.at }),
      latestTicket ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => openTicket(latestTicket.id) },
        pt(t, 'thread.openTicket')) : null),
    h('p', { className: 'sa-hint' }, reasonLabel(t, latest.reason) || '—'),
    h(Folded, { summary: pt(t, 'thread.groupDetail', { count }) },
      h('ul', { className: 'sa-list' }, group.decisions.map(decision => {
        const rules = Array.isArray(decision.rules) ? decision.rules : []
        const hit = rules.filter(rule => rule.matched).length
        const miss = rules.length - hit
        return h('li', { key: decision.id, className: 'sa-row' },
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' }, h(When, { at: decision.at }), threadStrengthTag(t, decision.strength)),
            h('p', { className: 'sa-hint' }, reasonLabel(t, decision.reason) || '—'),
            h('div', { className: 'sa-row-meta' }, pt(t, 'thread.rulesHit', { hit, miss })),
            rules.length ? h(Folded, { summary: pt(t, 'thread.rulesDetail') }, h(ThreadRuleRows, { rules })) : null))
      }))))
}

/** Decisions of this thread, newest first, folded into runs. Only the newest three runs render until 展开全部 is
    pressed (a native button, so the disclosure is keyboard reachable). Tickets that are not the latest decision's own
    stay reachable through a fold, so removing the 决定 section loses no Ticket jump. */
export const THREAD_EVAL_RECENT = 3

export function ThreadEvaluations({ decisions, tickets }) {
  const { t, navigate } = usePanel()
  const [expanded, setExpanded] = useState(false)
  if (!decisions.length) return h(Hint, null, pt(t, 'thread.noEval'))
  const groups = threadDecisionGroups(decisions)
  const folded = groups.length > THREAD_EVAL_RECENT
  const shown = expanded || !folded ? groups : groups.slice(0, THREAD_EVAL_RECENT)
  const latestTicketId = decisions[0]?.ticketId
  const latestTicket = latestTicketId ? tickets.find(ticket => ticket.id === latestTicketId) : undefined
  const otherTickets = tickets.filter(ticket => ticket.id !== latestTicket?.id)
  const openTicket = id => navigate({ page: 'execution', id })
  return h(Fragment, null,
    h('ul', { className: 'sa-list' }, shown.map((group, index) => h('li', { key: group.key, className: 'sa-row' },
      group.decisions.length === 1
        ? h(ThreadDecisionRow, { decision: group.decisions[0], latestTicket: index === 0 ? latestTicket : undefined, openTicket })
        : h(ThreadDecisionRunRow, { group, latestTicket: index === 0 ? latestTicket : undefined, openTicket })))),
    folded
      ? h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-8)' } },
        h(Button, { variant: 'ghost', size: 'sm', 'aria-expanded': expanded,
          icon: h(Icon, { name: expanded ? 'chevron-up' : 'chevron-down', size: 14 }),
          onClick: () => setExpanded(value => !value) },
        expanded ? pt(t, 'thread.evalCollapse') : pt(t, 'thread.evalShowAll', { count: groups.length })))
      : null,
    otherTickets.length
      ? h(Folded, { summary: pt(t, 'thread.groupTickets', { count: otherTickets.length }) },
        h('ul', { className: 'sa-list' }, otherTickets.map(ticket => h('li', { key: ticket.id, className: 'sa-row' },
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' }, h(TicketStatusTag, { ticket }), h('span', null, ticket.title ?? ticket.id)),
            h('div', { className: 'sa-row-actions' },
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => openTicket(ticket.id) },
                pt(t, 'thread.openTicket'))))))))
      : null)
}

/** Message timeline: vertical axis, shape-coded dots, and one disposition tag per message — the decision outcome lives
    in 评估过程, so it is not repeated here (C4). Only the newest three messages render until 展开全部 is pressed; the
    disclosure is a native button, so it is keyboard reachable, and every message keeps its full text/expand control. */
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
          h(Tag, { tone: dispositionTone(view.state) }, pt(t, view.labelKey))))
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
 * Renders PageHead + 事实 → 评估过程（含最近决定与工单跳转）→ 消息时间线; errors keep the last data and offer a retry.
 */
export function ThreadDetail(props) {
  const { t } = usePanel()
  const model = usePanelData()
  const threadKey = props?.threadKey ?? props?.id
  const { data, error, loading, reload } = useLiveResource('engine/thread/:key', { key: threadKey }, 30000)
  if (!threadKey) return h(EmptyState, { icon: 'inbox', title: pt(t, 'thread.noSelection'), hint: pt(t, 'thread.noSelectionHint') })
  if (error && !data) return h(ErrorState, { error, onRetry: reload })
  if (loading) return h(Skeleton, { rows: 4 })
  const thread = data?.thread ?? {}
  const triggers = Array.isArray(data?.triggers) ? data.triggers : []
  const decisions = Array.isArray(data?.decisions) ? data.decisions : []
  const tickets = Array.isArray(data?.tickets) ? data.tickets : []
  const facts = data?.facts ?? {}
  const channelId = facts.channelId ?? triggers[0]?.channel?.address?.channelId ?? triggers[0]?.channel?.thread
  const factRows = [
    [pt(t, 'thread.fieldSource'), thread.source ?? '—'],
    [pt(t, 'thread.fieldCreated'), thread.createdAt ? h(When, { at: thread.createdAt }) : '—'],
    [pt(t, 'thread.fieldLast'), thread.lastAt ? h(When, { at: thread.lastAt }) : '—'],
    [pt(t, 'thread.fieldTriggers'), String(triggers.length)],
    [pt(t, 'thread.fieldTickets'), String(tickets.length)],
  ]
  // Raw identifiers (`octo:<hex>` keys, the 32-char channel id) belong to the raw-value fold, never to the fact rows (G2).
  const rawFacts = { key: thread.key ?? threadKey, channelId, ...facts }
  const chatTitles = model?.data?.config?.octo?.chatTitles ?? {}
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
      h(Folded, { summary: pt(t, 'thread.factsRaw') }, h(RawValue, { label: pt(t, 'thread.factsRaw'), json: rawFacts }))),
    h(Section, { title: pt(t, 'thread.eval'), count: decisions.length },
      h(ThreadEvaluations, { decisions, tickets })),
    h(Section, { title: pt(t, 'thread.timeline'), count: triggers.length }, h(ThreadTimeline, { triggers, decisions })))
}
