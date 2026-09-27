import { describe, expect, test } from 'bun:test'
import { defaultQueueFetch, queuedPromptIds } from './comfyQueue.ts'

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
