import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { join } from 'node:path'
import type { AgenticSpawn } from './agentic.ts'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import { loadConfig } from './config.ts'
import { NAME_PREFIX } from './docker.ts'
import type { DoorOptions } from './doorContext.ts'
import {
  CLAUDE_SPEC,
  chatRequest,
  claudeEngine,
  createLlamaDoor,
  fakeExec,
  LOCAL_LLAMA_SPEC,
  llamaDoorConfig,
  makeLlamaHttpClient,
  PASSING_PROBE,
  READY_200,
  startRequest,
} from './doorFixtures.ts'
import type { Exec } from './exec.ts'
import { timeoutSecondsForKind } from './hop.ts'
import type { HttpClient } from './http.ts'
import { bindDualFamily, createDoor, type Door, resolveBunx } from './main.ts'
import {
  assertReportedAndResident,
  BUNX,
  buildExec,
  clearVerifiedVersion,
  collectLines,
  config,
  deadPort,
  engine,
  llamaControlPlane,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  tempPresetPath,
  upstream,
  writeEngineSpec,
} from './test-support.ts'
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
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        let body = ''
        res.on('data', (chunk: Buffer) => {
          body += chunk
        })
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      },
    )
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
      const v4 = await fetch(`http://127.0.0.1:${port}/openai/v1/models`)
      const v6 = await fetch(`http://[::1]:${port}/openai/v1/models`)
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

/** models_dir for its own bind mount, zero `[[model]]` rows. */
const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "ghcr.io/example/comfy@sha256:bbbb"
obtain = "pull"
serves = []
command = []

[ready]
path = "/queue"
status = 200
`

/** A real `config.toml` on disk, for a test that must go through `door.reload(path)` -- not the in-memory `Config` shortcut `llamaDoorConfig` uses. */
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

describe("timeoutSecondsForKind: the budget follows the hop's own engine kind", () => {
  test('an agentic-cli hop gets agent_timeout_seconds', () => {
    const cfg = config({ chat_timeout_seconds: 30, agent_timeout_seconds: 3600 })
    expect(timeoutSecondsForKind('agentic-cli', cfg)).toBe(3600)
  })

  test('every other kind gets chat_timeout_seconds -- including inside a chain', () => {
    const cfg = config({ chat_timeout_seconds: 30, agent_timeout_seconds: 3600 })
    expect(timeoutSecondsForKind('openai-http', cfg)).toBe(30)
    expect(timeoutSecondsForKind('tts', cfg)).toBe(30)
    expect(timeoutSecondsForKind(undefined, cfg)).toBe(30)
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

describe('the door: chain timeout follows the hop, not the chain', () => {
  /**
   * `chat_timeout_seconds` is scoped to "one engine," per attempt, and being
   * part of a chain does not widen it: `chatTimeoutMs` owes
   * `agent_timeout_seconds` only to a hop that is itself agentic, so a chain
   * with no agentic hop anywhere in it never inherits the long agentic budget
   * it does not need. `chat_timeout_seconds` is set well under the
   * upstream's artificial delay and `agent_timeout_seconds` well over it, so
   * the outcome (timeout vs success) proves which budget actually applied.
   */
  test('a chain with no agentic hop times out on chat_timeout_seconds rather than surviving on agent_timeout_seconds', async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
    const UpstreamDelayMs = 150
    const cfg = config({
      chat_timeout_seconds: 0.05,
      agent_timeout_seconds: 10,
      engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
      routes: [route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat' })],
      chains: { 'chain-x': ['@/local-llama/ornith'] },
    })
    const client: HttpClient = (url, init) => {
      if (url.endsWith('/models/load')) {
        return Promise.resolve(Response.json({ success: true }))
      }
      if (url.endsWith('/models/unload')) {
        return Promise.resolve(Response.json({ status: 'ok' }))
      }
      if (url.endsWith('/v1/models')) {
        return Promise.resolve(
          Response.json({ data: [{ id: 'ornith', status: { value: 'loaded' } }] }),
        )
      }
      // The chat completion call itself: artificially slow, and it actually
      // honours cancellation -- the real thing the fix has to reach in order
      // to matter, not just the number chatTimeoutMs computes.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ id: 'r1', choices: [{ message: { content: 'hi' } }] })),
          UpstreamDelayMs,
        )
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer)
          reject(new Error('aborted'))
        })
      })
    }
    const { lines, write } = collectLines()
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: client,
      write,
    })

    const res = await door.fetch(
      chatRequest({ model: 'chain-x', messages: [{ role: 'user', content: 'hi' }] }),
    )
    await res.text()

    expect(res.status).toBe(503)
    expect(soleProvenanceRecord(lines).attempts[0]?.failure).toBe('timeout')
  })
})

/** Same shape as `llamaDoorConfig`, plus a comfy engine alongside it -- a second no-egress, models_dir engine with no `[[model]]` naming it. */
function llamaDoorConfigWithComfy(): { cfg: Config; root: string } {
  const { cfg, root } = llamaDoorConfig(TEST_ROOT)
  writeEngineSpec(root, 'comfy', COMFY_SPEC)
  return {
    cfg: {
      ...cfg,
      engines: [...cfg.engines, engine({ id: 'comfy', models_dir: '/data/comfy' })],
    },
    root,
  }
}

describe('the door: a JSON body that is not a table is a 400', () => {
  // Each of these is valid JSON, so parsing cannot reject them -- only the
  // table check can. `null` is the one a `typeof body === "object"` guard
  // would wave through to a property read.
  const NotATable = ['null', '[]', '42', '"hi"']
  const BodyRoutes = ['/openai/v1/chat/completions', '/engined/v1/start']

  for (const pathname of BodyRoutes) {
    for (const raw of NotATable) {
      test(`${pathname} refuses ${raw}`, async () => {
        const door = createDoor(config(), { enginesRoot: '/nonexistent', bunx: BUNX })
        const res = await door.fetch(
          new Request(`http://engined${pathname}`, { method: 'POST', body: raw }),
        )
        expect(res.status).toBe(400)
        expect(await res.json()).toEqual({ error: 'invalid JSON body' })
      })
    }
  }
})

describe('the door: content routing', () => {
  test('a chat against a resolvable llama model reaches the router and returns its body', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const recorded: { body: string }[] = []
    const { lines, write } = collectLines()
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write,
    })
    const res = await door.fetch(
      chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
    )
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(body.choices[0]?.message.content).toBe('hi')
    expect(soleProvenanceRecord(lines).engine_used).toBe('local-llama')
  })

  test('workdir is stripped and reasoning_effort passes through to an openai-http hop', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const recorded: { body: string }[] = []
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write: () => undefined,
    })
    const res = await door.fetch(
      chatRequest({
        model: '@/local-llama/ornith',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/should/not/reach/llama',
        reasoning_effort: 'high',
      }),
    )
    // The response is a lazily-produced stream: reading it to completion is
    // what actually drives `runLease`'s upstream call, the same as a real
    // consumer would.
    await res.text()
    expect(recorded).toHaveLength(1)
    const forwarded = JSON.parse(recorded[0]?.body ?? '{}') as Record<string, unknown>
    expect(forwarded.workdir).toBeUndefined()
    expect(forwarded.reasoning_effort).toBe('high')
  })
})

describe('the door: answering-route headers', () => {
  test('a buffered chat reply names the answering route, upstream, and egress', async () => {
    const { cfg: base, root } = llamaDoorConfig(TEST_ROOT)
    const cfg = { ...base, upstreams: [upstream()] }
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient([]),
      write: () => undefined,
    })
    const res = await door.fetch(
      chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
    )
    await res.json()
    expect(res.headers.get('x-engined-route')).toBe('@/local-llama/local/ornith')
    expect(res.headers.get('x-engined-upstream')).toBe('local')
    expect(res.headers.get('x-engined-egress')).toBe('none')
    expect(res.headers.get('x-engined-chain')).toBeNull()
  })

  test('a streamed chat reply carries the same headers before the body resolves', async () => {
    const { cfg: base, root } = streamingDoorConfig()
    const cfg = { ...base, upstreams: [upstream()] }
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write: () => undefined,
    })
    // Headers are already on the `Response` before the stream is read at
    // all -- the whole point of committing to a hop before the body flows.
    expect(res.headers.get('x-engined-route')).toBe('@/local-llama/local/ornith')
    expect(res.headers.get('x-engined-egress')).toBe('none')
    await res.text()
  })

  test('a chain that falls over to its second hop names the second hop, not the first', async () => {
    const { cfg: base, root } = twoEngineDoorConfig()
    const cfg = { ...base, upstreams: [upstream()] }
    const door = createLlamaDoor(
      cfg,
      root,
      { llamaHttpClient: makeSplitHttpClient(500, [], []), write: () => undefined },
      twoEngineExec(),
    )
    const res = await door.fetch(
      chatRequest({ model: 'chain-failover', messages: [{ role: 'user', content: 'hi' }] }),
    )
    await res.json()
    expect(res.headers.get('x-engined-route')).toBe('@/llama-live/live-model')
    expect(res.headers.get('x-engined-chain')).toBe('chain-failover')
    expect(res.headers.get('x-engined-egress')).toBe('none')
  })

  test('a chain nothing in it can answer carries no answering-route headers', async () => {
    const { cfg: base, root } = twoEngineDoorConfig()
    const cfg = { ...base, upstreams: [upstream()] }
    const control = llamaControlPlane()
    const everyHopFails: HttpClient = (url, init) => {
      const controlled = control(url, init)
      if (controlled) {
        return Promise.resolve(controlled)
      }
      return Promise.resolve(Response.json({ error: 'dead' }, { status: 500 }))
    }
    const door = createLlamaDoor(
      cfg,
      root,
      { llamaHttpClient: everyHopFails, write: () => undefined },
      twoEngineExec(),
    )
    const res = await door.fetch(
      chatRequest({ model: 'chain-failover', messages: [{ role: 'user', content: 'hi' }] }),
    )
    await res.json()
    expect(res.status).toBe(503)
    expect(res.headers.get('x-engined-route')).toBeNull()
    expect(res.headers.get('x-engined-chain')).toBeNull()
  })
})

/**
 * `/models/load` and `/models/unload` always succeed; `/openai/v1/models` reports whichever id last
 * loaded: "ornith" while `loadAndWait` is still polling, so the proxy can
 * proceed, and "ornith-real" once the chat has answered -- standing in for the
 * GGUF that actually served it, read fresh per attempt rather than copied from
 * what the chat response echoed. `undefined` means the url is the chat call
 * itself, for the caller to answer.
 */
function llamaLifecycleResponse(url: string, chatAnswered: boolean): Response | undefined {
  if (url.endsWith('/models/load')) {
    return Response.json({ success: true })
  }
  if (url.endsWith('/models/unload')) {
    return Response.json({ status: 'ok' })
  }
  if (url.endsWith('/v1/models')) {
    const id = chatAnswered ? 'ornith-real' : 'ornith'
    return Response.json({ data: [{ id, status: { value: 'loaded' } }] })
  }
  return undefined
}

function makeStaleReportedHttpClient(): HttpClient {
  let chatAnswered = false
  return (url: string) => {
    const lifecycle = llamaLifecycleResponse(url, chatAnswered)
    if (lifecycle) {
      return Promise.resolve(lifecycle)
    }
    chatAnswered = true
    // The engine echoes the router id it was given back in `model` -- the
    // INI section name, never the GGUF that actually answered.
    return Promise.resolve(
      Response.json({ id: 'resp-1', model: 'ornith', choices: [{ message: { content: 'hi' } }] }),
    )
  }
}

/**
 * Mirrors `makeStaleReportedHttpClient`, but the chat call answers as a
 * chunked SSE stream instead of one JSON body -- each element of `chunks` is
 * enqueued as its own `ReadableStream` write, so a frame split across chunk
 * boundaries is exercised the same way a real upstream would split it.
 */
function makeStreamingReportedHttpClient(chunks: string[]): HttpClient {
  let chatAnswered = false
  return (url: string) => {
    const lifecycle = llamaLifecycleResponse(url, chatAnswered)
    if (lifecycle) {
      return Promise.resolve(lifecycle)
    }
    chatAnswered = true
    const encoder = new TextEncoder()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk))
        }
        controller.close()
      },
    })
    return Promise.resolve(
      new Response(stream, { headers: { 'content-type': 'text/event-stream' } }),
    )
  }
}

/** Two models on one role, same shape as the provenance fixture above, so `model_reported` and `model_resident` are guaranteed to differ. */
function streamingDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_SPEC)
  const cfg = config({
    engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
    routes: [
      route({ engine: 'local-llama', model: 'ornith', filename: 'ornith.gguf', role: 'chat' }),
      route({
        engine: 'local-llama',
        model: 'ornith-real',
        filename: 'ornith-real.gguf',
        role: 'chat',
      }),
    ],
  })
  return { cfg, root }
}

const STREAM_REQUEST_BODY = JSON.stringify({
  model: '@/local-llama/ornith',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
})

/** A fresh `LlamaRouter`'s first streaming call always emits this ahead of the real bytes -- see `emitWarming` in llama.ts. Asserted here, not worked around, so the byte-identity check covers it too. */
const WARMING_COMMENT = ': warming\n\n'

/** Every streaming-provenance test sends the same request through a fresh llama door; only the upstream chunks, the door's `write` sink and the assertion differ. */
function fetchStreamChat(cfg: Config, root: string, doorOpts: DoorOptions): Promise<Response> {
  return Promise.resolve(
    createLlamaDoor(cfg, root, doorOpts).fetch(
      new Request('http://engined/openai/v1/chat/completions', {
        method: 'POST',
        body: STREAM_REQUEST_BODY,
      }),
    ),
  )
}

describe('the door: streaming provenance', () => {
  test('a streaming llama hop records model_reported from the first SSE frame, and it differs from model_resident', async () => {
    const { cfg, root } = streamingDoorConfig()
    const { lines, write } = collectLines()
    const chunks = [
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write,
    })
    await res.text()
    assertReportedAndResident(lines, 'ornith', 'ornith-real')
  })

  test("the caller's stream is byte-identical to what the upstream sent, tee in place", async () => {
    const { cfg, root } = streamingDoorConfig()
    const chunks = [
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write: () => undefined,
    })
    const body = await res.text()
    expect(body).toBe(WARMING_COMMENT + chunks.join(''))
  })

  test('a stream whose frames carry no model id leaves model_reported absent, and the response still completes', async () => {
    const { cfg, root } = streamingDoorConfig()
    const { lines, write } = collectLines()
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      'data: [DONE]\n\n',
    ]
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write,
    })
    const body = await res.text()
    expect(body).toBe(WARMING_COMMENT + chunks.join(''))
    expect(soleProvenanceRecord(lines).attempts[0]?.model_reported).toBeUndefined()
  })
})

describe('the door: provenance model fields', () => {
  test('a completed llama hop carries model_reported and model_resident, and they differ', async () => {
    const { cfg, root } = streamingDoorConfig()
    const { lines, write } = collectLines()
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeStaleReportedHttpClient(),
      write,
    })
    const res = await door.fetch(
      chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
    )
    // Draining the body is what completes the underlying stream and fires
    // the deferred provenance line, same as a real consumer reading it.
    await res.json()
    assertReportedAndResident(lines, 'ornith', 'ornith-real')
  })
})

describe('the door: agentic and chain routing', () => {
  // The 400-without-workdir shape itself is covered by two survivors:
  // agentic.test.ts's "runAgentic: workdir absent is 400 and never spawns"
  // (the function, including the never-spawns assertion) and
  // integration.test.ts's "an agentic attempt with no workdir returns 400"
  // (the same rejection through a real door).

  test('an unproved agentic engine does not spawn', async () => {
    const id = 'claude-unproved'
    clearVerifiedVersion(id)
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, id, CLAUDE_SPEC)
    const cfg = config({
      routes: [route({ engine: id, model: 'assistant', upstream: null })],
      engines: [engine({ id, agent_version: '9.9.9' })],
    })
    const spawnCalls: unknown[] = []
    const fakeSpawn: AgenticSpawn = (argv, opts) => {
      spawnCalls.push({ argv, opts })
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"hi"}',
        stderr: '',
        exitCode: 0,
      })
    }
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX },
      { agenticSpawn: fakeSpawn, write: () => undefined },
    )
    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/tmp',
      }),
    )
    // A lone-hop dispatch that fails now advances like any other unavailable
    // engine (finding 1), so it lands in runChain's own generic "every
    // engine in this chain failed" exhaustion body -- the same wrapping the
    // secret-resolution path's equivalent 503 already goes through. The
    // per-engine fix text (naming `id` and "9.9.9") still exists, just on
    // the `HopResult` before runChain gets it; see `execAgentic`'s proof-gate
    // branch and the "missing secret" test below for that assertion.
    expect(res.status).toBe(503)
    expect(spawnCalls).toHaveLength(0)
  })
})

describe('the door: chain skips an engine that fails its version proof', () => {
  /**
   * A chain skips an unavailable engine. An engine that
   * cannot prove its agent_version pin is exactly "unavailable" -- the
   * same 503 the secret-resolution path already produces (`resolveRedirect`,
   * plain 503, no `envelopeFailure`) and the chain advances past that one.
   * The version-proof 503 has to stay envelope-free for the same reason:
   * `classifyResult` treats `envelopeFailure` as never-advancing regardless of
   * status, which would make the first hop terminal instead of skipped.
   */
  test('a chain whose first hop fails its version proof advances to the second hop', async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    for (const id of ['claude-unproved', 'claude-b']) {
      writeEngineSpec(root, id, CLAUDE_SPEC)
    }
    clearVerifiedVersion('claude-unproved')
    clearVerifiedVersion('claude-b')
    const cfg = config({
      engines: [
        engine({ id: 'claude-unproved', agent_version: '1.2.3' }),
        engine({ id: 'claude-b', agent_version: '4.5.6' }),
      ],
      chains: { 'chain-x': ['@/claude-unproved/x', '@/claude-b/y'] },
    })
    // Only claude-b's pin is provable -- claude-unproved's proof always
    // fails, the same as the standalone "unproved agentic engine" test above.
    const probeRunner: AgenticProbeRunner = (version) =>
      Promise.resolve(version === '4.5.6' ? { ok: true } : { ok: false, failedProbe: 'boom' })
    const hopBCalls: string[][] = []
    const spawn: AgenticSpawn = (argv) => {
      hopBCalls.push(argv)
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"hi"}',
        stderr: '',
        exitCode: 0,
      })
    }
    const { lines, write } = collectLines()
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: probeRunner },
      { agenticSpawn: spawn, write },
    )
    const res = await door.fetch(
      chatRequest({
        model: 'chain-x',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/tmp',
      }),
    )
    expect(res.status).toBe(200)
    expect(hopBCalls).toHaveLength(1)
    expect(hopBCalls[0]).toContain('@anthropic-ai/claude-code@4.5.6')
    expect(soleProvenanceRecord(lines).engine_used).toBe('claude-b')
    clearVerifiedVersion('claude-unproved')
    clearVerifiedVersion('claude-b')
  })
})

describe("the door: an agentic hop's own timeout actually aborts it", () => {
  /**
   * agent_timeout_seconds is computed, threaded through runOneHop's per-hop
   * timeout, and then reached a spawn that never listened for it -- so a
   * hung `claude -p` held its chain slot forever regardless of the budget.
   * This spawn double never resolves on its own, only on `opts.signal`
   * firing -- exactly what the real `defaultAgenticSpawn` now does, and
   * exactly what exposes whether the signal actually reaches it: with the
   * old, unwired `execAgentic`/`buildHopExec`, `opts.signal` is undefined
   * here and this promise never settles, so the request hangs until bun's
   * own test timeout fails it rather than the door's short budget.
   */
  test('a hung agentic spawn is aborted by agent_timeout_seconds instead of holding its slot forever', async () => {
    const id = 'claude-hangs'
    clearVerifiedVersion(id)
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, id, CLAUDE_SPEC)
    const workdir = mkdtempSync(join(TEST_ROOT, 'engined-workdir-'))
    const cfg = config({
      routes: [route({ engine: id, model: 'assistant', upstream: null })],
      // Well under bun's own per-test timeout, so a correct fix resolves
      // fast and a regression fails this test rather than hanging the suite.
      agent_timeout_seconds: 0.05,
      engines: [engine({ id, agent_version: '1.2.3' })],
    })
    const spawn: AgenticSpawn = (_argv, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const { lines, write } = collectLines()
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { agenticSpawn: spawn, write },
    )

    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: 'user', content: 'hi' }],
        workdir,
      }),
    )
    await res.text()

    expect(res.status).toBe(503)
    expect(soleProvenanceRecord(lines).attempts[0]?.failure).toBe('timeout')
    clearVerifiedVersion(id)
  })
})

describe('the door: chain routing', () => {
  test("a chain whose first hop's envelope fails is terminal there: the second hop's own spawn log stays empty", async () => {
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    for (const id of ['claude-a', 'claude-b']) {
      writeEngineSpec(root, id, CLAUDE_SPEC)
    }
    clearVerifiedVersion('claude-a')
    clearVerifiedVersion('claude-b')
    // Distinct pins so one shared spawn can tell the hops apart by argv and
    // keep a separate call log per hop -- the discriminating assertion is
    // against the next hop's own log, not the response status.
    const cfg = config({
      engines: [
        engine({ id: 'claude-a', agent_version: '1.2.3' }),
        engine({ id: 'claude-b', agent_version: '4.5.6' }),
      ],
      chains: { 'chain-x': ['@/claude-a/x', '@/claude-b/y'] },
    })
    const hopACalls: string[][] = []
    const hopBCalls: string[][] = []
    // claude-a's stdout fails to parse -- a proven envelope failure, terminal
    // regardless of status, never a transport error a retry might route around.
    const spawn: AgenticSpawn = (argv) => {
      ;(argv.includes('@anthropic-ai/claude-code@1.2.3') ? hopACalls : hopBCalls).push(argv)
      return Promise.resolve({ stdout: 'not json', stderr: '', exitCode: 0 })
    }
    const { lines, write } = collectLines()
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { agenticSpawn: spawn, write },
    )
    const res = await door.fetch(
      chatRequest({
        model: 'chain-x',
        messages: [{ role: 'user', content: 'hi' }],
        workdir: '/tmp',
      }),
    )
    expect(res.status).toBe(502)
    expect(hopACalls).toHaveLength(1)
    expect(hopBCalls).toHaveLength(0)
    const record = soleProvenanceRecord(lines)
    expect(record.engine_used).toBe('claude-a')
    expect(record.attempts).toHaveLength(1)
    expect(record.attempts[0]).toMatchObject({ engine: 'claude-a', ok: false })
    clearVerifiedVersion('claude-a')
    clearVerifiedVersion('claude-b')
  })
})

const FAILOVER_DEAD_PORT = 46_001
const FAILOVER_LIVE_PORT = 46_002

/** One shared docker fake for two engines, distinguished by the container name docker.ts always passes. */
function twoEngineExec(): Exec {
  return buildExec({
    portByContainer: {
      [`${NAME_PREFIX}llama-dead`]: FAILOVER_DEAD_PORT,
      [`${NAME_PREFIX}llama-live`]: FAILOVER_LIVE_PORT,
    },
  })
}

/** The "dead" upstream answers with `deadStatus`; the "live" one always succeeds. Each
 * records its own calls. `/models/load` and `/openai/v1/models` mirror the real b10354
 * contract, probed live: accept, then report "loaded" -- the ready signal
 * `loadAndWait` actually polls for. */
function makeSplitHttpClient(
  deadStatus: number,
  deadCalls: string[],
  liveCalls: string[],
): HttpClient {
  const control = llamaControlPlane()
  return (url: string, init?: RequestInit) => {
    const controlled = control(url, init)
    if (controlled) {
      return Promise.resolve(controlled)
    }
    const { port } = new URL(url)
    if (port === String(FAILOVER_DEAD_PORT)) {
      deadCalls.push(url)
      return Promise.resolve(Response.json({ error: 'dead' }, { status: deadStatus }))
    }
    liveCalls.push(url)
    return Promise.resolve(
      Response.json({ id: 'resp-live', choices: [{ message: { content: 'live' } }] }),
    )
  }
}

function twoEngineDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  for (const id of ['llama-dead', 'llama-live']) {
    writeEngineSpec(root, id, LOCAL_LLAMA_SPEC)
  }
  const cfg = config({
    engines: [
      engine({ id: 'llama-dead', models_dir: '/data/dead', models_max: 1 }),
      engine({ id: 'llama-live', models_dir: '/data/live', models_max: 1 }),
    ],
    routes: [
      route({ engine: 'llama-dead', model: 'dead-model', filename: 'd.gguf', role: 'chat' }),
      route({ engine: 'llama-live', model: 'live-model', filename: 'l.gguf', role: 'chat' }),
    ],
    chains: { 'chain-failover': ['@/llama-dead/dead-model', '@/llama-live/live-model'] },
  })
  return { cfg, root }
}

describe("the door: a llama hop's real status decides chain advance", () => {
  test("a 500 from the first hop advances: the second hop's upstream received a request", async () => {
    const { cfg, root } = twoEngineDoorConfig()
    const deadCalls: string[] = []
    const liveCalls: string[] = []
    const door = createLlamaDoor(
      cfg,
      root,
      {
        llamaHttpClient: makeSplitHttpClient(500, deadCalls, liveCalls),
        write: () => undefined,
      },
      twoEngineExec(),
    )
    const res = await door.fetch(
      chatRequest({
        model: 'chain-failover',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    expect(res.status).toBe(200)
    expect(body.choices[0]?.message.content).toBe('live')
    expect(deadCalls.length).toBeGreaterThan(0)
    expect(liveCalls.length).toBeGreaterThan(0)
  })

  test("a 400 from the first hop does not advance: the second hop's upstream is never touched", async () => {
    const { cfg, root } = twoEngineDoorConfig()
    const deadCalls: string[] = []
    const liveCalls: string[] = []
    const door = createLlamaDoor(
      cfg,
      root,
      {
        llamaHttpClient: makeSplitHttpClient(400, deadCalls, liveCalls),
        write: () => undefined,
      },
      twoEngineExec(),
    )
    const res = await door.fetch(
      chatRequest({
        model: 'chain-failover',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    )
    await res.text()
    expect(res.status).toBe(400)
    expect(deadCalls.length).toBeGreaterThan(0)
    expect(liveCalls).toHaveLength(0)
  })
})

const TOOL_FALLBACK_LLAMA_PORT = 46_003

const TOOL_CALL_ANSWER = {
  id: 'resp-tools',
  choices: [
    {
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call-1', type: 'function', function: { name: 'now', arguments: '{}' } },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
}

/**
 * A chain that falls back off a tool-capable llama hop onto an agentic one.
 * `chain-public` in `config.example.toml` has this exact shape, and a
 * consumer running a real tool loop over it (majordomo does) gets whatever
 * the last hop returns.
 *
 * `chain-rev` is the same pair the other way round, for the case where the
 * agentic hop is the one reached first: `llamaAnswers` then makes the llama
 * hop behind it a live one, so what the caller gets back proves the chain
 * reached it rather than merely that the agentic hop was skipped.
 */
function toolFallbackDoor(spawnCalls: string[][], llamaAnswers = false): Door {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  writeEngineSpec(root, 'llama-dead', LOCAL_LLAMA_SPEC)
  writeEngineSpec(root, 'claude', CLAUDE_SPEC)
  clearVerifiedVersion('claude')
  const cfg = config({
    engines: [
      engine({ id: 'llama-dead', models_dir: '/data/dead', models_max: 1 }),
      claudeEngine(),
    ],
    routes: [
      route({ engine: 'llama-dead', model: 'dead-model', filename: 'd.gguf', role: 'chat' }),
      route({ engine: 'claude', model: 'x', upstream: null }),
    ],
    chains: {
      'chain-tools': ['@/llama-dead/dead-model', '@/claude/x'],
      'chain-rev': ['@/claude/x', '@/llama-dead/dead-model'],
      // No hop here can honour a tool call, and none reads a workdir from a
      // caller who addressed the chain: the two refusals a chain caller can
      // meet, with nothing behind either to soften them.
      'chain-agentic-only': ['@/claude/x'],
    },
  })
  const control = llamaControlPlane()
  const llamaHttpClient: HttpClient = (url, init) =>
    Promise.resolve(
      control(url, init) ??
        (llamaAnswers
          ? Response.json(TOOL_CALL_ANSWER)
          : Response.json({ error: 'dead' }, { status: 500 })),
    )
  return createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({
        portByContainer: { [`${NAME_PREFIX}llama-dead`]: TOOL_FALLBACK_LLAMA_PORT },
      }),
      probe: READY_200,
      agenticProbeRunner: PASSING_PROBE,
    },
    {
      llamaPresetHostPath: tempPresetPath(TEST_ROOT),
      llamaHttpClient,
      agenticSpawn: (argv) => {
        spawnCalls.push(argv)
        return Promise.resolve({
          stdout: '{"is_error":false,"result":"here is prose"}',
          stderr: '',
          exitCode: 0,
        })
      },
      write: () => undefined,
    },
  )
}

/** Every tool-refusal case sends the same function under both spellings; only the body shape around it differs. */
const TOOL_NOW = { type: 'function', function: { name: 'now', parameters: {} } }

/** One tool-fallback door per call, posted a chat body and read back whole -- the spawn log is what proves the agent was never reached. */
interface ToolFallbackBody {
  choices?: { finish_reason?: string }[]
  error?: string
  attempts?: { failure?: string }[]
}

async function toolFallbackCall(
  body: Record<string, unknown>,
  agenticFirst = false,
): Promise<{ status: number; body: ToolFallbackBody; spawnCalls: string[][] }> {
  const spawnCalls: string[][] = []
  const door = toolFallbackDoor(spawnCalls, agenticFirst)
  const res = await door.fetch(chatRequest(body))
  return { status: res.status, body: (await res.json()) as ToolFallbackBody, spawnCalls }
}

describe('the door: a tool call never falls back into prose', () => {
  test('a chain falling off a llama hop onto an agentic one refuses the tools it cannot honour instead of answering', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: 'chain-tools',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [TOOL_NOW],
      parallel_tool_calls: true,
    })
    // The agent is never launched at all, so there is no prose to return.
    // A tool-capable hop was in this chain and merely failed, so the refusal
    // advances and the chain exhausts -- it does not terminate on the caller.
    expect(spawnCalls).toHaveLength(0)
    expect(status).toBe(503)
    expect(body.error).toBe('every engine in this chain failed')
    expect(body.attempts).toHaveLength(2)
    expect(body.choices).toBeUndefined()
    clearVerifiedVersion('claude')
  })

  // `workdir` means nothing to the llama hop that answers this, so the caller
  // had no reason to send one -- and the agentic hop it is reached through
  // must not turn that into a terminal 400 the chain cannot get past.
  test('a chain whose first hop is agentic still reaches the tool-capable hop behind it with no workdir sent', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall(
      {
        model: 'chain-rev',
        messages: [{ role: 'user', content: 'what time is it' }],
        tools: [TOOL_NOW],
      },
      true,
    )
    expect(status).toBe(200)
    expect(body.choices?.[0]?.finish_reason).toBe('tool_calls')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

describe("the door: a missing workdir is the chain's business, not the caller's", () => {
  // `workdir` is meaningful to an agentic hop and to nothing else, so a
  // caller who addressed a chain had no reason to send one. The hop that
  // cannot run without it is a shape mismatch like any other, whether or not
  // the body also carries a field this engine cannot honour.
  test('a chain whose first hop is agentic advances past it when no workdir and no tools were sent', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall(
      {
        model: 'chain-rev',
        messages: [{ role: 'user', content: 'what time is it' }],
      },
      true,
    )
    expect(status).toBe(200)
    expect(body.choices?.[0]?.finish_reason).toBe('tool_calls')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  // The counterpart the advance must not swallow: naming the engine itself
  // makes the omission the caller's own, and it stays terminal.
  test('naming the agentic engine directly with no workdir is still a terminal 400 naming it', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('workdir is required')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

describe('the door: a chain nothing in it can honour answers the caller, not a dead engine', () => {
  // No hop can honour `tools`, so the refusal is terminal wherever it is
  // reached from -- and a caller who left out the `workdir` only an agentic
  // hop reads still gets told the one thing they can act on.
  test('an all-agentic chain names the field it cannot honour even with no workdir sent', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: 'chain-agentic-only',
      messages: [{ role: 'user', content: 'what time is it' }],
      tools: [TOOL_NOW],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('cannot honour tools')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  // The missing workdir still advances, and the exhausted chain has to say
  // what actually happened: `http 502` alone reads as an engine that failed.
  test('an all-agentic chain with no workdir exhausts, and the attempt records why', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: 'chain-agentic-only',
      messages: [{ role: 'user', content: 'what time is it' }],
    })
    expect(status).toBe(503)
    expect(body.attempts).toHaveLength(1)
    expect(body.attempts?.[0]?.failure).toContain('carried no workdir')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  test('a max_egress that is not an egress is a 400 naming the values that are', async () => {
    const { status, body } = await toolFallbackCall({
      model: 'chain-agentic-only',
      messages: [{ role: 'user', content: 'what time is it' }],
      max_egress: 'internet',
    })
    expect(status).toBe(400)
    expect(body.error).toBe('max_egress must be one of: none, lan, remote')
  })
})

describe('the door: an agentic engine named directly refuses the tool field by name', () => {
  test('naming the agentic engine directly is terminal and names the field, not a 503 that reads as a dead box', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [TOOL_NOW],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('cannot honour tools')
    expect(spawnCalls).toHaveLength(0)
    expect(body.choices).toBeUndefined()
    clearVerifiedVersion('claude')
  })

  test('the legacy functions/function_call spelling is refused too, not answered in prose', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      functions: [TOOL_NOW.function],
      function_call: 'auto',
    })
    expect(status).toBe(400)
    expect(body.error).toContain('cannot honour functions')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })
})

describe('the door: a body that demands no tool call is answered', () => {
  test('the shapes that demand nothing -- empty tools, tool_choice none, text response_format -- are answered', async () => {
    const { status, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [],
      tool_choice: 'none',
      parallel_tool_calls: false,
      response_format: { type: 'text' },
    })
    expect(status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    clearVerifiedVersion('claude')
  })

  test('a caller who also forgot workdir is told about the workdir, which is the mistake they own first', async () => {
    const { status, body, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      tools: [TOOL_NOW],
    })
    expect(status).toBe(400)
    expect(body.error).toContain('workdir is required')
    expect(spawnCalls).toHaveLength(0)
    clearVerifiedVersion('claude')
  })

  // A non-empty tool list under `tool_choice: "none"` is the only shape a
  // client that carries tools and wants words actually sends, so refusing it
  // would refuse the traffic this whole refusal exists to keep serving.
  test('a real tool list under tool_choice "none" is answered, not refused for carrying one', async () => {
    const { status, spawnCalls } = await toolFallbackCall({
      model: '@/claude/x',
      messages: [{ role: 'user', content: 'what time is it' }],
      workdir: '/tmp',
      tools: [TOOL_NOW],
      tool_choice: 'none',
    })
    expect(status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    clearVerifiedVersion('claude')
  })
})

describe('the door: which addresses forward a tool call is discoverable', () => {
  test('the models menu says which addresses forward a tool call before the first one is sent', async () => {
    const door = toolFallbackDoor([])
    const res = await door.fetch(new Request('http://engined/openai/v1/models'))
    const { data } = (await res.json()) as { data: { id: string; tools: boolean }[] }
    expect(data.find((r) => r.id === 'chain-tools')?.tools).toBe(false)
    expect(data.find((r) => r.id === '@/llama-dead/dead-model')?.tools).toBe(true)
    clearVerifiedVersion('claude')
  })

  test('the same chain without tool-calling fields still falls back and answers', async () => {
    const spawnCalls: string[][] = []
    const door = toolFallbackDoor(spawnCalls)
    const res = await door.fetch(
      chatRequest({
        model: 'chain-tools',
        messages: [{ role: 'user', content: 'what time is it' }],
        workdir: '/tmp',
      }),
    )
    expect(res.status).toBe(200)
    expect(spawnCalls).toHaveLength(1)
    clearVerifiedVersion('claude')
  })
})

describe('the door: extras injects the resident model for the right role', () => {
  test('with a vision model and a chat model both resident, an extras call injects the chat model', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const cfgWithVision: Config = {
      ...cfg,
      routes: [
        ...cfg.routes,
        route({ engine: 'local-llama', model: 'vision-a', filename: 'v.gguf', role: 'vision' }),
      ],
    }
    const recorded: { body: string }[] = []
    const extrasCalls: string[] = []
    const extrasClient: HttpClient = (_url: string, init?: RequestInit) => {
      extrasCalls.push(typeof init?.body === 'string' ? init.body : '')
      return Promise.resolve(Response.json({ ok: true }))
    }
    const door = createLlamaDoor(cfgWithVision, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      extrasHttpClient: extrasClient,
      write: () => undefined,
    })

    // Warm both roles: chat first, then vision *last* — a door-side "last
    // model proxied to this engine, any role" approximation would report
    // vision here, since it was the most recent call. Asking the router for
    // the chat role specifically must still report the chat model.
    await (
      await door.fetch(
        chatRequest({ model: '@/local-llama/ornith', messages: [{ role: 'user', content: 'hi' }] }),
      )
    ).text()
    await (
      await door.fetch(
        chatRequest({
          model: '@/local-llama/vision-a',
          messages: [{ role: 'user', content: 'hi' }],
        }),
      )
    ).text()

    await door.fetch(
      new Request('http://engined/engined/v1/engines/local-llama/tokenize', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
    )

    expect(extrasCalls).toHaveLength(1)
    const forwarded = JSON.parse(extrasCalls[0] ?? '{}') as { model?: string }
    expect(forwarded.model).toBe('ornith')
  })
})

describe('the door: extras address one named engine, and refuse any other', () => {
  /**
   * `:id` is a raw engine id, so a comfy-shaped engine carrying `models_dir`
   * alongside local-llama is no longer an ambiguity -- it is simply a
   * different id. What matters is that naming it is refused rather than
   * starting that container and posting a chat body into it.
   */
  test('tokenize against the named llama engine reaches it, and against a comfy-shaped engine 400s', async () => {
    const { cfg, root } = llamaDoorConfigWithComfy()
    const recorded: { body: string }[] = []
    const extrasCalls: string[] = []
    const extrasClient: HttpClient = (_url: string, init?: RequestInit) => {
      extrasCalls.push(typeof init?.body === 'string' ? init.body : '')
      return Promise.resolve(Response.json({ tokens: [1, 2, 3] }))
    }
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      extrasHttpClient: extrasClient,
      write: () => undefined,
    })

    const res = await door.fetch(
      new Request('http://engined/engined/v1/engines/local-llama/tokenize', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(extrasCalls).toHaveLength(1)
    expect(JSON.parse(extrasCalls[0] ?? '{}')).toMatchObject({ model: 'ornith' })

    // Naming the comfy-shaped engine is refused before its container is touched.
    const wrong = await door.fetch(
      new Request('http://engined/engined/v1/engines/comfy/tokenize', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
    )
    expect(wrong.status).toBe(400)
    expect(extrasCalls).toHaveLength(1)
  })

  test('tokenize with no chat yet warm-loads the local chat route before injecting it', async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const extrasCalls: string[] = []
    const extrasClient: HttpClient = (_url: string, init?: RequestInit) => {
      extrasCalls.push(typeof init?.body === 'string' ? init.body : '')
      return Promise.resolve(Response.json({ tokens: [1] }))
    }
    const recorded: { body: string }[] = []
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      extrasHttpClient: extrasClient,
      write: () => undefined,
    })
    const res = await door.fetch(
      new Request('http://engined/engined/v1/engines/local-llama/tokenize', {
        method: 'POST',
        body: JSON.stringify({ content: 'hello' }),
      }),
    )
    expect(res.status).toBe(200)
    expect(JSON.parse(extrasCalls[0] ?? '{}')).toMatchObject({ model: 'ornith', content: 'hello' })
  })
})

describe('no response ever carries a container address', () => {
  // Grepping the raw JSON text, not typed field access: a field the wire
  // TYPE no longer declares would still typecheck clean even if some call
  // site smuggled it back in through a spread -- only the actual bytes on
  // the wire prove it is gone.
  test('GET /engined/v1/engines, with a running llama and a running comfy, mentions no private_url anywhere', async () => {
    const { cfg: base, root } = llamaDoorConfigWithComfy()
    const cfg: Config = {
      ...base,
      routes: [...base.routes, route({ engine: 'comfy', model: undefined, upstream: 'local' })],
    }
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient([]),
    })
    await door.fetch(startRequest('@/local-llama/ornith'))
    await door.fetch(startRequest('@/comfy/local'))

    const res = await door.fetch(new Request('http://engined/engined/v1/engines'))
    const text = await res.text()
    expect(res.status).toBe(200)
    expect(text).not.toContain('private_url')
  })

  test("POST /engined/v1/start's own response never mentions private_url", async () => {
    const { cfg, root } = llamaDoorConfig(TEST_ROOT)
    const door = createLlamaDoor(cfg, root, { llamaHttpClient: makeLlamaHttpClient([]) })
    const res = await door.fetch(startRequest('@/local-llama/ornith'))
    expect(await res.text()).not.toContain('private_url')
  })
})

/** Stands in for `globalThis.fetch`, keeping the JSON body of the last outgoing request; `restore` puts the real one back. */
function captureOutgoingBody(): {
  body: () => { model?: string } | undefined
  restore: () => void
} {
  const originalFetch = globalThis.fetch
  let captured: { model?: string } | undefined
  globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    captured =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as { model?: string }) : undefined
    return Promise.resolve(
      Response.json({ id: 'resp-1', choices: [{ message: { content: 'ok' } }] }),
    )
  }) as typeof fetch
  return {
    body: () => captured,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

/** A hosted openai-http engine behind an openrouter upstream, serving `hostedRoute`. */
function openrouterHostedConfig(hostedRoute: ReturnType<typeof route>): Config {
  return config({
    upstreams: [
      {
        id: 'openrouter',
        egress: 'remote',
        base_url: 'https://openrouter.example/api/v1',
        secret: { service: 's', username: 'u', header: 'authorization' },
      },
    ],
    engines: [engine({ id: 'hosted', kind: 'openai-http' })],
    routes: [hostedRoute],
  })
}

/** Posts one chat message for `model` to a door over `cfg`, with upstream `fetch` captured; resolves to the door's status and the model id that went out. */
async function outgoingModelFor(
  cfg: Config,
  model: string,
): Promise<{ status: number; sent: string | undefined }> {
  const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
  const outgoing = captureOutgoingBody()
  try {
    const door = createLlamaDoor(cfg, root, { secretExec: fakeExec('secret-value') })
    const res = await door.fetch(
      chatRequest({ model, messages: [{ role: 'user', content: 'hi' }] }),
    )
    return { status: res.status, sent: outgoing.body()?.model }
  } finally {
    outgoing.restore()
  }
}

describe('wire_model: the id sent upstream can differ from the address segment', () => {
  test('the remote openai-http proxy sends wire_model in the outgoing request body, not the address segment', async () => {
    const cfg = openrouterHostedConfig(
      route({
        engine: 'hosted',
        model: 'glm-5.2:free',
        wire_model: 'z-ai/glm-5.2:free',
        upstream: 'openrouter',
      }),
    )
    const { status, sent } = await outgoingModelFor(cfg, '@/hosted/glm-5.2:free')
    expect(status).toBe(200)
    // The config's own address segment must never leak onto the wire once
    // a wire_model is configured -- the config-read trap this exists to
    // catch is a test that asserts the route's `model` field and calls it
    // proof of what was actually sent.
    expect(sent).toBe('z-ai/glm-5.2:free')
    expect(sent).not.toBe('glm-5.2:free')
  })

  test('with no wire_model configured, the remote openai-http proxy still sends the address segment verbatim', async () => {
    const cfg = openrouterHostedConfig(
      route({ engine: 'hosted', model: 'sonnet-5', upstream: 'openrouter' }),
    )
    expect(await outgoingModelFor(cfg, '@/hosted/sonnet-5')).toEqual({
      status: 200,
      sent: 'sonnet-5',
    })
  })
})
