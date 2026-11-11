# AGENTS.md — dsh-superagent-panel

DeepSeek Harness（DSH）插件：Web UI 里的「超级智能体」管理面板（工单 / 来源 / 触发 / 评估 / 执行 / 验收 / 部署）。
本文件是给在这个仓库里干活的 Agent（包括 Superagent worker）的项目规则；更细的设计说明见 `README.md` 与
`CHANGELOG.md`（`spec/`、`verification/` 是本地验收材料，不进仓库，干净 clone 里看不到）。

## 先读什么

1. `README.md` 的「功能」「开发与验证」「状态与配置」三节。
2. `CHANGELOG.md` 最近两个版本（改动的写法、验证口径都以它为准）。
3. 要动的文件本身，以及它的测试（`*.test.js` 与 `scripts/render-check.mjs` 里的对应断言）。

## 结构

- `index.js`：Host 半。`/superagent/api` 路由、动作分发、与宿主（DSH）交互。**改这里要在 DSH 里
  禁用→启用插件（或重启 DSH）才生效。**
- `lib/`：旧管理层的只读投影/写操作（`views.js`、`actions.js`、`seed.js`、`prompts.js`，当前客户端不使用）。
- `lib/live/`：真实引擎。`engine.js`（循环与状态）、`executor.js`（worktree/worker/闸门/提交/推送/PR）、
  `worker.js`（进程内 DSH worker）、`repo.js`（git 与分支守卫）、`config.js` + `repos.js` + `live-json.js`
  （live.json 与多仓库）、`octo.js`（群轮询）、`gitlab.js`（GitLab API）、`eval.js` / `judge.js`（接单评估）、
  以及 inbox/signals/operations/acceptance 等台账。
- `client/src/*.js`：客户端源码，按文件名的数字前缀排序后拼接；`client/index.js` 是**构建产物，必须提交**。
- `scripts/`：构建与验收脚本（`build-client.mjs`、`check-keys.mjs`、`render-check.mjs`、`verify-panel.mjs`）。
- `locale/`：插件清单文案（中/英）。
- `cordis.patch.yml`：插件注册（sidebar/main 槽位）。
- `.github/workflows/auto-pr.yml`：GitHub 仓库的交付桥——执行器只能推 feature 分支，这个 workflow 负责开 PR。

客户端改动刷新页面即生效；Host 半改动要重载插件。**验收/截图类脚本可能在 `spec/`、`verification/` 写文件，
这两个目录被 gitignore，不要把它们的产物提交。**

## 每次改动的最低要求

```bash
node --check index.js                              # Host 半语法
node scripts/build-client.mjs --check               # 客户端产物是否最新（改了 client/src 先跑 node scripts/build-client.mjs）
node scripts/check-keys.mjs                        # 中英文 key 覆盖
node --test lib/store.test.js lib/live/*.test.js   # Host 测试（全量，当前 398 个）
node scripts/render-check.mjs                      # jsdom 渲染回归（依赖 /tmp/sa-harness）
```

- 改了客户端源码：先 `node scripts/build-client.mjs`，把 `client/index.js` 一起提交，否则闸门失败。
- 改了 Host 半或客户端行为：必须补/改对应测试（`lib/live/*.test.js` 或 `scripts/render-check.mjs`），
  不能只改代码不补断言。
- 提交信息沿用 `fix(0.4.x): 一句话` / `feat(0.4.x): 一句话`；每个改动在 `CHANGELOG.md` 顶部加一节
  （最新版本在上），写清根因、修改点、验证数字，并把 `package.json` 的 `version` 升一个 patch。
- `CHANGELOG.md` 的 H1 `# Changelog` 在最上面，版本节按倒序排列。

## 禁止

- 不要 `git push` / `git merge` / `git tag` / `gh pr`：执行器负责提交、推送与交付；worker 只改工作树。
- 不要碰受保护分支（`main`/`dev`/`develop`/`master`）或强推；不要改 `.git/config`、`.env*`、`secrets/`、
  `node_modules/`、`logs/`、`graphify-out/`。
- 不要修改 `scripts/local/` 之外的部署/导出脚本，不要执行生产部署、DDL/DML。
- 不要删 `spec/`、`verification/` 或 `.gitignore` 里的忽略规则（它们是本地材料，不进仓库）。
- 不要凭猜测改 `live.json` 契约（`lib/live/live-json.js` 的白名单、`repos.js` 的归一化）而不加测试。

## 交付语义（GitHub 仓库）

`live.json` 里本仓库的仓库项使用 `verifyMode: "manual"`、`createMr: "push"`、`ci: false`：

- 执行器跑完闸门、提交并推送 `feature/<ticketId>` 分支；对 github.com 仓库**不带 GitLab push options**推送
  （GitHub 忽略这些选项，且实测带 options 的推送会被服务端以 `no voting servers succeeded` 拒绝），
  `.github/workflows/auto-pr.yml` 收到分支后自动开 PR，人工评审合并。
- 合并请用 merge commit（不要 squash）——面板靠 `git merge-base --is-ancestor` 判断是否合入 `main`。
- 面板侧工单先到 `mr-open`（从推送输出解析 `/pull/new/` 链接），合并后自动转 `merged`，再由人验收。
