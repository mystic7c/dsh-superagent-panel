# Changelog

## [0.9.8] — 2026-11-14

### 变更
- `docs/delivery.md` 的分支前缀表补上 `fix/**`、`chore/**`、`docs/**`（与 0.9.7 的 `auto-pr.yml` 触发面一致），
  并顺手验证了 `docs/**` 分支现在也会自动开 PR。

## [0.9.7] — 2026-11-14

### 变更
- `.github/workflows/auto-pr.yml` 的触发前缀补上 `chore/**` 与 `docs/**`（此前只有 `feature/**`、`fix/**`、
  `release/**`、`hotfix/**`）：这两类分支 push 后不会再只跑 CI、需要人手动 `gh pr create`。
- `ci.yml` 的 push 触发早已含这两个前缀，现在两套工作流的触发面一致。

## [0.9.6] — 2026-11-14

### 变更
- 删除旧「管理层」：`lib/views.js`、`lib/actions.js`、`lib/store.js`、`lib/seed.js`、`lib/prompts.js`，以及它们挂的
  25 条非引擎路由（`GET state|overview|search|sources|settings|threads|decisions|tickets|policy/history|models|prompts`、
  `PUT settings|prompts|prompts/preview`、`POST threads/:id/unsubscribe|triggers/:id/requeue|decisions/:id/dismiss|
  tickets/:id/retry|tickets/:id/stop|sources/:id/labels|policy-sync/:id|executor/pause|setup/check|demo/reset`）。
  `index.js` 从 719 行降到 590 行，只剩引擎 API；`/superagent/api/<unknown>` 现在直接回 404。
- `index.js` 不再构造那个给旧视图用的 `host`（`createHost`/`readModels`/`FALLBACK_MODELS`/`MACHINE_LIMITS` 一并删除），
  `apply()` 只等引擎启动；`ActionError` 改为本文件内的 4 行类。
- 测试脚本从 `node --test lib/store.test.js lib/live/*.test.js` 收敛成 `node --test lib/live/*.test.js`
  （`store.test.js` 随 `store.js` 删除）；`tsconfig.check.json` 去掉已删除的 `lib/prompts.js`。
- `AGENTS.md` 结构段、`index.js` 头注释、`docs/quickstart.md` 的「演示种子/`/demo/reset`」说明同步更新。

### 为什么
客户端从 0.4.x 起只调 `/superagent/api/engine/*`，旧管理层早已是死代码：它需要另一份 `state.json`、另一套 actions，
却仍在 `apply()` 里被加载和注册，读代码的人会以为面板有两套数据源。删掉后 `/superagent/api` 只对应 `lib/live`。

### 验证
- `node --check index.js`；`node scripts/build-client.mjs --check` 23 modules / 481,052 bytes（未动客户端）。
- `node scripts/check-keys.mjs` 958 / 513 / 1359；`npm run types` 与 `npm run check:js` 均通过。
- Host 测试 554 pass / 0 fail（少了 `store.test.js` 的 2 条）。
- `node scripts/render-check.mjs` 194 checks / 0 failed / 0 skipped；`node scripts/isolated-verify.mjs` PASS，console errors 0。

## [0.9.5] — 2026-11-14

### 变更
- 新增 `tsconfig.check.json` 与 `npm run check:js`：用 `checkJs` 真正类型检查 JS 源码，但只覆盖
  「分档清单」里已经清零的文件。第一档是 Host 侧 21 个不依赖 `engine`/`executor` 的叶子模块
  （`lib/util.js`、`lib/prompts.js`、`lib/live/{repo,worker-tools,workflow,workflow-worker,acceptance,evidence,
  operations,worker-cli,review-json,diff,github,routing,eval,judge,octo,gitlab}.js`），0 错误。
- `ci.yml` 增加同名步骤；`AGENTS.md`、`CONTRIBUTING.md`、`README.md`、`docs/ui-workflow.md` 的验收命令同步，
  并写明规则：修好一个旧文件就把它加进 `files`，不要为了让绿灯把文件移出去。
- 给第一档文件补齐 JSDoc：批量把 27 处 `{ … } = {}` 默认参数标成 `Record<string, any>`（TS 会把 `{}` 推成空对象类型，
  属性访问全报 TS2339）；`acceptance.js` 的 `requirement`、`repo.js` 的 `prepareWorktree`、`worker-tools.js` 的
  `registerWorkerTools` 补参数/返回类型；`eval.js` 的 `ignore` 闭包、`gitlab.js` 的 `createGitlabClient`、
  `octo.js` 的 `firstDefined`/`toNumberOrRaw`、`review-json.js` 的 `log` 与扩展注册表补显式类型；
  `prompts.js` 的 `defaultChanged` 拆出带类型的 `changedPart`，避免 `flatMap` 返回联合数组。

### 为什么
P4（类型契约）此前只做了一半：`types/dsh.d.ts` 只校验声明本身，源码里 700 多个 `checkJs` 错误完全没进闸门，
类型注解写了也不验。一次性清零需要跨十几个模块补 JSDoc，一个 PR 不可审，所以改成只增不减的分档清单：
CI 从第一天起就守住已清零的部分，剩下的按 `engine`/`executor`/客户端逐档推进。

### 验证
- `npm run check:js` 0 错误；`npm run types` 通过；`node --check index.js` 通过。
- `node scripts/build-client.mjs --check` 23 modules / 481,052 bytes（只改 Host 半，客户端产物不变）。
- `node scripts/check-keys.mjs` 958 / 513 / 1359。
- Host 测试 556 pass / 0 fail。
- `node scripts/render-check.mjs`（`DSH_SUPERAGENT_STATE_DIR=/tmp/rc-t1`）194 checks / 0 failed / 0 skipped。
- `node scripts/isolated-verify.mjs` PASS，console errors 0。

## [0.9.4] — 2026-11-14

### 变更
- 新增 `scripts/dev.mjs` 与 `npm run dev`：用 `dev` profile（软链到本工作树）起一个 DSH 实例并打印带 token 的 URL，
  自动按 runtime CLI → app bundle → PATH 的顺序找 `dsh`，参数原样转发。
- `AGENTS.md` 的「本机两种安装态」把开发态收成一个命令，并补充两条注意事项（dev 实例用临时
  `DSH_SUPERAGENT_STATE_DIR`；全局 `~/.dsh/cordis.patch.yml` 的 MCP 条目也会加载，连不上只告警）。
- `dev` profile 已补齐 bundles（`dsh-base` + `dsh-web-app` + 本插件），此前只带 `dsh-base`，起不来 Web UI。

### 为什么
「边改边看」如果只写在文档里，每次都要拼全路径、记 profile 名；收成一条命令后这条路径才有可能天天走。

### 验证
- `node scripts/dev.mjs --help` 能转发到 dsh；用临时 `DSH_SUPERAGENT_STATE_DIR` 实起一次实例：
  `GET /superagent/api/engine/status` → 200（`phase: disabled`，`x-superagent-request: 1` 头），
  停掉后端口关闭、进程退出。`--dump-config` 显示 `superagent-panel` 与 `dsh-web-app` 都在合成树里。

## [0.9.3] — 2026-11-14

### 变更
- `AGENTS.md` 新增「本机两种安装态（必须分清）」：`desktop` profile 是干净安装（依赖指向 Release tarball、包目录是实体目录），
  `dev` profile 才软链到工作树供边改边看；明确禁止把仓库目录 `add` 进 `desktop`，并写清升级/核对命令
  （`node scripts/local-install.mjs`、`--verify`）与 dev 实例起法。

### 为什么
之前用 tarball 装桌面端时，pnpm 把依赖解析成了指向工作树的 `link:`，桌面端跑的是未发布代码却显示成 0.5.1；
这类「安装态漂移」不写在规则里，下次还会重犯。

### 验证
- 只改文档与版本号：`node --check index.js`、`--check`、`npm run types`、Host 556 pass、render-check 194/0 未变。

## [0.9.2] — 2026-11-14

这是 v0.8.0 之后累计到 `main` 的发布：0.8.1 证据空态语义、0.8.2 CI 去人工 approve + README 带数据截图、
0.9.0 P4 类型契约、0.9.1 文档状态标注，以及本节的 render-check 轮询修复。仍然 `"private": true`，只发 Release
tarball，不进 npm。

### 修复
- `scripts/render-check.mjs` 挂载后不再固定 `await sleep(900)`，改为轮询等待「`.sa-page` 出现且没有骨架屏」，
  超时 20 秒才报 `WAIT panel first data load timed out`。PR #50 的 Node 24 任务曾出现一次
  `FAILED 53/194`：CI 上首次数据加载晚于 900 ms，收件箱还没到，后面所有经它进入的断言连锁失败
  （`gh run rerun` 即通过，本地 Node 24 也通过——典型的固定等待 vs 机器速度）。轮询让这道闸门验行为，
  不验机器快慢；真加载不出来时仍然会超时报错。

### 验证
- 本机 `node scripts/render-check.mjs`（Node 24.22.2）：194 checks / 0 failed / 0 skipped，exit 0。
- `node --check index.js`、`--check`、`npm run types`、Host 556 pass 未变。

## [0.9.1] — 2026-11-14

### 变更
- 两份 2026-11 的评审文档标注状态：`docs/product-review-2026-11.md` 改为「历史输入」（六项改进已在
  0.4.19–0.4.38 落地），`docs/panel-improvements-2026-11.md` 明确为仍然有效的行为契约。仓库公开后这两份
  最容易让人误判「这些是待办」，先写清楚。

### 验证
- 只改 Markdown 与版本号：`node --check index.js`、`--check`、`npm run types`、Host 556 pass、render-check 194/0。

## [0.9.0] — 2026-11-14

### 新增
- **手写的宿主类型契约 `types/dsh.d.ts`**（P4）：只声明本插件真正用到的两面——Host 的
  `apply(ctx, config)`（`logger`、`effect`、`webServer.register`、`get`）与 Client 的 `apply(ctx)`
  （`slots.inject/register`、`locale.register`、`get('uiWorkspace')`），外加 `window.__ModuleLoader__` 的
  `load({ id, factory })`。**刻意不引用 `@deepseek-ai/dsh-*`**：那会把插件钉死在某个 DSH 版本的内部类型上，
  而这里要的是「宿主至少提供过什么」。
- `tsconfig.json` + `npm run types`（`tsc -p tsconfig.json`，`typescript` 5.9.3 精确锁定），只做 `noEmit`
  检查声明文件自身；CI 增加同名步骤，这样声明不会悄悄失效。
- `index.js` 的 `apply` 与 `client/src/apply.js` 的 `apply` 加了 JSDoc（`@param {DSH.HostPluginContext}` /
  `{DSH.ClientPluginContext}`），编辑器装了这个包就能顺着跳进类型定义。

### 变更
- `package.json` 的 `files` 增加 `types/**/*.d.ts`；`docs/self-development.md`、`docs/ui-workflow.md`
  里「render-check 依赖 `/tmp/sa-harness`」的旧说法改成 devDependencies（那是 P0 之后就过期的描述），
  闸门清单补上 `npm run types`。

### 验证
- `npm run types`（tsc 5.9.3）通过；`node --check index.js`；`--check` 23 modules / 481,052 bytes；
  check-keys 958/513/1359；Host 556 pass；render-check 194 checks / 0 failed。

## [0.8.2] — 2026-11-14

### 变更
- **CI 在投递分支的 push 上直接跑**：`ci.yml` 的 `push` 触发从 `[develop, main]` 扩到 `feature/**`、`fix/**`、
  `release/**`、`hotfix/**`、`chore/**`。push 运行不需要人工 approve，而分支保护读的是挂在 head commit 上的
  check run，两者的效果一致——之前每个 PR 的 `pull_request` 运行都停在 `action_required`，要手工
  `gh api -X POST …/actions/runs/<id>/approve`。
- README 首图从空状态换成带数据的执行页（三条排队工单、执行器负载、视图筛选），
  文件改为 `docs/images/panel-execution.png`。

### 验证
- `node --check index.js`；`node --test lib/store.test.js lib/live/*.test.js` 556 pass。
- `node scripts/build-client.mjs --check`（产物未变）；check-keys 958/513/1359；render-check 194/0。
- 截图来自隔离 DSH 实例（fixture 状态 + 通过 Host API 建的三条工单），console errors 0。

## [0.8.1] — 2026-11-14

### 修复
- **待运行工单的「交付证据」被渲染成读取失败**：`GET /superagent/api/engine/evidence/<ticketId>` 在没有证据记录时
  统一返回 `404 没有这段交付证据`，客户端 `DeliveryEvidenceCard` 把 404 当成错误，显示「没有这段交付证据 +
  可以先重试… + 原始错误」，而页面本来已经有「这段交付还没有持久化的证据（旧工单或尚未跑完）」这条空状态文案。
  - Host：工单**存在**但没有证据时返回 `200 { ticketId, rounds: [] }`（走空状态）；工单不存在仍返回 404。
    `evidence/:id/compare` 缺少可比较轮次时改为 `404 没有可比较的交付证据`，与「工单不存在」区分开。
  - 新增路由测试：已存在但无证据的工单 → 200 空轮次；未知工单 → 404。
- Host 测试 555 → 556。
- `.github/workflows/auto-pr.yml` 的触发分支补上 `fix/**`（此前只有 `feature/**`、`release/**`、`hotfix/**`，
  `fix/` 分支要手工开 PR）。

### 验证
- `node --check index.js`；`node --test lib/store.test.js lib/live/*.test.js` 556 pass / 0 fail。
- `node scripts/build-client.mjs --check`（产物未变，481,039 字节）；check-keys 958/513/1359。
- `node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。

## [0.8.0] — 2026-11-14

### 变更
- **客户端模块改成语义化文件名**：数字前缀只是拼接时代的加载顺序，P3 之后顺序已由 `client/src/index.js` 的
  import 列表显式表达，因此 `git mv` 重命名 23 个文件——`00-react.js`→`react.js`、`00-util.js`→`util.js`、
  `05-style.js`→`style.js`、`06-i18n.js`→`i18n.js`、`07-md.js`→`markdown.js`、`10-controls.js`→`controls.js`、
  `15-api.js`→`api.js`、`20-widgets.js`→`widgets.js`、`21-localtext.js`→`localtext.js`、`25-router.js`→`router.js`、
  `30-shell.js`→`shell.js`、`32-live-model.js`→`live-model.js`、`33-setup.js`→`setup.js`、`34-live-ui.js`→`live-ui.js`、
  `35-overview.js`→`overview.js`、`40-source.js`→`source.js`、`45-trigger.js`→`trigger.js`、
  `48-thread-detail.js`→`thread-detail.js`、`50-eval.js`→`eval.js`、`55-execution.js`→`execution.js`、
  `58-ticket-detail.js`→`ticket-detail.js`、`60-settings.js`→`settings.js`、`90-apply.js`→`apply.js`；
  同时更新 `index.js` 的 import 列表、`scripts/client-exports.mjs` 的映射与文档里的引用。
  产物逐字节不变（481,039 字节，23 模块）。
- **README 重写**：从 153 行的内部说明收缩成面向使用者的 88 行——一句话定位 + 截图、功能要点、安装（Release tarball
  或本地 checkout）、快速开始、开发命令、文档索引；原来的逐页细节与配置/排障拆到 `docs/pages.md` 与
  `docs/quickstart.md`，删掉原型仓库出身、GitFlow 沿革、内部自开发叙述等对外无意义的段落。
- 新增 `docs/images/panel-overview.png`（概览页真机截图，1280×900）作为 README 首图。
- `AGENTS.md`、`CONTRIBUTING.md`、`docs/*.md` 的交叉引用与"按数字顺序"的描述同步更新。

### 验证
- `node scripts/build-client.mjs --check`：23 模块，481,039 字节，逐字节一致。
- `node --check client/index.js`；check-keys 958/513/1359；Host 555 pass / 0 fail。
- `node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0，六个页签齐全。

## [0.7.0] — 2026-11-14

### 变更
- **P3：客户端从"按文件名拼接的片段"变成真正的 ESM 模块**（issue #35）。
  - 新增 `client/src/index.js` 作为入口：按数字顺序 `import` 其余模块，并从 `90-apply.js` 再导出 `{ inject, apply }`；
    数字前缀不再承载加载顺序（顺序由 import 列表显式表达），`22 片段` 的隐式契约消失。
  - 新增 `client/src/00-react.js`：把宿主提供的 `react` 收敛成一张导出表（`React`、`h`、常用 hooks），
    每个模块显式 `import` 需要的名字；`h` 不再来自工厂作用域的 prelude。
  - 22 个模块的顶层声明全部 `export`，跨模块引用改为显式 `import { … } from './xx-name.js'`；
    419 个顶层名字此前共用一个工厂作用域，现在各自归属到定义它的模块。
  - `scripts/build-client.mjs` 从 esbuild `transform` 改为 `bundle`：`format: 'cjs'`、`platform: 'browser'`、
    `external: ['react', 'react-dom', 'react/jsx-runtime']`，banner/footer 提供 `module`/`exports` 并包回
    `window.__ModuleLoader__.load({ id, factory(require) { … } })`——对外契约与之前完全一致。
  - 新增 `scripts/client-exports.mjs`：`check-keys.mjs` 与 `render-check.mjs` 通过它按同一套 esbuild 参数打包
    一个虚拟入口，取出 `App`/`DICTS`/`PANEL_CSS` 等内部名字，替代原来的"拼接文本 + `new Function`"。
- 产物 484,636 → 481,039 字节（−3,597）；`client/index.js.map` 同步重生成。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（23 模块，逐字节）。
- `node scripts/check-keys.mjs`：958 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0，六个页签齐全。

## [0.6.0] — 2026-11-14

### 变更
- **P2 完成**：客户端六个片段全部从 `h(...)` 迁移到 JSX（issue #34）。0.5.2–0.5.7 六个补丁版本合起来是这一步：
  `10-controls.js`、`20-widgets.js`、`30-shell.js`、`34-live-ui.js`、`58-ticket-detail.js`、`60-settings.js`，
  共 6,657 行、约 2,000 处调用点，产物 485,801 → 484,636 字节，产物契约与 `window.__ModuleLoader__.load` 工厂不变。
- 构建层先切成 `loader: 'jsx'` + `jsxFactory: 'h'`（只换 loader 时产物逐字节相同），之后每个文件一个 PR 单独迁移，
  diff 里只有写法变化；`scripts/check-keys.mjs` 与 `scripts/render-check.mjs` 同步改成先用 esbuild 编译再求值。
- `60-settings.js` 里十二个重复的仓库字段收敛成 `repoInputField(key, labelKey, { required, placeholder, hintKey })`，
  动态标签统一改成大写变量（`const Dot = detail ? 'span' : 'div'`）。
- 阶段意义：从此 `client/src` 可以按文件读写 JSX，P3（issue #35，真正的 ESM 模块边界）才有动手的前提。

### 验证
- 每个补丁版本的 PR 都跑过完整闸门：`node --check client/index.js`、`build-client --check`（22 片段）、
  `check-keys`、Host 555 pass、`render-check` 194 checks / 0 failed / 0 skipped、`isolated-verify` PASS（console errors 0）；
  CI 的 `test (22)` / `test (24)` 两个矩阵全绿后才 merge。
- 真实浏览器（隔离 DSH 实例 + `test/fixtures/live.json` 夹具状态）验过：概览/设置各组、执行列表、工单详情
  （改动内容/验收/自动化/阶段链路/运行记录/时间线）、添加仓库对话框（13 字段 + 必填校验）、编辑仓库对话框、
  配置示例对话框，均无控制台报错。

## [0.5.7] — 2026-11-14

### 变更
- `client/src/60-settings.js`（2306 行，420 处 `h(...)`）从 `h(...)` 迁移到 JSX（P2 第六步，issue #34）：
  `SettingsSwitchRow`、`SettingsStatusLine`、`WorkerCapabilityCard`、`ReposCard`、`settingsHeading`、`saveBarFor`、
  `reloadButton`、`renderRepos`、`renderOctoToken`、`renderGroupPicker`、`renderSenders`、`renderSource`、`renderEval`、
  `renderReview`、`renderRun`、`renderWorker`、`renderWrite`、`renderPrompt`、`settingsNavButton`、`repoFieldError`，
  以及四个对话框（变更历史、编辑仓库、添加仓库、配置示例）与最终返回树。
- 添加仓库的表单原本十二个字段各写一遍，抽成 `repoInputField(key, labelKey, { required, placeholder, hintKey })`
  一个 helper；编辑仓库的差异表 `repoEditRows`、闸门编辑器、各组的保存/丢弃/重载逻辑保持不变。
- 产物 486,236 → 484,636 字节（−1,600），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：958 literal keys / 513 shared / 1359 page-local，OK（数字从 967 降到 958，是因为
  九个字段标签改成通过 `repoInputField` 的 `labelKey` 参数传入，不再出现在 `pt(t, '…')` 字面量位置；键本身没变）。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。
- 真实浏览器（隔离实例 + 夹具状态）：设置页各组切换、添加仓库对话框（13 个字段、必填校验报「请填写此项。」并聚焦
  `sa-repo-field-id`）、编辑仓库对话框（12 个输入、闸门编辑）、配置示例对话框（`pre` 360 字）均正常渲染，无控制台报错。
  截图 `verification/browser-run-settings-0.5.7.png`、`verification/browser-run-add-repo-0.5.7.png`。

## [0.5.6] — 2026-11-14

### 变更
- `client/src/58-ticket-detail.js`（1951 行，403 处 `h(...)`）从 `h(...)` 迁移到 JSX（P2 第五步，issue #34）：
  `TicketStamp`、`TicketTimeline`、`TicketLazyFolded`、`RunTrace`、`RunHandoff`、`RunReport`、`TicketGateResults`、
  `AcceptanceRecordCard`、`TicketActivities`、`TicketRunRows`、`DiffBody`、`DiffCard`、`AutomationCard`、
  `DeliveryEvidenceCard` 以及 `TicketDetail` 整体（primaryAction 链、确认/差异对话框、四条 banner、四个 section、返回树）。
- 只改写法：字典、`TICKET_STEP_KEYS`、纯函数（`ticketEvents`、`changesOf`、`gateOnFailOf`、`failureHint`、
  `ticketVisibleJumps` 等）与交互逻辑不变；条件渲染仍用同一组判定。
- 产物 486,055 → 486,236 字节（+181），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。

## [0.5.5] — 2026-11-14

### 变更
- `client/src/34-live-ui.js` 从 `h(...)` 迁移到 JSX（P2 第四步，issue #34）：`AutomationBar`、`TicketRow`、
  `TicketList`、`TicketGroups`、`ManualTicketForm`、`FunnelBar`、`ExecutorLoad`、`GateSummary`、`StageRail`、
  `MergeRequestCard`、`UatCard`、`ticketEvidence`、`rowAcceptanceChip`、`automationChip`、`PilotStatusTag`、
  `TicketStatusTag` 以及三个过渡 shim 只改写法，输出逐节点等价。
- `StageRail` 的 `span`/`div` 二选一改成大写变量 `const Dot = detail ? 'span' : 'div'`；`TicketGroups` 的
  `className` 分支与 `TicketList` 的常驻 live region 保持原有开关逻辑。
- 产物 485,946 → 486,055 字节（+109），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。

## [0.5.4] — 2026-11-14

### 变更
- `client/src/30-shell.js` 从 `h(...)` 迁移到 JSX（P2 第三步，issue #34）：`GlobalStatus`、`GlobalSearch`、
  `Header`、`Pages`、`PanelBoundary`、`PanelShell`、`App` 只改写法。`PanelBoundary` 仍是 class 组件（它要
  `getDerivedStateFromError`），`Back`/`globalHealth`/`pageView` 等纯函数不动。
- 组件型 props 直接用元素：`icon={<Icon name="search" size={16} />}`、`<PanelState.Provider value={model}>`，
  与原来的 `h(Component, props, children)` 同构。
- 产物 485,926 → 485,946 字节（+20），构建层与契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0。

## [0.5.3] — 2026-11-14

### 变更
- `client/src/20-widgets.js` 从 `h(...)` 迁移到 JSX（P2 第二步，issue #34）：`Section`、`KeyValues`、
  `Inlines`、`MarkdownLite`、`ClampText`、`ConfirmButton`、`ExternalLink`、`PageHead`、`EmptyState`、
  `ErrorState`、`Skeleton`、`SaveBar`、`RawValue`、`Folded`、`GlossaryButton`、`GlossaryModal` 只改写法，
  输出保持逐节点等价：同样的 class 名、`data-*`、ARIA 属性与文本。
- Markdown 标题与列表改用动态标签变量（`const Heading = \`h${...}\`、`const List = block.ordered ? 'ol' : 'ul'`），
  JSX 里的组件名保持大写以免被当成字符串标签。
- 产物：`client/index.js` 485,818 → 485,926 字节（+108，来自 JSX 编译后的辅助代码），契约不变。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。
- `node scripts/isolated-verify.mjs`：PASS，console errors 0，真实 DSH 里六个页签都在。

## [0.5.2] — 2026-11-14

### 变更
- 客户端构建层接受 JSX：esbuild 以 `loader: 'jsx'` + `jsxFactory: 'h'` 编译拼接后的片段。产物契约不变——
  同一 esbuild 版本下，仅切换 loader 时 `client/index.js` 逐字节相同（485,801 字节）。
- `client/src/10-controls.js` 从 `h(...)` 迁移到 JSX（P2 第一步，issue #34）：markup、class 名、ARIA 属性、
  焦点行为与无障碍名全部保持原样，只改写法。
- `scripts/check-keys.mjs` 与 `scripts/render-check.mjs` 用同一套 esbuild 参数编译片段后再求值，否则 JSX
  片段在 `new Function` 里会直接语法错误。
- 文档：`CONTRIBUTING.md` 与 `README.md` 说明片段可写 JSX 或 `h(...)`，可以按文件逐个迁移。

### 验证
- `node --check client/index.js`；`node scripts/build-client.mjs --check`（22 片段，485,818 字节）。
- `node scripts/check-keys.mjs`：967 literal keys / 513 shared / 1359 page-local，OK。
- Host 测试 555 pass / 0 fail；`node scripts/render-check.mjs`：194 checks，0 failed，0 skipped。

## [0.5.1] — 2026-11-14

### 修复
- 测试里不再出现真实的自建 GitLab 主机名（`lib/live/executor.test.js:298` 的 push-option 断言改用
  `gitlab.example.com`），发布前把内部域名从公开仓库里清掉；断言的行为不变。

### 验证
- `node --test lib/live/executor.test.js` 通过；全量 555 pass / 0 fail。

## [0.5.0] — 2026-11-14

开源首发版本：把 0.4.39（开源准备 P0）与 0.4.40（客户端构建层 P1）合进一个可以对外发布的版本。
功能行为与 0.4.38 一致，变化都在工程与文档层。

### 内容
- 仓库可被外部贡献：MIT LICENSE、GitHub Actions CI（Node 22/24，五道门）、`CONTRIBUTING.md`、行为准则、
  安全策略与威胁模型、issue 表单与 PR 模板、`docs/delivery.md` 交付流程。
- 干净 clone 可自查：`jsdom`/`react`/`react-dom` 进 `devDependencies`（精确版本 + lockfile），渲染回归
  内置 fixture，194 项检查在无任何本地状态时也能跑通。
- 客户端构建层换成 esbuild：仍按文件名拼接进同一个工厂作用域，产物压缩到 486 KB 并附 sourcemap，
  `--check` 逐字节校验产物与 map。
- 基线 Node.js 22；`testConfig` 的 Node 检查、`engines`、CI 矩阵与文档统一。

### 验证
- `node scripts/build-client.mjs --check`、`node --check index.js`、`node scripts/check-keys.mjs`、
  Host 测试 555 pass / 0 fail、`node scripts/render-check.mjs` 194 checks / 0 fail / 0 skipped。
- 以上在干净 clone（`npm ci`）与 GitHub Actions（node 22、node 24）上各跑过一遍。

## [0.4.40] — 2026-11-14

开源准备（P1）：客户端构建层从"手写拼接"换成 esbuild 压缩，产物契约与运行时行为都不变。

### 内容
- `scripts/build-client.mjs` 仍按文件名排序拼接 `client/src/*.js`、仍在同一个工厂作用域里包
  `window.__ModuleLoader__.load`，但拼接结果交给 esbuild `transform`（不是 `bundle`）压缩：
  `require('react')` 保持为 loader 调用，React 不进入产物。
- 产物从 782,094 字节降到 485,801 字节（`client/index.js`），并生成 `client/index.js.map`（映射回片段源码）。
  `--check` 现在逐字节校验**两个**文件，读产物的人可以先看 `client/src`，必要时用 map 对齐。
- `esbuild@0.28.2` 精确锁定在 `devDependencies`：换版本会改变压缩字节，必须与重新生成的产物同一次提交。
- 文档同步：README 的目录树与开发命令、CONTRIBUTING 的产物契约说明；`package.json` 的 `files` 增加 map。

### 验证
- 干净状态目录：`node scripts/render-check.mjs` 194 checks / 0 fail / 0 skipped（压缩后的产物照常挂载）。
- `npm ci` 干净 clone 上 `node scripts/build-client.mjs --check` 逐字节一致；Host 测试 555 pass / 0 fail；
  `node --check client/index.js` 通过；`scripts/check-keys.mjs` 不变。

## [0.4.39] — 2026-11-14

开源准备（P0）：让一个干净 clone 能自查、能被外部贡献者读懂，并把仓库里的"内部习惯"与"外部契约"分开。
功能行为不变，所有改动都在构建、测试与文档层。

### 内容
- 新增 `LICENSE`（MIT）与 `.github/workflows/ci.yml`：Node 22/24 矩阵，`npm ci` 后跑 Host 语法、产物一致性、
  双语 key、Host 测试与渲染回归五道门。
- 渲染回归不再依赖 `/tmp/sa-harness`：`jsdom`/`react`/`react-dom` 改为 `devDependencies`（精确版本）并提交
  `package-lock.json`；`scripts/render-check.mjs` 缺依赖时提示 `npm ci` 并以 2 退出。
- 新增 `test/fixtures/live.json` 与渲染回归的内置 fixture：状态目录里没有 `live.json` 时自动在临时目录搭建
  一套演示状态（2 个仓库、2 个监听群、四条演示工单、一条接单历史），干净 clone 上不再是 172 检查 + 18 跳过。
- 新增 `CONTRIBUTING.md`、`CODE_OF_CONDUCT.md`、`SECURITY.md`、issue 表单与 PR 模板；交付桥与发布流程拆到
  `docs/delivery.md`，`AGENTS.md` 只留指向与 Agent 硬线。
- CI 基线定为 Node 22/24：`testConfig` 的 Node 检查要求 major ≥ 22，Node 20 已 EOL，降到 20 只会制造
  声明与实现不一致。
- 历史快照同一毫秒内写入时排序不稳定（`listLiveConfigHistory` 只按 `at` 排），文件名里的序号现作为二级排序键。
- 首次在 Linux/UTC 上跑 CI 暴露的三处测试问题（生产代码未改）：`lib/live/api.test.js` 的搜索用例被写进了
  status 用例体内（子测试抢跑导致偶发 cancelled），已移回顶层；`lib/live/gitlab.test.js` 的超时用例只剩
  `AbortSignal.timeout` 的 unref 定时器撑着事件循环，补了一个 ref 定时器；`lib/live/schedule.test.js` 的
  `nextDailyAt` 断言写死 `+08:00`，在 UTC runner 上必然失败，改为按时钟本地构造。
- 文档卫生：README 去掉写死的 `0.4.31`，改为 CHANGELOG/Releases 入口并加 CI/License/Node 徽章；开发验证一节
  改为从 `npm ci` 开始、写明前七条可在干净 clone/CI 上跑、后两条需桌面 DSH + Chrome；`docs/self-development.md`
  去掉本机绝对路径与内部仓库名；`engines.node` 提到 `>= 22`（与 `testConfig` 的 Node 检查、CI 矩阵一致）；`package.json` 补 `repository`/`homepage`/`bugs`。

### 验证
- 干净状态目录（`DSH_SUPERAGENT_STATE_DIR` 指向空目录）：`node scripts/render-check.mjs` 194 checks / 0 fail /
  0 skipped；操作者真实状态目录同样 194 / 0 / 0。
- `node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`、
  `node --test lib/store.test.js lib/live/*.test.js`（555 pass）全部通过；本地与 `TZ=UTC` 两种时区各跑一遍。
- GitHub Actions：PR #29 上 node 20/22 两条 job 全绿。

## [0.4.38] — 2026-11-13

按 `/impeccable audit`（对着 DESIGN.md 契约跑的 16/20 审计）逐条修复。核心一条是 token 语义错用：`--dsw-alias-bg-overlay`
是叠加用的薄染层，深色主题下解析成 `#61666b`，菜单/弹窗的二次文本只有 3.85:1。

### 内容
- 新增 `--sa-surface-raised`（= `var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-overlay))`），`.sa-menu-pop` 与
  `.sa-modal` 改用它。深色下弹窗描述 3.85 → 8.03:1、菜单说明 3.27 → 6.83:1，浅色下底变纯白。
- `.sa-info`（16px）与 `.sa-sender-remove`（约 8×12）加 24×24 的居中命中盒（`::before`），图形尺寸不变，满足 2.5.8。
- `.sa-sender-remove:focus-visible` 的圆角从 2px 改回 `--sa-r-sm`（检测器唯一命中的越界刻度）。
- 禁用态不透明度 0.4 → 0.55（按钮、图标按钮、分段控件），文字不再"消失"。
- `.sa-modal:focus-visible` 补焦点环：弹窗接管焦点时键盘用户仍能看到落点。
- `DESIGN.md`：Neutral 一节把 Overlay 改述为"薄染层"、新增 Raised 一节；Modal 组件绑定 `surface-raised`；
  `.impeccable/design.json` 同步。

### 验证
- 隔离 DSH web 实例（真实工单数据）实测：浅色菜单底 `#fff`、说明 5.50:1；切深色后底 `#353638`、说明 6.83:1、
  弹窗描述 8.03:1；`.sa-info` 与 sender chip 的 × 在 ±11px 处仍命中；390 / 600 / 760 三档容器无横向溢出。
- `node --check index.js`、`build-client --check`（22 fragments，11682 行）、`check-keys`（967/513/1359）、
  `node --test`（555 pass）、`render-check`（194 checks / 0 fail）。

## [0.4.37] — 2026-11-13

真浏览器点检（隔离 DSH web 实例 + 真实工单数据）发现的漏项：触发页的三个筛选分段把「条数」只写在 `title`
里，键盘与读屏都拿不到（WIG A3 同类问题在 0.4.36 清扫时漏掉了这一处）。

### 内容
- `SegmentedControl` 支持 `option.description`，渲染为按钮内的 `.sa-sr-only` 文案，因此可访问名变成
  「已订阅 4 条」；`45-trigger.js` 的三个筛选项同时传 `title`（悬停仍显示）与 `description`（读屏/语音输入可见）。
- 其余 0.4.36 改动在真机同路径点检中表现正常（见 `verification/ui-review-team.md` 的「真机点检」一节）。

### 验证
- `node scripts/build-client.mjs`（22 fragments，11672 行）、`node scripts/check-keys.mjs`（967 literal / 513 shared /
  1359 page-local）、`node --test lib/store.test.js lib/live/*.test.js`（555 pass）、`node scripts/render-check.mjs` 全绿；
  隔离实例里重载后 `.sa-segment` 的可访问名已含条数。

## [0.4.36] — 2026-11-13

按 Web Interface Guidelines 全渲染层审查（89 条）与 CSS 设计审查（14 条）逐条修复；不改变页面信息架构，只修
语义、键盘路径、对比度与 token 契约。

### 内容
- 组件层：`Input` 的 `label` 真正成为可访问名（不再泄漏成 DOM 属性）并默认 `spellCheck=false`；`Switch` 换成
  `<input role="switch">` + 可见 track（调用方用 `<label>` 包裹文案，整行可点）；`DisclosureRow` 改成真 `<button>`；
  `CopyButton` 用 `role=status` 播报「已复制」；`ConfirmButton` 支持动作级 `confirmLabel`；`MarkdownLite` 输出真
  h3–h6（`07-md.js` 保留 heading 级别）。
- 对比度/token：修掉不存在的 `--sa-radius-8`、`--dsw-alias-border-secondary`、`--dsw-alias-bg-secondary`、
  `--dsw-alias-label-error`；toast/tooltip 改用 `--dsw-alias-toast-label`/`--dsw-alias-tooltip-label`；状态文本统一
  走 `--sa-danger-text`/`--sa-warn-text`/`--sa-success-text`/`--sa-label-tertiary`。
- 焦点与键盘：菜单项、输入框、`.sa-scroll` 都有可见焦点环；列表/队列/收件箱的行点击改成行内真按钮（`.sa-row-open`），
  鼠标仍整行可点；消息列表加 roving tabindex + ↑/↓/Home/End。
- 深链：路由（含 `stage`/`group`/`focus` 等视图内选择）写入自身 `#sa=` 片段并可在冷启动恢复，sessionStorage 仍是
  兜底；宿主 URL 不属于本插件时不读不写。
- 语义与播报：搜索面板改成 `role=search` 表单并播报结果数；异步结果（列表刷新、保存、复制、建单、评测）统一
  `role=status`/`aria-busy`；`data-empty` 写到计数元素，配合 `.sa-count` 的尺寸契约。
- 文案与校验：破坏性操作使用动作级确认文案；设置页数字/时间/必填字段有字段级错误与 `aria-invalid`；设置草稿存入
  sessionStorage 并在离开前提示；`title` 不再作为唯一信息来源（改用可见提示或 focusable InfoTip）。
- 样式细节：行高收敛到 1/1.35/1.4/1.5，列表分隔线上下对称，sticky 偏移统一 `--sa-sticky-top`，删除死规则
  （`.sa-cards`/`.sa-grid2`/`.sa-grid3`/`.sa-chip-count[data-zero]`），补 `overscroll-behavior`、
  `touch-action`、`text-wrap: balance` 与 `prefers-reduced-motion`。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 11670 行）；`node scripts/check-keys.mjs`
（967 literal / 513 shared / 1359 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（555 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过）。审查清单与逐条状态见 `verification/ui-review-team.md`。

## [0.4.35] — 2026-11-13

收口 0.4.34 遗留的运行质量口径、事件队列 ack/cursor、持久化掉电与证据排序问题。

### 内容
- 运行质量：24 小时失败数改为按 `runCategoryOf` 分类（`stopReason` 的 gate_failed/worker_failed 等与遗留
  `status=failed` 同口径），不再只数 `status === 'failed'`。
- 事件队列：只 ack 已处理（接单/忽略/跳过/指令消费）的事件；处理失败的事件留在队列并保持原 cursor；
  UUID 形式的 `eventId` 会 ack 但不再把数字 cursor 归零（`Math.max(cursor, NaN)`）。
- 持久化：新增 `lib/live/durable.js`，所有 temp+rename 写入在 rename 前 fsync 临时文件；掉电时不再可能留下
  0 字节的 `live-state.json`/`acceptance.json`/`operations.json` 等。
- 证据：人工决策（采纳/拒绝/覆盖）只推进 `updatedAt`，交付轮次的 `at` 不变，证据列表按最近处理排序。
- 并发：`verifyTicket` 与 `refreshTicketCi` 也纳入工单锁，避免与执行/发布/回答重叠改同一张工单。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 10854 行）；`node scripts/check-keys.mjs`
（938 literal / 513 shared / 1304 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（555 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过）。

## [0.4.34] — 2026-11-13

按代码评审与实机点击评审收口：修掉 URL 注入、干跑消费上下文、发布/回答的并发与干跑语义，补齐实机暴露的
i18n 与状态文案问题；数据加载不再把权限错误当成空状态。

### 内容
- 安全：`ExternalLink` 只接受 http(s) URL，其余渲染为纯文本；Markdown 链接沿用原有 http(s) 白名单。
- 干跑：`pollSync`/`pollEvents` 的 `attachContext` 移到 dry-run 返回之后，且只对会入库的仓库执行；实机干跑不再
  在内存里消费 contextOnly 决策。
- 执行器：`executeTicket/publishTicket/answerTicket/resumeTicket/resumeInterruptedTicket` 共用进程内工单锁
  （重复调用报 `already busy`）；`publishTicket` 只接受 ready/failed/pushed；回答追问沿用原 run 的 dryRun；
  发布修复只对 `onFail=auto_repair` 的闸门生效；去掉重复的 stop 清理；CLI worker 接收 `AbortSignal`，停止会
  立即终止 CLI 进程组；采用已合并 MR 时不再把工单回退成 ci-pending/mr-open。
- 数据：`live-state/inbox/signals/operations/acceptance/store` 只在 ENOENT 时按空状态初始化，EACCES/EIO 直接
  抛错；`live-json` 写入遇到损坏配置拒绝覆盖并提示；新增仓库不再硬编码 `createMr:api`，并拒绝重复本地路径。
- Host：同源判断比较 host（HTTPS/反代可用）；非法 URL 编码返回 400；`normalizeRepo` 容忍不完整 base。
- 视图：`signalsView`/`decisionsView` 每次请求只读一次配置；无仓库时 `verifySeconds` 为 null；`requestStop` 走
  `atomic()` 队列；标题上限 64→160。
- 客户端：修复重复 `src.signalReason`（原因列显示“按原因筛选”）；补齐 8 个 `repos.*` 文案；仓库卡片改为
  “执行器未启用”；暂停时概览不再说“等待群消息”；“查看已处理工单”带 `stage=done`；评估筛选空态提供清除筛选；
  已合并工单不再显示“已推送，等待创建 PR”；信号标题不再被 300px 截断。
- 工具：`check-keys` 支持三元表达式取 key，并检测重复 PAGE_TEXT key。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 10854 行）；`node scripts/check-keys.mjs`
（938 literal / 513 shared / 1304 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（551 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过）。

## [0.4.33] — 2026-11-13

落地产品评审六项改进（AC-01…AC-12）并按七轮独立验收返工收口：路由贯穿分阶段执行、停止真正取消 worker 与
CLI 进程组、恢复时对远端推送对账、评测与来源深链可回溯、证据与部署判定可复核、仓库与闸门可直接在设置页编辑。

### 内容
- 路由：`lib/live/routing.js` 与 `executor.js` 的 staged 分支按 `routeBackend`/`routeProfile` 选择实现后端与只读/
  可写 profile，人工选择不可用时原样报 `unsupported`；设置页展示路由预览（交付类型、后端、是否自动、改动范围）。
- 停止：`requestStop` 对 queued 工单立即结束排队；executor 每步检查 `ticket.stop`，worker 通过 `AbortSignal` 取消
  宿主 agent，CLI 以进程组 SIGTERM→3s SIGKILL 升级；停止的 run 可恢复。
- 推送/部署：`publishTicket` 先持久化推送请求再执行，未知结果按远端分支与 MR 对账；部署判定按记录的 SHA 比较，
  不用最新流水线代替目标 commit。
- 证据与评测：gate 记录 `at` 时间戳，reused 判定生效；证据包补齐被截断标记与 `deployCommit`；评测搜索覆盖
  `candidate.text`/`payload.text`；来源与评估记录深链到具体 id；URL 恢复保留视图、页码与滚动位置。
- 设置页：仓库对象中的闸门（名称、命令、目录、超时、失败策略、干跑命令）按完整对象编辑与保存，保存后刷新
  不回退；`POST engine/repo/:id` 与 `POST engine/config/test` 补 API 测试；live-json 的 `onFail` 补断言。
- 文档：README、`docs/self-development.md`、`docs/feature-maturity.md` 与实际测试数、停止能力对齐。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments / 10826 行）；`node scripts/check-keys.mjs`
（882 literal / 513 shared / 1295 page-local）；`node --test lib/store.test.js lib/live/*.test.js`（541 通过 0 失败）；
`node scripts/render-check.mjs`（194 项检查全过，含仓库闸门保存后刷新的回归断言）。

## [0.4.32] — 2026-11-13

Claude 验收报 `Unexpected end of JSON input`：不是模型没答，是读不到答案。`runProcess` 的 stdout 上限 8 MB 在
达上限后丢弃**新到的** chunk，而 Claude stream-json 每个 thinking token 就产出一条 `thinking_tokens` 事件
（实测约 320 B/token，一次 1 万 token 的思考就有 3.5 MB），真实验收一越过 8 MB，最后那条含 verdict 的 `result`
就被丢掉，解析器只能拿到空字符串，`JSON.parse('')` 便报这个错。stage 里还留着 sessionId，正是「CLI 跑了、
只是尾巴没了」的证据。

### 内容
- `lib/live/worker-cli.js`：`runProcess` 达上限后**保留尾部**（`stdout = stdout.slice(-maxStdout)`），并支持
  注入 `maxStdout` 便于测试；`parseClaudeStream` 在 `result` 文本缺失时回落到 `structured_output`
  （`--json-schema` 的正式载荷）；CLI 退出 0 但没有任何结果文本时，错误改为
  `claude CLI returned no result text (stdout N bytes): …` 并带 stderr/stdout 尾部，不再让 JSON.parse 报误导性错误。
- 测试：`runProcess keeps the stream tail when the stdout cap is reached`、`a CLI that exits 0 without result
  text is reported instead of failing JSON parse`、`Claude structured output is used when the result event carries
  no text`。
- `package.json` 0.4.32。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`；`node scripts/check-keys.mjs`；
`node --test lib/store.test.js lib/live/*.test.js`（449 通过 0 失败）。

## [0.4.31] — 2026-11-13

独立验收现在可以选 DSH（独立只读会话），Claude 验收拿到 JSON schema，DSH 验收在 DeepSeek 路由上真正开
JSON Output。上一版把「DSH 没有验收入口」当成「DSH 不支持结构化输出」，这是错的：DSH 只是没有把
DeepSeek 的 `response_format` 接进评审请求，而 Claude Code CLI 2.1 早已支持 `--json-schema`（此前只给
codex 传了 `--output-schema`）。

### 内容
- `lib/live/worker-cli.js`：Claude 评审把 schema 文件内容以 `--json-schema <json>` 传给 CLI（不是路径），
  与 codex 的 `--output-schema` 对齐；repro：`claude --help` 的 "JSON Schema for structured output"。
- `lib/live/workflow-worker.js`：评审提示词追加固定标记 `Return only a json object with keys: verdict,
  findings, evidence.`（同时满足 DeepSeek JSON 模式「prompt 必须含 json」的要求）；DSH 评审调用带
  `readOnly: true`（实现轮仍可写）；新增 `parseStageResult()`，容忍 ```json 围栏与前后缀文字，解析失败才抛错。
- 新增 `lib/live/review-json.js`：`deepseekLlmApiExtensions.register('response_format', provider)`，仅当请求体
  含评审标记、且（无工具或已见过 tool 结果）时注入 `{type:'json_object'}`——首轮探索保持自由输出，避免
  JSON 模式打断读代码；宿主没有该扩展注册表时静默跳过，评审退回自由 JSON。
- `lib/live/config.js` / `lib/live/live-json.js`：`executor.reviewer` 白名单加入 `dsh`（错误文案改为
  `must be "codex", "claude" or "dsh"`）；设置 → Worker 的「独立验收后端」出现 DSH，选项仍跟随启用后端过滤。
- `index.js`：插件挂载时注册 JSON mode，失败只记 debug 日志。
- 测试：`review-json.test.js`（标记门控、工具结果门控、注册/降级）、`worker-cli` 的 `--json-schema` 断言、
  live-json/config 的 dsh 白名单、执行器 `a DSH reviewer runs read-only and its fenced JSON verdict parses`。
- `package.json` 0.4.31；`client/index.js` 重建（22 fragments，9828 行）。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（最新）；
`node scripts/check-keys.mjs`（775 literal / 513 shared / 1157 page-local）；
`node --test lib/store.test.js lib/live/*.test.js`（446 通过 0 失败）；`node scripts/render-check.mjs`（exit 0）。

## [0.4.30] — 2026-11-13

修掉三件事：设置页保存返工预算报 `unsupported setting: executor.maxRepairRounds`；独立验收后端不能切到 Claude；
DSH worker 无法按仓库指定 Agent 预设。

根因：`lib/live/live-json.js` 的 FIELDS 白名单漏了 `executor.maxRepairRounds`（设置页能显示、保存被拒）；
`workflow-worker.js` 把验收后端硬编码为 `config.executor.reviewer ?? 'codex'`，且该配置项既不在白名单也不在 UI；
`worker.js` 一律 `presets.resolve()` 跟随宿主默认预设，没有按仓库覆盖的入口。

### 内容
- `lib/live/live-json.js`：FIELDS 增加 `executor.maxRepairRounds`（整数 0..6）、`executor.reviewer`（codex|claude）、
  `executor.workerPreset`（单行）；对应校验错误文案。保存设置不再报 unsupported setting。
- `lib/live/config.js`：executor 归一化 reviewer（仅 codex/claude，dsh 不能当 reviewer）与 workerPreset（trim、拒换行）。
- `lib/live/repos.js`：仓库项支持可选 `reviewer` 与 `workerPreset`（缺省回落到 executor 级配置）。
- `lib/live/worker.js`：`runWorker({ preset })` 显式解析预设，解析不到时记录一次并回落到宿主默认，不中断运行。
- `lib/live/executor.js`：`workerPreset = repo.workerPreset ?? config.executor.workerPreset` 传给进程内 DSH worker
  （分阶段与经典路径都传）；`executeWorkflow` 新增 `reviewer = repo.reviewer ?? config.executor.reviewer`。
- `lib/live/workflow-worker.js`：验收/规划后端取 `reviewerOverride ?? config.executor.reviewer ?? 'codex'`，
  实现仍走 `implementer`；启停检查同时看两个后端。
- `lib/live/worker-cli.js`：Claude 的调用放开 Bash（只读 review 仍用 `plan` 权限模式，编辑被禁；实现轮用 `acceptEdits`），
  验收可以自己 `git diff`、跑测试，不再需要把 diff 塞进 prompt。
- 设置 → Worker「分阶段执行」新增「独立验收后端」（Codex / Claude Code）与「Worker 预设（DSH）」输入，
  每个控件都带可见标题（`sa-field-head`）；两个下拉的选项跟随「启用的后端」过滤，被关闭的后端不再出现
  （仅当它是已保存值时保留并标灰）；render-check 增加「控件必须有可见标签」「选项跟随启用后端」两条回归断言。
  patch 白名单同步加入两项。
- 测试：live-json 白名单/校验、config 解析、仓库 presets/reviewer、执行器按 `executor.reviewer` 选择 CLI 后端。
- `package.json` 0.4.30；`client/index.js` 重建（22 fragments，9814 行）。

### 验证
`node --check index.js`；`node scripts/build-client.mjs --check`（22 fragments，最新）；
`node scripts/check-keys.mjs`（773 literal / 513 shared / 1157 page-local）；
`node --test lib/store.test.js lib/live/*.test.js`（442 通过 0 失败）；`node scripts/render-check.mjs`（exit 0，ok:true）。

## [0.4.29] — 2026-11-13

分阶段流程停下来时不再只报「workflow blocked: blocked」，返工预算真正生效并且可以在设置里调大后接着返工。
根因有三处：`runWorkflow` 达到返工上限时把 workflow 置为 blocked 但从不写原因，`executeWorkflow` 抛错时只能拿
`reason ?? status`，于是用户只看到 `blocked`；`executeWorkflow` 调用 `runWorkflow`/`resumeWorkflow` 时没有把
`config.executor.maxRepairRounds` 传进去，配置项只管到经典闸门自动修复，分阶段流程永远用默认 2；`workflowResumable`
只认「最后阶段 failed」，评审要求修改（completed + changes_requested）把预算用完时界面连「继续执行」都不给。

### 内容
- `lib/live/workflow.js`：`deliver` 内统一经 `blocked(reason, detail)` 停单，写 `state.reason` 与一行
  `state.detail`：规划遗留问题（带条数）、闸门失败（列出失败闸门）、review 明确 blocked、验收连续要求修改
  （`review still requested changes after N repair round(s) (M findings); raise executor.maxRepairRounds to keep repairing`）、
  候选在验收期间变化。导出 `blockedMessage(workflow)`；`resumeWorkflow` 在「最后是 completed changes_requested」时
  校验 key 里的 plan/gates/digest 与当前候选一致、预算尚有余额，然后 `repairs += 1` 并接回交付循环跑下一轮。
- `lib/live/workflow-worker.js`：`executeWorkflow` 把 `maxRepairRounds`（0–6，默认 2）传给两个入口；
  `assertResumable` 接受上述「验收要求修改」的停点，预算不足时报同一句可读原因；失败时抛
  `workflow blocked: ${blockedMessage(...)}`。
- `lib/live/executor.js`：`resumableWorkflowOf` 带上预算；`resumeInterruptedTicket` 无法续跑时返回
  `ticket … workflow blocked: <detail>`，不再只回 `has no interrupted run`。
- `lib/live/repos.js`：`workflowResumable(ticket, maxRepairs)` 对「验收要求修改」的停点按预算余额判定，
  `decorateTicket` 传入配置。
- `lib/live/config.js`：`executor.maxRepairRounds` 上限 3 → 6（0–6，默认 2；经典闸门自动修复仍按 1 起步、
  最多 3）。
- 设置 → 运行新增「返工预算」数字输入（0–6，默认 2，含校验与说明）；工单详情的 workflow 行显示停单 detail，
  「继续执行」确认文案覆盖「失败的一步」与「下一轮返工」两种续跑。
- `package.json` 0.4.29；`client/index.js` 重建（22 fragments，9800 行）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（770 literal / 513 shared / 1152 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：438 通过，0 失败。新增 8 条：各种停点都写原因与可读 detail；
  评审用尽预算后调大预算可续跑下一轮返工（阶段、repairs、verdict 序列）；候选变化拒绝续跑；`executeTicket` 在
  预算耗尽时给出可读错误、调大后只多跑一轮 implement + review 并交付；`resumeInterruptedTicket` 仍拒但带原因；
  配置 0–6 边界；`workflowResumable` 对 failed review / 预算余额 / 其它状态的判定。
- `node scripts/render-check.mjs`：通过（ok=true，0 失败）。

## [0.4.28] — 2026-11-13

分阶段执行失败后可以从失败的那一步继续，不再整条重跑。之前的「继续执行」只识别被插件重载中断的运行，
而分阶段流程的失败（例如 Codex 验收时额度用尽）是普通 failed run，界面只给「重试执行」，等于把已完成的分析、
实现和闸门全部重做。本单给失败的分阶段工单补上真正的断点续跑：沿用 `ticket.workflow` 里已完成的阶段，
只用失败阶段 key 里记录的输入重放该阶段，通过后照常提交、推送并按仓库策略交付。

### 内容
- `lib/live/workflow.js`：新增 `failedStageOf` 与 `resumeWorkflow`，交付循环抽成 `deliver`，支持带
  `pendingReview`（沿用已记录的 gates 证据与 digest）续跑 review；`makeStage` 复用同 key 的失败项原地重试，
  不再追加重复阶段。`RESUMABLE_ROLES = ['implement', 'review']`——评估/规划失败仍走整条重跑，闸门有既有
  的停单/重试路径。
- `lib/live/workflow-worker.js`：`executeWorkflow({ ..., resume })` 续跑时校验
  mode、requirementRevision、最后阶段为 failed 且 role 可续，然后采用 `ticket.workflow` 调用
  `resumeWorkflow`；digest 与验收证据不一致时拒绝续跑（`candidate changed since the gated review`）。
- `lib/live/executor.js`：`executeTicket({ ..., resumeWorkflow })` 传入续跑标记并记 `workflow:resume` 步骤；
  新增 `resumableWorkflowOf`，`resumeInterruptedTicket` 在没有 interrupted run 时改走
  `executeTicket({ trigger:'resume', resumeWorkflow:true })`，两者都没有仍返回 409。
- `lib/live/repos.js`：`workflowResumable(ticket)` 派生「failed + workflow blocked + 最后阶段 failed 且可续」，
  `decorateTicket` 以 `workflowResumable` 暴露给客户端（不持久化）。
- `client/src/58-ticket-detail.js` + i18n：失败且可续时主按钮改为「继续执行」，确认框说明只重跑失败的一步、
  已完成的分析/实现/闸门保留，「重试执行」仍在 ⋯ 菜单；新增 `detail.resumeWorkflowTitle/Confirm` 中英 key。
- `package.json` 0.4.28；`client/index.js` 重建（22 fragments，9772 行）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（767 literal / 513 shared / 1149 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：430 通过，0 失败。新增 5 条：review 续跑只重跑 review 且
  阶段台账原地复用；digest 变化拒绝续跑；implement 失败按记录的 plan/feedback 续跑；无失败阶段拒绝续跑；
  `executeTicket({ resumeWorkflow:true })` 在 planned 模式下只多调一次 review、implement 只跑一次、交付 dry-run，
  且新 run 继承闸门结果与实现摘要（续跑不会让运行记录变成空壳）。
- `node scripts/render-check.mjs`：通过（ok=true，0 失败）。

## [0.4.27] — 2026-11-12

新增可选分阶段 Worker：自动复杂度评估，或直接选择简单/方案驱动执行。复杂流程由 Codex 规划、Claude/DSH 实现、程序闸门、全新 Codex 会话验收组成，支持最多两轮返工与方案修订。默认关闭，保留现有路由行为。

- 新增 workflow/workflow-worker，结构化阶段结果写入台账与工单详情；Codex 使用 JSON Schema 输出。
- 候选指纹包括 HEAD、tracked diff 和未跟踪文件；验收中/发布前变更阻止交付；失败、禁用后端和无效验收结果不放行。
- 设置页新增执行流程与实现后端，live.json 白名单及归一化同步支持；客户端产物已构建。
- Host 425/425 通过；渲染检查通过；构建、i18n 与语法通过。隔离 DSH Host API 正常，但两次 Chrome 启动均未在 30 秒内暴露 CDP 端口，随后改用 ego lite，验证六个页面入口、Worker 控件保存与刷新持久化通过；发现并修复 settingsPatchOf 遗漏新字段，补对应渲染断言。
- 边界：未做真实 CLI 模型调用/远程交付；当前失败后重跑流程，精确阶段恢复、CLI 实时流和执行中自动升级尚未接入。详见 docs/staged-workers.md。

## [0.4.26] — 2026-11-12

移动端容器 500–600px 时，头部状态行与溢出菜单的触控区没有硬隔离：0.4.24 及更早版本里触发器是
`.sa-head-tools` 的最后一个子项，状态行排到内容右边缘后，40px 菜单点击区会压在「数据更新于 17:21」上；
0.4.25 已把触发器移进 `.sa-head-title`，状态行因此换到下一行，但工具行仍未给自己留出触发器列。本单补上
44px 右余量，并用回归断言锁住「触发器只在标题行」这一前提，即使以后两行再合并，状态文字也不会进入
40px 点击区。

### 内容
- `client/src/05-style.js`：`@container (max-width:600px)` 下 `.sa-head-tools` 增加
  `padding-right: calc(40px + var(--sa-sp-4))`，为标题行右端的 40px 溢出触发器保留 44px 列宽（触控目标 +
  间距）；601px 以上与桌面布局不受影响。
- `scripts/render-check.mjs`：新增 2 条断言——移动端溢出触发器必须位于 `.sa-head-title` 内且不在
  `.sa-head-tools` 内；600px 块的 `.sa-head-tools` 必须声明上述 44px 右余量。同时把「概览只有一条数据更新于」
  的文本断言收窄到列表行以外：本工单标题本身就引用了「数据更新于 17:21」，整页计数会把它误算成第二条状态行。
- `package.json` 0.4.26；`client/index.js` 重建（22 fragments，9730 行）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：418 通过，0 失败
- `node scripts/render-check.mjs`：148/148 通过，0 SKIP
- `node scripts/isolated-verify.mjs`：由执行器运行（本工作树不创建 `verification/` 产物）

## [0.4.25] — 2026-11-12

对超级智能体面板做了一轮 Impeccable 系统评分（Operate 模式；设计审查 + 1280/960/390 实机截图与
DOM/检测器证据），总分 33/40。评分暴露的是同一类问题：执行页的词汇在筛选片、分组标题、行标签和负载图例
之间各说各话；一个 40px 的移动端溢出菜单在标题下自成一行；工单头的验收跳转与主行动并排成两个「去验收」；
列头压在分组标题之上；四段负载条没有图例。本次把这几项落掉，不改 Host 契约。

### 系统评分
| 维度 | 分数 | 依据 |
|---|---|---|
| 系统状态可见 | 4/4 | 全局状态行、系统脉搏、执行器条都有实时值 |
| 贴合真实世界 | 3/4 | 词汇漂移：等待你 / 等待人 / 等待回答 |
| 用户控制与自由 | 4/4 | 确认、返回、Esc、菜单均可退出 |
| 一致性与标准 | 2/4 | 同页四种等待说法、列头位置、重复 CTA |
| 错误预防 | 4/4 | 暂停/重试/写操作均有确认与禁用态 |
| 识别而非记忆 | 3/4 | 图标按钮有 aria/title；负载条此前不可解码 |
| 灵活与高效 | 3/4 | Alt+1..6、Ctrl+K、筛选持久化 |
| 美学与极简 | 3/4 | 密度合理，但重复列头/空图例制造噪声 |
| 错误识别与恢复 | 4/4 | 失败原因、重试、not-found 空态完整 |
| 帮助与文档 | 3/4 | 术语表与页内提示齐全，缺 PRODUCT.md |

### 内容
- `client/src/58-ticket-detail.js`：`needsAcceptance` 时验收注记只保留「待你验收」文字，不再渲染第二个
  「去验收」跳转按钮；主行动本身已滚到 `#sa-acceptance`，两个同文案控件相邻会被读成重复操作。已验收/已打回
  仍保留「查看验收」跳转。
- `client/src/34-live-ui.js`、`client/src/55-execution.js`、`client/src/06-i18n.js`：统一执行页词汇为
  **排队 / 执行中 / 等你处理 / 失败 / 已结束**。分组标题、筛选片、`waiting_for_human` 行标签、负载图例使用
  同一组词；`awaiting-answer` 保留更具体的「等待回答」。`loadbarRunning` 由「运行中」改为「执行中」。
- `client/src/34-live-ui.js`、`client/src/55-execution.js`：队列列头只渲染一次，放进第一个分组 `Section`
  的标题之下（阶段分组、仓库分组、已忽略单组一致）；此前列头先于「等你处理 3」出现，读起来像页面级表头。
- `client/src/55-execution.js`：执行器负载条恢复图例（`ExecutorLoad` 默认 `labels=true`），四段颜色由同一组
  阶段词解码；零负载仍不画条。
- `client/src/30-shell.js`、`client/src/05-style.js`：移动端溢出菜单移入标题行（`.sa-head-title`）右端，
  标题格在 `@container (max-width:600px)` 下 `flex:1` 撑满，状态行因此整体换到下一行；菜单不再在状态行后
  单独占一行，也不会压住状态文字，40px 触控目标保留。`@container (max-width:760px)` 下
  `最近一次执行` 左对齐，换行后不再右飘。
- `scripts/render-check.mjs`：新增 3 条断言——工单头只有一个「去验收」、列头位于分组标题之后、负载条图例
  含四个阶段词；阶段词断言同步为新词汇。
- `package.json` 0.4.25；`client/index.js` 重建（22 fragments，9726 行）。

### 未落地（记录，不在本单）
- 评估页 39 条记录整页铺开（约 3390px），无分页/搜索；属于日志页信息架构改动，另开。
- 概览「策略规则」胶囊是只读 `Tag`，与状态标签同一惯用法；不改交互外观以免制造假按钮。
- 全局搜索遮罩使用宿主 `--dsw-alias-bg-mask-1`（24% 黑），实测像素 194 vs 255，遮罩有效，不改。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：418 通过，0 失败
- `node scripts/render-check.mjs`：147/147 通过，0 SKIP
- `node scripts/isolated-verify.mjs`：PASS（6 个 tab，0 console error；用 `CHROME_PATH` 包装脚本补
  `--no-sandbox --disable-crashpad`，否则本会话沙箱下 Chrome 在 `Runtime.enable` 超时）

## [0.4.24] — 2026-11-12

群回复「接单 A7K2」用于人工推翻模型否决时，replay 会按规则重新判定并建单，但这条路径此前只建单、不执行
（`outcome.started=false`），群回复固定为「已建单」；即使 `executor.enabled=true`，操作人还得再到面板点一次
执行，与「接单即执行」的语义不一致，也和已排队工单被接单时的行为不一致。规则重放本身只走规则（高风险硬闸门
仍然生效，规则判定 ignore 时不建单），因此启用执行器时应在 replay 建单成功后立即 autoExecute，并把群回复
改成「已开始执行」。

### 内容
- `lib/live/engine.js`：`applyReviewAnswer` 的 replay 分支在建单成功后，若工单仍为 `queued`/`ready` 且
  `executor.enabled === true`，置 `outcome.started = true` 并调用 `autoExecute([replay.ticket.id])`；与
  「已排队工单被接单」路径一致，闸门是 `executor.enabled` 而不是 `autoRun`（`autoRun` 只控制新工单的自动派发）。
  规则判定高风险时仍是 `blocked: 'high-risk'`，不建单也不执行。
- `lib/live/engine.test.js`：新增 2 个用例——(a) 模型否决的评估收到「接单」后 replay 建单并立即执行（即使
  `autoRun=false`），群回复是「已开始执行」、`review.outcome.kind = 'started'`；(b) 规则硬拦的高风险信号即使
  回复「接单」也不建单、不执行，回复仍是「规则判定高风险」。原「replay 建单」用例继续覆盖
  `executor.enabled=false` 时只建单（`已建单`）。
- `docs/intake-and-eval.md`：复查动作表补充「`executor.enabled=true` 时同时立即执行」。
- `package.json` 版本 0.4.22 → 0.4.24（本工单开工后 `develop` 已由空闲看门狗工单升到 0.4.23）；`client/index.js`
  无变化（未改客户端源码）。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：418 通过，0 失败（0.4.24 新增 2 例、0.4.23 新增 3 例）
- `node scripts/render-check.mjs`：143/143 通过（`ok: true`，0 SKIP）
- `node scripts/isolated-verify.mjs`：PASS（6 个 tab、0 console error）。本会话的 DSH 文件沙箱会挡住 Chrome 自带沙箱，裸跑在 `Runtime.enable` 超时；用 `CHROME_PATH` 指向补 `--no-sandbox` 的临时包装脚本后通过

## [0.4.23] — 2026-11-12

空闲看门狗只看 session 事件：`tool/call` 之后到 `tool/result` 之前没有任何事件，长 bash（如连续 12 次 render-check，约 5–6 分钟）必然超过 `workerIdleTimeoutMs`（默认 300000），worker 仍在跑却被判 `worker_lost` 并 cancel。本次让在途工具调用成为看门狗的活动窗口。

### 内容
- `lib/live/worker.js`：`runWorker` 新增 `pendingTools`（`callId` → 调用名与自身超时截止时间）。`tool/call` 到达时按 `callId`（兼容 `toolCallId`、`message.toolCallId`）登记，并解析该工具声明的 `timeoutMs`（bash 工具自身的执行上界）+ 15s 结果投递宽限作为截止时间；`tool/result`（兼容旧 `tool/end`）按同一 `callId` 释放。
- 空闲检查发现存在未过期的在途调用时只重新武装计时器，不再触发 `worker_lost`；全部在途调用都超过各自声明的超时后才以 `worker tool timeout` cancel 并记为 `worker_lost`。未声明超时的工具不设截止时间，由整体 worker 超时兜底，避免永不返回的工具无限等待。
- `session/disposed` / `agent/disposed` 立即失败路径保持不变；`idleTimeoutMs` 语义与 `live.json` 的 `workerIdleTimeoutMs` 配置不变。
- 测试：新增 3 个用例——(a) 只有 `tool/call`、静默跨过多个空闲窗口仍不判 `worker_lost`；(b) 同一 `callId` 的 `tool/result` 之后继续静默超过 `idleTimeoutMs` 仍判 `worker_lost`；(c) 其它 `callId` 的 result 不会释放在途调用。
- `package.json` 版本 0.4.22 → 0.4.23；`client/index.js` 无变化。

### 验证
- `node --check index.js`：通过
- `node scripts/build-client.mjs --check`：通过（22 fragments，产物最新）
- `node scripts/check-keys.mjs`：通过（760 literal / 513 shared / 1134 page-local）
- `node --test lib/store.test.js lib/live/*.test.js`：416 通过，0 失败（`worker.test.js` 新增 3 例通过）
- `node scripts/render-check.mjs`：143/143 通过，0 SKIP（首跑 1 例共享 harness 抖动，连续重跑全过）
- `node scripts/isolated-verify.mjs`：PASS（6 个 tab、0 console error）。本会话的 DSH 文件沙箱会挡住 Chrome 自带沙箱，裸跑两次在 `Runtime.enable` 超时；用 `CHROME_PATH` 指向临时包装脚本补 `--no-sandbox` 后通过

## [0.4.22] — 2026-11-12

本机安装态已切换为 `main` 分支打包产物：桌面 profile 的依赖是 `file:<tarball>`，`node_modules/@mystic7c/dsh-superagent-panel` 是 tarball 解包后的实体目录。但 `docs/self-development.md`、`AGENTS.md` 仍描述旧的 stable clone + `link:` 模型，且每次切换/回滚都要手工提取 tarball、改 profile manifest。本次把文档统一到打包模型，并新增可重复的本地打包安装脚本。

### 内容
- `docs/self-development.md`：`## 本机稳定安装（与开发仓库分离）` 改为 `## 本机安装（main 打包产物）`，写明 profile dependency 为 `file:<tarball 绝对路径>`、包目录是实体目录、升级必须显式安装新 tarball 再重载插件、stable clone 不再是安装源（仅作回滚参考）；新增「本地打包与安装」bash 示例（`git switch main` + `npm pack --pack-destination ../releases`、备份 `package.json`、删除旧目录/链接、`tar --strip-components=1` 解包、dependency 改 `file:<绝对路径>`、插件管理重载 + 刷新页面）；新增「升级边界」小节（develop 工单与 6 个闸门只作用于 `~/.dsh/superagent/worktrees`、安装态只有显式安装才更新、回滚用 `package.json.bak-local-install-*` 与旧 tarball）；分支策略、自开发流程、常见坑中关于安装/升级的措辞同步为打包模型，隔离验证的临时 `link:` profile 明确标注仅用于该闸门
- `scripts/local-install.mjs`（新增，Node 18+ ESM）：`--tarball <path>`（默认仓库同级 `releases/` 下当前版本的 `.tgz`）、`--profile-dir <path>`（默认 `$DSH_HOME/profiles/desktop`）、`--dry-run`、`--verify`、`--allow-branch`；非 dry-run 校验 `main` 分支、工作树干净、tarball 内 `name`/`version` 与仓库一致、profile 存在；备份 `package.json` 为 `package.json.bak-local-install-<时间戳>`，删除旧包目录或 symlink，解包到 `profile/node_modules/@mystic7c/dsh-superagent-panel`，dependency 改为 `file:<tarball 绝对路径>`；只写 profile 目录，不调用面板、不重启 DSH、不改 `live.json`，失败保留备份并清理解包临时目录
- `AGENTS.md`：`scripts/` 结构行补 `local-install.mjs`；发布交付语义改为显式安装 `main` tarball（stable clone 仅回滚参考）
- `package.json` 版本 0.4.21 → 0.4.22

### 验证
- `node --check scripts/local-install.mjs`
- `node scripts/local-install.mjs --verify`：当前安装态是 `file:...0.4.21.tgz` + 实体目录 0.4.21，只读通过；仓库已升 0.4.22，脚本只提示需显式安装
- `node scripts/local-install.mjs --dry-run --tarball ...0.4.22.tgz`：打印计划；profile `package.json` 哈希与 mtime 不变、无临时目录残留
- 临时仓库 + 临时 profile 端到端：默认从 `../releases` 发现 tarball、备份、删除旧 symlink、解包实体目录 0.4.22、改写 dependency，重跑 `--verify` 通过；`--allow-branch` 在 `feature/x` 上按预期放宽
- 6 个闸门：`node --check index.js`、`node scripts/build-client.mjs --check`（22 fragments）、`node scripts/check-keys.mjs`（760/513/1134）、`node --test lib/store.test.js lib/live/*.test.js`（413/413）、`node scripts/render-check.mjs`（143/143、0 SKIP）、`node scripts/isolated-verify.mjs` PASS（本 worker 沙箱内 Chrome 需经 `CHROME_PATH` 包装脚本补 `--no-sandbox` 才能初始化，面板 6 tab、0 console error）

## [0.4.21] — 2026-11-12

工单 tkt_16e724f48ddd41b0 的交付收尾。GitHub 仓库 `createMr: "push"` 的工单交付后，详情卡片的 MR 区显示
「还没有合并请求」，但同一张工单的合并状态又显示「已合入目标分支」。根因是 push 模式只把
`links.mergeRequest.webUrl`（`/pull/new/` 链接）落库，不写 `iid`；卡片与列表的 `hasMr` 只看 `iid`，于是把
「有链接」当成「没有 MR」。同时 `acceptTicket` 的 cleanup 只删本地 worktree 与本地分支，远程
`feature/<ticketId>` 一直留在 origin。本次让 webUrl 也算 MR 证据，并在 merged 工单验收后 best-effort
删除远程 feature 分支。

### 内容
- `client/src/34-live-ui.js` / `client/src/58-ticket-detail.js`：`hasMr` 改为 `iid || webUrl`；push 模式（只有 webUrl）
  的 MR 卡片显示「MR 链接 → 打开 PR」，并提示该 PR 由推送后的 `.github/workflows/auto-pr.yml` 创建；
  `links.verification.merged === true` 时保留链接并显示「已合入目标分支」，不再落到「还没有合并请求」空状态；
  列表证据列与阶段链路同步显示「PR 已创建」；中英文案同步（`ticket.openPr`、`mr.pushHint`、`row.evidencePr`）
- `client/index.js`：按 `client/src` 重建（22 fragments）
- `lib/live/repo.js`：新增 `deleteRemoteBranch({ repo, branch, timeoutMs = 120_000 })`，执行
  `git push origin --delete <branch>`；分支已不存在按已删返回（`{ deleted: true, alreadyGone: true }`），受保护分支
  直接拒绝，其它失败抛 `RepoError('remote-delete-failed')`
- `lib/live/engine.js`：`acceptTicket` 的 cleanup 阶段，在 `links.verification.merged === true` 且分支以 `feature/`
  开头时调用 `deleteRemoteBranch`，结果写 `links.cleanup.remoteBranchDeleted`（或 `remoteBranchError`）；删除失败
  只告警，不影响验收；未合入、非 feature 分支、缺分支名时跳过
- `lib/live/repo.test.js`：新增 3 个用例（删除成功、分支已不存在按已删返回、远端失败保留 RepoError 且拒绝受保护分支）
- `lib/live/engine.test.js`：新增 4 个用例（merged 验收删远程并落盘、未 merged 不删、release/ 分支不删、
  删除失败不阻塞验收且写 `remoteBranchError`）
- `scripts/render-check.mjs`：新增仅 webUrl 的 push 模式 fixture，断言 MR 卡片出现「打开 PR」与 auto-pr 提示、
  不出现「还没有合并请求」、合入后仍显示「已合入目标分支」
- `package.json` 版本 0.4.20 → 0.4.21

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`（`client/index.js is up to date (22 fragments)`）
- `node scripts/check-keys.mjs`（760 literal keys / 513 shared keys / 1134 page-local keys）
- `node --test lib/store.test.js lib/live/*.test.js` 413/413（新增 7 个用例）
- `node scripts/render-check.mjs`：143/143 通过、0 SKIP，含 2 条 push-mode MR 卡片用例；连续重跑一致
- `node scripts/isolated-verify.mjs` PASS（6 个 tab、0 console error）
- 说明：worktree 起点早于 v0.4.20（Inlines 递归修复）与确定性 render fixture（PR #14），合并 `origin/develop`
  后按合并结果重跑以上检查；CHANGELOG 中 0.4.20 两条为 develop 已有历史

## [0.4.20] — 2026-11-12

render 闸门周期性假红，失败断言是「overview names the needs-you vs worth-a-look split when both are on screen」，
最近一次与代码改动无关（只改了 `lib/live/worker.js` 等 Host 半），同一版本人工复跑有时又通过。根因是
`scripts/render-check.mjs` 的 fixture 从操作者当时的 state 派生：Overview 的「值得留意」区块只在
`ovWatchItems` 推导出 watch 项时渲染（24h 内失败 run、失败后被忽略的工单、error source、轮询滞后），
`deskScope` 也随之消失；inbox 只有验收项、最近没有失败 run 时 watch 为空，断言必失败。metrics 路由的 stub 又把
`failed` 固定为 0，无法补上 watch 项。DSH_HOME 指向空目录时另有 19 处失败，因为来源页、仓库/UAT、评估与触发页
的断言依赖真实 live.json 与历史数据。

### 内容
- `scripts/render-check.mjs`：fixture 注入确定性的「值得留意」数据——一条 `status: 'failed'`、`startedAt`
  为当前时间前 45 分钟的演示 run（`ticketId` 复用 `tkt_demo_accept`，`error` 固定为「演示：闸门 standards
  未通过」），以及一张 `status: 'dismissed'` 且 `assignments[].report.state === 'failed'` 的演示工单
  `tkt_demo_dismissed`；只改内存中的 engine.state，不写真实 state
- `scripts/render-check.mjs`：把目标断言拆成两条——「值得留意」区块内至少一行且文案匹配
  `/过去 24 小时 \d+ 次执行失败/`；split note 必须同时包含「需要你处理 = 」与「无需你动作」。pulse 句断言不再
  依赖哪张执行中工单排在第一位（真实 state 里本 worker 的工单可能更新），改为校验「系统脉搏」/「在飞」/用时文案，
  并单独断言 fixture 的执行中工单出现在「正在执行」区块
- `scripts/render-check.mjs`：metrics stub 与注入的失败 run 对齐（`runs.failed = 1`、
  `stopReasons['gate-failed'] = 1`、`failureReasons` 一条），避免 quality 卡片显示 0 失败而 watch 显示 1 次失败
- `scripts/render-check.mjs`：新增 `skip(name, reason)` 机制，打印 `SKIP name — reason` 并在汇总 JSON 的
  `skipped` 中计数，SKIP 不计 FAIL、不影响退出码；依赖本机配置/历史的检查组（UAT 链接、来源页 3 条、ebs
  仓库选项、GitLab token 编辑器、评估页 7 条、触发/线程页 5 条）在配置或数据不可得时明确 SKIP
- `scripts/render-check.mjs`：取消「真实 state 已有待验收工单就跳过注入」的分支，演示验收工单始终注入；
  否则操作者 inbox 里另一张待验收工单会改变（甚至破坏）详情页走查打开的入口
- 不改 `client/src/35-overview.js` 的产品逻辑：`deskScope` 只在 watch 存在时渲染是正确的

### 验证
- 真实 state：`node scripts/render-check.mjs` exit 0，141 条检查全过、0 SKIP；连续 3 次结果一致（均 141/141）
- 空 state（`DSH_HOME` 指向新建临时空目录，stateDir 不存在）：exit 0，123 条通过 + 18 条 SKIP，0 FAIL；
  连续 3 次一致
- `node --check index.js`、`node scripts/build-client.mjs --check`（22 fragments，未改客户端）、
  `node scripts/check-keys.mjs`（756 literal / 513 shared / 1131 page-local）、
  `node --test lib/store.test.js lib/live/*.test.js`（406 通过）
- `node scripts/isolated-verify.mjs` PASS（概览/来源/触发/评估/执行/设置 6 个 tab、0 console error）。本会话的
  DSH 文件沙箱会挡住 Chrome 自带沙箱，裸跑两次都在 `Runtime.enable` 超时（最小 CDP 探针可复现）；本次用
  `CHROME_PATH` 指向加 `--no-sandbox` 的包装脚本跑通，脚本本身未改

## [0.4.20] — 2026-11-12

自开发状态里 threads 与 triggers 同时存在时，打开「触发」页会让渲染进程堆内存暴涨（render-check 可复现 OOM，
桌面 renderer 也被带崩重启）：`client/src/20-widgets.js` 的 `Inlines` 对 link/ref 的标签文本递归调用
`inlines()`，而裸 URL 的标签就是该 URL 本身，二次解析又得到同一个 link，于是无限递归创建 `<a>`。本次给嵌套
渲染加上一层深度上限，并补一条 render-check 回归探针（裸 URL 只产出一个链接、不再出现嵌套 `<a>`）。

### 内容
- `client/src/20-widgets.js`：`Inlines` 增加 `depth`；link/ref 的标签只在最外层再解析一次，嵌套层直接输出文本
  （裸 URL 的自链接不再递归，也不再产生 `<a>` 嵌套告警）
- `scripts/render-check.mjs`：新增回归探针「a bare URL renders as one link without recursing」，直接挂载
  `MarkdownLite` 验证裸 URL 只渲染一个链接；`MarkdownLite` 从客户端片段中导出仅用于该检查
- `client/index.js`：按新片段重建

## [0.4.19] — 2026-11-12

工单 tkt_ed2bb9e10a3b46e2 的 run_3953a38ea58c476a 在 prepare-worktree 之后卡在 worker 步骤：worker 没有产出报告，
run 一直保持 `working`，只能重载插件让 reconcile 把 run 标成 `interrupted` 再 `/resume`。根因是
`lib/live/worker.js` 的 `runWorker` 只靠 `ctx.on('session/event')` 的 `turn/end` 来 settle；worker 会话/代理在没有
`turn/end` 的情况下结束或事件流中断时，`done` 永远不 settle，run 只能等 `executor.timeoutMs`（默认 1_500_000ms）
超时才失败，期间工单一直 `working`、也无法重试。本次加空闲看门狗与宿主结束信号，并让 worker_lost 的失败可重试。

### 内容
- `lib/live/worker.js`：记录最近一次 worker 事件时间（`assistant/message`、`tool/call`、`tool/result`、`turn/end`、
  `error` 等 `session/event`）；新增 `idleTimeoutMs` 参数（默认 300_000，由 executor 从配置传入），超过该窗口没有
  新事件时调用 `handle.agent.cancel?.('worker idle timeout')` 并返回 `{ error: 'worker_lost', timedOut: false }`，
  `events` 里追加一条 `error` / state `worker_lost` 的终止事件；同时监听 `session/disposed` 与 `agent/disposed`
  （`{ agent }`），worker 会话/代理被宿主关掉时立即 settle，不再等总超时。所有监听器在 `finally` 统一注销，
  `worker_lost` 只在 idle/lifecycle 路径记录一次 error 事件
- `lib/live/executor.js`：`invokeWorker` 透传 `idleTimeoutMs: config.executor.workerIdleTimeoutMs`；
  worker 返回 `error === 'worker_lost'` 时以 `stopReason/errorCode = 'worker_lost'` 结束 run（worker 步骤 failed）；
  `failRun` 对 `worker_lost` 把工单放回可重试的 `ready`（保留 branch/worktree），写一条 `run` activity，
  终态仍由 `finally` 的 `persist()` 落盘，不再出现长期 `working`
- `lib/live/engine.js`：`deriveInboxItems` 在 `run.stopReason === 'worker_lost'` 且工单为 `ready` 时仍派生
  `kind: 'failure'` 待办（标题「worker 失联，可重试」），保证失败在桌面可见
- `lib/live/config.js`：`DEFAULT_EXECUTOR.workerIdleTimeoutMs = 300_000`，合并时只接受 60_000..3_600_000 的整数
- `lib/live/live-json.js`：白名单新增 `executor.workerIdleTimeoutMs`（kind `worker-idle-ms`，60_000..3_600_000）
- `lib/live/worker.test.js`：新增 5 个用例（无事件 → idleTimeoutMs 后 `worker_lost`、窗口内有事件则重新计时、
  正常 `turn/end` 不受影响、`session/disposed`/`agent/disposed` 立即 settle）；`fakeHost` 按事件类型记录监听器，避免生命周期事件与
  `session/event` 混淆
- `lib/live/executor.test.js`：新增 worker_lost → run failed/stopReason worker_lost/工单 `ready`/worktree 保留/
  activity 与 inbox failure 待办/未提交未推送，并断言 `idleTimeoutMs` 从配置透传
- `lib/live/config.test.js`、`lib/live/live-json.test.js`：覆盖默认值 300_000 与 60_000/3_600_000 边界及越界回退
- `package.json` 版本 0.4.18 → 0.4.19

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`（`client/index.js is up to date (22 fragments)`）
- `node scripts/check-keys.mjs`（756 literal keys / 513 shared keys / 1131 page-local keys）
- `node --test lib/store.test.js lib/live/*.test.js` 406/406（新增 8 个用例）
- `node scripts/render-check.mjs` 本机 137/138；基线上同一个失败（`overview names the needs-you vs worth-a-look split`，
  本机 state 无 worth-a-look 项），与本次 Host 改动无关
- `node scripts/isolated-verify.mjs` 本机在 `Runtime.enable timed out` 失败；基线同（Chrome/CDP 环境问题）

## [0.4.18] — 2026-11-12

README 虽已在 0.4.17 把自开发细节移出，仍有 308 行：其中「hybrid 接单试点（0.3.4）」「评估确认（群消息复核，0.4.2）」
「决策模型 shadow（可选，落地第一步）」「功能成熟度」四节约占 170 行，属于机制/排障/历史细节，按 AGENTS.md 的
「文档分层」应放 `docs/`，README 只留概览与入口。本次把四节原样迁到两个新文档，README 只留「进阶能力」入口。
只改文档与版本号，不改 `index.js`/`lib`/`client`，不重建 `client/index.js`。

### 内容
- 新增 `docs/intake-and-eval.md`：原样迁入「hybrid 接单试点（0.3.4）」「评估确认（群消息复核，0.4.2）」
  「决策模型 shadow（可选，落地第一步）」三节（保留 H2 层级、表格、代码块、链接与数字），开头注明
  本文件是评估与接单的进阶配置、非安装必读
- 新增 `docs/feature-maturity.md`：原样迁入「功能成熟度」整节（稳定/可用/部分/未实现分级、P1/P2 批次、
  多后端路由与 P1 诚实边界）
- README 删除上述四节，替换为 6 行以内的「## 进阶能力」：评估接单与确认、决策模型 shadow 指向
  `docs/intake-and-eval.md`，功能成熟度指向 `docs/feature-maturity.md`；README 308 → 141 行，其余章节不动
- AGENTS.md 的 `docs/` 结构描述补上两个新文档名
- `package.json` 版本 0.4.17 → 0.4.18（`files` 已含 `docs/**/*.md`，无需调整）；README 顶部「当前版本」同步

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs` 138/138
- `node scripts/isolated-verify.mjs`

## [0.4.17] — 2026-11-12

README.md 已到 418 行，自开发的全部操作细节（`live.json` 仓库配置与字段语义、GitFlow、6 个闸门表、交付流程、
状态流转、入口、本机稳定安装、隔离实例验证、常见坑）都堆在「用面板开发本仓库（自开发）」一节，项目概览与操作手册
混在一起。本次做文档分层：细节原样移到 `docs/self-development.md`，README 只留一句话闭环、闸门名与入口链接。
只改文档与版本号，不改 `index.js`/`lib`/`client`，不重建 `client/index.js`。

### 内容
- 新增 `docs/self-development.md`（130 行）：`live.json` 字段语义（`verifyMode`/`acceptance`/`createMr`/`ci`）、
  GitFlow 分支策略、6 个闸门表与依赖说明、交付流程 1–5、状态流转与失败处理、入口、本机稳定安装、隔离实例验证、
  常见坑（merge commit 与 ancestry、GitHub 免费私库无分支保护、desktop profile 由 Electron 管理）；命令、路径、
  字段名与数字保持原样，只归并小标题并新设「常见坑」一节
- README「用面板开发本仓库（自开发）」由 132 行压缩到 12 行：一句话说明自开发闭环 + 一行 6 个闸门名 +
  指向 `docs/self-development.md` 与 `AGENTS.md` 的链接；README 418 → 308 行，其余章节不动
- AGENTS.md 新增「文档分层」约定：README 只放概览/安装/5 分钟接入/简短验证命令/入口链接，机制与排障细节放 `docs/`，
  版本变更写 `CHANGELOG.md`，README 超过约 250 行先考虑拆文档
- `package.json` 版本 0.4.16 → 0.4.17，`files` 加入 `docs/**/*.md`（README 链接的文档随包分发）
- README 顶部「当前版本」同步到 0.4.17

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs`
- `node scripts/isolated-verify.mjs`

## [0.4.16] — 2026-11-12

README 的闸门表只写了 `isolated` 验证什么，没写闸门清单从哪来、本机需要什么依赖、失败时看什么；在没装 Chrome 的
机器上只会读到 `no Chrome/Chromium binary found (set CHROME_PATH)`，不知道 `CHROME_PATH` 的作用与失败标记长什么样。
本次只补文档与版本号，不改代码、不重建 `client/index.js`。

### 内容
- README「用面板开发本仓库（自开发）」在闸门表后补一段：executor 的闸门清单来自 `live.json` 的 `repo.gates`；
  0.4.15 起第 6 项 `isolated` 由 `node scripts/isolated-verify.mjs` 承担（临时 `DSH_HOME`/state + 真实 Chrome
  headless CDP）；本机需 Chrome/Chromium，可用 `CHROME_PATH` 指定可执行文件；失败时打印
  `[isolated-verify] FAIL <原因>`
- README 顶部「当前版本」同步到 0.4.16（此前停在 0.4.14，0.4.15 漏更新）
- `package.json` 版本 0.4.15 → 0.4.16

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs`
- `node scripts/isolated-verify.mjs` 单独跑通

## [0.4.15] — 2026-11-12

`render` 闸门在 jsdom + 共享 `/tmp/sa-harness` 上渲染客户端，证明不了「真实 DSH Web UI 里 Host 半 + 客户端能一起挂载」。
新增 `scripts/isolated-verify.mjs`：临时 `DSH_HOME` 与 `DSH_SUPERAGENT_STATE_DIR`、随机端口、真实 Chrome headless CDP，
打开左侧栏「超级智能体」并断言 6 个 tab、空状态引导、console 无错误，截图写入 `verification/`（gitignore）。

CLI 定位兼容 `DSH_NODE_EXECUTABLE` + `DSH_INSTALL_DIR`（executor gate 环境可能没有这两个变量），
其次探测 macOS 应用包（asar 内的 `lib/bin.js` 由 Electron 以 `ELECTRON_RUN_AS_NODE=1` 读取），最后回退 PATH 上的 `dsh`。

### 验证
- 本机 `node scripts/isolated-verify.mjs` PASS（清空 `DSH_*` 环境变量后走 app-bundle 兜底）
- `node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`
- Host 测试 398/398、`node scripts/render-check.mjs`

## [0.4.14] — 2026-11-12

README 的数字与仓库实际状态脱节：顶部还写着 0.4.8（`package.json` 已到 0.4.13），「开发与验证」里的 Host 测试数量
仍停在 396，实际已是 398。本次只同步文档与版本号，不改代码、不重建 `client/index.js`。

### 内容
- README 顶部「当前版本」改为 0.4.14，并注明 0.4.13 起交付走 GitFlow（feature→develop，release/hotfix 走独立分支），
  版本历史指向 CHANGELOG
- README「开发与验证」的 Host 测试数量 396 → 398，与 `AGENTS.md`、闸门表和实跑结果一致
- `package.json` 版本 0.4.13 → 0.4.14

### 验证
- `node --check index.js`
- `node scripts/build-client.mjs --check`
- `node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs`

## [0.4.13] — 2026-11-12

自开发链路改用 GitFlow，并把自开发代码与本机日常安装彻底分开。此前仓库只有 `main`：工单 PR 以 `main` 为 base、
合并即发布，dev 代码通过 `link:` 直接进入桌面 profile；本版本把交付、发布、本机运行三层拆开，并新增隔离实例闸门。

### 内容
- `auto-pr.yml` 按分支前缀选 base：`feature/**` → `develop`，`release/**`、`hotfix/**` → `main`（幂等，已有 PR 跳过）
- 仓库配置：`baseBranch`/`targetBranch` 改为 `develop`，工单合入集成分支即 `merged`，`main` 只由 release/hotfix 合入
- README 增加「分支策略（GitFlow）」「本机稳定安装（与开发仓库分离）」「隔离实例验证」三节，交付流程与
  `verifyMode: manual` 的 ancestry 判定改为 `origin/develop`
- 新增 `scripts/isolated-verify.mjs` 与 `isolated` 闸门：临时 `DSH_HOME` + 临时 state + 随机端口起一次性 DSH，
  Chrome headless CDP 实机断言侧栏入口、面板页签与空状态、console 无错误，结束后清理
- `AGENTS.md` 交付语义改为 GitFlow（feature→develop、release/hotfix→main、tag 发布、stable clone 跟随 tag）

### 验证
- `node --check index.js`、`node scripts/build-client.mjs --check`、`node scripts/check-keys.mjs`
- `node --test lib/store.test.js lib/live/*.test.js`
- `node scripts/render-check.mjs`
- `node scripts/isolated-verify.mjs`（本机 Chrome；闸门上线后在真实工单上再验证一次）

## [0.4.12] — 2026-11-11

README 补上「用面板开发本仓库（自开发）」一节：自开发链路已经跑通（工单 → 闸门 → 推送 → auto-pr → merge commit →
验收），但操作口径只散落在 `AGENTS.md` 与 CHANGELOG 里，照 GitLab/旧仓库的旧习惯操作容易踩坑（例如用 squash
合并，面板的 ancestry 判定认不到已合入，工单停在 `mr-open`）。

### 内容
- README 在「开发与验证」后新增该小节，按本仓库在 `live.json` 的仓库项说明：
  - `verifyMode: "manual"`（只观察提交是否合入 `main`）、`acceptance: "merged"`（合入后仍需人工验收）、
    `createMr: "push"`（只推分支，推送输出的 `pull/new` 链接记为 pending MR）、`ci: false`（发布后直接 `mr-open`）
  - 5 个闸门 `syntax` / `client-build` / `i18n` / `host-tests` / `render` 的命令与各自验证范围
  - 交付流程：闸门 → 提交 → 推送 `feature/<ticketId>` → 面板记 pending MR 并进入 `mr-open` →
    `.github/workflows/auto-pr.yml` 自动开 PR → 人工评审
  - 合并必须用 merge commit（fast-forward 可以；squash/rebase 会重写 commit，`git merge-base --is-ancestor`
    判定不到，工单一直停在 `mr-open`）
  - 状态流转 `queued → working → mr-open → merged → 人工验收`；失败时先看「闸门结果」与运行记录里的证据
  - 入口：执行页「手工建单」时选本仓库（`live.json` 的默认仓库不是本仓库，不能沿用默认）
- 改动范围：README、CHANGELOG 与 `package.json` 版本号；不涉及 Host/客户端代码，`client/index.js` 不重建

### 验证
- `node --check index.js`、`node scripts/build-client.mjs --check`（22 fragments 最新）、
  `node scripts/check-keys.mjs`（756 literal / 513 shared / 1131 page-local）通过
- `node --test lib/store.test.js lib/live/*.test.js` 398/398
- `node scripts/render-check.mjs` 138/138（无客户端改动，渲染回归不变）

## [0.4.11] — 2026-11-11

第一张自开发工单的实测暴露了两个问题，都在这里修掉：GitHub 仓库带着 GitLab push options 推送会被服务端拒绝；
render 闸门失败时证据只剩 40KB JSON 的尾巴，看不到是哪条断言失败。

### 内容
- **GitHub 仓库不以 push options 推送**：`createMr: "push"` 原先无条件带 `merge_request.*` push options。GitHub 忽略这些
  选项（PR 由 `.github/workflows/auto-pr.yml` 在分支推送后创建），而实测带 options 的推送被 GitHub 以
  `remote unpack failed: no voting servers succeeded` 拒绝两次，同一分支不带 options 立即推送成功。新增
  `usesPushOptionMr(repo)`：`gitlab.baseUrl` 指向 github.com 时不带 options，GitLab 仓库行为不变；GitHub 输出里的
  `pull/new/<branch>` 链接仍由 `parseMergeRequestFromPush` 记为 pending MR，工单照常进入 `mr-open`
- **闸门失败证据可定位**：`executor.runCommand` 只保留命令输出末尾 4000 字节，而 render-check 的 JSON 约 40KB，
  失败断言的 `FAIL` 行正好落在被截断的前段。`render-check.mjs` 在 JSON 之后补打 `FAILED n/total: 名称 | …` 与最多
  3 条 `DETAIL`，自动修复 worker 拿到的证据能指向具体断言

### 验证
- `node --test` 398/398（新增 GitHub 仓库不带 options 推送、`usesPushOptionMr` 的两组断言）
- 自开发工单实测链路：worker 修复 → 5 个闸门通过 → commit → push 两次被 GitHub 拒绝（带 push options）→ 人工 retry
  不带 options 成功 → Actions 自动开 PR #1 → merge commit 合入 `main` → 面板按 ancestry 判定 `merged` → 人工验收

## [0.4.10] — 2026-11-11

修复 `metricsView` 时长夹具的 1ms 竞态（flaky）：`metricsView classifies runs, windows them and rolls up
durations/triggers/stop reasons (p2c §1)` 偶发失败——2026-11-10 的全量运行里实际值 `totalMs=5280001`、
断言期望 `5280000`，其它字段一致，重跑即过。

根因在测试夹具自身，不在引擎：`seedMetrics` 里每个 run 的 `startedAt` 与 `completedAt` 是两次独立调用
`hoursAgo(...)` / `daysAgo(...)` 得到的（例如 `startedAt: hoursAgo(1)`、`completedAt: plusMinutes(hoursAgo(1), 10)`）。
两次 `Date.now()` 之间跨过 1 毫秒时，该 run 的时长就从 600000 变成 600001，聚合结果随之漂移。

- `seedMetrics` 在夹具开头冻结一次 `base = Date.now()`，`hoursAgo` / `daysAgo` 增加可选 `base` 参数
  （默认仍是 `Date.now()`，其它用例行为不变），每个 run 的两端都由同一基准推导；断言意图与期望聚合值
  保留不变（avgMs 528000 / p50Ms 360000 / p95Ms 1800000 / totalMs 5280000）
- 用例新增一条守卫断言：每个已结束 run 的 `completedAt - startedAt` 必须是整分钟数（`% 60000 === 0`），
  漂移会直接指向出错的那一行，而不是只表现为聚合值差 1
- 只改测试夹具，运行时行为（`lib/live/engine.js`）不变，`client/index.js` 无需重建

### 验证
- `node --test` 397/397；该用例单跑与全量均通过，重复运行稳定（该用例连续单跑 10 次也全过）
- 复现对照（时钟每次 `Date.now()` 前进 1ms）：旧夹具单 run 600001ms、10 个 run 合计 5280010ms；
  新夹具 600000ms / 5280000ms
- `node --check index.js`、`build-client --check`、`check-keys` 通过
- `render-check` 138/138，连续复跑 20 次均通过（含 `bash -lc` 登录 shell 的 node 24.14、8 路并发与 CPU 满载）；
  发布闸门曾报过一次 render exit 1，同一工作树/live 状态下未能复现，本轮不改客户端与闸门脚本

## [0.4.9] — 2026-11-11

为「用面板开发面板」补齐 GitHub 交付侧的唯一缺口，并把仓库规则落成 worker 可直接读取的 `AGENTS.md`。

### 内容
- **GitHub 推送后解析 create-PR 链接**：`parseMergeRequestFromPush` 增加 GitHub 的 `/pull/new/<branch>` 形态，
  返回 pending merge request（`created:false`、无 `iid`）。GitHub 会忽略 `merge_request.*` push options 且不创建
  PR，此前工单停在 `pushed`（已推送·缺 MR）；现在工单进入 `mr-open`，manual 仓库的巡检继续用 git ancestry
  判断合并，面板详情页也能直接点开建 PR 链接
- **`.github/workflows/auto-pr.yml`**：GitHub 仓库的交付桥，`feature/**` 分支推送后自动 `gh pr create`
  （幂等：已有 PR 就跳过）。PR 仍需人工评审合并；合并请用 merge commit，否则 ancestry 判定不到
- **`AGENTS.md`**：仓库结构、改动最低验证命令（build --check / check-keys / host tests / render-check）、版本与
  CHANGELOG 约定、禁止项、GitHub 交付语义，供 Superagent worker 在干净 worktree 里直接遵循
- `CHANGELOG.md` 把 H1 移回文件顶部（0.4.8 的版本节误加在 H1 之前）

### 验证
- `node --test` 397/397（新增 GitHub create-PR 解析用例）；`build-client --check`、`check-keys`、`render-check` 通过
- 真实 GitHub 推送输出回归：`remote: Create a pull request ... /pull/new/...` 解析出 pending MR URL

## [0.4.8] — 2026-11-11

Impeccable 系统评分（28/40，含两路独立评估与实机检测）后的修正：先修三处界面与数据自相矛盾，再修窄屏、对比度与
键盘可达性。评分报告与优化清单见本轮交付；未落地的结构性建议（自动化开关收成一张状态卡、评估行 meta 收敛）
保留在后续清单。

### 界面与数据自相矛盾
- **闸门结果按 run 实际记录的闸门渲染**：`TicketGateResults` / `GateSummary` 原来固定映射 standards/backend/frontend，
  仓库自定义闸门（`ebs-deploy`、`ebs-access`）显示成三个「—」，而同页阶段链路写着「闸门 2/2」。现在遍历
  `runs[].gates`，未知名称保留原名，失败门附 exit code / 超时文本，并给每个门补 `aria-label`（名称·通过/未通过）
- **概览「3 张工单在失败后被忽略 → 查看」不再是死路**：watch item 带 `stage:'dismissed'` 深链；执行页新增
  「已忽略」切片（chip 计数、`ex.dismissedNote` 说明、按 dismissed 过滤），`ExecutionQueuePage` 接受 route stage
- **概览运行脉搏与来源页统一口径**：来源改用「已启用 1/3」（与来源页同分母）；执行器 `enabled=false` 时显示
  「已停用（设置→运行）」而不是「空闲 · 无排队或运行中工单」；来源页每张卡始终显示自己的停用原因，且仓库卡
  指向「启用执行器」而不是「启用引擎」
- **自动化未启动横幅**：暂停/引擎/执行器三个事实各带修复位置（设置→来源/运行）；警告图标与标题包进
  `.sa-automation-head`，390 下不再独占一行
- **规则标签「命中/未命中」→「通过/未通过」**：R3 的 reason 本来写「未命中生产/DDL/…」，旁边却标「命中」；
  「{hit} 命中 / {miss} 未命中」同步改为「{hit} 通过 / {miss} 未通过」
- **人工复核只记录时标「（仅记录）」**：`humanReview.outcome==='recorded'` 的评估行不再只写「人工：接单」

### 可达性与窄屏
- 执行页阶段计数徽标去掉 opacity（0.42/0.66 → 1）：实测 1.82:1 / 2.75:1 → 5.5:1，达到 WCAG AA
- `.sa-tag` 加 `flex: none`：390 下来源页 20/25 个标签被压到 ~20px 并与标题叠字；现在换行不裁切
- 设置：表单 760→640、开关 36×20→40×24、紧凑开关 30×18→36×24、`.sa-input input` 拉到 32px 高度（24px 目标下限）
- 搜索：Ctrl+K 打开、Esc 关闭时若 opener 是 `<body>`，焦点回搜索按钮（`Modal restoreTo`）；Alt+数字切页签时
  焦点随选中项同步（原来选中项 tabindex 已变 -1 而焦点仍留在旧页签）
- 手工建单：提交改为 32px 主按钮 + 「取消」，不再是从左下角 28px 按钮提交

### 验证
- `node --test` 396/396；`render-check` 138/138（新增 5 条：闸门自定义名、已忽略切片、规则标签、手工建单动作等）
- `build-client --check`、`check-keys` 通过；`impeccable detect --cdp` 六页面板内 findings 0（修前 1 条 low-contrast）
- 实机复检 1280/960/390：概览 来源「已启用 1/3」+ 执行器「已停用」、执行页 7 个阶段 chip 与「已忽略」切片、
  工单详情闸门区显示 `ebs-deploy`/`ebs-access`、390 横幅图标同行、标签不压字

## [0.4.7] — 2026-11-11

修复「运行记录」把交付时的阶段当成实时状态：`tkt_f6a66f97a4ab41fe` 的 MR 已合并、已部署 UAT 并验收，
运行记录里仍有一条「等待 CI」在转圈，看起来像 CI 一直没回来。

根因是两段事实不一致：`run.status` 在交付那一刻被写成工单当时所处的阶段（`lib/live/executor.js` 的
`run.status = ticket.status`，例如 `ci-pending`），此后 CI 通过、MR 合入、部署、验收都只改 `ticket.status`
与 `ticket.links`，不会回写 run（run 是只追加证据，唯一的回写是 reconcile 把陈旧的 `running` 标成
`interrupted`）。而运行记录行直接拿 `run.status` 走工单状态表渲染，`ci-pending` 在状态表里是 `ongoing`
（默认转圈），于是**已经结束几小时的 run 一直在转**。

- 新增 `runView(t, run)`（`client/src/34-live-ui.js`）：run 有 `stopReason` 且状态不是 `running` /
  `waiting_for_human` 即视为已结算，形状由结束原因（`RUN_STOP_STATE`）决定；若它的末状态是交付阶段
  （`ci-pending` / `ci-passed` / `mr-open` / `pushed` / `merged` / `deploy-pending` / `gates-passed` / `ready`），
  文案改为「交付时：{阶段}」，不再借用该阶段的实时形状。交付时的阶段作为历史保留，`stopReason` 标签
  （完成 / 失败 / 中断…）不变
- 三处同源渲染改走 `runView`：工单详情运行记录行（`58-ticket-detail.js`）、阶段链路「执行」步结果、
  `LiveRunRows` 兼容层
- 回归：render-check 把演示工单的 run 固定成 `status:'ci-pending' + stopReason:'done'`（真机上该工单的形态），
  新增「已交付 run 写交付时阶段」「已结算 run 不转圈」两条断言，136/136；`node --test` 396/396；
  `build-client --check` 与 `check-keys` 通过

## [0.4.6] — 2026-11-09

修复工单详情「工单动作」菜单显示成一块空白灰块：菜单按 `align="end"` 向左展开，越过 `.sa-scroll` 的横向
裁剪边界后，整列文字被裁掉，只剩背景色。

- `Menu` 打开时按触发点两侧的可用宽度实测选边：能容纳时沿用调用方指定的方向，左侧空间不足则向右展开
  （`data-align` 改为实测方向），键盘操作与 `aria-*` 不变
- 只在客户端，刷新面板页面即生效；`getComputedStyle` 通过 `ownerDocument.defaultView` 走，jsdom 下也不崩
- 回归：render-check 135/135；`node --test` 396/396

## [0.4.5] — 2026-11-09

修复「执行超时」在设置里只能看不能改：worker 超时后无法调大超时再重试。

- `live.json` 白名单新增 `executor.timeoutMs`（整数毫秒，60000–86400000 校验）；设置→运行 改成分钟输入框
  （1–1440），保存即生效
- 保存前做范围校验，提示明确；说明文案写明「超时以 timeout 结束本次运行，工作树保留，可调大后重试」
- 回归：live-json 增加 timeout 边界用例；render-check 增加「运行超时可编辑」断言

### 验证
- `node --test` 396/396
- render-check 135/135
- `npm run verify`：client 产物最新；752 literal keys / 513 shared / 1121 page-local 通过

## [0.4.4] — 2026-11-09

修正 0.4.3 对 `tkt_969114d7aca74a45` 的结论：根因不是"worker 用了 subagent"，而是 **worker 在自己发起的
异步 run 还没完成时就结束了本轮**；0.4.3 禁用 subagent 工具只是绕过问题，违背"worker 对自己发起的 run 负责"
的约定。0.4.4 改为在 harness 的 turn 边界上强制等待。

- worker 在 setup 里监听 `agent/turn-stopping`（harness 在 `turn/end` 提交前 await 的边界钩子），用
  `subagents.listDescendants` + `subagents.waitForChildren` join 仍在运行的子代理；子代理结果回到 worker
  inbox 后 loop 再跑一步，直到没有 live child 才允许结束本轮（tkt_969114d7aca74a45，2026-11-09）
- 恢复 `subagent` / `subagent_fork` / `list_agents` / `send_message` 工具（不再禁用）；workerBrief 改为
  "可以起 subagent 做独立复核；run 会等它们完成，不要在结果回来前给最终总结"
- 兜底：最多 join 20 轮；abort 立即退出；`waitForChildren` 返回 false（idle resident child）不阻塞完成
- 测试：`joinChildrenBeforeTurnEnd` 单测 ×3 + worker 注册/清理/join 测试 ×1
- 验证：`node --test` 395/395；render-check 134/134；build-client --check、check-keys 通过

## [0.4.3] — 2026-11-09

两件事：修复 worker 把"等待独立复核"当成最终执行总结（tkt_969114d7aca74a45），以及评估确认的配置进入设置页。

### worker 总结停在"等待独立复核"

工单 `tkt_969114d7aca74a45` 已走到 `mr-open`，但执行总结是"初版改动已完成，独立复核仍在进行中…"。
trace 显示 worker 在会话里调用了 `subagent` 起异步复核、`list_agents` 发现还没结果，随后用了
`superagent_report_progress` 并结束本轮（`turn/end completed`）；executor 以"turn 结束"作为 worker 完成，
继续跑闸门、提交并发布 MR，最后一条 assistant 文本就成了 handoff summary。异步 subagent 的结果不会回到
这个 headless run，所以那句话不是最终交付说明。

- 修复：worker 的 `DENY_TOOLS` 增加 `subagent` / `subagent_fork` / `list_agents` / `send_message` /
  `interrupt_agent`，headless run 不允许再起异步 agent
- workerBrief 明确：headless run 在 turn 结束时收尾，独立复核必须在本轮内 inline 做第二遍；不要起后台 agent
- 回归：worker guard 测试覆盖新增的 denied 工具

### 评估确认设置页可配置

- 新增「设置 → 评估确认」可写分组：启用开关、确认范围（all/uncertain）、允许回复的操作人
  （Octo uid 逗号/换行分隔，留空 = 没人能回复）、回复有效期（1–168 小时），带保存栏与校验
- `live-json.js` allow-list 新增 `review.enabled` / `review.scope` / `review.allowSenderIds` /
  `review.expireHours`（枚举/小时数校验），设置页保存走同一原子写与配置回滚
- render-check 增加「评估确认」分组与 rail 顺序检查
- 验证：`node --test` 391/391；render-check 134/134；build-client --check、check-keys 通过

## [0.4.2] — 2026-11-09

评估确认（群消息复核）：每条评估回发来源群，操作人回复「接单/忽略 + 短码」决定是否开单，并把判断写成信号
标签用于校准。

- 新增 `lib/live/reviews.js` + 引擎 review 流程：每条被评估的消息（规则接单/规则忽略/模型否决）生成一条
  `#ABCD` 短码确认消息发回来源群；回复支持 `接单 ABCD` / `忽略 ABCD`（也支持码在前）
- 回复在 intake 之前拦截，不会变成新需求；机器人通知以 `Superagent:` 开头，被自回复过滤，不会循环
- 动作：模型否决/规则忽略 + 接单 → 规则重放建单（规则硬拦的高风险仍拒绝）；已排队工单 + 接单 → 立即执行；
  已排队工单 + 忽略 → dismiss；忽略 + 忽略 → 记录一致
- 每次回答写 `decision.humanReview` 并把 `correct / false_wake / missed_wake` 写入信号标签
- 严格 gate 用 `executor.autoRun=false` 控制（新工单排队等确认）；未回复的评估按 `review.expireHours`
  （默认 24h）过期
- 配置 `review.enabled / scope(all|uncertain) / allowSenderIds / expireHours`；面板设置→评估显示确认范围与
  待回复/已回复计数，评估页显示人工结论标签
- 新增 8 条 reviews 单测 + 10 条引擎 review 流程测试 + 1 条配置测试
- 验证：`node --test` 390/390；render-check 133/133；build-client --check、check-keys 通过

## [0.4.1] — 2026-11-09

修复 hybrid 线上漏单：2026-11-09 05:41 的一条真实需求

> 需求：库存出入库流水表（Cux_Mtl_Transactions_Pkg.Main）数据传BI …… 1、新增procedure：Main_Bi，参数 p_Ledger_Id…

被 `ticket-v1` 判成 `context`（P(repo_task)=0.30）→ `modelSkip` 忽略。消息里大量表名/procedure/参数名触发了
`context` 描述，但它是明确的开发需求（要求新增 procedure、并发请求、定时刷新、写入 cux schema）。

- 问题集 `ticket-v1` → **`ticket-v2`**：`repo_task` 描述扩展到"或提出具体的开发/数据交付需求（含需求说明、
  procedure/报表/接口、参数与定时规则）"；同一条消息重判为 `repo_task` 0.97
- 回归：人工回归集 25 条保持 24/25；真实标注（加入这条漏单，24 条）22/24，开单精确率保持 100%；
  golden/real 上没有新增误开
- 漏单的原始信号已用重放补建工单（replay 走规则判定，人工覆盖通道）
- 验证：`node --test` 374/374；render-check 116/116；build-client --check、check-keys 通过

## [0.4.0] — 2026-11-09

多 Worker 后端路由：原来 `executor.workerBackend` 只能选一个后端，现在可同时启用 DSH / Codex CLI / Claude Code CLI，并由路由按任务类型选择执行者与档位。

- 配置：`executor.workers`（每个后端 enabled/model/command）+ `executor.routing`（`mode: single|suggest|auto`、`defaultBackend`、`fallback`、`preferences`）；未写 workers 时完全沿用旧的单后端行为
- 分类与路由（`lib/live/routing.js`）：关键词分类 analysis/review/test/dev/docs/research/interactive；能力硬约束优先（联网调研与需提问只能 DSH、测试验证不能 Claude），其次用户偏好、默认、降级链；多后端默认 `suggest`（只记录建议，仍用默认后端），`auto` 才真正分发
- 执行：`run.route` / `ticket.route` 记录 workType、backend、profile、reason；CLI 按档位收紧（Codex `-s read-only`、Claude `--permission-mode plan`），DSH 只读用工具 guard 禁写；analysis/review/research/interactive 无改动时交付报告并结束为 `closed`，不跑闸门、不提交推送
- 手动改派：`POST engine/ticket/:id/run` 支持 `backend` 覆盖路由（记录为 manual）
- 面板：设置→Worker 改为路由模式、三后端启用与模型/CLI 路径、默认/降级后端、任务类型偏好表；运行记录新增「后端 · 类型（建议）」标签
- 回归：`lib/live/routing.test.js` 8 条 + executor/config/live-json 新增用例；`node --test` 374/374；render-check 133/133
- **发布失败自动修复闭环**（同版本树内补记）：`publishTicket` 闸门失败后把失败闸门的 exit code/输出/repairHint 交回
  worker，在同一 worktree 修复后重算 changedPaths、重跑全部闸门；最多 `executor.maxRepairRounds` 轮，成功继续
  commit/push/MR，耗尽才 `failed`。修复轮 brief 允许改 `scripts/local/` 的部署/授权工具（`oracle_connect.py` 与
  凭据仍禁止，`protectedPaths` 兜底）；发布接口改为异步 202；`run.repair`/`run.repairs`/`repair:worker:N` 可追溯。
  实测：`tkt_640380ab550b4e54` 发布时两轮自动修复（deploy 幂等 + access 属主连接）后开 MR !11 并合并
- **手动仓库巡检不再被上限停掉**（同版本树内补记）：`verifyMode=manual` 的仓库只观察 MR 是否合并，不再套用
  “同一 head 3 次”上限，合并/关闭后才停；CI 仓库用尽 3 次时工单详情验收区显示「点 ⋯ → 核对合并/UAT」提示。
  修复前该工单在 MR 合并 26 分钟后仍停在 `mr-open`

### 验证
- `node --test` 374/374
- render-check 133/133
- `npm run verify`：client 产物最新；737 literal keys / 513 shared / 1102 page-local 通过

## [0.3.8] — 2026-11-09

设置新增「Worker」页签：把 worker 后端与「运行后端能力」矩阵从「运行」组迁出，单独成组。

- 左侧导航在「运行」之后新增「Worker」（robot 图标）：Worker 后端选择、模型/CLI 路径与该后端的提示、只读
  「运行后端能力」矩阵都在这里；「运行」组只保留执行器总开关、自动执行、暂停、MR 方式、闸门/超时与手工建单
- 新组可写，沿用同一 `executor.*` allow-list：`settingsPatchOf` 的 run/worker/write 三组共用补丁逻辑，各自独立
  草稿与保存条；选中 DSH 时仍不渲染模型/CLI 输入（与迁移前一致）
- 文案同步：运行组提示不再提 worker 配置；工单详情的 CLI 失败提示改指「设置 → Worker → CLI 路径」；README 的
  设置分组说明同步
- 回归：render-check 131/131（新增 Worker 组、运行组不再含后端/能力矩阵、导航顺序、能力矩阵高亮 4 条断言）

### 验证
- `node --test` 355/355
- render-check 131/131
- `npm run verify`：client 产物最新；724 literal keys / 513 shared / 1064 page-local 通过

## [0.3.7] — 2026-11-09

修复「发布 MR」时带 `passChangedFiles` 的闸门拿不到改动文件：发布路径直接跑 gate 的原始命令，没有像干跑那样把
`changedPaths` 拼进去，EBS 部署闸门在参数解析阶段就退出（`未指定任何文件`，exit 2），根本没有连 UAT。

- 抽出 `gateCommandFor(spec, { paths, dryRun })`，干跑与发布两条闸门路径共用：`passChangedFiles` 的闸门一律附带
  执行器算出的改动路径（发布时用 `changedPaths(cwd, baseSha)` 重新计算）
- 发布路径补上 `requireOutput` 证据校验：闸门 exit 0 但输出缺少必需关键字同样判失败（与干跑一致）
- 回归：publish 把改动路径传给 `deploy_object.py`、缺证据时 `gate_failed` 且不推送；`node --test` 355/355
- 说明：干跑路径一直正常，所以之前 dry-run 闸门都是 exit 0；该 bug 只在「发布 MR → 真跑闸门」时暴露

### 验证
- `node --test` 355/355
- `npm run verify`：client 产物最新；723 literal keys / 513 shared / 1062 page-local 通过

## [0.3.6] — 2026-11-09

修复追加要求后「执行总结」显示上一轮的问题：`changesOf` 原来取 runs 列表里最后一条 worker 文本，而 runs 按最新在前，
于是第二轮之后仍显示第一轮的总结，看不出这次追加要求做了什么。

- 「改动内容 → 执行总结」改为取**最新一次写过总结的 run**，并标注来源 run（`执行总结（来自运行 run_xxx）`）；
  追加要求（revision）重跑后显示的就是这一轮的总结
- 改动文件列表仍是跨轮并集（"当前工作树里有哪些改动"），与总结的口径分开
- 回归：render-check 用"旧一轮 + 新一轮"的 fixture 验证总结不回退到旧轮（125/125）

### 验证
- `node --test` 353/353
- `render-check` 125/125
- `npm run verify`：client 产物最新；723 literal keys / 513 shared / 1062 page-local 通过

## [0.3.5] — 2026-11-08

工单详情支持「追加要求并自动重跑」：干跑结果不对时，操作员不必重新开单，也不用手工改 `live-state.json`。

- 新增 `POST /superagent/api/engine/ticket/:id/revision`（body `{text}`）：把要求追加到工单 `revisions[]` 并记一条
  `revision` 活动，随后**自动以干跑方式重跑**（`trigger=revise`，复用同一 worktree，不提交/推送）
- `Engine.addRevision` 校验：空内容 / 超 4000 字、执行中、等待回答、已结束或已忽略、已验收的工单拒绝；未知工单 404
- worker task 按顺序携带最近 10 条追加要求，并提示"上一轮改动在 worktree 中，保留并在此基础上修改"
- 面板：工单详情「改动内容 → 追加要求」输入框 + 「追加并重跑」，并展示修订历史（时间 + 原文）；运行记录新增
  `runTrigger.revise`（追加要求）标签
- 概览：新增第 6 类待办 `publish` —— 干跑已完成、还没发布的工单现在会出现在「需要你处理」里
  （标题「工单「…」干跑完成，等待你确认发布」，`blocking:true`、`priority:normal`，点「去工单」进入详情）；
  发布或开始下一轮后条件消失，条目自动 resolve。之前 `ready` 状态在概览上完全不可见，只有执行页能看到
- 工单详情：`ready`（干跑完成）的主行动从「干跑执行」改为「发布 MR」（仍走确认弹窗），「干跑执行」与其余动作
  留在 ⋯ 菜单——发布才是这一状态的下一步，而不是再跑一遍
- 回归：`Engine.addRevision` 状态矩阵、workerTask 修订注入、路由校验、`publish` 待办推导/自动 resolve、
  render-check 表单/历史/提交与 ready 主行动

### 验证
- `node --test` 353/353
- `render-check` 123/123
- `npm run verify`：client 产物最新；722 literal keys / 513 shared / 1061 page-local 通过

## [0.3.4] — 2026-11-08

hybrid 接单试点：规则仍是第一道门，模型 `ticket-v1` 参与 R1 的"要不要开单"。

- 新增 `eval.mode='hybrid'`：候选先走规则（R2/R3 硬闸不变，规则忽略的不会调用模型）；规则接单后按模型类别决定：
  `repo_task` 且 `p ≥ acceptAt`（默认 0.5，按 pilot 标注校准）→ 自动开单；`risky` 或 `riskP ≥ riskAt`（默认 0.5）→ 忽略
  `modelRisk`；其他类别 → `modelSkip`；中间区 → `modelUncertain`
- 人工兜底：三种模型否决都落为可重放的原始信号（来源页），重放会用规则重新判定并建单（人工覆盖通道）
- 失败与预算：模型报错或单轮 `maxPerPoll` 用完 → 回退规则 accept，不静默丢工作；hybrid dry run 会调用模型
- 决策记录新增 `decision.model`（category/p/riskP/verdict/latencyMs）与 `evalMode:'hybrid'`、`actorKind:'hybrid'`；
  面板评估页模型标签同时支持 shadow/hybrid 决策；设置→评估新增 hybrid 模式与调用/回退计数
- 状态面 `eval.hybrid`（calls/fallbacks）、`eval.decision.riskAt`；poll 结果带 `hybrid.judged/ignored/fallbacks`
- 验证：`node --test` 350/350；render-check 116/116；build-client --check、check-keys 通过

## [0.3.3] — 2026-11-08

决策模型 shadow 的问题集从 `request-v2`（isRequest noul）换成 **`ticket-v1`**（一个 `choice` 五选一：
repo_task / octo_platform / chat / context / risky）。原因：旧问题把"改 Thread.md、改 system prompt、建 thread、
查评论、排查 webhook"这类 **Octo 平台内事务**也当成工作请求，在人工回归集上会误开 12 单；五类 choice 显式
把"仓库/工作区/数据库任务"和"Octo 平台内事务"分开后，误开单归零。

- `JUDGE_QUESTIONS_VERSION` → `ticket-v1`；`p = P(repo_task)`、`riskP = P(risky)`，映射
  repo_task→开单候选、risky→拦、其余→不开；judge 客户端解析 `choice.probabilities`（缺 probabilities 时
  退回选中项）
- 选项描述文字视为契约的一部分：第一次接入时把描述改成同义表述，真实标注召回从 80% 掉到 60%，恢复原文后
  回到 80%；因此选项文字变化必须升问题集版本
- 人工回归集（25 条，`spec/shadow-golden-set.md`）：规则 12/25、旧问题集 18/25、`ticket-v1` **24/25**；
  真实 23 条标注：规则 11/23、旧问题集 13/23、`ticket-v1` **21/23（开单精确率 100%、召回 80%）**
- `shadow-collect.mjs` 重判时保留人工 `label`/`labeledAt`（此前换问题集会把 23 条标注清空，已修）
- 面板评估页 shadow 标签的 tooltip 增加五类类别
- 验证：`node --test` 342/342；render-check 116/116；build-client --check、check-keys 通过

## [0.3.2] — 2026-11-08

决策模型 shadow（落地第一步）：接单判断仍由规则（R1–R3）决定，但引擎可以把每条候选消息交给一个 System One
决策模型（阿里云百炼 `decision-model-preview`、TypeSafe Jev、Kev/Von 等同协议实现）再判一次，把模型答案记录在
`decision.shadow` 上，用于后续标注、温度拟合与 hybrid 决策。模型永远不改变接单结果。

- 新增 `lib/live/judge.js`：System One 协议客户端（`POST /v1/systemone`，`state` + `questions`），固定问题集
  `request-v1`：`isRequest`（这条消息是不是要做的活）与 `isHighRisk`（第二意见，仅记录）；带超时、HTTP 错误归一化、
  `noul` 概率解析与 `verdictOf` / `shadowOf` / `shadowErrorOf`
- 新增 `eval.mode='shadow'`：规则照常 accept/ignore 并建单；模型答案只写 `decision.shadow`
  （`status`、`p`、`riskP`、`verdict`、`ruleKind`、`latencyMs`、`questions`；失败为 `status:'error'`+`error`）
- `eval.decision` 配置：`endpoint` / `model` / `tokenFile` / `timeoutMs` / `acceptAt` / `rejectAt` / `maxPerPoll` /
  `concurrency`；越界值 clamp；token 走独立文件 `decision.token`（600），也可用 `DECISION_TOKEN` 环境变量
- 新增 `POST /superagent/api/engine/eval/token`（写/清 token，永不回显）；redacted 配置只回 `tokenConfigured`
- 引擎状态新增 `eval.decision`（配置是否就绪、问题集版本）与 `eval.judge`（calls / ok / errors / skipped / lastError）
- 每轮轮询有调用预算与并发上限；dry run（「检查新消息」）不调用模型；重放信号也会记录一次 shadow
- 面板：评估页每行显示「模型 93% · 倾向接单」标签（hover 含模型名与风险概率）；设置 → 评估只读显示模型配置
  与调用计数，`shadow` 模式有独立文案
- 新增 `scripts/judge-smoke.mjs`：不进引擎、不写状态，直接按 live.json 打通一次模型调用并打印 shadow 行
- 新增 `lib/live/shadow.js` + `scripts/shadow-collect.mjs`：批量取样（每个监听群最新 N 条消息，用同一套过滤/R2/R3
  与规则评估，再逐条问模型），样本写 `<stateDir>/shadow-samples.json`，**不写 live-state、不建工单**；默认复用上次
  答案，`--refresh` 全部重问；同时给出规则×模型交叉表、p 分布、风险分布、延迟分位与最值得人工标注的分歧列表
- 问题集 `request-v1` → `request-v2`：judge 的 state 固定为纯文本。pilot 实测把消息包成
  `{text, channel, threadTitle}` 会让「依据这个SQL，写一个视图」的 isRequest 从 0.97 掉到 0.09（同文本纯字符串
  0.97），所以 channel/threadTitle 不再进 state；需要上下文时只以文本前缀拼接

### 验证
- `node --test` 341/341（本特性 29 条：judge 10、config +2、engine shadow +8、shadow collector +8、API token +1；
  其余为 0.3.1 diff 回归；渲染回归 116/116）
- `npm run verify`：client 产物最新；702 literal keys / 513 shared / 1034 page-local 通过

## [0.3.1] — 2026-11-08

工单详情补上「查看 diff」：此前只列改动文件和 worker 总结，patch 本身不可见，操作员无法在面板里核对 worker
到底改了什么（面板「运行后端能力」矩阵里早已写着 diff 可用）。

- 新增 `lib/live/diff.js`：只读渲染一次 run 的工作树改动 —— 已跟踪修改走 `git diff <baseSha>`（工作树 vs 基线
  提交，含执行器已提交到分支的部分），未跟踪文件用 `git diff --no-index` 补成新文件段；`execFile` 传 argv，
  不经 shell
- 新增 `GET /superagent/api/engine/ticket/:id/diff?runId=&path=`（`Engine.ticketDiff`）：选最近一次带工作树的
  run；`path` 把结果收窄到单个文件（只匹配 git 自己报出的路径）。工作树/基线提交不存在时返回 `available:false` +
  `reason`，不把"读不到"伪装成"没有改动"（基线失效时退回 HEAD 并标 `baseMissing`）
- 上限与脱敏：总计 200 KB / 单文件 60 KB / 60 个文件，未跟踪文件超过 512 KB 不读；`.env`、`secrets/`、
  `node_modules/` 等 `FORBIDDEN_PATH_PATTERNS` 命中的路径不渲染
- 面板：工单详情「改动内容」里**每个改动文件名都是入口** → 点文件名只弹该文件的 patch（不是全部文件的合并
  diff）；弹窗按行着色（新增绿 / 删除红 / hunk 蓝 / 文件头加粗），带路径、±行数、run、基线 SHA、复制 diff
  与截断提示；工作树已清理时说明原因
- 回归：`diff.test.js` 覆盖按文件过滤（已跟踪/未跟踪/未知路径）、API 路由 1 条（含 `?path=` 与工作树已清理）、
  render-check 7 条（文件行入口/单文件弹窗/请求带 path/着色/摘要/关闭）

### 验证
- `node --test` 333/333
- `render-check` 115/115
- `npm run verify`：client 产物最新；715 literal keys / 513 shared / 1047 page-local 通过

## [0.2.6] — 2026-11-08

修复 R3 高风险主题的误判：`/生产|prod(uction)?/i` 做的是子串匹配，EBS 对象名 `Cux_Mtl_Sale_Products_Rpt`
里的 `Products` 被当成"生产"拦下（2026-11-08 的 `sig_502a33836cb540b6` 因此没有成为工单）。

- 风险词改成按词匹配：`/生产|(?<![A-Za-z])prod(?:uction)?(?![\w])/i` —— `生产`、`prod 环境`、`PRODUCTION 库`、
  `eBS_prod` 仍然拦；`Products`/`PRODUCT_ID`/`PROD_ID`/`procedure` 不再命中
- `pipelineVersion()` 前缀 `rules-v1` → `rules-v2`：重放是按 pipelineVersion 幂等的，只改规则内容不升版本时，
  重放会直接返回旧的 ignore 而不是按新规则重判；因此规则内容变化必须同时升前缀
- 回归测试：对象名含 `Products`/`PRODUCT_ID` 的请求 accept；`prod`/`PRODUCTION`/`生产`/`eBS_prod` 仍 highRisk；
  版本断言改为 `rules-v2`

### 验证
- `node --test` 306/306（新增 1 条边界回归）
- `npm run verify`：client 产物最新；687 literal keys / 513 shared / 1018 page-local 通过

## [0.2.5] — 2026-11-08

工单详情页三批修正（评审 21 条：8 条 P0 / 8 条 P1 / 5 条 P2），见 `spec/critique-ticket-detail-2026-11-08.md`。

### 批次一：会让页面"说了不算"的
- 锚点导航补上「自动化」，导航与滚动监听改为同一份 `DETAIL_JUMPS`（原两份清单都漏）
- 闸门阻塞时不再渲染「去处理闸门」空操作主行动——banner 自带三个决策；无主行动时菜单显示为「工单动作」
- 运行中的工单不再把「干跑执行」放主行动（挪进菜单），primary 只留给可启动的状态
- 闸门结果与 banner 同源：`pendingGate` 也渲染成"未通过 · 待处理"，不再出现"闸门未通过 + 还没有闸门结果"
- 验收时间只出现一次（页头「已验收 · 时间」），页头文案去掉重复的"验收"字样
- worker 报告里 `## 改动内容（3 个文件）` 之类的小节标题被清掉（正则原来只匹配精确标题，且匹配对象是标题文本）
- 时间统一：历史行（验收/运行/UAT 检查/时间线/活动）一律 `MM-DD HH:mm`；相对时间只用于"更新于"和调度
- 时间轴/活动行图标、时间、文案之间补间距（`.sa-event-actor` 加 flex gap）

### 批次二：噪音与重复
- 空的「闸门结果」「活动」section 不再渲染；活动流折进「时间线」的一条 disclosure
- 无 MR/UAT 时验收压成一句提示，不再两张空卡 + 禁用链接 + 解释句
- 自动化卡折成一行 disclosure（默认收起）；「保存自动化」只在表单与已存配置不同时出现
- 闸门失败策略（人工/自动修复）在 section 级说一次，不再每个闸门挂一个标签
- 阶段链路去掉截断 id；运行记录的短 run id 改成可复制的复制按钮

### 批次三：排版
- 「改动内容」在宽屏拆两栏：左 = 执行总结（72ch 阅读列），右 = 改动文件 + 需求折叠；空出来的右半边不再白着，窄屏回落单列（`@container (min-width: 1000px)`）
- 改动文件超过 5 个时先显示 5 个 + 「显示更多（共 N 个）」，展开后可「收起」；切到另一张工单时自动回到收起态
- 详情页头部重排：验收状态 + 时间 + 「查看验收」移到工单标题右侧；「打开 MR」/「工单动作」收进标题行右上角，原先标题下的整行验收说明与独立行动行删除（页面少了两行）。无主行动时右上角仍是带文字的「工单动作」
- 验收卡片 `auto-fit`，宽屏不再留第三列空洞
- 元数据 KV 与验收卡的两列布局保持到 640px（768 不再被过早压成单列）
- 详情阶段链路改为单行 breadcrumb（触发 › 评估 › 工单 › 执行 › 闸门 3/3 › #28 · 已合并 › UAT 可访问），窄屏去分隔符；顺带修掉 `<ol>` 的 40px 默认缩进
- 自动化卡的次数/时间字段限宽 200px，不再拉满整卡

### 验证
- `node --test` 305/305；`render-check` 107/107（新增：锚点含自动化、自动化折叠与脏保存、活动折叠进时间线、空闸门区不渲染、阶段链路无截断 id、改动内容两栏、头部标题行含验收说明与动作、文件列表收起/展开）；`build-client --check`、`check-keys` 通过
- 视觉验收：1440/1024/768/390 + 深色 + 闸门阻塞/运行中/已验收三状态；页面高度（1440）从 ~4200px 降到 ~3050px

## [0.2.4] — 2026-11-08

执行页视图控件的重做：分组方式 / 排序 / 显示已结束从「两个 260px 胶囊轨道 + 小灰标签 + 黑开关」的两行表单，收成一行真正的列表工具条。

### 设计/操作面
- 阶段筛选改为同行计数 chip（`sa-segmented-chips`）：每个阶段一枚 chip，计数在 chip 内，只有选中项着色——不再是一条横贯全宽、像第二个 tab 栏的胶囊轨道
- 分组与排序改为带标签的取值按钮（`Menu` 新增 `text` 形态）：按钮上直接写明「分组 按阶段」「排序 最近更新」，点开是带勾选的二选一菜单；不再需要「分组方式 / 排序」两个小灰标签各配一条胶囊
- 三个控件并进一行（阶段 chip 左、视图选项右、中间细分隔线），一行放不下时视图选项自然换行且左对齐；≤560 两列网格 + 独占一行的开关
- 「显示已结束」改用紧凑开关（30×18），与 28px 控件同高，不再是在白色页面上最抢眼的黑色胶囊
- 空列表时不渲染这行控件（与旧阶段胶囊一致）
- 同一套 chip 顺手用到评估页（决定类型 + 时间窗口，替换原 `Pill` 胶囊）与触发页（线程筛选），三页筛选行现在同一外观；删掉已无调用的 `Pill` 控件与 `.sa-pill` 样式

### 验证
- `node --test` 305/305；`render-check` 95/95（新增：chip 内计数、两个取值按钮的当前值、开关仍在、评估/触发筛选同为 chip）；`build-client --check`、`check-keys` 通过
- 真实浏览器（headless Chrome + 宿主主题 token + 真实 live 夹具）1440/1024/960/820/768/390 六档截图、深色主题、英文、菜单展开、按仓库分组、空列表八种状态逐一看过
- 本轮宿主侧无改动；面板刷新页面即生效

## [0.2.3] — 2026-11-07

第三轮收口：清掉 0.2.2 剩下的 P3，只做一致性、可读性和验证，不扩展功能。

- 来源页去掉独有的 PageHead，恢复为与其它页一致的 tab + section 结构；摘要行保留
- 设置页在 ≥960px 把 140px 导航 + 760px 表单作为一组居中，不再在右侧留下约 400px 空白；表单 max-width 680→760
- 删除 `SegmentedTabs` 中未被 CSS/标记消费的 `data-more` 测量状态，减少死代码
- 390 设置分组行高 36→40，移动头部菜单触发目标 36→40；tabs/菜单保持更大命中区
- 验证：1440 表单居中（body x≈560 / 760 宽）；720px 宽度无横向溢出；`prefers-reduced-motion: reduce` 匹配；深色主题切换后页面背景 `rgb(21,21,23)`、无横向溢出

## [0.2.2] — 2026-11-07

第二轮设计复评后的修正：把 0.2.1 过度收缩的执行控件改成真正的紧凑工具栏，补齐窄屏导航的可见性，并统一关闭态。

### 操作面
- 执行页在 1024/390 恢复紧凑工具栏：1024 首条工单从 y≈708 提升到 y≈507；390 从 y≈868 提升到 y≈794；阶段 pill 在 1024 为 6 列、390 为 3×2，均无裁切
- 执行页自动化条改为 compact（隐藏说明行），automation bar 出现时隐藏重复的“已暂停”badge 和执行器 hint
- Octo token「清除令牌」改为带后果说明的确认弹窗，与仓库 token 清除一致
- 390 设置子标签由单行横向滚动改为两行换行，7 个分组全部可见
- 工单详情窄屏恢复 sticky context（截断标题+状态），并加 IntersectionObserver 滚动联动；分区跳转高度提升到 32px
- 来源页增加页面级自动化条；关闭态卡片不再逐张重复“已禁用”，有 token 时 dry-run 可继续使用
- 来源 GitLab 卡片在 1024 改为 1-up 容器查询；概览“运行质量”回到左列，不再形成三列等宽
- ≤600px 头部四个图标收进“更多操作”菜单，图标目标 36px；移动端 tabs 最小 40px
- 自动化条显示“配置 3/4”进度；完成案摘要改为“共 8 张：5 已验收、3 已忽略；其中 3 张在失败重试后完成”

### 验证
- `node --test` 305/305；`render-check` 90/90；`build-client --check`、`check-keys` 通过
- 隔离 CDP：1024 执行首条 y≈507、390 首条 y≈794；390 设置 nav 两行；来源 1024 一列卡片；源/执行自动化条无溢出
- 面板检测器仍为 0 条 `.sa-*`；仅 DSH 宿主 2 条既有项

## [0.2.1] — 2026-11-07

设计评审后的操作面打磨：把"三个开关、四个说法"收敛成一个自动化状态，并修掉 1024/390 下的三处响应式断裂。

### 设计/操作面
- 概览与执行页共用「自动化未启动」状态条：一次确认即可恢复处理、启用引擎、启用执行器；引擎只差开关时不再同时出现暂停条、首次配置卡和系统问题三条重复提示
- 首次配置卡只在配置前置项未完成时占主位；有历史数据时退化为一行，避免教程压住值班信息
- 执行页控件改为标签+控件成组：≥960px 一行，窄屏每组一行；六个阶段筛选在 390 下改为多行网格，不再裁掉「已结束」
- 设置页在 ≤960px 从 260px 竖排导航改为可横向滚动的子标签，表单不再被导航推到首屏之外；表单正文宽度收窄
- 触发页窄屏：线程行出现「›」打开提示；未进入详情前不再显示虚假的选中底色；1280/1440 保持双栏
- 执行台账：已验收行用成功勾、失败后忽略用警告标识，不再全部显示空心 idle；MR 编号统一为 `MR #n`
- 来源页增加页面标题与统一的「已启用 x/y」摘要；去掉 `live.json 未启用` 这类实现细节
- 工单详情窄屏分区导航改为单行横向滚动；正文 measure 限制 72ch
- 概览漏斗去掉与步骤重复的总结行，只保留出站失败这个新增信息
- 头部术语表按钮与其他图标按钮统一为 outlined；自动化条内直接给出「检查新消息」文字入口

### 验证
- `node --test` 305/305；`render-check` 90/90；`build-client --check` 与 `check-keys` 通过
- 隔离 CDP：1440/1024/390 三档实测；检查了设置导航、执行工具栏、阶段筛选、触发紧凑布局、自动化条与确认启动、工单详情分区导航
- 确定性检测器：复核面板 `.sa-*` findings（工具栏/导航/选中行），并保留 host chrome 两条既有项

## [0.2.0] — 2026-11-07

首个产品化版本：把面板从"只读仪表盘"升级为可运营的主动型 agent 控制台。

### P0 — 可信与止血
- `run.stopReason/errorCode` 结构化失败；worker 事件 → `run.trace`
- 闸门失败不再直接判死：park 为 `waiting_for_human` + `pendingGate`，面板可「放行 / 重试该闸门 / 终止」
- 插件重载后的中断运行标记为 `interrupted`（可继续执行），不再一律 `failed`
- `inbox.json` 持久待办（gate/accept/failure/source/engine），支持已读/已解决；概览按阻塞程度排序
- 工单行 3-tag 预算、分组按注意力成本、验收与工单状态解耦、详情 404/500 分离

### P1 — 分层与可复盘
- `signal-log.json`：每个候选（含被过滤/跳过）落库，decision 带 `pipelineVersion/verdicts/actorKind`；可按当前规则重放
- `operations.json` 运行台账：trigger/handoff/usage/report/checkpoint/trace 外置，`live-state.json` 只留索引行
- `acceptance.json` 验收轮次：program checks、证据、`delivered/failed/errored`、人审决定与 intents
- worker 报告工具（`superagent_report_progress/artifact/set_verify/ask_human`）；`ask_human` 暂停为 `awaiting-answer`，回答后带 Q/A 重跑
- 检查点续跑、工单活动流、执行页视图选项（按阶段/仓库、排序、显示已结束、sessionStorage）

### P2 — 主动与观察
- 工单级自动执行：固定间隔 / 每天 HH:mm / 次数上限 / nextAt / lastSkipReason；触发原因 `heartbeat|schedule`
- GitLab 观察升级：MR `headSha`、只采用匹配 head 的 pipeline、`pipeline.stale` 不覆盖结论、draft/WIP 跳过、自动巡检 3 次/headSha
- signal 人工标注（correct/false_wake/missed_wake/cleared）与来源页计数
- gate `onFail: manual|auto_repair` + `executor.maxRepairRounds`（0..3）：失败门全为 auto_repair 且非 errored 时，同一 worktree 自动 repair worker 并重跑 gates
- 设置页只读 worker 能力矩阵（DSH/Codex/Claude × 流式事件/审批/会话恢复/diff/报告工具）
- `GET engine/metrics`：24h/7d/all 运行质量（成功/失败/停止/中断/等待、时长 p50/p95、触发方式、Top 失败原因、按仓库、验收轮次/通过率、信号标注）；概览「运行质量」卡片。token/成本数据待宿主提供。

### 验证
- `node --test` 305/305；`render-check` 90/90；`build-client --check` 与 `check-keys` 通过
- 隔离 CDP 实例真实渲染冒烟：概览运行质量、执行页视图选项、工单详情自动化卡片、设置页能力矩阵、验收/MR 状态

### 已知边界
- 仍未实现：agent/llm 验收验证器与评分 rubric、Goal、多通道（GitHub/飞书/企微）、多 agent 编排、token/成本聚合
- `@deepseek-ai/dsh-tools` 为 peerDependency；宿主缺失时 worker 报告工具静默跳过
- 状态目录 `~/.dsh/superagent`；`spec/` 与 `verification/` 为本地文档/截图，不入库
