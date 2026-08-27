import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "./secrets.ts";
import { resolveSecret } from "./secrets.ts";
import type { SecretRef } from "./types.ts";

const REF: SecretRef = { service: "engined-test", username: "alice", header: "Authorization" };

function fakeExec(result: ExecResult, captured?: { args?: readonly string[] }): Exec {
  return (args) => {
    if (captured) {
      captured.args = args;
    }
    return Promise.resolve(result);
  };
}

describe("resolveSecret", () => {
  test("resolved secret returns ok: true", async () => {
    const outcome = await resolveSecret(
      REF,
      fakeExec({ stdout: "sk-live-secret\n", stderr: "", exitCode: 0 }),
    );
    expect(outcome).toEqual({ ok: true, value: "sk-live-secret" });
  });

  test("zero exit with empty output is not treated as resolved", async () => {
    const outcome = await resolveSecret(REF, fakeExec({ stdout: "", stderr: "", exitCode: 0 }));
    expect(outcome.ok).toBe(false);
  });

  test("missing entry returns reason missing with a secret-tool store fix", async () => {
    const outcome = await resolveSecret(REF, fakeExec({ stdout: "", stderr: "", exitCode: 1 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("missing");
      expect(outcome.fix).toContain("secret-tool store");
    }
  });

  test("locked keyring returns reason locked without a store command", async () => {
    const outcome = await resolveSecret(
      REF,
      fakeExec({
        stdout: "",
        stderr: "secret-tool: Could not connect: No such file or directory\n",
        exitCode: 1,
      }),
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.reason).toBe("locked");
      expect(outcome.fix).not.toContain("secret-tool store");
    }
  });

  test("no failure outcome carries the resolved value", async () => {
    const secretValue = "sk-super-secret-value";
    const missing = await resolveSecret(REF, fakeExec({ stdout: "", stderr: "", exitCode: 1 }));
    const locked = await resolveSecret(
      REF,
      fakeExec({ stdout: "", stderr: `error: ${secretValue}`, exitCode: 1 }),
    );
    expect(JSON.stringify(missing)).not.toContain(secretValue);
    expect(JSON.stringify(locked)).not.toContain(secretValue);
  });

  test("never constructs a command containing search", async () => {
    const captured: { args?: readonly string[] } = {};
    await resolveSecret(REF, fakeExec({ stdout: "v", stderr: "", exitCode: 0 }, captured));
    expect(captured.args).toBeDefined();
    for (const arg of captured.args ?? []) {
      expect(arg).not.toBe("search");
    }
    expect((captured.args ?? []).join(" ")).not.toContain("search");
  });
});
