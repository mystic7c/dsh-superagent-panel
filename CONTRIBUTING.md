# Contributing

感谢你愿意改进这个面板。它是一个 DeepSeek Harness（DSH）Web 插件：Host 半跑在 DSH 进程里，Client 半是
注入 Web UI 槽位的 React 组件。下面是你动手前需要知道的全部硬约束。

## 环境

- Node.js ≥ 22（CI 跑 22 与 24）。
- 无需全局工具；依赖只有 devDependencies（jsdom + React，供渲染回归使用）：`npm ci`。

## 两条半区

| 半区 | 位置 | 生效方式 |
| --- | --- | --- |
| Host | `index.js`（`/superagent/api` 路由与动作分发）、`lib/` | 在 DSH 里禁用→启用插件（或重启 DSH）才生效 |
| Client | `client/src/*.js` → 构建出 `client/index.js` | 刷新页面即生效 |

`client/src` 按文件名的数字前缀排序后拼接进同一个工厂作用域，所以**文件名前缀是隐式的加载顺序契约**，
新增文件请沿用现有段位（`05-`、`10-`、`15-`、`20-`…）。`client/index.js` 是构建产物且**必须提交**——
CI 用 `node scripts/build-client.mjs --check` 逐字节校验。

## 改动前必跑的四道门

```bash
node --check index.js                              # Host 语法
node scripts/build-client.mjs                      # 改了 client/src 就先重建产物
node scripts/build-client.mjs --check              # 产物是否最新（CI 强制）
node scripts/check-keys.mjs                        # 中英文 key 覆盖
node --test lib/store.test.js lib/live/*.test.js   # Host 测试（全量）
node scripts/render-check.mjs                      # jsdom 渲染回归（194 条；无 live.json 时自动用 test/fixtures）
```

CI 在干净 clone 上跑的就是这六条。`scripts/isolated-verify.mjs` 与 `scripts/verify-panel.mjs` 需要本机桌面
DSH + Chrome（CDP），只在发布前由维护者人工执行。

## 代码规则

- **不要 import 任何 DSH 的客户端包**（包括 `@deepseek-ai/dsh-client-ui-primitives`）：它们不保证向后兼容，
  一个属性改动就会让整个槽位白屏（`slot entry crashed`）。需要复用的样式与交互请在我们的前缀下自己实现。
- 只渲染到槽位里：不加 iframe、不自建 app root、不向 `document.body` 追加节点、不在组件之外写 DOM。
- 颜色只允许 `--dsw-alias-*` token；不要写死十六进制色值。
- 所有文案走 locale：`locale/` 与客户端 translator 必须**同时**提供 `zh-CN` 与 `en`，`check-keys.mjs` 会拦下遗漏。
- 面板状态目录是 `~/.dsh/superagent`（可用 `DSH_SUPERAGENT_STATE_DIR` 覆盖）；测试不得写入操作者的真实状态目录。
- `spec/`、`verification/` 是本地的设计与验收材料（已 gitignore），不要提交它们的产物。

## 提交与分支

分支模型是 GitFlow：

```
feature/<name>  ──PR──>  develop   （集成分支）
release/<x.y.z> ──PR──>  main      （发布，打 tag）
hotfix/<name>   ──PR──>  main
```

- 一个 PR 只做一件事；面向 `develop` 提 PR。`main` 只接受 release/hotfix 的 PR。
- 合并请用 **merge commit**，不要 squash——面板用 `git merge-base --is-ancestor` 判断工单是否已进集成分支。
- 提交信息：`feat(0.4.x): 一句话` / `fix(0.4.x): 一句话` / `docs: …` / `test: …` / `chore: …`。
- **每个改动**都要在 `CHANGELOG.md` 顶部新增一节（最新在上），写清根因、修改点、验证数字，并把
  `package.json` 的 `version` 升一个 patch；改了 `client/src` 时 `client/index.js` 与源码同一次提交。
- 改了 Host 半或任何可见行为，必须补/改测试（`lib/live/*.test.js` 或 `scripts/render-check.mjs` 里的断言）。

## 发布（维护者）

`develop` → `main` 的 PR 合入后打 tag `vX.Y.Z`，并把本机安装用的 tarball 附到 Release。本机安装只认 `main`
的打包产物：安装新 tarball 后重载插件。

## 行为准则

参与本项目即表示你同意遵守 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。安全问题请走
[SECURITY.md](SECURITY.md)，不要开公开 issue。
