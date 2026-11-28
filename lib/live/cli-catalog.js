// The model and skill lists of the CLI backends, read from the CLIs' own configuration instead of asking the operator
// to type ids from memory. Claude Code keeps its model in `~/.claude/settings.json` (the `model` key and the
// ANTHROPIC_*_MODEL env entries, which is how a non-Anthropic gateway is configured), Codex CLI keeps it in
// `~/.codex/config.toml` (`model` plus the models its TUI remembers). Both keep skills as `<dir>/<name>/SKILL.md`
// folders under the home directory and the project. Nothing here executes the CLI: the file locations are stable and a
// side-effect-free read is what the Bot editor needs.
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODEL_CAP = 60
const SKILL_CAP = 200
const SKILL_FRONTMATTER_LINES = 40

/** Read a JSON file, or undefined when it is missing or not JSON. */
const jsonOf = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

const textOf = path => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

const uniq = values => [...new Set(values.filter(value => typeof value === 'string' && value.trim()).map(value => value.trim()))]

/** The configured CLI path: an explicit path is used as written, a bare name is resolved through `PATH`. */
export function resolveCliPath(command, env = process.env) {
  const name = typeof command === 'string' && command.trim() ? command.trim() : undefined
  if (!name) return undefined
  if (name.includes('/')) return existsSync(name) ? name : undefined
  for (const dir of String(env.PATH ?? '').split(':')) {
    if (!dir) continue
    const candidate = join(dir, name)
    try {
      accessSync(candidate, constants.X_OK)
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // Not here; keep looking.
    }
  }
  return undefined
}

/** Model ids configured for Claude Code: its `model` key, the gateway env entries, and the project override. */
function claudeModels({ home, cwd }) {
  const settings = [join(home, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.json')]
    .map(jsonOf).filter(Boolean)
  const env = settings.reduce((merged, value) => ({ ...merged, ...(value.env ?? {}) }), {})
  return uniq([
    ...settings.map(value => value.model),
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
    env.CLAUDE_CODE_SUBAGENT_MODEL,
  ]).slice(0, MODEL_CAP).map(id => ({ id, name: id }))
}

/** Model ids configured for Codex CLI: top-level `model`, per-profile models, and the models its TUI remembers. */
function codexModels({ home, cwd }) {
  const sources = [join(home, '.codex', 'config.toml'), join(cwd, '.codex', 'config.toml')]
  const found = []
  for (const path of sources) {
    const text = textOf(path)
    if (!text) continue
    let section = ''
    for (const line of text.split(/\r?\n/)) {
      const heading = line.match(/^\s*\[([^\]]+)\]\s*$/)
      if (heading) { section = heading[1].trim(); continue }
      const assignment = line.match(/^\s*("[^"]+"|[A-Za-z0-9_.-]+)\s*=\s*("[^"]*"|'[^']*'|[^#\s]+)/)
      if (!assignment) continue
      const key = assignment[1].replace(/^"|"$/g, '')
      const value = assignment[2].replace(/^["']|["']$/g, '')
      if (!section && key === 'model') found.push(value)
      else if (/^profiles\b/.test(section) && key === 'model') found.push(value)
      else if (/^tui\.model_availability/.test(section)) found.push(key)
    }
  }
  return uniq(found).slice(0, MODEL_CAP).map(id => ({ id, name: id }))
}

/** One skill folder: frontmatter name/description, or the folder name when the frontmatter omits them. */
function skillOf(dir, name) {
  const text = textOf(join(dir, name, 'SKILL.md'))
  if (text === undefined) return undefined
  const front = text.split(/\r?\n/).slice(0, SKILL_FRONTMATTER_LINES).join('\n')
  const pick = key => front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^["']|["']$/g, '')
  const id = pick('name') || name
  const description = pick('description') || ''
  return { name: id, description: description.slice(0, 200) }
}

/** Skills installed in the given `<root>/<name>/SKILL.md` roots, home first; the first root wins a duplicate name. */
export function skillsInDirs(roots) {
  const found = []
  const seen = new Set()
  for (const root of roots) {
    let names = []
    try { names = readdirSync(root) } catch { continue }
    for (const name of names.sort()) {
      const skill = skillOf(root, name)
      if (!skill || seen.has(skill.name)) continue
      seen.add(skill.name)
      found.push(skill)
      if (found.length >= SKILL_CAP) return found
    }
  }
  return found
}

/** What the Bot editor can offer for one CLI backend: the resolved binary, its configured models, its skills. */
export function cliCatalog({ backend, command, cwd = process.cwd(), home = homedir(), env = process.env }) {
  if (backend !== 'claude' && backend !== 'codex') return { path: undefined, models: [], skills: [] }
  const catalog = backend === 'claude'
    ? { models: claudeModels({ home, cwd }), skills: skillsInDirs([join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')]) }
    : { models: codexModels({ home, cwd }), skills: skillsInDirs([join(home, '.codex', 'skills'), join(cwd, '.codex', 'skills')]) }
  return { path: resolveCliPath(command ?? backend, env), ...catalog }
}
