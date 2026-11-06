/**
 * Multi-repository registry for the live engine.
 *
 * `live.json` can describe several GitLab repositories (`repos: [...]`), each with its own local clone, branches,
 * gates and verification mode. Older single-repository files (top-level `repo`, `baseBranch`, `gitlab`, …) are
 * normalised into exactly one repository, so every caller can rely on `config.repos` being populated.
 *
 * Verification modes:
 * - `web-uat`   — a web application with CI, a dev pipeline and a UAT URL (demo-legacy-repo). Existing fingerprint/health logic.
 * - `manual`    — a repository whose acceptance happens outside GitLab (bpit/ebs: object import/compile in Oracle
 *                 EBS). Only the merge into the target branch is observed automatically; a person accepts on the panel.
 */

/** Built-in gate commands for the legacy gate names (`executor.gates: ['standards', …]`). */
export const BUILTIN_GATES = {
  standards: { command: 'python3 scripts/standards_check.py' },
  backend: { command: 'cd ebs && mvn -B -ntp test' },
  frontend: { command: 'pnpm lint && pnpm typecheck && pnpm test:web' },
}

/** Default gates for a repository that does not list its own gates. */
export function defaultGatesFor(kind = 'web') {
  if (kind === 'oracle-ebs') {
    return [{
      name: 'ebs-deploy',
      command: 'python3 scripts/local/deploy_object.py',
      dryRunCommand: 'python3 scripts/local/deploy_object.py --dry-run',
      passChangedFiles: true,
      requireOutput: '待部署对象',
      timeoutMs: 1_800_000,
    }, {
      name: 'ebs-access',
      command: 'python3 scripts/local/apply_sql_script.py',
      dryRunCommand: 'python3 scripts/local/apply_sql_script.py --dry-run',
      passChangedFiles: true,
      requireOutput: 'ACCESS 脚本',
      timeoutMs: 600_000,
    }]
  }
  return Object.entries(BUILTIN_GATES).map(([name, spec]) => ({ name, ...spec }))
}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const strings = value => Array.isArray(value) ? value.filter(item => typeof item === 'string' && item.trim()).map(item => item.trim()) : []

/** Repository id: explicit, else the last segment of the GitLab project, else a positional fallback. */
export function repoIdOf(raw, index = 0, fallbackProject) {
  const explicit = typeof raw?.id === 'string' && raw.id.trim()
  if (explicit) return raw.id.trim()
  const project = raw?.gitlab?.project ?? fallbackProject
  const segment = typeof project === 'string' && project ? project.split('/').filter(Boolean).at(-1) : undefined
  return segment ? segment.replace(/[^A-Za-z0-9._-]/g, '-') : `repo-${index + 1}`
}

/** Normalise a gate list: names resolve through BUILTIN_GATES; objects keep their own command. */
export function normalizeGates(gates, kind = 'web') {
  const list = Array.isArray(gates) ? gates : []
  const normalized = []
  for (const entry of list) {
    if (typeof entry === 'string') {
      const builtin = BUILTIN_GATES[entry]
      if (builtin) normalized.push({ name: entry, ...builtin })
      continue
    }
    if (!isObject(entry) || typeof entry.command !== 'string' || !entry.command.trim()) continue
    normalized.push({
      name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : `gate-${normalized.length + 1}`,
      command: entry.command.trim(),
      ...typeof entry.dryRunCommand === 'string' && entry.dryRunCommand.trim() ? { dryRunCommand: entry.dryRunCommand.trim() } : {},
      ...entry.passChangedFiles === true ? { passChangedFiles: true } : {},
      ...typeof entry.requireOutput === 'string' && entry.requireOutput.trim() ? { requireOutput: entry.requireOutput.trim() } : {},
      ...Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0 ? { timeoutMs: Math.floor(entry.timeoutMs) } : {},
    })
  }
  if (!normalized.length) return defaultGatesFor(kind)
  return normalized
}

/**
 * Normalise one repository entry. `base` is the merged legacy config (top-level repo/baseBranch/gitlab/executor),
 * used for every field the entry does not set, so an older file stays valid.
 */
export function normalizeRepo(raw, base, index = 0, fallbackProject) {
  const gitlab = isObject(raw?.gitlab) ? raw.gitlab : {}
  const kind = raw?.kind === 'oracle-ebs' ? 'oracle-ebs' : 'web'
  const baseBranch = typeof raw?.baseBranch === 'string' && raw.baseBranch ? raw.baseBranch : base.baseBranch
  const verifyMode = raw?.verifyMode === 'manual' || raw?.verifyMode === 'web-uat'
    ? raw.verifyMode
    : kind === 'oracle-ebs' ? 'manual' : 'web-uat'
  const targetBranch = typeof gitlab.targetBranch === 'string' && gitlab.targetBranch
    ? gitlab.targetBranch
    : verifyMode === 'manual' ? baseBranch : base.gitlab.targetBranch
  return {
    id: repoIdOf(raw, index, fallbackProject),
    name: typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : repoIdOf(raw, index, fallbackProject),
    kind,
    repo: typeof raw?.repo === 'string' && raw.repo.trim() ? raw.repo.trim() : base.repo,
    baseBranch,
    featurePrefix: typeof raw?.featurePrefix === 'string' && raw.featurePrefix ? raw.featurePrefix : base.featurePrefix,
    worktreeRoot: typeof raw?.worktreeRoot === 'string' && raw.worktreeRoot ? raw.worktreeRoot : base.worktreeRoot,
    verifyMode,
    acceptance: raw?.acceptance === 'merged' || raw?.acceptance === 'deployed'
      ? raw.acceptance
      : verifyMode === 'manual' ? 'merged' : 'deployed',
    gitlab: {
      baseUrl: typeof gitlab.baseUrl === 'string' && gitlab.baseUrl ? gitlab.baseUrl.replace(/\/$/, '') : base.gitlab.baseUrl,
      project: typeof gitlab.project === 'string' && gitlab.project ? gitlab.project : base.gitlab.project,
      targetBranch,
      createMr: gitlab.createMr === 'push' || gitlab.createMr === 'api' ? gitlab.createMr : base.gitlab.createMr,
      tokenFile: typeof gitlab.tokenFile === 'string' && gitlab.tokenFile ? gitlab.tokenFile : base.gitlab.tokenFile,
      // The UAT surface belongs to the base legacy file too: without this fallback a normalised single repository
      // would lose demo-legacy-repo' uatUrl/healthUrl and the web verification would have nothing to check. Manual repositories
      // never inherit it — they have no web UAT (their verification is manual acceptance after the merge).
      ...typeof gitlab.uatUrl === 'string' && gitlab.uatUrl ? { uatUrl: gitlab.uatUrl }
        : verifyMode !== 'manual' && typeof base.gitlab.uatUrl === 'string' && base.gitlab.uatUrl ? { uatUrl: base.gitlab.uatUrl } : {},
      ...typeof gitlab.healthUrl === 'string' && gitlab.healthUrl ? { healthUrl: gitlab.healthUrl }
        : verifyMode !== 'manual' && typeof base.gitlab.healthUrl === 'string' && base.gitlab.healthUrl ? { healthUrl: base.gitlab.healthUrl } : {},
      ci: typeof gitlab.ci === 'boolean' ? gitlab.ci : kind !== 'oracle-ebs',
      verifySeconds: Number.isFinite(gitlab.verifySeconds) && gitlab.verifySeconds > 0
        ? Math.max(30, Math.floor(gitlab.verifySeconds)) : base.gitlab.verifySeconds,
    },
    gates: normalizeGates(raw?.gates ?? (index === 0 ? base.executor?.gates : undefined), kind),
    prepareCommand: typeof raw?.prepareCommand === 'string' ? raw.prepareCommand.trim() : '',
    postGatesCommand: typeof raw?.postGatesCommand === 'string' ? raw.postGatesCommand.trim() : '',
    workerInstructions: strings(raw?.workerInstructions),
    protectedPaths: strings(raw?.protectedPaths),
  }
}

/**
 * Ensure `config.repos` / `config.defaultRepo` / `config.octo.chatRepos` exist. A legacy config yields one repository
 * built from the top-level fields; `defaultRepo` falls back to the first repository; chat bindings that point at an
 * unknown repository are dropped (with no repo the engine must not silently route a ticket somewhere else).
 */
export function normalizeRepos(config) {
  const raw = Array.isArray(config.repos) ? config.repos.filter(isObject) : []
  const fallbackProject = config.gitlab?.project
  const repos = raw.length
    ? raw.map((entry, index) => normalizeRepo(entry, config, index, fallbackProject))
    : [normalizeRepo({ id: undefined, name: undefined, kind: 'web' }, config, 0, fallbackProject)]
  // Duplicate ids would make routing ambiguous: keep the first occurrence.
  const seen = new Set()
  const unique = repos.filter(repo => { if (seen.has(repo.id)) return false; seen.add(repo.id); return true })
  const byId = new Map(unique.map(repo => [repo.id, repo]))
  const requestedDefault = typeof config.defaultRepo === 'string' ? config.defaultRepo : undefined
  const defaultRepo = requestedDefault && byId.has(requestedDefault) ? requestedDefault : unique[0].id
  const chatRepos = {}
  for (const [chatId, repoId] of Object.entries(isObject(config.octo?.chatRepos) ? config.octo.chatRepos : {})) {
    if (typeof repoId === 'string' && byId.has(repoId)) chatRepos[String(chatId)] = repoId
  }
  return { ...config, repos: unique, defaultRepo, octo: { ...config.octo, chatRepos } }
}

/** Every configured repository; a config object that was not normalised (tests, callers with a partial config) is
 *  treated as the legacy single-repository file so lookups never fail on a missing `repos` array. */
export function configRepos(config) {
  if (Array.isArray(config?.repos) && config.repos.length) return config.repos
  return [normalizeRepo({}, config ?? {}, 0, config?.gitlab?.project)]
}

/** The repository a record belongs to; legacy records without `repoId` use the default repository. */
export function repoOf(config, id) {
  const repos = configRepos(config)
  return repos.find(repo => repo.id === id) ?? repos.find(repo => repo.id === config?.defaultRepo) ?? repos[0]
}

/** The repository of a ticket (persisted `ticket.repoId`, default repository otherwise). */
export function ticketRepo(config, ticket) {
  return repoOf(config, ticket?.repoId)
}

/** Token for one repository; the legacy single `gitlab.tokenFile` also backs the first repository. */
export function repoToken(loaded, repo) {
  if (!repo) return undefined
  const tokens = loaded?.tokens ?? {}
  if (tokens.repoTokens && Object.prototype.hasOwnProperty.call(tokens.repoTokens, repo.id)) return tokens.repoTokens[repo.id]
  if (configRepos(loaded?.config)[0]?.id === repo.id) return tokens.gitlab
  return undefined
}

/** Redacted repository summary used by the panel (`status.repos` and `config.repos`). */
export function repoSummary(loaded, repo) {
  return {
    id: repo.id,
    name: repo.name,
    kind: repo.kind,
    repo: repo.repo,
    baseBranch: repo.baseBranch,
    targetBranch: repo.gitlab.targetBranch,
    project: repo.gitlab.project,
    baseUrl: repo.gitlab.baseUrl,
    tokenConfigured: Boolean(repoToken(loaded, repo)),
    verifyMode: repo.verifyMode,
    acceptance: repo.acceptance,
    gates: repo.gates.map(gate => gate.name),
    ...repo.gitlab.uatUrl ? { uatUrl: repo.gitlab.uatUrl } : {},
  }
}

/** Derived repository fields attached to ticket payloads (never persisted). */
export function decorateTicket(config, ticket) {
  const repo = ticketRepo(config, ticket)
  if (!repo) return ticket
  return { ...ticket, repoId: repo.id, repoName: repo.name, repoKind: repo.kind,
    repoVerifyMode: repo.verifyMode, repoAcceptance: repo.acceptance }
}
