import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { bindDoor } from '../../src/listen.ts'
import { LOCAL } from './exclusive.ts'

const MARKER = 'engined-network-local-smoke'

/**
 * A cold start -- container plus a multi-gigabyte GGUF -- routinely outruns
 * Bun's default 10s socket timer, which closes the connection with no body
 * at all. That is why this needs a real socket: the in-process `fetch` call
 * every other test makes never opens one, so it cannot observe the timer.
 */
// The bind lives in `beforeAll`, not the `describe` body: bun still calls a skipped describe's body to enumerate
// its tests, so a socket opened there would bind on every run and never close.
describe.skipIf(!LOCAL)('slow response over a real socket (local)', () => {
  const SlowerThanBunDefaultMs = 12_000
  let bound: ReturnType<typeof bindDoor> | undefined

  beforeAll(() => {
    bound = bindDoor(async () => {
      await Bun.sleep(SlowerThanBunDefaultMs)
      return new Response(MARKER)
    }, 0)
  })

  afterAll(() => {
    for (const s of bound ?? []) {
      s.stop(true)
    }
  })

  test("an answer slower than Bun's default idle timeout still reaches the caller", async () => {
    if (!bound) {
      throw new Error('beforeAll did not run -- bound is unset')
    }
    const res = await fetch(`http://127.0.0.1:${bound[0]?.port}/`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(MARKER)
  }, 60_000)
})
