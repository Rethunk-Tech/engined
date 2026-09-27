/**
 * The shapes every door handler is written against: what an installer or a
 * test may inject, the live state a handler reads, and the comfy mediation
 * table that state carries. They live here rather than in `src/main.ts`
 * because the door's verb modules are imported BY main -- a type declared
 * there could only reach them as an import cycle.
 */

import type { AgenticSpawn } from './agentic.ts'
import type { DockerLifecycle } from './docker.ts'
import type { EngineRegistry } from './engines.ts'
import type { Exec as SecretExec } from './exec.ts'
import type { HttpClient } from './http.ts'
import { LlamaRouter } from './llama.ts'
import type { RegistryOptions } from './registryOptions.ts'
import type { Config, EngineEntry } from './types.ts'
import type { UsageTracker } from './usage.ts'

export interface DoorOptions {
  agenticSpawn?: AgenticSpawn
  llamaHttpClient?: HttpClient
  extrasHttpClient?: HttpClient
  /** Defaults to the real `fetch`; a test overrides it so the comfy proxy never reaches a real container. */
  comfyHttpClient?: HttpClient
  /** Injected so a test can capture the provenance line instead of reading real stdout. */
  write?: (line: string) => void
  /** Reaches both the registry that writes the preset and the router that mounts it; a test overrides it so neither touches the real state dir. */
  llamaPresetHostPath?: string
  /** Defaults to the real `secret-tool`; a test overrides it so a remote-agentic engine's keyring lookup never runs for real. */
  secretExec?: SecretExec
  /** Defaults to the real `process.env`; a test overrides it so a planted ambient secret has somewhere deterministic to not leak from. */
  agenticAmbientEnv?: NodeJS.ProcessEnv
  /** Defaults to the real `fetch`; a test overrides it so catalog refresh never dials a provider. */
  inventoryHttpClient?: HttpClient
  /** Overrides where `src/usage.ts` persists its per-day counters; a test redirects this so nothing writes under the operator's state. */
  usageStateRoot?: string
  /** Overrides `Date.now` for `src/usage.ts`'s own day-key math; a test pins this to cross a day boundary deterministically. */
  usageNow?: () => number
}

/**
 * Everything a content handler needs, bundled so each handler stays a
 * top-level function instead of a deep closure. `getConfig` rather than a
 * captured `Config` because `reload` swaps it out from under an in-flight
 * request's later lookups.
 */
export interface DoorContext {
  getConfig: () => Config
  registry: EngineRegistry
  lifecycle: DockerLifecycle
  registryOpts: RegistryOptions
  doorOpts: DoorOptions
  llamaRouters: Map<string, LlamaRouter>
  /**
   * Engine ids whose cached router belongs to a config generation `reload`
   * has since superseded. Swapped for a fresh one lazily, on the first call
   * after its own outstanding leases drain to zero -- never mid-flight, so
   * a request that arrives after a reload but while an earlier one is still
   * reading from the container joins the SAME occupancy tracker instead of
   * getting a second one that has no idea what the first still has resident.
   */
  staleLlamaRouters: Set<string>
  /**
   * Live launch-scoped nonces: minted where an agent is launched -- this
   * door's own dispatch and the registry's round-trip probe, which shares
   * this very set -- and deleted the moment that launch returns. A request
   * naming one that is not in this set -- expired, or never minted -- is
   * refused outright, whether or not it names an agentic engine: a leaked or
   * reused URL is not a standing key.
   */
  launchNonces: Set<string>
  /** Comfy proxy mediation state, reload-durable. */
  comfyBindings: ComfyBindings
  /** One submission gate per comfy engine -- see `ComfySlots`. */
  comfySlots: ComfySlots
  /** Per-day, per-route call counters -- see `src/usage.ts`. */
  usage: UsageTracker
}

/**
 * The gate that keeps a comfy container holding at most one prompt at a time,
 * one promise chain per engine id.
 *
 * comfy's `/interrupt` stops whatever is running and carries no id to scope
 * it, so a cancel is only ever safe when nothing can inherit the GPU from the
 * prompt being cancelled. Holding submissions here is what makes that true by
 * construction: `POST /prompt` waits for the container's queue to drain before
 * it forwards, so there is never a successor queued behind the running job.
 *
 * In memory only, and deliberately: every submission re-reads the container's
 * own queue rather than trusting this map, so a door restart mid-render costs
 * one round trip and not a wrong answer. The GPU is one, so the gate is per
 * engine and not per origin.
 */
type ComfySlots = Map<string, Promise<unknown>>

/**
 * What this door has actually seen pass through a comfy engine's proxy:
 * every `prompt_id` `POST /prompt` handed back, keyed on the origin that
 * submitted it as well as the engine, and under each one the output
 * filenames a completed `/history` read surfaced for THAT prompt. `GET
 * /view` and `POST /queue` are mediated against this table rather than
 * against anything the caller merely claims -- comfy's output directory is
 * shared, so a caller-supplied filename must never become a URL on its own
 * say-so, and one engine-wide filename set would hand every origin every
 * other origin's outputs.
 */
export type ComfyBindings = Map<string, ComfyBinding>

/**
 * One bound prompt: when this door bound it, and the output filenames a
 * completed `/history` read has surfaced for it since.
 *
 * `at` is creation time and is never refreshed by a later `/history` read, so
 * age means "how long ago this prompt was submitted" and not "how recently
 * someone polled it" -- a consumer cannot hold a binding open by polling.
 */
export interface ComfyBinding {
  at: number
  filenames: string[]
}

export function getLlamaRouter(ctx: DoorContext, engine: EngineEntry): LlamaRouter {
  const cached = ctx.llamaRouters.get(engine.id)
  if (cached && (!ctx.staleLlamaRouters.has(engine.id) || cached.hasOutstandingLeases())) {
    return cached
  }
  ctx.staleLlamaRouters.delete(engine.id)
  const routes = ctx
    .getConfig()
    .routes.filter((r) => r.engine === engine.id && r.upstream === 'local')
  const router = new LlamaRouter(engine, routes, ctx.lifecycle, {
    enginesRoot: ctx.registryOpts.enginesRoot,
    bunx: ctx.registryOpts.bunx,
    idleStopSeconds: engine.idle_stop_seconds,
    readyTimeoutS: engine.ready_timeout_s,
    httpClient: ctx.doorOpts.llamaHttpClient,
    presetHostPath: ctx.doorOpts.llamaPresetHostPath,
  })
  ctx.llamaRouters.set(engine.id, router)
  return router
}
