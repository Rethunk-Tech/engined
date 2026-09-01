/**
 * The half every remote-addressed engine shares: an address, and a keyring
 * secret projected into exactly one header. Nothing is launched, nothing is
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
 * — the raw string from `resolveUpstreamSecret`. It never reaches a log line
 * or an error body from anywhere in here.
 */

import type { Exec as SecretExec } from "./exec.ts";
import { STATUS_BAD_GATEWAY, STATUS_UNAVAILABLE } from "./http.ts";
import { resolveSecret } from "./secrets.ts";
import type { EngineEntry } from "./types.ts";

/** Where an upstream actually is, and what proves we may talk to it. */
export interface UpstreamEndpoint {
  /** The configured `base_url`, verbatim — engined writes no port for anything but this. */
  base_url: string;
  /** `{ [secret.header]: <resolved value> }`. One header, named by config. */
  headers: Record<string, string>;
  /**
   * The engine's `[engine.args]`, which for an upstream-addressed engine are
   * wire parameters rather than process flags — there is no process. Each
   * dialect reads the keys it needs and ignores the rest.
   */
  args: Record<string, unknown>;
}

type UpstreamResolution =
  | { ok: true; endpoint: UpstreamEndpoint }
  | { ok: false; status: number; error: string };

/** `header` rides along so a caller never has to reach back into `engine.secret` the resolver already validated. */
type SecretResolution =
  | { ok: true; value: string; header: string }
  | { ok: false; status: number; error: string };

const TRAILING_SLASHES = /\/+$/;
const LEADING_SLASHES = /^\/+/;
/** Anchored on the segment boundary so `/v1beta/...` is left alone. */
const DOOR_VERSION_PREFIX = /^\/openai\/v1(?=\/)/;

/** `base_url` is the whole test: an engine that has one launches nothing. */
export function isRemote(engine: EngineEntry): boolean {
  return engine.base_url !== undefined;
}

/** One wording for the missing-secret refusal, shared by the resolver and by `GET /v1/engines`'s `fix`. */
export function noSecretConfiguredFix(engineId: string): string {
  return `engine "${engineId}" has no configured secret`;
}

/**
 * The raw secret, for the one caller that needs the value itself rather than
 * a header: the agentic redirect hands it to a child process as an
 * environment variable. Everything else takes `resolveUpstream` and never
 * sees it.
 *
 * Resolved per request, never cached — a `--user` unit boots before the login
 * keyring unlocks, and every upstream-addressed engine must recover at the
 * operator's next sign-in without a reload.
 */
export async function resolveUpstreamSecret(
  engine: EngineEntry,
  secretExec?: SecretExec,
): Promise<SecretResolution> {
  if (!engine.secret) {
    return {
      ok: false,
      // 502, not 503: a missing configured secret is misconfiguration, and
      // no amount of waiting fixes it, unlike the 503 a locked or missing
      // keyring entry earns below, which resolves at the operator's next
      // sign-in.
      status: STATUS_BAD_GATEWAY,
      error: noSecretConfiguredFix(engine.id),
    };
  }
  const outcome = await resolveSecret(engine.secret, secretExec);
  return outcome.ok
    ? { ok: true, value: outcome.value, header: engine.secret.header }
    : { ok: false, status: STATUS_UNAVAILABLE, error: outcome.fix };
}

/** One wording for the missing-address refusal, shared by every caller that has to have one. */
export function noBaseUrlFix(engineId: string): string {
  return `engine "${engineId}" has no configured base_url`;
}

/** The address and the one header, for every caller that speaks HTTP straight to an upstream. */
export async function resolveUpstream(
  engine: EngineEntry,
  secretExec?: SecretExec,
): Promise<UpstreamResolution> {
  if (engine.base_url === undefined) {
    // 502, not 503: misconfiguration, which no amount of waiting fixes.
    return { ok: false, status: STATUS_BAD_GATEWAY, error: noBaseUrlFix(engine.id) };
  }
  const resolved = await resolveUpstreamSecret(engine, secretExec);
  if (!resolved.ok) {
    return resolved;
  }
  return {
    ok: true,
    endpoint: {
      base_url: engine.base_url,
      headers: { [resolved.header]: resolved.value },
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
export function upstreamUrl(base: string, path: string): string {
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
