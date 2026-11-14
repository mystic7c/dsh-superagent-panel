#!/usr/bin/env node
/**
 * Boot the `dev` profile — the one that links this working tree — and print the URL to open.
 *
 *   node scripts/dev.mjs                 # same as: dsh --profile dev --no-open --port 0
 *   node scripts/dev.mjs --port 51234     # extra arguments are forwarded to `dsh`
 *
 * This is the "边改边看" loop:
 *   client change  -> node scripts/build-client.mjs, then refresh the page
 *   host change    -> restart this process
 *
 * The `desktop` profile is the clean install (a real directory unpacked from a release tarball) and must
 * never point at this repository; see the install-state section in AGENTS.md.
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'

function resolveCli() {
  const runtimeCli = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
  if (existsSync(runtimeCli)) return { command: runtimeCli, args: [], via: 'runtime-cli' }
  const appBundle = ['/Applications/DeepSeek Harness.app', path.join(process.env.HOME || '', 'Applications/DeepSeek Harness.app')]
    .find(candidate => existsSync(path.join(candidate, 'Contents/MacOS/DeepSeek Harness')))
  if (appBundle) {
    const bin = path.join(appBundle, 'Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
    return { command: path.join(appBundle, 'Contents/MacOS/DeepSeek Harness'), args: [bin], via: 'app-bundle', electron: true }
  }
  return { command: 'dsh', args: [], via: 'path' }
}

const cli = resolveCli()
const env = { ...process.env }
for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_WEB_URL', 'DSH_SESSION_ID', 'DSH_SHELL']) delete env[key]
if (cli.electron) env.ELECTRON_RUN_AS_NODE = '1'

console.log(`[dev] dsh cli via ${cli.via}`)
console.log('[dev] profile=dev (links this working tree); open the token URL printed below')
console.log('[dev] client change -> node scripts/build-client.mjs + refresh; host change -> restart this process')

const child = spawn(cli.command, [...cli.args, '--profile', 'dev', '--no-open', '--port', '0',
  ...process.argv.slice(2)], { env, stdio: 'inherit' })
child.on('exit', code => process.exit(code ?? 0))
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
