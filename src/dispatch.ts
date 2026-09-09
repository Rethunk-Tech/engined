/**
 * Resolves an OpenAI `model` string to a route for one door endpoint. Pure
 * over `Config` and the registry's `get`/`serves`/`entry` so it is testable
 * without `Bun.serve` or docker.
 */

import type { EngineRegistry } from "./engines.ts";
import type { Config, Egress, ResolvedRoute } from "./types.ts";
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  EGRESS_RANK,
  qualifiedSegments,
  routeForHop,
  routeServes,
} from "./types.ts";

type ModelDispatch =
  | { ok: true; kind: "model"; route: ResolvedRoute }
  | { ok: false; error: string };

export type Dispatch =
  | ModelDispatch
  | { ok: true; kind: "chain"; chain: string; hops: readonly string[] };

/** Everything one resolution reads. No `endpoint` skips the serves check: starting a container asks nothing about which door path the engine answers. */
interface ResolveCtx {
  endpoint?: string;
  config: Config;
  registry: EngineRegistry;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

/** `engine.serves(endpoint)`, or the model-less form when the route has no model. The one funnel every resolved dispatch passes through, so the disabled check lives here rather than in each resolver. */
function withEndpointCheck(route: ResolvedRoute, ctx: ResolveCtx): ModelDispatch {
  const { engine, model } = route;
  if (ctx.registry.entry(engine)?.disabled) {
    return fail(`engine "${engine}" is disabled in config`);
  }
  if (
    ctx.endpoint !== undefined &&
    !routeServes(route.role, ctx.registry.serves(engine)).includes(ctx.endpoint)
  ) {
    const what = model === undefined ? `engine "${engine}"` : `"@/${engine}/${model}"`;
    return fail(`${what} does not serve ${ctx.endpoint}`);
  }
  return { ok: true, kind: "model", route };
}

/** Where this route's bytes travel. Ambient (`upstream === null`) is `"remote"`, matching `Upstream`'s own doc: no upstream leaves the box the same as any other network call. */
export function routeEgress(route: ResolvedRoute, config: Config): Egress {
  if (route.upstream === null) {
    return "remote";
  }
  return config.upstreams.find((u) => u.id === route.upstream)?.egress ?? "remote";
}

/**
 * `@/<model>`: the highest-preference route naming this model, across every
 * engine. Ordered local -> `lan` -> `remote` -> declaration, and resolved to
 * exactly ONE route -- it does not walk on failure. A caller wanting
 * fallback across candidates writes a chain instead.
 */
function resolveOneSegment(model: string, ctx: ResolveCtx): ModelDispatch {
  const candidates = ctx.config.routes.filter((r) => !r.disabled && r.model === model);
  if (candidates.length === 0) {
    return fail(`model "${model}" does not exist`);
  }
  const [winner] = [...candidates].sort(
    (a, b) => EGRESS_RANK[routeEgress(a, ctx.config)] - EGRESS_RANK[routeEgress(b, ctx.config)],
  );
  return withEndpointCheck(winner as ResolvedRoute, ctx);
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
    return fail(`"@/${engineSeg}/${seg}": engine "${engineSeg}" does not exist`);
  }
  // Ahead of the route lookup, which would otherwise report a disabled
  // engine's dropped routes as routes that never existed.
  if (ctx.registry.entry(engineSeg)?.disabled) {
    return fail(`engine "${engineSeg}" is disabled in config`);
  }
  const engineRoutes = ctx.config.routes.filter((r) => r.engine === engineSeg);
  const modelless = engineRoutes.some((r) => r.model === undefined);
  if (modelless) {
    const route = engineRoutes.find((r) => !r.disabled && r.upstream === seg);
    if (!route) {
      return fail(`"@/${engineSeg}/${seg}": no route on "${engineSeg}" with upstream "${seg}"`);
    }
    return withEndpointCheck(route, ctx);
  }
  const matches = engineRoutes.filter((r) => !r.disabled && r.model === seg);
  if (matches.length === 0) {
    return fail(`"@/${engineSeg}/${seg}": model "${seg}" does not exist on "${engineSeg}"`);
  }
  const route = routeForHop(engineRoutes, engineSeg, seg);
  if (route === undefined) {
    const qualified = matches.map((r) => `@/${engineSeg}/${r.upstream}/${seg}`).join(", ");
    return fail(`"@/${engineSeg}/${seg}" is ambiguous across upstreams; use one of: ${qualified}`);
  }
  return withEndpointCheck(route, ctx);
}

/** `@/<engine>/<upstream>/<model>`: fully explicit, the one form with no default to apply. */
function resolveThreeSegments(
  engineSeg: string,
  upstreamSeg: string,
  modelSeg: string,
  ctx: ResolveCtx,
): ModelDispatch {
  if (!ctx.config.engines.some((e) => e.id === engineSeg)) {
    return fail(
      `"@/${engineSeg}/${upstreamSeg}/${modelSeg}": engine "${engineSeg}" does not exist`,
    );
  }
  if (ctx.registry.entry(engineSeg)?.disabled) {
    return fail(`engine "${engineSeg}" is disabled in config`);
  }
  const route = ctx.config.routes.find(
    (r) =>
      !r.disabled && r.engine === engineSeg && r.upstream === upstreamSeg && r.model === modelSeg,
  );
  if (!route) {
    return fail(
      `"@/${engineSeg}/${upstreamSeg}/${modelSeg}": model "${modelSeg}" does not exist on "${engineSeg}"/"${upstreamSeg}"`,
    );
  }
  return withEndpointCheck(route, ctx);
}

/** A `@/...` address by segment count. Exported for `/engined/v1/start`, which resolves the same two- and three-segment forms with no endpoint to check. */
export function resolveQualified(segments: readonly string[], ctx: ResolveCtx): ModelDispatch {
  const [first, second, third] = segments;
  if (segments.length === 1) {
    return resolveOneSegment(first as string, ctx);
  }
  if (segments.length === 2) {
    return resolveTwoSegments(first as string, second as string, ctx);
  }
  return resolveThreeSegments(first as string, second as string, third as string, ctx);
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
]);

function resolveChain(model: string, endpoint: string, config: Config): Dispatch | undefined {
  const hops = config.chains[model];
  if (hops === undefined) {
    return;
  }
  if (!CHAIN_ENDPOINTS.has(endpoint)) {
    return fail(`chain "${model}" does not serve ${endpoint}`);
  }
  return { ok: true, kind: "chain", chain: model, hops };
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
  config: Config,
  registry: EngineRegistry,
): Dispatch {
  if (model === undefined || model === "") {
    return fail("model is required");
  }

  const segments = qualifiedSegments(model);
  if (segments !== undefined) {
    return resolveQualified(segments, { endpoint, config, registry });
  }

  return resolveChain(model, endpoint, config) ?? fail(`unknown model "${model}"`);
}
