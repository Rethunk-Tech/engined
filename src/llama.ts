/**
 * The llama.cpp router: one container, one `llama-server` in router mode,
 * one resident GGUF per role. Composes `DockerLifecycle` for the container
 * itself and `loadSpec`/`resolveArgs` for the spec and precedence rules;
 * this file owns only what those don't: the presets INI, per-role occupancy,
 * and the load/unload/proxy sequence.
 *
 * `--models-preset` is the only channel proven to reach a child's argv — a
 * `POST /models/load` with an `args` array left argv unchanged in the probe
 * that established this design. Every per-model flag therefore goes through
 * the INI, never through the load call's body.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resolveArgs } from "./config.ts";
import type { DockerLifecycle } from "./docker.ts";
import { stateDir } from "./paths.ts";
import { loadSpec } from "./spec.ts";
import type { ContainerSpec, EngineEntry, ModelEntry, Role } from "./types.ts";
import { isContainerSpec } from "./types.ts";

/** Fixed and internal: not configuration, so no operator ever sees or names it. */
const PRESET_CONTAINER_PATH = "/preset.ini";
const MODELS_CONTAINER_PATH = "/models";
const DEFAULT_POLL_INTERVAL_MS = 250;
const WARMING_COMMENT = new TextEncoder().encode(": warming\n\n");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Mirrors config.ts's private renderer: an engine's own process flags, not a model's INI content. */
function argvFromArgs(args: Record<string, unknown>): string[] {
  const argv: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    argv.push(`--${k}`);
    if (v !== true) {
      argv.push(String(v));
    }
  }
  return argv;
}

function iniLines(args: Record<string, unknown>): string[] {
  return Object.entries(args).map(([k, v]) => `${k} = ${String(v)}`);
}

/**
 * One `[id]` section per model on this engine. A model's section starts from
 * the engine's process-flag defaults and layers the model's own on top — the
 * precedence `resolveArgs` already encodes — then passes the merged table
 * through as INI keys verbatim. A headless GGUF's `[model.args]` simply omits
 * `spec-*`, so MTP never applies process-wide by construction.
 */
export function renderPresetIni(engine: EngineEntry, models: readonly ModelEntry[]): string {
  return models
    .filter(
      (m): m is ModelEntry & { filename: string } =>
        m.engine === engine.id && m.filename !== undefined,
    )
    .map((m) => {
      const args = resolveArgs(engine.args, m.args);
      const lines = [`model = ${MODELS_CONTAINER_PATH}/${m.filename}`, ...iniLines(args)];
      return `[${m.id}]\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

export interface LlamaBuildOptions {
  enginesRoot: string;
  bunx: string;
}

/**
 * Composes `loadSpec` (structural: `--models-preset`/`--models-max`/
 * `--no-models-autoload`, never edited here) with the two bind mounts and
 * the engine's own process flags, which are runtime values `loadSpec`'s
 * placeholder substitution has no way to reach. See the report's seam note.
 */
export function buildLlamaSpec(
  engine: EngineEntry,
  opts: LlamaBuildOptions,
  presetHostPath: string,
): ContainerSpec {
  const loaded = loadSpec(engine, {
    enginesRoot: opts.enginesRoot,
    bunx: opts.bunx,
    presetIni: PRESET_CONTAINER_PATH,
  });
  if (!isContainerSpec(loaded.spec)) {
    throw new Error(`engine "${engine.id}": local-llama spec must be a container spec`);
  }
  if (engine.models_dir === undefined) {
    throw new Error(`engine "${engine.id}": local-llama engine has no models_dir`);
  }
  const { spec } = loaded;
  spec.volumes = [
    ...spec.volumes,
    { name: engine.models_dir, path: MODELS_CONTAINER_PATH, read_only: true },
    { name: presetHostPath, path: PRESET_CONTAINER_PATH, read_only: true },
  ];
  spec.command = [...spec.command, ...argvFromArgs(engine.args)];
  return spec;
}

interface RoleWaiter {
  modelId: string;
  resolve: () => void;
  reject: (err: unknown) => void;
}

interface RoleState {
  activeModelId: string | null;
  activeCount: number;
  queue: RoleWaiter[];
  pumping: boolean;
}

/** Narrower than `typeof fetch`: Bun's `fetch` type also carries a static `preconnect`, which a plain test double has no reason to fake. */
export type HttpClient = (url: string, init?: RequestInit) => Promise<Response>;

export interface LlamaRouterOptions {
  enginesRoot: string;
  bunx: string;
  idleStopSeconds: number;
  readyTimeoutS: number;
  /** Defaults under the one writable state dir; tests always override this. */
  presetHostPath?: string;
  httpClient?: HttpClient;
  pollIntervalMs?: number;
}

/**
 * Body-parses defensively: a warming comment is only valid inside an SSE
 * stream, and injecting it ahead of a non-streaming JSON response would
 * corrupt that response instead of merely being ignored.
 */
function wantsStream(init: RequestInit): boolean {
  const { body } = init;
  if (typeof body !== "string") {
    return false;
  }
  try {
    const parsed = JSON.parse(body) as { stream?: unknown };
    return parsed.stream === true;
  } catch {
    return false;
  }
}

export class LlamaRouter {
  private readonly roleStates = new Map<Role, RoleState>();
  private readonly httpClient: HttpClient;
  private readonly pollIntervalMs: number;
  private readonly presetHostPath: string;
  private totalActive = 0;

  constructor(
    private readonly engine: EngineEntry,
    private readonly models: readonly ModelEntry[],
    private readonly lifecycle: DockerLifecycle,
    private readonly opts: LlamaRouterOptions,
  ) {
    this.httpClient = opts.httpClient ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.presetHostPath = opts.presetHostPath ?? `${stateDir()}/local-llama/preset.ini`;
  }

  private roleState(role: Role): RoleState {
    let state = this.roleStates.get(role);
    if (!state) {
      state = { activeModelId: null, activeCount: 0, queue: [], pumping: false };
      this.roleStates.set(role, state);
    }
    return state;
  }

  /** `private_url` from `getStatus` carries no scheme -- `docker.ts`'s own readiness poll prepends one too. */
  private baseUrl(): string {
    const url = this.lifecycle.getStatus(this.engine.id).private_url;
    if (url === null) {
      throw new Error(`${this.engine.id}: no private_url; container is not running`);
    }
    return `http://${url}`;
  }

  /** A container that was not already running has nothing loaded by construction (`--no-models-autoload`). */
  private async ensureStarted(): Promise<void> {
    const wasRunning = this.lifecycle.getStatus(this.engine.id).state === "running";
    if (wasRunning) {
      return;
    }
    mkdirSync(dirname(this.presetHostPath), { recursive: true });
    writeFileSync(this.presetHostPath, renderPresetIni(this.engine, this.models), "utf8");
    const spec = buildLlamaSpec(this.engine, this.opts, this.presetHostPath);
    await this.lifecycle.start(this.engine.id, spec, {
      idleStopSeconds: this.opts.idleStopSeconds,
      readyTimeoutS: this.opts.readyTimeoutS,
    });
    for (const state of this.roleStates.values()) {
      state.activeModelId = null;
      state.activeCount = 0;
    }
  }

  /** Same-GGUF overlap bypasses the queue entirely; anything else joins the back, in arrival order. */
  private acquireLease(role: Role, modelId: string): Promise<void> {
    const state = this.roleState(role);
    return new Promise<void>((resolve, reject) => {
      if (state.queue.length === 0 && state.activeModelId === modelId) {
        state.activeCount++;
        resolve();
        return;
      }
      state.queue.push({ modelId, resolve, reject });
      this.runPump(role);
    });
  }

  private releaseLease(role: Role): void {
    const state = this.roleState(role);
    state.activeCount = Math.max(0, state.activeCount - 1);
    this.runPump(role);
  }

  /** `pump` itself never rejects -- a failed swap is routed to its waiter's own `reject` -- so a catch here only guards a bug in pump. */
  private runPump(role: Role): void {
    this.pump(role).catch((_err: unknown) => {
      // pump() never rejects by design; nothing to do beyond not crashing.
    });
  }

  /**
   * Grants every queued entry matching the current resident immediately —
   * they share its slots. The first entry naming a different GGUF stalls the
   * pump until the resident's in-flight count drains, then swaps, so a
   * steady stream of same-model traffic queued behind a swap cannot starve it.
   */
  private async pump(role: Role): Promise<void> {
    const state = this.roleState(role);
    if (state.pumping) {
      return;
    }
    state.pumping = true;
    try {
      for (;;) {
        const [front] = state.queue;
        if (!front) {
          return;
        }
        if (state.activeModelId === front.modelId) {
          state.queue.shift();
          state.activeCount++;
          front.resolve();
          continue;
        }
        if (state.activeCount > 0) {
          return;
        }
        state.queue.shift();
        try {
          await this.swapResident(role, front.modelId);
        } catch (err) {
          front.reject(err);
          continue;
        }
        state.activeModelId = front.modelId;
        state.activeCount++;
        front.resolve();
      }
    } finally {
      state.pumping = false;
    }
  }

  private async swapResident(role: Role, modelId: string): Promise<void> {
    const state = this.roleState(role);
    const url = this.baseUrl();
    if (state.activeModelId !== null) {
      await this.unload(url, state.activeModelId);
    }
    await this.loadAndWait(url, modelId);
  }

  private async unload(baseUrl: string, modelId: string): Promise<void> {
    await this.httpClient(`${baseUrl}/models/unload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: modelId }),
    });
  }

  /** `/models/load` is asynchronous: it returns `loading` immediately, so this poll is the `warming` signal. */
  private async loadAndWait(baseUrl: string, modelId: string): Promise<void> {
    for (;;) {
      const res = await this.httpClient(`${baseUrl}/models/load`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: modelId }),
      });
      const body = (await res.json()) as { status?: string };
      if (body.status === "loaded") {
        return;
      }
      await sleep(this.pollIntervalMs);
    }
  }

  /**
   * Starts the container if needed, waits for this role's lease (unloading
   * and loading as the occupancy rule requires), then proxies. A cold wait
   * gets an SSE `: warming` comment ahead of the first real byte, only for a
   * request that is itself streaming -- see `wantsStream`.
   */
  proxy(model: ModelEntry, path: string, init: RequestInit): Response {
    const { role } = model;
    if (role === undefined) {
      throw new Error(`model "${model.id}" has no role`);
    }
    const state = this.roleState(role);
    const emitWarming =
      !(state.queue.length === 0 && state.activeModelId === model.id) && wantsStream(init);

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        try {
          if (emitWarming) {
            controller.enqueue(WARMING_COMMENT);
          }
          await this.runLease({ role, modelId: model.id, path, init }, controller);
          controller.close();
        } catch (err) {
          controller.error(err instanceof Error ? err : new Error(String(err)));
        }
      },
    });
    return new Response(stream, {
      headers: { "content-type": wantsStream(init) ? "text/event-stream" : "application/json" },
    });
  }

  /** Holds this role's lease for exactly one response: taken before the first byte, released when it ends or fails. */
  private async runLease(
    req: { role: Role; modelId: string; path: string; init: RequestInit },
    controller: ReadableStreamDefaultController<Uint8Array>,
  ): Promise<void> {
    const { role, modelId, path, init } = req;
    await this.ensureStarted();
    await this.acquireLease(role, modelId);
    this.totalActive++;
    try {
      const upstream = await this.httpClient(`${this.baseUrl()}${path}`, init);
      const reader = upstream.body?.getReader();
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          controller.enqueue(value);
        }
      }
    } finally {
      this.totalActive--;
      this.releaseLease(role);
      if (this.totalActive === 0) {
        this.lifecycle.endLease(this.engine.id, this.opts.idleStopSeconds);
      }
    }
  }
}
