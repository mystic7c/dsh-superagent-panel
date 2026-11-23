# Worker Bot 规范（Worker Bots Specification）

状态：**草案 v3**（评审用）。v3 只改「叫什么、怎么分层」：实体从「档位（profile）」改名为 **Bot（bot）**，随之改名的有字段、配置键、错误码、文件名与 UI 文案，迁移映射见附录 C；§3–§18 的规则不变。

实现进度：P0–P3 已按 v2 落地（v1.0.15–v1.0.17），v1.0.18 补齐 §3.2/§3.5/§4.1/§9.3/§12 的四处断线与五处反向实现，v1.0.19 完成附录 C 的代码改名（代码、配置键、错误码、文件名、UI 文案、`run.bot`），v1.0.20 让探针在真实宿主上可用（§3.3），v1.0.21 落地 §10.2 阶段级 Bot 与阶段级预算，v1.0.22 按 §18 的结论收敛分派口径（不自动选 `requires` 为空的 Bot、决策模型看到的工单带 `truncated`、阶段条目记 Bot），v1.0.23 补上 P6 的阶段编排 UI（逐阶段 Bot 与预算、preset 只读下拉、详情页显示阶段 Bot）。已知缺口：CLI 后端的增量事件与 §11 C1–C10（P4/P5）；`stale` 只在宿主提供版本时可达（§3.7 末段）。切片顺序见 §17。

v2 重写了能力模型（§3）：能力必须带证据，不承认任何写死的后端能力表；后端拆成独立上线单元，`dsh` 先完整落地，`claude` / `codex` 各自后续上线（§3.7、§17）。

与 `docs/worker-bots.md` 的关系：那份是设计稿，解释**为什么**这么设计（取舍、借鉴、被否掉的方案）；本文件只写**必须怎样**（数据形态、算法、错误码、验收）。两份冲突时以本文件为准；设计动机回设计稿查，不重复。

实现锚点按 v1.0.13（`1c915b2`）核对；行号随代码漂移，以符号名为准。

---

## 0. 规范用语

`MUST` / `MUST NOT` / `SHOULD` / `MAY` 按 RFC 2119 解释。本文的「实现」指 `dsh-superagent-panel` 的 `lib/live/*`（Host 半）与 `client/src/*`（面板半）。

定义两个术语以免歧义：

- **保存期**：写入 `worker-bots.json` 或 `live.json` 的那一刻。校验失败 = 写入被拒绝。
- **分派期**：一次 run 开始、决定用哪个 Bot 之前。校验失败 = 该 Bot 不可被选中（不是报错退出）。

---

## 1. 术语

| 术语 | 含义 |
| --- | --- |
| **Bot（bot）** | 用户定义的执行者，面向**一类相对固定、会反复出现的工作**：身份（`name` / `description` / `prompt.role`）+ 能力（后端、模型、思考深度、preset、工具/MCP 白名单、Skill 偏好）+ 执行预算 + 阶段集合。Bot 是定义，不是进程 |
| **worker** | 一次 run 的执行实例：进程/会话、worktree、trace 与交付动作。每次 run 按选中的 Bot 实例化，run 结束即结束 |
| **run** | 一次工单执行的不可分割单元：一个 worktree、一条可追责记录、一组阶段。会话复用（§11）的边界是 run |
| **staged workerflow** | `assess → plan → implement → gates → review` 五阶段流水（`lib/live/workflow.js:2` `STAGES`） |
| **能力（capability）** | `edit` / `exec` / `web` 三元组；`report` 是交付形态不是能力（§3.1） |
| **分派（dispatch）** | 在 run 开始前把工单映射到一个 Bot，并记录理由 |
| **ad-hoc Bot** | 没有合适 Bot 时现合成的、一次性的 Bot，id 形如 `adhoc:<hash8>` |
| **stateDir** | 插件状态目录（默认 `~/.dsh/superagent`）：`live.json`、`live-state.json`、`operations.json` 所在处 |
| **worktree** | 执行器为该 run 建的 git worktree；worker 的 cwd |
| **闸门（gate）** | 仓库级校验命令（`repos.js` 的 `repo.gates`），不是工单可自定义的东西 |

分层自外向内：**工单 → 分派（选 Bot）→ Bot（定义）→ worker（实例）→ run（记录）→ 交付（归执行器）**。Bot 不持有调度（何时跑由来源、触发与工单决定），也不持有交付权（I6）。

---

## 2. 不变量（I1–I9）

违反任一条的实现视为不合格，评审以此为准。每条给出**可验证方式**。

| # | 不变量 | 验证方式 |
| --- | --- | --- |
| I1 | **会话的边界是 run，不是工单。** run 内（主轮 → 返工轮 → 各阶段）可在同一 worktree 上续传同一 CLI 会话；跨 run 一律新会话、新上下文。run 内续传 MUST NOT 跨 worktree 或跨闸门边界。 | 单测：同一 run 两次调用共用 session id；不同 run 的 id 不同。集成：返工一轮后 CLI `--resume` 出现且 worktree 路径未变 |
| I2 | **Bot 是声明，不是代码。** 归一化按白名单（照 `config.js` 的 `mergeConfig` 风格），未知键丢弃，Bot 里不能出现脚本/命令。 | 单测：含 `"cmd": "rm -rf /"` 的 Bot 保存后该键不存在；含 `workerCommand` 键被丢弃 |
| I3 | **能力可推导、可校验。** Bot 声明 `requires`，保存期与分派期各用**探针结果**（§3.3）校验一次；`BACKEND_CAPABILITIES` 不是事实来源（§3.2）。能力不足或后端未核验的 Bot 既不能被选中，也不允许存成「看起来能用」。 | 单测：`requires:['web']` + `backend:'claude'`（web 未核验）保存被拒 `BOT_CAPABILITY_GAP`/`BOT_BACKEND_UNVERIFIED`；分派候选里不含它 |
| I4 | **每次 run 回答三个问题**：谁跑的（`run.botId`）、为什么是它（`run.bot.reason` + `source`）、它当时有什么能力（`run.bot.capability` 快照）。缺任一项视为观测缺陷。 | 断言：任何 `status !== 'queued'` 的 run 三者齐备；render-check 详情页可见 |
| I5 | **不承诺隔离。** 工具/MCP/Skill 是白名单与提示词契约，不是沙箱。UI 文案 MUST 用这个口径。 | 文案检查：Bot 编辑页与详情页不含「隔离」「沙箱」「安全」类承诺 |
| I6 | **交付权不变。** 闸门、提交、推送、PR 永远归执行器。Bot 与决策模型 MUST NOT 改变这一点。 | 单测：任何 Bot 都改不动 `deliver()`/push 路径；决策输出非法时不影响交付逻辑 |
| I7 | **Bot 不能被工单自提权。** Bot 只从 `<stateDir>/worker-bots.json` 读；worktree 里的 `.superagent/worker-bots.json`、`.dsh/*` MUST 被忽略，且详情页提示一句（drift 只报不改）。 | 单测：cwd 下放同名文件，解析结果不变；render-check 有提示断言 |
| I8 | **不确定就不重投。** worker 没有可判定的结束信号（`worker_lost`、超时被杀、进程组无法证明已退出）时，run 记 `indeterminate`：不自动返工、不续传会话，等人看一眼或整单重跑。 | 单测：`indeterminate` run 的返工轮数为 0、无 `resume` 参数 |
| I9 | **能力断言可追溯。** 每项能力要么来自运行期探针，要么来自带版本与日期的证据行（§3.4）；代码里写死的表 MUST NOT 单独作为断言。后端版本一变，证据即过期，该后端立刻不可用而不是继续放行。 | 单测：改掉证据行版本或删掉 smoke → 后端 `stale`，保存与分派都被拒 |

---

## 3. 能力模型

### 3.1 能力域与判据

后端能力只有三项，每一项都必须落在**可观察的事实**上：

| 能力 | 含义 | 判据（必须可观察） |
| --- | --- | --- |
| `edit` | 能改 worktree 里的文件 | 后端确有写入通道：DSH 看预设工具面，CLI 看 smoke 证据里写入真的发生 |
| `exec` | 能跑命令、跑闸门、跑测试 | 后端确有命令执行通道，且 smoke 证据里一条命令真的跑出回显 |
| `web` | 能访问网络取外部信息 | 后端显式提供联网工具/开关，且 provider 就绪（不是「有 Bash 就能 curl」） |

`report` **不是能力**：它是交付形态（`deliverable === 'report'`，`lib/live/routing.js` 的 `deliverableOf`），任何能输出文本的后端都满足。`CAPABILITIES` 常量里的 `report` 只保留给路由/交付判据，MUST NOT 参与后端能力校验；Bot `requires` 写 `report` 在保存期被拒（`BOT_REQUIRES_NOT_CAPABILITY`）。

能力 ≠ 权限：`edit` 为真不代表本次 run 是写模式（`route: read-only` 仍 deny 写工具）；`web` 为真不代表允许联网（预设或 CLI 开关可以关掉）。权限层见 §7.3、§14。

### 3.2 事实来源

**本规范不承认任何写死的后端能力表。** `lib/live/routing.js` 的 `BACKEND_CAPABILITIES` 是 v1.0.13 代码里的**假设**，本机实测已证明它与事实不符（§3.5），因此：

1. MUST NOT 把它当作分派/校验的事实来源；
2. MAY 把它保留为「该后端没有探针时的保守缺省」，此时 `source === 'fallback'`、所有能力记 `未核验`，Bot 不得使用该后端（§3.7）。

事实来源按优先级取用：

| 优先级 | 来源 | 何时用 | 可信范围 |
| --- | --- | --- | --- |
| 1 | **运行期探针**（§3.3） | 每次分派；DSH 上成本近 0 | 只对本次进程、本次版本有效 |
| 2 | **smoke 证据**（每后端版本一次，落盘缓存） | CLI 后端的能力断言 | 只对该 CLI 版本有效，版本一变即失效 |
| 3 | **技能文档**（`using-claude-cli` / `using-codex-cli`） | 写探针与 smoke 命令的依据 | 说明用法，不是能力断言 |
| 4 | **代码里的表** | 仅降级路径 | 一律标 `未核验`，不可用于放行 |

技能文档与 `--help` 只能证明「这个开关存在」，**不能**证明「这个后端在本机真的能编辑 / 执行 / 联网」；后者必须由 smoke 证据（§3.4）给出。

### 3.3 探针契约

```
probeBackendCapabilities({ backend, preset, config, signal }) -> ProbeResult

ProbeResult = {
  backend: 'dsh' | 'claude' | 'codex',
  preset?: string,
  capabilities: { edit: boolean, exec: boolean, web: boolean },
  unverified: Capability[],          // 有证据缺口的能力，按 §3.7 视为不可用
  source: 'probe' | 'smoke' | 'fallback',
  evidence: { version?: string, tools?: string[], flags?: string[],
              providers?: object, smoke?: string },
  verifiedAt: string                 // ISO-8601
}
```

**DSH：进程内探针，无外部调用**

1. `preset` → `ctx.get('agentPresets').resolve(preset ?? config.executor.workerPreset)`；解析不到记 `BOT_PRESET_UNKNOWN`，结果按 fallback 处理。
2. 工具面 → 两个来源取并集，映射必须显式、可测：
   - **preset 组成**（v1.0.20 起的主来源）：`ctx.get('agentPresets').inspectCompositions()`（或 `compositionInventory()`）里该 preset 的 `modules[].moduleName`。宿主全局 `tools` 注册表只列 MCP/team/workspace 工具，`write`/`edit`/`bash`/`web_*` 随 agent 注册，`agentPresets.resolve()` 又只返回 `{ id }` —— 只看工具名会把真机上所有 `dsh` 能力测成 `false`（1.0.18 的实测故障）。模块映射：`dsh-tool-fs`/`dsh-tool-apply-patch`/`dsh-tool-notebook` → `edit`；`dsh-tool-bash`/`dsh-tool-bash-persistent`/`dsh-terminal-bash` → `exec`；`dsh-tool-web` → `web`。`dsh-tool-fs-search` 只读搜索，**不算** `edit`。
   - **工具名**：`ctx.get('tools').get(name)` / `definitions()` / `schemas()` 的枚举（绝不调 `tools.resolve(...)`，见 1.0.17 宿主崩溃）。

   两者都拿不到 → `fallback`（全 `unverified`）。证据行记 `evidence.modules`（前 40 个）与 `evidence.tools`：

| 工具名 | 能力 |
| --- | --- |
| `write`、`edit`、`multi_edit`、`apply_patch`、`notebook_edit` | `edit` |
| `bash`（含宿主提供的等价执行工具） | `exec` |
| `web_search`、`web_fetch` | `web`（还要求 provider 就绪） |

3. `web` 除工具在场外，MUST 同时满足 `ctx.get('web').searchReady()`；有 `web_fetch` 时还要 `fetchReady()`。工具在而 provider 没配 = 取不到数，记 `web: false` 且 `unverified: ['web']`。
4. 探针结果按 `(backend, preset, 宿主版本)` 缓存一个进程生命周期，进程重启重算。
5. 这是**唯一**允许信任「后端自报能力」的路径——它问的就是正在跑的那个进程。

**Claude / Codex：版本清单 + smoke**

- `subprocess.resolveExecutable('claude' | 'codex')` 拿路径与版本；版本不在 §3.4 证据行里 → 该后端 `stale`（§3.7）。
- 能力断言 MUST 来自 smoke 证据；`--help` 里的 flag 只用来**构造** smoke 命令，`flags` 只进 `evidence`。

### 3.4 证据行（本机实测）

2026-11-21 在本机（macOS，插件 v1.0.13 检出）实测。新增或升级后端 MUST 先更新本表再改代码。

| backend | 版本 | 能力 | 结论 | 证据 |
| --- | --- | --- | --- | --- |
| `dsh` | 运行中宿主 | `edit` / `exec` / `web` | **按预设探针**，无全局结论 | `agentPresets.inspectCompositions()` 的 preset `modules`（`dsh-tool-fs`/`dsh-tool-bash`/`dsh-tool-web` 等）+ `tools` 服务工具名；`web.searchReady()` / `fetchReady()` 可查（v1.0.20 实测：`dsh` 三能力均 `true`） |
| `claude` | `2.1.329`（`claude --version`） | `edit`、`exec` | 可声明，需 smoke 通过 | `claude --help`：`--tools <tools...>`（"Built-in tools … or tool names (e.g. \"Bash,Edit,Read\")"）、`--permission-mode <mode>`、`--effort <level>` |
| `claude` | 同上 | `web` | **未核验，P4 开工时定**（§18 D6） | help 提到 `WebFetch`，未提 `WebSearch`；而且本插件给 claude 的 `--disallowedTools` 里就写着 `WebFetch,WebSearch`（`worker-cli.js:59`），所以「工具名对不对」之前先要决定「给不给联网」。在 P4 打开 C4 白名单并 smoke 之前，claude 的 `web` 恒为 `false` |
| `codex` | `0.171.0`（`codex --version`） | `edit`、`exec` | 可声明，需 smoke 通过 | `codex exec --help`：`-s/--sandbox {read-only,workspace-write,danger-full-access}`；`-a/--ask-for-approval never` |
| `codex` | 同上 | `web` | 可声明，需 smoke 通过 | 顶层 `--search`（"Enable live web search … native Responses `web_search` tool"） |
| `codex` | 同上 | 思考深度 | **未核验，P5 开工时定**（§18 D7） | `model_reasoning_effort` 键未在本机 help 中出现；P5 定之前 codex Bot 的 `reasoningEffort` 不生效（现状是静默不传，P5 要么证明能传、要么改成保存期拒绝） |

> 设计稿 `docs/worker-bots.md` 里的 `claude 2.1.316` / `codex 0.169.1` 已过期，以本表为准。

smoke 证据的形态（MUST 能区分「开」与「关」）：

| backend | smoke 命令（示意） | 通过判据 |
| --- | --- | --- |
| `claude` | `claude -p --tools "Bash" --permission-mode acceptEdits "run: printf sa-probe"` | 输出含 `sa-probe` 且 `is_error=false` |
| `codex` | `codex -a never exec -s workspace-write --ephemeral --json "write sa-probe to probe.txt, then read it back"` | 文件真的出现且被读回，事件流有 `turn.completed` |

smoke 只在「版本首次出现」或用户显式点「重新核验」时执行，结果缓存在 `<stateDir>/backend-verify.json`（版本、时间、命令、输出摘要；不含任何凭据）。

### 3.5 与代码现状的偏差（必须修）

| 代码断言（v1.0.13） | 实测事实 | 处理 |
| --- | --- | --- |
| `BACKEND_CAPABILITIES.claude.exec === false` | `--tools Bash` 明确可用 | 由探针/证据取代；上线 claude 前删除该断言 |
| `BACKEND_CAPABILITIES.codex.web === false` | 顶层 `--search` 存在 | 同上 |
| `report` 出现在 `CAPABILITIES` 且被当作后端能力 | 是交付形态 | `requires` 不再接受 `report`；常量只留给交付判据 |
| `BACKEND_CAPABILITIES.dsh` 全 `true` | 能力取决于 preset | DSH MUST 走 §3.3 探针，禁止读表 |

修完之前，这张表只能在 `source === 'fallback'` 下用于**拒绝**（保守），不能用于放行。

### 3.6 能力推导与校验

```
capabilitiesOf(probeResult) -> Set<capability>
  = { c ∈ {edit, exec, web} | probeResult.capabilities[c] === true && c ∉ probeResult.unverified }
```

- Bot MUST NOT 写 `capabilities` 字段（出现即丢弃，I2）。
- `run.bot.capability` 记本次 run **实际可用**的集合，并附 `capabilitySource`（`probe` / `smoke` / `fallback`）与 `verifiedAt`（I4、I9）。
- 保存期与分派期各跑一次 `validateBot(bot, probe)`：

| 规则 | 错误码 |
| --- | --- |
| `requires` 每项 ∈ `{edit, exec, web}` | `BOT_REQUIRES_UNKNOWN` |
| `requires` 写了 `report` | `BOT_REQUIRES_NOT_CAPABILITY`（提示改用 `deliverable`） |
| 后端 `unverified` / `stale`（§3.7） | `BOT_BACKEND_UNVERIFIED` / `BOT_BACKEND_STALE` |
| `requires ⊄ capabilitiesOf(probe)` | `BOT_CAPABILITY_GAP`（附后端与缺口 `c1,c2`） |
| `preset` 非空且解析不到（仅 `dsh`） | `BOT_PRESET_UNKNOWN` |
| `model.reasoningEffort` 超出后端支持（§9.3） | `BOT_EFFORT_UNSUPPORTED` |
| `backend` 不在 `executor.workers` 或未启用 | `BOT_BACKEND_DISABLED` |

`errors` 的第一项决定 UI 红字摘要，其余折叠成「还有 N 条」。

### 3.7 后端上线状态机

每个后端在任一时刻处于三态之一，MUST 在设置页与 Bot 编辑器可见：

| 状态 | 含义 | 保存期 | 分派期 |
| --- | --- | --- | --- |
| `unverified` | 没有探针实现，或没有证据行 | 拒绝（`BOT_BACKEND_UNVERIFIED`） | 不进候选集 |
| `verified` | 探针 / smoke 通过，版本与证据行一致 | 允许 | 进候选集 |
| `stale` | 证据行版本 ≠ 当前 CLI 版本，或宿主 preset 解析失败 | 拒绝（`BOT_BACKEND_STALE`） | 不进候选集 |

上线一个后端 MUST 同时满足：①§3.3 探针实现；②§3.4 证据行；③smoke 通过并落盘；④该后端专属验收（§15 的 AC-B\*）全绿；⑤`executor.workers.<backend>.enabled === true`。

**顺序**：`dsh` 先完整上线（P1–P3 全部按 dsh 落地、不依赖 CLI 任何开关）；`claude`、`codex` 各自独立上线，互不阻塞（P4、P5）。

**版本从哪来**（v1.0.18 实现口径）：宿主不暴露版本服务，因此 `hostVersionOf(ctx)` 依次取 `ctx.hostVersion`（函数或字符串）、`process.env.DSH_VERSION`，都没有则 `undefined`。注意 Cordis 的 Context 对未 `inject` 的属性**抛异常**而不是返回 `undefined`，所以注入读取与 `stateDir` 都必须走 try/catch 或显式参数（`probeBackend({ stateDir })` 是参数，不从 Context 上读）——否则一个设置页请求就是 500。探针缓存键与证据行都用这个值；`undefined` 时不做版本比较（`stale` 不可达，只能靠 `unverified` 拦住未核验的后端）。CLI 事后端的证据取自 `<stateDir>/backend-verify.json` 的 smoke 账本，账本里记录的 CLI 版本与当前版本不同即 `stale`。

## 4. Bot 数据模型

### 4.1 存储

- 位置：`<stateDir>/worker-bots.json`，MUST 与 `live.json` 分离（`live.json` 只放引用）。
- 权限：写入后 `chmod 0600`；目录已存在时不改目录权限。
- 写入：原子写（临时文件 + `rename`），避免半截 JSON。
- 不读：仓库内任何路径（I7）；跨机器共享走 P4 的显式导入/导出。
- 文件不存在 → 用内置 Bot（§4.5），不是错误；文件损坏或 `version` 不匹配（§4.6）→ 拒绝派单并在面板显示可修复的提示，MUST NOT 静默退回内置或默认后端。

### 4.2 JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://dsh.local/schemas/worker-bots.json",
  "type": "object",
  "required": ["version", "bots"],
  "additionalProperties": false,
  "properties": {
    "version": { "const": 2 },
    "default": { "type": "string", "pattern": "^[a-z0-9-]{2,32}$" },
    "bots": {
      "type": "array", "maxItems": 32,
      "items": { "$ref": "#/$defs/bot" }
    }
  },
  "$defs": {
    "bot": {
      "type": "object",
      "required": ["id", "name", "backend"],
      "additionalProperties": false,
      "properties": {
        "id": { "type": "string", "pattern": "^[a-z0-9-]{2,32}$" },
        "name": { "type": "string", "minLength": 1, "maxLength": 40 },
        "description": { "type": "string", "maxLength": 400 },
        "backend": { "enum": ["dsh", "claude", "codex"] },
        "model": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "provider": { "type": "string", "maxLength": 64 },
            "model": { "type": "string", "maxLength": 128 },
            "reasoningEffort": { "enum": ["auto", "low", "medium", "high"] }
          }
        },
        "preset": { "type": "string", "maxLength": 64 },
        "requires": {
          "type": "array", "uniqueItems": true, "maxItems": 3,
          "items": { "enum": ["edit", "exec", "web"] }
        },
        "tools": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "deny": { "type": "array", "maxItems": 32, "items": { "type": "string", "maxLength": 64 } },
            "allowMcp": { "type": "array", "maxItems": 16, "items": { "type": "string", "maxLength": 128 } }
          }
        },
        "skills": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "prefer": { "type": "array", "maxItems": 16, "items": { "type": "string", "maxLength": 64 } },
            "policy": { "enum": ["prompt", "preset"] }
          }
        },
        "prompt": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "role": { "type": "string", "maxLength": 2000 },
            "must": { "type": "array", "maxItems": 16, "items": { "type": "string", "maxLength": 200 } }
          }
        },
        "budget": {
          "type": "object", "additionalProperties": false,
          "properties": {
            "timeoutMs": { "type": "integer", "minimum": 60000, "maximum": 7200000 },
            "idleTimeoutMs": { "type": "integer", "minimum": 60000, "maximum": 3600000 },
            "maxRepairRounds": { "type": "integer", "minimum": 0, "maximum": 6 }
          }
        },
        "stages": {
          "type": "array", "minItems": 2, "uniqueItems": true,
          "items": { "enum": ["assess", "plan", "implement", "gates", "review"] }
        }
      }
    }
  }
}
```

Schema 是契约；实现 MUST 在保存期跑它，并把 `schema` 报错翻译成人话（错误码 `BOT_SCHEMA_INVALID`）。

### 4.3 字段语义

| 字段 | 缺省 | 消费者 | 说明 |
| --- | --- | --- | --- |
| `id` | 必填 | 全局 | 小写 kebab；`adhoc:` 前缀保留，用户 Bot 不得使用 |
| `name` / `description` | `name` 必填 | UI | 只展示，不参与分派 |
| `backend` | 必填 | `worker.js` / `worker-cli.js` | 必须在 `executor.workers` 中启用**且已核验**（§3.7）；未核验后端填了即保存期拒绝 |
| `model` | 跟随宿主动模（`agentDefaultModel` / `executor.model`） | `agentOptions()` / `cliInvocation()` | `provider`+`model` 成对；`reasoningEffort` 见 §9.3 |
| `preset` | 宿主默认 preset | `workerRun({ preset })` | 仅 `dsh`（Claude/Codex 的等价概念在 P4/P5 上线时另议）；非 dsh 填了即 `BOT_PRESET_UNKNOWN` |
| `requires` | `[]` | 保存期/分派期校验 | 见 §3.6；只有 `edit`/`exec`/`web`，`report` 不是能力 |
| `tools.deny` | `[]` | `worker.js` 的 `DENY_TOOLS` 之上叠加 | 只加不减；命中硬黑名单的项直接忽略（不报错） |
| `tools.allowMcp` | `[]`（= 不给任何 MCP 工具） | 工具名 `mcp__<server>__*` 前缀过滤 | 精确 server 名前缀 + `*`；不支持正则 |
| `skills.prefer` | `[]` | 提示词段 | 只是「优先用这些」的提示，不是强制 |
| `skills.policy` | `prompt` | 提示词/preset 选择 | `prompt`=注入提示词；`preset`=要求 Bot 另配专属 preset（缺 `preset` 时保存期拒绝：`BOT_SKILLS_PRESET_MISSING`） |
| `prompt.role` | `''` | system prompt 段（order 160 之后） | 追加，不替换 `workerBrief`/`workerTask` |
| `prompt.must` | `[]` | 同上，逐条作为 MUST 句 | 每条 ≤200 字，最多 16 条 |
| `budget` | 见 §9.2 | 执行器/CLI 超时 | 覆盖 `executor.*`，不覆盖闸门超时（`gateTimeoutMs` 归执行器） |
| `stages` | `STAGES` | `workflow.js` | 见 §10 |

### 4.4 归一化规则

`normalizeBots(raw)` MUST：

1. 只保留 Schema 里声明的键（白名单），未知键丢弃并在面板报告一条 `droppedKeys`（**不致命**）。
2. 字符串 trim；`id`、`backend`、`skills.policy`、`stages` 小写化后再校验。
3. 数组去重、保序；超上限截断并记 `truncated`。
4. 不合法项从 `bots` 中剔除（不删文件），其余 Bot 照常可用；剔除数量进 `warnings`。
5. 输出结构固定（键序稳定）以便 `configDigest`（§7.5）可复现。

### 4.5 内置 Bot

三个内置 Bot，**与 v1.0.7 行为一致**，不可编辑、可「复制为新 Bot」（每行一条，文件里放进 `bots` 数组）：

```jsonl
{"id":"generalist","name":"通用","description":"跟随宿主后端与模型，等同 v1.0.7 默认行为。","backend":"dsh","requires":["edit","exec"]}
{"id":"surgical","name":"小修","description":"简单改动：implement → gates，不跑 plan 与 review。","backend":"dsh","requires":["edit","exec"],"stages":["implement","gates"]}
{"id":"reviewer","name":"审阅者","description":"只读复核，产出报告。只能当阶段 Bot 用（见 §10.2）。","backend":"dsh","requires":[]}
```

`surgical` 与今天的 simple 模式等价（`workflow.js` 中 `plan` 为空即 `ready` 的分支）。内置 Bot 的 `backend` 一律 `dsh`（P1–P3 只上线 dsh，内置 Bot 不应因为配置里写了别的后端就跳到未核验的后端上）；用户自建 Bot 才能指向其他后端，且该后端必须先满足 §3.7。

`reviewer` 是**阶段级**Bot，设计上只该出现在 `stages[].bot`。它 `requires` 为空，所以在 §7.1 的**自动**候选里永远不出现（这条规则由 v1.0.22 落实，见 §18 D8）：`executor.bot` 指向它不会让它跑整单，决策模型也看不到它；只有显式层（`ticket.botOverride`、规则里点名）才能选中它。

### 4.6 版本

`version` 当前恒为 `2`（v2 的档位文件是 `1`，键名也不同）。读到 `2` 时忽略未知键（前向兼容）；读到 `1` MUST 拒绝加载并提示「档位文件已更名为 Bot 文件」；读到 `> 2` MUST 拒绝并提示升级插件。三种情况都不静默退回内置。

---

## 5. 配置面

### 5.1 新增键（`live.json`）

```json
{
  "executor": {
    "bot": "generalist",
    "botsFile": "worker-bots.json",
    "dispatch": {
      "mode": "rules",
      "adhoc": true,
      "cacheSeconds": 600,
      "maxPerPoll": 10,
      "adhocOrder": ["dsh", "claude", "codex"],
      "rules": [
        { "bot": "reviewer", "workTypes": ["review", "analysis"], "deliverable": "report" },
        { "bot": "surgical", "workTypes": ["docs"], "keywords": ["typo", "文案"] }
      ]
    }
  }
}
```

### 5.2 归一化（`config.js`，白名单风格）

| 键 | 类型/区间 | 缺省 | 非法时 |
| --- | --- | --- | --- |
| `executor.bot` | Bot id | `generalist` | 保存期拒绝 |
| `executor.botsFile` | 文件名（不含路径分隔符） | `worker-bots.json` | 保存期拒绝（防止读到 stateDir 之外） |
| `dispatch.mode` | `rules` \| `model` \| `auto` | `rules` | 丢弃，保留旧值 |
| `dispatch.adhoc` | boolean | `true` | 丢弃 |
| `dispatch.cacheSeconds` | 0–86400 整数 | 600 | 丢弃 |
| `dispatch.maxPerPoll` | 0–50 整数 | 10 | 丢弃 |
| `dispatch.adhocOrder` | `backend[]` 的排列 | `['dsh','claude','codex']` | 丢弃，用缺省 |
| `dispatch.rules[]` | 见 5.3 | `[]` | 非法规则逐条丢弃 |

`dispatch.adhocOrder` 里写到的后端若未核验（§3.7），分派期直接过滤，不报错；`adhocOrder` 缺省值在 P2 收窄为 `['dsh']`，`claude`/`codex` 上线时各自追加。

`dispatch.rules` 规则形态：`{ bot, workTypes?, keywords?, repos?, sources?, deliverable? }`；`bot` 必须是已存在 Bot，否则该条规则被丢弃（保存期报告 `DISPATCH_RULE_BOT_UNKNOWN`）。

### 5.3 默认配置的等价性（硬要求）

在缺省 `live.json` + 空 `worker-bots.json` 下，`resolveDispatch()` 的结果 MUST 与 v1.0.7 的 `workerBackendOf()` 选出的**后端**一致，且 `source === 'default'`、`botId === 'generalist'`。这条用单测钉住（fixture：仓库现有 7 种 workType 的代表工单）。

### 5.4 兼容回退

`executor.workerPreset`、`executor.implementer`、`executor.reviewer`、`repos[].workerPreset` 保留为兼容层：

- 有 Bot（`executor.bot` 或 rules 命中）时，Bot 字段优先；
- Bot 没给 `preset` 而 `workerPreset` 有值 → 用 `workerPreset`（等价于旧行为）；
- staged 的 implementer/reviewer 后端在 Bot 没指定 `backend` 时才生效（内置 Bot 的 `backend` 来自 `workerBackend`，见 §4.5）。

旧 `live.json` 不改也能跑，是 P0 的验收条件之一。

---

## 6. 预算解析

优先级（高 → 低）：**阶段覆盖（§10.2） > Bot `budget` > `executor.*` > 内置缺省**。

| 解析键 | Bot 字段 | 配置来源 | 内置缺省 | 消费者 |
| --- | --- | --- | --- | --- |
| 总超时 | `budget.timeoutMs` | `executor.timeoutMs` | `1_500_000` | `workerRun` / `runCliWorker` |
| 空闲看门狗 | `budget.idleTimeoutMs` | `executor.workerIdleTimeoutMs` | `300_000` | DSH 会话 watchdog / `runProcess`（§12） |
| 返工轮上限 | `budget.maxRepairRounds` | `executor.maxRepairRounds` | `2` | executor 循环 |
| 闸门超时 | — | `executor.gateTimeoutMs` | `600_000` | 闸门运行器 |

`budget` MUST NOT 覆盖闸门超时、闸门集合、推送权限（I6）。

---

## 7. 分派

### 7.1 算法

```
resolveDispatch(ticket, config, bots, ctx) -> {
  botId, reason, source, degraded?, candidates, capability, configDigest
}
```

按顺序取第一层命中，**显式层永不静默替换**：

1. **显式**：`ticket.botOverride` → `ticket.backendOverride`（映射到该后端的内置 Bot）→ `repo.bot` → `octo.chatRepos` 来源默认 → `executor.bot`。
   - 显式 Bot 能力不足时 → **拒绝执行**，`reason` 说明缺口，`source='explicit'`，`degraded='explicit-unusable'`。MUST NOT 换一个能用的。
2. **规则**：按 `dispatch.rules` 顺序，取第一条全条件命中（`workTypes`/`keywords`/`repos`/`sources`/`deliverable` 都是 AND；数组内是 OR）。
3. **决策模型**：`mode ∈ {'model','auto'}` 且（`mode==='auto'` 或规则无命中）时调用（§7.2）。
4. **回退**：规则命中 → `executor.bot` → ad-hoc（§8）→ 拒绝执行（`nahoc=false` 时），`source ∈ {'rule','default','adhoc'}`。

候选集 = 所有 `validateBot()` 通过且 `requires ⊆ capabilitiesOf()` 的 Bot；候选为空时直接进入第 4 层，不调模型。

**`requires` 为空且没有声明整单用途的 Bot 不进「自动」候选**（`source ∈ {'model','default','adhoc'}` 之外的规则层是配置作者的显式意图，仍可点名）。`reviewer` 就是这种 Bot：它的空 `requires` 如果参与过滤会"覆盖任何工单"，等于把只读复核器派成唯一执行者。自动层跳过它，显式层（`ticket.botOverride`、`backendOverride`、`repo.bot`、规则点名）仍可选中——选错了是人的显式决定，`covers()` 仍会校验能力。

### 7.2 决策模型契约

复用 `eval.decision` 的 `endpoint` / `model` / `tokenFile` / `timeoutMs`（不新增凭据），独立提示词，结构化输出，**不复用** `judgeQuestionPayload`。

请求体（`POST` 一次，无重试；超时即降级）：

```json
{
  "ticket": { "title": "…", "body": "…", "truncated": true, "repo": "dsh-plugins", "workType": "dev", "deliverable": "change" },
  "candidates": [
    { "id": "dsh-plugin-dev", "name": "DSH 插件开发员", "capabilities": ["edit","exec"], "notes": "…", "cost": "medium" }
  ]
}
```

`title` 截 400 字符、`body` 截 4000 字符；任一被截断时请求里带 `truncated: true`（§18 D3），让模型知道自己看的是节选，不要假装读过全文。节选上限是有意的成本与隐私边界，不随工单变长。

响应体（严格校验）：

```json
{ "bot": "dsh-plugin-dev", "confidence": 0.82, "reason": "改动落在 client/src，需要跑构建与 render-check" }
```

`validateChoice(choice, candidates)` 规则，任一不满足即视为模型失败：

| 规则 | 违规结果 |
| --- | --- |
| `bot` 是候选 id 之一，或 `null` | 失败（不许造 id、不许选能力不足的） |
| `confidence` 是 `[0,1]` 的有限数 | 失败 |
| `reason` 非空字符串且 ≤200 字 | 失败 |
| 对象不许有额外键 | 失败 |

失败 → 走 §7.1 第 4 层，并记 `degraded='model'`（可见，不静默）。`choice.bot === null` 是**成功**的「都不合适」信号，记 `degraded='model-null'`，同样进第 4 层。

### 7.3 权限边界

决策模型只能选 Bot。MUST NOT 授权它：改闸门集合、提高超时、跳过验收、选未启用后端、指定 worktree/分支、读写 Bot 文件。实现上把它的输出当**纯数据**（只取 `bot` 字段），不接受任何其他控制字段。

### 7.4 缓存与限流

- 缓存键：`sha256(title + '\n' + repo + '\n' + workType + '\n' + deliverable + '\n' + botSetDigest)`；`botSetDigest` 是归一化后 Bot 集合的稳定哈希（Bot 一改，缓存自然失效）。
- TTL：`dispatch.cacheSeconds`（0 = 关闭缓存）。
- 限流：每个轮询周期最多 `dispatch.maxPerPoll` 次调用，超出排队到下一轮（沿用 `eval.decision.maxPerPoll` 口径）。
- 单飞：同一缓存键并发只发一次请求。
- `mode='rules'` 完全离线，MUST NOT 触发任何模型调用。

### 7.5 记录（`run.bot`）

```json
{
  "id": "dsh-plugin-dev",
  "source": "explicit|rule|model|default|adhoc",
  "reason": "规则：dev + 关键词“插件”",
  "degraded": "model|model-null|explicit-unusable",
  "candidates": ["generalist", "dsh-plugin-dev"],
  "capability": ["edit","exec"],
  "capabilitySource": "probe",
  "verifiedAt": "2026-11-21T06:00:00.000Z",
  "configDigest": "sha256:…",
  "resolvedAt": "2026-11-21T06:00:00.000Z",
  "synthesizedFrom": { "requires": ["edit","exec"], "planDigest": "…" }
}
```

同时写 `run.botId`（便捷索引）。ad-hoc 额外写解析后的完整 Bot 到 `run.bot.resolved`（字段同 §4.2 的 bot，但 `id` 为 `adhoc:…`）。

`reason` 是给**人**的一句话，MUST 包含判定依据（哪条规则 / 模型理由 / 缺什么），不得只写「默认」。

### 7.6 换 Bot 重跑

详情页「换 Bot 重跑」= 新的 run，`botOverride` 写入该 run 的 trigger 记录；MUST NOT 修改工单的持久字段，MUST NOT 修改 Bot 文件。新 run 的 `source='explicit'`，`reason` 写「手动指定」。

---

## 8. ad-hoc Bot

### 8.1 触发

满足全部条件才合成：

1. `dispatch.adhoc === true`；
2. 显式层无可用 Bot（或工单显式要求 ad-hoc）；
3. 规则与默认 Bot 都不满足 `requires`；
4. 决策模型返回 `null` 或失败。

否则拒绝执行，`reason` 写明缺哪个能力，**不静默降级**到默认后端。

### 8.2 合成算法（确定性）

```
synthesizeBot(ticket, plan, config) -> { bot, synthesizedFrom }
1. requires = 由 deliverable/workType 推出的保守交集
   report 交付 → 无后端能力要求（文本输出任何后端都能做）；change 交付 → 至少 {edit}；workType=test → ∪{exec}；research → ∪{web}
2. backend = dispatch.adhocOrder 中第一个 capability 覆盖 requires 的后端
3. model = 该后端缺省模型（dsh: agentDefaultModel / CLI: 后端缺省）
4. preset = 宿主默认 preset（仅 dsh）
5. prompt.role = 工单标题（≤500 字符）；标题为空时回退成「按 `<workType>` 处理这件事」——不依赖 plan 摘要（simple 模式下 plan 为空；§18 D4）
6. budget = executor.*（不放大）
7. id = 'adhoc:' + sha256(canonicalJson({requires, backend, model, preset, rolePrefix, deliverable}))[0..8]
```

`canonicalJson`：键排序、无空格、数字规范化。同输入同 hash 是 MUST（可复现、可对比）。

### 8.3 边界

ad-hoc MUST NOT：新增字段、改闸门、放大预算、提升权限、自动升级到 staged 流程、自动写入 Bot 文件。它只是「一次性的 Bot」。

### 8.4 提升

详情页「存为 Bot」把 `run.bot.resolved` 填进编辑器，用户补 `id`/`name`/匹配规则后**手动**保存。MUST NOT 自动落盘。

---

## 9. 参数生效

### 9.1 `resolveBot()` 输出

```ts
resolveBot(botId, context) -> {
  id, backend,
  model?: { provider, model, reasoningEffort },
  preset?: string,          // dsh only
  denyTools: string[],      // DENY_TOOLS ∪ bot.tools.deny
  allowMcp: string[],       // 前缀列表
  readOnly: boolean,        // ROUTE_PROFILES[route] === 'read-only' 时追加 READ_ONLY_TOOLS
  systemPromptExtra?: { role?: string, must: string[], skills: string[] },
  budget: { timeoutMs, idleTimeoutMs, maxRepairRounds },
  stages?: StageSpec[],
  capability: string[]
}
```

执行器把 `DENY_TOOLS` 与 Bot `tools.deny` **合并**后传给 `ctx.tools.guard`；`readOnly` 沿用现有 `READ_ONLY_TOOLS`（`worker.js`）。

### 9.2 DSH 路径

`worker.js` 的 `agentOptions(model)` 当前只透传 `{provider, model}`（`worker.js:20-23`），思考深度被丢弃。P1 起 MUST：

- `agentOptions()` 接收 `reasoningEffort` 并写入 `AgentOptions`（宿主未实现的字段不传，不 emulate）；
- `maxTokens` 若 Bot 给出则透传（当前未支持，属 MAY）；
- `preset` 由 `workerRun({ preset })` 传入（已有 `executor.js:1508`/`:1539` 两条路径，统一走 `resolveBot()`）。

### 9.3 思考深度 → 后端映射

集中一处 `effortArgs(backend, effort)`（`lib/live/worker-cli.js`），带单测；**宁可不传也不猜**。

| Bot effort | DSH | Claude Code | Codex |
| --- | --- | --- | --- |
| `auto` / 缺省 | 不传 | 不传 | 不传 |
| `low` / `medium` / `high` | 透传至 `AgentOptions` | `--effort <level>`（2.1.329 已核验存在；P4 上线前再用 smoke 确认一次真的生效） | **未核验，P5 定**（§18 D7）：`-c model_reasoning_effort=<值>` 未在本机 help 出现；P5 要么实测通过，要么改成保存期 `BOT_EFFORT_UNSUPPORTED` |

保存期校验依赖宿主模型目录；不支持的值 → `BOT_EFFORT_UNSUPPORTED`。目录以宿主服务为准：`modelDirectories` 只注册在客户端 UI 插件里（宿主侧无此服务），因此实现读 `ctx.get('llm').resolveModel(provider, model)` 的 `reasoning.efforts`；模型目录查不到时不作结论（不阻断保存），只有在能确定「这个模型没有这档」时才拒绝。

### 9.4 Skill 与 MCP

- `skills.policy='prompt'`：在 system prompt 追加「优先考虑这些 Skill：…」；不裁剪 catalog（DSH 不支持）。
- `skills.policy='preset'`：要求 Bot 给出 `preset`，靠专属 preset 承载；缺 `preset` 保存期拒绝。
- `tools.allowMcp`：把宿主工具名按 `mcp__<server>__*` 前缀过滤；`[]` = 一个 MCP 工具都不给；非空时**只**给匹配项。
- 文案口径（I5）：写「限制/不给」，不写「隔离/安全边界」。

### 9.5 提示词注入顺序

`systemPrompt.section({ order })` 用一个常量表管理，避免与 `workerBrief`/`workerTask` 打架：

```
100 workerBrief（含禁运行时采集脚本、禁 .env/secrets 的既有禁令）
120 workerTask
140 repo 约定（AGENTS.md 提示）
160 bot.prompt.role
165 bot.prompt.must（逐条）
170 bot.skills.prefer
```

段名与 order 的映射写在 `lib/live/prompts.js`（新增）里，禁止散落魔法数字。

---

## 10. 阶段编排

### 10.1 允许的集合

`bot.stages`（或 run 级覆盖）MUST 是 `STAGES = ['assess','plan','implement','gates','review']` 的**有序子序列**，且必须包含 `implement` 与 `gates`。

- `surgical` = `['implement','gates']`（等价 simple 模式）。
- 只有 `review` 的集合非法（`BOT_STAGES_INVALID`）——`reviewer` 是**阶段级**Bot（§10.2），不是整单 Bot。

### 10.2 阶段级 Bot 与预算

```json
{
  "stages": [
    { "stage": "assess",  "bot": "reviewer" },
    { "stage": "plan",    "bot": "reviewer" },
    { "stage": "implement" },
    { "stage": "gates" },
    { "stage": "review",  "bot": "reviewer", "budget": { "timeoutMs": 600000 } }
  ]
}
```

语义：未给 `bot` 的阶段用整单 Bot；阶段 `budget` 覆盖 §6 的解析结果；阶段 Bot 的 `backend` 可以与整单不同（例如整单 dsh、review 用 codex）——但只在 `executor.reviewer` 允许的后端里选，且必须 `validateBot()` 通过。

记录口径（§18 D1）：`run.bot.capability` 只记**整单 Bot** 的能力快照（回答"这单是谁干的"）；阶段 Bot 记在阶段条目上——`stages[].backend`（v1.0.21 起）与 `stages[].bot`（v1.0.22 起）。不做能力并集：`gates` 阶段由执行器直接跑命令、不经任何 Bot，把能力并到整单快照只会让审计记录失真。

### 10.3 禁止

MUST NOT 允许：自定义阶段名（破 `validate()` 与续跑 key）、跳过 `gates`、review 之后修改候选（`candidate_changed` 检查保留）、阶段集合内乱序、把闸门集合当阶段参数。

---

## 11. CLI 进程契约

借自 OpenMausBot。**范围：C1–C10 只约束已上线的 CLI 后端**——P1–P3 的 `dsh` 不需要它们；`claude` 上线（P4）时 C1–C10 必须全绿，`codex` 上线（P5）时再补 `exec resume` 与思考深度键的核对。下表 flag 均为 2026-11-21 本机 `--help` 实测（`claude 2.1.329`、`codex-cli 0.171.0`）；CLI 升级后重跑这份核对与 §3.4 的证据行。

| # | 要求 | 现状 | 验收 |
| --- | --- | --- | --- |
| C1 | prompt MUST 走 stdin，argv 只留开关 | `cliInvocation()` 把 task 放进 argv（`worker-cli.js:37`） | 单测：argv 不含工单正文；`ps` 看不到正文 |
| C2 | brief MUST 走 `--append-system-prompt-file <0600 tempfile>` | 走 argv | 单测：argv 含该 flag 与路径，不含 brief 文本 |
| C3 | Claude MUST 隔离宿主配置：`--strict-mcp-config` + 空 `--mcp-config` + `--setting-sources project`，环境 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_CODE_DISABLE_CRON=1` | 继承 `~/.claude` | 单测：argv/env 断言 |
| C4 | 工具面 MUST 用 `--tools` 限定集合，`--allowedTools` 只做集合内预批准 | 只有白/反白名单 | 单测：两者同时出现 |
| C5 | 一次性回合加 `--no-session-persistence`；不使用 `--worktree`、`--bare` | 未加 | 单测 |
| C6 | 续传：Claude 首轮 `--session-id <合法 UUID>`，返工轮 `--resume <同一 UUID> --system-prompt-snapshot off`；Codex 去 `--ephemeral`，返工轮 `codex -a never -s workspace-write -C <worktree> exec resume <thread_id>` | `sessionId` 传进来但没用（`executor.js:1536`/`:2429`） | 单测：两次调用同 id；UUID 合法性；`--system-prompt-snapshot off` 存在 |
| C7 | idle 超时：每收到一行合法 JSON 刷新 `lastLineAt`，超过 `idleTimeoutMs` 即整组 SIGTERM | 只有总超时 | 单测：假进程沉默 N 秒被杀；有输出则不杀 |
| C8 | 被拒工具 MUST 记 `{type:'denied', name}` 事件并注入下一轮 brief | 静默 | 单测：事件存在；下一轮 brief 含「这些工具被拒」 |
| C9 | 结果契约：Claude 取最后一条 `type:"result"` 且 `subtype==="success"`、`is_error===false`；Codex 必须有 `turn.completed`，正文从 `-o` 文件读 | 「有 text 就算成功」 | 单测：`turn.failed`/`is_error:true` → 明确失败 |
| C10 | `indeterminate`（I8）：进程组无法证明退出 / 无结束信号 → 不返工、不续传 | 无 | 单测 |

`--help` 不是能力清单（`hideHelp()` 的 flag 不在 `--help` 里）；探测 flag 只认运行期行为（传不存在的路径看是否在 API 调用前报错），或按版本的 flag 下界表。

---

## 12. 增量事件

今天 `run.trace` 只在回合结束后落盘（`executor.js:1553`/`:1649`/`:2501`），跑着时 UI 空白，被杀/超时的 run 一条 trace 都没有。要求：

| # | 要求 |
| --- | --- |
| E1 | `runProcess` 增 `onLine(line)`：按 `\n` 切行，尾部残行留在 buffer |
| E2 | 解析循环体提成 `applyClaudeLine(state, line)` / `applyCodexLine(state, line)`，增量与收尾共用；**增量不参与任何判定** |
| E3 | 事件写进 `run.trace`：`TRACE_LIMIT=80` 环形、`clipSummary` 300 字 |
| E4 | 节流落盘：≥500ms 或积满 8 条才 `persist()` 一次 |
| E5 | 被杀/超时保留已写 trace，末尾补 `{type:'error', summary:'stopped'|'timeout'}` |
| E6 | 不做 token 级 delta 合并（面板不是聊天流） |

验收：杀掉一个 run，`run.trace` 非空且最后一条是终止事件。

---

## 13. 观测与 UI

### 13.1 详情页 MUST 显示

1. 一行 Bot 摘要：`Bot：DSH 插件开发员（规则：dev + 关键词“插件”）`；ad-hoc 显示 `现拉（adhoc:3f9a1c0b）` 并说明缺什么 Bot。
2. 「换 Bot 重跑」（§7.6）与「存为 Bot」（§8.4）。
3. 失败/被拒/超时的 run 直接展示已有 trace（不要求展开技术详情才看得到）。
4. worktree 里存在 Bot 文件时的提示：`仓库里的 Bot 文件已忽略（Bot 只从 stateDir 读）`，附路径。
5. `degraded` 可见：模型降级、显式 Bot 不可用时用警示色，不折叠。
6. 能力来源与核验状态：`能力：edit, exec（探针 / 2026-11-21）`；后端 `unverified`/`stale` 时用警示色，并给一句「后端 <b> 未核验，需先 smoke 核验」（§3.7）。
7. 分阶段流程的每行 MUST 显示该阶段实际使用的后端与 Bot（`stages[].backend` / `stages[].bot`，§10.2 记录口径）：混用后端的工单不用打开 Bot 文件就能读出来。

### 13.2 设置页 MUST 提供

- Bot 列表（内置三个 Bot 置顶、标「内置」且不可删）。
- 编辑器：字段按 §4.3；保存期校验错误就地显示（错误码 + 人话）。
- 编辑器 MUST 提供逐阶段 Bot 与阶段预算（§10.2）：勾选阶段后每阶段一行，可选 Bot（留空 = 整单 Bot）与 `budget.timeoutMs`；`gates` 不出现（由执行器跑）。数据源是 `GET engine/bots` 的 `bots[].id`。
- `preset` 字段在宿主给出 preset 列表（`GET engine/bots` 的 `presets`）时是只读下拉，宿主不答时退回自由文本（§18 D2）。
- 「预览它能拿到什么」：合并后的 deny 列表、MCP 前缀、能力集合、阶段集合。
- 复制内置 Bot 为自定义；删除需二次确认；导入/导出（P4）。

### 13.3 文案与 i18n

新增键进 `client/src/i18n.js`（中文在前、英文在后，遵循现有格式），并通过 `node scripts/check-keys.mjs`。禁止把错误码直接当文案展示（必须有 `t()` 映射）。

### 13.4 隐私

- 决策模型会收到工单标题与正文：与 `eval.decision` 同源，视为已接受的外部传输；Bot 文件 MUST NOT 存放任何凭据（Schema 无对应字段，这是有意的）。
- `run.bot` 快照 MUST NOT 含 token、`tokenFile` 路径、环境变量。
- 提示词里不注入 `.env`/secrets 内容（沿用 `executor.js:195-196` 的既有禁令）。

---

## 14. 威胁模型与对策

| # | 威胁 | 对策 |
| --- | --- | --- |
| T1 | worktree 里的 Bot 文件提升权限 | I7：只读 stateDir；忽略 + 提示 |
| T2 | 决策模型越权（改闸门/超时/后端） | §7.3：只取 `bot` 字段 |
| T3 | CLI 继承宿主配置（hooks/后台任务/多余工具） | §11 C3/C4 |
| T4 | 工单正文经 argv 泄漏到 `ps`/日志 | §11 C1/C2 |
| T5 | 模型自动新建 Bot 污染资产 | §8.4：只允许显式「存为 Bot」 |
| T6 | 大量模型调用烧钱 | §7.4：TTL、单飞、`maxPerPoll`，`rules` 模式离线 |

---

## 15. 验收标准

每条都必须有自动化落点；「真实 dev bot」指 `npm run dev` 的实例 + 真实 CLI 登录。

| # | 验收 | 落点 |
| --- | --- | --- |
| AC1 | 缺省配置下分派结果与 v1.0.7 后端一致 | 单测 `dispatch.test.js` fixture |
| AC2 | 非法 Bot（id/后端/能力缺口/preset/effort/stages）保存被拒，错误码对应 §3.6 | 单测 `worker-bot.test.js` |
| AC3 | 认知到未知键被丢弃，文件其余部分照常可用 | 单测 + 面板 `droppedKeys` 渲染 |
| AC4 | 显式 Bot 不可用时拒绝执行且理由可见，不静默替换 | 单测 + render-check |
| AC5 | 决策模型：合法 → 选中并记 `source='model'`；非法/超时/null → 按层降级并记 `degraded` | 单测（假 fetch） |
| AC6 | 候选集过滤：能力不足的 Bot 不出现在请求里 | 单测 |
| AC7 | ad-hoc：同输入同 hash；`resolved` 快照完整；`adhoc=false` 时拒绝执行 | 单测 |
| AC8 | `run.bot` 三要素齐备（I4） | 单测 + render-check |
| AC9 | DSH 路径 effort 出现在 `AgentOptions`；CLI 两条 argv 正确且不含 prompt | 单测 |
| AC10 | 续传：同 run 两次同 session id；不同 run 不同；`indeterminate` 不续传 | 单测 |
| AC11 | 被杀 run 的 trace 非空且以终止事件收尾 | 单测（假 spawn）+ dev bot 一次 |
| AC12 | 仓库内 Bot 文件被忽略且 UI 提示 | 单测 + render-check |
| AC13 | 旧 `live.json`（无新键）仍能跑通一轮 | 单测 + dev bot |
| AC14 | 内置三个 Bot 行为等价：`surgical` 不跑 plan/review；`reviewer` 只读 | 单测（workflow 断言） |
| AC-B1 | 后端未核验：保存被拒、候选集为空、设置页显示「未核验」 | 单测 `backend-capability.test.js` + render-check |
| AC-B2 | 版本变化 → 证据过期 → 后端 `stale`，保存与分派都拒，提示重新核验 | 单测（假 `resolveExecutable`） |
| AC-B3 | DSH 探针：preset 无 `bash` → `exec:false` 且 `requires:['exec']` 被拒；preset 有 `web_search` 但 `searchReady()===false` → `web:false` | 单测（假 ctx） |
| AC-B4 | smoke 结果落盘 `backend-verify.json`，同版本不重复执行，版本一变即重跑 | 单测（假 spawn + 临时 stateDir） |

AC1–AC14 与 AC-B1–AC-B3 的首版全部按 `dsh` 验收；每个新后端上线时再对它跑一遍 AC-B\* 外加该后端的 smoke。

---

## 16. 测试矩阵

| 层 | 文件 | 覆盖 |
| --- | --- | --- |
| 单测 | `lib/live/worker-bot.test.js` | Schema、归一化、校验错误码、内置 Bot、能力推导 |
| 单测 | `lib/live/backend-capability.test.js` | 探针映射（工具名→能力）、`web` provider 就绪、`unverified`/`stale` 状态机、smoke 缓存与版本失效 |
| 单测 | `lib/live/dispatch.test.js` | 四层收敛、规则匹配、模型契约、缓存、限流、ad-hoc、默认等价（AC1） |
| 单测 | `lib/live/worker-cli.test.js`（扩展） | C1–C10 |
| 单测 | `lib/live/workflow.test.js`（扩展） | 阶段子集、阶段 Bot、`surgical` 等价 |
| 单测 | `lib/live/executor.test.js`（扩展） | 预算解析、trace、`indeterminate` |
| 渲染 | `scripts/render-check.mjs` | Bot 摘要、换 Bot 重跑、存为 Bot、校验错误、drift 提示、degraded 警示、后端核验状态 |
| 实机 | dev bot | 一次真实返工（续传）、一次被杀（trace）、一次 ad-hoc |

每次改动的最低闸门沿用 `AGENTS.md`：`node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`、`npm run types`、`npm run check:js`、`node --test lib/live/*.test.js`、`node scripts/render-check.mjs`。

---

## 17. 落地切片

| 片 | 内容 | 出口条件 |
| --- | --- | --- |
| **P0 契约层**（~1d） | `lib/live/worker-bot.js`（`normalizeBots`/`validateBot`/`capabilitiesOf`/`resolveBot`/`synthesizeBot`）；`lib/live/backend-capability.js`（探针接口 + 状态机 + smoke 缓存骨架，首个实现只做 `dsh`）；`config.js` 增 `executor.bot`/`botsFile`/`dispatch` + `normalizeDispatch`；保留 `workerPreset` 兼容 | AC2、AC3、AC13、AC-B1–AC-B3 绿 |
| **P1 DSH 参数生效**（~2d） | `worker.js` 透传 `reasoningEffort`/`preset`；`executor.js:1405`/`:1539` 一带改用 `resolveBot()`（staged 与非 staged 都吃）；`effortArgs()` 先只留 `dsh` 分支 | AC9 的 dsh 半边绿；`ps`/argv 断言 |
| **P1.5 续传与卫生**（~1d） | 会话续传语义（I1）、C7/C8 的 dsh 等价项、I8 的 `indeterminate` | AC10、AC11 绿 + 一次真实返工 |
| **P2 分派**（~2d） | `lib/live/dispatch.js`（规则 + 模型 + `validateChoice` + 缓存/限流）；`adhocOrder` 缺省 `['dsh']`；`run.bot` | AC1、AC4–AC8 绿 |
| **P2.5 增量事件**（~1d） | §12 E1–E6 | AC11 绿 |
| **P3 UI**（~2–3d） | 设置页 Bot 分组 + 后端核验状态、详情页 §13.1 六项、i18n、render-check | AC12、AC14、AC-B1 的 UI 断言绿 |
| **P4 `claude` 上线**（~2d） | claude 探针（版本清单 + smoke；`web` 需先核验）、C1–C10 全量、`--effort` 映射 | 对 claude 跑 AC-B1–AC-B4 全绿 + 一条真实 claude run |
| **P5 `codex` 上线**（~2d） | codex 探针、`exec resume`、思考深度键实测、`--search` smoke | 对 codex 跑 AC-B\* 全绿 + 一条真实 codex run |
| **P6 可选** | 阶段编排 UI（v1.0.23 已落地：逐阶段 Bot/预算、preset 只读下拉、详情页显示阶段 Bot）、逐阶段闸门集合、导入导出、preset 发现器 | 各自独立评审 |

主要成本在 render-check 的 fixture 与两套 locale，不在功能本身。

---

## 18. 已定问题与推迟项

v3 评审时列了八个未决问题（原 Q1–Q8）。2026-11-23 定下六条、推迟两条：**推迟的两条都属于 CLI 后端（claude/codex），P4/P5 开工前不拍**——现在只有 `dsh` 上线，先把它跑顺。

| # | 问题 | 结论 | 落地 |
| --- | --- | --- | --- |
| D1 | 阶段 Bot 换后端时，能力要不要按并集记录？ | **不记并集**。`run.bot.capability` 只记整单 Bot 的快照；阶段 Bot 记在阶段条目上（`stages[].backend` / `stages[].bot`）。`gates` 由执行器跑命令、不经 Bot，"gates 需要 exec" 是伪问题。 | v1.0.21 记 `backend`，v1.0.22 记 `bot`（`workflow-worker.js`） |
| D2 | `skills.policy='preset'` 要求用户自己创建 preset？ | **不是契约问题**。契约只要求 `policy=preset` 时必须显式给 `preset`（`BOT_SKILLS_PRESET_MISSING`），保存期用宿主 preset 列表校验存在性（`BOT_PRESET_UNKNOWN`）。 | 已有（v1.0.18）；v1.0.23 起 `GET engine/bots` 带 `presets`，编辑器是只读下拉 |
| D3 | 决策模型看全文还是要截断？ | **截断且明示**：`title` 400 / `body` 4000 字符，被截断时请求带 `truncated: true`。不放大到 8k——成本与隐私是边界，不是可调参数。 | v1.0.22（`dispatch.js` 的 `dispatchRequestOf`） |
| D4 | ad-hoc 的 `prompt.role` 来自 plan，但 plan 可能为空？ | **不用 plan**：role = 工单标题（≤500），标题为空时回退「按 `<workType>` 处理这件事」。 | v1.0.22（`dispatch.js` 的 ad-hoc 分支） |
| D5 | 探针依赖 `tools.resolve()`，入参会随宿主变？ | **问题已消失**：`tools.resolve` 在 v1.0.17 移除（它会把宿主打挂），现在探针 = `agentPresets.resolve` + `inspectCompositions` + 工具名；任一步失败就 `fallbackProbe` → 未核验 → 拒绝派单（安全方向是拒绝而不是放行）。 | 已有（v1.0.20） |
| D6 | claude 的联网工具名是 `WebSearch` 还是 `WebFetch`？ | **推迟到 P4**。事实补充：本插件给 claude 的 `--disallowedTools` 里就写着 `WebFetch,WebSearch`，所以先要决定"给不给联网"，再谈名字。定之前 claude 的 `web` 恒 `false`，`requires:['web']` 的 claude Bot 保存期就报 `BOT_CAPABILITY_GAP`。 | P4 |
| D7 | codex 的 `model_reasoning_effort` 键存不存在？ | **推迟到 P5**。定之前 codex Bot 的 `reasoningEffort` 不生效（现状静默不传）；P5 要么证明能传，要么改成保存期 `BOT_EFFORT_UNSUPPORTED`——不允许长期静默丢弃声明。 | P5 |
| D8 | `reviewer` 这种 `requires` 为空的 Bot 会被整单分派选中 | **自动候选排除它**：`requires` 为空的 Bot 不进 `source ∈ {model, default, adhoc}` 的自动候选；显式层（`ticket.botOverride`、`backendOverride`、`repo.bot`、规则点名）仍可选中，`covers()` 照旧校验能力。**不加 `stageOnly` 字段**。 | v1.0.22（`dispatch.js`） |

D8 的代价（明写）：一个纯「写报告 Bot」如果也把 `requires` 留空，就不会被自动选中，需要规则点名或手动指定。要自动复用就给它一个非空 `requires`（报告交付本可以写 `[]`，所以这是取舍而不是能力缺失）。

---

## 附录 A：错误码

| 码 | 出现时机 | 展示 |
| --- | --- | --- |
| `BOT_SCHEMA_INVALID` | 保存 | 「字段格式不对：<路径>」 |
| `BOT_ID_INVALID` | 保存 | 「id 只能用小写字母、数字、连字符，2–32 位」 |
| `BOT_BACKEND_DISABLED` | 保存、分派 | 「后端 <b> 没有启用」 |
| `BOT_BACKEND_UNVERIFIED` | 保存、分派 | 「后端 <b> 还没核验（缺探针/smoke），先核验再用」 |
| `BOT_BACKEND_STALE` | 保存、分派 | 「后端 <b> 版本变了，证据已过期，请重新核验」 |
| `BOT_REQUIRES_NOT_CAPABILITY` | 保存 | 「report 是交付形态，不是能力：请用 deliverable 表达」 |
| `BOT_REQUIRES_UNKNOWN` | 保存 | 「未知能力 <c>」 |
| `BOT_CAPABILITY_GAP` | 保存、分派 | 「<backend> 缺 <c1>,<c2>」 |
| `BOT_PRESET_UNKNOWN` | 保存 | 「找不到 preset <p>」 |
| `BOT_EFFORT_UNSUPPORTED` | 保存 | 「<model> 不支持 effort <e>」 |
| `BOT_STAGES_INVALID` | 保存 | 「阶段必须是 … 的子集且含 implement、gates」 |
| `BOT_BUDGET_INVALID` | 保存 | 「预算超出允许区间」 |
| `BOT_PROMPT_INVALID` | 保存 | 「提示词超出长度」 |
| `BOT_SKILLS_PRESET_MISSING` | 保存 | 「policy=preset 时必须指定 preset」 |
| `BOT_DUPLICATE_ID` | 保存 | 「id 重复」 |
| `BOT_DEFAULT_UNKNOWN` | 保存 | 「default 指向不存在的 Bot」 |
| `DISPATCH_RULE_BOT_UNKNOWN` | 保存 | 「规则引用了不存在的 Bot」 |
| `DISPATCH_DEGRADED` | 分派（非错误） | 警示色：「决策模型降级」 |

## 附录 B：字段 → 代码锚点

| 规范条目 | 现有锚点 |
| --- | --- |
| 能力表（仅用于拒绝） | `lib/live/routing.js` `BACKEND_CAPABILITIES` |
| 能力探针 | 宿主 `agentPresets.resolve` / `tools.resolve` / `web.searchReady` / `fetchReady`；CLI `subprocess.resolveExecutable` |
| 阶段 | `lib/live/workflow.js:2` `STAGES` |
| DSH 参数 | `lib/live/worker.js` `agentOptions`/`DENY_TOOLS`/`READ_ONLY_TOOLS` |
| preset 注入 | `lib/live/executor.js:1405`、`:1508`、`:1539` |
| CLI 调用 | `lib/live/worker-cli.js:37` `cliInvocation`、`:262` `runCliWorker` |
| 超时/预算 | `lib/live/config.js` `DEFAULT_EXECUTOR`、`:240-290` 归一化 |
| 闸门 | `lib/live/repos.js:56` `normalizeGates`、`:139` |
| 决策模型凭据 | `lib/live/judge.js:93` `createSystemOneJudge` |
| run 记录 | `lib/live/engine.js:2395-2410` `ticketView`、`lib/live/operations.js:75` `list` |

## 附录 C：v2（档位 profile）→ v3（Bot bot）迁移对照

v3 只改命名与分层表述，不改行为。代码改造已按此表在 v1.0.19 完成：代码、`live.json` 键、`run.bot`、错误码前缀、文件名与 UI 文案现在都用 `bot`，仓库里不再有 `profile` 命名（本节留作从旧版本升级的对照）。

| v2（旧） | v3（新） |
| --- | --- |
| 档位 / profile | Bot / bot |
| `PROFILE_*` 错误码 | `BOT_*` 错误码（附录 A） |
| `<stateDir>/worker-profiles.json` | `<stateDir>/worker-bots.json` |
| `executor.profile` | `executor.bot` |
| `executor.profilesFile` | `executor.botsFile` |
| `dispatch.rules[].profile` | `dispatch.rules[].bot` |
| `ticket.profileOverride` | `ticket.botOverride` |
| `repos[].profile` / `octo.chatRepos[].profile` | `repos[].bot` / `octo.chatRepos[].bot` |
| `run.profile` / `run.profileId` | `run.bot` / `run.botId` |
| `stages[].profile` | `stages[].bot` |
| `lib/live/worker-profile.js` | `lib/live/worker-bot.js`（已在 v1.0.19 落地） |
| `readProfiles` / `writeProfiles` / `saveProfiles` / `normalizeProfiles` / `validateProfile` / `resolveProfile` / `synthesizeProfile` | `readBots` / `writeBots` / `saveBots` / `normalizeBots` / `validateBot` / `resolveBot` / `synthesizeBot` |
| `BUILTIN_PROFILES` / `PROFILE_FILE_VERSION` | `BUILTIN_BOTS` / `BOT_FILE_VERSION` |
| `profileSetDigest` / `profilesView` / `profileDrift` / `profileChoices` | `botSetDigest` / `botsView` / `botDrift` / `botChoices` |
| UI「换档重跑」「存为档位」「内置三档」 | 「换 Bot 重跑」「存为 Bot」「内置三个 Bot」 |
| `docs/worker-profiles.md`、`docs/worker-profiles-spec.md` | `docs/worker-bots.md`、`docs/worker-bots-spec.md`（本文件） |

文件 `version` 升到 `2`：键名整体换了，读到旧的 `version: 1` 文件必须报 `BOT_FILE_VERSION_UNSUPPORTED` 并提示「档位文件已更名为 Bot 文件」，不静默退回内置，也不尝试猜键名迁移（内置三个 Bot 不受影响，自定义 Bot 需按本表重建）。
