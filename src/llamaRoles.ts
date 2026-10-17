/**
 * Per-role occupancy for the llama router: one resident GGUF per role, the
 * queue of requests waiting on a different one, and the pump that admits
 * them in arrival order. Talks to llama-server only through the `swap` it is
 * handed, so the scheduling rule reads apart from the HTTP it drives.
 */

import type { RoleContention } from './responses.ts'
import type { Role } from './types.ts'

interface RoleWaiter {
  modelId: string
  /** `true` when this waiter's own grant is the one that swapped the resident. */
  resolve: (swapped: boolean) => void
  reject: (err: unknown) => void
}

interface RoleState {
  activeModelId: string | null
  activeCount: number
  /**
   * The door's own admission ceiling while `activeModelId` is resident:
   * `capacityFor`'s reading of that model's merged `parallel`, kept here
   * as a real number rather than re-read from the loose args record at
   * every admission check. Recomputed each time `activeModelId` changes,
   * since a swap can move a role onto a differently-configured model.
   * `Infinity` until the first model loads, since nothing is in flight to
   * admit against before there is a resident model to read a `parallel` off.
   */
  capacity: number
  queue: RoleWaiter[]
  pumping: boolean
  /** Its resident model is being unloaded to make room for another role; no lease may be granted meanwhile. */
  evicting: boolean
  /** A slot-less load is in flight: the slot is spoken for before `activeModelId` names it. */
  claiming: boolean
  /** Monotonic tick of the last grant or release, for least-recently-used eviction. */
  lastUsed: number
}

export interface RoleSchedulerDeps {
  /** Unloads `from` (when a model is resident) and loads `to`, resolving once `to` can serve. */
  swap: (from: string | null, to: string) => Promise<void>
  /** The admission ceiling while `modelId` is resident for `role`. */
  capacityFor: (role: Role, modelId: string) => number
  /** The model `keep_resident` pins this role back to once it drains, if any. */
  pinnedModel: (role: Role) => string | undefined
  /** How many models may be resident at once across all roles (`models_max`). */
  slots: number
}

/**
 * Each role runs its own lane (queue, pump, one resident GGUF); the lanes
 * share a budget of `slots` resident models. A role holds a slot exactly while
 * `activeModelId !== null`. A role with none takes a free slot, else evicts
 * the least recently used idle role, else waits in `slotWaiters` (FIFO, so a
 * starved role is never overtaken). A role never evicts one with leases in
 * flight, and `rewarmPinned` never evicts. With `slots` at least the number of
 * roles in use, a slot-less role always finds one free and lanes are independent.
 */
export class RoleScheduler {
  private readonly roleStates = new Map<Role, RoleState>()
  private readonly slotWaiters: Role[] = []
  private tick = 0
  private readonly deps: RoleSchedulerDeps

  constructor(deps: RoleSchedulerDeps) {
    this.deps = deps
  }

  /**
   * The model id currently resident for `role`, or `null` if none is —
   * occupancy is per role, so a caller asking "the" resident model without
   * naming one is asking the wrong question. Read-only: unlike `roleState`,
   * this never creates an entry for a role nothing has touched yet.
   */
  residentModel(role: Role): string | null {
    return this.roleStates.get(role)?.activeModelId ?? null
  }

  /**
   * Every role currently doing something, for the door's own status report.
   * Read-only in the same sense as `residentModel`: it never creates a role
   * state, and it takes no lease -- a status read must not queue behind the
   * traffic it is describing.
   */
  contention(): RoleContention[] {
    const busy: RoleContention[] = []
    for (const [role, state] of this.roleStates) {
      if (state.activeCount > 0 || state.queue.length > 0) {
        const row: RoleContention = {
          role,
          active: state.activeCount,
          waiting: state.queue.length,
        }
        if (state.activeCount > 0) {
          if (state.activeModelId !== null) {
            row.model = state.activeModelId
          }
        } else {
          const head = state.queue[0]
          if (head !== undefined) {
            row.model = head.modelId
          }
        }
        busy.push(row)
      }
    }
    return busy
  }

  /** Whether a request for `modelId` would be admitted without waiting behind a swap. */
  isResident(role: Role, modelId: string): boolean {
    const state = this.roleState(role)
    return state.queue.length === 0 && state.activeModelId === modelId
  }

  /**
   * A fresh child holds nothing, so no role has a resident model or a known
   * capacity any more. `activeCount` is not the child's state though: it
   * counts leases callers are still holding and will each release exactly
   * once, and a retried upstream fetch reaches a restart with those leases
   * live. Zeroing it lets the pump swap out from under them and admits a
   * second full set of requests onto the same llama.cpp slots.
   */
  forgetResidents(): void {
    for (const state of this.roleStates.values()) {
      state.activeModelId = null
      state.capacity = Number.POSITIVE_INFINITY
    }
    for (const role of [...this.slotWaiters]) {
      this.runPump(role)
    }
  }

  private occupied(): number {
    let n = 0
    for (const s of this.roleStates.values()) {
      if (s.activeModelId !== null || s.claiming) {
        n += 1
      }
    }
    return n
  }

  /** The idle slot holder to unload, least recently used first; never one mid-request, mid-pump or already leaving. */
  private pickVictim(except: Role): Role | undefined {
    let best: Role | undefined
    let bestTick = Number.POSITIVE_INFINITY
    for (const [role, s] of this.roleStates) {
      if (
        role !== except &&
        s.activeModelId !== null &&
        s.activeCount === 0 &&
        !s.pumping &&
        !s.evicting &&
        s.lastUsed < bestTick
      ) {
        best = role
        bestTick = s.lastUsed
      }
    }
    return best
  }

  private leaveSlotQueue(role: Role): void {
    const i = this.slotWaiters.indexOf(role)
    if (i !== -1) {
      this.slotWaiters.splice(i, 1)
    }
  }

  /** A slot may have freed: give the longest-waiting slot-less role its turn. */
  private wakeSlotWaiter(): void {
    const [head] = this.slotWaiters
    if (head !== undefined) {
      this.runPump(head)
    }
  }

  private roleState(role: Role): RoleState {
    let state = this.roleStates.get(role)
    if (!state) {
      state = {
        activeModelId: null,
        activeCount: 0,
        capacity: Number.POSITIVE_INFINITY,
        queue: [],
        pumping: false,
        evicting: false,
        claiming: false,
        lastUsed: 0,
      }
      this.roleStates.set(role, state)
    }
    return state
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
   * from here is parked inside a `swap` from `admitAfterSwap` or `rewarmPinned` -- both of
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
  acquire(role: Role, modelId: string, signal?: AbortSignal | null): Promise<boolean> {
    const state = this.roleState(role)
    return new Promise<boolean>((resolve, reject) => {
      if (
        !(state.pumping || state.evicting) &&
        state.queue.length === 0 &&
        state.activeModelId === modelId &&
        state.activeCount < state.capacity
      ) {
        state.activeCount += 1
        state.lastUsed = ++this.tick
        resolve(false)
        return
      }
      let onAbort: (() => void) | undefined
      const cleanup = () => {
        if (onAbort) {
          signal?.removeEventListener('abort', onAbort)
        }
      }
      const waiter: RoleWaiter = {
        modelId,
        resolve: (swapped) => {
          cleanup()
          resolve(swapped)
        },
        reject: (err) => {
          cleanup()
          reject(err)
        },
      }
      state.queue.push(waiter)
      if (signal) {
        onAbort = () => {
          const idx = state.queue.indexOf(waiter)
          if (idx === -1) {
            return
          }
          state.queue.splice(idx, 1)
          if (state.queue.length === 0 && state.activeModelId === null) {
            this.leaveSlotQueue(role)
            this.wakeSlotWaiter()
          }
          waiter.reject(signal.reason ?? new Error('lease request aborted while queued'))
        }
        if (signal.aborted) {
          onAbort()
          return
        }
        signal.addEventListener('abort', onAbort, { once: true })
      }
      this.runPump(role)
    })
  }

  release(role: Role): void {
    const state = this.roleState(role)
    state.activeCount = Math.max(0, state.activeCount - 1)
    state.lastUsed = ++this.tick
    this.runPump(role)
  }

  /**
   * Reloads what `keep_resident` asked this role to hold, once the role has
   * drained. True when it swapped, so the pump knows to look at the queue
   * again. A failed re-warm is nobody's request to fail: it is dropped and the
   * next release retries.
   */
  private async rewarmPinned(role: Role, state: RoleState): Promise<boolean> {
    const pinned = this.deps.pinnedModel(role)
    if (pinned === undefined || state.activeCount > 0 || state.activeModelId === pinned) {
      return false
    }
    const needsSlot = state.activeModelId === null
    if (needsSlot && (this.occupied() >= this.deps.slots || this.slotWaiters.length > 0)) {
      return false
    }
    state.claiming = needsSlot
    try {
      await this.deps.swap(state.activeModelId, pinned)
    } catch {
      return false
    } finally {
      state.claiming = false
    }
    state.activeModelId = pinned
    state.capacity = this.deps.capacityFor(role, pinned)
    return true
  }

  /** `pump` itself never rejects -- a failed swap is routed to its waiter's own `reject` -- so a catch here only guards a bug in pump. */
  private runPump(role: Role): void {
    this.pump(role).catch((_err: unknown) => {
      // pump() never rejects by design; nothing to do beyond not crashing.
    })
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
    const state = this.roleState(role)
    if (state.pumping || state.evicting) {
      return
    }
    state.pumping = true
    try {
      for (;;) {
        const [front] = state.queue
        if (!front) {
          // Re-check the queue after a re-warm rather than returning: a request
          // arriving during the swap queues behind a pump that is already
          // running, and would otherwise never be woken.
          if (await this.rewarmPinned(role, state)) {
            continue
          }
          this.leaveSlotQueue(role)
          return
        }
        if (state.activeModelId === front.modelId) {
          if (state.activeCount >= state.capacity) {
            // At the door, not the queue: the front waiter stays put and the
            // next `release` re-runs the pump, exactly as a swap stalls
            // on `activeCount > 0` below.
            return
          }
          state.queue.shift()
          state.activeCount += 1
          state.lastUsed = ++this.tick
          front.resolve(false)
          continue
        }
        if (state.activeCount > 0) {
          return
        }
        const grant = this.claimSlot(role, state)
        if (grant === 'wait') {
          return
        }
        const victimRole = grant.victim
        state.queue.shift()
        await this.admitAfterSwap(role, state, front, victimRole && this.roleState(victimRole))
        if (victimRole !== undefined) {
          this.runPump(victimRole)
        }
      }
    } finally {
      state.pumping = false
      // A drained role is only a victim once its pump has stopped, so the
      // wake that matters comes here rather than at `release`.
      if (state.activeCount === 0 && this.slotWaiters[0] !== role) {
        this.wakeSlotWaiter()
      }
    }
  }

  /**
   * Decides whether a role about to load may do so: a role already holding a
   * slot always may, a slot-less one needs a free slot or an idle victim and
   * must not overtake an earlier slot-waiter. `wait` has queued the role.
   */
  private claimSlot(role: Role, state: RoleState): 'wait' | { victim?: Role } {
    if (state.activeModelId !== null) {
      return {}
    }
    const [head] = this.slotWaiters
    const full = this.occupied() >= this.deps.slots
    const victim = full ? this.pickVictim(role) : undefined
    if ((head !== undefined && head !== role) || (full && victim === undefined)) {
      if (!this.slotWaiters.includes(role)) {
        this.slotWaiters.push(role)
      }
      return 'wait'
    }
    this.leaveSlotQueue(role)
    return { victim }
  }

  /**
   * Swaps the resident to `front`'s GGUF and grants it the first slot; a failed
   * swap rejects only `front`. With a `victim`, the swap unloads that idle
   * role's model instead and the slot changes hands. The victim is forgotten
   * even on failure: the unload may have happened, and a later request simply
   * reloads it rather than trust a resident that may be gone.
   */
  private async admitAfterSwap(
    role: Role,
    state: RoleState,
    front: RoleWaiter,
    victim?: RoleState,
  ): Promise<void> {
    const from = victim ? victim.activeModelId : state.activeModelId
    state.claiming = state.activeModelId === null
    if (victim) {
      victim.evicting = true
    }
    try {
      await this.deps.swap(from, front.modelId)
    } catch (err) {
      front.reject(err)
      return
    } finally {
      state.claiming = false
      if (victim) {
        victim.activeModelId = null
        victim.capacity = Number.POSITIVE_INFINITY
        victim.evicting = false
      }
    }
    state.activeModelId = front.modelId
    state.capacity = this.deps.capacityFor(role, front.modelId)
    state.activeCount += 1
    state.lastUsed = ++this.tick
    front.resolve(true)
  }
}
