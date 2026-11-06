import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createOctoClient, normalizeSyncedMessage, decodePayload } from './octo.js'

const payload = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64')

const syncEnvelope = {
  ok: true,
  data: {
    start_message_seq: 0,
    end_message_seq: 0,
    messages: [
      {
        channel_id: 'chat-1', channel_type: 2, message_id: 9001, message_idstr: '9001', message_seq: 197,
        from_uid: 'user-1', payload: payload({ content: '@bot 修复收款校验', type: 1, mention: { uids: ['bot'] } }),
        timestamp: 1792465120,
      },
      {
        channel_id: 'chat-1', channel_type: 2, message_id: 9002, message_idstr: '9002', message_seq: 198,
        from_uid: '', payload: payload({ type: 1001, content: 'ignored system notice' }), timestamp: 1792465121,
      },
    ],
  },
  identity: { bot_kind: 'user_bot' },
}

function fakeClient(handler) {
  const calls = []
  const exec = async (argv) => { calls.push(argv); return { stdout: JSON.stringify(handler(argv)), stderr: '', code: 0 } }
  return { client: createOctoClient({ token: 'bf_test', exec }), calls }
}

test('syncMessages calls message sync with the latest-window arguments', async () => {
  const { client, calls } = fakeClient(() => syncEnvelope)
  const result = await client.syncMessages({ channelId: 'chat-1', channelType: 2, limit: 50 })
  assert.equal(result.messages.length, 2)
  assert.deepEqual(result.messages.map(message => message.messageSeq), [197, 198])
  assert.equal(result.messages[0].text, '@bot 修复收款校验')
  assert.equal(result.messages[0].mention.uids[0], 'bot')
  assert.equal(result.messages[0].at, new Date(1792465120 * 1000).toISOString())
  assert.equal(result.messages[1].text, '')
  assert.deepEqual(calls[0].slice(1, 8), ['message','sync','--channel-id','chat-1','--channel-type','2','--start-message-seq'])
  assert.ok(calls[0].includes('--end-message-seq'))
  assert.ok(calls[0].includes('0'))
})

test('normalizeSyncedMessage keeps absent sender/channel undefined and decodes an object payload', () => {
  const message = normalizeSyncedMessage({ message_seq: '5', payload: { type: 1, content: 'hi' }, timestamp: 0 })
  assert.equal(message.messageSeq, 5)
  assert.equal(message.fromUid, undefined)
  assert.equal(message.channelId, undefined)
  assert.equal(message.text, 'hi')
  assert.ok(message.at)
})

test('decodePayload tolerates invalid base64/JSON and non-object values', () => {
  assert.deepEqual(decodePayload(undefined), {})
  assert.deepEqual(decodePayload('not-base64!!'), {})
  assert.deepEqual(decodePayload(Buffer.from('123').toString('base64')), {})
  assert.deepEqual(decodePayload({ content: 'x', type: 1 }), { content: 'x', type: 1 })
})
