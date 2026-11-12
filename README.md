# dsh-superagent-panel

Superagent 管理面板 —— 一个带**左侧栏入口**的 DeepSeek Harness 插件：在 Web UI 里打开「超级智能体」面板，
管理主动型编码智能体（Superagent）的工单、来源、触发、评估、执行器与部署配置。

面板的页面划分与交互参考
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)；宿主侧按原型的数据/API
契约重新实现为**可持久化、可写、与本机 DSH 同源**的本地管理服务。

**当前版本：0.4.27**（版本历史见 [CHANGELOG.md](CHANGELOG.md)；0.4.13 起交付走 GitFlow：工单分支 feature→develop，release/hotfix 走独立分支）。
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

## 进阶能力

- **评估与接单**：`eval.mode='hybrid'` 试点、群消息复核（评估确认）与决策模型 shadow 的配置、阈值、预算与实验记录见
  [docs/intake-and-eval.md](docs/intake-and-eval.md)。
- **功能成熟度**：稳定 / 可用但未生产验证 / 部分或未实现的分级、P1/P2 批次与诚实边界见
  [docs/feature-maturity.md](docs/feature-maturity.md)。

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
node --test lib/store.test.js lib/live/*.test.js   # Host 测试（当前 398 个）
node scripts/check-keys.mjs            # 双语 key 覆盖检查
node scripts/render-check.mjs          # jsdom 渲染回归（当前 138/138）
node scripts/isolated-verify.mjs       # 隔离 DSH + Chrome headless CDP 实机验证（需本机 Chrome）
node scripts/verify-panel.mjs capture  # 需要 CDP 9222 的隔离 DSH 实例；截图到 verification/
```

`npm run test` 等价于 Host 测试，`npm run verify` 等价于构建产物与 i18n 校验。`spec/` 与 `verification/` 是本地
设计/验收材料（gitignore），不随插件分发。

改客户端后刷新页面；改 Host 半（`index.js`/`lib`）后在 Plugin Manager 里禁用→启用该插件（或重启 DSH）。

## 用面板开发本仓库（自开发）

本仓库也注册为 `live.json` 的受管仓库（id `dsh-superagent-panel`），可以「用面板开发面板」：执行页手工建单 →
执行器在 worktree 里让 worker 改代码 → 跑 6 个闸门 → 推送 `feature/<ticketId>` → GitHub Actions 开 PR →
人工评审合并 → 面板巡检到合入后等人验收。

6 个闸门：`syntax`、`client-build`、`i18n`、`host-tests`、`render`、`isolated`。
完整操作细节（`live.json` 仓库配置与字段语义、GitFlow、闸门表、交付流程、状态流转与失败处理、入口、本机稳定安装、
隔离实例验证、常见坑）见 [docs/self-development.md](docs/self-development.md)；仓库给 Agent 的交付规则见
[AGENTS.md](AGENTS.md)。

## 卸载

```bash
plugin_manager remove_bundle target=@mystic7c/dsh-superagent-panel
```

状态目录 `~/.dsh/superagent` 不会被删除，可手动清理。

## License

MIT

分阶段 Worker 配置与验证边界见 [docs/staged-workers.md](docs/staged-workers.md)。
