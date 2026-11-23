/**
 * Read-only GitHub pull-request lookup (AC-05).
 *
 * The push bridge only produces a `/pull/new/` creation link, which is not proof that a PR exists. This client asks
 * the GitHub REST API which PR (if any) already uses the feature branch, so the panel can move from "pushed" to a
 * confirmed PR number without ever writing to GitHub.
 */
const API_BASE = 'https://api.github.com'

/** A repository whose remote/base URL is github.com; that host ignores GitLab push options and has no MR API. */
export function isGithubRepo(repo) {
  return /github\.com/i.test(String(repo?.gitlab?.baseUrl ?? repo?.repo ?? ''))
}

/** Map a REST pull object onto the small `{ iid, state, webUrl, sha, targetBranch }` shape the panel already uses. */
export function mapGithubPull(pull) {
  if (!pull || typeof pull !== 'object') return undefined
  const number = Number(pull.number)
  if (!Number.isFinite(number) || number <= 0) return undefined
  return {
    iid: number,
    webUrl: pull.html_url,
    state: pull.merged_at ? 'merged' : pull.state === 'closed' ? 'closed' : 'opened',
    sha: pull.head?.sha,
    targetBranch: pull.base?.ref,
    title: pull.title,
    draft: pull.draft === true,
    mergeCommitSha: pull.merge_commit_sha ?? undefined,
  }
}

/**
 * `createGithubClient({ repo: 'owner/name', token, fetchImpl, apiBase })`.
 * A token is optional for public repositories; it is sent only when configured and never logged.
 */
export function createGithubClient(options = /** @type {Record<string, any>} */ ({})) {
  const { repo, token, fetchImpl, apiBase = API_BASE } = options
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error('github repo must be owner/name')
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') throw new Error('fetch is unavailable')
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const retryOptions = options.retry && typeof options.retry === 'object' ? options.retry : {}
  const attempts = Number.isFinite(retryOptions.attempts) && retryOptions.attempts > 0
    ? Math.floor(retryOptions.attempts)
    : 3
  const baseDelayMs = Number.isFinite(retryOptions.baseDelayMs) && retryOptions.baseDelayMs >= 0
    ? Math.floor(retryOptions.baseDelayMs)
    : 500
  // Every call here is a read (pull requests are never written), so a 429/5xx or a dropped socket is safe to retry;
  // failing the whole run on one bad minute meant a red Ticket for a pipeline that was fine.
  const request = async (path) => {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'dsh-superagent-panel' }
    if (token) headers.authorization = `Bearer ${token}`
    let lastError
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const last = attempt >= attempts
      let response
      try {
        response = await fetchFn(`${apiBase}${path}`, { headers, signal: AbortSignal.timeout(20_000) })
      } catch (error) {
        lastError = error
        if (last) throw error
        await sleep(baseDelayMs * 2 ** (attempt - 1))
        continue
      }
      if (response.ok) {
        if (typeof response.text !== 'function' && typeof response.json === 'function') return response.json()
        const text = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
        if (!text) return null
        try {
          return JSON.parse(text)
        } catch {
          const contentType = String(response.headers?.get?.('content-type') ?? '').toLowerCase()
          if (contentType.includes('text/html') || /^\s*</.test(text)) {
            throw new Error('GitHub returned an HTML page instead of JSON (the token or SSO session has probably expired); sign in again')
          }
          throw new Error('GitHub returned an invalid JSON response')
        }
      }
      const body = typeof response.text === 'function' ? await response.text().catch(() => '') : ''
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || last) {
        throw new Error(`GitHub ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`)
      }
      const retryAfter = Number(response.headers?.get?.('retry-after'))
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(retryAfter * 1000, 5_000)
        : baseDelayMs * 2 ** (attempt - 1))
    }
    throw lastError ?? new Error('GitHub request failed')
  }
  return {
    /** Newest first; `head` filters by branch, `state` is open/closed/all (GitHub exposes merged under closed). */
    async listPullRequests({ sourceBranch, state = 'all' } = /** @type {Record<string, any>} */ ({})) {
      if (typeof sourceBranch !== 'string' || !sourceBranch) return []
      const [owner] = repo.split('/')
      const query = new URLSearchParams({ head: `${owner}:${sourceBranch}`, state: String(state), per_page: '20',
        sort: 'created', direction: 'desc' })
      const pulls = await request(`/repos/${repo}/pulls?${query}`)
      return Array.isArray(pulls) ? pulls.map(mapGithubPull).filter(Boolean) : []
    },
    async getPullRequest(number) {
      const id = Number(number)
      if (!Number.isFinite(id) || id <= 0) return undefined
      return mapGithubPull(await request(`/repos/${repo}/pulls/${id}`))
    },
  }
}

