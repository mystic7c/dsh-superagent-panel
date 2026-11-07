# Changelog

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
