/* LiveSettingsPage: live.json configuration in six groups (contract §6.6). The left column switches groups and the
   right column edits one group at a time. The executor split into two groups — one for how work runs (run) and one
   for what it may write (write) — so a high-risk permission never sits beside an unrelated switch. Editable groups
   keep a group-local draft and save through `actions.patchSettings(patch)` followed by a model reload; read-only rows
   state where the value comes from (live.json / built-in prompts) and never render a fake switch. */

Object.assign(PAGE_TEXT, {
  'repos.intro': ['执行器使用的 GitLab / GitHub 仓库：本地克隆、分支、闸门、验证与验收方式，以及每个仓库独立的 GitLab token。',
    'Repositories used by the executor: local clone, branches, gates, verification and acceptance, plus one GitLab token per repository.'],
  'repos.summary': ['{count} 个仓库 · 默认仓库 {default}', '{count} repositories · default {default}'],
  'repos.empty': ['live.json 里没有 repos；旧版单仓库字段会自动合成一个仓库。',
    'No repos in live.json; a legacy single-repository file is synthesised into one repository.'],
  'repos.manageHint': ['自动接单群 → 仓库的绑定在「设置 → 来源」里管理；手工建单在「设置 → 运行」里选择仓库。',
    'Group → repository bindings live under Settings → Source; manual tickets pick a repository under Settings → Runtime.'],
  'repos.gates': ['闸门', 'Gates'],
  'repos.gatesEmpty': ['默认闸门', 'Default gates'],
  'repos.tokenSaved': ['{name} 的 GitLab token 已保存', 'GitLab token saved for {name}'],
  'repos.tokenCleared': ['已清除 {name} 的 GitLab token', 'GitLab token cleared for {name}'],
  'repos.tokenPlaceholder': ['粘贴 GitLab token', 'Paste a GitLab token'],
  'repos.tokenSave': ['保存令牌', 'Save token'],
  'repos.tokenClear': ['清除令牌', 'Clear token'],
  // Clearing a token stops CI/deploy/UAT observation for that repository, so it asks first and states the consequence
  // (unlike saving, which is reversible by saving again).
  'repos.tokenClearTitle': ['清除这个仓库的 GitLab token？', 'Clear the GitLab token for this repository?'],
  'repos.tokenClearMessage': ['清除后该仓库的 CI/部署/UAT 观测会停止，直到重新配置 token；不会影响已合并的工单。',
    'After clearing, CI, deployment and UAT observation stop for this repository until a token is configured again; already merged Tickets are not affected.'],
  'repos.tokenHint': ['写入该仓库在 live.json 里声明的 tokenFile（权限 600），不会回显。',
    'Written to the tokenFile declared for this repository in live.json (mode 600); never echoed back.'],
  // ---- page chrome / navigation ----
  'st.pageIntro': ['设置会写回 ~/.dsh/superagent/live.json。只有改动的分组才会出现保存条，保存后立即生效。',
    'Settings are written to ~/.dsh/superagent/live.json. Only a changed group shows a save bar, and saving applies immediately.'],
  'st.navLabel': ['设置分组', 'Settings groups'],
  // Reference groups (评估 / 提示词) are read-only: they sit below a divider in the rail and never show a save bar.
  'st.reference': ['参考', 'Reference'],
  // The run/write groups split the old executor group; their labels live here as page-local overrides of the shared
  // settingsGroup dictionary (06-i18n.js keeps source/eval/repos/prompts only).
  'settingsGroup.run': ['运行', 'Runtime'],
  'settingsGroup.write': ['写权限', 'Write access'],
  'st.unsaved': ['未保存', 'Unsaved'],
  'st.bindings': ['自动接单群（群 → 仓库）', 'Intake groups (group → repository)'],
  'st.bindingsHint': ['给每个监听群绑定一个仓库；新群需要填 Octo 群的 chatId（可在群信息里查看），保存后引擎开始监听。',
    'Bind one repository to each watched group. A new group needs its Octo chat id (visible in the group info); the engine starts watching it after saving.'],
  'st.bindingChat': ['群 chatId', 'Group chat id'],
  'st.bindingTitle': ['群名称（可选）', 'Group name (optional)'],
  'st.bindingRepo': ['接单仓库', 'Repository'],
  'st.bindingAdd': ['添加绑定', 'Add binding'],
  'st.bindingRemove': ['移除', 'Remove'],
  'st.bindingEmpty': ['还没有绑定的群。现有群默认走默认仓库。',
    'No bound group yet. Existing groups fall back to the default repository.'],
  'st.bindingSaved': ['群绑定已保存', 'Group bindings saved'],
  'st.bindingChatRequired': ['请填写群 chatId。', 'Enter the group chat id.'],

  // ---- one-line intro hints of the groups (the group name itself lives in the left nav) ----
  'st.sourceHint': ['输入通道：监听哪些群、谁能触发，以及多久轮询一次。只读项直接来自 live.json。',
    'Intake: which groups are watched, who may trigger work, and the poll interval. Read-only items come straight from live.json.'],
  'st.evalHint': ['评估方式与规则目录由代码和 eval.mode 决定，这里只读展示。',
    'The evaluation mode and rule catalog come from code and eval.mode; shown read-only here.'],
  'st.runHint': ['执行器总开关、运行方式与 worker 配置。改完保存后立即生效；写权限在「写权限」分组单独管理。',
    'The executor master switch, how work runs and the worker configuration. Changes apply after saving; write permissions are managed separately under Write access.'],
  'st.writeHint': ['执行器对 GitLab 和来源群的写权限。关闭时执行器只准备改动：不推送分支、不合并 MR、不回群。',
    'What the executor may write to GitLab and to the source group. When off it only prepares changes: no branch push, no MR merge, no group reply.'],
  'st.deployHint': ['部署与 GitLab 目标由 live.json 文件配置。这里只读展示，可重载配置或检查 UAT。',
    'Deployment and the GitLab target are configured in live.json. Shown read-only here, with reload and a UAT check.'],

  // ---- source group ----
  'st.enabled': ['启用引擎', 'Engine enabled'],
  'st.enabledHint': ['开启后按轮询间隔读取监听群；关闭后只保留手动干跑。',
    'When on, watched groups are read on the poll interval; when off, only manual dry runs remain.'],
  'st.pollSeconds': ['轮询间隔（秒）', 'Poll interval (seconds)'],
  'st.pollSecondsHint': ['最小 2 秒；暂停期间不会自动轮询。', 'At least 2 seconds; nothing polls automatically while paused.'],
  'st.pollInvalid': ['轮询间隔必须是不小于 2 的整数秒。', 'The poll interval must be a whole number of seconds, at least 2.'],
  'st.allowAnyHuman': ['允许任意人类触发', 'Accept any human'],
  'st.allowAnyHumanHint': ['关闭时只接受“允许发送者”名单里的消息。',
    'When off, only messages from the allowed-senders list are accepted.'],
  'st.watchChats': ['监听群', 'Watched groups'],
  'st.senders': ['允许发送者', 'Allowed senders'],
  'st.allHumans': ['任意人类', 'Any human'],
  'st.octoToken': ['Octo token', 'Octo token'],
  'st.tokenOk': ['已配置', 'Configured'],
  'st.tokenMissing': ['未配置', 'Missing'],
  'st.cursors': ['群游标', 'Group cursors'],
  'st.lastPoll': ['最近轮询', 'Last poll'],
  'st.noSenders': ['没有允许发送者，也没有“允许任意人类”：轮询会被引擎拒绝。',
    'No allowed senders and "accept any human" is off, so the engine rejects polling.'],
  'st.noChats': ['还没有监听群。在 live.json 的 octo.watchChatIds 填入群 ID，然后重载配置。',
    'No watched groups yet. Put group ids in octo.watchChatIds in live.json, then reload the config.'],
  'st.probeHint': ['“检查新消息”是干跑：只读取并评估，不写入状态、不建工单。',
    '"Check for new messages" is a dry run: it only reads and evaluates, writing no state and creating no Ticket.'],
  'st.probeAt': ['检查于 {time}', 'Checked {time}'],
  'st.probeSummary': ['检查完成：可接单 {accepted} · 忽略 {ignored}（干跑，未写入）',
    'Check finished: {accepted} acceptable · {ignored} ignored (dry run, nothing written)'],
  'st.probeFailed': ['检查失败。', 'The check failed.'],
  'st.errBusy': ['已有一次轮询在进行中，请稍后再试。', 'A poll is already running; try again shortly.'],
  'st.errPaused': ['引擎已暂停：非干跑轮询会被拒绝。', 'The engine is paused: a non-dry-run poll is rejected.'],
  'st.errNoConfig': ['live.json 不存在。', 'live.json does not exist.'],
  'st.errDisabled': ['live.json 里引擎未启用（enabled=false）。', 'The engine is disabled in live.json (enabled=false).'],
  'st.errNoToken': ['Octo token 未配置，读不到群消息。', 'The Octo token is missing, so group messages cannot be read.'],
  'st.errNoSender': ['没有允许发送者，也没有“允许任意人类”。', 'No allowed senders and "accept any human" is off.'],
  'st.reloadConfig': ['重载配置', 'Reload config'],
  'st.reloadFailed': ['重载配置失败。', 'Reloading the config failed.'],
  'st.reloadedAt': ['已重载配置 {time}', 'Config reloaded {time}'],

  // ---- eval group ----
  'st.evalMode': ['评估方式', 'Evaluation mode'],
  'st.modeRules': ['规则引擎（rules）', 'Rule engine (rules)'],
  'st.modeLlm': ['模型评估（llm）', 'Model evaluation (llm)'],
  'st.modeUnknown': ['未知模式（{mode}）', 'Unknown mode ({mode})'],
  'st.rules': ['规则目录', 'Rule catalog'],
  'st.noRules': ['没有可显示的规则。', 'No rules to show.'],
  'st.decisionsTotal': ['累计决定', 'Decisions so far'],
  'st.decisions24h': ['最近 24 小时决定', 'Decisions in the last 24 hours'],

  // ---- execution group ----
  'st.execEnabled': ['启用执行器', 'Executor enabled'],
  'st.execEnabledHint': ['关闭时工单只排队，不运行 worker、不发布 MR。',
    'When off, Tickets only queue: no worker runs and no MR is published.'],
  'st.autoRun': ['自动执行新工单', 'Auto-run new Tickets'],
  'st.autoRunHint': ['新接的工单自动交给执行器；关闭后需要手动干跑或发布。',
    'Newly accepted Tickets go to the executor automatically; when off, run or publish them by hand.'],
  'st.allowPush': ['允许推送分支', 'Allow branch pushes'],
  'st.allowPushHint': ['执行器可以推送分支到 GitLab 并创建 MR。', 'The executor may push a branch to GitLab and open an MR.'],
  'st.allowMerge': ['允许合并 MR', 'Allow MR merges'],
  'st.allowMergeHint': ['CI 通过后执行器可以直接合并到目标分支。',
    'After CI passes the executor may merge into the target branch.'],
  'st.allowMergeNoToken': ['没有 GitLab token，不能合并 MR。', 'Merging an MR needs a GitLab token.'],
  // High-risk emphasis for allowMerge: the warning tag says what it is, the info tip and the on-state line say what
  // it costs. Both are copy, not a second confirmation: the save bar keeps its usual one-step semantics.
  'st.highRisk': ['高危', 'High risk'],
  'st.allowMergeRisk': ['开启后 CI 通过即自动合并到目标分支，不再需要人工确认。',
    'When on, a passing CI pipeline merges into the target branch automatically — no human confirmation.'],
  'st.allowMergeOn': ['已开启自动合并：CI 通过后执行器直接合并到目标分支，不再等待人工确认。',
    'Auto-merge is on: once CI passes the executor merges into the target branch without waiting for a human.'],
  'st.allowReply': ['允许回群消息', 'Allow group replies'],
  'st.allowReplyHint': ['执行器把状态与结果回复到来源群。', 'The executor posts status and results back to the source group.'],
  'st.paused': ['暂停处理', 'Pause processing'],
  'st.pausedHint': ['暂停后不轮询、不自动执行、不核对 UAT；已排队的工单保持不动。',
    'While paused: no polling, no auto-run and no UAT verification; queued Tickets stay as they are.'],
  'st.mrMode': ['发布 MR 方式', 'MR creation mode'],
  'st.mrModeHint': ['api：用 GitLab API 建 MR；push：用 git push options 建 MR。',
    'api: create the MR through the GitLab API; push: create it with git push options.'],
  'st.mrModeApi': ['GitLab API（api）', 'GitLab API (api)'],
  'st.mrModePush': ['推送选项（push）', 'Push options (push)'],
  'st.workerBackend': ['Worker 后端', 'Worker backend'],
  'st.workerDsh': ['DSH（进程内）', 'DSH (in-process)'],
  'st.workerCodex': ['Codex CLI（本机）', 'Codex CLI (local)'],
  'st.workerClaude': ['Claude Code CLI（本机）', 'Claude Code CLI (local)'],
  'st.workerBackendHint': ['DSH 在宿主进程内跑；Codex / Claude 在工单 worktree 里拉起本机 CLI 会话。无论哪种，提交、推送、MR、闸门与部署仍由执行器负责。',
    'DSH runs in-process; Codex / Claude start a local CLI session inside the ticket worktree. In every case the executor still owns commit, push, MR, gates and deployment.'],
  'st.workerDshHint': ['使用宿主模型的 DSH agent（当前默认，无额外登录或 CLI 依赖）。',
    'Uses the host model through the in-process DSH agent (current default; no extra login or CLI dependency).'],
  'st.workerCodexHint': ['需要本机已 `codex login`。CLI 以 workspace-write 沙箱运行并关闭网络；路径留空时自动探测 ChatGPT.app / OctoBuddy 自带的 codex。',
    'Requires a logged-in local Codex CLI. It runs in the workspace-write sandbox with network disabled; an empty path auto-detects the codex bundled with ChatGPT.app / OctoBuddy.'],
  'st.workerClaudeHint': ['沿用本机 Claude Code 的登录与模型配置（本机当前指向 DeepSeek 网关）。只允许读/改/写/搜索文件，禁用 Bash、Web 与子 agent 工具。',
    'Uses the local Claude Code login and model configuration (this machine currently targets the DeepSeek gateway). File tools only — Bash, web and sub-agent tools are denied.'],
  'st.workerModel': ['模型（可选）', 'Model (optional)'],
  'st.workerModelHint': ['留空使用 CLI 自己的默认模型；Claude 例：deepseek-flash[1m]，Codex 例：gpt-6-astra。',
    'Leave empty to use the CLI default; e.g. deepseek-flash[1m] for Claude, gpt-6-astra for Codex.'],
  'st.workerCommand': ['CLI 路径（可选）', 'CLI path (optional)'],
  'st.workerCommandHint': ['留空自动探测：Claude 用 PATH 里的 claude；Codex 优先用 ChatGPT.app / OctoBuddy 自带的 codex。',
    'Empty auto-detects: claude from PATH; codex from the ChatGPT.app / OctoBuddy bundles first.'],
  'st.gates': ['闸门', 'Gates'],
  'st.timeout': ['执行超时', 'Run timeout'],
  'st.minutes': ['{count} 分钟', '{count} min'],
  'st.repo': ['仓库', 'Repository'],
  'st.manualRepoHint': ['工单会在这个仓库上执行；默认是 {name}。',
    'The Ticket runs on this repository; the default is {name}.'],
  'st.worktreeRoot': ['worktree 根目录', 'Worktree root'],
  'st.manualTitle': ['手工建单（测试）', 'Create a Ticket (test)'],
  'st.manualHint': ['测试用：会真实写入 live 状态并加入执行队列，不是干跑。',
    'For testing: writes real live state and joins the execution queue — not a dry run.'],
  'st.titlePh': ['标题', 'Title'],
  'st.bodyPh': ['正文（可选）', 'Body (optional)'],
  'st.create': ['建单', 'Create Ticket'],
  'st.created': ['已建单', 'Ticket created'],

  // ---- prompt group ----
  'st.briefNote': ['下面这段是最近一张工单实际发给 worker 的 brief（data.prompts.workerBrief），只读。',
    'This is the brief the latest Ticket actually sent the worker (data.prompts.workerBrief), read-only.'],
  'st.briefLabel': ['workerBrief', 'workerBrief'],
  'st.briefBuiltIn': ['内置提示词随代码版本发布，不在 live.json 里改。',
    'Built-in prompts follow the code version and are not configured in live.json.'],
  'st.briefEmpty': ['还没有工单，所以还没有 worker brief。', 'No Ticket yet, so there is no worker brief.'],
  'st.briefEmptyHint': ['接一单或手工建单后，这里会显示最近一次实际内容。',
    'Accept a request or create a Ticket, and the latest brief will appear here.'],

  // ---- deploy section (folded into the repositories group) ----
  'st.deployTitle': ['部署与限制', 'Deployment & limits'],
  'st.configFile': ['live.json', 'live.json'],
  'st.configExists': ['配置文件', 'Config file'],
  'st.fileExists': ['已找到', 'Found'],
  'st.fileMissing': ['不存在（使用默认值）', 'Missing (defaults in use)'],
  'st.gitlabProject': ['GitLab 项目', 'GitLab project'],
  'st.gitlabBase': ['GitLab 地址', 'GitLab base URL'],
  'st.branches': ['分支', 'Branches'],
  'st.gitlabToken': ['GitLab token', 'GitLab token'],
  'st.uatUrl': ['UAT 地址', 'UAT URL'],
  'st.healthUrl': ['健康检查地址', 'Health URL'],
  'st.reloadHint': ['改完 live.json 后重载，引擎会重新读取配置与 token 状态。',
    'After editing live.json, reload so the engine re-reads config and token state.'],
  'st.configError': ['live.json 读取失败：', 'Could not read live.json: '],
  'st.checkUat': ['检查 UAT', 'Check UAT'],
  'st.uatOk': ['UAT 可访问', 'UAT reachable'],
  'st.uatFail': ['UAT 不可访问', 'UAT unreachable'],
  'st.uatUnset': ['未配置 UAT 地址。', 'The UAT URL is not configured.'],
  'st.httpStatus': ['HTTP {status}', 'HTTP {status}'],
})

/** Group order of the left column; labels come from the shared settingsGroup dictionary in 06-i18n.js, except the
    two executor groups whose labels are page-local overrides (settingsGroup.run / settingsGroup.write above).
    `reference: true` marks a read-only group: the rail lists the groups that can be changed first, then a divider and
    the "参考" label, then these. The content column and the save-bar logic are unchanged — only the rail groups them. */
const SETTINGS_GROUPS = [
  { id: 'source', labelKey: 'settingsGroup.source', icon: 'inbox' },
  { id: 'eval', labelKey: 'settingsGroup.eval', icon: 'decision', reference: true },
  { id: 'run', labelKey: 'settingsGroup.run', icon: 'play' },
  { id: 'write', labelKey: 'settingsGroup.write', icon: 'blocked' },
  { id: 'repos', labelKey: 'settingsGroup.repos', icon: 'pull' },
  { id: 'prompt', labelKey: 'settingsGroup.prompts', icon: 'message', reference: true },
]

/** Only these groups own writable fields, so only they may ever render a save bar. `run` and `write` keep separate
    drafts and separate save bars even though both patch `executor.*`. */
const SETTINGS_SAVEABLE = ['source', 'run', 'write']

const settingsOmit = (object, key) => {
  const next = { ...(object ?? {}) }
  delete next[key]
  return next
}

/** Draft comparison: booleans by value, numbers/strings by their text form (the number input holds a string). */
function settingsSame(left, right) {
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right)
  return String(left ?? '') === String(right ?? '')
}

/** Draft (UI values) → the patch the host accepts. Only live-json allow-listed keys are ever sent. */
function settingsPatchOf(group, draft) {
  const patch = {}
  if (!draft) return patch
  if (group === 'source') {
    if ('enabled' in draft) patch.enabled = draft.enabled === true
    if ('pollSeconds' in draft) patch.pollSeconds = Number(draft.pollSeconds)
    if ('octo.allowAnyHuman' in draft) patch['octo.allowAnyHuman'] = draft['octo.allowAnyHuman'] === true
  } else if (group === 'run' || group === 'write') {
    // `run` and `write` are two views of the same executor block: the union below patches every draft key either group
    // can hold, so a field moved between the two groups keeps saving through the same `executor.*` allow-list.
    for (const key of ['executor.enabled', 'executor.autoRun', 'executor.allowPush', 'executor.allowMerge', 'executor.allowReply']) {
      if (key in draft) patch[key] = draft[key] === true
    }
    if ('paused' in draft) patch.paused = draft.paused === true
    if ('gitlab.createMr' in draft) patch['gitlab.createMr'] = draft['gitlab.createMr']
    for (const key of ['executor.workerBackend', 'executor.workerModel', 'executor.workerCommand']) {
      if (key in draft) patch[key] = draft[key]
    }
  }
  return patch
}

/** Human text for the host error codes the poll endpoint reports; unknown codes stay raw in the folded detail. */
function settingsHostError(t, code) {
  const text = String(code ?? '')
  if (!text) return undefined
  if (/paused/i.test(text)) return pt(t, 'st.errPaused')
  if (/not found|不存在/i.test(text)) return pt(t, 'st.errNoConfig')
  if (/enabled *= *false|disabled/i.test(text)) return pt(t, 'st.errDisabled')
  if (/Octo token/i.test(text)) return pt(t, 'st.errNoToken')
  if (/allowSenderIds|allowAnyHuman/i.test(text)) return pt(t, 'st.errNoSender')
  return undefined
}

/** Save failures: 409 conflicts and lost connections get a human reason; everything else keeps the host message. */
function settingsSaveFailure(t, failure) {
  const status = failure?.status
  if (status === 409) return { error: new Error(t('settingsConflict')), raw: errorText(failure) }
  if (status === 0) return { error: new Error(t('offline')), raw: errorText(failure) }
  return { error: failure instanceof Error ? failure : new Error(errorText(failure)) }
}

/** Poll (dry run) result → one status line. */
function settingsProbeView(t, result) {
  if (!result) return undefined
  if (result.skipped === 'busy') return { state: 'warning', text: pt(t, 'st.errBusy') }
  if (result.error) {
    const mapped = settingsHostError(t, result.error)
    return { state: 'error', text: mapped ?? pt(t, 'st.probeFailed'), raw: mapped ? String(result.error) : undefined }
  }
  const fetched = Number(result.fetched ?? 0)
  return { state: fetched ? 'done' : 'idle', text: pt(t, 'st.probeSummary', {
    accepted: Array.isArray(result.accepted) ? result.accepted.length : 0,
    ignored: Array.isArray(result.ignored) ? result.ignored.length : 0 }) }
}

/** UAT check result → one status line. */
function settingsUatView(t, uat) {
  if (!uat) return undefined
  if (uat.ok) return { state: 'done', text: `${pt(t, 'st.uatOk')} · ${pt(t, 'st.httpStatus', { status: uat.status })}` }
  if (/uatUrl is not configured/i.test(String(uat.error ?? ''))) return { state: 'warning', text: pt(t, 'st.uatUnset') }
  const status = uat.status ? ` · ${pt(t, 'st.httpStatus', { status: uat.status })}` : ''
  return { state: 'error', text: `${pt(t, 'st.uatFail')}${status}`, raw: uat.error ? String(uat.error) : undefined }
}

/** One switch row of a group form: label (+ optional badge and info tip) and explanatory hint on the left, the switch
    on the right. `badge`/`tip` are optional, so the plain rows keep the original single-line label. */
function SettingsSwitchRow({ label, hint, badge, tip, tipWarn, checked, disabled, onChange }) {
  return h('div', { className: 'sa-switch-row' },
    h('div', { className: 'sa-switch-row-text' },
      h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 'var(--sa-sp-8)', flexWrap: 'wrap' } },
        label,
        badge ?? null,
        tip ? h(InfoTip, { text: tip, warn: tipWarn === true }) : null),
      hint ? h(Hint, null, hint) : null),
    h(Switch, { checked: Boolean(checked), label, disabled, onChange }))
}

/** Result line for a one-shot action; the raw error is folded, never a bare stack. */
function SettingsStatusLine({ view, note }) {
  const { t } = usePanel()
  if (!view) return null
  return h('div', { className: 'sa-actions', style: { flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--sa-sp-4)' } },
    h(StatusText, { state: view.state }, view.text),
    note ? h('span', { className: 'sa-hint' }, note) : null,
    view.raw ? h(Folded, { summary: t('rawError') }, h('pre', { className: 'sa-pre' }, view.raw)) : null)
}

/** Gate codes render through the shared gate labels when they are known, and stay raw when they are not. */
function settingsGateLabel(t, gate) {
  const key = `gate.${gate}`
  const label = pt(t, key)
  return label === key ? String(gate) : label
}

/** Gate names use the shared gate dictionary when known; unknown gates stay raw so operators can see them. */
function repoGateLabel(t, gate) {
  const key = `gate.${gate}`
  const label = pt(t, key)
  return label === key ? String(gate) : label
}

/** One repository card: read-only facts plus its own write-only token editor. Saving a token is the reversible edit;
    clearing one stops what the executor can observe for this repository, so it goes through a confirmation that names
    the consequence (C6) — a plain button here used to clear on a single click. */
function ReposCard({ repo, isDefault, onSaveToken, tokenBusy }) {
  const { t } = usePanel()
  const [token, setToken] = useState('')
  const gates = Array.isArray(repo.gates) ? repo.gates : []
  const rows = [
    [pt(t, 'repo.project'), repo.project ? h('span', { className: 'sa-mono' }, String(repo.project)) : t('empty')],
    [pt(t, 'repo.baseUrl'), repo.baseUrl ? h('span', { className: 'sa-mono' }, String(repo.baseUrl)) : t('empty')],
    [pt(t, 'repo.localPath'), repo.repo ? h('span', { className: 'sa-mono' }, String(repo.repo)) : t('empty')],
    [pt(t, 'repo.branches'), `${repo.baseBranch ?? t('empty')} → ${repo.targetBranch ?? t('empty')}`],
    [pt(t, 'repos.gates'), gates.length ? gates.map(gate => repoGateLabel(t, gate)).join(t('listSeparator')) : pt(t, 'repos.gatesEmpty')],
    [pt(t, 'repo.verifyMode'), repoVerifyModeText(t, repo.verifyMode)],
    [pt(t, 'repo.acceptance'), repoAcceptanceText(t, repo.acceptance)],
  ]
  return h('div', { className: 'sa-card' },
    h('div', { className: 'sa-card-head' },
      h('span', { className: 'sa-section-icon' }, h(Icon, { name: 'pull', size: 16 })),
      h('span', { className: 'sa-card-title' }, repo.name ?? repo.id),
      isDefault ? h(Tag, { tone: 'quiet' }, pt(t, 'repo.default')) : null,
      h(Tag, { tone: repo.tokenConfigured ? 'outline' : 'warning' },
        repo.tokenConfigured ? pt(t, 'repo.tokenConfigured') : pt(t, 'repo.tokenMissing')),
      repo.name && repo.id && repo.name !== repo.id
        ? h('span', { className: 'sa-mono sa-hint' }, String(repo.id)) : null),
    h(KeyValues, { rows }),
    h('div', { className: 'sa-field', style: { marginTop: 'var(--sa-sp-8)' } },
      h('span', { className: 'sa-field-head' }, pt(t, 'repo.token')),
      h('div', { style: { display: 'flex', width: '100%', minWidth: 0 } },
        h(Input, { type: 'password', autoComplete: 'new-password', value: token, disabled: tokenBusy, className: 'sa-input-full',
          placeholder: pt(t, 'repos.tokenPlaceholder'), 'aria-label': pt(t, 'repos.tokenPlaceholder'),
          onChange: event => setToken(event.target.value) })),
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'shield', size: 14 }),
          disabled: tokenBusy || !token.trim(),
          onClick: () => { void Promise.resolve(onSaveToken?.(repo, token.trim())).then(saved => { if (saved) setToken('') }) } },
        pt(t, 'repos.tokenSave')),
        repo.tokenConfigured
          // Cancel sends nothing: ConfirmButton only calls onConfirm from the dialog's own 确定 button.
          ? h(ConfirmButton, { label: pt(t, 'repos.tokenClear'), title: pt(t, 'repos.tokenClearTitle'),
            message: pt(t, 'repos.tokenClearMessage'),
            onConfirm: async () => {
              if (tokenBusy) return
              const cleared = await onSaveToken?.(repo, '')
              if (cleared !== false) setToken('')
            } })
          : null),
      h(Hint, null, pt(t, 'repos.tokenHint'))))
}

function LiveSettingsPage() {
  const { t, notify } = usePanel()
  const { data, error, reload, actions } = usePanelData()
  const [active, setActive] = useState('source')
  const [drafts, setDrafts] = useState({})
  const [savingGroup, setSavingGroup] = useState(null)
  const [saveErrors, setSaveErrors] = useState({})
  const [savedTimes, setSavedTimes] = useState({})
  const savedTimers = useRef({})
  const [reloadState, setReloadState] = useState({ busy: false })
  const [probe, setProbe] = useState({ busy: false })
  const [uatState, setUatState] = useState({ busy: false })
  const [tokenSaving, setTokenSaving] = useState(null)
  const [bindingForm, setBindingForm] = useState({ chatId: '', title: '', repoId: '' })
  const [bindingBusy, setBindingBusy] = useState(false)
  useEffect(() => () => {
    for (const timer of Object.values(savedTimers.current)) clearTimeout(timer)
  }, [])
  if (!data) {
    return error ? h(ErrorState, { error, onRetry: () => { void reload() } }) : h(Skeleton, { rows: 6 })
  }
  const config = data.config ?? {}
  const octo = config.octo ?? {}
  const gitlab = config.gitlab ?? {}
  const executor = config.executor ?? {}
  const engine = data.engine ?? {}
  // Multi-repository execution surface (contract §12): the repository list, its cards/tokens and the binding picker;
  // the manual Ticket picker itself lives in the shared ManualTicketForm, which reads `panelRepos` / `panelDefaultRepo`.
  const repos = panelRepos(data)
  const defaultRepoId = panelDefaultRepo(data)
  const repoOptions = repos.map(repo => ({ value: repo.id, label: repo.name ?? repo.id }))
  const defaultRepoName = repos.find(repo => repo.id === defaultRepoId)?.name ?? defaultRepoId

  /** Save (or clear) one repository's GitLab token; the value never comes back from the host. */
  const saveRepoTokenFor = async (repo, token) => {
    setTokenSaving(repo.id)
    try {
      await actions.saveRepoToken(repo.id, token)
      await reload()
      notify(pt(t, token ? 'repos.tokenSaved' : 'repos.tokenCleared', { name: repo.name ?? repo.id }))
      return true
    } catch (failure) {
      notify(errorText(failure))
      return false
    } finally { setTokenSaving(null) }
  }

  // ---- group heading (O18) ----------------------------------------------------------------------------------
  // Each content group opens with a real H2 mirroring its left-nav label; `.sa-settings-title` owns the typography
  // (05-style.js), so the element here carries no inline styles.
  const activeGroup = SETTINGS_GROUPS.find(group => group.id === active) ?? SETTINGS_GROUPS[0]
  const settingsHeading = () => h('h2', { className: 'sa-settings-title' }, pt(t, activeGroup.labelKey))

  // ---- repositories group: repository cards + tokens, then the read-only deployment section -------------------
  // Deployment used to be its own group; it describes the same GitLab target and worktree as these repositories, so it
  // lives here as a read-only sub-section instead of owning a seventh navigation entry.
  const renderRepos = () => {
    const deployRows = [
      [pt(t, 'st.configFile'), h('span', { className: 'sa-mono' }, config.file ?? t('empty'))],
      [pt(t, 'st.configExists'), config.exists ? pt(t, 'st.fileExists') : pt(t, 'st.fileMissing')],
      [pt(t, 'st.gitlabProject'), gitlab.project ? h('span', { className: 'sa-mono' }, gitlab.project) : t('empty')],
      [pt(t, 'st.gitlabBase'), gitlab.baseUrl ? h(ExternalLink, { href: gitlab.baseUrl, icon: null }, gitlab.baseUrl) : t('empty')],
      [pt(t, 'st.branches'), `${config.baseBranch ?? t('empty')} → ${gitlab.targetBranch ?? t('empty')}`],
      [pt(t, 'st.uatUrl'), gitlab.uatUrl ? h(ExternalLink, { href: gitlab.uatUrl, icon: null }, gitlab.uatUrl) : t('empty')],
      [pt(t, 'st.healthUrl'), gitlab.healthUrl ? h(ExternalLink, { href: gitlab.healthUrl, icon: null }, gitlab.healthUrl) : t('empty')],
      [pt(t, 'st.gitlabToken'), gitlab.tokenConfigured ? pt(t, 'st.tokenOk') : pt(t, 'st.tokenMissing')],
      [pt(t, 'st.worktreeRoot'), config.worktreeRoot ? h('span', { className: 'sa-mono' }, config.worktreeRoot) : t('empty')],
    ]
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'repos.intro')),
      repos.length
        ? h(Fragment, null,
          h('p', { className: 'sa-hint', role: 'status' }, pt(t, 'repos.summary', { count: repos.length, default: defaultRepoName })),
          h('div', { className: 'sa-cards-2' }, repos.map(repo => h(ReposCard, { key: repo.id, repo,
            isDefault: repo.id === defaultRepoId, onSaveToken: saveRepoTokenFor, tokenBusy: tokenSaving === repo.id }))))
        : h(EmptyState, { icon: 'pull', title: pt(t, 'repos.empty') }),
      h('p', { className: 'sa-hint' }, pt(t, 'repos.manageHint')),
      h('h3', { className: 'sa-ledger-title' }, pt(t, 'st.deployTitle')),
      h(Hint, null, pt(t, 'st.deployHint')),
      config.error ? h('p', { className: 'sa-banner sa-danger' }, `${pt(t, 'st.configError')}${config.error}`) : null,
      h(KeyValues, { rows: deployRows }),
      h(Hint, null, pt(t, 'st.reloadHint')),
      h('div', { className: 'sa-actions' },
        reloadButton(),
        h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'external', size: 14 }), disabled: uatState.busy,
          onClick: () => { void runUat() } }, pt(t, 'st.checkUat'))),
      h(SettingsStatusLine, { view: reloadView }),
      h(SettingsStatusLine, { view: uatState.view }))
  }

  /** Rewrite the whole group→repository map (host validates consistency) and refresh the model. */
  const applyBindings = async (watched, titles, bindings) => {
    setBindingBusy(true)
    try {
      await actions.patchSettings({ 'octo.watchChatIds': watched, 'octo.chatTitles': titles, 'octo.chatRepos': bindings })
      await reload()
      notify(pt(t, 'st.bindingSaved'))
      return true
    } catch (failure) {
      notify(errorText(failure))
      return false
    } finally { setBindingBusy(false) }
  }
  const closeBindingForm = () => setBindingForm({ chatId: '', title: '', repoId: '' })
  const onAddBinding = async () => {
    const chatId = bindingForm.chatId.trim()
    if (!chatId) { notify(pt(t, 'st.bindingChatRequired')); return }
    const repoId = bindingForm.repoId || defaultRepoId
    const watched = [...new Set([...(octo.watchChatIds ?? []), chatId])]
    const titles = { ...(octo.chatTitles ?? {}), ...bindingForm.title.trim() ? { [chatId]: bindingForm.title.trim() } : {} }
    const bindings = { ...(octo.chatRepos ?? {}), [chatId]: repoId }
    if (await applyBindings(watched, titles, bindings)) closeBindingForm()
  }
  const dirtyOf = group => Boolean(drafts[group] && Object.keys(drafts[group]).length)
  const dirtyGroups = new Set(SETTINGS_GROUPS.map(group => group.id).filter(dirtyOf))

  /** Move one field into (or back out of) the group draft; editing clears a shown save failure for that group. */
  const editField = (group, key, value, initial) => {
    setSaveErrors(previous => settingsOmit(previous, group))
    setDrafts(previous => {
      const next = { ...(previous[group] ?? {}) }
      if (settingsSame(value, initial)) delete next[key]
      else next[key] = value
      return Object.keys(next).length ? { ...previous, [group]: next } : settingsOmit(previous, group)
    })
  }

  const discardGroup = group => {
    clearTimeout(savedTimers.current[group])
    delete savedTimers.current[group]
    setDrafts(previous => settingsOmit(previous, group))
    setSaveErrors(previous => settingsOmit(previous, group))
    setSavedTimes(previous => settingsOmit(previous, group))
  }

  /** Save one group: patch → model reload → 3s "saved" state; failures keep the draft for a retry. */
  const saveGroup = async group => {
    const draft = drafts[group]
    if (!draft || !Object.keys(draft).length || savingGroup) return
    const patch = settingsPatchOf(group, draft)
    if ('pollSeconds' in patch && (!Number.isFinite(patch.pollSeconds) || patch.pollSeconds < 2)) {
      setSaveErrors(previous => ({ ...previous, [group]: { error: new Error(pt(t, 'st.pollInvalid')) } }))
      return
    }
    setSavingGroup(group)
    setSaveErrors(previous => settingsOmit(previous, group))
    clearTimeout(savedTimers.current[group])
    delete savedTimers.current[group]
    setSavedTimes(previous => settingsOmit(previous, group))
    try {
      await actions.patchSettings(patch)
      await reload()
      setDrafts(previous => settingsOmit(previous, group))
      setSavedTimes(previous => ({ ...previous, [group]: new Date().toISOString() }))
      savedTimers.current[group] = setTimeout(() => {
        delete savedTimers.current[group]
        setSavedTimes(previous => settingsOmit(previous, group))
      }, 3000)
    } catch (failure) {
      setSaveErrors(previous => ({ ...previous, [group]: settingsSaveFailure(t, failure) }))
    } finally {
      setSavingGroup(current => current === group ? null : current)
    }
  }

  /** Conflict recovery: re-read live.json, refresh the model and drop the stale draft. */
  const recoverGroup = async group => {
    if (savingGroup) return
    setSavingGroup(group)
    try {
      await actions.reloadConfig()
      await reload()
      discardGroup(group)
    } catch (failure) {
      setSaveErrors(previous => ({ ...previous, [group]: settingsSaveFailure(t, failure) }))
    } finally {
      setSavingGroup(current => current === group ? null : current)
    }
  }

  const reloadEngineConfig = async () => {
    if (reloadState.busy) return
    setReloadState({ busy: true })
    try {
      await actions.reloadConfig()
      await reload()
      setReloadState({ busy: false, at: new Date().toISOString() })
    } catch (failure) {
      setReloadState({ busy: false, error: failure })
    }
  }

  const runProbe = async () => {
    if (probe.busy) return
    setProbe({ busy: true })
    try {
      const result = await actions.poll({ dryRun: true })
      await reload()
      setProbe({ busy: false, at: new Date().toISOString(), view: settingsProbeView(t, result) })
    } catch (failure) {
      setProbe({ busy: false, view: { state: 'error', text: pt(t, 'st.probeFailed'), raw: errorText(failure) } })
    }
  }

  const runUat = async () => {
    if (uatState.busy) return
    setUatState({ busy: true })
    try {
      const uat = await actions.checkUat()
      setUatState({ busy: false, view: settingsUatView(t, uat) })
    } catch (failure) {
      setUatState({ busy: false, view: { state: 'error', text: pt(t, 'st.uatFail'), raw: errorText(failure) } })
    }
  }

  const reloadView = reloadState.error
    ? { state: 'error', text: pt(t, 'st.reloadFailed'), raw: errorText(reloadState.error) }
    : reloadState.at ? { state: 'done', text: pt(t, 'st.reloadedAt', { time: hhmmss(reloadState.at, t.lang) }) } : undefined

  /** The group save bar; nothing renders while the group is clean and no save has happened. */
  const saveBarFor = group => {
    // Read-only groups own no draft: never render a save bar for them, even if a draft were somehow left behind.
    if (!SETTINGS_SAVEABLE.includes(group)) return null
    const stored = saveErrors[group]
    const savedAt = savedTimes[group]
    const state = savingGroup === group ? 'saving' : stored ? 'error' : dirtyOf(group) ? 'dirty' : savedAt ? 'saved' : 'idle'
    if (state === 'idle') return null
    return h(Fragment, null,
      h(SaveBar, { state, savedAt, error: stored?.error, dirty: dirtyOf(group),
        onSave: () => { void saveGroup(group) },
        onRetry: () => { void saveGroup(group) },
        onDiscard: () => discardGroup(group) }),
      stored ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-8)' } },
        h('div', { className: 'sa-actions' },
          h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'refresh', size: 14 }),
            disabled: savingGroup === group, onClick: () => { void recoverGroup(group) } }, pt(t, 'st.reloadConfig'))),
        stored.raw ? h(Folded, { summary: t('rawError') }, h('pre', { className: 'sa-pre' }, stored.raw)) : null) : null)
  }

  const reloadButton = () => h(Button, { variant: 'ghost', size: 'sm', icon: h(Icon, { name: 'refresh', size: 14 }),
    disabled: reloadState.busy, onClick: () => { void reloadEngineConfig() } }, pt(t, 'st.reloadConfig'))

  // ---- source group -----------------------------------------------------------------------------------------
  const renderSource = () => {
    const draft = drafts.source ?? {}
    const enabled = 'enabled' in draft ? draft.enabled : config.enabled === true
    const allowAnyHuman = 'octo.allowAnyHuman' in draft ? draft['octo.allowAnyHuman'] : octo.allowAnyHuman === true
    const pollSeconds = 'pollSeconds' in draft ? draft.pollSeconds : String(config.pollSeconds ?? '')
    const chatIds = Array.isArray(octo.watchChatIds) ? octo.watchChatIds : []
    const chatNames = chatIds.map(id => octo.chatTitles?.[id] ?? id)
    const senders = Array.isArray(octo.allowSenderIds) ? octo.allowSenderIds : []
    const cursors = engine.channelCursors ?? {}
    const cursorRows = Object.entries(cursors).map(([chat, seq]) => `${octo.chatTitles?.[chat] ?? chat} · ${seq}`)
    const rows = [
      [pt(t, 'st.watchChats'), chatNames.length ? chatNames.join(t('listSeparator')) : t('empty')],
      [pt(t, 'st.senders'), allowAnyHuman ? pt(t, 'st.allHumans')
        : (senders.length ? senders.join(t('listSeparator')) : t('empty'))],
      [pt(t, 'st.octoToken'), octo.tokenConfigured ? pt(t, 'st.tokenOk') : pt(t, 'st.tokenMissing')],
      [pt(t, 'st.cursors'), cursorRows.length ? cursorRows.join(t('listSeparator')) : t('empty')],
      [pt(t, 'st.lastPoll'), engine.lastPollAt ? h(When, { at: engine.lastPollAt }) : t('empty')],
    ]
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.sourceHint')),
      h(SettingsSwitchRow, { label: pt(t, 'st.enabled'), hint: pt(t, 'st.enabledHint'), checked: enabled,
        disabled: savingGroup === 'source',
        onChange: next => editField('source', 'enabled', next, config.enabled === true) }),
      h(SettingsSwitchRow, { label: pt(t, 'st.allowAnyHuman'), hint: pt(t, 'st.allowAnyHumanHint'), checked: allowAnyHuman,
        disabled: savingGroup === 'source',
        onChange: next => editField('source', 'octo.allowAnyHuman', next, octo.allowAnyHuman === true) }),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.pollSeconds')),
        // The Input `style` reaches the inner <input>; the wrapper makes the bordered box itself 420px (critique §18).
        h('div', { style: { display: 'flex', maxWidth: '420px', minWidth: 0 } },
          h(Input, { type: 'number', min: 2, step: 1, value: pollSeconds, style: { maxWidth: '420px' },
            disabled: savingGroup === 'source', 'aria-label': pt(t, 'st.pollSeconds'),
            onChange: event => editField('source', 'pollSeconds', event.target.value, String(config.pollSeconds ?? '')) })),
        h(Hint, null, pt(t, 'st.pollSecondsHint'))),
      h(KeyValues, { rows }),
      !allowAnyHuman && !senders.length ? h('p', { className: 'sa-banner' }, pt(t, 'st.noSenders')) : null,
      chatNames.length ? null : h(Hint, null, pt(t, 'st.noChats')),
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'message', size: 14 }), disabled: probe.busy,
          onClick: () => { void runProbe() } }, pt(t, 'actions.checkNow')),
        reloadButton()),
      h(Hint, null, pt(t, 'st.probeHint')),
      h(SettingsStatusLine, { view: probe.view,
        note: probe.at ? pt(t, 'st.probeAt', { time: hhmmss(probe.at, t.lang) }) : undefined }),
      h(SettingsStatusLine, { view: reloadView }),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.bindings')),
        h(Hint, null, pt(t, 'st.bindingsHint')),
        chatIds.length
          ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-8)' } },
            chatIds.map(chatId => h('div', { key: chatId, className: 'sa-switch-row' },
              h('div', { className: 'sa-switch-row-text' },
                h('span', null, octo.chatTitles?.[chatId] ?? chatId),
                h('span', { className: 'sa-mono sa-hint' }, String(chatId))),
              // The control row never wraps: the repository select and its 移除 button stay on one line (critique §27).
              h('div', { className: 'sa-actions', style: { flexWrap: 'nowrap', minWidth: 0 } },
                h('div', { style: { flex: '0 1 240px', minWidth: 0 } },
                  h(Select, { label: pt(t, 'st.bindingRepo'), value: octo.chatRepos?.[chatId] ?? defaultRepoId,
                    options: repoOptions, disabled: bindingBusy,
                    onChange: next => { void applyBindings(chatIds, octo.chatTitles ?? {}, { ...(octo.chatRepos ?? {}), [chatId]: next }) } })),
                h(Button, { variant: 'ghost', size: 'sm', style: { flex: '0 0 auto' }, disabled: bindingBusy,
                  onClick: () => {
                    const titles = settingsOmit(octo.chatTitles ?? {}, chatId)
                    const bindings = settingsOmit(octo.chatRepos ?? {}, chatId)
                    void applyBindings(chatIds.filter(item => item !== chatId), titles, bindings)
                  } }, pt(t, 'st.bindingRemove'))))))
          : h(Hint, null, pt(t, 'st.bindingEmpty')),
        h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-4)' } },
          h(Input, { value: bindingForm.chatId, placeholder: pt(t, 'st.bindingChat'), 'aria-label': pt(t, 'st.bindingChat'),
            disabled: bindingBusy, onChange: event => setBindingForm(previous => ({ ...previous, chatId: event.target.value })) }),
          h(Input, { value: bindingForm.title, placeholder: pt(t, 'st.bindingTitle'), 'aria-label': pt(t, 'st.bindingTitle'),
            disabled: bindingBusy, onChange: event => setBindingForm(previous => ({ ...previous, title: event.target.value })) }),
          h(Select, { label: pt(t, 'st.bindingRepo'), value: bindingForm.repoId || defaultRepoId, options: repoOptions,
            disabled: bindingBusy, onChange: next => setBindingForm(previous => ({ ...previous, repoId: next })) }),
          h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'plus', size: 14 }),
            disabled: bindingBusy || !bindingForm.chatId.trim(), onClick: () => { void onAddBinding() } }, pt(t, 'st.bindingAdd')))),
      saveBarFor('source'))
  }

  // ---- eval group (read-only) -------------------------------------------------------------------------------
  const renderEval = () => {
    const mode = data.eval?.mode ?? config.eval?.mode
    const modeText = mode === 'rules' ? pt(t, 'st.modeRules')
      : mode === 'llm' ? pt(t, 'st.modeLlm') : mode ? pt(t, 'st.modeUnknown', { mode }) : t('empty')
    const rules = Array.isArray(data.eval?.rules) ? data.eval.rules : []
    const rows = [
      [pt(t, 'st.evalMode'), modeText],
      [pt(t, 'st.decisionsTotal'), String(data.counts?.decisions ?? 0)],
      [pt(t, 'st.decisions24h'), String(data.flow24h?.judged ?? 0)],
    ]
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.evalHint')),
      h(KeyValues, { rows }),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.rules')),
        rules.length
          ? h(KeyValues, { rows: rules.map(rule => [`${rule.id} · ${rule.name}`, rule.description]) })
          : h(Hint, null, pt(t, 'st.noRules'))))
  }

  // ---- run group: the executor master switch, how it runs, worker backend and the manual ticket form ---------
  const renderRun = () => {
    const draft = drafts.run ?? {}
    const field = (key, fallback) => key in draft ? draft[key] : fallback
    const frozen = savingGroup === 'run'
    const gates = Array.isArray(executor.gates) ? executor.gates : []
    const gateText = gates.length ? gates.map(gate => settingsGateLabel(t, gate)).join(t('listSeparator')) : t('empty')
    const timeout = Number(executor.timeoutMs)
    const rows = [
      [pt(t, 'st.gates'), gateText],
      [pt(t, 'st.timeout'), Number.isFinite(timeout) ? pt(t, 'st.minutes', { count: Math.round(timeout / 60000) }) : t('empty')],
      [pt(t, 'st.repo'), config.repo ? h('span', { className: 'sa-mono' }, config.repo) : t('empty')],
      [pt(t, 'st.worktreeRoot'), config.worktreeRoot ? h('span', { className: 'sa-mono' }, config.worktreeRoot) : t('empty')],
    ]
    const switchRow = (key, labelKey, hintKey, initial) => h(SettingsSwitchRow, {
      label: pt(t, labelKey), hint: pt(t, hintKey), checked: Boolean(field(key, initial)),
      disabled: frozen,
      onChange: next => editField('run', key, next, initial) })
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.runHint')),
      switchRow('executor.enabled', 'st.execEnabled', 'st.execEnabledHint', executor.enabled === true),
      switchRow('executor.autoRun', 'st.autoRun', 'st.autoRunHint', executor.autoRun === true),
      switchRow('paused', 'st.paused', 'st.pausedHint', config.paused === true || data.paused === true),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.mrMode')),
        h(Select, { label: pt(t, 'st.mrMode'), disabled: frozen,
          value: field('gitlab.createMr', gitlab.createMr === 'push' ? 'push' : 'api'),
          options: [{ value: 'api', label: pt(t, 'st.mrModeApi') }, { value: 'push', label: pt(t, 'st.mrModePush') }],
          onChange: next => editField('run', 'gitlab.createMr', next, gitlab.createMr === 'push' ? 'push' : 'api') }),
        h(Hint, null, pt(t, 'st.mrModeHint'))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.workerBackend')),
        h(Select, { label: pt(t, 'st.workerBackend'), disabled: frozen,
          value: field('executor.workerBackend', executor.workerBackend ?? 'dsh'),
          options: [{ value: 'dsh', label: pt(t, 'st.workerDsh') }, { value: 'codex', label: pt(t, 'st.workerCodex') },
            { value: 'claude', label: pt(t, 'st.workerClaude') }],
          onChange: next => editField('run', 'executor.workerBackend', next, executor.workerBackend ?? 'dsh') }),
        h(Hint, null, pt(t, 'st.workerBackendHint'))),
      field('executor.workerBackend', executor.workerBackend ?? 'dsh') === 'dsh'
        ? h(Hint, null, pt(t, 'st.workerDshHint'))
        : h(Fragment, null,
          h('div', { className: 'sa-field' },
            h('span', { className: 'sa-field-head' }, pt(t, 'st.workerModel')),
            h('div', { style: { display: 'flex', maxWidth: '420px', minWidth: 0 } },
              h(Input, { value: field('executor.workerModel', executor.workerModel ?? ''), disabled: frozen,
                placeholder: pt(t, 'st.workerModel'), 'aria-label': pt(t, 'st.workerModel'),
                onChange: event => editField('run', 'executor.workerModel', event.target.value, executor.workerModel ?? '') })),
            h(Hint, null, pt(t, 'st.workerModelHint'))),
          h('div', { className: 'sa-field' },
            h('span', { className: 'sa-field-head' }, pt(t, 'st.workerCommand')),
            h('div', { style: { display: 'flex', maxWidth: '420px', minWidth: 0 } },
              h(Input, { value: field('executor.workerCommand', executor.workerCommand ?? ''), disabled: frozen,
                placeholder: field('executor.workerBackend', executor.workerBackend ?? 'dsh') === 'codex'
                  ? '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex' : 'claude',
                'aria-label': pt(t, 'st.workerCommand'),
                onChange: event => editField('run', 'executor.workerCommand', event.target.value, executor.workerCommand ?? '') })),
            h(Hint, null, pt(t, 'st.workerCommandHint'))),
          h(Hint, null, pt(t, field('executor.workerBackend', executor.workerBackend ?? 'dsh') === 'codex'
            ? 'st.workerCodexHint' : 'st.workerClaudeHint'))),
      h(KeyValues, { rows }),
      // The manual Ticket form is the same component the Execution page opens in its dialog (34-live-ui.js): one set
      // of fields, one write path, one success/error treatment. The inline form resets itself after each creation.
      h(ManualTicketForm, { onDone: () => { void reload() } }),
      saveBarFor('run'))
  }

  // ---- write-permission group: the three things the executor may write, with the high-risk merge called out ------
  const renderWrite = () => {
    const draft = drafts.write ?? {}
    const field = (key, fallback) => key in draft ? draft[key] : fallback
    const frozen = savingGroup === 'write'
    const token = gitlab.tokenConfigured === true
    const allowMerge = Boolean(field('executor.allowMerge', executor.allowMerge === true))
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.writeHint')),
      h(SettingsSwitchRow, { label: pt(t, 'st.allowPush'), hint: pt(t, 'st.allowPushHint'), disabled: frozen,
        checked: Boolean(field('executor.allowPush', executor.allowPush === true)),
        onChange: next => editField('write', 'executor.allowPush', next, executor.allowPush === true) }),
      h(SettingsSwitchRow, { label: pt(t, 'st.allowReply'), hint: pt(t, 'st.allowReplyHint'), disabled: frozen,
        checked: Boolean(field('executor.allowReply', executor.allowReply === true)),
        onChange: next => editField('write', 'executor.allowReply', next, executor.allowReply === true) }),
      // The one irreversible permission: a warning tag, a warn-styled info tip and — while it is on — a standing
      // warning line. Saving still goes through the ordinary save bar; this is emphasis, not a second confirmation.
      h(SettingsSwitchRow, { label: pt(t, 'st.allowMerge'),
        hint: pt(t, token ? 'st.allowMergeHint' : 'st.allowMergeNoToken'),
        badge: h(Tag, { tone: 'warning' }, pt(t, 'st.highRisk')),
        tip: pt(t, 'st.allowMergeRisk'), tipWarn: true,
        checked: allowMerge, disabled: frozen || !token,
        onChange: next => editField('write', 'executor.allowMerge', next, executor.allowMerge === true) }),
      allowMerge ? h('p', { className: 'sa-banner' }, pt(t, 'st.allowMergeOn')) : null,
      saveBarFor('write'))
  }

  // ---- prompt group (read-only) -----------------------------------------------------------------------------
  const renderPrompt = () => {
    const brief = String(data.prompts?.workerBrief ?? '')
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      // One sentence per fact: briefNote explains the raw value below, briefBuiltIn says built-in prompts ship with code.
      h(Hint, null, pt(t, 'st.briefNote')),
      brief
        ? h(RawValue, { label: pt(t, 'st.briefLabel'), text: brief })
        : h(EmptyState, { icon: 'inbox', title: pt(t, 'st.briefEmpty'), hint: pt(t, 'st.briefEmptyHint') }),
      h(Hint, null, pt(t, 'st.briefBuiltIn')))
  }

  const renderGroup = () => {
    if (active === 'eval') return renderEval()
    if (active === 'run') return renderRun()
    if (active === 'write') return renderWrite()
    if (active === 'repos') return renderRepos()
    if (active === 'prompt') return renderPrompt()
    return renderSource()
  }

  // The rail promises what can be changed first: writable groups, then a divider + "参考" label + the read-only groups.
  // `data-reference` is the hook 05-style.js de-emphasises them with; the button keeps its usual label and dirty dot.
  const settingsNavButton = group => h('button', { key: group.id, type: 'button',
    className: 'sa-settings-group', 'aria-current': active === group.id ? 'true' : undefined,
    'data-reference': group.reference ? 'true' : undefined,
    // The title is always present (what the button opens) and only gains the dirty suffix while the draft is unsaved.
    title: dirtyGroups.has(group.id) ? `${pt(t, group.labelKey)} · ${pt(t, 'st.unsaved')}` : pt(t, group.labelKey),
    onClick: () => setActive(group.id) },
    h(Icon, { name: group.icon, size: 14 }),
    h('span', { style: { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } },
      pt(t, group.labelKey)),
    dirtyGroups.has(group.id)
      ? h('span', { className: 'sa-count', style: { marginLeft: 'auto', color: 'var(--dsw-alias-state-warn-primary)' },
        'aria-hidden': 'true' }, '●')
      : null)
  const writableGroups = SETTINGS_GROUPS.filter(group => !group.reference)
  const referenceGroups = SETTINGS_GROUPS.filter(group => group.reference)

  return h(Fragment, null,
    h(Hint, null, pt(t, 'st.pageIntro')),
    h('div', { className: 'sa-settings' },
      h('nav', { className: 'sa-settings-nav', 'aria-label': pt(t, 'st.navLabel') },
        writableGroups.map(settingsNavButton),
        referenceGroups.length
          ? h(Fragment, null,
            h('div', { className: 'sa-settings-nav-sep', 'aria-hidden': 'true' }),
            h('span', { className: 'sa-settings-nav-label' }, pt(t, 'st.reference')),
            referenceGroups.map(settingsNavButton))
          : null),
      h('div', { className: 'sa-settings-body' },
        error ? h(ErrorState, { error, onRetry: () => { void reload() } }) : null,
        renderGroup())))
}
