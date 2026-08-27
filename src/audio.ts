/**
 * `POST /v1/audio/speech`: translates a TTS engine's native NDJSON
 * `{audio: base64 WAV, alignment}` at `POST /v1/tts` into OpenAI audio bytes.
 * Alignment is not on this door — chatterbox's own value is null until a
 * later sagaforge phase, so nothing here surfaces or invents a field for it.
 * sagaforge itself bypasses this file entirely and reads the native NDJSON
 * straight from the engine's `private_url`; that path is accepted, not
 * something this module needs to guard against.
 */

const WAV_CONTENT_TYPE = "audio/wav";
const JSON_CONTENT_TYPE = "application/json";
const STATUS_BAD_REQUEST = 400;
const STATUS_OK = 200;
const STATUS_UNAVAILABLE = 503;
const STATUS_BAD_UPSTREAM = 502;

export interface SpeechRequestBody {
  /** The engine id: a TTS engine has no separate model concept to dispatch through. */
  model: string;
  input: string;
  response_format?: string;
}

export interface DoorResponse {
  status: number;
  contentType: string;
  /** Set on every non-2xx and never on success: the OpenAI audio body is bytes, not JSON. */
  body?: unknown;
  bytes?: Uint8Array;
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
