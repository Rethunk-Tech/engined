import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  type AgenticSpawn,
  buildAgenticProbeRunner,
  buildArgv,
  buildChildEnv,
  defaultAgenticSpawn,
  renderEmptyMcpConfig,
  runAgentic,
} from "./agentic.ts";
// The envelope parser moved to agents.ts with the rest of what varies per
// agent; these cases stay here because they are about the launch path.
import { agentCli, parseClaudeEnvelope as parseEnvelope } from "./agents.ts";
// Read-only import: proves the real reachable path (config parse), not just
// the shared validator in isolation. This file does not edit config.ts.
import { loadConfig } from "./config.ts";
import type { ExecResult } from "./exec.ts";
import { BUNX, makeTestRoot } from "./test-support.ts";
import { AGENTIC_FLOOR, assertNoForbiddenFlags, FORBIDDEN_AGENTIC_FLAGS } from "./types.ts";

const PIN = "1.2.3";
const MCP_CONFIG_PATH = "/state/agentic-mcp-empty.json";
const RX_TOOLS_FLAG = /--tools/;

const TEST_ROOT = makeTestRoot("engined-agentic-test-");

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
  const argv = buildArgv({
    bunx: BUNX,
    agent: "claude",
    agentVersion: PIN,
    args: MANY_OTHER_ARGS,
    mcpConfigPath: MCP_CONFIG_PATH,
  });

  expect(argv).toContain("--safe-mode");
  expect(argv).toContain("--strict-mcp-config");
  const toolsIndex = argv.indexOf("--tools");
  expect(toolsIndex).toBeGreaterThan(-1);
  expect(argv[toolsIndex + 1]).toBe("Read,Grep,Glob");

  for (const forbidden of FORBIDDEN_AGENTIC_FLAGS) {
    expect(argv).not.toContain(forbidden);
  }
});

// buildArgv itself stays a dumb assembler: it does not (and should not)
// reject anything, because rejection has to happen before a bad config ever
// reaches it. assertNoForbiddenFlags is where config.ts actually enforces
// this for every engine's `[engine.args]` and every model's `[model.args]`
// (config.ts:158,207) -- these tests exercise that real choke point, plus
// loadConfig end to end, rather than only the shape buildArgv would produce.

test("assertNoForbiddenFlags: every floor flag is rejected if a config names it, and the thrown message names it", () => {
  const floorFlagNames = AGENTIC_FLOOR.filter((token) => token.startsWith("--"));
  expect(floorFlagNames).toEqual(["--safe-mode", "--tools", "--strict-mcp-config"]);

  for (const floorFlag of floorFlagNames) {
    expect(() => assertNoForbiddenFlags([floorFlag], "config.toml")).toThrow(floorFlag);
  }

  // The real call site (config.ts:158) never sees the floor -- it validates
  // only what argsToArgv rendered from `[engine.args]` itself, exactly this
  // shape for `tools = "Bash,Write"`: a value alongside the flag, not the
  // bare flag the loop above used.
  expect(() => assertNoForbiddenFlags(["--tools", "Bash,Write"], "config.toml")).toThrow(
    RX_TOOLS_FLAG,
  );
});

test("assertNoForbiddenFlags: a long list of ordinary args that name none of the floor's flags still passes clean", () => {
  const argv = ["--max-turns", "8", "--model", "sonnet", "--verbose"];

  expect(() => assertNoForbiddenFlags(argv, "config.toml")).not.toThrow();
});

test("assertNoForbiddenFlags: cursor's own ways to say yes are all refused by name", () => {
  expect(() => assertNoForbiddenFlags(["--force"], "config.toml")).toThrow("--force");
  expect(() => assertNoForbiddenFlags(["--yolo"], "config.toml")).toThrow("--yolo");
  // --mode is cursor's own floor flag, not covered by AGENTIC_FLOOR_FLAG_NAMES
  // (claude's flag names only), so it needs its own bare-forbid entry.
  expect(() => assertNoForbiddenFlags(["--mode", "ask"], "config.toml")).toThrow("--mode");
});

test("assertNoForbiddenFlags: --sandbox disabled dissolves the floor in either spelling, --sandbox enabled does not", () => {
  expect(() => assertNoForbiddenFlags(["--sandbox", "disabled"], "config.toml")).toThrow(
    "--sandbox disabled",
  );
  expect(() => assertNoForbiddenFlags(["--sandbox=disabled"], "config.toml")).toThrow(
    "--sandbox disabled",
  );
  expect(() => assertNoForbiddenFlags(["--sandbox", "enabled"], "config.toml")).not.toThrow();
});

test("loadConfig: an agentic engine's [engine.args] tools duplicate is rejected at real config parse", () => {
  const dir = mkdtempSync(join(TEST_ROOT, "engined-agentic-floor-"));
  const configPath = join(dir, "config.toml");
  writeFileSync(
    configPath,
    `
[[engine]]
id = "claude"
agent_version = "1.2.3"

  [engine.args]
  tools = "Bash,Write"
`,
  );

  expect(() => loadConfig(configPath)).toThrow(RX_TOOLS_FLAG);
});

test("buildArgv: command[0] is the given bunx path, and the pin appears literally rather than latest", () => {
  const argv = buildArgv({
    bunx: BUNX,
    agent: "claude",
    agentVersion: PIN,
    args: {},
    mcpConfigPath: MCP_CONFIG_PATH,
  });

  expect(argv[0]).toBe(BUNX);
  expect(argv.some((token) => token.includes(PIN))).toBe(true);
  expect(argv.some((token) => token.includes("latest"))).toBe(false);
});

test("buildArgv: --strict-mcp-config is followed literally by the rendered config path, not left bare", () => {
  const argv = buildArgv({
    bunx: BUNX,
    agent: "claude",
    agentVersion: PIN,
    args: {},
    mcpConfigPath: MCP_CONFIG_PATH,
  });

  const flagIndex = argv.indexOf("--strict-mcp-config");
  expect(flagIndex).toBeGreaterThan(-1);
  expect(argv[flagIndex + 1]).toBe(MCP_CONFIG_PATH);
});

test("buildArgv: an agent with resolveBinary skips bunx and the pin entirely, using the resolved path as argv[0]", () => {
  const cursor = agentCli("cursor");
  expect(cursor?.resolveBinary).toBeDefined();
  let resolved: string | undefined;
  let resolveError: unknown;
  try {
    resolved = cursor?.resolveBinary?.();
  } catch (err) {
    resolveError = err;
  }
  if (resolved === undefined) {
    // No cursor installed on whatever box is running this suite: the failure
    // must still be loud and specific, at the same buildArgv call site a
    // real launch would hit -- never a silent fallback to a bare "agent".
    expect(resolveError).toBeInstanceOf(Error);
    expect(() =>
      buildArgv({
        bunx: BUNX,
        agent: "cursor",
        agentVersion: PIN,
        args: {},
        mcpConfigPath: MCP_CONFIG_PATH,
      }),
    ).toThrow();
  } else {
    // This box has cursor installed (test/local/cursor.test.ts's own real
    // round trip relies on the same fact): buildArgv must actually route
    // through it rather than bunx, and the configured pin -- unused by a
    // self-updating binary with no pin mechanism -- must never appear.
    const argv = buildArgv({
      bunx: BUNX,
      agent: "cursor",
      agentVersion: PIN,
      args: {},
      mcpConfigPath: MCP_CONFIG_PATH,
    });
    expect(argv[0]).toBe(resolved);
    expect(argv[0]).not.toBe(BUNX);
    expect(argv.some((token) => token.includes(PIN))).toBe(false);
  }
});

test("renderEmptyMcpConfig: the file it names exists and holds an empty MCP configuration", () => {
  const path = renderEmptyMcpConfig();

  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: {} });
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

function fakeSpawn(result: ExecResult): { spawn: AgenticSpawn; calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    spawn: (argv, opts) => {
      calls.push([argv, opts]);
      return Promise.resolve(result);
    },
  };
}

/** A spawn whose stdout carries a real clean-success envelope, the shape every "does the argv/env look right" test launches against. */
function fakeOkSpawn(): { spawn: AgenticSpawn; calls: unknown[][] } {
  return fakeSpawn({
    stdout: JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "ok" }),
    stderr: "",
    exitCode: 0,
  });
}

/** A spawn whose stdout carries a real is_error envelope, the shape every "reported as a failure" test launches against. */
function fakeErrorEnvelopeSpawn(): { spawn: AgenticSpawn; calls: unknown[][] } {
  return fakeSpawn({
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
}

/** The runAgentic call every test below makes, varied only by spawn and whichever field the test is exercising. */
function runAgenticFixture(
  spawn: AgenticSpawn,
  overrides: Partial<Parameters<typeof runAgentic>[0]> = {},
) {
  return runAgentic({
    agent: "claude",
    agentVersion: PIN,
    args: {},
    envAllowlist: ["HOME"],
    workdir: "/tmp/scratch-workdir",
    prompt: "hello",
    bunx: BUNX,
    spawn,
    ...overrides,
  });
}

test("runAgentic: the child's stderr reaches neither the result nor the log", async () => {
  // A child that echoes its stdin is the whole risk: journald keeps whatever
  // lands there, and only the provenance line may describe an agentic call.
  const stderrText = "hello: prompt echoed back by a noisy diagnostic";
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
  const written: string[] = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;

  let result: Awaited<ReturnType<typeof runAgentic>>;
  try {
    result = await runAgenticFixture(spawn);
  } finally {
    process.stderr.write = realWrite;
  }

  expect(written.join("")).toBe("");
  expect(JSON.stringify(result)).not.toContain(stderrText);
  expect(result.result).toBe("the answer");
});

test.each([
  ["absent", undefined],
  ["empty", ""],
])("runAgentic: workdir %s is 400 and never spawns", async (_label, workdir) => {
  const { spawn, calls } = fakeSpawn({ stdout: "{}", stderr: "", exitCode: 0 });

  const result = await runAgenticFixture(spawn, { workdir });

  expect(result.status).toBe(400);
  expect(calls.length).toBe(0);
});

test("runAgentic: an is_error envelope with exit 0 is reported as a failure, not success", async () => {
  const { spawn } = fakeErrorEnvelopeSpawn();

  const result = await runAgenticFixture(spawn);

  expect(result.ok).toBe(false);
  expect(result.status).not.toBe(200);
});

test("runAgentic: command[0] resolves from the given bunx and the pin appears in argv, never latest", async () => {
  const { spawn, calls } = fakeOkSpawn();

  await runAgenticFixture(spawn);

  const [argv] = calls[0] as [string[], unknown];
  expect(argv[0]).toBe(BUNX);
  expect(argv.some((token) => token.includes(PIN))).toBe(true);
  expect(argv.some((token) => token.includes("latest"))).toBe(false);
});

test("runAgentic: --strict-mcp-config in the spawned argv names a real file holding an empty MCP config", async () => {
  const { spawn, calls } = fakeOkSpawn();

  await runAgenticFixture(spawn);

  const [argv] = calls[0] as [string[], unknown];
  const flagIndex = argv.indexOf("--strict-mcp-config");
  expect(flagIndex).toBeGreaterThan(-1);
  const path = argv[flagIndex + 1] as string;
  expect(existsSync(path)).toBe(true);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ mcpServers: {} });
});

test("runAgentic: an envelope failure is flagged distinctly from a request-shape 400", async () => {
  const { spawn } = fakeErrorEnvelopeSpawn();

  const envelopeFailureResult = await runAgenticFixture(spawn);
  const workdirMissingResult = await runAgenticFixture(spawn, { workdir: undefined });

  expect(envelopeFailureResult.envelopeFailure).toBe(true);
  expect(workdirMissingResult.envelopeFailure).toBe(false);
});

test("runAgentic: extraEnv is set on the child alongside the allowlist and wins on a name collision", async () => {
  const { spawn, calls } = fakeOkSpawn();

  await runAgenticFixture(spawn, {
    ambientEnv: { HOME: "/home/engined" },
    extraEnv: { HOME: "/redirected", ANTHROPIC_BASE_URL: "https://api.kimi.com/coding/" },
  });

  const [, opts] = calls[0] as [string[], { env: Record<string, string> }];
  expect(opts.env.HOME).toBe("/redirected");
  expect(opts.env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
});

test("runAgentic: a successful result's version is the pin that was launched, not read back from anywhere else", async () => {
  const { spawn } = fakeOkSpawn();

  const result = await runAgenticFixture(spawn);

  expect(result.version).toBe(PIN);
});

/** Reads the witness path back out of the hook the hook-silence probe planted, the way a hook that actually fired would target it. */
function witnessPathFromCwd(cwd: string): string | undefined {
  const settingsPath = join(cwd, ".claude", "settings.json");
  if (!existsSync(settingsPath)) {
    return;
  }
  const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
    hooks: { UserPromptSubmit: { hooks: { command: string }[] }[] };
  };
  const command = settings.hooks.UserPromptSubmit[0]?.hooks[0]?.command ?? "";
  return command.split(">>")[1]?.trim();
}

function cleanEnvelopeSpawn(onCwd?: (cwd: string) => void): AgenticSpawn {
  return (_argv, opts) => {
    onCwd?.(opts.cwd);
    return Promise.resolve({
      stdout: JSON.stringify({ is_error: false, result: "hello" }),
      stderr: "",
      exitCode: 0,
    });
  };
}

/** Every probe test below wires the same engine and pin through buildAgenticProbeRunner, varying only the injected spawn. */
function runProbe(spawn: AgenticSpawn) {
  const runner = buildAgenticProbeRunner(BUNX, { spawn });
  return runner(PIN, "claude");
}

test("buildAgenticProbeRunner: a clean completion under both probes yields ok -- no real spawn, only the injected fake", async () => {
  const cwds: string[] = [];

  const outcome = await runProbe(cleanEnvelopeSpawn((cwd) => cwds.push(cwd)));

  expect(outcome).toEqual({ ok: true });
  expect(cwds).toHaveLength(2);
});

test("buildAgenticProbeRunner: a completion that writes into the scratch worktree fails byte-identical, and the hook probe never runs", async () => {
  const calls: string[] = [];
  const spawn: AgenticSpawn = (_argv, opts) => {
    calls.push(opts.cwd);
    writeFileSync(join(opts.cwd, "proof.txt"), "hello");
    return cleanEnvelopeSpawn()([], opts);
  };

  const outcome = await runProbe(spawn);

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: "byte-identical",
    detail: expect.stringContaining("worktree changed: proof.txt"),
  });
  expect(calls).toHaveLength(1);
});

test("buildAgenticProbeRunner: a hook that actually fires fails no-hook-fires", async () => {
  const spawn: AgenticSpawn = (_argv, opts) => {
    const witness = witnessPathFromCwd(opts.cwd);
    if (witness !== undefined) {
      writeFileSync(witness, "fired\n");
    }
    return cleanEnvelopeSpawn()([], opts);
  };

  const outcome = await runProbe(spawn);

  expect(outcome).toEqual({ ok: false, failedProbe: "no-hook-fires" });
});

test("buildAgenticProbeRunner: an envelope failure fails byte-identical even with an untouched worktree", async () => {
  const spawn: AgenticSpawn = () =>
    Promise.resolve({ stdout: "not json", stderr: "", exitCode: 0 });

  const outcome = await runProbe(spawn);

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: "byte-identical",
    detail: expect.stringContaining("launch answered 502"),
  });
});

/** Reads the witness path back out of the hook `plantCursorPromptHook` planted -- cursor's own `.cursor/hooks.json`, never claude's `.claude/settings.json`. */
function cursorWitnessPathFromCwd(cwd: string): string | undefined {
  const hooksPath = join(cwd, ".cursor", "hooks.json");
  if (!existsSync(hooksPath)) {
    return;
  }
  const hooks = JSON.parse(readFileSync(hooksPath, "utf8")) as {
    hooks: { beforeSubmitPrompt: { command: string }[] };
  };
  const command = hooks.hooks.beforeSubmitPrompt[0]?.command ?? "";
  return command.split(">>")[1]?.trim();
}

function cleanCursorSpawn(onCwd?: (cwd: string) => void): AgenticSpawn {
  return (_argv, opts) => {
    onCwd?.(opts.cwd);
    return Promise.resolve({
      stdout: '{"type":"result","subtype":"success","is_error":false,"result":"hello"}',
      stderr: "",
      exitCode: 0,
    });
  };
}

function runCursorProbe(spawn: AgenticSpawn) {
  const runner = buildAgenticProbeRunner(BUNX, { spawn });
  return runner(PIN, "cursor");
}

test("buildAgenticProbeRunner: cursor's own probes pass against a clean stream-json result", async () => {
  const outcome = await runCursorProbe(cleanCursorSpawn());

  expect(outcome).toEqual({ ok: true });
});

test("buildAgenticProbeRunner: a cursor hook that actually fires fails no-hook-fires, read from .cursor/hooks.json", async () => {
  const spawn: AgenticSpawn = (_argv, opts) => {
    const witness = cursorWitnessPathFromCwd(opts.cwd);
    if (witness !== undefined) {
      writeFileSync(witness, "fired\n");
    }
    return cleanCursorSpawn()([], opts);
  };

  const outcome = await runCursorProbe(spawn);

  expect(outcome).toEqual({ ok: false, failedProbe: "no-hook-fires" });
});

test("buildAgenticProbeRunner: cursor writing into the scratch worktree fails byte-identical", async () => {
  const spawn: AgenticSpawn = (_argv, opts) => {
    writeFileSync(join(opts.cwd, "proof.txt"), "hello");
    return cleanCursorSpawn()([], opts);
  };

  const outcome = await runCursorProbe(spawn);

  expect(outcome).toMatchObject({
    ok: false,
    failedProbe: "byte-identical",
    detail: expect.stringContaining("worktree changed"),
  });
});

/**
 * `defaultAgenticSpawn` against a REAL child process, not a fake -- the one
 * thing a fake can never prove. `/bin/sh -c "... & wait"` gives the wrapper
 * pid (`sh`) a distinct worker pid underneath it, the same shape `bunx`
 * has around `claude` (confirmed live against this box's real `bunx`
 * before writing the fix: it spawns the real binary as its own child, not
 * an exec-replacement, and a single-pid SIGKILL left that child running,
 * orphaned, with no pid left to reach it through). A rejected promise alone
 * proves nothing about the OS process -- the actual proof is the heartbeat
 * file the worker would keep appending to if it survived.
 */
test("defaultAgenticSpawn: aborting kills the real worker process, not just the wrapper -- verified by a heartbeat file, not by the rejection alone", async () => {
  const dir = mkdtempSync(join(TEST_ROOT, "engined-agentic-kill-"));
  const heartbeat = join(dir, "heartbeat");
  writeFileSync(heartbeat, "");
  const argv = [
    "/bin/sh",
    "-c",
    'while true; do date +%s%N >> "$HEARTBEAT_FILE"; sleep 0.05; done & wait',
  ];
  const controller = new AbortController();
  const promise = defaultAgenticSpawn(argv, {
    cwd: dir,
    env: { ...process.env, HEARTBEAT_FILE: heartbeat },
    input: "",
    signal: controller.signal,
  });

  const countLines = () => readFileSync(heartbeat, "utf8").split("\n").filter(Boolean).length;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // Let the worker actually start writing before killing it.
  await sleep(300);
  expect(countLines()).toBeGreaterThan(0);

  controller.abort();
  await expect(promise).rejects.toThrow();

  // The rejection above proves the PROMISE settled -- it proves nothing
  // about the process. Two more samples, a beat apart: if the worker
  // survived, the count would still be climbing between them.
  await sleep(400);
  const justAfterKill = countLines();
  await sleep(400);
  const settled = countLines();

  expect(settled).toBe(justAfterKill);
}, 10_000);
