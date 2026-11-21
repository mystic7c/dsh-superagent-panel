import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BACKEND_VERIFY_FILE, TOOL_CAPABILITIES, capabilityStateOf, clearProbeCache, fallbackProbe, needsSmoke,
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
