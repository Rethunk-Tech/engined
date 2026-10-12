/**
 * What an agentic provider says it serves, asked at start and on a timer,
 * cached on disk, and laid under the hand-written routes: a declared route
 * for the same model wins field by field, so an operator pins or hides a model
 * by declaring it (`disable = true` hides).
 *
 * Providers that cannot be asked have no source here and keep declared lists.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { DEFAULT_INVENTORY_REFRESH_SECONDS } from './configParse.ts'
import {
  CLAUDE_ENGINE_ID,
  DEFAULT_FETCH_TIMEOUT_MS,
  type DiscoveredModel,
  type DiscoveryOptions,
  type ModelSource,
  SOURCES,
} from './modelSources.ts'
import { stateDir } from './paths.ts'
import { errMessage, finiteNumber, isRecord, MS_PER_SECOND, parseRecord } from './records.ts'
import type { Config, EngineEntry, ModelCapabilities, ResolvedRoute } from './types.ts'

const DEFAULT_MODEL_REFRESH_SECONDS = DEFAULT_INVENTORY_REFRESH_SECONDS

const CACHE_VERSION = 1
const MS_PER_MINUTE = 60_000

/**
 * The capabilities of a Claude family, for a declared route the provider has
 * not described (offline, nothing cached yet). Source: Anthropic's models
 * overview, read 2026-10-11 -- "All current models support text and image
 * input, text output" -- and `GET /v1/models`, which reported
 * `image_input.supported = true` for all 14 models of these four lines. The
 * overview names Claude Fable 5.1, Opus 5.5, Sonnet 5.5 and Haiku 5.5 as the
 * current lineup. A new line is absent here until its capabilities are read.
 */
const CLAUDE_FAMILY_CAPABILITIES: Record<string, ModelCapabilities> = {
  opus: { input: ['text', 'image'], output: ['text'] },
  sonnet: { input: ['text', 'image'], output: ['text'] },
  haiku: { input: ['text', 'image'], output: ['text'] },
  fable: { input: ['text', 'image'], output: ['text'] },
}

/** The line whose newest model is an engine's default when the provider marks none. */
const PREFERRED_LINE: Record<string, string> = { [CLAUDE_ENGINE_ID]: 'sonnet' }

const CLAUDE_WIRE_ID = /^claude-([a-z]+)-/

interface Cached {
  fetchedAt: number
  models: DiscoveredModel[]
}

function isDiscoveredModel(v: unknown): v is DiscoveredModel {
  return (
    isRecord(v) &&
    typeof v.wire === 'string' &&
    typeof v.segment === 'string' &&
    isRecord(v.capabilities)
  )
}

/** What a declared route lacks, from the provider's answer for its wire id, then the family table. */
function filledCapabilities(
  route: ResolvedRoute,
  discovered: ReadonlyMap<string, DiscoveredModel>,
): Partial<ResolvedRoute> {
  const wire = route.wire_model ?? route.model
  const provided = wire === undefined ? undefined : discovered.get(wire)?.capabilities
  const family = wire === undefined ? undefined : CLAUDE_WIRE_ID.exec(wire)?.[1]
  const table =
    route.engine === CLAUDE_ENGINE_ID && family !== undefined
      ? CLAUDE_FAMILY_CAPABILITIES[family]
      : undefined
  const fill: Partial<ResolvedRoute> = {}
  for (const key of ['input', 'output', 'context_in', 'context_out', 'reasoning'] as const) {
    if (route[key] === undefined) {
      const value = provided?.[key] ?? table?.[key]
      if (value !== undefined) {
        Object.assign(fill, { [key]: value })
      }
    }
  }
  return fill
}

function newest(models: readonly DiscoveredModel[]): DiscoveredModel | undefined {
  return [...models].sort((a, b) => (b.created ?? '').localeCompare(a.created ?? ''))[0]
}

function defaultWire(engineId: string, models: readonly DiscoveredModel[]): string | undefined {
  const marked = models.find((m) => m.provider_default === true)
  if (marked !== undefined) {
    return marked.wire
  }
  const line = PREFERRED_LINE[engineId]
  return newest(models.filter((m) => m.line === line))?.wire
}

export class ModelDiscovery {
  private readonly cache = new Map<string, Cached>()
  private timers: ReturnType<typeof setInterval>[] = []
  private generation = 0
  private readonly errors = new Map<string, string>()
  private readonly inFlight = new Set<string>()
  private applied: { config: Config; generation: number; view: Config } | undefined
  private readonly opts: DiscoveryOptions

  constructor(opts: DiscoveryOptions = {}) {
    this.opts = opts
  }

  /** Loads each served engine's cached list, then refreshes it now and every `model_refresh_seconds`. Does not wait for the provider. */
  start(config: Config): void {
    this.stop()
    for (const engine of this.served(config)) {
      this.loadCache(engine.id)
      const seconds = engine.model_refresh_seconds ?? DEFAULT_MODEL_REFRESH_SECONDS
      this.timers.push(
        setInterval(() => {
          this.refresh(engine.id).catch(() => undefined)
        }, seconds * MS_PER_SECOND),
      )
      this.refresh(engine.id).catch(() => undefined)
    }
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers = []
  }

  /** Asks the provider once. A failure keeps the previous list; either way one info line says what happened. */
  async refresh(engineId: string): Promise<void> {
    const source = SOURCES[engineId]?.(this.opts)
    if (source === undefined) {
      return
    }
    if (this.inFlight.has(engineId)) {
      return
    }
    this.inFlight.add(engineId)
    try {
      await this.refreshFrom(engineId, source)
    } finally {
      this.inFlight.delete(engineId)
    }
  }

  private async refreshFrom(engineId: string, source: ModelSource): Promise<void> {
    const previous = this.cache.get(engineId)?.models ?? []
    let found: DiscoveredModel[]
    try {
      found = await withTimeout(
        source.fetch(),
        this.opts.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS,
      )
    } catch (err) {
      this.errors.set(engineId, errMessage(err))
      this.generation += 1
      this.log(
        `models: ${engineId}: refresh failed (${errMessage(err)}); keeping ${previous.length} cached, ${this.age(engineId)}`,
      )
      return
    }
    const before = new Set(previous.map((m) => m.wire))
    const after = new Set(found.map((m) => m.wire))
    const added = found.filter((m) => !before.has(m.wire)).length
    const removed = previous.filter((m) => !after.has(m.wire)).length
    const changed = added > 0 || removed > 0 || JSON.stringify(previous) !== JSON.stringify(found)
    this.log(
      changed
        ? `models: ${engineId}: found ${found.length}, added ${added}, removed ${removed}`
        : `models: ${engineId}: found ${found.length}, unchanged`,
    )
    const cached = { fetchedAt: this.opts.now?.() ?? Date.now(), models: found }
    this.cache.set(engineId, cached)
    this.writeCache(engineId, cached)
    this.errors.delete(engineId)
    this.generation += 1
  }

  /**
   * The config with discovered routes laid under the declared ones, declared
   * capabilities filled where missing, and `default_models` set. Memoised on
   * the config object and the discovery generation, so repeated reads agree.
   */
  apply(config: Config): Config {
    if (this.applied?.config === config && this.applied.generation === this.generation) {
      return this.applied.view
    }
    const routes = [...config.routes]
    const defaults: Record<string, string> = {}
    const status: Record<string, DiscoveryStatus> = {}
    for (const engine of this.served(config)) {
      const models = this.cache.get(engine.id)?.models ?? []
      const byWire = new Map(models.map((m) => [m.wire, m]))
      const claimed = new Set<string>()
      for (const [i, route] of routes.entries()) {
        if (route.engine !== engine.id || route.upstream !== null) {
          continue
        }
        for (const id of [route.model, route.wire_model]) {
          if (id !== undefined) {
            claimed.add(id)
          }
        }
        routes[i] = { ...route, ...filledCapabilities(route, byWire) }
      }
      for (const m of models) {
        if (!(claimed.has(m.wire) || claimed.has(m.segment))) {
          routes.push(discoveredRoute(engine.id, m))
        }
      }
      status[engine.id] = this.statusFor(engine.id, config, models)
      const model = this.defaultModel(engine, models, routes)
      if (model !== undefined) {
        defaults[engine.id] = model
      }
    }
    const view = { ...config, routes, default_models: defaults, model_discovery: status }
    this.applied = { config, generation: this.generation, view }
    return view
  }

  private statusFor(
    engineId: string,
    config: Config,
    models: readonly DiscoveredModel[],
  ): DiscoveryStatus {
    const cached = this.cache.get(engineId)
    return {
      fetched_at: cached === undefined ? undefined : new Date(cached.fetchedAt).toISOString(),
      models: models.length,
      last_error: this.errors.get(engineId),
      findings: cached === undefined ? [] : findingsFor(engineId, config.routes, models),
    }
  }

  private defaultModel(
    engine: EngineEntry,
    models: readonly DiscoveredModel[],
    routes: readonly ResolvedRoute[],
  ): string | undefined {
    const ambient = routes.filter(
      (r) => r.engine === engine.id && r.upstream === null && !r.disabled,
    )
    if (
      engine.default_model !== undefined &&
      ambient.some((r) => r.model === engine.default_model)
    ) {
      return engine.default_model
    }
    const wire = defaultWire(engine.id, models)
    return ambient.find((r) => (r.wire_model ?? r.model) === wire)?.model
  }

  /** How stale the cached list is, for the failure line: an operator reads it to tell a list that is hours old from one that is fresh. */
  private age(engineId: string): string {
    const cached = this.cache.get(engineId)
    if (cached === undefined) {
      return 'none fetched yet'
    }
    const minutes = Math.floor(
      ((this.opts.now?.() ?? Date.now()) - cached.fetchedAt) / MS_PER_MINUTE,
    )
    return `fetched ${minutes} min ago`
  }

  private served(config: Config): EngineEntry[] {
    return config.engines.filter((e) => !e.disabled && SOURCES[e.id] !== undefined)
  }

  private log(line: string): void {
    ;(this.opts.log ?? ((l) => process.stderr.write(`${l}\n`)))(line)
  }

  private cachePath(engineId: string): string {
    return join(this.opts.stateRoot ?? stateDir(), 'models', `${engineId}.json`)
  }

  private loadCache(engineId: string): void {
    if (this.cache.has(engineId)) {
      return
    }
    let raw: Record<string, unknown> | null
    try {
      raw = parseRecord(readFileSync(this.cachePath(engineId), 'utf8'))
    } catch {
      return
    }
    if (raw === null || raw.version !== CACHE_VERSION || !Array.isArray(raw.models)) {
      return
    }
    this.cache.set(engineId, {
      fetchedAt: finiteNumber(raw.fetched_at) ?? 0,
      models: raw.models.filter(isDiscoveredModel),
    })
    this.generation += 1
  }

  private writeCache(engineId: string, cached: Cached): void {
    const path = this.cachePath(engineId)
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(
      tmp,
      `${JSON.stringify({ version: CACHE_VERSION, fetched_at: cached.fetchedAt, models: cached.models })}\n`,
    )
    renameSync(tmp, path)
  }
}

function discoveredRoute(engine: string, m: DiscoveredModel): ResolvedRoute {
  return {
    engine,
    model: m.segment,
    wire_model: m.wire === m.segment ? undefined : m.wire,
    display_name: m.display_name,
    upstream: null,
    args: {},
    ...m.capabilities,
  }
}

interface DiscoveryFinding {
  kind: 'duplicate' | 'retired'
  route: string
  /** What to do to the config, literally. */
  fix: string
}

/** Per engine, what the last asks of its provider found; served on `GET /engined/v1/engines`. */
export interface DiscoveryStatus {
  /** When the list in use was last fetched; absent before the first success. */
  fetched_at?: string
  models: number
  /** Why the most recent refresh failed, while the list in use is older than it. */
  last_error?: string
  findings: DiscoveryFinding[]
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms)
  })
  return Promise.race([work, expired]).finally(() => clearTimeout(timer))
}

const CAPABILITY_KEYS = ['input', 'output', 'context_in', 'context_out', 'reasoning'] as const

/** Whether a declared route states nothing discovery would not already say. */
function addsNothing(route: ResolvedRoute, found: DiscoveredModel): boolean {
  if (route.model !== found.segment || (route.wire_model ?? route.model) !== found.wire) {
    return false
  }
  if (route.display_name !== undefined && route.display_name !== found.display_name) {
    return false
  }
  return CAPABILITY_KEYS.every(
    (key) =>
      route[key] === undefined ||
      JSON.stringify(route[key]) === JSON.stringify(found.capabilities[key]),
  )
}

function findingsFor(
  engineId: string,
  routes: readonly ResolvedRoute[],
  models: readonly DiscoveredModel[],
): DiscoveryFinding[] {
  const byWire = new Map(models.map((m) => [m.wire, m]))
  const findings: DiscoveryFinding[] = []
  for (const route of routes) {
    if (
      route.engine !== engineId ||
      route.upstream !== null ||
      route.disabled ||
      route.model === undefined
    ) {
      continue
    }
    const block = `the [[route]] block with engine = "${engineId}" and model = "${route.model}"`
    const wire = route.wire_model ?? route.model
    const found = byWire.get(wire)
    if (found === undefined) {
      findings.push({
        kind: 'retired',
        route: route.model,
        fix: `the provider no longer lists "${wire}"; delete ${block}`,
      })
    } else if (addsNothing(route, found)) {
      findings.push({
        kind: 'duplicate',
        route: route.model,
        fix: `discovery already serves "${wire}" identically; delete ${block}`,
      })
    }
  }
  return findings
}
