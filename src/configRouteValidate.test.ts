/**
 * `config.test.ts` drives most of these checks end to end through
 * `loadConfig()`. This fills the branches nothing there reaches: a
 * `models_max` below the engine's real role count, two `keep_resident`
 * routes colliding on one role, a `filename` that escapes `models_dir`, and
 * a wildcard route naming no upstream at all.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  validateFilenameUnderModelsDir,
  validateKeepResident,
  validateModelsMax,
  validateWildcardRoutes,
} from './configRouteValidate.ts'
import { WILDCARD_MODEL } from './routeAddress.ts'
import { engine, route, upstream } from './test-support.ts'
import type { EngineEntry } from './types.ts'

const FILE = 'config.toml'

describe('validateModelsMax', () => {
  test("a models_max below the engine's distinct local roles is refused", () => {
    const e = engine({ id: 'llama', models_max: 1 })
    const routes = [
      route({ engine: 'llama', model: 'a', role: 'chat' }),
      route({ engine: 'llama', model: 'b', role: 'vision' }),
    ]
    expect(() => validateModelsMax([e], routes, FILE)).toThrow(
      /engine "llama" "models_max" 1 is below its 2 distinct configured roles/,
    )
  })

  test('a models_max equal to the role count passes', () => {
    const e = engine({ id: 'llama', models_max: 2 })
    const routes = [
      route({ engine: 'llama', model: 'a', role: 'chat' }),
      route({ engine: 'llama', model: 'b', role: 'vision' }),
    ]
    expect(() => validateModelsMax([e], routes, FILE)).not.toThrow()
  })

  test('an engine with no models_max is never checked', () => {
    const e = engine({ id: 'llama' })
    const routes = [route({ engine: 'llama', model: 'a', role: 'chat' })]
    expect(() => validateModelsMax([e], routes, FILE)).not.toThrow()
  })
})

describe('validateKeepResident', () => {
  test('two keep_resident routes on the same engine and role refuse -- only one model per role can be resident', () => {
    const e = engine({ id: 'llama' })
    const routes = [
      route({ engine: 'llama', model: 'a', role: 'chat', keep_resident: true }),
      route({ engine: 'llama', model: 'b', role: 'chat', keep_resident: true }),
    ]
    expect(() => validateKeepResident([e], routes, FILE)).toThrow(
      /engine "llama" role "chat" has 2 routes declaring "keep_resident"/,
    )
  })

  test('keep_resident routes on distinct roles do not collide', () => {
    const e = engine({ id: 'llama' })
    const routes = [
      route({ engine: 'llama', model: 'a', role: 'chat', keep_resident: true }),
      route({ engine: 'llama', model: 'b', role: 'vision', keep_resident: true }),
    ]
    expect(() => validateKeepResident([e], routes, FILE)).not.toThrow()
  })

  test('a route proxied to a remote upstream holds nothing local to lease, and is not counted', () => {
    const e = engine({ id: 'llama' })
    const routes = [
      route({ engine: 'llama', model: 'a', role: 'chat', keep_resident: true, upstream: 'remote' }),
      route({ engine: 'llama', model: 'b', role: 'chat', keep_resident: true, upstream: 'remote' }),
    ]
    expect(() => validateKeepResident([e], routes, FILE)).not.toThrow()
  })
})

describe('validateFilenameUnderModelsDir', () => {
  test('a filename that escapes models_dir via .. is refused before any filesystem check', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engined-models-dir-'))
    const e = engine({ id: 'llama', models_dir: dir })
    const engines = new Map<string, EngineEntry>([['llama', e]])
    const routes = [route({ engine: 'llama', model: 'a', filename: '../outside.gguf' })]
    expect(() => validateFilenameUnderModelsDir(routes, engines, FILE)).toThrow(
      /filename" is not under engine's "models_dir"/,
    )
  })

  test('a filename under models_dir that does not exist is refused with its own message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engined-models-dir-'))
    const e = engine({ id: 'llama', models_dir: dir })
    const engines = new Map<string, EngineEntry>([['llama', e]])
    const routes = [route({ engine: 'llama', model: 'a', filename: 'missing.gguf' })]
    expect(() => validateFilenameUnderModelsDir(routes, engines, FILE)).toThrow(
      /filename" does not exist at/,
    )
  })

  test('a filename that exists under models_dir passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'engined-models-dir-'))
    writeFileSync(join(dir, 'present.gguf'), 'weights')
    const e = engine({ id: 'llama', models_dir: dir })
    const engines = new Map<string, EngineEntry>([['llama', e]])
    const routes = [route({ engine: 'llama', model: 'a', filename: 'present.gguf' })]
    expect(() => validateFilenameUnderModelsDir(routes, engines, FILE)).not.toThrow()
  })
})

describe('validateWildcardRoutes', () => {
  test('a wildcard route naming no upstream is refused', () => {
    const e = engine({ id: 'remote-chat' })
    const engines = new Map<string, EngineEntry>([['remote-chat', e]])
    const routes = [route({ engine: 'remote-chat', model: WILDCARD_MODEL, upstream: null })]
    expect(() =>
      validateWildcardRoutes({
        routes,
        engines,
        upstreams: new Map(),
        traitFor: () => ({ trait: 'optional', kind: 'openai-http' }),
        file: FILE,
      }),
    ).toThrow(/is a wildcard and must name an upstream/)
  })

  test('a wildcard naming an upstream missing inventory_max_age_seconds is refused', () => {
    const e = engine({ id: 'remote-chat' })
    const engines = new Map<string, EngineEntry>([['remote-chat', e]])
    const u = upstream({ id: 'openrouter' })
    const routes = [route({ engine: 'remote-chat', model: WILDCARD_MODEL, upstream: 'openrouter' })]
    expect(() =>
      validateWildcardRoutes({
        routes,
        engines,
        upstreams: new Map([['openrouter', u]]),
        traitFor: () => ({ trait: 'optional', kind: 'openai-http' }),
        file: FILE,
      }),
    ).toThrow(/upstream "openrouter" is named by a wildcard route and is missing required/)
  })

  test('a modelless (non-wildcard) engine kind refuses a wildcard route', () => {
    const e = engine({ id: 'llama' })
    const engines = new Map<string, EngineEntry>([['llama', e]])
    const routes = [route({ engine: 'llama', model: WILDCARD_MODEL, upstream: 'local' })]
    expect(() =>
      validateWildcardRoutes({
        routes,
        engines,
        upstreams: new Map(),
        traitFor: () => ({ trait: 'optional', kind: 'llama' }),
        file: FILE,
      }),
    ).toThrow(/only a remote openai-http engine may carry one/)
  })
})
