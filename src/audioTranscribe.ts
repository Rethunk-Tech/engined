/**
 * The transcription endpoint: whisper locally or a remote provider, the bias
 * prompt each accepts, and the streaming path a caller reaches only by asking
 * for it — the plain verb still answers exactly what whisper-server serves.
 */

import {
  type AnyTranscriptionRequestBody,
  conflictResponse,
  type DoorResponse,
  type EngineStart,
  errorResponse,
  type Frame,
  liveUpload,
  ndjsonFrames,
  ndjsonRelay,
  TEXT_RESPONSE_FORMATS,
  type TranscriptionRequestBody,
} from "./audio.ts";
import {
  CONTENT_TYPE,
  discardBody,
  type HttpClient,
  JSON_CONTENT_TYPE,
  OCTET_STREAM_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_OK,
  STATUS_UNAVAILABLE,
  TEXT_CONTENT_TYPE,
} from "./http.ts";
import { parseRecord } from "./types.ts";
import { type UpstreamEndpoint, upstreamUrl } from "./upstream.ts";

/**
 * ElevenLabs returns words with timings, so `srt`/`vtt` are buildable — and
 * building them means owning a subtitle writer for a format no consumer has
 * asked this door for. Rejected while that is still true, in the same spirit
 * as `SPEECH_RESPONSE_FORMATS` rejecting mp3 rather than mislabelling WAV.
 */
const REMOTE_TEXT_RESPONSE_FORMATS = new Set(["text"]);

/**
 * The ElevenLabs Scribe dialect. `model` is the door's own resolved model --
 * the route's `model` (`@/elevenlabs/scribe_v1`), never `req.engine`, which
 * names the engine and would send the literal string "elevenlabs" as a
 * model id and earn a 422.
 */
async function transcribeRemote(
  req: TranscriptionRequestBody,
  remote: UpstreamEndpoint,
  model: string,
  fetchImpl: HttpClient,
): Promise<DoorResponse> {
  const format = req.response_format;
  if (format !== undefined && !REMOTE_TEXT_RESPONSE_FORMATS.has(format) && format !== "json") {
    return errorResponse(
      STATUS_BAD_REQUEST,
      `${req.engine}: response_format must be one of: text, json`,
    );
  }

  // No prompt here: this speaks the remote STT dialect (`model_id`,
  // `language_code`), which has no equivalent of whisper's initial prompt.
  const form = new FormData();
  form.append("file", new Blob([req.file]), "audio");
  form.append("model_id", model);
  if (req.language !== undefined) {
    form.append("language_code", req.language);
  }

  const res = await fetchImpl(upstreamUrl(remote.base_url, "/speech-to-text"), {
    method: "POST",
    headers: remote.headers,
    body: form,
  });
  if (!res.ok) {
    await discardBody(res);
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.engine}: /speech-to-text returned ${res.status}`,
    );
  }

  const text = parseRecord(await res.text())?.text;
  if (typeof text !== "string") {
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.engine}: /speech-to-text carried no transcript`,
    );
  }
  if (format !== undefined && REMOTE_TEXT_RESPONSE_FORMATS.has(format)) {
    return { status: STATUS_OK, contentType: TEXT_CONTENT_TYPE, body: text };
  }
  // The door's own JSON shape, not the upstream's: a consumer that switched
  // engines would otherwise start seeing ElevenLabs' word timings and
  // language-probability fields appear and disappear with the engine id.
  return { status: STATUS_OK, contentType: JSON_CONTENT_TYPE, body: { text } };
}

/**
 * The path the wrapper in front of whisper answers with frames. Not the
 * OpenAI verb's own path: that one stays exactly what whisper-server has
 * always served, so a caller that does not ask to stream reaches the same
 * handler it always did.
 */
const TRANSCRIPTION_STREAM_PATH = "/v1/audio/transcriptions/stream";

/**
 * Whisper's `initial_prompt` is a fixed window -- half the text context, 224
 * tokens -- and vocabulary past it does not reach the decoder at all. The door
 * has no tokenizer, so the window is held as terms and term length: 24 terms
 * of at most 40 characters is ~960 characters, close under the window, and a
 * term longer than that is a phrase, which biases a whole sentence rather than
 * a name.
 *
 * The cap lives here because the limit is whisper's, not any caller's. Two
 * consumers guessed it independently and disagreed about which vocabulary
 * survives, which is the failure a shared door exists to prevent.
 */
const MAX_BIAS_TERMS = 24;
const MAX_BIAS_TERM_LENGTH = 40;

/**
 * The comma-separated vocabulary the engine will actually see, or `undefined`
 * when none of it is usable -- an empty `initial_prompt` is not the same as no
 * initial prompt, and the field belongs absent rather than blank.
 *
 * Newest first: a bias prompt exists to carry a name the model has never seen,
 * and corrections are appended as they are taught, so spending the cap on the
 * front of the list drops exactly the terms just added for this conversation.
 * Order within what survives is the caller's own, so a prompt already under
 * the cap round-trips unchanged.
 *
 * Truncated rather than refused. The recording is already uploaded and the
 * prompt is a hint, so a 400 costs the caller a transcription to protect a
 * bias term, and the term it protects is the one the model needs least. What
 * makes the drop honest is that the rule is one rule, stated here and the same
 * for every caller, instead of a per-consumer guess.
 */
function cappedBiasPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined) {
    return undefined;
  }
  const terms = prompt.split(",");
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let i = terms.length - 1; i >= 0 && kept.length < MAX_BIAS_TERMS; i -= 1) {
    const term = (terms[i] ?? "").trim().slice(0, MAX_BIAS_TERM_LENGTH);
    const key = term.toLowerCase();
    if (term !== "" && !seen.has(key)) {
      seen.add(key);
      kept.push(term);
    }
  }
  return kept.length === 0 ? undefined : kept.reverse().join(", ");
}

/** The transcription fields the door forwards, and nothing an engine invents beside them. */
function vettedTranscriptFrame(frame: Frame): Record<string, unknown> | undefined {
  if (typeof frame.phase !== "string") {
    return undefined;
  }
  const out: Record<string, unknown> = { phase: frame.phase };
  if (typeof frame.text === "string") {
    out.text = frame.text;
  }
  if (typeof frame.start === "number") {
    out.start = frame.start;
  }
  if (typeof frame.end === "number") {
    out.end = frame.end;
  }
  if (typeof frame.detail === "string") {
    out.detail = frame.detail;
  }
  return out;
}

/**
 * The upload goes up as its own body rather than inside a multipart form: this
 * route is the door's, not OpenAI's, and the two per-request levers whisper
 * takes ride in the query string instead of earning a parser on the far side.
 */
async function transcribeStreamed(
  req: AnyTranscriptionRequestBody,
  privateUrl: string,
  fetchImpl: HttpClient,
): Promise<DoorResponse> {
  const query = new URLSearchParams();
  if (req.language !== undefined) {
    query.set("language", req.language);
  }
  const prompt = cappedBiasPrompt(req.prompt);
  if (prompt !== undefined) {
    query.set("prompt", prompt);
  }
  const suffix = query.size > 0 ? `?${query}` : "";
  const res = await fetchImpl(`http://${privateUrl}${TRANSCRIPTION_STREAM_PATH}${suffix}`, {
    method: "POST",
    headers: { [CONTENT_TYPE]: OCTET_STREAM_CONTENT_TYPE },
    body: req.file,
  });
  if (!res.ok) {
    await discardBody(res);
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.engine}: ${TRANSCRIPTION_STREAM_PATH} returned ${res.status}`,
    );
  }
  const { body } = res;
  if (body === null) {
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.engine}: ${TRANSCRIPTION_STREAM_PATH} streamed no body`,
    );
  }
  return ndjsonRelay(ndjsonFrames(body), vettedTranscriptFrame);
}

/** `undefined` when the request is well-formed; a 400 response otherwise. */
function invalidTranscriptionRequest(req: AnyTranscriptionRequestBody): DoorResponse | undefined {
  if (!req.engine) {
    return errorResponse(STATUS_BAD_REQUEST, "engine is required");
  }
  // A live body's emptiness is not knowable here -- the engine answers a body
  // that turned out to carry nothing with its own 400.
  if (!liveUpload(req) && req.file.length === 0) {
    return errorResponse(STATUS_BAD_REQUEST, "file is required");
  }
  // srt/vtt/text format a whole transcript, and a streamed reply has no whole
  // transcript to format. Refused rather than ignored: honouring neither the
  // format nor the refusal is how a caller ends up parsing frames as subtitles.
  if (
    req.stream === true &&
    req.response_format !== undefined &&
    TEXT_RESPONSE_FORMATS.has(req.response_format)
  ) {
    return errorResponse(
      STATUS_BAD_REQUEST,
      `a streamed transcription answers in NDJSON frames, so response_format "${req.response_format}" does not apply`,
    );
  }
  // The streamed path is the door's own route on the whisper wrapper, whose
  // two query levers are language and prompt -- it has no channel for this
  // one. Refused rather than dropped: a translation request answered with an
  // untranslated transcript is the failure this whole flag guards against.
  if (req.stream === true && req.translate === true) {
    return errorResponse(
      STATUS_BAD_REQUEST,
      "a translation cannot be streamed; send it as a buffered request",
    );
  }
  return undefined;
}

/** The OpenAI verb as whisper-server has always answered it: one multipart form up, one whole body back. */
async function transcribeLocal(
  req: TranscriptionRequestBody,
  privateUrl: string,
  fetchImpl: HttpClient,
): Promise<DoorResponse> {
  const form = new FormData();
  form.append("file", new Blob([req.file]), "audio");
  if (req.language !== undefined) {
    form.append("language", req.language);
  }
  // whisper-server parses this per request, so the same loaded model answers
  // both verbs -- no second container and no restart to translate.
  if (req.translate === true) {
    form.append("translate", "true");
  }
  if (req.response_format !== undefined) {
    form.append("response_format", req.response_format);
  }
  const prompt = cappedBiasPrompt(req.prompt);
  if (prompt !== undefined) {
    form.append("prompt", prompt);
  }

  const res = await fetchImpl(`http://${privateUrl}/v1/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    await discardBody(res);
    return errorResponse(
      STATUS_BAD_GATEWAY,
      `${req.engine}: /v1/audio/transcriptions returned ${res.status}`,
    );
  }

  if (req.response_format !== undefined && TEXT_RESPONSE_FORMATS.has(req.response_format)) {
    return { status: STATUS_OK, contentType: TEXT_CONTENT_TYPE, body: await res.text() };
  }
  return { status: STATUS_OK, contentType: JSON_CONTENT_TYPE, body: await res.json() };
}

export async function handleTranscription(
  req: AnyTranscriptionRequestBody,
  start: EngineStart,
  fetchImpl: HttpClient = fetch,
): Promise<DoorResponse> {
  const invalid = invalidTranscriptionRequest(req);
  if (invalid) {
    return invalid;
  }

  const engine = await start(req.engine, req.model);
  const conflict = conflictResponse(engine);
  if (conflict) {
    return conflict;
  }
  if (engine.remote !== undefined) {
    if (liveUpload(req) || req.stream === true) {
      // Said out loud rather than answered with the buffered transcript: a
      // caller that asked for frames and silently got one body cannot tell
      // the engine from the door.
      return errorResponse(
        STATUS_BAD_REQUEST,
        `${req.engine} is a remote address, and no remote transcription dialect streams`,
      );
    }
    if (req.model === undefined) {
      return errorResponse(
        STATUS_BAD_GATEWAY,
        `${req.engine} requires a model, and none was named`,
      );
    }
    return await transcribeRemote(req, engine.remote, req.model, fetchImpl);
  }
  if (engine.private_url === null) {
    return errorResponse(
      STATUS_UNAVAILABLE,
      engine.unavailable ?? `${req.engine} is not available`,
    );
  }
  if (liveUpload(req) || req.stream === true) {
    return await transcribeStreamed(req, engine.private_url, fetchImpl);
  }
  return await transcribeLocal(req, engine.private_url, fetchImpl);
}
