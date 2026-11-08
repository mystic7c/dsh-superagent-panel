/**
 * Host half of the Superagent management panel.
 *
 * Owns the durable state directory (~/.dsh/superagent by default, override with DSH_SUPERAGENT_STATE_DIR), serves
 * the live engine's status and actions over same-origin `/superagent/api` routes, and hosts the legacy management
 * endpoints kept for older callers. The live engine (lib/live) does the real work: Octo intake, rule evaluation,
 * Ticket state, DSH/Codex/Claude workers, GitLab MR/CI/UAT and human acceptance. `README.md` is the capability
 * contract; this file should not claim more than that.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store } from './lib/store.js'
import { stateView, overviewView, searchView, sourcesView, settingsView, threadListView, threadDetailView,
  decisionListView, ticketListView, ticketDetailView, historyView, promptsView, modelsView } from './lib/views.js'
import { saveSettings, syncSource, setPaused, retryTicket, stopTicket, dismissDecision, requeueTrigger, unsubscribeThread,
  savePrompts, previewPromptsFor, setupCheck, resetDemo, ActionError } from './lib/actions.js'
import { createEngine } from './lib/live/engine.js'
import { updateLiveConfig, saveRepoToken, saveTokenFile } from './lib/live/live-json.js'
import { executeTicket, refreshTicketCi, injectTicket, publishTicket, checkUat, verifyTicket, resumeTicket,
  resumeInterruptedTicket, answerTicket } from './lib/live/executor.js'

export const inject = ['webServer']
const PREFIX = '/superagent/api'
const MAX_BODY = 128 * 1024

const FALLBACK_MODELS = {
  groups: [{ id: 'deepseek', name: 'DeepSeek', models: [
    { id: 'deepseek-chat', name: 'DeepSeek Chat', description: '通用对话与编码' },
    { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', description: '推理模型' },
  ] }],
  default: { provider: 'deepseek', model: 'deepseek-chat' },
}

/** Resolve the state directory from the row config, then the environment, then the user's ~/.dsh. */
function stateDirOf(config) {
  if (typeof config?.stateDir === 'string' && config.stateDir.trim()) return config.stateDir.trim().replace(/^~(?=\/|$)/, homedir())
  if (process.env.DSH_SUPERAGENT_STATE_DIR) return process.env.DSH_SUPERAGENT_STATE_DIR
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'superagent')
}

/** Versioned machine limits the panel shows and edits through the prompts/settings pages. */
const MACHINE_LIMITS = { promptMaxChars: 100_000, admissionContextMaxPages: 10, admissionContextTimeoutMs: 15_000 }

class BodyTooLarge extends Error {}

function send(res, status, value) {
  const body = `${JSON.stringify(value)}\n`
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

async function readJson(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new BodyTooLarge()
    chunks.push(Buffer.from(chunk))
  }
  if (!size) return undefined
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new ActionError(400, '请求体不是 JSON')
  }
}

/** Build the host object every view and action reads. */
function createHost({ ctx, store, stateDir }) {
  const host = {
    ctx,
    store,
    stateDir,
    masterId: null,
    environment: [],
    llm: undefined,
    modelDetail: '使用内置模型目录',
    setup: undefined,
    recheckSetup: undefined,
  }
  // Filled after the document is loaded: the environment block reads current settings and deployment facts.
  host.environment = []
  host.refreshEnvironment = () => {
    const settings = store.settings ?? {}
    host.environment = [
      { name: 'SUPERAGENT_STATE_DIR', label: { zh: '状态目录', en: 'State directory' }, value: stateDir },
      { name: 'SUPERAGENT_REPOSITORY', label: { zh: 'GitHub 仓库', en: 'GitHub repository' }, value: settings.sources?.github?.config?.repository ?? '' },
      { name: 'SUPERAGENT_AGENT', label: { zh: 'CLI 身份', en: 'CLI identity' }, value: store.setupCache?.accounts?.agent ?? '' },
      { name: 'SUPERAGENT_TICKET', label: { zh: '工单 id', en: 'Ticket id' }, value: '<ticket id>' },
      { name: 'SUPERAGENT_THREAD', label: { zh: '线程 key', en: 'Thread key' }, value: '<thread key>' },
      { name: 'SUPERAGENT_WORKER_MODEL', label: { zh: '执行器模型', en: 'Worker model' }, value: settings.executor?.workerModel?.model ?? '' },
    ]
  }
  host.refreshSetup = () => {
    const cache = store.state ? (store.setupCache ?? {}) : {}
    host.setup = { machine: { stateDir, ...MACHINE_LIMITS }, problem: cache.problem ?? null, feishuProblem: cache.feishuProblem ?? null,
      accounts: cache.accounts ?? null }
  }
  host.recheckSetup = async ({ soft = false } = {}) => {
    try {
      await setupCheck(host)
    } catch (error) {
      ctx.logger?.warn?.('superagent setup check failed: %s', error instanceof Error ? error.message : String(error))
    }
    host.refreshSetup()
  }
  host.refreshSetup()
  return host
}

/** Publish the model catalog the host LLM service offers, mirroring the session model selector. */
async function readModels(host) {
  const llm = host.ctx.get?.('llm')
  if (!llm || typeof llm.listProviders !== 'function') return FALLBACK_MODELS
  const groups = []
  try {
    for (const provider of llm.listProviders()) {
      const models = await llm.listModels(provider.id).catch(() => [])
      groups.push({ id: provider.id, name: provider.name ?? provider.id, models: models.map(model => ({
        id: model.id, name: model.name ?? model.id, ...model.description ? { description: model.description } : {} })) })
    }
  } catch {
    return FALLBACK_MODELS
  }
  if (!groups.length) return FALLBACK_MODELS
  host.modelDetail = `模型目录：${groups.map(group => `${group.name} (${group.models.length})`).join('、')}`
  const configured = host.store.settings.executor?.workerModel
  const fallback = groups[0]?.models?.[0]
  const defaultModel = configured ?? (fallback ? { provider: groups[0].id, model: fallback.id } : null)
  return { groups, default: defaultModel }
}

/** Parse `/superagent/api/<path>` into segments. */
const segmentsOf = (url) => url.split('?')[0].replace(PREFIX, '').split('/').filter(Boolean).map(decodeURIComponent)

const routes = {
  'GET state': ({ host }) => stateView(host),
  'GET overview': ({ host }) => overviewView(host),
  'GET search': ({ host, query }) => searchView(host, query.get('q') ?? ''),
  'GET sources': ({ host }) => sourcesView(host),
  'GET settings': ({ host }) => settingsView(host),
  'GET threads': ({ host, query }) => threadListView(host, query.get('filter') ?? 'subscribed', Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 20)),
  'GET decisions': ({ host, query }) => decisionListView(host, query.get('kind') ?? 'work', Number(query.get('offset') ?? 0),
    Number(query.get('limit') ?? 20), query.get('window')),
  'GET tickets': ({ host, query }) => ticketListView(host, query.get('state') ?? 'open', Number(query.get('offset') ?? 0), Number(query.get('limit') ?? 20)),
  'GET policy/history': ({ host }) => historyView(host),
  'GET models': async ({ host }) => modelsView(await readModels(host)),
  'GET prompts': ({ host, query }) => promptsView(host, query.get('revision') === null ? undefined : Number(query.get('revision'))),
}

export function apply(ctx, config = {}) {
  const stateDir = stateDirOf(config)
  const store = new Store(stateDir)
  const host = createHost({ ctx, store, stateDir })

  // The live engine is optional: it only starts when live.json exists and enabled=true. Its document is separate
  // from the demo state, so a trial run never destroys what the panel shows in demo mode.
  let engine
  const ready = store.load().then(async (result) => {
    host.refreshEnvironment()
    host.refreshSetup()
    if (result.corrupt) ctx.logger?.warn?.('superagent state was unreadable; seeded a fresh document (backup: %s)', result.backup)
    ctx.logger?.info?.('superagent management state: %s (demo: %s)', store.file, store.state.demo === true)
    try {
      engine = await createEngine({ stateDir, ctx, log: line => ctx.logger?.info?.('superagent engine: %s', line) })
      await engine.start()
      ctx.effect(() => () => engine?.stop())
      ctx.logger?.info?.('superagent live engine: %s', engine.status().engine.phase)
    } catch (error) {
      ctx.logger?.warn?.('superagent live engine failed to start: %s', error instanceof Error ? error.message : String(error))
    }
    return result
  }).catch((error) => {
    ctx.logger?.error?.('superagent state failed to load: %s', error instanceof Error ? error.message : String(error))
  })

  const handler = async (req, res) => {
    try {
      await ready
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (!url.pathname.startsWith(PREFIX)) { send(res, 404, { error: 'not found' }); return }
      // Same-origin only: a page served by this Harness. The custom header makes blind cross-site posts fail too.
      const origin = req.headers.origin
      if (origin && req.headers.host && origin !== `http://${req.headers.host}`) { send(res, 403, { error: 'same-origin request required' }); return }
      if (req.headers['x-superagent-request'] !== '1') { send(res, 403, { error: 'x-superagent-request header required' }); return }
      const segments = segmentsOf(url.pathname)
      const method = req.method ?? 'GET'
      const body = method === 'GET' ? undefined : await readJson(req)
      const call = { host, req, res, query: url.searchParams, segments, body }

      // Entity routes with one id segment after a known collection.
      const [first, second, third] = segments
      // Live-engine control and observation surface (separate from the demo management API).
      if (first === 'engine') {
        if (!engine) throw new ActionError(503, 'live engine is not ready')
        if (method === 'GET' && second === 'status') {
          // P0: the status poll is the panel's clock, so derive the actionable inbox here (cheap, writes only on change).
          try { await engine.refreshInbox?.() } catch (error) {
            ctx.logger?.warn?.('superagent inbox refresh failed: %s', error instanceof Error ? error.message : String(error))
          }
          send(res, 200, engine.status())
          return
        }
        // Actionable inbox (P0-5): persistent "needs you" items derived from tickets/runs/sources.
        if (method === 'GET' && second === 'inbox') {
          await engine.refreshInbox?.()
          send(res, 200, engine.inboxView?.() ?? { items: [], counts: { blocking: 0, system: 0, unread: 0 } })
          return
        }
        if (method === 'POST' && second === 'inbox' && third && segments[3] === 'read') {
          const item = await engine.readInbox?.(third)
          if (!item) throw new ActionError(404, `未知待办：${third}`)
          send(res, 200, { item })
          return
        }
        if (method === 'POST' && second === 'inbox' && third && segments[3] === 'resolve') {
          const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : undefined
          try {
            const item = await engine.resolveInbox?.(third, { action: body?.action, note })
            if (!item) throw new ActionError(404, `未知待办：${third}`)
            send(res, 200, { item })
            return
          } catch (error) {
            // A blocking item can only be settled by its real action (gate release/retry/stop, accept, dismiss).
            if (error && error.code === 'inbox-blocking') throw new ActionError(409, '这是必须由动作解决的待办：请处理对应闸门或验收')
            throw error
          }
        }
        // P1-1: raw signals (including filtered/skipped events) and their decisions.
        if (method === 'GET' && second === 'signals') {
          send(res, 200, engine.signalsView?.({
            status: url.searchParams.get('status') ?? undefined,
            source: url.searchParams.get('source') ?? undefined,
            offset: Number(url.searchParams.get('offset') ?? 0),
            limit: Number(url.searchParams.get('limit') ?? 50),
          }) ?? { items: [], total: 0, counts: { all: 0, pending: 0, processed: 0, ignored: 0, skipped: 0, failed: 0 } })
          return
        }
        if (method === 'GET' && second === 'signal' && third) {
          const value = engine.signalView?.(third)
          if (!value) throw new ActionError(404, `未知信号：${third}`)
          send(res, 200, value)
          return
        }
        if (method === 'POST' && second === 'signal' && third && segments[3] === 'replay') {
          const result = await engine.replaySignal?.(third)
          if (!result) throw new ActionError(503, '信号重放不可用')
          if (result.missing) throw new ActionError(404, `未知信号：${third}`)
          if (result.invalid) throw new ActionError(409, result.invalid)
          send(res, 200, result)
          return
        }
        // P2-8: append a human quality label to one signal (correct / false wake / missed wake / cleared).
        if (method === 'POST' && second === 'signal' && third && segments[3] === 'label') {
          const result = await engine.labelSignal?.(third, {
            label: body?.label,
            note: typeof body?.note === 'string' ? body.note.trim().slice(0, 300) : undefined,
          })
          if (!result) throw new ActionError(503, '信号标注不可用')
          if (result.missing) throw new ActionError(404, `未知信号：${third}`)
          if (result.invalid) throw new ActionError(409, result.invalid)
          send(res, 200, { signal: result.signal })
          return
        }
        // P1-2: the full operation ledger (the status payload keeps only small index rows).
        if (method === 'GET' && second === 'operations') {
          send(res, 200, engine.operationsView?.({
            ticketId: url.searchParams.get('ticketId') ?? undefined,
            limit: Number(url.searchParams.get('limit') ?? 20),
          }) ?? { items: [] })
          return
        }
        if (method === 'GET' && second === 'operation' && third) {
          const value = engine.operationView?.(third)
          if (!value) throw new ActionError(404, `未知运行：${third}`)
          send(res, 200, value)
          return
        }
        // P2-9: run-quality rollup (no token/cost data; cost.available is false until the host exposes usage).
        if (method === 'GET' && second === 'metrics') {
          const window = url.searchParams.get('window') ?? '24h'
          if (!['24h', '7d', 'all'].includes(window)) throw new ActionError(400, 'window 必须是 24h / 7d / all')
          send(res, 200, engine.metricsView?.({ window }) ?? { window, generatedAt: new Date().toISOString() })
          return
        }
        if (method === 'GET' && second === 'config') { send(res, 200, engine.configView()); return }
        // Read-only group list for the settings picker; writes nothing and never polls messages.
        if (method === 'GET' && second === 'octo' && third === 'groups') {
          try { send(res, 200, await engine.listGroups()); return }
          catch (error) {
            throw new ActionError(400, `无法读取 Octo 群列表：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Add one repository definition; token values still go through the per-repo token route.
        if (method === 'POST' && second === 'repos') {
          try {
            const result = await engine.addRepo(body?.repo, { makeDefault: body?.makeDefault === true })
            send(res, 200, { ...result, config: engine.configView() })
            return
          } catch (error) {
            throw new ActionError(400, `保存仓库失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Store the Octo bot token in the configured token file (mode 600, never echoed back).
        if (method === 'POST' && second === 'octo' && third === 'token') {
          if (typeof body?.token !== 'string') throw new ActionError(400, 'token 必须是字符串')
          try {
            const saved = await engine.setOctoToken(body.token)
            send(res, 200, { octo: { tokenConfigured: saved.configured, tokenSource: saved.configured ? 'file' : null } })
            return
          } catch (error) {
            throw new ActionError(400, `保存 Octo token 失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        // Store the decision-model API key in the configured token file (mode 600, never echoed back). The shadow
        // judge reads it from there; no panel screen is needed for the pilot.
        if (method === 'POST' && second === 'eval' && third === 'token') {
          if (typeof body?.token !== 'string') throw new ActionError(400, 'token 必须是字符串')
          try {
            const decision = engine.readConfig().config.eval?.decision
            if (!decision?.tokenFile) throw new Error('eval.decision.tokenFile 未配置')
            const saved = await saveTokenFile(decision.tokenFile, body.token)
            send(res, 200, { eval: { decision: { tokenConfigured: saved.configured, tokenSource: saved.configured ? 'file' : null } } })
            return
          } catch (error) {
            throw new ActionError(400, `保存 decision token 失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (method === 'POST' && second === 'uat-check') {
          const config = engine.readConfig().config
          const repoId = body?.repoId ?? url.searchParams.get('repo')
          const repo = (repoId ? config.repos.find(item => item.id === repoId) : undefined)
            ?? config.repos.find(item => item.verifyMode === 'web-uat') ?? config.repos[0]
          if (!repo?.gitlab.uatUrl) throw new ActionError(400, `${repo?.name ?? '该仓库'} 没有配置 UAT 地址`)
          send(res, 200, { uat: await checkUat(repo.gitlab.uatUrl) })
          return
        }
        // Saved live.json versions and one-click rollback (tokens are separate files and are not in history).
        if (method === 'GET' && second === 'settings' && third === 'history') {
          send(res, 200, { entries: await engine.settingsHistory() })
          return
        }
        if (method === 'POST' && second === 'settings' && third === 'history' && segments[4] === 'restore') {
          const id = segments[3]
          if (!id) throw new ActionError(400, '缺少历史版本 id')
          try {
            const restored = await engine.restoreSettings(id)
            send(res, 200, { restored, config: engine.configView() })
            return
          } catch (error) {
            throw new ActionError(400, `恢复配置失败：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        if (method === 'POST' && second === 'settings') {
          const patch = body ?? {}
          // Group ↔ repository bindings must stay consistent: a bound chat has to be watched, and the repository has
          // to exist. Rejecting here keeps a half-written binding out of live.json.
          if ('octo.chatRepos' in patch || 'octo.watchChatIds' in patch) {
            const config = engine.readConfig().config
            const repoIds = new Set(config.repos.map(repo => repo.id))
            const watched = new Set('octo.watchChatIds' in patch ? patch['octo.watchChatIds'] : config.octo.watchChatIds ?? [])
            const bindings = 'octo.chatRepos' in patch ? patch['octo.chatRepos'] : config.octo.chatRepos ?? {}
            const unknownRepo = Object.values(bindings).find(repoId => !repoIds.has(repoId))
            if (unknownRepo) throw new ActionError(400, `未知仓库：${unknownRepo}`)
            const unboundChat = Object.keys(bindings).find(chatId => !watched.has(chatId))
            if (unboundChat) throw new ActionError(400, `群 ${unboundChat} 不在监听列表里`)
          }
          const result = await updateLiveConfig(engine.stateDir, patch)
          const reloaded = await engine.refresh()
          send(res, 200, { applied: result.applied, ...reloaded, config: engine.configView() })
          return
        }
        // Store one repository's GitLab token in the token file that repository already declares (never returns it).
        if (method === 'POST' && second === 'repo' && third && segments[3] === 'token') {
          const config = engine.readConfig().config
          const repo = config.repos.find(item => item.id === third)
          if (!repo) throw new ActionError(404, `未知仓库：${third}`)
          const saved = await saveRepoToken(repo, body?.token)
          send(res, 200, { repo: { id: repo.id, tokenConfigured: saved.configured } })
          return
        }
        if (method === 'POST' && second === 'reload') {
          send(res, 200, { reloaded: true, ...(await engine.refresh()), status: engine.status().engine })
          return
        }
        if (method === 'POST' && second === 'poll') {
          const dryRun = body?.dryRun !== false
          send(res, 200, await engine.pollOnce({ dryRun }))
          return
        }
        if (method === 'POST' && second === 'ticket' && third === undefined) {
          const repoId = body?.repoId
          if (repoId !== undefined && !engine.readConfig().config.repos.some(repo => repo.id === repoId)) {
            throw new ActionError(400, `未知仓库：${repoId}`)
          }
          const ticket = await injectTicket({ engine, title: body?.title, body: body?.body, channelId: body?.channelId,
            repoId })
          send(res, 200, { ticket })
          return
        }
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'run') {
          const dryRun = body?.dryRun === true
          if (!dryRun && !engine.configView().executor.enabled) throw new ActionError(403, 'executor.enabled is false in live.json (use dryRun)')
          if (!dryRun && engine.configView().executor.allowPush !== true) throw new ActionError(403, 'executor.allowPush is false in live.json')
          const work = executeTicket({ ctx, engine, ticketId: third, dryRun, log: line => ctx.logger?.info?.('superagent executor: %s', line) })
            .catch(error => { ctx.logger?.warn?.('executor failed: %s', error instanceof Error ? error.message : String(error)); return { status: 'failed', error: String(error) } })
          if (body?.wait === true) { send(res, 200, await work); return }
          void work
          send(res, 202, { started: true, ticketId: third, dryRun })
          return
        }
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'ci') {
          const result = await refreshTicketCi({ engine, ticketId: third })
          if (result?.status === 'deployed' || result?.status === 'merged') await engine.markAcceptanceDelivered?.(third)
          send(res, 200, result)
          return
        }
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'verify') {
          const result = await verifyTicket({ engine, ticketId: third })
          // P1 §4.2: a successful deployment/merge completes the latest verifying acceptance round.
          if (result?.status === 'deployed' || result?.status === 'merged') await engine.markAcceptanceDelivered?.(third)
          send(res, 200, result)
          return
        }
        // Human decision on a parked gate (P0-3): release = skip this gate and deliver, retry = re-run the gates,
        // stop = fail the Ticket. The worktree and the failing evidence stay on disk for all three.
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'gate') {
          const action = body?.action
          if (!['release', 'retry', 'stop'].includes(action)) {
            throw new ActionError(400, 'action 必须是 release / retry / stop')
          }
          const note = typeof body?.note === 'string' ? body.note.trim().slice(0, 500) : undefined
          const result = await resumeTicket({ engine, ticketId: third, action, note,
            log: line => ctx.logger?.info?.('superagent gate: %s', line) })
          if (result?.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result?.invalid) throw new ActionError(409, result.invalid)
          send(res, 200, { run: result.run, ticket: result.ticket })
          return
        }
        // P1-5: continue an interrupted run from its checkpoint (gates/commit/push/MR phase) or re-run the whole Ticket.
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'resume') {
          const result = await resumeInterruptedTicket({ engine, ticketId: third,
            log: line => ctx.logger?.info?.('superagent resume: %s', line) })
          if (result?.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result?.invalid) throw new ActionError(409, result.invalid)
          send(res, 200, { run: result.run, ticket: result.ticket })
          return
        }
        // P1-4: answer a worker's parked question; the Ticket re-runs with the answer in context.
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'answer') {
          const answer = typeof body?.answer === 'string' ? body.answer.trim().slice(0, 4000) : ''
          if (!answer) throw new ActionError(400, 'answer 不能为空')
          const result = await answerTicket({ engine, ticketId: third, answer,
            log: line => ctx.logger?.info?.('superagent answer: %s', line) })
          if (result?.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result?.invalid) throw new ActionError(409, result.invalid)
          send(res, 200, { run: result.run, ticket: result.ticket })
          return
        }
        // P2-1: per-Ticket automation (fixed interval / daily time), stored on the Ticket itself.
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'automation') {
          const result = await engine.setTicketAutomation?.(third, body ?? {})
          if (!result) throw new ActionError(503, 'Ticket 自动化不可用')
          if (result.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result.invalid) throw new ActionError(409, result.invalid)
          send(res, 200, { ticket: result.ticket, automation: result.automation })
          return
        }
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'publish') {
          send(res, 200, await publishTicket({ engine, ticketId: third, commitMessage: body?.commitMessage, log: line => ctx.logger?.info?.('superagent publish: %s', line) }))
          return
        }
        // Human acceptance of a deployed UAT build: records the sign-off so the Ticket leaves "needs you".
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'accept') {
          const intents = Array.isArray(body?.intents)
            ? body.intents.filter(value => ['unmet', 'new-idea', 'no-evidence'].includes(value)).slice(0, 5)
            : undefined
          const result = await engine.acceptTicket({ ticketId: third, ok: body?.ok !== false, note: body?.note, intents })
          if (result.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result.invalid) throw new ActionError(409, result.invalid)
          if (result.cleanupFailed) throw new ActionError(409, result.cleanupFailed)
          send(res, 200, { ticket: result.ticket, cleanup: result.cleanup })
          return
        }
        // Hide a failed/unused Ticket from the human queue; dismissal also removes its local branch/worktree.
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'dismiss') {
          const result = await engine.dismissTicket({ ticketId: third, note: body?.note })
          if (result.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result.invalid) throw new ActionError(409, result.invalid)
          if (result.cleanupFailed) throw new ActionError(409, result.cleanupFailed)
          send(res, 200, { ticket: result.ticket, cleanup: result.cleanup })
          return
        }
        // Append a human revision and rerun the Ticket as a dry run on the same worktree. The panel's "add a
        // requirement and rerun": validation lives in the engine, the run starts asynchronously like a manual run.
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'revision') {
          const result = await engine.addRevision(third, body?.text)
          if (result.missing) throw new ActionError(404, `未知工单：${third}`)
          if (result.invalid) throw new ActionError(409, result.invalid)
          void executeTicket({ ctx, engine, ticketId: third, dryRun: true, trigger: 'revise',
            log: line => ctx.logger?.info?.('superagent revision: %s', line) })
            .catch(error => ctx.logger?.warn?.('superagent revision failed: %s',
              error instanceof Error ? error.message : String(error)))
          send(res, 202, { started: true, dryRun: true, ticket: result.ticket, revision: result.revision })
          return
        }
        // Read-only collections for the redesigned pages (contract §4): raw records, details and filters.
        if (method === 'GET' && second === 'tickets') {
          send(res, 200, engine.ticketsView({ stage: url.searchParams.get('stage') ?? 'all' }))
          return
        }
        // The run's worktree diff, computed on demand: the panel reads it instead of a stored patch (P1 §3.2).
        if (method === 'GET' && second === 'ticket' && third && segments[3] === 'diff') {
          const value = await engine.ticketDiff(third, { runId: url.searchParams.get('runId') ?? undefined,
            path: url.searchParams.get('path') ?? undefined })
          if (!value) throw new ActionError(404, `未知工单：${third}`)
          send(res, 200, value)
          return
        }
        if (method === 'GET' && second === 'ticket' && third) {
          const value = engine.ticketView(third)
          if (!value) throw new ActionError(404, `未知工单：${third}`)
          send(res, 200, value)
          return
        }
        if (method === 'GET' && second === 'threads') {
          send(res, 200, engine.threadsView({ filter: url.searchParams.get('filter') ?? 'all' }))
          return
        }
        if (method === 'GET' && second === 'thread' && third) {
          const value = engine.threadView(third)
          if (!value) throw new ActionError(404, `未知线程：${third}`)
          send(res, 200, value)
          return
        }
        if (method === 'GET' && second === 'search') {
          send(res, 200, engine.searchView(url.searchParams.get('q') ?? ''))
          return
        }
        if (method === 'GET' && second === 'decisions') {
          send(res, 200, engine.decisionsView({ kind: url.searchParams.get('kind') ?? 'all',
            window: url.searchParams.get('window') ?? 'all',
            offset: Number(url.searchParams.get('offset') ?? 0), limit: Number(url.searchParams.get('limit') ?? 50) }))
          return
        }
        throw new ActionError(404, `未知引擎接口：${method} ${segments.slice(1).join('/')}`)
      }
      if (method === 'GET' && first === 'threads' && second) { const value = threadDetailView(host, second, url.searchParams.get('before') ?? undefined, Number(url.searchParams.get('limit') ?? 20))
        if (!value) throw new ActionError(404, '线程不存在'); send(res, 200, value); return }
      if (method === 'GET' && first === 'tickets' && second) { const value = ticketDetailView(host, second)
        if (!value) throw new ActionError(404, '工单不存在'); send(res, 200, value); return }
      if (method === 'POST' && first === 'threads' && third === 'unsubscribe') { send(res, 200, await unsubscribeThread(host, second)); return }
      if (method === 'POST' && first === 'triggers' && third === 'requeue') { send(res, 200, await requeueTrigger(host, second)); return }
      if (method === 'POST' && first === 'decisions' && third === 'dismiss') { send(res, 200, await dismissDecision(host, second)); return }
      if (method === 'POST' && first === 'tickets' && third === 'retry') { send(res, 200, await retryTicket(host, second)); return }
      if (method === 'POST' && first === 'tickets' && third === 'stop') { send(res, 200, await stopTicket(host, second)); return }
      if (method === 'POST' && first === 'sources' && third === 'labels') { send(res, 200, await syncSource(host, second)); return }
      if (method === 'POST' && first === 'policy-sync' && second) { send(res, 200, await syncSource(host, second)); return }
      if (method === 'PUT' && first === 'settings' && second) {
        const value = body ?? {}
        send(res, 200, await saveSettings(host, second, value.value, value.revision))
        return
      }
      if (method === 'PUT' && first === 'prompts') {
        const value = body ?? {}
        send(res, 200, await savePrompts(host, value.config, value.baseRevision, MACHINE_LIMITS.promptMaxChars))
        return
      }
      if (method === 'POST' && first === 'prompts' && second === 'preview') { send(res, 200, previewPromptsFor(host, body?.config ?? body ?? {})); return }
      if (method === 'POST' && first === 'executor' && second === 'pause') { send(res, 200, await setPaused(host, !!body?.paused)); return }
      if (method === 'POST' && first === 'setup' && second === 'check') { send(res, 200, await setupCheck(host).then(() => host.refreshSetup())); return }
      if (method === 'POST' && first === 'demo' && second === 'reset') { send(res, 200, await resetDemo(host)); return }

      const key = `${method} ${segments.join('/')}`
      const route = routes[key]
      if (route) { send(res, 200, await route({ host, query: url.searchParams, body })); return }
      send(res, 404, { error: `未知接口：${key}` })
    } catch (error) {
      if (error instanceof BodyTooLarge) { send(res, 413, { error: '请求体过大' }); return }
      if (error instanceof ActionError) { send(res, error.status, { error: error.message, ...error.extra }); return }
      ctx.logger?.warn?.('superagent api failed: %s', error instanceof Error ? error.stack ?? error.message : String(error))
      send(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }

  try {
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler }))
    ctx.logger?.info?.('superagent management API mounted at %s', PREFIX)
  } catch (error) {
    // A route collision must not take the whole profile down: the panel then reports the host as unreachable.
    ctx.logger?.error?.('superagent management API failed to mount: %s', error instanceof Error ? error.message : String(error))
  }
  return ready
}
