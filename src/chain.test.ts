import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import { type HopExec, parseHop, type RunChainOptions, runChain } from './chain.ts'
import { chatRequest } from './doorFixtures.ts'
import { createDoor } from './main.ts'
import { recordCall } from './provenance.ts'
import { qualifiedSegments } from './routeAddress.ts'
import {
  BUNX,
  clearVerifiedVersion,
  collectLines,
  config,
  deadPort,
  engine,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  startFakeUpstream,
  writeEngineSpec,
} from './test-support.ts'
import type { Egress } from './types.ts'

const DEFAULT_TIMEOUT_MS = 2000

/** The engine a hop names, whether written qualified (`@/engine/...`) or as a bare engine id. */
function engineOf(hop: string): string {
  return qualifiedSegments(hop)?.[0] ?? hop
}

interface Behavior {
  status: number
  body?: string
  contentType?: string
  delayMs?: number
}

/** One fake upstream shared by every hop in a test, keyed by engine id; `requestLog` is the only proof a hop was never called. */
function startBehaviorUpstream(behaviors: Record<string, Behavior>) {
  const up = startFakeUpstream(async (req) => {
    const engineId = new URL(req.url).pathname.slice(1)
    const behavior = behaviors[engineId]
    if (!behavior) {
      return new Response('no route', { status: 404 })
    }
    if (behavior.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, behavior.delayMs))
    }
    return new Response(behavior.body ?? '', {
      status: behavior.status,
      headers: behavior.contentType ? { 'content-type': behavior.contentType } : undefined,
    })
  })
  return up
}

/**
 * A raw socket, not `Bun.serve`: emits one chunked-encoding frame with no
 * terminating `0\r\n\r\n` and cuts the connection, the same truncated-body
 * shape a dropped upstream connection leaves. `Bun.serve` recomputes
 * `content-length` from what a stream actually sends, so it cannot fake this.
 */
function startFlakyStreamUpstream(): { base: string; stop: () => void } {
  const chunk = 'data: partial\n\n'
  const chunkLen = new TextEncoder().encode(chunk).length
  const server = Bun.listen({
    hostname: '127.0.0.1',
    port: 0,
    socket: {
      open(socket) {
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunkLen.toString(16)}\r\n${chunk}\r\n`,
        )
        setTimeout(() => socket.terminate(), 5)
      },
      data() {
        // Nothing to read: this socket only ever writes.
      },
      close() {
        // The abrupt close is the point of this fake; nothing to react to.
      },
      error() {
        // Bun.listen requires a handler; the test asserts on the client's side of the drop.
      },
    },
  })
  return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

function makeExec(bases: Record<string, string>): HopExec {
  return async (hop, signal) => {
    const engineId = engineOf(hop)
    const base = bases[engineId]
    if (base === undefined) {
      throw new Error(`test exec: no route registered for ${engineId}`)
    }
    const res = await fetch(`${base}/${engineId}`, { signal })
    if (res.headers.get('content-type') === 'text/event-stream') {
      return { status: res.status, stream: res.body ?? undefined }
    }
    return { status: res.status, body: await res.text() }
  }
}

function baseOpts(
  overrides: Partial<RunChainOptions> &
    Pick<RunChainOptions, 'exec'> & { write?: (line: string) => void },
): RunChainOptions {
  const { write, ...rest } = overrides
  return {
    chain: 'test-chain',
    requested: 'chain-test-chain',
    egressOf: () => 'remote',
    timeoutMs: () => DEFAULT_TIMEOUT_MS,
    // Without this every runChain here writes its provenance line to the real
    // stdout; a test that asserts on the line passes its own collector.
    record: (record) => recordCall(record, write ?? (() => undefined)),
    ...rest,
  }
}

// model_reported/model_resident and version pass-through are not covered
// here: chain.ts's HopResult -> Attempt step is an unconditional object
// spread with no branching, and the values themselves are already proven at
// llama.test.ts (the derived model_reported/model_resident computation),
// provenance.test.ts (recordCall's serialization of both fields and of
// version) and dispatch.test.ts (the door's end-to-end provenance line).

test('parseHop reads the parsed shape by segment count, not a slash-joined model', () => {
  expect(parseHop('@/llama/ornith')).toEqual({ engine: 'llama', model: 'ornith' })
  expect(parseHop('@/cursor/openrouter/sonnet-5')).toEqual({
    engine: 'cursor',
    upstream: 'openrouter',
    model: 'sonnet-5',
  })
})

test("a three-segment hop's attempt records the bare model, never the upstream folded into it", async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () => Promise.resolve({ status: 200, body: 'answer' })

  const result = await runChain(['@/cursor/openrouter/sonnet-5'], baseOpts({ exec, write }))

  expect(result.status).toBe(200)
  expect(result.engineUsed).toBe('cursor')
  const record = soleProvenanceRecord(lines)
  expect(record.engine_used).toBe('cursor')
  expect(record.attempts[0]?.engine).toBe('cursor')
  expect(record.attempts[0]?.model).toBe('sonnet-5')
})

test('what an engine reported it cost reaches the provenance line', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      body: { usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } },
    })

  await runChain(['@/e/m'], baseOpts({ exec, write }))

  expect(hopAttempt(lines)?.usage).toEqual({
    prompt_tokens: 12,
    completion_tokens: 34,
    total_tokens: 46,
  })
})

// A field the engine did not send stays absent. Zero is a number a sum
// trusts, so defaulting to it would report a month of embeddings as having
// generated tokens it never did.
test('a half-reported usage records only what was reported, never a zero for the rest', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({ status: 200, body: { usage: { prompt_tokens: 20, total_tokens: 20 } } })

  await runChain(['@/e/m'], baseOpts({ exec, write }))

  const { usage } = soleProvenanceRecord(lines).attempts[0] ?? {}
  expect(usage).toEqual({ prompt_tokens: 20, total_tokens: 20 })
  expect(Object.hasOwn(usage ?? {}, 'completion_tokens')).toBe(false)
})

test('a body with no usage records none, rather than an empty object that reads as free', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () => Promise.resolve({ status: 200, body: { choices: [] } })

  await runChain(['@/e/m'], baseOpts({ exec, write }))

  expect(hopAttempt(lines)?.usage).toBeUndefined()
})

/** An SSE reply as an upstream sends one: token deltas, then a final frame stating the cost, then the terminator. */

async function drainSingleHop(exec: HopExec, write: (line: string) => void) {
  const result = await runChain(['@/e/m'], baseOpts({ exec, write }))
  await new Response(result.stream).text()
}

function hopAttempt(lines: string[]) {
  return soleProvenanceRecord(lines).attempts[0]
}

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start: (c) => {
      for (const frame of frames) {
        c.enqueue(encoder.encode(`data: ${frame}\n\n`))
      }
      c.enqueue(encoder.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
}

const DELTA = '{"choices":[{"delta":{"content":"ok"}}]}'
const DELTA_FRAME = `data: ${DELTA}\n\n`

/**
 * Captured verbatim from llama-server b10637-39817c476 through this door:
 * `stream: true` with `stream_options: {include_usage: true}`, five tokens
 * generated. The nested `prompt_tokens_details` and the whole `timings`
 * object are exactly what the engine sends, and both must be walked past
 * rather than tripped over. Only the completion id is shortened, because the
 * real one reads as a credential to the secret scanner; nothing reads it.
 */
const LLAMA_USAGE_FRAME =
  'data: {"choices":[],"created":1788969062,"id":"chatcmpl-x","model":"ornith","system_fingerprint":"b10637-39817c476","object":"chat.completion.chunk","usage":{"completion_tokens":5,"prompt_tokens":12,"total_tokens":17,"prompt_tokens_details":{"cached_tokens":8}},"timings":{"cache_n":8,"prompt_n":4,"prompt_ms":91.635,"predicted_n":5,"predicted_ms":91.273,"draft_n":2,"draft_n_accepted":2}}'

test("a real llama-server usage frame is read as the attempt's cost", async () => {
  const { lines, write } = collectLines()
  const encoder = new TextEncoder()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      stream: new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(encoder.encode(`${DELTA_FRAME}${LLAMA_USAGE_FRAME}\n\ndata: [DONE]\n\n`))
          c.close()
        },
      }),
    })

  await drainSingleHop(exec, write)

  // prompt_tokens is 12 -- the whole prompt. `timings.prompt_n` in the same
  // frame is 4, the uncached remainder after an 8-token cache hit, which is
  // why that field is not what this reads.
  expect(hopAttempt(lines)?.usage).toEqual({
    prompt_tokens: 12,
    completion_tokens: 5,
    total_tokens: 17,
  })
})

test("a streamed reply's cost is read out of its own frames", async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      stream: sseStream([
        DELTA,
        DELTA,
        '{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}',
      ]),
    })

  await drainSingleHop(exec, write)

  const attempt = hopAttempt(lines)
  expect(attempt?.streamed).toBe(true)
  expect(attempt?.usage).toEqual({ prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 })
})

// A frame split across two chunks is the normal case on a real socket, not an
// edge one: the scan keeps the partial line rather than dropping the frame.
test('a usage frame split across chunk boundaries is still read', async () => {
  const { lines, write } = collectLines()
  const encoder = new TextEncoder()
  const whole = `data: {"usage":{"total_tokens":41}}\n\n`
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      stream: new ReadableStream<Uint8Array>({
        start: (c) => {
          c.enqueue(encoder.encode(whole.slice(0, 20)))
          c.enqueue(encoder.encode(whole.slice(20)))
          c.close()
        },
      }),
    })

  await drainSingleHop(exec, write)

  expect(hopAttempt(lines)?.usage).toEqual({ total_tokens: 41 })
})

// An upstream that restates a running total every frame ends on the total,
// not on the first figure it happened to send.
test('the last usage frame wins', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      stream: sseStream([
        '{"usage":{"total_tokens":1}}',
        '{"usage":{"total_tokens":2}}',
        '{"usage":{"total_tokens":9}}',
      ]),
    })

  await drainSingleHop(exec, write)

  expect(hopAttempt(lines)?.usage).toEqual({ total_tokens: 9 })
})

// What was spent before the stream died was still spent.
test('a stream that dies after stating its cost still records it, as a failure', async () => {
  const { lines, write } = collectLines()
  const encoder = new TextEncoder()
  let sent = false
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      // Enqueued and errored in one `start` would deliver nothing at all --
      // `error()` discards the queue -- so the frame goes out on its own pull
      // first, the way a socket delivers bytes before it drops.
      stream: new ReadableStream<Uint8Array>({
        pull: (c) => {
          if (sent) {
            c.error(new Error('upstream went away'))
            return
          }
          sent = true
          c.enqueue(encoder.encode('data: {"usage":{"total_tokens":7}}\n\n'))
        },
      }),
    })

  await drainSingleHop(exec, write).catch(() => undefined)

  const [attempt] = soleProvenanceRecord(lines).attempts
  expect(attempt?.ok).toBe(false)
  expect(attempt?.usage).toEqual({ total_tokens: 7 })
})

// The guard that keeps the scan off the hot path must not also make it miss
// a real frame: ordinary content mentioning the word is not a usage record.
test('content that merely says usage is not mistaken for a cost', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      stream: sseStream(['{"choices":[{"delta":{"content":"the \\"usage\\" of it"}}]}']),
    })

  await drainSingleHop(exec, write)

  expect(hopAttempt(lines)?.usage).toBeUndefined()
})

// The one thing that separates "cost nothing" from "cost unknown": an
// upstream that states no cost in its frames.
test('a streamed attempt is marked streamed and carries no usage', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      stream: new ReadableStream<Uint8Array>({
        start: (c) => {
          c.close()
        },
      }),
    })

  // The line for a streamed reply is written when the stream ends, so it does
  // not exist until something has read it to completion.
  await drainSingleHop(exec, write)

  const attempt = hopAttempt(lines)
  expect(attempt?.streamed).toBe(true)
  expect(attempt?.usage).toBeUndefined()
})

// `Number("1234")` would turn a provider's string into a figure someone sums,
// and nothing downstream could tell it from a number the provider sent.
test('a non-numeric usage field is dropped, not coerced', async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({ status: 200, body: { usage: { prompt_tokens: '1234', total_tokens: 9 } } })

  await runChain(['@/e/m'], baseOpts({ exec, write }))

  expect(hopAttempt(lines)?.usage).toEqual({ total_tokens: 9 })
})

test('a 4xx on hop 1 does not advance: hop 2 is never invoked', async () => {
  const up = startBehaviorUpstream({
    badreq: { status: 400, body: 'bad request', contentType: 'text/plain' },
    unused: { status: 200, body: 'should never be seen' },
  })

  const result = await runChain(
    ['@/badreq/model', '@/unused/model'],
    baseOpts({ exec: makeExec({ badreq: up.base, unused: up.base }) }),
  )
  up.stop()

  expect(result.status).toBe(400)
  expect(up.requestLog).not.toContain('/unused')
})

// A key rejection is a property of THIS hop's credential, not of the
// caller's request -- a second engine can plausibly still answer, where a
// plain 400 (the caller's own malformed request) cannot be fixed by trying
// a different upstream.
test('a 401 on hop 1 advances to hop 2; a 400 on hop 1 does not', async () => {
  const advancing = startBehaviorUpstream({
    unauthed: { status: 401, body: 'no key', contentType: 'text/plain' },
    success: { status: 200, body: 'answer', contentType: 'text/plain' },
  })
  const advanced = await runChain(
    ['@/unauthed/model', '@/success/model'],
    baseOpts({ exec: makeExec({ unauthed: advancing.base, success: advancing.base }) }),
  )
  advancing.stop()
  expect(advanced.status).toBe(200)
  expect(advanced.engineUsed).toBe('success')

  const stopping = startBehaviorUpstream({
    badreq: { status: 400, body: 'bad request', contentType: 'text/plain' },
    success: { status: 200, body: 'answer', contentType: 'text/plain' },
  })
  const stopped = await runChain(
    ['@/badreq/model', '@/success/model'],
    baseOpts({ exec: makeExec({ badreq: stopping.base, success: stopping.base }) }),
  )
  stopping.stop()
  expect(stopped.status).toBe(400)
  expect(stopping.requestLog).not.toContain('/success')
})

test("an envelope failure on hop 1 does not advance, even carrying a 5xx status: hop 2's own call log stays empty", async () => {
  const hopCalls: string[] = []
  const exec: HopExec = (hop) => {
    hopCalls.push(engineOf(hop))
    if (engineOf(hop) === 'agentic') {
      return Promise.resolve({
        status: 502,
        body: { error: 'agentic envelope failure: api_error' },
        envelopeFailure: true,
      })
    }
    return Promise.resolve({ status: 200, body: 'should never be seen' })
  }

  const result = await runChain(['@/agentic/model', '@/unused/model'], baseOpts({ exec }))

  expect(result.status).toBe(502)
  expect(hopCalls).toEqual(['agentic'])
})

test('a 5xx, a connection failure, and an empty body each advance to the next hop', async () => {
  const up = startBehaviorUpstream({
    servererr: { status: 500, body: 'boom', contentType: 'text/plain' },
    empty: { status: 200, body: '', contentType: 'text/plain' },
    success: { status: 200, body: 'answer', contentType: 'text/plain' },
  })
  const dead = deadPort()

  const result = await runChain(
    ['@/servererr/model', '@/connfail/model', '@/empty/model', '@/success/model'],
    baseOpts({
      exec: makeExec({
        servererr: up.base,
        connfail: `http://127.0.0.1:${dead}`,
        empty: up.base,
        success: up.base,
      }),
    }),
  )
  up.stop()

  expect(result.status).toBe(200)
  expect(result.engineUsed).toBe('success')
})

test('a stream that dies after the first byte does not advance, and the failure lands in provenance', async () => {
  const flaky = startFlakyStreamUpstream()
  const up = startBehaviorUpstream({ unused: { status: 200, body: 'should never be seen' } })
  const { lines, write } = collectLines()

  const result = await runChain(
    ['@/flaky/model', '@/unused/model'],
    baseOpts({ exec: makeExec({ flaky: flaky.base, unused: up.base }), write }),
  )
  flaky.stop()

  expect(result.stream).toBeDefined()
  const reader = (result.stream as ReadableStream).getReader()
  let sawError = false
  try {
    for (;;) {
      const { done } = await reader.read()
      if (done) {
        break
      }
    }
  } catch {
    sawError = true
  }
  up.stop()

  expect(sawError).toBe(true)
  expect(up.requestLog).not.toContain('/unused')
  const record = soleProvenanceRecord(lines)
  expect(record.attempts).toHaveLength(1)
  expect(record.attempts[0]?.ok).toBe(false)
  expect(record.attempts[0]?.failure).toBeDefined()
})

test('every hop failing returns 503 listing each attempt', async () => {
  const up = startBehaviorUpstream({
    servererr: { status: 500, body: 'boom', contentType: 'text/plain' },
  })
  const dead = deadPort()

  const result = await runChain(
    ['@/servererr/model', '@/connfail/model'],
    baseOpts({ exec: makeExec({ servererr: up.base, connfail: `http://127.0.0.1:${dead}` }) }),
  )
  up.stop()

  expect(result.status).toBe(503)
  const body = result.body as { attempts: unknown[] }
  expect(body.attempts).toHaveLength(2)
})

test('a direct address that answers 429 returns 429 rather than a synthesized 503', async () => {
  const up = startBehaviorUpstream({
    ratelimited: { status: 429, body: 'slow down', contentType: 'text/plain' },
  })
  const result = await runChain(
    ['@/ratelimited/model'],
    baseOpts({ chain: null, exec: makeExec({ ratelimited: up.base }) }),
  )
  up.stop()

  expect(result.status).toBe(429)
  expect(result.body).toBe('slow down')
})

test('a stream-only 429 still returns 429', async () => {
  const exec: HopExec = () =>
    Promise.resolve({
      status: 429,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"error":"rate limited"}'))
          controller.close()
        },
      }),
    })

  const result = await runChain(['@/e/m'], baseOpts({ chain: null, exec }))

  expect(result.status).toBe(429)
  expect(result.stream).toBeDefined()
})

test('max_egress: none drops every hop over the ceiling, wherever it sits in the list', async () => {
  const up = startBehaviorUpstream({
    localengine: { status: 200, body: 'local answer', contentType: 'text/plain' },
    remote1: { status: 200, body: 'should never be seen' },
    remote2: { status: 200, body: 'should never be seen' },
  })
  const egress: Record<string, Egress> = {
    localengine: 'none',
    remote1: 'remote',
    remote2: 'remote',
  }

  const result = await runChain(
    ['@/localengine/model', '@/remote1/model', '@/remote2/model'],
    baseOpts({
      maxEgress: 'none',
      egressOf: (hop) => egress[engineOf(hop)] ?? 'remote',
      exec: makeExec({ localengine: up.base, remote1: up.base, remote2: up.base }),
    }),
  )
  up.stop()

  expect(result.status).toBe(200)
  expect(result.engineUsed).toBe('localengine')
  expect(up.requestLog).not.toContain('/remote1')
  expect(up.requestLog).not.toContain('/remote2')
})

// The boundary the bare-comparison trap gets wrong: alphabetically
// "lan" < "none", so `egressOf(hop) <= maxEgress` as a plain string compare
// would admit this hop under a "none" ceiling. Asserted by name, with a real
// "lan" upstream, rather than folded into the "remote" case above -- a
// remote-only test passes even with the broken comparator this guards
// against.
test('max_egress: "none" refuses a "lan" hop, not just a "remote" one', async () => {
  const result = await runChain(
    ['@/lanengine/model'],
    baseOpts({
      maxEgress: 'none',
      egressOf: () => 'lan',
      exec: () => {
        throw new Error('exec must not be called: the lan hop exceeds a none ceiling')
      },
    }),
  )

  expect(result.status).toBe(400)
  expect(JSON.stringify(result.body)).toContain('max_egress')
})

// The failure actually seen against the deployed door: a chain whose only
// hop resolves to a local upstream must be SERVED under a "none" ceiling,
// not refused -- the fixture that let a broken egressOf always answer
// "remote" is exactly what let this regress silently.
test('max_egress: "none" serves a chain whose only hop is local', async () => {
  const up = startBehaviorUpstream({
    localengine: { status: 200, body: 'local answer', contentType: 'text/plain' },
  })

  const result = await runChain(
    ['@/localengine/model'],
    baseOpts({
      maxEgress: 'none',
      egressOf: () => 'none',
      exec: makeExec({ localengine: up.base }),
    }),
  )
  up.stop()

  expect(result.status).toBe(200)
  expect(result.engineUsed).toBe('localengine')
})

test('a chain with no hop inside the ceiling returns 400 without calling exec', async () => {
  const result = await runChain(
    ['@/remote1/model', '@/remote2/model'],
    baseOpts({
      maxEgress: 'none',
      egressOf: () => 'remote',
      exec: () => {
        throw new Error('exec must not be called when nothing in the chain is within the ceiling')
      },
    }),
  )

  expect(result.status).toBe(400)
})

test('an absent max_egress applies no ceiling at all: every hop is attempted regardless of egress', async () => {
  const up = startBehaviorUpstream({ remote1: { status: 200, body: 'answer' } })

  const result = await runChain(
    ['@/remote1/model'],
    baseOpts({
      egressOf: () => 'remote',
      exec: makeExec({ remote1: up.base }),
    }),
  )
  up.stop()

  expect(result.status).toBe(200)
})

test('the per-attempt timeout is per hop, not per request: two hops each under the bound both run', async () => {
  const HopDelayMs = 100
  const PerHopTimeoutMs = 400
  const up = startBehaviorUpstream({
    slowFail: { status: 500, body: 'boom', contentType: 'text/plain', delayMs: HopDelayMs },
    slowSuccess: { status: 200, body: 'answer', contentType: 'text/plain', delayMs: HopDelayMs },
  })

  const result = await runChain(
    ['@/slowFail/model', '@/slowSuccess/model'],
    baseOpts({
      timeoutMs: () => PerHopTimeoutMs,
      exec: makeExec({ slowFail: up.base, slowSuccess: up.base }),
    }),
  )
  up.stop()

  expect(result.status).toBe(200)
  expect(result.engineUsed).toBe('slowSuccess')
})

test("a client disconnecting mid-stream still emits the call's provenance line", async () => {
  const { lines, write } = collectLines()
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      body: null,
      stream: new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode('data: chunk\n\n'))
        },
      }),
    })

  const result = await runChain(['@/e1/m'], baseOpts({ exec, write }))

  // Nothing is emitted while the body is still owed to the caller.
  expect(lines.length).toBe(0)

  const reader = result.stream?.getReader()
  await reader?.read()
  await reader?.cancel()

  const record = soleProvenanceRecord(lines)
  expect(record.attempts[0]?.ok).toBe(false)
  expect(record.attempts[0]?.failure).toBe('client disconnected')
})

test('a stream whose source fails while the client is reading nothing still emits its provenance line', async () => {
  const { lines, write } = collectLines()
  let fail: (err: Error) => void = () => undefined
  const exec: HopExec = () =>
    Promise.resolve({
      status: 200,
      body: null,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          // One chunk fills the wrapper's own queue, so no pull of its own is
          // pending when the source fails -- what a client reading nothing leaves.
          controller.enqueue(new TextEncoder().encode('data: chunk\n\n'))
          fail = (err) => controller.error(err)
        },
      }),
    })

  await runChain(['@/e1/m'], baseOpts({ exec, write }))
  await Bun.sleep(0)
  fail(new Error('client stalled: read nothing for 60s'))
  await Bun.sleep(0)

  const record = soleProvenanceRecord(lines)
  expect(record.attempts[0]?.failure).toBe('client stalled: read nothing for 60s')
})

test('a client abort stops the chain instead of advancing and billing the next provider', async () => {
  const up = startBehaviorUpstream({
    slow: { status: 502, delayMs: 500 },
    second: { status: 200, body: 'answer' },
  })
  const controller = new AbortController()
  setTimeout(() => controller.abort(), 20)

  const result = await runChain(
    ['@/slow/m', '@/second/m'],
    baseOpts({
      exec: makeExec({ slow: up.base, second: up.base }),
      signal: controller.signal,
    }),
  )

  expect(result.status).toBe(499)
  // The whole point: a 502 normally advances, so `second` would have been
  // called. requestLog is the only proof it was not.
  expect(up.requestLog).toEqual(['/slow'])
  up.stop()
})

test('an unaborted signal leaves chain walking untouched', async () => {
  const up = startBehaviorUpstream({
    first: { status: 502 },
    second: { status: 200, body: 'answer' },
  })

  const result = await runChain(
    ['@/first/m', '@/second/m'],
    baseOpts({
      exec: makeExec({ first: up.base, second: up.base }),
      signal: new AbortController().signal,
    }),
  )

  expect(result.status).toBe(200)
  expect(up.requestLog).toEqual(['/first', '/second'])
  up.stop()
})

test("a hop whose body carries a child agent's words records the status alone", async () => {
  const { lines, write } = collectLines()
  const fix =
    'engine "claude" pin 2.0.1 failed the "byte-identical" probe: ' +
    'launch answered 502: CHILD_AGENT_PARSE_WORDS (stderr: CHILD_STDERR_TAIL_SECRET)'
  const exec: HopExec = (hop) =>
    Promise.resolve(
      engineOf(hop) === 'claude'
        ? { status: 503, body: { error: fix }, bodyCarriesAgentOutput: true }
        : { status: 200, body: 'answer' },
    )

  await runChain(['@/claude/model', '@/success/model'], baseOpts({ exec, write }))

  const record = soleProvenanceRecord(lines)
  expect(record.attempts[0]?.failure).toBe('http 503')
  expect(lines.join('')).not.toContain('CHILD_STDERR_TAIL_SECRET')
  expect(lines.join('')).not.toContain('CHILD_AGENT_PARSE_WORDS')
})

// `x-engined-queue-ms` (`hop.ts`'s own llama hop sets it via `HopResult.headers`)
// merges onto the answering-route set in `finalizeTerminal`, same as every
// other per-hop header -- so a chain reports the hop that actually answered,
// never the one that failed first, even though that one ran too.
test('a chain reports the queue time of the hop that answered, not the one that failed first', async () => {
  const { write } = collectLines()
  const exec: HopExec = (hop) =>
    Promise.resolve(
      engineOf(hop) === 'dead'
        ? { status: 502, body: 'down', headers: new Headers({ 'x-engined-queue-ms': '999' }) }
        : { status: 200, body: 'answer', headers: new Headers({ 'x-engined-queue-ms': '4' }) },
    )

  const result = await runChain(['@/dead/m', '@/live/m'], baseOpts({ exec, write }))

  expect(result.headers?.get('x-engined-queue-ms')).toBe('4')
})

const AGENTIC_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
env = ["HOME"]
`

/**
 * The mark above only holds if the hop that actually builds this body sets
 * it, so this drives the real door: a failed pin probe's `detail` is the
 * child's own parsed stdout and stderr tail, and `proveAgenticPin` is the
 * one site that puts it on a `HopResult`.
 */
test("a failed pin probe's detail never reaches the provenance line", async () => {
  const id = 'claude-leaky'
  clearVerifiedVersion(id)
  const root = mkdtempSync(join(makeTestRoot('engined-chain-test-'), 'door-'))
  writeEngineSpec(root, id, AGENTIC_SPEC)
  const cfg = config({
    routes: [route({ engine: id, model: 'assistant', upstream: null })],
    engines: [engine({ id, agent_version: '9.9.9' })],
  })
  const probeRunner: AgenticProbeRunner = () =>
    Promise.resolve({
      ok: false,
      failedProbe: 'byte-identical',
      detail: 'launch answered 502: CHILD_PARSE_WORDS (stderr: CHILD_STDERR_SECRET)',
    })
  const { lines, write } = collectLines()
  const door = createDoor(
    cfg,
    { enginesRoot: root, bunx: BUNX, agenticProbeRunner: probeRunner },
    { write },
  )

  const res = await door.fetch(
    chatRequest({
      model: `@/${id}/assistant`,
      messages: [{ role: 'user', content: 'hi' }],
      workdir: '/tmp',
    }),
  )

  expect(res.status).toBe(503)
  expect(soleProvenanceRecord(lines).attempts[0]?.failure).toBe('http 503')
  expect(lines.join('')).not.toContain('CHILD_STDERR_SECRET')
  expect(lines.join('')).not.toContain('CHILD_PARSE_WORDS')
  clearVerifiedVersion(id)
})

test('a streamed 5xx the chain advances past is cancelled at once, not left for the stall timer', async () => {
  let cancelled = false
  const exec: HopExec = (hop) =>
    Promise.resolve(
      hop === '@/first/m'
        ? {
            status: 503,
            stream: new ReadableStream<Uint8Array>({
              cancel: () => {
                cancelled = true
              },
            }),
          }
        : { status: 200, body: { choices: [{ message: { content: 'ok' } }] } },
    )
  const result = await runChain(['@/first/m', '@/second/m'], baseOpts({ exec }))
  expect(result.status).toBe(200)
  expect(cancelled).toBe(true)
})
