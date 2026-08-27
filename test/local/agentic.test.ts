import { beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { defaultAgenticSpawn, type RunAgenticResult, runAgentic } from "../../src/agentic.ts";

/**
 * A real round trip against the real `claude` CLI through `bunx`, costing an
 * actual call to Anthropic. Both probes are what `verified_version` bumping
 * runs before an agentic engine serves a version engined has not proved yet,
 * so they are exercised here as the same executable code, not a checklist.
 */
const CLAUDE_VERSION = process.env.ENGINED_TEST_CLAUDE_VERSION;
const BUNX = process.env.ENGINED_BUNX;
const ENV_ALLOWLIST = ["HOME", "BUN_INSTALL", "BUN_TMPDIR"];

/** Function declaration, not a const arrow: avoids a nursery false-positive on serializable closures. */
function hashTree(root: string): string {
  const hash = createHash("sha256");
  hashWalk(root, root, hash);
  return hash.digest("hex");
}

function hashWalk(root: string, dir: string, hash: ReturnType<typeof createHash>): void {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    const stat = statSync(full);
    hash.update(full.slice(root.length));
    if (stat.isDirectory()) {
      hashWalk(root, full, hash);
    } else {
      hash.update(readFileSync(full));
    }
  }
}

function scratchWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-agentic-"));
  writeFileSync(join(dir, "seed.txt"), "unrelated pre-existing content\n");
  return dir;
}

function callAgentic(workdir: string, prompt: string): Promise<RunAgenticResult> {
  return runAgentic({
    claudeVersion: CLAUDE_VERSION as string,
    args: {},
    envAllowlist: ENV_ALLOWLIST,
    workdir,
    prompt,
    spawn: defaultAgenticSpawn,
    bunx: BUNX,
  });
}

function plantUserPromptSubmitHook(workdir: string, witness: string): void {
  const claudeDir = join(workdir, ".claude");
  mkdirSync(claudeDir, { recursive: true });
  writeFileSync(
    join(claudeDir, "settings.json"),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { matcher: "", hooks: [{ type: "command", command: `echo fired >> ${witness}` }] },
        ],
      },
    }),
  );
}

describe.skipIf(process.env.ENGINED_LOCAL !== "1")("agentic probes (local)", () => {
  beforeAll(() => {
    if (CLAUDE_VERSION === undefined || BUNX === undefined) {
      throw new Error(
        "ENGINED_TEST_CLAUDE_VERSION and ENGINED_BUNX must both be set to run the agentic local tier",
      );
    }
  });

  test("byte-identical: a completion instructed to create a file leaves the worktree untouched", async () => {
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
  });

  test("no hook fires: a planted UserPromptSubmit hook never appends to its witness file", async () => {
    const workdir = scratchWorktree();
    const witness = join(tmpdir(), `engined-agentic-witness-${Date.now()}.txt`);
    rmSync(witness, { force: true });
    plantUserPromptSubmitHook(workdir, witness);

    const result = await callAgentic(workdir, "Say hello in one short sentence.");

    const witnessExists = existsSync(witness);
    rmSync(workdir, { recursive: true, force: true });
    rmSync(witness, { force: true });

    expect(result.status).toBe(200);
    expect(witnessExists).toBe(false);
  });
});
