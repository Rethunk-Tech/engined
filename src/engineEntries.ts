/**
 * Turning the config's routes into the entries the registry serves: the
 * capabilities each engine offers, the shape whose change invalidates a
 * loaded entry, and the contradictions between a route and its engine's kind
 * that must refuse at startup rather than at the first request.
 */

import { agentCli } from "./agents.ts";
import { buildComfySpec } from "./comfy.ts";
import type { RuntimeStatus } from "./docker.ts";
import { FatalError } from "./errors/fatal.ts";
import { STATUS_OK } from "./http.ts";
import { buildLlamaSpec } from "./llamaSpec.ts";
import type { EngineStatus } from "./responses.ts";
import { applyEngineArgs, loadSpec, type SpecLoadOptions } from "./spec.ts";
import { isContainerSpec, type LoadedSpec, type Spec } from "./specTypes.ts";
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  type Config,
  type Disposition,
  type EngineCapability,
  type EngineEntry,
  type EngineKind,
  KIND_TRAITS,
  type ReadyProbe,
  type ResolvedRoute,
  routeServes,
  type Upstream,
  WILDCARD_MODEL,
} from "./types.ts";

/**
 * A spec-less engine's built-in spec has no spec directory, so its `serves`
 * list cannot come from a spec file. Mirrors the route table in
 * docs/http-api.md. Comfy is never reached this way, so it is absent from
 * this map's callers rather than mapped to `[]` here.
 */
export const KIND_SERVES: Record<EngineKind, string[]> = {
  "openai-http": [CONTENT_ENDPOINT_CHAT, CONTENT_ENDPOINT_EMBEDDINGS, CONTENT_ENDPOINT_RERANK],
  "agentic-cli": [CONTENT_ENDPOINT_CHAT],
  tts: [CONTENT_ENDPOINT_SPEECH],
  stt: [CONTENT_ENDPOINT_TRANSCRIPTIONS],
  comfy: [],
};

/** No spec directory exists for a spec-less engine; named as such rather than left blank. */
const BUILTIN_SPEC_SOURCE = "(none: spec-less engine)";

/** Never read: `isContainerSpec` is false for a spec-less engine's built-in spec, so no probe ever reaches `docker inspect` with this. */
const BUILTIN_READY_PROBE: ReadyProbe = { path: "/", status: STATUS_OK };

/**
 * The spec a spec-less engine takes when its own config declares `kind`.
 * `agentic-cli` has no built-in launch to fall back to -- there is no
 * package, no CLI, no floor to invent -- so it is refused here rather than
 * silently constructed wrong; every agentic engine ships a real spec.
 */
function builtInSpec(engine: EngineEntry, kind: EngineKind): Spec {
  if (kind === "agentic-cli") {
    throw new FatalError(
      `engine "${engine.id}": a spec-less agentic-cli engine has no built-in launch -- ship engines/${engine.id}/spec.toml`,
    );
  }
  return {
    kind,
    image: undefined,
    obtain: "pull",
    serves: KIND_SERVES[kind],
    env: [],
    command: [],
    upstream: KIND_TRAITS[kind].upstream,
    devices: [],
    group_add: [],
    security_opt: [],
    init: false,
    streaming: false,
    volumes: [],
    artifacts: [],
    ready: BUILTIN_READY_PROBE,
  };
}

export function isLocalLlama(engine: EngineEntry, kind: EngineKind): boolean {
  return kind === "openai-http" && engine.models_dir !== undefined;
}

/** Whether any of this engine's own routes resolve to THIS box's own upstream -- the fact `reload`'s second pass keys a container teardown on. An engine with no routes at all (comfy, sometimes) has no binding either way. */
export function hasLocalBinding(engineId: string, routes: readonly ResolvedRoute[]): boolean {
  return routes.some((r) => r.engine === engineId && r.upstream === "local");
}

export interface Entry {
  engine: EngineEntry;
  spec: LoadedSpec;
}

/**
 * Substituted into the throwaway peek below, never mounted: a spec that reads
 * `{preset_ini}` is re-resolved by its own builder with the real path, and a
 * spec that does not read it never sees this. Named rather than inlined so it
 * is obvious no real path was meant.
 */
const PEEK_PRESET_INI = "/unused";

/**
 * Picks the per-engine builder from the loaded spec's own `kind` and the
 * engine's own configuration, never from a hardcoded id — an operator naming
 * the local llama engine something other than "llama" must still get
 * its models mount. `buildLlamaSpec`/`buildComfySpec` each call `loadSpec`
 * themselves; the first call here only exists to learn `kind` cheaply,
 * before ever running or proxying anything.
 *
 * An engine declaring `kind` in config is spec-less and takes the built-in
 * spec for that kind; everything else loads `engines/<id>/spec.toml`.
 */
export function loadEngineSpec(
  engine: EngineEntry,
  specOptions: SpecLoadOptions,
  presetHostPath: string,
): LoadedSpec {
  if (engine.kind !== undefined) {
    return { spec: builtInSpec(engine, engine.kind), source: BUILTIN_SPEC_SOURCE };
  }
  // The peek's own resolved spec is discarded whenever a builder below takes
  // over -- each calls loadSpec again with the substitution `{preset_ini}`
  // actually needs.
  const loaded = loadSpec(engine, { ...specOptions, presetIni: PEEK_PRESET_INI });
  if (!isContainerSpec(loaded.spec)) {
    return loaded;
  }
  if (loaded.spec.kind === "comfy" && engine.models_dir !== undefined) {
    return { ...loaded, spec: buildComfySpec(engine, specOptions) };
  }
  if (isLocalLlama(engine, loaded.spec.kind)) {
    return { ...loaded, spec: buildLlamaSpec(engine, specOptions, presetHostPath) };
  }
  return { ...loaded, spec: applyEngineArgs(engine, loaded.spec) };
}

/** One field's disposition against whether the route actually declared it. `FatalError`, not `ParseError`: this is a startup failure, not a config-file one -- kind is not known until the spec driving this check has already loaded. */
function assertFieldDisposition(
  disposition: Disposition,
  present: boolean,
  field: string,
  site: string,
): void {
  if (disposition === "required" && !present) {
    throw new FatalError(`${site} is missing required "${field}"`);
  }
  if (disposition === "forbidden" && present) {
    throw new FatalError(`${site} must not declare "${field}"`);
  }
}

/**
 * The kind-dependent half of the filename/role/args split `config.ts`'s
 * parse-tier check leaves open: whisper requires `filename` and forbids
 * `role`, llama requires both. Only reached for a route the parse tier did
 * NOT already forbid outright (model-bearing, `upstream === "local"`, and
 * the engine actually has a `models_dir`) -- for every other route the
 * question is already closed and this is a no-op. `@/llama/sonnet-5` (a
 * filename-less llama route) stays invalid because of this, not for free.
 */
function checkLocalFileDisposition(
  engine: EngineEntry,
  kind: EngineKind,
  routes: readonly ResolvedRoute[],
): void {
  const rules = KIND_TRAITS[kind].localFile;
  for (const r of routes) {
    if (
      r.engine !== engine.id ||
      r.model === undefined ||
      r.upstream !== "local" ||
      engine.models_dir === undefined
    ) {
      continue;
    }
    const site = `route on engine "${engine.id}" model "${r.model}"`;
    assertFieldDisposition(rules.filename, r.filename !== undefined, "filename", site);
    assertFieldDisposition(rules.role, r.role !== undefined, "role", site);
    assertFieldDisposition(rules.translate, r.translate !== undefined, "translate", site);
    if (rules.args === "forbidden" && Object.keys(r.args).length > 0) {
      throw new FatalError(`${site} must not declare "args"`);
    }
  }
}

/**
 * Kind is not known until the spec loads. A wildcard is only legal on remote
 * openai-http: llama, media and agentic have no provider catalog to expand.
 */
function checkWildcardRouteKind(
  engine: EngineEntry,
  kind: EngineKind,
  routes: readonly ResolvedRoute[],
): void {
  for (const r of routes) {
    if (r.engine !== engine.id || r.model !== WILDCARD_MODEL) {
      continue;
    }
    const site = `route on engine "${engine.id}" model "${WILDCARD_MODEL}"`;
    if (kind !== "openai-http" || engine.models_dir !== undefined) {
      throw new FatalError(
        `${site} is a wildcard and only a remote openai-http engine may carry one`,
      );
    }
  }
}

/**
 * Which shape an agentic-cli engine's own process speaks comes from its
 * agent, never from config -- and the agent id comes from the spec
 * (`AgenticSpec.agent` -> `agentCli`), so this can only run once specs have
 * loaded, here in `buildEntries`, never at `config.ts` parse time. The door
 * forwards an agent CLI's native wire straight to its resolved upstream
 * without translating it (`main.ts`'s `resolveRedirect`), so a mismatch here
 * is not a style complaint -- it is every request through that route
 * arriving at the upstream in a shape it cannot parse. Ambient routes
 * (`upstream === null`) name no upstream to mismatch against and are exempt;
 * an upstream that declares no `wire` at all is treated as `"openai"`, the
 * default shape a plain HTTP proxy speaks.
 */
function checkAgenticWire(
  engine: EngineEntry,
  spec: Spec,
  routes: readonly ResolvedRoute[],
  upstreams: readonly Upstream[],
): void {
  if (spec.kind !== "agentic-cli") {
    return;
  }
  const agentWire = agentCli(spec.agent)?.wire ?? "openai";
  for (const r of routes) {
    if (r.engine !== engine.id || r.upstream === null) {
      continue;
    }
    const upstreamWire = upstreams.find((u) => u.id === r.upstream)?.wire ?? "openai";
    if (upstreamWire !== agentWire) {
      throw new FatalError(
        `route on engine "${engine.id}" names upstream "${r.upstream}" (wire "${upstreamWire}"), but agent "${spec.agent}" speaks "${agentWire}" -- the door forwards the agent's own wire unchanged, so a mismatched pairing can never actually work`,
      );
    }
  }
}

/**
 * A `self`-trait engine (comfy, every media kind) has no LLM-completions wire
 * of its own to translate through, so the only upstream it can ever validly
 * proxy to is another engined box's own `local` -- a peer speaking the exact
 * same native API this engine does. `local` itself is always permitted (that
 * is what `self` defaults to), and so is any upstream that declares no `wire`
 * at all, on the theory that a `wire` is what marks an upstream as an
 * LLM-completions provider -- ElevenLabs' STT upstream, for one, declares
 * none, precisely because `Wire` (`"openai" | "anthropic"`) has no vocabulary
 * for its dialect either. What this refuses is the nonsense case: a `self`
 * engine pointed at an upstream that DOES declare a wire, which is always a
 * foreign LLM provider no `self` kind could ever correctly speak to.
 */
function checkSelfUpstream(
  engine: EngineEntry,
  spec: Spec,
  routes: readonly ResolvedRoute[],
  upstreams: readonly Upstream[],
): void {
  if (spec.upstream !== "self") {
    return;
  }
  for (const r of routes) {
    if (r.engine !== engine.id || r.upstream === null || r.upstream === "local") {
      continue;
    }
    const found = upstreams.find((u) => u.id === r.upstream);
    if (found?.wire !== undefined) {
      throw new FatalError(
        `route on engine "${engine.id}" is "self" and cannot be pointed at upstream "${r.upstream}", which speaks "${found.wire}" -- a self engine only ever proxies to a peer's own "local", never a wire-shaped provider`,
      );
    }
  }
}

/** Whether a route declares any of its own capability fields, model-bearing or not. */
function routeHasCapability(r: ResolvedRoute): boolean {
  return (
    r.input !== undefined ||
    r.output !== undefined ||
    r.context_in !== undefined ||
    r.context_out !== undefined ||
    r.reasoning !== undefined
  );
}

/**
 * `serves` says what the door answers; a capability says what the engine can
 * do. A route may declare capability fields on an engine whose spec serves no
 * endpoint at all to ask it through -- `GET /openai/v1/models` would simply
 * drop that route (`modelsMenu`'s `servedEngines` filter), which turns a
 * config mistake into a silently missing address rather than a loud one.
 * Checked here rather than at parse (`config.ts`) because `serves` comes from
 * the spec, and specs load after `loadConfig()`.
 */
export function checkCapabilityServed(
  engine: EngineEntry,
  spec: Spec,
  routes: readonly ResolvedRoute[],
): void {
  if (spec.serves.length > 0) {
    return;
  }
  for (const r of routes) {
    if (r.engine !== engine.id || !routeHasCapability(r)) {
      continue;
    }
    throw new FatalError(
      `route on engine "${engine.id}" model "${r.model ?? ""}" declares a capability, but engine "${engine.id}" (kind "${spec.kind}") serves no endpoint to ask it through`,
    );
  }
}

export function buildEntries(
  config: Config,
  specOptions: SpecLoadOptions,
  presetHostPath: string,
): Entry[] {
  return config.engines.map((engine) => {
    const spec = loadEngineSpec(engine, specOptions, presetHostPath);
    // `disable = true` is the operator's escape hatch, so it has to reach the
    // checks that would otherwise refuse the boot: an engine nothing may
    // start or route to cannot be the reason the daemon will not come up.
    if (!engine.disabled) {
      checkLocalFileDisposition(engine, spec.spec.kind, config.routes);
      checkWildcardRouteKind(engine, spec.spec.kind, config.routes);
      checkAgenticWire(engine, spec.spec, config.routes, config.upstreams);
      checkSelfUpstream(engine, spec.spec, config.routes, config.upstreams);
      checkCapabilityServed(engine, spec.spec, config.routes);
    }
    return { engine, spec };
  });
}

/**
 * What `id`'s own routes can be asked for: one entry per non-disabled route
 * that names a model or declares a capability field directly, in the
 * precedence `config.ts`'s `mergeCapabilities` already resolved (a route's
 * own field beats the `[[model]]` row it names). Several routes on one
 * engine report several entries rather than one merged answer -- see
 * `EngineCapability`'s own doc for why a merge would be the wrong call.
 * `undefined` rather than `[]` when there is nothing to report, matching
 * every other optional `EngineStatus` field.
 */
export function engineCapabilities(
  engineId: string,
  routes: readonly ResolvedRoute[],
  engineServes: readonly string[],
): EngineCapability[] | undefined {
  const capabilities = routes
    .filter((r) => r.engine === engineId && r.disabled !== true)
    .filter((r) => r.model !== undefined || routeHasCapability(r))
    .map(
      (r): EngineCapability => ({
        model: r.model,
        serves: routeServes(r, engineServes),
        role: r.role,
        vision: r.vision,
        input: r.input,
        output: r.output,
        context_in: r.context_in,
        context_out: r.context_out,
        reasoning: r.reasoning,
      }),
    );
  return capabilities.length > 0 ? capabilities : undefined;
}

/** The identity an engine reports whatever produced its runtime state: everything an `EngineStatus` carries that a probe cannot change. */
export function baseStatus(engine: EngineEntry, spec: Spec, routes: readonly ResolvedRoute[]) {
  return {
    id: engine.id,
    kind: spec.kind,
    serves: spec.serves,
    streaming: spec.streaming,
    capabilities: engineCapabilities(engine.id, routes, spec.serves),
  };
}

/** The reported shape of an engine, whichever way its runtime state was obtained. */
export function statusFrom({
  engine,
  spec,
  runtime,
  routes,
  superseded,
}: {
  engine: EngineEntry;
  spec: Spec;
  runtime: RuntimeStatus;
  routes: readonly ResolvedRoute[];
  superseded?: string;
}): EngineStatus {
  return {
    ...baseStatus(engine, spec, routes),
    state: runtime.state,
    fix: runtime.fix,
    superseded,
    last_error: runtime.last_error,
    active_leases: runtime.active_leases,
  };
}

/**
 * Everything a container start bakes in, as one comparable string: the
 * resolved spec that becomes the `docker run`, the two lifecycle timings, and
 * this engine's own routes, whose args render the presets INI that
 * llama-server reads exactly once at startup.
 *
 * Compared, never parsed. Both sides are built here, so key order is the same
 * on both and a plain `JSON.stringify` is a faithful comparison.
 */
export function engineShape(
  engine: EngineEntry,
  spec: Spec,
  routes: readonly ResolvedRoute[],
): string {
  return JSON.stringify({
    spec,
    idle: engine.idle_stop_seconds,
    ready: engine.ready_timeout_s,
    routes: routes.filter((r) => r.engine === engine.id),
  });
}
