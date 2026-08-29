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

/** The only input `local_only` reads. Required on every engine of every kind. */
export type Egress = "none" | "remote";

export type EngineKind = "openai-http" | "agentic-cli" | "tts" | "stt" | "comfy";

/**
 * One table, whose value says what each kind is. Typed as a complete record
 * over `EngineKind`, so adding or removing a kind fails to compile here until
 * this file gives the new one an explicit answer -- which is the whole point:
 * an inline `kind === "a" || kind === "b"` elsewhere silently omits it.
 */
const KIND_TRAITS: Record<EngineKind, { container: boolean; modelLess: boolean }> = {
  "openai-http": { container: true, modelLess: false },
  // The only kind that runs no container at all.
  "agentic-cli": { container: false, modelLess: true },
  // tts/stt have no model id of their own; agentic-cli picks its own.
  tts: { container: true, modelLess: true },
  stt: { container: true, modelLess: true },
  comfy: { container: true, modelLess: false },
};

const KIND_ENTRIES = Object.entries(KIND_TRAITS) as [
  EngineKind,
  { container: boolean; modelLess: boolean },
][];

/** The complete kind list `parseKind` accepts; config.ts's source of truth. */
export const ENGINE_KINDS: readonly EngineKind[] = KIND_ENTRIES.map(([kind]) => kind);

/** Kinds whose spec is the container dialect. */
export const CONTAINER_KINDS: ReadonlySet<EngineKind> = new Set(
  KIND_ENTRIES.filter(([, t]) => t.container).map(([kind]) => kind),
);

/** Kinds whose door takes no separate model id. */
export const MODEL_LESS_KINDS: ReadonlySet<EngineKind> = new Set(
  KIND_ENTRIES.filter(([, t]) => t.modelLess).map(([kind]) => kind),
);

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
}

export interface ModelEntry {
  id: string;
  engine: string;
  /** Absent by construction on an agentic model: nothing is resident. */
  filename?: string;
  role?: Role;
  aliases: string[];
  /** Rendered into this model's section of the presets INI, verbatim. */
  args: Record<string, unknown>;
}

export interface EngineEntry {
  id: string;
  egress: Egress;
  /**
   * Configured but not served: named in the top-level `disabled` list. Kept
   * on the entry rather than filtered out of `Config` so `GET /v1/engines`
   * can report it as off — which is the difference an operator needs between
   * "turned off here" and "gone from the config".
   */
  disabled?: boolean;
  /** Replaces a shipped spec wholesale, never field by field. */
  spec_dir?: string;
  models_dir?: string;
  models_max?: number;
  idle_stop_seconds?: number;
  ready_timeout_s?: number;
  claude_version?: string;
  /** An engine that is only a remote address launches nothing. */
  kind?: EngineKind;
  base_url?: string;
  secret?: SecretRef;
  /** The engine's own process flags. A model's args win over the same key. */
  args: Record<string, unknown>;
}

export interface Config {
  listen_port: number;
  chat_timeout_seconds: number;
  agent_timeout_seconds: number;
  models: ModelEntry[];
  engines: EngineEntry[];
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
 * The qualified `@/<engine>/<model>` form, as written by an operator in a
 * chain or by a caller in `model`. Exactly two segments: `chain.ts`'s
 * `parseHop` is deliberately looser because it also destructures the bare
 * `@/<engine>` hop this rejects.
 */
export const QUALIFIED_MODEL_RE = /^@\/([^/]+)\/([^/]+)$/;

/**
 * A model on one engine, by id or by alias. The alias half is why this is
 * shared: a caller that compares only `id` silently stops resolving aliases.
 */
export function findModelOnEngine<T extends { engine: string; id: string; aliases: string[] }>(
  models: readonly T[],
  engineId: string,
  idOrAlias: string,
): T | undefined {
  return models.find(
    (m) => m.engine === engineId && (m.id === idOrAlias || m.aliases.includes(idOrAlias)),
  );
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
}

export interface ContainerSpec extends SpecCommon {
  kind: Exclude<EngineKind, "agentic-cli">;
  image: string;
  obtain: "pull" | "build";
  devices: string[];
  group_add: string[];
  security_opt: string[];
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
}

export type Spec = ContainerSpec | AgenticSpec;

export function isContainerSpec(s: Spec): s is ContainerSpec {
  return s.kind !== "agentic-cli";
}

/** A spec paired with where it was read from, because status reports which won. */
export interface LoadedSpec {
  spec: Spec;
  /** The directory it was built from — shipped, or a `spec_dir` override. */
  source: string;
}

export interface EngineStatus {
  id: string;
  kind: EngineKind;
  egress: Egress;
  serves: string[];
  state: EngineState;
  /**
   * Named in the config's `disabled` list. Always reported with
   * `state: "unavailable"` — nothing was probed to establish that, so the two
   * are not independent readings — and `fix` names the config edit that
   * undoes it. Absent on every engine that is actually served.
   */
  disabled?: boolean;
  /** The literal `docker pull` / `docker build` / `secret-tool store` that fixes it. */
  fix?: string;
  /** Docker reassigns the host port every start, so this is a per-job read. */
  private_url: string | null;
  spec_source: string;
  last_error?: string;
  /**
   * Requests holding this engine open right now. The audio engines serialize
   * every request on one process-wide lock inside the container, so a second
   * caller waits with nothing else reporting that it is waiting; this is how
   * concurrent demand on them is visible at all.
   */
  active_leases?: number;
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

/** Bumped when a field is removed, a state renamed, or a route's meaning altered. */
export const CONTRACT = 1;

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
  "--add-dir",
  "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions",
  "--permission-mode",
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
 * `--permission-mode` is forbidden only with `bypassPermissions`; the rest are
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
