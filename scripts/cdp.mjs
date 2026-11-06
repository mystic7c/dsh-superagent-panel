// Small CDP driver for verifying the panel in the running DeepSeek Harness desktop app.
// The app is launched with --remote-debugging-port=9222 (see /tmp/dsh-cdp/out/cdp-run.log).
//
//   node scripts/cdp.mjs text                 # visible text of the panel subtree
//   node scripts/cdp.mjs eval "<expression>"  # evaluate in the page, print the JSON result
//   node scripts/cdp.mjs click "<text>"       # click the first button/link whose text matches
//   node scripts/cdp.mjs open                 # click the sidebar entry for the panel
//   node scripts/cdp.mjs shot <path>          # screenshot the page
//   node scripts/cdp.mjs viewport 1280 800    # emulate a viewport size
//   node scripts/cdp.mjs tabs                 # list page targets

const PORT = process.env.CDP_PORT ?? '9222'
const BASE = `http://127.0.0.1:${PORT}`

async function targets() {
  const response = await fetch(`${BASE}/json/list`)
  return (await response.json()).filter(page => page.type === 'page')
}

async function pickPage() {
  const pages = await targets()
  if (!pages.length) throw new Error(`no CDP page target on port ${PORT}`)
  return pages.find(page => page.url.startsWith('dsh-app://')) ?? pages[0]
}

class Cdp {
  constructor(ws) {
    this.ws = ws
    this.id = 0
    this.pending = new Map()
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id === undefined) return
      const entry = this.pending.get(message.id)
      if (!entry) return
      this.pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30000)
      timer.unref?.()
    })
  }
  async eval(expression) {
    const result = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true,
      userGesture: true, timeout: 30000 })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  async close() { try { this.ws.close() } catch {} }
}

async function connect() {
  const page = await pickPage()
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  return { cdp: new Cdp(ws), page }
}

const PANEL_ROOT = `document.querySelector('.sa-page') ? document.querySelector('.sa-page').closest('[data-slot-error]') || document.querySelector('.sa-page') : null`

const commands = {
  async tabs() { return (await targets()).map(page => ({ id: page.id, title: page.title, url: page.url })) },
  async text() {
    const { cdp } = await connect()
    try {
      return await cdp.eval(`(() => { const page = document.querySelector('.sa-page'); if (!page) return 'PANEL_NOT_OPEN';
        return page.innerText })()`)
    } finally { await cdp.close() }
  },
  async eval(expression) {
    if (!expression) throw new Error('eval needs an expression')
    const { cdp } = await connect()
    try { return await cdp.eval(expression) } finally { await cdp.close() }
  },
  async 'eval-file'(file) {
    const { readFileSync } = await import('node:fs')
    const { cdp } = await connect()
    try { return await cdp.eval(readFileSync(file, 'utf8')) } finally { await cdp.close() }
  },
  async open() {
    const { cdp } = await connect()
    try {
      return await cdp.eval(`(() => {
        const items = [...document.querySelectorAll('button, a, [role="treeitem"], [role="button"]')]
        const entry = items.find(node => (node.innerText ?? '').trim() === '超级智能体')
          ?? items.find(node => (node.innerText ?? '').includes('超级智能体'))
        if (!entry) return { clicked: false, candidates: items.map(node => node.innerText).filter(Boolean).slice(0, 40) }
        entry.click()
        return { clicked: true, tag: entry.tagName, text: entry.innerText }
      })()`)
    } finally { await cdp.close() }
  },
  async click(text) {
    if (!text) throw new Error('click needs text')
    const { cdp } = await connect()
    try {
      return await cdp.eval(`(() => {
        const wanted = ${JSON.stringify(text)}
        const items = [...document.querySelectorAll('button, a, [role="button"], [role="tab"], [role="menuitem"]')]
        const visible = items.filter(node => node.offsetParent !== null || node.getClientRects().length)
        const exact = visible.find(node => (node.innerText ?? '').trim() === wanted)
        const partial = visible.find(node => (node.innerText ?? '').includes(wanted))
        const target = exact ?? partial
        if (!target) return { clicked: false, candidates: visible.map(node => (node.innerText ?? '').trim()).filter(Boolean).slice(0, 60) }
        target.click()
        return { clicked: true, tag: target.tagName, text: (target.innerText ?? '').trim() }
      })()`)
    } finally { await cdp.close() }
  },
  async shot(path = '/tmp/sa-panel.png') {
    const { cdp } = await connect()
    try {
      const metrics = await cdp.send('Page.getLayoutMetrics')
      const size = metrics.cssVisualViewport ?? metrics.visualViewport
      const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
      const { writeFileSync, mkdirSync } = await import('node:fs')
      const { dirname } = await import('node:path')
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, Buffer.from(result.data, 'base64'))
      return { path, width: size.width, height: size.height, scale: size.scale ?? 1, bytes: Buffer.byteLength(result.data, 'base64') }
    } finally { await cdp.close() }
  },
  async viewport(width, height) {
    if (!width || !height) throw new Error('viewport needs width and height')
    const { cdp } = await connect()
    try {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: Number(width), height: Number(height),
        deviceScaleFactor: Number(process.env.CDP_DSF ?? 2), mobile: false })
      return { width: Number(width), height: Number(height) }
    } finally { await cdp.close() }
  },
  async 'viewport-clear'() {
    const { cdp } = await connect()
    try { await cdp.send('Emulation.clearDeviceMetricsOverride'); return { cleared: true } } finally { await cdp.close() }
  },
  async 'click-at'(x, y) {
    if (x === undefined || y === undefined) throw new Error('click-at needs x y')
    const { cdp } = await connect()
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Number(x), y: Number(y), button: 'left', clickCount: 1 })
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Number(x), y: Number(y), button: 'left', clickCount: 1 })
      return { clicked: { x: Number(x), y: Number(y) } }
    } finally { await cdp.close() }
  },
  async 'status'() {
    const { cdp } = await connect()
    try {
      return await cdp.eval(`(() => {
        const page = document.querySelector('.sa-page');
        const slot = document.querySelector('[data-slot="main"]');
        const errors = [...document.querySelectorAll('[data-slot-error]')].map(n => n.textContent.slice(0, 200));
        return { panel: !!page, slotMain: !!slot, mainText: (slot?.innerText ?? '').slice(0, 120), errors };
      })()`)
    } finally { await cdp.close() }
  },
  async reload() {
    const { cdp } = await connect()
    try { await cdp.send('Page.reload', { ignoreCache: true }); return { reloaded: true } } finally { await cdp.close() }
  },
}

const [command, ...args] = process.argv.slice(2)
if (!commands[command]) {
  console.error(`usage: node scripts/cdp.mjs <${Object.keys(commands).join('|')}> [args]`)
  process.exit(2)
}
try {
  const value = await commands[command](...args)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
} catch (error) {
  console.error(`cdp ${command} failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
