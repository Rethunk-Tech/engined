import { expect, test } from 'bun:test'
import { holdSeconds } from './control.ts'
import { createLlamaDoor, llamaDoorConfig, makeLlamaHttpClient } from './doorFixtures.ts'
import { proxyExtras } from './extras.ts'
import { ENGINE_ERROR_CHARS, errorMessageOf, type HttpClient, MAX_JSON_BODY_BYTES } from './http.ts'
import { makeTestRoot } from './test-support.ts'

const BASE = 'http://127.0.0.1:9999'

function recordingClient(handler: (url: string, init?: RequestInit) => Response): {
  client: HttpClient
  calls: Array<{ url: string; init?: RequestInit }>
} {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const client: HttpClient = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(handler(url, init))
  }
  return { client, calls }
}

function tokenizeHiRequest() {
  return new Request(`${BASE}/tokenize`, {
    method: 'POST',
    body: JSON.stringify({ content: 'hi' }),
  })
}

test('POST /tokenize with no model in the body gets the resident injected', async () => {
  const { client, calls } = recordingClient(() => Response.json({ tokens: [1, 2, 3] }))
  const res = await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => BASE, enginePath: '/tokenize' },
    'ornith',
    client,
  )

  expect(res.status).toBe(200)
  const sentBody = calls[0]?.init?.body
  expect(typeof sentBody).toBe('string')
  const parsed = JSON.parse(sentBody as string) as { model?: string; content?: string }
  expect(parsed.model).toBe('ornith')
  expect(parsed.content).toBe('hi')
})

test('a model already present in the body is never overridden', async () => {
  const { client, calls } = recordingClient(() => Response.json({ tokens: [] }))
  const req = new Request(`${BASE}/apply-template`, {
    method: 'POST',
    body: JSON.stringify({ messages: [], model: 'explicit' }),
  })
  await proxyExtras(req, { baseUrl: () => BASE, enginePath: '/apply-template' }, 'ornith', client)

  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string }
  expect(parsed.model).toBe('explicit')
})

test('an oversized body is refused with the shared 413, never reaching the upstream', async () => {
  const { client, calls } = recordingClient(() => Response.json({ tokens: [] }))
  const req = new Request(`${BASE}/tokenize`, {
    method: 'POST',
    body: JSON.stringify({ content: 'hi' }),
    headers: { 'content-length': String(MAX_JSON_BODY_BYTES + 1) },
  })
  const res = await proxyExtras(
    req,
    { baseUrl: () => BASE, enginePath: '/tokenize' },
    'ornith',
    client,
  )

  expect(res.status).toBe(413)
  expect(calls.length).toBe(0)
})

test('an oversized passthrough body is refused with the shared 413 before any lease is taken', async () => {
  const { client, calls } = recordingClient(() => Response.json({ tokens: [] }))
  let leases = 0
  const req = new Request(`${BASE}/tokenize`, {
    method: 'POST',
    body: 'x'.repeat(MAX_JSON_BODY_BYTES + 1),
  })
  const res = await proxyExtras(
    req,
    {
      baseUrl: () => BASE,
      enginePath: '/tokenize',
      hold: (work) => {
        leases += 1
        return work()
      },
    },
    null,
    client,
  )

  expect(res.status).toBe(413)
  expect(leases).toBe(0)
  expect(calls.length).toBe(0)
})

test('the upstream response body passes through unmodified, SSE included', async () => {
  const sseBody = 'data: {"content":"a","timings":{"predicted_ms":1},"timings_per_token":{}}\n\n'
  const { client } = recordingClient(
    () => new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } }),
  )
  const req = new Request(`${BASE}/apply-template`, {
    method: 'POST',
    body: JSON.stringify({ messages: [] }),
  })
  const res = await proxyExtras(
    req,
    { baseUrl: () => BASE, enginePath: '/apply-template' },
    'ornith',
    client,
  )

  expect(res.headers.get('content-type')).toBe('text/event-stream')
  expect(await res.text()).toBe(sseBody)
})

test('no resident model: injectable endpoints are forwarded without a model, letting the upstream 400', async () => {
  const { client, calls } = recordingClient(() => new Response(null, { status: 400 }))
  const res = await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => BASE, enginePath: '/tokenize' },
    null,
    client,
  )

  expect(res.status).toBe(400)
  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string }
  expect(parsed.model).toBeUndefined()
})

test('a client that hangs up mid-upload gets a 400, not a throw out of the proxy', async () => {
  const { client, calls } = recordingClient(() => Response.json({}))
  const req = new Request(`${BASE}/apply-template`, {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      start: (c) => {
        c.enqueue(new TextEncoder().encode('{"messages":'))
        c.error(new Error('connection reset'))
      },
    }),
  })
  const res = await proxyExtras(
    req,
    { baseUrl: () => BASE, enginePath: '/apply-template' },
    null,
    client,
  )

  expect(res.status).toBe(400)
  expect(calls).toHaveLength(0)
})

const TEST_ROOT = makeTestRoot('engined-extras-')

function extrasLlamaDoor(extrasHttpClient?: HttpClient) {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  return createLlamaDoor(cfg, root, {
    llamaHttpClient: makeLlamaHttpClient([]),
    extrasHttpClient,
  })
}

function tokenizeOn(engineId: string) {
  return new Request(`http://engined/engined/v1/engines/${engineId}/tokenize`, {
    method: 'POST',
    body: JSON.stringify({ content: 'hi' }),
  })
}

test('tokenize on a held llama engine is JSON 503, not an uncaught throw', async () => {
  const door = extrasLlamaDoor(() =>
    Promise.reject(new Error('must not proxy extras on a held engine')),
  )
  const held = await door.fetch(
    new Request('http://engined/engined/v1/engines/local-llama/hold?seconds=60', {
      method: 'POST',
    }),
  )
  expect(held.status).toBe(200)

  const res = await door.fetch(tokenizeOn('local-llama'))
  expect(res.status).toBe(503)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(errorMessageOf(await res.json())).toContain('held')
})

test('an extras proxy whose upstream fetch throws is JSON 503', async () => {
  const client: HttpClient = () =>
    Promise.reject(new TypeError('Unable to connect. Is the computer able to access the url?'))
  const res = await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => BASE, enginePath: '/tokenize' },
    'ornith',
    client,
  )
  expect(res.status).toBe(503)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(errorMessageOf(await res.json())).toContain('Unable to connect')
})

test('proxyExtras holds the injected lease across the upstream fetch', async () => {
  let depth = 0
  let saw = 0
  const client: HttpClient = () => {
    saw = depth
    return Promise.resolve(Response.json({ tokens: [] }))
  }
  const hold = async (work: () => Promise<Response>) => {
    depth += 1
    try {
      return await work()
    } finally {
      depth -= 1
    }
  }
  await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => BASE, enginePath: '/tokenize', hold },
    'ornith',
    client,
  )
  expect(saw).toBe(1)
  expect(depth).toBe(0)
})

test('the engine address is read inside the lease, where a recreate may have moved it', async () => {
  let address = 'http://127.0.0.1:1111'
  const { client, calls } = recordingClient(() => Response.json({ tokens: [] }))
  const hold = (work: () => Promise<Response>) => {
    address = 'http://127.0.0.1:2222'
    return work()
  }
  await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => address, enginePath: '/tokenize', hold },
    'ornith',
    client,
  )
  expect(calls[0]?.url).toBe('http://127.0.0.1:2222/tokenize')
})

test('proxyExtras forwards the request abort signal to the upstream client', async () => {
  const ac = new AbortController()
  ac.abort()
  let signal: AbortSignal | undefined
  const client: HttpClient = (_url, init) => {
    signal = init?.signal ?? undefined
    return Promise.resolve(Response.json({ tokens: [] }))
  }
  const req = new Request(`${BASE}/tokenize`, {
    method: 'POST',
    body: JSON.stringify({ content: 'hi' }),
    signal: ac.signal,
  })
  await proxyExtras(req, { baseUrl: () => BASE, enginePath: '/tokenize' }, 'ornith', client)
  expect(signal?.aborted).toBe(true)
})

test('proxyExtras caps an error body at ENGINE_ERROR_CHARS', async () => {
  const body = `nope ${'x'.repeat(ENGINE_ERROR_CHARS + 40)}`
  const { client } = recordingClient(() => new Response(body, { status: 500 }))
  const res = await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => BASE, enginePath: '/tokenize' },
    'ornith',
    client,
  )
  expect(res.status).toBe(500)
  expect((await res.text()).length).toBe(ENGINE_ERROR_CHARS)
})

test('proxyExtras caps a success body', async () => {
  const over = `${'y'.repeat(1_048_576 + 8)}`
  const { client } = recordingClient(() => new Response(over, { status: 200 }))
  const res = await proxyExtras(
    tokenizeHiRequest(),
    { baseUrl: () => BASE, enginePath: '/tokenize' },
    'ornith',
    client,
  )
  expect(res.status).toBe(200)
  expect((await res.text()).length).toBe(1_048_576)
})

test('hold seconds: empty, zero and garbage take the default; the ceiling clamps', () => {
  const secs = (q: string) => holdSeconds(new URL(`http://engined/hold${q}`))
  expect([secs(''), secs('?seconds='), secs('?seconds=0'), secs('?seconds=x')]).toEqual([
    1800, 1800, 1800, 1800,
  ])
  expect([secs('?seconds=60'), secs('?seconds=99999')]).toEqual([60, 3600])
})
