// Verification driver for the redesigned Superagent panel.
//
//   node scripts/verify-panel.mjs capture   # 6 tabs at 1280x800 + overview + settings groups + text dumps
//   node scripts/verify-panel.mjs details   # open a ticket detail and a thread detail, capture them
//   node scripts/verify-panel.mjs idle      # intercept the status response with an empty ticket list, capture the idle state
//   node scripts/verify-panel.mjs gate      # static acceptance greps from spec/impl-contract-2026-11.md §10
//   node scripts/verify-panel.mjs detect    # impeccable detect --cdp 9222, sa-* findings only
//
// All artifacts go to verification/ (committed baselines) and /tmp/sa-verify (scratch text).

import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'verification')
const scratch = '/tmp/sa-verify'
const PORT = process.env.CDP_PORT ?? '9222'
const BASE = `http://127.0.0.1:${PORT}`
const VIEWPORT = { width: 1280, height: 800 }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = []
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) { this.events.push(message); return }
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 60000)
      timer.unref?.()
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true, timeout: 60000 })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  close() { try { this.ws.close() } catch {} }
}

async function connect() {
  const pages = (await (await fetch(`${BASE}/json/list`)).json()).filter(page => page.type === 'page')
  const page = pages.find(item => item.url.startsWith('dsh-app://')) ?? pages[0]
  if (!page) throw new Error(`no CDP page target on ${PORT}`)
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return { cdp: new Cdp(ws), page }
}

/** Find a visible element whose text matches and click it with real mouse events (React needs pointer events). */
async function clickText(cdp, text, { exact = false, selector = 'button, a, [role="button"], [role="tab"], [role="menuitem"], [role="treeitem"]' } = {}) {
  const point = await cdp.eval(`(() => {
    const wanted = ${JSON.stringify(text)}
    const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(node => node.getClientRects().length)
    const pick = nodes.find(node => (node.innerText ?? '').trim() === wanted)
      ?? (${exact} ? undefined : nodes.find(node => (node.innerText ?? '').includes(wanted)))
    if (!pick) return { error: 'not found', seen: nodes.map(node => (node.innerText ?? '').trim()).filter(Boolean).slice(0, 80) }
    pick.scrollIntoView({ block: 'center', inline: 'center' })
    const rect = pick.getBoundingClientRect()
    return { x: rect.left + Math.min(rect.width / 2, 120), y: rect.top + rect.height / 2, text: (pick.innerText ?? '').trim() }
  })()`)
  if (point.error) throw new Error(`clickText(${text}): ${point.error}; seen: ${JSON.stringify(point.seen)}`)
  await down(cdp, point.x, point.y)
  return point
}

async function down(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
}

async function openPanel(cdp) {
  const state = await cdp.eval(`(() => {
    const entry = [...document.querySelectorAll('button')].find(node => (node.innerText ?? '').trim() === '超级智能体')
    const panel = !!document.querySelector('.sa-page')
    if (panel) return { panel: true }
    if (!entry) return { panel: false, entry: false }
    const rect = entry.getBoundingClientRect()
    return { panel: false, entry: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
  })()`)
  if (state.panel) return { opened: 'already' }
  if (!state.entry) throw new Error('sidebar entry 超级智能体 not found')
  await down(cdp, state.x, state.y)
  for (let i = 0; i < 20; i++) {
    await sleep(150)
    if (await cdp.eval('!!document.querySelector(".sa-page")')) return { opened: 'clicked' }
  }
  throw new Error('panel did not open')
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false })
  await sleep(300)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const textOfPanel = async cdp => cdp.eval('(() => { const page = document.querySelector(".sa-page"); return page ? page.innerText : "" })()')
const pageErrors = async cdp => cdp.eval(`(() => ({
  slotErrors: [...document.querySelectorAll('[data-slot-error]')].map(node => node.textContent.slice(0, 300)),
  boundaryText: [...document.querySelectorAll('.sa-error')].map(node => node.textContent.slice(0, 300)),
}))()`)

async function shot(cdp, name) {
  mkdirSync(outDir, { recursive: true })
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  const path = join(outDir, name)
  writeFileSync(path, Buffer.from(result.data, 'base64'))
  return { path, bytes: Buffer.byteLength(result.data, 'base64') }
}

/** Raw i18n keys leak as text like pilotDryRun/liveNoTickets; page text must not contain them. */
function scanText(text) {
  const rawKeys = [...new Set((text.match(/\b(?:pilot|live)[A-Z][A-Za-z]+/g) ?? []))]
  const hardcodedEnglish = [...new Set((text.match(/\b(?:running|stopped|live\.json enabled|live\.json disabled|auto verify|dry-run)\b/g) ?? []))]
  return { rawKeys, hardcodedEnglish }
}

const BASELINE_NAMES = { overview: '50-overview-1280.png', source: '52-source-1280.png', trigger: '53-trigger-1280.png',
  eval: '54-eval-1280.png', execution: '55-execution-1280.png', settings: '57-settings-1280.png' }

const TABS = [
  { value: 'overview', label: '概览' },
  { value: 'source', label: '来源' },
  { value: 'trigger', label: '触发' },
  { value: 'eval', label: '评估' },
  { value: 'execution', label: '执行' },
  { value: 'settings', label: '设置' },
]

async function captureTabs(cdp) {
  const report = []
  try { await cdp.send('Runtime.enable'); await cdp.send('Log.enable') } catch {}
  for (const tab of TABS) {
    cdp.events.length = 0
    await clickText(cdp, tab.label, { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const runtimeErrors = cdp.events.filter(event => event.method === 'Runtime.exceptionThrown'
      || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
      .map(event => event.params?.exceptionDetails?.exception?.description ?? event.params?.entry?.text ?? String(event.method))
    const text = await textOfPanel(cdp)
    const scan = scanText(text)
    const errors = await pageErrors(cdp)
    const name = BASELINE_NAMES[tab.value] ?? `${tab.value}-1280.png`
    const image = await shot(cdp, name)
    writeFileSync(join(scratch, `${tab.value}.txt`), text)
    report.push({ tab: tab.value, firstLines: text.split('\n').slice(0, 8), rawKeys: scan.rawKeys, hardcodedEnglish: scan.hardcodedEnglish,
      slotErrors: errors.slotErrors, boundaryErrors: errors.boundaryText, runtimeErrors, image: image.path, bytes: image.bytes })
  }
  return report
}

async function commandCapture() {
  const { cdp } = await connect()
  try {
    await openPanel(cdp)
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' }).catch(() => {})
    await sleep(500)
    const tabs = await captureTabs(cdp)
    // Settings is grouped by operator question: runtime, write permissions, repositories (incl. deployment limits).
    await clickText(cdp, '运行', { exact: true, selector: '.sa-settings-nav button' }).catch(() => {})
    await sleep(800)
    const settingsRun = await shot(cdp, '68-settings-run-1280.png')
    await clickText(cdp, '写权限', { exact: true, selector: '.sa-settings-nav button' }).catch(() => {})
    await sleep(800)
    const settingsWrite = await shot(cdp, '69-settings-write-1280.png')
    // The repository group is a Settings left-nav entry (not a top-level tab).
    await clickText(cdp, '仓库', { exact: true, selector: '.sa-settings-nav button' }).catch(() => {})
    await sleep(800)
    const settingsRepos = await shot(cdp, '67-settings-repos-1280.png')
    // Reference-only groups (Eval, Prompt) sit below the divider; capture one to show the secondary rail.
    await clickText(cdp, '评估', { exact: true, selector: '.sa-settings-nav button' }).catch(() => {})
    await sleep(800)
    const settingsReference = await shot(cdp, '70-settings-reference-1280.png')
    // Global search palette (C13): Ctrl+K, type a query, capture the grouped results, then Escape.
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' }).catch(() => {})
    await sleep(500)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', windowsVirtualKeyCode: 75, modifiers: 2 })
    await sleep(500)
    await cdp.send('Input.insertText', { text: '视图' })
    await sleep(900)
    const search = await shot(cdp, '71-search-1280.png')
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(400)
    await setViewport(cdp, 960, 800)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const narrowText = await textOfPanel(cdp)
    const narrow = await shot(cdp, '51-overview-960.png')
    // Execution at 960: the ledger keeps four tracks and folds nothing (the container query only fires ≤860).
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(1600)
    const execution960 = await shot(cdp, '75-execution-960.png')
    const execution960Text = await textOfPanel(cdp)
    writeFileSync(join(scratch, 'overview-960.txt'), narrowText)
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height)
    const report = { tabs, settingsRun, settingsWrite, settingsRepos, settingsReference, search, narrow, narrowScan: scanText(narrowText), execution960, execution960Scan: scanText(execution960Text) }
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'capture-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally { cdp.close() }
}

async function commandDetails() {
  const { cdp } = await connect()
  try {
    await openPanel(cdp)
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height)
    // The desk may be empty (everything accepted): open the first Ticket from the Execution tab instead.
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(1000)
    const row = await cdp.eval(`(() => {
      const nodes = [...document.querySelectorAll('.sa-main .sa-row-openable')].filter(node => node.getClientRects().length)
      if (!nodes.length) return { error: 'no ticket row', seen: document.querySelector('.sa-page')?.innerText.slice(0, 300) }
      const rect = nodes[0].getBoundingClientRect()
      return { x: rect.left + 40, y: rect.top + rect.height / 2 }
    })()`)
    if (row.error) throw new Error('ticket detail: ' + row.error + ' ' + (row.seen ?? ''))
    await down(cdp, row.x, row.y)
    await sleep(1400)
    const ticketText = await textOfPanel(cdp)
    const ticketShot = await shot(cdp, '56-ticket-detail-1280.png')
    writeFileSync(join(scratch, 'ticket-detail.txt'), ticketText)
    const ticketScan = scanText(ticketText)
    const ticketErrors = await pageErrors(cdp)
    // Scroll segments: the detail page is taller than one viewport, record it the way a human reads it.
    const scrollShots = []
    for (const [index, offset] of [0, 620, 1240, 1860].entries()) {
      await cdp.eval(`(() => { const page = document.querySelector('.sa-scroll'); if (page) page.scrollTop = ${offset}; return page?.scrollTop ?? 0 })()`)
      await sleep(350)
      if (index > 0) scrollShots.push(await shot(cdp, `66-ticket-detail-scroll-${index}.png`))
    }
    await cdp.eval("(() => { const page = document.querySelector('.sa-scroll'); if (page) page.scrollTop = 0 })()")
    // The trigger tab hosts a thread detail; keep a fresh baseline of it too (the old 59-* was from 11-04).
    await clickText(cdp, '触发', { exact: true, selector: '[role="tab"]' })
    await sleep(1200)
    const threadShot = await shot(cdp, '59-thread-detail-1280.png')
    const threadText = await textOfPanel(cdp)
    writeFileSync(join(scratch, 'thread-detail.txt'), threadText)
    const report = { ticketShot, ticketScan, ticketErrors, scrollShots, threadShot, lines: ticketText.split('\n').slice(0, 40) }
    writeFileSync(join(scratch, 'details-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
  } finally { cdp.close() }
}

/**
 * Idle overview: intercept the status response in the page only (no shipped fake data), return the same document with
 * every ticket removed so the panel's positive idle state can be seen and screenshotted. The page is reloaded after.
 */
async function commandIdle() {
  const { cdp } = await connect()
  try {
    await openPanel(cdp)
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height)
    await cdp.eval(`(() => {
      if (window.__saOriginalFetch) return 'already'
      window.__saOriginalFetch = window.fetch
      window.fetch = async (input, init) => {
        const response = await window.__saOriginalFetch(input, init)
        const url = typeof input === 'string' ? input : input?.url ?? ''
        if (!url.includes('/superagent/api/engine/status')) return response
        const data = await response.clone().json()
        return new Response(JSON.stringify({ ...data, tickets: [], counts: { ...data.counts, needsHuman: 0 } }),
          { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return 'patched'
    })()`)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' })
    await sleep(400)
    // Force the model to refetch: the header refresh control, else wait for the 30s poll.
    const refreshed = await cdp.eval(`(() => {
      const node = [...document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? '').includes('刷新') || (item.title ?? '').includes('刷新'))
      if (node) { node.click(); return true }
      return false
    })()`)
    if (!refreshed) await sleep(31000)
    await sleep(1500)
    const text = await textOfPanel(cdp)
    const image = await shot(cdp, '58-overview-idle-1280.png')
    const scan = scanText(text)
    writeFileSync(join(scratch, 'overview-idle.txt'), text)
    // Restore the real fetch and refresh the model in place; never reload the page (it restarts the desktop app).
    await cdp.eval(`(() => { if (window.__saOriginalFetch) { window.fetch = window.__saOriginalFetch; delete window.__saOriginalFetch }
      const node = [...document.querySelectorAll('button')].find(item => (item.getAttribute('aria-label') ?? '').includes('刷新') || (item.title ?? '').includes('刷新'))
      if (node) node.click(); return 'restored' })()`)
    await sleep(2500)
    console.log(JSON.stringify({ image, scan, lines: text.split('\n').slice(0, 30) }, null, 2))
  } finally { cdp.close() }
}

const colorPattern = /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/
const files = (dir) => readdirSync(dir).filter(name => name.endsWith('.js')).map(name => join(dir, name))

async function commandGate() {
  const checks = []
  const push = (name, ok, detail) => checks.push({ name, ok, detail: String(detail).slice(0, 800) })
  const srcDir = join(root, 'client', 'src')

  try {
    execFileSync(process.execPath, [join(root, 'scripts', 'build-client.mjs')], { cwd: root, stdio: 'pipe' })
    push('build', true, 'built client/index.js')
  } catch (error) { push('build', false, error.stderr?.toString() ?? String(error)) }
  try {
    execFileSync(process.execPath, ['--check', join(root, 'client', 'index.js')], { stdio: 'pipe' })
    execFileSync(process.execPath, ['--check', join(root, 'index.js')], { stdio: 'pipe' })
    push('syntax', true, 'client/index.js + index.js')
  } catch (error) { push('syntax', false, error.stderr?.toString() ?? String(error)) }

  const sources = files(srcDir)
  const colorHits = sources.flatMap(file => readFileSync(file, 'utf8').split('\n')
    .map((line, index) => ({ file, index: index + 1, line })).filter(entry => colorPattern.test(entry.line)))
  push('no-literal-colors', colorHits.length === 0, colorHits.slice(0, 10).map(hit => `${hit.file}:${hit.index}: ${hit.line.trim()}`).join('\n') || '0')

  const textPilotKeys = files(srcDir).flatMap(file => readFileSync(file, 'utf8').split('\n')
    .map((line, index) => ({ file, index: index + 1, line })).filter(entry => /t\('pilot[A-Z]/.test(entry.line)))
  push('no-t-pilot-keys', textPilotKeys.length === 0, textPilotKeys.map(hit => `${hit.file}:${hit.index}`).join(', ') || '0')

  const css = readFileSync(join(srcDir, '05-style.js'), 'utf8')
  const literalFontSizes = [...new Set([...css.matchAll(/(?:^|[\s;])font-size:\s*([0-9.]+px)/g)].map(match => match[1]))]
  const fontTokens = [...new Set([...css.matchAll(/--sa-fs-[a-z]+:\s*([0-9.]+px)/g)].map(match => match[1]))].sort()
  const literalRadii = [...new Set([...css.matchAll(/(?:^|[\s;])border-radius:\s*([0-9.]+px)/g)].map(match => match[1]))]
  const radiusTokens = [...new Set([...css.matchAll(/--sa-r-[a-z]+:\s*([0-9.]+px)/g)].map(match => match[1]))].sort()
  push('font-size literal 0 + 5 tokens', literalFontSizes.length === 0 && fontTokens.length === 5,
    `literal=${literalFontSizes.join(',') || 0} tokens=${fontTokens.join(',')}`)
  push('radius literal 0 + tokens ⊆ 4/8/12', literalRadii.length === 0
    && radiusTokens.every(value => ['4px', '8px', '12px', '999px'].includes(value)),
  `literal=${literalRadii.join(',') || 0} tokens=${radiusTokens.join(',')}`)
  push('dead-styles-removed', !/\.sa-(demo|toolbar|search)\b/.test(css), (css.match(/\.sa-(demo|toolbar|search)\b/g) ?? []).join(',') || '0')

  try {
    const testFiles = readdirSync(join(root, 'lib', 'live')).filter(name => name.endsWith('.test.js')).map(name => join(root, 'lib', 'live', name))
    const output = execFileSync(process.execPath, ['--test', ...testFiles], { cwd: root, stdio: 'pipe' }).toString()
    const pass = output.match(/(?:ℹ|#) pass (\d+)/)?.[1]
    const fail = output.match(/(?:ℹ|#) fail (\d+)/)?.[1]
    push('host-tests', fail === '0', `pass=${pass} fail=${fail}`)
  } catch (error) { push('host-tests', false, (error.stdout?.toString() ?? '') + (error.stderr?.toString() ?? '')) }

  const ok = checks.every(check => check.ok)
  console.log(JSON.stringify({ ok, checks }, null, 2))
  if (!ok) process.exitCode = 1
}

async function commandDetect() {
  const cli = join(dirname(root), '.tmp-impeccable', 'node_modules', 'impeccable', 'cli', 'bin', 'cli.js')
  try {
    const { cdp } = await connect()
    // The detector scans the page as it stands: pin the overview tab so a leftover ticket detail (long SQL code
    // lines, a known line-length exception) does not flip this gate's result.
    try {
      await openPanel(cdp)
      // A minimized/background window makes the detector's pixel pass read nothing; bring the page forward first.
      await cdp.send('Page.bringToFront').catch(() => {})
      await cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {})
      await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' }).catch(() => {})
      await sleep(700)
    } finally { cdp.close() }
    let raw
    try {
      raw = execFileSync(process.execPath, [cli, 'detect', '--cdp', PORT, '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024 }).toString()
    } catch (error) {
      // The detector exits 2 when it reports findings; stdout still carries them.
      raw = (error.stdout ?? Buffer.alloc(0)).toString()
      if (!raw) throw error
    }
    const findings = JSON.parse(raw)
    const list = Array.isArray(findings) ? findings : findings.findings ?? []
    const own = list.filter(item => `${item.selector ?? ''} ${item.snippet ?? ''}`.includes('sa-'))
    const shell = list.filter(item => !`${item.selector ?? ''} ${item.snippet ?? ''}`.includes('sa-'))
    mkdirSync(scratch, { recursive: true })
    writeFileSync(join(scratch, 'detect.json'), JSON.stringify({ total: list.length, own, shell }, null, 2))
    console.log(JSON.stringify({ total: list.length, ownCount: own.length, own, shellCount: shell.length }, null, 2))
    if (own.length) process.exitCode = 1
  } catch (error) {
    console.error('detect failed:', error.stdout?.toString()?.slice(0, 2000) ?? String(error))
    process.exitCode = 1
  }
}

/**
 * Keyboard and action walk-through (critique 2026-11-05, G6): tablist arrows, row Enter opens the detail, Escape closes
 * the glossary, and the two header actions exist with stable aria labels. Captures the glossary.
 */
async function commandInteract() {
  const { cdp } = await connect()
  const checks = []
  const push = (name, ok, detail = '') => checks.push({ name, ok, detail: String(detail).slice(0, 400) })
  try {
    await openPanel(cdp)
    await setViewport(cdp, VIEWPORT.width, VIEWPORT.height)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' }).catch(() => {})
    await sleep(400)
    const tablist = await cdp.eval(`(() => {
      const list = document.querySelector('.sa-tabs, [role="tablist"]')
      const tabs = [...document.querySelectorAll('[role="tab"]')]
      return { tabs: tabs.length, selected: tabs.filter(tab => tab.getAttribute('aria-selected') === 'true').length,
        tabindex: tabs.filter(tab => tab.getAttribute('tabindex') === '0').length, hasList: Boolean(list) }
    })()`)
    push('tablist exposes six tabs with roving tabindex',
      tablist.tabs === 6 && tablist.selected === 1 && tablist.tabindex === 1 && tablist.hasList, JSON.stringify(tablist))
    await cdp.eval(`(() => { const tab = document.querySelector('[role="tab"][aria-selected="true"]'); tab?.focus() })()`)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 })
    await sleep(700)
    const afterRight = await cdp.eval('document.querySelector(\'[role="tab"][aria-selected="true"]\')?.innerText?.trim()')
    push('ArrowRight selects the next tab', afterRight === '来源', String(afterRight))
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 })
    await sleep(700)
    const afterLeft = await cdp.eval('document.querySelector(\'[role="tab"][aria-selected="true"]\')?.innerText?.trim()')
    push('ArrowLeft returns to the overview', afterLeft === '概览', String(afterLeft))
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const focused = await cdp.eval(`(() => {
      const row = [...document.querySelectorAll('.sa-main .sa-row-open')].find(node => node.getClientRects().length)
      if (!row) return { error: 'no row' }
      row.focus()
      return { focused: document.activeElement === row, text: row.innerText.slice(0, 80) }
    })()`)
    if (focused.error) throw new Error('no ticket row for keyboard walk-through')
    // The row's keyboard affordance is a native <button>; a raw CDP key event needs its text so the default action
    // (activate the button) fires, exactly like a real Enter press.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
    await sleep(1200)
    const detailOpen = await cdp.eval('document.querySelector(\'.sa-page\')?.innerText?.includes(\'阶段链路\') === true')
    push('Enter on a ticket row opens the detail', detailOpen)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(900)
    const backToList = await cdp.eval('document.querySelector(\'.sa-page\')?.innerText?.includes(\'阶段链路\') === false')
    push('Escape returns from the detail', backToList)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' }).catch(() => {})
    const glossary = await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find(node => (node.getAttribute('aria-label') ?? node.title ?? '').includes('术语'))
      if (!button) return { error: 'glossary trigger not found' }
      button.click(); return { clicked: true }
    })()`)
    if (glossary.error) throw new Error(glossary.error)
    await sleep(700)
    const glossaryOpen = await cdp.eval('!!document.querySelector(\'.sa-modal\')')
    const glossaryShot = glossaryOpen ? await shot(cdp, '60-glossary-1280.png') : null
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(600)
    const glossaryClosed = await cdp.eval('!document.querySelector(\'.sa-modal\')')
    push('glossary opens and Escape closes it', glossaryOpen && glossaryClosed)
    const actions = await cdp.eval(`(() => {
      const labels = [...document.querySelectorAll('button')].map(node => node.getAttribute('aria-label') ?? '').filter(Boolean)
      return { check: labels.includes('检查新消息'), refresh: labels.includes('刷新状态') }
    })()`)
    push('header exposes 检查新消息 and 刷新状态', actions.check && actions.refresh, JSON.stringify(actions))
    const runningSpin = await cdp.eval(`(() => {
      const node = document.querySelector('.sa-head .sa-status-icon')
      if (!node) return null
      const style = getComputedStyle(node)
      return { className: String(node.getAttribute('class') ?? ''), animation: style.animationName, duration: style.animationDuration }
    })()`)
    push('running header icon animates', Boolean(runningSpin && runningSpin.className.includes('sa-spin') && runningSpin.animation === 'sa-spin'),
      JSON.stringify(runningSpin))
    // Pause confirmation: open the dialog, capture it, and dismiss it so the engine keeps running.
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const pauseOpened = await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('button')].find(node => (node.innerText ?? '').trim() === '暂停处理')
      if (!button) return false
      button.click(); return true
    })()`)
    await sleep(600)
    const pauseModal = await cdp.eval(`!!document.querySelector('.sa-modal')`)
    const pauseShot = pauseModal ? await shot(cdp, '61-pause-confirm-1280.png') : null
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(500)
    const pauseDismissed = await cdp.eval(`!document.querySelector('.sa-modal')`)
    push('pause confirmation opens and can be dismissed without pausing', pauseOpened && pauseModal && pauseDismissed)
    const report = { checks, glossaryShot, pauseShot }
    writeFileSync(join(scratch, 'interact-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (checks.some(check => !check.ok)) process.exitCode = 1
  } finally { cdp.close() }
}

/** 960px reflow: each tab and a ticket detail must stay inside the panel without horizontal scrolling. */
async function commandNarrow() {
  const { cdp } = await connect()
  const checks = []
  try {
    await openPanel(cdp)
    await setViewport(cdp, 960, 800)
    for (const tab of ['概览', '来源', '触发', '评估', '执行', '设置']) {
      await clickText(cdp, tab, { exact: true, selector: '[role="tab"]' })
      await sleep(500)
      const width = await cdp.eval(`(() => { const page = document.querySelector('.sa-page'); return { scroll: page?.scrollWidth ?? 0, client: page?.clientWidth ?? 0 } })()`)
      checks.push({ name: tab + ' has no horizontal overflow', ok: width.scroll <= width.client + 1, detail: JSON.stringify(width) })
    }
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' })
    await sleep(500)
    const overviewShot = await shot(cdp, '51-overview-960.png')
    await clickText(cdp, '触发', { exact: true, selector: '[role="tab"]' })
    await sleep(1000)
    const threadShot = await shot(cdp, '64-thread-detail-960.png')
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(700)
    const row = await cdp.eval(`(() => {
      const nodes = [...document.querySelectorAll('.sa-main .sa-row-openable')].filter(node => node.getClientRects().length)
      if (!nodes.length) return { error: 'no row' }
      const rect = nodes[0].getBoundingClientRect()
      return { x: rect.left + 40, y: rect.top + rect.height / 2 }
    })()`)
    if (row.error) throw new Error('narrow: no ticket row')
    await down(cdp, row.x, row.y)
    await sleep(1200)
    const detailWidth = await cdp.eval(`(() => { const page = document.querySelector('.sa-page'); return { scroll: page?.scrollWidth ?? 0, client: page?.clientWidth ?? 0 } })()`)
    const detailShot = await shot(cdp, '65-ticket-detail-960.png')
    checks.push({ name: 'ticket detail has no horizontal overflow at 960', ok: detailWidth.scroll <= detailWidth.client + 1, detail: JSON.stringify(detailWidth) })
    const report = { checks, overviewShot, detailShot }
    writeFileSync(join(scratch, 'narrow-report.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify(report, null, 2))
    if (checks.some(check => !check.ok)) process.exitCode = 1
  } finally { cdp.close() }
}

/** Layout measurements at 960 used while tuning the narrow header (diagnostic only). */
async function commandDebug960() {
  const { cdp } = await connect()
  try {
    await openPanel(cdp)
    await setViewport(cdp, 960, 800)
    await clickText(cdp, '概览', { exact: true, selector: '[role="tab"]' }).catch(() => {})
    await sleep(600)
    const metrics = await cdp.eval(`(() => {
      const page = document.querySelector('.sa-page')
      const head = document.querySelector('.sa-head')
      const title = document.querySelector('.sa-title')
      const tools = document.querySelector('.sa-head-tools')
      const box = node => node ? ({ x: Math.round(node.getBoundingClientRect().left), y: Math.round(node.getBoundingClientRect().top),
        w: Math.round(node.getBoundingClientRect().width), h: Math.round(node.getBoundingClientRect().height) }) : null
      return { viewport: { w: innerWidth, h: innerHeight }, page: box(page), scroll: { page: page?.scrollWidth, client: page?.clientWidth },
        head: box(head), title: box(title), tools: box(tools),
        overlap: title && tools ? !(title.getBoundingClientRect().right <= tools.getBoundingClientRect().left || title.getBoundingClientRect().bottom <= tools.getBoundingClientRect().top) : null }
    })()`)
    writeFileSync(join(scratch, 'debug960.json'), JSON.stringify(metrics, null, 2))
    console.log(JSON.stringify(metrics, null, 2))
  } finally { cdp.close() }
}

/**
 * Wide-window acceptance (round 4 C14/C15): the execution ledger must not leave a blank right half. Measures the first
 * row at 1280/1440 and the physical window: actions anchored to the row end, evidence rail present before them, and the
 * column actually using a wide panel. Baselines: 72/73/74-execution-wide-*.png.
 */
async function commandWide() {
  const { cdp } = await connect()
  const checks = []
  const shots = []
  const measure = () => cdp.eval(`(() => {
    const rect = node => { const r = node.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) } }
    const row = document.querySelector('.sa-exec-queue .sa-row') ?? document.querySelector('.sa-main .sa-row')
    if (!row) return { error: 'no ticket row' }
    const page = document.querySelector('.sa-page')
    const column = document.querySelector('.sa-column')
    const action = row.querySelector('.sa-row-actions')
    const evidence = row.querySelector('.sa-row-evidence')
    return { vw: innerWidth, page: page?.clientWidth, column: column ? rect(column) : null, row: rect(row),
      action: action ? rect(action) : null,
      evidence: evidence ? { ...rect(evidence), text: (evidence.innerText ?? '').trim().slice(0, 60) } : null,
      children: [...row.children].map(node => ({ className: String(node.className), ...rect(node) })) }
  })()`)
  const evaluate = (width, value) => {
    if (value.error) { checks.push({ name: `${width}: execution row found`, ok: false, detail: value.error }); return }
    checks.push({ name: `${width}: actions are anchored at the row end`, ok: !value.action || value.row.right - value.action.right <= 24,
      detail: `gap=${value.action ? value.row.right - value.action.right : 'n/a'}` })
    checks.push({ name: `${width}: evidence rail exists with content`, ok: Boolean(value.evidence) && value.evidence.width > 24,
      detail: value.evidence ? JSON.stringify({ width: value.evidence.width, text: value.evidence.text }) : 'missing' })
    if (value.evidence && value.action) {
      checks.push({ name: `${width}: evidence sits before the actions`, ok: value.evidence.right <= value.action.left + 1,
        detail: `evidence.right=${value.evidence.right} action.left=${value.action.left}` })
    }
  }
  try {
    await openPanel(cdp)
    for (const [width, name] of [[1280, '72-execution-wide-1280.png'], [1440, '73-execution-wide-1440.png']]) {
      await setViewport(cdp, width, VIEWPORT.height)
      await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
      await sleep(900)
      evaluate(width, await measure())
      shots.push(await shot(cdp, name))
    }
    await cdp.send('Emulation.clearDeviceMetricsOverride')
    await sleep(700)
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const physical = await measure()
    evaluate('1920', physical)
    checks.push({ name: '1920: the column uses the wide panel', ok: Number(physical.column?.width) >= 1100,
      detail: JSON.stringify(physical.column) })
    shots.push(await shot(cdp, '74-execution-wide-1920.png'))
    writeFileSync(join(scratch, 'wide-report.json'), JSON.stringify({ checks, shots }, null, 2))
    console.log(JSON.stringify({ checks, shots }, null, 2))
    if (checks.some(check => !check.ok)) process.exitCode = 1
  } finally { cdp.close() }
}

/**
 * Round-6 acceptance: header + six tabs are permanent chrome and only `.sa-scroll` moves; a route change resets the
 * body scroll; the Ticket jump nav pins flush under the topbar; the narrow ledger keeps its cause/MR as a third line.
 */
async function commandSticky() {
  const { cdp } = await connect()
  const checks = []
  let shotPath
  const measure = () => cdp.eval(`(() => {
    const bar = document.querySelector('.sa-topbar')
    const tabs = document.querySelector('.sa-filters')
    const scroll = document.querySelector('.sa-scroll')
    const head = document.querySelector('.sa-head')
    const rect = node => node ? { top: Math.round(node.getBoundingClientRect().top), bottom: Math.round(node.getBoundingClientRect().bottom) } : null
    return { bar: rect(bar), head: rect(head), tabs: rect(tabs), tabCount: document.querySelectorAll('.sa-topbar [role="tab"]').length,
      scroll: scroll ? { top: Math.round(scroll.scrollTop), height: Math.round(scroll.getBoundingClientRect().height) } : null }
  })()`)
  try {
    await openPanel(cdp)
    await setViewport(cdp, 1280, VIEWPORT.height)
    await clickText(cdp, '触发', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const before = await measure()
    await cdp.eval(`(() => { const node = document.querySelector('.sa-scroll'); if (node) node.scrollTop = 420; return node?.scrollTop ?? 0 })()`)
    await sleep(400)
    const after = await measure()
    shotPath = await shot(cdp, '76-sticky-scrolled.png')
    checks.push({ name: 'topbar stays fixed while the body scrolls', ok: before.bar?.top === 0 && after.bar?.top === 0
      && after.bar.bottom === before.bar.bottom, detail: JSON.stringify({ before: before.bar, after: after.bar }) })
    checks.push({ name: 'six tabs stay in the fixed topbar', ok: after.tabCount === 6 && after.tabs?.top === before.tabs?.top,
      detail: JSON.stringify(after.tabs) })
    checks.push({ name: 'the body actually scrolled', ok: after.scroll.top > 0, detail: String(after.scroll.top) })
    await clickText(cdp, '评估', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    const reset = await measure()
    checks.push({ name: 'route change resets the body scroll', ok: reset.scroll.top === 0, detail: String(reset.scroll.top) })
    await setViewport(cdp, 800, VIEWPORT.height)
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(1000)
    const narrowState = await cdp.eval(`(() => {
      const row = document.querySelector('.sa-exec-queue .sa-row')
      const evidence = row?.querySelector('.sa-row-evidence')
      return { page: document.querySelector('.sa-page')?.clientWidth, display: evidence ? getComputedStyle(evidence).display : null,
        order: evidence ? getComputedStyle(evidence).order : null, text: evidence?.innerText?.trim().slice(0, 40) ?? '' }
    })()`)
    checks.push({ name: 'narrow ledger keeps the cause/MR as a third line', ok: Number(narrowState.page) <= 860 && narrowState.display === 'flex'
      && narrowState.order === '3' && narrowState.text.length > 0, detail: JSON.stringify(narrowState) })
    await setViewport(cdp, 1280, VIEWPORT.height)
    await clickText(cdp, '执行', { exact: true, selector: '[role="tab"]' })
    await sleep(900)
    await cdp.eval(`(() => { document.querySelector('.sa-exec-queue .sa-row-openable')?.click(); return true })()`)
    await sleep(1400)
    await cdp.eval(`(() => {
      const button = [...document.querySelectorAll('.sa-detail-jump')].find(node => node.innerText.trim() === '时间线')
      button?.click()
      return true
    })()`)
    await sleep(600)
    const detail = await cdp.eval(`(() => {
      const bar = document.querySelector('.sa-topbar'); const nav = document.querySelector('.sa-detail-nav')
      const button = [...(nav?.querySelectorAll('.sa-detail-jump') ?? [])].find(node => node.innerText.trim() === '时间线')
      return { barBottom: Math.round(bar.getBoundingClientRect().bottom), navTop: Math.round(nav.getBoundingClientRect().top),
        active: button?.getAttribute('data-active'), current: button?.getAttribute('aria-current') }
    })()`)
    checks.push({ name: 'detail jump nav pins flush under the topbar', ok: detail.navTop === detail.barBottom, detail: JSON.stringify(detail) })
    checks.push({ name: 'detail jump nav marks the active section', ok: detail.active === 'true' && detail.current === 'location',
      detail: JSON.stringify(detail) })
    writeFileSync(join(scratch, 'sticky-report.json'), JSON.stringify({ checks, shot: shotPath }, null, 2))
    console.log(JSON.stringify({ checks, shot: shotPath }, null, 2))
    if (checks.some(check => !check.ok)) process.exitCode = 1
  } finally {
    try { await cdp.send('Emulation.clearDeviceMetricsOverride') } catch {}
    cdp.close()
  }
}

const command = process.argv[2]
mkdirSync(scratch, { recursive: true })
const commands = { capture: commandCapture, details: commandDetails, idle: commandIdle, gate: commandGate, detect: commandDetect, interact: commandInteract, narrow: commandNarrow, wide: commandWide, sticky: commandSticky, debug960: commandDebug960 }
if (!commands[command]) {
  console.error('usage: node scripts/verify-panel.mjs <capture|details|idle|gate|detect|interact|narrow|wide|sticky>')
  process.exit(2)
}
await commands[command]()
