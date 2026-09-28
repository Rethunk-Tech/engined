/**
 * The llama.cpp router: one container, one `llama-server` in router mode,
 * one resident GGUF per role. Composes `DockerLifecycle` for the container
 * itself, `loadSpec` for the spec and precedence rules, `RoleScheduler` for
 * per-role occupancy and `LlamaUpstream` for the calls into llama-server;
 * this file owns the presets INI and the lease/proxy sequence around them.
 *
 * `--models-preset` is the only channel proven to reach a child's argv — a
 * `POST /models/load` with an `args` array left argv unchanged in the probe
 * that established this design. Every per-model flag therefore goes through
 * the INI, never through the load call's body.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DockerLifecycle } from './docker.ts'
import { CONTENT_TYPE, type HttpClient, SSE_CONTENT_TYPE } from './http.ts'
import { RoleScheduler } from './llamaRoles.ts'
import {
  classifyPrompt,
  DEFAULT_SLOT_LONG_THRESHOLD,
  LlamaSlotTable,
  renderedPromptText,
} from './llamaSlots.ts'
import {
  AUTO_PARALLEL,
  buildLlamaSpec,
  explicitParallel,
  readIfExists,
  renderPresetIni,
} from './llamaSpec.ts'
import { LlamaUpstream, pipeUpstream } from './llamaUpstream.ts'
import { llamaPresetPath } from './paths.ts'
import { isRecord, parseRecord } from './records.ts'
import type { RoleContention } from './responses.ts'
import { ggufPath } from './tokenizeRoute.ts'
import type { EngineEntry, ResolvedRoute, Role } from './types.ts'

/**
 * The `model` field a chat/embeddings response body echoes back: the INI
 * section name engined itself wrote, which proves the request reached the
 * engine and not which GGUF answered. Provenance's `model_reported`.
 */
export function reportedModelFrom(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return
  }
  const { model } = body
  return typeof model === 'string' ? model : undefined
}

/** Fixed and internal: not configuration, so no operator ever sees or names it. */
const DEFAULT_POLL_INTERVAL_MS = 250
/**
 * One hop's answer, with the GGUF the engine reported holding for the role
 * while that answer was being served. Read under the same lease, so it cannot
 * name a model promoted after the fact.
 */
export interface LlamaHop {
  response: Response
  modelResident: string | undefined
  /** Time from `proxy()`'s own call to the lease grant -- `x-engined-queue-ms`'s source. 0 when nothing was waited on: an idle role's role/container are granted synchronously. */
  queueMs: number
}

/** One `proxy()` call's fields, bundled so `fetchBuffered`/`fetchStreamed` take one object rather than five positional arguments. */
interface HopCall {
  role: Role
  modelId: string
  path: string
  init: RequestInit
  route: ResolvedRoute
}

export interface LlamaRouterOptions {
  enginesRoot: string
  bunx: string
  idleStopSeconds: number
  readyTimeoutS: number
  /** Defaults under the one writable state dir; tests always override this. */
  presetHostPath?: string
  httpClient?: HttpClient
  pollIntervalMs?: number
}

/**
 * Body-parses defensively: a warming comment is only valid inside an SSE
 * stream, and injecting it ahead of a non-streaming JSON response would
 * corrupt that response instead of merely being ignored.
 */
function wantsStream(init: RequestInit): boolean {
  const { body } = init
  return typeof body === 'string' && parseRecord(body)?.stream === true
}

export class LlamaRouter {
  private readonly scheduler: RoleScheduler
  private readonly upstream: LlamaUpstream
  private readonly presetHostPath: string
  private totalActive = 0
  /** De-dupes concurrent first-requests the same way `DockerLifecycle.start`'s own `startPromise` does -- `ensureStarted` now has a second mutating step (a recreate) that isn't safe to double-fire. */
  private ensureStartedPromise: Promise<void> | null = null
  /** See `pinContainer`: at most one, held for the life of the router. */
  private containerLease: 'none' | 'held' = 'none'

  private readonly engine: EngineEntry
  private readonly routes: readonly ResolvedRoute[]
  private readonly lifecycle: DockerLifecycle
  private readonly opts: LlamaRouterOptions
  /** One slot table per resident model id -- see `placeSlot`. Rebuilt (losing its history) if a config reload changes that model's merged `parallel`. */
  private readonly slotTables = new Map<string, LlamaSlotTable>()

  constructor(
    engine: EngineEntry,
    routes: readonly ResolvedRoute[],
    lifecycle: DockerLifecycle,
    opts: LlamaRouterOptions,
  ) {
    this.engine = engine
    this.routes = routes
    this.lifecycle = lifecycle
    this.opts = opts
    this.upstream = new LlamaUpstream({
      engineId: engine.id,
      lifecycle,
      httpClient: opts.httpClient ?? fetch,
      readyTimeoutS: opts.readyTimeoutS,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      ensureStarted: () => this.ensureStarted(),
    })
    this.scheduler = new RoleScheduler({
      swap: async (from, to) => {
        if (from !== null) {
          await this.upstream.unload(from)
        }
        await this.upstream.loadAndWait(to)
      },
      capacityFor: (role, modelId) => this.capacityFor(role, modelId),
      pinnedModel: (role) => this.pinnedFor(role)?.model,
    })
    this.presetHostPath = opts.presetHostPath ?? llamaPresetPath(engine.id)
  }

  /**
   * The model id currently resident for `role`, or `null` if none is —
   * occupancy is per role, so a caller asking "the" resident model without
   * naming one is asking the wrong question.
   */
  residentModel(role: Role): string | null {
    return this.scheduler.residentModel(role)
  }

  /**
   * A `keep_resident` model is pointless if idle-stop takes the container out
   * from under it -- idle-stop stops the container, it does not unload a
   * model. So an engine with one holds a single lifecycle lease that is never
   * released, which is the same mechanism a live request uses to keep the
   * container up. Taken once, on the first lease of the process.
   */
  private pinContainer(): void {
    if (this.containerLease === 'held') {
      return
    }
    if (!this.routes.some((r) => r.keep_resident === true)) {
      return
    }
    this.containerLease = 'held'
    this.lifecycle.beginLease(this.engine.id)
  }

  /**
   * Ends the keep_resident pin. A config reload that retires this router must
   * call this, or the pin outlives the routes that justified it and idle-stop
   * never fires.
   */
  dispose(): void {
    if (this.containerLease !== 'held') {
      return
    }
    this.containerLease = 'none'
    this.lifecycle.endLease(this.engine.id, this.opts.idleStopSeconds)
  }

  /** The route this role returns to when nothing is waiting, if config pinned one. */
  private pinnedFor(role: Role): (ResolvedRoute & { model: string }) | undefined {
    return this.routes.find(
      (r): r is ResolvedRoute & { model: string } =>
        r.role === role && r.keep_resident === true && r.model !== undefined,
    )
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
    const { role, model } = route
    if (role === undefined || model === undefined) {
      throw new Error(`route on engine "${route.engine}" has no role or model to warm`)
    }
    const swapped = await this.beginLease(role, model, signal)
    this.finishLease(role)
    return swapped
  }

  /** Every role currently doing something, for the door's own status report; takes no lease. */
  contention(): RoleContention[] {
    return this.scheduler.contention()
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
    return this.totalActive > 0
  }

  /**
   * A merged `parallel` of `<= 0` -- llama.cpp's `-1` auto, or the key
   * never set -- is not the absence of a ceiling; the child still admits a
   * fixed number of slots, so the door caps at `AUTO_PARALLEL` rather than
   * forwarding a burst to queue invisibly inside llama-server's scheduler.
   * Capping here is the only place that cap belongs: writing a positive
   * `parallel` into config to get one instead turns off the child's
   * `kv_unified` and divides `ctx-size` across its slots, unless `kv-unified`
   * is itself set to keep the whole pool shared regardless of slot count
   * (`modelsMenu.ts`'s `derivedContextIn`) -- either way the slot count this
   * caps at is `parallel`'s own, so that override changes nothing here.
   */
  private capacityFor(role: Role, modelId: string): number {
    const route = this.routes.find(
      (r) => r.engine === this.engine.id && r.role === role && r.model === modelId,
    )
    const parallel = explicitParallel(this.engine, route)
    return parallel ?? AUTO_PARALLEL
  }

  /** Shared by every caller in-flight at once -- see `ensureStartedPromise`'s own comment. */
  private ensureStarted(): Promise<void> {
    if (!this.ensureStartedPromise) {
      this.ensureStartedPromise = this.doEnsureStarted().finally(() => {
        this.ensureStartedPromise = null
      })
    }
    return this.ensureStartedPromise
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
    const nextPreset = renderPresetIni(this.engine, this.routes)
    const wasRunning = this.lifecycle.getStatus(this.engine.id).state === 'running'
    if (wasRunning) {
      if (readIfExists(this.presetHostPath) === nextPreset) {
        return
      }
      await this.lifecycle.removeEngine(this.engine.id)
    }
    mkdirSync(dirname(this.presetHostPath), { recursive: true })
    writeFileSync(this.presetHostPath, nextPreset, 'utf8')
    const spec = buildLlamaSpec(this.engine, this.opts, this.presetHostPath)
    await this.lifecycle.start(this.engine.id, spec, {
      idleStopSeconds: this.opts.idleStopSeconds,
      readyTimeoutS: this.opts.readyTimeoutS,
    })
    this.scheduler.forgetResidents()
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
   * Costs a round-trip to the engine on every roled attempt.
   * Measured live against this box's llama-server: the round trip itself
   * averages 0.19 ms over a warmed connection (N=20), against 292-390 ms for
   * a short end-to-end chat completion (N=5, max_tokens=8) -- under 0.1% of
   * the request it rides on. Not worth caching. The independence from
   * `residentModel` is the point, and caching would dissolve it.
   */
  async residentModelId(role: Role): Promise<string | undefined> {
    const listed = await this.upstream.listedModels()
    const roleIds = new Set(
      this.routes.filter((r) => r.role === role && r.model !== undefined).map((r) => r.model),
    )
    return listed.find((m) => roleIds.has(m.id) && m.status?.value === 'loaded')?.id
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
    const { role, model } = route
    if (role === undefined || model === undefined) {
      throw new Error(`route on engine "${route.engine}" has no role or model to proxy`)
    }
    const call: HopCall = { role, modelId: model, path, init, route }
    return wantsStream(init) ? this.fetchStreamed(call) : this.fetchBuffered(call)
  }

  /** Rebuilt whenever a config reload changes this model's merged `parallel` -- rare, and a slot table starting cold on that edge is far cheaper than tracking a table shape nothing asks to persist. */
  private slotTableFor(modelId: string, parallel: number): LlamaSlotTable {
    const existing = this.slotTables.get(modelId)
    if (existing !== undefined && existing.parallel === parallel) {
      return existing
    }
    const table = new LlamaSlotTable(parallel)
    this.slotTables.set(modelId, table)
    return table
  }

  /**
   * Folds a chosen `id_slot` into `init`'s body, when there is one to choose --
   * see `llamaSlots.ts`. Every one of these is the reason there is nothing to
   * place, in which case `init` comes back untouched and `release` is a no-op:
   * this route's merged `parallel` is not a positive integer `>= 2`; the body
   * is not JSON or already names `id_slot` itself, which always wins untouched;
   * or no slot in the prompt's own size class is idle right now, in which case
   * llama-server decides exactly as it did before this existed.
   */
  private async placeSlot(
    route: ResolvedRoute,
    modelId: string,
    init: RequestInit,
  ): Promise<{ init: RequestInit; release: () => void }> {
    const untouched = { init, release: () => undefined }
    const parallel = explicitParallel(this.engine, route)
    if (parallel === undefined || parallel < 2) {
      return untouched
    }
    if (typeof init.body !== 'string') {
      return untouched
    }
    const body = parseRecord(init.body)
    if (body === null || body.id_slot !== undefined) {
      return untouched
    }
    const { sizeClass, fingerprint } = await classifyPrompt(
      ggufPath(route, this.engine.models_dir),
      renderedPromptText(body),
      route.slot_long_threshold ?? DEFAULT_SLOT_LONG_THRESHOLD,
    )
    const slotId = this.slotTableFor(modelId, parallel).acquire(sizeClass, fingerprint)
    if (slotId === undefined) {
      return untouched
    }
    return {
      init: { ...init, body: JSON.stringify({ ...body, id_slot: slotId }) },
      release: () => this.slotTableFor(modelId, parallel).release(slotId, fingerprint, Date.now()),
    }
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
    await this.ensureStarted()
    const swapped = await this.scheduler.acquire(role, modelId, signal)
    this.totalActive += 1
    if (this.totalActive === 1) {
      this.lifecycle.beginLease(this.engine.id)
    }
    this.pinContainer()
    return swapped
  }

  private finishLease(role: Role): void {
    this.totalActive -= 1
    this.scheduler.release(role)
    if (this.totalActive === 0) {
      this.lifecycle.endLease(this.engine.id, this.opts.idleStopSeconds)
    }
  }

  /**
   * Ensures the container, takes this role's lease, runs `fn` against the
   * live upstream, then releases -- the one place a lease's whole lifetime
   * (start, acquire, release, idle-arm) is written, so the streaming and
   * buffered proxy paths cannot drift out of sync with each other.
   */
  async withLease<T>(
    role: Role,
    modelId: string,
    signal: AbortSignal | null | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    await this.beginLease(role, modelId, signal)
    try {
      return await fn()
    } finally {
      this.finishLease(role)
    }
  }

  /** Buffered so the lease stays held until the whole body is read, same as the streaming path holds it until the stream ends. Slot placement runs inside the same lease, so a route on a slot table that was never touched never pays for one. */
  private fetchBuffered({ role, modelId, path, init, route }: HopCall): Promise<LlamaHop> {
    const queueStart = Date.now()
    return this.withLease(role, modelId, init.signal, async () => {
      const queueMs = Date.now() - queueStart
      const { init: placed, release: releaseSlot } = await this.placeSlot(route, modelId, init)
      try {
        const upstream = await this.upstream.fetch(path, placed, modelId)
        const body = await upstream.arrayBuffer()
        return {
          response: new Response(body, { status: upstream.status, headers: upstream.headers }),
          modelResident: await this.residentModelId(role),
          queueMs,
        }
      } finally {
        releaseSlot()
      }
    })
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
  private async fetchStreamed({ role, modelId, path, init, route }: HopCall): Promise<LlamaHop> {
    const queueStart = Date.now()
    const emitWarming = !this.scheduler.isResident(role, modelId)
    await this.beginLease(role, modelId, init.signal)
    const queueMs = Date.now() - queueStart
    const { init: placed, release: releaseSlot } = await this.placeSlot(route, modelId, init)
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const release = this.streamRelease(
      role,
      init.signal,
      (reason) => {
        reader?.cancel(reason).catch(() => undefined)
      },
      releaseSlot,
    )
    // Everything between the lease and the `Response` can throw -- the fetch
    // itself, and the provenance read, whose `res.json()` rejects on any
    // non-JSON body llama-server writes. Without this the lease is never
    // released and the engine's idle-stop is never armed again.
    try {
      const upstream = await this.upstream.fetch(path, placed, modelId)
      reader = upstream.body?.getReader() as ReadableStreamDefaultReader<Uint8Array> | undefined
      const modelResident = await this.residentModelId(role)
      const contentType = upstream.ok
        ? SSE_CONTENT_TYPE
        : (upstream.headers.get(CONTENT_TYPE) ?? SSE_CONTENT_TYPE)
      return {
        response: new Response(pipeUpstream(reader, emitWarming, release), {
          status: upstream.status,
          headers: { [CONTENT_TYPE]: contentType },
        }),
        modelResident,
        queueMs,
      }
    } catch (err) {
      release()
      throw err
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
    releaseSlot: () => void,
  ): () => void {
    let released = false
    const release = () => {
      if (released) {
        return
      }
      released = true
      signal?.removeEventListener('abort', onAbort)
      this.finishLease(role)
      releaseSlot()
    }
    const onAbort = () => {
      release()
      cancelUpstream(signal?.reason)
    }
    if (signal?.aborted) {
      onAbort()
    } else {
      signal?.addEventListener('abort', onAbort, { once: true })
    }
    return release
  }
}
