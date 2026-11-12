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
import { type HopExec, runChain } from './chain.ts'
import { routeAddress } from './control.ts'
import { type Dispatch, resolveOrRefuse, resolveQualified, routeEgress } from './dispatch.ts'
import { type DoorContext, recordDoorCall } from './doorContext.ts'
import { EngineBusyError } from './errors/engineBusy.ts'
import {
  CONTENT_TYPE,
  engineErrorStatus,
  JSON_CONTENT_TYPE,
  jsonErrorBody,
  STATUS_BAD_GATEWAY,
  TEXT_CONTENT_TYPE,
} from './http.ts'
import { errMessage, MS_PER_SECOND } from './records.ts'
import { LOCAL_UPSTREAM, qualifiedSegments, routeForHop } from './routeAddress.ts'
import { CONTENT_ENDPOINT_SPEECH } from './routeServes.ts'
import type { Config, Egress, ResolvedRoute } from './types.ts'
import { resolveUpstream } from './upstream.ts'
import { resolveVoice } from './voices.ts'

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
interface AudioLease {
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
 * One audio verb aimed at one engine, called once per hop with the engine and
 * model the hop resolved to.
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
 * the provenance line. The lease is per hop rather than per call -- `hold`
 * gives the previous hop's engine back before this one is asked, or a chain of
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
  hold: (engineId: string, leased: AudioLease) => void,
): HopExec {
  return async (hop) => {
    const dispatch = audioHopRoute(ctx, hop, endpoint)
    if (!dispatch.ok) {
      return { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(STATUS_BAD_GATEWAY, dispatch.error) }
    }
    const { route } = dispatch
    const leased: AudioLease = { held: false }
    hold(route.engine, leased)
    const result = await attempt(route.engine, route.model, audioStart(ctx, leased))
    setContentType(result.contentType)
    return {
      // A modelless engine (every TTS route, most STT ones) has no separate
      // model id, so the engine id is the honest fill-in.
      model: route.model ?? route.engine,
      status: result.status,
      body: result.body,
      bytes: result.bytes,
      stream: result.stream,
      upstreamUsed: route.upstream ?? undefined,
    }
  }
}

interface AudioChain {
  resolved: Extract<Dispatch, { ok: true }>
  requested: string
  endpoint: string
  attempt: AudioAttempt
  signal?: AbortSignal
}

/**
 * An audio call, walked by the same `runChain` a chat prompt uses: one
 * provenance line carrying every hop, and the first hop that answers is the
 * answer. A direct `@/...` address is the one-hop case with no chain name.
 *
 * The last hop's lease ends when the provenance line has been written, which
 * for a stream is when the body does; an earlier hop's ends as the next is
 * asked.
 *
 * No `maxEgress`. The chat door reads a `max_egress` field off the request
 * body, and an audio body has no room for one -- a speech field engined does
 * not recognise is forwarded to the engine as a wire parameter, so claiming
 * the name here would change what an engine receives.
 */
export async function runAudioChain(ctx: DoorContext, opts: AudioChain): Promise<Response> {
  let contentType = JSON_CONTENT_TYPE
  let held: { engineId: string; leased: AudioLease } | undefined
  const release = (): void => {
    if (held !== undefined) {
      armAudioIdleStop(ctx, held.engineId, held.leased)
      held = undefined
    }
  }
  const config = ctx.getConfig()
  const { resolved } = opts
  const result = await runChain(
    resolved.kind === 'chain' ? [...resolved.hops] : [routeAddress(resolved.route, config.routes)],
    {
      chain: resolved.kind === 'chain' ? resolved.chain : null,
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
      stallMs: config.stream_stall_seconds * MS_PER_SECOND,
      signal: opts.signal,
      exec: audioHopExec(
        ctx,
        opts.endpoint,
        opts.attempt,
        (ct) => {
          contentType = ct
        },
        (engineId, leased) => {
          release()
          held = { engineId, leased }
        },
      ),
      record: (record) => {
        // A direct address that failed answered nothing: the line names no
        // engine, the same as every other single-engine verb's.
        const failed = record.chain === null && record.attempts.at(-1)?.ok !== true
        recordDoorCall(ctx, failed ? { ...record, engine_used: null, upstream_used: null } : record)
        release()
      },
    },
  )
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
 * `remote`, carrying no `status` -- `handleSpeech`/`handleTranscription`'s
 * own fixed 503 is right for that case. `EngineBusyError` (a model switch
 * that would kill a request in flight) surfaces as `conflict` rather than
 * propagating, so those callers turn it into a 409 the same way they turn a
 * caught start failure's own `status` (`engineErrorStatus`, `http.ts`) into
 * a 503 for a hold or a 502 for anything else.
 */
function audioStart(ctx: DoorContext, leased: AudioLease): EngineStart {
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
      return { private_url: null, unavailable: errMessage(err), status: engineErrorStatus(err) }
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
  const resolved = resolveOrRefuse(ctx, rawModel, CONTENT_ENDPOINT_SPEECH)
  if (resolved instanceof Response) {
    return resolved
  }
  const voice = resolveVoice(typeof body.voice === 'string' ? body.voice : undefined)
  if (voice instanceof Response) {
    return voice
  }
  const extra = Object.fromEntries(
    Object.entries(body).filter(([key]) => !SPEECH_DOOR_KEYS.has(key)),
  )
  // A hop's model is a voice file on an engine whose routes pick one (piper);
  // most TTS routes are modelless and the hop changes only the engine.
  const attempt: AudioAttempt = (hopEngine, hopModel, start) => {
    const speechReq: SpeechRequestBody = {
      engine: hopEngine,
      ...(hopModel === undefined ? {} : { model: hopModel }),
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

  return runAudioChain(ctx, {
    resolved,
    requested: rawModel ?? '',
    endpoint: CONTENT_ENDPOINT_SPEECH,
    attempt,
    signal,
  })
}
