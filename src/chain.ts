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
  STATUS_UNAVAILABLE,
} from "./http.ts";
import { type Attempt, type CallRecord, recordCall } from "./provenance.ts";
import type { Egress } from "./types.ts";
import { errMessage } from "./types.ts";

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
}

export type HopExec = (hop: string, signal: AbortSignal) => Promise<HopResult>;

export interface RunChainOptions {
  /** The named chain this hop list came from, or null for a single unqualified hop. */
  chain: string | null;
  /** The model id the caller actually asked for — what provenance calls `requested`. */
  requested: string;
  localOnly: boolean;
  /** The only input `local_only` reads. */
  egressOf: (engine: string) => Egress;
  /** Resolves a hop's raw `@/<segment>/…` engine to the id `GET /v1/engines` reports (e.g. the `local` alias), falling back to the segment unchanged. Provenance must record the resolved id, never the alias, to stay reconcilable. */
  resolveEngine: (engine: string) => string;
  /**
   * Per hop, not per request or per chain — a two-engine chain bounded per
   * request could run twice as long as intended, and a chain that merely
   * contains an agentic hop somewhere must not force every OTHER hop in it
   * onto the long agentic budget. The caller picks the budget from the hop
   * it is about to attempt.
   */
  timeoutMs: (hop: string) => number;
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

export function parseHop(hop: string): { engine: string; model: string } {
  const [engine, ...rest] = hop.replace(HOP_PREFIX, "").split("/");
  return { engine: engine ?? hop, model: rest.join("/") };
}

function bodyIsEmpty(body: unknown): boolean {
  return body === undefined || body === "";
}

/** The one place status and body decide advance-vs-terminal. 4xx never advances even with an empty body; 5xx and empty body always do — except an envelope failure, which never advances regardless of status. */
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
  if (result.status >= HTTP_CLIENT_ERROR_MIN && result.status < HTTP_SERVER_ERROR_MIN) {
    return { advance: false, ok: false, failure: `http ${result.status}` };
  }
  if (!result.stream && bodyIsEmpty(result.body)) {
    return { advance: true, ok: false, failure: "empty body" };
  }
  return { advance: false, ok: true };
}

/** Forwards chunks unchanged; a read that throws mid-body reports the failure instead of restarting the prompt elsewhere. */
function wrapStream(
  source: ReadableStream,
  onDone: (ok: boolean, failure?: string) => void,
): ReadableStream {
  const reader = source.getReader();
  // Whichever terminus arrives first owns the line; `cancel` can still fire
  // after a `pull` has closed the stream.
  let settled = false;
  const settle = (ok: boolean, failure?: string) => {
    if (settled) {
      return;
    }
    settled = true;
    onDone(ok, failure);
  };
  return new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          settle(true);
          return;
        }
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

/** Truncates after the last local hop. A chain holding *a* local hop is not a local chain — everything past that point is never attempted. */
function effectiveHops(hops: string[], opts: RunChainOptions): string[] | null {
  if (!opts.localOnly) {
    return hops;
  }
  let lastLocal = -1;
  for (const [i, hop] of hops.entries()) {
    if (opts.egressOf(parseHop(hop).engine) === "none") {
      lastLocal = i;
    }
  }
  return lastLocal === -1 ? null : hops.slice(0, lastLocal + 1);
}

function emit(opts: RunChainOptions, attempts: Attempt[], engineUsed: string | null): void {
  const record: CallRecord = {
    chain: opts.chain,
    requested: opts.requested,
    attempts,
    engine_used: engineUsed,
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
  const { engine: rawEngine, model } = parseHop(hop);
  const engine = opts.resolveEngine(rawEngine);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs(hop));
  const start = Date.now();
  try {
    const result = await opts.exec(hop, controller.signal);
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
      },
      result,
      advance: outcome.advance,
    };
  } catch (err) {
    clearTimeout(timer);
    const failure = controller.signal.aborted ? "timeout" : `connection failed: ${errMessage(err)}`;
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
  if (!result.stream) {
    emit(opts, attempts, engine);
    return { status: result.status, body: result.body, engineUsed: engine };
  }
  const stream = wrapStream(result.stream, (ok, streamFailure) => {
    if (!ok) {
      attempt.ok = false;
      attempt.failure = streamFailure ?? "stream ended before completion";
    }
    emit(opts, attempts, engine);
  });
  return { status: result.status, body: result.body, stream, engineUsed: engine };
}

export async function runChain(hops: string[], opts: RunChainOptions): Promise<ChainResult> {
  const truncated = effectiveHops(hops, opts);
  if (truncated === null) {
    emit(opts, [], null);
    return {
      status: STATUS_BAD_REQUEST,
      body: jsonErrorBody("local_only: true but no hop in this chain is local"),
      engineUsed: null,
    };
  }

  const attempts: Attempt[] = [];
  for (const hop of truncated) {
    const outcome = await runOneHop(hop, opts);
    attempts.push(outcome.attempt);
    if (outcome.advance) {
      continue;
    }
    return finalizeTerminal(outcome.attempt, outcome.result as HopResult, attempts, opts);
  }

  emit(opts, attempts, null);
  return {
    status: STATUS_UNAVAILABLE,
    body: { ...jsonErrorBody("every engine in this chain failed"), attempts },
    engineUsed: null,
  };
}
