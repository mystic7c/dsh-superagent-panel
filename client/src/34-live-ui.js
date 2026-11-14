/* Shared live semantics for the six pages: Chinese status vocabulary, ticket rows and groups, the 24h funnel,
   the executor load strip, the seven-stage rail, gate summary and the pure status helpers every page reads.
   Pages must never translate a raw engine status themselves — they call ticketStatus/decisionKindView/dispositionView
   and render the returned label key through `pt`. */

Object.assign(PAGE_TEXT, {
  // ---- legacy dictionaries kept for `PilotStatusTag` compatibility (labels are Chinese; keys are unchanged) ----
  pilotPhase: { disabled: ['未启用', 'Disabled'], starting: ['启动中', 'Starting'], idle: ['空闲', 'Idle'],
    'dry-run': ['干跑完成', 'Dry run'], ok: ['正常', 'OK'], error: ['异常', 'Error'], blocked: ['被阻塞', 'Blocked'] },
  pilotRunStatus: { running: ['运行中', 'Running'], 'dry-run': ['干跑完成', 'Dry run'], 'gates-passed': ['闸门通过', 'Gates passed'],
    pushed: ['已推送', 'Pushed'], 'ci-pending': ['等待 CI', 'Waiting for CI'], failed: ['失败', 'Failed'] },
  pilotTicketStatus: { queued: ['排队', 'Queued'], working: ['执行中', 'Working'], ready: ['就绪', 'Ready'],
    pushed: ['已推送（无 MR）', 'Pushed (no MR)'], 'ci-pending': ['等待 CI', 'CI pending'], 'ci-passed': ['CI 通过', 'CI passed'],
    'ci-failed': ['CI 失败', 'CI failed'], 'mr-open': ['MR 已创建', 'MR open'],
    merged: ['已合并', 'Merged'], deployed: ['已部署 UAT', 'Deployed to UAT'],
    'deploy-pending': ['部署 UAT 中', 'Deploying to UAT'], 'deploy-failed': ['部署失败', 'Deploy failed'], closed: ['MR 已关闭', 'MR closed'],
    failed: ['失败', 'Failed'] },
  pilotGate: { standards: ['规范闸门', 'Standards'], backend: ['后端测试', 'Backend tests'], frontend: ['前端检查', 'Frontend checks'] },
  pilotNoPermission: ['缺少 GitLab token 或推送未授权', 'GitLab token missing or push not allowed'],
  pilotDryRun: ['干跑执行', 'Dry run'], pilotPublish: ['发布 MR', 'Publish MR'], pilotCi: ['刷新 CI', 'Refresh CI'],
  pilotVerify: ['核对合并/UAT', 'Verify merge/UAT'], pilotPoll: ['立即轮询', 'Poll now'], pilotReloadConfig: ['重载配置', 'Reload config'],
  pilotRefresh: ['刷新', 'Refresh'], pilotCheckUat: ['检查 UAT', 'Check UAT'],

  // ---- shared status vocabulary ----
  ticketState: {
    queued: ['排队中', 'Queued'], ready: ['就绪', 'Ready'], working: ['执行中', 'Working'],
    pushed: ['已推送（缺 MR）', 'Pushed (no MR)'], 'ci-pending': ['等待 CI', 'Waiting for CI'],
    'ci-passed': ['CI 通过', 'CI passed'], 'ci-failed': ['CI 失败', 'CI failed'],
    'mr-open': ['MR 已创建', 'MR open'], merged: ['已合并', 'Merged'], deployed: ['已部署 UAT', 'Deployed to UAT'],
    'deploy-pending': ['部署 UAT 中', 'Deploying to UAT'], 'deploy-failed': ['部署失败', 'Deploy failed'],
    closed: ['MR 已关闭', 'MR closed'], dismissed: ['已忽略', 'Dismissed'], failed: ['失败', 'Failed'], unknown: ['状态未知', 'Unknown state'],
    'dry-run': ['干跑完成', 'Dry run finished'], running: ['运行中', 'Running'],
    // P0: a run parked on a failing gate is a state of its own; the Ticket keeps the phase label it reached.
    'gate-blocked': ['闸门待处理', 'Gate needs you'],
    // P1-4: the worker asked a question; the run is parked until a person answers (group waiting, primary 'answer').
    'awaiting-answer': ['等待回答', 'Awaiting your answer'],
    waiting_for_human: ['等你处理', 'Waiting on you'], interrupted: ['已中断', 'Interrupted'],
    accepted: ['已验收', 'Accepted'],
  },
  group: { queued: ['排队', 'Queued'], working: ['执行中', 'Working'], waiting: ['等你处理', 'Waiting on you'],
    failed: ['失败', 'Failed'], done: ['已结束', 'Ended'] },
  primary: { accept: ['去验收', 'Review UAT'], merge: ['去合并 MR', 'Merge MR'], deploy: ['刷新部署', 'Refresh deploy'],
    diagnose: ['查看原因', 'See what failed'], progress: ['干跑执行', 'Dry run'], openMr: ['打开 MR', 'Open MR'],
    gate: ['去处理闸门', 'Handle the gate'], answer: ['去回答', 'Answer the question'] },
  disposition: { queued: ['排队', 'Queued'], evaluating: ['评估中', 'Evaluating'], delivered: ['已送达', 'Delivered'],
    fanout: ['扇出', 'Fanned out'], filtered: ['被过滤', 'Filtered'] },
  rail: { trigger: ['触发', 'Trigger'], eval: ['评估', 'Eval'], ticket: ['工单', 'Ticket'], execution: ['执行', 'Execution'],
    gate: ['闸门', 'Gates'], mr: ['MR', 'MR'], uat: ['UAT', 'UAT'], retried: ['重试后完成', 'Completed after retry'] },
  gate: { standards: ['规范', 'Standards'], backend: ['后端', 'Backend'], frontend: ['前端', 'Frontend'],
    none: ['还没有闸门结果。', 'No gate result yet.'] },
  result: { uatOk: ['UAT 通过', 'UAT passed'], failed: ['执行失败', 'Failed'], ciPending: ['等待 CI', 'CI pending'],
    ciPassed: ['CI 通过', 'CI passed'], merged: ['已合并', 'Merged'], deploying: ['部署中', 'Deploying'],
    mrOpen: ['MR 待合并', 'MR open'], pushed: ['待发布 MR', 'MR not published'], closed: ['MR 已关闭', 'MR closed'] },
  shell: { running: ['运行中', 'Running'], paused: ['已暂停', 'Paused'], stopped: ['已停止', 'Stopped'],
    error: ['异常', 'Error'], blocked: ['被阻塞', 'Blocked'], unknown: ['状态未知', 'Status unknown'],
    loading: ['读取中…', 'Loading…'], pending: ['需要你处理 {count} 件', '{count} need you'],
    active: ['执行中 {count}', '{count} running'],
    setupChip: ['配置 {done}/{total}', 'Set up {done}/{total}'] },
  menu: { label: ['工单动作', 'Ticket actions'], dryRun: ['干跑执行', 'Dry run'], publish: ['发布 MR', 'Publish MR'],
    refreshCi: ['刷新 CI', 'Refresh CI'], verify: ['核对合并/UAT', 'Verify merge/UAT'], stop: ['停止工单', 'Stop ticket'] },
  row: { untitled: ['（未命名工单）', '(Untitled Ticket)'], openDetail: ['打开工单详情', 'Open Ticket details'],
    evidenceMr: ['MR #{iid}', 'MR #{iid}'], evidencePr: ['PR 已创建', 'PR opened'], evidencePrWaiting: ['已推送，等待创建 PR', 'Pushed; waiting for PR'], evidenceCause: ['原因：{cause}', 'Cause: {cause}'],
    evidenceReview: ['待你验收', 'Review UAT'], evidenceMerge: ['待你合并', 'Merge MR'],
    evidenceRunning: ['本轮 {minutes} 分', '{minutes} min'],
    evidenceGate: ['等你处理闸门 {name}', 'Gate {name} needs you'], evidenceGateWait: ['等你处理闸门', 'Gate needs you'],
    acceptanceAccepted: ['已验收', 'Accepted'], acceptanceRejected: ['已打回', 'Rejected'],
    interrupted: ['已中断', 'Interrupted'] },
  // P1-2: how a run was started and why it stopped; shared by the list band, the run records and the detail header.
  runTrigger: { manual: ['手动', 'Manual'], auto: ['自动', 'Automatic'], retry: ['重试', 'Retry'],
    revise: ['追加要求', 'Revision'], publish: ['发布', 'Publish'], resume: ['恢复', 'Resume'], pipeline: ['流水线', 'Pipeline'],
    other: ['触发方式：{trigger}', 'Trigger: {trigger}'] },
  runStop: { done: ['完成', 'Done'], error: ['执行失败', 'Failed'], timeout: ['超时', 'Timed out'],
    worker_failed: ['worker 失败', 'Worker failed'], no_changes: ['无改动', 'No changes'],
    gate_failed: ['闸门未通过', 'Gate failed'], prepare_failed: ['准备工作区失败', 'Worktree preparation failed'],
    bootstrap_failed: ['依赖安装失败', 'Dependency install failed'], guard_failed: ['改动校验失败', 'Change guard failed'],
    commit_failed: ['提交失败', 'Commit failed'], push_failed: ['推送失败', 'Push failed'],
    mr_failed: ['MR 创建失败', 'MR creation failed'], interrupted: ['已中断', 'Interrupted'],
    stopped: ['人工终止', 'Stopped by a person'], other: ['其他原因（{reason}）', 'Other ({reason})'] },
  // A settled run keeps the Ticket phase it handed off at as history, never as a live state (see runView).
  runState: { handoff: ['交付时：{phase}', 'Handed off: {phase}'] },
  problem: { engineError: ['引擎报告异常', 'The engine reported an error'], paused: ['处理已暂停', 'Processing is paused'],
    engineOff: ['自动触发未开启', 'Automatic intake is off'], sourceError: ['{name} 异常', '{name} is failing'],
    octoToken: ['Octo token 未配置', 'Octo token is missing'], gitlabToken: ['GitLab token 未配置', 'GitLab token is missing'],
    pausedDetail: ['恢复前不会开始新的评估、派工或回复。', 'No new Eval, dispatch or reply runs until you resume.'],
    engineOffDetail: ['在设置→来源打开「启用引擎」并保存后，引擎才会自动轮询群消息。',
      'Turn on “Engine enabled” under Settings → Source and save; the engine then polls the group automatically.'],
    octoTokenDetail: ['没有 Octo token，引擎读不到群消息。', 'Without an Octo token the engine cannot read the group.'],
    gitlabTokenDetail: ['没有 GitLab token 时无法观测 CI 与部署，只能做无 token 的核对。',
      'Without a GitLab token CI and deploy results cannot be observed; only token-free verification runs.'] },
  problemAction: { retry: ['检查新消息', 'Check for new messages'], reload: ['重载配置', 'Reload config'],
    settings: ['去设置', 'Open settings'], execution: ['去执行页', 'Open execution'] },
  // ---- multi-repository execution surface (contract §12) ----
  repo: { label: ['仓库', 'Repository'], name: ['仓库名称', 'Repository name'],
    repoId: ['仓库 ID', 'Repository ID'], localPath: ['本地路径', 'Local path'],
    project: ['GitLab 项目', 'GitLab project'], baseUrl: ['GitLab 地址', 'GitLab base URL'],
    branches: ['分支', 'Branches'], targetBranch: ['目标分支', 'Target branch'],
    token: ['Token', 'Token'], tokenConfigured: ['已配置', 'Configured'], tokenMissing: ['未配置', 'Missing'],
    verifyMode: ['验证方式', 'Verification'], acceptance: ['验收方式', 'Acceptance'],
    verifyModeWebUat: ['网页 UAT', 'Web UAT'], verifyModeManual: ['人工验收', 'Manual acceptance'],
    acceptanceDeployed: ['部署后验收', 'Accept after deploy'], acceptanceMerged: ['合并后验收', 'Accept after merge'],
    unknownMode: ['未知方式（{mode}）', 'Unknown mode ({mode})'],
    default: ['默认', 'Default'], mixed: ['多仓库', 'Multiple repositories'] },
  // ---- thread detail ----
  thread: { facts: ['线程信息', 'Thread facts'], eval: ['评估过程', 'Evaluation'], decision: ['决定', 'Decision'],
    timeline: ['消息时间线', 'Message timeline'], fieldKey: ['线程', 'Thread'], fieldSource: ['来源', 'Source'],
    fieldChannel: ['渠道 ID', 'Channel id'], fieldCreated: ['创建', 'Created'], fieldLast: ['最近活动', 'Last activity'],
    fieldTriggers: ['消息', 'Messages'], fieldTickets: ['工单', 'Tickets'], noEval: ['还没有评估记录。', 'No evaluation yet.'],
    noDecision: ['还没有决定。', 'No decision yet.'], noMessages: ['这个线程还没有消息。', 'This thread has no messages yet.'],
    latestDecision: ['最近决定', 'Latest decision'], reason: ['原因', 'Reason'], rules: ['规则', 'Rules'],
    openTicket: ['打开工单', 'Open Ticket'], decisionsTitle: ['决定历史', 'Decisions'],
    rulesHit: ['{hit} 通过 / {miss} 未通过', '{hit} passed / {miss} not passed'],
    factsRaw: ['事实原始值', 'Raw facts'], noSelection: ['从左侧选择一个线程', 'Pick a thread on the left'],
    noSelectionHint: ['选中线程后，这里会展示事实、评估、决定与消息去向。',
      'Pick a thread to see its facts, evaluation, decision and where each message went.'],
    noTicketProduced: ['这个决定没有产生工单。', 'This decision produced no Ticket.'],
    rulesDetail: ['逐条规则', 'Rule by rule'] },
  // ---- ticket detail ----
  ticket: { loading: ['正在读取工单…', 'Loading the Ticket…'], runs: ['运行记录', 'Runs'], noRuns: ['还没有运行记录。', 'No run yet.'],
    gates: ['闸门结果', 'Gate results'], mrCard: ['合并请求（MR）', 'Merge request'], uatCard: ['UAT 验收', 'UAT acceptance'],
    auth: ['权限依据', 'Authorization basis'], timeline: ['时间线', 'Timeline'], raw: ['原始 JSON', 'Raw JSON'],
    scope: ['受理范围', 'Scope'], policy: ['策略版本', 'Policy version'], strength: ['强度', 'Strength'],
    mergeState: ['合并状态', 'Merge state'],
    origin: ['来源请求', 'Origin request'], basis: ['决定依据', 'Decision basis'], target: ['目标分支', 'Target branch'],
    pipeline: ['流水线', 'Pipeline'], autoMerge: ['自动合并', 'Auto merge'], mrState: ['MR 状态', 'MR state'],
    mrLink: ['MR 链接', 'MR link'], openPr: ['打开 PR', 'Open the PR'],
    mergedYes: ['已合入目标分支', 'Merged into the target branch'],
    mergedNo: ['尚未合入目标分支', 'Not merged yet'], commit: ['提交', 'Commit'], devCommit: ['目标分支提交', 'Target commit'],
    uatReachable: ['UAT 可访问', 'UAT reachable'], uatUnreachable: ['UAT 不可访问', 'UAT unreachable'],
    uatChanged: ['已变化', 'Changed'], uatSame: ['未变化', 'Unchanged'],
    uatChange: ['构建变化', 'Build change'],
    mrOpened: ['打开中', 'Open'], mrMerged: ['已合并', 'Merged'], mrClosed: ['已关闭', 'Closed'], mrLocked: ['已锁定', 'Locked'],
    pipelineSuccess: ['通过', 'Passed'], pipelineFailed: ['失败', 'Failed'], pipelineRunning: ['运行中', 'Running'],
    pipelinePending: ['等待中', 'Pending'], pipelineCreated: ['已创建', 'Created'], pipelineCanceled: ['已取消', 'Canceled'],
    pipelineSkipped: ['已跳过', 'Skipped'], pipelineManual: ['手动', 'Manual'],
    autoMerged: ['已合并', 'Merged'], autoRequested: ['已请求', 'Requested'], autoFailed: ['失败', 'Failed'],
    checkedAt: ['检查时间', 'Checked at'], deployJob: ['部署', 'Deploy'], deployStatus: ['部署状态', 'Deploy status'],
    actions: ['工单动作', 'Ticket actions'], stages: ['阶段链路', 'Stage rail'], retry: ['重试执行', 'Retry run'], stop: ['停止工单', 'Stop ticket'],
    dryRun: ['干跑执行', 'Dry run'], publish: ['发布 MR', 'Publish MR'], refreshCi: ['刷新 CI', 'Refresh CI'],
    verify: ['核对合并/UAT', 'Verify merge/UAT'], originLink: ['来源触发', 'Origin trigger'],
    retryUnavailable: ['执行器未启用，只能干跑。', 'The executor is disabled; dry run only.'],
    stopUnavailable: ['当前没有可停止的执行。', 'There is no active run to stop.'],
    stopping: ['正在停止…', 'Stopping…'], stopConfirm: ['请求停止这个工单？已完成的动作会保留，之后不会再提交、推送或发布。',
      'Stop this Ticket? Finished actions stay as evidence; nothing else is committed, pushed or published.'],
    stopDone: ['已请求停止（排队中的工单会直接结束；执行中的会在当前阶段边界停止）',
      'Stop requested (a queued Ticket ends now; a running one stops at the next stage boundary).'],
    publishUnavailable: ['缺少推送权限、执行器未启用或没有 GitLab token。', 'Push is not allowed, the executor is off, or the GitLab token is missing.'],
    dryTag: ['干跑', 'Dry run'], publishTitle: ['发布这个工单的 MR？', "Publish this Ticket's MR?"],
    publishConfirm: ['会在现有工作区重跑闸门，然后推送分支并创建/刷新 MR：{title}',
      'Re-runs the gates in the existing worktree, then pushes the branch and creates/refreshes the MR: {title}'],
    step: { prepareWorktree: ['准备工作树', 'Prepare worktree'], prepareRepo: ['准备仓库', 'Prepare repository'],
      exportRepo: ['导出 UAT 对象', 'Export UAT objects'], worker: ['执行 worker', 'Run the worker'],
      changedPaths: ['检查改动', 'Inspect changes'], bootstrap: ['安装依赖', 'Install dependencies'],
      gate: ['闸门', 'Gates'], commit: ['提交改动', 'Commit changes'], push: ['推送分支', 'Push the branch'],
      mergeRequest: ['创建 MR', 'Open the MR'], finish: ['执行完成', 'Run finished'], error: ['执行失败', 'Run failed'],
      publish: ['发布 MR', 'Publish the MR'] },
    event: { created: ['工单创建', 'Ticket created'], runStarted: ['开始执行', 'Run started'], runFinished: ['执行结束', 'Run finished'],
      runFailed: ['执行失败', 'Run failed'], pushed: ['推送分支', 'Branch pushed'], mrOpened: ['创建 MR', 'MR opened'],
      merged: ['合并到目标分支', 'Merged into the target branch'], deployed: ['部署 UAT', 'Deployed to UAT'],
      verified: ['核对 UAT', 'UAT checked'], updated: ['状态更新', 'Status updated'], failed: ['失败', 'Failed'] },
    changes: ['改动内容', 'Changes'],
    request: ['需求', 'Request'],
    changedFiles: ['改动文件', 'Changed files'],
    workerSummary: ['执行总结', 'Worker summary'],
    workerSummaryRun: ['执行总结（来自运行 {run}）', 'Worker summary (run {run})'],
    noChangedFiles: ['这次执行没有记录改动文件。', 'No changed files were recorded for this run.'],
    noChanges: ['暂时没有可展示的改动内容。', 'No change summary yet.'],
    stepsCount: ['{count} 步', '{count} steps'],
    timelineRecent: ['显示最近 {count} 条，共 {total} 条', 'Showing the latest {count} of {total}'],
    timelineShowAll: ['展开全部（{count} 条）', 'Show all ({count})'],
    timelineCollapse: ['收起', 'Collapse'],
    acceptCard: ['验收', 'Acceptance'],
    acceptHint: ['在 UAT 上按工单正文的 UC/AC 验收；验收通过后，这张工单会从「需要你处理」移除。部署记录与构建证据保持不变。',
      'Verify the UC/AC from the Ticket body on UAT; accepting removes it from "needs you". The deploy record and its evidence stay untouched.'],
    // Acceptance mode `merged` (repositories without CI, e.g. group/project-b): accept once the MR is merged.
    acceptHintMerged: ['这个仓库在合并后验收：按工单正文的 UC/AC 在目标分支上核对；验收通过后，这张工单会从「需要你处理」移除。',
      'This repository is accepted after the merge: check the UC/AC from the Ticket body on the target branch; accepting removes it from "needs you".'],
    acceptOnlyMerged: ['只有 MR 已合入目标分支的工单可以验收。', 'Only a Ticket whose MR is merged into the target branch can be accepted.'],
    manualVerifyHint: ['这个仓库走人工验收：不做 UAT 检查，MR 合入目标分支后即可验收。',
      'Manual acceptance for this repository: no UAT check runs; accept once the MR is merged into the target branch.'],
    openUat: ['打开 UAT', 'Open UAT'],
    acceptPass: ['验收通过', 'Accept'],
    acceptFail: ['验收不通过', 'Reject'],
    acceptPassTitle: ['确认验收通过？', 'Accept this build?'],
    acceptPassConfirm: ['将记录「已验收」并把这张工单移出「需要你处理」列表；不会改变部署状态，也不会回复群消息：{title}',
      'Records the acceptance and removes the Ticket from the needs-you list. The deploy status and the group chat are not touched: {title}'],
    acceptFailTitle: ['确认验收不通过？', 'Reject this build?'],
    acceptFailConfirm: ['将记录「验收不通过」，工单仍留在「需要你处理」列表，便于修复后再次验收：{title}',
      'Records the rejection and keeps the Ticket in the needs-you list so it can be accepted after a fix: {title}'],
    acceptedAt: ['已验收 {time}', 'Accepted {time}'],
    rejectedAt: ['验收不通过 {time}', 'Rejected {time}'],
    acceptRejectedHint: ['已记录验收不通过；确认问题修复后可再次验收。', 'Rejection recorded; accept again after the issue is fixed.'],
    acceptOnlyDeployed: ['只有已部署 UAT 的工单可以验收。', 'Only a Ticket deployed to UAT can be accepted.'],
    acceptEmpty: ['还没有 MR 或 UAT 记录；构建部署到 UAT 后在这里验收。',
      'No MR or UAT record yet; accept here once a build is deployed.'],
    acceptRecorded: ['已记录验收通过', 'Acceptance recorded'],
    rejectRecorded: ['已记录验收不通过', 'Rejection recorded'],
    uatOpenHint: ['UAT 地址来自 live.json 的 gitlab.uatUrl。', 'The UAT URL comes from gitlab.uatUrl in live.json.'],
  },
  // One name per action across the panel (critique 2026-11-05 #3/#20).
  actions: {
    checkNow: ['检查新消息', 'Check for new messages'],
    refreshStatus: ['刷新状态', 'Refresh status'],
    openExecution: ['全部工单', 'All tickets'],
    openSource: ['打开来源页', 'Open Source'],
    viewHandled: ['查看已处理工单', 'View handled tickets'],
  },
  dismissedAfterFailure: ['失败后忽略', 'Dismissed after failure'],
  // P2-1: a Ticket can run itself; the same summary wording serves the row chip and the automation card.
  'auto.everyMinutes': ['每 {minutes} 分钟', 'Every {minutes} min'],
  'auto.everyHours': ['每 {hours} 小时', 'Every {hours} h'],
  'auto.daily': ['每天 {time}', 'Daily {time}'],
  'auto.nextAt': ['下次运行 {time}', 'Next run {time}'],
  'auto.skip.paused': ['处理已暂停', 'Processing is paused'],
  'auto.skip.dispatchPaused': ['派发已暂停（保留队列）', 'Dispatch is paused (queue kept)'],
  'auto.skip.executorDisabled': ['执行器未启用', 'The executor is disabled'],
  'auto.skip.working': ['工单正在执行', 'The Ticket is running'],
  'auto.skip.parked': ['工单在等人/等回答', 'The Ticket waits for a person'],
  'auto.skip.maxExecutions': ['已达到执行次数上限', 'The execution limit is reached'],
  'auto.skip.repoDisabled': ['仓库已停用，不再派发新任务', 'The repository is disabled; no new work is dispatched'],
  'auto.skip.noRepo': ['工单没有可用的仓库', 'No repository is available for this Ticket'],
  'auto.skip.due': ['已到执行时间', 'The scheduled time arrived'],
  // push mode records only the GitHub `/pull/new/` URL: the PR itself is opened by `.github/workflows/auto-pr.yml`.
  'ticket.prWaiting': ['已推送，等待创建 PR', 'Pushed; waiting for PR'],
  'ticket.prState': ['PR 状态', 'PR state'],
  'ticket.acceptState': ['人工验收', 'Human acceptance'],
  'ticket.acceptedYes': ['已通过', 'Accepted'],
  'ticket.acceptedNo': ['未验收', 'Not accepted'],
  'mr.pushHint': ['这个 PR 由推送后的 auto-pr workflow 自动创建；合并状态由目标分支历史判定。',
    'This PR is created automatically by the post-push auto-pr workflow; merge state comes from the target branch history.'],
  // P2-7: GitLab observation upgrades shown on the MR card.
  'mr.draft': ['草稿', 'Draft'],
  'mr.draftHint': ['这个 MR 仍是草稿/WIP：自动巡检会跳过合并与 UAT 判定。',
    'This MR is still a draft/WIP; auto-verification skips merge and UAT checks.'],
  'mr.stale': ['过期 CI', 'Stale CI'],
  'mr.staleHint': ['最新流水线属于另一个提交（当前 {head}，最新 {latest}），CI 结论不覆盖工单状态。',
    'The newest pipeline belongs to another commit (current {head}, latest {latest}); the CI result does not change the Ticket.'],
  // 24h funnel: 过滤 is a branch of 到达, and `dropped` means outbound replies that failed to send — neither is a stage.
  funnelBranch: ['其中 {count} 条仅作上下文', '{count} context-only'],
  funnelSummary2: ['{received} 到达 · {judged} 评估 · {accepted} 接单 · {dropped} 出站失败',
    '{received} arrived · {judged} evaluated · {accepted} accepted · {dropped} not sent'],
  automation: {
    offTitle: ['自动化未启动', 'Automation is off'],
    pausedTitle: ['处理已暂停', 'Processing is paused'],
    paused: ['处理已暂停（设置→运行）', 'Paused (Settings → Runtime)'],
    engineOff: ['引擎未启用（设置→来源）', 'Intake off (Settings → Source)'],
    executorOff: ['执行器未启用（设置→运行）', 'Executor off (Settings → Runtime)'],
    start: ['启动自动化', 'Start automation'],
    resume: ['恢复处理', 'Resume processing'],
    startHint: ['启动后会按轮询间隔读取群消息，新工单会开始执行。',
      'Starting reads groups on the poll interval and lets new Tickets run.'],
    resumeHint: ['恢复后会继续评估、派工与回复。', 'Resuming continues Eval, dispatch and replies.'],
    startTitle: ['启动自动化？', 'Start automation?'],
    resumeTitle: ['恢复处理？', 'Resume processing?'],
    startMessage: ['将恢复处理、启用引擎并启用执行器。启用后群消息会按轮询间隔读取，新工单会开始执行。',
      'This resumes processing, enables intake and turns the executor on; group messages will be read on the interval and new Tickets will run.'],
    resumeMessage: ['将恢复处理：继续评估、派工与回复。', 'This resumes processing: Eval, dispatch and replies continue.'],
    started: ['自动化已启动。', 'Automation started.'],
  },
  toast: {
    verifyOk: ['核对完成：UAT 可访问，构建已更新。', 'Checked: UAT reachable, new build detected.'],
    verifyDown: ['核对完成：UAT 当前不可访问，详见工单详情。', 'Checked: UAT is not reachable right now; see the Ticket detail.'],
    ciDone: ['CI 已刷新：{status}', 'CI refreshed: {status}'],
    ciNoToken: ['没有 GitLab token，无法观测 CI。', 'No GitLab token, CI cannot be observed.'],
    dryDone: ['干跑完成。', 'Dry run finished.'],
    publishStarted: ['已开始发布：闸门失败会自动让 worker 修复并重试，进度看工单状态',
      'Publish started; a failing gate is repaired by the worker and retried'],
    publishDone: ['已发布 MR #{iid}', 'Published MR #{iid}'],
    publishPushed: ['已推送分支。', 'Branch pushed.'],
    pollDone: ['检查完成：可接单 {accepted} · 忽略 {ignored}（干跑，未写入）', 'Check finished: {accepted} acceptable · {ignored} ignored (dry run, nothing written)'],
    pauseDone: ['已暂停处理。', 'Processing paused.'],
    resumeDone: ['已恢复处理。', 'Processing resumed.'],
    configReloaded: ['配置已重载。', 'Configuration reloaded.'],
  },
  // Stage rail: the colour-coded icon is aria-hidden, so each step also prints its state word (WIG 1.4.1).
  'railState.done': ['完成', 'Done'],
  'railState.ongoing': ['进行中', 'Ongoing'],
  'railState.warning': ['有警告', 'Warning'],
  'railState.error': ['失败', 'Failed'],
  'railState.idle': ['未开始', 'Not started'],
  // Polled ticket list: announce the count that changed, never the whole list (WIG A6).
  'list.status': ['共 {count} 张工单', '{count} tickets'],
  // Manual create form: a placeholder is not a label (WIG B).
  'st.titleLabel': ['工单标题', 'Ticket title'],
  'st.bodyLabel': ['需求正文', 'Request body'],
  // A raw run error opens in a fold instead of stretching the row (WIG B).
  'run.rawError': ['原始错误', 'Raw error'],
})

const TEXT_GROUPS = ['pilotPhase', 'pilotRunStatus', 'pilotTicketStatus', 'pilotGate',
  'ticketState', 'group', 'primary', 'disposition', 'rail', 'gate', 'result', 'shell', 'menu', 'row', 'flow', 'load',
  'problem', 'problemAction', 'repo', 'thread', 'ticket', 'ticket.event', 'ticket.step', 'actions', 'toast',
  'runTrigger', 'runStop', 'runState', 'automation']
for (const group of TEXT_GROUPS) {
  const nested = PAGE_TEXT[group]
  if (!nested || Array.isArray(nested)) continue
  for (const [key, pair] of Object.entries(nested)) PAGE_TEXT[`${group}.${key}`] = pair
  delete PAGE_TEXT[group]
}

/** Language for pure helpers and class components that cannot call `usePanel`; App sets it from `t.lang`. */
const liveText = (zh, en) => PANEL_LANG === 'en' ? en : zh
const localizedText = value => typeof value === 'string' ? value : value ? (value[PANEL_LANG] ?? value.zh ?? '') : ''
/** `hh:mm:ss` for the header; prefers the shared helper and degrades to the locale clock. */
function liveClock(value) {
  if (!value) return '—'
  if (typeof hhmmss === 'function') return hhmmss(value, PANEL_LANG)
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleTimeString(PANEL_LANG === 'en' ? 'en' : 'zh-CN', { hour12: false })
}
/** Short record id (never used for the row title itself, only in detail/raw places). */
function liveShortId(value, length = 6) {
  if (typeof shortId === 'function') return shortId(value, length)
  const text = String(value ?? '')
  return text.length > length + 1 ? `${text.slice(0, length)}…` : text
}

// ---- repositories (contract §12: several repositories behind one panel) -----------------------------------------

/** Repository summaries for the panel: `config.repos` when the host exposes it, else the status-level `repos`. */
function panelRepos(data) {
  const configRepos = data?.config?.repos
  if (Array.isArray(configRepos) && configRepos.length) return configRepos
  return Array.isArray(data?.repos) ? data.repos : []
}

/** Default repository id: the config default, the status fallback, then the first repository. */
function panelDefaultRepo(data) {
  return data?.config?.defaultRepo ?? data?.defaultRepo ?? panelRepos(data)[0]?.id
}

/** One repository summary by id; a Ticket must show its own repository, never another one's name. */
function panelRepoOf(data, repoId) {
  if (!repoId) return undefined
  return panelRepos(data).find(repo => repo && repo.id === repoId)
}

const REPO_VERIFY_MODE_KEYS = { 'web-uat': 'repo.verifyModeWebUat', manual: 'repo.verifyModeManual' }
const REPO_ACCEPTANCE_KEYS = { deployed: 'repo.acceptanceDeployed', merged: 'repo.acceptanceMerged' }

/** Repository verify mode → Chinese label; an unknown value stays visible instead of pretending to be known. */
function repoVerifyModeText(t, mode) {
  if (!mode) return pt(t, 'repo.unknownMode', { mode: '—' })
  const key = REPO_VERIFY_MODE_KEYS[mode]
  return key ? pt(t, key) : pt(t, 'repo.unknownMode', { mode })
}

/** Repository acceptance mode → Chinese label (`deployed` / `merged`). */
function repoAcceptanceText(t, acceptance) {
  if (!acceptance) return pt(t, 'repo.unknownMode', { mode: '—' })
  const key = REPO_ACCEPTANCE_KEYS[acceptance]
  return key ? pt(t, key) : pt(t, 'repo.unknownMode', { mode: acceptance })
}

/** Automation summary in the operator's language: mirrors lib/live/schedule.js `describeAutomation` on the client. */
function automationSummaryText(t, automation) {
  if (!automation || automation.enabled !== true || automation.mode === 'off') return ''
  if (automation.mode === 'heartbeat') {
    const raw = Number(automation.intervalMinutes)
    const minutes = Number.isFinite(raw) && raw > 0 ? raw : 60
    return minutes % 60 === 0 ? pt(t, 'auto.everyHours', { hours: minutes / 60 })
      : pt(t, 'auto.everyMinutes', { minutes })
  }
  if (automation.mode === 'schedule') return pt(t, 'auto.daily', { time: String(automation.at || '09:00') })
  return ''
}

/** The row chip for a self-running Ticket; the tooltip carries the next run when the host computed one. */
function automationChip(t, ticket) {
  const automation = ticket?.automation
  if (!automation || automation.enabled !== true || automation.mode === 'off') return null
  const label = automationSummaryText(t, automation)
  if (!label) return null
  const nextAt = automation.nextAt
    ? pt(t, 'auto.nextAt', { time: fullTime(automation.nextAt, PANEL_LANG) || String(automation.nextAt) })
    : ''
  // The next run used to live in a title tooltip only (no touch, no keyboard): a focusable InfoTip exposes it.
  return <Fragment key="automation">
    <Tag tone="info">{label}</Tag>
    {nextAt ? <InfoTip key="automation-next" text={nextAt} /> : null}
  </Fragment>
}

/** Engine skip reason → the operator's label; an unknown code stays visible (contract §1.1 SKIP_REASONS). */
const AUTO_SKIP_KEYS = { paused: 'auto.skip.paused', 'dispatch-paused': 'auto.skip.dispatchPaused',
  'executor-disabled': 'auto.skip.executorDisabled',
  working: 'auto.skip.working', parked: 'auto.skip.parked', 'max-executions': 'auto.skip.maxExecutions',
  'repo-disabled': 'auto.skip.repoDisabled', 'no-repo': 'auto.skip.noRepo', due: 'auto.skip.due' }
function autoSkipReasonText(t, reason) {
  const key = AUTO_SKIP_KEYS[String(reason ?? '')]
  return key ? pt(t, key) : String(reason ?? '')
}

// ---- status model ---------------------------------------------------------------------------------------------

/** Engine ticket status → shape, tag tone, group, whether a person has to act, and the one row action. */
const TICKET_VIEW = {
  queued: { state: 'idle', tone: 'outline', group: 'queued', needsHuman: false, primary: 'progress' },
  ready: { state: 'idle', tone: 'outline', group: 'queued', needsHuman: false, primary: 'progress' },
  working: { state: 'ongoing', tone: 'info', group: 'working', needsHuman: false, primary: 'none' },
  pushed: { state: 'warning', tone: 'warning', group: 'working', needsHuman: true, primary: 'merge' },
  'ci-pending': { state: 'ongoing', tone: 'info', group: 'working', needsHuman: false, primary: 'none' },
  merged: { state: 'ongoing', tone: 'info', group: 'working', needsHuman: false, primary: 'deploy' },
  'deploy-pending': { state: 'ongoing', tone: 'info', group: 'working', needsHuman: false, primary: 'deploy' },
  'ci-passed': { state: 'idle', tone: 'success', group: 'waiting', needsHuman: true, primary: 'merge' },
  'mr-open': { state: 'idle', tone: 'warning', group: 'waiting', needsHuman: true, primary: 'openMr' },
  deployed: { state: 'idle', tone: 'success', group: 'waiting', needsHuman: true, primary: 'accept' },
  closed: { state: 'done', tone: 'neutral', group: 'done', needsHuman: false, primary: 'none' },
  // A dismissed Ticket is an end state a person chose, not a success: the hollow idle shape keeps it out of the
  // green-check family (a Ticket dismissed right after a failed run used to read as "done fine").
  dismissed: { state: 'idle', tone: 'neutral', group: 'done', needsHuman: false, primary: 'none' },
  'dry-run': { state: 'done', tone: 'info', group: 'done', needsHuman: false, primary: 'none' },
  running: { state: 'ongoing', tone: 'info', group: 'working', needsHuman: false, primary: 'none' },
  // A parked gate is non-terminal and belongs to the person (P0-3): the row says so and its one action opens the detail.
  'gate-blocked': { state: 'warning', tone: 'warning', group: 'waiting', needsHuman: true, primary: 'gate' },
  // P1-4: the worker asked a question; the Ticket waits in the same shape as a gate park, with the answer as its action.
  'awaiting-answer': { state: 'warning', tone: 'warning', group: 'waiting', needsHuman: true, primary: 'answer' },
  // Run-level statuses (runs never reach the waiting/failed ticket groups; they only borrow the label and shape).
  waiting_for_human: { state: 'warning', tone: 'warning', group: 'working', needsHuman: false, primary: 'none' },
  interrupted: { state: 'warning', tone: 'warning', group: 'failed', needsHuman: false, primary: 'none' },
  failed: { state: 'error', tone: 'danger', group: 'failed', needsHuman: true, primary: 'diagnose' },
  'ci-failed': { state: 'error', tone: 'danger', group: 'failed', needsHuman: true, primary: 'diagnose' },
  'deploy-failed': { state: 'error', tone: 'danger', group: 'failed', needsHuman: true, primary: 'diagnose' },
}

/**
 * A Ticket's raw engine status → the phase view, before the human sign-off is applied.
 * Repositories accepted after the merge (no CI/UAT, contract §12) keep `merged` waiting for a person.
 */
function ticketBaseView(ticket) {
  const key = ticket?.status ?? ticket?.stage
  if (ticket?.repoAcceptance === 'merged' && ticket?.status === 'merged') {
    return { key: 'merged', state: 'idle', tone: 'success', group: 'waiting', needsHuman: true, primary: 'accept',
      labelKey: 'ticketState.merged' }
  }
  const view = TICKET_VIEW[key] ? { key, ...TICKET_VIEW[key] } : { key: 'unknown', ...TICKET_VIEW.queued, state: 'idle', group: 'queued', primary: 'none' }
  view.labelKey = `ticketState.${view.key}`
  return view
}

/**
 * The person's sign-off on a Ticket (spec §3.6.1), orthogonal to the engine status.
 * → { state: 'accepted'|'rejected'|'pending'|'none', at?, note? }.
 * A Ticket only has a *pending* sign-off while its phase view waits for a person with accept/merge as the one action;
 * every other status owns no acceptance duty.
 */
function ticketAcceptanceOf(ticket) {
  const acceptance = ticket?.links?.acceptance
  if (acceptance?.ok === true) return { state: 'accepted', at: acceptance.at, note: acceptance.note }
  if (acceptance?.ok === false) return { state: 'rejected', at: acceptance.at, note: acceptance.note }
  const base = ticketBaseView(ticket)
  if (base.group === 'waiting' && (base.primary === 'accept' || base.primary === 'merge')) return { state: 'pending' }
  return { state: 'none' }
}

/**
 * One Ticket status → the view every page renders.
 * → { key, state, tone, group, needsHuman, primary, acceptance, labelKey } (label key is read through `pt`).
 * The sign-off is a property of the Ticket, not of the engine status: an accepted Ticket keeps its phase key/state/tone
 * (the row still says “已部署 UAT”) but leaves the attention groups and owns no primary action.
 */
function ticketStatus(ticket) {
  const view = ticketBaseView(ticket)
  const acceptance = ticketAcceptanceOf(ticket)
  if (acceptance.state === 'accepted') {
    return { ...view, group: 'done', needsHuman: false, primary: 'none', acceptance }
  }
  // AC-03: a stop that has been requested but not yet confirmed is its own visible state. Leaving the chip on
  // "执行中" was indistinguishable from a run that is not stopping, and the stop action is already disabled.
  if (ticket?.stopRequested) {
    return { ...view, acceptance, labelKey: 'ticket.stopping', needsHuman: false, primary: 'none' }
  }
  return { ...view, acceptance }
}

/**
 * The middle row chip for a Ticket with an acceptance duty: the sign-off fact, or the wait the person owns. A pending
 * sign-off borrows the shared wait wording (验收 vs 合并) so the same fact is never printed twice on one row.
 */
function rowAcceptanceChip(t, view) {
  const acceptance = view?.acceptance
  if (!acceptance || acceptance.state === 'none') return null
  if (acceptance.state === 'accepted') return <Tag key="acceptance" tone="success">{pt(t, 'row.acceptanceAccepted')}</Tag>
  if (acceptance.state === 'rejected') return <Tag key="acceptance" tone="danger">{pt(t, 'row.acceptanceRejected')}</Tag>
  return <Tag key="acceptance" tone="warning">{pt(t, view.primary === 'merge' ? 'row.evidenceMerge' : 'row.evidenceReview')}</Tag>
}

/** Latest run of one Ticket: the detail payload carries `ticket.runs`; list rows rely on the status document's index. */
function latestRunFor(ticket, runs) {
  const inline = Array.isArray(ticket?.runs) ? ticket.runs.filter(Boolean) : []
  const pool = inline.length ? inline : (Array.isArray(runs) ? runs.filter(run => run && run.ticketId === ticket?.id) : [])
  return [...pool].sort((left, right) => String(right?.startedAt ?? '').localeCompare(String(left?.startedAt ?? '')))[0]
}

/** True when the newest run of the Ticket was interrupted by a plugin reload / host restart (P1-5). */
function ticketRunInterrupted(ticket, runs) {
  return latestRunFor(ticket, runs)?.status === 'interrupted'
}

/** How a run was started (P1-2 `run.trigger`) → the operator's label; a missing trigger renders nothing. */
const RUN_TRIGGER_KEYS = { manual: 'runTrigger.manual', auto: 'runTrigger.auto', retry: 'runTrigger.retry',
  revise: 'runTrigger.revise', publish: 'runTrigger.publish', resume: 'runTrigger.resume', pipeline: 'runTrigger.pipeline' }
function runTriggerLabel(t, run) {
  const trigger = run?.trigger
  if (!trigger) return null
  const key = RUN_TRIGGER_KEYS[String(trigger)]
  return key ? pt(t, key) : pt(t, 'runTrigger.other', { trigger: String(trigger) })
}

/** Why a run stopped (P0 `run.stopReason`/`errorCode`) → label + tone; an unknown reason stays visible. */
const RUN_STOP_REASON_KEYS = { done: 'runStop.done', error: 'runStop.error', timeout: 'runStop.timeout',
  worker_failed: 'runStop.worker_failed', no_changes: 'runStop.no_changes', gate_failed: 'runStop.gate_failed',
  prepare_failed: 'runStop.prepare_failed', bootstrap_failed: 'runStop.bootstrap_failed', guard_failed: 'runStop.guard_failed',
  commit_failed: 'runStop.commit_failed', push_failed: 'runStop.push_failed', mr_failed: 'runStop.mr_failed',
  interrupted: 'runStop.interrupted', stopped: 'runStop.stopped' }
const RUN_STOP_TONE = { done: 'success', no_changes: 'warning', gate_failed: 'warning', mr_failed: 'warning',
  interrupted: 'warning', stopped: 'neutral', error: 'danger', timeout: 'danger', worker_failed: 'danger',
  prepare_failed: 'danger', bootstrap_failed: 'danger', guard_failed: 'danger', commit_failed: 'danger', push_failed: 'danger' }
function runStopLabel(t, run) {
  const reason = run?.stopReason ?? run?.errorCode
  if (!reason) return null
  const key = RUN_STOP_REASON_KEYS[String(reason)]
  return { tone: RUN_STOP_TONE[String(reason)] ?? 'outline',
    label: key ? pt(t, key) : pt(t, 'runStop.other', { reason: String(reason) }) }
}

/**
 * Ticket phases a run can keep as its last recorded status: the run had already delivered, so these name where the
 * Ticket went on — not what the run is doing. `run.status` is written once at hand-off and never updated afterwards
 * (`ci-pending` stays `ci-pending` after CI passed, the MR merged, the deploy succeeded and the Ticket was accepted).
 */
const RUN_HANDOFF_STATUSES = new Set(['ci-pending', 'ci-passed', 'mr-open', 'pushed', 'merged', 'deploy-pending',
  'gates-passed', 'ready'])
/** A settled run's shape comes from how it ended (`stopReason`); an unknown reason keeps the phase's own shape. */
const RUN_STOP_STATE = { done: 'done', no_changes: 'warning', gate_failed: 'warning', mr_failed: 'warning',
  interrupted: 'warning', stopped: 'idle', error: 'error', timeout: 'error', worker_failed: 'error',
  prepare_failed: 'error', bootstrap_failed: 'error', guard_failed: 'error', commit_failed: 'error', push_failed: 'error' }

/**
 * One run → the state and label its row renders. A run that stopped at hand-off must never borrow the phase's live
 * shape: `ci-pending` used to keep a spinner turning on an accepted Ticket (the run had finished hours earlier).
 * → { state, label } — the phase stays readable as "交付时：…", with `runStopLabel` carrying the outcome tag.
 */
function runView(t, run) {
  const base = ticketStatus({ status: run?.status })
  const reason = String(run?.stopReason ?? run?.errorCode ?? '')
  const settled = Boolean(reason) && run?.status !== 'running' && run?.status !== 'waiting_for_human'
  if (!settled || !RUN_HANDOFF_STATUSES.has(String(run?.status))) return { state: base.state, label: pt(t, base.labelKey) }
  return { state: RUN_STOP_STATE[reason] ?? base.state, label: pt(t, 'runState.handoff', { phase: pt(t, base.labelKey) }) }
}

/** Old public seam: status string → tag tone. Kept because pages may still import it. */
function pilotTone(status) {
  if (['deployed', 'merged', 'ci-passed', 'ok', 'idle', 'done'].includes(status)) return 'success'
  if (['deploy-pending', 'ci-pending', 'mr-open', 'working', 'queued', 'ready', 'pushed', 'gates-passed', 'warning'].includes(status)) return 'warning'
  if (['deploy-failed', 'ci-failed', 'failed', 'error', 'blocked'].includes(status)) return 'danger'
  return 'outline'
}

/** Legacy signature: render one status tag from a `pilot*` dictionary; new code uses TicketStatusTag/TicketRow. */
function PilotStatusTag({ status, group = 'pilotTicketStatus' }) {
  const { t } = usePanel()
  const key = `${group}.${status}`
  const label = pt(t, key)
  return <Tag tone={pilotTone(status)}>{label === key ? status : label}</Tag>
}

/** Status tag for a raw ticket; the Chinese label always comes from `ticketStatus`. */
function TicketStatusTag({ ticket }) {
  const { t } = usePanel()
  const view = ticketStatus(ticket)
  const unknown = view.key === 'unknown' && ticket?.status ? `（${ticket.status}）` : ''
  return <Tag tone={view.tone}>{pt(t, view.labelKey) + unknown}</Tag>
}

/**
 * One automation state line for three switches that are one story: processing paused, intake enabled,
 * executor enabled. Its one primary action starts all missing parts together; other surfaces link here
 * instead of repeating the same warning in four places.
 */
function AutomationBar({ paused, engineEnabled, executorEnabled, onStart, onCheck, checkBusy = false, compact = false, progress }) {
  const { t } = usePanel()
  const onlyPaused = paused && engineEnabled && executorEnabled
  const facts = []
  if (paused) facts.push(pt(t, 'automation.paused'))
  if (!engineEnabled) facts.push(pt(t, 'automation.engineOff'))
  if (!executorEnabled) facts.push(pt(t, 'automation.executorOff'))
  const title = onlyPaused ? pt(t, 'automation.pausedTitle') : pt(t, 'automation.offTitle')
  const hint = onlyPaused ? pt(t, 'automation.resumeHint') : pt(t, 'automation.startHint')
  const progressText = progress && progress.done < progress.total
    ? pt(t, 'shell.setupChip', { done: progress.done, total: progress.total }) : null
  return <div className="sa-automation" role="group" aria-label={title} data-compact={compact ? 'true' : undefined}>
    <div className="sa-automation-main">
      {/* The icon travels with the title: as a sibling of the flex-basis block it wrapped onto a line of its own on a
          390px panel, leaving a lone warning triangle above the sentence (critique 2026-11-11). */}
      <div className="sa-automation-head">
        <StatusIcon state="warning" size={16} />
        <span className="sa-automation-title">{title}</span>
      </div>
      <span className="sa-automation-facts">{facts.join(' · ')}
        {progressText ? <> · {progressText}</> : null}
      </span>
      {compact ? null : <span className="sa-hint">{hint}</span>}
    </div>
    <div className="sa-automation-actions">
      {onCheck ? <Button variant="ghost" size="sm" icon={<Icon name="message" size={14} />}
        disabled={checkBusy} onClick={onCheck}>{pt(t, 'actions.checkNow')}</Button> : null}
      <ConfirmButton
        label={onlyPaused ? pt(t, 'automation.resume') : pt(t, 'automation.start')}
        confirmLabel={onlyPaused ? pt(t, 'automation.resume') : pt(t, 'automation.start')}
        title={onlyPaused ? pt(t, 'automation.resumeTitle') : pt(t, 'automation.startTitle')}
        message={onlyPaused ? pt(t, 'automation.resumeMessage') : pt(t, 'automation.startMessage')}
        variant="primary" icon="play" onConfirm={onStart} />
    </div>
  </div>
}

/** The one result worth a second tag in a row. */
function keyResultOf(ticket) {
  switch (ticket?.status) {
    case 'deployed': return { tone: 'success', labelKey: 'result.uatOk' }
    case 'ci-failed': case 'deploy-failed': case 'failed': return { tone: 'danger', labelKey: 'result.failed' }
    case 'ci-pending': return { tone: 'info', labelKey: 'result.ciPending' }
    case 'ci-passed': return { tone: 'success', labelKey: 'result.ciPassed' }
    case 'merged': return { tone: 'success', labelKey: 'result.merged' }
    case 'deploy-pending': return { tone: 'info', labelKey: 'result.deploying' }
    case 'mr-open': return { tone: 'warning', labelKey: 'result.mrOpen' }
    case 'pushed': return { tone: 'warning', labelKey: 'result.pushed' }
    case 'closed': return { tone: 'neutral', labelKey: 'result.closed' }
    default: return null
  }
}

/** Decision kind → shape/tone/label; the label key is a shared `decision.*` entry. */
function decisionKindView(decision) {
  const kind = decision?.kind ?? decision?.outcome ?? 'unavailable'
  const map = {
    accept: { state: 'done', tone: 'success' }, reopen: { state: 'ongoing', tone: 'info' },
    stop: { state: 'warning', tone: 'warning' }, ignore: { state: 'idle', tone: 'neutral' },
    unavailable: { state: 'warning', tone: 'warning' }, wouldAccept: { state: 'done', tone: 'info' },
  }
  const view = map[kind] ?? { state: 'idle', tone: 'outline' }
  return { ...view, kind, labelKey: `decision.${kind}` }
}

/** Where one trigger went: queued/evaluating/delivered/fanout/filtered, with a shape and a label key. */
function dispositionView(trigger, decision) {
  const disposition = trigger?.disposition ?? {}
  const fanout = Array.isArray(disposition.fanout) ? disposition.fanout : []
  if (!trigger || !disposition.decisionId) return { state: 'idle', labelKey: 'disposition.queued' }
  if (!decision) return { state: 'ongoing', labelKey: 'disposition.evaluating' }
  const view = decisionKindView(decision)
  if (view.kind === 'ignore') return { state: 'idle', labelKey: 'disposition.filtered' }
  if (view.kind === 'unavailable') return { state: 'warning', labelKey: 'disposition.evaluating' }
  if (fanout.length > 1) return { state: 'done', labelKey: 'disposition.fanout' }
  return { state: 'done', labelKey: 'disposition.delivered' }
}

/** Tickets that wait for a person, worst first (error > warning > waiting), derived from `status.tickets`. */
const SEVERITY_RANK = { error: 0, warning: 1, idle: 2, ongoing: 3, done: 4 }
function needsHuman(data) {
  const tickets = Array.isArray(data?.tickets) ? data.tickets : []
  return tickets.filter(ticket => ticketStatus(ticket).needsHuman)
    .sort((left, right) => {
      const a = ticketStatus(left), b = ticketStatus(right)
      return (SEVERITY_RANK[a.state] ?? 9) - (SEVERITY_RANK[b.state] ?? 9)
        || String(right.updatedAt ?? right.createdAt ?? '').localeCompare(String(left.updatedAt ?? left.createdAt ?? ''))
    })
}

/** The number every "needs you" surface shows: the host count (covers records beyond the 20-ticket window). */
function needsYouCount(data) {
  const host = data?.counts?.needsHuman
  if (Number.isFinite(host)) return host
  return needsHuman(data).length
}

/**
 * System-level problems derived from the status document (not from tickets — those are needsHuman).
 * Each entry: { key, severity: 'error'|'warning', title, detail, action: { labelKey, kind, payload } }.
 * `kind` tells the page how to wire the action: 'poll' | 'reloadConfig' | 'navigate'.
 */
function problemsOf(data) {
  const out = []
  if (!data) return out
  const engine = data.engine ?? {}
  const config = data.config ?? {}
  if (engine.phase === 'error' || engine.lastError) {
    out.push({ key: 'engine-error', severity: 'error', title: liveText('引擎报告异常', 'The engine reported an error'),
      detail: String(engine.lastError ?? engine.error ?? liveText('未知错误', 'Unknown error')),
      action: { labelKey: 'problemAction.retry', kind: 'poll', payload: { dryRun: true } } })
  }
  if (data.paused === true || config.paused === true || engine.paused === true) {
    out.push({ key: 'paused', severity: 'warning', title: liveText('处理已暂停', 'Processing is paused'),
      detail: liveText('恢复前不会开始新的评估、派工或回复。', 'No new Eval, dispatch or reply runs until you resume.'),
      action: { labelKey: 'problemAction.execution', kind: 'navigate', payload: { page: 'execution' } } })
  }
  if (config.enabled === false) {
    out.push({ key: 'engine-off', severity: 'warning', title: liveText('自动触发未开启', 'Automatic intake is off'),
      detail: liveText('在设置→来源打开「启用引擎」并保存后，引擎才会自动轮询群消息。',
        'Turn on “Engine enabled” under Settings → Source and save; the engine then polls the groups automatically.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings', group: 'source' } } })
  }
  if (config.octo && config.octo.tokenConfigured === false) {
    out.push({ key: 'octo-token', severity: 'warning', title: liveText('Octo token 未配置', 'Octo token is missing'),
      detail: liveText('在设置→来源保存 Octo token 后，引擎才能读取群消息。',
        'Save the Octo token under Settings → Source so the engine can read group messages.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings', group: 'source' } } })
  }
  if (config.octo && config.octo.allowAnyHuman !== true
    && !(Array.isArray(config.octo.allowSenderIds) && config.octo.allowSenderIds.length > 0)) {
    out.push({ key: 'octo-senders', severity: 'warning', title: liveText('没有允许的触发人', 'No allowed sender'),
      detail: liveText('在设置→来源开启「允许任意人类」或添加发送者；否则真实轮询会被引擎拒绝。',
        'Turn on “accept any human” or add allowed senders under Settings → Source; otherwise a live poll is refused.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings', group: 'source' } } })
  }
  if (config.gitlab && config.gitlab.tokenConfigured === false) {
    out.push({ key: 'gitlab-token', severity: 'warning', title: liveText('GitLab token 未配置', 'GitLab token is missing'),
      detail: liveText('在设置→仓库为对应仓库保存 GitLab token 后，才能观测 CI 与部署。',
        'Save a GitLab token for the repository under Settings → Repositories to observe CI and deployment.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings', group: 'repos' } } })
  }
  const sources = Array.isArray(data.sources) ? data.sources : []
  for (const source of sources) {
    if (source.state !== 'error') continue
    const name = localizedText(source.title) || source.id
    out.push({ key: `source-${source.id}`, severity: 'error', title: ptValues('problem.sourceError', { name }),
      detail: String(source.detail ?? liveText('来源正在报错。', 'The source is failing.')),
      action: { labelKey: 'problemAction.reload', kind: 'reloadConfig', payload: {} } })
  }
  return out
}

/** Interpolate one PAGE_TEXT pair outside a component (pure helpers such as problemsOf). */
function ptValues(key, values) {
  const pair = PAGE_TEXT[key]
  const template = pair ? pair[PANEL_LANG === 'en' ? 1 : 0] : key
  return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}

// ---- list building blocks -------------------------------------------------------------------------------------

/** Primary row action for a view: the label key plus how TicketRow executes it. */
function primaryActionOf(ticket, view) {
  const mergeRequest = ticket.links?.mergeRequest ?? {}
  const external = mergeRequest.webUrl
  switch (view.primary) {
    // Acceptance is a human decision made on the detail (open UAT, check the UC/AC, then accept/reject);
    // the row must not silently re-run the automatic check and look like nothing happened.
    case 'accept': return { labelKey: 'primary.accept', kind: 'detail' }
    case 'merge':
      if (ticket.status === 'pushed') return { labelKey: 'menu.publish', kind: 'publish' }
      return external ? { labelKey: 'primary.merge', kind: 'external', href: external } : { labelKey: 'primary.merge', kind: 'detail' }
    case 'openMr': return external ? { labelKey: 'primary.openMr', kind: 'external', href: external } : { labelKey: 'primary.openMr', kind: 'detail' }
    case 'deploy': return { labelKey: 'primary.deploy', kind: 'refreshCi' }
    case 'diagnose': return { labelKey: 'primary.diagnose', kind: 'detail' }
    // A parked gate needs the three-way human decision that only the detail can state; the row opens it. A parked
    // question is the same contract: the answer form lives in the detail banner.
    case 'gate': return { labelKey: 'primary.gate', kind: 'detail' }
    case 'answer': return { labelKey: 'primary.answer', kind: 'detail' }
    case 'progress': return { labelKey: 'primary.progress', kind: 'dryRun' }
    default: return null
  }
}

/** Known failure text → one short cause sentence; anything unrecognised falls back to the (clipped) original text, so a
    new error kind is never swallowed. The full original always stays reachable (fold in the banner, hover on a run row). */
const FAILURE_LABELS = [
  { pattern: /interrupted by a plugin reload|plugin reload|host restart/i, key: 'detail.errorInterrupted' },
  { pattern: /Cannot read propert|reading 'get'|host context|agents service is not available/i, key: 'detail.errorInternal' },
  { pattern: /no changes/i, key: 'detail.errorNoChanges' },
  { pattern: /CLI not found|cli was not found|ENOENT|not logged in|signed out/i, key: 'detail.errorCli' },
  { pattern: /timed out|timeout/i, key: 'detail.errorTimeout' },
  { pattern: /gate failed|gates? (did not pass|failed)/i, key: 'detail.errorGate' },
]
const FAILURE_RAW_LIMIT = 120
/** True when the text is one of the known failure causes (used to map step messages too, not only run.error). */
const failureKnown = text => FAILURE_LABELS.some(item => item.pattern.test(String(text ?? '')))
function failureLabel(t, error) {
  const text = String(error ?? '').trim()
  if (!text) return ''
  const known = FAILURE_LABELS.find(item => item.pattern.test(text))
  if (known) return pt(t, known.key)
  return text.length > FAILURE_RAW_LIMIT ? `${text.slice(0, FAILURE_RAW_LIMIT)}…` : text
}

/**
 * The one piece of physical evidence the execution ledger shows on the right: the gate that parked the run, the MR that
 * shipped it, the Chinese cause of a failed run, or the current run's age — exactly one of those, never a status or a
 * result a chip already states (P0 §3.6.4: state + acceptance/result + time are the row's whole information budget).
 */
function ticketEvidence(t, ticket, view, now = Date.now()) {
  const links = ticket?.links ?? {}
  const assignments = Array.isArray(ticket?.assignments) ? ticket.assignments : []
  // A parked gate: the gate's name is the evidence a person needs; the state and the wait are on the chips.
  if (ticket?.status === 'gate-blocked') {
    const name = ticket.pendingGate?.name
    return name ? pt(t, 'row.evidenceGate', { name }) : pt(t, 'row.evidenceGateWait')
  }
  const failed = [...assignments].reverse().find(assignment => assignment?.report?.state === 'failed')
  const recovered = view?.group === 'done' || ['merged', 'deployed'].includes(ticket?.status)
  if (failed && !recovered) {
    const raw = String(failed.report?.text ?? '')
    const cause = failureLabel(t, raw)
    // The full error was tooltip-only (no touch, no keyboard): the short cause stays visible and the raw text sits
    // behind a focusable info control when it says more than the sentence. The wrapper lifts it above the row's
    // stretched link overlay so it stays operable.
    return <>
      {raw.trim() && raw.trim() !== cause
        ? <span style={{ position: 'relative', zIndex: 1 }}><InfoTip text={raw} /></span>
        : null}
      <span>{pt(t, 'row.evidenceCause', { cause })}</span>
    </>
  }
  const mr = links.mergeRequest ?? {}
  // AC-05: a push-mode create link is not a Pull Request. Only an iid proves one exists; until then the row says the
  // branch is pushed and waits for the PR, and the link is labelled as the create entry (not "PR opened").
  // A merged/deployed Ticket is past that stage: saying "waiting for PR" beside a 已合并 tag contradicts the state.
  const merged = ['merged', 'deployed'].includes(ticket?.status)
    || links.verification?.merged === true || links.acceptance?.ok === true
  const prWaiting = !merged && !mr.iid && (mr.pending === true || Boolean(mr.webUrl))
  if (mr.iid || mr.webUrl) {
    const label = mr.iid ? pt(t, 'row.evidenceMr', { iid: mr.iid })
      : merged ? pt(t, 'ticket.mergedYes')
        : prWaiting ? pt(t, 'row.evidencePrWaiting') : pt(t, 'row.evidencePr')
    const href = safeHttpUrl(mr.webUrl)
    return href
      ? <a className="sa-inline-link sa-mono" href={href} target="_blank" rel="noopener noreferrer"
        title={href} onClick={event => event.stopPropagation()}>{label}</a>
      : <span className="sa-mono">{label}</span>
  }
  if (merged) return <span className="sa-mono">{pt(t, 'ticket.mergedYes')}</span>
  const running = assignments.at(-1)
  if (view?.group === 'working' && running?.startedAt) {
    const minutes = Math.max(0, Math.floor((now - Date.parse(running.startedAt)) / 60_000))
    return pt(t, 'row.evidenceRunning', { minutes })
  }
  return ''
}

/**
 * The core ticket row (spec 7.3): status shape + title + at most three tags, one primary action and a ⋯ menu.
 * The whole row opens the detail route; inner controls stop propagation. Height is never below 44px.
 */
/**
 * The core ticket row (spec 7.3): status shape + title + at most three tags, one primary action and a ⋯ menu.
 * The whole row opens the detail route; inner controls stop propagation. Height is never below 44px (CSS).
 */
function TicketRow({ ticket, page = 'execution', actions, reload, compact = false, extra, now }) {
  const { t, navigate, notify } = usePanel()
  const model = usePanelData()
  const act = actions ?? model?.actions
  const refreshAll = reload ?? model?.reload
  const data = model?.data
  const view = ticketStatus(ticket)
  const result = keyResultOf(ticket)
  const [pending, setPending] = useState(null)
  const [dismissOpen, setDismissOpen] = useState(false)
  const open = useCallback(() => navigate({ page, id: ticket.id }), [navigate, page, ticket.id])
  const dryRun = useAction(async () => { await act.runTicket(ticket.id, { dryRun: true, wait: false }); notify(pt(t, 'toast.dryDone')) },
    { reload: refreshAll })
  const publish = useAction(async () => {
    await act.publishTicket(ticket.id)
    notify(pt(t, 'toast.publishStarted'))
  }, { reload: refreshAll })
  const refreshCi = useAction(async () => {
    const result = await act.refreshCi(ticket.id)
    if (result?.skipped === 'no-token') notify(pt(t, 'toast.ciNoToken'))
    else notify(pt(t, 'toast.ciDone', { status: result?.status ?? result?.skipped ?? '—' }))
  }, { reload: refreshAll })
  const verify = useAction(async () => {
    const result = await act.verifyTicket(ticket.id)
    notify(pt(t, result?.verification?.uat?.ok ? 'toast.verifyOk' : 'toast.verifyDown'))
  }, { reload: refreshAll })
  const dismiss = useAction(async () => {
    const result = await act.dismissTicket(ticket.id)
    const cleanup = result?.cleanup ?? result?.ticket?.links?.cleanup
    notify(pt(t, cleanup ? 'detail.dismissRecorded' : 'detail.dismissRecordedBare'))
  }, { reload: refreshAll })
  const canPublish = Boolean(data?.config?.executor?.enabled && data?.config?.executor?.allowPush)
  const hasMr = Boolean(ticket.links?.mergeRequest?.iid || ticket.links?.mergeRequest?.webUrl)
  const primary = primaryActionOf(ticket, view)

  const busyOf = { verify: verify.busy, refreshCi: refreshCi.busy, dryRun: dryRun.busy, publish: publish.busy, dismiss: dismiss.busy }
  const branches = {
    verify: () => { void verify.run() },
    refreshCi: () => { void refreshCi.run() },
    dryRun: () => { void dryRun.run() },
    publish: () => setPending({ kind: 'publish' }),
    detail: open,
  }
  const externalHref = primary?.kind === 'external' ? safeHttpUrl(primary.href) : ''
  // A real link, not window.open: middle-click, Cmd-click and copy-link keep working, and it is keyboard reachable
  // (`.sa-btn` is class-based, so an <a> with the same classes renders as the same primary button).
  const primaryButton = !primary ? null
    : primary.kind === 'external'
      ? externalHref
        ? <a className="sa-btn sa-btn-primary sa-btn-sm" href={externalHref} target="_blank"
          rel="noopener noreferrer" style={{ textDecoration: 'none' }}
          onClick={event => event.stopPropagation()}>{pt(t, primary.labelKey)}</a>
        // An unsafe URL never becomes a link; the same action degrades to opening the detail.
        : <Button variant="primary" size="sm"
          onClick={event => { event.stopPropagation(); open() }}>{pt(t, primary.labelKey)}</Button>
      : <Button variant="primary" size="sm" disabled={Boolean(busyOf[primary.kind])}
        onClick={event => { event.stopPropagation(); branches[primary.kind]() }}>{pt(t, primary.labelKey)}</Button>
  const allItems = [
    { key: 'dryRun', label: pt(t, 'menu.dryRun'), onSelect: () => { void dryRun.run() }, disabled: dryRun.busy },
    { key: 'publish', label: pt(t, 'menu.publish'), onSelect: () => setPending({ kind: 'publish' }),
      disabled: publish.busy || !canPublish },
    { key: 'ci', label: pt(t, 'menu.refreshCi'), onSelect: () => { void refreshCi.run() }, disabled: refreshCi.busy || !hasMr },
    { key: 'verify', label: pt(t, 'menu.verify'), onSelect: () => { void verify.run() }, disabled: verify.busy },
    ...view.group === 'failed'
      ? [{ key: 'dismiss', label: pt(t, 'detail.dismiss'), onSelect: () => setDismissOpen(true), disabled: dismiss.busy }]
      : [],
  ]
  // A finished Ticket has nothing left to publish or verify: keep only the actions that still make sense (refresh CI,
  // dismiss a failed one) instead of offering three dead entries in an already short menu.
  const finished = ticketStatus(ticket).group === 'done' || ticket.links?.acceptance?.ok === true
  const items = allItems.filter(item => {
    if (finished && ['dryRun', 'publish', 'verify'].includes(item.key)) return false
    if (item.key === 'publish' && hasMr) return false
    return true
  })
  const stopInner = { onClick: event => event.stopPropagation(),
    onKeyDown: event => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() } }
  // The unavailable-publish reason is shared by the primary button and the ⋯ menu entry: one focusable info control
  // instead of a title tooltip (unreachable on touch, and a disabled menu item cannot take focus at all).
  const publishUnavailableTip = !canPublish && items.some(item => item.key === 'publish')
    ? <InfoTip text={pt(t, 'ticket.publishUnavailable')} warn /> : null
  // Multi-repository panels say which repository a Ticket belongs to; a plain text span, not a Tag, so the three-tag
  // budget of the row stays for state and result.
  const repoList = panelRepos(data)
  const repoName = ticket.repoName ?? panelRepoOf(data, ticket.repoId)?.name ?? ticket.repoId
  const showRepo = repoList.length > 1 && Boolean(repoName)
  const chips = [
    <Tag key="state" tone={view.tone}>{pt(t, view.labelKey)}</Tag>,
  ]
  // A dismissed Ticket is only neutral if it never failed; one dismissed right after a failed run says so.
  const failedBeforeDismiss = view.key === 'dismissed'
    && (Array.isArray(ticket.assignments) ? ticket.assignments : []).some(assignment => assignment?.report?.state === 'failed')
  if (failedBeforeDismiss) chips.push(<Tag key="dismissed-after-failure" tone="warning">{pt(t, 'dismissedAfterFailure')}</Tag>)
  // The left rail is the fast scan line; a done-but-accepted Ticket and a dismissed-after-failure Ticket must not
  // both read as the same hollow "idle" dot. Keep the phase keys/tags, only make the shape honest.
  const rowIconState = view.acceptance?.state === 'accepted' ? 'done'
    : view.acceptance?.state === 'rejected' || failedBeforeDismiss ? 'warning'
      : view.state
  // P1-5: a run interrupted by a plugin reload / host restart is resumable — the row says so before the phase label
  // (which still reads "排队中" after reconcile) can be mistaken for a healthy queue entry.
  const interrupted = ticketRunInterrupted(ticket, data?.runs)
  if (interrupted) chips.push(<Tag key="interrupted" tone="warning">{pt(t, 'row.interrupted')}</Tag>)
  // The middle slot is the person's sign-off when the Ticket has one, otherwise the one result worth a second tag
  // (P0 §3.6.4: 状态 + 验收/结果, never both). Time is the third chip and only where the row has room; the overview
  // (compact) keeps exactly two. The repository name stays a plain hint, outside the tag budget.
  const acceptanceChip = rowAcceptanceChip(t, view)
  // P2-1: a self-running Ticket says so in the middle slot (state + automation/result + time stays within the budget).
  const scheduleChip = automationChip(t, ticket)
  if (acceptanceChip) chips.push(acceptanceChip)
  else if (scheduleChip) chips.push(scheduleChip)
  else if (result) chips.push(<Tag key="result" tone={result.tone}>{pt(t, result.labelKey)}</Tag>)
  if (!compact && !interrupted) chips.push(<When key="at" at={ticket.updatedAt ?? ticket.createdAt} />)
  if (showRepo) chips.push(<span key="repo" className="sa-hint">{String(repoName)}</span>)
  if (extra) chips.push(<span key="extra" className="sa-hint">{extra}</span>)

  // The title is a real <button> so keyboard users get one focus stop, and the primary/⋯ controls are siblings of it —
  // never buttons nested inside a role=button row (G6). The evidence rail is the third track of the execution ledger;
  // other pages hide it via CSS and keep the flex row.
  const evidence = ticketEvidence(t, ticket, view, now)
  return <li>
    {/* The row div is not the click target any more: the title is a real button carrying `.sa-open`, whose stretched
        `::after` covers the whole row, so the row's primary action is one keyboard-reachable button (WIG: div click). */}
    <div className="sa-row sa-row-openable">
      <StatusIcon state={rowIconState} size={16} />
      <div className="sa-row-main">
        <div className="sa-row-title">
          <button type="button" className="sa-row-open sa-open"
            aria-label={`${ticket.title ?? pt(t, 'row.untitled')} — ${pt(t, view.labelKey)}`}
            onClick={open}>
            <span className="sa-ellipsis">{ticket.title || pt(t, 'row.untitled')}</span>
          </button>
        </div>
        <div className="sa-row-meta">{chips}</div>
      </div>
      <span className="sa-row-evidence">{evidence}</span>
      <div className="sa-row-actions" {...stopInner}>
        {publishUnavailableTip}
        {primaryButton}
        {compact || !items.length ? null : <Menu label={pt(t, 'menu.label')} items={items} align="end" />}
      </div>
    </div>
    <Modal open={Boolean(pending)} onClose={() => setPending(null)} title={pt(t, 'ticket.publish')}
      closeLabel={t('close')} description={pt(t, 'ticket.publishConfirm', { title: ticket.title ?? ticket.id })}
      footer={<>
        <Button variant="ghost" onClick={() => setPending(null)}>{t('cancel')}</Button>
        {/* Pending actions name the verb, never the generic 确认; the dialog closes only when the action succeeded. */}
        <Button variant="primary" disabled={publish.busy}
          onClick={() => { void publish.run().then(done => { if (done) setPending(null) }) }}>
          {pt(t, 'ticket.publish')}
        </Button>
      </>} />
    <Modal open={dismissOpen} onClose={() => setDismissOpen(false)} title={pt(t, 'detail.dismissTitle')}
      closeLabel={t('close')}
      description={pt(t, 'detail.dismissConfirm', { title: ticket.title ?? ticket.id,
        branch: ticket.links?.branch || '（无）', worktree: ticket.links?.worktree || '（无）' })}
      footer={<>
        <Button variant="ghost" onClick={() => setDismissOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={dismiss.busy}
          onClick={async () => { if (await dismiss.run()) setDismissOpen(false) }}>{pt(t, 'detail.dismiss')}</Button>
      </>} />
  </li>
}

/** Plain ticket list (no group headers). Empty lists render nothing: the page owns its empty state. */
function TicketList({ tickets, page = 'execution', actions, reload, now }) {
  const { t } = usePanel()
  const list = Array.isArray(tickets) ? tickets : []
  // The list polls every 30s: a status region announces only the count that changed, never the whole list. It stays
  // mounted when the list empties, so "0 tickets" is announced too instead of the region vanishing mid-announcement.
  const status = <span className="sa-sr-only" role="status" aria-live="polite">
    {pt(t, 'list.status', { count: list.length })}
  </span>
  if (!list.length) return status
  return <>
    {status}
    <ul className="sa-list">{list.map(ticket =>
      <TicketRow key={ticket.id} ticket={ticket} page={page} actions={actions} reload={reload} now={now} />)}</ul>
  </>
}

// Attention order (P0 §3.6.3): what waits for a person first, then what failed, then what moves, then the queue, then
// the settled history. The same order drives the execution stage filter (55-execution EXEC_STAGES).
const TICKET_GROUP_ORDER = ['waiting', 'failed', 'working', 'queued', 'done']

/** Execution tab: one Section per non-empty stage group, stage order fixed. `groupNotes` adds a one-line summary
    (e.g. the done group's accepted/dismissed/retried split) as the section badge; `className` wraps the groups so a
    page can switch the row layout without changing every TicketRow consumer. */
function TicketGroups({ tickets, page = 'execution', actions, reload, className, groupNotes, groupCounts, header }) {
  const { t } = usePanel()
  const list = Array.isArray(tickets) ? tickets : []
  if (!list.length) return null
  const grouped = new Map(TICKET_GROUP_ORDER.map(group => [group, []]))
  for (const ticket of list) {
    const group = ticketStatus(ticket).group
    if (!grouped.has(group)) grouped.set(group, [])
    grouped.get(group).push(ticket)
  }
  // One column header for the whole ledger, placed under the first group title: above every group it was a table
  // header that preceded the section it described, and repeating it for each stage turned a four-column list into
  // three little tables. The groups that follow share the same tracks.
  const rendered = TICKET_GROUP_ORDER.filter(group => grouped.get(group).length).map((group, index) =>
    <Section key={group} title={pt(t, `group.${group}`)}
      count={groupCounts?.[group] === false ? undefined : grouped.get(group).length}
      badge={groupNotes?.[group] ?? null}>
      {index === 0 ? header ?? null : null}
      <TicketList tickets={grouped.get(group)} page={page} actions={actions} reload={reload} />
    </Section>)
  return className ? <div className={className}>{rendered}</div> : <>{rendered}</>
}

/**
 * Manual Ticket form (test/backfill entry). Shared by Settings → Runtime and the Execution page's modal so the same
 * fields, repo picker and write semantics exist in both places; `onDone` lets a modal close itself after a success.
 */
const ROUTE_CAP_KEYS = { edit: 'st.routeCapEdit', exec: 'st.routeCapExec', web: 'st.routeCapWeb', report: 'st.routeCapReport' }

function ManualTicketForm({ onDone, onCancel, heading = true }) {
  const { t, notify } = usePanel()
  const model = usePanelData()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [repoId, setRepoId] = useState(undefined)
  const [deliverable, setDeliverable] = useState('')
  const [backend, setBackend] = useState('')
  const [preview, setPreview] = useState()
  const [previewError, setPreviewError] = useState()
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState()
  const [failure, setFailure] = useState()
  const data = model?.data
  const repos = panelRepos(data)
  const defaultRepo = panelDefaultRepo(data)
  const usableRepo = repos.some(repo => repo.id === repoId) ? repoId : defaultRepo
  const selection = { ...(backend ? { backend } : {}), ...(deliverable ? { deliverable } : {}) }
  const selectionKey = JSON.stringify(selection)
  // Draft preview: the operator sees the automatic judgement (deliverable / capabilities / backend) before creating,
  // and any manual choice is previewed through the same resolver the executor uses — so the preview cannot promise a
  // route the run then refuses.
  useEffect(() => {
    if (!`${title}${body}`.trim()) { setPreview(undefined); setPreviewError(undefined); return }
    let alive = true
    const timer = setTimeout(() => {
      const actions = model?.actions
      if (!actions?.previewRoute) return
      actions.previewRoute({ title: title.trim(), body: body.trim() || undefined, selection })
        .then(result => { if (alive) { setPreview(result); setPreviewError(undefined) } })
        .catch(error => { if (alive) { setPreview(undefined); setPreviewError(error) } })
    }, 250)
    return () => { alive = false; clearTimeout(timer) }
  }, [title, body, selectionKey])
  const route = preview?.route
  const capabilityText = (route?.capabilities ?? []).map(capability =>
    pt(t, ROUTE_CAP_KEYS[capability] ?? capability)).join(' · ') || '—'
  // Before the first preview arrives, offer the declared backends so the operator can pick one immediately; the
  // preview response then narrows the list to the enabled set.
  const enabledBackends = preview?.options?.backends
    ?? (typeof ROUTE_BACKENDS !== 'undefined' ? ROUTE_BACKENDS.map(backend => backend.value) : ['dsh', 'codex', 'claude'])
  const backendOptions = [{ value: '', label: pt(t, 'st.routeAuto') },
    ...enabledBackends.map(value => ({ value, label: value }))]
  const submit = async () => {
    if (busy || !title.trim()) return
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await model.actions.createTicket({ title: title.trim(), body: body.trim() || undefined,
        repoId: usableRepo || undefined, route: Object.keys(selection).length ? selection : undefined })
      // POST engine/ticket answers { ticket }; accept a bare ticket too so a future host shape change cannot hide the
      // created state (and onDone callers get the Ticket, not the envelope).
      const ticket = response?.ticket ?? response
      setCreated(ticket)
      setTitle('')
      setBody('')
      notify(pt(t, 'st.created'))
      onDone?.(ticket)
    } catch (error) {
      setFailure(error)
    } finally {
      setBusy(false)
    }
  }
  // A real form: Enter submits, every field carries a name, and title/body get a visible label (a placeholder is not one).
  return <form className="sa-field" onSubmit={event => { event.preventDefault(); void submit() }}>
    {heading ? <span className="sa-field-head">{pt(t, 'st.manualTitle')}</span> : null}
    {heading ? <Hint>{pt(t, 'st.manualHint')}</Hint> : null}
    {repos.length
      ? <>
        <span className="sa-field-head">{pt(t, 'repo.label')}</span>
        <Select label={pt(t, 'repo.label')} value={usableRepo ?? ''} disabled={busy}
          options={repos.map(repo => ({ value: repo.id, label: repo.name ?? repo.id }))}
          onChange={next => setRepoId(next)} />
        <Hint>{pt(t, 'st.manualRepoHint', { name: repos.find(repo => repo.id === defaultRepo)?.name ?? defaultRepo ?? '—' })}</Hint>
      </>
      : null}
    <label className="sa-field-head" htmlFor="sa-manual-title">{pt(t, 'st.titleLabel')}</label>
    <Input id="sa-manual-title" name="title" value={title} placeholder={pt(t, 'st.titlePh')} disabled={busy}
      onChange={event => setTitle(event.target.value)} />
    <label className="sa-field-head" htmlFor="sa-manual-body">{pt(t, 'st.bodyLabel')}</label>
    <textarea id="sa-manual-body" name="body" className="sa-textarea" rows={3} value={body}
      placeholder={pt(t, 'st.bodyPh')} disabled={busy} onChange={event => setBody(event.target.value)} />
    {/* Manual override is two independent choices, each defaulting to "let routing decide". They are saved on the
        Ticket by the host; an unsupported combination is warned about here and rejected by the executor. */}
    <div className="sa-route-controls">
      <Select label={pt(t, 'st.routeDeliverable')} value={deliverable} disabled={busy}
        options={[{ value: '', label: pt(t, 'st.routeAuto') },
          { value: 'change', label: pt(t, 'st.routeChange') },
          { value: 'report', label: pt(t, 'st.routeReport') }]}
        onChange={next => setDeliverable(next)} />
      <Select label={pt(t, 'st.routeBackend')} value={backend} disabled={busy} options={backendOptions}
        onChange={next => setBackend(next)} />
    </div>
    {route
      ? <div className="sa-route-preview">
        <span className="sa-field-head">{pt(t, 'st.routePreviewTitle')}</span>
        <p>
          {`${pt(t, `detail.workType.${route.workType}`)} · `}
          {`${pt(t, 'st.routeDeliverable')}: ${pt(t, route.deliverable === 'report' ? 'st.routeReport' : 'st.routeChange')} · `}
          {`${pt(t, 'st.routeCapabilities')}: ${capabilityText} · `}
          {`${pt(t, 'st.routeBackend')}: ${route.backend}`}
          {route.applied ? '' : ` · ${pt(t, 'detail.routeSuggested')}`}
        </p>
        {route.unsupported
          ? <p className="sa-error">{pt(t, 'st.routeUnsupported', { caps: route.unsupported })}</p>
          : null}
      </div>
      : null}
    {previewError ? <Hint tone="warning">{pt(t, 'st.routePreviewFailed')}</Hint> : null}
    {Object.keys(selection).length
      ? <Hint>{pt(t, 'st.routeManualHint')}</Hint>
      : null}
    {/* The dialog's only submit used to be a 28px button at the left edge of the body: make it the primary action and
        give a modal caller an explicit cancel next to it (critique 2026-11-11). */}
    <div className="sa-actions" style={{ justifyContent: 'flex-end' }}>
      {onCancel ? <Button variant="ghost" size="md" onClick={onCancel}>{t('cancel')}</Button> : null}
      <Button variant="primary" size="md" icon={<Icon name="plus" size={16} />} type="submit"
        disabled={busy || !title.trim()} aria-busy={busy ? 'true' : undefined}>{pt(t, 'st.create')}</Button>
    </div>
    {created?.id ? <div className="sa-actions" role="status" aria-live="polite">
      <StatusText state="done">{pt(t, 'st.created')}</StatusText>
      <code className="sa-mono">{shortId(created.id, 10)}</code>
    </div> : null}
    {failure ? <p className="sa-error" role="alert">{errorText(failure)}</p> : null}
  </form>
}
// ---- overview building blocks ---------------------------------------------------------------------------------

/** 24h flow: 到达 → 评估 → 接单. 过滤 is a branch of arrival (context-only messages), not a stage, and `dropped`
    counts outbound replies that failed to send — both are annotations, never a step that "loses" a number. */
function FunnelBar({ flow }) {
  const { t } = usePanel()
  if (!flow) return null
  const received = Number(flow.received ?? 0)
  const judged = Number(flow.judged ?? 0)
  const accepted = Number(flow.accepted ?? 0)
  const contextOnly = Number(flow.filtered ?? 0)
  const dropped = Number(flow.dropped ?? 0)
  const steps = [
    { key: 'received', labelKey: 'funnelReceived', value: received },
    { key: 'judged', labelKey: 'funnelJudged', value: judged },
    { key: 'accepted', labelKey: 'funnelAccepted', value: accepted },
  ]
  return <div className="sa-funnel">
    <div className="sa-funnel-steps">{steps.flatMap((step, index) => [
      index ? <span key={`arrow-${step.key}`} className="sa-funnel-arrow" aria-hidden="true">→</span> : null,
      <div key={step.key} className="sa-funnel-step">
        <span className="sa-funnel-value">{ovCount(step.value, t.lang)}</span>
        <span className="sa-funnel-label">{pt(t, step.labelKey)}</span>
      </div>,
    ])}
      {contextOnly > 0 ? <span className="sa-funnel-branch">{pt(t, 'funnelBranch', { count: contextOnly })}</span> : null}
    </div>
    {/* The three numbers are already on screen; only the outbound failure count is new information here. */}
    {dropped > 0 ? <p className="sa-funnel-summary">{pt(t, 'funnelDropped', { count: dropped })}</p> : null}
  </div>
}

/** Executor load: composition of running/queued/waiting/failed. No fake denominator without maxWorkers. */
function ExecutorLoad({ load, labels = true }) {
  const { t } = usePanel()
  if (!load) return null
  const counts = [
    { key: 'loadbarRunning', value: load.running ?? 0, tone: undefined },
    { key: 'loadbarQueued', value: load.queued ?? 0, tone: 'idle' },
    { key: 'loadbarWaiting', value: load.waiting ?? 0, tone: 'warning' },
    { key: 'loadbarFailed', value: load.failed ?? 0, tone: 'error' },
  ]
  const total = counts.reduce((sum, entry) => sum + entry.value, 0)
  // Zero is information: "working 0 · queued 0 · waiting 0 · failed 0" says the executor is calm without a sentence
  // that repeats the header. No track is drawn at zero — an empty 8px bar reads as a broken progress bar.
  // The bar is segmented, so it only means something with its legend: the same counts and words as the stage filter
  // sit under it, and the segment colours are read through those words rather than guessed.
  if (total === 0) return null
  return <div className="sa-executor-load">
    <div className="sa-loadbar">
      <div className="sa-loadbar-track" role="img" style={{ display: 'flex' }}
        aria-label={counts.map(entry => pt(t, entry.key, { count: entry.value })).join(' · ')}>
        {counts.filter(entry => entry.value > 0).map(entry =>
          <span key={entry.key} className="sa-loadbar-fill" data-tone={entry.tone}
            style={{ display: 'block', width: `${(entry.value / total) * 100}%` }} />)}
      </div>
      {labels ? <div className="sa-loadbar-meta">
        {counts.map(entry => <span key={entry.key}>{pt(t, entry.key, { count: entry.value })}</span>)}
        {load.paused ? <Tag key="paused" tone="warning">{pt(t, 'loadbarPaused')}</Tag> : null}
      </div> : null}
    </div>
  </div>
}

// ---- detail building blocks -----------------------------------------------------------------------------------

/** GitLab states → the same Chinese vocabulary as the rest of the panel; an unknown value is shown as-is. */
const MR_STATE_KEYS = { opened: 'ticket.mrOpened', merged: 'ticket.mrMerged', closed: 'ticket.mrClosed', locked: 'ticket.mrLocked' }
const PIPELINE_STATE_KEYS = { success: 'ticket.pipelineSuccess', failed: 'ticket.pipelineFailed', running: 'ticket.pipelineRunning',
  pending: 'ticket.pipelinePending', created: 'ticket.pipelineCreated', canceled: 'ticket.pipelineCanceled',
  skipped: 'ticket.pipelineSkipped', manual: 'ticket.pipelineManual' }
const AUTO_MERGE_KEYS = { merged: 'ticket.autoMerged', requested: 'ticket.autoRequested', failed: 'ticket.autoFailed' }
function providerStateText(t, map, value) {
  if (value === undefined || value === null || value === '') return ''
  const key = map[String(value)]
  return key ? pt(t, key) : String(value)
}

/** The latest run that carries gate results, plus the gates themselves. */
function latestGatesOf(ticket) {
  const runs = Array.isArray(ticket?.runs) ? ticket.runs : []
  const run = runs.find(entry => Array.isArray(entry.gates) && entry.gates.length) ?? runs[0]
  return { run, gates: Array.isArray(run?.gates) ? run.gates : [] }
}

/** Every gate this run recorded, as paired shape+text. Unknown names keep their configured name (a repository may
    configure its own gates), and a failed gate carries its exit code instead of a bare red mark. */
function GateSummary({ ticket }) {
  const { t } = usePanel()
  const { gates } = latestGatesOf(ticket)
  if (!gates.length) return <Hint>{pt(t, 'gate.none')}</Hint>
  return <div className="sa-gates">
    {gates.map((gate, index) => {
      const ok = gate.exitCode === 0 && !gate.timedOut
      return <span key={`${gate.name ?? 'gate'}-${index}`} className="sa-gate">
        <StatusText state={ok ? 'done' : 'error'}>{ticketGateLabel(t, gate.name)}</StatusText>
        {/* The passed/failed word is visible text, not an aria-label on a plain span (ignored by many screen readers). */}
        <span className="sa-hint">{pt(t, ok ? 'gate.passed' : 'gate.failed')}</span>
        {ok ? null : <span className="sa-hint">
          {gate.timedOut ? pt(t, 'gate.timedOut')
            : gate.exitCode !== undefined && gate.exitCode !== null ? pt(t, 'gate.exitCode', { code: gate.exitCode })
              : ''}
        </span>}
      </span>
    })}
  </div>
}

/** Seven stages of one ticket: 触发 → 评估 → 工单 → 执行 → 闸门 → MR → UAT. */
function StageRail({ ticket, detail = false }) {
  const { t } = usePanel()
  const origin = ticket.origin ?? {}
  const links = ticket.links ?? {}
  const { run, gates } = latestGatesOf(ticket)
  const mergeRequest = links.mergeRequest ?? {}
  const verification = links.verification ?? {}
  const deployment = links.deployment ?? {}
  const uatOk = Boolean(verification.uat?.ok || deployment.uat?.ok)
  const merged = Boolean(verification.merged) || mergeRequest.state === 'merged'
  const mrVisible = Boolean(mergeRequest.iid || mergeRequest.webUrl || merged)
  const gateFailed = gates.some(gate => gate.exitCode !== 0 || gate.timedOut)
  const gateDone = gates.length > 0 && !gateFailed
  const gatePassed = gates.filter(gate => gate.exitCode === 0 && !gate.timedOut).length
  const executed = Boolean(run || links.commit || links.branch)
  // A Ticket can fail a run and still land: the MR is merged, the UAT verified or a person accepted it. The rail must
  // not show a bare ✗ execution next to ✔ MR/✔ UAT — it says the failure was recovered by a retry.
  const runFailed = run?.status === 'failed' || (!run && ticket.status === 'failed')
  const recovered = runFailed && (merged || uatOk || links.acceptance?.ok === true
    || ['merged', 'deployed'].includes(ticket.status))
  const stages = [
    // The rail answers "where is it" in words; the ids behind the first two stages are one fold down in the
    // authorization block, not something to print under every step (T14).
    { key: 'trigger', state: origin.triggerId ? 'done' : 'idle', result: '' },
    { key: 'eval', state: origin.decisionId ? 'done' : 'idle', result: '' },
    { key: 'ticket', state: 'done', result: '' },
    { key: 'execution', state: ticket.status === 'working' ? 'ongoing' : runFailed ? (recovered ? 'warning' : 'error')
      : executed ? 'done' : 'idle',
      result: recovered ? pt(t, 'rail.retried') : run ? runView(t, run).label : '' },
    { key: 'gate', state: gateFailed ? 'error' : gateDone ? 'done' : ticket.status === 'working' ? 'ongoing' : 'idle',
      result: gates.length ? `${gatePassed}/${gates.length}` : '' },
    { key: 'mr', state: merged ? 'done' : mrVisible ? (ticket.status === 'closed' ? 'warning' : 'ongoing') : 'idle',
      result: mergeRequest.iid ? `#${mergeRequest.iid}${mergeRequest.state ? ` · ${providerStateText(t, MR_STATE_KEYS, mergeRequest.state)}` : ''}`
        : merged ? pt(t, 'ticket.mergedYes') : mrVisible ? pt(t, !mergeRequest.iid && (mergeRequest.pending === true || Boolean(mergeRequest.webUrl)) ? 'row.evidencePrWaiting' : 'row.evidencePr') : '' },
    { key: 'uat', state: uatOk ? 'done' : ticket.status === 'deploy-failed' ? 'error' : (ticket.status === 'deployed' || ticket.status === 'deploy-pending') ? 'ongoing' : 'idle',
      result: verification.uat ? (verification.uat.ok ? liveText('可访问', 'reachable') : liveText('不可访问', 'unreachable'))
        : deployment.uat ? (deployment.uat.ok ? liveText('部署可访问', 'deployed & reachable') : liveText('不可访问', 'unreachable')) : '' },
  ]
  return <ol className={detail ? 'sa-rail sa-rail-detail' : 'sa-rail'}>
    {/* The stage name carries no state: the state icon is aria-hidden and colour-coded, so each step also prints its
        state word (done/ongoing/warning/error/idle) in the result slot. Never colour-only (WIG 1.4.1). */}
    {stages.map(stage => {
      const Dot = detail ? 'span' : 'div'
      return <li key={stage.key} className="sa-rail-step" data-state={stage.state}>
        <Dot className="sa-rail-dot">
          <StatusIcon state={stage.state} size={14} />
          <span className="sa-rail-label">{pt(t, `rail.${stage.key}`)}</span>
          <span className="sa-rail-result">
            {[pt(t, `railState.${stage.state}`), detail ? stage.result : ''].filter(Boolean).join(' · ')}
          </span>
        </Dot>
      </li>
    })}
  </ol>
}

/** Merge request card: iid/link, state, pipeline, auto-merge and target branch, from what the ticket recorded. */
function MergeRequestCard({ ticket }) {
  const { t } = usePanel()
  const links = ticket?.links ?? {}
  const mr = links.mergeRequest ?? {}
  const verification = links.verification ?? {}
  const pipeline = links.pipeline ?? {}
  const autoMerge = links.autoMerge ?? {}
  // push mode records only the GitHub `/pull/new/` URL before any PR number exists; the URL alone is MR evidence.
  const hasMr = Boolean(mr.iid || mr.webUrl)
  const merged = mr.state === 'merged' || verification.merged === true
  const delivered = merged || ['merged', 'deployed'].includes(ticket?.status) || links.acceptance?.ok === true
  const rows = []
  const prWaiting = !delivered && !mr.iid && (mr.pending === true || Boolean(mr.webUrl))
  if (prWaiting) rows.push([pt(t, 'ticket.prState'), pt(t, 'ticket.prWaiting')])
  if (mr.iid) rows.push([pt(t, 'ticket.mrLink'), h(ExternalLink, { href: mr.webUrl }, `MR #${mr.iid}`)])
  else if (mr.webUrl) rows.push([pt(t, 'ticket.mrLink'), h(ExternalLink, { href: mr.webUrl }, pt(t, 'ticket.openPr'))])
  if (mr.state) rows.push([pt(t, 'ticket.mrState'), providerStateText(t, MR_STATE_KEYS, mr.state)])
  // push mode has no provider state; the verify step's ancestry result is what says the PR landed.
  if (!mr.state && verification.merged === true) rows.push([pt(t, 'ticket.mergeState'), pt(t, 'ticket.mergedYes')])
  if (pipeline.status) rows.push([pt(t, 'ticket.pipeline'), providerStateText(t, PIPELINE_STATE_KEYS, pipeline.status)])
  if (autoMerge.state) rows.push([pt(t, 'ticket.autoMerge'), providerStateText(t, AUTO_MERGE_KEYS, autoMerge.state)])
  // AC-05: acceptance is its own evidence even when the deliverable is a pushed branch.
  rows.push([pt(t, 'ticket.acceptState'), links.acceptance?.ok === true ? pt(t, 'ticket.acceptedYes') : pt(t, 'ticket.acceptedNo')])
  rows.push([pt(t, 'ticket.target'), ticket?.targetBranch ?? '—'])
  // P2-7: a draft MR and a CI result from another commit are both warnings the operator must see before trusting it.
  const draft = mr.draft === true || mr.workInProgress === true
  const stale = pipeline.stale && typeof pipeline.stale === 'object' ? pipeline.stale : undefined
  const badges = [
    draft ? <Tag key="draft" tone="warning">{pt(t, 'mr.draft')}</Tag> : null,
    stale ? <Tag key="stale" tone="warning">{pt(t, 'mr.stale')}</Tag> : null,
  ].filter(Boolean)
  return <div className="sa-card">
    <div className="sa-card-head"><span className="sa-card-title">{pt(t, 'ticket.mrCard')}</span></div>
    {badges.length ? <div className="sa-actions" style={{ marginBottom: 'var(--sa-sp-8)' }}>{badges}</div> : null}
    {draft ? <Folded summary={pt(t, 'mr.draft')}><p className="sa-hint">{pt(t, 'mr.draftHint')}</p></Folded> : null}
    {stale
      ? <Folded summary={pt(t, 'mr.stale')}><p className="sa-hint">
        {pt(t, 'mr.staleHint', { head: liveShortId(stale.headSha, 8) || '—', latest: liveShortId(stale.latestSha, 8) || '—' })}
      </p></Folded>
      : null}
    {hasMr || pipeline.status || autoMerge.state || merged
      ? <>
        <KeyValues rows={rows} />
        {mr.webUrl && !mr.iid
          ? <p className="sa-hint" style={{ marginTop: 'var(--sa-sp-8)' }}>{pt(t, 'mr.pushHint')}</p>
          : null}
      </>
      : <Hint>{liveText('还没有合并请求。', 'No merge request yet.')}</Hint>}
  </div>
}

/** UAT acceptance card: merge state, commit, reachability, build change and the deploy job. */
function UatCard({ ticket }) {
  const { t } = usePanel()
  const links = ticket?.links ?? {}
  const verification = links.verification ?? {}
  const deployment = links.deployment ?? {}
  const rows = []
  if (verification.sha) rows.push([pt(t, 'ticket.commit'), h('span', { className: 'sa-mono' }, liveShortId(verification.sha, 8))])
  if (verification.merged !== undefined) rows.push([pt(t, 'ticket.mergeState'),
    pt(t, verification.merged ? 'ticket.mergedYes' : 'ticket.mergedNo')])
  if (verification.uat) {
    // A mark alone reads as a bare "✓" when the provider sent no status: the reachability word is always visible.
    const uatState = pt(t, verification.uat.ok ? 'ticket.uatReachable' : 'ticket.uatUnreachable')
    const uatDetail = verification.uat.ok ? verification.uat.status : verification.uat.error
    const uatMark = verification.uat.ok ? '✓ ' : '✗ '
    rows.push([pt(t, 'ticket.uatReachable'), `${uatMark}${uatState}${uatDetail ? ` · ${uatDetail}` : ''}`])
  }
  if (verification.changed !== undefined) rows.push([pt(t, 'ticket.uatChange'),
    verification.changed ? pt(t, 'ticket.uatChanged') : pt(t, 'ticket.uatSame')])
  // History uses the one absolute stamp the rest of the detail page uses (T7); relative time is only for
  // "updated at" and scheduling.
  if (verification.at) rows.push([pt(t, 'ticket.checkedAt'), h(TicketStamp, { at: verification.at })])
  // Deploy evidence is one fact, not two rows: the job name + one shape mark + the state. The pipeline state is
  // already on the MR card, so repeating it here would show the same answer twice (critique #6).
  const deployStatusRaw = deployment.deployJob?.status ?? deployment.status
  if (deployStatusRaw) {
    const deployMark = deployStatusRaw === 'success' ? '✓ ' : deployStatusRaw === 'failed' ? '✗ ' : ''
    const deployName = deployment.deployJob?.name
    rows.push([pt(t, 'ticket.deployJob'),
      `${deployName ? `${deployName} · ` : ''}${deployMark}${providerStateText(t, PIPELINE_STATE_KEYS, deployStatusRaw)}`])
  }
  return <div className="sa-card">
    <div className="sa-card-head"><span className="sa-card-title">{pt(t, 'ticket.uatCard')}</span></div>
    {rows.length ? <KeyValues rows={rows} /> : <Hint>{liveText('还没有 UAT 验收记录。', 'No UAT acceptance yet.')}</Hint>}
  </div>
}

// ---- transitional shims ---------------------------------------------------------------------------------------
// The six page fragments are being rewritten against the new components above; until every page lands, keep the
// old composition seams alive so an intermediate build cannot blank a page with a ReferenceError.
function LiveFrame({ children }) { return <>{children}</> }
function LiveTicketList({ tickets, page = 'overview', actions, reload, now }) {
  return <TicketList tickets={tickets} page={page} actions={actions} reload={reload} now={now} />
}
function LiveRunRows({ runs, limit = Infinity }) {
  const { t } = usePanel()
  const list = Array.isArray(runs) ? runs.slice(0, limit) : []
  if (!list.length) return <Hint>{t('empty')}</Hint>
  return <ul className="sa-list">{list.map(run => {
    const view = runView(t, run)
    const cause = run.error ? failureLabel(t, run.error) : ''
    const raw = run.error ? String(run.error) : ''
    return <li key={run.id} className="sa-row">
      <div className="sa-row-main">
        <div className="sa-row-title">
          <StatusIcon state={view.state} size={14} />
          <span>{view.label}</span>
          <span className="sa-mono sa-hint">{liveShortId(run.id)}</span>
        </div>
        {/* A raw worker error can be a whole stack: the short cause stays inline and the untruncated text folds. */}
        {run.error ? <p className="sa-error">{cause}</p> : null}
        {run.error && raw.trim() !== cause
          ? <Folded summary={pt(t, 'run.rawError')}><ClampText text={raw} /></Folded>
          : null}
      </div>
    </li>
  })}</ul>
}
function LiveStatusTags({ engine, config }) {
  const { t } = usePanel()
  return <div className="sa-actions">
    <StatusText state={globalHealth({ engine, config }).state}>{pt(t, globalHealth({ engine, config }).labelKey)}</StatusText>
  </div>
}
