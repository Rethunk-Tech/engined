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

/** The collector bound to one binary, which is the only thing that varies between callers. */
export function binExec(bin: string): Exec {
  return async (args) => {
    let proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>
    try {
      proc = Bun.spawn([bin, ...args], { stdout: 'pipe', stderr: 'pipe' })
    } catch {
      return { stdout: '', stderr: '', exitCode: 1 }
    }
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, exitCode }
  }
}
