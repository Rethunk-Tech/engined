import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { createLlamaDoor, LOCAL_LLAMA_SPEC, makeLlamaHttpClient } from './doorFixtures.ts'
import { proxyExtras } from './extras.ts'
import { errorMessageOf, type HttpClient } from './http.ts'
import { config, engine, makeTestRoot, route, writeEngineSpec } from './test-support.ts'

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

const TEST_ROOT = makeTestRoot('engined-extras-')

function extrasLlamaDoor(extrasHttpClient?: HttpClient) {
  const root = mkdtempSync(join(TEST_ROOT, 'door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  const cfg = config({
    engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
    routes: [route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' })],
  })
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
    { baseUrl: BASE, enginePath: '/tokenize' },
    'ornith',
    client,
  )
  expect(res.status).toBe(503)
  expect(res.headers.get('content-type')).toContain('application/json')
  expect(errorMessageOf(await res.json())).toContain('Unable to connect')
})
