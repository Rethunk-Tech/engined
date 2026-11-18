import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDaemon } from './daemon.ts'
import type { Door } from './doorContext.ts'
import { assignEnv, clearEnv, envString } from './env.ts'
import { FatalError } from './errors/fatal.ts'
import type { ServedPorts } from './servedPorts.ts'
import { BUNX, config as configFixture, deadPort, makeTestRoot } from './test-support.ts'
import type { Config } from './types.ts'

const TEST_ROOT = makeTestRoot('engined-daemon-')
const silence = (): void => undefined

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => Promise<T> | T,
): Promise<T> {
  const previous = Object.keys(vars).map((name) => [name, envString(name)] as const)
  for (const [name, value] of Object.entries(vars)) {
    if (value === undefined) {
      clearEnv(name)
    } else {
      assignEnv(name, value)
    }
  }
  try {
    return await body()
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        clearEnv(name)
      } else {
        assignEnv(name, value)
      }
    }
  }
}

function scratch(toml: string): Record<string, string> {
  const base = mkdtempSync(join(TEST_ROOT, 'home-'))
  const configHome = join(base, 'config')
  const dataHome = join(base, 'data')
  const stateHome = join(base, 'state')
  mkdirSync(join(configHome, 'engined'), { recursive: true })
  mkdirSync(join(dataHome, 'engined', 'engines'), { recursive: true })
  writeFileSync(join(configHome, 'engined', 'config.toml'), toml)
  return {
    XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: dataHome,
    XDG_STATE_HOME: stateHome,
    ENGINED_INSTALL_DIR: join(dataHome, 'engined'),
  }
}

function fakeDoor(opts: {
  listen: number
  cursor?: number
  live?: boolean
  config?: Config
  reload?: Door['reload']
  shutdown?: () => Promise<void>
  interrupt?: () => void
  startInventory?: () => void
  startDiscovery?: (next: Config) => void
}): Door {
  const served: ServedPorts = { listen: opts.listen }
  const cfg =
    opts.config ??
    configFixture({
      listen_port: opts.listen,
      cursor_port: opts.cursor ?? opts.listen + 1,
    })
  return {
    fetch: () => new Response('ok'),
    reload: opts.reload ?? (() => undefined),
    live: () => opts.live === true,
    served,
    interrupt: opts.interrupt ?? (() => undefined),
    registry: {
      startInventoryRefresh: opts.startInventory ?? (() => undefined),
      shutdown: opts.shutdown ?? (async () => undefined),
    },
    ctx: {
      getConfig: () => cfg,
      doorOpts: {},
      usage: { shutdown: () => undefined },
    },
    discovery: { start: opts.startDiscovery ?? (() => undefined) },
    configError: () => undefined,
  } as unknown as Door
}

const realExit = process.exit.bind(process)
const realErr = process.stderr.write.bind(process.stderr)
const exits: number[] = []
let err: string[] = []
let exitThrows = true

beforeEach(() => {
  exits.length = 0
  err = []
  exitThrows = true
  process.exit = ((code?: number) => {
    exits.push(code ?? 0)
    if (exitThrows) {
      throw new Error(`exit ${code ?? 0}`)
    }
  }) as typeof process.exit
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    err.push(String(s))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.exit = realExit
  process.stderr.write = realErr
})

test('a valid config that is not yet live binds and stops without starting the cursor', async () => {
  const listen = deadPort()
  const env = scratch(`listen_port = ${listen}\n`)
  exitThrows = false
  await withEnv(env, async () => {
    const events: string[] = []
    const door = fakeDoor({
      listen,
      shutdown: async () => {
        events.push('shutdown')
      },
      startInventory: () => {
        events.push('inventory')
      },
    })
    const before = {
      SIGHUP: process.listeners('SIGHUP').slice(),
      SIGUSR1: process.listeners('SIGUSR1').slice(),
      SIGTERM: process.listeners('SIGTERM').slice(),
    }
    runDaemon({
      resolveBunx: () => BUNX,
      createDoor: () => door,
    })
    expect(events).toEqual([])
    ;(process.listeners('SIGUSR1').at(-1) as () => void)()
    await Bun.sleep(20)
    ;(process.listeners('SIGTERM').at(-1) as () => void)()
    await Bun.sleep(30)
    expect(events).toContain('shutdown')
    expect(exits).toEqual([0])
    for (const event of ['SIGHUP', 'SIGUSR1', 'SIGTERM'] as const) {
      for (const listener of process.listeners(event)) {
        if (!before[event].includes(listener)) {
          process.removeListener(event, listener)
        }
      }
    }
  })
})

test('a bad config starts an awaiting door and a throwing createDoor exits 78', async () => {
  const listen = deadPort()
  const env = scratch('listen_port = "nope"\n')
  const awaiting: unknown[] = []
  exitThrows = false
  await withEnv(env, async () => {
    const handle = runDaemon({
      resolveBunx: () => BUNX,
      createDoor: (config, _opts, doorOpts) => {
        awaiting.push({ listen: config.listen_port, error: doorOpts?.awaitingConfigError })
        return fakeDoor({ listen })
      },
      on: silence,
    })
    expect(err.join('')).toContain('waiting for a valid config')
    expect(awaiting).toHaveLength(1)
    await handle.stop()
  })

  exitThrows = true
  const ok = scratch(`listen_port = ${deadPort()}\n`)
  await withEnv(ok, () => {
    expect(() =>
      runDaemon({
        resolveBunx: () => BUNX,
        createDoor: () => {
          throw new Error('refused')
        },
        on: silence,
      }),
    ).toThrow('exit 78')
    expect(exits.at(-1)).toBe(FatalError.EXIT_CODE)
    expect(err.join('')).toContain('engined: refused')
  })
})

test('a port already in use or unbindable exits 78', async () => {
  const listen = deadPort()
  const blocker = Bun.serve({
    hostname: '::',
    port: listen,
    fetch: () => new Response(''),
  })
  try {
    const env = scratch(`listen_port = ${deadPort()}\n`)
    await withEnv(env, () => {
      expect(() =>
        runDaemon({
          resolveBunx: () => BUNX,
          createDoor: () => fakeDoor({ listen }),
          on: silence,
        }),
      ).toThrow('exit 78')
    })
    expect(exits.at(-1)).toBe(FatalError.EXIT_CODE)
    expect(err.join('')).toContain('already in use')
  } finally {
    blocker.stop(true)
  }

  const env = scratch(`listen_port = ${deadPort()}\n`)
  await withEnv(env, () => {
    expect(() =>
      runDaemon({
        resolveBunx: () => BUNX,
        createDoor: () => fakeDoor({ listen: 1 }),
        on: silence,
      }),
    ).toThrow('exit 78')
  })
  expect(err.join('')).toContain('cannot listen')
})

test('a live door starts inventory and cursor, then hangup, hard reload, and a nested hard reload', async () => {
  const listen = deadPort()
  const cursor = deadPort()
  const nextListen = deadPort()
  const nextCursor = deadPort()
  const env = scratch(`listen_port = ${listen}\ncursor_port = ${cursor}\n`)
  const events: string[] = []
  let hold: Promise<void> | undefined
  let releaseHold: () => void = () => undefined
  exitThrows = false
  await withEnv(env, async () => {
    const cfg = configFixture({ listen_port: listen, cursor_port: cursor })
    const door = fakeDoor({
      listen,
      cursor,
      live: true,
      config: cfg,
      startInventory: () => {
        events.push('inventory')
      },
      startDiscovery: () => {
        events.push('discovery')
      },
      interrupt: () => {
        events.push('interrupt')
      },
      shutdown: async () => {
        events.push('shutdown')
        if (hold !== undefined) {
          await hold
        }
      },
      reload: (_path, rebind) => {
        events.push(rebind === undefined ? 'hangup' : 'hard')
        rebind?.(configFixture({ listen_port: nextListen, cursor_port: nextCursor }))
      },
    })
    const handle = runDaemon({
      resolveBunx: () => BUNX,
      createDoor: () => door,
      on: silence,
    })
    expect(events).toEqual(['inventory', 'discovery'])
    expect(door.served.cursor).toBe(cursor)

    handle.hangup()
    expect(events).toContain('hangup')

    await handle.hardReload()
    expect(events.filter((e) => e === 'interrupt').length).toBe(1)
    expect(door.served.listen).toBe(nextListen)
    expect(door.served.cursor).toBe(nextCursor)

    hold = new Promise<void>((resolve) => {
      releaseHold = resolve
    })
    const first = handle.hardReload()
    await Bun.sleep(20)
    await handle.hardReload()
    releaseHold()
    await first
    expect(events.filter((e) => e === 'interrupt').length).toBe(2)

    door.registry.shutdown = async () => {
      throw new Error('nope')
    }
    await handle.hardReload()
    expect(err.join('')).toContain('hard reload failed')
    await handle.stop()
    expect(err.join('')).toContain('shutdown failed')
    door.registry.shutdown = async () => undefined
    await handle.stop()
  })
})
