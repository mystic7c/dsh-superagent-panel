/**
 * System-prompt section order (worker-bots spec §9.5).
 *
 * One place for the numbers: a bot's role/must/skills paragraphs must land *after* the executor brief and *before*
 * nothing else the host owns, and a section appended at the wrong order silently changes precedence. The values are
 * frozen so a typo cannot renumber the contract.
 */
export const PROMPT_ORDERS = Object.freeze({
  brief: 100,
  task: 120,
  conventions: 140,
  botRole: 160,
  botMust: 165,
  skills: 170,
})

export const PROMPT_SECTION_NAMES = Object.freeze({
  brief: 'superagent:worker',
  botRole: 'superagent:worker:bot',
  botMust: 'superagent:worker:must',
  skills: 'superagent:worker:skills',
})

/**
 * Sections one bot contributes on top of the executor brief (§9.4/§9.5). Empty fields produce no section, so a
 * bot without prompt/skills changes nothing about a run.
 * @param {{role?:string, must?:string[], skills?:string[]}} [extra]
 * @returns {{name:string, order:number, text:string}[]}
 */
export function botPromptSections(extra = {}) {
  const sections = []
  const role = typeof extra.role === 'string' ? extra.role.trim() : ''
  if (role) {
    sections.push({ name: PROMPT_SECTION_NAMES.botRole, order: PROMPT_ORDERS.botRole,
      text: `Bot role (this run):\n${role}` })
  }
  const must = Array.isArray(extra.must) ? extra.must.filter(item => typeof item === 'string' && item.trim()) : []
  if (must.length) {
    sections.push({ name: PROMPT_SECTION_NAMES.botMust, order: PROMPT_ORDERS.botMust,
      text: must.map(item => `- MUST ${item.trim()}`).join('\n') })
  }
  const skills = Array.isArray(extra.skills) ? extra.skills.filter(item => typeof item === 'string' && item.trim()) : []
  if (skills.length) {
    sections.push({ name: PROMPT_SECTION_NAMES.skills, order: PROMPT_ORDERS.skills,
      text: `优先考虑这些 Skill：${skills.map(item => item.trim()).join('、')}` })
  }
  return sections
}
