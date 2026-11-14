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

`client/src` 是一组真正的 ES 模块，入口是 `client/src/index.js`：它按"基础 → 外壳 → 页面"的顺序
`import` 每一条模块，把 `{ inject, apply }` 从 `apply.js` 再导出。模块之间用显式的 `import { … } from './xx-name.js'` 互相引用，
不再依赖"所有声明共享一个工厂作用域"——**新增文件请同时加到 `index.js` 的 import 列表里**。

React 与 `h` 不来自全局：`client/src/react.js` 把宿主提供的 `react` 收敛成一张导出表
（`React`、`h` 与常用 hooks），每个模块从它 `import` 自己需要的名字。JSX 通过 `jsxFactory: 'h'` 编译，
所以 JSX 和手写 `h(...)` 都指向同一个 `h` 绑定。

`client/index.js` 是构建产物且**必须提交**——CI 用 `node scripts/build-client.mjs --check` 逐字节校验
（`client/index.js` 与 `client/index.js.map` 两个文件）。构建是 esbuild **bundle**（`format: 'cjs'`，
`react` 保持 external，`require('react')` 仍是 loader 调用），外面包一层
`window.__ModuleLoader__.load({ id, factory(require) { … } })` 的工厂，契约与 P3 之前完全一致。

esbuild 版本在 `devDependencies` 里**精确锁定**——换版本会改变压缩后的字节，属于一次需要重新生成产物的显式改动，
请在同一个提交里说明并重跑 `--check`。

`scripts/check-keys.mjs` 与 `scripts/render-check.mjs` 通过 `scripts/client-exports.mjs` 用同一套 esbuild 参数
打包一份虚拟入口，再取出 `App`、`DICTS`、`PANEL_CSS` 之类的内部名字来验证；改了模块导出名要同步这两个脚本。

## 改动前必跑的闸门

```bash
node --check index.js                              # Host 语法
node scripts/build-client.mjs                      # 改了 client/src 就先重建产物
node scripts/build-client.mjs --check              # 产物是否最新（CI 强制）
node scripts/check-keys.mjs                        # 中英文 key 覆盖
npm run types                                      # types/dsh.d.ts 自身能否通过 tsc
npm run check:js                                   # checkJs 已清零的那一档（清单在 tsconfig.check.json）
node --test lib/live/*.test.js   # Host 测试（全量）
node scripts/render-check.mjs                      # jsdom 渲染回归（194 条；无 live.json 时自动用 test/fixtures）
```

CI 在干净 clone 上跑的就是这八条。`npm run check:js` 用的是「分档清单」：`tsconfig.check.json` 的 `files`
列出已经补完 JSDoc 的文件。从 0.9.12 起这一档**覆盖全部代码**：Host 半（`index.js` + `lib/`）与客户端入口
`client/src/index.js`（它 import 进来的每个片段都会被检查）。修好一个新文件就加进去，
**不要为了让 CI 变绿把文件移出去**。`scripts/isolated-verify.mjs` 与 `scripts/verify-panel.mjs` 需要本机桌面
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
