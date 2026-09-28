import { expect, test } from 'bun:test'
import {
  chatRequest,
  createLlamaDoor,
  fakeExec,
  llamaDoorConfig,
  makeLlamaHttpClient,
} from './doorFixtures.ts'
import type { HttpClient } from './http.ts'
import { createDoor } from './main.ts'
import {
  BUNX,
  config,
  engine,
  makeTestRoot,
  route,
  startFakeUpstream,
  upstream,
  withLlamaControl,
} from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-hop-')

test('a local openai-http hop is proxied with no door fields', async () => {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const recorded: { body: string }[] = []
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeLlamaHttpClient(recorded),
    write: () => undefined,
  })
  const res = await door.fetch(
    chatRequest({
      model: '@/local-llama/ornith',
      workdir: '/tmp/should-not-travel',
      max_egress: 'remote',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  )

  expect(res.status).toBe(200)
  expect(recorded).toHaveLength(1)
  const body = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>
  expect(body.model).toBe('ornith')
  expect(body).not.toHaveProperty('workdir')
  expect(body).not.toHaveProperty('max_egress')
})

// The exact value is the router's to prove (llama.test.ts, on an injected
// clock); this only proves the chat path carries the header.
test('a local llama chat hop carries x-engined-queue-ms', async () => {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeLlamaHttpClient([]),
    write: () => undefined,
  })
  const res = await door.fetch(
    chatRequest({
      model: '@/local-llama/ornith',
      messages: [{ role: 'user', content: 'hi' }],
    }),
  )
  expect(res.status).toBe(200)
  expect(res.headers.get('x-engined-queue-ms')).toMatch(/^\d+$/)
})

test('a model-less SSE hop delivers the first chunk before the upstream stream ends', async () => {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const encoder = new TextEncoder()
  let sourceEnded = false
  const httpClient: HttpClient = withLlamaControl(() => {
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode('data: {"id":"chunk-1","choices":[{"delta":{"content":"hi"}}]}\n\n'),
        )
        await Bun.sleep(30)
        sourceEnded = true
        controller.enqueue(
          encoder.encode('data: {"id":"chunk-2","choices":[{"delta":{"content":"!"}}]}\n\n'),
        )
        controller.close()
      },
    })
    return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
  })
  const door = createLlamaDoor(cfg, root, { llamaHttpClient: httpClient, write: () => undefined })
  const res = await door.fetch(
    chatRequest({
      model: '@/local-llama/ornith',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  )
  const reader = res.body?.getReader()
  expect(reader).toBeDefined()
  const decoder = new TextDecoder()
  let seen = ''
  while (!seen.includes('chunk-1')) {
    const { done, value } = (await reader?.read()) ?? { done: true, value: undefined }
    expect(done).toBe(false)
    seen += decoder.decode(value)
  }
  expect(sourceEnded).toBe(false)
})

test('a remote hop does not follow an upstream redirect', async () => {
  const dest = startFakeUpstream(() => Response.json({ ok: true }))
  const src = startFakeUpstream(
    () =>
      new Response(null, {
        status: 307,
        headers: { Location: `${dest.base}/v1/chat/completions` },
      }),
  )
  const cfg = config({
    engines: [engine({ id: 'hosted', kind: 'openai-http' })],
    upstreams: [
      upstream({
        id: 'remote',
        egress: 'remote',
        base_url: `${src.base}/v1`,
        secret: { service: 's', username: 'u', header: 'authorization', scheme: 'Bearer' },
      }),
    ],
    routes: [route({ engine: 'hosted', model: 'sonnet-5', upstream: 'remote' })],
  })
  const door = createDoor(
    cfg,
    { enginesRoot: '/nonexistent/engines', bunx: BUNX },
    { secretExec: fakeExec('sk-not-a-real-key') },
  )
  try {
    const res = await door.fetch(
      chatRequest({
        model: '@/hosted/sonnet-5',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    expect(src.requestLog.length).toBeGreaterThan(0)
    expect(dest.requestLog).toHaveLength(0)
    expect(res.status).toBe(502)
  } finally {
    src.stop()
    dest.stop()
  }
})
