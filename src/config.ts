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
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chainHopRoutes, parseHop, routeForChainHop } from './chain.ts'
import {
  asArgs,
  asArray,
  CHAIN_KEYS,
  ENGINE_KEYS,
  expandConfigPath,
  MODEL_KEYS,
  optional,
  parseCapabilities,
  parseDisable,
  requireString,
  requireTable,
  SECRET_KEYS,
  UPSTREAM_KEYS,
} from './configParse.ts'
import {
  checkModellessMixing,
  engineHasWildcard,
  parseRouteRaw,
  resolveRoute,
  type SpecFacts,
  specFactsFor,
  validateFilenameUnderModelsDir,
  validateKeepResident,
  validateModelsMax,
  validateVisionBridgeRoutes,
  validateWildcardRoutes,
} from './configRoutes.ts'
import { ParseError } from './errors/parse.ts'
import { configPath, installDir } from './paths.ts'
import type {
  Config,
  EngineEntry,
  EngineKind,
  ModelEntry,
  ResolvedRoute,
  SecretRef,
  Upstream,
  Wire,
} from './types.ts'
import {
  argKeysAsFlags,
  assertNoForbiddenFlags,
  EGRESS_RANK,
  isEgress,
  isRecord,
  KIND_TRAITS,
  qualifiedSegments,
  WILDCARD_MODEL,
} from './types.ts'

const DEFAULT_LISTEN_PORT = 29_200
/**
 * The Cursor turn stream is bidirectional and needs HTTP/2, which the main
 * cleartext door does not speak, so it gets its own h2c listener. A TLS
 * terminator in front routes `/agent.v1.AgentService/Run` here.
 */
const DEFAULT_CURSOR_PORT = 29_201
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600

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
    throw new ParseError(`${site} has invalid "kind" "${kindStr}"`, file)
  }
  return kindStr as EngineKind | undefined
}

function parseEngine(value: unknown, index: number, file: string): EngineEntry {
  const posSite = `engine[${index}]`
  const raw = requireTable(value, posSite, ENGINE_KEYS, file)
  const id = requireString(raw.id, `${posSite} "id"`, file)
  const site = `engine "${id}"`
  const rawModelsDir = optional(raw.models_dir, 'string', `${site} "models_dir"`, file)
  const agentVersion = optional(raw.agent_version, 'string', `${site} "agent_version"`, file)
  const args = asArgs(raw.args, site, file)
  assertNoForbiddenFlags(argKeysAsFlags(args), file)
  const rawSpecDir = optional(raw.spec_dir, 'string', `${site} "spec_dir"`, file)
  const drainTimeoutS = optional(
    raw.drain_timeout_seconds,
    'number',
    `${site} "drain_timeout_seconds"`,
    file,
  )
  // Zero reads as "no ceiling" and means the opposite: a single attempt, no
  // wait for a busy container, and a 503 telling the caller the engine has
  // not been free for 0s. Refused here rather than served as a wait nobody
  // asked for.
  if (drainTimeoutS !== undefined && drainTimeoutS <= 0) {
    throw new ParseError(`${site} "drain_timeout_seconds" must be greater than 0`, file)
  }
  return {
    id,
    disabled: parseDisable(raw, site, file),
    spec_dir: rawSpecDir === undefined ? undefined : expandConfigPath(rawSpecDir),
    models_dir: rawModelsDir === undefined ? undefined : expandConfigPath(rawModelsDir),
    models_max: optional(raw.models_max, 'number', `${site} "models_max"`, file),
    idle_stop_seconds: optional(
      raw.idle_stop_seconds,
      'number',
      `${site} "idle_stop_seconds"`,
      file,
    ),
    drain_timeout_seconds: drainTimeoutS,
    ready_timeout_s: optional(raw.ready_timeout_s, 'number', `${site} "ready_timeout_s"`, file),
    agent_version: agentVersion,
    kind: parseKind(raw, site, file),
    args,
  }
}

function parseUpstream(value: unknown, index: number, file: string): Upstream {
  const posSite = `upstream[${index}]`
  const raw = requireTable(value, posSite, UPSTREAM_KEYS, file)
  const id = requireString(raw.id, `${posSite} "id"`, file)
  const site = `upstream "${id}"`
  const egress = optional(raw.egress, 'string', `${site} "egress"`, file)
  if (egress === undefined) {
    throw new ParseError(`${site} is missing required "egress"`, file)
  }
  if (!isEgress(egress)) {
    throw new ParseError(
      `${site} "egress" must be one of: ${Object.keys(EGRESS_RANK).join(', ')}`,
      file,
    )
  }
  // "local" always means this box, so a learned upstream name can never point it
  // off-machine. Refused here, before route defaulting reads the literal.
  if (id === 'local' && (raw.base_url !== undefined || raw.secret !== undefined)) {
    throw new ParseError(
      `${site} is reserved for this box and cannot carry "base_url" or "secret"`,
      file,
    )
  }
  const wireStr = optional(raw.wire, 'string', `${site} "wire"`, file)
  if (wireStr !== undefined && wireStr !== 'openai' && wireStr !== 'anthropic') {
    throw new ParseError(`${site} has invalid "wire" "${wireStr}"`, file)
  }
  const inventoryMaxAge = optional(
    raw.inventory_max_age_seconds,
    'number',
    `${site} "inventory_max_age_seconds"`,
    file,
  )
  if (inventoryMaxAge !== undefined && inventoryMaxAge <= 0) {
    throw new ParseError(`${site} "inventory_max_age_seconds" must be greater than 0`, file)
  }
  const inventoryRefresh = optional(
    raw.inventory_refresh_seconds,
    'number',
    `${site} "inventory_refresh_seconds"`,
    file,
  )
  if (inventoryRefresh !== undefined && inventoryRefresh <= 0) {
    throw new ParseError(`${site} "inventory_refresh_seconds" must be greater than 0`, file)
  }
  if (
    inventoryMaxAge !== undefined &&
    inventoryRefresh !== undefined &&
    inventoryRefresh >= inventoryMaxAge
  ) {
    throw new ParseError(
      `${site} "inventory_refresh_seconds" must be less than "inventory_max_age_seconds"`,
      file,
    )
  }
  return {
    id,
    base_url: optional(raw.base_url, 'string', `${site} "base_url"`, file),
    secret: raw.secret === undefined ? undefined : parseSecret(raw.secret, site, file),
    egress,
    wire: wireStr as Wire | undefined,
    disabled: parseDisable(raw, site, file),
    inventory_max_age_seconds: inventoryMaxAge,
    inventory_refresh_seconds: inventoryRefresh,
  }
}

function parseModel(value: unknown, index: number, file: string): ModelEntry {
  const posSite = `model[${index}]`
  const raw = requireTable(value, posSite, MODEL_KEYS, file)
  const id = requireString(raw.id, `${posSite} "id"`, file)
  return { id, ...parseCapabilities(raw, `model "${id}"`, file) }
}

function claimName(seen: Map<string, string>, name: string, site: string, file: string): void {
  const prior = seen.get(name)
  if (prior !== undefined) {
    throw new ParseError(`"${name}" is declared twice: ${prior} and ${site}`, file)
  }
  seen.set(name, site)
}

/** Every `id` in one table declared once. Tables are checked only against themselves: an engine, an upstream and a model may share a name. */
function checkCollisions(items: readonly { id: string }[], label: string, file: string): void {
  const seen = new Map<string, string>()
  for (const item of items) {
    claimName(seen, item.id, `${label} "${item.id}"`, file)
  }
}

/**
 * One chain's hops, minus any whose resolved (engine, upstream, model)
 * address is disabled -- through the engine, the upstream, or the route
 * itself. Split out of `parseChains` so each half is one job.
 */
function parseChainHops({
  name,
  hops,
  engines,
  routes,
  file,
}: {
  name: string
  hops: readonly string[]
  engines: readonly EngineEntry[]
  routes: readonly ResolvedRoute[]
  file: string
}): string[] {
  const kept: string[] = []
  for (const [i, hop] of hops.entries()) {
    // `@/<engine>/<model>` and `@/<engine>/<upstream>/<model>` are the only hop shapes.
    const segs = qualifiedSegments(hop)
    if (segs === undefined || segs.length === 1) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hop}" is not a fully-qualified "@/<engine>/<model>" or "@/<engine>/<upstream>/<model>" hop`,
        file,
      )
    }
    // `local` is a real upstream id, never an engine one: a hop names an
    // engine by its actual id, same as every other address form.
    const { engine: engineId, model, upstream } = parseHop(hop)
    if (!engines.some((e) => e.id === engineId)) {
      throw new ParseError(`chain hop "${hop}": engine "${engineId}" does not exist`, file)
    }
    if (model === WILDCARD_MODEL) {
      throw new ParseError(
        `chain "${name}"[${i}] "${hop}": "${WILDCARD_MODEL}" is the wildcard sentinel, not a served address`,
        file,
      )
    }
    const { candidates: declared, modelless } = chainHopRoutes(routes, hop)
    const route = routeForChainHop(routes, hop)
    if (route === undefined) {
      // A hop onto a disabled engine, upstream or route drops out rather than
      // failing parse: the point of disabling one is that the chains naming it
      // keep working on what is left. An address that names nothing at all,
      // or resolves to nothing served for any other reason, is still a parse
      // error.
      if (declared.length > 0 && declared.every((r) => r.disabled === true)) {
        continue
      }
      // Inventory is empty at boot: a hop onto a catalog id the operator has
      // not declared still parses when this engine+upstream carries a wildcard.
      // Dispatch refuses until the cache contains that wire id.
      if (!modelless && engineHasWildcard(routes, engineId, upstream)) {
        kept.push(hop)
        continue
      }
      throw new ParseError(
        modelless
          ? `chain "${name}"[${i}] "${hop}": "${engineId}" is modelless and has no route with upstream "${model}"`
          : `chain "${name}"[${i}] "${hop}": model "${model}" does not exist on "${engineId}"`,
        file,
      )
    }
    kept.push(hop)
  }
  return kept
}

interface RawChain {
  id: string
  hops: string[]
  disabled: boolean
}

function parseChainRaw(value: unknown, index: number, file: string): RawChain {
  const posSite = `chain[${index}]`
  const raw = requireTable(value, posSite, CHAIN_KEYS, file)
  const id = requireString(raw.id, `${posSite} "id"`, file)
  const site = `chain "${id}"`
  const hopsRaw = asArray(raw.hops, `${site} "hops"`, file)
  if (hopsRaw.length === 0) {
    throw new ParseError(`${site} has no hops`, file)
  }
  const hops = hopsRaw.map((h, i) => requireString(h, `${site} "hops[${i}]"`, file))
  return { id, hops, disabled: parseDisable(raw, site, file) === true }
}

function parseChains(
  raw: unknown,
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): Record<string, string[]> {
  const rawChains = asArray(raw, 'chain', file).map((c, i) => parseChainRaw(c, i, file))

  checkCollisions(rawChains, 'chain', file)

  const chains: Record<string, string[]> = {}
  for (const c of rawChains) {
    // A disabled chain is not served at all -- its own top-level flag, not a
    // resolved-hop question the way an engine/upstream/route's is.
    if (c.disabled) {
      continue
    }
    const hops = parseChainHops({ name: c.id, hops: c.hops, engines, routes, file })
    // Nothing left to route to: the chain goes with its hops rather than
    // resolving to an empty list a request would fall off the end of.
    if (hops.length > 0) {
      chains[c.id] = hops
    }
  }
  return chains
}

/**
 * `enginesRoot` defaults to the installed `engines/` tree so a production
 * `loadConfig()` call needs no argument; a test that ships its own fixture
 * specs passes one explicitly.
 */
export function loadConfig(path?: string, enginesRoot?: string): Config {
  const file = path ?? configPath()
  const root = enginesRoot ?? join(installDir(), 'engines')
  const raw = readConfigTable(file)

  const engines = asArray(raw.engine, 'engine', file).map((e, i) => parseEngine(e, i, file))
  checkCollisions(engines, 'engine', file)
  const engineMap = new Map(engines.map((e) => [e.id, e]))

  const upstreams = asArray(raw.upstream, 'upstream', file).map((u, i) => parseUpstream(u, i, file))
  checkCollisions(upstreams, 'upstream', file)
  const upstreamMap = new Map(upstreams.map((u) => [u.id, u]))

  const models = asArray(raw.model, 'model', file).map((m, i) => parseModel(m, i, file))
  checkCollisions(models, 'model', file)
  const modelMap = new Map(models.map((m) => [m.id, m]))

  const rawRoutes = asArray(raw.route, 'route', file).map((r, i) =>
    parseRouteRaw(r, i, file, engineMap),
  )

  const traitFor = cachedTraitFor(root)
  const routes = rawRoutes.map((r) =>
    resolveRoute({
      raw: r,
      allRaws: rawRoutes,
      engines: engineMap,
      upstreams: upstreamMap,
      models: modelMap,
      traitFor,
      file,
    }),
  )

  checkModellessMixing(routes, file)
  validateWildcardRoutes({ routes, engines: engineMap, upstreams: upstreamMap, traitFor, file })
  validateFilenameUnderModelsDir(routes, engineMap, file)
  validateKeepResident(engines, routes, file)
  validateModelsMax(engines, routes, file)
  validateVisionBridgeRoutes(routes, file)

  const chains = parseChains(raw.chain, engines, routes, file)

  return {
    ...parseTopLevelSettings(raw, file),
    engines,
    upstreams,
    routes,
    chains,
  }
}

/** The config file as a parsed TOML table; every read or parse failure is a ParseError naming the file. */
function readConfigTable(file: string): Record<string, unknown> {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    throw new ParseError('cannot read config', file, { cause: err })
  }

  let raw: unknown
  try {
    raw = Bun.TOML.parse(text)
  } catch (err) {
    throw new ParseError('invalid TOML', file, { cause: err })
  }
  if (!isRecord(raw)) {
    throw new ParseError('config must be a table', file)
  }
  return raw
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
): Pick<Config, 'listen_port' | 'cursor_port' | 'chat_timeout_seconds' | 'agent_timeout_seconds'> {
  return {
    listen_port:
      optional(raw.listen_port, 'number', 'config "listen_port"', file) ?? DEFAULT_LISTEN_PORT,
    cursor_port:
      optional(raw.cursor_port, 'number', 'config "cursor_port"', file) ?? DEFAULT_CURSOR_PORT,
    chat_timeout_seconds:
      optional(raw.chat_timeout_seconds, 'number', 'config "chat_timeout_seconds"', file) ??
      DEFAULT_CHAT_TIMEOUT_SECONDS,
    agent_timeout_seconds:
      optional(raw.agent_timeout_seconds, 'number', 'config "agent_timeout_seconds"', file) ??
      DEFAULT_AGENT_TIMEOUT_SECONDS,
  }
}
