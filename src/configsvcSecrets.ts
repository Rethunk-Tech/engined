/** The desktop keyring as the config UI uses it: presence checks and stores, never a read of the value. */
import { errMessage } from './records.ts'

/** Same ceiling `binExec` uses: a wedged Secret Service must not hang the UI. */
const SECRET_TOOL_TIMEOUT_MS = 120_000

export interface SecretTool {
  /** Whether an item exists: `secret-tool lookup` exits 0 with non-empty output. The output itself is dropped. */
  present: (service: string, username: string) => Promise<boolean>
  store: (
    service: string,
    username: string,
    value: string,
  ) => Promise<{ ok: boolean; error?: string }>
  /** Drops the item. Already-absent is success: `secret-tool clear` exits 1 with empty stderr when there is nothing to delete. */
  clear: (service: string, username: string) => Promise<{ ok: boolean; error?: string }>
}

export const secretTool: SecretTool = {
  async present(service, username) {
    try {
      const proc = Bun.spawn(['secret-tool', 'lookup', 'service', service, 'username', username], {
        stdout: 'pipe',
        stderr: 'ignore',
        timeout: SECRET_TOOL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      })
      const out = await new Response(proc.stdout).arrayBuffer()
      return (await proc.exited) === 0 && out.byteLength > 0
    } catch {
      return false
    }
  },
  async store(service, username, value) {
    try {
      // The value goes on stdin, never argv: argv is world-readable in /proc.
      const proc = Bun.spawn(
        ['secret-tool', 'store', `--label=${service}`, 'service', service, 'username', username],
        {
          stdin: 'pipe',
          stdout: 'ignore',
          stderr: 'pipe',
          timeout: SECRET_TOOL_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      )
      proc.stdin.write(value)
      await proc.stdin.end()
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      return code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `exit ${code}` }
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
  },
  async clear(service, username) {
    try {
      const proc = Bun.spawn(['secret-tool', 'clear', 'service', service, 'username', username], {
        stdout: 'ignore',
        stderr: 'pipe',
        timeout: SECRET_TOOL_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      })
      const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
      if (code === 0 || stderr.trim().length === 0) {
        return { ok: true }
      }
      return { ok: false, error: stderr.trim() || `exit ${code}` }
    } catch (err) {
      return { ok: false, error: errMessage(err) }
    }
  },
}
