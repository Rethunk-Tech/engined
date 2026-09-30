/**
 * The wire primitives Cursor's CLI speaks: protobuf varints and
 * length-delimited fields, and Connect's stream envelope.
 *
 * Only the two wire types the agent protocol actually uses are here --
 * varint and length-delimited. Nothing in `AgentServerMessage` or the boot
 * replies carries a fixed32/fixed64, so a full protobuf implementation would
 * be dead weight beside the handful of messages this door encodes.
 */

const CONTINUATION = 128
const GROUP = 128
const PROTOBUF_FIELD_KEY_SHIFT = 8
const WIRE_VARINT = 0
const WIRE_LENGTH = 2
/** Connect stream frames start with a flag byte and a 4-byte length. */
export const ENVELOPE_HEADER = 5

/** Connect marks the final frame of a stream with this flag. */
const FLAG_END_STREAM = 2

function varint(value: number): Uint8Array {
  const out: number[] = []
  let n = value
  do {
    const byte = n % GROUP
    n = Math.floor(n / GROUP)
    out.push(n > 0 ? byte + CONTINUATION : byte)
  } while (n > 0)
  return Uint8Array.from(out)
}

function tag(fieldNo: number, wire: number): Uint8Array {
  return varint(fieldNo * PROTOBUF_FIELD_KEY_SHIFT + wire)
}

/** A length-delimited field: a nested message or a `bytes` value. */
export function bytesField(fieldNo: number, payload: Uint8Array): Uint8Array {
  return Buffer.concat([tag(fieldNo, WIRE_LENGTH), varint(payload.length), payload])
}

export function stringField(fieldNo: number, value: string): Uint8Array {
  return bytesField(fieldNo, new TextEncoder().encode(value))
}

export function intField(fieldNo: number, value: number): Uint8Array {
  return Buffer.concat([tag(fieldNo, WIRE_VARINT), varint(value)])
}

export function message(...parts: Uint8Array[]): Uint8Array {
  return Buffer.concat(parts)
}

/**
 * One Connect stream frame: a flag byte, a big-endian length, the payload.
 * The same shape carries both a message and the end-of-stream marker, which
 * is why the flag is a parameter rather than two functions.
 */
export function envelope(payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER + payload.length)
  out[0] = flags
  new DataView(out.buffer).setUint32(1, payload.length, false)
  out.set(payload, ENVELOPE_HEADER)
  return out
}

export function endOfStream(): Uint8Array {
  return envelope(new TextEncoder().encode('{}'), FLAG_END_STREAM)
}

export interface Field {
  no: number
  value: number | Uint8Array
}

/** One varint at `at`: its value and the offset after it, or `undefined` when the buffer ends mid-varint. */
function readVarint(buf: Uint8Array, at: number): { value: number; next: number } | undefined {
  let value = 0
  let mul = 1
  for (let i = at; ; i += 1) {
    const byte = buf[i]
    if (byte === undefined) {
      return
    }
    value += (byte % GROUP) * mul
    if (byte < CONTINUATION) {
      return { value, next: i + 1 }
    }
    mul *= GROUP
  }
}

/**
 * Walk a message into its raw fields. The caller matches field numbers
 * against the schema it expects, because the wire format carries no names
 * and this door only ever reads a handful of known fields.
 */
export function decode(buf: Uint8Array): Field[] {
  const out: Field[] = []
  let i = 0
  while (i < buf.length) {
    const key = readVarint(buf, i)
    if (key === undefined) {
      return out
    }
    const no = Math.floor(key.value / PROTOBUF_FIELD_KEY_SHIFT)
    const wire = key.value % PROTOBUF_FIELD_KEY_SHIFT
    if (wire !== WIRE_LENGTH && wire !== WIRE_VARINT) {
      return out
    }
    const v = readVarint(buf, key.next)
    if (v === undefined) {
      return out
    }
    if (wire === WIRE_VARINT) {
      out.push({ no, value: v.value })
      i = v.next
    } else {
      out.push({ no, value: buf.subarray(v.next, v.next + v.value) })
      i = v.next + v.value
    }
  }
  return out
}

export function fieldBytes(fields: Field[], no: number): Uint8Array | undefined {
  const hit = fields.find((f) => f.no === no && f.value instanceof Uint8Array)
  return hit?.value as Uint8Array | undefined
}

export function fieldString(fields: Field[], no: number): string | undefined {
  const raw = fieldBytes(fields, no)
  return raw === undefined ? undefined : new TextDecoder().decode(raw)
}

/** `cursorExec.ts` wire field numbers, from the pinned cursor-agent bundle. */
export const cursorExecWire = {
  bool: { false: 0, true: 1 },
  parsing: {
    executableName: 1,
    executableArg: 2,
    commandText: 3,
    failed: 1,
    executables: 2,
    hasRedirects: 3,
    hasCmdSubst: 4,
  },
  grep: {
    pattern: 1,
    path: 2,
    glob: 3,
    outputMode: 4,
    contextBefore: 5,
    contextAfter: 6,
    context: 7,
    caseInsensitive: 8,
    fileType: 9,
    headLimit: 10,
    multiline: 11,
    sort: 12,
    sortAsc: 13,
    callId: 14,
    resultOffset: 16,
  },
  shell: {
    command: 1,
    cwd: 2,
    timeout: 3,
    execId: 4,
    readOffset: 4,
    readLimit: 5,
    parsingResult: 8,
    background: 11,
    skipApproval: 12,
    description: 15,
    writeReturnContent: 4,
    stdout: 5,
    stderr: 6,
    failSignal: 4,
    spawnErrorText: 3,
  },
  read: { path: 1, execId: 2 },
  write: { path: 1, content: 2, execId: 3 },
  delete: { path: 1, execId: 2 },
  ls: { path: 1, ignore: 2, execId: 3 },
  agent: { serverExec: 2, messageId: 1 },
  tool: { resultFailure: 2, nestedFirstString: 1 },
} as const
