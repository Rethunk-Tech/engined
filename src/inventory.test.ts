import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chatRequest } from './doorFixtures.ts'
import { EngineRegistry } from './engines.ts'
import type { Exec as SecretExec } from './exec.ts'
import { decodeAddressSegment, encodeAddressSegment, Inventory } from './inventory.ts'
import { createDoor } from './main.ts'
import { MS_PER_SECOND } from './records.ts'
import type { ModelRow } from './responses.ts'
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

const TEST_ROOT = makeTestRoot('engined-inventory-test-')
const SECRET_VALUE = 'sk-not-a-real-key'
const foundSecret: SecretExec = async () => ({
  stdout: `${SECRET_VALUE}\n`,
  stderr: '',
  exitCode: 0,
})

const SECRET_REF = {
  service: 'svc',
  username: 'user',
  header: 'authorization',
  scheme: 'Bearer',
} as const

describe('address segment encoding', () => {
  test('only a slash becomes %2F, and the reverse restores the provider id', () => {
    expect(encodeAddressSegment('org/model:free')).toBe('org%2Fmodel:free')
    expect(decodeAddressSegment('org%2Fmodel:free')).toBe('org/model:free')
    expect(encodeAddressSegment('plain')).toBe('plain')
    expect(decodeAddressSegment('plain')).toBe('plain')
    expect(encodeAddressSegment('a/b/c')).toBe('a%2Fb%2Fc')
  })

  test('a provider id that already contains %2F, or the wildcard sentinel, is skipped', () => {
    expect(encodeAddressSegment('org%2Fmodel')).toBeUndefined()
    expect(encodeAddressSegment('*')).toBeUndefined()
  })
})

function expiredOpenrouterCache(stateName: string) {
  const stateRoot = join(TEST_ROOT, stateName)
  const cacheDir = join(stateRoot, 'upstreams', 'openrouter')
  mkdirSync(cacheDir, { recursive: true })
  writeFileSync(
    join(cacheDir, 'inventory.json'),
    `${JSON.stringify({ fetched_at: 1, ids: ['org/model:free'] })}\n`,
  )
  return { stateRoot, cacheDir }
}

function openrouterWildcardConfig(catalog: Upstream) {
  return config({
    engines: [engine({ id: 'openrouter', kind: 'openai-http' })],
    upstreams: [catalog],
    routes: [route({ engine: 'openrouter', model: '*', upstream: 'openrouter' })],
  })
}

function catalogUpstream(base: string, maxAge = 86_400): Upstream {
  return upstream({
    id: 'openrouter',
    base_url: base,
    secret: { ...SECRET_REF },
    egress: 'remote',
    inventory_max_age_seconds: maxAge,
  })
}

function modelsList(ids: string[]): Response {
  return Response.json({
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model' })),
  })
}

describe('provider /models inventory', () => {
  test('a fake catalog listing org/model:free is cached as that wire id', async () => {
    const headers: string[] = []
    const fake = startFakeUpstream((req) => {
      headers.push(req.headers.get('authorization') ?? '')
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === '/models') {
        return modelsList(['org/model:free', 'plain', '*', 'already%2Fencoded'])
      }
      return new Response('not found', { status: 404 })
    })
    const stateRoot = join(TEST_ROOT, 'state-ok')
    const inv = new Inventory({ secretExec: foundSecret, stateRoot })
    try {
      const result = await inv.refresh(catalogUpstream(fake.base))
      expect(result.ids).toEqual(['org/model:free', 'plain'])
      expect(result.fetchError).toBeUndefined()
      expect(headers).toEqual([`Bearer ${SECRET_VALUE}`])
      expect(inv.peek(catalogUpstream(fake.base))).toEqual(['org/model:free', 'plain'])
      const onDisk = JSON.parse(
        readFileSync(join(stateRoot, 'upstreams', 'openrouter', 'inventory.json'), 'utf8'),
      ) as { ids: string[]; fetched_at: number }
      expect(onDisk.ids).toEqual(['org/model:free', 'plain'])
      expect(JSON.stringify(onDisk)).not.toContain(SECRET_VALUE)
    } finally {
      fake.stop()
    }
  })

  test('before any successful fetch, peek is empty', () => {
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-empty'),
    })
    expect(inv.peek(catalogUpstream('http://127.0.0.1:1'))).toEqual([])
  })

  test('an empty catalog persists as no ids', async () => {
    const fake = startFakeUpstream((req) => {
      if (req.method === 'GET' && new URL(req.url).pathname === '/models') {
        return modelsList([])
      }
      return new Response('not found', { status: 404 })
    })
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-empty-list'),
    })
    try {
      expect((await inv.refresh(catalogUpstream(fake.base))).ids).toEqual([])
      expect(inv.peek(catalogUpstream(fake.base))).toEqual([])
    } finally {
      fake.stop()
    }
  })

  test('a failed live fetch serves an in-age cache and names the error', async () => {
    let fail = false
    const fake = startFakeUpstream((req) => {
      if (fail) {
        return new Response('nope', { status: 502 })
      }
      if (req.method === 'GET' && new URL(req.url).pathname === '/models') {
        return modelsList(['org/model:free'])
      }
      return new Response('not found', { status: 404 })
    })
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-stale-ok'),
    })
    const u = catalogUpstream(fake.base)
    try {
      await inv.refresh(u)
      fail = true
      const result = await inv.refresh(u)
      expect(result.ids).toEqual(['org/model:free'])
      expect(result.fetchError).toMatch(/HTTP 502/)
    } finally {
      fake.stop()
    }
  })

  test('an expired cache is dropped and expands empty', () => {
    const { stateRoot, cacheDir } = expiredOpenrouterCache('state-expired')
    const now = 10 * MS_PER_SECOND
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot,
      now: () => now,
    })
    const u = catalogUpstream('http://127.0.0.1:1', 5)
    expect(inv.peek(u)).toEqual([])
    expect(existsSync(join(cacheDir, 'inventory.json'))).toBe(false)
  })

  test('a cache file that is not a JSON object is dropped', () => {
    const stateRoot = join(TEST_ROOT, 'state-garbage')
    const cacheDir = join(stateRoot, 'upstreams', 'openrouter')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(join(cacheDir, 'inventory.json'), 'not-json\n')
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot,
      now: () => 10 * MS_PER_SECOND,
    })
    expect(inv.peek(catalogUpstream('http://127.0.0.1:1'))).toEqual([])
    expect(existsSync(join(cacheDir, 'inventory.json'))).toBe(false)
  })

  test('a failed fetch with an expired cache expands empty', async () => {
    const { stateRoot, cacheDir } = expiredOpenrouterCache('state-expired-fetch')
    const fake = startFakeUpstream(() => new Response('nope', { status: 503 }))
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot,
      now: () => 10 * MS_PER_SECOND,
    })
    try {
      const result = await inv.refresh(catalogUpstream(fake.base, 5))
      expect(result.ids).toEqual([])
      expect(result.fetchError).toMatch(/HTTP 503/)
      expect(existsSync(join(cacheDir, 'inventory.json'))).toBe(false)
    } finally {
      fake.stop()
    }
  })

  test('an injected fetch is used instead of the network', async () => {
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-inject'),
      fetch: async () => modelsList(['org/model:free']),
    })
    const result = await inv.refresh(catalogUpstream('https://example.invalid'))
    expect(result.ids).toEqual(['org/model:free'])
  })

  test('catalog fetch does not follow redirects', async () => {
    let redirect: RequestInit['redirect']
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-noredirect'),
      fetch: async (_url, init) => {
        redirect = init?.redirect
        return modelsList(['org/model:free'])
      },
    })
    const result = await inv.refresh(catalogUpstream('https://example.invalid'))
    expect(result.ids).toEqual(['org/model:free'])
    expect(redirect).toBe('error')
  })
})

const DOOR_PORT = 39_219

describe('menu and chat expand a cached catalog', () => {
  test('the menu lists the encoded address and a chat hop sends the wire id', async () => {
    const recorded: Record<string, unknown>[] = []
    const fake = startFakeUpstream(async (req) => {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path.endsWith('/models')) {
        return modelsList(['org/model:free', 'cohere/north-mini-code:free'])
      }
      if (req.method === 'POST') {
        recorded.push((await req.json()) as Record<string, unknown>)
        return Response.json({
          choices: [
            { index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' },
          ],
        })
      }
      return new Response('not found', { status: 404 })
    })
    const catalog = catalogUpstream(`${fake.base}/v1`)
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-door'),
    })
    const cfg = config({
      listen_port: DOOR_PORT,
      engines: [engine({ id: 'openrouter', kind: 'openai-http' })],
      upstreams: [catalog],
      routes: [
        route({ engine: 'openrouter', model: '*', upstream: 'openrouter' }),
        route({
          engine: 'openrouter',
          model: 'north-mini-code:free',
          wire_model: 'cohere/north-mini-code:free',
          upstream: 'openrouter',
        }),
      ],
    })
    const door = createDoor(
      cfg,
      { enginesRoot: '/nonexistent/engines', bunx: BUNX, inventory: inv },
      { secretExec: foundSecret },
    )
    try {
      await inv.refresh(catalog)
      const menu = await door.fetch(new Request(`http://127.0.0.1:${DOOR_PORT}/openai/v1/models`))
      expect(menu.status).toBe(200)
      const body = (await menu.json()) as { data: ModelRow[] }
      const ids = body.data.map((r) => r.id)
      expect(ids).toContain('@/openrouter/org%2Fmodel:free')
      expect(ids).toContain('@/openrouter/north-mini-code:free')
      expect(
        ids.filter((id) => id.includes('north-mini-code') || id.includes('cohere')),
      ).toHaveLength(1)
      expect(ids).not.toContain('@/openrouter/*')

      const chat = await door.fetch(
        chatRequest({
          model: '@/openrouter/org%2Fmodel:free',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      )
      expect(chat.status).toBe(200)
      expect(recorded[0]?.model).toBe('org/model:free')
    } finally {
      fake.stop()
      await door.registry.shutdown()
    }
  })
})

function wildcardRegistry(inv: Inventory, catalog: Upstream): EngineRegistry {
  return new EngineRegistry(openrouterWildcardConfig(catalog), {
    enginesRoot: '/nonexistent/engines',
    bunx: BUNX,
    inventory: inv,
  })
}

describe('inventory refresh timers', () => {
  test('the first refresh does not block, and reload replaces timers rather than stacking them', async () => {
    let release!: (res: Response) => void
    const hung = new Promise<Response>((resolve) => {
      release = resolve
    })
    const catalog = catalogUpstream('https://example.invalid')
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-timers'),
      fetch: async () => hung,
    })
    const reg = wildcardRegistry(inv, catalog)
    try {
      expect(reg.inventoryWatchCount()).toBe(0)
      const before = Date.now()
      reg.startInventoryRefresh()
      expect(Date.now() - before).toBeLessThan(50)
      expect(reg.inventoryWatchCount()).toBe(1)
      const armed = reg.inventoryWatchCount()
      reg.reload(openrouterWildcardConfig(catalog))
      expect(reg.inventoryWatchCount()).toBe(armed)
      await reg.shutdown()
      expect(reg.inventoryWatchCount()).toBe(0)
    } finally {
      release(modelsList(['org/model:free']))
    }
  })

  test('a failed refresh while serving cache sets EngineStatus.fix, until its wildcard route is removed', async () => {
    const live: { fail: boolean } = { fail: false }
    const catalog = catalogUpstream('https://example.invalid')
    const inv = new Inventory({
      secretExec: foundSecret,
      stateRoot: join(TEST_ROOT, 'state-fix'),
      fetch: async () =>
        live.fail ? new Response('nope', { status: 502 }) : modelsList(['org/model:free']),
    })
    await inv.refresh(catalog)
    live.fail = true
    const reg = wildcardRegistry(inv, catalog)
    try {
      expect(reg.get('openrouter')?.fix).toBeUndefined()
      reg.startInventoryRefresh()
      await Bun.sleep(20)
      expect(reg.get('openrouter')?.fix).toMatch(/HTTP 502/)
      expect(reg.get('openrouter')?.state).toBe('installed')

      // The wildcard route removed: nothing will refresh this engine again,
      // so its last fetch error must not stay as its fix.
      reg.reload({ ...openrouterWildcardConfig(catalog), routes: [] })
      expect(reg.get('openrouter')?.fix).toBeUndefined()
    } finally {
      await reg.shutdown()
    }
  })
})
