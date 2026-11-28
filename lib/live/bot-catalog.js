/**
 * @module dsh-superagent-panel/live/bot-catalog
 *
 * What a backend can actually run, for the Bot editor (§5.4 of docs/worker-bots-direction.md). The editor must offer
 * real choices — a host preset, a provider/model the host resolves, a Skill the host discovered — never an invented
 * list. Only the DSH backend has such a catalogue: a CLI (Claude Code / Codex) keeps its model names inside the
 * binary, so its lists stay empty and the editor falls back to free text.
 *
 * A failed or slow service yields an empty list, not an error: the Bot page must still render when skills or models
 * are unavailable, and a half-answer (one provider down) still helps.
 */

/** How long an engine may reuse a catalogue before asking the host again. */
export const CATALOG_TTL_MS = 60_000
/** One provider or skill provider may not hold the page longer than this. */
export const CATALOG_TIMEOUT_MS = 1_500
const PROVIDER_CAP = 24
const MODEL_CAP = 300
const SKILL_CAP = 200

/** @param {Promise<any[]>} promise @param {number} ms */
function within(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`目录读取超时（${ms}ms）`)), ms).unref?.()),
  ])
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
 * @param {{ cwd?: string }} [options] the workspace whose project skills may join the list
 * @returns {Promise<{ presets: string[], providers: { provider: string, name: string, models: { id: string, name: string }[] }[], skills: { name: string, description: string }[] }>}
 */
export async function dshCatalog(ctx, { cwd } = {}) {
  const [presets, providers, skills] = await Promise.all([presetsOf(ctx), providersOf(ctx), skillsOf(ctx, cwd)])
  return { presets, providers, skills }
}

/** @param {any} ctx @param {{ cwd?: string }} [options] @returns {Promise<Record<'dsh' | 'claude' | 'codex', any>>} */
export async function botCatalog(ctx, { cwd } = {}) {
  return {
    dsh: await dshCatalog(ctx, { cwd }),
    // A CLI is a black box: its model names live in the binary, not in a host service. The editor shows free text
    // for these backends instead of pretending to know the list.
    claude: { presets: [], providers: [], skills: [] },
    codex: { presets: [], providers: [], skills: [] },
  }
}
