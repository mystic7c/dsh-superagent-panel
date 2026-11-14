# UI 改动流程

本文件是面板 UI 改动的执行流程，非安装必读；安装与面板概览见 [README](../README.md)，逐页说明见 [pages.md](pages.md)，
视觉契约见 [DESIGN.md](../DESIGN.md)。

面板的客户端是**真正的 ES 模块 + JSX**：每个文件 `import { React, h } from "./react.js"`，JSX 由 `jsxFactory: 'h'`
编译成 `h(...)`，`scripts/build-client.mjs` 用 esbuild 从 `client/src/index.js` 起 bundle 成单个 `client/index.js`
（宿主只认 `window.__ModuleLoader__.load(...)` 这一个产物，见 README 的「给贡献者」一节）。样式是 `client/src/style.js`
里的一段模板字符串，配色全部来自宿主的 `--dsw-alias-*`。通用前端 skill 默认的 Tailwind / 组件库 / CSS Modules 假设在这里
都不成立，所以 UI 改动固定走「设计判断 → 落地 → 规则审查 → 真机回归」四段，每段只由一个角色主导。

## 模块地图

| 文件 | 职责 |
| --- | --- |
| `client/src/react.js` | 唯一导出 `React` 与 `h` 的地方；所有模块都从这里拿 |
| `client/src/controls.js` | 原子控件：按钮、输入框、开关、分段控件、菜单、弹窗、复制按钮 |
| `client/src/widgets.js` | 组合件：区块、键值表、空态/错误态、骨架、保存条、Markdown 渲染、术语弹层 |
| `client/src/style.js` | 全部 CSS（一个模板字符串）+ `Panel` 样式注入 |
| `client/src/shell.js` | 外壳：页头、六个页签、面包屑、错误边界 |
| `client/src/live-ui.js` / `live-model.js` | 工单列表、运行行、引擎动作（`useEngineActions`） |
| `client/src/overview.js` `source.js` `trigger.js` `eval.js` `execution.js` `ticket-detail.js` `thread-detail.js` `settings.js` `setup.js` | 各页面 |
| `client/src/apply.js` | 入口：注册侧栏图标、`main` 槽位、locale |

## 两个技能，两种角色

| 技能 | 角色 | 负责 | 不负责 |
| --- | --- | --- | --- |
| `impeccable` | 设计判断 + 落地编辑 | 这一屏该长什么样、怎么改代码、信息层级/排版/密度/状态 | 逐条规则符合性 |
| `web-design-guidelines` | 审查闸门 | 按 Web Interface Guidelines 出 `file:line` 清单 | 改文件、定方向 |

用 `impeccable` 时**显式选 `Operate` 模式**（app UI、dashboard、settings）。它的 `Persuade`/`Experience` 模式是营销页与
叙事页的思路（大图、留白、一屏一主题），与本面板的密度要求相反。

`web-design-guidelines` 只读不改。它的输出是问题清单，**是否修改、怎么修改仍由 `impeccable` 那一轮决定**——
否则同一处会收到两条互相矛盾的指令（典型：审查说「不要只用 `title` 传信息」，编辑轮又说「这里用 `title` 最省空间」）。

## 流水线

1. **取上下文**：`impeccable context`。`DESIGN.md` 是视觉契约的唯一起点；`docs/pages.md` 描述每页的信息架构。
   两者与代码冲突时，以 `client/src/style.js` 里实际生效的 token 为准，并回头改文档。
2. **先规划再动手**：`/impeccable shape <这一屏>`，只出方案（结构、层级、状态、空/错/加载），不写代码。
3. **编辑**：`/impeccable polish|layout|typeset|adapt <目标>`。编辑前读 `reference/craft-floor.md`；
   涉及每个可点元素的反馈、焦点、密度的判断以它为准。
4. **审查**：`/web-design-guidelines client/src/**` → 合并去重后按 `file:line` 落进
   `verification/ui-review-team.md`（分级 P1/P2/P3，标「可机器验证」与否）。
5. **回归**：跑完下面的闸门，再在 dev 实例里真机点一遍（见末节）。

一次改动只覆盖一层：要么是方向/结构（第 2–3 步），要么是规则符合性（第 4 步）。两件事混在一轮里，改出来的东西通常两头都不合格。

## 硬约束

写进每一次 prompt，不要让模型自己判断：

- **token 白名单**：只用手上已有的 `--sa-*`（`--sa-fs-*` / `--sa-sp-*` / `--sa-r-*`）与 `--dsw-alias-*`。
  新颜色、新字号、新间距一律不加；确实缺的变量先补进 `client/src/style.js` 头部的 token 块并在 PR 说明。
- **JSX 优先，`h()` 兼容**：两者编译结果相同（`jsxFactory: 'h'`），新代码写 JSX；只有动态标签（`const Heading = \`h${level}\``）
  或需要绕过类型的地方才用 `h(...)`。
- **只从 `./react.js` 拿 React**：不要在页面里 `import React from 'react'`，也不要 import 任何 `@deepseek-ai/*` 包
  （宿主会注入 React，但第三方包会随版本漂移）。
- **产物不手改**：`client/index.js` 是构建产物，只能由 `node scripts/build-client.mjs` 生成。
- **类型是闸门的一部分**：新增/改动组件的 props 要写 `@param` JSDoc，否则 `npm run check:js` 会报错——它就是 `tsc` 在
  `client/src/index.js` 的整条 import 链上跑（见 `tsconfig.check.json`）。
- **i18n 不抢写**：新增文案放进各模块自己的 `Object.assign(PAGE_TEXT, {…})` 块，不要改 `i18n.js` 的共享表；
  `check-keys.mjs` 会拦住缺 key 的调用。
- **信息架构不动**：这一轮的边界写在 prompt 里（改哪些文件、不动哪些页），否则 `impeccable` 会顺手重排导航。

## 闸门

```bash
npm ci                                    # 干净 clone 先装 devDependencies
node --check index.js                     # Host 半语法
node scripts/build-client.mjs --check     # 产物是否与 src 同步（逐字节）
node scripts/check-keys.mjs               # i18n key 完整性
npm run types                             # types/dsh.d.ts 自身能否通过 tsc
npm run check:js                          # tsc checkJs：Host 半 + 客户端整条 import 链
node --test lib/live/*.test.js            # Host 半测试
node scripts/render-check.mjs             # jsdom 全页回归（198 项）
node scripts/isolated-verify.mjs          # 真机：起隔离 DSH + Chrome，开面板
```

前七条在干净 clone 与 CI 上都会跑（Node 22 / 24 两档）；`isolated-verify` 需要本机有 DSH 与 Chrome。

`render-check` 断言的是**用户可见行为**，所以 UI 语义变化（把假链接换成真 `<button>`、把通用「确定」换成动作级文案）通常
需要同步更新 `scripts/render-check.mjs` 的期望——那是测试对齐，不是回归。`check:js` 报错同理：多数是缺 `@param`，
不是逻辑错。

## 真机点检

闸门只覆盖能静态断言的项。焦点顺序、读屏播报、对比度、真实交互仍要在浏览器里点一遍：

- 用 dev profile 起一个边改边看的实例：`npm run dev`（等价于 `dsh --profile dev --no-open --port 0`），它会打印带
  `?token=` 的地址；`dev` profile 的依赖是 `link:` 到本仓库，所以改完 `node scripts/build-client.mjs` 刷新页面即可，
  Host 半改动需要重启该实例。**不要**把仓库目录 `add` 进 `desktop` profile（那条路跑的是发布产物，见 AGENTS.md）。
- 状态目录用独立的临时目录（`DSH_SUPERAGENT_STATE_DIR=/tmp/…`）或 `~/.dsh/superagent` 的副本，并让 `live.json` 的
  `enabled:false`，避免和正在用的实例抢消息。
- 路径至少覆盖：概览 → 六页切换 → 打开一张工单 → 详情子页 → ⋯ 菜单 → 分段筛选 → 设置页开关与输入框 → Escape。
- 结论（通过项、发现项、未验证项）追加到 `verification/ui-review-team.md`。

## 常见误用

- **让审查器改代码**：它会给出合理的规则，但不了解这一屏的取舍，改完往往要回退。
- **不给 token 白名单**：审查器不知道 `--dsw-alias-*` 是什么，会建议引入一套新变量。
- **绕开 `./react.js`**：直接 `import React from 'react'` 会在 bundle 里多出一份 React，面板的 context（`PanelState`）
  与宿主那份不是同一个，报错形如 `Superagent panel rendered outside its provider`。
- **把审查清单当待办全做**：P3 里有一批是「按设计不改」，理由要写进文档，不要为了清零硬改。

## 模板 prompt

设计轮：

```text
/impeccable 给 dsh-superagent-panel 的「执行」页做一次 polish。
- 模式：Operate（app UI，scanability 优先，克制）
- 目标：client/src/execution.js + client/src/live-ui.js + client/src/style.js；不要动 i18n.js / client/index.js
- 上下文：先跑 impeccable context，以 DESIGN.md 的 token 与 Named Rules 为准；不新建刻度
- 编辑前先读 reference/craft-floor.md；客户端是 ES 模块 + JSX（jsxFactory: h），React 只从 ./react.js 引入
- 硬约束：只用手上已有的 --sa-* 与 --dsw-alias-* token；不许新增颜色，不许改信息架构
- 验收：npm run check:js && node scripts/build-client.mjs && node scripts/check-keys.mjs && node scripts/render-check.mjs
- 做完把改动点写进 verification/ui-review-team.md，每条注明可机器验证的方式
```

审查轮：

```text
/web-design-guidelines client/src/execution.js client/src/live-ui.js client/src/style.js
只报问题不改文件；按 file:line 输出，P1/P2/P3 分级。
注意：规则里的 Tailwind/组件库条款要翻译成这块面板的 token + 原生 DOM 等价物；行号必须 grep 核实。
```
