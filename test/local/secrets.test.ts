import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import process from "node:process";
import { resolveSecret, secretExec } from "../../src/secrets.ts";
import type { SecretRef } from "../../src/types.ts";

/**
 * A real round trip against the real keyring, scoped to a throwaway service
 * name so it can never collide with an operator-stored credential. Seeded
 * before every test, not once for the file: the missing-entry test deletes
 * the same entry the resolve test reads, so seeding once would make this
 * file's result depend on the order its tests happen to run in.
 */
const REF: SecretRef = {
  service: "engined-test-scratch",
  username: "engined-test-scratch",
  header: "Authorization",
};
const SCRATCH_VALUE = "engined-test-scratch-value";

async function clearScratch(): Promise<void> {
  await secretExec(["clear", "service", REF.service, "username", REF.username]);
}

/** `secret-tool store` reads the password from stdin until EOF; `secretExec` never writes to it. */
function storeScratch(value: string): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn("secret-tool", [
      "store",
      `--label=${REF.service}`,
      "service",
      REF.service,
      "username",
      REF.username,
    ]);
    proc.on("close", (code) => resolve(code ?? 1));
    proc.stdin.write(value);
    proc.stdin.end();
  });
}

describe.skipIf(process.env.ENGINED_LOCAL !== "1")("resolveSecret (local)", () => {
  beforeEach(async () => {
    await clearScratch();
    const exitCode = await storeScratch(SCRATCH_VALUE);
    if (exitCode !== 0) {
      throw new Error("secret-tool store failed for the scratch entry; is the keyring unlocked?");
    }
  });

  afterAll(async () => {
    await clearScratch();
  });

  test("resolves the stored scratch value", async () => {
    const outcome = await resolveSecret(REF);
    expect(outcome).toEqual({ ok: true, value: SCRATCH_VALUE });
  });

  test("reports missing after the entry is cleared", async () => {
    await clearScratch();
    const outcome = await resolveSecret(REF);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("missing");
    }
  });
});
