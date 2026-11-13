# 2026-11 评审改进的落地契约

本文记录 `docs/product-review-2026-11.md` 六项改进在本版本实现的行为边界；README 只保留摘要。

## 1. 交付目标、能力与后端分离

- `lib/live/routing.js` 先判定 **交付物**（`change` / `report`）和 **所需能力**（`edit` / `exec` / `web` / `report`），
  再选择后端（`dsh` / `codex` / `claude`）。标题/正文里同时出现「修复」和「分析」时不再降级为报告。
- 显式只读文案（只分析、不要修改、只读、read-only 等）保持 `report`；显式修改动词（修复、实现、新增、重构等）
  保持 `change`。能力仍会拒绝无法满足的后端，并给出 `missing-<cap>` 提示。
- `POST engine/route` 返回预览；建单表单可覆盖交付物与后端，选择保存在 `ticket.routeSelection`，执行时
  `run.route` 快照实际使用的交付物/能力/后端。人工覆盖不能绕过能力检查。

## 2. 停止与两种暂停

- `paused` 仍是旧的总体暂停（等于同时暂停接单与派发）。
- `pausedIntake` 停止读取新消息，来源游标不前进，恢复后消息仍会到达；`pausedDispatch` 不启动新运行，但保留队列
  与在跑任务。
- 运行停止会贯穿当前 worker/CLI/闸门子进程：`POST engine/ticket/:id/stop` 写入 `ticket.stopRequested`，执行器轮询后
  通过 `AbortSignal` 终止 DSH agent、CLI 子进程或正在跑的闸门命令（SIGTERM，2–3 秒后 SIGKILL），并在动作边界
  （导出、闸门、提交、推送、PR）再次检查；停止后保留工作树、不进入后续动作。CLI worker 以独立进程组启动，
  取消与超时都终止整个进程组，避免已脱离 CLI 的命令继续改工作树。worker/子进程真正结束后才写入
  `ticket.stop.confirmedAt` 并清除请求标记，界面在确认前显示「正在停止」。恢复后按已完成动作继续；推送前把
  `pushRequest`（分支/SHA/模式）落盘，恢复或重启后先按远端分支 SHA 对账，远端不可读时保留 `unknown` 并拒绝
  盲目重推，发布路径同样复用已经送达的 HEAD。

## 3/5. 交付证据与持久证据包

- 工单详情把「已推送」「等待创建 PR」「已确认 PR 编号」「已合并」「已部署」「已验收」分开投影（`delivery`）。
  `/pull/new/` 链接只表示已推送并等待 PR，不代表 PR 已创建。
- 合并判定仍使用 `git merge-base --is-ancestor`（merge commit 语义）；平台查询失败时保留未知状态。
- `lib/live/evidence.js` 按工单保存有界、脱敏的证据轮次（默认 20 轮）：分支/base/head、文件、可截断 patch、
  闸门结果、worker 总结、验收要求、人工决定与平台证据。不依赖 operations 的保留窗口，工作树删除后仍可读。
  文件列表因上限或脱敏被截短时记录 `filesOmitted`/`filesRedacted`，patch 保留 `truncated`/`bytes`，截断与缺失
  在界面上可见。
- `GET engine/evidence/:ticketId` 与 `/compare?from=&to=` 提供相邻轮次比较；只在对应侧文件列表完整时推断新增/
  删除，否则列入「无法确认」。比较同时给出基线变化（base SHA）、未重跑的闸门、沿用旧代码的闸门（HEAD 已变化但
  `at`/state 相同）与仍未通过的闸门；缺少历史时界面明确提示，不推断已修复。

## 4. 日志查询

- 评估页支持服务端 `q`（文本）、`repo`、`reason`、`from`/`to`、`kind`、`window`、`view`（全部分歧/人工改判），
  筛选在分页前执行；`offset`/`limit` 超过一页时 `total` 仍准确，并有上一页/下一页。
- 来源页的原始信号支持文本、状态、仓库、原因与时间范围筛选及分页；触发页的线程列表支持文本、仓库、
  最新/历史原因与最后活动时间范围筛选及分页；三页的筛选都在服务端分页前执行，并把查询写入 URL。
  评估页另提供模型与规则分歧、人工改判两个视图，分组不会把不同信号/模型意见/人工决定的记录折叠为一条。
- 评估筛选写入 URL（`evalKind`/`evalWindow`/`evalQ`/`evalRepo`/`evalReason`/`evalView`/`evalOffset` 等，
  `history.replaceState` 保留宿主参数），刷新、前进/后退与从详情返回可恢复；记录仍关联原始信号/线程/工单/运行。
- 评估记录链接到 `page/source?id=<signalId>`：来源页经 `GET engine/signal/:id` 解析并显示定位卡片（正文、工单/
  线程跳转、原始行高亮）；信号已被清理时明确提示原文不可用。来源与触发页在离开时记住 `.sa-scroll` 位置，返回
  并加载数据后恢复，不因整页重新挂载跳回顶部。

## 6. 仓库与闸门编辑

- `POST engine/repo/:id` 可改名称、本地路径、分支、验证方式、验收方式、GitLab 目标与闸门；仓库 `id`、令牌、
  历史引用不变。`enabled: false` 后不再接收/派发新任务，在跑任务与历史查询不受影响。
- 闸门必须是数组且 `name` 唯一，`command` 非空单行，`cwd` 只能指向仓库内相对路径；非法配置整体拒绝，
  不静默回退为默认闸门。
- 设置页编辑弹窗展示当前值与保存前差异（名称/路径/闸门），保存后写入 `live-history` 快照，可回滚。令牌不回显。
- 仓库卡片「测试配置」只执行固定只读检查：live.json 可读、Node 版本、本地路径存在、令牌是否配置（值不回显）、
  一次平台 GET 连通性、仓库启用状态。它不执行用户配置的闸门、不建单、不启动 worker、不触发远程写操作。

## 未覆盖边界

- GitHub 已支持只读 REST 查询（按 head 分支认领 opened/merged/closed PR）；仍不通过 GitHub 写接口合并或部署，
  `/pull/new/` 之后最终以 `auto-pr.yml` 与 merge commit 祖先关系为准。部署流水线按 MR 的 merge commit SHA
  精确匹配；匹配不到时证据保留 `waiting-for-pipeline`/`unknown` 与 `matchesHead: false`，不提升为已部署。
- 真实 CLI 取消与远程平台动作在本次验证中未执行；停止的进程组终止、动作边界、推送响应丢失后的远端核对与
  部署 SHA 关联以单元测试覆盖，不作为真实进程/平台验证。

## 复核补强（0.4.31）

- 停止：排队工单在请求停止时立即结束排队并写明 `ticket.stop.confirmedAt`，不再停留在 `queued + stopRequested`；
  重启发现的遗留 `stopRequested` 在 `reconcile` 中一并确认；再次停止返回已停止（`alreadyStopped:true`）而不是 409，不会长期显示「正在停止」。
- 恢复：停止步骤保留检查点阶段，`stopped` 运行与 `interrupted` 运行共用恢复入口；恢复从闸门/提交/推送/MR 继续，
  代码指纹变化仍会使旧闸门结果失效。
- 交付证据：只有 `webUrl`、没有 `iid`/`mode` 的旧 push 记录也投影为 `waiting`（已推送，等待创建 PR），不会再显示
  「PR 已创建」；部署 `matchesHead` 按 `deployment.sha` 与 `deployment.commit` 比较，缺少时回退到分支 HEAD，
  不再把功能分支 HEAD 与 MR merge commit 直接对比。
- 证据包：合法 JSON 但 `rounds` 缺失/损坏的证据文件会被归一为空轮次并标 `recovered`，详情与 API 不因损坏文件 500；
  报告型交付同样保存 worker 总结与交付事实（base/head 可以为空）。
- 调度：停用仓库在 `automationSkipReason` 阶段即跳过，不再计一次执行或写「定时触发」活动。
- 路由：人工选择的后端缺少所需能力时保留选择并返回 `unsupported`，建单接口直接 400 拒绝；预览、保存与 executor
  使用同一判定，人工覆盖不能绕过能力上限。
- 运行配置：run 记录 `repo` 快照（id/kind/baseBranch/verifyMode/createMr/ci/闸门名等），便于回溯当时的配置。
