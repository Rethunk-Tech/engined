/**
 * Generic managed-engine lifecycle: start-on-demand behind a per-engine start
 * lock, force-remove-and-recreate on every start (never a bare resume of
 * whatever container already holds the name), port read-back, readiness and
 * idle-stop. Every engine kind plays a `RunnableContainerSpec` through this
 * same machinery; nothing here is llama, Comfy or audio specific.
 *
 * Parsing is pure and takes strings. Only `dockerExec` and `defaultProbe`
 * touch a process or a socket, so everything else runs with no docker and no
 * network installed.
 */

import process from 'node:process'
import { hostBindings, parseHostPort, specDigest } from './dockerArgs.ts'
import {
  checkArtifacts,
  checkImage,
  findOrphan,
  type Result,
  readHostPort,
  readLogs,
  readResources,
  runContainer,
} from './dockerCommands.ts'
import { HeldError } from './errors/held.ts'
import { StopFailedError } from './errors/stopFailed.ts'
import { binExec, type Exec } from './exec.ts'
import { discardBody } from './http.ts'
import { errMessage, MS_PER_SECOND, pollUntil } from './records.ts'
import type { EngineResources } from './resources.ts'
import { type Runtime, type RuntimeStatus, RuntimeTable } from './runtimeTable.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import { probeSaysReady, type ReadyProbe } from './types.ts'

/** The prefix on every container engined starts, so a stray one is identifiable by name alone. */
export const NAME_PREFIX = 'engined-'
const READY_POLL_INTERVAL_MS = 250
/** A stuck idle-stop is retried this many times, at the same idle-stop cadence, before it is left to the next real request's `endLease` -- bounded so a persistently wedged daemon does not retry forever. */
const MAX_IDLE_STOP_RETRIES = 3
/**
 * What an adopted orphan counts down from when the caller that found it had
 * no engine config in hand -- `probe`, reached from a plain status GET. It is
 * a floor, not the operator's setting: the first `start` or `endLease` re-arms
 * from `[[engine]] idle_stop_seconds`. Without it an orphan adopted on a
 * status GET and never dispatched to holds its GPU until the daemon restarts.
 */
const ADOPTED_IDLE_STOP_SECONDS = 900

export const dockerExec: Exec = binExec('docker')

export type Probe = (
  url: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
) => Promise<{ status: number }>

/**
 * The least one readiness probe is given, so a one-shot check against an
 * already-running container (a deadline of now) still gets an answer.
 */
const PROBE_MIN_MS = 5000

async function defaultProbe(
  url: string,
  method: 'GET' | 'POST',
  signal?: AbortSignal,
): Promise<{ status: number }> {
  const res = await fetch(url, { method, signal })
  await discardBody(res)
  return { status: res.status }
}

interface LifecycleOptions {
  idleStopSeconds: number
  readyTimeoutS: number
  /** The spec's own directory (shipped `engines/<id>`, or a `spec_dir` override). */
  specSource?: string
}

export class DockerLifecycle {
  private readonly table: RuntimeTable
  private readonly exec: Exec
  private readonly httpProbe: Probe

  constructor(
    exec: Exec = dockerExec,
    httpProbe: Probe = defaultProbe,
    /**
     * What this lifecycle's containers are called. Overridden only by the
     * local tier, which drives real docker: under the default it would name
     * -- and on teardown stop -- the very containers an installed unit owns.
     */
    namePrefix: string = NAME_PREFIX,
  ) {
    this.exec = exec
    this.httpProbe = httpProbe
    this.table = new RuntimeTable(namePrefix)
  }

  /**
   * Fired when an engine's state actually changes. Set rather than
   * constructor-injected because a lifecycle is built in two places -- the
   * registry makes its own, and `createDoor` makes one to share with the
   * llama routers and hands it in. A constructor argument is silently
   * dropped by the second path, so the owner attaches instead.
   */
  onChange(listener: (id: string) => void): void {
    this.table.onChange(listener)
  }

  getStatus(id: string): RuntimeStatus {
    return this.table.status(id)
  }

  /** How long a hold on `id` still stands, in ms; zero when none does. */
  heldMsFor(id: string): number {
    return this.table.heldMsFor(id)
  }

  /**
   * Stops the engine and keeps it stopped for `ttlMs`, so a second process can
   * load the same weights without racing this one for the pool. `start`
   * refuses while the hold stands: a caller told "held" can wait or fail,
   * where an OOM takes the whole box and everything else on it.
   */
  async hold(id: string, ttlMs: number): Promise<void> {
    // Set before the stop so a start arriving during docker's grace period is
    // refused rather than relaunching the engine the hold is removing.
    this.table.holdFor(id, ttlMs)
    const status = await this.stop(id)
    if (status.state === 'running' || status.state === 'warming') {
      this.table.unhold(id)
      throw new StopFailedError(id, status.last_error ?? 'docker stop failed')
    }
  }

  /** Ends a hold early. Idempotent: releasing one that has already expired is the state the caller wanted. */
  unhold(id: string): void {
    this.table.unhold(id)
  }

  /**
   * Takes a lease, holding the container open for one in-flight request.
   * Paired with `endLease`, which every path must reach exactly once however
   * it ends -- an unreleased lease pins the engine's GPU for the life of the
   * process, since nothing else re-arms the countdown.
   */
  beginLease(id: string): void {
    const rt = this.table.get(id)
    if (rt?.state !== 'running') {
      return
    }
    rt.activeLeases += 1
    this.table.cancelIdle(rt)
  }

  /** Releases one lease. The countdown re-arms only once the last one is gone, so it can never fire mid-request. */
  endLease(id: string, idleStopSeconds: number): void {
    const rt = this.table.get(id)
    if (rt?.state !== 'running') {
      return
    }
    rt.activeLeases = Math.max(0, rt.activeLeases - 1)
    this.refreshIdle(rt, idleStopSeconds)
  }

  /**
   * Re-arms the countdown whenever nothing holds the container. Called on
   * every start too, not only on a lease end: an engine warmed by
   * `POST /v1/engines/:id/start` and never dispatched to has no lease to end,
   * and before this it stayed resident until the process died.
   */
  private refreshIdle(rt: Runtime, idleStopSeconds: number): void {
    this.table.cancelIdle(rt)
    if (rt.activeLeases > 0 || rt.state !== 'running') {
      return
    }
    rt.idleStopAttempts = 0
    this.armIdleStop(rt, idleStopSeconds)
  }

  /**
   * A `docker stop` that fails leaves the container running with no traffic
   * to trigger another attempt, so this re-arms itself on the same cadence
   * up to `MAX_IDLE_STOP_RETRIES` -- a single hiccup no longer pins the
   * engine's resources until a fresh request happens to arrive.
   */
  private armIdleStop(rt: Runtime, idleStopSeconds: number): void {
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = null
      this.stopContainer(rt)
        .then((stopped) => {
          if (!stopped && rt.idleStopAttempts < MAX_IDLE_STOP_RETRIES) {
            rt.idleStopAttempts += 1
            this.armIdleStop(rt, idleStopSeconds)
          }
        })
        .catch((err: unknown) => {
          rt.lastError = errMessage(err)
        })
    }, idleStopSeconds * MS_PER_SECOND)
  }

  /**
   * Two concurrent calls for a stopped engine share one in-flight start.
   * `opts.specSource` is the spec's own directory (shipped `engines/<id>`, or
   * a `spec_dir` override) -- optional only so tests that never exercise a
   * `build`-obtain spec can omit it; every real caller has it, straight from
   * `LoadedSpec.source`.
   */
  async start(
    id: string,
    spec: RunnableContainerSpec,
    opts: LifecycleOptions,
  ): Promise<RuntimeStatus> {
    const heldMs = this.table.heldMsFor(id)
    if (heldMs > 0) {
      throw new HeldError(id, heldMs)
    }
    const rt = this.table.runtime(id)
    this.table.cancelIdle(rt)
    // Returning the map's record on faith hands back a corpse when the
    // container crashed, was OOM-killed or was removed underneath engined --
    // and starting on faith destroys a container this process never started
    // but an earlier one did. A reconcile decides both, and only what it
    // leaves `running` is handed back without a fresh start.
    const reconciled = await this.reconcile(id, spec, opts.idleStopSeconds)
    if (reconciled.state === 'running' && rt.hostPort !== null) {
      this.refreshIdle(rt, opts.idleStopSeconds)
      return { ...this.table.status(id), launched: false, adopted: reconciled.adopted }
    }
    if (rt.startPromise !== null) {
      // Joining someone else's in-flight start, not running doStart myself --
      // `launched` must be decided per caller, not read off the shared
      // promise's resolved value, or every joiner would inherit the
      // launcher's `true`.
      return { ...(await rt.startPromise), launched: false }
    }
    const promise = this.doStart(id, rt, spec, opts)
    rt.startPromise = promise
    const status = await promise
    rt.startPromise = null
    this.refreshIdle(rt, opts.idleStopSeconds)
    return { ...status, launched: true }
  }

  /**
   * The one seam where docker, not this map, decides what is true — in both
   * directions. Believed-running state lives only in the map, so a container
   * killed from outside this process leaves it stale and keeps handing out a
   * dead `private_url`; and the map is empty at startup, so a container an
   * unclean exit left running is invisible to it. A transient HTTP failure
   * against a container that is genuinely still up leaves the record alone.
   *
   * `spec` enables the adoption direction and is passed by the two reads that
   * can act on it. A caller reconciling an engine it already believes running
   * has nothing to adopt and omits it, and with it `idleStopSeconds` -- which
   * only an adoption spends.
   */
  async reconcile(
    id: string,
    spec?: RunnableContainerSpec,
    idleStopSeconds?: number,
  ): Promise<RuntimeStatus> {
    const rt = this.table.get(id)
    if (!rt) {
      return this.table.status(id)
    }
    if (rt.adoption !== null) {
      await rt.adoption
      return this.table.status(id)
    }
    // `warming` is a state this process is actively driving, with an in-flight
    // start that will resolve it -- and the container it names may not exist
    // yet, so asking docker about it would report a live start as dead.
    if (rt.state === 'warming') {
      return this.table.status(id)
    }
    if (rt.state === 'running') {
      // Whatever holds this name is this process's own from here on.
      rt.adoptChecked = true
      const res = await this.exec(['inspect', '-f', '{{.State.Running}}', rt.containerName])
      if (res.exitCode === 0 && res.stdout.trim() === 'true') {
        return this.table.status(id)
      }
      this.table.markStopped(rt)
      return this.table.status(id)
    }
    if (spec !== undefined && !rt.adoptChecked) {
      rt.adoptChecked = true
      rt.adoption = this.adopt(rt, spec, idleStopSeconds ?? ADOPTED_IDLE_STOP_SECONDS)
      try {
        if (await rt.adoption) {
          return { ...this.table.status(id), adopted: true }
        }
      } finally {
        rt.adoption = null
      }
    }
    return this.table.status(id)
  }

  /**
   * A container still running under this engine's name that this process did
   * not start. Only an unclean exit leaves one -- `shutdown` stops everything
   * on SIGTERM -- and it is exactly then that destroying it is worst, because
   * whatever it was serving is still being served.
   *
   * Adopted only when its launch is byte-identical to the spec now in force,
   * a host binding is still published, and its own readiness probe answers.
   * Anything else is recreated: an orphan whose image or argv predates the
   * current spec silently serves a configuration engined no longer offers,
   * and one nothing can reach is not serving anything worth keeping. That
   * recreate is announced rather than taken silently, because a container
   * being destroyed is the one outcome an operator would want to have seen.
   *
   * An adopted container counts down like one this process started: nothing
   * else will ever arm it, since adoption happens once per process.
   */
  private async adopt(
    rt: Runtime,
    spec: RunnableContainerSpec,
    idleStopSeconds: number,
  ): Promise<boolean> {
    const found = await findOrphan(this.exec, rt.containerName)
    if (found === null) {
      return false
    }
    if (found.digest !== specDigest(spec)) {
      this.declineAdoption(
        rt,
        found.digest === ''
          ? 'it carries no spec digest, so what it was launched from cannot be established'
          : 'its launch does not match the spec now in force',
      )
      return false
    }
    const hostPort = parseHostPort(hostBindings(found.ports))
    if (hostPort === null) {
      this.declineAdoption(rt, 'docker publishes no host binding for it')
      return false
    }
    // One attempt, not the start-path poll: a container that has been up long
    // enough to be an orphan is either answering now or is not worth keeping,
    // and this runs on the GET that every operator poll makes.
    if (!(await this.pollReady(hostPort, spec.ready, Date.now()))) {
      this.declineAdoption(rt, `${spec.ready.path} did not answer`)
      return false
    }
    if (rt.state === 'warming' || rt.state === 'running') {
      return false
    }
    rt.hostPort = hostPort
    this.table.transition(rt, 'running')
    this.refreshIdle(rt, idleStopSeconds)
    return true
  }

  private declineAdoption(rt: Runtime, reason: string): void {
    process.stderr.write(
      `${rt.containerName}: left running by an unclean exit and will be replaced on the next start -- ${reason}\n`,
    )
  }

  /** Reports what an engine's artifacts say, without starting it. */
  async probe(
    id: string,
    spec: RunnableContainerSpec,
    specSource?: string,
    idleStopSeconds?: number,
  ): Promise<RuntimeStatus> {
    const rt = this.table.runtime(id)
    // Neither `running` nor `installed` is known here, only believed: the
    // first survives in the map long after the container behind it died, and
    // the second is what an empty map says about a container an unclean exit
    // left running. This is the read every operator uses to decide whether
    // the engine is servable, so both go to docker first. Whatever reconcile
    // does not leave running falls through to the installability check, which
    // reports the truthful resting state instead of a dead `private_url`.
    const reconciled = await this.reconcile(id, spec, idleStopSeconds)
    if (reconciled.state === 'running' || reconciled.state === 'warming') {
      return reconciled
    }
    const checked = await this.checkInstallable(id, rt, spec, specSource)
    if (!checked.ok) {
      return checked.status
    }
    this.table.transition(rt, 'installed')
    rt.fix = undefined
    rt.lastError = undefined
    return this.table.status(id)
  }

  /** Image then artifacts, in that order: an absent image is the cheaper and more likely fault, and its error names the pull. */
  private async checkInstallable(
    id: string,
    rt: Runtime,
    spec: RunnableContainerSpec,
    specSource?: string,
  ): Promise<{ ok: true; containerPort: number } | { ok: false; status: RuntimeStatus }> {
    const image = await this.ensureImageChecked(rt, spec, specSource)
    if (!image.ok) {
      return { ok: false, status: this.fail(id, rt, image.error, image.fix) }
    }
    const artifacts = await this.ensureArtifactsChecked(rt, spec)
    if (!artifacts.ok) {
      return { ok: false, status: this.fail(id, rt, artifacts.error, artifacts.fix) }
    }
    return { ok: true, containerPort: image.containerPort }
  }

  private fail(id: string, rt: Runtime, error: string, fix?: string): RuntimeStatus {
    this.table.transition(rt, 'unavailable')
    rt.fix = fix
    rt.lastError = error
    return this.table.status(id)
  }

  private async doStart(
    id: string,
    rt: Runtime,
    spec: RunnableContainerSpec,
    opts: LifecycleOptions,
  ): Promise<RuntimeStatus> {
    this.table.transition(rt, 'warming')
    rt.fix = undefined
    rt.lastError = undefined

    const checked = await this.checkInstallable(id, rt, spec, opts.specSource)
    if (!checked.ok) {
      return checked.status
    }
    const ran = await runContainer(this.exec, rt.containerName, spec, checked.containerPort)
    if (!ran.ok) {
      return this.fail(id, rt, ran.error)
    }
    const hostPort = await readHostPort(this.exec, rt.containerName, checked.containerPort)
    if (hostPort === null) {
      return this.fail(id, rt, `${rt.containerName}: docker port returned no host binding`)
    }
    const ready = await this.pollReady(
      hostPort,
      spec.ready,
      Date.now() + opts.readyTimeoutS * MS_PER_SECOND,
    )
    if (!ready) {
      return this.fail(
        id,
        rt,
        `${rt.containerName}: ${spec.ready.path} did not reach ${spec.ready.status} within ${opts.readyTimeoutS}s`,
      )
    }

    rt.hostPort = hostPort
    this.table.transition(rt, 'running')
    rt.imageCheck = null
    rt.artifactCheck = null
    return this.table.status(id)
  }

  /** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix (e.g. `docker pull`) can make it pass, and that fix happens outside this process. */
  private async ensureImageChecked(
    rt: Runtime,
    spec: RunnableContainerSpec,
    specSource?: string,
  ): Promise<Result<{ containerPort: number }>> {
    if (!rt.imageCheck) {
      rt.imageCheck = checkImage(this.exec, spec, specSource)
    }
    const result = await rt.imageCheck
    if (!result.ok) {
      rt.imageCheck = null
    }
    return result
  }

  /** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix can make it pass, and the fix happens outside this process. */
  private async ensureArtifactsChecked(rt: Runtime, spec: RunnableContainerSpec): Promise<Result> {
    if (spec.artifacts.length === 0) {
      return { ok: true }
    }
    if (!rt.artifactCheck) {
      rt.artifactCheck = checkArtifacts(this.exec, spec)
    }
    const result = await rt.artifactCheck
    if (!result.ok) {
      rt.artifactCheck = null
    }
    return result
  }

  /**
   * Polls until ready or past the deadline. Sequential by nature -- each probe
   * only matters once the previous one has failed -- so the awaits belong in a
   * loop rather than a promise chain per interval.
   */
  private pollReady(hostPort: number, ready: ReadyProbe, deadline: number): Promise<boolean> {
    return pollUntil(
      async () => {
        try {
          // A container that accepts the connection and never answers would
          // otherwise hold this probe past the deadline for Bun's idle timeout.
          const res = await this.httpProbe(
            `http://127.0.0.1:${hostPort}${ready.path}`,
            ready.method ?? 'GET',
            AbortSignal.timeout(Math.max(PROBE_MIN_MS, deadline - Date.now())),
          )
          return probeSaysReady(ready, res.status)
        } catch {
          return false // not listening yet
        }
      },
      deadline,
      READY_POLL_INTERVAL_MS,
    )
  }

  /**
   * A failed `docker stop` leaves the container's real state (still running)
   * alone and records why. Returns whether it actually stopped.
   *
   * The record stops being `running` before `docker stop` is issued, not once
   * it returns: the stop waits out the full SIGTERM grace, and a caller
   * reading the map during those seconds would be handed a `private_url` that
   * is about to die, take a lease against it, and then lose that lease to the
   * reset the stop performs on its way out.
   */
  private async stopContainer(rt: Runtime): Promise<boolean> {
    const priorState = rt.state
    const priorPort = rt.hostPort
    this.table.markStopped(rt)
    const res = await this.exec(['stop', rt.containerName])
    if (res.exitCode !== 0) {
      rt.lastError = res.stderr.trim() || `docker stop failed for ${rt.containerName}`
      // A start that arrived during the grace has already replaced everything
      // `markStopped` cleared; only an untouched record may be handed back the
      // truth it held before the attempt.
      if (rt.state === 'installed' && rt.hostPort === null) {
        rt.hostPort = priorPort
        this.table.transition(rt, priorState)
      }
      return false
    }
    rt.lastError = undefined
    return true
  }

  /**
   * `docker logs --tail`, stdout and stderr merged.
   *
   * Keyed off the deterministic container name rather than this process's own
   * runtime map, so an engine started by a previous engined still has readable
   * logs. A container that does not exist surfaces docker's own message.
   */
  async logs(id: string, tail: number): Promise<Result<{ lines: string[] }>> {
    return await readLogs(this.exec, this.table.runtime(id).containerName, tail)
  }

  /**
   * What the container holds right now, in one `docker exec`. Only meaningful
   * while it is running: a stopped engine has no processes to account for and
   * no cgroup to read, which is a different answer from "holds nothing".
   */
  async resources(id: string): Promise<Result<{ resources: EngineResources }>> {
    const rt = this.table.get(id)
    if (rt?.state !== 'running') {
      return { ok: false, error: `"${id}" is not running` }
    }
    return await readResources(this.exec, rt.containerName)
  }

  /**
   * Operator-driven stop, down the same path idle-stop takes -- so a stop
   * cancels the pending countdown rather than racing it, and the leases reset
   * with the container they belonged to.
   */
  async stop(id: string): Promise<RuntimeStatus> {
    const rt = this.table.get(id)
    if (rt && (rt.state === 'running' || rt.state === 'warming')) {
      await this.stopContainer(rt)
    }
    return this.table.status(id)
  }

  /**
   * An engine that has been running is stopped, never left orphaned. A stop
   * that fails keeps the runtime and rejects: a container dropped from this
   * map is beyond `shutdown`'s reach too, so forgetting one this process could
   * not kill is how it comes to outlive the daemon still holding its GPU. The
   * record `stopContainer` hands back on failure is the true one -- it
   * restores the state and port it cleared -- so keeping it costs nothing.
   */
  async removeEngine(id: string): Promise<void> {
    const rt = this.table.get(id)
    if (!rt) {
      return
    }
    if ((rt.state === 'running' || rt.state === 'warming') && !(await this.stopContainer(rt))) {
      throw new Error(rt.lastError ?? `docker stop failed for ${rt.containerName}`)
    }
    this.table.delete(id)
  }

  /** Stops every container this process started. Called at SIGTERM by the door, not from here. */
  async shutdown(): Promise<void> {
    await Promise.all(
      this.table
        .all()
        .filter((rt) => rt.state === 'running' || rt.state === 'warming')
        .map((rt) => this.stopContainer(rt)),
    )
  }
}
