# 交付与发布（GitHub）

本仓库的分支模型是 GitFlow：`main` 只放发布（打 tag），`develop` 是集成分支，工单/改动的交付分支是
`feature/<name>` 并合入 `develop`。

## 交付桥

执行器（或人）把 `feature/<name>` 推到 GitHub 后，`.github/workflows/auto-pr.yml` 按分支前缀自动开 PR：

| 分支前缀 | 目标 |
| --- | --- |
| `feature/**` | `develop` |
| `fix/**` | `develop` |
| `chore/**` | `develop` |
| `docs/**` | `develop` |
| `release/**` | `main` |
| `hotfix/**` | `main` |

由 Actions 开的 PR 不能被同一个 token 合并，必须由人评审后合并。

- 对 github.com 推送**不要带 GitLab push options**（`-o merge_request.*`）：GitHub 忽略它们，且实测带 options
  的推送会被服务端以 `no voting servers succeeded` 拒绝。
- 合并请用 **merge commit**（或 fast-forward），不要 squash：面板用
  `git merge-base --is-ancestor <commit> origin/<baseBranch>` 判断改动是否已进集成分支。
- `live.json` 里本仓库的仓库项用 `verifyMode: "manual"`、`createMr: "push"`、`ci: false`——闸门由执行器在本地跑，
  不需要远端 CI 通过后才允许开 PR；但 PR 合并前 CI（`.github/workflows/ci.yml`）必须是绿的。

## 面板侧的工单状态

工单推送后先到 `mr-open`（PR 链接从推送输出解析），PR 合并进 `develop` 后自动转 `merged`，再由人验收。

## 发布（维护者）

`develop` → `main` 的 PR 合并（merge commit）后打 tag `vX.Y.Z`，把本机安装用的 tarball 附到 Release。
本机桌面 profile 只认 `main` 的打包产物：`scripts/local-install.mjs` 显式安装新 tarball 后在面板里重载插件。
不要直接向 `main`/`develop` 推改动（bootstrap 例外由维护者执行）。
