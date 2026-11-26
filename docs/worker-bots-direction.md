> **状态**：1.5.0 实现方案。可交互原型：`../worker-bot-prototype.html`（`#bots` / `#execution` / `#dispatch`）。
> 本文描述 1.5.0 起的派单与后端形态，是这一版的实现依据；与旧文档冲突时以本文为准。

# Worker + Bot：派单与后端

## 一句话

派单只筛一条硬事实——**后端此刻可用**；选谁由模型读 **Bot 自己写的那段说明**来答。Bot 只描述「我是谁、什么样的活派给我」，不描述能力、不申请权限。危险行为在系统层处理。

## 1. 三层

| 层 | 是什么 | 住在哪 | 谁改 |
| --- | --- | --- | --- |
| 后端 / 环境 | 这台机器上有没有可跑的执行环境 | `executor.workers.<backend>` + 探针证据 | 设置 → 模型与后端 |
| Bot | 身份 + 一句话说明 + 什么样的活派给它 | `<stateDir>/worker-bots.json`（0600） | Bot 页编辑器 |
| run | 一次执行的可追责记录 | 每单的 run 记录 | 引擎写 |

配置里只放人真正知道的事实：这个 Bot 叫什么、干什么、什么样的活派给它。其余（能不能跑、该给谁）由代码判定，判不了就如实降级。

## 2. 派单

三层收敛：**显式 → 挑选 → 默认**。

### 2.1 显式（按单/按仓库指定）

| 来源 | 字段 | 语义 |
| --- | --- | --- |
| 仓库指定 | `repos[].bot` | 这个仓库的活永远交给它，跳过挑选 |
| 工单指定 | `ticket.botOverride` | 只对这一单生效 |

两种都是例外：写它们的理由永远是「我知道的比模型多」。归一化沿用 `lib/live/repos.js:119-122`。

### 2.2 候选（代码判定）

候选 = 所有 Bot 中，**后端此刻可用** 的那部分：

- `dsh`：预设能解析（进程内探针，免费，引擎启动时跑一次）
- CLI 后端：`<stateDir>/backend-verify.json` 有冒烟证据，且 CLI 版本未变（变了即失效，等自动复核）

没有别的过滤条件——预算很紧、只写报告的 Bot 都进候选。「它不该接这单」写在说明里。

### 2.3 挑选（一次模型调用）

- **输入**：每个候选的 `name` / `description` / `whenToUse`，加工单标题与正文（截断 4000 字）。
- **输出**：`{"botId": "...", "because": "一句话"}` 或 `{"botId": null}`。
- **校验**：`botId` 必须在候选集合内，否则按失败处理（不猜、不就近选）。
- **不调模型**：候选只有 1 个 → 直接就是它；缓存命中（`dispatch.cacheSeconds`，默认 600 秒）；已在显式层命中。
- **缓存 key**：`sha256(候选 id 序列 + 每个候选的 whenToUse 摘要 + 工单标题正文摘要)`。改了任何一段说明，旧答案立即失效。
- **用哪个模型**：现有决策模型（`eval.decision.endpoint` / `model` / `tokenFile` / `timeoutMs`），不新增模型配置。它负责「这单该不该做」，也负责「这单该谁做」。
- **限流**：沿用 `dispatch.maxPerPoll`；超出的单排到下一轮，先按默认 Bot 记账。

### 2.4 降级

| 情况 | 结果 | `run.dispatch.degraded` |
| --- | --- | --- |
| 模型不可用 / 超时 | 默认 Bot（`executor.bot`） | `pick-unavailable` |
| 调用失败 / 返回不可解析 | 默认 Bot | `pick-failed` |
| 返回候选外的 id | 默认 Bot | `pick-invalid` |
| 答「都不合适」 | 默认 Bot | `pick-none` |
| 候选为空 | 默认 Bot | `no-candidate` |
| 显式 / 单候选 / 缓存 | 相应 Bot | 不记 |

降级必须可见：run 详情与 Bot 统计都要能看出这一单没经过挑选。

### 2.5 run 里存什么

```jsonc
"dispatch": {
  "source": "explicit-repo" | "explicit-ticket" | "pick" | "default",
  "candidates": ["generalist", "reviewer", "dsh-plugin-dev"],
  "picked": "generalist",
  "because": "这单改 web-app 前端；reviewer 的说明写明只评审",
  "cacheHit": false,
  "degraded": null
}
```

存下「当时有哪些候选」是关键：说明改了以后，旧单为什么是那个答案仍然对得上。

## 3. Bot 契约（`worker-bots.json` v3）

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 小写 kebab，稳定不变 |
| `name` | string | 显示名 |
| `description` | string ≤120 | 一句话说明，给**人**扫列表用 |
| `whenToUse` | string ≤300 | 什么样的活派给我、什么样的别派。挑选时读的就是它 |
| `prompt.role` | string | 角色提示词，执行时注入 |
| `backend` | `dsh` \| `claude` \| `codex` | 默认后端 |
| `model` | `{provider, model}` | 可选覆盖，缺省跟随执行器 |
| `preset` | string | 可选，DSH 预设 |
| `skills` | object | 可选偏好 |
| `budget` | `{timeoutMs, idleTimeoutMs, maxRepairRounds}` | 可选。范围 60s–2h / 60s–1h / 0–6，缺省继承执行器。只有时间与次数，不提供 token / 金额预算 |

- 文件版本 `BOT_FILE_VERSION = 3`。
- 内置只有两个：`generalist`（通用实现）与 `reviewer`（只评审）。`BOT_BUILTIN_IDS = ['generalist', 'reviewer']`。
- 内核只从 `<stateDir>/worker-bots.json` 读，worktree 里的同名文件忽略。
- `budget` 不在编辑器里给输入框，只在详情里只读显示继承来的值。

## 4. 探针

`backendAvailability()` 返回四态之一 + 一句原因：

| 状态 | 含义 | 派单 |
| --- | --- | --- |
| `available` | 探针通过 | 进候选 |
| `unverified` | 没有证据 | 不进候选 |
| `checking` | 版本变了，复核中 | 不进候选 |
| `missing` | CLI 不在 | 不进候选 |

核验时机：保存后端配置后自动跑一次、引擎启动时跑一次；人工只在失败时介入。原因要写清是哪一条——CLI 不在 / 版本变了 / 没有冒烟证据。

## 5. 系统层约束

Bot 拿全部工具，「只读」是执行器的事，不是 Bot 的属性：

- **报告类 run**（`deliverable === 'report'`）由执行器置 `readOnly`（`resolveBot` 的 `context.readOnly`）：改动不落盘、不提交、不推送。
- **闸门**（`standards` / `backend` / `frontend`）与沙箱边界是唯一的交付裁决权。
- **拒绝规则**：危险命令、越界路径在这里拦，Bot 不参与、也不申请权限。
- UI 口径：不承诺隔离，工具面是契约不是沙箱。

## 6. UI

| 页签 | 内容 |
| --- | --- |
| Bot | 左列表（内置 / 自建 / 待沉淀）；右详情五项 + 预算只读：名称、后端、一句话说明、什么时候派给它、角色提示词；「谁会把活派给它」只读区（默认 Bot / 仓库指定 / 工单手动指定）；最近表现（通过率、平均返工、闸门通过率、中位耗时、最近一次）；待沉淀列表（`adhoc:<hash>` 出现 ≥3 次，点击预填编辑器，不自动写入） |
| 执行 | 三层逐条命中理由：1 EXPLICIT / 2 PICK / 3 DEFAULT；「这一单如果没有仓库指定」展示候选、模型读到什么、答案与理由；「为什么不是它们」；后端不可用时理由写清原因 |
| 设置 → 派单 | 候选怎么来、怎么选、什么时候不调模型、失败怎么办、危险行为在哪拦；两种显式指定 |
| 设置 → 模型与后端 | 三张后端卡（`派单 可用` / `复核期间跳过` + 原因 + CLI 路径 + 核验时间）；默认后端与降级后端（降级只在派单时生效，运行中不重试） |

## 7. 迁移与回滚

1. 首次启动读 v2 文件：未知键丢弃并在启动日志列一次 `droppedKeys`；写回时升 v3。
2. 写回前备份 `worker-bots.json.bak`。旧版本读 v3 会丢弃 `whenToUse`，回滚必须用备份恢复——这是唯一不可自动补救的降级。
3. `live.json` 里失效的派单键读时忽略、写回一次净值，日志各提示一行。
4. 指向已移除内置 id（`surgical`）的 `repos[].bot` 与 `ticket.botOverride` 加载时丢弃并记 warning，这一单落到默认 Bot，不报错。

## 8. 切片

| 切片 | 工作量 | 内容 | 验收 |
| --- | --- | --- | --- |
| **P0 契约** | 0.5 天 | `BOT_FILE_VERSION` 3、`whenToUse` 归一化与校验、内置名单收敛为两个、迁移与 `.bak`、`normalizeDispatch` 只留缓存/限流/adhoc 三个旋钮 | `worker-bot.test.js`：`whenToUse` 超长被拒、v2 加载后键进 `droppedKeys`、`BOT_BUILTIN_IDS` 不再含 `surgical`；`config.test.js`：dispatch 只剩 `cacheSeconds` / `maxPerPoll` / `adhoc` / `adhocOrder`、指向 `surgical` 的 `repos[].bot` 被丢弃 |
| **P1 派单** | 1 天 | 候选（`backendAvailability`）→ 显式 → 单候选短路 → 缓存 → 决策模型 → `validateChoice` → 兜底；run 记 `dispatch` | 新增 `dispatch.test.js`：候选不含未核验后端；单候选不发起调用；同单二次命中缓存；返回候选外 id → `pick-invalid` 且落默认；五种 `degraded` 码各一例 |
| **P2 Bot 页** | 1 天 | `whenToUse` 编辑；认领只读区；统计聚合（`run.botId` + `run.bot` 快照）；待沉淀列表 | API 测试：`POST /engine/bots` 接受 `whenToUse`、拒绝超长；统计接口无 run 时返回空结构 |
| **P3 核验与理由** | 0.5 天 | 保存后端与引擎启动各自动核验；四态与原因细化；执行页三层理由文案 | `backend-capability.test.js`：CLI 版本变化使旧证据失效；原因字符串包含具体原因 |

顺序 P0 → P1：候选口径依赖 P0 的契约。

## 9. 已定

1. **移除内置 `surgical`**：内置留 `generalist` 与 `reviewer`，两个各有真实差别。
2. **`whenToUse` 与 `description` 都保留**：前者给模型判归属，后者给人扫列表，一段文字服务不了两边。
3. **缓存 key 含 `whenToUse` 摘要**：改说明即失效。
4. **只做时间与次数预算**：不提供 token / 金额预算。
