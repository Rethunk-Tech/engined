/**
 * Startup exit codes, proven by spawning `src/main.ts` rather than by calling
 * into it: the thing under test is what the process exits with, and only a
 * real spawn observes that. The unit carries `RestartPreventExitStatus=78`,
 * so an exit code of 1 here is not a cosmetic difference -- it is a restart
 * loop against a fault no restart can clear.
 */

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { FatalError } from './errors/fatal.ts'
import { deadPort, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-startup-test-')
const RX_RESTART_PREVENT_EXIT_STATUS = /^RestartPreventExitStatus=(\d+)$/m

/** An XDG pair that redirects both `configPath()` and `installDir()` at a scratch tree. */
function scratchHome(
  specBody: string,
  configBody: string,
): { XDG_CONFIG_HOME: string; XDG_DATA_HOME: string } {
  const base = mkdtempSync(join(TEST_ROOT, 'engined-startup-'))
  const configHome = join(base, 'config')
  const dataHome = join(base, 'data')
  mkdirSync(join(configHome, 'engined'), { recursive: true })
  mkdirSync(join(dataHome, 'engined', 'engines', 'probe'), { recursive: true })
  writeFileSync(join(configHome, 'engined', 'config.toml'), configBody)
  writeFileSync(join(dataHome, 'engined', 'engines', 'probe', 'spec.toml'), specBody)
  return { XDG_CONFIG_HOME: configHome, XDG_DATA_HOME: dataHome }
}

async function runDaemon(env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'main.ts')], {
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stderr = await new Response(proc.stderr).text()
  return { code: await proc.exited, stderr }
}

/** Polls `probe` until it answers something other than `undefined`; the daemon is a real process, so there is no event to await. */
async function eventually<T>(probe: () => Promise<T | undefined>): Promise<T | undefined> {
  for (let i = 0; i < 50; i++) {
    const got = await probe().catch(() => undefined)
    if (got !== undefined) {
      return got
    }
    await Bun.sleep(100)
  }
  return undefined
}

async function listing(port: number): Promise<{ config_error?: string } | undefined> {
  const res = await fetch(`http://127.0.0.1:${port}/engined/v1/engines`)
  return (await res.json()) as { config_error?: string }
}

const modelsStatus = (port: number) =>
  fetch(`http://127.0.0.1:${port}/openai/v1/models`).then((res) => res.status)

// A spec placeholder the config never supplies is a config fault found at
// construction. The daemon must not exit (an edit fixes it, a restart cannot):
// it binds listen_port and reports the fault as 503 and `config_error`. Then
// the same process proves the reload signals: SIGHUP loads the fixed config,
// refuses a moved listen_port naming SIGUSR1, and SIGUSR1 moves it.
test('a bad config leaves the door up; SIGHUP loads it, SIGUSR1 moves the port', async () => {
  const [first, second, cursor] = [deadPort(), deadPort(), deadPort()]
  const env = scratchHome(
    [
      'kind = "tts"',
      'upstream = "self"',
      'image = "probe:local"',
      'obtain = "build"',
      'serves = ["/openai/v1/audio/speech"]',
      'command = []',
      '',
      '[[volume]]',
      'name = "{models_dir}"',
      'path = "/models"',
      '',
      '[ready]',
      'path   = "/health"',
      'status = 200',
    ].join('\n'),
    [`listen_port = ${first}`, '', '[[engine]]', 'id     = "probe"'].join('\n'),
  )
  const configFile = join(env.XDG_CONFIG_HOME, 'engined', 'config.toml')
  const proc = Bun.spawn(['bun', join(import.meta.dir, 'main.ts')], {
    env: { ...process.env, ...env },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    const waiting = await eventually(() => listing(first))
    expect(waiting?.config_error).toContain('unresolved placeholder {models_dir}')
    expect(await modelsStatus(first)).toBe(503)

    writeFileSync(configFile, `listen_port = ${first}\ncursor_port = ${cursor}\n`)
    proc.kill('SIGHUP')
    expect(
      await eventually(async () => ((await modelsStatus(first)) === 200 ? true : undefined)),
    ).toBe(true)

    writeFileSync(configFile, `listen_port = ${second}\ncursor_port = ${cursor}\n`)
    proc.kill('SIGHUP')
    const refused = await eventually(async () => (await listing(first))?.config_error)
    expect(refused).toContain('kill -s USR1 engined.service')
    expect(await modelsStatus(first)).toBe(200)

    proc.kill('SIGUSR1')
    expect(
      await eventually(async () => ((await modelsStatus(second)) === 200 ? true : undefined)),
    ).toBe(true)
    expect((await listing(second))?.config_error).toBeUndefined()
    expect(await modelsStatus(first).catch(() => 'closed')).toBe('closed')
  } finally {
    proc.kill()
    await proc.exited
  }
})

// A port already bound (by anything, not necessarily another engined) is
// fatal rather than a restart-loop candidate -- proven live earlier this
// session by holding the real 29200 and starting the unit (status=78/CONFIG,
// NRestarts=0). 39219 here is a second, distinct scratch port from
// startup.test.ts's other test (39218) -- never 29200, which the real
// engined.service is bound to and serving on right now.
test('a port already bound at startup exits 78 naming the port, not a restart loop', async () => {
  const port = 39_219
  const holder = Bun.listen({
    hostname: '127.0.0.1',
    port,
    // Bun's runtime requires at least one of data/drain, despite both being
    // typed optional -- this listener only needs to occupy the port.
    socket: {
      data() {
        // never receives real traffic; the listener exists only to hold the port
      },
    },
  })
  try {
    const env = scratchHome(
      [
        'kind = "tts"',
        'upstream = "self"',
        'image = "probe:local"',
        'obtain = "build"',
        'serves = ["/openai/v1/audio/speech"]',
        'command = []',
        '',
        '[ready]',
        'path   = "/health"',
        'status = 200',
      ].join('\n'),
      [`listen_port = ${port}`, '', '[[engine]]', 'id     = "probe"'].join('\n'),
    )
    const { code, stderr } = await runDaemon(env)
    expect(code).toBe(FatalError.EXIT_CODE)
    expect(stderr).toContain(String(port))
    expect(stderr).toContain('already in use')
  } finally {
    holder.stop(true)
  }
})

// The unit's RestartPreventExitStatus and FatalError.EXIT_CODE are one fact
// split across two files that nothing else compares. Without this, changing
// the constant leaves every test green while every fatal fault becomes a
// restart loop -- the exact failure the exit code exists to prevent.
test('the unit template prevents restart on the same code FatalError exits with', () => {
  const unit = readFileSync(join(import.meta.dir, '../scripts/engined.service.in'), 'utf8')
  const match = unit.match(RX_RESTART_PREVENT_EXIT_STATUS)
  expect(match?.[1]).toBe(String(FatalError.EXIT_CODE))
})
