/**
 * Cross-module acceptance: a real door (`createDoor`, called in-process — no
 * socket, so 29200 is never bound) over a real `EngineRegistry`, against
 * real `Bun.serve` fake upstreams standing in for engine containers. Each
 * fake upstream's own request log is what proves an engine was never
 * reached; a status code alone never is.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Exec, ExecResult } from "./exec.ts";
import { createDoor, type Door, type DoorOptions } from "./main.ts";
import {
  buildExec,
  deadPort,
  makeTestRoot,
  route,
  config as sharedConfig,
  tempPresetPath as sharedTempPresetPath,
  startFakeUpstream,
  upstream,
} from "./test-support.ts";
import type { Config, EngineEntry } from "./types.ts";

/** Never 29200 — a real daemon may be installed on this box. This is only ever compared against a header, never bound. */
const TEST_LISTEN_PORT = 39_217;

const TEST_ROOT = makeTestRoot("engined-integration-test-");

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

/** Mirrors engines/local-llama/spec.toml's own `streaming = true` -- llama has streamed all along, and this is what proves a row can finally say so. */
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
serves = []
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

test("GET /openai/v1/models is an OpenAI list envelope whose data[].id is every route's own address plus chain names -- comfy stays out, every modelless audio engine stays in", async () => {
  const config = baseConfig({
    routes: [
      route({
        engine: "local",
        model: "ornith",
        upstream: "local",
        filename: "ornith.gguf",
        role: "chat",
      }),
      route({ engine: "claude", model: "sonnet-5", upstream: null }),
      route({ engine: "chatterbox", model: undefined, upstream: "local" }),
    ],
    engines: [
      containerEngine("local", OPENAI_SPEC_STREAMING),
      containerEngine("claude", AGENTIC_SPEC),
      containerEngine("comfy", COMFY_SPEC),
      containerEngine("chatterbox", ttsSpec()),
    ],
    chains: { "chain-x": ["@/local/ornith"] },
  });
  // GET /openai/v1/models is async and authoritative now, so it probes every
  // engine's state through docker -- every image inspect failing keeps this
  // test off the real docker binary without changing which addresses list.
  const exec: Exec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  const door = createDoor(config, {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
    exec,
  });

  try {
    const res = await door.fetch(req("GET", "/openai/v1/models"));
    // `data` optional, because that is the shape a consumer must survive: the
    // `?? []` below is only a real fallback if the type admits its absence.
    const body = (await res.json()) as {
      object: string;
      data?: Array<{ id: string; streaming: boolean }>;
    };

    // Parsed the way a consumer parses it: a bare array leaves `data`
    // undefined, which reads as "this engine has no models" rather than as
    // an error. sagaforge-ts's probeModels is written exactly like this.
    const rows = body.data ?? [];
    const ids = rows.map((m) => m.id);
    expect(body.object).toBe("list");
    expect(ids).not.toHaveLength(0);

    expect(new Set(ids)).toEqual(
      new Set(["@/local/ornith", "@/claude/sonnet-5", "@/chatterbox/local", "chain-x"]),
    );
    expect(ids).not.toContain("comfy");
    expect(ids).not.toContain("@/comfy/local");
    // llama has streamed on the wire all along with no way to declare it;
    // this is the first place a caller can ask and get a real answer.
    expect(rows.find((r) => r.id === "@/local/ornith")?.streaming).toBe(true);
  } finally {
    await door.registry.shutdown();
  }
});

test("GET /engined/v1/engines carries top-level contract and commit", async () => {
  const config = baseConfig({ engines: [containerEngine("local", OPENAI_SPEC)] });
  const exec: Exec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  const door = createDoor(config, {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
// local_only truncation, chain exhaustion, and the agentic workdir rule.

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

/** chatterbox is modelless: its one route names an upstream, never a model, and its address is that route's engine+upstream form. */
const CHATTERBOX = "@/chatterbox/local";
const CHATTERBOX_ROUTES = [route({ engine: "chatterbox", model: undefined, upstream: "local" })];

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
      return Response.json({
        data:
          lastLoadedModel === undefined
            ? []
            : [{ id: lastLoadedModel, status: { value: "loaded" } }],
      });
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
    return chatStatus >= 400
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
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx", exec },
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
  const lines: string[] = [];
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
    { exec, stoppables: [good], doorOpts: { write: (line) => lines.push(line) } },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: { model: "chain-x", messages: [{ role: "user", content: "hi" }] },
        }),
      );
      const body = await res.text();

      expect(res.status).toBe(200);
      expect(body).toContain("answered by good");

      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0] ?? "{}") as {
        engine_used: string;
        attempts: { engine: string; ok: boolean }[];
      };
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
  const lines: string[] = [];
  await withChatDoor(
    {
      routes: [
        route({ engine: "dead", role: "chat", filename: "m.gguf" }),
        route({ engine: "good", role: "chat", filename: "m.gguf" }),
      ],
      engines: [containerEngine("dead", openaiSpec()), containerEngine("good", openaiSpec())],
      chains: { "chain-x": ["@/dead/m", "@/good/m"] },
    },
    { exec, stoppables: [dead, good], doorOpts: { write: (line) => lines.push(line) } },
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

      expect(lines).toHaveLength(1);
      const record = JSON.parse(lines[0] ?? "{}") as { engine_used: string };
      expect(record.engine_used).toBe("good");
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

test("local_only: true against a public chain never reaches a remote hop, even when the local hop cannot serve", async () => {
  const remote = startFakeUpstream(() => Response.json({ ok: true }));
  const MISSING_LOCAL_IMAGE = "local-image-that-does-not-resolve:local";

  const exec = buildExec({ missingImages: new Set([MISSING_LOCAL_IMAGE]) });
  await withChatDoor(
    {
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
        upstream({ id: "remote", egress: "remote" }),
      ],
      chains: { "chain-public": ["@/local/m", "@/remote/m"] },
    },
    { exec, stoppables: [remote] },
    async (door) => {
      const res = await door.fetch(
        req("POST", "/openai/v1/chat/completions", {
          body: {
            model: "chain-public",
            local_only: true,
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
    },
  );
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
  const door = createDoor(config, { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx" });

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
  const exec = buildExec({ portByContainer: { "engined-chatterbox": port } });
  const IDLE_STOP_SECONDS = 0.03;
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [containerEngine("chatterbox", ttsSpec(), { idle_stop_seconds: IDLE_STOP_SECONDS })],
  });
  const door = createDoor(config, {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
    await new Promise((resolve) => setTimeout(resolve, 60));

    const engines = await door.fetch(req("GET", "/engined/v1/engines"));
    const body = (await engines.json()) as { engines: Array<{ id: string; state: string }> };
    expect(body.engines.find((e) => e.id === "chatterbox")?.state).toBe("installed");
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
  const exec = buildExec({ portByContainer: { "engined-chatterbox": port } });
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [containerEngine("chatterbox", ttsSpec())],
  });
  const lines: string[] = [];
  const door = createDoor(
    config,
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx", exec },
    { write: (l) => lines.push(l) },
  );

  try {
    await door.fetch(
      req("POST", "/openai/v1/audio/speech", { body: { model: CHATTERBOX, input: "hi" } }),
    );
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as {
      attempts: { ok: boolean; failure?: string }[];
      engine_used: string | null;
    };
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
  const exec = buildExec({ portByContainer: { "engined-chatterbox": fake.port } });
  const lines: string[] = [];
  const door = createDoor(
    baseConfig({ routes: CHATTERBOX_ROUTES, engines: [containerEngine("chatterbox", ttsSpec())] }),
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx", exec },
    { write: (l) => lines.push(l) },
  );
  return {
    door,
    lines,
    stop: () => {
      fake.stop();
    },
  };
}

function speechAttempt(lines: string[]): {
  attempts: { ok: boolean; failure?: string }[];
  engine_used: string | null;
} {
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "{}") as {
    attempts: { ok: boolean; failure?: string }[];
    engine_used: string | null;
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

    const record = speechAttempt(lines);
    expect(record.attempts[0]?.ok).toBe(true);
    expect(record.attempts[0]?.failure).toBeUndefined();
    expect(record.engine_used).toBe("chatterbox");
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

    const record = speechAttempt(lines);
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
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
  const exec = buildExec({ portByContainer: { "engined-chatterbox": fake.port } });
  const config = baseConfig({
    routes: CHATTERBOX_ROUTES,
    engines: [containerEngine("chatterbox", ttsSpec())],
  });
  const door = createDoor(config, {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
  // parameters the standard shape has no room for. chatterbox has several --
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
  const exec = buildExec({ portByContainer: { "engined-chatterbox": fake.port } });
  const door = createDoor(
    baseConfig({ routes: CHATTERBOX_ROUTES, engines: [containerEngine("chatterbox", ttsSpec())] }),
    {
      enginesRoot: "/nonexistent/engines",
      bunx: "/opt/test/bunx",
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

  // OpenAI's names map to the engine's: `instructions` is what chatterbox calls `prompt`.
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

test("a transcription request with no multipart body is a JSON 400, not Bun's HTML 500", async () => {
  // req.formData() throws on an empty POST. Uncaught, that surfaced as Bun's
  // own HTML error page -- the one door response a JSON client cannot read.
  // No engines needed: both guards fire before the engine is ever resolved.
  const door = createDoor(baseConfig(), {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
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
