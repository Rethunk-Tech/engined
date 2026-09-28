/**
 * `POST /openai/v1/completions`: the legacy OpenAI completions shape, mapped
 * onto llama-server's own `/infill` -- fill-in-the-middle, `input_prefix`/
 * `input_suffix` rather than a single prompt. Only a local llama route that
 * opted in with `fim` (`routeServes.ts`'s `routeServes`) can answer it; every other
 * dispatch is refused with the door's normal 4xx before this file is reached.
 *
 * Reuses `LlamaRouter.proxy` exactly as chat does -- the same lease, warm-up
 * and abort plumbing, just a different path and a different body shape on
 * both sides of the wire. No chain support: nothing has asked for FIM
 * fallback across models, and chaining would mean guessing at a second
 * engine's own native completion shape with nothing here to test it against.
 */

import { classifyResult, wrapStream } from './chain.ts'
import { routeAddress } from './control.ts'
import { resolveModel, routeEgress } from './dispatch.ts'
import type { DoorContext } from './doorContext.ts'
import { getLlamaRouter, recordDoorCall } from './doorContext.ts'
import {
  CONTENT_TYPE,
  engineErrorStatus,
  JSON_CONTENT_TYPE,
  jsonError,
  jsonErrorBody,
  SSE_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  sseDataPayloads,
  sseFrames,
} from './http.ts'
import { answeringHeaders, type CallRecord, type Usage } from './provenance.ts'
import { errMessage, isRecord, MS_PER_SECOND, parseRecord } from './records.ts'
import { LOCAL_UPSTREAM } from './routeAddress.ts'
import { CONTENT_ENDPOINT_COMPLETIONS } from './routeServes.ts'
import type { ResolvedRoute } from './types.ts'

/** llama-server's own FIM verb -- distinct from the door's OpenAI-shaped `pathname`, which never reaches the wire. */
const INFILL_PATH = '/infill'

/** A neighbouring-file hint, forwarded to llama-server's own `input_extra` verbatim. Documented engined extension: `extra: [{filename, text}]` on the request body. */
interface ExtraFile {
  filename: string
  text: string
}

function isExtraFile(value: unknown): value is ExtraFile {
  return isRecord(value) && typeof value.filename === 'string' && typeof value.text === 'string'
}

/**
 * The OpenAI legacy completions body, read defensively: every field is
 * optional on the wire, and a caller sending a wrong-shaped one gets an empty
 * prefix/suffix rather than a thrown error -- llama-server's own 4xx (or an
 * empty completion) says more about a malformed request than this door
 * guessing at one.
 */
export function infillRequestInit(
  rawBody: Record<string, unknown>,
  resolvedModelId: string,
  signal?: AbortSignal,
): RequestInit {
  const extra = Array.isArray(rawBody.extra) ? rawBody.extra.filter(isExtraFile) : undefined
  const body: Record<string, unknown> = {
    model: resolvedModelId,
    input_prefix: typeof rawBody.prompt === 'string' ? rawBody.prompt : '',
    input_suffix: typeof rawBody.suffix === 'string' ? rawBody.suffix : '',
    stream: rawBody.stream === true,
    response_fields: ['content', 'stop', 'stop_type', 'tokens_predicted', 'tokens_evaluated'],
  }
  if (extra !== undefined && extra.length > 0) {
    body.input_extra = extra
  }
  if (typeof rawBody.max_tokens === 'number') {
    body.n_predict = rawBody.max_tokens
  }
  if (typeof rawBody.temperature === 'number') {
    body.temperature = rawBody.temperature
  }
  if (rawBody.stop !== undefined) {
    body.stop = rawBody.stop
  }
  return {
    method: 'POST',
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
    signal,
  }
}

/** llama-server's own `/infill` (and `/completion`) reply shape -- never OpenAI's, which is exactly why this door maps it rather than forwarding it. */
interface InfillFrame {
  content?: string
  stop?: boolean
  stop_type?: string
  tokens_predicted?: number
  tokens_evaluated?: number
}

function finishReason(frame: InfillFrame): 'stop' | 'length' {
  return frame.stop_type === 'limit' ? 'length' : 'stop'
}

function usageFrom(frame: InfillFrame): Usage | undefined {
  const { tokens_evaluated: promptTokens, tokens_predicted: completionTokens } = frame
  if (promptTokens === undefined && completionTokens === undefined) {
    return undefined
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens:
      promptTokens === undefined || completionTokens === undefined
        ? undefined
        : promptTokens + completionTokens,
  }
}

let completionSeq = 0

/** One OpenAI legacy-completions envelope, buffered or one streamed chunk -- the same shape either way, `finish_reason`/`usage` present only once `frame.stop` says generation actually ended. */
function completionEnvelope(modelId: string, frame: InfillFrame): Record<string, unknown> {
  completionSeq += 1
  const usage = frame.stop === true ? usageFrom(frame) : undefined
  return {
    id: `cmpl-${Date.now()}-${completionSeq}`,
    object: 'text_completion',
    created: Math.floor(Date.now() / MS_PER_SECOND),
    model: modelId,
    choices: [
      {
        index: 0,
        text: frame.content ?? '',
        logprobs: null,
        finish_reason: frame.stop === true ? finishReason(frame) : null,
      },
    ],
    ...(usage === undefined ? {} : { usage }),
  }
}

/** Every `data:` line in one SSE frame that parses as JSON, mapped through `completionEnvelope` and re-encoded on the door's own OpenAI-shaped wire. Reports whether anything was enqueued. */
function emitMappedFrame(
  controller: ReadableStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  frame: string,
  modelId: string,
): boolean {
  let enqueued = false
  for (const data of sseDataPayloads(frame)) {
    const parsed = parseRecord(data)
    if (parsed === null) {
      continue
    }
    controller.enqueue(
      encoder.encode(`data: ${JSON.stringify(completionEnvelope(modelId, parsed))}\n\n`),
    )
    enqueued = true
  }
  return enqueued
}

/**
 * llama-server's native infill stream, one `data:` frame per token (or
 * batch), re-encoded as the door's own OpenAI-shaped SSE. llama-server never
 * sends `[DONE]` -- that sentinel is added here once its stream ends, exactly
 * as `agenticSse` (`agenticHop.ts`) adds one for a CLI that never speaks SSE
 * at all.
 */
function mapInfillStream(
  source: ReadableStream<Uint8Array>,
  modelId: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  const gen = sseFrames(source)
  return new ReadableStream({
    // A pull that enqueues nothing is never followed by another, so a
    // keepalive or comment frame must not end the pull on its own.
    async pull(controller) {
      for (;;) {
        const { done, value } = await gen.next()
        if (done) {
          controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        if (emitMappedFrame(controller, encoder, value, modelId)) {
          return
        }
      }
    },
    async cancel() {
      await gen.return(undefined)
    },
  })
}

/**
 * The one record shape this route ever writes -- transport failure, an
 * upstream error body, or success -- differing only in whether the call
 * succeeded and the router/engine ids that go with it, exactly as
 * `images.ts`'s and `audioDoor.ts`'s own record builders do.
 */
function recordCompletion(
  ctx: DoorContext,
  route: ResolvedRoute,
  modelId: string,
  rawModel: string | undefined,
  startedAt: number,
  ok: boolean,
  failure: string | undefined,
): void {
  const record: CallRecord = {
    chain: null,
    requested: rawModel ?? '',
    attempts: [
      {
        engine: route.engine,
        model: modelId,
        ok,
        ...(failure === undefined ? {} : { failure }),
        duration_ms: Date.now() - startedAt,
        upstream_used: LOCAL_UPSTREAM,
        egress: routeEgress(route, ctx.getConfig()),
      },
    ],
    engine_used: ok ? route.engine : null,
    upstream_used: ok ? LOCAL_UPSTREAM : null,
  }
  recordDoorCall(ctx, record)
}

export async function handleCompletions(
  ctx: DoorContext,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const rawModel = typeof body.model === 'string' ? body.model : undefined
  const resolved = resolveModel(rawModel, CONTENT_ENDPOINT_COMPLETIONS, {
    config: ctx.getConfig(),
    registry: ctx.registry,
  })
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error)
  }
  if (resolved.kind === 'chain') {
    return jsonError(STATUS_BAD_REQUEST, `chain "${resolved.chain}" does not serve completions`)
  }
  const { route } = resolved
  const engineEntry = ctx.registry.entry(route.engine)
  // The endpoint check above already refused any route that did not opt in
  // with `fim`; this refuses the one shape that check cannot: a route on
  // some other engine kind, or a remote upstream, that a config mistake
  // (or a future engine reusing this same path) named anyway. Only a local
  // llama route's role+model are what `LlamaRouter.proxy` can dial.
  if (
    engineEntry === undefined ||
    route.upstream !== LOCAL_UPSTREAM ||
    route.role === undefined ||
    route.model === undefined
  ) {
    const address = route.model === undefined ? route.engine : `${route.engine}/${route.model}`
    return jsonError(STATUS_BAD_GATEWAY, `"@/${address}" cannot serve completions`)
  }
  const modelId = route.model
  const router = getLlamaRouter(ctx, engineEntry)
  const startedAt = Date.now()
  let response: Response
  let queueMs = 0
  try {
    ;({ response, queueMs } = await router.proxy(
      route,
      INFILL_PATH,
      infillRequestInit(body, modelId, signal),
    ))
  } catch (err) {
    // Checked before the generic transport failure: an aborted `signal` means
    // the caller hung up, not that the connection to llama-server failed --
    // the same distinction `chain.ts`'s own hop classifier draws.
    const failure = signal?.aborted
      ? 'client disconnected'
      : `connection failed: ${errMessage(err)}`
    const status = engineErrorStatus(err)
    recordCompletion(ctx, route, modelId, rawModel, startedAt, false, failure)
    return jsonError(status, errMessage(err))
  }
  if (!response.ok) {
    const text = await response.text()
    const parsed = parseRecord(text)
    const verdict = classifyResult({
      status: response.status,
      body: parsed ?? (text === '' ? undefined : jsonErrorBody(response.status, text)),
    })
    recordCompletion(ctx, route, modelId, rawModel, startedAt, false, verdict.failure)
    return new Response(text, {
      status: response.status,
      headers: { [CONTENT_TYPE]: response.headers.get(CONTENT_TYPE) ?? JSON_CONTENT_TYPE },
    })
  }
  const headers = answeringHeaders({
    route: routeAddress(route, ctx.getConfig().routes),
    upstreamUsed: LOCAL_UPSTREAM,
    egress: routeEgress(route, ctx.getConfig()),
    chain: null,
    queueMs,
  })
  const contentType = response.headers.get(CONTENT_TYPE) ?? ''
  if (contentType.includes(SSE_CONTENT_TYPE) && response.body) {
    headers.set(CONTENT_TYPE, SSE_CONTENT_TYPE)
    // Deferred the same way `chain.ts` defers a streaming hop's provenance:
    // a mid-body death or client abort must record as a failure, not the
    // success this branch would otherwise log before a single byte is sent.
    const stream = wrapStream(mapInfillStream(response.body, modelId), (ok, failure) => {
      recordCompletion(ctx, route, modelId, rawModel, startedAt, ok, failure)
    })
    return new Response(stream, { status: response.status, headers })
  }
  recordCompletion(ctx, route, modelId, rawModel, startedAt, true, undefined)
  const parsed: unknown = await response.json().catch(() => ({}))
  return Response.json(completionEnvelope(modelId, isRecord(parsed) ? parsed : {}), { headers })
}
