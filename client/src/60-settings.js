Object.assign(PAGE_TEXT, {
  'wf.title': ['分阶段执行', 'Staged execution'],
  'wf.off': ['关闭（沿用单 worker）', 'Off (single worker)'],
  'wf.auto': ['自动评估难度', 'Assess complexity automatically'],
  'wf.simple': ['直接实现', 'Direct implementation'],
  'wf.planned': ['Codex 规划与独立验收', 'Codex planning and independent review'],
  'wf.implementer': ['实现后端', 'Implementation backend'],
  'wf.reviewer': ['独立验收后端', 'Independent review backend'],
  'wf.reviewerHint': ['评估、规划与最终验收由它只读执行：Codex / Claude Code 的 CLI 会话，或 DSH 的独立只读会话。', 'Runs assessment, planning and the final review read-only: a Codex / Claude Code CLI session, or an independent read-only DSH session.'],
  'wf.workerPreset': ['Worker 预设（DSH）', 'Worker preset (DSH)'],
  'wf.workerPresetPlaceholder': ['standard / ptc / minimal / cordis（留空跟随默认）', 'standard / ptc / minimal / cordis (empty = host default)'],
  'wf.workerPresetHint': ['仅影响进程内 DSH worker；留空跟随宿主默认。发行版自带 standard / ptc / minimal / cordis（创造模式），live.json 里也可按仓库覆盖 repos[].workerPreset。',
    'Applies to the in-process DSH worker only; empty follows the host default. Shipped presets: standard / ptc / minimal / cordis (Creator); live.json can override per repository via repos[].workerPreset.'],
  'wf.hint': ['自动模式先由验收后端只读评估；复杂任务按 规划 → 实现 → 闸门 → 独立验收 执行。返工预算在「运行」里调。', 'Auto mode uses a read-only assessment by the review backend; complex tasks run planning, implementation, gates and independent review. The repair budget lives under Run.'],
  // ---- AC-01: routing preview and manual override on the create form ---------------------------------------------
  'st.routePreviewTitle': ['自动判断', 'Automatic routing'],
  'st.routeDeliverable': ['交付目标', 'Deliverable'],
  'st.routeBackend': ['执行后端', 'Backend'],
  'st.routeAuto': ['自动', 'Auto'],
  'st.routeChange': ['代码改动', 'Code change'],
  'st.routeReport': ['只读报告', 'Read-only report'],
  'st.routeCapabilities': ['所需能力', 'Capabilities'],
  'st.routeCapEdit': ['改文件', 'Edit files'],
  'st.routeCapExec': ['跑命令', 'Run commands'],
  'st.routeCapWeb': ['联网', 'Web access'],
  'st.routeCapReport': ['报告/提问', 'Report/questions'],
  'st.routeManualHint': ['人工选择会随工单保存并用于后续运行；能力上限仍然生效，不能把测试交给不会执行命令的后端。',
    'A manual choice is saved on the Ticket and used by later runs; capability limits still apply, so a backend that cannot run commands cannot take a verification Ticket.'],
  'st.routeUnsupported': ['当前后端缺少能力：{caps}', 'The chosen backend lacks: {caps}'],
  'st.routePreviewFailed': ['暂时无法预览路由，仍可直接创建。', 'Routing preview is unavailable; you can still create the Ticket.'],
})
/* LiveSettingsPage: live.json configuration in seven groups (contract §6.6). The left column switches groups and the
   right column edits one group at a time. What runs the work is split out of the executor groups: `run` owns how work
   runs, `worker` owns which backend executes it (and its capability matrix), and `write` owns what may be written — so
   a high-risk permission never sits beside an unrelated switch. Editable groups keep a group-local draft and save
   through `actions.patchSettings(patch)` followed by a model reload; read-only rows state where the value comes from
   (live.json / built-in prompts) and never render a fake switch. */

Object.assign(PAGE_TEXT, {
  'repos.intro': ['执行器使用的 GitLab 仓库：本地克隆、分支、闸门、验证与验收方式，以及每个仓库独立的 GitLab token。',
    'GitLab repositories used by the executor: local clone, branches, gates, verification and acceptance, plus one GitLab token per repository.'],
  'repos.summary': ['{count} 个仓库 · 默认仓库 {default}', '{count} repositories · default {default}'],
  'repos.empty': ['live.json 里还没有仓库；先用示例补一条仓库定义，再回到这里保存 token。',
    'No repository in live.json yet; add one from the example, then come back to save its token.'],
  'repos.emptyAction': ['查看示例', 'View example'],
  'repos.sampleTitle': ['仓库配置示例', 'Repository configuration example'],
  'repos.sampleHint': ['把绝对路径、GitLab 项目与 tokenFile 换成你的值；保存后点「重载配置」。token 值不要写在这里。',
    'Replace the absolute path, GitLab project and tokenFile with yours; save, then “Reload config”. Never put the token value here.'],
  'repos.sampleCopy': ['复制示例', 'Copy example'],

  // ---- P2-5: read-only worker backend capability matrix (static, mirrors the actual implementation) --------------
  'st.capTitle': ['运行后端能力', 'Worker capability matrix'],
  'st.capHint': ['当前实现能力，不是产品承诺；后端能力来自各自 CLI/宿主的实际实现，新增后端时需同步更新 README 与本表。',
    'What the current implementation can do — not a product promise. Capabilities come from each CLI/host implementation; update the README and this table when adding a backend.'],
  'st.capCurrent': ['当前', 'Current'],
  'st.capBackend': ['后端', 'Backend'],
  'st.capStream': ['流式事件', 'Streaming events'],
  'st.capApproval': ['工具调用审批', 'Tool-call approval'],
  'st.capResume': ['会话恢复', 'Session resume'],
  'st.capDiff': ['文件 diff', 'File diff'],
  'st.capReport': ['报告工具', 'Report tools'],
  'st.capYes': ['是', 'Yes'],
  'st.capNo': ['否', 'No'],
  'st.capDsh': ['DSH（进程内）', 'DSH (in-process)'],
  'st.capCodex': ['Codex CLI', 'Codex CLI'],
  'st.capClaude': ['Claude Code CLI', 'Claude Code CLI'],
  'st.capDshApproval': ['worker approval=never', 'worker approval=never'],
  'st.capDshResume': ['每个 run 新建 session', 'new session per run'],
  'st.capDshReport': ['P1 四个报告工具', 'P1 four report tools'],
  'st.capCodexStream': ['解析 codex --json', 'codex --json parsing'],
  'st.capCodexApproval': ['approval_policy=never', 'approval_policy=never'],
  'st.capCodexResume': ['--ephemeral', '--ephemeral'],
  'st.capClaudeStream': ['stream-json', 'stream-json'],
  'st.capClaudeApproval': ['permission-mode acceptEdits + 工具白名单', 'permission-mode acceptEdits + tool allow-list'],
  'st.capClaudeResume': ['-p 一次性会话', '-p one-shot session'],
  'st.capChangedPaths': ['git changedPaths', 'git changedPaths'],
  'repos.add': ['添加仓库', 'Add repository'],
  'repos.disabledTag': ['已停用', 'Disabled'],
  'repos.enable': ['启用仓库', 'Enable repository'],
  'repos.disable': ['停用仓库', 'Disable repository'],
  'repos.enableTitle': ['启用仓库 {name}？', 'Enable repository {name}?'],
  'repos.disableTitle': ['停用仓库 {name}？', 'Disable repository {name}?'],
  'repos.enableMessage': ['启用后该仓库重新接收新工单，并按闸门与验收设置执行。', 'When enabled, this repository takes new Tickets again under its gates and acceptance settings.'],
  'repos.disableMessage': ['停用后不再接收或派发新任务，历史记录保留；正在执行的任务不受影响。', 'When disabled, it takes no new work; history is kept and running work is unaffected.'],
  'repos.enableSaved': ['仓库 {name} 已启用。', 'Repository {name} enabled.'],
  'repos.disableSaved': ['仓库 {name} 已停用。', 'Repository {name} disabled.'],
  'repos.edit': ['编辑', 'Edit'],
  'repos.editTitle': ['编辑仓库 {name}', 'Edit repository {name}'],
  'repos.editHint': ['下面显示当前值：保存前先核对路径与闸门命令；停用后不再接收或派发新任务，历史记录保留。令牌不在此处回显。',
    'Current values are shown below: check the path and gate commands before saving. A disabled repository takes no new work, while its history is kept. Tokens are never shown here.'],
  'repos.editSaved': ['仓库配置已保存，历史版本已记录。', 'Repository saved; a history version was recorded.'],
  'repos.editInvalid': ['闸门必须是有效的 JSON 数组。', 'Gates must be a valid JSON array.'],
  'repos.editDiff': ['保存前差异', 'Changes to save'],
  'repos.editNoChanges': ['尚未修改。', 'No changes yet.'],
  'repos.editGateCount': ['{count} 个闸门', '{count} gates'],
  'repos.gateName': ['闸门名称', 'Gate name'],
  'repos.gateCommand': ['命令', 'Command'],
  'repos.gateCwd': ['工作目录（相对仓库）', 'Working directory (repository-relative)'],
  'repos.gateCwdPlaceholder': ['留空 = 仓库根目录', 'Empty = repository root'],
  'repos.gateTimeout': ['超时（毫秒）', 'Timeout (ms)'],
  'repos.gateOnFail': ['失败策略', 'Failure policy'],
  'repos.gateOnFail.manual': ['人工处置', 'Manual'],
  'repos.gateOnFail.auto_repair': ['自动返工', 'Auto repair'],
  'repos.gateDryRun': ['干跑命令（可选）', 'Dry-run command (optional)'],
  'repos.gateAdd': ['添加闸门', 'Add gate'],
  'repos.gateRemove': ['删除这个闸门', 'Remove this gate'],
  'repos.gateEmptyEditor': ['还没有闸门；保存后按默认闸门执行。', 'No gates yet; saving keeps the default gates.'],
  'repos.gateDiff': ['闸门「{name}」', 'Gate “{name}”'],
  'repos.gateFieldRequired': ['闸门名称和命令不能为空。', 'A gate needs a name and a command.'],
  'repos.editGateInvalid': ['JSON 无效', 'invalid JSON'],
  'repos.test': ['测试配置', 'Test configuration'],
  'repos.testing': ['检查中…', 'Checking…'],
  'repos.testOk': ['配置检查通过', 'Configuration check passed'],
  'repos.testFail': ['配置检查未通过', 'Configuration check failed'],
  'repos.check.config': ['配置文件', 'Config file'],
  'repos.check.node': ['Node.js 运行时', 'Node.js runtime'],
  'repos.check.repo': ['本地仓库', 'Local repository'],
  'repos.check.token': ['平台令牌', 'Platform token'],
  'repos.check.connection': ['平台连接', 'Platform connection'],
  'repos.check.enabled': ['仓库启用', 'Repository enabled'],
  'repos.testHint': ['只做固定的只读检查：配置文件、运行时、路径、令牌是否配置、平台连通性；不执行闸门、不建单、不启动 worker。',
    'Runs only fixed read-only checks: config file, runtime, path, token presence and platform connectivity. It never runs gates, creates Tickets or starts workers.'],
  'repos.gatesJson': ['闸门定义（JSON）', 'Gate definitions (JSON)'],
  'repos.gatesJsonHint': ['每项包含 name/command，可选 cwd（相对仓库路径）、timeoutMs、onFail、dryRunCommand。目录越界或重复名称会被拒绝。',
    'Each entry has name/command plus optional cwd (relative to the repository), timeoutMs, onFail and dryRunCommand. Escaping paths and duplicate names are rejected.'],
  'repos.addTitle': ['添加仓库', 'Add repository'],
  'repos.addHint': ['填写本地路径、GitLab 项目与验证方式；保存后可在这张卡片上保存 GitLab token。',
    'Fill in the local path, GitLab project and verification mode; save the GitLab token on the new card afterwards.'],
  'repos.saved': ['仓库已添加', 'Repository added'],
  'repos.field.id': ['仓库 id', 'Repository id'],
  'repos.field.idHint': ['小写字母、数字、点、下划线或短横线；创建后不可改。', 'Lowercase letters, digits, dots, underscores or dashes; immutable after creation.'],
  'repos.field.name': ['显示名称', 'Display name'],
  'repos.field.kind': ['仓库类型', 'Repository kind'],
  'repos.field.repo': ['本地路径', 'Local path'],
  'repos.field.repoHint': ['必须是已存在的本地仓库目录。', 'Must be an existing local repository directory.'],
  'repos.field.baseBranch': ['基础分支', 'Base branch'],
  'repos.field.targetBranch': ['目标分支', 'Target branch'],
  'repos.field.baseUrl': ['GitLab 地址', 'GitLab base URL'],
  'repos.field.project': ['GitLab 项目', 'GitLab project'],
  'repos.field.verifyMode': ['验证方式', 'Verification mode'],
  'repos.field.acceptance': ['验收方式', 'Acceptance'],
  'repos.field.uatUrl': ['UAT 地址（可选）', 'UAT URL (optional)'],
  'repos.field.healthUrl': ['健康检查地址（可选）', 'Health URL (optional)'],
  'repos.field.makeDefault': ['设为默认仓库', 'Make default repository'],
  'repos.field.makeDefaultHint': ['手工建单和未绑定群会使用默认仓库。', 'Manual Tickets and unbound groups use the default repository.'],
  'repos.kindWeb': ['Web / 常规', 'Web'],
  'repos.kindEbs': ['Oracle EBS', 'Oracle EBS'],
  'repos.verifyWebUat': ['Web UAT', 'Web UAT'],
  'repos.verifyManual': ['人工验证（只观察合并）', 'Manual (observe merge only)'],
  'repos.acceptDeployed': ['部署后验收', 'Accept after deploy'],
  'repos.acceptMerged': ['合并后验收', 'Accept after merge'],
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
  'st.pageIntro': ['设置会写回 ~/.dsh/superagent/live.json；开关类改动点保存后生效，令牌类项目保存即生效。',
    'Settings are written to ~/.dsh/superagent/live.json; switch changes apply after saving, token fields apply on save.'],
  'st.navLabel': ['设置分组', 'Settings groups'],
  // Reference groups (评估 / 提示词) are read-only: they sit below a divider in the rail and never show a save bar.
  'st.reference': ['参考', 'Reference'],
  // The run/worker/write groups split the old executor group; their labels live here as page-local overrides of the
  // shared settingsGroup dictionary (06-i18n.js keeps source/eval/repos/prompts only).
  'settingsGroup.review': ['评估确认', 'Review'],
  'settingsGroup.run': ['运行', 'Runtime'],
  'settingsGroup.worker': ['Worker', 'Worker'],
  'settingsGroup.write': ['写权限', 'Write access'],
  'st.unsaved': ['未保存', 'Unsaved'],
  'st.bindings': ['自动接单群（群 → 仓库）', 'Intake groups (group → repository)'],
  'st.bindingsHint': ['给每个监听群绑定一个仓库；新群可以从群列表选择，也可以手工填写 chatId，保存后按引擎开关状态开始监听。',
    'Bind one repository to each watched group. Add a group from the list or paste a chat id; the engine watches it once enabled and saved.'],
  'st.bindingChat': ['群 chatId', 'Group chat id'],
  'st.bindingTitle': ['群名称（可选）', 'Group name (optional)'],
  'st.bindingRepo': ['接单仓库', 'Repository'],
  'st.bindingAdd': ['添加绑定', 'Add binding'],
  'st.bindingRemove': ['移除', 'Remove'],
  'st.bindingEmpty': ['还没有绑定的群。现有群默认走默认仓库。',
    'No bound group yet. Existing groups fall back to the default repository.'],
  'st.bindingSaved': ['群绑定已保存', 'Group bindings saved'],
  'st.bindingChatRequired': ['请填写群 chatId。', 'Enter the group chat id.'],
  'st.groupsPick': ['从群列表选择', 'Pick from group list'],
  'st.groupsLoading': ['读取群列表…', 'Loading groups…'],
  'st.groupsSearch': ['搜索群名或 chatId…', 'Search group name or chat id…'],
  'st.groupsCount': ['{count} 个群', '{count} groups'],
  'st.groupsEmpty': ['没有可用的群。确认机器人已在群里，或直接填写 chatId。',
    'No group available. Make sure the bot is in a group, or paste a chat id.'],
  'st.groupsWatched': ['已监听', 'Watched'],
  'st.groupsClose': ['收起', 'Collapse'],
  'st.groupsNoToken': ['先保存 Octo token，再读取群列表。', 'Save the Octo token before loading groups.'],
  'st.octoTokenHint': ['保存在本机 token 文件（权限 600），不会回显；读取群列表可验证 token 是否有效。',
    'Stored in the local token file (mode 600) and never echoed; load the group list to verify it.'],
  'st.octoTokenPlaceholder': ['粘贴 Octo token', 'Paste the Octo token'],
  'st.octoTokenSave': ['保存令牌', 'Save token'],
  'st.octoTokenSaved': ['Octo token 已保存', 'Octo token saved'],
  'st.octoTokenCleared': ['已清除 Octo token', 'Octo token cleared'],
  'st.octoTokenClearTitle': ['清除 Octo token？', 'Clear the Octo token?'],
  'st.octoTokenClearMessage': ['清除后引擎无法读取群消息，监听、评估与派工都会停止；需要重新粘贴 token 才能恢复。已合并的工单不受影响。',
    'After clearing, the engine cannot read group messages; intake, Eval and dispatch stop until a token is pasted again. Already merged Tickets are not affected.'],
  'st.octoTokenEnv': ['环境变量', 'Env var'],
  'st.octoTokenEnvHint': ['当前使用 OCTO_TOKEN 环境变量；要改为本机保存，请移除该环境变量后再保存令牌。',
    'Using the OCTO_TOKEN environment variable; remove it before saving a local token file.'],
  'st.copyConfigPath': ['复制路径', 'Copy path'],
  'st.history': ['变更历史', 'Change history'],
  'st.historyTitle': ['配置变更历史', 'Configuration history'],
  'st.historyHint': ['每次保存 live.json 前会自动留一份；恢复也会先备份当前版本。token 文件不进入历史。',
    'A copy is saved before every live.json write; restoring backs up the current version first. Token files are not included.'],
  'st.historyEmpty': ['还没有历史版本。保存一次设置后就会出现。', 'No saved version yet. Save a setting once to create one.'],
  'st.historyRestore': ['恢复', 'Restore'],
  'st.historyRestored': ['配置已恢复', 'Configuration restored'],
  'st.historyLoading': ['读取历史…', 'Loading history…'],
  'st.historySettings': ['设置变更', 'Settings change'],
  'st.historyAddRepo': ['添加仓库', 'Add repository'],
  'st.historyBeforeRestore': ['恢复前的备份', 'Backup before restore'],

  // ---- one-line intro hints of the groups (the group name itself lives in the left nav) ----
  'st.sourceHint': ['输入通道：先连接 Octo，再选择监听群、触发人范围与轮询间隔；只读项由宿主状态提供。',
    'Intake: connect Octo first, then choose watched groups, who may trigger work, and the poll interval; read-only values come from the host.'],
  'st.evalHint': ['评估方式、判定模型与规则目录由 live.json 和代码版本决定，这里只读展示。',
    'The evaluation mode, decision model and rule catalog come from live.json and the code version; shown read-only here.'],
  'st.runHint': ['执行器总开关、运行方式、闸门/超时与手工建单。改完保存后立即生效；worker 后端在「Worker」分组单独管理。',
    'The executor master switch, how work runs, gates/timeout and the manual Ticket form. Changes apply after saving; the worker backend lives in its own Worker group.'],
  'st.workerHint': ['路由模式决定“建议 / 自动 / 单后端”；启用多个后端后按任务类型分发。suggest 只记录建议、仍用默认后端执行。',
    'The routing mode decides suggest / auto / single. With several backends enabled, work is dispatched by task type; suggest only records the choice and still runs the default backend.'],
  'st.routingTitle': ['路由模式', 'Routing mode'],
  'st.routingModeSingle': ['单后端（沿用旧配置）', 'Single backend (legacy)'],
  'st.routingModeSuggest': ['建议（只记录，不改变执行）', 'Suggest (record only)'],
  'st.routingModeAuto': ['自动（按任务类型分发）', 'Auto (dispatch by work type)'],
  'st.routingModeHint': ['建议模式先在运行记录里展示“会交给谁”，确认准确后再切自动。',
    'Suggest mode shows who would run the Ticket in the run record; switch to auto once the choices look right.'],
  'st.defaultBackend': ['默认后端', 'Default backend'],
  'st.defaultBackendHint': ['没有偏好规则、或偏好后端不可用时使用。', 'Used when no preference matches or the preferred backend is unavailable.'],
  'st.fallbackBackend': ['降级后端（可选）', 'Fallback backend (optional)'],
  'st.fallbackNone': ['不降级', 'No fallback'],
  'st.enabledBackends': ['启用的后端', 'Enabled backends'],
  'st.enabledBackendsHint': ['至少启用一个。启用多个后默认进入建议模式；CLI 后端需要本机已登录。',
    'Enable at least one. Several enabled defaults to suggest mode; CLI backends require a local login.'],
  'st.routePreferences': ['任务类型偏好', 'Work-type preferences'],
  'st.routePreferencesHint': ['按任务类型指定后端；留空跟随默认后端。硬约束优先：联网调研与需提问只能 DSH，测试验证不能 Claude。',
    'Bind each work type to a backend; leave it on “follow default” when unsure. Hard capability limits win: research and interactive work can only run on DSH, and verification cannot run on Claude.'],
  'st.routeFollowDefault': ['跟随默认', 'Follow default'],
  'st.workTypeAnalysis': ['需求分析', 'Analysis'],
  'st.workTypeReview': ['代码 review', 'Code review'],
  'st.workTypeTest': ['功能测试验证', 'Verification'],
  'st.workTypeDev': ['代码开发', 'Development'],
  'st.workTypeDocs': ['文档', 'Documentation'],
  'st.workTypeResearch': ['联网调研', 'Web research'],
  'st.workTypeInteractive': ['需提问/确认', 'Interactive'],
  'st.routeReadOnly': ['只读', 'read-only'],
  'st.routeWrite': ['可写', 'write'],
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
  'st.allowAnyHumanHint': ['开启后任何人类发送的文本消息都能触发；关闭时只接受下方名单里的发送者。',
    'When on, any human text message can trigger; when off, only senders in the list below are accepted.'],
  'st.sendersHint': ['填写发送者的 Octo UID；关闭「允许任意人类」时只接受名单中的发送者。',
    'Enter the sender Octo UID; when “accept any human” is off, only listed senders are accepted.'],
  'st.sendersEmpty': ['还没有允许的发送者。', 'No allowed sender yet.'],
  'st.senderPlaceholder': ['发送者 UID', 'Sender UID'],
  'st.addSender': ['添加', 'Add'],
  'st.removeSender': ['移除发送者 {sender}', 'Remove sender {sender}'],
  'st.anyHumanSendersHint': ['「允许任意人类」已开启，名单暂不参与判断；关闭后可继续编辑名单。',
    '“Accept any human” is on; the list is ignored until you turn it off.'],
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
  'st.noChats': ['还没有监听群。用「从群列表选择」添加，或手工填写 chatId。',
    'No watched groups yet. Use “Pick from group list”, or paste a chat id.'],
  'st.probeHint': ['“检查新消息”是干跑：只读取并评估，不写入状态、不建工单。',
    '"Check for new messages" is a dry run: it only reads and evaluates, writing no state and creating no Ticket.'],
  'st.probeAt': ['检查于 {time}', 'Checked {time}'],
  'st.probeSummary': ['检查完成：可接单 {accepted} · 忽略 {ignored}（干跑，未写入）',
    'Check finished: {accepted} acceptable · {ignored} ignored (dry run, nothing written)'],
  'st.probeFailed': ['检查失败。', 'The check failed.'],
  'st.errBusy': ['已有一次轮询在进行中，请稍后再试。', 'A poll is already running; try again shortly.'],
  'st.errPaused': ['引擎已暂停：非干跑轮询会被拒绝。', 'The engine is paused: a non-dry-run poll is rejected.'],
  'st.errNoConfig': ['live.json 不存在。', 'live.json does not exist.'],
  'st.errDisabled': ['引擎未启用，请先在设置→来源打开「启用引擎」。', 'The engine is disabled; turn on “Engine enabled” under Settings → Source first.'],
  'st.errNoToken': ['Octo token 未配置，读不到群消息。', 'The Octo token is missing, so group messages cannot be read.'],
  'st.errNoSender': ['没有允许发送者，也没有“允许任意人类”。', 'No allowed senders and "accept any human" is off.'],
  'st.reloadConfig': ['重载配置', 'Reload config'],
  'st.reloadFailed': ['重载配置失败。', 'Reloading the config failed.'],
  'st.reloadedAt': ['已重载配置 {time}', 'Config reloaded {time}'],

  // ---- eval group ----
  'st.evalMode': ['评估方式', 'Evaluation mode'],
  'st.modeRules': ['规则引擎（rules）', 'Rule engine (rules)'],
  'st.modeShadow': ['规则兜底 + 模型 shadow（shadow）', 'Rules + model shadow (shadow)'],
  'st.modeHybrid': ['规则硬闸 + 模型接单（hybrid）', 'Rules + model intake (hybrid)'],
  'st.modeLlm': ['模型评估（llm）', 'Model evaluation (llm)'],
  'st.modeUnknown': ['未知模式（{mode}）', 'Unknown mode ({mode})'],
  'st.judgeTitle': ['判定模型（shadow）', 'Decision model (shadow)'],
  'st.judgeEndpoint': ['模型地址', 'Model endpoint'],
  'st.judgeModel': ['模型名', 'Model'],
  'st.judgeToken': ['模型 token', 'Model token'],
  'st.judgeCalls': ['模型调用（成功 / 失败 / 跳过）', 'Model calls (ok / failed / skipped)'],
  'st.configured': ['已配置', 'Configured'],
  'st.notConfigured': ['未配置', 'Not configured'],
  'st.reviewIntro': ['每条评估都会回发来源群；只有下面列出的操作人回复「接单 ABCD / 忽略 ABCD」才会生效。保存后下一轮轮询生效。',
    'Every evaluation is posted back to its source group; only the operators listed below can answer with “接单 ABCD / 忽略 ABCD”. Applies on the next poll after saving.'],
  'st.reviewSummary': ['评估确认（{pending} 待回复 / {answered} 已回复）', 'Evaluation review ({pending} awaiting / {answered} answered)'],
  'st.reviewEnabled': ['启用评估确认', 'Enable review prompts'],
  'st.reviewEnabledHint': ['关闭后不再发确认消息，已经发出的确认仍可回复。', 'When off, no new prompts are posted; already-posted ones remain answerable.'],
  'st.reviewSenders': ['允许回复的操作人（Octo uid）', 'Operators allowed to answer (Octo uids)'],
  'st.reviewSendersHint': ['逗号或换行分隔；留空表示没有人能回复确认。uid 可从群成员资料或历史消息里查。',
    'Comma or newline separated; empty means nobody can confirm. Find uids in member profiles or past messages.'],
  'st.reviewExpire': ['回复有效期（小时）', 'Reply validity (hours)'],
  'st.reviewExpireHint': ['1–168 小时；过期的评估不再接受回复。', '1–168 hours; expired reviews no longer accept answers.'],
  'st.reviewExpireInvalid': ['回复有效期需为 1–168 之间的小时数。', 'Reply validity must be an integer between 1 and 168 hours.'],
  'st.reviewExample': ['回复示例：接单 ABCD / 忽略 ABCD（短码在前也认）', 'Reply examples: 接单 ABCD / 忽略 ABCD (code-first also works)'],
  'st.reviewScope': ['确认范围', 'Review scope'],
  'st.reviewScopeAll': ['所有评估', 'Every evaluation'],
  'st.reviewScopeUncertain': ['仅分歧与不确定', 'Disagreements only'],
  'st.judgeHint': ['shadow 模式下模型只记录意见；hybrid 下模型参与接单（repo_task 自动开单、risky 拦截、其余转人工）。地址与模型名在 live.json 的 eval.decision 里配置；token 通过接口写文件。',
    'In shadow mode the model only records an opinion; in hybrid it takes part in intake (repo_task opens, risky blocks, the rest goes to review). Configure endpoint/model in live.json eval.decision; write the token through the token endpoint.'],
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
  'st.pausedHint': ['总暂停：不轮询、不自动执行、不核对 UAT；已排队的工单保持不动。',
    'Total pause: no polling, no auto-run and no UAT verification; queued Tickets stay as they are.'],
  'st.pausedIntake': ['暂停接单（保留游标）', 'Pause intake (keep cursor)'],
  'st.pausedIntakeHint': ['不读取新消息，来源游标不前进：恢复后这些请求仍然会进来。已在跑的工单不受影响。',
    'Reads no new messages and does not advance the source cursor, so they arrive after resuming. Running work is unaffected.'],
  'st.pausedDispatch': ['暂停派发（保留队列）', 'Pause dispatch (keep queue)'],
  'st.pausedDispatchHint': ['不自动开始新的工单；队列和在跑任务都保留，手工开始仍可用。',
    'Starts no new Ticket automatically; the queue and running work are kept and manual starts still work.'],
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
  'st.timeoutHint': ['单位分钟，范围 1–1440。超时以 timeout 结束本次运行（工作树保留，可调大后重试）。',
    'Minutes, 1–1440. A timeout ends the run with "timeout"; the worktree is kept, so retry after raising it.'],
  'st.timeoutInvalid': ['执行超时必须是 1–1440 之间的整数分钟。', 'The run timeout must be a whole number of minutes between 1 and 1440.'],
  'st.minutes': ['{count} 分钟', '{count} min'],
  'st.repo': ['仓库', 'Repository'],
  'st.manualRepoHint': ['工单会在这个仓库上执行；默认是 {name}。',
    'The Ticket runs on this repository; the default is {name}.'],
  'st.worktreeRoot': ['工作树根目录', 'Worktree root'],
  'st.manualTitle': ['手工建单（测试）', 'Create a Ticket (test)'],
  'st.manualHint': ['测试用：会真实写入 live 状态并加入执行队列，不是干跑。',
    'For testing: writes real live state and joins the execution queue — not a dry run.'],
  'st.titlePh': ['标题', 'Title'],
  'st.bodyPh': ['正文（可选）', 'Body (optional)'],
  'st.create': ['建单', 'Create Ticket'],
  'st.created': ['已建单', 'Ticket created'],
  'st.repairBudget': ['返工预算', 'Repair budget'],
  'st.repairBudgetHint': ['0–6 轮，默认 2。分阶段流程里验收要求修改时最多自动返工几轮；用完会停下并说明原因，调大后可点「继续执行」接着返工。',
    'Rounds from 0 to 6, default 2. How many implement→gates→review rounds a staged workflow may spend when its independent review keeps asking for changes; when spent the workflow stops and says why, and raising it lets Continue run the next round.'],
  'st.repairBudgetInvalid': ['返工预算需为 0–6 的整数。', 'Repair budget must be an integer from 0 to 6.'],

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

/** A copyable, secret-free example of the file-only repository block. */
const REPO_CONFIG_SAMPLE = `{
  "repos": [
    {
      "id": "my-repo",
      "name": "my-repo",
      "repo": "/absolute/path/to/my-repo",
      "baseBranch": "dev",
      "gitlab": {
        "baseUrl": "https://gitlab.example.com",
        "project": "group/my-repo",
        "tokenFile": "/home/you/.dsh/superagent/gitlab-my-repo.token"
      }
    }
  ],
  "defaultRepo": "my-repo"
}
`
/** Blank repository form; values map to the fields accepted by POST engine/repos. */
const emptyRepoForm = () => ({
  id: '', name: '', kind: 'web', path: '', baseBranch: 'dev', featurePrefix: 'feature/', verifyMode: 'web-uat',
  acceptance: 'deployed', baseUrl: '', project: '', targetBranch: 'dev', uatUrl: '', healthUrl: '', makeDefault: false,
})

/** Group order of the left column; labels come from the shared settingsGroup dictionary in 06-i18n.js, except the
    executor groups whose labels are page-local overrides (settingsGroup.run / settingsGroup.worker /
    settingsGroup.write above).
    `reference: true` marks a read-only group: the rail lists the groups that can be changed first, then a divider and
    the "参考" label, then these. The content column and the save-bar logic are unchanged — only the rail groups them. */
const SETTINGS_GROUPS = [
  { id: 'source', labelKey: 'settingsGroup.source', icon: 'inbox' },
  { id: 'review', labelKey: 'settingsGroup.review', icon: 'decision' },
  { id: 'eval', labelKey: 'settingsGroup.eval', icon: 'decision', reference: true },
  { id: 'run', labelKey: 'settingsGroup.run', icon: 'play' },
  { id: 'worker', labelKey: 'settingsGroup.worker', icon: 'robot' },
  { id: 'write', labelKey: 'settingsGroup.write', icon: 'blocked' },
  { id: 'repos', labelKey: 'settingsGroup.repos', icon: 'pull' },
  { id: 'prompt', labelKey: 'settingsGroup.prompts', icon: 'message', reference: true },
]

/** Only these groups own writable fields, so only they may ever render a save bar. `run`, `worker` and `write` keep
    separate drafts and separate save bars even though all three patch `executor.*`. */
const SETTINGS_SAVEABLE = ['source', 'review', 'run', 'worker', 'write']

const settingsOmit = (object, key) => {
  const next = { ...(object ?? {}) }
  delete next[key]
  return next
}

/** Draft comparison: booleans by value, numbers/strings by their text form (the number input holds a string). */
/** Draft comparison: booleans by value, objects by JSON, numbers/strings by their text form. */
function settingsSame(left, right) {
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right)
  if ((left && typeof left === 'object') || (right && typeof right === 'object')) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  }
  return String(left ?? '') === String(right ?? '')
}

/** Draft (UI values) → the patch the host accepts. Only live-json allow-listed keys are ever sent. */
function settingsPatchOf(group, draft) {
  const patch = {}
  if (!draft) return patch
  if (group === 'review') {
    if ('review.enabled' in draft) patch['review.enabled'] = draft['review.enabled'] === true
    if ('review.scope' in draft) patch['review.scope'] = String(draft['review.scope'])
    if ('review.allowSenderIds' in draft) {
      patch['review.allowSenderIds'] = String(draft['review.allowSenderIds'] ?? '')
        .split(/[\s,，;；]+/).map(value => value.trim()).filter(Boolean)
    }
    if ('review.expireHours' in draft) patch['review.expireHours'] = Number(draft['review.expireHours'])
  }
  if (group === 'source') {
    if ('enabled' in draft) patch.enabled = draft.enabled === true
    if ('pollSeconds' in draft) patch.pollSeconds = Number(draft.pollSeconds)
    if ('octo.allowAnyHuman' in draft) patch['octo.allowAnyHuman'] = draft['octo.allowAnyHuman'] === true
    if ('octo.allowSenderIds' in draft) {
      const list = Array.isArray(draft['octo.allowSenderIds']) ? draft['octo.allowSenderIds'] : []
      patch['octo.allowSenderIds'] = list.map(value => String(value).trim()).filter(Boolean)
    }
  } else if (group === 'run' || group === 'worker' || group === 'write') {
    // `run`, `worker` and `write` are three views of the same executor block: the union below patches every draft key
    // any of them can hold, so a field moved between the groups keeps saving through the same `executor.*` allow-list.
    for (const key of ['executor.enabled', 'executor.autoRun', 'executor.allowPush', 'executor.allowMerge', 'executor.allowReply']) {
      if (key in draft) patch[key] = draft[key] === true
    }
    if ('paused' in draft) patch.paused = draft.paused === true
    if ('pausedIntake' in draft) patch.pausedIntake = draft.pausedIntake === true
    if ('pausedDispatch' in draft) patch.pausedDispatch = draft.pausedDispatch === true
    if ('gitlab.createMr' in draft) patch['gitlab.createMr'] = draft['gitlab.createMr']
    // P2: the run timeout is editable from Settings; it is stored as milliseconds in live.json.
    if ('executor.timeoutMs' in draft) patch['executor.timeoutMs'] = Number(draft['executor.timeoutMs'])
    // Repair budget shared by gate auto-repair and the staged review loop (0..6).
    if ('executor.maxRepairRounds' in draft) patch['executor.maxRepairRounds'] = Number(draft['executor.maxRepairRounds'])
    for (const key of ['executor.workerBackend', 'executor.workerModel', 'executor.workerCommand']) {
      if (key in draft) patch[key] = draft[key]
    }
    // P1 multi-backend routing: workers and routing are sent as whole objects by the Worker group.
    if (group === 'worker') {
      for (const key of ['executor.workers', 'executor.routing', 'executor.workflowMode', 'executor.implementer',
        'executor.reviewer', 'executor.workerPreset']) if (key in draft) patch[key] = draft[key]
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
  const name = typeof gate === 'string' ? gate : gate?.name
  const key = `gate.${name}`
  const label = pt(t, key)
  return label === key ? String(name) : label
}

/** One repository card: read-only facts plus its own write-only token editor. Saving a token is the reversible edit;
    clearing one stops what the executor can observe for this repository, so it goes through a confirmation that names
    the consequence (C6) — a plain button here used to clear on a single click. */
/** P2-5 capability table: static data describing what each backend actually does today (contract §2). */
const WORKER_CAP_COLUMNS = [
  { key: 'stream', labelKey: 'st.capStream' },
  { key: 'approval', labelKey: 'st.capApproval' },
  { key: 'resume', labelKey: 'st.capResume' },
  { key: 'diff', labelKey: 'st.capDiff' },
  { key: 'report', labelKey: 'st.capReport' },
]
/** P1 routing controls: the same enums the host validates (routing.js). Labels are page-local i18n keys. */
const ROUTE_BACKENDS = [
  { value: 'dsh', labelKey: 'st.workerDsh', hintKey: 'st.workerDshHint' },
  { value: 'codex', labelKey: 'st.workerCodex', hintKey: 'st.workerCodexHint' },
  { value: 'claude', labelKey: 'st.workerClaude', hintKey: 'st.workerClaudeHint' },
]
/** Staged-flow backends, mirroring lib/live/config.js: the implementer is the in-process DSH worker or Claude,
    the reviewer (assessment, planning and final review) is a read-only CLI (Codex or Claude). Options follow the
    enabled backends; a disabled one stays visible (marked) only while it is the saved value. */
const STAGED_IMPLEMENTERS = [{ value: 'dsh', label: 'DSH' }, { value: 'claude', label: 'Claude Code' }]
const STAGED_REVIEWERS = [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude Code' }, { value: 'dsh', label: 'DSH' }]
const ROUTE_WORK_TYPES = [
  { key: 'analysis', labelKey: 'st.workTypeAnalysis', hintKey: 'st.routeReadOnly' },
  { key: 'review', labelKey: 'st.workTypeReview', hintKey: 'st.routeReadOnly' },
  { key: 'test', labelKey: 'st.workTypeTest', hintKey: 'st.routeWrite' },
  { key: 'dev', labelKey: 'st.workTypeDev', hintKey: 'st.routeWrite' },
  { key: 'docs', labelKey: 'st.workTypeDocs', hintKey: 'st.routeWrite' },
  { key: 'research', labelKey: 'st.workTypeResearch', hintKey: 'st.routeReadOnly' },
  { key: 'interactive', labelKey: 'st.workTypeInteractive', hintKey: 'st.routeReadOnly' },
]
/** Built-in preference table mirroring lib/live/routing.js: capability first, then the operator's intent. */
const ROUTE_DEFAULT_PREFERENCES = [
  { workTypes: ['research', 'interactive'], backend: 'dsh' },
  { workTypes: ['analysis', 'review', 'test'], backend: 'codex' },
  { workTypes: ['dev', 'docs'], backend: 'claude' },
]

const WORKER_CAPABILITIES = [
  { backend: 'dsh', nameKey: 'st.capDsh', capabilities: {
    stream: { yes: true },
    approval: { yes: false, noteKey: 'st.capDshApproval' },
    resume: { yes: false, noteKey: 'st.capDshResume' },
    diff: { yes: true, noteKey: 'st.capChangedPaths' },
    report: { yes: true, noteKey: 'st.capDshReport' },
  } },
  { backend: 'codex', nameKey: 'st.capCodex', capabilities: {
    stream: { yes: true, noteKey: 'st.capCodexStream' },
    approval: { yes: false, noteKey: 'st.capCodexApproval' },
    resume: { yes: false, noteKey: 'st.capCodexResume' },
    diff: { yes: true, noteKey: 'st.capChangedPaths' },
    report: { yes: false },
  } },
  { backend: 'claude', nameKey: 'st.capClaude', capabilities: {
    stream: { yes: true, noteKey: 'st.capClaudeStream' },
    approval: { yes: false, noteKey: 'st.capClaudeApproval' },
    resume: { yes: false, noteKey: 'st.capClaudeResume' },
    diff: { yes: true, noteKey: 'st.capChangedPaths' },
    report: { yes: false },
  } },
]

/** The read-only「运行后端能力」card: current backend highlighted, every cell tagged with yes/no plus its caveat. */
function WorkerCapabilityCard({ currentBackend }) {
  const { t } = usePanel()
  const current = WORKER_CAPABILITIES.some(entry => entry.backend === currentBackend) ? currentBackend : 'dsh'
  return h('div', { className: 'sa-field' },
    h('span', { className: 'sa-field-head' }, pt(t, 'st.capTitle')),
    h(Hint, null, pt(t, 'st.capHint')),
    h('table', { className: 'sa-glossary sa-capabilities' },
      h('thead', null, h('tr', null,
        h('th', null, pt(t, 'st.capBackend')),
        WORKER_CAP_COLUMNS.map(column => h('th', { key: column.key }, pt(t, column.labelKey))))),
      h('tbody', null, WORKER_CAPABILITIES.map(entry => {
        const active = entry.backend === current
        return h('tr', { key: entry.backend, 'data-current': active ? 'true' : undefined,
          style: active ? { background: 'var(--dsw-alias-bg-subtle, transparent)' } : undefined },
          h('th', { scope: 'row' },
            h('span', { className: 'sa-actions', style: { gap: 'var(--sa-sp-4)' } },
              h('span', null, pt(t, entry.nameKey)),
              active ? h(Tag, { tone: 'info' }, pt(t, 'st.capCurrent')) : null)),
          WORKER_CAP_COLUMNS.map(column => {
            const cell = entry.capabilities[column.key] ?? { yes: false }
            return h('td', { key: column.key },
              h(Tag, { tone: cell.yes ? 'success' : 'neutral' }, pt(t, cell.yes ? 'st.capYes' : 'st.capNo')),
              cell.noteKey ? h('div', { className: 'sa-hint' }, pt(t, cell.noteKey)) : null)
          }))
      }))))
}

const TEST_LABELS = { config: 'repos.check.config', node: 'repos.check.node', repo: 'repos.check.repo',
  token: 'repos.check.token', connection: 'repos.check.connection', enabled: 'repos.check.enabled' }

function ReposCard({ repo, isDefault, onSaveToken, onEdit, onToggle, tokenBusy }) {
  const { t, actions } = usePanel()
  const [token, setToken] = useState('')
  const [test, setTest] = useState({ busy: false })
  const runTest = async () => {
    setTest({ busy: true })
    try {
      const result = await actions.testConfig(repo.id)
      setTest({ busy: false, result })
    } catch (error) {
      setTest({ busy: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  const testLabel = key => pt(t, TEST_LABELS[key] ?? 'repos.check.connection')
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
      repo.enabled === false ? h(Tag, { tone: 'warning' }, pt(t, 'repos.disabledTag')) : null,
      h(Tag, { tone: repo.tokenConfigured ? 'outline' : 'warning' },
        repo.tokenConfigured ? pt(t, 'repo.tokenConfigured') : pt(t, 'repo.tokenMissing')),
      repo.name && repo.id && repo.name !== repo.id
        ? h('span', { className: 'sa-mono sa-hint' }, String(repo.id)) : null),
    h(KeyValues, { rows }),
    h('div', { className: 'sa-actions' },
      h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'settings', size: 14 }),
        onClick: () => onEdit?.(repo) }, pt(t, 'repos.edit')),
      h(ConfirmButton, { label: pt(t, repo.enabled === false ? 'repos.enable' : 'repos.disable'),
        title: pt(t, repo.enabled === false ? 'repos.enableTitle' : 'repos.disableTitle'),
        message: pt(t, repo.enabled === false ? 'repos.enableMessage' : 'repos.disableMessage', { name: repo.name ?? repo.id }),
        onConfirm: async () => { await onToggle?.(repo) } }),
      h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'shield', size: 14 }),
        disabled: test.busy, onClick: () => { void runTest() } },
      pt(t, test.busy ? 'repos.testing' : 'repos.test'))),
    test.result || test.error
      ? h('div', { className: 'sa-field', style: { marginTop: 'var(--sa-sp-8)' } },
        h('span', { className: 'sa-field-head' }, pt(t, test.error || test.result?.ok === false ? 'repos.testFail' : 'repos.testOk')),
        h(Hint, null, test.error ?? (test.result.checks ?? []).map(check =>
          `${check.skipped ? '○' : check.ok ? '✓' : '✕'} ${testLabel(check.id)}${check.detail ? ` · ${check.detail}` : ''}`).join(' / ')),
        h(Hint, null, pt(t, 'repos.testHint')))
      : null,
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

function LiveSettingsPage({ route }) {
  const { t, notify } = usePanel()
  const { data, error, reload, actions } = usePanelData()
  const requestedGroup = route?.group && SETTINGS_GROUPS.some(group => group.id === route.group) ? route.group : 'source'
  const [active, setActive] = useState(requestedGroup)
  const [drafts, setDrafts] = useState({})
  const [savingGroup, setSavingGroup] = useState(null)
  const [saveErrors, setSaveErrors] = useState({})
  const [savedTimes, setSavedTimes] = useState({})
  const savedTimers = useRef({})
  const [reloadState, setReloadState] = useState({ busy: false })
  const [probe, setProbe] = useState({ busy: false })
  const [uatState, setUatState] = useState({ busy: false })
  const [tokenSaving, setTokenSaving] = useState(null)
  const [octoTokenDraft, setOctoTokenDraft] = useState('')
  const [octoTokenBusy, setOctoTokenBusy] = useState(false)
  const [octoGroups, setOctoGroups] = useState({ open: false, busy: false, error: undefined, items: [] })
  const [octoGroupQuery, setOctoGroupQuery] = useState('')
  const [configSampleOpen, setConfigSampleOpen] = useState(false)
  const [repoModalOpen, setRepoModalOpen] = useState(false)
  // AC-10: existing repositories stay editable without losing their id/history; the modal shows the current values.
  const [repoEdit, setRepoEdit] = useState(undefined)
  const [repoEditBusy, setRepoEditBusy] = useState(false)
  const [repoEditError, setRepoEditError] = useState(undefined)
  const [repoForm, setRepoForm] = useState(emptyRepoForm)
  const [repoSaving, setRepoSaving] = useState(false)
  const [repoError, setRepoError] = useState(undefined)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState(undefined)
  const [senderDraft, setSenderDraft] = useState('')
  const [bindingForm, setBindingForm] = useState({ chatId: '', title: '', repoId: '' })
  const [bindingBusy, setBindingBusy] = useState(false)
  useEffect(() => () => {
    for (const timer of Object.values(savedTimers.current)) clearTimeout(timer)
  }, [])
  // Deep links from the setup checklist and system problems select the matching group. The effect only depends on
  // the requested group, so clicking the left rail afterwards is never overridden by an old route.
  useEffect(() => {
    if (route?.group && SETTINGS_GROUPS.some(group => group.id === route.group)) setActive(route.group)
  }, [route?.group])
  // A setup step can point at one field inside a group; scroll it into view after the pane switched.
  useEffect(() => {
    if (!route?.focus) return undefined
    const timer = setTimeout(() => {
      document.getElementById(`sa-settings-${route.focus}`)?.scrollIntoView({ block: 'center' })
    }, 120)
    return () => clearTimeout(timer)
  }, [route?.focus, active])
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

  /** Save/clear the Octo bot token; the value is write-only and the host never echoes it back. */
  const saveOctoTokenFor = async (value) => {
    if (octoTokenBusy) return false
    setOctoTokenBusy(true)
    try {
      await actions.saveOctoToken(value)
      await reload()
      setOctoTokenDraft('')
      notify(pt(t, value ? 'st.octoTokenSaved' : 'st.octoTokenCleared'))
      return true
    } catch (failure) {
      notify(errorText(failure))
      return false
    } finally { setOctoTokenBusy(false) }
  }

  /** Load the bot's group list through the host; this is a read-only query, not a poll. */
  const loadOctoGroups = async () => {
    if (octo.tokenConfigured !== true) { notify(pt(t, 'st.groupsNoToken')); return }
    setOctoGroups(previous => ({ ...previous, open: true, busy: true, error: undefined }))
    try {
      const result = await actions.listOctoGroups()
      setOctoGroups({ open: true, busy: false, error: undefined, items: Array.isArray(result?.groups) ? result.groups : [] })
    } catch (failure) {
      setOctoGroups({ open: true, busy: false, error: errorText(failure), items: [] })
    }
  }

  /** Selecting a group only fills the binding form; the operator still confirms the repository and saves. */
  const chooseGroup = (group) => {
    setBindingForm(previous => ({ ...previous, chatId: String(group.id ?? ''), title: group.name ?? '' }))
    setOctoGroups(previous => ({ ...previous, open: false }))
  }

  /** Add/remove one sender UID in the source-group draft; saving uses the existing group save bar. */
  const senderValuesOf = (draft) => {
    const value = draft && 'octo.allowSenderIds' in draft ? draft['octo.allowSenderIds'] : octo.allowSenderIds
    return Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()) : []
  }
  const addSender = () => {
    const value = senderDraft.trim()
    if (!value) return
    const current = senderValuesOf(drafts.source)
    if (!current.includes(value)) {
      editField('source', 'octo.allowSenderIds', [...current, value],
        Array.isArray(octo.allowSenderIds) ? octo.allowSenderIds : [])
    }
    setSenderDraft('')
  }
  const removeSender = value => {
    const current = senderValuesOf(drafts.source)
    editField('source', 'octo.allowSenderIds', current.filter(item => item !== value),
      Array.isArray(octo.allowSenderIds) ? octo.allowSenderIds : [])
  }

  /** Add one repository definition; the token is a separate write on the new card. */
  const submitRepo = async () => {
    if (repoSaving) return
    const form = repoForm
    const repo = {
      id: form.id.trim(),
      name: form.name.trim() || form.id.trim(),
      kind: form.kind,
      repo: form.path.trim(),
      baseBranch: form.baseBranch.trim(),
      featurePrefix: form.featurePrefix.trim(),
      verifyMode: form.verifyMode,
      acceptance: form.acceptance,
      gitlab: {
        baseUrl: form.baseUrl.trim(),
        project: form.project.trim(),
        targetBranch: form.targetBranch.trim(),
        ...(form.uatUrl.trim() ? { uatUrl: form.uatUrl.trim() } : {}),
        ...(form.healthUrl.trim() ? { healthUrl: form.healthUrl.trim() } : {}),
      },
    }
    setRepoSaving(true)
    setRepoError(undefined)
    try {
      await actions.addRepo(repo, { makeDefault: form.makeDefault === true })
      await reload()
      setRepoModalOpen(false)
      setRepoForm(emptyRepoForm())
      notify(pt(t, 'repos.saved'))
    } catch (failure) {
      setRepoError(errorText(failure))
    } finally { setRepoSaving(false) }
  }

  const openRepoEdit = (repo) => {
    // AC-10: edit one gate field at a time instead of hand-writing the whole gates JSON. A deep clone keeps the form
    // independent from the loaded config (cancel must not mutate it).
    const gates = Array.isArray(repo.gates) ? JSON.parse(JSON.stringify(repo.gates)) : []
    setRepoEdit({ id: repo.id, name: repo.name ?? repo.id, repo: repo.repo ?? '', gates })
    setRepoEditError(undefined)
  }
  const editGate = (index, key, value) => {
    setRepoEdit(previous => {
      if (!previous) return previous
      const gates = previous.gates.map((gate, position) => position === index ? { ...gate, [key]: value } : gate)
      return { ...previous, gates }
    })
  }
  const saveRepoEdit = async () => {
    if (repoEditBusy || !repoEdit) return
    const gates = repoEdit.gates.map(gate => {
      const clean = { name: String(gate.name ?? '').trim(), command: String(gate.command ?? '').trim() }
      if (gate.cwd) clean.cwd = String(gate.cwd).trim()
      if (Number.isFinite(Number(gate.timeoutMs)) && Number(gate.timeoutMs) > 0) clean.timeoutMs = Number(gate.timeoutMs)
      if (gate.onFail) clean.onFail = gate.onFail
      if (gate.dryRunCommand) clean.dryRunCommand = String(gate.dryRunCommand).trim()
      return clean
    })
    if (gates.some(gate => !gate.name || !gate.command)) { setRepoEditError(pt(t, 'repos.gateFieldRequired')); return }
    setRepoEditBusy(true)
    setRepoEditError(undefined)
    try {
      await actions.updateRepo(repoEdit.id, { name: repoEdit.name.trim() || repoEdit.id, repo: repoEdit.repo.trim(), gates })
      await reload()
      setRepoEdit(undefined)
      notify(pt(t, 'repos.editSaved'))
    } catch (failure) { setRepoEditError(errorText(failure)) } finally { setRepoEditBusy(false) }
  }
  const toggleRepo = async (repo) => {
    try {
      await actions.updateRepo(repo.id, { enabled: repo.enabled === false })
      await reload()
      notify(pt(t, repo.enabled === false ? 'repos.enableSaved' : 'repos.disableSaved', { name: repo.name ?? repo.id }))
    } catch (failure) { notify(errorText(failure), 'error') }
  }

  /** Load saved live.json versions; the list contains configuration only, never tokens. */
  const openHistory = async () => {
    setHistoryOpen(true)
    setHistoryBusy(true)
    setHistoryError(undefined)
    try {
      const response = await actions.settingsHistory()
      setHistoryEntries(Array.isArray(response?.entries) ? response.entries : [])
    } catch (failure) {
      setHistoryError(errorText(failure))
    } finally { setHistoryBusy(false) }
  }
  const historyLabel = entry => {
    const label = entry.label ?? ''
    if (label.startsWith('settings:')) return `${pt(t, 'st.historySettings')} · ${label.slice('settings:'.length).trim()}`
    if (label.startsWith('add repository ')) return `${pt(t, 'st.historyAddRepo')} · ${label.slice('add repository '.length)}`
    if (label.startsWith('before restore')) return pt(t, 'st.historyBeforeRestore')
    return label || entry.id
  }
  const restoreHistory = async (id) => {
    if (historyBusy) return
    setHistoryBusy(true)
    setHistoryError(undefined)
    try {
      await actions.restoreSettings(id)
      await reload()
      setHistoryOpen(false)
      notify(pt(t, 'st.historyRestored'))
    } catch (failure) {
      setHistoryError(errorText(failure))
    } finally { setHistoryBusy(false) }
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
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'primary', size: 'sm', icon: h(Icon, { name: 'plus', size: 14 }),
          onClick: () => { setRepoForm(emptyRepoForm()); setRepoError(undefined); setRepoModalOpen(true) } },
        pt(t, 'repos.add')),
        config.file ? h(CopyButton, { value: config.file, label: pt(t, 'st.copyConfigPath') }) : null,
        h(Button, { variant: 'outline', size: 'sm', onClick: () => setConfigSampleOpen(true) },
          pt(t, 'repos.emptyAction'))),
      repos.length
        ? h(Fragment, null,
          h('p', { className: 'sa-hint', role: 'status' }, pt(t, 'repos.summary', { count: repos.length, default: defaultRepoName })),
          h('div', { className: 'sa-cards-2' }, repos.map(repo => h(ReposCard, { key: repo.id, repo,
            isDefault: repo.id === defaultRepoId, onSaveToken: saveRepoTokenFor, tokenBusy: tokenSaving === repo.id,
            onEdit: openRepoEdit, onToggle: toggleRepo }))))
        : h(EmptyState, { icon: 'pull', title: pt(t, 'repos.empty'),
          action: h('div', { className: 'sa-actions' },
            config.file ? h(CopyButton, { value: config.file, label: pt(t, 'st.copyConfigPath') }) : null,
            h(Button, { variant: 'outline', size: 'sm',
              onClick: () => setConfigSampleOpen(true) }, pt(t, 'repos.emptyAction'))) }),
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
    if ('executor.timeoutMs' in patch
      && (!Number.isFinite(patch['executor.timeoutMs']) || patch['executor.timeoutMs'] < 60_000
        || patch['executor.timeoutMs'] > 86_400_000)) {
      setSaveErrors(previous => ({ ...previous, [group]: { error: new Error(pt(t, 'st.timeoutInvalid')) } }))
      return
    }
    if ('executor.maxRepairRounds' in patch && (!Number.isInteger(patch['executor.maxRepairRounds'])
      || patch['executor.maxRepairRounds'] < 0 || patch['executor.maxRepairRounds'] > 6)) {
      setSaveErrors(previous => ({ ...previous, [group]: { error: new Error(pt(t, 'st.repairBudgetInvalid')) } }))
      return
    }
    if ('review.expireHours' in patch && (!Number.isInteger(patch['review.expireHours'])
      || patch['review.expireHours'] < 1 || patch['review.expireHours'] > 168)) {
      setSaveErrors(previous => ({ ...previous, [group]: { error: new Error(pt(t, 'st.reviewExpireInvalid')) } }))
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

  /** Write-only Octo token editor. An env-provided token is shown as read-only, because the file cannot override it. */
  const renderOctoToken = () => {
    const configured = octo.tokenConfigured === true
    const tokenSource = octo.tokenSource
    return h('div', { className: 'sa-field', id: 'sa-settings-octo-token' },
      h('span', { className: 'sa-field-head' }, pt(t, 'st.octoToken'),
        configured
          ? h(Tag, { tone: tokenSource === 'env' ? 'info' : 'success' },
            tokenSource === 'env' ? pt(t, 'st.octoTokenEnv') : pt(t, 'st.tokenOk'))
          : h(Tag, { tone: 'outline' }, pt(t, 'st.tokenMissing'))),
      tokenSource === 'env'
        ? h(Hint, null, pt(t, 'st.octoTokenEnvHint'))
        : h(Fragment, null,
          h('div', { style: { display: 'flex', maxWidth: '560px', minWidth: 0, gap: 'var(--sa-sp-8)', flexWrap: 'wrap' } },
            h('div', { style: { flex: '1 1 240px', minWidth: 0, display: 'flex' } },
              h(Input, { className: 'sa-input-full', type: 'password', value: octoTokenDraft, autoComplete: 'off',
                placeholder: pt(t, 'st.octoTokenPlaceholder'), 'aria-label': pt(t, 'st.octoTokenPlaceholder'),
                disabled: octoTokenBusy,
                onChange: event => setOctoTokenDraft(event.target.value) })),
            h(Button, { variant: 'outline', size: 'sm', disabled: octoTokenBusy || !octoTokenDraft.trim(),
              onClick: () => { void saveOctoTokenFor(octoTokenDraft) } },
            octoTokenBusy ? t('saving') : pt(t, 'st.octoTokenSave')),
            configured
              ? h(ConfirmButton, { label: pt(t, 'repos.tokenClear'), title: pt(t, 'st.octoTokenClearTitle'),
                message: pt(t, 'st.octoTokenClearMessage'),
                onConfirm: async () => { if (!octoTokenBusy) await saveOctoTokenFor('') } })
              : null),
          h(Hint, null, pt(t, 'st.octoTokenHint'))))
  }

  /** Searchable group picker: fills the binding form, never writes a binding by itself. */
  const renderGroupPicker = () => {
    const watched = new Set(Array.isArray(octo.watchChatIds) ? octo.watchChatIds : [])
    const query = octoGroupQuery.trim().toLowerCase()
    const items = (octoGroups.items ?? []).filter(group => !query
      || String(group.name ?? '').toLowerCase().includes(query) || String(group.id ?? '').toLowerCase().includes(query))
    return h('div', { className: 'sa-group-picker' },
      h('div', { className: 'sa-group-picker-head' },
        h(Input, { value: octoGroupQuery, placeholder: pt(t, 'st.groupsSearch'), 'aria-label': pt(t, 'st.groupsSearch'),
          onChange: event => setOctoGroupQuery(event.target.value) }),
        h('span', { className: 'sa-hint' }, pt(t, 'st.groupsCount', { count: items.length }))),
      octoGroups.busy
        ? h(Hint, null, pt(t, 'st.groupsLoading'))
        : octoGroups.error
          ? h('p', { className: 'sa-error', role: 'alert' }, octoGroups.error)
          : items.length
            ? h('ul', { className: 'sa-list' }, items.map(group => h('li', { key: String(group.id) },
              h('button', { type: 'button', className: 'sa-group-option', disabled: watched.has(String(group.id)),
                onClick: () => chooseGroup(group) },
              h('span', { className: 'sa-group-option-main' },
                h('span', { className: 'sa-group-option-name' }, group.name || String(group.id)),
                h('span', { className: 'sa-mono sa-hint' }, String(group.id))),
              watched.has(String(group.id))
                ? h(Tag, { tone: 'success' }, pt(t, 'st.groupsWatched'))
                : h(Icon, { name: 'plus', size: 14 })))))
            : h(Hint, null, pt(t, 'st.groupsEmpty')))
  }

  /** Sender allowlist: editable when "accept any human" is off; ignored (and explained) while it is on. */
  const renderSenders = () => {
    const draft = drafts.source ?? {}
    const allowAnyHuman = 'octo.allowAnyHuman' in draft ? draft['octo.allowAnyHuman'] : octo.allowAnyHuman === true
    const senders = senderValuesOf(draft)
    const list = senders.length
      ? h('div', { className: 'sa-sender-list' }, senders.map(sender => h('span', { key: sender, className: 'sa-sender-chip' },
        h('span', { className: 'sa-mono' }, sender),
        h('button', { type: 'button', className: 'sa-sender-remove', 'aria-label': pt(t, 'st.removeSender', { sender }),
          onClick: () => removeSender(sender) }, '×'))))
      : h(Hint, null, pt(t, 'st.sendersEmpty'))
    const add = h('div', { className: 'sa-actions' },
      h('div', { style: { flex: '1 1 240px', minWidth: 0, display: 'flex' } },
        h(Input, { className: 'sa-input-full', value: senderDraft, placeholder: pt(t, 'st.senderPlaceholder'),
          'aria-label': pt(t, 'st.senderPlaceholder'), disabled: savingGroup === 'source',
          onChange: event => setSenderDraft(event.target.value),
          onKeyDown: event => { if (event.key === 'Enter') { event.preventDefault(); addSender() } } })),
      h(Button, { variant: 'outline', size: 'sm', disabled: savingGroup === 'source' || !senderDraft.trim(),
        onClick: addSender }, pt(t, 'st.addSender')))
    return h('div', { className: 'sa-field' },
      h('span', { className: 'sa-field-head' }, pt(t, 'st.senders'),
        allowAnyHuman ? h(Tag, { tone: 'info' }, pt(t, 'st.allHumans')) : null),
      allowAnyHuman ? h(Hint, null, pt(t, 'st.anyHumanSendersHint')) : h(Fragment, null, list, add),
      allowAnyHuman ? null : h(Hint, null, pt(t, 'st.sendersHint')))
  }

  // ---- source group -----------------------------------------------------------------------------------------
  const renderSource = () => {
    const draft = drafts.source ?? {}
    const enabled = 'enabled' in draft ? draft.enabled : config.enabled === true
    const allowAnyHuman = 'octo.allowAnyHuman' in draft ? draft['octo.allowAnyHuman'] : octo.allowAnyHuman === true
    const pollSeconds = 'pollSeconds' in draft ? draft.pollSeconds : String(config.pollSeconds ?? '')
    const chatIds = Array.isArray(octo.watchChatIds) ? octo.watchChatIds : []
    const chatNames = chatIds.map(id => octo.chatTitles?.[id] ?? id)
    const senders = senderValuesOf(draft)
    const cursors = engine.channelCursors ?? {}
    const cursorRows = Object.entries(cursors).map(([chat, seq]) => `${octo.chatTitles?.[chat] ?? chat} · ${seq}`)
    const rows = [
      [pt(t, 'st.watchChats'), chatNames.length ? chatNames.join(t('listSeparator')) : t('empty')],
      [pt(t, 'st.cursors'), cursorRows.length ? cursorRows.join(t('listSeparator')) : t('empty')],
      [pt(t, 'st.lastPoll'), engine.lastPollAt ? h(When, { at: engine.lastPollAt }) : t('empty')],
    ]
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.sourceHint')),
      renderOctoToken(),
      h(SettingsSwitchRow, { label: pt(t, 'st.enabled'), hint: pt(t, 'st.enabledHint'), checked: enabled,
        disabled: savingGroup === 'source',
        onChange: next => editField('source', 'enabled', next, config.enabled === true) }),
      h(SettingsSwitchRow, { label: pt(t, 'st.allowAnyHuman'), hint: pt(t, 'st.allowAnyHumanHint'), checked: allowAnyHuman,
        disabled: savingGroup === 'source',
        onChange: next => editField('source', 'octo.allowAnyHuman', next, octo.allowAnyHuman === true) }),
      renderSenders(),
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
      h('div', { className: 'sa-field', id: 'sa-settings-bindings' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.bindings')),
        h(Hint, null, pt(t, 'st.bindingsHint')),
        h('div', { className: 'sa-actions', style: { marginTop: 'var(--sa-sp-4)' } },
          h(Button, { variant: 'outline', size: 'sm', icon: h(Icon, { name: 'message', size: 14 }),
            disabled: octoGroups.busy || bindingBusy, onClick: () => { void loadOctoGroups() } },
          octoGroups.busy ? pt(t, 'st.groupsLoading') : pt(t, 'st.groupsPick')),
          octoGroups.open
            ? h(Button, { variant: 'ghost', size: 'sm', onClick: () => setOctoGroups(previous => ({ ...previous, open: false, error: undefined })) },
              pt(t, 'st.groupsClose'))
            : null),
        octoGroups.open ? renderGroupPicker() : null,
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
      : mode === 'shadow' ? pt(t, 'st.modeShadow')
      : mode === 'hybrid' ? pt(t, 'st.modeHybrid')
      : mode === 'llm' ? pt(t, 'st.modeLlm') : mode ? pt(t, 'st.modeUnknown', { mode }) : t('empty')
    const rules = Array.isArray(data.eval?.rules) ? data.eval.rules : []
    const decision = data.eval?.decision ?? {}
    const judge = data.eval?.judge ?? {}
    const configured = value => value ? pt(t, 'st.configured') : pt(t, 'st.notConfigured')
    const rows = [
      [pt(t, 'st.evalMode'), modeText],
      [pt(t, 'st.judgeEndpoint'), configured(decision.endpointConfigured)],
      [pt(t, 'st.judgeModel'), decision.model || t('empty')],
      [pt(t, 'st.judgeToken'), configured(decision.tokenConfigured)],
      [pt(t, 'st.judgeCalls'), `${judge.calls ?? 0} / ${judge.ok ?? 0} / ${judge.errors ?? 0} / ${judge.skipped ?? 0}`],
      [pt(t, 'st.decisionsTotal'), String(data.counts?.decisions ?? 0)],
      [pt(t, 'st.decisions24h'), String(data.flow24h?.judged ?? 0)],
    ]
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.evalHint')),
      h(KeyValues, { rows }),
      h(Hint, null, pt(t, 'st.judgeHint')),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.rules')),
        rules.length
          ? h(KeyValues, { rows: rules.map(rule => [`${rule.id} · ${rule.name}`, rule.description]) })
          : h(Hint, null, pt(t, 'st.noRules'))))
  }

  // ---- review group: the group-confirmation loop (who may answer, scope, expiry) --------------------------------
  const renderReview = () => {
    const draft = drafts.review ?? {}
    const field = (key, fallback) => key in draft ? draft[key] : fallback
    const frozen = savingGroup === 'review'
    const review = data.review ?? {}
    const counts = review.counts ?? {}
    const initialSenders = Array.isArray(review.allowSenderIds) ? review.allowSenderIds.join(', ') : ''
    const senders = field('review.allowSenderIds', initialSenders)
    const expireHours = field('review.expireHours', String(review.expireHours ?? 24))
    const scope = field('review.scope', review.scope === 'uncertain' ? 'uncertain' : 'all')
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.reviewIntro')),
      h(SettingsSwitchRow, { label: pt(t, 'st.reviewEnabled'), hint: pt(t, 'st.reviewEnabledHint'),
        checked: Boolean(field('review.enabled', review.enabled === true)), disabled: frozen,
        onChange: next => editField('review', 'review.enabled', next, review.enabled === true) }),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.reviewScope')),
        h(Select, { label: pt(t, 'st.reviewScope'), disabled: frozen, value: scope,
          options: [{ value: 'all', label: pt(t, 'st.reviewScopeAll') },
            { value: 'uncertain', label: pt(t, 'st.reviewScopeUncertain') }],
          onChange: next => editField('review', 'review.scope', next, review.scope === 'uncertain' ? 'uncertain' : 'all') })),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.reviewSenders')),
        h('div', { style: { display: 'flex', maxWidth: '520px', minWidth: 0 } },
          h(Input, { value: String(senders ?? ''), disabled: frozen, 'aria-label': pt(t, 'st.reviewSenders'),
            onChange: event => editField('review', 'review.allowSenderIds', event.target.value, initialSenders) })),
        h(Hint, null, pt(t, 'st.reviewSendersHint'))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.reviewExpire')),
        h('div', { style: { display: 'flex', maxWidth: '220px', minWidth: 0 } },
          h(Input, { type: 'number', min: 1, max: 168, step: 1, value: String(expireHours), disabled: frozen,
            'aria-label': pt(t, 'st.reviewExpire'),
            onChange: event => editField('review', 'review.expireHours', event.target.value, String(review.expireHours ?? 24)) })),
        h(Hint, null, pt(t, 'st.reviewExpireHint'))),
      h(KeyValues, { rows: [
        [pt(t, 'st.reviewSummary', { pending: counts.pending ?? 0, answered: counts.answered ?? 0 }), ''],
      ] }),
      h(Hint, null, pt(t, 'st.reviewExample')),
      saveBarFor('review'))
  }

  // ---- run group: the executor master switch, how it runs and the manual ticket form -------------------------
  const renderRun = () => {
    const draft = drafts.run ?? {}
    const field = (key, fallback) => key in draft ? draft[key] : fallback
    const frozen = savingGroup === 'run'
    const gates = Array.isArray(executor.gates) ? executor.gates : []
    const gateText = gates.length ? gates.map(gate => settingsGateLabel(t, gate)).join(t('listSeparator')) : t('empty')
    const timeout = Number(executor.timeoutMs)
    const timeoutMinutes = Number.isFinite(timeout) ? Math.round(timeout / 60000) : 25
    // One budget shared by gate auto-repair and the staged review loop (0..6, default 2).
    const repairBudget = Number.isFinite(Number(executor.maxRepairRounds)) ? Number(executor.maxRepairRounds) : 2
    const rows = [
      [pt(t, 'st.gates'), gateText],
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
      switchRow('pausedIntake', 'st.pausedIntake', 'st.pausedIntakeHint', config.pausedIntake === true),
      switchRow('pausedDispatch', 'st.pausedDispatch', 'st.pausedDispatchHint', config.pausedDispatch === true),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.mrMode')),
        h(Select, { label: pt(t, 'st.mrMode'), disabled: frozen,
          value: field('gitlab.createMr', gitlab.createMr === 'push' ? 'push' : 'api'),
          options: [{ value: 'api', label: pt(t, 'st.mrModeApi') }, { value: 'push', label: pt(t, 'st.mrModePush') }],
          onChange: next => editField('run', 'gitlab.createMr', next, gitlab.createMr === 'push' ? 'push' : 'api') }),
        h(Hint, null, pt(t, 'st.mrModeHint'))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.timeout')),
        h('div', { style: { display: 'flex', maxWidth: '200px', minWidth: 0 } },
          h(Input, { type: 'number', min: 1, max: 1440, step: 1,
            value: Number.isFinite(Number(field('executor.timeoutMs', timeout))) && field('executor.timeoutMs', timeout) !== ''
              ? Math.round(Number(field('executor.timeoutMs', timeout)) / 60000) : '',
            disabled: frozen, 'aria-label': pt(t, 'st.timeout'),
            placeholder: String(timeoutMinutes),
            onChange: event => {
              const raw = event.target.value
              editField('run', 'executor.timeoutMs', raw === '' ? '' : Number(raw) * 60000, timeout)
            } })),
        h(Hint, null, pt(t, 'st.timeoutHint'))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.repairBudget')),
        h('div', { style: { display: 'flex', maxWidth: '200px', minWidth: 0 } },
          h(Input, { type: 'number', min: 0, max: 6, step: 1,
            value: field('executor.maxRepairRounds', repairBudget) === '' ? ''
              : String(field('executor.maxRepairRounds', repairBudget)),
            disabled: frozen, 'aria-label': pt(t, 'st.repairBudget'),
            placeholder: String(repairBudget),
            onChange: event => {
              const raw = event.target.value
              editField('run', 'executor.maxRepairRounds', raw === '' ? '' : Number(raw), repairBudget)
            } })),
        h(Hint, null, pt(t, 'st.repairBudgetHint'))),
      h(KeyValues, { rows }),
      // The manual Ticket form is the same component the Execution page opens in its dialog (34-live-ui.js): one set
      // of fields, one write path, one success/error treatment. The inline form resets itself after each creation.
      h(ManualTicketForm, { onDone: () => { void reload() } }),
      saveBarFor('run'))
  }

  // ---- worker group: routing mode, enabled backends, work-type preferences and the capability matrix ----------
  const renderWorker = () => {
    const draft = drafts.worker ?? {}
    const frozen = savingGroup === 'worker'
    const legacyBackend = ['dsh', 'codex', 'claude'].includes(executor.workerBackend) ? executor.workerBackend : 'dsh'
    const baseWorkers = executor.workers && typeof executor.workers === 'object'
      ? executor.workers : { [legacyBackend]: { enabled: true } }
    const baseRouting = executor.routing && typeof executor.routing === 'object' ? executor.routing : {}
    const workers = draft['executor.workers'] ?? baseWorkers
    const routing = draft['executor.routing'] ?? baseRouting
    const enabled = ROUTE_BACKENDS.map(backend => backend.value)
      .filter(backend => backend in workers && workers[backend]?.enabled !== false)
    const visible = (routing.mode ?? (enabled.length > 1 ? 'suggest' : 'single'))
    const defaultBackend = enabled.includes(routing.defaultBackend) ? routing.defaultBackend
      : enabled.includes(legacyBackend) ? legacyBackend : enabled[0] ?? 'dsh'
    const fallback = enabled.includes(routing.fallback?.[0]) ? routing.fallback[0] : ''
    const preferences = Array.isArray(routing.preferences) ? routing.preferences : ROUTE_DEFAULT_PREFERENCES
    const backendOptions = ROUTE_BACKENDS.map(backend => ({ value: backend.value, label: pt(t, backend.labelKey) }))
    const stagedOptions = (choices, current) => choices
      .filter(choice => enabled.includes(choice.value) || choice.value === current)
      .map(choice => ({ ...choice, disabled: !enabled.includes(choice.value) }))
    const editWorkers = next => editField('worker', 'executor.workers', next, baseWorkers)
    const editRouting = next => editField('worker', 'executor.routing', next, baseRouting)
    const setRouting = next => editRouting({ ...routing, ...next })
    const toggleBackend = (backend, on) => editWorkers({ ...workers, [backend]: { ...(workers[backend] ?? {}), enabled: on } })
    const setBackendField = (backend, key, value) => editWorkers({ ...workers, [backend]: { ...(workers[backend] ?? {}), [key]: value } })
    const preferenceOf = type => preferences.find(rule => Array.isArray(rule.workTypes) && rule.workTypes.includes(type))?.backend ?? ''
    const setPreference = (type, backend) => {
      const rules = preferences.map(rule => ({ workTypes: [...(rule.workTypes ?? [])].filter(item => item !== type), backend: rule.backend }))
      if (backend) {
        const existing = rules.find(rule => rule.backend === backend)
        if (existing) existing.workTypes.push(type)
        else rules.push({ workTypes: [type], backend })
      }
      setRouting({ preferences: rules.filter(rule => rule.workTypes.length) })
    }
    const backendCard = backend => {
      const entry = workers[backend.value] ?? {}
      const on = backend.value in workers && entry.enabled !== false
      return h('div', { key: backend.value, className: 'sa-field' },
        h(SettingsSwitchRow, { label: pt(t, backend.labelKey), hint: pt(t, backend.hintKey), disabled: frozen,
          checked: on, onChange: next => toggleBackend(backend.value, next) }),
        backend.value === 'dsh' ? null : h(Fragment, null,
          h('div', { style: { display: 'flex', gap: 'var(--sa-sp-8)', flexWrap: 'wrap', maxWidth: '560px', minWidth: 0 } },
            h('div', { style: { flex: '1 1 180px', minWidth: 0, display: 'flex' } },
              h(Input, { className: 'sa-input-full', value: entry.model ?? '', disabled: frozen,
                placeholder: pt(t, 'st.workerModel'), 'aria-label': pt(t, 'st.workerModel'),
                onChange: event => setBackendField(backend.value, 'model', event.target.value) })),
            h('div', { style: { flex: '1 1 240px', minWidth: 0, display: 'flex' } },
              h(Input, { className: 'sa-input-full', value: entry.command ?? '', disabled: frozen,
                placeholder: pt(t, 'st.workerCommand'), 'aria-label': pt(t, 'st.workerCommand'),
                onChange: event => setBackendField(backend.value, 'command', event.target.value) }))),
          h(Hint, null, pt(t, 'st.workerModelHint'))))
    }
    return h('div', { className: 'sa-settings-group' },
      settingsHeading(),
      h(Hint, null, pt(t, 'st.workerHint')),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'wf.title')),
        h(Select, { label: pt(t, 'wf.title'), disabled: frozen,
          value: draft['executor.workflowMode'] ?? executor.workflowMode ?? 'off',
          options: ['off', 'auto', 'simple', 'planned'].map(value => ({ value, label: pt(t, `wf.${value}`) })),
          onChange: value => editField('worker', 'executor.workflowMode', value, executor.workflowMode ?? 'off') }),
        h(Hint, null, pt(t, 'wf.hint')),
        h('span', { className: 'sa-field-head' }, pt(t, 'wf.implementer')),
        h(Select, { label: pt(t, 'wf.implementer'), disabled: frozen,
          value: draft['executor.implementer'] ?? executor.implementer ?? 'dsh',
          options: stagedOptions(STAGED_IMPLEMENTERS, draft['executor.implementer'] ?? executor.implementer ?? 'dsh'),
          onChange: value => editField('worker', 'executor.implementer', value, executor.implementer ?? 'dsh') }),
        h('span', { className: 'sa-field-head' }, pt(t, 'wf.reviewer')),
        h(Select, { label: pt(t, 'wf.reviewer'), disabled: frozen,
          value: draft['executor.reviewer'] ?? executor.reviewer ?? 'codex',
          options: stagedOptions(STAGED_REVIEWERS, draft['executor.reviewer'] ?? executor.reviewer ?? 'codex'),
          onChange: value => editField('worker', 'executor.reviewer', value, executor.reviewer ?? 'codex') }),
        h(Hint, null, pt(t, 'wf.reviewerHint')),
        h('span', { className: 'sa-field-head' }, pt(t, 'wf.workerPreset')),
        h(Input, { value: draft['executor.workerPreset'] ?? executor.workerPreset ?? '', disabled: frozen,
          placeholder: pt(t, 'wf.workerPresetPlaceholder'), 'aria-label': pt(t, 'wf.workerPreset'),
          onChange: event => editField('worker', 'executor.workerPreset', event.target.value, executor.workerPreset ?? '') }),
        h(Hint, null, pt(t, 'wf.workerPresetHint'))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.routingTitle')),
        h(Select, { label: pt(t, 'st.routingTitle'), disabled: frozen, value: visible,
          options: [{ value: 'single', label: pt(t, 'st.routingModeSingle') },
            { value: 'suggest', label: pt(t, 'st.routingModeSuggest') },
            { value: 'auto', label: pt(t, 'st.routingModeAuto') }],
          onChange: next => setRouting({ mode: next }) }),
        h(Hint, null, pt(t, 'st.routingModeHint'))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.enabledBackends')),
        h(Hint, null, pt(t, 'st.enabledBackendsHint')),
        ROUTE_BACKENDS.map(backendCard)),
      h('div', { style: { display: 'flex', gap: 'var(--sa-sp-16)', flexWrap: 'wrap' } },
        h('div', { className: 'sa-field', style: { flex: '1 1 220px', minWidth: 0 } },
          h('span', { className: 'sa-field-head' }, pt(t, 'st.defaultBackend')),
          h(Select, { label: pt(t, 'st.defaultBackend'), disabled: frozen, value: defaultBackend,
            options: backendOptions, onChange: next => setRouting({ defaultBackend: next }) }),
          h(Hint, null, pt(t, 'st.defaultBackendHint'))),
        h('div', { className: 'sa-field', style: { flex: '1 1 220px', minWidth: 0 } },
          h('span', { className: 'sa-field-head' }, pt(t, 'st.fallbackBackend')),
          h(Select, { label: pt(t, 'st.fallbackBackend'), disabled: frozen, value: fallback,
            options: [{ value: '', label: pt(t, 'st.fallbackNone') }, ...backendOptions],
            onChange: next => setRouting({ fallback: next ? [next] : [] }) }))),
      h('div', { className: 'sa-field' },
        h('span', { className: 'sa-field-head' }, pt(t, 'st.routePreferences')),
        h(Hint, null, pt(t, 'st.routePreferencesHint')),
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-4)' } },
          ROUTE_WORK_TYPES.map(type => h('div', { key: type.key, className: 'sa-switch-row' },
            h('div', { className: 'sa-switch-row-text' },
              h('span', null, pt(t, type.labelKey)),
              h('span', { className: 'sa-hint' }, type.hintKey ? pt(t, type.hintKey) : '')),
            h('div', { style: { flex: '0 0 200px', minWidth: 0 } },
              h(Select, { label: pt(t, type.labelKey), disabled: frozen, value: preferenceOf(type.key),
                options: [{ value: '', label: pt(t, 'st.routeFollowDefault') }, ...backendOptions],
                onChange: next => setPreference(type.key, next) })))))),
      // P2-5: static capability matrix, read-only; highlights the default backend.
      h(WorkerCapabilityCard, { currentBackend: defaultBackend }),
      saveBarFor('worker'))
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
    if (active === 'review') return renderReview()
    if (active === 'eval') return renderEval()
    if (active === 'run') return renderRun()
    if (active === 'worker') return renderWorker()
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

  // AC-10: show what saving will change before the request leaves the panel. Compare against the loaded repository,
  // not the draft, so a no-op save is visibly a no-op and token-only fields never enter the preview.
  const repoEditRows = (() => {
    if (!repoEdit) return []
    const current = repos.find(item => item.id === repoEdit.id) ?? {}
    const rows = []
    const nameNow = current.name ?? current.id
    if (repoEdit.name !== nameNow) rows.push([pt(t, 'repos.field.name'), nameNow, repoEdit.name])
    const repoNow = current.repo ?? ''
    if (repoEdit.repo !== repoNow) rows.push([pt(t, 'repos.field.repo'), repoNow, repoEdit.repo])
    // Field-level gate diff: changing a command, cwd, timeout or failure policy must be visible, not hidden behind an
    // unchanged gate count (review P2 AC-10).
    const gatesBefore = Array.isArray(current.gates) ? current.gates : []
    const gatesAfter = repoEdit.gates
    const count = Math.max(gatesBefore.length, gatesAfter.length)
    for (let index = 0; index < count; index += 1) {
      const before = gatesBefore[index]
      const after = gatesAfter[index]
      if (JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) continue
      rows.push([pt(t, 'repos.gateDiff', { name: after?.name || before?.name || `#${index + 1}` }),
        before ? JSON.stringify(before) : '—', after ? JSON.stringify(after) : '—'])
    }
    return rows
  })()

  return h(Fragment, null,
    h('div', { className: 'sa-settings-intro' },
      h(Hint, null, pt(t, 'st.pageIntro')),
      h('div', { className: 'sa-actions' },
        h(Button, { variant: 'ghost', size: 'sm', icon: h(Icon, { name: 'history', size: 14 }),
          onClick: () => { void openHistory() } }, pt(t, 'st.history')),
        config.file ? h(CopyButton, { value: config.file, label: pt(t, 'st.copyConfigPath') }) : null)),
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
        renderGroup())),
    historyOpen ? h(Modal, { open: true, onClose: () => { if (!historyBusy) setHistoryOpen(false) },
      title: pt(t, 'st.historyTitle'), closeLabel: t('close'), className: 'sa-history-modal',
      footer: h(Button, { variant: 'outline', size: 'sm', disabled: historyBusy,
        onClick: () => setHistoryOpen(false) }, t('close')) },
      h('p', { className: 'sa-hint' }, pt(t, 'st.historyHint')),
      historyError ? h('p', { className: 'sa-error', role: 'alert' }, historyError) : null,
      historyBusy && !historyEntries.length ? h(Hint, null, pt(t, 'st.historyLoading')) : null,
      historyEntries.length
        ? h('div', { className: 'sa-history-list' }, historyEntries.map(entry => h('div', { key: entry.id, className: 'sa-history-row' },
          h('div', { className: 'sa-history-main' },
            h('span', { className: 'sa-history-label' }, historyLabel(entry)),
            h('span', { className: 'sa-hint' }, h(When, { at: entry.at }))),
          h(Button, { variant: 'outline', size: 'sm', disabled: historyBusy,
            onClick: () => { void restoreHistory(entry.id) } }, pt(t, 'st.historyRestore')))))
        : (!historyBusy && !historyError ? h(Hint, null, pt(t, 'st.historyEmpty')) : null)) : null,
    repoEdit ? h(Modal, { open: true, onClose: () => { if (!repoEditBusy) setRepoEdit(undefined) },
      title: pt(t, 'repos.editTitle', { name: repoEdit.name || repoEdit.id }), closeLabel: t('close'), className: 'sa-repo-modal',
      footer: h(Fragment, null,
        h(Button, { variant: 'ghost', disabled: repoEditBusy, onClick: () => setRepoEdit(undefined) }, t('cancel')),
        h(Button, { variant: 'primary', disabled: repoEditBusy, onClick: () => { void saveRepoEdit() } },
          repoEditBusy ? t('saving') : t('save'))) },
      h('p', { className: 'sa-hint' }, pt(t, 'repos.editHint')),
      h('div', { className: 'sa-repo-diff' },
        h('span', { className: 'sa-field-head' }, pt(t, 'repos.editDiff')),
        repoEditRows.length
          ? repoEditRows.map(([label, before, after], index) => h('div', { key: index, className: 'sa-diff-row' },
            h('span', { className: 'sa-diff-label' }, label),
            h('code', { className: 'sa-mono sa-diff-old' }, before || '—'),
            h('span', { className: 'sa-hint', 'aria-hidden': 'true' }, '→'),
            h('code', { className: 'sa-mono sa-diff-new' }, after || '—')))
          : h('p', { className: 'sa-hint' }, pt(t, 'repos.editNoChanges'))),
      h('div', { className: 'sa-form-grid' },
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.name')),
          h(Input, { className: 'sa-input-full', value: repoEdit.name, 'aria-label': pt(t, 'repos.field.name'),
            onChange: event => setRepoEdit(previous => ({ ...previous, name: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.repo')),
          h(Input, { className: 'sa-input-full', value: repoEdit.repo, 'aria-label': pt(t, 'repos.field.repo'),
            onChange: event => setRepoEdit(previous => ({ ...previous, repo: event.target.value })) })),
        h('div', { className: 'sa-field', style: { gridColumn: '1 / -1' } },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.gates')),
          repoEdit.gates.length
            ? repoEdit.gates.map((gate, index) => h('div', { key: index, className: 'sa-card',
              style: { marginBottom: 8, padding: 10 } },
              h('div', { className: 'sa-form-grid' },
                h('label', { className: 'sa-field' },
                  h('span', { className: 'sa-field-head' }, pt(t, 'repos.gateName')),
                  h(Input, { className: 'sa-input-full', value: gate.name ?? '', 'aria-label': pt(t, 'repos.gateName'),
                    onChange: event => editGate(index, 'name', event.target.value) })),
                h('label', { className: 'sa-field' },
                  h('span', { className: 'sa-field-head' }, pt(t, 'repos.gateCommand')),
                  h(Input, { className: 'sa-input-full', value: gate.command ?? '', 'aria-label': pt(t, 'repos.gateCommand'),
                    onChange: event => editGate(index, 'command', event.target.value) })),
                h('label', { className: 'sa-field' },
                  h('span', { className: 'sa-field-head' }, pt(t, 'repos.gateCwd')),
                  h(Input, { className: 'sa-input-full', value: gate.cwd ?? '', placeholder: pt(t, 'repos.gateCwdPlaceholder'),
                    'aria-label': pt(t, 'repos.gateCwd'), onChange: event => editGate(index, 'cwd', event.target.value) })),
                h('label', { className: 'sa-field' },
                  h('span', { className: 'sa-field-head' }, pt(t, 'repos.gateTimeout')),
                  h(Input, { className: 'sa-input-full', type: 'number', min: 1, value: gate.timeoutMs ?? '',
                    'aria-label': pt(t, 'repos.gateTimeout'),
                    onChange: event => editGate(index, 'timeoutMs', event.target.value) })),
                h(Select, { label: pt(t, 'repos.gateOnFail'), value: gate.onFail ?? 'manual',
                  options: [{ value: 'manual', label: pt(t, 'repos.gateOnFail.manual') },
                    { value: 'auto_repair', label: pt(t, 'repos.gateOnFail.auto_repair') }],
                  onChange: value => editGate(index, 'onFail', value) }),
                h('label', { className: 'sa-field' },
                  h('span', { className: 'sa-field-head' }, pt(t, 'repos.gateDryRun')),
                  h(Input, { className: 'sa-input-full', value: gate.dryRunCommand ?? '',
                    'aria-label': pt(t, 'repos.gateDryRun'), onChange: event => editGate(index, 'dryRunCommand', event.target.value) }))),
              h(Button, { variant: 'ghost', size: 'sm', onClick: () => setRepoEdit(previous => ({ ...previous,
                gates: previous.gates.filter((item, position) => position !== index) })) }, pt(t, 'repos.gateRemove'))))
            : h('p', { className: 'sa-hint' }, pt(t, 'repos.gateEmptyEditor')),
          h(Button, { variant: 'outline', size: 'sm', onClick: () => setRepoEdit(previous => ({ ...previous,
            gates: [...previous.gates, { name: '', command: '', onFail: 'manual' }] })) }, pt(t, 'repos.gateAdd')),
          h('small', { className: 'sa-hint' }, pt(t, 'repos.gatesJsonHint')))),
      repoEditError ? h('p', { className: 'sa-banner sa-danger' }, repoEditError) : null) : null,
    repoModalOpen ? h(Modal, { open: true, onClose: () => { if (!repoSaving) setRepoModalOpen(false) },
      title: pt(t, 'repos.addTitle'), closeLabel: t('close'), className: 'sa-repo-modal',
      footer: h(Fragment, null,
        h(Button, { variant: 'ghost', disabled: repoSaving, onClick: () => setRepoModalOpen(false) }, t('cancel')),
        h(Button, { variant: 'primary', disabled: repoSaving, onClick: () => { void submitRepo() } },
          repoSaving ? t('saving') : pt(t, 'repos.add'))) },
      h('p', { className: 'sa-hint' }, pt(t, 'repos.addHint')),
      h('div', { className: 'sa-form-grid' },
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.id')),
          h(Input, { className: 'sa-input-full', value: repoForm.id, 'aria-label': pt(t, 'repos.field.id'),
            onChange: event => setRepoForm(previous => ({ ...previous, id: event.target.value })) }),
          h('small', { className: 'sa-hint' }, pt(t, 'repos.field.idHint'))),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.name')),
          h(Input, { className: 'sa-input-full', value: repoForm.name, 'aria-label': pt(t, 'repos.field.name'),
            onChange: event => setRepoForm(previous => ({ ...previous, name: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.kind')),
          h(Select, { label: pt(t, 'repos.field.kind'), value: repoForm.kind,
            options: [{ value: 'web', label: pt(t, 'repos.kindWeb') }, { value: 'oracle-ebs', label: pt(t, 'repos.kindEbs') }],
            onChange: next => setRepoForm(previous => ({ ...previous, kind: next,
              verifyMode: next === 'oracle-ebs' ? 'manual' : 'web-uat',
              acceptance: next === 'oracle-ebs' ? 'merged' : 'deployed' })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.repo')),
          h(Input, { className: 'sa-input-full', value: repoForm.path, 'aria-label': pt(t, 'repos.field.repo'),
            placeholder: '/Users/you/work/my-repo',
            onChange: event => setRepoForm(previous => ({ ...previous, path: event.target.value })) }),
          h('small', { className: 'sa-hint' }, pt(t, 'repos.field.repoHint'))),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.baseBranch')),
          h(Input, { className: 'sa-input-full', value: repoForm.baseBranch, 'aria-label': pt(t, 'repos.field.baseBranch'),
            onChange: event => setRepoForm(previous => ({ ...previous, baseBranch: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.targetBranch')),
          h(Input, { className: 'sa-input-full', value: repoForm.targetBranch, 'aria-label': pt(t, 'repos.field.targetBranch'),
            onChange: event => setRepoForm(previous => ({ ...previous, targetBranch: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.baseUrl')),
          h(Input, { className: 'sa-input-full', value: repoForm.baseUrl, 'aria-label': pt(t, 'repos.field.baseUrl'),
            placeholder: 'https://gitlab.example.com',
            onChange: event => setRepoForm(previous => ({ ...previous, baseUrl: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.project')),
          h(Input, { className: 'sa-input-full', value: repoForm.project, 'aria-label': pt(t, 'repos.field.project'),
            placeholder: 'group/project',
            onChange: event => setRepoForm(previous => ({ ...previous, project: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.verifyMode')),
          h(Select, { label: pt(t, 'repos.field.verifyMode'), value: repoForm.verifyMode,
            options: [{ value: 'web-uat', label: pt(t, 'repos.verifyWebUat') }, { value: 'manual', label: pt(t, 'repos.verifyManual') }],
            onChange: next => setRepoForm(previous => ({ ...previous, verifyMode: next })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.acceptance')),
          h(Select, { label: pt(t, 'repos.field.acceptance'), value: repoForm.acceptance,
            options: [{ value: 'deployed', label: pt(t, 'repos.acceptDeployed') }, { value: 'merged', label: pt(t, 'repos.acceptMerged') }],
            onChange: next => setRepoForm(previous => ({ ...previous, acceptance: next })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.uatUrl')),
          h(Input, { className: 'sa-input-full', value: repoForm.uatUrl, 'aria-label': pt(t, 'repos.field.uatUrl'),
            placeholder: 'https://uat.example.com',
            onChange: event => setRepoForm(previous => ({ ...previous, uatUrl: event.target.value })) })),
        h('label', { className: 'sa-field' },
          h('span', { className: 'sa-field-head' }, pt(t, 'repos.field.healthUrl')),
          h(Input, { className: 'sa-input-full', value: repoForm.healthUrl, 'aria-label': pt(t, 'repos.field.healthUrl'),
            placeholder: 'https://uat.example.com/health',
            onChange: event => setRepoForm(previous => ({ ...previous, healthUrl: event.target.value })) }))),
      h(SettingsSwitchRow, { label: pt(t, 'repos.field.makeDefault'), hint: pt(t, 'repos.field.makeDefaultHint'),
        checked: repoForm.makeDefault, disabled: repoSaving,
        onChange: next => setRepoForm(previous => ({ ...previous, makeDefault: next })) }),
      repoError ? h('p', { className: 'sa-error', role: 'alert' }, repoError) : null) : null,
    configSampleOpen ? h(Modal, { open: true, onClose: () => setConfigSampleOpen(false),
      title: pt(t, 'repos.sampleTitle'), closeLabel: t('close'), className: 'sa-glossary-modal',
      footer: h(Button, { variant: 'outline', size: 'sm', onClick: () => setConfigSampleOpen(false) }, t('close')) },
      h('p', { className: 'sa-hint' }, pt(t, 'repos.sampleHint')),
      h('div', { className: 'sa-md-code' },
        h('div', { className: 'sa-md-code-head' },
          h('span', { className: 'sa-md-code-lang' }, 'live.json'),
          h(CopyButton, { value: REPO_CONFIG_SAMPLE, label: pt(t, 'repos.sampleCopy') })),
        h('pre', { className: 'sa-md-pre' }, REPO_CONFIG_SAMPLE))) : null)
}
