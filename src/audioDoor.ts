/**
 * The door's two audio verbs. `src/audio.ts` speaks to an engine; this is
 * the half in front of it -- resolving which engine answers, holding a
 * lease for as long as the body streams, and recording the one provenance
 * line the call is entitled to.
 */

import {
  type DoorResponse,
  type EngineStart,
  handleSpeech,
  handleTranscription,
  SPEECH_DOOR_KEYS,
  type SpeechRequestBody,
  type TranscriptionRequestBody,
} from "./audio.ts";
import { classifyResult, wrapStream } from "./chain.ts";
import { resolveModel } from "./dispatch.ts";
import type { DoorContext } from "./doorContext.ts";
import { DEFAULT_IDLE_STOP_SECONDS, EngineBusyError } from "./engines.ts";
import {
  CONTENT_TYPE,
  jsonError,
  STATUS_BAD_REQUEST,
  STATUS_PAYLOAD_TOO_LARGE,
  TEXT_CONTENT_TYPE,
} from "./http.ts";
import { recordCall } from "./provenance.ts";
import {
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  type Config,
  findModelOnEngine,
  type ResolvedRoute,
} from "./types.ts";
import { resolveUpstream } from "./upstream.ts";

interface AudioCallInfo {
  engineId: string;
  /** The model segment of the resolved address, when the engine's routes carry one. Absent for a modelless engine. */
  model?: string;
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
  const { engineId, model, requested, result, startedAt } = info;
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
          },
        ],
        engine_used: ok ? engineId : null,
        // Audio provenance does not resolve or track an upstream id today --
        // this is the chat/agentic path's field.
        upstream_used: null,
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

/**
 * The audio door proxies a single buffered request per call, with no
 * multi-lease concept like `LlamaRouter`'s roles: unlike Comfy, this is
 * request traffic engined does see, so idle-stop arms right here rather than
 * off a queue poll. A no-op if the start attempt never reached "running".
 */
function armAudioIdleStop(ctx: DoorContext, engineId: string): void {
  const engine = ctx.registry.entry(engineId);
  ctx.lifecycle.endLease(engineId, engine?.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
}

/**
 * Both audio endpoints take an engine, and a model where the resolved
 * route carries one -- whisper's "small.en"/"medium.en", or ElevenLabs'
 * "scribe_v1" -- never a chain. Resolution and that refusal are one step.
 */
function resolveAudioEngine(
  ctx: DoorContext,
  rawModel: string | undefined,
  endpoint: string,
): { ok: true; engineId: string; model?: string } | { ok: false; response: Response } {
  const resolved = resolveModel(rawModel, endpoint, ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return { ok: false, response: jsonError(STATUS_BAD_REQUEST, resolved.error) };
  }
  if (resolved.kind === "chain") {
    return {
      ok: false,
      response: jsonError(STATUS_BAD_REQUEST, "audio endpoints do not take a chain"),
    };
  }
  return { ok: true, engineId: resolved.route.engine, model: resolved.route.model };
}

/** The route an audio call resolves to; a modelless route has no model segment to look one up by, so it is found by engine id alone. */
function audioRoute(
  config: Config,
  id: string,
  model: string | undefined,
): ResolvedRoute | undefined {
  return model === undefined
    ? config.routes.find((r) => r.engine === id && r.model === undefined)
    : findModelOnEngine(config.routes, id, model);
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
function audioStart(ctx: DoorContext): EngineStart {
  return async (id: string, model?: string) => {
    const engine = ctx.registry.entry(id);
    const route = audioRoute(ctx.getConfig(), id, model);
    const upstreamId = route?.upstream ?? null;
    if (engine && upstreamId !== null && upstreamId !== "local") {
      return remoteAudioStart(ctx, id, upstreamId);
    }
    try {
      await ctx.registry.start(id, model);
    } catch (err) {
      if (err instanceof EngineBusyError) {
        return { private_url: null, conflict: err.message };
      }
      throw err;
    }
    // Paired with the `armAudioIdleStop` every audio path runs on the way out.
    ctx.lifecycle.beginLease(id);
    // `EngineStatus` (the wire type `registry.start` returns) carries no
    // container address at all -- the internal runtime read is `lifecycle`'s
    // own, the same source the comfy proxy resolves against.
    return { private_url: ctx.lifecycle.getStatus(id).private_url };
  };
}

export async function handleAudioSpeech(
  ctx: DoorContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const audio = resolveAudioEngine(ctx, rawModel, CONTENT_ENDPOINT_SPEECH);
  if (!audio.ok) {
    return audio.response;
  }
  const { engineId } = audio;
  const start = audioStart(ctx);
  const extra = Object.fromEntries(
    Object.entries(body).filter(([key]) => !SPEECH_DOOR_KEYS.has(key)),
  );
  const speechReq: SpeechRequestBody = {
    engine: engineId,
    input: typeof body.input === "string" ? body.input : "",
    response_format: typeof body.response_format === "string" ? body.response_format : undefined,
    stream: body.stream === "ndjson" ? "ndjson" : body.stream === true,
    voice: typeof body.voice === "string" ? body.voice : undefined,
    speed: typeof body.speed === "number" ? body.speed : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
  };
  const startedAt = Date.now();
  const result = await handleSpeech(speechReq, start);
  armAudioIdleStop(ctx, engineId);
  return doorResponseToResponse(
    recordAudioCall(ctx, { engineId, requested: rawModel ?? "", result, startedAt }),
  );
}

interface TranscriptionForm {
  rawModel: string | null;
  file: Uint8Array<ArrayBuffer>;
  language: string | undefined;
  responseFormat: string | undefined;
  prompt: string | undefined;
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
  return {
    rawModel: typeof rawModel === "string" ? rawModel : null,
    file: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0),
    language: typeof language === "string" ? language : undefined,
    responseFormat: typeof responseFormat === "string" ? responseFormat : undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
  };
}

/**
 * An upload is read into memory whole, so a request larger than this is
 * refused before it is read rather than after. Generous enough for any
 * recording a caller has reason to transcribe in one request; a longer one
 * belongs in segments, which is what every consumer already sends.
 */
const MAX_AUDIO_UPLOAD_BYTES = 268_435_456;

export async function handleAudioTranscription(ctx: DoorContext, req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_UPLOAD_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `upload is ${declared} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
    );
  }
  const form = await parseTranscriptionForm(req);
  if (form === undefined) {
    return jsonError(STATUS_BAD_REQUEST, "expected a multipart form with a `file` part");
  }
  // Zero bytes reaches whisper as a valid-looking empty upload and comes back
  // as an empty transcript, which reads like silence rather than a bad request.
  if (form.file.byteLength === 0) {
    return jsonError(STATUS_BAD_REQUEST, "multipart form carried no `file` part");
  }
  if (form.file.byteLength > MAX_AUDIO_UPLOAD_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `upload is ${form.file.byteLength} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
    );
  }
  const audio = resolveAudioEngine(
    ctx,
    form.rawModel ?? undefined,
    CONTENT_ENDPOINT_TRANSCRIPTIONS,
  );
  if (!audio.ok) {
    return audio.response;
  }
  const { engineId, model } = audio;
  const start = audioStart(ctx);
  const transcriptionReq: TranscriptionRequestBody = {
    engine: engineId,
    model,
    file: form.file,
    language: form.language,
    response_format: form.responseFormat,
    prompt: form.prompt,
  };
  const startedAt = Date.now();
  const result = await handleTranscription(transcriptionReq, start);
  armAudioIdleStop(ctx, engineId);
  return doorResponseToResponse(
    recordAudioCall(ctx, { engineId, model, requested: form.rawModel ?? "", result, startedAt }),
  );
}
