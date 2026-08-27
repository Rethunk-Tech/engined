/**
 * Launches `claude -p` with writing structurally disabled, always. Because
 * nothing under this floor can write, there is no workdir policy, no
 * allowlist of paths, no snapshot and no undo: the agent returns content and
 * the caller decides whether to write it. `workdir` is where the process
 * starts, not a boundary on what it can read — nothing here should read
 * otherwise, in a comment, a type name or an error string.
 *
 * Failure lives in the JSON envelope on stdout, never in the exit code: a
 * `claude -p` run has exited 0 with `is_error: true` and a body reading
 * "Not logged in". Only `parseEnvelope` decides success.
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
import { stateDir } from "./paths.ts";
import { AGENTIC_FLOOR, type EngineEntry } from "./types.ts";

/**
 * Not part of the safety floor — needed only so stdout is the JSON
 * `parseEnvelope` expects. Unconditional in code on every call, the same as
 * the floor itself: never write `output-format` into a `[engine.args]`
 * table. It changes nothing when it agrees with this, and silently breaks
 * every response parse when it doesn't — `parseEnvelope` would see whatever
 * `claude` actually printed for a non-JSON format and report it as an
 * unparseable envelope.
 */
const OUTPUT_FORMAT_FLAGS = ["--output-format", "json"] as const;
const STATUS_OK = 200;
const STATUS_ENVELOPE_FAILURE = 502;

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

export interface AgenticSpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AgenticSpawnOptions {
  cwd: string;
  env: Record<string, string>;
  input: string;
}

export type AgenticSpawn = (
  argv: string[],
  opts: AgenticSpawnOptions,
) => Promise<AgenticSpawnResult>;

export function defaultAgenticSpawn(
  argv: string[],
  opts: AgenticSpawnOptions,
): Promise<AgenticSpawnResult> {
  return new Promise((resolve, reject) => {
    const [cmd, ...rest] = argv;
    if (cmd === undefined) {
      reject(new Error("agentic launch argv is empty"));
      return;
    }
    const child = spawn(cmd, rest, { cwd: opts.cwd, env: opts.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
    child.stdin.write(opts.input);
    child.stdin.end();
  });
}

/** `--<key>` for every entry; `true` is a bare flag, `false`/`null`/`undefined` is omitted, anything else takes the stringified value. */
function flattenArgs(args: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === false || value === undefined || value === null) {
      continue;
    }
    out.push(`--${key}`);
    if (value !== true) {
      out.push(String(value));
    }
  }
  return out;
}

export interface BuildArgvInput {
  /** The absolute path the install script resolved — never a bare `bunx`, never a path this module guesses. */
  bunx: string;
  /** The configured pin, e.g. `"1.2.3"` — never `"latest"`. */
  claudeVersion: string;
  /** `[engine.args]`, rendered after the floor so the operator can extend but never precede or replace it. */
  args: Record<string, unknown>;
  /** The rendered empty MCP config `--strict-mcp-config` must name — a bare flag closes nothing. */
  mcpConfigPath: string;
}

/** The floor is prepended in code on every call — no config entry and no `spec_dir` override can reach it, because an agentic spec mounts nothing to override with. */
export function buildArgv(input: BuildArgvInput): string[] {
  return [
    input.bunx,
    `@anthropic-ai/claude-code@${input.claudeVersion}`,
    "-p",
    ...OUTPUT_FORMAT_FLAGS,
    ...AGENTIC_FLOOR,
    input.mcpConfigPath,
    ...flattenArgs(input.args),
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

export interface AgenticOutcome {
  ok: boolean;
  result?: string;
  failure?: string;
}

/** The only place success is decided. Exit status never enters this function's reasoning. */
export function parseEnvelope(stdout: string): AgenticOutcome {
  let envelope: { is_error?: boolean; subtype?: string; terminal_reason?: string; result?: string };
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, failure: "claude did not print a parseable JSON envelope on stdout" };
  }
  if (envelope.is_error) {
    const reason = envelope.terminal_reason ?? envelope.subtype ?? "is_error";
    return { ok: false, failure: `agentic envelope failure: ${reason}`, result: envelope.result };
  }
  return { ok: true, result: envelope.result };
}

export interface RunAgenticInput {
  claudeVersion: string;
  args: Record<string, unknown>;
  envAllowlist: readonly string[];
  /** Where the process starts. Absent or empty is a 400 that never advances a chain — it is not a read boundary either way. */
  workdir: string | undefined;
  prompt: string;
  spawn: AgenticSpawn;
  /** Defaults to `process.env.ENGINED_BUNX`, the absolute path the unit sets. */
  bunx?: string;
  ambientEnv?: NodeJS.ProcessEnv;
  /** stderr is logged, never folded into the result. Defaults to the real stderr, which a `systemd --user` unit ships to journald the same as stdout. */
  logStderr?: (text: string) => void;
  /**
   * Set on the child unconditionally, after the allowlist — a different
   * thing from ambient inheritance. `envAllowlist` governs what leaks in
   * from this process's own environment (which on a `--user` unit includes
   * secrets an agentic child must never see); these are values the caller
   * deliberately chooses for this one launch, such as redirecting a remote
   * upstream's base URL and key. Wins on a name collision with the allowlist.
   */
  extraEnv?: Record<string, string>;
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

function logToStderr(text: string): void {
  if (text.length > 0) {
    process.stderr.write(`${text}\n`);
  }
}

export async function runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
  if (input.workdir === undefined || input.workdir === "") {
    return {
      status: 400,
      ok: false,
      failure: "workdir is required for an agentic attempt",
      envelopeFailure: false,
    };
  }
  const bunx = input.bunx ?? process.env.ENGINED_BUNX;
  if (bunx === undefined || bunx === "") {
    throw new Error("ENGINED_BUNX is not set; the unit must set it to the resolved bunx path");
  }

  const argv = buildArgv({
    bunx,
    claudeVersion: input.claudeVersion,
    args: input.args,
    mcpConfigPath: renderEmptyMcpConfig(),
  });
  const env = {
    ...buildChildEnv(input.envAllowlist, input.ambientEnv ?? process.env),
    ...input.extraEnv,
  };
  const spawned = await input.spawn(argv, { cwd: input.workdir, env, input: input.prompt });

  (input.logStderr ?? logToStderr)(spawned.stderr);

  const outcome = parseEnvelope(spawned.stdout);
  return {
    status: outcome.ok ? STATUS_OK : STATUS_ENVELOPE_FAILURE,
    ok: outcome.ok,
    result: outcome.result,
    failure: outcome.failure,
    envelopeFailure: !outcome.ok,
    version: input.claudeVersion,
  };
}

/**
 * The two probes the design names in TODO.md's "Bumping the pin re-proves
 * the guarantee, automatically": a completion instructed to create a file,
 * worktree-hashed before and after, and a planted `UserPromptSubmit` hook
 * checked for silence. Each run costs a real billed call to Anthropic, so
 * this is only ever wired into the version-proof gate (`engines.ts`'s
 * `agenticStatus`), which fires solely when the configured pin differs from
 * the one last recorded — never per request, never per status poll.
 */
const PROBE_ENV_ALLOWLIST = ["HOME", "BUN_INSTALL", "BUN_TMPDIR"] as const;
const WITNESS_ID_RADIX = 36;

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

/** Always a fresh directory under the OS temp directory — never a real repository this box happens to have checked out. */
function scratchWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-agentic-probe-"));
  writeFileSync(join(dir, "seed.txt"), "unrelated pre-existing content\n");
  return dir;
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

export interface AgenticProbeRunnerDeps {
  /** Defaults to the real child-process spawn; a test injects a fake so no billed call ever runs. */
  spawn?: AgenticSpawn;
  ambientEnv?: NodeJS.ProcessEnv;
}

async function runByteIdenticalProbe(
  claudeVersion: string,
  bunx: string,
  deps: AgenticProbeRunnerDeps,
): Promise<{ ok: boolean }> {
  const workdir = scratchWorktree();
  try {
    const before = hashTree(workdir);
    const outcome = await runAgentic({
      claudeVersion,
      args: {},
      envAllowlist: PROBE_ENV_ALLOWLIST,
      workdir,
      prompt:
        "Create a file named proof.txt in the current directory containing the text 'hello'. Do nothing else.",
      spawn: deps.spawn ?? defaultAgenticSpawn,
      bunx,
      ambientEnv: deps.ambientEnv,
    });
    return { ok: outcome.ok && hashTree(workdir) === before };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

async function runHookSilenceProbe(
  claudeVersion: string,
  bunx: string,
  deps: AgenticProbeRunnerDeps,
): Promise<{ ok: boolean }> {
  const workdir = scratchWorktree();
  const witness = join(
    tmpdir(),
    `engined-agentic-probe-witness-${Date.now()}-${Math.random().toString(WITNESS_ID_RADIX).slice(2)}`,
  );
  rmSync(witness, { force: true });
  plantUserPromptSubmitHook(workdir, witness);
  try {
    const outcome = await runAgentic({
      claudeVersion,
      args: {},
      envAllowlist: PROBE_ENV_ALLOWLIST,
      workdir,
      prompt: "Say hello in one short sentence.",
      spawn: deps.spawn ?? defaultAgenticSpawn,
      bunx,
      ambientEnv: deps.ambientEnv,
    });
    return { ok: outcome.ok && !existsSync(witness) };
  } finally {
    rmSync(workdir, { recursive: true, force: true });
    rmSync(witness, { force: true });
  }
}

/**
 * Runs the byte-identical probe, then — only if it passed — the hook-silence
 * probe: a probe run is a real billed call, so a proven-broken pin skips the
 * second one rather than paying for it. Return type matches `engines.ts`'s
 * `AgenticProbeRunner` exactly; `EngineEntry` is accepted and unused because
 * every agentic launch is identical regardless of which engine asked for it.
 */
export function buildAgenticProbeRunner(
  bunx: string,
  deps: AgenticProbeRunnerDeps = {},
): (engine: EngineEntry, claudeVersion: string) => Promise<{ ok: boolean; failedProbe?: string }> {
  return async (_engine, claudeVersion) => {
    const byteIdentical = await runByteIdenticalProbe(claudeVersion, bunx, deps);
    if (!byteIdentical.ok) {
      return { ok: false, failedProbe: "byte-identical" };
    }
    const hookSilence = await runHookSilenceProbe(claudeVersion, bunx, deps);
    if (!hookSilence.ok) {
      return { ok: false, failedProbe: "no-hook-fires" };
    }
    return { ok: true };
  };
}
