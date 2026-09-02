/**
 * Fixtures shared across this tier. The CI tier's own builders live in
 * `src/test-support.ts` and are imported from here and from the suites
 * directly; only what is specific to running against the real box -- real
 * scratch worktrees, real env-var gating, the real state dir -- is here.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateDir } from "../../src/paths.ts";
import { config } from "../../src/test-support.ts";
import type { Config } from "../../src/types.ts";
import { ENGINES_ROOT, LOCAL } from "./exclusive.ts";

/** Content nothing under test writes, so an unchanged tree hash means the agent touched nothing. */
const SEED = "unrelated pre-existing content\n";

/** Seeds `dir`, creating it if absent, and hands it back so a caller can name it inline. */
export function seedWorktree(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.txt"), SEED);
  return dir;
}

/** Always a fresh directory under the OS temp directory -- never a real repository this box happens to have checked out. */
export function scratchWorktree(prefix: string): string {
  return seedWorktree(mkdtempSync(join(tmpdir(), prefix)));
}

/** Which of the named env vars are unset, in declaration order. */
export function missingEnv(vars: Record<string, string | undefined>): string[] {
  return Object.entries(vars)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
}

/** Names in the describe title exactly why a suite did not run, rather than a green suite that ran nothing. */
export function skipTitle(base: string, ready: boolean, reason: string): string {
  return ready ? base : `${base}: SKIPPED -- ${reason}`;
}

/** Why an env-gated suite cannot run: the tier's own gate first, since an unset `ENGINED_LOCAL` leaves every other var unset too. */
export function missingEnvReason(missing: string[]): string {
  return LOCAL ? `missing ${missing.join(", ")}` : 'ENGINED_LOCAL is not "1"';
}

/**
 * Called only from inside a test body: a suite is skipped when any var it
 * needs is unset, so reaching the throw means that gate is broken, not that
 * the environment is.
 */
export function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`${name} is unset: this tier runs only under \`bun run test:local\``);
  }
  return value;
}

/**
 * The engine each agentic suite proves through the real registry. A dedicated
 * `id` pointed at the agent's real shipped spec via `spec_dir` keeps the proof
 * off the `verified_version` files the live unit's own registry tracks.
 */
export function probeGateConfig(id: string, agent: string, agentVersion: string): Config {
  return config({
    listen_port: 0,
    engines: [{ id, agent_version: agentVersion, spec_dir: join(ENGINES_ROOT, agent), args: {} }],
  });
}

/** The one file the gate writes; `clearVerifiedVersion` (src/test-support.ts) removes the directory holding it. */
export function verifiedVersionPath(id: string): string {
  return join(stateDir(), "agentic", id, "verified_version");
}
