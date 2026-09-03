/**
 * `GET /openai/v1/models`: the door's address book, and the row shapes it is
 * built from. Every dispatchable address -- a route, or a chain -- reports
 * its own capabilities, state and whether a tool call survives it.
 */

import { parseHop } from "./chain.ts";
import { routeEgress } from "./dispatch.ts";
import type { DoorContext } from "./doorContext.ts";
import {
  CONTENT_ENDPOINT_CHAT,
  type Config,
  type EngineState,
  type EngineStatus,
  type ModelCapabilities,
  type ModelRow,
  type ModelsResponse,
  type ResolvedRoute,
  type Role,
  routeForHop,
  routeServes,
} from "./types.ts";
import { resolveUpstream } from "./upstream.ts";

/** Whatever this route's own capability fields are -- undefined fields drop out of the JSON on their own, so a route naming an undeclared model reports empty capabilities with no special case. */
function routeCapabilities(route: ModelCapabilities): ModelCapabilities {
  return {
    input: route.input,
    output: route.output,
    context_in: route.context_in,
    context_out: route.context_out,
    reasoning: route.reasoning,
  };
}

/**
 * The addressable string for this route: the two-segment form when it is
 * the only route claiming this `(engine, model)` pair, else the fully
 * explicit three-segment form -- two sibling routes on one engine sharing a
 * model (different upstreams) would otherwise report the same `id` twice.
 */
function modelRowId(route: ResolvedRoute, siblingCount: number): string {
  if (route.model === undefined) {
    return `@/${route.engine}/${route.upstream}`;
  }
  if (siblingCount > 1 && route.upstream !== null) {
    return `@/${route.engine}/${route.upstream}/${route.model}`;
  }
  return `@/${route.engine}/${route.model}`;
}

/**
 * An engine-wide proof (`EngineStatus.state`) only ever vouches for what the
 * engine itself carries -- an agentic pin's read-only floor, a container's
 * image -- and carries it regardless of which upstream a route points at, so
 * one proof legitimately covers every route on the engine. A route's own
 * resolvable-address question does not: `@/claude/openrouter/sonnet-5` with
 * no configured secret, or an upstream carrying a secret and no `base_url`,
 * would otherwise report `installed` right alongside a proven ambient route
 * and fail on the first real request. Asked here per row with the resolver
 * the request path itself uses, never folded into the shared engine state.
 *
 * comfy is the one kind exempt: its proxy dials the local container's own
 * private_url and never the upstream's address, so a comfy route naming a
 * peer serves without either half of this.
 */
async function remoteRouteState(
  ctx: DoorContext,
  route: ResolvedRoute,
  engineState: EngineState,
): Promise<EngineState> {
  if (
    engineState !== "installed" ||
    route.upstream === null ||
    route.upstream === "local" ||
    ctx.registry.get(route.engine)?.kind === "comfy"
  ) {
    return engineState;
  }
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === route.upstream);
  if (upstream === undefined) {
    return "unavailable";
  }
  const resolved = await resolveUpstream(upstream, ctx.doorOpts.secretExec);
  return resolved.ok ? engineState : "unavailable";
}

interface ModelRowOptions {
  route: ResolvedRoute;
  siblingCount: number;
  config: Config;
  statuses: ReadonlyMap<string, EngineStatus>;
}

async function modelRow(
  ctx: DoorContext,
  { route, siblingCount, config, statuses }: ModelRowOptions,
): Promise<ModelRow> {
  const status = statuses.get(route.engine);
  const state = await remoteRouteState(ctx, route, status?.state ?? "unavailable");
  return {
    id: modelRowId(route, siblingCount),
    engine: route.engine,
    upstream: route.upstream ?? undefined,
    model: route.model,
    egress: routeEgress(route, config),
    streaming: route.streaming ?? status?.streaming ?? false,
    tools: forwardsTools(status, route.role),
    serves: routeServes(route.role, status?.serves ?? []),
    state,
    capabilities: routeCapabilities(route),
  };
}

/**
 * Whether the door hands this route's upstream the request body it was
 * given, tool-calling fields and all. Only a chat-serving `openai-http`
 * route does: an agentic hop refuses the values that demand a tool call
 * (`unhonourableFields`), an embeddings route has no tool-call channel to
 * forward one down whatever its engine kind, and no other kind serves chat.
 * It says nothing about whether the upstream then honours them -- that
 * answer is the upstream's own.
 */
function forwardsTools(status: EngineStatus | undefined, role: Role | undefined): boolean {
  return (
    status?.kind === "openai-http" &&
    routeServes(role, status.serves).includes(CONTENT_ENDPOINT_CHAT)
  );
}

/** The same question for one `@/engine/model` hop, which carries its route's role only once resolved. Shared by the `models` menu and by the dispatch that decides whether refusing a tool call is terminal. */
export function hopForwardsTools(
  hop: string,
  routes: Config["routes"],
  statusOf: (engineId: string) => EngineStatus | undefined,
): boolean {
  const { engine, upstream, model } = parseHop(hop);
  return forwardsTools(statusOf(engine), routeForHop(routes, engine, model, upstream)?.role);
}

/** One hop of a chain, resolved once: the route it names, its engine's status, and whether it can answer at all. */
interface ChainHop {
  hop: string;
  route: ResolvedRoute | undefined;
  status: EngineStatus | undefined;
  state: EngineState;
}

/** Every hop of one chain, each asked the same resolvable-address question a direct row is asked, so the menu cannot disagree with itself about the same address. */
function chainHops(
  ctx: DoorContext,
  hops: readonly string[],
  config: Config,
  statuses: ReadonlyMap<string, EngineStatus>,
): Promise<ChainHop[]> {
  return Promise.all(
    hops.map(async (hop) => {
      const { engine, upstream, model } = parseHop(hop);
      const route = routeForHop(config.routes, engine, model, upstream);
      const status = statuses.get(engine);
      return {
        hop,
        route,
        status,
        state:
          route === undefined
            ? "unavailable"
            : await remoteRouteState(ctx, route, status?.state ?? "unavailable"),
      };
    }),
  );
}

/**
 * A chain is not any one engine's route, so it omits engine/upstream/model/
 * egress entirely, and `hops` is what stands in for them: the ordered
 * addresses this id actually resolves to, present here and on no route row.
 * Without it a healthy chain is the least informative row in the address
 * book -- every field naming a destination absent, and `unavailable_hops`
 * absent too precisely because nothing is broken -- so a caller cannot tell
 * a chain from a bare model id, nor that `ornith` and `@/llama/ornith` are
 * one destination listed twice.
 *
 * `streaming` and `capabilities` come from its FIRST hop -- that is the hop
 * a request starts on, and the one whose shape a caller writes its request
 * against.
 *
 * `state` and `tools` both take EVERY hop, for opposite reasons. `runChain`
 * advances past a hop that cannot answer rather than failing the chain, so
 * the chain is usable exactly as long as one hop is: `state` is the first
 * hop that can answer, and `unavailable_hops` names the ones that cannot --
 * a chain limping on a fallback still says `installed`, and now says what it
 * is limping on. When no hop can answer there is no such hop, the state is
 * `unavailable`, and every hop is listed. `tools` instead demands every hop:
 * a fallback is precisely when a tool call would otherwise land on an agent
 * that cannot honour it, so one such hop anywhere makes the whole chain
 * unsafe to send a tool loop to.
 */
async function chainRow(
  ctx: DoorContext,
  chainId: string,
  hops: readonly string[],
  config: Config,
  statuses: ReadonlyMap<string, EngineStatus>,
): Promise<ModelRow> {
  const walked = await chainHops(ctx, hops, config, statuses);
  const [lead] = walked;
  const dead = walked.filter((h) => h.state === "unavailable").map((h) => h.hop);
  return {
    id: chainId,
    streaming: lead?.route?.streaming ?? lead?.status?.streaming ?? false,
    tools: walked.every((h) => forwardsTools(h.status, h.route?.role)),
    serves: [CONTENT_ENDPOINT_CHAT],
    state: walked.find((h) => h.state !== "unavailable")?.state ?? "unavailable",
    capabilities: lead?.route === undefined ? {} : routeCapabilities(lead.route),
    hops: walked.map((h) => h.hop),
    unavailable_hops: dead.length === 0 ? undefined : dead,
  };
}

/**
 * `GET /openai/v1/models`: every dispatchable address, as a row carrying its
 * own capabilities rather than a bare id -- async and authoritative, so
 * `state` reflects a real probe rather than the sync lifecycle cache.
 *
 * `comfy` is listed too, now that it has a real `serves` (the mediated
 * proxy's own paths, not a content endpoint): it is addressable like every
 * other engine, and this menu is the address book. `capabilities` is empty
 * for its row -- comfy has no `[[model]]` capability shape to report -- but
 * `serves` still tells a caller it does not speak chat, exactly as a
 * modelless audio engine's own `serves` (`/openai/v1/audio/speech`) does.
 */
export async function modelsMenu(ctx: DoorContext): Promise<Response> {
  const config = ctx.getConfig();
  const { engines } = await ctx.registry.list();
  const statuses = new Map(engines.map((e) => [e.id, e]));
  const servedEngines = new Set(engines.filter((e) => e.serves.length > 0).map((e) => e.id));

  const rows: ModelRow[] = [];
  for (const route of config.routes) {
    if (route.disabled || !servedEngines.has(route.engine)) {
      continue;
    }
    const siblingCount =
      route.model === undefined
        ? 1
        : config.routes.filter(
            (r) => !r.disabled && r.engine === route.engine && r.model === route.model,
          ).length;
    rows.push(await modelRow(ctx, { route, siblingCount, config, statuses }));
  }
  for (const [chainId, hops] of Object.entries(config.chains)) {
    rows.push(await chainRow(ctx, chainId, hops, config, statuses));
  }

  return Response.json({ object: "list", data: rows } satisfies ModelsResponse);
}
