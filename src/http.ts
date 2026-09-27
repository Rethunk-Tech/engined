/**
 * One name per HTTP status code this door ever returns, and the one shape
 * every JSON error body takes. A status meaning is decided once here; a
 * caller that reaches for a bare number instead of one of these constants
 * is the bug this file exists to prevent.
 */

export const STATUS_OK = 200
export const STATUS_BAD_REQUEST = 400
export const STATUS_UNAUTHORIZED = 401
export const STATUS_PAYMENT_REQUIRED = 402
export const STATUS_FORBIDDEN = 403
export const STATUS_NOT_FOUND = 404
export const STATUS_CONFLICT = 409
export const STATUS_PAYLOAD_TOO_LARGE = 413
export const STATUS_TOO_MANY_REQUESTS = 429
/** The client hung up before an answer. Nobody reads this body; it exists so the provenance line and the chain's own return value agree on why it stopped. */
export const STATUS_CLIENT_CLOSED = 499
export const STATUS_BAD_GATEWAY = 502
export const STATUS_UNAVAILABLE = 503

/** How much of an engine's error body is worth repeating: enough to name the failure, not the whole reply. */
export const ENGINE_ERROR_CHARS = 300

/**
 * The header every response here sets, and the media types this door speaks:
 * JSON for the OpenAI shapes, SSE for a streamed hop or the engine-event
 * feed, and the two whisper/TTS body types. Named here rather than beside
 * each writer so the reader and the writer of a body cannot spell it
 * differently.
 */
export const CONTENT_TYPE = 'content-type'
export const JSON_CONTENT_TYPE = 'application/json'
export const SSE_CONTENT_TYPE = 'text/event-stream'
export const TEXT_CONTENT_TYPE = 'text/plain'
export const WAV_CONTENT_TYPE = 'audio/wav'
/** Frame-per-line, so a caller reads progress as it lands rather than after the body ends. */
export const NDJSON_CONTENT_TYPE = 'application/x-ndjson'
/** An upload the door forwards as-is, with no form around it -- the recording a streamed transcription decodes. */
export const OCTET_STREAM_CONTENT_TYPE = 'application/octet-stream'
/**
 * Streamed speech. The rate and encoding ride in the type because there is no
 * container to carry them: signed 16-bit little-endian mono, at whatever the
 * engine that answered synthesizes. The rate is a parameter and not a constant
 * because the engines disagree -- piper's voice is 22.05 kHz where kokoro is
 * 24 kHz, and a caller told the wrong one plays the audio at the wrong pitch
 * with nothing to signal it.
 */
export function pcmContentType(rate: number): string {
  return `audio/L16; rate=${rate}; channels=1`
}

/** The one JSON error shape, for a caller that builds its own response envelope (`DoorResponse`, `HopResult`) around it. */
export function jsonErrorBody(message: string): { error: string } {
  return { error: message }
}

/** The same shape, already wrapped as a `Response` — for a caller returning straight to the door's own `fetch`. */
export function jsonError(status: number, message: string): Response {
  return Response.json(jsonErrorBody(message), { status })
}

/**
 * The Content-Length the caller declared, when it is a finite number past
 * `max`. An absent or unparseable header is not a refusal — the body is still
 * read and measured. Every oversized upload is 413; the wording of that 413
 * is the caller's, because the verbs do not share one noun for the bytes.
 */
export function declaredOverLimit(req: Request, max: number): number | undefined {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN)
  return Number.isFinite(declared) && declared > max ? declared : undefined
}

/** A 4xx is the caller's fault rather than the engine's, but the attempt still produced no output, so it is not a success. */
export const HTTP_CLIENT_ERROR_MIN = 400
export const HTTP_SERVER_ERROR_MIN = 500
export const STATUS_INTERNAL_SERVER_ERROR = HTTP_SERVER_ERROR_MIN
export const HTTP_SERVER_ERROR_MAX = 600

/** Narrower than `typeof fetch`: Bun's `fetch` type also carries a static `preconnect`, which a plain test double has no reason to fake. */
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Releases a response whose body this door will not read.
 *
 * Dropping an unread body does not tell the far side to stop: measured against
 * a source stream that records its own cancellation, twenty-five dropped
 * bodies produced zero cancellations, while an explicit `cancel()` produced
 * one each. An engine answering an error still holds its producer open until
 * something collects it, so the door releases it on the way out.
 *
 * Suppressed rather than surfaced: a cancel that rejects must not replace the
 * engine's own error with a cleanup one.
 */
export async function discardBody(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined)
}

export const SSE_FRAME_BOUNDARY = '\n\n'

/** Past this with no frame boundary the body is not SSE, so the scan stops holding it. Generous for one frame; nothing near a whole reply. */
const MAX_CARRY_BYTES = 65_536

/** Split complete SSE frames off `carry`. A carry past `MAX_CARRY_BYTES` is dropped: that body is not framed, and holding it would grow with the reply. */
export function splitSseFrames(carry: string): { frames: string[]; carry: string } {
  const parts = carry.split(SSE_FRAME_BOUNDARY)
  const next = parts.pop() ?? ''
  return { frames: parts, carry: next.length > MAX_CARRY_BYTES ? '' : next }
}

/** JSON payloads from `data:` lines in one frame. Comment, event, and empty/`[DONE]` lines are not payloads. */
export function sseDataPayloads(frame: string): string[] {
  const payloads: string[] = []
  for (const line of frame.split('\n')) {
    if (!line.startsWith('data:')) {
      continue
    }
    const data = line.slice('data:'.length).trim()
    if (data === '' || data === '[DONE]') {
      continue
    }
    payloads.push(data)
  }
  return payloads
}
