/**
 * Generic managed-engine lifecycle: start-on-demand behind a per-engine start
 * lock, adoption of a still-running `engined-*` container, port read-back,
 * readiness and idle-stop. Every engine kind plays a `ContainerSpec` through
 * this same machinery; nothing here is llama, Comfy or audio specific.
 *
 * Parsing is pure and takes strings. Only `dockerExec` and `defaultProbe`
 * touch a process or a socket, so everything else runs with no docker and no
 * network installed.
 */

import { spawn } from "node:child_process";
import process from "node:process";
import type { Artifact, ContainerSpec, EngineState, ReadyProbe } from "./types.ts";

const NAME_PREFIX = "engined-";
const MS_PER_SECOND = 1000;
const READY_POLL_INTERVAL_MS = 250;
/** docker's own "could not start the container" exit code, distinct from the command that ran failing. */
const DOCKER_START_FAILURE_EXIT_CODE = 125;
const HOST_PORT_LINE = /^(?<addr>\d{1,3}(?:\.\d{1,3}){3}):(?<port>\d+)$/;

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type Exec = (args: readonly string[]) => Promise<ExecResult>;

export function dockerExec(args: readonly string[]): Promise<ExecResult> {
  return new Promise((resolve) => {
    const proc = spawn("docker", args);
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

export type Probe = (url: string) => Promise<{ status: number }>;

async function defaultProbe(url: string): Promise<{ status: number }> {
  const res = await fetch(url);
  return { status: res.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type PortResult = { port: number } | { error: string };

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

export function parseContainerNames(psOutput: string): string[] {
  return psOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
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
    args.push("-v", `${volume.name}:${volume.path}`);
  }
  const [entryBin, ...entryRest] = spec.entrypoint ?? [];
  if (entryBin !== undefined) {
    args.push("--entrypoint", entryBin);
  }
  args.push(spec.image, ...entryRest, ...spec.command);
  return args;
}

export interface LifecycleOptions {
  idleStopSeconds: number;
  readyTimeoutS: number;
}

export interface RuntimeStatus {
  state: EngineState;
  private_url: string | null;
  fix?: string;
  last_error?: string;
}

type Result<T = unknown> = ({ ok: true } & T) | { ok: false; fix?: string; error: string };

interface Runtime {
  containerName: string;
  state: EngineState;
  hostPort: number | null;
  fix?: string;
  lastError?: string;
  startPromise: Promise<RuntimeStatus> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  artifactCheck: Promise<Result> | null;
}

export class DockerLifecycle {
  private readonly runtimes = new Map<string, Runtime>();

  constructor(
    private readonly exec: Exec = dockerExec,
    private readonly probe: Probe = defaultProbe,
  ) {}

  private runtime(id: string): Runtime {
    let rt = this.runtimes.get(id);
    if (!rt) {
      rt = {
        containerName: `${NAME_PREFIX}${id}`,
        state: "installed",
        hostPort: null,
        startPromise: null,
        idleTimer: null,
        artifactCheck: null,
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
    };
  }

  private cancelIdle(rt: Runtime): void {
    if (rt.idleTimer !== null) {
      clearTimeout(rt.idleTimer);
      rt.idleTimer = null;
    }
  }

  /** Arms idle-stop for the lease that just ended. Never call at request start: a timer armed there fires mid-stream. */
  endLease(id: string, idleStopSeconds: number): void {
    const rt = this.runtimes.get(id);
    if (rt?.state !== "running") {
      return;
    }
    this.cancelIdle(rt);
    rt.idleTimer = setTimeout(() => {
      rt.idleTimer = null;
      this.stopContainer(rt).catch(() => undefined);
    }, idleStopSeconds * MS_PER_SECOND);
  }

  /** Two concurrent calls for a stopped engine share one in-flight start. */
  async start(id: string, spec: ContainerSpec, opts: LifecycleOptions): Promise<RuntimeStatus> {
    const rt = this.runtime(id);
    this.cancelIdle(rt);
    if (rt.state === "running" && rt.hostPort !== null) {
      return this.getStatus(id);
    }
    if (rt.startPromise) {
      return rt.startPromise;
    }
    const promise = this.doStart(id, rt, spec, opts);
    rt.startPromise = promise;
    const status = await promise;
    rt.startPromise = null;
    return status;
  }

  private fail(id: string, rt: Runtime, error: string, fix?: string): RuntimeStatus {
    rt.state = "unavailable";
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
    rt.state = "warming";
    rt.fix = undefined;
    rt.lastError = undefined;

    const image = await this.checkImage(spec);
    if (!image.ok) {
      return this.fail(id, rt, image.error, image.fix);
    }
    const artifacts = await this.ensureArtifactsChecked(rt, spec);
    if (!artifacts.ok) {
      return this.fail(id, rt, artifacts.error, artifacts.fix);
    }
    const ran = await this.runContainer(rt.containerName, spec, image.containerPort);
    if (!ran.ok) {
      return this.fail(id, rt, ran.error);
    }
    const hostPort = await this.readHostPort(rt.containerName, image.containerPort);
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
    rt.state = "running";
    rt.artifactCheck = null;
    return this.getStatus(id);
  }

  private async checkImage(spec: ContainerSpec): Promise<Result<{ containerPort: number }>> {
    const res = await this.exec(["image", "inspect", spec.image]);
    if (res.exitCode !== 0) {
      const fix =
        spec.obtain === "pull" ? `docker pull ${spec.image}` : `docker build ${spec.image}`;
      return { ok: false, fix, error: `${spec.image}: image not present` };
    }
    const parsed = parseExposedPort(res.stdout, spec.image);
    if ("error" in parsed) {
      return { ok: false, error: parsed.error };
    }
    return { ok: true, containerPort: parsed.port };
  }

  /** Run when the engine is first asked for; cached until it next starts. */
  private ensureArtifactsChecked(rt: Runtime, spec: ContainerSpec): Promise<Result> {
    if (spec.artifacts.length === 0) {
      return Promise.resolve({ ok: true });
    }
    if (!rt.artifactCheck) {
      rt.artifactCheck = this.checkArtifacts(spec);
    }
    return rt.artifactCheck;
  }

  /** One short-lived container per artifact, mounting the volume it should live in. */
  private async checkArtifacts(spec: ContainerSpec): Promise<Result> {
    const volumeArgs = spec.volumes.flatMap((v) => ["-v", `${v.name}:${v.path}`]);
    const checks = await Promise.all(
      spec.artifacts.map(async (artifact) => ({
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

  private async runContainer(
    containerName: string,
    spec: ContainerSpec,
    containerPort: number,
  ): Promise<Result> {
    const started = await this.exec(["start", containerName]);
    if (started.exitCode === 0) {
      return { ok: true };
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

  /** Recursive rather than looping so a poll-retry never trips an await-in-loop shape. */
  private async pollReady(hostPort: number, ready: ReadyProbe, deadline: number): Promise<boolean> {
    try {
      const res = await this.probe(`http://127.0.0.1:${hostPort}${ready.path}`);
      if (res.status === ready.status) {
        return true;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await sleep(READY_POLL_INTERVAL_MS);
    return this.pollReady(hostPort, ready, deadline);
  }

  private async stopContainer(rt: Runtime): Promise<void> {
    this.cancelIdle(rt);
    await this.exec(["stop", rt.containerName]);
    rt.state = "installed";
    rt.hostPort = null;
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

  /**
   * On startup: find every `engined-*` container, re-read its port, restart
   * its idle timer, and keep serving from it. One still running for an id no
   * longer in `specs` is stopped rather than left orphaned.
   */
  async adopt(
    specs: ReadonlyMap<string, { spec: ContainerSpec; idleStopSeconds: number }>,
  ): Promise<void> {
    const res = await this.exec([
      "ps",
      "--filter",
      `name=^${NAME_PREFIX}`,
      "--format",
      "{{.Names}}",
    ]);
    if (res.exitCode !== 0) {
      return;
    }
    await Promise.all(
      parseContainerNames(res.stdout).map((containerName) => {
        const id = containerName.slice(NAME_PREFIX.length);
        const entry = specs.get(id);
        return entry
          ? this.adoptOne(id, containerName, entry.spec, entry.idleStopSeconds)
          : this.exec(["stop", containerName]).then(() => undefined);
      }),
    );
  }

  private async adoptOne(
    id: string,
    containerName: string,
    spec: ContainerSpec,
    idleStopSeconds: number,
  ): Promise<void> {
    const image = await this.checkImage(spec);
    if (!image.ok) {
      return;
    }
    const hostPort = await this.readHostPort(containerName, image.containerPort);
    if (hostPort === null) {
      return;
    }
    const rt = this.runtime(id);
    rt.state = "running";
    rt.hostPort = hostPort;
    this.endLease(id, idleStopSeconds);
  }

  /** Stops every container this process started or adopted. Called at SIGTERM by the door, not from here. */
  async shutdown(): Promise<void> {
    await Promise.all(
      [...this.runtimes.values()]
        .filter((rt) => rt.state === "running" || rt.state === "warming")
        .map((rt) => this.stopContainer(rt)),
    );
  }
}
