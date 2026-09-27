/**
 * Which model a container-kind engine was started for, and the guard that
 * keeps a start asking for a different one from stopping a container a
 * request already holds.
 */

import type { DockerLifecycle } from './docker.ts'
import { EngineBusyError } from './errors/engineBusy.ts'
import { FatalError } from './errors/fatal.ts'
import { routeForHop } from './routeAddress.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import type { ResolvedRoute } from './types.ts'

/** Where every container-kind engine's models_dir is bind-mounted; `filename` on a route is relative to it. */
const MODEL_MOUNT_PATH = '/models'

/**
 * The `-m <path>` pair in a stt-kind engine's own command, rewritten to name
 * one of its model-bearing routes' weights file -- the argv token that
 * differs between "@/whisper/small.en" and "@/whisper/medium.en". Whisper is
 * the only kind this ever runs for, so an absent "-m" pair here is a spec
 * that does not actually take a model file and is a startup-time mistake,
 * not a runtime one.
 */
function withModelFile(spec: RunnableContainerSpec, filename: string): RunnableContainerSpec {
  const idx = spec.command.indexOf('-m')
  if (idx === -1 || spec.command[idx + 1] === undefined) {
    throw new FatalError(
      `image "${spec.image}": no "-m <path>" pair in its command to substitute a model into`,
    )
  }
  const command = [...spec.command]
  command[idx + 1] = `${MODEL_MOUNT_PATH}/${filename}`
  return { ...spec, command }
}

/**
 * The spec a start for `model` on `id` runs: the engine's own, with a stt
 * engine's weights file swapped for the one the route names. Throws when a
 * model was asked for and no route on `id` serves it.
 */
export function specForModel(
  spec: RunnableContainerSpec,
  routes: readonly ResolvedRoute[],
  id: string,
  model: string | undefined,
): RunnableContainerSpec {
  if (model === undefined) {
    return spec
  }
  const route = routeForHop(routes, id, model)
  if (route === undefined) {
    throw new Error(`model "${model}" not found on "${id}"`)
  }
  return route.filename !== undefined && spec.kind === 'stt'
    ? withModelFile(spec, route.filename)
    : spec
}

export class ModelResidency {
  private readonly lifecycle: DockerLifecycle
  /**
   * The model each container-kind engine's own start last requested --
   * whisper's only consumer today. A container that has never been asked for
   * a specific model (started via the plain warm path) has no entry here,
   * which reads as "unknown" rather than any real model id.
   */
  private readonly resident = new Map<string, string | undefined>()
  /**
   * How many starts are inside their own container work for each engine. A
   * lease is taken by the caller only once the start has RETURNED, and the
   * last thing a start does is a status probe worth several docker round
   * trips -- a competing model switch reading leases in that window sees zero
   * and would stop the container under a request already admitted.
   */
  private readonly inFlight = new Map<string, number>()

  constructor(lifecycle: DockerLifecycle) {
    this.lifecycle = lifecycle
  }

  /**
   * Stops the running container when `model` differs from the one already
   * resident, so the `lifecycle.start` call after this recreates it rather
   * than reconciling onto the still-running old one. Refuses with
   * `EngineBusyError` instead of stopping while a request still holds the
   * container open: a warm is an optimization, and killing one in flight to
   * satisfy it is strictly worse than warming late.
   */
  async stopForSwitch(id: string, model: string | undefined): Promise<void> {
    if (model === undefined || this.resident.get(id) === model) {
      return
    }
    if ((this.inFlight.get(id) ?? 0) > 0) {
      throw new EngineBusyError(
        `engine "${id}" is starting for another request; switching to model "${model}" would stop it under a request already admitted`,
      )
    }
    const current = this.lifecycle.getStatus(id)
    if (current.state !== 'running') {
      return
    }
    if ((current.active_leases ?? 0) > 0) {
      throw new EngineBusyError(
        `engine "${id}" is serving ${current.active_leases} active request(s); switching to model "${model}" would stop them mid-flight`,
      )
    }
    await this.lifecycle.stop(id)
  }

  enter(id: string): void {
    this.inFlight.set(id, (this.inFlight.get(id) ?? 0) + 1)
  }

  /** The `finally` half of `enter`: the entry is dropped at zero rather than left holding a 0. */
  leave(id: string): void {
    const left = (this.inFlight.get(id) ?? 1) - 1
    if (left > 0) {
      this.inFlight.set(id, left)
    } else {
      this.inFlight.delete(id)
    }
  }

  started(id: string, model: string | undefined): void {
    this.resident.set(id, model)
  }
}
