import { mkdirSync, rmSync } from 'node:fs'
import process from 'node:process'
import { join } from 'node:path'
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
  seedCache: boolean
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

let warnedNoPasta = false

function warnNoPasta(): void {
  if (!warnedNoPasta) {
    warnedNoPasta = true
    process.stderr.write(
      'engined: pasta not found; agents share the host network namespace (abstract X11 sockets and loopback services are reachable). Install passt.\n',
    )
  }
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
      process.stderr.write(`engined: agent launch home ${home} could not be removed: ${String(err)}\n`)
    }
  }
}

/** `argv` wrapped under bwrap, the launch home's env merged into `env` in place -- or `null` when this box has no bwrap to wrap it with. */
export function applySandboxFloor(
  agent: AgentCli,
  input: SandboxFloorInput,
): { argv: string[]; home: string; cleanup: () => void } | null {
  const bwrap = usableBwrap(input.bwrapOverride)
  if (bwrap === null) {
    return null
  }
  const home = sandboxLaunchHome(agent.id)
  copyLogins(home, agent.logins ?? [])
  const pasta = input.pasta === undefined ? resolvePasta() : input.pasta
  if (pasta === null || pasta === '') {
    warnNoPasta()
  }
  const cache = agent.installCache?.() ?? join(sandboxHome(agent.id), SANDBOX_BUN_DIR)
  mkdirSync(cache, { recursive: true })
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
      netns:
        pasta === null || pasta === ''
          ? undefined
          : {
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
