import { describe, expect, test } from 'bun:test'
import { defaultQueueFetch, defaultReleaseFetch, queuedPromptIds } from './comfyQueue.ts'

test('the memory-release POST carries an abort timeout', async () => {
  const orig = globalThis.fetch
  let seen: AbortSignal | undefined
  globalThis.fetch = (async (_input, init) => {
    seen = init?.signal ?? undefined
    return new Response(null, { status: 204 })
  }) as typeof fetch
  try {
    await defaultReleaseFetch('http://127.0.0.1:1/free', {})
    expect(seen).toBeInstanceOf(AbortSignal)
  } finally {
    globalThis.fetch = orig
  }
})

describe('comfy queue snapshot', () => {
  test('a 200 response without queue_running does not throw', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({ queue_pending: [] })
      },
    })
    try {
      const snapshot = await defaultQueueFetch(`http://127.0.0.1:${server.port}/queue`)
      expect(queuedPromptIds(snapshot.queue_running)).toEqual([])
      expect(queuedPromptIds(snapshot.queue_pending)).toEqual([])
    } finally {
      server.stop()
    }
  })
})
