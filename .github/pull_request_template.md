## 这个 PR 做了什么

<!-- 一段话：改了什么、为什么改。关联 issue 用 `Closes #123`。 -->

## 类型

- [ ] feat（新能力）
- [ ] fix（修 bug）
- [ ] docs / test / chore

## 验证

```bash
node --check index.js
node scripts/build-client.mjs --check
node scripts/check-keys.mjs
node --test lib/store.test.js lib/live/*.test.js
node scripts/render-check.mjs
```

- [ ] 以上六条全绿（贴关键输出或数字）
- [ ] 改了 `client/src` 时已运行 `node scripts/build-client.mjs`，产物与源码同一次提交
- [ ] 改了可见行为时补了测试（`lib/live/*.test.js` 或 `scripts/render-check.mjs` 断言）
- [ ] 新增文案同时给了 `zh-CN` 与 `en`
- [ ] `CHANGELOG.md` 顶部加了本节，`package.json` 升了 patch

## 界面改动（如有）

<!-- 前后截图，或说明在哪一页、什么状态、浅色/深色下都看过。 -->
