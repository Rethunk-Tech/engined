/**
 * The vision-fidelity probe, and the image it sends.
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
 * drives the router directly, and `main.js --vision-probe`, which the
 * installed timer runs against the live door. A second copy of a PNG encoder
 * is the kind of drift this repo keeps getting bitten by.
 */

import { crc32, deflateSync } from "node:zlib";

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
  const ihdr = Buffer.alloc(PNG_IHDR_BYTES);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, IHDR_HEIGHT_OFFSET);
  ihdr.set(IHDR_TAIL, IHDR_TAIL_OFFSET);
  const row = Buffer.alloc(SCANLINE_FILTER_BYTES + size * RGB_BYTES);
  for (let x = 0; x < size; x++) {
    row.set(x < size / 2 ? left : right, SCANLINE_FILTER_BYTES + x * RGB_BYTES);
  }
  const raw = Buffer.concat(new Array(size).fill(row));
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 64px square: large enough that the halves are unmistakable, small enough that the data URI stays a few hundred bytes of prompt. */
const SPLIT_PNG_SIZE = 64;
/** Two hues no description confuses for one another, at full saturation so neither reads as a shade of the other. */
const SPLIT_PNG_LEFT = [220, 20, 20] as const;
const SPLIT_PNG_RIGHT = [20, 20, 220] as const;

/** Red on the left, blue on the right. */
export const SPLIT_PNG_DATA_URI = `data:image/png;base64,${Buffer.from(splitColorPng(SPLIT_PNG_SIZE, SPLIT_PNG_LEFT, SPLIT_PNG_RIGHT)).toString("base64")}`;

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
export interface VisionProbeLine {
  address: string;
  ok: boolean;
  detail: string;
}

export interface VisionProbeReport {
  /** False only when a vision address answered and got it wrong, or could not be reached at all. A door offering no vision address is `true` with one line saying so. */
  ok: boolean;
  lines: VisionProbeLine[];
}

/** The subset of a `/openai/v1/models` row this probe reads. Parsed from the wire, so it is narrowed here rather than imported: a row is whatever the running door sent, not whatever this build's `ModelRow` says. */
interface MenuRow {
  id?: unknown;
  role?: unknown;
  state?: unknown;
}

/**
 * Whether this menu comes from a door that knows what `role` is at all.
 *
 * Measured against the live install: a daemon built before `role` was reported
 * answers a menu of perfectly good vision routes with no `role` on any of them,
 * and a probe reading only "is any row vision?" calls that "nothing to prove"
 * and exits 0. That is the same silence this probe exists to end, so a menu
 * with rows and no roles anywhere is a stale door, not an idle one.
 */
function menuReportsRole(rows: readonly MenuRow[]): boolean {
  return rows.some((r) => typeof r.role === "string");
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
export async function runVisionProbe(
  doorUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<VisionProbeReport> {
  let rows: MenuRow[];
  try {
    const menu = await fetchImpl(`${doorUrl}/openai/v1/models`);
    if (!menu.ok) {
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
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      lines: [{ address: doorUrl, ok: false, detail: `the door could not be reached: ${message}` }],
    };
  }

  const vision = rows.filter(
    (r): r is MenuRow & { id: string } =>
      r.role === "vision" && r.state === "installed" && typeof r.id === "string",
  );
  if (vision.length === 0) {
    if (rows.length > 0 && !menuReportsRole(rows)) {
      return {
        ok: false,
        lines: [
          {
            address: doorUrl,
            ok: false,
            detail:
              "the running door reports no `role` on any row, so no vision address can be found. It predates this probe -- run scripts/install.sh to bring the daemon up to the bundle this probe ships with.",
          },
        ],
      };
    }
    return {
      ok: true,
      lines: [{ address: doorUrl, ok: true, detail: "no installed vision address to prove" }],
    };
  }

  const lines: VisionProbeLine[] = [];
  for (const row of vision) {
    lines.push({ address: row.id, ...(await probeOne(doorUrl, row.id, fetchImpl)) });
  }
  return { ok: lines.every((l) => l.ok), lines };
}

async function probeOne(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetchImpl(`${doorUrl}/openai/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: visionRequestBody(address),
    });
    if (!res.ok) {
      return {
        ok: false,
        detail: `http ${res.status}: ${(await res.text()).slice(0, ERROR_BODY_CHARS)}`,
      };
    }
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return visionVerdict(body.choices?.[0]?.message?.content ?? "");
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
