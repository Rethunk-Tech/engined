/**
 * The llama.cpp router: one container, one `llama-server` in router mode,
 * one resident GGUF per role. Composes `DockerLifecycle` for the container
 * itself and `loadSpec` for the spec and precedence rules;
 * this file owns only what those don't: the presets INI, per-role occupancy,
 * and the load/unload/proxy sequence.
 *
 * `--models-preset` is the only channel proven to reach a child's argv — a
 * `POST /models/load` with an `args` array left argv unchanged in the probe
 * that established this design. Every per-model flag therefore goes through
 * the INI, never through the load call's body.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { DockerLifecycle } from "./docker.ts";
import {
  CONTENT_TYPE,
  HTTP_SERVER_ERROR_MIN,
  type HttpClient,
  JSON_CONTENT_TYPE,
  SSE_CONTENT_TYPE,
  STATUS_BAD_REQUEST,
} from "./http.ts";
import { llamaPresetPath } from "./paths.ts";
import { loadSpec, type SpecLoadOptions } from "./spec.ts";
import type { EngineEntry, ResolvedRoute, Role, RoleContention } from "./types.ts";
import {
  isContainerSpec,
  isRecord,
  MS_PER_SECOND,
  ParseError,
  parseRecord,
  pollUntil,
  type RunnableContainerSpec,
} from "./types.ts";

/** Fixed and internal: not configuration, so no operator ever sees or names it. */
const PRESET_CONTAINER_PATH = "/preset.ini";
const MODELS_CONTAINER_PATH = "/models";
const DEFAULT_POLL_INTERVAL_MS = 250;
/**
 * The message bodies llama-server SENDS. The statuses they ride on are the
 * registry's in `http.ts`; only the wording is llama-server's own, so only the
 * wording is named here.
 */
/** llama-server's answer once its own residency disagrees with this router's. */
const MODEL_NOT_LOADED_MESSAGE = "model is not loaded";
/** The router proxying to a child it has already begun stopping: accepted the unload, has not finished it. */
const PROXY_UNREACHABLE_MESSAGE = "Could not establish connection";

/** Not an upstream status like the group above: the bytes this door writes while a cold swap is still waiting. */
const WARMING_COMMENT = new TextEncoder().encode(": warming\n\n");

/** One entry of llama-server's `GET /v1/models`, in the only shape this router reads. */
interface ListedModel {
  id: string;
  status?: { value?: string };
}

function iniLines(args: Record<string, unknown>): string[] {
  return Object.entries(args).map(([k, v]) => `${k} = ${String(v)}`);
}

/** `undefined` on a first start (nothing mounted yet) rather than throwing -- absence is the normal case, not an error. */
function readIfExists(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * The `model` field a chat/embeddings response body echoes back: the INI
 * section name engined itself wrote, which proves the request reached the
 * engine and not which GGUF answered. Provenance's `model_reported`.
 */
export function reportedModelFrom(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) {
    return;
  }
  const { model } = body as { model?: unknown };
  return typeof model === "string" ? model : undefined;
}

/**
 * The slot count llama.cpp's `parallel = -1` auto resolves to: measured at
 * n_slots=4 on build b10637 (`engines/llama/spec.toml`), sharing one unified
 * KV pool rather than four windows. The door needs a number to admit against
 * when a role leaves the key at auto; this is the child's real one.
 */
const AUTO_PARALLEL = 4;

/**
 * Precedence in one place: a route key beats the engine key naming it. The
 * preset INI and the door's own capacity ceiling must read the same merged
 * table, or the door admits a concurrency the child never agreed to.
 */
function mergedArgs(
  engine: EngineEntry,
  route: { args: Record<string, unknown> } | undefined,
): Record<string, unknown> {
  return { ...engine.args, ...route?.args };
}

/**
 * One `[model]` section per route on this engine. A route's section starts
 * from the engine's process-flag defaults and layers the route's own on top
 * — a route key beats the engine key naming it — then passes the merged
 * table through as INI keys verbatim. A headless GGUF's `[route.args]` simply
 * omits `spec-*`, so MTP never applies process-wide by construction.
 */
export function renderPresetIni(engine: EngineEntry, routes: readonly ResolvedRoute[]): string {
  return routes
    .filter(
      (r): r is ResolvedRoute & { filename: string; model: string } =>
        r.engine === engine.id && r.filename !== undefined && r.model !== undefined,
    )
    .map((r) => {
      const args = mergedArgs(engine, r);
      const lines = [`model = ${MODELS_CONTAINER_PATH}/${r.filename}`, ...iniLines(args)];
      return `[${r.model}]\n${lines.join("\n")}`;
    })
    .join("\n\n");
}

/**
 * Composes `loadSpec` (structural: `--models-preset`/`--models-max`/
 * `--no-models-autoload`, never edited here) with the two bind mounts.
 *
 * `engine.args` deliberately does NOT go on the command line. A CLI flag
 * overrides the preset for every model llama-server loads, so passing the
 * engine's defaults here would flatten each `[model.args]` back to the
 * engine value -- which is exactly how a model's own `ctx-size` came to be
 * silently ignored. `renderPresetIni` already layers the engine's defaults
 * under each model's section, so the child gets them either way, and only
 * this path lets a model override one.
 */
export function buildLlamaSpec(
  engine: EngineEntry,
  opts: SpecLoadOptions,
  presetHostPath: string,
): RunnableContainerSpec {
  const loaded = loadSpec(engine, {
    enginesRoot: opts.enginesRoot,
    bunx: opts.bunx,
    presetIni: PRESET_CONTAINER_PATH,
  });
  if (!isContainerSpec(loaded.spec)) {
    throw new ParseError(
      `engine "${engine.id}": llama spec must be a container spec`,
      loaded.source,
    );
  }
  if (engine.models_dir === undefined) {
    throw new ParseError(`engine "${engine.id}": llama engine has no models_dir`, loaded.source);
  }
  const { spec } = loaded;
  spec.volumes = [
    ...spec.volumes,
    { name: engine.models_dir, path: MODELS_CONTAINER_PATH, read_only: true },
    { name: presetHostPath, path: PRESET_CONTAINER_PATH, read_only: true },
  ];
  return spec;
}

interface RoleWaiter {
  modelId: string;
  /** `true` when this waiter's own grant is the one that swapped the resident. */
  resolve: (swapped: boolean) => void;
  reject: (err: unknown) => void;
}

interface RoleState {
  activeModelId: string | null;
  activeCount: number;
  /**
   * The door's own admission ceiling while `activeModelId` is resident:
   * `capacityFor`'s reading of that model's merged `parallel`, kept here
   * as a real number rather than re-read from the loose args record at
   * every admission check. Recomputed each time `activeModelId` changes,
   * since a swap can move a role onto a differently-configured model.
   * `Infinity` until the first model loads, since nothing is in flight to
   * admit against before there is a resident model to read a `parallel` off.
   */
  capacity: number;
  queue: RoleWaiter[];
  pumping: boolean;
}

/**
 * One hop's answer, with the GGUF the engine reported holding for the role
 * while that answer was being served. Read under the same lease, so it cannot
 * name a model promoted after the fact.
 */
export interface LlamaHop {
  response: Response;
  modelResident: string | undefined;
}

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
  return typeof body === "string" && parseRecord(body)?.stream === true;
}

/**
 * The consumer-driven half of `fetchStreamed`: chunks piped from the already
 * open upstream reader, and `release` called on whichever terminus arrives --
 * drain, error, or the client cancelling. Module-scope because it touches no
 * router state; the lease is entirely `release`'s business.
 */
function pipeUpstream(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  emitWarming: boolean,
  release: () => void,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      if (emitWarming) {
        controller.enqueue(WARMING_COMMENT);
      }
      if (!reader) {
        controller.close();
        release();
      }
    },
    pull: async (controller) => {
      if (!reader) {
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          release();
          return;
        }
        controller.enqueue(value);
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error(String(err)));
        release();
      }
    },
    cancel: (reason) => {
      release();
      // A client disconnecting mid-stream cancels this ReadableStream, but
      // that alone leaves the upstream llama-server connection open (and its
      // reader pending) until GC -- cancel it too so the socket closes now,
      // not eventually.
      reader?.cancel(reason).catch(() => undefined);
    },
  });
}

export class LlamaRouter {
  private readonly roleStates = new Map<Role, RoleState>();
  private readonly httpClient: HttpClient;
  private readonly pollIntervalMs: number;
  private readonly presetHostPath: string;
  private totalActive = 0;
  /** De-dupes concurrent first-requests the same way `DockerLifecycle.start`'s own `startPromise` does -- `ensureStarted` now has a second mutating step (a recreate) that isn't safe to double-fire. */
  private ensureStartedPromise: Promise<void> | null = null;
  /** See `pinContainer`: at most one, held for the life of the router. */
  private containerLease: "none" | "held" = "none";

  constructor(
    private readonly engine: EngineEntry,
    private readonly routes: readonly ResolvedRoute[],
    private readonly lifecycle: DockerLifecycle,
    private readonly opts: LlamaRouterOptions,
  ) {
    this.httpClient = opts.httpClient ?? fetch;
    this.pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.presetHostPath = opts.presetHostPath ?? llamaPresetPath();
  }

  /**
   * The model id currently resident for `role`, or `null` if none is —
   * occupancy is per role, so a caller asking "the" resident model without
   * naming one is asking the wrong question. Read-only: unlike `roleState`,
   * this never creates an entry for a role nothing has touched yet.
   */
  residentModel(role: Role): string | null {
    return this.roleStates.get(role)?.activeModelId ?? null;
  }

  /**
   * A `keep_resident` model is pointless if idle-stop takes the container out
   * from under it -- idle-stop stops the container, it does not unload a
   * model. So an engine with one holds a single lifecycle lease that is never
   * released, which is the same mechanism a live request uses to keep the
   * container up. Taken once, on the first lease of the process.
   */
  private pinContainer(): void {
    if (this.containerLease === "held") {
      return;
    }
    if (!this.routes.some((r) => r.keep_resident === true)) {
      return;
    }
    this.containerLease = "held";
    this.lifecycle.beginLease(this.engine.id);
  }

  /** The route this role returns to when nothing is waiting, if config pinned one. */
  private pinnedFor(role: Role): (ResolvedRoute & { model: string }) | undefined {
    return this.routes.find(
      (r): r is ResolvedRoute & { model: string } =>
        r.role === role && r.keep_resident === true && r.model !== undefined,
    );
  }

  /**
   * Makes `route` the resident one for its role and then lets go, so the next
   * real request finds it already loaded instead of paying the cold load.
   *
   * Deliberately routed through the ordinary lease rather than calling the
   * swap directly: a warm must not jump the queue, and it must obey the same
   * one-model-per-role occupancy every request does. It is exactly a request
   * that does no work. The lease is released immediately, so idle-stop is
   * armed as usual and this buys a head start rather than permanent
   * residency -- `keep_resident` is what makes residency survive.
   */
  async warm(route: ResolvedRoute, signal?: AbortSignal | null): Promise<boolean> {
    const { role, model } = route;
    if (role === undefined || model === undefined) {
      throw new Error(`route on engine "${route.engine}" has no role or model to warm`);
    }
    const swapped = await this.beginLease(role, model, signal);
    this.finishLease(role);
    return swapped;
  }

  /**
   * Every role currently doing something, for the door's own status report.
   * Read-only in the same sense as `residentModel`: it never creates a role
   * state, and it takes no lease -- a status read must not queue behind the
   * traffic it is describing.
   */
  contention(): RoleContention[] {
    const busy: RoleContention[] = [];
    for (const [role, state] of this.roleStates) {
      if (state.activeCount > 0 || state.queue.length > 0) {
        busy.push({ role, active: state.activeCount, waiting: state.queue.length });
      }
    }
    return busy;
  }

  /**
   * True while any request this router has already started is still holding
   * a lease (buffered or mid-stream). The signal a config reload needs
   * before it is safe to stop routing new requests through this instance: a
   * second, freshly-constructed router for the same container has no idea
   * what this one still has resident, so swapping it in while a lease is
   * outstanding is two independent occupancy trackers over one llama-server.
   */
  hasOutstandingLeases(): boolean {
    return this.totalActive > 0;
  }

  private roleState(role: Role): RoleState {
    let state = this.roleStates.get(role);
    if (!state) {
      state = {
        activeModelId: null,
        activeCount: 0,
        capacity: Number.POSITIVE_INFINITY,
        queue: [],
        pumping: false,
      };
      this.roleStates.set(role, state);
    }
    return state;
  }

  /**
   * A merged `parallel` of `<= 0` -- llama.cpp's `-1` auto, or the key
   * never set -- is not the absence of a ceiling; the child still admits a
   * fixed number of slots, so the door caps at `AUTO_PARALLEL` rather than
   * forwarding a burst to queue invisibly inside llama-server's scheduler.
   * Capping here is the only place that cap belongs: writing a positive
   * `parallel` into config to get one instead turns off the child's
   * `kv_unified` and divides `ctx-size` across its slots.
   */
  private capacityFor(role: Role, modelId: string): number {
    const route = this.routes.find(
      (r) => r.engine === this.engine.id && r.role === role && r.model === modelId,
    );
    const { parallel } = mergedArgs(this.engine, route);
    return typeof parallel === "number" && Number.isInteger(parallel) && parallel > 0
      ? parallel
      : AUTO_PARALLEL;
  }

  /** `private_url` from `getStatus` carries no scheme -- `docker.ts`'s own readiness poll prepends one too. */
  private baseUrl(): string {
    const url = this.lifecycle.getStatus(this.engine.id).private_url;
    if (url === null) {
      throw new Error(`${this.engine.id}: no private_url; container is not running`);
    }
    return `http://${url}`;
  }

  /** Shared by every caller in-flight at once -- see `ensureStartedPromise`'s own comment. */
  private ensureStarted(): Promise<void> {
    if (!this.ensureStartedPromise) {
      this.ensureStartedPromise = this.doEnsureStarted().finally(() => {
        this.ensureStartedPromise = null;
      });
    }
    return this.ensureStartedPromise;
  }

  /**
   * A container that was not already running has nothing loaded by
   * construction (`--no-models-autoload`), so a fresh start is the common
   * case below. The other case a config reload creates: a NEW router (a new
   * `this.engine`/`this.routes`, per `main.ts`'s stale-router swap) whose
   * container is nonetheless still running the OLD one's preset -- router-
   * mode llama-server was proven live to parse `--models-preset` exactly
   * once, at its own process start, and never again. Rewriting the mounted
   * file in place (confirmed visible inside the container immediately,
   * bind-mounts are the same inode) changed nothing: reloading even an
   * ALREADY-resident model id after the rewrite still launched with the
   * pre-rewrite args, and a model id added only by the rewrite 404'd
   * "File Not Found" forever, never picked up. So a changed preset -- new
   * model, removed model, or just different args on an existing id -- has
   * exactly one lever: recreate the container. `removeEngine` is safe to
   * reach for here because it is only ever this call path, and by the time
   * THIS router's `ensureStarted` runs at all, `main.ts` has already held
   * the outgoing router in service until its leases drained to zero -- no
   * in-flight lease exists on the container for this engine when this fires.
   */
  private async doEnsureStarted(): Promise<void> {
    const nextPreset = renderPresetIni(this.engine, this.routes);
    const wasRunning = this.lifecycle.getStatus(this.engine.id).state === "running";
    if (wasRunning) {
      if (readIfExists(this.presetHostPath) === nextPreset) {
        return;
      }
      await this.lifecycle.removeEngine(this.engine.id);
    }
    mkdirSync(dirname(this.presetHostPath), { recursive: true });
    writeFileSync(this.presetHostPath, nextPreset, "utf8");
    const spec = buildLlamaSpec(this.engine, this.opts, this.presetHostPath);
    await this.lifecycle.start(this.engine.id, spec, {
      idleStopSeconds: this.opts.idleStopSeconds,
      readyTimeoutS: this.opts.readyTimeoutS,
    });
    // A fresh child holds nothing, so no role has a resident model or a known
    // capacity any more. `activeCount` is not the child's state though: it
    // counts leases callers are still holding and will each release exactly
    // once, and `fetchUpstreamOnce`'s retry reaches this restart with those
    // leases live. Zeroing it lets the pump swap out from under them and
    // admits a second full set of requests onto the same llama.cpp slots.
    for (const state of this.roleStates.values()) {
      state.activeModelId = null;
      state.capacity = Number.POSITIVE_INFINITY;
    }
  }

  /**
   * Same-GGUF overlap bypasses the queue entirely, up to the role's
   * `capacity` -- genuine overflow past that joins the back like a real
   * model swap does, in arrival order, and waits for `pump()` to admit it
   * once a slot frees. `signal` is the caller's own hop budget, not the
   * lease grant itself: a caller that aborts while still queued behind a
   * swap (or behind capacity) must never receive that swap's `pump()` work
   * on nobody's behalf, so an abort splices the waiter back out instead of
   * letting it resolve late.
   *
   * The bypass also requires the pump to be idle. `pump` never awaits between
   * shifting a same-model waiter and resolving it, so a pump observed running
   * from here is parked inside `swapResident` or `rewarmPinned` -- both of
   * which have already unloaded the old GGUF while `activeModelId` still
   * names it and the queue is empty. That is exactly the shape the bypass
   * tests for, and taking it there proxies to a model the child no longer
   * holds.
   *
   * Resolves to whether *this* grant was the one that swapped the resident
   * in `pump()`'s `admitAfterSwap` -- never a shared flag, since a joiner
   * admitted moments later onto the same now-resident model must report
   * false even though the model was cold when it asked.
   */
  private acquireLease(role: Role, modelId: string, signal?: AbortSignal | null): Promise<boolean> {
    const state = this.roleState(role);
    return new Promise<boolean>((resolve, reject) => {
      if (
        !state.pumping &&
        state.queue.length === 0 &&
        state.activeModelId === modelId &&
        state.activeCount < state.capacity
      ) {
        state.activeCount++;
        resolve(false);
        return;
      }
      let onAbort: (() => void) | undefined;
      const cleanup = () => {
        if (onAbort) {
          signal?.removeEventListener("abort", onAbort);
        }
      };
      const waiter: RoleWaiter = {
        modelId,
        resolve: (swapped) => {
          cleanup();
          resolve(swapped);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
      };
      state.queue.push(waiter);
      if (signal) {
        onAbort = () => {
          const idx = state.queue.indexOf(waiter);
          if (idx === -1) {
            return;
          }
          state.queue.splice(idx, 1);
          waiter.reject(signal.reason ?? new Error("lease request aborted while queued"));
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      }
      this.runPump(role);
    });
  }

  private releaseLease(role: Role): void {
    const state = this.roleState(role);
    state.activeCount = Math.max(0, state.activeCount - 1);
    this.runPump(role);
  }

  /**
   * Reloads what `keep_resident` asked this role to hold, once the role has
   * drained. True when it swapped, so the pump knows to look at the queue
   * again. A failed re-warm is nobody's request to fail: it is dropped and the
   * next release retries.
   */
  private async rewarmPinned(role: Role, state: RoleState): Promise<boolean> {
    const pinned = this.pinnedFor(role);
    if (pinned === undefined || state.activeCount > 0 || state.activeModelId === pinned.model) {
      return false;
    }
    try {
      await this.swapResident(role, pinned.model);
    } catch {
      return false;
    }
    state.activeModelId = pinned.model;
    state.capacity = this.capacityFor(role, pinned.model);
    return true;
  }

  /** `pump` itself never rejects -- a failed swap is routed to its waiter's own `reject` -- so a catch here only guards a bug in pump. */
  private runPump(role: Role): void {
    this.pump(role).catch((_err: unknown) => {
      // pump() never rejects by design; nothing to do beyond not crashing.
    });
  }

  /**
   * Grants queued entries matching the current resident up to its
   * `capacity` — they share its slots, and the rest wait for a `release` to
   * call `pump` again rather than being handed a lease the server would
   * only queue internally with no visibility for this door. The first entry
   * naming a different GGUF stalls the pump until the resident's in-flight
   * count drains, then swaps, so a steady stream of same-model traffic
   * queued behind a swap cannot starve it.
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
          // Re-check the queue after a re-warm rather than returning: a request
          // arriving during the swap queues behind a pump that is already
          // running, and would otherwise never be woken.
          if (await this.rewarmPinned(role, state)) {
            continue;
          }
          return;
        }
        if (state.activeModelId === front.modelId) {
          if (state.activeCount >= state.capacity) {
            // At the door, not the queue: the front waiter stays put and the
            // next `releaseLease` re-runs the pump, exactly as a swap stalls
            // on `activeCount > 0` below.
            return;
          }
          state.queue.shift();
          state.activeCount++;
          front.resolve(false);
          continue;
        }
        if (state.activeCount > 0) {
          return;
        }
        state.queue.shift();
        await this.admitAfterSwap(role, state, front);
      }
    } finally {
      state.pumping = false;
    }
  }

  /** Swaps the resident to `front`'s GGUF and grants it the first slot; a failed swap rejects only `front`. */
  private async admitAfterSwap(role: Role, state: RoleState, front: RoleWaiter): Promise<void> {
    try {
      await this.swapResident(role, front.modelId);
    } catch (err) {
      front.reject(err);
      return;
    }
    state.activeModelId = front.modelId;
    state.capacity = this.capacityFor(role, front.modelId);
    state.activeCount++;
    front.resolve(true);
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
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ model: modelId }),
    });
  }

  /**
   * `/models/load` is asynchronous, but not the way it looks from the docs,
   * and its own response is not the ready signal either -- both probed live
   * against b10354. It never returns `{"status":"loaded"}`: a not-yet-
   * resident model answers `{"success":true}` (accepted) and a call for an
   * already-resident one 400s `{"error":{"message":"model is already
   * running"}}`. That 400 looked like readiness and is not: on a 23 GB GGUF
   * it fired ~0.25s after the trigger call, while the child was still on
   * `text_model` stage 0 of its load, and a request proxied at that point
   * 503'd. The real signal is `GET /v1/models`'s per-model
   * `data[].status.value`, which transitions `unloaded -> loading -> loaded`
   * and only reaches `loaded` once the child is actually able to serve --
   * confirmed against the same GGUF, ~8s cold. Bounded by `readyTimeoutS` --
   * the same per-engine budget the container readiness poll uses, since both
   * are "wait for the engine to become able to serve." A load that never
   * reaches `loaded` within it throws, so the caller's lease request rejects
   * instead of wedging the role's pump forever.
   */
  private async loadAndWait(baseUrl: string, modelId: string): Promise<void> {
    const deadline = Date.now() + this.opts.readyTimeoutS * MS_PER_SECOND;
    const triggerRes = await this.httpClient(`${baseUrl}/models/load`, {
      method: "POST",
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ model: modelId }),
    });
    if (triggerRes.status === STATUS_BAD_REQUEST) {
      const body = (await triggerRes.json()) as { error?: { message?: string } };
      if (body.error?.message !== "model is already running") {
        throw new Error(`${modelId}: load failed: ${body.error?.message ?? "400"}`);
      }
      // Already running by another caller's race -- fall through to confirm
      // real readiness via /v1/models rather than trusting this 400 alone.
    } else if (!triggerRes.ok) {
      throw new Error(`${modelId}: load failed: ${triggerRes.status} ${await triggerRes.text()}`);
    }
    const resident = await pollUntil(
      async () => (await this.modelStatus(baseUrl, modelId)) === "loaded",
      deadline,
      this.pollIntervalMs,
    );
    if (!resident) {
      throw new Error(
        `${modelId}: did not become resident within readyTimeoutS=${this.opts.readyTimeoutS}s`,
      );
    }
  }

  /** The engine's own view of what it holds. Both callers below read it fresh; neither caches. */
  private async listedModels(baseUrl: string): Promise<ListedModel[]> {
    const res = await this.httpClient(`${baseUrl}/v1/models`, { method: "GET" });
    const body = (await res.json()) as { data?: ListedModel[] };
    return body.data ?? [];
  }

  /** One model's readiness field: `unloaded | loading | loaded`, from `GET /v1/models`. */
  private async modelStatus(baseUrl: string, modelId: string): Promise<string | undefined> {
    const listed = await this.listedModels(baseUrl);
    return listed.find((m) => m.id === modelId)?.status?.value;
  }

  /**
   * Independent proof of which GGUF actually answered for `role`: read fresh
   * from `GET /v1/models` on this engine rather than trusted from
   * `residentModel`'s own bookkeeping, which records what this router last
   * commanded and not what the engine itself reports holding. Provenance's
   * `model_resident`, read per attempt.
   *
   * Read while the role's lease is still held, so a waiter promoted for a
   * different model cannot swap occupancy between the answer and this read.
   *
   * ponytail: costs a round-trip to the engine on every roled attempt. The
   * independence from `residentModel` is the point and caching would dissolve
   * it, so cache only per-request if provenance ever shows up in a profile.
   */
  async residentModelId(role: Role): Promise<string | undefined> {
    const listed = await this.listedModels(this.baseUrl());
    const roleIds = new Set(
      this.routes.filter((r) => r.role === role && r.model !== undefined).map((r) => r.model),
    );
    return listed.find((m) => roleIds.has(m.id) && m.status?.value === "loaded")?.id;
  }

  /**
   * Starts the container if needed, waits for this role's lease (unloading
   * and loading as the occupancy rule requires), then proxies. A cold wait
   * gets an SSE `: warming` comment ahead of the first real byte, only for a
   * request that is itself streaming -- see `wantsStream`.
   *
   * Both paths carry the upstream's real status: `runChain` advances on a
   * 5xx and must not advance on a 4xx, and neither rule is reachable if a
   * hop's `Response` is committed before the upstream has actually answered.
   * Streaming (SSE) still streams -- `fetchStreamed` awaits start/lease/fetch
   * first (mirroring `fetchBuffered`'s ordering) and only then constructs the
   * `Response`, piping the already-open upstream body through rather than
   * buffering it.
   */
  proxy(route: ResolvedRoute, path: string, init: RequestInit): Promise<LlamaHop> {
    const { role, model } = route;
    if (role === undefined || model === undefined) {
      throw new Error(`route on engine "${route.engine}" has no role or model to proxy`);
    }
    return wantsStream(init)
      ? this.fetchStreamed(role, model, path, init)
      : this.fetchBuffered(role, model, path, init);
  }

  /**
   * The acquire half of a lease. Paired with `finishLease`, which every path
   * must call exactly once however it ends. Resolves to `acquireLease`'s own
   * answer: whether this call is the one that swapped the resident.
   */
  private async beginLease(
    role: Role,
    modelId: string,
    signal?: AbortSignal | null,
  ): Promise<boolean> {
    await this.ensureStarted();
    const swapped = await this.acquireLease(role, modelId, signal);
    this.totalActive++;
    if (this.totalActive === 1) {
      this.lifecycle.beginLease(this.engine.id);
    }
    this.pinContainer();
    return swapped;
  }

  private finishLease(role: Role): void {
    this.totalActive--;
    this.releaseLease(role);
    if (this.totalActive === 0) {
      this.lifecycle.endLease(this.engine.id, this.opts.idleStopSeconds);
    }
  }

  /**
   * Ensures the container, takes this role's lease, runs `fn` against the
   * live upstream, then releases -- the one place a lease's whole lifetime
   * (start, acquire, release, idle-arm) is written, so the streaming and
   * buffered proxy paths cannot drift out of sync with each other.
   */
  private async withLease<T>(
    role: Role,
    modelId: string,
    signal: AbortSignal | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.beginLease(role, modelId, signal);
    try {
      return await fn();
    } finally {
      this.finishLease(role);
    }
  }

  /**
   * A container killed from outside engined leaves `state: running` and a
   * `private_url` nothing listens on. Nothing else ever asks docker about an
   * `openai-http` engine between starts -- `DockerLifecycle.start` returns
   * early while it believes the engine is up -- so without this the router
   * proxies to a dead port for the rest of the process's life, and only a
   * restart clears it.
   *
   * Reconciling here costs a `docker inspect` only once a request has already
   * failed; doing it before every request would tax every healthy one. Docker
   * decides, so a genuine upstream error against a live container rethrows
   * untouched rather than provoking a pointless restart.
   *
   * The retry re-sends `init` as given, which every caller builds with a
   * string body (`main.ts` stringifies the JSON it forwards). A streamed
   * request body would already be consumed and must not be retried here.
   */
  private async fetchUpstreamOnce(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.httpClient(`${this.baseUrl()}${path}`, init);
    } catch (err) {
      // A cancelled request is the door's own timeout budget expiring, not a
      // container that went away: retrying it would outlive the budget that
      // just fired, and turn a chain's 503 into a late 200.
      if (init.signal?.aborted === true) {
        throw err;
      }
      const reconciled = await this.lifecycle.reconcile(this.engine.id);
      if (reconciled.state === "running") {
        throw err;
      }
      await this.ensureStarted();
      return await this.httpClient(`${this.baseUrl()}${path}`, init);
    }
  }

  /**
   * `activeModelId` records what this router last commanded, not what the
   * engine actually holds, and the two come apart whenever anything unloads
   * behind it -- an operator poking `/models/unload`, or a router-side
   * eviction. The lease layer then sees its own belief satisfied, skips the
   * swap, and proxies to a child that answers 400 "model is not loaded" for
   * the rest of the process's life: the role never reloads, because nothing
   * in the request path ever asks the engine who is resident.
   *
   * So the 400 is the trigger to reconcile, exactly as a transport failure is
   * the trigger to reconcile the container in `fetchUpstreamOnce`. Both pay
   * only once a request has already failed rather than taxing healthy ones,
   * and both re-send `init` as given -- safe because every caller builds it
   * with a string body, and a consumed stream must never be retried here.
   *
   * `loadAndWait` is the whole repair: the belief is already correct about
   * WHICH model belongs here, so nothing needs unloading first, and its
   * `/v1/models` poll is what makes the retry wait for real readiness
   * instead of racing the child's load.
   */
  private async fetchUpstream(
    path: string,
    init: RequestInit,
    modelId?: string,
  ): Promise<Response> {
    const res = await this.fetchUpstreamOnce(path, init);
    if (modelId === undefined) {
      return res;
    }
    const fault = await this.residencyFault(res);
    if (fault === "none") {
      return res;
    }
    const url = this.baseUrl();
    // An unreachable child is one the router is still advertising as loaded,
    // so reloading first would be a no-op and the retry would land on the same
    // dying process. Waiting for the router to admit the instance is gone is
    // what makes the reload real.
    if (fault === "unreachable") {
      await this.awaitInstanceGone(url, modelId);
    }
    await this.loadAndWait(url, modelId);
    return await this.fetchUpstreamOnce(path, init);
  }

  /**
   * Both faults mean "the child that should serve this is not there", and
   * both are reached only after a request has already failed. They are kept
   * apart because they need different repairs, and because neither may be
   * widened into "retry any 5xx": re-sending a request a live child genuinely
   * failed turns one bad answer into two. Reads a clone so the caller still
   * owns an unconsumed body on every path.
   */
  private async residencyFault(res: Response): Promise<"none" | "not-loaded" | "unreachable"> {
    if (res.ok) {
      return "none";
    }
    let body: string;
    try {
      body = await res.clone().text();
    } catch {
      return "none";
    }
    // The router writes this one as plain text, not as its JSON error shape.
    if (res.status === HTTP_SERVER_ERROR_MIN && body.includes(PROXY_UNREACHABLE_MESSAGE)) {
      return "unreachable";
    }
    const error = parseRecord(body)?.error;
    return isRecord(error) && error.message === MODEL_NOT_LOADED_MESSAGE ? "not-loaded" : "none";
  }

  /**
   * Bounded by the same `readyTimeoutS` every other "wait for the engine to be
   * able to serve" uses. Giving up returns rather than throws: the reload and
   * its own poll follow, and they are better placed to fail with a real reason
   * than a timeout here would be.
   */
  private async awaitInstanceGone(baseUrl: string, modelId: string): Promise<void> {
    await pollUntil(
      async () => (await this.modelStatus(baseUrl, modelId)) !== "loaded",
      Date.now() + this.opts.readyTimeoutS * MS_PER_SECOND,
      this.pollIntervalMs,
    );
  }

  /** Buffered so the lease stays held until the whole body is read, same as the streaming path holds it until the stream ends. */
  private fetchBuffered(
    role: Role,
    modelId: string,
    path: string,
    init: RequestInit,
  ): Promise<LlamaHop> {
    return this.withLease(role, modelId, init.signal, async () => {
      const upstream = await this.fetchUpstream(path, init, modelId);
      const body = await upstream.arrayBuffer();
      return {
        response: new Response(body, { status: upstream.status, headers: upstream.headers }),
        modelResident: await this.residentModelId(role),
      };
    });
  }

  /**
   * Mirrors `fetchBuffered`'s ordering so a streaming request commits to a
   * hop only once the upstream has actually answered: start/lease/fetch all
   * run and are awaited before the `Response` (and its real status) is
   * built, so `runChain` sees a genuine 5xx/4xx instead of an unconditional
   * 200. Only the body stays lazy -- piped chunk by chunk from the
   * already-open upstream reader -- so a streaming request never buffers its
   * answer. `: warming` is still emitted (the caller's cold-swap wait ended
   * the moment `beginLease` resolved, before this ever runs), but it can no
   * longer be what commits the response: that already happened above. The
   * lease itself is released only once the pipe ends, fails, or is
   * cancelled -- never at `beginLease` -- matching `withLease`'s contract.
   */
  private async fetchStreamed(
    role: Role,
    modelId: string,
    path: string,
    init: RequestInit,
  ): Promise<LlamaHop> {
    const state = this.roleState(role);
    const emitWarming = !(state.queue.length === 0 && state.activeModelId === modelId);
    await this.beginLease(role, modelId, init.signal);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const release = this.streamRelease(role, init.signal, (reason) => {
      reader?.cancel(reason).catch(() => undefined);
    });
    // Everything between the lease and the `Response` can throw -- the fetch
    // itself, and the provenance read, whose `res.json()` rejects on any
    // non-JSON body llama-server writes. Without this the lease is never
    // released and the engine's idle-stop is never armed again.
    try {
      const upstream = await this.fetchUpstream(path, init, modelId);
      reader = upstream.body?.getReader();
      const modelResident = await this.residentModelId(role);
      return {
        response: new Response(pipeUpstream(reader, emitWarming, release), {
          status: upstream.status,
          headers: { [CONTENT_TYPE]: SSE_CONTENT_TYPE },
        }),
        modelResident,
      };
    } catch (err) {
      release();
      throw err;
    }
  }

  /**
   * The one release a streamed hop's lease has, idempotent so whichever
   * terminus arrives first is the one that counts: the stream draining,
   * erroring or being cancelled, a throw before the stream exists, or the
   * caller aborting.
   *
   * The abort listener is why this is not simply `withLease`'s `finally`: the
   * other release paths are driven by the stream's consumer -- `pull` on
   * drain, `cancel` on disconnect -- and a client that goes away without the
   * runtime pulling or cancelling reaches none of them. The abort signal is
   * the one signal that does not depend on the consumer.
   */
  private streamRelease(
    role: Role,
    signal: AbortSignal | null | undefined,
    cancelUpstream: (reason: unknown) => void,
  ): () => void {
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      signal?.removeEventListener("abort", onAbort);
      this.finishLease(role);
    };
    const onAbort = () => {
      release();
      cancelUpstream(signal?.reason);
    };
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener("abort", onAbort, { once: true });
    }
    return release;
  }
}
