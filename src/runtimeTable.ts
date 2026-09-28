/**
 * What this process believes about each managed container: its state, port,
 * leases, idle countdown and hold. Every state write goes through
 * `transition`, so a change is announced however it was reached.
 */

import type { Result } from './dockerCommands.ts'
import type { EngineState } from './types.ts'

export interface RuntimeStatus {
  state: EngineState
  private_url: string | null
  fix?: string
  last_error?: string
  /** Requests holding this engine open right now. Absent unless it is running. */
  active_leases?: number
  /**
   * Set only by `start()`: whether this call is the one that ran `doStart`,
   * as opposed to finding the container already running or joining another
   * caller's in-flight start. Absent from every other return of this type
   * (`reconcile`, `stop`, `getStatus`) -- there is nothing for them to answer.
   */
  launched?: boolean
  /**
   * Set only on the one return whose call adopted a container an unclean exit
   * left running. The caller alone knows which config the spec it passed came
   * from, and that config is what the adopted container is proven to run.
   */
  adopted?: boolean
}

export interface Runtime {
  id: string
  containerName: string
  state: EngineState
  hostPort: number | null
  fix?: string
  lastError?: string
  startPromise: Promise<RuntimeStatus> | null
  idleTimer: ReturnType<typeof setTimeout> | null
  imageCheck: Promise<Result<{ containerPort: number }>> | null
  artifactCheck: Promise<Result> | null
  /** Reset on every fresh `endLease`; counts retries within one continuous idle-stop attempt sequence. */
  idleStopAttempts: number
  /** Requests holding this container open. Idle-stop is armed only at zero, so a start with no traffic behind it still counts down. */
  activeLeases: number
  /**
   * Whether this process has already asked docker about a container holding
   * this name that it did not start. Only an unclean exit can leave one, so
   * the question has exactly one true answer per process -- once engined has
   * started or stopped this container itself, the map is the truth and the
   * docker round trip on every poll would buy nothing.
   */
  adoptChecked: boolean
  /**
   * Epoch ms until which something outside this process wants this engine
   * down. The local test tier takes one before it loads llama or comfy itself,
   * because two copies of either is what this box has no room for.
   */
  heldUntil?: number
}

export class RuntimeTable {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly namePrefix: string
  private onStateChange: (id: string) => void = () => undefined

  constructor(namePrefix: string) {
    this.namePrefix = namePrefix
  }

  onChange(listener: (id: string) => void): void {
    this.onStateChange = listener
  }

  /**
   * The only place `state` is assigned. A write of the same value is not a
   * change, and every assignment routes through here so a state reached by a
   * path added later is announced without that path remembering to say so.
   */
  transition(rt: Runtime, state: EngineState): void {
    if (rt.state === state) {
      return
    }
    rt.state = state
    this.onStateChange(rt.id)
  }

  get(id: string): Runtime | undefined {
    return this.runtimes.get(id)
  }

  /** The record for `id`, created in its resting state the first time it is asked for. */
  runtime(id: string): Runtime {
    let rt = this.runtimes.get(id)
    if (!rt) {
      rt = {
        id,
        containerName: `${this.namePrefix}${id}`,
        state: 'installed',
        hostPort: null,
        startPromise: null,
        idleTimer: null,
        imageCheck: null,
        artifactCheck: null,
        idleStopAttempts: 0,
        activeLeases: 0,
        adoptChecked: false,
      }
      this.runtimes.set(id, rt)
    }
    return rt
  }

  delete(id: string): void {
    this.runtimes.delete(id)
  }

  all(): Runtime[] {
    return [...this.runtimes.values()]
  }

  status(id: string): RuntimeStatus {
    const rt = this.runtimes.get(id)
    if (!rt) {
      return { state: 'installed', private_url: null }
    }
    return {
      state: rt.state,
      private_url:
        rt.state === 'running' && rt.hostPort !== null ? `127.0.0.1:${rt.hostPort}` : null,
      fix: rt.fix,
      last_error: rt.lastError,
      active_leases: rt.state === 'running' ? rt.activeLeases : undefined,
    }
  }

  cancelIdle(rt: Runtime): void {
    if (rt.idleTimer !== null) {
      clearTimeout(rt.idleTimer)
      rt.idleTimer = null
    }
  }

  /**
   * Everything that stops being true the moment the container is no longer
   * serving: the countdown, the state, the port and the leases. Shared by
   * every path that learns the container is gone, so one of them can never
   * again drop a lease the others reset -- a survivor pins the engine's GPU
   * for the life of the process, because `refreshIdle` refuses to arm while
   * a lease is held and nothing else re-arms it.
   */
  markStopped(rt: Runtime): void {
    this.cancelIdle(rt)
    this.transition(rt, 'installed')
    rt.hostPort = null
    rt.activeLeases = 0
  }

  /**
   * Refuses to keep an engine down forever. A holder that dies mid-run would
   * otherwise wedge the engine for the life of the process, and the caller
   * that most wants a hold is a test run, which is exactly the caller most
   * likely to die. Re-holding extends, so a long run refreshes rather than
   * asking for an open-ended one up front.
   */
  heldMsFor(id: string): number {
    const until = this.runtimes.get(id)?.heldUntil
    return until === undefined ? 0 : Math.max(0, until - Date.now())
  }

  /**
   * `runtime`, not a `get`: an engine that has never started has no entry
   * yet, and holding one down before its first start is exactly the case a
   * second process asking for the pool is in.
   */
  holdFor(id: string, ttlMs: number): void {
    this.runtime(id).heldUntil = Date.now() + ttlMs
  }

  /** Ends a hold early. Idempotent: releasing one that has already expired is the state the caller wanted. */
  unhold(id: string): void {
    const rt = this.runtimes.get(id)
    if (rt) {
      rt.heldUntil = undefined
    }
  }
}
