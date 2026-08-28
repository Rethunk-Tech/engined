import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSpeech, handleTranscription } from "./audio.ts";
import { buildRunArgs, DockerLifecycle } from "./docker.ts";
import type { Exec, ExecResult } from "./exec.ts";
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

/** Loads `id`'s real spec.toml and asserts it parsed as a container spec — every engine under test here is one. */
function loadSpecFor(id: string, models_dir?: string) {
  const entry: EngineEntry = { id, egress: "none", args: {}, models_dir };
  const loaded = loadSpec(entry, {
    enginesRoot: join(import.meta.dir, "..", "engines"),
    bunx: "/opt/engined/state/bunx",
  });
  if (!isContainerSpec(loaded.spec)) {
    throw new Error(`${id} spec.toml did not parse as a container spec`);
  }
  return loaded.spec;
}

/** `docker image inspect`, one exposed port -- a synthetic shape for the fake exec, not a real capture. */
const WHISPER_INSPECT = JSON.stringify([{ Config: { ExposedPorts: { "8080/tcp": {} } } }]);

/** A fake `Exec` with a fixed `docker image inspect` reply; every other verb falls through to `extra` (when it recognizes the argv) then a no-op success. */
function makeExec(
  inspectResult: ExecResult,
  extra?: (argv: string[]) => ExecResult | undefined,
): Exec {
  return (args): Promise<ExecResult> => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve(inspectResult);
    }
    return Promise.resolve(extra?.(argv) ?? { stdout: "", stderr: "", exitCode: 0 });
  };
}

/** A real `DockerLifecycle` over a fake `exec`, with a stub readiness fetch that always reports ready. */
function makeLifecycle(exec: Exec): DockerLifecycle {
  return new DockerLifecycle(exec, async () => ({ status: 200 }));
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

test("response_format: mp3 on speech is rejected with 400 naming wav, not silently returned as wav bytes", async () => {
  const result = await handleSpeech(
    { model: "chatterbox", input: "hello there", response_format: "mp3" },
    () => {
      throw new Error("must not start an engine for a rejected response_format");
    },
    unreachableFetch("must not fetch an engine for a rejected response_format"),
  );

  expect(result.status).toBe(400);
  expect(result.bytes).toBeUndefined();
  expect(JSON.stringify(result.body)).toContain("wav");
});

test("chatterbox spec.toml produces run argv carrying the GPU flags and no all-interfaces publish", () => {
  const spec = loadSpecFor("chatterbox");
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

  const exec = makeExec({ stdout: CHATTERBOX_INSPECT, stderr: "", exitCode: 0 }, (argv) => {
    if (argv[0] === "start") {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (argv[0] === "run") {
      runLog.push(argv);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (argv[0] === "port") {
      return { stdout: `127.0.0.1:${fakePort}`, stderr: "", exitCode: 0 };
    }
  });
  const lifecycle = makeLifecycle(exec);
  const spec = loadSpecFor("chatterbox");

  const result = await handleSpeech({ model: "chatterbox", input: "hello there" }, (id) =>
    lifecycle.start(id, spec, { idleStopSeconds: 60, readyTimeoutS: 1 }),
  );
  fake.stop();

  expect(runLog.length).toBe(1);
  expect(result.status).toBe(200);
});

/** A real `Bun.serve` fake whisper: echoes back the multipart fields it received. */
function startFakeWhisper(): {
  base: string;
  requests: Array<{ language?: string; response_format?: string }>;
  stop: () => void;
} {
  const requests: Array<{ language?: string; response_format?: string }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const form = await req.formData();
      const language = form.get("language");
      const responseFormat = form.get("response_format");
      requests.push({
        language: typeof language === "string" ? language : undefined,
        response_format: typeof responseFormat === "string" ? responseFormat : undefined,
      });
      if (responseFormat === "text") {
        return new Response("hello world", { headers: { "content-type": "text/plain" } });
      }
      return Response.json({ text: "hello world" });
    },
  });
  return { base: `127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}

const SAMPLE_AUDIO_BYTES = new Uint8Array([1, 2, 3, 4]);

/** A `fetchImpl` stand-in for "must not have been called" assertions. */
function unreachableFetch(message: string): typeof fetch {
  return (() => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

/** A `makeExec` `extra` that records `docker run -d` invocations without executing them — the real container must never be reached from an unavailable state. */
function trackRunD(runs: string[][]) {
  return (argv: string[]): ExecResult | undefined => {
    if (argv[0] === "run" && argv[1] === "-d") {
      runs.push(argv);
      return { stdout: "", stderr: "", exitCode: 0 };
    }
  };
}

test("response_format: text on transcriptions returns bare text, not a JSON envelope", async () => {
  const fake = startFakeWhisper();

  const result = await handleTranscription(
    { model: "whisper", file: SAMPLE_AUDIO_BYTES, response_format: "text" },
    async () => ({ private_url: fake.base }),
  );
  fake.stop();

  expect(result.contentType).toBe("text/plain");
  expect(result.body).toBe("hello world");
  expect(() => JSON.parse(result.body as string)).toThrow();
});

test("a per-request language reaches the engine, asserted against the fake upstream's recorded request", async () => {
  const fake = startFakeWhisper();

  await handleTranscription(
    { model: "whisper", file: SAMPLE_AUDIO_BYTES, language: "fr" },
    async () => ({ private_url: fake.base }),
  );
  fake.stop();

  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]?.language).toBe("fr");
});

test("with no whisper image built, transcriptions returns 503 naming it and GET /v1/engines' status reports the docker build command", async () => {
  const spec = loadSpecFor("whisper", "/data/whisper-models");
  const realContainerRuns: string[][] = [];

  const exec = makeExec(
    { stdout: "", stderr: "no such image", exitCode: 1 },
    trackRunD(realContainerRuns),
  );
  const lifecycle = makeLifecycle(exec);

  // The real shipped whisper spec dir, so the emitted fix is checked against
  // the Dockerfile that actually ships there -- see docker.ts's checkImage:
  // a build-obtain fix without a real spec directory to check can only be
  // the honest "no Dockerfile" fallback, not the runnable command this test
  // means to prove.
  const whisperSpecDir = join(import.meta.dir, "..", "engines", "whisper");
  const result = await handleTranscription(
    { model: "whisper", file: SAMPLE_AUDIO_BYTES },
    (id) =>
      lifecycle.start(id, spec, {
        idleStopSeconds: 60,
        readyTimeoutS: 1,
        specSource: whisperSpecDir,
      }),
    unreachableFetch("must not fetch an engine that never started"),
  );

  expect(result.status).toBe(503);
  expect(JSON.stringify(result.body)).toContain("whisper");
  expect(realContainerRuns.length).toBe(0);
  const status = lifecycle.getStatus("whisper");
  expect(status.state).toBe("unavailable");
  expect(status.fix).toBe(
    `docker build -t ${spec.image} -f ${join(whisperSpecDir, "Dockerfile")} ${whisperSpecDir}`,
  );
});

test("image present but the model artifact absent: unavailable naming the artifact's command, never installed, never a container that starts and dies", async () => {
  // whisper's real spec.toml volume is a bind mount whose host path is a
  // literal for the operator's own machine (see spec.toml's own comment on
  // why), so on a box that already has the real model downloaded, pointing
  // at the real spec would find the artifact present. Swap in a scratch
  // volume with nothing in it so "absent" is genuinely absent here, not an
  // artifact of this box's own state.
  const base = loadSpecFor("whisper", "/data/whisper-models");
  const scratchDir = mkdtempSync(join(tmpdir(), "engined-whisper-artifact-"));
  const spec = { ...base, volumes: [{ name: scratchDir, path: "/models" }] };
  const realContainerRuns: string[][] = [];

  const exec = makeExec(
    { stdout: WHISPER_INSPECT, stderr: "", exitCode: 0 },
    trackRunD(realContainerRuns),
  );
  const lifecycle = makeLifecycle(exec);

  const result = await handleTranscription(
    { model: "whisper", file: SAMPLE_AUDIO_BYTES },
    (id) => lifecycle.start(id, spec, { idleStopSeconds: 60, readyTimeoutS: 1 }),
    unreachableFetch("must not fetch an engine that never started"),
  );

  rmSync(scratchDir, { recursive: true, force: true });

  expect(result.status).toBe(503);
  expect(realContainerRuns.length).toBe(0);
  const status = lifecycle.getStatus("whisper");
  expect(status.state).toBe("unavailable");
  expect(status.fix).toBe(spec.artifacts[0]?.obtain);
});

test("a second audio caller is visible as a lease while the first is still in flight", async () => {
  const exec = makeExec({ stdout: CHATTERBOX_INSPECT, stderr: "", exitCode: 0 }, (argv) => {
    if (argv[0] === "start") {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (argv[0] === "port") {
      return { stdout: "127.0.0.1:41000", stderr: "", exitCode: 0 };
    }
  });
  const lifecycle = makeLifecycle(exec);
  await lifecycle.start("chatterbox", loadSpecFor("chatterbox"), {
    idleStopSeconds: 60,
    readyTimeoutS: 1,
  });

  // The engine apps serialize synthesis on one process-wide lock, so a second
  // caller simply waits. Without the lease count nothing outside the container
  // reports that it is waiting at all.
  expect(lifecycle.getStatus("chatterbox").active_leases).toBe(0);
  lifecycle.beginLease("chatterbox");
  lifecycle.beginLease("chatterbox");
  expect(lifecycle.getStatus("chatterbox").active_leases).toBe(2);

  lifecycle.endLease("chatterbox", 60);
  expect(lifecycle.getStatus("chatterbox").active_leases).toBe(1);
});
