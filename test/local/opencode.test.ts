import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  hashTree,
  PROBE_ENV_ALLOWLIST,
  runAgentic,
} from "../../src/agentic.ts";
import type { EngineEntry } from "../../src/types.ts";

/**
 * A real opencode round trip: `bunx opencode-ai@<pin> run --format json`, under
 * the bwrap floor, answering from ornith through engined's own door. Nothing
 * here is billed -- the model is this box's -- but it needs the door up and
 * the chat engine warm, which is why it lives in this tier rather than in CI.
 *
 * The second test is the one that matters. opencode's own read-only config is
 * overridable by a project `opencode.json` in the workdir or any ancestor of
 * it, so this plants exactly that, as permissively as the format allows, and
 * asserts the write still cannot land. Measured when it was written: opencode
 * did run its `write` tool and did fall back to `printf >`, and both came back
 * "Read-only file system".
 */
const VERSION = process.env.ENGINED_TEST_OPENCODE_VERSION;
const BUNX = process.env.ENGINED_BUNX;
const DOOR = process.env.ENGINED_TEST_DOOR ?? "http://127.0.0.1:29200/v1";
const MODEL = process.env.ENGINED_TEST_AGENT_MODEL ?? "ornith";
const LOCAL = process.env.ENGINED_LOCAL === "1";

/** A warm round trip measured ~11s; a cold one also resolves the npm package. */
const ROUND_TRIP_TIMEOUT_MS = 240_000;
/** The sandbox probe is a mount and a failed write: milliseconds, no model. */
const PROBE_GATE_TIMEOUT_MS = 10_000;

const MISSING = [
  VERSION === undefined ? "ENGINED_TEST_OPENCODE_VERSION" : undefined,
  BUNX === undefined ? "ENGINED_BUNX" : undefined,
].filter((name): name is string => name !== undefined);
const READY = LOCAL && MISSING.length === 0;

function title(base: string): string {
  if (READY) {
    return base;
  }
  return `${base}: SKIPPED -- ${LOCAL ? `missing ${MISSING.join(", ")}` : 'ENGINED_LOCAL is not "1"'}`;
}

/** Everything opencode's config can say to undo a read-only posture. */
const PERMISSIVE = JSON.stringify({
  permission: { "*": "allow", edit: "allow", bash: "allow" },
  tools: { write: true, edit: true, bash: true, patch: true },
});

/** A repo inside a parent, because opencode discovers config by walking up. */
function scratchRepo(permissive: boolean): { root: string; workdir: string } {
  const root = mkdtempSync(join(tmpdir(), "engined-opencode-"));
  const workdir = join(root, "repo");
  mkdirSync(workdir, { recursive: true });
  writeFileSync(join(workdir, "seed.txt"), "unrelated pre-existing content\n");
  if (permissive) {
    writeFileSync(join(root, "opencode.json"), PERMISSIVE);
    writeFileSync(join(workdir, "opencode.json"), PERMISSIVE);
  }
  return { root, workdir };
}

function call(workdir: string, prompt: string) {
  return runAgentic({
    agent: "opencode",
    agentVersion: VERSION as string,
    args: {},
    envAllowlist: [...PROBE_ENV_ALLOWLIST, "PATH"],
    workdir,
    prompt,
    spawn: defaultAgenticSpawn,
    bunx: BUNX as string,
    upstream: { baseUrl: DOOR, model: MODEL },
  });
}

describe(title("opencode, through this door, under the sandbox"), () => {
  test.skipIf(!READY)(
    "answers from the local model, so the whole route works end to end",
    async () => {
      const { root, workdir } = scratchRepo(false);
      try {
        const outcome = await call(workdir, "Reply with exactly the word: pong");
        expect(outcome.failure).toBeUndefined();
        expect(outcome.ok).toBe(true);
        expect(outcome.result?.toLowerCase()).toContain("pong");
        expect(outcome.version).toBe(VERSION as string);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    ROUND_TRIP_TIMEOUT_MS,
  );

  test.skipIf(!READY)(
    "cannot write, with a permissive opencode.json in the workdir AND its parent",
    async () => {
      const { root, workdir } = scratchRepo(true);
      try {
        const before = hashTree(root);
        const outcome = await call(
          workdir,
          "Create a file named proof.txt in the current directory containing the text 'hello'. Do nothing else.",
        );
        // A process really ran: without this, "nothing was written" would also
        // be true of a launch that never happened at all.
        expect(outcome.version).toBe(VERSION as string);
        expect(hashTree(root)).toBe(before);
        expect(existsSync(join(workdir, "proof.txt"))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    ROUND_TRIP_TIMEOUT_MS,
  );

  test.skipIf(!READY)(
    "the version-proof gate passes, and does it without a model round trip",
    async () => {
      const runner = buildAgenticProbeRunner(BUNX as string, DOOR);
      const engine = { id: "opencode", agent_model: MODEL } as EngineEntry;
      const startedAt = Date.now();
      expect(await runner(engine, VERSION as string, "opencode")).toEqual({ ok: true });
      // The point of the sandbox probe, not incidental: an agentic status poll
      // waits on this, and an LLM in it made the gate take minutes.
      expect(Date.now() - startedAt).toBeLessThan(PROBE_GATE_TIMEOUT_MS);
    },
    PROBE_GATE_TIMEOUT_MS,
  );
});
