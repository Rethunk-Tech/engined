/**
 * What an agentic provider says it serves, asked at start and on a timer,
 * cached on disk, and laid under the hand-written routes: a declared route
 * for the same model wins field by field, so an operator pins or hides a model
 * by declaring it (`disable = true` hides).
 *
 * Providers that cannot be asked have no source here and keep declared lists.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { resolveCursorBinary } from './agents.ts'
import { DEFAULT_INVENTORY_REFRESH_SECONDS } from './configParse.ts'
import { binExec, type Exec } from './exec.ts'
import type { HttpClient } from './http.ts'
import { stateDir } from './paths.ts'
import { errMessage, finiteNumber, isRecord, MS_PER_SECOND, parseRecord } from './records.ts'
import type { Config, EngineEntry, ModelCapabilities, ResolvedRoute } from './types.ts'

const DEFAULT_MODEL_REFRESH_SECONDS = DEFAULT_INVENTORY_REFRESH_SECONDS

const CLAUDE_ENGINE_ID = 'claude'
const CURSOR_ENGINE_ID = 'cursor'
const MODELS_URL = 'https://api.anthropic.com/v1/models'
const MAX_PAGES = 10
const MODELS_PAGE_SIZE = 1000
const CACHE_VERSION = 1

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
const CLAUDE_PREFIX = /^claude-/
const CURSOR_ROW = /^(\S+) - (.+)$/
const DATE_SUFFIX = /-\d{8}$/
const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max']

export interface DiscoveredModel {
  /** The id the provider serves; sent on the wire. */
  wire: string
  /** The route `model` segment it is addressed by. */
  segment: string
  display_name?: string
  /** The provider's model line (`sonnet`), when it names one. */
  line?: string
  created?: string
  /** The provider itself marks this its default. */
  provider_default?: boolean
  capabilities: ModelCapabilities
}

interface ModelSource {
  fetch(): Promise<DiscoveredModel[]>
}

export interface DiscoveryOptions {
  fetch?: HttpClient
  /** Runs `cursor-agent --list-models`; defaults to the resolved cursor binary. */
  cursorExec?: Exec
  env?: Record<string, string | undefined>
  /** Directory holding `.credentials.json`; defaults to `$CLAUDE_CONFIG_DIR` or `~/.claude`. */
  claudeDir?: string
  now?: () => number
  stateRoot?: string
  log?: (line: string) => void
}

interface Cached {
  fetchedAt: number
  models: DiscoveredModel[]
}

/** `claude-haiku-4-5-20251001` is addressed as `haiku-4-5`, matching the hand-written convention. */
function claudeSegment(wire: string): string {
  return wire.replace(CLAUDE_PREFIX, '').replace(DATE_SUFFIX, '')
}

function claudeCapabilities(row: Record<string, unknown>): ModelCapabilities {
  const caps = isRecord(row.capabilities) ? row.capabilities : {}
  const supported = (v: unknown): boolean => isRecord(v) && v.supported === true
  const effort = isRecord(caps.effort) ? caps.effort : {}
  const reasoning = EFFORT_LEVELS.filter((level) => supported(effort[level]))
  return {
    input: supported(caps.image_input) ? ['text', 'image'] : ['text'],
    output: ['text'],
    context_in: finiteNumber(row.max_input_tokens),
    context_out: finiteNumber(row.max_tokens),
    reasoning: reasoning.length > 0 ? reasoning : undefined,
  }
}

/** One page of Anthropic's Models API (`GET /v1/models`) as models, plus the cursor to the next. */
function parseClaudePage(body: unknown): { models: DiscoveredModel[]; next?: string } {
  if (!(isRecord(body) && Array.isArray(body.data))) {
    throw new Error('GET /v1/models was not a models list')
  }
  const models: DiscoveredModel[] = []
  for (const row of body.data) {
    if (!(isRecord(row) && typeof row.id === 'string')) {
      continue
    }
    models.push({
      wire: row.id,
      segment: claudeSegment(row.id),
      display_name: typeof row.display_name === 'string' ? row.display_name : undefined,
      line: typeof row.line === 'string' ? row.line : undefined,
      created: typeof row.created_at === 'string' ? row.created_at : undefined,
      capabilities: claudeCapabilities(row),
    })
  }
  const last = models.at(-1)
  return { models, next: body.has_more === true ? last?.wire : undefined }
}

/**
 * The credential the Models API accepts: `ANTHROPIC_API_KEY`, else the access
 * token the Claude CLI keeps for its own login. The CLI refreshes that token
 * whenever it runs, so an expired one is a failed refresh (the cache serves),
 * not something engined renews.
 */
function claudeAuthHeaders(opts: DiscoveryOptions, now: number): Record<string, string> {
  const apiKey = opts.env?.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY
  const base = { 'anthropic-version': '2023-06-01' }
  if (apiKey !== undefined && apiKey !== '') {
    return { ...base, 'x-api-key': apiKey }
  }
  const dir =
    opts.claudeDir ??
    opts.env?.CLAUDE_CONFIG_DIR ??
    process.env.CLAUDE_CONFIG_DIR ??
    join(homedir(), '.claude')
  const path = join(dir, '.credentials.json')
  const creds = existsSync(path) ? parseRecord(readFileSync(path, 'utf8')) : null
  const oauth = creds !== null && isRecord(creds.claudeAiOauth) ? creds.claudeAiOauth : undefined
  if (oauth === undefined || typeof oauth.accessToken !== 'string') {
    throw new Error(`no ANTHROPIC_API_KEY and no Claude login in ${path}`)
  }
  const expiresAt = finiteNumber(oauth.expiresAt)
  if (expiresAt !== undefined && expiresAt <= now) {
    throw new Error(`the Claude login token in ${path} has expired; running claude refreshes it`)
  }
  return {
    ...base,
    authorization: `Bearer ${oauth.accessToken}`,
    'anthropic-beta': 'oauth-2025-04-20',
  }
}

function claudeSource(opts: DiscoveryOptions): ModelSource {
  return {
    async fetch() {
      const http = opts.fetch ?? fetch
      const headers = claudeAuthHeaders(opts, opts.now?.() ?? Date.now())
      const models: DiscoveredModel[] = []
      let after: string | undefined
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const url = new URL(MODELS_URL)
        url.searchParams.set('limit', String(MODELS_PAGE_SIZE))
        if (after !== undefined) {
          url.searchParams.set('after_id', after)
        }
        const res = await http(url.toString(), { method: 'GET', headers, redirect: 'error' })
        if (!res.ok) {
          throw new Error(`GET /v1/models returned HTTP ${res.status}`)
        }
        const parsed = parseClaudePage(await res.json())
        models.push(...parsed.models)
        after = parsed.next
        if (after === undefined) {
          return models
        }
      }
      throw new Error(`GET /v1/models paged past ${MAX_PAGES} pages`)
    },
  }
}

/** `cursor-agent --list-models` prints `<id> - <Display Name>` rows between a header and a tip. */
export function parseCursorModels(stdout: string): DiscoveredModel[] {
  const models: DiscoveredModel[] = []
  for (const line of stdout.split('\n')) {
    const match = CURSOR_ROW.exec(line.trim())
    if (match === null) {
      continue
    }
    const [, id, display] = match as unknown as [string, string, string]
    models.push({
      wire: id,
      segment: id,
      display_name: display,
      provider_default: display.includes('(default)'),
      capabilities: {},
    })
  }
  return models
}

function cursorSource(opts: DiscoveryOptions): ModelSource {
  return {
    async fetch() {
      const exec = opts.cursorExec ?? binExec(resolveCursorBinary())
      const result = await exec(['--list-models'])
      if (result.exitCode !== 0) {
        throw new Error(`cursor --list-models exited ${result.exitCode}: ${result.stderr.trim()}`)
      }
      const models = parseCursorModels(result.stdout)
      if (models.length === 0) {
        throw new Error('cursor --list-models listed no models')
      }
      return models
    },
  }
}

const SOURCES: Record<string, (opts: DiscoveryOptions) => ModelSource> = {
  [CLAUDE_ENGINE_ID]: claudeSource,
  [CURSOR_ENGINE_ID]: cursorSource,
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
    const previous = this.cache.get(engineId)?.models ?? []
    let found: DiscoveredModel[]
    try {
      found = await source.fetch()
    } catch (err) {
      this.log(
        `models: ${engineId}: refresh failed (${errMessage(err)}); keeping ${previous.length} cached`,
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
    if (changed) {
      this.generation += 1
    }
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
      const model = this.defaultModel(engine, models, routes)
      if (model !== undefined) {
        defaults[engine.id] = model
      }
    }
    const view = { ...config, routes, default_models: defaults }
    this.applied = { config, generation: this.generation, view }
    return view
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
