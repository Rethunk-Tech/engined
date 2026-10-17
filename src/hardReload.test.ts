/**
 * A hard reload answers a call that is mid-flight with 503 in the OpenAI
 * error shape; it must not hang or finish against the config being replaced.
 */

import { expect, test } from 'bun:test'
import { chatRequest, fakeExec } from './doorFixtures.ts'
import { createDoor } from './main.ts'
import { BUNX, config, engine, route, startFakeUpstream, upstream } from './test-support.ts'

test('door.interrupt() fails an in-flight request with a 503 OpenAI error', async () => {
  let release: () => void = () => undefined
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let reached: () => void = () => undefined
  const arrived = new Promise<void>((resolve) => {
    reached = resolve
  })
  const provider = startFakeUpstream(async () => {
    reached()
    await held
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'old config' } }] })
  })
  const door = createDoor(
    config({
      engines: [engine({ id: 'hosted', kind: 'openai-http' })],
      upstreams: [
        upstream({
          id: 'up',
          egress: 'remote',
          base_url: `${provider.base}/v1`,
          secret: {
            service: 'openai-api',
            username: 'up',
            header: 'authorization',
            scheme: 'Bearer',
          },
        }),
      ],
      routes: [route({ engine: 'hosted', model: 'gpt', upstream: 'up' })],
    }),
    { enginesRoot: '/nonexistent/engines', bunx: BUNX },
    { secretExec: fakeExec('sk-test'), write: () => undefined },
  )
  try {
    const inflight = Promise.resolve(
      door.fetch(
        chatRequest({ model: '@/hosted/gpt', messages: [{ role: 'user', content: 'hi' }] }),
      ),
    )
    await arrived
    door.interrupt()
    const res = await inflight
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error?: { message?: string } }
    expect(body.error?.message).toContain('reloading')
  } finally {
    release()
    provider.stop()
    await door.registry.shutdown()
  }
})
