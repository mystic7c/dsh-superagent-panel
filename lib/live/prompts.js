/**
 * System-prompt section order (worker-profiles spec §9.5).
 *
 * One place for the numbers: a profile's role/must/skills paragraphs must land *after* the executor brief and *before*
 * nothing else the host owns, and a section appended at the wrong order silently changes precedence. The values are
 * frozen so a typo cannot renumber the contract.
 */
export const PROMPT_ORDERS = Object.freeze({
  brief: 100,
  task: 120,
  conventions: 140,
  profileRole: 160,
  profileMust: 165,
  skills: 170,
})

export const PROMPT_SECTION_NAMES = Object.freeze({
  brief: 'superagent:worker',
  profileRole: 'superagent:worker:profile',
  profileMust: 'superagent:worker:must',
  skills: 'superagent:worker:skills',
})

/**
 * Sections one profile contributes on top of the executor brief (§9.4/§9.5). Empty fields produce no section, so a
 * profile without prompt/skills changes nothing about a run.
 * @param {{role?:string, must?:string[], skills?:string[]}} [extra]
 * @returns {{name:string, order:number, text:string}[]}
 */
export function profilePromptSections(extra = {}) {
  const sections = []
  const role = typeof extra.role === 'string' ? extra.role.trim() : ''
  if (role) {
    sections.push({ name: PROMPT_SECTION_NAMES.profileRole, order: PROMPT_ORDERS.profileRole,
      text: `Profile role (this run):\n${role}` })
  }
  const must = Array.isArray(extra.must) ? extra.must.filter(item => typeof item === 'string' && item.trim()) : []
  if (must.length) {
    sections.push({ name: PROMPT_SECTION_NAMES.profileMust, order: PROMPT_ORDERS.profileMust,
      text: must.map(item => `- MUST ${item.trim()}`).join('\n') })
  }
  const skills = Array.isArray(extra.skills) ? extra.skills.filter(item => typeof item === 'string' && item.trim()) : []
  if (skills.length) {
    sections.push({ name: PROMPT_SECTION_NAMES.skills, order: PROMPT_ORDERS.skills,
      text: `优先考虑这些 Skill：${skills.map(item => item.trim()).join('、')}` })
  }
  return sections
}
