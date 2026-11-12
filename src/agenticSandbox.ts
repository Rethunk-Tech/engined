import { rmSync } from 'node:fs'
import type { AgentCli } from './agents.ts'
import {
  copyLogins,
  resolveBwrap,
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
  seedCache: boolean
  /** Paths the launch was handed, shown back through the masked home. */
  readOnly: readonly string[]
  writable?: readonly string[]
  /** tmpfs'd before the workdir bind; omitted uses the config default. */
  sandboxMask?: readonly string[]
}

/** The one reading of "this box has no bwrap": `null`, and the empty string an override may spell it as. */
export function usableBwrap(override?: string | null): string | null {
  const bwrap = override === undefined ? resolveBwrap() : override
  return bwrap === null || bwrap === '' ? null : bwrap
}

/** `argv` wrapped under bwrap, the launch home's env merged into `env` in place -- or `null` when this box has no bwrap to wrap it with. */
export function applySandboxFloor(
  agent: AgentCli,
  input: SandboxFloorInput,
): { argv: string[]; cleanup: () => void } | null {
  const bwrap = usableBwrap(input.bwrapOverride)
  if (bwrap === null) {
    return null
  }
  const home = sandboxLaunchHome(agent.id)
  copyLogins(home, agent.logins ?? [])
  const cache = agent.installCache?.() ?? sandboxHome(agent.id)
  Object.assign(input.env, sandboxEnv(home, cache))
  return {
    argv: sandboxArgv({
      bwrap,
      home,
      // A self-installed binary has no bunx cache to mount.
      cache: agent.pkg === undefined ? undefined : cache,
      cacheWritable: input.seedCache,
      workdir: input.workdir,
      argv: input.argv,
      readOnly: input.readOnly,
      writable: input.writable,
      sandboxMask: input.sandboxMask,
    }),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  }
}
