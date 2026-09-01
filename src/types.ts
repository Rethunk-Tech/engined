/**
 * The shapes every module shares, plus the few pure helpers that read them
 * (`probeSaysReady`, `argvFromArgs`, the agentic-floor assertions). Depends on
 * nothing but `http.ts`'s status names, so config parse, spec loading,
 * lifecycle and the door can be written against one another without importing
 * each other's implementations.
 */

import { STATUS_NOT_FOUND } from "./http.ts";

/** Occupancy is one resident GGUF per role, so the set is closed. */
export type Role = "chat" | "vision" | "embedding";

/**
 * Where an upstream's bytes travel, ordered least to most exposed. Lives on
 * `Upstream` now, not on an engine -- an engine has no address of its own
 * to leak from, only the upstream it is paired with does. An ambient route
 * (no upstream at all) is `"remote"`: the CLI's own login leaves the box the
 * same as any other network call.
 */
export type Egress = "none" | "lan" | "remote";

/** The only legal ordering on `Egress`. Index into this, never compare the strings themselves. */
export const EGRESS_RANK: Record<Egress, number> = { none: 0, lan: 1, remote: 2 };

/**
 * The ONLY legal comparison on `Egress`. Bare `<`/`<=` is banned: alphabetically
 * `"lan" < "none" < "remote"`, so the natural spelling admits a `lan` hop under a
 * `none` ceiling -- it typechecks, lints clean, and is wrong on the one boundary
 * that is a safety property.
 */
export function withinCeiling(value: Egress, ceiling: Egress | undefined): boolean {
  if (ceiling === undefined) {
    return true;
  }
  return EGRESS_RANK[value] <= EGRESS_RANK[ceiling];
}

export type EngineKind = "openai-http" | "agentic-cli" | "tts" | "stt" | "comfy";

/** The two request/response shapes an upstream can speak. An agent CLI speaks one; pairing it with the other is a parse error. */
export type Wire = "openai" | "anthropic";

/** How an engine gets an upstream when a route names none: itself (`self`), the ambient CLI login (`optional`), or its one declared upstream (`required`). */
export type UpstreamTrait = "self" | "optional" | "required";

/** Whether a route field is mandatory, forbidden, or takes either -- the split predicate's answer once `kind` is known. */
export type Disposition = "required" | "forbidden" | "allowed";

/** `filename`/`role`/`args` dispositions for a route on a given engine kind, checked at registry construction once `kind` is known. */
export interface RouteFieldRules {
  filename: Disposition;
  role: Disposition;
  args: Disposition;
}

/**
 * One table, whose value says what each kind is. Typed as a complete record
 * over `EngineKind`, so adding or removing a kind fails to compile here until
 * this file gives the new one an explicit answer -- which is the whole point:
 * an inline `kind === "a" || kind === "b"` elsewhere silently omits it.
 */
const KIND_TRAITS: Record<
  EngineKind,
  { container: boolean; upstream: UpstreamTrait; localFile: RouteFieldRules }
> = {
  "openai-http": {
    container: true,
    // A spec-less openai-http engine (openrouter) is a pure proxy: it must
    // name the one upstream it proxies to, there being no "self" to default to.
    upstream: "required",
    localFile: { filename: "required", role: "required", args: "allowed" },
  },
  // The only kind that runs no container at all.
  "agentic-cli": {
    container: false,
    upstream: "optional",
    localFile: { filename: "forbidden", role: "forbidden", args: "forbidden" },
  },
  tts: {
    container: true,
    upstream: "self",
    localFile: { filename: "forbidden", role: "forbidden", args: "forbidden" },
  },
  stt: {
    container: true,
    upstream: "self",
    localFile: { filename: "required", role: "forbidden", args: "allowed" },
  },
  comfy: {
    container: true,
    // comfy runs here or on some peer's `local`, never against a foreign provider.
    upstream: "self",
    localFile: { filename: "forbidden", role: "forbidden", args: "forbidden" },
  },
};

const KIND_ENTRIES = Object.entries(KIND_TRAITS) as [
  EngineKind,
  (typeof KIND_TRAITS)[EngineKind],
][];

/** The complete kind list `parseKind` accepts; config.ts's source of truth. */
export const ENGINE_KINDS: readonly EngineKind[] = KIND_ENTRIES.map(([kind]) => kind);

/** Kinds whose spec is the container dialect. */
export const CONTAINER_KINDS: ReadonlySet<EngineKind> = new Set(
  KIND_ENTRIES.filter(([, t]) => t.container).map(([kind]) => kind),
);

/** A spec-less engine's upstream trait, keyed by its declared `kind`. A spec-full engine's trait comes from its own spec instead -- see `spec.ts`'s `upstream` key. */
export const KIND_UPSTREAM_TRAIT: Record<EngineKind, UpstreamTrait> = Object.fromEntries(
  KIND_ENTRIES.map(([kind, t]) => [kind, t.upstream]),
) as Record<EngineKind, UpstreamTrait>;

/** A spec-less engine's filename/role/args disposition, keyed by its declared `kind`. */
export const KIND_LOCAL_FILE_RULES: Record<EngineKind, RouteFieldRules> = Object.fromEntries(
  KIND_ENTRIES.map(([kind, t]) => [kind, t.localFile]),
) as Record<EngineKind, RouteFieldRules>;

/**
 * There is no `idle`: idle-stop leaves an engine `installed` with nothing
 * running, which reads identically to one that has never started because
 * operationally it is.
 */
export type EngineState = "unavailable" | "installed" | "warming" | "running";

/** Names a keyring pair and the header to project it into. Never a value. */
export interface SecretRef {
  service: string;
  username: string;
  header: string;
  /** The auth scheme prefix a provider expects before the credential, e.g. "Bearer". Absent means the header carries the raw value. */
  scheme?: string;
}

/**
 * Fields shared by a `[[model]]` capability row and a `[[route]]`'s own
 * overrides of it -- a route may state a capability a provider tier
 * genuinely differs on without needing a whole second `[[model]]` row.
 */
export interface ModelCapabilities {
  input?: string[];
  output?: string[];
  context_in?: number;
  context_out?: number;
  reasoning?: string[];
}

/**
 * A name and what it can do, unrelated to any engine or upstream -- a model
 * is a name with capabilities; which engines and upstreams can reach it is
 * entirely `[[route]]`'s business. Optional: a route may name a model with
 * no row here at all, and `/openai/v1/models` reports empty capabilities for it.
 */
export interface ModelEntry extends ModelCapabilities {
  id: string;
}

/**
 * One route's own resolved capability fields, alongside the model they
 * describe -- absent `model` reports the fields a modelless route declared
 * directly on itself. An engine with several model-bearing routes reports
 * one of these per route rather than merging them into a single answer: two
 * routes on the same engine may genuinely differ (different context windows
 * on different upstream tiers, for one), and merging would silently pick a
 * winner the way `EnginesResponse` never has elsewhere.
 */
export interface EngineCapability extends ModelCapabilities {
  model?: string;
}

/** Names a keyring pair, an address and the wire it speaks -- *where* the bytes for a route come from, never *how* they are produced. */
export interface Upstream {
  id: string;
  base_url?: string;
  secret?: SecretRef;
  egress: Egress;
  wire?: Wire;
  disabled?: boolean;
}

/**
 * One engine paired with one upstream, resolved out of a `[[route]]` table
 * plus whatever `[[model]]` row (if any) its `model` names. `engine`,
 * `upstream` and `model` are three independent things related many-to-many:
 * none owns another, and a route is the only place that says which pairing
 * actually exists.
 */
export interface ResolvedRoute extends ModelCapabilities {
  engine: string;
  /** Absent on a MODELLESS route (comfy, and every media engine): this engine runs on this upstream and nothing more. */
  model?: string;
  /** The id the upstream knows this model by, when that differs from the name it is addressed by. Sent on the wire in place of `model` whenever present. */
  wire_model?: string;
  /** `null` === ambient: no upstream, the CLI's own login. Egress is `"remote"`. */
  upstream: string | null;
  /** Absent by construction whenever `upstream` is not `"local"`: a route proxied elsewhere has no local file to describe. */
  filename?: string;
  role?: Role;
  /**
   * Load this GGUF when its engine starts, and reload it whenever its role
   * falls idle again — warmth guaranteed against idleness, never against
   * contention. Occupancy is still one model per role, so a request for a
   * different model on the same role wins the swap exactly as it does now;
   * this only decides what the role returns to once nothing is waiting.
   *
   * It necessarily pins the container up too: idle-stop stops the whole
   * container, so an engine with one of these never idle-stops and holds its
   * share of the pool until engined is reloaded. That is the cost, and it is
   * why this is opt-in per route rather than a default.
   */
  keep_resident?: boolean;
  /** Overrides the engine spec's `streaming` for this one route: a provider tier that cannot chunk what its siblings can. Absent means the engine's own answer. */
  streaming?: boolean;
  /** Rendered into this model's section of the presets INI, verbatim. */
  args: Record<string, unknown>;
  /**
   * Configured but not served: this route, its engine, or its upstream
   * carries `disable = true`. Kept on the entry rather than dropped from
   * `Config` so a caller asking why a route is unreachable gets a real
   * answer.
   */
  disabled?: boolean;
}

export interface EngineEntry {
  id: string;
  /**
   * Configured but not served: this engine's own `[[engine]]` table carries
   * `disable = true`. Kept on the entry rather than filtered out of `Config`
   * so `GET /engined/v1/engines` can report it as off — which is the
   * difference an operator needs between "turned off here" and "gone from
   * the config".
   */
  disabled?: boolean;
  /** Replaces a shipped spec wholesale, never field by field. */
  spec_dir?: string;
  models_dir?: string;
  models_max?: number;
  idle_stop_seconds?: number;
  ready_timeout_s?: number;
  agent_version?: string;
  /** An engine has no address of its own; every dialect it speaks comes from `kind` or a real shipped spec. */
  kind?: EngineKind;
  /** The engine's own process flags. A model's args win over the same key. */
  args: Record<string, unknown>;
}

export interface Config {
  listen_port: number;
  chat_timeout_seconds: number;
  agent_timeout_seconds: number;
  /** `[[model]]` capability rows -- optional, and unrelated to which engines or upstreams can reach any of them. */
  models: ModelEntry[];
  engines: EngineEntry[];
  upstreams: Upstream[];
  /** The route table. Replaces every former `models.filter(m => m.engine === X)` consumer -- named separately from `models` so the two tables never read as one. */
  routes: ResolvedRoute[];
  /** Every hop is a fully-qualified `@/<engine>/<model>`. */
  chains: Record<string, string[]>;
}

export interface Volume {
  name: string;
  path: string;
  /**
   * Mount `:ro`. The model store and the rendered presets INI are both inputs
   * the container reads once and must not be able to rewrite — llama-server
   * reading its own occupancy configuration from a file it could edit is the
   * case this exists to prevent.
   */
  read_only?: boolean;
}

/** Declared so `installed` can be honest about what a pulled image still lacks. */
export interface Artifact {
  path: string;
  /** The literal command that supplies it, surfaced verbatim in status. */
  obtain: string;
}

/** A TCP connect is not readiness, so each spec names its own probe. */
export interface ReadyProbe {
  path: string;
  /** The exact status meaning ready, when `accept` is absent. */
  status: number;
  /** Defaults to GET. Some engines answer their dialect path only to POST. */
  method?: "GET" | "POST";
  /**
   * When set, any status in this inclusive range means ready — except 404,
   * which never does. An engine whose only route is an inference path answers
   * an empty probe payload with a 4xx, and that still proves the route exists,
   * whereas a 404 proves it does not.
   */
  accept?: { min: number; max: number };
}

/**
 * The qualified address form an operator or caller writes: `@/model` (one
 * segment), `@/engine/model` (two -- or `@/engine/upstream` for a modelless
 * engine), or `@/engine/upstream/model` (three, fully explicit). One regex
 * with two nested optional groups, so a three-segment match is only ever
 * reached through a present second segment -- never a shape a second regex
 * has to re-derive. Segment count alone decides the reading; that is
 * `qualifiedSegments`'s job, not this pattern's.
 */
export const QUALIFIED_MODEL_RE = /^@\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/;

/** `QUALIFIED_MODEL_RE`'s match, as the one, two or three non-empty segments it captured. `undefined` when `model` is not a qualified `@/...` address at all. */
export function qualifiedSegments(model: string): string[] | undefined {
  const match = QUALIFIED_MODEL_RE.exec(model);
  if (!match) {
    return undefined;
  }
  return [match[1], match[2], match[3]].filter((seg): seg is string => seg !== undefined);
}

/**
 * A route on one engine, by model id -- and, when `upstream` is given, on
 * that one upstream specifically. A modelless route (`model` absent) never
 * matches: `model` here is always a real string, and `undefined === model`
 * is never true.
 */
export function findModelOnEngine<
  T extends { engine: string; model?: string; upstream: string | null },
>(routes: readonly T[], engineId: string, model: string, upstream?: string): T | undefined {
  return routes.find(
    (r) =>
      r.engine === engineId &&
      r.model === model &&
      (upstream === undefined || r.upstream === upstream),
  );
}

/**
 * The one route a resolved `@/engine/[upstream/]model` hop names. Two
 * segments default the upstream the way the dispatcher does -- ambient, then
 * this box's own `local` -- never whichever matching route was declared
 * first, which is how an ambient dispatch used to run on a keyed upstream.
 */
export function routeForHop<T extends { engine: string; model?: string; upstream: string | null }>(
  routes: readonly T[],
  engineId: string,
  model: string,
  upstream?: string,
): T | undefined {
  if (upstream !== undefined) {
    return findModelOnEngine(routes, engineId, model, upstream);
  }
  const matches = routes.filter((r) => r.engine === engineId && r.model === model);
  if (matches.length === 1) {
    return matches[0];
  }
  return matches.find((r) => r.upstream === null) ?? matches.find((r) => r.upstream === "local");
}

/** Whether a probe response means the engine is ready to serve. */
export function probeSaysReady(probe: ReadyProbe, status: number): boolean {
  if (status === STATUS_NOT_FOUND) {
    return false;
  }
  if (probe.accept === undefined) {
    return status === probe.status;
  }
  return status >= probe.accept.min && status <= probe.accept.max;
}

interface SpecCommon {
  serves: string[];
  /** Allowlist. A `--user` unit hands every child the manager's environment. */
  env: string[];
  command: string[];
  /**
   * How this engine gets an upstream when a route names none. Required on
   * every spec: a spec-full engine has no other source of truth for its
   * trait, unlike a spec-less one, which takes it from the built-in
   * `KIND_UPSTREAM_TRAIT` table keyed by `kind` instead.
   */
  upstream: UpstreamTrait;
}

export interface ContainerSpec extends SpecCommon {
  kind: Exclude<EngineKind, "agentic-cli">;
  /**
   * Absent on the built-in spec a spec-less engine takes (one declaring
   * `kind` in config, e.g. a pure `openai-http` proxy) -- it launches
   * nothing, so it has no image to declare. `isContainerSpec` is what a
   * caller checks before ever reading this.
   */
  image?: string;
  obtain: "pull" | "build";
  devices: string[];
  group_add: string[];
  security_opt: string[];
  /**
   * Run the container under docker's own init, so it is PID 1 rather than the
   * engine's own process. Linux gives PID 1 no default signal disposition, so
   * a process that installs no SIGTERM handler simply ignores `docker stop`
   * and is SIGKILLed once the grace period expires. Measured on this box:
   * 10.19s and exit 137 without it, 0.128s and a clean exit 143 with it.
   *
   * Only for an engine whose process does not handle SIGTERM itself. Every
   * other engine here stops cleanly on its own, and wrapping those buys
   * nothing.
   */
  init: boolean;
  /**
   * This engine's `/v1/tts` emits per-chunk NDJSON frames, so the door can
   * forward audio as it is synthesized. A `tts` key only: it is what makes
   * `"stream": true` on `POST /openai/v1/audio/speech` servable, and no other route
   * has a chunk contract to honour. Off unless the engine's app says
   * otherwise — an engine that cannot chunk and claims it can hands the
   * caller a 502 on every streamed request.
   */
  streaming: boolean;
  entrypoint?: string[];
  volumes: Volume[];
  artifacts: Artifact[];
  ready: ReadyProbe;
}

/**
 * The second dialect, and a short one. Nothing is mounted, so `{spec_dir}` does
 * not apply and there is no bind-mount for a `spec_dir` override to swap.
 */
export interface AgenticSpec extends SpecCommon {
  kind: "agentic-cli";
  /** Which agent CLI this launches; `agents.ts` holds everything that differs between them. */
  agent: string;
}

export type Spec = ContainerSpec | AgenticSpec;

/** A `ContainerSpec` that can actually be run: `image` is the one field a spec-less engine's built-in spec omits, and `isContainerSpec` is the only way to reach this type. */
export type RunnableContainerSpec = ContainerSpec & { image: string };

/**
 * A declared `image`, not `kind !== "agentic-cli"`: a spec-less engine's
 * built-in spec is container-SHAPED (its `kind` is e.g. `"openai-http"`) but
 * launches nothing, so it must not read as a container here -- otherwise
 * starting it would `docker run` a proxy with no image. Every caller that
 * narrows through this gets `RunnableContainerSpec` for free, so `docker.ts`
 * never has to re-assert what this already proved.
 */
export function isContainerSpec(s: Spec): s is RunnableContainerSpec {
  return s.kind !== "agentic-cli" && s.image !== undefined;
}

/** A spec paired with where it was read from, because status reports which won. */
export interface LoadedSpec {
  spec: Spec;
  /** The directory it was built from — shipped, or a `spec_dir` override. */
  source: string;
}

/**
 * What one role is doing right now: the requests holding its lease, and the
 * ones queued behind them. Reported only for a role that has either, so an
 * idle engine carries none of this rather than a row of zeroes.
 */
export interface RoleContention {
  role: Role;
  active: number;
  waiting: number;
}

/**
 * No `private_url`, on purpose: every control this project has -- call
 * recording, egress ceilings, and later the budgets that decide whose money
 * pays -- lives at the door, and a consumer holding a raw container address
 * routes around all of it. The value stays an internal runtime one --
 * `docker.ts`'s own `RuntimeStatus`, read straight off `DockerLifecycle` by
 * whichever door verb still needs it -- it simply never reaches the wire.
 */
export interface EngineStatus {
  id: string;
  kind: EngineKind;
  serves: string[];
  state: EngineState;
  /**
   * This engine's own `[[engine]]` table carries `disable = true`. Always
   * reported with `state: "unavailable"` — nothing was probed to establish
   * that, so the two are not independent readings — and `fix` names the
   * config edit that undoes it. Absent on every engine that is actually
   * served.
   */
  disabled?: boolean;
  /** The literal `docker pull` / `docker build` / `secret-tool store` that fixes it. */
  fix?: string;
  /**
   * Per-role contention, for the llama engines that have roles at all. Absent
   * when nothing is queued or running, and absent entirely on a kind that has
   * no leases -- the distinction a caller needs is "waiting behind someone"
   * versus "loading", which `state` alone cannot answer.
   */
  roles?: RoleContention[];
  /**
   * Whether `"stream": true` is servable by this engine, on whichever route
   * it serves that admits streaming at all. Every kind can now declare it
   * (`spec.ts`'s `streaming` key is no longer tts-only), so a real boolean is
   * the honest answer everywhere: `false` means "this engine does not
   * stream", not "unknown". Without it a consumer's only way to learn that an
   * engine cannot chunk is a 502 per request, or a hardcoded engine list that
   * goes stale the moment engined gains an engine.
   */
  streaming: boolean;
  last_error?: string;
  /**
   * Requests holding this engine open right now. The audio engines serialize
   * every request on one process-wide lock inside the container, so a second
   * caller waits with nothing else reporting that it is waiting; this is how
   * concurrent demand on them is visible at all.
   */
  active_leases?: number;
  /**
   * What this engine's own model-bearing routes can be asked for, one entry
   * per non-disabled route -- the config surface `[[route]]`/`[[model]]`
   * capability fields exist to answer, so a caller learns it from this
   * listing rather than needing a second source. Absent when the engine has
   * no model-bearing routes at all (comfy, every modelless media engine).
   */
  capabilities?: EngineCapability[];
}

export interface EnginesResponse {
  /** Bumped when a consumer-visible shape changes. */
  contract: number;
  /** The source revision, written into the bundle by the install script. */
  commit: string;
  engines: EngineStatus[];
  /**
   * The parse error from the most recent failed reload, if one is outstanding.
   * A reload that cannot parse keeps the previous config serving, so this is
   * the only place an operator learns the edit did not take.
   */
  config_error?: string;
}

/**
 * One `GET /openai/v1/models` row: an address with its own capabilities,
 * never a bare id. `id` is the addressable `@/...` string a caller can put
 * straight into `model` -- the two-segment form when it is unambiguous on
 * its own, the three-segment form when a sibling route shares its
 * `(engine, model)` pair on a different upstream. A chain row omits
 * `engine`/`upstream`/`model`/`egress`: no single one answers for every hop,
 * so `streaming`, `state` and `capabilities` are its first hop's instead --
 * that is the hop that actually answers.
 */
export interface ModelRow {
  id: string;
  engine?: string;
  upstream?: string;
  model?: string;
  egress?: Egress;
  streaming: boolean;
  serves: string[];
  state: EngineState;
  capabilities: ModelCapabilities;
}

export interface ModelsResponse {
  object: "list";
  data: ModelRow[];
}

/**
 * One `POST /engined/v1/start` row: the route this call acted on and what
 * became of it. No `url` — an engine sits behind the door, and where its
 * container happens to listen is the door's own business, never the
 * caller's. Byte-identical to a peer-forwarded answer, so nothing about this
 * shape changes when a later delivery has a peer answer instead of this box.
 */
export interface StartRow {
  address: string;
  engine: string;
  upstream: string | null;
  state: EngineState;
  fix?: string;
}

export interface StartResponse {
  object: "list";
  data: StartRow[];
}

/** Bumped when a field is removed, a state renamed, or a route's meaning altered. */
export const CONTRACT = 6;

/**
 * Anything a restart cannot fix. The unit carries
 * `RestartPreventExitStatus=78`, so throwing this is what stops the loop.
 */
export class FatalError extends Error {
  static readonly EXIT_CODE = 78;
}

/** A fatal parse failure that can name the file and site that caused it. */
export class ParseError extends FatalError {
  constructor(
    message: string,
    readonly file: string,
    options?: ErrorOptions,
  ) {
    super(`${file}: ${message}`, options);
  }
}

/**
 * Prepended by engined in code on every agentic launch and removable by no
 * config entry or `spec_dir` override. Asserting `--safe-mode` alone is not
 * enough: neither the tool allowlist nor the MCP closure is sufficient by
 * itself, so all three are the floor.
 */
export const AGENTIC_FLOOR = [
  "--safe-mode",
  "--tools",
  "Read,Grep,Glob",
  "--strict-mcp-config",
] as const;

/** Each dissolves the guarantee. Fatal at parse wherever they appear. */
export const FORBIDDEN_AGENTIC_FLAGS = [
  // opencode's own dangerous flag: "auto-approve permissions that are not
  // explicitly denied". It cannot reach the sandbox floor, but it hands an
  // agent shell and network without asking, so no agentic engine gets it.
  "--auto",
  "--add-dir",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
  // cursor's own two spellings of "run everything without asking" --
  // `--yolo` is documented as a bare alias for `--force`. Whether either
  // actually overrides `--mode plan` was never tested; the assertion costs
  // nothing either way, and cursor exposes more ways to say yes than claude
  // does.
  "--force",
  "--yolo",
  // cursor's own floor flag. `AGENTIC_FLOOR_FLAG_NAMES` below only knows
  // claude's flag names, so without this a config `[engine.args]` entry
  // could set `--mode ask` and, by last-wins argument parsing, silently
  // replace the `--mode plan` cursor's own launch already prepended.
  "--mode",
] as const;

/**
 * Derived from `AGENTIC_FLOOR` itself rather than hand-copied: a config
 * `[engine.args]` key that renders to `--tools` (or any other floor flag)
 * appends a SECOND copy after the floor's own, and last-wins argument
 * parsing means whatever the config supplied is what the child actually
 * gets — the floor was never really prepended, just overwritten. Deriving
 * from the floor array means any flag later added to it is automatically
 * unbeatable too, with nothing new to remember to blacklist.
 */
const AGENTIC_FLOOR_FLAG_NAMES = new Set<string>(
  AGENTIC_FLOOR.filter((token) => token.startsWith("--")),
);

/** `--permission-mode=X` or a separate `--permission-mode X` pair — same lookup either spelling takes on the CLI. */
function permissionModeValue(arg: string, next: string | undefined): string | undefined {
  return arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : next;
}

/** The two ways a bare flag name can dissolve the floor: it's outright forbidden, or it duplicates one the floor already set. */
function assertNotForbiddenOrFloorDuplicate(bare: string, file: string): void {
  if ((FORBIDDEN_AGENTIC_FLAGS as readonly string[]).includes(bare)) {
    throw new ParseError(`${bare} dissolves the read-only floor`, file);
  }
  if (AGENTIC_FLOOR_FLAG_NAMES.has(bare)) {
    throw new ParseError(
      `${bare} duplicates a flag the agentic read-only floor already sets; it cannot be overridden, only the floor's own value would apply`,
      file,
    );
  }
}

/**
 * `--permission-mode` and `--sandbox` are forbidden only with the one value
 * that dissolves the floor (`bypassPermissions`, `disabled`); the rest are
 * forbidden outright, as is any flag that duplicates one the floor itself
 * sets. Throws `ParseError` naming the flag and the file.
 */
export function assertNoForbiddenFlags(argv: readonly string[], file: string): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    const bare = arg.split("=", 1)[0] ?? arg;
    if (bare === "--permission-mode") {
      if (permissionModeValue(arg, argv[i + 1]) === "bypassPermissions") {
        throw new ParseError(
          "--permission-mode bypassPermissions dissolves the read-only floor",
          file,
        );
      }
      continue;
    }
    // cursor's own escape hatch: `enabled` is the default posture and
    // harmless, so only `disabled` is refused. Whether it actually
    // overrides `--mode plan` was never tested -- the assertion costs
    // nothing either way, the same reasoning `--force`/`--yolo` above rest on.
    if (bare === "--sandbox") {
      if (permissionModeValue(arg, argv[i + 1]) === "disabled") {
        throw new ParseError("--sandbox disabled dissolves the read-only floor", file);
      }
      continue;
    }
    assertNotForbiddenOrFloorDuplicate(bare, file);
  }
}

/** A TOML table, as distinct from an array or a scalar. Arrays are objects too, which is the trap. */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The one way an args table becomes argv: `--key` for every entry, a bare flag
 * when the value is `true`, the stringified value otherwise, and nothing at all
 * when the value is `false`, `null` or `undefined` — a flag turned off is a flag
 * not passed, never `--key false`.
 */
export function argvFromArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    if (value === false || value === null || value === undefined) {
      continue;
    }
    argv.push(`--${key}`);
    if (value !== true) {
      argv.push(String(value));
    }
  }
  return argv;
}

/**
 * Every key an args table declares, rendered as a flag regardless of its value.
 * The read-only floor is checked by KEY, so a flag written `= false` must still
 * be seen here — it is the value the floor refuses to let a config decide.
 */
export function argKeysAsFlags(args: Record<string, unknown>): string[] {
  return Object.keys(args).map((key) => `--${key}`);
}

/** Whatever a `catch` produced, as a string — an `Error`'s message, anything else stringified. */
export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const MS_PER_SECOND = 1000;
