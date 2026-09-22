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

import { existsSync } from 'node:fs'
import process from 'node:process'
import {
  buildRunArgs,
  extraBuildArgs,
  extraBuildContexts,
  hostBindings,
  hostPathFor,
  mountSpec,
  parseExposedPort,
  parseHostPort,
  SPEC_LABEL,
  specDigest,
  specDockerfile,
} from './dockerArgs.ts'
import { binExec, type Exec } from './exec.ts'
import { discardBody } from './http.ts'
import type { EngineResources } from './resources.ts'
import { parseResources, RESOURCE_PROBE_SH } from './resources.ts'
import type { RunnableContainerSpec } from './specTypes.ts'
import type { Artifact, EngineState, ReadyProbe } from './types.ts'

import { errMessage, MS_PER_SECOND, pollUntil, probeSaysReady } from './types.ts'

/** The prefix on every container engined starts, so a stray one is identifiable by name alone. */
export const NAME_PREFIX = 'engined-'
const READY_POLL_INTERVAL_MS = 250
/** docker's own "could not start the container" exit code, distinct from the command that ran failing. */
const DOCKER_START_FAILURE_EXIT_CODE = 125
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
const NO_SUCH_CONTAINER = /no such container/i

export const dockerExec: Exec = binExec('docker')

export type Probe = (url: string, method: 'GET' | 'POST') => Promise<{ status: number }>

async function defaultProbe(url: string, method: 'GET' | 'POST'): Promise<{ status: number }> {
  const res = await fetch(url, { method })
  await discardBody(res)
  return { status: res.status }
}

interface LifecycleOptions {
  idleStopSeconds: number
  readyTimeoutS: number
  /** The spec's own directory (shipped `engines/<id>`, or a `spec_dir` override). */
  specSource?: string
}

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
}

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; fix?: string; error: string }

interface Runtime {
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

export class DockerLifecycle {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly exec: Exec
  private readonly httpProbe: Probe
  /**
   * What this lifecycle's containers are called. Overridden only by the
   * local tier, which drives real docker: under the default it would name
   * -- and on teardown stop -- the very containers an installed unit owns.
   */
  private readonly namePrefix: string

  constructor(
    exec: Exec = dockerExec,
    httpProbe: Probe = defaultProbe,
    namePrefix: string = NAME_PREFIX,
  ) {
    this.exec = exec
    this.httpProbe = httpProbe
    this.namePrefix = namePrefix
  }

  /**
   * Fired when an engine's state actually changes. Set rather than
   * constructor-injected because a lifecycle is built in two places -- the
   * registry makes its own, and `createDoor` makes one to share with the
   * llama routers and hands it in. A constructor argument is silently
   * dropped by the second path, so the owner attaches instead.
   */
  private onStateChange: (id: string) => void = () => undefined

  onChange(listener: (id: string) => void): void {
    this.onStateChange = listener
  }

  /**
   * The only place `state` is assigned. A write of the same value is not a
   * change, and every assignment routes through here so a state reached by a
   * path added later is announced without that path remembering to say so.
   */
  private transition(rt: Runtime, state: EngineState): void {
    if (rt.state === state) {
      return
    }
    rt.state = state
    this.onStateChange(rt.id)
  }

  private runtime(id: string): Runtime {
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

  getStatus(id: string): RuntimeStatus {
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

  private cancelIdle(rt: Runtime): void {
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
  private markStopped(rt: Runtime): void {
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
   * Stops the engine and keeps it stopped for `ttlMs`, so a second process can
   * load the same weights without racing this one for the pool. `start`
   * refuses while the hold stands: a caller told "held" can wait or fail,
   * where an OOM takes the whole box and everything else on it.
   */
  async hold(id: string, ttlMs: number): Promise<void> {
    await this.stop(id)
    // `runtime`, not a `runtimes.get`: an engine that has never started has no
    // entry yet, and holding one down before its first start is exactly the
    // case a second process asking for the pool is in.
    this.runtime(id).heldUntil = Date.now() + ttlMs
  }

  /** Ends a hold early. Idempotent: releasing one that has already expired is the state the caller wanted. */
  unhold(id: string): void {
    const rt = this.runtimes.get(id)
    if (rt) {
      rt.heldUntil = undefined
    }
  }

  /**
   * Takes a lease, holding the container open for one in-flight request.
   * Paired with `endLease`, which every path must reach exactly once however
   * it ends -- an unreleased lease pins the engine's GPU for the life of the
   * process, since nothing else re-arms the countdown.
   */
  beginLease(id: string): void {
    const rt = this.runtimes.get(id)
    if (rt?.state !== 'running') {
      return
    }
    rt.activeLeases++
    this.cancelIdle(rt)
  }

  /** Releases one lease. The countdown re-arms only once the last one is gone, so it can never fire mid-request. */
  endLease(id: string, idleStopSeconds: number): void {
    const rt = this.runtimes.get(id)
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
    this.cancelIdle(rt)
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
            rt.idleStopAttempts++
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
    const rt = this.runtime(id)
    this.cancelIdle(rt)
    // Returning the map's record on faith hands back a corpse when the
    // container crashed, was OOM-killed or was removed underneath engined --
    // and starting on faith destroys a container this process never started
    // but an earlier one did. A reconcile decides both, and only what it
    // leaves `running` is handed back without a fresh start.
    if (
      (await this.reconcile(id, spec, opts.idleStopSeconds)).state === 'running' &&
      rt.hostPort !== null
    ) {
      this.refreshIdle(rt, opts.idleStopSeconds)
      return { ...this.getStatus(id), launched: false }
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
    const rt = this.runtimes.get(id)
    if (!rt) {
      return this.getStatus(id)
    }
    // `warming` is a state this process is actively driving, with an in-flight
    // start that will resolve it -- and the container it names may not exist
    // yet, so asking docker about it would report a live start as dead.
    if (rt.state === 'warming') {
      return this.getStatus(id)
    }
    if (rt.state === 'running') {
      // Whatever holds this name is this process's own from here on.
      rt.adoptChecked = true
      const res = await this.exec(['inspect', '-f', '{{.State.Running}}', rt.containerName])
      if (res.exitCode === 0 && res.stdout.trim() === 'true') {
        return this.getStatus(id)
      }
      this.markStopped(rt)
      return this.getStatus(id)
    }
    if (spec !== undefined && !rt.adoptChecked) {
      rt.adoptChecked = true
      await this.adopt(rt, spec, idleStopSeconds ?? ADOPTED_IDLE_STOP_SECONDS)
    }
    return this.getStatus(id)
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
  ): Promise<void> {
    const found = await this.findOrphan(rt.containerName)
    if (found === null) {
      return
    }
    if (found.digest !== specDigest(spec)) {
      this.declineAdoption(
        rt,
        found.digest === ''
          ? 'it carries no spec digest, so what it was launched from cannot be established'
          : 'its launch does not match the spec now in force',
      )
      return
    }
    const hostPort = parseHostPort(hostBindings(found.ports))
    if (hostPort === null) {
      this.declineAdoption(rt, 'docker publishes no host binding for it')
      return
    }
    // One attempt, not the start-path poll: a container that has been up long
    // enough to be an orphan is either answering now or is not worth keeping,
    // and this runs on the GET that every operator poll makes.
    if (!(await this.pollReady(hostPort, spec.ready, Date.now()))) {
      this.declineAdoption(rt, `${spec.ready.path} did not answer`)
      return
    }
    rt.hostPort = hostPort
    this.transition(rt, 'running')
    this.refreshIdle(rt, idleStopSeconds)
  }

  /** Running only: a container that already exited holds nothing, and the next start removes it as it always did. */
  private async findOrphan(
    containerName: string,
  ): Promise<{ digest: string; ports: string } | null> {
    const res = await this.exec([
      'ps',
      '--filter',
      `name=^${containerName}$`,
      '--format',
      `{{.Names}}\t{{.Label "${SPEC_LABEL}"}}\t{{.Ports}}`,
    ])
    const line = res.stdout.trim()
    if (res.exitCode !== 0 || line === '') {
      return null
    }
    const [, digest, ports] = line.split('\t')
    return { digest: digest ?? '', ports: ports ?? '' }
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
    const rt = this.runtime(id)
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
    this.transition(rt, 'installed')
    rt.fix = undefined
    rt.lastError = undefined
    return this.getStatus(id)
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
    this.transition(rt, 'unavailable')
    rt.fix = fix
    rt.lastError = error
    return this.getStatus(id)
  }

  private async doStart(
    id: string,
    rt: Runtime,
    spec: RunnableContainerSpec,
    opts: LifecycleOptions,
  ): Promise<RuntimeStatus> {
    this.transition(rt, 'warming')
    rt.fix = undefined
    rt.lastError = undefined

    const checked = await this.checkInstallable(id, rt, spec, opts.specSource)
    if (!checked.ok) {
      return checked.status
    }
    const ran = await this.runContainer(rt.containerName, spec, checked.containerPort)
    if (!ran.ok) {
      return this.fail(id, rt, ran.error)
    }
    const hostPort = await this.readHostPort(rt.containerName, checked.containerPort)
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
    this.transition(rt, 'running')
    rt.imageCheck = null
    rt.artifactCheck = null
    return this.getStatus(id)
  }

  /**
   * `pull` always has a runnable fix: the image name is the whole command.
   * `build` does not by default -- `docker build <image>` treats the image
   * name as a context PATH and fails. A real fix needs the spec's own
   * directory, which is the build context and where its Dockerfile lives
   * unless `dockerfile-path` names another. `obtain = "build"` with no
   * Dockerfile to be found means the image was built elsewhere and only
   * tagged locally, so naming a path that does not exist would be the same
   * defect in a new costume.
   */
  private buildImageFix(spec: RunnableContainerSpec, specSource?: string): string {
    if (spec.obtain === 'pull') {
      return `docker pull ${spec.image}`
    }
    if (specSource !== undefined) {
      const dockerfile = specDockerfile(specSource)
      if (existsSync(dockerfile)) {
        return `docker build -t ${spec.image}${extraBuildContexts(specSource)}${extraBuildArgs(specSource)} -f ${dockerfile} ${specSource}`
      }
    }
    const where = specSource === undefined ? '' : ` at ${specSource}`
    return `${spec.image}: no Dockerfile${where} to build from -- this image must already exist locally, built some other way`
  }

  private async checkImage(
    spec: RunnableContainerSpec,
    specSource?: string,
  ): Promise<Result<{ containerPort: number }>> {
    const res = await this.exec(['image', 'inspect', spec.image])
    if (res.exitCode !== 0) {
      return {
        ok: false,
        fix: this.buildImageFix(spec, specSource),
        error: `${spec.image}: image not present`,
      }
    }
    const parsed = parseExposedPort(res.stdout, spec.image)
    if ('error' in parsed) {
      return { ok: false, error: parsed.error }
    }
    return { ok: true, containerPort: parsed.port }
  }

  /** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix (e.g. `docker pull`) can make it pass, and that fix happens outside this process. */
  private async ensureImageChecked(
    rt: Runtime,
    spec: RunnableContainerSpec,
    specSource?: string,
  ): Promise<Result<{ containerPort: number }>> {
    if (!rt.imageCheck) {
      rt.imageCheck = this.checkImage(spec, specSource)
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
      rt.artifactCheck = this.checkArtifacts(spec)
    }
    const result = await rt.artifactCheck
    if (!result.ok) {
      rt.artifactCheck = null
    }
    return result
  }

  /**
   * A bind-mounted artifact is a plain host `stat` — no container needed.
   * What's left after that (a named volume, or nothing declared to mount it
   * at all) is checked the only way it can be: a short-lived container per
   * artifact, mounting every volume the spec declares.
   */
  private async checkArtifacts(spec: RunnableContainerSpec): Promise<Result> {
    const needsContainer: Artifact[] = []
    for (const artifact of spec.artifacts) {
      const hostPath = hostPathFor(artifact, spec.volumes)
      if (hostPath === null) {
        needsContainer.push(artifact)
      } else if (!existsSync(hostPath)) {
        return this.missingArtifact(spec.image, artifact)
      }
    }
    if (needsContainer.length === 0) {
      return { ok: true }
    }
    const volumeArgs = spec.volumes.flatMap((v) => ['-v', mountSpec(v)])
    const checks = await Promise.all(
      needsContainer.map(async (artifact) => ({
        artifact,
        res: await this.exec([
          'run',
          '--rm',
          '--entrypoint',
          'sh',
          ...volumeArgs,
          spec.image,
          '-c',
          `test -e '${artifact.path}'`,
        ]),
      })),
    )
    for (const { artifact, res } of checks) {
      if (res.exitCode === 0) {
        continue
      }
      if (res.exitCode === DOCKER_START_FAILURE_EXIT_CODE) {
        return {
          ok: false,
          error: `${spec.image}: could not check artifact ${artifact.path} (volume unreachable)`,
        }
      }
      return this.missingArtifact(spec.image, artifact)
    }
    return { ok: true }
  }

  private missingArtifact(image: string, artifact: Artifact): Result {
    return {
      ok: false,
      fix: artifact.obtain,
      error: `${image}: artifact missing at ${artifact.path}`,
    }
  }

  /**
   * A container by this name is never resumed as-is: its creation-time args
   * can predate the spec now in force. `-f` is required, not cosmetic: a
   * still-running container (the exact case a daemon restart leaves behind)
   * refuses a plain `rm`, and the `docker run` that follows then fails 125
   * "name already in use" -- indistinguishable from a genuine startup
   * failure unless something recovers it. "No such container" is the normal
   * case (nothing to remove) and is not an error; anything else means `run`
   * would hit the same conflict, so it is surfaced now instead.
   */
  private async runContainer(
    containerName: string,
    spec: RunnableContainerSpec,
    containerPort: number,
  ): Promise<Result> {
    const rm = await this.exec(['rm', '-f', containerName])
    if (rm.exitCode !== 0 && !NO_SUCH_CONTAINER.test(rm.stderr)) {
      return { ok: false, error: rm.stderr.trim() || `docker rm -f failed for ${containerName}` }
    }
    const run = await this.exec(buildRunArgs(containerName, spec, containerPort))
    if (run.exitCode !== 0) {
      return { ok: false, error: run.stderr.trim() || `docker run failed for ${containerName}` }
    }
    return { ok: true }
  }

  private async readHostPort(containerName: string, containerPort: number): Promise<number | null> {
    const res = await this.exec(['port', containerName, `${containerPort}/tcp`])
    return res.exitCode === 0 ? parseHostPort(res.stdout) : null
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
          const res = await this.httpProbe(
            `http://127.0.0.1:${hostPort}${ready.path}`,
            ready.method ?? 'GET',
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
    this.markStopped(rt)
    const res = await this.exec(['stop', rt.containerName])
    if (res.exitCode !== 0) {
      rt.lastError = res.stderr.trim() || `docker stop failed for ${rt.containerName}`
      // A start that arrived during the grace has already replaced everything
      // `markStopped` cleared; only an untouched record may be handed back the
      // truth it held before the attempt.
      if (rt.state === 'installed' && rt.hostPort === null) {
        rt.hostPort = priorPort
        this.transition(rt, priorState)
      }
      return false
    }
    rt.lastError = undefined
    return true
  }

  /**
   * `docker logs --tail`, merged. docker writes the container's stdout to ours
   * and its stderr to ours, so the two arrive already separated and their
   * relative order is lost before this sees them -- most engines log to stderr,
   * so dropping it would return an empty log for a container that is talking.
   *
   * Keyed off the deterministic container name rather than this process's own
   * runtime map, so an engine started by a previous engined still has readable
   * logs. A container that does not exist surfaces docker's own message.
   */
  async logs(id: string, tail: number): Promise<Result<{ lines: string[] }>> {
    const { containerName } = this.runtime(id)
    const res = await this.exec(['logs', '--tail', String(tail), containerName])
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.trim() || `docker logs failed for ${containerName}` }
    }
    const merged = `${res.stdout}${res.stderr}`.split('\n')
    // A trailing newline yields one empty element that is not a log line.
    if (merged.at(-1) === '') {
      merged.pop()
    }
    return { ok: true, lines: merged }
  }

  /**
   * What the container holds right now, in one `docker exec`. Only meaningful
   * while it is running: a stopped engine has no processes to account for and
   * no cgroup to read, which is a different answer from "holds nothing".
   */
  async resources(id: string): Promise<Result<{ resources: EngineResources }>> {
    const rt = this.runtimes.get(id)
    if (rt?.state !== 'running') {
      return { ok: false, error: `"${id}" is not running` }
    }
    const res = await this.exec(['exec', rt.containerName, 'sh', '-c', RESOURCE_PROBE_SH])
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr.trim() || `docker exec failed for ${rt.containerName}`,
      }
    }
    return { ok: true, resources: parseResources(res.stdout) }
  }

  /**
   * Operator-driven stop, down the same path idle-stop takes -- so a stop
   * cancels the pending countdown rather than racing it, and the leases reset
   * with the container they belonged to.
   */
  async stop(id: string): Promise<RuntimeStatus> {
    const rt = this.runtimes.get(id)
    if (rt && (rt.state === 'running' || rt.state === 'warming')) {
      await this.stopContainer(rt)
    }
    return this.getStatus(id)
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
    const rt = this.runtimes.get(id)
    if (!rt) {
      return
    }
    if ((rt.state === 'running' || rt.state === 'warming') && !(await this.stopContainer(rt))) {
      throw new Error(rt.lastError ?? `docker stop failed for ${rt.containerName}`)
    }
    this.runtimes.delete(id)
  }

  /** Stops every container this process started. Called at SIGTERM by the door, not from here. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()]
        .filter((rt) => rt.state === 'running' || rt.state === 'warming')
        .map((rt) => this.stopContainer(rt)),
    )
  }
}
