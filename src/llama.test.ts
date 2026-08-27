import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, Probe } from "./docker.ts";
import { buildRunArgs, DockerLifecycle } from "./docker.ts";
import type { HttpClient } from "./llama.ts";
import { buildLlamaSpec, LlamaRouter, renderPresetIni } from "./llama.ts";
import type { EngineEntry, ModelEntry } from "./types.ts";

const ENGINES_ROOT = join(import.meta.dir, "..", "engines");
const BUNX = "/home/x/.bun/bin/bunx";
const CONTAINER_PORT = 8080;
const HOST_PORT = 55_123;
const LOAD_PATH = "/models/load";
const UNLOAD_PATH = "/models/unload";
const CHAT_PATH = "/v1/chat/completions";

function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return {
    id: "local-llama",
    egress: "none",
    models_dir: "/models-host",
    models_max: 3,
    args: {},
    ...overrides,
  };
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    id: "a",
    engine: "local-llama",
    filename: "a.gguf",
    role: "chat",
    aliases: [],
    args: {},
    ...overrides,
  };
}

function tmpIniPath(): string {
  return join(mkdtempSync(join(tmpdir(), "engined-llama-test-")), "preset.ini");
}

/** Answers `docker image inspect`/`run`/`start`/`port` the way a fresh, never-started container would. */
function fakeExec(): Exec {
  return (args) => {
    const [cmd] = args;
    if (cmd === "image") {
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify([{ Config: { ExposedPorts: { [`${CONTAINER_PORT}/tcp`]: {} } } }]),
        stderr: "",
      });
    }
    if (cmd === "start") {
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: "not created yet" });
    }
    if (cmd === "port") {
      return Promise.resolve({ exitCode: 0, stdout: `127.0.0.1:${HOST_PORT}\n`, stderr: "" });
    }
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  };
}

const fakeProbe: Probe = () => Promise.resolve({ status: 200 });

function baseOpts(httpClient: HttpClient) {
  return {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    idleStopSeconds: 1000,
    readyTimeoutS: 5,
    presetHostPath: tmpIniPath(),
    httpClient,
    pollIntervalMs: 1,
  };
}

interface RecordedCall {
  path: string;
  body: { model?: string; stream?: boolean } | undefined;
}

/** A minimal llama-server router double: load/unload always succeed, everything else echoes its request model. */
function fakeLlama(hook?: (call: RecordedCall) => Response | undefined): {
  client: HttpClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const client: HttpClient = (input, init) => {
    const url = new URL(String(input));
    const bodyStr = typeof init?.body === "string" ? init.body : undefined;
    const body = bodyStr === undefined ? undefined : (JSON.parse(bodyStr) as RecordedCall["body"]);
    const call: RecordedCall = { path: url.pathname, body };
    calls.push(call);
    const hooked = hook?.(call);
    if (hooked) {
      return Promise.resolve(hooked);
    }
    if (url.pathname === LOAD_PATH) {
      return Promise.resolve(Response.json({ status: "loaded" }));
    }
    if (url.pathname === UNLOAD_PATH) {
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.resolve(Response.json({ ok: true, model: body?.model }));
  };
  return { client, calls };
}

describe("renderPresetIni", () => {
  test("two models with different args produce two different INI sections", () => {
    const e = engine();
    const a = model({
      id: "a",
      filename: "a.gguf",
      args: { "spec-type": "draft-mtp", "spec-draft-p-min": 0.1 },
    });
    const b = model({ id: "b", filename: "b.gguf", args: {} });
    const ini = renderPresetIni(e, [a, b]);
    const sections = new Map(ini.split("\n\n").map((s) => [s.split("\n", 1)[0], s]));
    expect(sections.get("[a]")).toContain("spec-type = draft-mtp");
    expect(sections.get("[a]")).toContain("spec-draft-p-min = 0.1");
    expect(sections.get("[b]")).not.toContain("spec-type");
    expect(sections.get("[a]")).not.toBe(sections.get("[b]"));
  });

  test("a model arg beats an engine arg naming the same key", () => {
    const e = engine({ args: { "ctx-size": 4096 } });
    const a = model({ args: { "ctx-size": 8192 } });
    const ini = renderPresetIni(e, [a]);
    expect(ini).toContain("ctx-size = 8192");
    expect(ini).not.toContain("ctx-size = 4096");
  });
});

describe("buildLlamaSpec / buildRunArgs", () => {
  test("run argv pins models-max and sets no-models-autoload, never models-dir or /dev/kfd", () => {
    const e = engine({ models_max: 3 });
    const spec = buildLlamaSpec(e, { enginesRoot: ENGINES_ROOT, bunx: BUNX }, tmpIniPath());
    const argv = buildRunArgs("engined-local-llama", spec, CONTAINER_PORT);
    expect(argv).toContain("--no-models-autoload");
    const maxIdx = argv.indexOf("--models-max");
    expect(maxIdx).toBeGreaterThan(-1);
    expect(argv[maxIdx + 1]).toBe("3");
    expect(argv).not.toContain("--models-dir");
    expect(argv).not.toContain("/dev/kfd");
    const mountArgs = argv.filter((_, i) => argv[i - 1] === "-v");
    expect(mountArgs.some((m) => m.endsWith(":/models:ro"))).toBe(true);
    expect(mountArgs.some((m) => m.endsWith(":/preset.ini:ro"))).toBe(true);
  });
});

test("chat for model B while same-role model A is resident and idle: unload A, load B, then complete", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const b = model({ id: "b", filename: "b.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client, calls } = fakeLlama();
  const router = new LlamaRouter(e, [a, b], lifecycle, baseOpts(client));

  await router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }).text();
  await router.proxy(b, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "b" }) }).text();

  const paths = calls.map((c) => c.path);
  expect(paths).toEqual([LOAD_PATH, CHAT_PATH, UNLOAD_PATH, LOAD_PATH, CHAT_PATH]);
  expect(calls[2]?.body?.model).toBe("a");
  expect(calls[3]?.body?.model).toBe("b");
});

test("a different-role model resident is untouched by a chat swap", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf", role: "chat" });
  const b = model({ id: "b", filename: "b.gguf", role: "chat" });
  const v = model({ id: "v", filename: "v.gguf", role: "vision" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client, calls } = fakeLlama();
  const router = new LlamaRouter(e, [a, b, v], lifecycle, baseOpts(client));

  await router.proxy(v, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "v" }) }).text();
  await router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }).text();
  await router.proxy(b, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "b" }) }).text();

  const visionLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === "v",
  );
  expect(visionLoadOrUnload).toHaveLength(1);
  expect(visionLoadOrUnload[0]?.path).toBe(LOAD_PATH);
});

test("two overlapping chats for the same GGUF both complete without a second load", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  let releaseFirst: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  let firstStarted: () => void = () => undefined;
  const firstStartedPromise = new Promise<void>((r) => {
    firstStarted = r;
  });
  let sawFirstChat = false;
  const { client, calls } = fakeLlama();
  // Wrap the default client so the very first chat call gates on `gate` before resolving.
  const gatedClient: HttpClient = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === CHAT_PATH && !sawFirstChat) {
      sawFirstChat = true;
      firstStarted();
      await gate;
    }
    return client(input, init);
  };
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(gatedClient));

  const res1 = router.proxy(a, CHAT_PATH, {
    method: "POST",
    body: JSON.stringify({ model: "a" }),
  });
  await firstStartedPromise;
  const res2 = router.proxy(a, CHAT_PATH, {
    method: "POST",
    body: JSON.stringify({ model: "a" }),
  });

  const secondText = await Promise.race([
    res2.text().then((t) => ({ done: true, t })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 100)),
  ]);
  expect(secondText.done).toBe(true);

  releaseFirst();
  await res1.text();

  const loadCalls = calls.filter((c) => c.path === LOAD_PATH);
  expect(loadCalls).toHaveLength(1);
  expect(calls.filter((c) => c.path === UNLOAD_PATH)).toHaveLength(0);
});

test("a different-GGUF same-role chat arriving mid-lease waits, without eviction or a 409", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const b = model({ id: "b", filename: "b.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  let releaseFirst: () => void = () => undefined;
  const gate = new Promise<void>((r) => {
    releaseFirst = r;
  });
  let firstStarted: () => void = () => undefined;
  const firstStartedPromise = new Promise<void>((r) => {
    firstStarted = r;
  });
  let sawFirstChat = false;
  const { client, calls } = fakeLlama();
  const gatedClient: HttpClient = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === CHAT_PATH && !sawFirstChat) {
      sawFirstChat = true;
      firstStarted();
      await gate;
    }
    return client(input, init);
  };
  const router = new LlamaRouter(e, [a, b], lifecycle, baseOpts(gatedClient));

  const res1 = router.proxy(a, CHAT_PATH, {
    method: "POST",
    body: JSON.stringify({ model: "a" }),
  });
  await firstStartedPromise;

  const res2 = router.proxy(b, CHAT_PATH, {
    method: "POST",
    body: JSON.stringify({ model: "b" }),
  });
  // Let the pump run as far as it can while A's lease is still held.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  const bTouchedWhileWaiting = calls.some(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === "b",
  );
  expect(bTouchedWhileWaiting).toBe(false);

  releaseFirst();
  const text1 = await res1.text();
  expect((JSON.parse(text1) as { model?: string }).model).toBe("a");

  const text2 = await res2.text();
  expect((JSON.parse(text2) as { model?: string }).model).toBe("b");

  const unloadA = calls.find((c) => c.path === UNLOAD_PATH && c.body?.model === "a");
  expect(unloadA).toBeDefined();
});

test("/models/load returning loading is polled until loaded before any proxy call", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  let loadAttempts = 0;
  const { client, calls } = fakeLlama((call) => {
    if (call.path !== LOAD_PATH) {
      return;
    }
    loadAttempts++;
    const status = loadAttempts < 3 ? "loading" : "loaded";
    return Response.json({ status });
  });
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client));

  await router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }).text();

  expect(loadAttempts).toBe(3);
  const loadIdxs = calls.map((c, i) => (c.path === LOAD_PATH ? i : -1)).filter((i) => i >= 0);
  const chatIdx = calls.findIndex((c) => c.path === CHAT_PATH);
  expect(chatIdx).toBeGreaterThan(Math.max(...loadIdxs));
});

// Concurrent chat + vision decode needs a registered vision [[model]] against
// a real GGUF, which does not exist in this repo. Do not alias a chat model
// onto the vision role to make this runnable -- see TODO.md's acceptance
// criteria for this engine; the criterion is skipped, not faked.
