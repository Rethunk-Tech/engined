/**
 * The version-proof gate an agentic-cli engine's status passes through: an
 * engine whose binary has never been proved reports `unavailable` rather than
 * serving on faith. Holds the per-engine probe and version-observation caches
 * that keep a status poll from spawning an agent every time it is asked.
 */

import { realpathSync, statSync } from 'node:fs'
import { pruneAgentInstallCaches } from './agentCaches.ts'
import { mintLaunchNonce, type ObservedVersion } from './agentic.ts'
import {
  type AgenticProbeOutcome,
  type AgenticProbeRunner,
  agentBinaryUnresolvedFix,
  noAgentVersionConfiguredFix,
  noProbeRunnerConfiguredFix,
  probeFailedFix,
  readVerifiedVersion,
  roundTripTargetFor,
  writeVerifiedVersion,
} from './agenticProbe.ts'
import { resolveCursorBinary, sweepOrphanOpencodeDirs } from './agents.ts'
import { baseStatus } from './engineEntries.ts'
import { errMessage } from './records.ts'
import type { EngineStatus } from './responses.ts'
import type { AgenticSpec } from './specTypes.ts'
import type { Config, EngineEntry } from './types.ts'

export type ObserveAgentVersion = (
  agent: string,
  configuredVersion: string,
) => Promise<ObservedVersion>

function observationKey(agent: string, configuredVersion: string): string {
  if (agent !== 'cursor') {
    return configuredVersion
  }
  try {
    const binary = realpathSync(resolveCursorBinary())
    return `${binary}:${statSync(binary).mtimeMs}`
  } catch {
    return configuredVersion
  }
}

export interface AgenticGateOptions {
  runner: AgenticProbeRunner | undefined
  launchNonces: Set<string>
  observeAgentVersion: ObserveAgentVersion
}

/** The just-proved version plus every `agent_version` the current config pins. */
function keepInstallVersions(config: Config, proved: string): ReadonlySet<string> {
  const keep = new Set<string>([proved])
  for (const engine of config.engines) {
    if (engine.agent_version !== undefined && engine.agent_version !== '') {
      keep.add(engine.agent_version)
    }
  }
  return keep
}

export class AgenticGate {
  private readonly runner: AgenticProbeRunner | undefined
  private readonly launchNonces: Set<string>
  private readonly observeAgentVersion: ObserveAgentVersion
  /** Per-engine agentic-probe cache/dedupe; see `runProbe`. */
  private readonly probeState = new Map<
    string,
    { version: string; outcome?: AgenticProbeOutcome; promise?: Promise<AgenticProbeOutcome> }
  >()
  /** Last version observation per agentic engine id, and the one refresh in flight for it; see `observedVersion`. */
  private readonly versionObservations = new Map<
    string,
    { configured: string; last?: ObservedVersion; inFlight?: Promise<ObservedVersion> }
  >()

  constructor(opts: AgenticGateOptions) {
    this.runner = opts.runner
    this.launchNonces = opts.launchNonces
    this.observeAgentVersion = opts.observeAgentVersion
    sweepOrphanOpencodeDirs()
  }

  /**
   * The floor is version-scoped, so what has to match the last-proved version
   * is what the binary reports RIGHT NOW (`observeAgentVersion`), never the
   * configured pin on its own -- for an npm-pinned agent those are always
   * the same value (`bunx` fetches and pins in one step), but a self-updating
   * agent with no pin mechanism of its own (cursor) can drift away from its
   * configured pin between one status poll and the next, and a proof for a
   * binary that no longer exists is not a proof of anything running now.
   *
   * Re-verification only runs when the observed version differs from the one
   * last proved — keyed off what is actually installed rather than what
   * config says it should be. A pin that
   * FAILS is cached the same way: the failed outcome for that exact version
   * is remembered so every later poll reports it for free until the version
   * changes again, and two polls racing on the same unproved version share
   * one in-flight probe instead of each billing their own — see `runProbe`.
   */
  async status(
    engine: EngineEntry,
    spec: AgenticSpec,
    fresh: boolean,
    config: Config,
  ): Promise<EngineStatus> {
    const base = baseStatus(engine, spec, config.routes)
    const provable = await this.provableVersion(engine, spec.agent, fresh)
    if ('fix' in provable) {
      return { ...base, state: 'unavailable', fix: provable.fix }
    }
    const { version } = provable
    const proved = readVerifiedVersion(engine.id)
    if (proved === version) {
      return { ...base, state: 'installed' }
    }
    if (this.runner === undefined) {
      return {
        ...base,
        state: 'unavailable',
        fix: noProbeRunnerConfiguredFix(engine.id, version, proved),
      }
    }
    const outcome = await this.runProbe(engine, { version, agent: spec.agent }, config, this.runner)
    if (!outcome.ok) {
      return {
        ...base,
        state: 'unavailable',
        fix: probeFailedFix({
          engineId: engine.id,
          observed: version,
          proved,
          failedProbe: outcome.failedProbe ?? 'unknown',
          detail: outcome.detail,
        }),
      }
    }
    writeVerifiedVersion(engine.id, version)
    pruneAgentInstallCaches(spec.agent, keepInstallVersions(config, version))
    this.probeState.delete(engine.id)
    return { ...base, state: 'installed' }
  }

  /**
   * The version the agent's binary reports right now, or the `fix` naming
   * why nothing can be proved for it at all. Three ways to have no version
   * and one to have one, which is the whole reason this is not inline.
   */
  private async provableVersion(
    engine: EngineEntry,
    agent: string,
    fresh: boolean,
  ): Promise<{ version: string } | { fix: string }> {
    if (engine.agent_version === undefined) {
      return { fix: noAgentVersionConfiguredFix(engine.id) }
    }
    const observed = await this.observedVersion(engine.id, agent, engine.agent_version, fresh)
    if (!observed.ok) {
      return { fix: agentBinaryUnresolvedFix(engine.id, observed.error ?? 'unknown') }
    }
    return observed.version === undefined
      ? { fix: agentBinaryUnresolvedFix(engine.id, 'no version reported') }
      : { version: observed.version }
  }

  /**
   * An agent that resolves its own binary observes its version by running
   * that binary, and cursor's reaches the network on `--version` -- so the
   * worst case is a stall nothing here bounds, and it lands inside whatever
   * asked for the status.
   *
   * A launch pays it regardless: `proveAgenticPin` starts the engine before
   * every agentic call, and a version read that is anything but current
   * would let a self-updated binary run on a proof of the one it replaced.
   * A listing does not -- it reports state rather than acting on it, and
   * every consumer polls it -- so it answers from the last observation for
   * the current binary key. One observation per key is in flight at a time,
   * which is what keeps a stalled binary from accumulating a spawn per poll.
   *
   * Keyed by the binary's realpath and mtime when the agent resolves its own
   * file (cursor lives under versions/<ver>/), else by the configured pin.
   * A listing answers from the last observation for that key and does not
   * spawn again until the key changes. A launch (`fresh`) waits for an
   * in-flight observation when none has landed yet.
   */
  private observedVersion(
    engineId: string,
    agent: string,
    configuredVersion: string,
    fresh: boolean,
  ): Promise<ObservedVersion> {
    const key = observationKey(agent, configuredVersion)
    const cached = this.versionObservations.get(engineId)
    const state = cached?.configured === key ? cached : { configured: key }
    this.versionObservations.set(engineId, state)
    if (state.inFlight === undefined) {
      state.inFlight = this.observeAgentVersion(agent, configuredVersion)
        .catch((err): ObservedVersion => ({ ok: false, error: errMessage(err) }))
        .then((observed) => {
          state.last = observed
          state.inFlight = undefined
          return observed
        })
    }
    return fresh || state.last === undefined ? state.inFlight : Promise.resolve(state.last)
  }

  /**
   * One real probe per (engine, pin) in flight at a time. A pin already
   * being probed hands every caller the same promise; a pin that already
   * failed hands every caller the cached outcome with no runner call at
   * all. Keyed by version, so a pin bump — the only sanctioned way to
   * re-arm this gate — misses the cache on its own, with no separate
   * invalidation needed.
   *
   * A probe that dials a round trip spawns a real agent, so it mints a launch
   * nonce and holds it live for exactly the runner's own window, the same
   * bracket the door's dispatch keeps around a caller's launch.
   */
  private runProbe(
    engine: EngineEntry,
    { version, agent }: { version: string; agent: string },
    config: Config,
    runner: AgenticProbeRunner,
  ): Promise<AgenticProbeOutcome> {
    const cached = this.probeState.get(engine.id)
    if (cached?.version === version) {
      if (cached.promise !== undefined) {
        return cached.promise
      }
      if (cached.outcome) {
        return Promise.resolve(cached.outcome)
      }
    }
    const nonce = mintLaunchNonce()
    const roundTrip = roundTripTargetFor(engine.id, config, nonce)
    if (roundTrip !== undefined) {
      this.launchNonces.add(nonce)
    }
    const promise = runner(version, agent, roundTrip)
      .then((outcome) => {
        this.probeState.set(engine.id, {
          version,
          outcome: outcome.ok ? undefined : outcome,
        })
        return outcome
      })
      .finally(() => {
        this.launchNonces.delete(nonce)
      })
    this.probeState.set(engine.id, { version, promise })
    return promise
  }
}
