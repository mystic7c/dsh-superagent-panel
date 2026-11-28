import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { botCatalog, CATALOG_TIMEOUT_MS, CATALOG_TTL_MS, dshCatalog } from './bot-catalog.js'

/** A plugin context whose `get(name)` returns the services the test hands it; an unknown name throws like Cordis. */
function contextOf(services) {
  return { get: name => {
    if (!(name in services)) throw new Error(`unknown service ${name}`)
    return services[name]
  } }
}

const emptyHome = () => mkdtempSync(join(tmpdir(), 'bot-catalog-home-'))

test('the catalogue is the host’s real lists: presets, provider → models, and discovered skills', async () => {
  const home = emptyHome()
  const catalog = await botCatalog(contextOf({
    agentPresets: { list: async () => [{ id: 'standard' }, { id: 'minimal' }] },
    llm: {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'zai', name: 'Z.ai' }],
      listModels: provider => Promise.resolve(provider === 'deepseek'
        ? [{ id: 'deepseek-v4', name: 'DeepSeek V4' }]
        : [{ id: 'glm-4.7', name: 'GLM-4.7' }]),
    },
    skills: { list: async () => [{ name: 'ponytail', description: '最简解法' }, { name: 'review', description: '' }] },
  }), { home })
  assert.deepEqual(catalog.dsh.presets, ['standard', 'minimal'])
  assert.deepEqual(catalog.dsh.providers, [
    { provider: 'deepseek', name: 'DeepSeek', models: [{ id: 'deepseek-v4', name: 'DeepSeek V4' }] },
    { provider: 'zai', name: 'Z.ai', models: [{ id: 'glm-4.7', name: 'GLM-4.7' }] },
  ])
  assert.deepEqual(catalog.dsh.skills, [
    { name: 'ponytail', description: '最简解法' },
    { name: 'review', description: '' },
  ])
  assert.equal(CATALOG_TTL_MS, 60_000)
})

test('a missing or throwing service yields an empty list, never an error', async () => {
  const empty = { presets: [], providers: [], skills: [] }
  assert.deepEqual(await dshCatalog(contextOf({}), { home: emptyHome() }), empty)
  assert.deepEqual(await dshCatalog(contextOf({
    agentPresets: { list: async () => { throw new Error('boom') } },
    llm: { listProviders: () => { throw new Error('no llm') } },
    skills: { list: async () => { throw new Error('no skills') } },
  }), { home: emptyHome() }), empty)
  // A host service that is present but malformed is still not a crash.
  assert.deepEqual(await dshCatalog(contextOf({ llm: { listProviders: () => 'nope', listModels: () => [] } }), { home: emptyHome() }), empty)
})

test('one failing provider is dropped, the rest of the catalogue still answers', async () => {
  const catalog = await dshCatalog(contextOf({
    llm: {
      listProviders: () => [{ id: 'good', name: 'Good' }, { id: 'bad', name: 'Bad' }],
      listModels: provider => provider === 'good' ? Promise.resolve([{ id: 'm1', name: 'M1' }])
        : Promise.reject(new Error('provider down')),
    },
  }), { home: emptyHome() })
  assert.deepEqual(catalog.providers, [{ provider: 'good', name: 'Good', models: [{ id: 'm1', name: 'M1' }] }])
})

test('the workspace cwd reaches the skill registry so project skills can join the list', async () => {
  const asked = []
  await dshCatalog(contextOf({
    skills: { list: options => { asked.push(options); return Promise.resolve([]) } },
  }), { cwd: '/repo/work', home: emptyHome() })
  assert.deepEqual(asked, [{ cwd: '/repo/work' }])
  await dshCatalog(contextOf({ skills: { list: options => { asked.push(options); return Promise.resolve([]) } } }), { home: emptyHome() })
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

test('a CLI backend answers from its own configuration files, with the resolved binary path', async () => {
  const home = mkdtempSync(join(tmpdir(), 'bot-catalog-cli-'))
  const claude = join(home, 'claude')
  writeFileSync(claude, '#!/bin/sh\n')
  chmodSync(claude, 0o755)
  mkdirSync(join(home, '.claude', 'skills', 'review'), { recursive: true })
  writeFileSync(join(home, '.claude', 'skills', 'review', 'SKILL.md'),
    '---\nname: review\ndescription: 评审\n---\n\nBody.\n')
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'deepseek-flash[1m]' }))
  // Codex keeps its model in TOML.
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-6-astra"\n')
  const catalog = await botCatalog(contextOf({}), {
    home, env: { PATH: '' }, config: { executor: { workers: { claude: { command: claude }, codex: { command: 'codex' } } } },
  })
  assert.equal(catalog.claude.path, claude)
  assert.deepEqual(catalog.claude.models, [{ id: 'deepseek-flash[1m]', name: 'deepseek-flash[1m]' }])
  assert.deepEqual(catalog.claude.skills, [{ name: 'review', description: '评审' }])
  assert.deepEqual(catalog.codex.models, [{ id: 'gpt-6-astra', name: 'gpt-6-astra' }])
  // A CLI whose binary cannot be found renders with an unknown path instead of pretending it is installed.
  assert.equal(catalog.codex.path, undefined)
})

test('the DSH skill list also reads the filesystem roots the host scans, user installs included', async () => {
  const home = emptyHome()
  const cwd = mkdtempSync(join(tmpdir(), 'bot-catalog-cwd-'))
  const write = (root, name, description) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n`)
  }
  write(join(home, '.dsh', 'skills'), 'bailian-cli', 'Bailian CLI')
  write(join(home, '.agents', 'skills'), 'octo-shared', 'Octo shared')
  // A project skill of the same name shadows the user install.
  write(join(cwd, '.dsh', 'skills'), 'bailian-cli', 'project copy')
  const catalog = await dshCatalog(contextOf({
    skills: { list: async () => [{ name: 'office', description: 'bundled' }] },
  }), { cwd, home })
  assert.deepEqual(catalog.skills, [
    { name: 'bailian-cli', description: 'project copy' },
    { name: 'octo-shared', description: 'Octo shared' },
    { name: 'office', description: 'bundled' },
  ])
})
