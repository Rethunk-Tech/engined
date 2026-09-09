/**
 * The acceptance probes, and the images they send.
 *
 * Each one re-proves a criterion that a response cannot signal on its own, in
 * the only place that can prove it: against the live door, on a timer, rather
 * than in a note someone has to remember to act on.
 *
 * `docs/engines.md` records the one defect in this repo that nothing in a
 * response can signal: a vision request can come back a confident, plausible,
 * WRONG description of the image. It did not reproduce across three live
 * checks, which is three data points and not a fix, and a wrong description is
 * indistinguishable from a right one without ground truth. This module is the
 * ground truth -- an image whose content is known because it was built here,
 * with an answer that can be checked.
 *
 * It lives in `src/` rather than in the local test tier because two callers
 * need the same image and the same verdict: `test/local/llama.test.ts`, which
 * drives the router directly, and `main.js --probe`, which the installed
 * timer runs against the live door. A second copy of a PNG encoder is the
 * kind of drift this repo keeps getting bitten by.
 */

import { crc32, deflateSync } from "node:zlib";
import { CONTENT_TYPE, discardBody, JSON_CONTENT_TYPE, STATUS_BAD_REQUEST } from "./http.ts";
import {
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  CONTRACT,
  errMessage,
} from "./types.ts";

/** PNG's own field widths, which the format fixes and this encoder cannot choose: a chunk's length and CRC are 4 bytes each, and IHDR's payload is 13. */
const PNG_LENGTH_BYTES = 4;
const PNG_CRC_BYTES = 4;
const PNG_IHDR_BYTES = 13;

/** Where IHDR's height sits, immediately after its 4-byte width. */
const IHDR_HEIGHT_OFFSET = 4;

/** IHDR's tail after width and height: 8-bit depth, colour type 2 (RGB), then the deflate/filter/interlace defaults, which are the only values this encoder emits. */
const IHDR_TAIL = [8, 2, 0, 0, 0];
const IHDR_TAIL_OFFSET = 8;

/** One RGB pixel, and the leading filter-type-0 byte every scanline carries. */
const RGB_BYTES = 3;
const SCANLINE_FILTER_BYTES = 1;

/** The 8 bytes every PNG opens with. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/** One PNG chunk: length, 4-byte ASCII type, data, CRC32 over type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const length = Buffer.alloc(PNG_LENGTH_BYTES);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(PNG_CRC_BYTES);
  crc.writeUInt32BE(Number(crc32(Buffer.concat([typeBytes, data]))), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

/**
 * A minimal PNG encoder rather than a fixture file: no image library is
 * installed in node_modules (checked). `deflateSync` (node:zlib) already
 * produces the zlib-wrapped stream IDAT requires; `Bun.deflateSync` does not
 * -- it emits raw deflate with no header/adler32, confirmed by a failed
 * `inflateSync` round trip, which is why this uses the node import.
 *
 * Two vertical halves, not one flat colour. The defect this image exists to
 * catch returns a confident, plausible, WRONG description, and against a
 * single colour a wrong answer still lands on the expected word often enough
 * to pass: there are only a handful of words a model reaches for, so the
 * check is barely better than a coin flip. Naming two colours AND their order
 * is something a description that did not read the image cannot get right by
 * reaching for a likely word.
 */
export function splitColorPng(
  size: number,
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): Uint8Array {
  const row = Buffer.alloc(SCANLINE_FILTER_BYTES + size * RGB_BYTES);
  for (let x = 0; x < size; x++) {
    row.set(x < size / 2 ? left : right, SCANLINE_FILTER_BYTES + x * RGB_BYTES);
  }
  return encodePng(size, size, Buffer.concat(new Array(size).fill(row)));
}

/** Wraps already-filtered scanlines (each one a leading filter-type-0 byte then RGB triples) as a PNG. */
function encodePng(width: number, height: number, raw: Buffer): Uint8Array {
  const ihdr = Buffer.alloc(PNG_IHDR_BYTES);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, IHDR_HEIGHT_OFFSET);
  ihdr.set(IHDR_TAIL, IHDR_TAIL_OFFSET);
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * A 5x7 bitmap per digit, one string per scanline. Digits only, and that is
 * the point: a `read` probe needs a string no model could have memorised, so
 * it is generated per run, and ten glyphs is the whole alphabet that needs.
 * Letters would add glyphs without adding proof.
 */
const DIGIT_GLYPHS: readonly string[][] = [
  ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
];

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
/** One blank glyph column between digits, so a reader does not run two together. */
const GLYPH_GAP = 1;
/** Each glyph pixel becomes this many image pixels square. Small enough to stay a modest data URI, large enough that the strokes are not one pixel wide. */
const GLYPH_SCALE = 14;
/** Quiet space around the string, in glyph pixels: text flush to the edge reads badly. */
const MARGIN = 2;

const INK = 0;
const PAPER = 255;

/**
 * The digit string rendered black on white, big enough to read.
 *
 * A `read` route recognises characters rather than describing a scene, so the
 * two-colour image proves nothing about it -- asked to name colours,
 * PaddleOCR-VL answers with degenerate repetition, measured live. This is the
 * same idea as that image (ground truth this code created, so the right answer
 * is known) aimed at what the model actually does.
 */
export function digitsPng(text: string): Uint8Array {
  const cells = text.length * (GLYPH_WIDTH + GLYPH_GAP) - GLYPH_GAP + MARGIN * 2;
  const width = cells * GLYPH_SCALE;
  const height = (GLYPH_HEIGHT + MARGIN * 2) * GLYPH_SCALE;
  const stride = SCANLINE_FILTER_BYTES + width * RGB_BYTES;
  const raw = Buffer.alloc(stride * height, PAPER);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type 0, which the PAPER fill above overwrote
  }
  for (const [index, char] of [...text].entries()) {
    const glyph = DIGIT_GLYPHS[Number(char)];
    if (glyph === undefined) {
      continue;
    }
    const originX = MARGIN + index * (GLYPH_WIDTH + GLYPH_GAP);
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (glyph[gy]?.[gx] !== "1") {
          continue;
        }
        paintCell(raw, stride, originX + gx, MARGIN + gy);
      }
    }
  }
  return encodePng(width, height, raw);
}

/** One glyph pixel, filled as a `GLYPH_SCALE`-square block of image pixels. */
function paintCell(raw: Buffer, stride: number, cellX: number, cellY: number): void {
  for (let y = 0; y < GLYPH_SCALE; y++) {
    const rowStart = (cellY * GLYPH_SCALE + y) * stride + SCANLINE_FILTER_BYTES;
    for (let x = 0; x < GLYPH_SCALE; x++) {
      raw.fill(
        INK,
        rowStart + (cellX * GLYPH_SCALE + x) * RGB_BYTES,
        rowStart + (cellX * GLYPH_SCALE + x + 1) * RGB_BYTES,
      );
    }
  }
}

/** 64px square: large enough that the halves are unmistakable, small enough that the data URI stays a few hundred bytes of prompt. */
const SPLIT_PNG_SIZE = 64;
/** Two hues no description confuses for one another, at full saturation so neither reads as a shade of the other. */
const SPLIT_PNG_LEFT = [220, 20, 20] as const;
const SPLIT_PNG_RIGHT = [20, 20, 220] as const;

/** Red on the left, blue on the right. */
const SPLIT_PNG_DATA_URI = `data:image/png;base64,${Buffer.from(splitColorPng(SPLIT_PNG_SIZE, SPLIT_PNG_LEFT, SPLIT_PNG_RIGHT)).toString("base64")}`;

/** Two words is the whole answer this asks for; anything longer is tokens spent on prose the verdict discards. */
const VISION_MAX_TOKENS = 16;

/** The chat body that asks for exactly what `visionVerdict` reads back, and nothing else worth paying tokens for. */
export function visionRequestBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "This image has two vertical halves. Name the color of the left half, then the color of the right half. Answer with two words.",
          },
          { type: "image_url", image_url: { url: SPLIT_PNG_DATA_URI } },
        ],
      },
    ],
    max_tokens: VISION_MAX_TOKENS,
  });
}

/** How many digits the read probe puts in the image: long enough that a guess cannot land it, short enough to stay one glance for a reader. */
const READ_PROBE_DIGITS = 8;

/** A fresh string per run, so no answer can come from having seen this image before. */
export function readProbeText(): string {
  return Array.from({ length: READ_PROBE_DIGITS }, () =>
    String(Math.floor(Math.random() * DIGIT_GLYPHS.length)),
  ).join("");
}

/** The chat body for a `read` route: the digits as an image, and an instruction with no scene in it to describe. */
function visionReadRequestBody(modelId: string, text: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "Read the digits in this image. Answer with the digits only." },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${Buffer.from(digitsPng(text)).toString("base64")}`,
            },
          },
        ],
      },
    ],
    max_tokens: READ_MAX_TOKENS,
  });
}

/** Room for the digits plus whatever framing a model insists on, and no more. */
const READ_MAX_TOKENS = 64;

/** Every digit in the reply, in order, with the prose a model may wrap them in dropped. */
const NON_DIGITS = /\D+/g;

/**
 * The digits, in the order they were drawn. Punctuation and framing are
 * stripped rather than rejected -- a reader that answers "The digits are
 * 4 7 1 2." read the image correctly, and failing it would be failing the
 * wrapper rather than the recognition.
 */
export function visionReadVerdict(
  expected: string,
  reply: string,
): { ok: boolean; detail: string } {
  const seen = reply.replace(NON_DIGITS, "");
  if (!seen.includes(expected)) {
    return { ok: false, detail: `expected ${expected}, read ${JSON.stringify(reply)}` };
  }
  return { ok: true, detail: `read ${expected}` };
}

/**
 * Both halves, and the order between them. Naming one colour proves the mmproj
 * path carried SOMETHING; naming both in the image's own order is the part a
 * plausible-but-wrong description cannot reach by guessing.
 */
export function visionVerdict(reply: string): { ok: boolean; detail: string } {
  const seen = reply.toLowerCase();
  const red = seen.indexOf("red");
  const blue = seen.indexOf("blue");
  if (red < 0 || blue < 0) {
    return {
      ok: false,
      detail: `named ${red < 0 ? "no red" : "no blue"}: ${JSON.stringify(reply)}`,
    };
  }
  if (red > blue) {
    return { ok: false, detail: `named the halves in the wrong order: ${JSON.stringify(reply)}` };
  }
  return { ok: true, detail: JSON.stringify(reply) };
}

/** How much of an error body is worth a journal line: enough to name the failure, not enough to bury it. */
const ERROR_BODY_CHARS = 200;

/** One line per vision address the door offers, in the order the menu listed them. */
interface ProbeLine {
  address: string;
  ok: boolean;
  detail: string;
}

interface ProbeReport {
  /** False only when an address answered and got it wrong, or could not be reached at all. A door offering nothing to prove is `true` with one line saying so. */
  ok: boolean;
  lines: ProbeLine[];
}

/** The subset of a `/openai/v1/models` row this probe reads. Parsed from the wire, so it is narrowed here rather than imported: a row is whatever the running door sent, not whatever this build's `ModelRow` says. */
interface MenuRow {
  id?: unknown;
  role?: unknown;
  vision?: unknown;
  state?: unknown;
  translate?: unknown;
  serves?: unknown;
}

/**
 * Whether the running door is new enough for its answers to mean what this
 * probe reads them as.
 *
 * A daemon built before a field was reported answers a menu of perfectly good
 * routes without it, and a probe reading only "is any row vision?" calls that
 * "nothing to prove" and exits 0 -- the same silence this probe exists to end.
 *
 * Read from the door's own `contract` rather than guessed from whether any
 * row happens to carry a `role`. That guess was wrong for a legitimate
 * config: whisper, tts and comfy routes carry no role at all, so a box
 * serving only those looked like a stale daemon and failed weekly for a
 * defect that was not there.
 */
async function staleDoorLine(
  doorUrl: string,
  fetchImpl: typeof fetch,
): Promise<ProbeLine | undefined> {
  let contract: unknown;
  try {
    const res = await fetchImpl(`${doorUrl}/engined/v1/engines`);
    if (!res.ok) {
      await discardBody(res);
      return {
        address: doorUrl,
        ok: false,
        detail: `the door answered http ${res.status} for its own engine list`,
      };
    }
    contract = ((await res.json()) as { contract?: unknown }).contract;
  } catch (err) {
    return {
      address: doorUrl,
      ok: false,
      detail: `the door could not be reached: ${errMessage(err)}`,
    };
  }
  if (contract === CONTRACT) {
    return undefined;
  }
  return {
    address: doorUrl,
    ok: false,
    detail: `the running door reports contract ${String(contract)}; this probe ships with ${CONTRACT}. It predates this build -- run scripts/install.sh to bring the daemon up to the bundle this probe ships with.`,
  };
}

/**
 * Every vision address the door lists, probed in turn.
 *
 * `role` is what makes this discoverable at all -- chat and vision answer the
 * same door path, so `serves` cannot tell them apart. An address that is not
 * `installed` is left alone: `GET /engined/v1/engines` already reports why,
 * with the literal command that fixes it, and a probe repeating that in a
 * different voice adds nothing.
 *
 * A door with no vision address at all is not a failure. Nothing is
 * configured to be wrong, and the report says exactly that rather than
 * reporting a pass it did not earn.
 */
export async function runProbes(
  doorUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeReport> {
  let rows: MenuRow[];
  try {
    const menu = await fetchImpl(`${doorUrl}/openai/v1/models`);
    if (!menu.ok) {
      await discardBody(menu);
      return {
        ok: false,
        lines: [
          {
            address: doorUrl,
            ok: false,
            detail: `the door answered http ${menu.status} for its own model menu`,
          },
        ],
      };
    }
    const body = (await menu.json()) as { data?: MenuRow[] };
    rows = body.data ?? [];
  } catch (err) {
    const message = errMessage(err);
    return {
      ok: false,
      lines: [{ address: doorUrl, ok: false, detail: `the door could not be reached: ${message}` }],
    };
  }

  const stale = await staleDoorLine(doorUrl, fetchImpl);
  if (stale !== undefined) {
    return { ok: false, lines: [stale] };
  }

  const lines = [
    ...(await probeVision(doorUrl, rows, fetchImpl)),
    ...(await probeRerank(doorUrl, rows, fetchImpl)),
    ...(await probeTranslations(doorUrl, rows, fetchImpl)),
  ];
  // One line for a door with nothing configured to prove, rather than one per
  // family saying the same thing: nothing here is wrong, and a report that
  // says so three times buries the one run where something is.
  if (lines.length === 0) {
    return {
      ok: true,
      lines: [{ address: doorUrl, ok: true, detail: "no installed address to prove" }],
    };
  }
  return { ok: lines.every((l) => l.ok), lines };
}

/** Every vision address the door lists, each sent the ground-truth check its own `vision` kind can answer. */
async function probeVision(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const vision = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === "vision" && r.state === "installed" && typeof r.id === "string",
  );
  if (vision.length === 0) {
    return [];
  }

  const lines: ProbeLine[] = [];
  for (const row of vision) {
    lines.push({ address: row.id, ...(await probeOne(doorUrl, row, fetchImpl)) });
  }
  return lines;
}

/**
 * The rerank ground truth: one query and three documents, exactly one of
 * which answers it. A working reranker puts that one first -- results come
 * back ordered best-first, so the check is on `results[0].index`.
 *
 * Built here rather than read from a fixture for the same reason the vision
 * image is: the expected answer has to be known by construction. Measured on
 * Qwen3-Reranker-0.6B-seq-cls, the relevant document scored 0.907 against
 * 7.8e-11 and 4.9e-11, so a model that is working clears this by orders of
 * magnitude and one that is not cannot land on it by chance.
 */
const RERANK_QUERY = "How do I stop a running container?";
const RERANK_DOCUMENTS = [
  "Bananas ripen faster when kept in a paper bag.",
  "Run docker stop followed by the container name.",
  "The Treaty of Utrecht was signed in 1713.",
];
/** The index into `RERANK_DOCUMENTS` that answers `RERANK_QUERY`. */
const RERANK_ANSWER = 1;

async function probeRerank(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const rerank = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === "rerank" && r.state === "installed" && typeof r.id === "string",
  );
  if (rerank.length === 0) {
    return [];
  }
  const lines: ProbeLine[] = [];
  for (const row of rerank) {
    lines.push({ address: row.id, ...(await probeOneRerank(doorUrl, row.id, fetchImpl)) });
  }
  return lines;
}

async function probeOneRerank(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchImpl(`${doorUrl}${CONTENT_ENDPOINT_RERANK}`, {
      method: "POST",
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({
        model: address,
        query: RERANK_QUERY,
        documents: RERANK_DOCUMENTS,
      }),
    });
    if (!res.ok) {
      return {
        ok: false,
        detail: `http ${res.status}: ${(await res.text()).slice(0, ERROR_BODY_CHARS)}`,
      };
    }
    const body = (await res.json()) as { results?: { index?: unknown }[] };
    const top = body.results?.[0]?.index;
    if (typeof top !== "number") {
      return { ok: false, detail: "the reply carried no ranked results" };
    }
    return top === RERANK_ANSWER
      ? { ok: true, detail: `ranked the answering document first (index ${top})` }
      : {
          ok: false,
          detail: `ranked index ${top} first; the document answering the query is index ${RERANK_ANSWER}`,
        };
  } catch (err) {
    return { ok: false, detail: errMessage(err) };
  }
}

/**
 * The ground-truth check this route's model can actually answer.
 *
 * A `vision` role says the route takes an image; it does not say what the
 * model does with one. `describe` reads a scene back and is checked on naming
 * two colours in order; `read` recognises characters and is checked on reading
 * a freshly generated string back. Sending either check to the other model
 * fails a model that is working -- measured against PaddleOCR-VL, which
 * answers the colour question with degenerate repetition.
 */
function checkFor(row: MenuRow & { id: string }):
  | {
      body: string;
      verdict: (reply: string) => { ok: boolean; detail: string };
    }
  | undefined {
  if (row.vision === "read") {
    const text = readProbeText();
    return {
      body: visionReadRequestBody(row.id, text),
      verdict: (reply) => visionReadVerdict(text, reply),
    };
  }
  if (row.vision === "describe") {
    return { body: visionRequestBody(row.id), verdict: visionVerdict };
  }
  // Config requires a kind on every vision route, so a row without one came
  // from a door older than that rule. Guessing here is what this whole module
  // exists to stop: the wrong guess fails a working model and reads as a
  // vision defect.
  return undefined;
}

async function probeOne(
  doorUrl: string,
  row: MenuRow & { id: string },
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const check = checkFor(row);
  if (check === undefined) {
    return {
      ok: false,
      detail:
        "the running door reports no `vision` kind for this address, so there is no way to tell which check it can answer. It predates this probe -- run scripts/install.sh to bring the daemon up to the bundle this probe ships with.",
    };
  }
  try {
    const res = await fetchImpl(`${doorUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: check.body,
    });
    if (!res.ok) {
      return {
        ok: false,
        detail: `http ${res.status}: ${(await res.text()).slice(0, ERROR_BODY_CHARS)}`,
      };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return check.verdict(body.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    return { ok: false, detail: errMessage(err) };
  }
}

/**
 * The translations guard, which is the half of that verb with a ground truth.
 *
 * Translation *quality* is deliberately not probed: unlike an image, speech
 * in a known foreign language cannot be generated in code here, so there is
 * nothing to check a translated transcript against. What can be checked is
 * the failure this door was built to prevent -- an English-only model handed
 * the translate flag does not error, it transcribes and returns something
 * that reads like a translation. So the guard is that a route which does NOT
 * declare `translate` is refused, and it is checked against every such route
 * the menu lists.
 *
 * No audio is decoded: the refusal happens at dispatch, before the upload
 * reaches an engine, so a few bytes standing in for a recording is enough and
 * the probe costs no model load at all.
 */
async function probeTranslations(
  doorUrl: string,
  rows: readonly MenuRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const englishOnly = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === undefined &&
      r.translate !== true &&
      r.state === "installed" &&
      typeof r.id === "string" &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS),
  );
  if (englishOnly.length === 0) {
    return [];
  }
  const lines: ProbeLine[] = [];
  for (const row of englishOnly) {
    lines.push({ address: row.id, ...(await probeOneRefusal(doorUrl, row.id, fetchImpl)) });
  }
  return lines;
}

/** A few bytes standing in for a recording: enough to pass the upload check, never enough to be decoded, because the refusal lands first. */
const NOT_REALLY_AUDIO = new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0]);

async function probeOneRefusal(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const form = new FormData();
  form.append("file", new Blob([NOT_REALLY_AUDIO]), "probe.wav");
  form.append("model", address);
  try {
    const res = await fetchImpl(`${doorUrl}${CONTENT_ENDPOINT_TRANSLATIONS}`, {
      method: "POST",
      body: form,
    });
    const text = await res.text();
    if (res.status === STATUS_BAD_REQUEST) {
      return { ok: true, detail: "refused to translate, as a route not declaring it must" };
    }
    return {
      ok: false,
      detail: `answered http ${res.status} instead of refusing to translate: ${text.slice(0, ERROR_BODY_CHARS)}`,
    };
  } catch (err) {
    return { ok: false, detail: errMessage(err) };
  }
}
