import { realpathSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { type AgenticSpawn, defaultAgenticSpawn } from './agentic.ts'
import { agentCli } from './agents.ts'
import type { ExecResult } from './exec.ts'
import { errMessage } from './records.ts'

export interface ObservedVersion {
  ok: boolean
  /** Present only when `ok` -- what the binary itself reports. */
  version?: string
  /** Present only when `!ok` -- why nothing could be observed. */
  error?: string
}

/**
 * What an agent's binary reports RIGHT NOW, which a read-only floor proof
 * has to be checked against instead of the configured pin the moment
 * anything can update itself outside engined's control (agents.ts's
 * `resolveBinary`). An npm-pinned agent has no such gap -- `bunx` fetches
 * and pins in the same step, so its configured version already IS what
 * runs, and this returns that straight back with no process spawned at all.
 *
 * Never a model round trip: `--version` is a local, sub-second call with no
 * LLM in the loop, so `engines.ts`'s `agenticStatus` can afford to run this
 * on every status poll -- it is the (expensive, billed) probe re-run that is
 * gated on what this returns, never this itself.
 *
 * Keyed on the binary's realpath: a listing that finds the same file as last
 * time returns the last observation rather than spawning again, and a binary
 * replaced at that path (a newer mtime) drops the stale observation instead
 * of leaking it under a second key.
 */
const binaryVersionObservations = new Map<string, { mtimeMs: number; observed: ObservedVersion }>()

export async function observeAgentVersion(
  agent: string,
  configuredVersion: string,
  agenticSpawn: AgenticSpawn = defaultAgenticSpawn,
  /** Test-only: stands in for `resolveCursorBinary`/`cli.resolveBinary`, which otherwise resolve a real installed binary this door cannot fake a replacement for. */
  resolveBinary?: () => string,
): Promise<ObservedVersion> {
  const cli = agentCli(agent)
  if (cli?.resolveBinary === undefined) {
    return { ok: true, version: configuredVersion }
  }
  let binary: string
  try {
    binary = resolveBinary?.() ?? cli.resolveBinary()
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
  let resolved: string
  let mtimeMs: number
  try {
    resolved = realpathSync(binary)
    mtimeMs = statSync(resolved).mtimeMs
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
  const cached = binaryVersionObservations.get(resolved)
  if (cached !== undefined && cached.mtimeMs === mtimeMs) {
    return cached.observed
  }
  let spawned: ExecResult
  try {
    spawned = await agenticSpawn([binary, '--version'], { cwd: tmpdir(), env: {}, input: '' })
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
  const version = spawned.stdout.trim()
  if (spawned.exitCode !== 0 || version === '') {
    return { ok: false, error: `"${binary} --version" did not print a version` }
  }
  const observed: ObservedVersion = { ok: true, version }
  binaryVersionObservations.set(resolved, { mtimeMs, observed })
  return observed
}
