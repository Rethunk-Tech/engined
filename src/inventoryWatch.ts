/**
 * The refresh timers behind every wildcard route's provider catalog, and the
 * last fetch failure per engine that an in-age cache is still being served
 * over, so the engine's status can name it.
 */

import { DEFAULT_INVENTORY_REFRESH_SECONDS } from './configParse.ts'
import type { Inventory } from './inventory.ts'
import { MS_PER_SECOND } from './records.ts'
import type { EngineStatus } from './responses.ts'
import { WILDCARD_MODEL } from './routeAddress.ts'
import type { Config, Upstream } from './types.ts'

export class InventoryWatch {
  readonly inventory: Inventory
  private timers: ReturnType<typeof setInterval>[] = []
  /** Last failed catalog fetch per engine, while an in-age cache is still served. */
  private readonly fetchErrors = new Map<string, string>()

  constructor(inventory: Inventory) {
    this.inventory = inventory
  }

  /** How many catalog refresh intervals are armed. Tests the clear-and-restart, not a live signal. */
  count(): number {
    return this.timers.length
  }

  /**
   * Arm catalog timers and kick a fetch without waiting for it. Listen must
   * not sit on the provider; the first menu after boot may still be empty.
   */
  start(config: Config): void {
    this.stop()
    const upstreams = wildcardUpstreams(config)
    this.timers = upstreams.map((u) =>
      setInterval(
        () => {
          this.refreshOne(config, u).catch(() => undefined)
        },
        (u.inventory_refresh_seconds ?? DEFAULT_INVENTORY_REFRESH_SECONDS) * MS_PER_SECOND,
      ),
    )
    for (const u of upstreams) {
      this.refreshOne(config, u).catch(() => undefined)
    }
  }

  stop(): void {
    for (const timer of this.timers) {
      clearInterval(timer)
    }
    this.timers = []
  }

  /** Drops the cached catalog of every upstream whose entry changed or disappeared; an untouched upstream keeps its own. */
  forget(changedUpstreamIds: ReadonlySet<string>): void {
    if (changedUpstreamIds.size === 0) {
      return
    }
    this.inventory.forget(changedUpstreamIds)
    this.fetchErrors.clear()
  }

  /** The status with the engine's last catalog fetch failure as its `fix`, unless it already has one. */
  withFix(status: EngineStatus): EngineStatus {
    if (status.fix !== undefined) {
      return status
    }
    const fetchError = this.fetchErrors.get(status.id)
    return fetchError === undefined ? status : { ...status, fix: fetchError }
  }

  private async refreshOne(config: Config, upstream: Upstream): Promise<void> {
    const result = await this.inventory.refresh(upstream)
    const engines = new Set(
      config.routes
        .filter((r) => !r.disabled && r.model === WILDCARD_MODEL && r.upstream === upstream.id)
        .map((r) => r.engine),
    )
    for (const id of engines) {
      if (result.fetchError === undefined) {
        this.fetchErrors.delete(id)
      } else {
        this.fetchErrors.set(id, result.fetchError)
      }
    }
  }
}

function wildcardUpstreams(config: Config): Upstream[] {
  const ids = new Set(
    config.routes
      .filter((r) => !r.disabled && r.model === WILDCARD_MODEL && r.upstream !== null)
      .map((r) => r.upstream as string),
  )
  return config.upstreams.filter((u) => ids.has(u.id))
}
