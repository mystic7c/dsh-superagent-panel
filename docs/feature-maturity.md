# 功能成熟度

本文件是功能成熟度的完整清单，非安装必读；安装与面板概览见 [README](../README.md)，逐页说明见 [pages.md](pages.md)。

| 级别 | 含义 |
| --- | --- |
| **稳定** | 有单测/渲染回归与真实跑通记录（下面"真实可用"） |
| **可用但未生产验证** | 代码与单测存在，本机尚无生产运行记录（如 CLI worker） |
| **部分/未实现** | 明确列出，不在面板里假装可用 |

**真实可用**：Octo 群轮询（sync）、规则评估 R1–R3、工单生命周期、DSH 进程内 worker、GitLab MR/CI/部署/UAT
观测、多仓库与群→仓库绑定、人工验收/忽略/重试、搜索、术语表、配置原子写；
**P2**：工单级自动执行（`automation`：fixed interval / 每天 HH:mm / maxExecutions / nextAt / lastSkipReason；触发原因 heartbeat|schedule）、
GitLab 观察升级（MR headSha、只采用匹配 head 的 pipeline、不匹配写 `pipeline.stale` 不覆盖结论、draft/WIP 跳过、自动巡检 3 次/headSha——仅 CI 仓库；`verifyMode=manual` 的仓库一直巡检到 MR 合并/关闭）、
signal 人工标注（correct/false_wake/missed_wake/cleared + 来源页标注菜单与计数）；
**P2 第二批**：gate 可配 `onFail:'manual'|'auto_repair'`（默认 manual）与 `executor.maxRepairRounds`（0..6，默认 1；分阶段返工默认 2，设置 → 运行「返工预算」可改）——失败门全为 auto_repair 且非 errored（超时/命令跑不起来）时，同一 worktree 自动跑 repair worker 并重跑 gates，每轮写 activity，最终记录 `run.repair`/`run.repairs` 与验收轮次 `onFail/repair`；retry 不自动修，publish 失败会把闸门证据交给 worker 自动修复并重跑（最多 `executor.maxRepairRounds` 轮，成功才继续 commit/push/MR）。设置→Worker 新增只读「运行后端能力」矩阵（DSH/Codex/Claude × 流式事件/审批/会话恢复/diff/报告工具）。
**P2 第三批**：`GET engine/metrics?window=24h|7d|all` 聚合运行质量（成功/失败/停止/中断/等待、时长 avg/p50/p95、触发方式、停止原因、Top 失败原因、按仓库、验收轮次/通过率、信号与标注）；概览「运行质量」卡片。token/成本数据宿主尚未提供（`cost.available=false`）。
失败原因结构化（`run.stopReason/errorCode`）、worker 执行事件轨迹（`run.trace`，≤80 条）、
闸门失败暂停并由人「放行/重试该闸门/终止」、插件重载把中断运行标为 `interrupted` 并可「继续执行」（checkpoint：gates/commit/push/MR 阶段复用 worktree）、
待办箱（gate/accept/failure/source/engine，已读/已解决）、注意力成本排序与验收/阶段解耦；
**P1**：原始信号层（每个候选含被过滤/跳过都落 `signal-log.json`，可按当前规则「重放」，判定带 `pipelineVersion`）、
运行台账（`operations.json` + trigger/handoff/usage/report/checkpoint，`live-state.json` 只留索引行）、
验收轮次（`acceptance.json`：plan/逐项 program checks/证据/人审决定与 intents）、工单活动流、
worker 任务工具（`superagent_report_progress/artifact/set_verify/ask_human`；`ask_human` 会暂停工单，回答后带 Q/A 重跑）、
执行页视图选项（sessionStorage 持久化）、
工单改动 diff（`GET engine/ticket/:id/diff`：`git diff <base>` + 未跟踪文件，只读、带上限、跳过敏感路径；
详情页「改动内容」点文件名看单文件 patch，工作树被清理时说明原因）、
工单追加要求（详情页输入 → `POST engine/ticket/:id/revision` 追加 `revisions[]` 并以干跑重跑；
worker task 按序携带最近 10 条修订，保留上一轮 worktree 改动）。

**多后端路由（P1）**：`executor.workers` 可同时启用 DSH / Codex / Claude，`executor.routing`（`single|suggest|auto`、`defaultBackend`、`fallback`、`preferences`）按任务类型分发：
- 任务类型由关键词分类为 analysis / review / test / dev / docs / research / interactive；硬约束优先——联网调研与需提问只能 DSH，测试验证不能 Claude；
- 多后端时默认 `suggest`：只把「建议谁执行」写进运行记录，仍用默认后端执行；切到 `auto` 才真正按路由运行（设置→Worker 可切，或直接改 live.json）；
- 每张工单的 `run.route` / `ticket.route` 记录 workType、backend、profile、reason（preference/default/fallback/manual）；运行记录显示「后端 · 类型」标签，建议模式同时给出本次实际后端；
- 只读档位按适配器收紧：Codex `-s read-only`、Claude `--permission-mode plan`、DSH 工具 guard 禁止写文件；analysis/review/research/interactive 无文件改动时交付报告并结束为 `closed`，不提交、不推送；
- 手动改派：`POST engine/ticket/:id/run` 的 body 可带 `backend: "dsh"|"codex"|"claude"`，覆盖路由并记为 manual。
- **worker 对自己发起的 run 负责**：worker 可以起 subagent 做独立复核；harness 的 `agent/turn-stopping` 边界
  （在 `turn/end` 提交前 await）会用 `subagents.listDescendants + waitForChildren` join 仍在运行的子代理，
  子代理结果落回 worker inbox 后再跑下一步，直到没有 live child 才允许结束本轮——不会再把"等待复核"当最终总结。

**部分可用**：Codex CLI / Claude Code CLI worker（代码与单测存在，本机尚无生产运行记录）；手动验收仓库
只观测 MR 合入，不做 UAT 指纹；多仓库的部署健康检查以各仓库配置为准。

**未实现或旧模型**：GitHub/飞书来源；按模型阈值改判（hybrid）与 LLM 逐条评估（`eval.mode=llm` 仍只被配置层
接受；本轮的 signal 判定仍是规则版，shadow 模型只记录意见）；
线程订阅管理；requeue/重新评估；（工单停止已实现：运行中经 worker/CLI 进程组信号取消并在提交、推送前检查，排队中直接终止；见「可用」一节）
并发修订冲突检测（有本地快照回滚，但不做多端合并）；demo 种子；`gh` setup check；
设置页的模型目录选择。README 旧版本把这些状态写反了，以上面清单为准。

**P1 的诚实边界**：worker 四个报告工具依赖宿主提供 `@deepseek-ai/dsh-tools`（peerDependency）；缺失时工具静默跳过，面板只是没有报告区。
`ask_human` 的恢复是「带此前 Q/A 重跑整单」，不是同一会话续跑（headless worker 无持久 handle）。验收轮次目前只有 `program` 检查（三闸门），
不做 agent/llm 判据、评分 rubric 或验收流程图。`signal-log.json` 的 payload 7 天后清空但行保留；证据行（有 decision/trigger 引用）不清理。
