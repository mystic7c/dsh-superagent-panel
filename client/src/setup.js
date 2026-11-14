/* First-run setup: a four-step checklist derived from the status document every page already receives.
   It is deliberately a client-only projection: the host does not need a new "onboarding" endpoint, and the card
   disappears as soon as the four prerequisites are true. The copy names the operator's next action, not a file. */

import { when } from "./i18n.js"
import { Button, StatusIcon, Tag } from "./controls.js"
import { usePanel } from "./api.js"
import { When } from "./widgets.js"
import { PAGE_TEXT, pt } from "./localtext.js"
import { React, h } from "./react.js"
Object.assign(PAGE_TEXT, {
  'setup.title': ['开始使用', 'Get started'],
  'setup.lead': ['完成下面几步，群里的一条请求就会变成可执行的工单。', 'A few steps turn a group message into a runnable Ticket.'],
  'setup.progress': ['已完成 {done}/{total}', '{done}/{total} done'],
  'setup.continue': ['继续配置', 'Continue setup'],
  'setup.open': ['去配置', 'Open settings'],
  'setup.done': ['完成', 'Done'],
  'setup.footer': ['完成后用顶部「检查新消息」做一次试运行；试运行不会写入状态。',
    'When the steps are done, use “Check for new messages” at the top for a dry run; it writes no state.'],
  'setup.banner': ['配置未完成 · {done}/{total}', 'Setup incomplete · {done}/{total}'],
  'setup.token.title': ['配置 Octo token', 'Connect Octo'],
  'setup.token.hint': ['让面板能读取群消息；保存在本机 token 文件，不会回显。',
    'Lets the panel read group messages; stored in a local token file and never echoed.'],
  'setup.groups.title': ['添加监听群', 'Add a watched group'],
  'setup.groups.hint': ['从群列表选择，并设置允许的触发人（或开启任意人类）。',
    'Pick a group and set who may trigger it (or accept any human).'],
  'setup.repo.title': ['绑定仓库', 'Bind a repository'],
  'setup.repo.hint': ['执行器在哪个仓库改代码；还没有仓库时先在设置里复制配置路径。',
    'Where the executor changes code; if none exists, copy the config path under Settings first.'],
  'setup.engine.title': ['打开引擎', 'Turn on the engine'],
  'setup.engine.hint': ['在设置→来源打开「启用引擎」并保存；开启后才会自动轮询。',
    'Turn on “Engine enabled” under Settings → Source and save; polling starts after that.'],
})

/** The four prerequisites, in the order a first-time installer should satisfy them. */
export const SETUP_STEPS = [
  { key: 'token', group: 'source', focus: 'octo-token' },
  { key: 'groups', group: 'source', focus: 'bindings' },
  { key: 'repo', group: 'repos' },
  { key: 'engine', group: 'source' },
]

/** Pure projection of the status document; missing fields count as not done. */
export function setupStateOf(data) {
  const config = data?.config ?? {}
  const octo = config.octo ?? {}
  const repos = Array.isArray(config.repos) ? config.repos : []
  const steps = SETUP_STEPS.map(step => ({
    key: step.key,
    group: step.group,
    focus: step.focus,
    done: step.key === 'token' ? octo.tokenConfigured === true
      : step.key === 'groups' ? Array.isArray(octo.watchChatIds) && octo.watchChatIds.length > 0
        : step.key === 'repo' ? repos.length > 0
          : config.enabled === true,
  }))
  // The group step also carries the trigger-people rule: a watched group with no allowed sender (and "any human"
  // off) is a configured-looking intake the engine will refuse.
  const triggerRule = octo.allowAnyHuman === true
    || (Array.isArray(octo.allowSenderIds) && octo.allowSenderIds.length > 0)
  if (steps[1]) steps[1].done = steps[1].done && triggerRule
  const done = steps.filter(step => step.done).length
  return { steps, done, total: steps.length, complete: done === steps.length,
    next: steps.find(step => !step.done) ?? steps[steps.length - 1] }
}

/** Full card: shown when the desk is quiet (the first-run case), so it replaces empty space with the next action. */
export function SetupChecklist({ setup, onNavigate }) {
  const { t } = usePanel()
  if (!setup || setup.complete) return null
  return h('section', { className: 'sa-setup', 'aria-labelledby': 'sa-setup-title' },
    h('div', { className: 'sa-setup-head' },
      h('div', { className: 'sa-setup-heading' },
        h('div', { className: 'sa-setup-title-row' },
          h('h2', { className: 'sa-setup-title', id: 'sa-setup-title' }, pt(t, 'setup.title')),
          h('span', { className: 'sa-setup-count', role: 'status' }, pt(t, 'setup.progress', { done: setup.done, total: setup.total }))),
        h('p', { className: 'sa-setup-lead' }, pt(t, 'setup.lead'))),
      h(Button, { variant: 'primary', size: 'sm', onClick: () => onNavigate({ page: 'settings', group: setup.next.group, focus: setup.next.focus }) },
        pt(t, 'setup.continue'))),
    h('ol', { className: 'sa-setup-steps' }, setup.steps.map(step => h('li', {
      key: step.key, className: 'sa-setup-step', 'data-done': step.done || undefined },
      h(StatusIcon, { state: step.done ? 'done' : 'idle', size: 16 }),
      h('div', { className: 'sa-setup-step-main' },
        h('span', { className: 'sa-setup-step-title' }, pt(t, `setup.${step.key}.title`)),
        h('span', { className: 'sa-setup-step-hint' }, pt(t, `setup.${step.key}.hint`))),
      step.done ? h(Tag, { tone: 'success' }, pt(t, 'setup.done'))
        : h(Button, { variant: 'ghost', size: 'sm', onClick: () => onNavigate({ page: 'settings', group: step.group, focus: step.focus }) },
          pt(t, 'setup.open'))))),
    h('p', { className: 'sa-hint' }, pt(t, 'setup.footer')))
}

/** One-line banner: shown when there is live work, so setup never pushes urgent Tickets down the page. */
export function SetupBanner({ setup, onNavigate }) {
  const { t } = usePanel()
  if (!setup || setup.complete) return null
  return h('div', { className: 'sa-setup-banner' },
    h(StatusIcon, { state: 'idle', size: 14 }),
    h('span', { className: 'sa-hint' }, pt(t, 'setup.banner', { done: setup.done, total: setup.total })),
    h(Button, { variant: 'ghost', size: 'sm', onClick: () => onNavigate({ page: 'settings', group: setup.next.group, focus: setup.next.focus }) },
      pt(t, 'setup.continue')))
}
