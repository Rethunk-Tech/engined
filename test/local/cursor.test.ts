import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  hashTree,
  observeAgentVersion,
  PROBE_ENV_ALLOWLIST,
  plantCursorPromptHook,
  type RunAgenticResult,
  runAgentic,
} from "../../src/agentic.ts";
import { EngineRegistry } from "../../src/engines.ts";
import { stateDir } from "../../src/paths.ts";
import type { Config, EngineEntry } from "../../src/types.ts";

/**
 * A real round trip against the real `agent -p` CLI, resolved on this box's
 * own PATH (agents.ts's `resolveCursorBinary`) and using this box's own
 * logged-in Cursor account -- ambient, the only pairing proven to work (see
 * engines/cursor/spec.toml and src/agents.ts's cursor entry: `CURSOR_API_KEY`
 * is checked against Cursor's own key format client-side before any network
 * attempt, so no upstream redirect can pass it today). `--output-format
 * stream-json`, never `text`: a refused write emits an empty `text` stream,
 * so this suite failing to parse a real answer out of the JSON stream is the
 * regression it exists to catch.
 *
 * cursor's binary self-updates in the background with no version-pinning
 * subcommand -- measured live, twice, mid-delivery, on this very box. Nothing
 * launched here ever selects a specific pin (`buildArgv` skips the pinned-
 * package prefix entirely for an agent with `resolveBinary`); the box's
 * currently-installed binary is whatever runs, always. `ENGINED_TEST_CURSOR_
 * VERSION` records what the operator last observed, not a pin engined can
 * enforce, so the `beforeAll` below checks it against the binary's own
 * `--version` before any real round trip runs, and fails loudly and
 * specifically -- not as a confusing provenance mismatch three assertions
 * deep -- the moment a self-update has made it stale.
 */
const CURSOR_VERSION = process.env.ENGINED_TEST_CURSOR_VERSION;
const BUNX = process.env.ENGINED_BUNX;
const LOCAL = process.env.ENGINED_LOCAL === "1";

/** A real observed round trip through `agent -p` took 3-9s; genuine headroom over that. */
const REAL_ROUND_TRIP_TIMEOUT_MS = 60_000;
/** The probe-gate test below makes two real round trips sequentially. */
const PROBE_GATE_TIMEOUT_MS = 180_000;

function requireEnv(name: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`${name} is unset: this tier runs only under an explicit local invocation`);
  }
  return value;
}
const bunx = (): string => requireEnv("ENGINED_BUNX", BUNX);
const agentVersion = (): string => requireEnv("ENGINED_TEST_CURSOR_VERSION", CURSOR_VERSION);

const MISSING_ENV_VARS = [
  CURSOR_VERSION === undefined ? "ENGINED_TEST_CURSOR_VERSION" : undefined,
  BUNX === undefined ? "ENGINED_BUNX" : undefined,
].filter((name): name is string => name !== undefined);
const AGENTIC_READY = LOCAL && MISSING_ENV_VARS.length === 0;

function describeTitle(base: string): string {
  if (AGENTIC_READY) {
    return base;
  }
  const reason = LOCAL ? `missing ${MISSING_ENV_VARS.join(", ")}` : 'ENGINED_LOCAL is not "1"';
  return `${base}: SKIPPED -- ${reason}`;
}

/**
 * Set once, before any real round trip below runs. `undefined` means the
 * pin is current (or this tier is skipped entirely); any other value is the
 * exact, actionable reason every real-launch test below refuses to run --
 * a self-update the operator's `ENGINED_TEST_CURSOR_VERSION` has not caught
 * up with yet, never a bare assertion failure inside a 60s-timeout test.
 */
let staleVersionReason: string | undefined;

beforeAll(async () => {
  if (!AGENTIC_READY) {
    return;
  }
  const observed = await observeAgentVersion("cursor", agentVersion(), defaultAgenticSpawn);
  if (!observed.ok) {
    staleVersionReason = `cursor's binary could not be observed: ${observed.error}`;
    return;
  }
  if (observed.version !== agentVersion()) {
    staleVersionReason = `ENGINED_TEST_CURSOR_VERSION is "${agentVersion()}", but this box's "agent --version" now reports "${observed.version}" -- cursor self-updated since the pin was set; re-run with ENGINED_TEST_CURSOR_VERSION=${observed.version}`;
  }
});

function assertVersionCurrent(): void {
  if (staleVersionReason !== undefined) {
    throw new Error(staleVersionReason);
  }
}

function scratchWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-cursor-"));
  writeFileSync(join(dir, "seed.txt"), "unrelated pre-existing content\n");
  return dir;
}

/**
 * PATH, unlike claude's own version of this call: cursor's floor is a mode,
 * not a tool allowlist, so its shell tool stays reachable under
 * `--mode plan` -- measured, without PATH a shell command it runs comes
 * back "ls: command not found" (exit 127).
 */
function callAgentic(workdir: string, prompt: string): Promise<RunAgenticResult> {
  assertVersionCurrent();
  return runAgentic({
    agent: "cursor",
    agentVersion: agentVersion(),
    args: {},
    envAllowlist: [...PROBE_ENV_ALLOWLIST, "PATH"],
    workdir,
    prompt,
    spawn: defaultAgenticSpawn,
    bunx: bunx(),
  });
}

describe.skipIf(!AGENTIC_READY)(describeTitle("cursor agentic probes (local)"), () => {
  test(
    "byte-identical: a completion instructed to create a file leaves the worktree untouched",
    async () => {
      const workdir = scratchWorktree();
      const before = hashTree(workdir);

      const result = await callAgentic(
        workdir,
        "Create a file named proof.txt in the current directory containing the text 'hello'. Do nothing else.",
      );

      const after = hashTree(workdir);
      rmSync(workdir, { recursive: true, force: true });

      expect(result.status).toBe(200);
      expect(after).toBe(before);
    },
    REAL_ROUND_TRIP_TIMEOUT_MS,
  );

  test(
    "no hook fires: a planted beforeSubmitPrompt hook never appends to its witness file",
    async () => {
      const workdir = scratchWorktree();
      const witness = join(tmpdir(), `engined-cursor-witness-${Date.now()}.txt`);
      rmSync(witness, { force: true });
      plantCursorPromptHook(workdir, witness);

      const result = await callAgentic(workdir, "Say hello in one short sentence.");

      const witnessExists = existsSync(witness);
      rmSync(workdir, { recursive: true, force: true });
      rmSync(witness, { force: true });

      expect(result.status).toBe(200);
      expect(witnessExists).toBe(false);
    },
    REAL_ROUND_TRIP_TIMEOUT_MS,
  );
});

describe.skipIf(!AGENTIC_READY)(describeTitle("cursor agentic provenance (local)"), () => {
  test(
    "provenance: the result's version is the pin that was actually launched, and the answer is real text out of the stream-json envelope",
    async () => {
      const workdir = scratchWorktree();
      const result = await callAgentic(workdir, "Reply with exactly the word: pong");
      rmSync(workdir, { recursive: true, force: true });

      expect(result.status).toBe(200);
      // Honest by construction, not by luck: `beforeAll` above already
      // proved CURSOR_VERSION matches what "agent --version" reports on
      // this box, so this equality is a real claim about what ran, not a
      // tautological echo of an unverified env var.
      expect(result.version).toBe(CURSOR_VERSION);
      expect(result.result?.toLowerCase()).toContain("pong");
    },
    REAL_ROUND_TRIP_TIMEOUT_MS,
  );
});

/**
 * Mirrors `test/local/agentic.test.ts`'s own probe-gate test for claude:
 * proves `EngineRegistry.start` withholds service with no probe runner
 * configured and grants it once cursor's real probes -- run unattended by
 * the registry, not called directly -- pass. A dedicated engine id under
 * `spec_dir` (reusing the real shipped `engines/cursor` spec) keeps this off
 * the live unit's own `verified_version` file.
 */
const PROBE_GATE_ENGINE_ID = "engined-local-test-cursor-probe-gate";
const PROBE_GATE_ENGINES_ROOT = join(import.meta.dir, "..", "..", "engines");
const PROBE_GATE_VERIFIED_DIR = join(stateDir(), "agentic", PROBE_GATE_ENGINE_ID);

function buildProbeGateConfig(): Config {
  const engine: EngineEntry = {
    id: PROBE_GATE_ENGINE_ID,
    agent_version: agentVersion(),
    spec_dir: join(PROBE_GATE_ENGINES_ROOT, "cursor"),
    args: {},
  };
  return {
    listen_port: 0,
    chat_timeout_seconds: 600,
    agent_timeout_seconds: 3600,
    engines: [engine],
    models: [],
    upstreams: [],
    routes: [],
    chains: {},
  };
}

describe.skipIf(!AGENTIC_READY)(
  describeTitle("cursor agentic probes gate serving via the real registry (local)"),
  () => {
    afterAll(() => {
      rmSync(PROBE_GATE_VERIFIED_DIR, { recursive: true, force: true });
    });

    test(
      "unavailable with no probe runner configured; installed once the real probes run and pass",
      async () => {
        assertVersionCurrent();
        rmSync(PROBE_GATE_VERIFIED_DIR, { recursive: true, force: true });

        const gated = new EngineRegistry(buildProbeGateConfig(), {
          enginesRoot: PROBE_GATE_ENGINES_ROOT,
          bunx: bunx(),
        });
        const beforeStatus = (await gated.list()).engines.find(
          (e) => e.id === PROBE_GATE_ENGINE_ID,
        );
        expect(beforeStatus?.state).toBe("unavailable");
        expect(beforeStatus?.fix).toContain("no agentic probe runner is configured");

        const proven = new EngineRegistry(buildProbeGateConfig(), {
          enginesRoot: PROBE_GATE_ENGINES_ROOT,
          bunx: bunx(),
          agenticProbeRunner: buildAgenticProbeRunner(bunx()),
        });
        const afterStatus = await proven.start(PROBE_GATE_ENGINE_ID);
        expect(afterStatus.state).toBe("installed");

        // `writeVerifiedVersion` (engines.ts) persists the OBSERVED version,
        // never the configured one on its own -- these are proved equal by
        // the same `beforeAll` precondition the provenance test above relies
        // on, not by this gate's own construction.
        const recorded = readFileSync(
          join(PROBE_GATE_VERIFIED_DIR, "verified_version"),
          "utf8",
        ).trim();
        expect(recorded).toBe(agentVersion());
      },
      PROBE_GATE_TIMEOUT_MS,
    );
  },
);
