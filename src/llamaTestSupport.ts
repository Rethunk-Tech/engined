/**
 * llama-server router-double fixtures, shared by llama.test.ts and
 * llamaStream.test.ts. A `presetHostPath` is always taken as a parameter,
 * never defaulted from a shared temp root: each test file owns its own root
 * via its own `makeTestRoot()` call, whose `afterAll` cleanup fires on that
 * file's own schedule, not on whichever file happens to import this one.
 */
import { DockerLifecycle, type Probe } from './docker.ts'
import type { Exec } from './exec.ts'
import type { HttpClient } from './http.ts'
import { type LlamaHop, LlamaRouter } from './llama.ts'
import { pollUntil } from './records.ts'
import { BUNX, ENGINES_ROOT, engine, inspectSinglePort, portResult, route } from './test-support.ts'
import type { EngineEntry, ResolvedRoute } from './types.ts'

export const LLAMA_CHAT_PATH = '/openai/v1/chat/completions'
export const LLAMA_LOAD_PATH = '/models/load'
export const LLAMA_UNLOAD_PATH = '/models/unload'
export const LLAMA_MODELS_LIST_PATH = '/v1/models'

const LLAMA_CONTAINER_PORT = 8080
const LLAMA_HOST_PORT = 55_123
/** Tight, because every `waitFor` caller is waiting on in-process work, not on a container. */
const WAIT_INTERVAL_MS = 5

export function llamaEngine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return engine({ id: 'llama', models_dir: '/models-host', models_max: 3, ...overrides })
}

/** `id` names the route's `model` field -- kept as `id` here so every fixture built from it still reads as naming a GGUF, not a route. */
export function llamaModelRoute(
  overrides: { id?: string } & Omit<Partial<ResolvedRoute>, 'model'> = {},
): ResolvedRoute {
  const { id, ...rest } = overrides
  return route({ engine: 'llama', model: id ?? 'a', filename: 'a.gguf', role: 'chat', ...rest })
}

/** Answers `docker image inspect`/`run`/`start`/`port` the way a fresh, never-started container would. */
export function llamaFakeExec(): Exec {
  return (args) => {
    const [cmd] = args
    if (cmd === 'image') {
      return Promise.resolve(inspectSinglePort(LLAMA_CONTAINER_PORT))
    }
    if (cmd === 'start') {
      return Promise.resolve({ exitCode: 1, stdout: '', stderr: 'not created yet' })
    }
    if (cmd === 'port') {
      return Promise.resolve(portResult(LLAMA_HOST_PORT))
    }
    return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  }
}

export const llamaFakeProbe: Probe = () => Promise.resolve({ status: 200 })

export function llamaBaseOpts(httpClient: HttpClient, presetHostPath: string) {
  return {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    idleStopSeconds: 1000,
    readyTimeoutS: 5,
    presetHostPath,
    httpClient,
    pollIntervalMs: 1,
    streamStallSeconds: () => 60,
  }
}

export interface LlamaRecordedCall {
  path: string
  body: { model?: string; stream?: boolean; id_slot?: number } | undefined
}

/** Matches the real b10354 contract, probed live: `/models/load` never returns
 * `{status:"loaded"}` -- a not-yet-resident model answers `{success:true}`
 * (accepted) and an already-resident one 400s "model is already running".
 * That 400 is not readiness either -- probed live, it fired while a 23 GB
 * GGUF was still on load stage 0. The real signal is `GET /v1/models`'s
 * per-model `status.value`, which transitions unloaded -> loading -> loaded. */
export function llamaModelsList(entries: Array<{ id: string; status: string }>): Response {
  return Response.json({ data: entries.map((e) => ({ id: e.id, status: { value: e.status } })) })
}

/** A minimal llama-server router double: load/unload always succeed and the model
 * requested becomes immediately "loaded" on the next /v1/models poll; everything
 * else echoes its request model. */
export function llamaFakeClient(hook?: (call: LlamaRecordedCall) => Response | undefined): {
  client: HttpClient
  calls: LlamaRecordedCall[]
} {
  const calls: LlamaRecordedCall[] = []
  let lastLoadRequested: string | undefined
  const client: HttpClient = (input, init) => {
    const url = new URL(String(input))
    const bodyStr = typeof init?.body === 'string' ? init.body : undefined
    const body =
      bodyStr === undefined ? undefined : (JSON.parse(bodyStr) as LlamaRecordedCall['body'])
    const call: LlamaRecordedCall = { path: url.pathname, body }
    calls.push(call)
    const hooked = hook?.(call)
    if (hooked) {
      return Promise.resolve(hooked)
    }
    if (url.pathname === LLAMA_LOAD_PATH) {
      lastLoadRequested = body?.model
      return Promise.resolve(Response.json({ success: true }))
    }
    if (url.pathname === LLAMA_MODELS_LIST_PATH) {
      return Promise.resolve(
        llamaModelsList(
          lastLoadRequested === undefined ? [] : [{ id: lastLoadRequested, status: 'loaded' }],
        ),
      )
    }
    if (url.pathname === LLAMA_UNLOAD_PATH) {
      return Promise.resolve(Response.json({ ok: true }))
    }
    return Promise.resolve(Response.json({ ok: true, model: body?.model }))
  }
  return { client, calls }
}

/** Wires the given models to a router talking to `httpClient` over a fresh lifecycle. */
export function llamaRouterWithClient(
  e: EngineEntry,
  models: ResolvedRoute[],
  httpClient: HttpClient,
  presetHostPath: string,
): LlamaRouter {
  const lifecycle = new DockerLifecycle(llamaFakeExec(), llamaFakeProbe)
  return new LlamaRouter(e, models, lifecycle, llamaBaseOpts(httpClient, presetHostPath))
}

/**
 * `llamaFakeClient()` with its calls to `path` parked at a gate, so a caller can
 * prove work is genuinely in flight rather than already finished: `started`
 * resolves once the first call is parked, `inGate` counts how many are parked,
 * and `release` lets them all through. `once` gates only the first call, which
 * is what holding one request open behind a second, distinguishing one needs;
 * gating every call is what admission-control tests need, where several must
 * be in flight together. `inGate` counts entries and never decrements -- every
 * caller reads it before releasing.
 */
export function llamaGatedClient(
  path: string,
  { once = false }: { once?: boolean } = {},
): {
  client: HttpClient
  calls: LlamaRecordedCall[]
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
  const { client, calls } = llamaFakeClient()
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

export function llamaChatInit(
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

export function llamaChatHop(
  router: LlamaRouter,
  modelRoute: ResolvedRoute,
  modelId: string,
  extra: { stream?: boolean; signal?: AbortSignal } = {},
): Promise<LlamaHop> {
  return router.proxy(modelRoute, LLAMA_CHAT_PATH, llamaChatInit(modelId, extra))
}

export function llamaPair(
  aExtra: Parameters<typeof llamaModelRoute>[0] = {},
  bExtra: Parameters<typeof llamaModelRoute>[0] = {},
): { e: EngineEntry; a: ResolvedRoute; b: ResolvedRoute } {
  const e = llamaEngine()
  const a = llamaModelRoute({ id: 'a', filename: 'a.gguf', ...aExtra })
  const b = llamaModelRoute({ id: 'b', filename: 'b.gguf', ...bExtra })
  return { e, a, b }
}

/** Polls a condition the caller's system reaches on its own, for work no caller can await. */
export async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  if (!(await pollUntil(async () => cond(), Date.now() + timeoutMs, WAIT_INTERVAL_MS))) {
    throw new Error('condition never became true')
  }
}

/** Lets a pending `.then` chain run as far as it can without resolving any
 * new promise of its own -- three microtask turns is enough for a router's
 * internal queue pump to reach its next await. */
export async function drainMicrotasks(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
