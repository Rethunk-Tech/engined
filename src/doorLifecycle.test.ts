import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { chatRequest, createLlamaDoor, LOCAL_LLAMA_SPEC } from './doorFixtures.ts'
import type { HttpClient } from './http.ts'
import { bindDualFamily, createDoor, type Door, resolveBunx } from './main.ts'
import { BUNX, config, deadPort, makeTestRoot, writeEngineSpec } from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-door-test-')

/**
 * Binds the door on both loopback families on `port`, through `main.ts`'s
 * own `bindDualFamily` rather than a hand-rolled `Bun.serve` pair — a
 * substitute here would pass even with the real `::1` listener deleted. The
 * check needs `config.listen_port` to equal it, so the caller picks the port
 * first via `deadPort()` and builds both the config and this bind from it.
 */
function startDualBind(fetch: Door['fetch'], port: number): { stop: () => void } {
  const { v4, v6 } = bindDualFamily(fetch, port)
  return {
    stop: () => {
      v4.stop()
      v6.stop()
    },
  }
}

/** `Host` is a forbidden header for the Fetch API; `node:http` allows the override the test needs. */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
  hostname = '127.0.0.1',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: 'GET', headers }, (res) => {
      let body = ''
      res.on('data', (chunk: Buffer) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

/** Every Origin/Host/dual-bind check binds a real door on an ephemeral port for `fn`'s duration, then tears it down; only the config and the request/assertion differ. */
async function withBoundDoor<T>(cfg: Config, fn: (port: number) => Promise<T>): Promise<T> {
  const door = createDoor(cfg, { enginesRoot: '/nonexistent', bunx: BUNX })
  const bound = startDualBind(door.fetch, cfg.listen_port)
  try {
    return await fn(cfg.listen_port)
  } finally {
    bound.stop()
  }
}

describe('the door: Origin/Host check', () => {
  // The foreign-Origin, Origin:null and clean-request cases are covered by
  // integration.test.ts's own Origin guard test; `Host` is Fetch-forbidden,
  // so only this real-socket, raw `node:http` request can exercise it.
  test('a Host outside the loopback set is refused, on a GET', async () => {
    const port = deadPort()
    await withBoundDoor(config({ listen_port: port }), async () => {
      const res = await rawRequest(port, '/openai/v1/models', { Host: `evil.example:${port}` })
      expect(res.status).toBe(403)
    })
  })
})

describe('the door: dual-family bind', () => {
  test('both 127.0.0.1 and [::1] answer on the same configured port', async () => {
    const port = deadPort()
    await withBoundDoor(config({ listen_port: port }), async () => {
      const v4 = await rawRequest(port, '/openai/v1/models', {})
      const v6 = await rawRequest(port, '/openai/v1/models', {}, '::1')
      expect(v4.status).toBe(200)
      expect(v6.status).toBe(200)
    })
  })
})

describe('the door: SIGHUP reload', () => {
  // A spec-less kind (never reads a spec file, so "/nonexistent" below is
  // fine) with a modelless route: the parse-tier split already forbids
  // filename/role on it, so there is nothing left for the kind-dependent
  // registry check to gate.
  const GoodConfig = `
[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "claude"
kind = "stt"

[[route]]
engine = "claude"
upstream = "local"
`

  test('broken TOML on reload keeps the previous config serving and names the parse error', async () => {
    const dir = mkdtempSync(join(TEST_ROOT, 'engined-reload-'))
    const path = join(dir, 'config.toml')
    writeFileSync(path, GoodConfig)

    const door = createDoor(loadConfig(path), {
      enginesRoot: '/nonexistent',
      bunx: BUNX,
    })
    const before = (await (
      await door.fetch(new Request('http://engined/engined/v1/engines'))
    ).json()) as {
      engines: { id: string }[]
    }
    expect(before.engines.map((e) => e.id)).toEqual(['claude'])

    writeFileSync(path, 'not valid toml {{{')
    door.reload(path)

    expect(door.configError()).toBeDefined()
    const after = (await (
      await door.fetch(new Request('http://engined/engined/v1/engines'))
    ).json()) as {
      engines: { id: string }[]
      config_error: string
    }
    // Previous config still serving: the same engine, not an empty list.
    expect(after.engines.map((e) => e.id)).toEqual(['claude'])
    expect(after.config_error).toBeDefined()
    expect(after.config_error).toContain(path)
  })
})

function llamaTomlConfig(modelsDir: string): string {
  return `
[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "local-llama"
models_dir = "${modelsDir}"

[[route]]
engine = "local-llama"
upstream = "local"
model = "ornith"
filename = "x.gguf"
role = "chat"

[[route]]
engine = "local-llama"
upstream = "local"
model = "other"
filename = "y.gguf"
role = "chat"
`
}

/** A fresh root/spec.toml plus an on-disk config.toml naming "ornith" and "other", both real files backing the same local-llama engine -- the reload-race test's own on-disk config, since it must go through `door.reload(path)`, not the in-memory `Config` shortcut. */
function setupReloadRaceConfig(): { root: string; configFilePath: string } {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  const modelsDir = mkdtempSync(join(TEST_ROOT, 'engined-models-'))
  writeFileSync(join(modelsDir, 'x.gguf'), '')
  writeFileSync(join(modelsDir, 'y.gguf'), '')
  const configDir = mkdtempSync(join(TEST_ROOT, 'engined-config-'))
  const configFilePath = join(configDir, 'config.toml')
  writeFileSync(configFilePath, llamaTomlConfig(modelsDir))
  return { root, configFilePath }
}

/**
 * Answers the real b10354 load/unload/`/openai/v1/models` contract by replaying
 * `calls`'s own load history, and gates the "ornith" chat call on `gate` so
 * the reload race has a window to land while that lease is still held.
 */
function makeReloadRaceClient(
  calls: string[],
  gate: Promise<void>,
  ornithStarted: () => void,
): HttpClient {
  return async (url, init) => {
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : undefined
    if (url.endsWith('/models/load')) {
      calls.push(`load:${body?.model}`)
      return Response.json({ success: true })
    }
    if (url.endsWith('/models/unload')) {
      calls.push(`unload:${body?.model}`)
      return Response.json({ status: 'ok' })
    }
    if (url.endsWith('/v1/models')) {
      const lastLoad = [...calls]
        .reverse()
        .find((c) => c.startsWith('load:'))
        ?.slice(5)
      return Response.json({
        data: lastLoad === undefined ? [] : [{ id: lastLoad, status: { value: 'loaded' } }],
      })
    }
    // The chat completion call itself.
    if (body?.model === 'ornith') {
      calls.push('chat-start:ornith')
      ornithStarted()
      await gate
      calls.push('chat-end:ornith')
      return Response.json({ id: 'r1', choices: [{ message: { content: 'ornith-answer' } }] })
    }
    calls.push('chat:other')
    return Response.json({ id: 'r2', choices: [{ message: { content: 'other-answer' } }] })
  }
}

describe('the door: reload mid in-flight request', () => {
  /**
   * In-flight leases finish against the engine list they started on. A reload
   * must keep routing new requests through the existing `LlamaRouter` until
   * that router's own leases drain: a replacement router starts with empty
   * occupancy bookkeeping, so it would be a second, ignorant tracker over the
   * same container, free to unload/load a model the first request is still
   * being served from. A same-role request for a different model therefore
   * queues behind the one in flight rather than racing it on a second tracker.
   */
  test('a same-role request for a different model still queues behind one already in flight, even after a reload lands between them', async () => {
    const { root, configFilePath } = setupReloadRaceConfig()

    const calls: string[] = []
    let releaseOrnith: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      releaseOrnith = r
    })
    let ornithStarted: () => void = () => undefined
    const ornithStartedPromise = new Promise<void>((r) => {
      ornithStarted = r
    })
    const client = makeReloadRaceClient(calls, gate, ornithStarted)
    const door = createLlamaDoor(loadConfig(configFilePath), root, {
      llamaHttpClient: client,
      write: () => undefined,
    })

    const ornithReq = door.fetch(
      chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
    )
    await ornithStartedPromise

    // The reload lands while ornith's lease is still held -- same file,
    // content unchanged, only to exercise the router-cache swap itself.
    door.reload(configFilePath)

    const otherReq = door.fetch(
      chatRequest({ model: '@/local-llama/other', messages: [{ role: 'user', content: 'hi' }] }),
    )
    // Let the pump run as far as it can while ornith's lease is still held.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    const otherTouchedWhileOrnithHeld = calls.some((c) => c.includes('other'))
    expect(otherTouchedWhileOrnithHeld).toBe(false)

    releaseOrnith()
    const ornithBody = (await (await ornithReq).json()) as {
      choices: { message: { content: string } }[]
    }
    const otherBody = (await (await otherReq).json()) as {
      choices: { message: { content: string } }[]
    }
    expect(ornithBody.choices[0]?.message.content).toBe('ornith-answer')
    expect(otherBody.choices[0]?.message.content).toBe('other-answer')

    // Whatever "other" activity happened, it is strictly after ornith's own
    // chat call ended -- a real, serialized swap, not a race against it.
    const chatEndIdx = calls.indexOf('chat-end:ornith')
    const otherActivityIdx = calls.findIndex((c) => c.includes('other'))
    expect(chatEndIdx).toBeGreaterThan(-1)
    expect(otherActivityIdx).toBeGreaterThan(chatEndIdx)
  })
})

const RX_ENGINED_BUNX_UNSET = /ENGINED_BUNX is not set/

describe('resolveBunx: the ENGINED_BUNX invariant', () => {
  const noBunxOnPath = () => null

  test('ENGINED_BUNX set is used verbatim, PATH never consulted', () => {
    const which = (cmd: string) => {
      throw new Error(`which() must not be called when ENGINED_BUNX is set, got: ${cmd}`)
    }
    expect(resolveBunx({ ENGINED_BUNX: '/opt/engined/state/bunx' }, which)).toBe(
      '/opt/engined/state/bunx',
    )
  })

  test('ENGINED_BUNX unset falls back to PATH -- the legitimate working-tree dev-run path', () => {
    const which = (cmd: string) => (cmd === 'bunx' ? '/home/dev/.bun/bin/bunx' : null)
    expect(resolveBunx({}, which)).toBe('/home/dev/.bun/bin/bunx')
  })

  test('ENGINED_BUNX empty string is treated the same as unset, not used verbatim', () => {
    const which = () => '/home/dev/.bun/bin/bunx'
    expect(resolveBunx({ ENGINED_BUNX: '' }, which)).toBe('/home/dev/.bun/bin/bunx')
  })

  /**
   * An unresolvable bunx has to be fatal here. A `?? "bunx"` style fallback is
   * always a truthy string, so it would defer the failure to spawn time with no
   * indication of which of the two lookups came up empty.
   */
  test('neither ENGINED_BUNX nor a PATH bunx is fatal', () => {
    expect(() => resolveBunx({}, noBunxOnPath)).toThrow(RX_ENGINED_BUNX_UNSET)
  })
})
