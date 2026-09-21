/**
 * The wire primitives Cursor's CLI speaks: protobuf varints and
 * length-delimited fields, and Connect's stream envelope.
 *
 * Only the two wire types the agent protocol actually uses are here --
 * varint and length-delimited. Nothing in `AgentServerMessage` or the boot
 * replies carries a fixed32/fixed64, so a full protobuf implementation would
 * be dead weight beside the handful of messages this door encodes.
 */

const CONTINUATION = 128;
const GROUP = 128;
const WIRE_VARINT = 0;
const WIRE_LENGTH = 2;
/** Connect stream frames start with a flag byte and a 4-byte length. */
export const ENVELOPE_HEADER = 5;

/** Connect marks the final frame of a stream with this flag. */
const FLAG_END_STREAM = 2;

export function varint(value: number): Uint8Array {
  const out: number[] = [];
  let n = value;
  do {
    const byte = n % GROUP;
    n = Math.floor(n / GROUP);
    out.push(n > 0 ? byte + CONTINUATION : byte);
  } while (n > 0);
  return Uint8Array.from(out);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function tag(fieldNo: number, wire: number): Uint8Array {
  return varint(fieldNo * 8 + wire);
}

/** A length-delimited field: a nested message or a `bytes` value. */
export function bytesField(fieldNo: number, payload: Uint8Array): Uint8Array {
  return concat([tag(fieldNo, WIRE_LENGTH), varint(payload.length), payload]);
}

export function stringField(fieldNo: number, value: string): Uint8Array {
  return bytesField(fieldNo, new TextEncoder().encode(value));
}

export function intField(fieldNo: number, value: number): Uint8Array {
  return concat([tag(fieldNo, WIRE_VARINT), varint(value)]);
}

export function message(...parts: Uint8Array[]): Uint8Array {
  return concat(parts);
}

/**
 * One Connect stream frame: a flag byte, a big-endian length, the payload.
 * The same shape carries both a message and the end-of-stream marker, which
 * is why the flag is a parameter rather than two functions.
 */
export function envelope(payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(ENVELOPE_HEADER + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, ENVELOPE_HEADER);
  return out;
}

export function endOfStream(): Uint8Array {
  return envelope(new TextEncoder().encode("{}"), FLAG_END_STREAM);
}

export interface Field {
  no: number;
  value: number | Uint8Array;
}

/**
 * Walk a message into its raw fields. The caller matches field numbers
 * against the schema it expects, because the wire format carries no names
 * and this door only ever reads a handful of known fields.
 */
export function decode(buf: Uint8Array): Field[] {
  const out: Field[] = [];
  let i = 0;
  while (i < buf.length) {
    let key = 0;
    let shift = 1;
    for (;;) {
      const byte = buf[i];
      if (byte === undefined) {
        return out;
      }
      i += 1;
      key += (byte % GROUP) * shift;
      if (byte < CONTINUATION) {
        break;
      }
      shift *= GROUP;
    }
    const no = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === WIRE_LENGTH) {
      let len = 0;
      let mul = 1;
      for (;;) {
        const byte = buf[i];
        if (byte === undefined) {
          return out;
        }
        i += 1;
        len += (byte % GROUP) * mul;
        if (byte < CONTINUATION) {
          break;
        }
        mul *= GROUP;
      }
      out.push({ no, value: buf.subarray(i, i + len) });
      i += len;
    } else if (wire === WIRE_VARINT) {
      let v = 0;
      let mul = 1;
      for (;;) {
        const byte = buf[i];
        if (byte === undefined) {
          return out;
        }
        i += 1;
        v += (byte % GROUP) * mul;
        if (byte < CONTINUATION) {
          break;
        }
        mul *= GROUP;
      }
      out.push({ no, value: v });
    } else {
      return out;
    }
  }
  return out;
}

export function fieldBytes(fields: Field[], no: number): Uint8Array | undefined {
  const hit = fields.find((f) => f.no === no && f.value instanceof Uint8Array);
  return hit?.value as Uint8Array | undefined;
}

export function fieldString(fields: Field[], no: number): string | undefined {
  const raw = fieldBytes(fields, no);
  return raw === undefined ? undefined : new TextDecoder().decode(raw);
}
