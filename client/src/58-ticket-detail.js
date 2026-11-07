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

  // ---- P0: a run parked on a failing gate (contract §1.1/§3.2) ---------------------------------------------------
  'detail.gateTitle': ['闸门「{name}」未通过，执行已暂停', 'Gate “{name}” failed and the run is parked'],
  'detail.gateIntro': ['放行会跳过这个闸门并继续提交、推送与创建 MR；重试只重跑闸门；终止会以失败结束这张工单。失败证据保留在运行记录里。',
    'Release skips this gate and continues commit, push and MR; Retry re-runs the gates; Stop ends the Ticket as failed. The failing evidence stays on the run.'],
  'detail.gateExit': ['退出码', 'Exit code'],
  'detail.gateTimedOut': ['是否超时', 'Timed out'],
  'detail.gateChanged': ['改动文件', 'Changed files'],
  'detail.gateOutput': ['失败输出（末尾）', 'Failing output (tail)'],
  'detail.gateNoOutput': ['没有捕获到输出。', 'No captured output.'],
  'detail.gateRelease': ['放行并继续', 'Release and continue'],
  'detail.gateRetry': ['重试该闸门', 'Retry the gates'],
  'detail.gateStop': ['终止工单', 'Stop the Ticket'],
  'detail.gateReleaseTitle': ['放行这个闸门？', 'Release this gate?'],
  'detail.gateReleaseConfirm': ['会跳过闸门「{name}」并继续提交、推送与创建 MR；失败证据保留在运行记录里。只有当失败可以接受时才放行：{title}',
    'Skips gate “{name}” and continues commit, push and MR. The failing evidence stays on the run. Release only when the failure is acceptable: {title}'],
  'detail.gateStopTitle': ['终止这个工单？', 'Stop this Ticket?'],
  'detail.gateStopConfirm': ['工单会以「人工终止」结束，工作树与失败证据保留：{title}',
    'The Ticket ends as stopped by a person; the worktree and the failing evidence stay: {title}'],
  'detail.gateReleased': ['闸门已放行，继续执行。', 'Gate released; the run continues.'],
  'detail.gateRetried': ['闸门重跑完成，结果见运行记录。', 'Gates re-run; see Run records.'],
  'detail.gateStopped': ['工单已终止。', 'Ticket stopped.'],
  'detail.gateYes': ['是', 'Yes'],
  'detail.gateNo': ['否', 'No'],

  // ---- P0: independent acceptance line under the header ----------------------------------------------------------
  'detail.acceptLinePending': ['验收：待你验收', 'Acceptance: waiting for you'],
  'detail.acceptLineAccepted': ['验收：已验收于 {time}', 'Acceptance: accepted at {time}'],
  'detail.acceptLineRejected': ['验收：已打回于 {time}', 'Acceptance: rejected at {time}'],
  'detail.acceptLineJump': ['去验收', 'Go to acceptance'],
  'detail.acceptLineView': ['查看验收', 'View acceptance'],

  // ---- P0: run stop reasons and the worker trace -----------------------------------------------------------------
  'ticket.trace': ['执行轨迹', 'Execution trace'],
  'ticket.traceAssistant': ['助手消息', 'Assistant message'],
  'ticket.traceToolCall': ['工具调用', 'Tool call'],
  'ticket.traceToolResult': ['工具结果', 'Tool result'],
  'ticket.traceTurnEnd': ['回合结束', 'Turn end'],
  'ticket.traceError': ['错误事件', 'Error event'],
  'ticket.traceCount': ['执行轨迹（{count} 条）', 'Execution trace ({count})'],

  // ---- P0: a missing Ticket is not a broken connection -----------------------------------------------------------
  'detail.ticketMissing': ['找不到该工单', 'Ticket not found'],
  'detail.ticketMissingHint': ['它可能已被删除，或链接里的 ID 不正确。返回列表看看现有工单。',
    'It may have been removed, or the id in the link is wrong. Go back to the list to see the current Tickets.'],

  // ---- P1-2: operation detail (trigger, handoff, worker report) -------------------------------------------------
  'detail.handoff': ['交接摘要', 'Handoff'],
  'detail.handoffNext': ['下一步：{next}', 'Next: {next}'],
  'detail.report': ['执行报告', 'Worker report'],
  'detail.reportProgress': ['进度（{count}）', 'Progress ({count})'],
  'detail.reportArtifacts': ['产物（{count}）', 'Artifacts ({count})'],
  'detail.reportVerify': ['验证项（{count}）', 'Verify ({count})'],
  'detail.reportExpected': ['期望输出：{text}', 'Expected: {text}'],

  // ---- P1-3: acceptance rounds -----------------------------------------------------------------------------------
  'detail.acceptRecord': ['验收轮次', 'Acceptance rounds'],
  'detail.acceptStatus.unverified': ['未验收', 'Not verified'], 'detail.acceptStatus.verifying': ['验收中', 'Verifying'],
  'detail.acceptStatus.delivered': ['已送达', 'Delivered'], 'detail.acceptStatus.accepted': ['已验收', 'Accepted'],
  'detail.acceptStatus.rejected': ['已打回', 'Rejected'], 'detail.acceptStatus.closed': ['已关闭', 'Closed'],
  'detail.acceptStatus.errored': ['验收异常', 'Errored'],
  'detail.acceptRound': ['第 {round} 轮 · {status}', 'Round {round} · {status}'],
  'detail.acceptChecks': ['逐项检查（{count}）', 'Checks ({count})'],
  'detail.acceptNoChecks': ['这一轮还没有检查结果。', 'This round has no check results yet.'],
  'detail.acceptCheck.pending': ['待检查', 'Pending'], 'detail.acceptCheck.passed': ['通过', 'Passed'],
  'detail.acceptCheck.failed': ['失败', 'Failed'], 'detail.acceptCheck.errored': ['异常', 'Errored'],
  'detail.acceptCheck.skipped': ['跳过', 'Skipped'],
  'detail.acceptCheckOutput': ['输出（末尾）', 'Output (tail)'],
  'detail.acceptRequirement': ['验收要求：{text}', 'Requirement: {text}'],
  'detail.acceptIntents': ['打回原因', 'Rejection reasons'],
  'detail.acceptIntentsHint': ['勾选打回原因（可选），执行器会在下一轮据此修正。',
    'Tick the rejection reasons (optional); the executor uses them in the next round.'],
  'detail.intentUnmet': ['未满足需求', 'Requirement unmet'],
  'detail.intentNewIdea': ['有新想法', 'New idea'],
  'detail.intentNoEvidence': ['缺少证据', 'Missing evidence'],
  'detail.userDecision.accepted': ['已验收', 'Accepted'],
  'detail.userDecision.rejected': ['已打回', 'Rejected'],
  'detail.userDecision.overridden': ['已放行', 'Overridden'],

  // ---- P1-7: ticket activities -----------------------------------------------------------------------------------
  'ticket.activities': ['活动', 'Activity'],
  'ticket.activityEmpty': ['还没有活动记录。', 'No activity yet.'],
  'ticket.activityMore': ['共 {total} 条，显示最近 {shown} 条', '{total} total, showing the latest {shown}'],
  'activity.created': ['创建工单', 'Ticket created'], 'activity.status': ['状态变化', 'Status changed'],
  'activity.trigger': ['触发', 'Triggered'], 'activity.run': ['执行', 'Run'], 'activity.gate': ['闸门', 'Gate'],
  'activity.acceptance': ['验收', 'Acceptance'], 'activity.reply': ['回复来源', 'Replied to the Source'],
  'activity.dismiss': ['忽略', 'Dismissed'], 'activity.comment': ['评论', 'Comment'], 'activity.resume': ['恢复', 'Resumed'],

  // ---- P1-4 / P1-5: parked question and interrupted resume ------------------------------------------------------
  'detail.answerTitle': ['执行在等你回答', 'The run is waiting for your answer'],
  'detail.answerHint': ['回答后会以新的运行重新执行整张工单，之前的工作区与改动会复用。',
    'The Ticket re-runs as a new run with this answer in context; the worktree and changes are reused.'],
  'detail.answerQuestion': ['问题：{text}', 'Question: {text}'],
  'detail.answerOptions': ['可选回答', 'Suggested answers'],
  'detail.answerPlaceholder': ['输入回答…', 'Type an answer…'],
  'detail.answerSubmit': ['提交回答', 'Submit answer'],
  'detail.answerRequired': ['请先填写回答。', 'Type an answer first.'],
  'detail.answerSent': ['回答已提交，执行将继续。', 'Answer submitted; the run continues.'],
  'detail.answerHistory': ['此前的回答（{count}）', 'Previous answers ({count})'],
  'detail.resume': ['继续执行', 'Resume run'],
  'detail.resumeBusy': ['正在继续…', 'Resuming…'],
  'detail.resumed': ['已继续执行。', 'Run resumed.'],
  'detail.resumeTitle': ['继续这个中断的运行？', 'Resume this interrupted run?'],
  'detail.resumeConfirm': ['会从中断的检查点继续；没有检查点时重跑整单：{title}',
    'Continues from the interrupted checkpoint (re-runs the Ticket when there is none): {title}'],
  'detail.interruptedHint': ['上一次运行被插件重载或宿主重启中断，可以从检查点继续。',
    'The last run was interrupted by a plugin reload or host restart; it can resume from its checkpoint.'],

  // ---- P2-1: ticket-level automation ----------------------------------------------------------------------------
  'auto.section': ['自动化', 'Automation'],
  'auto.enabled': ['自动运行', 'Run automatically'],
  'auto.mode': ['模式', 'Mode'],
  'auto.modeOff': ['关闭', 'Off'],
  'auto.modeHeartbeat': ['固定间隔', 'Fixed interval'],
  'auto.modeSchedule': ['每天', 'Daily'],
  'auto.interval': ['间隔（分钟）', 'Interval (minutes)'],
  'auto.intervalHint': ['10–1440 分钟；固定间隔每次到点自动跑一轮。', '10–1440 minutes; each heartbeat runs one automatic round.'],
  'auto.at': ['每天时间', 'Time of day'],
  'auto.atHint': ['本机本地时间，格式 HH:mm。', 'Local machine time, HH:mm.'],
  'auto.maxExecutions': ['执行次数上限', 'Execution limit'],
  'auto.maxExecutionsPlaceholder': ['不限', 'Unlimited'],
  'auto.maxExecutionsHint': ['留空表示不限；只统计自动触发的次数。', 'Leave empty for unlimited; only automatic runs are counted.'],
  'auto.save': ['保存自动化', 'Save automation'],
  'auto.saved': ['自动化已保存。', 'Automation saved.'],
  'auto.disabledNote': ['保存后生效；仍受「执行器启用」、推送权限与暂停开关约束。',
    'Takes effect on save; still bounded by “executor enabled”, push permission and the pause switch.'],
  'auto.nextRun': ['下次运行', 'Next run'],
  'auto.executions': ['自动执行', 'Auto executions'],
  'auto.executionsValue': ['{count} 次', '{count}×'],
  'auto.executionsLimit': ['{count} / {max} 次', '{count} / {max}'],
  'auto.lastRun': ['上次运行', 'Last run'],
  'auto.lastSkip': ['上次跳过原因', 'Last skip reason'],
  'auto.lastTrigger': ['上次触发方式', 'Last trigger'],
  'auto.triggerHeartbeat': ['固定间隔', 'Heartbeat'],
  'auto.triggerSchedule': ['每天定时', 'Daily schedule'],

  // ---- P2-2: gate onFail policy + automatic repair rounds --------------------------------------------------------
  'gate.onFailAutoRepair': ['自动修复', 'Auto-repair'],
  'gate.onFailManual': ['人工', 'Manual'],
  'gate.onFailHintAutoRepair': ['失败时先尝试自动修复，仍失败才停下等人。', 'On failure the executor first tries an automatic repair, then parks for a person.'],
  'gate.onFailHintManual': ['失败时直接停下等人处理。', 'On failure the run parks for a person immediately.'],
  'detail.repairRun': ['自动修复 {attempts}/{max} 轮', 'Auto-repair {attempts}/{max}'],
  'detail.repairRunHint': ['这一轮执行里自动修复的轮数与结果（maxRepairRounds 控制上限）。',
    'Automatic repair rounds in this run and their outcome (bounded by maxRepairRounds).'],
  'detail.repairSucceeded': ['成功', 'Succeeded'],
  'detail.repairFailed': ['失败', 'Failed'],
  'detail.repairExhausted': ['已用尽', 'Exhausted'],
  'detail.repairNone': ['未触发', 'Not triggered'],
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

/** Gate names with a translated label (standards/backend/frontend); an unknown gate keeps its raw name. */
const TICKET_GATE_NAMES = ['standards', 'backend', 'frontend']
function ticketGateLabel(t, name) {
  const text = String(name ?? '')
  return TICKET_GATE_NAMES.includes(text) ? pt(t, `gate.${text}`) : (text || '—')
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

/** worker event type (P0 §1.1 trace) → icon, label and the shape its row gets. */
const TRACE_KINDS = {
  assistant: { icon: 'message', state: 'ongoing', labelKey: 'ticket.traceAssistant' },
  tool_call: { icon: 'settings', state: 'ongoing', labelKey: 'ticket.traceToolCall' },
  tool_result: { icon: 'check', state: 'done', labelKey: 'ticket.traceToolResult' },
  turn_end: { icon: 'circle-check', state: 'done', labelKey: 'ticket.traceTurnEnd' },
  error: { icon: 'alert-triangle', state: 'error', labelKey: 'ticket.traceError' },
}
const TRACE_LIMIT = 80

/** The normalised worker events kept on the run (never more than 80), folded under the run so evidence stays secondary. */
function RunTrace({ run }) {
  const { t } = usePanel()
  const trace = Array.isArray(run?.trace) ? run.trace.filter(event => event && typeof event === 'object') : []
  if (!trace.length) return null
  const shown = trace.slice(-TRACE_LIMIT)
  return h(Folded, { summary: pt(t, 'ticket.traceCount', { count: shown.length }) },
    h('ol', { className: 'sa-timeline' }, shown.map((event, index) => {
      const kind = TRACE_KINDS[event.type] ?? { icon: 'circle', state: 'idle', labelKey: 'ticket.traceAssistant' }
      const summary = typeof event.summary === 'string' ? event.summary.slice(0, 300) : ''
      return h('li', { key: index, className: 'sa-event' },
        h('div', { className: 'sa-event-actor' },
          h(StatusIcon, { state: kind.state, size: 13, spin: false }),
          typeof event.at === 'string' && event.at ? h(TicketStamp, { at: event.at }) : null,
          h('span', null, pt(t, kind.labelKey)),
          event.name ? h('span', { className: 'sa-mono sa-hint' }, String(event.name)) : null),
        summary ? h('p', { className: 'sa-event-text' }, summary) : null)
    })))
}

/** P1-2: the handoff an executor leaves behind (what is done, what comes next), folded under its run. */
function RunHandoff({ run }) {
  const { t } = usePanel()
  const handoff = run?.handoff
  const summary = typeof handoff?.summary === 'string' ? handoff.summary.trim() : ''
  const nextAction = typeof handoff?.nextAction === 'string' ? handoff.nextAction.trim() : ''
  const changed = Array.isArray(handoff?.changedPaths) ? handoff.changedPaths.filter(path => typeof path === 'string') : []
  if (!summary && !nextAction && !changed.length) return null
  return h(Folded, { summary: pt(t, 'detail.handoff') },
    summary ? h('p', { className: 'sa-event-text' }, summary) : null,
    changed.length ? h('p', { className: 'sa-hint' }, h('span', { className: 'sa-mono' }, changed.join(' · '))) : null,
    nextAction ? h('p', { className: 'sa-hint' }, pt(t, 'detail.handoffNext', { next: nextAction })) : null)
}

/** P1-4: the worker's own report (progress / artifacts / verify). A parked question is handled by the answer banner. */
function RunReport({ run }) {
  const { t } = usePanel()
  const report = run?.report
  if (!report || typeof report !== 'object') return null
  const progress = Array.isArray(report.progress) ? report.progress.filter(entry => entry && typeof entry === 'object') : []
  const artifacts = Array.isArray(report.artifacts) ? report.artifacts.filter(entry => entry && typeof entry === 'object') : []
  const verify = Array.isArray(report.verify) ? report.verify.filter(entry => entry && typeof entry === 'object') : []
  if (!progress.length && !artifacts.length && !verify.length) return null
  return h(Folded, { summary: pt(t, 'detail.report') },
    progress.length
      ? h('div', null,
        h('p', { className: 'sa-hint' }, pt(t, 'detail.reportProgress', { count: progress.length })),
        h('ul', { className: 'sa-list' }, progress.map((entry, index) => h('li', { key: index, className: 'sa-row' },
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' }, h('span', null, String(entry.text ?? ''))),
            entry.at ? h('div', { className: 'sa-row-meta' }, h(When, { at: entry.at })) : null)))))
      : null,
    artifacts.length
      ? h('div', null,
        h('p', { className: 'sa-hint' }, pt(t, 'detail.reportArtifacts', { count: artifacts.length })),
        h('ul', { className: 'sa-list' }, artifacts.map((entry, index) => h('li', { key: index, className: 'sa-row' },
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' }, h('span', { className: 'sa-mono' }, String(entry.path ?? ''))),
            entry.note ? h('div', { className: 'sa-row-meta' }, h('span', { className: 'sa-hint' }, String(entry.note))) : null)))))
      : null,
    verify.length
      ? h('div', null,
        h('p', { className: 'sa-hint' }, pt(t, 'detail.reportVerify', { count: verify.length })),
        h('ul', { className: 'sa-list' }, verify.map((entry, index) => h('li', { key: index, className: 'sa-row' },
          h('div', { className: 'sa-row-main' },
            h('div', { className: 'sa-row-title' }, h('span', null, String(entry.name ?? ''))),
            h('div', { className: 'sa-row-meta' },
              entry.command ? h('span', { className: 'sa-mono' }, String(entry.command)) : null,
              entry.expectedOutput
                ? h('span', { className: 'sa-hint' }, pt(t, 'detail.reportExpected', { text: String(entry.expectedOutput) }))
                : null))))))
      : null)
}

/** P2-2: gate failure policy labels (contract §1.1); a missing field always means `manual`. */
const GATE_ONFAIL_KEYS = { auto_repair: 'gate.onFailAutoRepair', manual: 'gate.onFailManual' }
const gateOnFail = value => (value === 'auto_repair' ? 'auto_repair' : 'manual')
/** The acceptance record already carries each gate's policy on its plan/checks; the run gate entry may too. */
function gateOnFailOf(gate, record) {
  const direct = gate?.onFail
  if (direct === 'auto_repair' || direct === 'manual') return direct
  const round = latestAcceptanceRound(record)
  const entries = [...(Array.isArray(round?.checks) ? round.checks : []), ...(Array.isArray(round?.plan) ? round.plan : [])]
  const entry = entries.find(item => item && (item.id === gate?.name || item.name === gate?.name))
  return gateOnFail(entry?.onFail)
}
/** Repair status → label key/tone (run.repair and round.repair share the vocabulary). */
const REPAIR_STATUS_KEYS = { succeeded: 'detail.repairSucceeded', failed: 'detail.repairFailed', exhausted: 'detail.repairExhausted' }
const REPAIR_STATUS_TONE = { succeeded: 'success', failed: 'danger', exhausted: 'warning' }
const repairLabel = (t, repair) => {
  const status = String(repair?.status ?? '')
  const key = REPAIR_STATUS_KEYS[status]
  return key ? pt(t, key) : String(status || '')
}

/**
 * P2-2 gate results: the same three gates as the shared GateSummary, plus each gate's failure policy. The policy comes
 * from the run gate entry, the acceptance plan/checks, or (older payloads) defaults to manual — never throws.
 */
function TicketGateResults({ ticket, record }) {
  const { t } = usePanel()
  const { gates } = latestGatesOf(ticket)
  if (!gates.length) return h(Hint, null, pt(t, 'gate.none'))
  return h('div', { className: 'sa-gates' },
    ['standards', 'backend', 'frontend'].map(name => {
      const gate = gates.find(entry => entry.name === name)
      if (!gate) return h('span', { key: name, className: 'sa-gate sa-hint' }, `${pt(t, `gate.${name}`)} —`)
      const ok = gate.exitCode === 0 && !gate.timedOut
      const policy = gateOnFailOf(gate, record)
      return h('span', { key: name, className: 'sa-gate' },
        h(StatusText, { state: ok ? 'done' : 'error' }, pt(t, `gate.${name}`)),
        h(Tag, { tone: policy === 'auto_repair' ? 'info' : 'outline', title: pt(t, policy === 'auto_repair' ? 'gate.onFailHintAutoRepair' : 'gate.onFailHintManual') },
          pt(t, GATE_ONFAIL_KEYS[policy])))
    }))
}

/** Acceptance record status → label key (P1-3). Unknown values stay visible instead of being hidden. */
const ACCEPTANCE_STATUS_KEYS = { unverified: 'detail.acceptStatus.unverified', verifying: 'detail.acceptStatus.verifying',
  delivered: 'detail.acceptStatus.delivered', accepted: 'detail.acceptStatus.accepted',
  rejected: 'detail.acceptStatus.rejected', closed: 'detail.acceptStatus.closed', errored: 'detail.acceptStatus.errored' }
const ACCEPTANCE_TONE = { unverified: 'outline', verifying: 'info', delivered: 'success', accepted: 'success',
  rejected: 'danger', closed: 'neutral', errored: 'danger' }
const ACCEPTANCE_CHECK_KEYS = { pending: 'detail.acceptCheck.pending', passed: 'detail.acceptCheck.passed',
  failed: 'detail.acceptCheck.failed', errored: 'detail.acceptCheck.errored', skipped: 'detail.acceptCheck.skipped' }
const ACCEPTANCE_CHECK_TONE = { pending: 'outline', passed: 'success', failed: 'danger', errored: 'danger', skipped: 'neutral' }
const ACCEPTANCE_CHECK_STATE = { pending: 'ongoing', passed: 'done', failed: 'error', errored: 'error', skipped: 'idle' }
const ACCEPTANCE_INTENTS = ['unmet', 'new-idea', 'no-evidence']
const ACCEPTANCE_INTENT_KEYS = { unmet: 'detail.intentUnmet', 'new-idea': 'detail.intentNewIdea', 'no-evidence': 'detail.intentNoEvidence' }
const acceptanceStatusLabel = (t, status) => {
  const key = ACCEPTANCE_STATUS_KEYS[String(status ?? '')]
  return key ? pt(t, key) : String(status ?? '—')
}
/** The latest round of an acceptance record; a record without rounds is still shown (status + requirement). */
function latestAcceptanceRound(record) {
  const rounds = Array.isArray(record?.rounds) ? record.rounds.filter(round => round && typeof round === 'object') : []
  return rounds.length ? rounds[rounds.length - 1] : null
}

/** P1-3: one acceptance record — status, newest round, its checks and the person's last decision. */
function AcceptanceRecordCard({ record }) {
  const { t } = usePanel()
  if (!record || typeof record !== 'object') return null
  const status = String(record.status ?? '')
  const round = latestAcceptanceRound(record)
  const checks = Array.isArray(round?.checks) ? round.checks.filter(check => check && typeof check === 'object') : []
  const plan = Array.isArray(round?.plan) ? round.plan.filter(item => item && typeof item === 'object') : []
  const repair = round?.repair && typeof round.repair === 'object' ? round.repair : undefined
  const onFailOfCheck = check => gateOnFail(check?.onFail
    ?? plan.find(item => item.id === check?.id || item.name === check?.name)?.onFail)
  const decision = round?.userDecision && typeof round.userDecision === 'object' ? round.userDecision : undefined
  const intents = Array.isArray(decision?.intents) ? decision.intents.filter(intent => typeof intent === 'string') : []
  return h('div', { className: 'sa-card' },
    h('div', { className: 'sa-card-head' },
      h('span', { className: 'sa-card-title' }, pt(t, 'detail.acceptRecord')),
      h('span', { className: 'sa-actions' },
        h(Tag, { tone: ACCEPTANCE_TONE[status] ?? 'outline' }, acceptanceStatusLabel(t, status)),
        round ? h('span', { className: 'sa-hint' },
          pt(t, 'detail.acceptRound', { round: round.roundIndex ?? '—', status: acceptanceStatusLabel(t, round.status) })) : null,
        // P2-2: a round that needed automatic repair says how many rounds it used and how it ended.
        repair && repair.status && repair.status !== 'none'
          ? h(Tag, { tone: REPAIR_STATUS_TONE[String(repair.status)] ?? 'outline',
            title: pt(t, 'detail.repairRunHint') },
          `${pt(t, 'detail.repairRun', { attempts: Number(repair.attempts) || 0, max: Number(repair.max) || 0 })} · ${repairLabel(t, repair)}`)
          : null)),
    record.requirement ? h('p', { className: 'sa-hint' }, pt(t, 'detail.acceptRequirement', { text: String(record.requirement) })) : null,
    checks.length
      ? h('div', { style: { marginTop: 'var(--sa-sp-8)' } },
        h('p', { className: 'sa-hint' }, pt(t, 'detail.acceptChecks', { count: checks.length })),
        h('ul', { className: 'sa-list' }, checks.map((check, index) => {
          const checkStatus = String(check.status ?? '')
          const outputTail = typeof check.outputTail === 'string' ? check.outputTail : ''
          return h('li', { key: check.id ?? index, className: 'sa-row' },
            h(StatusIcon, { state: ACCEPTANCE_CHECK_STATE[checkStatus] ?? 'idle', size: 14, spin: false }),
            h('div', { className: 'sa-row-main' },
              h('div', { className: 'sa-row-title' },
                h('span', null, String(check.name ?? check.id ?? '—')),
                h(Tag, { tone: ACCEPTANCE_CHECK_TONE[checkStatus] ?? 'outline' },
                  pt(t, ACCEPTANCE_CHECK_KEYS[checkStatus] ?? 'detail.acceptCheck.pending')),
                // P2-2: each check states whether its gate is auto-repaired or waits for a person (missing = manual).
                h(Tag, { tone: onFailOfCheck(check) === 'auto_repair' ? 'info' : 'outline',
                  title: pt(t, onFailOfCheck(check) === 'auto_repair' ? 'gate.onFailHintAutoRepair' : 'gate.onFailHintManual') },
                pt(t, GATE_ONFAIL_KEYS[onFailOfCheck(check)])),
                Number.isFinite(check.exitCode) ? h('span', { className: 'sa-mono sa-hint' }, `exit ${check.exitCode}`) : null,
                check.timedOut ? h(Tag, { tone: 'warning' }, pt(t, 'runStop.timeout')) : null),
              check.note ? h('div', { className: 'sa-row-meta' }, h('span', { className: 'sa-hint' }, String(check.note))) : null,
              outputTail
                ? h(Folded, { summary: pt(t, 'detail.acceptCheckOutput') },
                  h('div', { className: 'sa-actions' }, h(CopyButton, { value: outputTail })),
                  h('pre', { className: 'sa-pre' }, outputTail))
                : null))
        })))
      : h(Hint, null, pt(t, 'detail.acceptNoChecks')),
    decision
      ? h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-8)', flexWrap: 'wrap' } },
        h(Tag, { tone: decision.decision === 'rejected' ? 'danger' : 'success' },
          pt(t, `detail.userDecision.${decision.decision === 'rejected' ? 'rejected' : decision.decision === 'overridden' ? 'overridden' : 'accepted'}`)),
        decision.at ? h(When, { at: decision.at }) : null,
        decision.note ? h('span', { className: 'sa-hint' }, String(decision.note)) : null,
        intents.length
          ? h('span', { className: 'sa-hint' },
            `${pt(t, 'detail.acceptIntents')}：${intents.map(intent => pt(t, ACCEPTANCE_INTENT_KEYS[intent] ?? intent)).join('、')}`)
          : null)
      : null)
}

/** P1-7 activity row labels; an unknown kind stays raw so a new host event is never swallowed. */
const ACTIVITY_KIND_KEYS = { created: 'activity.created', status: 'activity.status', trigger: 'activity.trigger',
  run: 'activity.run', gate: 'activity.gate', acceptance: 'activity.acceptance', reply: 'activity.reply',
  dismiss: 'activity.dismiss', comment: 'activity.comment', resume: 'activity.resume' }
const ACTIVITY_ICON = { agent: 'robot', system: 'shield', user: 'user' }

/** P1-7: the ticket's own activity stream, newest first; the page shows the latest 20 and says how many remain. */
function TicketActivities({ activities }) {
  const { t } = usePanel()
  const list = Array.isArray(activities) ? activities.filter(entry => entry && typeof entry === 'object') : []
  const shown = list.slice(0, 20)
  return h(Fragment, null,
    h('ol', { className: 'sa-timeline' }, shown.map((entry, index) => {
      const kind = String(entry.kind ?? '')
      const actor = String(entry.actorKind ?? 'system')
      const transition = entry.from || entry.to ? `${entry.from ?? '—'} → ${entry.to ?? '—'}` : ''
      return h('li', { key: entry.id ?? index, className: 'sa-event' },
        h('div', { className: 'sa-event-actor' },
          h(Icon, { name: ACTIVITY_ICON[actor] ?? 'circle', size: 13 }),
          entry.at ? h(TicketStamp, { at: entry.at }) : null,
          h('span', null, pt(t, ACTIVITY_KIND_KEYS[kind] ?? kind)),
          transition ? h('span', { className: 'sa-hint' }, transition) : null),
        entry.detail ? h('p', { className: 'sa-event-text' }, String(entry.detail)) : null)
    })),
    list.length > shown.length ? h('p', { className: 'sa-hint' }, pt(t, 'ticket.activityMore', { total: list.length, shown: shown.length })) : null)
}

/** Run records, newest first: status, stop reason, start time, branch/commit and the failure cause in plain words (the raw
    text is on hover; gates live in their own section; a worker trace folds out under its run). */
function TicketRunRows({ runs }) {
  const { t } = usePanel()
  return h('ul', { className: 'sa-list' }, runs.map(run => {
    const view = ticketStatus({ status: run.status })
    const stop = runStopLabel(t, run)
    const trigger = runTriggerLabel(t, run)
    const repair = run?.repair && typeof run.repair === 'object' ? run.repair : undefined
    const repairStatus = String(repair?.status ?? '')
    const commit = typeof run.commit === 'string' ? run.commit : run.commit?.sha
    return h('li', { key: run.id, className: 'sa-row' },
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h(StatusIcon, { state: view.state, size: 14 }),
          h('span', null, pt(t, view.labelKey)),
          trigger ? h(Tag, { tone: 'outline' }, trigger) : null,
          stop ? h(Tag, { tone: stop.tone }, stop.label) : null,
          // P2-2: only a run that actually attempted repair says so; every other run keeps the row untouched.
          repair && repairStatus !== 'none'
            ? h(Tag, { tone: REPAIR_STATUS_TONE[repairStatus] ?? 'outline', title: pt(t, 'detail.repairRunHint') },
              `${pt(t, 'detail.repairRun', { attempts: Number(repair.attempts) || 0, max: Number(repair.max) || 0 })} · ${repairLabel(t, repair)}`)
            : null,
          run.dryRun ? h(Tag, { tone: 'outline' }, pt(t, 'ticket.dryTag')) : null,
          run.startedAt ? h(When, { at: run.startedAt }) : null,
          h('span', { className: 'sa-mono sa-hint' }, liveShortId(run.id))),
        h('div', { className: 'sa-row-meta' },
          run.branch ? h('span', { className: 'sa-mono' }, run.branch) : null,
          commit ? h('span', { className: 'sa-mono' }, liveShortId(commit, 8)) : null,
          Array.isArray(run.steps) ? h('span', { className: 'sa-hint' }, pt(t, 'ticket.stepsCount', { count: run.steps.length })) : null),
        run.error ? h('p', { className: 'sa-error', title: String(run.error) }, failureLabel(t, run.error)) : null,
        h(RunHandoff, { run }),
        h(RunReport, { run }),
        h(RunTrace, { run })))
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

/** The three automation modes, mirroring lib/live/schedule.js AUTOMATION_MODES. */
const AUTOMATION_MODES = ['off', 'heartbeat', 'schedule']

/** Form snapshot of one stored automation: numbers stay strings until save so a half-typed field is never coerced. */
function automationFormOf(automation) {
  const value = automation && typeof automation === 'object' ? automation : {}
  const mode = AUTOMATION_MODES.includes(value.mode) ? value.mode : 'off'
  const interval = Number(value.intervalMinutes)
  return {
    enabled: value.enabled === true && mode !== 'off',
    mode,
    intervalMinutes: Number.isFinite(interval) && interval > 0 ? String(interval) : '60',
    at: /^\d{2}:\d{2}$/.test(String(value.at ?? '')) ? String(value.at) : '09:00',
    maxExecutions: value.maxExecutions === null || value.maxExecutions === undefined ? '' : String(value.maxExecutions),
  }
}

/**
 * P2-1 automation card: the operator sets how a Ticket runs itself. The block only exists for a Ticket that already
 * carries an automation config (an older host, or a Ticket that never opted in, renders nothing).
 */
function AutomationCard({ ticket, onSaved }) {
  const { t, notify } = usePanel()
  const model = usePanelData()
  const act = model?.actions
  const automation = ticket?.automation && typeof ticket.automation === 'object' ? ticket.automation : undefined
  const signature = JSON.stringify(automation ?? null)
  const [form, setForm] = useState(() => automationFormOf(automation))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState(undefined)
  // Re-sync only when the stored config actually changed (a poll of unchanged data never wipes a half-typed form).
  useEffect(() => { setForm(automationFormOf(automation)) }, [signature])
  // A Ticket without a stored config still needs an entry point to opt in; only the terminal "put away" states hide
  // the card (a dismissed/closed Ticket will never run again by schedule).
  const update = patch => setForm(previous => ({ ...previous, ...patch }))
  const setMode = mode => setForm(previous => ({ ...previous, mode,
    enabled: mode === 'off' ? false : (previous.mode === mode ? previous.enabled : true) }))
  const save = async () => {
    if (saving || !act?.setAutomation) return
    setSaving(true)
    setFailure(undefined)
    try {
      const patch = { mode: form.mode, enabled: form.enabled }
      if (form.mode === 'heartbeat') patch.intervalMinutes = Number(form.intervalMinutes)
      if (form.mode === 'schedule') patch.at = form.at
      const limit = String(form.maxExecutions ?? '').trim()
      patch.maxExecutions = limit === '' ? null : Number(limit)
      await act.setAutomation(ticket.id, patch)
      notify(pt(t, 'auto.saved'))
      await onSaved?.()
    } catch (error) {
      setFailure(error)
    } finally {
      setSaving(false)
    }
  }
  const heartbeat = form.mode === 'heartbeat'
  const schedule = form.mode === 'schedule'
  // A Ticket without a stored config still gets the card (off state); every fact reads the empty object, never crashes.
  const stored = automation ?? {}
  const executions = Math.max(0, Number(stored.executions) || 0)
  const maxExecutions = Number.isFinite(Number(stored.maxExecutions)) ? Number(stored.maxExecutions) : undefined
  const facts = [
    [pt(t, 'auto.nextRun'), stored.nextAt ? h(When, { at: stored.nextAt }) : '—'],
    [pt(t, 'auto.executions'), maxExecutions !== undefined
      ? pt(t, 'auto.executionsLimit', { count: executions, max: maxExecutions })
      : pt(t, 'auto.executionsValue', { count: executions })],
  ]
  if (stored.lastRunAt) facts.push([pt(t, 'auto.lastRun'), h(When, { at: stored.lastRunAt })])
  if (stored.lastTrigger) {
    facts.push([pt(t, 'auto.lastTrigger'),
      pt(t, stored.lastTrigger === 'schedule' ? 'auto.triggerSchedule' : 'auto.triggerHeartbeat')])
  }
  if (stored.lastSkipReason) facts.push([pt(t, 'auto.lastSkip'), autoSkipReasonText(t, stored.lastSkipReason)])
  return h(Section, { id: 'sa-automation', title: pt(t, 'auto.section') },
    h('div', { className: 'sa-card' },
      h('div', { className: 'sa-card-head' },
        h('span', { className: 'sa-card-title' }, automationSummaryText(t, stored) || pt(t, 'auto.modeOff')),
        h('span', { className: 'sa-actions' },
          h('span', { className: 'sa-hint' }, pt(t, 'auto.enabled')),
          h(Switch, { checked: form.enabled, onChange: value => update({ enabled: value }), label: pt(t, 'auto.enabled') }))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'auto.mode')),
        h(SegmentedControl, { value: form.mode, onChange: setMode, label: pt(t, 'auto.mode'),
          options: [{ value: 'off', label: pt(t, 'auto.modeOff') },
            { value: 'heartbeat', label: pt(t, 'auto.modeHeartbeat') },
            { value: 'schedule', label: pt(t, 'auto.modeSchedule') }] })),
      heartbeat
        ? h('div', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'auto.interval')),
          h(Input, { type: 'number', min: 10, max: 1440, step: 5, value: form.intervalMinutes,
            'aria-label': pt(t, 'auto.interval'), onChange: event => update({ intervalMinutes: event.target.value }) }),
          h('small', null, pt(t, 'auto.intervalHint')))
        : null,
      schedule
        ? h('div', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'auto.at')),
          h(Input, { type: 'time', value: form.at, 'aria-label': pt(t, 'auto.at'),
            onChange: event => update({ at: event.target.value }) }),
          h('small', null, pt(t, 'auto.atHint')))
        : null,
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'auto.maxExecutions')),
        h(Input, { type: 'number', min: 1, max: 10000, value: form.maxExecutions,
          placeholder: pt(t, 'auto.maxExecutionsPlaceholder'), 'aria-label': pt(t, 'auto.maxExecutions'),
          onChange: event => update({ maxExecutions: event.target.value }) }),
        h('small', null, pt(t, 'auto.maxExecutionsHint'))),
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'primary', size: 'sm', icon: 'check', disabled: saving || !act?.setAutomation,
          onClick: () => { void save() } }, pt(t, 'auto.save')),
        h('span', { className: 'sa-hint' }, pt(t, 'auto.disabledNote'))),
      failure ? h('p', { className: 'sa-error', role: 'alert' }, errorText(failure)) : null,
      h('div', { style: { marginTop: 'var(--sa-sp-8)' } }, h(KeyValues, { rows: facts }))))
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
  const acceptFail = useAction(async intents => {
    await act.acceptTicket(id, { ok: false, intents: Array.isArray(intents) ? intents : undefined })
    notify(pt(t, 'ticket.rejectRecorded'))
  }, { reload: refreshAll })
  const dismiss = useAction(async () => {
    const result = await act.dismissTicket(id, '手动忽略')
    const cleanup = result?.cleanup ?? result?.ticket?.links?.cleanup
    notify(pt(t, cleanup ? 'detail.dismissRecorded' : 'detail.dismissRecordedBare'))
    return cleanup
  }, { reload: refreshAll })
  // P0 gate decisions (contract §3.2): release skips the gate and delivers, retry re-runs the gates, stop fails the
  // Ticket. Each one reloads both the detail and the shared status model, so the parked state never lingers on screen.
  const gateRelease = useAction(async () => { await act.gateAction(id, 'release'); notify(pt(t, 'detail.gateReleased')) },
    { reload: refreshAll })
  const gateRetry = useAction(async () => { await act.gateAction(id, 'retry'); notify(pt(t, 'detail.gateRetried')) },
    { reload: refreshAll })
  const gateStop = useAction(async () => { await act.gateAction(id, 'stop'); notify(pt(t, 'detail.gateStopped')) },
    { reload: refreshAll })
  // P1-5: resume an interrupted run from its checkpoint (the host falls back to re-running the whole Ticket).
  const resume = useAction(async () => { await act.resumeTicket(id); notify(pt(t, 'detail.resumed')) }, { reload: refreshAll })
  // P1-4: the answer buffer stays local until submitted; answering re-runs the Ticket as a new run.
  const [answerText, setAnswerText] = useState('')
  // P1-3: rejection intents are optional checkboxes next to the reject button.
  const [rejectIntents, setRejectIntents] = useState([])
  const answer = useAction(async () => {
    const text = String(answerText ?? '').trim()
    if (!text) { notify(pt(t, 'detail.answerRequired')); return }
    await act.answerTicket(id, text)
    setAnswerText('')
    notify(pt(t, 'detail.answerSent'))
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
  // P0 §3.6.6: a missing Ticket (404) is an empty state — "找不到该工单" — not a broken connection with a retry that
  // can never succeed. Any other failure keeps the URL and offers a retry.
  if (error?.missing && !data) return h(EmptyState, { icon: 'inbox', title: pt(t, 'detail.ticketMissing'), hint: pt(t, 'detail.ticketMissingHint'),
    action: h(Button, { variant: 'outline', size: 'sm', onClick: back }, t('back')) })
  if (error && !data) return h(ErrorState, { error, onRetry: reload })
  if (loading) return h(Skeleton, { rows: 5 })

  const ticket = data?.ticket ?? {}
  const runs = Array.isArray(data?.runs) ? data.runs : []
  const trigger = data?.trigger
  const decision = data?.decision
  const thread = data?.thread
  const config = model?.data?.config ?? {}
  const view = ticketStatus(ticket)
  const acceptanceView = ticketAcceptanceOf(ticket)
  // The parked gate lives on the Ticket (decorate passes it through) with the run as the fallback source of truth.
  const pendingGate = ticket.pendingGate
    ?? runs.find(run => run && run.id === ticket.runId && run.pendingGate)?.pendingGate
    ?? runs.find(run => run && run.pendingGate)?.pendingGate
  const gateBlocked = ticket.status === 'gate-blocked'
  // P1: the newest operation decides whether the run can be resumed; the parked question decides the answer banner.
  const latestRun = latestRunFor(ticket, runs)
  const interrupted = latestRun?.status === 'interrupted'
  const awaitingAnswer = ticket.status === 'awaiting-answer'
  const pendingQuestion = ticket.pendingQuestion ?? latestRun?.pendingQuestion
  const answerOptions = Array.isArray(pendingQuestion?.options) ? pendingQuestion.options.filter(option => typeof option === 'string') : []
  const previousAnswers = Array.isArray(ticket.answers) ? ticket.answers.filter(entry => entry && typeof entry === 'object') : []
  // P1-3 / P1-7 payloads are part of the ticket view; an older host simply has neither and the blocks stay hidden.
  const acceptanceRecord = data?.acceptance && typeof data.acceptance === 'object' ? data.acceptance : null
  const activities = Array.isArray(data?.activities) ? data.activities.filter(entry => entry && typeof entry === 'object') : []
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
  const primaryAction = awaitingAnswer
    // A parked question owns the primary slot: the answer form is the banner right below the header.
    ? h(Button, { variant: 'primary', size: 'sm', onClick: () =>
      document.getElementById('sa-answer')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, pt(t, 'primary.answer'))
    : failed
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
        // A parked gate owns the primary slot: the three decisions live in the banner right below the header.
        : gateBlocked
          ? h(Button, { variant: 'primary', size: 'sm', onClick: () =>
            document.getElementById('sa-gate')?.scrollIntoView({ block: 'start', behavior: 'smooth' }) }, pt(t, 'primary.gate'))
          // P1-5: an interrupted run is resumable, so it outranks the generic dry-run action.
          : interrupted
            ? h(Button, { variant: 'primary', size: 'sm', disabled: resume.busy || !canRun,
              title: canRun ? undefined : pt(t, 'ticket.retryUnavailable'),
              onClick: () => { void resume.run() } }, pt(t, resume.busy ? 'detail.resumeBusy' : 'detail.resume'))
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
  // P0 gate banner: what parked the run and the three human decisions; the failing output is folded and copyable.
  const gateBanner = gateBlocked
    ? h('div', { id: 'sa-gate', className: 'sa-banner', role: 'alert',
      style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' } },
      h(StatusIcon, { state: 'warning', size: 16, spin: false }),
      h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' } },
        h('strong', { style: { fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 } },
          pt(t, 'detail.gateTitle', { name: ticketGateLabel(t, pendingGate?.name) })),
        h('p', { className: 'sa-hint' }, pt(t, 'detail.gateIntro')),
        h(KeyValues, { rows: [
          [pt(t, 'detail.gateExit'), pendingGate?.exitCode === undefined ? '—' : String(pendingGate.exitCode)],
          [pt(t, 'detail.gateTimedOut'), pendingGate?.timedOut ? pt(t, 'detail.gateYes') : pt(t, 'detail.gateNo')],
          ...(Array.isArray(pendingGate?.changedPaths) && pendingGate.changedPaths.length
            ? [[pt(t, 'detail.gateChanged'), h('span', { className: 'sa-mono' }, pendingGate.changedPaths.join(' · '))]] : []),
        ] }),
        pendingGate?.outputTail
          ? h(Folded, { summary: pt(t, 'detail.gateOutput') },
            h('div', { className: 'sa-actions' }, h(CopyButton, { value: String(pendingGate.outputTail) })),
            h('pre', { className: 'sa-pre' }, String(pendingGate.outputTail)))
          : h(Hint, null, pt(t, 'detail.gateNoOutput')),
        h('div', { className: 'sa-actions' },
          h(ConfirmButton, { label: pt(t, 'detail.gateRelease'), title: pt(t, 'detail.gateReleaseTitle'),
            message: pt(t, 'detail.gateReleaseConfirm', { name: ticketGateLabel(t, pendingGate?.name),
              title: ticket.title ?? ticket.id }),
            variant: 'primary', icon: 'play', onConfirm: async () => { await gateRelease.run() } }),
          h(Button, { variant: 'outline', size: 'sm', icon: 'refresh', disabled: gateRetry.busy,
            onClick: () => { void gateRetry.run() } }, pt(t, 'detail.gateRetry')),
          h(ConfirmButton, { label: pt(t, 'detail.gateStop'), title: pt(t, 'detail.gateStopTitle'),
            message: pt(t, 'detail.gateStopConfirm', { title: ticket.title ?? ticket.id }),
            variant: 'danger', icon: 'stop', onConfirm: async () => { await gateStop.run() } }))))
    : null
  // P1-4 answer banner: the worker asked a question, so the one thing on screen is the question and the answer box.
  const answerQuestion = typeof pendingQuestion?.question === 'string' ? pendingQuestion.question : ''
  const answerBanner = awaitingAnswer
    ? h('div', { id: 'sa-answer', className: 'sa-banner', role: 'alert',
      style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' } },
      h(StatusIcon, { state: 'warning', size: 16, spin: false }),
      h('div', { style: { minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-8)' } },
        h('strong', { style: { fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 } }, pt(t, 'detail.answerTitle')),
        h('p', { className: 'sa-hint' }, pt(t, 'detail.answerHint')),
        answerQuestion ? h('p', null, pt(t, 'detail.answerQuestion', { text: answerQuestion })) : null,
        answerOptions.length
          ? h('div', { className: 'sa-actions' },
            h('span', { className: 'sa-hint' }, pt(t, 'detail.answerOptions')),
            answerOptions.map((option, index) => h(Button, { key: index, variant: 'outline', size: 'sm',
              onClick: () => setAnswerText(option) }, option)))
          : null,
        h('div', { className: 'sa-actions', style: { alignItems: 'flex-end' } },
          h('textarea', { className: 'sa-textarea', rows: 2, value: answerText,
            placeholder: pt(t, 'detail.answerPlaceholder'), 'aria-label': pt(t, 'detail.answerPlaceholder'),
            onChange: event => setAnswerText(event.target.value) }),
          h(Button, { variant: 'primary', size: 'sm', icon: 'message',
            disabled: answer.busy || !String(answerText ?? '').trim(),
            onClick: () => { void answer.run() } }, pt(t, 'detail.answerSubmit'))),
        previousAnswers.length
          ? h(Folded, { summary: pt(t, 'detail.answerHistory', { count: previousAnswers.length }) },
            h('ul', { className: 'sa-list' }, previousAnswers.map((entry, index) => h('li', { key: index, className: 'sa-row' },
              h('div', { className: 'sa-row-main' },
                h('div', { className: 'sa-row-title' }, h('span', null, String(entry.answer ?? ''))),
                entry.at ? h('div', { className: 'sa-row-meta' }, h(When, { at: entry.at })) : null)))))
          : null))
    : null
  // P1-5 interrupted banner: the reason the resume action exists, so the phase label is never read as a healthy queue.
  const interruptedStop = interrupted ? runStopLabel(t, latestRun) : null
  const interruptedBanner = interrupted
    ? h('div', { className: 'sa-banner', style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' } },
      h(StatusIcon, { state: 'warning', size: 16, spin: false }),
      h('div', { style: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' } },
        h('strong', { style: { fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 } },
          interruptedStop ? interruptedStop.label : pt(t, 'ticketState.interrupted')),
        h('p', { className: 'sa-hint' }, pt(t, 'detail.interruptedHint'))))
    : null
  const jumps = [
    { id: 'sa-ticket-changes', labelKey: 'ticket.changes' },
    { id: 'sa-acceptance', labelKey: 'ticket.acceptCard' },
    { id: 'sa-ticket-stages', labelKey: 'ticket.stages' },
    { id: 'sa-ticket-gates', labelKey: 'ticket.gates' },
    { id: 'sa-ticket-runs', labelKey: 'ticket.runs' },
    { id: 'sa-ticket-activities', labelKey: 'ticket.activities' },
    { id: 'sa-ticket-timeline', labelKey: 'ticket.timeline' },
  ]
  const jumpTo = id => {
    setActiveJump(id)
    const node = document.getElementById(id)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start' })
  }

  // P0 §3.6.6: the person's sign-off is a fact of the Ticket, so it gets its own line under the header instead of being
  // discoverable only by scrolling into the acceptance card. The jump lands on that card (`#sa-acceptance` exists).
  const acceptanceLine = acceptanceView.state === 'none'
    ? null
    : h('p', { className: 'sa-hint', style: { margin: 'var(--sa-sp-4) 0', display: 'flex', alignItems: 'center', gap: 'var(--sa-sp-8)' } },
      h('span', null, acceptanceView.state === 'pending' ? pt(t, 'detail.acceptLinePending')
        : acceptanceView.state === 'accepted'
          ? pt(t, 'detail.acceptLineAccepted', { time: ticketStamp(acceptanceView.at) || '—' })
          : pt(t, 'detail.acceptLineRejected', { time: ticketStamp(acceptanceView.at) || '—' })),
      h('button', { type: 'button', className: 'sa-textlink', onClick: () => jumpTo('sa-acceptance') },
        pt(t, acceptanceView.state === 'pending' ? 'detail.acceptLineJump' : 'detail.acceptLineView')))

  return h(Fragment, null,
    h(PageHead, { headRef, title: ticket.title ?? pt(t, 'ticket.loading'),
      meta: h(Fragment, null,
        h(TicketStatusTag, { ticket }),
        h('span', { className: 'sa-mono' }, liveShortId(ticket.id, 10)),
        ticket.id ? h(CopyButton, { value: ticket.id, label: pt(t, 'detail.copyTicketId') }) : null,
        ticket.updatedAt ? h(When, { at: ticket.updatedAt }) : null,
        repoName ? h('span', { className: 'sa-hint' }, `${pt(t, 'repo.label')}：${repoName}`) : null) }),
    acceptanceLine,
    error ? h(ErrorState, { error, onRetry: reload }) : null,
    answerBanner,
    interruptedBanner,
    failureBanner,
    gateBanner,
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
      // P1-3: the acceptance rounds (status, newest round, checks, last decision) lead the block when the host has them.
      acceptanceRecord
        ? h('div', { style: { marginBottom: 'var(--sa-sp-8)' } }, h(AcceptanceRecordCard, { record: acceptanceRecord }))
        : null,
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
          // P1-3: rejection intents are optional; they ride on the accept POST only when at least one is ticked.
          h('div', { className: 'sa-actions', style: { flexWrap: 'wrap', alignItems: 'center' } },
            h('span', { className: 'sa-hint' }, pt(t, 'detail.acceptIntentsHint')),
            ...ACCEPTANCE_INTENTS.map(intent => h('label', { key: intent,
              style: { display: 'inline-flex', alignItems: 'center', gap: 'var(--sa-sp-4)', fontSize: 'var(--sa-fs-meta)' } },
            h('input', { type: 'checkbox', checked: rejectIntents.includes(intent),
              onChange: event => setRejectIntents(previous => event.target.checked
                ? [...previous, intent] : previous.filter(item => item !== intent)) }),
            h('span', null, pt(t, ACCEPTANCE_INTENT_KEYS[intent]))))),
          h('div', { className: 'sa-actions' },
            h(ConfirmButton, { label: pt(t, 'ticket.acceptPass'), title: pt(t, 'ticket.acceptPassTitle'),
              message: pt(t, 'ticket.acceptPassConfirm', { title: ticket.title ?? ticket.id }),
              variant: 'primary', icon: 'decision', onConfirm: async () => { await acceptPass.run() } }),
            h(ConfirmButton, { label: pt(t, 'ticket.acceptFail'), title: pt(t, 'ticket.acceptFailTitle'),
              message: pt(t, 'ticket.acceptFailConfirm', { title: ticket.title ?? ticket.id }),
              variant: 'outline', icon: 'blocked', onConfirm: async () => { await acceptFail.run(rejectIntents) } })))
        : !canAccept && !accepted
          ? h(Hint, null, pt(t, acceptMode === 'merged' ? 'ticket.acceptOnlyMerged' : 'ticket.acceptOnlyDeployed'))
          : null),

    // P2-1: the Ticket's own automation config (a Ticket without config renders the card in the off state so the
    // operator can opt in; dismissed/closed Tickets do not offer scheduling).
    ['dismissed', 'closed'].includes(ticket.status) ? null : h(AutomationCard, { ticket, onSaved: refreshAll }),

    // 3. Stage rail, 4. gate results, 5. run records, 6. timeline (older events folded by default).
    h(Section, { id: 'sa-ticket-stages', title: pt(t, 'ticket.stages') }, h(StageRail, { ticket: { ...ticket, runs }, detail: true })),
    h(Section, { id: 'sa-ticket-gates', title: pt(t, 'ticket.gates') },
      h(TicketGateResults, { ticket: { ...ticket, runs }, record: acceptanceRecord })),
    h(Section, { id: 'sa-ticket-runs', title: pt(t, 'ticket.runs'), count: runs.length },
      runs.length ? h(TicketRunRows, { runs }) : h(Hint, null, pt(t, 'ticket.noRuns'))),
    // P1-7: the host's own activity stream (newest first) sits between the run records and the derived timeline.
    h(Section, { id: 'sa-ticket-activities', title: pt(t, 'ticket.activities'), count: activities.length },
      activities.length ? h(TicketActivities, { activities }) : h(Hint, null, pt(t, 'ticket.activityEmpty'))),
    h(Section, { id: 'sa-ticket-timeline', title: pt(t, 'ticket.timeline'), count: events.length },
      h(TicketTimeline, { ticket, runs })),

    // Secondary evidence and the raw escape hatch stay at the bottom.
    h(Folded, { summary: pt(t, 'ticket.auth') },
      h(KeyValues, { rows: authRows }),
      rules.length ? h(Folded, { summary: pt(t, 'thread.rulesDetail') }, h(ThreadRuleRows, { rules })) : null),
    h(RawValue, { label: pt(t, 'ticket.raw'), json: data }))
}
