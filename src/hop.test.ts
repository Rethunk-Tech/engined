import { expect, test } from 'bun:test'
import {
  chatRequest,
  createLlamaDoor,
  llamaDoorConfig,
  makeLlamaHttpClient,
} from './doorFixtures.ts'
import type { HttpClient } from './http.ts'
import { llamaControlPlane, makeTestRoot } from './test-support.ts'

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

test('a model-less SSE hop delivers the first chunk before the upstream stream ends', async () => {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  const encoder = new TextEncoder()
  let sourceEnded = false
  const control = llamaControlPlane()
  const httpClient: HttpClient = (url, init) => {
    const controlled = control(url, init)
    if (controlled) {
      return Promise.resolve(controlled)
    }
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
  }
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
