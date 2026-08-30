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
 * `/tmp` and `/var/tmp` are tmpfs rather than read-only: an agent that cannot
 * write a temporary file fails in ways that look like a bug in the agent.
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
    "--tmpfs",
    "/var/tmp",
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
