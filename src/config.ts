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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { argKeysAsFlags, assertNoForbiddenFlags } from './agenticArgs.ts'
import { chainHopRoutes, parseHop, routeForChainHop } from './chain.ts'
import {
  asArgs,
  asArray,
  assertKnownKeys,
  CHAIN_KEYS,
  ENGINE_KEYS,
  expandConfigPath,
  MODEL_KEYS,
  optional,
  optionalPositive,
  optionalTimeoutSeconds,
  parseCapabilities,
  parseDisable,
  parsePort,
  parsePositiveInteger,
  requireString,
  requireTable,
  SECRET_KEYS,
  TOP_KEYS,
  UPSTREAM_KEYS,
} from './configParse.ts'
import { parseRouteRaw, resolveRoute, type SpecFacts, specFactsFor } from './configRoutes.ts'
import {
  checkModellessMixing,
  engineHasWildcard,
  validateFilenameUnderModelsDir,
  validateKeepResident,
  validateModelsMax,
  validateVisionBridgeRoutes,
  validateWildcardRoutes,
} from './configRouteValidate.ts'
import { DEFAULT_IDLE_STOP_SECONDS, DEFAULT_READY_TIMEOUT_S } from './engineEntries.ts'
import { ParseError } from './errors/parse.ts'
import { configPath, installDir } from './paths.ts'
import { isRecord } from './records.ts'
import { LOCAL_UPSTREAM, qualifiedSegments, WILDCARD_MODEL } from './routeAddress.ts'
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
import { EGRESS_RANK, isEgress, KIND_TRAITS } from './types.ts'

const DEFAULT_LISTEN_PORT = 29_200
/**
 * The Cursor turn stream is bidirectional and needs HTTP/2, which the main
 * cleartext door does not speak, so it gets its own h2c listener. A TLS
 * terminator in front routes `/agent.v1.AgentService/Run` here.
 */
const DEFAULT_CURSOR_PORT = 29_201
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600
const DEFAULT_STREAM_STALL_SECONDS = 60
const DEFAULT_AGENTIC_CONCURRENCY = 4

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

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * An engine or upstream id becomes a state path (llama/<id>/preset.ini,
 * upstreams/<id>/inventory.json), so `/`, `..` or a leading dot must never
 * reach a join.
 */
function requireId(value: unknown, posSite: string, file: string): string {
  const id = requireString(value, `${posSite} "id"`, file)
  if (!ID_RE.test(id)) {
    throw new ParseError(`${posSite} "id" "${id}" must match ${ID_RE}`, file)
  }
  return id
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
    kind: parseKind(raw, site, file),
    args,
  }
}

function parseUpstream(value: unknown, index: number, file: string): Upstream {
  const posSite = `upstream[${index}]`
  const raw = requireTable(value, posSite, UPSTREAM_KEYS, file)
  const id = requireId(raw.id, posSite, file)
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
  if (id === LOCAL_UPSTREAM && (raw.base_url !== undefined || raw.secret !== undefined)) {
    throw new ParseError(
      `${site} is reserved for this box and cannot carry "base_url" or "secret"`,
      file,
    )
  }
  const wireStr = optional(raw.wire, 'string', `${site} "wire"`, file)
  if (wireStr !== undefined && wireStr !== 'openai' && wireStr !== 'anthropic') {
    throw new ParseError(`${site} has invalid "wire" "${wireStr}"`, file)
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
      file,
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
  }
}

function parseUpstreamHeaders(
  v: unknown,
  site: string,
  file: string,
  secretHeader: string | undefined,
): Record<string, string> | undefined {
  if (v === undefined) {
    return
  }
  if (!isRecord(v)) {
    throw new ParseError(`${site} "headers" must be a table`, file)
  }
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string') {
      throw new ParseError(`${site} "headers" key "${key}" must be a string`, file)
    }
    const lower = key.toLowerCase()
    if (lower === 'host') {
      throw new ParseError(`${site} "headers" must not set "Host"`, file)
    }
    if (secretHeader !== undefined && lower === secretHeader.toLowerCase()) {
      throw new ParseError(
        `${site} "headers" must not set "${key}": that header is set from "secret"`,
        file,
      )
    }
    out[key] = value
  }
  return out
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
  label: string,
): void {
  const seen = new Map<string, string>()
  for (const [i, item] of items.entries()) {
    const file = files[i] as string
    const prior = seen.get(item.id)
    if (prior !== undefined) {
      throw new ParseError(
        `${label} "${item.id}" is declared twice: also declared in ${prior}`,
        file,
      )
    }
    seen.set(item.id, file)
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

function buildChains(
  rawChains: readonly RawChain[],
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  chainFiles: readonly string[],
): Record<string, string[]> {
  const chains: Record<string, string[]> = Object.create(null)
  for (const [i, c] of rawChains.entries()) {
    // A disabled chain is not served at all -- its own top-level flag, not a
    // resolved-hop question the way an engine/upstream/route's is.
    if (c.disabled) {
      continue
    }
    const hops = parseChainHops({
      name: c.id,
      hops: c.hops,
      engines,
      routes,
      file: chainFiles[i] as string,
    })
    // Nothing left to route to: the chain goes with its hops rather than
    // resolving to an empty list a request would fall off the end of.
    if (hops.length > 0) {
      chains[c.id] = hops
    }
  }
  return chains
}

/** One `[[table]]` array plus which file each of its parsed entries came from -- what a collision or a cross-entry check needs to name the right fragment. */
interface Collected<T> {
  items: T[]
  files: string[]
}

/**
 * Parses one array key (`engine`, `upstream`, ...) out of every source in
 * order -- the main file first, then each `config.d` fragment in sorted
 * filename order -- so the merged result reads exactly as if all the arrays
 * had been declared in one file, while every parse error still names the
 * fragment it came from.
 */
function collectEntries<T>(
  sources: readonly ConfigSource[],
  key: string,
  parseOne: (value: unknown, index: number, file: string) => T,
): Collected<T> {
  const items: T[] = []
  const files: string[] = []
  for (const { file, raw } of sources) {
    for (const [i, value] of asArray(raw[key], key, file).entries()) {
      items.push(parseOne(value, i, file))
      files.push(file)
    }
  }
  return { items, files }
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

  const { items: engines, files: engineFiles } = collectEntries(sources, 'engine', parseEngine)
  checkCollisions(engines, engineFiles, 'engine')
  const engineMap = new Map(engines.map((e) => [e.id, e]))

  const { items: upstreams, files: upstreamFiles } = collectEntries(
    sources,
    'upstream',
    parseUpstream,
  )
  checkCollisions(upstreams, upstreamFiles, 'upstream')
  const upstreamMap = new Map(upstreams.map((u) => [u.id, u]))

  const { items: models, files: modelFiles } = collectEntries(sources, 'model', parseModel)
  checkCollisions(models, modelFiles, 'model')
  const modelMap = new Map(models.map((m) => [m.id, m]))

  const { items: rawRoutes, files: routeFiles } = collectEntries(sources, 'route', (v, i, f) =>
    parseRouteRaw(v, i, f, engineMap),
  )

  const traitFor = cachedTraitFor(root)
  const routes = rawRoutes.map((r, i) =>
    resolveRoute({
      raw: r,
      allRaws: rawRoutes,
      engines: engineMap,
      upstreams: upstreamMap,
      models: modelMap,
      traitFor,
      file: routeFiles[i] as string,
    }),
  )

  // Each check names the file the offending entry actually came from, so a
  // bad route or engine in a config.d fragment is reported against that
  // fragment rather than the main file.
  const routeFileOf = new Map<ResolvedRoute, string>(
    routes.map((r, i) => [r, routeFiles[i] as string]),
  )
  const engineFileOf = new Map<string, string>(
    engines.map((e, i) => [e.id, engineFiles[i] as string]),
  )
  const upstreamFileOf = new Map<string, string>(
    upstreams.map((u, i) => [u.id, upstreamFiles[i] as string]),
  )
  const fileForRoute = (r: ResolvedRoute) => routeFileOf.get(r) ?? file
  const fileForEngine = (id: string) => engineFileOf.get(id) ?? file
  const fileForUpstream = (id: string) => upstreamFileOf.get(id) ?? file

  checkModellessMixing(routes, fileForRoute)
  validateWildcardRoutes({
    routes,
    engines: engineMap,
    upstreams: upstreamMap,
    traitFor,
    fileForRoute,
    fileForUpstream,
  })
  validateFilenameUnderModelsDir(routes, engineMap, fileForRoute)
  validateKeepResident(engines, routes, fileForEngine)
  validateModelsMax(engines, routes, fileForEngine)
  validateVisionBridgeRoutes(routes, fileForRoute)

  const { items: rawChains, files: chainFiles } = collectEntries(sources, 'chain', parseChainRaw)
  checkCollisions(rawChains, chainFiles, 'chain')
  const chains = buildChains(rawChains, engines, routes, chainFiles)

  return {
    ...parseTopLevelSettings(mainRaw, file),
    engines,
    upstreams,
    routes,
    chains,
  }
}

/** Scalar keys that only the main config file may carry -- everything else in `TOP_KEYS` is one of the five arrays a fragment may also extend. */
const FRAGMENT_TABLE_KEYS = new Set(['engine', 'upstream', 'model', 'route', 'chain'])

/** A parsed source file plus the raw table it produced, in the order its entries merge. */
interface ConfigSource {
  file: string
  raw: Record<string, unknown>
}

/**
 * `config.d/*.toml` beside the main file, sorted by filename -- the same
 * order their `[[engine]]`/etc. arrays are appended in. A missing directory
 * is normal and silent, since most installs have no fragments at all.
 */
function fragmentFiles(mainFile: string): string[] {
  const dir = join(dirname(mainFile), 'config.d')
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return []
    }
    throw new ParseError('cannot read config.d', dir, { cause: err })
  }
  return (
    names
      // A dotfile is an editor's lock or swap file (Emacs `.#foo.toml` is a
      // dangling symlink), never a fragment someone meant to load.
      .filter((name) => name.endsWith('.toml') && !name.startsWith('.'))
      .sort()
      .map((name) => join(dir, name))
  )
}

/**
 * The main config plus every `config.d` fragment, each read and key-checked
 * on its own: the main file against the full `TOP_KEYS`, a fragment against
 * only the five array keys, since a fragment scalar like `listen_port` would
 * silently shadow or fight the main file's depending on merge order.
 */
function readConfigSources(mainFile: string): ConfigSource[] {
  const mainRaw = readConfigTable(mainFile)
  assertKnownKeys(mainRaw, 'config', TOP_KEYS, mainFile)
  const sources: ConfigSource[] = [{ file: mainFile, raw: mainRaw }]
  for (const fragFile of fragmentFiles(mainFile)) {
    const fragRaw = readConfigTable(fragFile)
    assertKnownKeys(fragRaw, 'config.d fragment', FRAGMENT_TABLE_KEYS, fragFile)
    sources.push({ file: fragFile, raw: fragRaw })
  }
  return sources
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
): Pick<
  Config,
  | 'listen_port'
  | 'cursor_port'
  | 'chat_timeout_seconds'
  | 'agent_timeout_seconds'
  | 'stream_stall_seconds'
  | 'agentic_concurrency'
> {
  const listenPort = parsePort(raw.listen_port, 'config "listen_port"', file, DEFAULT_LISTEN_PORT)
  const cursorPort = parsePort(raw.cursor_port, 'config "cursor_port"', file, DEFAULT_CURSOR_PORT)
  if (listenPort === cursorPort) {
    throw new ParseError('config "listen_port" and "cursor_port" must differ', file)
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
  }
}
