import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Exec, ExecResult } from './exec.ts'
import {
  clearSecret,
  ENGINED_KEYRING_SERVICE,
  resolveSecret,
  seedLegacySecrets,
  storeSecret,
} from './secrets.ts'
import type { SecretRef } from './types.ts'

const REF: SecretRef = { service: 'engined-test', username: 'alice', header: 'Authorization' }

function fakeExec(result: ExecResult, captured?: { args?: readonly string[] }): Exec {
  return (args) => {
    if (captured) {
      captured.args = args
    }
    return Promise.resolve(result)
  }
}

describe('resolveSecret', () => {
  test('resolved secret returns ok: true', async () => {
    const outcome = await resolveSecret(
      REF,
      fakeExec({ stdout: 'sk-live-secret\n', stderr: '', exitCode: 0 }),
    )
    expect(outcome).toEqual({ ok: true, value: 'sk-live-secret' })
  })

  test('zero exit with empty output is not treated as resolved', async () => {
    const outcome = await resolveSecret(REF, fakeExec({ stdout: '', stderr: '', exitCode: 0 }))
    expect(outcome.ok).toBe(false)
  })

  test('missing entry returns reason missing with a secret-tool store fix', async () => {
    const outcome = await resolveSecret(REF, fakeExec({ stdout: '', stderr: '', exitCode: 1 }))
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      throw new Error('unreachable: the test expects !outcome.ok')
    }
    expect(outcome.reason).toBe('missing')
    expect(outcome.fix).toContain('secret-tool store')
  })

  test('locked keyring returns reason locked without a store command', async () => {
    const outcome = await resolveSecret(
      REF,
      fakeExec({
        stdout: '',
        stderr: 'secret-tool: Could not connect: No such file or directory\n',
        exitCode: 1,
      }),
    )
    expect(outcome.ok).toBe(false)
    if (outcome.ok) {
      throw new Error('unreachable: the test expects !outcome.ok')
    }
    expect(outcome.reason).toBe('locked')
    expect(outcome.fix).not.toContain('secret-tool store')
  })

  test('no failure outcome carries the resolved value', async () => {
    const secretValue = 'sk-super-secret-value'
    const missing = await resolveSecret(REF, fakeExec({ stdout: '', stderr: '', exitCode: 1 }))
    const locked = await resolveSecret(
      REF,
      fakeExec({ stdout: '', stderr: `error: ${secretValue}`, exitCode: 1 }),
    )
    expect(JSON.stringify(missing)).not.toContain(secretValue)
    expect(JSON.stringify(locked)).not.toContain(secretValue)
  })

  test('never constructs a command containing search', async () => {
    const captured: { args?: readonly string[] } = {}
    await resolveSecret(REF, fakeExec({ stdout: 'v', stderr: '', exitCode: 0 }, captured))
    expect(captured.args).toBeDefined()
    for (const arg of captured.args ?? []) {
      expect(arg).not.toBe('search')
    }
    expect((captured.args ?? []).join(' ')).not.toContain('search')
  })
})

/** An in-memory Secret Service behind `secret-tool`'s argv: `lookup` and `clear` match every item carrying all the given attributes. */
function fakeKeyring(items: Map<string, string>, calls: string[][]): Exec {
  const attrsOf = (args: readonly string[]): [string, string][] => {
    const pairs: [string, string][] = []
    for (let i = 0; i + 1 < args.length; i += 2) {
      pairs.push([args[i] as string, args[i + 1] as string])
    }
    return pairs
  }
  const matches = (item: string, want: [string, string][]) => {
    const have = new Map(JSON.parse(item) as [string, string][])
    return want.every(([k, v]) => have.get(k) === v)
  }
  return (args, stdin) => {
    calls.push([...args])
    const [verb, ...rest] = args
    const attrs = attrsOf(verb === 'store' ? rest.slice(1) : rest)
    if (verb === 'store') {
      items.set(JSON.stringify(attrs), stdin ?? '')
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
    }
    const hit = [...items.keys()].filter((item) => matches(item, attrs))
    if (verb === 'clear') {
      for (const item of hit) {
        items.delete(item)
      }
      return Promise.resolve({ stdout: '', stderr: '', exitCode: hit.length > 0 ? 0 : 1 })
    }
    const first = hit[0]
    return Promise.resolve(
      first === undefined
        ? { stdout: '', stderr: '', exitCode: 1 }
        : { stdout: items.get(first) ?? '', stderr: '', exitCode: 0 },
    )
  }
}

const itemKey = (attrs: Record<string, string>) => JSON.stringify(Object.entries(attrs))

describe('the engined keyring namespace', () => {
  const pendingFile = () => join(mkdtempSync(join(tmpdir(), 'keyring-')), 'keyring-legacy.json')
  const Chrome = { service: 'Chrome Safe Storage', username: 'Chrome' }
  const Openai = { service: 'openai-api', username: 'default' }
  const prefixed = (ref: { service: string; username: string }) =>
    itemKey({ service: ENGINED_KEYRING_SERVICE, name: ref.service, username: ref.username })

  test('a config naming a foreign item can neither read, store over nor clear it', async () => {
    const items = new Map([[itemKey(Chrome), 'chrome-master-key']])
    const calls: string[][] = []
    const exec = fakeKeyring(items, calls)
    const file = pendingFile()
    seedLegacySecrets({ upstreams: [] }, file)

    const read = await resolveSecret(Chrome, exec, file)
    expect(read.ok).toBe(false)
    expect(await storeSecret(Chrome, 'overwritten', exec, file)).toEqual({ ok: true })
    expect(await clearSecret(Chrome, exec, file)).toEqual({ ok: true })

    expect(items.get(itemKey(Chrome))).toBe('chrome-master-key')
    for (const call of calls) {
      expect(call.slice(call[0] === 'store' ? 2 : 1).slice(0, 2)).toEqual([
        'service',
        ENGINED_KEYRING_SERVICE,
      ])
    }
  })

  test('an existing engined secret moves under the prefix on first read, and the old item is never read again', async () => {
    const items = new Map([[itemKey(Openai), 'sk-legacy']])
    const calls: string[][] = []
    const exec = fakeKeyring(items, calls)
    const file = pendingFile()
    seedLegacySecrets({ upstreams: [{ secret: Openai }] }, file)
    // A config saved after the first run cannot widen what that run named.
    seedLegacySecrets({ upstreams: [{ secret: Chrome }] }, file)

    expect(await resolveSecret(Openai, exec, file)).toEqual({ ok: true, value: 'sk-legacy' })
    expect(items.get(prefixed(Openai))).toBe('sk-legacy')
    expect(items.get(itemKey(Openai))).toBe('sk-legacy')

    calls.length = 0
    expect(await resolveSecret(Openai, exec, file)).toEqual({ ok: true, value: 'sk-legacy' })
    expect(await clearSecret(Openai, exec, file)).toEqual({ ok: true })
    expect((await resolveSecret(Openai, exec, file)).ok).toBe(false)
    expect(items.get(itemKey(Openai))).toBe('sk-legacy')
    expect(calls.every((call) => call.includes(ENGINED_KEYRING_SERVICE))).toBe(true)

    items.set(itemKey(Chrome), 'chrome-master-key')
    expect((await resolveSecret(Chrome, exec, file)).ok).toBe(false)
  })

  test('a locked keyring leaves the move pending for the next read', async () => {
    const items = new Map([[itemKey(Openai), 'sk-legacy']])
    const file = pendingFile()
    seedLegacySecrets({ upstreams: [], potluck: { secret: Openai } }, file)
    const locked: Exec = () =>
      Promise.resolve({
        stdout: '',
        stderr: 'secret-tool: Cannot get secret of a locked object',
        exitCode: 1,
      })
    expect((await resolveSecret(Openai, locked, file)).ok).toBe(false)
    expect(await resolveSecret(Openai, fakeKeyring(items, []), file)).toEqual({
      ok: true,
      value: 'sk-legacy',
    })
  })

  test('a store before the first read wins over the old item, and a clear does not bring it back', async () => {
    const items = new Map([[itemKey(Openai), 'sk-legacy']])
    const exec = fakeKeyring(items, [])
    const file = pendingFile()
    seedLegacySecrets({ upstreams: [], potluck: { secret: Openai } }, file)
    expect(await storeSecret(Openai, 'sk-new', exec, file)).toEqual({ ok: true })
    expect(await resolveSecret(Openai, exec, file)).toEqual({ ok: true, value: 'sk-new' })
    expect(await clearSecret(Openai, exec, file)).toEqual({ ok: true })
    expect((await resolveSecret(Openai, exec, file)).ok).toBe(false)
  })

  test("a missing secret's fix stores it under the prefix", async () => {
    const outcome = await resolveSecret(Openai, fakeKeyring(new Map(), []), pendingFile())
    expect(outcome.ok ? '' : outcome.fix).toBe(
      "secret-tool store --label='engined openai-api/default' service engined name openai-api username default",
    )
  })
})
