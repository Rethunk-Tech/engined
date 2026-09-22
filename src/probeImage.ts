/**
 * The two images a vision probe asks a model about, synthesised here rather
 * than shipped as fixtures: a split-colour field, and rendered digits the
 * model must read back. A PNG encoder small enough to carry is cheaper than a
 * binary asset nothing else needs.
 */

import { crc32, deflateSync } from 'node:zlib'

/** PNG's own field widths, which the format fixes and this encoder cannot choose: a chunk's length and CRC are 4 bytes each, and IHDR's payload is 13. */
const PNG_LENGTH_BYTES = 4
const PNG_CRC_BYTES = 4
const PNG_IHDR_BYTES = 13

/** Where IHDR's height sits, immediately after its 4-byte width. */
const IHDR_HEIGHT_OFFSET = 4

/** IHDR's tail after width and height: 8-bit depth, colour type 2 (RGB), then the deflate/filter/interlace defaults, which are the only values this encoder emits. */
const IHDR_TAIL = [8, 2, 0, 0, 0]
const IHDR_TAIL_OFFSET = 8

/** One RGB pixel, and the leading filter-type-0 byte every scanline carries. */
const RGB_BYTES = 3
const SCANLINE_FILTER_BYTES = 1

/** The 8 bytes every PNG opens with. */
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10]

/** One PNG chunk: length, 4-byte ASCII type, data, CRC32 over type+data. */
function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(PNG_LENGTH_BYTES)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(PNG_CRC_BYTES)
  crc.writeUInt32BE(Number(crc32(Buffer.concat([typeBytes, data]))), 0)
  return Buffer.concat([length, typeBytes, data, crc])
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
  const row = Buffer.alloc(SCANLINE_FILTER_BYTES + size * RGB_BYTES)
  for (let x = 0; x < size; x++) {
    row.set(x < size / 2 ? left : right, SCANLINE_FILTER_BYTES + x * RGB_BYTES)
  }
  return encodePng(size, size, Buffer.concat(new Array(size).fill(row)))
}

/** Wraps already-filtered scanlines (each one a leading filter-type-0 byte then RGB triples) as a PNG. */
function encodePng(width: number, height: number, raw: Buffer): Uint8Array {
  const ihdr = Buffer.alloc(PNG_IHDR_BYTES)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, IHDR_HEIGHT_OFFSET)
  ihdr.set(IHDR_TAIL, IHDR_TAIL_OFFSET)
  return Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * A 5x7 bitmap per digit, one string per scanline. Digits only, and that is
 * the point: a `read` probe needs a string no model could have memorised, so
 * it is generated per run, and ten glyphs is the whole alphabet that needs.
 * Letters would add glyphs without adding proof.
 */
export const DIGIT_GLYPHS: readonly string[][] = [
  ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
]

const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
/** One blank glyph column between digits, so a reader does not run two together. */
const GLYPH_GAP = 1
/** Each glyph pixel becomes this many image pixels square. Small enough to stay a modest data URI, large enough that the strokes are not one pixel wide. */
const GLYPH_SCALE = 14
/** Quiet space around the string, in glyph pixels: text flush to the edge reads badly. */
const MARGIN = 2

const INK = 0
const PAPER = 255

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
  const cells = text.length * (GLYPH_WIDTH + GLYPH_GAP) - GLYPH_GAP + MARGIN * 2
  const width = cells * GLYPH_SCALE
  const height = (GLYPH_HEIGHT + MARGIN * 2) * GLYPH_SCALE
  const stride = SCANLINE_FILTER_BYTES + width * RGB_BYTES
  const raw = Buffer.alloc(stride * height, PAPER)
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0 // filter type 0, which the PAPER fill above overwrote
  }
  for (const [index, char] of [...text].entries()) {
    const glyph = DIGIT_GLYPHS[Number(char)]
    if (glyph === undefined) {
      continue
    }
    const originX = MARGIN + index * (GLYPH_WIDTH + GLYPH_GAP)
    for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
      for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
        if (glyph[gy]?.[gx] !== '1') {
          continue
        }
        paintCell(raw, stride, originX + gx, MARGIN + gy)
      }
    }
  }
  return encodePng(width, height, raw)
}

/** One glyph pixel, filled as a `GLYPH_SCALE`-square block of image pixels. */
function paintCell(raw: Buffer, stride: number, cellX: number, cellY: number): void {
  for (let y = 0; y < GLYPH_SCALE; y++) {
    const rowStart = (cellY * GLYPH_SCALE + y) * stride + SCANLINE_FILTER_BYTES
    for (let x = 0; x < GLYPH_SCALE; x++) {
      raw.fill(
        INK,
        rowStart + (cellX * GLYPH_SCALE + x) * RGB_BYTES,
        rowStart + (cellX * GLYPH_SCALE + x + 1) * RGB_BYTES,
      )
    }
  }
}

/** 64px square: large enough that the halves are unmistakable, small enough that the data URI stays a few hundred bytes of prompt. */
const SPLIT_PNG_SIZE = 64
/** Two hues no description confuses for one another, at full saturation so neither reads as a shade of the other. */
const SPLIT_PNG_LEFT = [220, 20, 20] as const
const SPLIT_PNG_RIGHT = [20, 20, 220] as const

/** Red on the left, blue on the right. */
export const SPLIT_PNG_DATA_URI = `data:image/png;base64,${Buffer.from(splitColorPng(SPLIT_PNG_SIZE, SPLIT_PNG_LEFT, SPLIT_PNG_RIGHT)).toString('base64')}`

/** Two words is the whole answer this asks for; anything longer is tokens spent on prose the verdict discards. */
export const VISION_MAX_TOKENS = 16
