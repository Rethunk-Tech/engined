/**
 * The `/engined/v1` control surface: what the door reports about its engines,
 * and the verbs that start, hold, release, stop, or read the logs of one.
 * Every one of them answers about engines rather than serving content.
 */

import { parseHop } from "./chain.ts";
import { resolveQualified } from "./dispatch.ts";
import { type DoorContext, getLlamaRouter } from "./doorContext.ts";
import type { EngineRegistry } from "./engines.ts";
import { EngineBusyError } from "./errors/engineBusy.ts";
import {
  jsonError,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_CONFLICT,
  STATUS_NOT_FOUND,
} from "./http.ts";
import { readJsonBody } from "./requestBody.ts";
import {
  errMessage,
  qualifiedSegments,
  type ResolvedRoute,
  routeForHop,
  type StartResponse,
  type StartRow,
} from "./types.ts";

/**
 * How long a hold stands without being renewed. Long enough for the slowest
 * local suite that loads llama or comfy, short enough that a run killed
 * mid-hold does not keep the engine out of service for an operator who never
 * asked for it -- the caller most likely to want a hold is a test run, which is
 * the caller most likely to die holding one.
 */
const DEFAULT_HOLD_SECONDS = 1800;
const MAX_HOLD_SECONDS = 3600;
/** Enough to see a crash's stack without streaming a whole boot log by default. */
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 5000;

/**
 * Contention comes from the routers, which the door owns and the registry has
 * never heard of -- so it is added here rather than by giving `EngineRegistry`
 * a back-reference to the door. An engine no request has touched yet has no
 * router, and so reports no roles, which is the honest answer.
 */
export async function handleEngines(
  ctx: DoorContext,
  configErr: string | undefined,
): Promise<Response> {
  const listed = await ctx.registry.list();
  for (const engine of listed.engines) {
    const busy = ctx.llamaRouters.get(engine.id)?.contention();
    if (busy !== undefined && busy.length > 0) {
      engine.roles = busy;
    }
  }
  listed.config_error = configErr;
  return Response.json(listed);
}

/**
 * `/engined/v1/start`'s target: a chain name resolves to its FIRST hop only
 * (warming exists to avoid a cold first turn; starting every hop spins up
 * containers for requests the first hop will answer), a bare `@/<model>`
 * resolves to every route offering it -- one address can name more than one
 * engine, unlike the single-winner pick a chat dispatch makes -- and the
 * two/three-segment forms are already engine-specific.
 */
function resolveStartRoutes(
  model: string,
  ctx: DoorContext,
): { ok: true; routes: readonly ResolvedRoute[] } | { ok: false; error: string } {
  const config = ctx.getConfig();
  const chainHops = config.chains[model];
  if (chainHops !== undefined) {
    const [first] = chainHops;
    if (first === undefined) {
      return { ok: false, error: `chain "${model}" has no hops` };
    }
    const hop = parseHop(first);
    const route = routeForHop(config.routes, hop.engine, hop.model, hop.upstream);
    return route === undefined
      ? { ok: false, error: `chain "${model}"'s first hop "${first}" does not resolve to a route` }
      : { ok: true, routes: [route] };
  }
  const segments = qualifiedSegments(model);
  if (segments === undefined) {
    return { ok: false, error: `unknown model "${model}"` };
  }
  if (segments.length === 1) {
    const modelId = segments[0] as string;
    const candidates = config.routes.filter((r) => !r.disabled && r.model === modelId);
    return candidates.length === 0
      ? { ok: false, error: `model "${modelId}" does not exist` }
      : { ok: true, routes: candidates };
  }
  const resolved = resolveQualified(segments, { config, registry: ctx.registry });
  return resolved.ok ? { ok: true, routes: [resolved.route] } : resolved;
}

/** The canonical `@/...` a route answers for -- always the fully explicit form, never a URL. A start row reports it; a chat dispatch walks it as the one hop `runChain` takes. */
export function routeAddress(route: ResolvedRoute): string {
  const upstreamPart = route.upstream === null ? "" : `/${route.upstream}`;
  const modelPart = route.model === undefined ? "" : `/${route.model}`;
  return `@/${route.engine}${upstreamPart}${modelPart}`;
}

/**
 * One resolved route's action, by engine class:
 *  - the local llama router: `warm`, the only start path there is now.
 *  - a container engine with a per-model route (whisper): the stop-and-restart
 *    already in `EngineRegistry.start`, `model` carried through so its own
 *    409-on-held-leases applies.
 *  - anything else local (comfy, a container-less agentic-cli route): the
 *    same `EngineRegistry.start` call, which is already a plain availability
 *    check with nothing to start for a spec that runs no container.
 *  - a route whose upstream is not `"local"` at all: a no-op that says so,
 *    never an error -- warming a peer or provider is not this delivery's job.
 * Never routes a non-llama engine through `getLlamaRouter`: a whisper route
 * carries `filename` and no `role`, and `warm` throws on a roleless model.
 */
async function startRoute(ctx: DoorContext, route: ResolvedRoute): Promise<StartRow> {
  const address = routeAddress(route);
  const { engine: engineId, upstream } = route;
  if (upstream !== "local") {
    const status = ctx.registry.get(engineId);
    const row = {
      address,
      engine: engineId,
      upstream,
      state: status?.state ?? "unavailable",
      fix: `upstream "${upstream ?? "ambient"}" is not local; nothing to start here`,
      started: false,
    };
    return row;
  }
  if (ctx.registry.isLocalLlama(engineId)) {
    const engineEntry = ctx.registry.entry(engineId);
    if (engineEntry === undefined) {
      const row = {
        address,
        engine: engineId,
        upstream,
        state: "unavailable" as const,
        fix: `unknown engine "${engineId}"`,
        started: false,
      };
      return row;
    }
    // `warm` reports whether this call is the one that swapped the resident
    // -- its own lease queue already knows, computed per caller -- so two
    // concurrent starts on one cold model never both claim they started it.
    const started = await getLlamaRouter(ctx, engineEntry).warm(route);
    const status = ctx.registry.get(engineId);
    const row = {
      address,
      engine: engineId,
      upstream,
      state: status?.state ?? "unavailable",
      fix: status?.fix,
      started,
    };
    return row;
  }
  const status = await ctx.registry.start(engineId, route.model);
  const row = {
    address,
    engine: engineId,
    upstream,
    state: status.state,
    fix: status.fix,
    started: status.launched,
  };
  return row;
}

/**
 * `POST /engined/v1/start`: a model address or a chain name, resolved to the
 * route(s) it names and started where "started" means something. Never hands
 * back a `url` -- reaching the engine is a separate request, to the door, by
 * address; this verb only answers what state it is in.
 */
export async function handleStart(ctx: DoorContext, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (model === "") {
    return jsonError(STATUS_BAD_REQUEST, "model is required");
  }
  const resolved = resolveStartRoutes(model, ctx);
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error);
  }
  try {
    const data = await Promise.all(resolved.routes.map((route) => startRoute(ctx, route)));
    return Response.json({ object: "list", data } satisfies StartResponse);
  } catch (err) {
    if (err instanceof EngineBusyError) {
      return jsonError(STATUS_CONFLICT, err.message);
    }
    return jsonError(STATUS_BAD_GATEWAY, errMessage(err));
  }
}

/**
 * `POST /engined/v1/engines/<id>/hold`: stop this engine and keep it stopped,
 * so a second process can load the same weights without racing the door for
 * the pool. comfy is ~42 GiB and llama ~30 GiB on this box; two copies of
 * either, or one of each, is what there is no room for.
 *
 * A hold degrades service deliberately -- a start refuses while it stands --
 * which is the trade it exists to make: a caller told "held" retries, where an
 * OOM takes the box and everything else running on it.
 */
export async function handleHold(
  registry: EngineRegistry,
  id: string,
  url: URL,
): Promise<Response> {
  const asked = Number(url.searchParams.get("seconds") ?? DEFAULT_HOLD_SECONDS);
  const seconds = Number.isFinite(asked)
    ? Math.min(Math.max(1, Math.trunc(asked)), MAX_HOLD_SECONDS)
    : DEFAULT_HOLD_SECONDS;
  try {
    return Response.json(await registry.hold(id, seconds));
  } catch (err) {
    return jsonError(STATUS_NOT_FOUND, errMessage(err));
  }
}

/** `POST /engined/v1/engines/<id>/unhold`: ends a hold early rather than waiting out its TTL. */
export async function handleUnhold(registry: EngineRegistry, id: string): Promise<Response> {
  try {
    return Response.json(await registry.unhold(id));
  } catch (err) {
    return jsonError(STATUS_NOT_FOUND, errMessage(err));
  }
}

export async function handleStop(registry: EngineRegistry, id: string): Promise<Response> {
  try {
    return Response.json(await registry.stop(id));
  } catch (err) {
    return jsonError(STATUS_NOT_FOUND, errMessage(err));
  }
}

/**
 * `?tail=` is clamped rather than rejected: a consumer asking for more lines
 * than the door will serve wants as many as it can get, not a 400.
 */
export async function handleLogs(
  registry: EngineRegistry,
  id: string,
  url: URL,
): Promise<Response> {
  const asked = Number(url.searchParams.get("tail") ?? DEFAULT_LOG_TAIL);
  const tail = Number.isFinite(asked)
    ? Math.min(Math.max(1, Math.trunc(asked)), MAX_LOG_TAIL)
    : DEFAULT_LOG_TAIL;
  const res = await registry.logs(id, tail);
  return "error" in res ? jsonError(STATUS_NOT_FOUND, res.error) : Response.json(res);
}

export async function handleRelease(registry: EngineRegistry, id: string): Promise<Response> {
  const res = await registry.release(id);
  return "error" in res ? jsonError(STATUS_BAD_REQUEST, res.error) : Response.json(res);
}

export async function handleResources(registry: EngineRegistry, id: string): Promise<Response> {
  const res = await registry.resources(id);
  return "error" in res ? jsonError(STATUS_NOT_FOUND, res.error) : Response.json(res);
}
