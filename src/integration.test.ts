/**
 * Cross-module acceptance: a real door (`createDoor`, called in-process — no
 * socket, so 29200 is never bound) over a real `EngineRegistry`, against
 * real `Bun.serve` fake upstreams standing in for engine containers. Each
 * fake upstream's own request log is what proves an engine was never
 * reached; a status code alone never is.
 */

import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { resetSpeechCache } from "./audio.ts";
import type { DoorOptions } from "./doorContext.ts";
import type { Exec, ExecResult } from "./exec.ts";
import { HTTP_CLIENT_ERROR_MIN } from "./http.ts";
import { createDoor, type Door } from "./main.ts";
import {
  buildExec,
  clearVerifiedVersion,
  collectLines,
  deadPort,
  engine,
  makeTestRoot,
  route,
  config as sharedConfig,
  tempPresetPath as sharedTempPresetPath,
  soleProvenanceRecord,
  startFakeUpstream,
  upstream,
} from "./test-support.ts";
import type { Config, EngineEntry } from "./types.ts";

// One door per process in production, so the synthesis cache is module-level.
// A suite builds many doors in one process, so without this an earlier test's
// rendition answers a later one and a call that must fail succeeds instead.
beforeEach(resetSpeechCache);

/** Never 29200 — a real daemon may be installed on this box. This is only ever compared against a header, never bound. */
const TEST_LISTEN_PORT = 39_217;

const TEST_ROOT = makeTestRoot("engined-integration-test-");

/**
 * The registry options every door here is built with. Neither value is ever
 * resolved: engines are named through `spec_dir`, and no agentic launch is
 * spawned, so an `enginesRoot` that cannot exist is what proves it. Not
 * `test-support.ts`'s `ENGINES_ROOT`/`BUNX` -- those name the repo's real
 * `engines/` and a plausible bunx path, which is a different exercise.
 */
const REGISTRY_OPTS = { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx" };

/** `config()` with a port that is never 29200 and timeouts short enough to fail fast. */
function baseConfig(overrides: Partial<Config> = {}): Config {
  return sharedConfig({
    listen_port: TEST_LISTEN_PORT,
    chat_timeout_seconds: 30,
    agent_timeout_seconds: 60,
    ...overrides,
  });
}

function req(
  method: string,
  pathname: string,
  opts: { origin?: string; host?: string; body?: unknown } = {},
): Request {
  const headers: Record<string, string> = {};
  if (opts.origin !== undefined) {
    headers.Origin = opts.origin;
  }
  if (opts.host !== undefined) {
    headers.Host = opts.host;
  }
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  return new Request(`http://127.0.0.1:${TEST_LISTEN_PORT}${pathname}`, init);
}

/** Writes a fresh `<dir>/spec.toml`; the returned path is a ready `spec_dir` override. */
function specDirFor(toml: string): string {
  const dir = mkdtempSync(join(TEST_ROOT, "engined-integration-"));
  writeFileSync(join(dir, "spec.toml"), toml);
  return dir;
}

function tempPresetPath(): string {
  return sharedTempPresetPath(TEST_ROOT);
}

const OPENAI_SPEC = `
kind = "openai-http"
upstream = "self"
image = "test-openai:local"
obtain = "pull"
serves = ["/openai/v1/chat/completions", "/openai/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`;

/** Mirrors engines/llama/spec.toml's own `streaming = true` -- llama has streamed all along, and this is what proves a row can finally say so. */
const OPENAI_SPEC_STREAMING = `
kind = "openai-http"
upstream = "self"
image = "test-openai:local"
obtain = "pull"
serves = ["/openai/v1/chat/completions", "/openai/v1/embeddings"]
command = []
streaming = true

[ready]
path = "/health"
status = 200
`;

const AGENTIC_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@1.0.0", "-p"]
`;

const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "test-comfy:local"
obtain = "pull"
serves = ["/engined/v1/comfy/:engine/:upstream/prompt"]
command = []

[ready]
path = "/queue"
status = 200
`;

function containerEngine(
  id: string,
  toml: string,
  overrides: Partial<EngineEntry> = {},
): EngineEntry {
  // models_dir: LlamaRouter.ensureStarted() calls buildLlamaSpec
  // unconditionally for any openai-http-kind engine (there is no remote,
  // non-router-mode openai-http variant wired anywhere yet), and
  // buildLlamaSpec throws without one. Harmless for the agentic/comfy specs
  // this helper also builds, since isLocalLlama gates engines.ts's own use
  // of it on kind === "openai-http" too.
  return {
    id,
    args: {},
    spec_dir: specDirFor(toml),
    models_dir: "/models-host",
    ...overrides,
  };
}

/** One route per engine kind, plus a chain, so the models list has every shape of row to prove. */
function modelsListConfig(): Config {
  return baseConfig({
    routes: [
      route({
        engine: "local",
        model: "ornith",
        upstream: "local",
        filename: "ornith.gguf",
        role: "chat",
      }),
      route({
        engine: "local",
        model: "embed",
        upstream: "local",
        filename: "embed.gguf",
        role: "embedding",
      }),
      route({
        engine: "local",
        model: "quiet",
        upstream: "local",
        filename: "quiet.gguf",
        role: "chat",
        streaming: false,
      }),
      // Same engine, same `serves` as the chat route above -- chat and vision
      // answer one door path. This row is why `role` exists on the menu at all.
      route({
        engine: "local",
        model: "see",
        upstream: "local",
        filename: "see.gguf",
        role: "vision",
      }),
      route({ engine: "claude", model: "sonnet-5", upstream: null }),
      route({ engine: "chatterbox-multi", model: undefined, upstream: "local" }),
      route({ engine: "comfy", model: undefined, upstream: "local" }),
    ],
    engines: [
      containerEngine("local", OPENAI_SPEC_STREAMING),
      containerEngine("claude", AGENTIC_SPEC),
      containerEngine("comfy", COMFY_SPEC),
      containerEngine("chatterbox-multi", ttsSpec()),
    ],
    chains: { "chain-x": ["@/local/ornith"] },
  });
}

/** A door whose every docker call fails: the models list probes engine state through docker, and this keeps the test off the real binary without changing which addresses list. */
function offlineDoor(config: Config): Door {
  const exec: Exec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  return createDoor(config, {
    ...REGISTRY_OPTS,
    exec,
  });
}

/** A chat call aimed at the embedding route, which a chat role must refuse. */
function chatToEmbeddingRoute(door: Door): Response | Promise<Response> {
  return door.fetch(
    new Request("http://engined/openai/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "@/local/embed",
        messages: [{ role: "user", content: "hi" }],
      }),
    }),
  );
}

test("a chain over audio engines lists the endpoint its hops serve, not chat", async () => {
  const door = offlineDoor(
    baseConfig({
      routes: [route({ engine: "chatterbox-multi", model: undefined, upstream: "local" })],
      engines: [containerEngine("chatterbox-multi", ttsSpec())],
      chains: { "chain-speech": ["@/chatterbox-multi/local"] },
    }),
  );
  try {
    const res = await door.fetch(req("GET", "/openai/v1/models"));
    const body = (await res.json()) as {
      data?: { id: string; serves?: string[]; hops?: string[] }[];
    };
    const chain = (body.data ?? []).find((r) => r.id === "chain-speech");

    // A hop onto a modelless engine names an upstream in its second segment.
    // Read as a model it resolves to nothing, and the menu would report the
    // whole chain as naming no route while the door dispatched it happily.
    expect(chain?.hops).toEqual(["@/chatterbox-multi/local"]);
    // Hardcoding chat here would tell a TTS consumer the one address built for
    // it is the one address it cannot use.
    expect(chain?.serves).toEqual(["/openai/v1/audio/speech"]);
  } finally {
    await door.registry.shutdown();
  }
});

test("GET /openai/v1/models is an OpenAI list envelope whose data[].id is every route's own address plus chain names -- comfy's modelless route lists like any other engine's", async () => {
  const door = offlineDoor(modelsListConfig());
  try {
    const res = await door.fetch(req("GET", "/openai/v1/models"));
    // `data` optional, because that is the shape a consumer must survive: the
    // `?? []` below is only a real fallback if the type admits its absence.
    const body = (await res.json()) as {
      object: string;
      data?: Array<{ id: string; streaming: boolean; serves: string[]; role?: string }>;
    };

    // Parsed the way a consumer parses it: a bare array leaves `data`
    // undefined, which reads as "this engine has no models" rather than as
    // an error. sagaforge-ts's probeModels is written exactly like this.
    const rows = body.data ?? [];
    const ids = rows.map((m) => m.id);
    expect(body.object).toBe("list");
    expect(ids).not.toHaveLength(0);

    expect(new Set(ids)).toEqual(
      new Set([
        "@/local/ornith",
        "@/local/embed",
        "@/local/quiet",
        "@/local/see",
        "@/claude/sonnet-5",
        "@/chatterbox-multi/local",
        "@/comfy/local",
        "chain-x",
      ]),
    );
    expect(ids).not.toContain("comfy");
    // llama has streamed on the wire all along with no way to declare it;
    // this is the first place a caller can ask and get a real answer.
    expect(rows.find((r) => r.id === "@/local/ornith")?.streaming).toBe(true);
    // The route's own declaration beats the engine's spec, per row.
    expect(rows.find((r) => r.id === "@/local/quiet")?.streaming).toBe(false);
    // `serves` is the route's own: an embedding role answers embeddings only,
    // and a chat role never answers embeddings, whatever the engine serves.
    expect(rows.find((r) => r.id === "@/local/embed")?.serves).toEqual(["/openai/v1/embeddings"]);
    expect(rows.find((r) => r.id === "@/local/ornith")?.serves).toEqual([
      "/openai/v1/chat/completions",
    ]);
    // `role` is the only field that tells a vision address from a chat one.
    // Both rows serve the same door path, so a consumer wiring up vision has
    // nothing else in the menu to pick on.
    const chatRow = rows.find((r) => r.id === "@/local/ornith");
    const visionRow = rows.find((r) => r.id === "@/local/see");
    expect(visionRow?.serves).toEqual(chatRow?.serves);
    expect(chatRow?.role).toBe("chat");
    expect(visionRow?.role).toBe("vision");
    // A route declaring no role, and a chain, which names no single route to
    // take one from, both report none rather than guessing at one.
    expect(rows.find((r) => r.id === "@/claude/sonnet-5")?.role).toBeUndefined();
    expect(rows.find((r) => r.id === "chain-x")?.role).toBeUndefined();
    const chatToEmbed = await chatToEmbeddingRoute(door);
    expect(chatToEmbed.status).toBe(400);
    expect(await chatToEmbed.text()).toContain("does not serve");
  } finally {
    await door.registry.shutdown();
  }
});

test("GET /engined/v1/engines carries top-level contract and commit", async () => {
  const config = baseConfig({ engines: [containerEngine("local", OPENAI_SPEC)] });
  const exec: Exec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  const door = createDoor(config, {
    ...REGISTRY_OPTS,
    exec,
  });

  try {
    const res = await door.fetch(req("GET", "/engined/v1/engines"));
    const body = (await res.json()) as { contract: unknown; commit: unknown };

    expect(typeof body.contract).toBe("number");
    expect(typeof body.commit).toBe("string");
  } finally {
    await door.registry.shutdown();
  }
});

test("GET /engined/v1/engines answers 200 even when every engine is unavailable", async () => {
  const config = baseConfig({ engines: [containerEngine("local", OPENAI_SPEC)] });
  // Every "image inspect" fails: no image ever resolves on this box.
  const exec: Exec = async (): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 1 });
  const door = createDoor(config, {
    ...REGISTRY_OPTS,
    exec,
  });

  try {
    const res = await door.fetch(req("GET", "/engined/v1/engines"));
    const body = (await res.json()) as { engines: Array<{ id: string; state: string }> };

    expect(res.status).toBe(200);
    expect(body.engines.find((e) => e.id === "local")?.state).toBe("unavailable");
  } finally {
    await door.registry.shutdown();
  }
});

test("the Origin guard applies to a GET: foreign Origin, Origin: null, and a non-loopback Host are refused; no Origin is served normally", async () => {
  const door = createDoor(baseConfig(), {
    ...REGISTRY_OPTS,
  });

  try {
    const foreign = await door.fetch(
      req("GET", "/openai/v1/models", { origin: "https://evil.example" }),
    );
    expect(foreign.status).toBe(403);

    const nullOrigin = await door.fetch(req("GET", "/openai/v1/models", { origin: "null" }));
    expect(nullOrigin.status).toBe(403);

    const badHost = await door.fetch(req("GET", "/openai/v1/models", { host: "evil.example" }));
    expect(badHost.status).toBe(403);

    const clean = await door.fetch(req("GET", "/openai/v1/models"));
    expect(clean.status).toBe(200);
  } finally {
    await door.registry.shutdown();
  }
});

// --- POST /openai/v1/chat/completions, actually proxied: chain failover,
// max_egress truncation, chain exhaustion, and the agentic workdir rule.

function openaiSpec(image = "test-openai:local"): string {
  return `
kind = "openai-http"
upstream = "self"
image = "${image}"
obtain = "pull"
serves = ["/openai/v1/chat/completions", "/openai/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`;
}

function ttsSpec(): string {
  return `
kind = "tts"
upstream = "self"
image = "test-tts:local"
obtain = "pull"
serves = ["/openai/v1/audio/speech"]
command = []

[ready]
path = "/health"
status = 200
`;
}

/** chatterbox-multi is modelless: its one route names an upstream, never a model, and its address is that route's engine+upstream form. */
const CHATTERBOX = "@/chatterbox-multi/local";
const CHATTERBOX_ROUTES = [
  route({ engine: "chatterbox-multi", model: undefined, upstream: "local" }),
];

/** llama-server's `/v1/models`: empty until a load, then the one resident GGUF. */
function loadedModelsResponse(lastLoadedModel: string | undefined): Response {
  return Response.json({
    data:
      lastLoadedModel === undefined ? [] : [{ id: lastLoadedModel, status: { value: "loaded" } }],
  });
}

/**
 * A fake llama upstream good enough for `LlamaRouter.loadAndWait`: it
 * triggers via `/models/load` (real b10354 contract, probed live: answers
 * `{success:true}`, never a "loaded" status) and confirms readiness via
 * `GET /openai/v1/models`'s per-model `status.value` -- any other shape here loops
 * `loadAndWait` forever. `content` is the chat body returned once resident;
 * `chatStatus` lets a hop stand up cleanly (load/unload/readiness all real)
 * while still answering the actual chat call with a failure, which is what
 * distinguishes "upstream never reachable" from "upstream reachable but bad"
 * for a regression that must exercise `classifyResult`'s real status check.
 * `chatBodies`, when given, collects the parsed JSON body of every actual
 * `/openai/v1/chat/completions`-style call -- the only way to prove what `model`
 * field engined forwarded upstream, as opposed to merely what it responded.
 */
function fakeLlamaUpstream(
  content: string,
  chatStatus = 200,
  chatBodies?: Record<string, unknown>[],
): (request: Request) => Response | Promise<Response> {
  let lastLoadedModel: string | undefined;
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (pathname === "/models/load") {
      lastLoadedModel = ((await request.json()) as { model?: string }).model;
      return Response.json({ success: true });
    }
    if (pathname === "/v1/models") {
      return loadedModelsResponse(lastLoadedModel);
    }
    if (pathname === "/models/unload") {
      return Response.json({ ok: true });
    }
    // Answer ONLY llama-server's own paths. A fallthrough here is what let the
    // door forward its own `/openai/v1/...` and still get a 200: the whole
    // local chat strip passed green while every real call would have 404'd.
    if (pathname !== "/v1/chat/completions" && pathname !== "/v1/embeddings") {
      return Response.json({ error: `fake llama: unexpected path ${pathname}` }, { status: 404 });
    }
    chatBodies?.push((await request.json()) as Record<string, unknown>);
    return chatStatus >= HTTP_CLIENT_ERROR_MIN
      ? Response.json({ error: content }, { status: chatStatus })
      : Response.json({ choices: [{ message: { content } }] });
  };
}

interface ChatDoorSetup {
  exec: Exec;
  stoppables?: { stop: () => void }[];
  doorOpts?: DoorOptions;
}

/** Every chat-completions test here stands up a door over the same fake-exec/preset wiring, runs one request, then tears the door and every fake upstream down; only the config, exec, upstream(s), doorOpts and assertion differ. */
async function withChatDoor(
  cfgOverrides: Partial<Config>,
  setup: ChatDoorSetup,
  fn: (door: Door) => Promise<void>,
): Promise<void> {
  const { exec, stoppables = [], doorOpts = {} } = setup;
  const door = createDoor(
    baseConfig(cfgOverrides),
    { ...REGISTRY_OPTS, exec },
    { llamaPresetHostPath: tempPresetPath(), ...doorOpts },
  );
  try {
    await fn(door);
  } finally {
    for (const stoppable of stoppables) {
      stoppable.stop();
    }
    await door.registry.shutdown();
  }
}

test("a chain whose first hop is dead completes on the second, and provenance names the second engine", async () => {
  const good = startFakeUpstream(fakeLlamaUpstream("answered by good"));
  const goodPort = String(good.port);
  const dead = deadPort();

  const exec = buildExec({
    portByContainer: { "engined-dead": dead, "engined-good": Number(goodPort) },
  });
  const { lines, write } = collectLines();
  await withChatDoor(
    {
      routes: [
        route({ engine: "dead", role: "chat", filename: "m.gguf" }),
        route({ engine: "good", role: "chat", filename: "m.gguf" }),
      ],
      engines: [
        // Short readiness timeout: nothing listens on `dead`, so the poll
        // must give up fast rather than spend the 60s default finding out.
        containerEngine("dead", openaiSpec(), { ready_timeout_s: 0.1 }),
        containerEngine("good", openaiSpec()),
      ],
      chains: { "chain-x": ["@/dead/m", "@/good/m"] },
    },
    { exec, stoppables: [good], doorOpts: { write } },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: { model: "chain-x", messages: [{ role: "user", content: "hi" }] },
        }),
      );
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain("answered by good");

      const record = soleProvenanceRecord(lines);
      expect(record.engine_used).toBe("good");
      expect(record.attempts).toHaveLength(2);
      expect(record.attempts[0]?.engine).toBe("dead");
      expect(record.attempts[0]?.ok).toBe(false);
    },
  );
});

test("a streaming chain whose first hop 5xxs on the actual chat call advances to the second hop, and provenance names the second engine", async () => {
  // Both hops stand up cleanly (load/unload/readiness all answer for real --
  // this is not a connection failure); only the first hop's actual chat call
  // fails. That isolates the streaming-proxy bug: `LlamaRouter.proxy` used to
  // hand back an unconditional 200 the instant a streaming request arrived,
  // before it had even contacted the upstream, so `classifyResult` never saw
  // this 500 and treated the dead hop as the terminal, successful answer.
  const dead = startFakeUpstream(fakeLlamaUpstream("boom", 500));
  const good = startFakeUpstream(fakeLlamaUpstream("answered by good"));
  const deadHostPort = String(dead.port);
  const goodPort = String(good.port);

  const exec = buildExec({
    portByContainer: { "engined-dead": Number(deadHostPort), "engined-good": Number(goodPort) },
  });
  const { lines, write } = collectLines();
  await withChatDoor(
    {
      routes: [
        route({ engine: "dead", role: "chat", filename: "m.gguf" }),
        route({ engine: "good", role: "chat", filename: "m.gguf" }),
      ],
      engines: [containerEngine("dead", openaiSpec()), containerEngine("good", openaiSpec())],
      chains: { "chain-x": ["@/dead/m", "@/good/m"] },
    },
    { exec, stoppables: [dead, good], doorOpts: { write } },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: { model: "chain-x", stream: true, messages: [{ role: "user", content: "hi" }] },
        }),
      );
      const body = await res.text();

      // Streaming stays streaming: the fix defers the 200 until upstream has
      // actually answered rather than buffering, so status must still be real.
      expect(res.status).toBe(200);
      expect(body).toContain("answered by good");

      expect(soleProvenanceRecord(lines).engine_used).toBe("good");
    },
  );
});

// --- The forwarded `model` field: a chain dispatch must rewrite it to the
// resolved per-hop model id before it reaches llama-server. Forwarding the
// caller's own `model` (the chain name) verbatim 400s upstream, since a
// chain name and a model id can never collide (checkNamespaceCollisions).

test("a chain dispatch to a llama hop rewrites the forwarded body's model to the resolved model id, not the chain name", async () => {
  const chatBodies: Record<string, unknown>[] = [];
  const good = startFakeUpstream(fakeLlamaUpstream("answered by good", 200, chatBodies));
  const goodPort = String(good.port);

  const exec = buildExec({ portByContainer: { "engined-good": Number(goodPort) } });
  await withChatDoor(
    {
      routes: [route({ engine: "good", model: "ornith", role: "chat", filename: "ornith.gguf" })],
      engines: [containerEngine("good", openaiSpec())],
      chains: { "chain-private": ["@/good/ornith"] },
    },
    { exec, stoppables: [good] },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: { model: "chain-private", messages: [{ role: "user", content: "hi" }] },
        }),
      );

      expect(res.status).toBe(200);
      expect(chatBodies).toHaveLength(1);
      expect(chatBodies[0]?.model).toBe("ornith");
    },
  );
});

test("a streaming chain dispatch to a llama hop also rewrites the forwarded body's model to the resolved model id", async () => {
  const chatBodies: Record<string, unknown>[] = [];
  const good = startFakeUpstream(fakeLlamaUpstream("answered by good", 200, chatBodies));
  const goodPort = String(good.port);

  const exec = buildExec({ portByContainer: { "engined-good": Number(goodPort) } });
  await withChatDoor(
    {
      routes: [route({ engine: "good", model: "ornith", role: "chat", filename: "ornith.gguf" })],
      engines: [containerEngine("good", openaiSpec())],
      chains: { "chain-private": ["@/good/ornith"] },
    },
    { exec, stoppables: [good] },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: {
            model: "chain-private",
            stream: true,
            messages: [{ role: "user", content: "hi" }],
          },
        }),
      );

      expect(res.status).toBe(200);
      expect(chatBodies).toHaveLength(1);
      expect(chatBodies[0]?.model).toBe("ornith");
    },
  );
});

test("a direct (non-chain) model request still forwards its own model id unchanged", async () => {
  const chatBodies: Record<string, unknown>[] = [];
  const good = startFakeUpstream(fakeLlamaUpstream("answered by good", 200, chatBodies));
  const goodPort = String(good.port);

  const exec = buildExec({ portByContainer: { "engined-good": Number(goodPort) } });
  await withChatDoor(
    {
      routes: [route({ engine: "good", model: "ornith", role: "chat", filename: "ornith.gguf" })],
      engines: [containerEngine("good", openaiSpec())],
    },
    { exec, stoppables: [good] },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: { model: "@/good/ornith", messages: [{ role: "user", content: "hi" }] },
        }),
      );

      expect(res.status).toBe(200);
      expect(chatBodies).toHaveLength(1);
      expect(chatBodies[0]?.model).toBe("ornith");
    },
  );
});

/**
 * A chain whose local hop cannot serve (its image never resolves) ahead of a
 * genuinely reachable, genuinely successful remote upstream -- unlike a
 * secretless or address-less fixture, whose own resolution failure would
 * 502 the hop regardless of whether the ceiling ever filtered it out. Only
 * a remote hop that WOULD answer 200 if reached makes an empty request log
 * a real proof of truncation, not a coincidence of a broken fixture --
 * exactly the class of bug that let this ceiling regress silently against
 * the deployed door: a fixture that could not tell "refused" from "never
 * attempted".
 */
function publicChainFixture(): {
  remote: ReturnType<typeof startFakeUpstream>;
  cfg: Partial<Config>;
  setup: ChatDoorSetup;
} {
  const remote = startFakeUpstream(() =>
    Response.json({
      model: "m",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
    }),
  );
  const remoteSecretExec: Exec = () =>
    Promise.resolve({ stdout: "remote-key\n", stderr: "", exitCode: 0 });
  const MISSING_LOCAL_IMAGE = "local-image-that-does-not-resolve:local";
  const exec = buildExec({ missingImages: new Set([MISSING_LOCAL_IMAGE]) });
  return {
    remote,
    cfg: {
      routes: [
        route({ engine: "local", role: "chat", filename: "m.gguf" }),
        route({ engine: "remote", role: "chat", upstream: "remote" }),
      ],
      engines: [
        containerEngine("local", openaiSpec(MISSING_LOCAL_IMAGE)),
        containerEngine("remote", openaiSpec()),
      ],
      upstreams: [
        upstream({ id: "local", egress: "none" }),
        upstream({
          id: "remote",
          egress: "remote",
          base_url: remote.base,
          secret: { service: "svc", username: "u", header: "x-api-key" },
        }),
      ],
      chains: { "chain-public": ["@/local/m", "@/remote/m"] },
    },
    setup: { exec, stoppables: [remote], doorOpts: { secretExec: remoteSecretExec } },
  };
}

test('max_egress: "none" against a public chain never reaches a remote hop, even when the local hop cannot serve', async () => {
  const { remote, cfg, setup } = publicChainFixture();
  await withChatDoor(cfg, setup, async (door) => {
    const res = await door.fetch(
      req("POST", "/openai/v1/chat/completions", {
        body: {
          model: "chain-public",
          max_egress: "none",
          messages: [{ role: "user", content: "hi" }],
        },
      }),
    );

    // Truncation removes the remote hop before it is ever attempted -- the
    // empty request log is what proves that, not the response shape. The
    // local hop was never started before this call either: the container
    // adopt/start-on-demand path, not a stopped container, is what put it in
    // this state, and the first request starts it (and fails) on its own.
    // A single unavailable hop is the degenerate one-attempt case of "every
    // engine in the chain failed" -- 503, never 200 and never left at 501.
    expect(res.status).toBe(503);
    expect(remote.requestLog).toEqual([]);
  });
});

test("an absent max_egress applies no ceiling: the same public chain DOES reach the remote hop, and answers 200", async () => {
  const { remote, cfg, setup } = publicChainFixture();
  await withChatDoor(cfg, setup, async (door) => {
    const res = await door.fetch(
      req("POST", "/openai/v1/chat/completions", {
        body: { model: "chain-public", messages: [{ role: "user", content: "hi" }] },
      }),
    );

    expect(res.status).toBe(200);
    expect(remote.requestLog).toEqual(["/chat/completions"]);
  });
});

test("every engine in a chain unavailable returns 503 listing each attempt", async () => {
  const exec = buildExec({ missingImages: new Set(["missing-e1:local", "missing-e2:local"]) });
  await withChatDoor(
    {
      routes: [
        route({ engine: "e1", role: "chat", filename: "m.gguf" }),
        route({ engine: "e2", role: "chat", filename: "m.gguf" }),
      ],
      engines: [
        containerEngine("e1", openaiSpec("missing-e1:local")),
        containerEngine("e2", openaiSpec("missing-e2:local")),
      ],
      chains: { "chain-z": ["@/e1/m", "@/e2/m"] },
    },
    { exec },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: { model: "chain-z", messages: [{ role: "user", content: "hi" }] },
        }),
      );
      const body = (await res.json()) as { attempts: unknown[] };

      expect(res.status).toBe(503);
      expect(body.attempts).toHaveLength(2);
    },
  );
});

test("an agentic attempt with no workdir returns 400", async () => {
  const config = baseConfig({
    routes: [route({ engine: "claude", model: "assistant", upstream: null })],
    // agent_version drives buildArgv directly (not the loaded spec's own
    // command array, which agentic.ts never reads) -- required for
    // execAgentic to reach the workdir check at all.
    engines: [containerEngine("claude", AGENTIC_SPEC, { agent_version: "1.0.0" })],
  });
  const door = createDoor(config, { ...REGISTRY_OPTS });

  try {
    const res = await door.fetch(
      req("POST", "/openai/v1/chat/completions", {
        body: { model: "@/claude/assistant", messages: [{ role: "user", content: "hi" }] },
      }),
    );

    expect(res.status).toBe(400);
  } finally {
    await door.registry.shutdown();
  }
});

test("a completed audio request arms idle-stop the same as a chat lease: the container stops on its own", async () => {
  const fake = startFakeUpstream((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (pathname === "/v1/tts") {
      const audio = Buffer.from("RIFF____WAVEfmt ", "utf8").toString("base64");
      return new Response(`${JSON.stringify({ phase: "done", audio, alignment: null })}\n`);
    }
    return new Response("", { status: 404 });
  });
  const { port } = fake;
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": port } });
  const IDLE_STOP_SECONDS = 0.03;
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [
      containerEngine("chatterbox-multi", ttsSpec(), { idle_stop_seconds: IDLE_STOP_SECONDS }),
    ],
  });
  const door = createDoor(config, {
    ...REGISTRY_OPTS,
    exec,
  });

  try {
    const speech = await door.fetch(
      req("POST", "/openai/v1/audio/speech", { body: { model: CHATTERBOX, input: "hi" } }),
    );
    expect(speech.status).toBe(200);

    // Nothing calls endLease for the audio door the way LlamaRouter's
    // withLease does for chat -- prove the request itself arms the timer,
    // not just that the container started.
    await Bun.sleep(60);

    const engines = await door.fetch(req("GET", "/engined/v1/engines"));
    const body = (await engines.json()) as { engines: Array<{ id: string; state: string }> };
    expect(body.engines.find((e) => e.id === "chatterbox-multi")?.state).toBe("installed");
  } finally {
    fake.stop();
    await door.registry.shutdown();
  }
});

test("a streamed audio call holds its lease until the body ends, not until the handler returns", async () => {
  let release: (() => void) | undefined;
  const fake = startFakeUpstream((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (pathname === "/v1/tts") {
      // Stays open until the test lets go, standing in for an engine still
      // producing into a body the caller has not finished reading.
      const audio = Buffer.from("RIFF____WAVEfmt ", "utf8").toString("base64");
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            // A first frame so headers and the relay are live, the way a real
            // engine reports progress before it has finished synthesizing.
            controller.enqueue(
              new TextEncoder().encode(`${JSON.stringify({ phase: "progress", step: 1 })}\n`),
            );
            release = () => {
              controller.enqueue(
                new TextEncoder().encode(
                  `${JSON.stringify({ phase: "done", audio, alignment: null })}\n`,
                ),
              );
              controller.close();
            };
          },
        }),
      );
    }
    return new Response("", { status: 404 });
  });
  const { port } = fake;
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": port } });
  const IDLE_STOP_SECONDS = 0.03;
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [
      containerEngine("chatterbox-multi", ttsSpec(), { idle_stop_seconds: IDLE_STOP_SECONDS }),
    ],
  });
  const door = createDoor(config, {
    ...REGISTRY_OPTS,
    exec,
  });

  try {
    const speech = await door.fetch(
      req("POST", "/openai/v1/audio/speech", {
        body: { model: CHATTERBOX, input: "hi", stream: "ndjson" },
      }),
    );
    expect(speech.status).toBe(200);

    // The handler has returned, but the engine is still producing. Arming the
    // countdown here would aim it at a request in flight.
    await Bun.sleep(60);
    const during = await door.fetch(req("GET", "/engined/v1/engines"));
    const held = (await during.json()) as { engines: Array<{ id: string; state: string }> };
    expect(held.engines.find((e) => e.id === "chatterbox-multi")?.state).toBe("running");

    release?.();
    await speech.text();
    await Bun.sleep(60);
    const after = await door.fetch(req("GET", "/engined/v1/engines"));
    const ended = (await after.json()) as { engines: Array<{ id: string; state: string }> };
    expect(ended.engines.find((e) => e.id === "chatterbox-multi")?.state).toBe("installed");
  } finally {
    fake.stop();
    await door.registry.shutdown();
  }
});

test("a failed audio call records why it failed, not merely that it did", async () => {
  const fake = startFakeUpstream((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    // The engine is up and answers, and the synthesis itself fails. Provenance
    // has to carry the reason: "ok: false" with no failure is unreadable later.
    return new Response("", { status: 503 });
  });
  const { port } = fake;
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": port } });
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [containerEngine("chatterbox-multi", ttsSpec())],
  });
  const { lines, write } = collectLines();
  const door = createDoor(config, { ...REGISTRY_OPTS, exec }, { write });

  try {
    await door.fetch(
      req("POST", "/openai/v1/audio/speech", { body: { model: CHATTERBOX, input: "hi" } }),
    );
    const record = soleProvenanceRecord(lines);
    expect(record.attempts[0]?.ok).toBe(false);
    expect(record.attempts[0]?.failure).toBeDefined();
    expect(record.engine_used).toBeNull();
  } finally {
    fake.stop();
    await door.registry.shutdown();
  }
});

/**
 * Two 4-byte PCM chunks over the engine's own NDJSON, which is what a streamed
 * `/openai/v1/audio/speech` forwards: the door buffers none of it, so provenance can
 * only learn the size from the stream itself.
 */
function fakeStreamingTts(): (request: Request) => Response {
  const pcm = Buffer.from(Uint8Array.from([1, 2, 3, 4])).toString("base64");
  return (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (pathname === "/v1/tts") {
      return new Response(
        `${JSON.stringify({ phase: "chunk", pcm, rate: 22_050 })}\n${JSON.stringify({ phase: "chunk", pcm, rate: 22_050 })}\n`,
      );
    }
    return new Response("", { status: 404 });
  };
}

interface StreamingSpeechDoor {
  door: ReturnType<typeof createDoor>;
  lines: string[];
  stop: () => void;
}

function streamingSpeechDoor(): StreamingSpeechDoor {
  const fake = startFakeUpstream(fakeStreamingTts());
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": fake.port } });
  const { lines, write } = collectLines();
  const door = createDoor(
    baseConfig({
      routes: CHATTERBOX_ROUTES,
      engines: [containerEngine("chatterbox-multi", ttsSpec())],
    }),
    { ...REGISTRY_OPTS, exec },
    { write },
  );
  return {
    door,
    lines,
    stop: () => {
      fake.stop();
    },
  };
}

const STREAM_SPEECH = { model: CHATTERBOX, input: "hi", stream: true };

test("a streamed audio call that forwards its whole body records a success, not an empty body", async () => {
  const { door, lines, stop } = streamingSpeechDoor();
  try {
    const res = await door.fetch(req("POST", "/openai/v1/audio/speech", { body: STREAM_SPEECH }));
    expect(res.status).toBe(200);
    // Nothing is recorded until the caller has the bytes: the line is the
    // stream's outcome, not the response header's.
    expect(lines).toHaveLength(0);
    expect((await res.arrayBuffer()).byteLength).toBe(8);

    const record = soleProvenanceRecord(lines);
    expect(record.attempts[0]?.ok).toBe(true);
    expect(record.attempts[0]?.failure).toBeUndefined();
    expect(record.engine_used).toBe("chatterbox-multi");
  } finally {
    stop();
    await door.registry.shutdown();
  }
});

test("a streamed audio call abandoned mid-body still records a failure", async () => {
  const { door, lines, stop } = streamingSpeechDoor();
  try {
    const res = await door.fetch(req("POST", "/openai/v1/audio/speech", { body: STREAM_SPEECH }));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    // Bytes did reach the caller, so this is not the empty-body case -- only
    // the abandonment separates it from the success above.
    expect((await reader.read()).value?.byteLength).toBe(4);
    await reader.cancel();

    const record = soleProvenanceRecord(lines);
    expect(record.attempts[0]?.ok).toBe(false);
    expect(record.attempts[0]?.failure).toBe("client disconnected");
    expect(record.engine_used).toBeNull();
  } finally {
    stop();
    await door.registry.shutdown();
  }
});

test("an oversized transcription upload is refused before it is read", async () => {
  const door = createDoor(baseConfig({}), {
    ...REGISTRY_OPTS,
    exec: buildExec({}),
  });

  try {
    // Declared, not sent: the point is that the size is refused on the header
    // rather than after the body has been read into memory.
    const res = await door.fetch(
      new Request("http://engined/openai/v1/audio/transcriptions", {
        method: "POST",
        headers: { "content-length": String(512 * 1024 * 1024) },
        body: "x",
      }),
    );
    expect(res.status).toBe(413);
  } finally {
    await door.registry.shutdown();
  }
});

test('a speech request survives the door boundary with stream: "ndjson", not coerced to a bool', async () => {
  // handleAudioSpeech builds SpeechRequestBody by hand, so a widened type on
  // the far side proves nothing: the boundary is where "ndjson" was dropped,
  // and dropping it silently returns a WAV to a caller expecting frames.
  const fake = startFakeUpstream((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (pathname === "/v1/tts") {
      return new Response(
        [
          JSON.stringify({ phase: "synthesizing", step: 3, step_limit: 9 }),
          JSON.stringify({
            phase: "chunk",
            pcm: Buffer.from([7, 7]).toString("base64"),
            rate: 24_000,
          }),
        ].join("\n"),
      );
    }
    return new Response("", { status: 404 });
  });
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": fake.port } });
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [containerEngine("chatterbox-multi", ttsSpec())],
  });
  const door = createDoor(config, {
    ...REGISTRY_OPTS,
    exec,
  });

  const res = await door.fetch(
    req("POST", "/openai/v1/audio/speech", {
      body: { model: CHATTERBOX, input: "hi", stream: "ndjson" },
    }),
  );

  expect(res.headers.get("content-type")).toContain("application/x-ndjson");
  const lines = (await res.text()).split("\n").filter((l) => l.length > 0);
  expect(JSON.parse(lines[0] ?? "{}")).toEqual({ phase: "synthesizing", step: 3, step_limit: 9 });
});

test("speech forwards OpenAI's own fields under the engine's names, and carries unknown ones through", async () => {
  // The OpenAI SDKs ship extra_body so a compatible server can be handed
  // parameters the standard shape has no room for. chatterbox-multi has several --
  // a reference-voice path, a language -- and a closed set here would cost a
  // door edit per engine capability.
  let sent: Record<string, unknown> = {};
  const fake = startFakeUpstream(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (pathname === "/v1/tts") {
      sent = (await request.json()) as Record<string, unknown>;
      const audio = Buffer.from("RIFF____WAVEfmt ", "utf8").toString("base64");
      return new Response(`${JSON.stringify({ phase: "done", audio })}\n`);
    }
    return new Response("", { status: 404 });
  });
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": fake.port } });
  const door = createDoor(
    baseConfig({
      routes: CHATTERBOX_ROUTES,
      engines: [containerEngine("chatterbox-multi", ttsSpec())],
    }),
    {
      ...REGISTRY_OPTS,
      exec,
    },
  );

  const res = await door.fetch(
    req("POST", "/openai/v1/audio/speech", {
      body: {
        model: CHATTERBOX,
        input: "hi",
        voice: "af_heart",
        speed: 1.25,
        instructions: "Speak with controlled rage.",
        language: "en",
        reference_voice_path: "/voices/a.wav",
      },
    }),
  );
  expect(res.status).toBe(200);

  // OpenAI's names map to the engine's: `instructions` is what chatterbox-multi calls `prompt`.
  expect(sent.voice).toBe("af_heart");
  expect(sent.speed).toBe(1.25);
  expect(sent.prompt).toBe("Speak with controlled rage.");
  // Unknown fields ride through untouched.
  expect(sent.language).toBe("en");
  expect(sent.reference_voice_path).toBe("/voices/a.wav");
  // Door-only fields are never passed on as engine parameters.
  expect(sent).not.toHaveProperty("model");
  expect(sent).not.toHaveProperty("input");
  expect(sent).not.toHaveProperty("stream");
  expect(sent).not.toHaveProperty("instructions");
});

/** whisper's shape, reduced to what the door reads: an STT engine that streams. */
function sttSpec(): string {
  return `
kind = "stt"
upstream = "self"
image = "test-stt:local"
obtain = "pull"
serves = ["/openai/v1/audio/transcriptions"]
streaming = true
command = []

[ready]
path = "/health"
status = 200
`;
}

const STT = "@/whisper/local";
const STT_ROUTES = [route({ engine: "whisper", model: undefined, upstream: "local" })];

test("a live transcription reaches the engine while the caller is still uploading", async () => {
  // The claim is about ordering, not about frames: a door that reads the body
  // to the end before dispatching cannot deliver a caption while the speaker
  // is still talking, however well it streams the reply. So the engine's first
  // read is timed against the caller's second write, and the caller does not
  // make that write until the engine has the first one.
  const engineRead = Promise.withResolvers<void>();
  let engineReadAt = Number.POSITIVE_INFINITY;
  let secondWriteAt = Number.NEGATIVE_INFINITY;
  let query = "";

  const fake = startFakeUpstream(async (request) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response("", { status: 200 });
    }
    if (url.pathname !== "/v1/audio/transcriptions/stream" || request.body === null) {
      return new Response("", { status: 404 });
    }
    query = url.search;
    const reader = request.body.getReader();
    await reader.read();
    engineReadAt = performance.now();
    engineRead.resolve();
    while (!(await reader.read()).done) {
      // Drain: the caller's remaining audio.
    }
    return new Response(
      `${JSON.stringify({ phase: "segment", text: "half a", start: 0, end: 1 })}\n${JSON.stringify({ phase: "done", text: "half a sentence" })}\n`,
      { headers: { "content-type": "application/x-ndjson" } },
    );
  });

  const door = createDoor(
    baseConfig({ routes: STT_ROUTES, engines: [containerEngine("whisper", sttSpec())] }),
    {
      ...REGISTRY_OPTS,
      exec: buildExec({ portByContainer: { "engined-whisper": fake.port } }),
    },
  );

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
      // A door that buffers never lets this resolve, so the wait is bounded
      // and the assertion below reads the ordering rather than hanging on it.
      await Promise.race([engineRead.promise, Bun.sleep(2000)]);
      secondWriteAt = performance.now();
      controller.enqueue(new Uint8Array([5, 6, 7, 8]));
      controller.close();
    },
  });

  try {
    const res = await door.fetch(
      new Request(
        `http://engined/openai/v1/audio/transcriptions?stream=true&model=${encodeURIComponent(STT)}&language=en`,
        { method: "POST", headers: { "content-type": "audio/wav" }, body },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    const lines = (await res.text()).split("\n").filter((line) => line.length > 0);
    expect(JSON.parse(lines[1] ?? "{}")).toEqual({ phase: "done", text: "half a sentence" });
    // The per-request fields ride in the query string, since a multipart part
    // is only readable once the boundary after it has arrived.
    expect(query).toContain("language=en");
    expect(engineReadAt).toBeLessThan(secondWriteAt);
  } finally {
    fake.stop();
    await door.registry.shutdown();
  }
});

test("a transcription request with no multipart body is a JSON 400, not Bun's HTML 500", async () => {
  // req.formData() throws on an empty POST. Uncaught, that surfaced as Bun's
  // own HTML error page -- the one door response a JSON client cannot read.
  // No engines needed: both guards fire before the engine is ever resolved.
  const door = createDoor(baseConfig(), {
    ...REGISTRY_OPTS,
  });

  const empty = await door.fetch(
    new Request("http://engined/openai/v1/audio/transcriptions", { method: "POST" }),
  );
  expect(empty.status).toBe(400);
  expect(empty.headers.get("content-type")).toContain("application/json");
  expect(((await empty.json()) as { error: string }).error).toContain("multipart");

  // A well-formed form with no file is the same class: refuse it rather than
  // hand whisper zero bytes and return an empty transcript that reads as silence.
  const noFile = new FormData();
  noFile.append("model", "whisper");
  const missing = await door.fetch(
    new Request("http://engined/openai/v1/audio/transcriptions", {
      method: "POST",
      body: noFile,
    }),
  );
  expect(missing.status).toBe(400);
  expect(((await missing.json()) as { error: string }).error).toContain("`file`");
});

/**
 * `base_url` is optional and `secret` does not imply it, so an upstream
 * carrying only a secret loads and every route naming it is dispatchable on
 * paper. Both remote-addressed kinds resolve that address before they can
 * answer -- the agentic redirect and the remote HTTP proxy alike -- so a row
 * that says `installed` here is advertising an address whose very first POST
 * 502s. The secret here resolves; the missing address is the only reason
 * either row can be anything but `installed`.
 */
test("a route whose upstream has a secret and no base_url lists unavailable, agentic and remote-http alike", async () => {
  const agenticId = "models-menu-addressless-agentic";
  clearVerifiedVersion(agenticId);
  const config = baseConfig({
    routes: [
      route({ engine: agenticId, model: "k3", upstream: "addressless" }),
      route({ engine: "addressless-proxy", model: "m", upstream: "addressless-openai" }),
    ],
    engines: [
      containerEngine(agenticId, AGENTIC_SPEC, { agent_version: "1.0.0" }),
      engine({ id: "addressless-proxy", kind: "openai-http" }),
    ],
    upstreams: [
      upstream({ id: "local", egress: "none" }),
      upstream({
        id: "addressless",
        egress: "remote",
        secret: { service: "svc", username: "u", header: "x-api-key" },
        wire: "anthropic",
      }),
      upstream({
        id: "addressless-openai",
        egress: "remote",
        secret: { service: "svc", username: "u", header: "authorization" },
        wire: "openai",
      }),
    ],
  });
  const door = createDoor(
    config,
    {
      ...REGISTRY_OPTS,
      exec: async () => ({ stdout: "", stderr: "", exitCode: 1 }),
      agenticProbeRunner: () => Promise.resolve({ ok: true }),
    },
    { secretExec: () => Promise.resolve({ stdout: "key\n", stderr: "", exitCode: 0 }) },
  );
  try {
    const res = await door.fetch(req("GET", "/openai/v1/models"));
    const rows = ((await res.json()) as { data?: Array<{ id: string; state: string }> }).data ?? [];
    const stateOf = (id: string): string | undefined => rows.find((r) => r.id === id)?.state;

    expect(stateOf(`@/${agenticId}/k3`)).toBe("unavailable");
    expect(stateOf("@/addressless-proxy/m")).toBe("unavailable");
  } finally {
    clearVerifiedVersion(agenticId);
  }
});

/**
 * `runChain` advances past a hop that cannot answer rather than failing the
 * whole chain, so one unreachable hop does not make the chain unusable and
 * `state: "installed"` on a chain is an honest answer to "can I send this a
 * request". It is not an answer to "is every hop healthy", and nothing else
 * on the row was ever asked that -- `unavailable_hops` is. The dead hop here
 * sits on an engine whose own image resolves: the engine is installed and the
 * hop still cannot answer, which is the only way to tell a per-hop answer
 * from an engine-wide one.
 */
// hop-dead sits on a container engine whose image resolves, so its engine
// state is `installed` and only the per-hop upstream resolution can make it
// dead -- otherwise the assertions could pass off an engine-wide answer as a
// per-hop one.
const chainHopConfig = () =>
  baseConfig({
    routes: [
      route({ engine: "hop-a", model: "m", upstream: "local", filename: "a.gguf", role: "chat" }),
      route({ engine: "hop-b", model: "m", upstream: "local", filename: "b.gguf", role: "chat" }),
      route({ engine: "hop-dead", model: "m", upstream: "addressless" }),
      route({ engine: "hop-dead", model: "m2", upstream: "addressless" }),
    ],
    engines: [
      containerEngine("hop-a", OPENAI_SPEC),
      containerEngine("hop-b", OPENAI_SPEC),
      containerEngine("hop-dead", OPENAI_SPEC),
    ],
    upstreams: [
      upstream({ id: "local", egress: "none" }),
      upstream({
        id: "addressless",
        egress: "remote",
        secret: { service: "svc", username: "u", header: "authorization" },
      }),
    ],
    chains: {
      "chain-healthy": ["@/hop-a/local/m", "@/hop-b/local/m"],
      "chain-limping": ["@/hop-dead/addressless/m", "@/hop-b/local/m"],
      "chain-dead": ["@/hop-dead/addressless/m", "@/hop-dead/addressless/m2"],
    },
  });

test("a chain reports the first hop that can answer as its state and names every hop that cannot", async () => {
  const config = chainHopConfig();
  const door = createDoor(
    config,
    { ...REGISTRY_OPTS, exec: buildExec({}) },
    { secretExec: () => Promise.resolve({ stdout: "key\n", stderr: "", exitCode: 0 }) },
  );

  try {
    const res = await door.fetch(req("GET", "/openai/v1/models"));
    const body = (await res.json()) as {
      data?: Array<{ id: string; state: string; hops?: string[]; unavailable_hops?: string[] }>;
    };
    const rows = body.data ?? [];
    const row = (id: string) => rows.find((r) => r.id === id);

    // Every hop reachable: nothing to report, and the field stays off the wire.
    expect(row("chain-healthy")?.state).toBe("installed");
    expect(row("chain-healthy")?.unavailable_hops).toBeUndefined();

    // ...which is exactly why `hops` is unconditional: with the destination
    // fields all absent from a chain row, a healthy chain would otherwise say
    // nothing about where it goes. Every hop, in order, dead ones included.
    expect(row("chain-healthy")?.hops).toEqual(["@/hop-a/local/m", "@/hop-b/local/m"]);
    expect(row("chain-dead")?.hops).toEqual([
      "@/hop-dead/addressless/m",
      "@/hop-dead/addressless/m2",
    ]);

    // Present on chains, absent on routes -- that difference is what tells a
    // caller the two kinds of address apart.
    expect(row("@/hop-a/m")?.hops).toBeUndefined();

    // A dead first hop and a live second: still dispatchable, and now says
    // what it lost on the way.
    expect(row("chain-limping")?.state).toBe("installed");
    expect(row("chain-limping")?.unavailable_hops).toEqual(["@/hop-dead/addressless/m"]);

    // No hop can answer: `unavailable`, with every hop accounted for -- never
    // `installed` off an engine that is installed but unaddressable.
    expect(row("chain-dead")?.state).toBe("unavailable");
    expect(row("chain-dead")?.unavailable_hops).toEqual([
      "@/hop-dead/addressless/m",
      "@/hop-dead/addressless/m2",
    ]);
  } finally {
    await door.registry.shutdown();
  }
});

/** The shape `handleVoiceUpload` issues: the door's own name for the file, never the caller's. */
const VOICE_HANDLE = /^vc_[0-9a-f]{32}\.wav$/;

/** Points the voice store at a scratch directory for one test, returning the undo -- the real one holds the operator's own uploads. */
function redirectStateHome(): () => void {
  const prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = mkdtempSync(join(TEST_ROOT, "engined-voices-"));
  return () => {
    if (prior === undefined) {
      delete process.env.XDG_STATE_HOME;
    } else {
      process.env.XDG_STATE_HOME = prior;
    }
  };
}

/**
 * The upload verb, end to end. A voice clone only works if the engine can
 * read the reference, so what matters is the string the engine is finally
 * handed: the door's own mount path for a handle it issued, and a refusal
 * for one it did not -- never the caller's own string either way.
 */
test("an uploaded reference voice reaches the engine as the door's own path, and a handle the door never issued is refused", async () => {
  const seen: Array<Record<string, unknown>> = [];
  const fake = startFakeUpstream(async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    seen.push((await request.json()) as Record<string, unknown>);
    const audio = Buffer.from("RIFF____WAVEfmt ", "utf8").toString("base64");
    return new Response(`${JSON.stringify({ phase: "done", audio, alignment: null })}\n`);
  });
  const exec = buildExec({ portByContainer: { "engined-chatterbox-multi": fake.port } });
  const door = createDoor(
    baseConfig({
      routes: CHATTERBOX_ROUTES,
      engines: [containerEngine("chatterbox-multi", ttsSpec())],
    }),
    { ...REGISTRY_OPTS, exec },
  );
  const restoreStateHome = redirectStateHome();

  try {
    const form = new FormData();
    form.set("file", new File([Buffer.from("RIFF0000WAVEfmt ")], "reference.wav"));
    const upload = await door.fetch(
      new Request(`http://127.0.0.1:${TEST_LISTEN_PORT}/engined/v1/audio/voices`, {
        method: "POST",
        body: form,
      }),
    );
    expect(upload.status).toBe(200);
    const { voice } = (await upload.json()) as { voice: string };
    expect(voice).toMatch(VOICE_HANDLE);

    const spoken = await door.fetch(
      req("POST", "/openai/v1/audio/speech", { body: { model: CHATTERBOX, input: "hi", voice } }),
    );
    expect(spoken.status).toBe(200);
    expect(seen[0]?.voice).toBe(`/voices/${voice}`);

    // A well-formed handle for a file this door does not hold, and a
    // malformed one: neither may reach the engine as a path.
    for (const bogus of [`vc_${"0".repeat(32)}.wav`, "vc_../../etc/passwd"]) {
      const refused = await door.fetch(
        req("POST", "/openai/v1/audio/speech", {
          body: { model: CHATTERBOX, input: "hi", voice: bogus },
        }),
      );
      expect(refused.status).toBe(400);
    }
    expect(seen).toHaveLength(1);
  } finally {
    restoreStateHome();
    fake.stop();
    await door.registry.shutdown();
  }
});
