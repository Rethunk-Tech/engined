/**
 * Cross-route checks that only run once every `[[route]]` has resolved: mixing
 * modelless and modelled routes on one engine, keep-resident occupancy, wildcard
 * catalogs, and a vision-bridge hop that must name a served vision route.
 */

import { existsSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'

import { parseHop } from './chain.ts'
import { DEFAULT_INVENTORY_REFRESH_SECONDS } from './configParse.ts'
import type { SpecFacts } from './configRoutes.ts'
import { ParseError } from './errors/parse.ts'
import { isUnder } from './paths.ts'
import { localRoutesOf, qualifiedSegments, routeForHop, WILDCARD_MODEL } from './routeAddress.ts'
import type { EngineEntry, ResolvedRoute, Upstream } from './types.ts'

/** The one rule that keeps a two-segment address single-valued: an engine is modelless routes or model-bearing ones, never both. */
export function checkModellessMixing(
  routes: readonly ResolvedRoute[],
  fileFor: (r: ResolvedRoute) => string,
): void {
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
        fileFor(r),
      )
    }
  }
}

export function validateFilenameUnderModelsDir(
  routes: readonly ResolvedRoute[],
  engines: Map<string, EngineEntry>,
  fileFor: (r: ResolvedRoute) => string,
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
    if (!isUnder(dir, target)) {
      throw new ParseError(`${label} "filename" is not under engine's "models_dir"`, fileFor(r))
    }
    if (!existsSync(target)) {
      throw new ParseError(`${label} "filename" does not exist at "${target}"`, fileFor(r))
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
  fileFor: (id: string) => string,
): void {
  for (const e of engines) {
    const pinned = localRoutesOf(routes, e.id).filter((r) => r.keep_resident === true)
    const byRole = new Map<string, string[]>()
    for (const r of pinned) {
      if (r.role === undefined) {
        throw new ParseError(
          `route on engine "${e.id}" model "${r.model ?? ''}" declares "keep_resident" but has no "role": nothing holds it resident`,
          fileFor(e.id),
        )
      }
      byRole.set(r.role, [...(byRole.get(r.role) ?? []), r.model ?? e.id])
    }
    for (const [role, ids] of byRole) {
      if (ids.length > 1) {
        throw new ParseError(
          `engine "${e.id}" role "${role}" has ${ids.length} routes declaring "keep_resident" (${ids.join(', ')}): only one model per role can be resident`,
          fileFor(e.id),
        )
      }
    }
  }
}

export function validateModelsMax(
  engines: readonly EngineEntry[],
  routes: readonly ResolvedRoute[],
  fileFor: (id: string) => string,
): void {
  for (const e of engines) {
    if (e.models_max === undefined) {
      continue
    }
    const roles = new Set(
      localRoutesOf(routes, e.id)
        .filter((r) => r.role)
        .map((r) => r.role),
    )
    if (e.models_max < roles.size) {
      throw new ParseError(
        `engine "${e.id}" "models_max" ${e.models_max} is below its ${roles.size} distinct configured roles`,
        fileFor(e.id),
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
  fileForRoute,
  fileForUpstream,
}: {
  routes: readonly ResolvedRoute[]
  engines: Map<string, EngineEntry>
  upstreams: Map<string, Upstream>
  traitFor: (engine: EngineEntry) => SpecFacts
  fileForRoute: (r: ResolvedRoute) => string
  fileForUpstream: (id: string) => string
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
        fileForRoute(r),
      )
    }
    if (r.upstream === null) {
      throw new ParseError(`${site} is a wildcard and must name an upstream`, fileForRoute(r))
    }
    named.add(r.upstream)
  }
  for (const id of named) {
    const u = upstreams.get(id)
    if (u?.inventory_max_age_seconds === undefined) {
      throw new ParseError(
        `upstream "${id}" is named by a wildcard route and is missing required "inventory_max_age_seconds"`,
        fileForUpstream(id),
      )
    }
    const refresh = u.inventory_refresh_seconds ?? DEFAULT_INVENTORY_REFRESH_SECONDS
    if (refresh >= u.inventory_max_age_seconds) {
      throw new ParseError(
        `upstream "${id}" "inventory_refresh_seconds" must be less than "inventory_max_age_seconds"`,
        fileForUpstream(id),
      )
    }
  }
}

/**
 * A route's own `role = "chat"` check (`parseRouteRaw`) cannot see across
 * routes, so the address itself is validated here, once every route has
 * resolved: it must be a fully-qualified hop, and it must resolve to an
 * enabled `role = "vision"` route -- the one shape `src/visionBridge.ts` can
 * actually dispatch to.
 */
export function validateVisionBridgeRoutes(
  routes: readonly ResolvedRoute[],
  fileFor: (r: ResolvedRoute) => string,
): void {
  for (const r of routes) {
    if (r.vision_bridge === undefined) {
      continue
    }
    const label = `route on engine "${r.engine}" model "${r.model ?? ''}"`
    const segs = qualifiedSegments(r.vision_bridge)
    if (segs === undefined || segs.length === 1) {
      throw new ParseError(
        `${label}: "vision_bridge" "${r.vision_bridge}" is not a fully-qualified "@/<engine>/<model>" address`,
        fileFor(r),
      )
    }
    const { engine, model, upstream } = parseHop(r.vision_bridge)
    const target = routeForHop(routes, engine, model, upstream)
    if (target === undefined || target.disabled === true) {
      throw new ParseError(
        `${label}: "vision_bridge" "${r.vision_bridge}" does not resolve to a served route`,
        fileFor(r),
      )
    }
    if (target.role !== 'vision') {
      throw new ParseError(
        `${label}: "vision_bridge" "${r.vision_bridge}" does not resolve to a role = "vision" route`,
        fileFor(r),
      )
    }
  }
}
