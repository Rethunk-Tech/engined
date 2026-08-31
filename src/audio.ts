/**
 * `POST /v1/audio/speech`: translates a TTS engine's native NDJSON
 * `{audio: base64 WAV, alignment}` at `POST /v1/tts` into OpenAI audio bytes.
 * `response_format` is honoured by rejection, not translation: the only
 * format any TTS engine emits is WAV, so a request for anything else is a 400
 * naming what is supported, rather than bytes silently mislabelled with the
 * wrong content type. Alignment is not on this door — chatterbox's own value
 * is null until a later sagaforge phase, so nothing here surfaces or invents
 * a field for it.
 * sagaforge itself bypasses this file entirely and reads the native NDJSON
 * straight from the engine's `private_url`; that path is accepted, not
 * something this module needs to guard against.
 *
 * `POST /v1/audio/transcriptions`: whisper's own `--inference-path` is the
 * OpenAI path itself, so the request needs no translation — only
 * `response_format` decides whether the reply is unwrapped to bare text or
 * passed through as JSON. `language` is a per-request field that reaches the
 * engine on the wire; it never touches the shipped spec.
 *
 * A **remote** STT engine is the one place this door translates the request
 * as well as the reply. ElevenLabs is not OpenAI-shaped: the path is
 * `/speech-to-text`, the model field is `model_id`, the language field is
 * `language_code`, and the reply is always JSON. Exactly one remote STT
 * dialect ships, because exactly one is configured — a second one earns a
 * discriminator when it exists, not before.
 */

import {
  CONTENT_TYPE,
  type HttpClient,
  JSON_CONTENT_TYPE,
  jsonErrorBody,
  NDJSON_CONTENT_TYPE,
  pcmContentType,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_OK,
  STATUS_UNAVAILABLE,
  TEXT_CONTENT_TYPE,
  WAV_CONTENT_TYPE,
} from "./http.ts";
import { type RemoteEndpoint, remoteUrl } from "./remote.ts";

/** OpenAI's non-JSON transcript formats; whisper.cpp's server speaks this same dialect. */
const TEXT_RESPONSE_FORMATS = new Set(["text", "srt", "vtt"]);
/**
 * Every shipped TTS engine emits WAV, and only WAV, over `/v1/tts`. Transcoding to
 * mp3/opus/flac would mean shelling out to ffmpeg (or a new dependency) for a
 * format no consumer has asked for yet — reject instead of silently mislabelling
 * bytes, and add real transcoding the day a caller actually needs it.
 */
const SPEECH_RESPONSE_FORMATS = new Set(["wav"]);

export interface SpeechRequestBody {
  /** The engine id: a TTS engine has no separate model concept to dispatch through. */
  model: string;
  input: string;
  response_format?: string;
  /**
   * Deliver audio as it is synthesized instead of after all of it is. Opt-in
   * because it changes what comes back: PCM rather than a WAV, since a WAV's
   * header carries a length nothing knows until the end.
   *
   * `"ndjson"` streams the engine's own frames instead of raw bytes, so a
   * caller gets synthesis progress as well as audio. A progress bar is the
   * whole reason a consumer would otherwise reach past the door to the
   * container, and reaching past the door skips recording and egress.
   */
  stream?: boolean | "ndjson";
  /** OpenAI's own speech fields, forwarded under the engine's names for them. */
  voice?: string;
  speed?: number;
  instructions?: string;
  /**
   * Every other body field, forwarded to the engine untouched.
   *
   * The OpenAI SDKs ship `extra_body` precisely so a compatible server can be
   * handed parameters the standard shape has no room for, and engined's TTS
   * engines have several: chatterbox takes a reference-voice path and a
   * language, and a new one will take something nobody has thought of yet.
   * A closed set here would mean a door edit per engine capability, which is
   * the friction the spec table exists to avoid.
   *
   * Door-only fields are stripped before this is built, so nothing engined
   * interprets is also forwarded.
   */
  extra?: Record<string, unknown>;
}

/** Fields the door reads itself, and so never passes on as engine parameters. */
export const SPEECH_DOOR_KEYS = new Set([
  "model",
  "input",
  "response_format",
  "stream",
  "voice",
  "speed",
  "instructions",
]);

export interface DoorResponse {
  status: number;
  contentType: string;
  /** A JSON error body, a transcription's bare-text/srt/vtt body, or its parsed JSON — never set on a speech success, which is `bytes` or `stream`. */
  body?: unknown;
  bytes?: Uint8Array;
  /** Set instead of `bytes` on a streamed speech response. */
  stream?: ReadableStream<Uint8Array>;
}

export interface TranscriptionRequestBody {
  /** The engine id: an STT engine has no separate model concept to dispatch through. */
  model: string;
  /** Raw audio bytes already read from the multipart upload. */
  file: Uint8Array<ArrayBuffer>;
  /** Reaches the engine on the wire, per request; never written into its spec. */
  language?: string;
  response_format?: string;
}

/**
 * Whatever starts an engine on demand and reports where it landed —
 * `EngineRegistry.start`, in production.
 *
 * A remote engine lands nowhere: it has no container and so no
 * `private_url`, and `remote` carries its address and header instead. The
 * two are mutually exclusive by construction, not by convention — a
 * `base_url` engine is never handed to the lifecycle at all.
 */
export type EngineStart = (id: string) => Promise<StartedEngine>;

interface StartedEngine {
  private_url: string | null;
  remote?: RemoteEndpoint;
  /**
   * The runnable fix for an engine that could not be reached at all — a
   * `secret-tool store` line, usually. Carried rather than collapsed into
   * "not available", because for a remote engine the reason is always
   * actionable and always specific.
   */
  unavailable?: string;
}

/**
 * The first NDJSON line carrying a non-empty `audio` field. Each engine app
 * emits exactly one terminal `{phase:"done", audio}` frame, so a second one
 * does not occur -- an engine that starts emitting CHUNKED audio needs this
 * to concatenate rather than return early, and would be silently truncated
 * to its first chunk until it does.
 */
function extractAudioFromNdjson(body: string): string | undefined {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let frame: { audio?: unknown };
    try {
      frame = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof frame.audio === "string" && frame.audio.length > 0) {
      return frame.audio;
    }
  }
}

interface Frame {
  phase?: unknown;
  pcm?: unknown;
  rate?: unknown;
  detail?: unknown;
  step?: unknown;
  step_limit?: unknown;
  audio?: unknown;
}

/** Every parseable NDJSON line, including a last one the engine did not newline-terminate. */
async function* ndjsonFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        const frame = parseFrame(line);
        if (frame !== undefined) {
          yield frame;
        }
      }
    }
    const last = parseFrame(pending);
    if (last !== undefined) {
      yield last;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function parseFrame(line: string): Frame | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed) as Frame;
  } catch {
    return undefined;
  }
}

/**
 * Holds the reply open until the first `chunk` frame, because that frame
 * carries the sample rate and the content type stating it has to be written
 * before any byte of body. Waiting is also what keeps an engine that never
 * chunks from hanging the caller: a stream that ends having produced no audio
 * is a 502 here, where committing 200 + headers first would leave the caller
 * on a body that never arrives and never ends.
 *
 * Everything after that first frame is forwarded as it lands and everything
 * else is dropped, including the terminal frame's whole-utterance WAV -- a
 * streaming caller has already been handed those samples.
 *
 * Raw PCM rather than a WAV because a WAV header carries a length nothing
 * knows until synthesis ends, and the alternatives are a sentinel length that
 * players disagree about or concatenated headers that are not a WAV at all.
 */
async function streamedSpeech(
  model: string,
  body: ReadableStream<Uint8Array>,
): Promise<DoorResponse> {
  const frames = ndjsonFrames(body);
  for (;;) {
    const { done, value } = await frames.next();
    if (done) {
      return errorResponse(STATUS_BAD_GATEWAY, `${model}: /v1/tts streamed no audio`);
    }
    if (value.phase === "error") {
      const detail = typeof value.detail === "string" ? value.detail : "no detail";
      return errorResponse(STATUS_BAD_GATEWAY, `${model}: /v1/tts failed: ${detail}`);
    }
    if (value.phase !== "chunk" || typeof value.pcm !== "string") {
      continue;
    }
    if (typeof value.rate !== "number") {
      return errorResponse(STATUS_BAD_GATEWAY, `${model}: /v1/tts chunk carried no sample rate`);
    }
    return {
      status: STATUS_OK,
      contentType: pcmContentType(value.rate),
      stream: pcmStream(Buffer.from(value.pcm, "base64"), frames),
    };
  }
}

/**
 * Forwards the engine's own frames rather than raw samples: `synthesizing` with
 * `step`/`step_limit` where the engine reports them, `chunk` with base64 `pcm`
 * and its rate, and `error` with its detail.
 *
 * Re-serialized through a vetted field list, so an engine gaining a field does
 * not silently become part of this contract.
 *
 * The terminal frame's whole-utterance `audio` is forwarded only when no chunk
 * carried samples. A chunking engine (kokoro, piper) has already sent them and
 * repeating the whole utterance doubles the payload; a non-chunking one
 * (chatterbox, which streams step counts and then one final WAV) has sent
 * nothing else, and dropping it would hand a caller progress and no audio.
 *
 * No leading status decision to make: unlike the PCM path there is no content
 * type that depends on a rate only the first chunk knows, so the response
 * commits immediately and a synthesis that never produces audio ends as a
 * final `error` frame instead of a 502.
 */
function ndjsonSpeech(body: ReadableStream<Uint8Array>): DoorResponse {
  const frames = ndjsonFrames(body);
  const encoder = new TextEncoder();
  let sentChunk = false;
  return {
    status: STATUS_OK,
    contentType: NDJSON_CONTENT_TYPE,
    stream: new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await frames.next();
        if (done) {
          controller.close();
          return;
        }
        const out = vettedFrame(value, sentChunk);
        if (out !== undefined) {
          if (out.phase === "chunk") {
            sentChunk = true;
          }
          controller.enqueue(encoder.encode(`${JSON.stringify(out)}\n`));
        }
      },
      async cancel() {
        await frames.return(undefined);
      },
    }),
  };
}

/** The fields the door forwards, and nothing an engine invents beside them. */
function vettedFrame(frame: Frame, sentChunk: boolean): Record<string, unknown> | undefined {
  if (typeof frame.phase !== "string") {
    return undefined;
  }
  const out: Record<string, unknown> = { phase: frame.phase };
  if (typeof frame.step === "number") {
    out.step = frame.step;
  }
  if (typeof frame.step_limit === "number") {
    out.step_limit = frame.step_limit;
  }
  if (typeof frame.detail === "string") {
    out.detail = frame.detail;
  }
  if (frame.phase === "chunk" && typeof frame.pcm === "string" && typeof frame.rate === "number") {
    out.pcm = frame.pcm;
    out.rate = frame.rate;
  }
  if (frame.phase === "done" && !sentChunk && typeof frame.audio === "string") {
    out.audio = frame.audio;
  }
  return out;
}

/**
 * A frame-level failure cannot become a status code once bytes are committed,
 * so a mid-stream error frame ends the stream. The caller sees short audio,
 * which is the honest signal available at that point.
 */
function pcmStream(first: Uint8Array, frames: AsyncGenerator<Frame>): ReadableStream<Uint8Array> {
  let head: Uint8Array | undefined = first;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (head !== undefined) {
        controller.enqueue(head);
        head = undefined;
        return;
      }
      for (;;) {
        const { done, value } = await frames.next();
        if (done || value.phase === "error") {
          controller.close();
          return;
        }
        if (value.phase === "chunk" && typeof value.pcm === "string") {
          controller.enqueue(Buffer.from(value.pcm, "base64"));
          return;
        }
      }
    },
    cancel() {
      frames.return(undefined).catch(() => undefined);
    },
  });
}

function errorResponse(status: number, message: string): DoorResponse {
  return { status, contentType: JSON_CONTENT_TYPE, body: jsonErrorBody(message) };
}

export async function handleSpeech(
  req: SpeechRequestBody,
  start: EngineStart,
  fetchImpl: HttpClient = fetch,
): Promise<DoorResponse> {
  if (!req.model) {
    return errorResponse(STATUS_BAD_REQUEST, "model is required");
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

  const engine = await start(req.model);
  if (engine.remote !== undefined) {
    // No remote TTS upstream is configured, so no remote TTS dialect ships.
    // Said out loud rather than left to fail as "not available", which would
    // read as a container that did not start.
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.model} is a remote address, and no remote speech dialect ships`,
    );
  }
  if (engine.private_url === null) {
    return errorResponse(STATUS_UNAVAILABLE, engine.unavailable ?? `${req.model} is not available`);
  }

  const ndjson = req.stream === "ndjson";
  const streaming = req.stream === true || ndjson;
  const res = await fetchImpl(`http://${engine.private_url}/v1/tts`, {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify({
      text: req.input,
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
    return errorResponse(STATUS_BAD_GATEWAY, `${req.model}: /v1/tts returned ${res.status}`);
  }

  if (streaming) {
    const { body } = res;
    if (body === null) {
      return errorResponse(STATUS_BAD_GATEWAY, `${req.model}: /v1/tts streamed no body`);
    }
    return ndjson ? ndjsonSpeech(body) : await streamedSpeech(req.model, body);
  }

  const audio = extractAudioFromNdjson(await res.text());
  if (audio === undefined) {
    return errorResponse(STATUS_BAD_GATEWAY, `${req.model}: /v1/tts response carried no audio`);
  }

  return { status: STATUS_OK, contentType: WAV_CONTENT_TYPE, bytes: Buffer.from(audio, "base64") };
}

/** ElevenLabs' own default. Overridable per engine through `[engine.args] model_id`. */
const ELEVENLABS_DEFAULT_MODEL_ID = "scribe_v1";
/**
 * ElevenLabs returns words with timings, so `srt`/`vtt` are buildable — and
 * building them means owning a subtitle writer for a format no consumer has
 * asked this door for. Rejected while that is still true, in the same spirit
 * as `SPEECH_RESPONSE_FORMATS` rejecting mp3 rather than mislabelling WAV.
 */
const REMOTE_TEXT_RESPONSE_FORMATS = new Set(["text"]);

/**
 * The ElevenLabs Scribe dialect. `model_id` is not the door's `model`: on
 * this door `model` names the *engine*, so the upstream's own model id can
 * only come from config — forwarding `model` verbatim would send the string
 * "elevenlabs" as a model id and earn a 422.
 */
async function transcribeRemote(
  req: TranscriptionRequestBody,
  remote: RemoteEndpoint,
  fetchImpl: HttpClient,
): Promise<DoorResponse> {
  const format = req.response_format;
  if (format !== undefined && !REMOTE_TEXT_RESPONSE_FORMATS.has(format) && format !== "json") {
    return errorResponse(
      STATUS_BAD_REQUEST,
      `${req.model}: response_format must be one of: text, json`,
    );
  }

  const form = new FormData();
  form.append("file", new Blob([req.file]), "audio");
  form.append("model_id", String(remote.args.model_id ?? ELEVENLABS_DEFAULT_MODEL_ID));
  if (req.language !== undefined) {
    form.append("language_code", req.language);
  }

  const res = await fetchImpl(remoteUrl(remote.base_url, "/speech-to-text"), {
    method: "POST",
    headers: remote.headers,
    body: form,
  });
  if (!res.ok) {
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.model}: /speech-to-text returned ${res.status}`,
    );
  }

  const parsed = (await res.json()) as { text?: unknown };
  if (typeof parsed.text !== "string") {
    return errorResponse(STATUS_BAD_GATEWAY, `${req.model}: /speech-to-text carried no transcript`);
  }
  if (format !== undefined && REMOTE_TEXT_RESPONSE_FORMATS.has(format)) {
    return { status: STATUS_OK, contentType: TEXT_CONTENT_TYPE, body: parsed.text };
  }
  // The door's own JSON shape, not the upstream's: a consumer that switched
  // engines would otherwise start seeing ElevenLabs' word timings and
  // language-probability fields appear and disappear with the engine id.
  return { status: STATUS_OK, contentType: JSON_CONTENT_TYPE, body: { text: parsed.text } };
}

export async function handleTranscription(
  req: TranscriptionRequestBody,
  start: EngineStart,
  fetchImpl: HttpClient = fetch,
): Promise<DoorResponse> {
  if (!req.model) {
    return errorResponse(STATUS_BAD_REQUEST, "model is required");
  }
  if (req.file.length === 0) {
    return errorResponse(STATUS_BAD_REQUEST, "file is required");
  }

  const engine = await start(req.model);
  if (engine.remote !== undefined) {
    return await transcribeRemote(req, engine.remote, fetchImpl);
  }
  if (engine.private_url === null) {
    return errorResponse(STATUS_UNAVAILABLE, engine.unavailable ?? `${req.model} is not available`);
  }

  const form = new FormData();
  form.append("file", new Blob([req.file]), "audio");
  if (req.language !== undefined) {
    form.append("language", req.language);
  }
  if (req.response_format !== undefined) {
    form.append("response_format", req.response_format);
  }

  const res = await fetchImpl(`http://${engine.private_url}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.model}: /v1/audio/transcriptions returned ${res.status}`,
    );
  }

  if (req.response_format !== undefined && TEXT_RESPONSE_FORMATS.has(req.response_format)) {
    return { status: STATUS_OK, contentType: TEXT_CONTENT_TYPE, body: await res.text() };
  }
  return { status: STATUS_OK, contentType: JSON_CONTENT_TYPE, body: await res.json() };
}
