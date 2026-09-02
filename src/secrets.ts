/**
 * Resolves a `SecretRef` against the desktop keyring at request time. Never
 * cached across requests: a `--user` unit boots before the login keyring is
 * unlocked by PAM, so a cached failure would need a reload to clear once the
 * operator signs in. Always `secret-tool lookup`, never `search` — `search`
 * printed a live key to stdout during this design.
 */
import { binExec, type Exec } from "./exec.ts";

import type { SecretRef } from "./types.ts";

type SecretOutcome =
  | { ok: true; value: string }
  | { ok: false; reason: "missing"; fix: string }
  | { ok: false; reason: "locked"; fix: string };

export const secretExec: Exec = binExec("secret-tool");

function storeFix(ref: SecretRef): string {
  return `secret-tool store --label='${ref.service}' service ${ref.service} username ${ref.username}`;
}

const LOCKED_FIX = "keyring is locked; resolves automatically once the operator signs in";

export async function resolveSecret(
  ref: SecretRef,
  exec: Exec = secretExec,
): Promise<SecretOutcome> {
  const result = await exec(["lookup", "service", ref.service, "username", ref.username]);
  const value = result.stdout.trim();
  if (result.exitCode === 0 && value.length > 0) {
    return { ok: true, value };
  }
  /**
   * `secret-tool` prints nothing on either stream for a clean "no such item".
   * Any real service or unlock-prompt failure lands a message on stderr, so
   * a non-empty stderr is the locked/unavailable signal and an empty one is
   * a genuinely missing entry. Recorded from `secret-tool lookup` against a
   * nonexistent entry (exit 1, empty stdout, empty stderr) versus against an
   * unreachable Secret Service (exit 1, empty stdout, `secret-tool: Could not
   * connect: …` on stderr).
   */
  if (result.stderr.trim().length > 0) {
    return { ok: false, reason: "locked", fix: LOCKED_FIX };
  }
  return { ok: false, reason: "missing", fix: storeFix(ref) };
}
