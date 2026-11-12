/**
 * Live-run configuration for the Superagent engine.
 *
 * The panel half keeps its demo document untouched; the engine reads one small JSON file in the state
 * directory (`live.json`, mode 600) so turning a real run on or off never needs a profile patch or a restart.
 * Credentials live in separate token files (also 600) and are never returned by the redacted view.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { normalizeRepos, repoSummary, repoToken, configRepos } from './repos.js'

/** Where the engine looks for its configuration and tokens. */
export const LIVE_CONFIG_NAME = 'live.json'
export const OCTO_TOKEN_NAME = 'octo.token'
export const GITLAB_TOKEN_NAME = 'gitlab.token'
/** API key for the System One decision model (shadow evaluation; see judge.js). */
export const DECISION_TOKEN_NAME = 'decision.token'

const DEFAULT_EXECUTOR = {
  enabled: false,
  autoRun: false,
  allowPush: false,
  allowReply: false,
  allowMerge: false,
  gates: ['standards', 'backend', 'frontend'],
  timeoutMs: 1_500_000,
  gateTimeoutMs: 600_000,
  // A worker whose session stops emitting events is declared lost after this window (60s..1h).
  workerIdleTimeoutMs: 300_000,
  model: null,
  // Worker backend: the in-process DSH agent (default) or a local CLI session (contract §13).
  workerBackend: 'dsh',
  workerModel: '',
  workerCommand: '',
}

/** Defaults used when a key is absent; the file only needs the values that differ. */
export function defaultLiveConfig(stateDir) {
  return {
    enabled: false,
    // Operator stop switch: while true the engine keeps its schedule but does not poll, verify, or auto-run tickets.
    paused: false,
    repo: '',
    baseBranch: 'dev',
    featurePrefix: 'feature/',
    worktreeRoot: join(stateDir, 'worktrees'),
    pollSeconds: 10,
    octo: {
      cliPath: 'octo-cli',
      tokenFile: join(stateDir, OCTO_TOKEN_NAME),
      intake: 'sync',
      watchChatIds: [],
      chatTitles: {},
      channelType: 2,
      allowSenderIds: [],
      allowAnyHuman: false,
      requireMention: false,
      botName: 'DSH_BOT',
      botUid: '',
      syncLimit: 100,
      backfill: false,
      replyPrefix: 'Superagent:',
    },
    gitlab: {
      baseUrl: '',
      project: '',
      tokenFile: join(stateDir, GITLAB_TOKEN_NAME),
      targetBranch: 'dev',
      createMr: 'api',
      uatUrl: '',
      healthUrl: '',
      verifySeconds: 120,
    },
    // Rule evaluation is the default and the only mode that decides today. `shadow` asks the decision model the same
    // question and stores its answer on the Decision (never acting on it); `llm` stays accepted for compatibility but
    // is still unimplemented, as before. See judge.js and README §决策模型 shadow.
    eval: {
      mode: 'rules',
      decision: {
        endpoint: '',
        model: '',
        tokenFile: join(stateDir, DECISION_TOKEN_NAME),
        timeoutMs: 6000,
        // 0.5 is calibrated from the labelled pilot: ticket-worthy messages scored P(repo_task) ≥ 0.71, non-tickets ≤ 0.26.
        acceptAt: 0.5,
        rejectAt: 0.2,
        riskAt: 0.5,
        maxPerPoll: 10,
        concurrency: 2,
      },
    },
    // Group confirmation loop: every evaluated candidate can be posted back to its source group and answered with
    // 「接单 A12」/「忽略 A12」; disabled by default (the operator enables it in live.json).
    review: {
      enabled: false,
      scope: 'all',
      allowSenderIds: [],
      expireHours: 24,
    },
    executor: { ...DEFAULT_EXECUTOR, gates: [...DEFAULT_EXECUTOR.gates] },
    // Multi-repository execution (#12): absent means the legacy single-repo file is used.
    repos: [],
    defaultRepo: undefined,
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const isProbability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
const stringMap = (value) => isObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' && item))
  : {}

// --- P1 worker routing: per-backend enablement plus one preference table (see routing.js) -------------------------
const ROUTED_BACKENDS = ['dsh', 'codex', 'claude']
const ROUTING_MODES = ['single', 'suggest', 'auto']
const WORK_TYPES = ['analysis', 'review', 'test', 'dev', 'docs', 'research', 'interactive']

/** One `executor.workers.<backend>` entry: enabled by default once the backend is listed; empty command/model allowed. */
function normalizeWorkerEntry(raw) {
  const entry = isObject(raw) ? raw : {}
  return {
    enabled: entry.enabled !== false,
    ...(typeof entry.command === 'string' ? { command: entry.command.trim() } : {}),
    ...(typeof entry.model === 'string' ? { model: entry.model.trim() } : {}),
  }
}

function normalizeWorkers(raw) {
  const workers = {}
  for (const backend of ROUTED_BACKENDS) {
    if (typeof raw[backend] === 'boolean') workers[backend] = normalizeWorkerEntry({ enabled: raw[backend] })
    else if (isObject(raw[backend])) workers[backend] = normalizeWorkerEntry(raw[backend])
  }
  return workers
}

function normalizeRouting(raw) {
  const routing = {
    ...(ROUTING_MODES.includes(raw.mode) ? { mode: raw.mode } : {}),
    ...(ROUTED_BACKENDS.includes(raw.defaultBackend) ? { defaultBackend: raw.defaultBackend } : {}),
    ...(Array.isArray(raw.fallback)
      ? { fallback: raw.fallback.filter((backend, index, list) => ROUTED_BACKENDS.includes(backend) && list.indexOf(backend) === index).slice(0, 2) }
      : {}),
    ...(Array.isArray(raw.preferences)
      ? {
        preferences: raw.preferences.flatMap(rule => {
          if (!isObject(rule) || !ROUTED_BACKENDS.includes(rule.backend)) return []
          const workTypes = (Array.isArray(rule.workTypes) ? rule.workTypes : [])
            .filter((type, index, list) => WORK_TYPES.includes(type) && list.indexOf(type) === index)
            .slice(0, WORK_TYPES.length)
          return workTypes.length ? [{ workTypes, backend: rule.backend }] : []
        }).slice(0, 10),
      }
      : {}),
  }
  return routing
}


/** Read one token file; a missing or empty file yields undefined instead of failing the whole engine. */
export function readToken(file) {
  if (typeof file !== 'string' || !file) return undefined
  try {
    const text = readFileSync(resolve(file), 'utf8').trim()
    return text || undefined
  } catch {
    return undefined
  }
}

/** Merge a parsed file over the defaults, keeping only the keys the engine understands. */
function mergeConfig(base, raw) {
  if (!isObject(raw)) return base
  const config = {
    ...base,
    ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}),
    ...(typeof raw.paused === 'boolean' ? { paused: raw.paused } : {}),
    ...(typeof raw.repo === 'string' ? { repo: raw.repo } : {}),
    ...(typeof raw.baseBranch === 'string' && raw.baseBranch ? { baseBranch: raw.baseBranch } : {}),
    ...(typeof raw.featurePrefix === 'string' && raw.featurePrefix ? { featurePrefix: raw.featurePrefix } : {}),
    ...(typeof raw.worktreeRoot === 'string' && raw.worktreeRoot ? { worktreeRoot: raw.worktreeRoot } : {}),
    ...(Number.isFinite(raw.pollSeconds) && raw.pollSeconds >= 2 ? { pollSeconds: Math.floor(raw.pollSeconds) } : {}),
    ...(typeof raw.defaultRepo === 'string' && raw.defaultRepo ? { defaultRepo: raw.defaultRepo } : {}),
    ...(Array.isArray(raw.repos) ? { repos: raw.repos.filter(item => isObject(item)) } : {}),
  }
  if (isObject(raw.octo)) config.octo = {
    ...config.octo,
    ...(typeof raw.octo.cliPath === 'string' ? { cliPath: raw.octo.cliPath } : {}),
    ...(typeof raw.octo.tokenFile === 'string' ? { tokenFile: raw.octo.tokenFile } : {}),
    ...(raw.octo.intake === 'events' || raw.octo.intake === 'sync' ? { intake: raw.octo.intake } : {}),
    ...(Array.isArray(raw.octo.watchChatIds) ? { watchChatIds: raw.octo.watchChatIds.filter(value => typeof value === 'string' && value) } : {}),
    ...(isObject(raw.octo.chatTitles) ? { chatTitles: Object.fromEntries(Object.entries(raw.octo.chatTitles).filter(([, value]) => typeof value === 'string')) } : {}),
    ...(typeof raw.octo.botUid === 'string' ? { botUid: raw.octo.botUid } : {}),
    ...(Number.isFinite(raw.octo.syncLimit) && raw.octo.syncLimit > 0 ? { syncLimit: Math.min(200, Math.floor(raw.octo.syncLimit)) } : {}),
    ...(typeof raw.octo.backfill === 'boolean' ? { backfill: raw.octo.backfill } : {}),
    ...(typeof raw.octo.replyPrefix === 'string' ? { replyPrefix: raw.octo.replyPrefix } : {}),
    ...(Number.isFinite(raw.octo.channelType) ? { channelType: Math.floor(raw.octo.channelType) } : {}),
    ...(Array.isArray(raw.octo.allowSenderIds) ? { allowSenderIds: raw.octo.allowSenderIds.filter(value => typeof value === 'string' && value) } : {}),
    ...(typeof raw.octo.allowAnyHuman === 'boolean' ? { allowAnyHuman: raw.octo.allowAnyHuman } : {}),
    ...(typeof raw.octo.requireMention === 'boolean' ? { requireMention: raw.octo.requireMention } : {}),
    ...(typeof raw.octo.botName === 'string' ? { botName: raw.octo.botName } : {}),
    ...(isObject(raw.octo.chatRepos) ? { chatRepos: stringMap(raw.octo.chatRepos) } : {}),
  }
  if (isObject(raw.gitlab)) config.gitlab = {
    ...config.gitlab,
    ...(typeof raw.gitlab.baseUrl === 'string' ? { baseUrl: raw.gitlab.baseUrl.replace(/\/$/, '') } : {}),
    ...(typeof raw.gitlab.project === 'string' ? { project: raw.gitlab.project } : {}),
    ...(typeof raw.gitlab.tokenFile === 'string' ? { tokenFile: raw.gitlab.tokenFile } : {}),
    ...(typeof raw.gitlab.targetBranch === 'string' ? { targetBranch: raw.gitlab.targetBranch } : {}),
    ...(raw.gitlab.createMr === 'push' || raw.gitlab.createMr === 'api' ? { createMr: raw.gitlab.createMr } : {}),
    ...(typeof raw.gitlab.uatUrl === 'string' ? { uatUrl: raw.gitlab.uatUrl } : {}),
    ...(typeof raw.gitlab.healthUrl === 'string' ? { healthUrl: raw.gitlab.healthUrl } : {}),
    ...(Number.isFinite(raw.gitlab.verifySeconds) && raw.gitlab.verifySeconds > 0
      ? { verifySeconds: Math.max(30, Math.floor(raw.gitlab.verifySeconds)) } : {}),
  }
  if (isObject(raw.review)) {
    const review = raw.review
    config.review = {
      ...config.review,
      ...(typeof review.enabled === 'boolean' ? { enabled: review.enabled } : {}),
      ...(review.scope === 'all' || review.scope === 'uncertain' ? { scope: review.scope } : {}),
      ...(Array.isArray(review.allowSenderIds)
        ? { allowSenderIds: review.allowSenderIds.filter(value => typeof value === 'string' && value) } : {}),
      ...(Number.isFinite(review.expireHours) && review.expireHours >= 1
        ? { expireHours: Math.min(24 * 7, Math.floor(review.expireHours)) } : {}),
    }
  }
  if (isObject(raw.eval)) {
    const current = isObject(config.eval) ? config.eval : { mode: 'rules' }
    let mode = current.mode
    if (typeof raw.eval.mode === 'string' && ['rules', 'llm', 'shadow', 'hybrid'].includes(raw.eval.mode)) mode = raw.eval.mode
    const decision = { ...(current.decision ?? {}) }
    if (isObject(raw.eval.decision)) {
      const d = raw.eval.decision
      if (typeof d.endpoint === 'string') decision.endpoint = d.endpoint.trim()
      if (typeof d.model === 'string') decision.model = d.model.trim()
      if (typeof d.tokenFile === 'string' && d.tokenFile.trim()) decision.tokenFile = d.tokenFile.trim()
      if (Number.isFinite(d.timeoutMs) && d.timeoutMs >= 500) decision.timeoutMs = Math.min(30_000, Math.floor(d.timeoutMs))
      if (isProbability(d.acceptAt)) decision.acceptAt = d.acceptAt
      if (isProbability(d.rejectAt)) decision.rejectAt = d.rejectAt
      if (isProbability(d.riskAt)) decision.riskAt = d.riskAt
      if (Number.isFinite(d.maxPerPoll) && d.maxPerPoll >= 0) decision.maxPerPoll = Math.min(50, Math.floor(d.maxPerPoll))
      if (Number.isFinite(d.concurrency) && d.concurrency >= 1) decision.concurrency = Math.min(4, Math.floor(d.concurrency))
    }
    config.eval = { mode, decision }
  }
  if (isObject(raw.executor)) {
    const e = raw.executor
    config.executor = {
      ...config.executor,
      ...(typeof e.enabled === 'boolean' ? { enabled: e.enabled } : {}),
      ...(typeof e.autoRun === 'boolean' ? { autoRun: e.autoRun } : {}),
      ...(typeof e.allowPush === 'boolean' ? { allowPush: e.allowPush } : {}),
      ...(typeof e.allowReply === 'boolean' ? { allowReply: e.allowReply } : {}),
      ...(typeof e.allowMerge === 'boolean' ? { allowMerge: e.allowMerge } : {}),
      ...(Array.isArray(e.gates) ? { gates: e.gates.filter(value => ['standards', 'backend', 'frontend'].includes(value)) } : {}),
      ...(Number.isFinite(e.timeoutMs) && e.timeoutMs >= 60_000 ? { timeoutMs: Math.floor(e.timeoutMs) } : {}),
      ...(Number.isFinite(e.gateTimeoutMs) && e.gateTimeoutMs >= 30_000 ? { gateTimeoutMs: Math.floor(e.gateTimeoutMs) } : {}),
      // Idle watchdog: a silent worker is declared lost after this window (60s..1h).
      ...(Number.isFinite(e.workerIdleTimeoutMs) && e.workerIdleTimeoutMs >= 60_000 && e.workerIdleTimeoutMs <= 3_600_000
        ? { workerIdleTimeoutMs: Math.floor(e.workerIdleTimeoutMs) } : {}),
      // P2-2: automatic repair rounds for gates that opt in with onFail='auto_repair' (0..3, default 1).
      ...(Number.isFinite(e.maxRepairRounds) && e.maxRepairRounds >= 0 && e.maxRepairRounds <= 3
        ? { maxRepairRounds: Math.floor(e.maxRepairRounds) } : {}),
      ...(isObject(e.model) && typeof e.model.provider === 'string' && typeof e.model.model === 'string' ? { model: e.model } : {}),
      ...(e.workerBackend === 'dsh' || e.workerBackend === 'codex' || e.workerBackend === 'claude'
        ? { workerBackend: e.workerBackend } : {}),
      ...(typeof e.workerModel === 'string' ? { workerModel: e.workerModel } : {}),
      ...(typeof e.workerCommand === 'string' ? { workerCommand: e.workerCommand } : {}),
      // P1 multi-backend routing: a map of enabled backends and one preference table. Absent keeps the legacy
      // single-backend behaviour exactly as before.
      ...(isObject(e.workers) ? { workers: normalizeWorkers(e.workers) } : {}),
      ...(['off', 'auto', 'simple', 'planned'].includes(e.workflowMode) ? { workflowMode: e.workflowMode } : {}),
      ...(['dsh', 'claude'].includes(e.implementer) ? { implementer: e.implementer } : {}),
      ...(isObject(e.routing) ? { routing: normalizeRouting(e.routing) } : {}),
    }
  }
  return config
}

/** Read the live configuration and its secrets; `exists` says whether the file is present at all. */
export function loadLiveConfig(stateDir) {
  const file = join(stateDir, LIVE_CONFIG_NAME)
  const defaults = defaultLiveConfig(stateDir)
  let raw
  let exists = false
  try {
    if (existsSync(file)) {
      exists = true
      raw = JSON.parse(readFileSync(file, 'utf8'))
    }
  } catch (error) {
    return { file, exists: true, config: defaults, error: `live.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      tokens: { octo: undefined, octoSource: null, gitlab: undefined, repoTokens: {}, decision: undefined, decisionSource: null } }
  }
  const config = normalizeRepos(mergeConfig(defaults, raw))
  const octoFromFile = readToken(config.octo.tokenFile)
  const octoFromEnv = process.env.OCTO_TOKEN || undefined
  const octoToken = octoFromFile ?? octoFromEnv
  // The decision model is optional: a missing file simply leaves shadow mode unconfigured (status says why).
  const decisionFromFile = readToken(config.eval?.decision?.tokenFile)
  const decisionFromEnv = process.env.DECISION_TOKEN || undefined
  const decisionToken = decisionFromFile ?? decisionFromEnv
  const repoTokens = {}
  for (const repo of config.repos) {
    const fromFile = readToken(repo.gitlab.tokenFile)
    const fromEnv = repo.id === config.repos[0].id ? process.env.GITLAB_TOKEN : undefined
    repoTokens[repo.id] = fromFile ?? fromEnv
  }
  return {
    file,
    exists,
    config,
    error: undefined,
    tokens: {
      octo: octoToken,
      // Where the effective token came from; the file wins so a UI-saved token is not surprised by an old env.
      octoSource: octoFromFile ? 'file' : octoFromEnv ? 'env' : null,
      // Legacy single-repository seam: the first repository's token.
      gitlab: repoTokens[config.repos[0].id],
      repoTokens,
      decision: decisionToken,
      decisionSource: decisionFromFile ? 'file' : decisionFromEnv ? 'env' : null,
    },
  }
}

/** A config view safe to send to the browser: token file paths are reduced to booleans. */
export function redactedLiveConfig(loaded) {
  const { config, tokens } = loaded
  const repos = configRepos(config)
  const first = repos[0]
  const { tokenFile: firstTokenFile, ...firstGitlab } = first.gitlab
  const { tokenFile: _octoTokenFile, ...octoSafe } = config.octo
  // The decision model's token path is file-only as well: the browser sees whether a token exists, never where it lives.
  const { tokenFile: _decisionTokenFile, ...decisionSafe } = config.eval?.decision ?? {}
  return {
    file: loaded.file,
    exists: loaded.exists,
    error: loaded.error ?? null,
    enabled: config.enabled,
    paused: config.paused,
    // Legacy single-repository fields mirror the first (default) repository for older callers and pages.
    repo: first.repo,
    baseBranch: first.baseBranch,
    featurePrefix: first.featurePrefix,
    worktreeRoot: first.worktreeRoot,
    pollSeconds: config.pollSeconds,
    octo: { ...octoSafe, tokenConfigured: !!tokens.octo, tokenSource: tokens.octoSource ?? null },
    gitlab: { ...firstGitlab, tokenConfigured: !!repoToken(loaded, first) },
    eval: {
      ...(config.eval ?? { mode: 'rules' }),
      decision: { ...decisionSafe, tokenConfigured: !!tokens.decision, tokenSource: tokens.decisionSource ?? null },
    },
    review: config.review,
    executor: config.executor,
    repos: repos.map(repo => repoSummary(loaded, repo)),
    defaultRepo: config.defaultRepo,
  }
}
