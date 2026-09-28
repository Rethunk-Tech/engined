import { DEFAULT_IDLE_STOP_SECONDS } from './engineEntries.ts'
/**
 * The door's two audio verbs. `src/audio.ts` speaks to an engine; this is
 * the half in front of it -- resolving which engine answers, holding a
 * lease for as long as the body streams, and recording the one provenance
 * line the call is entitled to.
 */

import type { DoorResponse, EngineStart, SpeechRequestBody } from './audio.ts'
import { SPEECH_DOOR_KEYS } from './audio.ts'
import { handleSpeech } from './audioSpeech.ts'
import { classifyResult, type HopExec, runChain, wrapStream } from './chain.ts'
import { routeAddress } from './control.ts'
import { resolveModel, resolveQualified, routeEgress } from './dispatch.ts'
import type { DoorContext } from './doorContext.ts'
import { EngineBusyError } from './errors/engineBusy.ts'
import {
  CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  jsonError,
  jsonErrorBody,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  TEXT_CONTENT_TYPE,
} from './http.ts'
import { answeringHeaders, recordCall } from './provenance.ts'
import { MS_PER_SECOND } from './records.ts'
import { LOCAL_UPSTREAM, qualifiedSegments, routeForHop } from './routeAddress.ts'
import { CONTENT_ENDPOINT_SPEECH } from './routeServes.ts'
import type { Config, Egress, ResolvedRoute } from './types.ts'
import { resolveUpstream } from './upstream.ts'
import { resolveVoice } from './voices.ts'

interface AudioCallInfo {
  engineId: string
  /** The model segment of the resolved address, when the engine's routes carry one. Absent for a modelless engine. */
  model?: string
  /** The resolved route's `[[upstream]]` id, or `"local"`. Absent for an ambient route, the same disposition a chat hop's carries. */
  upstream?: string
  /** The route's own `@/...` address, for the answering-route header -- this call has no chain fallback, so the route resolved before dispatch is the route that answers. */
  address: string
  egress: Egress
  requested: string
  result: DoorResponse
  startedAt: number
}

/**
 * Audio provenance is classified by the same rule a chain hop is: one place
 * decides ok-vs-failure, so a failed audio call records WHY it failed and a
 * 200 carrying no audio is not recorded as a success. A streamed call holds
 * no buffered `bytes`, so its line waits for the stream and reports the bytes
 * it actually forwarded -- a stream that ended having delivered audio is a
 * success, and one that died mid-body is not.
 */
function recordAudioCall(ctx: DoorContext, info: AudioCallInfo): DoorResponse {
  const { engineId, model, upstream, requested, result, startedAt } = info
  const emit = (audioBytes: number, streamFailure?: string): void => {
    const verdict = classifyResult({
      status: result.status,
      body: audioBytes > 0 ? 'audio' : result.body,
    })
    const ok = verdict.ok && streamFailure === undefined
    const failure = streamFailure ?? verdict.failure
    recordCall(
      {
        chain: null,
        requested,
        attempts: [
          {
            engine: engineId,
            // A modelless engine (every TTS route, most STT ones) has no
            // separate model id, so the engine id is the honest fill-in --
            // the same convention the chat path's own Attempt.model follows.
            model: model ?? engineId,
            ok,
            ...(failure === undefined ? {} : { failure }),
            duration_ms: Date.now() - startedAt,
            upstream_used: upstream,
          },
        ],
        engine_used: ok ? engineId : null,
        // The record's field names the upstream that actually answered, so it
        // is null wherever `engine_used` is -- the attempt above keeps the
        // resolved id either way.
        upstream_used: ok ? (upstream ?? null) : null,
      },
      ctx.doorOpts.write,
    )
  }
  if (!result.stream) {
    emit(result.bytes?.byteLength ?? 0)
    return result
  }
  return {
    ...result,
    stream: wrapStream(result.stream, (ok, streamFailure, bytes) =>
      emit(bytes ?? 0, ok ? undefined : (streamFailure ?? 'stream ended before completion')),
    ),
  }
}

/** `headers` carries the answering-route fields already, if any; every branch just adds its own `Content-Type` on top rather than building a fresh header set. */
function doorResponseToResponse(result: DoorResponse, headers?: Headers): Response {
  const out = headers ?? new Headers()
  if (result.stream) {
    out.set(CONTENT_TYPE, result.contentType)
    return new Response(result.stream, { status: result.status, headers: out })
  }
  if (result.bytes) {
    // `Buffer.from` rather than the raw `Uint8Array`: DoorResponse.bytes is
    // typed as the generic `ArrayBufferLike` view, which Bun's `BodyInit`
    // does not accept directly.
    out.set(CONTENT_TYPE, result.contentType)
    return new Response(Buffer.from(result.bytes), { status: result.status, headers: out })
  }
  if (result.contentType === TEXT_CONTENT_TYPE) {
    out.set(CONTENT_TYPE, result.contentType)
    return new Response(String(result.body), { status: result.status, headers: out })
  }
  return Response.json(result.body, { status: result.status, headers: out })
}

/** Whether this call's `audioStart` actually took a lease -- the only thing entitled to give one back. */
export interface AudioLease {
  held: boolean
}

/**
 * The audio door proxies a single buffered request per call, with no
 * multi-lease concept like `LlamaRouter`'s roles: unlike Comfy, this is
 * request traffic engined does see, so idle-stop arms right here rather than
 * off a queue poll.
 *
 * A call that never took a lease must not release one. Several paths reach
 * here without one -- a body refused before the engine was ever started, a
 * remote engine that has no container, a start refused with `conflict` --
 * and the lease they would hand back belongs to whichever request is still
 * in flight on that container. `conflict` is the sharp case: the refusal
 * happens precisely BECAUSE a lease is held, so releasing here would drop
 * that count to zero and arm a countdown against a live request. The
 * countdown those paths need is already armed by the start itself.
 */
function armAudioIdleStop(ctx: DoorContext, engineId: string, leased: AudioLease): void {
  if (!leased.held) {
    return
  }
  const engine = ctx.registry.entry(engineId)
  // An engine dropped by a config reload mid-request still holds this lease.
  ctx.lifecycle.endLease(engineId, engine?.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS)
}

/**
 * Ends the call's lease when the call actually ends.
 *
 * A streamed response returns as soon as its headers and stream are handed
 * back, while the engine is still producing into it -- a transcription decoded
 * during upload runs for as long as the caller keeps talking. Arming the
 * countdown at that moment aims it at a request still in flight, so the lease
 * ends on the same signal the provenance line waits for: the body finishing.
 */
function endAudioLease(
  ctx: DoorContext,
  engineId: string,
  leased: AudioLease,
  result: DoorResponse,
): DoorResponse {
  if (!result.stream) {
    armAudioIdleStop(ctx, engineId, leased)
    return result
  }
  return {
    ...result,
    stream: wrapStream(result.stream, () => armAudioIdleStop(ctx, engineId, leased)),
  }
}

/**
 * How every audio call ends: the one provenance line is recorded, the lease
 * ends when the body actually does, and what is left is an HTTP response.
 * Both verbs share the sequence because the order within it is load-bearing --
 * `endAudioLease` wraps the stream `recordAudioCall` already wrapped, so the
 * countdown is armed after the line is written rather than racing it.
 */
export function finishAudioCall(
  ctx: DoorContext,
  leased: AudioLease,
  info: AudioCallInfo,
): Response {
  return doorResponseToResponse(
    endAudioLease(ctx, info.engineId, leased, recordAudioCall(ctx, info)),
    answeringHeaders({
      route: info.address,
      upstreamUsed: info.upstream ?? null,
      egress: info.egress,
      chain: null,
    }),
  )
}

/**
 * One audio verb aimed at one engine. The chain path calls it once per hop and
 * the single-address path once; each supplies the engine and model the hop
 * resolved to, so nothing below has to know which of the two it is serving.
 */
export type AudioAttempt = (
  engineId: string,
  model: string | undefined,
  start: EngineStart,
) => Promise<DoorResponse>

/**
 * What one chain hop resolves to for an audio endpoint. `resolveQualified` is
 * reused rather than `parseHop` because an audio engine is usually modelless:
 * `@/chatterbox-multi/local` names an upstream in its second segment, not a
 * model, and only the engine's own routes say which reading applies. It also
 * carries the per-hop `serves` check, so a chat-only hop in a speech chain
 * fails as itself rather than being dispatched to an engine that cannot answer.
 */
function audioHopRoute(ctx: DoorContext, hop: string, endpoint: string) {
  const segments = qualifiedSegments(hop)
  if (segments === undefined) {
    return { ok: false as const, error: `chain hop "${hop}" is not a qualified @/ address` }
  }
  return resolveQualified(segments, {
    endpoint,
    config: ctx.getConfig(),
    registry: ctx.registry,
  })
}

/**
 * One hop of an audio chain: its own engine, its own lease, its own attempt in
 * the provenance line. The lease is per hop rather than per call -- a hop that
 * failed must give its engine back before the next one is asked, or a chain of
 * three would hold three engines open to answer once.
 *
 * A hop that will not resolve answers 502 rather than 400, because a 5xx is
 * what advances: another hop may serve the endpoint this one does not.
 */
function audioHopExec(
  ctx: DoorContext,
  endpoint: string,
  attempt: AudioAttempt,
  setContentType: (ct: string) => void,
): HopExec {
  return async (hop) => {
    const dispatch = audioHopRoute(ctx, hop, endpoint)
    if (!dispatch.ok) {
      return { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(STATUS_BAD_GATEWAY, dispatch.error) }
    }
    const { route } = dispatch
    const leased: AudioLease = { held: false }
    const result = endAudioLease(
      ctx,
      route.engine,
      leased,
      await attempt(route.engine, route.model, audioStart(ctx, leased)),
    )
    setContentType(result.contentType)
    return {
      status: result.status,
      body: result.body,
      bytes: result.bytes,
      stream: result.stream,
      upstreamUsed: route.upstream ?? undefined,
    }
  }
}

interface AudioChain {
  chain: string
  hops: readonly string[]
  requested: string
  endpoint: string
  attempt: AudioAttempt
  signal?: AbortSignal
}

/**
 * A chain across audio engines, walked by the same `runChain` a chat prompt
 * uses: one provenance line carrying every hop, and the first hop that answers
 * is the answer.
 *
 * No `maxEgress`. The chat door reads a `max_egress` field off the request
 * body, and an audio body has no room for one -- a speech field engined does
 * not recognise is forwarded to the engine as a wire parameter, so claiming
 * the name here would change what an engine receives.
 */
export async function runAudioChain(ctx: DoorContext, opts: AudioChain): Promise<Response> {
  let contentType = JSON_CONTENT_TYPE
  const config = ctx.getConfig()
  const result = await runChain([...opts.hops], {
    chain: opts.chain,
    requested: opts.requested,
    egressOf: (hop): Egress => {
      const dispatch = audioHopRoute(ctx, hop, opts.endpoint)
      // Fail closed, the same reading the chat door's own egressOf takes: a hop
      // that resolves to no route could be anything, so it is treated as remote.
      return dispatch.ok ? routeEgress(dispatch.route, config) : 'remote'
    },
    // Every audio hop is a container or a vendor's HTTP endpoint; none is an
    // agentic CLI, so there is one budget rather than a per-kind lookup.
    timeoutMs: () => config.chat_timeout_seconds * MS_PER_SECOND,
    signal: opts.signal,
    exec: audioHopExec(ctx, opts.endpoint, opts.attempt, (ct) => {
      contentType = ct
    }),
    write: ctx.doorOpts.write,
  })
  return doorResponseToResponse(
    {
      status: result.status,
      // Nothing answered, so the body is the chain's own JSON refusal rather than
      // audio -- the content type a failed hop happened to set last would type it
      // as the sound it never produced.
      contentType: result.engineUsed === null ? JSON_CONTENT_TYPE : contentType,
      body: result.body,
      bytes: result.bytes,
      stream: result.stream,
    },
    result.headers,
  )
}

/**
 * Both audio endpoints take an engine, and a model where the resolved
 * route carries one -- whisper's "small.en"/"medium.en", or ElevenLabs'
 * "scribe_v1".
 */
export function singleAudioRoute(
  route: ResolvedRoute,
  config: Config,
): {
  engineId: string
  model?: string
  upstream?: string
  address: string
  egress: Egress
} {
  return {
    engineId: route.engine,
    model: route.model,
    // `null` is an ambient route, which named no upstream at all -- absent from the line rather than reported as a name, exactly as a chat hop's is.
    upstream: route.upstream ?? undefined,
    address: routeAddress(route, config.routes),
    egress: routeEgress(route, config),
  }
}

/** The route an audio call resolves to; a modelless route has no model segment to look one up by, so it is found by engine id alone, excluding disabled routes exactly as `routeForHop` does for the rest. */
function audioRoute(
  config: Config,
  id: string,
  model: string | undefined,
): ResolvedRoute | undefined {
  return model === undefined
    ? config.routes.find((r) => r.disabled !== true && r.engine === id && r.model === undefined)
    : routeForHop(config.routes, id, model)
}

async function remoteAudioStart(
  ctx: DoorContext,
  id: string,
  upstreamId: string,
): Promise<Awaited<ReturnType<EngineStart>>> {
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === upstreamId)
  if (upstream === undefined) {
    return { private_url: null, unavailable: `engine "${id}" has no resolvable upstream` }
  }
  const resolution = await resolveUpstream(upstream, ctx.doorOpts.secretExec)
  return resolution.ok
    ? { private_url: null, remote: resolution.endpoint }
    : { private_url: null, unavailable: resolution.error }
}

/**
 * The audio door's `EngineStart`. A remote engine is resolved to an address
 * and a header instead of started — there is no container to warm — and a
 * secret that will not resolve surfaces as a null `private_url` with no
 * `remote`, which the door reports as unavailable exactly like a container
 * that failed to come up. `EngineBusyError` (a model switch that would kill
 * a request in flight) surfaces as `conflict` rather than propagating, so
 * `handleSpeech`/`handleTranscription` can turn it into a 409 the same way
 * they already turn `unavailable` into a 503.
 */
export function audioStart(ctx: DoorContext, leased: AudioLease): EngineStart {
  return async (id: string, model?: string) => {
    const engine = ctx.registry.entry(id)
    const route = audioRoute(ctx.getConfig(), id, model)
    const upstreamId = route?.upstream ?? null
    if (engine && upstreamId !== null && upstreamId !== LOCAL_UPSTREAM) {
      return remoteAudioStart(ctx, id, upstreamId)
    }
    try {
      // The lease is the registry's to take, not this door's: taken here it
      // would be one microtask late, and a competing model switch reading
      // zero leases in that gap stops the container under this request.
      // Paired with the `armAudioIdleStop` on the way out, which releases
      // only what was actually taken.
      await ctx.registry.start(id, model, { lease: true })
    } catch (err) {
      if (err instanceof EngineBusyError) {
        return { private_url: null, conflict: err.message }
      }
      throw err
    }
    // `EngineStatus` (the wire type `registry.start` returns) carries no
    // container address at all -- the internal runtime read is `lifecycle`'s
    // own, the same source the comfy proxy resolves against.
    const status = ctx.lifecycle.getStatus(id)
    // `active_leases` is reported for a running container and no other, which
    // is the one condition `beginLease` takes a lease under. Read in the same
    // tick, it answers whether the start above took one.
    leased.held = status.active_leases !== undefined
    return { private_url: status.private_url }
  }
}

export async function handleAudioSpeech(
  ctx: DoorContext,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const rawModel = typeof body.model === 'string' ? body.model : undefined
  const resolved = resolveModel(rawModel, CONTENT_ENDPOINT_SPEECH, {
    config: ctx.getConfig(),
    registry: ctx.registry,
  })
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error)
  }
  const voice = resolveVoice(typeof body.voice === 'string' ? body.voice : undefined)
  if (voice instanceof Response) {
    return voice
  }
  const extra = Object.fromEntries(
    Object.entries(body).filter(([key]) => !SPEECH_DOOR_KEYS.has(key)),
  )
  // A speech request carries no model of its own -- every TTS route is
  // modelless -- so the only thing a hop changes is which engine it names.
  const attempt: AudioAttempt = (hopEngine, _model, start) => {
    const speechReq: SpeechRequestBody = {
      engine: hopEngine,
      input: typeof body.input === 'string' ? body.input : '',
      response_format: typeof body.response_format === 'string' ? body.response_format : undefined,
      stream: body.stream === 'ndjson' ? 'ndjson' : body.stream === true,
      voice,
      speed: typeof body.speed === 'number' ? body.speed : undefined,
      instructions: typeof body.instructions === 'string' ? body.instructions : undefined,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    }
    return handleSpeech(speechReq, start)
  }

  if (resolved.kind === 'chain') {
    return runAudioChain(ctx, {
      chain: resolved.chain,
      hops: resolved.hops,
      requested: rawModel ?? '',
      endpoint: CONTENT_ENDPOINT_SPEECH,
      attempt,
      signal,
    })
  }

  const { engineId, upstream, address, egress } = singleAudioRoute(resolved.route, ctx.getConfig())
  const leased: AudioLease = { held: false }
  const startedAt = Date.now()
  const result = await attempt(engineId, undefined, audioStart(ctx, leased))
  return finishAudioCall(ctx, leased, {
    engineId,
    upstream,
    address,
    egress,
    requested: rawModel ?? '',
    result,
    startedAt,
  })
}
