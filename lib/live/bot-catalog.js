/**
 * @module dsh-superagent-panel/live/bot-catalog
 *
 * What a backend can actually run, for the Bot editor (§5.4 of docs/worker-bots-direction.md). The editor must offer
 * real choices — a host preset, a provider/model the host resolves, a Skill the host discovered — never an invented
 * list. The DSH backend answers from host services; a CLI backend answers from its own configuration files (see
 * `cli-catalog.js`), so both kinds of backend get a list and neither asks the operator to type ids from memory. The
 * CLI path shown is the one the executor will actually spawn (`resolveCliCommand`), not a second guess.
 *
 * A failed or slow service yields an empty list, not an error: the Bot page must still render when skills or models
 * are unavailable, and a half-answer (one provider down) still helps.
 */

/** How long an engine may reuse a catalogue before asking the host again. */
export const CATALOG_TTL_MS = 60_000
/** One provider or skill provider may not hold the page longer than this. */
export const CATALOG_TIMEOUT_MS = 1_500
import { homedir } from 'node:os'
import { join } from 'node:path'
import { cliCatalog, skillsInDirs } from './cli-catalog.js'
import { resolveCliCommand } from './worker-cli.js'

const PROVIDER_CAP = 24
const MODEL_CAP = 300
const SKILL_CAP = 200

/**
 * Resolve with `promise`, or reject after `ms`. The deadline timer stays ref'd on purpose: an unref'd timer lets the
 * event loop drain while an awaiting test/caller is still pending (Node 22's test runner then fails the test with
 * "Promise resolution is still pending"). Clearing it as soon as either side settles keeps the cost at zero.
 *
 * @param {Promise<any[]>} promise @param {number} ms
 */
function within(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`目录读取超时（${ms}ms）`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

/** @param {any} ctx */
function serviceOf(ctx, name) {
  try { return ctx?.get?.(name) } catch { return undefined }
}

/** @param {{ id?: string, name?: string, provider?: string }[]} list */
function flatten(list, idKey) {
  const rows = []
  for (const item of Array.isArray(list) ? list : []) {
    const id = String(item?.[idKey] ?? item?.id ?? '').trim()
    if (!id) continue
    rows.push({ provider: id, name: String(item?.name ?? id) })
  }
  return rows
}

/** @param {any} ctx */
async function providersOf(ctx) {
  const llm = serviceOf(ctx, 'llm')
  if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') return []
  let listed
  try { listed = llm.listProviders() } catch { return [] }
  const providers = flatten(listed, 'id').slice(0, PROVIDER_CAP)
  const settled = await Promise.allSettled(providers.map(async provider => {
    const models = await within(Promise.resolve(llm.listModels(provider.provider)), CATALOG_TIMEOUT_MS)
    const rows = (Array.isArray(models) ? models : []).map(model => {
      const id = String(model?.id ?? model?.model ?? '').trim()
      return id ? { id, name: String(model?.name ?? id) } : undefined
    }).filter(Boolean).slice(0, MODEL_CAP)
    return { ...provider, models: rows }
  }))
  return settled.filter(result => result.status === 'fulfilled').map(result => result.value)
}

/**
 * Every skill the DSH backend can offer: the filesystem roots the host scans (`<cwd>/.dsh|.agents/skills`,
 * `~/.dsh|.agents/skills`) plus whatever the skills service reports. The service's own `list()` is scoped to one
 * agent preset, so on its own it hides the user's installed skills — which are most of them.
 *
 * @param {any} ctx @param {string} [cwd] @param {string} [home]
 */
async function dshSkillsOf(ctx, cwd, home) {
  const fromFiles = skillsInDirs([
    ...(cwd ? [join(cwd, '.dsh', 'skills'), join(cwd, '.agents', 'skills')] : []),
    join(home, '.dsh', 'skills'),
    join(home, '.agents', 'skills'),
  ])
  const seen = new Set(fromFiles.map(skill => skill.name))
  const listed = await skillsOf(ctx, cwd)
  return [...fromFiles, ...listed.filter(skill => !seen.has(skill.name))]
}

/** @param {any} ctx @param {string} [cwd] */
async function skillsOf(ctx, cwd) {
  const skills = serviceOf(ctx, 'skills')
  if (!skills || typeof skills.list !== 'function') return []
  try {
    // `cwd` lets the registry include the project's own skills for the workspace this panel works in; without it only
    // the global layer answers.
    const listed = await within(Promise.resolve(skills.list(cwd ? { cwd } : {})), CATALOG_TIMEOUT_MS)
    return (Array.isArray(listed) ? listed : []).map(skill => ({
      name: String(skill?.name ?? '').trim(),
      description: String(skill?.description ?? ''),
    })).filter(skill => skill.name).slice(0, SKILL_CAP)
  } catch { return [] }
}

/** @param {any} ctx */
async function presetsOf(ctx) {
  const presets = serviceOf(ctx, 'agentPresets')
  if (!presets || typeof presets.list !== 'function') return []
  try {
    const listed = await within(Promise.resolve(presets.list()), CATALOG_TIMEOUT_MS)
    return (Array.isArray(listed) ? listed : []).map(preset => String(preset?.id ?? preset?.name ?? '').trim())
      .filter(Boolean)
  } catch { return [] }
}

/**
 * The DSH catalogue: named presets, provider → models, and skills. Everything is optional: a host that exposes none of
 * these services yields empty lists.
 *
 * @param {any} ctx the plugin context, only for `ctx.get('...')`
 * @param {{ cwd?: string, home?: string }} [options] the workspace and home whose skill roots may join the list
 * @returns {Promise<{ presets: string[], providers: { provider: string, name: string, models: { id: string, name: string }[] }[], skills: { name: string, description: string }[] }>}
 */
export async function dshCatalog(ctx, { cwd, home = homedir() } = {}) {
  const [presets, providers, skills] = await Promise.all([
    presetsOf(ctx), providersOf(ctx), dshSkillsOf(ctx, cwd, home),
  ])
  return { presets, providers, skills }
}

/** @param {any} ctx @param {{ cwd?: string, config?: any, home?: string, env?: Record<string, string|undefined> }} [options] @returns {Promise<Record<'dsh' | 'claude' | 'codex', any>>} */
export async function botCatalog(ctx, { cwd, config, home, env } = {}) {
  const workers = config?.executor?.workers ?? {}
  return {
    dsh: await dshCatalog(ctx, { cwd, home }),
    // A CLI keeps its model names in its own configuration, so reading that file is the only honest list. A missing
    // binary or config yields empty lists rather than an error: the page still renders.
    // `home`/`env` exist for tests only; production reads the real home directory and PATH.
    claude: cliCatalog({ backend: 'claude', command: resolveCliCommand('claude', workers?.claude?.command), cwd, home, env }),
    codex: cliCatalog({ backend: 'codex', command: resolveCliCommand('codex', workers?.codex?.command), cwd, home, env }),
  }
}
