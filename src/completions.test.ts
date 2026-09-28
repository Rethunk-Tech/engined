/**
 * `POST /openai/v1/completions`: request mapping onto llama-server's
 * `/infill`, response mapping back (buffered and streamed), and the refusal
 * a route not opted in with `fim` gets. Against a fake upstream per
 * AGENTS.md -- no mocks, a real door, a real `LlamaRouter`.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { wrapStream } from './chain.ts'
import { infillRequestInit, mapInfillStream } from './completions.ts'
import { createLlamaDoor, llamaExec } from './doorFixtures.ts'
import type { HttpClient } from './http.ts'
import {
  collectLines,
  config,
  engine,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  tempPresetPath,
  upstream,
  withLlamaControl,
  writeEngineSpec,
} from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-completions-')

const COMPLETIONS_PATH = '/openai/v1/completions'

/** Same shape as `LOCAL_LLAMA_SPEC` in `doorFixtures.ts`, plus the completions verb this suite needs and its sibling files do not. */
const LOCAL_LLAMA_FIM_SPEC = `
kind = "openai-http"
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/chat/completions", "${COMPLETIONS_PATH}"]
command = []

[ready]
path = "/health"
status = 200
`

function completionsRequest(body: unknown, signal?: AbortSignal): Request {
  return new Request(`http://engined${COMPLETIONS_PATH}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  })
}

/** One local llama engine with a chat route that opts into `fim` (or not, for the refusal case). */
function fimDoorConfig(testRoot: string, fim: boolean): { cfg: Config; root: string } {
  const root = mkdtempSync(join(testRoot, 'engined-completions-door-'))
  writeEngineSpec(root, 'local-llama', LOCAL_LLAMA_FIM_SPEC)
  const cfg = config({
    engines: [engine({ id: 'local-llama', models_dir: '/data/gguf', models_max: 1 })],
    routes: [
      route({ engine: 'local-llama', model: 'ornith', filename: 'x.gguf', role: 'chat', fim }),
    ],
  })
  return { cfg, root }
}

/** llama-server's own `/infill` reply shape, buffered: never OpenAI's. */
const INFILL_REPLY = {
  content: 'return a + b',
  stop: true,
  stopped_eos: false,
  stopped_word: true,
  stop_type: 'eos',
  tokens_predicted: 5,
  tokens_evaluated: 12,
}

/** Two native llama.cpp SSE frames -- a mid-stream delta, then the terminal one carrying the stop reason and token counts -- with a keepalive comment between them that maps to nothing. No `[DONE]`: llama-server never sends one. */
const INFILL_SSE = [
  `data: ${JSON.stringify({ content: 'return', stop: false })}\n\n`,
  ': keepalive\n\n',
  `data: ${JSON.stringify({ content: ' a + b', stop: true, stop_type: 'limit', tokens_predicted: 5, tokens_evaluated: 12 })}\n\n`,
].join('')

function recordControlledClient(
  recorded: { url: string; body: string }[],
  respond: () => Response,
): HttpClient {
  return withLlamaControl((url, init) => {
    if (typeof init?.body === 'string') {
      recorded.push({ url, body: init.body })
    }
    return Promise.resolve(respond())
  })
}

function makeInfillHttpClient(
  recorded: { url: string; body: string }[],
  reply: 'buffered' | 'streamed',
): HttpClient {
  return recordControlledClient(recorded, () =>
    reply === 'streamed'
      ? new Response(INFILL_SSE, { headers: { 'content-type': 'text/event-stream' } })
      : Response.json(INFILL_REPLY),
  )
}

function doorFor(cfg: Config, root: string, httpClient: HttpClient, write: (line: string) => void) {
  return createLlamaDoor(
    cfg,
    root,
    { llamaHttpClient: httpClient, llamaPresetHostPath: tempPresetPath(dirname(root)), write },
    llamaExec(),
  )
}

describe('infillRequestInit: request mapping', () => {
  test("maps the OpenAI completions body onto llama-server's infill fields", () => {
    const init = infillRequestInit(
      {
        prompt: 'def add(a, b):\n    ',
        suffix: '\n\nprint(add(1, 2))\n',
        max_tokens: 16,
        temperature: 0.2,
        stop: ['\n'],
        stream: false,
        extra: [{ filename: 'utils.py', text: 'def helper(): ...' }],
      },
      'ornith',
    )
    const body = JSON.parse(init.body as string)
    expect(body).toEqual({
      model: 'ornith',
      input_prefix: 'def add(a, b):\n    ',
      input_suffix: '\n\nprint(add(1, 2))\n',
      stream: false,
      response_fields: ['content', 'stop', 'stop_type', 'tokens_predicted', 'tokens_evaluated'],
      input_extra: [{ filename: 'utils.py', text: 'def helper(): ...' }],
      n_predict: 16,
      temperature: 0.2,
      stop: ['\n'],
    })
  })

  test('a body with none of the optional fields still carries prefix/suffix/model', () => {
    const init = infillRequestInit({}, 'ornith')
    expect(JSON.parse(init.body as string)).toEqual({
      model: 'ornith',
      input_prefix: '',
      input_suffix: '',
      stream: false,
      response_fields: ['content', 'stop', 'stop_type', 'tokens_predicted', 'tokens_evaluated'],
    })
  })

  test('a malformed "extra" (not filename/text objects) is dropped rather than forwarded', () => {
    const init = infillRequestInit({ extra: ['not-an-object', { filename: 'x.py' }] }, 'ornith')
    expect(JSON.parse(init.body as string).input_extra).toBeUndefined()
  })
})

describe('POST /openai/v1/completions: response mapping', () => {
  test('a buffered infill reply maps to the OpenAI completions shape', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const recorded: { url: string; body: string }[] = []
    const { lines, write } = collectLines()
    const door = doorFor(cfg, root, makeInfillHttpClient(recorded, 'buffered'), write)
    const res = await door.fetch(
      completionsRequest({
        model: '@/local-llama/ornith',
        prompt: 'def add(a, b):\n    ',
        suffix: '\n\nprint(add(1, 2))\n',
        max_tokens: 16,
        stop: ['\n'],
      }),
    )
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      object: string
      choices: { text: string; finish_reason: string | null }[]
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
    }
    expect(body.object).toBe('text_completion')
    expect(body.choices[0]?.text).toBe('return a + b')
    expect(body.choices[0]?.finish_reason).toBe('stop')
    expect(body.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
    expect(recorded[0]?.url.endsWith('/infill')).toBe(true)
    expect(soleProvenanceRecord(lines).engine_used).toBe('local-llama')
  })

  test('a buffered completions reply carries the answering-route headers', async () => {
    const { cfg: base, root } = fimDoorConfig(TEST_ROOT, true)
    const cfg = { ...base, upstreams: [upstream()] }
    const door = doorFor(cfg, root, makeInfillHttpClient([], 'buffered'), () => undefined)
    const res = await door.fetch(
      completionsRequest({
        model: '@/local-llama/ornith',
        prompt: 'def add(a, b):\n    ',
        suffix: '\n\nprint(add(1, 2))\n',
      }),
    )
    await res.json()
    expect(res.headers.get('x-engined-route')).toBe('@/local-llama/ornith')
    expect(res.headers.get('x-engined-upstream')).toBe('local')
    expect(res.headers.get('x-engined-egress')).toBe('none')
    expect(res.headers.get('x-engined-chain')).toBeNull()
  })

  test('a stop_type of "limit" reports finish_reason "length"', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const recorded: { url: string; body: string }[] = []
    const httpClient = recordControlledClient(recorded, () =>
      Response.json({ ...INFILL_REPLY, stopped_word: false, stop_type: 'limit' }),
    )
    const door = doorFor(cfg, root, httpClient, () => undefined)
    const res = await door.fetch(
      completionsRequest({ model: '@/local-llama/ornith', prompt: 'x', max_tokens: 1 }),
    )
    const body = (await res.json()) as { choices: { finish_reason: string | null }[] }
    expect(body.choices[0]?.finish_reason).toBe('length')
  })

  test('a streamed infill reply maps each frame to an OpenAI completions chunk, terminated by [DONE]', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const recorded: { url: string; body: string }[] = []
    const { lines, write } = collectLines()
    const door = doorFor(cfg, root, makeInfillHttpClient(recorded, 'streamed'), write)
    const res = await door.fetch(
      completionsRequest({
        model: '@/local-llama/ornith',
        prompt: 'def add(a, b):\n    ',
        stream: true,
      }),
    )
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const text = await res.text()
    const frames = text
      .trim()
      .split('\n\n')
      .filter((f) => f.startsWith('data:'))
    expect(frames.at(-1)).toBe('data: [DONE]')
    const parsed = frames.slice(0, -1).map((f) => JSON.parse(f.slice('data:'.length).trim()))
    expect(parsed.map((p) => p.choices[0].text)).toEqual(['return', ' a + b'])
    expect(parsed[0].choices[0].finish_reason).toBeNull()
    expect(parsed[1].choices[0].finish_reason).toBe('length')
    expect(parsed[1].usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
    // The request that reached llama-server carried the caller's own stream flag through to infill.
    expect(JSON.parse(recorded[0]?.body ?? '{}').stream).toBe(true)
    expect(soleProvenanceRecord(lines).attempts[0]?.ok).toBe(true)
  })

  test('a stream that errors mid-body records a failure, not the success recorded before it started', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const { lines, write } = collectLines()
    const brokenStream: HttpClient = withLlamaControl(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(INFILL_SSE.slice(0, 30)))
          controller.error(new Error('upstream died mid-body'))
        },
      })
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      )
    })
    const door = doorFor(cfg, root, brokenStream, write)
    const res = await door.fetch(
      completionsRequest({ model: '@/local-llama/ornith', prompt: 'x', stream: true }),
    )
    await res.text().catch(() => undefined)
    const record = soleProvenanceRecord(lines)
    expect(record.attempts[0]?.ok).toBe(false)
  })

  test('a route that did not opt in with fim refuses the request, not silently 200s', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, false)
    const recorded: { url: string; body: string }[] = []
    const door = doorFor(cfg, root, makeInfillHttpClient(recorded, 'buffered'), () => undefined)
    const res = await door.fetch(completionsRequest({ model: '@/local-llama/ornith', prompt: 'x' }))
    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(res.status).toBeLessThan(500)
    expect(recorded).toHaveLength(0)
    expect(res.headers.get('x-engined-route')).toBeNull()
  })

  test('a failed infill records the engine error text, not a bare status', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const { lines, write } = collectLines()
    const httpClient: HttpClient = withLlamaControl(() =>
      Promise.resolve(Response.json({ error: 'infill rejected the prefix' }, { status: 502 })),
    )
    const door = doorFor(cfg, root, httpClient, write)
    const res = await door.fetch(completionsRequest({ model: '@/local-llama/ornith', prompt: 'x' }))
    expect(res.status).toBe(502)
    expect(soleProvenanceRecord(lines).attempts[0]?.failure).toBe(
      'http 502: infill rejected the prefix',
    )
  })

  test('an unknown model on the completions path is refused the same way any other unknown model is', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const door = doorFor(cfg, root, makeInfillHttpClient([], 'buffered'), () => undefined)
    const res = await door.fetch(completionsRequest({ model: '@/local-llama/nope', prompt: 'x' }))
    expect(res.status).toBe(400)
  })

  test('an infill fetch that refuses the connection is JSON 502 with provenance, not an uncaught TypeError', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const { lines, write } = collectLines()
    const httpClient: HttpClient = withLlamaControl(() =>
      Promise.reject(new TypeError('Unable to connect. Is the computer able to access the url?')),
    )
    const door = doorFor(cfg, root, httpClient, write)
    const res = await door.fetch(completionsRequest({ model: '@/local-llama/ornith', prompt: 'x' }))
    expect(res.status).toBe(502)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain(
      'Unable to connect',
    )
    expect(soleProvenanceRecord(lines).attempts[0]?.failure).toContain('connection failed')
  })

  test('an infill request whose caller already disconnected records "client disconnected", not "connection failed"', async () => {
    const { cfg, root } = fimDoorConfig(TEST_ROOT, true)
    const { lines, write } = collectLines()
    // Whatever error a dropped connection surfaces as, the caller's own
    // aborted signal is what should decide the recorded reason -- not the
    // error's own shape.
    const httpClient: HttpClient = withLlamaControl(() =>
      Promise.reject(new TypeError('other side closed')),
    )
    const door = doorFor(cfg, root, httpClient, write)
    const controller = new AbortController()
    controller.abort()
    const res = await door.fetch(
      completionsRequest({ model: '@/local-llama/ornith', prompt: 'x' }, controller.signal),
    )
    expect(res.status).toBe(502)
    const failure = soleProvenanceRecord(lines).attempts[0]?.failure
    expect(failure).toBe('client disconnected')
  })
})

/** `reader.read()` with a deadline: a pull that enqueues nothing and never gets called again hangs a plain reader forever, which a bare `await reader.read()` would mask as a slow test rather than a failure. */
function readWithTimeout(
  reader: { read(): Promise<{ done: boolean; value?: Uint8Array }> },
  ms: number,
): Promise<{ done: boolean; value?: Uint8Array }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('mapInfillStream stalled on a keepalive frame')),
      ms,
    )
    reader.read().then((result) => {
      clearTimeout(timer)
      resolve(result)
    }, reject)
  })
}

test('mapInfillStream keeps pulling past a keepalive frame that maps to nothing, rather than stalling a plain reader', async () => {
  const source = new ReadableStream<Uint8Array>({
    // Each frame arrives on its own tick, as separate TCP reads would, rather
    // than pre-buffered together -- the shape that exposed the stall.
    async start(controller) {
      const encoder = new TextEncoder()
      for (const frame of INFILL_SSE.split('\n\n')
        .filter(Boolean)
        .map((f) => `${f}\n\n`)) {
        await Bun.sleep(0)
        controller.enqueue(encoder.encode(frame))
      }
      controller.close()
    },
  })
  const reader = mapInfillStream(source, 'ornith').getReader()
  const decoder = new TextDecoder()
  let text = ''
  for (;;) {
    const { done, value } = await readWithTimeout(reader, 500)
    if (done) {
      break
    }
    text += decoder.decode(value)
  }
  const frames = text
    .trim()
    .split('\n\n')
    .filter((f) => f.startsWith('data:'))
  expect(frames.at(-1)).toBe('data: [DONE]')
  const parsed = frames.slice(0, -1).map((f) => JSON.parse(f.slice('data:'.length).trim()))
  expect(parsed.map((p) => p.choices[0].text)).toEqual(['return', ' a + b'])
})

test('a source that fails while nobody reads the infill stream still reaches provenance as a failure', async () => {
  let fail: (err: Error) => void = () => undefined
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      // Enough frames that every queue downstream fills and stops pulling,
      // which is the state a stall deadline fires in.
      controller.enqueue(new TextEncoder().encode(INFILL_SSE.repeat(3)))
      fail = (err) => controller.error(err)
    },
  })
  const settled = new Promise<{ ok: boolean; failure?: string }>((resolve) => {
    wrapStream(mapInfillStream(source, 'ornith'), (ok, failure) => resolve({ ok, failure }))
  })
  await Bun.sleep(10)
  fail(new Error('client stalled: read nothing for 60s'))
  const outcome = await Promise.race([settled, Bun.sleep(500).then(() => 'never settled')])
  expect(outcome).toEqual({ ok: false, failure: 'client stalled: read nothing for 60s' })
})

test('cancelling the infill stream while the source is silent reaches the source at once', async () => {
  let cancelledWith: unknown = 'not cancelled'
  // A source mid-prefill: one frame, then nothing until cancelled.
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(INFILL_SSE.split('\n\n')[0] + '\n\n'))
    },
    cancel(reason) {
      cancelledWith = reason
    },
  })
  const reader = mapInfillStream(source, 'ornith').getReader()
  expect((await reader.read()).done).toBe(false)
  const parked = reader.read()
  await Bun.sleep(10)
  await Promise.race([reader.cancel('client gone'), Bun.sleep(200)])
  expect(cancelledWith).toBe('client gone')
  expect(await parked).toEqual({ done: true, value: undefined })
})
