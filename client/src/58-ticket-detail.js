/* Ticket detail (spec 6.5 / 7.4): changes → acceptance → stage rail → gate results → run records → timeline,
   with the authorization basis and the raw JSON folded at the bottom. Actions are one state-following primary action
   plus a ⋯ menu; destructive ones always confirm (retry, publish MR, accept/reject).
   Data: GET engine/ticket/:id (host increments, contract §4), refreshed every 10s. */

Object.assign(PAGE_TEXT, {
  'detail.failedTitle': ['这次执行失败', 'This run failed'],
  'detail.failedSteps': ['失败步骤：{steps}', 'Failed steps: {steps}'],
  'detail.failedNoChanges': ['执行器没有检测到任何文件改动。检查工单正文是否包含可执行的需求，或看「运行记录」里的 worker 输出后重试。',
    'The executor saw no file changes. Check that the request text is actionable, review the worker output under Run records, then retry.'],
  'detail.failedCli': ['本地 CLI 不可用或未登录。安装/登录 CLI，或在「设置 → 运行 → CLI 路径」填写绝对路径后重试。',
    'The local CLI is missing or not logged in. Install/log in, or set its absolute path under Settings → Runtime → CLI path, then retry.'],
  'detail.failedTimeout': ['执行超时。缩小需求或调大「执行超时」后重试。', 'The run timed out. Narrow the request or raise the run timeout, then retry.'],
  'detail.failedGate': ['闸门未通过。展开下面的「闸门结果」看失败输出，修复后重试。', 'A gate failed. Open Gate results for the failing output, fix it, then retry.'],
  'detail.failedInternal': ['执行器内部错误（旧版自动执行没有把宿主上下文传给 worker）。该问题已在本次修复中解决，直接点「重试执行」即可。',
    'The executor hit an internal error (the old auto-run path did not pass the host context to the worker). This is fixed; just press Retry.'],
  'detail.failedGeneric': ['可修复工作树或工单正文后点「重试执行」；不需要的失败工单可以在 ⋯ 菜单里忽略。',
    'Fix the worktree or request, then retry; an obsolete failed Ticket can be dismissed from the ⋯ menu.'],
  // One short cause per known failure kind (C9); the raw English text stays one fold below the banner.
  'detail.errorInterrupted': ['执行被插件重载或宿主重启中断。', 'The run was interrupted by a plugin reload or host restart.'],
  'detail.errorInternal': ['执行器内部错误。', 'The executor hit an internal error.'],
  'detail.errorNoChanges': ['worker 没有产生任何文件改动。', 'The worker made no file changes.'],
  'detail.errorCli': ['本地 CLI 缺失或未登录。', 'The local CLI is missing or not signed in.'],
  'detail.errorTimeout': ['执行超时。', 'The run timed out.'],
  'detail.errorGate': ['闸门未通过。', 'A gate failed.'],
  'detail.rawError': ['原始错误', 'Raw error'],
  'detail.copyTicketId': ['复制工单 ID', 'Copy Ticket ID'],
  'ticket.sectionNav': ['页内跳转', 'Jump to section'],
  'detail.dismiss': ['忽略并清理', 'Dismiss and clean up'],
  'detail.dismissTitle': ['忽略工单', 'Dismiss Ticket'],
  'detail.dismissConfirm': ['将把工单标记为「已忽略」并移出「需要你处理」，同时删除本地分支 {branch} 与工作树 {worktree}（远程分支不自动删除）：{title}',
    'Marks this Ticket as dismissed, removes it from "needs you", and deletes local branch {branch} and worktree {worktree} (the remote branch is not touched): {title}'],
  'detail.dismissRecorded': ['工单已忽略，本地分支与工作树已删除', 'Ticket dismissed; local branch and worktree removed'],
  'detail.dismissRecordedBare': ['工单已忽略', 'Ticket dismissed'],
  'detail.acceptedOn': ['验收于 {time}', 'Accepted at {time}'],
  'detail.acceptCleanupDone': ['本地工作区与分支已清理', 'Local worktree and branch cleaned up'],
  'detail.acceptCleanupFailedShort': ['验收已记录，但本地工作区清理失败', 'Accepted; local cleanup failed'],
  'detail.acceptCleanupFailed': ['验收已记录，但本地工作区清理失败：{reason}', 'Accepted; local cleanup failed: {reason}'],
  'detail.rejectedOn': ['验收不通过于 {time}', 'Rejected at {time}'],
  'ticket.dryRunUnavailable': ['执行器未启用，干跑不可用。', 'The executor is disabled; dry run is unavailable.'],
})

/** Run step name → PAGE_TEXT key suffix; gate steps are labelled with their gate name. */
const TICKET_STEP_KEYS = {
  'prepare-worktree': 'prepareWorktree',
  'prepare-repo': 'prepareRepo',
  'export-repo': 'exportRepo',
  worker: 'worker',
  'changed-paths': 'changedPaths',
  'bootstrap:pnpm': 'bootstrap',
  finish: 'finish',
  commit: 'commit',
  push: 'push',
  'merge-request': 'mergeRequest',
  error: 'error',
  publish: 'publish',
}

function ticketStepLabel(t, name) {
  const text = String(name ?? '')
  if (text.startsWith('gate:')) return `${pt(t, 'ticket.step.gate')}：${pt(t, `gate.${text.slice(5)}`)}`
  const key = TICKET_STEP_KEYS[text]
  return key ? pt(t, `ticket.step.${key}`) : text
}

/** run step state → status shape. */
const STEP_STATE = { ok: 'done', running: 'ongoing', failed: 'error', pending: 'idle' }

/** Absolute short stamp for the detail timeline and the acceptance line: `MM-DD HH:mm`; the full time goes in title. */
function ticketStamp(value) {
  const date = new Date(value ?? '')
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  const pad = number => String(number).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Timeline timestamps are read as absolute times first (critique #11): no "20 小时前" at the start of a row. */
function TicketStamp({ at }) {
  const { t } = usePanel()
  return h('time', { dateTime: at, title: fullTime(at, t.lang) }, ticketStamp(at))
}

/**
 * One event stream for the ticket: created, the *final* state of every run step, and the verification result.
 *
 * The executor logs a step twice while it runs (a `running` transition, then the final state), so a naive dump shows
 * every step as a spinner-looking "turn" followed by a duplicate check. Only the last state per step per run is a
 * fact worth showing; transient `running`/`pending` rows and the duplicated dry-run start are dropped here.
 */
function ticketEvents(t, ticket, runs) {
  const events = []
  const seen = new Set()
  const add = event => {
    if (typeof event.at !== 'string' || !event.at) return
    const key = [event.at, event.stepName ?? event.labelKey, event.state, event.detail ?? '', event.sha ?? ''].join('|')
    if (seen.has(key)) return
    seen.add(key)
    events.push(event)
  }
  add({ at: ticket.createdAt, labelKey: 'ticket.event.created', state: 'done' })
  for (const run of runs) {
    const failed = run.status === 'failed'
    add({ at: run.startedAt, labelKey: 'ticket.event.runStarted', state: failed ? 'error' : 'done', dry: Boolean(run.dryRun) })
    // Keep only the final record of each step name inside this run.
    const finalSteps = new Map()
    for (const step of Array.isArray(run.steps) ? run.steps : []) {
      if (!step?.name) continue
      const previous = finalSteps.get(step.name)
      if (!previous || String(step.at ?? '') >= String(previous.at ?? '')) finalSteps.set(step.name, step)
    }
    const ordered = [...finalSteps.values()].sort((left, right) => String(left.at ?? '').localeCompare(String(right.at ?? '')))
    for (const step of ordered) {
      if (step.state === 'running' || step.state === 'pending') continue
      // A commit/push step records the full 40-char SHA; the timeline shows 7 chars plus a copy button (critique #11).
      const sha = typeof step.sha === 'string' && step.sha ? step.sha : undefined
      // The `error` step repeats run.error, and a reconcile step can carry the same English cause; map any known
      // failure wording to the Chinese cause, keeping the raw text on hover (C9).
      const rawDetail = String(step.message ?? step.error ?? step.branch
        ?? (step.exitCode !== undefined ? `exit ${step.exitCode}` : ''))
      const mapped = failureKnown(rawDetail)
      const detail = mapped ? failureLabel(t, rawDetail) : rawDetail
      add({ at: step.at, stepName: step.name, state: STEP_STATE[step.state] ?? 'idle', detail,
        detailTitle: mapped ? rawDetail : undefined, sha, dry: Boolean(run.dryRun) })
    }
    if (run.error) add({ at: run.endedAt ?? run.startedAt, labelKey: 'ticket.event.runFailed', state: 'error',
      detail: failureLabel(t, run.error), detailTitle: String(run.error) })
  }
  const verification = ticket.links?.verification
  if (verification?.at) {
    const bad = verification.uat && verification.uat.ok === false
    add({ at: verification.at, labelKey: 'ticket.event.verified', state: bad ? 'error' : verification.merged ? 'done' : 'idle',
      detail: verification.uat ? (verification.uat.ok ? liveText('UAT 可访问', 'UAT reachable') : String(verification.uat.error ?? liveText('UAT 不可访问', 'UAT unreachable'))) : '' })
  }
  if (ticket.updatedAt && !events.some(event => event.at === ticket.updatedAt)) {
    add({ at: ticket.updatedAt, labelKey: 'ticket.event.updated', state: 'done' })
  }
  return events.sort((left, right) => String(left.at ?? '').localeCompare(String(right.at ?? '')))
}

const TIMELINE_RECENT = 8

/** Timeline with a vertical axis, shape-coded dots and a timestamp per event; long histories collapse to the latest. */
function TicketTimeline({ ticket, runs }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState(false)
  const events = ticketEvents(t, ticket, runs)
  const shown = expanded ? events : events.slice(-TIMELINE_RECENT)
  return h(Fragment, null,
    events.length > TIMELINE_RECENT
      ? h('p', { className: 'sa-hint' }, pt(t, 'ticket.timelineRecent', { count: shown.length, total: events.length }))
      : null,
    h('ol', { className: 'sa-timeline' }, shown.map((event, index) => h('li', { key: index, className: 'sa-event' },
      h('div', { className: 'sa-event-actor' },
        h(StatusIcon, { state: event.state, size: 14 }),
        h(TicketStamp, { at: event.at }),
        h('span', null, event.stepName ? ticketStepLabel(t, event.stepName) : pt(t, event.labelKey)),
        event.dry ? h(Tag, { tone: 'outline' }, pt(t, 'ticket.dryTag')) : null),
      event.sha
        ? h('div', { className: 'sa-actions' },
          h('code', { className: 'sa-mono', title: event.sha }, String(event.sha).slice(0, 7)),
          h(CopyButton, { value: event.sha }),
          event.detail ? h('span', { className: 'sa-hint', title: event.detailTitle }, event.detail) : null)
        : event.detail ? h('p', { className: 'sa-event-text', title: event.detailTitle }, event.detail) : null))),
    events.length > TIMELINE_RECENT
      ? h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-8)' } },
        h(Button, { variant: 'ghost', size: 'sm', icon: expanded ? 'chevron-up' : 'chevron-down',
          onClick: () => setExpanded(value => !value) },
        expanded ? pt(t, 'ticket.timelineCollapse') : pt(t, 'ticket.timelineShowAll', { count: events.length })))
      : null)
}

/** Run records, newest first: status, start time, branch/commit and the failure cause in plain words (the raw text is on
    hover; gates live in their own section). */
function TicketRunRows({ runs }) {
  const { t } = usePanel()
  return h('ul', { className: 'sa-list' }, runs.map(run => {
    const view = ticketStatus({ status: run.status })
    const commit = typeof run.commit === 'string' ? run.commit : run.commit?.sha
    return h('li', { key: run.id, className: 'sa-row' },
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h(StatusIcon, { state: view.state, size: 14 }),
          h('span', null, pt(t, view.labelKey)),
          run.dryRun ? h(Tag, { tone: 'outline' }, pt(t, 'ticket.dryTag')) : null,
          run.startedAt ? h(When, { at: run.startedAt }) : null,
          h('span', { className: 'sa-mono sa-hint' }, liveShortId(run.id))),
        h('div', { className: 'sa-row-meta' },
          run.branch ? h('span', { className: 'sa-mono' }, run.branch) : null,
          commit ? h('span', { className: 'sa-mono' }, liveShortId(commit, 8)) : null,
          Array.isArray(run.steps) ? h('span', { className: 'sa-hint' }, pt(t, 'ticket.stepsCount', { count: run.steps.length })) : null),
        run.error ? h('p', { className: 'sa-error', title: String(run.error) }, failureLabel(t, run.error)) : null))
  }))
}

/**
 * The worker summary is written by the agent and usually carries its own "## 闸门结果" table. This page renders gate
 * results in their own section, so that block is removed from the change summary; the leading "## 改动内容" heading
 * is dropped too because the section already says it.
 */
const WORKER_GATE_HEADING = /^#{1,6}\s*(闸门结果|闸门|质量闸门|测试与闸门|gates?)\b/i
const WORKER_CHANGES_HEADING = /^#{1,6}\s*改动内容\s*$/i
function cleanWorkerSummary(text) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  const out = []
  let skipping = false
  let skipLevel = 0
  let skippedChangesHeading = false
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = heading.length > 0 ? heading[1].length : 0
      const title = heading[2].trim()
      if (WORKER_GATE_HEADING.test(title) || /^(闸门结果|闸门)/.test(title)) { skipping = true; skipLevel = level; continue }
      if (skipping && level <= skipLevel) skipping = false
      if (skipping) continue
      if (!skippedChangesHeading && WORKER_CHANGES_HEADING.test(title)) { skippedChangesHeading = true; continue }
      out.push(line)
      continue
    }
    if (skipping) {
      // A plain "闸门结果" line without a heading also opens the gate block.
      if (/^\s*闸门结果\s*$/.test(line)) { skipping = true; continue }
      continue
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Changed files and the worker summary: the human-readable "what changed", unioned across runs. */
function changesOf(runs) {
  const files = []
  const seen = new Set()
  let worker
  for (const run of runs) {
    for (const file of Array.isArray(run.changedPaths) ? run.changedPaths : []) {
      if (typeof file !== 'string' || seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
    if (run.worker?.text) worker = run.worker.text
  }
  return { files, worker: cleanWorkerSummary(worker) }
}

/** One sentence explaining what a failed run means and how to recover. */
function failureHint(t, error, steps) {
  const text = String(error ?? '')
  if (/no changes/i.test(text)) return pt(t, 'detail.failedNoChanges')
  if (/Cannot read propert|reading 'get'|host context/i.test(text)) return pt(t, 'detail.failedInternal')
  if (/CLI not found|ENOENT|not logged in/i.test(text)) return pt(t, 'detail.failedCli')
  if (/timed out/i.test(text)) return pt(t, 'detail.failedTimeout')
  if (/gate/i.test(text) || steps.some(step => step.startsWith(pt(t, 'ticket.step.gate')))) return pt(t, 'detail.failedGate')
  return pt(t, 'detail.failedGeneric')
}

/**
 * Full ticket detail. `id` is the engine ticket id; `page` says which tab hosts it so a row click on another tab
 * keeps the same route page.
 */
function TicketDetail({ id, page = 'execution' }) {
  const { t, navigate, notify, back } = usePanel()
  const model = usePanelData()
  const { data, error, loading, reload } = useLiveResource('engine/ticket/:id', { id }, 10000)
  const [activeJump, setActiveJump] = useState()
  const [headStuck, setHeadStuck] = useState(false)
  const headRef = useRef(null)
  // The PageHead (title/status/primary action) scrolls away; the sticky tier-2 row re-shows that context once it is
  // out of view, so a deep scroll never leaves only the section links and the generic page chrome (C31).
  useEffect(() => {
    const node = headRef.current ?? document.querySelector('.sa-page-head')
    const root = document.querySelector('.sa-scroll')
    if (!node || !root) return undefined
    const update = () => {
      const head = node.getBoundingClientRect()
      const scroll = root.getBoundingClientRect()
      // The compact context appears only once the real PageHead is under the sticky nav (a small overlap margin keeps
      // it from flickering at the boundary).
      setHeadStuck(head.bottom <= scroll.top + 8)
    }
    update()
    root.addEventListener('scroll', update, { passive: true })
    return () => root.removeEventListener('scroll', update)
  }, [id, data])
  const act = model?.actions
  const refreshAll = useCallback(async () => { await Promise.all([model?.reload?.(), reload()]) }, [model, reload])
  const dryRun = useAction(() => act.runTicket(id, { dryRun: true, wait: false }), { reload: refreshAll })
  const retry = useAction(() => act.runTicket(id, { dryRun: false, wait: false }), { reload: refreshAll })
  const publish = useAction(() => act.publishTicket(id), { reload: refreshAll })
  const refreshCi = useAction(() => act.refreshCi(id), { reload: refreshAll })
  const verify = useAction(async () => {
    const result = await act.verifyTicket(id)
    notify(pt(t, result?.verification?.uat?.ok ? 'toast.verifyOk' : 'toast.verifyDown'))
  }, { reload: refreshAll })
  const acceptPass = useAction(async () => {
    const result = await act.acceptTicket(id, { ok: true })
    const cleanup = result?.cleanup ?? result?.ticket?.links?.cleanup
    notify(pt(t, cleanup ? (cleanup.failed ? 'detail.acceptCleanupFailedShort' : 'detail.acceptCleanupDone') : 'ticket.acceptRecorded'))
    return cleanup
  }, { reload: refreshAll })
  const acceptFail = useAction(async () => { await act.acceptTicket(id, { ok: false }); notify(pt(t, 'ticket.rejectRecorded')) },
    { reload: refreshAll })
  const dismiss = useAction(async () => {
    const result = await act.dismissTicket(id, '手动忽略')
    const cleanup = result?.cleanup ?? result?.ticket?.links?.cleanup
    notify(pt(t, cleanup ? 'detail.dismissRecorded' : 'detail.dismissRecordedBare'))
    return cleanup
  }, { reload: refreshAll })
  // Which confirmation dialog the ⋯ menu opened (`publish` / `retry`); mirrors TicketRow's menu behavior (critique #4).
  const [pending, setPending] = useState(null)
  // Keyboard walk-through (critique G6): Escape leaves the detail, but never while a dialog or menu owns the key.
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      // An open dialog/menu owns Escape; the trigger wrapper itself is always in the DOM, so test the role.
      if (document.querySelector('.sa-modal') || document.querySelector('[role="menu"]')) return
      back()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [back])

  if (!id) return h(EmptyState, { icon: 'inbox', title: pt(t, 'thread.noSelection'), hint: pt(t, 'thread.noSelectionHint') })
  if (error && !data) return h(ErrorState, { error, onRetry: reload })
  if (loading) return h(Skeleton, { rows: 5 })

  const ticket = data?.ticket ?? {}
  const runs = Array.isArray(data?.runs) ? data.runs : []
  const trigger = data?.trigger
  const decision = data?.decision
  const thread = data?.thread
  const config = model?.data?.config ?? {}
  const view = ticketStatus(ticket)
  const failedRun = view.state === 'error' ? runs.find(run => run.status === 'failed') : undefined
  const failedSteps = (failedRun?.steps ?? [])
    .filter(step => step.state === 'failed' && step.name !== 'error').map(step => ticketStepLabel(t, step.name))
  const canRun = config.executor?.enabled === true
  const canPush = canRun && config.executor?.allowPush === true
  const hasMr = Boolean(ticket.links?.mergeRequest?.iid)
  // Which repository this Ticket runs on (contract §12): the derived name/id plus the local clone and branch flow.
  const repos = panelRepos(model?.data)
  const repoId = ticket.repoId ?? panelDefaultRepo(model?.data)
  const repo = repos.find(entry => entry && entry.id === repoId)
  const repoName = ticket.repoName ?? repo?.name ?? repoId
  const repoVerifyMode = ticket.repoVerifyMode ?? repo?.verifyMode
  const repoAcceptance = ticket.repoAcceptance ?? repo?.acceptance
  const repoBase = repo?.baseBranch ?? config.baseBranch
  const repoTarget = repo?.targetBranch ?? config.gitlab?.targetBranch
  // One "仓库" row: the name, plus the id only when the two differ (critique #17).
  const repoRows = []
  if (repoName) {
    const repoLabel = String(repoName)
    const repoIdText = repoId ? String(repoId) : ''
    repoRows.push([pt(t, 'repo.label'), repoIdText && repoIdText !== repoLabel ? `${repoLabel}（${repoIdText}）` : repoLabel])
  }
  if (repo?.repo) repoRows.push([pt(t, 'repo.localPath'), h('span', { className: 'sa-mono' }, String(repo.repo))])
  if (repoBase || repoTarget) repoRows.push([pt(t, 'repo.branches'), `${repoBase ?? '—'} → ${repoTarget ?? '—'}`])
  if (repoVerifyMode) repoRows.push([pt(t, 'repo.verifyMode'), repoVerifyModeText(t, repoVerifyMode)])
  if (repoAcceptance) repoRows.push([pt(t, 'repo.acceptance'), repoAcceptanceText(t, repoAcceptance)])
  const rules = Array.isArray(decision?.rules) ? decision.rules : []
  const authRows = [
    [pt(t, 'ticket.scope'), ticket.scope ?? '—'],
    [pt(t, 'ticket.policy'), decision?.policyVersion ?? '—'],
    [pt(t, 'ticket.strength'), decision?.strength ? pt(t, `strength.${decision.strength}`) : '—'],
    [pt(t, 'ticket.origin'), trigger ? h('span', { className: 'sa-mono' }, liveShortId(trigger.id)) : '—'],
    [pt(t, 'ticket.basis'), reasonLabel(t, decision?.reason ?? ticket.origin?.reason) || '—'],
  ]
  if (thread?.key) authRows.push([t('term.thread'), h(Button, { variant: 'ghost', size: 'sm',
    onClick: () => navigate({ page: 'trigger', id: thread.key }) }, thread.title ?? liveShortId(thread.key))])

  // Acceptance is a human decision: it gets its own card, its own two sign-off buttons, and (unlike the action row)
  // never goes through the ⋯ menu. The mode comes from the repository (contract §12): `merged` repositories accept
  // after the merge, `deployed` ones after the UAT deployment.
  const acceptance = ticket.links?.acceptance
  const accepted = acceptance?.ok === true
  const acceptMode = ticket.repoAcceptance ?? 'deployed'
  const canAccept = acceptMode === 'merged'
    ? (ticket.status === 'merged' || ticket.links?.verification?.merged === true)
    : ticket.status === 'deployed'
  const manualVerify = repoVerifyMode === 'manual'
  const uatUrl = manualVerify ? undefined : (repo?.uatUrl ?? config.gitlab?.uatUrl)
  const busy = { dryRun: dryRun.busy, retry: retry.busy, publish: publish.busy, refreshCi: refreshCi.busy, verify: verify.busy }
  // One state-following primary action (retry a failed run, review a pending acceptance, open the merged MR once
  // accepted, dry run otherwise) plus a ⋯ menu for every other action (critique #4, O15).
  const failed = view.state === 'error'
  const needsAcceptance = !accepted && view.group === 'waiting' && canAccept
  const mrUrl = ticket.links?.mergeRequest?.webUrl
  const primaryAction = failed
    ? canRun
      ? h(ConfirmButton, { label: pt(t, 'ticket.retry'), title: pt(t, 'retryTitle'),
        message: pt(t, 'retryConfirm', { title: ticket.title ?? ticket.id }), variant: 'primary', icon: 'refresh',
        onConfirm: async () => { await retry.run() } })
      : h(Button, { variant: 'primary', size: 'sm', disabled: true, title: pt(t, 'ticket.retryUnavailable') }, pt(t, 'ticket.retry'))
    : accepted
      // An accepted Ticket has nothing left to run: open the merged MR when there is one, otherwise only the ⋯ menu stays.
      ? (mrUrl ? h(Button, { variant: 'primary', size: 'sm',
        onClick: () => { window.open(mrUrl, '_blank', 'noopener') } }, pt(t, 'primary.openMr')) : null)
      : needsAcceptance
        ? h(Button, { variant: 'primary', size: 'sm', onClick: () =>
          document.getElementById('sa-acceptance')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) },
        pt(t, 'primary.accept'))
        : h(Button, { variant: 'primary', size: 'sm', disabled: busy.dryRun || !canRun,
          title: canRun ? undefined : pt(t, 'ticket.dryRunUnavailable'),
          onClick: () => { void dryRun.run() } }, pt(t, 'ticket.dryRun'))
  const menuItems = [
    { key: 'verify', label: pt(t, 'menu.verify'), icon: 'review', onSelect: () => { void verify.run() }, disabled: busy.verify },
    { key: 'ci', label: pt(t, 'menu.refreshCi'), icon: 'refresh', onSelect: () => { void refreshCi.run() },
      disabled: busy.refreshCi || !hasMr },
    { key: 'publish', label: pt(t, 'menu.publish'), icon: 'external', onSelect: () => setPending('publish'),
      disabled: busy.publish || !canPush, title: canPush ? undefined : pt(t, 'ticket.publishUnavailable') },
    { key: 'retry', label: pt(t, 'ticket.retry'), icon: 'refresh', onSelect: () => setPending('retry'),
      disabled: busy.retry || !canRun, title: canRun ? undefined : pt(t, 'ticket.retryUnavailable') },
    { key: 'stop', label: pt(t, 'menu.stop'), icon: 'stop', onSelect: () => {}, disabled: true, title: pt(t, 'ticket.stopUnavailable') },
    ...failed ? [{ key: 'dismiss', label: pt(t, 'detail.dismiss'), icon: 'stop', onSelect: () => setPending('dismiss') }] : [],
  ]
  const runPending = async action => { const done = await action.run(); if (done) setPending(null) }
  const confirmDialog = pending
    ? h(Modal, { open: true, onClose: () => setPending(null),
      title: pending === 'retry' ? pt(t, 'retryTitle') : pending === 'dismiss' ? pt(t, 'detail.dismissTitle') : pt(t, 'ticket.publishTitle'),
      closeLabel: t('close'),
      description: pending === 'retry'
        ? pt(t, 'retryConfirm', { title: ticket.title ?? ticket.id })
        : pending === 'dismiss'
          ? pt(t, 'detail.dismissConfirm', { title: ticket.title ?? ticket.id,
            branch: ticket.links?.branch || '（无）', worktree: ticket.links?.worktree || '（无）' })
          : pt(t, 'ticket.publishConfirm', { title: ticket.title ?? ticket.id }),
      footer: h(Fragment, null,
        h(Button, { variant: 'ghost', onClick: () => setPending(null) }, t('cancel')),
        h(Button, { variant: 'primary', disabled: pending === 'retry' ? busy.retry : pending === 'dismiss' ? busy.dismiss : busy.publish,
          onClick: () => { void runPending(pending === 'retry' ? retry : pending === 'dismiss' ? dismiss : publish) } }, t('confirm'))) })
    : null
  const actionRow = h(Fragment, null,
    h('div', { className: 'sa-actions' },
      primaryAction,
      h(Menu, { label: pt(t, 'menu.label'), items: menuItems, align: 'end' })),
    confirmDialog)

  const changes = changesOf(runs)
  const events = ticketEvents(t, ticket, runs)
  // The banner names the cause in one short sentence; the original text of a recognised failure sits one fold below it,
  // so mapping the wording never hides the raw error (C9).
  const failureRaw = String(failedRun?.error ?? '').trim()
  const failureCause = failureRaw ? failureLabel(t, failedRun.error) : ''
  const failureBanner = failedRun
    ? h('div', { className: 'sa-banner sa-danger', role: 'alert',
      style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' } },
      h(StatusIcon, { state: 'error', size: 16, spin: false }),
      h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' } },
        h('strong', { style: { fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 } }, pt(t, 'detail.failedTitle')),
        failureCause ? h('p', { className: 'sa-error' }, failureCause) : null,
        failureCause && failureRaw !== failureCause
          ? h(Folded, { summary: pt(t, 'detail.rawError') }, h('p', { className: 'sa-error' }, failureRaw))
          : null,
        failedSteps.length
          ? h('p', { className: 'sa-hint' }, pt(t, 'detail.failedSteps', { steps: failedSteps.join(' · ') }))
          : null,
        h('p', { className: 'sa-hint' }, failureHint(t, failedRun.error, failedSteps))))
    : null
  const jumps = [
    { id: 'sa-ticket-changes', labelKey: 'ticket.changes' },
    { id: 'sa-acceptance', labelKey: 'ticket.acceptCard' },
    { id: 'sa-ticket-stages', labelKey: 'ticket.stages' },
    { id: 'sa-ticket-gates', labelKey: 'ticket.gates' },
    { id: 'sa-ticket-runs', labelKey: 'ticket.runs' },
    { id: 'sa-ticket-timeline', labelKey: 'ticket.timeline' },
  ]
  const jumpTo = id => {
    setActiveJump(id)
    const node = document.getElementById(id)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
  }

  return h(Fragment, null,
    h(PageHead, { headRef, title: ticket.title ?? pt(t, 'ticket.loading'),
      meta: h(Fragment, null,
        h(TicketStatusTag, { ticket }),
        h('span', { className: 'sa-mono' }, liveShortId(ticket.id, 10)),
        ticket.id ? h(CopyButton, { value: ticket.id, label: pt(t, 'detail.copyTicketId') }) : null,
        ticket.updatedAt ? h(When, { at: ticket.updatedAt }) : null,
        repoName ? h('span', { className: 'sa-hint' }, `${pt(t, 'repo.label')}：${repoName}`) : null) }),
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    failureBanner,
    actionRow,
    h('nav', { className: 'sa-detail-nav', 'aria-label': pt(t, 'ticket.sectionNav') },
      headStuck ? h('div', { className: 'sa-detail-context' },
        h('span', { className: 'sa-detail-context-title', title: ticket.title ?? ticket.id },
          ticket.title ?? pt(t, 'ticket.loading')),
        h(TicketStatusTag, { ticket })) : null,
      h('div', { className: 'sa-detail-jumps' }, jumps.map(jump => h('button', { key: jump.id, type: 'button', className: 'sa-detail-jump',
        'data-active': activeJump === jump.id ? 'true' : undefined,
        'aria-current': activeJump === jump.id ? 'location' : undefined,
        onClick: () => jumpTo(jump.id) }, pt(t, jump.labelKey)))),
      headStuck && primaryAction ? h('div', { className: 'sa-detail-context-action' }, primaryAction) : null),

    // 1. What changed: repository, request body, changed files and the worker's summary — gates stay in their section.
    h(Section, { id: 'sa-ticket-changes', title: pt(t, 'ticket.changes') },
      repoRows.length
        ? h('div', { style: { marginBottom: 'var(--sa-sp-8)' } }, h(KeyValues, { rows: repoRows }))
        : null,
      // "What changed" answers with the files and the worker's own summary first; the original request (often a long
      // SQL paste) stays one click away so it cannot push the actual changes below the first screen (critique C24).
      h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-8)' } },
        h('span', { className: 'sa-hint' }, pt(t, 'ticket.changedFiles')),
        h('span', { className: 'sa-count' }, String(changes.files.length))),
      changes.files.length
        ? h('ul', { className: 'sa-list' }, changes.files.map((file, index) =>
          h('li', { key: index, className: 'sa-row' }, h('span', { className: 'sa-mono' }, file))))
        : h(Hint, null, pt(t, 'ticket.noChangedFiles')),
      changes.worker
        ? h('div', { style: { marginTop: 'var(--sa-sp-8)' } },
          h('p', { className: 'sa-hint' }, pt(t, 'ticket.workerSummary')),
          h(MarkdownLite, { text: String(changes.worker) }))
        : h(Hint, null, pt(t, 'ticket.noChanges')),
      ticket.body
        ? h('div', { style: { marginTop: 'var(--sa-sp-8)' } },
          h(Folded, { summary: pt(t, 'ticket.request') }, h(MarkdownLite, { text: ticket.body })))
        : null),

    // 2. Acceptance: MR/UAT evidence plus the human sign-off actions. The acceptance state is already the PageHead
    //    tag, so this card only repeats the sign-off time once (critique #5: one "已验收" per screen).
    h(Section, { id: 'sa-acceptance', title: pt(t, 'ticket.acceptCard') },
      h('div', { className: 'sa-card-grid', style: { marginBottom: 'var(--sa-sp-8)' } },
        h(MergeRequestCard, { ticket }), h(UatCard, { ticket })),
      h('div', { className: 'sa-actions', style: { marginBottom: 'var(--sa-sp-8)' } },
        uatUrl ? h(ExternalLink, { href: uatUrl }, pt(t, 'ticket.openUat'))
          : manualVerify ? h(Hint, null, pt(t, 'ticket.manualVerifyHint'))
          : h(Hint, null, pt(t, 'ticket.uatOpenHint'))),
      accepted
        ? h(Fragment, null,
          h('p', { className: 'sa-hint', title: fullTime(acceptance.at, t.lang) },
            pt(t, 'detail.acceptedOn', { time: ticketStamp(acceptance.at) })),
          ticket.links?.cleanup
            ? h(Hint, null, ticket.links.cleanup.failed
              ? pt(t, 'detail.acceptCleanupFailed', { reason: ticket.links.cleanup.failed })
              : pt(t, 'detail.acceptCleanupDone'))
            : null)
        : acceptance?.ok === false
          ? h(Fragment, null,
            h('p', { className: 'sa-hint', title: fullTime(acceptance.at, t.lang) },
              pt(t, 'detail.rejectedOn', { time: ticketStamp(acceptance.at) })),
            h(Hint, null, pt(t, 'ticket.acceptRejectedHint')))
          : null,
      canAccept && !accepted
        ? h(Fragment, null,
          h(Hint, null, pt(t, acceptMode === 'merged' ? 'ticket.acceptHintMerged' : 'ticket.acceptHint')),
          h('div', { className: 'sa-actions' },
            h(ConfirmButton, { label: pt(t, 'ticket.acceptPass'), title: pt(t, 'ticket.acceptPassTitle'),
              message: pt(t, 'ticket.acceptPassConfirm', { title: ticket.title ?? ticket.id }),
              variant: 'primary', icon: 'decision', onConfirm: async () => { await acceptPass.run() } }),
            h(ConfirmButton, { label: pt(t, 'ticket.acceptFail'), title: pt(t, 'ticket.acceptFailTitle'),
              message: pt(t, 'ticket.acceptFailConfirm', { title: ticket.title ?? ticket.id }),
              variant: 'outline', icon: 'blocked', onConfirm: async () => { await acceptFail.run() } })))
        : !canAccept && !accepted
          ? h(Hint, null, pt(t, acceptMode === 'merged' ? 'ticket.acceptOnlyMerged' : 'ticket.acceptOnlyDeployed'))
          : null),

    // 3. Stage rail, 4. gate results, 5. run records, 6. timeline (older events folded by default).
    h(Section, { id: 'sa-ticket-stages', title: pt(t, 'ticket.stages') }, h(StageRail, { ticket: { ...ticket, runs }, detail: true })),
    h(Section, { id: 'sa-ticket-gates', title: pt(t, 'ticket.gates') }, h(GateSummary, { ticket: { ...ticket, runs } })),
    h(Section, { id: 'sa-ticket-runs', title: pt(t, 'ticket.runs'), count: runs.length },
      runs.length ? h(TicketRunRows, { runs }) : h(Hint, null, pt(t, 'ticket.noRuns'))),
    h(Section, { id: 'sa-ticket-timeline', title: pt(t, 'ticket.timeline'), count: events.length },
      h(TicketTimeline, { ticket, runs })),

    // Secondary evidence and the raw escape hatch stay at the bottom.
    h(Folded, { summary: pt(t, 'ticket.auth') },
      h(KeyValues, { rows: authRows }),
      rules.length ? h(Folded, { summary: pt(t, 'thread.rulesDetail') }, h(ThreadRuleRows, { rules })) : null),
    h(RawValue, { label: pt(t, 'ticket.raw'), json: data }))
}
