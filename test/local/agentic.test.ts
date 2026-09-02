import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  hashTree,
  PROBE_ENV_ALLOWLIST,
  plantUserPromptSubmitHook,
  type RunAgenticResult,
  runAgentic,
} from "../../src/agentic.ts";
import { EngineRegistry } from "../../src/engines.ts";
import { clearVerifiedVersion } from "../../src/test-support.ts";
import type { Config } from "../../src/types.ts";
import { ENGINES_ROOT, LOCAL } from "./exclusive.ts";
import {
  missingEnv,
  probeGateConfig,
  requireEnv,
  scratchWorktree,
  skipTitle,
  verifiedVersionPath,
} from "./fixtures.ts";

/**
 * A real round trip against the real `claude` CLI through `bunx`, costing an
 * actual call to Anthropic. Both probes are what `verified_version` bumping
 * runs before an agentic engine serves a version engined has not proved yet,
 * so they are exercised here as the same executable code, not a checklist.
 */
const CLAUDE_VERSION = process.env.ENGINED_TEST_CLAUDE_VERSION;
// Set by the `test:local` script, alongside ENGINED_LOCAL that gates this tier.
const BUNX = process.env.ENGINED_BUNX;

/** A real observed round trip through `bunx claude -p` took ~6s; 60s is genuine headroom over that, not a number picked to match bun's 5s default. */
const REAL_ROUND_TRIP_TIMEOUT_MS = 60_000;
/** The probe-gate test below makes two real round trips sequentially. */
const PROBE_GATE_TIMEOUT_MS = 180_000;

const bunx = (): string => requireEnv("ENGINED_BUNX", BUNX);
const agentVersion = (): string => requireEnv("ENGINED_TEST_CLAUDE_VERSION", CLAUDE_VERSION);

const MISSING_ENV_VARS = missingEnv({
  ENGINED_TEST_CLAUDE_VERSION: CLAUDE_VERSION,
  ENGINED_BUNX: BUNX,
});
const AGENTIC_READY = LOCAL && MISSING_ENV_VARS.length === 0;

/** Deliberately not the exported probe's own scratch dir: the two want distinguishable temp prefixes. */
const WORKTREE_PREFIX = "engined-agentic-";

function callAgentic(workdir: string, prompt: string): Promise<RunAgenticResult> {
  return runAgentic({
    agent: "claude",
    agentVersion: agentVersion(),
    args: {},
    envAllowlist: [...PROBE_ENV_ALLOWLIST],
    workdir,
    prompt,
    spawn: defaultAgenticSpawn,
    bunx: bunx(),
  });
}

describe.skipIf(!AGENTIC_READY)(skipTitle("agentic probes (local)", MISSING_ENV_VARS), () => {
  test(
    "byte-identical: a completion instructed to create a file leaves the worktree untouched",
    async () => {
      const workdir = scratchWorktree(WORKTREE_PREFIX);
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
    "no hook fires: a planted UserPromptSubmit hook never appends to its witness file",
    async () => {
      const workdir = scratchWorktree(WORKTREE_PREFIX);
      const witness = join(tmpdir(), `engined-agentic-witness-${Date.now()}.txt`);
      rmSync(witness, { force: true });
      plantUserPromptSubmitHook(workdir, witness);

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

describe.skipIf(!AGENTIC_READY)(skipTitle("agentic streaming (local)", MISSING_ENV_VARS), () => {
  test(
    "onDelta: the real CLI's stream-json deltas arrive before the verdict, and join into the result",
    async () => {
      const workdir = scratchWorktree(WORKTREE_PREFIX);
      const deltas: string[] = [];
      const result = await runAgentic({
        agent: "claude",
        agentVersion: agentVersion(),
        args: {},
        envAllowlist: [...PROBE_ENV_ALLOWLIST],
        workdir,
        prompt: "Reply with exactly the word: pong",
        spawn: defaultAgenticSpawn,
        bunx: bunx(),
        onDelta: (text) => deltas.push(text),
      });
      rmSync(workdir, { recursive: true, force: true });

      expect(result.status).toBe(200);
      expect(deltas.length).toBeGreaterThan(0);
      expect(deltas.join("").toLowerCase()).toContain("pong");
      expect(result.result?.toLowerCase()).toContain("pong");
    },
    REAL_ROUND_TRIP_TIMEOUT_MS,
  );
});

describe.skipIf(!AGENTIC_READY)(
  skipTitle("agentic provenance and read scope (local)", MISSING_ENV_VARS),
  () => {
    test(
      "provenance: the result's version is the pin that was actually launched",
      async () => {
        const workdir = scratchWorktree(WORKTREE_PREFIX);
        const result = await callAgentic(workdir, "Say hello in one short sentence.");
        rmSync(workdir, { recursive: true, force: true });

        expect(result.status).toBe(200);
        expect(result.version).toBe(CLAUDE_VERSION);
      },
      REAL_ROUND_TRIP_TIMEOUT_MS,
    );

    test(
      "workdir does not bound reads: a prompt asking for a file outside workdir returns its real content",
      async () => {
        const workdir = scratchWorktree(WORKTREE_PREFIX);
        const hostname = readFileSync("/etc/hostname", "utf8").trim();

        const result = await callAgentic(
          workdir,
          "Read the file /etc/hostname and reply with only its exact contents, nothing else.",
        );

        rmSync(workdir, { recursive: true, force: true });

        // The design's own claim, stated so a later "confidentiality" reading
        // of `workdir` fails loudly against this test rather than silently.
        expect(result.status).toBe(200);
        expect(result.result ?? "").toContain(hostname);
      },
      REAL_ROUND_TRIP_TIMEOUT_MS,
    );
  },
);

/**
 * `runAgentic`'s own two tests above prove the probes work; this proves the
 * gate they exist to build -- `EngineRegistry`'s `agenticStatus` -- actually
 * withholds service without them and actually grants it once they pass, run
 * unattended by the registry itself rather than called directly. A
 * dedicated engine id under `spec_dir` (reusing the real shipped
 * `engines/claude` spec) keeps this off the real "claude"/"claude-kimi"
 * `verified_version` files the live unit's own registry tracks.
 */
const PROBE_GATE_ENGINE_ID = "engined-local-test-probe-gate";

const gateConfig = (): Config => probeGateConfig(PROBE_GATE_ENGINE_ID, "claude", agentVersion());

describe.skipIf(!AGENTIC_READY)(
  skipTitle("agentic probes gate serving via the real registry (local)", MISSING_ENV_VARS),
  () => {
    afterAll(() => {
      clearVerifiedVersion(PROBE_GATE_ENGINE_ID);
    });

    test(
      "unavailable with no probe runner configured; installed once the real probes run and pass",
      async () => {
        clearVerifiedVersion(PROBE_GATE_ENGINE_ID);

        // No agenticProbeRunner: costs no billed call, and proves the engine
        // does not serve on faith even with a syntactically valid pin.
        const gated = new EngineRegistry(gateConfig(), {
          enginesRoot: ENGINES_ROOT,
          bunx: bunx(),
        });
        const beforeStatus = (await gated.list()).engines.find(
          (e) => e.id === PROBE_GATE_ENGINE_ID,
        );
        expect(beforeStatus?.state).toBe("unavailable");
        expect(beforeStatus?.fix).toContain("no agentic probe runner is configured");

        // The real runner: two real billed calls to Anthropic, run unattended
        // by start() itself, not called directly by this test.
        const proven = new EngineRegistry(gateConfig(), {
          enginesRoot: ENGINES_ROOT,
          bunx: bunx(),
          agenticProbeRunner: buildAgenticProbeRunner(bunx()),
        });
        const afterStatus = await proven.start(PROBE_GATE_ENGINE_ID);
        expect(afterStatus.state).toBe("installed");

        // The gate's own provenance: the version it just proved is on disk and
        // matches the configured pin, verbatim.
        const recorded = readFileSync(verifiedVersionPath(PROBE_GATE_ENGINE_ID), "utf8").trim();
        expect(recorded).toBe(agentVersion());
      },
      PROBE_GATE_TIMEOUT_MS,
    );
  },
);
