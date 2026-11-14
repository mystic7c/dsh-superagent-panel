/**
 * DeepSeek JSON Output for the staged review.
 *
 * The official DeepSeek route accepts a top-level `response_format: {type:'json_object'}`. The generic `llm.stream`
 * surface does not carry that field, but a plugin may register top-level request fields through
 * `deepseekLlmApiExtensions` (its map is declaration-merged and empty by default), which is how this module turns
 * JSON mode on for review turns only.
 *
 * Two rules keep that safe:
 * - only requests whose prompt carries {@link REVIEW_JSON_MARKER} are touched, so normal chat and worker turns keep
 *   their free-form output;
 * - a review turn that has not seen any tool result yet keeps free-form output too, because JSON mode on the first
 *   exploration step would push the reviewer to answer before it read the code.
 */

/** Marks the review prompt; the extension never touches a request that does not carry it. */
export const REVIEW_JSON_MARKER = 'Return only a json object with keys: verdict, findings, evidence.'

/** Top-level DeepSeek request field for the verdict turn: {type:'json_object'} (the API requires "json" in the prompt). */
export const reviewJsonFormatProvider = {
  prepare({ body } = /** @type {Record<string, any>} */ ({})) {
    if (body === undefined || body === null) return undefined
    let text
    try { text = JSON.stringify(body) } catch { return undefined }
    if (!text.includes(REVIEW_JSON_MARKER)) return undefined
    const tools = Array.isArray(body.tools) ? body.tools : []
    const messages = Array.isArray(body.messages) ? body.messages : []
    const sawToolResult = messages.some(message => message && message.role === 'tool')
    if (tools.length && !sawToolResult) return undefined
    return { value: { type: 'json_object' } }
  },
}

/**
 * Register the JSON-mode field on the host plugin context. Returns false when the host does not expose the DeepSeek
 * extension registry (another provider, or an older Harness); the review still works through its prompt then.
 */
export function registerReviewJsonMode(ctx, log = /** @type {(message: string) => void} */ (() => {})) {
  const extensions = /** @type {any} */ (ctx?.get?.('deepseekLlmApiExtensions'))
  if (!extensions || typeof extensions.register !== 'function') return false
  try {
    const registered = extensions.register('response_format', reviewJsonFormatProvider)
    if (registered && typeof registered.catch === 'function') {
      registered.catch(error => log(error instanceof Error ? error.message : String(error)))
    }
    return true
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    return false
  }
}
