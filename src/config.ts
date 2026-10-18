/**
 * Parses and validates `config.toml` into the shared `Config` shape. Every
 * rule here is fatal at parse: a daemon serving a config it cannot fully
 * trust is worse than one that refuses to start.
 *
 * Five tables, four independent id namespaces (engine, upstream, model,
 * chain), each checked for collisions only against itself -- an engine and
 * an upstream may share an id with no conflict, since nothing before
 * addressing (a later phase) ever compares the two.
 */
import { join } from 'node:path'
import { argKeysAsFlags, assertNoForbiddenFlags } from './agenticArgs.ts'
import { buildChains, parseChainRaw } from './configChains.ts'
import { ENGINE_KEYS, MODEL_KEYS, SECRET_KEYS, UPSTREAM_KEYS } from './configKeys.ts'
import { recordOrigins } from './configOrigin.ts'
import {
  asArgs,
  expandConfigPath,
  optional,
  optionalPositive,
  optionalStringArray,
  optionalTimeoutSeconds,
  parseCapabilities,
  parseDisable,
  parsePort,
  parsePositiveInteger,
  requireString,
  requireTable,
} from './configParse.ts'
import { parseRouteRaw, resolveRoute, type SpecFacts, specFactsFor } from './configRoutes.ts'
import {
  checkModellessMixing,
  validateFilenameUnderModelsDir,
  validateKeepResident,
  validateModelsMax,
  validateVisionBridgeRoutes,
  validateWildcardRoutes,
} from './configRouteValidate.ts'
import { collectEntries, configTextSha256, inEntry, readConfigSources } from './configSources.ts'
import {
  parseConfigsvc,
  parsePotluckCallback,
  parseUpstreamHeaders,
  readFingerprint,
  readMonthlyCap,
} from './configUpstream.ts'
import { DEFAULT_IDLE_STOP_SECONDS, DEFAULT_READY_TIMEOUT_S } from './engineEntries.ts'
import { ParseError } from './errors/parse.ts'
import { configPath, installDir } from './paths.ts'
import { LOCAL_UPSTREAM } from './routeAddress.ts'
import type {
  Config,
  EngineEntry,
  EngineKind,
  ModelEntry,
  SecretRef,
  Upstream,
  Wire,
} from './types.ts'
import { EGRESS_RANK, isEgress, KIND_TRAITS } from './types.ts'

export const DEFAULT_LISTEN_PORT = 29_200
/**
 * The Cursor turn stream is bidirectional and needs HTTP/2, which the main
 * cleartext door does not speak, so it gets its own h2c listener. A TLS
 * terminator in front routes `/agent.v1.AgentService/Run` here.
 */
export const DEFAULT_CURSOR_PORT = 29_201
export const DEFAULT_CHAT_TIMEOUT_SECONDS = 600
export const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600
export const DEFAULT_STREAM_STALL_SECONDS = 60
export const DEFAULT_AGENTIC_CONCURRENCY = 4

function parseSecret(value: unknown, site: string, file: string): SecretRef {
  const v = requireTable(value, `${site} "secret"`, SECRET_KEYS, file)
  return {
    service: requireString(v.service, `${site} "secret.service"`, file),
    username: requireString(v.username, `${site} "secret.username"`, file),
    header: requireString(v.header, `${site} "secret.header"`, file),
    scheme: optional(v.scheme, 'string', `${site} "secret.scheme"`, file),
  }
}

function parseKind(
  raw: Record<string, unknown>,
  site: string,
  file: string,
): EngineKind | undefined {
  const kindStr = optional(raw.kind, 'string', `${site} "kind"`, file)
  // `Object.hasOwn` against the trait table itself, the same idiom `isEgress`
  // uses and for the same reason: the kinds a config may name are exactly the
  // ones the table answers for, so a new kind is admitted here the moment it
  // is given traits, with no second list to keep in step.
  if (kindStr !== undefined && !Object.hasOwn(KIND_TRAITS, kindStr)) {
    throw new ParseError(`${site} has invalid "kind" "${kindStr}"`, { file, key: 'kind' })
  }
  return kindStr as EngineKind | undefined
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * An engine or upstream id becomes a state path (llama/<id>/preset.ini,
 * upstreams/<id>/inventory.json), so `/`, `..` or a leading dot must never
 * reach a join.
 */
function requireId(value: unknown, posSite: string, file: string): string {
  const id = requireString(value, `${posSite} "id"`, file)
  if (!ID_RE.test(id)) {
    throw new ParseError(`${posSite} "id" "${id}" must match ${ID_RE}`, { file, key: 'id' })
  }
  return id
}

/** Only the keys the operator wrote: an absent key leaves the spec's value standing, an empty array replaces it with none. */
function configuredDevices(
  raw: Record<string, unknown>,
  site: string,
  file: string,
): Pick<EngineEntry, 'devices' | 'group_add'> {
  const devices = optionalStringArray(raw.devices, `${site} "devices"`, file)
  const groupAdd = optionalStringArray(raw.group_add, `${site} "group_add"`, file)
  return {
    ...(devices === undefined ? {} : { devices }),
    ...(groupAdd === undefined ? {} : { group_add: groupAdd }),
  }
}

function parseEngine(value: unknown, index: number, file: string): EngineEntry {
  const posSite = `engine[${index}]`
  const raw = requireTable(value, posSite, ENGINE_KEYS, file)
  const id = requireId(raw.id, posSite, file)
  const site = `engine "${id}"`
  const rawModelsDir = optional(raw.models_dir, 'string', `${site} "models_dir"`, file)
  const agentVersion = optional(raw.agent_version, 'string', `${site} "agent_version"`, file)
  const args = asArgs(raw.args, site, file)
  assertNoForbiddenFlags(argKeysAsFlags(args), file)
  const rawSpecDir = optional(raw.spec_dir, 'string', `${site} "spec_dir"`, file)
  // Zero reads as "no ceiling" and means the opposite: a single attempt, no
  // wait for a busy container, and a 503 telling the caller the engine has
  // not been free for 0s. Refused here rather than served as a wait nobody
  // asked for.
  const drainTimeoutS = optionalTimeoutSeconds(
    raw.drain_timeout_seconds,
    `${site} "drain_timeout_seconds"`,
    file,
  )
  return {
    id,
    disabled: parseDisable(raw, site, file),
    spec_dir: rawSpecDir === undefined ? undefined : expandConfigPath(rawSpecDir),
    models_dir: rawModelsDir === undefined ? undefined : expandConfigPath(rawModelsDir),
    models_max: optionalPositive(raw.models_max, `${site} "models_max"`, file),
    idle_stop_seconds:
      optionalTimeoutSeconds(raw.idle_stop_seconds, `${site} "idle_stop_seconds"`, file) ??
      DEFAULT_IDLE_STOP_SECONDS,
    drain_timeout_seconds: drainTimeoutS,
    ready_timeout_s:
      optionalTimeoutSeconds(raw.ready_timeout_s, `${site} "ready_timeout_s"`, file) ??
      DEFAULT_READY_TIMEOUT_S,
    agent_version: agentVersion,
    default_model: optional(raw.default_model, 'string', `${site} "default_model"`, file),
    model_refresh_seconds: optionalTimeoutSeconds(
      raw.model_refresh_seconds,
      `${site} "model_refresh_seconds"`,
      file,
    ),
    kind: parseKind(raw, site, file),
    args,
    ...configuredDevices(raw, site, file),
  }
}

function parseUpstream(value: unknown, index: number, file: string): Upstream {
  const posSite = `upstream[${index}]`
  const raw = requireTable(value, posSite, UPSTREAM_KEYS, file)
  const id = requireId(raw.id, posSite, file)
  const site = `upstream "${id}"`
  const egress = optional(raw.egress, 'string', `${site} "egress"`, file)
  if (egress === undefined) {
    throw new ParseError(`${site} is missing required "egress"`, { file, key: 'egress' })
  }
  if (!isEgress(egress)) {
    throw new ParseError(
      `${site} "egress" must be one of: ${Object.keys(EGRESS_RANK).join(', ')}`,
      { file, key: 'egress' },
    )
  }
  // "local" always means this box, so a learned upstream name can never point it
  // off-machine. Refused here, before route defaulting reads the literal.
  if (id === LOCAL_UPSTREAM && (raw.base_url !== undefined || raw.secret !== undefined)) {
    throw new ParseError(
      `${site} is reserved for this box and cannot carry "base_url" or "secret"`,
      { file, key: 'base_url' },
    )
  }
  const wireStr = optional(raw.wire, 'string', `${site} "wire"`, file)
  if (wireStr !== undefined && wireStr !== 'openai' && wireStr !== 'anthropic') {
    throw new ParseError(`${site} has invalid "wire" "${wireStr}"`, { file, key: 'wire' })
  }
  const inventoryMaxAge = optionalTimeoutSeconds(
    raw.inventory_max_age_seconds,
    `${site} "inventory_max_age_seconds"`,
    file,
  )
  const inventoryRefresh = optionalTimeoutSeconds(
    raw.inventory_refresh_seconds,
    `${site} "inventory_refresh_seconds"`,
    file,
  )
  if (
    inventoryMaxAge !== undefined &&
    inventoryRefresh !== undefined &&
    inventoryRefresh >= inventoryMaxAge
  ) {
    throw new ParseError(
      `${site} "inventory_refresh_seconds" must be less than "inventory_max_age_seconds"`,
      { file, key: 'inventory_refresh_seconds' },
    )
  }
  const secret = raw.secret === undefined ? undefined : parseSecret(raw.secret, site, file)
  return {
    id,
    base_url: optional(raw.base_url, 'string', `${site} "base_url"`, file),
    secret,
    egress,
    wire: wireStr as Wire | undefined,
    disabled: parseDisable(raw, site, file),
    inventory_max_age_seconds: inventoryMaxAge,
    inventory_refresh_seconds: inventoryRefresh,
    headers: parseUpstreamHeaders(raw.headers, site, file, secret?.header),
    fingerprint: readFingerprint(raw.fingerprint, site, file),
    monthly_cap_usd: readMonthlyCap(raw.monthly_cap_usd, site, file),
  }
}

function parseModel(value: unknown, index: number, file: string): ModelEntry {
  const posSite = `model[${index}]`
  const raw = requireTable(value, posSite, MODEL_KEYS, file)
  const id = requireString(raw.id, `${posSite} "id"`, file)
  return { id, ...parseCapabilities(raw, `model "${id}"`, file) }
}

/**
 * Every `id` in one table declared once, across the main file and every
 * `config.d` fragment. Tables are checked only against themselves: an
 * engine, an upstream and a model may share a name. `files` is parallel to
 * `items`, so a collision names both the fragment that redeclared an id and
 * the file that declared it first.
 */
function checkCollisions(
  items: readonly { id: string }[],
  files: readonly string[],
  indexes: readonly number[],
  label: string,
): void {
  const seen = new Map<string, string>()
  for (const [i, item] of items.entries()) {
    const file = files[i] as string
    const prior = seen.get(item.id)
    if (prior !== undefined) {
      throw new ParseError(`${label} "${item.id}" is declared twice: also declared in ${prior}`, {
        file,
        table: label,
        index: indexes[i] as number,
        key: 'id',
      })
    }
    seen.set(item.id, file)
  }
}

/**
 * `enginesRoot` defaults to the installed `engines/` tree so a production
 * `loadConfig()` call needs no argument; a test that ships its own fixture
 * specs passes one explicitly.
 */
export function loadConfig(path?: string, enginesRoot?: string): Config {
  const file = path ?? configPath()
  const root = enginesRoot ?? join(installDir(), 'engines')
  const sources = readConfigSources(file)
  const mainRaw = sources[0]?.raw as Record<string, unknown>

  const {
    items: engines,
    files: engineFiles,
    indexes: engineIndexes,
  } = collectEntries(sources, 'engine', parseEngine)
  checkCollisions(engines, engineFiles, engineIndexes, 'engine')
  recordOrigins(engines, 'engine', engineFiles, engineIndexes)
  const engineMap = new Map(engines.map((e) => [e.id, e]))

  const {
    items: upstreams,
    files: upstreamFiles,
    indexes: upstreamIndexes,
  } = collectEntries(sources, 'upstream', parseUpstream)
  checkCollisions(upstreams, upstreamFiles, upstreamIndexes, 'upstream')
  recordOrigins(upstreams, 'upstream', upstreamFiles, upstreamIndexes)
  const upstreamMap = new Map(upstreams.map((u) => [u.id, u]))

  const {
    items: models,
    files: modelFiles,
    indexes: modelIndexes,
  } = collectEntries(sources, 'model', parseModel)
  checkCollisions(models, modelFiles, modelIndexes, 'model')
  const modelMap = new Map(models.map((m) => [m.id, m]))

  const {
    items: rawRoutes,
    files: routeFiles,
    indexes: routeIndexes,
  } = collectEntries(sources, 'route', (v, i, f) => parseRouteRaw(v, i, f, engineMap))

  const traitFor = cachedTraitFor(root)
  const routes = rawRoutes.map((r, i) =>
    inEntry('route', routeIndexes[i] as number, () =>
      resolveRoute({
        raw: r,
        allRaws: rawRoutes,
        engines: engineMap,
        upstreams: upstreamMap,
        models: modelMap,
        traitFor,
        file: routeFiles[i] as string,
      }),
    ),
  )
  // The checks below name the file and entry the offender came from, so a bad
  // route or engine in a config.d fragment is reported against that fragment.
  recordOrigins(routes, 'route', routeFiles, routeIndexes)

  checkModellessMixing(routes)
  validateWildcardRoutes({
    routes,
    engines: engineMap,
    upstreams: upstreamMap,
    traitFor,
  })
  validateFilenameUnderModelsDir(routes, engineMap)
  validateKeepResident(engines, routes)
  validateModelsMax(engines, routes)
  validateVisionBridgeRoutes(routes)

  const {
    items: rawChains,
    files: chainFiles,
    indexes: chainIndexes,
  } = collectEntries(sources, 'chain', parseChainRaw)
  checkCollisions(rawChains, chainFiles, chainIndexes, 'chain')
  const chains = buildChains(rawChains, engines, routes, chainFiles, chainIndexes)

  return {
    ...parseTopLevelSettings(mainRaw, file),
    source_sha256: configTextSha256(sources.map((source) => source.text)),
    engines,
    upstreams,
    routes,
    chains,
  }
}

/** A spec is read at most once per engine no matter how many routes name it. */
function cachedTraitFor(enginesRoot: string): (engine: EngineEntry) => SpecFacts {
  const cache = new Map<string, SpecFacts>()
  return (engine) => {
    let facts = cache.get(engine.id)
    if (facts === undefined) {
      facts = specFactsFor(engine, enginesRoot)
      cache.set(engine.id, facts)
    }
    return facts
  }
}

function parseTopLevelSettings(
  raw: Record<string, unknown>,
  file: string,
): Pick<
  Config,
  | 'listen_port'
  | 'cursor_port'
  | 'chat_timeout_seconds'
  | 'agent_timeout_seconds'
  | 'stream_stall_seconds'
  | 'agentic_concurrency'
  | 'potluck'
  | 'configsvc'
> {
  const listenPort = parsePort(raw.listen_port, 'config "listen_port"', file, DEFAULT_LISTEN_PORT)
  const cursorPort = parsePort(raw.cursor_port, 'config "cursor_port"', file, DEFAULT_CURSOR_PORT)
  if (listenPort === cursorPort) {
    throw new ParseError('config "listen_port" and "cursor_port" must differ', {
      file,
      key: 'listen_port',
    })
  }
  return {
    listen_port: listenPort,
    cursor_port: cursorPort,
    chat_timeout_seconds:
      optionalTimeoutSeconds(raw.chat_timeout_seconds, 'config "chat_timeout_seconds"', file) ??
      DEFAULT_CHAT_TIMEOUT_SECONDS,
    agent_timeout_seconds:
      optionalTimeoutSeconds(raw.agent_timeout_seconds, 'config "agent_timeout_seconds"', file) ??
      DEFAULT_AGENT_TIMEOUT_SECONDS,
    stream_stall_seconds:
      optionalTimeoutSeconds(raw.stream_stall_seconds, 'config "stream_stall_seconds"', file) ??
      DEFAULT_STREAM_STALL_SECONDS,
    agentic_concurrency: parsePositiveInteger(
      raw.agentic_concurrency,
      'config "agentic_concurrency"',
      file,
      DEFAULT_AGENTIC_CONCURRENCY,
    ),
    ...parsePotluckCallback(raw, file),
    configsvc: parseConfigsvc(raw, { listen: listenPort, cursor: cursorPort }, file),
  }
}
