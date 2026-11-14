---
name: SuperAgent Panel
description: DSH 里的工作台面板——密度优先、平面为主、状态靠语义色与文字
colors:
  brand-primary: "var(--dsw-alias-brand-primary)"
  primary-foreground: "var(--dsw-alias-label-primary-foreground)"
  surface-base: "var(--dsw-alias-bg-base)"
  surface-layer-1: "var(--dsw-alias-bg-layer-1)"
  surface-layer-2: "var(--dsw-alias-bg-layer-2)"
  surface-overlay: "var(--dsw-alias-bg-overlay)"
  surface-raised: "var(--sa-surface-raised)"
  border-line: "var(--dsw-alias-border-l2)"
  text-primary: "var(--dsw-alias-label-primary)"
  text-secondary: "var(--dsw-alias-label-secondary)"
  text-tertiary: "var(--dsw-alias-label-tertiary)"
  text-tertiary-aa: "var(--sa-label-tertiary)"
  link-text: "var(--sa-link-text)"
  danger-text: "var(--sa-danger-text)"
  warn-text: "var(--sa-warn-text)"
  success-text: "var(--sa-success-text)"
  info-text: "var(--sa-info-text)"
typography:
  page:
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.4
  title:
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
  body:
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  meta:
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.4
  caption:
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  mono:
    fontFamily: "Menlo, monospace"
    fontSize: "12px"
    lineHeight: 1.4
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  pill: "999px"
spacing:
  "2": "2px"
  "4": "4px"
  "8": "8px"
  "12": "12px"
  "16": "16px"
  "24": "24px"
  "32": "32px"
  sticky-top: "64px"
components:
  button-primary:
    backgroundColor: "{colors.brand-primary}"
    textColor: "{colors.primary-foreground}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-outline:
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    padding: "0 12px"
    height: "32px"
  button-icon:
    textColor: "{colors.text-secondary}"
    rounded: "{rounded.md}"
    size: "28px"
  tab:
    textColor: "{colors.text-secondary}"
    height: "36px"
  input:
    backgroundColor: "{colors.surface-layer-1}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.sm}"
    height: "32px"
  row:
    rounded: "{rounded.md}"
    padding: "8px 0 10px"
  card:
    backgroundColor: "{colors.surface-layer-1}"
    rounded: "{rounded.md}"
    padding: "16px"
  badge:
    textColor: "{colors.text-tertiary-aa}"
    rounded: "{rounded.pill}"
    height: "18px"
  modal:
    backgroundColor: "{colors.surface-raised}"
    rounded: "{rounded.lg}"
    width: "560px"
---

# Design System: SuperAgent Panel

## Overview

**Creative North Star: "The Quiet Instrument Panel"**

这块面板不是一个要被浏览的页面，而是一个在值班时被反复切开看的工作台：用户一天里要点开它十几次，每次都带着一个具体问题
（这条工单卡在哪、这次运行为什么失败、这条消息该不该接单）。所以整套视觉的目标是**让答案在一瞥之内出现，并且第二次打开时
长得和第一次一模一样**。表达欲全部收进细节：0.5px 的描边、对齐的数字、只在对的时候出现的焦点环。

面板不拥有自己的品牌色，它运行在 DSH 宿主主题里，颜色、字体、浮层背景全部来自 `--dsw-alias-*`。这套设计系统的职责不是
定义颜色，而是**约束怎么用**：哪一层用哪一档、什么情况下才允许出现阴影、小字号文本必须抬到哪个对比度。

实现形态：客户端是 ES 模块 + JSX（`jsxFactory: 'h'`，React 只从 `client/src/react.js` 引入），由 esbuild 从
`client/src/index.js` bundle 成单一 `client/index.js`；样式是 `client/src/style.js` 里的一段模板字符串，没有 Tailwind、
CSS Modules 或组件库。token 定义在 `.sa-page` / `.sa-main` / `.sa-toast` 上，靠继承生效。

**Key Characteristics:**
- 密度优先：正文 13px、行高 1.5，一屏能读完的东西不折行、不换页。
- 平面为主：卡片、行、输入框一律无阴影，阴影只属于浮层。
- 一条描边：所有边框都是 `0.5px solid var(--sa-line)`。
- 语义色只出现在状态上，不作装饰。
- 数字一律 `tabular-nums`，时间线、计数、百分比上下对齐。

## Colors

调性：**冷、低饱和、靠层次而不是靠色相区分区域**。品牌色是唯一的高饱和入口。

### Primary
- **Harness Brand Blue**（`var(--dsw-alias-brand-primary)`）：主操作按钮填充、当前页签的下划线、焦点环的兜底色、选中态指示。
  它通常是全屏唯一的彩色块。

### Neutral
- **Panel Base**（`var(--dsw-alias-bg-base)`）：页面底色。顶栏与详情导航条也用它与滚动内容"融"在一起。
- **Layer 1**（`var(--dsw-alias-bg-layer-1)`）：输入框、卡片、代码块的底。比 Base 高一层，用来分隔"内容块"。
- **Layer 2**（`var(--dsw-alias-bg-layer-2)`）：hover 底、分段控件的槽底。
- **Raised**（`--sa-surface-raised` = `var(--dsw-alias-bg-layer-3)`）：菜单与弹窗的底。这一层才有阴影。
- **Overlay**（`var(--dsw-alias-bg-overlay)`）：叠加用的薄染层，**不是**浮层表面。深色主题下它解析成 `bluish-700`，二次文本只有 3.85:1，所以不许拿来当菜单或弹窗的底。
- **Line**（`var(--dsw-alias-border-l2)`，以 `--sa-line` 暴露）：唯一描边色，永远 0.5px。
- **Label Primary / Secondary / Tertiary**：正文 / 次要说明 / 元信息三档文字。

### 抬升的文本色（AA）
宿主主题的 tertiary 与 link 在浅色底上只有 3.71:1 / 4.23:1，达不到 AA。面板在小字号处一律用下面这组 `color-mix` 变体：

- **Raised Tertiary**（`--sa-label-tertiary`，tertiary 76% + primary）：元信息、计数、时间戳、次要标签。
- **Raised Link**（`--sa-link-text`，link 82% + primary）：正文内链接。
- **Raised Danger / Warn / Success / Info**（`--sa-*-text`）：状态**文字**。状态**形状**（圆点、进度条段、图标）仍用原始
  `--dsw-alias-state-*`，因为描边和填充的对比度门槛不同。

### Named Rules
**The One Border Rule.** 任何边框只有一种写法：`0.5px solid var(--sa-line)`。不新增边框色，不用 1px 表达分隔。

**The Raised Text Rule.** 11–12px 的文本不许直接用 tertiary / link / state 原值，必须用对应的 `--sa-*` 抬升变体；形状与填充不受此限。

**The One Accent Rule.** 品牌色只用于：主操作、当前选中、焦点环。屏幕上同时出现的品牌色块不超过一个。

## Typography

**Body Font:** 继承宿主（`font-family: inherit`）
**Mono:** `var(--ds-font-family-code, Menlo, monospace)`

**Character:** 只有一套 sans，靠字号、字重和颜色分层，不靠字族对比。等宽只用于 ID、commit、diff、路径——它们是"要照抄的东西"。

### Hierarchy
- **Page**（600，20px / 1.4）：面板页标题「超级智能体」，每页一个。
- **Title**（600，15px / 1.35）：区块标题、工单标题、卡片标题。
- **Body**（400，13px / 1.5）：正文与表格内容。这是默认档，其余四档都是相对它的例外。
- **Meta**（400，12px / 1.4）：次要说明、字段值、按钮小号、时间戳。
- **Caption**（400，11px / 1.4）：徽标、计数、极短的标签。低于 11px 不存在。

### Named Rules
**The Scale-Only Rule.** 只有 11 / 12 / 13 / 15 / 20 五档字号。介于两者之间的值属于控件高度或边框宽度，不属于文字。

**The Tabular Rule.** 任何会纵向对齐的数字（计数、时长、百分比、时间线、diff 行号）加 `font-variant-numeric: tabular-nums`；
正文段落（`.sa-md`）不继承这组规则，保持默认数字宽度。

**The Two-Weight Rule.** 字重只用 400 / 500 / 600。600 表示"这是标题或当前项"，500 表示"这是可点的"，400 是其余。

## Layout

- **容器查询而不是视口断点**：面板宽度由 DSH 的侧栏与右栏决定，同一视口下可用宽度可能差 300px。布局全部挂在
  `@container` 上（480 / 560 / 600 / 640 / 700 / 760 / 860 / 900 / 960 / 1000）。
- **框架**：`.sa-column` 最大 1180px 居中，左右各 32px；顶部 chrome（标题行 + 六个页签）固定不滚，只有 `.sa-scroll` 滚动。
- **一个 sticky 偏移**：`--sa-sticky-top: 64px`，滚动留白、区块跳转的 `scroll-margin-top`、侧栏最大高度都从它派生。
- **节奏**：区块之间 24px，区块内标题与内容 8px，行内元素 4–8px。
- **密度**：列表行 `8px 0 10px`（上下留白不对称是为了让 0.5px 分隔线看起来居中）；卡片内边距 16px。

## Elevation & Depth

**平面为默认。** 卡片、列表行、输入框、页签在静止和 hover 时都没有阴影，深度靠**底色分层**（base → layer-1 → layer-2）和
一条 0.5px 描边表达。

阴影只属于浮层：菜单、弹窗、toast、tooltip 用 `var(--dsw-elevation-prominent)`；分段控件的选中块用
`var(--dsw-elevation-soft)`，分段槽本身用 `inset 0 0 0 1px var(--sa-line)` 画出内描边而不是外阴影。

### Named Rules
**The Flat-By-Default Rule.** 阴影是"这个元素浮在页面之上"的信号，不是美化手段。给卡片加阴影等于宣称它会移动。

## Shapes

- **四档圆角**：4px（按钮、页签、输入框、代码块）、8px（卡片、行、菜单、toast）、12px（弹窗）、999px（徽标、标签、分段控件）。
- **描边恒为 0.5px**：这是面板看起来"细"的主要原因，放大到 1px 会让整页变重。
- **不做斜切、不做异形**。所有容器都是矩形 + 圆角。
- **焦点环是形状的一部分**：`2px solid var(--sa-focus)`，贴边时用负偏移（`-1px` / `-2px`）让环落在容器内部，不推动布局。

## Components

### Buttons
- **Shape:** 4px 圆角（`--sa-r-sm`），高度 32px（`--sa-btn-md`）或 28px（`--sa-btn-sm`），横向 12px / 8px 内边距。
- **Primary:** 品牌色底 + `primary-foreground` 文字。一屏最多一个。
- **Outline:** 透明底 + 0.5px 描边，用于与主操作并列的次要动作。
- **Ghost:** 无底无边，hover 才出现 layer-2 底。
- **Danger:** `state-error-primary` 底，只用于不可逆动作；默认仍走 `ConfirmButton` 二次确认并给动作级文案。
- **Hover / Focus:** hover 只换底色/边框色；`:focus-visible` 一律 `outline: var(--sa-focus); outline-offset: 2px`。禁用态 `opacity: .4`。
- 变体就是四个类：`.sa-btn-primary` / `.sa-btn-outline` / `.sa-btn-ghost` / `.sa-btn-danger`，没有 theme prop。

### Tabs（页签）
- 36px 高，底部 2px 透明边；选中项文字升为 primary 并把下划线染成品牌色。页签用 `aria-selected` 而不是 CSS 类表达选中。

### Inputs / Fields
- 32px 高，0.5px 描边 + layer-1 底，4px 圆角，13px 文字。
- **Focus:** 容器 `:focus-within` 同时换品牌色边框并加 2px 焦点环（`outline-offset: -1px`），内层 `<input>` 自身 `outline: 0`。
- **Error:** 边框不变色，改为在字段下方给 `--sa-danger-text` 的说明 + `aria-invalid` + `role=alert`。

### Rows（列表行）
- 内边距 `8px 0 10px`（上下不对称是为了让 0.5px 分隔线看起来居中），行间用 0.5px 上边框（`border-top-left-radius: 0`），
  hover 整行染 layer-2。
- 整行可点由**行内真按钮**（`.sa-row-open`）实现：它 `flex: 1 1 auto` 撑满剩余宽度，点击区域就是按钮本身，不叠
  `::after` 伪元素；行内不再嵌套可交互元素。

### Cards
- layer-1 底、8px 圆角、0.5px 描边、16px 内边距、内部 12px 间距。无阴影。

### Segmented / Chips
- 槽：layer-2 底 + `inset` 内描边 + pill 圆角；选中块：base 底 + soft 阴影。
- 筛选 chip 变体：无槽无阴影，选中项用 layer-2 底加粗文字，计数用 `--sa-label-tertiary` 并保持 AA。

### Modal / Toast / Tooltip
- 弹窗：`min(560px, 100%)`、12px 圆角、raised 底、prominent 阴影、`120ms ease-out` 入场。
- Toast：底部居中、8px 圆角、`--dsw-alias-toast-label` 文字；tooltip 用 `--dsw-alias-tooltip-label`。
- 三者都带 `overscroll-behavior: contain`。

### Empty / Error states
- 空态是"教界面"的一段话 + 一个动作，不是「暂无数据」；错误态给原因 + 重试路径，且首屏失败不整块消失（骨架或带重试的错误块）。

## Do's and Don'ts

### Do:
- **Do** 所有间距从 `2 / 4 / 8 / 12 / 16 / 24 / 32` 里取，字号从 `11 / 12 / 13 / 15 / 20` 里取，圆角从 `4 / 8 / 12 / 999` 里取。
- **Do** 用 `--sa-line` 画一切分隔线，宽度 0.5px。
- **Do** 给每个可点元素配 `:focus-visible` 的 2px 焦点环，并在 hover 之外保留键盘路径。
- **Do** 用语义色表达状态，并同时给文字（不只给颜色），保证色觉障碍用户可读。
- **Do** 数字加 `tabular-nums`；时间统一用一个 `Intl.DateTimeFormat` 实例。

### Don't:
- **Don't** 给卡片、行、输入框加阴影——阴影是浮层专属信号。
- **Don't** 新增字号、间距、圆角档位，或为单个页面发明一个新变量。
- **Don't** 在 11–12px 文本上直接用 `--dsw-alias-label-tertiary` / `--dsw-alias-link`（浅色底不达 AA），用 `--sa-*` 抬升变体。
- **Don't** 用 `outline: none` 去掉焦点环；要么换成 `var(--sa-focus)`，要么连焦点一起删掉（不可聚焦）。
- **Don't** 用 emoji 或彩色图标做状态指示；状态用 `--sa-*-text` 的文字 + `state-*` 色的图形。
- **Don't** 假设深色主题已验证：浅色已按 AA 抬升，深色主题的对比度**尚未实测**，新增颜色时先按两种主题各算一次。
