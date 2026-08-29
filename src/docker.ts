/**
 * Generic managed-engine lifecycle: start-on-demand behind a per-engine start
 * lock, force-remove-and-recreate on every start (never a bare resume of
 * whatever container already holds the name), port read-back, readiness and
 * idle-stop. Every engine kind plays a `ContainerSpec` through this same
 * machinery; nothing here is llama, Comfy or audio specific.
 *
 * Parsing is pure and takes strings. Only `dockerExec` and `defaultProbe`
 * touch a process or a socket, so everything else runs with no docker and no
 * network installed.
 */

import { existsSync } from "node:fs";
import { posix } from "node:path";
import process from "node:process";
import { binExec, type Exec } from "./exec.ts";
import type { EngineResources } from "./resources.ts";
import { parseResources, RESOURCE_PROBE_SH } from "./resources.ts";
import type { Artifact, ContainerSpec, EngineState, ReadyProbe, Volume } from "./types.ts";

import { errMessage, MS_PER_SECOND, probeSaysReady } from "./types.ts";

/** Exported so the local tier asserts against the real prefix rather than a hand-built copy. */
export const NAME_PREFIX = "engined-";
const READY_POLL_INTERVAL_MS = 250;
/** docker's own "could not start the container" exit code, distinct from the command that ran failing. */
const DOCKER_START_FAILURE_EXIT_CODE = 125;
/** A stuck idle-stop is retried this many times, at the same idle-stop cadence, before it is left to the next real request's `endLease` -- bounded so a persistently wedged daemon does not retry forever. */
const MAX_IDLE_STOP_RETRIES = 3;
const HOST_PORT_LINE = /^(?<addr>\d{1,3}(?:\.\d{1,3}){3}):(?<port>\d+)$/;
const NO_SUCH_CONTAINER = /no such container/i;

export const dockerExec: Exec = binExec("docker");

export type Probe = (url: string, method: "GET" | "POST") => Promise<{ status: number }>;

async function defaultProbe(url: string, method: "GET" | "POST"): Promise<{ status: number }> {
  const res = await fetch(url, { method });
  return { status: res.status };
}

type PortResult = { port: number } | { error: string };

function mountSpec(volume: Volume): string {
  const base = `${volume.name}:${volume.path}`;
  return volume.read_only === true ? `${base}:ro` : base;
}

/**
 * The host path an artifact lives at, when it sits under a bind-mounted
 * volume (`volume.name` is an absolute host path, not a docker volume name).
 * Null when no volume covers it — a named volume, whose contents only a
 * container can see, or an artifact baked into the image with no mount at all.
 */
export function hostPathFor(artifact: Artifact, volumes: readonly Volume[]): string | null {
  for (const volume of volumes) {
    if (!volume.name.startsWith("/")) {
      continue;
    }
    if (artifact.path === volume.path) {
      return volume.name;
    }
    const prefix = volume.path.endsWith("/") ? volume.path : `${volume.path}/`;
    if (artifact.path.startsWith(prefix)) {
      return posix.join(volume.name, artifact.path.slice(volume.path.length));
    }
  }
  return null;
}

/** The container side comes from the image: exposing zero or several ports leaves no field to disambiguate with. */
export function parseExposedPort(inspectJson: string, image: string): PortResult {
  const parsed = JSON.parse(inspectJson) as Array<{
    Config?: { ExposedPorts?: Record<string, unknown> };
  }>;
  const exposed = parsed[0]?.Config?.ExposedPorts ?? {};
  const ports = Object.keys(exposed);
  if (ports.length === 0) {
    return { error: `${image} exposes no ports` };
  }
  if (ports.length > 1) {
    return { error: `${image} exposes multiple ports: ${ports.join(", ")}` };
  }
  const [first] = ports;
  if (first === undefined) {
    return { error: `${image} exposes no ports` };
  }
  const portStr = first.split("/")[0] ?? first;
  return { port: Number(portStr) };
}

/**
 * `docker port <container> <port>/tcp` prints one `address:port` line per
 * bound interface — an IPv6 wildcard binding prints as a bracketed `[::]`
 * line beside the IPv4 one. Loopback-only publishing never emits it, but the
 * parser skips rather than accidentally matching it.
 */
export function parseHostPort(portOutput: string): number | null {
  for (const line of portOutput.trim().split("\n")) {
    const port = line.trim().match(HOST_PORT_LINE)?.groups?.port;
    if (port !== undefined) {
      return Number(port);
    }
  }
  return null;
}

/** The flags docker never receives from config: the container name and both ports are read back, not written. */
export function buildRunArgs(
  containerName: string,
  spec: ContainerSpec,
  containerPort: number,
): string[] {
  const args = ["run", "-d", "--name", containerName, "-p", `127.0.0.1::${containerPort}`];
  for (const device of spec.devices) {
    args.push("--device", device);
  }
  for (const group of spec.group_add) {
    args.push("--group-add", group);
  }
  for (const opt of spec.security_opt) {
    args.push("--security-opt", opt);
  }
  for (const envName of spec.env) {
    const value = process.env[envName];
    if (value !== undefined) {
      args.push("-e", `${envName}=${value}`);
    }
  }
  for (const volume of spec.volumes) {
    args.push("-v", mountSpec(volume));
  }
  const [entryBin, ...entryRest] = spec.entrypoint ?? [];
  if (entryBin !== undefined) {
    args.push("--entrypoint", entryBin);
  }
  args.push(spec.image, ...entryRest, ...spec.command);
  return args;
}

interface LifecycleOptions {
  idleStopSeconds: number;
  readyTimeoutS: number;
  /** The spec's own directory (shipped `engines/<id>`, or a `spec_dir` override) -- carried here rather than as its own parameter, since `doStart` already has four. */
  specSource?: string;
}

export interface RuntimeStatus {
  state: EngineState;
  private_url: string | null;
  fix?: string;
  last_error?: string;
  /** Requests holding this engine open right now. Absent unless it is running. */
  active_leases?: number;
}

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; fix?: string; error: string };

interface Runtime {
  id: string;
  containerName: string;
  state: EngineState;
  hostPort: number | null;
  fix?: string;
  lastError?: string;
  startPromise: Promise<RuntimeStatus> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  imageCheck: Promise<Result<{ containerPort: number }>> | null;
  artifactCheck: Promise<Result> | null;
  /** Reset on every fresh `endLease`; counts retries within one continuous idle-stop attempt sequence. */
  idleStopAttempts: number;
  /** Requests holding this container open. Idle-stop is armed only at zero, so a start with no traffic behind it still counts down. */
  activeLeases: number;
  /** Whatever the last `start`/`endLease` was told, so a re-arm does not need the caller to repeat it. */
  idleStopSeconds: number | null;
}

export class DockerLifecycle {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly exec: Exec = dockerExec,
    private readonly httpProbe: Probe = defaultProbe,
  ) {}

  /**
   * Fired when an engine's state actually changes. Set rather than
   * constructor-injected because a lifecycle is built in two places -- the
   * registry makes its own, and `createDoor` makes one to share with the
   * llama routers and hands it in. A constructor argument is silently
   * dropped by the second path, so the owner attaches instead.
   */
  private onStateChange: (id: string) => void = () => undefined;

  onChange(listener: (id: string) => void): void {
    this.onStateChange = listener;
  }

  /**
   * The only place `state` is assigned. A write of the same value is not a
   * change, and every assignment routes through here so a state reached by a
   * path added later is announced without that path remembering to say so.
   */
  private transition(rt: Runtime, state: EngineState): void {
    if (rt.state === state) {
      return;
    }
    rt.state = state;
    this.onStateChange(rt.id);
  }

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        id,
        containerName: `${NAME_PREFIX}${id}`,
        state: "installed",
        hostPort: null,
        startPromise: null,
        idleTimer: null,
        imageCheck: null,
        artifactCheck: null,
        idleStopAttempts: 0,
        activeLeases: 0,
        idleStopSeconds: null,
      };
      this.runtimes.set(id, rt);
    }
    return rt;
  }

  getStatus(id: string): RuntimeStatus {
    const rt = this.runtimes.get(id);
    if (!rt) {
      return { state: "installed", private_url: null };
    }
    return {
      state: rt.state,
      private_url:
        rt.state === "running" && rt.hostPort !== null ? `127.0.0.1:${rt.hostPort}` : null,
      fix: rt.fix,
      last_error: rt.lastError,
      active_leases: rt.state === "running" ? rt.activeLeases : undefined,
    };
  }

  private cancelIdle(rt: Runtime): void {
    if (rt.idleTimer !== null) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = null;
    }
  }

  /**
   * Takes a lease, holding the container open for one in-flight request.
   * Paired with `endLease`, which every path must reach exactly once however
   * it ends -- an unreleased lease pins the engine's GPU for the life of the
   * process, since nothing else re-arms the countdown.
   */
  beginLease(id: string): void {
    const rt = this.runtimes.get(id);
    if (rt?.state !== "running") {
      return;
    }
    rt.activeLeases++;
    this.cancelIdle(rt);
  }

  /** Releases one lease. The countdown re-arms only once the last one is gone, so it can never fire mid-request. */
  endLease(id: string, idleStopSeconds: number): void {
    const rt = this.runtimes.get(id);
    if (rt?.state !== "running") {
      return;
    }
    rt.activeLeases = Math.max(0, rt.activeLeases - 1);
    this.refreshIdle(rt, idleStopSeconds);
  }

  /**
   * Re-arms the countdown whenever nothing holds the container. Called on
   * every start too, not only on a lease end: an engine warmed by
   * `POST /v1/engines/:id/start` and never dispatched to has no lease to end,
   * and before this it stayed resident until the process died.
   */
  private refreshIdle(rt: Runtime, idleStopSeconds: number): void {
    rt.idleStopSeconds = idleStopSeconds;
    this.cancelIdle(rt);
    if (rt.activeLeases > 0 || rt.state !== "running") {
      return;
    }
    rt.idleStopAttempts = 0;
    this.armIdleStop(rt, idleStopSeconds);
  }

  /**
   * A `docker stop` that fails leaves the container running with no traffic
   * to trigger another attempt, so this re-arms itself on the same cadence
   * up to `MAX_IDLE_STOP_RETRIES` -- a single hiccup no longer pins the
   * engine's resources until a fresh request happens to arrive.
   */
  private armIdleStop(rt: Runtime, idleStopSeconds: number): void {
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = null;
      this.stopContainer(rt)
        .then((stopped) => {
          if (!stopped && rt.idleStopAttempts < MAX_IDLE_STOP_RETRIES) {
            rt.idleStopAttempts++;
            this.armIdleStop(rt, idleStopSeconds);
          }
        })
        .catch((err: unknown) => {
          rt.lastError = errMessage(err);
        });
    }, idleStopSeconds * MS_PER_SECOND);
  }

  /**
   * Two concurrent calls for a stopped engine share one in-flight start.
   * `opts.specSource` is the spec's own directory (shipped `engines/<id>`, or
   * a `spec_dir` override) -- optional only so tests that never exercise a
   * `build`-obtain spec can omit it; every real caller has it, straight from
   * `LoadedSpec.source`.
   */
  async start(id: string, spec: ContainerSpec, opts: LifecycleOptions): Promise<RuntimeStatus> {
    const rt = this.runtime(id);
    this.cancelIdle(rt);
    if (rt.state === "running" && rt.hostPort !== null) {
      this.refreshIdle(rt, opts.idleStopSeconds);
      return this.getStatus(id);
    }
    if (rt.startPromise) {
      return rt.startPromise;
    }
    const promise = this.doStart(id, rt, spec, opts);
    rt.startPromise = promise;
    const status = await promise;
    rt.startPromise = null;
    this.refreshIdle(rt, opts.idleStopSeconds);
    return status;
  }

  /**
   * Believed-running state lives only in this map, so a container killed from
   * outside this process leaves it stale and keeps handing out a dead
   * `private_url`. Docker decides: a transient HTTP failure against a
   * container that is genuinely still up leaves the record alone.
   */
  async reconcile(id: string): Promise<RuntimeStatus> {
    const rt = this.runtimes.get(id);
    if (!rt || (rt.state !== "running" && rt.state !== "warming")) {
      return this.getStatus(id);
    }
    const res = await this.exec(["inspect", "-f", "{{.State.Running}}", rt.containerName]);
    if (res.exitCode === 0 && res.stdout.trim() === "true") {
      return this.getStatus(id);
    }
    this.cancelIdle(rt);
    this.transition(rt, "installed");
    rt.hostPort = null;
    return this.getStatus(id);
  }

  /** Reports what an engine's artifacts say, without starting it. */
  async probe(id: string, spec: ContainerSpec, specSource?: string): Promise<RuntimeStatus> {
    const rt = this.runtime(id);
    if (rt.state === "running" || rt.state === "warming") {
      return this.getStatus(id);
    }
    const checked = await this.checkInstallable(id, rt, spec, specSource);
    if (!checked.ok) {
      return checked.status;
    }
    this.transition(rt, "installed");
    rt.fix = undefined;
    rt.lastError = undefined;
    return this.getStatus(id);
  }

  /** Image then artifacts, in that order: an absent image is the cheaper and more likely fault, and its error names the pull. */
  private async checkInstallable(
    id: string,
    rt: Runtime,
    spec: ContainerSpec,
    specSource?: string,
  ): Promise<{ ok: true; containerPort: number } | { ok: false; status: RuntimeStatus }> {
    const image = await this.ensureImageChecked(rt, spec, specSource);
    if (!image.ok) {
      return { ok: false, status: this.fail(id, rt, image.error, image.fix) };
    }
    const artifacts = await this.ensureArtifactsChecked(rt, spec);
    if (!artifacts.ok) {
      return { ok: false, status: this.fail(id, rt, artifacts.error, artifacts.fix) };
    }
    return { ok: true, containerPort: image.containerPort };
  }

  private fail(id: string, rt: Runtime, error: string, fix?: string): RuntimeStatus {
    this.transition(rt, "unavailable");
    rt.fix = fix;
    rt.lastError = error;
    return this.getStatus(id);
  }

  private async doStart(
    id: string,
    rt: Runtime,
    spec: ContainerSpec,
    opts: LifecycleOptions,
  ): Promise<RuntimeStatus> {
    this.transition(rt, "warming");
    rt.fix = undefined;
    rt.lastError = undefined;

    const checked = await this.checkInstallable(id, rt, spec, opts.specSource);
    if (!checked.ok) {
      return checked.status;
    }
    const ran = await this.runContainer(rt.containerName, spec, checked.containerPort);
    if (!ran.ok) {
      return this.fail(id, rt, ran.error);
    }
    const hostPort = await this.readHostPort(rt.containerName, checked.containerPort);
    if (hostPort === null) {
      return this.fail(id, rt, `${rt.containerName}: docker port returned no host binding`);
    }
    const ready = await this.pollReady(
      hostPort,
      spec.ready,
      Date.now() + opts.readyTimeoutS * MS_PER_SECOND,
    );
    if (!ready) {
      return this.fail(
        id,
        rt,
        `${rt.containerName}: ${spec.ready.path} did not reach ${spec.ready.status} within ${opts.readyTimeoutS}s`,
      );
    }

    rt.hostPort = hostPort;
    this.transition(rt, "running");
    rt.imageCheck = null;
    rt.artifactCheck = null;
    return this.getStatus(id);
  }

  /**
   * `pull` always has a runnable fix: the image name is the whole command.
   * `build` does not by default -- `docker build <image>` treats the image
   * name as a context PATH and fails. A real fix needs the spec's own
   * directory, which is where a spec's Dockerfile lives when it has one.
   * `obtain = "build"` with no Dockerfile there means the image was built
   * elsewhere and only tagged locally, so naming a path that does not exist
   * would be the same defect in a new costume.
   */
  private buildImageFix(spec: ContainerSpec, specSource?: string): string {
    if (spec.obtain === "pull") {
      return `docker pull ${spec.image}`;
    }
    const dockerfile = specSource === undefined ? undefined : posix.join(specSource, "Dockerfile");
    if (dockerfile !== undefined && existsSync(dockerfile)) {
      return `docker build -t ${spec.image} -f ${dockerfile} ${specSource}`;
    }
    const where = specSource === undefined ? "" : ` at ${specSource}`;
    return `${spec.image}: no Dockerfile${where} to build from -- this image must already exist locally, built some other way`;
  }

  private async checkImage(
    spec: ContainerSpec,
    specSource?: string,
  ): Promise<Result<{ containerPort: number }>> {
    const res = await this.exec(["image", "inspect", spec.image]);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        fix: this.buildImageFix(spec, specSource),
        error: `${spec.image}: image not present`,
      };
    }
    const parsed = parseExposedPort(res.stdout, spec.image);
    if ("error" in parsed) {
      return { ok: false, error: parsed.error };
    }
    return { ok: true, containerPort: parsed.port };
  }

  /** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix (e.g. `docker pull`) can make it pass, and that fix happens outside this process. */
  private async ensureImageChecked(
    rt: Runtime,
    spec: ContainerSpec,
    specSource?: string,
  ): Promise<Result<{ containerPort: number }>> {
    if (!rt.imageCheck) {
      rt.imageCheck = this.checkImage(spec, specSource);
    }
    const result = await rt.imageCheck;
    if (!result.ok) {
      rt.imageCheck = null;
    }
    return result;
  }

  /** Run when the engine is first asked for; cached until it next starts. A failed check is never cached: only a fix can make it pass, and the fix happens outside this process. */
  private async ensureArtifactsChecked(rt: Runtime, spec: ContainerSpec): Promise<Result> {
    if (spec.artifacts.length === 0) {
      return { ok: true };
    }
    if (!rt.artifactCheck) {
      rt.artifactCheck = this.checkArtifacts(spec);
    }
    const result = await rt.artifactCheck;
    if (!result.ok) {
      rt.artifactCheck = null;
    }
    return result;
  }

  /**
   * A bind-mounted artifact is a plain host `stat` — no container needed.
   * What's left after that (a named volume, or nothing declared to mount it
   * at all) is checked the only way it can be: a short-lived container per
   * artifact, mounting every volume the spec declares.
   */
  private async checkArtifacts(spec: ContainerSpec): Promise<Result> {
    const needsContainer: Artifact[] = [];
    for (const artifact of spec.artifacts) {
      const hostPath = hostPathFor(artifact, spec.volumes);
      if (hostPath === null) {
        needsContainer.push(artifact);
      } else if (!existsSync(hostPath)) {
        return this.missingArtifact(spec.image, artifact);
      }
    }
    if (needsContainer.length === 0) {
      return { ok: true };
    }
    const volumeArgs = spec.volumes.flatMap((v) => ["-v", mountSpec(v)]);
    const checks = await Promise.all(
      needsContainer.map(async (artifact) => ({
        artifact,
        res: await this.exec([
          "run",
          "--rm",
          "--entrypoint",
          "sh",
          ...volumeArgs,
          spec.image,
          "-c",
          `test -e '${artifact.path}'`,
        ]),
      })),
    );
    for (const { artifact, res } of checks) {
      if (res.exitCode === 0) {
        continue;
      }
      if (res.exitCode === DOCKER_START_FAILURE_EXIT_CODE) {
        return {
          ok: false,
          error: `${spec.image}: could not check artifact ${artifact.path} (volume unreachable)`,
        };
      }
      return this.missingArtifact(spec.image, artifact);
    }
    return { ok: true };
  }

  private missingArtifact(image: string, artifact: Artifact): Result {
    return {
      ok: false,
      fix: artifact.obtain,
      error: `${image}: artifact missing at ${artifact.path}`,
    };
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
    spec: ContainerSpec,
    containerPort: number,
  ): Promise<Result> {
    const rm = await this.exec(["rm", "-f", containerName]);
    if (rm.exitCode !== 0 && !NO_SUCH_CONTAINER.test(rm.stderr)) {
      return { ok: false, error: rm.stderr.trim() || `docker rm -f failed for ${containerName}` };
    }
    const run = await this.exec(buildRunArgs(containerName, spec, containerPort));
    if (run.exitCode !== 0) {
      return { ok: false, error: run.stderr.trim() || `docker run failed for ${containerName}` };
    }
    return { ok: true };
  }

  private async readHostPort(containerName: string, containerPort: number): Promise<number | null> {
    const res = await this.exec(["port", containerName, `${containerPort}/tcp`]);
    return res.exitCode === 0 ? parseHostPort(res.stdout) : null;
  }

  /**
   * Polls until ready or past the deadline. Sequential by nature -- each probe
   * only matters once the previous one has failed -- so the awaits belong in a
   * loop rather than a promise chain per interval.
   */
  private async pollReady(hostPort: number, ready: ReadyProbe, deadline: number): Promise<boolean> {
    for (;;) {
      try {
        const res = await this.httpProbe(
          `http://127.0.0.1:${hostPort}${ready.path}`,
          ready.method ?? "GET",
        );
        if (probeSaysReady(ready, res.status)) {
          return true;
        }
      } catch {
        // not listening yet
      }
      if (Date.now() >= deadline) {
        return false;
      }
      await Bun.sleep(READY_POLL_INTERVAL_MS);
    }
  }

  /** A failed `docker stop` leaves the container's real state (still running) alone and records why. Returns whether it actually stopped. */
  private async stopContainer(rt: Runtime): Promise<boolean> {
    this.cancelIdle(rt);
    const res = await this.exec(["stop", rt.containerName]);
    if (res.exitCode !== 0) {
      rt.lastError = res.stderr.trim() || `docker stop failed for ${rt.containerName}`;
      return false;
    }
    this.transition(rt, "installed");
    rt.hostPort = null;
    rt.lastError = undefined;
    rt.activeLeases = 0;
    return true;
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
    const { containerName } = this.runtime(id);
    const res = await this.exec(["logs", "--tail", String(tail), containerName]);
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.trim() || `docker logs failed for ${containerName}` };
    }
    const merged = `${res.stdout}${res.stderr}`.split("\n");
    // A trailing newline yields one empty element that is not a log line.
    if (merged.at(-1) === "") {
      merged.pop();
    }
    return { ok: true, lines: merged };
  }

  /**
   * What the container holds right now, in one `docker exec`. Only meaningful
   * while it is running: a stopped engine has no processes to account for and
   * no cgroup to read, which is a different answer from "holds nothing".
   */
  async resources(id: string): Promise<Result<{ resources: EngineResources }>> {
    const rt = this.runtimes.get(id);
    if (rt?.state !== "running") {
      return { ok: false, error: `"${id}" is not running` };
    }
    const res = await this.exec(["exec", rt.containerName, "sh", "-c", RESOURCE_PROBE_SH]);
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr.trim() || `docker exec failed for ${rt.containerName}`,
      };
    }
    return { ok: true, resources: parseResources(res.stdout) };
  }

  /**
   * Operator-driven stop, down the same path idle-stop takes -- so a stop
   * cancels the pending countdown rather than racing it, and the leases reset
   * with the container they belonged to.
   */
  async stop(id: string): Promise<RuntimeStatus> {
    const rt = this.runtimes.get(id);
    if (rt && (rt.state === "running" || rt.state === "warming")) {
      await this.stopContainer(rt);
    }
    return this.getStatus(id);
  }

  /** An engine that has been running is stopped, never left orphaned. */
  async removeEngine(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    if (!rt) {
      return;
    }
    if (rt.state === "running" || rt.state === "warming") {
      await this.stopContainer(rt);
    }
    this.runtimes.delete(id);
  }

  /** Stops every container this process started. Called at SIGTERM by the door, not from here. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()]
        .filter((rt) => rt.state === "running" || rt.state === "warming")
        .map((rt) => this.stopContainer(rt)),
    );
  }
}
