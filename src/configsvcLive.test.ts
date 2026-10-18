import { expect, test } from 'bun:test'
import type { ConfigsvcDeps } from './configsvcApi.ts'
import { liveApi } from './configsvcLive.ts'
import { CONTENT_ENDPOINT_CHAT, CONTENT_ENDPOINT_TRANSLATIONS } from './routeServes.ts'

const asFetch = (
  fn: (input: string | Request | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(fn, { preconnect: fetch.preconnect })

function deps(over: Partial<ConfigsvcDeps>): ConfigsvcDeps {
  return {
    configFile: '/dev/null',
    enginesRoot: '/dev/null',
    bunx: 'bunx',
    stateRoot: '/tmp',
    doorUrl: () => 'http://door.test',
    reload: async () => ({ ok: true }),
    secrets: {
      present: async () => false,
      store: async () => ({ ok: true }),
      clear: async () => ({ ok: true }),
    },
    audit: () => undefined,
    fetch: asFetch(async () => new Response('{}')),
    doctor: async () => ({ ok: true, checks: [] }),
    ...over,
  }
}

test('a translations-only route is probed with the translations verb, never chat', async () => {
  const posted: string[] = []
  const env = deps({
    fetch: asFetch(async (input, init) => {
      const path = new URL(String(input)).pathname
      if (path.endsWith('/openai/v1/models') && (init?.method ?? 'GET') === 'GET') {
        return Response.json({
          data: [{ id: '@/whisper/local', serves: [CONTENT_ENDPOINT_TRANSLATIONS] }],
        })
      }
      posted.push(path)
      return Response.json({ ok: true })
    }),
  })
  const res = await liveApi(
    new Request('http://ui/api/test-route', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: '@/whisper/local' }),
    }),
    '/api/test-route',
    env,
  )
  expect(res).toBeInstanceOf(Response)
  expect((await (res as Response).json()) as { status: number }).toMatchObject({ status: 200 })
  expect(posted).toEqual([CONTENT_ENDPOINT_TRANSLATIONS])
  expect(posted).not.toContain(CONTENT_ENDPOINT_CHAT)
})

test('POST /api/secret/clear drops the named item and refuses a body without both names', async () => {
  const cleared: string[] = []
  const env = deps({
    secrets: {
      present: async () => true,
      store: async () => ({ ok: true }),
      clear: async (service, username) => {
        cleared.push(`${service}:${username}`)
        return { ok: true }
      },
    },
  })
  const missing = await liveApi(
    new Request('http://ui/api/secret/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'engined' }),
    }),
    '/api/secret/clear',
    env,
  )
  expect(missing).toBeInstanceOf(Response)
  expect((missing as Response).status).toBe(400)
  expect(cleared).toEqual([])

  const ok = await liveApi(
    new Request('http://ui/api/secret/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'engined', username: 'openai' }),
    }),
    '/api/secret/clear',
    env,
  )
  expect(ok).toBeInstanceOf(Response)
  expect((ok as Response).status).toBe(200)
  expect(cleared).toEqual(['engined:openai'])
})
