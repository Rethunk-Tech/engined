/**
 * Resolves an OpenAI `model` string to a route for one door endpoint. Pure
 * over `Config` and the registry's `get`/`serves`/`entry` so it is testable
 * without `Bun.serve` or docker.
 */

import type { EngineRegistry } from "./engines.ts";
import type { Config, Egress, ResolvedRoute } from "./types.ts";
import { EGRESS_RANK, qualifiedSegments } from "./types.ts";

/** Chains exist to route a chat prompt hop by hop; no other endpoint takes one. */
const CHAIN_ENDPOINT = "/openai/v1/chat/completions";

export type Dispatch =
  | { ok: true; kind: "model"; engine: string; model?: string; upstream?: string }
  | { ok: true; kind: "chain"; chain: string; hops: readonly string[] }
  | { ok: false; error: string };

/** Everything one resolution reads, bundled so no resolver runs past the parameter budget. */
interface ResolveCtx {
  endpoint: string;
  config: Config;
  registry: EngineRegistry;
}

function fail(error: string): Dispatch {
  return { ok: false, error };
}

/** The engine segment, resolved to a real id -- `undefined` when nothing configured carries it. Exported so the door can resolve the same segment for chain hops, extras and `egressOf`. */
export function resolveEngineSegment(seg: string, config: Config): string | undefined {
  return config.engines.some((e) => e.id === seg) ? seg : undefined;
}

/** `engine.serves(endpoint)`, or the model-less form when `model` is `undefined`. The one funnel every resolved dispatch passes through, so the disabled check lives here rather than in each resolver. */
function withEndpointCheck(
  engineId: string,
  model: string | undefined,
  upstream: string | undefined,
  ctx: ResolveCtx,
): Dispatch {
  if (ctx.registry.entry(engineId)?.disabled) {
    return fail(`engine "${engineId}" is disabled in config`);
  }
  if (!ctx.registry.serves(engineId).includes(ctx.endpoint)) {
    return fail(`engine "${engineId}" does not serve ${ctx.endpoint}`);
  }
  return { ok: true, kind: "model", engine: engineId, model, upstream };
}

/** Where an upstream ranks on `EGRESS_RANK`; ambient (`upstream === null`) is `"remote"`, matching `Upstream`'s own doc: no upstream leaves the box the same as any other network call. */
function routeEgressRank(route: ResolvedRoute, config: Config): number {
  const egress: Egress =
    route.upstream === null
      ? "remote"
      : (config.upstreams.find((u) => u.id === route.upstream)?.egress ?? "remote");
  return EGRESS_RANK[egress];
}

/**
 * `@/<model>`: the highest-preference route naming this model, across every
 * engine. Ordered local -> `lan` -> `remote` -> declaration, and resolved to
 * exactly ONE route -- it does not walk on failure. A caller wanting
 * fallback across candidates writes a chain instead.
 */
function resolveOneSegment(model: string, ctx: ResolveCtx): Dispatch {
  const candidates = ctx.config.routes.filter((r) => !r.disabled && r.model === model);
  if (candidates.length === 0) {
    return fail(`model "${model}" does not exist`);
  }
  const [winner] = [...candidates].sort(
    (a, b) => routeEgressRank(a, ctx.config) - routeEgressRank(b, ctx.config),
  );
  const route = winner as ResolvedRoute;
  return withEndpointCheck(route.engine, model, route.upstream ?? undefined, ctx);
}

/** Among routes sharing one `(engine, model)`, the default upstream: ambient first, then this box's own `local`. Anything else is a real ambiguity the caller must break with the three-segment form. */
function pickDefaultUpstream(matches: readonly ResolvedRoute[]): ResolvedRoute | undefined {
  return matches.find((r) => r.upstream === null) ?? matches.find((r) => r.upstream === "local");
}

/**
 * `@/<engine>/<seg>`: engine+model normally, or engine+upstream when this
 * engine's own routes declare no model at all -- read from the engine's
 * declaration, never from whether `seg` happens to match an upstream id.
 * That stays single-valued only because config parse refuses an engine that
 * mixes modelless and model-bearing routes.
 */
function resolveTwoSegments(engineSeg: string, seg: string, ctx: ResolveCtx): Dispatch {
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
    return withEndpointCheck(engineSeg, undefined, seg, ctx);
  }
  const matches = engineRoutes.filter((r) => !r.disabled && r.model === seg);
  if (matches.length === 0) {
    return fail(`"@/${engineSeg}/${seg}": model "${seg}" does not exist on "${engineSeg}"`);
  }
  const route = matches.length === 1 ? matches[0] : pickDefaultUpstream(matches);
  if (route === undefined) {
    const qualified = matches.map((r) => `@/${engineSeg}/${r.upstream}/${seg}`).join(", ");
    return fail(`"@/${engineSeg}/${seg}" is ambiguous across upstreams; use one of: ${qualified}`);
  }
  return withEndpointCheck(engineSeg, seg, route.upstream ?? undefined, ctx);
}

/** `@/<engine>/<upstream>/<model>`: fully explicit, the one form with no default to apply. */
function resolveThreeSegments(
  engineSeg: string,
  upstreamSeg: string,
  modelSeg: string,
  ctx: ResolveCtx,
): Dispatch {
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
  return withEndpointCheck(engineSeg, modelSeg, upstreamSeg, ctx);
}

function resolveQualified(segments: readonly string[], ctx: ResolveCtx): Dispatch {
  const [first, second, third] = segments;
  if (segments.length === 1) {
    return resolveOneSegment(first as string, ctx);
  }
  if (segments.length === 2) {
    return resolveTwoSegments(first as string, second as string, ctx);
  }
  return resolveThreeSegments(first as string, second as string, third as string, ctx);
}

function resolveChain(model: string, endpoint: string, config: Config): Dispatch | undefined {
  const hops = config.chains[model];
  if (hops === undefined) {
    return;
  }
  if (endpoint !== CHAIN_ENDPOINT) {
    return fail(`chain "${model}" only serves ${CHAIN_ENDPOINT}`);
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
