import { basename } from 'node:path'
import { envString } from './env.ts'

/** Per-agent cgroup ceiling: a claude CLI peaks near 1 GiB, and the door's own MemoryMax must not be shared with it. */
const AGENT_MEMORY_MAX = '2G'

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

/**
 * pasta replaces stdio with /dev/null when it is a socket, and Bun's piped
 * stdio is a socketpair, so the child would read nothing and print nothing.
 * Real pipes carry the three streams across instead (a fifo is replaced too);
 * the shell's exit status is the child's.
 */
const PIPE_SHIM = `d=$(mktemp -d) || exit 125
trap 'rm -rf "$d"' EXIT
exec 3>&1 4>&2
{ cat | { "$@" 2>&1 1>&5; echo $? >"$d/rc"; } | cat >&4; } 5>&1 | cat >&3
read -r rc <"$d/rc" || rc=125
exit "$rc"`

/** `argv` unchanged unless it starts with pasta, which needs real pipes for stdio. */
export function pipedArgv(argv: string[]): string[] {
  return basename(argv[0] ?? '') === 'pasta' ? ['/bin/bash', '-c', PIPE_SHIM, '_', ...argv] : argv
}
