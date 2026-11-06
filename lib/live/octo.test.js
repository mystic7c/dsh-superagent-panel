import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOctoClient, readToken, tokenFromEnvironment, OctoError } from './octo.js'

const DEFAULT_CLI = 'octo-cli'

function envelope(data, identity = { type: 'bot' }) {
  return JSON.stringify({ ok: true, data, identity })
}

function pollResult(events, identity) {
  return { stdout: envelope({ status: 1, results: events }, identity), stderr: '', code: 0 }
}

/** Fake exec that records calls and delegates to a handler. */
function fakeExec(handler) {
  const calls = []
  const exec = async (argv, options) => {
    calls.push({ argv, options })
    return handler(argv, options, calls.length)
  }
  exec.calls = calls
  return exec
}

function tempToken(content) {
  const dir = mkdtempSync(join(tmpdir(), 'octo-client-test-'))
  const file = join(dir, 'octo.token')
  writeFileSync(file, content, { mode: 0o600 })
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test('token resolution: explicit, then file, then env; missing token errors', async () => {
  const temp = tempToken(' file-token \n')
  const saved = process.env.OCTO_TOKEN
  try {
    process.env.OCTO_TOKEN = 'env-token'

    const explicitExec = fakeExec(() => pollResult([]))
    const explicitClient = createOctoClient({
      token: 'explicit-token',
      tokenFile: temp.file,
      exec: explicitExec,
    })
    await explicitClient.pollEvents()
    assert.equal(explicitExec.calls[0].options.env.OCTO_TOKEN, 'explicit-token')

    const fileExec = fakeExec(() => pollResult([]))
    const fileClient = createOctoClient({ tokenFile: temp.file, exec: fileExec })
    await fileClient.pollEvents()
    assert.equal(fileExec.calls[0].options.env.OCTO_TOKEN, 'file-token')

    delete process.env.OCTO_TOKEN
    const optionsEnvExec = fakeExec(() => pollResult([]))
    const optionsEnvClient = createOctoClient({
      env: { OCTO_TOKEN: 'options-env-token' },
      exec: optionsEnvExec,
    })
    await optionsEnvClient.pollEvents()
    assert.equal(optionsEnvExec.calls[0].options.env.OCTO_TOKEN, 'options-env-token')

    process.env.OCTO_TOKEN = 'env-token'
    const envExec = fakeExec(() => pollResult([]))
    const envClient = createOctoClient({ exec: envExec })
    await envClient.pollEvents()
    assert.equal(envExec.calls[0].options.env.OCTO_TOKEN, 'env-token')

    delete process.env.OCTO_TOKEN
    assert.throws(
      () => createOctoClient({ exec: fakeExec(() => pollResult([])) }),
      error => error instanceof OctoError
        && error.code === 'no-token'
        && error.message === 'octo token is not configured',
    )

    assert.throws(
      () => readToken(join(temp.dir, 'missing.token')),
      error => error instanceof OctoError && error.code === 'token-file',
    )

    assert.equal(tokenFromEnvironment({ OCTO_TOKEN: '  from-env  ' }), 'from-env')
    assert.equal(tokenFromEnvironment({}), undefined)
  } finally {
    if (saved === undefined) delete process.env.OCTO_TOKEN
    else process.env.OCTO_TOKEN = saved
    temp.cleanup()
  }
})

test('pollEvents normalizes DM and group events, keeping absent channels undefined', async () => {
  const dmEvent = {
    event_id: 10,
    message: {
      from_uid: 'user-dm',
      message_id: '9001',
      message_seq: 3,
      payload: { content: 'hello', type: 1, space_id: 'space-1' },
      timestamp: 1700000000,
    },
  }
  const groupEvent = {
    event_id: '11',
    event_type: 'message.create',
    message: {
      from_uid: 'user-group',
      message_id: 9002,
      message_seq: 4,
      channel_id: 'chan-a',
      channel_type: '2',
      payload: { content: 'group hello', type: '1' },
      timestamp: '1700000001',
    },
  }
  const rootGroupEvent = {
    event_id: 12,
    channel_id: 'chan-b',
    channel_type: 2,
    message: {
      from_uid: 'user-root',
      message_id: 9003,
      message_seq: 5,
      payload: { content: 'not text', type: 2 },
      timestamp: 1700000002,
    },
  }
  const noTimestampEvent = {
    event_id: 13,
    message: {
      from_uid: 'user-now',
      message_id: 9004,
      message_seq: 6,
      payload: { content: 'now', type: 1 },
    },
  }

  const exec = fakeExec(() => pollResult([dmEvent, groupEvent, rootGroupEvent, noTimestampEvent]))
  const client = createOctoClient({ token: 'test-token', exec })
  const before = Date.now()
  const result = await client.pollEvents()
  const after = Date.now()

  assert.equal(result.events.length, 4)
  assert.deepEqual(result.identity, { type: 'bot' })
  assert.equal(result.raw.ok, true)

  const [dm, group, rootGroup, noTimestamp] = result.events

  assert.equal(dm.eventId, 10)
  assert.equal(dm.eventType, undefined)
  assert.equal(dm.messageId, 9001)
  assert.equal(dm.seq, 3)
  assert.equal(dm.fromUid, 'user-dm')
  assert.equal(dm.channelId, undefined)
  assert.equal(dm.channelType, undefined)
  assert.equal(dm.contentType, 1)
  assert.equal(dm.text, 'hello')
  assert.deepEqual(dm.payload, { content: 'hello', type: 1, space_id: 'space-1' })
  assert.equal(dm.at, '2023-11-14T22:13:20.000Z')
  assert.deepEqual(dm.raw, dmEvent)

  assert.equal(group.eventId, 11)
  assert.equal(group.eventType, 'message.create')
  assert.equal(group.messageId, 9002)
  assert.equal(group.seq, 4)
  assert.equal(group.fromUid, 'user-group')
  assert.equal(group.channelId, 'chan-a')
  assert.equal(group.channelType, 2)
  assert.equal(group.contentType, 1)
  assert.equal(group.text, 'group hello')
  assert.equal(group.at, '2023-11-14T22:13:21.000Z')

  assert.equal(rootGroup.channelId, 'chan-b')
  assert.equal(rootGroup.channelType, 2)
  assert.equal(rootGroup.contentType, 2)
  assert.equal(rootGroup.text, '')
  assert.equal(rootGroup.at, '2023-11-14T22:13:22.000Z')

  const noTimestampAt = Date.parse(noTimestamp.at)
  assert.ok(Number.isFinite(noTimestampAt))
  assert.ok(noTimestampAt >= before && noTimestampAt <= after)
})

test('pollEvents argv adds --wait only when wait > 0', async () => {
  const exec = fakeExec(() => pollResult([]))
  const client = createOctoClient({ token: 'test-token', exec })

  await client.pollEvents()
  await client.pollEvents({ cursor: 5, limit: 10, wait: 0 })
  await client.pollEvents({ cursor: 7, limit: 3, wait: 4 })

  assert.deepEqual(exec.calls[0].argv, [
    DEFAULT_CLI, 'event', 'list', '--event-id', '0', '--limit', '100', '--format', 'json',
  ])
  assert.deepEqual(exec.calls[1].argv, [
    DEFAULT_CLI, 'event', 'list', '--event-id', '5', '--limit', '10', '--format', 'json',
  ])
  assert.deepEqual(exec.calls[2].argv, [
    DEFAULT_CLI, 'event', 'list', '--event-id', '7', '--limit', '3', '--format', 'json',
    '--wait', '4',
  ])
  assert.equal(exec.calls[0].options.timeoutMs, 30000)

  const customExec = fakeExec(() => pollResult([]))
  const customClient = createOctoClient({
    cliPath: '/tmp/custom-octo-cli',
    token: 'test-token',
    timeoutMs: 1234,
    exec: customExec,
  })
  await customClient.pollEvents({ cursor: 1, limit: 2, wait: 1 })
  assert.deepEqual(customExec.calls[0].argv, [
    '/tmp/custom-octo-cli', 'event', 'list', '--event-id', '1', '--limit', '2', '--format', 'json',
    '--wait', '1',
  ])
  assert.equal(customExec.calls[0].options.timeoutMs, 1234)
})

test('ack sends event ack argv and reports acknowledgement', async () => {
  const exec = fakeExec(() => ({ stdout: '{"ok":true}', stderr: '', code: 0 }))
  const client = createOctoClient({ token: 'test-token', exec })

  assert.deepEqual(await client.ack(42), { acknowledged: true })
  assert.deepEqual(exec.calls[0].argv, [DEFAULT_CLI, 'event', 'ack', '42'])
})

test('sendText builds the exact JSON payload and flags', async () => {
  const exec = fakeExec(() => ({
    stdout: '{"ok":true,"data":{"message_id":77}}',
    stderr: '',
    code: 0,
  }))
  const client = createOctoClient({ token: 'test-token', exec })

  const result = await client.sendText({
    channelId: 'chan-1',
    channelType: 2,
    content: 'hello world',
  })
  assert.deepEqual(exec.calls[0].argv, [
    DEFAULT_CLI, 'message', 'send',
    '--channel-id', 'chan-1',
    '--channel-type', '2',
    '--data', '{"payload":{"type":1,"content":"hello world"}}',
  ])
  assert.equal(result.raw.data.message_id, 77)

  await client.sendText({
    channelId: 'chan-2',
    channelType: '5',
    content: 'thanks',
    onBehalfOf: 'user-9',
  })
  assert.deepEqual(exec.calls[1].argv, [
    DEFAULT_CLI, 'message', 'send',
    '--channel-id', 'chan-2',
    '--channel-type', '5',
    '--data', '{"payload":{"type":1,"content":"thanks"}}',
    '--on-behalf-of', 'user-9',
  ])
})

test('listGroups maps group_no/name/space_id and returns identity', async () => {
  const identity = { type: 'bot', bot_kind: 'user_bot' }
  const exec = fakeExec(() => ({
    stdout: JSON.stringify({
      ok: true,
      data: [{ group_no: 'g-1', name: 'Group One', space_id: 'space-1' }],
      identity,
    }),
    stderr: '',
    code: 0,
  }))
  const client = createOctoClient({ token: 'test-token', exec })

  assert.deepEqual(await client.listGroups(), {
    groups: [{ groupNo: 'g-1', name: 'Group One', spaceId: 'space-1' }],
    identity,
  })
  assert.deepEqual(exec.calls[0].argv, [DEFAULT_CLI, 'group', 'list', '--format', 'json'])

  const wrappedExec = fakeExec(() => ({
    stdout: JSON.stringify({
      ok: true,
      data: { groups: [{ groupNo: 'g-2', name: 'Group Two', spaceId: 'space-2' }] },
    }),
    stderr: '',
    code: 0,
  }))
  const wrappedClient = createOctoClient({ token: 'test-token', exec: wrappedExec })
  const wrapped = await wrappedClient.listGroups()
  assert.deepEqual(wrapped.groups, [{ groupNo: 'g-2', name: 'Group Two', spaceId: 'space-2' }])
})

test('envelope ok:false becomes an OctoError with the token redacted', async () => {
  const token = 'super-secret-token-value'
  const exec = fakeExec(() => ({
    stdout: JSON.stringify({
      ok: false,
      error: {
        code: 'UNAUTHORIZED',
        message: `bad token ${token} rejected`,
      },
    }),
    stderr: `server said ${token}`,
    code: 0,
  }))
  const client = createOctoClient({ token, exec })

  await assert.rejects(client.pollEvents(), error => {
    assert.ok(error instanceof OctoError)
    assert.equal(error.code, 'UNAUTHORIZED')
    assert.equal(error.message, 'bad token *** rejected')
    assert.ok(!error.message.includes(token))
    assert.ok(!String(error.stderr).includes(token))
    assert.ok(String(error.stderr).includes('***'))
    return true
  })
})

test('invalid JSON becomes an OctoError', async () => {
  const token = 'json-secret-token'
  const exec = fakeExec(() => ({
    stdout: 'this is not json',
    stderr: `human readable failure involving ${token}`,
    code: 0,
  }))
  const client = createOctoClient({ token, exec })

  await assert.rejects(client.listGroups(), error => {
    assert.ok(error instanceof OctoError)
    assert.equal(error.code, 'invalid-json')
    assert.ok(error.message.includes('human readable failure'))
    assert.ok(!error.message.includes(token))
    assert.ok(String(error.stderr).includes('***'))
    return true
  })
})

test('timeouts and missing CLI map to OctoError codes', async () => {
  const timeoutExec = fakeExec(() => {
    throw Object.assign(new Error('command timed out with secret-token'), { code: 'ETIMEDOUT' })
  })
  const timeoutClient = createOctoClient({
    token: 'secret-token',
    timeoutMs: 1234,
    exec: timeoutExec,
  })
  await assert.rejects(timeoutClient.pollEvents(), error => {
    assert.ok(error instanceof OctoError)
    assert.equal(error.code, 'timeout')
    assert.ok(error.message.includes('1234'))
    assert.ok(!error.message.includes('secret-token'))
    return true
  })
  assert.equal(timeoutExec.calls[0].options.timeoutMs, 1234)

  const missingExec = fakeExec(() => {
    throw Object.assign(new Error('spawn /nope/octo-cli ENOENT'), { code: 'ENOENT' })
  })
  const missingClient = createOctoClient({
    cliPath: '/nope/octo-cli',
    token: 'test-token',
    exec: missingExec,
  })
  await assert.rejects(missingClient.pollEvents(), error => {
    assert.ok(error instanceof OctoError)
    assert.equal(error.code, 'cli-missing')
    assert.ok(error.message.includes('/nope/octo-cli'))
    return true
  })
})

test('retries once on transient stderr, then succeeds with a redacted warning', async () => {
  const token = 'retry-secret-token'
  const warnings = []
  const exec = fakeExec((argv, options, callNumber) => {
    if (callNumber === 1) {
      return { stdout: '', stderr: `read ECONNRESET while using ${token}`, code: 1 }
    }
    return pollResult([{
      event_id: 1,
      message: {
        from_uid: 'user-1',
        message_id: 10,
        message_seq: 1,
        payload: { type: 1, content: 'after retry' },
        timestamp: 1700000000,
      },
    }])
  })
  const client = createOctoClient({ token, exec, warn: line => warnings.push(line) })

  const result = await client.pollEvents()
  assert.equal(result.events.length, 1)
  assert.equal(result.events[0].text, 'after retry')
  assert.equal(exec.calls.length, 2)
  assert.equal(warnings.length, 1)
  assert.ok(warnings[0].includes('ECONNRESET'))
  assert.ok(!warnings[0].includes(token))
  assert.ok(warnings[0].includes('***'))
})

test('retries only once, and never retries validation errors', async () => {
  const alwaysTransient = fakeExec(() => ({ stdout: '', stderr: 'timeout', code: 1 }))
  const transientClient = createOctoClient({ token: 'test-token', exec: alwaysTransient })
  await assert.rejects(transientClient.pollEvents(), error => {
    assert.ok(error instanceof OctoError)
    assert.equal(error.code, 'command-failed')
    return true
  })
  assert.equal(alwaysTransient.calls.length, 2)

  const validationEnvelope = JSON.stringify({
    ok: false,
    error: { code: 'VALIDATION_ERROR', message: 'a flag was not recognised' },
  })
  const validationExec = fakeExec(() => ({
    stdout: validationEnvelope,
    stderr: 'VALIDATION_ERROR: bad flag',
    code: 2,
  }))
  const validationClient = createOctoClient({ token: 'test-token', exec: validationExec })
  await assert.rejects(validationClient.pollEvents(), error => {
    assert.ok(error instanceof OctoError)
    assert.equal(error.code, 'VALIDATION_ERROR')
    assert.equal(error.message, 'a flag was not recognised')
    return true
  })
  assert.equal(validationExec.calls.length, 1)
})
