/**
 * The one consumer and operator surface: composes config, spec loading and
 * the container lifecycle into `GET /engined/v1/engines`, `GET /openai/v1/models` and
 * `POST /engined/v1/engines/:id/start`. Nothing here talks to docker or parses TOML
 * directly — that is `docker.ts` and `spec.ts`'s job.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import process from "node:process";
import { mintLaunchNonce, type ObservedVersion, observeAgentVersion } from "./agentic.ts";
import { type AgentTarget, agentCli } from "./agents.ts";
import { buildComfySpec } from "./comfy.ts";
import { DockerLifecycle, dockerExec, type Probe, type RuntimeStatus } from "./docker.ts";
import type { Exec } from "./exec.ts";
import { CONTENT_TYPE, discardBody, JSON_CONTENT_TYPE, STATUS_OK } from "./http.ts";
import { buildLlamaSpec, renderPresetIni } from "./llama.ts";
import { llamaPresetPath, stateDir } from "./paths.ts";
import type { EngineResources } from "./resources.ts";
import { applyEngineArgs, loadSpec, type SpecLoadOptions } from "./spec.ts";
import {
  type AgenticSpec,
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTRACT,
  type Config,
  type Disposition,
  type EngineCapability,
  type EngineEntry,
  type EngineKind,
  type EngineStatus,
  type EnginesResponse,
  errMessage,
  FatalError,
  isContainerSpec,
  KIND_TRAITS,
  type LoadedSpec,
  MS_PER_SECOND,
  type ReadyProbe,
  type ResolvedRoute,
  type RunnableContainerSpec,
  routeForHop,
  routeServes,
  type Spec,
  type Upstream,
} from "./types.ts";

/** Set at build time by the install script; absent in a working-tree run. */
declare const ENGINED_COMMIT: string | undefined;

/** Lifecycle defaults live here rather than in config.ts: an engine that omits them is not a parse error, it just takes these. */
export const DEFAULT_IDLE_STOP_SECONDS = 900;
export const DEFAULT_READY_TIMEOUT_S = 60;

/**
 * Thrown by `EngineRegistry.start` when a model switch would kill requests
 * mid-flight: a warm is an optimization, and stopping a container to satisfy
 * one is strictly worse than warming late. A distinct class rather than a
 * plain `Error` so a caller can map it to 409 without parsing a message.
 */
export class EngineBusyError extends Error {}

/**
 * Comfy is the one engine whose idleness engined cannot observe, because it
 * proxies nothing for it: this polls Comfy's own `/queue` and drives the
 * lifecycle's existing lease timer from what it sees, rather than from
 * request traffic engined never gets. Short relative to `idle_stop_seconds`
 * (minutes), so a job that starts is noticed well before a stale deadline
 * inherited from the last empty poll could fire mid-job.
 */
const COMFY_POLL_INTERVAL_MS = 15_000;

export interface QueueSnapshot {
  queue_running: unknown[];
  queue_pending: unknown[];
}

type QueueFetch = (url: string) => Promise<QueueSnapshot>;
/** Overridable for tests; the release POST is the only other call engined makes into a running container. */
export type ReleaseFetch = (url: string, body: unknown) => Promise<{ ok: boolean; status: number }>;

async function defaultReleaseFetch(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  });
  // The status is the whole answer here; the body is never read, so release it.
  await discardBody(res);
  return { ok: res.ok, status: res.status };
}

async function defaultQueueFetch(url: string): Promise<QueueSnapshot> {
  const res = await fetch(url);
  return (await res.json()) as QueueSnapshot;
}

function isQueueEmpty(q: QueueSnapshot): boolean {
  return q.queue_running.length === 0 && q.queue_pending.length === 0;
}

/**
 * A spec-less engine's built-in spec has no spec directory, so its `serves`
 * list cannot come from a spec file. Mirrors the route table in
 * docs/http-api.md. Comfy is never reached this way, so it is absent from
 * this map's callers rather than mapped to `[]` here.
 */
const KIND_SERVES: Record<EngineKind, string[]> = {
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

function isLocalLlama(engine: EngineEntry, kind: EngineKind): boolean {
  return kind === "openai-http" && engine.models_dir !== undefined;
}

/** Whether any of this engine's own routes resolve to THIS box's own upstream -- the fact `reload`'s second pass keys a container teardown on. An engine with no routes at all (comfy, sometimes) has no binding either way. */
function hasLocalBinding(engineId: string, routes: readonly ResolvedRoute[]): boolean {
  return routes.some((r) => r.engine === engineId && r.upstream === "local");
}

/**
 * The read-only floor is version-specific, so a proved version is only
 * proof for that version. One file per engine, mirroring the llama
 * preset's own directory shape under the state directory.
 */
const AGENTIC_VERIFIED_DIR = (engineId: string): string => `${stateDir()}/agentic/${engineId}`;
const AGENTIC_VERIFIED_PATH = (engineId: string): string =>
  `${AGENTIC_VERIFIED_DIR(engineId)}/verified_version`;

function readVerifiedVersion(engineId: string): string | undefined {
  try {
    return readFileSync(AGENTIC_VERIFIED_PATH(engineId), "utf8").trim();
  } catch {
    // No file yet, or an unreadable one: this engine has no proved version.
  }
}

function writeVerifiedVersion(engineId: string, version: string): void {
  mkdirSync(AGENTIC_VERIFIED_DIR(engineId), { recursive: true });
  writeFileSync(AGENTIC_VERIFIED_PATH(engineId), version, "utf8");
}

interface AgenticProbeOutcome {
  ok: boolean;
  /** Which probe failed -- e.g. "byte-identical" or "no-hook-fires". Present only when `ok` is false. */
  failedProbe?: string;
  /** Why that probe failed, when it can say. */
  detail?: string;
}

/**
 * Runs the two probes the design names: a completion instructed to create a
 * file, worktree-hashed before and after, and a planted `UserPromptSubmit`
 * hook checked for silence. Injected rather than built in here -- each run
 * costs a real billed call to Anthropic, so wiring the real implementation
 * against a live `claude` is its own, separately-authorised task; nothing in
 * this module calls out to a subprocess.
 */
export type AgenticProbeRunner = (
  agentVersion: string,
  /** From the spec, never the engine entry: the floor is a property of the agent. */
  agent: string,
  /**
   * Where a real model-answer probe would dial, if this agent has one to
   * run and doing so is free -- `roundTripTargetFor`'s own output. Absent
   * whenever this engine's route leaves the box (claude, cursor): a round
   * trip through either is a billed call to a third party, and nothing here
   * should make a status poll pay for one. Present for opencode, whose
   * route names the `local` upstream -- its round trip runs on this box's
   * own GPU, so proving it costs nothing but time.
   */
  roundTrip?: AgentTarget,
) => Promise<AgenticProbeOutcome>;

/**
 * The one route on `engineId` that both names a model and keeps its prompt
 * on this box -- what a real round-trip probe would dial, or `undefined`
 * when no such route exists (a remote-only agent, or one with no route at
 * all). `local` is the same egress this box's own opencode route already
 * uses to say "does not leave the machine" -- reused here rather than
 * re-deriving egress from `[[upstream]]`, since a modelless engine or a
 * remote-upstream route has nothing this probe could answer for free anyway.
 */
function roundTripTargetFor(
  engineId: string,
  config: Config,
  nonce: string,
): AgentTarget | undefined {
  const route = config.routes.find(
    (r) => !r.disabled && r.engine === engineId && r.upstream === "local" && r.model !== undefined,
  );
  if (route?.model === undefined) {
    return undefined;
  }
  // `wire_model` first, for the same reason the real launch dials it: this
  // route's own segment names the agent, so handing it back points the child
  // at itself rather than at a model that answers.
  return {
    // The launch-scoped surface, exactly as a caller's own agentic dispatch
    // gets: a probe spawns a real agent, so the hop that reaches back here
    // has to be bounded by the same nonce or the recursion control has a
    // hole shaped like a status poll.
    baseUrl: `http://127.0.0.1:${config.listen_port}/openai/v1/${nonce}`,
    model: route.wire_model ?? route.model,
  };
}

function noAgentVersionConfiguredFix(engineId: string): string {
  return `engine "${engineId}" is agentic-cli with no agent_version configured`;
}

/** The binary itself could not be identified at all -- `resolveBinary` threw, or `--version` printed nothing. Distinct from a version mismatch: there is no "observed" version to compare here. */
function agentBinaryUnresolvedFix(engineId: string, reason: string): string {
  return `engine "${engineId}" agent binary could not be resolved: ${reason}`;
}

/**
 * `proved` is `readVerifiedVersion`'s own return -- `undefined` for an
 * engine that has never passed a probe at all, some other string for one
 * whose binary has since drifted out from under it (a self-update, for an
 * agent with no pin mechanism of its own). Both name `observed`, the
 * version any fresh probe run would actually be proving; only the drifted
 * case also names what the stale proof was for, since that is the fact an
 * operator needs to understand *why* a box that worked yesterday stopped.
 */
function noProbeRunnerConfiguredFix(
  engineId: string,
  observed: string,
  proved: string | undefined,
): string {
  if (proved === undefined) {
    return `engine "${engineId}" pin ${observed} has not been proved and no agentic probe runner is configured`;
  }
  return `engine "${engineId}" binary reports version ${observed}, but its read-only floor was last proved for ${proved} -- a self-updated binary invalidates that proof, and no agentic probe runner is configured to re-prove it`;
}

function probeFailedFix(
  engineId: string,
  observed: string,
  proved: string | undefined,
  failedProbe: string,
  detail: string | undefined,
): string {
  const why = detail === undefined ? "" : `: ${detail}`;
  if (proved === undefined) {
    return `engine "${engineId}" pin ${observed} failed the "${failedProbe}" probe${why}`;
  }
  return `engine "${engineId}" binary reports version ${observed}, but its read-only floor was last proved for ${proved} -- re-proving for ${observed} failed the "${failedProbe}" probe${why}`;
}

export interface RegistryOptions {
  /** Root of the shipped `engines/` directory, passed straight through to `loadSpec`. */
  enginesRoot: string;
  bunx: string;
  /** Injected together so the image probe below agrees with a test's fake lifecycle. */
  exec?: Exec;
  probe?: Probe;
  lifecycle?: DockerLifecycle;
  /** Overridable for tests: a fast interval against a fake `/queue` response. */
  queueFetch?: QueueFetch;
  releaseFetch?: ReleaseFetch;
  comfyPollIntervalMs?: number;
  /** Absent by default: an agentic-cli engine whose pin has never been proved stays `unavailable` until one is injected. */
  agenticProbeRunner?: AgenticProbeRunner;
  /**
   * The door's own live launch nonces, which a round-trip probe's launch is
   * registered in for as long as it runs. `createDoor` passes the set it
   * checks requests against; a registry built without one still scopes the
   * URL it hands a probe, but nothing is listening for that nonce, so a
   * probe that calls back is refused as unknown.
   */
  launchNonces?: Set<string>;
  /**
   * Overridable for tests: what `agenticStatus` treats as an agent's actual
   * running version, checked against the proved one on every status poll.
   * Defaults to `observeAgentVersion` (agentic.ts), which is a real
   * subprocess call only for an agent that resolves its own binary (cursor)
   * -- an npm-pinned agent (claude, opencode) never spawns anything here,
   * since its `bunx` pin already IS the observed version.
   */
  observeAgentVersion?: (agent: string, configuredVersion: string) => Promise<ObservedVersion>;
  /** Defaults under the one writable state dir; tests always override this. Must be the same path the door hands `LlamaRouter`, since one writes the file the other mounts. */
  presetHostPath?: string;
}

interface Entry {
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
function loadEngineSpec(
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

/** Where every container-kind engine's models_dir is bind-mounted; `filename` on a route is relative to it. */
const MODEL_MOUNT_PATH = "/models";

/**
 * The `-m <path>` pair in a stt-kind engine's own command, rewritten to name
 * one of its model-bearing routes' weights file -- the argv token that
 * differs between "@/whisper/small.en" and "@/whisper/medium.en". Whisper is
 * the only kind this ever runs for (`EngineRegistry.start` gates the call on
 * `kind === "stt"`), so an absent "-m" pair here is a spec that does not
 * actually take a model file and is a startup-time mistake, not a runtime one.
 */
function withModelFile(spec: RunnableContainerSpec, filename: string): RunnableContainerSpec {
  const idx = spec.command.indexOf("-m");
  if (idx === -1 || spec.command[idx + 1] === undefined) {
    throw new FatalError(
      `image "${spec.image}": no "-m <path>" pair in its command to substitute a model into`,
    );
  }
  const command = [...spec.command];
  command[idx + 1] = `${MODEL_MOUNT_PATH}/${filename}`;
  return { ...spec, command };
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
    if (rules.args === "forbidden" && Object.keys(r.args).length > 0) {
      throw new FatalError(`${site} must not declare "args"`);
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
function checkCapabilityServed(
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

function buildEntries(
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
function engineCapabilities(
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
        serves: routeServes(r.role, engineServes),
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
function baseStatus(engine: EngineEntry, spec: Spec, routes: readonly ResolvedRoute[]) {
  return {
    id: engine.id,
    kind: spec.kind,
    serves: spec.serves,
    streaming: spec.streaming,
    capabilities: engineCapabilities(engine.id, routes, spec.serves),
  };
}

/** The reported shape of an engine, whichever way its runtime state was obtained. */
function statusFrom(
  engine: EngineEntry,
  spec: Spec,
  runtime: RuntimeStatus,
  routes: readonly ResolvedRoute[],
  superseded?: string,
): EngineStatus {
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
function engineShape(engine: EngineEntry, spec: Spec, routes: readonly ResolvedRoute[]): string {
  return JSON.stringify({
    spec,
    idle: engine.idle_stop_seconds,
    ready: engine.ready_timeout_s,
    routes: routes.filter((r) => r.engine === engine.id),
  });
}

export class EngineRegistry {
  private readonly exec: Exec;
  private readonly lifecycle: DockerLifecycle;
  private readonly specOptions: SpecLoadOptions;
  private readonly queueFetch: QueueFetch;
  private readonly releaseFetch: ReleaseFetch;
  private readonly comfyPollIntervalMs: number;
  private readonly agenticProbeRunner?: AgenticProbeRunner;
  private readonly launchNonces: Set<string>;
  private readonly observeAgentVersion: (
    agent: string,
    configuredVersion: string,
  ) => Promise<ObservedVersion>;
  private readonly presetHostPath: string;
  /**
   * The shape each running container was started under, set when this registry
   * starts one. A later start overwrites it and only a running engine is ever
   * asked, so a leftover entry for something stopped cannot report a
   * supersession that is not there.
   */
  private readonly launchedShape = new Map<string, string>();
  private config: Config;
  private entries: Entry[];
  private byId: Map<string, Entry>;
  private comfyTimers: ReturnType<typeof setInterval>[] = [];
  /**
   * Last observed `/queue` emptiness per comfy-kind engine id. The lease is
   * armed once per transition into empty, never re-armed on every poll while
   * it stays empty — re-arming on every tick would reset the countdown
   * before it ever elapsed.
   */
  private readonly comfyQueueEmpty = new Map<string, boolean>();
  /** Per-engine agentic-probe cache/dedupe; see `runAgenticProbe`. */
  private readonly agenticProbeState = new Map<
    string,
    { version: string; outcome?: AgenticProbeOutcome; promise?: Promise<AgenticProbeOutcome> }
  >();
  /** Last version observation per agentic engine id, and the one refresh in flight for it; see `observedVersion`. */
  private readonly versionObservations = new Map<
    string,
    { configured: string; last?: ObservedVersion; inFlight?: Promise<ObservedVersion> }
  >();
  /**
   * The model each container-kind engine's own `start()` last requested --
   * whisper's only consumer today. Compared against a fresh `start(id, model)`
   * call to decide whether the running container actually needs a
   * stop-and-restart; a container that has never been asked for a specific
   * model (started via the plain warm path) has no entry here, which reads as
   * "unknown" rather than any real model id.
   */
  private readonly residentModel = new Map<string, string | undefined>();

  /**
   * How many `start()` calls are inside their own container work for each
   * engine. A lease is taken by the caller only once `start` has RETURNED,
   * and the last thing `start` does is a status probe worth several docker
   * round trips -- a competing model switch reading leases in that window
   * sees zero and would stop the container under a request already admitted.
   */
  private readonly startsInFlight = new Map<string, number>();

  constructor(config: Config, opts: RegistryOptions) {
    this.exec = opts.exec ?? dockerExec;
    this.lifecycle = opts.lifecycle ?? new DockerLifecycle(this.exec, opts.probe);
    this.specOptions = {
      enginesRoot: opts.enginesRoot,
      bunx: opts.bunx,
    };
    this.queueFetch = opts.queueFetch ?? defaultQueueFetch;
    this.releaseFetch = opts.releaseFetch ?? defaultReleaseFetch;
    this.comfyPollIntervalMs = opts.comfyPollIntervalMs ?? COMFY_POLL_INTERVAL_MS;
    this.agenticProbeRunner = opts.agenticProbeRunner;
    this.launchNonces = opts.launchNonces ?? new Set();
    this.observeAgentVersion = opts.observeAgentVersion ?? observeAgentVersion;
    this.presetHostPath = opts.presetHostPath ?? llamaPresetPath();
    this.config = config;
    this.entries = buildEntries(config, this.specOptions, this.presetHostPath);
    this.byId = new Map(this.entries.map((e) => [e.engine.id, e]));
    // Attached here, not passed to the constructor above: `createDoor` builds
    // its own lifecycle to share with the llama routers and hands it in, and
    // a constructor argument would never reach that one.
    this.lifecycle.onChange((id) => {
      this.announce(id);
    });
    this.comfyTimers = this.startComfyWatches(this.entries);
  }

  /**
   * Subscribers to engine state changes. A set, so a dropped connection
   * removes exactly its own listener and a reconnect is a fresh entry rather
   * than a duplicate of the old one.
   */
  private readonly watchers = new Set<(status: EngineStatus) => void>();

  /**
   * Subscribe to state changes; the returned function unsubscribes. Callers
   * get the changed engine's full status, not just its id -- a consumer
   * receiving only an id has to turn around and ask, which reintroduces the
   * polling the stream exists to remove.
   */
  watch(listener: (status: EngineStatus) => void): () => void {
    this.watchers.add(listener);
    return () => this.watchers.delete(listener);
  }

  /** A listener that throws must not stop the others from hearing about it. */
  private announce(id: string): void {
    const entry = this.byId.get(id);
    if (!entry || this.watchers.size === 0) {
      return;
    }
    // syncStatus, not statusFor: the async one runs an installability probe,
    // which is both a docker round trip on every transition and a path that
    // can itself transition -- announcing from inside it would recurse.
    const status = this.syncStatus(entry);
    for (const listener of this.watchers) {
      try {
        listener(status);
      } catch {
        // A broken subscriber is its own problem; the lifecycle transition
        // that triggered this has already happened either way.
      }
    }
  }

  /** One poll timer per `comfy`-kind engine; idleness for it comes from nowhere else. */
  private startComfyWatches(entries: Entry[]): ReturnType<typeof setInterval>[] {
    return entries
      .filter((e) => !e.engine.disabled && e.spec.spec.kind === "comfy")
      .map((entry) =>
        setInterval(() => {
          this.pollComfyQueue(entry).catch(() => undefined);
        }, this.comfyPollIntervalMs),
      );
  }

  /**
   * A transition into empty arms the same idle-stop lease every other
   * engine's request traffic arms, once; a transition into non-empty takes
   * that lease back, which is what cancels the pending stop. Not released or
   * taken on every tick: docker.ts's `endLease` resets its own countdown on
   * every call, so re-arming it every poll while the queue stays empty would
   * defer the stop forever.
   */
  private async pollComfyQueue(entry: Entry): Promise<void> {
    if (!isContainerSpec(entry.spec.spec)) {
      return;
    }
    const { engine } = entry;
    const status = this.lifecycle.getStatus(engine.id);
    if (status.state !== "running" || status.private_url === null) {
      this.comfyQueueEmpty.delete(engine.id);
      return;
    }
    let queue: QueueSnapshot;
    try {
      queue = await this.queueFetch(`http://${status.private_url}/queue`);
    } catch {
      // A refused poll is the only signal engined gets that this container
      // died underneath it -- nothing else asks docker about a comfy engine
      // between starts. `reconcile` lets docker decide, so a poll that failed
      // against a container still genuinely up changes nothing here.
      const reconciled = await this.lifecycle.reconcile(engine.id);
      if (reconciled.state !== "running") {
        this.comfyQueueEmpty.delete(engine.id);
      }
      return;
    }
    const empty = isQueueEmpty(queue);
    // Unknown starts as empty: a first observation of a BUSY queue is then a
    // real transition and takes a lease, rather than leaving a working Comfy
    // counting down against the idle-stop its own start armed.
    const wasEmpty = this.comfyQueueEmpty.get(engine.id) ?? true;
    this.comfyQueueEmpty.set(engine.id, empty);
    if (empty && !wasEmpty) {
      this.lifecycle.endLease(engine.id, engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
    } else if (!empty && wasEmpty) {
      // The lease alone cancels the pending stop, and taking it synchronously
      // is the point: a docker round trip here is a window in which the
      // container holds neither a lease nor a countdown, and a model switch
      // landing in it stops a comfy the queue has just reported working. The
      // queue answering at all is better proof the container is up than any
      // reconcile.
      this.lifecycle.beginLease(engine.id);
    }
  }

  /**
   * Everything `getStatus`/spec loading already know, with no docker round
   * trip and no version proof: optimistic `installed`, the same resting
   * assumption a container gets before its first probe. `statusFor` is the
   * authoritative, async check.
   */
  private syncStatus(entry: Entry): EngineStatus {
    const { engine } = entry;
    if (engine.disabled) {
      return this.disabledStatus(entry);
    }

    const { spec } = entry.spec;
    if (!isContainerSpec(spec)) {
      return { ...baseStatus(engine, spec, this.config.routes), state: "installed" };
    }

    const runtime = this.lifecycle.getStatus(engine.id);
    return statusFrom(engine, spec, runtime, this.config.routes, this.supersededBy(entry, runtime));
  }

  /**
   * The literal call that brings a running container up to the config now in
   * force, or `undefined` when it is already on it.
   *
   * Only ever asked of something running: a stopped engine reads its current
   * config at its next start by construction, and reporting supersession for
   * one would be reporting a problem that does not exist.
   */
  private supersededBy(entry: Entry, runtime: RuntimeStatus): string | undefined {
    if (runtime.state !== "running") {
      return undefined;
    }
    const launched = this.launchedShape.get(entry.engine.id);
    if (
      launched === undefined ||
      launched === engineShape(entry.engine, entry.spec.spec, this.config.routes)
    ) {
      return undefined;
    }
    return `curl -s -X POST localhost:${this.config.listen_port}/engined/v1/engines/${entry.engine.id}/stop`;
  }

  /**
   * Reported, not inspected: no docker probe, no version proof. `unavailable`
   * is the honest state -- nothing here is servable -- and `disabled` is what
   * separates it from an engine that is unavailable for a reason the operator
   * would have to go fix. `fix` names the edit that undoes it, the same as
   * every other unavailable engine.
   */
  private disabledStatus(entry: Entry): EngineStatus {
    const { engine, spec } = entry;
    return {
      ...baseStatus(engine, spec.spec, this.config.routes),
      state: "unavailable",
      disabled: true,
      fix: `set "disable = false" on engine "${engine.id}" in config.toml`,
    };
  }

  /**
   * `syncStatus` for a container engine's non-running case is superseded by
   * `lifecycle.probe`, which checks image *and* artifact presence read-only
   * (never starts a container) so a never-started engine with either missing
   * reports `unavailable` on the very first `GET /engined/v1/engines` rather than
   * waiting for a start attempt to notice.
   */
  private async statusFor(entry: Entry, fresh = true): Promise<EngineStatus> {
    if (entry.engine.disabled) {
      return this.disabledStatus(entry);
    }
    const { spec, source } = entry.spec;
    if (!isContainerSpec(spec)) {
      if (spec.kind === "agentic-cli") {
        return this.agenticStatus(entry.engine, spec, fresh);
      }
      // A spec-less proxy: nothing to probe and nothing resident -- an
      // address is either configured or it is not, and syncStatus's
      // optimistic `installed` already says as much.
      return this.syncStatus(entry);
    }
    const { engine } = entry;
    return statusFrom(
      engine,
      spec,
      await this.lifecycle.probe(
        engine.id,
        spec,
        source,
        engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
      ),
      this.config.routes,
    );
  }

  /**
   * The version-proof gate: an engine whose binary has never been proved
   * reports `unavailable` rather than serving on faith. The floor is
   * version-scoped, so what has to match the last-proved version is what the
   * binary reports RIGHT NOW (`this.observeAgentVersion`), never the
   * configured pin on its own -- for an npm-pinned agent those are always
   * the same value (`bunx` fetches and pins in one step), but a self-updating
   * agent with no pin mechanism of its own (cursor) can drift away from its
   * configured pin between one status poll and the next, and a proof for a
   * binary that no longer exists is not a proof of anything running now.
   *
   * Re-verification only runs when the observed version differs from the one
   * last proved — keyed off what is actually installed rather than what
   * config says it should be. A pin that
   * FAILS is cached the same way: the failed outcome for that exact version
   * is remembered so every later poll reports it for free until the version
   * changes again, and two polls racing on the same unproved version share
   * one in-flight probe instead of each billing their own — see
   * `runAgenticProbe`.
   */
  private async agenticStatus(
    engine: EngineEntry,
    spec: AgenticSpec,
    fresh: boolean,
  ): Promise<EngineStatus> {
    const base = baseStatus(engine, spec, this.config.routes);
    const provable = await this.provableVersion(engine, spec.agent, fresh);
    if ("fix" in provable) {
      return { ...base, state: "unavailable", fix: provable.fix };
    }
    const { version } = provable;
    const proved = readVerifiedVersion(engine.id);
    if (proved === version) {
      return { ...base, state: "installed" };
    }
    if (this.agenticProbeRunner === undefined) {
      return {
        ...base,
        state: "unavailable",
        fix: noProbeRunnerConfiguredFix(engine.id, version, proved),
      };
    }
    const outcome = await this.runAgenticProbe(
      engine,
      version,
      spec.agent,
      this.agenticProbeRunner,
    );
    if (!outcome.ok) {
      return {
        ...base,
        state: "unavailable",
        fix: probeFailedFix(
          engine.id,
          version,
          proved,
          outcome.failedProbe ?? "unknown",
          outcome.detail,
        ),
      };
    }
    writeVerifiedVersion(engine.id, version);
    this.agenticProbeState.delete(engine.id);
    return { ...base, state: "installed" };
  }

  /**
   * The version the agent's binary reports right now, or the `fix` naming
   * why nothing can be proved for it at all. Three ways to have no version
   * and one to have one, which is the whole reason this is not inline.
   */
  private async provableVersion(
    engine: EngineEntry,
    agent: string,
    fresh: boolean,
  ): Promise<{ version: string } | { fix: string }> {
    if (engine.agent_version === undefined) {
      return { fix: noAgentVersionConfiguredFix(engine.id) };
    }
    const observed = await this.observedVersion(engine.id, agent, engine.agent_version, fresh);
    if (!observed.ok) {
      return { fix: agentBinaryUnresolvedFix(engine.id, observed.error ?? "unknown") };
    }
    return observed.version === undefined
      ? { fix: agentBinaryUnresolvedFix(engine.id, "no version reported") }
      : { version: observed.version };
  }

  /**
   * An agent that resolves its own binary observes its version by running
   * that binary, and cursor's reaches the network on `--version` -- so the
   * worst case is a stall nothing here bounds, and it lands inside whatever
   * asked for the status.
   *
   * A launch pays it regardless: `proveAgenticPin` starts the engine before
   * every agentic call, and a version read that is anything but current
   * would let a self-updated binary run on a proof of the one it replaced.
   * A listing does not -- it reports state rather than acting on it, and
   * every consumer polls it -- so it answers from the last observation and
   * refreshes behind itself, converging one poll later. One refresh per
   * engine is in flight at a time, which is what keeps a stalled binary
   * from accumulating a spawn per poll.
   *
   * Keyed by the configured pin, so a bump misses this on its own: for an
   * agent whose pin already IS its observed version, config is the only
   * thing an observation could report, and a reload must not be answered
   * from what the previous pin said.
   */
  private observedVersion(
    engineId: string,
    agent: string,
    configuredVersion: string,
    fresh: boolean,
  ): Promise<ObservedVersion> {
    const cached = this.versionObservations.get(engineId);
    const state =
      cached?.configured === configuredVersion ? cached : { configured: configuredVersion };
    this.versionObservations.set(engineId, state);
    if (state.inFlight === undefined) {
      state.inFlight = this.observeAgentVersion(agent, configuredVersion)
        .catch((err): ObservedVersion => ({ ok: false, error: errMessage(err) }))
        .then((observed) => {
          state.last = observed;
          state.inFlight = undefined;
          return observed;
        });
    }
    return fresh || state.last === undefined ? state.inFlight : Promise.resolve(state.last);
  }

  /**
   * One real probe per (engine, pin) in flight at a time. A pin already
   * being probed hands every caller the same promise; a pin that already
   * failed hands every caller the cached outcome with no runner call at
   * all. Keyed by version, so a pin bump — the only sanctioned way to
   * re-arm this gate — misses the cache on its own, with no separate
   * invalidation needed.
   *
   * A probe that dials a round trip spawns a real agent, so it mints a launch
   * nonce and holds it live for exactly the runner's own window, the same
   * bracket the door's dispatch keeps around a caller's launch.
   */
  private runAgenticProbe(
    engine: EngineEntry,
    version: string,
    agent: string,
    runner: AgenticProbeRunner,
  ): Promise<AgenticProbeOutcome> {
    const cached = this.agenticProbeState.get(engine.id);
    if (cached?.version === version) {
      if (cached.promise) {
        return cached.promise;
      }
      if (cached.outcome) {
        return Promise.resolve(cached.outcome);
      }
    }
    const nonce = mintLaunchNonce();
    const roundTrip = roundTripTargetFor(engine.id, this.config, nonce);
    if (roundTrip !== undefined) {
      this.launchNonces.add(nonce);
    }
    const promise = runner(version, agent, roundTrip)
      .then((outcome) => {
        this.agenticProbeState.set(engine.id, {
          version,
          outcome: outcome.ok ? undefined : outcome,
        });
        return outcome;
      })
      .finally(() => {
        this.launchNonces.delete(nonce);
      });
    this.agenticProbeState.set(engine.id, { version, promise });
    return promise;
  }

  async list(): Promise<EnginesResponse> {
    const engines = await Promise.all(this.entries.map((e) => this.statusFor(e, false)));
    return {
      contract: CONTRACT,
      commit: typeof ENGINED_COMMIT === "string" ? ENGINED_COMMIT : "unknown",
      engines,
    };
  }

  /** Whether an id names the local llama, which is the only engine the extras routes can address. */
  isLocalLlama(id: string): boolean {
    const entry = this.byId.get(id);
    return entry !== undefined && isLocalLlama(entry.engine, entry.spec.spec.kind);
  }

  /** Endpoints a given *engine* id serves, for the door's model/endpoint mismatch check. */
  serves(id: string): string[] {
    return this.byId.get(id)?.spec.spec.serves ?? [];
  }

  /** The configured engine itself — secret, base_url, args, timeouts — as distinct from `get`'s runtime status. */
  entry(id: string): EngineEntry | undefined {
    return this.byId.get(id)?.engine;
  }

  /** This engine's resolved spec, for a door verb that reads something the spec ships (a comfy engine's `images_workflow`). */
  specFor(id: string): Spec | undefined {
    return this.byId.get(id)?.spec.spec;
  }

  /** Sync accessor: reports the lifecycle's cached state — no image probe, no keyring lookup. */
  get(id: string): EngineStatus | undefined {
    const entry = this.byId.get(id);
    return entry ? this.syncStatus(entry) : undefined;
  }

  /** The route `model` names on `id`, or `undefined` when no model was asked for. Throws when one was asked for and none matches. */
  private routeForStart(id: string, model: string | undefined): ResolvedRoute | undefined {
    if (model === undefined) {
      return undefined;
    }
    const route = routeForHop(this.config.routes, id, model);
    if (route === undefined) {
      throw new Error(`model "${model}" not found on "${id}"`);
    }
    return route;
  }

  /**
   * Stops the running container when `model` differs from the one already
   * resident, so the `lifecycle.start` call after this recreates it rather
   * than reconciling onto the still-running old one. Refuses with
   * `EngineBusyError` instead of stopping while a request still holds the
   * container open: a warm is an optimization, and killing one in flight to
   * satisfy it is strictly worse than warming late.
   */
  private async stopForModelSwitch(id: string, model: string | undefined): Promise<void> {
    if (model === undefined || this.residentModel.get(id) === model) {
      return;
    }
    if ((this.startsInFlight.get(id) ?? 0) > 0) {
      throw new EngineBusyError(
        `engine "${id}" is starting for another request; switching to model "${model}" would stop it under a request already admitted`,
      );
    }
    const current = this.lifecycle.getStatus(id);
    if (current.state !== "running") {
      return;
    }
    if ((current.active_leases ?? 0) > 0) {
      throw new EngineBusyError(
        `engine "${id}" is serving ${current.active_leases} active request(s); switching to model "${model}" would stop them mid-flight`,
      );
    }
    await this.lifecycle.stop(id);
  }

  /**
   * `model`, when given, selects which of the engine's own model-bearing
   * routes should be resident -- meaningful only for a `kind === "stt"`
   * engine today (whisper), which loads its model at container start rather
   * than through a router like llama's.
   *
   * `opts.lease` hands back a container already held for the caller's own
   * request. A caller that takes its own lease after this resolves cannot:
   * `startsInFlight` stops covering the engine the moment `start` returns,
   * and the caller's continuation is a microtask later -- a competing model
   * switch running in between reads zero leases and no start in flight, and
   * stops a container under a request already admitted. Taken here, the
   * in-flight guard and the lease are one continuous interval.
   */
  async start(
    id: string,
    model?: string,
    opts?: { lease?: boolean },
  ): Promise<EngineStatus & { launched: boolean }> {
    const entry = this.byId.get(id);
    if (!entry) {
      throw new Error(`unknown engine "${id}"`);
    }
    // Listed by `GET /engined/v1/engines` and startable are different things: an
    // operator can see it is off, and starting it is still the config edit.
    if (entry.engine.disabled) {
      throw new Error(`engine "${id}" is disabled in config`);
    }
    // Refused rather than queued: the holder wants the weights out of the pool,
    // and a start that waited would leave the caller blocked for as long as the
    // hold stands with nothing said about why.
    const heldMs = this.lifecycle.heldMsFor(id);
    if (heldMs > 0) {
      throw new Error(
        `engine "${id}" is held for another ${Math.ceil(heldMs / MS_PER_SECOND)}s; whatever took the hold wants this engine's memory`,
      );
    }
    if (!isContainerSpec(entry.spec.spec)) {
      // Nothing to warm up: a spec-less proxy or an agentic-cli engine has
      // no standing container.
      return { ...(await this.statusFor(entry)), launched: false };
    }
    // A fresh start's first queue observation must be a real transition, not
    // one suppressed by stale queue-emptiness from an earlier session.
    this.comfyQueueEmpty.delete(id);
    if (isLocalLlama(entry.engine, entry.spec.spec.kind)) {
      this.renderLocalLlamaPreset(entry.engine);
    }
    const route = this.routeForStart(id, model);
    const spec =
      route?.filename !== undefined && entry.spec.spec.kind === "stt"
        ? withModelFile(entry.spec.spec, route.filename)
        : entry.spec.spec;
    await this.stopForModelSwitch(id, model);
    this.startsInFlight.set(id, (this.startsInFlight.get(id) ?? 0) + 1);
    try {
      // `launched` is the lifecycle start lock's own answer to "did this call
      // spawn it", not a pre-read snapshot -- two concurrent calls on one cold
      // engine resolve to exactly one `true`.
      const { launched } = await this.lifecycle.start(id, spec, {
        idleStopSeconds: entry.engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
        readyTimeoutS: entry.engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
        specSource: entry.spec.source,
      });
      this.residentModel.set(id, model);
      this.launchedShape.set(id, engineShape(entry.engine, entry.spec.spec, this.config.routes));
      if (opts?.lease === true) {
        this.lifecycle.beginLease(id);
      }
      return { ...(await this.statusFor(entry)), launched: launched ?? false };
    } finally {
      this.leaveStart(id);
    }
  }

  /** The `finally` half of `startsInFlight`: the entry is dropped at zero rather than left holding a 0. */
  private leaveStart(id: string): void {
    const left = (this.startsInFlight.get(id) ?? 1) - 1;
    if (left > 0) {
      this.startsInFlight.set(id, left);
    } else {
      this.startsInFlight.delete(id);
    }
  }

  /**
   * The bind-mounted INI llama-server reads once at startup, re-rendered on
   * every start so a config edit to `[[route]]`/`[engine.args]` reaches the
   * container the next time it actually starts, per the reload rule. Filtered
   * on `(engine, upstream === "local")`: a route proxied to a peer's llama
   * has nothing resident on this box to render a section for.
   */
  private renderLocalLlamaPreset(engine: EngineEntry): void {
    const routes = this.config.routes.filter(
      (r) => r.engine === engine.id && r.upstream === "local",
    );
    mkdirSync(dirname(this.presetHostPath), { recursive: true });
    writeFileSync(this.presetHostPath, renderPresetIni(engine, routes), "utf8");
  }

  /**
   * Why a per-container read cannot answer for this engine, or `undefined` if
   * it can. A spec-less proxy or an agentic-cli engine has no container, and
   * says so rather than returning an empty result that reads like a quiet one.
   */
  private containerRefusal(id: string): { error: string } | undefined {
    const entry = this.byId.get(id);
    if (!entry) {
      return { error: `unknown engine "${id}"` };
    }
    if (!isContainerSpec(entry.spec.spec)) {
      return { error: `"${id}" runs no container of its own` };
    }
    return undefined;
  }

  /** `docker logs --tail` for a container-backed engine. */
  async logs(id: string, tail: number): Promise<{ lines: string[] } | { error: string }> {
    const refusal = this.containerRefusal(id);
    if (refusal) {
      return refusal;
    }
    const res = await this.lifecycle.logs(id, tail);
    return res.ok ? { lines: res.lines } : { error: res.error };
  }

  /** What a running container holds. See resources.ts for why RAM alone is not the answer. */
  async resources(id: string): Promise<EngineResources | { error: string }> {
    const refusal = this.containerRefusal(id);
    if (refusal) {
      return refusal;
    }
    const res = await this.lifecycle.resources(id);
    return res.ok ? res.resources : { error: res.error };
  }

  /**
   * Explicit stop, for an operator reclaiming the GPU rather than waiting out
   * the idle countdown. Stopping something already stopped is a no-op that
   * reports the same state, so a consumer never has to check first.
   */
  async stop(id: string): Promise<EngineStatus> {
    const entry = this.byId.get(id);
    if (!entry) {
      throw new Error(`unknown engine "${id}"`);
    }
    if (isContainerSpec(entry.spec.spec)) {
      this.comfyQueueEmpty.delete(id);
      await this.lifecycle.stop(id);
    }
    return this.statusFor(entry);
  }

  /**
   * Stops this engine and keeps it stopped, so something outside this process
   * can load the same weights without racing the door for the pool. Only a
   * container engine can be held: nothing else occupies memory the holder
   * could want back.
   */
  async hold(id: string, seconds: number): Promise<EngineStatus> {
    const entry = this.byId.get(id);
    if (!entry) {
      throw new Error(`unknown engine "${id}"`);
    }
    if (!isContainerSpec(entry.spec.spec)) {
      throw new Error(`engine "${id}" runs no container, so there is nothing to hold`);
    }
    this.comfyQueueEmpty.delete(id);
    await this.lifecycle.hold(id, seconds * MS_PER_SECOND);
    return this.statusFor(entry);
  }

  /** Ends a hold early. Idempotent, because the state the caller wants is "not held" either way. */
  async unhold(id: string): Promise<EngineStatus> {
    const entry = this.byId.get(id);
    if (!entry) {
      throw new Error(`unknown engine "${id}"`);
    }
    this.lifecycle.unhold(id);
    return this.statusFor(entry);
  }

  /**
   * Drops an engine's loaded weights without stopping it -- the operation a
   * consumer wants between phases, when the GPU is needed for something else
   * but the container's own startup is not worth paying again. ComfyUI reloads
   * its custom nodes on boot, which is the cost `stop` would charge here.
   *
   * Only comfy has such an endpoint: llama's residency is engined's own to
   * manage (`models_max` and the router's swap), so an outside release would
   * fight it, and a TTS or STT container reloads in about a second, which is
   * cheaper than the endpoint needed to avoid it. Never silently a no-op: a
   * caller told the memory was released when it was not would go on to
   * schedule work that cannot fit.
   */
  async release(id: string): Promise<{ released: true } | { error: string }> {
    const entry = this.byId.get(id);
    if (!entry) {
      return { error: `unknown engine "${id}"` };
    }
    const { kind } = entry.spec.spec;
    if (kind !== "comfy") {
      return { error: `"${id}" (${kind}) has no release endpoint; stop it instead` };
    }
    const endpoint = { path: "/free", body: { unload_models: true, free_memory: true } };
    const status = this.lifecycle.getStatus(id);
    if (status.state !== "running" || status.private_url === null) {
      // Nothing is loaded, so nothing is held -- the caller's intent is
      // already satisfied and failing here would make them special-case it.
      return { released: true };
    }
    const res = await this.releaseFetch(
      `http://${status.private_url}${endpoint.path}`,
      endpoint.body,
    );
    return res.ok ? { released: true } : { error: `${id}: release failed with HTTP ${res.status}` };
  }

  /**
   * A reload's teardown, in the background because `reload` is synchronous.
   * A teardown that fails is reported rather than swallowed: whatever it did
   * not stop is no longer in the lifecycle's map, so `shutdown` will not
   * reach it either and this line is the only trace it outlived the reload.
   */
  private teardown(id: string): void {
    this.launchedShape.delete(id);
    this.lifecycle.removeEngine(id).catch((err: unknown) => {
      process.stderr.write(`${id}: teardown after reload failed: ${errMessage(err)}\n`);
    });
  }

  /**
   * In-flight work keeps using the entries captured at call time; only new
   * lookups see the rebuilt map. An engine dropped from `config` is stopped
   * in the background rather than left orphaned; a running container whose
   * shape changed is left alone until its next start.
   */
  reload(config: Config): void {
    const newEntries = buildEntries(config, this.specOptions, this.presetHostPath);
    // A newly-disabled engine is torn down like a removed one: it keeps its
    // entry so the route can report it, but nothing of it may keep running.
    const newIds = new Set(newEntries.filter((e) => !e.engine.disabled).map((e) => e.engine.id));
    for (const old of this.entries) {
      if (!newIds.has(old.engine.id)) {
        this.teardown(old.engine.id);
      }
    }
    // A second, independent pass: an engine present in BOTH configs -- the
    // id diff above only catches an add or a remove -- whose LOCAL binding
    // changed. Repointing llama's own routes away from "local" changes no
    // engine id, so nothing else would notice its container is now
    // orphaned, with nothing routed to it on this box. Never merged with
    // the id-diff pass: an engine with no routes at all (comfy, sometimes)
    // has no binding either way, so a bindings-only rule would silently
    // stop managing it while still typechecking -- exactly the failure
    // class this delivery removes elsewhere.
    for (const old of this.entries) {
      if (!newIds.has(old.engine.id)) {
        continue;
      }
      const hadLocal = hasLocalBinding(old.engine.id, this.config.routes);
      const hasLocal = hasLocalBinding(old.engine.id, config.routes);
      if (hadLocal && !hasLocal) {
        this.teardown(old.engine.id);
      }
    }
    this.config = config;
    this.entries = newEntries;
    this.byId = new Map(newEntries.map((e) => [e.engine.id, e]));
    for (const timer of this.comfyTimers) {
      clearInterval(timer);
    }
    this.comfyTimers = this.startComfyWatches(newEntries);
  }

  async shutdown(): Promise<void> {
    for (const timer of this.comfyTimers) {
      clearInterval(timer);
    }
    this.comfyTimers = [];
    await this.lifecycle.shutdown();
  }
}
