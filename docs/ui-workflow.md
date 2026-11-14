# UI 改动流程

本文件是面板 UI 改动的执行流程，非安装必读；安装与面板概览见 [README](../README.md)，逐页说明见 [pages.md](pages.md)。

面板是**裸 DOM（`h = React.createElement`，无 JSX）+ 手写 CSS + token 契约**的组合，样式集中在
`client/src/style.js`，规范写在 `spec/panel-ui.md`。通用前端 skill 默认的 React/Tailwind/组件库假设在这里都不成立，
所以 UI 改动固定走「设计判断 → 落地 → 规则审查 → 真机回归」四段，每段只由一个角色主导。

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

1. **取上下文**：`impeccable context`。`DESIGN.md`（根目录）是视觉契约的唯一起点，`spec/panel-ui.md` 是它的来源与细则；
   两者冲突时以代码里实际生效的 token 为准，并回头改文档。
2. **先规划再动手**：`/impeccable shape <这一屏>`，只出方案（结构、层级、状态、空/错/加载），不写代码。
3. **编辑**：`/impeccable polish|layout|typeset|adapt <目标>`。编辑前读 `reference/craft-floor.md`；
   涉及每个可点元素的反馈、焦点、密度的判断以它为准。
4. **审查**：`/web-design-guidelines dsh-superagent-panel/client/src/**` → 合并去重后按 `file:line` 落进
   `verification/ui-review-team.md`（分级 P1/P2/P3，标「可机器验证」与否）。
5. **回归**：跑完下面的闸门，再在隔离实例里真机点一遍（见末节）。

一次改动只覆盖一层：要么是方向/结构（第 2–3 步），要么是规则符合性（第 4 步）。两件事混在一轮里，改出来的东西通常两头都不合格。

## 硬约束

写进每一次 prompt，不要让模型自己判断：

- **token 白名单**：只用手上已有的 `--sa-*`（`--sa-fs-*` / `--sa-sp-*` / `--sa-r-*`）与 `--dsw-alias-*`。
  新颜色、新字号、新间距一律不加；确实缺的变量先补进 `style.js` 头部并在 PR 说明。
- **裸 DOM**：不引入 JSX、React 组件库、Tailwind、CSS-in-JS；组件就是函数返回 `h(...)`。
- **产物不手改**：`client/index.js` 是构建产物，只能由 `node scripts/build-client.mjs` 生成。
- **i18n 不抢写**：新增文案放进各片段自己的 `Object.assign(PAGE_TEXT, {…})` 块，不要改 `i18n.js` 的共享表；
  `check-keys.mjs` 会拦住缺 key 的调用。
- **信息架构不动**：这一轮的边界写在 prompt 里（改哪些文件、不动哪些页），否则 `impeccable` 会顺手重排导航。

## 闸门

```bash
node --check index.js
node scripts/build-client.mjs --check     # 产物是否与 src 同步
node scripts/check-keys.mjs               # i18n key 完整性
npm run types                             # types/dsh.d.ts 自身能否通过 tsc
npm run check:js                          # checkJs 已清零的那一档（tsconfig.check.json）
node --test lib/store.test.js lib/live/*.test.js
node scripts/render-check.mjs             # jsdom 全页回归（devDependencies 里的 jsdom + React）
```

`render-check` 依赖仓库 `devDependencies` 里的 jsdom + React：干净 clone 先 `npm ci`，缺依赖时脚本会报错并以 2 退出。
它断言的是**用户可见行为**，所以 UI 语义变化（把假链接换成真 `<button>`、把通用「确定」换成动作级文案）通常需要同步更新
`scripts/render-check.mjs` 的期望——那是测试对齐，不是回归。

## 真机点检

闸门只覆盖能静态断言的项。焦点顺序、读屏播报、对比度、真实交互仍要在浏览器里点一遍：

- 桌面版没有可用调试端口时，用临时 `DSH_HOME` + 独立 profile + `plugin add <本仓库>`（link）起一个隔离实例，
  状态目录用 `~/.dsh/superagent` 的副本并设 `live.json` 的 `enabled:false`，避免和正在用的实例抢消息。
- 路径至少覆盖：概览 → 六页切换 → 打开一张工单 → 详情子页 → ⋯ 菜单 → 分段筛选 → 设置页开关与输入框 → Escape。
- 结论（通过项、发现项、未验证项）追加到 `verification/ui-review-team.md`。

## 常见误用

- **让审查器改代码**：它会给出合理的规则，但不了解这一屏的取舍，改完往往要回退。
- **不给 token 白名单**：审查器不知道 `--dsw-alias-*` 是什么，会建议引入一套新变量。
- **照抄规则里的 React 写法**：`aria-*` 要落到真实 DOM 属性上，`<label>` 只能包 phrasing content（`<p>` 不行）。
- **把审查清单当待办全做**：P3 里有一批是「按设计不改」，理由要写进文档，不要为了清零硬改。

## 模板 prompt

设计轮：

```text
/impeccable 给 dsh-superagent-panel 的「执行」页做一次 polish。
- 模式：Operate（app UI，scanability 优先，克制）
- 目标：client/src/execution.js + client/src/style.js；不要动 i18n.js / client/index.js
- 上下文：先跑 impeccable context，以 DESIGN.md 的 token 与 Named Rules 为准；不新建刻度
- 编辑前先读 reference/craft-floor.md；这是裸 DOM（h = React.createElement），不要引入 JSX/Tailwind
- 硬约束：只用手上已有的 --sa-* 与 --dsw-alias-* token；不许新增颜色，不许改信息架构
- 验收：node scripts/build-client.mjs && node scripts/check-keys.mjs && node --test lib/store.test.js lib/live/*.test.js
- 做完把改动点写进 verification/ui-review-team.md，每条注明可机器验证的方式
```

审查轮：

```text
/web-design-guidelines dsh-superagent-panel/client/src/execution.js dsh-superagent-panel/client/src/style.js
只报问题不改文件；按 file:line 输出，P1/P2/P3 分级。
注意：规则里的 React/Tailwind 条款要翻译成裸 DOM 等价物；行号必须 grep 核实。
```
