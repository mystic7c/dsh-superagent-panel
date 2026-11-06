/**
 * Versioned role prompts: the team sections (communication, scope, delivery), the built-in parts a team may
 * override, the preview assembled from them, and the optimistic-concurrency revision counter.
 *
 * The text model mirrors the research prototype: orchestrator and worker each receive the shared part, their
 * own role part, the three team sections, the operational guides, then the generated execution environment and
 * (for the orchestrator only) the Policy section. Editing never changes what the agent is allowed to do.
 */
import { clone } from './util.js'

export const TEAM_SECTIONS = ['communication', 'scope', 'delivery']
const HEADINGS = { communication: 'Communication', scope: 'Ticket scope', delivery: 'Delivery requirements' }
export const SKILL_NAME = /^[a-z][a-z0-9-]*$/
export const MAX_CHARS = 100_000

const SHARED = `You work on one repository for a team. You receive work from people on GitHub and, when configured,
Feishu, and you answer in the conversation where the request arrived. Take as little of a person's attention as
possible: act on what is clearly asked, record why you decided, and speak only when a person must act or can use
a result.`

const ORCHESTRATOR_TEXT = `You are the orchestrator. For each candidate you receive, decide whether it is work for this
repository, which ticket it belongs to, and what scope the work has. Open a ticket only for work a person asked
for; otherwise record an ignore or stop decision with the reason that matched. Keep the ticket title short and
concrete, and put the facts a worker needs in the ticket body. Hand long work to a worker rather than doing it in
this Session.`

const WORKER_TEXT = `You are the worker for one ticket. Read the ticket body, plan the smallest change that satisfies it,
and implement it on a branch of the configured repository. Run the checks that apply, open or update a pull
request, and report back with what changed, what you verified, and what a person must review. Do not widen the
scope: report an adjacent problem instead of fixing it unasked.`

const GUIDES = {
  subscriptions: `Follow the threads a ticket subscribes to and send every new message there as context to that
ticket's worker. A message on the ticket's own thread is decided by its worker, not by a new evaluation.`,
  replies: `Reply in the conversation the request came from, not only in the ticket. Keep replies short: what you
did, what you verified, and what you need. A reply that cannot be delivered is retried and then shown to a person
in the panel.`,
  dispatch: `Route explicit requests immediately. Evaluate inferred candidates against the Policy; in observe mode
record what you would accept without accepting it. Prefer the least intrusive decision: stop a request that asks
to stop, ignore what does not concern this repository.`,
  work: `Work in the ticket directory. Before editing, check the branch and the working tree. Commit small,
reviewable changes and reference the ticket in commit messages. Report progress when a turn ends only if the
ticket waits for someone.`,
  admission: `Only a person on the Source's allowed list, or a bot on its list with an inferred candidate, may
originate work. A message that neither addresses the agent nor continues a subscribed thread is admitted only
through the admission table.`,
}
const ENVIRONMENT_HEAD = `Execution environment (from this installation's settings; it takes precedence over any repository or account
named elsewhere in these instructions; an empty value means that part is not configured here). The prepare
command of a ticket directory reads the same variables:`
const POLICY_HEAD = `## Policy
Policy version {version}; accept mode {mode}. The accept mode and the rules decide proactive candidates only: an
explicit request is routed as dispatch says, in any mode and whatever the rules.`

const BOTH = ['orchestrator', 'worker']
const MAIN = ['orchestrator']
const WORKER = ['worker']

/** The built-in parts a team may override, by key: both roles' parts, the Source skills, and generated templates. */
export const BUILT_IN = {
  'runtime/shared': { roles: BOTH, text: SHARED },
  'runtime/orchestrator': { roles: MAIN, text: ORCHESTRATOR_TEXT },
  'runtime/worker': { roles: WORKER, text: WORKER_TEXT },
  'runtime/subscriptions': { roles: BOTH, text: `## subscriptions\n${GUIDES.subscriptions}` },
  'runtime/replies': { roles: BOTH, text: `## replies\n${GUIDES.replies}` },
  'runtime/dispatch': { roles: MAIN, text: `## dispatch\n${GUIDES.dispatch}` },
  'runtime/work': { roles: WORKER, text: `## work\n${GUIDES.work}` },
  'runtime/admission': { roles: MAIN, text: GUIDES.admission },
  'runtime/handoff/orchestrator': { roles: MAIN, text: '## handoff\nHand long work to a worker with the ticket id, the scope, and the facts you gathered; a hand-back returns it to you with the reason.' },
  'runtime/handoff/worker': { roles: WORKER, text: '## handoff\nWhen a message is beyond this ticket, hand it back with the reason instead of acting on it.' },
  'runtime/environment': { roles: BOTH, text: `${ENVIRONMENT_HEAD}\n{variables}`, placeholders: ['{variables}'] },
  'runtime/policy': { roles: MAIN, text: `${POLICY_HEAD}\nThe enabled rules, by name and id:\n{rules}`, placeholders: ['{version}', '{mode}', '{rules}'] },
  'runtime/policy/none': { roles: MAIN, text: `${POLICY_HEAD}\nNo rule is enabled: a proactive candidate can only be ignored.`, placeholders: ['{version}', '{mode}'] },
  'skill/github': { roles: BOTH, text: `## GitHub\nUse the configured \`gh\` CLI for issue and pull-request reads and writes. Never force-push a branch a person owns; if a push conflicts, report it instead of rewriting history.` },
  'skill/feishu': { roles: BOTH, text: `## Feishu\nUse the configured bot CLI for reads and replies. Restrict yourself to chats the bot has joined; never message a person directly unless they asked for it in the thread.` },
}

/** Placeholder keys of a built-in template, in template order. */
export const builtInPlaceholders = (key) => BUILT_IN[key]?.placeholders ?? []
/** The text of a built-in part after a team override, or the built-in text. */
const partText = (config, key) => config.overrides?.[key]?.text ?? BUILT_IN[key].text
const fill = (template, values) => template.replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match)
const team = (config, name) => config[name] ? `## ${HEADINGS[name]}\n${config[name]}` : ''

/** Default configuration before a team edits anything. */
export function defaultPrompts() {
  return {
    communication: '改代码前先给出简短计划；完成后用中文总结改动、验证步骤与风险。只在一个话题需要人决定时才追问。',
    scope: '只处理工单范围内的改动。发现相邻问题时写进工单回复，不擅自扩大范围；需要设计取舍时先停下问人。',
    delivery: '每个工单使用独立分支并提交 PR，PR 描述引用来源 Issue；CI 通过后请求评审，不直接合并。',
    skills: {
      'aurora-conventions': '修改 aurora-console 时遵循 src/features 的分层约定；数据访问只走 repository 层；提交信息使用 Conventional Commits。',
    },
  }
}

/** A role's assembled prompt parts; `generated` parts are filled from installation facts, not from stored text. */
export function promptParts(config, role, environment, policy) {
  const fixed = (key) => ({ name: key, kind: 'fixed', key, text: partText(config, key) })
  const parts = [
    fixed('runtime/shared'), fixed(`runtime/${role}`),
    ...TEAM_SECTIONS.map(name => ({ name, kind: 'team', heading: `## ${HEADINGS[name]}`, text: team(config, name) })),
    ...['subscriptions', 'replies', role === 'orchestrator' ? 'dispatch' : 'work'].map(name => fixed(`runtime/${name}`)),
    ...role === 'orchestrator' ? [fixed('runtime/admission')] : [],
    fixed(`runtime/handoff/${role}`),
    ...environment ? [{ name: 'runtime/environment', kind: 'generated', key: 'runtime/environment', text: environment }] : [],
    ...role === 'orchestrator' && policy ? [{ name: 'runtime/policy', kind: 'generated', ...policy }] : [],
  ]
  return parts.filter(part => part.text)
}

export const composePrompt = (config, role, environment, policy) =>
  promptParts(config, role, environment, policy).map(part => part.text).join('\n\n')

/** Built-in text recorded when an override was authored, by `base` key; kept so an upgrade can show a diff. */
export const builtInBase = (text) => `prompt-built-in:${simpleHash(text)}`
function simpleHash(value) {
  let hash = 0
  for (let index = 0; index < value.length; index++) hash = Math.imul(31, hash) + value.charCodeAt(index) | 0
  return (hash >>> 0).toString(36)
}

/** Overrides whose built-in text changed since the team edited it, or whose part this version no longer has. */
export function defaultChanged(config, builtIns = {}) {
  return Object.entries(config.overrides ?? {}).flatMap(([part, override]) => {
    const current = BUILT_IN[part]
    if (!current) return [{ part, ...override.base ? { base: override.base } : {}, removed: true }]
    if (override.base === undefined || override.base === builtInBase(current.text)) return []
    const previous = builtIns[override.base]
    return [{ part, base: override.base, ...previous === undefined ? {} : { previous } }]
  })
}

/** A configuration error raised at save/preview time: `issues` are localized by the panel as `error.<code>`. */
export class PromptError extends Error {
  constructor(code, values = {}) { super(code); this.code = code; this.values = values }
}

/** Validate a submitted configuration against the built-in parts and the size limit. */
export function validatePrompts(value, saved, limit = MAX_CHARS) {
  const config = value && typeof value === 'object' ? value : {}
  const take = (key) => typeof config[key] === 'string' ? config[key] : ''
  const skills = {}
  for (const [name, text] of Object.entries(config.skills ?? {})) {
    if (!SKILL_NAME.test(name)) throw new PromptError('skillName', { name })
    if (Object.hasOwn(BUILT_IN, `skill/${name}`)) throw new PromptError('skillBuiltIn', { name })
    if (typeof text !== 'string' || !text.trim()) throw new PromptError('skillEmpty', { name })
    skills[name] = text
  }
  const overrides = {}
  for (const [part, override] of Object.entries(config.overrides ?? {})) {
    if (!BUILT_IN[part]) {
      if (saved?.overrides && Object.hasOwn(saved.overrides, part)) continue
      throw new PromptError('unknownPart', { part })
    }
    const body = typeof override?.text === 'string' ? override.text : ''
    if (!body.trim()) throw new PromptError('partEmpty', { part })
    const missing = builtInPlaceholders(part).filter(placeholder => !body.includes(placeholder))
    if (missing.length) throw new PromptError('placeholders', { part, placeholders: missing.join(', ') })
    if (body === BUILT_IN[part].text) continue
    const base = override.base ?? saved?.overrides?.[part]?.base ?? builtInBase(BUILT_IN[part].text)
    overrides[part] = { text: body, base }
  }
  const result = { communication: take('communication'), scope: take('scope'), delivery: take('delivery'), skills,
    ...Object.keys(overrides).length ? { overrides } : {} }
  if (JSON.stringify(result).length > limit) throw new PromptError('tooLong', { limit: String(limit) })
  return result
}

/** A preview of both roles, with every part named so the panel can compare text at the part level. */
export function previewPrompts(config, environment, policy) {
  const parts = {
    orchestrator: promptParts(config, 'orchestrator', environment, policy),
    worker: promptParts(config, 'worker', environment),
  }
  const skills = {}
  for (const [name, body] of Object.entries(config.skills ?? {})) skills[name] = `## skill/${name}\n${body}`
  return { orchestrator: parts.orchestrator.map(part => part.text).join('\n\n'),
    worker: parts.worker.map(part => part.text).join('\n\n'), parts, skills,
    builtIn: Object.entries(BUILT_IN).map(([key, value]) => ({ key, roles: [...value.roles], placeholders: [...(value.placeholders ?? [])], text: value.text })) }
}

/** Copy a saved prompt version for storage, without leaking mutable references. */
export const copyConfig = (config) => clone(config)
