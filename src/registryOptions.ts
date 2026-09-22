/** What an `EngineRegistry` is built with; everything past the engines root is injectable for tests. */

import type { ObservedVersion } from './agentic.ts'
import type { AgenticProbeRunner } from './agenticProbe.ts'
import type { QueueFetch, ReleaseFetch } from './comfyQueue.ts'
import type { DockerLifecycle, Probe } from './docker.ts'
import type { Exec } from './exec.ts'
import type { Inventory } from './inventory.ts'

export interface RegistryOptions {
  /** Root of the shipped `engines/` directory, passed straight through to `loadSpec`. */
  enginesRoot: string
  bunx: string
  /** Injected together so the image probe below agrees with a test's fake lifecycle. */
  exec?: Exec
  probe?: Probe
  lifecycle?: DockerLifecycle
  /** Overridable for tests: a fast interval against a fake `/queue` response. */
  queueFetch?: QueueFetch
  releaseFetch?: ReleaseFetch
  comfyPollIntervalMs?: number
  /** Absent by default: an agentic-cli engine whose pin has never been proved stays `unavailable` until one is injected. */
  agenticProbeRunner?: AgenticProbeRunner
  /**
   * The door's own live launch nonces, which a round-trip probe's launch is
   * registered in for as long as it runs. `createDoor` passes the set it
   * checks requests against; a registry built without one still scopes the
   * URL it hands a probe, but nothing is listening for that nonce, so a
   * probe that calls back is refused as unknown.
   */
  launchNonces?: Set<string>
  /**
   * Overridable for tests: what `agenticStatus` treats as an agent's actual
   * running version, checked against the proved one on every status poll.
   * Defaults to `observeAgentVersion` (agentic.ts), which is a real
   * subprocess call only for an agent that resolves its own binary (cursor)
   * -- an npm-pinned agent (claude, opencode) never spawns anything here,
   * since its `bunx` pin already IS the observed version.
   */
  observeAgentVersion?: (agent: string, configuredVersion: string) => Promise<ObservedVersion>
  /** Defaults under the one writable state dir; tests always override this. Must be the same path the door hands `LlamaRouter`, since one writes the file the other mounts. */
  presetHostPath?: string
  /** Provider catalog cache. Tests pass a pre-filled instance; production builds one in `createDoor`. */
  inventory?: Inventory
}
