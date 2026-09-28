/**
 * The one consumer and operator surface: composes config, spec loading and
 * the container lifecycle into `GET /engined/v1/engines`, `GET /openai/v1/models` and
 * `POST /engined/v1/engines/:id/start`. Nothing here talks to docker or parses TOML
 * directly — that is `docker.ts` and `spec.ts`'s job.
 */

import { rmSync } from 'node:fs'
import { dirname } from 'node:path'
import process from 'node:process'
import { AgenticGate } from './agenticGate.ts'
import { observeAgentVersion } from './agentVersion.ts'
import {
  COMFY_POLL_INTERVAL_MS,
  ComfyQueueWatch,
  defaultQueueFetch,
  defaultReleaseFetch,
  type ReleaseFetch,
  releaseComfyMemory,
} from './comfyQueue.ts'
import { DockerLifecycle, dockerExec } from './docker.ts'
import {
  baseStatus,
  buildEntries,
  disabledStatus,
  type Entry,
  engineShape,
  hasLocalBinding,
  isLocalLlama,
  statusFrom,
} from './engineEntries.ts'
import type { Exec } from './exec.ts'
import { Inventory } from './inventory.ts'
import { InventoryWatch } from './inventoryWatch.ts'
import { writeLocalPreset } from './llamaSpec.ts'
import { ModelResidency, specForModel } from './modelResidency.ts'
import { llamaPresetPath } from './paths.ts'
import { errMessage, MS_PER_SECOND } from './records.ts'
import type { RegistryOptions } from './registryOptions.ts'
import type { EngineResources } from './resources.ts'
import { CONTRACT, type EngineStatus, type EnginesResponse } from './responses.ts'
import type { RuntimeStatus } from './runtimeTable.ts'
import type { SpecLoadOptions } from './spec.ts'
import { isContainerSpec, type Spec } from './specTypes.ts'
import type { Config, EngineEntry } from './types.ts'

/** Set at build time by the install script; absent in a working-tree run. */
declare const ENGINED_COMMIT: string | undefined

export class EngineRegistry {
  private readonly exec: Exec
  private readonly lifecycle: DockerLifecycle
  private readonly specOptions: SpecLoadOptions
  private readonly releaseFetch: ReleaseFetch
  private readonly comfy: ComfyQueueWatch
  private readonly agentic: AgenticGate
  private readonly presetHostPathFor: (engineId: string) => string
  /** False when `opts.presetHostPath` overrode the per-engine default -- a test-only path shared across engines that teardown must never delete out from under a sibling. */
  private readonly usesDefaultPresetPath: boolean
  private readonly inventoryWatch: InventoryWatch
  /**
   * The shape each running container was started under, set when this registry
   * starts one. A later start overwrites it and only a running engine is ever
   * asked, so a leftover entry for something stopped cannot report a
   * supersession that is not there.
   */
  private readonly launchedShape = new Map<string, string>()
  private config: Config
  private entries: Entry[]
  private byId: Map<string, Entry>
  private readonly residency: ModelResidency

  constructor(config: Config, opts: RegistryOptions) {
    this.exec = opts.exec ?? dockerExec
    this.lifecycle = opts.lifecycle ?? new DockerLifecycle(this.exec, opts.probe)
    this.specOptions = {
      enginesRoot: opts.enginesRoot,
      bunx: opts.bunx,
    }
    this.releaseFetch = opts.releaseFetch ?? defaultReleaseFetch
    this.residency = new ModelResidency(this.lifecycle)
    this.comfy = new ComfyQueueWatch(
      this.lifecycle,
      opts.queueFetch ?? defaultQueueFetch,
      opts.comfyPollIntervalMs ?? COMFY_POLL_INTERVAL_MS,
    )
    this.agentic = new AgenticGate({
      runner: opts.agenticProbeRunner,
      launchNonces: opts.launchNonces ?? new Set(),
      observeAgentVersion: opts.observeAgentVersion ?? observeAgentVersion,
    })
    this.presetHostPathFor = (id) => opts.presetHostPath ?? llamaPresetPath(id)
    this.usesDefaultPresetPath = opts.presetHostPath === undefined
    this.inventoryWatch = new InventoryWatch(opts.inventory ?? new Inventory())
    this.config = config
    this.entries = buildEntries(config, this.specOptions, this.presetHostPathFor)
    this.byId = new Map(this.entries.map((e) => [e.engine.id, e]))
    // Attached here, not passed to the constructor above: `createDoor` builds
    // its own lifecycle to share with the llama routers and hands it in, and
    // a constructor argument would never reach that one.
    this.lifecycle.onChange((id) => {
      this.announce(id)
    })
    this.comfy.watch(this.entries)
  }

  get inventory(): Inventory {
    return this.inventoryWatch.inventory
  }

  /** How many catalog refresh intervals are armed. Tests the clear-and-restart, not a live signal. */
  inventoryWatchCount(): number {
    return this.inventoryWatch.count()
  }

  /**
   * Arm catalog timers and kick a fetch without waiting for it. Listen must
   * not sit on the provider; the first menu after boot may still be empty.
   */
  startInventoryRefresh(): void {
    this.inventoryWatch.start(this.config)
  }

  /**
   * Subscribers to engine state changes. A set, so a dropped connection
   * removes exactly its own listener and a reconnect is a fresh entry rather
   * than a duplicate of the old one.
   */
  private readonly watchers = new Set<(status: EngineStatus) => void>()

  /**
   * Subscribe to state changes; the returned function unsubscribes. Callers
   * get the changed engine's full status, not just its id -- a consumer
   * receiving only an id has to turn around and ask, which reintroduces the
   * polling the stream exists to remove.
   */
  watch(listener: (status: EngineStatus) => void): () => void {
    this.watchers.add(listener)
    return () => this.watchers.delete(listener)
  }

  /** A listener that throws must not stop the others from hearing about it. */
  private announce(id: string): void {
    const entry = this.byId.get(id)
    if (!entry || this.watchers.size === 0) {
      return
    }
    // syncStatus, not statusFor: the async one runs an installability probe,
    // which is both a docker round trip on every transition and a path that
    // can itself transition -- announcing from inside it would recurse.
    const status = this.syncStatus(entry)
    for (const listener of this.watchers) {
      try {
        listener(status)
      } catch {
        // A broken subscriber is its own problem; the lifecycle transition
        // that triggered this has already happened either way.
      }
    }
  }

  /**
   * Everything `getStatus`/spec loading already know, with no docker round
   * trip and no version proof: optimistic `installed`, the same resting
   * assumption a container gets before its first probe. `statusFor` is the
   * authoritative, async check.
   */
  private syncStatus(entry: Entry): EngineStatus {
    const { engine } = entry
    if (engine.disabled) {
      return disabledStatus(entry, this.config.routes)
    }

    const { spec } = entry.spec
    if (!isContainerSpec(spec)) {
      return this.inventoryWatch.withFix({
        ...baseStatus(engine, spec, this.config.routes),
        state: 'installed',
      })
    }

    const runtime = this.lifecycle.getStatus(engine.id)
    return this.inventoryWatch.withFix(
      statusFrom({
        engine,
        spec,
        runtime,
        routes: this.config.routes,
        superseded: this.supersededBy(entry, runtime),
      }),
    )
  }

  /**
   * The literal call that brings a running container up to the config now in
   * force, or `undefined` when it is already on it.
   *
   * Only ever asked of something running: a stopped engine reads its current
   * config at its next start by construction, and reporting supersession for
   * one would be reporting a problem that does not exist.
   */
  private supersededBy(entry: Entry, runtime: RuntimeStatus): string | undefined {
    if (runtime.state !== 'running') {
      return undefined
    }
    const launched = this.launchedShape.get(entry.engine.id)
    if (
      launched === undefined ||
      launched === engineShape(entry.engine, entry.spec.spec, this.config.routes)
    ) {
      return undefined
    }
    return `curl -s -X POST localhost:${this.config.listen_port}/engined/v1/engines/${entry.engine.id}/stop`
  }

  /**
   * `syncStatus` for a container engine's non-running case is superseded by
   * `lifecycle.probe`, which checks image *and* artifact presence read-only
   * (never starts a container) so a never-started engine with either missing
   * reports `unavailable` on the very first `GET /engined/v1/engines` rather than
   * waiting for a start attempt to notice.
   */
  private async statusFor(entry: Entry, fresh = true): Promise<EngineStatus> {
    if (entry.engine.disabled) {
      return disabledStatus(entry, this.config.routes)
    }
    const { spec, source } = entry.spec
    if (!isContainerSpec(spec)) {
      if (spec.kind === 'agentic-cli') {
        return this.agentic.status(entry.engine, spec, fresh, this.config)
      }
      // A spec-less proxy: nothing to probe and nothing resident -- an
      // address is either configured or it is not, and syncStatus's
      // optimistic `installed` already says as much.
      return this.syncStatus(entry)
    }
    const { engine } = entry
    return this.inventoryWatch.withFix(
      statusFrom({
        engine,
        spec,
        runtime: await this.lifecycle.probe(engine.id, spec, source, engine.idle_stop_seconds),
        routes: this.config.routes,
      }),
    )
  }

  async list(): Promise<EnginesResponse> {
    const engines = await Promise.all(this.entries.map((e) => this.statusFor(e, false)))
    return {
      contract: CONTRACT,
      commit: typeof ENGINED_COMMIT === 'string' ? ENGINED_COMMIT : 'unknown',
      engines,
    }
  }

  /** Whether an id names the local llama, which is the only engine the extras routes can address. */
  isLocalLlama(id: string): boolean {
    const entry = this.byId.get(id)
    return entry !== undefined && isLocalLlama(entry.engine, entry.spec.spec.kind)
  }

  /** Endpoints a given *engine* id serves, for the door's model/endpoint mismatch check. */
  serves(id: string): string[] {
    return this.byId.get(id)?.spec.spec.serves ?? []
  }

  /** The configured engine itself — secret, base_url, args, timeouts — as distinct from `get`'s runtime status. */
  entry(id: string): EngineEntry | undefined {
    return this.byId.get(id)?.engine
  }

  /** This engine's resolved spec, for a door verb that reads something the spec ships (a comfy engine's `images_workflow`). */
  specFor(id: string): Spec | undefined {
    return this.byId.get(id)?.spec.spec
  }

  /** Sync accessor: reports the lifecycle's cached state — no image probe, no keyring lookup. */
  get(id: string): EngineStatus | undefined {
    const entry = this.byId.get(id)
    return entry ? this.syncStatus(entry) : undefined
  }

  /**
   * `model`, when given, selects which of the engine's own model-bearing
   * routes should be resident -- meaningful only for a `kind === "stt"`
   * engine today (whisper), which loads its model at container start rather
   * than through a router like llama's.
   *
   * `opts.lease` hands back a container already held for the caller's own
   * request. A caller that takes its own lease after this resolves cannot:
   * the in-flight guard stops covering the engine the moment `start` returns,
   * and the caller's continuation is a microtask later -- a competing model
   * switch running in between reads zero leases and no start in flight, and
   * stops a container under a request already admitted. Taken here, the
   * in-flight guard and the lease are one continuous interval.
   */
  async start(
    id: string,
    model?: string,
    opts?: { lease?: boolean },
  ): Promise<EngineStatus & { launched: boolean }> {
    const entry = this.byId.get(id)
    if (!entry) {
      throw new Error(`unknown engine "${id}"`)
    }
    // Listed by `GET /engined/v1/engines` and startable are different things: an
    // operator can see it is off, and starting it is still the config edit.
    if (entry.engine.disabled) {
      throw new Error(`engine "${id}" is disabled in config`)
    }
    if (!isContainerSpec(entry.spec.spec)) {
      // Nothing to warm up: a spec-less proxy or an agentic-cli engine has
      // no standing container.
      return { ...(await this.statusFor(entry)), launched: false }
    }
    this.comfy.forget(id)
    if (isLocalLlama(entry.engine, entry.spec.spec.kind)) {
      writeLocalPreset(this.presetHostPathFor(entry.engine.id), entry.engine, this.config.routes)
    }
    const spec = specForModel(entry.spec.spec, this.config.routes, id, model)
    await this.residency.stopForSwitch(id, model)
    this.residency.enter(id)
    try {
      // `launched` is the lifecycle start lock's own answer to "did this call
      // spawn it", not a pre-read snapshot -- two concurrent calls on one cold
      // engine resolve to exactly one `true`.
      const { launched } = await this.lifecycle.start(id, spec, {
        idleStopSeconds: entry.engine.idle_stop_seconds,
        readyTimeoutS: entry.engine.ready_timeout_s,
        specSource: entry.spec.source,
      })
      this.residency.started(id, model)
      this.launchedShape.set(id, engineShape(entry.engine, entry.spec.spec, this.config.routes))
      if (opts?.lease === true) {
        this.lifecycle.beginLease(id)
      }
      return { ...(await this.statusFor(entry)), launched: launched ?? false }
    } finally {
      this.residency.leave(id)
    }
  }

  /**
   * Why a per-container read cannot answer for this engine, or `undefined` if
   * it can. A spec-less proxy or an agentic-cli engine has no container, and
   * says so rather than returning an empty result that reads like a quiet one.
   */
  private containerRefusal(id: string): { error: string } | undefined {
    const entry = this.byId.get(id)
    if (!entry) {
      return { error: `unknown engine "${id}"` }
    }
    if (!isContainerSpec(entry.spec.spec)) {
      return { error: `"${id}" runs no container of its own` }
    }
    return undefined
  }

  /** `docker logs --tail` for a container-backed engine. */
  async logs(id: string, tail: number): Promise<{ lines: string[] } | { error: string }> {
    const refusal = this.containerRefusal(id)
    if (refusal) {
      return refusal
    }
    const res = await this.lifecycle.logs(id, tail)
    return res.ok ? { lines: res.lines } : { error: res.error }
  }

  /** What a running container holds. See resources.ts for why RAM alone is not the answer. */
  async resources(id: string): Promise<EngineResources | { error: string }> {
    const refusal = this.containerRefusal(id)
    if (refusal) {
      return refusal
    }
    const res = await this.lifecycle.resources(id)
    return res.ok ? res.resources : { error: res.error }
  }

  /**
   * Explicit stop, for an operator reclaiming the GPU rather than waiting out
   * the idle countdown. Stopping something already stopped is a no-op that
   * reports the same state, so a consumer never has to check first.
   */
  async stop(id: string): Promise<EngineStatus> {
    const entry = this.byId.get(id)
    if (!entry) {
      throw new Error(`unknown engine "${id}"`)
    }
    if (isContainerSpec(entry.spec.spec)) {
      this.comfy.forget(id)
      await this.lifecycle.stop(id)
    }
    return this.statusFor(entry)
  }

  /**
   * Stops this engine and keeps it stopped, so something outside this process
   * can load the same weights without racing the door for the pool. Only a
   * container engine can be held: nothing else occupies memory the holder
   * could want back.
   */
  async hold(id: string, seconds: number): Promise<EngineStatus> {
    const entry = this.byId.get(id)
    if (!entry) {
      throw new Error(`unknown engine "${id}"`)
    }
    if (!isContainerSpec(entry.spec.spec)) {
      throw new Error(`engine "${id}" runs no container, so there is nothing to hold`)
    }
    this.comfy.forget(id)
    await this.lifecycle.hold(id, seconds * MS_PER_SECOND)
    return this.statusFor(entry)
  }

  /** Ends a hold early. Idempotent, because the state the caller wants is "not held" either way. */
  unhold(id: string): Promise<EngineStatus> {
    const entry = this.byId.get(id)
    if (!entry) {
      throw new Error(`unknown engine "${id}"`)
    }
    this.lifecycle.unhold(id)
    return this.statusFor(entry)
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
    const entry = this.byId.get(id)
    if (!entry) {
      return { error: `unknown engine "${id}"` }
    }
    const { kind } = entry.spec.spec
    if (kind !== 'comfy') {
      return { error: `"${id}" (${kind}) has no release endpoint; stop it instead` }
    }
    return await releaseComfyMemory(id, this.lifecycle, this.releaseFetch)
  }

  /**
   * A reload's teardown, in the background because `reload` is synchronous.
   * A teardown that fails is reported rather than swallowed: whatever it did
   * not stop is no longer in the lifecycle's map, so `shutdown` will not
   * reach it either and this line is the only trace it outlived the reload.
   */
  private teardown(id: string): void {
    this.launchedShape.delete(id)
    this.lifecycle.removeEngine(id).catch((err: unknown) => {
      process.stderr.write(`${id}: teardown after reload failed: ${errMessage(err)}\n`)
    })
    // Only under the per-engine default path: a test override shares one
    // path across engines, and deleting its directory would take a sibling
    // engine's preset with it.
    if (this.usesDefaultPresetPath && this.isLocalLlama(id)) {
      rmSync(dirname(this.presetHostPathFor(id)), { recursive: true, force: true })
    }
  }

  /**
   * In-flight work keeps using the entries captured at call time; only new
   * lookups see the rebuilt map. An engine dropped from `config` is stopped
   * in the background rather than left orphaned; a running container whose
   * shape changed is left alone until its next start.
   */
  reload(config: Config): void {
    const newEntries = buildEntries(config, this.specOptions, this.presetHostPathFor)
    // A newly-disabled engine is torn down like a removed one: it keeps its
    // entry so the route can report it, but nothing of it may keep running.
    const newIds = new Set(newEntries.filter((e) => !e.engine.disabled).map((e) => e.engine.id))
    for (const old of this.entries) {
      if (!newIds.has(old.engine.id)) {
        this.teardown(old.engine.id)
      }
    }
    // A second, independent pass: an engine present in BOTH configs -- the
    // id diff above only catches an add or a remove -- whose LOCAL binding
    // changed. Repointing llama's own routes away from "local" changes no
    // engine id, so nothing else would notice its container is now
    // orphaned, with nothing routed to it on this box. Never merged with
    // the id-diff pass: an engine with no routes at all (comfy, sometimes)
    // has no binding either way, so a bindings-only rule would silently
    // stop managing it while still typechecking -- exactly the failure
    // class this delivery removes elsewhere.
    for (const old of this.entries) {
      if (!newIds.has(old.engine.id)) {
        continue
      }
      const hadLocal = hasLocalBinding(old.engine.id, this.config.routes)
      const hasLocal = hasLocalBinding(old.engine.id, config.routes)
      if (hadLocal && !hasLocal) {
        this.teardown(old.engine.id)
      }
    }
    this.config = config
    this.entries = newEntries
    this.byId = new Map(newEntries.map((e) => [e.engine.id, e]))
    this.comfy.watch(newEntries)
    this.inventoryWatch.forget()
    this.startInventoryRefresh()
  }

  async shutdown(): Promise<void> {
    this.comfy.stop()
    this.inventoryWatch.stop()
    await this.lifecycle.shutdown()
  }
}
