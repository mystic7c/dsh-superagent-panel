# 分阶段 Worker

设置 → Worker → 分阶段执行，可选择关闭（默认，兼容旧行为）、自动评估、直接实现、Codex 规划与独立验收；实现后端选择 DSH 或 Claude Code。保存后新运行生效，不需要修改本机 live.json。

自动模式由独立只读 Codex 调查相关代码并输出 simple/planned。planned 路径为 Codex 规划 → DSH/Claude 实现 → 仓库程序闸门 → 全新 Codex 会话验收；simple 路径直接实现并运行闸门。各阶段产物存入运行台账，工单详情显示阶段及结果。规划包含验收标准和阻塞问题；阻塞问题、程序闸门失败、CLI 错误、无效结果均阻止交付。验收可要求修复或重新规划，最多两轮。人工验收保持独立。

配置字段：executor.workflowMode = off|auto|simple|planned；executor.implementer = dsh|claude。Codex/Claude 的路径和模型沿用 executor.workers 中对应条目；明确禁用的后端不会被调用。

每次 Codex 规划/验收使用新的 ephemeral 会话，JSON Schema 约束输出。候选指纹覆盖 HEAD、tracked diff、未跟踪文件内容；验收过程中变化或发布前变化会阻止交付，需重新执行流程。postGatesCommand 改动候选文件也会使证据失效。

当前边界：失败后通过重新执行重跑流程，保留工作树修改；尚未提供跨进程精确阶段恢复、简单任务执行中自动升级、CLI 实时事件或整单时间预算。CLI 认证/额度错误不会跳过 Codex 验收。自动评估与规划均使用本机 Codex，而非外部评估 API。真实 CLI 登录与真实仓库交付需要另行验证；单测和隔离页面挂载不等于生产验证。

Ego lite 隔离实例验证：设置中选择 auto + claude、保存、刷新并重新打开 Worker 页，值保持；新增保存字段回归断言通过。截图位于 verification/ego-workflow-settings.png。仅配置界面测试，未启动模型任务。
