# Changelog

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
