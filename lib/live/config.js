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

const DEFAULT_EXECUTOR = {
  enabled: false,
  autoRun: false,
  allowPush: false,
  allowReply: false,
  allowMerge: false,
  gates: ['standards', 'backend', 'frontend'],
  timeoutMs: 1_500_000,
  gateTimeoutMs: 600_000,
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
    eval: { mode: 'rules' },
    executor: { ...DEFAULT_EXECUTOR, gates: [...DEFAULT_EXECUTOR.gates] },
    // Multi-repository execution (#12): absent means the legacy single-repo file is used.
    repos: [],
    defaultRepo: undefined,
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const stringMap = (value) => isObject(value)
  ? Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string' && item))
  : {}

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
  if (isObject(raw.eval) && (raw.eval.mode === 'rules' || raw.eval.mode === 'llm')) config.eval = { mode: raw.eval.mode }
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
      ...(isObject(e.model) && typeof e.model.provider === 'string' && typeof e.model.model === 'string' ? { model: e.model } : {}),
      ...(e.workerBackend === 'dsh' || e.workerBackend === 'codex' || e.workerBackend === 'claude'
        ? { workerBackend: e.workerBackend } : {}),
      ...(typeof e.workerModel === 'string' ? { workerModel: e.workerModel } : {}),
      ...(typeof e.workerCommand === 'string' ? { workerCommand: e.workerCommand } : {}),
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
      tokens: { octo: undefined, gitlab: undefined } }
  }
  const config = normalizeRepos(mergeConfig(defaults, raw))
  const octoToken = readToken(config.octo.tokenFile) ?? (process.env.OCTO_TOKEN || undefined)
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
      // Legacy single-repository seam: the first repository's token.
      gitlab: repoTokens[config.repos[0].id],
      repoTokens,
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
    octo: { ...octoSafe, tokenConfigured: !!tokens.octo },
    gitlab: { ...firstGitlab, tokenConfigured: !!repoToken(loaded, first) },
    eval: config.eval,
    executor: config.executor,
    repos: repos.map(repo => repoSummary(loaded, repo)),
    defaultRepo: config.defaultRepo,
  }
}
