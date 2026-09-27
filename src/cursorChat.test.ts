import { expect, test } from 'bun:test'
import type { StreamSink } from './cursorAgent.ts'
import { completeLocally } from './cursorChat.ts'
import type { DoorContext } from './doorContext.ts'
import { CONTENT_TYPE, JSON_CONTENT_TYPE } from './http.ts'
import { CONTENT_ENDPOINT_CHAT } from './routeServes.ts'
import { config, engine, route, upstream } from './test-support.ts'

const sinkChunks: string[] = []
const silent: StreamSink = {
  thinking: (chunk) => {
    sinkChunks.push(chunk)
  },
  text: (chunk) => {
    sinkChunks.push(chunk)
  },
  toolArgs: (callId, chunk) => {
    sinkChunks.push(callId, chunk)
  },
}

function ctxFor(cfg: ReturnType<typeof config>): DoorContext {
  return { getConfig: () => cfg } as DoorContext
}

test('completeLocally addresses a chat route by engine id, not a hardcoded llama path', async () => {
  const seen: { path: string; type: string | null; model: unknown }[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as { model?: unknown }
      seen.push({
        path: new URL(req.url).pathname,
        type: req.headers.get(CONTENT_TYPE),
        model: body.model,
      })
      return new Response('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n', {
        headers: { [CONTENT_TYPE]: 'text/event-stream' },
      })
    },
  })
  try {
    const cfg = config({
      listen_port: server.port,
      engines: [engine({ id: 'box' })],
      upstreams: [upstream()],
      routes: [route({ engine: 'box', model: 'ornith', role: 'chat' })],
    })
    const reply = await completeLocally(ctxFor(cfg), [], silent)
    expect(reply.text).toBe('hi')
    expect(seen).toEqual([
      {
        path: CONTENT_ENDPOINT_CHAT,
        type: JSON_CONTENT_TYPE,
        model: '@/box/ornith',
      },
    ])
  } finally {
    server.stop(true)
  }
})

test('a null SSE data frame does not abort the turn', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response('data: null\n\ndata: {"choices":[{"delta":{"content":"ok"}}]}\n\n', {
        headers: { [CONTENT_TYPE]: 'text/event-stream' },
      }),
  })
  try {
    const cfg = config({
      listen_port: server.port,
      routes: [route({ engine: 'box', model: 'ornith', role: 'chat' })],
    })
    const reply = await completeLocally(ctxFor(cfg), [], silent)
    expect(reply.text).toBe('ok')
  } finally {
    server.stop(true)
  }
})
