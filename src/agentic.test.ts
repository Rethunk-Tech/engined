import { expect, test } from "bun:test";
import {
  type AgenticSpawn,
  type AgenticSpawnResult,
  buildArgv,
  buildChildEnv,
  parseEnvelope,
  runAgentic,
} from "./agentic.ts";
import { FORBIDDEN_AGENTIC_FLAGS } from "./types.ts";

const PIN = "1.2.3";
const BUNX = "/opt/engined/state/bunx";

/** Every flag another kind's spec.toml plausibly carries in `[engine.args]`, none of them one of the three floor flags or a forbidden one. */
const MANY_OTHER_ARGS: Record<string, unknown> = {
  "max-turns": 8,
  model: "sonnet",
  "append-system-prompt": "be terse",
  verbose: true,
  "no-color": false,
  cwd: undefined,
  "session-id": "abc-123",
};

test("buildArgv: the floor's three flags all survive a long list of other args, and none of the four forbidden flags appear", () => {
  const argv = buildArgv({ bunx: BUNX, claudeVersion: PIN, args: MANY_OTHER_ARGS });

  expect(argv).toContain("--safe-mode");
  expect(argv).toContain("--strict-mcp-config");
  const toolsIndex = argv.indexOf("--tools");
  expect(toolsIndex).toBeGreaterThan(-1);
  expect(argv[toolsIndex + 1]).toBe("Read,Grep,Glob");

  for (const forbidden of FORBIDDEN_AGENTIC_FLAGS) {
    expect(argv).not.toContain(forbidden);
  }
});

test("buildArgv: command[0] is the given bunx path, and the pin appears literally rather than latest", () => {
  const argv = buildArgv({ bunx: BUNX, claudeVersion: PIN, args: {} });

  expect(argv[0]).toBe(BUNX);
  expect(argv.some((token) => token.includes(PIN))).toBe(true);
  expect(argv.some((token) => token.includes("latest"))).toBe(false);
});

test("parseEnvelope: is_error true is a failure even when the process exited 0", () => {
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: true,
    terminal_reason: "api_error",
    result: "Not logged in",
  });

  const outcome = parseEnvelope(envelope);

  expect(outcome.ok).toBe(false);
  expect(outcome.failure).toContain("api_error");
});

test("parseEnvelope: is_error false is a success", () => {
  const envelope = JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "hi",
  });

  const outcome = parseEnvelope(envelope);

  expect(outcome.ok).toBe(true);
  expect(outcome.result).toBe("hi");
});

test("buildChildEnv: only the allowlisted keys survive — a planted secret in the parent never reaches the child", () => {
  const ambient = {
    HOME: "/home/engined",
    BUN_INSTALL: "/opt/bun",
    BUN_TMPDIR: "/var/lib/engined/tmp",
    GITHUB_TOKEN: "ghp_leaked_repo_scope",
  };

  const childEnv = buildChildEnv(["HOME", "BUN_INSTALL", "BUN_TMPDIR"], ambient);

  expect(childEnv.HOME).toBe(ambient.HOME);
  expect(childEnv.BUN_INSTALL).toBe(ambient.BUN_INSTALL);
  expect(childEnv.BUN_TMPDIR).toBe(ambient.BUN_TMPDIR);
  expect("GITHUB_TOKEN" in childEnv).toBe(false);
  expect(Object.values(childEnv)).not.toContain(ambient.GITHUB_TOKEN);
});

function fakeSpawn(result: AgenticSpawnResult): { spawn: AgenticSpawn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    spawn: (argv, opts) => {
      calls.push([argv, opts]);
      return Promise.resolve(result);
    },
  };
}

test("runAgentic: stderr is captured but never appears anywhere in the returned result", async () => {
  const stderrText = "warning: some noisy diagnostic the operator does not need in the answer";
  const { spawn } = fakeSpawn({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "the answer",
    }),
    stderr: stderrText,
    exitCode: 0,
  });

  const result = await runAgentic({
    claudeVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: "/tmp/scratch-workdir",
    prompt: "hello",
    spawn,
    bunx: BUNX,
    logStderr: () => undefined,
  });

  expect(JSON.stringify(result)).not.toContain(stderrText);
  expect(result.result).toBe("the answer");
});

test("runAgentic: workdir absent is 400 and never spawns", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: "{}", stderr: "", exitCode: 0 });

  const result = await runAgentic({
    claudeVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: undefined,
    prompt: "hello",
    spawn,
    bunx: BUNX,
  });

  expect(result.status).toBe(400);
  expect(calls.length).toBe(0);
});

test("runAgentic: workdir empty is 400 and never spawns", async () => {
  const { spawn, calls } = fakeSpawn({ stdout: "{}", stderr: "", exitCode: 0 });

  const result = await runAgentic({
    claudeVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: "",
    prompt: "hello",
    spawn,
    bunx: BUNX,
  });

  expect(result.status).toBe(400);
  expect(calls.length).toBe(0);
});

test("runAgentic: an is_error envelope with exit 0 is reported as a failure, not success", async () => {
  const { spawn } = fakeSpawn({
    stdout: JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: true,
      terminal_reason: "api_error",
      result: "Not logged in",
    }),
    stderr: "",
    exitCode: 0,
  });

  const result = await runAgentic({
    claudeVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: "/tmp/scratch-workdir",
    prompt: "hello",
    spawn,
    bunx: BUNX,
  });

  expect(result.ok).toBe(false);
  expect(result.status).not.toBe(200);
});

test("runAgentic: command[0] resolves from the given bunx and the pin appears in argv, never latest", async () => {
  const { spawn, calls } = fakeSpawn({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
    stderr: "",
    exitCode: 0,
  });

  await runAgentic({
    claudeVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: "/tmp/scratch-workdir",
    prompt: "hello",
    spawn,
    bunx: BUNX,
  });

  const [argv] = calls[0] as [string[], unknown];
  expect(argv[0]).toBe(BUNX);
  expect(argv.some((token) => token.includes(PIN))).toBe(true);
  expect(argv.some((token) => token.includes("latest"))).toBe(false);
});

test("runAgentic: extraEnv is set on the child alongside the allowlist and wins on a name collision", async () => {
  const { spawn, calls } = fakeSpawn({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
    stderr: "",
    exitCode: 0,
  });

  await runAgentic({
    claudeVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: "/tmp/scratch-workdir",
    prompt: "hello",
    spawn,
    bunx: BUNX,
    ambientEnv: { HOME: "/home/engined" },
    extraEnv: { HOME: "/redirected", ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" },
  });

  const [, opts] = calls[0] as [string[], { env: Record<string, string> }];
  expect(opts.env.HOME).toBe("/redirected");
  expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
});
