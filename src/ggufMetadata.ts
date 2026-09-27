/**
 * Reads a GGUF file's own metadata (the key/value header every llama.cpp
 * consumer already trusts) without touching the tensor data that follows
 * it -- the weights `/engined/v1/tokenize` exists to avoid loading. The
 * format: https://github.com/ggml-org/ggml/blob/master/docs/gguf.md
 */

import { open } from 'node:fs/promises'

const MAGIC = 0x46_55_47_47 // "GGUF" read little-endian as a u32

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
}

const WANTED_KEYS = new Set([
  'general.architecture',
  'tokenizer.ggml.model',
  'tokenizer.ggml.pre',
  'tokenizer.ggml.tokens',
  'tokenizer.ggml.merges',
])

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
    this.need(4)
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  u64(): number {
    this.need(8)
    const v = this.buf.readBigUInt64LE(this.pos)
    this.pos += 8
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
  const size = FIXED_TYPE_SIZES[type]
  if (size === undefined) {
    throw new Error(`unknown GGUF value type ${type}`)
  }
  c.skipFixed(size)
  return undefined
}

function parse(buf: Buffer): GgufMetadata {
  const c = new Cursor(buf)
  if (c.u32() !== MAGIC) {
    throw new Error('not a GGUF file (bad magic)')
  }
  c.u32() // version, unused
  c.u64() // tensor_count -- the metadata this door reads ends before tensor data
  const kvCount = c.u64()

  const out: GgufMetadata = {}
  for (let i = 0; i < kvCount; i++) {
    const key = c.str()
    const type = c.u32() as GgufValueType
    const want = WANTED_KEYS.has(key)
    const value = readValue(c, type, want)
    if (!want) {
      continue
    }
    switch (key) {
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
const INITIAL_BYTES = 16 * 1024 * 1024
const MAX_BYTES = 256 * 1024 * 1024

/** Reads `path`'s GGUF key/value metadata, growing the buffered prefix until the whole metadata section fits or `MAX_BYTES` is exhausted. Never reads the tensor data that follows. */
export async function readGgufMetadata(path: string): Promise<GgufMetadata> {
  const handle = await open(path, 'r')
  try {
    for (let size = INITIAL_BYTES; size <= MAX_BYTES; ) {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buf, 0, size, 0)
      try {
        return parse(buf.subarray(0, bytesRead))
      } catch (err) {
        if (err !== NEED_MORE_BYTES || bytesRead < size) {
          throw err
        }
      }
      if (size === MAX_BYTES) {
        break
      }
      size = Math.min(size * 4, MAX_BYTES)
    }
    throw new Error(`${path}: GGUF metadata exceeds ${MAX_BYTES} bytes`)
  } finally {
    await handle.close()
  }
}
