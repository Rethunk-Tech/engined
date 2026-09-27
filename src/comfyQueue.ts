/**
 * Comfy is the one engine whose idleness engined cannot observe, because it
 * proxies nothing for it: this polls Comfy's own `/queue` and drives the
 * lifecycle's existing lease timer from what it sees, rather than from
 * request traffic engined never gets. It also owns the one other call engined
 * makes into a running comfy container, the memory release.
 */

import type { DockerLifecycle } from './docker.ts'
import type { Entry } from './engineEntries.ts'
import { CONTENT_TYPE, discardBody, JSON_CONTENT_TYPE } from './http.ts'
import { isContainerSpec } from './specTypes.ts'

/**
 * Short relative to `idle_stop_seconds` (minutes), so a job that starts is
 * noticed well before a stale deadline inherited from the last empty poll
 * could fire mid-job.
 */
export const COMFY_POLL_INTERVAL_MS = 15_000

export interface QueueSnapshot {
  queue_running: unknown[]
  queue_pending: unknown[]
}

export type QueueFetch = (url: string) => Promise<QueueSnapshot>
/** Overridable for tests; the release POST is the only other call engined makes into a running container. */
export type ReleaseFetch = (url: string, body: unknown) => Promise<{ ok: boolean; status: number }>

export async function defaultReleaseFetch(
  url: string,
  body: unknown,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  })
  // The status is the whole answer here; the body is never read, so release it.
  await discardBody(res)
  return { ok: res.ok, status: res.status }
}

export async function defaultQueueFetch(url: string): Promise<QueueSnapshot> {
  const res = await fetch(url)
  return (await res.json()) as QueueSnapshot
}

function isQueueEmpty(q: QueueSnapshot): boolean {
  return q.queue_running.length === 0 && q.queue_pending.length === 0
}

export class ComfyQueueWatch {
  private readonly lifecycle: DockerLifecycle
  private readonly queueFetch: QueueFetch
  private readonly intervalMs: number
  private timers: ReturnType<typeof setInterval>[] = []
  /**
   * Last observed `/queue` emptiness per comfy-kind engine id. The lease is
   * armed once per transition into empty, never re-armed on every poll while
   * it stays empty — re-arming on every tick would reset the countdown
   * before it ever elapsed.
   */
  private readonly lastEmpty = new Map<string, boolean>()

  constructor(lifecycle: DockerLifecycle, queueFetch: QueueFetch, intervalMs: number) {
    this.lifecycle = lifecycle
    this.queueFetch = queueFetch
    this.intervalMs = intervalMs
  }

  /** One poll timer per `comfy`-kind engine, replacing any armed before; idleness for it comes from nowhere else. */
  watch(entries: Entry[]): void {
    this.stop()
    this.timers = entries
      .filter((e) => !e.engine.disabled && e.spec.spec.kind === 'comfy')
      .map((entry) =>
        setInterval(() => {
          this.poll(entry).catch(() => undefined)
        }, this.intervalMs),
      )
  }

  /** A fresh start's first queue observation must be a real transition, not one suppressed by stale emptiness from an earlier session. */
  forget(id: string): void {
    this.lastEmpty.delete(id)
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers = []
  }

  /**
   * A transition into empty arms the same idle-stop lease every other
   * engine's request traffic arms, once; a transition into non-empty takes
   * that lease back, which is what cancels the pending stop. Not released or
   * taken on every tick: docker.ts's `endLease` resets its own countdown on
   * every call, so re-arming it every poll while the queue stays empty would
   * defer the stop forever.
   */
  private async poll(entry: Entry): Promise<void> {
    if (!isContainerSpec(entry.spec.spec)) {
      return
    }
    const { engine } = entry
    const status = this.lifecycle.getStatus(engine.id)
    if (status.state !== 'running' || status.private_url === null) {
      this.lastEmpty.delete(engine.id)
      return
    }
    let queue: QueueSnapshot
    try {
      queue = await this.queueFetch(`http://${status.private_url}/queue`)
    } catch {
      // A refused poll is the only signal engined gets that this container
      // died underneath it -- nothing else asks docker about a comfy engine
      // between starts. `reconcile` lets docker decide, so a poll that failed
      // against a container still genuinely up changes nothing here.
      const reconciled = await this.lifecycle.reconcile(engine.id)
      if (reconciled.state !== 'running') {
        this.lastEmpty.delete(engine.id)
      }
      return
    }
    const empty = isQueueEmpty(queue)
    // Unknown starts as empty: a first observation of a BUSY queue is then a
    // real transition and takes a lease, rather than leaving a working Comfy
    // counting down against the idle-stop its own start armed.
    const wasEmpty = this.lastEmpty.get(engine.id) ?? true
    this.lastEmpty.set(engine.id, empty)
    if (empty && !wasEmpty) {
      this.lifecycle.endLease(engine.id, engine.idle_stop_seconds)
    } else if (!empty && wasEmpty) {
      // The lease alone cancels the pending stop, and taking it synchronously
      // is the point: a docker round trip here is a window in which the
      // container holds neither a lease nor a countdown, and a model switch
      // landing in it stops a comfy the queue has just reported working. The
      // queue answering at all is better proof the container is up than any
      // reconcile.
      this.lifecycle.beginLease(engine.id)
    }
  }
}

/**
 * Drops a comfy engine's loaded weights without stopping it -- the operation
 * a consumer wants between phases, when the GPU is needed for something else
 * but the container's own startup is not worth paying again. ComfyUI reloads
 * its custom nodes on boot, which is the cost a stop would charge here.
 */
export async function releaseComfyMemory(
  id: string,
  lifecycle: DockerLifecycle,
  releaseFetch: ReleaseFetch,
): Promise<{ released: true } | { error: string }> {
  const status = lifecycle.getStatus(id)
  if (status.state !== 'running' || status.private_url === null) {
    // Nothing is loaded, so nothing is held -- the caller's intent is
    // already satisfied and failing here would make them special-case it.
    return { released: true }
  }
  const res = await releaseFetch(`http://${status.private_url}/free`, {
    unload_models: true,
    free_memory: true,
  })
  return res.ok ? { released: true } : { error: `${id}: release failed with HTTP ${res.status}` }
}
