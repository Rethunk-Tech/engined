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
const EMBED_PATH = "/v1/embeddings";
const READY_TIMEOUT_ERROR = /readyTimeoutS/;

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

/** `proxy()` now returns `Promise<Response>` — real status requires buffering, see llama.ts. */
async function text(res: Promise<Response>): Promise<string> {
  return (await res).text();
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

/** Matches the real b10354 contract, probed live: never `{status:"loaded"}` --
 * the first `/models/load` for a model answers `{success:true}` (accepted,
 * still loading) and every call once it is resident 400s "model is already
 * running". Second call onward reports resident, same as the real child did
 * for the tiny nomic embedding model in the live probe. */
function alreadyRunning(): Response {
  return Response.json(
    { error: { code: 400, message: "model is already running", type: "invalid_request_error" } },
    { status: 400 },
  );
}

/** A minimal llama-server router double: load/unload always succeed, everything else echoes its request model. */
function fakeLlama(hook?: (call: RecordedCall) => Response | undefined): {
  client: HttpClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const loadCounts = new Map<string, number>();
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
      const key = body?.model ?? "";
      const n = (loadCounts.get(key) ?? 0) + 1;
      loadCounts.set(key, n);
      return Promise.resolve(n === 1 ? Response.json({ success: true }) : alreadyRunning());
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

  test("an embedding model's pooling/RoPE keys render in its section only, never a chat model's", () => {
    const e = engine();
    const chat = model({ id: "chat-a", filename: "a.gguf", role: "chat", args: {} });
    const embed = model({
      id: "embed",
      filename: "embed.gguf",
      role: "embedding",
      args: { pooling: "mean", "rope-freq-base": 0, "rope-freq-scale": 0 },
    });
    const ini = renderPresetIni(e, [chat, embed]);
    const sections = new Map(ini.split("\n\n").map((s) => [s.split("\n", 1)[0], s]));
    expect(sections.get("[embed]")).toContain("pooling = mean");
    expect(sections.get("[embed]")).toContain("rope-freq-base = 0");
    expect(sections.get("[chat-a]")).not.toContain("pooling");
    expect(sections.get("[chat-a]")).not.toContain("rope-freq");
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

  await text(router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }));
  await text(router.proxy(b, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "b" }) }));

  // Default fakeLlama mirrors the real b10354 handshake: a fresh load takes
  // two /models/load calls (accepted, then already-running) before the swap
  // proceeds.
  const paths = calls.map((c) => c.path);
  expect(paths).toEqual([
    LOAD_PATH,
    LOAD_PATH,
    CHAT_PATH,
    UNLOAD_PATH,
    LOAD_PATH,
    LOAD_PATH,
    CHAT_PATH,
  ]);
  expect(calls[3]?.body?.model).toBe("a");
  expect(calls[4]?.body?.model).toBe("b");
});

test("a different-role model resident is untouched by a chat swap", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf", role: "chat" });
  const b = model({ id: "b", filename: "b.gguf", role: "chat" });
  const v = model({ id: "v", filename: "v.gguf", role: "vision" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client, calls } = fakeLlama();
  const router = new LlamaRouter(e, [a, b, v], lifecycle, baseOpts(client));

  await text(router.proxy(v, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "v" }) }));
  await text(router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }));
  await text(router.proxy(b, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "b" }) }));

  // Two /models/load calls (the default fake's accepted-then-already-running
  // handshake) and never an unload: vision is loaded once, up front, and the
  // later chat swaps between "a" and "b" never touch its role.
  const visionLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === "v",
  );
  expect(visionLoadOrUnload).toHaveLength(2);
  expect(visionLoadOrUnload.every((c) => c.path === LOAD_PATH)).toBe(true);
});

test("an embedding request co-resides with a resident chat model: neither evicts the other", async () => {
  const e = engine();
  const chat = model({ id: "chat-a", filename: "a.gguf", role: "chat" });
  const embed = model({ id: "embed", filename: "embed.gguf", role: "embedding" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client, calls } = fakeLlama();
  const router = new LlamaRouter(e, [chat, embed], lifecycle, baseOpts(client));

  await text(
    router.proxy(chat, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "chat-a" }) }),
  );
  await text(
    router.proxy(embed, EMBED_PATH, { method: "POST", body: JSON.stringify({ model: "embed" }) }),
  );
  await text(
    router.proxy(chat, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "chat-a" }) }),
  );

  const chatLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === "chat-a",
  );
  const embedLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === "embed",
  );
  // Each loaded exactly once (the default fake's two-call accepted-then-
  // already-running handshake) and never unloaded: the embedding request did
  // not evict the chat resident, and the second chat request -- already the
  // resident -- took the synchronous fast path with no further load call.
  expect(chatLoadOrUnload).toEqual([
    { path: LOAD_PATH, body: { model: "chat-a" } },
    { path: LOAD_PATH, body: { model: "chat-a" } },
  ]);
  expect(embedLoadOrUnload).toEqual([
    { path: LOAD_PATH, body: { model: "embed" } },
    { path: LOAD_PATH, body: { model: "embed" } },
  ]);
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
    text(res2).then((t) => ({ done: true, t })),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 100)),
  ]);
  expect(secondText.done).toBe(true);

  releaseFirst();
  await text(res1);

  // Two /models/load calls total (the default fake's accepted-then-already-
  // running handshake for the one load) -- the overlapping second request
  // found the resident already active and took the synchronous fast path,
  // issuing no load call of its own.
  const loadCalls = calls.filter((c) => c.path === LOAD_PATH);
  expect(loadCalls).toHaveLength(2);
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
  const text1 = await text(res1);
  expect((JSON.parse(text1) as { model?: string }).model).toBe("a");

  const text2 = await text(res2);
  expect((JSON.parse(text2) as { model?: string }).model).toBe("b");

  const unloadA = calls.find((c) => c.path === UNLOAD_PATH && c.body?.model === "a");
  expect(unloadA).toBeDefined();
});

test("/models/load answering success:true is polled until the already-running 400 before any proxy call", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  let loadAttempts = 0;
  const { client, calls } = fakeLlama((call) => {
    if (call.path !== LOAD_PATH) {
      return;
    }
    loadAttempts++;
    return loadAttempts < 3 ? Response.json({ success: true }) : alreadyRunning();
  });
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client));

  await text(router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }));

  expect(loadAttempts).toBe(3);
  const loadIdxs = calls.map((c, i) => (c.path === LOAD_PATH ? i : -1)).filter((i) => i >= 0);
  const chatIdx = calls.findIndex((c) => c.path === CHAT_PATH);
  expect(chatIdx).toBeGreaterThan(Math.max(...loadIdxs));
});

test("a /models/load that never reaches the already-running 400 fails within the timeout instead of hanging", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client } = fakeLlama((call) =>
    call.path === LOAD_PATH ? Response.json({ success: true }) : undefined,
  );
  const router = new LlamaRouter(e, [a], lifecycle, { ...baseOpts(client), readyTimeoutS: 0.05 });

  await expect(
    text(router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) })),
  ).rejects.toThrow(READY_TIMEOUT_ERROR);
});

test("the role's lease is free after a failed load: a later request for the role proceeds", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const b = model({ id: "b", filename: "b.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client } = fakeLlama((call) =>
    call.path === LOAD_PATH && call.body?.model === "a"
      ? Response.json({ success: true })
      : undefined,
  );
  const router = new LlamaRouter(e, [a, b], lifecycle, {
    ...baseOpts(client),
    readyTimeoutS: 0.05,
  });

  await expect(
    text(router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) })),
  ).rejects.toThrow();

  const result = await Promise.race([
    text(router.proxy(b, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "b" }) })).then(
      (t) => ({ done: true as const, t }),
    ),
    new Promise<{ done: false }>((resolve) => setTimeout(() => resolve({ done: false }), 500)),
  ]);
  expect(result.done).toBe(true);
  expect(result.done && (JSON.parse(result.t) as { model?: string }).model).toBe("b");
});

// Concurrent chat + vision decode needs a registered vision [[model]] against
// a real GGUF, which does not exist in this repo. Do not alias a chat model
// onto the vision role to make this runnable -- see TODO.md's acceptance
// criteria for this engine; the criterion is skipped, not faked.
