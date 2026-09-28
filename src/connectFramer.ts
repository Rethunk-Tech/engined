import { gunzipSync } from 'node:zlib'
import { ENVELOPE_HEADER } from './cursorProto.ts'

/**
 * Connect sets the low bit of a frame's flag byte when the payload is
 * compressed, and the client only compresses once a turn is big enough --
 * which is why short prompts work against a decoder that ignores it and a
 * real brief does not.
 */
const FLAG_COMPRESSED = 1

/** A Connect frame larger than this is a runaway, not a turn. */
const MAX_CONNECT_FRAME = 16 * 1024 * 1024

function concatChunks(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

function peekEnvelope(chunks: Uint8Array[]): { flags: number; length: number } | undefined {
  let have = 0
  for (const part of chunks) {
    have += part.length
  }
  if (have < ENVELOPE_HEADER) {
    return undefined
  }
  const header = new Uint8Array(ENVELOPE_HEADER)
  let at = 0
  for (const part of chunks) {
    const n = Math.min(part.length, ENVELOPE_HEADER - at)
    header.set(part.subarray(0, n), at)
    at += n
    if (at >= ENVELOPE_HEADER) {
      break
    }
  }
  return {
    flags: header[0] ?? 0,
    length: new DataView(header.buffer).getUint32(1, false),
  }
}

/** Split a stream's bytes into Connect envelopes as they arrive. */
export function framer(onFrame: (payload: Uint8Array) => void): (chunk: Uint8Array) => void {
  const chunks: Uint8Array[] = []
  let buffered = 0
  return (chunk: Uint8Array) => {
    chunks.push(chunk)
    buffered += chunk.length
    for (;;) {
      const head = peekEnvelope(chunks)
      if (head === undefined) {
        return
      }
      if (head.length > MAX_CONNECT_FRAME) {
        throw new Error(`connect frame exceeds ${MAX_CONNECT_FRAME} bytes`)
      }
      if (buffered < ENVELOPE_HEADER + head.length) {
        return
      }
      const joined = concatChunks(chunks)
      const payload = joined.subarray(ENVELOPE_HEADER, ENVELOPE_HEADER + head.length)
      const rest = joined.subarray(ENVELOPE_HEADER + head.length)
      chunks.length = 0
      buffered = rest.length
      if (rest.length > 0) {
        chunks.push(rest)
      }
      onFrame(
        head.flags % 2 === FLAG_COMPRESSED
          ? new Uint8Array(gunzipSync(payload, { maxOutputLength: MAX_CONNECT_FRAME }))
          : payload,
      )
    }
  }
}
