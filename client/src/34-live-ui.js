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
    accepted: ['已验收', 'Accepted'],
  },
  group: { queued: ['待排', 'Queued'], working: ['执行中', 'Working'], waiting: ['等待人', 'Waiting for you'],
    failed: ['失败', 'Failed'], done: ['已结束', 'Ended'] },
  primary: { accept: ['去验收', 'Review UAT'], merge: ['去合并 MR', 'Merge MR'], deploy: ['刷新部署', 'Refresh deploy'],
    diagnose: ['查看原因', 'See what failed'], progress: ['干跑执行', 'Dry run'], openMr: ['打开 MR', 'Open MR'] },
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
    active: ['执行中 {count}', '{count} running'] },
  menu: { label: ['工单动作', 'Ticket actions'], dryRun: ['干跑执行', 'Dry run'], publish: ['发布 MR', 'Publish MR'],
    refreshCi: ['刷新 CI', 'Refresh CI'], verify: ['核对合并/UAT', 'Verify merge/UAT'], stop: ['停止工单', 'Stop ticket'] },
  row: { untitled: ['（未命名工单）', '(Untitled Ticket)'], openDetail: ['打开工单详情', 'Open Ticket details'],
    evidenceMr: ['MR #{iid}', 'MR #{iid}'], evidenceCause: ['原因：{cause}', 'Cause: {cause}'],
    evidenceReview: ['待你验收', 'Review UAT'], evidenceMerge: ['待你合并', 'Merge MR'],
    evidenceRunning: ['本轮 {minutes} 分', '{minutes} min'] },
  problem: { engineError: ['引擎报告异常', 'The engine reported an error'], paused: ['处理已暂停', 'Processing is paused'],
    engineOff: ['自动触发未开启', 'Automatic intake is off'], sourceError: ['{name} 异常', '{name} is failing'],
    octoToken: ['Octo token 未配置', 'Octo token is missing'], gitlabToken: ['GitLab token 未配置', 'GitLab token is missing'],
    pausedDetail: ['恢复前不会开始新的评估、派工或回复。', 'No new Eval, dispatch or reply runs until you resume.'],
    engineOffDetail: ['改 ~/.dsh/superagent/live.json 并重载配置后，引擎才会自动轮询群消息。',
      'Set enabled in ~/.dsh/superagent/live.json and reload the config to poll the group automatically.'],
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
    rulesHit: ['{hit} 命中 / {miss} 未命中', '{hit} matched / {miss} unmatched'],
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
    mrLink: ['MR 链接', 'MR link'], mergedYes: ['已合入目标分支', 'Merged into the target branch'],
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
    stopUnavailable: ['当前引擎还没有停止接口。', 'The engine has no stop endpoint yet.'],
    publishUnavailable: ['缺少推送权限、执行器未启用或没有 GitLab token。', 'Push is not allowed, the executor is off, or the GitLab token is missing.'],
    dryTag: ['干跑', 'Dry run'], publishTitle: ['发布这个工单的 MR？', "Publish this Ticket's MR?"],
    publishConfirm: ['会在现有工作区重跑闸门，然后推送分支并创建/刷新 MR：{title}',
      'Re-runs the gates in the existing worktree, then pushes the branch and creates/refreshes the MR: {title}'],
    step: { prepareWorktree: ['准备工作区', 'Prepare worktree'], prepareRepo: ['准备仓库', 'Prepare repository'],
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
  // 24h funnel: 过滤 is a branch of 到达, and `dropped` means outbound replies that failed to send — neither is a stage.
  funnelBranch: ['其中 {count} 条仅作上下文', '{count} context-only'],
  funnelSummary2: ['{received} 到达 · {judged} 评估 · {accepted} 接单 · {dropped} 出站失败',
    '{received} arrived · {judged} evaluated · {accepted} accepted · {dropped} not sent'],
  toast: {
    verifyOk: ['核对完成：UAT 可访问，构建已更新。', 'Checked: UAT reachable, new build detected.'],
    verifyDown: ['核对完成：UAT 当前不可访问，详见工单详情。', 'Checked: UAT is not reachable right now; see the Ticket detail.'],
    ciDone: ['CI 已刷新：{status}', 'CI refreshed: {status}'],
    ciNoToken: ['没有 GitLab token，无法观测 CI。', 'No GitLab token, CI cannot be observed.'],
    dryDone: ['干跑完成。', 'Dry run finished.'],
    publishDone: ['已发布 MR !{iid}', 'Published MR !{iid}'],
    publishPushed: ['已推送分支。', 'Branch pushed.'],
    pollDone: ['检查完成：可接单 {accepted} · 忽略 {ignored}（干跑，未写入）', 'Check finished: {accepted} acceptable · {ignored} ignored (dry run, nothing written)'],
    pauseDone: ['已暂停处理。', 'Processing paused.'],
    resumeDone: ['已恢复处理。', 'Processing resumed.'],
    configReloaded: ['配置已重载。', 'Configuration reloaded.'],
  },
})

const TEXT_GROUPS = ['pilotPhase', 'pilotRunStatus', 'pilotTicketStatus', 'pilotGate',
  'ticketState', 'group', 'primary', 'disposition', 'rail', 'gate', 'result', 'shell', 'menu', 'row', 'flow', 'load',
  'problem', 'problemAction', 'repo', 'thread', 'ticket', 'ticket.event', 'ticket.step', 'actions', 'toast']
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
  failed: { state: 'error', tone: 'danger', group: 'failed', needsHuman: true, primary: 'diagnose' },
  'ci-failed': { state: 'error', tone: 'danger', group: 'failed', needsHuman: true, primary: 'diagnose' },
  'deploy-failed': { state: 'error', tone: 'danger', group: 'failed', needsHuman: true, primary: 'diagnose' },
}

/**
 * One Ticket status → the view every page renders.
 * → { key, state, tone, group, needsHuman, primary, labelKey } (label key is read through `pt`).
 */
function ticketStatus(ticket) {
  const key = ticket?.status ?? ticket?.stage
  // A person's UAT sign-off is a property of the ticket, not of the engine status: the deployment record stays
  // `deployed`, but the Ticket is done waiting for a human.
  if (ticket?.links?.acceptance?.ok === true) {
    return { key: 'accepted', state: 'done', tone: 'success', group: 'done', needsHuman: false, primary: 'none', labelKey: 'ticketState.accepted' }
  }
  // Repositories that are accepted after the merge (no CI/UAT, contract §12): a merged Ticket still waits for a
  // person, so it groups under "needs you" with acceptance as its one action.
  if (ticket?.repoAcceptance === 'merged' && ticket?.status === 'merged') {
    return { key: 'merged', state: 'idle', tone: 'success', group: 'waiting', needsHuman: true, primary: 'accept', labelKey: 'ticketState.merged' }
  }
  const view = TICKET_VIEW[key] ? { key, ...TICKET_VIEW[key] } : { key: 'unknown', ...TICKET_VIEW.queued, state: 'idle', group: 'queued', primary: 'none' }
  view.labelKey = `ticketState.${view.key}`
  return view
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
  return h(Tag, { tone: pilotTone(status) }, label === key ? status : label)
}

/** Status tag for a raw ticket; the Chinese label always comes from `ticketStatus`. */
function TicketStatusTag({ ticket }) {
  const { t } = usePanel()
  const view = ticketStatus(ticket)
  const unknown = view.key === 'unknown' && ticket?.status ? `（${ticket.status}）` : ''
  return h(Tag, { tone: view.tone }, pt(t, view.labelKey) + unknown)
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
      detail: liveText('改 ~/.dsh/superagent/live.json 并重载配置后，引擎才会自动轮询群消息。',
        'Enable it in ~/.dsh/superagent/live.json and reload the config to poll the group automatically.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings' } } })
  }
  if (config.octo && config.octo.tokenConfigured === false) {
    out.push({ key: 'octo-token', severity: 'warning', title: liveText('Octo token 未配置', 'Octo token is missing'),
      detail: liveText('没有 Octo token，引擎读不到群消息。', 'Without an Octo token the engine cannot read the group.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings' } } })
  }
  if (config.gitlab && config.gitlab.tokenConfigured === false) {
    out.push({ key: 'gitlab-token', severity: 'warning', title: liveText('GitLab token 未配置', 'GitLab token is missing'),
      detail: liveText('没有 GitLab token 时无法观测 CI 与部署，只能做无 token 的核对。',
        'Without a GitLab token CI and deploy results cannot be observed; only token-free verification runs.'),
      action: { labelKey: 'problemAction.settings', kind: 'navigate', payload: { page: 'settings' } } })
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
 * The one piece of physical evidence the execution ledger shows on the right: the MR that shipped it, the Chinese
 * cause of a failed run, the wait a person owns, or the current run's age. Deliberately never repeats a status that a
 * Tag already states (state/result stay in the meta line), and it stays empty for Tickets that have no evidence yet.
 */
function ticketEvidence(t, ticket, view) {
  const links = ticket.links ?? {}
  const assignments = Array.isArray(ticket.assignments) ? ticket.assignments : []
  const failed = [...assignments].reverse().find(assignment => assignment?.report?.state === 'failed')
  const mr = links.mergeRequest ?? {}
  const delivered = ['merged', 'deployed'].includes(ticket.status) || links.acceptance?.ok === true
  if (mr.iid && (!failed || delivered)) {
    const label = pt(t, 'row.evidenceMr', { iid: mr.iid })
    return mr.webUrl
      ? h('a', { className: 'sa-inline-link sa-mono', href: mr.webUrl, target: '_blank', rel: 'noopener noreferrer',
        title: mr.webUrl, onClick: event => event.stopPropagation() }, label)
      : h('span', { className: 'sa-mono' }, label)
  }
  if (failed) {
    const raw = String(failed.report?.text ?? '')
    return h('span', { title: raw || undefined }, pt(t, 'row.evidenceCause', { cause: failureLabel(t, raw) }))
  }
  if (view?.group === 'waiting') return pt(t, ticket.status === 'deployed' ? 'row.evidenceReview' : 'row.evidenceMerge')
  const running = assignments.at(-1)
  if (view?.group === 'working' && running?.startedAt) {
    const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(running.startedAt)) / 60_000))
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
function TicketRow({ ticket, page = 'execution', actions, reload, compact = false, extra }) {
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
    const result = await act.publishTicket(ticket.id)
    notify(result?.mergeRequest?.iid ? pt(t, 'toast.publishDone', { iid: result.mergeRequest.iid }) : pt(t, 'toast.publishPushed'))
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
  const hasMr = Boolean(ticket.links?.mergeRequest?.iid)
  const primary = primaryActionOf(ticket, view)

  const busyOf = { verify: verify.busy, refreshCi: refreshCi.busy, dryRun: dryRun.busy, publish: publish.busy, dismiss: dismiss.busy }
  const branches = {
    verify: () => { void verify.run() },
    refreshCi: () => { void refreshCi.run() },
    dryRun: () => { void dryRun.run() },
    publish: () => setPending({ kind: 'publish' }),
    external: () => window.open(primary.href, '_blank', 'noopener'),
    detail: open,
  }
  const primaryButton = primary ? h(Button, { variant: 'primary', size: 'sm', disabled: Boolean(busyOf[primary.kind]),
    title: primary.kind === 'publish' && !canPublish ? pt(t, 'ticket.publishUnavailable') : undefined,
    onClick: event => { event.stopPropagation(); branches[primary.kind]() } }, pt(t, primary.labelKey)) : null
  const allItems = [
    { key: 'dryRun', label: pt(t, 'menu.dryRun'), onSelect: () => { void dryRun.run() }, disabled: dryRun.busy },
    { key: 'publish', label: pt(t, 'menu.publish'), onSelect: () => setPending({ kind: 'publish' }),
      disabled: publish.busy || !canPublish, title: canPublish ? undefined : pt(t, 'ticket.publishUnavailable') },
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
  // Multi-repository panels say which repository a Ticket belongs to; a plain text span, not a Tag, so the three-tag
  // budget of the row stays for state and result.
  const repoList = panelRepos(data)
  const repoName = ticket.repoName ?? panelRepoOf(data, ticket.repoId)?.name ?? ticket.repoId
  const showRepo = repoList.length > 1 && Boolean(repoName)
  const chips = [
    h(Tag, { key: 'state', tone: view.tone }, pt(t, view.labelKey)),
  ]
  // A dismissed Ticket is only neutral if it never failed; one dismissed right after a failed run says so.
  const failedBeforeDismiss = view.key === 'dismissed'
    && (Array.isArray(ticket.assignments) ? ticket.assignments : []).some(assignment => assignment?.report?.state === 'failed')
  if (failedBeforeDismiss) chips.push(h(Tag, { key: 'dismissed-after-failure', tone: 'warning' }, pt(t, 'dismissedAfterFailure')))
  if (showRepo) chips.push(h('span', { key: 'repo', className: 'sa-hint' }, String(repoName)))
  chips.push(h(When, { key: 'at', at: ticket.updatedAt ?? ticket.createdAt }))
  if (result && !compact) chips.push(h(Tag, { key: 'result', tone: result.tone }, pt(t, result.labelKey)))
  if (extra) chips.push(h('span', { key: 'extra', className: 'sa-hint' }, extra))

  // The row itself is a plain div (mouse convenience); the title is a real <button> so keyboard users get one focus
  // stop, and the primary/⋯ controls are siblings of it — never buttons nested inside a role=button row (G6). The
  // evidence rail is the third track of the execution ledger; other pages hide it via CSS and keep the flex row.
  const evidence = ticketEvidence(t, ticket, view)
  return h('li', null,
    h('div', { className: 'sa-row sa-row-openable', onClick: open },
      h(StatusIcon, { state: view.state, size: 16 }),
      h('div', { className: 'sa-row-main' },
        h('div', { className: 'sa-row-title' },
          h('button', { type: 'button', className: 'sa-row-open',
            'aria-label': `${ticket.title ?? pt(t, 'row.untitled')} — ${pt(t, view.labelKey)}`,
            onClick: event => { event.stopPropagation(); open() } },
          h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
            ticket.title || pt(t, 'row.untitled')))),
        h('div', { className: 'sa-row-meta' }, chips)),
      h('span', { className: 'sa-row-evidence' }, evidence),
      h('div', { className: 'sa-row-actions', ...stopInner },
        primaryButton,
        compact || !items.length ? null : h(Menu, { label: pt(t, 'menu.label'), items, align: 'end' }))),
    h(Modal, { open: Boolean(pending), onClose: () => setPending(null), title: pt(t, 'ticket.publish'),
      closeLabel: t('close'), description: pt(t, 'ticket.publishConfirm', { title: ticket.title ?? ticket.id }),
      footer: h(Fragment, null,
        h(Button, { variant: 'ghost', onClick: () => setPending(null) }, t('cancel')),
        h(Button, { variant: 'primary', disabled: publish.busy, onClick: () => { void publish.run() } }, t('confirm'))) }),
    h(Modal, { open: dismissOpen, onClose: () => setDismissOpen(false), title: pt(t, 'detail.dismissTitle'),
      closeLabel: t('close'),
      description: pt(t, 'detail.dismissConfirm', { title: ticket.title ?? ticket.id,
        branch: ticket.links?.branch || '（无）', worktree: ticket.links?.worktree || '（无）' }),
      footer: h(Fragment, null,
        h(Button, { variant: 'ghost', onClick: () => setDismissOpen(false) }, t('cancel')),
        h(Button, { variant: 'primary', disabled: dismiss.busy,
          onClick: async () => { await dismiss.run(); setDismissOpen(false) } }, t('confirm'))) }))
}

/** Plain ticket list (no group headers). Empty lists render nothing: the page owns its empty state. */
function TicketList({ tickets, page = 'execution', actions, reload }) {
  const list = Array.isArray(tickets) ? tickets : []
  if (!list.length) return null
  return h('ul', { className: 'sa-list' }, list.map(ticket =>
    h(TicketRow, { key: ticket.id, ticket, page, actions, reload })))
}

const TICKET_GROUP_ORDER = ['queued', 'working', 'waiting', 'failed', 'done']

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
  const rendered = TICKET_GROUP_ORDER.filter(group => grouped.get(group).length).map(group =>
    h(Section, { key: group, title: pt(t, `group.${group}`),
      count: groupCounts?.[group] === false ? undefined : grouped.get(group).length,
      badge: groupNotes?.[group] ?? null },
      h(TicketList, { tickets: grouped.get(group), page, actions, reload })))
  return className ? h('div', { className }, header, rendered) : h(Fragment, null, header, rendered)
}

/**
 * Manual Ticket form (test/backfill entry). Shared by Settings → Runtime and the Execution page's modal so the same
 * fields, repo picker and write semantics exist in both places; `onDone` lets a modal close itself after a success.
 */
function ManualTicketForm({ onDone, heading = true }) {
  const { t, notify } = usePanel()
  const model = usePanelData()
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [repoId, setRepoId] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const [created, setCreated] = useState()
  const [failure, setFailure] = useState()
  const data = model?.data
  const repos = panelRepos(data)
  const defaultRepo = panelDefaultRepo(data)
  const usableRepo = repos.some(repo => repo.id === repoId) ? repoId : defaultRepo
  const submit = async () => {
    if (busy || !title.trim()) return
    setBusy(true)
    setFailure(undefined)
    try {
      const response = await model.actions.createTicket({ title: title.trim(), body: body.trim() || undefined,
        repoId: usableRepo || undefined })
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
  return h('div', { className: 'sa-field' },
    heading ? h('span', { className: 'sa-field-head' }, pt(t, 'st.manualTitle')) : null,
    heading ? h(Hint, null, pt(t, 'st.manualHint')) : null,
    repos.length
      ? h(Fragment, null,
        h('span', { className: 'sa-field-head' }, pt(t, 'repo.label')),
        h(Select, { label: pt(t, 'repo.label'), value: usableRepo ?? '', disabled: busy,
          options: repos.map(repo => ({ value: repo.id, label: repo.name ?? repo.id })),
          onChange: next => setRepoId(next) }),
        h(Hint, null, pt(t, 'st.manualRepoHint', { name: repos.find(repo => repo.id === defaultRepo)?.name ?? defaultRepo ?? '—' })))
      : null,
    h(Input, { value: title, placeholder: pt(t, 'st.titlePh'), 'aria-label': pt(t, 'st.titlePh'), disabled: busy,
      onChange: event => setTitle(event.target.value) }),
    h('textarea', { className: 'sa-textarea', rows: 3, value: body, placeholder: pt(t, 'st.bodyPh'),
      'aria-label': pt(t, 'st.bodyPh'), disabled: busy, onChange: event => setBody(event.target.value) }),
    h('div', { className: 'sa-actions' },
      h(Button, { variant: 'primary', size: 'sm', icon: h(Icon, { name: 'plus', size: 14 }),
        disabled: busy || !title.trim(), onClick: () => { void submit() } }, pt(t, 'st.create'))),
    created?.id ? h('div', { className: 'sa-actions' },
      h(StatusText, { state: 'done' }, pt(t, 'st.created')),
      h('code', { className: 'sa-mono' }, shortId(created.id, 10))) : null,
    failure ? h('p', { className: 'sa-error', role: 'alert' }, errorText(failure)) : null)
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
  return h('div', { className: 'sa-funnel' },
    h('div', { className: 'sa-funnel-steps' }, steps.flatMap((step, index) => [
      index ? h('span', { key: `arrow-${step.key}`, className: 'sa-funnel-arrow', 'aria-hidden': 'true' }, '→') : null,
      h('div', { key: step.key, className: 'sa-funnel-step' },
        h('span', { className: 'sa-funnel-value' }, String(step.value)),
        h('span', { className: 'sa-funnel-label' }, pt(t, step.labelKey))),
    ]),
      contextOnly > 0 ? h('span', { className: 'sa-funnel-branch' }, pt(t, 'funnelBranch', { count: contextOnly })) : null),
    // The conclusion the three numbers cannot state by themselves (critique #13/#O2).
    h('p', { className: 'sa-funnel-summary' },
      pt(t, 'funnelSummary2', { received, judged, accepted, dropped })))
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
  // Zero is information: "running 0 · queued 0 · waiting 0 · failed 0" says the executor is calm without a sentence
  // that repeats the header. No track is drawn at zero — an empty 8px bar reads as a broken progress bar.
  // The four counts belong to the interactive stage filter (one place, one unit). The band keeps the composition bar
  // only while work is moving, so the same numbers are never printed twice on one screen.
  if (total === 0) return null
  return h('div', { className: 'sa-executor-load' },
    h('div', { className: 'sa-loadbar' },
      h('div', { className: 'sa-loadbar-track', role: 'img', style: { display: 'flex' },
        'aria-label': counts.map(entry => pt(t, entry.key, { count: entry.value })).join(' · ') },
        counts.filter(entry => entry.value > 0).map(entry =>
          h('span', { key: entry.key, className: 'sa-loadbar-fill', 'data-tone': entry.tone,
            style: { display: 'block', width: `${(entry.value / total) * 100}%` } }))),
      labels ? h('div', { className: 'sa-loadbar-meta' },
        counts.map(entry => h('span', { key: entry.key }, pt(t, entry.key, { count: entry.value }))),
        load.paused ? h(Tag, { key: 'paused', tone: 'warning' }, pt(t, 'loadbarPaused')) : null) : null))
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

/** Three gates as paired shape+text (`standards ✓ / backend ✓ / frontend ✗`), from runs[].gates. */
function GateSummary({ ticket }) {
  const { t } = usePanel()
  const { gates } = latestGatesOf(ticket)
  if (!gates.length) return h(Hint, null, pt(t, 'gate.none'))
  return h('div', { className: 'sa-gates' },
    ['standards', 'backend', 'frontend'].map(name => {
      const gate = gates.find(entry => entry.name === name)
      if (!gate) return h('span', { key: name, className: 'sa-gate sa-hint' }, `${pt(t, `gate.${name}`)} —`)
      const ok = gate.exitCode === 0 && !gate.timedOut
      return h('span', { key: name, className: 'sa-gate' }, h(StatusText, { state: ok ? 'done' : 'error' }, pt(t, `gate.${name}`)))
    }))
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
    { key: 'trigger', state: origin.triggerId ? 'done' : 'idle', result: origin.triggerId ? liveShortId(origin.triggerId) : '' },
    { key: 'eval', state: origin.decisionId ? 'done' : 'idle', result: origin.decisionId ? liveShortId(origin.decisionId) : '' },
    { key: 'ticket', state: 'done', result: liveShortId(ticket.id) },
    { key: 'execution', state: ticket.status === 'working' ? 'ongoing' : runFailed ? (recovered ? 'warning' : 'error')
      : executed ? 'done' : 'idle',
      result: recovered ? pt(t, 'rail.retried') : run ? pt(t, ticketStatus({ status: run.status }).labelKey)
        : executed ? liveShortId(links.commit) : '' },
    { key: 'gate', state: gateFailed ? 'error' : gateDone ? 'done' : ticket.status === 'working' ? 'ongoing' : 'idle',
      result: gates.length ? `${gatePassed}/${gates.length}` : '' },
    { key: 'mr', state: merged ? 'done' : mrVisible ? (ticket.status === 'closed' ? 'warning' : 'ongoing') : 'idle',
      result: mergeRequest.iid ? `MR #${mergeRequest.iid}${mergeRequest.state ? ` · ${providerStateText(t, MR_STATE_KEYS, mergeRequest.state)}` : ''}` : merged ? liveShortId(verification.sha) : '' },
    { key: 'uat', state: uatOk ? 'done' : ticket.status === 'deploy-failed' ? 'error' : (ticket.status === 'deployed' || ticket.status === 'deploy-pending') ? 'ongoing' : 'idle',
      result: verification.uat ? (verification.uat.ok ? liveText('可访问', 'reachable') : liveText('不可访问', 'unreachable'))
        : deployment.uat ? (deployment.uat.ok ? liveText('部署可访问', 'deployed & reachable') : liveText('不可访问', 'unreachable')) : '' },
  ]
  return h('ol', { className: 'sa-rail' }, stages.map(stage => h('li', { key: stage.key, className: 'sa-rail-step', 'data-state': stage.state },
    h('div', { className: 'sa-rail-dot' }, h(StatusIcon, { state: stage.state, size: 14 }), h('span', { className: 'sa-rail-label' }, pt(t, `rail.${stage.key}`))),
    detail && stage.result ? h('span', { className: 'sa-rail-result' }, stage.result) : null)))
}

/** Merge request card: iid/link, state, pipeline, auto-merge and target branch, from what the ticket recorded. */
function MergeRequestCard({ ticket }) {
  const { t } = usePanel()
  const links = ticket?.links ?? {}
  const mr = links.mergeRequest ?? {}
  const pipeline = links.pipeline ?? {}
  const autoMerge = links.autoMerge ?? {}
  const rows = []
  if (mr.iid) rows.push([pt(t, 'ticket.mrLink'), h(ExternalLink, { href: mr.webUrl }, `MR #${mr.iid}`)])
  if (mr.state) rows.push([pt(t, 'ticket.mrState'), providerStateText(t, MR_STATE_KEYS, mr.state)])
  if (pipeline.status) rows.push([pt(t, 'ticket.pipeline'), providerStateText(t, PIPELINE_STATE_KEYS, pipeline.status)])
  if (autoMerge.state) rows.push([pt(t, 'ticket.autoMerge'), providerStateText(t, AUTO_MERGE_KEYS, autoMerge.state)])
  rows.push([pt(t, 'ticket.target'), ticket?.targetBranch ?? '—'])
  return h('div', { className: 'sa-card' },
    h('div', { className: 'sa-card-head' }, h('span', { className: 'sa-card-title' }, pt(t, 'ticket.mrCard'))),
    mr.iid || pipeline.status || autoMerge.state
      ? h(KeyValues, { rows })
      : h(Hint, null, liveText('还没有合并请求。', 'No merge request yet.')))
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
  if (verification.uat) rows.push([pt(t, 'ticket.uatReachable'),
    verification.uat.ok ? `✓ ${verification.uat.status ?? ''}`.trim() : `✗ ${verification.uat.error ?? ''}`.trim()])
  if (verification.changed !== undefined) rows.push([pt(t, 'ticket.uatChange'),
    verification.changed ? pt(t, 'ticket.uatChanged') : pt(t, 'ticket.uatSame')])
  if (verification.at) rows.push([pt(t, 'ticket.checkedAt'), h(When, { at: verification.at })])
  // Deploy evidence is one fact, not two rows: the job name + one shape mark + the state. The pipeline state is
  // already on the MR card, so repeating it here would show the same answer twice (critique #6).
  const deployStatusRaw = deployment.deployJob?.status ?? deployment.status
  if (deployStatusRaw) {
    const deployMark = deployStatusRaw === 'success' ? '✓ ' : deployStatusRaw === 'failed' ? '✗ ' : ''
    const deployName = deployment.deployJob?.name
    rows.push([pt(t, 'ticket.deployJob'),
      `${deployName ? `${deployName} · ` : ''}${deployMark}${providerStateText(t, PIPELINE_STATE_KEYS, deployStatusRaw)}`])
  }
  return h('div', { className: 'sa-card' },
    h('div', { className: 'sa-card-head' }, h('span', { className: 'sa-card-title' }, pt(t, 'ticket.uatCard'))),
    rows.length ? h(KeyValues, { rows }) : h(Hint, null, liveText('还没有 UAT 验收记录。', 'No UAT acceptance yet.')))
}

// ---- transitional shims ---------------------------------------------------------------------------------------
// The six page fragments are being rewritten against the new components above; until every page lands, keep the
// old composition seams alive so an intermediate build cannot blank a page with a ReferenceError.
function LiveFrame({ children }) { return h(Fragment, null, children) }
function LiveTicketList({ tickets, page = 'overview', actions, reload }) {
  return h(TicketList, { tickets, page, actions, reload })
}
function LiveRunRows({ runs, limit = Infinity }) {
  const { t } = usePanel()
  const list = Array.isArray(runs) ? runs.slice(0, limit) : []
  if (!list.length) return h(Hint, null, t('empty'))
  return h('ul', { className: 'sa-list' }, list.map(run => h('li', { key: run.id, className: 'sa-row' },
    h('div', { className: 'sa-row-main' },
      h('div', { className: 'sa-row-title' },
        h(StatusIcon, { state: ticketStatus({ status: run.status }).state, size: 14 }),
        h('span', null, pt(t, ticketStatus({ status: run.status }).labelKey)),
        h('span', { className: 'sa-mono sa-hint' }, liveShortId(run.id))),
      run.error ? h('p', { className: 'sa-error' }, String(run.error)) : null))))
}
function LiveStatusTags({ engine, config }) {
  const { t } = usePanel()
  return h('div', { className: 'sa-actions' },
    h(StatusText, { state: globalHealth({ engine, config }).state }, pt(t, globalHealth({ engine, config }).labelKey)))
}
