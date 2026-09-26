import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { AgenticSpawn } from './agentic.ts'
import {
  CLAUDE_SPEC,
  chatRequest,
  createLlamaDoor,
  fakeExec,
  LOCAL_LLAMA_SPEC,
  llamaDoorConfig,
  makeLlamaHttpClient,
  makeSplitHttpClient,
  PASSING_PROBE,
  startRequest,
  twoEngineDoorConfig,
  twoEngineExec,
} from './doorFixtures.ts'
import type { HttpClient } from './http.ts'
import { createDoor } from './main.ts'
import {
  assertReportedAndResident,
  BUNX,
  clearVerifiedVersion,
  collectLines,
  config,
  engine,
  llamaControlPlane,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  upstream,
  writeEngineSpec,
} from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-door-test-')

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
    // llama never reports a dollar cost, so the header is absent rather than a fabricated zero.
    expect(res.headers.get('x-engined-cost-usd')).toBeNull()
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
    const { cfg: base, root } = twoEngineDoorConfig(TEST_ROOT)
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
    const { cfg: base, root } = twoEngineDoorConfig(TEST_ROOT)
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

  test('a buffered claude reply carries x-engined-cost-usd from its own total_cost_usd', async () => {
    const id = 'claude-cost'
    clearVerifiedVersion(id)
    const root = mkdtempSync(join(TEST_ROOT, 'engined-door-'))
    writeEngineSpec(root, id, CLAUDE_SPEC)
    const cfg = config({
      routes: [route({ engine: id, model: 'assistant', upstream: null })],
      engines: [engine({ id, agent_version: '1.2.3' })],
    })
    const spawn: AgenticSpawn = () =>
      Promise.resolve({
        stdout: '{"is_error":false,"result":"hi","total_cost_usd":0.2236745}',
        stderr: '',
        exitCode: 0,
      })
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { agenticSpawn: spawn, write: () => undefined },
    )
    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: 'user', content: 'hi' }],
        workdir: TEST_ROOT,
      }),
    )
    await res.json()
    expect(res.status).toBe(200)
    expect(res.headers.get('x-engined-cost-usd')).toBe('0.2236745')
    clearVerifiedVersion(id)
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
function fetchStreamChat(
  cfg: Config,
  root: string,
  doorOpts: Parameters<typeof createLlamaDoor>[2],
): Promise<Response> {
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
