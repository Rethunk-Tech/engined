import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import process from "node:process";
import { DockerLifecycle, dockerExec } from "../../src/docker.ts";
import type { RunnableContainerSpec } from "../../src/types.ts";
import { TEST_NAME_PREFIX } from "./exclusive.ts";

/**
 * A real round trip against a trivial, already-small single-port image:
 * nginx:alpine serves 200 on `/` with no configuration, so it doubles as its
 * own readiness probe. Every container this file creates is named
 * `engined-local-smoke` and is removed, never left running or merely stopped.
 */
const ID = "local-smoke";
const CONTAINER_NAME = `${TEST_NAME_PREFIX}${ID}`;

const SPEC: RunnableContainerSpec = {
  kind: "openai-http",
  serves: ["chat"],
  env: [],
  command: [],
  upstream: "self",
  image: "nginx:alpine",
  obtain: "pull",
  devices: [],
  group_add: [],
  security_opt: [],
  init: false,
  streaming: false,
  volumes: [],
  artifacts: [],
  ready: { path: "/", status: 200 },
};

const IDLE_STOP_SECONDS = 2;
const IDLE_WAIT_MS = 2500;
const READY_TIMEOUT_S = 20;
// `docker pull` is a registry round trip, so it is not bounded by bun's 5s
// default hook timeout: warm it still takes ~4.7s here under concurrent
// container load, and cold it is a real download.
const PULL_TIMEOUT_MS = 120_000;

async function removeContainer(): Promise<void> {
  await dockerExec(["rm", "-f", CONTAINER_NAME]);
}

describe.skipIf(process.env.ENGINED_LOCAL !== "1")("docker lifecycle (local)", () => {
  beforeAll(async () => {
    await dockerExec(["pull", SPEC.image]);
    await removeContainer();
  }, PULL_TIMEOUT_MS);

  afterAll(removeContainer);

  test("start, reach, idle-stop, restart: two different reachable private_urls", async () => {
    const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);
    const opts = { idleStopSeconds: IDLE_STOP_SECONDS, readyTimeoutS: READY_TIMEOUT_S };

    const first = await lifecycle.start(ID, SPEC, opts);
    expect(first.state).toBe("running");
    expect(first.private_url).not.toBeNull();
    expect((await fetch(`http://${first.private_url}/`)).status).toBe(200);

    lifecycle.endLease(ID, IDLE_STOP_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, IDLE_WAIT_MS));
    expect(lifecycle.getStatus(ID).state).toBe("installed");

    const second = await lifecycle.start(ID, SPEC, opts);
    expect(second.state).toBe("running");
    expect(second.private_url).not.toBe(first.private_url);
    expect((await fetch(`http://${second.private_url}/`)).status).toBe(200);

    await lifecycle.shutdown();
  });
});
