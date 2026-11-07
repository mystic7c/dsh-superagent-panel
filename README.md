# dsh-superagent-panel

Superagent 管理面板 —— 一个带**左侧栏入口**的 DeepSeek Harness 插件：在 Web UI 里打开「超级智能体」面板，
管理主动型编码智能体（Superagent）的工单、来源、触发、评估、执行器与部署配置。

面板的页面划分与交互参考
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)；宿主侧按原型的数据/API
契约重新实现为**可持久化、可写、与本机 DSH 同源**的本地管理服务。

## 功能

| 页 | 内容 |
|---|---|
| 概览 | 值班摘要：**待办箱**（闸门/验收/失败/来源/引擎，可已读）→ 正在执行 → 系统问题 → 24 小时漏斗、策略规则与系统脉搏；首次使用时显示四步配置清单 |
| 来源 | Octo 消息源与每个仓库的执行面：24h 到达/过滤/接单、被过滤消息、**原始信号（含跳过/忽略/失败，可重放，可人工标注正确/误报/漏报）**、健康检查、检查新消息 |
| 触发 | 线程列表与详情：评估过程、消息时间线、决定与规则明细 |
| 评估 | 决定列表（接单/忽略）与命中规则；只读 |
| 执行 | 执行器负载、工单队列台账（等待人优先）、**视图选项（按阶段/按仓库、排序、显示已结束）**、手工建单、工单详情；**每张工单可配置自动执行（固定间隔 / 每天 HH:mm / 次数上限；显示下次运行与跳过原因）**；闸门失败停在「等人放行/重试该闸门/终止」，中断运行可「继续执行」，worker 提问可「回答」；运行记录含 trigger/停止原因/handoff/执行轨迹/报告/验收轮次/活动流；MR 卡显示「草稿」「过期 CI」提示 |
| 设置 | 来源（Octo token、监听群、触发人名单、轮询、绑定）/ 运行 / 写权限 / 仓库（token、新增仓库）/ 变更历史 可写；评估与提示词为只读参考 |

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
   新卡片上保存 GitLab token。闸门命令、超时、worktree 等更细字段仍可在 `live.json` 中补充（设置页提供
   「复制路径」和示例）。
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
- 设置页可写：来源（token、群绑定、轮询、允许任意人类/发送者名单）、运行（执行器开关/自动执行/暂停/worker
  后端/MR 方式）、写权限（推送/回群/合并）、仓库（GitLab token、新增仓库定义）、变更历史（查看/恢复快照）。
  编辑/删除已有仓库、闸门命令、超时、worktree、UAT/健康检查地址、gate `onFail/repairHint`、
  `executor.maxRepairRounds` 等更细字段仍通过 `live.json` 配置；工单自动化在工单详情页配置。
- 手动 `live.json` 修改后，使用设置页「重载配置」让引擎重新读取。

## 能力边界

**真实可用**：Octo 群轮询（sync）、规则评估 R1–R3、工单生命周期、DSH 进程内 worker、GitLab MR/CI/部署/UAT
观测、多仓库与群→仓库绑定、人工验收/忽略/重试、搜索、术语表、配置原子写；
**P2**：工单级自动执行（`automation`：fixed interval / 每天 HH:mm / maxExecutions / nextAt / lastSkipReason；触发原因 heartbeat|schedule）、
GitLab 观察升级（MR headSha、只采用匹配 head 的 pipeline、不匹配写 `pipeline.stale` 不覆盖结论、draft/WIP 跳过、自动巡检 3 次/headSha 上限）、
signal 人工标注（correct/false_wake/missed_wake/cleared + 来源页标注菜单与计数）；
**P2 第二批**：gate 可配 `onFail:'manual'|'auto_repair'`（默认 manual）与 `executor.maxRepairRounds`（0..3，默认 1）——失败门全为 auto_repair 且非 errored（超时/命令跑不起来）时，同一 worktree 自动跑 repair worker 并重跑 gates，每轮写 activity，最终记录 `run.repair`/`run.repairs` 与验收轮次 `onFail/repair`；retry/publish 不自动修。设置→运行新增只读「运行后端能力」矩阵（DSH/Codex/Claude × 流式事件/审批/会话恢复/diff/报告工具）。
失败原因结构化（`run.stopReason/errorCode`）、worker 执行事件轨迹（`run.trace`，≤80 条）、
闸门失败暂停并由人「放行/重试该闸门/终止」、插件重载把中断运行标为 `interrupted` 并可「继续执行」（checkpoint：gates/commit/push/MR 阶段复用 worktree）、
待办箱（gate/accept/failure/source/engine，已读/已解决）、注意力成本排序与验收/阶段解耦；
**P1**：原始信号层（每个候选含被过滤/跳过都落 `signal-log.json`，可按当前规则「重放」，判定带 `pipelineVersion`）、
运行台账（`operations.json` + trigger/handoff/usage/report/checkpoint，`live-state.json` 只留索引行）、
验收轮次（`acceptance.json`：plan/逐项 program checks/证据/人审决定与 intents）、工单活动流、
worker 任务工具（`superagent_report_progress/artifact/set_verify/ask_human`；`ask_human` 会暂停工单，回答后带 Q/A 重跑）、
执行页视图选项（sessionStorage 持久化）。

**部分可用**：Codex CLI / Claude Code CLI worker（代码与单测存在，本机尚无生产运行记录）；手动验收仓库
只观测 MR 合入，不做 UAT 指纹；多仓库的部署健康检查以各仓库配置为准。

**未实现或旧模型**：GitHub/飞书来源；LLM 评估（`eval.mode=llm` 会被配置层接受，但引擎始终使用规则评估；本轮的 signal 判定仍是规则版）；
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
└── live/           真实引擎：配置、评估、执行器、GitLab/Octo 客户端、待办箱（inbox.js）、
                    原始信号（signals.js）、运行台账（operations.js）、验收轮次（acceptance.js）、
                    worker 报告工具（worker-tools.js）、活动流（activities.js）、工单调度（schedule.js）
client/src/*.js     客户端源码（有序纯 JS 片段，按文件名拼接）
client/index.js     构建产物（单文件 ModuleLoader bundle）
scripts/            构建与验收脚本（build-client / verify-panel / render-check …）
locale/             插件清单文案（中/英）
cordis.patch.yml    插件注册（insert 行）
```

## 开发

```bash
node scripts/build-client.mjs          # 从 client/src 生成 client/index.js
node scripts/build-client.mjs --check  # 校验产物是否最新
node --check index.js                  # Host 半语法检查
node --test lib/store.test.js lib/live/*.test.js   # Host 测试
node scripts/check-keys.mjs            # 双语 key 覆盖检查
```

改客户端后刷新页面；改 Host 半（`index.js`/`lib`）后在 Plugin Manager 里禁用→启用该插件（或重启 DSH）。

## 卸载

```bash
plugin_manager remove_bundle target=@mystic7c/dsh-superagent-panel
```

状态目录 `~/.dsh/superagent` 不会被删除，可手动清理。

## License

MIT
