/**
 * Host half of the Superagent management panel.
 *
 * Owns the durable management state (~/.dsh/superagent by default, override with DSH_SUPERAGENT_STATE_DIR),
 * serves it to the panel over same-origin `/superagent/api` routes on the Harness Web server, and implements
 * the panel's actions: settings/prompt saves with revisions, ticket retry/stop, decision dismiss, trigger
 * requeue, thread unsubscribe, executor pause, and a real deployment check of the configured GitHub CLI.
 *
 * It does not run the research prototype's engine (GitHub/Feishu polling, LLM assessment, worker Sessions);
 * `README.md` states exactly which capabilities are live and which are represented by the seeded demo state.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Store } from './lib/store.js'
import { stateView, overviewView, searchView, sourcesView, settingsView, threadListView, threadDetailView,
  decisionListView, ticketListView, ticketDetailView, historyView, promptsView, modelsView } from './lib/views.js'
import { saveSettings, syncSource, setPaused, retryTicket, stopTicket, dismissDecision, requeueTrigger, unsubscribeThread,
  savePrompts, previewPromptsFor, setupCheck, resetDemo, ActionError } from './lib/actions.js'
import { createEngine } from './lib/live/engine.js'
import { updateLiveConfig, saveRepoToken } from './lib/live/live-json.js'
import { executeTicket, refreshTicketCi, injectTicket, publishTicket, checkUat, verifyTicket } from './lib/live/executor.js'

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
        if (method === 'GET' && second === 'status') { send(res, 200, engine.status()); return }
        if (method === 'GET' && second === 'config') { send(res, 200, engine.configView()); return }
        if (method === 'POST' && second === 'uat-check') {
          const config = engine.readConfig().config
          const repoId = body?.repoId ?? url.searchParams.get('repo')
          const repo = (repoId ? config.repos.find(item => item.id === repoId) : undefined)
            ?? config.repos.find(item => item.verifyMode === 'web-uat') ?? config.repos[0]
          if (!repo?.gitlab.uatUrl) throw new ActionError(400, `${repo?.name ?? '该仓库'} 没有配置 UAT 地址`)
          send(res, 200, { uat: await checkUat(repo.gitlab.uatUrl) })
          return
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
          send(res, 200, await refreshTicketCi({ engine, ticketId: third }))
          return
        }
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'verify') {
          send(res, 200, await verifyTicket({ engine, ticketId: third }))
          return
        }
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'publish') {
          send(res, 200, await publishTicket({ engine, ticketId: third, commitMessage: body?.commitMessage, log: line => ctx.logger?.info?.('superagent publish: %s', line) }))
          return
        }
        // Human acceptance of a deployed UAT build: records the sign-off so the Ticket leaves "needs you".
        if (method === 'POST' && second === 'ticket' && third && segments[3] === 'accept') {
          const result = await engine.acceptTicket({ ticketId: third, ok: body?.ok !== false, note: body?.note })
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
        // Read-only collections for the redesigned pages (contract §4): raw records, details and filters.
        if (method === 'GET' && second === 'tickets') {
          send(res, 200, engine.ticketsView({ stage: url.searchParams.get('stage') ?? 'all' }))
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
