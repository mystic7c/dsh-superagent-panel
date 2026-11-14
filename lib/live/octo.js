/**
 * Dependency-free client for the local `octo-cli` (Octo IM bot CLI).
 *
 * The live engine runs in-process but drives the already-installed CLI as a child process. Everything here is
 * deliberately injectable: `createOctoClient({ exec })` lets tests (and the engine) supply a fake exec, while the
 * default wraps `node:child_process.execFile` with a timeout and no shell.
 *
 * The token never appears in argv, error messages or warn lines. It is passed to the CLI through the
 * `OCTO_TOKEN` environment variable and any occurrence in stderr is redacted to `***`.
 */
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

const DEFAULT_CLI_PATH = 'octo-cli'
const DEFAULT_TIMEOUT_MS = 30000
const MAX_BUFFER = 32 * 1024 * 1024
const TRANSIENT_RE = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|timeout/i

/**
 * Error raised for every octo failure (configuration, spawn, timeout, CLI envelope or parse failure).
 * `status` and `stderr` are optional and always redacted when a token is known.
 */
export class OctoError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, status?: number, stderr?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'OctoError'
    if (options.code !== undefined) this.code = options.code
    if (options.status !== undefined) this.status = options.status
    if (options.stderr !== undefined) this.stderr = options.stderr
  }
}

/**
 * Read an octo bot token from a file and trim surrounding whitespace.
 *
 * @param {string} file absolute path to the token file (the engine uses ~/.dsh/superagent/octo.token)
 * @returns {string} the trimmed token
 * @throws {OctoError} code `token-file` when the file is missing, unreadable or empty
 */
export function readToken(file) {
  try {
    if (typeof file !== 'string' || file.length === 0) throw new Error('no token file path')
    const token = readFileSync(file, 'utf8').trim()
    if (!token) throw new OctoError(`octo token file is empty: ${file}`, { code: 'token-file' })
    return token
  } catch (error) {
    if (error instanceof OctoError) throw error
    throw new OctoError(`cannot read octo token file: ${file}`, { code: 'token-file' })
  }
}

/**
 * Read `OCTO_TOKEN` from an env object (defaults to `process.env`).
 *
 * @param {Record<string, string|undefined>} [env]
 * @returns {string|undefined} the trimmed token, or undefined when absent/blank
 */
export function tokenFromEnvironment(env = process.env) {
  const value = env && typeof env === 'object' ? env.OCTO_TOKEN : undefined
  if (typeof value !== 'string') return undefined
  const token = value.trim()
  return token.length > 0 ? token : undefined
}

/**
 * Create an Octo client bound to one CLI path, token and timeout.
 *
 * @param {object} [options]
 * @param {string} [options.cliPath='octo-cli'] CLI executable (argv[0])
 * @param {string} [options.tokenFile] file containing the bot token (read synchronously)
 * @param {string} [options.token] token override (highest precedence)
 * @param {Record<string, string|undefined>} [options.env] extra child environment (OCTO_TOKEN is set from the
 *   resolved token and cannot be overridden here)
 * @param {number} [options.timeoutMs=30000] per-exec timeout in milliseconds
 * @param {(argv: string[], options: { env: object, timeoutMs: number }) => Promise<{stdout: string, stderr: string, code?: number}>} [options.exec]
 *   injection seam; the default wraps execFile
 * @param {(line: string) => void} [options.warn] receives redacted retry warnings
 * @returns {{
 *   pollEvents: (opts?: {cursor?: number, limit?: number, wait?: number}) => Promise<{events: object[], identity: object|undefined, raw: unknown}>,
 *   ack: (eventId: number|string) => Promise<{acknowledged: true}>,
 *   sendText: (opts: {channelId: string|number, channelType: number|string, content: string, onBehalfOf?: string}) => Promise<{raw: unknown}>,
 *   listGroups: () => Promise<{groups: Array<{groupNo: string|undefined, name: string|undefined, spaceId: string|undefined}>, identity: object|undefined}>
 * }}
 * @throws {OctoError} code `no-token` or `token-file` during client creation
 */
export function createOctoClient(options = {}) {
  const token = resolveToken(options)
  const cliPath = typeof options.cliPath === 'string' && options.cliPath.length > 0
    ? options.cliPath
    : DEFAULT_CLI_PATH
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS
  const exec = typeof options.exec === 'function' ? options.exec : defaultExec
  const warn = typeof options.warn === 'function' ? options.warn : undefined
  const env = {
    ...process.env,
    ...(options.env && typeof options.env === 'object' ? options.env : {}),
    OCTO_TOKEN: token,
  }

  /**
   * Run one CLI invocation, retrying exactly once when the first failure looks transient.
   * @param {string[]} argv
   * @returns {Promise<{stdout: string, stderr: string, code?: number}>}
   */
  async function run(argv) {
    let last
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let result
      try {
        result = await exec(argv, { env, timeoutMs })
      } catch (error) {
        throw mapExecError(error, { token, timeoutMs, cliPath })
      }
      const current = normalizeExecResult(result)

      if (current.code === 'ENOENT') throw cliMissing(cliPath, token)
      if (current.code === 'ETIMEDOUT' || current.code === 'ABORT_ERR') throw timeoutError(timeoutMs, token)

      if (current.code === 0 || current.code === undefined || current.code === null) return current

      last = current
      if (attempt === 0 && TRANSIENT_RE.test(current.stderr)) {
        const detail = firstLine(current.stderr) || `exit ${current.code}`
        warn?.(redact(`octo-cli failed transiently (${detail}); retrying once`, token))
        continue
      }
      throw commandError(current, token)
    }
    throw commandError(last, token)
  }

  /**
   * Poll pending bot events.
   * @param {{cursor?: number, limit?: number, wait?: number}} [opts]
   * @returns {Promise<{events: object[], identity: object|undefined, raw: unknown}>}
   */
  async function pollEvents({ cursor = 0, limit = 100, wait = 0 } = {}) {
    const argv = [
      cliPath,
      'event',
      'list',
      '--event-id',
      String(cursor),
      '--limit',
      String(limit),
      '--format',
      'json',
    ]
    if (Number(wait) > 0) argv.push('--wait', String(wait))

    const result = await run(argv)
    const envelope = parseEnvelope(result, token)
    if (envelope.ok === false) throw envelopeError(envelope, result, token)

    const data = isObject(envelope.data) ? envelope.data : {}
    const results = Array.isArray(data.results) ? data.results : []
    return {
      events: results.map(normalizeEvent),
      identity: envelope.identity,
      raw: envelope,
    }
  }

  /**
   * Acknowledge (remove) one event from the bot queue.
   * @param {number|string} eventId
   * @returns {Promise<{acknowledged: true}>}
   */
  async function ack(eventId) {
    const result = await run([cliPath, 'event', 'ack', String(eventId)])
    const envelope = tryParse(result.stdout)
    if (isObject(envelope) && envelope.ok === false) throw envelopeError(envelope, result, token)
    return { acknowledged: true }
  }

  /**
   * Send one plain-text message to a channel (DM, group or thread).
   * @param {{channelId: string|number, channelType: number|string, content: string, onBehalfOf?: string}} opts
   * @returns {Promise<{raw: unknown}>}
   */
  async function sendText({ channelId, channelType, content, onBehalfOf }) {
    const data = JSON.stringify({ payload: { type: 1, content } })
    const argv = [
      cliPath,
      'message',
      'send',
      '--channel-id',
      String(channelId),
      '--channel-type',
      String(channelType),
      '--data',
      data,
    ]
    if (onBehalfOf !== undefined && onBehalfOf !== null && onBehalfOf !== '') {
      argv.push('--on-behalf-of', String(onBehalfOf))
    }

    const result = await run(argv)
    const parsed = tryParse(result.stdout)
    if (isObject(parsed) && parsed.ok === false) throw envelopeError(parsed, result, token)
    return { raw: parsed === undefined ? result.stdout : parsed }
  }

  /**
   * List the groups (spaces) the bot belongs to.
   * @returns {Promise<{groups: Array<{groupNo: string|undefined, name: string|undefined, spaceId: string|undefined}>, identity: object|undefined}>}
   */
  async function listGroups() {
    const result = await run([cliPath, 'group', 'list', '--format', 'json'])
    const envelope = parseEnvelope(result, token)
    if (envelope.ok === false) throw envelopeError(envelope, result, token)

    const rows = Array.isArray(envelope.data)
      ? envelope.data
      : Array.isArray(envelope.data?.groups) ? envelope.data.groups : []
    return {
      groups: rows.map(normalizeGroup),
      identity: envelope.identity,
    }
  }

  /**
   * Pull the latest messages of one group channel. The backend returns the newest `limit` messages ordered by
   * sequence; the engine dedupes by message_seq, so this stays correct while traffic is below the limit.
   * @param {{channelId: string|number, channelType: number|string, limit?: number}} opts
   * @returns {Promise<{messages: Array<object>, identity: object|undefined, raw: unknown}>}
   */
  async function syncMessages({ channelId, channelType, limit = 100 }) {
    const argv = [
      cliPath,
      'message',
      'sync',
      '--channel-id',
      String(channelId),
      '--channel-type',
      String(channelType),
      '--start-message-seq',
      '0',
      '--end-message-seq',
      '0',
      '--limit',
      String(limit),
      '--format',
      'json',
    ]
    const result = await run(argv)
    const envelope = parseEnvelope(result, token)
    if (envelope.ok === false) throw envelopeError(envelope, result, token)
    const data = isObject(envelope.data) ? envelope.data : {}
    const messages = Array.isArray(data.messages) ? data.messages : []
    return { messages: messages.map(normalizeSyncedMessage), identity: envelope.identity, raw: envelope }
  }

  return /** @type {any} */ ({ pollEvents, ack, sendText, listGroups, syncMessages })
}

/**
 * Normalize one `message sync` message: channel facts, sender, sequence, a decoded payload and text.
 * The payload is a base64-encoded JSON string in the observed API; object payloads are accepted too.
 */
export function normalizeSyncedMessage(message = {}) {
  const payload = decodePayload(message.payload)
  const type = Number(payload.type ?? message.payload_type ?? 0) || 0
  const channelType = Number(message.channel_type)
  const timestamp = Number(message.timestamp)
  return {
    messageSeq: Number(message.message_seq),
    messageId: message.message_id ?? message.message_idstr,
    messageIdStr: message.message_idstr,
    fromUid: typeof message.from_uid === 'string' && message.from_uid ? message.from_uid : undefined,
    channelId: typeof message.channel_id === 'string' && message.channel_id ? message.channel_id : undefined,
    channelType: Number.isFinite(channelType) ? channelType : undefined,
    contentType: type,
    text: type === 1 && typeof payload.content === 'string' ? payload.content : '',
    mention: payload.mention,
    at: Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp * 1000).toISOString() : new Date().toISOString(),
    payload,
    raw: message,
  }
}

/** Decode a payload that is either already an object or a base64 JSON string. */
export function decodePayload(payload) {
  if (isObject(payload)) return payload
  if (typeof payload !== 'string' || payload === '') return {}
  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8')
    const parsed = JSON.parse(decoded)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** @param {object} options */
function resolveToken(options) {
  const direct = typeof options.token === 'string' ? options.token.trim() : undefined
  if (direct) return direct

  if (options.tokenFile) return readToken(options.tokenFile)

  const fromOptionsEnv = tokenFromEnvironment(options.env)
  if (fromOptionsEnv) return fromOptionsEnv
  const fromProcessEnv = tokenFromEnvironment(process.env)
  if (fromProcessEnv) return fromProcessEnv

  throw new OctoError('octo token is not configured', { code: 'no-token' })
}

/**
 * Default exec seam: execFile with no shell, utf8 output and a hard timeout.
 * A normal non-zero exit resolves (so the retry layer can inspect stderr); spawn failures reject.
 * @param {string[]} argv
 * @param {{ env: object, timeoutMs: number }} options
 * @returns {Promise<{stdout: string, stderr: string, code?: number}>}
 */
function defaultExec(argv, { env, timeoutMs }) {
  const [file, ...args] = argv
  return new Promise((resolve, reject) => {
    execFile(file, args, { env, timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) {
        resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: 0 })
        return
      }
      if (error.code === 'ENOENT') {
        reject(error)
        return
      }
      if (isTimeoutError(error)) {
        reject(error)
        return
      }
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? (typeof error.message === 'string' ? error.message : ''),
        code: typeof error.code === 'number' ? error.code : 1,
      })
    })
  })
}

/** @param {any} result */
function normalizeExecResult(result) {
  return {
    stdout: typeof result?.stdout === 'string'
      ? result.stdout
      : result?.stdout == null ? '' : String(result.stdout),
    stderr: typeof result?.stderr === 'string'
      ? result.stderr
      : result?.stderr == null ? '' : String(result.stderr),
    code: result?.code,
  }
}

/**
 * Parse the CLI JSON envelope; invalid JSON is an OctoError.
 * @param {{stdout: string, stderr: string, code?: number}} result
 * @param {string} token
 * @returns {Record<string, any>}
 */
function parseEnvelope(result, token) {
  const parsed = tryParse(result.stdout)
  if (!isObject(parsed)) {
    const detail = firstLine(result.stderr)
    throw makeError(detail || 'octo-cli returned invalid JSON', {
      code: 'invalid-json',
      stderr: result.stderr,
    }, token)
  }
  return parsed
}

/** @param {string} stdout */
function tryParse(stdout) {
  if (typeof stdout !== 'string' || stdout.trim().length === 0) return undefined
  try {
    return JSON.parse(stdout)
  } catch {
    return undefined
  }
}

/**
 * Build the error for a CLI envelope with ok:false.
 * @param {Record<string, any>} envelope
 * @param {{stderr?: string}} result
 * @param {string} token
 * @returns {OctoError}
 */
function envelopeError(envelope, result, token) {
  const source = isObject(envelope.error) ? envelope.error : {}
  const message = typeof source.message === 'string' && source.message.length > 0
    ? source.message
    : firstLine(result.stderr) || 'octo-cli request failed'
  const code = typeof source.code === 'string' && source.code.length > 0 ? source.code : 'api-error'
  const status = Number.isFinite(source.status) ? source.status : undefined
  return makeError(message, { code, status, stderr: result.stderr }, token)
}

/**
 * Build the error for a non-zero exit whose stdout is not a usable error envelope.
 * @param {{stdout: string, stderr: string, code?: number}} result
 * @param {string} token
 * @returns {OctoError}
 */
function commandError(result, token) {
  const parsed = tryParse(result.stdout)
  if (isObject(parsed) && parsed.ok === false) return envelopeError(parsed, result, token)
  const message = firstLine(result.stderr) || `octo-cli exited with code ${result.code}`
  return makeError(message, { code: 'command-failed', stderr: result.stderr }, token)
}

/**
 * Map an exception thrown by the exec seam (spawn failure, timeout, abort).
 * @param {any} error
 * @param {{ token: string, timeoutMs: number, cliPath: string }} context
 * @returns {OctoError}
 */
function mapExecError(error, { token, timeoutMs, cliPath }) {
  if (error?.code === 'ENOENT') return cliMissing(cliPath, token)
  if (isTimeoutError(error)) return timeoutError(timeoutMs, token)
  const message = error instanceof Error ? error.message : String(error)
  return makeError(`octo-cli failed: ${message}`, { code: 'exec' }, token)
}

/** @param {string} cliPath @param {string} token */
function cliMissing(cliPath, token) {
  return makeError(`octo-cli was not found at ${cliPath}`, { code: 'cli-missing' }, token)
}

/** @param {number} timeoutMs @param {string} token */
function timeoutError(timeoutMs, token) {
  return makeError(`octo-cli timed out after ${timeoutMs}ms`, { code: 'timeout' }, token)
}

/** @param {any} error */
function isTimeoutError(error) {
  if (!error || typeof error !== 'object') return false
  const code = typeof error.code === 'string' ? error.code : ''
  return code === 'ETIMEDOUT'
    || code === 'ABORT_ERR'
    || error.name === 'AbortError'
    || error.killed === true
    || /\btimed?\s*out\b|timeout/i.test(String(error.message ?? ''))
}

/**
 * Create an OctoError with message/stderr redacted. The token is only ever a secret in the message, never a code.
 * @param {string} message
 * @param {{ code?: string, status?: number, stderr?: string }} options
 * @param {string} token
 * @returns {OctoError}
 */
function makeError(message, options, token) {
  return new OctoError(redact(String(message), token), {
    code: options.code,
    status: options.status,
    stderr: options.stderr === undefined ? undefined : redact(options.stderr, token),
  })
}

/**
 * Replace every literal occurrence of the token with `***`.
 * @param {string} text
 * @param {string} token
 * @returns {string}
 */
function redact(text, token) {
  if (typeof text !== 'string' || !token) return text
  return text.split(token).join('***')
}

/**
 * First non-empty line of stderr/output, capped so a warn line stays readable.
 * @param {string} text
 * @param {number} [max=400]
 * @returns {string}
 */
function firstLine(text, max = 400) {
  if (typeof text !== 'string') return ''
  const line = text.trim().split(/\r?\n/, 1)[0]?.trim() ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** @param {unknown} value */
function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Map one raw event from `event.list` into the engine's stable shape.
 * Tolerates both observed shapes: DM-ish events without channel fields, and group/thread events carrying
 * `channel_id`/`channel_type` on the message or on the event root. A missing channel id stays undefined.
 * @param {any} event
 * @returns {{
 *   eventId: number|string|undefined, eventType: string|undefined,
 *   messageId: number|string|undefined, seq: number|undefined,
 *   fromUid: string|undefined, channelId: string|undefined, channelType: number|undefined,
 *   at: string, contentType: number|undefined, text: string, payload: any, raw: any
 * }}
 */
function normalizeEvent(event) {
  const message = isObject(event?.message) ? event.message : {}
  const payload = message.payload
  const contentRaw = isObject(payload) ? payload.content : undefined
  const contentType = toNumber(payload?.type)
  const channelRaw = firstDefined(
    message.channel_id,
    message.channelId,
    event?.channel_id,
    event?.channelId,
  )
  const channelTypeRaw = firstDefined(
    message.channel_type,
    message.channelType,
    event?.channel_type,
    event?.channelType,
  )
  const timestamp = message.timestamp
  const at = isoFromSeconds(timestamp) ?? new Date().toISOString()

  return {
    eventId: toNumberOrRaw(firstDefined(event?.event_id, event?.eventId)),
    eventType: toOptionalString(firstDefined(event?.event_type, event?.eventType)),
    messageId: toNumberOrRaw(firstDefined(message.message_id, message.messageId, event?.message_id)),
    seq: toNumber(firstDefined(message.message_seq, message.messageSeq, event?.message_seq)),
    fromUid: toOptionalString(firstDefined(message.from_uid, message.fromUid, event?.from_uid)),
    channelId: channelRaw === undefined || channelRaw === null || channelRaw === ''
      ? undefined
      : String(channelRaw),
    channelType: toNumber(channelTypeRaw),
    at,
    contentType,
    text: contentType === 1 && contentRaw !== undefined && contentRaw !== null
      ? (typeof contentRaw === 'string' ? contentRaw : String(contentRaw))
      : '',
    payload,
    raw: event,
  }
}

/**
 * Map one `group.list` row. The CLI schema uses snake_case; camelCase is accepted for robustness.
 * @param {any} group
 */
function normalizeGroup(group) {
  return {
    groupNo: firstDefined(group?.group_no, group?.groupNo, group?.group_id, group?.groupId),
    name: firstDefined(group?.name, group?.group_name, group?.groupName),
    spaceId: firstDefined(group?.space_id, group?.spaceId),
  }
}

/** @param {any[]} values */
/** @param {...any} values @returns {any} */
function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined) return value
  }
  return undefined
}

/** @param {unknown} value @returns {number|undefined} */
function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Numeric ids become numbers; non-numeric ids stay strings. @param {unknown} value @returns {string|number|undefined} */
function toNumberOrRaw(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string') {
    if (value.trim().length === 0) return undefined
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  return value === null ? undefined : /** @type {any} */ (value)
}

/** @param {unknown} value @returns {string|undefined} */
function toOptionalString(value) {
  if (value === undefined || value === null || value === '') return undefined
  return typeof value === 'string' ? value : String(value)
}

/** Seconds (number or numeric string) to ISO; anything else is not a usable timestamp. @param {unknown} value */
function isoFromSeconds(value) {
  let seconds
  if (typeof value === 'number') seconds = value
  else if (typeof value === 'string' && value.trim().length > 0) seconds = Number(value)
  if (!Number.isFinite(seconds)) return undefined
  const date = new Date(seconds * 1000)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}
