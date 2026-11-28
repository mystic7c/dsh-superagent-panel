import { test } from 'node:test'
import assert from 'node:assert/strict'
import { botCatalog, CATALOG_TIMEOUT_MS, CATALOG_TTL_MS, dshCatalog } from './bot-catalog.js'

/** A plugin context whose `get(name)` returns the services the test hands it; an unknown name throws like Cordis. */
function contextOf(services) {
  return { get: name => {
    if (!(name in services)) throw new Error(`unknown service ${name}`)
    return services[name]
  } }
}

test('the catalogue is the host’s real lists: presets, provider → models, and discovered skills', async () => {
  const catalog = await botCatalog(contextOf({
    agentPresets: { list: async () => [{ id: 'standard' }, { id: 'minimal' }] },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'zai', name: 'Z.ai' }],
      listModels: provider => Promise.resolve(provider === 'deepseek'
        ? [{ id: 'deepseek-v4', name: 'DeepSeek V4' }]
        : [{ id: 'glm-4.7', name: 'GLM-4.7' }]),
    },
    skills: { list: async () => [{ name: 'ponytail', description: '最简解法' }, { name: 'review', description: '' }] },
  }))
  assert.deepEqual(catalog.dsh.presets, ['standard', 'minimal'])
  assert.deepEqual(catalog.dsh.providers, [
    { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
    { provider: 'zai', name: 'Z.ai', models: [{ id: 'glm-4.7', name: 'GLM-4.7' }] },
  ])
  assert.deepEqual(catalog.dsh.skills, [
    { name: 'ponytail', description: '最简解法' },
    { name: 'review', description: '' },
  ])
  // A CLI keeps its model names inside the binary: the editor shows free text, not an invented list.
  assert.deepEqual(catalog.claude, { presets: [], providers: [], skills: [] })
  assert.deepEqual(catalog.codex, { presets: [], providers: [], skills: [] })
  assert.equal(CATALOG_TTL_MS, 60_000)
})

test('a missing or throwing service yields an empty list, never an error', async () => {
  const empty = { presets: [], providers: [], skills: [] }
  assert.deepEqual(await dshCatalog(contextOf({})), empty)
  assert.deepEqual(await dshCatalog(contextOf({
    agentPresets: { list: async () => { throw new Error('boom') } },
    llm: { listProviders: () => { throw new Error('no llm') } },
    skills: { list: async () => { throw new Error('no skills') } },
  })), empty)
  // A host service that is present but malformed is still not a crash.
  assert.deepEqual(await dshCatalog(contextOf({ llm: { listProviders: () => 'nope', listModels: () => [] } })), empty)
})

test('one failing provider is dropped, the rest of the catalogue still answers', async () => {
  const catalog = await dshCatalog(contextOf({
    llm: {
      listProviders: () => [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }],
      listModels: provider => provider === 'good' ? Promise.resolve([{ id: 'm1', name: 'M1' }])
        : Promise.reject(new Error('provider down')),
    },
  }))
  assert.deepEqual(catalog.providers, [{ provider: 'good', name: 'Good', models: [{ id: 'm1', name: 'M1' }] }])
})

test('the workspace cwd reaches the skill registry so project skills can join the list', async () => {
  const asked = []
  await dshCatalog(contextOf({
    skills: { list: options => { asked.push(options); return Promise.resolve([]) } },
  }), { cwd: '/repo/work' })
  assert.deepEqual(asked, [{ cwd: '/repo/work' }])
  await dshCatalog(contextOf({ skills: { list: options => { asked.push(options); return Promise.resolve([]) } } }))
  assert.deepEqual(asked.at(-1), {})
})

test('a provider that never answers is cut off instead of holding the page open', async () => {
  const startedAt = Date.now()
  const catalog = await dshCatalog(contextOf({
    llm: {
      listProviders: () => [{ id: 'fast', name: 'Fast' }, { id: 'hung', name: 'Hung' }],
      listModels: provider => provider === 'fast' ? Promise.resolve([{ id: 'm1' }])
        : new Promise(() => {}),
    },
  }))
  assert.deepEqual(catalog.providers.map(row => row.provider), ['fast'])
  assert.ok(Date.now() - startedAt < CATALOG_TIMEOUT_MS + 2_000, 'the hung provider must not block the read')
})
