import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, Probe } from "./docker.ts";
import { buildRunArgs, DockerLifecycle } from "./docker.ts";
import type { HttpClient } from "./llama.ts";
import { buildLlamaSpec, LlamaRouter, renderPresetIni, reportedModelFrom } from "./llama.ts";
import type { EngineEntry, ModelEntry } from "./types.ts";

const ENGINES_ROOT = join(import.meta.dir, "..", "engines");
const BUNX = "/home/x/.bun/bin/bunx";
const CONTAINER_PORT = 8080;
const HOST_PORT = 55_123;
const LOAD_PATH = "/models/load";
const UNLOAD_PATH = "/models/unload";
const CHAT_PATH = "/v1/chat/completions";
const EMBED_PATH = "/v1/embeddings";
const MODELS_LIST_PATH = "/v1/models";
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

/** Structured parse of `renderPresetIni`'s output: `id -> {key: value}`, section-name brackets stripped. */
function parseIniSections(ini: string): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const block of ini.split("\n\n")) {
    const [header, ...lines] = block.split("\n");
    const id = header?.replace(/^\[|\]$/g, "");
    if (id === undefined) {
      continue;
    }
    const kv: Record<string, string> = {};
    for (const line of lines) {
      const [k, v] = line.split(" = ");
      if (k !== undefined && v !== undefined) {
        kv[k] = v;
      }
    }
    out.set(id, kv);
  }
  return out;
}

/** Matches the real b10354 contract, probed live: `/models/load` never returns
 * `{status:"loaded"}` -- a not-yet-resident model answers `{success:true}`
 * (accepted) and an already-resident one 400s "model is already running".
 * That 400 is not readiness either -- probed live, it fired while a 23 GB
 * GGUF was still on load stage 0. The real signal is `GET /v1/models`'s
 * per-model `status.value`, which transitions unloaded -> loading -> loaded. */
function modelsList(entries: Array<{ id: string; status: string }>): Response {
  return Response.json({ data: entries.map((e) => ({ id: e.id, status: { value: e.status } })) });
}

/** A minimal llama-server router double: load/unload always succeed and the model
 * requested becomes immediately "loaded" on the next /v1/models poll; everything
 * else echoes its request model. */
function fakeLlama(hook?: (call: RecordedCall) => Response | undefined): {
  client: HttpClient;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let lastLoadRequested: string | undefined;
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
      lastLoadRequested = body?.model;
      return Promise.resolve(Response.json({ success: true }));
    }
    if (url.pathname === MODELS_LIST_PATH) {
      return Promise.resolve(
        modelsList(
          lastLoadRequested === undefined ? [] : [{ id: lastLoadRequested, status: "loaded" }],
        ),
      );
    }
    if (url.pathname === UNLOAD_PATH) {
      return Promise.resolve(Response.json({ ok: true }));
    }
    return Promise.resolve(Response.json({ ok: true, model: body?.model }));
  };
  return { client, calls };
}

describe("renderPresetIni", () => {
  test("two models with different [model.args] produce two different INI sections, and the run argv points the child at that file", () => {
    const e = engine();
    const a = model({
      id: "a",
      filename: "a.gguf",
      args: { "spec-type": "draft-mtp", "spec-draft-p-min": 0.1 },
    });
    const b = model({ id: "b", filename: "b.gguf", args: {} });
    const ini = renderPresetIni(e, [a, b]);
    const sections = parseIniSections(ini);
    // Structured, not substring: proves the exact key set each section
    // carries, not merely that a wanted phrase appears somewhere in it.
    expect(sections.get("a")).toEqual({
      model: "/models/a.gguf",
      "spec-type": "draft-mtp",
      "spec-draft-p-min": "0.1",
    });
    expect(sections.get("b")).toEqual({ model: "/models/b.gguf" });

    // Proves different *file content* only -- not that llama-server honours
    // a per-model key rather than ignoring it. The run argv below is what
    // connects that file to the child: `--models-preset` names the mounted
    // path. Reading the child's real argv/`/slots` per flag needs a live
    // container and belongs to a smoke test under test/local/.
    const spec = buildLlamaSpec(e, { enginesRoot: ENGINES_ROOT, bunx: BUNX }, tmpIniPath());
    const argv = buildRunArgs("engined-local-llama", spec, CONTAINER_PORT);
    const presetIdx = argv.indexOf("--models-preset");
    expect(presetIdx).toBeGreaterThan(-1);
    expect(argv[presetIdx + 1]).toBe("/preset.ini");
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

  // Default fakeLlama mirrors the real b10354 handshake: a POST /models/load
  // trigger, then a GET /v1/models poll for the "loaded" status -- the real
  // ready signal, per the live probe -- before the swap proceeds.
  const paths = calls.map((c) => c.path);
  expect(paths).toEqual([
    LOAD_PATH,
    MODELS_LIST_PATH,
    CHAT_PATH,
    UNLOAD_PATH,
    LOAD_PATH,
    MODELS_LIST_PATH,
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

  const visionLoadOrUnload = calls.filter(
    (c) => (c.path === LOAD_PATH || c.path === UNLOAD_PATH) && c.body?.model === "v",
  );
  expect(visionLoadOrUnload).toHaveLength(1);
  expect(visionLoadOrUnload[0]?.path).toBe(LOAD_PATH);
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
  // Each loaded exactly once and never unloaded: the embedding request did not
  // evict the chat resident, and the second chat request did not re-swap.
  expect(chatLoadOrUnload).toEqual([{ path: LOAD_PATH, body: { model: "chat-a" } }]);
  expect(embedLoadOrUnload).toEqual([{ path: LOAD_PATH, body: { model: "embed" } }]);
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
  const text1 = await text(res1);
  expect((JSON.parse(text1) as { model?: string }).model).toBe("a");

  const text2 = await text(res2);
  expect((JSON.parse(text2) as { model?: string }).model).toBe("b");

  const unloadA = calls.find((c) => c.path === UNLOAD_PATH && c.body?.model === "a");
  expect(unloadA).toBeDefined();
});

test('/models/load only triggers; readiness is polled via /v1/models until "loaded"', async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  let pollAttempts = 0;
  const { client, calls } = fakeLlama((call) => {
    if (call.path !== MODELS_LIST_PATH) {
      return;
    }
    pollAttempts++;
    return modelsList([{ id: "a", status: pollAttempts < 3 ? "loading" : "loaded" }]);
  });
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client));

  await text(router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) }));

  expect(pollAttempts).toBe(3);
  const pollIdxs = calls
    .map((c, i) => (c.path === MODELS_LIST_PATH ? i : -1))
    .filter((i) => i >= 0);
  const chatIdx = calls.findIndex((c) => c.path === CHAT_PATH);
  expect(chatIdx).toBeGreaterThan(Math.max(...pollIdxs));
});

test('a model that never reports "loaded" via /v1/models fails within the timeout instead of hanging', async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client } = fakeLlama((call) =>
    call.path === MODELS_LIST_PATH ? modelsList([{ id: "a", status: "loading" }]) : undefined,
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
  let lastLoad: string | undefined;
  const { client } = fakeLlama((call) => {
    if (call.path === LOAD_PATH) {
      lastLoad = call.body?.model;
      return; // default {success:true} answers the trigger
    }
    // "a" never reports loaded; "b" falls through to the default fake's
    // immediate "loaded" so the later request can prove the role recovered.
    return call.path === MODELS_LIST_PATH && lastLoad === "a"
      ? modelsList([{ id: "a", status: "loading" }])
      : undefined;
  });
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

test("a cold streaming request emits `: warming` before its first real byte", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client } = fakeLlama();
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client));

  const res = await router.proxy(a, CHAT_PATH, {
    method: "POST",
    body: JSON.stringify({ model: "a", stream: true }),
  });
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("expected a body reader");
  }
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toBe(": warming\n\n");
});

test("a cold non-streaming request never gets an SSE `: warming` comment, which would corrupt its JSON body", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  const { client } = fakeLlama();
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client));

  // No prior proxy() call: this is the container's first request, the
  // coldest possible load.
  const res = await router.proxy(a, CHAT_PATH, {
    method: "POST",
    body: JSON.stringify({ model: "a" }),
  });
  const raw = await res.text();
  expect(() => JSON.parse(raw)).not.toThrow();
  expect(raw.startsWith(": warming")).toBe(false);
});

test("model_reported (the echoed body) and model_resident (read from /v1/models) differ on a stale echo", async () => {
  const e = engine();
  const a = model({ id: "a", filename: "a.gguf", role: "chat" });
  const lifecycle = new DockerLifecycle(fakeExec(), fakeProbe);
  // The chat response echoes a router id that is not the resident file --
  // exactly the staleness model_resident exists to catch independently.
  const { client } = fakeLlama((call) =>
    call.path === CHAT_PATH ? Response.json({ ok: true, model: "stale-id" }) : undefined,
  );
  const router = new LlamaRouter(e, [a], lifecycle, baseOpts(client));

  const body = (await (
    await router.proxy(a, CHAT_PATH, { method: "POST", body: JSON.stringify({ model: "a" }) })
  ).json()) as { model?: string };

  const modelReported = reportedModelFrom(body);
  const modelResident = await router.residentModelId("chat");
  expect(modelReported).toBe("stale-id");
  expect(modelResident).toBe("a");
  expect(modelReported).not.toBe(modelResident);
});

// Concurrent chat + vision decode needs a registered vision [[model]] against
// a real GGUF, which does not exist in this repo. Do not alias a chat model
// onto the vision role to make this runnable -- see TODO.md's acceptance
// criteria for this engine; the criterion is skipped, not faked.
