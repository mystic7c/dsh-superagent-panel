# Changelog

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
