# dsh-superagent-panel

Superagent 管理面板 —— 一个带**左侧栏入口**的 DeepSeek Harness 插件：在 Web UI 里打开「超级智能体」面板，
管理主动型编码智能体（Superagent）的工单、来源、触发、评估、执行器与部署配置。

面板的页面划分与交互参考
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)；宿主侧按原型的数据/API
契约重新实现为**可持久化、可写、与本机 DSH 同源**的本地管理服务。

**当前版本：0.4.8**（0.4.8 是一次系统设计评审后的修正：闸门结果按 run 实际记录的闸门渲染、概览「失败后被忽略」
可深链到执行页新增的「已忽略」切片、来源与执行器状态口径统一、390 窄屏与对比度/键盘焦点问题；
0.4.7/0.4.6 修复运行记录终态与动作菜单，0.4.4 用 `agent/turn-stopping` 让 worker 对自己发起的 run 负责；
版本历史见 [CHANGELOG.md](CHANGELOG.md)）。
运行可复盘、闸门可停、待办可寻址、任务可自动化、验收与信号有独立台账。设计参照来自对
[LobeHub（CAO 平台）](https://github.com/lobehub/lobehub) 的研究（本地报告 `spec/lobehub-research-2026-11.md`，
不随插件分发）。

## 功能

| 页 | 内容 |
|---|---|
| 概览 | 值班摘要：**待办箱**（闸门/验收/干跑待发布/失败/来源/引擎，可已读）→ 正在执行 → 系统问题 → 24 小时漏斗、**运行质量**（成功率/平均耗时/自动修复/Top 失败原因）、策略规则与系统脉搏；首次使用时显示四步配置清单 |
| 来源 | Octo 消息源与每个仓库的执行面：24h 到达/过滤/接单、被过滤消息、**原始信号（含跳过/忽略/失败，可重放，可人工标注正确/误报/漏报）**、健康检查、检查新消息 |
| 触发 | 线程列表与详情：评估过程、消息时间线、决定与规则明细 |
| 评估 | 决定列表（接单/忽略）与命中规则；shadow 模式另显示模型意见；只读 |
| 执行 | 执行器负载、工单队列台账（等待人优先）、**视图选项（按阶段/按仓库、排序、显示已结束）**、**「已忽略」切片（失败后被人放弃的工单）**、手工建单、工单详情；**每张工单可配置自动执行（固定间隔 / 每天 HH:mm / 次数上限；显示下次运行与跳过原因）**；闸门失败停在「等人放行/重试该闸门/终止」，中断运行可「继续执行」，worker 提问可「回答」；运行记录含 trigger/停止原因/handoff/执行轨迹/报告/验收轮次/活动流、**改动 diff（点文件名看该文件的 patch，按工作树按需读取）**、**追加要求（输入后自动干跑重跑，保留工作树改动）**、干跑完成后主行动为「发布 MR」；MR 卡显示「草稿」「过期 CI」提示 |
| 设置 | 来源（Octo token、监听群、触发人名单、轮询、绑定）/ 运行（执行器开关、自动执行、暂停、MR 方式、执行超时）/ Worker（多后端启用、路由模式与任务类型偏好、模型/CLI 路径、能力矩阵）/ 写权限 / 仓库（token、新增仓库）/ 变更历史 可写；评估与提示词为只读参考 |

首次安装后状态为空（不是演示种子）。设置 → 来源里可完成 Octo token 保存、从群列表选择监听群、
编辑允许的触发人并绑定仓库；设置 → 仓库可用向导新增仓库（本地路径、GitLab 项目、验证方式），再在仓库卡片上
保存 GitLab token。闸门命令、超时、worktree 等更细的字段仍在 `live.json` 中配置；每次保存前会自动生成可回滚快照。

## 安装

前置：DSH（含 Web UI）、Node.js ≥ 18。

```bash
# 在 DSH 会话中让 agent 执行，或通过 Plugin Manager 安装该目录
plugin_manager install_bundle target=<本仓库目录>
```

安装后左侧栏出现「超级智能体」入口。插件以 `link:` 方式安装到 profile，本地改动即时可见。

## 5 分钟接入

1. **准备环境**：本机可执行 `octo-cli`；准备一个有 bot 的 Octo 群和 bot token；准备仓库的本地 clone；
   GitLab PAT（`api` 或 `read_api`，按是否需要写 MR/合并决定）。
2. **保存 Octo token**：设置 → 来源 → Octo token → 粘贴并保存。保存到本机 token 文件（权限 600），不会回显。
3. **添加监听群**：设置 → 来源 → 「从群列表选择」，或手工填写群 chatId；再选择接单仓库并保存绑定。
4. **配置仓库**：设置 → 仓库「添加仓库」填写本地路径、GitLab 地址/project、分支、验证/验收方式；保存后在
   新卡片上保存 GitLab token。闸门命令、worktree 等更细字段仍可在 `live.json` 中补充（设置页提供「复制路径」和示例）。
5. **打开引擎**：设置 → 来源打开「启用引擎」并保存；设置 → 运行打开执行器并按需开启自动执行。
6. **验证**：点顶部「检查新消息」做一次试运行（不写入状态），再到群里发一条明确请求；概览、触发、执行会出现
   对应记录。首次轮询会初始化游标，不会回放历史消息。

## 状态与配置

- 状态目录：`~/.dsh/superagent`（环境变量 `DSH_SUPERAGENT_STATE_DIR` 可覆盖）。
- 配置文件：`live.json`（运行配置，mode 600）；`live-state.json`（引擎记录，勿手改；`runs` 只存索引行）；
  `inbox.json`（待办项派生与已读/已解决状态，可删，重启后按 `live-state.json` 重建）；
  `signal-log.json`（原始信号 + 判定，含被过滤/跳过；payload 7 天后清空、证据行豁免）；
  `operations.json`（运行台账：steps/trace/gates/report/checkpoint，保留最近 500 条）；
  `acceptance.json`（每个工单的验收轮次与逐项检查/人审决定）；
  `runs/<runId>.report.jsonl`（worker 工具写入的报告；运行结束并入 operations）；
  `live-history/`（每次写入前的配置快照，mode 600，保留最近 30 份，可在设置→变更历史里回滚）；
  `state.json`（旧管理层的空文档，面板不使用）。
- 令牌文件：`octo.token` 与每个仓库的 `gitlab-*.token`（均为 600，面板不回显）。
- 本插件没有演示种子：首次启动创建空状态；`POST /superagent/api/demo/reset` 只会清空回空状态。
- 设置页可写：来源（token、群绑定、轮询、允许任意人类/发送者名单）、评估确认（启用/范围/允许回复的操作人/
  有效期）、运行（执行器开关/自动执行/暂停/MR 方式/执行超时）、
  Worker（多后端启用、路由模式/默认/降级/任务类型偏好、模型/CLI 路径）、写权限（推送/回群/合并）、仓库（GitLab token、新增仓库定义）、变更历史（查看/恢复快照）。
  编辑/删除已有仓库、闸门命令、worktree、UAT/健康检查地址、gate `onFail/repairHint`、
  `executor.maxRepairRounds` 等更细字段仍通过 `live.json` 配置；工单自动化在工单详情页配置。
- 手动 `live.json` 修改后，使用设置页「重载配置」让引擎重新读取。

## hybrid 接单试点（0.3.4）

`eval.mode='hybrid'` 时，规则仍然是第一道门，模型参与 R1 的"要不要开单"：

1. **R2/R3 规则硬闸不变**：来源/身份/高风险/上下文判断照旧；规则忽略的消息不会调用模型。
2. 规则接单的消息交给 `ticket-v2` 模型（`repo_task` 的描述包含带 procedure/报表/接口、参数与定时规则的需求说明）：
   - `repo_task` 且 `p ≥ eval.decision.acceptAt`（默认 0.5，按 pilot 标注校准）→ **自动开单**（后续和普通工单一样执行）；
   - `risky` 或 `riskP ≥ eval.decision.riskAt`（默认 0.5）→ 忽略，原因 `modelRisk`（高风险转人工）；
   - 其他类别（octo_platform / chat / context）→ 忽略，原因 `modelSkip`；
   - `repo_task` 但概率落在中间区 → 忽略，原因 `modelUncertain`。
3. **人工兜底**：`modelRisk / modelSkip / modelUncertain` 都会落成可重放的原始信号（来源页可见）；
   点重放会用规则重新判定并建单——这是模型的"人工否决覆盖"通道。
4. **失败与预算**：模型报错、或单轮 `maxPerPoll` 预算用完 → 回退到规则的 accept，不会静默丢掉工作；
   dry run（「检查新消息」）会调用模型，预览真实行为但不写状态。
5. 面板评估页的模型标签同时支持 shadow 和 hybrid 决策；设置 → 评估显示 `hybrid` 模式与调用/回退计数。
6. 阈值依据：真实标注里该开单的 `P(repo_task)` 最低 0.71、不该开单的最高 0.26，因此默认 `acceptAt=0.5`
   留出两侧余量；很短的"修复：xxx"有时只给 0.4–0.5，会进 `modelUncertain`（来源页可重放），不会静默丢单。

```json
{
  "eval": {
    "mode": "hybrid",
    "decision": {
      "endpoint": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
      "model": "decision-model-preview",
      "acceptAt": 0.8, "rejectAt": 0.2, "riskAt": 0.5, "maxPerPoll": 10
    }
  }
}
```

## 评估确认（群消息复核，0.4.2）

打开后，**每一条被评估的消息**（规则接单、规则忽略、模型否决都算）都会回发到来源群一条确认消息：

```
Superagent: 评估 #A7K2
消息：需求：库存出入库流水表…数据传BI…
规则：接单 · 模型：repo_task 0.97 → 建议接单
工单：tkt_xxx（已排队，等你确认后执行）
回复「接单 A7K2」或「忽略 A7K2」
```

操作人在群里回复短码即可：

| 回复 | 引擎原结论 | 动作 |
|---|---|---|
| `接单 A7K2` | 忽略/模型否决 | 用规则重放该信号建单（规则硬拦的高风险仍不建单） |
| `接单 A7K2` | 已接单、工单排队 | 立即执行该工单 |
| `忽略 A7K2` | 已接单、工单排队 | 撤销（dismiss）该工单 |
| `忽略 A7K2` | 忽略/模型否决 | 记录你的判断 |

- 每次回复都会写成 `decision.humanReview` 和信号标签（`correct / false_wake / missed_wake`），直接成为
  规则 vs 模型的校准数据。
- 回复消息在正常 intake 之前被拦截，不会被当成新需求；机器人自己的通知以 `Superagent:` 开头，也会被自回复
  过滤，不会循环。
- **严格 gate 由 `executor.autoRun` 控制**：把它设为 `false` 时，新工单只会排队，只有你回复"接单"才会执行；
  设为 `true` 时照常自动执行，确认消息只作为反馈/撤销不了已开始的工单。
- 没回复的评估 24 小时后过期（`review.expireHours`）。
- **设置 → 评估确认**可写：启用开关、确认范围（all / uncertain）、允许回复的操作人（Octo uid，逗号/换行分隔，
  留空 = 没人能回复）、回复有效期（1–168 小时）；保存后下一轮轮询生效。

```json
{
  "review": {
    "enabled": true,
    "scope": "all",
    "allowSenderIds": ["<你的 Octo uid>"],
    "expireHours": 24
  },
  "executor": { "autoRun": false }
}
```

`scope` 可选 `all`（所有评估）或 `uncertain`（只发规则/模型分歧与模型否决的消息，减少群噪声）。

## 决策模型 shadow（可选，落地第一步）

接单判断仍由规则（R1–R3）决定。要让一个 System One 决策模型（阿里云百炼 `decision-model-preview`、
TypeSafe Jev、Kev/Von 等同一协议实现）对每条候选消息再判一次，把 `live.json` 的评估段改成：

```json
{
  "eval": {
    "mode": "shadow",
    "decision": {
      "endpoint": "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone",
      "model": "decision-model-preview",
      "timeoutMs": 6000,
      "acceptAt": 0.8,
      "rejectAt": 0.2,
      "maxPerPoll": 10,
      "concurrency": 2
    }
  }
}
```

- **token**：写到 `~/.dsh/superagent/decision.token`（600），或设置 `DECISION_TOKEN`；也可以
  `POST /superagent/api/engine/eval/token`（body `{"token":"..."}`）写入文件。面板永不回显 token。
- **先冒烟**：`node scripts/judge-smoke.mjs --text "修复：收款单保存时校验银行账户必填"` —— 不进引擎、不写状态，
  打印模型原始答案和将会记录的 shadow 行。
- **批量取样（建议先做这个）**：`node scripts/shadow-collect.mjs --limit 100` 读取每个监听群最新 100 条消息，
  用与接单完全相同的过滤与规则评估，再逐条问模型；结果写 `<stateDir>/shadow-samples.json`（600）。
  它**不写 live-state、不建工单**；默认复用上次答案，`--refresh` 全部重问，`--json` 打印全量样本。
- **state 只能是纯文本**：pilot 实测把消息包进 `{text, channel, threadTitle}` 会让一条明确请求的概率
  从 0.97 掉到 0.09；judge 只发纯文本消息（需要上下文时也只以文本前缀拼接，不序列化成对象）。
- **问题集 `ticket-v2`**：一个 `choice` 五选一 —— `repo_task`（仓库/工作区/数据库任务）/ `octo_platform`
  （Octo 平台内事务）/ `chat` / `context` / `risky`。`p = P(repo_task)`（开单候选），`riskP = P(risky)`（高风险），
  其余归"不开"。选项描述文字是问题集契约的一部分（实测同义改写会让召回从 80% 掉到 60%），改文字必须升版本。
  人工回归集（25 条）与真实标注（24 条）上：`ticket-v2` 完全正确 24/25 与 22/24，开单精确率均为 100%。
  （`ticket-v2` 修复了 2026-11-09 一条真实需求被误判 `context` 的线上漏单。）
- **标签会保留**：`shadow-collect.mjs` 重判时会保留已有人工 `label`，换问题集不会清空标注集。
- **记录什么**：每条 decision 的 `shadow` 字段：`status`、`p`（isRequest 概率）、`riskP`、`verdict`
  （accept / reject / uncertain）、`ruleKind`（规则当时的结果）、`latencyMs`、`questions` 版本；失败是
  `status:'error'` + `error`。模型答案不改变 kind、reason、工单。
- **面板**：评估页每行多一个「模型 93% · 倾向接单」标签（hover 看模型与风险概率）；设置 → 评估只读显示
  模型地址/模型名/token 是否就绪，以及本次进程的调用计数（成功 / 失败 / 跳过）。
- **预算**：每轮轮询最多判 `maxPerPoll` 条、并发 `concurrency` 条，超出的跳过（`eval.judge.skipped` 计数）。
  dry run（「检查新消息」）不调用模型。
- **下一步**：用原始信号的标签（正确/误报/漏报）积累 500–1000 条中文标注集，拟合温度并定阈值后才考虑
  hybrid（按模型阈值决定接单）；在那之前 `eval.mode` 只有 `rules` 和 `shadow` 两种有效行为。

## 功能成熟度

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
**P2 第二批**：gate 可配 `onFail:'manual'|'auto_repair'`（默认 manual）与 `executor.maxRepairRounds`（0..3，默认 1）——失败门全为 auto_repair 且非 errored（超时/命令跑不起来）时，同一 worktree 自动跑 repair worker 并重跑 gates，每轮写 activity，最终记录 `run.repair`/`run.repairs` 与验收轮次 `onFail/repair`；retry 不自动修，publish 失败会把闸门证据交给 worker 自动修复并重跑（最多 `executor.maxRepairRounds` 轮，成功才继续 commit/push/MR）。设置→Worker 新增只读「运行后端能力」矩阵（DSH/Codex/Claude × 流式事件/审批/会话恢复/diff/报告工具）。
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
线程订阅管理；任意工单停止（只有闸门暂停的工单可以终止）；requeue/重新评估；
并发修订冲突检测（有本地快照回滚，但不做多端合并）；demo 种子；`gh` setup check；
设置页的模型目录选择。README 旧版本把这些状态写反了，以上面清单为准。

**P1 的诚实边界**：worker 四个报告工具依赖宿主提供 `@deepseek-ai/dsh-tools`（peerDependency）；缺失时工具静默跳过，面板只是没有报告区。
`ask_human` 的恢复是「带此前 Q/A 重跑整单」，不是同一会话续跑（headless worker 无持久 handle）。验收轮次目前只有 `program` 检查（三闸门），
不做 agent/llm 判据、评分 rubric 或验收流程图。`signal-log.json` 的 payload 7 天后清空但行保留；证据行（有 decision/trigger 引用）不清理。

## 目录结构

```
index.js            Host 半：/superagent/api 路由、状态装载与动作分发
lib/
├── store.js        单文档 JSON 持久化（temp+rename 原子写、串行化读改写、损坏备份）
├── seed.js         空状态与旧演示种子（演示种子当前不再使用）
├── views.js        旧管理层的只读投影（当前客户端不使用）
├── actions.js      旧管理层的写操作（当前客户端不使用）
├── prompts.js      提示词模型（旧管理层）
└── live/           真实引擎：配置、规则评估（eval.js）、决策模型 shadow（judge.js）、执行器、
                    GitLab/Octo 客户端、待办箱（inbox.js）、原始信号（signals.js）、
                    运行台账（operations.js）、验收轮次（acceptance.js）、
                    worker 报告工具（worker-tools.js）、活动流（activities.js）、工单调度（schedule.js）
client/src/*.js     客户端源码（有序纯 JS 片段，按文件名拼接）
client/index.js     构建产物（单文件 ModuleLoader bundle）
scripts/            构建与验收脚本（build-client / verify-panel / render-check …）
locale/             插件清单文案（中/英）
cordis.patch.yml    插件注册（insert 行）
CHANGELOG.md        版本与能力变更记录
```

## 开发与验证

```bash
node scripts/build-client.mjs          # 从 client/src 生成 client/index.js
node scripts/build-client.mjs --check  # 校验产物是否最新
node --check index.js                  # Host 半语法检查
node --test lib/store.test.js lib/live/*.test.js   # Host 测试（当前 396 个）
node scripts/check-keys.mjs            # 双语 key 覆盖检查
node scripts/render-check.mjs          # jsdom 渲染回归（当前 138/138）
node scripts/verify-panel.mjs capture  # 需要 CDP 9222 的隔离 DSH 实例；截图到 verification/
```

`npm run test` 等价于 Host 测试，`npm run verify` 等价于构建产物与 i18n 校验。`spec/` 与 `verification/` 是本地
设计/验收材料（gitignore），不随插件分发。

改客户端后刷新页面；改 Host 半（`index.js`/`lib`）后在 Plugin Manager 里禁用→启用该插件（或重启 DSH）。

## 用面板开发本仓库（自开发）

本仓库也在 `live.json` 的 `repos[]` 里注册成一个受管仓库（id `dsh-superagent-panel`），所以可以「用面板开发面板」：
执行页手工建单 → 执行器在 git worktree 里让 worker 改代码 → 跑 5 个闸门 → 提交并推送 `feature/<ticketId>` →
GitHub Actions 自动开 PR → 人工评审合并 → 面板巡检到合入后等人验收。配置在 `live.json`（默认
`~/.dsh/superagent/live.json`，`DSH_SUPERAGENT_STATE_DIR` 可改状态目录）的仓库项里，关键字段如下
（只列关键字段；本机路径、`timeoutMs` 等从略）：

### 仓库配置（`live.json`）

```json
{
  "id": "dsh-superagent-panel",
  "baseBranch": "main",
  "verifyMode": "manual",
  "acceptance": "merged",
  "gates": [
    { "name": "syntax", "command": "node --check index.js" },
    { "name": "client-build", "command": "node scripts/build-client.mjs --check" },
    { "name": "i18n", "command": "node scripts/check-keys.mjs" },
    { "name": "host-tests", "command": "node --test lib/store.test.js lib/live/*.test.js" },
    { "name": "render", "command": "node scripts/render-check.mjs" }
  ],
  "gitlab": {
    "baseUrl": "https://github.com",
    "project": "mystic7c/dsh-superagent-panel",
    "targetBranch": "main",
    "createMr": "push",
    "ci": false
  }
}
```

- **`verifyMode: "manual"`**：不做 CI/UAT 观察，只认一个远端事实——工单的提交是否已合入 `main`
  （`git merge-base --is-ancestor <commit> origin/main`）。本仓库只有 `pull/new` 链接、没有 MR iid，所以合并判定
  实际走 ancestry。
- **`acceptance: "merged"`**：合入不等于完成。工单到 `merged` 后阶段仍是「等待人」，要在工单详情的「验收」
  里点「验收通过」（或记录拒绝原因打回）才会离开待处理列表。
- **`createMr: "push"`**：执行器只推 `feature/<ticketId>` 分支，不通过 API 建 MR；GitHub 不消费 GitLab 的
  `merge_request.*` push options（实测带 options 的推送还会被服务端拒绝），推送输出里的
  `.../pull/new/<branch>` 链接会被面板解析成 pending MR。
- **`ci: false`**：本仓库没有面板可观察的 CI 流水线，发布后直接从 `working` 进入 `mr-open`，不经过 `ci-pending`。
- 字段名沿用面板的 `gitlab.*`（即使仓库托管在 GitHub）；`baseUrl` 指向 github.com 时执行器不带 GitLab push
  options，PR 交给 `.github/workflows/auto-pr.yml`。

5 个闸门由执行器按顺序执行，任一失败就停下，不会继续提交或推送（失败门保留 exit code、超时标记与输出末尾）：

| 闸门 | 命令 | 验证什么 |
| --- | --- | --- |
| `syntax` | `node --check index.js` | Host 半 `index.js` 语法 |
| `client-build` | `node scripts/build-client.mjs --check` | `client/index.js` 与 `client/src/` 是否同步（改了源码没重建就失败） |
| `i18n` | `node scripts/check-keys.mjs` | 客户端用到的文案 key 都存在，且中英文词典 key 一致 |
| `host-tests` | `node --test lib/store.test.js lib/live/*.test.js` | Host 全量单测（当前 398 个） |
| `render` | `node scripts/render-check.mjs` | jsdom 渲染回归（jsdom/React 来自 `/tmp/sa-harness`） |

### 交付流程

1. 执行器为工单开 worktree，worker 只改工作树、不提交；交付前执行器核对改动（feature 分支前缀、受保护路径，
   见 `protectedPaths`）。
2. 闸门全部通过后提交并推送 `feature/<ticketId>` 到 `github.com/mystic7c/dsh-superagent-panel`。
3. 推送输出里的 `pull/new/<branch>` 链接被面板解析为 pending MR，工单进入 `mr-open`；没解析到链接时停在
   `pushed`（已推送、缺 MR），需要到 GitHub 上按分支手动开 PR。
4. `.github/workflows/auto-pr.yml` 在 `feature/**` 分支出现后自动 `gh pr create --base main`（幂等：已有 PR 就
   跳过），PR 由人评审。
5. **合并请用 merge commit，不要 squash 或 rebase（fast-forward 可以）。** 面板用 `git merge-base --is-ancestor`
   判断提交是否已进入 `main`；squash/rebase 会重写 commit，ancestry 判定不到，工单会一直停在 `mr-open`。

### 状态流转与失败处理

`queued`（建单）→ `working`（执行中）→ `mr-open`（已推送、待评审合并）→ `merged`（巡检发现合入，阶段仍是
「等待人」）→ 人工验收（记录 `links.acceptance` 后算完成）。

- 失败分支：闸门未通过停在 `gate-blocked`（可「重试该闸门」「放行」「终止」）；worker/提交/推送失败进入 `failed`。
- 失败时先看工单详情的「闸门结果」：失败门带 exit code 与是否超时；闸门暂停（`gate-blocked`）时横幅里能展开并
  复制失败输出末尾。运行记录保留同一次 run 的闸门、执行轨迹与报告，据此修复后重试。
- `live.json` 顶层的 `executor.autoRun` 为 `false`：手工建单只会进队列，不会自动开跑，执行与发布由人在工单详情
  触发。

### 入口

执行页 →「手工建单」→ 仓库下拉选择 **DSH Superagent Panel**（`live.json` 的默认仓库是 `demo-legacy-repo`，别沿用默认），
填写标题与需求后创建；工单随后按上面的流程推进。自开发的典型操作路径是：手工建单 → 工单详情「干跑执行」
（worker 改工作树、跑闸门、不推送）→ 确认改动后「发布 MR」（重跑闸门再提交、推送）。

## 卸载

```bash
plugin_manager remove_bundle target=@mystic7c/dsh-superagent-panel
```

状态目录 `~/.dsh/superagent` 不会被删除，可手动清理。

## License

MIT
