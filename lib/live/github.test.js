import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGithubClient, mapGithubPull, isGithubRepo } from './github.js'

const pull = { number: 12, html_url: 'https://github.com/o/r/pull/12', state: 'open', title: 'Superagent: x',
  head: { sha: 'abc123' }, base: { ref: 'develop' }, draft: false, merge_commit_sha: null }

test('mapGithubPull keeps the closed/open/merged distinction', () => {
  assert.deepEqual(mapGithubPull(pull), { iid: 12, webUrl: pull.html_url, state: 'opened', sha: 'abc123',
    targetBranch: 'develop', title: 'Superagent: x', draft: false, mergeCommitSha: undefined })
  assert.equal(mapGithubPull({ ...pull, state: 'closed' }).state, 'closed')
  assert.equal(mapGithubPull({ ...pull, state: 'closed', merged_at: '2026-11-12T00:00:00Z' }).state, 'merged')
  assert.equal(mapGithubPull({ ...pull, number: 0 }), undefined)
})

test('listPullRequests asks by owner-qualified head and never writes', async () => {
  const calls = []
  const client = createGithubClient({ repo: 'owner/repo', token: 'ghp_x', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return { ok: true, json: async () => [pull] }
  } })
  const items = await client.listPullRequests({ sourceBranch: 'feature/tkt_1', state: 'all' })
  assert.equal(items[0].iid, 12)
  const url = new URL(calls[0].url)
  assert.equal(url.pathname, '/repos/owner/repo/pulls')
  assert.equal(url.searchParams.get('head'), 'owner:feature/tkt_1')
  assert.equal(url.searchParams.get('state'), 'all')
  assert.equal(calls[0].options.headers.authorization, 'Bearer ghp_x')
  assert.equal(calls[0].options.method, undefined)
})

test('a GitHub query failure is an error, not a fabricated empty/confirmed state', async () => {
  const client = createGithubClient({ repo: 'owner/repo', token: undefined, fetchImpl: async () => ({
    ok: false, status: 502, text: async () => 'bad gateway' }) })
  await assert.rejects(() => client.listPullRequests({ sourceBranch: 'feature/x' }), /GitHub 502: bad gateway/)
})

test('isGithubRepo only matches a github.com target', () => {
  assert.equal(isGithubRepo({ gitlab: { baseUrl: 'https://github.com' } }), true)
  assert.equal(isGithubRepo({ gitlab: { baseUrl: 'https://gitlab.example' } }), false)
  assert.equal(isGithubRepo({ repo: 'git@github.com:o/r.git' }), true)
})
