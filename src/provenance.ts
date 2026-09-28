/**
 * One structured line to journald per call, not per attempt. A `systemd
 * --user` service's stdout is journald by default, so writing a JSON line to
 * stdout is the whole mechanism — no log-level framework, no journal binding.
 */

import process from 'node:process'
import type { Egress } from './types.ts'

/**
 * What one attempt cost, exactly as the engine reported it -- never derived,
 * estimated, or converted. The four paid upstreams on this box all bill on
 * tokens and all report them in the OpenAI `usage` shape, so this is a copy
 * of what came back rather than a second accounting engined would have to
 * keep right.
 *
 * Every field is optional because engines differ in which they send: an
 * embeddings reply has no completion half, and llama-server's rerank reports
 * `prompt_tokens` and `total_tokens` and nothing else. A field engined did
 * not receive is absent, never zero -- zero is a number a sum would trust.
 */
export interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /**
   * What the run cost in dollars, where the thing that ran worked it out
   * itself -- the agentic CLIs do, and they are the one kind whose token
   * counts cannot be summed into a price. Never engined's own multiplication
   * of tokens by a rate card: no rate card lives in this repo, and one that
   * did would be wrong the week a provider repriced.
   */
  cost_usd?: number
}

export interface Attempt {
  engine: string
  model: string
  ok: boolean
  failure?: string
  /** Clocked from when this attempt started, never from when the call arrived — queue wait is not an attempt's latency. */
  duration_ms: number
  /** The router id the engine echoed back. Proves the request reached the engine, not which GGUF answered. */
  model_reported?: string
  /** Read per attempt from that engine's `GET /v1/models`. The value that names the GGUF that actually answered. */
  model_resident?: string
  /** The pin that actually launched, for an agentic attempt only. Absent, never an empty string, for every other kind. */
  version?: string
  /** This hop's resolved `[[upstream]]` id, or `"local"`. Absent for an ambient hop, which named no upstream at all. */
  upstream_used?: string
  /** This hop's own egress category (`routeEgress`'s fail-closed `"remote"` when the hop cannot be resolved at all). `src/usage.ts` is the one reader. */
  egress?: Egress
  /** Present only when this agentic call used the web-only research floor. */
  research?: true
  /** What the engine said this attempt cost. Absent whenever it reported nothing -- see `streamed`, and `Usage`. */
  usage?: Usage
  /**
   * This attempt answered with a stream rather than a body. Its `usage`, when
   * present, was read out of the frames themselves; when absent, the upstream
   * stated no cost in them -- for an OpenAI-shaped one that means the caller
   * did not send `stream_options: {include_usage: true}`, which is the only
   * thing that puts a usage frame in the reply.
   *
   * Recorded either way, so a sum over these lines can tell "cost nothing"
   * from "cost unknown" instead of reading a month of streamed chat as zero.
   */
  streamed?: true
}

export interface CallRecord {
  chain: string | null
  requested: string
  attempts: Attempt[]
  engine_used: string | null
  /** The upstream of the attempt that actually answered. `null` alongside `engine_used: null` — nothing answered. */
  upstream_used: string | null
  /**
   * One entry per image `src/visionBridge.ts` sent to a route's
   * `vision_bridge` address, in image order. Never the caption text itself
   * (INVARIANT: no door logs prompt content -- a caption is content too).
   * Absent when the call carried no image, or dispatched to a route with no
   * bridge configured.
   */
  vision_bridge?: Attempt[]
}

/** Exported so everything engined puts on the record shares one writer, rather than growing a second `process.stdout` site per caller. */
export function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`)
}

/**
 * Picks only the known fields, so a caller that spreads a headers object onto
 * an attempt never leaks it into the line. Runtime, not compile-time: a cast
 * to `Attempt` defeats excess-property checking, and provenance is written to
 * journald where a leaked bearer token cannot be recalled.
 */
function serializeAttempt(attempt: Attempt): Attempt {
  return {
    engine: attempt.engine,
    model: attempt.model,
    ok: attempt.ok,
    failure: attempt.failure,
    duration_ms: attempt.duration_ms,
    model_reported: attempt.model_reported,
    model_resident: attempt.model_resident,
    version: attempt.version,
    upstream_used: attempt.upstream_used,
    research: attempt.research,
    usage: attempt.usage,
    streamed: attempt.streamed,
    egress: attempt.egress,
  }
}

/** The caller-visible names for what `answeringHeaders` sets, so a consumer reads one constant rather than a string it has to get byte-for-byte right. */
const HEADER_ROUTE = 'x-engined-route'
const HEADER_UPSTREAM = 'x-engined-upstream'
const HEADER_EGRESS = 'x-engined-egress'
const HEADER_CHAIN = 'x-engined-chain'
/** Only ever set for an agentic hop that reported its own dollar cost -- see `Usage.cost_usd`. Absent, never a fabricated zero, for every other engine. */
const HEADER_COST_USD = 'x-engined-cost-usd'
/**
 * How long this call waited for a llama role/container lease before it ever
 * reached the upstream -- `LlamaHop.queueMs` (`llama.ts`). Set on every
 * llama-routed answer, 0 included: a request that found its role already
 * resident still went through the same lease gate, it just was not held up
 * by it.
 */
const HEADER_QUEUE_MS = 'x-engined-queue-ms'

/**
 * The one place that turns an answering attempt into the headers a caller
 * sees -- built from the same fields `recordCall` already writes, so a
 * header can never claim something the provenance line does not. Every
 * answering site (a chain's terminal hop, or a verb with no chain support at
 * all) funnels through this rather than formatting its own strings.
 *
 * `chain` is set only when the request named one: a caller who addressed a
 * single route directly gets no chain header at all, not an empty one.
 *
 * `costUsd` is absent whenever the answering hop is streaming: an agentic
 * CLI's cost is only known once its process exits, which for a streamed
 * reply is after these headers already went out. That figure reaches the
 * caller in the stream's own final chunk instead -- see `agenticSse`.
 */
export function answeringHeaders(fields: {
  route: string
  upstreamUsed: string | null | undefined
  egress: Egress
  chain: string | null
  costUsd?: number
  queueMs?: number
}): Headers {
  const headers = new Headers({
    [HEADER_ROUTE]: fields.route,
    [HEADER_EGRESS]: fields.egress,
  })
  if (fields.upstreamUsed !== undefined && fields.upstreamUsed !== null) {
    headers.set(HEADER_UPSTREAM, fields.upstreamUsed)
  }
  if (fields.chain !== null) {
    headers.set(HEADER_CHAIN, fields.chain)
  }
  if (fields.costUsd !== undefined) {
    headers.set(HEADER_COST_USD, String(fields.costUsd))
  }
  if (fields.queueMs !== undefined) {
    headers.set(HEADER_QUEUE_MS, String(fields.queueMs))
  }
  return headers
}

export function recordCall(
  record: CallRecord,
  write: (line: string) => void = writeToStdout,
): void {
  write(
    JSON.stringify({
      chain: record.chain,
      requested: record.requested,
      attempts: record.attempts.map(serializeAttempt),
      engine_used: record.engine_used,
      upstream_used: record.upstream_used,
      ...(record.vision_bridge === undefined
        ? {}
        : { vision_bridge: record.vision_bridge.map(serializeAttempt) }),
    }),
  )
}
