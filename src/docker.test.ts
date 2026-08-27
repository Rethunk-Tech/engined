import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DockerLifecycle,
  type Exec,
  type ExecResult,
  hostPathFor,
  type Probe,
  parseExposedPort,
  parseHostPort,
} from "./docker.ts";
import type { ContainerSpec, Volume } from "./types.ts";

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

/**
 * Stubbed docker: `start` always misses (forcing `run`), `port` answers with
 * a fixed mapping. `runDelayMs` holds `run` pending for a real tick before
 * resolving -- the start-lock race test needs this: without a genuine delay,
 * a broken lock could still coincidentally log one `run` if both calls
 * happened to interleave microtask-perfectly, which proves nothing about a
 * future regression that adds a real `await` between the lock's check and
 * its set. Every other caller passes 0 and sees no behaviour change.
 */
function stubExec(runLog: string[][], stopLog: string[][], hostPort: number, runDelayMs = 0): Exec {
  return async (args): Promise<ExecResult> => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return { stdout: REDIS_INSPECT, stderr: "", exitCode: 0 };
    }
    if (argv[0] === "start") {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (argv[0] === "run") {
      runLog.push(argv);
      if (runDelayMs > 0) {
        await Bun.sleep(runDelayMs);
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (argv[0] === "port") {
      return { stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 };
    }
    if (argv[0] === "stop") {
      stopLog.push(argv);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
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

const RACE_RUN_DELAY_MS = 40;
/** Comfortably inside RACE_RUN_DELAY_MS -- the first `run` must still be pending here, proving genuine overlap rather than sequencing. */
const RACE_MIDFLIGHT_CHECK_MS = 10;

test("start: two concurrent calls against a stopped engine spawn exactly one container", async () => {
  const runLog: string[][] = [];
  const lifecycle = new DockerLifecycle(
    stubExec(runLog, [], STUB_HOST_PORT_A, RACE_RUN_DELAY_MS),
    readyProbe,
  );

  // Neither call is awaited before the other is issued -- both are in
  // flight together, not sequenced.
  const first = lifecycle.start("redis", SPEC, START_OPTS);
  const second = lifecycle.start("redis", SPEC, START_OPTS);

  // Checked while the first `run` is still pending (RACE_RUN_DELAY_MS has
  // not elapsed): a broken lock would have already logged a second `run`
  // for the second call by now, since it never waits on the first.
  await Bun.sleep(RACE_MIDFLIGHT_CHECK_MS);
  expect(runLog.length).toBe(1);

  const [a, b] = await Promise.all([first, second]);
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

describe("hostPathFor", () => {
  const bindMount: Volume = { name: "/data/whisper", path: "/models" };
  const namedVolume: Volume = { name: "whisper-models", path: "/models" };

  test("bind-mounted volume resolves to a host path", () => {
    expect(hostPathFor({ path: "/models/x.bin", obtain: "" }, [bindMount])).toBe(
      "/data/whisper/x.bin",
    );
  });

  test("named (non-path) volume is not host-visible", () => {
    expect(hostPathFor({ path: "/models/x.bin", obtain: "" }, [namedVolume])).toBeNull();
  });

  test("no volume covers the artifact's path", () => {
    expect(hostPathFor({ path: "/models/x.bin", obtain: "" }, [])).toBeNull();
  });
});

test("start: a bind-mounted artifact is checked with a host stat, never a container", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engined-artifact-"));
  try {
    const specWithBindMount: ContainerSpec = {
      ...SPEC,
      volumes: [{ name: dir, path: "/models" }],
      artifacts: [
        { path: "/models/x.gguf", obtain: `curl -o ${dir}/x.gguf https://example/x.gguf` },
      ],
    };
    const calls: string[][] = [];
    function exec(args: readonly string[]): Promise<ExecResult> {
      const argv = [...args];
      calls.push(argv);
      if (argv[0] === "image" && argv[1] === "inspect") {
        return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
      }
      if (argv[0] === "port") {
        return Promise.resolve({ stdout: "127.0.0.1:40030", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    const lifecycle = new DockerLifecycle(exec, readyProbe);

    // Missing: unavailable, carrying the artifact's own obtain command, never a container run.
    const missing = await lifecycle.start("bind-artifact", specWithBindMount, START_OPTS);
    expect(missing.state).toBe("unavailable");
    expect(missing.fix).toBe(specWithBindMount.artifacts[0]?.obtain);

    // Present: a startable engine, still without a container run to check it.
    writeFileSync(join(dir, "x.gguf"), "weights");
    const present = await lifecycle.start("bind-artifact", specWithBindMount, START_OPTS);
    expect(present.state).toBe("running");

    expect(calls.some((c) => c[0] === "run" && c[1] === "--rm")).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: a missing pull-obtain image reports a runnable docker pull, and starts no container", async () => {
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
  expect(pullStatus.fix).toBe(`docker pull ${SPEC.image}`);
  expect(runLog.length).toBe(0);
});

test("probe: a missing build-obtain image whose spec dir HAS a Dockerfile reports a runnable docker build", async () => {
  // `docker build <image>` (no `-t`/`-f`/context) is not runnable -- it treats
  // the image name as a context PATH. Confirmed pre-fix: buildStatus.fix was
  // exactly `docker build sagaforge-llama-cpp:local`, which fails the same
  // way if pasted.
  const dir = mkdtempSync(join(tmpdir(), "engined-dockerfile-"));
  try {
    writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
    const buildSpec: ContainerSpec = { ...SPEC, obtain: "build", image: "engined-kokoro:local" };

    function exec(args: readonly string[]): Promise<ExecResult> {
      const argv = [...args];
      if (argv[0] === "image" && argv[1] === "inspect") {
        return Promise.resolve({ stdout: "", stderr: "no such image", exitCode: 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }

    const lifecycle = new DockerLifecycle(exec, readyProbe);
    const status = await lifecycle.probe("kokoro", buildSpec, dir);

    expect(status.state).toBe("unavailable");
    expect(status.fix).toBe(`docker build -t engined-kokoro:local -f ${dir}/Dockerfile ${dir}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: a missing build-obtain image whose spec dir has NO Dockerfile does not invent a path that doesn't exist", async () => {
  // A synthetic stand-in, not a real shipped engine -- every engine this
  // repo actually ships now has a Dockerfile beside its spec (local-llama
  // got its own this session, the scenario this test was originally
  // modelled on). The shape under test still exists in principle -- obtain
  // = "build" naming an image built from a different repository entirely,
  // with nothing shipped here to build it from -- so it stays covered
  // against a fixture invented for the purpose rather than a real engine's
  // name, which would otherwise drift out from under this test again the
  // next time a real engine gains its own Dockerfile. A `-f <dir>/Dockerfile`
  // hint would name a file that does not exist -- the same defect in a new
  // costume -- so this must not contain the literal string "docker build".
  const dir = mkdtempSync(join(tmpdir(), "engined-no-dockerfile-"));
  try {
    const buildSpec: ContainerSpec = {
      ...SPEC,
      obtain: "build",
      image: "no-dockerfile-example:local",
    };

    function exec(args: readonly string[]): Promise<ExecResult> {
      const argv = [...args];
      if (argv[0] === "image" && argv[1] === "inspect") {
        return Promise.resolve({ stdout: "", stderr: "no such image", exitCode: 1 });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }

    const lifecycle = new DockerLifecycle(exec, readyProbe);
    const status = await lifecycle.probe("no-dockerfile-example", buildSpec, dir);

    expect(status.state).toBe("unavailable");
    expect(status.fix).not.toContain("docker build");
    expect(status.fix).toContain("no-dockerfile-example:local");
    expect(status.fix).toContain(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: a container already running is left alone, not re-checked or restarted", async () => {
  const lifecycle = new DockerLifecycle(stubExec([], [], STUB_HOST_PORT_A), readyProbe);
  const started = await lifecycle.start("already-running", SPEC, START_OPTS);
  expect(started.state).toBe("running");

  const probed = await lifecycle.probe("already-running", SPEC);
  expect(probed).toEqual(started);
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
  expect(calls.some((c) => c[0] === "rm" && c.includes("-f") && c.includes("engined-stale"))).toBe(
    true,
  );
  expect(calls.some((c) => c[0] === "start")).toBe(false);
  const runCall = calls.find((c) => c[0] === "run" && c.includes("--name"));
  expect(runCall).toContain(DISTINGUISHING_ARG);
});

test("start: a container already running under this name is force-removed and recreated, not left name-conflicted", async () => {
  // Real docker: `docker rm` without `-f` refuses a running container, and the
  // `docker run` that follows then fails 125 "Conflict ... name already in
  // use". This models both commands' real exit behaviour so the test fails
  // against code that either omits `-f` or ignores rm's result.
  const calls: string[][] = [];
  const hostPort = 40_022;
  let removed = false;

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "rm") {
      if (argv.includes("-f")) {
        removed = true;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({
        stdout: "",
        stderr:
          "Error response from daemon: You cannot remove a running container ... Stop the container before attempting removal or force remove",
        exitCode: 1,
      });
    }
    if (argv[0] === "run") {
      if (!removed) {
        const DOCKER_NAME_CONFLICT_EXIT_CODE = 125;
        return Promise.resolve({
          stdout: "",
          stderr:
            'docker: Error response from daemon: Conflict. The container name "/engined-running-conflict" is already in use by container ...',
          exitCode: DOCKER_NAME_CONFLICT_EXIT_CODE,
        });
      }
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const status = await lifecycle.start("running-conflict", SPEC, START_OPTS);

  expect(status.state).toBe("running");
  expect(calls.some((c) => c[0] === "rm" && c.includes("-f"))).toBe(true);
});

test("start: a genuine docker rm failure is surfaced, not swallowed into a doomed run", async () => {
  const calls: string[][] = [];

  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: REDIS_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "rm") {
      return Promise.resolve({
        stdout: "",
        stderr: "Error response from daemon: driver failed programming external connectivity",
        exitCode: 1,
      });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const status = await lifecycle.start("rm-fails", SPEC, START_OPTS);

  expect(status.state).toBe("unavailable");
  expect(status.last_error).toContain("driver failed programming external connectivity");
  expect(calls.some((c) => c[0] === "run")).toBe(false);
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
