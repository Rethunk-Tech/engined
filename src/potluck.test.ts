/**
 * A donated credential is an upstream this door can call, a ceiling it will
 * stop at, and a liveness report potluck cannot make on its own.
 */

import { expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { chatRequest, fakeExec } from './doorFixtures.ts'
import { ParseError } from './errors/parse.ts'
import { createDoor } from './main.ts'
import { DonorLedger, MONTHLY_CAP_REACHED } from './potluck.ts'
import {
  BUNX,
  config,
  engine,
  makeTestRoot,
  route,
  startFakeUpstream,
  upstream,
} from './test-support.ts'
import type { Upstream } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-potluck-')
const FINGERPRINT = 'a'.repeat(64)
const SECRET = 'sk-donated'

function donated(base: string, cap?: number): Upstream {
  return upstream({
    id: 'openai-aaaaaaaa',
    egress: 'remote',
    base_url: `${base}/v1`,
    wire: 'openai',
    fingerprint: FINGERPRINT,
    monthly_cap_usd: cap,
    headers: { 'anthropic-version': '2023-06-01' },
    secret: {
      service: 'openai-api',
      username: 'openai-aaaaaaaa',
      header: 'authorization',
      scheme: 'Bearer',
    },
  })
}

test('a potluck upstream block parses fingerprint, headers, and the monthly ceiling', () => {
  const dir = join(TEST_ROOT, 'parse')
  mkdirSync(dir)
  const file = join(dir, 'config.toml')
  writeFileSync(
    file,
    `
[potluck]
callback_url = "https://potluck.example/api/callback/status"
callback_secret = { service = "potluck", username = "callback" }

[[upstream]]
id = "openai-aaaaaaaa"
base_url = "https://api.openai.com/v1"
secret = { service = "openai-api", username = "openai-aaaaaaaa", header = "authorization", scheme = "Bearer" }
egress = "remote"
wire = "openai"
fingerprint = "${FINGERPRINT}"
monthly_cap_usd = 25.00
headers = { "anthropic-version" = "2023-06-01" }
`,
  )
  const cfg = loadConfig(file, dir)
  const [row] = cfg.upstreams
  expect(row?.fingerprint).toBe(FINGERPRINT)
  expect(row?.monthly_cap_usd).toBe(25)
  expect(row?.headers).toEqual({ 'anthropic-version': '2023-06-01' })
  expect(cfg.potluck).toEqual({
    url: 'https://potluck.example/api/callback/status',
    secret: { service: 'potluck', username: 'callback' },
  })

  writeFileSync(file, `[[upstream]]\nid = "x"\negress = "remote"\nfingerprint = "abcd"\n`)
  expect(() => loadConfig(file, dir)).toThrow(ParseError)
})

test('a donated credential serves, reports live, then stops at the ceiling', async () => {
  const reports: {
    fingerprint?: string
    status?: string
    lastUsedAt?: string
    authorization?: string | null
  }[] = []
  const callback = startFakeUpstream(async (req) => {
    const body = (await req.json()) as {
      fingerprint?: string
      status?: string
      lastUsedAt?: string
    }
    reports.push({ ...body, authorization: req.headers.get('authorization') })
    return Response.json({ recorded: true })
  })
  const chats: { version: string | null; authorization: string | null }[] = []
  const provider = startFakeUpstream((req) => {
    const path = new URL(req.url).pathname
    if (path.endsWith('/chat/completions')) {
      chats.push({
        version: req.headers.get('anthropic-version'),
        authorization: req.headers.get('authorization'),
      })
      return Response.json({
        choices: [{ message: { role: 'assistant', content: 'hi' } }],
        usage: { prompt_tokens: 2, completion_tokens: 1, cost: 25 },
      })
    }
    return Response.json({ data: [{ id: 'gpt' }] })
  })
  const state = join(TEST_ROOT, 'state')
  mkdirSync(state)
  const door = createDoor(
    config({
      potluck: {
        url: `${callback.base}/api/callback/status`,
        secret: { service: 'potluck', username: 'callback' },
      },
      engines: [engine({ id: 'hosted', kind: 'openai-http' })],
      upstreams: [donated(provider.base, 25)],
      routes: [route({ engine: 'hosted', model: 'gpt', upstream: 'openai-aaaaaaaa' })],
    }),
    { enginesRoot: '/nonexistent/engines', bunx: BUNX },
    { secretExec: fakeExec(SECRET), usageStateRoot: state, write: () => undefined },
  )
  try {
    const first = await door.fetch(
      chatRequest({ model: '@/hosted/gpt', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(first.status).toBe(200)
    await first.text()
    expect(chats).toEqual([{ version: '2023-06-01', authorization: `Bearer ${SECRET}` }])
    for (let i = 0; i < 50 && reports.length === 0; i += 1) {
      await Bun.sleep(20)
    }
    expect(reports).toHaveLength(1)
    expect(reports[0]?.fingerprint).toBe(FINGERPRINT)
    expect(reports[0]?.status).toBe('live')
    expect(reports[0]?.authorization).toBe(`Bearer ${SECRET}`)
    expect(Date.parse(reports[0]?.lastUsedAt ?? '')).not.toBeNaN()

    const second = await door.fetch(
      chatRequest({ model: '@/hosted/gpt', messages: [{ role: 'user', content: 'again' }] }),
    )
    expect(second.status).toBe(402)
    const blocked = (await second.json()) as { error?: { message?: string } }
    expect(blocked.error?.message).toContain(MONTHLY_CAP_REACHED)
    expect(chats).toHaveLength(1)
  } finally {
    provider.stop()
    callback.stop()
    await door.registry.shutdown()
  }
})

test('a provider 401 is reported dead and a ceiling refusal is not', async () => {
  const reports: string[] = []
  const callback = startFakeUpstream(async (req) => {
    const body = (await req.json()) as { status?: string }
    reports.push(body.status ?? '')
    return Response.json({ recorded: true })
  })
  const provider = startFakeUpstream(
    () => new Response('revoked', { status: 401, headers: { 'content-type': 'text/plain' } }),
  )
  const ledger = new DonorLedger({
    stateRoot: join(TEST_ROOT, 'dead'),
    now: () => Date.UTC(2026, 9, 1),
  })
  const row = donated('http://127.0.0.1:9', 1)
  ledger.note(row.id, 1, Date.UTC(2026, 9, 1))
  expect(ledger.refusal(row, Date.UTC(2026, 9, 1))).toContain(MONTHLY_CAP_REACHED)
  expect(ledger.refusal(row, Date.UTC(2026, 10, 1))).toBeUndefined()

  const door = createDoor(
    config({
      potluck: {
        url: `${callback.base}/api/callback/status`,
        secret: { service: 'potluck', username: 'callback' },
      },
      engines: [engine({ id: 'hosted', kind: 'openai-http' })],
      upstreams: [donated(provider.base)],
      routes: [route({ engine: 'hosted', model: 'gpt', upstream: 'openai-aaaaaaaa' })],
    }),
    { enginesRoot: '/nonexistent/engines', bunx: BUNX },
    {
      secretExec: fakeExec(SECRET),
      usageStateRoot: join(TEST_ROOT, 'dead-state'),
      write: () => undefined,
    },
  )
  try {
    const res = await door.fetch(
      chatRequest({ model: '@/hosted/gpt', messages: [{ role: 'user', content: 'hi' }] }),
    )
    expect(res.status).toBe(401)
    await res.text()
    for (let i = 0; i < 50 && reports.length === 0; i += 1) {
      await Bun.sleep(20)
    }
    expect(reports).toEqual(['dead'])
  } finally {
    provider.stop()
    callback.stop()
    await door.registry.shutdown()
  }
})
