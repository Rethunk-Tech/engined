/**
 * `vision_bridge` end to end through the real door: a text-only chat route
 * opted into bridging an image through a `role = "vision"` sibling on the
 * same engine, dispatched with fake upstreams (CI tier, no mocks).
 */
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { chatRequest, createLlamaDoor, LOCAL_LLAMA_SPEC } from './doorFixtures.ts'
import { errorMessageOf, type HttpClient } from './http.ts'
import {
  collectLines,
  config,
  engine,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  upstream,
  withLlamaControl,
  writeEngineSpec,
} from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-vision-bridge-test-')

/** One engine, two routes: a text-only chat route bridged onto a vision sibling. */
function bridgedDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  const cfg = config({
    engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 2 })],
    upstreams: [upstream()],
    routes: [
      route({
        engine: 'local-llama',
        model: 'ornith',
        filename: 'ornith.gguf',
        role: 'chat',
        vision_bridge: '@/local-llama/vision',
      }),
      route({
        engine: 'local-llama',
        model: 'vision',
        filename: 'vision.gguf',
        role: 'vision',
        vision: 'describe',
      }),
    ],
  })
  return { cfg, root }
}

interface RecordedBody {
  model?: string
  messages?: unknown[]
}

/** Distinguishes the bridge call from the main call by which model the door resolved it to -- both land on the same fake container. */

function bridgedLoggedDoor(bridgeStatus?: number) {
  const { cfg, root } = bridgedDoorConfig()
  const bridgeCalls: RecordedBody[] = []
  const mainCalls: RecordedBody[] = []
  const { lines, write } = collectLines()
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeBridgeHttpClient({
      bridgeCalls,
      mainCalls,
      ...(bridgeStatus === undefined ? {} : { bridgeStatus }),
    }),
    write,
  })
  return { door, bridgeCalls, mainCalls, lines }
}

function makeBridgeHttpClient(opts: {
  bridgeCalls: RecordedBody[]
  mainCalls: RecordedBody[]
  caption?: string
  bridgeStatus?: number
}): HttpClient {
  return withLlamaControl((_url: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as RecordedBody) : {}
    if (body.model === 'vision') {
      opts.bridgeCalls.push(body)
      if (opts.bridgeStatus !== undefined) {
        return Promise.resolve(
          Response.json({ error: 'vision engine overloaded' }, { status: opts.bridgeStatus }),
        )
      }
      return Promise.resolve(
        Response.json({
          id: 'resp-vision',
          choices: [{ message: { content: opts.caption ?? 'a red circle on white' } }],
          usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        }),
      )
    }
    opts.mainCalls.push(body)
    return Promise.resolve(
      Response.json({ id: 'resp-1', choices: [{ message: { content: 'ok' } }] }),
    )
  })
}

test('an image content part is captioned by the bridge route and spliced into the dispatched request, in order', async () => {
  const { door, bridgeCalls, mainCalls, lines } = bridgedLoggedDoor()
  const res = await door.fetch(
    chatRequest({
      model: '@/local-llama/ornith',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          ],
        },
      ],
    }),
  )
  expect(res.status).toBe(200)
  await res.json()

  expect(bridgeCalls).toHaveLength(1)
  const bridgeMessages = bridgeCalls[0]?.messages as { role: string; content: unknown }[]
  expect(bridgeMessages[0]?.role).toBe('system')
  expect(bridgeMessages[1]).toEqual({
    role: 'user',
    content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }],
  })

  expect(mainCalls).toHaveLength(1)
  const mainMessages = mainCalls[0]?.messages as { content: unknown[] }[]
  const sentContent = mainMessages[0]?.content
  expect(sentContent).toEqual([
    { type: 'text', text: 'describe this' },
    { type: 'text', text: '[Image 1: a red circle on white]' },
  ])

  // No caption text reaches provenance -- only the bridge attempt's shape.
  const record = soleProvenanceRecord(lines)
  expect(record.vision_bridge).toHaveLength(1)
  expect(record.vision_bridge?.[0]?.ok).toBe(true)
  expect(record.vision_bridge?.[0]?.engine).toBe('local-llama')
  expect(record.vision_bridge?.[0]?.model).toBe('vision')
  expect(JSON.stringify(record)).not.toContain('red circle')
})

test('a text-only chat request to a bridged route is dispatched unchanged', async () => {
  const { cfg, root } = bridgedDoorConfig()
  const bridgeCalls: RecordedBody[] = []
  const mainCalls: RecordedBody[] = []
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeBridgeHttpClient({ bridgeCalls, mainCalls }),
    write: () => undefined,
  })
  const res = await door.fetch(
    chatRequest({
      model: '@/local-llama/ornith',
      messages: [{ role: 'user', content: 'plain text, no image' }],
    }),
  )
  expect(res.status).toBe(200)
  await res.json()
  expect(bridgeCalls).toHaveLength(0)
  expect(mainCalls).toHaveLength(1)
  expect(mainCalls[0]?.messages?.[0]).toEqual({ role: 'user', content: 'plain text, no image' })
})

test('a failing bridge call refuses the whole request, naming the bridge, rather than dropping the image', async () => {
  const { door, mainCalls, lines } = bridgedLoggedDoor(503)
  const res = await door.fetch(
    chatRequest({
      model: '@/local-llama/ornith',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
      ],
    }),
  )
  expect(res.status).toBe(502)
  const body = await res.json()
  expect(errorMessageOf(body)).toContain('@/local-llama/vision')
  expect(errorMessageOf(body)).toContain('image 1')
  expect(mainCalls).toHaveLength(0)
  const record = soleProvenanceRecord(lines)
  expect(record.attempts).toHaveLength(0)
  expect(record.vision_bridge?.[0]?.ok).toBe(false)
})

test('a caller abort reaches the bridge dispatch and refuses rather than hanging', async () => {
  const { cfg, root } = bridgedDoorConfig()
  const httpClient: HttpClient = withLlamaControl(
    (_url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ choices: [{ message: { content: 'late' } }] })),
          50,
        )
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('The operation was aborted'))
        })
      }),
  )
  const door = createLlamaDoor(cfg, root, { llamaHttpClient: httpClient, write: () => undefined })
  const controller = new AbortController()
  const req = new Request('http://engined/openai/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: '@/local-llama/ornith',
      messages: [
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x/y.png' } }] },
      ],
    }),
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 5)
  const res = await door.fetch(req)
  expect(res.status).toBe(502)
  const body = await res.json()
  expect(errorMessageOf(body)).toContain('client disconnected')
})

test('GET /openai/v1/models advertises image input and the bridge address on the bridged route', async () => {
  const { cfg, root } = bridgedDoorConfig()
  const door = createLlamaDoor(cfg, root, {
    llamaHttpClient: makeBridgeHttpClient({ bridgeCalls: [], mainCalls: [] }),
    write: () => undefined,
  })
  const res = await door.fetch(new Request('http://engined/openai/v1/models'))
  const body = (await res.json()) as {
    data: { id: string; vision_bridge?: string; capabilities: { input?: string[] } }[]
  }
  const row = body.data.find((r) => r.id === '@/local-llama/ornith')
  expect(row?.vision_bridge).toBe('@/local-llama/vision')
  expect(row?.capabilities.input).toContain('image')
})
