/**
 * Fixtures shared across this tier. The CI tier's own builders live in
 * `src/test-support.ts` and are imported from here and from the suites
 * directly; only what is specific to running against the real box -- real
 * scratch worktrees, real env-var gating, the real state dir -- is here.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import type { RunAgenticResult } from "../../src/agentic.ts";
import { buildAgenticProbeRunner, hashTree, WORKTREE_SEED } from "../../src/agenticProbeHarness.ts";
import { loadConfig } from "../../src/config.ts";
import { EngineRegistry } from "../../src/engines.ts";
import { stateDir } from "../../src/paths.ts";
import { clearVerifiedVersion, config } from "../../src/test-support.ts";
import { type Config, errMessage, type ResolvedRoute } from "../../src/types.ts";
import { CONFIG_EXAMPLE, ENGINES_ROOT, LOCAL } from "./exclusive.ts";

/** Seeds `dir`, creating it if absent, and hands it back so a caller can name it inline. */
export function seedWorktree(dir: string): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.txt"), WORKTREE_SEED);
  return dir;
}

/** Always a fresh directory under the OS temp directory -- never a real repository this box happens to have checked out. */
export function scratchWorktree(prefix: string): string {
  return seedWorktree(mkdtempSync(join(tmpdir(), prefix)));
}

/** Which of the named env vars are unset, in declaration order. */
function missingEnv(vars: Record<string, string | undefined>): string[] {
  return Object.entries(vars)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
}

/** Names in the describe title exactly why a suite did not run, rather than a green suite that ran nothing. */
export function skipTitle(base: string, ready: boolean, reason: string): string {
  return ready ? base : `${base}: SKIPPED -- ${reason}`;
}

/** The whole tier's gate, as the reason a suite names when it is unset. */
const NOT_LOCAL_REASON = 'ENGINED_LOCAL is not "1"';

/** Why an env-gated suite cannot run: the tier's own gate first, since an unset `ENGINED_LOCAL` leaves every other var unset too. */
function missingEnvReason(missing: string[]): string {
  return LOCAL ? `missing ${missing.join(", ")}` : NOT_LOCAL_REASON;
}

/**
 * This tier's one config read: the operator's own real `config.example.toml`
 * against the repo's real `engines/`, so a clean parse is also live proof the
 * example still matches this box.
 *
 * Never throws. `loadConfig` validates the whole file, so an unrelated
 * engine's absent weights fail a suite that never speaks to it; every caller
 * here degrades to a named skip instead, and `error` is what names it.
 */
export function loadLocalConfig(): { config?: Config; error?: string } {
  if (!LOCAL) {
    return { error: NOT_LOCAL_REASON };
  }
  try {
    return { config: loadConfig(CONFIG_EXAMPLE, ENGINES_ROOT) };
  } catch (err) {
    return { error: errMessage(err) };
  }
}

/** A route that really names a model, so every caller reads `.model` as a plain string rather than `string | undefined`. */
export type ChatRoute = ResolvedRoute & { model: string };

/** The one local chat route this box's llama serves -- the model every suite here makes resident. */
export function isChatRoute(route: ResolvedRoute): route is ChatRoute {
  return (
    route.engine === "llama" &&
    route.upstream === "local" &&
    route.role === "chat" &&
    route.model !== undefined
  );
}

/**
 * Called only from inside a test body: a suite is skipped when any var it
 * needs is unset, so reaching the throw means that gate is broken, not that
 * the environment is.
 */
function requireEnv(name: string, value: string | undefined): string {
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
function probeGateConfig(id: string, agent: string, agentVersion: string): Config {
  return config({
    listen_port: 0,
    engines: [{ id, agent_version: agentVersion, spec_dir: join(ENGINES_ROOT, agent), args: {} }],
  });
}

/** The one file the gate writes; `clearVerifiedVersion` (src/test-support.ts) removes the directory holding it. */
function verifiedVersionPath(id: string): string {
  return join(stateDir(), "agentic", id, "verified_version");
}

/**
 * The env every agentic suite in this tier gates on: the tier's own
 * `ENGINED_BUNX` and the one var recording the agent version the operator
 * last observed. `version` is the raw value, for the provenance assertion
 * that compares it against what actually launched; the two accessors are
 * what a test body calls, and throw only if the gate above them is broken.
 */
export function agentEnv(versionVar: string): {
  version: string | undefined;
  bunx: () => string;
  agentVersion: () => string;
  ready: boolean;
  skipReason: string;
} {
  const version = process.env[versionVar];
  const bunxPath = process.env.ENGINED_BUNX;
  const missing = missingEnv({ [versionVar]: version, ENGINED_BUNX: bunxPath });
  return {
    version,
    bunx: () => requireEnv("ENGINED_BUNX", bunxPath),
    agentVersion: () => requireEnv(versionVar, version),
    ready: LOCAL && missing.length === 0,
    skipReason: missingEnvReason(missing),
  };
}

/**
 * The integrity floor every agentic agent owes, identical across agents
 * because the guarantee is: a completion told to write leaves the worktree
 * byte-identical, and a prompt hook planted in that worktree never fires.
 * `hookName` is the agent's own name for that hook, `plantHook` the planter
 * that writes it.
 */
export function agenticIntegrityTests(o: {
  title: string;
  ready: boolean;
  skipReason: string;
  prefix: string;
  hookName: string;
  plantHook: (workdir: string, witness: string) => void;
  call: (workdir: string, prompt: string) => Promise<RunAgenticResult>;
  timeoutMs: number;
}): void {
  describe.skipIf(!o.ready)(skipTitle(o.title, o.ready, o.skipReason), () => {
    test(
      "byte-identical: a completion instructed to create a file leaves the worktree untouched",
      async () => {
        const workdir = scratchWorktree(o.prefix);
        const before = hashTree(workdir);

        const result = await o.call(
          workdir,
          "Create a file named proof.txt in the current directory containing the text 'hello'. Do nothing else.",
        );

        const after = hashTree(workdir);
        rmSync(workdir, { recursive: true, force: true });

        expect(result.status).toBe(200);
        expect(after).toBe(before);
      },
      o.timeoutMs,
    );

    test(
      `no hook fires: a planted ${o.hookName} hook never appends to its witness file`,
      async () => {
        const workdir = scratchWorktree(o.prefix);
        const witness = join(tmpdir(), `${o.prefix}witness-${Date.now()}.txt`);
        rmSync(witness, { force: true });
        o.plantHook(workdir, witness);

        const result = await o.call(workdir, "Say hello in one short sentence.");

        const witnessExists = existsSync(witness);
        rmSync(workdir, { recursive: true, force: true });
        rmSync(witness, { force: true });

        expect(result.status).toBe(200);
        expect(witnessExists).toBe(false);
      },
      o.timeoutMs,
    );
  });
}

/**
 * `runAgentic`'s own tests prove the probes work; this proves the gate they
 * exist to build -- `EngineRegistry`'s `agenticStatus` -- withholds service
 * without them and grants it once they pass, run unattended by the registry
 * itself rather than called directly. `precondition` is whatever the agent
 * must re-check before spending a real round trip.
 */
export function agenticProbeGateTest(o: {
  title: string;
  ready: boolean;
  skipReason: string;
  engineId: string;
  agent: string;
  bunx: () => string;
  agentVersion: () => string;
  timeoutMs: number;
  precondition?: () => void;
}): void {
  const gateConfig = (): Config => probeGateConfig(o.engineId, o.agent, o.agentVersion());

  describe.skipIf(!o.ready)(skipTitle(o.title, o.ready, o.skipReason), () => {
    afterAll(() => {
      clearVerifiedVersion(o.engineId);
    });

    test(
      "unavailable with no probe runner configured; installed once the real probes run and pass",
      async () => {
        o.precondition?.();
        clearVerifiedVersion(o.engineId);

        // No agenticProbeRunner: costs no real call, and proves the engine
        // does not serve on faith even with a syntactically valid pin.
        const gated = new EngineRegistry(gateConfig(), {
          enginesRoot: ENGINES_ROOT,
          bunx: o.bunx(),
        });
        const beforeStatus = (await gated.list()).engines.find((e) => e.id === o.engineId);
        expect(beforeStatus?.state).toBe("unavailable");
        expect(beforeStatus?.fix).toContain("no agentic probe runner is configured");

        // The real runner: two real round trips, billed wherever the agent's
        // own account is, run unattended by start() itself.
        const proven = new EngineRegistry(gateConfig(), {
          enginesRoot: ENGINES_ROOT,
          bunx: o.bunx(),
          agenticProbeRunner: buildAgenticProbeRunner(o.bunx()),
        });
        const afterStatus = await proven.start(o.engineId);
        expect(afterStatus.state).toBe("installed");

        // `writeVerifiedVersion` (engines.ts) persists the OBSERVED version,
        // never the configured one on its own, so this equality is a claim
        // about what really launched -- honest because each agent's pin is
        // already tied to the binary: claude's is enforced at launch, and
        // cursor's is checked against `agent --version` before any round trip.
        const recorded = readFileSync(verifiedVersionPath(o.engineId), "utf8").trim();
        expect(recorded).toBe(o.agentVersion());
      },
      o.timeoutMs,
    );
  });
}
