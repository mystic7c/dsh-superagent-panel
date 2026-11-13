# 用面板开发本仓库（自开发）

本仓库也在 `live.json` 的 `repos[]` 里注册成一个受管仓库（id `dsh-superagent-panel`），所以可以「用面板开发面板」：
执行页手工建单 → 执行器在 git worktree 里让 worker 改代码 → 跑 6 个闸门 → 提交并推送 `feature/<ticketId>` →
GitHub Actions 自动开 PR → 人工评审合并 → 面板巡检到合入后等人验收。配置在 `live.json`（默认
`~/.dsh/superagent/live.json`，`DSH_SUPERAGENT_STATE_DIR` 可改状态目录）的仓库项里，关键字段如下
（只列关键字段；本机路径、`timeoutMs` 等从略）：

## 仓库配置（`live.json`）

```json
{
  "id": "dsh-superagent-panel",
  "baseBranch": "develop",
  "verifyMode": "manual",
  "acceptance": "merged",
  "gates": [
    { "name": "syntax", "command": "node --check index.js" },
    { "name": "client-build", "command": "node scripts/build-client.mjs --check" },
    { "name": "i18n", "command": "node scripts/check-keys.mjs" },
    { "name": "host-tests", "command": "node --test lib/store.test.js lib/live/*.test.js" },
    { "name": "render", "command": "node scripts/render-check.mjs" },
    { "name": "isolated", "command": "node scripts/isolated-verify.mjs" }
  ],
  "gitlab": {
    "baseUrl": "https://github.com",
    "project": "mystic7c/dsh-superagent-panel",
    "targetBranch": "develop",
    "createMr": "push",
    "ci": false
  }
}
```

- **`verifyMode: "manual"`**：不做 CI/UAT 观察，只认一个远端事实——工单的提交是否已合入集成分支 `develop`
  （`git merge-base --is-ancestor <commit> origin/develop`，分支取自 `baseBranch`）。本仓库只有 `pull/new` 链接、
  没有 MR iid，所以合并判定实际走 ancestry。发布到 `main` 由人做 release 合并，不参与工单验收。
- **`acceptance: "merged"`**：合入不等于完成。工单到 `merged` 后阶段仍是「等待人」，要在工单详情的「验收」
  里点「验收通过」（或记录拒绝原因打回）才会离开待处理列表。
- **`createMr: "push"`**：执行器只推 `feature/<ticketId>` 分支，不通过 API 建 MR；GitHub 不消费 GitLab 的
  `merge_request.*` push options（实测带 options 的推送还会被服务端拒绝），推送输出里的
  `.../pull/new/<branch>` 链接会被面板解析成 pending MR。
- **`ci: false`**：本仓库没有面板可观察的 CI 流水线，发布后直接从 `working` 进入 `mr-open`，不经过 `ci-pending`。
- 字段名沿用面板的 `gitlab.*`（即使仓库托管在 GitHub）；`baseUrl` 指向 github.com 时执行器不带 GitLab push
  options，PR 交给 `.github/workflows/auto-pr.yml`。

## 分支策略（GitFlow）

- `main`：发布分支，只接收 `release/**` 与 `hotfix/**` 的合并；每次发布打 tag（`v0.4.13` 起）。本机安装跟随
  `main` 的打包产物（见「本机安装（main 打包产物）」）。
- `develop`：集成分支，工单的 `feature/<ticketId>` 都合到这里；`live.json` 的 `baseBranch`/`targetBranch` 指向它。
- `feature/**`：执行器为每张工单推送的交付分支，auto-pr 以 `develop` 为 base 开 PR。
- `release/<version>`（从 `develop` 切出）与 `hotfix/<version>`（从 `main` 切出）：auto-pr 以 `main` 为 base 开 PR；
  合并后打 tag，并把 `develop` 回合并一次，避免 release 分支上的修复丢失。

`develop` 首次创建：`git checkout -b develop && git push -u origin develop`。

## 6 个闸门

6 个闸门由执行器按顺序执行，任一失败就停下，不会继续提交或推送（失败门保留 exit code、超时标记与输出末尾）：

| 闸门 | 命令 | 验证什么 |
| --- | --- | --- |
| `syntax` | `node --check index.js` | Host 半 `index.js` 语法 |
| `client-build` | `node scripts/build-client.mjs --check` | `client/index.js` 与 `client/src/` 是否同步（改了源码没重建就失败） |
| `i18n` | `node scripts/check-keys.mjs` | 客户端用到的文案 key 都存在，且中英文词典 key 一致 |
| `host-tests` | `node --test lib/store.test.js lib/live/*.test.js` | Host 全量单测（当前 541 个） |
| `render` | `node scripts/render-check.mjs` | jsdom 渲染回归（jsdom/React 来自 `/tmp/sa-harness`） |
| `isolated` | `node scripts/isolated-verify.mjs` | 起一个隔离 DSH（临时 `DSH_HOME`/state、随机端口）加载本工作树的面板代码，用 Chrome headless CDP 实机渲染并检查侧栏入口、页签与空状态、console 无错误；结束后清理 |

执行器的闸门清单来自 `live.json` 的 `repo.gates`（上面只是仓库配置里的一份快照，增删闸门要改 `live.json`）。
0.4.15 起第 6 项 `isolated` 由 `node scripts/isolated-verify.mjs` 承担：临时 `DSH_HOME`/state 加真实 Chrome headless
CDP。因此本机需要 Chrome/Chromium，可用 `CHROME_PATH` 指定可执行文件（找不到时脚本报
`no Chrome/Chromium binary found (set CHROME_PATH)`）；脚本失败时会打印 `[isolated-verify] FAIL <原因>`，闸门结果里
能看到同样的输出。

## 交付流程

1. 执行器为工单开 worktree，worker 只改工作树、不提交；交付前执行器核对改动（feature 分支前缀、受保护路径，
   见 `protectedPaths`）。
2. 闸门全部通过后提交并推送 `feature/<ticketId>` 到 `github.com/mystic7c/dsh-superagent-panel`。
3. 推送输出里的 `pull/new/<branch>` 链接被面板解析为 pending MR，工单进入 `mr-open`；没解析到链接时停在
   `pushed`（已推送、缺 MR），需要到 GitHub 上按分支手动开 PR。
4. `.github/workflows/auto-pr.yml` 按分支前缀自动开 PR（幂等：已有 PR 就跳过），PR 由人评审：
   `feature/**` → `develop`，`release/**` 与 `hotfix/**` → `main`。
5. 合并到 `develop` 请用 merge commit（不要 squash 或 rebase，fast-forward 可以）；原因见「常见坑」。

## 状态流转与失败处理

`queued`（建单）→ `working`（执行中）→ `mr-open`（已推送、待评审合并）→ `merged`（巡检发现合入，阶段仍是
「等待人」）→ 人工验收（记录 `links.acceptance` 后算完成）。

- 失败分支：闸门未通过停在 `gate-blocked`（可「重试该闸门」「放行」「终止」）；worker/提交/推送失败进入 `failed`。
- 失败时先看工单详情的「闸门结果」：失败门带 exit code 与是否超时；闸门暂停（`gate-blocked`）时横幅里能展开并
  复制失败输出末尾。运行记录保留同一次 run 的闸门、执行轨迹与报告，据此修复后重试。
- `live.json` 顶层的 `executor.autoRun` 为 `false`：手工建单只会进队列，不会自动开跑，执行与发布由人在工单详情
  触发。

## 入口

执行页 →「手工建单」→ 仓库下拉选择 **DSH Superagent Panel**（`live.json` 的默认仓库是 `ml-ebs`，别沿用默认），
填写标题与需求后创建；工单随后按上面的流程推进。自开发的典型操作路径是：手工建单 → 工单详情「干跑执行」
（worker 改工作树、跑闸门、不推送）→ 确认改动后「发布 MR」（重跑闸门再提交、推送）。合入 `develop` 只更新
集成分支，不会更新本机安装；把新版本装进日常界面要显式安装 `main` 的 tarball（见「本机安装（main 打包产物）」）。

## 本机安装（main 打包产物）

本机桌面 profile 的安装态**只来自 `main` 的打包产物**，不是开发工作树：

- profile 依赖是 `file:<tarball 绝对路径>`（例如
  `file:/Users/mlamp/Documents/workspace/private/dsh-plugins/releases/mystic7c-dsh-superagent-panel-0.4.21.tgz`）。
- `~/.dsh/profiles/desktop/node_modules/@mystic7c/dsh-superagent-panel` 是 tarball 解包后的**实体目录**，
  不是指向开发仓库的 `link:`。
- 升级必须**显式安装新 tarball**，再在面板的插件管理里重载插件并刷新页面；合并进 `develop`、在工作树里跑闸门
  都不会改动安装目录或运行态。

### 本地打包与安装

推荐用仓库自带脚本（参数见下），等价的纯手工步骤如下：

```bash
# 1) 在 dev 仓库的 main 分支打 tarball，产物落在仓库同级的 releases/
cd <dev-repo>
git switch main && git pull --ff-only
mkdir -p ../releases
npm pack --pack-destination ../releases
# 产物：../releases/mystic7c-dsh-superagent-panel-<version>.tgz

# 2) 备份 profile 的 package.json
PROFILE="$HOME/.dsh/profiles/desktop"
cp "$PROFILE/package.json" "$PROFILE/package.json.bak-local-install-$(date +%Y%m%d-%H%M%S)"

# 3) 删除旧包目录（或旧的 link）
rm -rf "$PROFILE/node_modules/@mystic7c/dsh-superagent-panel"

# 4) 把 tarball 解包到 profile node_modules 的包目录（tarball 内层是 package/）
TARBALL="$(cd ../releases && pwd)/mystic7c-dsh-superagent-panel-<version>.tgz"
mkdir -p "$PROFILE/node_modules/@mystic7c/dsh-superagent-panel"
tar -xzf "$TARBALL" -C "$PROFILE/node_modules/@mystic7c/dsh-superagent-panel" --strip-components=1

# 5) 把 profile dependency 改为 file:<tarball 绝对路径>
#    编辑 "$PROFILE/package.json" 的 dependencies：
#    "@mystic7c/dsh-superagent-panel": "file:/.../mystic7c-dsh-superagent-panel-<version>.tgz"

# 6) 在面板「插件管理」里重载该插件（或禁用→启用），然后刷新页面
```

也可以一条命令完成 2–5 步（默认从仓库同级 `releases/` 找当前版本的 tarball）：

```bash
node scripts/local-install.mjs              # 备份 → 解包 → 改 dependency（要求当前在 main 且工作树干净）
node scripts/local-install.mjs --dry-run    # 只校验并打印计划，不写盘
node scripts/local-install.mjs --verify     # 只读核对当前安装态
```

脚本支持 `--tarball <path>`（指定 tgz）与 `--profile-dir <path>`（默认
`$DSH_HOME/profiles/desktop`，通常 `~/.dsh/profiles/desktop`），并校验 tarball 内 `package.json` 的
`name`/`version` 与仓库一致。安装前要求 `main` 分支且工作树干净（`--allow-branch` 可放宽分支检查）；
它只写 profile 目录及其包目录，**不调用面板、不重启 DSH、不改 `live.json`**，失败时保留
`package.json.bak-local-install-*` 备份。

### 升级边界

- `develop` 分支上的工单与 6 个闸门只作用于 `~/.dsh/superagent/worktrees/` 下的工作树；合并进 `develop`
  不会更新本机安装目录，也不会改变正在运行的插件。
- 只有显式安装新 tarball 并重载插件，运行态才会更新；release 合并到 `main` 后仍要手动打包安装一次。
- 回滚：保留 profile 的 `package.json.bak-local-install-*` 与旧 tarball。回滚时把备份覆盖回
  `$PROFILE/package.json`，再把旧 tarball 按步骤 4 解包回包目录，最后重载插件。

## 隔离实例验证（`scripts/isolated-verify.mjs`）

`render` 闸门用 jsdom 在共享 `/tmp/sa-harness` 里跑，依赖真实状态目录时会抖动；`isolated` 闸门改为起一个一次性的
DSH：临时 `DSH_HOME`（其中的一次性 profile 以 `link:` 装入本工作树的面板代码，**只用于该闸门，不是本机安装态**）
+ 临时 `DSH_SUPERAGENT_STATE_DIR` + 随机端口，用 Chrome headless 通过 CDP 打开 UI，断言侧栏「超级智能体」入口、
面板页签与空状态，并检查 console 无错误；截图写到 `verification/`（gitignore）。可单独运行：
`node scripts/isolated-verify.mjs`，默认清理临时目录，`--keep` 保留现场。

## 常见坑

- **merge commit 与 ancestry**：合并到 `develop` 请用 merge commit，不要 squash 或 rebase（fast-forward 可以）。
  面板用 `git merge-base --is-ancestor` 判断提交是否已进入 `develop`；squash/rebase 会重写 commit，ancestry 判定不到，
  工单会一直停在 `mr-open`。
- **GitHub 免费私库没有分支保护**：分支纪律靠约定：交付走 PR、不直接推 `main`/`develop`。
- **desktop profile 由 Electron 管理**：桌面 DSH 是 Electron 应用，`desktop` profile 的插件与依赖由应用内的
  Plugin Manager（`~/.dsh/profiles/desktop`）维护。当前安装态是 `file:<tarball>` + 实体包目录，不要改回开发
  工作树的 `link:`；升级用 `scripts/local-install.mjs`（或上面的手工步骤）显式安装新 tarball，再在
  Plugin Manager 里重载插件并刷新页面。否则会被应用升级或下一次 Plugin Manager 操作覆盖，运行态仍是旧代码。
