/**
 * The half every remote engine shares: an address, and a keyring secret
 * projected into exactly one header. Nothing is launched, nothing is
 * resident, and no occupancy applies — which is why this sits beside the
 * lifecycle rather than inside it.
 *
 * Lifted out of `main.ts`'s `resolveRedirect` rather than copied. The
 * agentic redirect and the HTTP proxies resolve the same secret under the
 * same never-cached rule, and two copies of that rule drift the first time
 * one of them learns something about the keyring the other does not.
 *
 * The resolved value reaches a request header, or — for the agentic
 * redirect, which hands it to a child process rather than sending it itself
 * — the raw string from `resolveRemoteSecret`. It never reaches a log line
 * or an error body from anywhere in here.
 */

import { resolveSecret, type Exec as SecretExec } from "./secrets.ts";
import type { EngineEntry } from "./types.ts";

/** Where a remote engine actually is, and what proves we may talk to it. */
export interface RemoteEndpoint {
  /** The configured `base_url`, verbatim — engined writes no port for anything but this. */
  base_url: string;
  /** `{ [secret.header]: <resolved value> }`. One header, named by config. */
  headers: Record<string, string>;
  /**
   * The engine's `[engine.args]`, which for a remote engine are wire
   * parameters rather than process flags — there is no process. Each remote
   * dialect reads the keys it needs and ignores the rest.
   */
  args: Record<string, unknown>;
}

export type RemoteResolution =
  | { ok: true; endpoint: RemoteEndpoint }
  | { ok: false; status: number; error: string };

/**
 * The raw secret, for the one caller that needs the value itself rather than
 * a header: the agentic redirect hands it to a child process as
 * `ANTHROPIC_API_KEY`. Everything else takes `resolveRemote` and never sees
 * it.
 */
export type SecretResolution =
  | { ok: true; value: string }
  | { ok: false; status: number; error: string };

/**
 * A 502: the engine is misconfigured, and no amount of waiting fixes it.
 * Distinct from the 503 a locked or missing keyring entry earns, which
 * resolves itself the moment the operator signs in.
 */
const STATUS_MISCONFIGURED = 502;
const STATUS_UNAVAILABLE = 503;

const TRAILING_SLASHES = /\/+$/;
const LEADING_SLASHES = /^\/+/;
/** Anchored on the segment boundary so `/v1beta/...` is left alone. */
const DOOR_VERSION_PREFIX = /^\/v1(?=\/)/;

/** `base_url` is the whole test: an engine that has one launches nothing. */
export function isRemote(engine: EngineEntry): boolean {
  return engine.base_url !== undefined;
}

/**
 * Resolved per request, never cached — a `--user` unit boots before the login
 * keyring unlocks, and every remote engine must recover at the operator's
 * next sign-in without a reload.
 */
export async function resolveRemoteSecret(
  engine: EngineEntry,
  secretExec?: SecretExec,
): Promise<SecretResolution> {
  if (!engine.secret) {
    return {
      ok: false,
      status: STATUS_MISCONFIGURED,
      error: `engine "${engine.id}" is a remote address with no configured secret`,
    };
  }
  const outcome = await resolveSecret(engine.secret, secretExec);
  return outcome.ok
    ? { ok: true, value: outcome.value }
    : { ok: false, status: STATUS_UNAVAILABLE, error: outcome.fix };
}

/** The address and the one header, for every remote caller that speaks HTTP itself. */
export async function resolveRemote(
  engine: EngineEntry,
  secretExec?: SecretExec,
): Promise<RemoteResolution> {
  if (engine.base_url === undefined || engine.secret === undefined) {
    return {
      ok: false,
      status: STATUS_MISCONFIGURED,
      error: `engine "${engine.id}" is a remote address with no configured secret`,
    };
  }
  const resolved = await resolveRemoteSecret(engine, secretExec);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    endpoint: {
      base_url: engine.base_url,
      headers: { [engine.secret.header]: resolved.value },
      args: engine.args,
    },
  };
}

/**
 * Joins a door path onto a configured base URL without either half having to
 * know how the other was punctuated. `new URL("/v1/x", base)` would discard
 * the base's own path — which is exactly what a consumer wants against
 * llama.cpp and exactly wrong here, where `https://api.elevenlabs.io/v1` and
 * `https://api.kimi.com/coding/` both carry a path that has to survive.
 */
export function remoteUrl(base: string, path: string): string {
  return `${base.replace(TRAILING_SLASHES, "")}/${path.replace(LEADING_SLASHES, "")}`;
}

/**
 * The door's `/v1` is engined's, not the upstream's. Every provider
 * documents a `base_url` that already carries its own version segment —
 * `https://api.openai.com/v1`, `https://api.elevenlabs.io/v1` — so joining
 * the door's path verbatim produces `/v1/v1/chat/completions` and a 404 that
 * reads like a wrong address rather than a doubled prefix.
 *
 * Stripping here rather than asking operators to write a `base_url` without
 * its version: a config that disagreed with every provider's own
 * documentation is the kind that gets copied wrong once and debugged twice.
 */
export function upstreamPath(doorPath: string): string {
  return doorPath.replace(DOOR_VERSION_PREFIX, "");
}
