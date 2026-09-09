/**
 * The cloned-voice store: what an operator may upload, the opaque handle it is
 * addressed by afterwards, and the eviction that keeps the directory bounded.
 * A handle never carries the uploader's own filename.
 */

import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
import process from "node:process";
import { jsonError, STATUS_BAD_REQUEST, STATUS_PAYLOAD_TOO_LARGE } from "./http.ts";
import { voicesDir } from "./paths.ts";
import { errMessage } from "./types.ts";
export const VOICE_UPLOAD_PATH = "/engined/v1/audio/voices";

/** Where each `engines/chatterbox-*` spec.toml mounts `{state_dir}/voices`. The two are one pair; changing either alone breaks every clone. */
export const VOICE_CONTAINER_DIR = "/voices";

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
export function resolveVoice(voice: string | undefined): string | undefined | Response {
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
