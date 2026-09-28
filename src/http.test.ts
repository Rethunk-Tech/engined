import { expect, test } from 'bun:test'
import {
  declaredOverLimit,
  discardBody,
  headOf,
  jsonErrorBody,
  MAX_JSON_BODY_BYTES,
  methodNotAllowed,
  readJsonBody,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_METHOD_NOT_ALLOWED,
  STATUS_NOT_FOUND,
  STATUS_PAYLOAD_TOO_LARGE,
  STATUS_PAYMENT_REQUIRED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_UNAUTHORIZED,
  STATUS_UNAVAILABLE,
  splitSseFrames,
  sseDataPayloads,
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
  expect(splitSseFrames(kept)).toEqual({ frames: [], carry: kept, discarding: false })
  expect(splitSseFrames(`${kept}y`)).toEqual({ frames: [], carry: '', discarding: true })
})

test('SSE frames split on LF, CRLF, or CR boundaries', () => {
  expect(splitSseFrames('a\n\nb')).toEqual({ frames: ['a'], carry: 'b', discarding: false })
  expect(splitSseFrames('a\r\n\r\nb')).toEqual({ frames: ['a'], carry: 'b', discarding: false })
  expect(splitSseFrames('a\r\rb')).toEqual({ frames: ['a'], carry: 'b', discarding: false })
})

test('an oversized frame in 7-byte chunks yields no partial; the next frame still arrives', async () => {
  const encoder = new TextEncoder()
  const body = `data: ${'x'.repeat(70_000)}\n\ndata: {"ok":true}\n\n`
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < body.length; i += 7) {
        controller.enqueue(encoder.encode(body.slice(i, i + 7)))
      }
      controller.close()
    },
  })
  const frames: string[] = []
  for await (const frame of sseFrames(stream)) {
    frames.push(frame)
  }
  expect(frames.some((frame) => frame.includes('xxx'))).toBe(false)
  expect(frames).toEqual(['data: {"ok":true}'])
})

test('a CR-only frame with two data lines yields two payloads', () => {
  expect(sseDataPayloads('data: one\rdata: two')).toEqual(['one', 'two'])
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

async function expectJsonTooLarge(result: unknown): Promise<void> {
  expect(result).toBeInstanceOf(Response)
  if (!(result instanceof Response)) {
    return
  }
  expect(result.status).toBe(STATUS_PAYLOAD_TOO_LARGE)
  expect(await result.json()).toEqual(
    jsonErrorBody(STATUS_PAYLOAD_TOO_LARGE, 'JSON body too large'),
  )
}

test('a JSON error body is OpenAI-shaped and types the status', () => {
  expect(jsonErrorBody(STATUS_BAD_REQUEST, 'nope')).toEqual({
    error: {
      message: 'nope',
      type: 'invalid_request_error',
      param: null,
      code: null,
    },
  })
  expect(jsonErrorBody(STATUS_UNAUTHORIZED, 'no').error.type).toBe('authentication_error')
  expect(jsonErrorBody(STATUS_PAYMENT_REQUIRED, 'pay').error.type).toBe('insufficient_quota')
  expect(jsonErrorBody(STATUS_FORBIDDEN, 'no').error.type).toBe('permission_error')
  expect(jsonErrorBody(STATUS_NOT_FOUND, 'gone').error.type).toBe('not_found_error')
  expect(jsonErrorBody(STATUS_METHOD_NOT_ALLOWED, 'no').error.type).toBe('invalid_request_error')
  expect(jsonErrorBody(STATUS_TOO_MANY_REQUESTS, 'slow').error.type).toBe('rate_limit_error')
  expect(jsonErrorBody(STATUS_UNAVAILABLE, 'down').error.type).toBe('server_error')
})

test('methodNotAllowed is 405 with Allow naming the methods that path serves', () => {
  const res = methodNotAllowed(['GET', 'HEAD'])
  expect(res.status).toBe(STATUS_METHOD_NOT_ALLOWED)
  expect(res.headers.get('Allow')).toBe('GET, HEAD')
})

test('headOf keeps the GET status and drops the body', async () => {
  const head = await headOf(Response.json({ object: 'list' }))
  expect(head.status).toBe(200)
  expect(await head.text()).toBe('')
})

test('a JSON body whose declared Content-Length is past the cap is 413 without reading it', async () => {
  const req = new Request('http://door.local/', {
    method: 'POST',
    headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
  })
  const result = await readJsonBody(req)
  await expectJsonTooLarge(result)
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
  await expectJsonTooLarge(result)
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
