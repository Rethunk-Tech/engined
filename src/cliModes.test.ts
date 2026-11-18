import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { enginesExit, probeExit } from './cliModes.ts'
import { assignEnv, clearEnv, envString } from './env.ts'
import { FatalError } from './errors/fatal.ts'
import { CONTRACT } from './responses.ts'
import { OPENAI_MODELS_PATH } from './routeServes.ts'
import { deadPort, makeTestRoot } from './test-support.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

const TEST_ROOT = makeTestRoot('engined-cli-modes-')

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

function configHomeFor(toml: string): string {
  const configHome = join(mkdtempSync(join(TEST_ROOT, 'home-')), 'config')
  mkdirSync(join(configHome, 'engined'), { recursive: true })
  writeFileSync(join(configHome, 'engined', 'config.toml'), toml)
  return configHome
}

let out: string[] = []
let err: string[] = []
const realOut = process.stdout.write.bind(process.stdout)
const realErr = process.stderr.write.bind(process.stderr)

beforeEach(() => {
  out = []
  err = []
  process.stdout.write = ((s: string | Uint8Array): boolean => {
    out.push(String(s))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((s: string | Uint8Array): boolean => {
    err.push(String(s))
    return true
  }) as typeof process.stderr.write
})

afterEach(() => {
  process.stdout.write = realOut
  process.stderr.write = realErr
})

test('enginesExit and probeExit refuse when the config does not load', async () => {
  const configHome = configHomeFor('listen_port = "nope"\n')
  await withEnv({ XDG_CONFIG_HOME: configHome }, async () => {
    expect(await enginesExit()).toBe(FatalError.EXIT_CODE)
    expect(await probeExit(false)).toBe(FatalError.EXIT_CODE)
  })
  expect(err.join('')).toContain('engined:')
})

test('enginesExit reports an unreachable door, an http error, and a config_error', async () => {
  const missed = deadPort()
  await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${missed}\n`) }, async () => {
    expect(await enginesExit()).toBe(1)
  })
  expect(err.join('')).toContain('the door could not be reached')

  const failing = Bun.serve({
    port: 0,
    fetch: () => new Response('nope', { status: 503 }),
  })
  try {
    const port = failing.port
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    err = []
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      expect(await enginesExit()).toBe(1)
    })
    expect(err.join('')).toContain('http 503')
  } finally {
    failing.stop(true)
  }

  const configError = 'config.d/scratch.toml: expected a value'
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path === ENGINED_ENGINES_PATH) {
        return Response.json({
          contract: CONTRACT,
          engines: [{ id: 'local-llama' }],
          config_error: configError,
        })
      }
      return new Response('unhandled', { status: 404 })
    },
  })
  try {
    const port = server.port
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    out = []
    err = []
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      expect(await enginesExit()).toBe(0)
    })
    expect(out.join('')).toContain('"id":"local-llama"')
    expect(err.join('')).toBe(`engined: ${configError}\n`)
  } finally {
    server.stop(true)
  }
})

test('enginesExit strips one trailing newline and ignores a non-string or unparsed config_error', async () => {
  const junk = Bun.serve({
    port: 0,
    fetch: () => new Response('not-json'),
  })
  try {
    const port = junk.port
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    out = []
    err = []
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      expect(await enginesExit()).toBe(0)
    })
    expect(out.join('')).toBe('not-json\n')
    expect(err.join('')).toBe('')
  } finally {
    junk.stop(true)
  }

  const server = Bun.serve({
    port: 0,
    fetch: () => new Response('{"engines":[]}\n\n'),
  })
  try {
    const port = server.port
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    out = []
    err = []
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      expect(await enginesExit()).toBe(0)
    })
    expect(out.join('')).toBe('{"engines":[]}\n\n')
  } finally {
    server.stop(true)
  }

  const noisy = Bun.serve({
    port: 0,
    fetch: () => Response.json({ engines: [], config_error: 12 }),
  })
  try {
    const port = noisy.port
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    out = []
    err = []
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      expect(await enginesExit()).toBe(0)
    })
    expect(out.join('')).toContain('"engines":[]')
    expect(err.join('')).toBe('')
  } finally {
    noisy.stop(true)
  }
})

test('probeExit prints text, json, and a failing door', async () => {
  await withDoor(200, async (port) => {
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      out = []
      expect(await probeExit(false)).toBe(0)
      expect(out.join('')).toBe(`ok http://127.0.0.1:${port}: no reachable address to prove\n`)
      out = []
      expect(await probeExit(true)).toBe(0)
      const parsed = JSON.parse(out.join('')) as { schema: number; ok: boolean }
      expect(parsed.schema).toBe(1)
      expect(parsed.ok).toBe(true)
    })
  })

  await withDoor(503, async (port) => {
    await withEnv({ XDG_CONFIG_HOME: configHomeFor(`listen_port = ${port}\n`) }, async () => {
      out = []
      expect(await probeExit(false)).toBe(1)
      expect(out.join('')).toContain('FAIL')
      expect(out.join('')).toContain('http 503')
    })
  })
})

async function withDoor(menuStatus: number, fn: (port: number) => Promise<void>): Promise<void> {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === OPENAI_MODELS_PATH) {
        return menuStatus === 200
          ? Response.json({ object: 'list', data: [] })
          : new Response('unavailable', { status: menuStatus })
      }
      if (path === ENGINED_ENGINES_PATH) {
        return Response.json({ contract: CONTRACT, engines: [] })
      }
      return new Response('unhandled', { status: 404 })
    },
  })
  try {
    const port = server.port
    if (port === undefined) {
      throw new Error('the fake door did not bind a port')
    }
    await fn(port)
  } finally {
    server.stop(true)
  }
}
