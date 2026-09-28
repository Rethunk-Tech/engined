/**
 * One name per HTTP status code this door ever returns, and the one shape
 * every JSON error body takes. A status meaning is decided once here; a
 * caller that reaches for a bare number instead of one of these constants
 * is the bug this file exists to prevent.
 */

import { EngineBusyError } from './errors/engineBusy.ts'
import { HeldError } from './errors/held.ts'
import { isRecord, parseRecord } from './records.ts'

export const STATUS_OK = 200
export const STATUS_BAD_REQUEST = 400
export const STATUS_UNAUTHORIZED = 401
export const STATUS_PAYMENT_REQUIRED = 402
export const STATUS_FORBIDDEN = 403
export const STATUS_NOT_FOUND = 404
export const STATUS_METHOD_NOT_ALLOWED = 405
export const STATUS_CONFLICT = 409
export const STATUS_PAYLOAD_TOO_LARGE = 413
export const STATUS_TOO_MANY_REQUESTS = 429
/** The client hung up before an answer. Nobody reads this body; it exists so the provenance line and the chain's own return value agree on why it stopped. */
export const STATUS_CLIENT_CLOSED = 499
export const STATUS_BAD_GATEWAY = 502
export const STATUS_UNAVAILABLE = 503
/** A 4xx is the caller's fault rather than the engine's, but the attempt still produced no output, so it is not a success. */
export const HTTP_CLIENT_ERROR_MIN = 400
export const HTTP_SERVER_ERROR_MIN = 500
export const STATUS_INTERNAL_SERVER_ERROR = 500
export const HTTP_SERVER_ERROR_MAX = 600

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

/**
 * OpenAI's error object, used on every JSON error this door returns — both
 * `/openai/v1/*` and `/engined/v1/*`. `type` is derived from the status so a
 * caller never has to pick it; `param` and `code` stay null because this door
 * does not name a request field or a machine-readable code.
 */
type OpenAiErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'rate_limit_error'
  | 'insufficient_quota'
  | 'server_error'

export interface OpenAiErrorBody {
  error: {
    message: string
    type: OpenAiErrorType
    param: null
    code: null
  }
}

function errorTypeFromStatus(status: number): OpenAiErrorType {
  if (status === STATUS_TOO_MANY_REQUESTS) {
    return 'rate_limit_error'
  }
  if (status === STATUS_UNAUTHORIZED) {
    return 'authentication_error'
  }
  if (status === STATUS_FORBIDDEN) {
    return 'permission_error'
  }
  if (status === STATUS_NOT_FOUND) {
    return 'not_found_error'
  }
  if (status === STATUS_PAYMENT_REQUIRED) {
    return 'insufficient_quota'
  }
  if (status >= HTTP_SERVER_ERROR_MIN) {
    return 'server_error'
  }
  return 'invalid_request_error'
}

/** The one JSON error shape, for a caller that builds its own response envelope (`DoorResponse`, `HopResult`) around it. */
export function jsonErrorBody(status: number, message: string): OpenAiErrorBody {
  return {
    error: {
      message,
      type: errorTypeFromStatus(status),
      param: null,
      code: null,
    },
  }
}

/** The same shape, already wrapped as a `Response` — for a caller returning straight to the door's own `fetch`. */
export function jsonError(status: number, message: string): Response {
  return Response.json(jsonErrorBody(status, message), { status })
}

/**
 * The one status a registry-driven start/dispatch failure gets, everywhere a
 * door catches one: a model switch that would kill a request in flight is a
 * 409, a held engine is a 503 the caller is meant to retry, and anything
 * else got no more specific reason out of the engine's own supply chain, so
 * it answers as the door's own upstream failure -- 502. One function so a
 * fourth call site cannot invent a fourth ordering of the same three checks.
 */
export function engineErrorStatus(err: unknown): number {
  if (err instanceof EngineBusyError) {
    return STATUS_CONFLICT
  }
  if (err instanceof HeldError) {
    return STATUS_UNAVAILABLE
  }
  return STATUS_BAD_GATEWAY
}

/** A known path asked with a method it does not serve. `Allow` names every method that path does. */
export function methodNotAllowed(allow: readonly string[]): Response {
  const res = jsonError(STATUS_METHOD_NOT_ALLOWED, 'method not allowed')
  res.headers.set('Allow', allow.join(', '))
  return res
}

/** The GET answer with its body dropped: HEAD on a GET route. */
export async function headOf(res: Response | Promise<Response>): Promise<Response> {
  const answered = await res
  await discardBody(answered)
  return new Response(null, { status: answered.status, headers: answered.headers })
}

/** The human sentence inside a door error body, whether the body is the current object or a leftover string `error`. */
export function errorMessageOf(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined
  }
  const { error } = body
  if (typeof error === 'string') {
    return error
  }
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message
  }
  return undefined
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

/** SSE allows LF, CRLF, or CR as the frame separator; matching only `\n\n` drops a CRLF-framed body. */
const SSE_FRAME_BOUNDARY = /\r\n\r\n|\n\n|\r\r/

/** Past this with no frame boundary the body is not SSE, so the scan stops holding it. Generous for one frame; nothing near a whole reply. */
const MAX_CARRY_BYTES = 65_536

/** Bytes kept while discarding so a boundary that straddles two chunks is still seen. Longest boundary is `\r\n\r\n`. */
const DISCARD_BOUNDARY_TAIL = 3

/** One frame boundary at the start of a string, so the separator itself can be stripped once `search` has found where it starts. */
const LEADING_FRAME_BOUNDARY = /^(?:\r\n\r\n|\n\n|\r\r)/

function dropThroughBoundary(carry: string): { carry: string; discarding: boolean } {
  const at = carry.search(SSE_FRAME_BOUNDARY)
  if (at === -1) {
    return {
      carry: carry.slice(Math.max(0, carry.length - DISCARD_BOUNDARY_TAIL)),
      discarding: true,
    }
  }
  return { carry: carry.slice(at).replace(LEADING_FRAME_BOUNDARY, ''), discarding: false }
}

/** Split complete SSE frames off `carry`. A carry past `MAX_CARRY_BYTES` is dropped: that body is not framed, and holding it would grow with the reply. After a drop, further input is discarded through the next frame boundary so the oversized frame's tail is never yielded. */
export function splitSseFrames(
  carry: string,
  discarding = false,
): { frames: string[]; carry: string; discarding: boolean } {
  let pending = carry
  if (discarding) {
    const dropped = dropThroughBoundary(carry)
    if (dropped.discarding) {
      return { frames: [], carry: dropped.carry, discarding: true }
    }
    pending = dropped.carry
  }
  const parts = pending.split(SSE_FRAME_BOUNDARY)
  const next = parts.pop() ?? ''
  if (next.length > MAX_CARRY_BYTES) {
    return { frames: parts, carry: '', discarding: true }
  }
  return { frames: parts, carry: next, discarding: false }
}

const SSE_LINE_BREAK = /\r\n|\r|\n/

/** JSON payloads from `data:` lines in one frame. Comment, event, and empty/`[DONE]` lines are not payloads. */
export function sseDataPayloads(frame: string): string[] {
  const payloads: string[] = []
  for (const line of frame.split(SSE_LINE_BREAK)) {
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

/**
 * Yield each complete SSE frame from `body`, then a trimmed leftover with no
 * trailing boundary. The reader is cancelled on the way out, including when
 * the caller returns from a `for await` before the stream ends. A caller that
 * must also watch the source's `closed` hands in the reader it already holds.
 */
export async function* sseFrames(
  body:
    | ReadableStream<Uint8Array>
    | { read: () => Promise<{ done: boolean; value?: Uint8Array }>; cancel: () => Promise<void> },
): AsyncGenerator<string> {
  const reader = body instanceof ReadableStream ? body.getReader() : body
  const decoder = new TextDecoder()
  let carry = ''
  let discarding = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (value) {
        carry += decoder.decode(value, { stream: true })
      }
      if (done) {
        carry += decoder.decode()
      }
      const split = splitSseFrames(carry, discarding)
      carry = split.carry
      discarding = split.discarding
      for (const frame of split.frames) {
        yield frame
      }
      if (!done) {
        continue
      }
      if (!discarding && carry.trim() !== '') {
        yield carry
      }
      return
    }
  } finally {
    reader.cancel().catch(() => undefined)
  }
}

/**
 * An uploaded image is held in memory whole before it is forwarded, so an
 * oversized one is refused rather than read. Generous for anything a
 * diffusion model will accept as a starting point.
 */
export const MAX_IMAGE_UPLOAD_BYTES = 33_554_432

/** One wording for the image ceiling, so the declared length and what actually arrived cannot drift apart. */
export function imageTooLarge(bytes: number): Response {
  return jsonError(
    STATUS_PAYLOAD_TOO_LARGE,
    `"image" is ${bytes} bytes; the limit is ${MAX_IMAGE_UPLOAD_BYTES}`,
  )
}

/** JSON routes share this ceiling; the Bun server's larger upload cap is for audio, not tables. */
export const MAX_JSON_BODY_BYTES = 32 * 1024 * 1024

/**
 * A request body within `max` bytes, or the 413/400 to return instead;
 * `tooLarge` words the 413 from the byte count that tripped it. The cap counts
 * bytes as they arrive, so a chunked body with no Content-Length is cancelled
 * at the cap rather than buffered whole first. A client that hangs up
 * mid-upload makes the read throw, and that is the caller's malformed request,
 * not this door's failure.
 */
export async function readCappedBytes(
  req: Request,
  max: number,
  tooLarge: (bytes: number) => Response,
): Promise<Uint8Array | Response> {
  const declared = declaredOverLimit(req, max)
  if (declared !== undefined) {
    return tooLarge(declared)
  }
  if (req.body === null) {
    return new Uint8Array()
  }
  const reader = req.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > max) {
        reader.cancel().catch(() => undefined)
        return tooLarge(total)
      }
      chunks.push(value)
    }
  } catch {
    return jsonError(STATUS_BAD_REQUEST, 'request body could not be read')
  }
  return Buffer.concat(chunks)
}

/** What `Request.formData()` resolves to; Bun types it apart from the global `FormData` an outgoing form is built with. */
export type RequestForm = Awaited<ReturnType<Request['formData']>>

/**
 * A multipart form within `max` bytes, or the 413/400 to return instead;
 * `undefined` for a body that arrived whole but is not a form, whose 400 each
 * verb words for the part it expects.
 */
export async function readCappedForm(
  req: Request,
  max: number,
  tooLarge: (bytes: number) => Response,
): Promise<RequestForm | Response | undefined> {
  const bytes = await readCappedBytes(req, max, tooLarge)
  if (bytes instanceof Response) {
    return bytes
  }
  // The boundary lives in the caller's Content-Type, so the headers travel with the bytes.
  return await new Response(bytes, { headers: req.headers }).formData().catch(() => undefined)
}

/** A request body within the JSON routes' ceiling, decoded, or the 413/400 to return instead. */
export async function readCappedText(req: Request): Promise<string | Response> {
  const bytes = await readCappedBytes(req, MAX_JSON_BODY_BYTES, () =>
    jsonError(STATUS_PAYLOAD_TOO_LARGE, 'JSON body too large'),
  )
  return bytes instanceof Response ? bytes : new TextDecoder().decode(bytes)
}

/**
 * Every JSON body this door reads, or the 400 to return instead. A table is
 * the only accepted shape: `null`, an array and a bare scalar all parse as
 * valid JSON and none of them has the fields a handler goes on to read, so
 * they are rejected here rather than at the first property access. A
 * `Response` back means exactly that; the caller returns it unchanged.
 */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  const raw = await readCappedText(req)
  if (raw instanceof Response) {
    return raw
  }
  return parseRecord(raw) ?? jsonError(STATUS_BAD_REQUEST, 'invalid JSON body')
}

/**
 * `readJsonBody`, plus the "model is required" check every model-taking verb
 * (`/engined/v1/start`, `/engined/v1/tokenize`) repeats. Returns the parsed
 * body alongside the model so a caller with other fields to read (tokenize's
 * `content`) still has it.
 */
export async function readModelBody(
  req: Request,
): Promise<{ body: Record<string, unknown>; model: string } | Response> {
  const body = await readJsonBody(req)
  if (body instanceof Response) {
    return body
  }
  const model = typeof body.model === 'string' ? body.model : ''
  if (model === '') {
    return jsonError(STATUS_BAD_REQUEST, 'model is required')
  }
  return { body, model }
}
