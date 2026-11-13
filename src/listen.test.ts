import { expect, test } from 'bun:test'
import { bindDoor } from './listen.ts'

test("door idleTimeout is finite at Bun's ceiling", () => {
  let idleTimeout: number | undefined
  const serve = ((opts: { idleTimeout?: number; hostname?: string }) => {
    idleTimeout = opts.idleTimeout
    if (opts.hostname === '::') {
      const err = new Error('no ipv6') as Error & { code: string }
      err.code = 'EAFNOSUPPORT'
      throw err
    }
    return { port: 1, stop: () => undefined }
  }) as unknown as typeof Bun.serve
  bindDoor(async () => new Response(), 0, serve)
  expect(idleTimeout).toBe(255)
})

test('an unhandled route error answers a generic 500 with an id, and the journal keeps the id but not the message', async () => {
  const marker = 'PROMPT-MARKER-7f3a'
  const written: string[] = []
  const realWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  }) as typeof process.stderr.write
  const servers = bindDoor(() => {
    throw new TypeError(`bad input: ${marker}`)
  }, 0)
  let text: string
  try {
    const res = await fetch(`http://127.0.0.1:${servers[0]?.port}/anything`)
    expect(res.status).toBe(500)
    text = await res.text()
  } finally {
    process.stderr.write = realWrite
    for (const server of servers) {
      server.stop(true)
    }
  }
  expect(text).not.toContain(marker)
  const body = JSON.parse(text) as { error: { message: string; type: string } }
  const id = /internal error \(id ([0-9a-f-]{36})\)/.exec(body.error.message)?.[1]
  expect(id).toBeDefined()
  const log = written.join('')
  expect(log).toContain(`${id}`)
  expect(log).toContain('TypeError')
  expect(log).toContain(' at ')
  expect(log).not.toContain(marker)
})
