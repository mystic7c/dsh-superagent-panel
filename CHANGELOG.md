# Changelog

## [1.1.17] — 2026-11-25

### 人按的重跑接着上一轮的对话

「追加并重跑」过去只保留工作树里的改动，worker 每次都是新会话：它得重新读一遍代码，也不知道自己上一轮为什么那么写。现在 `manual` / `revise` / `resume` 触发的 run 会续上一轮 run 的 worker 会话——同 worktree、同后端，Claude 还要会话文件仍在磁盘上；自动分派（`auto`）仍开新会话。

- `lib/live/executor.js`：新增 `continuationOf({ previousRun, backend, log, exists })`；`executeTicketInner` 在占用 `ticket.runId` 之前读上一轮 run（`runOf`），把结论作为 `resume` 传给两个后端的主轮（CLI 走 `--resume`，DSH 走 `agents.resume`）；repair 轮仍然续自己这一轮的会话。换后端、会话文件丢失、首次运行三种情况都静默降级为新会话并记一行日志。
- run 记录多一个 `worker.resumedFrom`；工单详情在 run 行上显示「续接上一轮」标签，鼠标悬停说明这次不是重新认识仓库。
- `lib/live/worker-cli.js`：新增 `claudeSessionExists(sessionId)`——`claude --resume` 找不到会话会让整轮失败，所以续之前先确认 `~/.claude/projects/*/<sid>.jsonl` 还在。
- 「追加并重跑」的提示改成「保留当前工作树的改动，也接着上一轮的对话改」。
- `docs/worker-bots.md` 不变量 1 补一段：run 仍是会话边界，人触发的重跑是唯一有意的放宽，以及为什么。

### 验证

- `lib/live/executor.test.js` +2（`continuationOf` 的四条边界；`revise` 把上一轮会话交给 worker 并记进 `worker.resumedFrom`，首次运行不带 `resume`）；全量 753 pass；`render-check` 323 项 0 FAIL。

## [1.1.14] — 2026-11-24

把 1.1.13 只做在 CLI 上的「修复轮续接」补到 DSH worker。

### DSH worker 的修复轮续接

- `lib/live/worker.js` 的 `runWorker` 新增 `resume`：给了持久化的会话 id 就走 `agents.resume({ resumeSessionId })`（宿主先加载对话），不再每轮 `agents.create` 开一个新会话。`setup` 照旧在新作用域里重建，所以 brief、工具守卫、审批策略、Bot 的 prompt sections 一个都不少。
- `lib/live/executor.js`：自动修复轮传 `resume: run.worker?.sessionId`，与 CLI 分支同一条规则——修复时它记得自己上一轮读了什么、改了什么。
- 两条兜底：宿主没有 `agents.resume`（旧 DSH）→ 记一行日志，照常开新会话；会话文件已不存在或被别的进程占着 → 同样退回新会话，不让「续不上」变成一个失败的 run。

### 为什么 DSH 没有「在终端接管」

DSH worker 的会话本来就是一等 Session：运行行的「打开 Session」就是接管，在 GUI 里能接着聊。本机也没有 TUI app（`dsh-tui` 不在安装包里，`~/.dsh/profiles` 只有 desktop/dev/headless/sdk/web），`dsh tui --resume` 直接报 profile 不存在；唯一能续跑持久化会话的是 `dsh --profile headless --session-id <id> "…"`，那是命令而不是终端。

### 验证

- `node --test lib/live/*.test.js`：worker 新增三例（修复轮走 `agents.resume` 且重建 setup、宿主无 resume 时退回创建、resume 失败退回创建）。
- `render-check`、`build-client --check`、`check-keys`、`npm run types`、`check:js` 全绿。

## [1.1.13] — 2026-11-24

把 Claude Code CLI 会话接进面板：CLI worker 不再是一次性黑盒，运行中可以看、跑完可以接着聊、还能直接接管到终端。

### 运行时可见（CLI worker 的实时 trace）

- `lib/live/worker-cli.js`：`runProcess` 增加 `onStdout` 观测点，`runCliWorker` 增加 `onTrace` 与行缓冲，把 stream-json 的每一行即时解析成 trace 条目（新增导出 `streamedEvents`）；进程退出时冲刷最后一行（CLI 常不带尾随换行，`result` 就在缓冲里）。解析结果仍是权威来源，`run.trace` 的最终内容不变。
- `lib/live/executor.js`：CLI 分支把 `onTrace` 接到 `liveTrace.push`，与进程内 DSH worker 同一条 §12 实时链路——CLI 运行期间详情页不再空白，直到回合结束才有 trace。

### 跨轮续接（同一条 Claude Code 会话）

- `cliInvocation` 支持 `resume`（claude 加 `--resume <id>`，与 `--append-system-prompt`/`--json-schema`/权限参数并存，已用本机 claude 2.1.329 实测：续接后返回同一 `session_id`、记得上一轮的答案）。
- 自动修复轮次 `resume` 主回合的会话：修复时不再从一段「刚写完什么都不记得」的新对话开始。Codex 暂无核实的续接方式，不加参数。

### 在终端接管

- 新增 `lib/live/worker-terminal.js` + Host 路由 `POST /superagent/api/engine/workers/terminal`：为当前 GUI 会话开一个侧边终端（worktree 目录、120x32），输入 `claude --resume <id>`；没有可续接的 id 时开一个新的 `claude`。首个按键即由人接管，和自己在终端里开一样。
- 会话标识按 `/^[A-Za-z0-9_-]{1,128}$/` 校验后才拼进 shell 命令行；缺会话 / 会话未运行 / 无终端服务 / 超出终端上限都返回带原因的 4xx，而不是 500。
- `cliInvocation` 只在会话 id 是 UUID 形状时才加 `--resume`：`claude --resume <value>` 会把未知值当**会话标题**去匹配，而流里没拿到 `session_id` 时会退化成 `worker-xxxxxxxx` 这种合成 id——以前理论上可能续到别人的会话，现在直接不加该参数。
- 客户端：`PanelProvider` 新增 `currentSessionId`（点击时读取：`sidebarRight.mounted`，面板占着主栏时它为空，退回工作区自己的选择记录 `dsh.sessions.current`），运行行在 `worker.backend === 'claude'` 且有 worktree 时显示「在终端接管」按钮；DSH 运行仍走「打开 Session」，Codex 运行两者都没有。
- 同一个运行再点一次会回到已经在跑的那个终端（按标题认领，`reused: true`），不会占用宿主仅有的几个 agent 终端位、也不会在同一个会话上再起一个 Claude Code。

### 「会话」页：左边会话列表，右边对话

- 新增「会话」页（页签在「执行」与「设置」之间），和宿主自己的形状一致：左边是这个仓库 Claude Code CLI worker 跑过的会话，右边是那条会话的对话——不是一块终端。
- 对话是真的那条 CLI 会话：每条消息就是一次 `claude -p --resume <session_id>`（`POST /superagent/api/engine/workers/chat`），所以之前的上下文、它对仓库的了解都还在；回复由 CLI 的 stream-json 渲染成 markdown，上面一行写这次做了几步、花了多久（`完成 2 步 · 13s`），没跑完则写原因。
- 列表来自引擎的 runs（`worker.backend === 'claude'`），按会话去重（修复轮与主回合同一个 `session_id`，不会变两行），一行显示工单标题、会话短 id 与时间；从运行行点「继续对话」直接落到这条会话。
- 只有 UUID 形状的会话 id 才会续接（`claude --resume <value>` 会把别的值当**会话标题**去找），消息与工作区路径都在 Host 侧校验后才拼进 argv；一条消息最多一次跑 10 分钟，失败/超时作为一条带原因的回复留在对话里，不会静默消失。
- 终端没有丢，只是退成逃生口：会话页右上「在终端里打开」还是那条 `claude --resume` 的 TUI（面板自己的 xterm 渲染，宿主只提供 PTY），给聊天框表达不了的场景用；「返回对话」回到聊天。
- 终端渲染的细节（`client/src/terminal.js`）：`snapshot` 先 `reset()` 再按 `info.cols/rows` 定尺寸、`output` 直接写，写完 `acknowledge(revision)`；`ResizeObserver` 走 `fitGrid`（按 `environment.maxCols/maxRows` 夹紧）把容器尺寸同步回宿主；刚开的终端本窗口 roster 还是旧缓存，第一次 `refresh()` 会 `missingTerminal`，故退避重试（最多 8 次、间隔 350ms）；`view.state` 的订阅通知不带参数，用计数器重渲染、渲染时读 `getSnapshot()`。

### 验证

- `lib/live/worker-cli.test.js` 28/28（新增 resume argv、续接透传、流式 trace 三例）；新增 `lib/live/worker-terminal.test.js` 6/6（接管参数与策略、无 id 开新会话、注入形态 id 拒绝、缺会话/无服务/超上限、写入失败关闭终端）。
- `lib/live/worker-chat.test.js` 6/6：一条消息＝一次续接的 CLI 回合（工作区、`bot: 'write'`、不带 schema）、无 id 开新会话、非 UUID 一律 400 且不 spawn、消息/目录/长度校验、CLI 失败如实报错、历史读取（thinking/sidechain/工具结果不进对话，工具调用计数，只留最近 N 条）。
- `render-check`：新增 claude 运行夹具，断言「claude 运行显示『继续对话』、Codex 与 DSH 运行不显示」；另加会话页六条（按会话去重、只有 UUID 可续接、列表与选中、聊天框与终端入口、开场说明、步数与失败提示）与帧协议三条。
- 本机实测：真实 `claude` 走 `runCliWorker` 流式产出 `assistant`/`turn_end`，再用 `--resume` 续接同一 `session_id` 答出上一轮的 `PINEAPPLE`；dev 实例（独立端口 + 独立状态目录）上路由按 400/409 拒绝非法请求。接管全链路在浏览器里点通：运行行点「在终端接管」→ 会话页选中该会话并自动开终端、`connected`、屏上是 `claude --resume f46922bb-…` 恢复出的上一轮对话（PINEAPPLE 问答），可继续输入。

## [1.1.12] — 2026-11-24

### 设置 → 仓库改为列表

- 仓库不再用两列卡片：每行一个仓库，事实（项目、远程地址、本地路径、分支、闸门、验证/验收方式）折行排在行内，令牌编辑与测试结果仍在行内；行之间用发丝线分隔（`sa-repo-list` / `sa-repo-row` / `sa-repo-facts`）。
- `render-check` 断言同步：由「两列卡片网格」改为「一行一个仓库、列表内没有卡片」。

### 打包文件名

- 新增 `npm run pack:release`（`scripts/pack-release.mjs`）：`npm pack` 的 scoped 文件名（`mystic7c-dsh-superagent-panel-<v>.tgz`）统一改成 `dsh-superagent-panel-<v>.tgz`，与 `local-install.mjs` 的默认查找、`docs/delivery.md`、`docs/self-development.md`、README 一致；不再需要 `--tarball` 绕过。

## [1.1.11] — 2026-11-24

第十批：整体代码走查 + UI 体检（设计 A 27/40、检测 B 1 个 P1）后的修复，重点是把「哪条信息归哪个页面」重新钉死。

### 信息归属（本次重点）

- **来源页不再复述仓库配置**：项目/远程地址/目标分支/令牌/本地路径/分支/验证与验收方式只留在「设置 → 仓库」；来源页的仓库卡改成运营卡（状态、执行工单/待合并 MR/UAT、打开项目、管理仓库），信号台账移到页面主体最前面。
- **检查新消息只留两个入口**：顶部状态条与来源页；概览、执行页的自动化条都去掉了重复按钮。
- **重新加载配置全站一个**：移到设置页头（与变更历史/复制路径同一行），来源与仓库分组里各自那份删掉。
- **手工建单只在执行页**：设置 → 运行里的第二份表单删除，文案与 render-check 断言同步。
- **概览不再重复暂停横幅**：暂停/未运行由顶部状态条与执行页自动化条负责；概览只保留设置清单（页头的「还有 N 项待配置」在概览页隐藏，不再和清单并排出现）。
- **绑定的写入走草稿**：监听群 → 仓库绑定不再即时写 `live.json`，改为进入设置草稿，保存时按高风险变更确认。
- **仓库编辑器补全**：远程地址、GitLab 项目、基分支/目标分支、验证/验收方式、UAT/健康检查地址现在都能在弹窗里改（Host 的 `updateRepoDefinition` 早已接受这些字段，之前 UI 只回传三个）。
- **能力矩阵改为指向 Bot 页**：`设置 → Worker` 不再和 Bot 页的后端核验状态抢同一件事。
- 部署与限制块只保留全局文件事实（配置文件、路径、worktree 根），逐仓库事实回到仓库卡。

### 客户端逻辑

- 详情页粘性头不再粘住不消失（`stuckRef` 跨轮询保留）；验收不通过的拒收理由移到按钮下方，切工单时清空。
- 最近一次运行不再把 running/interrupted/stopped 一律写成「运行成功」，按 `runView` 给标签。
- 执行器开关判定统一为 `executorOn()`，引擎开关统一为 `engineOn()`（此前有 truthy / `=== true` / `!== false` 三种读法）。
- 相对时间由 30s 共享时钟刷新（轮询会在负载相同的时候跳过，`When` 原本会冻住）。
- 顶部「需要你处理 N 件」优先用 blocking 行数，不再和概览的清单数字打架。
- 触发页首行点击、空状态判定、翻页边界；评估页越界深链的诚实提示；弹窗 Esc 只关最上层、Tab 焦点跳过隐藏控件；信号列表只有一个 `role=status`；运行列表按开始时间排序（`sortRunsNewestFirst`）后再取最新闸门与改动。
- 闸门「已通过」计数兼容没有 `state` 的旧运行（看 `exitCode`/`timedOut`），与交付证据的 6/6 一致。

### Host / 引擎

- GitLab PAT 不再发给 api.github.com（GitHub 调用只读 `GITHUB_TOKEN`）；GitLab/GitHub 的响应体读取超时不再被 `.catch(() => '')` 吞成空成功。
- 仓库禁用时消息在评估前就记为 `skipped`（可重放），不再先判成 accepted 再丢弃。
- 自动化设置不再被运行落盘时的旧 ticket 覆盖；web-uat 先合并后建基线时会直接判定 deployed，不再永久卡在 deploy-pending。
- 闸门输出改为有界滚动尾巴 + 流式 `markerSeen`（长日志不再整段驻留内存，`requireOutput` 也不会因为落在 4000 字符之前就误判缺证据）。
- abort/timeout 的 `runCommand` 与 CLI `runProcess` 都加了硬结算定时器（孙进程占着管道时不再永久 working 并占住 claim）。
- `maxExecutions: 0` 视为不限次（不再变成 1）；`verifySeconds` 读写同用 30 秒下限；显式 repo id 走字符集校验；legacy `gitlab.tokenFile` 只被第一个仓库继承；event id 超过安全整数时保留字符串。
- `live.json` 顶层不是对象时拒绝覆盖；evidence/shadow/worker-bot 的临时文件名加随机后缀、evidence 写入串行化。

### 体检项

- 评估页筛选组标签对比度 3.71:1（低于 DESIGN.md 的 11–12px raised token 规则）改用 `--sa-label-tertiary`。

### 验证

- `node --test lib/live/*.test.js` → **734 pass / 0 fail**。
- `node scripts/render-check.mjs` → **309 checks / ok:true / 0 fail / 1 skip**（唯一 skip 是本机没有可检查的 UAT 仓库卡）。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs` 全绿。
- 独立实例逐页截图复核（7 页 + 工单详情），确认不再有重复的暂停横幅/配置清单/检查按钮。

## [1.1.10] — 2026-11-24

第九批：把上一轮 UI 体检里明确留作「重新设计量级」的三条 P2 补完。

### 详情页太长（390 下 56 屏）

- **运行记录 / 时间线按长度折叠**：`Section` 新增 `collapsible` / `open` / `onToggle`，标题行变成整行可点的 disclosure（`aria-expanded` + `aria-controls`，右侧 chevron 只做旋转）。运行记录超过 3 条、时间线超过 10 条时默认折叠，短工单不折（不为折叠而折叠）。实测同一张工单：时间线 25 条时 1280 页面高度 6352 → 4188px，390 从 6126 起算只到正文主体。
- **跳转条会先展开再滚**：点到「运行记录 / 时间线」时先打开目标区，等两帧再滚动，否则会停在一个只有标题的折叠块上（实测：折叠态点击跳转后 `aria-expanded=true`、`scrollTop` 落在 4005）。
- **顺带修掉 390 上两处更刺眼的问题**：详情粘性条原本三行（标题、跳转、主操作各占一行），把 390 的 20% 屏幕长期盖住——改为标题与主操作同一行 + 跳转一行；运行记录行标题原本被挤成一字一行（「交 付 时：」），现在行内换行而不是压缩。

### 「主要失败原因」只读

- 每条失败原因现在是按钮，点进执行页并已按「失败」档位过滤（`route.stage = 'failed'` 本来就被执行页读取）。实测注入两条失败数据后：两行都可点，`aria-label` 为「<原因> — 查看这些失败运行」，点击后 URL 变为 `execution?stage=failed` 且档位 chip 选中「失败」。

### 三组分段控件没有组名

- 评估页三组 chip 现在带可见小标题「决定类型 / 时间窗口 / 评估视图」（视觉层，读屏仍用 radiogroup 的 `aria-label`）；≤900 容器宽度下标题隐藏，不给窄屏加噪。「全部 / 全部 / 全部」的同名问题也因为第三组叫「全部视图」而消失。

### 验证

- `node --test lib/live/*.test.js` → **733 pass / 0 fail**。
- `node scripts/render-check.mjs` → **311 checks / ok:true / 0 fail / 0 skip**。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`（24 modules, 548858 bytes）、`node scripts/check-keys.mjs`（1068 / 541 / 1518）全绿。
- 独立实例（`/tmp/sa-r2`、独立端口、CDP 1280/390）逐条截图与 DOM 断言验证，见上。
- 回归防护再次生效：写 CSS 注释时带了反引号，`build-client.mjs` 的模板字面量守卫直接报 `style.js: 47 comment open(s) vs 46 close(s)`，在进浏览器之前就拦住了。

## [1.1.9] — 2026-11-24

第二轮整体审查（代码 + UI）后的第八批修复：客户端 12 条逻辑缺陷、Host / 引擎 20 条缺陷，以及两轮 UI 体检（设计 A 28/40、检测 B 0 个 P1）发现的可用性与无障碍问题。四条上批反馈的修复在本轮实测确认未回归。

### 客户端逻辑（client-review）

- **每条已结束的运行都被展开**：trace 的默认展开条件是「有 stopReason」，而任何结束的运行都有，于是一页里所有运行轨迹全开。现在按 `RUN_FAILURE_STOP_REASONS`（error/timeout/gate_failed/…/repair_limit）只展开失败运行。
- **自动化开关会自动弹回**：`mode === 'off'` 时切换开关，下一次渲染又按 `enabled` 复位。现在 `checked = form.enabled && form.mode !== 'off'`，且关闭态下开关禁用。
- **保存成功会把整组草稿清空**：`commitGroup` 在 reload 未回来前用服务端旧值覆盖 `drafts[group]`，保存期间输入的内容消失。现在保存前快照 `submitted`，reload 后只保留与快照不同的键。
- **深链会改写「上次查看」**：概览写入 `ovSaveLastSeen` 时不区分是否带 `route.id`，从工单深链进来会把游标推进。现在 `deepLinked` 时不写。
- **触发 / 来源页翻页在 popstate 后被重置**：筛选变化 effect 会把刚恢复的 offset 打回第一页。现在用 `restoringFilters` / `restoringSignalFilters` 标记 + `currentSlice` 镜像，只有筛选真的变化才重置。
- 其余：`stopped` / `gates-passed` 缺视图导致「状态未知」（补 TICKET_VIEW 与文案）、`runTrigger.heartbeat/repair` 没文案（定时巡检 / 自动修复）、执行器负载为 0 时整块消失（渲染图例、只省轨道）、搜索面板切换关键词时旧结果仍可点（先清空再 busy）、`uatBusy` 是全局布尔（改按 repoId，一次只跑一个仓库）、详情页头尾各有一份主操作（头随滚动让位时只保留粘性条那一份）。

### Host / 引擎（host-review）

- **已处理的信号会被重评并重复建单**：游标回退到 `firstFailed - 1` 后，其后已 `accepted/ignored` 的信号再次进入 `buildRecords`，而信号此刻读回不带 `status`，于是又开一张工单。现在按 `TERMINAL_SIGNAL_STATUSES` 跳过，游标回退不再复活已决信号。
- **追加要求返回 202 但什么都没跑**：`POST ticket/:id/revision` 直接 `executeTicket`，工单被占用时内部 409 只写日志。现在先 `assertTicketFree`，占用即 409。
- **轮询间隔可以设成 0 或极大值**：`pollSeconds` / `verifySeconds` 在 config 归一化、live-json 校验、调度 `setTimeout` 三处都没有上限，`setTimeout` 溢出会变成「每 tick 轮询一次」。现在夹在 2–3600s / 60–86400s。
- **重载后旧引擎还能写台账**：`stop()` 只关 LiveState，`pollSync` / `pollEvents` 循环没有 `disposed` 守卫，重载后旧循环会覆盖新引擎的台账。现在 `stop()` 关全部五本台账，循环开头检查 `disposed`，关闭后写入静默丢弃。
- **同一毫秒的临时文件互相覆盖**：收件箱、操作、验收、信号四处临时名用 `pid + Date.now()`。现在加 `randomBytes(6)` 并 try/catch 清理。
- **定时派发失败也吃掉配额**：`runs` 没增长时 `attempts/lastRunAt` 已落库。现在 `restoreScheduledAttempt` 归还配额与时钟。
- 其余（P3）：gate 的 `stop` 不再被 `requireExecutor` 403（release/retry 才查，release 另加 `requirePush`）；`refreshInbox` 路由包 try/catch；`/run` 校验 `body.backend` 在已启用后端内；`ticketView` 存在性检查改读 `state.tickets`（纯性能）；`labelSignal` 的读改写搬进 `signals.commit`；`replaySignal` 先去重 + 原子占位再 shadow，并新增 `markReplayedSignal` 治愈崩溃窗口；毒事件只把游标冻到失败点之前；远端分支删除按 `${repo.featurePrefix}${ticketId}` 精确匹配；认领到已 `merged` 的 MR 直接记 `merged`；`verifyTicketInner` 拒绝 `dismissed/closed`；新增 `assertBranchName`（拒前导 `-`、空白、`..`）；非 sha 的 diff base 直接丢弃；`failRun` 清 `stopRequested`；抽 `runGateBootstrap` 让手工发布也跑 `pnpm install --frozen-lockfile`。

### UI 体检（设计 A 28/40 + 检测 B）

- **「更多筛选」是空转开关**：`.sa-textlink { display: inline-flex }` 的优先级压过 `.sa-filter-toggle { display: none }`，点了只翻 `aria-expanded`，输入框位置不动。现在用 `.sa-filter-toggle.sa-textlink` 精确匹配，折叠区用 `.sa-filter-extra--collapsed` / `[data-open]` 控制。
- **触发页筛选墙**：左栏 5 个常驻输入把首条线程推到 y≈530。现在只留档位 chip + 搜索，「更多筛选」展开仓库/原因/日期（从 / 至）。
- **详情页 390 分区导航溢出**：跳转条 353px 只能放下 5 项，`运行记录`/`时间线` 被裁且容器不可滑。现在 `overflow-x: auto` 且当前项自动滚入视野。
- **两个 disclosure 的 `aria-expanded` 与可见性矛盾**：改动文件与时间线把「展开全部」写成 `aria-expanded={expanded}`，但被控制的区域一直可见，读屏播报「已折叠」。现在溢出项放进独立区域（`#sa-changed-files-more` / `#sa-timeline-more`），折叠时 `hidden`，`aria-controls` 指向它。
- **深色模式 placeholder 3.41:1**：全站没有 `::placeholder` 规则，13 个输入框用浏览器默认 `#757575`。现在统一取 `--dsw-alias-label-secondary` 并 `opacity: 1`。
- **搜索面板不是 combobox**：输入框没有 `role/aria-expanded/aria-controls/aria-activedescendant`，方向键不动。现在按 combobox 语义接线，↑/↓ 移动选中项、Enter 打开，选中行有可见底色。
- 其余：术语表在 ≤520px 改堆叠（弹窗在 `.sa-page` 外，容器查询管不到，改 `@media`）；390 主标签改 4 列网格（第七个不再单独折行成「小节标题」）；路由变化聚焦页面标题时先在 10 帧内重试（详情页数据未到时标题还不存在），并且仍然不聚焦滚动容器；`Section` 标题 `aria-label` 只留标题文字；相对时间 <60s 读「刚刚」而不是「现在」；「已验收」与「6 项未过闸门」冲突处补「已由人工验收放行（N 项未过）」；执行页窄屏的 MR 行加「证据 ·」前缀，不再像下一行的证据；`保存令牌 / 清除令牌` 在窄屏改为 outline 变体；Bot 的「复制内置」改「另存为副本」（旁边就是「复制为 JSON」）；来源页「最近同步」两种写法统一；评估页第三个「全部」改「全部视图」。
- **两处自伤（本轮实测发现并修掉）**：`unfinished` 在 `TicketDetail` 头里越界引用（移到 `DeliveryEvidenceCard` 并传 `accepted`）、`evidenceLabel` 加在 span 上但 `TicketRow` 没收这个 prop。两次都只有实测截图能发现——构建是绿的。

### 验证

- `node --test lib/live/*.test.js` → **733 pass / 0 fail**（host 侧 19 条新断言，覆盖信号重放、占用即 409、间隔上限、`disposed`、临时名、配额归还、分支名、diff base、`stopRequested`、bootstrap 等）。
- `node scripts/render-check.mjs` → **311 checks / ok:true / 0 fail / 0 skip**。门槛里三条断言按新行为重写：列头在分组名之前、改动文件/时间线的溢出区域用 `hidden` 表达、路由聚焦接受 `sa-page-head-title`。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`（1067 / 541 / 1517）全绿。
- 独立实例实测（`DSH_SUPERAGENT_STATE_DIR=/tmp/sa-r2`、独立端口、CDP 1280/390）：触发左栏折叠区高 0 → 展开 112px 且带「从 / 至」，首条线程上移到 y≈380；评估在 1280 无「更多筛选」、390 点开后 0 → 72px；执行页 390 的证据行带「证据 ·」前缀；详情页改动文件 5 + 1（折叠）/ 时间线 8 + 7（折叠）且 `aria-expanded` 与 `hidden` 一致；搜索输入框 `role=combobox`、14 个 option、↓ 后 `aria-activedescendant=sa-search-option-0` 且行有底色；设置页从 scrollTop 240 切「运行 / 仓库」后 Intro 与按钮仍在视口内。

## [1.1.8] — 2026-11-23

整体代码 + UI 审查后的第七批修复：4 条使用中反馈（触发页线程栏被 160px 内滚动条夹住、评估页筛选空档消失、执行页按仓库分组缺「查看全部」且列头压住分组名、设置页切页签把说明和按钮顶出屏幕），加上客户端 12 条逻辑缺陷、Host 侧 12 条缺陷，以及两轮 UI 体检（设计 A / 检测 B）发现的 17 条可用性与无障碍问题。

### 用户反馈的四条

- **触发页左侧线程列表太短 + 内部滚动条**：`.sa-pane-aside` 同时是 `position: sticky` 又带 `max-height: calc(64px + 32px*3)` 与 `overflow-y: auto`，1280 下只有 160px 高、线程只能露两行，还会和页面滚动条套成双滚动条。现在去掉 sticky/max-height/overflow，线程栏按内容撑开、由页面统一滚动（窄屏本来就是这套行为），并删掉 `@container (max-width:960px)` 里已冗余的覆盖。
- **评估页筛选条件因无数据而消失**：`kindOptions` 用 `value === 'all' || value === kind || counts[value] > 0` 过滤，于是「续做 / 停止 / 未完成」在没有命中时整颗 chip 消失，用户无法切到一个空结果再回看。现在固定渲染 `EVAL_KINDS` 全量六档，计数留给小标题。
- **执行页按仓库分组没有「查看全部 / 收起」，列头位置也错**：`队列头（工单 / 证据 / 操作）` 原先由 `TicketGroups` 塞进第一个 `Section` 内、跟在「已结束」「ebs」这些分组名后面，读起来像分组自己的说明；按仓库分组时又完全不带 10 条上限与展开按钮。现在列头在两种分组下都渲染在分组名之前（`execution.js` 直接放在 `.sa-exec-queue` 下，`TicketGroups` 的 header 提到 Section 之外），仓库分组同样复用 `EXEC_DONE_RECENT` 上限与共享的「查看全部（N）/收起」按钮。
- **设置页点左栏页签把说明和按钮顶出屏幕**：`selectGroup` 在 `setTimeout(0)` 里无条件 `scrollPanelTo(bodyRef)`，把面板滚到右栏正文顶部，于是 Intro 说明与「变更历史 / 复制路径」被顶走；右栏不够高时又不会滚，所以只在长分组上跳。现在只在正文顶部已经离开可视区时才滚（`top < 0 || top >= clientHeight`），并且滚的是正文而不是整个面板。

### 客户端逻辑（client-review）

- **仓库「测试配置」每次都抛错**：`ReposCard` 从 `usePanel()` 解构 `actions`，而 Panel context 里没有它（只有 `t/call/navigate/...`），每次点击都是 `TypeError`。改为 `usePanelData().actions`。
- **关掉「显示已结束」仍显示 10 条已结束**：`recentDone` 判断的是已被过滤后的 `inStage`，条件恒真。改为按 `doneAllowed` 判断并保留最近 10 条。
- **信号翻页越界后无路可回**：信号偏移超过总数时列表空、分页器又整块不渲染，只能刷新。现在 `clampPageOffset` 把越界偏移夹回最后一页（评估页同一式）。
- **URL 里带未知 kind/range 时整组筛选没有 tab 停靠点**：`evalUrlState` 不校验取值，`SegmentedControl` 于是所有 chip `tabIndex=-1`。现在 URL 状态按 `EVAL_KINDS` / `EVAL_RANGES` 校验，`SegmentedControl` 在值未知时也给第一颗可选项 `tabIndex=0`。
- **触发 / 来源页的仓库与原因筛选每个键都发一次请求**：防抖 effect 把 `repo`/`reason` 设成它们自己的旧值，依赖不变。现在输入先进 `repoInput`/`reasonInput`，300ms 后统一提交三个文本筛选。
- 其余：`total` 非数字时 `NaN` 分页；评估「已夹到最后一页」提示永不清除、`restoringFilters` 用 `setTimeout` 释放（改为消费即清）；`toast` id 用 `Date.now()` 会撞（改自增）；Markdown 标题层级在正文从 `##` 起跳时被固定成 h3/h4（按文档最小标题为基准）；`useLiveResource` 在 disabled 时永远 `loading: true`；清令牌被宿主拒绝后对话框仍关掉（`useAction` 现在返回 `result !== false`，确认框按 `false` 保持打开）；`Section` 的 `<h2>` 里塞了计数与按钮，屏幕阅读器把「运行质量去执行页」当标题念（加 `aria-label`）。

### Host / 引擎（host-review）

- **已忽略 / 已关闭的工单还会被定时派发**：`dismissTicket` 保留 `automation`，`automationSkipReason` 又不看 `dismissed|closed`，`maxExecutions` 没配时限不住。现在 `automationSkipReason` 直接返回 `dismissed`/`closed`，`executeTicketInner` 里非显式触发（manual/resume/revise）也拒绝已结束工单。
- **游标越过没有评估到的消息**：`fillSyncGap` 报出回填缺口、或某条消息评估失败时，`cursors[chatId]` 仍被推到 `maxSeq`，那段消息永远不会再读。现在游标取 `max(baseline, min(maxSeq, gap.from-1, failedSeq-1))`。
- **修复预算三处不一致**：执行器 `REPAIR_LIMIT = 3` / 默认 1、live.json 允许 6、workflow 默认 2。现在统一 `lib/live/repair.js`（上限 6、默认 2），配置归一化、校验消息、bot、repos、workflow 与执行器共用。
- **能力证据过期永远检测不到**：`environmentFor` 不传 `ctx.versions[backend]`，`version` 恒为 undefined。现在传 `hostVersionOf(ctx)`，且没有 `evidence.version` 的非兜底探针判 `unverified`。
- 其余：仓库停用时体检重放仍写入一个没落库的 `decisionId`（改在 markSignal 前返回 invalid）；同一 `dedupeKey` 的重复收件箱行永远不 resolve（改为 resolve 所有非规范行）；设置补丁类型不对时 500 而不是 400；`acceptAt` 状态面默认值 0.8 与配置 0.5 不一致；`7d` 窗口退化成全时段；worker 的 `setTimeout(Math.max(1, undefined))` 变成立即触发；原子写在 rename 后不 fsync 目录（新增 `syncDirectory` / `renameDurable`，11 个存储共用）；自动验证的传输超时也吃掉重试预算（现在按 `transportFailure` 退还一次）。

### UI 体检（设计 A + 检测 B）

- **列表标题把 Markdown 源码当正文**：评估 / 执行 / 概览 / 命令面板的行标题直接打印 `[标题](/Users/...)` 并在中途截断。新增 `plainTitle()` 去掉链接语法、反引号与多余空白。
- **窄屏筛选墙**：390 下 14 个筛选控件占掉半屏。现在仓库/原因/日期收进「更多筛选」折叠（仅 ≤600 容器），首行只留档位 chip、时间窗与搜索。
- **日期区间没有「从/至」**：两个「年/月/日」并排无法分辨。加上前后缀标签。
- **开关「开」看不出来**：`--dsw-alias-interactive-bg-active` 在本主题是 `#2631481a`（淡到看不见），DESIGN.md:157 要求的中性底导致开关与关闭态几乎同色。改用 `--dsw-alias-label-primary`（本主题 `#0f1115`）作图轨，视觉上明确、也没有抢走品牌色（U-05 仍通过）。这是对 DESIGN.md:157 字面要求的有意偏离，理由记录在此。
- **点击页签后整页出现 2px 黑框**：`shell.js` 路由变化时在没有页面标题的页面上聚焦滚动容器（`tabindex=-1`），焦点环把整个内容区框住，像调试框。现在只聚焦页面标题，没有标题时聚焦面板 h1；`.sa-scroll:focus-visible` 恢复 DESIGN 的 2px。
- **390 第七个页签被裁成半个字**：`.sa-tabs` 在 ≤600 容器改为换行。
- **触控目标只有 16.8px**：折叠摘要与复制链接加上 24px 最小高度。
- **Cmd+K 在术语表弹窗之后失焦**：弹窗自身的 `dialog.focus()` 在子组件之后执行，把输入框的焦点抢回来（3/3 复现）。现在弹窗只在内部没有任何焦点时才接焦点，搜索框连续两帧聚焦。
- **群 ID 输入框只有 placeholder**（补 `aria-label`）、清除令牌按钮在窄屏折行后像字段标题（改 outline 变体）、「明确」裸词（改「明确请求 / 推断候选」）、`24h`/`24 小时` 用词（统一 24 小时）、执行页「已忽略 8」与「全部 71」口径（改「其中已忽略 8」）、概览「主要失败原因」只显示一行省略号（改两行夹取）。

### 验证

- `node --test lib/live/*.test.js` → **712 pass / 0 fail**（新增：已忽略/已关闭工单不再自动执行、缺口与失败消息的游标不回退、修复预算默认 2 上限 6、版本缺失的探针判 unverified、停用仓库重放返回 invalid、重复收件箱行 resolve、设置补丁 400、acceptAt 0.5、7d 窗口、worker 超时兜底、rename 后目录 fsync、传输失败退还验证预算）。
- `node scripts/render-check.mjs` → **311 checks / ok:true / 0 fail / 0 skip**。渲染门槛的「列头在分组名之前」断言按新行为重写（旧断言编码的是被修掉的 bug）。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs` 全绿。
- 独立实例实测（`DSH_SUPERAGENT_STATE_DIR=/tmp/sa-review`、独立端口、CDP 截图）：1280 触发页线程栏从 160px 内滚动改为整页滚动且分页器可见；评估页六颗档位 chip 在 0 命中时仍全部渲染；执行页列头在「已结束」/仓库名之上，`查看全部（71）` 在按仓库分组下同样出现并展开到 71 行；设置页从 scrollTop 240 切到「运行 / 仓库」后落在 scrollTop 12，Intro 与两个按钮仍在视口内；术语表 → Esc → Cmd+K 后焦点落在搜索输入框。
- 回归防护：`scripts/build-client.mjs` 增加模板字面量守卫——CSS 注释里出现反引号会让 `PANEL_CSS` 提前结束（本次实际踩到：整站样式变成 `<style>NaN</style>`），现在构建直接报 `style.js: N comment open(s) vs M comment close(s)`。

## [1.1.7] — 2026-11-23

整体审查后的第六批修复（P3 批量）：一次 429/5xx 就让整次执行变红、GitLab 的登录页被报成「JSON 无效」、流水线第二页的失败 job 看不见、超长 job 日志整份读进内存、判定模型的输入没有上限，以及面板侧「失败和成功长得一样」的六处细节。

### 根因与修改

- **一次 429/5xx 让整次执行失败**：`gitlab.js` / `github.js` 的请求层没有重试，GitLab 侧抖一下就是一张红工单等人工重跑。现在只有幂等读（GET）会重试，默认三次、指数退避（500ms 起）、尊重 `Retry-After`（上限 5 秒）；写请求（建 MR、合并、发 note）一次都不重试，避免重复建单。
- **登录页被读成「JSON 无效」**：token/SSO 过期时 GitLab 回 200 + HTML 登录页，旧代码把它报成 invalid JSON，看的人以为是响应格式问题。现在按 `content-type`（或正文以 `<` 开头）识别为「返回了 HTML 页面，令牌或 SSO 会话可能已过期，请重新登录」。
- **流水线第二页的失败 job 看不见**：`listPipelineJobs` 只取首页 100 条，矩阵构建超过 100 个 job 时，第二页的失败被 `summarizeJobs` 判成绿、执行器照常放行。现在按页读到不满一页为止（上限 10 页）。
- **job 日志整份进内存**：`getJobTrace` 先 `response.text()` 再截尾，几十 MB 的 trace 全量进了内存和事件循环。现在优先流式读取、只保留尾部窗口；注入的 fetch 没有可读流时回退到原路径。
- **判定模型的输入没有上限**：`judge` 把整条消息原样作为 `state` 发给 provider，长消息既可能被截断也可能超时。现在 `clampJudgeState()` 在 8000 字符处从中间省略（保留开头 6000 + 结尾 2000 并写明省略了多少）。
- **失败提示和成功提示一样**：`notify(text, 'error')` 的第二参被 `notify` 丢掉，保存失败与保存成功同色同语气。现在 toast 接收 `tone`，失败渲染为 `.sa-toast-error` + `role="alert"`（新增 CSS 规则）。
- **删除失败但对话框关掉**：Bot 删除（`settings.js`）与收件箱「忽略并清理」（`overview.js`）都吞掉异常后正常返回，`ConfirmButton` 判成功、对话框关闭，而对象还在。现在抛出错误，对话框保留并显示原因。
- **`tone="warn"` 是没有的档位**：Tag 只有 `warning`，`tone="warn"` 让降级提示退化无警示色。
- **`scrollIntoView` 又回来了**：设置页跳组、跳段与外壳页签滚动都用它，会把宿主外框一起带动（正是之前移除它的原因）。现在统一走 `scrollPanelTo`。
- **快速切文件看到旧 diff**：`loadDiff` 无序列号，慢的旧响应会覆盖新选择。现在只有最新一次请求能写状态。
- **`i18n.js` 的三个未用 import**（`Input`、`same`/`stay`、`apply`）顺手删掉，也解开了 i18n↔controls↔api↔apply 的循环依赖。

### 验证

- `node --test lib/live/*.test.js` → 703 pass / 0 fail（新增 7 条：读请求重试而写请求不重试、200 HTML 登录页的提示、流水线第二页的失败 job、流式 trace 只留尾部、GitHub 503 重试与 HTML 提示、超长消息中间省略）。
- `node scripts/render-check.mjs` → 311 checks / ok:true / 0 fail / 0 skip（新增两条：失败动作是 `role="alert"` 的 `.sa-toast-error`、该规则真的写在 CSS 里）。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs` 全绿。
- 负向验证：去掉 `tone` 透传后 toast 检查拿到 `sa-toast role=status`；GitLab 写请求的 503 计数为 1（重试会重复建 MR）。

## [1.1.6] — 2026-11-23

整体审查后的第五批修复（P2，Host 侧十二条）：并发写丢更新、孤儿工单每两分钟撞一次平台 API、信号日志只增不减、机器人自己的回复回流成候选、重放被双击成两张工单、UUID 事件永久重取、`tkt_1` 的工作树被当成 `tkt_10` 的、没有 base 时推送守卫不扫已提交的密钥、旧 MR 状态盖住新 MR、远端删掉分支后跳过 push、MR 建失败读成已交付、`/gate` 同步等到分钟级操作跑完。

### 根因与修改

- **设置自动化丢掉一次执行**：`setTicketAutomation` 在临界区外以 `this.state.tickets[id]` 快照做 `normalizeAutomation`，再进 `atomic` 写回；调度 tick（`executions+1`、写 `nextAt`）插在中间时被整块覆盖，并可能把 `nextAt` 退回已触发的档位再派一次。现在 normalize 与合并都在同一个 `atomic` 里、读 `doc.tickets[id]`。
- **孤儿工单每 `verifySeconds` 撞一次平台 API**：`failed|pushed` 且有分支、没有 MR 的工单几乎每张都算孤儿，`reconcileTicketFromGitlab` 在 `no-mr` 时直接返回且不记尝试数，于是永久 120 秒一次。现在 `links.reconcile` 记 `attempts`/`nextAt`（10 分钟起、指数退避到 12 小时、8 次后 `exhausted`），`reconcileDue()` 决定这一轮要不要问，成功路径清掉它。
- **信号日志的回收豁免让上限失效**：`sweepPayloads`/`sweepScope` 对所有带 `decisionId|triggerId` 的行永久跳过，而每条被处理的消息都会被盖上这两个字段——2000/scope 只约束被过滤掉的行，`candidate.text` 永久保留，每次 commit 整份 `JSON.stringify`。现在豁免有 30 天时限，过期后正文照常清掉。
- **events 入口的过滤器比 sync 少五条**：`candidateOf(event)` 只查 channel 与监听群，`allowAnyHuman` 开启时机器人自己的回复会回流成新候选（自触发循环）。现在两条入口共用 `messageSkipReason()`：channel、监听群、系统消息、非文本、bot 自己、bot 发送者、回复前缀。
- **双击重放会建两张工单**：幂等检查在 `atomic` 外，两次并发都读不到对方的 replay decision。现在写库的同一个 `atomic` 里再查一次，命中就返回已存的那条（不 absorb）。
- **UUID 事件永久重取**：非数字 cursor 被刻意不写回，`failed` 时 `nextCursor` 退回原值，于是同一事件每次重取、每次失败。现在 `live-state.json` 记最近 500 个 `handledEvents`，处理过的事件直接 `already-handled` 跳过并 ack。
- **`tkt_1` 命中 `tkt_10` 的工作树**：`git worktree list` 的解析用 `block.startsWith('worktree ' + path)` 做前缀匹配，短 id 读到长 id 的块 → 分支不符 → `worktree-conflict`。现在按整行精确比较。
- **没有 base commit 时推送守卫不扫已提交文件**：`changedPaths` 的 `git diff base...HEAD` 失败被静默吞掉，publish 的 `baseSha` 是 `.catch(() => undefined)`，于是只剩 `git status`，已提交的 `.env` 之类不会被发现。现在 base 缺失或 diff 失败时用 `git log --name-only HEAD --not --remotes` 兜底，兜底也失败则报错；publish 把取不到路径的原因写进日志而不是静默空列表。
- **旧 MR 状态盖住新 MR**：发布收尾用 `['merged','deployed'].includes(ticket.status)` 无条件保留 merged，而验证已被清空、链上的是新开的 MR。现在只在本次真的合并（`mergedNow`）时写 merged。
- **远端分支被删后跳过 push**：publish 的 `reusePushed` 只信本地 `links.push.sha`，不读远端。现在复用前用 `remoteBranchSha()` 校验（`checked` 且 sha 相等才复用），远端没了就重推。
- **MR 建失败被读成已交付**：api 模式下非 `mr_lookup_failed` 的 MR 创建失败只写 `run.errorCode`，随后 `run.status = ticket.status`（`pushed`），证据按成功写。现在记 `run.mergeRequestUnconfirmed`、工单链 `mergeRequest.pending/unverified/error`，`run.status` 保持 `failed`。
- **`/gate` 同步等到分钟级操作跑完**：`release` 会跑闸门、commit、push、开 MR（可能含数分钟的 `postGatesCommand`），却和 `/publish`（202）不同步。现在默认 202 + 后台执行，`wait: true` 保留同步形式；`未知工单→404`、`不处于 gate-blocked→409` 这两类拒绝提到启动之前，不会出现「202 之后才发现工单不在等闸门」。

### 验证

- `node --test lib/live/*.test.js` → 696 pass / 0 fail（新增 7 条：自动化合并在文档上而非快照、复用的远端分支被删后重推、UUID 事件不重复处理且 `handledEvents` 有界、`tkt_1`/`tkt_10` 工作树互不干扰、base 缺失仍能扫到已提交的 `Secrets/key.pem`、evidence 超过 30 天后正文清掉、`/gate` 默认 202）。
- `node scripts/render-check.mjs` → 309 checks / ok:true / 0 fail / 0 skip。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs` 全绿。
- 负向验证：改动前 `setTicketAutomation` 的旧实现会让新断言读到 `intervalMinutes: 15`（排队中的 tick 写的 45 被覆盖）；移除 `handledEvents` 后第二次 poll 会重新记一条信号而不是 `already-handled`。

## [1.1.5] — 2026-11-23

整体审查后的第四批修复（P2，客户端优先）：一次没回音的请求会把轮询队列永久卡住、等回答的工单在两个分组里各算一半、Bot 改名会留下一份旧副本、没选线程时每 30 秒请求一次 `thread/undefined`。

### 根因与修改

- **一次挂起的请求冻结整个面板**：`apiCall` 用裸 `fetch`，没有超时也没有 `AbortSignal`；`usePoll` 的队列是 `queue = queue.then(once)`，`once` 只有 `fetch` 返回才会结束——连接半开时队列永远 pending，错误不出现、下一次轮询也不排期，页面停在上一份文档或骨架屏。现在读请求 20 秒、写请求 2 分钟超时（`AbortController`），超时抛 `ApiError`（`status 0`、`details.timeout`）并提示「服务可能仍在处理」；跑闸门/等待式运行这两条本来就以分钟计的路线传 `timeoutMs: 0`，不会被切断在半次提交中间。
- **等回答的工单在芯片与行之间错位**：Host 的 `STAGE_OF_STATUS`（`lib/live/engine.js`）缺 `awaiting-answer`，落回 `working`；而面板的 `TICKET_VIEW` 把它归在 `waiting`。于是「等你处理」芯片少一张、`working` 多一张，点进去的行数与芯片不符。Host 补 `'awaiting-answer': 'waiting'`，两侧同一口径。
- **Bot 改名保存出两个 Bot**：`save` 用 `bots.filter(item => item.id !== bot.id)` 排除被编辑的那一行，而 `bot.id` 取自**表单**；把 id 从 `mine` 改成 `mine2` 时旧 id 不在排除列表里，旧 Bot 原样留在 store。现在同时排除 `editor.id`（打开编辑器时的 id）。
- **没选线程也在轮询 `thread/undefined`**：`ThreadDetail` 调 `useLiveResource('engine/thread/:key', { key: threadKey }, 30000)` 时没传 `{ enabled }`，`threadKey` 为空时路由把 `undefined` 编进路径，每 30 秒一个 404。现在传 `{ enabled: Boolean(threadKey) }`。

### 验证

- `node --test lib/live/*.test.js` → 689 pass / 0 fail（新增一条：`awaiting-answer` 的工单进 `waiting` 分组、不进 `working`，且芯片计数与行数一致）。
- `node scripts/render-check.mjs` → 309 checks / ok:true / 0 fail / 0 skip（新增三条：改名只留一份、请求超时而不是永久挂起、无线程时不发请求）。
- 负向验证：把 `timeoutMs` 改回 0 → 超时检查报 `still pending` 且整轮 exit 1；把排除条件改回只看 `bot.id` → 改名检查报 `["generalist","surgical","reviewer","mine","mine2"]`。
- `npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs` 全绿。

## [1.1.4] — 2026-11-23

整体审查后的第三批修复：全部落在界面契约上——弹窗不说明它要做什么、整行点击靠一层伪元素、页标题与「需求」各说一遍、路由切换把键盘用户丢在 `<body>`、品牌色铺到开关和设置左栏、以及十一条细则（字号、禁用态、术语表、时长与失败原因的读法）。

### 根因与修改

- **弹窗只报名字，不报后果**：`Modal` 的 `description` 渲染成裸 `<p>`，`role="dialog"` 只有 `aria-label`，读屏只会念标题；打开时也不锁页面滚动，背后的长页面还能滚。现在每个弹窗用自己的 `aria-describedby` 指向那句后果说明（`sa-modal-desc-N`），打开时 `body.overflow = hidden` 并在关闭/卸载时还原。
- **整行可点靠 `::after` 覆盖层**：行内主按钮只有标题那么大，点击区由 `.sa-open::after { inset: 0 }` 撑出来，还带 `outline: none` + 只画伪元素的焦点环。DESIGN.md §Rows 明文禁止这条路，而且覆盖层会吃掉 chips 的命中/hover 语义。现在主列就是真按钮（`button.sa-row-open > .sa-row-main`，`align-items: stretch`），删掉 `::after` 与 `outline: none`，焦点环回到按钮本身；执行台的栅格列也改由按钮持有（`.sa-exec-queue .sa-row .sa-row-open { grid-column: 2 }`）。
- **页标题与「需求」重复**：工单标题本身常常就是需求原文，下面「需求」段把同一段再印一遍，页头又折成两三行。现在 `requestIsTitle()` 判断「正文与标题同一段」时不再渲染需求段、对应的跳转项也一并收起，页头两行截断、全文进 `title`。审查里「页标题应为 h1」这条经实测不成立——外壳已经有页面唯一的 `h1.sa-title`「超级智能体」（`client/src/shell.js`），页头再出一个 h1 就是两个；页头保持 `h2`，DESIGN.md 已写清这条层级。
- **路由切换丢焦点**：`PanelShell` 只重置滚动，点进去的那一行按钮随即卸载，焦点落到 `<body>`。现在路由变化（且焦点本来不在别处）时把焦点交给新页面的 `.sa-page-head-title`（必要时补 `tabindex="-1"`），与搜索面板原有的做法一致。
- **品牌色超量**：开关选中态挂 `brand-primary` 底色、设置左栏当前项挂品牌色左边框，同屏出现三处品牌色。现在两处改用 `--dsw-alias-interactive-bg-active` 中性底色（带回退），品牌色只留当前页签下划线；危险动作统一 `variant="danger"`（忽略/停止确认、打回验收，原来是 `primary` 与 `outline`）。
- **十一条细则**：warning 内联色改 `--sa-warn-text`；输入框 hover 改底色而非换边框色；禁用态 opacity 统一 0.4（原来 0.55/0.72/0.4 三种）；裸 `gap: 2px|1px` 改 `var(--sa-sp-2)`；开关圆点 50% → `var(--sa-r-pill)`；diff 正文 11px → 12px；补 `.sa-signal-toggle/.sa-signal-text/.sa-signal-full` 样式（原来 role=button 的信号预览没有 cursor、没有焦点环、命中区只有 12px 高）；术语表补「验收/在飞/干跑/接单/发布」五条。
- **概览的可读性**：平均耗时原来直接印 `659.9s`，现在 `durationText()` 输出 `11m`／`1m 30s`（整分省秒）；旧数据里已带标签的失败原因会二次包裹成「其他原因：其他原因：…」，`collapseRepeats()` 先收起连续重复段，`failureReasonTextOf()` 再检测已有前缀，不再叠加。

### 验证

- `node scripts/render-check.mjs` → 305 checks / ok:true / 0 fail / 0 skip（新增 15 条：行按钮持有主列、路由切换焦点、单 h1、弹窗 `aria-describedby` 与滚动锁、滚动释放、品牌色只在下划线、禁用态单一 opacity、信号触发器 cursor/焦点环、diff 字号、`requestIsTitle`、`durationText`、失败原因去重、危险确认语气）。
- `node --test lib/live/*.test.js` → 688 pass / 0 fail；`npm run types`、`npm run check:js`、`node scripts/check-keys.mjs`、`node scripts/build-client.mjs --check` 全绿。
- `DESIGN.md` 同步两处：Page 标题是每页唯一的 `h1` 且两行截断；One Accent Rule 明确开关与设置左栏的选中态用中性底色，品牌色留给页签下划线。

## [1.1.3] — 2026-11-23

整体审查后的第二批修复：全部是「记录的数据与实际发生的事对不上」——轮询丢了消息还说同步完成、轮询链每保存一次设置就翻一倍、关掉的收件箱项再也不回来、停机时把没落盘的游标 ack 掉、后台批次失败无人接收、UAT 结果落在别的仓库卡上、详情页草稿跟着路由跑到别的工单。

### 根因与修改

- **停机后的消息缺口被静默吞掉**：`pollSync` 用 `syncMessages({ limit: 100 })`（`--start-message-seq/--end-message-seq` 恒为 0），只拿最新一窗，然后把 cursor 无条件推到批内 maxSeq。停机超过 100 条时中间的缺口永远不会被读，且 `lastStatus` 说同步成功。现在 `syncMessages({ fromSeq, toSeq })` 传真实窗口，新增 `fillSyncGap()`：满批且 `oldest-1 >= baseline+1` 时按区间补拉一次；补拉后仍有缺口就把 `{ chatId, from, to }` 记录进 `result.gaps` / `lastStatus.gaps` 并写日志，剩余缺口不再当作已同步。
- **轮询链倍增**：`schedule()` / `scheduleVerify()` / `scheduleAutomation()` 的 `setTimeout` 回调跑完会无条件重新排期，`refresh()` 之后新旧两条链同时自续，每保存一次设置 poll 频率就翻一倍。三条链各用一个世代令牌（`pollGeneration` / `verifyGeneration` / `automationGeneration`），旧链在回调里发现世代已变就直接退出。
- **收件箱项解决后永不回来**：`applyDesiredInbox` 的 upsert 保留 `resolvedAt`，而 dedupeKey 是稳定的（`engine:last`、`source:<id>`、`accept:<ticketId>`），所以同一个错误手动 resolve 一次，90 天内同样的错误再现也不会进收件箱，也没有任何「重新打开」入口。现在条件复发时重开：自动解决（`resolvedAction === 'auto'`）后再现同文即重开；手动解决后需要内容或时间真的变了（`changedSinceResolve()` 比对 kind/title/summary 与 `refs.at|updatedAt|lastAt`）才重开，重开时清掉 `resolvedAt`/`resolvedAction`/`readAt` 并计入 `result.reopened`。
- **停机时 ack 掉没落盘的事件**：`pollEvents` 先 `state.save()` 再 ack，但 `stop()` 先 `state.close()`，此后 `save()` 是 no-op，ack 却照发——游标都没落盘就把服务端事件标成已读。现在 `state.closed` 时不 ack，并记一条 `ack skipped: engine stopped before N recorded events were persisted`。
- **自动批次失败无人接收**：`pollSync` 末尾 `this.dispatchQueue = this.autoExecute(ids)` 没有 catch，`autoExecute` 抛错就是 unhandled rejection（Node 下会打挂 host 进程）。现在 `.catch()` 记日志 `auto-run batch failed: …`。
- **UAT 结果落在别的仓库卡上**：客户端 `checkUat()` 不带参数、结果只存一份，`uatResult(source)` 又对每张执行仓库卡渲染同一份结果；host 侧找不到指定仓库时还会回落 `web-uat` 或 `repos[0]`。现在 `checkUat(repoId)` 带仓库、结果按 `repoId` 分组渲染，host 对「指定了不存在的仓库」答 404，只有完全没指定时才按 `web-uat` 挑默认。
- **详情页草稿跟着路由跑到别的工单**：`TicketDetail` 的两个挂载点（执行页、概览深链）没有 `key`，换 id 时 React 复用同一个组件实例，上一张工单的追加需求、回答框与 待确认状态 都会留在新工单上；`usePoll` 换 deps 也不清旧 `data`。现在两个挂载点都写 `key={route.id}`，`usePoll` 在 deps 变化时先清空上一份数据。

### 验证

- `node --test lib/live/*.test.js`：688 pass / 0 fail（新增 7 条：满批补拉用真实 `fromSeq/toSeq` 且补拉消息被处理；超大缺口记进 `result.gaps` 与 `lastStatus.gaps` 且 cursor 仍前进；补拉抛错时记 `range read failed` 且最新窗仍处理；`schedule()` 跑三次 tick 只有一条链；`state.closed` 后 `pollEvents` 不 ack；`autoExecute` 抛错被 `.catch` 记日志；收件箱自动/手动解决后的重开口径）。
- `node scripts/render-check.mjs`：290 checks / 0 fail（新增 4 条：UAT 请求带上被点的仓库且只有那张卡显示结果；换工单后详情草稿不残留）。
- `node scripts/check-keys.mjs`：1059 literal keys / 530 shared / 1505 page-local；`node scripts/build-client.mjs`：24 modules / 529880 bytes（`--check` up to date）；`npm run types`、`npm run check:js`、`node --check index.js` 全绿。

---

## [1.1.2] — 2026-11-23

整体审查后的第一批修复，全部是「开关与守卫被绕过」这一类：执行器关着仍能交付、token 被静默删除、推送守卫漏大小写、并发保存丢配置、Bot 文件可覆盖 live.json、群消息可重复发送。

### 根因与修改

- **群消息重试没有幂等键（P0）**：`lib/live/octo.js` 的 `run(argv)` 对任意命令在 stderr 命中 `TRANSIENT_RE` 时都重试一次，`sendText` 正是走它。消息已入库但返回时超时/断开就会发两遍。现在 `run(argv, { retry = true })`，`sendText` 传 `{ retry: false }`：只有 poll/ack/sync/list 这类幂等调用还会重试。
- **执行器总开关可被绕过**：`/gate`、`/resume`、`/answer` 三个路由没有 `requireExecutor`（`/run`、`/publish` 有），且 `resumeTicketInner` 只算 `allowPush`、不查 `executor.enabled`。关闭执行器后点「放行」照样 commit + push + 开 MR。现在三个路由补 `requireExecutor(engine, { dryRun: false })`，`resumeTicketInner`/`answerTicketInner` 各自加 `if (!dryRun && !config.executor.enabled) return { invalid }`；`action==='stop'` 仍然允许（它只结束一次运行），`answerTicketInner` 的检查在写入 Q/A 之前，被拒的回答不会把工单推到 `ready`。路由层用新助手 `ticketDryRun()` 取该工单上一次运行的 `dryRun`，与 `/run` 的口径一致——干跑不写任何东西，执行器关着也能回答/放行。
- **仓库 token 被静默删除**：`POST engine/repo/:id/token` 把 `body?.token` 直接交给 `saveRepoToken`，非字符串被 `saveTokenFile` 当成 `''`（= 断开连接）→ 已存 token 被 `rm`。现在与 octo/eval token 路由一致，非字符串答 400。
- **推送守卫漏大小写**：`lib/live/repo.js` 的 `FORBIDDEN_PATH_PATTERNS` 没有 `i` 标志（同文件 `SECRET_PATH_PATTERNS` 有）。在大小写不敏感的 APFS/Windows 上 worker 建 `.ENV` 就是 `.env`，守卫放行。九个模式统一补 `i`。
- **live.json 三个写入口绕过串行队列**：只有 `updateLiveConfig` 在 `configWrites` 队列里；`addRepoDefinition` / `updateRepoDefinition` / `restoreLiveConfig` 是裸 read-modify-write，且临时名 `${pid}.${Date.now()}.tmp` 同毫秒不唯一。现在四个入口共用同一队列，临时名统一走 `tmpPath()`（带 6 字节随机后缀）。
- **Bot 文件可覆盖 live.json**：`executor.botsFile` 只校验「裸文件名」，写成 `live.json` 就能让每次保存 Bot 把配置与工单整份覆盖。`botsFileOf` 现在拒绝 stateDir 保留名（`live.json` / `live-state.json` / `operations.json` / `shadow-samples.json` / `backend-verify.json` / 各 `*.token` / `live-history` `runs` `evidence` `worktrees` 目录），它自己的默认名 `worker-bots.json` 仍是唯一合法占用者。

### 验证

- `node --test lib/live/*.test.js`：681 pass / 0 fail（新增 6 条：`sendText` 遇到 socket hang up 只调用一次；仓库加库与保存设置并发时两者都落盘、无 tmp 残留、两份快照完整；`.ENV`/`Secrets/`/`Node_Modules/` 被判为禁止路径；`botsFile` 拒绝 live.json/LIVE.JSON/live-state.json/gitlab.token/octo.token 且接受 worker-bots.json；执行器关闭时 release+retry 均被拒、stop 仍生效、无任何 git 命令；执行器关闭时 answerTicket 不写 Q/A 且工单留在 `awaiting-answer`，打开后同一回答可通过；路由级：非字符串 token 答 400 且已存 token 仍在，`/gate` `/resume` `/answer` 在关闭执行器时答 403）。
- `node scripts/render-check.mjs`：286 checks / 0 fail。
- `node scripts/check-keys.mjs`：1059 literal keys / 530 shared / 1505 page-local；`node scripts/build-client.mjs --check`：24 modules / 529684 bytes up to date（本次无客户端改动）；`npm run types`、`npm run check:js`、`node --check index.js`、`npm ci` 全绿。

---

## [1.1.1] — 2026-11-23

交付之后才失败（MR 流水线红了、dev 部署 job 红了、MR 被关掉）的工单，在面板里点不动：行内只有「查看原因」，菜单里的「发布 MR」被状态白名单挡住，而「重试」即便跑起来也会复用那张**已经合并**的 MR，于是永远盯着旧 merge commit 的流水线。

### 根因与修改

- **合并后的 MR 被当成「这次交付」反复复用**：`lib/live/executor.js` 的 `openOrAdoptMergeRequest` 先找 `state==='merged'`、再找 `opened`，且不比对 head。现在 `opened` 优先，`merged` 只有在仍指向当前 HEAD 时才采纳（新增 `headSha` 入参，取 `item.sha ?? item.diffRefs?.headSha`），否则新建 MR；两条调用（`executeTicket` 与 `publishTicketInner`）都传 `headSha`。
- **推送证据被复用时直接沿用旧 MR**：`executeTicket` 的 `reusePush` 分支原本无条件 `mr = ticket.links.mergeRequest` 并打印 "already opened"。现在 stored MR 只有在 `opened`、或 `merged` 且仍指向 HEAD、或没有 `state`（旧工单）时才复用，否则落到 API 分支重新开 MR。
- **新 MR 背着旧交付的账**：`linkMergeRequest` 在 MR `iid` 变化时丢弃 `deployment` / `autoMerge` / `pipeline` / `verification`。否则旧的 `autoMerge.state='merged'` 会让自动合并守卫直接拒绝新 MR，旧的 `verification.merged=true` 会让新交付在落地前就被判成已合并。
- **失败态不可发布**：`PUBLISHABLE_STATUSES` 从 `lib/live/executor.js` 导出（`ready`/`failed`/`pushed`/`ci-failed`/`deploy-failed`/`closed`），`index.js` 与 `client/src/live-ui.js` 的 `publishableStatusOf` 共用同一份口径；409 文案改为「只有待执行、交付失败或已推送的工单可以发布 MR」。
- **行内主按钮给出口**：`ci-failed` / `deploy-failed` 的 primary 从 `diagnose` 改为 `redeliver`（文案「重新交付」/「Re-deliver」），`primaryActionOf` 映射到已有的 `publish` 通道（重跑闸门 → 提交 → 推送 → 开新 MR），执行器未启用或不允许推送时该按钮禁用。

### 验证

- `node --test lib/live/*.test.js`：675 pass / 0 fail（新增 3 条：合并 MR 的 head 落后于 HEAD 时新开 MR 且清掉旧交付账；head 未变时仍采纳已合并 MR；`deploy-failed` 可发布、`merged` 不可发布）。
- `node scripts/render-check.mjs`：286 checks / 0 fail（R2-10 扩到失败态，新增「失败交付在行内可重新交付」）。
- `node scripts/check-keys.mjs`：1059 literal keys / 530 shared / 1505 page-local；`node scripts/build-client.mjs`：24 modules / 529684 bytes，`--check` up to date；`npm run types`、`npm run check:js`、`node --check index.js` 全绿。
- 真实工单 `tkt_67d46ecb809d4ce4` 复现的链路：MR !70 在修复提交前自动合并，dev 流水线 533268 的 `agent-package` 因 skill/CLI 版本不一致失败，之后的 job 全 skipped；修复提交合入（MR !71，merge commit `31b3ba6`）后 dev 流水线 533279 的 `agent-package` 转绿。

---

## [1.1.0] — 2026-11-23

Bot 从「设置里的一个分组」升级成顶层页签，位置在「执行」左边：先把「谁来做」定下来，再看队列。设置页回到只配置工作流本身，Bot 的定义、查看、编辑、核验全部集中在 Bot 页签。

### 根因与修改

- **Bot 藏在设置里**：`SETTINGS_GROUPS` 的 `bots` 分组默认不在首屏，第一次用的人要先找设置、再找分组才看得到"这类活由谁做"。现在 `client/src/router.js` 的 `TABS` 在 `eval` 与 `execution` 之间插入 `bots`（Alt+5 直达），`shell.js` 的 `pageView` 直接渲染 `BotsCard`；设置页的 `bots` 分组与 `settingsGroup.bots` 标签随之删除，rail 上不再有它。
- **入口都跟着走**：工单详情「存为 Bot」原本 `navigate({page:'settings',group:'bots'})`，现在送到 `{page:'bots'}`；`BotsCard` 挂载时消费 `superagent-panel/bot-draft` 的行为不变，草稿仍然落到新页签的编辑器里。
- **标题不再重复**：`st.botsTitle` 从「Bot」改为「Bot 列表」，避免页签与区块标题都叫 Bot 时读起来像重复渲染。
- **文档与验收同步**：`README.md`、`docs/pages.md`（新增 Bot 章节）、`docs/ui-workflow.md` 由六个页签改为七个；`scripts/verify-panel.mjs` 的 tablist 计数 6→7；`render-check` 新增两条断言——Bot 页签紧邻「执行」左侧、Bot 页签带着文件/内置/后端核验/新建 Bot 四块且设置页不再有 Bot 分组。

### 验证

- `node --test lib/live/*.test.js`：672 pass / 0 fail。
- `node scripts/render-check.mjs`：285 checks / 0 fail。
- `node scripts/check-keys.mjs`：1059 literal keys / 530 shared / 1504 page-local；`node scripts/build-client.mjs`：24 modules / 529511 bytes，`--check` up to date；`npm run types`、`npm run check:js`、`node --check index.js` 全绿。
- 独立端口 + 独立状态目录（`DSH_SUPERAGENT_STATE_DIR=/tmp/...`）起实例，页面 200 且插件加载，无 Host 报错；测完已关闭。

---

## [1.0.24] — 2026-11-23

Bot 编辑器的首次使用体验：20 个字段一次平铺，第一次用根本不知道该填什么，而且没有样式——`sa-bot-modal` / `sa-field-grid` 这些类名在 `style.js` 里根本没有规则，于是每个输入框占满整行。数据模型与契约不变，只动 `client/src/settings.js` 与 `client/src/style.js`。

### 根因与修改

- **20 个字段平铺**：身份、后端、模型、能力、工具、阶段、预算全在同一屏。编辑器现在只留第一屏四件事——名称、标识、一句话说明、后端——加上角色提示词（改成 4 行 textarea，带占位说明「留空跟随工作流默认」）；其余字段原样搬进 `DisclosureRow`「高级设置」，折叠时在标题旁显示「已设置 N 项」，值不丢、可回改，`stageSpecs` 等未渲染字段照旧静默往返。
- **补了缺失的样式**：`style.js` 新增 `.sa-field-grid`（两列、容器 <620px 退单列）、`.sa-field-wide`（整行）、`.sa-bot-modal`（720px）、`.sa-settings-stack`；Bot 列表行改用已有的 `sa-row` 类，不再是一堆挤在一起的裸文本。
- **`description` 一直没有输入框**：`emptyBotForm`/`botToForm`/`formToBot` 都带着它，列表也读它，但编辑器不渲染——现在它是第一屏的「一句话说明」。

### 验证

- `node --test lib/live/*.test.js`：672 pass / 0 fail。
- `node scripts/render-check.mjs`：282 checks / 0 fail（新增一条——打开编辑器时阶段行位于折叠区、未展开则不渲染；预览区改在展开后断言）。
- `node scripts/check-keys.mjs`：1059 literal keys / 530 shared / 1504 page-local；`node scripts/build-client.mjs`：24 modules / 529570 bytes，`--check` up to date；`npm run types`、`npm run check:js`、`node --check index.js` 全绿。

---

## [1.0.23] — 2026-11-23

P6 的阶段编排 UI 补齐：§10.2 的数据通路在 1.0.21 就通了，但面板上既选不了阶段 Bot，也看不到某个阶段跑了谁。这一版只动 UI 与 `botsView` 的返回体，契约不变。

### 根因与修改

- **阶段 Bot 只能改文件**：编辑器只有阶段勾选，`{stage, bot, budget}` 只能手写 JSON。`client/src/settings.js` 现在为每个已勾选阶段（`gates` 除外，由执行器跑）渲染一行——Bot 下拉（选项来自 `bots[].id`，留空 = 整单 Bot）与 `budget.timeoutMs` 输入；空值不落键，避免保存时留下 schema 会拒的空对象。`botToForm`/`formToBot` 的 `stageSpecs` 已能往返，这一版只是把它接到控件上。
- **`preset` 要手填 id**（§18 D2）：`GET engine/bots` 的返回体新增 `presets`（`hostPresetIds(ctx)`，宿主不答时不下发），编辑器据此把 `preset` 渲染成只读下拉；宿主不答时仍是自由文本，不凭空造列表。
- **详情页看不出阶段换了后端**：`stages[].bot`（1.0.22 记录）没有渲染。分阶段流程的阶段行现在显示 `阶段 · 后端 (Bot) · 状态`，混用后端的工单不用打开 Bot 文件就能读出来。

### 验证

- `node --test lib/live/*.test.js`：672 pass / 0 fail。
- `node scripts/render-check.mjs`：281 checks / 0 fail（新增两条——编辑器里某阶段的 Bot 下拉与预算是该 Bot 的值、阶段行只对 review 显示 `claude (rechecker)`）。
- `node scripts/check-keys.mjs`：1054 literal keys / 530 shared / 1499 page-local；`node scripts/build-client.mjs`：24 modules / 527565 bytes，`--check` up to date；`npm run types`、`npm run check:js`、`node --check index.js` 全绿。

---

## [1.0.22] — 2026-11-23

`docs/worker-bots-spec.md` §18 的八个未决问题定下六条（D1–D5、D8），两条属于 CLI 后端的问题（D6 claude 联网、D7 codex 思考深度）推迟到 P4/P5。D6/D7 之外真正要改代码的只有三处，其余是把已经长成的行为写进契约。

### 根因与修改

- **`requires` 为空的 Bot 会被整单分派选中（D8）**：`reviewer` 的 `requires: []` 让 `(bot.requires ?? []).every(...)` 恒真，于是只读复核器能当整单执行者被自动选中。`lib/live/dispatch.js` 现在把自动层（决策模型候选、`executor.bot` 默认层）限制在 `requires` 非空的 Bot 上；显式层（`ticket.botOverride`、`backendOverride`、`repo.bot`、规则点名）仍可选中——那是人的显式决定，`covers()` 照旧校验能力。不加 `stageOnly` 字段。
- **`run.bot.capability` 与阶段 Bot 的关系（D1）**：不记能力并集。整单快照保持原样，阶段级信息记在阶段条目上——`stages[].backend`（1.0.21 已有）之外补 `stages[].bot`（`lib/live/workflow-worker.js`），面板据此能说清"这一单用了哪两个 Bot"。
- **决策模型的工单节选要自报（D3）**：`dispatchRequestOf` 一直把 `title` 截 400、`body` 截 4000，但模型看不出这是节选；现在被截断时请求里带 `truncated: true`。
- **ad-hoc 的角色不再依赖 plan（D4）**：`role` 用工单标题（≤500 字符），标题为空时回退「按 `<workType>` 处理这件事」，避免 simple 模式下空提示词。
- **契约文档**：§18 从"未决问题"改为"已定问题与推迟项"（D1–D8，逐条给依据与落地版本）；§3.4 写明 claude 的 `web` 是被我们自己的 `--disallowedTools` 关掉的、`codex` 的 effort 在 P5 前不生效；§4.5/§7.1 写死"`requires` 为空不进自动候选"；§7.2 加 `truncated`；§8.2 改角色的真实来源；§10.2 写记录口径。

### 验证

- `node --test lib/live/*.test.js` → **672 pass / 0 fail**。新增 `dispatch.test.js` 四条：`reviewer` 当 `executor.bot` 时不会被整单选中（显式仍可用）、决策模型候选里看不到它且选它只降级不采纳、超长 body 带 `truncated: true` 且短 body 不带、空标题的 ad-hoc Bot 拿到备用角色。`executor.test.js` 两处补断言：阶段条目记 `bot`（`review` 是 `rechecker`、`implement` 没有），以及整单 Bot 必须声明 `requires`（否则按 D8 不会被自动选中）。
- `node scripts/build-client.mjs --check` 24 modules / 526072 bytes（无客户端改动，产物未变）；`check-keys` 1051/530/1496；`npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/render-check.mjs`（exit 0）全绿。

### 升级提示

- 自查：如果你有**只当执行器用**的自建 Bot 却没写 `requires`，它现在不会被自动选中（规则点名或手动指定仍可以）。给它补上真实需要的 `edit`/`exec`/`web` 即可。
- `reviewer` 依旧只能当阶段 Bot；`executor.bot: "reviewer"` 不再让整单跑在它上面。
- 代码没有改名，文件仍是 `worker-bots.json` `version: 2`。

## [1.0.21] — 2026-11-22

`docs/worker-bots-spec.md` §10.2（阶段级 Bot 与阶段级预算）落地。此前 `stages` 只能写阶段名，一个 Bot 的所有阶段共用同一后端/模型/预算；现在某个阶段可以指定**另一个 Bot** 和它自己的预算，没指定的阶段继续用整单 Bot。

### 根因与修改

- **数据通路**：`lib/live/worker-bot.js` 的 `stages` 条目接受 `"implement"` 或 `{ "stage": "review", "bot": "rechecker", "budget": { "timeoutMs": 600000 } }`；新增 `stageNamesOf()`（取名字，给工作流用）与 `stageBotOf()`，`normalizeStages()` 保留对象形态并按 stage 名去重，`sortBot` 让阶段对象的键序稳定（文件与 digest 可复现）。
- **保存期校验**：阶段名仍必须是有序子序列且含 implement+gates；阶段对象额外要求 `stage` 合法、`bot` 匹配 Bot id 且（`environment.botIds` 给出时）确实存在、不得引用自身、`budget` 各键在 §6 区间 —— 分别报 `BOT_STAGES_INVALID` / `BOT_BUDGET_INVALID`。`engine.saveBots` 现在把「内置 Bot + 本次提交的 Bot」的 id 列表一并交给校验，所以引用不存在的 Bot 存不进去。
- **派单期**：`executor` 在整单 Bot 解析后构造 `stageBots`，用与候选完全相同的判定（`dispatch.environmentOf`：同一个探针、同一个版本/启用规则）校验阶段 Bot；不通过就按该 Bot 的错误码拒单（例如阶段 Bot 后端未核验 → `BOT_BACKEND_UNVERIFIED`，消息带「阶段 review 的 Bot xxx」）。阶段 Bot 的后端可以与整单不同，只看它自己是否核验通过。
- **生效**：被指定 Bot 的那个阶段用阶段 Bot 的 backend/model/preset/effort/deny/allowMcp；预算按「阶段 budget > 阶段 Bot 预算 > 整单 Bot 预算 > executor 默认」，`timeoutMs`/`idleTimeoutMs` 都按这条链取。`stages` 传给工作流时用 `stageNamesOf()`，避免对象形态破坏阶段判定。
- **面板**：设置页的 Bot 表单仍只编辑阶段勾选（阶段 Bot 选择器属 P6），但 `botToForm`/`formToBot` 会把 `{bot, budget}` 原样带过保存，不会静默丢字段。

### 验证

- `node --test lib/live/*.test.js` → **668 pass / 0 fail**。新增：`executor.test.js` 两条（阶段 Bot 用 claude + sonnet-4 + 600000ms 跑 review、其余阶段仍走 dsh；阶段 Bot 未核验时拒单且不执行命令）；`worker-bot.test.js` 两条（阶段对象归一化与键序；未知 Bot/自引用/越界预算/非法阶段名的错误码）。修复过程中发现：阶段 Bot 的 claude 模型是 `{provider, model}` 对象，CLI 只吃 model id，已在 workflow-worker 的 cli 分支取 `model?.model`。
- `node scripts/build-client.mjs` 24 modules / 526072 bytes 且 `--check` up to date；`check-keys` 1051/530/1496；`npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/render-check.mjs`（exit 0）全绿。

### 升级提示

- 现有 Bot 文件无需迁移：`stages: ["implement","gates"]` 仍有效。阶段级写法是新增能力，不写就等于整单 Bot。
- 阶段 Bot 必须自己核验通过（dsh 走探针，claude/codex 需要 `<stateDir>/backend-verify.json` 里的 smoke 证据），否则整个 run 拒单，不会悄悄退回整单 Bot。

## [1.0.20] — 2026-11-22

用 dev 实例（`scripts/dev.mjs`，链接工作树、`DSH_SUPERAGENT_STATE_DIR=/tmp/sa-dev-state`）在真实宿主 0.2.2-rc.5 上实测 Bot 页，桌面 profile 未动。三个问题：两个把设置页打成 500，一个是探针在真机上永远测不出能力。

### 根因与修改

- **Cordis 未声明属性会抛异常**：`hostVersionOf` 里 `ctx?.hostVersion`、`probeBackend` 里 `ctx?.stateDir` 在宿主上是 `cannot get property "hostVersion" without inject`（不是 undefined），`GET engine/bots` 直接 500（1.0.18 引入的回归）。改为：`hostVersionOf` 用 try/catch 包住注入读取；`probeBackend` 新增显式 `stateDir` 参数（JSDoc 写明不从宿主 Context 上读），`engine.backendStateOf` 传 `this.stateDir`，`executor.probesForRun` 透传 `engine.stateDir`。回归测试用 Proxy 模拟严格 Context（未知键抛错，仍能取到 `DSH_VERSION`）。
- **真机探针三能力全 false**：宿主全局 `tools` 注册表只列 MCP/team/workspace 等 49 个工具，`write`/`edit`/`bash`/`web_*` 是随 agent 注册的；`agentPresets.resolve()` 只返回 `{ id }`，没有 `tools`。于是 `dsh` 探针「成功」却报 `{edit:false,exec:false,web:false}`，候选集恒空 —— 等于整个功能不可用。改为：新增 `compositionModulesOf(ctx, presetId)` 读 `agentPresets.inspectCompositions()`（或 `compositionInventory()`）里该 preset 的 `modules`，新增 `MODULE_CAPABILITIES`（`dsh-tool-fs`/`dsh-tool-apply-patch`/`dsh-tool-notebook` → edit；`dsh-tool-bash`/`dsh-tool-bash-persistent`/`dsh-terminal-bash` → exec；`dsh-tool-web` → web），能力 = 工具名命中 **或** preset 挂载了对应插件；`dsh-tool-fs-search` 不算 edit（只读搜索）。证据行新增 `evidence.modules`（前 40 个模块名），两边都读不到才退回 `fallback`（全未核验）。

### 验证

- dev 实例（端口 63419）：`GET engine/bots` → 200，`backends.dsh` = `state:"verified"`, `source:"probe"`, `{edit:true,exec:true,web:true}`；`claude`/`codex` = `unverified`（fallback），保存 claude Bot 仍被拒（`BOT_BACKEND_UNVERIFIED`）；保存 dsh Bot 成功，写入 `/tmp/sa-dev-state/worker-bots.json`（`version: 2`）。桌面 profile 未安装、未启动。
- `node --test lib/live/*.test.js` → **664 pass / 0 fail**（新增两条：composition 作为证据、search-only fs 不给 edit）；`node scripts/build-client.mjs` 24 modules / 525702 bytes 且 `--check` up to date；`check-keys` 1051/530/1496；`npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/render-check.mjs`（exit 0）全绿。
- 文档：`docs/worker-bots-spec.md` §3.3 补「DSH 探针的证据来源」（工具名 ∪ preset 组成），§3.7 版本来源处补「`stateDir` 是参数，不从 Context 读」。

### 升级提示

- 1.0.18/1.0.19 若在真实宿主上打开 Bot 页报 `cannot get property … without inject`，升级到本版即可；无需改配置。
- 能力表仍只用于拒绝：composition 是宿主运行时声明，`routing.js` 的静态表不授权任何能力。

## [1.0.19] — 2026-11-22

把「档位（profile）」整套命名换成 **Bot（bot）**（`docs/worker-bots-spec.md` 附录 C）：用户定义、面向一类固定重复工作的执行者。行为不变，但对操作员可见的每一条路径都换了名字，旧配置与旧 Bot 文件需要按附录 C 迁移。

### 改名：代码、配置、文件、UI

- `lib/live/worker-profile.js` → `lib/live/worker-bot.js`（测试同 ren 名）；`readProfiles`/`writeProfiles`/`saveProfiles`/`normalizeProfiles`/`normalizeProfile`/`validateProfile`/`resolveProfile`/`synthesizeProfile`/`parseProfilesDocument` → `readBots`/`writeBots`/`saveBots`/`normalizeBots`/`normalizeBot`/`validateBot`/`resolveBot`/`synthesizeBot`/`parseBotsDocument`；`BUILTIN_PROFILES`/`BUILTIN_PROFILE_IDS`/`DEFAULT_PROFILE_ID` → `BUILTIN_BOTS`/`BUILTIN_BOT_IDS`/`DEFAULT_BOT_ID`；`profilesView`/`profileDrift`/`profileChoices`/`profileSetDigest`/`profilesDigest`/`profilesPath`/`profilePromptSections` → `botsView`/`botDrift`/`botChoices`/`botSetDigest`/`botsDigest`/`botsPath`/`botPromptSections`。
- 错误码前缀 `PROFILE_*` → `BOT_*`（含 `BOT_FILE_CORRUPT`、`BOT_FILE_VERSION_UNSUPPORTED`、`BOT_BACKEND_*`、`BOT_CAPABILITY_GAP`、`DISPATCH_RULE_BOT_UNKNOWN` 等，见附录 A）。
- `live.json`：`executor.profile` → `executor.bot`、`executor.profilesFile` → `executor.botsFile`、`dispatch.rules[].profile` → `.bot`、`repos[].profile` / `octo.chatRepos[].profile` → `.bot`；工单字段 `profileOverride` → `botOverride`；运行记录 `run.profile` / `run.profileId` → `run.bot` / `run.botId`；阶段配置 `stages[].profile` → `stages[].bot`。
- Bot 文件：`<stateDir>/worker-profiles.json` → `<stateDir>/worker-bots.json`，文档 `version` 1 → **2**；读到旧 `version: 1` 直接拒绝（`BOT_FILE_VERSION_UNSUPPORTED`）并提示「旧版档位文件（version 1）…重命名并改 version 后重试」，不猜键名、不静默退回内置（§4.1/§4.6）。
- 面板：设置页「档位」组 → 「Bot」，页内文案（内置三个 Bot、换 Bot 重跑、存为 Bot、Bot 文件、后端核验）、`st.profiles*` → `st.bots*`、详情页 `detail.profile*` → `detail.bot*`、`sa-run-profile` → `sa-run-bot`；API `GET/POST engine/profiles`、`POST engine/profiles/verify` → `engine/bots`、`engine/bots/verify`。
- 保留不动：`execProfile` / `ROUTE_PROFILES` / `routeProfile`（都是 routing 的只读·可写判定，与 Bot 无关）；DSH 安装 profile（`--profile desktop`）同理。

### 验证

- `node --test lib/live/*.test.js` → **662 pass / 0 fail**（新增一条：旧 `version: 1` Bot 文件被拒并给出改名提示；`version: 9` 仍是「请升级插件」）。
- `node scripts/build-client.mjs` → 24 modules / 525702 bytes，`--check` up to date；`node scripts/check-keys.mjs` → 1051 / 530 / 1496；`npm run types`、`npm run check:js`（`tsconfig.check.json` 的文件清单同步改名）、`node --check index.js`、`node scripts/render-check.mjs`（exit 0）全绿。
- 文档：`docs/worker-bots-spec.md` 头部实现进度与附录 C 标注「已在 v1.0.19 落地」，§3.7 补版本来源口径，§9.3 改按宿主 `llm.resolveModel` 取目录（`modelDirectories` 只在客户端注册）。

### 升级提示

- 自定义 Bot 需从 `worker-profiles.json`（`version: 1`）改名为 `worker-bots.json` 并把 `version` 改成 `2`；字段名不变，仅文件与版本号变化。
- `live.json` 里旧的 `executor.profile` / `profilesFile` / `dispatch.rules[].profile` / `repos[].profile` 现在会被忽略（键不存在），请在设置页重新指认，或按附录 C 手改。

## [1.0.18] — 2026-11-22

按 `docs/worker-bots-spec.md`（v3，即 1.0.15–1.0.17 期间评审过的 v2 规则，只改了「档位 → Bot」命名）做了一轮契约合规修复：1.0.17 的测试全绿，但闸门绿不等于契约符合 —— 对照 §3.2/§3.5/§3.7/§4.1/§9.3/§12 逐条核对后，有五处实现与规范相反，另有四处根本没接上。

### 修复 1：能力表只用于拒绝，未核验的后端不再靠它放行（§3.5 / §3.2 / I3）

- 根因：`dispatch.js` 的默认层有一条 `unverifiable()` 分支，后端探针是 `fallback`（即直接读 `BACKEND_CAPABILITIES` 静态表）时，只要表里写着这个工单要的能力就照派；现拉档位同理。这张表按 §3.2 只能解释拒绝，不能授权执行，而且它本身就是错的（下一段）。
- 修改点：删掉该分支与 `fallbackCapabilities` 导出，默认层只在候选集里找 `executor.profile`；现拉档位的后端能力一律取探针。`capabilitiesOf()` 增加 `observed = source !== 'fallback'`，静态表推不出任何能力。`executor.probesForRun` 改为对每个已启用后端各取一次探针（CLI 后端读 smoke 账本），不再只探 dsh。
- 顺带修正静态表（§3.5 点名的两条 + report 不是能力）：`claude.exec` 改 `true`、`codex.web` 改 `true`，`CAPABILITIES` 收为 `['edit','exec','web']`，`REQUIRED_CAPABILITY` 删掉 `interactive:'report'`。`claude.web` 保持 `false`：CLI help 只提到 WebFetch，没有 smoke 证据（§3.4 / Q6）。

### 修复 2：版本线接上，`stale` 不再不可达（§3.7 / AC-B2）

- 根因：`capabilityStateOf(probe, { version })` 的版本从来没人传 —— 调用方只传 probe，宿主也不暴露版本服务，于是「后端版本变了 → 重新核验」这条状态机永远是死代码。
- 修改点：新增 `hostVersionOf(ctx)`（`ctx.hostVersion` 函数/字符串 → `process.env.DSH_VERSION` → `undefined`）；`probeBackend` 的缓存键与证据行都用它，`engine.backendStateOf` 把它传给 `capabilityStateOf`。CLI 后端的探针现在直接读 `<stateDir>/backend-verify.json`（1.0.15 写了账本，但 `probeBackend` 从来不看它，等于白记）。

### 修复 3：保存期查宿主目录，`PROFILE_PRESET_UNKNOWN` / `PROFILE_EFFORT_UNSUPPORTED` 真的会报（§9.3 / §3.6）

- 根因：`engine.saveProfiles` 给 `validateProfile` 的环境只有能力与后端状态，`presetKnown` / `effortSupported` 从没被算过，两条错误码只在单测里存在。
- 修改点：保存前用宿主服务取目录 —— `agentPresets.list()` 得 preset 名单、`llm.resolveModel(provider, model)` 的 `reasoning.efforts` 得该模型支持的思考档；`writeProfiles` 把它们并进每个 bot 的校验环境。模型目录查不到时不作结论（不阻断保存），只报「确实不存在」的。
- 说明：规范原文写的是 `ctx.get('modelDirectories')`，该服务只注册在客户端 UI 插件里，宿主侧没有，因此改用 `llm`。

### 修复 4：Bot 文件读不出来就拒单，不再静默退回内置（§4.1）

- 根因：`executor` 读到 `readProfiles().code`（JSON 损坏、version 不匹配）只 `log()` 一行，接着派单 —— 现拉档位开着时还能凭空合成一个跑起来。
- 修改点：在派单结果落盘后、开工作树之前直接 `fail(PROFILE_FILE_CORRUPT 或 PROFILE_FILE_VERSION_UNSUPPORTED, 文件名与原因)`。面板设置页同时补上两处提示：文件读不出来（错误码 + 人话 + 修好后重试）与被忽略的未知字段（`droppedKeys`，§4.3 的非致命归一化结果此前没渲染，AC3 的 UI 半边）。

### 修复 5：运行中的 trace 边跑边落盘（§12 E1/E3/E4/E5 / AC11）

- 根因：DSH worker 的 events 只在 `await invokeWorker()` 返回后才写进 `run.trace`，运行期间面板空白，被停/超时的轮次也没有 trace。
- 修改点：`worker.js` 的 `record()` 每记一条就回调 `onTrace`（消费方抛错不影响 worker）；`executor.js` 新增 `liveTraceSink`，按 §12 归一化后进 80 条环，500ms 或积攒 8 条就 `persist()`（E4），停止/超时/worker_lost 的终止事件照常留在末尾（E5）；worker 返回后仍用 `traceOf(worker.events)` 覆盖为权威终值。

### 验证

- `node --test lib/live/*.test.js` → **662 pass / 0 fail**（新增 5 条：损坏 Bot 文件拒单、停止的轮次保留流式 trace、worker 每条事件都到达 `onTrace`、保存期 preset/effort 目录校验、smoke 账本使 CLI 后端可核验且换版本即 stale）。
- `node scripts/build-client.mjs` → 24 modules / 526599 bytes，`--check` up to date；`node scripts/check-keys.mjs` → 1051 / 530 / 1496；`npm run types`、`npm run check:js`、`node --check index.js`、`node scripts/render-check.mjs`（exit 0）全绿。

### 行为变化（升级前请看一眼）

- **未核验的后端不再能派单**：旧 `executor.workerBackend: 'codex'`（或 `claude`）配置现在需要先有一条 Bot + smoke 账本证据，否则拒绝并说明「没有可用 Bot」/「后端尚未核验」。这是 §3.7 的本意，但确实是行为变化。
- 默认层/现拉层不再用静态能力表兜底；宿主 `agentPresets` 不可用时，DSH 后端同样按未核验处理。
- 已知遗留：宿主不暴露版本，`stale` 只在设置了 `DSH_VERSION` 或注入 resolver 时可达；CLI 的增量事件（`onLine`）与 C1–C10 仍属于 P4/P5；阶段级 Bot（§10.2）未实现。

## [1.0.17] — 2026-11-21

1.0.16 打开「设置 → 档位」直接把宿主打崩（`应用无法启动或已意外停止`，`dsh: fatal load failure`），1.0.15 的档位契约层因此完全不可用。

### 修复：能力探针不再调用 `tools.resolve()`，也不再丢掉它的 Promise

- 根因：`lib/live/backend-capability.js` 的 `serviceToolNames` 在枚举工具名的最后一步调用宿主 `tools` 服务的 `resolve`。宿主的契约是 `async resolve(context: ToolActivationContext): Promise<ResolvedToolSet>`，`context` 必须带 `agent`/`modelSelection`/`signal`；无参调用在 async 函数里变成 **rejected Promise**，而 `call()` 是同步的、只 catch 同步异常，于是这个 rejection 没人接 —— 宿主以 `TypeError: Cannot destructure property 'agent' of 'context' as it is undefined` 退出进程。真实 `AgentPreset` 也没有 `tools` 字段，所以每次探针都会走到这条兜底路径。
- 修改点：`serviceToolNames` 改为读宿主的只读枚举面 `definitions()` / `schemas()`，再对 `TOOL_CAPABILITIES` 里的候选名逐个问 `tools.get(name)`（契约里三者都不需要 Agent）；`resolve` 与那段同步 `call()` 一起删掉。探针里任何一次调用抛错都只记「未核验」，不再影响宿主。
- 顺带修复同一函数的第二个偏差：`web.searchReady()` / `fetchReady()` 是 async，原代码不 await，Promise 既不是 `true` 也没有 `ready` 字段，于是 web 能力**永远**被判未核验。`readiness` 改为 async 并在 `probeDsh` 里 await，`evidence.providers` 也落成布尔值。

### 验证

- `node --test lib/live/*.test.js` → **657 pass / 0 fail**（新增 3 条：宿主形状的 `tools` 服务按名探测且 `resolve` 调用次数为 0、只有 `definitions()` 也能探测、只有 `resolve` 的服务退化成未核验而不是崩溃）。
- `npm run check`、`npm run check:js`、`node --check index.js`、`node scripts/check-keys.mjs`、`node scripts/render-check.mjs` 全绿（客户端未变）。
- 属于 Host 半修复：装上新版本后需要**重启 DSH**（重载插件即可）才生效。

## [1.0.16] — 2026-11-21

`tkt_f96ee85ca71d4577`：按 `docs/worker-profiles-spec.md` 落 **P2 派单层 + P3 面板 UI**。1.0.15 只交付了档位契约层与 DSH 参数，谁来选档位、选了之后记在哪、操作员怎么看和怎么换，都还缺。

### 新增：P2 派单层与 run.profile 记账

- `lib/live/dispatch.js`：`resolveDispatch(ticket, config, profiles, ctx)` 四层判定 —— 显式（`profileOverride` → `backendOverride` 映射内置档位 → 仓库 `profile` → 来源会话映射的仓库 `profile`）不可用即拒绝执行（`source: 'explicit'`、`degraded: 'explicit-unusable'`，绝不悄悄换一个）；`dispatch.rules` 按序第一条全条件命中（workTypes/keywords/repos/sources/deliverable 之间 AND、数组内 OR）；决策模型只在 `mode != rules` 且有候选时调用，严格 `validateChoice`（三个键、profile 必须在候选集或 null、confidence 0–1、reason ≤200），缓存键含 `profileSetDigest`、TTL/每轮询上限/同键单飞，失败分别记 `model` / `model-null`（§7.5 只允许这两个加 `explicit-unusable`，本轮轮询额度用完也归入 `model`，下一轮重试）；最后回退 `executor.profile`（`source: 'default'`）与现拉档位（`synthesizeProfile`，`source: 'adhoc'`），都不行才拒绝并说明是现拉关了还是现拉没有能覆盖本次工作的后端。候选集只含后端已核验且 `requires ⊆ capabilities` 的档位；探针没跑过的后端按 §3.2 的降级表判断，`default` 与现拉两层都不许把 `requires` 不满足的工作派出去（例如 research 要 web）。
- `lib/live/executor.js`：每轮先跑能力探针 → 派单 → 拒绝（`DISPATCH_DEGRADED`：没有可用档位，或显式指定的档位从未生效——AC4，此时连工作树都不开）→ `run.profileId` / `run.profile{id,backend,source,reason,degraded,capability,capabilitySource,verifiedAt,configDigest,resolvedAt}`；现拉档位额外带 `resolved` 与 `synthesizedFrom`；`profileOverride` 只写进这一轮的 run（§7.6），不改工单持久字段。预算、preset、model、deny、MCP 白名单、阶段与提示词全部从解析后的档位取。
- `lib/live/prompts.js`：提示词段名与顺序收敛到 `PROMPT_ORDERS`（100 brief / 120 task / 140 约定 / 160 role / 165 must / 170 skills），`worker.js` 按 order 注册并按顺序排序。
- `lib/live/worker.js`：新增 `promptSections` 与 `allowMcp`（`mcp__<server>__*` 前缀白名单，白名单外的 MCP 工具在 guard 处被拒）。
- `lib/live/workflow.js` / `workflow-worker.js`：`stages` 透传，`surgical` 这类档位不再跑 plan/review，`gates` 恒在。
- `lib/live/config.js`：`dispatch.adhocOrder` 缺省收窄为 `['dsh']`（§8.2：CLI 后端要等 smoke 通道落地才进现拉顺序）；`lib/live/repos.js` 支持 `repos[].profile`。

### 新增：P3 面板 UI

- `index.js`：`GET engine/profiles`、`POST engine/profiles`（校验失败返回 `code` + `problems`，面板就地显示）、`POST engine/profiles/verify`；`POST engine/ticket/:id/run` 接受 `profile`（换档重跑）。
- `lib/live/engine.js`：`profilesView/saveProfiles/verifyBackend/backendStateOf/profileDriftOf`；`profilesView.ruleWarnings` 把指向不存在档位的分派规则报成 `DISPATCH_RULE_PROFILE_UNKNOWN`；`ticketView` 增加 `profileDrift`（仓库里的档位文件被忽略，附两侧路径）与 `profileChoices`（换档下拉）。
- `client/src/settings.js`：新增「档位」组 —— 内置三档置顶且标「内置不可删」、编辑器按 §4.3 字段、保存期错误码 + 人话就地显示、「预览它能拿到什么」（能力集合/禁止工具/MCP 前缀/阶段）、复制内置、删除二次确认、后端核验状态与重新核验；`sessionStorage` 承接详情页送来的现拉档位草稿。
- `client/src/ticket-detail.js`：每轮运行显示档位摘要（`来源 · 判定依据`）、能力与来源（`能力：edit, exec（探针 / 日期）`）、未核验警示色、降级不折叠、失败/被拒/超时的 trace 直接展开、工作树内的档位文件提示、换档重跑与存为档位。
- `client/src/api.js`：错误响应保留 Host 的 `code`/`problems`。
- 文案口径按 I5：只写「限制/不给」，不承诺隔离、沙箱或安全边界。

### 未包含（后续工单）

- P4 Claude（C1–C10 进程契约、smoke 核验通道）与 P5 Codex；`dispatch.adhocOrder` 到那时再放开。
- P2.5 的 CLI 增量事件（`runProcess` 的 `onLine`、`applyClaudeLine/applyCodexLine`）留给 P4/P5：DSH 走进程内事件流，
  增量通道只服务于还没有上线的 CLI 后端，先做就是没有消费者的代码。
- 阶段级档位编排 UI（§10.2 的数据通路已通，面板还没有阶段选择器）。

### 验证

- `node --test lib/store.test.js lib/live/*.test.js` → **654 pass / 0 fail**（新增 `dispatch.test.js` 14 条，以及 prompt 段顺序、MCP 白名单、stages 跳过 plan/review、per-backend 保存校验、`run.profile` 记账、显式档位不可用即拒跑、仓库档位文件被忽略、未知规则档位被上报、档位路由各 1 条）。
- `node scripts/render-check.mjs` → **279 checks / ok true**（新增详情页档位摘要/能力来源/降级/未核验/仓库文件提示/换档下拉，以及设置页档位列表、内置档位不可编辑、未核验警示、编辑器预览、错误码就地显示、核验状态、规则档位缺失提示）。
- `node scripts/build-client.mjs` 24 modules / 525,931 bytes；`check-keys` 1049 / 530 / 1494；`node --check index.js`、`npm run types`、`npm run check:js` 全绿。
- 属于 Host 半 + 客户端改动：Host 半装上新版本后需要**重启 DSH**；客户端刷新页面即生效。

## [1.0.15] — 2026-11-21

`tkt_2ee8c4b1fbf7429d`：按 `docs/worker-profiles-spec.md` 落 P0 契约层与 P1 DSH 参数。此前 worker 只有「后端 + preset」一层配置，没有可声明、可校验、可复现的档位（profile）概念。

### 新增：档位数据模型、校验与状态目录存储

- `lib/live/worker-profile.js`：档位 schema 常量与内置档位（`generalist` / `surgical` / `reviewer`）；`normalizeProfile(s)` 白名单归一（未知键只报告、数组去重/截断、id/backend/stages 小写）；`validateProfile` 输出 `PROFILE_*` 码（含 `PROFILE_REQUIRES_NOT_CAPABILITY`、`PROFILE_CAPABILITY_GAP`、`PROFILE_BACKEND_UNVERIFIED/STALE/DISABLED`、`PROFILE_PRESET_UNKNOWN`、`PROFILE_EFFORT_UNSUPPORTED`、`PROFILE_STAGES_INVALID`）；`capabilitiesOf` 只采信探针未标 unverified 的能力；`resolveProfile` 合并硬黑名单 + 档位 deny、预算与提示词；`synthesizeProfile` 生成确定性的 `adhoc:` 档位；`readProfiles/writeProfiles` 读写 `<stateDir>/worker-profiles.json`（0600、原子写，缺失即内置、损坏/未来版本拒绝而非静默回退）。
- `lib/live/backend-capability.js`：能力探针与状态机。DSH 走进程内 `agentPresets.resolve` + 工具集映射（write/edit…→edit、bash→exec、web_search/web_fetch→web，并要求 `web.searchReady()/fetchReady()`），按 `(preset, host version)` 缓存；Claude/Codex 只认显式 smoke，证据记录在 `<stateDir>/backend-verify.json`，版本变化即 stale。

### 新增：executor 配置与 Host 半接线

- `lib/live/config.js`：`executor.profile`（默认 `generalist`）、`executor.profilesFile`（只允许 stateDir 下的裸文件名）、`executor.dispatch`（mode/adhoc/cacheSeconds/maxPerPoll/adhocOrder/rules）按白名单归一，非法值逐项丢弃且不影响其余配置；旧 `live.json` 的 `workerBackend/workerPreset/implementer/reviewer` 行为不变。
- `lib/live/worker.js`：`runWorker` 接受 `reasoningEffort` / `denyTools` / `preset`，档位 deny 只能叠加在硬黑名单之上；`agentOptions` 在带模型时把 reasoning effort 一并传给宿主，`auto` 不下发。
- `lib/live/worker-cli.js`：新增 `effortArgs(backend, effort)`（Claude `--effort`，DSH 透传，Codex 未验证前不加），由 `cliInvocation`/`runCliWorker` 统一使用。
- `lib/live/executor.js`：执行前读取档位，把 preset/model/reasoningEffort/deny/budget/maxRepairRounds 传给 worker（staged 与单 worker 两条路径一致）；档位不存在时退回 1.0.14 的行为，不阻断运行。
- `tsconfig.check.json`：两个新 Host 文件入档。

### 未包含（后续工单）

- P2 派单层（`lib/live/dispatch.js`：规则/决策模型/现拉档位、缓存与并发上限）与 `run.profile` 记账、P3 面板 UI（档位设置、换档重跑、trace 展示）、P4/P5 Claude/Codex 实跑与 C1–C10 进程契约。规范 §17 的 P0–P3 约 8–10 人日，本轮只交付 P0 契约层 + P1 DSH 参数。

### 验证

- `node --test lib/live/*.test.js` → **631 pass / 0 fail**（新增 `worker-profile.test.js` 18 条、`backend-capability.test.js` 9 条，并扩展 config / worker / worker-cli / executor 的档位与 effort 断言）。
- `node scripts/render-check.mjs` → **263 checks / ok true**；`build-client --check` 24 modules / 504,910 bytes（客户端未变）；`check-keys` 991/529/1421；`node --check index.js`、`npm run types`、`npm run check:js` 全绿。
- 属于 Host 半改动：装上新版本后需要**重启 DSH** 才生效。

## [1.0.14] — 2026-11-18

`tkt_68e399abfed64ae6` 的 `run_fb00585a0b08484a`：worker 06:31:13 正常结束、四个闸门（standards / backend / frontend / uat-sql-smoke）06:31:46.792 全绿，06:31:46.799 却以 **`其他原因：Workflow evidence is missing or stale; rerun the workflow`** 失败 —— 19 个文件留在工作树里没提交，分支 0 提交；随后点「发布」也在同一处失败。

### 修复：workflow 的评审证据规则只在 workflow 轮生效，不再拦非 workflow 轮

- 现场：同一工单上一轮 `run_896abf4007064892` 走 staged workflow，`plan` 抛出 2 个 open question，`executeWorkflow` 在 `workflow blocked: …` 处抛错，`ticket.workflowDigest = await digest()` 从未执行，于是工单上留下一份 `status: blocked / reason: plan_open_questions`、没有 digest 的 `ticket.workflow`。19 秒后（快照 `live-history/1794982636011-000001-14cnfd.json`，label `settings: executor.workflowMode`）配置从 `auto` 改为 `off`，重跑走单 worker 路径。
- 根因：交付守卫原来只判断 `if (ticket.workflow && (!ticket.workflowDigest || …))`，看的是「工单上有没有 workflow 记录」而不是「这一轮是不是 workflow 轮」。非 staged 分支永远不会写 digest（`delete ticket.workflowDigest` 只在 `if (staged)` 内），于是上一轮 blocked 的残留让之后每一次普通运行都在闸门通过之后、commit/push 之前失败。
- `lib/live/executor.js`：`finishPipeline` 的守卫改为 `run.workflow?.status === 'ready'` 才比较 digest —— `run.workflow` 只由 `executeWorkflow` 写入，正是「这一轮经 workflow 实现并交付」的证据；配置关闭、或 report/read-only 路由，都不会再有可比较的证据，残留记录对它们无效。
- `publishTicketInner` 同一守卫改为 `workflowMode` 打开 **且** `ticket.workflow.status === 'ready'` 才校验：发布本身就是普通交付，被禁用配置遗留的 blocked 记录不拦发布。
- 不清理 `ticket.workflow`：只要判断逻辑正确，workflow 轮留下的记录对非 workflow 轮就是惰性的；是否替换/续跑由下一轮 staged 执行自己决定。

### 验证

- `node --test lib/live/*.test.js` → **592 pass / 0 fail**（新增 4 条：残留 blocked workflow 不拦普通运行、report 路由在 `workflowMode: on` 下也不被残留拦住、`workflowMode: off` 时发布忽略旧 digest、`workflowMode: on` 时发布仍拒绝过期证据）。
- 属于 Host 半改动：装上新版本后需要**重启 DSH** 才生效。

## [1.0.13] — 2026-11-17

`tkt_59a2d395723646b9` 的 `run_2ac91627b4374739`：`assess` 通过（判为 planned），`plan` 跑了 44 步、写出一份很完整的计划，却以 **`其他原因：invalid acceptance IDs`** 结束。

### 修复：契约只说键名，模型把 acceptanceCriteria 写成了字符串数组

- 现场：`~/.dsh/sessions/.../workflow-run_2ac91627b4374739-plan-2` 的最终回答里，`acceptanceCriteria` 是十二个编号字符串（`"1. …", "2. …"`），不是 `{id, requirement, verification}` 对象。旧校验 `result.acceptanceCriteria.map(item => item?.id)` 于是全拿到 `undefined`，抛一句没法读回原因的 `invalid acceptance IDs`。
- 根因：DSH 阶段拿到的契约只有键名 —— `Return only a json object with keys: summary, steps, acceptanceCriteria, openQuestions.` —— 没有说数组元素长什么样；CLI 阶段有完整 `outputSchema`，所以只有 DSH 路径踩。
- `lib/live/workflow-worker.js`：新增 `schemaSketch(schema)`，`stageJsonMarker(role)` 从「只列键名」改为 `… keys: … . Shape: {"summary":"string","acceptanceCriteria":[{"id":"string",…}],…}`。枚举渲染成 `"simple|planned"` 字符串（若写成数组字面量，模型容易把 string 字段也答成数组）。
- `lib/live/workflow.js`：`plan` 的校验改为说清哪一项错 —— `plan acceptanceCriteria[0] must be an object with id, requirement and verification (got string)` / `… [i] has no id` / `… repeats the id AC-1`，同时保留在 `stage.error` 里供面板复盘。

### 验证

- `node --test lib/live/*.test.js` → **588 pass / 0 fail**（新增：计划把 AC 答成字符串时报 shape 错误、缺 id / 重复 id 各自点名；marker 断言含 Shape 与枚举写法）。
- `node scripts/render-check.mjs` → **263 checks / ok true**；`build-client --check` 24 modules / 504,910 bytes（客户端未变）；`check-keys` 991/529/1421；`node --check index.js`、`npm run types`、`npm run check:js` 全绿。
- 属于 Host 半改动：装上新版本后需要**重启 DSH** 才生效。

## [1.0.12] — 2026-11-17

1.0.11 的「等推送再试一次」没救回来：`tkt_59a2d395723646b9` 的运行结束后再点，宿主仍答 `sessions.retain: unknown session workflow-run_2ac91627b4374739-plan-2` —— 而同一个 id 在新起进程的列表里是有的（651 行，含 plan-2 / assess-1 / 旧 assess-1）。

### 修复：等不到推送时，主动拉一次列表

- 根因：客户端 `summaries` 只在连接时 pull 一次、之后靠宿主推送。运行由执行器 Host 半经 `agents.create` 起会话，这类会话不保证产生列表变更帧；页面又从运行开始前就加载着，于是这份快照整个页面生命周期内都不会自己补上那一行 —— 单靠「等」永远等不到。
- 客户端 `sessions` 的**文档面**没有 `refresh`（`retain/using/retainInfo/refreshProjections/search/fork/scope/binding`），但实现里有：`service.refresh()` → `manager.refreshList()`（`dsh-api-session-controller/src/client/sessions/service.ts:373`、`manager.ts:395`，单飞、重连时也走它）。实机确认桌面端可调用。
- `client/src/session-open.js`：被宿主拒绝后先 `refreshList(sessions)`（`typeof === 'function'` 才调、异常吞掉，缺席不算错）→ 再 `waitListed`（3s 等推送）→ 再试一次 `openSession`；仍被拒才报 `session-open-unavailable` 并带宿主原话。

### 验证

- `node scripts/render-check.mjs` → **263 checks / ok true**（新增两条：列表过期 → 一次 refresh 后直接打开；refresh 后仍没这行 → 不重试、报 unavailable 且带 `unknown session worker-void`）。
- `node --test lib/live/*.test.js` → **586 pass / 0 fail**；`build-client --check` 24 modules / 504,910 bytes；`check-keys` 991/529/1421；`node --check index.js`、`npm run types`、`npm run check:js` 全绿。
- 实机（dev 实例，真实 `~/.dsh/sessions`）：新拉取的列表 `phase:'ready'`、含 `workflow-run_2ac91627b4374739-plan-2` 与 `assess-1`；`ctx.get("sessions").refresh` 为函数。

## [1.0.11] — 2026-11-17

1.0.10 之后仍然复现：`tkt_59a2d395723646b9` 的新运行（`run_2ac91627b4374739`）正在跑、它的 `assess` 会话也确实出现在左侧「未分组」，点 run ID 却还是「DSH 的会话列表里没有这个 Session」。

### 修复：运行中的会话还没进列表投影，跳转就放弃了

- 根因在宿主的 `retain` 而不是本面板的守卫：`sessions.retain` → `resolveTarget` 只用「已实例化的 Session」和最近一次 `session.list` 拉下来的 `summaries` 做判断（`dsh-api-session-controller/src/client/sessions/manager.ts:147`），两者都没有就抛 `unknown session <id>`。一次还在执行中的运行刚创建出来的会话，磁盘上已经有了，列表那次 pull 里可能还没有 —— 于是 1.0.10 的「交给宿主裁决」把宿主的这句拒绝原样变成了「不存在」。
- `client/src/session-open.js`：被宿主拒绝后不再立刻放弃，改为等「列表点到这个会话的那一帧」（最多 3s，`retryMs` 可覆盖）→ 再试一次 `openSession`；第二次仍被拒绝才报 `session-open-unavailable`。注意客户端的 `sessions` 服务面**没有** `refresh`（只有 `retain/using/retainInfo/refreshProjections/search/fork/scope/binding`，列表由宿主推送），所以不能主动重拉，只能等推送；这也是为什么「真没了」和「还没推」需要靠提示语里的原因区分。
- 提示语带上宿主原话（`openSessionReason`）：`…还没登记）。DSH 给出的原因：unknown session worker-…`，这样「会话真没了」和「列表没追上」不再长得一样。`openSessionUnavailable` 的措辞也从「还在加载」改成「还没登记」，因为等待已经由代码做掉了。

### 验证

- `node scripts/render-check.mjs` → **261 checks / ok true**（新增三条：拒绝后等到列表推送到位即打开、列表始终没点名 → unavailable、提示语带宿主原因）。
- `node --test lib/live/*.test.js` → **586 pass / 0 fail**；`build-client --check` 24 modules / 504,779 bytes；`check-keys` 991/529/1421；`node --check index.js`、`npm run types`、`npm run check:js` 全绿。

## [1.0.10] — 2026-11-17

两个都在 `tkt_59a2d395723646b9` 上暴露：staged 工作流的 `assess` 阶段把散文当 JSON 交回来，整条运行直接 failed；那条运行留下的 run ID 又在会话列表还没投影出这个会话时被 opener 判成「不存在」。

### 修复：DSH 阶段没有回答契约，模型交回散文

- 根因：CLI 阶段靠 `outputSchema` 告诉模型交什么，DSH 阶段只拿到 `instructions.assess`（"Read relevant source and tests. Assess complexity…"）这类散文指令，没有任何「用一个 JSON 对象回答」的要求；`parseStageResult` 随后对一个 markdown 报告做 `JSON.parse`，冒出的就是 V8 的 `Expected property name or '}' in JSON at position 1`。
- `lib/live/workflow-worker.js` 新增 `stageJsonMarker(role)`：按 `SCHEMAS[role]` 生成 `Return only a json object with keys: workflow, reason.`，只对 `backend === 'dsh'` 的阶段追加（CLI 已有 `outputSchema`，`implement` 仍要求散文总结）。
- `lib/live/review-json.js` 把 JSON 模式的判据从 review 专用标记泛化成 `JSON_OBJECT_PROMPT`（"Return only a json object with keys:"），于是 assess / plan 的收尾回合也拿到 DeepSeek `response_format: {type:'json_object'}`；「还没看到任何 tool 结果前不开 JSON 模式」这条规则保持不动，避免模型先答后读。
- `parseStageResult` 改成括号配对扫描：接受裸对象、```json 围栏、带前言的回答、嵌套对象与字符串里的花括号；只有整段都解析不出对象时才失败，错误改成 `assess did not answer with one JSON object: <原文前 160 字>`，不再把裸解析器的报错丢给用户。

### 修复：会话列表还没投影出会话时，run ID 链接误报不存在

- `client/src/session-open.js` 的 `createSessionOpener` 不再拿 `sessions.list` 当闸门：列表只用来「等它别再 loading」和「查是不是归档」，真正的裁决交给宿主的 `openSession`；宿主拒绝（`unknown session`）才报 `session-open-unavailable`。列表比执行器慢一拍、或当前列表根本没投影这个会话时，跳转照常发生。

### 验证

- `node --test lib/live/*.test.js` → **586 pass / 0 fail**（新增 `lib/live/workflow-worker.test.js` 5 条：schema 文案、裸/围栏/前言、嵌套与字符串花括号、散文报错文案、数组与标量；`review-json.test.js` 补 assess 也进 JSON 模式、implement 不进）。
- `node scripts/render-check.mjs` → **258 checks / ok true**（新增「列表里没有该会话仍交给宿主」「列表永远不 ready 也照常跳」两条）。
- `build-client --check` 24 modules / 504,064 bytes；`check-keys` 990/528/1421；`node --check index.js`、`npm run types`、`npm run check:js` 全绿。

## [1.0.9] — 2026-11-17

一条：把「运行记录」里的 run ID 变成进执行器会话的门。此前 worker 的 DSH Session 在左侧「未分组」下能打开，但要从一次运行里看它跑的过程，只能自己去会话列表里一个个找。

### 新增（客户端）

- **run ID 即入口**：`client/src/util.js` 新增 `executorSessionId(run)`，只认 DSH worker 的会话（`run.worker.backend === 'dsh'` 且有 `sessionId`；staged 工作流取最后一个 dsh 阶段的 `sessionId`）。CLI worker（Codex / Claude Code）留下的是它自己的 thread id，不能当 Harness Session 打开，所以它们不进这条链路。
- `client/src/live-ui.js` 新增 `RunSessionLink`：run ID 渲染成 ghost 小按钮（图标 `session`，`title` 带完整 run id），点击调用面板早已接入的 `openSession`（`client/src/apply.js` 拿到的宿主 `uiWorkspace.openSession`），失败仍走 `useAction` 的统一报错。`LiveRunRows` 与工单详情的 `TicketRunRows` 都是「有可打开会话就链接、否则保留原来的复制按钮」，两者不并列。
- `client/src/i18n.js` 加 `openSessionHint`；`client/src/style.js` 加 `.sa-runid-open`（链接色 + hover 下划线）；`docs/pages.md` 的运行记录一行补上这条入口。

### 修复（实机验证后补的）

- 直接调 `uiWorkspace.openSession` 有两种失败态，实测都会掉回落地页（「选择一个工作区开始」），看着像插件没反应：
  - **页面刚加载**：`openSession` 内部先 `sessions.retain()`，而此时 Session 列表还是 `pending`，抛 `unknown session`，什么都不会打开；
  - **运行已结束、会话被归档**：`openSession` 不抛错，但 Workspace 控制器的 `clearArchivedCurrent()` 立刻把 selection 清掉。
- 新增 `client/src/session-open.js`：`createSessionOpener(ctx, { waitMs })` 先等 `sessions.list` 变成 `ready` 且 `byId` 里有这个 id（`missing` 才算打不开，6s 内仍未就绪也按「找不到」报错；列表形状读不出来就不拦截），命中 `archivedSessionIds` 就先 `unarchiveSession()` 再 `openSession()`；`openSessionMessage()` 把两种失败映射成 `openSessionUnsupported` / `openSessionUnavailable` 的人话。`apply.js` 的 `Mounted` 改用它（原来那段「没有 uiWorkspace 就抛中文」的判空逻辑搬进 opener）。
- 语义说明：点已归档运行的 run ID 会**顺带取消归档**——不这么做，Harness 会立刻把 selection 清掉，看不到会话。

### 验证

- `node scripts/render-check.mjs`：**256 checks / `"ok": true`**（原 247 + 3：DSH run 有链接、CLI run 无链接且仍是复制、点击后宿主收到 `worker-tkt_demo_accept-abc123`；+ 6 条 opener 单测：等 pending 列表、先取消归档再打开、未知会话报 `session-open-unavailable`、失败文案是人话、无 uiWorkspace 报 `session-open-unsupported`、列表形状不可读时不拦截跳转）。
- 实机（dev profile + 临时状态目录，ego lite 点真按钮）：
  - 运行中的 worker 会话 `worker-tkt_84fa0db527e24a0a-d64987` → 打开成功，标题「修复 freeze.md 并完成 BI-02」；
  - 已归档的 `worker-tkt_640380ab550b4e54-f04262` → 取消归档并打开，标题「发出商品报表数据传BI开发」；
  - 修复前同一操作停在「选择一个工作区开始」落地页（对照证据见本轮排障）。
- `node --test lib/live/*.test.js`：**580 pass / 0 fail**。
- 其余闸门：`node --check index.js`、`build-client --check`（24 modules / 504,063 bytes）、`check-keys`（990/528/1421）、`npm run types`、`npm run check:js` 全绿。

## [1.0.8] — 2026-11-17

两条：把「只读」从关键词升级为语境判断（工单 `tkt_e3c4b7ce8ddd4399` 只出报告、不落地需求的根因），并让一张工单能在标题/正文/追加要求里引用另一张工单，执行时自动带上被引用工单的报告。

### 修复（路由）

- **裸「只读」不再把工单钉成报告**：`lib/live/routing.js` 的 `READ_ONLY_INTENT` 现在只认只读**动作**（只读分析/审查/评审/梳理/本次只读/`read-only review` 等）与明确的禁改措辞（只分析/不要修改/不改代码）；引用语境里的“EBS 只读”“只读输入框”“`--verify` 只读检查”不再压制显式修改动词。根因是 0.4.31 引入的裸词把“修正 freeze.md 的 EBS 只读口径”判成只读分析，run 以 `report_delivered` 结束、worktree 干净。
- `routing.test.js` 补回归：引文式「只读」仍判 `change`；`只读分析/本次只读/read-only review` 仍判 `report`。

### 新增（工单引用）

- 新文件 `lib/live/references.js`：`ticketIdsIn(text)` 解析 `tkt_…`；`referenceContext(engine, ticket)` 取被引用工单的 `links.report.text`（没有报告则正文）拼成 worker 上下文块；最多 5 张、单张 40k 字符、总计 60k，缺号只写「未找到」不失败。
- `lib/live/executor.js` 的 `workerContext()` 把引用块接到 extraContext 之后，staged 工作流、单轮 worker 与发布修复三处都使用（`workerTask` 本身保持纯函数）。
- 引用内容是「背景需求」而非新指令：块头重复硬边界（不执行参考内容里的部署/发版/生产/EBS DDL/DML）。引用文本在建单时不再经过 R3（它已作为独立工单被接手并产出报告），新工单正文本身仍走 R3。
- 文档：`docs/pages.md` 手工建单说明；`docs/panel-improvements-2026-11.md` 的行为契约同步。

### 验证

- `node --test lib/live/*.test.js`：**580 pass / 0 fail**（新增 references 5 条、routing 1 条、executor 2 条）。
- `node scripts/render-check.mjs`：**248 checks / `"ok": true`**（hermetic fixture）。
- `node scripts/isolated-verify.mjs`：**PASS**（临时 DSH profile + 临时状态 + headless Chrome，随机端口独立启动；真实面板挂载、6 个页签、0 console error，未触碰运行中的面板与 `~/.dsh/superagent`）。
- 其余闸门：`node --check index.js`、`build-client --check`（23 modules / 501,251 bytes）、`check-keys`（986/525/1421）、`npm run types`、`npm run check:js` 全绿。
- 独立验证（真实状态只读）：`tkt_e3c4b7ce8ddd4399` 现在判 `dev/change/write`；草稿工单「按 tkt_e3c4b7ce8ddd4399 的报告落地」判 `change`、R3 不命中、worker task 已带 17,374 字符引用块；`live-state.json` 的 sha 前后一致（未写状态）。

## [1.0.7] — 2026-11-16

仓库卫生：把 `impeccable` 的工作目录从版本控制的口子上挡掉，并写清 `.github/` 与 `DESIGN.md` 侧的契约产物各自该不该进仓库。

### 文档

- **`.impeccable/` 只留契约 sidecar**：`.impeccable/design.json` 是 `DESIGN.md` 的机器可读另一半（impeccable `document`
  流程随 `DESIGN.md` 一起重生成），属于设计契约，继续纳入仓库且不手改；`config.local.json`、`critique/`、`build/`、
  `review/`、`mocks/` 是工具在一个人机器上的工作目录（评审报告、构建状态、组件评审清单、示意图），已加入 `.gitignore`，
  避免以后整目录 `git add` 时把本机产物和截图提交上去。
- **`AGENTS.md` 结构一节补两条**：`.github/` 下是功能性文件（`ci.yml` 就是分支保护引用的 required checks、
  `auto-pr.yml` 是交付桥），不进 `.gitignore`；`DESIGN.md` 与 `.impeccable/design.json` 是人读/机器读两半，
  `design.json` 是生成物，跟着 `DESIGN.md` 重生成。

## [1.0.6] — 2026-11-16

渲染闸门原来是「看本机脸色」的：同一句 `node scripts/render-check.mjs`，本机跑 246 条、CI 跑 245 条，结果还不一样。
1.0.4 的 CI 红就是这么漏过去的——本地全绿，合进 `main` 之后 CI 才红。这一版把闸门固定在一份自带状态上。

### 修复（闸门）

- **`render-check` 不再读 `~/.dsh/superagent`**：原来 `DSH_SUPERAGENT_STATE_DIR` 未设时会直接拿本机真实 `live.json`，
  于是决策条数、信号、线程都随机器变，面板的请求断言（深链 offset、筛选、空态）跟着变；CI 上干净检出只有 1 条决策，
  本机 42 条，两边断言命中的分支不同。现在默认永远用 `test/fixtures/live.json` 在临时目录建状态，本机与 CI 跑的是同一个
  条件。`DSH_SUPERAGENT_STATE_DIR=<目录>` 保留为排障用的显式 opt-out（目录里必须有 `live.json`），会打印
  `[render-check] 用外部状态目录 …（结果可能与 CI 不同；CI 跑的是自带 fixture）`；目录里没有 `live.json` 时警告并回退 fixture。
- **fixture 补远程凭据占位**：`gitlab.token` / `octo.token` 写进临时状态目录。原来干净 clone 上「允许合并 MR」开关因为
  没有 token 而 disabled，U-06 的两步确认检查被 SKIP（`no second writable high-risk switch on this machine`）——
  这条覆盖洞跟凭据无关，是 fixture 缺省值造成的。
- **新增一条 hermetic 断言** `the gate runs on its own fixture state unless an operator opts in (hermetic)`：
  状态目录若不是 fixture 又没显式 opt-in，闸门自己报红，避免以后有人又把本机状态接回来。

### 验证

- 默认（本机，有真实状态）：**247 checks / 0 failed / 0 skipped**。
- 无 `~/.dsh/superagent` 的干净状态：同样 **247 / 0 / 0**（此前 245 + 1 SKIP）。
- `DSH_SUPERAGENT_STATE_DIR=/tmp/<有 live.json 的目录>`：走外部状态并打印警告；目录不存在或没有 `live.json`：警告后回退 fixture。
- 其余闸门不变：`node --check index.js`、`build-client --check`（23 modules / 501,251 bytes）、`check-keys` 986/525/1421、
  `npm run types`、`npm run check:js`、`node --test lib/live/*.test.js` 572 pass / 0 fail。

## [1.0.5] — 2026-11-16

纯文档：把「怎么改这个仓库」从只有面板自开发一种角色，补成两种开发方式并列出共同的 GitFlow 硬线。

### 文档

- **AGENTS.md 区分两种开发方式**：`禁止`一节原来写的是「不要 `git push` / `git merge` / `git tag` / `gh pr`：执行器负责
  提交、推送与交付；worker 只改工作树」——那是**面板自开发**（工单驱动、执行器开 worktree）的角色分工。在 DSH 会话里
  直接改本地仓库时，提交者就是会话里的 Agent 自己，照字面读容易得出「Agent 不能提交/推送」，或者反过来直推受保护分支。
  现在新增「两种开发方式（同一套 GitFlow）」一节，把两者并排列出，并写清共同的硬线：只在交付分支提交、交给 auto-pr 开 PR、
  PR 前 CI 必须绿、不直推 `main`/`develop`、不 `--force`、不 squash；`禁止`一节的措辞同步按两种方式改写。
- **补一条「推之前用干净状态跑渲染闸门」**：`render-check` 在 `~/.dsh/superagent/live.json` 存在时读的是本机真实状态，
  干净 clone 与 CI 读 `test/fixtures/live.json`，两边结果可以不同——1.0.4 的 CI 红（本机 42 条决策、CI 只有 1 条）就是这么
  漏出去的。现在写明 `DSH_SUPERAGENT_STATE_DIR=$(mktemp -d) node scripts/render-check.mjs` 就是 CI 的条件。

## [1.0.4] — 2026-11-15

一轮开发视角深挖审计（`verification/dev-audit-round2.md`）的 10 条缺陷，加上用户第二轮点检（`verification/ui-review-round2.md`）的 13 条修复与 5 条体验问题，合并发布。服务端修的是「并发/契约/生命周期」，界面修的是「刷新、筛选、命名与可达性」。

### 修复（服务端）

- **两组设置同时保存会丢改动并报 500**：`updateLiveConfig` 先读整份 `live.json` 再写回，临时文件名只用进程号加毫秒，
  同一毫秒的两个请求撞名后，后一个 `rename` 找不到临时文件（`ENOENT … .live-<pid>-<ms>.json`），先到的那组改动也
  被后写者覆盖。现在读改写整段进单进程串行队列，临时名带随机后缀（`lib/live/live-json.js`）。
- **同一工单的并发动作返回 500 和英文内部文案**：`withTicketClaim` 撞上在跑动作时抛普通 `Error`，Host 只把
  `ActionError` 映射成 4xx；详情页双击「运行/重试/回答」会看到 `ticket … is already busy (executing)`。
  现在抛带 `httpStatus:409` 的 `TicketBusyError`，文案是「工单 … 正在执行「…」，请等这次操作结束再试。」，并且
  Host 在 run/gate/resume/answer/publish 前主动检查（`lib/live/executor.js`、`index.js`）。
- **发布 MR 接口先答应再失败**：对不存在或状态不对的工单也立刻返回 202，真正的失败只进 Host 日志；`wait:true` 时
  甚至返回 `undefined` 字符串（不是 JSON）。现在前置校验「未知工单 404 / 状态不允许 409 / 执行器关闭 403 /
  未允许推送 409」，`wait:true` 恒返回 JSON，异步失败写进工单时间线（`index.js`）。
- **`awaiting-answer` 工单没有出口**：stop、dismiss、追加要求三个入口都拒绝等待回答的工单，唯一出路是「回答」，
  而回答会整单重跑。现在可以「放弃并清理」：`dismissTicket` 收 `awaiting-answer`，把停在 `waiting_for_human` 的运行
  结算成 `failed/abandoned`，清工作树与分支；`requestStop` 也改成指路「回答或忽略」（`lib/live/engine.js`）。
- **禁用/重载插件时在跑的工单被写成「已中断」**：`engine.stop()` 只清定时器，旧运行仍在写盘；新引擎 `reconcile()`
  把它标 `interrupted` 后，旧运行完成时的整份文档写回又把状态改回去，两边的写入互相覆盖。现在 `stop()` 置
  `disposed`、关闭文档（`LiveState.save()` 不再落盘），执行器在停止检查、持久化与证据写入前都看 `disposed`
  （`lib/live/engine.js`、`lib/live/state.js`、`lib/live/executor.js`）。
- **`allowPush=false` 把「真跑」也拦掉了**：只关推送时，入口 403，用户既跑不了也看不懂。现在 `allowPush` 只决定
  「推不推」：真跑照常执行、本地 commit、落 `gates-passed`，待办明确写「改动已完成但未推送（allowPush=false）」；
  发布 MR 返回 409 并给出「打开推送后再发布，或忽略并清理」两条路（`index.js`、`lib/live/executor.js`）。
- **运行停止原因有 5 个码没有文案**：`worker_lost` / `route_unsupported` / `review_stale` / `report_delivered` /
  `waiting_for_human` 曾显示成「其他原因（raw）」，现在各有中文结论与情绪色（`client/src/live-ui.js`）。
- **设置项越界返回 500 + 英文**：`updateLiveConfig` 的字段校验抛的是普通 `Error`，Host 只能按 500 回包，提示还是
  `executor.timeoutMs must be whole milliseconds between …`。现在校验失败带 400 语义、文案改中文并带字段名与范围，
  Host 统一映射成 400（`lib/live/live-json.js`、`index.js`）。
- **状态文件的临时名没有随机后缀**：`live-state.json` 的原子写临时名同样只含进程号与毫秒，写失败时还会留下 0 字节
  残留。现在带随机后缀，异常时清理该临时文件（`lib/live/state.js`）。
- **验收清理失败的分支永远不会触发**：Host 判断 `result.cleanupFailed`，`acceptTicket` 返回的却是 `cleanup.failed`，
  清理失败只能静默 200。现在对齐真实返回（`index.js`）。

### 修复（界面）

- **来源页翻页后刷新/分享回到第 1 页**：首屏的「筛选变了就回第 1 页」effect 在挂载时也跑一次，把 URL 里的
  `srcOffset` 归零。现在首屏按 URL 取数，翻页写回 URL，`offset=0` 省略（`client/src/source.js`）。
- **评估页显示英文 `modelSkip` 等原因码**：全局原因字典缺模型判断与过滤类编码。现在补齐 `modelSkip` / `modelRisk` /
  `modelUncertain` 及 9 个过滤码，来源页与评估页共用一套文案（`client/src/i18n.js`）。
- **「模型调用（成功 / 失败 / 跳过）」后面有 4 个数字**：标签只列 3 桶。现在标签写「总计 / 成功 / 失败 / 跳过」，
  与 `${calls} / ${ok} / ${errors} / ${skipped}` 一一对应（`client/src/settings.js`）。
- **GitHub 仓库被叫「GitLab 项目 / GitLab token」**：同卡还并排「GitLab 项目」与「GitHub 地址」。现在「项目 / 地址 /
  令牌」按托管方取词（GitHub / GitLab），表单字段保持中性的「远端项目 / 远端地址」（`client/src/util.js`、
  `settings.js`、`source.js`、`live-ui.js`）。
- **触发页搜索无结果时谎报「还没配来源」**：现在区分「没有符合当前筛选的线程」并给「清除筛选」，只有真的没有线程
  才引导去来源页（`client/src/trigger.js`）。
- **「24 小时运行失败 0 次 →」仍可点**：点进去是历史失败单。现在 0 次时只显示一句「24 小时没有运行失败」，不再可点
  （`client/src/execution.js`）。
- **评估页筛选切页签再回来全清**：跨页清理把同页筛选也删了。现在每页的最近筛选/分页写进 `sessionStorage`，切回时
  恢复，URL 仍只留当前页参数（`client/src/router.js`、source/trigger/eval）。
- **排队未执行的工单也能点「发布 MR」**：现在入口与服务端白名单一致，只有 `ready` / `failed` / `pushed` 可发布
  （`client/src/live-ui.js`、`ticket-detail.js`）。
- **评估页 offset 越界误报「筛选无记录」**：现在收回到最后一页并提示「你打开的位置超出范围；已显示最后一页」
  （`client/src/eval.js`）。
- **概览「主要失败原因」显示原始码**：指标里的失败原因是 `stopReason` 或错误码，页面上直接出现 `stopped`、
  `workflow blocked`。现在已知原因走运行字典（如「人工终止」），`workflow blocked: …` 翻成中文结论，未知标识
  写成「技术标识：…」而不是冒充一句人话（`client/src/overview.js`）。
- **失败工单在概览「系统问题」里没有清理入口**：失败待办是非阻塞项，会被并进系统问题块，而那里只有「去工单」。
  现在该行同样提供「忽略并清理」（`client/src/overview.js`）。
- **首次带 token 打开带筛选的链接丢筛选**：模块求值时先捕获初始 query，宿主清理地址栏后仍能回落到它；每页只回落
  一次（`client/src/router.js`）。

### 体验

- **变更历史只有一句标签**：展开每条历史即可看到字段的「旧值 → 新值」，开关类写「开 / 关」，长值截断后可展开全文；
  Host 用快照 diff 出改动清单，不再需要额外接口（`lib/live/live-json.js`、`client/src/settings.js`）。
- **新单的「需求」藏在改动内容里**：工单详情把需求提成独立章节、默认展开并加进页内跳转，改动内容仍可折叠
  （`client/src/ticket-detail.js`）。
- **「配置 3/4」是死文本**：自动化状态条（`AutomationBar`，设置流程卡出现时它仍是实际可见的那一条）和头部配置条目
  改成「还有 N 项待配置」，保留可点的「继续配置」（`client/src/live-ui.js`、`client/src/shell.js`、`client/src/setup.js`）。
- **Token / 令牌 / chatId 混用**：凭据类统一「令牌」并区分「已配置 / 未配置」，群标识统一「群 ID」（`client/src/settings.js`、
  `live-ui.js`）。
- **禁用菜单项读屏无法得知原因**：禁用项补 `aria-disabled="true"`（`client/src/controls.js`）。
- **折叠标签统一为「技术详情」**（原「原始错误」），与 CHANGELOG 及注释一致（`client/src/i18n.js`、`live-ui.js`、
  `ticket-detail.js`）。

### 已知限制

- 禁用/重载插件仍可能中断在跑的工单（本次在停止后不再写盘，但不提供运行租约）；带筛选的深链依赖宿主不提前改写
  `query`，被改写时首屏只能回落到模块加载时捕获的那份参数。

## [1.0.3] — 2026-11-15

一轮 11 条用户点检（`verification/ui-review-team.md`）加 4 条自查缺陷的修复，分「修复」（行为确实不对）和「体验」
（行为对、但用户读不懂或够不着）两组。

### 修复

- **待办箱里出现过没人能解掉的验收条目**：`ACCEPT_STATUSES` 曾把 `mr-open` / `ci-passed` 也算成「等待验收」，
  这两张工单的前端验收按钮是禁用的（验收要等合并/部署），于是它变成一条 `blocking` 待办，`resolveInbox` 又因
  `blocking` 拒绝关闭（409），只能等外部系统推进才消失。现在 `lib/live/engine.js` 只把 `deployed` 当验收待办，
  合并后验收仍由 `acceptance='merged'` 分支覆盖。
- **`allowPush=false` 的真跑结果没有待办**：跑完闸门、`run.status='gates-passed'`、工单停在 `ready`，但待办箱只认
  `dry-run`，运营看不到「该发 MR 了」。现在 `deriveInboxItems` 的 publish 分支同时收 `dry-run` 与 `gates-passed`，
  标题按哪种完成分别说「干跑完成」/「闸门已通过」（`lib/live/engine.js`）。
- **空装时首屏谎报「绑定仓库已完成」**：`normalizeRepos` 恒合成一条占位仓库（`repo-1`，路径与项目都为空），
  而配置卡按 `repos.length > 0` 打勾。现在 `client/src/setup.js` 的 `setupStateOf` 要求仓库有本地路径或远程项目
  才算绑定（4 步里会正确显示 0/4）。
- **干跑会被依赖安装卡死**：frontend 闸门前会先跑 `pnpm install --frozen-lockfile`，失败即 `bootstrap_failed` 致命退出，
  于是任何没有 pnpm/lockfile 的仓库连第一次干跑都过不去。现在 `lib/live/executor.js` 的 `runGatePhase` 在干跑时把
  安装失败降级成 `bootstrap:pnpm` 的 `warn` 步骤并继续跑闸门；真跑仍按致命处理（失败原因更接近「仓库没准备好」
  而不是「改动有问题」）。
- **启动失败的引擎会永远显示「运行中」**：`engine.start()` 抛错时 Host 只打 warning，`lastStatus` 停在 `starting`，
  侧栏把 `starting` 归入「运行中」，所有 `engine/*` 接口却是 503。现在 `lib/live/engine.js` 新增 `setStartError()`，
  `index.js` 在启动失败时调用，头部显示明确的错误态。
- **被停止的 bootstrap 步骤永远停在「运行中」**：`pnpm install` 或闸门命令在停止请求到达后 `aborted` 早退，只把
  运行记录收成 stopped，却没有给该步骤写终态，执行页于是同时显示「已停止」和一条转圈的步骤。现在
  `lib/live/executor.js` 的三处早退（bootstrap、`runGatePhase`、`publishTicket` 的闸门）都补 `state:'stopped'`
  + `aborted:true` 的终态步骤。

### 体验

- **章节锚点会把整个宿主外壳滚走**（`client/src/ticket-detail.js` 的回答/查看验收/运行记录跳转，`client/src/source.js`
  的筛选定位）：原来用 `scrollIntoView`，浏览器会连带滚动宿主的外层框架。现在统一走 `client/src/util.js` 的
  `panelScroller`/`scrollPanelTo`，只改面板自己的 `.sa-scroll`。
- **带 `#sa=…` 刷新不回到面板**：`client/src/apply.js` 在注册主区后，如果本次加载带着面板的深链，就反复尝试用
  宿主的 `ctx.layout.selectPanel(PANEL_ID)` 把面板激活（每 120ms 重新取一次 layout 服务，最多 17 次≈2s，成功或
  用户自己切走就停）。`layout` **不再写进 `inject`**：旧宿主没有这个服务时插件仍然照常激活，只是深链打不开面板
  （深链自动挂载依赖宿主的 `layout` 服务；没有它的宿主上，链接会像以前一样停在落地页，不报错）。
- **`dry-run` / `starting` 被读成「运行中」**：`client/src/shell.js` 的 `globalHealth` 不再把干跑和启动中说成运行中，
  引擎未启用时一律落到「已停止」，并新增 `shell.starting`（启动中）。干跑后头部与「自动化未启动」的矛盾随之消失。
- **手工建单的两个下拉没有可见标签**：`client/src/live-ui.js` 的交付目标/执行后端各自补 `<label>` 与字段标题，
  `aria-label` 不变。
- **评估页「筛选后为空」说的是「还没有记录」**：`client/src/eval.js` 的 `evalEmptyState` 增加筛选态分支（「这个筛选条件下
  没有记录／换个决定类型，或清除筛选」），与执行页口径一致；`decisionsView` 的 counts 改为按历史（不含 kind/view）算，
  避免「分歧」视图下总数显示成 1。
- **原始信号的长文本只能看 160 字**：`lib/live/engine.js` 的 `signalRow` 额外下发 `text`（>160 字时截到 1000），
  `client/src/source.js` 的行标题带 `title` 全量，点击/回车就地展开全文（不弹窗、不跳页、折叠态行高不变）。
  展开后标题变成「收起」、原来的预览段不再重复渲染，正文只出现一次。
- **保存高危开关只差一次点击就写盘**：`client/src/settings.js` 对 `enabled`、`executor.enabled/autoRun/allowPush/
  allowMerge` 的变化先展开人话差异清单（「启用引擎：开始自动轮询群消息…」），确认后才写；普通字段仍一步保存。
  监听群的新增/移除本来就有独立确认，未改动。点「确认保存」的瞬间会按**当前草稿**重算一次风险差异：打开清单之后
  又改过的高危开关不会被当成旧清单里的样子写盘——清单变了就先刷新清单、要求再确认一次；差异归零（改回原值）
  则按普通保存处理。
- **执行记录里的「恢复」看起来像按钮**：`client/src/live-ui.js` 的触发方式标签改「恢复触发」，两处渲染从
  `Tag tone="outline"` 改为 `quiet` 并带「这次运行是怎么触发的」提示（`client/src/execution.js`、`client/src/ticket-detail.js`）。
- **GitHub 仓库被写成「GitLab 地址」**：`client/src/source.js` 的 `sourceRepoRows` 按托管方选标签（GitHub 地址／
  GitLab 地址／远程地址），token 缺失改「未配置（不影响本地只读）」，仓库卡在无 token 时状态改「本地可用」并说明
  仍可本地只读；来源页「已启用 x/y」不再把未绑定的占位仓库算进去。
- **筛选参数在页签之间串台**：`client/src/router.js` 新增每页的参数白名单 `PAGE_QUERY_KEYS` 与 `prunePageQuery`，
  切页时只清掉不属于该页的参数，保留 `#sa` 深链与宿主自己的参数。
- **后台枚举值直接透出**（`bot-sender`、`modelSkip`、`workflow blocked: …`）：`client/src/source.js` 补齐跳过码中文，
  未知码显示「未识别原因（技术标识：…）」；`client/src/live-ui.js` 的失败映射新增分阶段流程阻塞（含独立审查要求修改），
  未知英文错误首行给「其他原因：…」结论，原文收进可展开的技术详情。

### 验证
- `node --check index.js`、`node scripts/build-client.mjs`（23 modules / 492,485 bytes）、`node scripts/check-keys.mjs`
  （967 / 513 / 1398）、`npm run types`、`npm run check:js`、`node --test lib/live/*.test.js`（557 pass / 0 fail）、
  `node scripts/render-check.mjs`（217 checks / 0 failed / 0 skipped）。
- 真机（dev 实例）复验深链：F5 保留 `#sa={"page":"eval"}` 后 252ms 自动挂载并落在评估页，冷开
  `?token=…#sa=…` 同样挂载，console 0 error。

## [1.0.2] — 2026-11-14

### 文档
- `docs/ui-workflow.md` 重写：原文还把面板描述成「裸 DOM、无 JSX，规范写在 `spec/panel-ui.md`」，与 0.8.0 之后的实现
  （ES 模块 + JSX、`jsxFactory: 'h'`、esbuild bundle）和公共仓库的现实（`spec/` 不入库）都不符。新版补了模块地图、
  「React 只从 `./react.js` 引入」的硬约束、`npm ci` 与 `check:js`/`render-check`/`isolated-verify` 的完整闸门，
  真机点检改成 dev profile（`npm run dev`），模板 prompt 同步。
- `DESIGN.md` 对齐代码：补「实现形态」段（ES 模块 + JSX、单一 CSS 模板字符串、token 定义在 `.sa-page`/`.sa-main`/`.sa-toast`）；
  修正三条与 `client/src/style.js` 不一致的说法——`.sa-md` 不再声称显式 opt out `tabular-nums`、列表行点击区
  是 `.sa-row-open` 自身撑满（没有 `::after` 覆盖层）、按钮变体就是四个 CSS 类。

## [1.0.1] — 2026-11-14

### 文档
- `docs/delivery.md` 的「发布（维护者）」补全为四步：注释 tag → `npm pack` 并 `gh release create` 附 tarball →
  `npm publish --access public`（先 `--dry-run` 看文件清单）→ `chore/backmerge-X.Y.Z` 回合并。
- 起因：1.0.0 发布时 npm 发布这一步只有口头惯例，没有写在仓库里。

## [1.0.1] — 2026-11-14

### 文档
- 分发渠道修正：1.0.0 **只**通过 GitHub Release 的 tarball 分发，npm 暂不发。README 的「安装」回到 tarball 优先、
  去掉 npm 安装示例；`docs/delivery.md` 的 npm 步骤标注为「暂未启用」并保留操作说明，等启用时照做即可。
- `package.json` 保留 `publishConfig.access: public`、保持非 private：启用 npm 时不需要再改元数据。

## [1.0.0] — 2026-11-14

第一个公开发布版本。仓库转为 public，通过 GitHub Release 的 tarball 分发（`package.json` 已去掉 `"private": true`
并写好 `publishConfig.access: public`，npm 发布暂未启用）。

### 自 0.9.13 起
- 无功能变化；只改分发元数据与安装文档：`package.json` 去掉 `"private": true`、加 `publishConfig`，版本 1.0.0；
  README 的「安装」一节改成 npm 优先，tarball 与本地 checkout 作为备选。

### 1.0 之前发生了什么（0.4.39 → 1.0.0 摘要）
- **0.4.39–0.9.4**：开源准备（LICENSE / CI / `npm ci` 与 lockfile / 可复现的 jsdom 渲染回归 / CONTRIBUTING、COC、
  SECURITY、issue 与 PR 模板）、客户端构建层从「手写拼接」换成 esbuild（产物 782 KB → 481 KB + sourcemap）、
  客户端全面迁移到 JSX、客户端拆成真正的 ESM 模块并把文件名语义化。
- **0.9.5–0.9.12**：`checkJs` 分档推进到全量（Host 半 + 客户端入口，28 个文件、0 错误）；删除旧「演示管理层」
  1,752 行与 25 条遗留路由；交付桥覆盖 `fix/**`、`chore/**`、`docs/**`；README 重写并拆出 `docs/pages.md`
  与 `docs/quickstart.md`；历史中的内部域名/仓库名/本机路径用 `git-filter-repo` 重写清除。
- **0.9.13**：修「改动 diff」弹窗在工单已消失时永远停在「正在读取 diff…」。

### 验证
- `check:js` 0（28 文件）、`types` 通过、`--check` 23 modules / 481,428 bytes、`check-keys` 959/513/1360、
  Host 554 pass / 0 fail、render-check 198 checks / 0 failed / 0 skipped、`isolated-verify` PASS（console errors 0）。
- `npm pack` 后在干净临时目录 `npm i <tgz>` + `dsh plugin --profile <临时> add <tgz>` 可启动面板。

## [0.9.13] — 2026-11-14

### 修复
- 「改动 diff」弹窗在工单已不存在时会永远停在「正在读取 diff…」。`engine.ticketDiff(...)` 对已删除/重置的工单返回
  `undefined`（`lib/live/engine.js` 的 `ticketDiff`），而 `loadDiff` 会把 `{ path, data: undefined }` 存进对话框状态——
  既不 `loading` 也不 `error`，于是 `DiffCard` 的 `if (!data) return <Hint>{ticket.diffLoading}</Hint>` 一直成立。
- 修法：`loadDiff` 区分「读到了」与「读完了但没有数据」，后者记 `{ path, gone: true }`；新增纯函数
  `diffPlaceholderKey(state)` 决定占位文案（`ticket.diffLoading` / 新增的 `ticket.diffTicketGone` / `null`），
  `DiffCard` 按它渲染；正常路径（工单还在、只是没执行过）仍走原来的 `data.available !== true` 分支，行为不变。

### 验证
- `scripts/render-check.mjs` 新增 4 条断言（在飞行中 / 读完但数据为空 / 已加载 / 读取失败），总数 194 → **198 checks，
  0 failed / 0 skipped**；其中「读完但数据为空」在没有修复时会渲染成「正在读取 diff…」，这条断言会失败。
- `npm run check:js` 0、`--check` 23 modules / 481,428 bytes、`check-keys` 959/513/1360（新增一个 key）、
  Host 554 pass / 0 fail、`isolated-verify` PASS（console errors 0）。

## [0.9.12] — 2026-11-14

### 变更
- checkJs 的最后一档：`tsconfig.check.json` 加入 `client/src/index.js`，`npm run check:js` 现在覆盖**全部代码**——
  Host 半（`index.js` + `lib/`）与整个客户端（入口 `index.js` 顺着 import 检查每个片段）。清单 26 → 28 个文件，
  0 个错误。
- 客户端补完的 JSDoc/类型（只加类型，不改行为，含两个子代理并行完成的两个大文件）：
  - `types/dsh.d.ts` 补 `declare namespace JSX`（`Element`/`IntrinsicAttributes.key`/`IntrinsicElements`/`
    ElementChildrenAttribute`）——这一步把 390 个错误降到 276；`SlotEntry.label` 放宽为 `string | (() => string)`，
    依据是 `dsh-client-ui-plugin-manager` 里传的是 thunk。
  - `client/src/controls.js`（14 个基础控件）、`widgets.js`（16 个展示组件）的 props 一律可选，并用
    `[attribute: string]: any` 承接 `...rest`。
  - `markdown.js` 增加 `MarkdownBlock` 联合类型；`i18n.js` 的字典构建从 `flatMap` 改成显式循环（保留原分组规则）；
    `live-model.js` 增加 `EngineActions`（35 个动作的签名与参数顺序）；`apply.js` 收口 `ctx.get?.(…)`；
    `shell.js` 修 DOM 聚焦与类组件 `props`；`live-ui.js` 补 `TicketRow`/`TicketList`/`ManualTicketForm`（`onCancel?`）。
  - `ticket-detail.js` 增加 `DiffRequestState`（对照 `lib/live/diff.js` 的 `worktreeDiff` 与 `engine.js` 的
    `ticketDiff` 的真实返回形状）+ `DiffCard` 的 `@param`；`settings.js` 给 `SettingsSwitchRow`/`SettingsStatusLine`
    补可选 props，并把 DOM 聚焦处的 `Element` 收口成 `HTMLElement`。
- 文档同步：`AGENTS.md`/`CONTRIBUTING.md`/`README.md` 的闸门说明从「Host 半全量、客户端尚未入档」改为
  「Host 半 + 客户端入口全量」。

### 验证
- `npm run check:js` 0 错误（28 个文件）；`npm run types` 通过。
- `node scripts/build-client.mjs` → 23 modules / 481,032 bytes（JSDoc 被压缩器去掉，产物只少了 20 字节的代码改动）；
  `node --check client/index.js` OK；`check-keys` 958/513/1359。
- `node --test lib/live/*.test.js` → 554 pass / 0 fail。
- `node scripts/render-check.mjs` → 194 checks / 0 failed / 0 skipped。
- `node scripts/isolated-verify.mjs` → PASS，console errors 0，六个 tab 都在。

## [0.9.11] — 2026-11-14

> 发布说明：v0.9.11 是 0.9.5–0.9.11 的汇总发布（checkJs 分档、删除旧管理层、交付桥前缀、Host 半全量入档），
> 只通过 GitHub Release 的 tarball 分发，`package.json` 仍是 `"private": true`。

### 变更
- `tsconfig.check.json` 的 tranche 4：`index.js` 入档，`npm run check:js` 现在覆盖**整个 Host 半**（含入口）。
- `index.js` 只有 10 个错误，都是 `resumeTicket(...)` / `answerTicket(...)` 的联合返回（`{run, ticket}` vs
  `{missing, invalid}`）在 `if (result?.missing)` 处收窄失败；修法是
  `const result = /** @type {any} */ (await resumeTicket({ … }))`，`answerTicket` 同款。
- `AGENTS.md` / `CONTRIBUTING.md` / `README.md` 的闸门说明改成「Host 半全量入档；客户端 `client/src/*.js` 尚未入档」。

### 为什么
`engine`/`executor` 在 0.9.10 清零后，`index.js` 的错误从 151 掉到 10——绝大多数是引擎返回类型没标注时的连锁报错。
把入口也纳入清单，P4 的 checkJs 部分就只剩「客户端片段」这一档。

### 验证
- `npm run check:js` 0 错误（清单 26 个文件）；`npm run types` 通过；`node --check index.js`。
- `--check` 23 modules / 481,052 bytes；`check-keys` 958 / 513 / 1359。
- Host `554 pass / 0 fail`；render-check `194 / 0 failed / 0 skipped`。

## [0.9.10] — 2026-11-14

### 变更
- `tsconfig.check.json` 的 tranche 3：`lib/live/engine.js`、`shadow.js` 进 `files`；`engine.js` 会拉进 `executor.js`，
  所以三个文件一起清零（清单 23 → 25 个文件，`npm run check:js` 0 错误）。`index.js` 仍在清单外（会牵出整条引擎链，
  留最后一档）。
- 修法全是类型标注，没有行为改动：给「解构出一个 options 对象」的函数补 `@param {any} [options]`
  （`engine.js` 的 `deriveInboxItems`/`routePreview`/`signalsView`/`operationsView`/`acceptTicket`/`dismissTicket` 等，
  `executor.js` 的 `runCommand`/`gateCommandFor`/`workerBrief`/`createRunRecorder`/`markRunComplete`/`executeTicketInner` 等，
  `shadow.js` 的 `collectShadowSamples`）；`error.code`/`error.status`、`records.ticket.routeSelection`、
  `candidate.signalId`、`built.decision`、`check.onFail`、`worktreeDiff` 的返回联合等用 `/** @type {any} */` 收口；
  `deps = {}` 统一改成 `deps = /** @type {any} */ ({})`，`log` 参数标成 `(line: string) => void`。
- `lib/live/shadow.js` 的 `collectShadowSamples` 补了 `@param {any} [options]`。

### 为什么
`check:js` 分档的价值是「新代码在已清档的模块里必须类型干净」。`engine`/`executor`/`shadow` 互相 import，
不一起清零就无法单独入档；它们是 Host 半最重的三个文件（放探针时 257/161/267 个错误），清零后
`npm run check:js` 覆盖了除 `index.js` 之外的整个 Host 引擎。

### 验证
- `npm run check:js` 0 错误；`npm run types` 通过；`node --check index.js`。
- `--check` 23 modules / 481,052 bytes（未动客户端）；`check-keys` 958 / 513 / 1359。
- Host `554 pass / 0 fail`；render-check `194 / 0 failed / 0 skipped`；`isolated-verify` PASS（console errors 0）。

## [0.9.9] — 2026-11-14

### 变更
- `tsconfig.check.json` 的 tranche 2：`lib/live/repos.js`、`config.js`、`signals.js`、`inbox.js`、`live-json.js`、`worker.js`
  进 `files`（tranche 1 → 2 共 23 个文件），`npm run check:js` 仍 0 错误。
- `lib/live/worker.js` 补 JSDoc：`joinChildrenBeforeTurnEnd` 的 `{ subagents, payload, log }` 参数类型与返回形状；
  `runWorker` 补 `readOnly`/`preset`/`signal` 三个漏掉的 `@param`；`ctx.agents` 与 `agentCtx.on` 用 `any` 兜住宿主未声明的服务；
  `offs`/`stopChildren` 显式标类型（否则从 `ctx.on` 的返回值推成 `never`，`release?.()`/`stopChildren()` 都报 TS2349）。

### 为什么
`worker.js` 是唯一还有错误的叶子模块：其余五个（`repos`/`config`/`signals`/`inbox`/`live-json`）实测 0 错误，
加进清单即可防回归。`engine`/`executor`/`shadow`/`index.js` 分别 257/161/267/275 错误，留作 tranche 3。

### 验证
- `npm run check:js` 0 错误；`npm run types` 通过；`node --check index.js`；`--check` 23 modules / 481,052 bytes；
- `check-keys` 958 / 513 / 1359；Host 554 pass / 0 fail；render-check 194 / 0 failed。

## [0.9.8] — 2026-11-14

### 变更
- `docs/delivery.md` 的分支前缀表补上 `fix/**`、`chore/**`、`docs/**`（与 0.9.7 的 `auto-pr.yml` 触发面一致）。
- `ci.yml` 的 push 触发面补上 `docs/**`：此前 docs 分支只有 `auto-pr` 会跑，分支保护要求的 `test (22)`/`test (24)`
  不出现，PR 反而合不了。这条 `docs/**` 分支本身就是验证：推送后 `auto-pr` 自动开了 PR，CI 也照常跑。

## [0.9.7] — 2026-11-14

### 变更
- `.github/workflows/auto-pr.yml` 的触发前缀补上 `chore/**` 与 `docs/**`（此前只有 `feature/**`、`fix/**`、
  `release/**`、`hotfix/**`）：这两类分支 push 后不会再只跑 CI、需要人手动 `gh pr create`。
- `ci.yml` 的 push 触发早已含这两个前缀，现在两套工作流的触发面一致。

## [0.9.6] — 2026-11-14

### 变更
- 删除旧「管理层」：`lib/views.js`、`lib/actions.js`、`lib/store.js`、`lib/seed.js`、`lib/prompts.js`，以及它们挂的
  25 条非引擎路由（`GET state|overview|search|sources|settings|threads|decisions|tickets|policy/history|models|prompts`、
  `PUT settings|prompts|prompts/preview`、`POST threads/:id/unsubscribe|triggers/:id/requeue|decisions/:id/dismiss|
  tickets/:id/retry|tickets/:id/stop|sources/:id/labels|policy-sync/:id|executor/pause|setup/check|demo/reset`）。
  `index.js` 从 719 行降到 590 行，只剩引擎 API；`/superagent/api/<unknown>` 现在直接回 404。
- `index.js` 不再构造那个给旧视图用的 `host`（`createHost`/`readModels`/`FALLBACK_MODELS`/`MACHINE_LIMITS` 一并删除），
  `apply()` 只等引擎启动；`ActionError` 改为本文件内的 4 行类。
- 测试脚本从 `node --test lib/store.test.js lib/live/*.test.js` 收敛成 `node --test lib/live/*.test.js`
  （`store.test.js` 随 `store.js` 删除）；`tsconfig.check.json` 去掉已删除的 `lib/prompts.js`。
- `AGENTS.md` 结构段、`index.js` 头注释、`docs/quickstart.md` 的「演示种子/`/demo/reset`」说明同步更新。

### 为什么
客户端从 0.4.x 起只调 `/superagent/api/engine/*`，旧管理层早已是死代码：它需要另一份 `state.json`、另一套 actions，
却仍在 `apply()` 里被加载和注册，读代码的人会以为面板有两套数据源。删掉后 `/superagent/api` 只对应 `lib/live`。

### 验证
- `node --check index.js`；`node scripts/build-client.mjs --check` 23 modules / 481,052 bytes（未动客户端）。
- `node scripts/check-keys.mjs` 958 / 513 / 1359；`npm run types` 与 `npm run check:js` 均通过。
- Host 测试 554 pass / 0 fail（少了 `store.test.js` 的 2 条）。
- `node scripts/render-check.mjs` 194 checks / 0 failed / 0 skipped；`node scripts/isolated-verify.mjs` PASS，console errors 0。

## [0.9.5] — 2026-11-14

### 变更
- 新增 `tsconfig.check.json` 与 `npm run check:js`：用 `checkJs` 真正类型检查 JS 源码，但只覆盖
  「分档清单」里已经清零的文件。第一档是 Host 侧 21 个不依赖 `engine`/`executor` 的叶子模块
  （`lib/util.js`、`lib/prompts.js`、`lib/live/{repo,worker-tools,workflow,workflow-worker,acceptance,evidence,
  operations,worker-cli,review-json,diff,github,routing,eval,judge,octo,gitlab}.js`），0 错误。
- `ci.yml` 增加同名步骤；`AGENTS.md`、`CONTRIBUTING.md`、`README.md`、`docs/ui-workflow.md` 的验收命令同步，
  并写明规则：修好一个旧文件就把它加进 `files`，不要为了让绿灯把文件移出去。
- 给第一档文件补齐 JSDoc：批量把 27 处 `{ … } = {}` 默认参数标成 `Record<string, any>`（TS 会把 `{}` 推成空对象类型，
  属性访问全报 TS2339）；`acceptance.js` 的 `requirement`、`repo.js` 的 `prepareWorktree`、`worker-tools.js` 的
  `registerWorkerTools` 补参数/返回类型；`eval.js` 的 `ignore` 闭包、`gitlab.js` 的 `createGitlabClient`、
  `octo.js` 的 `firstDefined`/`toNumberOrRaw`、`review-json.js` 的 `log` 与扩展注册表补显式类型；
  `prompts.js` 的 `defaultChanged` 拆出带类型的 `changedPart`，避免 `flatMap` 返回联合数组。

### 为什么
P4（类型契约）此前只做了一半：`types/dsh.d.ts` 只校验声明本身，源码里 700 多个 `checkJs` 错误完全没进闸门，
类型注解写了也不验。一次性清零需要跨十几个模块补 JSDoc，一个 PR 不可审，所以改成只增不减的分档清单：
CI 从第一天起就守住已清零的部分，剩下的按 `engine`/`executor`/客户端逐档推进。

### 验证
- `npm run check:js` 0 错误；`npm run types` 通过；`node --check index.js` 通过。
- `node scripts/build-client.mjs --check` 23 modules / 481,052 bytes（只改 Host 半，客户端产物不变）。
- `node scripts/check-keys.mjs` 958 / 513 / 1359。
- Host 测试 556 pass / 0 fail。
- `node scripts/render-check.mjs`（`DSH_SUPERAGENT_STATE_DIR=/tmp/rc-t1`）194 checks / 0 failed / 0 skipped。
- `node scripts/isolated-verify.mjs` PASS，console errors 0。

## [0.9.4] — 2026-11-14

### 变更
- 新增 `scripts/dev.mjs` 与 `npm run dev`：用 `dev` profile（软链到本工作树）起一个 DSH 实例并打印带 token 的 URL，
  自动按 runtime CLI → app bundle → PATH 的顺序找 `dsh`，参数原样转发。
- `AGENTS.md` 的「本机两种安装态」把开发态收成一个命令，并补充两条注意事项（dev 实例用临时
  `DSH_SUPERAGENT_STATE_DIR`；全局 `~/.dsh/cordis.patch.yml` 的 MCP 条目也会加载，连不上只告警）。
- `dev` profile 已补齐 bundles（`dsh-base` + `dsh-web-app` + 本插件），此前只带 `dsh-base`，起不来 Web UI。

### 为什么
「边改边看」如果只写在文档里，每次都要拼全路径、记 profile 名；收成一条命令后这条路径才有可能天天走。

### 验证
- `node scripts/dev.mjs --help` 能转发到 dsh；用临时 `DSH_SUPERAGENT_STATE_DIR` 实起一次实例：
  `GET /superagent/api/engine/status` → 200（`phase: disabled`，`x-superagent-request: 1` 头），
  停掉后端口关闭、进程退出。`--dump-config` 显示 `superagent-panel` 与 `dsh-web-app` 都在合成树里。

## [0.9.3] — 2026-11-14

### 变更
- `AGENTS.md` 新增「本机两种安装态（必须分清）」：`desktop` profile 是干净安装（依赖指向 Release tarball、包目录是实体目录），
  `dev` profile 才软链到工作树供边改边看；明确禁止把仓库目录 `add` 进 `desktop`，并写清升级/核对命令
  （`node scripts/local-install.mjs`、`--verify`）与 dev 实例起法。

### 为什么
之前用 tarball 装桌面端时，pnpm 把依赖解析成了指向工作树的 `link:`，桌面端跑的是未发布代码却显示成 0.5.1；
这类「安装态漂移」不写在规则里，下次还会重犯。

### 验证
- 只改文档与版本号：`node --check index.js`、`--check`、`npm run types`、Host 556 pass、render-check 194/0 未变。

## [0.9.2] — 2026-11-14

这是 v0.8.0 之后累计到 `main` 的发布：0.8.1 证据空态语义、0.8.2 CI 去人工 approve + README 带数据截图、
0.9.0 P4 类型契约、0.9.1 文档状态标注，以及本节的 render-check 轮询修复。仍然 `"private": true`，只发 Release
tarball，不进 npm。

### 修复
- `scripts/render-check.mjs` 挂载后不再固定 `await sleep(900)`，改为轮询等待「`.sa-page` 出现且没有骨架屏」，
  超时 20 秒才报 `WAIT panel first data load timed out`。PR #50 的 Node 24 任务曾出现一次
  `FAILED 53/194`：CI 上首次数据加载晚于 900 ms，收件箱还没到，后面所有经它进入的断言连锁失败
  （`gh run rerun` 即通过，本地 Node 24 也通过——典型的固定等待 vs 机器速度）。轮询让这道闸门验行为，
  不验机器快慢；真加载不出来时仍然会超时报错。

### 验证
- 本机 `node scripts/render-check.mjs`（Node 24.22.2）：194 checks / 0 failed / 0 skipped，exit 0。
- `node --check index.js`、`--check`、`npm run types`、Host 556 pass 未变。

## [0.9.1] — 2026-11-14

### 变更
- 两份 2026-11 的评审文档标注状态：`docs/product-review-2026-11.md` 改为「历史输入」（六项改进已在
  0.4.19–0.4.38 落地），`docs/panel-improvements-2026-11.md` 明确为仍然有效的行为契约。仓库公开后这两份
  最容易让人误判「这些是待办」，先写清楚。

### 验证
- 只改 Markdown 与版本号：`node --check index.js`、`--check`、`npm run types`、Host 556 pass、render-check 194/0。

## [0.9.0] — 2026-11-14

### 新增
- **手写的宿主类型契约 `types/dsh.d.ts`**（P4）：只声明本插件真正用到的两面——Host 的
  `apply(ctx, config)`（`logger`、`effect`、`webServer.register`、`get`）与 Client 的 `apply(ctx)`
  （`slots.inject/register`、`locale.register`、`get('uiWorkspace')`），外加 `window.__ModuleLoader__` 的
  `load({ id, factory })`。**刻意不引用 `@deepseek-ai/dsh-*`**：那会把插件钉死在某个 DSH 版本的内部类型上，
  而这里要的是「宿主至少提供过什么」。
- `tsconfig.json` + `npm run types`（`tsc -p tsconfig.json`，`typescript` 5.9.3 精确锁定），只做 `noEmit`
  检查声明文件自身；CI 增加同名步骤，这样声明不会悄悄失效。
- `index.js` 的 `apply` 与 `client/src/apply.js` 的 `apply` 加了 JSDoc（`@param {DSH.HostPluginContext}` /
  `{DSH.ClientPluginContext}`），编辑器装了这个包就能顺着跳进类型定义。

### 变更
- `package.json` 的 `files` 增加 `types/**/*.d.ts`；`docs/self-development.md`、`docs/ui-workflow.md`
  里「render-check 依赖 `/tmp/sa-harness`」的旧说法改成 devDependencies（那是 P0 之后就过期的描述），
  闸门清单补上 `npm run types`。

### 验证
- `npm run types`（tsc 5.9.3）通过；`node --check index.js`；`--check` 23 modules / 481,052 bytes；
  check-keys 958/513/1359；Host 556 pass；render-check 194 checks / 0 failed。

## [0.8.2] — 2026-11-14

### 变更
- **CI 在投递分支的 push 上直接跑**：`ci.yml` 的 `push` 触发从 `[develop, main]` 扩到 `feature/**`、`fix/**`、
  `release/**`、`hotfix/**`、`chore/**`。push 运行不需要人工 approve，而分支保护读的是挂在 head commit 上的
  check run，两者的效果一致——之前每个 PR 的 `pull_request` 运行都停在 `action_required`，要手工
  `gh api -X POST …/actions/runs/<id>/approve`。
- README 首图从空状态换成带数据的执行页（三条排队工单、执行器负载、视图筛选），
  文件改为 `docs/images/panel-execution.png`。

### 验证
- `node --check index.js`；`node --test lib/store.test.js lib/live/*.test.js` 556 pass。
- `node scripts/build-client.mjs --check`（产物未变）；check-keys 958/513/1359；render-check 194/0。
- 截图来自隔离 DSH 实例（fixture 状态 + 通过 Host API 建的三条工单），console errors 0。

## [0.8.1] — 2026-11-14

### 修复
- **待运行工单的「交付证据」被渲染成读取失败**：`GET /superagent/api/engine/evidence/<ticketId>` 在没有证据记录时
  统一返回 `404 没有这段交付证据`，客户端 `DeliveryEvidenceCard` 把 404 当成错误，显示「没有这段交付证据 +
  可以先重试… + 原始错误」，而页面本来已经有「这段交付还没有持久化的证据（旧工单或尚未跑完）」这条空状态文案。
  - Host：工单**存在**但没有证据时返回 `200 { ticketId, rounds: [] }`（走空状态）；工单不存在仍返回 404。
    `evidence/:id/compare` 缺少可比较轮次时改为 `404 没有可比较的交付证据`，与「工单不存在」区分开。
  - 新增路由测试：已存在但无证据的工单 → 200 空轮次；未知工单 → 404。
- Host 测试 555 → 556。
- `.github/workflows/auto-pr.yml` 的触发分支补上 `fix/**`（此前只有 `feature/**`、`release/**`、`hotfix/**`，
  `fix/` 分支要手工开 PR）。

### 验证
- `node --check index.js`；`node --test lib/store.test.js lib/live/*.test.js` 556 pass / 0 fail。
- `node scripts/build-client.mjs --check`（产物未变，481,039 字节）；check-keys 958/513/1359。
- `node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。

## [0.8.0] — 2026-11-14

### 变更
- **客户端模块改成语义化文件名**：数字前缀只是拼接时代的加载顺序，P3 之后顺序已由 `client/src/index.js` 的
  import 列表显式表达，因此 `git mv` 重命名 23 个文件——`00-react.js`→`react.js`、`00-util.js`→`util.js`、
  `05-style.js`→`style.js`、`06-i18n.js`→`i18n.js`、`07-md.js`→`markdown.js`、`10-controls.js`→`controls.js`、
  `15-api.js`→`api.js`、`20-widgets.js`→`widgets.js`、`21-localtext.js`→`localtext.js`、`25-router.js`→`router.js`、
  `30-shell.js`→`shell.js`、`32-live-model.js`→`live-model.js`、`33-setup.js`→`setup.js`、`34-live-ui.js`→`live-ui.js`、
  `35-overview.js`→`overview.js`、`40-source.js`→`source.js`、`45-trigger.js`→`trigger.js`、
  `48-thread-detail.js`→`thread-detail.js`、`50-eval.js`→`eval.js`、`55-execution.js`→`execution.js`、
  `58-ticket-detail.js`→`ticket-detail.js`、`60-settings.js`→`settings.js`、`90-apply.js`→`apply.js`；
  同时更新 `index.js` 的 import 列表、`scripts/client-exports.mjs` 的映射与文档里的引用。
  产物逐字节不变（481,039 字节，23 模块）。
- **README 重写**：从 153 行的内部说明收缩成面向使用者的 88 行——一句话定位 + 截图、功能要点、安装（Release tarball
  或本地 checkout）、快速开始、开发命令、文档索引；原来的逐页细节与配置/排障拆到 `docs/pages.md` 与
  `docs/quickstart.md`，删掉原型仓库出身、GitFlow 沿革、内部自开发叙述等对外无意义的段落。
- 新增 `docs/images/panel-overview.png`（概览页真机截图，1280×900）作为 README 首图。
- `AGENTS.md`、`CONTRIBUTING.md`、`docs/*.md` 的交叉引用与"按数字顺序"的描述同步更新。

### 验证
- `node scripts/build-client.mjs --check`：23 模块，481,039 字节，逐字节一致。
- `node --check client/index.js`；check-keys 958/513/1359；Host 555 pass / 0 fail。
- `node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0，六个页签齐全。

## [0.7.0] — 2026-11-14

### 变更
- **P3：客户端从"按文件名拼接的片段"变成真正的 ESM 模块**（issue #35）。
  - 新增 `client/src/index.js` 作为入口：按数字顺序 `import` 其余模块，并从 `90-apply.js` 再导出 `{ inject, apply }`；
    数字前缀不再承载加载顺序（顺序由 import 列表显式表达），`22 片段` 的隐式契约消失。
  - 新增 `client/src/00-react.js`：把宿主提供的 `react` 收敛成一张导出表（`React`、`h`、常用 hooks），
    每个模块显式 `import` 需要的名字；`h` 不再来自工厂作用域的 prelude。
  - 22 个模块的顶层声明全部 `export`，跨模块引用改为显式 `import { … } from './xx-name.js'`；
    419 个顶层名字此前共用一个工厂作用域，现在各自归属到定义它的模块。
  - `scripts/build-client.mjs` 从 esbuild `transform` 改为 `bundle`：`format: 'cjs'`、`platform: 'browser'`、
    `external: ['react', 'react-dom', 'react/jsx-runtime']`，banner/footer 提供 `module`/`exports` 并包回
    `window.__ModuleLoader__.load({ id, factory(require) { … } })`——对外契约与之前完全一致。
  - 新增 `scripts/client-exports.mjs`：`check-keys.mjs` 与 `render-check.mjs` 通过它按同一套 esbuild 参数打包
    一个虚拟入口，取出 `App`/`DICTS`/`PANEL_CSS` 等内部名字，替代原来的"拼接文本 + `new Function`"。
- 产物 484,636 → 481,039 字节（−3,597）；`client/index.js.map` 同步重生成。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（23 模块，逐字节）。
- `node scripts/check-keys.mjs`：958 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0，六个页签齐全。

## [0.6.0] — 2026-11-14

### 变更
- **P2 完成**：客户端六个片段全部从 `h(...)` 迁移到 JSX（issue #34）。0.5.2–0.5.7 六个补丁版本合起来是这一步：
  `10-controls.js`、`20-widgets.js`、`30-shell.js`、`34-live-ui.js`、`58-ticket-detail.js`、`60-settings.js`，
  共 6,657 行、约 2,000 处调用点，产物 485,801 → 484,636 字节，产物契约与 `window.__ModuleLoader__.load` 工厂不变。
- 构建层先切成 `loader: 'jsx'` + `jsxFactory: 'h'`（只换 loader 时产物逐字节相同），之后每个文件一个 PR 单独迁移，
  diff 里只有写法变化；`scripts/check-keys.mjs` 与 `scripts/render-check.mjs` 同步改成先用 esbuild 编译再求值。
- `60-settings.js` 里十二个重复的仓库字段收敛成 `repoInputField(key, labelKey, { required, placeholder, hintKey })`，
  动态标签统一改成大写变量（`const Dot = detail ? 'span' : 'div'`）。
- 阶段意义：从此 `client/src` 可以按文件读写 JSX，P3（issue #35，真正的 ESM 模块边界）才有动手的前提。

### 验证
- 每个补丁版本的 PR 都跑过完整闸门：`node --check client/index.js`、`build-client --check`（22 片段）、
  `check-keys`、Host 555 pass、`render-check` 194 checks / 0 failed / 0 skipped、`isolated-verify` PASS（console errors 0）；
  CI 的 `test (22)` / `test (24)` 两个矩阵全绿后才 merge。
- 真实浏览器（隔离 DSH 实例 + `test/fixtures/live.json` 夹具状态）验过：概览/设置各组、执行列表、工单详情
  （改动内容/验收/自动化/阶段链路/运行记录/时间线）、添加仓库对话框（13 字段 + 必填校验）、编辑仓库对话框、
  配置示例对话框，均无控制台报错。

## [0.5.7] — 2026-11-14

### 变更
- `client/src/60-settings.js`（2306 行，420 处 `h(...)`）从 `h(...)` 迁移到 JSX（P2 第六步，issue #34）：
  `SettingsSwitchRow`、`SettingsStatusLine`、`WorkerCapabilityCard`、`ReposCard`、`settingsHeading`、`saveBarFor`、
  `reloadButton`、`renderRepos`、`renderOctoToken`、`renderGroupPicker`、`renderSenders`、`renderSource`、`renderEval`、
  `renderReview`、`renderRun`、`renderWorker`、`renderWrite`、`renderPrompt`、`settingsNavButton`、`repoFieldError`，
  以及四个对话框（变更历史、编辑仓库、添加仓库、配置示例）与最终返回树。
- 添加仓库的表单原本十二个字段各写一遍，抽成 `repoInputField(key, labelKey, { required, placeholder, hintKey })`
  一个 helper；编辑仓库的差异表 `repoEditRows`、闸门编辑器、各组的保存/丢弃/重载逻辑保持不变。
- 产物 486,236 → 484,636 字节（−1,600），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：958 literal keys / 513 shared / 1359 page-local，OK（数字从 967 降到 958，是因为
  九个字段标签改成通过 `repoInputField` 的 `labelKey` 参数传入，不再出现在 `pt(t, '…')` 字面量位置；键本身没变）。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。
- 真实浏览器（隔离实例 + 夹具状态）：设置页各组切换、添加仓库对话框（13 个字段、必填校验报「请填写此项。」并聚焦
  `sa-repo-field-id`）、编辑仓库对话框（12 个输入、闸门编辑）、配置示例对话框（`pre` 360 字）均正常渲染，无控制台报错。
  截图 `verification/browser-run-settings-0.5.7.png`、`verification/browser-run-add-repo-0.5.7.png`。

## [0.5.6] — 2026-11-14

### 变更
- `client/src/58-ticket-detail.js`（1951 行，403 处 `h(...)`）从 `h(...)` 迁移到 JSX（P2 第五步，issue #34）：
  `TicketStamp`、`TicketTimeline`、`TicketLazyFolded`、`RunTrace`、`RunHandoff`、`RunReport`、`TicketGateResults`、
  `AcceptanceRecordCard`、`TicketActivities`、`TicketRunRows`、`DiffBody`、`DiffCard`、`AutomationCard`、
  `DeliveryEvidenceCard` 以及 `TicketDetail` 整体（primaryAction 链、确认/差异对话框、四条 banner、四个 section、返回树）。
- 只改写法：字典、`TICKET_STEP_KEYS`、纯函数（`ticketEvents`、`changesOf`、`gateOnFailOf`、`failureHint`、
  `ticketVisibleJumps` 等）与交互逻辑不变；条件渲染仍用同一组判定。
- 产物 486,055 → 486,236 字节（+181），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。

## [0.5.5] — 2026-11-14

### 变更
- `client/src/34-live-ui.js` 从 `h(...)` 迁移到 JSX（P2 第四步，issue #34）：`AutomationBar`、`TicketRow`、
  `TicketList`、`TicketGroups`、`ManualTicketForm`、`FunnelBar`、`ExecutorLoad`、`GateSummary`、`StageRail`、
  `MergeRequestCard`、`UatCard`、`ticketEvidence`、`rowAcceptanceChip`、`automationChip`、`PilotStatusTag`、
  `TicketStatusTag` 以及三个过渡 shim 只改写法，输出逐节点等价。
- `StageRail` 的 `span`/`div` 二选一改成大写变量 `const Dot = detail ? 'span' : 'div'`；`TicketGroups` 的
  `className` 分支与 `TicketList` 的常驻 live region 保持原有开关逻辑。
- 产物 485,946 → 486,055 字节（+109），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。

## [0.5.4] — 2026-11-14

### 变更
- `client/src/30-shell.js` 从 `h(...)` 迁移到 JSX（P2 第三步，issue #34）：`GlobalStatus`、`GlobalSearch`、
  `Header`、`Pages`、`PanelBoundary`、`PanelShell`、`App` 只改写法。`PanelBoundary` 仍是 class 组件（它要
  `getDerivedStateFromError`），`Back`/`globalHealth`/`pageView` 等纯函数不动。
- 组件型 props 直接用元素：`icon={<Icon name="search" size={16} />}`、`<PanelState.Provider value={model}>`，
  与原来的 `h(Component, props, children)` 同构。
- 产物 485,926 → 485,946 字节（+20），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。

## [0.5.3] — 2026-11-14

### 变更
- `client/src/20-widgets.js` 从 `h(...)` 迁移到 JSX（P2 第二步，issue #34）：`Section`、`KeyValues`、
  `Inlines`、`MarkdownLite`、`ClampText`、`ConfirmButton`、`ExternalLink`、`PageHead`、`EmptyState`、
  `ErrorState`、`Skeleton`、`SaveBar`、`RawValue`、`Folded`、`GlossaryButton`、`GlossaryModal` 只改写法，
  输出保持逐节点等价：同样的 class 名、`data-*`、ARIA 属性与文本。
- Markdown 标题与列表改用动态标签变量（`const Heading = \`h${...}\`、`const List = block.ordered ? 'ol' : 'ul'`），
  JSX 里的组件名保持大写以免被当成字符串标签。
- 产物：`client/index.js` 485,818 → 485,926 字节（+108，来自 JSX 编译后的辅助代码），契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0，真实 DSH 里六个页签都在。

## [0.5.2] — 2026-11-14

### 变更
- 客户端构建层接受 JSX：esbuild 以 `loader: 'jsx'` + `jsxFactory: 'h'` 编译拼接后的片段。产物契约不变——
  同一 esbuild 版本下，仅切换 loader 时 `client/index.js` 逐字节相同（485,801 字节）。
- `client/src/10-controls.js` 从 `h(...)` 迁移到 JSX（P2 第一步，issue #34）：markup、class 名、ARIA 属性、
  焦点行为与无障碍名全部保持原样，只改写法。
- `scripts/check-keys.mjs` 与 `scripts/render-check.mjs` 用同一套 esbuild 参数编译片段后再求值，否则 JSX
  片段在 `new Function` 里会直接语法错误。
- 文档：`CONTRIBUTING.md` 与 `README.md` 说明片段可写 JSX 或 `h(...)`，可以按文件逐个迁移。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段，485,818 字节）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。

## [0.5.1] — 2026-11-14

### 修复
- 测试里不再出现真实的自建 GitLab 主机名（`lib/live/executor.test.js:298` 的 push-option 断言改用
  `gitlab.example.com`），发布前把内部域名从公开仓库里清掉；断言的行为不变。

### 验证
- `node --test lib/live/executor.test.js` 通过；全量 555 pass / 0 fail。

## [0.5.0] — 2026-11-14

开源首发版本：把 0.4.39（开源准备 P0）与 0.4.40（客户端构建层 P1）合进一个可以对外发布的版本。
功能行为与 0.4.38 一致，变化都在工程与文档层。

### 内容
- 仓库可被外部贡献：MIT LICENSE、GitHub Actions CI（Node 22/24，五道门）、`CONTRIBUTING.md`、行为准则、
  安全策略与威胁模型、issue 表单与 PR 模板、`docs/delivery.md` 交付流程。
- 干净 clone 可自查：`jsdom`/`react`/`react-dom` 进 `devDependencies`（精确版本 + lockfile），渲染回归
  内置 fixture，194 项检查在无任何本地状态时也能跑通。
- 客户端构建层换成 esbuild：仍按文件名拼接进同一个工厂作用域，产物压缩到 486 KB 并附 sourcemap，
  `--check` 逐字节校验产物与 map。
- 基线 Node.js 22；`testConfig` 的 Node 检查、`engines`、CI 矩阵与文档统一。

### 验证
- `node scripts/build-client.mjs --check`、`node --check index.js`、`node scripts/check-keys.mjs`、
  Host 测试 555 pass / 0 fail、`node scripts/render-check.mjs` 194 checks / 0 fail / 0 skipped。
- 以上在干净 clone（`npm ci`）与 GitHub Actions（node 22、node 24）上各跑过一遍。

## [0.4.40] — 2026-11-14

开源准备（P1）：客户端构建层从"手写拼接"换成 esbuild 压缩，产物契约与运行时行为都不变。

### 内容
- `scripts/build-client.mjs` 仍按文件名排序拼接 `client/src/*.js`、仍在同一个工厂作用域里包
  `window.__ModuleLoader__.load`，但拼接结果交给 esbuild `transform`（不是 `bundle`）压缩：
  `require('react')` 保持为 loader 调用，React 不进入产物。
- 产物从 782,094 字节降到 485,801 字节（`client/index.js`），并生成 `client/index.js.map`（映射回片段源码）。
  `--check` 现在逐字节校验**两个**文件，读产物的人可以先看 `client/src`，必要时用 map 对齐。
- `esbuild@0.28.2` 精确锁定在 `devDependencies`：换版本会改变压缩字节，必须与重新生成的产物同一次提交。
- 文档同步：README 的目录树与开发命令、CONTRIBUTING 的产物契约说明；`package.json` 的 `files` 增加 map。

### 验证
- 干净状态目录：`node scripts/render-check.mjs` 194 checks / 0 fail / 0 skipped（压缩后的产物照常挂载）。
- `npm ci` 干净 clone 上 `node scripts/build-client.mjs --check` 逐字节一致；Host 测试 555 pass / 0 fail；
  `node --check client/index.js` 通过；`scripts/check-keys.mjs` 不变。

## [0.4.39] — 2026-11-14

开源准备（P0）：让一个干净 clone 能自查、能被外部贡献者读懂，并把仓库里的"内部习惯"与"外部契约"分开。
功能行为不变，所有改动都在构建、测试与文档层。

### 内容
- 新增 `LICENSE`（MIT）与 `.github/workflows/ci.yml`：Node 22/24 矩阵，`npm ci` 后跑 Host 语法、产物一致性、
  双语 key、Host 测试与渲染回归五道门。
- 渲染回归不再依赖 `/tmp/sa-harness`：`jsdom`/`react`/`react-dom` 改为 `devDependencies`（精确版本）并提交
  `package-lock.json`；`scripts/render-check.mjs` 缺依赖时提示 `npm ci` 并以 2 退出。
- 新增 `test/fixtures/live.json` 与渲染回归的内置 fixture：状态目录里没有 `live.json` 时自动在临时目录搭建
  一套演示状态（2 个仓库、2 个监听群、四条演示工单、一条接单历史），干净 clone 上不再是 172 检查 + 18 跳过。
- 新增 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、issue 表单与 PR 模板；交付桥与发布流程拆到
  `docs/delivery.md`，`AGENTS.md` 只留指向与 Agent 硬线。
- CI 基线定为 Node 22/24：`testConfig` 的 Node 检查要求 major ≥ 22，Node 20 已 EOL，降到 20 只会制造
  声明与实现不一致。
- 历史快照同一毫秒内写入时排序不稳定（`listLiveConfigHistory` 只按 `at` 排），文件名里的序号现作为二级排序键。
- 首次在 Linux/UTC 上跑 CI 暴露的三处测试问题（生产代码未改）：`lib/live/api.test.js` 的搜索用例被写进了
  status 用例体内（子测试抢跑导致偶发 cancelled），已移回顶层；`lib/live/gitlab.test.js` 的超时用例只剩
  `AbortSignal.timeout` 的 unref 定时器撑着事件循环，补了一个 ref 定时器；`lib/live/schedule.test.js` 的
  `nextDailyAt` 断言写死 `+08:00`，在 UTC runner 上必然失败，改为按时钟本地构造。
- 文档卫生：README 去掉写死的 `0.4.31`，改为 CHANGELOG/Releases 入口并加 CI/License/Node 徽章；开发验证一节
  改为从 `npm ci` 开始、写明前七条可在干净 clone/CI 上跑、后两条需桌面 DSH + Chrome；`docs/self-development.md`
  去掉本机绝对路径与内部仓库名；`engines.node` 提到 `>= 22`（与 `testConfig` 的 Node 检查、CI 矩阵一致）；`package.json` 补 `repository`/`homepage`/`bugs`。

### 验证
- 干净状态目录（`DSH_SUPERAGENT_STATE_DIR` 指向空目录）：`node scripts/render-check.mjs` 194 checks / 0 fail /
  0 skipped；操作者真实状态目录同样 194 / 0 / 0。
- `node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`、
  `node --test lib/store.test.js lib/live/*.test.js`（555 pass）全部通过；本地与 `TZ=UTC` 两种时区各跑一遍。
- GitHub Actions：PR #29 上 node 20/22 两条 job 全绿。

## [0.4.38] — 2026-11-13

按 `/impeccable audit`（对着 DESIGN.md 契约跑的 16/20 审计）逐条修复。核心一条是 token 语义错用：`--dsw-alias-bg-overlay`
是叠加用的薄染层，深色主题下解析成 `#61666b`，菜单/弹窗的二次文本只有 3.85:1。

### 内容
- 新增 `--sa-surface-raised`（= `var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-overlay))`），`.sa-menu-pop` 与
  `.sa-modal` 改用它。深色下弹窗描述 3.85 → 8.03:1、菜单说明 3.27 → 6.83:1，浅色下底变纯白。
- `.sa-info`（16px）与 `.sa-sender-remove`（约 8×12）加 24×24 的居中命中盒（`::before`），图形尺寸不变，满足 2.5.8。
- `.sa-sender-remove:focus-visible` 的圆角从 2px 改回 `--sa-r-sm`（检测器唯一命中的越界刻度）。
- 禁用态不透明度 0.4 → 0.55（按钮、图标按钮、分段控件），文字不再"消失"。
- `.sa-modal:focus-visible` 补焦点环：弹窗接管焦点时键盘用户仍能看到落点。
- `DESIGN.md`：Neutral 一节把 Overlay 改述为"薄染层"、新增 Raised 一节；Modal 组件绑定 `surface-raised`；
  `.impeccable/design.json` 同步。

### 验证
- 隔离 DSH web 实例（真实工单数据）实测：浅色菜单底 `#fff`、说明 5.50:1；切深色后底 `#353638`、说明 6.83:1、
  弹窗描述 8.03:1；`.sa-info` 与 sender chip 的 × 在 ±11px 处仍命中；390 / 600 / 760 三档容器无横向溢出。
- `node --check index.js`、`build-client --check`（22 fragments，11682 行）、`check-keys`（967/513/1359）、
  `node --test`（555 pass）、`render-check`（194 checks / 0 fail）。

## [0.4.37] — 2026-11-13

真浏览器点检（隔离 DSH web 实例 + 真实工单数据）发现的漏项：触发页的三个筛选分段把「条数」只写在 `title`
里，键盘与读屏都拿不到（WIG A3 同类问题在 0.4.36 清扫时漏掉了这一处）。

### 内容
- `SegmentedControl` 支持 `option.description`，渲染为按钮内的 `.sa-sr-only` 文案，因此可访问名变成
  「已订阅 4 条」；`45-trigger.js` 的三个筛选项同时传 `title`（悬停仍显示）与 `description`（读屏/语音输入可见）。
- 其余 0.4.36 改动在真机同路径点检中表现正常（见 `verification/ui-review-team.md` 的「真机点检」一节）。

### 验证
- `node scripts/build-client.mjs`（22 fragments，11672 行）、`node scripts/check-keys.mjs`（967 literal / 513 shared /
  1359 page-local）、`node --test lib/store.test.js lib/live/*.test.js`（555 pass）、`node scripts/render-check.mjs` 全绿；
  隔离实例里重载后 `.sa-segment` 的可访问名已含条数。

## [0.4.36] — 2026-11-13

按 Web Interface Guidelines 全渲染层审查（89 条）与 CSS 设计审查（14 条）逐条修复；不改变页面信息架构，只修
语义、键盘路径、对比度与 token 契约。

### 内容
- 组件层：`Input` 的 `label` 真正成为可访问名（不再泄漏成 DOM 属性）并默认 `spellCheck=false`；`Switch` 换成
  `<input role="switch">` + 可见 track（调用方用 `<label>` 包裹文案，整行可点）；`DisclosureRow` 改成真 `<button>`；
  `CopyButton` 用 `role=status` 播报「已复制」；`ConfirmButton` 支持动作级 `confirmLabel`；`MarkdownLite` 输出真
  h3–h6（`07-md.js` 保留 heading 级别）。
- 对比度/token：修掉不存在的 `--sa-radius-8`、`--dsw-alias-border-secondary`、`--dsw-alias-bg-secondary`、
  `--dsw-alias-label-error`；toast/tooltip 改用 `--dsw-alias-toast-label`/`--dsw-alias-tooltip-label`；状态文本统一
  走 `--sa-danger-text`/`--sa-warn-text`/`--sa-success-text`/`--sa-label-tertiary`。
- 焦点与键盘：菜单项、输入框、`.sa-scroll` 都有可见焦点环；列表/队列/收件箱的行点击改成行内真按钮（`.sa-row-open`），
  鼠标仍整行可点；消息列表加 roving tabindex + ↑/↓/Home/End。
- 深链：路由（含 `stage`/`group`/`focus` 等视图内选择）写入自身 `#sa=` 片段并可在冷启动恢复，sessionStorage 仍是
  兜底；宿主 URL 不属于本插件时不读不写。
- 语义与播报：搜索面板改成 `role=search` 表单并播报结果数；异步结果（列表刷新、保存、复制、建单、评测）统一
  `role=status`/`aria-busy`；`data-empty` 写到计数元素，配合 `.sa-count` 的尺寸契约。
- 文案与校验：破坏性操作使用动作级确认文案；设置页数字/时间/必填字段有字段级错误与 `aria-invalid`；设置草稿存入
  sessionStorage 并在离开前提示；`title` 不再作为唯一信息来源（改用可见提示或 focusable InfoTip）。
- 样式细节：行高收敛到 1/1.35/1.4/1.5，列表分隔线上下对称，sticky 偏移统一 `--sa-sticky-top`，删除死规则
  （`.sa-cards`/`.sa-grid2`/`.sa-grid3`/`.sa-chip-count[data-zero]`），补 `overscroll-behavior`、
  `touch-action`、`text-wrap: balance` 与 `prefers-reduced-motion`。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 11670 行）；`node scripts/check-keys.mjs`
（967 literal / 513 shared / 1359 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（555 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过）。审查清单与逐条状态见 `verification/ui-review-team.md`。

## [0.4.35] — 2026-11-13

收口 0.4.34 遗留的运行质量口径、事件队列 ack/cursor、持久化掉电与证据排序问题。

### 内容
- 运行质量：24 小时失败数改为按 `runCategoryOf` 分类（`stopReason` 的 gate_failed/worker_failed 等与遗留
  `status=failed` 同口径），不再只数 `status === 'failed'`。
- 事件队列：只 ack 已处理（接单/忽略/跳过/指令消费）的事件；处理失败的事件留在队列并保持原 cursor；
  UUID 形式的 `eventId` 会 ack 但不再把数字 cursor 归零（`Math.max(cursor, NaN)`）。
- 持久化：新增 `lib/live/durable.js`，所有 temp+rename 写入在 rename 前 fsync 临时文件；掉电时不再可能留下
  0 字节的 `live-state.json`/`acceptance.json`/`operations.json` 等。
- 证据：人工决策（采纳/拒绝/覆盖）只推进 `updatedAt`，交付轮次的 `at` 不变，证据列表按最近处理排序。
- 并发：`verifyTicket` 与 `refreshTicketCi` 也纳入工单锁，避免与执行/发布/回答重叠改同一张工单。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 10854 行）；`node scripts/check-keys.mjs`
（938 literal / 513 shared / 1304 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（555 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过）。

## [0.4.34] — 2026-11-13

按代码评审与实机点击评审收口：修掉 URL 注入、干跑消费上下文、发布/回答的并发与干跑语义，补齐实机暴露的
i18n 与状态文案问题；数据加载不再把权限错误当成空状态。

### 内容
- 安全：`ExternalLink` 只接受 http(s) URL，其余渲染为纯文本；Markdown 链接沿用原有 http(s) 白名单。
- 干跑：`pollSync`/`pollEvents` 的 `attachContext` 移到 dry-run 返回之后，且只对会入库的仓库执行；实机干跑不再
  在内存里消费 contextOnly 决策。
- 执行器：`executeTicket/publishTicket/answerTicket/resumeTicket/resumeInterruptedTicket` 共用进程内工单锁
  （重复调用报 `already busy`）；`publishTicket` 只接受 ready/failed/pushed；回答追问沿用原 run 的 dryRun；
  发布修复只对 `onFail=auto_repair` 的闸门生效；去掉重复的 stop 清理；CLI worker 接收 `AbortSignal`，停止会
  立即终止 CLI 进程组；采用已合并 MR 时不再把工单回退成 ci-pending/mr-open。
- 数据：`live-state/inbox/signals/operations/acceptance/store` 只在 ENOENT 时按空状态初始化，EACCES/EIO 直接
  抛错；`live-json` 写入遇到损坏配置拒绝覆盖并提示；新增仓库不再硬编码 `createMr:api`，并拒绝重复本地路径。
- Host：同源判断比较 host（HTTPS/反代可用）；非法 URL 编码返回 400；`normalizeRepo` 容忍不完整 base。
- 视图：`signalsView`/`decisionsView` 每次请求只读一次配置；无仓库时 `verifySeconds` 为 null；`requestStop` 走
  `atomic()` 队列；标题上限 64→160。
- 客户端：修复重复 `src.signalReason`（原因列显示“按原因筛选”）；补齐 8 个 `repos.*` 文案；仓库卡片改为
  “执行器未启用”；暂停时概览不再说“等待群消息”；“查看已处理工单”带 `stage=done`；评估筛选空态提供清除筛选；
  已合并工单不再显示“已推送，等待创建 PR”；信号标题不再被 300px 截断。
- 工具：`check-keys` 支持三元表达式取 key，并检测重复 PAGE_TEXT key。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 10854 行）；`node scripts/check-keys.mjs`
（938 literal / 513 shared / 1304 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（551 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过）。

## [0.4.33] — 2026-11-13

落地产品评审六项改进（AC-01…AC-12）并按七轮独立验收返工收口：路由贯穿分阶段执行、停止真正取消 worker 与
CLI 进程组、恢复时对远端推送对账、评测与来源深链可回溯、证据与部署判定可复核、仓库与闸门可直接在设置页编辑。

### 内容
- 路由：`lib/live/routing.js` 与 `executor.js` 的 staged 分支按 `routeBackend`/`routeProfile` 选择实现后端与只读/
  可写 profile，人工选择不可用时原样报 `unsupported`；设置页展示路由预览（交付类型、后端、是否自动、改动范围）。
- 停止：`requestStop` 对 queued 工单立即结束排队；executor 每步检查 `ticket.stop`，worker 通过 `AbortSignal` 取消
  宿主 agent，CLI 以进程组 SIGTERM→3s SIGKILL 升级；停止的 run 可恢复。
- 推送/部署：`publishTicket` 先持久化推送请求再执行，未知结果按远端分支与 MR 对账；部署判定按记录的 SHA 比较，
  不用最新流水线代替目标 commit。
- 证据与评测：gate 记录 `at` 时间戳，reused 判定生效；证据包补齐被截断标记与 `deployCommit`；评测搜索覆盖
  `candidate.text`/`payload.text`；来源与评估记录深链到具体 id；URL 恢复保留视图、页码与滚动位置。
- 设置页：仓库对象中的闸门（名称、命令、目录、超时、失败策略、干跑命令）按完整对象编辑与保存，保存后刷新
  不回退；`POST engine/repo/:id` 与 `POST engine/config/test` 补 API 测试；live-json 的 `onFail` 补断言。
- 文档：README、`docs/self-development.md`、`docs/feature-maturity.md` 与实际测试数、停止能力对齐。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 10826 行）；`node scripts/check-keys.mjs`
（882 literal / 513 shared / 1295 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（541 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过，含仓库闸门保存后刷新的回归断言）。

## [0.4.32] — 2026-11-13

Claude 验收报 `Unexpected end of JSON input`：不是模型没答，是读不到答案。`runProcess` 的 stdout 上限 8 MB 在
达上限后丢弃**新到的** chunk，而 Claude stream-json 每个 thinking token 就产出一条 `thinking_tokens` 事件
（实测约 320 B/token，一次 1 万 token 的思考就有 3.5 MB），真实验收一越过 8 MB，最后那条含 verdict 的 `result`
就被丢掉，解析器只能拿到空字符串，`JSON.parse('')` 便报这个错。stage 里还留着 sessionId，正是「CLI 跑了、
只是尾巴没了」的证据。

### 内容
- `lib/live/worker-cli.js`：`runProcess` 达上限后**保留尾部**（`stdout = stdout.slice(-maxStdout)`），并支持
  注入 `maxStdout` 便于测试；`parseClaudeStream` 在 `result` 文本缺失时回落到 `structured_output`
  （`--json-schema` 的正式载荷）；CLI 退出 0 但没有任何结果文本时，错误改为
  `claude CLI returned no result text (stdout N bytes): …` 并带 stderr/stdout 尾部，不再让 JSON.parse 报误导性错误。
- 测试：`runProcess keeps the stream tail when the stdout cap is reached`、`a CLI that exits 0 without result
  text is reported instead of failing JSON parse`、`Claude structured output is used when the result event carries
  no text`。
- `package.json` 0.4.32。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`；`node scripts/check-keys.mjs`；
`node --test lib/store.test.js lib/live/*.test.js`（449 通过 0 失败）。

## [0.4.31] — 2026-11-13

独立验收现在可以选 DSH（独立只读会话），Claude 验收拿到 JSON schema，DSH 验收在 DeepSeek 路由上真正开
JSON Output。上一版把「DSH 没有验收入口」当成「DSH 不支持结构化输出」，这是错的：DSH 只是没有把
DeepSeek 的 `response_format` 接进评审请求，而 Claude Code CLI 2.1 早已支持 `--json-schema`（此前只给
codex 传了 `--output-schema`）。

### 内容
- `lib/live/worker-cli.js`：Claude 评审把 schema 文件内容以 `--json-schema <json>` 传给 CLI（不是路径），
  与 codex 的 `--output-schema` 对齐；repro：`claude --help` 的 "JSON Schema for structured output"。
- `lib/live/workflow-worker.js`：评审提示词追加固定标记 `Return only a json object with keys: verdict,
  findings, evidence.`（同时满足 DeepSeek JSON 模式「prompt 必须含 json」的要求）；DSH 评审调用带
  `readOnly: true`（实现轮仍可写）；新增 `parseStageResult()`，容忍 ```json 围栏与前后缀文字，解析失败才抛错。
- 新增 `lib/live/review-json.js`：`deepseekLlmApiExtensions.register('response_format', provider)`，仅当请求体
  含评审标记、且（无工具或已见过 tool 结果）时注入 `{type:'json_object'}`——首轮探索保持自由输出，避免
  JSON 模式打断读代码；宿主没有该扩展注册表时静默跳过，评审退回自由 JSON。
- `lib/live/config.js` / `lib/live/live-json.js`：`executor.reviewer` 白名单加入 `dsh`（错误文案改为
  `must be "codex", "claude" or "dsh"`）；设置 → Worker 的「独立验收后端」出现 DSH，选项仍跟随启用后端过滤。
- `index.js`：插件挂载时注册 JSON mode，失败只记 debug 日志。
- 测试：`review-json.test.js`（标记门控、工具结果门控、注册/降级）、`worker-cli` 的 `--json-schema` 断言、
  live-json/config 的 dsh 白名单、执行器 `a DSH reviewer runs read-only and its fenced JSON verdict parses`。
- `package.json` 0.4.31；`client/index.js` 重建（22 fragments，9828 行）。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（最新）；
`node scripts/check-keys.mjs`（775 literal / 513 shared / 1157 page-local）；
`node --test lib/store.test.js lib/live/*.test.js`（446 通过 0 失败）；`node scripts/render-check.mjs`（exit 0）。

## [0.4.30] — 2026-11-13

修掉三件事：设置页保存返工预算报 `unsupported setting: executor.maxRepairRounds`；独立验收后端不能切到 Claude；
DSH worker 无法按仓库指定 Agent 预设。

根因：`lib/live/live-json.js` 的 FIELDS 白名单漏了 `executor.maxRepairRounds`（设置页能显示、保存被拒）；
`workflow-worker.js` 把验收后端硬编码为 `config.executor.reviewer ?? 'codex'`，且该配置项既不在白名单也不在 UI；
`worker.js` 一律 `presets.resolve()` 跟随宿主默认预设，没有按仓库覆盖的入口。

### 内容
- `lib/live/live-json.js`：FIELDS 增加 `executor.maxRepairRounds`（整数 0..6）、`executor.reviewer`（codex|claude）、
  `executor.workerPreset`（单行）；对应校验错误文案。保存设置不再报 unsupported setting。
- `lib/live/config.js`：executor 归一化 reviewer（仅 codex/claude，dsh 不能当 reviewer）与 workerPreset（trim、拒换行）。
- `lib/live/repos.js`：仓库项支持可选 `reviewer` 与 `workerPreset`（缺省回落到 executor 级配置）。
- `lib/live/worker.js`：`runWorker({ preset })` 显式解析预设，解析不到时记录一次并回落到宿主默认，不中断运行。
- `lib/live/executor.js`：`workerPreset = repo.workerPreset ?? config.executor.workerPreset` 传给进程内 DSH worker
  （分阶段与经典路径都传）；`executeWorkflow` 新增 `reviewer = repo.reviewer ?? config.executor.reviewer`。
- `lib/live/workflow-worker.js`：验收/规划后端取 `reviewerOverride ?? config.executor.reviewer ?? 'codex'`，
  实现仍走 `implementer`；启停检查同时看两个后端。
- `lib/live/worker-cli.js`：Claude 的调用放开 Bash（只读 review 仍用 `plan` 权限模式，编辑被禁；实现轮用 `acceptEdits`），
  验收可以自己 `git diff`、跑测试，不再需要把 diff 塞进 prompt。
- 设置 → Worker「分阶段执行」新增「独立验收后端」（Codex / Claude Code）与「Worker 预设（DSH）」输入，
  每个控件都带可见标题（`sa-field-head`）；两个下拉的选项跟随「启用的后端」过滤，被关闭的后端不再出现
  （仅当它是已保存值时保留并标灰）；render-check 增加「控件必须有可见标签」「选项跟随启用后端」两条回归断言。
  patch 白名单同步加入两项。
- 测试：live-json 白名单/校验、config 解析、仓库 presets/reviewer、执行器按 `executor.reviewer` 选择 CLI 后端。
- `package.json` 0.4.30；`client/index.js` 重建（22 fragments，9814 行）。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments，最新）；
`node scripts/check-keys.mjs`（773 literal / 513 shared / 1157 page-local）；
`node --test lib/store.test.js lib/live/*.test.js`（442 通过 0 失败）；`node scripts/render-check.mjs`（exit 0，ok:true）。

## [0.4.29] — 2026-11-13

分阶段流程停下来时不再只报「workflow blocked: blocked」，返工预算真正生效并且可以在设置里调大后接着返工。
根因有三处：`runWorkflow` 达到返工上限时把 workflow 置为 blocked 但从不写原因，`executeWorkflow` 抛错时只能拿
`reason ?? status`，于是用户只看到 `blocked`；`executeWorkflow` 调用 `runWorkflow`/`resumeWorkflow` 时没有把
`config.executor.maxRepairRounds` 传进去，配置项只管到经典闸门自动修复，分阶段流程永远用默认 2；`workflowResumable`
只认「最后阶段 failed」，评审要求修改（completed + changes_requested）把预算用完时界面连「继续执行」都不给。

### 内容
- `lib/live/workflow.js`：`deliver` 内统一经 `blocked(reason, detail)` 停单，写 `state.reason` 与一行
  `state.detail`：规划遗留问题（带条数）、闸门失败（列出失败闸门）、review 明确 blocked、验收连续要求修改
  （`review still requested changes after N repair round(s) (M findings); raise executor.maxRepairRounds to keep repairing`）、
  候选在验收期间变化。导出 `blockedMessage(workflow)`；`resumeWorkflow` 在「最后是 completed changes_requested」时
  校验 key 里的 plan/gates/digest 与当前候选一致、预算尚有余额，然后 `repairs += 1` 并接回交付循环跑下一轮。
- `lib/live/workflow-worker.js`：`executeWorkflow` 把 `maxRepairRounds`（0–6，默认 2）传给两个入口；
  `assertResumable` 接受上述「验收要求修改」的停点，预算不足时报同一句可读原因；失败时抛
  `workflow blocked: ${blockedMessage(...)}`。
- `lib/live/executor.js`：`resumableWorkflowOf` 带上预算；`resumeInterruptedTicket` 无法续跑时返回
  `ticket … workflow blocked: <detail>`，不再只回 `has no interrupted run`。
- `lib/live/repos.js`：`workflowResumable(ticket, maxRepairs)` 对「验收要求修改」的停点按预算余额判定，
  `decorateTicket` 传入配置。
- `lib/live/config.js`：`executor.maxRepairRounds` 上限 3 → 6（0–6，默认 2；经典闸门自动修复仍按 1 起步、
  最多 3）。
- 设置 → 运行新增「返工预算」数字输入（0–6，默认 2，含校验与说明）；工单详情的 workflow 行显示停单 detail，
  「继续执行」确认文案覆盖「失败的一步」与「下一轮返工」两种续跑。
- `package.json` 0.4.29；`client/index.js` 重建（22 fragments，9800 行）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（770 literal / 513 shared / 1152 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：438 通过，0 失败。新增 8 条：各种停点都写原因与可读 detail；
  评审用尽预算后调大预算可续跑下一轮返工（阶段、repairs、verdict 序列）；候选变化拒绝续跑；`executeTicket` 在
  预算耗尽时给出可读错误、调大后只多跑一轮 implement + review 并交付；`resumeInterruptedTicket` 仍拒但带原因；
  配置 0–6 边界；`workflowResumable` 对 failed review / 预算余额 / 其它状态的判定。
- `node scripts/render-check.mjs`：通过（ok=true，0 失败）。

## [0.4.28] — 2026-11-13

分阶段执行失败后可以从失败的那一步继续，不再整条重跑。之前的「继续执行」只识别被插件重载中断的运行，
而分阶段流程的失败（例如 Codex 验收时额度用尽）是普通 failed run，界面只给「重试执行」，等于把已完成的分析、
实现和闸门全部重做。本单给失败的分阶段工单补上真正的断点续跑：沿用 `ticket.workflow` 里已完成的阶段，
只用失败阶段 key 里记录的输入重放该阶段，通过后照常提交、推送并按仓库策略交付。

### 内容
- `lib/live/workflow.js`：新增 `failedStageOf` 与 `resumeWorkflow`，交付循环抽成 `deliver`，支持带
  `pendingReview`（沿用已记录的 gates 证据与 digest）续跑 review；`makeStage` 复用同 key 的失败项原地重试，
  不再追加重复阶段。`RESUMABLE_ROLES = ['implement', 'review']`——评估/规划失败仍走整条重跑，闸门有既有
  的停单/重试路径。
- `lib/live/workflow-worker.js`：`executeWorkflow({ ..., resume })` 续跑时校验
  mode、requirementRevision、最后阶段为 failed 且 role 可续，然后采用 `ticket.workflow` 调用
  `resumeWorkflow`；digest 与验收证据不一致时拒绝续跑（`candidate changed since the gated review`）。
- `lib/live/executor.js`：`executeTicket({ ..., resumeWorkflow })` 传入续跑标记并记 `workflow:resume` 步骤；
  新增 `resumableWorkflowOf`，`resumeInterruptedTicket` 在没有 interrupted run 时改走
  `executeTicket({ trigger:'resume', resumeWorkflow:true })`，两者都没有仍返回 409。
- `lib/live/repos.js`：`workflowResumable(ticket)` 派生「failed + workflow blocked + 最后阶段 failed 且可续」，
  `decorateTicket` 以 `workflowResumable` 暴露给客户端（不持久化）。
- `client/src/58-ticket-detail.js` + i18n：失败且可续时主按钮改为「继续执行」，确认框说明只重跑失败的一步、
  已完成的分析/实现/闸门保留，「重试执行」仍在 ⋯ 菜单；新增 `detail.resumeWorkflowTitle/Confirm` 中英 key。
- `package.json` 0.4.28；`client/index.js` 重建（22 fragments，9772 行）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（767 literal / 513 shared / 1149 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：430 通过，0 失败。新增 5 条：review 续跑只重跑 review 且
  阶段台账原地复用；digest 变化拒绝续跑；implement 失败按记录的 plan/feedback 续跑；无失败阶段拒绝续跑；
  `executeTicket({ resumeWorkflow:true })` 在 planned 模式下只多调一次 review、implement 只跑一次、交付 dry-run，
  且新 run 继承闸门结果与实现摘要（续跑不会让运行记录变成空壳）。
- `node scripts/render-check.mjs`：通过（ok=true，0 失败）。

## [0.4.27] — 2026-11-12

新增可选分阶段 Worker：自动复杂度评估，或直接选择简单/方案驱动执行。复杂流程由 Codex 规划、Claude/DSH 实现、程序闸门、全新 Codex 会话验收组成，支持最多两轮返工与方案修订。默认关闭，保留现有路由行为。

- 新增 workflow/workflow-worker，结构化阶段结果写入台账与工单详情；Codex 使用 JSON Schema 输出。
- 候选指纹包括 HEAD、tracked diff 和未跟踪文件；验收中/发布前变更阻止交付；失败、禁用后端和无效验收结果不放行。
- 设置页新增执行流程与实现后端，live.json 白名单及归一化同步支持；客户端产物已构建。
- Host 425/425 通过；渲染检查通过；构建、i18n 与语法通过。隔离 DSH Host API 正常，但两次 Chrome 启动均未在 30 秒内暴露 CDP 端口，随后改用 ego lite，验证六个页面入口、Worker 控件保存与刷新持久化通过；发现并修复 settingsPatchOf 遗漏新字段，补对应渲染断言。
- 边界：未做真实 CLI 模型调用/远程交付；当前失败后重跑流程，精确阶段恢复、CLI 实时流和执行中自动升级尚未接入。详见 docs/staged-workers.md。

## [0.4.26] — 2026-11-12

移动端容器 500–600px 时，头部状态行与溢出菜单的触控区没有硬隔离：0.4.24 及更早版本里触发器是
`.sa-head-tools` 的最后一个子项，状态行排到内容右边缘后，40px 菜单点击区会压在「数据更新于 17:21」上；
0.4.25 已把触发器移进 `.sa-head-title`，状态行因此换到下一行，但工具行仍未给自己留出触发器列。本单补上
44px 右余量，并用回归断言锁住「触发器只在标题行」这一前提，即使以后两行再合并，状态文字也不会进入
40px 点击区。

### 内容
- `client/src/05-style.js`：`@container (max-width:600px)` 下 `.sa-head-tools` 增加
  `padding-right: calc(40px + var(--sa-sp-4))`，为标题行右端的 40px 溢出触发器保留 44px 列宽（触控目标 +
  间距）；601px 以上与桌面布局不受影响。
- `scripts/render-check.mjs`：新增 2 条断言——移动端溢出触发器必须位于 `.sa-head-title` 内且不在
  `.sa-head-tools` 内；600px 块的 `.sa-head-tools` 必须声明上述 44px 右余量。同时把「概览只有一条数据更新于」
  的文本断言收窄到列表行以外：本工单标题本身就引用了「数据更新于 17:21」，整页计数会把它误算成第二条状态行。
- `package.json` 0.4.26；`client/index.js` 重建（22 fragments，9730 行）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：418 通过，0 失败
- `node scripts/render-check.mjs`：148/148 通过，0 SKIP
- `node scripts/isolated-verify.mjs`：由执行器运行（本工作树不创建 `verification/` 产物）

## [0.4.25] — 2026-11-12

对超级智能体面板做了一轮 Impeccable 系统评分（Operate 模式；设计审查 + 1280/960/390 实机截图与
DOM/检测器证据），总分 33/40。评分暴露的是同一类问题：执行页的词汇在筛选片、分组标题、行标签和负载图例
之间各说各话；一个 40px 的移动端溢出菜单在标题下自成一行；工单头的验收跳转与主行动并排成两个「去验收」；
列头压在分组标题之上；四段负载条没有图例。本次把这几项落掉，不改 Host 契约。

### 系统评分
| 维度 | 分数 | 依据 |
|---|---|---|
| 系统状态可见 | 4/4 | 全局状态行、系统脉搏、执行器条都有实时值 |
| 贴合真实世界 | 3/4 | 词汇漂移：等待你 / 等待人 / 等待回答 |
| 用户控制与自由 | 4/4 | 确认、返回、Esc、菜单均可退出 |
| 一致性与标准 | 2/4 | 同页四种等待说法、列头位置、重复 CTA |
| 错误预防 | 4/4 | 暂停/重试/写操作均有确认与禁用态 |
| 识别而非记忆 | 3/4 | 图标按钮有 aria/title；负载条此前不可解码 |
| 灵活与高效 | 3/4 | Alt+1..6、Ctrl+K、筛选持久化 |
| 美学与极简 | 3/4 | 密度合理，但重复列头/空图例制造噪声 |
| 错误识别与恢复 | 4/4 | 失败原因、重试、not-found 空态完整 |
| 帮助与文档 | 3/4 | 术语表与页内提示齐全，缺 PRODUCT.md |

### 内容
- `client/src/58-ticket-detail.js`：`needsAcceptance` 时验收注记只保留「待你验收」文字，不再渲染第二个
  「去验收」跳转按钮；主行动本身已滚到 `#sa-acceptance`，两个同文案控件相邻会被读成重复操作。已验收/已打回
  仍保留「查看验收」跳转。
- `client/src/34-live-ui.js`、`client/src/55-execution.js`、`client/src/06-i18n.js`：统一执行页词汇为
  **排队 / 执行中 / 等你处理 / 失败 / 已结束**。分组标题、筛选片、`waiting_for_human` 行标签、负载图例使用
  同一组词；`awaiting-answer` 保留更具体的「等待回答」。`loadbarRunning` 由「运行中」改为「执行中」。
- `client/src/34-live-ui.js`、`client/src/55-execution.js`：队列列头只渲染一次，放进第一个分组 `Section`
  的标题之下（阶段分组、仓库分组、已忽略单组一致）；此前列头先于「等你处理 3」出现，读起来像页面级表头。
- `client/src/55-execution.js`：执行器负载条恢复图例（`ExecutorLoad` 默认 `labels=true`），四段颜色由同一组
  阶段词解码；零负载仍不画条。
- `client/src/30-shell.js`、`client/src/05-style.js`：移动端溢出菜单移入标题行（`.sa-head-title`）右端，
  标题格在 `@container (max-width:600px)` 下 `flex:1` 撑满，状态行因此整体换到下一行；菜单不再在状态行后
  单独占一行，也不会压住状态文字，40px 触控目标保留。`@container (max-width:760px)` 下
  `最近一次执行` 左对齐，换行后不再右飘。
- `scripts/render-check.mjs`：新增 3 条断言——工单头只有一个「去验收」、列头位于分组标题之后、负载条图例
  含四个阶段词；阶段词断言同步为新词汇。
- `package.json` 0.4.25；`client/index.js` 重建（22 fragments，9726 行）。

### 未落地（记录，不在本单）
- 评估页 39 条记录整页铺开（约 3390px），无分页/搜索；属于日志页信息架构改动，另开。
- 概览「策略规则」胶囊是只读 `Tag`，与状态标签同一惯用法；不改交互外观以免制造假按钮。
- 全局搜索遮罩使用宿主 `--dsw-alias-bg-mask-1`（24% 黑），实测像素 194 vs 255，遮罩有效，不改。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：418 通过，0 失败
- `node scripts/render-check.mjs`：147/147 通过，0 SKIP
- `node scripts/isolated-verify.mjs`：PASS（6 个 tab，0 console error；用 `CHROME_PATH` 包装脚本补
  `--no-sandbox --disable-crashpad`，否则本会话沙箱下 Chrome 在 `Runtime.enable` 超时）

## [0.4.24] — 2026-11-12

群回复「接单 A7K2」用于人工推翻模型否决时，replay 会按规则重新判定并建单，但这条路径此前只建单、不执行
（`outcome.started=false`），群回复固定为「已建单」；即使 `executor.enabled=true`，操作人还得再到面板点一次
执行，与「接单即执行」的语义不一致，也和已排队工单被接单时的行为不一致。规则重放本身只走规则（高风险硬闸门
仍然生效，规则判定 ignore 时不建单），因此启用执行器时应在 replay 建单成功后立即 autoExecute，并把群回复
改成「已开始执行」。

### 内容
- `lib/live/engine.js`：`applyReviewAnswer` 的 replay 分支在建单成功后，若工单仍为 `queued`/`ready` 且
  `executor.enabled === true`，置 `outcome.started = true` 并调用 `autoExecute([replay.ticket.id])`；与
  「已排队工单被接单」路径一致，闸门是 `executor.enabled` 而不是 `autoRun`（`autoRun` 只控制新工单的自动派发）。
  规则判定高风险时仍是 `blocked: 'high-risk'`，不建单也不执行。
- `lib/live/engine.test.js`：新增 2 个用例——(a) 模型否决的评估收到「接单」后 replay 建单并立即执行（即使
  `autoRun=false`），群回复是「已开始执行」、`review.outcome.kind = 'started'`；(b) 规则硬拦的高风险信号即使
  回复「接单」也不建单、不执行，回复仍是「规则判定高风险」。原「replay 建单」用例继续覆盖
  `executor.enabled=false` 时只建单（`已建单`）。
- `docs/intake-and-eval.md`：复查动作表补充「`executor.enabled=true` 时同时立即执行」。
- `package.json` 版本 0.4.22 → 0.4.24（本工单开工后 `develop` 已由空闲看门狗工单升到 0.4.23）；`client/index.js`
  无变化（未改客户端源码）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：418 通过，0 失败（0.4.24 新增 2 例、0.4.23 新增 3 例）
- `node scripts/render-check.mjs`：143/143 通过（`ok: true`，0 SKIP）
- `node scripts/isolated-verify.mjs`：PASS（6 个 tab、0 console error）。本会话的 DSH 文件沙箱会挡住 Chrome 自带沙箱，裸跑在 `Runtime.enable` 超时；用 `CHROME_PATH` 指向补 `--no-sandbox` 的临时包装脚本后通过

## [0.4.23] — 2026-11-12

空闲看门狗只看 session 事件：`tool/call` 之后到 `tool/result` 之前没有任何事件，长 bash（如连续 12 次 render-check，约 5–6 分钟）必然超过 `workerIdleTimeoutMs`（默认 300000），worker 仍在跑却被判 `worker_lost` 并 cancel。本次让在途工具调用成为看门狗的活动窗口。

### 内容
- `lib/live/worker.js`：`runWorker` 新增 `pendingTools`（`callId` → 调用名与自身超时截止时间）。`tool/call` 到达时按 `callId`（兼容 `toolCallId`、`message.toolCallId`）登记，并解析该工具声明的 `timeoutMs`（bash 工具自身的执行上界）+ 15s 结果投递宽限作为截止时间；`tool/result`（兼容旧 `tool/end`）按同一 `callId` 释放。
- 空闲检查发现存在未过期的在途调用时只重新武装计时器，不再触发 `worker_lost`；全部在途调用都超过各自声明的超时后才以 `worker tool timeout` cancel 并记为 `worker_lost`。未声明超时的工具不设截止时间，由整体 worker 超时兜底，避免永不返回的工具无限等待。
- `session/disposed` / `agent/disposed` 立即失败路径保持不变；`idleTimeoutMs` 语义与 `live.json` 的 `workerIdleTimeoutMs` 配置不变。
- 测试：新增 3 个用例——(a) 只有 `tool/call`、静默跨过多个空闲窗口仍不判 `worker_lost`；(b) 同一 `callId` 的 `tool/result` 之后继续静默超过 `idleTimeoutMs` 仍判 `worker_lost`；(c) 其它 `callId` 的 result 不会释放在途调用。
- `package.json` 版本 0.4.22 → 0.4.23；`client/index.js` 无变化。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：416 通过，0 失败（`worker.test.js` 新增 3 例通过）
- `node scripts/render-check.mjs`：143/143 通过，0 SKIP（首跑 1 例共享 harness 抖动，连续重跑全过）
- `node scripts/isolated-verify.mjs`：PASS（6 个 tab、0 console error）。本会话的 DSH 文件沙箱会挡住 Chrome 自带沙箱，裸跑两次在 `Runtime.enable` 超时；用 `CHROME_PATH` 指向临时包装脚本补 `--no-sandbox` 后通过

## [0.4.22] — 2026-11-12

本机安装态已切换为 `main` 分支打包产物：桌面 profile 的依赖是 `file:<tarball>`，`node_modules/@mystic7c/dsh-superagent-panel` 是 tarball 解包后的实体目录。但 `docs/self-development.md`、`AGENTS.md` 仍描述旧的 stable clone + `link:` 模型，且每次切换/回滚都要手工提取 tarball、改 profile manifest。本次把文档统一到打包模型，并新增可重复的本地打包安装脚本。

### 内容
- `docs/self-development.md`：`## 本机稳定安装（与开发仓库分离）` 改为 `## 本机安装（main 打包产物）`，写明 profile dependency 为 `file:<tarball 绝对路径>`、包目录是实体目录、升级必须显式安装新 tarball 再重载插件、stable clone 不再是安装源（仅作回滚参考）；新增「本地打包与安装」bash 示例（`git switch main` + `npm pack --pack-destination ../releases`、备份 `package.json`、删除旧目录/链接、`tar --strip-components=1` 解包、dependency 改 `file:<绝对路径>`、插件管理重载 + 刷新页面）；新增「升级边界」小节（develop 工单与 6 个闸门只作用于 `~/.dsh/superagent/worktrees`、安装态只有显式安装才更新、回滚用 `package.json.bak-local-install-*` 与旧 tarball）；分支策略、自开发流程、常见坑中关于安装/升级的措辞同步为打包模型，隔离验证的临时 `link:` profile 明确标注仅用于该闸门
- `scripts/local-install.mjs`（新增，Node 18+ ESM）：`--tarball <path>`（默认仓库同级 `releases/` 下当前版本的 `.tgz`）、`--profile-dir <path>`（默认 `$DSH_HOME/profiles/desktop`）、`--dry-run`、`--verify`、`--allow-branch`；非 dry-run 校验 `main` 分支、工作树干净、tarball 内 `name`/`version` 与仓库一致、profile 存在；备份 `package.json` 为 `package.json.bak-local-install-<时间戳>`，删除旧包目录或 symlink，解包到 `profile/node_modules/@mystic7c/dsh-superagent-panel`，dependency 改为 `file:<tarball 绝对路径>`；只写 profile 目录，不调用面板、不重启 DSH、不改 `live.json`，失败保留备份并清理解包临时目录
- `AGENTS.md`：`scripts/` 结构行补 `local-install.mjs`；发布交付语义改为显式安装 `main` tarball（stable clone 仅回滚参考）
- `package.json` 版本 0.4.21 → 0.4.22

### 验证
- `node --check scripts/local-install.mjs`
- `node scripts/local-install.mjs --verify`：当前安装态是 `file:...0.4.21.tgz` + 实体目录 0.4.21，只读通过；仓库已升 0.4.22，脚本只提示需显式安装
- `node scripts/local-install.mjs --dry-run --tarball ...0.4.22.tgz`：打印计划；profile `package.json` 哈希与 mtime 不变、无临时目录残留
- 临时仓库 + 临时 profile 端到端：默认从 `../releases` 发现 tarball、备份、删除旧 symlink、解包实体目录 0.4.22、改写 dependency，重跑 `--verify` 通过；`--allow-branch` 在 `feature/x` 上按预期放宽
- 6 个闸门：`node --check index.js`、`node scripts/build-client.mjs --check`（22 fragments）、`node scripts/check-keys.mjs`（760/513/1134）、`node --test lib/store.test.js lib/live/*.test.js`（413/413）、`node scripts/render-check.mjs`（143/143、0 SKIP）、`node scripts/isolated-verify.mjs` PASS（本 worker 沙箱内 Chrome 需经 `CHROME_PATH` 包装脚本补 `--no-sandbox` 才能初始化，面板 6 tab、0 console error）

## [0.4.21] — 2026-11-12

工单 tkt_16e724f48ddd41b0 的交付收尾。GitHub 仓库 `createMr: "push"` 的工单交付后，详情卡片的 MR 区显示
「还没有合并请求」，但同一张工单的合并状态又显示「已合入目标分支」。根因是 push 模式只把
`links.mergeRequest.webUrl`（`/pull/new/` 链接）落库，不写 `iid`；卡片与列表的 `hasMr` 只看 `iid`，于是把
「有链接」当成「没有 MR」。同时 `acceptTicket` 的 cleanup 只删本地 worktree 与本地分支，远程
`feature/<ticketId>` 一直留在 origin。本次让 webUrl 也算 MR 证据，并在 merged 工单验收后 best-effort
删除远程 feature 分支。

### 内容
- `client/src/34-live-ui.js` / `client/src/58-ticket-detail.js`：`hasMr` 改为 `iid || webUrl`；push 模式（只有 webUrl）
  的 MR 卡片显示「MR 链接 → 打开 PR」，并提示该 PR 由推送后的 `.github/workflows/auto-pr.yml` 创建；
  `links.verification.merged === true` 时保留链接并显示「已合入目标分支」，不再落到「还没有合并请求」空状态；
  列表证据列与阶段链路同步显示「PR 已创建」；中英文案同步（`ticket.openPr`、`mr.pushHint`、`row.evidencePr`）
- `client/index.js`：按 `client/src` 重建（22 fragments）
- `lib/live/repo.js`：新增 `deleteRemoteBranch({ repo, branch, timeoutMs = 120_000 })`，执行
  `git push origin --delete <branch>`；分支已不存在按已删返回（`{ deleted: true, alreadyGone: true }`），受保护分支
  直接拒绝，其它失败抛 `RepoError('remote-delete-failed')`
- `lib/live/engine.js`：`acceptTicket` 的 cleanup 阶段，在 `links.verification.merged === true` 且分支以 `feature/`
  开头时调用 `deleteRemoteBranch`，结果写 `links.cleanup.remoteBranchDeleted`（或 `remoteBranchError`）；删除失败
  只告警，不影响验收；未合入、非 feature 分支、缺分支名时跳过
- `lib/live/repo.test.js`：新增 3 个用例（删除成功、分支已不存在按已删返回、远端失败保留 RepoError 且拒绝受保护分支）
- `lib/live/engine.test.js`：新增 4 个用例（merged 验收删远程并落盘、未 merged 不删、release/ 分支不删、
  删除失败不阻塞验收且写 `remoteBranchError`）
- `scripts/render-check.mjs`：新增仅 webUrl 的 push 模式 fixture，断言 MR 卡片出现「打开 PR」与 auto-pr 提示、
  不出现「还没有合并请求」、合入后仍显示「已合入目标分支」
- `package.json` 版本 0.4.20 → 0.4.21

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`（`client/index.js is up to date (22 fragments)`）
- `node scripts/check-keys.mjs`（760 literal keys / 513 shared keys / 1134 page-local keys）
- `node --test lib/store.test.js lib/live/*.test.js` 413/413（新增 7 个用例）
- `node scripts/render-check.mjs`：143/143 通过、0 SKIP，含 2 条 push-mode MR 卡片用例；连续重跑一致
- `node scripts/isolated-verify.mjs` PASS（6 个 tab、0 console error）
- 说明：worktree 起点早于 v0.4.20（Inlines 递归修复）与确定性 render fixture（PR #14），合并 `origin/develop`
  后按合并结果重跑以上检查；CHANGELOG 中 0.4.20 两条为 develop 已有历史

## [0.4.20] — 2026-11-12

render 闸门周期性假红，失败断言是「overview names the needs-you vs worth-a-look split when both are on screen」，
最近一次与代码改动无关（只改了 `lib/live/worker.js` 等 Host 半），同一版本人工复跑有时又通过。根因是
`scripts/render-check.mjs` 的 fixture 从操作者当时的 state 派生：Overview 的「值得留意」区块只在
`ovWatchItems` 推导出 watch 项时渲染（24h 内失败 run、失败后被忽略的工单、error source、轮询滞后），
`deskScope` 也随之消失；inbox 只有验收项、最近没有失败 run 时 watch 为空，断言必失败。metrics 路由的 stub 又把
`failed` 固定为 0，无法补上 watch 项。DSH_HOME 指向空目录时另有 19 处失败，因为来源页、仓库/UAT、评估与触发页
的断言依赖真实 live.json 与历史数据。

### 内容
- `scripts/render-check.mjs`：fixture 注入确定性的「值得留意」数据——一条 `status: 'failed'`、`startedAt`
  为当前时间前 45 分钟的演示 run（`ticketId` 复用 `tkt_demo_accept`，`error` 固定为「演示：闸门 standards
  未通过」），以及一张 `status: 'dismissed'` 且 `assignments[].report.state === 'failed'` 的演示工单
  `tkt_demo_dismissed`；只改内存中的 engine.state，不写真实 state
- `scripts/render-check.mjs`：把目标断言拆成两条——「值得留意」区块内至少一行且文案匹配
  `/过去 24 小时 \d+ 次执行失败/`；split note 必须同时包含「需要你处理 = 」与「无需你动作」。pulse 句断言不再
  依赖哪张执行中工单排在第一位（真实 state 里本 worker 的工单可能更新），改为校验「系统脉搏」/「在飞」/用时文案，
  并单独断言 fixture 的执行中工单出现在「正在执行」区块
- `scripts/render-check.mjs`：metrics stub 与注入的失败 run 对齐（`runs.failed = 1`、
  `stopReasons['gate-failed'] = 1`、`failureReasons` 一条），避免 quality 卡片显示 0 失败而 watch 显示 1 次失败
- `scripts/render-check.mjs`：新增 `skip(name, reason)` 机制，打印 `SKIP name — reason` 并在汇总 JSON 的
  `skipped` 中计数，SKIP 不计 FAIL、不影响退出码；依赖本机配置/历史的检查组（UAT 链接、来源页 3 条、ebs
  仓库选项、GitLab token 编辑器、评估页 7 条、触发/线程页 5 条）在配置或数据不可得时明确 SKIP
- `scripts/render-check.mjs`：取消「真实 state 已有待验收工单就跳过注入」的分支，演示验收工单始终注入；
  否则操作者 inbox 里另一张待验收工单会改变（甚至破坏）详情页走查打开的入口
- 不改 `client/src/35-overview.js` 的产品逻辑：`deskScope` 只在 watch 存在时渲染是正确的

### 验证
- 真实 state：`node scripts/render-check.mjs` exit 0，141 条检查全过、0 SKIP；连续 3 次结果一致（均 141/141）
- 空 state（`DSH_HOME` 指向新建临时空目录，stateDir 不存在）：exit 0，123 条通过 + 18 条 SKIP，0 FAIL；
  连续 3 次一致
- `node --check index.js`、`node scripts/build-client.mjs --check`（22 fragments，未改客户端）、
  `node scripts/check-keys.mjs`（756 literal / 513 shared / 1131 page-local）、
  `node --test lib/store.test.js lib/live/*.test.js`（406 通过）
- `node scripts/isolated-verify.mjs` PASS（概览/来源/触发/评估/执行/设置 6 个 tab、0 console error）。本会话的
  DSH 文件沙箱会挡住 Chrome 自带沙箱，裸跑两次都在 `Runtime.enable` 超时（最小 CDP 探针可复现）；本次用
  `CHROME_PATH` 指向加 `--no-sandbox` 的包装脚本跑通，脚本本身未改

## [0.4.20] — 2026-11-12

自开发状态里 threads 与 triggers 同时存在时，打开「触发」页会让渲染进程堆内存暴涨（render-check 可复现 OOM，
桌面 renderer 也被带崩重启）：`client/src/20-widgets.js` 的 `Inlines` 对 link/ref 的标签文本递归调用
`inlines()`，而裸 URL 的标签就是该 URL 本身，二次解析又得到同一个 link，于是无限递归创建 `<a>`。本次给嵌套
渲染加上一层深度上限，并补一条 render-check 回归探针（裸 URL 只产出一个链接、不再出现嵌套 `<a>`）。

### 内容
- `client/src/20-widgets.js`：`Inlines` 增加 `depth`；link/ref 的标签只在最外层再解析一次，嵌套层直接输出文本
  （裸 URL 的自链接不再递归，也不再产生 `<a>` 嵌套告警）
- `scripts/render-check.mjs`：新增回归探针「a bare URL renders as one link without recursing」，直接挂载
  `MarkdownLite` 验证裸 URL 只渲染一个链接；`MarkdownLite` 从客户端片段中导出仅用于该检查
- `client/index.js`：按新片段重建

## [0.4.19] — 2026-11-12

工单 tkt_ed2bb9e10a3b46e2 的 run_3953a38ea58c476a 在 prepare-worktree 之后卡在 worker 步骤：worker 没有产出报告，
run 一直保持 `working`，只能重载插件让 reconcile 把 run 标成 `interrupted` 再 `/resume`。根因是
`lib/live/worker.js` 的 `runWorker` 只靠 `ctx.on('session/event')` 的 `turn/end` 来 settle；worker 会话/代理在没有
`turn/end` 的情况下结束或事件流中断时，`done` 永远不 settle，run 只能等 `executor.timeoutMs`（默认 1_500_000ms）
超时才失败，期间工单一直 `working`、也无法重试。本次加空闲看门狗与宿主结束信号，并让 worker_lost 的失败可重试。

### 内容
- `lib/live/worker.js`：记录最近一次 worker 事件时间（`assistant/message`、`tool/call`、`tool/result`、`turn/end`、
  `error` 等 `session/event`）；新增 `idleTimeoutMs` 参数（默认 300_000，由 executor 从配置传入），超过该窗口没有
  新事件时调用 `handle.agent.cancel?.('worker idle timeout')` 并返回 `{ error: 'worker_lost', timedOut: false }`，
  `events` 里追加一条 `error` / state `worker_lost` 的终止事件；同时监听 `session/disposed` 与 `agent/disposed`
  （`{ agent }`），worker 会话/代理被宿主关掉时立即 settle，不再等总超时。所有监听器在 `finally` 统一注销，
  `worker_lost` 只在 idle/lifecycle 路径记录一次 error 事件
- `lib/live/executor.js`：`invokeWorker` 透传 `idleTimeoutMs: config.executor.workerIdleTimeoutMs`；
  worker 返回 `error === 'worker_lost'` 时以 `stopReason/errorCode = 'worker_lost'` 结束 run（worker 步骤 failed）；
  `failRun` 对 `worker_lost` 把工单放回可重试的 `ready`（保留 branch/worktree），写一条 `run` activity，
  终态仍由 `finally` 的 `persist()` 落盘，不再出现长期 `working`
- `lib/live/engine.js`：`deriveInboxItems` 在 `run.stopReason === 'worker_lost'` 且工单为 `ready` 时仍派生
  `kind: 'failure'` 待办（标题「worker 失联，可重试」），保证失败在桌面可见
- `lib/live/config.js`：`DEFAULT_EXECUTOR.workerIdleTimeoutMs = 300_000`，合并时只接受 60_000..3_600_000 的整数
- `lib/live/live-json.js`：白名单新增 `executor.workerIdleTimeoutMs`（kind `worker-idle-ms`，60_000..3_600_000）
- `lib/live/worker.test.js`：新增 5 个用例（无事件 → idleTimeoutMs 后 `worker_lost`、窗口内有事件则重新计时、
  正常 `turn/end` 不受影响、`session/disposed`/`agent/disposed` 立即 settle）；`fakeHost` 按事件类型记录监听器，避免生命周期事件与
  `session/event` 混淆
- `lib/live/executor.test.js`：新增 worker_lost → run failed/stopReason worker_lost/工单 `ready`/worktree 保留/
  activity 与 inbox failure 待办/未提交未推送，并断言 `idleTimeoutMs` 从配置透传
- `lib/live/config.test.js`、`lib/live/live-json.test.js`：覆盖默认值 300_000 与 60_000/3_600_000 边界及越界回退
- `package.json` 版本 0.4.18 → 0.4.19

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`（`client/index.js is up to date (22 fragments)`）
- `node scripts/check-keys.mjs`（756 literal keys / 513 shared keys / 1131 page-local keys）
- `node --test lib/store.test.js lib/live/*.test.js` 406/406（新增 8 个用例）
- `node scripts/render-check.mjs` 本机 137/138；基线上同一个失败（`overview names the needs-you vs worth-a-look split`，
  本机 state 无 worth-a-look 项），与本次 Host 改动无关
- `node scripts/isolated-verify.mjs` 本机在 `Runtime.enable timed out` 失败；基线同（Chrome/CDP 环境问题）

## [0.4.18] — 2026-11-12

README 虽已在 0.4.17 把自开发细节移出，仍有 308 行：其中「hybrid 接单试点（0.3.4）」「评估确认（群消息复核，0.4.2）」
「决策模型 shadow（可选，落地第一步）」「功能成熟度」四节约占 170 行，属于机制/排障/历史细节，按 AGENTS.md 的
「文档分层」应放 `docs/`，README 只留概览与入口。本次把四节原样迁到两个新文档，README 只留「进阶能力」入口。
只改文档与版本号，不改 `index.js`/`lib`/`client`，不重建 `client/index.js`。

### 内容
- 新增 `docs/intake-and-eval.md`：原样迁入「hybrid 接单试点（0.3.4）」「评估确认（群消息复核，0.4.2）」
  「决策模型 shadow（可选，落地第一步）」三节（保留 H2 层级、表格、代码块、链接与数字），开头注明
  本文件是评估与接单的进阶配置、非安装必读
- 新增 `docs/feature-maturity.md`：原样迁入「功能成熟度」整节（稳定/可用/部分/未实现分级、P1/P2 批次、
  多后端路由与 P1 诚实边界）
- README 删除上述四节，替换为 6 行以内的「## 进阶能力」：评估接单与确认、决策模型 shadow 指向
  `docs/intake-and-eval.md`，功能成熟度指向 `docs/feature-maturity.md`；README 308 → 141 行，其余章节不动
- AGENTS.md 的 `docs/` 结构描述补上两个新文档名
- `package.json` 版本 0.4.17 → 0.4.18（`files` 已含 `docs/**/*.md`，无需调整）；README 顶部「当前版本」同步

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs` 138/138
- `node scripts/isolated-verify.mjs`

## [0.4.17] — 2026-11-12

README.md 已到 418 行，自开发的全部操作细节（`live.json` 仓库配置与字段语义、GitFlow、6 个闸门表、交付流程、
状态流转、入口、本机稳定安装、隔离实例验证、常见坑）都堆在「用面板开发本仓库（自开发）」一节，项目概览与操作手册
混在一起。本次做文档分层：细节原样移到 `docs/self-development.md`，README 只留一句话闭环、闸门名与入口链接。
只改文档与版本号，不改 `index.js`/`lib`/`client`，不重建 `client/index.js`。

### 内容
- 新增 `docs/self-development.md`（130 行）：`live.json` 字段语义（`verifyMode`/`acceptance`/`createMr`/`ci`）、
  GitFlow 分支策略、6 个闸门表与依赖说明、交付流程 1–5、状态流转与失败处理、入口、本机稳定安装、隔离实例验证、
  常见坑（merge commit 与 ancestry、GitHub 免费私库无分支保护、desktop profile 由 Electron 管理）；命令、路径、
  字段名与数字保持原样，只归并小标题并新设「常见坑」一节
- README「用面板开发本仓库（自开发）」由 132 行压缩到 12 行：一句话说明自开发闭环 + 一行 6 个闸门名 +
  指向 `docs/self-development.md` 与 `AGENTS.md` 的链接；README 418 → 308 行，其余章节不动
- AGENTS.md 新增「文档分层」约定：README 只放概览/安装/5 分钟接入/简短验证命令/入口链接，机制与排障细节放 `docs/`，
  版本变更写 `CHANGELOG.md`，README 超过约 250 行先考虑拆文档
- `package.json` 版本 0.4.16 → 0.4.17，`files` 加入 `docs/**/*.md`（README 链接的文档随包分发）
- README 顶部「当前版本」同步到 0.4.17

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs`
- `node scripts/isolated-verify.mjs`

## [0.4.16] — 2026-11-12

README 的闸门表只写了 `isolated` 验证什么，没写闸门清单从哪来、本机需要什么依赖、失败时看什么；在没装 Chrome 的
机器上只会读到 `no Chrome/Chromium binary found (set CHROME_PATH)`，不知道 `CHROME_PATH` 的作用与失败标记长什么样。
本次只补文档与版本号，不改代码、不重建 `client/index.js`。

### 内容
- README「用面板开发本仓库（自开发）」在闸门表后补一段：executor 的闸门清单来自 `live.json` 的 `repo.gates`；
  0.4.15 起第 6 项 `isolated` 由 `node scripts/isolated-verify.mjs` 承担（临时 `DSH_HOME`/state + 真实 Chrome
  headless CDP）；本机需 Chrome/Chromium，可用 `CHROME_PATH` 指定可执行文件；失败时打印
  `[isolated-verify] FAIL <原因>`
- README 顶部「当前版本」同步到 0.4.16（此前停在 0.4.14，0.4.15 漏更新）
- `package.json` 版本 0.4.15 → 0.4.16

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs`
- `node scripts/isolated-verify.mjs` 单独跑通

## [0.4.15] — 2026-11-12

`render` 闸门在 jsdom + 共享 `/tmp/sa-harness` 上渲染客户端，证明不了「真实 DSH Web UI 里 Host 半 + 客户端能一起挂载」。
新增 `scripts/isolated-verify.mjs`：临时 `DSH_HOME` 与 `DSH_SUPERAGENT_STATE_DIR`、随机端口、真实 Chrome headless CDP，
打开左侧栏「超级智能体」并断言 6 个 tab、空状态引导、console 无错误，截图写入 `verification/`（gitignore）。

CLI 定位兼容 `DSH_NODE_EXECUTABLE` + `DSH_INSTALL_DIR`（executor gate 环境可能没有这两个变量），
其次探测 macOS 应用包（asar 内的 `lib/bin.js` 由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 读取），最后回退 PATH 上的 `dsh`。

### 验证
- 本机 `node scripts/isolated-verify.mjs` PASS（清空 `DSH_*` 环境变量后走 app-bundle 兜底）
- `node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`
- Host 测试 398/398、`node scripts/render-check.mjs`

## [0.4.14] — 2026-11-12

README 的数字与仓库实际状态脱节：顶部还写着 0.4.8（`package.json` 已到 0.4.13），「开发与验证」里的 Host 测试数量
仍停在 396，实际已是 398。本次只同步文档与版本号，不改代码、不重建 `client/index.js`。

### 内容
- README 顶部「当前版本」改为 0.4.14，并注明 0.4.13 起交付走 GitFlow（feature→develop，release/hotfix 走独立分支），
  版本历史指向 CHANGELOG
- README「开发与验证」的 Host 测试数量 396 → 398，与 `AGENTS.md`、闸门表和实跑结果一致
- `package.json` 版本 0.4.13 → 0.4.14

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs`

## [0.4.13] — 2026-11-12

自开发链路改用 GitFlow，并把自开发代码与本机日常安装彻底分开。此前仓库只有 `main`：工单 PR 以 `main` 为 base、
合并即发布，dev 代码通过 `link:` 直接进入桌面 profile；本版本把交付、发布、本机运行三层拆开，并新增隔离实例闸门。

### 内容
- `auto-pr.yml` 按分支前缀选 base：`feature/**` → `develop`，`release/**`、`hotfix/**` → `main`（幂等，已有 PR 跳过）
- 仓库配置：`baseBranch`/`targetBranch` 改为 `develop`，工单合入集成分支即 `merged`，`main` 只由 release/hotfix 合入
- README 增加「分支策略（GitFlow）」「本机稳定安装（与开发仓库分离）」「隔离实例验证」三节，交付流程与
  `verifyMode: manual` 的 ancestry 判定改为 `origin/develop`
- 新增 `scripts/isolated-verify.mjs` 与 `isolated` 闸门：临时 `DSH_HOME` + 临时 state + 随机端口起一次性 DSH，
  Chrome headless CDP 实机断言侧栏入口、面板页签与空状态、console 无错误，结束后清理
- `AGENTS.md` 交付语义改为 GitFlow（feature→develop、release/hotfix→main、tag 发布、stable clone 跟随 tag）

### 验证
- `node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js`
- `node scripts/render-check.mjs`
- `node scripts/isolated-verify.mjs`（本机 Chrome；闸门上线后在真实工单上再验证一次）

## [0.4.12] — 2026-11-11

README 补上「用面板开发本仓库（自开发）」一节：自开发链路已经跑通（工单 → 闸门 → 推送 → auto-pr → merge commit →
验收），但操作口径只散落在 `AGENTS.md` 与 CHANGELOG 里，照 GitLab/旧仓库的旧习惯操作容易踩坑（例如用 squash
合并，面板的 ancestry 判定认不到已合入，工单停在 `mr-open`）。

### 内容
- README 在「开发与验证」后新增该小节，按本仓库在 `live.json` 的仓库项说明：
  - `verifyMode: "manual"`（只观察提交是否合入 `main`）、`acceptance: "merged"`（合入后仍需人工验收）、
    `createMr: "push"`（只推分支，推送输出的 `pull/new` 链接记为 pending MR）、`ci: false`（发布后直接 `mr-open`）
  - 5 个闸门 `syntax` / `client-build` / `i18n` / `host-tests` / `render` 的命令与各自验证范围
  - 交付流程：闸门 → 提交 → 推送 `feature/<ticketId>` → 面板记 pending MR 并进入 `mr-open` →
    `.github/workflows/auto-pr.yml` 自动开 PR → 人工评审
  - 合并必须用 merge commit（fast-forward 可以；squash/rebase 会重写 commit，`git merge-base --is-ancestor`
    判定不到，工单一直停在 `mr-open`）
  - 状态流转 `queued → working → mr-open → merged → 人工验收`；失败时先看「闸门结果」与运行记录里的证据
  - 入口：执行页「手工建单」时选本仓库（`live.json` 的默认仓库不是本仓库，不能沿用默认）
- 改动范围：README、CHANGELOG 与 `package.json` 版本号；不涉及 Host/客户端代码，`client/index.js` 不重建

### 验证
- `node --check index.js`、`node scripts/build-client.mjs --check`（22 fragments 最新）、
  `node scripts/check-keys.mjs`（756 literal / 513 shared / 1131 page-local）通过
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs` 138/138（无客户端改动，渲染回归不变）

## [0.4.11] — 2026-11-11

第一张自开发工单的实测暴露了两个问题，都在这里修掉：GitHub 仓库带着 GitLab push options 推送会被服务端拒绝；
render 闸门失败时证据只剩 40KB JSON 的尾巴，看不到是哪条断言失败。

### 内容
- **GitHub 仓库不以 push options 推送**：`createMr: "push"` 原先无条件带 `merge_request.*` push options。GitHub 忽略这些
  选项（PR 由 `.github/workflows/auto-pr.yml` 在分支推送后创建），而实测带 options 的推送被 GitHub 以
  `remote unpack failed: no voting servers succeeded` 拒绝两次，同一分支不带 options 立即推送成功。新增
  `usesPushOptionMr(repo)`：`gitlab.baseUrl` 指向 github.com 时不带 options，GitLab 仓库行为不变；GitHub 输出里的
  `pull/new/<branch>` 链接仍由 `parseMergeRequestFromPush` 记为 pending MR，工单照常进入 `mr-open`
- **闸门失败证据可定位**：`executor.runCommand` 只保留命令输出末尾 4000 字节，而 render-check 的 JSON 约 40KB，
  失败断言的 `FAIL` 行正好落在被截断的前段。`render-check.mjs` 在 JSON 之后补打 `FAILED n/total: 名称 | …` 与最多
  3 条 `DETAIL`，自动修复 worker 拿到的证据能指向具体断言

### 验证
- `node --test` 398/398（新增 GitHub 仓库不带 options 推送、`usesPushOptionMr` 的两组断言）
- 自开发工单实测链路：worker 修复 → 5 个闸门通过 → commit → push 两次被 GitHub 拒绝（带 push options）→ 人工 retry
  不带 options 成功 → Actions 自动开 PR #1 → merge commit 合入 `main` → 面板按 ancestry 判定 `merged` → 人工验收

## [0.4.10] — 2026-11-11

修复 `metricsView` 时长夹具的 1ms 竞态（flaky）：`metricsView classifies runs, windows them and rolls up
durations/triggers/stop reasons (p2c §1)` 偶发失败——2026-11-10 的全量运行里实际值 `totalMs=5280001`、
断言期望 `5280000`，其它字段一致，重跑即过。

根因在测试夹具自身，不在引擎：`seedMetrics` 里每个 run 的 `startedAt` 与 `completedAt` 是两次独立调用
`hoursAgo(...)` / `daysAgo(...)` 得到的（例如 `startedAt: hoursAgo(1)`、`completedAt: plusMinutes(hoursAgo(1), 10)`）。
两次 `Date.now()` 之间跨过 1 毫秒时，该 run 的时长就从 600000 变成 600001，聚合结果随之漂移。

- `seedMetrics` 在夹具开头冻结一次 `base = Date.now()`，`hoursAgo` / `daysAgo` 增加可选 `base` 参数
  （默认仍是 `Date.now()`，其它用例行为不变），每个 run 的两端都由同一基准推导；断言意图与期望聚合值
  保留不变（avgMs 528000 / p50Ms 360000 / p95Ms 1800000 / totalMs 5280000）
- 用例新增一条守卫断言：每个已结束 run 的 `completedAt - startedAt` 必须是整分钟数（`% 60000 === 0`），
  漂移会直接指向出错的那一行，而不是只表现为聚合值差 1
- 只改测试夹具，运行时行为（`lib/live/engine.js`）不变，`client/index.js` 无需重建

### 验证
- `node --test` 397/397；该用例单跑与全量均通过，重复运行稳定（该用例连续单跑 10 次也全过）
- 复现对照（时钟每次 `Date.now()` 前进 1ms）：旧夹具单 run 600001ms、10 个 run 合计 5280010ms；
  新夹具 600000ms / 5280000ms
- `node --check index.js`、`build-client --check`、`check-keys` 通过
- `render-check` 138/138，连续复跑 20 次均通过（含 `bash -lc` 登录 shell 的 node 24.14、8 路并发与 CPU 满载）；
  发布闸门曾报过一次 render exit 1，同一工作树/live 状态下未能复现，本轮不改客户端与闸门脚本

## [0.4.9] — 2026-11-11

为「用面板开发面板」补齐 GitHub 交付侧的唯一缺口，并把仓库规则落成 worker 可直接读取的 `AGENTS.md`。

### 内容
- **GitHub 推送后解析 create-PR 链接**：`parseMergeRequestFromPush` 增加 GitHub 的 `/pull/new/<branch>` 形态，
  返回 pending merge request（`created:false`、无 `iid`）。GitHub 会忽略 `merge_request.*` push options 且不创建
  PR，此前工单停在 `pushed`（已推送·缺 MR）；现在工单进入 `mr-open`，manual 仓库的巡检继续用 git ancestry
  判断合并，面板详情页也能直接点开建 PR 链接
- **`.github/workflows/auto-pr.yml`**：GitHub 仓库的交付桥，`feature/**` 分支推送后自动 `gh pr create`
  （幂等：已有 PR 就跳过）。PR 仍需人工评审合并；合并请用 merge commit，否则 ancestry 判定不到
- **`AGENTS.md`**：仓库结构、改动最低验证命令（build --check / check-keys / host tests / render-check）、版本与
  CHANGELOG 约定、禁止项、GitHub 交付语义，供 Superagent worker 在干净 worktree 里直接遵循
- `CHANGELOG.md` 把 H1 移回文件顶部（0.4.8 的版本节误加在 H1 之前）

### 验证
- `node --test` 397/397（新增 GitHub create-PR 解析用例）；`build-client --check`、`check-keys`、`render-check` 通过
- 真实 GitHub 推送输出回归：`remote: Create a pull request ... /pull/new/...` 解析出 pending MR URL

## [0.4.8] — 2026-11-11

Impeccable 系统评分（28/40，含两路独立评估与实机检测）后的修正：先修三处界面与数据自相矛盾，再修窄屏、对比度与
键盘可达性。评分报告与优化清单见本轮交付；未落地的结构性建议（自动化开关收成一张状态卡、评估行 meta 收敛）
保留在后续清单。

### 界面与数据自相矛盾
- **闸门结果按 run 实际记录的闸门渲染**：`TicketGateResults` / `GateSummary` 原来固定映射 standards/backend/frontend，
  仓库自定义闸门（`ebs-deploy`、`ebs-access`）显示成三个「—」，而同页阶段链路写着「闸门 2/2」。现在遍历
  `runs[].gates`，未知名称保留原名，失败门附 exit code / 超时文本，并给每个门补 `aria-label`（名称·通过/未通过）
- **概览「3 张工单在失败后被忽略 → 查看」不再是死路**：watch item 带 `stage:'dismissed'` 深链；执行页新增
  「已忽略」切片（chip 计数、`ex.dismissedNote` 说明、按 dismissed 过滤），`ExecutionQueuePage` 接受 route stage
- **概览运行脉搏与来源页统一口径**：来源改用「已启用 1/3」（与来源页同分母）；执行器 `enabled=false` 时显示
  「已停用（设置→运行）」而不是「空闲 · 无排队或运行中工单」；来源页每张卡始终显示自己的停用原因，且仓库卡
  指向「启用执行器」而不是「启用引擎」
- **自动化未启动横幅**：暂停/引擎/执行器三个事实各带修复位置（设置→来源/运行）；警告图标与标题包进
  `.sa-automation-head`，390 下不再独占一行
- **规则标签「命中/未命中」→「通过/未通过」**：R3 的 reason 本来写「未命中生产/DDL/…」，旁边却标「命中」；
  「{hit} 命中 / {miss} 未命中」同步改为「{hit} 通过 / {miss} 未通过」
- **人工复核只记录时标「（仅记录）」**：`humanReview.outcome==='recorded'` 的评估行不再只写「人工：接单」

### 可达性与窄屏
- 执行页阶段计数徽标去掉 opacity（0.42/0.66 → 1）：实测 1.82:1 / 2.75:1 → 5.5:1，达到 WCAG AA
- `.sa-tag` 加 `flex: none`：390 下来源页 20/25 个标签被压到 ~20px 并与标题叠字；现在换行不裁切
- 设置：表单 760→640、开关 36×20→40×24、紧凑开关 30×18→36×24、`.sa-input input` 拉到 32px 高度（24px 目标下限）
- 搜索：Ctrl+K 打开、Esc 关闭时若 opener 是 `<body>`，焦点回搜索按钮（`Modal restoreTo`）；Alt+数字切页签时
  焦点随选中项同步（原来选中项 tabindex 已变 -1 而焦点仍留在旧页签）
- 手工建单：提交改为 32px 主按钮 + 「取消」，不再是从左下角 28px 按钮提交

### 验证
- `node --test` 396/396；`render-check` 138/138（新增 5 条：闸门自定义名、已忽略切片、规则标签、手工建单动作等）
- `build-client --check`、`check-keys` 通过；`impeccable detect --cdp` 六页面板内 findings 0（修前 1 条 low-contrast）
- 实机复检 1280/960/390：概览 来源「已启用 1/3」+ 执行器「已停用」、执行页 7 个阶段 chip 与「已忽略」切片、
  工单详情闸门区显示 `ebs-deploy`/`ebs-access`、390 横幅图标同行、标签不压字

## [0.4.7] — 2026-11-11

修复「运行记录」把交付时的阶段当成实时状态：`tkt_f6a66f97a4ab41fe` 的 MR 已合并、已部署 UAT 并验收，
运行记录里仍有一条「等待 CI」在转圈，看起来像 CI 一直没回来。

根因是两段事实不一致：`run.status` 在交付那一刻被写成工单当时所处的阶段（`lib/live/executor.js` 的
`run.status = ticket.status`，例如 `ci-pending`），此后 CI 通过、MR 合入、部署、验收都只改 `ticket.status`
与 `ticket.links`，不会回写 run（run 是只追加证据，唯一的回写是 reconcile 把陈旧的 `running` 标成
`interrupted`）。而运行记录行直接拿 `run.status` 走工单状态表渲染，`ci-pending` 在状态表里是 `ongoing`
（默认转圈），于是**已经结束几小时的 run 一直在转**。

- 新增 `runView(t, run)`（`client/src/34-live-ui.js`）：run 有 `stopReason` 且状态不是 `running` /
  `waiting_for_human` 即视为已结算，形状由结束原因（`RUN_STOP_STATE`）决定；若它的末状态是交付阶段
  （`ci-pending` / `ci-passed` / `mr-open` / `pushed` / `merged` / `deploy-pending` / `gates-passed` / `ready`），
  文案改为「交付时：{阶段}」，不再借用该阶段的实时形状。交付时的阶段作为历史保留，`stopReason` 标签
  （完成 / 失败 / 中断…）不变
- 三处同源渲染改走 `runView`：工单详情运行记录行（`58-ticket-detail.js`）、阶段链路「执行」步结果、
  `LiveRunRows` 兼容层
- 回归：render-check 把演示工单的 run 固定成 `status:'ci-pending' + stopReason:'done'`（真机上该工单的形态），
  新增「已交付 run 写交付时阶段」「已结算 run 不转圈」两条断言，136/136；`node --test` 396/396；
  `build-client --check` 与 `check-keys` 通过

## [0.4.6] — 2026-11-09

修复工单详情「工单动作」菜单显示成一块空白灰块：菜单按 `align="end"` 向左展开，越过 `.sa-scroll` 的横向
裁剪边界后，整列文字被裁掉，只剩背景色。

- `Menu` 打开时按触发点两侧的可用宽度实测选边：能容纳时沿用调用方指定的方向，左侧空间不足则向右展开
  （`data-align` 改为实测方向），键盘操作与 `aria-*` 不变
- 只在客户端，刷新面板页面即生效；`getComputedStyle` 通过 `ownerDocument.defaultView` 走，jsdom 下也不崩
- 回归：render-check 135/135；`node --test` 396/396

## [0.4.5] — 2026-11-09

修复「执行超时」在设置里只能看不能改：worker 超时后无法调大超时再重试。

- `live.json` 白名单新增 `executor.timeoutMs`（整数毫秒，60000–86400000 校验）；设置→运行 改成分钟输入框
  （1–1440），保存即生效
- 保存前做范围校验，提示明确；说明文案写明「超时以 timeout 结束本次运行，工作树保留，可调大后重试」
- 回归：live-json 增加 timeout 边界用例；render-check 增加「运行超时可编辑」断言

### 验证
- `node --test` 396/396
- render-check 135/135
- `npm run verify`：client 产物最新；752 literal keys / 513 shared / 1121 page-local 通过

## [0.4.4] — 2026-11-09

修正 0.4.3 对 `tkt_969114d7aca74a45` 的结论：根因不是"worker 用了 subagent"，而是 **worker 在自己发起的
异步 run 还没完成时就结束了本轮**；0.4.3 禁用 subagent 工具只是绕过问题，违背"worker 对自己发起的 run 负责"
的约定。0.4.4 改为在 harness 的 turn 边界上强制等待。

- worker 在 setup 里监听 `agent/turn-stopping`（harness 在 `turn/end` 提交前 await 的边界钩子），用
  `subagents.listDescendants` + `subagents.waitForChildren` join 仍在运行的子代理；子代理结果回到 worker
  inbox 后 loop 再跑一步，直到没有 live child 才允许结束本轮（tkt_969114d7aca74a45，2026-11-09）
- 恢复 `subagent` / `subagent_fork` / `list_agents` / `send_message` 工具（不再禁用）；workerBrief 改为
  "可以起 subagent 做独立复核；run 会等它们完成，不要在结果回来前给最终总结"
- 兜底：最多 join 20 轮；abort 立即退出；`waitForChildren` 返回 false（idle resident child）不阻塞完成
- 测试：`joinChildrenBeforeTurnEnd` 单测 ×3 + worker 注册/清理/join 测试 ×1
- 验证：`node --test` 395/395；render-check 134/134；build-client --check、check-keys 通过

## [0.4.3] — 2026-11-09

两件事：修复 worker 把"等待独立复核"当成最终执行总结（tkt_969114d7aca74a45），以及评估确认的配置进入设置页。

### worker 总结停在"等待独立复核"

工单 `tkt_969114d7aca74a45` 已走到 `mr-open`，但执行总结是"初版改动已完成，独立复核仍在进行中…"。
trace 显示 worker 在会话里调用了 `subagent` 起异步复核、`list_agents` 发现还没结果，随后用了
`superagent_report_progress` 并结束本轮（`turn/end completed`）；executor 以"turn 结束"作为 worker 完成，
继续跑闸门、提交并发布 MR，最后一条 assistant 文本就成了 handoff summary。异步 subagent 的结果不会回到
这个 headless run，所以那句话不是最终交付说明。

- 修复：worker 的 `DENY_TOOLS` 增加 `subagent` / `subagent_fork` / `list_agents` / `send_message` /
  `interrupt_agent`，headless run 不允许再起异步 agent
- workerBrief 明确：headless run 在 turn 结束时收尾，独立复核必须在本轮内 inline 做第二遍；不要起后台 agent
- 回归：worker guard 测试覆盖新增的 denied 工具

### 评估确认设置页可配置

- 新增「设置 → 评估确认」可写分组：启用开关、确认范围（all/uncertain）、允许回复的操作人
  （Octo uid 逗号/换行分隔，留空 = 没人能回复）、回复有效期（1–168 小时），带保存栏与校验
- `live-json.js` allow-list 新增 `review.enabled` / `review.scope` / `review.allowSenderIds` /
  `review.expireHours`（枚举/小时数校验），设置页保存走同一原子写与配置回滚
- render-check 增加「评估确认」分组与 rail 顺序检查
- 验证：`node --test` 391/391；render-check 134/134；build-client --check、check-keys 通过

## [0.4.2] — 2026-11-09

评估确认（群消息复核）：每条评估回发来源群，操作人回复「接单/忽略 + 短码」决定是否开单，并把判断写成信号
标签用于校准。

- 新增 `lib/live/reviews.js` + 引擎 review 流程：每条被评估的消息（规则接单/规则忽略/模型否决）生成一条
  `#ABCD` 短码确认消息发回来源群；回复支持 `接单 ABCD` / `忽略 ABCD`（也支持码在前）
- 回复在 intake 之前拦截，不会变成新需求；机器人通知以 `Superagent:` 开头，被自回复过滤，不会循环
- 动作：模型否决/规则忽略 + 接单 → 规则重放建单（规则硬拦的高风险仍拒绝）；已排队工单 + 接单 → 立即执行；
  已排队工单 + 忽略 → dismiss；忽略 + 忽略 → 记录一致
- 每次回答写 `decision.humanReview` 并把 `correct / false_wake / missed_wake` 写入信号标签
- 严格 gate 用 `executor.autoRun=false` 控制（新工单排队等确认）；未回复的评估按 `review.expireHours`
  （默认 24h）过期
- 配置 `review.enabled / scope(all|uncertain) / allowSenderIds / expireHours`；面板设置→评估显示确认范围与
  待回复/已回复计数，评估页显示人工结论标签
- 新增 8 条 reviews 单测 + 10 条引擎 review 流程测试 + 1 条配置测试
- 验证：`node --test` 390/390；render-check 133/133；build-client --check、check-keys 通过

## [0.4.1] — 2026-11-09

修复 hybrid 线上漏单：2026-11-09 05:41 的一条真实需求

> 需求：库存出入库流水表（Cux_Mtl_Transactions_Pkg.Main）数据传BI …… 1、新增procedure：Main_Bi，参数 p_Ledger_Id…

被 `ticket-v1` 判成 `context`（P(repo_task)=0.30）→ `modelSkip` 忽略。消息里大量表名/procedure/参数名触发了
`context` 描述，但它是明确的开发需求（要求新增 procedure、并发请求、定时刷新、写入 cux schema）。

- 问题集 `ticket-v1` → **`ticket-v2`**：`repo_task` 描述扩展到"或提出具体的开发/数据交付需求（含需求说明、
  procedure/报表/接口、参数与定时规则）"；同一条消息重判为 `repo_task` 0.97
- 回归：人工回归集 25 条保持 24/25；真实标注（加入这条漏单，24 条）22/24，开单精确率保持 100%；
  golden/real 上没有新增误开
- 漏单的原始信号已用重放补建工单（replay 走规则判定，人工覆盖通道）
- 验证：`node --test` 374/374；render-check 116/116；build-client --check、check-keys 通过

## [0.4.0] — 2026-11-09

多 Worker 后端路由：原来 `executor.workerBackend` 只能选一个后端，现在可同时启用 DSH / Codex CLI / Claude Code CLI，并由路由按任务类型选择执行者与档位。

- 配置：`executor.workers`（每个后端 enabled/model/command）+ `executor.routing`（`mode: single|suggest|auto`、`defaultBackend`、`fallback`、`preferences`）；未写 workers 时完全沿用旧的单后端行为
- 分类与路由（`lib/live/routing.js`）：关键词分类 analysis/review/test/dev/docs/research/interactive；能力硬约束优先（联网调研与需提问只能 DSH、测试验证不能 Claude），其次用户偏好、默认、降级链；多后端默认 `suggest`（只记录建议，仍用默认后端），`auto` 才真正分发
- 执行：`run.route` / `ticket.route` 记录 workType、backend、profile、reason；CLI 按档位收紧（Codex `-s read-only`、Claude `--permission-mode plan`），DSH 只读用工具 guard 禁写；analysis/review/research/interactive 无改动时交付报告并结束为 `closed`，不跑闸门、不提交推送
- 手动改派：`POST engine/ticket/:id/run` 支持 `backend` 覆盖路由（记录为 manual）
- 面板：设置→Worker 改为路由模式、三后端启用与模型/CLI 路径、默认/降级后端、任务类型偏好表；运行记录新增「后端 · 类型（建议）」标签
- 回归：`lib/live/routing.test.js` 8 条 + executor/config/live-json 新增用例；`node --test` 374/374；render-check 133/133
- **发布失败自动修复闭环**（同版本树内补记）：`publishTicket` 闸门失败后把失败闸门的 exit code/输出/repairHint 交回
  worker，在同一 worktree 修复后重算 changedPaths、重跑全部闸门；最多 `executor.maxRepairRounds` 轮，成功继续
  commit/push/MR，耗尽才 `failed`。修复轮 brief 允许改 `scripts/local/` 的部署/授权工具（`oracle_connect.py` 与
  凭据仍禁止，`protectedPaths` 兜底）；发布接口改为异步 202；`run.repair`/`run.repairs`/`repair:worker:N` 可追溯。
  实测：`tkt_640380ab550b4e54` 发布时两轮自动修复（deploy 幂等 + access 属主连接）后开 MR !11 并合并
- **手动仓库巡检不再被上限停掉**（同版本树内补记）：`verifyMode=manual` 的仓库只观察 MR 是否合并，不再套用
  “同一 head 3 次”上限，合并/关闭后才停；CI 仓库用尽 3 次时工单详情验收区显示「点 ⋯ → 核对合并/UAT」提示。
  修复前该工单在 MR 合并 26 分钟后仍停在 `mr-open`

### 验证
- `node --test` 374/374
- render-check 133/133
- `npm run verify`：client 产物最新；737 literal keys / 513 shared / 1102 page-local 通过

## [0.3.8] — 2026-11-09

设置新增「Worker」页签：把 worker 后端与「运行后端能力」矩阵从「运行」组迁出，单独成组。

- 左侧导航在「运行」之后新增「Worker」（robot 图标）：Worker 后端选择、模型/CLI 路径与该后端的提示、只读
  「运行后端能力」矩阵都在这里；「运行」组只保留执行器总开关、自动执行、暂停、MR 方式、闸门/超时与手工建单
- 新组可写，沿用同一 `executor.*` allow-list：`settingsPatchOf` 的 run/worker/write 三组共用补丁逻辑，各自独立
  草稿与保存条；选中 DSH 时仍不渲染模型/CLI 输入（与迁移前一致）
- 文案同步：运行组提示不再提 worker 配置；工单详情的 CLI 失败提示改指「设置 → Worker → CLI 路径」；README 的
  设置分组说明同步
- 回归：render-check 131/131（新增 Worker 组、运行组不再含后端/能力矩阵、导航顺序、能力矩阵高亮 4 条断言）

### 验证
- `node --test` 355/355
- render-check 131/131
- `npm run verify`：client 产物最新；724 literal keys / 513 shared / 1064 page-local 通过

## [0.3.7] — 2026-11-09

修复「发布 MR」时带 `passChangedFiles` 的闸门拿不到改动文件：发布路径直接跑 gate 的原始命令，没有像干跑那样把
`changedPaths` 拼进去，EBS 部署闸门在参数解析阶段就退出（`未指定任何文件`，exit 2），根本没有连 UAT。

- 抽出 `gateCommandFor(spec, { paths, dryRun })`，干跑与发布两条闸门路径共用：`passChangedFiles` 的闸门一律附带
  执行器算出的改动路径（发布时用 `changedPaths(cwd, baseSha)` 重新计算）
- 发布路径补上 `requireOutput` 证据校验：闸门 exit 0 但输出缺少必需关键字同样判失败（与干跑一致）
- 回归：publish 把改动路径传给 `deploy_object.py`、缺证据时 `gate_failed` 且不推送；`node --test` 355/355
- 说明：干跑路径一直正常，所以之前 dry-run 闸门都是 exit 0；该 bug 只在「发布 MR → 真跑闸门」时暴露

### 验证
- `node --test` 355/355
- `npm run verify`：client 产物最新；723 literal keys / 513 shared / 1062 page-local 通过

## [0.3.6] — 2026-11-09

修复追加要求后「执行总结」显示上一轮的问题：`changesOf` 原来取 runs 列表里最后一条 worker 文本，而 runs 按最新在前，
于是第二轮之后仍显示第一轮的总结，看不出这次追加要求做了什么。

- 「改动内容 → 执行总结」改为取**最新一次写过总结的 run**，并标注来源 run（`执行总结（来自运行 run_xxx）`）；
  追加要求（revision）重跑后显示的就是这一轮的总结
- 改动文件列表仍是跨轮并集（"当前工作树里有哪些改动"），与总结的口径分开
- 回归：render-check 用"旧一轮 + 新一轮"的 fixture 验证总结不回退到旧轮（125/125）

### 验证
- `node --test` 353/353
- `render-check` 125/125
- `npm run verify`：client 产物最新；723 literal keys / 513 shared / 1062 page-local 通过

## [0.3.5] — 2026-11-08

工单详情支持「追加要求并自动重跑」：干跑结果不对时，操作员不必重新开单，也不用手工改 `live-state.json`。

- 新增 `POST /superagent/api/engine/ticket/:id/revision`（body `{text}`）：把要求追加到工单 `revisions[]` 并记一条
  `revision` 活动，随后**自动以干跑方式重跑**（`trigger=revise`，复用同一 worktree，不提交/推送）
- `Engine.addRevision` 校验：空内容 / 超 4000 字、执行中、等待回答、已结束或已忽略、已验收的工单拒绝；未知工单 404
- worker task 按顺序携带最近 10 条追加要求，并提示"上一轮改动在 worktree 中，保留并在此基础上修改"
- 面板：工单详情「改动内容 → 追加要求」输入框 + 「追加并重跑」，并展示修订历史（时间 + 原文）；运行记录新增
  `runTrigger.revise`（追加要求）标签
- 概览：新增第 6 类待办 `publish` —— 干跑已完成、还没发布的工单现在会出现在「需要你处理」里
  （标题「工单「…」干跑完成，等待你确认发布」，`blocking:true`、`priority:normal`，点「去工单」进入详情）；
  发布或开始下一轮后条件消失，条目自动 resolve。之前 `ready` 状态在概览上完全不可见，只有执行页能看到
- 工单详情：`ready`（干跑完成）的主行动从「干跑执行」改为「发布 MR」（仍走确认弹窗），「干跑执行」与其余动作
  留在 ⋯ 菜单——发布才是这一状态的下一步，而不是再跑一遍
- 回归：`Engine.addRevision` 状态矩阵、workerTask 修订注入、路由校验、`publish` 待办推导/自动 resolve、
  render-check 表单/历史/提交与 ready 主行动

### 验证
- `node --test` 353/353
- `render-check` 123/123
- `npm run verify`：client 产物最新；722 literal keys / 513 shared / 1061 page-local 通过

## [0.3.4] — 2026-11-08

hybrid 接单试点：规则仍是第一道门，模型 `ticket-v1` 参与 R1 的"要不要开单"。

- 新增 `eval.mode='hybrid'`：候选先走规则（R2/R3 硬闸不变，规则忽略的不会调用模型）；规则接单后按模型类别决定：
  `repo_task` 且 `p ≥ acceptAt`（默认 0.5，按 pilot 标注校准）→ 自动开单；`risky` 或 `riskP ≥ riskAt`（默认 0.5）→ 忽略
  `modelRisk`；其他类别 → `modelSkip`；中间区 → `modelUncertain`
- 人工兜底：三种模型否决都落为可重放的原始信号（来源页），重放会用规则重新判定并建单（人工覆盖通道）
- 失败与预算：模型报错或单轮 `maxPerPoll` 用完 → 回退规则 accept，不静默丢工作；hybrid dry run 会调用模型
- 决策记录新增 `decision.model`（category/p/riskP/verdict/latencyMs）与 `evalMode:'hybrid'`、`actorKind:'hybrid'`；
  面板评估页模型标签同时支持 shadow/hybrid 决策；设置→评估新增 hybrid 模式与调用/回退计数
- 状态面 `eval.hybrid`（calls/fallbacks）、`eval.decision.riskAt`；poll 结果带 `hybrid.judged/ignored/fallbacks`
- 验证：`node --test` 350/350；render-check 116/116；build-client --check、check-keys 通过

## [0.3.3] — 2026-11-08

决策模型 shadow 的问题集从 `request-v2`（isRequest noul）换成 **`ticket-v1`**（一个 `choice` 五选一：
repo_task / octo_platform / chat / context / risky）。原因：旧问题把"改 Thread.md、改 system prompt、建 thread、
查评论、排查 webhook"这类 **Octo 平台内事务**也当成工作请求，在人工回归集上会误开 12 单；五类 choice 显式
把"仓库/工作区/数据库任务"和"Octo 平台内事务"分开后，误开单归零。

- `JUDGE_QUESTIONS_VERSION` → `ticket-v1`；`p = P(repo_task)`、`riskP = P(risky)`，映射
  repo_task→开单候选、risky→拦、其余→不开；judge 客户端解析 `choice.probabilities`（缺 probabilities 时
  退回选中项）
- 选项描述文字视为契约的一部分：第一次接入时把描述改成同义表述，真实标注召回从 80% 掉到 60%，恢复原文后
  回到 80%；因此选项文字变化必须升问题集版本
- 人工回归集（25 条，`spec/shadow-golden-set.md`）：规则 12/25、旧问题集 18/25、`ticket-v1` **24/25**；
  真实 23 条标注：规则 11/23、旧问题集 13/23、`ticket-v1` **21/23（开单精确率 100%、召回 80%）**
- `shadow-collect.mjs` 重判时保留人工 `label`/`labeledAt`（此前换问题集会把 23 条标注清空，已修）
- 面板评估页 shadow 标签的 tooltip 增加五类类别
- 验证：`node --test` 342/342；render-check 116/116；build-client --check、check-keys 通过

## [0.3.2] — 2026-11-08

决策模型 shadow（落地第一步）：接单判断仍由规则（R1–R3）决定，但引擎可以把每条候选消息交给一个 System One
决策模型（阿里云百炼 `decision-model-preview`、TypeSafe Jev、Kev/Von 等同协议实现）再判一次，把模型答案记录在
`decision.shadow` 上，用于后续标注、温度拟合与 hybrid 决策。模型永远不改变接单结果。

- 新增 `lib/live/judge.js`：System One 协议客户端（`POST /v1/systemone`，`state` + `questions`），固定问题集
  `request-v1`：`isRequest`（这条消息是不是要做的活）与 `isHighRisk`（第二意见，仅记录）；带超时、HTTP 错误归一化、
  `noul` 概率解析与 `verdictOf` / `shadowOf` / `shadowErrorOf`
- 新增 `eval.mode='shadow'`：规则照常 accept/ignore 并建单；模型答案只写 `decision.shadow`
  （`status`、`p`、`riskP`、`verdict`、`ruleKind`、`latencyMs`、`questions`；失败为 `status:'error'`+`error`）
- `eval.decision` 配置：`endpoint` / `model` / `tokenFile` / `timeoutMs` / `acceptAt` / `rejectAt` / `maxPerPoll` /
  `concurrency`；越界值 clamp；token 走独立文件 `decision.token`（600），也可用 `DECISION_TOKEN` 环境变量
- 新增 `POST /superagent/api/engine/eval/token`（写/清 token，永不回显）；redacted 配置只回 `tokenConfigured`
- 引擎状态新增 `eval.decision`（配置是否就绪、问题集版本）与 `eval.judge`（calls / ok / errors / skipped / lastError）
- 每轮轮询有调用预算与并发上限；dry run（「检查新消息」）不调用模型；重放信号也会记录一次 shadow
- 面板：评估页每行显示「模型 93% · 倾向接单」标签（hover 含模型名与风险概率）；设置 → 评估只读显示模型配置
  与调用计数，`shadow` 模式有独立文案
- 新增 `scripts/judge-smoke.mjs`：不进引擎、不写状态，直接按 live.json 打通一次模型调用并打印 shadow 行
- 新增 `lib/live/shadow.js` + `scripts/shadow-collect.mjs`：批量取样（每个监听群最新 N 条消息，用同一套过滤/R2/R3
  与规则评估，再逐条问模型），样本写 `<stateDir>/shadow-samples.json`，**不写 live-state、不建工单**；默认复用上次
  答案，`--refresh` 全部重问；同时给出规则×模型交叉表、p 分布、风险分布、延迟分位与最值得人工标注的分歧列表
- 问题集 `request-v1` → `request-v2`：judge 的 state 固定为纯文本。pilot 实测把消息包成
  `{text, channel, threadTitle}` 会让「依据这个SQL，写一个视图」的 isRequest 从 0.97 掉到 0.09（同文本纯字符串
  0.97），所以 channel/threadTitle 不再进 state；需要上下文时只以文本前缀拼接

### 验证
- `node --test` 341/341（本特性 29 条：judge 10、config +2、engine shadow +8、shadow collector +8、API token +1；
  其余为 0.3.1 diff 回归；渲染回归 116/116）
- `npm run verify`：client 产物最新；702 literal keys / 513 shared / 1034 page-local 通过

## [0.3.1] — 2026-11-08

工单详情补上「查看 diff」：此前只列改动文件和 worker 总结，patch 本身不可见，操作员无法在面板里核对 worker
到底改了什么（面板「运行后端能力」矩阵里早已写着 diff 可用）。

- 新增 `lib/live/diff.js`：只读渲染一次 run 的工作树改动 —— 已跟踪修改走 `git diff <baseSha>`（工作树 vs 基线
  提交，含执行器已提交到分支的部分），未跟踪文件用 `git diff --no-index` 补成新文件段；`execFile` 传 argv，
  不经 shell
- 新增 `GET /superagent/api/engine/ticket/:id/diff?runId=&path=`（`Engine.ticketDiff`）：选最近一次带工作树的
  run；`path` 把结果收窄到单个文件（只匹配 git 自己报出的路径）。工作树/基线提交不存在时返回 `available:false` +
  `reason`，不把"读不到"伪装成"没有改动"（基线失效时退回 HEAD 并标 `baseMissing`）
- 上限与脱敏：总计 200 KB / 单文件 60 KB / 60 个文件，未跟踪文件超过 512 KB 不读；`.env`、`secrets/`、
  `node_modules/` 等 `FORBIDDEN_PATH_PATTERNS` 命中的路径不渲染
- 面板：工单详情「改动内容」里**每个改动文件名都是入口** → 点文件名只弹该文件的 patch（不是全部文件的合并
  diff）；弹窗按行着色（新增绿 / 删除红 / hunk 蓝 / 文件头加粗），带路径、±行数、run、基线 SHA、复制 diff
  与截断提示；工作树已清理时说明原因
- 回归：`diff.test.js` 覆盖按文件过滤（已跟踪/未跟踪/未知路径）、API 路由 1 条（含 `?path=` 与工作树已清理）、
  render-check 7 条（文件行入口/单文件弹窗/请求带 path/着色/摘要/关闭）

### 验证
- `node --test` 333/333
- `render-check` 115/115
- `npm run verify`：client 产物最新；715 literal keys / 513 shared / 1047 page-local 通过

## [0.2.6] — 2026-11-08

修复 R3 高风险主题的误判：`/生产|prod(uction)?/i` 做的是子串匹配，EBS 对象名 `Cux_Mtl_Sale_Products_Rpt`
里的 `Products` 被当成"生产"拦下（2026-11-08 的 `sig_502a33836cb540b6` 因此没有成为工单）。

- 风险词改成按词匹配：`/生产|(?<![A-Za-z])prod(?:uction)?(?![\w])/i` —— `生产`、`prod 环境`、`PRODUCTION 库`、
  `eBS_prod` 仍然拦；`Products`/`PRODUCT_ID`/`PROD_ID`/`procedure` 不再命中
- `pipelineVersion()` 前缀 `rules-v1` → `rules-v2`：重放是按 pipelineVersion 幂等的，只改规则内容不升版本时，
  重放会直接返回旧的 ignore 而不是按新规则重判；因此规则内容变化必须同时升前缀
- 回归测试：对象名含 `Products`/`PRODUCT_ID` 的请求 accept；`prod`/`PRODUCTION`/`生产`/`eBS_prod` 仍 highRisk；
  版本断言改为 `rules-v2`

### 验证
- `node --test` 306/306（新增 1 条边界回归）
- `npm run verify`：client 产物最新；687 literal keys / 513 shared / 1018 page-local 通过

## [0.2.5] — 2026-11-08

工单详情页三批修正（评审 21 条：8 条 P0 / 8 条 P1 / 5 条 P2），见 `spec/critique-ticket-detail-2026-11-08.md`。

### 批次一：会让页面"说了不算"的
- 锚点导航补上「自动化」，导航与滚动监听改为同一份 `DETAIL_JUMPS`（原两份清单都漏）
- 闸门阻塞时不再渲染「去处理闸门」空操作主行动——banner 自带三个决策；无主行动时菜单显示为「工单动作」
- 运行中的工单不再把「干跑执行」放主行动（挪进菜单），primary 只留给可启动的状态
- 闸门结果与 banner 同源：`pendingGate` 也渲染成"未通过 · 待处理"，不再出现"闸门未通过 + 还没有闸门结果"
- 验收时间只出现一次（页头「已验收 · 时间」），页头文案去掉重复的"验收"字样
- worker 报告里 `## 改动内容（3 个文件）` 之类的小节标题被清掉（正则原来只匹配精确标题，且匹配对象是标题文本）
- 时间统一：历史行（验收/运行/UAT 检查/时间线/活动）一律 `MM-DD HH:mm`；相对时间只用于"更新于"和调度
- 时间轴/活动行图标、时间、文案之间补间距（`.sa-event-actor` 加 flex gap）

### 批次二：噪音与重复
- 空的「闸门结果」「活动」section 不再渲染；活动流折进「时间线」的一条 disclosure
- 无 MR/UAT 时验收压成一句提示，不再两张空卡 + 禁用链接 + 解释句
- 自动化卡折成一行 disclosure（默认收起）；「保存自动化」只在表单与已存配置不同时出现
- 闸门失败策略（人工/自动修复）在 section 级说一次，不再每个闸门挂一个标签
- 阶段链路去掉截断 id；运行记录的短 run id 改成可复制的复制按钮

### 批次三：排版
- 「改动内容」在宽屏拆两栏：左 = 执行总结（72ch 阅读列），右 = 改动文件 + 需求折叠；空出来的右半边不再白着，窄屏回落单列（`@container (min-width: 1000px)`）
- 改动文件超过 5 个时先显示 5 个 + 「显示更多（共 N 个）」，展开后可「收起」；切到另一张工单时自动回到收起态
- 详情页头部重排：验收状态 + 时间 + 「查看验收」移到工单标题右侧；「打开 MR」/「工单动作」收进标题行右上角，原先标题下的整行验收说明与独立行动行删除（页面少了两行）。无主行动时右上角仍是带文字的「工单动作」
- 验收卡片 `auto-fit`，宽屏不再留第三列空洞
- 元数据 KV 与验收卡的两列布局保持到 640px（768 不再被过早压成单列）
- 详情阶段链路改为单行 breadcrumb（触发 › 评估 › 工单 › 执行 › 闸门 3/3 › #28 · 已合并 › UAT 可访问），窄屏去分隔符；顺带修掉 `<ol>` 的 40px 默认缩进
- 自动化卡的次数/时间字段限宽 200px，不再拉满整卡

### 验证
- `node --test` 305/305；`render-check` 107/107（新增：锚点含自动化、自动化折叠与脏保存、活动折叠进时间线、空闸门区不渲染、阶段链路无截断 id、改动内容两栏、头部标题行含验收说明与动作、文件列表收起/展开）；`build-client --check`、`check-keys` 通过
- 视觉验收：1440/1024/768/390 + 深色 + 闸门阻塞/运行中/已验收三状态；页面高度（1440）从 ~4200px 降到 ~3050px

## [0.2.4] — 2026-11-08

执行页视图控件的重做：分组方式 / 排序 / 显示已结束从「两个 260px 胶囊轨道 + 小灰标签 + 黑开关」的两行表单，收成一行真正的列表工具条。

### 设计/操作面
- 阶段筛选改为同行计数 chip（`sa-segmented-chips`）：每个阶段一枚 chip，计数在 chip 内，只有选中项着色——不再是一条横贯全宽、像第二个 tab 栏的胶囊轨道
- 分组与排序改为带标签的取值按钮（`Menu` 新增 `text` 形态）：按钮上直接写明「分组 按阶段」「排序 最近更新」，点开是带勾选的二选一菜单；不再需要「分组方式 / 排序」两个小灰标签各配一条胶囊
- 三个控件并进一行（阶段 chip 左、视图选项右、中间细分隔线），一行放不下时视图选项自然换行且左对齐；≤560 两列网格 + 独占一行的开关
- 「显示已结束」改用紧凑开关（30×18），与 28px 控件同高，不再是在白色页面上最抢眼的黑色胶囊
- 空列表时不渲染这行控件（与旧阶段胶囊一致）
- 同一套 chip 顺手用到评估页（决定类型 + 时间窗口，替换原 `Pill` 胶囊）与触发页（线程筛选），三页筛选行现在同一外观；删掉已无调用的 `Pill` 控件与 `.sa-pill` 样式

### 验证
- `node --test` 305/305；`render-check` 95/95（新增：chip 内计数、两个取值按钮的当前值、开关仍在、评估/触发筛选同为 chip）；`build-client --check`、`check-keys` 通过
- 真实浏览器（headless Chrome + 宿主主题 token + 真实 live 夹具）1440/1024/960/820/768/390 六档截图、深色主题、英文、菜单展开、按仓库分组、空列表八种状态逐一看过
- 本轮宿主侧无改动；面板刷新页面即生效

## [0.2.3] — 2026-11-07

第三轮收口：清掉 0.2.2 剩下的 P3，只做一致性、可读性和验证，不扩展功能。

- 来源页去掉独有的 PageHead，恢复为与其它页一致的 tab + section 结构；摘要行保留
- 设置页在 ≥960px 把 140px 导航 + 760px 表单作为一组居中，不再在右侧留下约 400px 空白；表单 max-width 680→760
- 删除 `SegmentedTabs` 中未被 CSS/标记消费的 `data-more` 测量状态，减少死代码
- 390 设置分组行高 36→40，移动头部菜单触发目标 36→40；tabs/菜单保持更大命中区
- 验证：1440 表单居中（body x≈560 / 760 宽）；720px 宽度无横向溢出；`prefers-reduced-motion: reduce` 匹配；深色主题切换后页面背景 `rgb(21,21,23)`、无横向溢出

## [0.2.2] — 2026-11-07

第二轮设计复评后的修正：把 0.2.1 过度收缩的执行控件改成真正的紧凑工具栏，补齐窄屏导航的可见性，并统一关闭态。

### 操作面
- 执行页在 1024/390 恢复紧凑工具栏：1024 首条工单从 y≈708 提升到 y≈507；390 从 y≈868 提升到 y≈794；阶段 pill 在 1024 为 6 列、390 为 3×2，均无裁切
- 执行页自动化条改为 compact（隐藏说明行），automation bar 出现时隐藏重复的“已暂停”badge 和执行器 hint
- Octo token「清除令牌」改为带后果说明的确认弹窗，与仓库 token 清除一致
- 390 设置子标签由单行横向滚动改为两行换行，7 个分组全部可见
- 工单详情窄屏恢复 sticky context（截断标题+状态），并加 IntersectionObserver 滚动联动；分区跳转高度提升到 32px
- 来源页增加页面级自动化条；关闭态卡片不再逐张重复“已禁用”，有 token 时 dry-run 可继续使用
- 来源 GitLab 卡片在 1024 改为 1-up 容器查询；概览“运行质量”回到左列，不再形成三列等宽
- ≤600px 头部四个图标收进“更多操作”菜单，图标目标 36px；移动端 tabs 最小 40px
- 自动化条显示“配置 3/4”进度；完成案摘要改为“共 8 张：5 已验收、3 已忽略；其中 3 张在失败重试后完成”

### 验证
- `node --test` 305/305；`render-check` 90/90；`build-client --check`、`check-keys` 通过
- 隔离 CDP：1024 执行首条 y≈507、390 首条 y≈794；390 设置 nav 两行；来源 1024 一列卡片；源/执行自动化条无溢出
- 面板检测器仍为 0 条 `.sa-*`；仅 DSH 宿主 2 条既有项

## [0.2.1] — 2026-11-07

设计评审后的操作面打磨：把"三个开关、四个说法"收敛成一个自动化状态，并修掉 1024/390 下的三处响应式断裂。

### 设计/操作面
- 概览与执行页共用「自动化未启动」状态条：一次确认即可恢复处理、启用引擎、启用执行器；引擎只差开关时不再同时出现暂停条、首次配置卡和系统问题三条重复提示
- 首次配置卡只在配置前置项未完成时占主位；有历史数据时退化为一行，避免教程压住值班信息
- 执行页控件改为标签+控件成组：≥960px 一行，窄屏每组一行；六个阶段筛选在 390 下改为多行网格，不再裁掉「已结束」
- 设置页在 ≤960px 从 260px 竖排导航改为可横向滚动的子标签，表单不再被导航推到首屏之外；表单正文宽度收窄
- 触发页窄屏：线程行出现「›」打开提示；未进入详情前不再显示虚假的选中底色；1280/1440 保持双栏
- 执行台账：已验收行用成功勾、失败后忽略用警告标识，不再全部显示空心 idle；MR 编号统一为 `MR #n`
- 来源页增加页面标题与统一的「已启用 x/y」摘要；去掉 `live.json 未启用` 这类实现细节
- 工单详情窄屏分区导航改为单行横向滚动；正文 measure 限制 72ch
- 概览漏斗去掉与步骤重复的总结行，只保留出站失败这个新增信息
- 头部术语表按钮与其他图标按钮统一为 outlined；自动化条内直接给出「检查新消息」文字入口

### 验证
- `node --test` 305/305；`render-check` 90/90；`build-client --check` 与 `check-keys` 通过
- 隔离 CDP：1440/1024/390 三档实测；检查了设置导航、执行工具栏、阶段筛选、触发紧凑布局、自动化条与确认启动、工单详情分区导航
- 确定性检测器：复核面板 `.sa-*` findings（工具栏/导航/选中行），并保留 host chrome 两条既有项

## [0.2.0] — 2026-11-07

首个产品化版本：把面板从"只读仪表盘"升级为可运营的主动型 agent 控制台。

### P0 — 可信与止血
- `run.stopReason/errorCode` 结构化失败；worker 事件 → `run.trace`
- 闸门失败不再直接判死：park 为 `waiting_for_human` + `pendingGate`，面板可「放行 / 重试该闸门 / 终止」
- 插件重载后的中断运行标记为 `interrupted`（可继续执行），不再一律 `failed`
- `inbox.json` 持久待办（gate/accept/failure/source/engine），支持已读/已解决；概览按阻塞程度排序
- 工单行 3-tag 预算、分组按注意力成本、验收与工单状态解耦、详情 404/500 分离

### P1 — 分层与可复盘
- `signal-log.json`：每个候选（含被过滤/跳过）落库，decision 带 `pipelineVersion/verdicts/actorKind`；可按当前规则重放
- `operations.json` 运行台账：trigger/handoff/usage/report/checkpoint/trace 外置，`live-state.json` 只留索引行
- `acceptance.json` 验收轮次：program checks、证据、`delivered/failed/errored`、人审决定与 intents
- worker 报告工具（`superagent_report_progress/artifact/set_verify/ask_human`）；`ask_human` 暂停为 `awaiting-answer`，回答后带 Q/A 重跑
- 检查点续跑、工单活动流、执行页视图选项（按阶段/仓库、排序、显示已结束、sessionStorage）

### P2 — 主动与观察
- 工单级自动执行：固定间隔 / 每天 HH:mm / 次数上限 / nextAt / lastSkipReason；触发原因 `heartbeat|schedule`
- GitLab 观察升级：MR `headSha`、只采用匹配 head 的 pipeline、`pipeline.stale` 不覆盖结论、draft/WIP 跳过、自动巡检 3 次/headSha
- signal 人工标注（correct/false_wake/missed_wake/cleared）与来源页计数
- gate `onFail: manual|auto_repair` + `executor.maxRepairRounds`（0..3）：失败门全为 auto_repair 且非 errored 时，同一 worktree 自动 repair worker 并重跑 gates
- 设置页只读 worker 能力矩阵（DSH/Codex/Claude × 流式事件/审批/会话恢复/diff/报告工具）
- `GET engine/metrics`：24h/7d/all 运行质量（成功/失败/停止/中断/等待、时长 p50/p95、触发方式、Top 失败原因、按仓库、验收轮次/通过率、信号标注）；概览「运行质量」卡片。token/成本数据待宿主提供。

### 验证
- `node --test` 305/305；`render-check` 90/90；`build-client --check` 与 `check-keys` 通过
- 隔离 CDP 实例真实渲染冒烟：概览运行质量、执行页视图选项、工单详情自动化卡片、设置页能力矩阵、验收/MR 状态

### 已知边界
- 仍未实现：agent/llm 验收验证器与评分 rubric、Goal、多通道（GitHub/飞书/企微）、多 agent 编排、token/成本聚合
- `@deepseek-ai/dsh-tools` 为 peerDependency；宿主缺失时 worker 报告工具静默跳过
- 状态目录 `~/.dsh/superagent`；`spec/` 与 `verification/` 为本地文档/截图，不入库
