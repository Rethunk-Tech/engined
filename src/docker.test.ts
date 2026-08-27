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
