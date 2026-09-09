/**
 * The speech endpoint: the voice a request names, the engine that renders it,
 * and the cache that keeps a repeated line from re-rendering. Answers WAV or
 * a PCM frame stream; never mislabels one as the other.
 */

import { createHash } from "node:crypto";
import {
  conflictResponse,
  type DoorResponse,
  type EngineStart,
  errorResponse,
  extractAudioFromNdjson,
  ndjsonSpeech,
  SPEECH_RESPONSE_FORMATS,
  type SpeechRequestBody,
  type StartedEngine,
  speakableText,
  streamedSpeech,
} from "./audio.ts";
import {
  CONTENT_TYPE,
  discardBody,
  type HttpClient,
  JSON_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_OK,
  STATUS_UNAVAILABLE,
  WAV_CONTENT_TYPE,
} from "./http.ts";

/** `undefined` when the request body is well-formed; a 400 response otherwise. */
function invalidSpeechRequest(req: SpeechRequestBody): DoorResponse | undefined {
  if (!req.engine) {
    return errorResponse(STATUS_BAD_REQUEST, "engine is required");
  }
  if (!req.input) {
    return errorResponse(STATUS_BAD_REQUEST, "input is required");
  }
  if (req.response_format !== undefined && !SPEECH_RESPONSE_FORMATS.has(req.response_format)) {
    return errorResponse(
      STATUS_BAD_REQUEST,
      `response_format must be one of: ${[...SPEECH_RESPONSE_FORMATS].join(", ")}`,
    );
  }
  return undefined;
}

/** `undefined` when `engine` is a running local container this door can speak to; the error response otherwise. */
function unusableSpeechEngine(name: string, engine: StartedEngine): DoorResponse | undefined {
  const conflict = conflictResponse(engine);
  if (conflict) {
    return conflict;
  }
  if (engine.remote !== undefined) {
    // No remote TTS upstream is configured, so no remote TTS dialect ships.
    // Said out loud rather than left to fail as "not available", which would
    // read as a container that did not start.
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${name} is a remote address, and no remote speech dialect ships`,
    );
  }
  if (engine.private_url === null) {
    return errorResponse(STATUS_UNAVAILABLE, engine.unavailable ?? `${name} is not available`);
  }
  return undefined;
}

/**
 * Bounded by bytes rather than entries: an utterance is however long the
 * caller's sentence was, so a count bound would bound nothing in particular.
 * 64 MB is ~20 minutes of 24 kHz mono WAV -- far above the stock confirmation
 * phrases this exists for, and uninteresting beside the tens of GiB an engine
 * holds.
 *
 * In memory, not on disk. The door is a daemon that stays up for days, so
 * within-uptime reuse is nearly all of the gain; a disk store would add an
 * eviction pass, a state directory no spec mounts, and a test suite that stops
 * being idempotent the moment one run leaves entries behind for the next.
 *
 * What a hit buys, measured warm through this door on one short phrase
 * ("Your build finished successfully."): chatterbox-multi 3.6-3.9 s (N=3,
 * discarding a 16.6 s first call that was the model load), piper ~80 ms
 * (N=5, median). A hit is a Map lookup. The spread is the point -- the same
 * stock phrase costs a neural TTS seconds and costs this nothing, and every
 * consumer that says it banks that rather than the one that measured it.
 */
const SPEECH_CACHE_MAX_BYTES = 67_108_864;

/** Insertion-ordered, so re-inserting on read leaves the first key the least recently used. */
const speechCache = new Map<string, Buffer>();
let speechCacheBytes = 0;

/**
 * Everything that decides the bytes, and nothing that does not.
 *
 * The text is the NORMALIZED one: two requests differing only in markdown are
 * one utterance after `speakableText`, and keying on the raw input would miss
 * exactly the pair that pass exists to make identical. `voice` is the resolved
 * value, so a `/voices/vc_...` clone handle is part of the key and two cloned
 * voices cannot collide. `response_format` is absent deliberately -- every TTS
 * engine emits WAV and anything else is already a 400, so it never changes a byte.
 */
function speechCacheKey(req: SpeechRequestBody, text: string): string {
  return createHash("sha256")
    .update(
      JSON.stringify([req.engine, text, req.voice, req.speed, req.instructions, req.extra ?? null]),
    )
    .digest("hex");
}

function cachedSpeech(key: string): Buffer | undefined {
  const hit = speechCache.get(key);
  if (hit !== undefined) {
    speechCache.delete(key);
    speechCache.set(key, hit);
  }
  return hit;
}

function storeSpeech(key: string, bytes: Buffer): void {
  if (bytes.byteLength > SPEECH_CACHE_MAX_BYTES) {
    return;
  }
  speechCache.set(key, bytes);
  speechCacheBytes += bytes.byteLength;
  for (const [oldest, old] of speechCache) {
    if (speechCacheBytes <= SPEECH_CACHE_MAX_BYTES) {
      break;
    }
    speechCache.delete(oldest);
    speechCacheBytes -= old.byteLength;
  }
}

/** The cache outlives one request by design, so a suite counting engine calls starts from empty. */
export function resetSpeechCache(): void {
  speechCache.clear();
  speechCacheBytes = 0;
}

export async function handleSpeech(
  req: SpeechRequestBody,
  start: EngineStart,
  fetchImpl: HttpClient = fetch,
): Promise<DoorResponse> {
  const invalid = invalidSpeechRequest(req);
  if (invalid) {
    return invalid;
  }
  const text = speakableText(req.input);
  // Refused before an engine is started: an input that was nothing but markup
  // reaches the engine as an empty utterance, and "synthesized no audio" sends
  // the caller looking at the container for a body it never sent.
  if (text.trim() === "") {
    return errorResponse(STATUS_BAD_REQUEST, "input carries no speakable text");
  }
  const ndjson = req.stream === "ndjson";
  const streaming = req.stream === true || ndjson;

  const engine = await start(req.engine);
  const unusable = unusableSpeechEngine(req.engine, engine);
  if (unusable) {
    return unusable;
  }

  // After the engine is resolved, never before it. Skipping `start` on a hit
  // would look like a bigger win -- no container start either -- but `start` is
  // where a stopped engine comes up on demand, where a model conflict becomes a
  // 409, where the lease is taken and where a chain learns a hop cannot answer.
  // A cache consulted ahead of it makes all four depend on what was said
  // earlier, so a chain would route by history instead of by which engine is up.
  // Synthesis is the GPU cost; consulting an already-warm engine is not.
  //
  // A streamed reply is never cached: it is frames, not a body, and storing it
  // means buffering exactly what the caller asked not to be buffered.
  //
  // Synthesis is stochastic, so this does change behaviour -- a repeated request
  // returns the same rendition rather than a fresh one. That is the point for
  // the stock phrases this exists for, and it is what majordomo's own cache, the
  // one consumer that measured this, already did unconditionally. A caller that
  // wants variation varies something in the key, most simply `speed`.
  const cacheKey = streaming ? undefined : speechCacheKey(req, text);
  if (cacheKey !== undefined) {
    const hit = cachedSpeech(cacheKey);
    if (hit !== undefined) {
      return { status: STATUS_OK, contentType: WAV_CONTENT_TYPE, bytes: hit };
    }
  }
  const res = await fetchImpl(`http://${engine.private_url}/v1/tts`, {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify({
      text,
      chunks: streaming,
      // The engine's spellings: `prompt` is what chatterbox calls what OpenAI
      // calls `instructions`. Undefined values are dropped by JSON.stringify,
      // so an unasked-for field is absent rather than null.
      voice: req.voice,
      speed: req.speed,
      prompt: req.instructions,
      ...req.extra,
    }),
  });
  if (!res.ok) {
    await discardBody(res);
    return errorResponse(STATUS_BAD_GATEWAY, `${req.engine}: /v1/tts returned ${res.status}`);
  }

  if (streaming) {
    const { body } = res;
    if (body === null) {
      return errorResponse(STATUS_BAD_GATEWAY, `${req.engine}: /v1/tts streamed no body`);
    }
    return ndjson ? ndjsonSpeech(body) : await streamedSpeech(req.engine, body);
  }

  const { audio, error } = extractAudioFromNdjson(await res.text());
  if (error !== undefined) {
    return errorResponse(STATUS_BAD_GATEWAY, `${req.engine}: /v1/tts failed: ${error}`);
  }
  if (audio === undefined) {
    return errorResponse(STATUS_BAD_GATEWAY, `${req.engine}: /v1/tts response carried no audio`);
  }

  const bytes = Buffer.from(audio, "base64");
  if (cacheKey !== undefined) {
    storeSpeech(cacheKey, bytes);
  }
  return { status: STATUS_OK, contentType: WAV_CONTENT_TYPE, bytes };
}
