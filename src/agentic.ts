/**
 * Launches an agent CLI with writing structurally disabled, always. Because
 * nothing under that floor can write, there is no workdir allowlist, no
 * snapshot and no undo: the agent returns content and the caller decides
 * whether to write it. `workdir` must be an existing directory where engined
 * runs, but is not a boundary on what the agent can read.
 *
 * WHERE the floor comes from is per-agent, and `agents.ts` says which. claude
 * honours it as argv, and `assertNoForbiddenFlags` stops a config unsaying it.
 * opencode offers no such flag, so its floor is `sandbox.ts`'s mount table --
 * measured, its config-level floor is overridable from any ancestor of the
 * workdir. An agent whose floor is the sandbox never launches without it:
 * a missing `bwrap` refuses the call rather than running loose.
 *
 * Failure lives in what the agent printed, never in its exit code. Verified:
 * `claude -p --output-format json` exited 0 with `"subtype": "success"` and a
 * non-empty result while simultaneously carrying `is_error: true`,
 * `terminal_reason: "api_error"` and a body reading "Not logged in". Only the
 * agent's own parser decides success.
 */

import { mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import process from 'node:process'
import {
  type AgentCli,
  type AgenticOutcome,
  type AgentTarget,
  agentCli,
  agentDelta,
  resolveCursorBinary,
} from './agents.ts'
import type { ExecResult } from './exec.ts'
import { STATUS_BAD_GATEWAY, STATUS_BAD_REQUEST, STATUS_OK, STATUS_UNAVAILABLE } from './http.ts'
import { stateDir } from './paths.ts'
import type { Usage } from './provenance.ts'
import { resolveBwrap, sandboxArgv, sandboxEnv, sandboxHome } from './sandbox.ts'
import { argvFromArgs, errMessage } from './types.ts'

const STDERR_TAIL_CHARS = 300

/** Whitespace-collapsed last few hundred characters: enough to name the fault, bounded so a fix line stays a line. */
function stderrTail(stderr: string): string | undefined {
  const flat = stderr.replace(/\s+/g, ' ').trim()
  return flat === '' ? undefined : flat.slice(-STDERR_TAIL_CHARS)
}

/**
 * `--strict-mcp-config` closes the MCP door only against a config that
 * exists; a bare flag with nothing to point at closes nothing. One shared
 * file for every agentic launch — the closure is engine-independent, so
 * there is nothing per-engine to render.
 */
function mcpEmptyConfigPath(): string {
  return `${stateDir()}/agentic-mcp-empty.json`
}

/** Rendered fresh before every launch so the flag always names a file that exists. */
export function renderEmptyMcpConfig(): string {
  const path = mcpEmptyConfigPath()
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(path, JSON.stringify({ mcpServers: {} }), 'utf8')
  return path
}

/**
 * A launch's single-use nonce: `crypto.randomUUID()` with its dashes stripped
 * -- 32 lowercase hex characters, the shape `main.ts`'s launch-scoped route
 * matches. Every agentic launch hands its child `/openai/v1/<nonce>/...`
 * rather than the plain surface, so a hop resolving back to an agentic engine
 * is refused instead of launching a further child. It lives here rather than
 * at either call site because there are two -- a caller's own dispatch and
 * the registry's round-trip probe -- and a launch minting nothing would be
 * handed the unscoped door.
 */
export function mintLaunchNonce(): string {
  return crypto.randomUUID().replace(/-/g, '')
}

interface AgenticSpawnOptions {
  cwd: string
  env: Record<string, string>
  input: string
  /**
   * `runOneHop`'s per-hop timeout, or a caller giving up early. Killed on
   * the whole process GROUP, never just the returned pid -- confirmed live
   * against this box's real `bunx`: it spawns the actual `claude` binary as
   * its own child, not an exec-replacement (a different pid), and a SIGKILL
   * aimed at only the wrapper's pid leaves that child running, orphaned, with
   * no pid left to reach it through afterward. SIGTERM alone happened to get
   * forwarded cooperatively in that same test, but nothing guarantees a
   * future bunx version keeps doing that, so the group is signalled either
   * way. `detached: true` below is what makes `-child.pid` a valid target: it
   * gives the child its own process group whose pgid equals its pid.
   */
  signal?: AbortSignal
  /** Each stdout chunk as it arrives, ahead of the buffered whole the promise resolves with. */
  onStdout?: (chunk: string) => void
}

export type AgenticSpawn = (argv: string[], opts: AgenticSpawnOptions) => Promise<ExecResult>

/** Graceful-then-forceful: real work (writes, network calls) gets a chance to unwind before the group is SIGKILLed out from under it. */
const KILL_GRACE_MS = 3000

export async function defaultAgenticSpawn(
  argv: string[],
  opts: AgenticSpawnOptions,
): Promise<ExecResult> {
  if (argv.length === 0) {
    throw new Error('agentic launch argv is empty')
  }
  const child = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  let killTimer: ReturnType<typeof setTimeout> | undefined

  function killGroup(sig: NodeJS.Signals): void {
    try {
      process.kill(-child.pid, sig)
    } catch {
      // Already gone -- nothing left to signal.
    }
  }

  function onAbort(): void {
    killGroup('SIGTERM')
    killTimer = setTimeout(() => killGroup('SIGKILL'), KILL_GRACE_MS)
  }

  if (opts.signal?.aborted) {
    onAbort()
  } else {
    opts.signal?.addEventListener('abort', onAbort)
  }
  child.stdin.write(opts.input)
  child.stdin.end()
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      teeText(child.stdout, opts.onStdout),
      new Response(child.stderr).text(),
      child.exited,
    ])
    // Killed by our own abort: rejecting (rather than resolving with
    // whatever partial stdout it managed) is what lets runOneHop's own
    // catch block -- which checks `controller.signal.aborted` -- record
    // this as "timeout" instead of an ordinary envelope failure, the same
    // distinction the openai-http path's aborted fetch() already gets.
    if (opts.signal?.aborted) {
      throw new Error('agentic launch aborted')
    }
    return { stdout, stderr, exitCode }
  } finally {
    opts.signal?.removeEventListener('abort', onAbort)
    clearTimeout(killTimer)
  }
}

/** The whole stream as text, with each chunk also handed to `onChunk` as it lands. */
async function teeText(
  stream: ReadableStream<Uint8Array<ArrayBuffer>>,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  if (onChunk === undefined) {
    return new Response(stream).text()
  }
  let all = ''
  for await (const text of stream.pipeThrough(new TextDecoderStream())) {
    all += text
    onChunk(text)
  }
  return all
}

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
 * Keyed on the binary's realpath and mtime: a listing that finds the same
 * file as last time returns the last observation rather than spawning again.
 */
const binaryVersionObservations = new Map<string, ObservedVersion>()

export async function observeAgentVersion(
  agent: string,
  configuredVersion: string,
  agenticSpawn: AgenticSpawn = defaultAgenticSpawn,
): Promise<ObservedVersion> {
  const cli = agentCli(agent)
  if (cli?.resolveBinary === undefined) {
    return { ok: true, version: configuredVersion }
  }
  let binary: string
  try {
    binary = agent === 'cursor' ? resolveCursorBinary() : cli.resolveBinary()
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
  let key: string
  try {
    const resolved = realpathSync(binary)
    key = `${resolved}:${statSync(resolved).mtimeMs}`
  } catch (err) {
    return { ok: false, error: errMessage(err) }
  }
  const cached = binaryVersionObservations.get(key)
  if (cached !== undefined) {
    return cached
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
  binaryVersionObservations.set(key, observed)
  return observed
}

interface BuildArgvInput {
  /** The absolute path the install script resolved — never a bare `bunx`, never a path this module guesses. */
  bunx: string
  /** Which agent CLI, from the spec. `agents.ts` supplies its package and its launch argv. */
  agent: string
  /** The configured pin, e.g. `"1.2.3"` — never `"latest"`. */
  agentVersion: string
  /** `[engine.args]`, rendered last so the operator can extend but never precede or replace what came before. */
  args: Record<string, unknown>
  /** The rendered empty MCP config claude's `--strict-mcp-config` must name — a bare flag closes nothing. Ignored by an agent that takes no such flag. */
  mcpConfigPath: string
  /** Launch in the agent's streamed output format, for a caller reading deltas as they print. */
  streaming?: boolean
  /** Caller-supplied system instructions, passed through an agent's dedicated system-prompt channel. */
  systemPrompt?: string
  /** Use the claude research floor, which has web search and no file tools. */
  research?: boolean
  /** Overrides the agent's own `resolveBinary` for a test, which cannot redirect `Bun.which` or `homedir()` in-process. Ignored for an npm-pinned agent. */
  resolveBinary?: () => string
}

/**
 * Built from scratch on every call, so the spec's own `command` array is
 * never what runs — it exists only so a spec that tried to redirect the
 * binary fails at parse. A `flags` agent's floor is prepended here and no
 * config entry or `spec_dir` override can reach it.
 *
 * The pinned-package prefix is only for an agent `bunx` actually fetches:
 * one with `resolveBinary` (agents.ts) instead resolves its own already-
 * installed binary here, on every call, so a self-update between launches
 * is picked up rather than cached stale — and throws rather than falling
 * through to a bare command name a spawned child's own PATH might not carry.
 */
export function buildArgv(input: BuildArgvInput): string[] {
  const agent = agentCli(input.agent)
  if (agent === undefined) {
    throw new Error(`unknown agent "${input.agent}"`)
  }
  const command =
    agent.resolveBinary === undefined
      ? [input.bunx, `${agent.pkg}@${input.agentVersion}`]
      : [(input.resolveBinary ?? agent.resolveBinary)()]
  return [
    ...command,
    ...agent.launch(
      input.mcpConfigPath,
      input.streaming === true,
      input.systemPrompt,
      input.research === true,
    ),
    ...argvFromArgs(input.args),
  ]
}

/** Spawned processes get an allowlist, never the ambient environment — a `--user` unit hands every child the manager's environment otherwise, secrets included. */
export function buildChildEnv(
  allowlist: readonly string[],
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of allowlist) {
    const value = ambient[key]
    if (value !== undefined) {
      out[key] = value
    }
  }
  return out
}

interface RunAgenticInput {
  /** Which agent CLI the spec declared. Decides the argv, the parser and where the floor comes from. */
  agent: string
  agentVersion: string
  args: Record<string, unknown>
  envAllowlist: readonly string[]
  /** Where the process starts. Absent or empty is a 400 that never advances a chain — it is not a read boundary either way. */
  workdir: string | undefined
  prompt: string
  systemPrompt?: string
  research?: boolean
  spawn: AgenticSpawn
  /** The absolute path `resolveBunx` produced, which refuses to be empty. */
  bunx: string
  /** Overrides `resolveBwrap` for a test. Only ever consulted for a `sandbox` agent. */
  bwrap?: string | null
  /** Where this agent's own model lives. Required by an agent with a `configure`; ignored by one without. */
  upstream?: AgentTarget
  ambientEnv?: NodeJS.ProcessEnv
  /**
   * Set on the child unconditionally, after the allowlist — a different
   * thing from ambient inheritance. `envAllowlist` governs what leaks in
   * from this process's own environment (which on a `--user` unit includes
   * secrets an agentic child must never see); these are values the caller
   * deliberately chooses for this one launch, such as redirecting a remote
   * upstream's base URL and key. Wins on a name collision with the allowlist.
   */
  extraEnv?: Record<string, string>
  /** Forwarded to `spawn` verbatim; see `AgenticSpawnOptions.signal`. Absent for a probe run, which has no chain hop or timeout above it. */
  signal?: AbortSignal
  /** Answer text as the CLI prints it. Presence switches the launch to the agent's streamed output format; the verdict still comes from `parse` over the whole stdout. */
  onDelta?: (text: string) => void
  /** See `BuildArgvInput.resolveBinary`. */
  resolveBinary?: () => string
}

export interface RunAgenticResult {
  status: number
  ok: boolean
  result?: string
  failure?: string
  /**
   * True only when the envelope itself carried `is_error` or failed to
   * parse — never for the 400 workdir-required rejection, which is a
   * request-shape error, not an envelope one. `chain.ts` reads this to
   * keep an envelope failure from advancing a chain the way a genuine
   * upstream 5xx does.
   */
  envelopeFailure: boolean
  /** The tail of what the CLI wrote to stderr when its envelope could not be read -- the only place a launch that never answered explains itself. */
  stderrTail?: string
  /** The pin actually embedded in the launched argv. Absent when no process was spawned (the workdir-required 400). */
  version?: string
  /** What the CLI said the run cost, off its own envelope. Absent for a launch that never produced one. */
  usage?: Usage
}

/**
 * `agent.configure`'s env, merged into `env` in place, plus its `cleanup` --
 * or a 400 for an agent that has one but was given no `upstream` to render
 * it against. `undefined` `cleanup` for an agent with no `configure` at all
 * (claude, cursor) is deliberate: nothing was written, so nothing needs
 * removing once the spawn it belongs to returns.
 */
function configureUpstream(
  agent: AgentCli,
  upstream: AgentTarget | undefined,
  env: Record<string, string>,
): { cleanup?: () => void; error?: RunAgenticResult } {
  if (agent.configure === undefined) {
    return {}
  }
  if (upstream === undefined) {
    return {
      error: {
        status: STATUS_BAD_REQUEST,
        ok: false,
        failure: `agent "${agent.id}" has to be pointed at a model; dispatch through a route that names one`,
        envelopeFailure: false,
      },
    }
  }
  const configured = agent.configure(upstream)
  Object.assign(env, configured.env)
  return { cleanup: configured.cleanup }
}

interface SandboxFloorInput {
  workdir: string
  argv: string[]
  env: Record<string, string>
  /** Overrides `resolveBwrap()`; only ever set by a test. */
  bwrapOverride: string | null | undefined
}

/** The one reading of "this box has no bwrap": `null`, and the empty string an override may spell it as. */
export function usableBwrap(override?: string | null): string | null {
  const bwrap = override === undefined ? resolveBwrap() : override
  return bwrap === null || bwrap === '' ? null : bwrap
}

/** `argv` wrapped under bwrap for a `sandbox`-floor agent, `home`'s env merged into `env` in place -- unchanged for a `flags` agent, or a 503 when this box has no bwrap to wrap it with. */
function applySandboxFloor(
  agent: AgentCli,
  input: SandboxFloorInput,
): { argv: string[]; error?: RunAgenticResult } {
  const { workdir, argv, env, bwrapOverride } = input
  if (agent.floor !== 'sandbox') {
    return { argv }
  }
  const bwrap = usableBwrap(bwrapOverride)
  if (bwrap === null) {
    // Never a fallback to an unsandboxed launch: this agent's whole floor is
    // the mount table, so without it there is no floor to run under at all.
    return {
      argv,
      error: {
        status: STATUS_UNAVAILABLE,
        ok: false,
        failure: `agent "${agent.id}" needs bwrap for its read-only floor and none was found; set ENGINED_BWRAP or install bubblewrap`,
        envelopeFailure: false,
      },
    }
  }
  const home = sandboxHome(agent.id)
  Object.assign(env, sandboxEnv(home))
  return { argv: sandboxArgv({ bwrap, home, workdir, argv }) }
}

interface LaunchInput {
  argv: string[]
  env: Record<string, string>
  workdir: string
}

/** The actual launch, once every gate above has cleared: spawn `argv`, then hand the raw stdout to this agent's own envelope parser -- the one place a run's success is decided. */
async function spawnAndParse(
  agent: AgentCli,
  launch: LaunchInput,
  input: RunAgenticInput,
): Promise<RunAgenticResult> {
  const { onDelta } = input
  let pending = ''
  const onStdout =
    onDelta === undefined
      ? undefined
      : (chunk: string): void => {
          pending += chunk
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          for (const line of lines) {
            const text = agentDelta(agent.id, line)
            if (text !== '') {
              onDelta(text)
            }
          }
        }
  const spawned = await input.spawn(launch.argv, {
    cwd: launch.workdir,
    env: launch.env,
    input: input.prompt,
    signal: input.signal,
    onStdout,
  })
  const outcome: AgenticOutcome = agent.parse(spawned.stdout)
  return {
    status: outcome.ok ? STATUS_OK : STATUS_BAD_GATEWAY,
    ok: outcome.ok,
    result: outcome.result,
    failure: outcome.failure,
    envelopeFailure: !outcome.ok,
    version: input.agentVersion,
    // Carried whether or not the envelope said the run succeeded: a run that
    // errored after spending still spent.
    usage: outcome.usage,
    stderrTail: outcome.ok ? undefined : stderrTail(spawned.stderr),
  }
}

export async function runAgentic(input: RunAgenticInput): Promise<RunAgenticResult> {
  if (input.workdir === undefined || input.workdir === '') {
    return {
      status: STATUS_BAD_REQUEST,
      ok: false,
      failure: 'workdir is required for an agentic attempt',
      envelopeFailure: false,
    }
  }
  try {
    if (!statSync(input.workdir).isDirectory()) {
      throw new Error('not a directory')
    }
  } catch {
    return {
      status: STATUS_BAD_REQUEST,
      ok: false,
      failure: `workdir ${input.workdir} does not exist for engined (the service runs with PrivateTmp, so /tmp and /var/tmp are private to it; use a directory under the user's home)`,
      envelopeFailure: false,
    }
  }
  const agent = agentCli(input.agent)
  if (agent === undefined) {
    return {
      status: STATUS_BAD_REQUEST,
      ok: false,
      failure: `unknown agent "${input.agent}"`,
      envelopeFailure: false,
    }
  }
  if (input.research === true && agent.id !== 'claude') {
    return {
      status: STATUS_BAD_REQUEST,
      ok: false,
      failure: `agent "${agent.id}" does not support research mode`,
      envelopeFailure: false,
    }
  }
  let argv: string[] = buildArgv({
    bunx: input.bunx,
    agent: agent.id,
    agentVersion: input.agentVersion,
    args: input.args,
    mcpConfigPath: renderEmptyMcpConfig(),
    streaming: input.onDelta !== undefined,
    systemPrompt: input.systemPrompt,
    research: input.research,
    resolveBinary: input.resolveBinary,
  })
  const env: Record<string, string> = {
    ...buildChildEnv(input.envAllowlist, input.ambientEnv ?? process.env),
  }
  // Whatever `configure` wrote (opencode's per-launch config file) outlives
  // this call only until the spawn it was rendered for returns -- the
  // `try` below covers the bwrap-missing and spawn-throws paths too, since
  // the file is already on disk by the time either can happen.
  const configured = configureUpstream(agent, input.upstream, env)
  if (configured.error) {
    return configured.error
  }
  try {
    const sandboxed = applySandboxFloor(agent, {
      workdir: input.workdir,
      argv,
      env,
      bwrapOverride: input.bwrap,
    })
    if (sandboxed.error) {
      return sandboxed.error
    }
    ;({ argv } = sandboxed)
    Object.assign(env, input.extraEnv)
    return await spawnAndParse(agent, { argv, env, workdir: input.workdir }, input)
  } finally {
    configured.cleanup?.()
  }
}
