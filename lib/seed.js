/**
 * Demo seed for a freshly installed panel. It tells one believable 24-hour story so every page has content:
 * two Sources, one thread per piece of work, decisions with reasons, tickets in every stage (review, answer,
 * blocked, failed, delivery, queued, idle, ended), a filtered message, an unsent reply, an evaluating thread,
 * one team Settings save, and one overridden prompt part whose built-in text changed.
 *
 * `demo: true` marks the state as seeded. Writes are real from then on; nothing in the panel pretends a seeded
 * ticket was executed by a real worker Session. Delete `<stateDir>/state.json` (or POST /superagent/api/demo/reset)
 * to start over.
 */
import { ago, id, text, reason, DAY, HOUR } from './util.js'
import { defaultPrompts, builtInBase, BUILT_IN } from './prompts.js'

const MIN = 60_000
const GH = 'github:acme/aurora-console'
const ghThread = (n) => `${GH}#${n}`
const fsThread = (n) => `feishu:om_${n}`

export function seedState() {
  const at = ago
  const overridden = `## replies\n先确认对方是否需要更多信息，再回复结论。回复最多三句：做了什么、验证了什么、需要对方做什么。`
  const prompts = defaultPrompts()
  prompts.overrides = { 'runtime/replies': { text: overridden, base: 'prompt-built-in:legacy001' } }
  const replyBase = builtInBase(BUILT_IN['runtime/replies'].text)

  /** One message record; `threads` names every thread it belongs to (the first hosts its evaluation). */
  const trigger = ({ key, source, actor, human = true, addressed, at: when, body, url, channel, filtered, disposition }) => ({
    id: id('trg'), threads: [key], source, actor, human, ...addressed ? { addressed } : {}, at: when, text: body,
    ...url ? { url } : {}, ...channel ? { channel } : {}, ...filtered ? { filtered } : {},
    ...disposition ? { disposition } : {}, meta: {},
  })

  const octocat = { source: 'github', id: 'octocat', name: text('Octocat', 'Octocat') }
  const lin = { source: 'github', id: 'lin', name: text('林书', 'Lin Shu') }
  const wang = { source: 'github', id: 'wang', name: text('王一鸣', 'Wang Yiming') }
  const bot = { source: 'github', id: 'ci-bot', name: text('CI 机器人', 'CI bot') }
  const chen = { source: 'feishu', id: 'ou_chen', name: text('陈可', 'Chen Ke') }
  const zhao = { source: 'feishu', id: 'ou_zhao', name: text('赵敏', 'Zhao Min') }

  const triggerRows = [
    // 1. Ticket waiting for a person's review.
    trigger({ key: ghThread(128), source: 'github', actor: lin, at: at(26 * HOUR), url: 'https://github.com/acme/aurora-console/issues/128',
      body: '生产环境有用户反馈：支付回调偶发重复入账。日志里同一个 callback id 被处理了两次。麻烦看一下，能否在本周修复？' }),
    trigger({ key: ghThread(128), source: 'github', actor: octocat, addressed: 'mention', at: at(25 * HOUR),
      body: '@dsh-agent 这是一次明确的修复请求：对 callback id 做去重，补充集成测试。' }),
    trigger({ key: ghThread(128), source: 'github', actor: lin, at: at(2 * HOUR),
      body: 'PR 看过了。幂等键的存储周期需要确认一下，我们有 7 天的回放窗口。' }),
    // 2. Working ticket.
    trigger({ key: ghThread(131), source: 'github', actor: wang, addressed: 'mention', at: at(4 * HOUR), url: 'https://github.com/acme/aurora-console/issues/131',
      body: '@dsh-agent 导出 CSV 时金额列和日期列错位，只有带负数的行会出现。帮忙修一下并补上回归用例。' }),
    // 3. Blocked ticket.
    trigger({ key: ghThread(133), source: 'github', actor: octocat, addressed: 'mention', at: at(9 * HOUR), url: 'https://github.com/acme/aurora-console/issues/133',
      body: '@dsh-agent 登录页 401 后会闪烁两次再跳转，复现概率约 1/20。查一下是不是 token 刷新竞态。' }),
    trigger({ key: ghThread(133), source: 'github', actor: octocat, at: at(5 * HOUR), body: '有进展吗？这周能修掉吗？' }),
    // 4. Ended ticket, merged.
    trigger({ key: ghThread(126), source: 'github', actor: wang, addressed: 'mention', at: at(23 * HOUR), url: 'https://github.com/acme/aurora-console/issues/126',
      body: '@dsh-agent 退款状态在订单详情里不同步，看下是不是缓存没失效。' }),
    trigger({ key: ghThread(126), source: 'github', actor: wang, at: at(20 * HOUR), body: '修好了，PR #127 已合并，感谢。' }),
    // 5. Waiting for a person's answer.
    trigger({ key: fsThread('5f2c1a'), source: 'feishu', actor: chen, addressed: 'mention', at: at(3 * HOUR),
      body: '上线后 smoke 有两条失败：订单导出和回调重放。要不要先回滚到上一个版本？' }),
    trigger({ key: fsThread('5f2c1a'), source: 'feishu', actor: chen, at: at(2.5 * HOUR), body: '@dsh-agent 两个失败都在 store 的 compensation 用例，麻烦确认是不是同一原因。' }),
    // 6. Idle ticket, waiting for a Trigger.
    trigger({ key: fsThread('71a4bb'), source: 'feishu', actor: zhao, addressed: 'mention', at: at(7 * HOUR),
      body: '批量导入 5 万行会超时，前端的进度条卡在 60%。需求是 10 分钟内导入 20 万行，能做的化先看一下瓶颈在哪。' }),
    // 7. Delivery failed.
    trigger({ key: ghThread(135), source: 'github', actor: lin, addressed: 'mention', at: at(70 * MIN), url: 'https://github.com/acme/aurora-console/issues/135',
      body: '@dsh-agent 帮忙把 payment 模块的日志级别从 debug 调到 info，线上日志太多了。' }),
    // 8. Failed report.
    trigger({ key: ghThread(136), source: 'github', actor: bot, human: false, at: at(11 * HOUR), url: 'https://github.com/acme/aurora-console/issues/136',
      body: 'CI failure: aurora-console / integration (payment-replay) — 2 tests failed.' }),
    // 9. Same PR as ticket 1 for context (read-only follow).
    trigger({ key: `${GH}/pull/142`, source: 'github', actor: lin, at: at(90 * MIN), url: 'https://github.com/acme/aurora-console/pull/142',
      body: 'PR #142 的 CI 通过了，幂等键 TTL 目前是 3 天，需要改成 7 天。' }),
    // 10. Evaluating thread (accepted into Eval, not yet decided).
    trigger({ key: ghThread(140), source: 'github', actor: wang, addressed: 'mention', at: at(12 * MIN), url: 'https://github.com/acme/aurora-console/issues/140',
      body: '@dsh-agent 需求：操作审计日志要能按人、按资源检索，给我们一个实现方案，先不要动代码。' }),
    // 11. Ignored candidate.
    trigger({ key: ghThread(139), source: 'github', actor: wang, at: at(6 * HOUR), url: 'https://github.com/acme/aurora-console/issues/139',
      body: '想到一个想法：把首页的 B 端入口挪到二级导航，看看会不会更清爽。' }),
    // 12. Filtered by the Source scope (bot comment, not allowed to originate work).
    { id: id('trg'), threads: [], source: 'github', actor: bot, human: false, at: at(8 * HOUR),
      text: 'chore(deps): bump react from 18.2.0 to 19.0.0 — dependabot', filtered: reason('senderNotBot'), meta: {} },
    // 13. A person outside the allow list.
    { id: id('trg'), threads: [], source: 'feishu', actor: { source: 'feishu', id: 'ou_guest', name: text('访客', 'Guest') }, human: true,
      at: at(5 * HOUR), text: '在吗？帮忙看下账单为什么多了一笔。', filtered: reason('senderNotMember'), meta: {} },
  ]

  const byThread = (key) => triggerRows.filter(row => row.threads[0] === key)
  const trg = (n, i = 0) => byThread(n)[i].id

  const decision = ({ threadKey, triggerIds, at: when, kind, reasons, strength = 'explicit', ticketId, rules, dismissed, audit }) => ({
    id: id('dec'), threadKey, triggerIds, at: when, kind, reason: reasons, strength,
    ...ticketId ? { ticketId } : {}, ...rules ? { rules } : {}, ...dismissed ? { dismissed: true } : {}, ...audit ? { audit } : {}, policyVersion: 'pol_2026_11_03_1',
  })

  const decisions = {
    dec1: decision({ threadKey: ghThread(128), triggerIds: [trg(ghThread(128), 1)], at: at(25 * HOUR), kind: 'accept',
      reasons: [reason('said', { text: '明确的修复请求：callback 去重并补测试' })], rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec2: decision({ threadKey: ghThread(131), triggerIds: [trg(ghThread(131))], at: at(4 * HOUR), kind: 'accept',
      reasons: [reason('said', { text: '导出列错位，修复并补回归用例' })], rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec3: decision({ threadKey: ghThread(133), triggerIds: [trg(ghThread(133))], at: at(9 * HOUR), kind: 'accept',
      reasons: [reason('said', { text: '排查登录页 401 闪烁' })], rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec4: decision({ threadKey: ghThread(126), triggerIds: [trg(ghThread(126))], at: at(23 * HOUR), kind: 'accept',
      reasons: [reason('said', { text: '退款状态不同步' })], rules: [{ id: 'r2', name: '缺陷修复优先' }] }),
    dec5: decision({ threadKey: fsThread('5f2c1a'), triggerIds: [trg(fsThread('5f2c1a'), 1)], at: at(2.4 * HOUR), kind: 'accept',
      reasons: [reason('said', { text: '确认 smoke 失败是否为同一原因' })], rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec6: decision({ threadKey: fsThread('71a4bb'), triggerIds: [trg(fsThread('71a4bb'))], at: at(7 * HOUR), kind: 'accept',
      reasons: [reason('said', { text: '批量导入超时，先定位瓶颈' })], rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec7: decision({ threadKey: ghThread(135), triggerIds: [trg(ghThread(135))], at: at(68 * MIN), kind: 'accept',
      reasons: [reason('said', { text: '调整 payment 模块日志级别' })], rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec8: decision({ threadKey: ghThread(136), triggerIds: [trg(ghThread(136))], at: at(10.8 * HOUR), kind: 'accept', strength: 'inferred',
      reasons: [reason('said', { text: 'CI 失败：payment-replay 集成用例' })], rules: [{ id: 'r3', name: 'CI 失败自动接手' }] }),
    dec9: decision({ threadKey: ghThread(139), triggerIds: [trg(ghThread(139))], at: at(6 * HOUR), kind: 'ignore',
      reasons: [reason('said', { text: '产品想法，不是本仓库的实现请求' })], rules: [] }),
    dec10: decision({ threadKey: ghThread(140), triggerIds: [trg(ghThread(140))], at: at(11 * MIN), kind: 'unavailable',
      reasons: [reason('timeout', {})], strength: 'explicit', rules: [{ id: 'r1', name: '明确请求直接接单' }] }),
    dec11: decision({ threadKey: ghThread(133), triggerIds: [trg(ghThread(133), 1)], at: at(4.9 * HOUR), kind: 'ignore',
      reasons: [reason('said', { text: '进度询问由工单的执行器回答，无需新工单' })], rules: [] }),
  }

  const ticket = ({
    title, createdAt, updatedAt, origin: originDecision, body, threads, inputs = [], subscriptions, assignments = [],
    attention, delivery, ends, outcome,
  }) => ({
    id: id('tkt'), title, createdAt, updatedAt,
    origin: { decisionId: originDecision.id, triggerId: originDecision.triggerIds[0], threadKey: originDecision.threadKey,
      reason: originDecision.reason, policyVersion: originDecision.policyVersion, scope: 'acme/aurora-console' },
    body, threads, subscriptions: subscriptions ?? threads, inputs, assignments,
    ...attention ? { attention } : {}, ...delivery ? { delivery } : {}, ...ends ? { ends } : {}, ...outcome ? { outcome } : {},
  })

  const t1 = ticket({ title: '支付回调重复入账：callback id 去重', createdAt: at(25 * HOUR), updatedAt: at(2 * HOUR), origin: decisions.dec1,
    body: '同一 callback id 被处理两次导致重复入账。在入账前按 callback id 做幂等去重，并补充集成测试。',
    threads: [ghThread(128), `${GH}/pull/142`],
    inputs: [
      { id: id('inp'), kind: 'trigger', triggerId: trg(ghThread(128), 2), at: at(2 * HOUR) },
      { id: id('inp'), kind: 'text', at: at(2 * HOUR), text: '评审意见：幂等键的存储周期要覆盖 7 天回放窗口。' },
    ],
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(24.5 * HOUR), endedAt: at(3 * HOUR),
      report: { state: 'ready', text: 'PR #142：按 callback id 建立唯一索引，新增 payment-replay 集成测试。CI 通过，等待评审。', at: at(3 * HOUR) } }],
    })
  const t2 = ticket({ title: '导出 CSV 金额与日期列错位', createdAt: at(4 * HOUR), updatedAt: at(6 * MIN), origin: decisions.dec2,
    body: '带负数金额的行在导出时列错位；修复格式化逻辑并补充回归用例。',
    threads: [ghThread(131)],
    assignments: [{ id: id('asg'), state: 'running', executor: 'dsh-superagent-worker', startedAt: at(20 * MIN),
      report: { state: 'progress', text: '正在补导出格式化的回归用例，预计还需一轮。', at: at(6 * MIN) } }] })
  const t3 = ticket({ title: '登录页 401 闪烁：token 刷新竞态', createdAt: at(9 * HOUR), updatedAt: at(5 * HOUR), origin: decisions.dec3,
    body: '401 后页面闪烁两次再跳转，怀疑 token 刷新与路由守卫竞态。',
    threads: [ghThread(133)],
    inputs: [{ id: id('inp'), kind: 'trigger', triggerId: trg(ghThread(133), 1), at: at(5 * HOUR) }],
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(8.5 * HOUR), endedAt: at(5 * HOUR),
      report: { state: 'blocked', text: '需要 staging 环境访问凭证才能复现 1/20 的竞态；当前环境没有该凭证。', at: at(5 * HOUR) } }] })
  const t4 = ticket({ title: '退款状态不同步（缓存未失效）', createdAt: at(23 * HOUR), updatedAt: at(20 * HOUR), origin: decisions.dec4,
    body: '退款后订单详情仍显示旧状态；失效相关缓存并补测试。',
    threads: [ghThread(126)],
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(22.5 * HOUR), endedAt: at(20.5 * HOUR),
      report: { state: 'ready', text: 'PR #127 已合并并在 staging 验证通过。', at: at(20.5 * HOUR) } }],
    ends: { at: at(20 * HOUR), by: 'agent', outcome: 'merged' } })
  const t5 = ticket({ title: '上线后 smoke 失败：补偿用例确认', createdAt: at(2.4 * HOUR), updatedAt: at(2.2 * HOUR), origin: decisions.dec5,
    body: '两条 smoke 失败都在 store 的 compensation 用例，确认是否同一原因。',
    threads: [fsThread('5f2c1a')],
    attention: { kind: 'answer', text: '两条失败可能同因，但也可能是测试数据冲突。是否先回滚？需要人决定。', at: at(2.2 * HOUR) },
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(2.3 * HOUR), endedAt: at(2.2 * HOUR),
      report: { state: 'waiting', text: '已定位到 compensation 用例的测试数据竞争；是否直接修复由人决定。', at: at(2.2 * HOUR) } }] })
  const t6 = ticket({ title: '批量导入 5 万行超时：定位瓶颈', createdAt: at(7 * HOUR), updatedAt: at(6.5 * HOUR), origin: decisions.dec6,
    body: '批量导入 5 万行超时，进度卡在 60%；先给出瓶颈定位，不直接改代码。',
    threads: [fsThread('71a4bb')],
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(6.9 * HOUR), endedAt: at(6.5 * HOUR),
      report: { state: 'waiting', text: '瓶颈在逐行 INSERT 与逐行审计写入；等待新的触发（性能方案评审）后继续。', at: at(6.5 * HOUR) } }] })
  const t7 = ticket({ title: 'payment 模块日志级别降到 info', createdAt: at(70 * MIN), updatedAt: at(65 * MIN), origin: decisions.dec7,
    body: '把 payment 模块的日志级别从 debug 调到 info。',
    threads: [ghThread(135)],
    delivery: { error: '飞书回复发送失败：机器人不在目标群（staging-告警）', attempts: 3, at: at(65 * MIN) },
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(68 * MIN), endedAt: at(66 * MIN),
      report: { state: 'ready', text: 'PR #137：日志级别调整完成，等待评审。', at: at(66 * MIN) } }] })
  const t8 = ticket({ title: 'CI 失败：payment-replay 集成用例', createdAt: at(10.8 * HOUR), updatedAt: at(10.5 * HOUR), origin: decisions.dec8,
    body: 'CI 在 payment-replay 集成用例失败 2 条，需要定位并修复。',
    threads: [ghThread(136)],
    assignments: [{ id: id('asg'), state: 'ended', executor: 'dsh-superagent-worker', startedAt: at(10.7 * HOUR), endedAt: at(10.5 * HOUR),
      report: { state: 'failed', text: '无法连接测试数据库（sandbox-db:5432），连续 3 次失败。', at: at(10.5 * HOUR) } }] })

  // Link tickets to their originating decisions now that ids exist.
  const ticketList = [t1, t2, t3, t4, t5, t6, t7, t8]
  for (const [index, t] of ticketList.entries()) {
    [decisions.dec1, decisions.dec2, decisions.dec3, decisions.dec4, decisions.dec5, decisions.dec6, decisions.dec7, decisions.dec8][index].ticketId = t.id
  }

  const thread = ({ key, title, createdAt, lastAt, subscriptions = [], context = [], evaluating, triggerCount24h, facts, url, meta }) => ({
    key, title, createdAt, lastAt, subscriptions, ...context.length ? { context } : {},
    ...evaluating ? { evaluating: { id: id('evl'), triggerIds: [trg(key)], startedAt: ago(10 * MIN), deadline: new Date(Date.now() + 20 * MIN).toISOString() } } : {},
    triggerCount24h, facts, ...url ? { url } : {}, meta: meta ?? {},
  })
  const fact = (label, value, problem) => ({ label: text(label, label === 'Issue' ? 'Issue' : label), value: text(value, value), ...problem ? { problem: true } : {} })

  const threads = {
    [ghThread(128)]: thread({ key: ghThread(128), title: '支付回调重复入账（Issue #128）', createdAt: at(26 * HOUR), lastAt: at(2 * HOUR),
      subscriptions: [t1.id], triggerCount24h: 3, url: 'https://github.com/acme/aurora-console/issues/128',
      facts: { issue: fact('Issue', '#128'), state: fact('状态', '开放'), ci: fact('CI', '通过') } }),
    [ghThread(131)]: thread({ key: ghThread(131), title: 'CSV 导出列错位（Issue #131）', createdAt: at(4 * HOUR), lastAt: at(4 * HOUR),
      subscriptions: [t2.id], triggerCount24h: 1, url: 'https://github.com/acme/aurora-console/issues/131',
      facts: { issue: fact('Issue', '#131'), state: fact('状态', '开放') } }),
    [ghThread(133)]: thread({ key: ghThread(133), title: '登录页 401 闪烁（Issue #133）', createdAt: at(9 * HOUR), lastAt: at(5 * HOUR),
      subscriptions: [t3.id], triggerCount24h: 2, url: 'https://github.com/acme/aurora-console/issues/133',
      facts: { issue: fact('Issue', '#133'), state: fact('状态', '阻塞'), repro: fact('复现率', '1/20', true) } }),
    [ghThread(126)]: thread({ key: ghThread(126), title: '退款状态不同步（Issue #126）', createdAt: at(23 * HOUR), lastAt: at(20 * HOUR),
      subscriptions: [], triggerCount24h: 2, url: 'https://github.com/acme/aurora-console/issues/126',
      facts: { issue: fact('Issue', '#126'), pr: fact('PR', '#127 已合并') } }),
    [`${GH}/pull/142`]: thread({ key: `${GH}/pull/142`, title: 'PR #142：幂等键与集成测试', createdAt: at(21 * HOUR), lastAt: at(90 * MIN),
      subscriptions: [], context: [t1.id], triggerCount24h: 1, url: 'https://github.com/acme/aurora-console/pull/142',
      facts: { pr: fact('PR', '#142'), ci: fact('CI', '通过') } }),
    [fsThread('5f2c1a')]: thread({ key: fsThread('5f2c1a'), title: '发布群：上线后 smoke 失败', createdAt: at(3 * HOUR), lastAt: at(2.5 * HOUR),
      subscriptions: [t5.id], triggerCount24h: 2, facts: { chat: fact('会话', '发布群'), topic: fact('话题', 'smoke') } }),
    [fsThread('71a4bb')]: thread({ key: fsThread('71a4bb'), title: '需求群：批量导入超时', createdAt: at(7 * HOUR), lastAt: at(7 * HOUR),
      subscriptions: [t6.id], triggerCount24h: 1, facts: { chat: fact('会话', '需求群'), volume: fact('行数', '5 万') } }),
    [ghThread(135)]: thread({ key: ghThread(135), title: 'payment 日志级别（Issue #135）', createdAt: at(70 * MIN), lastAt: at(70 * MIN),
      subscriptions: [t7.id], triggerCount24h: 1, url: 'https://github.com/acme/aurora-console/issues/135',
      facts: { issue: fact('Issue', '#135') } }),
    [ghThread(136)]: thread({ key: ghThread(136), title: 'CI 失败：payment-replay（Issue #136）', createdAt: at(11 * HOUR), lastAt: at(11 * HOUR),
      subscriptions: [t8.id], triggerCount24h: 1, url: 'https://github.com/acme/aurora-console/issues/136',
      facts: { issue: fact('Issue', '#136'), ci: fact('CI', '失败', true) } }),
    [ghThread(140)]: thread({ key: ghThread(140), title: '审计日志检索需求（Issue #140）', createdAt: at(12 * MIN), lastAt: at(12 * MIN),
      subscriptions: [], triggerCount24h: 1, url: 'https://github.com/acme/aurora-console/issues/140',
      facts: { issue: fact('Issue', '#140'), state: fact('状态', '评估中') } }),
    [ghThread(139)]: thread({ key: ghThread(139), title: '首页 B 端入口（Issue #139）', createdAt: at(6 * HOUR), lastAt: at(6 * HOUR),
      subscriptions: [], triggerCount24h: 1, url: 'https://github.com/acme/aurora-console/issues/139',
      facts: { issue: fact('Issue', '#139') } }),
  }

  const triggers = Object.fromEntries(triggerRows.map(row => [row.id, row]))
  const sourceStats = {
    github: { received: byThread(ghThread(128)).length + byThread(ghThread(131)).length + byThread(ghThread(133)).length + byThread(ghThread(126)).length + byThread(ghThread(135)).length + byThread(ghThread(136)).length + byThread(ghThread(140)).length + byThread(ghThread(139)).length + 1, filtered: 1, lastAt: at(12 * MIN) },
    feishu: { received: byThread(fsThread('5f2c1a')).length + byThread(fsThread('71a4bb')).length, filtered: 1, lastAt: at(2.5 * HOUR) },
  }

  const sources = {
    github: {
      health: { state: 'ready', detail: '最近一次轮询 12 秒前，读取 50 条通知', at: at(12 * MIN) },
      facts: { repository: text('acme/aurora-console', 'acme/aurora-console'), agent: text('dsh-agent', 'dsh-agent'), access: text('可推送', 'push') },
      labels: { octocat: 'Octocat', lin: '林书', wang: '王一鸣', 'ci-bot': 'CI 机器人' },
      lastPollAt: at(12 * MIN),
      sync: { state: 'ready', detail: '名单已同步（4 个账号）', at: at(20 * HOUR) },
    },
    feishu: {
      health: { state: 'ready', detail: '机器人已加入 2 个群', at: at(2.5 * HOUR) },
      facts: { appId: text('cli_a1b2c3d4', 'cli_a1b2c3d4'), brand: text('feishu', 'feishu'), botId: text('ou_9f8e7d6c', 'ou_9f8e7d6c'), name: text('Aurora 助手', 'Aurora Bot') },
      labels: { ou_chen: '陈可', ou_zhao: '赵敏' },
      lastPollAt: at(2.5 * HOUR),
      sync: { state: 'ready', detail: '名单已同步（2 个账号）', at: at(20 * HOUR) },
    },
  }

  const settings = {
    paused: false,
    policy: {
      rules: [
        { id: 'r1', name: '明确请求直接接单', instruction: '来自名单成员、明确点名代理的修复或实现请求，直接接单。', enabled: true },
        { id: 'r2', name: '缺陷修复优先', instruction: '带复现步骤的生产缺陷优先于新功能。', enabled: true },
        { id: 'r3', name: 'CI 失败自动接手', instruction: '默认分支上的 CI 失败，若与本仓库代码相关则自动接手定位。', enabled: true },
        { id: 'r4', name: '需求评审', instruction: '新功能需求先产出方案，等产品确认后再动代码。', enabled: false },
      ],
      sources: {
        github: { allowed: [{ id: 'octocat', name: 'Octocat' }, { id: 'lin', name: '林书' }, { id: 'wang', name: '王一鸣' }],
          bots: [{ id: 'ci-bot', name: 'CI 机器人' }], admission: {} },
        feishu: { allowed: [{ id: 'ou_chen', name: '陈可' }, { id: 'ou_zhao', name: '赵敏' }], bots: [], admission: {} },
      },
    },
    eval: { acceptMode: 'auto', timeoutSeconds: 1800, model: { provider: 'deepseek', model: 'deepseek-chat' } },
    executor: { workerModel: { provider: 'deepseek', model: 'deepseek-chat' }, maxWorkers: 3,
      directoryRoot: '~/.dsh/superagent/worktrees', prepare: 'pnpm install --frozen-lockfile',
      blockedCommands: ['git push --force', 'rm -rf /'] },
    sources: {
      github: { enabled: true, config: { repository: 'acme/aurora-console', cli: 'gh', pollSeconds: 60, readLimit: 50,
        receive: { issues: true, pullRequests: true, comments: true, ci: false } } },
      feishu: { enabled: true, config: { cli: 'lark-cli' } },
    },
  }

  const historyEntry = (revision, atTime, block, changes) => ({ revision, savedAt: atTime, source: 'panel', block,
    policyVersion: 'pol_2026_11_03_1', policyChanged: true, notified: [] , changes })
  const settingsHistory = [
    historyEntry(3, at(3 * HOUR), 'executor', [{ code: 'maxWorkers', from: 2, to: 3 }]),
    historyEntry(2, at(20 * HOUR), 'policy', [{ code: 'ruleAdded', name: 'CI 失败自动接手' }]),
    historyEntry(1, at(2 * DAY), 'policy', [{ code: 'ruleAdded', name: '需求评审' }]),
  ]

  return {
    schemaVersion: 1,
    demo: true,
    createdAt: at(2 * DAY),
    settings,
    revisions: { global: 3, pause: 0, eval: 1, executor: 2, policy: 2, 'source:github': 1, 'source:feishu': 1, prompts: 4 },
    settingsHistory,
    prompts: {
      revision: 4,
      config: prompts,
      builtIns: { 'prompt-built-in:legacy001': `## replies\nThe research prototype's default replies text, kept so the panel can show what changed.` },
      history: [
        { revision: 4, savedAt: at(4 * HOUR), source: 'panel', config: prompts },
        { revision: 3, savedAt: at(2 * DAY), source: 'panel', config: defaultPrompts() },
      ],
      baseRevision: 4,
    },
    sources,
    threads,
    triggers,
    // Key by each Decision's own id: tickets reference that id, while the seed literal uses symbolic keys.
    decisions: Object.fromEntries(Object.values(decisions).map(item => [item.id, item])),
    tickets: Object.fromEntries(ticketList.map(item => [item.id, item])),
    ticketOrder: ticketList.map(item => item.id),
    executor: { running: 1 },
    setupCache: {
      problem: null,
      feishuProblem: null,
      accounts: { repository: 'acme/aurora-console', agent: 'dsh-agent',
        feishu: { appId: 'cli_a1b2c3d4', brand: 'feishu', botId: 'ou_9f8e7d6c', name: 'Aurora 助手' } },
      checkedAt: ago(20 * HOUR),
      dirty: false,
    },
    outgoing: [{ id: id('out'), channel: { source: 'feishu', thread: fsThread('5f2c1a'), address: { chatId: 'oc_publish' } },
      text: '已定位 smoke 失败原因，PR 待评审。', attempts: 3, error: '机器人不在目标群', at: at(50 * MIN) }],
    sourceStats,
    meta: { lastPassAt: at(12 * MIN), policyVersion: 'pol_2026_11_03_1' },
  }
}


/** A valid but empty document for live-only installs: no demo sources/threads/tickets/outgoing, no fake history. */
export function emptyState() {
  const now = new Date().toISOString()
  return {
    schemaVersion: 1,
    demo: false,
    createdAt: now,
    settings: {
      paused: false,
      policy: { rules: [], sources: {} },
      eval: { acceptMode: 'off', timeoutSeconds: 1800, model: null },
      executor: { maxWorkers: 1, directoryRoot: '~/.dsh/superagent/worktrees', prepare: 'pnpm install --frozen-lockfile',
        blockedCommands: [] },
      sources: {},
    },
    revisions: { global: 0, pause: 0, eval: 0, executor: 0, policy: 0 },
    settingsHistory: [],
    prompts: { revision: 0, config: defaultPrompts(), builtIns: {}, history: [], baseRevision: 0 },
    sources: {},
    threads: {},
    triggers: {},
    decisions: {},
    tickets: {},
    ticketOrder: [],
    executor: { running: 0 },
    setupCache: { problem: null, feishuProblem: null, accounts: {}, checkedAt: now, dirty: false },
    outgoing: [],
    sourceStats: {},
    meta: { policyVersion: 'pol_live_1' },
  }
}
