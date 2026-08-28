/**
 * The one consumer and operator surface: composes config, spec loading and
 * the container lifecycle into `GET /v1/engines`, `GET /v1/models` and
 * `POST /v1/engines/:id/start`. Nothing here talks to docker or parses TOML
 * directly — that is `docker.ts` and `spec.ts`'s job.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { buildComfySpec } from "./comfy.ts";
import { DockerLifecycle, dockerExec, type Exec, type Probe } from "./docker.ts";
import { argvFromArgs, buildLlamaSpec, renderPresetIni } from "./llama.ts";
import { stateDir } from "./paths.ts";
import { resolveSecret, type SecretOutcome } from "./secrets.ts";
import { loadSpec, type SpecLoadOptions } from "./spec.ts";
import {
  type AgenticSpec,
  CONTRACT,
  type Config,
  type ContainerSpec,
  type EngineEntry,
  type EngineKind,
  type EngineStatus,
  type EnginesResponse,
  isContainerSpec,
  type LoadedSpec,
  type SecretRef,
} from "./types.ts";

/** Set at build time by the install script; absent in a working-tree run. */
declare const ENGINED_COMMIT: string | undefined;

/** No lifecycle default is stated in TODO.md; chosen here, not in config.ts. */
const DEFAULT_IDLE_STOP_SECONDS = 900;
const DEFAULT_READY_TIMEOUT_S = 60;

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

export type QueueFetch = (url: string) => Promise<QueueSnapshot>;

async function defaultQueueFetch(url: string): Promise<QueueSnapshot> {
  const res = await fetch(url);
  return (await res.json()) as QueueSnapshot;
}

function isQueueEmpty(q: QueueSnapshot): boolean {
  return q.queue_running.length === 0 && q.queue_pending.length === 0;
}

/**
 * A remote-address-only engine (`base_url` set) has no spec directory, so its
 * `serves` list cannot come from a spec file. Mirrors the door table in
 * TODO.md `## The OpenAI door` — comfy is never reached this way, so it is
 * absent from this map's callers rather than mapped to `[]` here.
 */
const KIND_SERVES: Record<EngineKind, string[]> = {
  "openai-http": ["/v1/chat/completions", "/v1/embeddings"],
  "agentic-cli": ["/v1/chat/completions"],
  tts: ["/v1/audio/speech"],
  stt: ["/v1/audio/transcriptions"],
  comfy: [],
};

/** No spec directory exists for a remote-address engine; named as such rather than left blank. */
const REMOTE_SPEC_SOURCE = "(none: remote address)";

/**
 * A remote-address `agentic-cli` engine (e.g. `claude-kimi`) launches the
 * identical binary under the identical floor as a local one — only its
 * upstream differs — so it is gated through the same `agenticStatus` proof.
 * Only `kind`/`serves` are read by that gate; `env`/`command` are never used
 * for a remote engine, which has no spec directory to load either from.
 */
const REMOTE_AGENTIC_SPEC: AgenticSpec = {
  kind: "agentic-cli",
  serves: KIND_SERVES["agentic-cli"],
  env: [],
  command: [],
};

/** Must match `LlamaRouterOptions.presetHostPath`'s own default: both write and mount the same file. */
const LOCAL_LLAMA_PRESET_DIR = (): string => `${stateDir()}/local-llama`;
const LOCAL_LLAMA_PRESET_PATH = (): string => `${LOCAL_LLAMA_PRESET_DIR()}/preset.ini`;

function isLocalLlama(engine: EngineEntry, kind: EngineKind): boolean {
  return kind === "openai-http" && engine.models_dir !== undefined;
}

/**
 * Resolved per request, never cached — a `--user` unit boots before the
 * login keyring unlocks (lingering is enabled here specifically so engined
 * starts before any graphical login), and a cached failure would need a
 * reload to clear once the operator signs in rather than just recovering
 * on the next `GET /v1/engines`.
 */
export function defaultSecretResolves(secret: SecretRef): Promise<SecretOutcome> {
  return resolveSecret(secret);
}

function noSecretConfiguredFix(engineId: string): string {
  return `engine "${engineId}" is a remote address with no configured secret`;
}

/**
 * The read-only floor is version-specific, so a proved version is only
 * proof for that version. One file per engine, mirroring the local-llama
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

export interface AgenticProbeOutcome {
  ok: boolean;
  /** Which probe failed -- e.g. "byte-identical" or "no-hook-fires". Present only when `ok` is false. */
  failedProbe?: string;
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
  engine: EngineEntry,
  claudeVersion: string,
) => Promise<AgenticProbeOutcome>;

function noClaudeVersionConfiguredFix(engineId: string): string {
  return `engine "${engineId}" is agentic-cli with no claude_version configured`;
}

function noProbeRunnerConfiguredFix(engineId: string, version: string): string {
  return `engine "${engineId}" pin ${version} has not been proved and no agentic probe runner is configured`;
}

function probeFailedFix(engineId: string, version: string, failedProbe: string): string {
  return `engine "${engineId}" pin ${version} failed the "${failedProbe}" probe`;
}

export interface RegistryOptions {
  /** Root of the shipped `engines/` directory, passed straight through to `loadSpec`. */
  enginesRoot: string;
  bunx: string;
  presetIni?: string;
  /** Injected together so the image probe below agrees with a test's fake lifecycle. */
  exec?: Exec;
  probe?: Probe;
  lifecycle?: DockerLifecycle;
  /** Defaults to real `secret-tool` access via secrets.ts; a test injects a fake outcome directly, without simulating a subprocess. */
  secretResolves?: (secret: SecretRef) => Promise<SecretOutcome>;
  /** Overridable for tests: a fast interval against a fake `/queue` response. */
  queueFetch?: QueueFetch;
  comfyPollIntervalMs?: number;
  /** Absent by default: an agentic-cli engine whose pin has never been proved stays `unavailable` until one is injected. */
  agenticProbeRunner?: AgenticProbeRunner;
}

interface Entry {
  engine: EngineEntry;
  /** `null` for a remote-address-only engine: it has no spec directory to load. */
  spec: LoadedSpec | null;
}

/**
 * Picks the per-engine builder from the loaded spec's own `kind` and the
 * engine's own configuration, never from a hardcoded id — an operator naming
 * the local llama engine something other than "local-llama" must still get
 * its models mount. `buildLlamaSpec`/`buildComfySpec` each call `loadSpec`
 * themselves; the first call here only exists to learn `kind` cheaply,
 * before ever running or proxying anything.
 */
/**
 * Every other container kind's own [engine.args] -- comfy and local-llama's
 * own builders already append theirs. `buildRunArgs` renders as
 * `image, ...entrypoint, ...command`, so an empty `command` means "run the
 * image's own baked-in CMD unmodified" (chatterbox/kokoro's real shape: it
 * is already correct, nothing to extend) and appending flags to it does not
 * extend that CMD, it REPLACES "use the image's own" with "run these flags
 * as the command" -- silently corrupting the launch, not merely leaving the
 * args unused. That is rejected here instead: an operator who sets
 * `[engine.args]` gets its effect or an error, the same contract
 * config.ts's own closed key sets hold one layer up.
 */
function applyEngineArgs(engine: EngineEntry, spec: ContainerSpec): ContainerSpec {
  const argv = argvFromArgs(engine.args);
  if (argv.length === 0) {
    return spec;
  }
  if (spec.command.length === 0) {
    throw new Error(
      `engine "${engine.id}": [engine.args] is set, but this engine's command is image-defined (empty) -- appending flags would replace the image's own CMD, not extend it`,
    );
  }
  return { ...spec, command: [...spec.command, ...argv] };
}

function loadEngineSpec(engine: EngineEntry, specOptions: SpecLoadOptions): LoadedSpec {
  // The peek's own resolved spec is discarded whenever a builder below takes
  // over (each calls loadSpec again with the substitution `{preset_ini}`
  // actually needs) — this placeholder only has to satisfy substitution, not
  // name a real path.
  const loaded = loadSpec(engine, {
    ...specOptions,
    presetIni: specOptions.presetIni ?? "/unused",
  });
  if (!isContainerSpec(loaded.spec)) {
    return loaded;
  }
  if (loaded.spec.kind === "comfy" && engine.models_dir !== undefined) {
    return { ...loaded, spec: buildComfySpec(engine, specOptions) };
  }
  if (isLocalLlama(engine, loaded.spec.kind)) {
    return { ...loaded, spec: buildLlamaSpec(engine, specOptions, LOCAL_LLAMA_PRESET_PATH()) };
  }
  return { ...loaded, spec: applyEngineArgs(engine, loaded.spec) };
}

function buildEntries(config: Config, specOptions: SpecLoadOptions): Entry[] {
  return config.engines.map((engine) => ({
    engine,
    spec: engine.base_url === undefined ? loadEngineSpec(engine, specOptions) : null,
  }));
}

export class EngineRegistry {
  private readonly exec: Exec;
  private readonly lifecycle: DockerLifecycle;
  private readonly secretResolves: (secret: SecretRef) => Promise<SecretOutcome>;
  private readonly specOptions: SpecLoadOptions;
  private readonly queueFetch: QueueFetch;
  private readonly comfyPollIntervalMs: number;
  private readonly agenticProbeRunner?: AgenticProbeRunner;
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

  constructor(config: Config, opts: RegistryOptions) {
    this.exec = opts.exec ?? dockerExec;
    this.lifecycle = opts.lifecycle ?? new DockerLifecycle(this.exec, opts.probe);
    this.secretResolves = opts.secretResolves ?? defaultSecretResolves;
    this.specOptions = {
      enginesRoot: opts.enginesRoot,
      bunx: opts.bunx,
      presetIni: opts.presetIni,
    };
    this.queueFetch = opts.queueFetch ?? defaultQueueFetch;
    this.comfyPollIntervalMs = opts.comfyPollIntervalMs ?? COMFY_POLL_INTERVAL_MS;
    this.agenticProbeRunner = opts.agenticProbeRunner;
    this.config = config;
    this.entries = buildEntries(config, this.specOptions);
    this.byId = new Map(this.entries.map((e) => [e.engine.id, e]));
    this.comfyTimers = this.startComfyWatches(this.entries);
  }

  /** One poll timer per `comfy`-kind engine; idleness for it comes from nowhere else. */
  private startComfyWatches(entries: Entry[]): ReturnType<typeof setInterval>[] {
    return entries
      .filter((e) => this.kindOf(e) === "comfy")
      .map((entry) =>
        setInterval(() => {
          this.pollComfyQueue(entry).catch(() => undefined);
        }, this.comfyPollIntervalMs),
      );
  }

  /**
   * A transition into empty arms the same idle-stop lease every other
   * engine's request traffic arms, once; a transition into non-empty cancels
   * a pending stop the same way a fresh `start()` on an already-running
   * container does — cheap, since `start()` returns immediately once `state`
   * is already `running`. Not stopped or started on every tick: docker.ts's
   * `endLease` resets its own countdown on every call, so re-arming it every
   * poll while the queue stays empty would defer the stop forever.
   */
  private async pollComfyQueue(entry: Entry): Promise<void> {
    if (entry.spec === null || !isContainerSpec(entry.spec.spec)) {
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
    const wasEmpty = this.comfyQueueEmpty.get(engine.id) ?? false;
    this.comfyQueueEmpty.set(engine.id, empty);
    if (empty && !wasEmpty) {
      this.lifecycle.endLease(engine.id, engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
    } else if (!empty && wasEmpty) {
      await this.lifecycle.start(engine.id, entry.spec.spec, {
        idleStopSeconds: engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
        readyTimeoutS: engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
        specSource: entry.spec.source,
      });
    }
  }

  private kindOf(entry: Entry): EngineKind {
    if (entry.spec === null) {
      return entry.engine.kind ?? "agentic-cli";
    }
    return entry.spec.spec.kind;
  }

  /**
   * Everything `getStatus`/spec loading already know, with no docker round
   * trip and — for a remote-address engine — no keyring round trip either:
   * optimistic `installed`, the same resting assumption a container gets
   * before its first probe. `statusFor` is the authoritative, async check.
   */
  private syncStatus(entry: Entry): EngineStatus {
    const { engine } = entry;

    if (entry.spec === null) {
      const kind = this.kindOf(entry);
      return {
        id: engine.id,
        kind,
        egress: engine.egress,
        serves: KIND_SERVES[kind],
        state: "installed",
        private_url: null,
        spec_source: REMOTE_SPEC_SOURCE,
      };
    }

    const { spec, source } = entry.spec;
    if (!isContainerSpec(spec)) {
      return {
        id: engine.id,
        kind: spec.kind,
        egress: engine.egress,
        serves: spec.serves,
        state: "installed",
        private_url: null,
        spec_source: source,
      };
    }

    const runtime = this.lifecycle.getStatus(engine.id);
    return {
      id: engine.id,
      kind: spec.kind,
      egress: engine.egress,
      serves: spec.serves,
      state: runtime.state,
      fix: runtime.fix,
      private_url: runtime.private_url,
      spec_source: source,
      last_error: runtime.last_error,
    };
  }

  /**
   * The keyring round trip a remote-address engine's status needs: resolved
   * fresh on every call (never cached — see `defaultSecretResolves`), so an
   * operator who signs in and unlocks their keyring sees it recover on the
   * next `GET /v1/engines`, no reload required. Distinguishes `missing` from
   * `locked` rather than collapsing both into one `fix`, because a `locked`
   * engine already has a correctly-stored secret — telling the operator to
   * `secret-tool store` it again is the wrong diagnosis.
   *
   * A `kind: "agentic-cli"` remote address launches the same binary as a
   * local one and so is gated the same way: the secret is checked first
   * (the existing behaviour every other remote engine gets), and only once
   * it resolves does the version-proof gate in `agenticStatus` run. An
   * engine that is merely a remote address and launches nothing carries no
   * `claude_version` and is never routed there.
   */
  private async remoteStatus(entry: Entry): Promise<EngineStatus> {
    const { engine } = entry;
    const kind = this.kindOf(entry);
    const base = {
      id: engine.id,
      kind,
      egress: engine.egress,
      serves: KIND_SERVES[kind],
      private_url: null,
      spec_source: REMOTE_SPEC_SOURCE,
    } as const;
    const { secret } = engine;
    if (secret === undefined) {
      return { ...base, state: "unavailable", fix: noSecretConfiguredFix(engine.id) };
    }
    const outcome = await this.secretResolves(secret);
    if (!outcome.ok) {
      return { ...base, state: "unavailable", fix: outcome.fix };
    }
    if (kind === "agentic-cli") {
      return this.agenticStatus(engine, REMOTE_AGENTIC_SPEC, REMOTE_SPEC_SOURCE);
    }
    return { ...base, state: "installed" };
  }

  /**
   * `syncStatus` for a container engine's non-running case is superseded by
   * `lifecycle.probe`, which checks image *and* artifact presence read-only
   * (never starts a container) so a never-started engine with either missing
   * reports `unavailable` on the very first `GET /v1/engines` rather than
   * waiting for a start attempt to notice.
   */
  private async statusFor(entry: Entry): Promise<EngineStatus> {
    if (entry.spec === null) {
      return this.remoteStatus(entry);
    }
    if (!isContainerSpec(entry.spec.spec)) {
      return this.agenticStatus(entry.engine, entry.spec.spec, entry.spec.source);
    }
    const { engine } = entry;
    const { spec, source } = entry.spec;
    const runtime = await this.lifecycle.probe(engine.id, spec, source);
    return {
      id: engine.id,
      kind: spec.kind,
      egress: engine.egress,
      serves: spec.serves,
      state: runtime.state,
      fix: runtime.fix,
      private_url: runtime.private_url,
      spec_source: source,
      last_error: runtime.last_error,
    };
  }

  /**
   * The version-proof gate: an engine whose configured pin has never been
   * proved reports `unavailable` rather than serving on faith. Verification
   * only runs when the configured pin differs from the one last proved —
   * bumping the pin is what re-arms it, per the design's own reasoning for
   * why the pin exists at all. A pin that FAILS is cached the same way: the
   * failed outcome for that exact pin is remembered so every later poll
   * reports it for free until the pin changes, and two polls racing on the
   * same unproved pin share one in-flight probe instead of each billing
   * their own — see `runAgenticProbe`.
   */
  private async agenticStatus(
    engine: EngineEntry,
    spec: AgenticSpec,
    source: string,
  ): Promise<EngineStatus> {
    const base = {
      id: engine.id,
      kind: spec.kind,
      egress: engine.egress,
      serves: spec.serves,
      private_url: null,
      spec_source: source,
    } as const;
    if (engine.claude_version === undefined) {
      return { ...base, state: "unavailable", fix: noClaudeVersionConfiguredFix(engine.id) };
    }
    if (readVerifiedVersion(engine.id) === engine.claude_version) {
      return { ...base, state: "installed" };
    }
    if (this.agenticProbeRunner === undefined) {
      return {
        ...base,
        state: "unavailable",
        fix: noProbeRunnerConfiguredFix(engine.id, engine.claude_version),
      };
    }
    const outcome = await this.runAgenticProbe(engine, engine.claude_version);
    if (!outcome.ok) {
      return {
        ...base,
        state: "unavailable",
        fix: probeFailedFix(engine.id, engine.claude_version, outcome.failedProbe ?? "unknown"),
      };
    }
    writeVerifiedVersion(engine.id, engine.claude_version);
    this.agenticProbeState.delete(engine.id);
    return { ...base, state: "installed" };
  }

  /**
   * One real probe per (engine, pin) in flight at a time. A pin already
   * being probed hands every caller the same promise; a pin that already
   * failed hands every caller the cached outcome with no runner call at
   * all. Keyed by version, so a pin bump — the only sanctioned way to
   * re-arm this gate — misses the cache on its own, with no separate
   * invalidation needed.
   */
  private runAgenticProbe(engine: EngineEntry, version: string): Promise<AgenticProbeOutcome> {
    const cached = this.agenticProbeState.get(engine.id);
    if (cached?.version === version) {
      if (cached.promise) {
        return cached.promise;
      }
      if (cached.outcome) {
        return Promise.resolve(cached.outcome);
      }
    }
    const runner = this.agenticProbeRunner;
    if (!runner) {
      return Promise.resolve({ ok: false, failedProbe: "no-runner-configured" });
    }
    const promise = runner(engine, version).then((outcome) => {
      this.agenticProbeState.set(engine.id, {
        version,
        outcome: outcome.ok ? undefined : outcome,
      });
      return outcome;
    });
    this.agenticProbeState.set(engine.id, { version, promise });
    return promise;
  }

  async list(): Promise<EnginesResponse> {
    const engines = await Promise.all(this.entries.map((e) => this.statusFor(e)));
    return {
      contract: CONTRACT,
      commit: typeof ENGINED_COMMIT === "string" ? ENGINED_COMMIT : "unknown",
      engines,
    };
  }

  /**
   * Every selectable `model` string: GGUF ids and their aliases, engine ids
   * of engines that answer without being told which model (`agentic-cli`,
   * `tts`, `stt` — each serves a fixed job with no GGUF to name), and chain
   * names (already `chain-*` in `config.chains`'s keys). `openai-http`
   * engines are excluded here because a router needs the GGUF id, not the
   * engine id. `comfy` is excluded structurally, never by name: it has no
   * OpenAI shape and owns no `[[model]]` entry, so it never enters the set.
   */
  models(): string[] {
    const out = new Set<string>();
    for (const m of this.config.models) {
      out.add(m.id);
      for (const alias of m.aliases) {
        out.add(alias);
      }
    }
    for (const entry of this.entries) {
      const kind = this.kindOf(entry);
      if (kind === "agentic-cli" || kind === "tts" || kind === "stt") {
        out.add(entry.engine.id);
      }
    }
    for (const name of Object.keys(this.config.chains)) {
      out.add(name);
    }
    return [...out];
  }

  /** Endpoints a given *engine* id serves, for the door's model/endpoint mismatch check. */
  serves(id: string): string[] {
    const entry = this.byId.get(id);
    if (!entry) {
      return [];
    }
    if (entry.spec === null) {
      return KIND_SERVES[this.kindOf(entry)];
    }
    return entry.spec.spec.serves;
  }

  /** Sync accessor: reports the lifecycle's cached state — no image probe, no keyring lookup. */
  get(id: string): EngineStatus | undefined {
    const entry = this.byId.get(id);
    return entry ? this.syncStatus(entry) : undefined;
  }

  async start(id: string): Promise<EngineStatus> {
    const entry = this.byId.get(id);
    if (!entry) {
      throw new Error(`unknown engine "${id}"`);
    }
    if (entry.spec === null || !isContainerSpec(entry.spec.spec)) {
      // Nothing to warm up: a remote address or an agentic-cli local engine
      // has no standing container.
      return this.statusFor(entry);
    }
    // A fresh start's first queue observation must be a real transition, not
    // one suppressed by emptiness left over from the container's last run.
    this.comfyQueueEmpty.delete(id);
    if (isLocalLlama(entry.engine, entry.spec.spec.kind)) {
      this.renderLocalLlamaPreset(entry.engine);
    }
    await this.lifecycle.start(id, entry.spec.spec, {
      idleStopSeconds: entry.engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
      readyTimeoutS: entry.engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
      specSource: entry.spec.source,
    });
    return this.statusFor(entry);
  }

  /**
   * The bind-mounted INI llama-server reads once at startup, re-rendered on
   * every start so a config edit to `[[model]]`/`[engine.args]` reaches the
   * container the next time it actually starts, per the reload rule.
   */
  private renderLocalLlamaPreset(engine: EngineEntry): void {
    const models = this.config.models.filter((m) => m.engine === engine.id);
    mkdirSync(LOCAL_LLAMA_PRESET_DIR(), { recursive: true });
    writeFileSync(LOCAL_LLAMA_PRESET_PATH(), renderPresetIni(engine, models), "utf8");
  }

  /**
   * In-flight work keeps using the entries captured at call time; only new
   * lookups see the rebuilt map. An engine dropped from `config` is stopped
   * in the background rather than left orphaned; a running container whose
   * shape changed is left alone until its next start.
   */
  reload(config: Config): void {
    const newEntries = buildEntries(config, this.specOptions);
    const newIds = new Set(newEntries.map((e) => e.engine.id));
    for (const old of this.entries) {
      if (!newIds.has(old.engine.id)) {
        this.lifecycle.removeEngine(old.engine.id).catch(() => undefined);
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
