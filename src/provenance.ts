/**
 * One structured line to journald per call, not per attempt. A `systemd
 * --user` service's stdout is journald by default, so writing a JSON line to
 * stdout is the whole mechanism — no log-level framework, no journal binding.
 */

import process from "node:process";

export interface Attempt {
  engine: string;
  model: string;
  ok: boolean;
  failure?: string;
  /** Clocked from when this attempt started, never from when the call arrived — queue wait is not an attempt's latency. */
  duration_ms: number;
  /** The router id the engine echoed back. Proves the request reached the engine, not which GGUF answered. */
  model_reported?: string;
  /** Read per attempt from that engine's `GET /v1/models`. The value that names the GGUF that actually answered. */
  model_resident?: string;
  /** The pin that actually launched, for an agentic attempt only. Absent, never an empty string, for every other kind. */
  version?: string;
  /** This hop's resolved `[[upstream]]` id, or `"local"`. Absent for an ambient hop, which named no upstream at all. */
  upstream_used?: string;
}

export interface CallRecord {
  chain: string | null;
  requested: string;
  attempts: Attempt[];
  engine_used: string | null;
  /** The upstream of the attempt that actually answered. `null` alongside `engine_used: null` — nothing answered. */
  upstream_used: string | null;
}

/** Exported so everything engined puts on the record shares one writer, rather than growing a second `process.stdout` site per caller. */
export function writeToStdout(line: string): void {
  process.stdout.write(`${line}\n`);
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
  };
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
    }),
  );
}
