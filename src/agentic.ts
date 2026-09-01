/**
 * Launches an agent CLI with writing structurally disabled, always. Because
 * nothing under that floor can write, there is no workdir policy, no
 * allowlist of paths, no snapshot and no undo: the agent returns content and
 * the caller decides whether to write it. `workdir` is where the process
 * starts, not a boundary on what it can read — nothing here should read
 * otherwise, in a comment, a type name or an error string.
 *
 * WHERE the floor comes from is per-agent, and `agents.ts` says which. claude
 * honours it as argv, and `assertNoForbiddenFlags` stops a config unsaying it.
 * opencode offers no such flag, so its floor is `sandbox.ts`'s mount table --
 * measured, its config-level floor is overridable from any ancestor of the
 * workdir. An agent whose floor is the sandbox never launches without it:
 * a missing `bwrap` refuses the call rather than running loose.
 *
 * Failure lives in what the agent printed, never in its exit code. Verified:
 * `claude -p --output-format json` exited 0 with `"subtype": "success"` and a
 * non-empty result while simultaneously carrying `is_error: true`,
 * `terminal_reason: "api_error"` and a body reading "Not logged in". Only the
 * agent's own parser decides success.
 */

import { spawn } from "node:child_process";
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
import { type AgenticOutcome, type AgentTarget, agentCli, type FloorKind } from "./agents.ts";
import type { ExecResult } from "./exec.ts";
import { STATUS_BAD_GATEWAY, STATUS_BAD_REQUEST, STATUS_OK, STATUS_UNAVAILABLE } from "./http.ts";
import { stateDir } from "./paths.ts";
import { resolveBwrap, sandboxArgv, sandboxEnv, sandboxHome } from "./sandbox.ts";
import { argvFromArgs, type EngineEntry } from "./types.ts";

/**
 * `--strict-mcp-config` closes the MCP door only against a config that
 * exists; a bare flag with nothing to point at closes nothing. One shared
 * file for every agentic launch — the closure is engine-independent, so
 * there is nothing per-engine to render.
 */
function mcpEmptyConfigPath(): string {
  return `${stateDir()}/agentic-mcp-empty.json`;
}

/** Rendered fresh before every launch so the flag always names a file that exists. */
export function renderEmptyMcpConfig(): string {
  const path = mcpEmptyConfigPath();
  mkdirSync(stateDir(), { recursive: true });
  writeFileSync(path, JSON.stringify({ mcpServers: {} }), "utf8");
  return path;
}

interface AgenticSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  input: string;
  /**
   * `runOneHop`'s per-hop timeout, or a caller giving up early. Killed on
   * the whole process GROUP, never just the returned pid -- confirmed live
   * against this box's real `bunx`: it spawns the actual `claude` binary as
   * its own child, not an exec-replacement (a different pid), and a SIGKILL
   * aimed at only the wrapper's pid leaves that child running, orphaned, with
   * no pid left to reach it through afterward. SIGTERM alone happened to get
   * forwarded cooperatively in that same test, but nothing guarantees a
   * future bunx version keeps doing that, so the group is signalled either
   * way. `detached: true` below is what makes `-child.pid` a valid target: it
   * gives the child its own process group whose pgid equals its pid.
   */
  signal?: AbortSignal;
}

export type AgenticSpawn = (argv: string[], opts: AgenticSpawnOptions) => Promise<ExecResult>;

/** Graceful-then-forceful: real work (writes, network calls) gets a chance to unwind before the group is SIGKILLed out from under it. */
const KILL_GRACE_MS = 3000;

export function defaultAgenticSpawn(
  argv: string[],
  opts: AgenticSpawnOptions,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = argv;
    if (cmd === undefined) {
      reject(new Error("agentic launch argv is empty"));
      return;
    }
    const child = spawn(cmd, rest, { cwd: opts.cwd, env: opts.env, detached: true });
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    function killGroup(sig: NodeJS.Signals): void {
      if (child.pid === undefined) {
        return;
      }
      try {
        process.kill(-child.pid, sig);
      } catch {
        // Already gone -- nothing left to signal.
      }
    }

    function onAbort(): void {
      killGroup("SIGTERM");
      killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
    }

    if (opts.signal?.aborted) {
      onAbort();
    } else {
      opts.signal?.addEventListener("abort", onAbort);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      reject(err);
    });
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      clearTimeout(killTimer);
      // Killed by our own abort: rejecting (rather than resolving with
      // whatever partial stdout it managed) is what lets runOneHop's own
      // catch block -- which checks `controller.signal.aborted` -- record
      // this as "timeout" instead of an ordinary envelope failure, the same
      // distinction the openai-http path's aborted fetch() already gets.
      if (opts.signal?.aborted) {
        reject(new Error("agentic launch aborted"));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.write(opts.input);
    child.stdin.end();
  });
}

interface BuildArgvInput {
  /** The absolute path the install script resolved — never a bare `bunx`, never a path this module guesses. */
  bunx: string;
  /** Which agent CLI, from the spec. `agents.ts` supplies its package and its launch argv. */
  agent: string;
  /** The configured pin, e.g. `"1.2.3"` — never `"latest"`. */
  agentVersion: string;
  /** `[engine.args]`, rendered last so the operator can extend but never precede or replace what came before. */
  args: Record<string, unknown>;
  /** The rendered empty MCP config claude's `--strict-mcp-config` must name — a bare flag closes nothing. Ignored by an agent that takes no such flag. */
  mcpConfigPath: string;
}

/**
 * Built from scratch on every call, so the spec's own `command` array is
 * never what runs — it exists only so a spec that tried to redirect the
 * binary fails at parse. A `flags` agent's floor is prepended here and no
 * config entry or `spec_dir` override can reach it.
 */
export function buildArgv(input: BuildArgvInput): string[] {
  const agent = agentCli(input.agent);
  if (agent === undefined) {
    throw new Error(`unknown agent "${input.agent}"`);
  }
  return [
    input.bunx,
    `${agent.pkg}@${input.agentVersion}`,
    ...agent.launch(input.mcpConfigPath),
    ...argvFromArgs(input.args),
  ];
}

/** Spawned processes get an allowlist, never the ambient environment — a `--user` unit hands every child the manager's environment otherwise, secrets included. */
export function buildChildEnv(
  allowlist: readonly string[],
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of allowlist) {
    const value = ambient[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

interface RunAgenticInput {
  /** Which agent CLI the spec declared. Decides the argv, the parser and where the floor comes from. */
  agent: string;
  agentVersion: string;
  args: Record<string, unknown>;
  envAllowlist: readonly string[];
  /** Where the process starts. Absent or empty is a 400 that never advances a chain — it is not a read boundary either way. */
  workdir: string | undefined;
  prompt: string;
  spawn: AgenticSpawn;
  /** The absolute path `resolveBunx` produced, which refuses to be empty. */
  bunx: string;
  /** Overrides `resolveBwrap` for a test. Only ever consulted for a `sandbox` agent. */
  bwrap?: string | null;
  /** Where this agent's own model lives. Required by an agent with a `configure`; ignored by one without. */
  upstream?: AgentTarget;
  ambientEnv?: NodeJS.ProcessEnv;
  /**
   * Set on the child unconditionally, after the allowlist — a different
   * thing from ambient inheritance. `envAllowlist` governs what leaks in
   * from this process's own environment (which on a `--user` unit includes
   * secrets an agentic child must never see); these are values the caller
   * deliberately chooses for this one launch, such as redirecting a remote
   * upstream's base URL and key. Wins on a name collision with the allowlist.
   */
  extraEnv?: Record<string, string>;
  /** Forwarded to `spawn` verbatim; see `AgenticSpawnOptions.signal`. Absent for a probe run, which has no chain hop or timeout above it. */
  signal?: AbortSignal;
}

export interface RunAgenticResult {
  status: number;
  ok: boolean;
  result?: string;
  failure?: string;
  /**
   * True only when the envelope itself carried `is_error` or failed to
   * parse — never for the 400 workdir-required rejection, which is a
   * request-shape error, not an envelope one. `chain.ts` reads this to
   * keep an envelope failure from advancing a chain the way a genuine
   * upstream 5xx does.
   */
  envelopeFailure: boolean;
  /** The pin actually embedded in the launched argv. Absent when no process was spawned (the workdir-required 400). */
  version?: string;
}

export async function runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
  if (input.workdir === undefined || input.workdir === "") {
    return {
      status: STATUS_BAD_REQUEST,
      ok: false,
      failure: "workdir is required for an agentic attempt",
      envelopeFailure: false,
    };
  }
  const agent = agentCli(input.agent);
  if (agent === undefined) {
    return {
      status: STATUS_BAD_REQUEST,
      ok: false,
      failure: `unknown agent "${input.agent}"`,
      envelopeFailure: false,
    };
  }
  let argv = buildArgv({
    bunx: input.bunx,
    agent: agent.id,
    agentVersion: input.agentVersion,
    args: input.args,
    mcpConfigPath: renderEmptyMcpConfig(),
  });
  const env: Record<string, string> = {
    ...buildChildEnv(input.envAllowlist, input.ambientEnv ?? process.env),
  };
  if (agent.configure !== undefined) {
    if (input.upstream === undefined) {
      return {
        status: STATUS_BAD_REQUEST,
        ok: false,
        failure: `agent "${agent.id}" has to be pointed at a model; set agent_model on the engine`,
        envelopeFailure: false,
      };
    }
    Object.assign(env, agent.configure(input.upstream));
  }
  if (agent.floor === "sandbox") {
    const bwrap = input.bwrap === undefined ? resolveBwrap() : input.bwrap;
    if (bwrap === null || bwrap === "") {
      // Never a fallback to an unsandboxed launch: this agent's whole floor is
      // the mount table, so without it there is no floor to run under at all.
      return {
        status: STATUS_UNAVAILABLE,
        ok: false,
        failure: `agent "${agent.id}" needs bwrap for its read-only floor and none was found; set ENGINED_BWRAP or install bubblewrap`,
        envelopeFailure: false,
      };
    }
    const home = sandboxHome(agent.id);
    Object.assign(env, sandboxEnv(home));
    argv = sandboxArgv({ bwrap, home, workdir: input.workdir, argv });
  }
  Object.assign(env, input.extraEnv);
  const spawned = await input.spawn(argv, {
    cwd: input.workdir,
    env,
    input: input.prompt,
    signal: input.signal,
  });

  const outcome: AgenticOutcome = agent.parse(spawned.stdout);
  return {
    status: outcome.ok ? STATUS_OK : STATUS_BAD_GATEWAY,
    ok: outcome.ok,
    result: outcome.result,
    failure: outcome.failure,
    envelopeFailure: !outcome.ok,
    version: input.agentVersion,
  };
}

/** Everything else is stripped from a probe's environment, so a probe proves the floor rather than the operator's shell. */
export const PROBE_ENV_ALLOWLIST = ["HOME", "BUN_INSTALL", "BUN_TMPDIR"] as const;
const WITNESS_ID_RADIX = 36;

export function hashTree(root: string): string {
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

/** Always a fresh directory under the OS temp directory — never a real repository this box happens to have checked out. */
function scratchWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-agentic-probe-"));
  writeFileSync(join(dir, "seed.txt"), "unrelated pre-existing content\n");
  return dir;
}

export function plantUserPromptSubmitHook(workdir: string, witness: string): void {
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

interface AgenticProbeRunnerDeps {
  /** Defaults to the real child-process spawn; a test injects a fake so no billed call ever runs. */
  spawn?: AgenticSpawn;
  ambientEnv?: NodeJS.ProcessEnv;
}

interface ProbeInput {
  agent: string;
  agentVersion: string;
  bunx: string;
  deps: AgenticProbeRunnerDeps;
}

/**
 * The two floors fail the same instruction in opposite ways. A `flags` agent
 * is not given a write tool at all, so it declines and says so -- a successful
 * call that changed nothing. A `sandbox` agent has every tool it always had
 * and runs into EROFS, so it usually reports failure. Demanding `ok` of it
 * would fail the probe precisely when the floor worked.
 *
 * `version` is set only on the path that actually spawned something, so it is
 * what keeps "nothing ran" from passing as "nothing was written".
 */
function wroteNothing(outcome: RunAgenticResult, floor: FloorKind, unchanged: boolean): boolean {
  if (!unchanged) {
    return false;
  }
  return floor === "sandbox" ? outcome.version !== undefined : outcome.ok;
}

const WRITE_INSTRUCTION =
  "Create a file named proof.txt in the current directory containing the text 'hello'. Do nothing else.";

function probeLaunch(
  input: ProbeInput,
  workdir: string,
  prompt: string,
): Promise<RunAgenticResult> {
  return runAgentic({
    agent: input.agent,
    agentVersion: input.agentVersion,
    args: {},
    envAllowlist: PROBE_ENV_ALLOWLIST,
    workdir,
    prompt,
    spawn: input.deps.spawn ?? defaultAgenticSpawn,
    bunx: input.bunx,
    ambientEnv: input.deps.ambientEnv,
  });
}

function floorOf(agent: string): FloorKind {
  return agentCli(agent)?.floor ?? "flags";
}

async function runByteIdenticalProbe(input: ProbeInput): Promise<{ ok: boolean }> {
  const workdir = scratchWorktree();
  try {
    const before = hashTree(workdir);
    const outcome = await probeLaunch(input, workdir, WRITE_INSTRUCTION);
    return {
      ok: wroteNothing(outcome, floorOf(input.agent), hashTree(workdir) === before),
    };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function runHookSilenceProbe(input: ProbeInput): Promise<{ ok: boolean }> {
  const workdir = scratchWorktree();
  const witness = join(
    tmpdir(),
    `engined-agentic-probe-witness-${Date.now()}-${Math.random().toString(WITNESS_ID_RADIX).slice(2)}`,
  );
  rmSync(witness, { force: true });
  plantUserPromptSubmitHook(workdir, witness);
  try {
    const outcome = await probeLaunch(input, workdir, "Say hello in one short sentence.");
    return { ok: outcome.ok && !existsSync(witness) };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(witness, { force: true });
  }
}

/**
 * A `sandbox` agent's floor is the mount table, so it is proved against the
 * mount table rather than against the agent: bind a scratch directory the way
 * a real launch binds a workdir, try to write into it, and require EROFS.
 *
 * This deliberately does NOT ask the model anything. The kernel does not care
 * which binary is writing, so `sh` failing proves exactly what the agent
 * failing would, in milliseconds instead of minutes and with no LLM in the
 * loop to be nondeterministic about it. It is also the honest shape: this
 * guarantee does not come from the pin, so a pin bump cannot drop it -- what
 * a bump has to re-check is that THIS BOX still has a working `bwrap`.
 *
 * The end-to-end demonstration that opencode really does get its tools back
 * from a permissive `opencode.json` and still cannot write lives in
 * `test/local/opencode.test.ts`, where a real round trip belongs.
 */
async function runSandboxFloorProbe(input: ProbeInput): Promise<{ ok: boolean }> {
  const bwrap = resolveBwrap();
  if (bwrap === null || bwrap === "") {
    return { ok: false };
  }
  const workdir = scratchWorktree();
  const home = sandboxHome(input.agent);
  try {
    const before = hashTree(workdir);
    const argv = sandboxArgv({
      bwrap,
      home,
      workdir,
      argv: ["/bin/sh", "-c", `printf x > ${join(workdir, "proof.txt")}`],
    });
    const spawned = await (input.deps.spawn ?? defaultAgenticSpawn)(argv, {
      cwd: workdir,
      env: {},
      input: "",
    });
    return { ok: spawned.exitCode !== 0 && hashTree(workdir) === before };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

interface Probe {
  /** Reported verbatim in the engine's `fix` string when it fails. */
  name: string;
  run: (input: ProbeInput) => Promise<{ ok: boolean }>;
}

/**
 * Which guarantees each agent's pin has to re-prove. Both start with the same
 * question -- can it write? -- and then ask the one that is specific to how
 * that agent could get its tools back: a settings hook for claude, a
 * permissive config for opencode.
 */
const AGENT_PROBES: Record<string, readonly Probe[]> = {
  claude: [
    { name: "byte-identical", run: runByteIdenticalProbe },
    { name: "no-hook-fires", run: runHookSilenceProbe },
  ],
  // No model round trip: see runSandboxFloorProbe for why the kernel is the
  // whole proof for an agent floored this way.
  opencode: [{ name: "sandbox-refuses-writes", run: runSandboxFloorProbe }],
};

export function buildAgenticProbeRunner(
  bunx: string,
  deps: AgenticProbeRunnerDeps = {},
): (engine: EngineEntry, agentVersion: string, agent: string) => Promise<AgenticProbeOutcome> {
  return async (_engine, agentVersion, agent) => {
    // Ordered, and stopped at the first failure: each run is a real billed
    // call, and a pin already proven broken should not pay for the next one.
    for (const probe of AGENT_PROBES[agent] ?? []) {
      const outcome = await probe.run({ agent, agentVersion, bunx, deps });
      if (!outcome.ok) {
        return { ok: false, failedProbe: probe.name };
      }
    }
    return { ok: true };
  };
}

/** Mirrors `engines.ts`'s own shape so the two cannot drift apart silently. */
interface AgenticProbeOutcome {
  ok: boolean;
  failedProbe?: string;
}
