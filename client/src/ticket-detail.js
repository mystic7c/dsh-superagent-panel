import { Icon, safeHttpUrl, shortId } from "./util.js"
import { errorText, fullTime, localized, reasonLabel, timeLocale, when } from "./i18n.js"
import { Button, CopyButton, InfoTip, Input, Menu, Modal, SegmentedControl, StatusIcon, StatusText, Switch, Tag } from "./controls.js"
import { same, stay, useAction, usePanel, usePanelData } from "./api.js"
import { ConfirmButton, EmptyState, ErrorState, ExternalLink, Folded, Hint, KeyValues, MarkdownLite, PageHead, RawValue, Section, Skeleton, When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { routeLabel } from "./router.js"
import { useLiveResource } from "./live-model.js"
import { GateSummary, MergeRequestCard, StageRail, TicketRow, TicketStatusTag, UatCard, autoSkipReasonText, automationSummaryText, failureKnown, failureLabel, latestGatesOf, latestRunFor, liveShortId, liveText, panelDefaultRepo, panelRepos, repoAcceptanceText, repoVerifyModeText, runStopLabel, runTriggerLabel, runView, ticketAcceptanceOf, ticketStatus } from "./live-ui.js"
import { ThreadRuleRows } from "./thread-detail.js"
import { React, h, useCallback, useEffect, useRef, useState } from "./react.js"

Object.assign(PAGE_TEXT, {
  'wf.progress': ['执行流程', 'Execution workflow'],
  'wf.assess': ['难度评估', 'Assessment'], 'wf.plan': ['方案设计', 'Planning'],
  'wf.implement': ['实现', 'Implementation'], 'wf.gates': ['程序闸门', 'Gates'],
  'wf.review': ['独立验收', 'Independent review'],
  // Host workflow state and stage status are backend enums; render them through these keys (unknown values stay raw).
  'wf.statePending': ['待开始', 'Pending'], 'wf.stateRunning': ['进行中', 'Running'],
  'wf.stateAssess': ['评估中', 'Assessing'], 'wf.statePlan': ['规划中', 'Planning'],
  'wf.stateImplement': ['实现中', 'Implementing'], 'wf.stateGates': ['闸门检查中', 'Checking gates'],
  'wf.stateReview': ['评审中', 'Reviewing'], 'wf.stateBlocked': ['已阻塞', 'Blocked'],
  'wf.stateReady': ['已就绪', 'Ready'],
  'wf.stagePending': ['等待', 'Pending'], 'wf.stageRunning': ['进行中', 'Running'],
  'wf.stageCompleted': ['已完成', 'Completed'], 'wf.stageFailed': ['失败', 'Failed'],
  'wf.stageBlocked': ['已阻塞', 'Blocked'],
})
/* Ticket detail (spec 6.5 / 7.4): changes → acceptance → stage rail → gate results → run records → timeline,
   with the authorization basis and the raw JSON folded at the bottom. Actions are one state-following primary action
   plus a ⋯ menu; destructive ones always confirm (retry, publish MR, accept/reject).
   Data: GET engine/ticket/:id (host increments, contract §4), refreshed every 10s. */

Object.assign(PAGE_TEXT, {
  'detail.failedTitle': ['这次执行失败', 'This run failed'],
  'detail.failedSteps': ['失败步骤：{steps}', 'Failed steps: {steps}'],
  'detail.failedNoChanges': ['执行器没有检测到任何文件改动。检查工单正文是否包含可执行的需求，或看「运行记录」里的 worker 输出后重试。',
    'The executor saw no file changes. Check that the request text is actionable, review the worker output under Run records, then retry.'],
  'detail.failedCli': ['本地 CLI 不可用或未登录。安装/登录 CLI，或在「设置 → Worker → CLI 路径」填写绝对路径后重试。',
    'The local CLI is missing or not logged in. Install/log in, or set its absolute path under Settings → Worker → CLI path, then retry.'],
  // P1 routing: who ran (or would run) a Ticket, independent of ticket status.
  'detail.routeSuggest': ['建议 {backend} · {workType}', 'suggested {backend} · {workType}'],
  'detail.routeLabel': ['执行路由', 'Route'],
  'detail.routeSuggested': ['建议', 'suggested'],
  'detail.routeApplied': ['{backend} · {workType}', '{backend} · {workType}'],
  'detail.routeReadOnly': ['只读', 'read-only'],
  'detail.routeWrite': ['可写', 'write'],
  'detail.workType.analysis': ['需求分析', 'analysis'],
  'detail.workType.review': ['代码 review', 'code review'],
  'detail.workType.test': ['功能测试验证', 'verification'],
  'detail.workType.dev': ['代码开发', 'development'],
  'detail.workType.docs': ['文档', 'documentation'],
  'detail.workType.research': ['联网调研', 'web research'],
  'detail.workType.interactive': ['需提问/确认', 'interactive'],
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
  'detail.acceptCleanupDone': ['本地工作区与分支已清理', 'Local worktree and branch cleaned up'],
  'detail.acceptCleanupFailedShort': ['验收已记录，但本地工作区清理失败', 'Accepted; local cleanup failed'],
  'detail.acceptCleanupFailed': ['验收已记录，但本地工作区清理失败：{reason}', 'Accepted; local cleanup failed: {reason}'],
  'ticket.dryRunUnavailable': ['执行器未启用，干跑不可用。', 'The executor is disabled; dry run is unavailable.'],

  // ---- P1 §3.2: the run's worktree diff, read on demand (the executor never stores the patch) --------------------
  'ticket.diffOpenFile': ['查看 {path} 的 diff', 'View the diff of {path}'],
  'ticket.autoVerifyLimit': ['自动巡检已在同一提交上用完 3 次，不会继续刷新；点右上角 ⋯ →「核对合并/UAT」手动刷新。',
    'Automatic checks for this commit are used up; open ··· → “Verify merge/UAT” to refresh.'],
  'ticket.diffTitle': ['改动 diff', 'Change diff'],
  'ticket.diffLoading': ['正在读取 diff…', 'Reading the diff…'],
  'ticket.diffUnavailable': ['这个工单没有可读取的工作树（可能已被清理，或还没执行）。diff 只在该次执行的工作树还在时可用。',
    'This Ticket has no readable worktree (it may be cleaned up or not run yet); the diff is only available while the worktree still exists.'],
  'ticket.diffNotGit': ['工作树不是 git 工作树，读不了 diff。', 'The worktree is not a git work tree, so its diff cannot be read.'],
  'ticket.diffFailed': ['读取 diff 失败（git 报错）。', 'Reading the diff failed (git error).'],
  'ticket.diffTicketGone': ['这个工单已经不在引擎里（可能被删除或重置），这次执行的 diff 读不到了。',
    'This Ticket is no longer in the engine (it may have been deleted or reset), so the diff of that run cannot be read.'],
  'ticket.diffEmpty': ['这次执行没有留下改动。', 'This run left no changes.'],
  'ticket.diffSummary': ['{files} 个文件 · +{additions} −{deletions}', '{files} files · +{additions} −{deletions}'],
  'ticket.diffRun': ['运行 {run}', 'Run {run}'],
  'ticket.diffBase': ['基线 {sha}', 'Base {sha}'],
  'ticket.diffCopy': ['复制 diff', 'Copy diff'],
  'ticket.diffTruncated': ['diff 超过 {limit}，只显示前面一部分；{omitted} 个文件未显示。',
    'The diff is larger than {limit}; only its first part is shown and {omitted} files are omitted.'],
  'ticket.diffOmitted': ['{count} 个文件未显示（过大或属于敏感路径）。', '{count} files are omitted (too large or sensitive paths).'],

  // ---- P2: append requirements and rerun on the same worktree ---------------------------------------------------
  'ticket.revisionTitle': ['追加要求（重跑）', 'Add a requirement (rerun)'],
  'ticket.revisionHint': ['会保留当前工作树的改动，按追加要求重跑一遍干跑；跑完再看新 diff，确认后再发布。',
    'Keeps the current worktree changes and reruns the Ticket as a dry run; review the new diff, then publish.'],
  'ticket.revisionPlaceholder': ['哪里不对、要改成什么、验收标准…', 'What is wrong, what to change, how it will be accepted…'],
  'ticket.revisionSubmit': ['追加并重跑', 'Add and rerun'],
  'ticket.revisionRequired': ['先写要追加的要求', 'Write the requirement first'],
  'ticket.revisionStarted': ['已追加要求，开始干跑重跑', 'Requirement added; dry run started'],
  'ticket.revisionHistory': ['修订历史（{count}）', 'Revisions ({count})'],
  'ticket.revisionWorking': ['工单正在执行，等这一轮结束再追加要求。', 'The Ticket is running; add the requirement after this run.'],
  'ticket.revisionAwaitingAnswer': ['工单在等你回答 worker 的问题，请先用「回答」再追加要求。',
    'The Ticket is waiting for your answer; answer it first.'],
  'ticket.revisionEnded': ['工单已结束或已验收，不能再追加要求。', 'The Ticket ended or was accepted; no further requirements.'],

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
  'detail.gatePendingTag': ['未通过 · 待处理', 'Failed · pending'],
  'detail.gatePolicy': ['失败策略：{policy}', 'Failure policy: {policy}'],
  'detail.gatePolicyMixed': ['失败策略按闸门不同', 'Failure policy differs per gate'],
  'detail.gateYes': ['是', 'Yes'],
  'detail.gateNo': ['否', 'No'],

  // ---- P0: independent acceptance line under the header ----------------------------------------------------------
  'detail.acceptLinePending': ['待你验收', 'Waiting for your sign-off'],
  'detail.acceptLineAccepted': ['已验收 · {time}', 'Accepted · {time}'],
  'detail.acceptLineRejected': ['已打回 · {time}', 'Rejected · {time}'],
  'detail.evidenceTitle': ['交付证据', 'Delivery evidence'],
  'detail.evidenceEmpty': ['这段交付还没有持久化的证据（旧工单或尚未跑完）。缺少历史时不推断“已修复”。',
    'No persisted evidence for this delivery yet (an older Ticket or a run that has not delivered). Missing history never means “fixed”.'],
  'detail.evidenceRound': ['第 {round} 轮', 'Round {round}'],
  'detail.evidenceFiles': ['{count} 个文件', '{count} files'],
  'detail.evidenceGates': ['闸门 {passed}/{total}', 'Gates {passed}/{total}'],
  'detail.evidenceCompare': ['与上一轮对比：新增 {added}，删除 {removed}，修改 {changed}；闸门变化 {gates} 项。',
    'Compared with the previous round: +{added} added, -{removed} removed, {changed} changed; {gates} gate change(s).'],
  'detail.evidencePlatform': ['推送 {pushed} · PR {pr} · 合并 {merged} · 部署 {deployed} · 验收 {accepted}',
    'pushed {pushed} · PR {pr} · merged {merged} · deployed {deployed} · accepted {accepted}'],
  'detail.evidenceYes': ['是', 'yes'],
  'detail.evidenceBranch': ['分支', 'Branch'],
  'detail.evidenceFilesLabel': ['改动文件', 'Changed files'],
  'detail.evidenceSummary': ['本轮 worker 总结', 'Worker summary for this round'],
  'detail.evidenceNoHistory': ['只有这一轮证据，无法比较上一轮；不推断“已修复”。',
    'Only this round is on file; there is no previous round to compare, so nothing is claimed as fixed.'],
  'detail.evidenceNo': ['否', 'no'],
  'detail.evidenceRequirements': ['验收要求变化：新增 {added}；移除 {removed}。',
    'Acceptance requirements changed: added {added}; removed {removed}.'],
  'detail.evidenceNotRerun': ['未重跑：{names}。这些结果不能算本轮已通过。',
    'Not re-run: {names}. These results cannot count as passing in this round.'],
  'detail.evidenceDeploy': ['部署 commit {sha}', 'Deployment commit {sha}'],
  'detail.evidenceIncomplete': ['证据不完整：上一轮文件列表截断 {previousOmitted} 项、脱敏 {previousRedacted} 项；本轮截断 {currentOmitted} 项、脱敏 {currentRedacted} 项。缺失项不当作删除。',
    'Incomplete evidence: the previous file list lost {previousOmitted} to truncation and {previousRedacted} to redaction; this round lost {currentOmitted} and {currentRedacted}. Missing entries are not counted as deletions.'],
  'detail.evidenceUncertain': ['无法确认新增 {added}、删除 {removed}：对应轮次的文件列表不完整。',
    'Additions ({added}) and deletions ({removed}) cannot be confirmed: the file list on that side is incomplete.'],
  'detail.evidencePatchTruncated': ['本轮 patch 已截断（保留 {bytes}\u00A0字节），不是完整改动。',
    'This round\'s patch was truncated ({bytes}\u00A0bytes kept); it is not the full change.'],
  'detail.evidenceBaseline': ['基线已变化（{from} → {to}），上一轮的闸门结果不能直接沿用。',
    'The baseline changed ({from} → {to}); the previous round\'s gate results cannot be reused as-is.'],
  'detail.evidenceUnfinished': ['本轮仍未通过：{names}。',
    'Still not passing in this round: {names}.'],
  'detail.evidenceStale': ['以下闸门沿用了旧代码的结果，需要重跑：{names}。',
    'These gates reused results from older code and must be re-run: {names}.'],
  'detail.evidenceNone': ['无', 'none'],
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
  'ticket.activityFold': ['宿主活动记录（{count}）', 'Host activity ({count})'],
  'ticket.filesShowAll': ['显示更多（共 {count} 个）', 'Show all ({count})'],
  'ticket.filesCollapse': ['收起', 'Collapse'],
  'ticket.activityEmpty': ['还没有活动记录。', 'No activity yet.'],
  'ticket.activityMore': ['共 {total} 条，显示最近 {shown} 条', '{total} total, showing the latest {shown}'],
  'activity.created': ['创建工单', 'Ticket created'], 'activity.status': ['状态变化', 'Status changed'],
  'activity.trigger': ['触发', 'Triggered'], 'activity.run': ['执行', 'Run'], 'activity.gate': ['闸门', 'Gate'],
  'activity.acceptance': ['验收', 'Acceptance'], 'activity.reply': ['回复来源', 'Replied to the Source'],
  'activity.dismiss': ['忽略', 'Dismissed'], 'activity.comment': ['评论', 'Comment'], 'activity.resume': ['恢复', 'Resumed'],
  'activity.revision': ['追加要求', 'Revision'],

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
  'detail.stoppedHint': ['上一次运行已按人工请求停止，工作树与检查点保留，可以继续执行。',
    'The last run was stopped by a person; its worktree and checkpoint are kept and it can resume.'],
  'detail.interruptedHint': ['上一次运行被插件重载或宿主重启中断，可以从检查点继续。',
    'The last run was interrupted by a plugin reload or host restart; it can resume from its checkpoint.'],
  'detail.resumeWorkflowTitle': ['从断点继续？', 'Continue where it stopped?'],
  'detail.resumeWorkflowConfirm': ['不会重跑已完成的分析、实现与闸门：只从停下的那一步继续（失败的一步，或验收要求修改后的下一轮返工），通过后提交、推送并按仓库策略开 MR。要整单重来请用「重试执行」：{title}',
    'Finished assessment, implementation and gates are kept: only the stage where it stopped runs again (the failed one, or the next repair round after a rejection), then the change is committed, pushed and delivered as MR. Use Retry to start over: {title}'],

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
  'auto.maxExecutionsPlaceholder': ['例如：10', 'e.g. 10'],
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
  'gate.exitCode': ['exit {code}', 'exit {code}'],
  'gate.timedOut': ['超时', 'Timed out'],
  'gate.passed': ['通过', 'Passed'],
  'gate.failed': ['未通过', 'Failed'],
  'detail.repairRun': ['自动修复 {attempts}/{max} 轮', 'Auto-repair {attempts}/{max}'],
  'detail.repairRunHint': ['这一轮执行里自动修复的轮数与结果（maxRepairRounds 控制上限）。',
    'Automatic repair rounds in this run and their outcome (bounded by maxRepairRounds).'],
  'detail.repairSucceeded': ['成功', 'Succeeded'],
  'detail.repairFailed': ['失败', 'Failed'],
  'detail.repairExhausted': ['已用尽', 'Exhausted'],
  'detail.repairNone': ['未触发', 'Not triggered'],

  // ---- WIG a11y/UX audit (2026-11-13): action-specific confirms and the small copy fixes --------------------------
  'detail.confirmRetry': ['重试执行', 'Retry run'],
  'detail.confirmPublish': ['发布并开 MR', 'Publish and open MR'],
  'detail.confirmStop': ['终止工单', 'Stop Ticket'],
  'detail.confirmDismiss': ['忽略并删除分支', 'Dismiss and delete branch'],
  'detail.confirmResume': ['从断点继续', 'Resume from checkpoint'],
  'detail.confirmGateRelease': ['放行闸门', 'Release gate'],
  'detail.confirmAcceptPass': ['确认验收通过', 'Accept delivery'],
  'detail.confirmAcceptFail': ['确认打回', 'Reject delivery'],
  'detail.prNone': ['无', 'none'],
  'detail.answerLabel': ['你的回答', 'Your answer'],
  'detail.dismissCleanupFailed': ['已忽略该工单，但清理失败：{reason}。本地分支或工作树可能仍在，请手动清理。',
    'Ticket dismissed, but cleanup failed: {reason}. The local branch or worktree may still exist; clean it up manually.'],
  'auto.intervalInvalid': ['间隔必须是 10–1440 之间的整数分钟。', 'Interval must be a whole number of minutes between 10 and 1440.'],
  'auto.atInvalid': ['时间格式应为 HH:mm。', 'Time must use the HH:mm format.'],
  'auto.maxExecutionsInvalid': ['执行次数上限应为 1–10000 的整数，或留空。',
    'Execution limit must be a whole number between 1 and 10000, or empty.'],
  'auto.saving': ['保存中…', 'Saving…'],
  'ticket.traceCountOmitted': ['执行轨迹（共 {count} 条，显示最近 {shown} 条）',
    'Execution trace ({count} total, latest {shown} shown)'],
})

/** Run step name → PAGE_TEXT key suffix; gate steps are labelled with their gate name. */
export const TICKET_STEP_KEYS = {
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

export function ticketStepLabel(t, name) {
  const text = String(name ?? '')
  if (text.startsWith('gate:')) return `${pt(t, 'ticket.step.gate')}：${pt(t, `gate.${text.slice(5)}`)}`
  const key = TICKET_STEP_KEYS[text]
  return key ? pt(t, `ticket.step.${key}`) : text
}

/** Gate names with a translated label (standards/backend/frontend); an unknown gate keeps its raw name. */
export const TICKET_GATE_NAMES = ['standards', 'backend', 'frontend']
export function ticketGateLabel(t, name) {
  const text = String(name ?? '')
  return TICKET_GATE_NAMES.includes(text) ? pt(t, `gate.${text}`) : (text || '—')
}

/** run step state → status shape. */
export const STEP_STATE = { ok: 'done', running: 'ongoing', failed: 'error', pending: 'idle' }

/** Absolute short stamp for the detail timeline and the acceptance line; the full time goes in title. */
export function ticketStamp(value, lang) {
  const date = new Date(value ?? '')
  if (Number.isNaN(date.getTime())) return typeof value === 'string' ? value : ''
  // Intl keeps the stamp consistent with when/fullTime and follows the active language (it used to be a hand-rolled
  // fixed `MM-DD HH:mm`, which ignored the English locale entirely).
  return new Intl.DateTimeFormat(timeLocale(lang), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)
}

/** Scrolls stay instant for reduced-motion users; the shared util helper is owned by another file, so this one is local. */
export function ticketReduceMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/** Timeline timestamps are read as absolute times first (critique #11): no "20 小时前" at the start of a row. */
export function TicketStamp({ at }) {
  const { t } = usePanel()
  return <time dateTime={at} title={fullTime(at, t.lang)}>{ticketStamp(at, t.lang)}</time>
}

/**
 * One event stream for the ticket: created, the *final* state of every run step, and the verification result.
 *
 * The executor logs a step twice while it runs (a `running` transition, then the final state), so a naive dump shows
 * every step as a spinner-looking "turn" followed by a duplicate check. Only the last state per step per run is a
 * fact worth showing; transient `running`/`pending` rows and the duplicated dry-run start are dropped here.
 */
export function ticketEvents(t, ticket, runs) {
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
        ?? (step.exitCode !== undefined ? pt(t, 'gate.exitCode', { code: step.exitCode }) : ''))
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

export const TIMELINE_RECENT = 8
// A wide changes rail can hold dozens of paths; the list shows this many before the "show more" control.
export const CHANGES_FILES_RECENT = 5

/** Timeline with a vertical axis, shape-coded dots and a timestamp per event; long histories collapse to the latest. */
export function TicketTimeline({ ticket, runs }) {
  const { t } = usePanel()
  const [expanded, setExpanded] = useState(false)
  const events = ticketEvents(t, ticket, runs)
  const shown = expanded ? events : events.slice(-TIMELINE_RECENT)
  return <>
    {events.length > TIMELINE_RECENT
      ? <p className="sa-hint">{pt(t, 'ticket.timelineRecent', { count: shown.length, total: events.length })}</p>
      : null}
    <ol id="sa-timeline-events" className="sa-timeline">{shown.map((event, index) => <li key={index} className="sa-event">
      <div className="sa-event-actor">
        <StatusIcon state={event.state} size={14} />
        <TicketStamp at={event.at} />
        <span>{event.stepName ? ticketStepLabel(t, event.stepName) : pt(t, event.labelKey)}</span>
        {event.dry ? <Tag tone="outline">{pt(t, 'ticket.dryTag')}</Tag> : null}
      </div>
      {event.sha
        ? <div className="sa-actions">
          <code className="sa-mono" title={event.sha}>{String(event.sha).slice(0, 7)}</code>
          <CopyButton value={event.sha} />
          {event.detail ? <span className="sa-hint" title={event.detailTitle}>{event.detail}</span> : null}
        </div>
        : event.detail ? <p className="sa-event-text" title={event.detailTitle}>{event.detail}</p> : null}
    </li>)}</ol>
    {events.length > TIMELINE_RECENT
      ? <div className="sa-actions" style={{ marginTop: 'var(--sa-sp-8)' }}>
        <Button variant="ghost" size="sm" icon={expanded ? 'chevron-up' : 'chevron-down'}
          aria-expanded={expanded} aria-controls="sa-timeline-events"
          onClick={() => setExpanded(value => !value)}>
          {expanded ? pt(t, 'ticket.timelineCollapse') : pt(t, 'ticket.timelineShowAll', { count: events.length })}
        </Button>
      </div>
      : null}
  </>
}

/** worker event type (P0 §1.1 trace) → icon, label and the shape its row gets. */
export const TRACE_KINDS = {
  assistant: { icon: 'message', state: 'ongoing', labelKey: 'ticket.traceAssistant' },
  tool_call: { icon: 'settings', state: 'ongoing', labelKey: 'ticket.traceToolCall' },
  tool_result: { icon: 'check', state: 'done', labelKey: 'ticket.traceToolResult' },
  turn_end: { icon: 'circle-check', state: 'done', labelKey: 'ticket.traceTurnEnd' },
  error: { icon: 'alert-triangle', state: 'error', labelKey: 'ticket.traceError' },
}
export const TRACE_LIMIT = 80

/**
 * Folded renders its children even while closed; a trace of up to 80 rows should build its DOM only once opened
 * (audit P3). Markup and classes mirror the shared Folded, which stays untouched for the other pages.
 */
export function TicketLazyFolded({ summary, children }) {
  const [open, setOpen] = useState(false)
  return <details className="sa-folded" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary className="sa-folded-summary"><Icon name="chevron-right" size={14} /><span>{summary}</span></summary>
    {open ? <div className="sa-folded-body">{children}</div> : null}
  </details>
}

/** The normalised worker events kept on the run (never more than 80), folded under the run so evidence stays secondary. */
export function RunTrace({ run }) {
  const { t } = usePanel()
  const trace = Array.isArray(run?.trace) ? run.trace.filter(event => event && typeof event === 'object') : []
  if (!trace.length) return null
  const shown = trace.slice(-TRACE_LIMIT)
  const omitted = trace.length - shown.length
  // The title counts every event and names the omitted tail instead of silently rendering "the last 80" (audit P3).
  const summary = omitted > 0
    ? pt(t, 'ticket.traceCountOmitted', { count: trace.length, shown: shown.length })
    : pt(t, 'ticket.traceCount', { count: trace.length })
  return <TicketLazyFolded summary={summary}>
    <ol className="sa-timeline">{shown.map((event, index) => {
      const kind = TRACE_KINDS[event.type] ?? { icon: 'circle', state: 'idle', labelKey: 'ticket.traceAssistant' }
      const full = typeof event.summary === 'string' ? event.summary : ''
      // A clipped summary says so and keeps the full text reachable on hover/focus (audit P3).
      const text = full.length > 300 ? `${full.slice(0, 300)}…` : full
      return <li key={index} className="sa-event">
        <div className="sa-event-actor">
          <StatusIcon state={kind.state} size={13} spin={false} />
          {typeof event.at === 'string' && event.at ? <TicketStamp at={event.at} /> : null}
          <span>{pt(t, kind.labelKey)}</span>
          {event.name ? <span className="sa-mono sa-hint">{String(event.name)}</span> : null}
        </div>
        {text ? <p className="sa-event-text" title={full.length > 300 ? full : undefined}>{text}</p> : null}
      </li>
    })}</ol>
  </TicketLazyFolded>
}

/** P1-2: the handoff an executor leaves behind (what is done, what comes next), folded under its run. */
export function RunHandoff({ run }) {
  const { t } = usePanel()
  const handoff = run?.handoff
  const summary = typeof handoff?.summary === 'string' ? handoff.summary.trim() : ''
  const nextAction = typeof handoff?.nextAction === 'string' ? handoff.nextAction.trim() : ''
  const changed = Array.isArray(handoff?.changedPaths) ? handoff.changedPaths.filter(path => typeof path === 'string') : []
  if (!summary && !nextAction && !changed.length) return null
  return <Folded summary={pt(t, 'detail.handoff')}>
    {summary ? <p className="sa-event-text">{summary}</p> : null}
    {changed.length ? <p className="sa-hint"><span className="sa-mono">{changed.join(' · ')}</span></p> : null}
    {nextAction ? <p className="sa-hint">{pt(t, 'detail.handoffNext', { next: nextAction })}</p> : null}
  </Folded>
}

/** P1-4: the worker's own report (progress / artifacts / verify). A parked question is handled by the answer banner. */
export function RunReport({ run }) {
  const { t } = usePanel()
  const report = run?.report
  if (!report || typeof report !== 'object') return null
  const progress = Array.isArray(report.progress) ? report.progress.filter(entry => entry && typeof entry === 'object') : []
  const artifacts = Array.isArray(report.artifacts) ? report.artifacts.filter(entry => entry && typeof entry === 'object') : []
  const verify = Array.isArray(report.verify) ? report.verify.filter(entry => entry && typeof entry === 'object') : []
  if (!progress.length && !artifacts.length && !verify.length) return null
  return <Folded summary={pt(t, 'detail.report')}>
    {progress.length
      ? <div>
        <p className="sa-hint">{pt(t, 'detail.reportProgress', { count: progress.length })}</p>
        <ul className="sa-list">{progress.map((entry, index) => <li key={index} className="sa-row">
          <div className="sa-row-main">
            <div className="sa-row-title"><span>{String(entry.text ?? '')}</span></div>
            {entry.at ? <div className="sa-row-meta"><TicketStamp at={entry.at} /></div> : null}
          </div>
        </li>)}</ul>
      </div>
      : null}
    {artifacts.length
      ? <div>
        <p className="sa-hint">{pt(t, 'detail.reportArtifacts', { count: artifacts.length })}</p>
        <ul className="sa-list">{artifacts.map((entry, index) => <li key={index} className="sa-row">
          <div className="sa-row-main">
            <div className="sa-row-title"><span className="sa-mono">{String(entry.path ?? '')}</span></div>
            {entry.note ? <div className="sa-row-meta"><span className="sa-hint">{String(entry.note)}</span></div> : null}
          </div>
        </li>)}</ul>
      </div>
      : null}
    {verify.length
      ? <div>
        <p className="sa-hint">{pt(t, 'detail.reportVerify', { count: verify.length })}</p>
        <ul className="sa-list">{verify.map((entry, index) => <li key={index} className="sa-row">
          <div className="sa-row-main">
            <div className="sa-row-title"><span>{String(entry.name ?? '')}</span></div>
            <div className="sa-row-meta">
              {entry.command ? <span className="sa-mono">{String(entry.command)}</span> : null}
              {entry.expectedOutput
                ? <span className="sa-hint">{pt(t, 'detail.reportExpected', { text: String(entry.expectedOutput) })}</span>
                : null}
            </div>
          </div>
        </li>)}</ul>
      </div>
      : null}
  </Folded>
}

/** P2-2: gate failure policy labels (contract §1.1); a missing field always means `manual`. */
export const GATE_ONFAIL_KEYS = { auto_repair: 'gate.onFailAutoRepair', manual: 'gate.onFailManual' }
export const gateOnFail = value => (value === 'auto_repair' ? 'auto_repair' : 'manual')
/** The acceptance record already carries each gate's policy on its plan/checks; the run gate entry may too. */
export function gateOnFailOf(gate, record) {
  const direct = gate?.onFail
  if (direct === 'auto_repair' || direct === 'manual') return direct
  const round = latestAcceptanceRound(record)
  const entries = [...(Array.isArray(round?.checks) ? round.checks : []), ...(Array.isArray(round?.plan) ? round.plan : [])]
  const entry = entries.find(item => item && (item.id === gate?.name || item.name === gate?.name))
  return gateOnFail(entry?.onFail)
}
/** Repair status → label key/tone (run.repair and round.repair share the vocabulary). */
export const REPAIR_STATUS_KEYS = { succeeded: 'detail.repairSucceeded', failed: 'detail.repairFailed', exhausted: 'detail.repairExhausted' }
export const REPAIR_STATUS_TONE = { succeeded: 'success', failed: 'danger', exhausted: 'warning' }
export const repairLabel = (t, repair) => {
  const status = String(repair?.status ?? '')
  const key = REPAIR_STATUS_KEYS[status]
  return key ? pt(t, key) : String(status || '')
}

/**
 * P2-2 gate results: the same three gates as the shared GateSummary, plus each gate's failure policy. The policy comes
 * from the run gate entry, the acceptance plan/checks, or (older payloads) defaults to manual — never throws.
 */
export function TicketGateResults({ ticket, record }) {
  const { t } = usePanel()
  const { run, gates } = latestGatesOf(ticket)
  // The parked gate is not in run.gates yet (only finished gates are recorded there), so without this the section
  // would say "还没有闸门结果" while the banner above reports a failed gate (T4). Both read the same pendingGate.
  const pending = ticket?.pendingGate
    ?? run?.pendingGate
    ?? (Array.isArray(ticket?.runs) ? ticket.runs.find(entry => entry?.pendingGate)?.pendingGate : undefined)
  if (!gates.length && !pending) return <Hint>{pt(t, 'gate.none')}</Hint>
  const policies = gates.map(gate => gateOnFailOf(gate, record))
  const sharedPolicy = policies.length && policies.every(policy => policy === policies[0]) ? policies[0] : undefined
  // Render the gates this run actually has. A repository can configure its own names (ebs-deploy, ebs-access, …), so a
  // fixed standards/backend/frontend list printed "— — —" while the rail above said "闸门 2/2" (critique 2026-11-11).
  const gateRow = (gate, index) => {
    const ok = gate.exitCode === 0 && !gate.timedOut
    const policy = gateOnFailOf(gate, record)
    // The label gets its outcome as a text alternative: shape+colour alone leaves a screen reader with a bare name.
    // `role="group"` makes that label a valid accessible name on a generic span (aria-label alone on a span is ignored).
    return <span key={`${gate.name ?? 'gate'}-${index}`} className="sa-gate" role="group"
      aria-label={`${ticketGateLabel(t, gate.name)} · ${pt(t, ok ? 'gate.passed' : 'gate.failed')}`}>
      <StatusText state={ok ? 'done' : 'error'}>{ticketGateLabel(t, gate.name)}</StatusText>
      {ok ? null : <span className="sa-hint">
        {gate.timedOut ? pt(t, 'gate.timedOut')
          : gate.exitCode !== undefined && gate.exitCode !== null ? pt(t, 'gate.exitCode', { code: gate.exitCode })
            : ''}
      </span>}
      {/* The failure policy is one fact about the Ticket's gates, so it is said once under the row; only a mixed set
          needs a tag per gate to tell them apart (T13). */}
      {sharedPolicy ? null : <Tag tone={policy === 'auto_repair' ? 'info' : 'outline'}
        title={pt(t, policy === 'auto_repair' ? 'gate.onFailHintAutoRepair' : 'gate.onFailHintManual')}>
        {pt(t, GATE_ONFAIL_KEYS[policy])}
      </Tag>}
    </span>
  }
  return <>
    <div className="sa-gates">
      {pending
        ? <span className="sa-gate" role="group"
          aria-label={`${ticketGateLabel(t, pending.name)} · ${pt(t, 'detail.gatePendingTag')}`}>
          <StatusText state="error">{ticketGateLabel(t, pending.name)}</StatusText>
          <Tag tone="warning">{pt(t, 'detail.gatePendingTag')}</Tag>
        </span>
        : null}
      {gates.map(gateRow)}
    </div>
    {gates.length
      ? <p className="sa-hint">{sharedPolicy
        ? pt(t, 'detail.gatePolicy', { policy: pt(t, GATE_ONFAIL_KEYS[sharedPolicy]) })
        : pt(t, 'detail.gatePolicyMixed')}</p>
      : null}
  </>
}

/** Acceptance record status → label key (P1-3). Unknown values stay visible instead of being hidden. */
export const ACCEPTANCE_STATUS_KEYS = { unverified: 'detail.acceptStatus.unverified', verifying: 'detail.acceptStatus.verifying',
  delivered: 'detail.acceptStatus.delivered', accepted: 'detail.acceptStatus.accepted',
  rejected: 'detail.acceptStatus.rejected', closed: 'detail.acceptStatus.closed', errored: 'detail.acceptStatus.errored' }
export const ACCEPTANCE_TONE = { unverified: 'outline', verifying: 'info', delivered: 'success', accepted: 'success',
  rejected: 'danger', closed: 'neutral', errored: 'danger' }
export const ACCEPTANCE_CHECK_KEYS = { pending: 'detail.acceptCheck.pending', passed: 'detail.acceptCheck.passed',
  failed: 'detail.acceptCheck.failed', errored: 'detail.acceptCheck.errored', skipped: 'detail.acceptCheck.skipped' }
export const ACCEPTANCE_CHECK_TONE = { pending: 'outline', passed: 'success', failed: 'danger', errored: 'danger', skipped: 'neutral' }
export const ACCEPTANCE_CHECK_STATE = { pending: 'ongoing', passed: 'done', failed: 'error', errored: 'error', skipped: 'idle' }
export const ACCEPTANCE_INTENTS = ['unmet', 'new-idea', 'no-evidence']
export const ACCEPTANCE_INTENT_KEYS = { unmet: 'detail.intentUnmet', 'new-idea': 'detail.intentNewIdea', 'no-evidence': 'detail.intentNoEvidence' }
export const acceptanceStatusLabel = (t, status) => {
  const key = ACCEPTANCE_STATUS_KEYS[String(status ?? '')]
  return key ? pt(t, key) : String(status ?? '—')
}
/** The latest round of an acceptance record; a record without rounds is still shown (status + requirement). */
export function latestAcceptanceRound(record) {
  const rounds = Array.isArray(record?.rounds) ? record.rounds.filter(round => round && typeof round === 'object') : []
  return rounds.length ? rounds[rounds.length - 1] : null
}

/** P1-3: one acceptance record — status, newest round, its checks and the person's last decision. */
export function AcceptanceRecordCard({ record }) {
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
  return <div className="sa-card">
    <div className="sa-card-head">
      <span className="sa-card-title">{pt(t, 'detail.acceptRecord')}</span>
      <span className="sa-actions">
        <Tag tone={ACCEPTANCE_TONE[status] ?? 'outline'}>{acceptanceStatusLabel(t, status)}</Tag>
        {round ? <span className="sa-hint">
          {pt(t, 'detail.acceptRound', { round: round.roundIndex ?? '—', status: acceptanceStatusLabel(t, round.status) })}
        </span> : null}
        {/* P2-2: a round that needed automatic repair says how many rounds it used and how it ended. */}
        {repair && repair.status && repair.status !== 'none'
          ? <Tag tone={REPAIR_STATUS_TONE[String(repair.status)] ?? 'outline'}
            title={pt(t, 'detail.repairRunHint')}>
            {`${pt(t, 'detail.repairRun', { attempts: Number(repair.attempts) || 0, max: Number(repair.max) || 0 })} · ${repairLabel(t, repair)}`}
          </Tag>
          : null}
      </span>
    </div>
    {record.requirement ? <p className="sa-hint">{pt(t, 'detail.acceptRequirement', { text: String(record.requirement) })}</p> : null}
    {checks.length
      ? <div style={{ marginTop: 'var(--sa-sp-8)' }}>
        <p className="sa-hint">{pt(t, 'detail.acceptChecks', { count: checks.length })}</p>
        <ul className="sa-list">{checks.map((check, index) => {
          const checkStatus = String(check.status ?? '')
          const outputTail = typeof check.outputTail === 'string' ? check.outputTail : ''
          return <li key={check.id ?? index} className="sa-row">
            <StatusIcon state={ACCEPTANCE_CHECK_STATE[checkStatus] ?? 'idle'} size={14} spin={false} />
            <div className="sa-row-main">
              <div className="sa-row-title">
                <span>{String(check.name ?? check.id ?? '—')}</span>
                <Tag tone={ACCEPTANCE_CHECK_TONE[checkStatus] ?? 'outline'}>
                  {pt(t, ACCEPTANCE_CHECK_KEYS[checkStatus] ?? 'detail.acceptCheck.pending')}
                </Tag>
                {/* P2-2: each check states whether its gate is auto-repaired or waits for a person (missing = manual). */}
                <Tag tone={onFailOfCheck(check) === 'auto_repair' ? 'info' : 'outline'}
                  title={pt(t, onFailOfCheck(check) === 'auto_repair' ? 'gate.onFailHintAutoRepair' : 'gate.onFailHintManual')}>
                  {pt(t, GATE_ONFAIL_KEYS[onFailOfCheck(check)])}
                </Tag>
                {Number.isFinite(check.exitCode) ? <span className="sa-mono sa-hint">{pt(t, 'gate.exitCode', { code: check.exitCode })}</span> : null}
                {check.timedOut ? <Tag tone="warning">{pt(t, 'runStop.timeout')}</Tag> : null}
              </div>
              {check.note ? <div className="sa-row-meta"><span className="sa-hint">{String(check.note)}</span></div> : null}
              {outputTail
                ? <Folded summary={pt(t, 'detail.acceptCheckOutput')}>
                  <div className="sa-actions"><CopyButton value={outputTail} /></div>
                  <pre className="sa-pre">{outputTail}</pre>
                </Folded>
                : null}
            </div>
          </li>
        })}</ul>
      </div>
      : <Hint>{pt(t, 'detail.acceptNoChecks')}</Hint>}
    {decision
      ? <div className="sa-actions" style={{ marginTop: 'var(--sa-sp-8)', flexWrap: 'wrap' }}>
        <Tag tone={decision.decision === 'rejected' ? 'danger' : 'success'}>
          {pt(t, `detail.userDecision.${decision.decision === 'rejected' ? 'rejected' : decision.decision === 'overridden' ? 'overridden' : 'accepted'}`)}
        </Tag>
        {decision.at ? <TicketStamp at={decision.at} /> : null}
        {decision.note ? <span className="sa-hint">{String(decision.note)}</span> : null}
        {intents.length
          ? <span className="sa-hint">
            {`${pt(t, 'detail.acceptIntents')}：${intents.map(intent => pt(t, ACCEPTANCE_INTENT_KEYS[intent] ?? intent)).join('、')}`}
          </span>
          : null}
      </div>
      : null}
  </div>
}

/** P1-7 activity row labels; an unknown kind stays raw so a new host event is never swallowed. */
export const ACTIVITY_KIND_KEYS = { created: 'activity.created', status: 'activity.status', trigger: 'activity.trigger',
  run: 'activity.run', gate: 'activity.gate', acceptance: 'activity.acceptance', reply: 'activity.reply',
  dismiss: 'activity.dismiss', comment: 'activity.comment', resume: 'activity.resume', revision: 'activity.revision' }
export const ACTIVITY_ICON = { agent: 'robot', system: 'shield', user: 'user' }

/** P1-7: the ticket's own activity stream, newest first; the page shows the latest 20 and says how many remain. */
export function TicketActivities({ activities }) {
  const { t } = usePanel()
  const list = Array.isArray(activities) ? activities.filter(entry => entry && typeof entry === 'object') : []
  const shown = list.slice(0, 20)
  return <>
    <ol className="sa-timeline">{shown.map((entry, index) => {
      const kind = String(entry.kind ?? '')
      const actor = String(entry.actorKind ?? 'system')
      const transition = entry.from || entry.to ? `${entry.from ?? '—'} → ${entry.to ?? '—'}` : ''
      return <li key={entry.id ?? index} className="sa-event">
        <div className="sa-event-actor">
          <Icon name={ACTIVITY_ICON[actor] ?? 'circle'} size={13} />
          {entry.at ? <TicketStamp at={entry.at} /> : null}
          <span>{pt(t, ACTIVITY_KIND_KEYS[kind] ?? kind)}</span>
          {transition ? <span className="sa-hint">{transition}</span> : null}
        </div>
        {entry.detail ? <p className="sa-event-text">{String(entry.detail)}</p> : null}
      </li>
    })}</ol>
    {list.length > shown.length ? <p className="sa-hint">{pt(t, 'ticket.activityMore', { total: list.length, shown: shown.length })}</p> : null}
  </>
}

/** P1 route tag: the work type and the backend that ran (or would run) this Ticket; suggest runs name both. */
export function runRouteTag(t, run) {
  const route = run?.route
  if (!route || typeof route !== 'object') return null
  const workType = pt(t, `detail.workType.${route.workType}`)
  const backend = route.execBackend ?? route.backend
  const text = route.applied
    ? pt(t, 'detail.routeApplied', { backend, workType })
    : pt(t, 'detail.routeSuggest', { backend: route.backend, workType })
  return <Tag tone={route.applied ? 'outline' : 'info'}
    title={`${pt(t, 'detail.routeReadOnly')} / ${pt(t, 'detail.routeWrite')} · ${route.profile ?? ''}`}>{text}</Tag>
}

/** Run records, newest first: status, stop reason, start time, branch/commit and the failure cause in plain words (the raw
    text is on hover; gates live in their own section; a worker trace folds out under its run). */
export function TicketRunRows({ runs }) {
  const { t } = usePanel()
  return <ul className="sa-list">{runs.map(run => {
    const view = runView(t, run)
    const stop = runStopLabel(t, run)
    const trigger = runTriggerLabel(t, run)
    const repair = run?.repair && typeof run.repair === 'object' ? run.repair : undefined
    const repairStatus = String(repair?.status ?? '')
    const commit = typeof run.commit === 'string' ? run.commit : run.commit?.sha
    return <li key={run.id} id={`sa-run-${run.id}`} className="sa-row">
      <div className="sa-row-main">
        <div className="sa-row-title">
          <StatusIcon state={view.state} size={14} />
          <span>{view.label}</span>
          {trigger ? <Tag tone="outline">{trigger}</Tag> : null}
          {runRouteTag(t, run)}
          {stop ? <Tag tone={stop.tone}>{stop.label}</Tag> : null}
          {/* P2-2: only a run that actually attempted repair says so; every other run keeps the row untouched. */}
          {repair && repairStatus !== 'none'
            ? <Tag tone={REPAIR_STATUS_TONE[repairStatus] ?? 'outline'} title={pt(t, 'detail.repairRunHint')}>
              {`${pt(t, 'detail.repairRun', { attempts: Number(repair.attempts) || 0, max: Number(repair.max) || 0 })} · ${repairLabel(t, repair)}`}
            </Tag>
            : null}
          {run.dryRun ? <Tag tone="outline">{pt(t, 'ticket.dryTag')}</Tag> : null}
          {run.startedAt ? <TicketStamp at={run.startedAt} /> : null}
          <CopyButton value={String(run.id)} label={liveShortId(run.id)} />
        </div>
        <div className="sa-row-meta">
          {run.branch ? <span className="sa-mono">{run.branch}</span> : null}
          {commit ? <span className="sa-mono">{liveShortId(commit, 8)}</span> : null}
          {Array.isArray(run.steps) ? <span className="sa-hint">{pt(t, 'ticket.stepsCount', { count: run.steps.length })}</span> : null}
        </div>
        {run.error ? <p className="sa-error" title={String(run.error)}>{failureLabel(t, run.error)}</p> : null}
        <RunHandoff run={run} />
        <RunReport run={run} />
        <RunTrace run={run} />
      </div>
    </li>
  })}</ul>
}

/**
 * The worker summary is written by the agent and usually carries its own "## 闸门结果" table. This page renders gate
 * results in their own section, so that block is removed from the change summary; the leading "## 改动内容" heading
 * is dropped too because the section already says it.
 */
export const WORKER_GATE_HEADING = /^#{1,6}\s*(闸门结果|闸门|质量闸门|测试与闸门|gates?)\b/i
export const WORKER_CHANGES_HEADING = /^(改动内容|改动文件|变更内容|变更文件)/i
export function cleanWorkerSummary(text) {
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

/**
 * Changed files (union across runs) and the worker summary of the newest run that wrote one. The summary describes the
 * current worktree, so a revision rerun must replace it — taking the last run in the newest-first list (the old
 * behaviour) kept showing the first round's summary after a rerun.
 */
export function changesOf(runs) {
  const files = []
  const seen = new Set()
  let worker
  let workerRunId
  for (const run of runs) {
    for (const file of Array.isArray(run.changedPaths) ? run.changedPaths : []) {
      if (typeof file !== 'string' || seen.has(file)) continue
      seen.add(file)
      files.push(file)
    }
    if (!worker && run.worker?.text) { worker = run.worker.text; workerRunId = run.id }
  }
  return { files, worker: cleanWorkerSummary(worker), workerRunId }
}

/** One unified-diff line's role; the first character of the line is the whole classification. */
export function diffLineClass(line) {
  if (line.startsWith('diff --git ')) return 'sa-diff-file'
  if (line.startsWith('@@')) return 'sa-diff-hunk'
  if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('index ')
    || line.startsWith('new file mode') || line.startsWith('deleted file mode') || line.startsWith('similarity index')
    || line.startsWith('rename ') || line.startsWith('\\ No newline')) return 'sa-diff-meta'
  if (line.startsWith('+')) return 'sa-diff-add'
  if (line.startsWith('-')) return 'sa-diff-del'
  return 'sa-diff-ctx'
}

/** The patch itself: one row per line, monospace and horizontally scrollable so indentation keeps meaning. */
export function DiffBody({ text }) {
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n')
  if (lines.length && lines.at(-1) === '') lines.pop()
  return <div className="sa-diff">
    <pre>{lines.map((line, index) =>
      <span key={index} className={`sa-diff-line ${diffLineClass(line)}`}>{line === '' ? ' ' : line}</span>)}</pre>
  </div>
}

/**
 * The dialog's own on-demand request state: a read in flight, the host's worktree diff, or the failure that ended it.
 * @typedef {{
 *   loading?: boolean,
 *   error?: any,
 *   path?: string,
 *   gone?: boolean,
 *   data?: {
 *     available?: boolean,
 *     reason?: string,
 *     path?: string,
 *     worktree?: string,
 *     baseSha?: string | null,
 *     baseMissing?: boolean,
 *     ticketId?: string,
 *     runId?: string,
 *     diff?: string,
 *     bytes?: number,
 *     omitted?: number,
 *     truncated?: boolean,
 *     files?: {
 *       path?: string, additions?: number, deletions?: number, digest?: string,
 *       binary?: boolean, truncated?: boolean,
 *     }[],
 *   } | null,
 * }} DiffRequestState
 */
/**
 * The placeholder a settled-but-empty read shows. The host answers `undefined` when the Ticket itself is gone: without
 * the `gone` branch the dialog would sit on "reading the diff" forever, because neither `loading` nor `error` is set
 * again. Pure so the render regression can assert all three branches without mounting the dialog.
 * @param {DiffRequestState} state
 * @returns {'ticket.diffLoading' | 'ticket.diffTicketGone' | null}
 */
export function diffPlaceholderKey(state) {
  const value = state ?? {}
  if (value.loading || value.error || value.data) return null
  return value.gone ? 'ticket.diffTicketGone' : 'ticket.diffLoading'
}

/**
 * Body of the "view diff" dialog: loading, unavailable, empty and truncated states all answer in place.
 * @param {{ state?: DiffRequestState, onRetry?: () => void }} props
 */
export function DiffCard({ state = {}, onRetry }) {
  const { t } = usePanel()
  if (state.loading) return <Skeleton rows={4} />
  if (state.error) return <ErrorState error={state.error} onRetry={onRetry} />
  const placeholder = diffPlaceholderKey(state)
  if (placeholder) return <Hint>{pt(t, placeholder)}</Hint>
  const data = state.data
  if (data.available !== true) {
    return <Hint>{data.reason === 'not-a-worktree' ? pt(t, 'ticket.diffNotGit')
      : data.reason === 'git-failed' ? pt(t, 'ticket.diffFailed')
      : pt(t, 'ticket.diffUnavailable')}</Hint>
  }
  const files = Array.isArray(data.files) ? data.files : []
  const additions = files.reduce((total, file) => total + (Number(file.additions) || 0), 0)
  const deletions = files.reduce((total, file) => total + (Number(file.deletions) || 0), 0)
  // Locale number formatting and a non-breaking space keep the size from wrapping away from its unit (audit P3).
  const limit = `${new Intl.NumberFormat(timeLocale(t.lang)).format(Math.max(1, Math.round((Number(data.bytes) || 0) / 1024)))}\u00A0KB`
  const omitted = Number(data.omitted) || 0
  const filePath = typeof data.path === 'string' && data.path ? data.path : (typeof state.path === 'string' ? state.path : '')
  const pathRow = filePath ? <div className="sa-mono" style={{ overflowWrap: 'anywhere' }}>{filePath}</div> : null
  const head = <div className="sa-actions" style={{ flexWrap: 'wrap' }}>
    <span className="sa-hint">{pt(t, 'ticket.diffSummary', { files: files.length, additions, deletions })}</span>
    {data.runId ? <span className="sa-hint">{pt(t, 'ticket.diffRun', { run: shortId(data.runId, 10) })}</span> : null}
    {data.baseSha ? <span className="sa-hint">{pt(t, 'ticket.diffBase', { sha: String(data.baseSha).slice(0, 8) })}</span> : null}
    <CopyButton value={String(data.diff ?? '')} label={pt(t, 'ticket.diffCopy')} />
  </div>
  const notes = data.truncated
    ? [<Hint key="truncated">{pt(t, 'ticket.diffTruncated', { limit, omitted })}</Hint>]
    : omitted > 0 ? [<Hint key="omitted">{pt(t, 'ticket.diffOmitted', { count: omitted })}</Hint>] : []
  if (!String(data.diff ?? '').trim()) return <>{pathRow}{head}<Hint>{pt(t, 'ticket.diffEmpty')}</Hint></>
  return <>{pathRow}{head}{notes}<DiffBody text={data.diff} /></>
}

/** One sentence explaining what a failed run means and how to recover. */
export function failureHint(t, error, steps) {
  const text = String(error ?? '')
  if (/no changes/i.test(text)) return pt(t, 'detail.failedNoChanges')
  if (/Cannot read propert|reading 'get'|host context/i.test(text)) return pt(t, 'detail.failedInternal')
  if (/CLI not found|ENOENT|not logged in/i.test(text)) return pt(t, 'detail.failedCli')
  if (/timed out/i.test(text)) return pt(t, 'detail.failedTimeout')
  if (/gate/i.test(text) || steps.some(step => step.startsWith(pt(t, 'ticket.step.gate')))) return pt(t, 'detail.failedGate')
  return pt(t, 'detail.failedGeneric')
}

/** Host workflow state → localized text; an unknown value stays visible instead of leaking a backend enum (audit P2). */
export const WORKFLOW_STATE_KEYS = { pending: 'wf.statePending', running: 'wf.stateRunning', assess: 'wf.stateAssess',
  plan: 'wf.statePlan', implement: 'wf.stateImplement', gates: 'wf.stateGates', review: 'wf.stateReview',
  blocked: 'wf.stateBlocked', ready: 'wf.stateReady' }
export const WORKFLOW_STAGE_KEYS = { pending: 'wf.stagePending', running: 'wf.stageRunning', completed: 'wf.stageCompleted',
  failed: 'wf.stageFailed', blocked: 'wf.stageBlocked' }
export function ticketWorkflowStateLabel(t, status) {
  const key = WORKFLOW_STATE_KEYS[String(status ?? '')]
  return key ? pt(t, key) : String(status ?? '—')
}
export function ticketWorkflowStageLabel(t, status) {
  const key = WORKFLOW_STAGE_KEYS[String(status ?? '')]
  return key ? pt(t, key) : String(status ?? '—')
}

/** The three automation modes, mirroring lib/live/schedule.js AUTOMATION_MODES. */
export const AUTOMATION_MODES = ['off', 'heartbeat', 'schedule']

/** Form snapshot of one stored automation: numbers stay strings until save so a half-typed field is never coerced. */
export function automationFormOf(automation) {
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
export function AutomationCard({ ticket, onSaved }) {
  const { t, notify } = usePanel()
  const model = usePanelData()
  const act = model?.actions
  const automation = ticket?.automation && typeof ticket.automation === 'object' ? ticket.automation : undefined
  const signature = JSON.stringify(automation ?? null)
  const [form, setForm] = useState(() => automationFormOf(automation))
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState(undefined)
  // Audit P2: invalid numbers are explained at the field that produced them, and the focus moves to the first one.
  const [fieldErrors, setFieldErrors] = useState({})
  const intervalRef = useRef(null)
  const atRef = useRef(null)
  const maxExecutionsRef = useRef(null)
  // Re-sync only when the stored config actually changed (a poll of unchanged data never wipes a half-typed form).
  useEffect(() => { setForm(automationFormOf(automation)) }, [signature])
  // A Ticket without a stored config still needs an entry point to opt in; only the terminal "put away" states hide
  // the card (a dismissed/closed Ticket will never run again by schedule).
  const update = patch => { setForm(previous => ({ ...previous, ...patch })); setFieldErrors({}) }
  const setMode = mode => {
    setFieldErrors({})
    setForm(previous => ({ ...previous, mode,
      enabled: mode === 'off' ? false : (previous.mode === mode ? previous.enabled : true) }))
  }
  const validate = () => {
    const errors = {}
    if (form.mode === 'heartbeat') {
      const minutes = Number(form.intervalMinutes)
      if (!Number.isInteger(minutes) || minutes < 10 || minutes > 1440) errors.intervalMinutes = pt(t, 'auto.intervalInvalid')
    }
    if (form.mode === 'schedule' && !/^\d{2}:\d{2}$/.test(String(form.at ?? ''))) errors.at = pt(t, 'auto.atInvalid')
    const limit = String(form.maxExecutions ?? '').trim()
    if (limit !== '') {
      const max = Number(limit)
      if (!Number.isInteger(max) || max < 1 || max > 10000) errors.maxExecutions = pt(t, 'auto.maxExecutionsInvalid')
    }
    return errors
  }
  const save = async () => {
    if (saving || !act?.setAutomation) return
    // Audit P2: the host used to receive Number('')/NaN/out-of-range values, with only a generic failure afterwards.
    const errors = validate()
    if (Object.keys(errors).length) {
      setFieldErrors(errors)
      const first = errors.intervalMinutes ? intervalRef : errors.at ? atRef : maxExecutionsRef
      first.current?.focus()
      return
    }
    setFieldErrors({})
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
  // Saving is an edit action, not part of the page: the bar appears only while the form differs from the stored config
  // (T12, same rule as the settings page).
  const savedSnapshot = automationFormOf(automation)
  const dirty = form.mode !== savedSnapshot.mode || Boolean(form.enabled) !== Boolean(savedSnapshot.enabled)
    || (form.mode === 'heartbeat' && String(form.intervalMinutes) !== String(savedSnapshot.intervalMinutes))
    || (form.mode === 'schedule' && String(form.at) !== String(savedSnapshot.at))
    || String(form.maxExecutions) !== String(savedSnapshot.maxExecutions)
  const executions = Math.max(0, Number(stored.executions) || 0)
  const maxExecutions = Number.isFinite(Number(stored.maxExecutions)) ? Number(stored.maxExecutions) : undefined
  const facts = [
    [pt(t, 'auto.nextRun'), stored.nextAt ? <When at={stored.nextAt} /> : '—'],
    [pt(t, 'auto.executions'), maxExecutions !== undefined
      ? pt(t, 'auto.executionsLimit', { count: executions, max: maxExecutions })
      : pt(t, 'auto.executionsValue', { count: executions })],
  ]
  if (stored.lastRunAt) facts.push([pt(t, 'auto.lastRun'), <When at={stored.lastRunAt} />])
  if (stored.lastTrigger) {
    facts.push([pt(t, 'auto.lastTrigger'),
      pt(t, stored.lastTrigger === 'schedule' ? 'auto.triggerSchedule' : 'auto.triggerHeartbeat')])
  }
  if (stored.lastSkipReason) facts.push([pt(t, 'auto.lastSkip'), autoSkipReasonText(t, stored.lastSkipReason)])
  // Automation is a setting, not the page: it folds to a single line and expands only when the operator opens it (T11).
  const summary = automationSummaryText(t, stored) || pt(t, 'auto.modeOff')
  return <Section id="sa-automation" title={pt(t, 'auto.section')}>
    <Folded summary={summary}>
      <div className="sa-card">
        <div className="sa-card-head">
          <span className="sa-card-title">{automationSummaryText(t, stored) || pt(t, 'auto.modeOff')}</span>
          <label className="sa-actions">
            <span className="sa-hint">{pt(t, 'auto.enabled')}</span>
            <Switch checked={form.enabled} onChange={value => update({ enabled: value })}
              label={pt(t, 'auto.enabled')} />
          </label>
        </div>
        <div className="sa-field">
          <span className="sa-field-head">{pt(t, 'auto.mode')}</span>
          <SegmentedControl value={form.mode} onChange={setMode} label={pt(t, 'auto.mode')}
            options={[{ value: 'off', label: pt(t, 'auto.modeOff') },
              { value: 'heartbeat', label: pt(t, 'auto.modeHeartbeat') },
              { value: 'schedule', label: pt(t, 'auto.modeSchedule') }]} />
        </div>
        {heartbeat
          ? <div className="sa-field sa-field-narrow">
            <span className="sa-field-head">{pt(t, 'auto.interval')}</span>
            <Input type="number" min={10} max={1440} step={5} value={form.intervalMinutes} inputRef={intervalRef}
              aria-label={pt(t, 'auto.interval')} aria-invalid={fieldErrors.intervalMinutes ? true : undefined}
              onChange={event => update({ intervalMinutes: event.target.value })} />
            {fieldErrors.intervalMinutes ? <small className="sa-error" role="alert">{fieldErrors.intervalMinutes}</small> : null}
            <small>{pt(t, 'auto.intervalHint')}</small>
          </div>
          : null}
        {schedule
          ? <div className="sa-field sa-field-narrow">
            <span className="sa-field-head">{pt(t, 'auto.at')}</span>
            <Input type="time" value={form.at} inputRef={atRef} aria-label={pt(t, 'auto.at')}
              aria-invalid={fieldErrors.at ? true : undefined}
              onChange={event => update({ at: event.target.value })} />
            {fieldErrors.at ? <small className="sa-error" role="alert">{fieldErrors.at}</small> : null}
            <small>{pt(t, 'auto.atHint')}</small>
          </div>
          : null}
        <div className="sa-field sa-field-narrow">
          <span className="sa-field-head">{pt(t, 'auto.maxExecutions')}</span>
          <Input type="number" min={1} max={10000} value={form.maxExecutions} inputRef={maxExecutionsRef}
            placeholder={pt(t, 'auto.maxExecutionsPlaceholder')} aria-label={pt(t, 'auto.maxExecutions')}
            aria-invalid={fieldErrors.maxExecutions ? true : undefined}
            onChange={event => update({ maxExecutions: event.target.value })} />
          {fieldErrors.maxExecutions ? <small className="sa-error" role="alert">{fieldErrors.maxExecutions}</small> : null}
          <small>{pt(t, 'auto.maxExecutionsHint')}</small>
        </div>
        {dirty || saving || failure
          ? <>
            <div className="sa-actions">
              <Button variant="primary" size="sm" icon={saving ? undefined : 'check'}
                disabled={saving || !act?.setAutomation} aria-busy={saving || undefined}
                onClick={() => { void save() }}>
                {saving ? <><StatusIcon state="ongoing" size={14} />{pt(t, 'auto.saving')}</> : pt(t, 'auto.save')}
              </Button>
              <span className="sa-hint">{pt(t, 'auto.disabledNote')}</span>
            </div>
            {failure ? <p className="sa-error" role="alert">{errorText(failure)}</p> : null}
          </>
          : null}
        <div style={{ marginTop: 'var(--sa-sp-8)' }}><KeyValues rows={facts} /></div>
      </div>
    </Folded>
  </Section>
}

/**
 * Full ticket detail. `id` is the engine ticket id; `page` says which tab hosts it so a row click on another tab
 * keeps the same route page.
 */
// One list drives both the jump row and the scroll observer, so a section can never be navigable from one and
// invisible to the other (the automation block used to be missing from both).
export const DETAIL_JUMPS = [
  { id: 'sa-ticket-changes', labelKey: 'ticket.changes' },
  { id: 'sa-acceptance', labelKey: 'ticket.acceptCard' },
  { id: 'sa-automation', labelKey: 'auto.section' },
  { id: 'sa-ticket-stages', labelKey: 'ticket.stages' },
  { id: 'sa-ticket-gates', labelKey: 'ticket.gates' },
  { id: 'sa-ticket-runs', labelKey: 'ticket.runs' },
  { id: 'sa-ticket-timeline', labelKey: 'ticket.timeline' },
]

/** A jump must land on a section this Ticket really renders: dismissed/closed hides automation, no gate result hides gates. */
export function ticketVisibleJumps(ticket, hasGateResults) {
  const status = typeof ticket?.status === 'string' ? ticket.status : ''
  return DETAIL_JUMPS.filter(jump => {
    if (jump.id === 'sa-automation') return !['dismissed', 'closed'].includes(status)
    if (jump.id === 'sa-ticket-gates') return Boolean(hasGateResults)
    return true
  })
}

/** AC-08/09: bounded delivery evidence, independent of the worktree and the operation-ledger window. */
export function DeliveryEvidenceCard({ data, id, loading, error, onRetry }) {
  const { t } = usePanel()
  const rounds = Array.isArray(data?.rounds) ? data.rounds : []
  // The Host owns the comparison (completeness markers, baseline change, reused/stale gate results); the card must not
  // recompute it from the rounds and quietly disagree (review P2 AC-08/AC-09).
  const compare = useLiveResource('engine/evidence/:id/compare', { id }, 30000,
    { enabled: Boolean(id) && rounds.length > 1 })
  // A read still in flight or failed is not "no evidence yet" (audit P2): render the read's own state and retry it.
  if (error && !data) return <ErrorState error={error} onRetry={onRetry} />
  if (loading && !data) return <Skeleton rows={2} />
  if (!rounds.length) return <Hint>{pt(t, 'detail.evidenceEmpty')}</Hint>
  const latest = rounds.at(-1)
  const diff = compare.data
  const previous = rounds.length > 1 ? rounds.at(-2) : null
  const passed = (latest.gates ?? []).filter(gate => gate.state === 'passed').length
  const platform = latest.platform ?? {}
  const incomplete = diff?.incomplete
  const uncertain = diff?.filesUncertain
  const incompleteLine = incomplete && (!incomplete.previous.fileList || !incomplete.current.fileList)
    ? pt(t, 'detail.evidenceIncomplete', {
      previousOmitted: incomplete.previous.filesOmitted, previousRedacted: incomplete.previous.filesRedacted,
      currentOmitted: incomplete.current.filesOmitted, currentRedacted: incomplete.current.filesRedacted })
    : ''
  const uncertainAdded = (uncertain?.added ?? []).join('、')
  const uncertainRemoved = (uncertain?.removed ?? []).join('、')
  const requirementsAdded = diff?.acceptance?.added ?? []
  const requirementsRemoved = diff?.acceptance?.removed ?? []
  const unfinished = (diff?.gatesUnfinished ?? []).map(gate => gate.name)
  return <div className="sa-card">
    <div className="sa-card-head"><span className="sa-card-title">{pt(t, 'detail.evidenceTitle')}</span>
      <Tag tone="neutral">{pt(t, 'detail.evidenceRound', { round: latest.round ?? rounds.length })}</Tag>
    </div>
    <KeyValues rows={[
      [pt(t, 'detail.evidenceBranch'), <span className="sa-mono">{latest.branch || '—'}</span>],
      [pt(t, 'ticket.commit'), <span className="sa-mono">{(latest.headSha ?? '—').slice(0, 8)}</span>],
      [pt(t, 'detail.evidenceFilesLabel'), pt(t, 'detail.evidenceFiles', { count: (latest.files ?? []).length })],
      [pt(t, 'ticket.gates'), pt(t, 'detail.evidenceGates', { passed, total: (latest.gates ?? []).length })],
    ]} />
    <p className="sa-hint">{pt(t, 'detail.evidencePlatform', { pushed: platform.pushed ? pt(t, 'detail.evidenceYes') : pt(t, 'detail.evidenceNo'),
      pr: platform.pr ?? pt(t, 'detail.prNone'), merged: platform.merged ? pt(t, 'detail.evidenceYes') : pt(t, 'detail.evidenceNo'),
      deployed: platform.deployed ? pt(t, 'detail.evidenceYes') : pt(t, 'detail.evidenceNo'),
      accepted: platform.accepted ? pt(t, 'detail.evidenceYes') : pt(t, 'detail.evidenceNo') })}</p>
    {diff
      ? <p className="sa-hint">{pt(t, 'detail.evidenceCompare', { added: diff.files.added.length,
        removed: diff.files.removed.length, changed: diff.files.changed.length, gates: diff.gates.length })}</p>
      : rounds.length < 2
        ? <p className="sa-hint">{pt(t, 'detail.evidenceNoHistory')}</p>
        : null}
    {incompleteLine ? <p className="sa-hint">{incompleteLine}</p> : null}
    {uncertainAdded || uncertainRemoved
      ? <p className="sa-hint">{pt(t, 'detail.evidenceUncertain', {
        added: uncertainAdded || pt(t, 'detail.evidenceNone'), removed: uncertainRemoved || pt(t, 'detail.evidenceNone') })}</p>
      : null}
    {latest.patch?.truncated || diff?.incomplete?.previous?.patchTruncated || diff?.incomplete?.current?.patchTruncated
      ? <p className="sa-hint">{pt(t, 'detail.evidencePatchTruncated', {
        bytes: new Intl.NumberFormat(timeLocale(t.lang)).format(Number(latest.patch?.bytes ?? previous?.patch?.bytes ?? 0)) })}</p>
      : null}
    {diff?.baseline?.changed
      ? <p className="sa-hint">{pt(t, 'detail.evidenceBaseline', {
        from: String(diff.baseline.from).slice(0, 8), to: String(diff.baseline.to).slice(0, 8) })}</p>
      : null}
    {unfinished.length
      ? <p className="sa-hint">{pt(t, 'detail.evidenceUnfinished', { names: unfinished.join('、') })}</p>
      : null}
    {diff?.gatesStale?.length
      ? <p className="sa-hint">{pt(t, 'detail.evidenceStale', { names: diff.gatesStale.join('、') })}</p>
      : null}
    {diff?.gatesNotRun?.length
      ? <p className="sa-hint">{pt(t, 'detail.evidenceNotRerun', { names: diff.gatesNotRun.join('、') })}</p>
      : null}
    {requirementsAdded.length || requirementsRemoved.length
      ? <p className="sa-hint">{pt(t, 'detail.evidenceRequirements', {
        added: requirementsAdded.join('；') || pt(t, 'detail.evidenceNone'),
        removed: requirementsRemoved.join('；') || pt(t, 'detail.evidenceNone') })}</p>
      : null}
    {platform.deployCommit
      ? <p className="sa-hint">{pt(t, 'detail.evidenceDeploy', { sha: String(platform.deployCommit).slice(0, 12) })}</p>
      : null}
    {latest.workerSummary ? <Folded summary={pt(t, 'detail.evidenceSummary')}><p>{latest.workerSummary}</p></Folded> : null}
  </div>
}

export function TicketDetail({ id, page = 'execution', focusRun }) {
  const { t, navigate, notify, back } = usePanel()
  const model = usePanelData()
  const { data, error, loading, reload } = useLiveResource('engine/ticket/:id', { id }, 10000)
  const evidence = useLiveResource('engine/evidence/:id', { id }, 30000)
  // The nav now has an at-rest state: the first section is where the page opens, so it is the current one before
  // any click. Scroll-spy would be better, but a truthful default beats an all-inactive link row.
  const [activeJump, setActiveJump] = useState('sa-ticket-changes')
  const [headStuck, setHeadStuck] = useState(false)
  const [filesExpanded, setFilesExpanded] = useState(false)
  // A new Ticket starts with the compact file list again (the component instance survives an id change).
  useEffect(() => { setFilesExpanded(false) }, [id])
  // P1 §3.2: the worktree diff is read on demand (the executor does not store patches), so the dialog owns a small
  // request state instead of the page poll.
  const [diffOpen, setDiffOpen] = useState(false)
  const [diff, setDiff] = useState({})
  useEffect(() => { setDiff({}); setDiffOpen(false) }, [id])
  // AC-07: an Eval/source record's run link opens this page pinned to that run; scroll to it once the ledger loads.
  const focusedRun = useRef(null)
  useEffect(() => {
    if (!focusRun || focusedRun.current === focusRun) return
    const node = document.getElementById(`sa-run-${focusRun}`)
    if (node) { focusedRun.current = focusRun; node.scrollIntoView({ block: 'center', behavior: ticketReduceMotion() ? 'auto' : 'smooth' }) }
  }, [focusRun, data?.runs?.length])
  // "Add a requirement and rerun": the box stays local until submitted; the host appends the revision and starts
  // the dry run, so the page only clears it and lets the existing poll show the new run.
  const [revisionText, setRevisionText] = useState('')
  const [revisionError, setRevisionError] = useState(false)
  const headRef = useRef(null)
  // The PageHead (title/status/primary action) scrolls away; the sticky tier-2 row re-shows that context once it is
  // out of view, so a deep scroll never leaves only the section links and the generic page chrome (C31).
  useEffect(() => {
    const node = headRef.current ?? document.querySelector('.sa-page-head')
    const root = document.querySelector('.sa-scroll')
    if (!node || !root) return undefined
    // Audit P3: one read per animation frame, and a state write only when the threshold actually flips (a scroll
    // event used to force two layouts and two renders per frame).
    let frame = 0
    let stuck = false
    const measure = () => {
      frame = 0
      const head = node.getBoundingClientRect()
      const scroll = root.getBoundingClientRect()
      // The compact context appears only once the real PageHead is under the sticky nav (a small overlap margin keeps
      // it from flickering at the boundary).
      const next = head.bottom <= scroll.top + 8
      if (next === stuck) return
      stuck = next
      setHeadStuck(next)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure) }
    measure()
    root.addEventListener('scroll', schedule, { passive: true })
    return () => {
      root.removeEventListener('scroll', schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [id, data])
  const act = model?.actions
  const refreshAll = useCallback(async () => { await Promise.all([model?.reload?.(), reload()]) }, [model, reload])
  // The diff dialog fetches once, on first open; a retry button re-issues the same read.
  const loadDiff = useCallback(async (path) => {
    if (!act?.ticketDiff) return
    setDiff({ loading: true, path })
    try {
      const data = await act.ticketDiff(id, { path })
      setDiff(data === undefined ? { path, gone: true } : { path, data })
    }
    catch (error) { setDiff({ error, path }) }
  }, [act, id])
  // One file at a time: the row the operator clicked is the only thing the dialog fetches and shows.
  const openDiff = (path) => {
    setDiffOpen(true)
    if (path) void loadDiff(path)
  }
  const revision = useAction(async () => {
    const text = String(revisionText ?? '').trim()
    // The submit button stays clickable when empty (audit P3): this inline reason is the explanation, not a silent no-op.
    if (!text) { setRevisionError(true); return }
    await act.addRevision(id, text)
    setRevisionText('')
    setRevisionError(false)
    notify(pt(t, 'ticket.revisionStarted'))
  }, { reload: refreshAll })
  const dryRun = useAction(() => act.runTicket(id, { dryRun: true, wait: false }), { reload: refreshAll })
  const retry = useAction(() => act.runTicket(id, { dryRun: false, wait: false }), { reload: refreshAll })
  const publish = useAction(async () => {
    await act.publishTicket(id)
    notify(pt(t, 'toast.publishStarted'))
  }, { reload: refreshAll })
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
    // Audit P2: a failed cleanup still leaves the branch/worktree behind, so do not claim they were deleted.
    notify(pt(t, cleanup ? (cleanup.failed ? 'detail.dismissCleanupFailed' : 'detail.dismissRecorded') : 'detail.dismissRecordedBare',
      { reason: cleanup?.failed ?? '' }))
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
  const stopRun = useAction(async () => { await act.stopTicket(id); notify(pt(t, 'ticket.stopDone')) }, { reload: refreshAll })
  // P1-4: the answer buffer stays local until submitted; answering re-runs the Ticket as a new run.
  const [answerText, setAnswerText] = useState('')
  // A click on an empty answer explains itself inline instead of leaving a silently disabled button (audit P3).
  const [answerError, setAnswerError] = useState(false)
  // P1-3: rejection intents are optional checkboxes next to the reject button.
  const [rejectIntents, setRejectIntents] = useState([])
  const answer = useAction(async () => {
    const text = String(answerText ?? '').trim()
    if (!text) { setAnswerError(true); return }
    await act.answerTicket(id, text)
    setAnswerText('')
    setAnswerError(false)
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
      // Audit P1: Escape inside a field cancels that field (blur) instead of navigating away and losing the draft;
      // only a key pressed outside editable content is the page-level "go back".
      const target = typeof Element !== 'undefined' && event.target instanceof Element ? event.target : null
      const editable = target ? target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])') : null
      if (editable) { editable.blur(); return }
      back()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [back])

  // Keep the section link row honest while the page scrolls; a click-only active state went stale after one scroll.
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return undefined
    const root = document.querySelector('.sa-scroll')
    if (!root) return undefined
    // Same filtered list as the jump row (audit P2): a hidden section is neither linked nor observed.
    const ticket = data?.ticket ?? {}
    const runs = Array.isArray(data?.runs) ? data.runs : []
    const gates = latestGatesOf({ ...ticket, runs })
    const hasGates = gates.gates.length > 0 || Boolean(ticket.pendingGate ?? gates.run?.pendingGate)
    const nodes = ticketVisibleJumps(ticket, hasGates).map(jump => document.getElementById(jump.id)).filter(Boolean)
    if (!nodes.length) return undefined
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(entry => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)
      if (visible[0]) setActiveJump(visible[0].target.id)
    }, { root, rootMargin: '-96px 0px -58% 0px', threshold: [0, 1] })
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [id, data])
  if (!id) return <EmptyState icon="inbox" title={pt(t, 'thread.noSelection')} hint={pt(t, 'thread.noSelectionHint')} />
  // P0 §3.6.6: a missing Ticket (404) is an empty state — "找不到该工单" — not a broken connection with a retry that
  // can never succeed. Any other failure keeps the URL and offers a retry.
  if (error?.missing && !data) return <EmptyState icon="inbox" title={pt(t, 'detail.ticketMissing')} hint={pt(t, 'detail.ticketMissingHint')}
    action={<Button variant="outline" size="sm" onClick={back}>{t('back')}</Button>} />
  if (error && !data) return <ErrorState error={error} onRetry={reload} />
  if (loading) return <Skeleton rows={5} />

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
  // Gate results are only worth a section when there is a result (or a parked gate) to show (T9).
  const gateView = latestGatesOf({ ...ticket, runs })
  const parkedGate = ticket.pendingGate ?? gateView.run?.pendingGate
  const hasGateResults = gateView.gates.length > 0 || Boolean(parkedGate)
  // P1: the newest operation decides whether the run can be resumed; the parked question decides the answer banner.
  const latestRun = latestRunFor(ticket, runs)
  // AC-04: a stopped run keeps its checkpoint too, so the same resume action serves interrupted and stopped runs.
  const interrupted = latestRun?.status === 'interrupted' || latestRun?.status === 'stopped'
  // A run in flight has nothing to launch: the dry-run action belongs to the ⋯ menu, not the primary slot (T3).
  const running = latestRun?.status === 'running' || ticket.status === 'working'
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
  // push mode records the GitHub `/pull/new/` URL without a PR number; the link alone still counts as an MR.
  const hasMr = Boolean(ticket.links?.mergeRequest?.iid || ticket.links?.mergeRequest?.webUrl)
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
  if (repo?.repo) repoRows.push([pt(t, 'repo.localPath'), <span className="sa-mono">{String(repo.repo)}</span>])
  if (repoBase || repoTarget) repoRows.push([pt(t, 'repo.branches'), `${repoBase ?? '—'} → ${repoTarget ?? '—'}`])
  if (repoVerifyMode) repoRows.push([pt(t, 'repo.verifyMode'), repoVerifyModeText(t, repoVerifyMode)])
  if (repoAcceptance) repoRows.push([pt(t, 'repo.acceptance'), repoAcceptanceText(t, repoAcceptance)])
  const rules = Array.isArray(decision?.rules) ? decision.rules : []
  const authRows = [
    [pt(t, 'ticket.scope'), ticket.scope ?? '—'],
    [pt(t, 'ticket.policy'), decision?.policyVersion ?? '—'],
    [pt(t, 'ticket.strength'), decision?.strength ? pt(t, `strength.${decision.strength}`) : '—'],
    [pt(t, 'ticket.origin'), trigger ? <span className="sa-mono">{liveShortId(trigger.id)}</span> : '—'],
    [pt(t, 'ticket.basis'), reasonLabel(t, decision?.reason ?? ticket.origin?.reason) || '—'],
  ]
  if (thread?.key) authRows.push([t('term.thread'), <Button variant="ghost" size="sm"
    onClick={() => navigate({ page: 'trigger', id: thread.key })}>{thread.title ?? liveShortId(thread.key)}</Button>])
  // P1 routing: before the next run show who routing suggests (and whether it will be applied).
  const routePreview = data?.routePreview && typeof data.routePreview === 'object' ? data.routePreview : null
  if (routePreview) {
    // Deliverable, required capabilities and backend are separate facts: a read-only report is not "the same route"
    // as a code change, and an operator override must be visible as such.
    const capabilities = (routePreview.capabilities ?? []).map(capability => pt(t,
      `st.routeCap${capability.charAt(0).toUpperCase()}${capability.slice(1)}`)).join(' · ')
    authRows.push([pt(t, 'detail.routeLabel'),
      `${pt(t, routePreview.deliverable === 'report' ? 'st.routeReport' : 'st.routeChange')}${capabilities ? ` · ${capabilities}` : ''} · ${routePreview.backend}${routePreview.applied ? '' : ` · ${pt(t, 'detail.routeSuggested')}`}`])
  }

  // Acceptance is a human decision: it gets its own card, its own two sign-off buttons, and (unlike the action row)
  // never goes through the ⋯ menu. The mode comes from the repository (contract §12): `merged` repositories accept
  // after the merge, `deployed` ones after the UAT deployment.
  const acceptance = ticket.links?.acceptance
  const accepted = acceptance?.ok === true
  // Evidence decides the shape of the acceptance block: two cards only when there is something in them, otherwise one
  // sentence. A gate-blocked Ticket used to spend ~200px on "还没有合并请求 / 还没有 UAT 验收记录" (T10).
  const uatEvidence = ticket.links?.verification?.uat ?? ticket.links?.deployment?.uat
  // The auto-verify budget is per commit; when it is spent the panel must say so instead of looking stuck.
  const autoVerifyLimit = ticket.links?.autoVerify?.lastSkipReason === 'auto-verify-limit'
    && ['mr-open', 'ci-pending', 'deploy-pending'].includes(ticket.status)
  const hasAcceptanceEvidence = Boolean(ticket.links?.mergeRequest?.iid || ticket.links?.mergeRequest?.webUrl
    || ticket.links?.verification?.merged === true || uatEvidence)
  const acceptMode = ticket.repoAcceptance ?? 'deployed'
  const canAccept = acceptMode === 'merged'
    ? (ticket.status === 'merged' || ticket.links?.verification?.merged === true)
    : ticket.status === 'deployed'
  const manualVerify = repoVerifyMode === 'manual'
  // Revision: a person can append requirements and rerun; the form hides while a run or a question owns the Ticket.
  const revisions = Array.isArray(ticket.revisions) ? ticket.revisions : []
  const revisionBlocked = ticket.status === 'working' ? 'working'
    : ticket.status === 'awaiting-answer' ? 'answer'
      : ['dismissed', 'closed'].includes(ticket.status) || accepted ? 'ended' : undefined
  const uatUrl = manualVerify ? undefined : (repo?.uatUrl ?? config.gitlab?.uatUrl)
  const busy = { dryRun: dryRun.busy, retry: retry.busy, publish: publish.busy, refreshCi: refreshCi.busy, verify: verify.busy }
  // One state-following primary action (retry a failed run, review a pending acceptance, publish a finished dry run,
  // open the merged MR once accepted, dry run otherwise) plus a ⋯ menu for every other action (critique #4, O15).
  const activeRun = ticket.status === 'working' || ticket.status === 'queued' || ticket.status === 'preparing'
    || Boolean(ticket.stopRequested)
  const failed = view.state === 'error'
  // A failed run whose staged workflow stopped at a replayable stage can continue from there (host: workflowResumable).
  const workflowResumable = failed && ticket.workflowResumable === true
  const needsAcceptance = !accepted && view.group === 'waiting' && canAccept
  // A finished dry run is not "run it again": the next decision is publish. The rerun stays in the ⋯ menu.
  const dryRunReady = ticket.status === 'ready' && !interrupted && !accepted && !failed
  const mrUrl = ticket.links?.mergeRequest?.webUrl
  const primaryAction = awaitingAnswer
    // A parked question owns the primary slot: the answer form is the banner right below the header.
    ? <Button variant="primary" size="sm" onClick={() =>
      document.getElementById('sa-answer')?.scrollIntoView({ block: 'start', behavior: ticketReduceMotion() ? 'auto' : 'smooth' })}>{pt(t, 'primary.answer')}</Button>
    : failed
    ? canRun
      // A blocked staged workflow continues at its failed stage; "retry" (start over) stays in the ⋯ menu.
      ? workflowResumable
        ? <ConfirmButton label={pt(t, 'detail.resume')} title={pt(t, 'detail.resumeWorkflowTitle')}
          message={pt(t, 'detail.resumeWorkflowConfirm', { title: ticket.title ?? ticket.id })} variant="primary" icon="play"
          confirmLabel={pt(t, 'detail.confirmResume')} onConfirm={async () => { await resume.run() }} />
        : <ConfirmButton label={pt(t, 'ticket.retry')} title={pt(t, 'retryTitle')}
          message={pt(t, 'retryConfirm', { title: ticket.title ?? ticket.id })} variant="primary" icon="refresh"
          confirmLabel={pt(t, 'detail.confirmRetry')} onConfirm={async () => { await retry.run() }} />
      // A disabled control still has to say why; the reason is a focusable InfoTip next to it, not a title tooltip.
      : <>
        <Button variant="primary" size="sm" disabled>{pt(t, 'ticket.retry')}</Button>
        <InfoTip text={pt(t, 'ticket.retryUnavailable')} warn />
      </>
    : accepted
      // An accepted Ticket has nothing left to run: the merged MR is a real link, otherwise only the ⋯ menu stays.
      ? (safeHttpUrl(mrUrl) ? <a className="sa-btn sa-btn-primary sa-btn-sm"
        href={safeHttpUrl(mrUrl)} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
        {pt(t, 'primary.openMr')}</a> : null)
      : needsAcceptance
        ? <Button variant="primary" size="sm" onClick={() =>
          document.getElementById('sa-acceptance')?.scrollIntoView({ block: 'start', behavior: ticketReduceMotion() ? 'auto' : 'smooth' })}>
          {pt(t, 'primary.accept')}
        </Button>
        // A parked gate already carries all three decisions in the banner above this row, and running work has
        // nothing to launch — both states keep only the ⋯ menu, so the page never shows a second button that either
        // duplicates the banner or invites "start another run" (T2/T3).
        : gateBlocked || running
          ? null
          // P1-5: an interrupted run is resumable, so it outranks the generic dry-run action.
          : interrupted
            ? <>
              <Button variant="primary" size="sm" disabled={resume.busy || !canRun}
                onClick={() => { void resume.run() }}>{pt(t, resume.busy ? 'detail.resumeBusy' : 'detail.resume')}</Button>
              {!canRun ? <InfoTip text={pt(t, 'ticket.retryUnavailable')} warn /> : null}
            </>
            : dryRunReady
              ? <>
                <Button variant="primary" size="sm" icon="external"
                  disabled={busy.publish || !canPush}
                  onClick={() => setPending('publish')}>{pt(t, 'menu.publish')}</Button>
                {!canPush ? <InfoTip text={pt(t, 'ticket.publishUnavailable')} warn /> : null}
              </>
              : <>
                <Button variant="primary" size="sm" disabled={busy.dryRun || !canRun}
                  onClick={() => { void dryRun.run() }}>{pt(t, 'ticket.dryRun')}</Button>
                {!canRun ? <InfoTip text={pt(t, 'ticket.dryRunUnavailable')} warn /> : null}
              </>
  const menuItems = [
    { key: 'verify', label: pt(t, 'menu.verify'), icon: 'review', onSelect: () => { void verify.run() }, disabled: busy.verify },
    { key: 'ci', label: pt(t, 'menu.refreshCi'), icon: 'refresh', onSelect: () => { void refreshCi.run() },
      disabled: busy.refreshCi || !hasMr },
    { key: 'dryRun', label: pt(t, 'ticket.dryRun'), icon: 'play', onSelect: () => { void dryRun.run() },
      disabled: busy.dryRun || !canRun, note: canRun ? undefined : pt(t, 'ticket.dryRunUnavailable') },
    // The publish entry only lives here when it is not already the primary action.
    ...(dryRunReady ? [] : [{ key: 'publish', label: pt(t, 'menu.publish'), icon: 'external',
      onSelect: () => setPending('publish'), disabled: busy.publish || !canPush,
      note: canPush ? undefined : pt(t, 'ticket.publishUnavailable') }]),
    { key: 'retry', label: pt(t, 'ticket.retry'), icon: 'refresh', onSelect: () => setPending('retry'),
      disabled: busy.retry || !canRun, note: canRun ? undefined : pt(t, 'ticket.retryUnavailable') },
    { key: 'stop', label: pt(t, ticket.stopRequested ? 'ticket.stopping' : 'menu.stop'), icon: 'stop',
      onSelect: () => setPending('stop'), disabled: stopRun.busy || !activeRun || Boolean(ticket.stopRequested),
      note: !activeRun ? pt(t, 'ticket.stopUnavailable') : ticket.stopRequested ? pt(t, 'ticket.stopping') : undefined },
    ...failed ? [{ key: 'dismiss', label: pt(t, 'detail.dismiss'), icon: 'stop', onSelect: () => setPending('dismiss') }] : [],
  ]
  const runPending = async action => { const done = await action.run(); if (done) setPending(null) }
  const confirmActionLabels = {
    retry: pt(t, 'detail.confirmRetry'),
    publish: pt(t, 'detail.confirmPublish'),
    stop: pt(t, 'detail.confirmStop'),
    // Only promise a deletion when there is a branch/worktree to delete.
    dismiss: ticket.links?.branch || ticket.links?.worktree
      ? pt(t, 'detail.confirmDismiss') : pt(t, 'detail.dismiss'),
  }
  const confirmDialog = pending
    ? <Modal open onClose={() => setPending(null)}
      title={pending === 'retry' ? pt(t, 'retryTitle') : pending === 'dismiss' ? pt(t, 'detail.dismissTitle')
        : pending === 'stop' ? pt(t, 'menu.stop') : pt(t, 'ticket.publishTitle')}
      closeLabel={t('close')}
      description={pending === 'retry'
        ? pt(t, 'retryConfirm', { title: ticket.title ?? ticket.id })
        : pending === 'stop'
          ? pt(t, 'ticket.stopConfirm')
        : pending === 'dismiss'
          ? pt(t, 'detail.dismissConfirm', { title: ticket.title ?? ticket.id,
            branch: ticket.links?.branch || '（无）', worktree: ticket.links?.worktree || '（无）' })
          : pt(t, 'ticket.publishConfirm', { title: ticket.title ?? ticket.id })}
      footer={<>
        <Button variant="ghost" onClick={() => setPending(null)}>{t('cancel')}</Button>
        {/* The confirm button names the action it destroys; a destructive one (stop/dismiss) is styled as such. */}
        <Button variant={pending === 'dismiss' || pending === 'stop' ? 'danger' : 'primary'}
          disabled={pending === 'retry' ? busy.retry : pending === 'dismiss' ? busy.dismiss
          : pending === 'stop' ? stopRun.busy : busy.publish}
          onClick={() => { void runPending(pending === 'retry' ? retry : pending === 'dismiss' ? dismiss
            : pending === 'stop' ? stopRun : publish) }}>{confirmActionLabels[pending] ?? t('confirm')}</Button>
      </>} />
    : null

  // P1 §3.2: the diff lives behind one dialog so the reading column stays about the worker's summary.
  const diffDialog = diffOpen
    ? <Modal open onClose={() => setDiffOpen(false)} title={pt(t, 'ticket.diffTitle')}
      closeLabel={t('close')} className="sa-diff-modal">
      <DiffCard state={diff} onRetry={() => { if (diff.path) void loadDiff(diff.path) }} />
    </Modal>
    : null

  const changes = changesOf(runs)
  const events = ticketEvents(t, ticket, runs)
  // The banner names the cause in one short sentence; the original text of a recognised failure sits one fold below it,
  // so mapping the wording never hides the raw error (C9).
  const failureRaw = String(failedRun?.error ?? '').trim()
  const failureCause = failureRaw ? failureLabel(t, failedRun.error) : ''
  const failureBanner = failedRun
    ? <div className="sa-banner sa-danger" role="alert"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' }}>
      <StatusIcon state="error" size={16} spin={false} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' }}>
        <strong style={{ fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 }}>{pt(t, 'detail.failedTitle')}</strong>
        {failureCause ? <p className="sa-error">{failureCause}</p> : null}
        {failureCause && failureRaw !== failureCause
          ? <Folded summary={pt(t, 'detail.rawError')}><p className="sa-error">{failureRaw}</p></Folded>
          : null}
        {failedSteps.length
          ? <p className="sa-hint">{pt(t, 'detail.failedSteps', { steps: failedSteps.join(' · ') })}</p>
          : null}
        <p className="sa-hint">{failureHint(t, failedRun.error, failedSteps)}</p>
      </div>
    </div>
    : null
  // P0 gate banner: what parked the run and the three human decisions; the failing output is folded and copyable.
  const gateBanner = gateBlocked
    ? <div id="sa-gate" className="sa-banner" role="alert"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' }}>
      <StatusIcon state="warning" size={16} spin={false} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' }}>
        <strong style={{ fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 }}>
          {pt(t, 'detail.gateTitle', { name: ticketGateLabel(t, pendingGate?.name) })}
        </strong>
        <p className="sa-hint">{pt(t, 'detail.gateIntro')}</p>
        <KeyValues rows={[
          [pt(t, 'detail.gateExit'), pendingGate?.exitCode === undefined ? '—' : String(pendingGate.exitCode)],
          [pt(t, 'detail.gateTimedOut'), pendingGate?.timedOut ? pt(t, 'detail.gateYes') : pt(t, 'detail.gateNo')],
          ...(Array.isArray(pendingGate?.changedPaths) && pendingGate.changedPaths.length
            ? [[pt(t, 'detail.gateChanged'), <span className="sa-mono">{pendingGate.changedPaths.join(' · ')}</span>]] : []),
        ]} />
        {pendingGate?.outputTail
          ? <Folded summary={pt(t, 'detail.gateOutput')}>
            <div className="sa-actions"><CopyButton value={String(pendingGate.outputTail)} /></div>
            <pre className="sa-pre">{String(pendingGate.outputTail)}</pre>
          </Folded>
          : <Hint>{pt(t, 'detail.gateNoOutput')}</Hint>}
        <div className="sa-actions">
          <ConfirmButton label={pt(t, 'detail.gateRelease')} title={pt(t, 'detail.gateReleaseTitle')}
            message={pt(t, 'detail.gateReleaseConfirm', { name: ticketGateLabel(t, pendingGate?.name),
              title: ticket.title ?? ticket.id })}
            confirmLabel={pt(t, 'detail.confirmGateRelease')}
            variant="primary" icon="play" onConfirm={async () => { await gateRelease.run() }} />
          <Button variant="outline" size="sm" icon="refresh" disabled={gateRetry.busy}
            onClick={() => { void gateRetry.run() }}>{pt(t, 'detail.gateRetry')}</Button>
          <ConfirmButton label={pt(t, 'detail.gateStop')} title={pt(t, 'detail.gateStopTitle')}
            message={pt(t, 'detail.gateStopConfirm', { title: ticket.title ?? ticket.id })}
            confirmLabel={pt(t, 'detail.confirmStop')}
            variant="danger" icon="stop" onConfirm={async () => { await gateStop.run() }} />
        </div>
      </div>
    </div>
    : null
  // P1-4 answer banner: the worker asked a question, so the one thing on screen is the question and the answer box.
  const answerQuestion = typeof pendingQuestion?.question === 'string' ? pendingQuestion.question : ''
  const answerBanner = awaitingAnswer
    ? <div id="sa-answer" className="sa-banner" role="alert"
      style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' }}>
      <StatusIcon state="warning" size={16} spin={false} />
      <div style={{ minWidth: 0, flex: '1 1 auto', display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-8)' }}>
        <strong style={{ fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 }}>{pt(t, 'detail.answerTitle')}</strong>
        <p className="sa-hint">{pt(t, 'detail.answerHint')}</p>
        {answerQuestion ? <p>{pt(t, 'detail.answerQuestion', { text: answerQuestion })}</p> : null}
        {answerOptions.length
          ? <div className="sa-actions">
            <span className="sa-hint">{pt(t, 'detail.answerOptions')}</span>
            {answerOptions.map((option, index) => <Button key={index} size="sm"
              variant={answerText === option ? 'primary' : 'outline'}
              aria-pressed={answerText === option}
              onClick={() => { setAnswerText(option); setAnswerError(false) }}>{option}</Button>)}
          </div>
          : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' }}>
          <label htmlFor="sa-answer-input" className="sa-hint">{pt(t, 'detail.answerLabel')}</label>
          <div className="sa-actions" style={{ alignItems: 'flex-end' }}>
            <textarea id="sa-answer-input" name="answer" autoComplete="off"
              className="sa-textarea" rows={2} value={answerText}
              placeholder={pt(t, 'detail.answerPlaceholder')}
              aria-invalid={answerError ? true : undefined}
              onChange={event => { setAnswerText(event.target.value); setAnswerError(false) }} />
            <Button variant="primary" size="sm" icon="message"
              disabled={answer.busy}
              onClick={() => { void answer.run() }}>{pt(t, 'detail.answerSubmit')}</Button>
          </div>
        </div>
        {answerError ? <p className="sa-error" role="alert">{pt(t, 'detail.answerRequired')}</p> : null}
        {previousAnswers.length
          ? <Folded summary={pt(t, 'detail.answerHistory', { count: previousAnswers.length })}>
            <ul className="sa-list">{previousAnswers.map((entry, index) => <li key={index} className="sa-row">
              <div className="sa-row-main">
                <div className="sa-row-title">
                  <span style={{ whiteSpace: 'pre-wrap' }}>{String(entry.answer ?? '')}</span>
                </div>
                {entry.at ? <div className="sa-row-meta"><TicketStamp at={entry.at} /></div> : null}
              </div>
            </li>)}</ul>
          </Folded>
          : null}
      </div>
    </div>
    : null
  // P1-5 interrupted banner: the reason the resume action exists, so the phase label is never read as a healthy queue.
  const interruptedStop = interrupted ? runStopLabel(t, latestRun) : null
  const interruptedBanner = interrupted
    ? <div className="sa-banner" style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--sa-sp-8)' }}>
      <StatusIcon state="warning" size={16} spin={false} />
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' }}>
        <strong style={{ fontSize: 'var(--sa-fs-body)', lineHeight: 1.5 }}>
          {interruptedStop ? interruptedStop.label : pt(t, 'ticketState.interrupted')}
        </strong>
        <p className="sa-hint">{pt(t, latestRun?.status === 'stopped' ? 'detail.stoppedHint' : 'detail.interruptedHint')}</p>
      </div>
    </div>
    : null
  // A jump is only offered for a section this Ticket actually renders (dismissed/closed hide automation, a Ticket
  // without gate results hides the gates section) — the observer below uses the same filtered list.
  const jumps = ticketVisibleJumps(ticket, hasGateResults)
  const jumpTo = id => {
    setActiveJump(id)
    const node = document.getElementById(id)
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'start', behavior: ticketReduceMotion() ? 'auto' : 'smooth' })
  }

  // P0 §3.6.6: the person's sign-off is a fact of the Ticket, so it never hides behind a scroll. It now rides on the
  // title row (right of the title, left of the actions) instead of owning a full-width line under the head; the jump
  // still lands on the acceptance card (`#sa-acceptance`). When the primary action already is that jump, the note
  // stays text only: two identical 去验收 controls side by side made the header read as a duplicated action.
  const acceptanceNote = acceptanceView.state === 'none'
    ? null
    : <span className="sa-page-head-note">
      <span>{acceptanceView.state === 'pending' ? pt(t, 'detail.acceptLinePending')
        : acceptanceView.state === 'accepted'
          ? pt(t, 'detail.acceptLineAccepted', { time: ticketStamp(acceptanceView.at, t.lang) || '—' })
          : pt(t, 'detail.acceptLineRejected', { time: ticketStamp(acceptanceView.at, t.lang) || '—' })}</span>
      {needsAcceptance ? null
        : <button type="button" className="sa-textlink" onClick={() => jumpTo('sa-acceptance')}>
          {pt(t, acceptanceView.state === 'pending' ? 'detail.acceptLineJump' : 'detail.acceptLineView')}
        </button>}
    </span>

  // The header's right corner is the Ticket's control cluster: sign-off note, the one state-following primary action,
  // then the ⋯ menu. The menu opens leftwards (align end) because it now sits at the right edge of the content.
  const headActions = <>
    {acceptanceNote}
    {primaryAction}
    {/* AC-03: the stop entry also lives in the header while a run is active, so it is not buried in the ⋯ menu only. */}
    {activeRun && !ticket.stopRequested
      ? <Button size="sm" variant="ghost" icon="stop" disabled={stopRun.busy} onClick={() => setPending('stop')}>
        {pt(t, 'menu.stop')}
      </Button>
      : null}
    <Menu label={pt(t, 'menu.label')} items={menuItems} align="end"
      text={primaryAction ? undefined : pt(t, 'menu.label')} />
  </>

  return <>
    <PageHead headRef={headRef} title={ticket.title ?? pt(t, 'ticket.loading')} actions={headActions}
      meta={<>
        <TicketStatusTag ticket={ticket} />
        <span className="sa-mono">{liveShortId(ticket.id, 10)}</span>
        {ticket.id ? <CopyButton value={ticket.id} label={pt(t, 'detail.copyTicketId')} /> : null}
        {ticket.updatedAt ? <When at={ticket.updatedAt} /> : null}
        {repoName ? <span className="sa-hint">{`${pt(t, 'repo.label')}：${repoName}`}</span> : null}
      </>} />
    {error ? <ErrorState error={error} onRetry={reload} /> : null}
    {answerBanner}
    {interruptedBanner}
    {failureBanner}
    {gateBanner}
    {confirmDialog}
    {diffDialog}
    <nav className="sa-detail-nav" aria-label={pt(t, 'ticket.sectionNav')}>
      {headStuck ? <div className="sa-detail-context">
        <span className="sa-detail-context-title" title={ticket.title ?? ticket.id}>
          {ticket.title ?? pt(t, 'ticket.loading')}
        </span>
        <TicketStatusTag ticket={ticket} />
      </div> : null}
      <div className="sa-detail-jumps">{jumps.map(jump => <button key={jump.id} type="button" className="sa-detail-jump"
        data-active={activeJump === jump.id ? 'true' : undefined}
        aria-current={activeJump === jump.id ? 'location' : undefined}
        onClick={() => jumpTo(jump.id)}>{pt(t, jump.labelKey)}</button>)}</div>
      {headStuck && primaryAction ? <div className="sa-detail-context-action">{primaryAction}</div> : null}
    </nav>

    {ticket.workflow ? <Section title={pt(t, 'wf.progress')}>
      {/* The host records why a workflow stopped (reason code + one-line detail); show both instead of bare "blocked". */}
      <p>{ticketWorkflowStateLabel(t, ticket.workflow.status)}
        {ticket.workflow.detail ? <span className="sa-hint">{` · ${ticket.workflow.detail}`}</span> : null}</p>
      {(ticket.workflow.stages ?? []).map((stage, index) => <Folded
        key={index} summary={`${pt(t, `wf.${stage.role}`)} · ${stage.backend ?? 'host'} · ${ticketWorkflowStageLabel(t, stage.status)}`}>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          {stage.error ?? JSON.stringify(stage.result ?? {}, null, 2)}
        </pre>
      </Folded>)}
    </Section> : null}

    {/* 1. What changed: repository, request body, changed files and the worker's summary — gates stay in their section. */}
    <Section id="sa-ticket-changes" title={pt(t, 'ticket.changes')}>
      {repoRows.length
        ? <div style={{ marginBottom: 'var(--sa-sp-8)' }}><KeyValues rows={repoRows} /></div>
        : null}
      {/* On a wide panel the section splits the way it is read: the worker's summary (a 72ch reading column) on the
          left, and the evidence it talks about on the right — the changed files and the original request. On a narrow
          panel the grid collapses and the left column leads; the request stays folded so a long SQL paste cannot push
          the actual changes below the first screen (critique C24). */}
      {!changes.worker && !changes.files.length && !ticket.body
        // Nothing to show at all: one sentence, not two empty columns.
        ? <Hint>{pt(t, 'ticket.noChanges')}</Hint>
        : <div className="sa-changes-grid">
          <div className="sa-changes-main">
            <p className="sa-hint">
              {changes.workerRunId ? pt(t, 'ticket.workerSummaryRun', { run: liveShortId(changes.workerRunId, 10) })
                : pt(t, 'ticket.workerSummary')}
            </p>
            {changes.worker
              ? <MarkdownLite text={String(changes.worker)} />
              : <Hint>{pt(t, 'ticket.noChanges')}</Hint>}
          </div>
          <div className="sa-changes-side">
            <div className="sa-actions">
              <span className="sa-hint">{pt(t, 'ticket.changedFiles')}</span>
              <span className="sa-count" data-empty={changes.files.length === 0 ? 'true' : undefined}>{String(changes.files.length)}</span>
            </div>
            {changes.files.length
              ? <>
                {/* Each file name is the entry point to its own patch (only available while the worktree exists). */}
                <ul id="sa-changed-files" className="sa-list">
                  {(filesExpanded ? changes.files : changes.files.slice(0, CHANGES_FILES_RECENT))
                    .map((file, index) => <li key={index} className="sa-row">
                      <button type="button" className="sa-file-diff"
                        title={pt(t, 'ticket.diffOpenFile', { path: file })}
                        onClick={() => openDiff(file)}>
                        <Icon name="diff" size={13} /><span className="sa-mono">{file}</span>
                      </button>
                    </li>)}
                </ul>
                {changes.files.length > CHANGES_FILES_RECENT
                  ? <div className="sa-actions">
                    <Button variant="ghost" size="sm" icon={filesExpanded ? 'chevron-up' : 'chevron-down'}
                      aria-expanded={filesExpanded} aria-controls="sa-changed-files"
                      onClick={() => setFilesExpanded(value => !value)}>
                      {pt(t, filesExpanded ? 'ticket.filesCollapse' : 'ticket.filesShowAll', { count: changes.files.length })}
                    </Button>
                  </div>
                  : null}
              </>
              : <Hint>{pt(t, 'ticket.noChangedFiles')}</Hint>}
            {ticket.body
              ? <div style={{ marginTop: 'var(--sa-sp-8)' }}>
                <Folded summary={pt(t, 'ticket.request')}><MarkdownLite text={ticket.body} /></Folded>
              </div>
              : null}
            <div className="sa-revision" style={{ marginTop: 'var(--sa-sp-8)' }}>
              <div className="sa-actions">
                <label htmlFor="sa-revision-input" className="sa-hint">{pt(t, 'ticket.revisionTitle')}</label>
              </div>
              {revisionBlocked
                ? <Hint>{pt(t, revisionBlocked === 'answer' ? 'ticket.revisionAwaitingAnswer'
                  : revisionBlocked === 'working' ? 'ticket.revisionWorking' : 'ticket.revisionEnded')}</Hint>
                : <>
                  <textarea id="sa-revision-input" name="revision" autoComplete="off"
                    className="sa-textarea sa-revision-input" rows={4} value={revisionText}
                    placeholder={pt(t, 'ticket.revisionPlaceholder')}
                    aria-invalid={revisionError ? true : undefined}
                    disabled={revision.busy}
                    onChange={event => { setRevisionText(event.target.value); setRevisionError(false) }} />
                  {revisionError ? <p className="sa-error" role="alert">{pt(t, 'ticket.revisionRequired')}</p> : null}
                  <div className="sa-actions">
                    {/* Clickable while empty, so the click gets the inline reason instead of a dead disabled button (audit P3). */}
                    <Button variant="primary" size="sm" icon="play"
                      disabled={revision.busy}
                      onClick={() => { void revision.run() }}>{pt(t, 'ticket.revisionSubmit')}</Button>
                  </div>
                  <Hint>{pt(t, 'ticket.revisionHint')}</Hint>
                </>}
              {revisions.length
                ? <div style={{ marginTop: 'var(--sa-sp-8)' }}>
                  <Folded summary={pt(t, 'ticket.revisionHistory', { count: revisions.length })}>
                    <ul className="sa-list">{revisions.map((entry, index) => <li
                      key={entry.id ?? entry.at ?? index} className="sa-row">
                      <div className="sa-row-main">
                        {entry.at ? <div className="sa-row-meta"><TicketStamp at={entry.at} /></div> : null}
                        <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{String(entry.text ?? '')}</p>
                      </div>
                    </li>)}</ul>
                  </Folded>
                </div>
                : null}
            </div>
          </div>
        </div>}
    </Section>

    {/* 2. Acceptance: MR/UAT evidence plus the human sign-off actions. The acceptance state is already the PageHead
        tag, so this card only repeats the sign-off time once (critique #5: one "已验收" per screen). */}
    <Section id="sa-acceptance" title={pt(t, 'ticket.acceptCard')}>
      {/* AC-08/09: durable evidence lives next to (not inside) the acceptance record. */}
      <div style={{ marginBottom: 'var(--sa-sp-8)' }}>
        <DeliveryEvidenceCard data={evidence.data} id={id} loading={evidence.loading} error={evidence.error} onRetry={evidence.reload} />
      </div>
      {/* P1-3: the acceptance rounds (status, newest round, checks, last decision) lead the block when the host has them. */}
      {acceptanceRecord
        ? <div style={{ marginBottom: 'var(--sa-sp-8)' }}><AcceptanceRecordCard record={acceptanceRecord} /></div>
        : null}
      {autoVerifyLimit ? <Hint>{pt(t, 'ticket.autoVerifyLimit')}</Hint> : null}
      {hasAcceptanceEvidence
        ? <>
          <div className="sa-card-grid" style={{ marginBottom: 'var(--sa-sp-8)' }}>
            <MergeRequestCard ticket={ticket} /> <UatCard ticket={ticket} />
          </div>
          <div className="sa-actions" style={{ marginBottom: 'var(--sa-sp-8)' }}>
            {uatUrl ? <ExternalLink href={uatUrl}>{pt(t, 'ticket.openUat')}</ExternalLink>
              : manualVerify ? <Hint>{pt(t, 'ticket.manualVerifyHint')}</Hint>
              : <Hint>{pt(t, 'ticket.uatOpenHint')}</Hint>}
          </div>
        </>
        : <Hint>{pt(t, 'ticket.acceptEmpty')}</Hint>}
      {accepted
        ? <>
          {ticket.links?.cleanup
            ? <Hint>{ticket.links.cleanup.failed
              ? pt(t, 'detail.acceptCleanupFailed', { reason: ticket.links.cleanup.failed })
              : pt(t, 'detail.acceptCleanupDone')}</Hint>
            : null}
        </>
        : acceptance?.ok === false
          ? <Hint>{pt(t, 'ticket.acceptRejectedHint')}</Hint>
          : null}
      {canAccept && !accepted
        ? <>
          <Hint>{pt(t, acceptMode === 'merged' ? 'ticket.acceptHintMerged' : 'ticket.acceptHint')}</Hint>
          {/* P1-3: rejection intents are optional; they ride on the accept POST only when at least one is ticked. */}
          <div className="sa-actions" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="sa-hint">{pt(t, 'detail.acceptIntentsHint')}</span>
            {ACCEPTANCE_INTENTS.map(intent => <label key={intent}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sa-sp-4)', fontSize: 'var(--sa-fs-meta)' }}>
              <input type="checkbox" checked={rejectIntents.includes(intent)}
                onChange={event => setRejectIntents(previous => event.target.checked
                  ? [...previous, intent] : previous.filter(item => item !== intent))} />
              <span>{pt(t, ACCEPTANCE_INTENT_KEYS[intent])}</span>
            </label>)}
          </div>
          <div className="sa-actions">
            <ConfirmButton label={pt(t, 'ticket.acceptPass')} title={pt(t, 'ticket.acceptPassTitle')}
              message={pt(t, 'ticket.acceptPassConfirm', { title: ticket.title ?? ticket.id })}
              confirmLabel={pt(t, 'detail.confirmAcceptPass')}
              variant="primary" icon="decision" onConfirm={async () => { await acceptPass.run() }} />
            <ConfirmButton label={pt(t, 'ticket.acceptFail')} title={pt(t, 'ticket.acceptFailTitle')}
              message={pt(t, 'ticket.acceptFailConfirm', { title: ticket.title ?? ticket.id })}
              confirmLabel={pt(t, 'detail.confirmAcceptFail')}
              variant="outline" icon="blocked" onConfirm={async () => { await acceptFail.run(rejectIntents) }} />
          </div>
        </>
        : !canAccept && !accepted && hasAcceptanceEvidence
          // Without evidence the empty-state sentence above already says what unlocks acceptance.
          ? <Hint>{pt(t, acceptMode === 'merged' ? 'ticket.acceptOnlyMerged' : 'ticket.acceptOnlyDeployed')}</Hint>
          : null}
    </Section>

    {/* P2-1: the Ticket's own automation config (a Ticket without config renders the card in the off state so the
        operator can opt in; dismissed/closed Tickets do not offer scheduling). */}
    {['dismissed', 'closed'].includes(ticket.status) ? null : <AutomationCard ticket={ticket} onSaved={refreshAll} />}

    {/* 3. Stage rail, 4. gate results, 5. run records, 6. timeline (older events folded by default). */}
    <Section id="sa-ticket-stages" title={pt(t, 'ticket.stages')}><StageRail ticket={{ ...ticket, runs }} detail /></Section>
    {hasGateResults
      ? <Section id="sa-ticket-gates" title={pt(t, 'ticket.gates')}>
        <TicketGateResults ticket={{ ...ticket, runs }} record={acceptanceRecord} />
      </Section>
      : null}
    <Section id="sa-ticket-runs" title={pt(t, 'ticket.runs')} count={runs.length}>
      {runs.length ? <TicketRunRows runs={runs} /> : <Hint>{pt(t, 'ticket.noRuns')}</Hint>}
    </Section>
    {/* P1-7: the host's own activity stream rides inside the timeline as a fold instead of being a second, identical-
        looking timeline above it (T16). */}
    <Section id="sa-ticket-timeline" title={pt(t, 'ticket.timeline')} count={events.length}>
      {activities.length
        ? <Folded summary={pt(t, 'ticket.activityFold', { count: activities.length })}>
          <TicketActivities activities={activities} />
        </Folded>
        : null}
      <TicketTimeline ticket={ticket} runs={runs} />
    </Section>

    {/* Secondary evidence and the raw escape hatch stay at the bottom. */}
    <Folded summary={pt(t, 'ticket.auth')}>
      <KeyValues rows={authRows} />
      {rules.length ? <Folded summary={pt(t, 'thread.rulesDetail')}><ThreadRuleRows rules={rules} /></Folded> : null}
    </Folded>
    <RawValue label={pt(t, 'ticket.raw')} json={data} />
  </>
}
