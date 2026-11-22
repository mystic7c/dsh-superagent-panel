import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKEND_VERIFY_FILE, TOOL_CAPABILITIES, capabilityStateOf, clearProbeCache, fallbackProbe, hostVersionOf, needsSmoke,
  probeBackend, probeDsh, readBackendVerify, recordSmoke, toolNamesOf, verifiedAtOf,
} from './backend-capability.js'
import { capabilitiesOf, validateProfile } from './worker-profile.js'

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'superagent-capability-'))
}

function fakeCtx({ tools = ['write', 'bash', 'web_search'], searchReady = true, fetchReady = true, presetId = 'standard' } = {}) {
  return {
    get(name) {
      if (name === 'agentPresets') return { resolve: async () => ({ id: presetId, tools: tools.map(name => ({ name })) }) }
      if (name === 'web') return { searchReady: () => searchReady, fetchReady: () => fetchReady }
      return undefined
    },
  }
}

test('toolNamesOf reads the shapes a preset or tool service may expose', () => {
  assert.deepEqual(toolNamesOf({ tools: ['bash', { name: 'write' }] }), ['bash', 'write'])
  assert.deepEqual(toolNamesOf({ tools: { bash: true, disabled: false } }), ['bash'])
  assert.deepEqual(toolNamesOf({ agent: { tools: ['edit'] } }), ['edit'])
  assert.equal(toolNamesOf(undefined), undefined)
  assert.equal(toolNamesOf({}), undefined)
})

test('a DSH probe derives capabilities from the tool set, not the routing table', async () => {
  clearProbeCache()
  const probe = await probeDsh({ ctx: fakeCtx(), preset: 'standard', version: '2.0.0' })
  assert.equal(probe.source, 'probe')
  assert.deepEqual(probe.capabilities, { edit: true, exec: true, web: true })
  assert.deepEqual(probe.unverified, [])
  assert.equal(probe.evidence.preset, 'standard')
  assert.equal(probe.evidence.version, '2.0.0')
  assert.deepEqual(capabilitiesOf(probe), { edit: true, exec: true, web: true })
  assert.deepEqual(validateProfile({ id: 'xx', name: 'x', backend: 'dsh', requires: ['edit', 'exec'] },
    { backendState: 'verified', capabilities: capabilitiesOf(probe) }).ok, true)
})

test('a preset without bash cannot satisfy a profile that requires exec (AC-B3)', async () => {
  clearProbeCache()
  const probe = await probeDsh({ ctx: fakeCtx({ tools: ['write', 'web_search'] }), preset: 'readonly', version: '2.0.0' })
  assert.equal(probe.capabilities.exec, false)
  const checked = validateProfile({ id: 'xx', name: 'x', backend: 'dsh', requires: ['exec'] },
    { backendState: 'verified', capabilities: capabilitiesOf(probe) })
  assert.equal(checked.code, 'PROFILE_CAPABILITY_GAP')
  assert.deepEqual(checked.missing, ['exec'])
})

test('web tools present but providers not ready means web is unverified (AC-B3)', async () => {
  clearProbeCache()
  const probe = await probeDsh({ ctx: fakeCtx({ tools: ['write', 'bash', 'web_search'], searchReady: false }), version: '2.0.0' })
  assert.equal(probe.capabilities.web, false)
  assert.deepEqual(probe.unverified, ['web'])
  assert.deepEqual(capabilitiesOf(probe), { edit: true, exec: true, web: false })
  // web_fetch additionally needs the fetch provider.
  clearProbeCache()
  const fetchDown = await probeDsh({
    ctx: fakeCtx({ tools: ['write', 'bash', 'web_search', 'web_fetch'], searchReady: true, fetchReady: false }),
    version: '2.0.0',
  })
  assert.equal(fetchDown.capabilities.web, false)
  assert.equal(fetchDown.evidence.providers.fetch, false)
})

test('the host tools service is probed by name, never through resolve (1.0.16 host crash)', async () => {
  clearProbeCache()
  const registered = new Set(['write', 'edit', 'bash', 'web_search', 'web_fetch'])
  let resolveCalls = 0
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }) }
      if (name === 'tools') {
        return {
          get: tool => (registered.has(tool) ? { name: tool } : undefined),
          // A bare resolve() rejects: unawaited, that rejection exits the host.
          resolve: async context => { resolveCalls += 1; return { dispose() {}, view: () => context.agent.tools } },
        }
      }
      if (name === 'web') return { searchReady: async () => true, fetchReady: async () => true }
      return undefined
    },
  }
  const probe = await probeDsh({ ctx, preset: 'standard', version: '2.0.0' })
  assert.equal(probe.source, 'probe')
  assert.deepEqual(probe.capabilities, { edit: true, exec: true, web: true })
  assert.deepEqual(probe.unverified, [])
  assert.equal(resolveCalls, 0)
  assert.equal(probe.evidence.providers.search, true)
})

test('a tools service that only lists definitions or schemas is enough', async () => {
  clearProbeCache()
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }) }
      if (name === 'tools') return { definitions: () => [{ name: 'write' }, { name: 'bash' }] }
      return undefined
    },
  }
  const probe = await probeDsh({ ctx, version: '2.0.0' })
  assert.equal(probe.source, 'probe')
  assert.deepEqual(probe.capabilities, { edit: true, exec: true, web: false })
  assert.deepEqual(probe.unverified, ['web'])
})

test('a tools service without get is an unverified fallback, not a crash', async () => {
  clearProbeCache()
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { resolve: async () => ({ id: 'standard' }) }
      if (name === 'tools') return { resolve: async () => { throw new Error('needs a live agent') } }
      return undefined
    },
  }
  const probe = await probeDsh({ ctx })
  assert.equal(probe.source, 'fallback')
  assert.match(probe.evidence.reason, /工具清单/)
})

test('a DSH probe that cannot resolve the preset or list tools is a fallback (all unverified)', async () => {
  clearProbeCache()
  const missing = await probeDsh({ ctx: { get: name => (name === 'agentPresets' ? { resolve: async () => undefined } : undefined) }, preset: 'nope' })
  assert.equal(missing.source, 'fallback')
  assert.match(missing.evidence.reason, /nope/)
  assert.deepEqual(capabilitiesOf(missing), { edit: false, exec: false, web: false })
  const blind = await probeDsh({ ctx: { get: name => (name === 'agentPresets' ? { resolve: async () => ({ id: 'standard' }) } : undefined) } })
  assert.equal(blind.source, 'fallback')
  assert.match(blind.evidence.reason, /工具清单/)
})

test('probeBackend caches per (preset, host version) and re-probes after a version change', async () => {
  clearProbeCache()
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'agentPresets') {
        return { resolve: async () => { calls.push(1); return { id: 'standard', tools: ['write', 'bash'] } } }
      }
      return undefined
    },
  }
  const first = await probeBackend({ backend: 'dsh', ctx, preset: 'standard', version: '1.0.0' })
  await probeBackend({ backend: 'dsh', ctx, preset: 'standard', version: '1.0.0' })
  assert.equal(calls.length, 1)
  const upgraded = await probeBackend({ backend: 'dsh', ctx, preset: 'standard', version: '1.1.0' })
  assert.equal(calls.length, 2)
  assert.equal(capabilityStateOf(first, { version: '1.0.0' }), 'verified')
  assert.equal(capabilityStateOf(first, { version: '1.1.0' }), 'stale')
  assert.equal(capabilityStateOf(fallbackProbe('dsh')), 'unverified')
  assert.equal(verifiedAtOf(upgraded), upgraded.verifiedAt)
})

test('CLI backends are only usable with an explicit smoke result', async () => {
  const blind = await probeBackend({ backend: 'claude', version: '2.1.329' })
  assert.equal(blind.source, 'fallback')
  assert.deepEqual(capabilitiesOf(blind), { edit: false, exec: false, web: false })
  const smoked = await probeBackend({
    backend: 'claude',
    smoke: { capabilities: { edit: true, exec: true, web: false }, unverified: ['web'], evidence: { version: '2.1.329' } },
  })
  assert.equal(smoked.source, 'smoke')
  assert.deepEqual(capabilitiesOf(smoked), { edit: true, exec: true, web: false })
})

test('smoke evidence persists, is requested once per version and survives a missing file', async () => {
  const dir = await tempDir()
  try {
    assert.deepEqual(readBackendVerify(dir).backends, {})
    assert.equal(needsSmoke(readBackendVerify(dir), 'claude', '2.1.329'), true)
    await recordSmoke(dir, 'claude', {
      version: '2.1.329', command: 'claude -p --tools Bash "run: printf sa-probe"',
      summary: 'sa-probe', capabilities: { edit: true, exec: true, web: false },
    })
    const mode = (await stat(join(dir, BACKEND_VERIFY_FILE))).mode & 0o777
    assert.equal(mode, 0o600)
    const ledger = readBackendVerify(dir)
    assert.equal(ledger.backends.claude.version, '2.1.329')
    assert.equal(ledger.backends.claude.capabilities.exec, true)
    assert.equal(needsSmoke(ledger, 'claude', '2.1.329'), false)
    assert.equal(needsSmoke(ledger, 'claude', '2.2.0'), true)
    const raw = await readFile(join(dir, BACKEND_VERIFY_FILE), 'utf8')
    assert.equal(raw.includes('token'), false)
    await writeFile(join(dir, BACKEND_VERIFY_FILE), 'not json')
    assert.deepEqual(readBackendVerify(dir).backends, {})
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('TOOL_CAPABILITIES covers edit, exec and web with the host tool names', () => {
  assert.deepEqual(Object.keys(TOOL_CAPABILITIES).sort(), ['edit', 'exec', 'web'])
  assert.ok(TOOL_CAPABILITIES.edit.includes('write'))
  assert.deepEqual(TOOL_CAPABILITIES.exec, ['bash'])
  assert.deepEqual(TOOL_CAPABILITIES.web, ['web_search', 'web_fetch'])
})

test('AC-B2: the persisted smoke run is a CLI backend\'s evidence, and a version change makes it stale', async () => {
  const dir = await tempDir()
  try {
    await recordSmoke(dir, 'claude', { version: '2.1.329', command: 'claude --version', summary: 'ok',
      capabilities: { edit: true, exec: true, web: false } })
    const ctx = { stateDir: dir, get: () => undefined }
    const probe = await probeBackend({ backend: 'claude', ctx })
    assert.equal(probe.source, 'smoke')
    assert.deepEqual(capabilitiesOf(probe), { edit: true, exec: true, web: false })
    assert.equal(capabilityStateOf(probe, { version: '2.1.329' }), 'verified')
    assert.equal(capabilityStateOf(probe, { version: '2.2.0' }), 'stale')
    const checked = validateProfile({ id: 'cli', name: 'CLI', backend: 'claude', requires: ['edit'] },
      { backendState: 'stale', capabilities: capabilitiesOf(probe) })
    assert.equal(checked.code, 'PROFILE_BACKEND_STALE')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AC-B2: the host version comes from an injected resolver or DSH_VERSION, and an upgrade re-probes', async () => {
  clearProbeCache()
  const previous = process.env.DSH_VERSION
  process.env.DSH_VERSION = '3.0.0'
  try {
    assert.equal(hostVersionOf({}), '3.0.0')
    assert.equal(hostVersionOf({ hostVersion: ' 3.1.0 ' }), '3.1.0')
    assert.equal(hostVersionOf({ hostVersion: () => '3.2.0' }), '3.2.0')
    delete process.env.DSH_VERSION
    assert.equal(hostVersionOf({}), undefined)
    assert.equal(hostVersionOf({ hostVersion: () => { throw new Error('nope') } }), undefined)
  } finally {
    if (previous === undefined) delete process.env.DSH_VERSION
    else process.env.DSH_VERSION = previous
  }
  // A host upgrade must not be served by the old probe: the cache key carries the version (§3.3).
  const before = await probeBackend({ backend: 'dsh', preset: 'standard',
    ctx: { ...fakeCtx({ tools: ['write'] }), hostVersion: '1.0.0' } })
  const after = await probeBackend({ backend: 'dsh', preset: 'standard',
    ctx: { ...fakeCtx({ tools: ['write', 'bash'] }), hostVersion: '1.1.0' } })
  assert.equal(before.evidence.version, '1.0.0')
  assert.equal(before.capabilities.exec, false)
  assert.equal(after.evidence.version, '1.1.0')
  assert.equal(after.capabilities.exec, true)
})
