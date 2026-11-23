# AGENTS.md — dsh-superagent-panel

DeepSeek Harness（DSH）插件：Web UI 里的「超级智能体」管理面板（工单 / 来源 / 触发 / 评估 / 执行 / 验收 / 部署）。
本文件是给在这个仓库里干活的 Agent（含 Superagent worker）的规则；细节见 `README.md`、`docs/`、`CHANGELOG.md`
（`spec/`、`verification/` 是本地验收材料，gitignore，不进仓库）。

## 先读什么

1. `README.md`、`docs/pages.md`、`docs/quickstart.md`。
2. `CHANGELOG.md` 最近两个版本——改动的写法与验证口径以它为准。
3. 要动的文件及其测试（`*.test.js`、`scripts/render-check.mjs` 里的对应断言）。

## 结构

- `index.js`：Host 半，`/superagent/api` 路由与动作分发。**改这里要禁用→启用插件（或重启 DSH）才生效。**
- `lib/util.js`：Host 与引擎共用的纯函数。
- `lib/live/`：真实引擎。`engine.js`（循环与状态）、`executor.js`（worktree/worker/闸门/提交/推送/PR）、
  `worker.js`（进程内 DSH worker）、`worker-bot.js`（Bot 契约）、`repo.js`（git 与分支守卫）、
  `config.js`+`repos.js`+`live-json.js`（live.json 与多仓库）、`octo.js`、`gitlab.js`、`eval.js`/`judge.js`，
  以及 inbox/signals/operations/acceptance 等台账。
- `client/src/*.js`：客户端源码（入口 `client/src/index.js`），esbuild 打成 CJS 后包进 `__ModuleLoader__`；
  `client/index.js` 与 `.map` 是**构建产物，必须提交**（改源码后先 `node scripts/build-client.mjs`）。
- `scripts/`：构建与验收（`build-client.mjs`、`check-keys.mjs`、`render-check.mjs`、`verify-panel.mjs`、
  `isolated-verify.mjs`、`local-install.mjs` 本机打包安装）。
- `docs/`：机制、流程、配置与排障细节；README 只留摘要与入口。`locale/`：插件清单文案。
- `cordis.patch.yml`：插件注册。`.github/workflows/`：`auto-pr.yml`（按分支前缀开 PR）、`ci.yml`（闸门本体，
  分支保护的 required checks 就是它）——都是功能性文件，不要动 `.gitignore` 里它们的规则。
- `DESIGN.md` / `.impeccable/design.json`：设计契约的人读与机器读两半。`design.json` 是生成物，随 `DESIGN.md`
  重生成，不手改、不单独提交；`.impeccable/` 其余目录是本机工作目录（已忽略）。

客户端改动刷新页面即可；Host 半改动要重载插件。

## 本机两种安装态（必须分清，互斥）

| profile | 形态 | 用途 |
| --- | --- | --- |
| `desktop` | **干净安装**：依赖 `file:…/releases/*.tgz`，包目录是实体目录 | 日常使用、演示、截图；跑的一定是发布产物 |
| `dev` | **软链到工作树**（`link:`） | 边改边看：`build-client.mjs` + 刷新页面即新代码 |

- **不要把仓库目录 add 进 `desktop` profile**：那会把它变成指向工作树的软链，截图与验证结论全部失真。桌面端只从
  tarball 升级（`node scripts/local-install.mjs`，默认只允许在 `main` 上打包；或 `dsh plugin --profile desktop add <tgz>`），
  升级前后用 `node scripts/local-install.mjs --verify`（只读）核对。
- 边改边看用 `npm run dev`（= `node scripts/dev.mjs`，内部 `dsh --profile dev`），打开它打印的带 token 的 URL。
- 实测必须用**独立端口 + 独立状态目录**（`DSH_SUPERAGENT_STATE_DIR=/tmp/...`），**禁止用本机 desktop profile 实测**
  （不安装、不改其目录、不重启桌面端）；测完关掉实例（`pkill -f "scripts/dev.mjs"`），不留后台进程。
  dev 实例加载全局 `~/.dsh/cordis.patch.yml` 的 MCP，连不上只打 warning，与本插件无关。
- 本机 `dsh` 不在 PATH：用全路径 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。

## 每次改动的最低要求

```bash
npm ci                                         # 首次：devDependencies（无运行时依赖）
node --check index.js                          # Host 半语法
node scripts/build-client.mjs --check          # 客户端产物最新（改 client/src 先跑 build-client.mjs）
node scripts/check-keys.mjs                    # 中英文 key 覆盖
npm run types                                  # types/dsh.d.ts 自身能否过 tsc
npm run check:js                               # checkJs 清单（Host 半 + 客户端入口）
node --test lib/live/*.test.js                 # Host 测试（全量）
node scripts/render-check.mjs                  # jsdom 渲染回归（固定用 test/fixtures，不读 ~/.dsh/superagent）
```

- 改客户端源码必须同提交 `client/index.js` 构建产物，否则闸门失败。
- 改 `tsconfig.check.json` 里的文件要跑 `check:js`；给旧文件补完 JSDoc 后加进 `files`，不要为绿灯把文件移出去。
- 改行为必须补/改断言（`lib/live/*.test.js` 或 `render-check.mjs`），不能只改代码。
- 每个改动：`CHANGELOG.md` 顶部加一节（倒序，写清根因、修改点、验证数字）+ `package.json` 升一个 patch；
  提交信息 `fix(x.y.z): 一句话` / `feat(x.y.z): 一句话`。

## 文档分层

- `README.md` 只放概览、安装、快速开始摘要、开发命令与索引（目标 100 行内）。
- 机制/流程/配置/排障进 `docs/`；页面细节进 `docs/pages.md`，配置与排障进 `docs/quickstart.md`，自开发操作进
  `docs/self-development.md`，交付与分支见 `docs/delivery.md`。版本历史只进 `CHANGELOG.md`。

## 两种开发方式（同一套 GitFlow）

| 方式 | 谁写代码 | 谁提交与推送 | 怎么进 `develop` |
| --- | --- | --- | --- |
| **面板自开发**（工单驱动） | 执行器开 worktree；worker 只改工作树 | 执行器：闸门 → 提交 → 推 `feature/<ticketId>` | auto-pr 开 PR（base `develop`）→ 人评审合并 |
| **DSH 会话里直接开发** | 会话里的 Agent 或人改本仓库工作树 | 自己提交、推交付分支（`fix/**`、`feature/**`、`chore/**`、`docs/**`） | 同上：auto-pr 开 PR（base `develop`）→ 人评审合并 |

第二种不是「本地开发就能随便推」：只是换成交付者自己提交，仍必须走交付分支 + PR。

硬线（没有例外）：

- 从 `develop` 开交付分支；`main` 只接收 `release/**` / `hotfix/**`。**不直接推 `main`/`develop`，不强推**——它们挂着
  required status checks，直推会绕过检查（本地绿 ≠ CI 绿）。交付分支上改自己未合并的提交可以 `--force-with-lease`；
  进了 `develop` 就不再改写历史。
- 不 squash，合并用 merge commit（fast-forward 也算）；面板用 `git merge-base --is-ancestor` 判断是否已进集成分支。
- PR 合并前 `ci.yml` 必须绿；Actions 开的 PR 不能被同一个 token 合并，须人评审后合并。
- 渲染闸门本地跑的就是 CI 那份（固定 `test/fixtures/live.json`），本地绿与 CI 绿是同一件事；只有排障才用
  `DSH_SUPERAGENT_STATE_DIR` 指向真实状态，脚本会警告「结果可能与 CI 不同」。

## 禁止

- 面板自开发模式下 worker 只改工作树：不 `git push` / `git merge` / `git tag` / `gh pr`——提交、推送、PR 归执行器。
- 不改 `.git/config`、`.env*`、`secrets/`、`node_modules/`、`logs/`、`graphify-out/`；不动 `.github/` 与
  `scripts/local/` 之外的部署/导出脚本；不执行生产部署、DDL/DML。
- 不删 `spec/`、`verification/` 或 `.gitignore` 里已有的忽略规则。
- 不凭猜测改 `live.json` 契约（`lib/live/live-json.js` 白名单、`lib/live/repos.js` 归一化）而不加测试。
