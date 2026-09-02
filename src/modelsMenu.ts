/**
 * `GET /openai/v1/models`: the door's address book, and the row shapes it is
 * built from. Every dispatchable address -- a route, or a chain -- reports
 * its own capabilities, state and whether a tool call survives it.
 */

import { parseHop } from "./chain.ts";
import { routeEgress } from "./dispatch.ts";
import type { EngineRegistry } from "./engines.ts";
import type { Exec as SecretExec } from "./exec.ts";
import {
  CONTENT_ENDPOINT_CHAT,
  type Config,
  type EngineState,
  type EngineStatus,
  findModelOnEngine,
  type ModelCapabilities,
  type ModelRow,
  type ModelsResponse,
  type ResolvedRoute,
  type Role,
  routeForHop,
  routeServes,
} from "./types.ts";
import { resolveUpstreamSecret } from "./upstream.ts";

/**
 * The slice of the door's context the menu reads. Declared here for the same
 * reason the comfy proxy and the audio verbs declare their own: the door
 * imports this module, so this module cannot import `DoorContext` back.
 */
export interface MenuDoor {
  getConfig: () => Config;
  registry: EngineRegistry;
  doorOpts: { secretExec?: SecretExec };
}

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
 * The engine-wide agentic proof (`EngineStatus.state`) only ever vouches for
 * the read-only floor -- a guarantee the pin carries regardless of which
 * upstream a route redirects to, so one proof legitimately covers every
 * route on the engine. A route's own resolvable-address question does not:
 * `@/claude/openrouter/sonnet-5` with no configured secret would otherwise
 * report `installed` right alongside a proven ambient route and fail on the
 * first real request. Checked here, per row, never folded into the shared
 * engine-wide state.
 */
async function agenticRouteState(
  ctx: MenuDoor,
  route: ResolvedRoute,
  engineState: EngineState,
): Promise<EngineState> {
  if (
    engineState !== "installed" ||
    route.upstream === null ||
    route.upstream === "local" ||
    ctx.registry.get(route.engine)?.kind !== "agentic-cli"
  ) {
    return engineState;
  }
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === route.upstream);
  if (upstream === undefined) {
    return "unavailable";
  }
  const resolved = await resolveUpstreamSecret(upstream, ctx.doorOpts.secretExec);
  return resolved.ok ? engineState : "unavailable";
}

interface ModelRowOptions {
  route: ResolvedRoute;
  siblingCount: number;
  config: Config;
  statuses: ReadonlyMap<string, EngineStatus>;
}

async function modelRow(
  ctx: MenuDoor,
  { route, siblingCount, config, statuses }: ModelRowOptions,
): Promise<ModelRow> {
  const status = statuses.get(route.engine);
  const state = await agenticRouteState(ctx, route, status?.state ?? "unavailable");
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

/**
 * A chain is not any one engine's route, so it omits engine/upstream/model/
 * egress entirely. `streaming`, `state` and `capabilities` come from its
 * FIRST hop instead -- that is the hop that actually answers, the same rule
 * `classifyResult` uses to decide whether a chain keeps walking.
 *
 * `tools` is the exception, and takes EVERY hop: a fallback is precisely
 * when a tool call would otherwise land on an agent that cannot honour it,
 * so one such hop anywhere in the list makes the whole chain unsafe to send
 * a tool loop to.
 */
function chainRow(
  chainId: string,
  hops: readonly string[],
  config: Config,
  statuses: ReadonlyMap<string, EngineStatus>,
): ModelRow {
  const [firstHop] = hops;
  const hop = firstHop === undefined ? undefined : parseHop(firstHop);
  const route =
    hop === undefined
      ? undefined
      : findModelOnEngine(config.routes, hop.engine, hop.model, hop.upstream);
  const status = route === undefined ? undefined : statuses.get(route.engine);
  return {
    id: chainId,
    streaming: route?.streaming ?? status?.streaming ?? false,
    tools: hops.every((h) => hopForwardsTools(h, config.routes, (id) => statuses.get(id))),
    serves: [CONTENT_ENDPOINT_CHAT],
    state: status?.state ?? "unavailable",
    capabilities: route === undefined ? {} : routeCapabilities(route),
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
export async function modelsMenu(ctx: MenuDoor): Promise<Response> {
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
    rows.push(chainRow(chainId, hops, config, statuses));
  }

  return Response.json({ object: "list", data: rows } satisfies ModelsResponse);
}
