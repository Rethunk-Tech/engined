/**
 * Proving an agentic CLI is the version its engine pins, and what to tell the
 * operator when it is not. A proof is version-specific and recorded per engine,
 * so the read-only floor a launch runs under is only claimed for the version
 * that actually answered.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { launchScopedBaseUrl } from './agentic.ts'
import type { AgentTarget } from './agents.ts'
import { localRoutesOf } from './engineEntries.ts'
import { stateDir } from './paths.ts'
import type { Config } from './types.ts'

/**
 * The read-only floor is version-specific, so a proved version is only
 * proof for that version. One file per engine, mirroring the llama
 * preset's own directory shape under the state directory.
 */
const AGENTIC_VERIFIED_DIR = (engineId: string): string => `${stateDir()}/agentic/${engineId}`
const AGENTIC_VERIFIED_PATH = (engineId: string): string =>
  `${AGENTIC_VERIFIED_DIR(engineId)}/verified_version`

export function readVerifiedVersion(engineId: string): string | undefined {
  try {
    return readFileSync(AGENTIC_VERIFIED_PATH(engineId), 'utf8').trim()
  } catch {
    // No file yet, or an unreadable one: this engine has no proved version.
  }
  return undefined
}

export function writeVerifiedVersion(engineId: string, version: string): void {
  mkdirSync(AGENTIC_VERIFIED_DIR(engineId), { recursive: true })
  writeFileSync(AGENTIC_VERIFIED_PATH(engineId), version, 'utf8')
}

export interface AgenticProbeOutcome {
  ok: boolean
  /** Which probe failed -- e.g. "byte-identical" or "no-hook-fires". Present only when `ok` is false. */
  failedProbe?: string
  /** Why that probe failed, when it can say. */
  detail?: string
}

/**
 * Runs the two probes the design names: a completion instructed to create a
 * file, worktree-hashed before and after, and a planted `UserPromptSubmit`
 * hook checked for silence. Injected rather than built in here -- each run
 * costs a real billed call to Anthropic, so wiring the real implementation
 * against a live `claude` is its own, separately-authorised task; nothing in
 * this module calls out to a subprocess.
 */
export type AgenticProbeRunner = (
  agentVersion: string,
  /** From the spec, never the engine entry: the floor is a property of the agent. */
  agent: string,
  /**
   * Where a real model-answer probe would dial, if this agent has one to
   * run and doing so is free -- `roundTripTargetFor`'s own output. Absent
   * whenever this engine's route leaves the box (claude, cursor): a round
   * trip through either is a billed call to a third party, and nothing here
   * should make a status poll pay for one. Present for opencode, whose
   * route names the `local` upstream -- its round trip runs on this box's
   * own GPU, so proving it costs nothing but time.
   */
  roundTrip?: AgentTarget,
) => Promise<AgenticProbeOutcome>

/**
 * The one route on `engineId` that both names a model and keeps its prompt
 * on this box -- what a real round-trip probe would dial, or `undefined`
 * when no such route exists (a remote-only agent, or one with no route at
 * all). `local` is the same egress this box's own opencode route already
 * uses to say "does not leave the machine" -- reused here rather than
 * re-deriving egress from `[[upstream]]`, since a modelless engine or a
 * remote-upstream route has nothing this probe could answer for free anyway.
 */
export function roundTripTargetFor(
  engineId: string,
  config: Config,
  nonce: string,
): AgentTarget | undefined {
  const route = localRoutesOf(config.routes, engineId).find(
    (r) => !r.disabled && r.model !== undefined,
  )
  if (route?.model === undefined) {
    return undefined
  }
  // `wire_model` first, for the same reason the real launch dials it: this
  // route's own segment names the agent, so handing it back points the child
  // at itself rather than at a model that answers.
  return {
    // The launch-scoped surface, exactly as a caller's own agentic dispatch
    // gets: a probe spawns a real agent, so the hop that reaches back here
    // has to be bounded by the same nonce or the recursion control has a
    // hole shaped like a status poll.
    baseUrl: launchScopedBaseUrl(config.listen_port, nonce),
    model: route.wire_model ?? route.model,
  }
}

export function noAgentVersionConfiguredFix(engineId: string): string {
  return `engine "${engineId}" is agentic-cli with no agent_version configured`
}

/** The binary itself could not be identified at all -- `resolveBinary` threw, or `--version` printed nothing. Distinct from a version mismatch: there is no "observed" version to compare here. */
export function agentBinaryUnresolvedFix(engineId: string, reason: string): string {
  return `engine "${engineId}" agent binary could not be resolved: ${reason}`
}

/**
 * `proved` is `readVerifiedVersion`'s own return -- `undefined` for an
 * engine that has never passed a probe at all, some other string for one
 * whose binary has since drifted out from under it (a self-update, for an
 * agent with no pin mechanism of its own). Both name `observed`, the
 * version any fresh probe run would actually be proving; only the drifted
 * case also names what the stale proof was for, since that is the fact an
 * operator needs to understand *why* a box that worked yesterday stopped.
 */
export function noProbeRunnerConfiguredFix(
  engineId: string,
  observed: string,
  proved: string | undefined,
): string {
  if (proved === undefined) {
    return `engine "${engineId}" pin ${observed} has not been proved and no agentic probe runner is configured`
  }
  return `engine "${engineId}" binary reports version ${observed}, but its read-only floor was last proved for ${proved} -- a self-updated binary invalidates that proof, and no agentic probe runner is configured to re-prove it`
}

export function probeFailedFix({
  engineId,
  observed,
  proved,
  failedProbe,
  detail,
}: {
  engineId: string
  observed: string
  proved: string | undefined
  failedProbe: string
  detail: string | undefined
}): string {
  const why = detail === undefined ? '' : `: ${detail}`
  if (proved === undefined) {
    return `engine "${engineId}" pin ${observed} failed the "${failedProbe}" probe${why}`
  }
  return `engine "${engineId}" binary reports version ${observed}, but its read-only floor was last proved for ${proved} -- re-proving for ${observed} failed the "${failedProbe}" probe${why}`
}
