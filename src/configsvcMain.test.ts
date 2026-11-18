import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { configsvcMain } from './configsvcMain.ts'
import { assignEnv, clearEnv, envString } from './env.ts'
import { FatalError } from './errors/fatal.ts'
import { deadPort, makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-configsvc-main-')
const cwd = process.cwd()
const realErr = process.stderr.write.bind(process.stderr)

async function withEnv<T>(
  vars: Record<string, string | undefined>,
  body: () => Promise<T>,
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

afterEach(() => {
  process.chdir(cwd)
  process.stderr.write = realErr
})

test('configsvcMain exits 0 when the UI is not enabled', async () => {
  const env = scratch('listen_port = 29200\n')
  const lines: string[] = []
  await withEnv(env, async () => {
    expect(await configsvcMain((line) => lines.push(line))).toBe(0)
  })
  expect(lines.join('\n')).toContain('not enabled')
})

test('a config that does not load still starts the UI so it can be repaired', async () => {
  const env = scratch(`
listen_port = 1
cursor_port = 1
[configsvc]
host = "box.example"
port = 0
password_hash = "$argon2id$not-verified-here"
`)
  const lines: string[] = []
  let err = ''
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    err += String(s)
    return true
  }) as typeof process.stderr.write
  await withEnv(env, async () => {
    const pending = configsvcMain((line) => lines.push(line))
    for (let i = 0; i < 50 && lines.length === 0; i++) {
      await Bun.sleep(10)
    }
    const term = process.listeners('SIGTERM').at(-1) as () => void
    term()
    expect(await pending).toBe(0)
    process.removeListener('SIGTERM', term)
  })
  expect(err).toContain('starting anyway so it can be repaired')
  expect(lines.join('\n')).toContain('https://box.example:29444/')
})

test('an enabled configsvc that cannot bind its port exits 78', async () => {
  const taken = deadPort()
  const blocker = Bun.serve({
    hostname: '127.0.0.1',
    port: taken,
    fetch: () => new Response(''),
  })
  try {
    const env = scratch(`
listen_port = 29200
cursor_port = 29201
[configsvc]
enable = true
port = ${taken}
`)
    let err = ''
    process.stderr.write = ((s: string | Uint8Array): boolean => {
      err += String(s)
      return true
    }) as typeof process.stderr.write
    await withEnv(env, async () => {
      expect(await configsvcMain((line) => line)).toBe(FatalError.EXIT_CODE)
    })
    expect(err).toContain('already in use')
  } finally {
    blocker.stop(true)
  }

  const env = scratch(`
listen_port = 29200
cursor_port = 29201
[configsvc]
enable = true
port = 1
`)
  let err = ''
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    err += String(s)
    return true
  }) as typeof process.stderr.write
  await withEnv(env, async () => {
    expect(await configsvcMain((line) => line)).toBe(FatalError.EXIT_CODE)
  })
  expect(err).toContain('cannot listen')
})
