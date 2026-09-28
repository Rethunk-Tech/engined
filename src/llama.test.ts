import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DockerLifecycle, type Probe } from './docker.ts'
import { buildRunArgs } from './dockerArgs.ts'
import { type DoorContext, getLlamaRouter } from './doorContext.ts'
import type { EngineRegistry } from './engines.ts'
import { HeldError } from './errors/held.ts'
import type { Exec } from './exec.ts'
import type { HttpClient } from './http.ts'
import { type LlamaHop, LlamaRouter, reportedModelFrom } from './llama.ts'
import { buildLlamaSpec, renderPresetIni } from './llamaSpec.ts'
import { pollUntil } from './records.ts'
import {
  BUNX,
  engine as baseEngine,
  route as baseRoute,
  containerRunning,
  ENGINES_ROOT,
  inspectSinglePort,
  makeTestRoot,
  portResult,
  tempPresetPath,
  config as testConfig,
  writeGgufFixture,
} from './test-support.ts'
import type { EngineEntry, ResolvedRoute } from './types.ts'
import { UsageTracker } from './usage.ts'

const CONTAINER_PORT = 8080
const HOST_PORT = 55_123
const LOAD_PATH = '/models/load'
const UNLOAD_PATH = '/models/unload'
const CHAT_PATH = '/openai/v1/chat/completions'
const EMBED_PATH = '/openai/v1/embeddings'
const MODELS_LIST_PATH = '/v1/models'
const READY_TIMEOUT_ERROR = /readyTimeoutS/
/** Tight, because every `waitFor` below is waiting on in-process work, not on a container. */
const WAIT_INTERVAL_MS = 5
const UNLOAD_FAILED_ERROR = /unload failed/

function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return baseEngine({ id: 'llama', models_dir: '/models-host', models_max: 3, ...overrides })
}

/** `id` names the route's `model` field -- kept as `id` here so every fixture below still reads as naming a GGUF, not a route. */
function model(
  overrides: { id?: string } & Omit<Partial<ResolvedRoute>, 'model'> = {},
): ResolvedRoute {
  const { id, ...rest } = overrides
  return baseRoute({
    engine: 'llama',
    model: id ?? 'a',
    filename: 'a.gguf',
    role: 'chat',
    ...rest,
  })
}

const TEST_ROOT = makeTestRoot('engined-llama-test-')

function tmpIniPath(): string {
  return tempPresetPath(TEST_ROOT)
}

/** `proxy()` hands back the hop's `Response` plus the model resident under its lease, see llama.ts. */
async function text(hop: Promise<LlamaHop>): Promise<string> {
  return (await hop).response.text()
}

/** Answers `docker image inspect`/`run`/`start`/`port` the way a fresh, never-started container would. */
function fakeExec(): Exec {
  return (args) => {
    const [cmd] = args
    if (cmd === 'image') {
      return Promise.resolve(inspectSinglePort(CONTAINER_PORT))
    }
    if (cmd === 'start') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'not created yet' })
    }
    if (cmd === 'port') {
      return Promise.resolve(portResult(HOST_PORT))
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  }
}

const fakeProbe: Probe = () => Promise.resolve({ status: 200 })

function baseOpts(httpClient: HttpClient) {
  return {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    idleStopSeconds: 1000,
    readyTimeoutS: 5,
    presetHostPath: tmpIniPath(),
    httpClient,
    pollIntervalMs: 1,
  }
}

interface RecordedCall {
  path: string
  body: { model?: string; stream?: boolean; id_slot?: number } | undefined
}

/** Structured parse of `renderPresetIni`'s output: `id -> {key: value}`, section-name brackets stripped. */
function parseIniSections(ini: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>()
  for (const block of ini.split('\n\n')) {
    const [header, ...lines] = block.split('\n')
    const id = header?.replace(/^\[|\]$/g, '')
    if (id === undefined) {
      continue
    }
    const kv: Record<string, string> = {}
    for (const line of lines) {
      const [k, v] = line.split(' = ')
      if (k !== undefined && v !== undefined) {
        kv[k] = v
      }
    }
    out.set(id, kv)
  }
  return out
}

/** Matches the real b10354 contract, probed live: `/models/load` never returns
 * `{status:"loaded"}` -- a not-yet-resident model answers `{success:true}`
 * (accepted) and an already-resident one 400s "model is already running".
 * That 400 is not readiness either -- probed live, it fired while a 23 GB
 * GGUF was still on load stage 0. The real signal is `GET /v1/models`'s
 * per-model `status.value`, which transitions unloaded -> loading -> loaded. */
function modelsList(entries: Array<{ id: string; status: string }>): Response {
  return Response.json({ data: entries.map((e) => ({ id: e.id, status: { value: e.status } })) })
}

/** A minimal llama-server router double: load/unload always succeed and the model
 * requested becomes immediately "loaded" on the next /v1/models poll; everything
 * else echoes its request model. */
function fakeLlama(hook?: (call: RecordedCall) => Response | undefined): {
  client: HttpClient
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  let lastLoadRequested: string | undefined
  const client: HttpClient = (input, init) => {
    const url = new URL(String(input))
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined
    const body = bodyStr === undefined ? undefined : (JSON.parse(bodyStr) as RecordedCall['body'])
    const call: RecordedCall = { path: url.pathname, body }
    calls.push(call)
    const hooked = hook?.(call)
    if (hooked) {
      return Promise.resolve(hooked)
    }
    if (url.pathname === LOAD_PATH) {
      lastLoadRequested = body?.model
      return Promise.resolve(Response.json({ success: true }))
    }
    if (url.pathname === MODELS_LIST_PATH) {
      return Promise.resolve(
        modelsList(
          lastLoadRequested === undefined ? [] : [{ id: lastLoadRequested, status: 'loaded' }],
        ),
      )
    }
    if (url.pathname === UNLOAD_PATH) {
      return Promise.resolve(Response.json({ ok: true }))
    }
    return Promise.resolve(Response.json({ ok: true, model: body?.model }))
  }
  return { client, calls }
}

/** Wires the given models to a router talking to `httpClient` over a fresh lifecycle. */
function routerWithClient(
  e: EngineEntry,
  models: ResolvedRoute[],
  httpClient: HttpClient,
): LlamaRouter {
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  return new LlamaRouter(e, models, lifecycle, baseOpts(httpClient))
}

/** Wires the given models to a router with the default `fakeLlama()` client. */
function routerFor(
  e: EngineEntry,
  models: ResolvedRoute[],
): { calls: RecordedCall[]; router: LlamaRouter } {
  const { client, calls } = fakeLlama()
  return { calls, router: routerWithClient(e, models, client) }
}

/** A single "a" model wired to a router with the default `fakeLlama()` client. */
function singleModelRouter(): { e: EngineEntry; a: ResolvedRoute; router: LlamaRouter } {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const { router } = routerFor(e, [a])
  return { e, a, router }
}

/** Sends one warm-up chat so "a" is resident, then reports how many loads that took. */
async function warmUpAndCountLoads(
  router: LlamaRouter,
  a: ResolvedRoute,
  calls: RecordedCall[],
): Promise<number> {
  await chatText(router, a, 'a')
  return calls.filter((c) => c.path === LOAD_PATH).length
}

/**
 * `fakeLlama()` with its calls to `path` parked at a gate, so a caller can
 * prove work is genuinely in flight rather than already finished: `started`
 * resolves once the first call is parked, `inGate` counts how many are parked,
 * and `release` lets them all through. `once` gates only the first call, which
 * is what holding one request open behind a second, distinguishing one needs;
 * gating every call is what admission-control tests need, where several must
 * be in flight together. `inGate` counts entries and never decrements -- every
 * caller reads it before releasing.
 */
function gatedClient(
  path: string,
  { once = false }: { once?: boolean } = {},
): {
  client: HttpClient
  calls: RecordedCall[]
  release: () => void
  started: Promise<void>
  inGate: () => number
} {
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  let started: () => void = () => undefined
  const startedPromise = new Promise<void>((r) => {
    started = r
  })
  let sawFirst = false
  let waiting = 0
  const { client, calls } = fakeLlama()
  const gated: HttpClient = async (input, init) => {
    const url = new URL(String(input))
    if (url.pathname === path && !(once && sawFirst)) {
      sawFirst = true
      waiting += 1
      started()
      await gate
    }
    return client(input, init)
  }
  return { client: gated, calls, release, started: startedPromise, inGate: () => waiting }
}

/** Wires `models` to a gated router, fires the first "a" chat, and waits
 * until it is in flight -- the shared opening every gated-lease test needs
 * before it can issue its own, distinguishing second request. */
async function startGatedChat(
  e: EngineEntry,
  models: ResolvedRoute[],
  a: ResolvedRoute,
): Promise<{
  router: LlamaRouter
  calls: RecordedCall[]
  release: () => void
  res1: Promise<LlamaHop>
}> {
  const { client: gated, calls, release, started } = gatedClient(CHAT_PATH, { once: true })
  const router = routerWithClient(e, models, gated)
  const res1 = chatHop(router, a, 'a')
  await started
  return { router, calls, release, res1 }
}

/** Polls a condition the router reaches on its own, for work no caller can await. */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  if (!(await pollUntil(async () => cond(), Date.now() + timeoutMs, WAIT_INTERVAL_MS))) {
    throw new Error('condition never became true')
  }
}

/** Lets a pending `.then` chain run as far as it can without resolving any
 * new promise of its own -- three microtask turns is enough for the router's
 * internal queue pump to reach its next await. */
async function drainMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function chatInit(
  modelId: string,
  extra: { stream?: boolean; signal?: AbortSignal } = {},
): RequestInit {
  const { stream, signal } = extra
  return {
    method: 'POST',
    body: JSON.stringify(stream === undefined ? { model: modelId } : { model: modelId, stream }),
    ...(signal === undefined ? {} : { signal }),
  }
}

function chatText(
  router: LlamaRouter,
  route: ResolvedRoute,
  modelId: string,
  extra: { stream?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  return text(router.proxy(route, CHAT_PATH, chatInit(modelId, extra)))
}

function chatHop(
  router: LlamaRouter,
  route: ResolvedRoute,
  modelId: string,
  extra: { stream?: boolean; signal?: AbortSignal } = {},
): Promise<LlamaHop> {
  return router.proxy(route, CHAT_PATH, chatInit(modelId, extra))
}

function pair(aExtra: Parameters<typeof model>[0] = {}, bExtra: Parameters<typeof model>[0] = {}) {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf', ...aExtra })
  const b = model({ id: 'b', filename: 'b.gguf', ...bExtra })
  return { e, a, b }
}

function pairRouter(
  aExtra: Parameters<typeof model>[0] = {},
  bExtra: Parameters<typeof model>[0] = {},
  extras: ResolvedRoute[] = [],
) {
  const { e, a, b } = pair(aExtra, bExtra)
  const { calls, router } = routerFor(e, [a, b, ...extras])
  return { e, a, b, calls, router }
}

async function gatedPair(
  aExtra: Parameters<typeof model>[0] = {},
  bExtra: Parameters<typeof model>[0] = {},
) {
  const { e, a, b } = pair(aExtra, bExtra)
  const gated = await startGatedChat(e, [a, b], a)
  return { e, a, b, ...gated }
}

function goneExecFrom(base: Exec = fakeExec()): Exec {
  return (args) => (args[0] === 'inspect' ? Promise.resolve(containerRunning(false)) : base(args))
}

function sseBody(chunk: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(chunk))
    },
    ...(onCancel === undefined ? {} : { cancel: onCancel }),
  })
}

function loadListChatClient(chatReply: () => Response): HttpClient {
  return (input) => {
    const url = new URL(String(input))
    if (url.pathname === LOAD_PATH) {
      return Promise.resolve(Response.json({ success: true }))
    }
    if (url.pathname === MODELS_LIST_PATH) {
      return Promise.resolve(modelsList([{ id: 'a', status: 'loaded' }]))
    }
    if (url.pathname === CHAT_PATH) {
      return Promise.resolve(chatReply())
    }
    throw new Error(`unexpected path ${url.pathname}`)
  }
}

function sseRouter(chatReply: () => Response): {
  e: EngineEntry
  a: ResolvedRoute
  router: LlamaRouter
} {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const router = new LlamaRouter(
    e,
    [a],
    new DockerLifecycle(fakeExec(), fakeProbe),
    baseOpts(loadListChatClient(chatReply)),
  )
  return { e, a, router }
}

function admissionOf(a: ResolvedRoute) {
  const e = engine()
  const { client, calls, release, inGate } = gatedClient(CHAT_PATH)
  const router = routerWithClient(e, [a], client)
  const send = () => chatHop(router, a, 'a')
  return { e, a, router, calls, release, inGate, send }
}

function failFirstOn(path: string): { client: HttpClient; count: () => number } {
  let n = 0
  const { client } = fakeLlama((call) => {
    if (call.path !== path) {
      return
    }
    n += 1
    if (n === 1) {
      throw new Error('Unable to connect')
    }
  })
  return { client, count: () => n }
}

async function proxyGone(client: HttpClient): Promise<Response> {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const router = new LlamaRouter(
    e,
    [a],
    new DockerLifecycle(goneExecFrom(), fakeProbe),
    baseOpts(client),
  )
  return (await chatHop(router, a, 'a')).response
}

function expectReloaded(res: Response, calls: RecordedCall[], loadsBefore: number): void {
  expect(res.status).toBe(200)
  expect(calls.filter((c) => c.path === LOAD_PATH)).toHaveLength(loadsBefore + 1)
  expect(calls.filter((c) => c.path === UNLOAD_PATH)).toHaveLength(0)
}

function gatedUnloadPair(
  aExtra: Parameters<typeof model>[0] = {},
  bExtra: Parameters<typeof model>[0] = {},
) {
  const { e, a, b } = pair(aExtra, bExtra)
  const { client, calls, release, started } = gatedClient(UNLOAD_PATH, { once: true })
  const router = routerWithClient(e, [a, b], client)
  return { e, a, b, calls, release, started, router }
}

describe('renderPresetIni', () => {
  test('two models with different [model.args] produce two different INI sections, and the run argv points the child at that file', () => {
    const e = engine()
    const a = model({
      id: 'a',
      filename: 'a.gguf',
      args: { 'spec-type': 'draft-mtp', 'spec-draft-p-min': 0.1 },
    })
    const b = model({ id: 'b', filename: 'b.gguf', args: {} })
    const ini = renderPresetIni(e, [a, b])
    const sections = parseIniSections(ini)
    // Structured, not substring: proves the exact key set each section
    // carries, not merely that a wanted phrase appears somewhere in it.
    expect(sections.get('a')).toEqual({
      model: '/models/a.gguf',
      'spec-type': 'draft-mtp',
      'spec-draft-p-min': '0.1',
    })
    expect(sections.get('b')).toEqual({ model: '/models/b.gguf' })

    // Proves different *file content* only -- not that llama-server honours
    // a per-model key rather than ignoring it. The run argv below is what
    // connects that file to the child: `--models-preset` names the mounted
    // path. Reading the child's real argv/`/slots` per flag needs a live
    // container and belongs to a smoke test under test/local/.
    const spec = buildLlamaSpec(e, { enginesRoot: ENGINES_ROOT, bunx: BUNX }, tmpIniPath())
    const argv = buildRunArgs('engined-llama', spec, CONTAINER_PORT)
    const presetIdx = argv.indexOf('--models-preset')
    expect(presetIdx).toBeGreaterThan(-1)
    expect(argv[presetIdx + 1]).toBe('/preset.ini')
  })

  test('a model arg beats an engine arg naming the same key', () => {
    const e = engine({ args: { 'ctx-size': 4096 } })
    const a = model({ args: { 'ctx-size': 8192 } })
    const ini = renderPresetIni(e, [a])
    expect(ini).toContain('ctx-size = 8192')
    expect(ini).not.toContain('ctx-size = 4096')
  })

  test("an embedding model's pooling/RoPE keys render in its section only, never a chat model's", () => {
    const e = engine()
    const chat = model({ id: 'chat-a', filename: 'a.gguf', role: 'chat', args: {} })
    const embed = model({
      id: 'embed',
      filename: 'embed.gguf',
      role: 'embedding',
      args: { pooling: 'mean', 'rope-freq-base': 0, 'rope-freq-scale': 0 },
    })
    const ini = renderPresetIni(e, [chat, embed])
    const sections = new Map(ini.split('\n\n').map((s) => [s.split('\n', 1)[0], s]))
    expect(sections.get('[embed]')).toContain('pooling = mean')
    expect(sections.get('[embed]')).toContain('rope-freq-base = 0')
    expect(sections.get('[chat-a]')).not.toContain('pooling')
    expect(sections.get('[chat-a]')).not.toContain('rope-freq')
  })
})

describe('buildLlamaSpec / buildRunArgs', () => {
  test('run argv pins models-max and sets no-models-autoload, never models-dir or /dev/kfd', () => {
    const e = engine({ models_max: 3 })
    const spec = buildLlamaSpec(e, { enginesRoot: ENGINES_ROOT, bunx: BUNX }, tmpIniPath())
    const argv = buildRunArgs('engined-llama', spec, CONTAINER_PORT)
    expect(argv).toContain('--no-models-autoload')
    const maxIdx = argv.indexOf('--models-max')
    expect(maxIdx).toBeGreaterThan(-1)
    expect(argv[maxIdx + 1]).toBe('3')
    expect(argv).not.toContain('--models-dir')
    expect(argv).not.toContain('/dev/kfd')
    const mountArgs = argv.filter((_, i) => argv[i - 1] === '-v')
    expect(mountArgs.some((m) => m.endsWith(':/models:ro'))).toBe(true)
    expect(mountArgs.some((m) => m.endsWith(':/preset.ini:ro'))).toBe(true)
  })

  test('engine args reach the preset, never the command line that would override it', () => {
    const e = engine({ models_max: 3, args: { 'ctx-size': 32_768, parallel: -1 } })
    const spec = buildLlamaSpec(e, { enginesRoot: ENGINES_ROOT, bunx: BUNX }, tmpIniPath())
    const argv = buildRunArgs('engined-llama', spec, CONTAINER_PORT)

    // llama-server lets a CLI flag beat the preset for every model it loads,
    // so an engine default here is a per-model `ctx-size` that can never win.
    expect(argv).not.toContain('--ctx-size')
    expect(argv).not.toContain('--parallel')

    const ini = renderPresetIni(e, [model({ id: 'a', filename: 'a.gguf', args: {} })])
    expect(ini).toContain('ctx-size = 32768')
  })
})

test('chat for model B while same-role model A is resident and idle: unload A, load B, then complete', async () => {
  const { a, b, calls, router } = pairRouter()

  await chatText(router, a, 'a')
  await chatText(router, b, 'b')

  // Default fakeLlama mirrors the real b10354 handshake: a POST /models/load
  // trigger, then a GET /v1/models poll for the "loaded" status -- the real
  // ready signal, per the live probe -- before the swap proceeds. The list
  // read that follows each chat is the provenance one, and it lands before
  // the unload: taken under the same lease, so it cannot name B's model as
  // what answered for A.
  const paths = calls.map((c) => c.path)
  expect(paths).toEqual([
    LOAD_PATH,
    MODELS_LIST_PATH,
    CHAT_PATH,
    MODELS_LIST_PATH,
    UNLOAD_PATH,
    LOAD_PATH,
    MODELS_LIST_PATH,
    CHAT_PATH,
    MODELS_LIST_PATH,
  ])
  expect(calls[4]?.body?.model).toBe('a')
  expect(calls[5]?.body?.model).toBe('b')
})

test('the resident model reported for a hop is the one that served it, not a later swap', async () => {
  const { a, b, router } = pairRouter()

  const first = await router.proxy(a, CHAT_PATH, chatInit('a'))
  await first.response.text()
  // Swaps the role onto B. The hop above already carries its own answer, so
  // this cannot retroactively change what it reported holding.
  await chatText(router, b, 'b')

  expect(first.modelResident).toBe('a')
})

test('a different-role model resident is untouched by a chat swap', async () => {
  const v = model({ id: 'v', filename: 'v.gguf', role: 'vision' })
  const { a, b, calls, router } = pairRouter({ role: 'chat' }, { role: 'chat' }, [v])

  await chatText(router, v, 'v')
  await chatText(router, a, 'a')
  await chatText(router, b, 'b')

  const visionLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === 'v',
  )
  expect(visionLoadOrUnload).toHaveLength(1)
  expect(visionLoadOrUnload[0]?.path).toBe(LOAD_PATH)
})

test('an embedding request co-resides with a resident chat model: neither evicts the other', async () => {
  const e = engine()
  const chat = model({ id: 'chat-a', filename: 'a.gguf', role: 'chat' })
  const embed = model({ id: 'embed', filename: 'embed.gguf', role: 'embedding' })
  const { calls, router } = routerFor(e, [chat, embed])

  await text(chatHop(router, chat, 'chat-a'))
  await text(router.proxy(embed, EMBED_PATH, chatInit('embed')))
  await text(chatHop(router, chat, 'chat-a'))

  const chatLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === 'chat-a',
  )
  const embedLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === 'embed',
  )
  // Each loaded exactly once and never unloaded: the embedding request did not
  // evict the chat resident, and the second chat request did not re-swap.
  expect(chatLoadOrUnload).toEqual([{ path: LOAD_PATH, body: { model: 'chat-a' } }])
  expect(embedLoadOrUnload).toEqual([{ path: LOAD_PATH, body: { model: 'embed' } }])
})

test('two overlapping chats for the same GGUF both complete without a second load', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const { router, calls, release, res1 } = await startGatedChat(e, [a], a)

  const res2 = router.proxy(a, CHAT_PATH, chatInit('a'))

  const secondText = await Promise.race([
    text(res2).then((t) => ({ done: true, t })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 100)),
  ])
  expect(secondText.done).toBe(true)

  release()
  await text(res1)

  const loadCalls = calls.filter((c) => c.path === LOAD_PATH)
  expect(loadCalls).toHaveLength(1)
  expect(calls.filter((c) => c.path === UNLOAD_PATH)).toHaveLength(0)
})

test('a different-GGUF same-role chat arriving mid-lease waits, without eviction or a 409', async () => {
  const { b, router, calls, release, res1 } = await gatedPair()

  const res2 = router.proxy(b, CHAT_PATH, chatInit('b'))
  // Let the pump run as far as it can while A's lease is still held.
  await drainMicrotasks()
  const bTouchedWhileWaiting = calls.some(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === 'b',
  )
  expect(bTouchedWhileWaiting).toBe(false)

  release()
  const text1 = await text(res1)
  expect((JSON.parse(text1) as { model?: string }).model).toBe('a')

  const text2 = await text(res2)
  expect((JSON.parse(text2) as { model?: string }).model).toBe('b')

  const unloadA = calls.find((c) => c.path === UNLOAD_PATH && c.body?.model === 'a')
  expect(unloadA).toBeDefined()
})

test('a queued waiter whose caller aborts is dropped before the swap it would have triggered', async () => {
  const { b, router, calls, release, res1 } = await gatedPair()

  const controller = new AbortController()
  const res2 = router.proxy(b, CHAT_PATH, chatInit('b', { signal: controller.signal }))
  // Let the pump run as far as it can while A's lease is still held, exactly
  // as the mid-lease test above does, so B is genuinely queued (not merely
  // still inside ensureStarted) before it aborts.
  await drainMicrotasks()

  controller.abort()
  await expect(res2).rejects.toThrow()

  release()
  await text(res1)

  const bTouched = calls.some(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === 'b',
  )
  expect(bTouched).toBe(false)
})

test('/models/load only triggers; readiness is polled via /v1/models until "loaded"', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  let pollAttempts = 0
  const { client, calls } = fakeLlama((call) => {
    if (call.path !== MODELS_LIST_PATH) {
      return
    }
    pollAttempts += 1
    return modelsList([{ id: 'a', status: pollAttempts < 3 ? 'loading' : 'loaded' }])
  })
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client))

  await chatText(router, a, 'a')

  // Three readiness polls, then the provenance read once the chat has answered.
  expect(pollAttempts).toBe(4)
  const pollIdxs = calls.map((c, i) => (c.path === MODELS_LIST_PATH ? i : -1)).filter((i) => i >= 0)
  const chatIdx = calls.findIndex((c) => c.path === CHAT_PATH)
  const readinessIdxs = pollIdxs.filter((i) => i < chatIdx)
  expect(readinessIdxs).toHaveLength(3)
})

test('a model that never reports "loaded" via /v1/models fails within the timeout instead of hanging', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  const { client } = fakeLlama((call) =>
    call.path === MODELS_LIST_PATH ? modelsList([{ id: 'a', status: 'loading' }]) : undefined,
  )
  const router = new LlamaRouter(e, [a], lifecycle, { ...baseOpts(client), readyTimeoutS: 0.05 })

  await expect(chatText(router, a, 'a')).rejects.toThrow(READY_TIMEOUT_ERROR)
})

test("the role's lease is free after a failed load: a later request for the role proceeds", async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const b = model({ id: 'b', filename: 'b.gguf' })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  let lastLoad: string | undefined
  const { client } = fakeLlama((call) => {
    if (call.path === LOAD_PATH) {
      lastLoad = call.body?.model
      return // default {success:true} answers the trigger
    }
    // "a" never reports loaded; "b" falls through to the default fake's
    // immediate "loaded" so the later request can prove the role recovered.
    return call.path === MODELS_LIST_PATH && lastLoad === 'a'
      ? modelsList([{ id: 'a', status: 'loading' }])
      : undefined
  })
  const router = new LlamaRouter(e, [a, b], lifecycle, {
    ...baseOpts(client),
    readyTimeoutS: 0.05,
  })

  await expect(chatText(router, a, 'a')).rejects.toThrow()

  const result = await Promise.race([
    chatText(router, b, 'b').then((t) => ({ done: true as const, t })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 500)),
  ])
  expect(result.done).toBe(true)
  expect(result.done && (JSON.parse(result.t) as { model?: string }).model).toBe('b')
})

test('a streamed 429 keeps the upstream content-type instead of text/event-stream', async () => {
  const { a, router } = sseRouter(() =>
    Response.json({ error: { message: 'rate limited' } }, { status: 429 }),
  )

  const { response: res } = await chatHop(router, a, 'a', { stream: true })
  expect(res.status).toBe(429)
  expect(res.headers.get('content-type')).toContain('application/json')
})

test('a streamed 400 keeps the upstream content-type instead of text/event-stream', async () => {
  const { a, router } = sseRouter(() =>
    Response.json({ error: { message: 'bad request' } }, { status: 400 }),
  )

  const { response: res } = await chatHop(router, a, 'a', { stream: true })
  expect(res.status).toBe(400)
  expect(res.headers.get('content-type')).toContain('application/json')
})

test('a cold streaming request emits `: warming` before its first real byte', async () => {
  const { a, router } = singleModelRouter()

  const { response: res } = await chatHop(router, a, 'a', { stream: true })
  const reader = res.body?.getReader()
  if (!reader) {
    throw new Error('expected a body reader')
  }
  const { value } = await reader.read()
  expect(new TextDecoder().decode(value)).toBe(': warming\n\n')
})

test('a client cancelling a streaming response cancels the upstream reader too, instead of leaking the connection', async () => {
  let upstreamCancelled = false
  const { a, router } = sseRouter(
    () =>
      new Response(
        sseBody('data: chunk\n\n', () => {
          upstreamCancelled = true
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
  )

  const { response: res } = await chatHop(router, a, 'a', { stream: true })
  const reader = res.body?.getReader()
  await reader?.read()
  await reader?.cancel()

  expect(upstreamCancelled).toBe(true)
})

test('a streaming client that aborts without draining the stream still releases its lease', async () => {
  const { a, router } = sseRouter(
    () =>
      new Response(sseBody('data: chunk\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
  )

  const controller = new AbortController()
  await chatHop(router, a, 'a', { stream: true, signal: controller.signal })

  // The returned stream is never read and never cancelled -- exactly what a
  // client that goes away mid-generation leaves behind. Only the abort signal
  // can release the lease here.
  expect(router.hasOutstandingLeases()).toBe(true)
  controller.abort()
  expect(router.hasOutstandingLeases()).toBe(false)
})

test('a streaming hop whose provenance read gets a non-JSON body releases its lease rather than leaking it', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  // The load's own /v1/models poll must still answer JSON, or the failure
  // under test is never reached: only the provenance read that runs AFTER the
  // upstream has answered gets the body llama-server writes when it is not
  // answering as a router at all.
  let chatAnswered = false
  const { client } = fakeLlama((call) => {
    if (call.path === CHAT_PATH) {
      chatAnswered = true
      return
    }
    if (call.path === MODELS_LIST_PATH && chatAnswered) {
      return new Response('<html>502 Bad Gateway</html>', { status: 502 })
    }
    return
  })
  const router = routerWithClient(e, [a], client)

  await expect(router.proxy(a, CHAT_PATH, chatInit('a', { stream: true }))).rejects.toThrow()

  expect(router.hasOutstandingLeases()).toBe(false)
  expect(router.contention()).toEqual([])
})

test('a cold non-streaming request never gets an SSE `: warming` comment, which would corrupt its JSON body', async () => {
  const { a, router } = singleModelRouter()

  // No prior proxy() call: this is the container's first request, the
  // coldest possible load.
  const { response: res } = await router.proxy(a, CHAT_PATH, chatInit('a'))
  const raw = await res.text()
  expect(() => JSON.parse(raw)).not.toThrow()
  expect(raw.startsWith(': warming')).toBe(false)
})

test('model_reported (the echoed body) and model_resident (read from /v1/models) differ on a stale echo', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf', role: 'chat' })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  // The chat response echoes a router id that is not the resident file --
  // exactly the staleness model_resident exists to catch independently.
  const { client } = fakeLlama((call) =>
    call.path === CHAT_PATH ? Response.json({ ok: true, model: 'stale-id' }) : undefined,
  )
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client))

  const { response, modelResident } = await router.proxy(a, CHAT_PATH, chatInit('a'))
  const body = (await response.json()) as { model?: string }

  const modelReported = reportedModelFrom(body)
  expect(modelReported).toBe('stale-id')
  expect(modelResident).toBe('a')
  expect(modelReported).not.toBe(modelResident)
})

function requestedModel(init: RequestInit | undefined): string | undefined {
  const bodyStr = typeof init?.body === 'string' ? init.body : undefined
  return bodyStr === undefined ? undefined : (JSON.parse(bodyStr) as { model?: string }).model
}

/** `File Not Found` is the real b10354 body for an id `docker run` never saw. */
function routerModeLoadResponse(knownAtRun: Set<string>, requested: string | undefined): Response {
  if (!knownAtRun.has(requested ?? '')) {
    return Response.json(
      { error: { message: 'File Not Found', type: 'not_found_error', code: 404 } },
      { status: 404 },
    )
  }
  return Response.json({ success: true })
}

/**
 * A router-mode double that only "knows" the model ids present in the
 * preset file at the moment `docker run` fires -- matching the real b10354
 * behaviour, proven live against the actual container: rewriting the
 * mounted preset in place (confirmed visible inside the container
 * immediately -- a bind mount is the same inode) changed nothing. Even
 * reloading an ALREADY-resident id after the rewrite still launched with
 * the pre-rewrite args, and an id added only by the rewrite 404'd "File Not
 * Found" forever. `--models-preset` is parsed exactly once, at process
 * start.
 */
function fakeReloadableLlama(presetHostPath: string): { exec: Exec; client: HttpClient } {
  const knownAtRun = new Set<string>()
  const exec: Exec = (args) => {
    if (args[0] === 'run') {
      knownAtRun.clear()
      for (const id of parseIniSections(readFileSync(presetHostPath, 'utf8')).keys()) {
        knownAtRun.add(id)
      }
    }
    return fakeExec()(args)
  }
  let lastLoadRequested: string | undefined
  const client: HttpClient = (input, init) => {
    const path = new URL(String(input)).pathname
    const requested = requestedModel(init)
    if (path === LOAD_PATH) {
      const res = routerModeLoadResponse(knownAtRun, requested)
      if (res.ok) {
        lastLoadRequested = requested
      }
      return Promise.resolve(res)
    }
    if (path === MODELS_LIST_PATH) {
      return Promise.resolve(
        modelsList(
          lastLoadRequested === undefined ? [] : [{ id: lastLoadRequested, status: 'loaded' }],
        ),
      )
    }
    if (path === UNLOAD_PATH) {
      return Promise.resolve(Response.json({ ok: true }))
    }
    return Promise.resolve(Response.json({ ok: true, model: requested }))
  }
  return { exec, client }
}

test('a model added by config reload becomes genuinely servable, not just listed', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const b = model({ id: 'b', filename: 'b.gguf' })
  const presetHostPath = tmpIniPath()
  const { exec, client } = fakeReloadableLlama(presetHostPath)
  const lifecycle = new DockerLifecycle(exec, fakeProbe)

  // Router 1: only "a" configured -- the pre-reload state. Drives the
  // container to "running" the way a real first request would.
  const router1 = new LlamaRouter(e, [a], lifecycle, { ...baseOpts(client), presetHostPath })
  expect(await text(chatHop(router1, a, 'a'))).toContain('"model":"a"')

  // Router 2: what `main.ts`'s reload produces -- a NEW router over the SAME
  // still-running container, with "b" newly added. The stale-router swap
  // only ever hands off once router1's leases have drained to zero, which
  // is already true here (its one request finished above), so this mirrors
  // the real handoff, not a shortcut past it.
  const router2 = new LlamaRouter(e, [a, b], lifecycle, { ...baseOpts(client), presetHostPath })
  const { response: res } = await router2.proxy(b, CHAT_PATH, chatInit('b'))
  expect(res.status).toBe(200)
})

// Concurrent chat + vision decode needs a registered vision [[model]] against
// a real GGUF, which does not exist in this repo. Do not alias a chat model
// onto the vision role to make this runnable -- see the acceptance
// criteria for this engine; the criterion is skipped, not faked.

/**
 * The container dies from outside engined. Nothing else asks docker about an
 * `openai-http` engine between starts, so without reconciling on the failure
 * the router proxies to a dead port until the process restarts.
 */
test('a request that cannot connect reconciles a dead container, restarts it and retries once', async () => {
  // Only the proxied completion fails, and only the first time: the load and
  // /v1/models polling the lease itself does must still succeed, or the
  // failure under test is never reached.
  const { client, count } = failFirstOn(CHAT_PATH)
  const res = await proxyGone(client)

  expect(res.status).toBe(200)
  expect(count()).toBe(2)
})

/**
 * The same death, seen one call earlier. A lease loads its GGUF before any
 * completion is proxied, so a container removed while the map still believes
 * it running fails at `/models/load` and never reaches the proxy. Loading
 * against a captured base URL instead of the reconciling one left that path
 * unable to recover: every later request failed in about a millisecond, for
 * the life of the process.
 */
test('a load that cannot connect reconciles a dead container, restarts it and retries once', async () => {
  const { client, count } = failFirstOn(LOAD_PATH)
  const res = await proxyGone(client)

  expect(res.status).toBe(200)
  expect(count()).toBe(2)
})

/** Docker decides: a real upstream failure against a live container must not provoke a restart-and-retry. */
test('a request that cannot connect while the container is genuinely up rethrows', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })

  const base = fakeExec()
  const aliveExec: Exec = (args) =>
    args[0] === 'inspect' ? Promise.resolve(containerRunning()) : base(args)

  let chatCalls = 0
  const { client } = fakeLlama((call) => {
    if (call.path !== CHAT_PATH) {
      return
    }
    chatCalls += 1
    throw new Error('Unable to connect')
  })

  const router = new LlamaRouter(
    e,
    [a],
    new DockerLifecycle(aliveExec, fakeProbe),
    baseOpts(client),
  )

  await expect(chatHop(router, a, 'a')).rejects.toThrow('Unable to connect')
  // Not retried: docker said the container is up, so this is a real upstream error.
  expect(chatCalls).toBe(1)
})

/**
 * Interleaving: a request holding the chat role's lease loses its connection,
 * so `fetchUpstreamOnce` reconciles a dead container and restarts it -- with
 * that lease still held and its retry still to come. A second request for the
 * same role arrives while the retry is in flight. The restart may forget what
 * the child had resident; it must not forget the requests this door still has
 * running against it, or four in-flight requests plus four newly admitted ride
 * four llama.cpp slots.
 */
test('a container restarted under a live lease still counts that lease: the next request waits rather than riding the same slots', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const goneExec = goneExecFrom()

  let retrying: () => void = () => undefined
  const retryStarted = new Promise<void>((r) => {
    retrying = r
  })
  let release: () => void = () => undefined
  const gate = new Promise<void>((r) => {
    release = r
  })
  let chatCalls = 0
  const { client, calls } = fakeLlama()
  const failThenGate: HttpClient = async (input, init) => {
    if (new URL(String(input)).pathname === CHAT_PATH) {
      chatCalls += 1
      if (chatCalls === 1) {
        throw new Error('Unable to connect')
      }
      // The post-restart retry, still under the first request's lease.
      retrying()
      await gate
    }
    return client(input, init)
  }

  const router = new LlamaRouter(e, [a], new DockerLifecycle(goneExec, fakeProbe), {
    ...baseOpts(failThenGate),
  })
  const res1 = chatHop(router, a, 'a')
  await retryStarted

  const res2 = chatHop(router, a, 'a')
  await drainMicrotasks()

  expect(router.contention()).toEqual([{ role: 'chat', active: 1, waiting: 1 }])
  // Nor may the queued one swap a model in under the lease that is still running.
  expect(calls.filter((c) => c.path === LOAD_PATH)).toHaveLength(1)

  release()
  const [{ response: r1 }, { response: r2 }] = await Promise.all([res1, res2])
  expect(r1.status).toBe(200)
  expect(r2.status).toBe(200)
  expect(router.contention()).toEqual([])
})

/**
 * The desync this heals is not hypothetical: unloading ornith straight at the
 * router (`POST /models/unload`) left engined still believing it resident, so
 * the very next proxied request came back 400 "model is not loaded" in ~12ms
 * and the role never reloaded on its own. Reproduced live against b10637.
 */
test("a model unloaded behind the router's back reloads once, instead of 400ing forever", async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  let unloadedBehindBack = false
  let served404s = 0
  const { client, calls } = fakeLlama((call) => {
    if (call.path === CHAT_PATH && unloadedBehindBack) {
      unloadedBehindBack = false
      served404s += 1
      return Response.json({ error: { message: 'model is not loaded' } }, { status: 400 })
    }
    return
  })
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client))

  const loadsBefore = await warmUpAndCountLoads(router, a, calls)

  // Nothing tells engined about this: its own activeModelId still says "a".
  unloadedBehindBack = true
  const { response: res } = await chatHop(router, a, 'a')

  expect(served404s).toBe(1)
  // The reload is a real /models/load, not a silent retry against the same dead state.
  // And no eviction: the belief about WHICH model belongs here was never wrong.
  expectReloaded(res, calls, loadsBefore)
})

/**
 * The narrower half of the same desync, captured live: a request that reaches
 * the router inside the window where an unload has begun but not finished is
 * proxied to the dying child, and the router answers 500 with the plain-text
 * body "proxy error: Could not establish connection" -- 11ms after the unload
 * in the observed run. The trap is that the router still advertises the model
 * as loaded through that window, so reloading immediately is a no-op and the
 * retry lands on the same corpse.
 */
test('a child stopped mid-flight is waited out and reloaded, not surfaced as a 500', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  // An annotated holder rather than a bare `let`: read from the closure
  // below, a boolean is narrowed to `false` where that closure is written and
  // the flips further down never widen it back.
  const child: { gone: boolean } = { gone: false }
  let staleAdvertisements = 2
  let served500s = 0
  const { client, calls } = fakeLlama((call) => {
    if (!child.gone) {
      return
    }
    if (call.path === CHAT_PATH) {
      served500s += 1
      return new Response('proxy error: Could not establish connection', { status: 500 })
    }
    if (call.path === MODELS_LIST_PATH) {
      // The router keeps claiming the instance for a beat after accepting the unload.
      if (staleAdvertisements > 0) {
        staleAdvertisements -= 1
        return modelsList([{ id: 'a', status: 'loaded' }])
      }
      return modelsList([{ id: 'a', status: 'unloaded' }])
    }
    if (call.path === LOAD_PATH) {
      child.gone = false
    }
    return
  })
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client))

  const loadsBefore = await warmUpAndCountLoads(router, a, calls)

  child.gone = true
  const { response: res } = await chatHop(router, a, 'a')

  expect(served500s).toBe(1)
  // It waited for the router to stop advertising the dying instance...
  expect(staleAdvertisements).toBe(0)
  // ...and only then issued a real reload.
  expectReloaded(res, calls, loadsBefore)
})

test("contention reports the request holding a role's lease and the one queued behind it", async () => {
  const { b, router, release, res1 } = await gatedPair()

  // A different model on the same role cannot overlap, so this one queues.
  const res2 = chatHop(router, b, 'b')
  await drainMicrotasks()

  expect(router.contention()).toEqual([{ role: 'chat', active: 1, waiting: 1 }])

  release()
  await text(res1)
  await text(res2)

  // Nothing running and nothing queued reports as no roles at all, not zeroes.
  expect(router.contention()).toEqual([])
})

test('queueMs is 0 for a lease granted immediately and positive for one queued behind it', async () => {
  const { b, router, release, res1 } = await gatedPair()

  // b's role/model is already the one a holds, so this one waits in line
  // behind a's lease rather than being granted on arrival. A real delay,
  // not just a microtask drain, so the wait has actual wall-clock time to
  // measure rather than risking a same-millisecond race.
  const res2 = chatHop(router, b, 'b')
  await new Promise((r) => setTimeout(r, 5))

  release()
  const [{ queueMs: queueMs1 }, { queueMs: queueMs2 }] = await Promise.all([res1, res2])

  expect(queueMs1).toBe(0)
  expect(queueMs2).toBeGreaterThan(0)
})

test('6 concurrent same-model requests against a parallel=2 role: active caps at 2, the other 4 queue at the door', async () => {
  const a = model({ id: 'a', filename: 'a.gguf', args: { parallel: 2 } })
  const { router, calls, release, inGate, send } = admissionOf(a)
  const r1 = send()
  await waitFor(() => inGate() === 1)
  const r2 = send()
  await waitFor(() => inGate() === 2)
  const rest = [send(), send(), send(), send()]

  // The other 4 must sit queued behind the cap, never reaching the gated
  // upstream call -- this is the acceptance test's own shape: 6 fired,
  // /engined/v1/engines' roles[] (backed by contention()) shows active
  // capped at the role's parallel and the remainder waiting.
  await drainMicrotasks()
  expect(inGate()).toBe(2)
  expect(router.contention()).toEqual([{ role: 'chat', active: 2, waiting: 4 }])

  release()
  await Promise.all([text(r1), text(r2), ...rest.map(text)])

  // Same GGUF the whole time -- one load, no swap, no eviction.
  expect(calls.filter((c) => c.path === LOAD_PATH)).toHaveLength(1)
  expect(router.contention()).toEqual([])
})

// `-1` and an unset key are the same instruction to llama.cpp -- take the
// auto slot count -- so the door admits against that count instead of
// without limit. A config buying the same cap by stating a positive
// `parallel` would pay for it by splitting the child's unified KV pool.
for (const [label, args] of [
  ["parallel = -1 (llama.cpp's own auto)", { parallel: -1 }],
  ['a route that never states parallel', {}],
] as const) {
  test(`${label} caps admission at the auto slot count the child really has`, async () => {
    const a = model({ id: 'a', filename: 'a.gguf', args })
    const { router, release, inGate, send } = admissionOf(a)
    const sent = [send(), send(), send(), send(), send()]
    await waitFor(() => inGate() === 4)

    await drainMicrotasks()
    expect(inGate()).toBe(4)
    expect(router.contention()).toEqual([{ role: 'chat', active: 4, waiting: 1 }])

    release()
    await Promise.all(sent.map(text))
    expect(router.contention()).toEqual([])
  })
}

test('a role nothing has touched is absent from contention rather than reported idle', () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const { router } = routerFor(e, [a])
  expect(router.contention()).toEqual([])
})

/**
 * Interleaving: "a" is resident and idle, so no lease is held and the queue is
 * empty. A request for "b" is shifted off the queue and parked inside
 * `swapResident`, which has already unloaded "a" -- but `activeModelId` still
 * reads "a", and the queue it emptied is still empty. A fresh request for "a"
 * then arrives and finds the same-GGUF bypass exactly true.
 */
test('a request for the resident model arriving while that GGUF is mid-unload queues instead of being admitted onto it', async () => {
  const { a, b, calls, release, started, router } = gatedUnloadPair()

  await chatText(router, a, 'a')
  expect(router.residentModel('chat')).toBe('a')
  expect(router.contention()).toEqual([])

  const resB = chatHop(router, b, 'b')
  await started

  const resA = chatHop(router, a, 'a')
  await drainMicrotasks()

  // Nothing may be in flight during a swap: "a" is gone from the child and
  // "b" is not there yet.
  expect(router.contention()).toEqual([{ role: 'chat', active: 0, waiting: 1 }])

  release()
  await Promise.all([text(resB), text(resA)])

  // "a" had to be loaded a second time to serve the second request, rather
  // than being served off the GGUF the swap had already unloaded.
  expect(calls.filter((c) => c.path === LOAD_PATH).map((c) => c.body?.model)).toEqual([
    'a',
    'b',
    'a',
  ])
})

/**
 * The same interleaving through `rewarmPinned`, which the pump reaches with an
 * empty queue rather than a waiter: "b" served and released, so the re-warm to
 * pinned "a" unloads "b" and parks -- `activeModelId` still "b", queue empty.
 * A request for "b" then arrives onto a GGUF the re-warm has already taken.
 */
test('a request for the resident model arriving while a keep_resident re-warm unloads it queues instead of being admitted onto it', async () => {
  const { b, calls, release, started, router } = gatedUnloadPair({ keep_resident: true })

  // Nothing is resident yet, so serving "b" loads it without an unload; the
  // release that follows is what starts the re-warm, and its unload is the
  // first this client ever sees.
  await chatText(router, b, 'b')
  await started

  const resB = chatHop(router, b, 'b')
  await drainMicrotasks()

  expect(router.contention()).toEqual([{ role: 'chat', active: 0, waiting: 1 }])

  release()
  await text(resB)
  // The release drains the role again, so the pin re-warms once more; wait it
  // out rather than asserting into the middle of it.
  await waitFor(() => router.residentModel('chat') === 'a')

  expect(calls.filter((c) => c.path === LOAD_PATH).map((c) => c.body?.model)).toEqual([
    'b',
    'a',
    'b',
    'a',
  ])
})

test('an unload the engine refuses fails that swap instead of loading the new GGUF beside the old one', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const b = model({ id: 'b', filename: 'b.gguf' })
  const { client, calls } = fakeLlama((call) =>
    call.path === UNLOAD_PATH ? new Response('model is busy', { status: 500 }) : undefined,
  )
  const router = routerWithClient(e, [a, b], client)

  await chatText(router, a, 'a')

  await expect(chatHop(router, b, 'b')).rejects.toThrow(UNLOAD_FAILED_ERROR)

  // "b" was never loaded on top of a still-resident "a", and the role still
  // believes what the child actually holds.
  expect(calls.filter((c) => c.path === LOAD_PATH).map((c) => c.body?.model)).toEqual(['a'])
  expect(router.residentModel('chat')).toBe('a')
  expect(router.contention()).toEqual([])
})

test('a keep_resident model is reloaded once its role drains', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf', keep_resident: true })
  const b = model({ id: 'b', filename: 'b.gguf' })
  const { calls, router } = routerFor(e, [a, b])

  // b wins the swap -- keep_resident never blocks another model's request.
  await chatText(router, b, 'b')

  // The re-warm is deliberately not awaited by the release that triggers it --
  // a request must not wait for the next one's head start -- so poll for it.
  await waitFor(() => router.residentModel('chat') === 'a')

  const loaded = calls.filter((c) => c.path === LOAD_PATH).map((c) => c.body?.model)
  expect(loaded).toEqual(['b', 'a'])
})

test('without keep_resident a role stays on whatever last served it', async () => {
  const { b, router } = pairRouter()

  await chatText(router, b, 'b')

  expect(router.residentModel('chat')).toBe('b')
})

test('warm loads a model without holding it: the lease is released again', async () => {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const { calls, router } = routerFor(e, [a])

  await router.warm(a)

  expect(router.residentModel('chat')).toBe('a')
  expect(calls.filter((c) => c.path === LOAD_PATH).map((c) => c.body?.model)).toEqual(['a'])
  expect(router.hasOutstandingLeases()).toBe(false)
  expect(router.contention()).toEqual([])
})

test('a held llama engine refuses to start and docker is never run', async () => {
  const runs: string[][] = []
  const inner = fakeExec()
  const exec: Exec = (args) => {
    if (args[0] === 'run') {
      runs.push([...args])
    }
    return inner(args)
  }
  const lifecycle = new DockerLifecycle(exec, fakeProbe)
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const { client } = fakeLlama()
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client))
  await lifecycle.hold(e.id, 60_000)
  await expect(chatText(router, a, 'a')).rejects.toBeInstanceOf(HeldError)
  expect(runs).toEqual([])
})

test('retiring a stale llama router releases its keep_resident pin', async () => {
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  const e = engine()
  const pinned = model({ id: 'a', filename: 'a.gguf', keep_resident: true })
  const unpinned = model({ id: 'a', filename: 'a.gguf' })
  const { client } = fakeLlama()
  let routes: ResolvedRoute[] = [pinned]
  const ctx: DoorContext = {
    getConfig: () => testConfig({ routes }),
    registry: {} as EngineRegistry,
    lifecycle,
    registryOpts: { enginesRoot: ENGINES_ROOT, bunx: BUNX, lifecycle },
    doorOpts: { llamaHttpClient: client, llamaPresetHostPath: tmpIniPath() },
    llamaRouters: new Map(),
    staleLlamaRouters: new Set(),
    launchNonces: new Set(),
    agenticInFlight: 0,
    comfyBindings: new Map(),
    comfySlots: new Map(),
    usage: new UsageTracker({ stateRoot: TEST_ROOT }),
  }
  const first = getLlamaRouter(ctx, e)
  await chatText(first, pinned, 'a')
  expect(lifecycle.getStatus(e.id).active_leases).toBe(1)
  ctx.staleLlamaRouters.add(e.id)
  routes = [unpinned]
  const second = getLlamaRouter(ctx, e)
  expect(second).not.toBe(first)
  expect(lifecycle.getStatus(e.id).active_leases).toBe(0)
})

describe('cache-aware slot placement', () => {
  /**
   * A real, tiny GGUF vocab ("a" and "b" each their own token, no merges) so
   * `classifyPrompt` tokenizes for real instead of falling back to chars/3 --
   * a repeated-character prompt's token count is then exactly its length,
   * and two prompts sharing a prefix share a fingerprint. `ceil(parallel/2)`
   * reserves slot ids `[0, longCount)` LONG and the rest SHORT.
   */
  function slotEngineAndRoute(
    parallel: number,
    thresholdTokens = 4,
  ): { e: EngineEntry; r: ResolvedRoute } {
    const modelsDir = join(TEST_ROOT, `slots-${Math.random().toString(36).slice(2)}`)
    writeGgufFixture(join(modelsDir, 'tiny.gguf'), {
      'general.architecture': 'qwen3',
      'tokenizer.ggml.model': 'gpt2',
      'tokenizer.ggml.pre': 'gpt2',
      'tokenizer.ggml.tokens': ['a', 'b'],
      'tokenizer.ggml.merges': [],
    })
    const e = engine({ models_dir: modelsDir })
    const r = baseRoute({
      engine: 'llama',
      model: 'ornith',
      filename: 'tiny.gguf',
      role: 'chat',
      slot_long_threshold: thresholdTokens,
      args: { parallel },
    })
    return { e, r }
  }

  function chatBody(content: string, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ model: 'ornith', messages: [{ role: 'user', content }], ...extra })
  }

  test('a prompt at or above the threshold is placed on the reserved long slot', async () => {
    const { e, r } = slotEngineAndRoute(2)
    const { calls, router } = routerFor(e, [r])
    await text(router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('aaaa') }))
    expect(calls.find((c) => c.path === CHAT_PATH)?.body?.id_slot).toBe(0)
  })

  test('a prompt under the threshold never lands on the long slot', async () => {
    const { e, r } = slotEngineAndRoute(2)
    const { calls, router } = routerFor(e, [r])
    await text(router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('a') }))
    expect(calls.find((c) => c.path === CHAT_PATH)?.body?.id_slot).toBe(1)
  })

  test('a repeated long prompt returns to the slot holding its matching prefix, not a virgin slot', async () => {
    // parallel = 4 -> two long slots (0, 1), so a plain LRU pick would send
    // the second identical prompt to slot 1 (never yet used) instead of back
    // to slot 0 -- only the fingerprint match explains landing on 0 twice.
    const { e, r } = slotEngineAndRoute(4)
    const { calls, router } = routerFor(e, [r])
    await text(router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('aaaa') }))
    await text(router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('aaaa') }))
    const chatCalls = calls.filter((c) => c.path === CHAT_PATH)
    expect(chatCalls.map((c) => c.body?.id_slot)).toEqual([0, 0])
  })

  test('a caller-supplied id_slot is forwarded untouched', async () => {
    const { e, r } = slotEngineAndRoute(2)
    const { calls, router } = routerFor(e, [r])
    await text(
      router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('aaaa', { id_slot: 9 }) }),
    )
    expect(calls.find((c) => c.path === CHAT_PATH)?.body?.id_slot).toBe(9)
  })

  test('parallel = 1 never places a slot', async () => {
    const { e, r } = slotEngineAndRoute(1)
    const { calls, router } = routerFor(e, [r])
    await text(router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('aaaa') }))
    expect(calls.find((c) => c.path === CHAT_PATH)?.body?.id_slot).toBeUndefined()
  })

  test('a long slot already busy is left unset for a second concurrent long request rather than reused', async () => {
    const { e, r } = slotEngineAndRoute(2)
    const { client, calls, release, inGate } = gatedClient(CHAT_PATH)
    const router = routerWithClient(e, [r], client)

    const first = router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('aaaa') })
    await waitFor(() => inGate() === 1)
    const second = router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('bbbb') })
    await waitFor(() => inGate() === 2)
    release()
    await Promise.all([text(first), text(second)])

    const chatCalls = calls.filter((c) => c.path === CHAT_PATH)
    expect(chatCalls[0]?.body?.id_slot).toBe(0)
    expect(chatCalls[1]?.body?.id_slot).toBeUndefined()
  })

  test('an aborted long request releases its slot for the next one', async () => {
    const { e, r } = slotEngineAndRoute(2)
    const { client: base, calls } = fakeLlama()
    let started: () => void = () => undefined
    const startedPromise = new Promise<void>((res) => {
      started = res
    })
    let firstChatSeen = false
    // The first chat call hangs until the caller aborts it; every later call
    // (including this same request's own load/poll plumbing) answers
    // normally through the shared `fakeLlama()` double.
    const client: HttpClient = (input, init) => {
      const url = new URL(String(input))
      if (url.pathname === CHAT_PATH && !firstChatSeen) {
        firstChatSeen = true
        started()
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      }
      return base(input, init)
    }
    const router = routerWithClient(e, [r], client)
    const controller = new AbortController()
    const aborted = router.proxy(r, CHAT_PATH, {
      method: 'POST',
      body: chatBody('aaaa'),
      signal: controller.signal,
    })
    await startedPromise
    controller.abort()
    await expect(aborted).rejects.toThrow()

    // Same router, same slot table: if the abort had not released slot 0,
    // this would be left with no idle long slot to place at all.
    await text(router.proxy(r, CHAT_PATH, { method: 'POST', body: chatBody('bbbb') }))
    expect(calls.find((c) => c.path === CHAT_PATH)?.body?.id_slot).toBe(0)
  })
})
