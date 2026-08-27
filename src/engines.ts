/**
 * The one consumer and operator surface: composes config, spec loading and
 * the container lifecycle into `GET /v1/engines`, `GET /v1/models` and
 * `POST /v1/engines/:id/start`. Nothing here talks to docker or parses TOML
 * directly — that is `docker.ts` and `spec.ts`'s job.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { buildComfySpec } from "./comfy.ts";
import { DockerLifecycle, dockerExec, type Exec, type Probe } from "./docker.ts";
import { buildLlamaSpec, renderPresetIni } from "./llama.ts";
import { stateDir } from "./paths.ts";
import { loadSpec, type SpecLoadOptions } from "./spec.ts";
import {
  CONTRACT,
  type Config,
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

/** Must match `LlamaRouterOptions.presetHostPath`'s own default: both write and mount the same file. */
const LOCAL_LLAMA_PRESET_DIR = (): string => `${stateDir()}/local-llama`;
const LOCAL_LLAMA_PRESET_PATH = (): string => `${LOCAL_LLAMA_PRESET_DIR()}/preset.ini`;

function isLocalLlama(engine: EngineEntry, kind: EngineKind): boolean {
  return kind === "openai-http" && engine.models_dir !== undefined;
}

/** Real keyring access is a later phase. Named seam so it is one call to swap. */
export function defaultSecretResolves(_secret: SecretRef): boolean {
  return true;
}

function remoteFix(engineId: string, secret: SecretRef | undefined): string {
  if (secret === undefined) {
    return `engine "${engineId}" is a remote address with no configured secret`;
  }
  return `secret-tool store ${secret.service} ${secret.username}`;
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
  secretResolves?: (secret: SecretRef) => boolean;
  /** Overridable for tests: a fast interval against a fake `/queue` response. */
  queueFetch?: QueueFetch;
  comfyPollIntervalMs?: number;
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
  return loaded;
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
  private readonly secretResolves: (secret: SecretRef) => boolean;
  private readonly specOptions: SpecLoadOptions;
  private readonly queueFetch: QueueFetch;
  private readonly comfyPollIntervalMs: number;
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
    const queue = await this.queueFetch(`http://${status.private_url}/queue`);
    const empty = isQueueEmpty(queue);
    const wasEmpty = this.comfyQueueEmpty.get(engine.id) ?? false;
    this.comfyQueueEmpty.set(engine.id, empty);
    if (empty && !wasEmpty) {
      this.lifecycle.endLease(engine.id, engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
    } else if (!empty && wasEmpty) {
      await this.lifecycle.start(engine.id, entry.spec.spec, {
        idleStopSeconds: engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
        readyTimeoutS: engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
      });
    }
  }

  private kindOf(entry: Entry): EngineKind {
    if (entry.spec === null) {
      return entry.engine.kind ?? "agentic-cli";
    }
    return entry.spec.spec.kind;
  }

  /** Everything `getStatus`/spec loading already know, with no docker round trip. */
  private syncStatus(entry: Entry): EngineStatus {
    const { engine } = entry;

    if (entry.spec === null) {
      const kind = this.kindOf(entry);
      const { secret } = engine;
      const resolved = secret !== undefined && this.secretResolves(secret);
      return {
        id: engine.id,
        kind,
        egress: engine.egress,
        serves: KIND_SERVES[kind],
        state: resolved ? "installed" : "unavailable",
        fix: resolved ? undefined : remoteFix(engine.id, secret),
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
   * `syncStatus` for a container engine's non-running case is superseded by
   * `lifecycle.probe`, which checks image *and* artifact presence read-only
   * (never starts a container) so a never-started engine with either missing
   * reports `unavailable` on the very first `GET /v1/engines` rather than
   * waiting for a start attempt to notice.
   */
  private async statusFor(entry: Entry): Promise<EngineStatus> {
    if (entry.spec === null || !isContainerSpec(entry.spec.spec)) {
      return this.syncStatus(entry);
    }
    const { engine } = entry;
    const { spec, source } = entry.spec;
    const runtime = await this.lifecycle.probe(engine.id, spec);
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
   * of engines that answer without being told which model (agentic-cli), and
   * chain names (already `chain-*` in `config.chains`'s keys). `comfy` is
   * excluded structurally, never by name: its kind is never `agentic-cli`
   * and it owns no `[[model]]` entry, so it never enters the set.
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
      if (this.kindOf(entry) === "agentic-cli") {
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

  /** Sync accessor: reports the lifecycle's cached state, no image probe. */
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
