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
  STATUS_UNAVAILABLE,
} from "./http.ts";
import { type Attempt, type CallRecord, recordCall } from "./provenance.ts";
import type { Egress } from "./types.ts";
import { errMessage, withinCeiling } from "./types.ts";

export interface HopResult {
  status: number;
  body?: unknown;
  stream?: ReadableStream;
  /**
   * Set only by an agentic hop whose envelope itself failed (`RunAgenticResult.envelopeFailure`).
   * Neither a 4xx nor an ordinary 5xx: it never advances a chain regardless of
   * `status`, because the failure is proven, not merely a transport error a
   * retry against the next hop might route around.
   */
  envelopeFailure?: boolean;
  /** The router id the answering engine echoed back, when the hop kind can report one. Passed straight to the attempt's `model_reported`. */
  modelReported?: string;
  /** Read per attempt from the answering engine's own `GET /v1/models`, when it can supply one. Passed straight to the attempt's `model_resident`. */
  modelResident?: string;
  /** Set only by an agentic hop, from the version that actually launched. Passed straight to the attempt's `version`; absent for every other hop kind. */
  version?: string;
  /** This hop's resolved upstream id, or `"local"`. Absent for an ambient hop. Passed straight to the attempt's `upstream_used`. */
  upstreamUsed?: string;
}

export type HopExec = (hop: string, signal: AbortSignal) => Promise<HopResult>;

export interface RunChainOptions {
  /** The named chain this hop list came from, or null for a single unqualified hop. */
  chain: string | null;
  /** The model id the caller actually asked for — what provenance calls `requested`. */
  requested: string;
  /** Absent means no ceiling: every hop is attempted regardless of its own egress. */
  maxEgress?: Egress;
  /** Per hop, not per engine — a two-engine hop can each resolve to a different upstream the engine id alone cannot distinguish. Fail-closed `"remote"` when a hop cannot be resolved to a route at all. */
  egressOf: (hop: string) => Egress;
  /**
   * Per hop, not per request or per chain — a two-engine chain bounded per
   * request could run twice as long as intended, and a chain that merely
   * contains an agentic hop somewhere must not force every OTHER hop in it
   * onto the long agentic budget. The caller picks the budget from the hop
   * it is about to attempt.
   */
  timeoutMs: (hop: string) => number;
  /** The client's own signal. Distinct from the per-hop timeout: when this fires there is no one left to answer, so the chain stops instead of advancing and billing the next provider. */
  signal?: AbortSignal;
  exec: HopExec;
  /** Injected so a test can capture the provenance line instead of reading real stdout. */
  write?: (line: string) => void;
}

interface ChainResult {
  status: number;
  body?: unknown;
  stream?: ReadableStream;
  engineUsed: string | null;
}

const HOP_PREFIX = /^@\//;

/**
 * A hop is always the two- or three-segment qualified form: `@/<engine>/<model>`
 * or `@/<engine>/<upstream>/<model>`. Reads exactly three segments -- the
 * third only when present -- rather than joining every segment past the
 * first into `model`, which is how a three-segment hop used to silently
 * become a model id containing a slash.
 */
export function parseHop(hop: string): { engine: string; upstream?: string; model: string } {
  const [engine, second, third] = hop.replace(HOP_PREFIX, "").split("/");
  if (third !== undefined) {
    return { engine: engine ?? hop, upstream: second, model: third };
  }
  return { engine: engine ?? hop, model: second ?? "" };
}

function bodyIsEmpty(body: unknown): boolean {
  return body === undefined || body === "";
}

/**
 * A 4xx naming a problem with THIS hop's own credential -- missing or bad
 * auth, no balance, rate-limited -- is not a problem with the caller's
 * request, and a second engine can plausibly answer where this one could
 * not. The rest of 4xx still terminates: a caller's own malformed request
 * is not something a different upstream can fix either.
 */
const STATUS_UNAUTHORIZED = 401;
const STATUS_PAYMENT_REQUIRED = 402;
const STATUS_TOO_MANY_REQUESTS = 429;
const ADVANCING_CLIENT_ERRORS = new Set([
  STATUS_UNAUTHORIZED,
  STATUS_PAYMENT_REQUIRED,
  STATUS_FORBIDDEN,
  STATUS_TOO_MANY_REQUESTS,
]);

/** The one place status and body decide advance-vs-terminal. 4xx never advances even with an empty body -- except the credential-shaped ones above -- and 5xx and empty body always do, except an envelope failure, which never advances regardless of status. */
export function classifyResult(result: HopResult): {
  advance: boolean;
  ok: boolean;
  failure?: string;
} {
  if (result.envelopeFailure) {
    return { advance: false, ok: false, failure: `http ${result.status}` };
  }
  if (result.status >= HTTP_SERVER_ERROR_MIN && result.status < HTTP_SERVER_ERROR_MAX) {
    return { advance: true, ok: false, failure: `http ${result.status}` };
  }
  if (ADVANCING_CLIENT_ERRORS.has(result.status)) {
    return { advance: true, ok: false, failure: `http ${result.status}` };
  }
  if (result.status >= HTTP_CLIENT_ERROR_MIN && result.status < HTTP_SERVER_ERROR_MIN) {
    return { advance: false, ok: false, failure: `http ${result.status}` };
  }
  if (!result.stream && bodyIsEmpty(result.body)) {
    return { advance: true, ok: false, failure: "empty body" };
  }
  return { advance: false, ok: true };
}

/** Forwards chunks unchanged; a read that throws mid-body reports the failure instead of restarting the prompt elsewhere. `onDone` is handed the byte count actually forwarded, so a caller that classifies by body size sees what the client received rather than nothing at all. */
export function wrapStream<T>(
  source: ReadableStream<T>,
  onDone: (ok: boolean, failure?: string, bytes?: number) => void,
): ReadableStream<T> {
  const reader = source.getReader();
  let forwarded = 0;
  // Whichever terminus arrives first owns the line; `cancel` can still fire
  // after a `pull` has closed the stream.
  let settled = false;
  const settle = (ok: boolean, failure?: string) => {
    if (settled) {
      return;
    }
    settled = true;
    onDone(ok, failure, forwarded);
  };
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          settle(true);
          return;
        }
        forwarded += ArrayBuffer.isView(value) ? value.byteLength : 0;
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        settle(false, errMessage(err));
      }
    },
    cancel(reason) {
      // A disconnect is a terminus like any other. Without this the call that
      // died mid-body is the one call that never appears in provenance --
      // precisely the one worth being able to find later.
      settle(false, "client disconnected");
      reader.cancel(reason).catch(() => undefined);
    },
  });
}

/**
 * Drops every hop whose own egress exceeds the ceiling, wherever it sits in
 * the list -- a hop over the ceiling is a safety property, not a priority
 * hint, so it is never attempted regardless of what comes after it. `null`
 * means nothing in the chain survives the filter at all.
 */
function effectiveHops(hops: string[], opts: RunChainOptions): string[] | null {
  if (opts.maxEgress === undefined) {
    return hops;
  }
  const kept = hops.filter((hop) => withinCeiling(opts.egressOf(hop), opts.maxEgress));
  return kept.length === 0 ? null : kept;
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
  };
  recordCall(record, opts.write);
}

interface HopOutcome {
  attempt: Attempt;
  result?: HopResult;
  advance: boolean;
}

/** One hop's whole attempt: clock started here, not at chain start, so queue wait before it never counts against it. */
async function runOneHop(hop: string, opts: RunChainOptions): Promise<HopOutcome> {
  const { engine, model } = parseHop(hop);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs(hop));
  // The hop dies on whichever comes first: its own budget, or the client leaving.
  const signal = opts.signal
    ? AbortSignal.any([controller.signal, opts.signal])
    : controller.signal;
  const start = Date.now();
  try {
    const result = await opts.exec(hop, signal);
    clearTimeout(timer);
    const outcome = classifyResult(result);
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
      },
      result,
      advance: outcome.advance,
    };
  } catch (err) {
    clearTimeout(timer);
    // Checked before the timeout: a client abort leaves `controller` untouched, so the timeout arm would otherwise claim it.
    let failure = `connection failed: ${errMessage(err)}`;
    if (opts.signal?.aborted) {
      failure = "client disconnected";
    } else if (controller.signal.aborted) {
      failure = "timeout";
    }
    return {
      attempt: { engine, model, ok: false, failure, duration_ms: Date.now() - start },
      advance: true,
    };
  }
}

/** Commits to a hop as the answer. A streaming result defers its provenance line until the stream ends, so a mid-body death still lands as that attempt's failure. */
function finalizeTerminal(
  attempt: Attempt,
  result: HopResult,
  attempts: Attempt[],
  opts: RunChainOptions,
): ChainResult {
  const { engine } = attempt;
  const upstreamUsed = attempt.upstream_used ?? null;
  if (!result.stream) {
    emit(opts, attempts, engine, upstreamUsed);
    return { status: result.status, body: result.body, engineUsed: engine };
  }
  const stream = wrapStream(result.stream, (ok, streamFailure) => {
    if (!ok) {
      attempt.ok = false;
      attempt.failure = streamFailure ?? "stream ended before completion";
    }
    emit(opts, attempts, engine, upstreamUsed);
  });
  return { status: result.status, body: result.body, stream, engineUsed: engine };
}

export async function runChain(hops: string[], opts: RunChainOptions): Promise<ChainResult> {
  const truncated = effectiveHops(hops, opts);
  if (truncated === null) {
    emit(opts, [], null, null);
    return {
      status: STATUS_BAD_REQUEST,
      body: jsonErrorBody(
        `max_egress: "${opts.maxEgress}" leaves no hop in this chain within the ceiling`,
      ),
      engineUsed: null,
    };
  }

  const attempts: Attempt[] = [];
  for (const hop of truncated) {
    if (opts.signal?.aborted) {
      return abandoned(attempts, opts);
    }
    const outcome = await runOneHop(hop, opts);
    attempts.push(outcome.attempt);
    if (outcome.advance) {
      continue;
    }
    return finalizeTerminal(outcome.attempt, outcome.result as HopResult, attempts, opts);
  }

  if (opts.signal?.aborted) {
    return abandoned(attempts, opts);
  }

  emit(opts, attempts, null, null);
  return {
    status: STATUS_UNAVAILABLE,
    body: { ...jsonErrorBody("every engine in this chain failed"), attempts },
    engineUsed: null,
  };
}

/** The client left mid-chain. Advancing would bill the next provider for an answer nobody is waiting for, so the walk stops here and the attempts so far are still recorded. */
function abandoned(attempts: Attempt[], opts: RunChainOptions): ChainResult {
  emit(opts, attempts, null, null);
  return {
    status: STATUS_CLIENT_CLOSED,
    body: { ...jsonErrorBody("client disconnected"), attempts },
    engineUsed: null,
  };
}
