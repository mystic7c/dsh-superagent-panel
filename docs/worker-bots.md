# Worker Bot（用户定义的执行者）

本文件是「自定义 worker」的设计稿：解释为什么把执行者做成 **Bot**、Bot 由什么组成、怎么被选出来、落地分几步。它只写**为什么**与**取舍**；必须怎样（数据形态、算法、错误码、验收）见 `docs/worker-bots-spec.md`，两份冲突以规范为准。

## 一句话

Bot 是用户定义、面向**一类相对固定、会反复出现的工作**的执行者：给它一个名字、一段角色说明、一套能力（后端 / 模型 / 思考深度 / preset / 工具与 MCP 白名单 / Skill 偏好）、一份预算和一组阶段，它就能在同类工单上反复以同一种方式干活，并在每次 run 里留下可比较的记录。Bot 建立在 worker 之上——worker 是每次 run 的执行实例，Bot 是让这个实例带着可复现身份与权限跑的定义。会话的边界是 **run**（不变量 1）；分派按「显式指定 > 规则命中 > 决策模型 > 现拉 ad-hoc」四层收敛。

## 0. 为什么是 Bot

**「档位」这个词印错了形状。** 档位暗示一次性旋钮：这一趟用几档，下一趟再拨。实际要建的东西是长期资产——一个有名字、有专门工作域、反复接同一类活、能被对比考核的执行者。名字会塑造用法，所以改叫 Bot：

- **有身份**：`name`、`description`、`prompt.role`。同一人设的多次 run 结果可比；换名字、换角色说明就是换了一个执行者。
- **有专门工作域**：同一个 Bot 反复接「DSH 插件小改」这类活。它认领哪些工单绑定在分派层（`dispatch.rules` / `repo.bot` / 来源默认），不在 Bot 里写调度。
- **有边界**：能力清单 + 预算 + 阶段，是它对「这类活我怎么干」的承诺，不是对某一单的临时参数。
- **可考核**：每次 run 记 `botId`，同一 Bot 的成功率、返工轮数、耗时、闸门通过率可以聚合——「一类重复工作」的度量单位是 Bot 的历史，不是单次 run。

借鉴 **OpenMausBot** 的地方（是它验证过的形状，不是照抄实现）：

1. **bot 是一个身份，不是一组参数**：有名字、有人格说明，用户按「谁适合干这类活」来选，而不是按「这次要开哪几个能力」来拼。
2. **人格与权限描述放在 bot 工作区之外**：OpenMausBot 把 `SOUL.md` 放在 bot 可写目录之外，worker 读不到也改不了。本设计同源：Bot 只从 `<stateDir>/worker-bots.json` 读（不变量 7），worktree 里的同名文件一律忽略。
3. **bot 与 provider 解耦**：同一个 bot 可以跑在不同后端上，能力由探针判定，不由名字暗示（§5）。
4. **固定重复的工作值得固定流程**：一个 Bot 可以只跑 `implement → gates`（内置 `surgical`），把「这类活不需要重新论证方案」写进定义，而不是每单靠模型临场判断。

不抄的部分：provider fleet / shadow 实例 / 预热会话 / 模型目录发现 / TTS / 云电脑（§9 末条）——面板一个引擎进程只伺候一个工单池，没有 fleet 可管。

分层：**工单**是一类工作的一次具体实例；**Bot** 是这类工作的执行者定义；**worker** 是这次运行的进程/会话；**run** 是这次运行的可追责记录；**交付**（闸门、提交、推送、PR）永远归执行器。

## 1. 不变量

后面所有设计都从这八条推，冲突时以不变量为准。

1. **会话的边界是 run，不是工单**。每单一个 worktree、一份可追责的 run；run 之内（主轮 → 返工轮 → staged 各阶段）在同一 worktree 上续传同一个 CLI 会话是允许且推荐的（§11.3），跨 run 一律新会话、新上下文。判据只有一条：run 内的续传不得跨过 worktree 或闸门边界。Bot 复用的是**定义**（身份、能力、预算、阶段）；run 之间复用的也仍然只是定义，不是上下文——上下文只在 run 内续（§11.3）。
2. **Bot 是声明，不是代码**。白名单式归一化（照 `lib/live/config.js` 的 `mergeConfig`），不认识的键丢弃；Bot 里不能写任意脚本。
3. **能力必须可推导、可校验**。Bot 声明 `requires`，保存期与分派期各用**探针结果**校验一次（`agentPresets.resolve` 的工具面 + `web` 服务 ready；`BACKEND_CAPABILITIES` 只作为没有探针时的拒绝依据）。能力不足或后端未核验的 Bot 不允许被选中，也不允许被保存成「看起来能用」。
4. **每次运行回答三个问题**：谁跑的（`botId`）、为什么是它（`reason`）、它当时有什么能力（`capability` 快照存档）。缺任一项视为观测缺陷。
5. **不承诺隔离**。工具/Skill/MCP 是白名单与提示词契约，不是沙箱。`dsh-agent-preset-registry` README 明写 "Presets are not security sandboxes"；`dsh-mcp-manager` 只管全局平面（README「Global plane only」）。UI 文案必须照这个口径写。
6. **交付权不变**。闸门、提交、推送、PR 永远归执行器；Bot 与决策模型都不能改变这一点。
7. **Bot 不能被工单自提权**。Bot 只从 `<stateDir>` 读，不从 worktree 读（§3）。worktree 里若出现 `.superagent/worker-bots.json` 这类「声明执行权限」的文件，引擎忽略并在工单详情提示一句（drift 只报不改）——理由与 OpenMausBot 把 `SOUL.md` 放在 bot 可写工作区之外同源：会读到不可信内容的 worker，不能顺手改写自己的权限或人格。
8. **不确定就不重投**。worker 没给出可判定的结束信号（`worker_lost`、超时被杀、进程组无法证明已退出）时，run 记 `indeterminate`：不自动返工、不复用该会话，等人看一眼或整单重跑。续传的代价是「接上一个我们不完全信任的上下文」，只有确认干净时才接。

## 2. 现状与缺口

| 能力 | 今天在哪 | 缺口 |
| --- | --- | --- |
| 后端 | `executor.workers.<backend>`、`workerBackendOf()` | 只能全局一个默认，不能按 Bot 命名 |
| 模型 | `executor.workers.<b>.model`、`executor.model` | 与 Bot 不绑定 |
| 思考深度 | DSH 原生 `AgentOptions.reasoningEffort`（adapter 拥有，loop 校验） | `lib/live/worker.js:20-23` 只传 `{provider, model}`，**effort 被丢掉**；CLI 侧无映射 |
| preset | `executor.workerPreset`、`repos[].workerPreset`（`config.js:285`） | 只能引用已存在的 preset；面板不能造 preset（registry 不收 YAML） |
| 工具 | `ctx.tools.guard`（`worker.js` 已在用，拒绝 `DENY_TOOLS`） | 只有硬编码黑名单，没有逐 Bot 白/黑名单 |
| MCP | 宿主全局 `mcp-manager` | 无 per-worker 概念；只能按 `mcp__<server>__*` 前缀过滤工具名 |
| Skill | 宿主全局注册表，按 scope 分层合并（只能加、就近覆盖） | 隐藏不了全局 catalog；只能「专属 preset」或「同名 shadow」 |
| 分派 | `routing.js:75` 正则分类 → 7 种 workType → 选**后端** | 选的是后端不是 Bot；无解释、无覆盖、无 ad-hoc |
| 决策模型 | `eval.decision` + `lib/live/judge.js:93` `createSystemOneJudge()`（endpoint/model/tokenFile/timeoutMs） | 现在只判「要不要开单」，不判「交给谁」 |
| 工作流 | `lib/live/workflow.js:2` 五阶段 + key/digest/返工预算/续跑 | 阶段硬编码，不能编排 |
| CLI 进程契约 | `worker-cli.js:37` `cliInvocation()` | 工单全文进 argv（`ps` 可读、有长度上限）；Claude 分支不隔离宿主 MCP/settings/hooks/CLAUDE.md；Codex `--ephemeral` 会话不可续；CLI 只有 25 分钟总超时，没有 idle 超时 |
| 会话续传 | 1.1.13 起 `cliInvocation(..., { resume })` 走 `--resume`，修复轮续接主回合的 Claude Code 会话（`~/.claude/projects/<cwd>/<id>.jsonl`）；Codex 仍无核实的续接方式 | staged 工作流的 CLI 阶段仍未串会话；跨 run（换工单/换 worktree）不续，cwd 变了上游也找不到那条记录 |
| 运行中观测 | 1.1.13 起 CLI 分支也接 `liveTrace.push`（`runCliWorker` 的 `onTrace` + `streamedEvents`），跑着就能看；收尾仍以完整解析为准 | 被 SIGKILL 的 run 仍可能只有半截 trace；超时/中断的收尾事件未补 |

## 3. Bot 模型

存储：**只放 `<stateDir>/worker-bots.json`**（mode 600），与 `live.json` 分开——Bot 是一份独立的可读资产，`live.json` 只放引用。不读仓库内的 Bot 文件：仓库里的 `.dsh/` 属于被开发的目标工程，引擎不该从目标工程的未跟踪文件里取执行权限（那等于让工单自己决定用什么工具跑）。跨机器共享靠 P4 的**显式导入/导出**，不是自动发现。

以下是**用户自建 Bot**的形态（`dsh-plugin-dev` 是示例，不是内置项；内置只有 §10 的三个 Bot）：

```json
{
  "version": 2,
  "bots": [
    {
      "id": "dsh-plugin-dev",
      "name": "DSH 插件开发员",
      "description": "改 DSH 插件仓库：读 AGENTS.md、跑闸门、不碰 bot。",
      "backend": "dsh",
      "model": { "provider": "deepseek", "model": "deepseek-chat", "reasoningEffort": "high" },
      "preset": "standard",
      "requires": ["edit", "exec"],
      "tools": { "deny": ["workflow", "schedule_create"], "allowMcp": ["mcp__github__*"] },
      "skills": { "prefer": ["dsh-doc"], "policy": "prompt" },
      "prompt": { "role": "你是 DSH 插件开发员……", "must": ["先读 AGENTS.md，再动文件"] },
      "budget": { "timeoutMs": 1500000, "idleTimeoutMs": 300000, "maxRepairRounds": 2 },
      "stages": ["assess", "plan", "implement", "gates", "review"]
    }
  ],
  "default": "generalist"
}
```

| 字段 | 说明 |
| --- | --- |
| `id` | 小写 kebab，`[a-z0-9-]{2,32}`；`adhoc:` 前缀保留给现拉的 Bot |
| `backend` | `dsh` / `claude` / `codex`，必须是 `executor.workers` 里启用的后端 |
| `model` | provider/model 可选（缺省跟随 `agentDefaultModel`）；`reasoningEffort` 仅 DSH 原生，CLI 后端按 §5 映射表翻译 |
| `preset` | 仅 `dsh`；缺省跟随宿主默认；填了但不存在时**拒绝保存**并在 UI 说明，不静默回退 |
| `requires` | `edit` / `exec` / `web` 的子集，保存期用**探针结果**校验（`report` 是交付形态不是能力，写它在保存期被拒） |
| `tools.deny` / `tools.allowMcp` | 在引擎硬黑名单之上叠加；`allowMcp` 以 `mcp__<server>__*` 前缀匹配，空数组=不给任何 MCP 工具 |
| `skills.prefer` / `skills.policy` | `prompt`（注入「优先用这些」的提示词段）或 `preset`（靠专属 preset 隔离）；**没有 `enforce`**，因为 DSH 不支持逐会话裁剪 catalog |
| `prompt.role` / `prompt.must` | 追加在 `systemPrompt.section({ order: 160 })` 之后，order 统一由常量管理，避免与 `workerBrief`/`workerTask` 打架 |
| `stages` | 可选，见 §7；缺省用 `STAGES` |
| `budget` | 覆盖 `executor.timeoutMs` / `workerIdleTimeoutMs` / `maxRepairRounds` |

**能力由探针推导，不手填也不查表**：`capabilitiesOf(probe)` 只回答「这个后端 + 这个 preset 在本机实际能做什么」，来源是 §3.3 的探针（`agentPresets.resolve` 拿到的工具面 + `web` 服务的 ready 状态），`BACKEND_CAPABILITIES` 只在没有探针时作为**拒绝依据**存在。手填的能力声明会和现实脱节，是可预期的谎报来源；写死的后端能力表同理（规范 §3.2、§3.5）。

**adhoc Bot**：`botId` 形如 `adhoc:3f9a1c0b`，不进 `bots` 文件，但**完整解析结果快照写进 run**，事后可复现（见 §6）。

Bot 由四部分组成，缺一块就不是同一个执行者：

| 部分 | 字段 | 回答的问题 |
| --- | --- | --- |
| 身份 | `id`、`name`、`description`、`prompt.role`、`prompt.must` | 它是谁、该怎么说话、有哪些固定要求 |
| 能力 | `backend`、`model`、`preset`、`tools`、`skills`、`requires` | 它能动什么、能跑什么、能上网查什么 |
| 执行预算与阶段 | `budget`、`stages` | 一次给它多少时间与返工次数、按哪几段流程走 |
| 工作域（绑定） | 不在 Bot 里：`dispatch.rules` / `repo.bot` / 来源默认 | 它认领哪一类工单 |

**Bot 不携带调度。** 什么时候跑、跑几次、由谁触发，属于来源、触发与工单；Bot 只定义「这类活怎么干」。把 cron 塞进 Bot 会让「同一个执行者」和「同一个排期」纠缠在一起，改时间就等于改执行者。

**同一 `botId` 的多次 run 构成它的工作记录。** 成功率、返工轮数、耗时分布、闸门通过率都可以按 `botId` 聚合，这也是「一类重复工作」可被度量、可被替换的依据。面板聚合视图可以后置，`run.botId` 与 `run.bot` 快照已经够用。

## 4. 分派（dispatch）

新增 `lib/live/dispatch.js`，不改 `routing.js` 的既有语义（它继续负责交付形态与只读判定，dispatch 在它的结果之上选 Bot）。

### 4.1 四层收敛

1. **显式**：工单字段 `backendOverride`/`botOverride`、`repos[].bot`、来源默认 Bot。命中即用，永不静默替换（能力不足则拒绝执行并说明，与今天的 `manual override` 语义一致）。
2. **规则**：`dispatch.rules` 按 workType / 关键词 / 仓库 / 来源标签匹配，取第一条命中。
3. **决策模型**：仅当 `dispatch.mode` 为 `model`（规则无命中时）或 `auto`（每条工单都问）时进入。候选只含能力满足的 Bot，模型只能从中选一个或返回 `null`，不能凭空造 id。
4. **回退**：模型返回 null / 超时 / 输出不合法 → 用规则命中 → 用 `default` → 都不合适则**现拉 ad-hoc Bot**（§6）。ad-hoc **默认开启**，可用 `dispatch.adhoc=false` 关闭；关闭后无合适 Bot 即拒绝执行并说明原因，不静默降级。

### 4.2 决策模型契约

复用 `eval.decision` 的 endpoint / model / tokenFile / timeoutMs（不新增凭据），但用独立提示词与**结构化输出**，不复用 `judgeQuestionPayload`。

输入（每候选一段，能力是推导值）：

```json
{
  "ticket": { "title": "……", "body": "……", "repo": "dsh-plugins", "workType": "dev", "deliverable": "change" },
  "candidates": [
    { "id": "dsh-plugin-dev", "name": "DSH 插件开发员", "capabilities": ["edit", "exec"],
      "notes": "熟悉 DSH preset/工具链；不碰 bot", "cost": "medium" }
  ]
}
```

输出（严格校验，`lib/live/dispatch.js` 内一个 `validateChoice()`）：

```json
{ "bot": "dsh-plugin-dev", "confidence": 0.82, "reason": "改动落在 dsh-superagent-panel 的 client/src，需要跑构建与 render-check" }
```

校验规则：`bot` 必须是候选之一或 `null`；`confidence` 在 `[0,1]`；`reason` 非空且 ≤ 200 字。任一条不满足 → 视为模型失败，走 4.1 第 4 层，并在 run 里记 `degraded: 'model'`（可见，不静默）。

**决策模型的权限边界**：它只能选 Bot。不能改闸门集合、不能提高超时、不能跳过验收、不能选未启用的后端。这些是执行器与配置的职责。

### 4.3 配置

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
      "rules": [
        { "bot": "reviewer", "workTypes": ["review", "analysis"], "deliverable": "report" },
        { "bot": "surgical", "workTypes": ["docs"], "keywords": ["typo", "文案"] }
      ]
    }
  }
}
```

`dispatch.mode`：`rules`（默认，离线，不调模型）/ `model`（规则无命中时调模型）/ `auto`（每条工单都问模型，仅建议试点用，成本最高）。`rules` 为空且 `mode='rules'` 时等价于「默认 Bot + ad-hoc」，与今天的行为一致。

### 4.4 解释与纠正

`resolveDispatch()` 返回 `{ botId, reason, source: 'explicit'|'rule'|'model'|'default'|'adhoc', degraded?, candidates }`，全部写进 run。工单详情显示一行「Bot：DSH 插件开发员（规则：dev + 关键词“插件”）」，并提供「换 Bot 重跑」——不需要改 Bot 定义，只覆盖本单。

### 4.5 成本控制

一次分派一次模型调用。同 `title + repo + workType` 的决策在 `dispatch.cacheSeconds`（默认 600）内复用；`dispatch.maxPerPoll` 限制单轮调用数（沿用 `eval.decision.maxPerPoll` 的口径）。`mode='rules'` 完全离线；`mode='model'` 只在规则无命中时调用；`mode='auto'` 每条都调用，成本最高，仅试点期使用。

## 5. 思考深度到各后端的映射

DSH 直接透传 `reasoningEffort`（`AgentOptions` 的 adapter 拥有字段）。两个 CLI 没有统一语义，映射表集中一处（`lib/live/worker-cli.js` 的 `effortArgs(backend, effort)`），带单测，宁可不传也不猜：

| Bot effort | DSH | Claude Code | Codex |
| --- | --- | --- | --- |
| `auto` / 缺省 | 不传（adapter 默认） | 不传 | 不传 |
| `low` / `medium` / `high` | 透传 | 按 CLI 现有开关传（实现时核对 `claude --help`，不支持的 Bot 降级为不传并记日志） | `-c model_reasoning_effort=<值>` |

**保存期校验**：host 的模型目录（`ctx.get('modelDirectories')`，与输入框模型选择器同源）给出该模型支持的 effort 集合；不支持的值拒绝保存，而不是运行到一半才发现。

## 6. ad-hoc Bot（没有合适 Bot 时）

这是「超级智能体自己拉人」的落点，也是今天的行为（默认后端单轮）的正式化。

- **触发**：决策模型返回 `null`，且规则与默认 Bot 都不满足 `requires`；或工单显式要求。**默认开启**（`dispatch.adhoc` 默认 `true`）；关掉后该情形直接拒绝执行并说明「没有满足 requires 的 Bot」，不静默降级到默认后端。
- **合成**：`synthesizeBot(ticket, plan)` 依次决定——`requires`（从任务文本与 deliverable 推，保守取交集）→ 在 `BACKEND_CAPABILITIES` 里筛「零缺口」后端（多个时按 `dispatch.adhocOrder`，默认 `dsh > claude > codex`）→ 该后端默认模型 + 宿主默认 preset + 从 plan 摘要生成的 `prompt.role` → 预算沿用 `executor.*`。
- **记录**：`botId='adhoc:<sha256(合成输入)[0..8]>'`，解析后的完整 Bot 写进 `run.bot`，含 `synthesizedFrom`。同输入同 hash，可复现、可对比。
- **提升**：工单详情提供「存为 Bot」——把快照填进 Bot 编辑器，用户补 `id`/`name`/匹配规则后保存。**不自动写入** bots 文件：自动生成的 Bot 会污染资产，且没人负责维护它的 `requires`。
- **边界**：ad-hoc 不新增字段、不改闸门、不提升权限；它就是「一次性的 Bot」。

## 7. 工作流：只做编排，不做脚本

`lib/live/workflow.js` 的价值全在结构保证：阶段 key 化、review 前绑定 `digest`、gates 不过不进 review、返工预算、从失败阶段续跑。这些不能被「任意流程」换掉。

允许的自定义只有四项：跑哪些阶段（`STAGES` 的子集，且必须保序、含 `implement` 与 `gates`）、每个阶段用哪个 Bot（例如 review 固定用只读 Bot）、每阶段预算、闸门集合。**禁止**自定义阶段名（会破 `validate()` 与续跑）、禁止跳过 `gates`、禁止在 review 后修改候选（`candidate_changed` 检查保留）。

## 8. 落地切片

每片独立可交付，跑完 `AGENTS.md` 的最低闸门。

**P0 契约层（约 1 天）**
新增 `lib/live/worker-bot.js`（`normalizeBots` / `validateBot` / `capabilitiesOf` / `resolveBot` / `synthesizeBot`），`lib/live/config.js` 增 `executor.bot`、`executor.botsFile`、`executor.dispatch`（含 `normalizeDispatch` 白名单），保留 `workerPreset`/`implementer`/`reviewer` 作为兼容回退（旧 `live.json` 不改也能跑）。测试 `lib/live/worker-bot.test.js`：非法 effort、能力缺口、不存在的 preset、空 Bot 回退、adhoc 合成确定性。

**P1 参数生效与进程契约（约 2 天）**
`lib/live/worker.js:20-23` 透传 `reasoningEffort`/`maxTokens`；`worker-cli.js` 增 `effortArgs()` 与测试；`lib/live/executor.js:1390` 与 `:1522` 一带把 `workerPreset` 换成 `resolveBot()` 结果，staged 与非 staged 两条路径都吃。同一片顺手做 §11.1 与 §11.2：task 改走 stdin、brief 改走 `--append-system-prompt-file`，Claude 分支加 `--strict-mcp-config` + 空 `--mcp-config` + `--setting-sources project` 与 `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS|CRON`。验收：单测断言 effort 出现在 `agentOptions`、两套 argv 正确、**prompt 不再出现在 argv 里**。

**P1.5 续传与后台卫生（约 1 天）**
Claude 分支首轮 `--session-id <randomUUID()>`、返工轮 `--resume` + `--system-prompt-snapshot off`（§11.3——`executor.js:1536`/`:2429` 已经把 `sessionId` 传进来了，要改的是 `cliInvocation` 与 id 的来源：今天传的 `worker-<ticket>-<run>` 不是合法 UUID）；`runProcess` 加 `idleTimeoutMs`（§11.4）；被拒工具记 `denied` 事件并注入下一轮 brief（§11.5）；`worker_lost`/超时路径补 `indeterminate`（不变量 8）。Codex 的 `exec resume` 留到 P4。验收：两次调用共用同一 session id 的单测 + 一次真实返工跑通的 dev bot 记录。

**P2 分派（约 2 天）**
新增 `lib/live/dispatch.js`（规则 + 模型 + `validateChoice` + 缓存），`resolveDispatch()` 接入 `executor.js` 的路由调用点，run 增 `botId`/`reason`/`source`/`capability`/`degraded`。测试：模型超时降级、非法输出降级、能力不足拒绝、显式覆盖不静默替换、adhoc 触发条件。

**P2.5 增量事件（约 1 天）**
按 §12 把 `runProcess` 的整段缓冲换成行解析 + 节流落盘；`executor.js` 那三处 `traceOf(...)` 保留（收尾仍以完整解析为准，增量只负责「跑着就能看」）。验收：杀掉一个 run，`run.trace` 非空且最后一条是 `stopped`。

**P3 UI（约 2–3 天）**
`client/src/settings.js` 增「Bot」分组（列表/编辑/复制内置/预览它拿到哪些工具与 MCP 前缀/保存期校验提示）；工单详情显示 Bot 与理由 + 「换 Bot 重跑」+「存为 Bot」+ 中断/被拒 run 直接展示已有 trace + 「仓库里的 Bot 文件已忽略」提示；`locale/*.json` 同步；`scripts/render-check.mjs` 增渲染与校验失败断言。

**P4 可选**
`stages` 编排 UI、逐 Bot 闸门集合、Bot 导入导出、preset 发现器（列宿主已有 preset，避免填错 id）。

**合计**：P0–P3 约 8–10 个工作日；主要成本在 render-check 的 fixture 与两套 locale，不在功能本身。

## 9. 已知边界与不做的事

- 不做跨 run 的会话复用（不变量 1）；run 内续传见 §11.3。
- 不做 Skill/MCP 沙箱；`skills.policy='preset'` 只是「用专属 preset」，不构成隔离（不变量 5）。
- 不做任意脚本流程（§7）。
- 决策模型不能改闸门、超时、审批与交付路径（§4.2）。
- 不做「模型自动新建 Bot」：只允许「存为 Bot」的显式动作（§6）。
- 不做跨进程精确阶段恢复（沿用 `staged-workers.md` 的既有边界）。
- 真实验证仍需 dev bot + 真实 CLI 登录；单测与 `render-check` 的页面挂载不等于生产验证。
- 不用 claude / codex 各自的 `--worktree`：worktree、分支、提交都归执行器，两个 worktree 会让人分不清在提交哪一个。
- 不做 CLI 沙箱：Claude 分支拿到的是 Bash + 网络，Bot 的 `tools.deny` 是「不给工具」，不是「给不了能力」（不变量 5、§11.2）。
- 不抄 OpenMausBot 的 provider fleet / shadow 实例 / 预热会话 / 模型目录发现 / TTS / 云电脑：面板一个引擎进程只伺候一个工单池，没有 fleet 可管，抄过来就是无人维护的空壳。
- 不做 Bot 调度器/触发器：Bot 只定义「这类活怎么干」，不定义「什么时候干」。排期归来源、触发与工单（§0、§3）。
- 不做 Bot 市场、分享与自动发现：跨机器共享只走 P4 的显式导入/导出，机器人不等于可执行的他人配置（不变量 7）。
- 不做「按 Bot 自动造专属 preset」：preset 仍由用户/registry 提供，`skills.policy='preset'` 只能指向已存在的 preset。

## 10. 已确认的口径

1. **Bot 文件只放 `stateDir`**（`<stateDir>/worker-bots.json`）。不读仓库内 Bot 文件；跨机器共享走 P4 的显式导入/导出。
2. **内置只有三个 Bot**，都按「与今天行为一致」定义，不含「插件开发」：`generalist`（默认，跟随宿主后端与模型）、`surgical`（小改动，等价今天的 simple 模式：`implement → gates`，不跑 plan 与 review，见 `workflow.js` 中 `plan` 为空即 `ready` 的分支）、`reviewer`（只读 + `report`，供 review 阶段用）。`docs/worker-bots.md` §3 的 `dsh-plugin-dev` 是**用户自建 Bot**的形态示例，不是内置项。
3. **ad-hoc 默认开启**（`dispatch.adhoc = true`）。触发时不得改变今天的默认行为：合成出的 Bot 沿用 `executor.*` 的预算、默认后端与宿主默认 preset，单轮执行，不自动升级到 staged 流程。
4. **run 内续传、跨 run 不续**（不变量 1、§11.3）。Claude 先行，Codex `exec resume` 作 P4 可选项；prompt 一律走 stdin（§11.1）。

实现时第 1–3 条写进 `lib/live/config.js` 的默认值与 `normalizeDispatch`，并用单测钉住：默认配置下 `resolveDispatch()` 的结果与 v1.0.7 选出的后端一致。

## 11. CLI 后端的进程契约（借自 OpenMausBot，已本机核对）

OpenMausBot 把 `claude`/`codex` 当**协议端点**跑：一个 driver 一个文件，各自的原生流归一成一套 runtime event stream，审批走反向请求（`--permission-prompt-tool` / ACP 的 `session/request_permission`）。我们不抄它的 fleet、shadow 实例、预热会话与模型目录发现（§9），只抄下面六件与「后台无人值守 worker」直接相关的。

本机已装两份对应 skill（`~/.dsh/skills/using-claude-cli`、`using-codex-cli`，来自 [yikox/skills](https://github.com/yikox/skills)）：实现 §11 之前先读它们，它们是这两个 CLI 的无人值守调度契约，比这里的摘要细。

核对版本（2026-11-20，本机）：`claude 2.1.316 (Claude Code)`、`codex-cli 0.169.1`。下面每条以此为准；升级 CLI 之后要重跑一遍这份核对。

### 11.1 prompt 不进 argv

`claude -p` 的 prompt 可以从 stdin 读（`--print` 本身不带值），`codex exec -` 也从 stdin 读。今天 `cliInvocation` 把 `task` 塞进 argv（Claude 的第一个位置参数、Codex 的最后一个参数），两个实际后果：`ps` 能读到工单全文；工单越长越可能撞 argv 上限。改为 **task 走 stdin，argv 只留开关**（`runProcess` 要多一个 `stdin` 入参）。

- brief 也走文件：`--append-system-prompt-file <path>`（写进 0600 临时目录，OpenMausBot 的 `server/drivers/claude.ts:1271` 就是这么做的）。这样 argv 里只剩开关名，`ps` 读不到任何工单内容。

**`--help` 不是能力清单**。这个 flag 在 claude 2.1.316 里是 `addOption(new bs("--append-system-prompt-file <file>", "Read system prompt from a file and append to the default system prompt").argParser(String).hideHelp())` —— `hideHelp()` 让它在 `--help` 里完全消失，`claude --help | grep -c` 得 0，但二进制里出现 14 次、真传了能生效。同类隐藏项至少还有 `--system-prompt-file`、`--permission-prompt-tool`、`--max-turns`、`--thinking`。

判断一个 flag 有没有，用零成本运行期探测：传一个不存在的路径，若在**任何 API 调用之前**就报「`Error: Append system prompt file not found: <path>`」，说明它被解析且接进了运行路径。反过来，`--help` 加任何参数都 exit=0（连故意打错的 flag 都不报错），拿 `--help` 的退出码或输出做判断只会得出错误结论。OpenMausBot 的做法更稳：`CLAUDE_FLAG_FLOORS` 表 + `claudeCliSupports(version, flag)`，按版本探测新/隐藏 flag，缺了就退化成不带。

### 11.2 隔离宿主配置（只对 Claude 分支）

今天 claude worker 继承本机的一切：`~/.claude` 的 MCP server、hooks、插件 skill、全局 `CLAUDE.md`。对无人值守 worker 是两个问题——多出来的工具（OpenMausBot 注释里实测「一台桌面机 407 个工具、约 10k tokens 系统提示」）和不该有的副作用（hooks、后台任务在回合结束后继续写 worktree）。三个开关：

- `--strict-mcp-config` + `--mcp-config <空 JSON>`：只加载我们给的 MCP，不给就是没有。
- `--setting-sources project`：只读 worktree 里的项目设置，不读用户全局设置（hooks / MCP / 记忆）。仓库自带的 `CLAUDE.md` 仍然生效——对改代码是有用上下文，这是有意取舍；UI 口径仍是「不承诺隔离」（不变量 5）。
- 环境：`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`、`CLAUDE_CODE_DISABLE_CRON=1`。
- 工具面用 `--tools <list>` 限定内建工具**集合**，`--allowedTools` 只是在集合内预先批准：两者不能互相替代。今天只给了后半个（白名单 + 反白名单），模型仍知道有 Bash 之外的一堆工具存在。
- 一次性回合（不需要续的那个）加 `--no-session-persistence`，别在 `~/.claude` 里堆会话目录。
- **不用 `--worktree`（claude 也有这个 flag）**：worktree 归执行器，worker 自己再开一个只会让「提交哪个目录」变成两个答案。

**不用 `--bare`**：它顺带禁掉 keychain/OAuth 读取，worker 就只能靠 `ANTHROPIC_API_KEY`，与「用本机已登录的 CLI」这个前提冲突。

### 11.3 会话续传（只在 run 内）

- Claude：首轮 `--session-id <uuid>`——**必须是合法 UUID**，今天传的 `worker-<ticket>-<runId>` 不是，直接传会被 CLI 拒；返工轮 `--resume <同一个 uuid>`，并同时传 `--system-prompt-snapshot off`。
- 为什么必须关 snapshot：默认 `on` 时，首轮会把渲染好的 system prompt **记录在会话里**，之后每个请求与**每次 `--resume` 都按记录原样重发**，直到 compact。也就是说返工轮改了 brief 也白改，模型还在按首轮的话术干活。`off` = 每请求重新渲染。这个 flag 是 2.1.267 才有的，旧版只能接受「续传就沿用旧 brief」。
- Codex：去掉 `--ephemeral`，从 `thread.started` 取 `thread_id`，返工轮 `codex exec resume <thread_id>`。`exec resume` 子命令**自己**没有 `-s`/`-C`，但 `-a`/`-s`/`-C` 都是**顶层**参数，写在子命令之前即可：`codex -a never -s workspace-write -C <worktree> exec resume <thread_id> --json -o <file>`。会话落在 `~/.codex/sessions`，要么接受残留要么加清理。所以 **Claude 先行，Codex 列 P4**。
- Codex 的审批参数是顶层 `-a never`，不是 `-c approval_policy="never"`。今天 `cliInvocation` 用的是后者：`-a` 才是文档化的开关，`-c` 键随版本漂移且不表达意图。
- 续传只发生在 run 之内（不变量 1）；`indeterminate` 的 run 禁止续传（不变量 8）。

### 11.4 CLI 也要 idle 超时

`runProcess` 只有总超时（`timeoutMs`，默认 25 分钟）；DSH worker 有 `idleTimeoutMs`，CLI 路径没有。补：每收到一行合法 JSON 就刷新 `lastLineAt`，超过 `idleTimeoutMs` 无输出即 SIGTERM（沿用现有整组 kill）。一个卡在网络上的 `claude` 不该占满 25 分钟。

### 11.5 被拒的工具要说话

两个 CLI 在「工具不在白名单」时都静默拒绝，worker 于是换一种更糟的写法继续、或者直接放弃，run 里只剩一句「没做完」。把流里的拒绝（Claude 的 `tool_use` 没有配套结果、Codex 的 item 失败）记成 `{type:'denied', name}` 事件，并在下一轮返工的 brief 里加一句「上一轮这些工具被拒：…，换个做法」。这是 Bot `tools.deny` 真正生效的反馈回路，也是不变量 5 的补丁：拒了，要让人知道拒了。

### 11.6 结果契约：怎么判断这轮成没成

退出码不是判据，两边都有「exit 0 但没干活」的形态：

- Claude：找最后一条 `type:"result"` 事件，要求 `subtype == "success"` 且 `is_error == false`，正文取 `.result`，续传 id 取 `.session_id`。`--output-format json` 只产出这一个对象；`stream-json` 是逐条 JSONL，同样以它收尾。
- Codex：必须出现 `turn.completed`（失败是 `turn.failed`），最终答复从 `-o/--output-last-message` 那个文件读，不要从 JSONL 里重组；续传 id 取 `thread.started` 的 `thread_id`。
- 今天 `worker-cli.js` 的判定是「有 text 就算成功、没有就报 `CLI returned no result text`」。补上上面两条后，`turn.failed`、`is_error:true` 都能落成明确失败而不是「没做完」，`indeterminate`（不变量 8）也就有了客观来源。

## 12. 增量事件流（把 trace 变成「跑着就能看」）

今天 `run.trace` 只在回合结束后由 `traceOf(worker.events)` 落盘，所以：worker 跑着的时候工单详情一片空白；被超时或停止杀掉的 run 连一条 trace 都没有（`executor.js:1553` 那段根本走不到）。OpenMausBot 的做法是边读边归一成事件、经 SSE 推给 UI；我们不需要新传输——面板本来就轮询 `engine/status`，**只要事件在跑的时候就进了 run，现有 poller 就显示得出来**。

- `runProcess` 增 `onLine(line)`：按 `\n` 切行，尾部不完整的一行留在 buffer 里；把 `parseClaudeStream`/`parseCodexStream` 的循环体提成 `applyClaudeLine(state, line)` / `applyCodexLine(state, line)`，增量与收尾两处共用（收尾仍走完整解析，增量不参与任何判定）。
- 事件写进 `run.trace`，沿用 `TRACE_LIMIT=80`、`clipSummary` 的 300 字、环形丢弃最旧。
- **节流落盘**：≥500ms 或积满 8 条才 `persist()` 一次，不在每行写盘。
- 被杀/超时的 run 保留已写入的 trace，末尾补一条 `{type:'error', summary:'stopped'|'timeout'}`——这是「为什么挂了」唯一的证据。
- 不做 token 级 delta 合并（OpenMausBot 的 `DELTA_MERGE_MS=50` / `MAX_QUEUED_EVENTS=4096` 那一套）：面板不是聊天流，工具调用粒度的可见性够了，多一层合并就多一处要维护的状态机。

成本：一个行解析器 + 一次节流，没有新组件、没有新传输。

## 13. Bot 与「一类重复工作」

Bot 的价值不在单次执行，而在同一类活第二次、第十次到来时：

- **认领**：哪类工单落到哪个 Bot，写在分派层——`dispatch.rules`（工作类型 / 关键词 / 仓库 / 来源 / 交付形态）、`repo.bot`、来源默认。Bot 本身不写「几点跑」「跑几次」。
- **复用**：同一 Bot 每次 run 都从同一份定义实例化新的 worker：同样的角色说明、同样的工具面、同样的预算与阶段。复用的是定义与流程，不是上下文（不变量 1）。
- **可替换**：同类活效果不好时，改的是这个 Bot（换模型、换 effort、收紧 `tools.deny`、把阶段砍成 `implement → gates`），或者换一个 Bot 接；工单本身不动。
- **可比较**：`run.botId` + `run.bot` 快照让「同一 Bot 的成功率 / 返工轮数 / 耗时 / 闸门通过率」可聚合。没有这个记录，Bot 只是换了个名字的参数，谈不上「固定重复工作」的资产。
- **可显式纠正**：详情页「换 Bot 重跑」对单次工单换执行者而不改工单，「存为 Bot」把现拉结果沉淀成资产——这是从一次性到固定工作的唯一人工闸口。
