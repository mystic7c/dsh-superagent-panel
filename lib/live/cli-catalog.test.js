import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliCatalog, resolveCliPath } from './cli-catalog.js'

const workspace = () => mkdtempSync(join(tmpdir(), 'cli-catalog-'))

/** Write `files` as a tree under `root`; values ending in `.exec` become an executable file. */
function seed(root, files) {
  for (const [path, text] of Object.entries(files)) {
    const target = path.endsWith('.exec') ? path.slice(0, -5) : path
    mkdirSync(join(root, target, '..'), { recursive: true })
    writeFileSync(join(root, target), text)
    if (path.endsWith('.exec')) chmodSync(join(root, target), 0o755)
  }
}

const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`

test('claude models are the settings model and every gateway env entry, deduped', () => {
  const home = workspace()
  seed(home, {
    '.claude/settings.json': JSON.stringify({
      model: 'deepseek-flash[1m]',
      env: { ANTHROPIC_MODEL: 'deepseek-flash[1m]', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-flash' },
    }),
  })
  const catalog = cliCatalog({ backend: 'claude', command: 'claude', home, cwd: workspace(), env: { PATH: '' } })
  assert.deepEqual(catalog.models.map(model => model.id), ['deepseek-flash[1m]', 'deepseek-flash'])
})

test('the project layer can name a model the home layer does not', () => {
  const home = workspace()
  const cwd = workspace()
  seed(home, { '.claude/settings.json': JSON.stringify({ model: 'home-model' }) })
  seed(cwd, { '.claude/settings.json': JSON.stringify({ model: 'project-model' }) })
  const catalog = cliCatalog({ backend: 'claude', command: 'claude', home, cwd, env: { PATH: '' } })
  assert.deepEqual(catalog.models.map(model => model.id), ['home-model', 'project-model'])
})

test('codex models come from the config file, its profiles and the remembered models', () => {
  const home = workspace()
  seed(home, {
    '.codex/config.toml': [
      'model = "gpt-6-astra"',
      '',
      '[profiles.fast]',
      'model = "gpt-5.5"',
      '',
      '[tui.model_availability_nux]',
      '"gpt-5.6-sol" = 1',
    ].join('\n'),
  })
  const catalog = cliCatalog({ backend: 'codex', command: 'codex', home, cwd: workspace(), env: { PATH: '' } })
  assert.deepEqual(catalog.models.map(model => model.id), ['gpt-6-astra', 'gpt-5.5', 'gpt-5.6-sol'])
})

test('skills are read from SKILL.md frontmatter, with the folder name as the fallback', () => {
  const home = workspace()
  seed(home, {
    '.claude/skills/bailian-cli/SKILL.md': skill('bailian-cli', 'Alibaba Bailian CLI hub'),
    '.claude/skills/no-frontmatter/SKILL.md': 'Just a body.',
  })
  const catalog = cliCatalog({ backend: 'claude', command: 'claude', home, cwd: workspace(), env: { PATH: '' } })
  assert.deepEqual(catalog.skills, [
    { name: 'bailian-cli', description: 'Alibaba Bailian CLI hub' },
    { name: 'no-frontmatter', description: '' },
  ])
})

test('the project layer adds skills once and the CLI path resolves through PATH', () => {
  const home = workspace()
  const cwd = workspace()
  seed(home, {
    '.codex/config.toml': 'model = "gpt-6-astra"\n',
    '.codex/skills/from-home/SKILL.md': skill('from-home', 'Home skill'),
    'bin/codex.exec': '#!/bin/sh\n',
  })
  seed(cwd, {
    '.codex/skills/from-home/SKILL.md': skill('from-home', 'Project copy'),
    '.codex/skills/from-project/SKILL.md': skill('from-project', 'Project skill'),
  })
  const catalog = cliCatalog({ backend: 'codex', command: 'codex', home, cwd, env: { PATH: join(home, 'bin') } })
  assert.deepEqual(catalog.skills.map(item => item.name), ['from-home', 'from-project'])
  assert.equal(catalog.path, join(home, 'bin', 'codex'))
})

test('a missing binary or config yields an empty catalogue, not an error', () => {
  const catalog = cliCatalog({ backend: 'claude', command: 'claude', home: workspace(), cwd: workspace(), env: { PATH: '' } })
  assert.deepEqual(catalog, { path: undefined, models: [], skills: [] })
  assert.equal(resolveCliPath('/nowhere/claude'), undefined)
  assert.equal(cliCatalog({ backend: 'dsh', home: workspace(), cwd: workspace() }).models.length, 0)
})
