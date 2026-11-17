/**
 * The table-shape refusals in `configParse.ts`, `configRoutes.ts`,
 * `configUpstream.ts` and `configSources.ts` that `config.test.ts` reaches only
 * through `loadConfig()` (or not at all): each is a fatal parse, so the same
 * message has to come out whether it is reached from the file loader or called
 * directly.
 */
import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadConfig } from './config.ts'
import { declaredHops, parseChainRaw } from './configChains.ts'
import { asArray, requireTable } from './configParse.ts'
import { parseRouteRaw, specFactsFor } from './configRoutes.ts'
import {
  collectEntries,
  configFilesSha256,
  configTextSha256,
  inEntry,
  readConfigSources,
} from './configSources.ts'
import { parsePotluckCallback, parseUpstreamHeaders, readFingerprint } from './configUpstream.ts'
import { ParseError } from './errors/parse.ts'
import { makeTestRoot } from './test-support.ts'

const TEST_ROOT = makeTestRoot('engined-config-tables-')
const FILE = 'config.toml'
const SITE = 'route[0] on engine "e"'
const NO_KEYS = new Set<string>()

function scratch(prefix: string): string {
  return mkdtempSync(join(TEST_ROOT, prefix))
}

function configDir(toml: string): string {
  const dir = scratch('cfg-')
  writeFileSync(join(dir, 'config.toml'), toml)
  return dir
}

describe('requireTable', () => {
  test('a scalar or array in a table position is refused, not coerced', () => {
    expect(() => requireTable('x', SITE, NO_KEYS, FILE)).toThrow(ParseError)
    expect(() => requireTable('x', SITE, NO_KEYS, FILE)).toThrow(`${SITE} must be a table`)
    expect(() => requireTable([{ a: 1 }], SITE, NO_KEYS, FILE)).toThrow(`${SITE} must be a table`)
    expect(() => requireTable(null, SITE, NO_KEYS, FILE)).toThrow(`${SITE} must be a table`)
  })

  test('a table is returned unchanged once its keys are known', () => {
    expect(requireTable({ a: 1 }, SITE, new Set(['a']), FILE)).toEqual({ a: 1 })
    expect(() => requireTable({ b: 1 }, SITE, new Set(['a']), FILE)).toThrow(
      `${SITE} has unrecognised key "b"`,
    )
  })
})

describe('asArray', () => {
  test('absent is no entries; a present non-array is fatal', () => {
    expect(asArray(undefined, 'engine', FILE)).toEqual([])
    expect(() => asArray({ a: 1 }, 'engine', FILE)).toThrow('"engine" must be an array of tables')
  })
})

describe('route tables', () => {
  const engine = { id: 'e', args: {}, env: {}, volumes: [] } as never
  const engines = new Map([['e', engine]])

  test('set_params must be a table of scalars', () => {
    expect(() => parseRouteRaw({ engine: 'e', set_params: 'x' }, 0, FILE, engines)).toThrow(
      `${SITE} "set_params" must be a table`,
    )
    expect(() =>
      parseRouteRaw({ engine: 'e', set_params: { nested: { a: 1 } } }, 0, FILE, engines),
    ).toThrow(`${SITE} "set_params" key "nested" must be a string, number or boolean`)
  })

  test('log accepts only "summary"', () => {
    expect(() => parseRouteRaw({ engine: 'e', log: 'full' }, 0, FILE, engines)).toThrow(
      `${SITE} has invalid "log" "full"`,
    )
    expect(parseRouteRaw({ engine: 'e', log: 'summary' }, 0, FILE, engines).log).toBe('summary')
  })

  test('role must be one the door serves', () => {
    expect(() => parseRouteRaw({ engine: 'e', role: 'translate' }, 0, FILE, engines)).toThrow(
      `${SITE} has invalid "role" "translate"`,
    )
  })

  test('a route naming an engine the config never declared is fatal', () => {
    expect(() => parseRouteRaw({ engine: 'nope' }, 0, FILE, engines)).toThrow(
      'route[0] on engine "nope" names unknown engine "nope"',
    )
  })
})

describe('the config file itself', () => {
  test('an unrecognised engine kind is named rather than carrying an empty trait', () => {
    const dir = configDir('[[engine]]\nid = "e"\nkind = "grpc"\n')
    expect(() => loadConfig(join(dir, 'config.toml'))).toThrow(/has invalid "kind" "grpc"/)
  })

  test('an unrecognised upstream wire is named', () => {
    const dir = configDir(
      '[[upstream]]\nid = "u"\nbase_url = "https://x.invalid/v1"\negress = "remote"\nwire = "grpc"\n',
    )
    expect(() => loadConfig(join(dir, 'config.toml'))).toThrow(/has invalid "wire" "grpc"/)
  })

  test('exclude_models holding a non-string is a shape error, not a regex failure', () => {
    const dir = configDir(
      '[[upstream]]\nid = "u"\nbase_url = "https://x.invalid/v1"\negress = "remote"\nexclude_models = ["ok", 7]\n',
    )
    expect(() => loadConfig(join(dir, 'config.toml'))).toThrow(
      /"exclude_models" must be an array of strings/,
    )
  })
})

describe('upstream headers', () => {
  test('a non-table headers value is refused', () => {
    expect(() => parseUpstreamHeaders(['X-A: 1'], 'upstream "u"', FILE, undefined)).toThrow(
      'upstream "u" "headers" must be a table',
    )
    expect(parseUpstreamHeaders(undefined, 'upstream "u"', FILE, undefined)).toBeUndefined()
  })

  test('every value must be a string, and the header names kept as written', () => {
    expect(() => parseUpstreamHeaders({ 'X-Trace': 7 }, 'upstream "u"', FILE, undefined)).toThrow(
      'upstream "u" "headers" key "X-Trace" must be a string',
    )
    expect(parseUpstreamHeaders({ 'X-Trace': 'on' }, 'upstream "u"', FILE, undefined)).toEqual({
      'X-Trace': 'on',
    })
  })

  test('a header colliding with the secret header under any casing is refused', () => {
    expect(() =>
      parseUpstreamHeaders({ 'x-api-key': 'leak' }, 'upstream "u"', FILE, 'X-Api-Key'),
    ).toThrow('must not set "x-api-key"')
  })
})

describe('the potluck callback table', () => {
  test('absent is nothing to call', () => {
    expect(parsePotluckCallback({}, FILE)).toBeUndefined()
  })

  test('a table missing its callback_url is refused', () => {
    expect(() =>
      parsePotluckCallback({ potluck: { callback_secret: { service: 's', username: 'u' } } }, FILE),
    ).toThrow(/callback_url" is missing or empty/)
  })

  test('an unrecognised key under potluck is a typo named at parse', () => {
    expect(() =>
      parsePotluckCallback(
        {
          potluck: {
            callback_url: 'https://x.invalid/cb',
            callback_secrets: { service: 's', username: 'u' },
          },
        },
        FILE,
      ),
    ).toThrow(/config "potluck" has unrecognised key "callback_secrets"/)
  })
})

describe('upstream fingerprint', () => {
  test('a fingerprint that is not 64 lowercase hex characters is refused', () => {
    expect(readFingerprint('a'.repeat(64), 'upstream "u"', FILE)).toBe('a'.repeat(64))
    expect(readFingerprint(undefined, 'upstream "u"', FILE)).toBeUndefined()
    expect(() => readFingerprint('A'.repeat(64), 'upstream "u"', FILE)).toThrow(
      /"fingerprint" must be 64 hex characters/,
    )
    expect(() => readFingerprint(7, 'upstream "u"', FILE)).toThrow(/must be a string/)
  })
})

describe('a spec-full engine whose spec cannot be read', () => {
  test('the failure names the spec file and the engine', () => {
    const enginesRoot = scratch('engines-')
    const engine = { id: 'custom', args: {}, env: {}, volumes: [] } as never
    expect(() => specFactsFor(engine, enginesRoot)).toThrow(
      /spec\.toml: engine "custom": cannot read its spec to resolve an upstream trait/,
    )
  })

  test('a spec missing a valid "upstream" trait is refused by name', () => {
    const enginesRoot = scratch('engines-')
    mkdirSync(join(enginesRoot, 'custom'))
    writeFileSync(join(enginesRoot, 'custom', 'spec.toml'), 'kind = "container"\n')
    const engine = { id: 'custom', args: {}, env: {}, volumes: [] } as never
    expect(() => specFactsFor(engine, enginesRoot)).toThrow(
      /spec is missing required "upstream" \("self"\|"optional"\|"required"\)/,
    )
  })
})

describe('chain tables', () => {
  test('a chain with no hops is refused rather than serving nothing', () => {
    expect(() => parseChainRaw({ id: 'c', hops: [] }, 0, FILE)).toThrow('chain "c" has no hops')
  })

  test('a hop list carrying the written form reports that form, and a hand-built one reports its leaves', () => {
    const written = Object.assign(['@/a/x'], { declared_hops: ['@/a/x', '@/b/y'] })
    expect(declaredHops(written)).toEqual(['@/a/x', '@/b/y'])
    expect(declaredHops(['@/a/x'])).toEqual(['@/a/x'])
    const malformed = Object.assign(['leaf'], { declared_hops: [1] })
    expect(declaredHops(malformed)).toEqual(['leaf'])
  })
})

describe('config sources', () => {
  test('the text digest is order-sensitive and joins files with a NUL', () => {
    expect(configTextSha256(['a', 'b'])).not.toBe(configTextSha256(['b', 'a']))
    expect(configTextSha256(['ab'])).not.toBe(configTextSha256(['a', 'b']))
  })

  test('a missing main file has no digest rather than throwing', () => {
    expect(configFilesSha256(join(scratch('cfg-'), 'absent.toml'))).toBeUndefined()
  })

  test('invalid TOML is a ParseError, not a raw parser throw', () => {
    const path = join(configDir('[[engine]\nid = "e"\n'), 'config.toml')
    expect(() => readConfigSources(path)).toThrow(/invalid TOML/)
  })

  test('a fragment scalar is refused: only the five arrays may be extended there', () => {
    const dir = configDir('')
    mkdirSync(join(dir, 'config.d'))
    writeFileSync(join(dir, 'config.d', 'x.toml'), 'listen_port = 29201\n')
    expect(() => readConfigSources(join(dir, 'config.toml'))).toThrow(
      /config\.d fragment has unrecognised key "listen_port"/,
    )
  })

  test('a config.d that is a file rather than a directory is an error, not a silent zero fragments', () => {
    const dir = configDir('')
    writeFileSync(join(dir, 'config.d'), '')
    expect(() => readConfigSources(join(dir, 'config.toml'))).toThrow(/cannot read config\.d/)
  })

  test('an unreadable config file is a ParseError naming it', () => {
    const path = join(configDir(''), 'config.toml')
    writeFileSync(path, '[[engine]]\nid = "e"\n')
    chmodSync(path, 0o000)
    try {
      expect(() => readConfigSources(path)).toThrow(/cannot read config/)
    } finally {
      chmodSync(path, 0o644)
    }
  })

  test('invalid TOML in a file not named .toml is still located by name alone', () => {
    const dir = scratch('cfg-')
    const path = join(dir, 'config.conf')
    writeFileSync(path, '[[engine]\n')
    // No positional suffix: only a `.toml` path can be re-loaded to find one.
    expect(() => readConfigSources(path)).toThrow(`${path}: invalid TOML: `)
  })

  test('collectEntries stamps the file and per-file index onto a refusal', () => {
    const sources = [
      { file: 'a.toml', raw: { engine: [{ id: 'one' }] }, text: '' },
      { file: 'b.toml', raw: { engine: [{ id: 'two' }] }, text: '' },
    ]
    expect(collectEntries(sources, 'engine', (value) => (value as { id: string }).id)).toEqual({
      items: ['one', 'two'],
      files: ['a.toml', 'b.toml'],
      indexes: [0, 0],
    })

    const thrown = (() => {
      try {
        collectEntries(sources, 'engine', () => {
          throw new ParseError('bad entry', { file: 'a.toml' })
        })
      } catch (err) {
        return err as ParseError
      }
      return
    })()
    expect(thrown?.path).toEqual({ file: 'a.toml', table: 'engine', index: 0 })
  })

  test('inEntry keeps a table already named by the parser', () => {
    const named = new ParseError('bad hop', { file: 'c.toml', table: 'chain', index: 3 })
    expect(() =>
      inEntry('chain', 0, () => {
        throw named
      }),
    ).toThrow(named)
    expect(named.path).toEqual({ file: 'c.toml', table: 'chain', index: 3 })
  })
})
