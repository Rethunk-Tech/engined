/**
 * A chain is an ordered array of already-qualified `@/<engine>/<model>` hops.
 * Config parse guarantees the form; this file only decides whether to move
 * to the next hop and reports every attempt through `src/provenance.ts`.
 */

import {
  HTTP_CLIENT_ERROR_MIN,
  HTTP_SERVER_ERROR_MAX,
  HTTP_SERVER_ERROR_MIN,
  jsonErrorBody,
  STATUS_BAD_REQUEST,
  STATUS_CLIENT_CLOSED,
  STATUS_FORBIDDEN,
  STATUS_PAYMENT_REQUIRED,
  STATUS_TOO_MANY_REQUESTS,
  STATUS_UNAUTHORIZED,
  STATUS_UNAVAILABLE,
} from './http.ts'
import {
  type Attempt,
  answeringHeaders,
  type CallRecord,
  recordCall,
  type Usage,
} from './provenance.ts'
import type { Egress } from './types.ts'
import {
  errMessage,
  isRecord,
  parseRecord,
  qualifiedSegments,
  routeForHop,
  withinCeiling,
} from './types.ts'

export interface HopResult {
  status: number
  body?: unknown
  stream?: ReadableStream
  /**
   * Set only by an agentic hop whose envelope itself failed (`RunAgenticResult.envelopeFailure`).
   * Neither a 4xx nor an ordinary 5xx: it never advances a chain regardless of
   * `status`, because the failure is proven, not merely a transport error a
   * retry against the next hop might route around.
   */
  envelopeFailure?: boolean
  /**
   * Text a child agent wrote -- its parsed stdout, or the tail of its stderr --
   * reached this body. It still answers the caller, but no provenance line
   * carries a child's words, so the recorded failure keeps the status alone.
   * Set it where the body is built: a hop knows what it put there, and nothing
   * downstream can tell engined's own sentence from an agent's.
   */
  bodyCarriesAgentOutput?: boolean
  /** The router id the answering engine echoed back, when the hop kind can report one. Passed straight to the attempt's `model_reported`. */
  modelReported?: string
  /** Read per attempt from the answering engine's own `GET /v1/models`, when it can supply one. Passed straight to the attempt's `model_resident`. */
  modelResident?: string
  /** Set only by an agentic hop, from the version that actually launched. Passed straight to the attempt's `version`; absent for every other hop kind. */
  version?: string
  /** This hop's resolved upstream id, or `"local"`. Absent for an ambient hop. Passed straight to the attempt's `upstream_used`. */
  upstreamUsed?: string
  /** Present only when this agentic hop used the web-only research floor. */
  research?: true
  /** What this hop cost, where the hop kind knows it without a body to read -- an agentic CLI states it in its own envelope. Beats `usageFrom` when set. */
  usage?: Usage
  /**
   * A binary body, which an audio hop answers with instead of `body` -- synthesized
   * speech is bytes, not JSON. Counts as a body for advance-vs-terminal below: a 200
   * carrying audio and no `body` is an answer, not the empty reply that advances.
   */
  bytes?: Uint8Array
}

export type HopExec = (hop: string, signal: AbortSignal) => Promise<HopResult>

export interface RunChainOptions {
  /** The named chain this hop list came from, or null for a single unqualified hop. */
  chain: string | null
  /** The model id the caller actually asked for — what provenance calls `requested`. */
  requested: string
  /** Absent means no ceiling: every hop is attempted regardless of its own egress. */
  maxEgress?: Egress
  /** Per hop, not per engine — a two-engine hop can each resolve to a different upstream the engine id alone cannot distinguish. Fail-closed `"remote"` when a hop cannot be resolved to a route at all. */
  egressOf: (hop: string) => Egress
  /**
   * Per hop, not per request or per chain — a two-engine chain bounded per
   * request could run twice as long as intended, and a chain that merely
   * contains an agentic hop somewhere must not force every OTHER hop in it
   * onto the long agentic budget. The caller picks the budget from the hop
   * it is about to attempt.
   */
  timeoutMs: (hop: string) => number
  /** The client's own signal. Distinct from the per-hop timeout: when this fires there is no one left to answer, so the chain stops instead of advancing and billing the next provider. */
  signal?: AbortSignal
  exec: HopExec
  /** Injected so a test can capture the provenance line instead of reading real stdout. */
  write?: (line: string) => void
}

interface ChainResult {
  status: number
  body?: unknown
  stream?: ReadableStream
  /** The answering hop's binary body, where it had one. Only an audio hop sets it. */
  bytes?: Uint8Array
  engineUsed: string | null
  /**
   * The `x-engined-*` headers naming which hop answered, set only once a hop
   * has actually committed as the answer (`finalizeTerminal`). Absent
   * whenever no hop did -- an exhausted chain, an egress ceiling that leaves
   * nothing to attempt, or a client that left mid-chain -- because there is
   * no route to name in any of those.
   */
  headers?: Headers
}

/** A hop is the two- or three-segment qualified form, `@/<engine>/<model>` or `@/<engine>/<upstream>/<model>`; the third segment is the model only when present. */
export function parseHop(hop: string): { engine: string; upstream?: string; model: string } {
  const [engine = hop, second = '', third] = qualifiedSegments(hop) ?? []
  return third === undefined
    ? { engine, model: second }
    : { engine, upstream: second, model: third }
}

/**
 * Every route one chain hop names, before any disabled filter decides what is
 * left of them.
 *
 * A **modelless** engine's two-segment hop names an upstream in its second
 * segment, not a model. Every audio engine's routes declare no model, so read
 * the other way `@/piper/local` resolves to nothing and no such engine could
 * be a chain hop at all. Config parse refuses an engine that mixes modelless
 * and model-bearing routes, so one route answers the question for the engine.
 *
 * Config parse, the models menu and dispatch all ask this, and a hop that
 * three callers read three ways is a hop the menu reports unavailable while
 * the door happily dispatches it.
 */
export function chainHopRoutes<
  T extends { engine: string; model?: string; upstream: string | null; disabled?: boolean },
>(routes: readonly T[], hop: string): { candidates: T[]; modelless: boolean } {
  const { engine: engineId, upstream, model } = parseHop(hop)
  const engineRoutes = routes.filter((r) => r.engine === engineId)
  if (engineRoutes.some((r) => r.model === undefined)) {
    // A third segment on a modelless engine names a model it has no room for,
    // so nothing matches and the caller reports the address as naming nothing.
    return {
      candidates: engineRoutes.filter(
        (r) => r.model === undefined && upstream === undefined && r.upstream === model,
      ),
      modelless: true,
    }
  }
  return {
    candidates: engineRoutes.filter(
      (r) => r.model === model && (upstream === undefined || r.upstream === upstream),
    ),
    modelless: false,
  }
}

/** The one served route a chain hop resolves to, or `undefined` when the address names nothing servable. */
export function routeForChainHop<
  T extends { engine: string; model?: string; upstream: string | null; disabled?: boolean },
>(routes: readonly T[], hop: string): T | undefined {
  const { engine: engineId, upstream, model } = parseHop(hop)
  const { candidates, modelless } = chainHopRoutes(routes, hop)
  if (modelless) {
    return candidates.find((r) => r.disabled !== true)
  }
  // Model-bearing hops keep `routeForHop`'s upstream defaulting, which decides
  // between sibling routes that share one (engine, model).
  return routeForHop(routes, engineId, model, upstream)
}

/**
 * A 4xx naming a problem with THIS hop's own credential -- missing or bad
 * auth, no balance, rate-limited -- is not a problem with the caller's
 * request, and a second engine can plausibly answer where this one could
 * not. The rest of 4xx still terminates: a caller's own malformed request
 * is not something a different upstream can fix either.
 */
const ADVANCING_CLIENT_ERRORS = new Set([
  STATUS_UNAUTHORIZED,
  STATUS_PAYMENT_REQUIRED,
  STATUS_FORBIDDEN,
  STATUS_TOO_MANY_REQUESTS,
])

/**
 * The status alone cannot say what went wrong: a hop refused before it was
 * ever asked -- no workdir, an unresolvable upstream -- puts the only
 * explanation in its body, and an attempt recorded as bare `http 502` reads
 * as an engine that failed. Excluded is any body a hop has marked as carrying
 * a child agent's words -- the property that decides this, rather than a
 * status or a shape that happens to correlate with one today.
 */
function failureOf(result: HopResult): string {
  const status = `http ${result.status}`
  const { body } = result
  if (
    result.bodyCarriesAgentOutput === true ||
    typeof body !== 'object' ||
    body === null ||
    !('error' in body)
  ) {
    return status
  }
  return typeof body.error === 'string' ? `${status}: ${body.error}` : status
}

/** The one place status and body decide advance-vs-terminal. 4xx never advances even with an empty body -- except the credential-shaped ones above -- and 5xx and empty body always do, except an envelope failure, which never advances regardless of status. */
export function classifyResult(result: HopResult): {
  advance: boolean
  ok: boolean
  failure?: string
} {
  if (result.envelopeFailure) {
    return { advance: false, ok: false, failure: failureOf(result) }
  }
  if (result.status >= HTTP_SERVER_ERROR_MIN && result.status < HTTP_SERVER_ERROR_MAX) {
    return { advance: true, ok: false, failure: failureOf(result) }
  }
  if (ADVANCING_CLIENT_ERRORS.has(result.status)) {
    return { advance: true, ok: false, failure: failureOf(result) }
  }
  if (result.status >= HTTP_CLIENT_ERROR_MIN && result.status < HTTP_SERVER_ERROR_MIN) {
    return { advance: false, ok: false, failure: failureOf(result) }
  }
  // Bytes are a body: a speech hop answers 200 with audio and no `body` at all,
  // which would otherwise read as the empty reply that advances to the next hop.
  const carriesBytes = (result.bytes?.byteLength ?? 0) > 0
  const emptyBody = result.body === undefined || result.body === ''
  if (!(result.stream || carriesBytes) && emptyBody) {
    return { advance: true, ok: false, failure: 'empty body' }
  }
  return { advance: false, ok: true }
}

/** Forwards chunks unchanged; a read that throws mid-body reports the failure instead of restarting the prompt elsewhere. `onDone` is handed the byte count actually forwarded, so a caller that classifies by body size sees what the client received rather than nothing at all. */
export function wrapStream<T>(
  source: ReadableStream<T>,
  onDone: (ok: boolean, failure?: string, bytes?: number) => void,
  /** Handed every byte chunk as it is forwarded, for a caller reading something out of the frames themselves. Rides the `isView` branch the byte count already takes, so a non-byte stream costs nothing. */
  scan?: (chunk: Uint8Array) => void,
): ReadableStream<T> {
  const reader = source.getReader()
  let forwarded = 0
  // Whichever terminus arrives first owns the line; `cancel` can still fire
  // after a `pull` has closed the stream.
  let settled = false
  const settle = (ok: boolean, failure?: string) => {
    if (settled) {
      return
    }
    settled = true
    onDone(ok, failure, forwarded)
  }
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          settle(true)
          return
        }
        if (ArrayBuffer.isView(value)) {
          forwarded += value.byteLength
          scan?.(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
        }
        controller.enqueue(value)
      } catch (err) {
        controller.error(err)
        settle(false, errMessage(err))
      }
    },
    cancel(reason) {
      // A disconnect is a terminus like any other. Without this the call that
      // died mid-body is the one call that never appears in provenance --
      // precisely the one worth being able to find later.
      settle(false, 'client disconnected')
      reader.cancel(reason).catch(() => undefined)
    },
  })
}

/**
 * Drops every hop whose own egress exceeds the ceiling, wherever it sits in
 * the list -- a hop over the ceiling is a safety property, not a priority
 * hint, so it is never attempted regardless of what comes after it. `null`
 * means nothing in the chain survives the filter at all.
 */
function effectiveHops(hops: string[], opts: RunChainOptions): string[] | null {
  if (opts.maxEgress === undefined) {
    return hops
  }
  const kept = hops.filter((hop) => withinCeiling(opts.egressOf(hop), opts.maxEgress))
  return kept.length === 0 ? null : kept
}

function emit(
  opts: RunChainOptions,
  attempts: Attempt[],
  engineUsed: string | null,
  upstreamUsed: string | null,
): void {
  const record: CallRecord = {
    chain: opts.chain,
    requested: opts.requested,
    attempts,
    engine_used: engineUsed,
    upstream_used: upstreamUsed,
  }
  recordCall(record, opts.write)
}

interface HopOutcome {
  attempt: Attempt
  result?: HopResult
  advance: boolean
}

/** One numeric field of a reported `usage`, or absent. Absent for a non-number, never coerced: a provider sending `"1234"` is a shape engined does not understand, and `Number()` would turn that into a figure someone sums. */
function usageField(raw: Record<string, unknown>, key: string): number | undefined {
  const value = raw[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** One reported `usage` object as engined records it, or `undefined` for one it understood no field of -- which is not a cost record. */
function pickUsage(raw: Record<string, unknown>): Usage | undefined {
  const out: Usage = {
    prompt_tokens: usageField(raw, 'prompt_tokens'),
    completion_tokens: usageField(raw, 'completion_tokens'),
    total_tokens: usageField(raw, 'total_tokens'),
  }
  return Object.values(out).some((v) => v !== undefined) ? out : undefined
}

/**
 * What the engine said this attempt cost, read off the body it already
 * returned. Every kind funnels through here rather than each hop builder
 * setting it: an engine that reports `usage` gets it recorded whatever verb
 * it answered, and one that reports none records none rather than a zero.
 *
 * A streamed reply has no such body; `StreamUsage` reads its frames instead.
 */
function usageFrom(result: HopResult): Usage | undefined {
  const { body } = result
  if (typeof body !== 'object' || body === null) {
    return undefined
  }
  const { usage } = body as { usage?: unknown }
  return isRecord(usage) ? pickUsage(usage) : undefined
}

/**
 * A streamed reply's frames are the only place its cost is stated, and the
 * provenance line for one is already deferred until the stream ends -- so the
 * figure is there to be read by the time the line is written.
 *
 * Scans rather than buffers: SSE frames are newline-delimited, so this keeps
 * one partial line and forgets every frame it has already considered. The
 * `"usage"` substring guard is what keeps it off the hot path -- a token
 * delta never matches it, so no chunk of ordinary output is ever parsed.
 *
 * The LAST usage seen wins. An upstream that reports cumulatively per frame
 * ends on the total; one that reports once ends on the only one.
 *
 * Measured, against llama-server b10637 through this door: a streamed reply
 * carries NO `usage` frame unless the caller sent
 * `stream_options: {include_usage: true}`. It always carries `timings`, whose
 * `prompt_n`/`predicted_n` are token counts -- deliberately not read here.
 * With a prefix-cache hit `prompt_n` is only the uncached remainder (measured
 * `prompt_n: 4, cache_n: 8` against `usage.prompt_tokens: 12`), so a figure
 * from it would be engined's own arithmetic rather than the engine's answer,
 * and llama is the local engine, which no budget is counting anyway. The
 * paid upstreams all speak `usage` or nothing.
 */
class StreamUsage {
  private readonly decoder = new TextDecoder()
  private carry = ''
  private found: Usage | undefined

  push(chunk: Uint8Array): void {
    this.carry += this.decoder.decode(chunk, { stream: true })
    const lines = this.carry.split('\n')
    // The tail is whatever came after the last newline: a partial frame, kept
    // until the rest of it arrives.
    this.carry = lines.pop() ?? ''
    if (this.carry.length > MAX_CARRY_BYTES) {
      // A body with no newline in it is not SSE, and holding it whole is the
      // one way this scan could cost memory proportional to the reply.
      this.carry = ''
    }
    for (const line of lines) {
      this.consider(line)
    }
  }

  /** The figure to record, after the last frame. The final line needs considering too: a stream may end without a trailing newline. */
  done(): Usage | undefined {
    this.consider(this.carry)
    return this.found
  }

  private consider(line: string): void {
    if (!line.includes('"usage"')) {
      return
    }
    const payload = line.startsWith('data:') ? line.slice('data:'.length).trim() : line.trim()
    const usage = parseRecord(payload)?.usage
    if (isRecord(usage)) {
      this.found = pickUsage(usage) ?? this.found
    }
  }
}

/** Past this with no newline the body is not SSE, so the scan stops holding it. Generous for one frame; nothing near a whole reply. */
const MAX_CARRY_BYTES = 65_536

/** One hop's whole attempt: clock started here, not at chain start, so queue wait before it never counts against it. */
async function runOneHop(hop: string, opts: RunChainOptions): Promise<HopOutcome> {
  const { engine, model } = parseHop(hop)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs(hop))
  // The hop dies on whichever comes first: its own budget, or the client leaving.
  const signal = opts.signal ? AbortSignal.any([controller.signal, opts.signal]) : controller.signal
  const start = Date.now()
  try {
    const result = await opts.exec(hop, signal)
    clearTimeout(timer)
    const outcome = classifyResult(result)
    return {
      attempt: {
        engine,
        model,
        ok: outcome.ok,
        failure: outcome.failure,
        duration_ms: Date.now() - start,
        model_reported: result.modelReported,
        model_resident: result.modelResident,
        version: result.version,
        upstream_used: result.upstreamUsed,
        research: result.research,
        // A hop that stated its own cost wins: an agentic envelope carries
        // one where the OpenAI-shaped body this would otherwise read has none.
        usage: result.usage ?? usageFrom(result),
        streamed: result.stream === undefined ? undefined : true,
      },
      result,
      advance: outcome.advance,
    }
  } catch (err) {
    clearTimeout(timer)
    // Checked before the timeout: a client abort leaves `controller` untouched, so the timeout arm would otherwise claim it.
    let failure = `connection failed: ${errMessage(err)}`
    if (opts.signal?.aborted) {
      failure = 'client disconnected'
    } else if (controller.signal.aborted) {
      failure = 'timeout'
    }
    return {
      attempt: { engine, model, ok: false, failure, duration_ms: Date.now() - start },
      advance: true,
    }
  }
}

/**
 * Commits to a hop as the answer. A streaming result defers its provenance
 * line until the stream ends, so a mid-body death still lands as that
 * attempt's failure -- but the answering-route headers are built right here,
 * before either branch returns, because they name which hop is streaming and
 * a header cannot be added once the body has started.
 */
function finalizeTerminal(
  terminal: { hop: string; attempt: Attempt; result: HopResult },
  attempts: Attempt[],
  opts: RunChainOptions,
): ChainResult {
  const { hop, attempt, result } = terminal
  const { engine } = attempt
  const upstreamUsed = attempt.upstream_used ?? null
  const headers = answeringHeaders({
    route: hop,
    upstreamUsed,
    egress: opts.egressOf(hop),
    chain: opts.chain,
    // Absent for a streaming result: an agentic hop's own usage (and its
    // cost) is not read until the stream ends, well after these headers are
    // already on the wire -- see `answeringHeaders`'s own comment.
    costUsd: attempt.usage?.cost_usd,
  })
  if (!result.stream) {
    emit(opts, attempts, engine, upstreamUsed)
    return {
      status: result.status,
      body: result.body,
      bytes: result.bytes,
      engineUsed: engine,
      headers,
    }
  }
  const scanner = new StreamUsage()
  const stream = wrapStream(
    result.stream,
    (ok, streamFailure) => {
      if (!ok) {
        attempt.ok = false
        attempt.failure = streamFailure ?? 'stream ended before completion'
      }
      // After the last frame, which is where an upstream states the total --
      // and still worth reading on a failed stream, since what was spent
      // before it died was spent.
      attempt.usage = scanner.done() ?? attempt.usage
      emit(opts, attempts, engine, upstreamUsed)
    },
    (chunk) => {
      scanner.push(chunk)
    },
  )
  return { status: result.status, body: result.body, stream, engineUsed: engine, headers }
}

export async function runChain(hops: string[], opts: RunChainOptions): Promise<ChainResult> {
  const truncated = effectiveHops(hops, opts)
  if (truncated === null) {
    emit(opts, [], null, null)
    return {
      status: STATUS_BAD_REQUEST,
      body: jsonErrorBody(
        `max_egress: "${opts.maxEgress}" leaves no hop in this chain within the ceiling`,
      ),
      engineUsed: null,
    }
  }

  const attempts: Attempt[] = []
  for (const hop of truncated) {
    if (opts.signal?.aborted) {
      return abandoned(attempts, opts)
    }
    const outcome = await runOneHop(hop, opts)
    attempts.push(outcome.attempt)
    if (outcome.advance) {
      continue
    }
    return finalizeTerminal(
      { hop, attempt: outcome.attempt, result: outcome.result as HopResult },
      attempts,
      opts,
    )
  }

  if (opts.signal?.aborted) {
    return abandoned(attempts, opts)
  }

  emit(opts, attempts, null, null)
  return {
    status: STATUS_UNAVAILABLE,
    body: { ...jsonErrorBody('every engine in this chain failed'), attempts },
    engineUsed: null,
  }
}

/** The client left mid-chain. Advancing would bill the next provider for an answer nobody is waiting for, so the walk stops here and the attempts so far are still recorded. */
function abandoned(attempts: Attempt[], opts: RunChainOptions): ChainResult {
  emit(opts, attempts, null, null)
  return {
    status: STATUS_CLIENT_CLOSED,
    body: { ...jsonErrorBody('client disconnected'), attempts },
    engineUsed: null,
  }
}
