# AGENTS.md — dsh-superagent-panel

DeepSeek Harness（DSH）插件：Web UI 里的「超级智能体」管理面板（工单 / 来源 / 触发 / 评估 / 执行 / 验收 / 部署）。
本文件是给在这个仓库里干活的 Agent（包括 Superagent worker）的项目规则；更细的说明见 `README.md`、`docs/` 与
`CHANGELOG.md`（`spec/`、`verification/` 是本地验收材料，不进仓库，干净 clone 里看不到）。

## 先读什么

1. `README.md`（概览与安装）与 `docs/pages.md`「页面说明」、`docs/quickstart.md`「状态与配置」。
2. `CHANGELOG.md` 最近两个版本（改动的写法、验证口径都以它为准）。
3. 要动的文件本身，以及它的测试（`*.test.js` 与 `scripts/render-check.mjs` 里的对应断言）。

## 结构

- `index.js`：Host 半。`/superagent/api` 路由、动作分发、与宿主（DSH）交互。**改这里要在 DSH 里
  禁用→启用插件（或重启 DSH）才生效。**
- `lib/util.js`：Host 与引擎共用的纯函数。旧的「管理层」（`views.js`/`actions.js`/`store.js`/`seed.js`/`prompts.js`）
  与它挂的 25 条 `/superagent/api` 演示路由已在 0.9.6 删除，现在只有引擎一套 API。
- `lib/live/`：真实引擎。`engine.js`（循环与状态）、`executor.js`（worktree/worker/闸门/提交/推送/PR）、
  `worker.js`（进程内 DSH worker）、`repo.js`（git 与分支守卫）、`config.js` + `repos.js` + `live-json.js`
  （live.json 与多仓库）、`octo.js`（群轮询）、`gitlab.js`（GitLab API）、`eval.js` / `judge.js`（接单评估）、
  以及 inbox/signals/operations/acceptance 等台账。
- `client/src/*.js`：客户端源码，ES 模块，入口 `client/src/index.js`（显式按 基础 → 外壳 → 页面 的顺序 import，
  `react.js` 收敛 React/`h`/hooks），由 esbuild bundle 成 CJS 再包进 `__ModuleLoader__` 工厂；
  `client/index.js` 与 `client/index.js.map` 是**构建产物，必须提交**。改源码后先 `node scripts/build-client.mjs`。
- `scripts/`：构建与验收脚本（`build-client.mjs`、`check-keys.mjs`、`render-check.mjs`、`verify-panel.mjs`、
  `isolated-verify.mjs`、`local-install.mjs` 本机打包安装）。
- `locale/`：插件清单文案（中/英）。
- `docs/`：机制、流程、配置与排障细节（如 `docs/self-development.md` 的自开发完整操作、
  `docs/intake-and-eval.md` 的评估与接单配置、`docs/feature-maturity.md` 的功能成熟度清单）；README 只留摘要与入口。
- `cordis.patch.yml`：插件注册（sidebar/main 槽位）。
- `.github/workflows/auto-pr.yml`：GitHub 仓库的交付桥——执行器只能推 feature 分支，这个 workflow 负责开 PR。

客户端改动刷新页面即生效；Host 半改动要重载插件。**验收/截图类脚本可能在 `spec/`、`verification/` 写文件，
这两个目录被 gitignore，不要把它们的产物提交。**

## 本机两种安装态（必须分清）

本机同一个插件有两种装法，用途不同、互斥：

| profile | 形态 | 用途 |
| --- | --- | --- |
| `desktop` | **干净安装**：依赖写 `file:…/releases/dsh-superagent-panel-<version>.tgz`，`node_modules/@mystic7c/dsh-superagent-panel` 是**实体目录** | 日常使用、对外演示、截图；跑的一定是发布产物 |
| `dev` | **软链到工作树**（`link:`） | 边改边看：`node scripts/build-client.mjs` 之后刷新页面就是新代码 |

硬线：

- **不要把本仓库目录 `add` 进 `desktop` profile**（`dsh plugin --profile desktop add <仓库路径>`）：那会把桌面端变成
  指向工作树的软链，你看到的就不再是 Release 里的代码，截图、验证结论、用户反馈全部失真。桌面端只从 tarball 升级：
  `node scripts/local-install.mjs`（默认只允许在 `main` 上打包）或 `dsh plugin --profile desktop add <tgz>`。
- 每次升级前后都用 `node scripts/local-install.mjs --verify` 核对：它只读，会打印 dependency 是否为 `file:<tarball>`、
  包目录是实体目录还是软链，并给出结论。
- 边改边看：`npm run dev`（= `node scripts/dev.mjs`，内部就是 `dsh --profile dev --no-open --port 0`），
  打开它打印的带 token 的 URL。客户端改动 = `node scripts/build-client.mjs` + 刷新页面；Host 半改动 = 重启这个实例。
  `dev` profile 的 bundles 是 `dsh-base` + `dsh-web-app` + 本插件，依赖为 `link:` 指向本仓库。
- 两个实例都不该同时对着同一份真实状态调试引擎：给 dev 实例加 `DSH_SUPERAGENT_STATE_DIR=<临时目录>`，
  免得 dev 里的试跑写进 `~/.dsh/superagent/live.json`。另外全局 `~/.dsh/cordis.patch.yml` 里的 MCP 条目在 dev
  实例也会加载，连不上时只打印一行 warning，与本插件无关。
- 本机没有把 `dsh` 放进 PATH：命令写全路径
  `"/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"`，或自己加个 alias。

## 每次改动的最低要求

```bash
npm ci                                              # 首次：安装 devDependencies（无运行时依赖）
node --check index.js                              # Host 半语法
node scripts/build-client.mjs --check               # 客户端产物是否最新（改了 client/src 先跑 node scripts/build-client.mjs）
node scripts/check-keys.mjs                        # 中英文 key 覆盖
npm run types                                       # types/dsh.d.ts 自身能否通过 tsc
npm run check:js                                    # checkJs 清单（全量：Host 半 + 客户端入口）
node --test lib/live/*.test.js                     # Host 测试（全量）
node scripts/render-check.mjs                      # jsdom 渲染回归（干净 clone 先 npm ci；无 live.json 时用内置 fixture）
```

- 改了客户端源码：先 `node scripts/build-client.mjs`，把 `client/index.js` 一起提交，否则闸门失败。
- 改了 `tsconfig.check.json` 里的任何一个文件：跑 `npm run check:js`；给一个旧文件补完 JSDoc 后把它加进 `files`，
  不要为了让绿灯把文件移出去（这一档只增不减）。0.9.12 起 Host 半与客户端入口 `client/src/index.js` 都已入档，
  清单外的客户端片段只有新文件才需要手动追加。
- 改了 Host 半或客户端行为：必须补/改对应测试（`lib/live/*.test.js` 或 `scripts/render-check.mjs`），
  不能只改代码不补断言。
- 提交信息沿用 `fix(0.4.x): 一句话` / `feat(0.4.x): 一句话`；每个改动在 `CHANGELOG.md` 顶部加一节
  （最新版本在上），写清根因、修改点、验证数字，并把 `package.json` 的 `version` 升一个 patch。
- `CHANGELOG.md` 的 H1 `# Changelog` 在最上面，版本节按倒序排列。

## 文档分层

- `README.md` 只放项目概览、功能要点、安装、快速开始摘要、开发命令与文档索引（目标 100 行以内）。
- 机制/流程/配置/排障细节放 `docs/`（例如自开发的完整操作在 `docs/self-development.md`）。
- 版本变更写 `CHANGELOG.md`，不要把版本历史塞进 README。
- 新增内容先判断归属，不要把长文继续塞进 README；页面细节进 `docs/pages.md`，配置与排障进 `docs/quickstart.md`。

## 禁止

- 面板自开发模式下 worker 只改工作树：不要 `git push` / `git merge` / `git tag` / `gh pr`——跑闸门、提交、推送与
  交付是执行器的活（见下面「两种开发方式」）。
- 在 DSH 会话里直接本地开发时，会话里的 Agent 可以提交并推**交付分支**，但同样受「两种开发方式」的硬线约束，
  不因为“不是执行器”就可以直推受保护分支。
- 不要碰受保护分支（`main`/`dev`/`develop`/`master`）或强推；不要改 `.git/config`、`.env*`、`secrets/`、
  `node_modules/`、`logs/`、`graphify-out/`。
- 不要修改 `scripts/local/` 之外的部署/导出脚本，不要执行生产部署、DDL/DML。
- 不要删 `spec/`、`verification/` 或 `.gitignore` 里的忽略规则（它们是本地材料，不进仓库）。
- 不要凭猜测改 `live.json` 契约（`lib/live/live-json.js` 的白名单、`repos.js` 的归一化）而不加测试。

## 两种开发方式（同一套 GitFlow）

在本仓库写代码有两种方式，角色不同、交付路径相同：

| 方式 | 谁写代码 | 谁提交与推送 | 怎么进集成分支 |
| --- | --- | --- | --- |
| **面板自开发**（工单驱动） | 执行器为工单开 worktree；worker 只改工作树 | 执行器：跑闸门 → 提交 → 推 `feature/<ticketId>` | auto-pr 开 PR（base `develop`）→ 人评审合并 |
| **DSH 会话里直接本地开发** | 会话里的 Agent 或人，直接改本仓库工作树 | 会话里的 Agent/人自己提交、推交付分支（`fix/**`、`feature/**`、`chore/**`、`docs/**`） | 同上：auto-pr 开 PR（base `develop`）→ 人评审合并 |

第二种方式**不是**“本地开发就可以随便推”：`禁止`一节里“worker 只改工作树、由执行器交付”说的是第一种方式的分工，
换到会话里直接开发，规矩变成“自己就是提交者，但仍必须走交付分支 + PR”。

两种方式共同的硬线（**没有例外**）：

- 只在交付分支上提交，推上去交给 auto-pr 开 PR；发布只从 `release/**` / `hotfix/**` 进 `main`。
- **不直接推 `main`/`develop`，不向受保护分支强推**。这两个分支挂着 required status checks，直推会“推送成功”但绕过检查
  （GitHub 回显 `Bypassed rule violations … required status checks are expected`）；本地闸门绿不等于 CI 绿，被绕过的检查
  等于没有。（交付分支上改自己还没合并的提交，`--force-with-lease` 可以；合并进 `develop` 之后就不要再改写历史。）
- 不 squash：合并用 merge commit（fast-forward 也算）。面板用 `git merge-base --is-ancestor` 判断改动是否已进集成分支。
- PR 合并前 `.github/workflows/ci.yml` 必须是绿的；Actions 开的 PR 不能被同一个 token 合并，必须由人评审后合并。
- 推送前用**干净状态**再跑一遍渲染闸门：`render-check` 在 `~/.dsh/superagent/live.json` 存在时读的是**本机真实状态**，
  干净 clone 与 CI 读的是 `test/fixtures/live.json`，两边结果可以不同。`DSH_SUPERAGENT_STATE_DIR=$(mktemp -d)
  node scripts/render-check.mjs` 就是 CI 的条件（1.0.4 的 CI 红就是“本地有 42 条决策、CI 只有 1 条”漏出去的）。

## 交付语义（GitHub 仓库）

分支模型、交付桥（`.github/workflows/auto-pr.yml` 按前缀开 PR）、合并方式与发布流程见
[`docs/delivery.md`](docs/delivery.md)。给 Agent 的三条硬线：不推 `main`/`develop`，不 squash 合并，
推送不带 GitLab push options。
