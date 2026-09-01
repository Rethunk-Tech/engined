import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { handleSpeech, handleTranscription } from "./audio.ts";
import { buildRunArgs, DockerLifecycle } from "./docker.ts";
import type { Exec, ExecResult } from "./exec.ts";
import { loadSpec } from "./spec.ts";
import { containerRunning, makeTestRoot } from "./test-support.ts";
import type { EngineEntry } from "./types.ts";
import { isContainerSpec } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-audio-");

const CHATTERBOX_CONTAINER_PORT = 8004;
const SAMPLE_WAV_BYTES = Buffer.from("RIFF____WAVEfmt ", "utf8");
const SAMPLE_WAV_BASE64 = SAMPLE_WAV_BYTES.toString("base64");

/** `docker image inspect`, one exposed port — chatterbox-multi's shape, not a real capture. */
const CHATTERBOX_INSPECT = JSON.stringify([
  { Config: { ExposedPorts: { [`${CHATTERBOX_CONTAINER_PORT}/tcp`]: {} } } },
]);

/** Loads `id`'s real spec.toml and asserts it parsed as a container spec — every engine under test here is one. */
function loadSpecFor(id: string, models_dir?: string) {
  const entry: EngineEntry = { id, args: {}, models_dir };
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
    if (argv[0] === "inspect") {
      return Promise.resolve(containerRunning());
    }
    return Promise.resolve(extra?.(argv) ?? { stdout: "", stderr: "", exitCode: 0 });
  };
}

/** A real `DockerLifecycle` over a fake `exec`, with a stub readiness fetch that always reports ready. */
function makeLifecycle(exec: Exec): DockerLifecycle {
  return new DockerLifecycle(exec, async () => ({ status: 200 }));
}

/** A real `Bun.serve` fake chatterbox-multi, emitting real NDJSON: one frame with `audio`, alignment null. */
function startFakeChatterboxMulti(): { base: string; stop: () => void } {
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

test("handleSpeech returns an OpenAI audio body, not the chatterbox-multi NDJSON envelope", async () => {
  const fake = startFakeChatterboxMulti();

  const result = await handleSpeech(
    { engine: "chatterbox-multi", input: "hello there" },
    async () => ({
      private_url: fake.base,
    }),
  );
  fake.stop();

  expect(result.status).toBe(200);
  expect(result.bytes).toBeDefined();
  const bytes = result.bytes as Uint8Array;
  expect(Buffer.from(bytes).equals(SAMPLE_WAV_BYTES)).toBe(true);
  expect(() => JSON.parse(Buffer.from(bytes).toString("utf8"))).toThrow();
});

test("response_format: wav returns bytes with a binary content type, not a JSON envelope", async () => {
  const fake = startFakeChatterboxMulti();

  const result = await handleSpeech(
    { engine: "chatterbox-multi", input: "hello there", response_format: "wav" },
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
    { engine: "chatterbox-multi", input: "hello there", response_format: "mp3" },
    () => {
      throw new Error("must not start an engine for a rejected response_format");
    },
    unreachableFetch("must not fetch an engine for a rejected response_format"),
  );

  expect(result.status).toBe(400);
  expect(result.bytes).toBeUndefined();
  expect(JSON.stringify(result.body)).toContain("wav");
});

test("a start refused for a model conflict is a 409, never fetched", async () => {
  const result = await handleSpeech(
    { engine: "chatterbox-multi", input: "hello there" },
    async () => ({ private_url: null, conflict: 'engine "chatterbox-multi" is busy' }),
    unreachableFetch("must not fetch an engine refused for a model conflict"),
  );

  expect(result.status).toBe(409);
  expect(JSON.stringify(result.body)).toContain("busy");
});

test("chatterbox-multi spec.toml produces run argv carrying the GPU flags and no all-interfaces publish", () => {
  const spec = loadSpecFor("chatterbox-multi");
  const argv = buildRunArgs("engined-chatterbox-multi", spec, CHATTERBOX_CONTAINER_PORT);

  expect(argv).toContain("/dev/kfd");
  expect(argv).toContain("/dev/dri");
  expect(argv).toContain("--security-opt");
  expect(argv).toContain("label=disable");
  expect(argv).not.toContain("-P");
});

test("a request against a stopped engine starts it on demand through the real docker lifecycle", async () => {
  const fake = startFakeChatterboxMulti();
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
  const spec = loadSpecFor("chatterbox-multi");

  const result = await handleSpeech({ engine: "chatterbox-multi", input: "hello there" }, (id) =>
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
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES, response_format: "text" },
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
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES, language: "fr" },
    async () => ({ private_url: fake.base }),
  );
  fake.stop();

  expect(fake.requests).toHaveLength(1);
  expect(fake.requests[0]?.language).toBe("fr");
});

test("a route's model reaches EngineStart as its own argument, not folded into the engine id", async () => {
  const fake = startFakeWhisper();
  const starts: Array<{ id: string; model: string | undefined }> = [];

  await handleTranscription(
    { engine: "whisper", model: "small.en", file: SAMPLE_AUDIO_BYTES },
    (id, model) => {
      starts.push({ id, model });
      return Promise.resolve({ private_url: fake.base });
    },
  );
  fake.stop();

  expect(starts).toEqual([{ id: "whisper", model: "small.en" }]);
});

test("a model switch that would kill an in-flight request is a 409, not a silent restart", async () => {
  const result = await handleTranscription(
    { engine: "whisper", model: "medium.en", file: SAMPLE_AUDIO_BYTES },
    async () => ({
      private_url: null,
      conflict: 'engine "whisper" is serving 1 active request(s)',
    }),
    unreachableFetch("must not fetch an engine refused for a model conflict"),
  );

  expect(result.status).toBe(409);
  expect(JSON.stringify(result.body)).toContain("active request");
});

test("with no whisper image built, transcriptions returns 503 naming it and GET /engined/v1/engines' status reports the docker build command", async () => {
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
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES },
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
  const scratchDir = mkdtempSync(join(TEST_ROOT, "whisper-artifact-"));
  const spec = { ...base, volumes: [{ name: scratchDir, path: "/models" }] };
  const realContainerRuns: string[][] = [];

  const exec = makeExec(
    { stdout: WHISPER_INSPECT, stderr: "", exitCode: 0 },
    trackRunD(realContainerRuns),
  );
  const lifecycle = makeLifecycle(exec);

  const result = await handleTranscription(
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES },
    (id) => lifecycle.start(id, spec, { idleStopSeconds: 60, readyTimeoutS: 1 }),
    unreachableFetch("must not fetch an engine that never started"),
  );

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
  await lifecycle.start("chatterbox-multi", loadSpecFor("chatterbox-multi"), {
    idleStopSeconds: 60,
    readyTimeoutS: 1,
  });

  // The engine apps serialize synthesis on one process-wide lock, so a second
  // caller simply waits. Without the lease count nothing outside the container
  // reports that it is waiting at all.
  expect(lifecycle.getStatus("chatterbox-multi").active_leases).toBe(0);
  lifecycle.beginLease("chatterbox-multi");
  lifecycle.beginLease("chatterbox-multi");
  expect(lifecycle.getStatus("chatterbox-multi").active_leases).toBe(2);

  lifecycle.endLease("chatterbox-multi", 60);
  expect(lifecycle.getStatus("chatterbox-multi").active_leases).toBe(1);
});

test("a streamed speech request forwards each chunk's PCM and drops the terminal WAV", async () => {
  const frames = [
    JSON.stringify({ phase: "synthesizing" }),
    JSON.stringify({
      phase: "chunk",
      pcm: Buffer.from([1, 2, 3, 4]).toString("base64"),
      rate: 24_000,
    }),
    JSON.stringify({ phase: "chunk", pcm: Buffer.from([5, 6]).toString("base64"), rate: 24_000 }),
    JSON.stringify({ phase: "done", audio: Buffer.from("a whole wav").toString("base64") }),
  ].join("\n");
  let asked: unknown;
  const res = await handleSpeech(
    { engine: "kokoro", input: "hi", stream: true },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    (_url, init) => {
      asked = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(frames));
    },
  );

  expect((asked as { chunks?: boolean }).chunks).toBe(true);
  expect(res.contentType).toContain("audio/L16");
  expect(res.bytes).toBeUndefined();
  const out = Buffer.from(await new Response(res.stream).arrayBuffer());
  // Only the chunk PCM, in order -- the terminal frame's WAV is not appended.
  expect([...out]).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a streamed speech request advertises the rate the engine reported, not a constant", async () => {
  const frames = [
    JSON.stringify({ phase: "synthesizing" }),
    JSON.stringify({ phase: "chunk", pcm: Buffer.from([9]).toString("base64"), rate: 22_050 }),
    JSON.stringify({ phase: "done", audio: Buffer.from("a whole wav").toString("base64") }),
  ].join("\n");
  const res = await handleSpeech(
    { engine: "piper", input: "hi", stream: true },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(frames)),
  );

  expect(res.contentType).toBe("audio/L16; rate=22050; channels=1");
  const out = Buffer.from(await new Response(res.stream).arrayBuffer());
  expect([...out]).toEqual([9]);
});

test("an engine that streams no chunk frames is a 502, not a caller waiting forever", async () => {
  // Status and headers are committed the moment a stream is returned, so an
  // engine that never chunks has to be caught before that -- otherwise the
  // caller holds a 200 whose body never produces a byte and never ends.
  const frames = [
    JSON.stringify({ phase: "synthesizing" }),
    JSON.stringify({ phase: "done", audio: Buffer.from("a whole wav").toString("base64") }),
  ].join("\n");
  const res = await handleSpeech(
    { engine: "piper", input: "hi", stream: true },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(frames)),
  );

  expect(res.status).toBe(502);
  expect(res.stream).toBeUndefined();
  expect(res.body).toEqual({ error: "piper: /v1/tts streamed no audio" });
});

test("an error frame before any audio is a 502 carrying the engine's own detail", async () => {
  const frames = [
    JSON.stringify({ phase: "synthesizing" }),
    JSON.stringify({ phase: "error", detail: "text produced no audio" }),
  ].join("\n");
  const res = await handleSpeech(
    { engine: "piper", input: ".", stream: true },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(frames)),
  );

  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: "piper: /v1/tts failed: text produced no audio" });
});

test("a buffered speech request is unchanged and never asks for chunks", async () => {
  let asked: unknown;
  const res = await handleSpeech(
    { engine: "kokoro", input: "hi" },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    (_url, init) => {
      asked = JSON.parse(String(init?.body));
      return Promise.resolve(
        Response.json({ phase: "done", audio: Buffer.from("wav").toString("base64") }),
      );
    },
  );
  expect((asked as { chunks?: boolean }).chunks).toBe(false);
  expect(res.contentType).toBe("audio/wav");
  expect(Buffer.from(res.bytes ?? new Uint8Array()).toString()).toBe("wav");
});

test('stream: "ndjson" forwards synthesis progress, which raw PCM cannot carry', async () => {
  const frames = [
    JSON.stringify({ phase: "synthesizing", step: 1, step_limit: 1000 }),
    JSON.stringify({ phase: "synthesizing", step: 500, step_limit: 1000 }),
    JSON.stringify({
      phase: "chunk",
      pcm: Buffer.from([1, 2, 3, 4]).toString("base64"),
      rate: 24_000,
    }),
    // The terminal frame's whole-utterance WAV is not forwarded: the caller
    // already has those samples, and an unvetted field is not a contract.
    JSON.stringify({ phase: "done", audio: Buffer.from("a whole wav").toString("base64") }),
  ].join("\n");
  let asked: unknown;
  const res = await handleSpeech(
    { engine: "chatterbox-multi", input: "hi", stream: "ndjson" },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    (_url, init) => {
      asked = JSON.parse(String(init?.body));
      return Promise.resolve(new Response(frames));
    },
  );

  expect((asked as { chunks?: boolean }).chunks).toBe(true);
  expect(res.contentType).toBe("application/x-ndjson");
  const text = await new Response(res.stream).text();
  const out = text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  expect(out).toEqual([
    { phase: "synthesizing", step: 1, step_limit: 1000 },
    { phase: "synthesizing", step: 500, step_limit: 1000 },
    { phase: "chunk", pcm: Buffer.from([1, 2, 3, 4]).toString("base64"), rate: 24_000 },
    { phase: "done" },
  ]);
});

test('stream: "ndjson" keeps the terminal audio when the engine never chunked', async () => {
  // chatterbox-multi streams step counts and then one whole-utterance WAV: it emits
  // no chunk frames at all, so dropping `audio` on `done` -- correct for a
  // chunking engine that already sent the samples -- hands this caller
  // progress and silence.
  const frames = [
    JSON.stringify({ phase: "synthesizing", step: 7, step_limit: 1000 }),
    JSON.stringify({ phase: "vocoding" }),
    JSON.stringify({ phase: "done", audio: SAMPLE_WAV_BASE64, alignment: null }),
  ].join("\n");
  const res = await handleSpeech(
    { engine: "chatterbox-multi", input: "hi", stream: "ndjson" },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(frames)),
  );

  const out = (await new Response(res.stream).text())
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  expect(out).toEqual([
    { phase: "synthesizing", step: 7, step_limit: 1000 },
    { phase: "vocoding" },
    { phase: "done", audio: SAMPLE_WAV_BASE64 },
  ]);
});

test("a buffered speech failure reports the engine's own reason, not just missing audio", async () => {
  // kokoro refuses an unknown voice with {phase:"error", detail}. Reporting
  // "carried no audio" sends the caller looking at the door instead.
  const res = await handleSpeech(
    { engine: "kokoro", input: "hi", voice: "not_a_real_voice" },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () =>
      Promise.resolve(
        new Response(
          `${JSON.stringify({ phase: "error", detail: 'unknown Kokoro voice "not_a_real_voice"' })}\n`,
        ),
      ),
  );

  expect(res.status).toBe(502);
  expect((res.body as { error: string }).error).toContain(
    'unknown Kokoro voice "not_a_real_voice"',
  );
});
