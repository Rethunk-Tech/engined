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
 */

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

/** Whatever starts an engine on demand and reports where it landed — `EngineRegistry.start`, in production. */
export type EngineStart = (id: string) => Promise<{ private_url: string | null }>;

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
  if (engine.private_url === null) {
    return errorResponse(STATUS_UNAVAILABLE, `${req.model} is not available`);
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
  if (engine.private_url === null) {
    return errorResponse(STATUS_UNAVAILABLE, `${req.model} is not available`);
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
