import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DockerLifecycle, type Probe } from "./docker.ts";
import {
  buildRunArgs,
  hostPathFor,
  parseExposedPort,
  parseHostPort,
  specDigest,
} from "./dockerArgs.ts";
import type { Exec, ExecResult } from "./exec.ts";
import { buildExec, containerRunning, makeTestRoot } from "./test-support.ts";
import type { RunnableContainerSpec, Volume } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-docker-");

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

const SPEC: RunnableContainerSpec = {
  kind: "openai-http",
  serves: ["chat"],
  env: [],
  command: [],
  upstream: "self",
  image: "redis:alpine",
  obtain: "pull",
  devices: [],
  group_add: [],
  security_opt: [],
  init: false,
  streaming: false,
  volumes: [],
  artifacts: [],
  ready: { path: "/health", status: READY_STATUS },
};

/** Function declaration, not a const arrow: avoids a nursery false-positive on serializable closures. */
function readyProbe(): ReturnType<Probe> {
  return Promise.resolve({ status: READY_STATUS });
}

/** A successful, empty `ExecResult` -- the default for any command a fake `exec` doesn't care about. */
function ok(): ExecResult {
  return { stdout: "", stderr: "", exitCode: 0 };
}

/** `docker image inspect` success: the redis fixture is present. */
function inspectFound(): ExecResult {
  return { stdout: REDIS_INSPECT, stderr: "", exitCode: 0 };
}

/** `docker image inspect` failure: no such image locally. */
function inspectMissing(): ExecResult {
  return { stdout: "", stderr: "no such image", exitCode: 1 };
}

/** `docker start` miss on a stopped/absent container: forces the caller to `run` instead. */
function startMiss(): ExecResult {
  return { stdout: "", stderr: "", exitCode: 1 };
}

/** `docker port` success: the container answers on the given host port. */
function portFound(hostPort: number): ExecResult {
  return { stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 };
}

/**
 * A recording `Exec`: logs every call's argv into `calls`, always reports
 * `docker image inspect` as the redis fixture present, and defers any other
 * verb to `rest` -- returning `undefined` from `rest` falls through to a bare
 * success.
 */
function recordingExec(
  calls: string[][],
  rest: (argv: readonly string[]) => ExecResult | undefined,
): Exec {
  return (args) => {
    const argv = [...args];
    calls.push(argv);
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve(inspectFound());
    }
    return Promise.resolve(rest(argv) ?? ok());
  };
}

/** An `Exec` that answers `docker image inspect` via `onInspect` and counts how many times it was asked; every other verb succeeds. */
function inspectCountingExec(counter: { count: number }, onInspect: () => ExecResult): Exec {
  return (args) => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      counter.count++;
      return Promise.resolve(onInspect());
    }
    return Promise.resolve(ok());
  };
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
    buildExec({ runLog, port: STUB_HOST_PORT_A, runDelayMs: RACE_RUN_DELAY_MS }),
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
  // Same container, but only one call actually ran `doStart` -- `launched`
  // is the one field the shared lock does not equalize between them.
  const { launched: aLaunched, ...aRest } = a;
  const { launched: bLaunched, ...bRest } = b;
  expect(aRest).toEqual(bRest);
  expect([aLaunched, bLaunched].sort()).toEqual([false, true]);
  expect(aRest).toEqual({
    state: "running",
    private_url: `127.0.0.1:${STUB_HOST_PORT_A}`,
    fix: undefined,
    last_error: undefined,
    active_leases: 0,
  });
});

test("a held lease outlasts idle-stop; a lease-less start still counts down", async () => {
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(buildExec({ stopLog, port: STUB_HOST_PORT_B }), readyProbe);
  const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: 1 };

  await lifecycle.start("idle-test", SPEC, opts);
  lifecycle.beginLease("idle-test");

  // A lease is held: outlasting idleStopSeconds must not stop it mid-use.
  await Bun.sleep(OUTLAST_WAIT_MS);
  expect(stopLog.length).toBe(0);
  expect(lifecycle.getStatus("idle-test").state).toBe("running");

  // Last lease ends: idle-stop is armed now, and fires after idleStopSeconds.
  lifecycle.endLease("idle-test", opts.idleStopSeconds);
  await Bun.sleep(SHORT_WAIT_MS);
  expect(stopLog.length).toBe(0);
  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(1);
  expect(lifecycle.getStatus("idle-test").state).toBe("installed");

  // A new start after a lease end cancels the pending stop rather than racing it.
  await lifecycle.start("idle-test", SPEC, opts);
  lifecycle.beginLease("idle-test");
  lifecycle.endLease("idle-test", opts.idleStopSeconds);
  await Bun.sleep(SHORT_WAIT_MS);
  await lifecycle.start("idle-test", SPEC, opts);
  lifecycle.beginLease("idle-test");
  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(1);
});

test("an engine warmed by start and never dispatched to still idle-stops", async () => {
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(buildExec({ stopLog, port: STUB_HOST_PORT_B }), readyProbe);

  // POST /engined/v1/engines/:id/start with no request behind it: nothing will ever
  // call endLease, so before the countdown was armed here too this container
  // stayed resident -- holding its GPU -- until the process died.
  await lifecycle.start("warm-only", SPEC, {
    idleStopSeconds: IDLE_STOP_SECONDS,
    readyTimeoutS: 1,
  });

  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(1);
  expect(lifecycle.getStatus("warm-only").state).toBe("installed");
});

test("concurrent leases: the countdown starts only when the last one is released", async () => {
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(buildExec({ stopLog, port: STUB_HOST_PORT_B }), readyProbe);
  const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: 1 };

  await lifecycle.start("two-leases", SPEC, opts);
  lifecycle.beginLease("two-leases");
  lifecycle.beginLease("two-leases");

  lifecycle.endLease("two-leases", opts.idleStopSeconds);
  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(0);
  expect(lifecycle.getStatus("two-leases").state).toBe("running");

  lifecycle.endLease("two-leases", opts.idleStopSeconds);
  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(1);
});

test("start: a failed artifact check is not cached — a repaired condition re-runs it and succeeds", async () => {
  const specWithArtifact: RunnableContainerSpec = {
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
      return Promise.resolve(inspectFound());
    }
    if (argv[0] === "run" && argv[1] === "--rm") {
      artifactState.checkCount++;
      return Promise.resolve({ stdout: "", stderr: "", exitCode: artifactState.present ? 0 : 1 });
    }
    if (argv[0] === "start") {
      return Promise.resolve(startMiss());
    }
    if (argv[0] === "run") {
      return Promise.resolve(ok());
    }
    if (argv[0] === "port") {
      return Promise.resolve(portFound(40_010));
    }
    return Promise.resolve(ok());
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
  const dir = mkdtempSync(join(TEST_ROOT, "artifact-"));
  try {
    const specWithBindMount: RunnableContainerSpec = {
      ...SPEC,
      volumes: [{ name: dir, path: "/models" }],
      artifacts: [
        { path: "/models/x.gguf", obtain: `curl -o ${dir}/x.gguf https://example/x.gguf` },
      ],
    };
    const calls: string[][] = [];
    const exec = recordingExec(calls, (argv) =>
      argv[0] === "port" ? portFound(40_030) : undefined,
    );
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

test("probe: a container docker still reports as up is left alone, not re-checked or restarted", async () => {
  const runLog: string[][] = [];
  const lifecycle = new DockerLifecycle(buildExec({ runLog, port: STUB_HOST_PORT_A }), readyProbe);
  const started = await lifecycle.start("already-running", SPEC, START_OPTS);
  expect(started.state).toBe("running");

  const probed = await lifecycle.probe("already-running", SPEC);
  // `probe()` never sets `launched` -- only `start()` answers that question.
  const { launched: _launched, ...startedRest } = started;
  expect(probed).toEqual(startedRest);
  expect(runLog.length).toBe(1);
});

/**
 * A container that crashed, was OOM-killed or was removed behind engined's
 * back presents identically to this map: `running`, with a `private_url`
 * nothing answers on. Both reads that hand that record to a caller ask
 * docker first, so recovery never needs the daemon restarted.
 */
describe("a container that vanished underneath engined", () => {
  /** Live until `gone` flips, then absent exactly as docker reports it: `inspect` fails, and a re-`run` succeeds. */
  function vanishingExec(gone: { yet: boolean }, runLog: string[][]): Exec {
    const live = buildExec({ runLog, port: STUB_HOST_PORT_A });
    return (args) => {
      if (args[0] === "inspect" && gone.yet) {
        return Promise.resolve({ stdout: "", stderr: "No such object", exitCode: 1 });
      }
      return live(args);
    };
  }

  test("probe stops advertising it as running with a dead private_url", async () => {
    const gone = { yet: false };
    const lifecycle = new DockerLifecycle(vanishingExec(gone, []), readyProbe);
    expect((await lifecycle.start("vanisher", SPEC, START_OPTS)).state).toBe("running");

    gone.yet = true;
    const probed = await lifecycle.probe("vanisher", SPEC);
    expect(probed.state).toBe("installed");
    expect(probed.private_url).toBeNull();
  });

  test("start brings up a fresh container rather than handing back the corpse", async () => {
    const gone = { yet: false };
    const runLog: string[][] = [];
    const lifecycle = new DockerLifecycle(vanishingExec(gone, runLog), readyProbe);
    const first = await lifecycle.start("vanisher", SPEC, START_OPTS);
    expect(runLog.length).toBe(1);

    gone.yet = true;
    const second = await lifecycle.start("vanisher", SPEC, START_OPTS);
    expect(second.state).toBe("running");
    expect(second.private_url).toBe(first.private_url);
    expect(runLog.length).toBe(2);
  });
});

/**
 * An unclean exit -- a crash, a kill -9, a host reboot with the daemon dead --
 * leaves `shutdown` unrun and its containers up, against a map that starts
 * empty. Destroying one is worst exactly then, because whatever it was
 * serving is still being served.
 */
const ADOPTED_HOST_PORT = 41_000;

interface Orphan {
  digest: string;
  ports: string;
}

/** `docker ps` success listing one orphan under this engine's name. */
function orphanPs(orphan: Orphan): ExecResult {
  return {
    stdout: `engined-orphan\t${orphan.digest}\t${orphan.ports}\n`,
    stderr: "",
    exitCode: 0,
  };
}

/**
 * The orphan `docker ps` reports under this engine's name, plus the ordinary
 * stub for everything else -- so a declined adoption really does fall
 * through to a fresh `run` on the stub's own port.
 */
function orphanExec(orphan: Orphan, runLog: string[][]): Exec {
  const live = buildExec({ runLog, port: STUB_HOST_PORT_A });
  return (args) => (args[0] === "ps" ? Promise.resolve(orphanPs(orphan)) : live(args));
}

/** An orphan launched from `SPEC` exactly, publishing a host port. */
function matchingOrphan(): Orphan {
  return { digest: specDigest(SPEC), ports: `127.0.0.1:${ADOPTED_HOST_PORT}->6379/tcp` };
}

describe("a container an unclean exit left running: adopted", () => {
  test("probe reports one launched from this exact spec as running, on its own port", async () => {
    const runLog: string[][] = [];
    const lifecycle = new DockerLifecycle(orphanExec(matchingOrphan(), runLog), readyProbe);

    const probed = await lifecycle.probe("orphan", SPEC);
    expect(probed.state).toBe("running");
    expect(probed.private_url).toBe(`127.0.0.1:${ADOPTED_HOST_PORT}`);
    expect(runLog.length).toBe(0);
  });

  test("start hands it back rather than removing and recreating it", async () => {
    const runLog: string[][] = [];
    const lifecycle = new DockerLifecycle(orphanExec(matchingOrphan(), runLog), readyProbe);

    const started = await lifecycle.start("orphan", SPEC, START_OPTS);
    expect(started.private_url).toBe(`127.0.0.1:${ADOPTED_HOST_PORT}`);
    expect(runLog.length).toBe(0);
  });

  test("docker is asked once, not on every poll", async () => {
    const calls: string[][] = [];
    const orphan = matchingOrphan();
    const lifecycle = new DockerLifecycle((args) => {
      calls.push([...args]);
      if (args[0] === "ps") {
        return Promise.resolve(orphanPs(orphan));
      }
      return Promise.resolve(args[0] === "image" ? inspectFound() : containerRunning());
    }, readyProbe);

    await lifecycle.probe("orphan", SPEC);
    await lifecycle.probe("orphan", SPEC);
    expect(calls.filter((argv) => argv[0] === "ps").length).toBe(1);
  });
});

describe("a container an unclean exit left running: replaced", () => {
  test("one whose launch no longer matches the spec is replaced", async () => {
    const runLog: string[][] = [];
    const lifecycle = new DockerLifecycle(
      orphanExec(
        { digest: specDigest({ ...SPEC, image: "redis:7" }), ports: "127.0.0.1:9/tcp" },
        runLog,
      ),
      readyProbe,
    );

    const started = await lifecycle.start("orphan", SPEC, START_OPTS);
    expect(started.private_url).toBe(`127.0.0.1:${STUB_HOST_PORT_A}`);
    expect(runLog.length).toBe(1);
  });

  test("one publishing no host binding is replaced", async () => {
    const runLog: string[][] = [];
    const lifecycle = new DockerLifecycle(
      orphanExec({ digest: specDigest(SPEC), ports: "" }, runLog),
      readyProbe,
    );

    await lifecycle.start("orphan", SPEC, START_OPTS);
    expect(runLog.length).toBe(1);
  });

  test("one that no longer answers its own readiness probe is replaced", async () => {
    const runLog: string[][] = [];
    // Ready only once the fresh container's port answers: the orphan's does not.
    const probe: Probe = (url) =>
      Promise.resolve({ status: url.includes(String(STUB_HOST_PORT_A)) ? READY_STATUS : 503 });
    const lifecycle = new DockerLifecycle(orphanExec(matchingOrphan(), runLog), probe);

    const started = await lifecycle.start("orphan", SPEC, START_OPTS);
    expect(started.private_url).toBe(`127.0.0.1:${STUB_HOST_PORT_A}`);
    expect(runLog.length).toBe(1);
  });
});

test("the digest stamped on a container is the one adoption compares against", () => {
  expect(buildRunArgs("engined-redis", SPEC, 6379)).toContain(`engined.spec=${specDigest(SPEC)}`);
  expect(specDigest({ ...SPEC, command: ["--verbose"] })).not.toBe(specDigest(SPEC));
});

test("probe: the image check is cached across repeated polls, not re-shelled on every GET /engined/v1/engines", async () => {
  const inspectCalls = { count: 0 };
  const lifecycle = new DockerLifecycle(
    inspectCountingExec(inspectCalls, inspectFound),
    readyProbe,
  );

  const first = await lifecycle.probe("cached-image", SPEC);
  expect(first.state).toBe("installed");
  expect(inspectCalls.count).toBe(1);

  const second = await lifecycle.probe("cached-image", SPEC);
  expect(second.state).toBe("installed");
  expect(inspectCalls.count).toBe(1);
});

test("probe: a missing image is not cached -- a pull between polls is picked up without a restart", async () => {
  // An annotated holder, not a bare `let`: the exec closure below reads this
  // on every call, and a boolean captured before its first flip is narrowed
  // to `false` for good at the point the closure is written.
  const image: { present: boolean } = { present: false };
  const inspectCalls = { count: 0 };
  const lifecycle = new DockerLifecycle(
    inspectCountingExec(inspectCalls, () => (image.present ? inspectFound() : inspectMissing())),
    readyProbe,
  );

  const missing = await lifecycle.probe("repairable-image", SPEC);
  expect(missing.state).toBe("unavailable");
  expect(inspectCalls.count).toBe(1);

  const stillMissing = await lifecycle.probe("repairable-image", SPEC);
  expect(stillMissing.state).toBe("unavailable");
  expect(inspectCalls.count).toBe(2);

  image.present = true;
  const repaired = await lifecycle.probe("repairable-image", SPEC);
  expect(repaired.state).toBe("installed");
  expect(inspectCalls.count).toBe(3);
});

test("idle-stop failure is recorded as last_error, not thrown, the container stays running, and the timer retries a bounded number of times with no new traffic", async () => {
  const stopCalls: string[][] = [];
  function exec(args: readonly string[]): Promise<ExecResult> {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve(inspectFound());
    }
    if (argv[0] === "start") {
      return Promise.resolve(startMiss());
    }
    if (argv[0] === "run") {
      return Promise.resolve(ok());
    }
    if (argv[0] === "port") {
      return Promise.resolve(portFound(40_003));
    }
    if (argv[0] === "stop") {
      stopCalls.push(argv);
      return Promise.resolve({ stdout: "", stderr: "container is not running", exitCode: 1 });
    }
    return Promise.resolve(ok());
  }

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: 1 };
  await lifecycle.start("flaky-stop", SPEC, opts);

  lifecycle.endLease("flaky-stop", opts.idleStopSeconds);
  await Bun.sleep(PAST_IDLE_WAIT_MS);

  const status = lifecycle.getStatus("flaky-stop");
  expect(status.state).toBe("running");
  expect(status.last_error).toBe("container is not running");
  expect(stopCalls.length).toBe(1);

  // No new traffic arrives: the idle timer alone retries on the same
  // cadence -- this is the fix. One initial attempt plus 3 retries, then it
  // stops re-arming itself rather than retrying forever against a wedged
  // daemon.
  const RETRY_SETTLE_WAIT_MS = PAST_IDLE_WAIT_MS * 8;
  await Bun.sleep(RETRY_SETTLE_WAIT_MS);
  const TOTAL_ATTEMPTS_WITH_RETRIES = 4;
  expect(stopCalls.length).toBe(TOTAL_ATTEMPTS_WITH_RETRIES);

  // Bounded: waiting again brings no further attempts.
  await Bun.sleep(RETRY_SETTLE_WAIT_MS);
  expect(stopCalls.length).toBe(TOTAL_ATTEMPTS_WITH_RETRIES);
  expect(lifecycle.getStatus("flaky-stop").state).toBe("running");
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
      path: "/openai/v1/audio/transcriptions",
      status: READY_STATUS,
      method: "POST" as const,
      accept: { min: ACCEPT_MIN, max: ACCEPT_MAX },
    },
  };
  function recordingProbe(_url: string, method: "GET" | "POST"): ReturnType<Probe> {
    methods.push(method);
    return Promise.resolve({ status: BAD_REQUEST });
  }

  const lifecycle = new DockerLifecycle(buildExec({ port: STUB_HOST_PORT_A }), recordingProbe);
  const status = await lifecycle.start("whisper", postSpec, START_OPTS);

  expect(status.state).toBe("running");
  expect(methods).toEqual(["POST"]);
});

test("start: a stale container by this name is removed and recreated from the current spec, never resumed with docker start", async () => {
  const calls: string[][] = [];
  const DISTINGUISHING_ARG = "--ctx-size=8192";
  const currentSpec: RunnableContainerSpec = { ...SPEC, command: [DISTINGUISHING_ARG] };
  const hostPort = 40_020;

  const exec = recordingExec(calls, (argv) => {
    if (argv[0] === "rm") {
      // A stopped container by this name existed and is removed.
      return ok();
    }
    if (argv[0] === "port") {
      return portFound(hostPort);
    }
  });

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

  const exec = recordingExec(calls, (argv) => {
    if (argv[0] === "rm") {
      if (argv.includes("-f")) {
        removed = true;
        return ok();
      }
      return {
        stdout: "",
        stderr:
          "Error response from daemon: You cannot remove a running container ... Stop the container before attempting removal or force remove",
        exitCode: 1,
      };
    }
    if (argv[0] === "run") {
      if (!removed) {
        const DOCKER_NAME_CONFLICT_EXIT_CODE = 125;
        return {
          stdout: "",
          stderr:
            'docker: Error response from daemon: Conflict. The container name "/engined-running-conflict" is already in use by container ...',
          exitCode: DOCKER_NAME_CONFLICT_EXIT_CODE,
        };
      }
      return ok();
    }
    if (argv[0] === "port") {
      return portFound(hostPort);
    }
  });

  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const status = await lifecycle.start("running-conflict", SPEC, START_OPTS);

  expect(status.state).toBe("running");
  expect(calls.some((c) => c[0] === "rm" && c.includes("-f"))).toBe(true);
});

test("start: a genuine docker rm failure is surfaced, not swallowed into a doomed run", async () => {
  const calls: string[][] = [];

  const exec = recordingExec(calls, (argv) => {
    if (argv[0] === "rm") {
      return {
        stdout: "",
        stderr: "Error response from daemon: driver failed programming external connectivity",
        exitCode: 1,
      };
    }
  });

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
      path: "/openai/v1/audio/transcriptions",
      status: READY_STATUS,
      method: "POST" as const,
      accept: { min: ACCEPT_MIN, max: ACCEPT_MAX },
    },
  };
  function notFoundProbe(): ReturnType<Probe> {
    return Promise.resolve({ status: NOT_FOUND });
  }

  const lifecycle = new DockerLifecycle(buildExec({ port: STUB_HOST_PORT_A }), notFoundProbe);
  const status = await lifecycle.start("whisper", notFoundSpec, {
    idleStopSeconds: 60,
    readyTimeoutS: 0.05,
  });

  expect(status.state).not.toBe("running");
});

test("init = true reaches the run argv as --init, and is absent by default", () => {
  expect(buildRunArgs("engined-x", { ...SPEC, init: true }, 8188)).toContain("--init");
  expect(buildRunArgs("engined-x", { ...SPEC, init: false }, 8188)).not.toContain("--init");
});

/**
 * `docker stop` is not instantaneous: it sends SIGTERM and waits out the
 * grace period before killing. Everything below forces that window open and
 * runs a request through it.
 */
const STOP_GRACE_MS = 120;
const GRACE_IDLE_STOP_SECONDS = 0.02;
/** Comfortably after the countdown fires and comfortably before the grace ends. */
const MID_GRACE_WAIT_MS = 50;
const PAST_GRACE_WAIT_MS = STOP_GRACE_MS * 2;

/** The ordinary stub, with `docker stop` held open for a real SIGTERM grace. */
function slowStopExec(runLog: string[][], stopLog: string[][]): Exec {
  const live = buildExec({ runLog, stopLog, port: STUB_HOST_PORT_A });
  return async (args) => {
    const res = await live(args);
    if (args[0] === "stop") {
      await Bun.sleep(STOP_GRACE_MS);
    }
    return res;
  };
}

test("a request arriving inside docker stop's SIGTERM grace is never handed the dying container", async () => {
  const runLog: string[][] = [];
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(slowStopExec(runLog, stopLog), readyProbe);
  const opts = { idleStopSeconds: GRACE_IDLE_STOP_SECONDS, readyTimeoutS: 1 };

  await lifecycle.start("grace", SPEC, opts);
  expect(runLog.length).toBe(1);

  // The interleaving: idle-stop has fired and `docker stop` is blocked in its
  // grace. Everything until PAST_GRACE_WAIT_MS below happens strictly inside
  // that window, with the stop's own bookkeeping still to come.
  await Bun.sleep(MID_GRACE_WAIT_MS);
  expect(stopLog.length).toBe(1);
  const dying = lifecycle.getStatus("grace");
  expect(dying.state).not.toBe("running");
  expect(dying.private_url).toBeNull();

  // A request admitted here must get a container that will still exist when
  // the stop lands -- a fresh one, not the corpse.
  const restarted = await lifecycle.start("grace", SPEC, opts);
  lifecycle.beginLease("grace");
  expect(restarted.state).toBe("running");
  expect(runLog.length).toBe(2);

  // The stop resolves last, and must not reset the record the restart built.
  await Bun.sleep(PAST_GRACE_WAIT_MS);
  const after = lifecycle.getStatus("grace");
  expect(after.state).toBe("running");
  expect(after.private_url).toBe(`127.0.0.1:${STUB_HOST_PORT_A}`);
  expect(after.active_leases).toBe(1);
});

test("a lease held when the container dies underneath engined does not survive the reconcile that notices", async () => {
  // Comfy's shape: its leases come from a queue poller rather than from a
  // request, so the poll that reconciles a dead container is the only thing
  // that will ever release the lease that poller took.
  const gone = { yet: false };
  const stopLog: string[][] = [];
  const live = buildExec({ stopLog, port: STUB_HOST_PORT_A });
  const exec: Exec = (args) =>
    args[0] === "inspect" && gone.yet
      ? Promise.resolve({ stdout: "", stderr: "No such object", exitCode: 1 })
      : live(args);
  const lifecycle = new DockerLifecycle(exec, readyProbe);
  const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: 1 };

  await lifecycle.start("queue-lease", SPEC, opts);
  lifecycle.beginLease("queue-lease");

  // The container dies; the next poll's reconcile is what learns of it.
  gone.yet = true;
  expect((await lifecycle.probe("queue-lease", SPEC)).state).toBe("installed");

  gone.yet = false;
  const restarted = await lifecycle.start("queue-lease", SPEC, opts);
  expect(restarted.state).toBe("running");
  expect(restarted.active_leases).toBe(0);

  // A lease surviving the death would leave refreshIdle refusing to arm, and
  // the restarted container would hold its GPU until the daemon restarts.
  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(1);
  expect(lifecycle.getStatus("queue-lease").state).toBe("installed");
});

test("an orphan adopted on a status GET counts down like one this process started", async () => {
  const stopLog: string[][] = [];
  const live = buildExec({ stopLog, port: STUB_HOST_PORT_A });
  const exec: Exec = (args) =>
    args[0] === "ps" ? Promise.resolve(orphanPs(matchingOrphan())) : live(args);
  const lifecycle = new DockerLifecycle(exec, readyProbe);

  // The first status GET after an unclean exit: nothing else in this process
  // will ever arm this engine, since adoption happens once.
  const probed = await lifecycle.probe("orphan", SPEC, undefined, IDLE_STOP_SECONDS);
  expect(probed.state).toBe("running");

  await Bun.sleep(PAST_IDLE_WAIT_MS);
  expect(stopLog.length).toBe(1);
  expect(lifecycle.getStatus("orphan").state).toBe("installed");
});

const STOP_REFUSED = "Error response from daemon: cannot stop container";

/** `docker stop` refused by the daemon: the container is still up afterwards. Every other verb behaves. */
function failingStopExec(stopLog: string[][], port: number): Exec {
  const live = buildExec({ port });
  return (args) => {
    if (args[0] !== "stop") {
      return live(args);
    }
    stopLog.push([...args]);
    return Promise.resolve({ stdout: "", stderr: STOP_REFUSED, exitCode: 1 });
  };
}

test("removeEngine keeps a container it could not stop, so shutdown still reaches it", async () => {
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(failingStopExec(stopLog, STUB_HOST_PORT_A), readyProbe);

  await lifecycle.start("stuck", SPEC, START_OPTS);
  await expect(lifecycle.removeEngine("stuck")).rejects.toThrow(STOP_REFUSED);
  expect(stopLog.length).toBe(1);

  // The interleaving: a reload's teardown asked for this engine and docker
  // refused. Dropping the record here is what puts the container beyond every
  // later stop -- it is still running, so the record must still say so.
  const after = lifecycle.getStatus("stuck");
  expect(after.state).toBe("running");
  expect(after.private_url).toBe(`127.0.0.1:${STUB_HOST_PORT_A}`);
  expect(after.last_error).toBe(STOP_REFUSED);

  await lifecycle.shutdown();
  expect(stopLog.length).toBe(2);
});

describe("a spec dir's declared build flags", () => {
  const BUILD_SPEC: RunnableContainerSpec = {
    ...SPEC,
    image: "engined/chatterbox-en:local",
    obtain: "build",
  };

  /** The `fix` a missing image reports for a spec dir: the whole `docker build` command. */
  async function buildFix(dir: string): Promise<string | undefined> {
    const lifecycle = new DockerLifecycle(
      inspectCountingExec({ count: 0 }, inspectMissing),
      readyProbe,
    );
    return (await lifecycle.probe("build-contexts", BUILD_SPEC, dir)).fix;
  }

  test("each name=path line becomes a --build-context resolved against the spec dir", async () => {
    const dir = mkdtempSync(join(TEST_ROOT, "build-contexts-"));
    try {
      writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(dir, "build-contexts"), "shared=../shared\n");

      // The path is relative to the spec dir in the file and absolute in the
      // command: docker resolves a relative one against its own cwd, which is
      // wherever the operator happens to be standing.
      expect(await buildFix(dir)).toBe(
        `docker build -t ${BUILD_SPEC.image} --build-context shared=${resolve(dir, "../shared")} -f ${join(dir, "Dockerfile")} ${dir}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("each name=value line of build-args becomes a --build-arg, after the contexts", async () => {
    const dir = mkdtempSync(join(TEST_ROOT, "build-args-"));
    try {
      writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");
      writeFileSync(join(dir, "build-contexts"), "shared=../shared\n");
      // One entry per line, the way a real `build-args` is written -- the two
      // values mirror `engines/chatterbox-en/build-args` rather than inventing
      // a shape the loader never sees.
      const buildArgs = ["PORT=8005", "CHECKPOINT_MODULE=chatterbox.tts_turbo"];
      writeFileSync(join(dir, "build-args"), `${buildArgs.join("\n")}\n`);

      // Values are taken literally -- unlike a context's path, which is a
      // location this has to resolve; a build arg is whatever the Dockerfile
      // means by it.
      expect(await buildFix(dir)).toBe(
        `docker build -t ${BUILD_SPEC.image} --build-context shared=${resolve(dir, "../shared")}` +
          " --build-arg PORT=8005 --build-arg CHECKPOINT_MODULE=chatterbox.tts_turbo" +
          ` -f ${join(dir, "Dockerfile")} ${dir}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("dockerfile-path points -f at a recipe outside the context, which stays the spec dir", async () => {
    const dir = mkdtempSync(join(TEST_ROOT, "dockerfile-path-"));
    try {
      writeFileSync(join(dir, "dockerfile-path"), "../shared/Dockerfile\n");
      mkdirSync(resolve(dir, "../shared"), { recursive: true });
      writeFileSync(resolve(dir, "../shared/Dockerfile"), "FROM scratch\n");

      // A symlink in the spec dir would not do: buildkit reads `-f` off the
      // filesystem but refuses to follow one out of the context.
      expect(await buildFix(dir)).toBe(
        `docker build -t ${BUILD_SPEC.image} -f ${resolve(dir, "../shared/Dockerfile")} ${dir}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(resolve(dir, "../shared"), { recursive: true, force: true });
    }
  });

  test("no such file leaves the build command byte-identical", async () => {
    const dir = mkdtempSync(join(TEST_ROOT, "build-contexts-"));
    try {
      writeFileSync(join(dir, "Dockerfile"), "FROM scratch\n");

      // Every spec without the file -- which is nearly all of them -- must get
      // the command it would get if the mechanism did not exist: not a stray
      // space, not an empty flag.
      expect(await buildFix(dir)).toBe(
        `docker build -t ${BUILD_SPEC.image} -f ${join(dir, "Dockerfile")} ${dir}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("a hold stops the engine and keeps it stopped, and expires rather than wedging it", async () => {
  const stopLog: string[][] = [];
  const lifecycle = new DockerLifecycle(buildExec({ stopLog, port: STUB_HOST_PORT_B }), readyProbe);

  await lifecycle.start("held-test", SPEC, START_OPTS);
  expect(lifecycle.heldMsFor("held-test")).toBe(0);

  // A hold is a stop that stays: the weights leave the pool, which is the whole
  // reason a second process asks for one.
  await lifecycle.hold("held-test", 60_000);
  expect(stopLog.length).toBe(1);
  expect(lifecycle.heldMsFor("held-test")).toBeGreaterThan(0);

  // Re-holding extends rather than stacking, so a long run refreshes instead of
  // asking for an open-ended hold up front.
  await lifecycle.hold("held-test", 120_000);
  expect(lifecycle.heldMsFor("held-test")).toBeGreaterThan(60_000);

  lifecycle.unhold("held-test");
  expect(lifecycle.heldMsFor("held-test")).toBe(0);

  // A holder that dies must not keep the engine out of service forever: the TTL
  // is what makes that impossible rather than merely unlikely.
  await lifecycle.hold("held-test", 1);
  await Bun.sleep(5);
  expect(lifecycle.heldMsFor("held-test")).toBe(0);
});
