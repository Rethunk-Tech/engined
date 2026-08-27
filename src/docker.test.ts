import { describe, expect, test } from "bun:test";
import {
  DockerLifecycle,
  type Exec,
  type ExecResult,
  type Probe,
  parseExposedPort,
  parseHostPort,
} from "./docker.ts";
import type { ContainerSpec } from "./types.ts";

/** `docker image inspect redis:alpine`, captured on this box — the one-port case. */
const REDIS_INSPECT = `[
    {
        "Id": "sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576",
        "RepoTags": ["redis:alpine"],
        "Comment": "buildkit.dockerfile.v0",
        "Config": {
            "ExposedPorts": { "6379/tcp": {} },
            "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "REDIS_VERSION=8.10.1"],
            "Entrypoint": ["docker-entrypoint.sh"],
            "Cmd": ["redis-server"],
            "WorkingDir": "/data"
        },
        "Architecture": "amd64",
        "Os": "linux"
    }
]`;

/** `docker image inspect alpine:3.20`, captured on this box — the zero-port case: no `EEXPOSE` in that image at all. */
const ALPINE_INSPECT = `[
    {
        "Id": "sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc",
        "RepoTags": ["alpine:3.20"],
        "Comment": "buildkit.dockerfile.v0",
        "Config": {
            "Env": ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"],
            "Cmd": ["/bin/sh"],
            "WorkingDir": "/"
        },
        "Architecture": "amd64",
        "Os": "linux"
    }
]`;

/** The several-ports case: the real redis structure with a second `ExposedPorts` entry added. */
const MULTI_PORT_INSPECT = (() => {
  const parsed = JSON.parse(REDIS_INSPECT);
  parsed[0].Config.ExposedPorts["16379/tcp"] = {};
  return JSON.stringify(parsed);
})();

describe("parseExposedPort", () => {
  test("one port", () => {
    expect(parseExposedPort(REDIS_INSPECT, "redis:alpine")).toEqual({ port: 6379 });
  });

  test("zero ports", () => {
    expect(parseExposedPort(ALPINE_INSPECT, "alpine:3.20")).toEqual({
      error: "alpine:3.20 exposes no ports",
    });
  });

  test("several ports", () => {
    const result = parseExposedPort(MULTI_PORT_INSPECT, "redis:alpine");
    expect("error" in result && result.error).toContain("6379/tcp");
    expect("error" in result && result.error).toContain("16379/tcp");
  });
});

const RECORDED_HOST_PORT = 32_768;

describe("parseHostPort", () => {
  test("real `docker port <container> <port>/tcp` output, loopback only", () => {
    expect(parseHostPort(`127.0.0.1:${RECORDED_HOST_PORT}`)).toBe(RECORDED_HOST_PORT);
  });

  test("skips the IPv6 wildcard line docker prints alongside the IPv4 one", () => {
    expect(parseHostPort(`0.0.0.0:${RECORDED_HOST_PORT}\n[::]:${RECORDED_HOST_PORT}`)).toBe(
      RECORDED_HOST_PORT,
    );
  });

  test("no binding yet", () => {
    expect(parseHostPort("")).toBeNull();
  });
});

const READY_STATUS = 200;

const SPEC: ContainerSpec = {
  kind: "openai-http",
  serves: ["chat"],
  env: [],
  command: [],
  image: "redis:alpine",
  obtain: "pull",
  devices: [],
  group_add: [],
  security_opt: [],
  volumes: [],
  artifacts: [],
  ready: { path: "/health", status: READY_STATUS },
};

/** Stubbed docker: `start` always misses (forcing `run`), `port` answers with a fixed mapping. */
function stubExec(runLog: string[][], stopLog: string[][], hostPort: number): Exec {
  return (args): Promise<ExecResult> => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
    if (argv[0] === "run") {
      runLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "stop") {
      stopLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
}

/** Function declaration, not a const arrow: avoids a nursery false-positive on serializable closures. */
function readyProbe(): ReturnType<Probe> {
  return Promise.resolve({ status: READY_STATUS });
}

const STUB_HOST_PORT_A = 40_000;
const STUB_HOST_PORT_B = 40_001;
const IDLE_STOP_SECONDS = 0.03;
const OUTLAST_WAIT_MS = 80;
const SHORT_WAIT_MS = 10;
const PAST_IDLE_WAIT_MS = 60;
const START_OPTS = { idleStopSeconds: 60, readyTimeoutS: 1 };

test("start: two concurrent calls against a stopped engine spawn exactly one container", async () => {
  const runLog: string[][] = [];
  const lifecycle = new DockerLifecycle(stubExec(runLog, [], STUB_HOST_PORT_A), readyProbe);
  const [a, b] = await Promise.all([
    lifecycle.start("redis", SPEC, START_OPTS),
    lifecycle.start("redis", SPEC, START_OPTS),
  ]);
  expect(runLog.length).toBe(1);
  expect(a).toEqual(b);
  expect(a).toEqual({
    state: "running",
    private_url: `127.0.0.1:${STUB_HOST_PORT_A}`,
    fix: undefined,
    last_error: undefined,
  });
});

test("idle timer fires only after the lease ends, and a fresh start cancels a pending stop", async () => {
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(stubExec([], stopLog, STUB_HOST_PORT_B), readyProbe);
  const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: 1 };

  await lifecycle.start("idle-test", SPEC, opts);

  // No lease has ended: outlasting idleStopSeconds must not stop it mid-use.
  await new Promise((resolve) => setTimeout(resolve, OUTLAST_WAIT_MS));
  expect(stopLog.length).toBe(0);
  expect(lifecycle.getStatus("idle-test").state).toBe("running");

  // Lease ends: idle-stop is armed now, and fires after idleStopSeconds.
  lifecycle.endLease("idle-test", opts.idleStopSeconds);
  await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
  expect(stopLog.length).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, PAST_IDLE_WAIT_MS));
  expect(stopLog.length).toBe(1);
  expect(lifecycle.getStatus("idle-test").state).toBe("installed");

  // A new start after a lease end cancels the pending stop rather than racing it.
  await lifecycle.start("idle-test", SPEC, opts);
  lifecycle.endLease("idle-test", opts.idleStopSeconds);
  await new Promise((resolve) => setTimeout(resolve, SHORT_WAIT_MS));
  await lifecycle.start("idle-test", SPEC, opts);
  await new Promise((resolve) => setTimeout(resolve, PAST_IDLE_WAIT_MS));
  expect(stopLog.length).toBe(1);
});

test("adopt: keeps and re-reads the configured container, stops the unconfigured one", async () => {
  const stopLog: string[][] = [];
  const hostPort = 40_002;

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    if (argv[0] === "ps") {
      return Promise.resolve({
        stdout: "engined-configured\nengined-orphan\n",
        stderr: "",
        exitCode: 0,
      });
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "stop") {
      stopLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  await lifecycle.adopt(
    new Map([["configured", { spec: SPEC, idleStopSeconds: IDLE_STOP_SECONDS }]]),
  );

  // The configured id is kept and its port re-read from docker, not guessed.
  expect(lifecycle.getStatus("configured")).toEqual({
    state: "running",
    private_url: `127.0.0.1:${hostPort}`,
    fix: undefined,
    last_error: undefined,
  });
  // The id no longer in config is stopped, not left orphaned.
  expect(stopLog).toEqual([["stop", "engined-orphan"]]);

  // Adoption restarts the idle timer: with nothing acquiring the lease, the
  // re-adopted container is stopped on its own once idleStopSeconds elapses.
  await new Promise((resolve) => setTimeout(resolve, PAST_IDLE_WAIT_MS));
  expect(stopLog).toEqual([
    ["stop", "engined-orphan"],
    ["stop", "engined-configured"],
  ]);
  expect(lifecycle.getStatus("configured").state).toBe("installed");
});

test("start: a failed artifact check is not cached — a repaired condition re-runs it and succeeds", async () => {
  const specWithArtifact: ContainerSpec = {
    ...SPEC,
    artifacts: [
      { path: "/models/x.gguf", obtain: "curl -o /models/x.gguf https://example/x.gguf" },
    ],
  };
  const STARTS_BEFORE_REPAIR = 2;
  const STARTS_AFTER_REPAIR = 3;
  const artifactState: { present: boolean; checkCount: number } = { present: false, checkCount: 0 };

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "run" && argv[1] === "--rm") {
      artifactState.checkCount++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: artifactState.present ? 0 : 1 });
    }
    if (argv[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
    if (argv[0] === "run") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: "127.0.0.1:40010", stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);

  const first = await lifecycle.start("needs-artifact", specWithArtifact, START_OPTS);
  expect(first.state).toBe("unavailable");
  expect(artifactState.checkCount).toBe(1);

  // Second start before the artifact is repaired must still report unavailable,
  // proving the cache clear didn't just make the first result silently pass.
  const stillMissing = await lifecycle.start("needs-artifact", specWithArtifact, START_OPTS);
  expect(stillMissing.state).toBe("unavailable");
  expect(artifactState.checkCount).toBe(STARTS_BEFORE_REPAIR);

  artifactState.present = true;
  const repaired = await lifecycle.start("needs-artifact", specWithArtifact, START_OPTS);
  expect(repaired.state).toBe("running");
  expect(artifactState.checkCount).toBe(STARTS_AFTER_REPAIR);
});

test("probe: reports unavailable and the matching fix without ever starting a container", async () => {
  const runLog: string[][] = [];

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: "", stderr: "no such image", exitCode: 1 });
    }
    if (argv[0] === "run") {
      runLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);

  const pullStatus = await lifecycle.probe("pull-engine", SPEC);
  expect(pullStatus.state).toBe("unavailable");
  expect(pullStatus.fix).toContain("docker pull");

  const buildSpec: ContainerSpec = { ...SPEC, obtain: "build" };
  const buildStatus = await lifecycle.probe("build-engine", buildSpec);
  expect(buildStatus.state).toBe("unavailable");
  expect(buildStatus.fix).toContain("docker build");

  expect(runLog.length).toBe(0);
});

test("probe: a container already running is left alone, not re-checked or restarted", async () => {
  const lifecycle = new DockerLifecycle(stubExec([], [], STUB_HOST_PORT_A), readyProbe);
  const started = await lifecycle.start("already-running", SPEC, START_OPTS);
  expect(started.state).toBe("running");

  const probed = await lifecycle.probe("already-running", SPEC);
  expect(probed).toEqual(started);
});

test("adopt: a container whose port cannot be read is reported running with last_error, never plainly installed", async () => {
  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    if (argv[0] === "ps") {
      return Promise.resolve({ stdout: "engined-unreadable\n", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  await lifecycle.adopt(
    new Map([["unreadable", { spec: SPEC, idleStopSeconds: IDLE_STOP_SECONDS }]]),
  );

  const status = lifecycle.getStatus("unreadable");
  expect(status.state).toBe("running");
  expect(status.state).not.toBe("installed");
  expect(status.last_error).toBeDefined();
});

test("idle-stop failure is recorded as last_error, not thrown, and the container stays running", async () => {
  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
    if (argv[0] === "run") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: "127.0.0.1:40003", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "stop") {
      return Promise.resolve({ stdout: "", stderr: "container is not running", exitCode: 1 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: 1 };
  await lifecycle.start("flaky-stop", SPEC, opts);

  lifecycle.endLease("flaky-stop", opts.idleStopSeconds);
  await new Promise((resolve) => setTimeout(resolve, PAST_IDLE_WAIT_MS));

  const status = lifecycle.getStatus("flaky-stop");
  expect(status.state).toBe("running");
  expect(status.last_error).toBe("container is not running");
});

test("readiness honours a POST probe and an accept range, not just an exact GET status", async () => {
  // whisper answers only its inference path, only to POST, and a 4xx there still
  // proves the route exists. A probe that degraded to `GET` and `=== status`
  // would never report ready, and the engine would stall until its timeout.
  const BAD_REQUEST = 400;
  const ACCEPT_MIN = 200;
  const ACCEPT_MAX = 499;
  const methods: string[] = [];
  const postSpec = {
    ...SPEC,
    ready: {
      path: "/v1/audio/transcriptions",
      status: READY_STATUS,
      method: "POST" as const,
      accept: { min: ACCEPT_MIN, max: ACCEPT_MAX },
    },
  };
  function recordingProbe(_url: string, method: "GET" | "POST"): ReturnType<Probe> {
    methods.push(method);
    return Promise.resolve({ status: BAD_REQUEST });
  }

  const lifecycle = new DockerLifecycle(stubExec([], [], STUB_HOST_PORT_A), recordingProbe);
  const status = await lifecycle.start("whisper", postSpec, START_OPTS);

  expect(status.state).toBe("running");
  expect(methods).toEqual(["POST"]);
});

test("start: a stale container by this name is removed and recreated from the current spec, never resumed with docker start", async () => {
  const calls: string[][] = [];
  const DISTINGUISHING_ARG = "--ctx-size=8192";
  const currentSpec: ContainerSpec = { ...SPEC, command: [DISTINGUISHING_ARG] };
  const hostPort = 40_020;

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "rm") {
      // A stopped container by this name existed and is removed.
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "run") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const status = await lifecycle.start("stale", currentSpec, START_OPTS);

  expect(status.state).toBe("running");
  expect(calls.some((c) => c[0] === "rm" && c[1] === "engined-stale")).toBe(true);
  expect(calls.some((c) => c[0] === "start")).toBe(false);
  const runCall = calls.find((c) => c[0] === "run" && c.includes("--name"));
  expect(runCall).toContain(DISTINGUISHING_ARG);
});

test("adopt: a running container is adopted in place, never removed or recreated", async () => {
  const calls: string[][] = [];
  const hostPort = 40_021;

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] === "ps") {
      return Promise.resolve({ stdout: "engined-live\n", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  await lifecycle.adopt(new Map([["live", { spec: SPEC, idleStopSeconds: IDLE_STOP_SECONDS }]]));

  // Adopted in place: port re-read from the live container, nothing torn down or rebuilt.
  expect(lifecycle.getStatus("live")).toEqual({
    state: "running",
    private_url: `127.0.0.1:${hostPort}`,
    fix: undefined,
    last_error: undefined,
  });
  expect(calls.some((c) => c[0] === "rm")).toBe(false);
  expect(calls.some((c) => c[0] === "run")).toBe(false);
  expect(calls.some((c) => c[0] === "start")).toBe(false);

  // Adoption also restarts the idle timer: with nothing acquiring the lease,
  // the adopted container is stopped on its own once idleStopSeconds elapses.
  await new Promise((resolve) => setTimeout(resolve, PAST_IDLE_WAIT_MS));
  expect(calls.some((c) => c[0] === "stop" && c[1] === "engined-live")).toBe(true);
  expect(lifecycle.getStatus("live").state).toBe("installed");
});

test("a 404 never counts as ready, even inside the accept range", async () => {
  const NOT_FOUND = 404;
  const ACCEPT_MIN = 200;
  const ACCEPT_MAX = 499;
  const notFoundSpec = {
    ...SPEC,
    ready: {
      path: "/v1/audio/transcriptions",
      status: READY_STATUS,
      method: "POST" as const,
      accept: { min: ACCEPT_MIN, max: ACCEPT_MAX },
    },
  };
  function notFoundProbe(): ReturnType<Probe> {
    return Promise.resolve({ status: NOT_FOUND });
  }

  const lifecycle = new DockerLifecycle(stubExec([], [], STUB_HOST_PORT_A), notFoundProbe);
  const status = await lifecycle.start("whisper", notFoundSpec, {
    idleStopSeconds: 60,
    readyTimeoutS: 0.05,
  });

  expect(status.state).not.toBe("running");
});
