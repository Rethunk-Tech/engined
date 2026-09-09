import { beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import {
  defaultAgenticSpawn,
  observeAgentVersion,
  type RunAgenticResult,
  runAgentic,
} from "../../src/agentic.ts";
import { PROBE_ENV_ALLOWLIST, plantCursorPromptHook } from "../../src/agenticProbeHarness.ts";
import {
  agentEnv,
  agenticIntegrityTests,
  agenticProbeGateTest,
  scratchWorktree,
  skipTitle,
} from "./fixtures.ts";

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
const {
  version: CURSOR_VERSION,
  bunx,
  agentVersion,
  ready: AGENTIC_READY,
  skipReason: SKIP_REASON,
} = agentEnv("ENGINED_TEST_CURSOR_VERSION");

/** A real observed round trip through `agent -p` took 3-9s; genuine headroom over that. */
const REAL_ROUND_TRIP_TIMEOUT_MS = 60_000;
/** The probe-gate test below makes two real round trips sequentially. */
const PROBE_GATE_TIMEOUT_MS = 180_000;

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

const WORKTREE_PREFIX = "engined-cursor-";

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

agenticIntegrityTests({
  title: "cursor agentic probes (local)",
  ready: AGENTIC_READY,
  skipReason: SKIP_REASON,
  prefix: WORKTREE_PREFIX,
  hookName: "beforeSubmitPrompt",
  plantHook: plantCursorPromptHook,
  call: callAgentic,
  timeoutMs: REAL_ROUND_TRIP_TIMEOUT_MS,
});

describe.skipIf(!AGENTIC_READY)(
  skipTitle("cursor agentic provenance (local)", AGENTIC_READY, SKIP_REASON),
  () => {
    test(
      "provenance: the result's version is the pin that was actually launched, and the answer is real text out of the stream-json envelope",
      async () => {
        const workdir = scratchWorktree(WORKTREE_PREFIX);
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
  },
);

/**
 * A dedicated engine id under `spec_dir` (reusing the real shipped
 * `engines/cursor` spec) keeps this off the live unit's own
 * `verified_version` file.
 */
agenticProbeGateTest({
  title: "cursor agentic probes gate serving via the real registry (local)",
  ready: AGENTIC_READY,
  skipReason: SKIP_REASON,
  engineId: "engined-local-test-cursor-probe-gate",
  agent: "cursor",
  bunx,
  agentVersion,
  timeoutMs: PROBE_GATE_TIMEOUT_MS,
  precondition: assertVersionCurrent,
});
