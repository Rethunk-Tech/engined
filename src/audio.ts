import {
  JSON_CONTENT_TYPE,
  jsonErrorBody,
  NDJSON_CONTENT_TYPE,
  pcmContentType,
  STATUS_BAD_GATEWAY,
  STATUS_CONFLICT,
  STATUS_OK,
} from "./http.ts";
import { isRecord, parseRecord } from "./types.ts";
import type { UpstreamEndpoint } from "./upstream.ts";

/** OpenAI's non-JSON transcript formats; whisper.cpp's server speaks this same dialect. */
export const TEXT_RESPONSE_FORMATS = new Set(["text", "srt", "vtt"]);
/**
 * Every shipped TTS engine emits WAV, and only WAV, over `/v1/tts`. Transcoding to
 * mp3/opus/flac would mean shelling out to ffmpeg (or a new dependency) for a
 * format no consumer has asked for yet — reject instead of silently mislabelling
 * bytes, and add real transcoding the day a caller actually needs it.
 */
export const SPEECH_RESPONSE_FORMATS = new Set(["wav"]);

/**
 * Markup a TTS engine vocalizes, and the cost of leaving it in: `**bold**`
 * synthesizes 3.5x slower than `bold` and a bare URL 2.2x, measured against
 * piper. Backticks and list hyphens measured free, so backticks stay --
 * removing what costs nothing only risks mangling quoted code -- and
 * underscores stay too, since `some_var` is an identifier far more often than
 * emphasis.
 *
 * Applied to every request rather than behind a flag. The consumer paying the
 * 3.5x is the one that strips nothing, so an opt-in lever is set by exactly
 * the callers who already normalize and by none of the ones that do not. The
 * rejected alternative to that is a per-request opt-out, which is not shipped
 * because no caller has asked to have asterisks read aloud; the day one does,
 * it is a door key, not an engine parameter.
 */
const MARKDOWN_LINK = /\[([^\]]*)\]\(([^)]*)\)/g;
/** The trailing character is pinned to a non-terminator so a sentence-final `https://example.com.` keeps its period. */
const BARE_URL = /\bhttps?:\/\/\S*[^\s.,;:!?)]/g;
const LEADING_MARKUP = /^[ \t]*(?:#{1,6}|[-+])[ \t]+/gm;
const ASTERISKS = /\*+/g;
const WWW = /^www\./;

/** A host is speakable, a path is not, and the measurement was taken against `example dot com`. */
function spokenUrl(url: string): string {
  try {
    return new URL(url).hostname.replace(WWW, "").replaceAll(".", " dot ");
  } catch {
    return url;
  }
}

/**
 * Text as the voice should receive it. Every rule removes markup or rewrites a
 * URL into words, and none of them collapses whitespace: nothing here
 * introduces a run of spaces, and a caller that already normalizes must get
 * its own bytes back rather than a second, differently-spaced pass.
 *
 * Pronunciation is deliberately absent. A lexicon is per-installation
 * vocabulary, not a property of markdown, and belongs to whoever can supply
 * one -- this is the pass that is the same for every caller.
 */
export function speakableText(input: string): string {
  return input
    .replace(MARKDOWN_LINK, "$1")
    .replace(BARE_URL, spokenUrl)
    .replace(LEADING_MARKUP, "")
    .replace(ASTERISKS, "");
}

export interface SpeechRequestBody {
  /** The engine to dispatch through. Every TTS route stays modelless (voices are a request field, not an address segment), so there is no separate model to carry. */
  engine: string;
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
   * engines have several: chatterbox-multi takes a reference-voice path and a
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
  /** Set instead of `bytes` on a streamed reply: speech samples, or a transcript's NDJSON frames. */
  stream?: ReadableStream<Uint8Array>;
}

export interface TranscriptionRequestBody {
  /** The engine to dispatch through. */
  engine: string;
  /**
   * The model segment of the resolved address, when this engine's routes
   * carry one -- whisper's "small.en"/"medium.en", or the wire model a
   * remote STT dialect names (ElevenLabs' "scribe_v1"). Absent for a
   * modelless engine.
   */
  model?: string;
  /** Raw audio bytes already read from the multipart upload. */
  file: Uint8Array<ArrayBuffer>;
  /** Reaches the engine on the wire, per request; never written into its spec. */
  language?: string;
  response_format?: string;
  /**
   * Vocabulary the caller expects to hear -- whisper's `initial_prompt`. It is
   * the only lever that moves a proper noun the model has never seen, so a
   * door that drops it silently costs every caller that error class. Comma
   * separated, and capped to whisper's window by `cappedBiasPrompt` before it
   * reaches the engine.
   */
  prompt?: string;
  /**
   * Render the speech as English rather than in the language it was spoken --
   * whisper's own `translate`, and the whole difference between
   * `/openai/v1/audio/translations` and `/openai/v1/audio/transcriptions`.
   *
   * Only a route whose weights are multilingual serves that verb at all
   * (`ResolvedRoute.translate`), because an English-only model handed this
   * flag does not fail: it transcribes and returns something that reads like
   * a translation of English speech.
   */
  translate?: boolean;
  /**
   * Deliver each segment as the model decodes it instead of the transcript
   * after all of it exists. Opt-in because it changes what comes back: NDJSON
   * frames rather than one JSON body, and so no `response_format` to apply.
   */
  stream?: boolean;
}

/**
 * The same request with the recording still arriving. A multipart part cannot
 * be read before the part after it exists, so a form is a buffer by
 * construction — the shape that carries a live recording is the audio itself
 * as the body, and every other field in the query string.
 *
 * `stream` is not optional here: a body with no declared end has no whole
 * transcript to wait for, and nothing to answer a buffered request with.
 */
interface StreamedTranscriptionRequestBody
  extends Omit<TranscriptionRequestBody, "file" | "stream"> {
  file: ReadableStream<Uint8Array>;
  stream: true;
}

/** Either shape of the same verb; `liveUpload` tells them apart. */
export type AnyTranscriptionRequestBody =
  | TranscriptionRequestBody
  | StreamedTranscriptionRequestBody;

export function liveUpload(
  req: AnyTranscriptionRequestBody,
): req is StreamedTranscriptionRequestBody {
  return req.file instanceof ReadableStream;
}

/**
 * Whatever starts an engine on demand and reports where it landed —
 * `EngineRegistry.start`, in production. `model` selects which of the
 * engine's own model-bearing routes should be resident (whisper's
 * "small.en"/"medium.en"); absent for a modelless engine, which is every
 * TTS route and most STT ones.
 *
 * A route on a non-local upstream lands nowhere: there is no container and
 * so no `private_url`, and `remote` carries the upstream's address and
 * header instead. The two are mutually exclusive by construction, not by
 * convention — such a route is never handed to the lifecycle at all.
 */
export type EngineStart = (id: string, model?: string) => Promise<StartedEngine>;

export interface StartedEngine {
  private_url: string | null;
  remote?: UpstreamEndpoint;
  /**
   * The runnable fix for an engine that could not be reached at all — a
   * `secret-tool store` line, usually. Carried rather than collapsed into
   * "not available", because for a remote engine the reason is always
   * actionable and always specific.
   */
  unavailable?: string;
  /**
   * Set instead of starting: switching the container to the requested model
   * would stop a request already in flight. A warm is an optimization, and
   * killing one to satisfy it is strictly worse than warming late.
   */
  conflict?: string;
}

/**
 * The first NDJSON line carrying a non-empty `audio` field. Each engine app
 * emits exactly one terminal `{phase:"done", audio}` frame, so a second one
 * does not occur -- an engine that starts emitting CHUNKED audio needs this
 * to concatenate rather than return early, and would be silently truncated
 * to its first chunk until it does.
 */
export function extractAudioFromNdjson(body: string): { audio?: string; error?: string } {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const frame = parseRecord(trimmed);
    if (frame === null) {
      continue;
    }
    // The engine says why it refused -- an unknown voice, say. Reporting
    // "carried no audio" instead sends the caller looking at the door.
    if (frame.phase === "error" && typeof frame.detail === "string") {
      return { error: frame.detail };
    }
    if (typeof frame.audio === "string" && frame.audio.length > 0) {
      return { audio: frame.audio };
    }
  }
  return {};
}

export interface Frame {
  phase?: unknown;
  pcm?: unknown;
  rate?: unknown;
  words?: unknown;
  detail?: unknown;
  step?: unknown;
  step_limit?: unknown;
  audio?: unknown;
  /** A transcription frame: one decoded segment, and where it sits in the recording. */
  text?: unknown;
  start?: unknown;
  end?: unknown;
}

/**
 * Every parseable NDJSON line, including a last one the engine did not
 * newline-terminate.
 *
 * A consumer that stops early — `frames.return()`, or a `break` — cancels the
 * upstream body, so a caller who hangs up does not leave a response open
 * against a running engine. That is the async iterator's own `return()`
 * reaching the source through the pipe, not something this loop arranges.
 */
export async function* ndjsonFrames(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): AsyncGenerator<Frame> {
  let pending = "";
  for await (const text of body.pipeThrough(new TextDecoderStream())) {
    pending += text;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const frame = parseRecord(line);
      if (frame !== null) {
        yield frame;
      }
    }
  }
  const last = parseRecord(pending);
  if (last !== null) {
    yield last;
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
export async function streamedSpeech(
  engineId: string,
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
): Promise<DoorResponse> {
  const frames = ndjsonFrames(body);
  /**
   * Only the success path hands `frames` on to a consumer that will cancel it.
   * Every other exit abandons the generator mid-yield, and an abandoned
   * generator skips a `finally` block exactly as it skips `return()` -- so the
   * explicit call is what releases the engine's body, not any wrapper around
   * the loop. Awaited so the body is released before the door replies, and
   * suppressed so a cleanup that throws cannot replace the reason the request
   * failed with an unrelated one.
   */
  const fail = async (message: string): Promise<DoorResponse> => {
    await frames.return(undefined).catch(() => undefined);
    return errorResponse(STATUS_BAD_GATEWAY, message);
  };
  for (;;) {
    const { done, value } = await frames.next();
    if (done) {
      return await fail(`${engineId}: /v1/tts streamed no audio`);
    }
    if (value.phase === "error") {
      const detail = typeof value.detail === "string" ? value.detail : "no detail";
      return await fail(`${engineId}: /v1/tts failed: ${detail}`);
    }
    if (value.phase !== "chunk" || typeof value.pcm !== "string") {
      continue;
    }
    if (typeof value.rate !== "number") {
      return await fail(`${engineId}: /v1/tts chunk carried no sample rate`);
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
export function ndjsonSpeech(body: ReadableStream<Uint8Array<ArrayBuffer>>): DoorResponse {
  let sentChunk = false;
  return ndjsonRelay(ndjsonFrames(body), (frame) => {
    const out = vettedFrame(frame, sentChunk);
    if (out?.phase === "chunk") {
      sentChunk = true;
    }
    return out;
  });
}

/**
 * The engine's own frames, re-serialized one at a time through `vet` and
 * forwarded as they land. A frame `vet` rejects is dropped rather than
 * forwarded, so an engine gaining a field does not silently become part of
 * this door's contract.
 *
 * The response commits before the first frame: there is no header here that
 * depends on something only a later frame knows, so an engine that produces
 * nothing ends as its own terminal `error` frame rather than as a status code.
 *
 * `cancel` is the whole cancellation path. A caller that stops reading reaches
 * `frames.return()`, which cancels the engine's body -- dropping it instead
 * would leave the engine decoding for nobody.
 */
export function ndjsonRelay(
  frames: AsyncGenerator<Frame>,
  vet: (frame: Frame) => Record<string, unknown> | undefined,
): DoorResponse {
  const encoder = new TextEncoder();
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
        const out = vet(value);
        if (out !== undefined) {
          controller.enqueue(encoder.encode(`${JSON.stringify(out)}\n`));
        }
      },
      async cancel() {
        await frames.return(undefined);
      },
    }),
  };
}

/** A spoken word and where it sits in the utterance, in seconds, when the engine can tell. */
function isWord(value: unknown): value is { text: string; start: number; end: number } {
  return (
    isRecord(value) &&
    typeof value.text === "string" &&
    typeof value.start === "number" &&
    typeof value.end === "number"
  );
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
    if (Array.isArray(frame.words)) {
      out.words = frame.words.filter(isWord);
    }
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
          // Closing the caller's stream does not reach the source, so an error
          // frame has to release the engine's body itself; a `done` generator
          // takes this as a no-op.
          await frames.return(undefined).catch(() => undefined);
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

export function errorResponse(status: number, message: string): DoorResponse {
  return { status, contentType: JSON_CONTENT_TYPE, body: jsonErrorBody(message) };
}

/** `undefined` when `start()` handed back a usable engine; a 409 response otherwise. */
export function conflictResponse(engine: StartedEngine): DoorResponse | undefined {
  return engine.conflict === undefined
    ? undefined
    : errorResponse(STATUS_CONFLICT, engine.conflict);
}
