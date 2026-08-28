/**
 * `POST /v1/audio/speech`: translates a TTS engine's native NDJSON
 * `{audio: base64 WAV, alignment}` at `POST /v1/tts` into OpenAI audio bytes.
 * `response_format` is honoured by rejection, not translation: the only
 * format either engine emits is WAV, so a request for anything else is a 400
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

import { type RemoteEndpoint, remoteUrl } from "./remote.ts";

const WAV_CONTENT_TYPE = "audio/wav";
const TEXT_CONTENT_TYPE = "text/plain";
const JSON_CONTENT_TYPE = "application/json";
const STATUS_BAD_REQUEST = 400;
const STATUS_OK = 200;
const STATUS_UNAVAILABLE = 503;
const STATUS_BAD_UPSTREAM = 502;
/** OpenAI's non-JSON transcript formats; whisper.cpp's server speaks this same dialect. */
const TEXT_RESPONSE_FORMATS = new Set(["text", "srt", "vtt"]);
/**
 * Chatterbox and kokoro emit WAV, and only WAV, over `/v1/tts`. Transcoding to
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
}

export interface DoorResponse {
  status: number;
  contentType: string;
  /** A JSON error body, a transcription's bare-text/srt/vtt body, or its parsed JSON — never set on a speech success, which is `bytes`. */
  body?: unknown;
  bytes?: Uint8Array;
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

export interface StartedEngine {
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

/** The first NDJSON line carrying a non-empty `audio` field; later lines (if any) are ignored, same as an absent alignment. */
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

function errorResponse(status: number, message: string): DoorResponse {
  return { status, contentType: JSON_CONTENT_TYPE, body: { error: message } };
}

export async function handleSpeech(
  req: SpeechRequestBody,
  start: EngineStart,
  fetchImpl: typeof fetch = fetch,
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
      STATUS_BAD_UPSTREAM,
      `${req.model} is a remote address, and no remote speech dialect ships`,
    );
  }
  if (engine.private_url === null) {
    return errorResponse(STATUS_UNAVAILABLE, engine.unavailable ?? `${req.model} is not available`);
  }

  const res = await fetchImpl(`http://${engine.private_url}/v1/tts`, {
    method: "POST",
    headers: { "content-type": JSON_CONTENT_TYPE },
    body: JSON.stringify({ text: req.input }),
  });
  if (!res.ok) {
    return errorResponse(STATUS_BAD_UPSTREAM, `${req.model}: /v1/tts returned ${res.status}`);
  }

  const audio = extractAudioFromNdjson(await res.text());
  if (audio === undefined) {
    return errorResponse(STATUS_BAD_UPSTREAM, `${req.model}: /v1/tts response carried no audio`);
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
  fetchImpl: typeof fetch,
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
      STATUS_BAD_UPSTREAM,
      `${req.model}: /speech-to-text returned ${res.status}`,
    );
  }

  const parsed = (await res.json()) as { text?: unknown };
  if (typeof parsed.text !== "string") {
    return errorResponse(
      STATUS_BAD_UPSTREAM,
      `${req.model}: /speech-to-text carried no transcript`,
    );
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
  fetchImpl: typeof fetch = fetch,
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
      STATUS_BAD_UPSTREAM,
      `${req.model}: /v1/audio/transcriptions returned ${res.status}`,
    );
  }

  if (req.response_format !== undefined && TEXT_RESPONSE_FORMATS.has(req.response_format)) {
    return { status: STATUS_OK, contentType: TEXT_CONTENT_TYPE, body: await res.text() };
  }
  return { status: STATUS_OK, contentType: JSON_CONTENT_TYPE, body: await res.json() };
}
