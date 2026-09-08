import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import {
  defaultAgenticSpawn,
  PROBE_ENV_ALLOWLIST,
  plantUserPromptSubmitHook,
  type RunAgenticResult,
  runAgentic,
} from "../../src/agentic.ts";
import {
  agentEnv,
  agenticIntegrityTests,
  agenticProbeGateTest,
  scratchWorktree,
  skipTitle,
} from "./fixtures.ts";

/**
 * A real round trip against the real `claude` CLI through `bunx`, costing an
 * actual call to Anthropic. Both probes are what `verified_version` bumping
 * runs before an agentic engine serves a version engined has not proved yet,
 * so they are exercised here as the same executable code, not a checklist.
 */
const {
  version: CLAUDE_VERSION,
  bunx,
  agentVersion,
  ready: AGENTIC_READY,
  skipReason: SKIP_REASON,
} = agentEnv("ENGINED_TEST_CLAUDE_VERSION");

/** A real observed round trip through `bunx claude -p` took ~6s; 60s is genuine headroom over that, not a number picked to match bun's 5s default. */
const REAL_ROUND_TRIP_TIMEOUT_MS = 60_000;
/** The probe-gate test below makes two real round trips sequentially. */
const PROBE_GATE_TIMEOUT_MS = 180_000;

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

agenticIntegrityTests({
  title: "agentic probes (local)",
  ready: AGENTIC_READY,
  skipReason: SKIP_REASON,
  prefix: WORKTREE_PREFIX,
  hookName: "UserPromptSubmit",
  plantHook: plantUserPromptSubmitHook,
  call: callAgentic,
  timeoutMs: REAL_ROUND_TRIP_TIMEOUT_MS,
});

describe.skipIf(!AGENTIC_READY)(
  skipTitle("agentic streaming (local)", AGENTIC_READY, SKIP_REASON),
  () => {
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
  },
);

describe.skipIf(!AGENTIC_READY)(
  skipTitle("agentic provenance and read scope (local)", AGENTIC_READY, SKIP_REASON),
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
 * A dedicated engine id under `spec_dir` (reusing the real shipped
 * `engines/claude` spec) keeps this off the real "claude"/"claude-kimi"
 * `verified_version` files the live unit's own registry tracks.
 */
agenticProbeGateTest({
  title: "agentic probes gate serving via the real registry (local)",
  ready: AGENTIC_READY,
  skipReason: SKIP_REASON,
  engineId: "engined-local-test-probe-gate",
  agent: "claude",
  bunx,
  agentVersion,
  timeoutMs: PROBE_GATE_TIMEOUT_MS,
});
