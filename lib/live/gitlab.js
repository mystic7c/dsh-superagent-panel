/**
 * GitLab REST v4 client for the Superagent executor. Works against any self-hosted
 * GitLab instance and project configured in `live.json`.
 *
 * The client is deliberately narrow: project lookup, merge requests, pipelines/jobs and
 * notes. It never logs, never puts the token in a URL, and redacts the token from every
 * error message it builds. `fetch` is injected so tests never touch the network.
 *
 * Notices for the executor:
 * - GitLab returns `[]` from the MR pipelines endpoint until a pipeline is created for the
 *   merge request, and `pipelineStatusOf([])` reports `{ status: 'none', pipelineId: null }`.
 * - `getJobTrace()` keeps the END of a trace (the failing step normally sits there) and caps
 *   it at `maxBytes` UTF-8 bytes.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_USER_AGENT = 'superagent-panel/0.1.0'
const DEFAULT_TRACE_BYTES = 20_000
const MAX_ERROR_EXCERPT = 500
const REDACTED = '[redacted]'

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])
const DEFAULT_MAX_PAGES = 10
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** `Retry-After` as milliseconds, bounded so a hostile header cannot park the caller for minutes. */
function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after')
  const seconds = Number(header)
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined
  return Math.min(seconds * 1000, 5_000)
}

const PENDING_JOB_STATUSES = new Set([
  'pending',
  'created',
  'preparing',
  'waiting_for_resource',
  'scheduled',
])

/** Error raised by this client; `status` is 0 for local/config/timeout failures. */
export class GitlabError extends Error {
  constructor(message, { status, body, cause } = /** @type {Record<string, any>} */ ({})) {
    super(message)
    this.name = 'GitlabError'
    if (status !== undefined) this.status = status
    if (body !== undefined) this.body = body
    if (cause !== undefined) this.cause = cause
  }
}

/** Read one token file, returning undefined for a missing/unreadable/empty file. */
function tokenFromFile(file) {
  if (typeof file !== 'string' || !file) return undefined
  try {
    const value = readFileSync(resolve(file), 'utf8').trim()
    return value || undefined
  } catch {
    return undefined
  }
}

function resolveToken(options) {
  if (options.token !== undefined && options.token !== null) {
    const value = String(options.token).trim()
    return value || undefined
  }
  return tokenFromFile(options.tokenFile)
}

function normalizeBaseUrl(value) {
  return String(value ?? '').trim().replace(/\/+$/, '')
}

function normalizeProject(value) {
  return String(value ?? '').trim().replace(/^\/+|\/+$/g, '')
}

/** Append non-empty query parameters without ever creating a double slash. */
function withQuery(url, query) {
  if (!query) return url
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    params.append(key, String(value))
  }
  const encoded = params.toString()
  return encoded ? `${url}?${encoded}` : url
}

/** Flatten the shapes GitLab uses for errors: `{message}`, `{error}` and field maps. */
function errorMessageFrom(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.trim()
  if (Array.isArray(value)) {
    return value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ')
  }
  if (typeof value !== 'object') return String(value)
  const candidate = value.message ?? value.error
  if (candidate === undefined || candidate === null) return ''
  if (typeof candidate === 'string') return candidate.trim()
  if (Array.isArray(candidate)) {
    return candidate.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ')
  }
  if (typeof candidate === 'object') {
    const parts = []
    for (const [key, detail] of Object.entries(candidate)) {
      const text = Array.isArray(detail)
        ? detail.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('; ')
        : (typeof detail === 'string' ? detail : JSON.stringify(detail))
      parts.push(`${key}: ${text}`)
    }
    return parts.join('; ')
  }
  return String(candidate)
}

function describeHttpError(parsed, rawText, response) {
  const fromBody = errorMessageFrom(parsed)
  if (fromBody) return fromBody
  const excerpt = String(rawText ?? '').trim()
  if (excerpt) return excerpt.length > MAX_ERROR_EXCERPT ? `${excerpt.slice(0, MAX_ERROR_EXCERPT - 1)}…` : excerpt
  const statusText = response.statusText ? ` ${response.statusText}` : ''
  return `gitlab request failed with status ${response.status}${statusText}`
}

function isAbortError(error) {
  return error?.name === 'TimeoutError'
    || error?.name === 'AbortError'
    || error?.code === 'ABORT_ERR'
    || error?.code === 20
    || error?.code === 23
}

/** Redact token occurrences in a parsed JSON body without changing its shape. */
function redactDeep(value, redact) {
  if (typeof value === 'string') return redact(value)
  if (Array.isArray(value)) return value.map(item => redactDeep(item, redact))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactDeep(item, redact)]))
  }
  return value
}

/** Keep the trailing `maxBytes` bytes of a UTF-8 string, never splitting a character. */
function tailBytes(text, maxBytes) {
  if (!text) return ''
  const buffer = Buffer.from(text, 'utf8')
  if (buffer.length <= maxBytes) return text
  let start = buffer.length - maxBytes
  while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1
  return buffer.subarray(start).toString('utf8')
}

const optionalString = (value) => (value === undefined || value === null ? undefined : value)

function mapProject(raw) {
  const data = raw ?? {}
  return {
    id: data.id,
    pathWithNamespace: data.path_with_namespace,
    defaultBranch: data.default_branch,
    webUrl: data.web_url,
  }
}

function mapMergeRequest(raw) {
  const data = raw ?? {}
  const mergeRequest = {
    iid: data.iid,
    title: data.title,
    state: data.state,
    webUrl: data.web_url,
    sourceBranch: data.source_branch,
    targetBranch: data.target_branch,
    sha: data.sha,
  }
  const mergeStatus = optionalString(data.merge_status)
  const detailedMergeStatus = optionalString(data.detailed_merge_status)
  if (mergeStatus !== undefined) mergeRequest.mergeStatus = mergeStatus
  if (detailedMergeStatus !== undefined) mergeRequest.detailedMergeStatus = detailedMergeStatus
  // The merge commit is the code version the target-branch deployment pipeline must be built for. Without it the panel
  // cannot tell this Ticket's deployment from a later unrelated pipeline (AC-05).
  const mergeCommitSha = optionalString(data.merge_commit_sha ?? data.mergeCommitSha)
  if (mergeCommitSha !== undefined) mergeRequest.mergeCommitSha = mergeCommitSha
  // Draft / work-in-progress is what stops the executor from judging an MR as ready. GitLab exposes it under either
  // spelling depending on the endpoint/version, so accept both; omit the field entirely when neither was sent.
  if (typeof data.work_in_progress === 'boolean' || typeof data.draft === 'boolean') {
    mergeRequest.workInProgress = data.work_in_progress === true || data.draft === true
  }
  // The diff refs carry the commit the MR is currently based on (`head_sha`); the executor uses it as the fallback
  // head commit when GitLab omits `sha` on an endpoint.
  if (data.diff_refs !== null && typeof data.diff_refs === 'object') {
    const diffRefs = {}
    const headSha = optionalString(data.diff_refs.head_sha ?? data.diff_refs.headSha)
    const baseSha = optionalString(data.diff_refs.base_sha ?? data.diff_refs.baseSha)
    const startSha = optionalString(data.diff_refs.start_sha ?? data.diff_refs.startSha)
    if (headSha !== undefined) diffRefs.headSha = headSha
    if (baseSha !== undefined) diffRefs.baseSha = baseSha
    if (startSha !== undefined) diffRefs.startSha = startSha
    if (Object.keys(diffRefs).length) mergeRequest.diffRefs = diffRefs
  }
  return mergeRequest
}

function mapPipeline(raw) {
  const data = raw ?? {}
  const pipeline = {
    id: data.id,
    status: data.status,
    ref: data.ref,
    sha: data.sha,
  }
  const webUrl = optionalString(data.web_url)
  const createdAt = optionalString(data.created_at)
  const updatedAt = optionalString(data.updated_at)
  if (webUrl !== undefined) pipeline.webUrl = webUrl
  if (createdAt !== undefined) pipeline.createdAt = createdAt
  if (updatedAt !== undefined) pipeline.updatedAt = updatedAt
  return pipeline
}

function mapJob(raw) {
  const data = raw ?? {}
  const job = {
    id: data.id,
    name: data.name,
    stage: data.stage,
    status: data.status,
  }
  const webUrl = optionalString(data.web_url)
  if (webUrl !== undefined) job.webUrl = webUrl
  if (typeof data.allow_failure === 'boolean') job.allowFailure = data.allow_failure
  if (typeof data.duration === 'number') job.duration = data.duration
  return job
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

/**
 * Aggregate pipeline jobs into a compact status for the executor.
 * A non-allowFailure failure always wins; timings then follow. `failed` excludes jobs
 * marked `allow_failure` because they do not fail the pipeline.
 */
export function summarizeJobs(jobs, { truncated = false } = {}) {
  const list = Array.isArray(jobs) ? jobs.filter(Boolean) : []
  const failed = []
  let running = 0
  let pending = 0
  let manual = 0
  let canceled = 0
  let skipped = 0

  for (const job of list) {
    switch (job.status) {
      case 'failed':
        if (!job.allowFailure) failed.push({ id: job.id, name: job.name, stage: job.stage })
        break
      case 'running':
        running += 1
        break
      case 'manual':
        manual += 1
        break
      case 'canceled':
        canceled += 1
        break
      case 'skipped':
        skipped += 1
        break
      default:
        if (PENDING_JOB_STATUSES.has(job.status)) pending += 1
    }
  }

  let status
  if (failed.length > 0) status = 'failed'
  else if (running > 0) status = 'running'
  else if (pending > 0) status = 'pending'
  else if (manual > 0) status = 'manual'
  else if (canceled > 0) status = 'canceled'
  else if (list.length === 0) status = 'created'
  // The job list stopped at the page cap: nothing seen failed, but a failure may sit past it, so this is not green.
  else if (truncated) status = 'unknown'
  else if (skipped === list.length) status = 'skipped'
  else status = 'success'

  return { status, failed, total: list.length, running, ...(truncated ? { truncated: true } : {}) }
}

/**
 * Pick the most recent pipeline of a merge request by max id (GitLab ids grow over time)
 * and reduce it to the two fields the executor needs. No pipeline yet -> status 'none'.
 */
export function pipelineStatusOf(mrPipelines) {
  const pipelines = asArray(mrPipelines).filter(pipeline => pipeline && pipeline.id !== undefined && pipeline.id !== null)
  if (pipelines.length === 0) return { status: 'none', pipelineId: null }
  const latest = pipelines.reduce((current, candidate) => (
    Number(candidate.id) > Number(current.id) ? candidate : current
  ))
  return { status: latest.status, pipelineId: latest.id }
}

/**
 * Build a GitLab client. Token resolution happens eagerly (options.token, else
 * options.tokenFile), so a missing token fails at construction with status 0.
 * @param {Record<string, any>} [options] `{baseUrl, project, token, tokenFile, fetchImpl, timeoutMs, userAgent}`
 */
export function createGitlabClient(options = /** @type {Record<string, any>} */ ({})) {
  if (!options || typeof options !== 'object') {
    throw new GitlabError('gitlab options are required', { status: 0 })
  }

  const baseUrl = normalizeBaseUrl(options.baseUrl)
  if (!baseUrl) throw new GitlabError('gitlab baseUrl is required', { status: 0 })
  const project = normalizeProject(options.project)
  if (!project) throw new GitlabError('gitlab project is required', { status: 0 })

  const token = resolveToken(options)
  if (!token) throw new GitlabError('gitlab token is not configured', { status: 0 })

  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new GitlabError('gitlab fetch is not available', { status: 0 })
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? Math.floor(options.timeoutMs)
    : DEFAULT_TIMEOUT_MS
  const userAgent = typeof options.userAgent === 'string' && options.userAgent
    ? options.userAgent
    : DEFAULT_USER_AGENT
  // A 429/5xx or a dropped socket used to fail the whole run: one bad minute on the GitLab side meant a red Ticket and
  // a manual retry. Only idempotent reads are retried, with a bounded backoff, so a retry can never double-apply a write.
  const retryOptions = options.retry && typeof options.retry === 'object' ? options.retry : {}
  const retryAttempts = Number.isFinite(retryOptions.attempts) && retryOptions.attempts > 0
    ? Math.floor(retryOptions.attempts)
    : 3
  const retryBaseMs = Number.isFinite(retryOptions.baseDelayMs) && retryOptions.baseDelayMs >= 0
    ? Math.floor(retryOptions.baseDelayMs)
    : 500
  const maxPages = Number.isFinite(options.maxPages) && options.maxPages > 0 ? Math.floor(options.maxPages) : DEFAULT_MAX_PAGES

  const apiBase = `${baseUrl}/api/v4`
  const encodedProject = encodeURIComponent(project)
  const encodeId = (value) => encodeURIComponent(String(value))
  const secrets = [...new Set([token, encodeURIComponent(token)].filter(Boolean))]
  const redact = (value) => {
    let text = String(value ?? '')
    for (const secret of secrets) text = text.split(secret).join(REDACTED)
    return text
  }

  /**
   * One authenticated request. Non-2xx responses become GitlabError with the server's
   * message, timeout/abort becomes status 0, and every message passes through `redact`.
   */
  async function request(path, { method = 'GET', query, body, raw = false } = /** @type {Record<string, any>} */ ({})) {
    const url = withQuery(`${apiBase}${path}`, query)
    const headers = {
      'PRIVATE-TOKEN': token,
      'content-type': 'application/json',
      'user-agent': userAgent,
    }
    // A fresh AbortSignal per attempt: reusing one would leave later attempts racing an already-expired timer.
    const initOf = () => {
      const init = { method, headers, signal: AbortSignal.timeout(timeoutMs) }
      if (body !== undefined) init.body = JSON.stringify(body)
      return init
    }
    const attempts = method === 'GET' ? retryAttempts : 1

    let response
    for (let attempt = 1; ; attempt += 1) {
      const last = attempt >= attempts
      try {
        response = await fetchImpl(url, initOf())
        if (!RETRYABLE_STATUSES.has(response.status) || last) break
        // Drain the body so the connection is reusable before backing off; Retry-After wins when GitLab sent one.
        await response.text().catch(() => '')
        await sleep(retryAfterMs(response) ?? retryBaseMs * 2 ** (attempt - 1))
        continue
      } catch (error) {
        if (isAbortError(error)) {
          if (last) {
            // The raw abort cause can carry request details; only the fixed message survives.
            throw new GitlabError('gitlab request timed out', { status: 0 })
          }
          await sleep(retryBaseMs * 2 ** (attempt - 1))
          continue
        }
        const detail = error instanceof Error ? error.message : String(error)
        if (last) throw new GitlabError(redact(`gitlab request failed: ${detail || 'network error'}`), { status: 0 })
        await sleep(retryBaseMs * 2 ** (attempt - 1))
        continue
      }
    }

    // A body read that times out or aborts must not look like an empty 200: callers treat "no JSON" as "not found",
    // which turned a stalled connection into a confident empty answer.
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new GitlabError(redact(`gitlab response body was not read: ${error instanceof Error ? error.message : String(error)}`),
        { status: 0 })
    }

    if (!response.ok) {
      let parsed
      if (text) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = undefined
        }
      }
      throw new GitlabError(redact(describeHttpError(parsed, text, response)), {
        status: response.status,
        body: parsed !== undefined
          ? redactDeep(parsed, redact)
          : (text ? redact(text) : undefined),
      })
    }

    if (raw) return text
    if (!text) return null
    try {
      return JSON.parse(text)
    } catch {
      // A proxy or an expired SSO session answers with a 200 HTML login page; calling that "invalid JSON" hid the real
      // problem (the token needs re-auth, retrying will not help).
      const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase()
      if (contentType.includes('text/html') || /^\s*</.test(text)) {
        throw new GitlabError(redact('gitlab returned an HTML page instead of JSON (the token or SSO session has probably expired); sign in again'), {
          status: response.status,
          body: redact(text.slice(0, MAX_ERROR_EXCERPT)),
        })
      }
      throw new GitlabError(redact('gitlab returned an invalid JSON response'), {
        status: response.status,
        body: redact(text.slice(0, MAX_ERROR_EXCERPT)),
      })
    }
  }

  /**
   * Stream one text response and keep only its trailing `limit` bytes. Returns undefined when the injected `fetch` does
   * not expose a readable body (tests, older runtimes) so the caller can fall back to the plain request path.
   */
  async function requestTail(path, limit) {
    let response
    try {
      response = await fetchImpl(`${apiBase}${path}`, {
        method: 'GET',
        headers: { 'PRIVATE-TOKEN': token, 'user-agent': userAgent },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch { return undefined }
    if (!response.ok || !response.body || typeof response.body.getReader !== 'function') {
      await response.text().catch(() => '')
      return undefined
    }
    const reader = response.body.getReader()
    let tail = Buffer.alloc(0)
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (!value) continue
        tail = Buffer.concat([tail, Buffer.from(value)])
        if (tail.length > limit * 2) tail = tail.subarray(tail.length - limit)
      }
    } catch {
      try { await reader.cancel() } catch {}
      return undefined
    }
    return tailBytes(tail.toString('utf8'), limit)
  }

  return {
    /** URL-encoded project path, e.g. `group%2Fproject`. */
    projectId: () => encodedProject,

    /** Browser/plain URL of the project (never a `.git` remote). */
    projectUrl: () => `${baseUrl}/${project}`,

    async getProject() {
      return mapProject(await request(`/projects/${encodedProject}`))
    },

    async createMergeRequest({ sourceBranch, targetBranch = 'dev', title, description = '', draft = false } = /** @type {Record<string, any>} */ ({})) {
      const data = await request(`/projects/${encodedProject}/merge_requests`, {
        method: 'POST',
        body: {
          source_branch: sourceBranch,
          target_branch: targetBranch,
          title: draft ? `Draft: ${title}` : title,
          description,
          remove_source_branch: true,
        },
      })
      return mapMergeRequest(data)
    },

    /** Merge requests filtered by source branch (and optionally state). */
    async listMergeRequests({ sourceBranch, state } = /** @type {Record<string, any>} */ ({})) {
      const data = await request(`/projects/${encodedProject}/merge_requests`, {
        query: { source_branch: sourceBranch, state, per_page: 20 },
      })
      return asArray(data).map(mapMergeRequest)
    },

    /** Merge one MR (optionally as merge-when-pipeline-succeeds). Requires an `api` token with write access. */
    async mergeMergeRequest(iid, { sha, mergeWhenPipelineSucceeds = false, removeSourceBranch = true } = /** @type {Record<string, any>} */ ({})) {
      const body = { merge_when_pipeline_succeeds: !!mergeWhenPipelineSucceeds }
      if (sha) body.sha = sha
      if (removeSourceBranch) body.should_remove_source_branch = true
      return mapMergeRequest(await request(`/projects/${encodedProject}/merge_requests/${encodeId(iid)}/merge`, {
        method: 'PUT', body,
      }))
    },

    async getMergeRequest(iid) {
      return mapMergeRequest(await request(`/projects/${encodedProject}/merge_requests/${encodeId(iid)}`))
    },

    async listMergeRequestPipelines(iid) {
      const data = await request(`/projects/${encodedProject}/merge_requests/${encodeId(iid)}/pipelines`)
      return asArray(data).map(mapPipeline)
    },

    async getPipeline(pipelineId) {
      return mapPipeline(await request(`/projects/${encodedProject}/pipelines/${encodeId(pipelineId)}`))
    },

    async listPipelineJobs(pipelineId) {
      // A matrix build can exceed one page; taking only the first 100 meant a failing job on page 2 was invisible and
      // `summarizeJobs` reported green, so the executor shipped a red pipeline as successful.
      const jobs = []
      let page = 1
      for (; page <= maxPages; page += 1) {
        const data = await request(`/projects/${encodedProject}/pipelines/${encodeId(pipelineId)}/jobs`, {
          query: { per_page: 100, page },
        })
        const rows = asArray(data)
        jobs.push(...rows.map(mapJob))
        if (rows.length < 100) break
      }
      // `page` is past the cap when the loop exhausted `maxPages` without a short page: more jobs exist that were not
      // read, so the caller must not treat this list as the whole pipeline (review H21).
      return { jobs, truncated: page > maxPages }
    },

    async listPipelines({ ref, sha, perPage = 20 } = /** @type {Record<string, any>} */ ({})) {
      const data = await request(`/projects/${encodedProject}/pipelines`, {
        query: { ref, sha, per_page: perPage },
      })
      return asArray(data).map(mapPipeline)
    },

    /** Text of one job's log, capped to the last `maxBytes` UTF-8 bytes. */
    async getJobTrace(jobId, { maxBytes = DEFAULT_TRACE_BYTES } = /** @type {Record<string, any>} */ ({})) {
      const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.floor(maxBytes) : DEFAULT_TRACE_BYTES
      // A verbose trace can be tens of megabytes; reading it whole just to keep the tail pushed the whole log through
      // memory (and the event loop). When the response exposes a stream, keep only the trailing window as it arrives.
      // A body that is not streamable (or an error response) used to fall back to downloading the whole trace into
      // memory — exactly the blow-up the streaming tail exists to avoid. Report "no trace" instead (review H22).
      return requestTail(`/projects/${encodedProject}/jobs/${encodeId(jobId)}/trace`, limit)
    },

    async createNote(body, noteable = {}) {
      if (noteable?.kind !== 'merge_request') {
        throw new GitlabError(redact(`unsupported noteable kind: ${String(noteable?.kind ?? '')}`), { status: 0 })
      }
      const data = await request(`/projects/${encodedProject}/merge_requests/${encodeId(noteable.iid)}/notes`, {
        method: 'POST',
        body: { body },
      })
      return { id: data?.id }
    },
  }
}
