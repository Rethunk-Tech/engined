/**
 * The one consumer and operator surface: composes config, spec loading and
 * the container lifecycle into `GET /v1/engines`, `GET /v1/models` and
 * `POST /v1/engines/:id/start`. Nothing here talks to docker or parses TOML
 * directly beyond the one image-presence probe noted below — that is
 * `docker.ts` and `spec.ts`'s job.
 */

import { DockerLifecycle, dockerExec, type Exec, type Probe } from "./docker.ts";
import { loadSpec, type SpecLoadOptions } from "./spec.ts";
import {
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
}

interface Entry {
  engine: EngineEntry;
  /** `null` for a remote-address-only engine: it has no spec directory to load. */
  spec: LoadedSpec | null;
}

function buildEntries(config: Config, specOptions: SpecLoadOptions): Entry[] {
  return config.engines.map((engine) => ({
    engine,
    spec: engine.base_url === undefined ? loadSpec(engine, specOptions) : null,
  }));
}

export class EngineRegistry {
  private readonly exec: Exec;
  private readonly lifecycle: DockerLifecycle;
  private readonly secretResolves: (secret: SecretRef) => boolean;
  private readonly specOptions: SpecLoadOptions;
  private config: Config;
  private entries: Entry[];
  private byId: Map<string, Entry>;

  constructor(config: Config, opts: RegistryOptions) {
    this.exec = opts.exec ?? dockerExec;
    this.lifecycle = opts.lifecycle ?? new DockerLifecycle(this.exec, opts.probe);
    this.secretResolves = opts.secretResolves ?? defaultSecretResolves;
    this.specOptions = {
      enginesRoot: opts.enginesRoot,
      bunx: opts.bunx,
      presetIni: opts.presetIni,
    };
    this.config = config;
    this.entries = buildEntries(config, this.specOptions);
    this.byId = new Map(this.entries.map((e) => [e.engine.id, e]));
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

  /** `docker image inspect`, read-only: never runs or stops anything. */
  private async probeImage(
    spec: ContainerSpec,
  ): Promise<{ ok: true } | { ok: false; fix: string; error: string }> {
    const res = await this.exec(["image", "inspect", spec.image]);
    if (res.exitCode === 0) {
      return { ok: true };
    }
    const fix = spec.obtain === "pull" ? `docker pull ${spec.image}` : `docker build ${spec.image}`;
    return { ok: false, fix, error: `${spec.image}: image not present` };
  }

  /**
   * `syncStatus` plus a cold image probe for a container engine nothing has
   * started or checked yet, so a never-started engine with a missing image
   * reports `unavailable` on the very first `GET /v1/engines` rather than
   * waiting for a start attempt to notice.
   */
  private async statusFor(entry: Entry): Promise<EngineStatus> {
    const base = this.syncStatus(entry);
    if (base.state !== "installed" || entry.spec === null || !isContainerSpec(entry.spec.spec)) {
      return base;
    }
    const probe = await this.probeImage(entry.spec.spec);
    if (probe.ok) {
      return base;
    }
    return { ...base, state: "unavailable", fix: probe.fix, last_error: probe.error };
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
    await this.lifecycle.start(id, entry.spec.spec, {
      idleStopSeconds: entry.engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
      readyTimeoutS: entry.engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
    });
    return this.statusFor(entry);
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
  }

  async shutdown(): Promise<void> {
    await this.lifecycle.shutdown();
  }
}
