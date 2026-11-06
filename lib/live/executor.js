/**
 * Executor orchestration for one ticket: worktree → DSH worker agent → local gates → commit/push → merge request →
 * pipeline tracking. Every mutating action is gated by live.json (`executor.enabled`, `executor.allowPush`) and the
 * worktree guards in repo.js; the executor is the only place that pushes or opens an MR, never the worker itself.
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readToken } from './config.js'
import { recordId } from './state.js'
import {
  prepareWorktree, assertSafeWorktree, changedPaths, commitAll, pushBranch, hasChanges, git,
} from './repo.js'
import { runWorker } from './worker.js'
import { runCliWorker, workerBackendOf } from './worker-cli.js'
import { createGitlabClient, summarizeJobs, pipelineStatusOf } from './gitlab.js'
import { repoOf, ticketRepo, repoToken, configRepos } from './repos.js'

const OUTPUT_TAIL = 4000

/** Run one shell command with a timeout, capturing a bounded tail of stdout+stderr. */
export function runCommand(command, { cwd, timeoutMs = 600_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn('bash', ['-lc', command], { cwd, env: { ...process.env, ...env } })
    let output = ''
    let settled = false
    const settle = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ...result, output: output.slice(-OUTPUT_TAIL), durationMs: Date.now() - startedAt })
    }
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      settle({ exitCode: 124, timedOut: true })
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', chunk => { output += chunk.toString() })
    child.stderr.on('data', chunk => { output += chunk.toString() })
    child.on('error', error => settle({ exitCode: 127, error: error.message }))
    child.on('close', code => settle({ exitCode: code ?? 1, timedOut: false }))
  })
}

/** Quote one path as a single shell argument (gate commands run through bash -lc). */
const shellArg = value => `'${String(value).replace(/'/g, `'\\''`)}'`

/** One repository's gates, keyed by name (frozen order in `repo.gates`). */
export function gateCommands(repo, config) {
  // Legacy callers pass the whole config: use its first/legacy repository.
  const target = repo?.gates ? repo : configRepos(repo ?? config)[0]
  const settings = repo?.gates ? config : repo
  const map = {}
  for (const gate of target?.gates ?? []) {
    map[gate.name] = { command: gate.command, ...gate.dryRunCommand ? { dryRunCommand: gate.dryRunCommand } : {},
      ...gate.passChangedFiles === true ? { passChangedFiles: true } : {},
      ...gate.requireOutput ? { requireOutput: gate.requireOutput } : {},
      timeoutMs: gate.timeoutMs ?? settings?.executor?.gateTimeoutMs ?? 600_000 }
  }
  return map
}

/** Resolve the repository of one ticket plus its token; every repo-scoped action goes through this. */
export function repoContext(engine, ticket) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const repo = ticketRepo(config, ticket) ?? config.repos[0]
  return { loaded, config, repo, token: repoToken(loaded, repo) }
}

/** Previous name for callers that only have a repository id. */
export function repoById(config, id) { return repoOf(config, id) }

/** Worker prompt: the project rules an executor session must follow, plus the ticket's boundaries. */
export function workerBrief(ticket, config, repo) {
  const target = repo ?? configRepos(config)[0] ?? {}
  const kind = target.kind === 'oracle-ebs'
    ? 'Oracle EBS R12 export mirror (DDL / PLSQL / Forms / Java source exported from UAT)'
    : 'Oracle EBS channel layer (Java 21 + Spring Boot + React/TS)'
  const gates = (target.gates ?? []).map(gate => `\`${gate.command}\``).join('、') || '(none)'
  const lines = [
    `You are the Superagent worker for one ticket in the ${target.name ?? target.id} repository (${kind}).`,
    'Follow the repository rules: read AGENTS.md (and AGENT.md when present) before editing; they override your habits.',
    'Make the smallest compatible change. Add or adjust tests / specs where the repository standards require it.',
    `Do NOT run the repository's deployment or export scripts yourself — the executor runs the gates after you: ${gates}.`,
    'You are in an isolated git worktree on a feature branch. HARD BOUNDARIES: never run git push, git merge, git tag, gh/glab, deployment scripts, or write to the protected branch; never run production or EBS DDL/DML. Never touch .env*, secrets/, db/apps/, node_modules/, logs/, or any path the repository marks protected — including committed credential scripts.',
    'Do not create commits; the executor commits and pushes after reviewing the diff. Leave the changes in the working tree.',
    ...(target.workerInstructions ?? []),
    'Finish with a short final message: what you changed, which gates you ran and their result, and any remaining risk.',
    `Ticket: ${ticket.id} — ${ticket.title}`,
    `Base: ${target.baseBranch ?? config.baseBranch} (origin/${target.baseBranch ?? config.baseBranch}); you are on the ticket's feature worktree already.`,
  ]
  return lines.join('\n')
}

/** Ticket body plus provenance as the worker's user message. */
export function workerTask(ticket, repo) {
  return [
    `处理这个 ${repo?.name ?? 'Superagent'} 工单：${ticket.title}`,
    '',
    ticket.body ? `原始请求：\n${ticket.body}` : '',
    '',
    '要求：按仓库规范完成改动；不要提交、不要推送、不要合并，也不要运行导出/部署脚本（执行器会跑相应闸门）。',
  ].filter(Boolean).join('\n')
}

/** Execute one ticket end to end. Returns the final run record. */
export async function executeTicket({ ctx, engine, ticketId, dryRun = false, log = () => {}, deps = {} }) {
  const prepare = deps.prepareWorktree ?? prepareWorktree
  const workerRun = deps.runWorker ?? runWorker
  const cliRun = deps.runCliWorker ?? runCliWorker
  const command = deps.runCommand ?? runCommand
  const pathsOf = deps.changedPaths ?? changedPaths
  const changes = deps.hasChanges ?? hasChanges
  const commit = deps.commitAll ?? commitAll
  const safe = deps.assertSafeWorktree ?? assertSafeWorktree
  const push = deps.pushBranch ?? pushBranch
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  const token = repoToken(loaded, repo)
  if (ticket.status === 'working') throw new Error(`ticket ${ticketId} is already working`)
  if (!dryRun && !config.executor.enabled) throw new Error('executor.enabled is false in live.json')
  const allowPush = !dryRun && config.executor.allowPush === true
  const runId = recordId('run')
  const at = new Date().toISOString()
  const run = { id: runId, ticketId, dryRun, status: 'running', startedAt: at, steps: [], worktree: undefined, branch: undefined,
    mergeRequest: undefined, pipeline: undefined, error: undefined }
  const step = (name, detail) => {
    run.steps.push({ name, at: new Date().toISOString(), ...detail })
    log(`executor ${ticketId}: ${name}${detail && detail.state ? ` ${detail.state}` : ''}`)
  }
  const persist = async () => {
    await engine.state.atomic((doc) => {
      doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket }
      doc.runs = [run, ...(doc.runs ?? []).filter(item => item.id !== runId)].slice(0, 100)
    })
  }

  ticket.status = 'working'
  ticket.updatedAt = at
  ticket.runId = runId
  if (!ticket.assignments) ticket.assignments = []
  ticket.assignments.push({ id: runId, state: 'running', startedAt: at, report: { state: 'progress', text: '执行器已启动', at } })
  await persist()

  try {
    step('prepare-worktree', { state: 'running' })
    const worktree = await prepare({ repo: repo.repo, worktreeRoot: repo.worktreeRoot, baseBranch: repo.baseBranch,
      featurePrefix: repo.featurePrefix, ticketId })
    run.worktree = worktree.path
    run.branch = worktree.branch
    ticket.links = { ...ticket.links, branch: worktree.branch, worktree: worktree.path }
    step('prepare-worktree', { state: 'ok', branch: worktree.branch, path: worktree.path, reused: worktree.reused })
    await persist()

    if (!dryRun && repo.prepareCommand) {
      step('prepare-repo', { state: 'running', command: repo.prepareCommand })
      const prepared = await command(repo.prepareCommand, { cwd: worktree.path, timeoutMs: config.executor.timeoutMs })
      step('prepare-repo', { state: prepared.exitCode === 0 ? 'ok' : 'failed', exitCode: prepared.exitCode })
      if (prepared.exitCode !== 0) throw new Error(`prepareCommand failed (exit ${prepared.exitCode})`)
    }

    step('worker', { state: 'running', sessionId: undefined })
    const brief = workerBrief(ticket, config, repo)
    const task = workerTask(ticket, repo)
    const workerSessionId = `worker-${ticketId}-${runId.slice(-6)}`
    const worker = workerBackend === 'dsh'
      ? await workerRun({ ctx, cwd: worktree.path, systemPrompt: brief, task, model: config.executor.model,
        timeoutMs: config.executor.timeoutMs, sessionId: workerSessionId, log })
      : await cliRun({ backend: workerBackend, cwd: worktree.path, systemPrompt: brief, task,
        model: config.executor.workerModel, command: config.executor.workerCommand,
        timeoutMs: config.executor.timeoutMs, sessionId: workerSessionId, log })
    run.worker = { sessionId: worker.sessionId, timedOut: worker.timedOut, text: worker.text, toolCalls: worker.toolCalls,
      backend: worker.backend ?? workerBackend }
    ticket.sessionId = worker.sessionId
    step('worker', { state: worker.timedOut || worker.error ? 'failed' : 'ok', sessionId: worker.sessionId,
      timedOut: worker.timedOut, error: worker.error, toolCalls: worker.toolCalls, backend: run.worker.backend })
    if (worker.timedOut || worker.error) throw new Error(worker.error ?? 'worker timed out')

    const paths = await pathsOf(worktree.path, worktree.baseSha)
    run.changedPaths = paths
    step('changed-paths', { state: paths.length ? 'ok' : 'failed', count: paths.length })
    if (!paths.length) throw new Error('worker made no changes')

    const commands = gateCommands(repo, config)
    const gateNames = repo.gates.map(gate => gate.name)
    const gates = []
    // A fresh worktree has no node_modules; install from the lockfile once before the frontend gate.
    if (gateNames.includes('frontend')) {
      step('bootstrap:pnpm', { state: 'running', command: 'pnpm install --frozen-lockfile' })
      const bootstrap = await command('pnpm install --frozen-lockfile', { cwd: worktree.path, timeoutMs: config.executor.gateTimeoutMs })
      step('bootstrap:pnpm', { state: bootstrap.exitCode === 0 ? 'ok' : 'failed', exitCode: bootstrap.exitCode })
      if (bootstrap.exitCode !== 0) { run.gates = gates; throw new Error(`pnpm install failed (exit ${bootstrap.exitCode})`) }
    }
    for (const name of gateNames) {
      const spec = commands[name]
      if (!spec) continue
      const baseCommand = dryRun && spec.dryRunCommand ? spec.dryRunCommand : spec.command
      // A fresh worktree has untracked new files; `--changed`-style git diff would miss them. Passing the executor's
      // own changed-path list makes the gate validate exactly what the worker changed.
      const gateCommand = spec.passChangedFiles
        ? `${baseCommand}${paths.length ? ` ${paths.map(shellArg).join(' ')}` : ''}`
        : baseCommand
      step(`gate:${name}`, { state: 'running', command: gateCommand })
      const result = await command(gateCommand, { cwd: worktree.path, timeoutMs: spec.timeoutMs })
      const missingEvidence = Boolean(spec.requireOutput) && !String(result.output ?? '').includes(spec.requireOutput)
      gates.push({ name, command: gateCommand, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output })
      step(`gate:${name}`, { state: result.exitCode === 0 && !missingEvidence ? 'ok' : 'failed', exitCode: result.exitCode,
        timedOut: result.timedOut, durationMs: result.durationMs, ...missingEvidence ? { detail: `missing evidence: ${spec.requireOutput}` } : {} })
      if (result.exitCode !== 0 || missingEvidence) {
        run.gates = gates
        throw new Error(missingEvidence
          ? `${name} gate did not validate any changed object (expected output: ${spec.requireOutput})`
          : `${name} gate failed (exit ${result.exitCode})`)
      }
    }
    run.gates = gates

    if (!dryRun && repo.postGatesCommand) {
      step('export-repo', { state: 'running', command: repo.postGatesCommand })
      const exported = await command(repo.postGatesCommand, { cwd: worktree.path, timeoutMs: config.executor.timeoutMs })
      step('export-repo', { state: exported.exitCode === 0 ? 'ok' : 'failed', exitCode: exported.exitCode })
      if (exported.exitCode !== 0) throw new Error(`postGatesCommand failed (exit ${exported.exitCode})`)
      run.changedPaths = await pathsOf(worktree.path, worktree.baseSha)
    }

    if (dryRun) {
      run.status = 'dry-run'
      ticket.status = 'ready'
      step('finish', { state: 'ok', detail: 'dry run: gates passed, nothing pushed' })
      return run
    }
    if (!allowPush) {
      run.status = 'gates-passed'
      ticket.status = 'ready'
      step('finish', { state: 'ok', detail: 'executor.allowPush=false: push skipped' })
      return run
    }

    await safe({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix, baseSha: worktree.baseSha,
      extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
    if (await changes(worktree.path)) {
      const commitResult = await commit({ cwd: worktree.path, message: commitMessageFor(ticket), authorName: 'Superagent',
        authorEmail: 'superagent@local' })
      run.commit = commitResult
      ticket.links = { ...ticket.links, commit: commitResult.sha }
      step('commit', { state: 'ok', sha: commitResult.sha })
      // Persist remote-visible progress as it happens: a plugin reload after this point must not lose the commit.
      await persist()
    }
    const gitlabToken = token
    const mrMode = repo.gitlab.createMr === 'push' ? 'push' : 'api'
    if (mrMode === 'api' && !gitlabToken) throw new Error(`gitlab token is not configured for ${repo.name} (set gitlab.createMr=push to open the MR without an API token)`)
    let pushed
    let mr
    if (mrMode === 'push') {
      pushed = await push({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix,
        pushOptions: pushOptionsFor(ticket, repo) })
      run.push = pushed
      if (pushed.sha) ticket.links = { ...ticket.links, commit: pushed.sha }
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
      await persist()
      mr = pushed.mergeRequest
      if (mr?.webUrl) step('merge-request', { state: 'ok', webUrl: mr.webUrl, mode: 'push' })
      else step('merge-request', { state: 'pending', detail: 'MR created via push options; GitLab did not print its URL' })
      ticket.links = { ...ticket.links, mergeRequest: { ...(mr ?? {}), mode: 'push', pending: !mr?.webUrl } }
    } else {
      pushed = await push({ cwd: worktree.path, branch: worktree.branch, featurePrefix: repo.featurePrefix })
      run.push = pushed
      if (pushed.sha) ticket.links = { ...ticket.links, commit: pushed.sha }
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
      await persist()
      const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token: gitlabToken })
      try {
        mr = await gitlab.createMergeRequest({ sourceBranch: worktree.branch, targetBranch: repo.gitlab.targetBranch,
          title: `Superagent: ${ticket.title}`, description: mergeRequestDescription(ticket, run) })
        step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl })
        ticket.links = { ...ticket.links, mergeRequest: { iid: mr.iid, webUrl: mr.webUrl, state: mr.state, mode: 'api' } }
        await persist()
      } catch (error) {
        run.mergeRequestError = error instanceof Error ? error.message : String(error)
        step('merge-request', { state: 'failed', message: run.mergeRequestError })
      }
    }
    const ciObservable = Boolean(gitlabToken) && repo.gitlab.ci !== false
    const opened = Boolean(ticket.links?.mergeRequest?.webUrl || ticket.links?.mergeRequest?.iid)
    ticket.status = opened ? (ciObservable ? 'ci-pending' : 'mr-open') : 'pushed'
    run.status = ticket.status
    await persist()
    if (opened && config.executor.allowReply) await replyToSource(engine, config, loaded, ticket, run, repo)
    return run
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run.status = 'failed'
    run.error = message
    ticket.status = 'failed'
    ticket.updatedAt = new Date().toISOString()
    ticket.assignments.at(-1).state = 'ended'
    ticket.assignments.at(-1).endedAt = ticket.updatedAt
    ticket.assignments.at(-1).report = { state: 'failed', text: message.slice(0, 2000), at: ticket.updatedAt }
    step('error', { state: 'failed', message })
    return run
  } finally {
    await persist().catch(() => {})
  }
}

/** Repo-style commit subject: `fix(ar): <summary>` derived from the ticket (scope from UC/AC ids), overridable. */
export function commitMessageFor(ticket) {
  if (typeof ticket.commitMessage === 'string' && ticket.commitMessage.trim()) return ticket.commitMessage.trim()
  const text = `${ticket.title ?? ''}\n${ticket.body ?? ''}`
  const scope = /(?:UC|AC)-([A-Za-z]{2,4})-/.exec(text)?.[1]?.toLowerCase()
  const type = /^\s*(?:feat|feature|实现|新增|新功能)/i.test(ticket.title ?? '') || /需求|新增功能/.test(ticket.body ?? '') ? 'feat' : 'fix'
  let summary = String(ticket.title ?? 'Superagent change')
    .replace(/^\s*(?:修复|fix|feat|feature|新增|实现)[:：]\s*/i, '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
  if (type === 'feat') summary = summary.replace(/^(?:实现|新增)\s*/, '').trim()
  return `${type}${scope ? `(${scope})` : ''}: ${summary}`
}

/** GitLab push options that create the MR during the push (no API token needed). */
export function pushOptionsFor(ticket, repo) {
  const title = String(ticket.title ?? 'Superagent ticket').replace(/[\r\n]+/g, ' ').slice(0, 120)
  return [
    'merge_request.create',
    `merge_request.target=${repo.gitlab.targetBranch}`,
    `merge_request.title=Superagent: ${title}`,
    `merge_request.description=Superagent ticket ${ticket.id}`,
    'merge_request.remove_source_branch',
  ]
}

/** Description body for the merge request: ticket, source, gates and worker summary. */
export function mergeRequestDescription(ticket, run, repo) {
  const gates = (run.gates ?? []).map(gate => `- ${gate.name}: exit ${gate.exitCode}${gate.timedOut ? ' (timeout)' : ''}`).join('\n')
  return [
    `Superagent ticket: ${ticket.id}`,
    ...(repo ? [`Repository: ${repo.name} (${repo.gitlab.project})`] : []),
    '',
    '## 原始请求',
    ticket.body || '(empty)',
    '',
    '## 本地闸门',
    gates || '(none)',
    '',
    '## Worker 总结',
    run.worker?.text || '(no summary)',
    '',
    '> 由 Superagent 执行器自动创建；请人工评审后合并。禁止自动合并。',
  ].join('\n')
}

/** Reply the outcome to the originating Octo thread. */
async function replyToSource(engine, config, loaded, ticket, run, repo) {
  try {
    const client = await engine.ensureClient(loaded)
    if (!client) return
    const mr = ticket.links?.mergeRequest
    const lines = [
      `Superagent: ${ticket.title}`,
      mr?.webUrl ? `MR: ${mr.webUrl}` : 'MR: 未创建（缺少 GitLab token）',
      run.gates?.length ? `闸门：${run.gates.map(gate => `${gate.name}=${gate.exitCode === 0 ? '通过' : '失败'}`).join(' ')}` : undefined,
      repo?.verifyMode === 'manual'
        ? '状态：等待人工评审与合并；合并后在面板确认验收。'
        : '状态：等待人工评审与合并，合并后 dev 流水线会自动部署 UAT。',
    ].filter(Boolean)
    await client.sendText({ channelId: ticket.origin?.channelId, channelType: ticket.origin?.channelType ?? config.octo.channelType,
      content: lines.join('\n') })
  } catch (error) {
    run.replyError = error instanceof Error ? error.message : String(error)
  }
}

/** One bounded reachability check of the UAT surface; never throws. */
export async function checkUat(url, fetchImpl) {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'uatUrl is not configured', checkedAt: new Date().toISOString() }
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch is unavailable', checkedAt: new Date().toISOString() }
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetchFn(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    return { ok: response.status >= 200 && response.status < 400, status: response.status, url, checkedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url, checkedAt }
  }
}

/** Refresh the CI status of a ticket's MR and (once merged) the dev pipeline it triggered. */
export async function refreshTicketCi({ engine, ticketId, deps = {} }) {
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket?.links?.mergeRequest?.iid) return { skipped: 'no-mr' }
  const repo = ticketRepo(config, ticket)
  // A manual repository has no CI pipeline to observe; its MR is tracked by verifyTicket/checkMerged instead.
  if (!repo || repo.verifyMode === 'manual' || repo.gitlab.ci === false) return { skipped: 'no-ci' }
  const token = repoToken(loaded, repo)
  if (!token) return { skipped: 'no-token' }
  const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
  let mr = await gitlab.getMergeRequest(ticket.links.mergeRequest.iid)
  const pipelines = await gitlab.listMergeRequestPipelines(ticket.links.mergeRequest.iid)
  const latest = pipelineStatusOf(pipelines)
  const jobs = latest.pipelineId ? await gitlab.listPipelineJobs(latest.pipelineId).catch(() => []) : []
  const summary = summarizeJobs(jobs)
  const patch = {
    mergeRequest: { iid: mr.iid, webUrl: mr.webUrl, state: mr.state, mergeStatus: mr.mergeStatus },
    pipeline: latest.pipelineId ? { id: latest.pipelineId, status: latest.status, webUrl: pipelines.find(p => p.id === latest.pipelineId)?.webUrl,
      failed: summary.failed, running: summary.running, total: summary.total } : null,
  }
  // Optional auto-merge: only after the MR pipeline is green, and only when the operator enabled allowMerge.
  // GitLab's merge API performs the merge; the dev pipeline then deploys UAT by itself.
  // Auto-merge only exists for repositories with a real CI gate; manual repos always need a human merge.
  if (repo.verifyMode === 'web-uat' && config.executor.allowMerge && mr.state === 'opened' && latest.status === 'success'
      && !['requested', 'merged'].includes(ticket.links?.autoMerge?.state)) {
    try {
      const merged = await gitlab.mergeMergeRequest(mr.iid, { sha: mr.sha, mergeWhenPipelineSucceeds: false, removeSourceBranch: true })
      mr = merged
      patch.mergeRequest = { ...patch.mergeRequest, state: merged.state, mergeStatus: merged.mergeStatus }
      patch.autoMerge = { state: merged.state === 'merged' ? 'merged' : 'requested', iid: merged.iid, at: new Date().toISOString() }
    } catch (error) {
      patch.autoMerge = { state: 'failed', iid: mr.iid, at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error) }
    }
  }
  let status = latest.status === 'success' ? 'ci-passed' : latest.status === 'failed' ? 'ci-failed' : 'ci-pending'
  if (mr.state === 'merged') {
    status = 'merged'
    // After a merge into the deploy branch, the branch pipeline is what deploys UAT; follow it to the deploy job.
    try {
      const pipelines = await gitlab.listPipelines({ ref: repo.gitlab.targetBranch, perPage: 20 })
      const branch = [...pipelines].sort((left, right) => Number(right.id) - Number(left.id))[0]
      if (branch) {
        const jobs = await gitlab.listPipelineJobs(branch.id).catch(() => [])
        const deploy = jobs.find(job => job.stage === 'deploy' || /deploy/i.test(job.name))
        patch.deployment = { pipelineId: branch.id, status: branch.status, webUrl: branch.webUrl,
          deployJob: deploy ? { name: deploy.name, status: deploy.status, webUrl: deploy.webUrl } : null }
        if (deploy?.status === 'success') {
          status = 'deployed'
          // A green deploy job is not proof the GUI answers; record one reachability check of the UAT URL.
          patch.deployment.uat = await checkUat(repo.gitlab.uatUrl, deps.fetchImpl)
        } else if (deploy?.status === 'failed' || branch.status === 'failed') status = 'deploy-failed'
        else status = 'deploy-pending'
      }
    } catch (error) {
      patch.deploymentError = error instanceof Error ? error.message : String(error)
    }
  } else if (mr.state === 'closed') status = 'closed'
  ticket.status = status
  ticket.links = { ...ticket.links, ...patch }
  ticket.updatedAt = new Date().toISOString()
  await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
  return { mergeRequest: mr, pipeline: latest, ...(patch.deployment ? { deployment: patch.deployment } : {}),
    ...(patch.autoMerge ? { autoMerge: patch.autoMerge } : {}), status }
}

/** Manually inject a ticket (used before the Octo group message exists, and by tests). */
export async function injectTicket({ engine, title, body, channelId, repoId, fromUid = 'manual' }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const repos = configRepos(config)
  const repo = repoId ? repos.find(item => item.id === repoId) : undefined
  if (repoId && !repo) throw new Error(`unknown repoId: ${repoId}`)
  const targetRepo = repo ?? repos.find(item => item.id === config.defaultRepo) ?? repos[0]
  const { evaluate, buildRecords } = await import('./eval.js')
  const candidate = {
    eventId: Date.now(), messageId: `manual-${Date.now()}`, fromUid,
    channelId: channelId ?? config.octo.watchChatIds[0],
    channelType: config.octo.channelType, contentType: 1,
    text: body ?? title, at: new Date().toISOString(),
    repoId: targetRepo.id,
    triggerId: recordId('trg'), decisionId: recordId('dec'), ticketId: recordId('tkt'),
  }
  const evaluation = evaluate({ ...candidate, text: `${title}\n${body ?? ''}` }, config)
  if (evaluation.kind !== 'accept') throw new Error(`manual ticket rejected: ${evaluation.reason[0]?.code}`)
  const records = buildRecords({ ...candidate, text: `${title}\n${body ?? ''}` }, evaluation, config)
  records.ticket.title = String(title).slice(0, 64)
  records.ticket.body = String(body ?? title)
  await engine.state.atomic((doc) => {
    doc.threads = doc.threads ?? {}
    doc.triggers = doc.triggers ?? {}
    doc.decisions = doc.decisions ?? {}
    doc.tickets = doc.tickets ?? {}
    doc.ticketOrder = doc.ticketOrder ?? []
    doc.threads[records.thread.key] = doc.threads[records.thread.key] ?? records.thread
    doc.triggers[records.trigger.id] = records.trigger
    doc.decisions[records.decision.id] = records.decision
    doc.tickets[records.ticket.id] = records.ticket
    doc.ticketOrder.push(records.ticket.id)
  })
  return records.ticket
}

export { git, recordId, readToken }


/**
 * Publish an already-executed ticket without running the worker again: re-run the gates on the existing worktree,
 * commit/push the feature branch and open the merge request. Used after a dry run has produced reviewed changes.
 */
export async function publishTicket({ engine, ticketId, log = () => {}, deps = {}, commitMessage }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  const token = repoToken(loaded, repo)
  if (!config.executor.enabled) throw new Error('executor.enabled is false in live.json')
  if (!config.executor.allowPush) throw new Error('executor.allowPush is false in live.json')
  const mrMode = repo.gitlab.createMr === 'push' ? 'push' : 'api'
  if (mrMode === 'api' && !token) throw new Error(`gitlab token is not configured for ${repo.name} (set gitlab.createMr=push to open the MR without an API token)`)
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const branch = ticket.links?.branch ?? `${repo.featurePrefix}${ticketId}`
  const cwd = ticket.links?.worktree ?? `${repo.worktreeRoot}/${ticketId}`
  const runId = recordId('run')
  const startedAt = new Date().toISOString()
  const run = { id: runId, ticketId, dryRun: false, publish: true, status: 'running', startedAt, steps: [], branch, worktree: cwd }
  const step = (name, detail) => { run.steps.push({ name, at: new Date().toISOString(), ...detail }); log(`publish ${ticketId}: ${name}`) }
  const persist = async () => {
    await engine.state.atomic((doc) => {
      doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket }
      doc.runs = [run, ...(doc.runs ?? []).filter(item => item.id !== runId)].slice(0, 100)
    })
  }
  ticket.status = 'working'
  ticket.updatedAt = startedAt
  await persist()
  try {
    const baseSha = await git(['rev-parse', `origin/${repo.baseBranch}`], repo.repo).catch(() => undefined)
    const commands = gateCommands(repo, config)
    // Reuse the installed dependencies of a previous gate run in this worktree; install only when absent.
    const gates = []
    for (const name of repo.gates.map(gate => gate.name)) {
      const spec = commands[name]
      if (!spec) continue
      step(`gate:${name}`, { state: 'running', command: spec.command })
      const result = await (deps.runCommand ?? runCommand)(spec.command, { cwd, timeoutMs: spec.timeoutMs })
      gates.push({ name, exitCode: result.exitCode, timedOut: result.timedOut, durationMs: result.durationMs, output: result.output })
      step(`gate:${name}`, { state: result.exitCode === 0 ? 'ok' : 'failed', exitCode: result.exitCode })
      if (result.exitCode !== 0) { run.gates = gates; throw new Error(`${name} gate failed (exit ${result.exitCode})`) }
    }
    run.gates = gates
    await (deps.assertSafeWorktree ?? assertSafeWorktree)({ cwd, branch, featurePrefix: repo.featurePrefix, baseSha,
      extraPatterns: repo.protectedPaths.map(pattern => new RegExp(pattern)) })
    if (await (deps.hasChanges ?? hasChanges)(cwd)) {
      const commit = await (deps.commitAll ?? commitAll)({ cwd, message: commitMessage ?? commitMessageFor(ticket), authorName: 'Superagent',
        authorEmail: 'superagent@local' })
      run.commit = commit
      ticket.links = { ...ticket.links, commit: commit.sha }
      step('commit', { state: 'ok', sha: commit.sha })
    }
    let mr
    if (mrMode === 'push') {
      const pushed = await (deps.pushBranch ?? pushBranch)({ cwd, branch, featurePrefix: repo.featurePrefix,
        pushOptions: pushOptionsFor(ticket, repo) })
      run.push = pushed
      mr = pushed.mergeRequest
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
      step('merge-request', { state: mr?.webUrl ? 'ok' : 'pending', webUrl: mr?.webUrl, mode: 'push' })
      ticket.links = { ...ticket.links, branch, worktree: cwd, mergeRequest: { ...(mr ?? {}), mode: 'push', pending: !mr?.webUrl } }
      ticket.status = 'mr-open'
      run.status = 'mr-open'
    } else {
      const pushed = await (deps.pushBranch ?? pushBranch)({ cwd, branch, featurePrefix: repo.featurePrefix })
      run.push = pushed
      step('push', { state: 'ok', branch: pushed.branch, sha: pushed.sha })
      const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
      try {
        mr = await gitlab.createMergeRequest({ sourceBranch: branch, targetBranch: repo.gitlab.targetBranch,
          title: `Superagent: ${ticket.title}`, description: mergeRequestDescription(ticket, run, repo) })
      } catch (error) {
        // An already-open MR for the same branch is not a failure of this publish.
        const message = error instanceof Error ? error.message : String(error)
        if (/already exists|open merge request/i.test(message)) {
          const existing = await gitlab.listMergeRequests({ sourceBranch: branch, state: 'opened' }).catch(() => [])
          mr = existing?.[0]
        }
        if (!mr) throw error
      }
      ticket.links = { ...ticket.links, branch, worktree: cwd, mergeRequest: { iid: mr.iid, webUrl: mr.webUrl, state: mr.state, mode: 'api' } }
      ticket.status = repo.gitlab.ci === false ? 'mr-open' : 'ci-pending'
      run.status = ticket.status
      run.mergeRequest = mr
      step('merge-request', { state: 'ok', iid: mr.iid, webUrl: mr.webUrl })
    }
    if (config.executor.allowReply) await replyToSource(engine, config, loaded, ticket, run, repo)
    return run
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    run.status = 'failed'
    run.error = message
    ticket.status = 'failed'
    ticket.updatedAt = new Date().toISOString()
    step('error', { state: 'failed', message })
    return run
  } finally {
    await persist().catch(() => {})
  }
}


/** Has this branch commit reached the deploy branch? Uses git only, so it works without a GitLab token. */
export async function checkMerged({ repo, baseBranch, sha, deps = {} }) {
  const runGit = deps.git ?? git
  try {
    await runGit(['fetch', 'origin', baseBranch], repo, { timeoutMs: 60_000 })
    const devSha = await runGit(['rev-parse', `origin/${baseBranch}`], repo)
    const merged = await runGit(['merge-base', '--is-ancestor', sha, `origin/${baseBranch}`], repo)
      .then(() => true).catch(() => false)
    return { merged, devSha, sha }
  } catch (error) {
    return { merged: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Fingerprint the UAT surface from its HTML asset references. A new deployment changes those references, so the
 * fingerprint gives token-free evidence that the UAT build actually changed (200 alone cannot show that).
 */
export async function uatFingerprint({ url, fetchImpl, timeoutMs = 15_000 } = {}) {
  if (typeof url !== 'string' || !url) return { ok: false, error: 'uatUrl is not configured', checkedAt: new Date().toISOString() }
  const fetchFn = fetchImpl ?? globalThis.fetch
  if (typeof fetchFn !== 'function') return { ok: false, error: 'fetch is unavailable', checkedAt: new Date().toISOString() }
  const checkedAt = new Date().toISOString()
  try {
    const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' })
    const text = typeof response.text === 'function' ? await response.text() : ''
    if (response.status < 200 || response.status >= 400) return { ok: false, status: response.status, url, checkedAt }
    const assets = [...String(text).matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)].map(match => match[1]).sort()
    const hash = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 16)
    const header = name => (response.headers && typeof response.headers.get === 'function'
      ? response.headers.get(name) : undefined)
    // The deploy replaces the web dist on every pipeline, so index.html's mtime (and ETag) changes even when the
    // frontend sources produce identical asset names. That makes Last-Modified a deployment signal for backend fixes.
    return { ok: true, status: response.status, url, hash, assets: assets.length,
      lastModified: header('last-modified') ?? undefined, etag: header('etag') ?? undefined, checkedAt }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), url, checkedAt }
  }
}

/**
 * Verify one ticket against its repository:
 * - `web-uat` (demo-legacy-repo): token-free merge + UAT fingerprint + health check, as before.
 * - `manual` (bpit/ebs): only observe the MR/merge into the target branch; a person accepts the result on the panel.
 */
export async function verifyTicket({ engine, ticketId, deps = {} }) {
  const loaded = engine.readConfig()
  const config = loaded.config
  const workerBackend = workerBackendOf(config)
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) throw new Error(`ticket ${ticketId} not found`)
  const repo = ticketRepo(config, ticket)
  if (!repo) throw new Error(`ticket ${ticketId} has no repository configured`)
  const token = repoToken(loaded, repo)
  let sha = ticket.links?.commit
  if (!sha && ticket.links?.worktree) {
    sha = await git(['rev-parse', 'HEAD'], ticket.links.worktree).catch(() => undefined)
    if (sha) ticket.links = { ...ticket.links, commit: sha }
  }
  const merged = sha
    ? await checkMerged({ repo: repo.repo, baseBranch: repo.gitlab.targetBranch, sha, deps })
    : { merged: false, error: 'ticket has no commit sha yet' }

  if (repo.verifyMode === 'manual') {
    // With a GitLab token the MR state is authoritative (covers squash/merge commits); git ancestry is the fallback.
    let mrState
    const patch = {}
    const makeGitlab = deps.createGitlabClient ?? createGitlabClient
    if (ticket.links?.mergeRequest?.iid && token) {
      try {
        const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
        const mr = await gitlab.getMergeRequest(ticket.links.mergeRequest.iid)
        mrState = mr?.state
        patch.mergeRequest = { ...ticket.links.mergeRequest, state: mr.state, webUrl: mr.webUrl ?? ticket.links.mergeRequest.webUrl }
      } catch (error) {
        patch.mergeRequestError = error instanceof Error ? error.message : String(error)
      }
    }
    const isMerged = Boolean(merged.merged || mrState === 'merged')
    const verification = { merged: isMerged, sha, devSha: merged.devSha, mode: 'manual', at: new Date().toISOString(),
      ...(merged.error ? { mergeError: merged.error } : {}), ...(mrState ? { mergeRequestState: mrState } : {}) }
    let status = ticket.status
    if (isMerged) status = 'merged'
    else if (mrState === 'closed') status = 'closed'
    ticket.links = { ...ticket.links, verification, ...patch }
    ticket.status = status
    ticket.updatedAt = verification.at
    await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
    return { status, verification }
  }

  const uat = await uatFingerprint({ url: repo.gitlab.uatUrl, fetchImpl: deps.fetchImpl })
  const health = await uatFingerprint({ url: repo.gitlab.healthUrl, fetchImpl: deps.fetchImpl })
  const before = ticket.links?.verification
  const capture = !before || !before.baselineLastModified
  const baselineHash = before?.baselineHash ?? (merged.merged ? undefined : uat.hash)
  const baselineLastModified = before?.baselineLastModified ?? (capture && !merged.merged ? uat.lastModified : undefined)
  const baselineEtag = before?.baselineEtag ?? (capture && !merged.merged ? uat.etag : undefined)
  const changed = Boolean(
    (baselineHash && uat.hash && baselineHash !== uat.hash)
    || (baselineLastModified && uat.lastModified && baselineLastModified !== uat.lastModified)
    || (baselineEtag && uat.etag && baselineEtag !== uat.etag))
  const verification = { merged: merged.merged, sha, devSha: merged.devSha, uat, health,
    baselineHash, baselineLastModified, baselineEtag, changed,
    at: new Date().toISOString(), ...(merged.error ? { mergeError: merged.error } : {}) }
  let status = ticket.status
  if (merged.merged) {
    if (!uat.ok) status = 'deploy-pending'
    else if (changed) status = 'deployed'
    else status = 'deploy-pending'
  }
  ticket.links = { ...ticket.links, verification }
  ticket.status = status
  ticket.updatedAt = verification.at
  await engine.state.atomic((doc) => { doc.tickets[ticketId] = { ...doc.tickets[ticketId], ...ticket } })
  return { status, verification }
}


/**
 * Heal a Ticket whose local run was interrupted after the GitLab side had already happened: look the MR up by source
 * branch (including deleted source branches), reattach its link and move the Ticket to the truthful status.
 */
export async function reconcileTicketFromGitlab({ engine, ticketId, deps = {} }) {
  const makeGitlab = deps.createGitlabClient ?? createGitlabClient
  const loaded = engine.readConfig()
  const config = loaded.config
  const ticket = engine.state.tickets[ticketId]
  if (!ticket) return { missing: true }
  if (ticket.links?.mergeRequest?.iid) return { skipped: 'has-mr' }
  const branch = ticket.links?.branch
  if (typeof branch !== 'string' || !branch) return { skipped: 'no-branch' }
  const repo = ticketRepo(config, ticket)
  if (!repo) return { skipped: 'no-repo' }
  const token = repoToken(loaded, repo)
  if (!token) return { skipped: 'no-token' }
  const gitlab = makeGitlab({ baseUrl: repo.gitlab.baseUrl, project: repo.gitlab.project, token })
  const mergeRequests = await gitlab.listMergeRequests({ sourceBranch: branch, state: 'all' })
  if (!Array.isArray(mergeRequests) || !mergeRequests.length) return { skipped: 'no-mr' }
  const merged = mergeRequests.find(mr => mr.state === 'merged')
  const open = mergeRequests.find(mr => mr.state === 'opened')
  const mr = merged ?? open ?? mergeRequests[0]
  const status = mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : 'mr-open'
  const at = new Date().toISOString()
  const mergeRequest = { iid: mr.iid, webUrl: mr.webUrl, state: mr.state, mode: 'api', reconciled: true }
  const links = { ...(ticket.links ?? {}), mergeRequest,
    ...(mr.sha ? { commit: mr.sha } : {}),
    ...(status === 'merged' ? { verification: { ...(ticket.links?.verification ?? {}), merged: true,
      sha: mr.sha ?? ticket.links?.commit, targetBranch: mr.targetBranch ?? repo.gitlab.targetBranch, at, reconciled: true } } : {}),
    reconciled: { at, source: 'gitlab-mr', previousStatus: ticket.status } }
  await engine.state.atomic((doc) => {
    const current = doc.tickets[ticketId]
    doc.tickets[ticketId] = { ...current, status, updatedAt: at, links }
  })
  return { ticket: { ...ticket, status, links }, mergeRequest, status }
}
