/**
 * Reads a GGUF file's own metadata (the key/value header every llama.cpp
 * consumer already trusts) without touching the tensor data that follows
 * it -- the weights `/engined/v1/tokenize` exists to avoid loading. The
 * format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

import { open } from 'node:fs/promises'

const MAGIC = 0x46_55_47_47 // "GGUF" read little-endian as a u32
const UINT32_BYTES = 4
const UINT64_BYTES = 8
const KIBIBYTE = 1024
const MEBIBYTE = KIBIBYTE * KIBIBYTE

const GgufValueType = {
  Uint8: 0,
  Int8: 1,
  Uint16: 2,
  Int16: 3,
  Uint32: 4,
  Int32: 5,
  Float32: 6,
  Bool: 7,
  String: 8,
  Array: 9,
  Uint64: 10,
  Int64: 11,
  Float64: 12,
} as const
type GgufValueType = (typeof GgufValueType)[keyof typeof GgufValueType]

/** Thrown internally when the buffered prefix ran out mid-parse; `readGgufMetadata` retries with a bigger one. A sentinel rather than an `Error` subclass, so this file declares only the one class (`Cursor`) `noExcessiveClassesPerFile` allows. */
const NEED_MORE_BYTES = Symbol('gguf-need-more-bytes')

/** The handful of keys `bpeVocab.ts` actually reads. Every other key is skipped without allocating its value. */
export interface GgufMetadata {
  architecture?: string
  /** `tokenizer.ggml.model`: "gpt2" for byte-level BPE, "llama" for SentencePiece -- the two this file's tables distinguish. */
  tokenizerModel?: string
  /** `tokenizer.ggml.pre`: which pretokenizer regex a BPE vocab was built with, e.g. "qwen35". Absent on a non-BPE vocab. */
  tokenizerPre?: string
  tokens?: string[]
  merges?: string[]
  /** `<architecture>.context_length`: the window the model was trained for. */
  contextLength?: number
  /** `general.file_type`, llama.cpp's quantization enum. */
  fileType?: number
  /** `fileType` as its quantization name, for example "Q4_K_M"; absent for a value this table does not name. */
  quantization?: string
  /** Whether the file ships a `tokenizer.chat_template`; its text is not read. */
  hasChatTemplate: boolean
  /** Bytes on disk, tensors included. */
  sizeBytes: number
}

/** llama.cpp's `llama_ftype` values that appear in files; the removed 4-6 are absent. */
const FILE_TYPE_NAMES: Record<number, string> = {
  0: 'F32',
  1: 'F16',
  2: 'Q4_0',
  3: 'Q4_1',
  7: 'Q8_0',
  8: 'Q5_0',
  9: 'Q5_1',
  10: 'Q2_K',
  11: 'Q3_K_S',
  12: 'Q3_K_M',
  13: 'Q3_K_L',
  14: 'Q4_K_S',
  15: 'Q4_K_M',
  16: 'Q5_K_S',
  17: 'Q5_K_M',
  18: 'Q6_K',
  19: 'IQ2_XXS',
  20: 'IQ2_XS',
  21: 'Q2_K_S',
  22: 'IQ3_XS',
  23: 'IQ3_XXS',
  24: 'IQ1_S',
  25: 'IQ4_NL',
  26: 'IQ3_S',
  27: 'IQ3_M',
  28: 'IQ2_S',
  29: 'IQ2_M',
  30: 'IQ4_XS',
  31: 'IQ1_M',
  32: 'BF16',
  36: 'TQ1_0',
  37: 'TQ2_0',
  38: 'MXFP4_MOE',
}

const WANTED_KEYS = new Set([
  'general.architecture',
  'tokenizer.ggml.model',
  'tokenizer.ggml.pre',
  'tokenizer.ggml.tokens',
  'tokenizer.ggml.merges',
  'general.file_type',
])
const CHAT_TEMPLATE_KEY = 'tokenizer.chat_template'
const CONTEXT_LENGTH_SUFFIX = '.context_length'

const FIXED_TYPE_SIZES: Partial<Record<GgufValueType, number>> = {
  [GgufValueType.Uint8]: 1,
  [GgufValueType.Int8]: 1,
  [GgufValueType.Uint16]: 2,
  [GgufValueType.Int16]: 2,
  [GgufValueType.Uint32]: 4,
  [GgufValueType.Int32]: 4,
  [GgufValueType.Float32]: 4,
  [GgufValueType.Bool]: 1,
  [GgufValueType.Uint64]: 8,
  [GgufValueType.Int64]: 8,
  [GgufValueType.Float64]: 8,
}

/** A cursor over one buffered prefix of the file; throws `NeedMoreBytesError` rather than reading past what was buffered. */
class Cursor {
  private pos = 0
  private readonly buf: Buffer
  constructor(buf: Buffer) {
    this.buf = buf
  }

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw NEED_MORE_BYTES
    }
  }

  u32(): number {
    this.need(UINT32_BYTES)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += UINT32_BYTES
    return v
  }

  u64(): number {
    this.need(UINT64_BYTES)
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += UINT64_BYTES
    // Every length and count read here (string bytes, array elements, kv
    // count) fits a real GGUF's metadata comfortably under 2^53 -- this file
    // reads no tensor offsets, which is the only field wide enough to need
    // the full 64 bits.
    return Number(v)
  }

  str(): string {
    const len = this.u64()
    this.need(len)
    const s = this.buf.toString('utf8', this.pos, this.pos + len)
    this.pos += len
    return s
  }

  /** An unsigned or signed integer of `type`, as a number; the only widths a window or enum needs. */
  integer(type: GgufValueType): number {
    switch (type) {
      case GgufValueType.Uint32:
        return this.u32()
      case GgufValueType.Int32: {
        this.need(UINT32_BYTES)
        const v = this.buf.readInt32LE(this.pos)
        this.pos += UINT32_BYTES
        return v
      }
      case GgufValueType.Uint64:
      case GgufValueType.Int64:
        return this.u64()
      default:
        throw new Error(`GGUF value type ${type} is not an integer this reader decodes`)
    }
  }

  /** Advances past a value of a fixed-size scalar type without decoding it. */
  skipFixed(size: number): void {
    this.need(size)
    this.pos += size
  }
}

/** Reads one value of `type`, decoding strings and the two array shapes this door cares about; every other value is skipped. */
function readValue(c: Cursor, type: GgufValueType, want: boolean): unknown {
  if (type === GgufValueType.String) {
    return c.str()
  }
  if (type === GgufValueType.Array) {
    const elemType = c.u32() as GgufValueType
    const count = c.u64()
    if (!want) {
      for (let i = 0; i < count; i++) {
        readValue(c, elemType, false)
      }
      return undefined
    }
    const out: unknown[] = []
    for (let i = 0; i < count; i++) {
      out.push(readValue(c, elemType, true))
    }
    return out
  }
  if (want && INTEGER_TYPES.has(type)) {
    return c.integer(type)
  }
  const size = FIXED_TYPE_SIZES[type]
  if (size === undefined) {
    throw new Error(`unknown GGUF value type ${type}`)
  }
  c.skipFixed(size)
  return undefined
}

const INTEGER_TYPES: ReadonlySet<GgufValueType> = new Set([
  GgufValueType.Uint32,
  GgufValueType.Int32,
  GgufValueType.Uint64,
  GgufValueType.Int64,
])

function parse(buf: Buffer, sizeBytes: number): GgufMetadata {
  const c = new Cursor(buf)
  if (c.u32() !== MAGIC) {
    throw new Error('not a GGUF file (bad magic)')
  }
  c.u32() // version, unused
  c.u64() // tensor_count -- the metadata this door reads ends before tensor data
  const kvCount = c.u64()

  const out: GgufMetadata = { hasChatTemplate: false, sizeBytes }
  // The architecture key need not come first, so every window is kept and the right one picked after.
  const windows = new Map<string, number>()
  for (let i = 0; i < kvCount; i++) {
    const key = c.str()
    const type = c.u32() as GgufValueType
    const isWindow = key.endsWith(CONTEXT_LENGTH_SUFFIX)
    const want = WANTED_KEYS.has(key) || isWindow
    const value = readValue(c, type, want)
    if (key === CHAT_TEMPLATE_KEY) {
      out.hasChatTemplate = true
    }
    if (!want) {
      continue
    }
    if (isWindow) {
      windows.set(key, value as number)
      continue
    }
    switch (key) {
      case 'general.file_type':
        out.fileType = value as number
        out.quantization = FILE_TYPE_NAMES[value as number]
        break
      case 'general.architecture':
        out.architecture = value as string
        break
      case 'tokenizer.ggml.model':
        out.tokenizerModel = value as string
        break
      case 'tokenizer.ggml.pre':
        out.tokenizerPre = value as string
        break
      case 'tokenizer.ggml.tokens':
        out.tokens = value as string[]
        break
      case 'tokenizer.ggml.merges':
        out.merges = value as string[]
        break
      default:
        break
    }
  }
  out.contextLength = windows.get(`${out.architecture}${CONTEXT_LENGTH_SUFFIX}`)
  return out
}

/**
 * A vocab of this size fits comfortably in a few MiB even at 250k tokens and
 * a quarter-million merge rules -- this cap is only ever hit by a metadata
 * section that is not what this door expects, not by a real vocab growing.
 * ponytail: fixed *4 growth instead of a real streaming cursor; raise the cap
 * or switch to incremental reads if a model's metadata ever legitimately
 * exceeds it.
 */
const INITIAL_METADATA_READ_MEBIBYTES = 16
const MAX_METADATA_READ_MEBIBYTES = 256
const METADATA_READ_GROWTH_FACTOR = 4
const INITIAL_BYTES = INITIAL_METADATA_READ_MEBIBYTES * MEBIBYTE
const MAX_BYTES = MAX_METADATA_READ_MEBIBYTES * MEBIBYTE

/** Reads `path`'s GGUF key/value metadata, growing the buffered prefix until the whole metadata section fits or `MAX_BYTES` is exhausted. Never reads the tensor data that follows. */
export async function readGgufMetadata(path: string): Promise<GgufMetadata> {
  const handle = await open(path, 'r')
  try {
    const { size: sizeBytes } = await handle.stat()
    for (let size = INITIAL_BYTES; size <= MAX_BYTES; ) {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buf, 0, size, 0)
      try {
        return parse(buf.subarray(0, bytesRead), sizeBytes)
      } catch (err) {
        if (err !== NEED_MORE_BYTES || bytesRead < size) {
          throw err
        }
      }
      if (size === MAX_BYTES) {
        break
      }
      size = Math.min(size * METADATA_READ_GROWTH_FACTOR, MAX_BYTES)
    }
    throw new Error(`${path}: GGUF metadata exceeds ${MAX_BYTES} bytes`)
  } finally {
    await handle.close()
  }
}
