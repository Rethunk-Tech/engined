import { expect, test } from 'bun:test'
import { proxyExtras } from './extras.ts'
import type { HttpClient } from './http.ts'

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
    { baseUrl: BASE, enginePath: '/tokenize' },
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
  await proxyExtras(req, { baseUrl: BASE, enginePath: '/apply-template' }, 'ornith', client)

  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string }
  expect(parsed.model).toBe('explicit')
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
    { baseUrl: BASE, enginePath: '/apply-template' },
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
    { baseUrl: BASE, enginePath: '/tokenize' },
    null,
    client,
  )

  expect(res.status).toBe(400)
  const parsed = JSON.parse(calls[0]?.init?.body as string) as { model?: string }
  expect(parsed.model).toBeUndefined()
})
