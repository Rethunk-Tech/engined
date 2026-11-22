/**
 * The tailnet half of the `Host` allowlist. Its own file because the probe's
 * cache is module state: a previous test in a shared file would have warmed
 * it, and what this proves is what the first request after boot sees.
 */
import { expect, test } from 'bun:test'
import { isAllowedHost } from './hostCheck.ts'

/**
 * The unit can boot before `tailscale` is up, so a probe that found nothing is
 * not this machine's final set of names. The spy is `Bun.spawnSync` itself,
 * answering the shapes a missing then a working `tailscale` return.
 *
 * Module state is shared with every other test file in a bun run, so the
 * clock starts far past any cache another file may have left behind.
 */
test('a tailnet name that appears after a failed probe is allowed on a later request', () => {
  const realSpawn = Bun.spawnSync
  const realNow = Date.now
  const answers = [
    { stdout: Buffer.from(''), exitCode: 1 },
    {
      stdout: Buffer.from(JSON.stringify({ Self: { DNSName: 'box.tailnet-1234.ts.net.' } })),
      exitCode: 0,
    },
  ]
  let probes = 0
  Bun.spawnSync = ((cmd: string[]) => {
    if (cmd[0] !== 'tailscale') {
      return realSpawn(cmd as never)
    }
    const answer = answers[Math.min(probes, answers.length - 1)] as (typeof answers)[number]
    probes += 1
    return { ...answer, stderr: Buffer.from('') }
  }) as typeof Bun.spawnSync
  // Past any cooldown a probe in another test file may have started, so this
  // file's first request is the one that probes.
  let clock = realNow() + 10 * 60_000
  Date.now = () => clock

  try {
    const tailnet = 'box.tailnet-1234.ts.net'
    expect(isAllowedHost(tailnet, [])).toBe(false)
    expect(probes).toBe(1)

    // Before the cooldown a missing name is not re-probed: a hostile `Host`
    // must not buy a `tailscale` spawn per request.
    clock += 1_000
    expect(isAllowedHost(tailnet, [])).toBe(false)
    expect(probes).toBe(1)

    clock += 60_000
    expect(isAllowedHost(tailnet, [])).toBe(true)
    expect(probes).toBe(2)
  } finally {
    Bun.spawnSync = realSpawn
    Date.now = realNow
  }
})
