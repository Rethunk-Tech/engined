/**
 * One subprocess collector. A command's stdout and stderr are accumulated to
 * completion and the exit code reported; a spawn that never starts reports 1
 * rather than throwing, because every caller here treats "did not run" and
 * "ran and failed" the same way.
 */
export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
}

export type Exec = (args: readonly string[]) => Promise<ExecResult>

/**
 * Long enough for the slowest thing engined asks of either binary -- a `docker
 * stop` waits out the container's own grace, a `docker run` creates one -- and
 * short enough that a wedged dockerd or Secret Service cannot hang a request.
 */
const EXEC_TIMEOUT_MS = 120_000

/** `timeout(1)`'s own code for a command it had to kill. */
const EXIT_TIMED_OUT = 124

/** The collector bound to one binary, which is the only thing that varies between callers. */
export function binExec(bin: string, timeoutMs: number = EXEC_TIMEOUT_MS): Exec {
  return async (args) => {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([bin, ...args], {
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
      })
    } catch {
      return { stdout: '', stderr: '', exitCode: 1 }
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    if (proc.signalCode === 'SIGKILL') {
      return {
        stdout,
        stderr: `${bin} ${args[0] ?? ''} timed out after ${timeoutMs} ms`,
        exitCode: EXIT_TIMED_OUT,
      }
    }
    return { stdout, stderr, exitCode }
  }
}
