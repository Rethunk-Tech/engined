import { expect, test } from 'bun:test'
import { DockerLifecycle, type Probe } from './docker.ts'
import type { HttpClient } from './http.ts'
import { LlamaRouter } from './llama.ts'
import {
  llamaBaseOpts as baseOpts,
  LLAMA_CHAT_PATH as CHAT_PATH,
  llamaChatHop as chatHop,
  llamaChatInit as chatInit,
  drainMicrotasks,
  llamaEngine as engine,
  llamaFakeExec as fakeExec,
  llamaFakeClient as fakeLlama,
  llamaFakeProbe as fakeProbe,
  llamaGatedClient as gatedClient,
  LLAMA_LOAD_PATH as LOAD_PATH,
  LLAMA_MODELS_LIST_PATH as MODELS_LIST_PATH,
  llamaModelRoute as model,
  llamaModelsList as modelsList,
  llamaPair as pair,
  llamaRouterWithClient as routerWithClient,
  waitFor,
} from './llamaTestSupport.ts'
import { MS_PER_SECOND } from './records.ts'
import { makeTestRoot, tempPresetPath } from './test-support.ts'
import type { EngineEntry, ResolvedRoute } from './types.ts'

/** Short enough to wait out in a test, and far longer than an eager reader ever leaves a chunk queued. */
const STALL_SECONDS = 0.05

// This file's own temp root, never llama.test.ts's: its cleanup runs on
// llama.test.ts's own schedule, which has already fired by the time this
// file's tests run.
const TEST_ROOT = makeTestRoot('engined-llama-stream-test-')

function tmpIniPath(): string {
  return tempPresetPath(TEST_ROOT)
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

function sseBody(chunk: string, onCancel?: () => void): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new TextEncoder().encode(chunk))
    },
    ...(onCancel === undefined ? {} : { cancel: onCancel }),
  })
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
    baseOpts(loadListChatClient(chatReply), tmpIniPath()),
  )
  return { e, a, router }
}

/** A single "a" model wired to a router with the default `fakeLlama()` client. */
function singleModelRouter(): { e: EngineEntry; a: ResolvedRoute; router: LlamaRouter } {
  const e = engine()
  const a = model({ id: 'a', filename: 'a.gguf' })
  const router = routerWithClient(e, [a], fakeLlama().client, tmpIniPath())
  return { e, a, router }
}

function stallRouter(chunks: () => ReadableStream<Uint8Array>): {
  a: ResolvedRoute
  router: LlamaRouter
} {
  const a = model({ id: 'a', filename: 'a.gguf' })
  const client = loadListChatClient(
    () => new Response(chunks(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
  )
  const router = new LlamaRouter(engine(), [a], new DockerLifecycle(fakeExec(), fakeProbe), {
    ...baseOpts(client, tmpIniPath()),
    streamStallSeconds: () => STALL_SECONDS,
  })
  return { a, router }
}

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

test('a streaming client that holds the socket but stops reading is aborted as a stall and its lease released', async () => {
  let upstreamCancelled = false
  const { a, router } = stallRouter(() =>
    sseBody('data: chunk\n\n', () => {
      upstreamCancelled = true
    }),
  )

  const { response } = await chatHop(router, a, 'a', { stream: true })
  expect(router.hasOutstandingLeases()).toBe(true)

  await waitFor(() => !router.hasOutstandingLeases())
  expect(upstreamCancelled).toBe(true)
  // What reaches provenance: the stream ends in an error naming the stall.
  await expect(response.text()).rejects.toThrow(/client stalled/)
})

test('a client that keeps reading is never stalled, however long the upstream takes between chunks', async () => {
  const gapMs = STALL_SECONDS * MS_PER_SECOND * 3
  const { a, router } = stallRouter(() => {
    let sent = 0
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        await Bun.sleep(gapMs)
        sent += 1
        controller.enqueue(new TextEncoder().encode(`data: ${sent}\n\n`))
        if (sent === 3) {
          controller.close()
        }
      },
    })
  })

  const { response } = await chatHop(router, a, 'a', { stream: true })
  expect(await response.text()).toEndWith('data: 1\n\ndata: 2\n\ndata: 3\n\n')
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
  const router = routerWithClient(e, [a], client, tmpIniPath())

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

test('queueMs is 0 for a lease granted immediately and positive for one queued behind it', async () => {
  // An injected clock rather than real timers: a real-timer version of this
  // assertion is exactly the flake a sibling run hit (the "immediate" grant
  // read 1ms on a loaded box, since ensureStarted's own cold-start work is
  // real wall-clock time too). The clock only ever advances where this test
  // moves it, so which lease waited is provable by construction, not by luck.
  let clock = 0
  const { e, a, b } = pair()
  const { client: gated, release, started } = gatedClient(CHAT_PATH, { once: true })
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe)
  const router = new LlamaRouter(e, [a, b], lifecycle, {
    ...baseOpts(gated, tmpIniPath()),
    now: () => clock,
  })
  const res1 = chatHop(router, a, 'a')
  await started

  // b's role/model is already the one a holds, so this one waits in line
  // behind a's lease rather than being granted on arrival.
  clock = 5
  const res2 = chatHop(router, b, 'b')
  await drainMicrotasks()
  clock = 9

  release()
  const [{ queueMs: queueMs1 }, { queueMs: queueMs2 }] = await Promise.all([res1, res2])

  expect(queueMs1).toBe(0)
  expect(queueMs2).toBe(4)
})

test.each([
  ['a proxied chat', (router: LlamaRouter, a: ResolvedRoute) => chatHop(router, a, 'a')],
  [
    'a bare withLease',
    (router: LlamaRouter) =>
      router.withLease('chat', 'a', undefined, (queueMs) => Promise.resolve({ queueMs })),
  ],
] as const)(
  'queueMs excludes a cold container start for %s: only lease contention counts',
  async (_, hold) => {
    let clock = 0
    const e = engine()
    const a = model({ id: 'a', filename: 'a.gguf' })
    const { client } = fakeLlama()
    let releaseProbe: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      releaseProbe = r
    })
    let probeStarted: () => void = () => undefined
    const probeStartedPromise = new Promise<void>((r) => {
      probeStarted = r
    })
    const gatedProbe: Probe = async (url, method) => {
      probeStarted()
      await gate
      return fakeProbe(url, method)
    }
    const lifecycle = new DockerLifecycle(fakeExec(), gatedProbe)
    const router = new LlamaRouter(e, [a], lifecycle, {
      ...baseOpts(client, tmpIniPath()),
      now: () => clock,
    })

    const res = hold(router, a)
    await probeStartedPromise
    // Time the fake clock never sees moving except where the test moves it --
    // this stands in for the real wall-clock cost of the container coming up.
    clock = 50
    releaseProbe()

    const { queueMs } = await res
    expect(queueMs).toBe(0)
  },
)
