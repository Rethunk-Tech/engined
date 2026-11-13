import { expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ConfigsvcDeps } from './configsvcApi.ts'
import { liveApi } from './configsvcLive.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_TRANSLATIONS,
} from './routeServes.ts'
import { ENGINES_ROOT, makeTestRoot } from './test-support.ts'

const asFetch = (
  fn: (input: string | Request | URL, init?: RequestInit) => Promise<Response>,
): typeof fetch => Object.assign(fn, { preconnect: fetch.preconnect })

const TEST_ROOT = makeTestRoot('engined-live-')

function configWithSecret(): string {
  const file = join(mkdtempSync(join(TEST_ROOT, 'cfg-')), 'config.toml')
  writeFileSync(
    file,
    `[[upstream]]
id = "openai"
base_url = "https://api.openai.com/v1"
secret = { service = "openai-api", username = "default", header = "authorization" }
egress = "remote"
`,
  )
  return file
}

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

test('a skip names the served paths unless they are image verbs', async () => {
  const probe = async (id: string, serves: string[]) => {
    const env = deps({
      fetch: asFetch(async (input, init) => {
        if (
          new URL(String(input)).pathname.endsWith('/openai/v1/models') &&
          (init?.method ?? 'GET') === 'GET'
        ) {
          return Response.json({ data: [{ id, serves }] })
        }
        return Response.json({ ok: true })
      }),
    })
    const res = await liveApi(
      new Request('http://ui/api/test-route', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ address: id }),
      }),
      '/api/test-route',
      env,
    )
    return (await (res as Response).json()) as { skipped?: string }
  }
  const agentic = await probe('@/claude/local', ['/v1/agent'])
  expect(agentic.skipped).toContain('/v1/agent')
  expect(agentic.skipped).not.toContain('image')
  const empty = await probe('@/none/local', [])
  expect(empty.skipped).toBe('nothing has no cheap test')
  const images = await probe('@/comfy/local', [CONTENT_ENDPOINT_IMAGES])
  expect(images.skipped).toBe('image routes have no cheap test: one would load the diffusion model')
})

test('POST /api/secret/clear drops the named item and refuses a body without both names', async () => {
  const cleared: string[] = []
  const env = deps({
    configFile: configWithSecret(),
    enginesRoot: ENGINES_ROOT,
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
      body: JSON.stringify({ service: 'openai-api', username: 'default' }),
    }),
    '/api/secret/clear',
    env,
  )
  expect(ok).toBeInstanceOf(Response)
  expect((ok as Response).status).toBe(200)
  expect(cleared).toEqual(['openai-api:default'])

  const unnamed = await liveApi(
    new Request('http://ui/api/secret/clear', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ service: 'gh', username: 'token' }),
    }),
    '/api/secret/clear',
    env,
  )
  expect((unnamed as Response).status).toBe(403)
  expect(cleared).toEqual(['openai-api:default'])
})

test('a malformed percent-escape in an engine id is a 400, not a 500', async () => {
  const env = deps({ configFile: configWithSecret(), enginesRoot: ENGINES_ROOT })
  for (const [method, path] of [
    ['GET', '/api/spec/%E0%A4%A'],
    ['GET', '/api/logs/%E0%A4%A'],
    ['POST', '/api/obtain/%E0%A4%A'],
  ] as const) {
    const res = await liveApi(new Request(`http://ui${path}`, { method }), path, env)
    expect([path, (res as Response).status]).toEqual([path, 400])
  }
})
