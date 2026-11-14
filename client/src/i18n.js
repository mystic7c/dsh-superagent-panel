/* Bilingual dictionary and translator. Keys are flat and dotted; `{name}` placeholders are filled from the values
   object. The panel follows the Harness locale service (`locale.getSnapshot().active`) and falls back to the browser
   language when the service is absent, so it never needs the host's dictionary registry to render. */

import { Input } from "./controls.js"
import { same, stay } from "./api.js"
import { apply } from "./apply.js"
import { React, h, useEffect, useMemo, useState } from "./react.js"
export const TEXT = {
  title: ['超级智能体', 'Superagent'],
  close: ['关闭', 'Close'],
  cancel: ['取消', 'Cancel'],
  confirm: ['确定', 'Confirm'],
  loading: ['正在读取…', 'Loading…'],
  loadMore: ['加载更多', 'Load more'],
  empty: ['—', '—'],
  yes: ['是', 'Yes'],
  no: ['否', 'No'],
  retry: ['重试', 'Retry'],
  save: ['保存', 'Save'],
  saving: ['保存中…', 'Saving…'],
  saved: ['已保存', 'Saved'],
  edit: ['编辑', 'Edit'],
  done: ['完成', 'Done'],
  discard: ['放弃修改', 'Discard'],
  history: ['历史', 'History'],
  fullPrompt: ['完整提示词', 'Full prompt'],
  preview: ['预览', 'Preview'],
  back: ['返回', 'Back'],
  details: ['详情 ›', 'Details ›'],
  openSession: ['打开 Session', 'Open Session'],
  openMaster: ['打开主 Session', 'Open main Session'],
  openInSource: ['在来源中打开', 'Open in source'],
  searchPlaceholder: ['搜索工单、线程、触发或链接', 'Search tickets, threads, triggers or links'],
  searchLabel: ['搜索', 'Search'],
  searchFound: ['找到 {tickets} 个工单、{threads} 个线程、{items} 条触发', 'Found {tickets} tickets, {threads} threads and {items} triggers'],
  searchFoundCapped: ['找到 {tickets} 个工单、{threads} 个线程，前 {items} 条触发（请缩小范围）', 'Found {tickets} tickets, {threads} threads and the first {items} triggers (narrow the search)'],
  searchNone: ['没有找到。可以输入工单标题、线程名或消息片段。', 'Nothing found. Try a Ticket title, a Thread name, or a message snippet.'],
  searchFiltered: ['被来源过滤：{reason}', 'Filtered by its Source: {reason}'],
  inThread: ['在 {thread}', 'in {thread}'],
  glossary: ['术语表', 'Glossary'],
  glossaryIntro: ['面板使用同一套领域术语。中文和英文并排，便于对照产品与实现。', 'The panel uses one set of domain terms. Chinese and English side by side, so product and implementation read the same.'],
  glossaryChinese: ['中文', 'Chinese'],
  glossaryEnglish: ['English', 'English'],
  glossaryMeaning: ['含义', 'Meaning'],
  legendTitle: ['状态图例', 'Status legend'],
  legend: { done: ['完成', 'Done'], ongoing: ['进行中', 'Ongoing'], warning: ['警告', 'Warning'], error: ['错误', 'Error'], idle: ['空闲', 'Idle'], queued: ['排队', 'Queued'] },
  lang: ['zh', 'en'],
  offline: ['无法连接到 Superagent 管理服务。请确认插件已启用后重试。', 'Cannot reach the Superagent management service. Check that the plugin is enabled, then retry.'],
  hostNotRunning: ['Superagent 管理服务未运行（插件可能已停用或正在重启）。', 'The Superagent management service is not running (the plugin may be disabled or restarting).'],
  serverError: ['服务内部错误（{status}），请查看运行日志后重试。', 'Service error ({status}). Check the log, then retry.'],
  requestFailed: ['请求失败（{status}）。', 'Request failed ({status}).'],
  demoBadge: ['演示数据', 'Demo data'],
  demoHint: ['当前面板展示内置演示数据：设置、来源、提示词、工单等操作会真实写入本地状态目录。', 'This panel shows seeded demo data. Settings, sources, prompts and ticket actions write to the local state directory for real.'],
  reference: ['参考', 'Reference'],
  unknown: ['未知', 'Unknown'],
  loadFailed: ['读取失败：{error}', 'Could not load: {error}'],
  pageLabel: ['超级智能体页面', 'Superagent pages'],
  tab: {
    overview: ['概览', 'Overview'],
    source: ['来源', 'Source'],
    trigger: ['触发', 'Trigger'],
    eval: ['评估', 'Eval'],
    execution: ['执行', 'Execution'],
    pilot: ['试运行', 'Pilot'],
    settings: ['设置', 'Settings'],
  },
  statusTitle: ['系统状态', 'System status'],
  term: {
    agent: ['智能体', 'Agent'],
    mainSession: ['主 Session', 'Main Session'],
    executorSession: ['执行器 Session', 'Executor Session'],
    source: ['来源', 'Source'],
    channel: ['会话地址', 'Channel'],
    trigger: ['触发', 'Trigger'],
    thread: ['线程', 'Thread'],
    correlation: ['关联线程', 'Correlation'],
    subscription: ['订阅', 'Subscription'],
    fanout: ['扇出', 'Fan-out'],
    disposition: ['去向', 'Disposition'],
    policy: ['策略', 'Policy'],
    policyVersion: ['策略版本', 'Policy version'],
    eval: ['评估', 'Eval'],
    gate: ['准入', 'Gate'],
    assessment: ['评估过程', 'Assessment'],
    decision: ['决定', 'Decision'],
    mandate: ['授权', 'Mandate'],
    scope: ['受理范围', 'Scope'],
    strength: ['强度', 'Strength'],
    executor: ['执行器', 'Executor'],
    environment: ['执行环境', 'Environment'],
    ticket: ['工单', 'Ticket'],
    assignment: ['执行尝试', 'Assignment'],
    input: ['输入', 'Input'],
    report: ['报告', 'Report'],
    attention: ['待答复', 'Attention'],
  },
  meaning: {
    agent: ['在这个仓库上主动工作的编码智能体：监听来源、判断请求、开立工单并执行。', 'The coding agent that works proactively on this repository: it watches Sources, judges requests, opens Tickets and executes them.'],
    mainSession: ['负责路由与评估的 DSH Session，把触发变成决定。', 'The DSH Session that routes and evaluates, turning Triggers into Decisions.'],
    executorSession: ['执行一个工单的 DSH Session，拥有独立的目录与分支。', 'The DSH Session that executes one Ticket, with its own directory and branch.'],
    source: ['消息来源，例如一个 Octo 群。', 'A place messages arrive from, such as an Octo group.'],
    channel: ['来源内的一个可回复地址，例如某个群。', 'One replyable address inside a Source, such as a group.'],
    trigger: ['来源中的一条不可变消息。', 'One immutable message from a Source.'],
    thread: ['一段可以被订阅的对话，触发按它归组。', 'A conversation that can be subscribed to; Triggers are grouped by it.'],
    correlation: ['和同一触发相关的其它线程，仅作上下文。', 'Other Threads related to the same Trigger, used as context only.'],
    subscription: ['工单持续关注一个线程，新消息会送到它的执行器。', 'A Ticket keeps following a Thread; new messages reach its executor.'],
    fanout: ['一条触发按订阅分发给多个工单。', 'One Trigger delivered to several Tickets through subscriptions.'],
    disposition: ['触发进入系统后的去向：排队、评估、已决定、被过滤或已送达工单。', 'Where a Trigger went: queued, evaluating, decided, filtered, or delivered to a Ticket.'],
    policy: ['团队写的准入规则，决定哪些主动候选可以成为工单。', 'The team-written admission rules that decide which proactive candidates may become Tickets.'],
    policyVersion: ['策略内容的指纹，决定与授权都记录它。', 'A fingerprint of the Policy content; Decisions and Mandates record it.'],
    eval: ['对一条或多条触发做一次判断的过程。', 'One judging pass over one or more Triggers.'],
    gate: ['决定哪些消息可以进入评估的准入层。', 'The admission layer that decides which messages reach Eval.'],
    assessment: ['对候选是否属于本仓库工作的评估结论与规则命中。', 'The assessment of whether a candidate is work for this repository, with matched rules.'],
    decision: ['一次评估的结论：接单、续做、停止、忽略或未完成。', 'The outcome of one Eval: accept, reopen, stop, ignore, or unavailable.'],
    mandate: ['由决定产生、限定执行范围的不可变授权。', 'The immutable authorization an accept Decision produces, bounding execution.'],
    scope: ['允许智能体写入的仓库范围。', 'The repository scope the agent may write to.'],
    strength: ['授权是明确请求还是推断出的候选。', 'Whether a request was explicit or an inferred candidate.'],
    executor: ['执行工单的进程与并发槽位。', 'The process and concurrency slots that execute Tickets.'],
    environment: ['执行器运行命令时的目录、变量与准备命令。', 'The directory, variables and prepare command the executor runs with.'],
    ticket: ['一段被授权的执行工作，以及它在时间上的状态。', 'One authorized unit of work and its state over time.'],
    assignment: ['一次把工单交给执行器的尝试。', 'One attempt to run a Ticket on an executor.'],
    input: ['送进执行器 Session 的触发、文本或备注。', 'A Trigger, text or note delivered to the executor Session.'],
    report: ['执行器对工单的结论：进展、等待、就绪、受阻或失败。', 'The executor\'s report on a Ticket: progress, waiting, ready, blocked or failed.'],
    attention: ['执行器向人提出的问题，工单暂停等待回答。', 'A question the executor asks a person; the Ticket waits for the answer.'],
  },
  glossaryGroup: { roles: ['角色', 'Roles'], source: ['来源', 'Source'], trigger: ['触发与线程', 'Triggers and Threads'], eval: ['评估与策略', 'Eval and Policy'], execution: ['执行', 'Execution'] },
  decision: { accept: ['接单', 'Accept'], reopen: ['续做', 'Reopen'], stop: ['停止', 'Stop'], ignore: ['忽略', 'Ignore'], unavailable: ['未完成', 'Unavailable'], wouldAccept: ['本会接单', 'Would accept'] },
  strength: { explicit: ['明确', 'Explicit'], inferred: ['推断', 'Inferred'] },
  mode: { off: ['关闭', 'Off'], observe: ['仅观察', 'Observe'], auto: ['自动接单', 'Auto'] },
  stage: { answer: ['待回答', 'Needs an answer'], review: ['待评审', 'Needs review'], blocked: ['受阻', 'Blocked'], failed: ['失败', 'Failed'], delivery: ['待送达', 'Delivery failed'], queued: ['排队中', 'Queued'], working: ['执行中', 'Working'], idle: ['等待触发', 'Waiting for a Trigger'] },
  'ticket.ended': ['已结束', 'ended'],
  assignment: { pending: ['等待中', 'Pending'], running: ['运行中', 'Running'], ended: ['已结束', 'Ended'] },
  report: { progress: ['进展', 'Progress'], waiting: ['等待', 'Waiting'], ready: ['就绪', 'Ready'], blocked: ['受阻', 'Blocked'], failed: ['失败', 'Failed'], dropped: ['放弃', 'Dropped'] },
  source: { github: ['GitHub', 'GitHub'], feishu: ['飞书', 'Feishu'] },
  threadStage: { error: ['轮询错误', 'Poll error'], evaluating: ['评估中', 'Evaluating'], queued: ['排队等待评估', 'Queued for Eval'], subscribed: ['有工单关注', 'Subscribed'], dormant: ['仅存历史', 'Dormant'], unsubscribed: ['未订阅', 'Unsubscribed'] },
  // Overview
  needsYouNone: ['没有需要你处理的工单。', 'No Ticket needs you.'],
  pendingTickets: ['需要你处理的工单', 'Tickets needing you'],
  sourceError: ['{source} 来源异常', '{source} Source failing'],
  problemSetup: ['部署检查未通过，暂不接单', 'Deployment check failed; no work is taken'],
  problemNoSource: ['没有运行中的来源，不会收到任何触发', 'No Source is running; no Triggers arrive'],
  problemPaused: ['处理已暂停：不开始新的评估，不派工，不发送回复', 'Processing paused: no new Evals, Assignments or replies'],
  problemReply: ['{source} 回复发送失败（已重试 {attempts} 次）', '{source} reply failing (retried {attempts} times)'],
  problemRuntime: ['运行异常：{name}', '{name} failing'],
  problemEvalUnavailable: ['评估未完成：{thread}', 'Eval unavailable: {thread}'],
  problemEvalOverdue: ['评估超时未决定：{thread}', 'Eval overdue: {thread}'],
  problemNoAllowed: ['没有人能发起工作：各来源上的名单都为空，任何请求都不会成为工单', 'No one may originate work: the lists on every Source are empty, so no request can become a Ticket'],
  actionOpenSources: ['去打开来源', 'Turn on a Source'],
  actionAddAllowed: ['去添加名单', 'Add senders'],
  actionDismiss: ['忽略', 'Dismiss'],
  sourceErrorHint: ['来源会在每次轮询时自动重试。持续出现时检查网络和该来源的登录状态。', 'The Source retries on every poll. If this persists, check the network and the Source\'s sign-in.'],
  lastDay: ['过去 24 小时', 'Last 24 hours'],
  flowLabel: { received: ['到达', 'Arrived'], filtered: ['被过滤', 'Filtered'], dropped: ['放弃发送', 'Not sent'], judged: ['已评估', 'Evaluated'], accepted: ['接单或续做', 'Accepted or continued'] },
  idleLabel: ['等待新触发', 'Waiting for a Trigger'],
  executorLoad: ['执行器负载', 'Executor load'],
  loadRunning: ['运行中', 'Running'],
  loadQueued: ['排队', 'Queued'],
  loadIdle: ['执行器空闲 · 无排队或运行中工单', 'Executor idle · no queued or running tickets'],
  loadMaxWorkers: ['并发上限 {count}', 'Up to {count}'],
  // Source
  sourceStatusIntro: ['每个来源是否在运行、过去 24 小时到达和被过滤的触发，以及被过滤的原因。', 'Whether each Source runs, the Triggers that arrived and were filtered in the last 24 hours, and why.'],
  sourceReceivedLabel: ['24 小时到达', 'Arrived in 24 h'],
  sourceFilteredLabel: ['被过滤', 'Filtered'],
  sourceFilteredTitle: ['24 小时内最近被过滤的触发', 'Latest Triggers filtered in the last 24 hours'],
  sourceDroppedTitle: ['24 小时内放弃发送的消息', 'Not sent in the last 24 hours'],
  sourceDroppedHint: ['这些消息要发往的对话已无法接收，或来源已不再监听该对话，因此放弃发送。', 'Their conversation can no longer receive them, or the Source no longer listens to it, so they are not sent.'],
  labelsAdded: ['名单已更新，新增：{names}', 'List updated, added: {names}'],
  labelsCurrent: ['名单已是最新', 'List is up to date'],
  labelsFailed: ['读取失败，名单保持不变：{error}', 'Could not read the list; it stays as it was: {error}'],
  syncNow: ['立即同步', 'Sync now'],
  lastSync: ['上次同步 {time}', 'Last synced {time}'],
  sourceNotInstalled: ['插件未安装', 'Plugin not installed'],
  sourceState: { missing: ['未安装', 'Not installed'], off: ['已关闭', 'Off'], error: ['异常', 'Error'], setup: ['等待部署', 'Waiting for setup'], starting: ['启动中', 'Starting'], paused: ['已暂停', 'Paused'], ready: ['运行中', 'Ready'] },
  // Trigger
  triggerListIntro: ['线程按最近活动排序。选中一条查看它的触发、决定与订阅。', 'Threads sorted by latest activity. Open one to see its Triggers, Decisions and subscriptions.'],
  threadFilter: { subscribed: ['已订阅', 'Subscribed'], evaluating: ['评估中', 'Evaluating'], recent: ['24 小时新触发', 'New in 24 h'], all: ['全部线程', 'All threads'] },
  threadEmpty: { subscribed: ['没有正在被工单关注的线程。', 'No Thread is followed by a Ticket.'], evaluating: ['当前没有评估中的线程。', 'No Thread is evaluating now.'], recent: ['过去 24 小时没有新触发。', 'No Trigger arrived in the last 24 hours.'], all: ['还没有任何线程。', 'No Thread exists yet.'] },
  latest: ['最新', 'Latest'],
  pendingCount: ['排队 {count}', '{count} queued'],
  evaluatingSince: ['评估中（截止 {deadline}）', 'Evaluating (due {deadline})'],
  threadFacts: ['线程信息', 'Thread facts'],
  threadTickets: ['订阅的工单', 'Subscribed Tickets'],
  threadDecisions: ['评估决定', 'Decisions'],
  threadTimeline: ['消息时间线', 'Timeline'],
  threadContext: ['仅作上下文的关注', 'Followed for context only'],
  correlated: ['关联线程', 'Correlated Threads'],
  showEarlier: ['更早的消息', 'Earlier messages'],
  requeue: ['重新评估', 'Evaluate again'],
  requeued: ['已排队等待评估', 'Queued for Eval'],
  unsubscribe: ['取消订阅', 'Unsubscribe'],
  unsubscribeTitle: ['取消这个线程的订阅？', 'Unsubscribe from this Thread?'],
  unsubscribeMessage: ['正在执行的工单不再收到这个线程的新消息。线程历史保留，之后可以重新订阅。', 'Running Tickets stop receiving new messages from this Thread. Its history is kept and it can be subscribed again later.'],
  unsubscribedNotice: ['已取消订阅', 'Unsubscribed'],
  queuedForEval: ['排队等待评估', 'Queued for Eval'],
  evaluatingNow: ['评估中', 'Evaluating'],
  deliveredToTicket: ['已送达工单', 'Delivered to a Ticket'],
  fannedOut: ['扇出到 {count} 个工单', 'Fanned out to {count} Tickets'],
  filteredBySource: ['被来源过滤：{reason}', 'Filtered by its Source: {reason}'],
  decidedBy: ['决定：{decision}', 'Decision: {decision}'],
  noThreadTriggers: ['这个线程还没有消息。', 'This Thread has no messages yet.'],
  // Eval
  evalIntro: ['每次评估的结论、原因与命中的规则。未完成或超时的评估可以在这里忽略。', 'The outcome, reason and matched rules of each Eval. Unavailable or timed-out Evals can be dismissed here.'],
  decisionFilter: { work: ['接单或续做', 'Accept or reopen'], stop: ['停止', 'Stop'], ignore: ['忽略', 'Ignore'], unavailable: ['未完成', 'Unavailable'], all: ['全部', 'All'] },
  decisionEmpty: { work: ['还没有接单或续做的决定。', 'No accept or reopen Decision yet.'], stop: ['没有停止的决定。', 'No stop Decision.'], ignore: ['没有忽略的决定。', 'No ignore Decision.'], unavailable: ['没有未完成的评估。', 'No unavailable Eval.'], all: ['还没有任何决定。', 'No Decision yet.'] },
  window24h: ['仅看 24 小时', 'Last 24 hours'],
  matchedRules: ['命中规则', 'Matched rules'],
  // A rule's `matched` means "this check passed", not "a risk word was hit": R3 matched = no high-risk topic found.
  // Printing 命中 next to R3's own reason "未命中生产/DDL/…" contradicted itself (critique 2026-11-11).
  ruleMatched: ['通过', 'Passed'],
  ruleNotMatched: ['未通过', 'Not passed'],
  decisionReason: ['原因', 'Reason'],
  decisionDirection: ['方向判断', 'Direction'],
  decisionTicket: ['工单', 'Ticket'],
  dismissProblem: ['忽略问题', 'Dismiss'],
  dismissedNotice: ['已忽略', 'Dismissed'],
  decisionStrength: ['强度：{strength}', 'Strength: {strength}'],
  // Execution
  executionIntro: ['执行器状态、暂停开关，以及按阶段分组的工单。打开工单查看动作、授权、等待中的输入、订阅与执行尝试。', 'Executor state, the pause switch, and Tickets by stage. Open one for its actions, authorization, waiting inputs, subscriptions and assignments.'],
  ticketFilter: { open: ['进行中', 'Open'], person: ['需要人', 'Needs a person'], working: ['执行中', 'Working'], idle: ['空闲', 'Idle'], ended: ['已结束', 'Ended'] },
  ticketEmpty: { open: ['没有进行中的工单。', 'No open Ticket.'], person: ['没有等你处理的工单。', 'No Ticket waits for you.'], working: ['没有正在执行的工单。', 'No Ticket is working.'], idle: ['没有等待触发的工单。', 'No Ticket waits for a Trigger.'], ended: ['还没有结束的工单。', 'No Ticket has ended.'], },
  pauseProcessing: ['暂停处理', 'Pause processing'],
  resumeProcessing: ['恢复处理', 'Resume processing'],
  pausedBanner: ['处理已暂停：不开始新的评估，不派工，不发送回复。', 'Processing paused: no new Evals, Assignments or replies.'],
  resumedNotice: ['已恢复处理', 'Processing resumed'],
  pauseInterrupts: ['暂停会停止新的派工，正在运行的执行器继续当前一轮。', 'Pausing stops new dispatches; a running executor finishes its current turn.'],
  ticketOrigin: ['来源', 'Origin'],
  ticketBody: ['工单正文', 'Ticket body'],
  authorization: ['授权', 'Authorization'],
  authorizationBasis: ['准入依据', 'Admission basis'],
  waitingInputs: ['等待中的输入', 'Waiting inputs'],
  subscriptions: ['订阅', 'Subscriptions'],
  assignments: ['执行尝试', 'Assignments'],
  environment: ['执行环境', 'Execution environment'],
  stopTicket: ['停止工单', 'Stop Ticket'],
  stopTicketTitle: ['停止这个工单？', 'Stop this Ticket?'],
  stopTicketMessage: ['执行器停止工作，工单以「被人停止」结束。可以在线程里继续讨论。', 'The executor stops working and the Ticket ends as stopped by a person. The Thread can still be discussed.'],
  stoppedNotice: ['工单已停止', 'Ticket stopped'],
  retryTicket: ['重试', 'Retry'],
  retriedNotice: ['已重新排队', 'Queued again'],
  deliveryError: ['回复发送失败', 'Reply could not be sent'],
  sessionLink: ['执行器 Session', 'Executor Session'],
  directory: ['工单目录', 'Ticket directory'],
  endedBy: ['结束原因', 'Ended'],
  'ended.merged': ['Pull request 已合并', 'Pull request merged'],
  'ended.stopped': ['被人停止', 'Stopped by a person'],
  'ended.closed': ['已关闭', 'Closed'],
  'ended.done': ['完成', 'Done'],
  noInputs: ['还没有输入。', 'No input yet.'],
  noAssignments: ['还没有执行尝试。', 'No Assignment yet.'],
  before: ['前一页', 'Earlier'],
  // Settings
  settingsIntro: ['按概念分组的配置。每个分组只在有改动时显示保存条；保存使用版本号，冲突时提示重新载入。', 'Configuration grouped by concept. Each group shows a save bar only while changes exist; saves use a revision and ask you to reload on a conflict.'],
  settingsGroup: { source: ['来源', 'Sources'], eval: ['评估', 'Eval'], repos: ['仓库', 'Repositories'], prompts: ['提示词', 'Prompts'] },
  settingsSaved: ['已保存（修订 {revision}）', 'Saved (revision {revision})'],
  settingsConflict: ['设置已变化，请重新载入后再保存。', 'Settings changed. Reload before saving.'],
  restartRequired: ['保存已生效；来源账号变更在重新检查后完全生效。', 'Saved; Source account changes fully apply after the next check.'],
  policy: ['策略', 'Policy'],
  policyIntro: ['规则与各来源的名单决定哪些主动候选可以成为工单，以及谁可以发起工作。', 'Rules and each Source\'s lists decide which proactive candidates become Tickets and who may originate work.'],
  rules: ['规则', 'Rules'],
  addRule: ['添加规则', 'Add rule'],
  removeRule: ['删除规则', 'Remove rule'],
  ruleId: ['规则 id', 'Rule id'],
  ruleName: ['规则名称', 'Rule name'],
  ruleInstruction: ['规则说明', 'Instruction'],
  ruleEnabled: ['启用', 'Enabled'],
  allowed: ['允许发起工作的人', 'Allowed senders'],
  bots: ['机器人', 'Bots'],
  addRow: ['添加', 'Add'],
  removeRow: ['移除', 'Remove'],
  admission: ['准入表', 'Admission table'],
  admissionIntro: ['接收范围、发送者是否在名单、以及消息是否点名智能体，共同决定一条消息是否进入评估。', 'Receiving scope, whether the sender is listed, and whether the message addresses the agent together decide whether it reaches Eval.'],
  evalAcceptMode: ['接受模式', 'Accept mode'],
  evalTimeout: ['评估超时（秒）', 'Eval timeout (s)'],
  evalModel: ['评估模型', 'Assessment model'],
  followSessionDefault: ['跟随会话默认', 'Follow the Session default'],
  executorModel: ['执行器模型', 'Worker model'],
  executorMax: ['并发执行器数', 'Concurrent executors'],
  executorDirectory: ['工单目录根', 'Ticket directory root'],
  executorPrepare: ['准备命令', 'Prepare command'],
  executorBlocked: ['禁止命令', 'Blocked commands'],
  executorBlockedHint: ['每行一个；执行器环境里这些命令会被拒绝。', 'One per line; the executor environment refuses them.'],
  insertVariable: ['点击插入变量', 'Click to insert a variable'],
  sourceEnable: ['运行来源：{name}', 'Run Source: {name}'],
  sourceFields: ['来源配置', 'Source fields'],
  sourceFacts: ['已验证的账号信息', 'Verified account facts'],
  sourceLabels: ['名单显示名', 'Name labels'],
  sourcePolicy: ['该来源的策略', 'Policy on this Source'],
  deploymentStateDir: ['状态目录', 'State directory'],
  deploymentLimits: ['机器限制', 'Machine limits'],
  checkSetup: ['重新检查', 'Check again'],
  setupChecking: ['正在重新检查部署…', 'Checking deployment…'],
  setupCheckInterrupts: ['有 {count} 个执行器正在运行；重新检查会中断它们。', '{count} executors are running; checking again interrupts them.'],
  deploymentIntro: ['启动检查、状态目录与机器限制。限制保存后立即生效。', 'Startup checks, the state directory and machine limits. Limits apply without a restart.'],
  envRoot: ['工单工作目录根', 'Ticket working root'],
  saveHistory: ['保存历史', 'Save history'],
  historyEmpty: ['还没有保存记录。', 'No save yet.'],
  change: {
    ruleAdded: ['新增规则：{name}', 'Rule added: {name}'],
    ruleRemoved: ['删除规则：{name}', 'Rule removed: {name}'],
    ruleEnabled: ['启用规则：{name}', 'Rule enabled: {name}'],
    ruleDisabled: ['停用规则：{name}', 'Rule disabled: {name}'],
    ruleRenamed: ['规则改名：{from} → {to}', 'Rule renamed: {from} → {to}'],
    ruleInstruction: ['修改规则说明：{name}', 'Rule instruction changed: {name}'],
    sourceEnabled: ['开启来源：{source}', 'Source enabled: {source}'],
    sourceDisabled: ['关闭来源：{source}', 'Source disabled: {source}'],
    sourceField: ['修改来源字段 {source}.{field}', 'Source field changed: {source}.{field}'],
    sourceRowsAdded: ['{source} 名单新增：{items}', '{source} list added: {items}'],
    sourceRowsRemoved: ['{source} 名单移除：{items}', '{source} list removed: {items}'],
    sourceRowsChanged: ['{source} 名单修改：{items}', '{source} list changed: {items}'],
    sourceAdmission: ['修改 {source} 的准入表', '{source} admission table changed'],
    mode: ['接受模式：{from} → {to}', 'Accept mode: {from} → {to}'],
    timeout: ['评估超时：{from} → {to} 秒', 'Eval timeout: {from} → {to}s'],
    evalModel: ['评估模型已修改', 'Assessment model changed'],
    executorModel: ['执行器模型已修改', 'Worker model changed'],
    maxWorkers: ['并发执行器：{from} → {to}', 'Concurrent executors: {from} → {to}'],
    paused: ['暂停处理', 'Processing paused'],
    resumed: ['恢复处理', 'Processing resumed'],
    executionDirectory: ['工单目录根：{from} → {to}', 'Ticket root: {from} → {to}'],
    prepareCommand: ['准备命令已修改', 'Prepare command changed'],
    blockedCommands: ['禁止命令已修改', 'Blocked commands changed'],
  },
  fields: { repository: ['仓库', 'Repository'], cli: ['CLI', 'CLI'], pollSeconds: ['轮询间隔（秒）', 'Poll interval (s)'], readLimit: ['单次读取上限', 'Read limit'], receive: ['接收范围', 'Receive'], enabled: ['启用', 'Enabled'] },
  // Prompts
  promptsIntro: ['团队写的提示词覆盖内置文本；完整提示词展示组装结果。提示词决定告诉智能体什么，不改变它被允许做什么。', 'The team text that overrides the built-in prompts; Full prompt shows the assembled result. Prompt text changes what the agents are told, not what they may do.'],
  teamSection: { communication: ['沟通', 'Communication'], scope: ['工单范围', 'Ticket scope'], delivery: ['交付要求', 'Delivery requirements'] },
  skills: ['技能', 'Skills'],
  addSkill: ['添加技能', 'Add skill'],
  skillName: ['技能名', 'Skill name'],
  skillText: ['技能内容', 'Skill text'],
  builtInParts: ['内置段落', 'Built-in parts'],
  builtInIntro: ['这些段落有内置文本；团队文本会覆盖它。模板里的占位符必须保留。', 'These parts ship with built-in text; team text overrides it. A template\'s placeholders must stay.'],
  override: ['团队文本', 'Team text'],
  resetDefault: ['恢复内置文本', 'Reset to built-in'],
  changed: ['已修改', 'Changed'],
  defaultUpdated: ['默认内容已更新', 'Default updated'],
  defaultUpdatedIntro: ['升级改动了这些段落的默认文本。选择保留团队文本，或改用新默认。', 'An upgrade changed the default text of these parts. Keep the team text, or use the new default.'],
  keepMine: ['保留我的文本', 'Keep my text'],
  useNew: ['使用新默认', 'Use the new default'],
  promptsHistory: ['提示词版本历史', 'Prompt history'],
  promptsRestore: ['查看此版本', 'View this revision'],
  promptsCurrent: ['当前版本', 'Current'],
  savingPrompts: ['保存提示词', 'Save prompts'],
  noChanges: ['没有改动', 'No changes'],
  saveFailed: ['保存失败：{error}', 'Save failed: {error}'],
  promptScopeNote: ['这些文本只改变对智能体的说明，不改变工具权限、准入闸门或账号包装。', 'This text only changes what the agents are told; tool permissions, the gate and account wrappers stay.'],
  promptPartLabel: { 'runtime/shared': ['共享说明', 'Shared'], 'runtime/orchestrator': ['主 Session 说明', 'Orchestrator'], 'runtime/worker': ['执行器说明', 'Worker'], 'runtime/subscriptions': ['订阅指南', 'Subscriptions'], 'runtime/replies': ['回复指南', 'Replies'], 'runtime/dispatch': ['派工指南', 'Dispatch'], 'runtime/work': ['执行指南', 'Work'], 'runtime/admission': ['准入说明', 'Admission'], 'runtime/handoff/orchestrator': ['交接（主）', 'Handoff (main)'], 'runtime/handoff/worker': ['交接（执行器）', 'Handoff (worker)'], 'runtime/environment': ['执行环境', 'Environment'], 'runtime/policy': ['策略段', 'Policy'], 'runtime/policy/none': ['策略段（无规则）', 'Policy (no rules)'], 'skill/github': ['GitHub 技能', 'GitHub skill'], 'skill/feishu': ['飞书技能', 'Feishu skill'] },
  // Errors
  error: {
    skillName: ['技能名只能用小写字母、数字和连字符，且以字母开头。', 'A skill name is lowercase letters, digits and dashes, starting with a letter.'],
    skillBuiltIn: ['{name} 是内置技能名。', '{name} is a built-in skill name.'],
    skillEmpty: ['技能 {name} 的内容为空。', 'Skill {name} has no text.'],
    unknownPart: ['未知的内置段落：{part}', 'Unknown built-in part: {part}'],
    partEmpty: ['段落 {part} 的文本为空。', 'Part {part} has no text.'],
    placeholders: ['段落 {part} 缺少占位符：{placeholders}', 'Part {part} is missing placeholders: {placeholders}'],
    tooLong: ['提示词超过 {limit} 个字符的上限。', 'The prompt exceeds the {limit} character limit.'],
    conflict: ['内容已被其他人修改，请重新载入后再保存。', 'Someone else changed this; reload before saving.'],
  },
  setup: {
    repositoryUnset: ['没有配置仓库。', 'No repository is configured.'],
    agentCliUnset: ['没有配置 GitHub CLI。', 'No GitHub CLI is configured.'],
    agentCliMissing: ['GitHub CLI 不可执行：{detail}', 'The GitHub CLI is not executable: {detail}'],
    agentCliSignedOut: ['GitHub CLI 未登录：{detail}', 'The GitHub CLI is not signed in: {detail}'],
    agentCliNoAccount: ['GitHub CLI 没有返回账号。', 'The GitHub CLI returned no account.'],
    repositoryUnreadable: ['读取仓库失败：{detail}', 'The repository could not be read: {detail}'],
    repositoryUnreported: ['仓库没有返回访问信息。', 'The repository returned no access facts.'],
    repositoryReadOnly: ['当前 CLI 身份对 {repository} 没有推送权限。', 'The CLI identity has no push access to {repository}.'],
    feishuCliUnset: ['没有配置飞书机器人 CLI。', 'No Feishu bot CLI is configured.'],
    feishuCliFailed: ['飞书 CLI 检查失败：{detail}', 'The Feishu CLI check failed: {detail}'],
    feishuNotBot: ['飞书 CLI 不是机器人身份。', 'The Feishu CLI is not a bot identity.'],
    stateDirMissing: ['状态目录不存在。', 'The state directory does not exist.'],
    stateDirUnwritable: ['状态目录不可写。', 'The state directory is not writable.'],
    workerModelMissing: ['没有可用的执行器模型。', 'No worker model is available.'],
  },
  reason: {
    said: ['{text}', '{text}'],
    timeout: ['评估超时', 'Assessment timed out'],
    policyChanged: ['评估过程中策略已变化', 'Policy changed during assessment'],
    noAdmissible: ['没有可准入的触发', 'No admissible trigger'],
    senderNotMember: ['发送者不在名单里', 'The sender is not on the Source\'s list'],
    routed: ['已路由到工单 {ticket}', 'Routed to Ticket {ticket}'],
    explicitRequest: ['来自名单成员的明确请求', 'Explicit request from a listed sender'],
    humanStop: ['人要求停止', 'A person asked to stop'],
    retried: ['由人重新评估', 'Re-evaluated by a person'],
    ignoredFromCard: ['从卡片忽略，未经规则评估', 'Ignored from its card, without a rule assessment'],
    observed: ['观察模式：本会接单（{text}）', 'Observe mode: would accept ({text})'],
    ciFailure: ['默认分支 CI 失败', 'Default-branch CI failed'],
    noRuleMatched: ['没有启用的规则匹配', 'No enabled rule matched'],
    handback: ['执行器交回：{reason}', 'Handed back by the executor: {reason}'],
    senderNotBot: ['机器人不在该来源的机器人名单里', 'The bot is not on that Source\'s bot list'],
  },
  // Filters, statuses not covered above
  filter: { all: ['全部', 'All'] },
  copied: ['已复制', 'Copied'],
  open: ['打开', 'Open'],
  collapse: ['收起', 'Collapse'],
  expand: ['展开', 'Expand'],
  willBeAvailable: ['暂不可用', 'Not available yet'],
  problems: ['需要处理的问题', 'Problems'],
  retryTitle: ['重试这个工单？', 'Retry this Ticket?'],
  retryConfirm: ['工单会重新进入执行器队列，执行器从工单当前状态继续：{title}', 'The Ticket returns to the executor queue and continues from its current state: {title}'],
  stop: ['停止', 'Stop'],
  stopConfirmTitle: ['停止这个工单？', 'Stop this Ticket?'],
  stopConfirm: ['执行器停止工作，工单以「被人停止」结束：{title}', 'The executor stops and the Ticket ends as stopped by a person: {title}'],
  fanoutTo: ['送达', 'Reaches'],
  andMore: [' 等 {count} 个', ' and {count} more'],
  labelSeparator: ['：', ': '],
  listSeparator: ['、', ', '],
  ruleLabel: ['规则', 'Rules'],
  automatedEarlier: ['更早的自动消息（{count}）', 'Earlier automated messages ({count})'],
  ticketUndeliveredLabel: ['未送达', 'Undelivered'],
  contextOnly: ['仅上下文', 'Context only'],
  contextOnlyHint: ['这个线程只作为上下文送到执行器，不授予任何权限。', 'This Thread reaches the executor as context only and grants nothing.'],
  answerIn: ['去{source}回答', 'Answer in {source}'],
  executorWaitingSetup: ['部署检查通过前执行器不运行。', 'The executor does not run until the deployment check passes.'],
  executingLabel: ['运行中', 'Running'],
  queuedLabel: ['排队', 'Queued'],
  problemsFix: ['去修正', 'Fix it'],
  health: { github: ['GitHub 来源', 'GitHub Source'], feishu: ['飞书来源', 'Feishu Source'], runtime: ['运行', 'Runtime'], models: ['模型服务', 'Model service'], assessment: ['评估', 'Assessment'], evals: ['未完成评估', 'Unfinished Evals'], history: ['历史', 'History'], 'sync:github': ['GitHub 名单同步', 'GitHub list sync'], 'sync:feishu': ['飞书名单同步', 'Feishu list sync'] },
  // Shared component text appended for redesign-2026-11 §3/§7 (design-system); existing keys above keep their semantics.
  copy: ['复制', 'Copy'],
  rawError: ['原始错误', 'Raw error'],
  glossaryValues: ['状态取值', 'State values'],
  moreActions: ['更多操作', 'More actions'],
  savebarDirty: ['有未保存的修改', 'Unsaved changes'],
  savebarFailed: ['保存失败：{error}', 'Save failed: {error}'],
  savebarSavedAt: ['已保存 {time}', 'Saved {time}'],
  errorHint: ['可以先重试；如果一直失败，检查插件是否在运行。', 'Retry first; if it keeps failing, check that the plugin is running.'],
  reload: ['重新载入', 'Reload'],
  reloadConfig: ['重新载入配置', 'Reload config'],
  noData: ['暂无数据', 'No data'],
  statusLabel: ['状态', 'Status'],
  loadbarRunning: ['执行中 {count}', 'Working {count}'],
  loadbarQueued: ['排队 {count}', 'Queued {count}'],
  loadbarWaiting: ['等你处理 {count}', 'Waiting on you {count}'],
  loadbarFailed: ['失败 {count}', 'Failed {count}'],
  loadbarPaused: ['已暂停', 'Paused'],
  funnelReceived: ['到达', 'Arrived'],
  funnelFiltered: ['过滤', 'Filtered'],
  funnelJudged: ['评估', 'Evaluated'],
  funnelAccepted: ['接单', 'Accepted'],
  funnelDropped: ['出站失败 {count}', 'Not sent: {count}'],
  funnelEmpty: ['暂无 24 小时数据', 'No 24-hour data yet'],
  dataUpdatedAt: ['数据更新于 {time}', 'Data updated {time}'],
  lastChecked: ['上次检查 {time}', 'Last checked {time}'],
  noNeedsYou: ['现在没有需要你处理的事', 'Nothing needs you right now'],
  savedTime: ['保存于 {time}', 'Saved at {time}'],
}

/** Bilingual lookup helpers used by the views to render enum values and glossary rows. */
export const GLOSSARY = { roles: ['agent', 'mainSession', 'executorSession'], source: ['source', 'channel'],
  trigger: ['trigger', 'thread', 'correlation', 'subscription', 'fanout', 'disposition'],
  eval: ['policy', 'policyVersion', 'eval', 'gate', 'assessment', 'decision', 'mandate', 'scope', 'strength'],
  execution: ['executor', 'environment', 'ticket', 'assignment', 'input', 'report', 'attention'] }
export const GLOSSARY_VALUES = {
  decision: ['decision.accept', 'decision.reopen', 'decision.stop', 'decision.ignore', 'decision.unavailable', 'decision.wouldAccept'],
  strength: ['strength.explicit', 'strength.inferred'],
  ticket: ['stage.answer', 'stage.review', 'stage.blocked', 'stage.failed', 'stage.delivery', 'stage.queued', 'stage.working', 'stage.idle', 'ticket.ended'],
  assignment: ['assignment.pending', 'assignment.running', 'assignment.ended'],
  report: ['report.progress', 'report.waiting', 'report.ready', 'report.blocked', 'report.failed', 'report.dropped'],
}

export const DICTS = {}
for (const lang of ['zh', 'en']) {
  const index = lang === 'zh' ? 0 : 1
  /** @type {Array<[string, any]>} */
  const pairs = []
  for (const [key, value] of Object.entries(TEXT)) {
    if (Array.isArray(value)) {
      pairs.push([key, value[index]])
      continue
    }
    // Nested groups (`decision.accept`, `glossaryGroup.roles`, …) become flat dotted keys.
    /** @type {Record<string, any>} */
    const flat = {}
    for (const [suffix, pair] of Object.entries(value)) flat[`${key}.${suffix}`] = pair[index]
    pairs.push(...Object.entries(flat))
  }
  DICTS[lang] = Object.fromEntries(pairs)
}

/** Translate one key with `{name}` interpolation; unknown keys render as the key so a missing entry is visible. */
export function translate(lang, key, values) {
  const dict = DICTS[lang] ?? DICTS.zh
  const template = dict[key] ?? DICTS.zh[key] ?? key
  if (values === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}

/** Subscribe to the Harness locale and expose a translator bound to the active language, with a browser fallback. */
export function useTranslator(ctx) {
  const [lang, setLang] = useState(() => detectLang(ctx))
  useEffect(() => {
    const locale = ctx.get?.('locale')
    if (!locale?.subscribe) return
    const unsubscribe = locale.subscribe(() => setLang(detectLang(ctx)))
    return unsubscribe
  }, [ctx])
  return useMemo(() => {
    const t = (key, values) => translate(lang, key, values)
    t.lang = lang
    return t
  }, [lang])
}
export function detectLang(ctx) {
  try {
    const locale = ctx.get?.('locale')
    const active = locale?.getSnapshot?.().active ?? locale?.getLocale?.().active
    if (typeof active === 'string') return active.startsWith('zh') ? 'zh' : 'en'
  } catch { /* fall through to the browser preference */ }
  const browser = typeof navigator !== 'undefined' ? navigator.language : 'en'
  return String(browser).startsWith('zh') ? 'zh' : 'en'
}
export const errorText = failure => failure instanceof Error ? failure.message : String(failure)
export const localized = (t, value) => typeof value === 'string' ? value : value ? value[t.lang === 'en' ? 'en' : 'zh'] : ''
export const actorName = (t, actor) => actor?.name ? localized(t, actor.name) : t('unknown')
export const valueLabel = (t, group, key) => {
  if (!key) return ''
  const text = t(`${group}.${key}`)
  return text === `${group}.${key}` ? key : text
}
/** Render one or more structured reasons in the active language; unknown codes fall back to their code. */
export function reasonLabel(t, reason) {
  const list = reason === undefined ? [] : Array.isArray(reason) ? reason : [reason]
  return list.map(item => {
    if (typeof item === 'string') return item
    const key = `reason.${item.code}`
    const text = t(key, item.values ?? {})
    if (text !== key) return text
    // Shared vocabulary keys (contextOnly, …) live at the top level, not under `reason.`.
    const shared = t(item.code, item.values ?? {})
    return shared === item.code ? item.code : shared
  }).filter(Boolean).join('；')
}
export const setupText = (t, problem) => problem ? t(`setup.${problem.code}`, problem.values ?? {}) : ''
/** Replace source content placeholders with localized labels. */
export const readableMarkers = (t, value) => String(value ?? '')
  .replace(/!\[[^\]]*\]\([^)]*\)|\[Image: [^\]]*\]|\[image\]/g, '［图片］')
  .replace(/\[Chat card: [^\]]*\]/g, '［卡片］')
  .replace(/\[Media: [^\]]*\]/g, '［媒体］')
  .replace(/\[Merged forward\]/g, '［合并转发］')
  .replace(/@_user_\d+/g, '［未知提及］')

export const timeLocale = lang => lang === 'en' ? 'en' : 'zh-CN'
/** Relative time for recent values and an absolute time for older ones. */
export function when(value, lang) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const seconds = Math.round((date.getTime() - Date.now()) / 1000)
  if (Math.abs(seconds) < 86_400) {
    const relative = new Intl.RelativeTimeFormat(timeLocale(lang), { numeric: 'auto' })
    if (Math.abs(seconds) < 60) return relative.format(0, 'second')
    if (Math.abs(seconds) < 3600) return relative.format(Math.round(seconds / 60), 'minute')
    return relative.format(Math.round(seconds / 3600), 'hour')
  }
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleString(timeLocale(lang), { ...sameYear ? {} : { year: 'numeric' }, month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
export const fullTime = (value, lang) => {
  const date = new Date(value ?? '')
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(timeLocale(lang))
}
