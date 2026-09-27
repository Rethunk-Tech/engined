/**
 * Resolving a declared route to the engine, upstream and model it actually
 * names, and refusing at parse time the ones the engine's own spec cannot
 * serve: a local file where the kind forbids one, a resident model outside the
 * models directory, or a mix of modelled and model-less routes on one engine.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, sep as pathSep, resolve as resolvePath } from 'node:path'

import {
  asArgs,
  DEFAULT_INVENTORY_REFRESH_SECONDS,
  expandConfigPath,
  mergeCapabilities,
  optional,
  parseCapabilities,
  parseDisable,
  ROLES,
  ROUTE_KEYS,
  requireString,
  requireTable,
  VISION_KINDS,
} from './configParse.ts'
import { ParseError } from './errors/parse.ts'
import type {
  EngineEntry,
  ModelCapabilities,
  ModelEntry,
  ResolvedRoute,
  Role,
  Upstream,
  UpstreamTrait,
  VisionKind,
} from './types.ts'
import {
  argKeysAsFlags,
  assertNoForbiddenFlags,
  isRecord,
  KIND_TRAITS,
  WILDCARD_MODEL,
} from './types.ts'

/** A route's shape before its `upstream` is defaulted -- that needs every other route on the same engine, which is not known until all of them have been parsed once. */
export interface RawRoute {
  engine: string
  model?: string
  wire_model?: string
  display_name?: string
  declaredUpstream?: string
  filename?: string
  role?: Role
  vision?: VisionKind
  translate?: boolean
  fim?: boolean
  keep_resident?: boolean
  streaming?: boolean
  slot_long_threshold?: number
  args: Record<string, unknown>
  disabledOwn: boolean
  capabilities: ModelCapabilities
  site: string
}

export function parseRouteRaw(
  value: unknown,
  index: number,
  file: string,
  engines: Map<string, EngineEntry>,
): RawRoute {
  const posSite = `route[${index}]`
  const raw = requireTable(value, posSite, ROUTE_KEYS, file)
  const engineId = requireString(raw.engine, `${posSite} "engine"`, file)
  const modelStr = optional(raw.model, 'string', `${posSite} "model"`, file)
  const site = `route[${index}] on engine "${engineId}"${modelStr === undefined ? '' : ` model "${modelStr}"`}`
  if (!engines.has(engineId)) {
    throw new ParseError(`${site} names unknown engine "${engineId}"`, file)
  }
  if (modelStr?.includes('/')) {
    throw new ParseError(
      `${site} has a "model" containing "/", which an address segment cannot express; give it a slash-free "model" and put the id its upstream actually knows in "wire_model"`,
      file,
    )
  }
  if (modelStr === WILDCARD_MODEL) {
    // A catalog expansion is not one model: local-file keys, a wire alias,
    // and per-route args would describe a SKU the operator has not named.
    for (const key of [
      'filename',
      'role',
      'vision',
      'translate',
      'fim',
      'keep_resident',
      'wire_model',
      'slot_long_threshold',
      'args',
    ] as const) {
      if (raw[key] !== undefined) {
        throw new ParseError(`${site} is a wildcard route and must not declare "${key}"`, file)
      }
    }
  }
  const wireModel = optional(raw.wire_model, 'string', `${site} "wire_model"`, file)
  const displayName =
    raw.display_name === undefined
      ? undefined
      : requireString(raw.display_name, `${site} "display_name"`, file)
  const rawFilename = optional(raw.filename, 'string', `${site} "filename"`, file)
  const roleStr = optional(raw.role, 'string', `${site} "role"`, file)
  if (roleStr !== undefined && !ROLES.includes(roleStr as Role)) {
    throw new ParseError(`${site} has invalid "role" "${roleStr}"`, file)
  }
  const visionStr = optional(raw.vision, 'string', `${site} "vision"`, file)
  if (visionStr !== undefined && !VISION_KINDS.includes(visionStr as VisionKind)) {
    throw new ParseError(`${site} has invalid "vision" "${visionStr}"`, file)
  }
  // Fatal rather than ignored: a `vision` on a chat route is someone believing
  // it does something, and a silently dropped key never corrects them.
  if (visionStr !== undefined && roleStr !== 'vision') {
    throw new ParseError(`${site} has "vision" but is not role = "vision"`, file)
  }
  // Required rather than defaulted, because the default was the wrong answer
  // for half the vision routes on this box. A reader model left undeclared is
  // sent the describe check and fails it while working correctly, and nothing
  // about that failure says the config is what is wrong. Refusing at parse is
  // the only place that can say so.
  if (roleStr === 'vision' && visionStr === undefined) {
    throw new ParseError(
      `${site} is role = "vision" and must declare "vision" ("describe" for a model that reads a scene back, "read" for one that recognises the characters in an image)`,
      file,
    )
  }
  const args = asArgs(raw.args, site, file)
  assertNoForbiddenFlags(argKeysAsFlags(args), file)
  const slotLongThreshold = optional(
    raw.slot_long_threshold,
    'number',
    `${site} "slot_long_threshold"`,
    file,
  )
  if (slotLongThreshold !== undefined && slotLongThreshold <= 0) {
    throw new ParseError(`${site} "slot_long_threshold" must be greater than 0`, file)
  }
  return {
    engine: engineId,
    model: modelStr,
    wire_model: wireModel,
    display_name: displayName,
    declaredUpstream: optional(raw.upstream, 'string', `${site} "upstream"`, file),
    filename: rawFilename === undefined ? undefined : expandConfigPath(rawFilename),
    role: roleStr as Role | undefined,
    vision: visionStr as VisionKind | undefined,
    translate: optional(raw.translate, 'boolean', `${site} "translate"`, file),
    fim: optional(raw.fim, 'boolean', `${site} "fim"`, file),
    keep_resident: optional(raw.keep_resident, 'boolean', `${site} "keep_resident"`, file),
    streaming: optional(raw.streaming, 'boolean', `${site} "streaming"`, file),
    slot_long_threshold: slotLongThreshold,
    args,
    disabledOwn: parseDisable(raw, site, file) === true,
    capabilities: parseCapabilities(raw, site, file),
    site,
  }
}

/** What a route's own validation needs to know about the engine it names, read from the one place that carries it. */
export interface SpecFacts {
  trait: UpstreamTrait
  /** A spec-full engine's kind, which config does not restate. `undefined` only when the config's own `kind` already answered. */
  kind?: string
}

/**
 * A spec-less engine's trait comes from the built-in table keyed by `kind`;
 * a spec-full one declares its own in `engines/<id>/spec.toml`, read directly
 * here rather than through the full `loadSpec` pipeline -- that pipeline also
 * substitutes placeholders and validates the read-only floor, none of which
 * this one flat key needs, and engine parsing must finish before spec loading
 * (`engines.ts`'s `buildEntries`) ever starts.
 */
export function specFactsFor(engine: EngineEntry, enginesRoot: string): SpecFacts {
  if (engine.kind !== undefined) {
    return { trait: KIND_TRAITS[engine.kind].upstream, kind: engine.kind }
  }
  const specDir = engine.spec_dir ?? join(enginesRoot, engine.id)
  const specFile = join(specDir, 'spec.toml')
  let raw: unknown
  try {
    raw = Bun.TOML.parse(readFileSync(specFile, 'utf8'))
  } catch (err) {
    throw new ParseError(
      `engine "${engine.id}": cannot read its spec to resolve an upstream trait`,
      specFile,
      { cause: err },
    )
  }
  const trait = isRecord(raw) ? raw.upstream : undefined
  if (trait !== 'self' && trait !== 'optional' && trait !== 'required') {
    throw new ParseError(
      `engine "${engine.id}": spec is missing required "upstream" ("self"|"optional"|"required")`,
      specFile,
    )
  }
  return { trait, kind: isRecord(raw) && typeof raw.kind === 'string' ? raw.kind : undefined }
}

/** Every upstream some OTHER route on this engine already names explicitly -- the basis a `required`-trait engine's own default is drawn from. */
function distinctDeclaredUpstreams(engineId: string, raws: readonly RawRoute[]): Set<string> {
  return new Set(
    raws
      .filter((r) => r.engine === engineId && r.declaredUpstream !== undefined)
      .map((r) => r.declaredUpstream as string),
  )
}

/**
 * By the engine's trait: `self` -> `"local"`, `optional` -> `null` (ambient),
 * `required` -> the one upstream every other route on this engine already
 * agrees on -- a `ParseError` naming what was found if there is zero or more
 * than one candidate, since there is no single answer to default to.
 */
function defaultUpstreamFor({
  engineId,
  trait,
  site,
  allRaws,
  file,
}: {
  engineId: string
  trait: UpstreamTrait
  site: string
  allRaws: readonly RawRoute[]
  file: string
}): string | null {
  if (trait === 'optional') {
    return null
  }
  if (trait === 'self') {
    return 'local'
  }
  const distinct = distinctDeclaredUpstreams(engineId, allRaws)
  if (distinct.size !== 1) {
    const names = [...distinct].join(', ') || 'none'
    throw new ParseError(
      `${site} names no "upstream" and engine "${engineId}" is "required" to have exactly one across its routes; found: ${names}`,
      file,
    )
  }
  return [...distinct][0] as string
}

/**
 * The parse-tier half of the filename/role/args split: everything decidable
 * without `kind`, which is not known until specs load in `engines.ts`'s
 * `buildEntries`. That is where the kind-dependent half of this same
 * question -- whisper requires `filename` and forbids `role`, llama requires
 * both -- is checked instead.
 */
function localFileForbiddenReason(
  model: string | undefined,
  upstreamId: string | null,
  engine: EngineEntry,
): string | undefined {
  if (model === undefined) {
    return 'there is no model whose weights they could describe'
  }
  if (upstreamId !== 'local') {
    return 'a route proxied elsewhere has no local file to describe'
  }
  if (engine.models_dir === undefined) {
    return `engine "${engine.id}" has no local model store to host it`
  }
  return undefined
}

export function resolveRoute({
  raw,
  allRaws,
  engines,
  upstreams,
  models,
  traitFor,
  file,
}: {
  raw: RawRoute
  allRaws: readonly RawRoute[]
  engines: Map<string, EngineEntry>
  upstreams: Map<string, Upstream>
  models: Map<string, ModelEntry>
  traitFor: (engine: EngineEntry) => SpecFacts
  file: string
}): ResolvedRoute {
  const engine = engines.get(raw.engine) as EngineEntry
  const upstreamId =
    raw.declaredUpstream === undefined
      ? defaultUpstreamFor({
          engineId: raw.engine,
          trait: traitFor(engine).trait,
          site: raw.site,
          allRaws,
          file,
        })
      : raw.declaredUpstream
  if (upstreamId !== null && !upstreams.has(upstreamId)) {
    throw new ParseError(`${raw.site} names unknown upstream "${upstreamId}"`, file)
  }
  const upstream = upstreamId === null ? undefined : upstreams.get(upstreamId)

  const reason = localFileForbiddenReason(raw.model, upstreamId, engine)
  if (reason !== undefined) {
    if (raw.filename !== undefined) {
      throw new ParseError(`${raw.site} must not declare "filename": ${reason}`, file)
    }
    if (raw.role !== undefined) {
      throw new ParseError(`${raw.site} must not declare "role": ${reason}`, file)
    }
    // A comfy route is the exception, and only for args: it is modelless, so
    // there is no GGUF for these to describe, but `POST /openai/v1/images/
    // generations` reads them as the checkpoint names its shipped graph loads.
    // `filename` and `role` above stay forbidden -- those really are about a
    // local weights file, and comfy has none.
    if (Object.keys(raw.args).length > 0 && traitFor(engine).kind !== 'comfy') {
      throw new ParseError(`${raw.site} declares "args" that nothing reads: ${reason}`, file)
    }
  }

  const baseCaps = raw.model === undefined ? {} : (models.get(raw.model) ?? {})
  const disabled =
    raw.disabledOwn || engine.disabled === true || upstream?.disabled === true ? true : undefined

  return {
    engine: raw.engine,
    model: raw.model,
    wire_model: raw.wire_model,
    display_name: raw.display_name,
    upstream: upstreamId,
    filename: raw.filename,
    role: raw.role,
    vision: raw.vision,
    translate: raw.translate,
    fim: raw.fim,
    keep_resident: raw.keep_resident,
    streaming: raw.streaming,
    slot_long_threshold: raw.slot_long_threshold,
    args: raw.args,
    disabled,
    ...mergeCapabilities(baseCaps, roleCapabilities(raw.role), raw.capabilities),
  }
}

/**
 * What a role already says about a route's modalities, so a consumer reading
 * the door sees it without a hand-written `[[model]]` row: a `vision` route
 * takes images, a `chat` route takes text, both answer in text. An embedding
 * route says nothing here -- its output is not a modality a caller sends.
 */
function roleCapabilities(role: Role | undefined): ModelCapabilities {
  if (role === 'vision') {
    return { input: ['text', 'image'], output: ['text'] }
  }
  if (role === 'chat') {
    return { input: ['text'], output: ['text'] }
  }
  return {}
}

/** The one rule that keeps a two-segment address single-valued: an engine is modelless routes or model-bearing ones, never both. */
export function checkModellessMixing(routes: readonly ResolvedRoute[], file: string): void {
  const seen = new Map<string, boolean>()
  for (const r of routes) {
    const modelless = r.model === undefined
    const prior = seen.get(r.engine)
    if (prior === undefined) {
      seen.set(r.engine, modelless)
      continue
    }
    if (prior !== modelless) {
      throw new ParseError(
        `engine "${r.engine}" carries both a modelless route and a model-bearing route; an engine must be one or the other`,
        file,
      )
    }
  }
}

export function validateFilenameUnderModelsDir(
  routes: readonly ResolvedRoute[],
  engines: Map<string, EngineEntry>,
  file: string,
): void {
  for (const r of routes) {
    if (r.filename === undefined) {
      continue
    }
    const engine = engines.get(r.engine)
    if (engine?.models_dir === undefined) {
      continue
    }
    const dir = resolvePath(engine.models_dir)
    const target = resolvePath(dir, r.filename)
    const label = `route on engine "${engine.id}" model "${r.model ?? ''}"`
    if (target !== dir && !target.startsWith(dir + pathSep)) {
      throw new ParseError(`${label} "filename" is not under engine's "models_dir"`, file)
    }
    if (!existsSync(target)) {
      throw new ParseError(`${label} "filename" does not exist at "${target}"`, file)
    }
  }
}

/**
 * Both of these are unsatisfiable rather than merely unwise, so they are fatal
 * here instead of surprising at runtime: occupancy is one model per role.
 * Filtered on `(engine, upstream === "local")`: a route proxied to a peer's
 * llama has nothing resident on this box to hold a lease over.
 *
 * There is deliberately no check against `models_max`. Every pinned role has
 * a route, `validateModelsMax` already refuses a `models_max` below the
 * engine's distinct local role count, and the pinned roles are a subset of
 * those -- so a pinned set can never exceed it, and a guard here would be
 * unreachable.
 */
export function validateKeepResident(
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): void {
  for (const e of engines) {
    const pinned = routes.filter(
      (r) => r.engine === e.id && r.upstream === 'local' && r.keep_resident === true,
    )
    const byRole = new Map<string, string[]>()
    for (const r of pinned) {
      if (r.role === undefined) {
        throw new ParseError(
          `route on engine "${e.id}" model "${r.model ?? ''}" declares "keep_resident" but has no "role": nothing holds it resident`,
          file,
        )
      }
      byRole.set(r.role, [...(byRole.get(r.role) ?? []), r.model ?? e.id])
    }
    for (const [role, ids] of byRole) {
      if (ids.length > 1) {
        throw new ParseError(
          `engine "${e.id}" role "${role}" has ${ids.length} routes declaring "keep_resident" (${ids.join(', ')}): only one model per role can be resident`,
          file,
        )
      }
    }
  }
}

export function validateModelsMax(
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  file: string,
): void {
  for (const e of engines) {
    if (e.models_max === undefined) {
      continue
    }
    const roles = new Set(
      routes
        .filter((r) => r.engine === e.id && r.upstream === 'local' && r.role)
        .map((r) => r.role),
    )
    if (e.models_max < roles.size) {
      throw new ParseError(
        `engine "${e.id}" "models_max" ${e.models_max} is below its ${roles.size} distinct configured roles`,
        file,
      )
    }
  }
}

/** Whether this engine (and, when given, this upstream) carries an enabled catalog wildcard. */
export function engineHasWildcard(
  routes: readonly ResolvedRoute[],
  engineId: string,
  upstream?: string,
): boolean {
  return routes.some(
    (r) =>
      r.engine === engineId &&
      r.model === WILDCARD_MODEL &&
      r.disabled !== true &&
      (upstream === undefined || r.upstream === upstream),
  )
}

/**
 * A wildcard is a remote openai-http catalog, not a local store or another
 * kind: llama, media and agentic have no provider `/models` list to expand.
 * Max age is required on every upstream a wildcard names -- without it a
 * failed fetch has no bound at which to drop the cache.
 */
export function validateWildcardRoutes({
  routes,
  engines,
  upstreams,
  traitFor,
  file,
}: {
  routes: readonly ResolvedRoute[]
  engines: Map<string, EngineEntry>
  upstreams: Map<string, Upstream>
  traitFor: (engine: EngineEntry) => SpecFacts
  file: string
}): void {
  const named = new Set<string>()
  for (const r of routes) {
    if (r.model !== WILDCARD_MODEL) {
      continue
    }
    const engine = engines.get(r.engine) as EngineEntry
    const kind = engine.kind ?? traitFor(engine).kind
    const site = `route on engine "${r.engine}" model "${WILDCARD_MODEL}"`
    if (engine.models_dir !== undefined || kind !== 'openai-http') {
      throw new ParseError(
        `${site} is a wildcard and only a remote openai-http engine may carry one`,
        file,
      )
    }
    if (r.upstream === null) {
      throw new ParseError(`${site} is a wildcard and must name an upstream`, file)
    }
    named.add(r.upstream)
  }
  for (const id of named) {
    const u = upstreams.get(id)
    if (u?.inventory_max_age_seconds === undefined) {
      throw new ParseError(
        `upstream "${id}" is named by a wildcard route and is missing required "inventory_max_age_seconds"`,
        file,
      )
    }
    const refresh = u.inventory_refresh_seconds ?? DEFAULT_INVENTORY_REFRESH_SECONDS
    if (refresh >= u.inventory_max_age_seconds) {
      throw new ParseError(
        `upstream "${id}" "inventory_refresh_seconds" must be less than "inventory_max_age_seconds"`,
        file,
      )
    }
  }
}
