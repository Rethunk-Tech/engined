import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import type { AgentCli } from './agents.ts'
import {
  copyLogins,
  loopbackPorts,
  resolveBwrap,
  resolvePasta,
  SANDBOX_BUN_DIR,
  sandboxArgv,
  sandboxEnv,
  sandboxHome,
  sandboxLaunchHome,
} from './sandbox.ts'

interface SandboxFloorInput {
  workdir: string
  argv: string[]
  env: Record<string, string>
  /** Overrides `resolveBwrap()`; only ever set by a test. */
  bwrapOverride: string | null | undefined
  /** A private, empty Bun install tree the launch may write; the shared cache is then not mounted at all. */
  seedCache?: string
  /** Paths the launch was handed, shown back through the masked home. */
  readOnly: readonly string[]
  writable?: readonly string[]
  /** tmpfs'd before the workdir bind; omitted uses the config default. */
  sandboxMask?: readonly string[]
  /** The launch's upstream and extra env name the door; their loopback ports are the only host network the sandbox keeps. */
  upstreamUrl?: string
  extraEnv?: Record<string, string>
  /** Overrides `resolvePasta()`; only ever set by a test. */
  pasta?: string | null
}

/** The one reading of "this box has no bwrap": `null`, and the empty string an override may spell it as. */
export function usableBwrap(override?: string | null): string | null {
  const bwrap = override === undefined ? resolveBwrap() : override
  return bwrap === null || bwrap === '' ? null : bwrap
}

/** The agent can `chmod 000` a directory it made under the home, which makes rmSync throw EACCES; the home is ours, so reopen it and retry once. */
export function removeLaunchHome(home: string): void {
  const remove = () => rmSync(home, { recursive: true, force: true })
  try {
    remove()
  } catch {
    try {
      Bun.spawnSync(['chmod', '-R', 'u+rwX', '--', home])
      remove()
    } catch (err) {
      process.stderr.write(
        `engined: agent launch home ${home} could not be removed: ${String(err)}\n`,
      )
    }
  }
}

/** The Bun install tree every normal launch of this agent reads (through a throwaway overlay). */
export function sharedInstallCache(agent: AgentCli): string {
  return agent.installCache?.() ?? join(sandboxHome(agent.id), SANDBOX_BUN_DIR)
}

/** A fresh private seed tree beside `shared`, on the same filesystem so promotion is a rename. */
export function makeSeedCache(shared: string): string {
  mkdirSync(dirname(shared), { recursive: true })
  return mkdtempSync(`${shared}.probe-`)
}

/**
 * Move what a passed probe fetched into the shared cache: package entries under
 * `install/cache` (one `@scope` level deep) that the shared tree does not
 * already hold. An existing entry is never replaced and a symlink is never moved.
 */
export function promoteSeedCache(seed: string, shared: string): void {
  const merge = (from: string, to: string, scopes: boolean): void => {
    if (!existsSync(from)) {
      return
    }
    mkdirSync(to, { recursive: true })
    for (const name of readdirSync(from)) {
      const src = join(from, name)
      const dst = join(to, name)
      const kind = lstatSync(src)
      if (kind.isSymbolicLink()) {
        continue
      }
      if (scopes && name.startsWith('@') && kind.isDirectory()) {
        merge(src, dst, false)
      } else if (!existsSync(dst)) {
        renameSync(src, dst)
      }
    }
  }
  merge(join(seed, 'install', 'cache'), join(shared, 'install', 'cache'), true)
}

/** What to install or set when the sandbox floor is missing a tool. */
export const SANDBOX_FIX = {
  bwrap: 'set ENGINED_BWRAP or install bubblewrap',
  pasta: 'install passt',
} as const

/** `argv` wrapped under bwrap in pasta's network namespace, the launch home's env merged into `env` in place -- or the tool this box lacks to build that floor. */
export function applySandboxFloor(
  agent: AgentCli,
  input: SandboxFloorInput,
): { argv: string[]; home: string; cleanup: () => void } | { missing: 'bwrap' | 'pasta' } {
  const bwrap = usableBwrap(input.bwrapOverride)
  if (bwrap === null) {
    return { missing: 'bwrap' }
  }
  const pasta = input.pasta === undefined ? resolvePasta() : input.pasta
  if (pasta === null || pasta === '') {
    return { missing: 'pasta' }
  }
  const home = sandboxLaunchHome(agent.id)
  copyLogins(home, agent.logins ?? [])
  const shared = sharedInstallCache(agent)
  mkdirSync(shared, { recursive: true })
  const cache = input.seedCache ?? shared
  Object.assign(input.env, sandboxEnv(home, cache))
  return {
    argv: sandboxArgv({
      bwrap,
      home,
      // A self-installed binary has no bunx cache to mount.
      cache: agent.pkg === undefined ? undefined : cache,
      cacheWritable: input.seedCache !== undefined,
      workdir: input.workdir,
      argv: input.argv,
      readOnly: input.readOnly,
      writable: input.writable,
      sandboxMask: input.sandboxMask,
      netns: {
        pasta,
        ports: loopbackPorts([
          input.upstreamUrl,
          ...Object.values(input.env),
          ...Object.values(input.extraEnv ?? {}),
        ]),
      },
    }),
    home,
    cleanup: () => removeLaunchHome(home),
  }
}
