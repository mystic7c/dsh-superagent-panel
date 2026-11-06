# dsh-superagent-panel

Superagent 管理面板 —— 一个带**左侧栏入口**的 DeepSeek Harness 插件：在 Web UI 里打开「超级智能体」面板，
管理主动型编码智能体（Superagent）的工单、来源、触发、评估、执行器与部署配置。

面板的页面划分与交互参考
[dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype)；宿主侧按原型的数据/API
契约重新实现为**可持久化、可写、与本机 DSH 同源**的本地管理服务。

## 功能

| 页 | 内容 |
|---|---|
| 概览 | 值班摘要：需要人处理的工单（评审/回答/受阻/失败）→ 系统问题 → 24 小时漏斗、策略规则与系统脉搏 |
| 来源 | GitHub / 飞书 来源状态、健康检查、被过滤与未送达消息、开关与名单同步 |
| 触发 | 线程列表与详情：评估过程、消息时间线、订阅管理 |
| 评估 | 决定列表（接单/续做/停止/忽略）与命中规则明细 |
| 执行 | 执行器负载、工单队列台账、手工建单、工单详情与执行记录 |
| 设置 | 来源 / 运行 / 写权限 / 仓库 四组可写；评估与提示词为只读参考 |

## 安装

前置：DSH（含 Web UI）、Node.js ≥ 18。

```bash
# 在 DSH 会话中让 agent 执行，或通过 Plugin Manager 安装该目录
plugin_manager install_bundle target=<本仓库目录>
```

安装后左侧栏出现「超级智能体」入口。插件以 `link:` 方式安装到 profile，本地改动即时可见。

## 状态与配置

- 状态文件：`~/.dsh/superagent/state.json`（环境变量 `DSH_SUPERAGENT_STATE_DIR` 可覆盖目录）。
- 首次启动写入演示数据（`demo: true`，界面显示「演示数据」徽标）；之后所有写操作真实写入该文件。
- 重置演示数据：删除 `state.json`，或 `POST /superagent/api/demo/reset`。
- 设置页可配置：来源监听范围与 token、执行器后端（DSH / Codex CLI / Claude Code CLI）、写权限闸门、
  仓库绑定与部署健康检查。

## 能力边界

**真实可用**：状态持久化与全部面板写操作（含修订号冲突检测、保存历史与 diff）；部署检查真实调用
`gh` 验证身份与推送权限；模型目录读取宿主 LLM 服务的实时 provider/model 列表。

**暂为演示**：不轮询 GitHub/飞书、不调用 LLM 做评估、不创建真实 Worker Session；工单来自演示种子，
重试/停止只改变状态机并记录输入，不会启动执行器。

## 目录结构

```
index.js            Host 半：/superagent/api 路由、状态装载与动作分发
lib/
├── store.js        单文档 JSON 持久化（temp+rename 原子写、串行化读改写、损坏备份）
├── seed.js         演示种子
├── views.js        只读投影：所有 GET 响应的形状
├── actions.js      写操作：设置/提示词、暂停、重试、停止、忽略、重新评估、退订、部署检查
├── prompts.js      提示词模型：团队段落、内置段落、模板组装与预览
└── live/           真实引擎：配置、评估、执行器、GitHub/GitLab 客户端
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
plugin_manager remove_bundle target=@mlamp/dsh-superagent-ui
```

状态目录 `~/.dsh/superagent` 不会被删除，可手动清理。

## License

MIT
