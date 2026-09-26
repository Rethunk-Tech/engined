/**
 * `context_in` derivation for `GET /openai/v1/models`: the merged
 * `ctx-size`/`parallel` a llama route resolves to when config left
 * `context_in` undeclared, declared-always-wins over that derivation, and
 * the chain-wide minimum across hops. Exercised directly against the
 * exported pure functions rather than a full door -- there is no upstream
 * involved in any of this, only the same config merge the launcher itself
 * runs.
 */
import { expect, test } from 'bun:test'
import { type ChainHop, chainContext, collapseCursorRoutes, routeContextIn } from './modelsMenu.ts'
import type { EngineStatus } from './responses.ts'
import { config, engine, route } from './test-support.ts'

function llamaEngineStatus(overrides: Partial<EngineStatus> = {}): EngineStatus {
  return {
    id: 'llama',
    kind: 'openai-http',
    serves: [],
    state: 'installed',
    streaming: true,
    ...overrides,
  }
}

test('a local llama route with no declared context_in derives it from ctx-size / parallel', () => {
  const eng = engine({
    id: 'llama',
    models_dir: '/models',
    args: { 'ctx-size': 32_768, parallel: -1 },
  })
  const r = route({ engine: 'llama', model: 'ornith', args: { 'ctx-size': 262_144, parallel: 4 } })
  expect(routeContextIn(r, eng, llamaEngineStatus())).toBe(65_536)
})

test('an explicit kv-unified keeps the whole ctx-size even with a positive parallel', () => {
  // Live proof: ornith runs ctx-size=262144, parallel=4, kv-unified=true, and
  // the resident engine's GET /slots reports n_ctx=262144 on all four slots
  // -- kv-unified gives them one shared pool, not four divided ones.
  const eng = engine({ id: 'llama', models_dir: '/models', args: {} })
  const r = route({
    engine: 'llama',
    model: 'ornith',
    args: { 'ctx-size': 262_144, parallel: 4, 'kv-unified': true },
  })
  expect(routeContextIn(r, eng, llamaEngineStatus())).toBe(262_144)
})

test('parallel <= 0 (llama.cpp auto) reports the whole ctx-size, not a divided window', () => {
  const eng = engine({
    id: 'llama',
    models_dir: '/models',
    args: { 'ctx-size': 32_768, parallel: -1 },
  })
  const r = route({ engine: 'llama', model: 'vision', args: {} })
  expect(routeContextIn(r, eng, llamaEngineStatus())).toBe(32_768)
})

test('a declared context_in always wins over the derived one', () => {
  const eng = engine({
    id: 'llama',
    models_dir: '/models',
    args: { 'ctx-size': 32_768, parallel: -1 },
  })
  const r = route({
    engine: 'llama',
    model: 'ornith',
    args: { 'ctx-size': 262_144, parallel: 4 },
    context_in: 1000,
  })
  expect(routeContextIn(r, eng, llamaEngineStatus())).toBe(1000)
})

test('a remote openai-http route (no models_dir) is never derived', () => {
  const eng = engine({ id: 'openrouter', args: { 'ctx-size': 262_144, parallel: 4 } })
  const r = route({ engine: 'openrouter', model: 'sonnet-5', args: {} })
  expect(routeContextIn(r, eng, llamaEngineStatus({ id: 'openrouter' }))).toBeUndefined()
})

function chainHop(contextIn: number | undefined, contextOut?: number): ChainHop {
  return {
    hop: '@/llama/x',
    route: route({ engine: 'llama', model: 'x', context_in: contextIn, context_out: contextOut }),
    status: llamaEngineStatus(),
    state: 'installed',
  }
}

test('a chain reports the minimum context_in/context_out across the hops that declare one', () => {
  const walked = [chainHop(65_536, 4096), chainHop(32_768)]
  expect(chainContext(walked, config())).toEqual({
    context_in: 32_768,
    context_out: 4096,
  })
})

test('a chain with no hop reporting a context leaves both absent', () => {
  const walked = [chainHop(undefined)]
  expect(chainContext(walked, config())).toEqual({
    context_in: undefined,
    context_out: undefined,
  })
})

test('collapseCursorRoutes replaces every @/cursor/<suffixed> row with one row per base', () => {
  const others = [route({ engine: 'llama', model: 'ornith', upstream: 'local' })]
  const cursorRoutes = [
    route({ engine: 'cursor', model: 'gpt-5.3-codex', upstream: null, display_name: 'Codex 5.3' }),
    route({
      engine: 'cursor',
      model: 'gpt-5.3-codex-low',
      upstream: null,
      display_name: 'Codex 5.3 Low',
    }),
    route({
      engine: 'cursor',
      model: 'gpt-5.3-codex-high',
      upstream: null,
      display_name: 'Codex 5.3 High',
    }),
  ]
  const collapsed = collapseCursorRoutes([...others, ...cursorRoutes])
  expect(collapsed).toHaveLength(2)
  const codex = collapsed.find((r) => r.engine === 'cursor')
  expect(codex?.model).toBe('gpt-5.3-codex')
  expect(codex?.display_name).toBe('Codex 5.3')
  expect(codex?.reasoning).toEqual(['low', 'medium', 'high'])
})

test('collapseCursorRoutes leaves a "cursor"-named engine alone when its routes are not ambient', () => {
  // A config could name a real remote-upstream engine "cursor" for reasons
  // that have nothing to do with Cursor's own catalog -- only an ambient
  // (upstream === null) "cursor" engine is Cursor's own addressing.
  const routes = [route({ engine: 'cursor', model: 'sonnet-5', upstream: 'openrouter' })]
  expect(collapseCursorRoutes(routes)).toEqual(routes)
})
