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
import process from "node:process";
import { AGENTIC_FLOOR } from "./types.ts";

/** Not part of the safety floor — needed only so stdout is the JSON `parseEnvelope` expects. */
const OUTPUT_FORMAT_FLAGS = ["--output-format", "json"] as const;
const STATUS_OK = 200;
const STATUS_ENVELOPE_FAILURE = 502;

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
}

/** The floor is prepended in code on every call — no config entry and no `spec_dir` override can reach it, because an agentic spec mounts nothing to override with. */
export function buildArgv(input: BuildArgvInput): string[] {
  return [
    input.bunx,
    `@anthropic-ai/claude-code@${input.claudeVersion}`,
    "-p",
    ...OUTPUT_FORMAT_FLAGS,
    ...AGENTIC_FLOOR,
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
}

function logToStderr(text: string): void {
  if (text.length > 0) {
    process.stderr.write(`${text}\n`);
  }
}

export async function runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
  if (input.workdir === undefined || input.workdir === "") {
    return { status: 400, ok: false, failure: "workdir is required for an agentic attempt" };
  }
  const bunx = input.bunx ?? process.env.ENGINED_BUNX;
  if (bunx === undefined || bunx === "") {
    throw new Error("ENGINED_BUNX is not set; the unit must set it to the resolved bunx path");
  }

  const argv = buildArgv({ bunx, claudeVersion: input.claudeVersion, args: input.args });
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
  };
}
