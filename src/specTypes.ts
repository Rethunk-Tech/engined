/**
 * What an engine IS, as its spec declares it: the container to run or the CLI
 * to spawn, the volumes and artifacts it needs on disk, and the probe that
 * says when it is ready to answer.
 */

import type { Artifact, EngineKind, ReadyProbe, UpstreamTrait, Volume } from './types.ts'

interface SpecCommon {
  /**
   * This engine can answer a streamed request: per-chunk NDJSON frames from a
   * `tts` app, SSE from an `openai-http` server, deltas from an agent CLI's
   * streamed output format. Off unless the engine's spec says otherwise -- an
   * engine that cannot chunk and claims it can hands the caller a 502 on
   * every streamed request.
   */
  streaming: boolean
  serves: string[]
  /** Allowlist. A `--user` unit hands every child the manager's environment. */
  env: string[]
  /**
   * How this engine gets an upstream when a route names none. Required on
   * every spec: a spec-full engine has no other source of truth for its
   * trait, unlike a spec-less one, which takes it from the built-in
   * `KIND_TRAITS` table keyed by `kind` instead.
   */
  upstream: UpstreamTrait
}

export interface ContainerSpec extends SpecCommon {
  kind: Exclude<EngineKind, 'agentic-cli'>
  command: string[]
  /**
   * Absent on the built-in spec a spec-less engine takes (one declaring
   * `kind` in config, e.g. a pure `openai-http` proxy) -- it launches
   * nothing, so it has no image to declare. `isContainerSpec` is what a
   * caller checks before ever reading this.
   */
  image?: string
  obtain: 'pull' | 'build'
  devices: string[]
  group_add: string[]
  security_opt: string[]
  /**
   * Run the container under docker's own init, so it is PID 1 rather than the
   * engine's own process. Linux gives PID 1 no default signal disposition, so
   * a process that installs no SIGTERM handler simply ignores `docker stop`
   * and is SIGKILLed once the grace period expires. Measured on this box:
   * 10.19s and exit 137 without it, 0.128s and a clean exit 143 with it.
   *
   * Only for an engine whose process does not handle SIGTERM itself. Every
   * other engine here stops cleanly on its own, and wrapping those buys
   * nothing.
   */
  init: boolean
  entrypoint?: string[]
  /**
   * The comfy workflow `POST /openai/v1/images/generations` renders, as a path
   * this spec's own `{spec_dir}` resolves. Shipped with the engine because the
   * graph's wiring is what fails silently -- a mis-wired node yields a black
   * image or an error from inside comfy, never one naming the graph. Only the
   * checkpoint filenames vary by install, and those come from the route.
   */
  images_workflow?: string
  /**
   * The graph `POST /openai/v1/images/edits` renders: the same job with the
   * caller's own image encoded into the starting latent instead of an empty
   * one. A separate file rather than a branch in the other, because the two
   * differ in their wiring -- which is the half that fails silently -- and a
   * graph with a dead LoadImage node in the text-to-image path would be one
   * more thing to get wrong on every render that never uploads anything.
   */
  images_edit_workflow?: string
  volumes: Volume[]
  artifacts: Artifact[]
  ready: ReadyProbe
}

/**
 * The second dialect, and a short one. Nothing is mounted, so `{spec_dir}` does
 * not apply and there is no bind-mount for a `spec_dir` override to swap.
 */
export interface AgenticSpec extends SpecCommon {
  kind: 'agentic-cli'
  /** Which agent CLI this launches; `agents.ts` holds everything that differs between them. */
  agent: string
}

export type Spec = ContainerSpec | AgenticSpec

/** A `ContainerSpec` that can actually be run: `image` is the one field a spec-less engine's built-in spec omits, and `isContainerSpec` is the only way to reach this type. */
export type RunnableContainerSpec = ContainerSpec & { image: string }

/**
 * A declared `image`, not `kind !== "agentic-cli"`: a spec-less engine's
 * built-in spec is container-SHAPED (its `kind` is e.g. `"openai-http"`) but
 * launches nothing, so it must not read as a container here -- otherwise
 * starting it would `docker run` a proxy with no image. Every caller that
 * narrows through this gets `RunnableContainerSpec` for free, so `docker.ts`
 * never has to re-assert what this already proved.
 */
export function isContainerSpec(s: Spec): s is RunnableContainerSpec {
  return s.kind !== 'agentic-cli' && s.image !== undefined
}

/** A spec paired with where it was read from, because status reports which won. */
export interface LoadedSpec {
  spec: Spec
  /** The directory it was built from — shipped, or a `spec_dir` override. */
  source: string
}
