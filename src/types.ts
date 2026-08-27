/**
 * The shapes every module shares. Kept free of behaviour so that config parse,
 * spec loading, lifecycle and the door can be written against one another
 * without importing each other's implementations.
 */

/** Occupancy is one resident GGUF per role, so the set is closed. */
export type Role = "chat" | "vision" | "embedding";

/** The only input `local_only` reads. Required on every engine of every kind. */
export type Egress = "none" | "remote";

export type EngineKind = "openai-http" | "agentic-cli" | "tts" | "stt" | "comfy";

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
  status: number;
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
  overridden: boolean;
}

export interface EngineStatus {
  id: string;
  kind: EngineKind;
  egress: Egress;
  serves: string[];
  state: EngineState;
  /** The literal `docker pull` / `docker build` / `secret-tool store` that fixes it. */
  fix?: string;
  /** Docker reassigns the host port every start, so this is a per-job read. */
  private_url: string | null;
  spec_source: string;
  last_error?: string;
  /** Best-effort from docker when cheap; absent rather than zero. */
  disk?: number;
  vram?: number;
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
 * `--permission-mode` is forbidden only with `bypassPermissions`; the rest are
 * forbidden outright. Throws `ParseError` naming the flag and the file.
 */
export function assertNoForbiddenFlags(argv: readonly string[], file: string): void {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    const bare = arg.split("=", 1)[0] ?? arg;
    if (bare === "--permission-mode") {
      const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : argv[i + 1];
      if (value === "bypassPermissions") {
        throw new ParseError(
          "--permission-mode bypassPermissions dissolves the read-only floor",
          file,
        );
      }
      continue;
    }
    if ((FORBIDDEN_AGENTIC_FLAGS as readonly string[]).includes(bare)) {
      throw new ParseError(`${bare} dissolves the read-only floor`, file);
    }
  }
}
