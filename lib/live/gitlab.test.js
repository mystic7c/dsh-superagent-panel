import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createGitlabClient,
  GitlabError,
  pipelineStatusOf,
  summarizeJobs,
} from './gitlab.js'

const BASE_URL = 'https://gitlab.example.com'
const PROJECT = 'group/project-a'
const ENCODED_PROJECT = 'group%2Fproject-a'
const TOKEN = 'glpat-unit-test-secret'
const USER_AGENT = 'gitlab-test/1.0'
const API = `${BASE_URL}/api/v4/projects/${ENCODED_PROJECT}`

const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json' },
})

const textResponse = (body, status = 200, contentType = 'text/plain') => new Response(body, {
  status,
  headers: { 'content-type': contentType },
})

/** Fake fetch that records every call; `handler` decides the response. */
function createTestClient({ handler, calls = [], ...overrides } = {}) {
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url: String(url),
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
      signal: init.signal,
    }
    calls.push(call)
    if (!handler) throw new Error(`unexpected fetch: ${call.method} ${call.url}`)
    return handler(call, calls.length - 1)
  }
  const client = createGitlabClient({
    baseUrl: BASE_URL,
    project: PROJECT,
    token: TOKEN,
    fetchImpl,
    userAgent: USER_AGENT,
    ...overrides,
  })
  return { client, calls }
}

test('reads a token from tokenFile and rejects a missing token with status 0', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-gitlab-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tokenFile = join(dir, 'gitlab.token')
  const fileToken = 'glpat-from-file'
  await writeFile(tokenFile, `${fileToken}\n`, { mode: 0o600 })

  const { client, calls } = createTestClient({
    token: undefined,
    tokenFile,
    handler: () => jsonResponse({
      id: 42,
      path_with_namespace: PROJECT,
      default_branch: 'dev',
      web_url: `${BASE_URL}/${PROJECT}`,
    }),
  })
  const project = await client.getProject()
  assert.equal(project.id, 42)
  assert.equal(project.pathWithNamespace, PROJECT)
  assert.equal(project.defaultBranch, 'dev')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].headers['PRIVATE-TOKEN'], fileToken)

  const missing = () => createGitlabClient({
    baseUrl: BASE_URL,
    project: PROJECT,
    tokenFile: join(dir, 'does-not-exist.token'),
    fetchImpl: async () => jsonResponse({}),
  })
  assert.throws(missing, (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 0)
    assert.equal(error.message, 'gitlab token is not configured')
    assert.equal(error.message.includes(fileToken), false)
    return true
  })
  assert.throws(() => createGitlabClient({
    baseUrl: BASE_URL,
    project: PROJECT,
    fetchImpl: async () => jsonResponse({}),
  }), GitlabError)
})

test('redacts the token from server and network error messages', async () => {
  const secret = 'glpat-super-secret-value'
  const { client: serverError } = createTestClient({
    token: secret,
    handler: () => jsonResponse({ message: `401 Unauthorized: token ${secret} rejected` }, 401),
  })
  await assert.rejects(serverError.getProject(), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 401)
    assert.equal(error.message.includes(secret), false)
    assert.match(error.message, /\[redacted\]/)
    assert.match(error.message, /401 Unauthorized/)
    assert.equal(JSON.stringify(error).includes(secret), false)
    assert.match(error.body.message, /\[redacted\]/)
    return true
  })

  const { client: networkError } = createTestClient({
    token: secret,
    handler: () => { throw new Error(`socket hang up while using ${secret}`) },
  })
  await assert.rejects(networkError.getProject(), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 0)
    assert.equal(error.message.includes(secret), false)
    assert.equal(JSON.stringify(error).includes(secret), false)
    assert.match(error.message, /gitlab request failed/)
    return true
  })
})

test('encodes the nested project path and joins URLs without a double slash', () => {
  const { client } = createTestClient({ handler: () => jsonResponse({}) })
  assert.equal(client.projectId(), ENCODED_PROJECT)
  assert.equal(client.projectUrl(), `${BASE_URL}/${PROJECT}`)

  const trailing = createGitlabClient({
    baseUrl: `${BASE_URL}/`,
    project: PROJECT,
    token: TOKEN,
    fetchImpl: async () => jsonResponse({}),
  })
  assert.equal(trailing.projectId(), ENCODED_PROJECT)
  assert.equal(trailing.projectUrl(), `${BASE_URL}/${PROJECT}`)
})

test('creates a merge request with the contract body, draft prefix and camelCase mapping', async () => {
  const raw = {
    iid: 7,
    title: 'Draft: feat: x',
    state: 'opened',
    web_url: `${BASE_URL}/${PROJECT}/-/merge_requests/7`,
    source_branch: 'feature/UC-1',
    target_branch: 'dev',
    sha: 'abc123',
    merge_status: 'can_be_merged',
    detailed_merge_status: 'mergeable',
  }
  const { client, calls } = createTestClient({ handler: () => jsonResponse(raw) })
  const mr = await client.createMergeRequest({
    sourceBranch: 'feature/UC-1',
    title: 'feat: x',
    description: 'why',
    draft: true,
  })

  assert.equal(calls.length, 1)
  const [call] = calls
  assert.equal(call.url, `${API}/merge_requests`)
  assert.equal(call.method, 'POST')
  assert.deepEqual(call.headers, {
    'PRIVATE-TOKEN': TOKEN,
    'content-type': 'application/json',
    'user-agent': USER_AGENT,
  })
  assert.deepEqual(JSON.parse(call.body), {
    source_branch: 'feature/UC-1',
    target_branch: 'dev',
    title: 'Draft: feat: x',
    description: 'why',
    remove_source_branch: true,
  })
  assert.ok(call.signal instanceof AbortSignal)
  assert.deepEqual(mr, {
    iid: 7,
    title: 'Draft: feat: x',
    state: 'opened',
    webUrl: `${BASE_URL}/${PROJECT}/-/merge_requests/7`,
    sourceBranch: 'feature/UC-1',
    targetBranch: 'dev',
    sha: 'abc123',
    mergeStatus: 'can_be_merged',
    detailedMergeStatus: 'mergeable',
  })

  const second = createTestClient({ handler: () => jsonResponse({ ...raw, iid: 8, title: 'feat: y' }) })
  const plain = await second.client.createMergeRequest({ sourceBranch: 'feature/UC-2', title: 'feat: y' })
  assert.deepEqual(JSON.parse(second.calls[0].body), {
    source_branch: 'feature/UC-2',
    target_branch: 'dev',
    title: 'feat: y',
    description: '',
    remove_source_branch: true,
  })
  assert.equal(plain.title, 'feat: y')
})

test('reads a merge request and maps a 404 response to GitlabError', async () => {
  const raw = {
    iid: 7,
    title: 'feat: x',
    state: 'opened',
    web_url: `${BASE_URL}/${PROJECT}/-/merge_requests/7`,
    source_branch: 'feature/UC-1',
    target_branch: 'dev',
    sha: 'abc123',
  }
  const { client, calls } = createTestClient({ handler: () => jsonResponse(raw) })
  const mr = await client.getMergeRequest(7)
  assert.equal(calls[0].url, `${API}/merge_requests/7`)
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].body, undefined)
  assert.deepEqual(mr, {
    iid: 7,
    title: 'feat: x',
    state: 'opened',
    webUrl: `${BASE_URL}/${PROJECT}/-/merge_requests/7`,
    sourceBranch: 'feature/UC-1',
    targetBranch: 'dev',
    sha: 'abc123',
  })
  assert.equal(Object.hasOwn(mr, 'mergeStatus'), false)

  const missing = createTestClient({
    handler: () => jsonResponse({ message: '404 Project Not Found' }, 404),
  })
  await assert.rejects(missing.client.getMergeRequest(7), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 404)
    assert.equal(error.body.message, '404 Project Not Found')
    assert.match(error.message, /404 Project Not Found/)
    return true
  })
})

test('lists merge request pipelines and maps statuses (empty until a pipeline exists)', async () => {
  const payload = [
    {
      id: 3,
      status: 'failed',
      ref: 'feature/UC-1',
      sha: 'aaa',
      web_url: `${BASE_URL}/${PROJECT}/-/pipelines/3`,
      created_at: '2026-11-04T01:00:00Z',
      updated_at: '2026-11-04T01:05:00Z',
    },
    { id: 4, status: 'running', ref: 'feature/UC-1', sha: 'aaa' },
  ]
  const { client, calls } = createTestClient({ handler: () => jsonResponse(payload) })
  const pipelines = await client.listMergeRequestPipelines(7)
  assert.equal(calls[0].url, `${API}/merge_requests/7/pipelines`)
  assert.equal(calls[0].method, 'GET')
  assert.deepEqual(pipelines, [
    {
      id: 3,
      status: 'failed',
      ref: 'feature/UC-1',
      sha: 'aaa',
      webUrl: `${BASE_URL}/${PROJECT}/-/pipelines/3`,
      createdAt: '2026-11-04T01:00:00Z',
      updatedAt: '2026-11-04T01:05:00Z',
    },
    { id: 4, status: 'running', ref: 'feature/UC-1', sha: 'aaa' },
  ])

  const empty = createTestClient({ handler: () => jsonResponse([]) })
  assert.deepEqual(await empty.client.listMergeRequestPipelines(7), [])
})

test('reads one pipeline and maps its fields', async () => {
  const { client, calls } = createTestClient({
    handler: () => jsonResponse({
      id: 11,
      status: 'success',
      ref: 'dev',
      sha: 'ccc',
      web_url: `${BASE_URL}/${PROJECT}/-/pipelines/11`,
      created_at: '2026-11-04T02:00:00Z',
    }),
  })
  const pipeline = await client.getPipeline(11)
  assert.equal(calls[0].url, `${API}/pipelines/11`)
  assert.deepEqual(pipeline, {
    id: 11,
    status: 'success',
    ref: 'dev',
    sha: 'ccc',
    webUrl: `${BASE_URL}/${PROJECT}/-/pipelines/11`,
    createdAt: '2026-11-04T02:00:00Z',
  })
})

test('lists pipeline jobs with optional fields mapped', async () => {
  const { client, calls } = createTestClient({
    handler: () => jsonResponse([
      {
        id: 101,
        name: 'backend-test',
        stage: 'test',
        status: 'failed',
        web_url: `${BASE_URL}/${PROJECT}/-/jobs/101`,
        allow_failure: false,
        duration: 12.5,
        artifacts: [],
      },
      { id: 102, name: 'standards', stage: 'lint', status: 'skipped', allow_failure: true },
    ]),
  })
  const jobs = await client.listPipelineJobs(11)
  assert.equal(calls[0].url, `${API}/pipelines/11/jobs?per_page=100`)
  assert.deepEqual(jobs, [
    {
      id: 101,
      name: 'backend-test',
      stage: 'test',
      status: 'failed',
      webUrl: `${BASE_URL}/${PROJECT}/-/jobs/101`,
      allowFailure: false,
      duration: 12.5,
    },
    { id: 102, name: 'standards', stage: 'lint', status: 'skipped', allowFailure: true },
  ])
})

test('lists branch pipelines with ref/sha/per_page query parameters', async () => {
  const { client, calls } = createTestClient({
    handler: () => jsonResponse([{ id: 11, status: 'success', ref: 'feature/UC-1', sha: 'deadbeef' }]),
  })
  const pipelines = await client.listPipelines({ ref: 'feature/UC-1', sha: 'deadbeef', perPage: 5 })
  assert.deepEqual(pipelines, [{ id: 11, status: 'success', ref: 'feature/UC-1', sha: 'deadbeef' }])

  const url = new URL(calls[0].url)
  assert.equal(url.pathname, `/api/v4/projects/${ENCODED_PROJECT}/pipelines`)
  assert.equal(url.searchParams.get('ref'), 'feature/UC-1')
  assert.equal(url.searchParams.get('sha'), 'deadbeef')
  assert.equal(url.searchParams.get('per_page'), '5')

  await client.listPipelines()
  const fallback = new URL(calls[1].url)
  assert.equal(fallback.searchParams.get('per_page'), '20')
  assert.equal(fallback.searchParams.has('ref'), false)
  assert.equal(fallback.searchParams.has('sha'), false)
})

test('creates a merge request note and rejects unsupported noteable kinds', async () => {
  const { client, calls } = createTestClient({ handler: () => jsonResponse({ id: 9001 }) })
  const note = await client.createNote('pipeline failed on backend-test', { kind: 'merge_request', iid: 7 })
  assert.equal(calls[0].url, `${API}/merge_requests/7/notes`)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { body: 'pipeline failed on backend-test' })
  assert.deepEqual(note, { id: 9001 })

  const { client: unsupported } = createTestClient({ handler: () => jsonResponse({}) })
  await assert.rejects(unsupported.createNote('x', { kind: 'issue', iid: 3 }), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 0)
    return true
  })
})

test('truncates a job trace from the end in bytes', async () => {
  const trace = `${'A'.repeat(120)}\nFAILURE: backend-test failed at step 4`
  const { client, calls } = createTestClient({ handler: () => textResponse(trace) })
  const out = await client.getJobTrace(55, { maxBytes: 30 })
  assert.equal(calls[0].url, `${API}/jobs/55/trace`)
  assert.equal(calls[0].method, 'GET')
  assert.equal(out, trace.slice(-30))
  assert.equal(Buffer.byteLength(out), 30)
  assert.ok(out.endsWith('step 4'))
  assert.equal(out.startsWith('AAAA'), false)

  const short = await client.getJobTrace(55, { maxBytes: 10_000 })
  assert.equal(short, trace)
})

test('summarizes jobs and picks the latest MR pipeline by max id', () => {
  const jobs = [
    { id: 1, name: 'build', stage: 'build', status: 'success' },
    { id: 2, name: 'lint', stage: 'lint', status: 'failed', allowFailure: true },
    { id: 3, name: 'test', stage: 'test', status: 'failed', allowFailure: false },
    { id: 4, name: 'e2e', stage: 'test', status: 'running' },
    { id: 5, name: 'package', stage: 'deploy', status: 'skipped' },
  ]
  assert.deepEqual(summarizeJobs(jobs), {
    status: 'failed',
    failed: [{ id: 3, name: 'test', stage: 'test' }],
    total: 5,
    running: 1,
  })
  assert.deepEqual(summarizeJobs([
    { id: 1, name: 'build', stage: 'build', status: 'success' },
    { id: 2, name: 'lint', stage: 'lint', status: 'failed', allowFailure: true },
  ]), { status: 'success', failed: [], total: 2, running: 0 })
  assert.deepEqual(summarizeJobs([]), { status: 'created', failed: [], total: 0, running: 0 })

  assert.deepEqual(pipelineStatusOf([
    { id: 5, status: 'failed' },
    { id: 12, status: 'running' },
    { id: 9, status: 'success' },
  ]), { status: 'running', pipelineId: 12 })
  assert.deepEqual(pipelineStatusOf([]), { status: 'none', pipelineId: null })
})

test('maps timeout and abort failures to GitlabError status 0', async () => {
  const { client } = createTestClient({
    handler: () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
  })
  await assert.rejects(client.getProject(), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 0)
    assert.equal(error.message, 'gitlab request timed out')
    return true
  })

  const aborting = createGitlabClient({
    baseUrl: BASE_URL,
    project: PROJECT,
    token: TOKEN,
    timeoutMs: 25,
    // `AbortSignal.timeout` keeps an unref'd timer, so nothing else would hold the process open between the two
    // statements below on a fast/empty event loop. A ref'd timer stands in for the socket a real request holds.
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const keepAlive = setTimeout(() => {}, 500)
      init.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init.signal.reason) }, { once: true })
    }),
  })
  await assert.rejects(aborting.getProject(), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 0)
    assert.equal(error.message, 'gitlab request timed out')
    return true
  })
})

test('maps non-JSON and {error} response bodies to GitlabError messages', async () => {
  const { client } = createTestClient({
    handler: () => textResponse('<html><body>502 Bad Gateway</body></html>', 502, 'text/html'),
  })
  await assert.rejects(client.getProject(), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 502)
    assert.match(error.message, /502 Bad Gateway/)
    assert.equal(typeof error.body, 'string')
    return true
  })

  const { client: scoped } = createTestClient({
    handler: () => jsonResponse({ error: 'insufficient_scope' }, 403),
  })
  await assert.rejects(scoped.getProject(), (error) => {
    assert.ok(error instanceof GitlabError)
    assert.equal(error.status, 403)
    assert.match(error.message, /insufficient_scope/)
    return true
  })
})


test('mergeMergeRequest sends the GitLab merge PUT with sha and source-branch cleanup', async () => {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : undefined })
    return { ok: true, status: 200, text: async () => JSON.stringify({ iid: 7, state: 'merged', web_url: 'https://gitlab.example/mr/7',
      source_branch: 'feature/x', target_branch: 'dev', sha: 'abc123' }) }
  }
  const client = createGitlabClient({ baseUrl: 'https://gitlab.example', project: 'g/p', token: 'glpat-test', fetchImpl })
  const mr = await client.mergeMergeRequest(7, { sha: 'abc123', mergeWhenPipelineSucceeds: false })
  assert.equal(mr.iid, 7)
  assert.equal(mr.state, 'merged')
  assert.match(calls[0].url, /\/merge_requests\/7\/merge$/)
  assert.equal(calls[0].method, 'PUT')
  assert.deepEqual(calls[0].body, { merge_when_pipeline_succeeds: false, sha: 'abc123', should_remove_source_branch: true })
})

// ---------------------------------------------------------------------------
// P2 §2.1: draft / work-in-progress detection and the head commit of an MR.
// ---------------------------------------------------------------------------

test('maps draft / work-in-progress from either GitLab spelling and omits it when unknown', async () => {
  const base = { iid: 7, title: 'feat: x', state: 'opened', web_url: 'u', sha: 'abc123' }
  const wip = createTestClient({ handler: () => jsonResponse({ ...base, work_in_progress: true }) })
  assert.equal((await wip.client.getMergeRequest(7)).workInProgress, true)
  const draft = createTestClient({ handler: () => jsonResponse({ ...base, draft: true }) })
  assert.equal((await draft.client.getMergeRequest(7)).workInProgress, true)
  const draftFlagOnly = createTestClient({ handler: () => jsonResponse({ ...base, draft: false }) })
  assert.equal((await draftFlagOnly.client.getMergeRequest(7)).workInProgress, false)
  const unknown = createTestClient({ handler: () => jsonResponse(base) })
  assert.equal(Object.hasOwn(await unknown.client.getMergeRequest(7), 'workInProgress'), false)
})

test('maps the MR diff refs so the head commit is available when sha is omitted', async () => {
  const { client } = createTestClient({ handler: () => jsonResponse({ iid: 7, state: 'opened', web_url: 'u',
    diff_refs: { head_sha: 'head-1', base_sha: 'base-1', start_sha: 'start-1' } }) })
  const mr = await client.getMergeRequest(7)
  assert.deepEqual(mr.diffRefs, { headSha: 'head-1', baseSha: 'base-1', startSha: 'start-1' })
  assert.equal(Object.hasOwn(mr, 'sha'), true)
  assert.equal(mr.sha, undefined)
})
