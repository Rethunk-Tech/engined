/**
 * The one consumer and operator surface: composes config, spec loading and
 * the container lifecycle into `GET /engined/v1/engines`, `GET /openai/v1/models` and
 * `POST /engined/v1/engines/:id/start`. Nothing here talks to docker or parses TOML
 * directly — that is `docker.ts` and `spec.ts`'s job.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildComfySpec } from "./comfy.ts";
import { DockerLifecycle, dockerExec, type Probe, type RuntimeStatus } from "./docker.ts";
import type { Exec } from "./exec.ts";
import { CONTENT_TYPE, JSON_CONTENT_TYPE } from "./http.ts";
import { buildLlamaSpec, renderPresetIni } from "./llama.ts";
import { localLlamaPresetPath, stateDir } from "./paths.ts";
import { isRemote, noSecretConfiguredFix } from "./remote.ts";
import type { EngineResources } from "./resources.ts";
import { resolveSecret, type SecretOutcome } from "./secrets.ts";
import { applyEngineArgs, loadSpec, type SpecLoadOptions } from "./spec.ts";
import {
  type AgenticSpec,
  CONTRACT,
  type Config,
  type EngineEntry,
  type EngineKind,
  type EngineStatus,
  type EnginesResponse,
  isContainerSpec,
  type LoadedSpec,
  MODEL_LESS_KINDS,
  type SecretRef,
  type Spec,
} from "./types.ts";

/** Set at build time by the install script; absent in a working-tree run. */
declare const ENGINED_COMMIT: string | undefined;

/** Lifecycle defaults live here rather than in config.ts: an engine that omits them is not a parse error, it just takes these. */
export const DEFAULT_IDLE_STOP_SECONDS = 900;
export const DEFAULT_READY_TIMEOUT_S = 60;

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
 * A remote-address-only engine (`base_url` set) has no spec directory, so its
 * `serves` list cannot come from a spec file. Mirrors the route table in
 * docs/http-api.md. Comfy is never reached this way, so it is absent from
 * this map's callers rather than mapped to `[]` here.
 */
const KIND_SERVES: Record<EngineKind, string[]> = {
  "openai-http": ["/openai/v1/chat/completions", "/openai/v1/embeddings"],
  "agentic-cli": ["/openai/v1/chat/completions"],
  tts: ["/openai/v1/audio/speech"],
  stt: ["/openai/v1/audio/transcriptions"],
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
  // A remote address has no spec directory to declare one, and every remote
  // agentic engine shipped so far is a claude upstream behind a different door.
  agent: "claude",
  serves: KIND_SERVES["agentic-cli"],
  env: [],
  command: [],
};

function isLocalLlama(engine: EngineEntry, kind: EngineKind): boolean {
  return kind === "openai-http" && engine.models_dir !== undefined;
}

/**
 * Resolved per request, never cached — a `--user` unit boots before the
 * login keyring unlocks (lingering is enabled here specifically so engined
 * starts before any graphical login), and a cached failure would need a
 * reload to clear once the operator signs in rather than just recovering
 * on the next `GET /engined/v1/engines`.
 */
function defaultSecretResolves(secret: SecretRef): Promise<SecretOutcome> {
  return resolveSecret(secret);
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

interface AgenticProbeOutcome {
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
  agentVersion: string,
  /** From the spec, never the engine entry: the floor is a property of the agent. */
  agent: string,
) => Promise<AgenticProbeOutcome>;

function noAgentVersionConfiguredFix(engineId: string): string {
  return `engine "${engineId}" is agentic-cli with no agent_version configured`;
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
  /** Injected together so the image probe below agrees with a test's fake lifecycle. */
  exec?: Exec;
  probe?: Probe;
  lifecycle?: DockerLifecycle;
  /** Defaults to real `secret-tool` access via secrets.ts; a test injects a fake outcome directly, without simulating a subprocess. */
  secretResolves?: (secret: SecretRef) => Promise<SecretOutcome>;
  /** Overridable for tests: a fast interval against a fake `/queue` response. */
  queueFetch?: QueueFetch;
  releaseFetch?: ReleaseFetch;
  comfyPollIntervalMs?: number;
  /** Absent by default: an agentic-cli engine whose pin has never been proved stays `unavailable` until one is injected. */
  agenticProbeRunner?: AgenticProbeRunner;
  /** Defaults under the one writable state dir; tests always override this. Must be the same path the door hands `LlamaRouter`, since one writes the file the other mounts. */
  presetHostPath?: string;
}

interface Entry {
  engine: EngineEntry;
  /** `null` for a remote-address-only engine: it has no spec directory to load. */
  spec: LoadedSpec | null;
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
 * the local llama engine something other than "local-llama" must still get
 * its models mount. `buildLlamaSpec`/`buildComfySpec` each call `loadSpec`
 * themselves; the first call here only exists to learn `kind` cheaply,
 * before ever running or proxying anything.
 */

function loadEngineSpec(
  engine: EngineEntry,
  specOptions: SpecLoadOptions,
  presetHostPath: string,
): LoadedSpec {
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

function buildEntries(
  config: Config,
  specOptions: SpecLoadOptions,
  presetHostPath: string,
): Entry[] {
  return config.engines.map((engine) => ({
    engine,
    spec: isRemote(engine) ? null : loadEngineSpec(engine, specOptions, presetHostPath),
  }));
}

/**
 * Whether a chunked `stream: true` on `/openai/v1/audio/speech` is servable here.
 * Only `tts` serves that route, so every other kind reports nothing at all
 * rather than a `false` that reads as "streaming is turned off". A remote
 * address has no spec to declare it and engined ships no remote TTS dialect,
 * so it is a truthful `false` there rather than an unknown.
 */
function streamingOf(kind: EngineKind, spec: Spec | null): boolean | undefined {
  if (kind !== "tts") {
    return undefined;
  }
  return spec !== null && isContainerSpec(spec) ? spec.streaming : false;
}

/** The reported shape of an engine, whichever way its runtime state was obtained. */
function statusFrom(
  engine: EngineEntry,
  spec: Spec,
  source: string,
  runtime: RuntimeStatus,
): EngineStatus {
  return {
    id: engine.id,
    kind: spec.kind,
    egress: engine.egress,
    serves: spec.serves,
    streaming: streamingOf(spec.kind, spec),
    state: runtime.state,
    fix: runtime.fix,
    private_url: runtime.private_url,
    spec_source: source,
    last_error: runtime.last_error,
    active_leases: runtime.active_leases,
  };
}

export class EngineRegistry {
  private readonly exec: Exec;
  private readonly lifecycle: DockerLifecycle;
  private readonly secretResolves: (secret: SecretRef) => Promise<SecretOutcome>;
  private readonly specOptions: SpecLoadOptions;
  private readonly queueFetch: QueueFetch;
  private readonly releaseFetch: ReleaseFetch;
  private readonly comfyPollIntervalMs: number;
  private readonly agenticProbeRunner?: AgenticProbeRunner;
  private readonly presetHostPath: string;
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
    };
    this.queueFetch = opts.queueFetch ?? defaultQueueFetch;
    this.releaseFetch = opts.releaseFetch ?? defaultReleaseFetch;
    this.comfyPollIntervalMs = opts.comfyPollIntervalMs ?? COMFY_POLL_INTERVAL_MS;
    this.agenticProbeRunner = opts.agenticProbeRunner;
    this.presetHostPath = opts.presetHostPath ?? localLlamaPresetPath();
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
      .filter((e) => !e.engine.disabled && this.kindOf(e) === "comfy")
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
    // Unknown starts as empty: a first observation of a BUSY queue is then a
    // real transition and takes a lease, rather than leaving a working Comfy
    // counting down against the idle-stop its own start armed.
    const wasEmpty = this.comfyQueueEmpty.get(engine.id) ?? true;
    this.comfyQueueEmpty.set(engine.id, empty);
    if (empty && !wasEmpty) {
      this.lifecycle.endLease(engine.id, engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
    } else if (!empty && wasEmpty) {
      await this.lifecycle.start(engine.id, entry.spec.spec, {
        idleStopSeconds: engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
        readyTimeoutS: engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
        specSource: entry.spec.source,
      });
      this.lifecycle.beginLease(engine.id);
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
    if (engine.disabled) {
      return this.disabledStatus(entry);
    }

    if (entry.spec === null) {
      const kind = this.kindOf(entry);
      return {
        id: engine.id,
        kind,
        egress: engine.egress,
        serves: KIND_SERVES[kind],
        streaming: streamingOf(kind, null),
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

    return statusFrom(engine, spec, source, this.lifecycle.getStatus(engine.id));
  }

  /**
   * Reported, not inspected: no docker probe, no keyring round trip, no
   * version proof. `unavailable` is the honest state -- nothing here is
   * servable -- and `disabled` is what separates it from an engine that is
   * unavailable for a reason the operator would have to go fix. `fix` names
   * the edit that undoes it, the same as every other unavailable engine.
   */
  private disabledStatus(entry: Entry): EngineStatus {
    const { engine, spec } = entry;
    return {
      id: engine.id,
      kind: this.kindOf(entry),
      egress: engine.egress,
      serves: this.serves(engine.id),
      streaming: streamingOf(this.kindOf(entry), spec?.spec ?? null),
      state: "unavailable",
      disabled: true,
      fix: `remove "${engine.id}" from "disabled" in config.toml`,
      private_url: null,
      spec_source: spec === null ? REMOTE_SPEC_SOURCE : spec.source,
    };
  }

  /**
   * The keyring round trip a remote-address engine's status needs: resolved
   * fresh on every call (never cached — see `defaultSecretResolves`), so an
   * operator who signs in and unlocks their keyring sees it recover on the
   * next `GET /engined/v1/engines`, no reload required. Distinguishes `missing` from
   * `locked` rather than collapsing both into one `fix`, because a `locked`
   * engine already has a correctly-stored secret — telling the operator to
   * `secret-tool store` it again is the wrong diagnosis.
   *
   * A `kind: "agentic-cli"` remote address launches the same binary as a
   * local one and so is gated the same way: the secret is checked first
   * (the existing behaviour every other remote engine gets), and only once
   * it resolves does the version-proof gate in `agenticStatus` run. An
   * engine that is merely a remote address and launches nothing carries no
   * `agent_version` and is never routed there.
   */
  private async remoteStatus(entry: Entry): Promise<EngineStatus> {
    const { engine } = entry;
    const kind = this.kindOf(entry);
    const base = {
      id: engine.id,
      kind,
      egress: engine.egress,
      serves: KIND_SERVES[kind],
      streaming: streamingOf(kind, null),
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
   * reports `unavailable` on the very first `GET /engined/v1/engines` rather than
   * waiting for a start attempt to notice.
   */
  private async statusFor(entry: Entry): Promise<EngineStatus> {
    if (entry.engine.disabled) {
      return this.disabledStatus(entry);
    }
    if (entry.spec === null) {
      return this.remoteStatus(entry);
    }
    if (!isContainerSpec(entry.spec.spec)) {
      return this.agenticStatus(entry.engine, entry.spec.spec, entry.spec.source);
    }
    const { engine } = entry;
    const { spec, source } = entry.spec;
    return statusFrom(engine, spec, source, await this.lifecycle.probe(engine.id, spec, source));
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
    if (engine.agent_version === undefined) {
      return { ...base, state: "unavailable", fix: noAgentVersionConfiguredFix(engine.id) };
    }
    if (readVerifiedVersion(engine.id) === engine.agent_version) {
      return { ...base, state: "installed" };
    }
    if (this.agenticProbeRunner === undefined) {
      return {
        ...base,
        state: "unavailable",
        fix: noProbeRunnerConfiguredFix(engine.id, engine.agent_version),
      };
    }
    const outcome = await this.runAgenticProbe(
      engine,
      engine.agent_version,
      spec.agent,
      this.agenticProbeRunner,
    );
    if (!outcome.ok) {
      return {
        ...base,
        state: "unavailable",
        fix: probeFailedFix(engine.id, engine.agent_version, outcome.failedProbe ?? "unknown"),
      };
    }
    writeVerifiedVersion(engine.id, engine.agent_version);
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
    const promise = runner(engine, version, agent).then((outcome) => {
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
      // A disabled engine is reported by /engined/v1/engines, never advertised here:
      // this list is what a caller may put in `model`, and dispatch refuses it.
      if (entry.engine.disabled) {
        continue;
      }
      const kind = this.kindOf(entry);
      if (MODEL_LESS_KINDS.has(kind)) {
        out.add(entry.engine.id);
      }
    }
    for (const name of Object.keys(this.config.chains)) {
      out.add(name);
    }
    return [...out];
  }

  /** Whether an id names the local llama, which is the only engine the extras routes can address. */
  isLocalLlama(id: string): boolean {
    const entry = this.byId.get(id);
    return entry !== undefined && isLocalLlama(entry.engine, this.kindOf(entry));
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

  /** The configured engine itself — secret, base_url, args, timeouts — as distinct from `get`'s runtime status. */
  entry(id: string): EngineEntry | undefined {
    return this.byId.get(id)?.engine;
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
    // Listed by `GET /engined/v1/engines` and startable are different things: an
    // operator can see it is off, and starting it is still the config edit.
    if (entry.engine.disabled) {
      throw new Error(`engine "${id}" is disabled in config`);
    }
    if (entry.spec === null || !isContainerSpec(entry.spec.spec)) {
      // Nothing to warm up: a remote address or an agentic-cli local engine
      // has no standing container.
      return this.statusFor(entry);
    }
    // A fresh start's first queue observation must be a real transition, not
    // one suppressed by stale queue-emptiness from an earlier session.
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
    mkdirSync(dirname(this.presetHostPath), { recursive: true });
    writeFileSync(this.presetHostPath, renderPresetIni(engine, models), "utf8");
  }

  /**
   * Why a per-container read cannot answer for this engine, or `undefined` if
   * it can. A remote address or an agentic-cli engine has no container, and
   * says so rather than returning an empty result that reads like a quiet one.
   */
  private containerRefusal(id: string): { error: string } | undefined {
    const entry = this.byId.get(id);
    if (!entry) {
      return { error: `unknown engine "${id}"` };
    }
    if (entry.spec === null || !isContainerSpec(entry.spec.spec)) {
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
    if (entry.spec !== null && isContainerSpec(entry.spec.spec)) {
      this.comfyQueueEmpty.delete(id);
      await this.lifecycle.stop(id);
    }
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
    const kind = this.kindOf(entry);
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
