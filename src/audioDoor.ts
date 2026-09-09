/**
 * The door's two audio verbs. `src/audio.ts` speaks to an engine; this is
 * the half in front of it -- resolving which engine answers, holding a
 * lease for as long as the body streams, and recording the one provenance
 * line the call is entitled to.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  type AnyTranscriptionRequestBody,
  type DoorResponse,
  type EngineStart,
  handleSpeech,
  handleTranscription,
  SPEECH_DOOR_KEYS,
  type SpeechRequestBody,
} from "./audio.ts";
import { classifyResult, type HopExec, runChain, wrapStream } from "./chain.ts";
import { resolveModel, resolveQualified, routeEgress } from "./dispatch.ts";
import type { DoorContext } from "./doorContext.ts";
import { DEFAULT_IDLE_STOP_SECONDS, EngineBusyError } from "./engines.ts";
import {
  CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  jsonError,
  jsonErrorBody,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_PAYLOAD_TOO_LARGE,
  TEXT_CONTENT_TYPE,
} from "./http.ts";
import { voicesDir } from "./paths.ts";
import { recordCall } from "./provenance.ts";
import {
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  type Config,
  type Egress,
  errMessage,
  MS_PER_SECOND,
  qualifiedSegments,
  type ResolvedRoute,
  routeForHop,
} from "./types.ts";
import { resolveUpstream } from "./upstream.ts";

interface AudioCallInfo {
  engineId: string;
  /** The model segment of the resolved address, when the engine's routes carry one. Absent for a modelless engine. */
  model?: string;
  /** The resolved route's `[[upstream]]` id, or `"local"`. Absent for an ambient route, the same disposition a chat hop's carries. */
  upstream?: string;
  requested: string;
  result: DoorResponse;
  startedAt: number;
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
  const { engineId, model, upstream, requested, result, startedAt } = info;
  const emit = (audioBytes: number, streamFailure?: string): void => {
    const verdict = classifyResult({
      status: result.status,
      body: audioBytes > 0 ? "audio" : result.body,
    });
    const ok = verdict.ok && streamFailure === undefined;
    const failure = streamFailure ?? verdict.failure;
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
    );
  };
  if (!result.stream) {
    emit(result.bytes?.byteLength ?? 0);
    return result;
  }
  return {
    ...result,
    stream: wrapStream(result.stream, (ok, streamFailure, bytes) =>
      emit(bytes ?? 0, ok ? undefined : (streamFailure ?? "stream ended before completion")),
    ),
  };
}

function doorResponseToResponse(result: DoorResponse): Response {
  if (result.stream) {
    return new Response(result.stream, {
      status: result.status,
      headers: { [CONTENT_TYPE]: result.contentType },
    });
  }
  if (result.bytes) {
    // `Buffer.from` rather than the raw `Uint8Array`: DoorResponse.bytes is
    // typed as the generic `ArrayBufferLike` view, which Bun's `BodyInit`
    // does not accept directly.
    return new Response(Buffer.from(result.bytes), {
      status: result.status,
      headers: { [CONTENT_TYPE]: result.contentType },
    });
  }
  if (result.contentType === TEXT_CONTENT_TYPE) {
    return new Response(String(result.body), {
      status: result.status,
      headers: { [CONTENT_TYPE]: result.contentType },
    });
  }
  return Response.json(result.body, { status: result.status });
}

/** Whether this call's `audioStart` actually took a lease -- the only thing entitled to give one back. */
interface AudioLease {
  held: boolean;
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
    return;
  }
  const engine = ctx.registry.entry(engineId);
  ctx.lifecycle.endLease(engineId, engine?.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
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
    armAudioIdleStop(ctx, engineId, leased);
    return result;
  }
  return {
    ...result,
    stream: wrapStream(result.stream, () => armAudioIdleStop(ctx, engineId, leased)),
  };
}

/**
 * How every audio call ends: the one provenance line is recorded, the lease
 * ends when the body actually does, and what is left is an HTTP response.
 * Both verbs share the sequence because the order within it is load-bearing --
 * `endAudioLease` wraps the stream `recordAudioCall` already wrapped, so the
 * countdown is armed after the line is written rather than racing it.
 */
function finishAudioCall(ctx: DoorContext, leased: AudioLease, info: AudioCallInfo): Response {
  return doorResponseToResponse(
    endAudioLease(ctx, info.engineId, leased, recordAudioCall(ctx, info)),
  );
}

/**
 * One audio verb aimed at one engine. The chain path calls it once per hop and
 * the single-address path once; each supplies the engine and model the hop
 * resolved to, so nothing below has to know which of the two it is serving.
 */
type AudioAttempt = (
  engineId: string,
  model: string | undefined,
  start: EngineStart,
) => Promise<DoorResponse>;

/**
 * What one chain hop resolves to for an audio endpoint. `resolveQualified` is
 * reused rather than `parseHop` because an audio engine is usually modelless:
 * `@/chatterbox-multi/local` names an upstream in its second segment, not a
 * model, and only the engine's own routes say which reading applies. It also
 * carries the per-hop `serves` check, so a chat-only hop in a speech chain
 * fails as itself rather than being dispatched to an engine that cannot answer.
 */
function audioHopRoute(ctx: DoorContext, hop: string, endpoint: string) {
  const segments = qualifiedSegments(hop);
  if (segments === undefined) {
    return { ok: false as const, error: `chain hop "${hop}" is not a qualified @/ address` };
  }
  return resolveQualified(segments, {
    endpoint,
    config: ctx.getConfig(),
    registry: ctx.registry,
  });
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
    const dispatch = audioHopRoute(ctx, hop, endpoint);
    if (!dispatch.ok) {
      return { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(dispatch.error) };
    }
    const { route } = dispatch;
    const leased: AudioLease = { held: false };
    const result = endAudioLease(
      ctx,
      route.engine,
      leased,
      await attempt(route.engine, route.model, audioStart(ctx, leased)),
    );
    setContentType(result.contentType);
    return {
      status: result.status,
      body: result.body,
      bytes: result.bytes,
      stream: result.stream,
      upstreamUsed: route.upstream ?? undefined,
    };
  };
}

interface AudioChain {
  chain: string;
  hops: readonly string[];
  requested: string;
  endpoint: string;
  attempt: AudioAttempt;
  signal?: AbortSignal;
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
async function runAudioChain(ctx: DoorContext, opts: AudioChain): Promise<Response> {
  let contentType = JSON_CONTENT_TYPE;
  const config = ctx.getConfig();
  const result = await runChain([...opts.hops], {
    chain: opts.chain,
    requested: opts.requested,
    egressOf: (hop): Egress => {
      const dispatch = audioHopRoute(ctx, hop, opts.endpoint);
      // Fail closed, the same reading the chat door's own egressOf takes: a hop
      // that resolves to no route could be anything, so it is treated as remote.
      return dispatch.ok ? routeEgress(dispatch.route, config) : "remote";
    },
    // Every audio hop is a container or a vendor's HTTP endpoint; none is an
    // agentic CLI, so there is one budget rather than a per-kind lookup.
    timeoutMs: () => config.chat_timeout_seconds * MS_PER_SECOND,
    signal: opts.signal,
    exec: audioHopExec(ctx, opts.endpoint, opts.attempt, (ct) => {
      contentType = ct;
    }),
    write: ctx.doorOpts.write,
  });
  return doorResponseToResponse({
    status: result.status,
    // Nothing answered, so the body is the chain's own JSON refusal rather than
    // audio -- the content type a failed hop happened to set last would type it
    // as the sound it never produced.
    contentType: result.engineUsed === null ? JSON_CONTENT_TYPE : contentType,
    body: result.body,
    bytes: result.bytes,
    stream: result.stream,
  });
}

/**
 * Both audio endpoints take an engine, and a model where the resolved
 * route carries one -- whisper's "small.en"/"medium.en", or ElevenLabs'
 * "scribe_v1".
 */
function singleAudioRoute(route: ResolvedRoute): {
  engineId: string;
  model?: string;
  upstream?: string;
} {
  return {
    engineId: route.engine,
    model: route.model,
    // `null` is an ambient route, which named no upstream at all -- absent from the line rather than reported as a name, exactly as a chat hop's is.
    upstream: route.upstream ?? undefined,
  };
}

/** The route an audio call resolves to; a modelless route has no model segment to look one up by, so it is found by engine id alone, excluding disabled routes exactly as `routeForHop` does for the rest. */
function audioRoute(
  config: Config,
  id: string,
  model: string | undefined,
): ResolvedRoute | undefined {
  return model === undefined
    ? config.routes.find((r) => r.disabled !== true && r.engine === id && r.model === undefined)
    : routeForHop(config.routes, id, model);
}

async function remoteAudioStart(
  ctx: DoorContext,
  id: string,
  upstreamId: string,
): Promise<Awaited<ReturnType<EngineStart>>> {
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === upstreamId);
  if (upstream === undefined) {
    return { private_url: null, unavailable: `engine "${id}" has no resolvable upstream` };
  }
  const resolution = await resolveUpstream(upstream, ctx.doorOpts.secretExec);
  return resolution.ok
    ? { private_url: null, remote: resolution.endpoint }
    : { private_url: null, unavailable: resolution.error };
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
function audioStart(ctx: DoorContext, leased: AudioLease): EngineStart {
  return async (id: string, model?: string) => {
    const engine = ctx.registry.entry(id);
    const route = audioRoute(ctx.getConfig(), id, model);
    const upstreamId = route?.upstream ?? null;
    if (engine && upstreamId !== null && upstreamId !== "local") {
      return remoteAudioStart(ctx, id, upstreamId);
    }
    try {
      // The lease is the registry's to take, not this door's: taken here it
      // would be one microtask late, and a competing model switch reading
      // zero leases in that gap stops the container under this request.
      // Paired with the `armAudioIdleStop` on the way out, which releases
      // only what was actually taken.
      await ctx.registry.start(id, model, { lease: true });
    } catch (err) {
      if (err instanceof EngineBusyError) {
        return { private_url: null, conflict: err.message };
      }
      throw err;
    }
    // `EngineStatus` (the wire type `registry.start` returns) carries no
    // container address at all -- the internal runtime read is `lifecycle`'s
    // own, the same source the comfy proxy resolves against.
    const status = ctx.lifecycle.getStatus(id);
    // `active_leases` is reported for a running container and no other, which
    // is the one condition `beginLease` takes a lease under. Read in the same
    // tick, it answers whether the start above took one.
    leased.held = status.active_leases !== undefined;
    return { private_url: status.private_url };
  };
}

/**
 * `POST /engined/v1/audio/voices`: a multipart upload of one reference
 * recording, answered with the handle a later `/audio/speech` call names as
 * its `voice`.
 *
 * A voice clone needs the engine to READ an audio file, and a TTS container
 * sees only what the door mounted into it. Sending the path instead would
 * mean the caller naming a host file -- unreachable from anywhere but this
 * box, and a directory traversal the moment the caller is not trusted. So
 * the door takes the bytes, chooses the name, and is the only party that
 * ever knows the path.
 */
export const VOICE_UPLOAD_PATH = "/engined/v1/audio/voices";

/** Where each `engines/chatterbox-*` spec.toml mounts `{state_dir}/voices`. The two are one pair; changing either alone breaks every clone. */
const VOICE_CONTAINER_DIR = "/voices";

/** Marks a `voice` field as a handle this door issued rather than a path baked into an engine image, which still passes through untouched. */
const VOICE_HANDLE_PREFIX = "vc_";

/**
 * The whole handle, and the only string ever joined onto `voicesDir()`: 16
 * random bytes plus a short suffix, so no caller-supplied character reaches
 * a path and no handle is guessable.
 */
const VOICE_HANDLE_RE = /^vc_[0-9a-f]{32}\.[a-z0-9]{1,4}$/;

/** 128 bits: the handle is the only thing standing between one caller's uploads and another's, so it is guessed, not enumerated. */
const VOICE_ID_BYTES = 16;

/**
 * A reference voice is a few seconds of speech -- chatterbox conditions on
 * the first several and ignores the rest -- so this is orders of magnitude
 * above what any real reference needs, and still far below the 256 MB a
 * transcription upload is allowed to be. It bounds one file; VOICE_KEEP
 * bounds the store.
 */
const MAX_VOICE_BYTES = 16_777_216;

/**
 * How many uploads the store keeps. A count, like the comfy binding table's
 * own bound and for the same reason: an age cutoff would delete the caller's
 * favourite reference precisely because it has worked for months. Eviction is
 * least-recently-USED (every successful synthesis touches the file), so what
 * falls off the end is what nothing has spoken with. 64 x MAX_VOICE_BYTES is
 * the worst case at 1 GiB; a real store of 10-second clips is a few MB.
 */
const VOICE_KEEP = 64;

/** The suffix `voiceSuffix` will accept from an upload, and the same shape `VOICE_HANDLE_RE` will later match back. */
const VOICE_SUFFIX_RE = /^[a-z0-9]{1,4}$/;

/** The suffix is cosmetic -- the engine's loader sniffs content -- but a wrong-looking one invites a bug report, so a plain one from the upload is kept and anything else becomes `wav`. */
function voiceSuffix(name: string): string {
  const ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return VOICE_SUFFIX_RE.test(ext) && ext !== name ? ext : "wav";
}

/**
 * Trims the store to VOICE_KEEP, oldest use first. Failure is reported and
 * swallowed: the upload it follows has already succeeded, and refusing it
 * afterwards would lose the caller's file to a disk problem that has nothing
 * to do with them.
 */
function evictVoices(): void {
  try {
    const dir = voicesDir();
    const files = readdirSync(dir)
      .map((name) => ({ name, used: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => a.used - b.used);
    for (const { name } of files.slice(0, Math.max(0, files.length - VOICE_KEEP))) {
      rmSync(join(dir, name));
    }
  } catch (err) {
    process.stderr.write(`voice store not trimmed: ${errMessage(err)}\n`);
  }
}

export async function handleVoiceUpload(req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_VOICE_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `reference voice is ${declared} bytes; the limit is ${MAX_VOICE_BYTES}`,
    );
  }
  let file: FormDataEntryValue | null = null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    // Not multipart at all, which the same message covers as a missing part.
  }
  if (!(file instanceof Blob)) {
    return jsonError(STATUS_BAD_REQUEST, "expected a multipart form with a `file` part");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return jsonError(STATUS_BAD_REQUEST, "multipart form carried no `file` part");
  }
  if (bytes.byteLength > MAX_VOICE_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `reference voice is ${bytes.byteLength} bytes; the limit is ${MAX_VOICE_BYTES}`,
    );
  }
  const name = file instanceof File ? file.name : "";
  const voice = `${VOICE_HANDLE_PREFIX}${randomBytes(VOICE_ID_BYTES).toString("hex")}.${voiceSuffix(name)}`;
  mkdirSync(voicesDir(), { recursive: true });
  writeFileSync(join(voicesDir(), voice), bytes);
  evictVoices();
  return Response.json({ voice, bytes: bytes.byteLength });
}

/**
 * Turns a `voice` field into what the engine will actually be handed. A
 * handle is bound at upload and checked here -- the door reads its own
 * directory rather than trusting the string -- and anything else passes
 * through untouched, which is how a voice name or a path baked into an
 * engine image keeps working. `utimesSync` is what makes VOICE_KEEP's
 * eviction least-recently-used rather than oldest-first.
 */
function resolveVoice(voice: string | undefined): string | undefined | Response {
  if (voice === undefined || !voice.startsWith(VOICE_HANDLE_PREFIX)) {
    return voice;
  }
  if (!VOICE_HANDLE_RE.test(voice)) {
    return jsonError(STATUS_BAD_REQUEST, `"${voice}" is not a voice handle this door issued`);
  }
  const path = join(voicesDir(), voice);
  try {
    const now = new Date();
    utimesSync(path, now, now);
  } catch {
    return jsonError(
      STATUS_BAD_REQUEST,
      `voice "${voice}" is not held by this door -- upload it again`,
    );
  }
  return `${VOICE_CONTAINER_DIR}/${voice}`;
}

export async function handleAudioSpeech(
  ctx: DoorContext,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const resolved = resolveModel(rawModel, CONTENT_ENDPOINT_SPEECH, ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error);
  }
  const voice = resolveVoice(typeof body.voice === "string" ? body.voice : undefined);
  if (voice instanceof Response) {
    return voice;
  }
  const extra = Object.fromEntries(
    Object.entries(body).filter(([key]) => !SPEECH_DOOR_KEYS.has(key)),
  );
  // A speech request carries no model of its own -- every TTS route is
  // modelless -- so the only thing a hop changes is which engine it names.
  const attempt: AudioAttempt = (hopEngine, _model, start) => {
    const speechReq: SpeechRequestBody = {
      engine: hopEngine,
      input: typeof body.input === "string" ? body.input : "",
      response_format: typeof body.response_format === "string" ? body.response_format : undefined,
      stream: body.stream === "ndjson" ? "ndjson" : body.stream === true,
      voice,
      speed: typeof body.speed === "number" ? body.speed : undefined,
      instructions: typeof body.instructions === "string" ? body.instructions : undefined,
      ...(Object.keys(extra).length > 0 ? { extra } : {}),
    };
    return handleSpeech(speechReq, start);
  };

  if (resolved.kind === "chain") {
    return runAudioChain(ctx, {
      chain: resolved.chain,
      hops: resolved.hops,
      requested: rawModel ?? "",
      endpoint: CONTENT_ENDPOINT_SPEECH,
      attempt,
      signal,
    });
  }

  const { engineId, upstream } = singleAudioRoute(resolved.route);
  const leased: AudioLease = { held: false };
  const startedAt = Date.now();
  const result = await attempt(engineId, undefined, audioStart(ctx, leased));
  return finishAudioCall(ctx, leased, {
    engineId,
    upstream,
    requested: rawModel ?? "",
    result,
    startedAt,
  });
}

interface TranscriptionForm {
  rawModel: string | null;
  /** A stream when the recording is still being made; the bytes of one that is not. */
  file: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>;
  language: string | undefined;
  responseFormat: string | undefined;
  prompt: string | undefined;
  stream: boolean;
  /** Set by the translations verb alone; the transcriptions verb never sets it, whatever the caller sends. */
  translate?: boolean;
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
  const query = new URL(req.url).searchParams;
  // A multipart body is a form however the query is spelled: reading its parts
  // as raw audio would send whisper the boundaries too.
  if (
    query.get("stream") !== "true" ||
    req.body === null ||
    (req.headers.get(CONTENT_TYPE) ?? "").startsWith("multipart/")
  ) {
    return undefined;
  }
  return {
    rawModel: query.get("model"),
    file: req.body,
    language: query.get("language") ?? undefined,
    responseFormat: query.get("response_format") ?? undefined,
    prompt: query.get("prompt") ?? undefined,
    stream: true,
  };
}

/** `undefined` when the body is not multipart at all -- an empty POST, or a wrong content type. */
async function parseTranscriptionForm(req: Request): Promise<TranscriptionForm | undefined> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return undefined;
  }
  const rawModel = form.get("model");
  const file = form.get("file");
  const language = form.get("language");
  const responseFormat = form.get("response_format");
  const prompt = form.get("prompt");
  const stream = form.get("stream");
  return {
    rawModel: typeof rawModel === "string" ? rawModel : null,
    file: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0),
    language: typeof language === "string" ? language : undefined,
    responseFormat: typeof responseFormat === "string" ? responseFormat : undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
    // A multipart field is a string, so the flag arrives spelled out. Only the
    // one spelling counts: treating every non-empty value as true would make
    // `stream=false` stream.
    stream: stream === "true",
  };
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
const MAX_AUDIO_UPLOAD_BYTES = 268_435_456;

/** One wording for the ceiling, so the declared length and what actually arrived cannot drift apart. */
function tooLarge(bytes: number): Response {
  return jsonError(
    STATUS_PAYLOAD_TOO_LARGE,
    `upload is ${bytes} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
  );
}

/**
 * Whether this upload is refused before anything is dispatched. The ceiling is
 * checked twice against the same limit: once on the declared length, so an
 * oversized body is turned away before it is read, and again on what actually
 * arrived, because a multipart form need not declare one. A live body is
 * neither -- it declares no length and is never held here, so the engine
 * wrapper enforces the ceiling as the audio arrives.
 */
function uploadRefusal(file: TranscriptionForm["file"]): Response | undefined {
  if (file instanceof ReadableStream) {
    return undefined;
  }
  // Zero bytes reaches whisper as a valid-looking empty upload and comes back
  // as an empty transcript, which reads like silence rather than a bad request.
  if (file.byteLength === 0) {
    return jsonError(STATUS_BAD_REQUEST, "multipart form carried no `file` part");
  }
  return file.byteLength > MAX_AUDIO_UPLOAD_BYTES ? tooLarge(file.byteLength) : undefined;
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
    };
    const transcriptionReq: AnyTranscriptionRequestBody =
      form.file instanceof ReadableStream
        ? { ...common, file: form.file, stream: true }
        : { ...common, file: form.file, stream: form.stream };
    return handleTranscription(transcriptionReq, start);
  };
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
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_UPLOAD_BYTES) {
    return tooLarge(declared);
  }
  const parsed = liveTranscription(req) ?? (await parseTranscriptionForm(req));
  if (parsed === undefined) {
    return jsonError(STATUS_BAD_REQUEST, "expected a multipart form with a `file` part");
  }
  // The wrapper's streaming route carries language and prompt and nothing
  // else, so a streamed translation would arrive as a plain transcription.
  if (translating && parsed.stream) {
    return jsonError(
      STATUS_BAD_REQUEST,
      "a translation cannot be streamed; send it as a buffered request",
    );
  }
  return uploadRefusal(parsed.file) ?? (translating ? { ...parsed, translate: true } : parsed);
}

export async function handleAudioTranscription(
  ctx: DoorContext,
  req: Request,
  endpoint: string = CONTENT_ENDPOINT_TRANSCRIPTIONS,
): Promise<Response> {
  const form = await readAudioUpload(req, endpoint === CONTENT_ENDPOINT_TRANSLATIONS);
  if (form instanceof Response) {
    return form;
  }
  const resolved = resolveModel(
    form.rawModel ?? undefined,
    endpoint,
    ctx.getConfig(),
    ctx.registry,
  );
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error);
  }
  const live = form.file instanceof ReadableStream;
  if (resolved.kind === "chain" && live) {
    // The upload is the request, and it is consumed by the hop that reads it.
    // A second hop would be handed a body already drained -- it would transcribe
    // silence and report success, which is worse than refusing here. The
    // buffered form of this verb chains, because its bytes can be sent twice.
    return jsonError(
      STATUS_BAD_REQUEST,
      "a recording streamed as the request body cannot be replayed on a second hop; send it as a multipart upload to use a chain",
    );
  }
  const attempt = transcriptionAttempt(form);

  if (resolved.kind === "chain") {
    return runAudioChain(ctx, {
      chain: resolved.chain,
      hops: resolved.hops,
      requested: form.rawModel ?? "",
      endpoint,
      attempt,
      signal: req.signal,
    });
  }

  const { engineId, model, upstream } = singleAudioRoute(resolved.route);
  const leased: AudioLease = { held: false };
  const startedAt = Date.now();
  const result = await attempt(engineId, model, audioStart(ctx, leased));
  return finishAudioCall(ctx, leased, {
    engineId,
    model,
    upstream,
    requested: form.rawModel ?? "",
    result,
    startedAt,
  });
}
