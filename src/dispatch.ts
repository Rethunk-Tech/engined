/**
 * Resolves an OpenAI `model` string to a route for one door endpoint. Pure
 * over `Config` and the registry's `get`/`serves`/`entry` so it is testable
 * without `Bun.serve` or docker.
 */

import { chainHopRoutes } from './chain.ts'
import { groupCursorModels, resolveCursorVariant } from './cursorModels.ts'
import type { DoorContext } from './doorContext.ts'
import type { EngineRegistry } from './engines.ts'
import { jsonError, STATUS_BAD_REQUEST } from './http.ts'
import { decodeAddressSegment, encodeAddressSegment, type Inventory } from './inventory.ts'
import { qualifiedSegments, routeForHop, WILDCARD_MODEL } from './routeAddress.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  routeServes,
} from './routeServes.ts'
import type { Config, Egress, ResolvedRoute } from './types.ts'
import { EGRESS_RANK } from './types.ts'

type ModelDispatch =
  | { ok: true; kind: 'model'; route: ResolvedRoute }
  | { ok: false; error: string }

export type Dispatch =
  | ModelDispatch
  | { ok: true; kind: 'chain'; chain: string; hops: readonly string[] }

/** Everything one resolution reads. No `endpoint` skips the serves check: starting a container asks nothing about which door path the engine answers. `body` is the caller's own JSON, read only for the cursor engine's `reasoning_effort`/`service_tier` -- absent for every caller (start, audio, images) that never carries either. */
interface ResolveCtx {
  endpoint?: string
  config: Config
  registry: EngineRegistry
  body?: Record<string, unknown>
}

const CURSOR_ENGINE_ID = 'cursor'

/**
 * `@/cursor/<base>` collapses Cursor's own flat, per-reasoning-level model
 * ids onto one address per base (`modelsMenu.ts` builds the menu row this
 * mirrors). `reasoning_effort` and `service_tier` pick which of the base's
 * real, still-literal routes actually answers -- so this runs ahead of the
 * plain exact-model-string lookup below, which would otherwise hand every
 * request for a base the same bare/default variant regardless of what the
 * caller asked for. `thinking` (this door's own request extension, absent
 * by default) breaks the tie on a base where a plain and a `-thinking`
 * sibling share the same effort word -- `cursorModels.ts`'s own
 * `resolveCursorVariant` is where that selection actually happens.
 *
 * Gated on every one of this engine's routes being ambient (`upstream ===
 * null`, cursor's own shape): a config that instead points an engine literally
 * named "cursor" at a real upstream is a different engine in every way that
 * matters here, and must not have its own model ids swallowed by this.
 */
function resolveCursorBase(
  engineRoutes: readonly ResolvedRoute[],
  seg: string,
  body: Record<string, unknown> | undefined,
): ResolvedRoute | undefined {
  const served = engineRoutes.filter((r) => !r.disabled && r.model !== undefined)
  if (served.length === 0 || !served.every((r) => r.upstream === null)) {
    return undefined
  }
  const groups = groupCursorModels(served.map((r) => r.model as string))
  const group = groups.get(seg)
  if (group === undefined) {
    return undefined
  }
  const reasoningEffort =
    typeof body?.reasoning_effort === 'string' ? body.reasoning_effort : undefined
  const serviceTier = typeof body?.service_tier === 'string' ? body.service_tier : undefined
  const thinking = typeof body?.thinking === 'boolean' ? body.thinking : undefined
  const picked = resolveCursorVariant(group, { reasoningEffort, serviceTier, thinking })
  return picked === undefined ? undefined : served.find((r) => r.model === picked.id)
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error }
}

/** `engine.serves(endpoint)`, or the model-less form when the route has no model. The one funnel every resolved dispatch passes through, so the disabled check lives here rather than in each resolver. */
function withEndpointCheck(route: ResolvedRoute, ctx: ResolveCtx): ModelDispatch {
  const { engine, model } = route
  if (ctx.registry.entry(engine)?.disabled) {
    return fail(`engine "${engine}" is disabled in config`)
  }
  if (
    ctx.endpoint !== undefined &&
    !routeServes(route, ctx.registry.serves(engine)).includes(ctx.endpoint)
  ) {
    const what = model === undefined ? `engine "${engine}"` : `"@/${engine}/${model}"`
    return fail(`${what} does not serve ${ctx.endpoint}`)
  }
  return { ok: true, kind: 'model', route }
}

/** Where this route's bytes travel. Ambient (`upstream === null`) is `"remote"`, matching `Upstream`'s own doc: no upstream leaves the box the same as any other network call. */
export function routeEgress(route: ResolvedRoute, config: Config): Egress {
  if (route.upstream === null) {
    return 'remote'
  }
  return config.upstreams.find((u) => u.id === route.upstream)?.egress ?? 'remote'
}

/**
 * `@/<model>`: the highest-preference route naming this model, across every
 * engine. Ordered local -> `lan` -> `remote` -> declaration, and resolved to
 * exactly ONE route -- it does not walk on failure. A caller wanting
 * fallback across candidates writes a chain instead.
 */
function resolveOneSegment(model: string, ctx: ResolveCtx): ModelDispatch {
  const candidates = ctx.config.routes.filter((r) => !r.disabled && r.model === model)
  if (candidates.length === 0) {
    return fail(`model "${model}" does not exist`)
  }
  const [winner] = [...candidates].sort(
    (a, b) => EGRESS_RANK[routeEgress(a, ctx.config)] - EGRESS_RANK[routeEgress(b, ctx.config)],
  )
  return withEndpointCheck(winner as ResolvedRoute, ctx)
}

/**
 * `@/<engine>/<seg>`: engine+model normally, or engine+upstream when this
 * engine's own routes declare no model at all -- read from the engine's
 * declaration, never from whether `seg` happens to match an upstream id.
 * That stays single-valued only because config parse refuses an engine that
 * mixes modelless and model-bearing routes.
 */
function resolveTwoSegments(engineSeg: string, seg: string, ctx: ResolveCtx): ModelDispatch {
  if (!ctx.config.engines.some((e) => e.id === engineSeg)) {
    return fail(`"@/${engineSeg}/${seg}": engine "${engineSeg}" does not exist`)
  }
  // Ahead of the route lookup, which would otherwise report a disabled
  // engine's dropped routes as routes that never existed.
  if (ctx.registry.entry(engineSeg)?.disabled) {
    return fail(`engine "${engineSeg}" is disabled in config`)
  }
  const engineRoutes = ctx.config.routes.filter((r) => r.engine === engineSeg)
  if (engineSeg === CURSOR_ENGINE_ID) {
    const cursorRoute = resolveCursorBase(engineRoutes, seg, ctx.body)
    if (cursorRoute !== undefined) {
      return withEndpointCheck(cursorRoute, ctx)
    }
  }
  const { candidates, modelless } = chainHopRoutes(engineRoutes, `@/${engineSeg}/${seg}`)
  if (modelless) {
    const route = candidates.find((r) => !r.disabled)
    if (!route) {
      return fail(`"@/${engineSeg}/${seg}": no route on "${engineSeg}" with upstream "${seg}"`)
    }
    return withEndpointCheck(route, ctx)
  }
  const matches = candidates.filter((r) => !r.disabled)
  if (matches.length === 0) {
    const invented = resolveServedRoute({
      config: ctx.config,
      engineId: engineSeg,
      modelSeg: seg,
      inventory: ctx.registry.inventory,
    })
    if (invented !== undefined) {
      return withEndpointCheck(invented, ctx)
    }
    return fail(`"@/${engineSeg}/${seg}": model "${seg}" does not exist on "${engineSeg}"`)
  }
  const route = routeForHop(engineRoutes, engineSeg, seg)
  if (route === undefined) {
    const qualified = matches.map((r) => `@/${engineSeg}/${r.upstream}/${seg}`).join(', ')
    return fail(`"@/${engineSeg}/${seg}" is ambiguous across upstreams; use one of: ${qualified}`)
  }
  return withEndpointCheck(route, ctx)
}

/** The wildcard template on this engine, optionally pinned to one upstream. */
function wildcardTemplate(
  routes: readonly ResolvedRoute[],
  engineId: string,
  upstream?: string,
): ResolvedRoute | undefined {
  const wild = routes.filter(
    (r) => r.disabled !== true && r.engine === engineId && r.model === WILDCARD_MODEL,
  )
  if (upstream !== undefined) {
    return wild.find((r) => r.upstream === upstream)
  }
  return wild.length === 1 ? wild[0] : undefined
}

/**
 * Declared routes win. A miss against a catalog wildcard becomes a
 * synthesized route only when the cache already lists that wire id -- empty
 * inventory is a 400, not a parse failure.
 */
export function resolveServedRoute({
  config,
  engineId,
  modelSeg,
  upstreamSeg,
  inventory,
}: {
  config: Config
  engineId: string
  modelSeg: string
  upstreamSeg?: string
  inventory: Inventory
}): ResolvedRoute | undefined {
  if (modelSeg === '' || modelSeg === WILDCARD_MODEL) {
    return
  }
  const declared = routeForHop(config.routes, engineId, modelSeg, upstreamSeg)
  if (declared !== undefined) {
    return declared
  }
  const template = wildcardTemplate(config.routes, engineId, upstreamSeg)
  if (template === undefined || template.upstream === null) {
    return
  }
  const upstream = config.upstreams.find((u) => u.id === template.upstream)
  if (upstream === undefined) {
    return
  }
  const wireId = decodeAddressSegment(modelSeg)
  if (encodeAddressSegment(wireId) !== modelSeg) {
    return
  }
  if (!inventory.peek(upstream).includes(wireId)) {
    return
  }
  return { ...template, model: modelSeg, wire_model: wireId }
}

/** `@/<engine>/<upstream>/<model>`: fully explicit, the one form with no default to apply. */
function resolveThreeSegments(
  engineSeg: string,
  upstreamSeg: string,
  modelSeg: string,
  ctx: ResolveCtx,
): ModelDispatch {
  if (!ctx.config.engines.some((e) => e.id === engineSeg)) {
    return fail(`"@/${engineSeg}/${upstreamSeg}/${modelSeg}": engine "${engineSeg}" does not exist`)
  }
  if (ctx.registry.entry(engineSeg)?.disabled) {
    return fail(`engine "${engineSeg}" is disabled in config`)
  }
  const route = routeForHop(ctx.config.routes, engineSeg, modelSeg, upstreamSeg)
  if (!route) {
    const invented = resolveServedRoute({
      config: ctx.config,
      engineId: engineSeg,
      modelSeg,
      upstreamSeg,
      inventory: ctx.registry.inventory,
    })
    if (invented !== undefined) {
      return withEndpointCheck(invented, ctx)
    }
    return fail(
      `"@/${engineSeg}/${upstreamSeg}/${modelSeg}": model "${modelSeg}" does not exist on "${engineSeg}"/"${upstreamSeg}"`,
    )
  }
  return withEndpointCheck(route, ctx)
}

/** A `@/...` address by segment count. Exported for `/engined/v1/start`, which resolves the same two- and three-segment forms with no endpoint to check. */
export function resolveQualified(segments: readonly string[], ctx: ResolveCtx): ModelDispatch {
  if (segments.includes(WILDCARD_MODEL)) {
    return fail(`"${WILDCARD_MODEL}" is the wildcard sentinel, not a served address`)
  }
  const [first, second, third] = segments
  if (segments.length === 1) {
    return resolveOneSegment(first as string, ctx)
  }
  if (segments.length === 2) {
    return resolveTwoSegments(first as string, second as string, ctx)
  }
  return resolveThreeSegments(first as string, second as string, third as string, ctx)
}

/**
 * The endpoints a fallback list means anything on. Embeddings are absent
 * deliberately: a vector from a second engine is not interchangeable with the
 * first's, so falling back would answer with something the caller cannot
 * compare against what it already stored.
 *
 * Rerank is absent for a weaker reason and a stronger one. The weak reason is
 * that a second reranker's scores are on its own scale, which matters only to
 * a caller comparing them across calls -- an ordering over the caller's own
 * documents survives the fallback intact. The strong one is that nothing has
 * asked: no consumer sends rerank through a chain, so admitting it here would
 * ship an untested path. One line adds it when one does.
 *
 * Whether each individual hop serves the endpoint is not checked here. A chain
 * advances past a hop it cannot use, so a hop that does not serve this endpoint
 * fails as itself and the next one is tried -- and if none serves it, the
 * caller gets every hop's own reason rather than one sentence about the chain.
 */
export const CHAIN_ENDPOINTS: ReadonlySet<string> = new Set([
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
])

/** Chain hops by caller id. `Object.hasOwn` so inherited Object keys never resolve as chains. */
export function hopsOfChain(config: Config, id: string): string[] | undefined {
  return Object.hasOwn(config.chains, id) ? config.chains[id] : undefined
}

function resolveChain(model: string, endpoint: string, config: Config): Dispatch | undefined {
  const hops = hopsOfChain(config, model)
  if (hops === undefined) {
    return
  }
  if (!CHAIN_ENDPOINTS.has(endpoint)) {
    return fail(`chain "${model}" does not serve ${endpoint}`)
  }
  return { ok: true, kind: 'chain', chain: model, hops }
}

/**
 * `model` resolution for one door endpoint. A caller that has not said where
 * its prompt should run has not said whether it may leave the machine, so
 * absent or empty is fatal to the request rather than defaulted. A bare
 * (unqualified, no `@/`) string resolves only as a chain name -- a bare model
 * or engine id is 400, same as any other unrecognised string.
 */
export function resolveModel(
  model: string | undefined,
  endpoint: string,
  ctx: { config: Config; registry: EngineRegistry; body?: Record<string, unknown> },
): Dispatch {
  if (model === undefined || model === '') {
    return fail('model is required')
  }

  const segments = qualifiedSegments(model)
  if (segments !== undefined) {
    return resolveQualified(segments, { endpoint, ...ctx })
  }

  return resolveChain(model, endpoint, ctx.config) ?? fail(`unknown model "${model}"`)
}

/** `resolveModel` against the door's live config, or the 400 its refusal becomes. */
export function resolveOrRefuse(
  ctx: DoorContext,
  model: string | undefined,
  endpoint: string,
  body?: Record<string, unknown>,
): Extract<Dispatch, { ok: true }> | Response {
  const resolved = resolveModel(model, endpoint, {
    config: ctx.getConfig(),
    registry: ctx.registry,
    body,
  })
  return resolved.ok ? resolved : jsonError(STATUS_BAD_REQUEST, resolved.error)
}

/** Every model and wire id a concrete route already claims on the wildcard template's engine and upstream. */
function claimedIds(config: Config, template: ResolvedRoute): Set<string> {
  const claimed = new Set<string>()
  for (const r of config.routes) {
    if (
      r.disabled ||
      r.engine !== template.engine ||
      r.upstream !== template.upstream ||
      r.model === WILDCARD_MODEL
    ) {
      continue
    }
    if (r.model !== undefined) {
      claimed.add(r.model)
    }
    if (r.wire_model !== undefined) {
      claimed.add(r.wire_model)
    }
  }
  return claimed
}

/**
 * Catalog rows synthesized from each wildcard template. A discovered id
 * whose wire id (or address segment) is already claimed by a declared
 * non-wildcard route on that engine+upstream is omitted -- the alias stays.
 */
export function expandWildcardRoutes(config: Config, inventory: Inventory): ResolvedRoute[] {
  const out: ResolvedRoute[] = []
  for (const template of config.routes) {
    if (template.disabled || template.model !== WILDCARD_MODEL || template.upstream === null) {
      continue
    }
    const upstream = config.upstreams.find((u) => u.id === template.upstream)
    if (upstream === undefined) {
      continue
    }
    const claimed = claimedIds(config, template)
    for (const wireId of inventory.peek(upstream)) {
      if (claimed.has(wireId)) {
        continue
      }
      const segment = encodeAddressSegment(wireId)
      if (segment === undefined || claimed.has(segment)) {
        continue
      }
      out.push({ ...template, model: segment, wire_model: wireId })
    }
  }
  return out
}
