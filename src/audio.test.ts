import { expect, test } from "bun:test";
import { join } from "node:path";
import { handleSpeech } from "./audio.ts";
import { buildRunArgs, DockerLifecycle, type Exec, type ExecResult } from "./docker.ts";
import { loadSpec } from "./spec.ts";
import type { EngineEntry } from "./types.ts";
import { isContainerSpec } from "./types.ts";

const CHATTERBOX_CONTAINER_PORT = 8004;
const SAMPLE_WAV_BYTES = Buffer.from("RIFF____WAVEfmt ", "utf8");
const SAMPLE_WAV_BASE64 = SAMPLE_WAV_BYTES.toString("base64");

/** `docker image inspect`, one exposed port — chatterbox's shape, not a real capture. */
const CHATTERBOX_INSPECT = JSON.stringify([
  { Config: { ExposedPorts: { [`${CHATTERBOX_CONTAINER_PORT}/tcp`]: {} } } },
]);

function loadChatterboxSpec() {
  const entry: EngineEntry = { id: "chatterbox", egress: "none", args: {} };
  const loaded = loadSpec(entry, {
    enginesRoot: join(import.meta.dir, "..", "engines"),
    bunx: "/opt/engined/state/bunx",
  });
  if (!isContainerSpec(loaded.spec)) {
    throw new Error("chatterbox spec.toml did not parse as a container spec");
  }
  return loaded.spec;
}

/** A real `Bun.serve` fake chatterbox, emitting real NDJSON: one frame with `audio`, alignment null. */
function startFakeChatterbox(): { base: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/tts") {
        return new Response(`${JSON.stringify({ audio: SAMPLE_WAV_BASE64, alignment: null })}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { base: `127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

test("handleSpeech returns an OpenAI audio body, not the chatterbox NDJSON envelope", async () => {
  const fake = startFakeChatterbox();

  const result = await handleSpeech({ model: "chatterbox", input: "hello there" }, async () => ({
    private_url: fake.base,
  }));
  fake.stop();

  expect(result.status).toBe(200);
  expect(result.bytes).toBeDefined();
  const bytes = result.bytes as Uint8Array;
  expect(Buffer.from(bytes).equals(SAMPLE_WAV_BYTES)).toBe(true);
  expect(() => JSON.parse(Buffer.from(bytes).toString("utf8"))).toThrow();
});

test("response_format: wav returns bytes with a binary content type, not a JSON envelope", async () => {
  const fake = startFakeChatterbox();

  const result = await handleSpeech(
    { model: "chatterbox", input: "hello there", response_format: "wav" },
    async () => ({ private_url: fake.base }),
  );
  fake.stop();

  expect(result.contentType).not.toBe("application/json");
  expect(result.contentType).toBe("audio/wav");
  expect(result.bytes).toBeDefined();
  expect(result.body).toBeUndefined();
});

test("chatterbox spec.toml produces run argv carrying the GPU flags and no all-interfaces publish", () => {
  const spec = loadChatterboxSpec();
  const argv = buildRunArgs("engined-chatterbox", spec, CHATTERBOX_CONTAINER_PORT);

  expect(argv).toContain("/dev/kfd");
  expect(argv).toContain("/dev/dri");
  expect(argv).toContain("--security-opt");
  expect(argv).toContain("label=disable");
  expect(argv).not.toContain("-P");
});

test("a request against a stopped engine starts it on demand through the real docker lifecycle", async () => {
  const fake = startFakeChatterbox();
  const [, fakePort] = fake.base.split(":");
  const runLog: string[][] = [];

  const exec: Exec = (args): Promise<ExecResult> => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve({ stdout: CHATTERBOX_INSPECT, stderr: "", exitCode: 0 });
    }
    if (argv[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
    if (argv[0] === "run") {
      runLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve({ stdout: `127.0.0.1:${fakePort}`, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
  const lifecycle = new DockerLifecycle(exec, async () => ({ status: 200 }));
  const spec = loadChatterboxSpec();

  const result = await handleSpeech({ model: "chatterbox", input: "hello there" }, (id) =>
    lifecycle.start(id, spec, { idleStopSeconds: 60, readyTimeoutS: 1 }),
  );
  fake.stop();

  expect(runLog.length).toBe(1);
  expect(result.status).toBe(200);
});
