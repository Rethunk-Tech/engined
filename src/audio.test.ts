import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { handleSpeech, handleTranscription, resetSpeechCache } from "./audio.ts";
import { handleAudioSpeech, handleAudioTranscription } from "./audioDoor.ts";
import { buildRunArgs, DockerLifecycle } from "./docker.ts";
import type { DoorContext } from "./doorContext.ts";
import { EngineRegistry } from "./engines.ts";
import type { Exec, ExecResult } from "./exec.ts";
import { loadSpec } from "./spec.ts";
import {
  BUNX,
  collectLines,
  config,
  containerRunning,
  deadPort,
  ENGINES_ROOT,
  engine,
  makeTestRoot,
  route,
  soleProvenanceRecord,
  startFakeUpstream,
  upstream,
} from "./test-support.ts";
import type { EngineEntry } from "./types.ts";
import { CONTENT_ENDPOINT_TRANSCRIPTIONS, isContainerSpec } from "./types.ts";

// The synthesis cache is process-wide, which is the point in a daemon and a
// hazard in a suite: without this, one test's rendition answers another's
// request and a chain never reaches the hop it was written to prove.
beforeEach(resetSpeechCache);

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
  const fake = startFakeUpstream((req) => {
    if (new URL(req.url).pathname === "/v1/tts") {
      return new Response(`${JSON.stringify({ audio: SAMPLE_WAV_BASE64, alignment: null })}\n`, {
        headers: { "content-type": "application/x-ndjson" },
      });
    }
    return new Response("not found", { status: 404 });
  });
  // A `private_url` carries no scheme, so this one is built from the port
  // rather than handed back as `startFakeUpstream`'s own schemed `base`.
  return { base: `127.0.0.1:${fake.port}`, stop: fake.stop };
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

/** The per-request fields whisper-server reads off the form; `translate` is a string here because a multipart field is always one. */
interface WhisperRequest {
  language?: string;
  response_format?: string;
  prompt?: string;
  translate?: string;
}

/** A real `Bun.serve` fake whisper: echoes back the multipart fields it received. */
function startFakeWhisper(): {
  base: string;
  requests: WhisperRequest[];
  stop: () => void;
} {
  const requests: WhisperRequest[] = [];
  const fake = startFakeUpstream(async (req) => {
    const form = await req.formData();
    const language = form.get("language");
    const responseFormat = form.get("response_format");
    const prompt = form.get("prompt");
    const translate = form.get("translate");
    requests.push({
      language: typeof language === "string" ? language : undefined,
      response_format: typeof responseFormat === "string" ? responseFormat : undefined,
      prompt: typeof prompt === "string" ? prompt : undefined,
      translate: typeof translate === "string" ? translate : undefined,
    });
    if (responseFormat === "text") {
      return new Response("hello world", { headers: { "content-type": "text/plain" } });
    }
    return Response.json({ text: "hello world" });
  });
  return { base: `127.0.0.1:${fake.port}`, requests, stop: fake.stop };
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

test("a per-request prompt reaches the engine, which is what biases a proper noun", async () => {
  const fake = startFakeWhisper();

  await handleTranscription(
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES, prompt: "Priya, nginx, sekhmet" },
    async () => ({ private_url: fake.base }),
  );
  fake.stop();

  expect(fake.requests[0]?.prompt).toBe("Priya, nginx, sekhmet");
});

test("no prompt means the field is absent, not an empty initial prompt", async () => {
  const fake = startFakeWhisper();

  await handleTranscription({ engine: "whisper", file: SAMPLE_AUDIO_BYTES }, async () => ({
    private_url: fake.base,
  }));
  fake.stop();

  expect(fake.requests[0]?.prompt).toBeUndefined();
});

test("translate reaches the engine as its own field, which is the whole of the translations verb", async () => {
  const fake = startFakeWhisper();

  await handleTranscription(
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES, translate: true },
    async () => ({ private_url: fake.base }),
  );
  fake.stop();

  expect(fake.requests[0]?.translate).toBe("true");
});

// Absent, never "false": whisper-server parses this field with its own
// string-to-bool, and a door that always sent one would be relying on that
// parse agreeing with ours for a request that never asked to translate.
test("a transcription sends no translate field at all", async () => {
  const fake = startFakeWhisper();

  await handleTranscription({ engine: "whisper", file: SAMPLE_AUDIO_BYTES }, async () => ({
    private_url: fake.base,
  }));
  fake.stop();

  expect(fake.requests[0]?.translate).toBeUndefined();
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

test("an error exit cancels the engine's own body, not only the caller's request", async () => {
  // A 502 hands back no stream, so nothing later reads the upstream body: one
  // left open holds a live response against a running engine forever.
  let cancelled = false;
  const encoder = new TextEncoder();
  const line = `${JSON.stringify({ phase: "error", detail: "text produced no audio" })}\n`;
  // Never closes: the engine keeps the connection open past its own error frame.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(line));
    },
    cancel() {
      cancelled = true;
    },
  });

  const res = await handleSpeech(
    { engine: "piper", input: ".", stream: true },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(body)),
  );
  await Bun.sleep(1);

  expect(res.status).toBe(502);
  expect(res.body).toEqual({ error: "piper: /v1/tts failed: text produced no audio" });
  expect(cancelled).toBe(true);
});

test("an error frame mid-stream cancels the engine's own body as the caller's stream ends", async () => {
  // Closing the caller's stream does not reach the source it was built over,
  // so the same open body outlives a failure that arrives after the first chunk.
  let cancelled = false;
  const encoder = new TextEncoder();
  const chunk = `${JSON.stringify({
    phase: "chunk",
    pcm: Buffer.from([1, 2]).toString("base64"),
    rate: 24_000,
  })}\n`;
  const failure = `${JSON.stringify({ phase: "error", detail: "vocoder died" })}\n`;
  let sentChunk = false;
  // Never closes: the engine keeps the connection open past its own error frame.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(sentChunk ? failure : chunk));
      sentChunk = true;
    },
    cancel() {
      cancelled = true;
    },
  });

  const res = await handleSpeech(
    { engine: "piper", input: "hi", stream: true },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(body)),
  );

  const out = Buffer.from(await new Response(res.stream).arrayBuffer());
  await Bun.sleep(1);

  expect([...out]).toEqual([1, 2]);
  expect(cancelled).toBe(true);
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

test('stream: "ndjson" forwards a chunk\'s word timings, and only well-formed ones', async () => {
  const frames = [
    JSON.stringify({
      phase: "chunk",
      pcm: Buffer.from([1, 2]).toString("base64"),
      rate: 24_000,
      words: [{ text: "hi", start: 0.1, end: 0.4 }, { text: "bad" }, "junk"],
      invented: true,
    }),
    JSON.stringify({ phase: "done" }),
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
  expect(out[0]).toEqual({
    phase: "chunk",
    pcm: Buffer.from([1, 2]).toString("base64"),
    rate: 24_000,
    words: [{ text: "hi", start: 0.1, end: 0.4 }],
  });
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

test('stream: "ndjson" skips a literal null line instead of throwing mid-body', async () => {
  // A `null` line parses fine, so reading a field off it throws where the
  // stream is already committed -- the caller gets truncated bytes, not a 502.
  const frames = ["null", JSON.stringify({ phase: "done", audio: SAMPLE_WAV_BASE64 })].join("\n");
  const res = await handleSpeech(
    { engine: "chatterbox-multi", input: "hi", stream: "ndjson" },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(frames)),
  );

  const out = (await new Response(res.stream).text())
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  expect(out).toEqual([{ phase: "done", audio: SAMPLE_WAV_BASE64 }]);
});

test("a caller who hangs up mid-stream cancels the engine's own body", async () => {
  // An upstream body left open holds a live response against a running engine,
  // and nothing later closes it -- the caller is already gone.
  let cancelled = false;
  const encoder = new TextEncoder();
  const line = `${JSON.stringify({ phase: "synthesizing", step: 1, step_limit: 1000 })}\n`;
  // Never closes: synthesis is still in flight when the caller lets go.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(line));
    },
    cancel() {
      cancelled = true;
    },
  });

  const res = await handleSpeech(
    { engine: "chatterbox-multi", input: "hi", stream: "ndjson" },
    () => Promise.resolve({ private_url: "127.0.0.1:1", remote: undefined }),
    () => Promise.resolve(new Response(body)),
  );
  const forwarded = res.stream;
  if (forwarded === undefined) {
    throw new Error('stream: "ndjson" returned no stream to hang up on');
  }

  const reader = forwarded.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(1);

  expect(cancelled).toBe(true);
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

const CHATTERBOX_HOST_PORT = 41_100;

/**
 * A door context over one real chatterbox-multi spec, started and running:
 * enough for the two audio verbs, and nothing else. `hostPort` is what
 * `docker port` reports, so a caller with a fake engine listening somewhere
 * points the container's mapping at it; the default reaches nothing, which is
 * what every test asserting a refusal wants.
 *
 * `upstreamId` names the `[[upstream]]` the route pairs with, so a suite can
 * tell a local engine from a remote one in what the door records.
 */
function speechDoorContext(opts: { hostPort?: number; upstreamId?: string } = {}): {
  ctx: DoorContext;
  lifecycle: DockerLifecycle;
  lines: string[];
} {
  const { hostPort = CHATTERBOX_HOST_PORT, upstreamId = "local" } = opts;
  const exec = makeExec({ stdout: CHATTERBOX_INSPECT, stderr: "", exitCode: 0 }, (argv) => {
    if (argv[0] === "start") {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (argv[0] === "port") {
      return { stdout: `127.0.0.1:${hostPort}`, stderr: "", exitCode: 0 };
    }
  });
  const lifecycle = makeLifecycle(exec);
  const cfg = config({
    engines: [engine({ id: "chatterbox-multi", idle_stop_seconds: 60 })],
    upstreams: [upstream({ id: upstreamId })],
    routes: [route({ engine: "chatterbox-multi", model: undefined, upstream: upstreamId })],
  });
  const registry = new EngineRegistry(cfg, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle,
  });
  const { lines, write } = collectLines();
  const ctx: DoorContext = {
    getConfig: () => cfg,
    registry,
    lifecycle,
    registryOpts: { enginesRoot: ENGINES_ROOT, bunx: BUNX, lifecycle },
    doorOpts: { write },
    llamaRouters: new Map(),
    staleLlamaRouters: new Set(),
    launchNonces: new Set(),
    comfyBindings: new Map(),
    comfySlots: new Map(),
  };
  return { ctx, lifecycle, lines };
}

/**
 * Two real TTS specs side by side, each container mapped to whichever host
 * port the caller names for it, so one hop can be pointed at a live fake and
 * the other at a port nothing listens on. `chains` is what the door resolves a
 * bare name to.
 */
function chainDoorContext(ports: Record<string, number>): { ctx: DoorContext; lines: string[] } {
  const exec = makeExec({ stdout: CHATTERBOX_INSPECT, stderr: "", exitCode: 0 }, (argv) => {
    if (argv[0] === "port") {
      const id = Object.keys(ports).find((engineId) => argv[1]?.includes(engineId));
      return { stdout: `127.0.0.1:${ports[id ?? ""]}`, stderr: "", exitCode: 0 };
    }
  });
  const lifecycle = makeLifecycle(exec);
  const cfg = config({
    engines: Object.keys(ports).map((id) => engine({ id, idle_stop_seconds: 60 })),
    upstreams: [upstream()],
    routes: Object.keys(ports).map((id) => route({ engine: id, model: undefined })),
    chains: { "chain-tts": Object.keys(ports).map((id) => `@/${id}/local`) },
  });
  const registry = new EngineRegistry(cfg, { enginesRoot: ENGINES_ROOT, bunx: BUNX, lifecycle });
  const { lines, write } = collectLines();
  const ctx: DoorContext = {
    getConfig: () => cfg,
    registry,
    lifecycle,
    registryOpts: { enginesRoot: ENGINES_ROOT, bunx: BUNX, lifecycle },
    doorOpts: { write },
    llamaRouters: new Map(),
    staleLlamaRouters: new Set(),
    launchNonces: new Set(),
    comfyBindings: new Map(),
    comfySlots: new Map(),
  };
  return { ctx, lines };
}

test("a speech chain advances past an engine that cannot answer and the next one synthesizes", async () => {
  const fake = startFakeChatterboxMulti();
  const { ctx, lines } = chainDoorContext({
    "chatterbox-multi": deadPort(),
    "chatterbox-en": Number(fake.base.split(":")[1]),
  });

  const res = await handleAudioSpeech(ctx, { model: "chain-tts", input: "hello there" });
  fake.stop();

  // The point of the whole feature: without a chain, a local TTS that cannot
  // answer is the end of the request -- audio has nothing else to advance to.
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toBe("audio/wav");
  expect(Buffer.from(await res.arrayBuffer()).equals(SAMPLE_WAV_BYTES)).toBe(true);

  const record = soleProvenanceRecord(lines);
  expect(record.chain).toBe("chain-tts");
  expect(record.attempts.map((a) => a.engine)).toEqual(["chatterbox-multi", "chatterbox-en"]);
  expect(record.attempts[0]?.ok).toBe(false);
  expect(record.engine_used).toBe("chatterbox-en");
});

test("a speech chain whose every hop fails answers JSON, not a content type promising audio", async () => {
  const { ctx, lines } = chainDoorContext({
    "chatterbox-multi": deadPort(),
    "chatterbox-en": deadPort(),
  });

  const res = await handleAudioSpeech(ctx, { model: "chain-tts", input: "hello there" });

  expect(res.status).toBe(503);
  // A hop that failed still set a content type on its way out; typing this body
  // as audio would hand the caller a JSON error to play.
  expect(res.headers.get("content-type")).toContain("application/json");

  const record = soleProvenanceRecord(lines);
  expect(record.engine_used).toBeNull();
  expect(record.attempts).toHaveLength(2);
});

test("a recording streamed as the request body is refused a chain rather than replayed into silence", async () => {
  const { ctx } = chainDoorContext({ "chatterbox-multi": deadPort() });
  const query = new URLSearchParams({ stream: "true", model: "chain-tts" });
  const req = new Request(`http://engined${CONTENT_ENDPOINT_TRANSCRIPTIONS}?${query}`, {
    method: "POST",
    headers: { "content-type": "audio/wav" },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(SAMPLE_WAV_BYTES));
        controller.close();
      },
    }),
  });

  const res = await handleAudioTranscription(ctx, req);

  expect(res.status).toBe(400);
  expect((await res.json()).error).toContain("cannot be replayed");
});

test("a speech call records the upstream its route resolved to, not a bare null", async () => {
  const fake = startFakeChatterboxMulti();
  const { ctx, lines } = speechDoorContext({ hostPort: Number(fake.base.split(":")[1]) });

  const res = await handleAudioSpeech(ctx, {
    model: "@/chatterbox-multi/local",
    input: "hello there",
  });
  fake.stop();
  expect(res.status).toBe(200);

  // Which upstream answered is the whole question an audio provenance line is
  // asked: one engine id fronts a local container and a metered vendor alike,
  // so the engine alone cannot say whether the call was billed. The id comes
  // off the resolved route, so the local answer here and a vendor's travel the
  // same field -- what this guards is that the field is filled at all.
  const record = soleProvenanceRecord(lines);
  expect(record.upstream_used).toBe("local");
  expect(record.attempts[0]?.upstream_used).toBe("local");
});

test("a speech body refused before the engine is started does not release another request's lease", async () => {
  const { ctx, lifecycle } = speechDoorContext();
  await ctx.registry.start("chatterbox-multi");

  // The interleaving: one synthesis is in flight and holds the container
  // open. A second caller then posts a body that is refused before `start`
  // is ever reached -- so it takes no lease of its own.
  lifecycle.beginLease("chatterbox-multi");
  expect(lifecycle.getStatus("chatterbox-multi").active_leases).toBe(1);

  const refused = await handleAudioSpeech(ctx, { model: "@/chatterbox-multi/local", input: "" });
  expect(refused.status).toBe(400);

  // Releasing here would hand away a lease this caller never held, arming an
  // idle-stop against the synthesis that is still running.
  expect(lifecycle.getStatus("chatterbox-multi").active_leases).toBe(1);
});

/**
 * A whisper wrapper mid-decode: one segment frame is available now, and the
 * terminal transcript does not exist until `release` is called. Reading the
 * segment before then is the only thing that distinguishes streaming from
 * cutting up a transcript the engine already finished.
 */
function decodingWhisperBody(): { body: ReadableStream<Uint8Array>; release: () => void } {
  const encoder = new TextEncoder();
  const { promise: stillDecoding, resolve: release } = Promise.withResolvers<void>();
  let segmentSent = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!segmentSent) {
        segmentSent = true;
        // `decoder` is the engine inventing a field beside the door's own list.
        controller.enqueue(
          encoder.encode(
            `${JSON.stringify({ phase: "segment", text: "set a timer", start: 2.59, end: 5.49, decoder: "greedy" })}\n`,
          ),
        );
        return;
      }
      await stillDecoding;
      controller.enqueue(
        encoder.encode(
          `${JSON.stringify({ phase: "done", text: "set a timer for 25 minutes" })}\n`,
        ),
      );
      controller.close();
    },
  });
  return { body, release };
}

test("a streamed transcription forwards each segment as it lands, ahead of the terminal transcript", async () => {
  const { body, release } = decodingWhisperBody();
  let asked: { url: string; body: unknown } | undefined;
  const res = await handleTranscription(
    {
      engine: "whisper",
      file: SAMPLE_AUDIO_BYTES,
      language: "en",
      prompt: "Priya",
      stream: true,
    },
    async () => ({ private_url: "127.0.0.1:1" }),
    (url, init) => {
      asked = { url, body: init?.body };
      return Promise.resolve(new Response(body));
    },
  );

  // The streamed route is the door's own, and takes the recording as a bare
  // body -- the OpenAI verb's multipart path is left exactly as it was.
  const asJson = new URL(asked?.url ?? "");
  expect(asJson.pathname).toBe("/v1/audio/transcriptions/stream");
  expect(asJson.searchParams.get("language")).toBe("en");
  expect(asJson.searchParams.get("prompt")).toBe("Priya");
  expect(asked?.body).toBe(SAMPLE_AUDIO_BYTES);
  expect(res.contentType).toBe("application/x-ndjson");

  const reader = (res.stream ?? new ReadableStream<Uint8Array>()).getReader();
  const first = await reader.read();
  expect(JSON.parse(new TextDecoder().decode(first.value))).toEqual({
    phase: "segment",
    text: "set a timer",
    start: 2.59,
    end: 5.49,
  });

  release();
  const rest: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    rest.push(new TextDecoder().decode(value));
  }
  expect(rest.join("").trim()).toBe(
    JSON.stringify({ phase: "done", text: "set a timer for 25 minutes" }),
  );
});

test("a caller who hangs up mid-transcript cancels the engine's own decode", async () => {
  // A dropped body does not reach the far side, so nothing else stops whisper
  // from decoding a recording whose caller is already gone.
  let cancelled = false;
  const encoder = new TextEncoder();
  const line = `${JSON.stringify({ phase: "segment", text: "still decoding", start: 0, end: 1 })}\n`;
  // Never closes: the recording is still being decoded when the caller lets go.
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(encoder.encode(line));
    },
    cancel() {
      cancelled = true;
    },
  });

  const res = await handleTranscription(
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES, stream: true },
    async () => ({ private_url: "127.0.0.1:1" }),
    () => Promise.resolve(new Response(body)),
  );
  const forwarded = res.stream;
  if (forwarded === undefined) {
    throw new Error("a streamed transcription returned no stream to hang up on");
  }

  const reader = forwarded.getReader();
  await reader.read();
  await reader.cancel();
  await Bun.sleep(1);

  expect(cancelled).toBe(true);
});

test("a streamed transcription refuses a whole-body response_format instead of ignoring it", async () => {
  let asked = false;
  const res = await handleTranscription(
    { engine: "whisper", file: SAMPLE_AUDIO_BYTES, stream: true, response_format: "srt" },
    async () => ({ private_url: "127.0.0.1:1" }),
    () => {
      asked = true;
      return Promise.resolve(new Response(""));
    },
  );

  expect(res.status).toBe(400);
  expect((res.body as { error: string }).error).toContain("NDJSON frames");
  expect(asked).toBe(false);
});

test("a remote STT engine refuses to stream rather than answering one buffered body", async () => {
  const res = await handleTranscription(
    { engine: "elevenlabs", model: "scribe_v1", file: SAMPLE_AUDIO_BYTES, stream: true },
    async () => ({
      private_url: null,
      remote: { base_url: "https://api.elevenlabs.io/v1", headers: { "xi-api-key": "k" } },
    }),
    () => {
      throw new Error("a refused stream must never reach the upstream");
    },
  );

  expect(res.status).toBe(400);
  expect((res.body as { error: string }).error).toContain(
    "no remote transcription dialect streams",
  );
});
