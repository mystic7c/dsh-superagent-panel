#!/usr/bin/env node
/**
 * Isolated DSH + Chrome headless CDP verification for the Superagent panel.
 *
 * Why: the `render` gate renders the client in jsdom against a fixture state, so it cannot prove
 * that the panel actually mounts inside a real DSH web UI with a real Host half. This script boots a throw-away
 * DSH instance instead:
 *
 *   1. a temp $DSH_HOME with a `web`-template profile whose only added bundle is this worktree, linked with
 *      `dsh plugin add` — so the code under test is exactly the files the executor just gated;
 *   2. a temp $DSH_SUPERAGENT_STATE_DIR, so the instance shows the empty onboarding state and never touches the
 *      developer's live.json/tokens;
 *   3. a random port and `--no-open`, so it cannot collide with the running DSH;
 *   4. real Chrome in headless mode driven over CDP: open the sidebar entry, wait for the panel tabs, assert the
 *      empty state and collect console errors; a screenshot is left in verification/ as evidence.
 *
 * Everything is cleaned up at the end (processes, temp dirs). `--keep` keeps the temp dirs for debugging but still
 * stops the processes. Runs from a git worktree, needs no node_modules, and never reads the developer's state.
 *
 * Usage: node scripts/isolated-verify.mjs [--keep] [--timeout <ms>]
 * Exit: 0 all checks passed; 1 a check failed or the instance could not boot.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const keep = argv.includes('--keep')
const timeoutArg = argv.indexOf('--timeout')
const TOTAL_TIMEOUT = timeoutArg >= 0 ? Number(argv[timeoutArg + 1]) || 240_000 : 240_000
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const log = message => console.log(`[isolated-verify] ${message}`)

class CheckFailure extends Error {}

function fail(message) {
  throw new CheckFailure(message)
}

async function tail(command, args, { env, cwd, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = chunk => { output = (output + chunk.toString()).slice(-8_000) }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${command} timed out after ${timeoutMs}ms\n${output}`)) }, timeoutMs)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      if (code === 0) resolve(output)
      else reject(new Error(`${command} ${args.join(' ')} exited ${code}\n${output}`))
    })
  })
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function resolveCli() {
  const electron = process.env.DSH_NODE_EXECUTABLE
  const installDir = process.env.DSH_INSTALL_DIR
  if (electron && installDir) {
    return { command: electron, args: args => [path.join(installDir, 'lib/bin.js'), ...args], via: 'env' }
  }
  const appBundle = ['/Applications/DeepSeek Harness.app', path.join(process.env.HOME || '', 'Applications/DeepSeek Harness.app')]
    .find(candidate => existsSync(path.join(candidate, 'Contents/MacOS/DeepSeek Harness')))
  if (appBundle) {
    // The install dir lives inside app.asar: node's fs cannot see bin.js there, but Electron (ELECTRON_RUN_AS_NODE=1)
    // can, so only the outer bundle executable is probed.
    const install = path.join(appBundle, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh')
    return { command: path.join(appBundle, 'Contents/MacOS/DeepSeek Harness'), args: args => [path.join(install, 'lib/bin.js'), ...args], via: 'app-bundle' }
  }
  return { command: 'dsh', args: args => args, via: 'path' }
}

function chromeBinary() {
  const candidates = [process.env.CHROME_PATH,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean)
  const found = candidates.find(candidate => existsSync(candidate))
  if (!found) fail('no Chrome/Chromium binary found (set CHROME_PATH)')
  return found
}

async function fetchJson(url, init) {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`)
  return response.json()
}

function cdp(webSocketUrl) {
  const ws = new WebSocket(webSocketUrl)
  const pending = new Map()
  const errors = []
  let nextId = 0
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data)
    if (message.id !== undefined) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(`${message.error.message} (${message.error.code})`))
      else entry.resolve(message.result)
      return
    }
    if (message.method === 'Runtime.exceptionThrown') {
      errors.push(String(message.params?.exceptionDetails?.exception?.description
        ?? message.params?.exceptionDetails?.text ?? '').slice(0, 300))
    }
    if (message.method === 'Log.entryAdded' && message.params?.entry?.level === 'error') {
      errors.push(String(message.params.entry.text).slice(0, 300))
    }
  })
  const send = (method, params = {}) => {
    const id = ++nextId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)) }, 30_000).unref?.()
    })
  }
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    return result.result.value
  }
  return { ws, ready, send, evaluate, errors }
}

const PROFILE_TABS = ['概览', '来源', '触发', '评估', '执行', '设置']

async function waitForPanel(client) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const opened = await client.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('a, button, [role="tab"], [role="button"], [role="treeitem"]')]
      const pick = nodes.find(node => (node.innerText || '').trim() === '超级智能体')
        || nodes.find(node => (node.innerText || '').includes('超级智能体'))
      if (!pick) return { clicked: false, seen: nodes.map(node => (node.innerText || '').trim()).filter(Boolean).slice(0, 20) }
      pick.click()
      return { clicked: true }
    })()`)
    await sleep(700)
    const panel = await client.evaluate(`(() => {
      const text = document.body ? document.body.innerText : ''
      return { text, length: text.length }
    })()`)
    const tabs = PROFILE_TABS.filter(tab => panel.text.includes(tab))
    if (opened.clicked && tabs.length === PROFILE_TABS.length) return { opened, panel, tabs }
  }
  const seen = await client.evaluate(`(() => (document.body ? document.body.innerText : '').slice(0, 600))()`)
  fail(`panel did not open with all tabs ${PROFILE_TABS.join('/')}; body text:\n${seen}`)
}

async function main() {
  if (!existsSync(path.join(repoRoot, 'package.json'))) fail(`not a plugin checkout: ${repoRoot}`)

  // Locate the dsh CLI. The GUI process hands us an Electron binary that behaves as node when ELECTRON_RUN_AS_NODE=1;
  // it can read lib/bin.js inside app.asar, which plain fs checks cannot (so do not pre-check existence). When the
  // gate runs from the executor the DSH_* env vars may be absent, so fall back to the installed macOS app bundle,
  // then to a `dsh` binary on PATH.
  const cli = resolveCli()
  const useElectron = cli.via !== 'path'
  const cliCommand = cli.command
  const cliArgs = cli.args
  log(`dsh cli via ${cli.via}`)
  const childEnv = (home, extra = {}) => {
    const env = { ...process.env }
    for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SHELL']) delete env[key]
    return { ...env, ...(useElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}), DSH_HOME: home, ...extra }
  }
  const runCli = (args, { home, cwd = repoRoot, timeoutMs = 180_000 } = {}) =>
    tail(cliCommand, cliArgs(args), { env: childEnv(home), cwd, timeoutMs })

  const root = await mkdtemp(path.join(tmpdir(), 'sa-isolated-'))
  const home = path.join(root, 'home')
  const state = path.join(root, 'state')
  const chromeData = path.join(root, 'chrome')
  const profile = `iso-${path.basename(root).slice(-6)}`
  let child
  let chrome
  let client
  const cleanup = async () => {
    try { client?.ws?.close() } catch {}
    for (const proc of [chrome, child]) {
      if (!proc || proc.exitCode !== null) continue
      proc.kill('SIGTERM')
      await sleep(1_500)
      if (proc.exitCode === null) proc.kill('SIGKILL')
    }
    if (!keep) await rm(root, { recursive: true, force: true })
  }
  const guard = setTimeout(() => { cleanup().finally(() => { console.error(`[isolated-verify] FAIL total timeout (${TOTAL_TIMEOUT}ms)`); process.exit(1) }) }, TOTAL_TIMEOUT)
  guard.unref?.()

  try {
    await mkdir(home, { recursive: true })
    log(`repo ${repoRoot}`)
    log(`profile ${profile} in ${home}`)

    log('create throw-away profile from the web template')
    await runCli(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], { home })

    log('link this worktree into the profile')
    await runCli(['plugin', '--profile', profile, 'add', repoRoot], { home })

    log('boot isolated DSH (random port, state dir isolated)')
    child = spawn(cliCommand, cliArgs(['--profile', profile, '--no-open', '--port', '0']),
      { cwd: repoRoot, env: childEnv(home, { DSH_SUPERAGENT_STATE_DIR: state }), stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const booted = new Promise((resolve, reject) => {
      const onData = chunk => {
        output += chunk.toString()
        const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)\/\?token=([^\s]+)/)
        if (match) resolve({ url: match[0], port: Number(match[1]), token: match[2] })
      }
      child.stdout.on('data', onData)
      child.stderr.on('data', onData)
      child.on('exit', code => reject(new Error(`dsh exited ${code} before printing a URL\n${output.slice(-2_000)}`)))
      setTimeout(() => reject(new Error(`dsh printed no URL within 90s\n${output.slice(-2_000)}`)), 90_000).unref?.()
    })
    const boot = await booted
    log(`url ${boot.url}`)

    log('check the Host API answers and its state dir is isolated')
    const config = await fetchJson(`${boot.url.split('/?')[0]}/superagent/api/engine/config`,
      { headers: { 'x-superagent-request': '1' } })
    if (config.exists !== false) fail(`isolated state dir is not empty (exists=${config.exists}, file=${config.file})`)
    if (config.enabled !== false) fail(`live engine unexpectedly enabled in the isolated state (enabled=${config.enabled})`)
    log(`config file=${config.file} exists=${config.exists} enabled=${config.enabled}`)

    log('start headless Chrome and drive the real UI over CDP')
    const chromePort = await freePort()
    const chromePath = chromeBinary()
    chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--user-data-dir=${chromeData}`, `--remote-debugging-port=${chromePort}`, '--window-size=1280,900', 'about:blank'],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    let chromeReady = false
    for (let attempt = 0; attempt < 60 && !chromeReady; attempt += 1) {
      try { await fetchJson(`http://127.0.0.1:${chromePort}/json/version`); chromeReady = true }
      catch { await sleep(500) }
    }
    if (!chromeReady) fail('Chrome did not expose a CDP port within 30s')
    const target = await fetchJson(`http://127.0.0.1:${chromePort}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
    client = cdp(target.webSocketDebuggerUrl)
    await client.ready
    await client.send('Runtime.enable')
    await client.send('Log.enable')
    await client.send('Page.enable')
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false })
    await client.send('Page.navigate', { url: boot.url })
    await sleep(4_000)
    const { opened, panel, tabs } = await waitForPanel(client)

    if (!panel.text.includes('超级智能体')) fail('panel heading missing from the rendered body')
    if (!/开始使用|配置 Octo token|待办/.test(panel.text)) fail('empty-state onboarding block missing from the panel')
    const relevantErrors = client.errors.filter(error =>
      !/favicon\.ico|Failed to load resource: the server responded with a status of 404/i.test(error))
    if (relevantErrors.length > 0) fail(`console errors in the rendered panel (${relevantErrors.length}):\n${relevantErrors.slice(0, 5).join('\n')}`)

    const shot = await client.send('Page.captureScreenshot', { format: 'png' })
    const evidenceDir = path.join(repoRoot, 'verification')
    await mkdir(evidenceDir, { recursive: true })
    const screenshot = path.join(evidenceDir, 'isolated-verify-latest.png')
    await writeFile(screenshot, Buffer.from(shot.data, 'base64'))

    log(`panel opened by clicking the sidebar entry (clicked=${opened.clicked})`)
    log(`tabs present: ${tabs.join('/')}`)
    log(`console errors: ${client.errors.length}`)
    log(`screenshot ${screenshot}`)
    log('PASS')
    if (keep) log(`temp dir kept: ${root}`)
    process.exitCode = 0
  } catch (error) {
    console.error(`[isolated-verify] FAIL ${error instanceof Error ? error.message : String(error)}`)
    if (keep) console.error(`[isolated-verify] temp dir kept: ${root}`)
    process.exitCode = 1
  } finally {
    clearTimeout(guard)
    await cleanup()
  }
}

main().catch(error => {
  console.error(`[isolated-verify] FAIL ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
})
