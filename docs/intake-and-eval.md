# 评估、接单与决策模型

本文件是评估与接单的进阶配置，非安装必读；安装、5 分钟接入与面板概览见 [README](../README.md)。

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
