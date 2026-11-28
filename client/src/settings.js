import { API, Icon, hhmmss, hostName, hostOfUrl, panelScroller, scrollPanelTo } from "./util.js"
import { errorText, translate, when } from "./i18n.js"
import { Button, CopyButton, DisclosureRow, InfoTip, Input, Modal, ModelPicker, Select, StatusText, Switch, Tag } from "./controls.js"
import { same, stay, usePanel, usePanelData } from "./api.js"
import { ConfirmButton, EmptyState, ErrorState, ExternalLink, Folded, Hint, KeyValues, RawValue, SaveBar, Section, Skeleton, When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { panelDefaultRepo, panelRepos, repoAcceptanceText, repoVerifyModeText } from "./live-ui.js"
import { gateOnFail } from "./ticket-detail.js"
import { apply } from "./apply.js"
import { React, h, useEffect, useRef, useState } from "./react.js"

Object.assign(PAGE_TEXT, {
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
  'repos.intro': ['执行器使用的代码仓库：本地克隆、分支、闸门、验证与验收方式，以及每个仓库独立的远端令牌。',
    'Code repositories used by the executor: local clone, branches, gates, verification and acceptance, plus one remote token per repository.'],
  'repos.summary': ['{count} 个仓库 · 默认仓库 {default}', '{count} repositories · default {default}'],
  'repos.empty': ['live.json 里还没有仓库；先用示例补一条仓库定义，再回到这里保存 token。',
    'No repository in live.json yet; add one from the example, then come back to save its token.'],
  'repos.emptyAction': ['查看示例', 'View example'],
  'repos.sampleTitle': ['仓库配置示例', 'Repository configuration example'],
  'repos.sampleHint': ['把绝对路径、远端项目与 tokenFile 换成你的值；保存后点「重载配置」。令牌值不要写在这里。',
    'Replace the absolute path, remote project and tokenFile with yours; save, then “Reload config”. Never put the token value here.'],
  'repos.sampleCopy': ['复制示例', 'Copy example'],

  // ---- P2-5: read-only worker backend capability matrix (static, mirrors the actual implementation) --------------
  'st.capTitle': ['运行后端能力', 'Worker capability matrix'],
  'st.capHint': ['当前实现能力，不是产品承诺；后端能力来自各自 CLI/宿主的实际实现，新增后端时需同步更新 README 与本表。',
    'What the current implementation can do — not a product promise. Capabilities come from each CLI/host implementation; update the README and this table when adding a backend.'],
  'st.capLive': ['本机后端是否已安装并核验，以 Bot 页为准。', 'Whether a backend is installed and verified on this machine lives on the Bot page.'],
  'st.capLiveLink': ['打开 Bot 页', 'Open the Bot page'],
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
  'st.capClaudeApproval': ['permission-mode bypassPermissions（工具不设限）', 'permission-mode bypassPermissions (no tool restrictions)'],
  'st.capClaudeResume': ['--resume 续接同一会话', '--resume continues the same session'],
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
  'repos.addHint': ['填写本地路径、远端项目与验证方式；保存后可在这张卡片上保存该仓库的令牌。',
    'Fill in the local path, remote project and verification mode; save the remote token on the new card afterwards.'],
  'repos.saved': ['仓库已添加', 'Repository added'],
  'repos.field.id': ['仓库 id', 'Repository id'],
  'repos.field.idHint': ['小写字母、数字、点、下划线或短横线；创建后不可改。', 'Lowercase letters, digits, dots, underscores or dashes; immutable after creation.'],
  'repos.field.name': ['显示名称', 'Display name'],
  'repos.field.kind': ['仓库类型', 'Repository kind'],
  'repos.field.repo': ['本地路径', 'Local path'],
  'repos.field.repoHint': ['必须是已存在的本地仓库目录。', 'Must be an existing local repository directory.'],
  'repos.field.baseBranch': ['基础分支', 'Base branch'],
  'repos.field.targetBranch': ['目标分支', 'Target branch'],
  'repos.field.baseUrl': ['远端地址', 'Remote base URL'],
  'repos.field.project': ['远端项目', 'Remote project'],
  'repos.field.verifyMode': ['验证方式', 'Verification mode'],
  'repos.field.acceptance': ['验收方式', 'Acceptance'],
  'repos.field.uatUrl': ['UAT 地址（可选）', 'UAT URL (optional)'],
  'repos.field.healthUrl': ['健康检查地址（可选）', 'Health URL (optional)'],
  'repos.field.makeDefault': ['设为默认仓库', 'Make default repository'],
  'repos.field.makeDefaultHint': ['手工建单和未绑定群会使用默认仓库。', 'Manual Tickets and unbound groups use the default repository.'],
  'repos.required': ['请填写此项。', 'This field is required.'],
  'repos.idInvalid': ['只能用小写字母、数字、点、下划线或短横线。', 'Use lowercase letters, digits, dots, underscores or dashes only.'],
  'repos.urlInvalid': ['需要完整的 http(s) 地址。', 'Enter a full http(s) URL.'],
  'repos.fixHint': ['修正标红字段后重试；服务器报错时会给出具体原因。', 'Fix the highlighted fields and try again; a server failure states its reason.'],
  'repos.kindWeb': ['Web / 常规', 'Web'],
  'repos.kindEbs': ['Oracle EBS', 'Oracle EBS'],
  'repos.verifyWebUat': ['Web UAT', 'Web UAT'],
  'repos.verifyManual': ['人工验证（只观察合并）', 'Manual (observe merge only)'],
  'repos.acceptDeployed': ['部署后验收', 'Accept after deploy'],
  'repos.acceptMerged': ['合并后验收', 'Accept after merge'],
  'repos.manageHint': ['自动接单群 → 仓库的绑定在「设置 → 来源」里管理；手工建单在「执行」页选择仓库。',
    'Group → repository bindings live under Settings → Source; manual tickets pick a repository under Settings → Runtime.'],
  'repos.gates': ['闸门', 'Gates'],
  'repos.gatesEmpty': ['默认闸门', 'Default gates'],
  'repos.tokenSaved': ['{name} 的 {host} 令牌已保存', '{host} token saved for {name}'],
  'repos.tokenCleared': ['已清除 {name} 的 {host} 令牌', '{host} token cleared for {name}'],
  'repos.tokenPlaceholder': ['粘贴 {host} 令牌', 'Paste a {host} token'],
  'repos.tokenSave': ['保存令牌', 'Save token'],
  'repos.tokenClear': ['清除令牌', 'Clear token'],
  // Clearing a token stops CI/deploy/UAT observation for that repository, so it asks first and states the consequence
  // (unlike saving, which is reversible by saving again).
  'repos.tokenClearTitle': ['清除这个仓库的 {host} 令牌？', 'Clear the {host} token for this repository?'],
  'repos.tokenClearMessage': ['清除后该仓库的 CI/部署/UAT 观测会停止，直到重新配置令牌；不会影响已合并的工单。',
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
  // shared settingsGroup dictionary (i18n.js keeps source/eval/repos/prompts only).
  'settingsGroup.review': ['评估确认', 'Review'],
  'settingsGroup.run': ['运行', 'Runtime'],
  'settingsGroup.worker': ['Worker', 'Worker'],
  'settingsGroup.dispatch': ['派单', 'Dispatch'],
  'settingsGroup.write': ['写权限', 'Write access'],
  'st.unsaved': ['未保存', 'Unsaved'],
  'st.bindings': ['自动接单群（群 → 仓库）', 'Intake groups (group → repository)'],
  'st.bindingsHint': ['给每个监听群绑定一个仓库；新群可以从群列表选择，也可以手工填写群 ID，保存后按引擎开关状态开始监听。',
    'Bind one repository to each watched group. Add a group from the list or paste a chat id; the engine watches it once enabled and saved.'],
  'st.bindingTitle': ['群名称（可选）', 'Group name (optional)'],
  'st.bindingRepo': ['接单仓库', 'Repository'],
  'st.bindingAdd': ['添加绑定', 'Add binding'],
  'st.bindingRemove': ['移除', 'Remove'],
  'st.bindingsSaveHint': ['监听群的改动随本组「保存」一起提交；保存前会列出高风险变更。',
    'Group changes are saved with this group: the save bar lists the high-risk changes first.'],
  'st.bindingEmpty': ['还没有绑定的群。现有群默认走默认仓库。',
    'No bound group yet. Existing groups fall back to the default repository.'],
  'st.bindingChatRequired': ['请填写群 ID。', 'Enter the group chat ID.'],
  'st.groupsPick': ['从群列表选择', 'Pick from group list'],
  'st.groupsLoading': ['读取群列表…', 'Loading groups…'],
  'st.groupsSearch': ['搜索群名或群 ID…', 'Search group name or group ID…'],
  'st.groupsCount': ['{count} 个群', '{count} groups'],
  'st.groupsEmpty': ['没有可用的群。确认机器人已在群里，或直接填写群 ID。',
    'No group available. Make sure the bot is in a group, or paste a chat id.'],
  'st.groupsWatched': ['已监听', 'Watched'],
  'st.groupsClose': ['收起', 'Collapse'],
  'st.groupsNoToken': ['先保存 Octo 令牌，再读取群列表。', 'Save the Octo token before loading groups.'],
  'st.octoTokenHint': ['保存在本机 token 文件（权限 600），不会回显；读取群列表可验证 token 是否有效。',
    'Stored in the local token file (mode 600) and never echoed; load the group list to verify it.'],
  'st.octoTokenPlaceholder': ['粘贴 Octo token', 'Paste the Octo token'],
  'st.octoTokenSave': ['保存令牌', 'Save token'],
  'st.octoTokenSaved': ['Octo 令牌已保存', 'Octo token saved'],
  'st.octoTokenCleared': ['已清除 Octo 令牌', 'Octo token cleared'],
  'st.octoTokenClearTitle': ['清除 Octo 令牌？', 'Clear the Octo token?'],
  'st.octoTokenClearMessage': ['清除后引擎无法读取群消息，监听、评估与派工都会停止；需要重新粘贴令牌才能恢复。已合并的工单不受影响。',
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
  // R2-04: each row can show the field-level old → new diff behind that save instead of only a timestamp.
  'st.historyChanges': ['查看改动（{count}）', 'Show changes ({count})'],
  'st.historyChangesHide': ['收起改动', 'Hide changes'],
  'st.historyNoChanges': ['这一版没有可对比的字段改动。', 'This version has no comparable field change.'],
  'st.historyOn': ['开', 'On'],
  'st.historyOff': ['关', 'Off'],
  'st.historyUnset': ['（未设置）', '(unset)'],
  'st.historyExpandValue': ['展开全文', 'Show full value'],
  'st.historyCollapseValue': ['收起全文', 'Hide full value'],
  'st.historyChangesTruncated': ['改动较多，只列出前 {count} 项。', 'Many changes; only the first {count} are listed.'],

  // ---- one-line intro hints of the groups (the group name itself lives in the left nav) ----
  'st.sourceHint': ['输入通道：先连接 Octo，再选择监听群、触发人范围与轮询间隔；只读项由宿主状态提供。',
    'Intake: connect Octo first, then choose watched groups, who may trigger work, and the poll interval; read-only values come from the host.'],
  'st.evalHint': ['评估方式、判定模型与规则目录由 live.json 和代码版本决定，这里只读展示。',
    'The evaluation mode, decision model and rule catalog come from live.json and the code version; shown read-only here.'],
  'st.runHint': ['执行器总开关、运行方式、闸门与超时。改完保存后立即生效；手工建单在「执行」页，worker 后端在「Worker」分组。',
    'The executor master switch, how work runs, gates/timeout and the manual Ticket form. Changes apply after saving; the worker backend lives in its own Worker group.'],
  'st.defaultBackend': ['默认后端', 'Default backend'],
  'st.fallbackBackend': ['降级后端（可选）', 'Fallback backend (optional)'],
  'st.fallbackNone': ['不降级', 'No fallback'],
  'st.enabledBackends': ['启用的后端', 'Enabled backends'],
  'st.dispatchHint': ['派单只筛一条硬事实——后端此刻可用；选谁由决策模型读 Bot 自己写的「什么时候派给它」回答。',
    'Dispatch filters on one hard fact — the backend can take work right now — and a judge model picks the bot by reading its own when-to-use note.'],
  'st.dispatchHow': ['怎么决定', 'How it decides'],
  'st.dispatchCandidates': ['候选', 'Candidates'],
  'st.dispatchCandidatesText': ['所有 Bot 里，它自己的后端此刻可用的那些；不看预算、不看能力声明。只写报告的 Bot 也在候选里。',
    'Every bot whose own backend is available right now; budgets and capability declarations are not filters, so a report-only bot still competes.'],
  'st.dispatchPick': ['挑选', 'Pick'],
  'st.dispatchPickText': ['一次模型调用，把候选的说明与工单标题正文给它（截断 4000 字）；它答 {"botId","because"} 或 {"botId":null}。',
    'One model call sees each candidate note and the Ticket text (cut at 4000 characters) and answers {"botId","because"} or {"botId":null}.'],
  'st.dispatchNoModel': ['不调模型', 'No model call'],
  'st.dispatchNoModelText': ['显式指定已命中、候选只有 1 个、或同一工单 {cacheSeconds} 秒内缓存命中。缓存按候选集合与它们的说明 + 工单标题正文算，说明一改旧答案就失效。',
    'An explicit choice hit, only one candidate, or the same Ticket inside the {cacheSeconds}s cache. The cache key covers the candidate set with its notes plus the Ticket text, so editing a note invalidates it.'],
  'st.dispatchFallback': ['失败回退', 'On failure'],
  'st.dispatchFallbackText': ['模型不可用、失败、答了候选之外或认为都不合适 → 一律回退默认 Bot，并把降级原因记在这次运行里，执行页与 Bot 统计都看得到。',
    'Unavailable, failed, answered outside the candidates or found none suitable: all fall back to the default bot, and the reason is recorded on the run and counted in the bot stats.'],
  'st.dispatchDanger': ['危险行为', 'Dangerous actions'],
  'st.dispatchDangerText': ['闸门（standards/backend/frontend）、沙箱与拒绝规则是唯一的裁决权；派单不申请权限，UI 也不承诺隔离。只写报告的 Bot 由执行器置只读，改动不落盘、不提交、不推送。',
    'The gates, the sandbox and the deny rules decide. Dispatch grants no permission and the UI promises no isolation; a report-only bot runs read-only, writing nothing and pushing nothing.'],
  'st.dispatchExplicit': ['显式指定', 'Explicit choice'],
  'st.dispatchExplicitText': ['仓库指定（repos[].bot）与工单手动指定（ticket.botOverride）永远先于挑选；即使后端此刻不可用也不会被静默换人，执行器会带着原因拒绝。',
    'The repository bot and the one-run Ticket override always come before the pick; an explicit choice is never silently swapped, the executor refuses with the reason.'],
  'st.dispatchDefaultNote': ['默认 Bot（{id}）在「Bot」页改；后端可用性在「Worker」组看。',
    'The default bot ({id}) is changed on the Bot page; backend availability lives in the Worker group.'],
  'st.dispatchOpenBots': ['打开 Bot 页', 'Open the Bot page'],
  'st.writeHint': ['执行器对远端仓库和来源群的写权限。关闭时执行器只准备改动：不推送分支、不合并 MR、不回群。',
    'What the executor may write to the remote repository and to the source group. When off it only prepares changes: no branch push, no MR merge, no group reply.'],
  'st.deployHint': ['这里只读展示 live.json 的位置与工作树根目录；项目、分支、令牌、UAT 与健康检查地址在上方仓库列表里逐行编辑。',
    'Read-only facts about where live.json lives and where worktrees go. Edit project, branch, token, UAT and health URLs per repository in the list above.'],

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
  'st.addSender': ['添加', 'Add'],
  'st.removeSender': ['移除发送者 {sender}', 'Remove sender {sender}'],
  'st.anyHumanSendersHint': ['「允许任意人类」已开启，名单暂不参与判断；关闭后可继续编辑名单。',
    '“Accept any human” is on; the list is ignored until you turn it off.'],
  'st.watchChats': ['监听群', 'Watched groups'],
  'st.senders': ['允许发送者', 'Allowed senders'],
  'st.allHumans': ['任意人类', 'Any human'],
  'st.octoToken': ['Octo 令牌', 'Octo token'],
  'st.tokenOk': ['令牌已配置', 'Configured'],
  'st.tokenMissing': ['令牌未配置', 'Token not configured'],
  'st.cursors': ['群游标', 'Group cursors'],
  'st.lastPoll': ['最近轮询', 'Last poll'],
  'st.noSenders': ['没有允许发送者，也没有“允许任意人类”：轮询会被引擎拒绝。',
    'No allowed senders and “accept any human” is off, so the engine rejects polling.'],
  'st.noChats': ['还没有监听群。用「从群列表选择」添加，或手工填写群 ID。',
    'No watched groups yet. Use “Pick from group list”, or paste a chat id.'],
  'st.errBusy': ['已有一次轮询在进行中，请稍后再试。', 'A poll is already running; try again shortly.'],
  'st.errPaused': ['引擎已暂停：非干跑轮询会被拒绝。', 'The engine is paused: a non-dry-run poll is rejected.'],
  'st.errNoConfig': ['live.json 不存在。', 'live.json does not exist.'],
  'st.errDisabled': ['引擎未启用，请先在设置→来源打开「启用引擎」。', 'The engine is disabled; turn on “Engine enabled” under Settings → Source first.'],
  'st.errNoToken': ['Octo 令牌未配置，读不到群消息。', 'The Octo token is missing, so group messages cannot be read.'],
  'st.errNoSender': ['没有允许发送者，也没有“允许任意人类”。', 'No allowed senders and “accept any human” is off.'],
  'st.reloadConfig': ['重载配置', 'Reload config'],
  'st.reloading': ['重载中…', 'Reloading…'],
  'st.senderPlaceholderExample': ['发送者 UID，如 oc_xxxx…', 'Sender UID, e.g. oc_xxxx…'],
  'st.chatIdPlaceholder': ['群 ID，如 oc_xxxx…', 'Group ID, e.g. oc_xxxx…'],
  'st.historyRestoreTitle': ['恢复这个历史版本？', 'Restore this version?'],
  'st.historyRestoreMessage': ['恢复前会先把当前 live.json 备份为「恢复前的备份」，再用所选版本覆盖；正在运行的任务不受影响。',
    'The current live.json is backed up as “before restore” first, then replaced by the chosen version; running work is unaffected.'],
  'st.historyRestoreConfirm': ['恢复并先备份', 'Restore and back up first'],
  'st.bindingRemoveTitle': ['移除这个监听群？', 'Remove this watched group?'],
  'st.bindingRemoveMessage': ['移除后引擎不再读取该群；群游标会保留，重新绑定后从原位置继续。',
    'The engine stops reading this group. Its cursor is kept, so re-binding resumes from the same position.'],
  'st.bindingRemoveConfirm': ['移除绑定', 'Remove binding'],
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
  'st.judgeToken': ['模型令牌', 'Model token'],
  'st.judgeCalls': ['模型调用（总计 / 成功 / 失败 / 跳过）', 'Model calls (total / ok / failed / skipped)'],
  'st.configured': ['已配置', 'Configured'],
  'st.notConfigured': ['未配置', 'Not configured'],
  'st.reviewIntro': ['每条评估都会回发来源群；只有下面列出的操作人回复「接单 ABCD / 忽略 ABCD」才会生效。保存后下一轮轮询生效。',
    'Every evaluation is posted back to its source group; only the operators listed below can answer with “接单 ABCD / 忽略 ABCD”. Applies on the next poll after saving.'],
  'st.reviewSummary': ['评估确认（{pending} 待回复 / {answered} 已回复）', 'Evaluation review ({pending} awaiting / {answered} answered)'],
  'st.reviewEnabled': ['启用评估确认', 'Enable review prompts'],
  'st.reviewEnabledHint': ['关闭后不再发确认消息，已经发出的确认仍可回复。', 'When off, no new prompts are posted; already-posted ones remain answerable.'],
  'st.reviewSenders': ['允许回复的操作人（Octo uid）', 'Operators allowed to answer (Octo uids)'],
  'st.reviewSendersHint': ['逗号或换行分隔；留空表示没有人能回复确认。uid 可从群成员资料或历史消息里查。',
    'Comma or newline separated; empty means nobody can confirm. Find uids in member bots or past messages.'],
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
  'st.evalOpenLedger': ['在评估页查看判定记录', 'See the decision ledger'],

  // ---- execution group ----
  'st.execEnabled': ['启用执行器', 'Executor enabled'],
  'st.execEnabledHint': ['关闭时工单只排队，不运行 worker、不发布 MR。',
    'When off, Tickets only queue: no worker runs and no MR is published.'],
  'st.autoRun': ['自动执行新工单', 'Auto-run new Tickets'],
  'st.autoRunHint': ['新接的工单自动交给执行器；关闭后需要手动干跑或发布。',
    'Newly accepted Tickets go to the executor automatically; when off, run or publish them by hand.'],
  'st.allowPush': ['允许推送分支', 'Allow branch pushes'],
  'st.allowPushHint': ['执行器可以推送分支到远端仓库并创建 MR。', 'The executor may push a branch to the remote and open an MR.'],
  'st.allowMerge': ['允许合并 MR', 'Allow MR merges'],
  'st.allowMergeHint': ['CI 通过后执行器可以直接合并到目标分支。',
    'After CI passes the executor may merge into the target branch.'],
  'st.allowMergeNoToken': ['没有远端令牌，不能合并 MR。', 'Merging an MR needs a remote token.'],
  // High-risk emphasis for allowMerge: the warning tag says what it is, the info tip and the on-state line say what
  // it costs. Turning a high-risk switch ON or OFF is the one save that gets a second confirmation (U-06): the save bar
  // expands a plain-language list of what changes first, and `riskChangesOf` computes it from the two configs locally.
  'st.highRisk': ['高危', 'High risk'],
  'st.riskTitle': ['这次保存会改变高风险设置', 'This save changes high-risk settings'],
  'st.riskIntro': ['以下是保存后会发生的变化，确认后才会写入：', 'These take effect only after you confirm:'],
  'st.riskConfirm': ['确认保存', 'Confirm save'],
  'st.riskCancel': ['取消', 'Cancel'],
  'st.riskEngineOn': ['启用引擎：开始自动轮询群消息、评估并开单', 'Engine on: poll the watched groups, evaluate and open Tickets'],
  'st.riskEngineOff': ['关闭引擎：停止自动轮询（已开的工单保留）',
    'Engine off: polling stops; existing Tickets stay'],
  'st.riskExecOn': ['启用执行器：工单会真正运行 worker', 'Executor on: Tickets actually run a worker'],
  'st.riskExecOff': ['关闭执行器：工单只排队，不再运行 worker', 'Executor off: Tickets only queue'],
  'st.riskAutoRunOn': ['自动执行新工单：接单后立即交给执行器',
    'Auto-run on: newly accepted Tickets go straight to the executor'],
  'st.riskAutoRunOff': ['不再自动执行新工单：需要手动干跑或发布', 'Auto-run off: run or publish by hand'],
  'st.riskPushOn': ['允许推送分支：执行器可以推分支到远端并建 MR',
    'Pushes on: the executor may push branches and open merge requests'],
  'st.riskPushOff': ['不再允许推送分支：执行器只到闸门为止', 'Pushes off: the executor stops after the gates'],
  'st.riskMergeOn': ['允许合并 MR：CI 通过后自动合并到目标分支，不再人工确认',
    'Merges on: a passing CI merges into the target branch without a human'],
  'st.riskMergeOff': ['不再自动合并 MR：合并回到人工', 'Merges off: merging goes back to a person'],
  'st.riskWatchChats': ['监听群变更为 {count} 个群', 'Watched groups change to {count}'],
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
  'st.mrModeHint': ['api：用远端 API 建 MR；push：用 git push options 建 MR。',
    'api: create the MR through the remote API; push: create it with git push options.'],
  'st.mrModeApi': ['远端 API（api）', 'Remote API (api)'],
  'st.mrModePush': ['推送选项（push）', 'Push options (push)'],
  'st.workerBackend': ['Worker 后端', 'Worker backend'],
  'st.workerDsh': ['DSH（进程内）', 'DSH (in-process)'],
  'st.workerCodex': ['Codex CLI（本机）', 'Codex CLI (local)'],
  'st.workerClaude': ['Claude Code CLI（本机）', 'Claude Code CLI (local)'],
  'st.workerBackendHint': ['DSH 在宿主进程内跑；Codex / Claude 在工单 worktree 里拉起本机 CLI 会话。无论哪种，提交、推送、MR、闸门与部署仍由执行器负责。',
    'DSH runs in-process; Codex / Claude start a local CLI session inside the ticket worktree. In every case the executor still owns commit, push, MR, gates and deployment.'],
  'st.workerModel': ['模型', 'Model'],
  'st.workerModelDefault': ['CLI 自己的默认模型', 'CLI default model'],
  'st.workerPathMissing': ['未找到 CLI', 'CLI not found'],
  'st.workerCommand': ['CLI 路径', 'CLI path'],
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
  'st.repairBudgetHint': ['0–6 轮，默认 2。闸门失败时最多自动返工几轮；用完会停下并说明原因。',
    'Rounds from 0 to 6, default 2. How many times a failing gate may send the worker back for repairs; when spent the run stops and says why.'],
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
  'st.deployTitle': ['配置文件与路径', 'Config file & paths'],
  'st.configFile': ['live.json', 'live.json'],
  'st.configExists': ['配置文件', 'Config file'],
  'st.fileExists': ['已找到', 'Found'],
  'st.fileMissing': ['不存在（使用默认值）', 'Missing (defaults in use)'],
  'st.configError': ['live.json 读取失败：', 'Could not read live.json: '],
  'st.httpStatus': ['HTTP {status}', 'HTTP {status}'],
})

/** A copyable, secret-free example of the file-only repository block. */
export const REPO_CONFIG_SAMPLE = `{
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
export const emptyRepoForm = () => ({
  id: '', name: '', kind: 'web', path: '', baseBranch: 'dev', featurePrefix: 'feature/', verifyMode: 'web-uat',
  acceptance: 'deployed', baseUrl: '', project: '', targetBranch: 'dev', uatUrl: '', healthUrl: '', makeDefault: false,
})

/** Group order of the left column; labels come from the shared settingsGroup dictionary in i18n.js, except the
    executor groups whose labels are page-local overrides (settingsGroup.run / settingsGroup.worker /
    settingsGroup.write above).
    `reference: true` marks a read-only group: the rail lists the groups that can be changed first, then a divider and
    the "参考" label, then these. The content column and the save-bar logic are unchanged — only the rail groups them. */
export const SETTINGS_GROUPS = [
  { id: 'source', labelKey: 'settingsGroup.source', icon: 'inbox' },
  { id: 'review', labelKey: 'settingsGroup.review', icon: 'decision' },
  { id: 'eval', labelKey: 'settingsGroup.eval', icon: 'decision', reference: true },
  { id: 'run', labelKey: 'settingsGroup.run', icon: 'play' },
  { id: 'worker', labelKey: 'settingsGroup.worker', icon: 'robot' },
  { id: 'dispatch', labelKey: 'settingsGroup.dispatch', icon: 'decision', reference: true },
  { id: 'write', labelKey: 'settingsGroup.write', icon: 'blocked' },
  { id: 'repos', labelKey: 'settingsGroup.repos', icon: 'pull' },
  { id: 'prompt', labelKey: 'settingsGroup.prompts', icon: 'message', reference: true },
]

/** Only these groups own writable fields, so only they may ever render a save bar. `run`, `worker` and `write` keep
    separate drafts and separate save bars even though all three patch `executor.*`. */
export const SETTINGS_SAVEABLE = ['source', 'review', 'run', 'worker', 'write']

/** Draft mirror for the current tab: a reload or an accidental page switch must not silently drop unsaved edits. */
export const SETTINGS_DRAFT_CACHE = 'superagent-panel/settings-drafts'

export function draftHasKeys(draft) {
  return Boolean(draft && typeof draft === 'object' && Object.keys(draft).length)
}

export function readDraftCache() {
  try {
    const raw = window.sessionStorage.getItem(SETTINGS_DRAFT_CACHE)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return {}
    const restored = {}
    for (const group of SETTINGS_SAVEABLE) {
      if (draftHasKeys(parsed[group])) restored[group] = parsed[group]
    }
    return restored
  } catch { return {} }
}

export function writeDraftCache(drafts) {
  try {
    if (draftHasKeys(drafts)) window.sessionStorage.setItem(SETTINGS_DRAFT_CACHE, JSON.stringify(drafts))
    else window.sessionStorage.removeItem(SETTINGS_DRAFT_CACHE)
  } catch { /* storage can be unavailable (private mode); drafts then stay in memory only */ }
}

export const settingsOmit = (object, key) => {
  const next = { ...(object ?? {}) }
  delete next[key]
  return next
}

/** Scroll a node into view inside the panel, never by moving the host window (scrollIntoView drags the outer frame). */
export const revealNode = node => {
  scrollPanelTo(node, { align: 'center' })
}

/** Draft comparison: booleans by value, numbers/strings by their text form (the number input holds a string). */
/** Draft comparison: booleans by value, objects by JSON, numbers/strings by their text form. */
export function settingsSame(left, right) {
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right)
  if ((left && typeof left === 'object') || (right && typeof right === 'object')) {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null)
  }
  return String(left ?? '') === String(right ?? '')
}

/** Draft (UI values) → the patch the host accepts. Only live-json allow-listed keys are ever sent. */
/* U-06: the switches whose flip changes what the machine does on its own. A save that touches one of them is not a
   copy edit — enabling the engine starts polling real groups, allowMerge merges real branches — so the save bar asks
   for an explicit confirmation listing the changes in words. `octo.watchChatIds` is covered where it is edited (the
   binding rows already confirm a removal). */
export const RISK_FIELDS = [
  { key: 'enabled', on: 'st.riskEngineOn', off: 'st.riskEngineOff' },
  { key: 'executor.enabled', on: 'st.riskExecOn', off: 'st.riskExecOff' },
  { key: 'executor.autoRun', on: 'st.riskAutoRunOn', off: 'st.riskAutoRunOff' },
  { key: 'executor.allowPush', on: 'st.riskPushOn', off: 'st.riskPushOff' },
  { key: 'executor.allowMerge', on: 'st.riskMergeOn', off: 'st.riskMergeOff' },
]
const configAt = (config, path) => path.split('.').reduce((value, key) => (value == null ? undefined : value[key]), config)
/** The high-risk changes a `settingsPatchOf` patch would make, in plain language. Pure and local: no Host round-trip. */
export function riskChangesOf(patch, config) {
  const changes = []
  if (!patch || typeof patch !== 'object') return changes
  for (const field of RISK_FIELDS) {
    if (!Object.hasOwn(patch, field.key)) continue
    const next = patch[field.key] === true
    const current = configAt(config, field.key) === true
    if (next === current) continue
    changes.push({ key: field.key, labelKey: next ? field.on : field.off })
  }
  if (Object.hasOwn(patch, 'octo.watchChatIds')) {
    const next = [...(patch['octo.watchChatIds'] ?? [])].map(String).sort()
    const current = [...(configAt(config, 'octo.watchChatIds') ?? [])].map(String).sort()
    if (next.join() !== current.join()) {
      changes.push({ key: 'octo.watchChatIds', labelKey: 'st.riskWatchChats', values: { count: next.length } })
    }
  }
  return changes
}

/** U-06: whether two `riskChangesOf` lists say the same thing — used to notice that the draft moved while the
 * confirmation was on screen. Compared by identity of the wording, not by array instance. */
export function sameRiskChanges(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  return a.every((change, index) => change.key === b[index].key && change.labelKey === b[index].labelKey
    && (change.values?.count ?? null) === (b[index].values?.count ?? null))
}

export function settingsPatchOf(group, draft) {
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
    // Bindings ride the same draft/save/confirm path as the switches above (review M-4).
    for (const key of ['octo.watchChatIds', 'octo.chatTitles', 'octo.chatRepos']) if (key in draft) patch[key] = draft[key]
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
    // An emptied field means "use the stored value" (the input shows the default as its placeholder); Number('') is 0,
    // which used to persist a zero timeout / zero repair budget (review L-19).
    if ('executor.timeoutMs' in draft && draft['executor.timeoutMs'] !== '') patch['executor.timeoutMs'] = Number(draft['executor.timeoutMs'])
    if ('executor.maxRepairRounds' in draft && draft['executor.maxRepairRounds'] !== '') patch['executor.maxRepairRounds'] = Number(draft['executor.maxRepairRounds'])
    for (const key of ['executor.workerBackend', 'executor.workerModel', 'executor.workerCommand']) {
      if (key in draft) patch[key] = draft[key]
    }
    // P1 multi-backend routing: workers and routing are sent as whole objects by the Worker group.
    if (group === 'worker') {
      for (const key of ['executor.workers', 'executor.routing']) if (key in draft) patch[key] = draft[key]
    }
  }
  return patch
}

/** Human text for the host error codes the poll endpoint reports; unknown codes stay raw in the folded detail. */
export function settingsHostError(t, code) {
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
export function settingsSaveFailure(t, failure) {
  const status = failure?.status
  if (status === 409) return { error: new Error(t('settingsConflict')), raw: errorText(failure) }
  if (status === 0) return { error: new Error(t('offline')), raw: errorText(failure) }
  return { error: failure instanceof Error ? failure : new Error(errorText(failure)) }
}

/** One switch row of a group form: label (+ optional badge and info tip) and explanatory hint on the left, the switch
    on the right. `badge`/`tip` are optional, so the plain rows keep the original single-line label. The hint is tied to
    the switch with aria-describedby, so it is announced with the switch instead of only sitting next to it. */
export let settingsSwitchHintSeq = 0
/** @param {{ label: any, hint?: any, badge?: any, tip?: any, tipWarn?: boolean, checked?: any, disabled?: any,
    onChange?: (checked: boolean) => void }} props */
export function SettingsSwitchRow({ label, hint, badge, tip, tipWarn, checked, disabled, onChange }) {
  const inputRef = useRef(null)
  const seqRef = useRef(null)
  if (seqRef.current === null) { settingsSwitchHintSeq += 1; seqRef.current = settingsSwitchHintSeq }
  const hintId = hint ? `sa-switch-hint-${seqRef.current}` : undefined
  useEffect(() => {
    const node = inputRef.current
    if (!node) return
    if (hintId) node.setAttribute('aria-describedby', hintId)
    else node.removeAttribute('aria-describedby')
  }, [hintId])
  return <label className="sa-switch-row">
    <span className="sa-switch-row-text">
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--sa-sp-8)', flexWrap: 'wrap' }}>
        {label}
        {badge ?? null}
        {tip ? <InfoTip text={tip} warn={tipWarn === true} /> : null}
      </span>
      {/* A <label> may only contain phrasing content, so the hint is a block-level span, not a <p>. */}
      {hint ? <span className="sa-hint" id={hintId} style={{ display: 'block' }}>{hint}</span> : null}
    </span>
    <Switch checked={Boolean(checked)} label={label} disabled={disabled} inputRef={inputRef} onChange={onChange} />
  </label>
}

/** Result line for a one-shot action; the raw error is folded, never a bare stack. It is a polite live region so a
    check/reload/test result is announced when it appears, and aria-busy marks the trigger while work runs. */
/** @param {{ view?: any, note?: any, busy?: any }} props */
export function SettingsStatusLine({ view, note, busy }) {
  const { t } = usePanel()
  if (!view) return null
  return <div className="sa-actions" role="status" aria-live="polite" aria-atomic="true"
    aria-busy={busy ? 'true' : undefined}
    style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 'var(--sa-sp-4)' }}>
    <StatusText state={view.state}>{view.text}</StatusText>
    {note ? <span className="sa-hint">{note}</span> : null}
    {view.raw ? <Folded summary={t('rawError')}><pre className="sa-pre" translate="no">{view.raw}</pre></Folded> : null}
  </div>
}

/** Gate codes render through the shared gate labels when they are known, and stay raw when they are not. */
export function settingsGateLabel(t, gate) {
  const key = `gate.${gate}`
  const label = pt(t, key)
  return label === key ? String(gate) : label
}

/** Gate names use the shared gate dictionary when known; unknown gates stay raw so operators can see them. */
export function repoGateLabel(t, gate) {
  const name = typeof gate === 'string' ? gate : gate?.name
  const key = `gate.${name}`
  const label = pt(t, key)
  return label === key ? String(name) : label
}

/** One repository card: read-only facts plus its own write-only token editor. Saving a token is the reversible edit;
    clearing one stops what the executor can observe for this repository, so it goes through a confirmation that names
    the consequence (C6) — a plain button here used to clear on a single click. */
/** P2-5 capability table: static data describing what each backend actually does today (contract §2). */
export const WORKER_CAP_COLUMNS = [
  { key: 'stream', labelKey: 'st.capStream' },
  { key: 'approval', labelKey: 'st.capApproval' },
  { key: 'resume', labelKey: 'st.capResume' },
  { key: 'diff', labelKey: 'st.capDiff' },
  { key: 'report', labelKey: 'st.capReport' },
]
/** P1 routing controls: the same enums the host validates (routing.js). Labels are page-local i18n keys. */
export const ROUTE_BACKENDS = [
  { value: 'dsh', labelKey: 'st.workerDsh' },
  { value: 'codex', labelKey: 'st.workerCodex' },
  { value: 'claude', labelKey: 'st.workerClaude' },
]
/** Static backend contract; the live question (can it take work right now) lives on the Bot page. */
export const WORKER_CAPABILITIES = [
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
    resume: { yes: true, noteKey: 'st.capClaudeResume' },
    diff: { yes: true, noteKey: 'st.capChangedPaths' },
    report: { yes: false },
  } },
]

export const TEST_LABELS = { config: 'repos.check.config', node: 'repos.check.node', repo: 'repos.check.repo',
  token: 'repos.check.token', connection: 'repos.check.connection', enabled: 'repos.check.enabled' }

/** The read-only facts of one repository card. Exported so the render check asserts the same rows the card draws and
    no page can invent a second wording for them (the Source page used to repeat these rows). */
export function repoFactRows(t, repo) {
  const host = hostName(hostOfUrl(repo?.baseUrl))
  const gates = Array.isArray(repo.gates) ? repo.gates : []
  return [
    [pt(t, 'repo.project', { host }), repo.project ? <span className="sa-mono" translate="no">{String(repo.project)}</span> : t('empty')],
    [pt(t, 'repo.baseUrl', { host }), repo.baseUrl ? <span className="sa-mono" translate="no">{String(repo.baseUrl)}</span> : t('empty')],
    [pt(t, 'repo.localPath'), repo.repo ? <span className="sa-mono" translate="no">{String(repo.repo)}</span> : t('empty')],
    [pt(t, 'repo.branches'), `${repo.baseBranch ?? t('empty')} → ${repo.targetBranch ?? t('empty')}`],
    [pt(t, 'repos.gates'), gates.length ? gates.map(gate => repoGateLabel(t, gate)).join(t('listSeparator')) : pt(t, 'repos.gatesEmpty')],
    [pt(t, 'repo.verifyMode'), repoVerifyModeText(t, repo.verifyMode)],
    [pt(t, 'repo.acceptance'), repoAcceptanceText(t, repo.acceptance)],
  ]
}

export function ReposCard({ repo, isDefault, onSaveToken, onEdit, onToggle, tokenBusy }) {
  // R2-05: a GitHub-backed repository must not be called "GitLab project" on the same card that shows a GitHub URL.
  const host = hostName(hostOfUrl(repo?.baseUrl))
  // The Panel context carries t/call/navigate only; the actions live on the model context (as BotsCard does).
  const { t } = usePanel()
  const { actions } = usePanelData()
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
  const rows = repoFactRows(t, repo)
  // A repository is a configured thing, not a card to browse: one list row per repository (2026-11-24 review). The facts
  // stay on the row as label/value pairs so the list still answers "which project, which branch, which gates" in place.
  return <li className="sa-row sa-repo-row">
    <div className="sa-row-main">
    <div className="sa-card-head">
      <span className="sa-section-icon"><Icon name="pull" size={16} /></span>
      <span className="sa-card-title">{repo.name ?? repo.id}</span>
      {isDefault ? <Tag tone="quiet">{pt(t, 'repo.default')}</Tag> : null}
      {repo.enabled === false ? <Tag tone="warning">{pt(t, 'repos.disabledTag')}</Tag> : null}
      <Tag tone={repo.tokenConfigured ? 'outline' : 'warning'}>
        {repo.tokenConfigured ? pt(t, 'repo.tokenConfigured') : pt(t, 'repo.tokenMissing')}
      </Tag>
      {repo.name && repo.id && repo.name !== repo.id
        ? <span className="sa-mono sa-hint" translate="no">{String(repo.id)}</span> : null}
    </div>
    <div className="sa-repo-facts">{rows.map(([label, value], index) =>
      <span className="sa-repo-fact" key={index}>
        <span className="sa-repo-fact-label">{label}</span>
        <span className="sa-repo-fact-value">{value}</span>
      </span>)}</div>
    <div className="sa-actions">
      <Button variant="outline" size="sm" icon={<Icon name="settings" size={14} />}
        onClick={() => onEdit?.(repo)}>{pt(t, 'repos.edit')}</Button>
      <ConfirmButton label={pt(t, repo.enabled === false ? 'repos.enable' : 'repos.disable')}
        title={pt(t, repo.enabled === false ? 'repos.enableTitle' : 'repos.disableTitle')}
        message={pt(t, repo.enabled === false ? 'repos.enableMessage' : 'repos.disableMessage', { name: repo.name ?? repo.id })}
        // A generic "确定" would make the reader re-read the dialog body: the confirm button states the action.
        confirmLabel={pt(t, repo.enabled === false ? 'repos.enable' : 'repos.disable')}
        onConfirm={async () => { await onToggle?.(repo) }} />
      <Button variant="outline" size="sm" icon={<Icon name="shield" size={14} />}
        disabled={test.busy} aria-busy={test.busy ? 'true' : undefined} onClick={() => { void runTest() }}>
        {pt(t, test.busy ? 'repos.testing' : 'repos.test')}
      </Button>
    </div>
    {test.result || test.error
      ? <div className="sa-field" role="status" aria-live="polite" aria-atomic="true"
        style={{ marginTop: 'var(--sa-sp-8)' }}>
        <span className="sa-field-head">{pt(t, test.error || test.result?.ok === false ? 'repos.testFail' : 'repos.testOk')}</span>
        <Hint>{test.error ?? (test.result.checks ?? []).map(check =>
          `${check.skipped ? '○' : check.ok ? '✓' : '✕'} ${testLabel(check.id)}${check.detail ? ` · ${check.detail}` : ''}`).join(' / ')}</Hint>
        <Hint>{pt(t, 'repos.testHint')}</Hint>
      </div>
      : null}
    <div className="sa-token-row">
      <Input type="password" autoComplete="off" value={token} disabled={tokenBusy} className="sa-input-full"
        placeholder={pt(t, 'repos.tokenPlaceholder', { host })} aria-label={pt(t, 'repo.token')}
        onChange={event => setToken(event.target.value)} />
      <Button variant="outline" size="sm" icon={<Icon name="shield" size={14} />}
        disabled={tokenBusy || !token.trim()}
        onClick={() => { void Promise.resolve(onSaveToken?.(repo, token.trim())).then(saved => { if (saved) setToken('') }) }}>
        {pt(t, 'repos.tokenSave')}
      </Button>
      {repo.tokenConfigured
        // Cancel sends nothing: ConfirmButton only calls onConfirm from the dialog's own 确定 button.
        // Outline, like 保存令牌 beside it: the ghost variant is bare text, which on a phone wrapped onto its own
        // line and read as a field heading instead of a button (ui review P2).
        ? <ConfirmButton variant="outline" label={pt(t, 'repos.tokenClear')} title={pt(t, 'repos.tokenClearTitle', { host })}
          message={pt(t, 'repos.tokenClearMessage')} confirmLabel={pt(t, 'repos.tokenClear')}
          onConfirm={async () => {
            if (tokenBusy) return false
            const cleared = await onSaveToken?.(repo, '')
            if (cleared !== false) setToken('')
            // `false` keeps the dialog open: the host refused, and `saveRepoTokenFor` already said why.
            return cleared !== false
          }} />
        : null}
    </div>
    </div>
  </li>
}

const HISTORY_VALUE_PREVIEW = 80

/** One side of a field diff: booleans read as 开/关, long values preview then expand instead of stretching the row. */
function HistoryValue({ t, value }) {
  const [open, setOpen] = useState(false)
  const text = String(value ?? '')
  if (text === 'true' || text === 'false') {
    return <span className="sa-history-value">{pt(t, text === 'true' ? 'st.historyOn' : 'st.historyOff')}</span>
  }
  if (!text) return <span className="sa-history-value sa-hint">{pt(t, 'st.historyUnset')}</span>
  if (text.length <= HISTORY_VALUE_PREVIEW) return <span className="sa-history-value sa-mono">{text}</span>
  return <span className="sa-history-value">
    <span className="sa-mono">{open ? text : `${text.slice(0, HISTORY_VALUE_PREVIEW)}…`}</span>
    <Button variant="ghost" size="sm" onClick={() => setOpen(current => !current)}>
      {pt(t, open ? 'st.historyCollapseValue' : 'st.historyExpandValue')}
    </Button>
  </span>
}

/** The field-level "old → new" list of one snapshot (R2-04); collapsed by default so the modal stays scannable. */
export function HistoryChanges({ t, entry, open, onToggle }) {
  const changes = Array.isArray(entry?.changes) ? entry.changes : []
  if (!changes.length) return <p className="sa-hint">{pt(t, 'st.historyNoChanges')}</p>
  return <div className="sa-history-changes">
    <Button variant="ghost" size="sm" aria-expanded={open}
      onClick={() => onToggle?.(entry.id)}>
      {pt(t, open ? 'st.historyChangesHide' : 'st.historyChanges', { count: changes.length })}
    </Button>
    {open
      ? <ul className="sa-list">
        {changes.map((change, index) => <li key={`${change.key}-${index}`} className="sa-row sa-history-change">
          <div className="sa-row-main">
            <span className="sa-mono sa-history-key">{change.key}</span>
            <span className="sa-row-meta">
              <HistoryValue t={t} value={change.before} />
              <span className="sa-history-arrow" aria-hidden="true">→</span>
              <HistoryValue t={t} value={change.after} />
            </span>
          </div>
        </li>)}
      </ul>
      : null}
    {open && entry.changesTruncated
      ? <p className="sa-hint">{pt(t, 'st.historyChangesTruncated', { count: changes.length })}</p>
      : null}
  </div>
}

Object.assign(PAGE_TEXT, {
  'st.botsTitle': ['Bot', 'Bots'],
  'st.botsFile': ['Bot 文件', 'Bot file'],
  'st.botsBroken': ['Bot 文件无法读取（{code}）：{message}。派单会回退默认 Bot，修好文件后重试。',
    'The bot file cannot be read ({code}): {message}. Dispatch falls back to the default bot until it is repaired.'],
  'st.botsDropped': ['已忽略不认识的字段：{keys}（不影响其它字段）。',
    'Unknown fields were dropped: {keys}. The rest of the bot was kept.'],
  'st.botsBuiltinTag': ['内置', 'built-in'],
  'st.botsCopy': ['复制为 JSON', 'Copy as JSON'],
  'st.botsDuplicate': ['另存为副本', 'Save a copy'],
  'st.botsDelete': ['删除', 'Delete'],
  'st.botsDeleteTitle': ['删除 Bot', 'Delete bot'],
  'st.botsDeleteMessage': ['删除 Bot {id}？仓库或工单上显式指定它的地方会失效，落回正常派单。',
    'Delete bot {id}? Repositories and Tickets that name it fall back to normal dispatch.'],
  'st.botsDeleteConfirm': ['删除', 'Delete'],
  'st.botsNew': ['新建 Bot', 'New bot'],
  'st.botsBackends': ['后端与派单', 'Backends and dispatch'],
  'st.botsBackendsHint': ['只有「派单可用」的后端会让它的 Bot 进入候选。核验在保存后端配置或引擎启动时自动跑一次，失败才需要手动介入。',
    'Only a backend marked "available" puts its bots in the candidate set. Verification runs when the backend settings are saved and once at engine start; manual checks are for failures.'],
  'st.botsBackend.available': ['派单可用', 'available'],
  'st.botsBackend.unverified': ['没有证据，暂不进入候选', 'no evidence yet'],
  'st.botsBackend.checking': ['版本变了，复核期间不派单', 'version changed — not dispatched while re-checking'],
  'st.botsBackend.missing': ['CLI 不在', 'CLI missing'],
  'st.botsBackendPath': ['CLI：{path}', 'CLI: {path}'],
  'st.botsBackendVerify': ['核验', 'Verify'],
  'st.botsEdit': ['编辑 Bot', 'Edit bot'],
  'st.botsEditorNew': ['新建 Bot', 'New bot'],
  'st.botsPick': ['从左侧选择一个 Bot', 'Pick a Bot on the left'],
  'st.botsCreate': ['创建', 'Create'],
  'st.botsFieldName': ['名称', 'Name'],
  'st.botsFieldDescription': ['一句话说明', 'One line'],
  'st.botsFieldDescriptionHint': ['给人扫列表看的，不超过 120 字。', 'For a human scanning the list; up to 120 characters.'],
  'st.botsFieldWhenToUse': ['什么时候派给它', 'When to send it work'],
  'st.botsFieldBackend': ['后端', 'Backend'],
  'st.botsFieldRole': ['角色提示词', 'Role prompt'],
  'st.botsAdvanced': ['高级设置', 'Advanced'],
  'st.botsFieldPreset': ['预设', 'Preset'],
  'st.botsFieldModel': ['模型', 'Model'],
  'st.botsFieldPrefer': ['偏好 Skill', 'Preferred skills'],
  'st.botsSearchModel': ['搜索模型…', 'Search models…'],
  'st.botsNoModel': ['没有读到可用模型', 'No models found'],
  'st.botsNoSkills': ['没有读到可用 Skill', 'No skills found'],
  'st.botsFieldSkillsPolicy': ['Skill 策略', 'Skill policy'],
  'st.botsPresetHostDefault': ['跟随宿主默认', 'Host default'],
  'st.botsBudget': ['预算（只读，继承自设置）', 'Budget (read-only, inherited)'],
  'st.botsBudgetTimeout': ['超时', 'Timeout'],
  'st.botsBudgetIdle': ['空闲超时', 'Idle timeout'],
  'st.botsBudgetRepairs': ['最多返工', 'Max repairs'],
  'st.botsBudgetInherit': ['跟随设置', 'From settings'],
  'st.botsClaims': ['谁会把活派给它', 'Who sends it work'],
  'st.botsClaimsDefault': ['默认 Bot：派单失败或候选为空时兜底。', 'Default bot: catches the run when a pick fails or no candidate is available.'],
  'st.botsClaimsRepo': ['仓库指定：{repos}。命中即用，不再调模型。', 'Repositories name it: {repos}. An explicit choice skips the model.'],
  'st.botsClaimsTicket': ['工单手动指定：执行页「用这个 Bot 跑一次」，只影响这一次 run。',
    'Picked on a Ticket: "run once with this bot" affects that run only.'],
  'st.botsClaimsNone': ['没有仓库指定它；工单上可以手动指定。', 'No repository names it; a Ticket can still name it for one run.'],
  'st.botsStats': ['最近表现', 'Recent performance'],
  'st.botsStatsPass': ['通过率', 'Pass rate'],
  'st.botsStatsRepairs': ['平均返工', 'Avg repairs'],
  'st.botsStatsGate': ['闸门通过率', 'Gate pass rate'],
  'st.botsStatsMedian': ['中位耗时', 'Median duration'],
  'st.botsStatsLast': ['最近一次', 'Last run'],
  'st.botsStatsEmpty': ['还没有它跑过的记录（最近 20 单）。', 'No runs yet (last 20).'],
  'st.botsStatsRuns': ['最近 {count} 单', 'last {count} runs'],
  'st.botsPending': ['待沉淀', 'Worth saving'],
  'st.botsPendingHint': ['这些是 1.4 时代现拉的临时 Bot，同一个名字跑过至少三次。点一下预填编辑器，保存后才成为正式 Bot。',
    'These are ad-hoc bots from 1.4 that ran at least three times. Click one to prefill the editor; it becomes a real Bot only when saved.'],
  'st.botsPendingCount': ['跑过 {count} 次', '{count} runs'],
  'st.botsPreviewEmpty': ['—', '—'],
})
/* ---------------------------------------------------------------------------------------------------------------
   Bots (1.5.0 §5): identity + whenToUse + role. The store lives under the state dir, so this page edits the file the
   engine actually reads — a repository's own worker-bots.json is ignored on purpose.
   --------------------------------------------------------------------------------------------------------------- */

export const BOT_BACKEND_OPTIONS = ['dsh', 'claude', 'codex']
/** The two built-ins ship with the plugin: always available, never editable, copy to change. */
export const BOT_BUILTIN_IDS = ['generalist', 'reviewer']

/** A display name becomes the internal id: lowercase kebab, and the caller appends a suffix when it is taken. */
export const slugOf = name => String(name ?? '').toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30)

export const emptyBotForm = () => ({
  id: '', name: '', description: '', whenToUse: '', backend: 'dsh', preset: '', modelProvider: '',
  modelModel: '', reasoningEffort: 'auto', prefer: '', skillsPolicy: 'prompt', role: '', budget: undefined,
})

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/** Store shape → form strings, so a form value is always editable text and never a half-typed number. */
export function botToForm(bot) {
  const model = bot?.model && typeof bot.model === 'object' ? bot.model : {}
  const skills = bot?.skills && typeof bot.skills === 'object' ? bot.skills : {}
  const prompt = bot?.prompt && typeof bot.prompt === 'object' ? bot.prompt : {}
  return {
    ...emptyBotForm(),
    id: String(bot?.id ?? ''), name: String(bot?.name ?? ''), description: String(bot?.description ?? ''),
    whenToUse: String(bot?.whenToUse ?? ''), backend: String(bot?.backend ?? 'dsh'), preset: String(bot?.preset ?? ''),
    modelProvider: String(model.provider ?? ''), modelModel: String(model.model ?? ''),
    reasoningEffort: String(model.reasoningEffort ?? 'auto'),
    prefer: (Array.isArray(skills.prefer) ? skills.prefer : []).join(', '),
    skillsPolicy: String(skills.policy ?? 'prompt'),
    role: String(prompt.role ?? ''),
    // The editor shows no budget inputs; the stored override rides along untouched so a save cannot erase it.
    budget: isPlainObject(bot?.budget) ? bot.budget : undefined,
  }
}

const listOf = value => String(value ?? '').split(/[,，\n]/).map(item => item.trim()).filter(Boolean)

/** Form → bot. Empty fields are omitted so the store only carries what the operator actually set. */
export function formToBot(form) {
  const bot = { id: String(form.id ?? '').trim().toLowerCase(), name: String(form.name ?? '').trim(),
    backend: String(form.backend ?? 'dsh') }
  if (form.description) bot.description = form.description
  if (form.whenToUse) bot.whenToUse = form.whenToUse
  if (form.preset) bot.preset = form.preset.trim()
  const model = {}
  if (form.modelProvider) model.provider = form.modelProvider.trim()
  if (form.modelModel) model.model = form.modelModel.trim()
  if (form.reasoningEffort && form.reasoningEffort !== 'auto') model.reasoningEffort = form.reasoningEffort
  if (model.model) bot.model = model
  const skills = {}
  const prefer = listOf(form.prefer)
  if (prefer.length) skills.prefer = prefer
  if (form.skillsPolicy && form.skillsPolicy !== 'prompt') skills.policy = form.skillsPolicy
  if (Object.keys(skills).length) bot.skills = skills
  if (form.role) bot.prompt = { role: form.role }
  if (form.budget) bot.budget = form.budget
  return bot
}

const formatDuration = ms => {
  if (!Number.isFinite(ms)) return undefined
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分`
  return `${Math.round(ms / 3_600_000)} 小时`
}
const formatPercent = ratio => Number.isFinite(ratio) ? `${Math.round(ratio * 100)}%` : undefined

/** The backend card's badge tone: only `available` is green; everything else explains why it is skipped. */
const backendToneOf = state => state === 'available' ? 'done' : state === 'missing' ? 'warn' : 'quiet'

/** One Bot's recent-run aggregate; empty until the first run, and never invented. */
function BotStats({ t, stats }) {
  if (!stats || !stats.runs) return <p className="sa-hint">{pt(t, 'st.botsStatsEmpty')}</p>
  const rows = [
    [pt(t, 'st.botsStatsPass'), formatPercent(stats.passRate)],
    [pt(t, 'st.botsStatsRepairs'), String(stats.avgRepairs ?? 0)],
    [pt(t, 'st.botsStatsGate'), formatPercent(stats.gatePassRate)],
    [pt(t, 'st.botsStatsMedian'), formatDuration(stats.medianMs)],
    [pt(t, 'st.botsStatsLast'), stats.lastAt ? when(stats.lastAt) : undefined],
  ].filter(([, value]) => value !== undefined && value !== '')
  return <>
    <p className="sa-hint">{pt(t, 'st.botsStatsRuns', { count: stats.runs })}</p>
    <KeyValues rows={rows} />
  </>
}

/** The Bot page: list on the left, five-field detail on the right, then the backends and the pending ad-hoc bots. */
export function BotsCard() {
  const { t } = usePanel()
  const { actions } = usePanelData()
  const [state, setState] = useState({ busy: true, data: undefined, error: undefined })
  const [editor, setEditor] = useState(undefined)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(undefined)
  const [verifying, setVerifying] = useState('')
  const [pickedId, setPickedId] = useState('')
  const [advanced, setAdvanced] = useState(false)
  const seq = useRef(0)
  const load = async () => {
    const seqNow = ++seq.current
    try {
      const [view, stats, config, catalog] = await Promise.all([
        actions.bots(),
        actions.botStats(),
        actions.config(),
        // §5.4: the editor offers real presets/models/skills. Optional — a host that cannot list them still renders
        // the editor with free-text fields.
        Promise.resolve().then(() => actions.botCatalog?.()).catch(() => ({})),
      ])
      if (seq.current === seqNow) setState({ busy: false, data: { view, stats, config, catalog }, error: undefined })
    } catch (failure) {
      if (seq.current === seqNow) setState({ busy: false, data: undefined, error: failure })
    }
  }
  useEffect(() => { void load() }, [])
  // An old "存为 Bot" hand-off still lands here: review the draft, then save it as a normal Bot.
  useEffect(() => {
    let draft
    try { draft = window.sessionStorage.getItem('superagent-panel/bot-draft') } catch { draft = undefined }
    if (!draft) return
    try {
      const parsed = JSON.parse(draft)
      if (parsed && typeof parsed === 'object') setEditor({ form: botToForm(parsed), id: parsed.id })
    } catch { /* a corrupt draft is simply not preloaded */ }
    try { window.sessionStorage.removeItem('superagent-panel/bot-draft') } catch { /* private mode */ }
  }, [])
  if (state.error) return <ErrorState error={state.error} onRetry={() => { void load() }} />
  if (!state.data) return <Skeleton rows={4} />
  const { view, stats, config, catalog } = state.data
  const bots = Array.isArray(view.bots) ? view.bots : []
  const presetIds = Array.isArray(view.presets) ? view.presets : []
  const dshCatalog = catalog && typeof catalog.dsh === 'object' && catalog.dsh ? catalog.dsh : {}
  const catalogPresets = Array.isArray(dshCatalog.presets) ? dshCatalog.presets : []
  const catalogProviders = Array.isArray(dshCatalog.providers) ? dshCatalog.providers : []
  const catalogSkills = Array.isArray(dshCatalog.skills) ? dshCatalog.skills : []
  const presetChoices = [...new Set([...presetIds, ...catalogPresets])]
  const backends = view.backends && typeof view.backends === 'object' ? view.backends : {}
  const builtinOf = bot => BOT_BUILTIN_IDS.includes(bot?.id)
  const editField = (key, value) => setEditor(current => current ? { ...current, form: { ...current.form, [key]: value } } : current)
  const openEditor = (bot, prefill) => {
    setSaveError(undefined)
    setEditor({ form: botToForm(bot ?? prefill), id: bot?.id })
  }
  const closeEditor = () => { if (!saving) setEditor(undefined) }
  const save = async () => {
    if (!editor) return
    setSaving(true)
    setSaveError(undefined)
    try {
      let bot = formToBot(editor.form)
      if (!editor.id) {
        const base = slugOf(editor.form.name) || `bot-${Date.now().toString(36).slice(-4)}`
        let candidate = base
        let suffix = 2
        while (bots.some(item => item.id === candidate)) candidate = `${base}-${suffix++}`
        bot = formToBot({ ...editor.form, id: candidate })
      }
      const others = bots.filter(item => !builtinOf(item) && item.id !== bot.id && item.id !== editor.id)
        .map(item => stripBotForSave(item))
      await actions.saveBots([...others, bot])
      if (!editor.id) setPickedId(bot.id)
      setEditor(undefined)
      await load()
    } catch (failure) { setSaveError(failure) } finally { setSaving(false) }
  }
  const remove = async bot => {
    try {
      await actions.saveBots(bots.filter(item => !builtinOf(item) && item.id !== bot.id).map(stripBotForSave))
      await load()
    } catch (failure) { setSaveError(failure); throw failure }
  }
  const verify = async backend => {
    setVerifying(backend)
    try {
      await actions.verifyBotBackend(backend)
      await load()
    } catch (failure) { setSaveError(failure) } finally { setVerifying('') }
  }
  const selected = bots.find(bot => bot.id === pickedId) ?? bots[0]
  const pick = id => { setPickedId(id); setEditor(undefined); setSaveError(undefined) }
  const detailForm = selected ? botToForm(selected) : undefined
  const repoClaims = (Array.isArray(config?.repos) ? config.repos : [])
    .filter(repo => repo.bot === selected?.id).map(repo => repo.id)
  const defaultBot = config?.executor?.bot ?? 'generalist'
  const statsOf = stats?.bots?.[selected?.id]
  const pending = Array.isArray(stats?.pending) ? stats.pending : []
  // A backend decides what can be configured: DSH answers from host services, a CLI from its own configuration files.
  // Both get real lists, so the editor never asks for an id from memory.
  const editorIsDsh = editor?.form?.backend === 'dsh'
  const backendCatalog = catalog && typeof catalog[editor?.form?.backend] === 'object' && catalog[editor?.form?.backend]
    ? catalog[editor?.form?.backend] : {}
  const cliModels = Array.isArray(backendCatalog.models) ? backendCatalog.models : []
  const modelGroups = editorIsDsh
    ? catalogProviders.map(row => ({ provider: row.provider, label: row.name, models: Array.isArray(row.models) ? row.models : [] }))
    : [{ provider: '', label: String(editor?.form?.backend ?? ''), models: cliModels }]
  const modelLabel = modelGroups.flatMap(group => group.models).find(model => model.id === editor?.form?.modelModel)?.name
  const skillChoices = editorIsDsh ? catalogSkills : (Array.isArray(backendCatalog.skills) ? backendCatalog.skills : [])
  const preferTokens = listOf(editor?.form?.prefer ?? '')
  // A stored preference the catalogue does not know yet (an older save, a skill removed from the host) stays visible
  // and checkable, so saving the editor never drops it silently.
  const unknownPrefers = preferTokens.filter(name => !skillChoices.some(skill => skill.name === name))
    .map(name => ({ name, description: '' }))
  const allSkills = [...skillChoices, ...unknownPrefers]
  const togglePrefer = name => {
    const next = preferTokens.includes(name) ? preferTokens.filter(item => item !== name) : [...preferTokens, name]
    editField('prefer', next.join(', '))
  }
  // A backend change resets everything that is scoped to the previous backend: its preset, its model pair and its
  // skill preferences. Empty means "this backend's own default", which is what the advanced section shows.
  const changeBackend = value => setEditor(current => current ? { ...current, form: {
    ...current.form, backend: value,
    preset: '', modelProvider: '', modelModel: '', prefer: '', skillsPolicy: 'prompt',
  } } : current)
  // Five questions, no capability toggles: who it is, what it is for, when to send it work, which backend, and how it
  // should behave. Budget and claims stay read-only so the editor never duplicates the settings pages.
  const editorPane = editor ? <Section title={editor.id ? pt(t, 'st.botsEdit') : pt(t, 'st.botsEditorNew')}>
    <div className="sa-bots-editor-body sa-bots-editor">
      <div className="sa-field-grid">
        <label className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldName')}</span>
          <Input value={editor.form.name} maxLength={40}
            onChange={event => editField('name', event.target.value)} /></label>
        <label className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldBackend')}</span>
          <Select value={editor.form.backend} onChange={changeBackend}
            options={BOT_BACKEND_OPTIONS.map(backend => ({ value: backend, label: backend }))} /></label>
        <label className="sa-field sa-field-wide"><span className="sa-field-head">{pt(t, 'st.botsFieldDescription')}</span>
          <Input value={editor.form.description} maxLength={120}
            onChange={event => editField('description', event.target.value)} /></label>
      </div>
      <label className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldWhenToUse')}</span>
        <textarea className="sa-textarea" rows={3} maxLength={300} value={editor.form.whenToUse}
          aria-label={pt(t, 'st.botsFieldWhenToUse')}
          onChange={event => editField('whenToUse', event.target.value)} /></label>
      <label className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldRole')}</span>
        <textarea className="sa-textarea" rows={4} value={editor.form.role}
          aria-label={pt(t, 'st.botsFieldRole')}
          onChange={event => editField('role', event.target.value)} /></label>
      <DisclosureRow title={pt(t, 'st.botsAdvanced')} open={advanced}
        onToggle={() => setAdvanced(value => !value)} />
      {advanced ? <div className="sa-field-grid">
        <label className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldPreset')}</span>
          <Select value={editor.form.preset} disabled={!editorIsDsh}
            onChange={value => editField('preset', value)}
            options={[{ value: '', label: pt(t, 'st.botsPresetHostDefault') },
              ...presetChoices.map(id => ({ value: id, label: id }))]} /></label>
        <span className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldModel')}</span>
          <ModelPicker groups={modelGroups} value={editor.form.modelModel} valueLabel={modelLabel}
            label={pt(t, 'st.botsFieldModel')} searchLabel={pt(t, 'st.botsSearchModel')}
            emptyLabel={pt(t, 'st.botsNoModel')} disabled={!modelGroups.some(group => group.models.length)}
            onChange={choice => setEditor(current => current ? { ...current, form: {
              ...current.form, modelProvider: choice.provider, modelModel: choice.model,
            } } : current)} /></span>
        {allSkills.length
          ? <div className="sa-field sa-field-wide">
            <span className="sa-field-head">{pt(t, 'st.botsFieldPrefer')}</span>
            <div className="sa-check-row">
              {allSkills.map(skill => <label key={skill.name} className="sa-check">
                <input type="checkbox" checked={preferTokens.includes(skill.name)} onChange={() => togglePrefer(skill.name)} />
                <span>{skill.name}</span>
              </label>)}
            </div>
          </div>
          : <span className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldPrefer')}</span>
            <span className="sa-hint">{pt(t, 'st.botsNoSkills')}</span></span>}
        <label className="sa-field"><span className="sa-field-head">{pt(t, 'st.botsFieldSkillsPolicy')}</span>
          <Select value={editor.form.skillsPolicy} onChange={value => editField('skillsPolicy', value)}
            options={[{ value: 'prompt', label: 'prompt' }, { value: 'preset', label: 'preset' }]} /></label>
      </div> : null}
      {saveError ? <p className="sa-error" role="alert">{saveError.details?.code
        ? `${String(saveError.details.code)}：${saveError.message}` : errorText(saveError)}</p> : null}
      <div className="sa-actions">
        <Button variant="ghost" disabled={saving} onClick={closeEditor}>{t('cancel')}</Button>
        <Button variant="primary" disabled={saving || String(editor.form.name ?? '').trim() === ''
          || String(editor.form.whenToUse ?? '').trim() === ''}
          onClick={() => { void save() }}>
          {saving ? t('saving') : editor.id ? t('save') : pt(t, 'st.botsCreate')}
        </Button>
      </div>
    </div>
  </Section> : null
  const detailRows = selected ? [
    [pt(t, 'st.botsFieldBackend'), selected.backend ?? 'dsh'],
    [pt(t, 'st.botsFieldWhenToUse'), detailForm.whenToUse || pt(t, 'st.botsPreviewEmpty')],
    ...(detailForm.preset ? [[pt(t, 'st.botsFieldPreset'), detailForm.preset]] : []),
    ...(detailForm.modelModel
      ? [[pt(t, 'st.botsFieldModel'), detailForm.modelProvider
        ? `${detailForm.modelProvider} · ${detailForm.modelModel}` : detailForm.modelModel]] : []),
    [pt(t, 'st.botsBudget'),
      `${pt(t, 'st.botsBudgetTimeout')} ${pt(t, 'st.botsBudgetInherit')} · ${pt(t, 'st.botsBudgetIdle')} ${pt(t, 'st.botsBudgetInherit')} · ${pt(t, 'st.botsBudgetRepairs')} ${pt(t, 'st.botsBudgetInherit')}`],
  ] : []
  return <>
    <Section title={pt(t, 'st.botsTitle')}>
      {view.code
        ? <p className="sa-hint sa-info-warn">
          {pt(t, 'st.botsBroken', { code: String(view.code), message: String(view.error ?? '') })}
        </p> : null}
      {(Array.isArray(view.droppedKeys) && view.droppedKeys.length)
        ? <p className="sa-hint sa-info-warn">{pt(t, 'st.botsDropped', { keys: view.droppedKeys.join(', ') })}</p>
        : null}
      <div className="sa-panes">
        <div className="sa-pane sa-pane-aside">
          <ul className="sa-list sa-bot-list">
            {bots.map(bot => <li key={bot.id}>
              <button type="button" className="sa-row sa-bot-row" aria-current={selected?.id === bot.id}
                onClick={() => pick(bot.id)}>
                <div className="sa-row-main">
                  <div className="sa-row-title">
                    <span>{bot.name ?? bot.id}</span>
                    <span className="sa-mono sa-hint">{bot.id}</span>
                  </div>
                  {bot.description ? <div className="sa-row-meta">{bot.description}</div> : null}
                </div>
              </button>
            </li>)}
          </ul>
          <Button size="sm" variant="outline" icon="plus" onClick={() => openEditor(undefined)}>{pt(t, 'st.botsNew')}</Button>
          <p className="sa-hint sa-bots-store">{pt(t, 'st.botsFile')} · <span className="sa-mono">{String(view.file ?? '—')}</span></p>

        </div>
        <div className="sa-pane sa-bots-detail">
          {editorPane ?? (selected
            ? <Section title={selected.name ?? selected.id}
              badge={builtinOf(selected) ? <Tag tone="quiet">{pt(t, 'st.botsBuiltinTag')}</Tag> : null}
              action={<span className="sa-actions">
                {builtinOf(selected)
                  ? null
                  : <Button size="sm" variant="outline" onClick={() => openEditor(selected)}>{t('edit')}</Button>}
                <CopyButton value={JSON.stringify(stripBotForSave(selected), null, 2)} label={pt(t, 'st.botsCopy')} />
                {builtinOf(selected)
                  ? <Button size="sm" variant="ghost" onClick={() => openEditor(undefined, { ...selected, id: `${selected.id}-copy`,
                    name: `${selected.name ?? selected.id} 副本` })}>{pt(t, 'st.botsDuplicate')}</Button>
                  : <ConfirmButton label={pt(t, 'st.botsDelete')} title={pt(t, 'st.botsDeleteTitle')}
                    message={pt(t, 'st.botsDeleteMessage', { id: selected.id })} confirmLabel={pt(t, 'st.botsDeleteConfirm')}
                    onConfirm={async () => { await remove(selected) }} />}
              </span>}>
              <div className="sa-settings-stack">
                {selected.description ? <p className="sa-hint">{selected.description}</p> : null}
                <KeyValues rows={detailRows} />
                <div className="sa-field">
                  <span className="sa-field-head">{pt(t, 'st.botsFieldRole')}</span>
                  <p className="sa-hint sa-role-text">{detailForm.role || pt(t, 'st.botsPreviewEmpty')}</p>
                </div>
                <div className="sa-field">
                  <span className="sa-field-head">{pt(t, 'st.botsClaims')}</span>
                  <p className="sa-hint">
                    {selected.id === defaultBot ? <>{pt(t, 'st.botsClaimsDefault')}<br /></> : null}
                    {repoClaims.length
                      ? <>{pt(t, 'st.botsClaimsRepo', { repos: repoClaims.join('、') })}<br /></>
                      : <>{pt(t, 'st.botsClaimsNone')}<br /></>}
                    {pt(t, 'st.botsClaimsTicket')}
                  </p>
                </div>
                <div className="sa-field">
                  <span className="sa-field-head">{pt(t, 'st.botsStats')}</span>
                  <BotStats t={t} stats={statsOf} />
                </div>
              </div>
            </Section>
            : <EmptyState title={pt(t, 'st.botsPick')} />)}
        </div>
      </div>
    </Section>
    <Section title={pt(t, 'st.botsBackends')} hint={pt(t, 'st.botsBackendsHint')}>
      <div className="sa-settings-stack">
        {BOT_BACKEND_OPTIONS.map(backend => {
          const entry = backends[backend] ?? { state: 'unverified' }
          return <div key={backend} className="sa-row">
            <div className="sa-row-main">
              <div className="sa-row-title">
                <Tag tone={backendToneOf(entry.state)}>{backend}</Tag>
                <span>{pt(t, `st.botsBackend.${entry.state ?? 'unverified'}`)}</span>
                {entry.verifiedAt ? <When at={entry.verifiedAt} /> : null}
              </div>
              <p className="sa-hint">
                {entry.reason ? <>{entry.reason}</> : null}
                {entry.cliPath ? <span className="sa-mono">{` · ${pt(t, 'st.botsBackendPath', { path: entry.cliPath })}`}</span> : null}
              </p>
            </div>
            <Button size="sm" variant="ghost" disabled={verifying === backend}
              onClick={() => { void verify(backend) }}>{pt(t, 'st.botsBackendVerify')}</Button>
          </div>
        })}
      </div>
    </Section>
    {pending.length ? <Section title={pt(t, 'st.botsPending')}>
      <div className="sa-settings-stack">
        {pending.map(item => <div key={item.id} className="sa-row">
          <div className="sa-row-main">
            <div className="sa-row-title">
              <span>{item.name}</span>
              <span className="sa-mono sa-hint">{item.id}</span>
              <span className="sa-hint">{pt(t, 'st.botsPendingCount', { count: item.count })}</span>
            </div>
            {item.description ? <div className="sa-row-meta">{item.description}</div> : null}
          </div>
          <Button size="sm" variant="outline" onClick={() => openEditor(undefined, {
            name: item.name, description: item.description, whenToUse: item.whenToUse,
            backend: item.backend, prompt: { role: item.role } })}>{t('edit')}</Button>
        </div>)}
      </div>
    </Section> : null}
    {saveError && !editor ? <p className="sa-error" role="alert">{saveError.details?.code
      ? `${String(saveError.details.code)}：${saveError.message}` : errorText(saveError)}</p> : null}
  </>
}

/** Strip host-added keys before re-saving a listed bot: only the store's own fields may round-trip. */
function stripBotForSave(bot) {
  const keys = ['id', 'name', 'description', 'whenToUse', 'backend', 'model', 'preset', 'skills', 'prompt', 'budget']
  const out = {}
  for (const key of keys) if (bot?.[key] !== undefined) out[key] = bot[key]
  return out
}

export function LiveSettingsPage({ route }) {
  const { t, notify, navigate } = usePanel()
  const { data, error, reload, actions } = usePanelData()
  // The Worker group shows what the CLIs are actually configured with — the binary the executor will spawn and the
  // models their own config files name — so neither is typed in by hand.
  const [botCatalog, setBotCatalog] = useState({})
  useEffect(() => {
    let active = true
    Promise.resolve().then(() => actions.botCatalog?.()).then(value => { if (active) setBotCatalog(value ?? {}) }).catch(() => {})
    return () => { active = false }
  }, [])
  const requestedGroup = route?.group && SETTINGS_GROUPS.some(group => group.id === route.group) ? route.group : 'source'
  const [active, setActive] = useState(requestedGroup)
  // Editable groups keep a group-local draft. A draft that exists only in memory is lost on reload / tab close, so it
  // is mirrored into sessionStorage and the tab warns before unloading while any group still has unsaved edits.
  const [drafts, setDrafts] = useState(readDraftCache)
  const [savingGroup, setSavingGroup] = useState(null)
  const [saveErrors, setSaveErrors] = useState({})
  const [fieldErrors, setFieldErrors] = useState({})
  const [savedTimes, setSavedTimes] = useState({})
  // U-06: a save that flips a high-risk switch waits here for a second confirmation instead of writing immediately.
  const [riskConfirm, setRiskConfirm] = useState(undefined)
  const savedTimers = useRef({})
  const bodyRef = useRef(null)
  const introRef = useRef(null)
  const [reloadState, setReloadState] = useState({ busy: false })
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
  const [repoFieldErrors, setRepoFieldErrors] = useState({})
  // R2-04's per-entry expansion state. It lives here, with the other Hooks, because the page returns a skeleton before
  // `data` arrives: a Hook declared after that early return would change the Hook count between the first and second
  // render (React #310) and take the whole panel down on a cold open / F5 of the Settings tab.
  const [historyChangesOpen, setHistoryChangesOpen] = useState({})
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyEntries, setHistoryEntries] = useState([])
  const [historyBusy, setHistoryBusy] = useState(false)
  const [historyError, setHistoryError] = useState(undefined)
  const [senderDraft, setSenderDraft] = useState('')
  const [bindingForm, setBindingForm] = useState({ chatId: '', title: '', repoId: '' })
  const [bindingError, setBindingError] = useState(undefined)
  useEffect(() => () => {
    for (const timer of Object.values(savedTimers.current)) clearTimeout(timer)
  }, [])
  // Keep the draft mirror in sync; clearing the last draft removes the key so a stale copy never comes back.
  useEffect(() => { writeDraftCache(drafts) }, [drafts])
  // Unsaved edits are the only client state that cannot be recovered after a reload: ask before leaving the tab.
  useEffect(() => {
    const dirty = SETTINGS_SAVEABLE.some(group => draftHasKeys(drafts[group]))
    if (!dirty) return undefined
    const onBeforeUnload = event => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [drafts])
  // Deep links from the setup checklist and system problems select the matching group. The effect only depends on
  // the requested group, so clicking the left rail afterwards is never overridden by an old route.
  useEffect(() => {
    if (route?.group && SETTINGS_GROUPS.some(group => group.id === route.group)) setActive(route.group)
  }, [route?.group])
  // A setup step can point at one field inside a group; scroll it into view and move focus there after the pane
  // switched, so keyboard and screen-reader users land on the field instead of the top of the page.
  useEffect(() => {
    if (!route?.focus) return undefined
    const timer = setTimeout(() => {
      const target = document.getElementById(`sa-settings-${route.focus}`)
      if (!target) return
      revealNode(target)
      const focusable = target.matches('input, select, textarea, button, a[href]')
        ? target
        : target.querySelector('input, select, textarea, button, a[href], [tabindex]')
      // The selector only matches HTML focusables, but `querySelector` widens the result to `Element`.
      const node = /** @type {HTMLElement | null} */ (focusable ?? target)
      if (node && typeof node.focus === 'function') node.focus({ preventScroll: true })
    }, 120)
    return () => clearTimeout(timer)
  }, [route?.focus, active])
  if (!data) {
    return error ? <ErrorState error={error} onRetry={() => { void reload() }} /> : <Skeleton rows={6} />
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
      notify(pt(t, token ? 'repos.tokenSaved' : 'repos.tokenCleared', { name: repo.name ?? repo.id, host: hostName(hostOfUrl(repo.baseUrl)) }))
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

  /** Field-level validation for the add-repository form: one message per field, so the modal can mark and focus it. */
  const validateRepoForm = form => {
    const errors = {}
    const id = form.id.trim()
    if (!id) errors.id = 'repos.required'
    else if (!/^[a-z0-9._-]+$/.test(id)) errors.id = 'repos.idInvalid'
    if (!form.path.trim()) errors.path = 'repos.required'
    if (!form.baseBranch.trim()) errors.baseBranch = 'repos.required'
    if (!form.targetBranch.trim()) errors.targetBranch = 'repos.required'
    const urlOk = value => /^https?:\/\/\S+$/i.test(value.trim())
    if (!form.baseUrl.trim()) errors.baseUrl = 'repos.required'
    else if (!urlOk(form.baseUrl)) errors.baseUrl = 'repos.urlInvalid'
    if (!form.project.trim()) errors.project = 'repos.required'
    if (form.uatUrl.trim() && !urlOk(form.uatUrl)) errors.uatUrl = 'repos.urlInvalid'
    if (form.healthUrl.trim() && !urlOk(form.healthUrl)) errors.healthUrl = 'repos.urlInvalid'
    return errors
  }

  /** Add one repository definition; the token is a separate write on the new card. */
  const submitRepo = async () => {
    if (repoSaving) return
    const form = repoForm
    const clientErrors = validateRepoForm(form)
    if (Object.keys(clientErrors).length) {
      setRepoFieldErrors(clientErrors)
      setRepoError(undefined)
      const first = Object.keys(clientErrors)[0]
      setTimeout(() => {
        const node = document.getElementById(`sa-repo-field-${first}`)
        if (!node) return
        if (typeof node.focus === 'function') node.focus({ preventScroll: true })
        revealNode(node)
      }, 0)
      return
    }
    setRepoFieldErrors({})
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
      // A server failure is not tied to one field: bring the banner into view and put focus on it, with advice.
      setTimeout(() => {
        const node = document.getElementById('sa-repo-error')
        if (!node) return
        revealNode(node)
        if (typeof node.focus === 'function') node.focus({ preventScroll: true })
      }, 0)
    } finally { setRepoSaving(false) }
  }

  const openRepoEdit = (repo) => {
    // AC-10: edit one gate field at a time instead of hand-writing the whole gates JSON. A deep clone keeps the form
    // independent from the loaded config (cancel must not mutate it).
    const gates = Array.isArray(repo.gates) ? JSON.parse(JSON.stringify(repo.gates)) : []
    // AC-10 only exposed the gates. Every other value the repository uses (branches, remote, verify/acceptance mode,
    // UAT URL) was fixed at creation and could only be changed by editing live.json by hand (review H-1).
    setRepoEdit({
      id: repo.id, name: repo.name ?? repo.id, repo: repo.repo ?? '',
      baseBranch: repo.baseBranch ?? '', verifyMode: repo.verifyMode ?? 'manual', acceptance: repo.acceptance ?? 'merged',
      baseUrl: repo.gitlab?.baseUrl ?? '', project: repo.gitlab?.project ?? '', targetBranch: repo.gitlab?.targetBranch ?? '',
      uatUrl: repo.gitlab?.uatUrl ?? '', healthUrl: repo.gitlab?.healthUrl ?? '', gates,
    })
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
      await actions.updateRepo(repoEdit.id, {
        name: repoEdit.name.trim() || repoEdit.id, repo: repoEdit.repo.trim(), gates,
        baseBranch: repoEdit.baseBranch.trim(), verifyMode: repoEdit.verifyMode, acceptance: repoEdit.acceptance,
        gitlab: { baseUrl: repoEdit.baseUrl.trim(), project: repoEdit.project.trim(),
          targetBranch: repoEdit.targetBranch.trim(), uatUrl: repoEdit.uatUrl.trim(), healthUrl: repoEdit.healthUrl.trim() },
      })
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
  const toggleHistoryChanges = id => setHistoryChangesOpen(current => ({ ...current, [id]: !current[id] }))
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
  // (style.js), so the element here carries no inline styles.
  const activeGroup = SETTINGS_GROUPS.find(group => group.id === active) ?? SETTINGS_GROUPS[0]
  const settingsHeading = () => <h2 className="sa-settings-title">{pt(t, activeGroup.labelKey)}</h2>

  // ---- repositories group: repository cards + tokens, then the read-only deployment section -------------------
  // Deployment used to be its own group; it describes the same GitLab target and worktree as these repositories, so it
  // lives here as a read-only sub-section instead of owning a seventh navigation entry.
  const renderRepos = () => {
    const deployHost = hostName(hostOfUrl(gitlab.baseUrl))
    // Only facts that belong to the host file itself are global now: project, branches, token, UAT and health URLs are
    // per-repository values edited on the card above (a global summary contradicted them as soon as a second
    // repository disagreed).
    const deployRows = [
      [pt(t, 'st.configFile'), <span className="sa-mono" translate="no">{config.file ?? t('empty')}</span>],
      [pt(t, 'st.configExists'), config.exists ? pt(t, 'st.fileExists') : pt(t, 'st.fileMissing')],
      [pt(t, 'st.worktreeRoot'), config.worktreeRoot ? <span className="sa-mono" translate="no">{config.worktreeRoot}</span> : t('empty')],
    ]
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'repos.intro')}</Hint>
      <div className="sa-actions">
        <Button variant="primary" size="sm" icon={<Icon name="plus" size={14} />}
          onClick={() => { setRepoForm(emptyRepoForm()); setRepoError(undefined); setRepoModalOpen(true) }}>
          {pt(t, 'repos.add')}
        </Button>
        {config.file ? <CopyButton value={config.file} label={pt(t, 'st.copyConfigPath')} /> : null}
        <Button variant="outline" size="sm" onClick={() => setConfigSampleOpen(true)}>{pt(t, 'repos.emptyAction')}</Button>
      </div>
      {repos.length
        ? <>
          <p className="sa-hint" role="status">{pt(t, 'repos.summary', { count: repos.length, default: defaultRepoName })}</p>
          <ul className="sa-list sa-repo-list">{repos.map(repo => <ReposCard key={repo.id} repo={repo}
            isDefault={repo.id === defaultRepoId} onSaveToken={saveRepoTokenFor} tokenBusy={tokenSaving === repo.id}
            onEdit={openRepoEdit} onToggle={toggleRepo} />)}</ul>
          <Hint>{pt(t, 'repos.tokenHint')}</Hint>
        </>
        : <EmptyState icon="pull" title={pt(t, 'repos.empty')}
          action={<div className="sa-actions">
            {config.file ? <CopyButton value={config.file} label={pt(t, 'st.copyConfigPath')} /> : null}
            <Button variant="outline" size="sm" onClick={() => setConfigSampleOpen(true)}>{pt(t, 'repos.emptyAction')}</Button>
          </div>} />}
      <p className="sa-hint">{pt(t, 'repos.manageHint')}</p>
      <h3 className="sa-ledger-title">{pt(t, 'st.deployTitle')}</h3>
      <Hint>{pt(t, 'st.deployHint')}</Hint>
      {config.error ? <p className="sa-banner sa-danger">{`${pt(t, 'st.configError')}${config.error}`}</p> : null}
      <KeyValues rows={deployRows} />
    </div>
  }

  /** The bindings as the editor sees them: the unsaved draft first, the saved config second. */
  const bindingDraft = () => {
    const draft = drafts.source ?? {}
    const watched = draft['octo.watchChatIds'] ?? octo.watchChatIds
    return {
      watched: Array.isArray(watched) ? watched : [],
      titles: draft['octo.chatTitles'] ?? octo.chatTitles ?? {},
      repos: draft['octo.chatRepos'] ?? octo.chatRepos ?? {},
    }
  }
  /** Stage a binding change in the source draft; the group's 保存 (with its risk confirmation) writes it. */
  const editBindings = (watched, titles, bindings) => {
    editField('source', 'octo.watchChatIds', watched, octo.watchChatIds ?? [])
    editField('source', 'octo.chatTitles', titles, octo.chatTitles ?? {})
    editField('source', 'octo.chatRepos', bindings, octo.chatRepos ?? {})
  }
  const closeBindingForm = () => { setBindingForm({ chatId: '', title: '', repoId: '' }); setBindingError(undefined) }
  const onAddBinding = () => {
    const chatId = bindingForm.chatId.trim()
    if (!chatId) {
      // The missing chat id is marked on the field (and announced there), not only in a transient toast.
      setBindingError(pt(t, 'st.bindingChatRequired'))
      setTimeout(() => document.getElementById('sa-field-binding-chat')?.focus(), 0)
      return
    }
    setBindingError(undefined)
    const repoId = bindingForm.repoId || defaultRepoId
    // Merge onto the draft, not the saved file: a second chat added before 保存 used to drop the first unsaved binding.
    const current = bindingDraft()
    const watched = [...new Set([...current.watched, chatId])]
    const titles = { ...current.titles, ...bindingForm.title.trim() ? { [chatId]: bindingForm.title.trim() } : {} }
    const bindings = { ...current.repos, [chatId]: repoId }
    editBindings(watched, titles, bindings)
    closeBindingForm()
  }
  const dirtyOf = group => Boolean(drafts[group] && Object.keys(drafts[group]).length)
  const dirtyGroups = new Set(SETTINGS_GROUPS.map(group => group.id).filter(dirtyOf))

  /** Move one field into (or back out of) the group draft; editing clears a shown save failure for that group. */
  const editField = (group, key, value, initial) => {
    setSaveErrors(previous => settingsOmit(previous, group))
    setFieldErrors(previous => settingsOmit(previous, group))
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
    setFieldErrors(previous => settingsOmit(previous, group))
    setSavedTimes(previous => settingsOmit(previous, group))
  }

  /** A validation failure belongs on the field, not only in the bottom save bar: mark the input, point it at the
      message and move focus there so the user can fix it without hunting. */
  const failField = (group, field, messageKey) => {
    setSaveErrors(previous => settingsOmit(previous, group))
    setFieldErrors(previous => ({ ...previous, [group]: { field, messageKey } }))
    setTimeout(() => {
      const node = document.getElementById(`sa-field-${field}`)
      if (!node) return
      if (typeof node.focus === 'function') node.focus({ preventScroll: true })
      revealNode(node)
    }, 0)
  }

  /** aria-invalid / aria-describedby for a numeric field that may currently fail validation. */
  const fieldAria = (group, field, hintId) => {
    const invalid = fieldErrors[group]?.field === field
    const describedBy = [hintId, invalid ? `sa-field-${field}-error` : null].filter(Boolean).join(' ')
    return { 'aria-invalid': invalid ? 'true' : undefined, 'aria-describedby': describedBy || undefined }
  }

  const fieldErrorMessage = (group, field) => {
    const error = fieldErrors[group]
    return error && error.field === field
      ? <p className="sa-error" id={`sa-field-${field}-error`} role="alert">{pt(t, error.messageKey)}</p>
      : null
  }

  /** Save one group: patch → (high-risk confirm) → model reload → 3s "saved" state; failures keep the draft for a retry. */
  const saveGroup = async group => {
    const draft = drafts[group]
    if (!draft || !Object.keys(draft).length || savingGroup) return
    const patch = settingsPatchOf(group, draft)
    if ('pollSeconds' in patch && (!Number.isFinite(patch.pollSeconds) || patch.pollSeconds < 2)) {
      failField(group, 'poll', 'st.pollInvalid')
      return
    }
    if ('executor.timeoutMs' in patch
      && (!Number.isFinite(patch['executor.timeoutMs']) || patch['executor.timeoutMs'] < 60_000
        || patch['executor.timeoutMs'] > 86_400_000)) {
      failField(group, 'timeout', 'st.timeoutInvalid')
      return
    }
    if ('executor.maxRepairRounds' in patch && (!Number.isInteger(patch['executor.maxRepairRounds'])
      || patch['executor.maxRepairRounds'] < 0 || patch['executor.maxRepairRounds'] > 6)) {
      failField(group, 'repair', 'st.repairBudgetInvalid')
      return
    }
    if ('review.expireHours' in patch && (!Number.isInteger(patch['review.expireHours'])
      || patch['review.expireHours'] < 1 || patch['review.expireHours'] > 168)) {
      failField(group, 'expire', 'st.reviewExpireInvalid')
      return
    }
    // U-06: enabling the engine, auto-run, pushes or merges is not a copy edit. The first Save only expands the
    // plain-language change list; the write happens from the confirmation's own button.
    const changes = riskChangesOf(patch, config)
    if (changes.length) {
      setRiskConfirm({ group, patch, changes })
      return
    }
    await commitGroup(group, patch)
  }

  /** The write itself: patch → model reload → 3s "saved" state; failures keep the draft for a retry. */
  const commitGroup = async (group, patch) => {
    setRiskConfirm(undefined)
    setSavingGroup(group)
    setSaveErrors(previous => settingsOmit(previous, group))
    setFieldErrors(previous => settingsOmit(previous, group))
    clearTimeout(savedTimers.current[group])
    delete savedTimers.current[group]
    setSavedTimes(previous => settingsOmit(previous, group))
    // Snapshot what this save covers. The inputs stay editable while patchSettings + reload are in flight, so dropping
    // the whole draft afterwards silently discarded anything typed during those few hundred milliseconds (review P2).
    const submitted = drafts[group] ?? {}
    try {
      await actions.patchSettings(patch)
      await reload()
      setDrafts(previous => {
        const now = previous[group]
        if (!now) return previous
        const left = Object.keys(now).reduce((acc, key) => (
          settingsSame(now[key], submitted[key]) ? acc : { ...acc, [key]: now[key] }), {})
        return Object.keys(left).length ? { ...previous, [group]: left } : settingsOmit(previous, group)
      })
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

  /** U-06: the confirmation writes the *draft as it is now*, never the patch captured when the list was drawn. When a
   * field moved in the meantime the list is refreshed and the person confirms again — an old patch must never be the
   * thing that turns the engine on. */
  const confirmRisk = async group => {
    const patch = settingsPatchOf(group, drafts[group] ?? {})
    const changes = riskChangesOf(patch, config)
    const shown = riskConfirm && riskConfirm.group === group ? riskConfirm.changes : []
    if (!sameRiskChanges(changes, shown)) {
      if (!changes.length) {
        await commitGroup(group, patch)
        return
      }
      setRiskConfirm({ group, patch, changes })
      return
    }
    await commitGroup(group, patch)
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
    // SaveBar has no disabled state; while any group is saving its save/retry actions would be silent no-ops
    // (saveGroup returns early), so other groups only keep the local-only discard action.
    const canSave = !savingGroup
    const risk = riskConfirm && riskConfirm.group === group ? riskConfirm : undefined
    return <>
      {risk
        ? <div className="sa-risk" role="group" aria-label={pt(t, 'st.riskTitle')}>
          <p className="sa-field-head">{pt(t, 'st.riskTitle')}</p>
          <p className="sa-hint">{pt(t, 'st.riskIntro')}</p>
          <ul className="sa-risk-list">{risk.changes.map(change => <li key={change.key}>{pt(t, change.labelKey, change.values)}</li>)}</ul>
          <div className="sa-actions">
            <Button variant="primary" size="sm" disabled={Boolean(savingGroup)}
              onClick={() => { void confirmRisk(group) }}>{pt(t, 'st.riskConfirm')}</Button>
            <Button variant="ghost" size="sm" disabled={Boolean(savingGroup)}
              onClick={() => setRiskConfirm(undefined)}>{pt(t, 'st.riskCancel')}</Button>
          </div>
        </div>
        : null}
      <SaveBar state={state} savedAt={savedAt} error={stored?.error} dirty={dirtyOf(group)}
        onSave={canSave ? () => { void saveGroup(group) } : undefined}
        onRetry={canSave ? () => { void saveGroup(group) } : undefined}
        onDiscard={() => { setRiskConfirm(undefined); discardGroup(group) }} />
      {stored ? <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-8)' }}>
        <div className="sa-actions">
          <Button variant="outline" size="sm" icon={<Icon name="refresh" size={14} />}
            disabled={Boolean(savingGroup)} onClick={() => { void recoverGroup(group) }}>{pt(t, 'st.reloadConfig')}</Button>
        </div>
        {stored.raw ? <Folded summary={t('rawError')}><pre className="sa-pre" translate="no">{stored.raw}</pre></Folded> : null}
      </div> : null}
    </>
  }

  const reloadButton = () => <Button variant="ghost" size="sm" icon={<Icon name="refresh" size={14} />}
    disabled={reloadState.busy} aria-busy={reloadState.busy ? 'true' : undefined}
    onClick={() => { void reloadEngineConfig() }}>
    {reloadState.busy ? pt(t, 'st.reloading') : pt(t, 'st.reloadConfig')}
  </Button>

  /** Write-only Octo token editor. An env-provided token is shown as read-only, because the file cannot override it. */
  const renderOctoToken = () => {
    const configured = octo.tokenConfigured === true
    const tokenSource = octo.tokenSource
    return <div className="sa-field" id="sa-settings-octo-token" tabIndex={-1}
      style={{ scrollMarginTop: 'calc(var(--sa-sticky-top) + var(--sa-sp-16))' }}>
      <label className="sa-field-head" htmlFor="sa-field-octo-token">{pt(t, 'st.octoToken')}
        {configured
          ? <Tag tone={tokenSource === 'env' ? 'info' : 'success'}>
            {tokenSource === 'env' ? pt(t, 'st.octoTokenEnv') : pt(t, 'st.tokenOk')}
          </Tag>
          : <Tag tone="outline">{pt(t, 'st.tokenMissing')}</Tag>}
      </label>
      {tokenSource === 'env'
        ? <Hint>{pt(t, 'st.octoTokenEnvHint')}</Hint>
        : <>
          <div style={{ display: 'flex', maxWidth: '560px', minWidth: 0, gap: 'var(--sa-sp-8)', flexWrap: 'wrap' }}>
            <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex' }}>
              <Input id="sa-field-octo-token" className="sa-input-full" type="password" value={octoTokenDraft}
                autoComplete="off" aria-describedby="sa-field-octo-token-hint"
                placeholder={pt(t, 'st.octoTokenPlaceholder')}
                disabled={octoTokenBusy}
                onChange={event => setOctoTokenDraft(event.target.value)} />
            </div>
            <Button variant="outline" size="sm" disabled={octoTokenBusy || !octoTokenDraft.trim()}
              aria-busy={octoTokenBusy ? 'true' : undefined}
              onClick={() => { void saveOctoTokenFor(octoTokenDraft) }}>
              {octoTokenBusy ? t('saving') : pt(t, 'st.octoTokenSave')}
            </Button>
            {configured
              // Outline, like 保存令牌 beside it: bare text reads as a field heading when it wraps on a phone.
              ? <ConfirmButton variant="outline" label={pt(t, 'repos.tokenClear')} title={pt(t, 'st.octoTokenClearTitle')}
                message={pt(t, 'st.octoTokenClearMessage')} confirmLabel={pt(t, 'repos.tokenClear')}
                onConfirm={async () => { if (!octoTokenBusy) await saveOctoTokenFor('') }} />
              : null}
          </div>
          <p className="sa-hint" id="sa-field-octo-token-hint">{pt(t, 'st.octoTokenHint')}</p>
        </>}
    </div>
  }

  /** Searchable group picker: fills the binding form, never writes a binding by itself. */
  const renderGroupPicker = () => {
    const watched = new Set(Array.isArray(octo.watchChatIds) ? octo.watchChatIds : [])
    const query = octoGroupQuery.trim().toLowerCase()
    const items = (octoGroups.items ?? []).filter(group => !query
      || String(group.name ?? '').toLowerCase().includes(query) || String(group.id ?? '').toLowerCase().includes(query))
    return <div className="sa-group-picker">
      <div className="sa-group-picker-head">
        <Input value={octoGroupQuery} placeholder={pt(t, 'st.groupsSearch')} aria-label={pt(t, 'st.groupsSearch')}
          onChange={event => setOctoGroupQuery(event.target.value)} />
        <span className="sa-hint">{pt(t, 'st.groupsCount', { count: items.length })}</span>
      </div>
      {octoGroups.busy
        ? <Hint>{pt(t, 'st.groupsLoading')}</Hint>
        : octoGroups.error
          ? <p className="sa-error" role="alert">{octoGroups.error}</p>
          : items.length
            ? <ul className="sa-list">{items.map(group => <li key={String(group.id)}>
              <button type="button" className="sa-group-option" disabled={watched.has(String(group.id))}
                onClick={() => chooseGroup(group)}>
                <span className="sa-group-option-main">
                  <span className="sa-group-option-name">{group.name || String(group.id)}</span>
                  <span className="sa-mono sa-hint" translate="no">{String(group.id)}</span>
                </span>
                {watched.has(String(group.id))
                  ? <Tag tone="success">{pt(t, 'st.groupsWatched')}</Tag>
                  : <Icon name="plus" size={14} />}
              </button>
            </li>)}</ul>
            : <Hint>{pt(t, 'st.groupsEmpty')}</Hint>}
    </div>
  }

  /** Sender allowlist: editable when "accept any human" is off; ignored (and explained) while it is on. */
  const renderSenders = () => {
    const draft = drafts.source ?? {}
    const allowAnyHuman = 'octo.allowAnyHuman' in draft ? draft['octo.allowAnyHuman'] : octo.allowAnyHuman === true
    const senders = senderValuesOf(draft)
    const list = senders.length
      ? <div className="sa-sender-list">{senders.map(sender => <span key={sender} className="sa-sender-chip">
        <span className="sa-mono" translate="no">{sender}</span>
        <button type="button" className="sa-sender-remove" aria-label={pt(t, 'st.removeSender', { sender })}
          onClick={() => removeSender(sender)}>×</button>
      </span>)}</div>
      : <Hint>{pt(t, 'st.sendersEmpty')}</Hint>
    const add = <div className="sa-actions">
      <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex' }}>
        <Input id="sa-field-senders" className="sa-input-full" value={senderDraft}
          placeholder={pt(t, 'st.senderPlaceholderExample')} aria-describedby="sa-field-senders-hint"
          disabled={savingGroup === 'source'}
          onChange={event => setSenderDraft(event.target.value)}
          onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); addSender() } }} />
      </div>
      <Button variant="outline" size="sm" disabled={savingGroup === 'source' || !senderDraft.trim()}
        onClick={addSender}>{pt(t, 'st.addSender')}</Button>
    </div>
    return <div className="sa-field">
      {allowAnyHuman
        ? <span className="sa-field-head">{pt(t, 'st.senders')}<Tag tone="info">{pt(t, 'st.allHumans')}</Tag></span>
        : <label className="sa-field-head" htmlFor="sa-field-senders">{pt(t, 'st.senders')}</label>}
      {allowAnyHuman ? <Hint>{pt(t, 'st.anyHumanSendersHint')}</Hint> : <>{list}{add}</>}
      {allowAnyHuman ? null : <p className="sa-hint" id="sa-field-senders-hint">{pt(t, 'st.sendersHint')}</p>}
    </div>
  }

  // ---- source group -----------------------------------------------------------------------------------------
  const renderSource = () => {
    const draft = drafts.source ?? {}
    const enabled = 'enabled' in draft ? draft.enabled : config.enabled === true
    const allowAnyHuman = 'octo.allowAnyHuman' in draft ? draft['octo.allowAnyHuman'] : octo.allowAnyHuman === true
    const pollSeconds = 'pollSeconds' in draft ? draft.pollSeconds : String(config.pollSeconds ?? '')
    // Bindings are a source-group draft like every other setting here: writing them straight to live.json bypassed
    // both the dirty indicator and the high-risk confirmation in the save bar (review M-4).
    const { watched: chatIds, titles: chatTitles, repos: chatRepos } = bindingDraft()
    const chatNames = chatIds.map(id => chatTitles[id] ?? id)
    const senders = senderValuesOf(draft)
    const cursors = engine.channelCursors ?? {}
    const cursorRows = Object.entries(cursors).map(([chat, seq]) => `${octo.chatTitles?.[chat] ?? chat} · ${seq}`)
    const rows = [
      [pt(t, 'st.watchChats'), chatNames.length ? chatNames.join(t('listSeparator')) : t('empty')],
      [pt(t, 'st.cursors'), cursorRows.length ? cursorRows.join(t('listSeparator')) : t('empty')],
      [pt(t, 'st.lastPoll'), engine.lastPollAt ? <When at={engine.lastPollAt} /> : t('empty')],
    ]
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'st.sourceHint')}</Hint>
      {renderOctoToken()}
      <SettingsSwitchRow label={pt(t, 'st.enabled')} hint={pt(t, 'st.enabledHint')} checked={enabled}
        disabled={savingGroup === 'source'}
        onChange={next => editField('source', 'enabled', next, config.enabled === true)} />
      <SettingsSwitchRow label={pt(t, 'st.allowAnyHuman')} hint={pt(t, 'st.allowAnyHumanHint')} checked={allowAnyHuman}
        disabled={savingGroup === 'source'}
        onChange={next => editField('source', 'octo.allowAnyHuman', next, octo.allowAnyHuman === true)} />
      {renderSenders()}
      <div className="sa-field">
        <label className="sa-field-head" htmlFor="sa-field-poll">{pt(t, 'st.pollSeconds')}</label>
        {/* The Input `style` reaches the inner <input>; the wrapper makes the bordered box itself 420px (critique §18). */}
        <div style={{ display: 'flex', maxWidth: '420px', minWidth: 0 }}>
          <Input id="sa-field-poll" type="number" min={2} step={1} value={pollSeconds} style={{ maxWidth: '420px' }}
            disabled={savingGroup === 'source'} aria-label={pt(t, 'st.pollSeconds')}
            {...fieldAria('source', 'poll', 'sa-field-poll-hint')}
            onChange={event => editField('source', 'pollSeconds', event.target.value, String(config.pollSeconds ?? ''))} />
        </div>
        <p className="sa-hint" id="sa-field-poll-hint">{pt(t, 'st.pollSecondsHint')}</p>
        {fieldErrorMessage('source', 'poll')}
      </div>
      <KeyValues rows={rows} />
      {!allowAnyHuman && !senders.length ? <p className="sa-banner">{pt(t, 'st.noSenders')}</p> : null}
      {chatNames.length ? null : <Hint>{pt(t, 'st.noChats')}</Hint>}
      <div className="sa-field" id="sa-settings-bindings" tabIndex={-1}
        style={{ scrollMarginTop: 'calc(var(--sa-sticky-top) + var(--sa-sp-16))' }}>
        <span className="sa-field-head">{pt(t, 'st.bindings')}</span>
        <Hint>{pt(t, 'st.bindingsHint')}</Hint>
        <Hint>{pt(t, 'st.bindingsSaveHint')}</Hint>
        <div className="sa-actions" style={{ marginTop: 'var(--sa-sp-4)' }}>
          <Button variant="outline" size="sm" icon={<Icon name="message" size={14} />}
            disabled={octoGroups.busy} onClick={() => { void loadOctoGroups() }}>
            {octoGroups.busy ? pt(t, 'st.groupsLoading') : pt(t, 'st.groupsPick')}
          </Button>
          {octoGroups.open
            ? <Button variant="ghost" size="sm"
              onClick={() => setOctoGroups(previous => ({ ...previous, open: false, error: undefined }))}>
              {pt(t, 'st.groupsClose')}
            </Button>
            : null}
        </div>
        {octoGroups.open ? renderGroupPicker() : null}
        {chatIds.length
          ? <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sa-sp-8)' }}>
            {chatIds.map(chatId => <div key={chatId} className="sa-switch-row">
              <div className="sa-switch-row-text">
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={chatTitles[chatId] ?? String(chatId)}>{chatTitles[chatId] ?? chatId}</span>
                {/* A 32-character chat key wrapped mid-hash on a phone; one ellipsised line keeps the row readable and the
                    full key stays in the tooltip. */}
                <span className="sa-mono sa-hint" translate="no" title={String(chatId)}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{String(chatId)}</span>
              </div>
              {/* The control row never wraps: the repository select and its 移除 button stay on one line (critique §27). */}
              <div className="sa-actions" style={{ flexWrap: 'nowrap', minWidth: 0 }}>
                <div style={{ flex: '0 1 240px', minWidth: 0 }}>
                  <Select label={pt(t, 'st.bindingRepo')} value={chatRepos[chatId] ?? defaultRepoId}
                    options={repoOptions}
                    onChange={next => editBindings(chatIds, chatTitles, { ...chatRepos, [chatId]: next })} />
                </div>
                <span style={{ flex: '0 0 auto' }}>
                  <ConfirmButton label={pt(t, 'st.bindingRemove')} title={pt(t, 'st.bindingRemoveTitle')}
                    message={pt(t, 'st.bindingRemoveMessage')} confirmLabel={pt(t, 'st.bindingRemoveConfirm')}
                    onConfirm={async () => {
                      // Removing a binding changes what the engine watches; the draft keeps it visible until 保存.
                      editBindings(chatIds.filter(item => item !== chatId), settingsOmit(chatTitles, chatId),
                        settingsOmit(chatRepos, chatId))
                    }} />
                </span>
              </div>
            </div>)}
          </div>
          : <Hint>{pt(t, 'st.bindingEmpty')}</Hint>}
        <div className="sa-actions" style={{ marginTop: 'var(--sa-sp-4)' }}>
          {/* The chat id had only a placeholder, so it had no accessible name once the field held a value (ui audit B-11). */}
          <Input id="sa-field-binding-chat" value={bindingForm.chatId} placeholder={pt(t, 'st.chatIdPlaceholder')}
            aria-label={pt(t, 'st.chatIdPlaceholder')}
            aria-invalid={bindingError ? 'true' : undefined}
            aria-describedby={bindingError ? 'sa-field-binding-chat-error' : undefined}
            onChange={event => { setBindingError(undefined); setBindingForm(previous => ({ ...previous, chatId: event.target.value })) }} />
          <Input value={bindingForm.title} placeholder={pt(t, 'st.bindingTitle')} aria-label={pt(t, 'st.bindingTitle')}
            onChange={event => setBindingForm(previous => ({ ...previous, title: event.target.value }))} />
          <Select label={pt(t, 'st.bindingRepo')} value={bindingForm.repoId || defaultRepoId} options={repoOptions}
            onChange={next => setBindingForm(previous => ({ ...previous, repoId: next }))} />
          <Button variant="outline" size="sm" icon={<Icon name="plus" size={14} />}
            disabled={!bindingForm.chatId.trim()} onClick={() => onAddBinding()}>{pt(t, 'st.bindingAdd')}</Button>
        </div>
        {bindingError
          ? <p className="sa-error" id="sa-field-binding-chat-error" role="alert">{bindingError}</p>
          : null}
      </div>
      {saveBarFor('source')}
    </div>
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
      // The decision counts and their 24-hour window belong to the Eval ledger and the Overview summary; showing them
      // here too meant three pages quoting the same number (review P3). One link instead.
    ]
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'st.evalHint')}</Hint>
      <KeyValues rows={rows} />
      <div className="sa-actions">
        <Button variant="ghost" size="sm" icon={<Icon name="decision" size={14} />}
          onClick={() => navigate({ page: 'eval' })}>{pt(t, 'st.evalOpenLedger')}</Button>
      </div>
      <Hint>{pt(t, 'st.judgeHint')}</Hint>
      <div className="sa-field">
        <span className="sa-field-head">{pt(t, 'st.rules')}</span>
        {rules.length
          ? <KeyValues rows={rules.map(rule => [`${rule.id} · ${rule.name}`, rule.description])} />
          : <Hint>{pt(t, 'st.noRules')}</Hint>}
      </div>
    </div>
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
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'st.reviewIntro')}</Hint>
      <SettingsSwitchRow label={pt(t, 'st.reviewEnabled')} hint={pt(t, 'st.reviewEnabledHint')}
        checked={Boolean(field('review.enabled', review.enabled === true))} disabled={frozen}
        onChange={next => editField('review', 'review.enabled', next, review.enabled === true)} />
      <div className="sa-field">
        <span className="sa-field-head">{pt(t, 'st.reviewScope')}</span>
        <Select label={pt(t, 'st.reviewScope')} disabled={frozen} value={scope}
          options={[{ value: 'all', label: pt(t, 'st.reviewScopeAll') },
            { value: 'uncertain', label: pt(t, 'st.reviewScopeUncertain') }]}
          onChange={next => editField('review', 'review.scope', next, review.scope === 'uncertain' ? 'uncertain' : 'all')} />
      </div>
      <div className="sa-field">
        <label className="sa-field-head" htmlFor="sa-field-review-senders">{pt(t, 'st.reviewSenders')}</label>
        <div style={{ display: 'flex', maxWidth: '520px', minWidth: 0 }}>
          <Input id="sa-field-review-senders" value={String(senders ?? '')} disabled={frozen}
            aria-label={pt(t, 'st.reviewSenders')} aria-describedby="sa-field-review-senders-hint"
            onChange={event => editField('review', 'review.allowSenderIds', event.target.value, initialSenders)} />
        </div>
        <p className="sa-hint" id="sa-field-review-senders-hint">{pt(t, 'st.reviewSendersHint')}</p>
      </div>
      <div className="sa-field">
        <label className="sa-field-head" htmlFor="sa-field-expire">{pt(t, 'st.reviewExpire')}</label>
        <div style={{ display: 'flex', maxWidth: '220px', minWidth: 0 }}>
          <Input id="sa-field-expire" type="number" min={1} max={168} step={1} value={String(expireHours)} disabled={frozen}
            aria-label={pt(t, 'st.reviewExpire')}
            {...fieldAria('review', 'expire', 'sa-field-expire-hint')}
            onChange={event => editField('review', 'review.expireHours', event.target.value, String(review.expireHours ?? 24))} />
        </div>
        <p className="sa-hint" id="sa-field-expire-hint">{pt(t, 'st.reviewExpireHint')}</p>
        {fieldErrorMessage('review', 'expire')}
      </div>
      <Hint>{pt(t, 'st.reviewSummary', { pending: counts.pending ?? 0, answered: counts.answered ?? 0 })}</Hint>
      <Hint>{pt(t, 'st.reviewExample')}</Hint>
      {saveBarFor('review')}
    </div>
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
    // The gate auto-repair budget (0..6, default 2).
    const repairBudget = Number.isFinite(Number(executor.maxRepairRounds)) ? Number(executor.maxRepairRounds) : 2
    const rows = [
      [pt(t, 'st.gates'), gateText],
      [pt(t, 'st.repo'), config.repo ? <span className="sa-mono" translate="no">{config.repo}</span> : t('empty')],
      [pt(t, 'st.worktreeRoot'), config.worktreeRoot ? <span className="sa-mono" translate="no">{config.worktreeRoot}</span> : t('empty')],
    ]
    const switchRow = (key, labelKey, hintKey, initial) => <SettingsSwitchRow
      label={pt(t, labelKey)} hint={pt(t, hintKey)} checked={Boolean(field(key, initial))}
      disabled={frozen}
      onChange={next => editField('run', key, next, initial)} />
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'st.runHint')}</Hint>
      {switchRow('executor.enabled', 'st.execEnabled', 'st.execEnabledHint', executor.enabled === true)}
      {switchRow('executor.autoRun', 'st.autoRun', 'st.autoRunHint', executor.autoRun === true)}
      {switchRow('paused', 'st.paused', 'st.pausedHint', config.paused === true || data.paused === true)}
      {switchRow('pausedIntake', 'st.pausedIntake', 'st.pausedIntakeHint', config.pausedIntake === true)}
      {switchRow('pausedDispatch', 'st.pausedDispatch', 'st.pausedDispatchHint', config.pausedDispatch === true)}
      <div className="sa-field">
        <span className="sa-field-head">{pt(t, 'st.mrMode')}</span>
        <Select label={pt(t, 'st.mrMode')} disabled={frozen}
          value={field('gitlab.createMr', gitlab.createMr === 'push' ? 'push' : 'api')}
          options={[{ value: 'api', label: pt(t, 'st.mrModeApi') }, { value: 'push', label: pt(t, 'st.mrModePush') }]}
          onChange={next => editField('run', 'gitlab.createMr', next, gitlab.createMr === 'push' ? 'push' : 'api')} />
        <Hint>{pt(t, 'st.mrModeHint')}</Hint>
      </div>
      <div className="sa-field">
        <label className="sa-field-head" htmlFor="sa-field-timeout">{pt(t, 'st.timeout')}</label>
        <div style={{ display: 'flex', maxWidth: '200px', minWidth: 0 }}>
          <Input id="sa-field-timeout" type="number" min={1} max={1440} step={1}
            value={Number.isFinite(Number(field('executor.timeoutMs', timeout))) && field('executor.timeoutMs', timeout) !== ''
              ? Math.round(Number(field('executor.timeoutMs', timeout)) / 60000) : ''}
            disabled={frozen} aria-label={pt(t, 'st.timeout')}
            {...fieldAria('run', 'timeout', 'sa-field-timeout-hint')}
            placeholder={String(timeoutMinutes)}
            onChange={event => {
              const raw = event.target.value
              editField('run', 'executor.timeoutMs', raw === '' ? '' : Number(raw) * 60000, timeout)
            }} />
        </div>
        <p className="sa-hint" id="sa-field-timeout-hint">{pt(t, 'st.timeoutHint')}</p>
        {fieldErrorMessage('run', 'timeout')}
      </div>
      <div className="sa-field">
        <label className="sa-field-head" htmlFor="sa-field-repair">{pt(t, 'st.repairBudget')}</label>
        <div style={{ display: 'flex', maxWidth: '200px', minWidth: 0 }}>
          <Input id="sa-field-repair" type="number" min={0} max={6} step={1}
            value={field('executor.maxRepairRounds', repairBudget) === '' ? ''
              : String(field('executor.maxRepairRounds', repairBudget))}
            disabled={frozen} aria-label={pt(t, 'st.repairBudget')}
            {...fieldAria('run', 'repair', 'sa-field-repair-hint')}
            placeholder={String(repairBudget)}
            onChange={event => {
              const raw = event.target.value
              editField('run', 'executor.maxRepairRounds', raw === '' ? '' : Number(raw), repairBudget)
            }} />
        </div>
        <p className="sa-hint" id="sa-field-repair-hint">{pt(t, 'st.repairBudgetHint')}</p>
        {fieldErrorMessage('run', 'repair')}
      </div>
      <KeyValues rows={rows} />
      {saveBarFor('run')}
    </div>
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
    const defaultBackend = enabled.includes(routing.defaultBackend) ? routing.defaultBackend
      : enabled.includes(legacyBackend) ? legacyBackend : enabled[0] ?? 'dsh'
    const backendOptions = ROUTE_BACKENDS.map(backend => ({ value: backend.value, label: pt(t, backend.labelKey) }))
    const editWorkers = next => editField('worker', 'executor.workers', next, baseWorkers)
    const editRouting = next => editField('worker', 'executor.routing', next, baseRouting)
    const setRouting = next => editRouting({ ...routing, ...next })
    const toggleBackend = (backend, on) => editWorkers({ ...workers, [backend]: { ...(workers[backend] ?? {}), enabled: on } })
    const setBackendField = (backend, key, value) => editWorkers({ ...workers, [backend]: { ...(workers[backend] ?? {}), [key]: value } })
    const backendCard = backend => {
      const entry = workers[backend.value] ?? {}
      const on = backend.value in workers && entry.enabled !== false
      const catalog = botCatalog && typeof botCatalog[backend.value] === 'object' ? botCatalog[backend.value] : {}
      const models = Array.isArray(catalog.models) ? catalog.models : []
      return <div key={backend.value} className="sa-field">
        <SettingsSwitchRow label={pt(t, backend.labelKey)} disabled={frozen}
          checked={on} onChange={next => toggleBackend(backend.value, next)} />
        {backend.value === 'dsh' ? null : <>
          <div style={{ display: 'flex', gap: 'var(--sa-sp-8)', flexWrap: 'wrap', maxWidth: '560px', minWidth: 0 }}>
            <div style={{ flex: '1 1 180px', minWidth: 0, display: 'flex' }}>
              <Select className="sa-input-full" label={pt(t, 'st.workerModel')} disabled={frozen}
                value={models.some(model => model.id === entry.model) ? entry.model : ''}
                onChange={next => setBackendField(backend.value, 'model', next)}
                options={[{ value: '', label: pt(t, 'st.workerModelDefault') },
                  ...models.map(model => ({ value: model.id, label: model.name }))]} />
            </div>
            <div style={{ flex: '1 1 240px', minWidth: 0, display: 'flex', alignItems: 'center' }}>
              <span className="sa-mono">{catalog.path ?? pt(t, 'st.workerPathMissing')}</span>
            </div>
          </div>
        </>}
      </div>
    }
    return <div className="sa-settings-group">
      {settingsHeading()}
      <div className="sa-field">
        <span className="sa-field-head">{pt(t, 'st.enabledBackends')}</span>
        {ROUTE_BACKENDS.map(backendCard)}
      </div>
      <div style={{ display: 'flex', gap: 'var(--sa-sp-16)', flexWrap: 'wrap' }}>
        <div className="sa-field" style={{ flex: '1 1 220px', minWidth: 0 }}>
          <span className="sa-field-head">{pt(t, 'st.defaultBackend')}</span>
          <Select label={pt(t, 'st.defaultBackend')} disabled={frozen} value={defaultBackend}
            options={backendOptions} onChange={next => setRouting({ defaultBackend: next })} />
        </div>
      </div>
      {saveBarFor('worker')}
    </div>
  }

  /**
   * 「派单」— the read-only explanation (§5.7). Dispatch is not a setting any more: this page says how the engine
   * decides, what never reaches the model, what happens when the model cannot answer, and where dangerous actions are
   * stopped instead. The only editable facts are the default bot (Bot page) and backend availability (Worker group).
   */
  const renderDispatch = () => {
    const dispatch = executor.dispatch && typeof executor.dispatch === 'object' ? executor.dispatch : {}
    const defaultBot = String(executor.bot ?? 'generalist')
    const facts = [
      ['st.dispatchCandidates', {}],
      ['st.dispatchPick', {}],
      ['st.dispatchNoModel', { cacheSeconds: String(dispatch.cacheSeconds ?? 600) }],
      ['st.dispatchFallback', {}],
      ['st.dispatchDanger', {}],
      ['st.dispatchExplicit', {}],
    ]
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'st.dispatchHint')}</Hint>
      <div className="sa-field">
        <span className="sa-field-head">{pt(t, 'st.dispatchHow')}</span>
        <KeyValues rows={facts.map(([key, params]) => [pt(t, key), pt(t, `${key}Text`, params)])} />
      </div>
      <p className="sa-hint">{pt(t, 'st.dispatchDefaultNote', { id: defaultBot })}</p>
      <div className="sa-actions">
        <Button size="sm" variant="outline" onClick={() => navigate({ page: 'bots' })}>{pt(t, 'st.dispatchOpenBots')}</Button>
      </div>
    </div>
  }

  // ---- write-permission group: the three things the executor may write, with the high-risk merge called out ------
  const renderWrite = () => {
    const draft = drafts.write ?? {}
    const field = (key, fallback) => key in draft ? draft[key] : fallback
    const frozen = savingGroup === 'write'
    const token = gitlab.tokenConfigured === true
    const allowMerge = Boolean(field('executor.allowMerge', executor.allowMerge === true))
    return <div className="sa-settings-group">
      {settingsHeading()}
      <Hint>{pt(t, 'st.writeHint')}</Hint>
      <SettingsSwitchRow label={pt(t, 'st.allowPush')} hint={pt(t, 'st.allowPushHint')} disabled={frozen}
        checked={Boolean(field('executor.allowPush', executor.allowPush === true))}
        onChange={next => editField('write', 'executor.allowPush', next, executor.allowPush === true)} />
      <SettingsSwitchRow label={pt(t, 'st.allowReply')} hint={pt(t, 'st.allowReplyHint')} disabled={frozen}
        checked={Boolean(field('executor.allowReply', executor.allowReply === true))}
        onChange={next => editField('write', 'executor.allowReply', next, executor.allowReply === true)} />
      {/* The one irreversible permission: a warning tag, a warn-styled info tip and — while it is on — a standing
          warning line. Saving it is also the save that gets a second confirmation (U-06), because a merge cannot be
          undone by turning the switch back off. */}
      <SettingsSwitchRow label={pt(t, 'st.allowMerge')}
        hint={pt(t, token ? 'st.allowMergeHint' : 'st.allowMergeNoToken')}
        badge={<Tag tone="warning">{pt(t, 'st.highRisk')}</Tag>}
        tip={pt(t, 'st.allowMergeRisk')} tipWarn={true}
        checked={allowMerge} disabled={frozen || !token}
        onChange={next => editField('write', 'executor.allowMerge', next, executor.allowMerge === true)} />
      {allowMerge ? <p className="sa-banner">{pt(t, 'st.allowMergeOn')}</p> : null}
      {saveBarFor('write')}
    </div>
  }

  // ---- prompt group (read-only) -----------------------------------------------------------------------------
  const renderPrompt = () => {
    const brief = String(data.prompts?.workerBrief ?? '')
    return <div className="sa-settings-group">
      {settingsHeading()}
      {/* One sentence per fact: briefNote explains the raw value below, briefBuiltIn says built-in prompts ship with code. */}
      <Hint>{pt(t, 'st.briefNote')}</Hint>
      {brief
        ? <RawValue label={pt(t, 'st.briefLabel')} text={brief} />
        : <EmptyState icon="inbox" title={pt(t, 'st.briefEmpty')} hint={pt(t, 'st.briefEmptyHint')} />}
      <Hint>{pt(t, 'st.briefBuiltIn')}</Hint>
    </div>
  }

  const renderGroup = () => {
    if (active === 'review') return renderReview()
    if (active === 'eval') return renderEval()
    if (active === 'run') return renderRun()
    if (active === 'worker') return renderWorker()
    if (active === 'dispatch') return renderDispatch()
    if (active === 'write') return renderWrite()
    if (active === 'repos') return renderRepos()
    if (active === 'prompt') return renderPrompt()
    return renderSource()
  }

  // The rail promises what can be changed first: writable groups, then a divider + "参考" label + the read-only groups.
  // `data-reference` is the hook style.js de-emphasises them with; the button keeps its usual label and dirty dot.
  /** Selecting a group writes it into the panel route, so reload and deep links keep it. It scrolls only when the new
      group starts off-screen, and then to the page intro rather than the group heading: the old "scroll to the heading"
      yanked a taller-than-viewport group up and hid the write-back note and its buttons, so clicking a tab made the page
      jump (user report 2026-11-23). A short group never scrolled, which is why only some tabs jumped. */
  const selectGroup = id => {
    if (id === active) return
    setActive(id)
    navigate({ page: 'settings', group: id }, true)
    // Defer past the render; scroll the panel, not the host frame (scrollIntoView moves the outer window too).
    setTimeout(() => {
      const node = bodyRef.current
      const scroller = node && panelScroller(node)
      if (!scroller) return
      const top = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      if (top < 0 || top >= scroller.clientHeight) scrollPanelTo(introRef.current ?? node, { behavior: 'auto' })
    }, 0)
  }
  const settingsNavButton = group => <button key={group.id} type="button"
    className="sa-settings-group" aria-current={active === group.id ? 'true' : undefined}
    data-reference={group.reference ? 'true' : undefined}
    // The title is always present (what the button opens) and only gains the dirty suffix while the draft is unsaved.
    title={dirtyGroups.has(group.id) ? `${pt(t, group.labelKey)} · ${pt(t, 'st.unsaved')}` : pt(t, group.labelKey)}
    onClick={() => selectGroup(group.id)}>
    <Icon name={group.icon} size={14} />
    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
      {pt(t, group.labelKey)}
    </span>
    {/* The dot is decorative; the unsaved state is also in the accessible name, not only in the title tooltip. */}
    {dirtyGroups.has(group.id)
      ? <span className="sa-count" style={{ marginLeft: 'auto', color: 'var(--dsw-alias-state-warn-primary)' }}
        aria-hidden="true" data-empty="true">●</span>
      : null}
    {dirtyGroups.has(group.id) ? <span className="sa-sr-only">{`· ${pt(t, 'st.unsaved')}`}</span> : null}
  </button>
  const writableGroups = SETTINGS_GROUPS.filter(group => !group.reference)
  const referenceGroups = SETTINGS_GROUPS.filter(group => group.reference)

  // Add-repository form: identifier fields get a stable id/name and no autofill or spellcheck; a failed validation
  // marks the field it belongs to (aria-invalid + described-by) instead of only showing one banner at the bottom.
  const repoFieldProps = (key, required) => ({
    id: `sa-repo-field-${key}`,
    name: key === 'path' ? 'repo' : key,
    autoComplete: 'off',
    'aria-required': required ? 'true' : undefined,
    'aria-invalid': repoFieldErrors[key] ? 'true' : undefined,
    'aria-describedby': repoFieldErrors[key] ? `sa-repo-field-${key}-error` : undefined,
  })
  const repoFieldError = key => repoFieldErrors[key]
    ? <small className="sa-error" id={`sa-repo-field-${key}-error`} role="alert">{pt(t, repoFieldErrors[key])}</small>
    : null
  const repoFieldEdit = (key, value) => {
    setRepoFieldErrors(previous => settingsOmit(previous, key))
    setRepoForm(previous => ({ ...previous, [key]: value }))
  }

  // AC-10: show what saving will change before the request leaves the panel. Compare against the loaded repository,
  // not the draft, so a no-op save is visibly a no-op and token-only fields never enter the preview.
  // One text input bound to one repoEdit field; the add modal keeps its own form state, so this stays local.
  const repoEditField = (field, labelKey) => <label className="sa-field">
    <span className="sa-field-head">{pt(t, labelKey)}</span>
    <Input className="sa-input-full" value={repoEdit?.[field] ?? ''} aria-label={pt(t, labelKey)}
      onChange={event => setRepoEdit(previous => ({ ...previous, [field]: event.target.value }))} />
  </label>
  const repoEditRows = (() => {
    if (!repoEdit) return []
    const current = repos.find(item => item.id === repoEdit.id) ?? {}
    const rows = []
    const nameNow = current.name ?? current.id
    if (repoEdit.name !== nameNow) rows.push([pt(t, 'repos.field.name'), nameNow, repoEdit.name])
    const repoNow = current.repo ?? ''
    if (repoEdit.repo !== repoNow) rows.push([pt(t, 'repos.field.repo'), repoNow, repoEdit.repo])
    // Every field the editor owns is diffed, not only gates: a silently changed target branch is a delivery risk.
    const changed = [
      ['repos.field.baseBranch', current.baseBranch, repoEdit.baseBranch],
      ['repos.field.targetBranch', current.gitlab?.targetBranch, repoEdit.targetBranch],
      ['repos.field.baseUrl', current.gitlab?.baseUrl, repoEdit.baseUrl],
      ['repos.field.project', current.gitlab?.project, repoEdit.project],
      ['repos.field.uatUrl', current.gitlab?.uatUrl, repoEdit.uatUrl],
      ['repos.field.healthUrl', current.gitlab?.healthUrl, repoEdit.healthUrl],
      ['repos.field.verifyMode', current.verifyMode, repoEdit.verifyMode],
      ['repos.field.acceptance', current.acceptance, repoEdit.acceptance],
    ]
    for (const [key, before, after] of changed) if (String(before ?? '') !== String(after ?? '')) rows.push([pt(t, key), before ?? '', after])
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

  /** One add-repository input row: the label, the control, an optional hint and the field's own error line. */
  const repoInputField = (key, labelKey, { required = false, placeholder = undefined, hintKey = undefined } = {}) => (
    <label className="sa-field">
      <span className="sa-field-head">{pt(t, labelKey)}</span>
      <Input className="sa-input-full" value={repoForm[key]} aria-label={pt(t, labelKey)}
        placeholder={placeholder}
        {...repoFieldProps(key, required)}
        onChange={event => repoFieldEdit(key, event.target.value)} />
      {hintKey ? <small className="sa-hint">{pt(t, hintKey)}</small> : null}
      {repoFieldError(key)}
    </label>
  )

  return <>
    <div className="sa-settings-intro" ref={introRef}>
      <Hint>{pt(t, 'st.pageIntro')}</Hint>
      <div className="sa-actions">
        {reloadButton()}
        <Button variant="ghost" size="sm" icon={<Icon name="history" size={14} />}
          onClick={() => { void openHistory() }}>{pt(t, 'st.history')}</Button>
        {config.file ? <CopyButton value={config.file} label={pt(t, 'st.copyConfigPath')} /> : null}
      </div>
      <SettingsStatusLine view={reloadView} busy={reloadState.busy} />
    </div>
    <div className="sa-settings">
      <nav className="sa-settings-nav" aria-label={pt(t, 'st.navLabel')}>
        {writableGroups.map(settingsNavButton)}
        {referenceGroups.length
          ? <>
            <div className="sa-settings-nav-sep" aria-hidden="true" />
            <span className="sa-settings-nav-label">{pt(t, 'st.reference')}</span>
            {referenceGroups.map(settingsNavButton)}
          </>
          : null}
      </nav>
      <div className="sa-settings-body" ref={bodyRef}>
        {error ? <ErrorState error={error} onRetry={() => { void reload() }} /> : null}
        {renderGroup()}
      </div>
    </div>
    {historyOpen ? <Modal open={true} onClose={() => { if (!historyBusy) setHistoryOpen(false) }}
      title={pt(t, 'st.historyTitle')} closeLabel={t('close')} className="sa-history-modal"
      footer={<Button variant="outline" size="sm" disabled={historyBusy}
        onClick={() => setHistoryOpen(false)}>{t('close')}</Button>}>
      <p className="sa-hint">{pt(t, 'st.historyHint')}</p>
      {historyError ? <p className="sa-error" role="alert">{historyError}</p> : null}
      {historyBusy && !historyEntries.length ? <Hint>{pt(t, 'st.historyLoading')}</Hint> : null}
      {historyEntries.length
        ? <div className="sa-history-list">{historyEntries.map(entry => <div key={entry.id} className="sa-history-row">
          <div className="sa-history-main">
            <span className="sa-history-label">{historyLabel(entry)}</span>
            <span className="sa-hint"><When at={entry.at} /></span>
          </div>
          <HistoryChanges t={t} entry={entry} open={Boolean(historyChangesOpen[entry.id])}
            onToggle={toggleHistoryChanges} />
          <ConfirmButton label={pt(t, 'st.historyRestore')} title={pt(t, 'st.historyRestoreTitle')}
            message={pt(t, 'st.historyRestoreMessage')} confirmLabel={pt(t, 'st.historyRestoreConfirm')}
            onConfirm={async () => { await restoreHistory(entry.id) }} />
        </div>)}</div>
        : (!historyBusy && !historyError ? <Hint>{pt(t, 'st.historyEmpty')}</Hint> : null)}
    </Modal> : null}
    {repoEdit ? <Modal open={true} onClose={() => { if (!repoEditBusy) setRepoEdit(undefined) }}
      title={pt(t, 'repos.editTitle', { name: repoEdit.name || repoEdit.id })} closeLabel={t('close')}
      className="sa-repo-modal"
      footer={<>
        <Button variant="ghost" disabled={repoEditBusy} onClick={() => setRepoEdit(undefined)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={repoEditBusy} onClick={() => { void saveRepoEdit() }}>
          {repoEditBusy ? t('saving') : t('save')}
        </Button>
      </>}>
      <p className="sa-hint">{pt(t, 'repos.editHint')}</p>
      <div className="sa-repo-diff">
        <span className="sa-field-head">{pt(t, 'repos.editDiff')}</span>
        {repoEditRows.length
          ? repoEditRows.map(([label, before, after], index) => <div key={index} className="sa-diff-row">
            <span className="sa-diff-label">{label}</span>
            <code className="sa-mono sa-diff-old" translate="no">{before || '—'}</code>
            <span className="sa-hint" aria-hidden="true">→</span>
            <code className="sa-mono sa-diff-new" translate="no">{after || '—'}</code>
          </div>)
          : <p className="sa-hint">{pt(t, 'repos.editNoChanges')}</p>}
      </div>
      <div className="sa-form-grid">
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.name')}</span>
          <Input className="sa-input-full" value={repoEdit.name} aria-label={pt(t, 'repos.field.name')}
            onChange={event => setRepoEdit(previous => ({ ...previous, name: event.target.value }))} />
        </label>
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.repo')}</span>
          <Input className="sa-input-full" value={repoEdit.repo} aria-label={pt(t, 'repos.field.repo')}
            onChange={event => setRepoEdit(previous => ({ ...previous, repo: event.target.value }))} />
        </label>
        {repoEditField('baseBranch', 'repos.field.baseBranch')}
        {repoEditField('targetBranch', 'repos.field.targetBranch')}
        {repoEditField('baseUrl', 'repos.field.baseUrl')}
        {repoEditField('project', 'repos.field.project')}
        {repoEditField('uatUrl', 'repos.field.uatUrl')}
        {repoEditField('healthUrl', 'repos.field.healthUrl')}
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.verifyMode')}</span>
          <Select label={pt(t, 'repos.field.verifyMode')} value={repoEdit.verifyMode}
            options={[{ value: 'manual', label: pt(t, 'repo.verifyModeManual') },
              { value: 'web-uat', label: pt(t, 'repo.verifyModeWebUat') }]}
            onChange={value => setRepoEdit(previous => ({ ...previous, verifyMode: value }))} />
        </label>
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.acceptance')}</span>
          <Select label={pt(t, 'repos.field.acceptance')} value={repoEdit.acceptance}
            options={[{ value: 'merged', label: pt(t, 'repo.acceptanceMerged') },
              { value: 'deployed', label: pt(t, 'repo.acceptanceDeployed') }]}
            onChange={value => setRepoEdit(previous => ({ ...previous, acceptance: value }))} />
        </label>
        <div className="sa-field" style={{ gridColumn: '1 / -1' }}>
          <span className="sa-field-head">{pt(t, 'repos.gates')}</span>
          {repoEdit.gates.length
            ? repoEdit.gates.map((gate, index) => <div key={index} className="sa-card" style={{ marginBottom: 8, padding: 10 }}>
              <div className="sa-form-grid">
                <label className="sa-field">
                  <span className="sa-field-head">{pt(t, 'repos.gateName')}</span>
                  <Input className="sa-input-full" value={gate.name ?? ''} aria-label={pt(t, 'repos.gateName')}
                    onChange={event => editGate(index, 'name', event.target.value)} />
                </label>
                <label className="sa-field">
                  <span className="sa-field-head">{pt(t, 'repos.gateCommand')}</span>
                  <Input className="sa-input-full" value={gate.command ?? ''} aria-label={pt(t, 'repos.gateCommand')}
                    onChange={event => editGate(index, 'command', event.target.value)} />
                </label>
                <label className="sa-field">
                  <span className="sa-field-head">{pt(t, 'repos.gateCwd')}</span>
                  <Input className="sa-input-full" value={gate.cwd ?? ''} placeholder={pt(t, 'repos.gateCwdPlaceholder')}
                    aria-label={pt(t, 'repos.gateCwd')} onChange={event => editGate(index, 'cwd', event.target.value)} />
                </label>
                <label className="sa-field">
                  <span className="sa-field-head">{pt(t, 'repos.gateTimeout')}</span>
                  <Input className="sa-input-full" type="number" min={1} value={gate.timeoutMs ?? ''}
                    aria-label={pt(t, 'repos.gateTimeout')}
                    onChange={event => editGate(index, 'timeoutMs', event.target.value)} />
                </label>
                <Select label={pt(t, 'repos.gateOnFail')} value={gate.onFail ?? 'manual'}
                  options={[{ value: 'manual', label: pt(t, 'repos.gateOnFail.manual') },
                    { value: 'auto_repair', label: pt(t, 'repos.gateOnFail.auto_repair') }]}
                  onChange={value => editGate(index, 'onFail', value)} />
                <label className="sa-field">
                  <span className="sa-field-head">{pt(t, 'repos.gateDryRun')}</span>
                  <Input className="sa-input-full" value={gate.dryRunCommand ?? ''}
                    aria-label={pt(t, 'repos.gateDryRun')} onChange={event => editGate(index, 'dryRunCommand', event.target.value)} />
                </label>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setRepoEdit(previous => ({ ...previous,
                gates: previous.gates.filter((item, position) => position !== index) }))}>{pt(t, 'repos.gateRemove')}</Button>
            </div>)
            : <p className="sa-hint">{pt(t, 'repos.gateEmptyEditor')}</p>}
          <Button variant="outline" size="sm" onClick={() => setRepoEdit(previous => ({ ...previous,
            gates: [...previous.gates, { name: '', command: '', onFail: 'manual' }] }))}>{pt(t, 'repos.gateAdd')}</Button>
          <small className="sa-hint">{pt(t, 'repos.gatesJsonHint')}</small>
        </div>
      </div>
      {repoEditError ? <p className="sa-banner sa-danger">{repoEditError}</p> : null}
    </Modal> : null}
    {repoModalOpen ? <Modal open={true} onClose={() => { if (!repoSaving) setRepoModalOpen(false) }}
      title={pt(t, 'repos.addTitle')} closeLabel={t('close')} className="sa-repo-modal"
      footer={<>
        <Button variant="ghost" disabled={repoSaving} onClick={() => setRepoModalOpen(false)}>{t('cancel')}</Button>
        <Button variant="primary" disabled={repoSaving} onClick={() => { void submitRepo() }}>
          {repoSaving ? t('saving') : pt(t, 'repos.add')}
        </Button>
      </>}>
      <p className="sa-hint">{pt(t, 'repos.addHint')}</p>
      <div className="sa-form-grid">
        {repoInputField('id', 'repos.field.id', { required: true, hintKey: 'repos.field.idHint' })}
        {repoInputField('name', 'repos.field.name')}
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.kind')}</span>
          <Select label={pt(t, 'repos.field.kind')} value={repoForm.kind}
            options={[{ value: 'web', label: pt(t, 'repos.kindWeb') }, { value: 'oracle-ebs', label: pt(t, 'repos.kindEbs') }]}
            onChange={next => setRepoForm(previous => ({ ...previous, kind: next,
              verifyMode: next === 'oracle-ebs' ? 'manual' : 'web-uat',
              acceptance: next === 'oracle-ebs' ? 'merged' : 'deployed' }))} />
        </label>
        {repoInputField('path', 'repos.field.repo', { required: true, placeholder: '/Users/you/work/my-repo', hintKey: 'repos.field.repoHint' })}
        {repoInputField('baseBranch', 'repos.field.baseBranch', { required: true })}
        {repoInputField('targetBranch', 'repos.field.targetBranch', { required: true })}
        {repoInputField('baseUrl', 'repos.field.baseUrl', { required: true, placeholder: 'https://gitlab.example.com' })}
        {repoInputField('project', 'repos.field.project', { required: true, placeholder: 'group/project' })}
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.verifyMode')}</span>
          <Select label={pt(t, 'repos.field.verifyMode')} value={repoForm.verifyMode}
            options={[{ value: 'web-uat', label: pt(t, 'repos.verifyWebUat') }, { value: 'manual', label: pt(t, 'repos.verifyManual') }]}
            onChange={next => setRepoForm(previous => ({ ...previous, verifyMode: next }))} />
        </label>
        <label className="sa-field">
          <span className="sa-field-head">{pt(t, 'repos.field.acceptance')}</span>
          <Select label={pt(t, 'repos.field.acceptance')} value={repoForm.acceptance}
            options={[{ value: 'deployed', label: pt(t, 'repos.acceptDeployed') }, { value: 'merged', label: pt(t, 'repos.acceptMerged') }]}
            onChange={next => setRepoForm(previous => ({ ...previous, acceptance: next }))} />
        </label>
        {repoInputField('uatUrl', 'repos.field.uatUrl', { placeholder: 'https://uat.example.com' })}
        {repoInputField('healthUrl', 'repos.field.healthUrl', { placeholder: 'https://uat.example.com/health' })}
      </div>
      <SettingsSwitchRow label={pt(t, 'repos.field.makeDefault')} hint={pt(t, 'repos.field.makeDefaultHint')}
        checked={repoForm.makeDefault} disabled={repoSaving}
        onChange={next => setRepoForm(previous => ({ ...previous, makeDefault: next }))} />
      {repoError
        ? <>
          <p className="sa-error" role="alert" id="sa-repo-error" tabIndex={-1}>{repoError}</p>
          <p className="sa-hint">{pt(t, 'repos.fixHint')}</p>
        </>
        : null}
    </Modal> : null}
    {configSampleOpen ? <Modal open={true} onClose={() => setConfigSampleOpen(false)}
      title={pt(t, 'repos.sampleTitle')} closeLabel={t('close')} className="sa-glossary-modal"
      footer={<Button variant="outline" size="sm" onClick={() => setConfigSampleOpen(false)}>{t('close')}</Button>}>
      <p className="sa-hint">{pt(t, 'repos.sampleHint')}</p>
      <div className="sa-md-code">
        <div className="sa-md-code-head">
          <span className="sa-md-code-lang">live.json</span>
          <CopyButton value={REPO_CONFIG_SAMPLE} label={pt(t, 'repos.sampleCopy')} />
        </div>
        <pre className="sa-md-pre" translate="no">{REPO_CONFIG_SAMPLE}</pre>
      </div>
    </Modal> : null}
  </>
}
