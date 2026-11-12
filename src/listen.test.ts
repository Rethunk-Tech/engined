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
    return { port: 1, stop() {} }
  }) as unknown as typeof Bun.serve
  bindDoor(async () => new Response(), 0, serve)
  expect(idleTimeout).toBe(255)
})
