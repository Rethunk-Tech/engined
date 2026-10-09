/**
 * The two images a vision probe asks a model about, synthesised here rather
 * than shipped as fixtures: a split-colour field, and rendered digits the
 * model must read back. A PNG encoder small enough to carry is cheaper than a
 * binary asset nothing else needs.
 */

import { crc32, deflateSync } from 'node:zlib'
import { ENGINE_ERROR_CHARS, STATUS_BAD_REQUEST } from './http.ts'
import { errMessage } from './records.ts'
import { CONTENT_ENDPOINT_TRANSCRIPTIONS, CONTENT_ENDPOINT_TRANSLATIONS } from './routeServes.ts'

/** PNG's own field widths, which the format fixes and this encoder cannot choose: a chunk's length and CRC are 4 bytes each, and IHDR's payload is 13. */
const PNG_LENGTH_BYTES = 4
const PNG_CRC_BYTES = 4
const PNG_IHDR_BYTES = 13

/** Where IHDR's height sits, immediately after its 4-byte width. */
const IHDR_HEIGHT_OFFSET = 4

/** IHDR's tail after width and height: 8-bit depth, colour type 2 (RGB), then the deflate/filter/interlace defaults, which are the only values this encoder emits. */
const IHDR_BIT_DEPTH = 8
const IHDR_COLOR_TYPE_RGB = 2
const IHDR_COMPRESSION_DEFAULT = 0
const IHDR_FILTER_DEFAULT = 0
const IHDR_INTERLACE_NONE = 0
const IHDR_TAIL = [
  IHDR_BIT_DEPTH,
  IHDR_COLOR_TYPE_RGB,
  IHDR_COMPRESSION_DEFAULT,
  IHDR_FILTER_DEFAULT,
  IHDR_INTERLACE_NONE,
]
const IHDR_TAIL_OFFSET = 8

/** One RGB pixel, and the leading filter-type-0 byte every scanline carries. */
const RGB_BYTES = 3
const SCANLINE_FILTER_BYTES = 1

/** The 8 bytes every PNG opens with. */
const PNG_SIG_BYTE_MAGIC = 0x89
const PNG_SIG_BYTE_P = 0x50
const PNG_SIG_BYTE_N = 0x4e
const PNG_SIG_BYTE_G = 0x47
const PNG_SIG_BYTE_CR = 0x0d
const PNG_SIG_BYTE_LF = 0x0a
const PNG_SIG_BYTE_CTRL_Z = 0x1a
const PNG_SIGNATURE = [
  PNG_SIG_BYTE_MAGIC,
  PNG_SIG_BYTE_P,
  PNG_SIG_BYTE_N,
  PNG_SIG_BYTE_G,
  PNG_SIG_BYTE_CR,
  PNG_SIG_BYTE_LF,
  PNG_SIG_BYTE_CTRL_Z,
  PNG_SIG_BYTE_LF,
]

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
const DIGIT_GLYPHS: readonly string[][] = [
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
 * PaddleOCR-VL answers with degenerate repetition. This is the
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
const SPLIT_PROBE_RED_CHANNEL = 220
const SPLIT_PROBE_LOW_CHANNEL = 20
const SPLIT_PROBE_BLUE_CHANNEL = 220
const SPLIT_PNG_LEFT = [
  SPLIT_PROBE_RED_CHANNEL,
  SPLIT_PROBE_LOW_CHANNEL,
  SPLIT_PROBE_LOW_CHANNEL,
] as const
const SPLIT_PNG_RIGHT = [
  SPLIT_PROBE_LOW_CHANNEL,
  SPLIT_PROBE_LOW_CHANNEL,
  SPLIT_PROBE_BLUE_CHANNEL,
] as const

/** Red on the left, blue on the right. */
const SPLIT_PNG_DATA_URI = `data:image/png;base64,${Buffer.from(splitColorPng(SPLIT_PNG_SIZE, SPLIT_PNG_LEFT, SPLIT_PNG_RIGHT)).toString('base64')}`

/** Two words is the whole answer this asks for; anything longer is tokens spent on prose the verdict discards. */
const VISION_MAX_TOKENS = 16

/** The chat body that asks for exactly what `visionVerdict` reads back, and nothing else worth paying tokens for. */
export function visionRequestBody(modelId: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'This image has two vertical halves. Name the color of the left half, then the color of the right half. Answer with two words.',
          },
          { type: 'image_url', image_url: { url: SPLIT_PNG_DATA_URI } },
        ],
      },
    ],
    max_tokens: VISION_MAX_TOKENS,
  })
}

const READ_PROBE_DIGITS = 8

/** A fresh string per run, so no answer can come from having seen this image before. */
export function readProbeText(): string {
  return Array.from({ length: READ_PROBE_DIGITS }, () =>
    String(Math.floor(Math.random() * DIGIT_GLYPHS.length)),
  ).join('')
}

const READ_MAX_TOKENS = 64

export function visionReadRequestBody(modelId: string, text: string): string {
  return JSON.stringify({
    model: modelId,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Read the digits in this image. Answer with the digits only.' },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/png;base64,${Buffer.from(digitsPng(text)).toString('base64')}`,
            },
          },
        ],
      },
    ],
    max_tokens: READ_MAX_TOKENS,
  })
}

const NON_DIGITS = /\D+/g

export function visionReadVerdict(
  expected: string,
  reply: string,
): { ok: boolean; detail: string } {
  const seen = reply.replace(NON_DIGITS, '')
  if (!seen.includes(expected)) {
    return { ok: false, detail: `expected ${expected}, read ${JSON.stringify(reply)}` }
  }
  return { ok: true, detail: `read ${expected}` }
}

export function visionVerdict(reply: string): { ok: boolean; detail: string } {
  const seen = reply.toLowerCase()
  const red = seen.indexOf('red')
  const blue = seen.indexOf('blue')
  if (red < 0 || blue < 0) {
    return {
      ok: false,
      detail: `named ${red < 0 ? 'no red' : 'no blue'}: ${JSON.stringify(reply)}`,
    }
  }
  if (red > blue) {
    return { ok: false, detail: `named the halves in the wrong order: ${JSON.stringify(reply)}` }
  }
  return { ok: true, detail: JSON.stringify(reply) }
}

const RIFF_ASCII_R = 0x52
const RIFF_ASCII_I = 0x49
const RIFF_ASCII_F = 0x46
const RIFF_WAVEFORM_SIZE_PLACEHOLDER = 0
const NOT_REALLY_AUDIO = new Uint8Array([
  RIFF_ASCII_R,
  RIFF_ASCII_I,
  RIFF_ASCII_F,
  RIFF_ASCII_F,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
  RIFF_WAVEFORM_SIZE_PLACEHOLDER,
])

interface TranslationProbeRow {
  id?: unknown
  role?: unknown
  translate?: unknown
  state?: unknown
  serves?: unknown
}

interface ProbeLine {
  address: string
  ok: boolean
  detail: string
}

function canAnswer(state: unknown): boolean {
  return typeof state === 'string' && state !== 'unavailable'
}

async function probeOneRefusal(
  doorUrl: string,
  address: string,
  fetchImpl: typeof fetch,
): Promise<{ ok: boolean; detail: string }> {
  const form = new FormData()
  form.append('file', new Blob([NOT_REALLY_AUDIO]), 'probe.wav')
  form.append('model', address)
  try {
    const res = await fetchImpl(`${doorUrl}${CONTENT_ENDPOINT_TRANSLATIONS}`, {
      method: 'POST',
      body: form,
    })
    const text = await res.text()
    if (res.status === STATUS_BAD_REQUEST) {
      return { ok: true, detail: 'refused to translate, as a route not declaring it must' }
    }
    return {
      ok: false,
      detail: `answered http ${res.status} instead of refusing to translate: ${text.slice(0, ENGINE_ERROR_CHARS)}`,
    }
  } catch (err) {
    return { ok: false, detail: errMessage(err) }
  }
}

/** English-only transcription routes must refuse `/translations` before any model loads. */
export async function probeTranslations(
  doorUrl: string,
  rows: readonly TranslationProbeRow[],
  fetchImpl: typeof fetch,
): Promise<ProbeLine[]> {
  const englishOnly = rows.filter(
    (r): r is TranslationProbeRow & { id: string } =>
      r.role === undefined &&
      r.translate !== true &&
      canAnswer(r.state) &&
      typeof r.id === 'string' &&
      Array.isArray(r.serves) &&
      r.serves.includes(CONTENT_ENDPOINT_TRANSCRIPTIONS),
  )
  if (englishOnly.length === 0) {
    return []
  }
  const lines: ProbeLine[] = []
  for (const row of englishOnly) {
    lines.push({ address: row.id, ...(await probeOneRefusal(doorUrl, row.id, fetchImpl)) })
  }
  return lines
}
