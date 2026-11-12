import { envString } from './env.ts'

/** Per-agent cgroup ceiling: a claude CLI peaks near 1 GiB, and the door's own MemoryMax must not be shared with it. */
export const AGENT_MEMORY_MAX = '2G'

let warnedNoScope = false

/**
 * Wraps a launch in its own transient systemd scope so an agent's memory is
 * charged to it, not to the door's unit: one runaway agent is OOM-killed alone
 * instead of taking the door (and every other agent) down with it. systemd-run
 * execs the command in place, so the pid and process group stay the child's.
 */
export function scopedArgv(argv: string[], systemdRun: string | null): string[] {
  if (systemdRun === null) {
    if (!warnedNoScope) {
      warnedNoScope = true
      process.stderr.write(
        'engined: systemd-run not found; agents share the door cgroup and its MemoryMax\n',
      )
    }
    return argv
  }
  return [
    systemdRun,
    '--user',
    '--scope',
    '--quiet',
    '--collect',
    '-p',
    `MemoryMax=${AGENT_MEMORY_MAX}`,
    '-p',
    'MemorySwapMax=0',
    '--',
    ...argv,
  ]
}

/** The one variable `systemd-run --user` needs to reach the user manager. */
export function scopeEnv(env: Record<string, string>): Record<string, string> {
  const runtime = envString('XDG_RUNTIME_DIR')
  return runtime === undefined ? env : { XDG_RUNTIME_DIR: runtime, ...env }
}
