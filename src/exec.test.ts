/**
 * `binExec` against real subprocesses -- `sh` and `false` are always present,
 * so this proves the collector's own behaviour without a docker or network
 * dependency. Every caller treats "did not run" and "ran and failed" the
 * same way, which is the one thing worth pinning here.
 */
import { describe, expect, test } from 'bun:test'
import { binExec } from './exec.ts'

describe('binExec', () => {
  test('collects stdout, stderr and a non-zero exit code from a real command', async () => {
    const exec = binExec('sh')
    const res = await exec(['-c', 'echo out; echo err 1>&2; exit 3'])
    expect(res.stdout).toBe('out\n')
    expect(res.stderr).toBe('err\n')
    expect(res.exitCode).toBe(3)
  })

  test('a binary that does not exist reports exitCode 1 rather than throwing', async () => {
    const exec = binExec('engined-no-such-binary-xyz')
    const res = await exec([])
    expect(res).toEqual({ stdout: '', stderr: '', exitCode: 1 })
  })

  test('a command that outlives its deadline is killed and reported as a timeout, not awaited', async () => {
    const exec = binExec('sleep', 50)
    const start = Date.now()
    const res = await exec(['5'])
    expect(Date.now() - start).toBeLessThan(2000)
    expect(res.exitCode).toBe(124)
    expect(res.stderr).toContain('timed out')
  })
})
