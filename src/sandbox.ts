/**
 * The kernel floor, for an agent whose own configuration cannot provide one.
 *
 * `claude` takes the read-only floor as flags it honours, and
 * `assertNoForbiddenFlags` stops a config from unsaying them. `opencode` has
 * no equivalent: it exposes no tool or permission flag at all, its only lever
 * is a config file, and config is discovered by walking UP from the working
 * directory -- so any ancestor of the workdir can hand `edit`, `bash` and
 * `write` back, and even the built-in read-only `plan` agent can be redefined
 * the same way, because the rules are last-wins. Both measured against
 * opencode 1.18.25.
 *
 * For an agent like that the guarantee has to come from something it cannot
 * argue with. `bwrap` binds the filesystem read-only and the agent's own state
 * directory read-write, so a write into the workdir fails with EROFS whatever
 * a config file inside it claims. Unprivileged user namespaces are what make
 * this reachable without root.
 *
 * What this floor does NOT close, and `--tools Read,Grep,Glob
 * --strict-mcp-config` does: reading. The sandbox shares the host network
 * namespace because the agent has to reach engined's own door on loopback, so
 * an agent under it can still run read-only shell, fetch a URL and start an
 * MCP server. It is the stronger floor against writing and the weaker one
 * against exfiltration, and an agent given a private repository is trusted
 * with its contents either way.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { stateDir } from "./paths.ts";

/**
 * Writable, engined-owned, and never inside a repository -- so the agent keeps
 * its sessions and its downloaded provider packages across launches while the
 * workdir stays read-only. A tmpfs here would work and would re-download the
 * provider on every single call.
 */
export function sandboxHome(agentId: string): string {
  const home = join(stateDir(), "agentic-home", agentId);
  mkdirSync(home, { recursive: true });
  return home;
}

export interface SandboxInput {
  /** Absolute `bwrap` path, resolved by the install script the way `bunx` is. */
  bwrap: string;
  /** The agent's writable state directory, from `sandboxHome`. */
  home: string;
  /** Bound read-only over itself: the one directory the agent was pointed at. */
  workdir: string;
  /** The launch the sandbox wraps, `bunx` path first. */
  argv: readonly string[];
}

/**
 * Order is the whole mechanism: `--ro-bind / /` first makes everything
 * read-only, and only the binds after it are writable. A later bind wins, so
 * the agent's home is carved back out read-write and the workdir is re-bound
 * read-only after it -- explicit rather than merely inherited, because the
 * workdir is the one path this floor exists to protect.
 *
 * `/tmp` is a tmpfs rather than read-only, because an agent that cannot write a
 * temporary file fails in ways that look like a bug in the agent. It is the
 * only one: `sandboxEnv` points TMPDIR at it, and every additional tmpfs is
 * another path that could mask a workdir mounted underneath it.
 */
export function sandboxArgv(input: SandboxInput): string[] {
  return [
    input.bwrap,
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    input.home,
    input.home,
    "--ro-bind",
    input.workdir,
    input.workdir,
    // Belt and braces beside defaultAgenticSpawn's process-group kill: if
    // engined dies without getting its signal out, the sandbox still goes.
    "--die-with-parent",
    "--",
    ...input.argv,
  ];
}

/**
 * Resolved at launch rather than at startup: a box that only ever runs a
 * `flags` agent needs no `bwrap` at all, and making it fatal at boot would
 * take engined down for an engine nobody configured. `null` is refused by the
 * caller -- there is no unsandboxed fallback, because the fallback would be
 * running a write-capable agent loose in someone's repository.
 */
export function resolveBwrap(
  env: NodeJS.ProcessEnv = process.env,
  which: (cmd: string) => string | null = Bun.which,
): string | null {
  const configured = env.ENGINED_BWRAP;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  return which("bwrap");
}

/**
 * Everything the agent needs pointed inside its own writable directory. A
 * `--user` unit's HOME is the operator's, which the sandbox binds read-only,
 * so an agent left pointing at it fails on its own state file rather than on
 * anything to do with the workdir -- and that failure reads like a bug in the
 * agent rather than the floor doing its job.
 */
export function sandboxEnv(home: string): Record<string, string> {
  return {
    HOME: home,
    XDG_DATA_HOME: join(home, "data"),
    XDG_CONFIG_HOME: join(home, "config"),
    XDG_STATE_HOME: join(home, "state"),
    XDG_CACHE_HOME: join(home, "cache"),
    // The child's environment is an allowlist, so it has no TMPDIR unless one
    // is put there. Without it `bunx` refuses to run at all, with an error
    // about a temporary directory that says nothing about a sandbox --
    // measured, and the reason this is not left to the ambient environment.
    TMPDIR: "/tmp",
    BUN_TMPDIR: "/tmp",
    // Inside the writable home rather than the tmpfs, so a fetched agent
    // package survives to the next launch instead of being downloaded again.
    BUN_INSTALL: join(home, "bun"),
  };
}
