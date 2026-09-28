import { expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { gzipSync } from 'node:zlib'
import { framer, serveCursorAgent, toolRequestFrom } from './cursorAgent.ts'
import { execOutcome, execRequest } from './cursorExec.ts'
import {
  bytesField,
  decode,
  envelope,
  fieldBytes,
  fieldString,
  message,
  stringField,
} from './cursorProto.ts'
import { FatalError } from './errors/fatal.ts'

test('tool arguments of null become an empty table rather than aborting the turn', () => {
  expect(() =>
    toolRequestFrom({
      id: 'call_0',
      type: 'function',
      function: { name: 'read', arguments: 'null' },
    }),
  ).not.toThrow()
  expect(
    toolRequestFrom({
      id: 'call_0',
      type: 'function',
      function: { name: 'read', arguments: 'null' },
    }),
  ).toMatchObject({ tool: 'read' })
})

test('execRequest round trip carries id, exec id, and read path', () => {
  const framed = execRequest(3, 'exec-1', { tool: 'read', path: '/tmp/a' })
  expect(framed).toBeDefined()
  if (framed === undefined) {
    return
  }
  const inner = fieldBytes(decode(framed), 2)
  expect(inner).toBeDefined()
  if (inner === undefined) {
    return
  }
  const fields = decode(inner)
  expect(fieldString(fields, 15)).toBe('exec-1')
  const args = fieldBytes(fields, 7)
  expect(args).toBeDefined()
  if (args === undefined) {
    return
  }
  expect(fieldString(decode(args), 1)).toBe('/tmp/a')
})

const OUTCOMES: Array<{ name: string; payload: Uint8Array; ok: boolean; text: string }> = [
  {
    name: 'shell success',
    payload: message(
      bytesField(2, message(bytesField(1, message(stringField(5, 'out'), stringField(6, 'err'))))),
    ),
    ok: true,
    text: 'out\nerr',
  },
  {
    name: 'shell failure',
    payload: message(
      bytesField(
        2,
        message(bytesField(2, message(stringField(4, 'SIGTERM'), stringField(6, 'killed')))),
      ),
    ),
    ok: false,
    text: 'command failed (SIGTERM): killed',
  },
  {
    name: 'shell spawn-error',
    payload: message(bytesField(2, message(bytesField(5, message(stringField(3, 'no such bin')))))),
    ok: false,
    text: 'no such bin',
  },
  {
    name: 'read success',
    payload: message(bytesField(7, message(bytesField(1, message(stringField(2, 'file body')))))),
    ok: true,
    text: 'file body',
  },
]

for (const row of OUTCOMES) {
  test(`execOutcome ${row.name}`, () => {
    expect(execOutcome(row.payload)).toEqual({ ok: row.ok, text: row.text })
  })
}

test('framer reassembles a split frame and a gzipped frame', () => {
  const plain = new TextEncoder().encode('plain')
  const zipped = new Uint8Array(gzipSync(new TextEncoder().encode('zipped')))
  const first = envelope(plain)
  const second = envelope(zipped, 1)
  const got: string[] = []
  const push = framer((payload) => {
    got.push(new TextDecoder().decode(payload))
  })
  push(first.subarray(0, 3))
  push(first.subarray(3))
  push(second)
  expect(got).toEqual(['plain', 'zipped'])
})

test('framer rejects a frame larger than 16 MiB', () => {
  const header = new Uint8Array(5)
  new DataView(header.buffer).setUint32(1, 16 * 1024 * 1024 + 1, false)
  expect(() => {
    framer(() => undefined)(header)
  }).toThrow(/connect frame exceeds/)
})

test('a Cursor bind failure is reported like the door port-in-use path', async () => {
  const blocker = createServer()
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject)
    blocker.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = blocker.address()
  if (addr === null || typeof addr === 'string') {
    blocker.close()
    throw new Error('expected a TCP address')
  }
  let cursor: ReturnType<typeof serveCursorAgent> | undefined
  try {
    const detail = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('bind error was never raised')), 2000)
      cursor = serveCursorAgent(addr.port, {
        complete: () => Promise.resolve({ text: '', toolCalls: [] }),
        onBindError: (message) => {
          clearTimeout(timer)
          resolve(message)
        },
      })
    })
    expect(detail.length).toBeGreaterThan(0)
    expect(`port ${addr.port} already in use: ${detail}`).toContain('already in use')
    expect(FatalError.EXIT_CODE).toBe(78)
  } finally {
    cursor?.stop()
    await new Promise<void>((resolve) => {
      blocker.close(() => resolve())
    })
  }
})
