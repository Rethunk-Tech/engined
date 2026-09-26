/**
 * The transcription verb at the door: the multipart form it arrives as, the
 * upload ceiling it must stay under, and whether the caller asked to stream.
 */

import type { AnyTranscriptionRequestBody } from './audio.ts'
import {
  type AudioAttempt,
  type AudioLease,
  audioStart,
  finishAudioCall,
  runAudioChain,
  singleAudioRoute,
} from './audioDoor.ts'
import { handleTranscription } from './audioTranscribe.ts'
import { resolveModel } from './dispatch.ts'
import type { DoorContext } from './doorContext.ts'
import { CONTENT_TYPE, jsonError, STATUS_BAD_REQUEST, STATUS_PAYLOAD_TOO_LARGE } from './http.ts'
import { CONTENT_ENDPOINT_TRANSCRIPTIONS, CONTENT_ENDPOINT_TRANSLATIONS } from './types.ts'

interface TranscriptionForm {
  rawModel: string | null
  /** A stream when the recording is still being made; the bytes of one that is not. */
  file: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>
  language: string | undefined
  responseFormat: string | undefined
  prompt: string | undefined
  stream: boolean
  /** Set by the translations verb alone; the transcriptions verb never sets it, whatever the caller sends. */
  translate?: boolean
}

/**
 * The live shape of the same verb: `?stream=true` with the recording as the
 * request body, and the fields a form would have carried in the query string.
 *
 * Not multipart, because multipart is a buffering point -- a part is only
 * readable once the boundary after it has arrived, so a form cannot deliver
 * audio that is still being spoken. `undefined` for every other request, which
 * leaves the multipart verb exactly as it was.
 */
function liveTranscription(req: Request): TranscriptionForm | undefined {
  const query = new URL(req.url).searchParams
  // A multipart body is a form however the query is spelled: reading its parts
  // as raw audio would send whisper the boundaries too.
  if (
    query.get('stream') !== 'true' ||
    req.body === null ||
    (req.headers.get(CONTENT_TYPE) ?? '').startsWith('multipart/')
  ) {
    return undefined
  }
  return {
    rawModel: query.get('model'),
    file: req.body,
    language: query.get('language') ?? undefined,
    responseFormat: query.get('response_format') ?? undefined,
    prompt: query.get('prompt') ?? undefined,
    stream: true,
  }
}

/** `undefined` when the body is not multipart at all -- an empty POST, or a wrong content type. */
async function parseTranscriptionForm(req: Request): Promise<TranscriptionForm | undefined> {
  const form = await req.formData().catch(() => undefined)
  if (form === undefined) {
    return undefined
  }
  const rawModel = form.get('model')
  const file = form.get('file')
  const language = form.get('language')
  const responseFormat = form.get('response_format')
  const prompt = form.get('prompt')
  const stream = form.get('stream')
  return {
    rawModel: typeof rawModel === 'string' ? rawModel : null,
    file: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0),
    language: typeof language === 'string' ? language : undefined,
    responseFormat: typeof responseFormat === 'string' ? responseFormat : undefined,
    prompt: typeof prompt === 'string' ? prompt : undefined,
    // A multipart field is a string, so the flag arrives spelled out. Only the
    // one spelling counts: treating every non-empty value as true would make
    // `stream=false` stream.
    stream: stream === 'true',
  }
}

/**
 * A multipart upload is read into memory whole, so a request larger than this
 * is refused before it is read rather than after. Generous enough for any
 * recording a caller has reason to transcribe in one request; a longer one
 * belongs in segments, which is what every consumer already sends.
 *
 * A live body declares no length and is never held here, so the same ceiling
 * is the engine wrapper's to enforce as the audio arrives.
 */
const MAX_AUDIO_UPLOAD_BYTES = 268_435_456

/** One wording for the ceiling, so the declared length and what actually arrived cannot drift apart. */
function tooLarge(bytes: number): Response {
  return jsonError(
    STATUS_PAYLOAD_TOO_LARGE,
    `upload is ${bytes} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
  )
}

/**
 * Whether this upload is refused before anything is dispatched. The ceiling is
 * checked twice against the same limit: once on the declared length, so an
 * oversized body is turned away before it is read, and again on what actually
 * arrived, because a multipart form need not declare one. A live body is
 * neither -- it declares no length and is never held here, so the engine
 * wrapper enforces the ceiling as the audio arrives.
 */
function uploadRefusal(file: TranscriptionForm['file']): Response | undefined {
  if (file instanceof ReadableStream) {
    return undefined
  }
  // Zero bytes reaches whisper as a valid-looking empty upload and comes back
  // as an empty transcript, which reads like silence rather than a bad request.
  if (file.byteLength === 0) {
    return jsonError(STATUS_BAD_REQUEST, 'multipart form carried no `file` part')
  }
  return file.byteLength > MAX_AUDIO_UPLOAD_BYTES ? tooLarge(file.byteLength) : undefined
}

/**
 * This upload aimed at one engine. A live body is always `stream: true` -- there
 * is no buffered reading of a recording still being made -- while a multipart
 * one streams only if the caller asked for segments as they are decoded.
 */
function transcriptionAttempt(form: TranscriptionForm): AudioAttempt {
  return (hopEngine, hopModel, start) => {
    const common = {
      engine: hopEngine,
      model: hopModel,
      language: form.language,
      response_format: form.responseFormat,
      prompt: form.prompt,
      translate: form.translate,
    }
    const transcriptionReq: AnyTranscriptionRequestBody =
      form.file instanceof ReadableStream
        ? { ...common, file: form.file, stream: true }
        : { ...common, file: form.file, stream: form.stream }
    return handleTranscription(transcriptionReq, start)
  }
}

/**
 * `/openai/v1/audio/transcriptions` and `/openai/v1/audio/translations` are
 * one verb over one upload; the difference is a single field whisper-server
 * reads per request. So they share this handler, and `endpoint` is what
 * decides which routes may answer -- only a route declaring `translate` serves
 * the translations path (`routeServes`), so an English-only model is refused
 * by address rather than answering with an untranslated transcript.
 */
/**
 * The upload and its per-request fields, or the 400 that ends the request
 * before anything is resolved or started. Split out of the handler because
 * every refusal here is about the body alone -- nothing it decides needs the
 * config, the registry, or which route will answer.
 */
async function readAudioUpload(
  req: Request,
  translating: boolean,
): Promise<TranscriptionForm | Response> {
  const declared = Number(req.headers.get('content-length') ?? Number.NaN)
  if (Number.isFinite(declared) && declared > MAX_AUDIO_UPLOAD_BYTES) {
    return tooLarge(declared)
  }
  const parsed = liveTranscription(req) ?? (await parseTranscriptionForm(req))
  if (parsed === undefined) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with a `file` part')
  }
  // The wrapper's streaming route carries language and prompt and nothing
  // else, so a streamed translation would arrive as a plain transcription.
  if (translating && parsed.stream) {
    return jsonError(
      STATUS_BAD_REQUEST,
      'a translation cannot be streamed; send it as a buffered request',
    )
  }
  return uploadRefusal(parsed.file) ?? (translating ? { ...parsed, translate: true } : parsed)
}

export async function handleAudioTranscription(
  ctx: DoorContext,
  req: Request,
  endpoint: string = CONTENT_ENDPOINT_TRANSCRIPTIONS,
): Promise<Response> {
  const form = await readAudioUpload(req, endpoint === CONTENT_ENDPOINT_TRANSLATIONS)
  if (form instanceof Response) {
    return form
  }
  const resolved = resolveModel(form.rawModel ?? undefined, endpoint, {
    config: ctx.getConfig(),
    registry: ctx.registry,
  })
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error)
  }
  const live = form.file instanceof ReadableStream
  if (resolved.kind === 'chain' && live) {
    // The upload is the request, and it is consumed by the hop that reads it.
    // A second hop would be handed a body already drained -- it would transcribe
    // silence and report success, which is worse than refusing here. The
    // buffered form of this verb chains, because its bytes can be sent twice.
    return jsonError(
      STATUS_BAD_REQUEST,
      'a recording streamed as the request body cannot be replayed on a second hop; send it as a multipart upload to use a chain',
    )
  }
  const attempt = transcriptionAttempt(form)

  if (resolved.kind === 'chain') {
    return runAudioChain(ctx, {
      chain: resolved.chain,
      hops: resolved.hops,
      requested: form.rawModel ?? '',
      endpoint,
      attempt,
      signal: req.signal,
    })
  }

  const { engineId, model, upstream, address, egress } = singleAudioRoute(
    resolved.route,
    ctx.getConfig(),
  )
  const leased: AudioLease = { held: false }
  const startedAt = Date.now()
  const result = await attempt(engineId, model, audioStart(ctx, leased))
  return finishAudioCall(ctx, leased, {
    engineId,
    model,
    upstream,
    address,
    egress,
    requested: form.rawModel ?? '',
    result,
    startedAt,
  })
}
