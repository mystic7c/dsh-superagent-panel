// Headless render check for the panel (no browser, no CDP).
//
// Loads the real client fragments with React + jsdom from the local harness, feeds them fixtures built from the
// real engine state (read-only: state.load() never reconciles or writes), and walks the acceptance flow:
// overview -> 去验收 -> ticket detail -> 验收通过 -> back to the desk.
//
//   node scripts/render-check.mjs
//
// It depends on /tmp/sa-harness (jsdom + react + react-dom), which the desktop image provides for verification.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const harness = join('/tmp', 'sa-harness')
const requireHarness = createRequire(join(harness, 'package.json'))
const { JSDOM } = requireHarness('jsdom')
const React = requireHarness('react')
const ReactDOM = requireHarness('react-dom/client')

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',
  { url: 'http://127.0.0.1:1/', pretendToBeVisual: true })
const { window } = dom
window.matchMedia = query => ({ matches: false, media: query, addListener() {}, removeListener() {},
  addEventListener() {}, removeEventListener() {} })
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
global.window = window
global.document = window.document
global.HTMLElement = window.HTMLElement
global.sessionStorage = window.sessionStorage
global.location = window.location
global.ResizeObserver = window.ResizeObserver
try { Object.defineProperty(global, 'navigator', { value: window.navigator, configurable: true }) } catch { /* node keeps its own */ }

// ---- fixtures from the real live state (read-only) ---------------------------------------------------------------
const { Engine } = await import('../lib/live/engine.js')
const stateDir = process.env.DSH_SUPERAGENT_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'superagent')
const engine = new Engine({ stateDir, log: () => {} })
await engine.state.load()
// Repository ids/projects come from this machine's live.json, so the checks below never assume specific
// project names; only the machine that runs the check needs them configured.
const { loadLiveConfig } = await import('../lib/live/config.js')
const { configRepos } = await import('../lib/live/repos.js')
const loadedLive = loadLiveConfig(stateDir)
const liveRepos = configRepos(loadedLive.config)
const primaryRepoId = liveRepos[0]?.id ?? 'repo-1'
const defaultRepoId = loadedLive.config.defaultRepo ?? primaryRepoId
const repoLabels = liveRepos.map(repo => repo.gitlab.project || repo.id)
const nowIso = new Date().toISOString()
if (!Object.values(engine.state.tickets).some(ticket => ticket.status === 'deployed' && !ticket.links?.acceptance)) {
  const demoId = 'tkt_demo_accept'
  engine.state.tickets[demoId] = {
    id: demoId, title: '演示：验收按钮流程',
    body: 'UC-DEMO-001：检查验收按钮把工单移出待处理。\n\nSELECT Gcc.Segment1 公司, Hou.Name 公司名称, Gjh.Period_Name 期间\nFROM Gl_Je_Headers Gjh, Gl_Je_Batches Gbh, Gl_Je_Lines Gjl\nWHERE Gjh.Je_Batch_Id = Gbh.Je_Batch_Id AND Gjh.Je_Header_Id = Gjl.Je_Header_Id;',
    status: 'deployed', repoId: primaryRepoId, createdAt: nowIso, updatedAt: nowIso, assignments: [],
    origin: { threadKey: 'octo:demo', actor: 'demo' },
    links: { branch: 'feature/tkt_demo_accept', commit: 'demo1234', worktree: '/tmp/demo',
      verification: { merged: true, changed: true, at: nowIso, uat: { ok: true, status: 200, checkedAt: nowIso } },
      mergeRequest: { iid: 1, webUrl: 'https://example.test/mr/1', state: 'merged' },
      deployment: { status: 'success', deployJob: { name: 'deploy_dev', status: 'success' } } },
  }
  engine.state.state.ticketOrder.push(demoId)
  const stepNames = ['prepare-worktree', 'worker', 'changed-paths', 'bootstrap:pnpm', 'gate:standards', 'gate:backend',
    'gate:frontend', 'commit', 'push', 'merge-request']
  const steps = stepNames.map((name, index) => ({ name,
    at: new Date(Date.now() - (10 - index) * 60_000).toISOString(), state: 'ok', exitCode: 0 }))
  engine.state.runs.unshift({ id: 'run_demo', ticketId: demoId, status: 'deployed', startedAt: nowIso, endedAt: nowIso,
    steps, worker: { text: '## 改动内容\n\n1、修复验收流程。\n2、补充演示列表。' }, changedPaths: ['demo/File.java'],
    gates: [{ name: 'standards', exitCode: 0 }] })
}
// A working Ticket makes the "in progress" desk block and header count deterministic for this check.
const demoWorkId = 'tkt_demo_running'
engine.state.tickets[demoWorkId] = {
  id: demoWorkId, title: '演示：正在执行的工单', body: 'UC-DEMO-002：检查概览是否显示执行中的工单。',
  status: 'working', repoId: primaryRepoId, createdAt: new Date(Date.now() - 8 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 60_000).toISOString(), runId: 'run_demo_working', assignments: [],
  origin: { threadKey: 'octo:demo', actor: 'demo' },
  links: { branch: 'feature/tkt_demo_running', mergeRequest: null, pipeline: null },
}
engine.state.state.ticketOrder.push(demoWorkId)
engine.state.runs.unshift({ id: 'run_demo_working', ticketId: demoWorkId, status: 'running',
  startedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
  steps: [{ name: 'prepare-worktree', state: 'ok', at: new Date(Date.now() - 5 * 60_000).toISOString() },
    { name: 'export-repo', state: 'running', at: new Date(Date.now() - 2 * 60_000).toISOString() }] })

engine.lastStatus = { phase: 'ok', mode: 'sync', at: new Date().toISOString() }
engine.started = true
// P0: the panel now reads the derived inbox; build it from the same fixture state. Saving is stubbed so this read-only
// check never writes inbox.json into the operator's real state directory.
await engine.inbox.load()
engine.inbox.save = async () => {}
await engine.refreshInbox()
const fixtures = {
  status: engine.status(),
  tickets: engine.ticketsView({}),
  threads: engine.threadsView({}),
  decisions: engine.decisionsView({}),
  inbox: engine.inboxView(),
}
const detailOf = id => engine.ticketView(id)
const threadOf = key => engine.threadView(key)

function recalcStatus() {
  const tickets = Object.values(engine.state.tickets)
  const waiting = tickets.filter(ticket => ticket.status === 'deployed' || ticket.status === 'mr-open' || ticket.status === 'ci-passed')
    .filter(ticket => ticket.links?.acceptance?.ok !== true).length
  const failed = tickets.filter(ticket => ['failed', 'ci-failed', 'deploy-failed'].includes(ticket.status)).length
  fixtures.status.counts.needsHuman = waiting + failed
  fixtures.status.load.waiting = waiting
  fixtures.tickets = engine.ticketsView({})
  fixtures.status.tickets = tickets.slice().reverse()
}

const calls = []
window.fetch = global.fetch = async (input, init = {}) => {
  const url = new URL(String(input), 'http://127.0.0.1:1')
  const method = String(init.method ?? 'GET').toUpperCase()
  calls.push(`${method} ${url.pathname}${url.search}`)
  const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
  const p = url.pathname.replace('/superagent/api/', '')
  if (method === 'GET' && p === 'engine/status') return json(fixtures.status)
  if (method === 'GET' && p === 'engine/tickets') return json(fixtures.tickets)
  if (method === 'GET' && p === 'engine/inbox') return json(fixtures.inbox)
  if (method === 'GET' && p === 'engine/signals') return json({ items: [], total: 0, counts: { all: 0, pending: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 } })
  if (method === 'GET' && p === 'engine/metrics') return json({
    window: '24h', generatedAt: new Date().toISOString(),
    runs: { total: 1, succeeded: 1, failed: 0, stopped: 0, interrupted: 0, parked: 0, running: 1, repaired: 0, repairSucceeded: 0, repairExhausted: 0 },
    duration: { avgMs: 120000, p50Ms: 120000, p95Ms: 120000, totalMs: 120000 }, triggers: { manual: 1 },
    stopReasons: { done: 1 }, failureReasons: [], byRepo: [],
    acceptance: { rounds: 0, delivered: 0, failed: 0, errored: 0, accepted: 0, rejected: 0, avgRoundsToAccept: 0 },
    signals: { total: 0, processed: 0, ignored: 0, skipped: 0, failed: 0, labels: { correct: 0, false_wake: 0, missed_wake: 0, cleared: 0 } },
    cost: { available: false, note: 'not available in this check' },
  })
  const readItem = /^engine\/inbox\/([^/]+)\/read$/.exec(p)
  if (method === 'POST' && readItem) {
    const item = fixtures.inbox.items.find(candidate => candidate.id === decodeURIComponent(readItem[1]))
    if (item) item.readAt = new Date().toISOString()
    return json({ item })
  }
  if (method === 'GET' && p.startsWith('engine/ticket/')) {
    const id = decodeURIComponent(p.slice('engine/ticket/'.length))
    return json(detailOf(id))
  }
  if (method === 'GET' && p === 'engine/threads') return json(fixtures.threads)
  if (method === 'GET' && p.startsWith('engine/thread/')) return json(threadOf(decodeURIComponent(p.slice('engine/thread/'.length))))
  if (method === 'GET' && p === 'engine/decisions') return json(fixtures.decisions)
  if (method === 'GET' && p === 'engine/search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase()
    const has = value => String(value ?? '').toLowerCase().includes(q)
    const tickets = fixtures.tickets.items.filter(ticket => has(ticket.title) || has(ticket.body)).slice(0, 6)
      .map(ticket => ({ id: ticket.id, title: ticket.title, status: ticket.status, updatedAt: ticket.updatedAt }))
    const threads = fixtures.threads.items.filter(thread => has(thread.title)).slice(0, 6)
      .map(thread => ({ key: thread.key, title: thread.title, source: thread.source, lastAt: thread.lastAt }))
    const triggers = (fixtures.status.triggers ?? []).filter(trigger => has(trigger.text)).slice(0, 8)
    return json({ query: q, tickets, threads, triggers, total: tickets.length + threads.length + triggers.length })
  }
  const accept = /^engine\/ticket\/([^/]+)\/accept$/.exec(p)
  if (method === 'POST' && accept) {
    const id = decodeURIComponent(accept[1])
    const body = init.body ? JSON.parse(String(init.body)) : {}
    const acceptance = { ok: body.ok !== false, at: new Date().toISOString() }
    engine.state.tickets[id] = { ...engine.state.tickets[id], links: { ...engine.state.tickets[id].links, acceptance } }
    recalcStatus()
    // P0: accepting settles the derived accept item; drop it from the fixture inbox as the next refresh would.
    fixtures.inbox.items = fixtures.inbox.items.filter(item => !(item.refs?.ticketId === id && item.blocking === true))
    fixtures.inbox.counts = {
      blocking: fixtures.inbox.items.filter(item => item.blocking === true).length,
      system: fixtures.inbox.items.filter(item => item.blocking !== true).length,
      unread: fixtures.inbox.items.filter(item => !item.readAt).length,
    }
    fixtures.status.inbox = { ...fixtures.inbox.counts }
    return json({ ticket: engine.state.tickets[id] })
  }
  if (method === 'POST' && p === 'engine/poll') return json({ fetched: 0, accepted: [], ignored: [], skipped: [], dryRun: true })
  return json({})
}

// ---- load the real client fragments ----------------------------------------------------------------------------
const prelude = `
const React = require('react')
const { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect, useContext, createContext, Fragment } = React
const h = React.createElement
`
const files = readdirSync(join(root, 'client', 'src')).filter(name => name.endsWith('.js') && name !== '90-apply.js').sort()
const source = files.map(name => readFileSync(join(root, 'client', 'src', name), 'utf8')).join('\n')
const factory = new Function('require', prelude + source + '\nreturn { App, translate, DICTS, PAGE_TEXT }')
const { App, translate, DICTS, PAGE_TEXT } = factory(id => {
  if (id === 'react') return React
  throw new Error(`unexpected require(${id})`)
})

const t = (key, values) => {
  const pair = PAGE_TEXT[key]
  let template = pair ? pair[0] : (DICTS.zh[key] ?? DICTS.zh[key] ?? key)
  if (values === undefined) return template
  return String(template).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match)
}
t.lang = 'zh'

const errors = []
const originalError = console.error
console.error = (...args) => { errors.push(args.map(a => a?.stack ?? String(a)).join(' ')); originalError(...args) }
window.addEventListener('error', event => errors.push(String(event.error ?? event.message)))

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const rootElement = window.document.getElementById('root')
console.log('STEP mount')
const rootDom = ReactDOM.createRoot(rootElement)
rootDom.render(React.createElement(App, { openSession: async () => {}, t }))
await sleep(900)
console.log('STEP rendered')

const text = () => rootElement.textContent
const checks = []
const check = (name, ok, detail = '') => { checks.push({ name, ok, detail }); if (!ok) console.log(`FAIL ${name} ${detail}`) }
const clickByText = (label, selector = 'button') => {
  const node = [...rootElement.querySelectorAll(selector)].find(el => (el.textContent ?? '').trim() === label)
  if (!node) return undefined
  node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  return node
}

console.log('STEP checks')
check('overview shows the desk', text().includes('需要你处理'), text().slice(0, 120))
{
  const desk = text()
  check('overview shows one updated-at and no stale wording',
    (desk.match(/数据更新于/g) ?? []).length <= 1 && !/立即轮询|上次检查|待处理/.test(desk), desk.slice(0, 260))
  check('overview no longer duplicates the executor load block',
  ![...rootElement.querySelectorAll('.sa-main .sa-section-title')].some(node => (node.textContent ?? '').trim() === '执行器'),
  [...rootElement.querySelectorAll('.sa-main .sa-section-title')].map(node => (node.textContent ?? '').trim()).join(','))
{
  const deskWithWork = text()
  const runningSection = [...rootElement.querySelectorAll('.sa-main section')]
    .find(section => (section.querySelector('.sa-section-title')?.textContent ?? '').includes('正在执行'))
  check('overview lists the in-flight Ticket itself, not only a pulse rollup',
    Boolean(runningSection) && Boolean(runningSection.querySelector('.sa-row-open')),
    runningSection?.textContent?.slice(0, 260) ?? 'no section')
  check('overview surfaces in-progress work as one pulse sentence',
    deskWithWork.includes('系统脉搏') && deskWithWork.includes('在飞') && deskWithWork.includes('导出 UAT 对象')
      && /已运行 \d+ 分钟/.test(deskWithWork),
    deskWithWork.slice(0, 500))
  check('overview adds pulse, watchlist and a policy ledger instead of copying another page',
    deskWithWork.includes('值得留意') && deskWithWork.includes('策略规则'), deskWithWork.slice(0, 900))
  check('policy ledger leads with interceptions, not pass rates',
    deskWithWork.includes('拦截') && deskWithWork.includes('通过'), deskWithWork.slice(0, 900))
  check('overview names the needs-you vs worth-a-look split when both are on screen',
    deskWithWork.includes('需要你处理 = ') || deskWithWork.includes('无需你动作'), deskWithWork.slice(0, 700))
  check('overview funnel no longer treats 过滤 as a stage or says 丢弃',
    !deskWithWork.includes('丢弃') && (/仅作上下文/.test(deskWithWork) || !deskWithWork.includes('1\n过滤')),
    deskWithWork.slice(0, 500))
  check('overview brief is a two-column block', Boolean(rootElement.querySelector('.sa-brief-grid .sa-brief-col')),
    String(rootElement.querySelectorAll('.sa-brief-grid .sa-brief-col').length))
  const headerText = rootElement.querySelector('.sa-global-status')?.textContent ?? ''
  check('header shows the running count', /执行中\s*\d+/.test(headerText), headerText)
}
}
// P0: the desk lists derived inbox items; an accept item's row action is 去工单. Pick the demo row explicitly so a
// real state with parked gates cannot change which ticket this walkthrough opens.
const inboxButtons = [...rootElement.querySelectorAll('button')].filter(node => (node.textContent ?? '').trim() === '去工单')
const acceptButtons = inboxButtons.filter(node => (node.closest('li')?.textContent ?? '').includes('演示：验收按钮流程'))
check('inbox desk offers 去工单 for a pending acceptance', acceptButtons.length >= 1, `buttons=${acceptButtons.length}`)
acceptButtons[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
check('去验收 opens the ticket detail', text().includes('阶段链路') && text().includes('权限依据'),
  text().slice(0, 200))
{
  const detailText = text()
  const sectionTitles = [...rootElement.querySelectorAll('.sa-main .sa-section-title')]
    .map(node => (node.textContent ?? '').trim().replace(/\s+/g, '').replace(/\d+$/, ''))
  const order = ['改动内容', '验收', '阶段链路', '闸门结果', '运行记录', '时间线']
  const positions = order.map(label => sectionTitles.indexOf(label))
  check('detail sections follow the requested order', positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])),
    JSON.stringify({ sectionTitles, positions }))
  check('changes section carries the changed files and worker summary', /改动文件/.test(detailText) && /执行总结/.test(detailText), detailText.slice(0, 300))
  check('worker summary renders an ordered list', rootElement.querySelectorAll('.sa-md ol li').length >= 1,
    String(rootElement.querySelectorAll('.sa-md ol li').length))
  check('pasted SQL body renders as a code block, not prose', rootElement.querySelectorAll('.sa-md-pre').length >= 1,
    String(rootElement.querySelectorAll('.sa-md-pre').length))
  check('detail nav keeps the seven jumps in a dedicated cluster', rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length === 7,
  String(rootElement.querySelectorAll('.sa-detail-jumps .sa-detail-jump').length))
check('long ticket detail offers in-page jump navigation', rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length === 7,
  String(rootElement.querySelectorAll('.sa-detail-nav .sa-detail-jump').length))
{
  const changes = rootElement.querySelector('#sa-ticket-changes')
  const changeText = changes?.textContent ?? ''
  const fold = changes?.querySelector('details')
  check('changes lists files before the folded request', Boolean(fold)
    && changeText.indexOf('改动文件') >= 0 && changeText.indexOf('改动文件') < changeText.indexOf('需求'),
    changeText.slice(0, 300))
}
check('ticket id is copyable from the detail head', Boolean(rootElement.querySelector('.sa-page-head-meta .sa-copy-btn')),
    rootElement.querySelector('.sa-page-head-meta')?.textContent?.slice(0, 120) ?? '')
  check('repository name is not duplicated with its id', !/仓库名称[\s\S]{0,80}仓库 ID/.test(detailText), 'repo block')
  check('acceptance is shown once in the detail', (detailText.match(/已验收/g) ?? []).length <= 1,
    String((detailText.match(/已验收/g) ?? []).length))
  check('UAT card merges deploy job and status into one row', !detailText.includes('部署状态') && /部署\s*deploy_dev/.test(detailText), 'deploy rows')
  check('MR uses the MR # notation', /MR #\d+/.test(detailText) && !/!\d+/.test(detailText), 'MR label')
  check('rail gate result is a pass count', /通过|\d+\/\d+/.test(detailText) && /\d+\/\d+/.test(detailText), 'gate count')
  check('detail action bar is one primary plus an overflow menu',
    Boolean(rootElement.querySelector('.sa-main [aria-haspopup="menu"]')), 'menu trigger')
  const timeline = detailText.slice(detailText.indexOf('时间线'))
  check('timeline has no duplicated running/ok pairs', (timeline.match(/准备工作区/g) ?? []).length <= 1, String((timeline.match(/准备工作区/g) ?? []).length))
  const firstActor = rootElement.querySelector('.sa-timeline .sa-event-actor')
  check('timeline rows start with an absolute time', Boolean(firstActor && /\d{1,2}:\d{2}/.test(firstActor.textContent ?? '')), firstActor?.textContent?.slice(0, 80))
  check('timeline no longer prints 40-char SHAs', !/[0-9a-f]{40}/.test(timeline), 'sha')
  const timelineEvents = () => rootElement.querySelectorAll('.sa-timeline .sa-event').length
  const collapsedEvents = timelineEvents()
  const expandButton = [...rootElement.querySelectorAll('.sa-main button')].find(node => /展开全部/.test(node.textContent ?? ''))
  check('timeline collapses long histories by default', collapsedEvents <= 8 && Boolean(expandButton), `events=${collapsedEvents}`)
  expandButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(400)
  check('timeline expands to the full history', timelineEvents() > collapsedEvents, `after=${timelineEvents()}`)
  const collapseButton = [...rootElement.querySelectorAll('.sa-main button')].find(node => (node.textContent ?? '').trim() === '收起')
  collapseButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  await sleep(300)
  check('timeline can collapse again', timelineEvents() === collapsedEvents, `back=${timelineEvents()}`)
  writeFileSync('/tmp/render-detail.txt', detailText)
}
check('detail shows the acceptance card and UAT link', text().includes('验收') && text().includes('打开 UAT'), text().slice(0, 200))
const passButton = clickByText('验收通过')
check('acceptance button exists', Boolean(passButton))
await sleep(500)
const confirm = [...rootElement.querySelectorAll('.sa-modal button')].find(node => (node.textContent ?? '').trim() === '确定')
check('acceptance asks for confirmation', Boolean(confirm))
confirm?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1600)
check('acceptance is recorded on the ticket', text().includes('已验收') && text().includes('确认验收通过') === false, text().slice(0, 240))
// O15: an accepted Ticket is done; its primary action must not invite another dry run.
const primaryLabels = [...rootElement.querySelectorAll('.sa-main .sa-btn-primary')].map(node => (node.textContent ?? '').trim())
check('accepted ticket has no dry-run primary action', !primaryLabels.includes('干跑执行'), JSON.stringify(primaryLabels))
const acceptCall = calls.find(call => call.includes('/accept'))
check('acceptance posts to engine/ticket/:id/accept', Boolean(acceptCall), String(acceptCall))

// Back to the desk: the accepted ticket must be gone from "needs you" and the count must drop.
const back = rootElement.querySelector('.sa-page-head button')
back?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(1200)
const deskText = text()
// Other tickets (e.g. the two failed ones in real state) stay in "needs you", so count the accept actions rather than
// assuming an empty desk after one acceptance.
// The accepted Ticket must disappear from the derived desk. The demo row is the deterministic signal; other real
// items (parked gates, failures) may legitimately remain.
check('accepted ticket leaves the human queue', !deskText.includes('演示：验收按钮流程'), deskText.slice(0, 300))

// Non-acceptance actions must confirm visibly: the page-level poll emits a toast.
const pollButton = [...rootElement.querySelectorAll('button')]
  .find(node => (node.getAttribute('aria-label') ?? '') === '检查新消息')
pollButton?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
await sleep(800)
check('header poll action reports a dry-run check', /检查完成/.test(text()) && /干跑/.test(text()), text().slice(-220))

// Multi-repository UI: the source page groups IM vs code; repository facts/tokens moved to their own Repositories tab,
// while Settings keeps only the link and the manual-ticket repository picker.
clickByText('来源')
await sleep(1000)
const sourceText = text()
check('source page shows both repositories', repoLabels.every(label => sourceText.includes(label)), sourceText.slice(0, 260))
check('source page groups IM and code repositories', sourceText.includes('IM 消息源') && sourceText.includes('GitLab 仓库'), sourceText.slice(0, 260))
check('source cards use the two-up grid', rootElement.querySelectorAll('.sa-cards-2').length >= 2,
  String(rootElement.querySelectorAll('.sa-cards-2').length))
clickByText('设置')
await sleep(900)
clickByText('运行', '.sa-settings-nav button')
await sleep(900)
const settingsText = text()
// O18: each group carries a real H2 that mirrors its left-nav label; the generic section-title class stays out of it.
const settingsTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('settings groups carry an H2 heading that mirrors the navigation label',
  settingsTitles.length === 1 && settingsTitles[0] === '运行', JSON.stringify(settingsTitles))
check('run group no longer carries the repository list', !settingsText.includes('本地路径') && !settingsText.includes('前往仓库页管理'), settingsText.slice(0, 260))
const repoSelect = [...rootElement.querySelectorAll('select')]
  .find(select => [...select.options].some(option => option.value === 'ebs'))
check('manual ticket form offers the ebs repository', Boolean(repoSelect), String(repoSelect?.value))
clickByText('写权限', '.sa-settings-nav button')
await sleep(800)
const writeText = text()
const writeTitles = [...rootElement.querySelectorAll('.sa-main .sa-settings-title')].map(node => (node.textContent ?? '').trim())
check('write group is its own H2 group', writeTitles.length === 1 && writeTitles[0] === '写权限', JSON.stringify(writeTitles))
check('write group holds the three executor write permissions',
  writeText.includes('允许推送分支') && writeText.includes('允许回群消息') && writeText.includes('允许合并 MR'), writeText.slice(0, 400))
check('the merge permission is marked as high risk', writeText.includes('高危'), writeText.slice(0, 400))
const navLabels = [...rootElement.querySelectorAll('.sa-settings-nav .sa-settings-group')]
  .map(node => (node.textContent ?? '').trim()).filter(Boolean)
check('settings rail separates writable groups from reference groups',
  navLabels.slice(0, 4).join('/') === '来源/运行/写权限/仓库' && navLabels.slice(4).join('/') === '评估/提示词'
    && Boolean(rootElement.querySelector('.sa-settings-nav-sep')) && text().includes('参考'), JSON.stringify(navLabels))
clickByText('来源', '.sa-settings-nav button')
await sleep(900)
const sourceSettingsText = text()
const outlineHeaderIcons = [...rootElement.querySelectorAll('.sa-head .sa-icon-btn[data-variant="outline"]')]
check('header icon actions use the outline variant', outlineHeaderIcons.length >= 2, String(outlineHeaderIcons.length))
check('source settings offer group→repository bindings', sourceSettingsText.includes('自动接单群') && sourceSettingsText.includes('添加绑定'),
  sourceSettingsText.slice(0, 300))

// Repositories settings group: all repository facts, gates, token status and the write-only token editor live here,
// in the Settings left navigation rather than a top-level tab.
clickByText('仓库', '.sa-settings-nav button')
await sleep(900)
const reposText = text()
check('repositories group lists every repository', repoLabels.every(label => reposText.includes(label)), reposText.slice(0, 400))
check('repositories group uses the two-up card grid', rootElement.querySelectorAll('.sa-main .sa-cards-2').length >= 1,
  String(rootElement.querySelectorAll('.sa-main .sa-cards-2').length))
check('repositories group carries the default repository summary', new RegExp(`${liveRepos.length} 个仓库 · 默认仓库 ${defaultRepoId}`).test(reposText), reposText.slice(0, 200))
check('repositories group shows gates and clone path', reposText.includes('闸门') && reposText.includes('本地路径'), reposText.slice(0, 300))
check('repositories group absorbs the deployment facts', reposText.includes('部署与限制') && reposText.includes('live.json'), reposText.slice(0, 500))
const tokenInputs = [...rootElement.querySelectorAll('.sa-main input[type="password"]')]
check('repositories group offers a GitLab token editor', tokenInputs.length >= 2, `inputs=${tokenInputs.length}`)
check('token editor has a save button', [...rootElement.querySelectorAll('.sa-main button')]
  .some(button => (button.textContent ?? '').trim() === '保存令牌'))

// Eval page (O9): the row leads with the judged message, and no English reason code leaks.
clickByText('概览')
await sleep(700)
clickByText('评估')
await sleep(1000)
const evalText = text()
check('eval rows lead with the judged message', /依据这个SQL|SELECT Gcc|修复：|报表/.test(evalText), evalText.slice(0, 500))
check('eval rows no longer leak a raw reason key', !/contextOnly/.test(evalText), evalText.slice(0, 500))
check('eval keeps the rule-by-rule fold', evalText.includes('逐条规则'), evalText.slice(0, 300))
check('eval ticket short codes are links', rootElement.querySelectorAll('.sa-main .sa-row-meta a.sa-mono').length >= 1,
  String(rootElement.querySelectorAll('.sa-main .sa-row-meta a.sa-mono').length))
check('eval rows identify their thread or ticket', rootElement.querySelectorAll('.sa-main .sa-row-meta .sa-mono').length >= 1,
  String(rootElement.querySelectorAll('.sa-main .sa-row-meta .sa-mono').length))
// Execution ledger (round 4): evidence rail, stage filters, done summary, in-place manual Ticket.
clickByText('执行')
await sleep(1200)
const execText = text()
check('execution list uses the ledger wrapper', Boolean(rootElement.querySelector('.sa-exec-queue')), execText.slice(0, 300))
const evidence = [...rootElement.querySelectorAll('.sa-exec-queue .sa-row-evidence')].map(node => (node.textContent ?? '').trim()).filter(Boolean)
check('execution rows carry an evidence rail', evidence.length >= 1 && /MR #|原因：|待你|本轮|分钟|分/.test(evidence.join(' ')),
  JSON.stringify(evidence.slice(0, 4)))
check('execution rows put their actions at the row end', rootElement.querySelectorAll('.sa-exec-queue .sa-row-actions').length
  === rootElement.querySelectorAll('.sa-exec-queue .sa-row').length, String(rootElement.querySelectorAll('.sa-exec-queue .sa-row').length))
check('stage filter keeps the counts for every stage', ['排队', '执行中', '等待你', '失败工单', '已结束'].every(label => execText.includes(label)),
  execText.slice(0, 500))
check('execution ledger has a column header', ['工单', '证据', '操作'].every(label => (rootElement.querySelector('.sa-queue-head')?.textContent ?? '').includes(label)),
  rootElement.querySelector('.sa-queue-head')?.textContent ?? '')
check('executor band shows the last run', /最近一次执行/.test(execText), execText.slice(0, 400))
// P1 adds view-option segments (group/sort) to the same toolbar; only the six stage pills carry stage words.
const stageWords = /全部|等待你|失败工单|执行中|排队|已结束/
const stageButtons = [...rootElement.querySelectorAll('.sa-main .sa-filters .sa-segment')]
  .filter(button => stageWords.test(button.textContent ?? ''))
check('execution offers six stage filters with counts', stageButtons.length === 6 && /全部/.test(stageButtons[0]?.textContent ?? ''),
  JSON.stringify(stageButtons.map(button => (button.textContent ?? '').trim())))
const doneBadge = [...rootElement.querySelectorAll('.sa-exec-queue .sa-section-title .sa-hint')]
  .map(node => (node.textContent ?? '').trim()).find(label => /已验收/.test(label))
check('done group states its accepted/dismissed split', /已验收.*已忽略/.test(doneBadge ?? ''), String(doneBadge))
clickByText('手工建单')
await sleep(800)
const manualModal = rootElement.querySelector('.sa-modal')
check('manual Ticket opens in place, without leaving Execution', Boolean(manualModal)
  && Boolean(manualModal.querySelector('input')) && /建单/.test(manualModal.textContent ?? ''), (manualModal?.textContent ?? '').slice(0, 160))
rootElement.ownerDocument.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(500)
check('manual Ticket modal closes with Escape', !rootElement.querySelector('.sa-modal'), 'modal still open')

clickByText('触发')
await sleep(1000)
const triggerText = text()
const threadSections = [...rootElement.querySelectorAll('.sa-main .sa-section-title')]
  .map(node => (node.textContent ?? '').trim().replace(/\d+$/, ''))
check('thread detail no longer repeats a separate decision section',
  !threadSections.includes('决定') && threadSections.includes('评估过程') && threadSections.includes('消息时间线'),
  JSON.stringify(threadSections))
check('thread detail keeps the ticket jump in the evaluation flow', /打开工单/.test(triggerText), triggerText.slice(0, 400))
check('thread timeline renders messages through the Markdown renderer', rootElement.querySelectorAll('.sa-event-text .sa-md').length >= 1,
  String(rootElement.querySelectorAll('.sa-event-text .sa-md').length))
check('thread key is copyable from the detail head', Boolean(rootElement.querySelector('.sa-page-head-meta .sa-copy-btn')),
  rootElement.querySelector('.sa-page-head-meta')?.textContent?.slice(0, 120) ?? '')
// Global search (C13): Ctrl+K opens the palette with a focused input; Escape closes it. Query typing is exercised in
// the real browser (jsdom's old focus/selection polyfill breaks synthetic input events in render-check).
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))
await sleep(600)
const searchModal = rootElement.querySelector('.sa-modal')
const searchInput = searchModal?.querySelector('input')
// jsdom has no frame loop, so the field's focus-on-open is skipped there; the real browser check covers focus.
const searchInputFocused = rootElement.ownerDocument.activeElement === searchInput
check('Ctrl+K opens the search palette with an input', Boolean(searchModal) && Boolean(searchInput),
  JSON.stringify({ modal: Boolean(searchModal), input: Boolean(searchInput), focused: searchInputFocused }))
check('search palette starts with the keyword hint', /输入关键词/.test(searchModal?.textContent ?? ''),
  (searchModal?.textContent ?? '').slice(0, 200))
rootElement.ownerDocument.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
await sleep(400)
check('Escape closes the search palette', !rootElement.querySelector('.sa-modal'), 'modal still open')

// Keyboard shortcut: Alt+3 jumps to Eval, Alt+1 returns to the desk.
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '4', altKey: true, bubbles: true }))
await sleep(700)
const shortcutTab = [...rootElement.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim()
check('Alt+4 switches to the Eval tab', shortcutTab === '评估', String(shortcutTab))
window.dispatchEvent(new window.KeyboardEvent('keydown', { key: '1', altKey: true, bubbles: true }))
await sleep(700)
const shortcutBack = [...rootElement.querySelectorAll('[role="tab"]')].find(node => node.getAttribute('aria-selected') === 'true')?.textContent?.trim()
check('Alt+1 returns to the Overview tab', shortcutBack === '概览', String(shortcutBack))

// Sticky chrome: header + six tabs are outside the body scroller, and a route change starts at the top.
check('header and six tabs live in the fixed topbar', rootElement.querySelectorAll('.sa-topbar [role="tab"]').length === 6
  && Boolean(rootElement.querySelector('.sa-topbar .sa-head')), String(rootElement.querySelectorAll('.sa-topbar [role="tab"]').length))
check('page body is the only scrolling container', Boolean(rootElement.querySelector('.sa-scroll > .sa-main')),
  'missing .sa-scroll > .sa-main')
const scroller = rootElement.querySelector('.sa-scroll')
scroller.scrollTop = 240
clickByText('来源')
await sleep(900)
check('route change resets the body scroll', scroller.scrollTop === 0, String(scroller.scrollTop))
const selectedTab = rootElement.querySelector('[role="tab"][aria-selected="true"]')
selectedTab?.focus()
selectedTab?.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
await sleep(500)
const focusedTab = rootElement.ownerDocument.activeElement
check('arrow keys move focus with the selected tab', focusedTab?.getAttribute('role') === 'tab'
  && focusedTab.getAttribute('aria-selected') === 'true', `${focusedTab?.textContent?.trim()} / ${focusedTab?.getAttribute('aria-selected')}`)
clickByText('概览')
await sleep(600)

check('no render/runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '))
const failed = checks.filter(item => !item.ok)
console.log(JSON.stringify({ ok: failed.length === 0, checks, calls: [...new Set(calls)].slice(0, 20) }, null, 2))
try { rootDom.unmount(); dom.window.close() } catch { /* best effort */ }
process.exit(failed.length === 0 ? 0 : 1)
