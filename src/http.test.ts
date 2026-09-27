import { expect, test } from 'bun:test'
import {
  declaredOverLimit,
  discardBody,
  jsonErrorBody,
  MAX_JSON_BODY_BYTES,
  readJsonBody,
  STATUS_PAYLOAD_TOO_LARGE,
  splitSseFrames,
  sseFrames,
} from './http.ts'

/**
 * A response whose body records whether anything ever cancelled it, standing in
 * for an engine that is still producing when the door gives up on the reply.
 */
function watchedResponse(): { res: Response; cancelled: () => boolean } {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('x'.repeat(1024)))
    },
    cancel() {
      cancelled = true
    },
  })
  return { res: new Response(body, { status: 502 }), cancelled: () => cancelled }
}

test('a body the door will not read is cancelled rather than left to a collector', async () => {
  const { res, cancelled } = watchedResponse()

  await discardBody(res)

  expect(cancelled()).toBe(true)
})

/**
 * The counterfactual the helper exists for: dropping the reference does not
 * reach the producer, so an engine answering an error keeps its side open.
 */
test('dropping the reference instead never reaches the producer', async () => {
  // The reference is dropped by never binding it, which is the case under
  // test -- a `void res` would have kept one alive to satisfy the linter.
  const { cancelled } = watchedResponse()

  await Bun.sleep(1)

  expect(cancelled()).toBe(false)
})

test('a body already released is not an error the caller has to handle', async () => {
  const { res } = watchedResponse()
  await res.body?.cancel()

  await discardBody(res)
})

test('a response carrying no body at all is a no-op', async () => {
  await discardBody(new Response(null, { status: 204 }))
})

test('a carry with no frame boundary past the cap is dropped rather than held', () => {
  const kept = 'x'.repeat(65_536)
  expect(splitSseFrames(kept)).toEqual({ frames: [], carry: kept })
  expect(splitSseFrames(`${kept}y`)).toEqual({ frames: [], carry: '' })
})

test('SSE frames split on LF, CRLF, or CR boundaries', () => {
  expect(splitSseFrames('a\n\nb')).toEqual({ frames: ['a'], carry: 'b' })
  expect(splitSseFrames('a\r\n\r\nb')).toEqual({ frames: ['a'], carry: 'b' })
  expect(splitSseFrames('a\r\rb')).toEqual({ frames: ['a'], carry: 'b' })
})

test('sseFrames yields a trimmed tail with no trailing boundary', async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"x":1}'))
      controller.close()
    },
  })
  const frames: string[] = []
  for await (const frame of sseFrames(body)) {
    frames.push(frame)
  }
  expect(frames).toEqual(['data: {"x":1}'])
})

test('a JSON body whose declared Content-Length is past the cap is 413 without reading it', async () => {
  const req = new Request('http://door.local/', {
    method: 'POST',
    headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
  })
  const result = await readJsonBody(req)
  expect(result).toBeInstanceOf(Response)
  if (!(result instanceof Response)) {
    return
  }
  expect(result.status).toBe(STATUS_PAYLOAD_TOO_LARGE)
  expect(await result.json()).toEqual(jsonErrorBody('JSON body too large'))
})

test('a JSON body past the cap with no Content-Length is 413 after the read', async () => {
  const encoder = new TextEncoder()
  const chunk = encoder.encode(`{"x":"${'a'.repeat(MAX_JSON_BODY_BYTES)}"}`)
  const init: RequestInit & { duplex: 'half' } = {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
        controller.close()
      },
    }),
  }
  const result = await readJsonBody(new Request('http://door.local/', init))
  expect(result).toBeInstanceOf(Response)
  if (!(result instanceof Response)) {
    return
  }
  expect(result.status).toBe(STATUS_PAYLOAD_TOO_LARGE)
  expect(await result.json()).toEqual(jsonErrorBody('JSON body too large'))
})

test('a finite Content-Length past the cap is over the limit; an absent or unparseable one is not', () => {
  const max = 100
  expect(
    declaredOverLimit(
      new Request('http://engined/', { headers: { 'content-length': '101' } }),
      max,
    ),
  ).toBe(101)
  expect(
    declaredOverLimit(
      new Request('http://engined/', { headers: { 'content-length': '100' } }),
      max,
    ),
  ).toBeUndefined()
  expect(declaredOverLimit(new Request('http://engined/'), max)).toBeUndefined()
  expect(
    declaredOverLimit(
      new Request('http://engined/', { headers: { 'content-length': 'nope' } }),
      max,
    ),
  ).toBeUndefined()
})
