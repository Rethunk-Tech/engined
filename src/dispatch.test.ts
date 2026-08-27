import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgenticSpawn } from "./agentic.ts";
import { loadConfig } from "./config.ts";
import { resolveModel } from "./dispatch.ts";
import type { Exec, ExecResult, Probe } from "./docker.ts";
import { EngineRegistry } from "./engines.ts";
import type { HttpClient } from "./llama.ts";
import { createDoor, type Door, parsePortHolder, resolveRedirect } from "./main.ts";
import type { Exec as SecretExec } from "./secrets.ts";
import type { Config, EngineEntry, ModelEntry } from "./types.ts";

const BUNX = "/home/x/.bun/bin/bunx";
const CHAT = "/v1/chat/completions";
const SPEECH = "/v1/audio/speech";

function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return { id: "e", egress: "none", args: {}, ...overrides };
}

function remoteAgentic(id: string): EngineEntry {
  return engine({
    id,
    egress: "remote",
    kind: "agentic-cli",
    base_url: `https://example.com/${id}`,
    secret: { service: id, username: "u", header: "x-api-key" },
  });
}

function remoteOpenaiHttp(id: string): EngineEntry {
  return engine({
    id,
    egress: "remote",
    kind: "openai-http",
    base_url: `https://example.com/${id}`,
    secret: { service: id, username: "u", header: "x-api-key" },
  });
}

function model(overrides: Partial<ModelEntry> = {}): ModelEntry {
  return { id: "m", engine: "e", aliases: [], args: {}, ...overrides };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
    listen_port: 29_200,
    chat_timeout_seconds: 600,
    agent_timeout_seconds: 3600,
    models: [],
    engines: [],
    chains: {},
    ...overrides,
  };
}

/** No engine in these fixtures is a container, so no docker exec is ever invoked. */
function registry(cfg: Config, enginesRoot = "/nonexistent"): EngineRegistry {
  return new EngineRegistry(cfg, { enginesRoot, bunx: BUNX });
}

describe("bare model ambiguity", () => {
  test("two engines serving the same bare id: 400 listing the qualified forms", () => {
    const cfg = config({
      engines: [remoteAgentic("engineA"), remoteAgentic("engineB")],
      models: [
        model({ id: "shared", engine: "engineA" }),
        model({ id: "shared", engine: "engineB" }),
      ],
    });
    const reg = registry(cfg);
    const result = resolveModel("shared", CHAT, cfg, reg);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("@/engineA/shared");
    expect(!result.ok && result.error).toContain("@/engineB/shared");
  });

  test("the same string qualified with @/ succeeds", () => {
    const cfg = config({
      engines: [remoteAgentic("engineA"), remoteAgentic("engineB")],
      models: [
        model({ id: "shared", engine: "engineA" }),
        model({ id: "shared", engine: "engineB" }),
      ],
    });
    const reg = registry(cfg);
    const result = resolveModel("@/engineA/shared", CHAT, cfg, reg);
    expect(result).toEqual({ ok: true, kind: "model", engine: "engineA", model: "shared" });
  });

  test("a lone match resolves bare, no qualification needed", () => {
    const cfg = config({
      engines: [remoteAgentic("solo")],
      models: [model({ id: "only", engine: "solo", aliases: ["nickname"] })],
    });
    const reg = registry(cfg);
    expect(resolveModel("only", CHAT, cfg, reg)).toEqual({
      ok: true,
      kind: "model",
      engine: "solo",
      model: "only",
    });
    expect(resolveModel("nickname", CHAT, cfg, reg)).toEqual({
      ok: true,
      kind: "model",
      engine: "solo",
      model: "only",
    });
  });
});

describe("absent, empty and unknown model", () => {
  const cfg = config({ engines: [remoteAgentic("claude")] });
  const reg = registry(cfg);

  test("absent is 400", () => {
    expect(resolveModel(undefined, CHAT, cfg, reg).ok).toBe(false);
  });

  test("empty is 400", () => {
    expect(resolveModel("", CHAT, cfg, reg).ok).toBe(false);
  });

  test("unrecognised is 400", () => {
    const result = resolveModel("nonexistent-thing", CHAT, cfg, reg);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("nonexistent-thing");
  });
});

describe("engine-id bare selector", () => {
  test("an agentic-cli engine resolves with no model", () => {
    const cfg = config({ engines: [remoteAgentic("claude")] });
    const reg = registry(cfg);
    expect(resolveModel("claude", CHAT, cfg, reg)).toEqual({
      ok: true,
      kind: "engine",
      engine: "claude",
    });
  });

  test("a non-agentic engine id bare is 400: it cannot answer without a model", () => {
    const cfg = config({ engines: [remoteOpenaiHttp("gguf-host")] });
    const reg = registry(cfg);
    expect(resolveModel("gguf-host", CHAT, cfg, reg).ok).toBe(false);
  });
});

describe("endpoint mismatch", () => {
  test("a chat-only engine's model posted to a different endpoint is 400", () => {
    const cfg = config({
      engines: [remoteAgentic("claude")],
      models: [model({ id: "sonnet", engine: "claude" })],
    });
    const reg = registry(cfg);
    const result = resolveModel("sonnet", SPEECH, cfg, reg);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("does not serve");
  });
});

describe("chains", () => {
  test("chain-<name> resolves its hops for chat", () => {
    const cfg = config({
      engines: [remoteAgentic("claude")],
      chains: { "chain-private": ["@/claude/sonnet"] },
    });
    const reg = registry(cfg);
    expect(resolveModel("chain-private", CHAT, cfg, reg)).toEqual({
      ok: true,
      kind: "chain",
      chain: "chain-private",
      hops: ["@/claude/sonnet"],
    });
  });

  test("a chain posted to a non-chat endpoint is 400", () => {
    const cfg = config({ chains: { "chain-private": ["@/claude/sonnet"] } });
    const reg = registry(cfg);
    expect(resolveModel("chain-private", SPEECH, cfg, reg).ok).toBe(false);
  });
});

describe("@/local/<model>", () => {
  const CONTAINER_SPEC = `
kind = "openai-http"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["${CHAT}"]
command = ["--model", "x"]

[ready]
path = "/health"
status = 200
`;

  test("resolves to the sole no-egress, models_dir engine", () => {
    const root = mkdtempSync(join(tmpdir(), "engined-dispatch-"));
    mkdirSync(join(root, "local-llama"), { recursive: true });
    writeFileSync(join(root, "local-llama", "spec.toml"), CONTAINER_SPEC);
    const cfg = config({
      engines: [engine({ id: "local-llama", egress: "none", models_dir: "/models" })],
      models: [model({ id: "ornith", engine: "local-llama" })],
    });
    const reg = registry(cfg, root);
    expect(resolveModel("@/local/ornith", CHAT, cfg, reg)).toEqual({
      ok: true,
      kind: "model",
      engine: "local-llama",
      model: "ornith",
    });
  });
});

/** Never 29200: a real workstation daemon may hold it. */
function ephemeralPort(): number {
  return 40_000 + Math.floor(Math.random() * 10_000);
}

/**
 * Binds the door on both loopback families on `port`. The check needs
 * `config.listen_port` to equal it, so the caller picks the port first via
 * `ephemeralPort()` and builds both the config and this bind from it.
 */
function startDualBind(fetch: Door["fetch"], port: number): { stop: () => void } {
  const v4 = Bun.serve({ hostname: "127.0.0.1", port, fetch });
  const v6 = Bun.serve({ hostname: "::1", port, fetch });
  return {
    stop: () => {
      v4.stop();
      v6.stop();
    },
  };
}

/** `Host` is a forbidden header for the Fetch API; `node:http` allows the override the test needs. */
function rawRequest(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("the door: Origin/Host check", () => {
  test("no Origin header is served normally, on a GET", async () => {
    const port = ephemeralPort();
    const cfg = config({ listen_port: port, engines: [remoteAgentic("claude")] });
    const door = createDoor(cfg, { enginesRoot: "/nonexistent", bunx: BUNX });
    const bound = startDualBind(door.fetch, port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`);
      expect(res.status).toBe(200);
    } finally {
      bound.stop();
    }
  });

  test("a foreign Origin is refused on a GET", async () => {
    const port = ephemeralPort();
    const door = createDoor(config({ listen_port: port }), {
      enginesRoot: "/nonexistent",
      bunx: BUNX,
    });
    const bound = startDualBind(door.fetch, port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/models`, {
        headers: { Origin: "https://evil.example" },
      });
      expect(res.status).toBe(403);
    } finally {
      bound.stop();
    }
  });

  test("Origin: null is refused rather than treated as absent, on a POST", async () => {
    const port = ephemeralPort();
    const door = createDoor(config({ listen_port: port }), {
      enginesRoot: "/nonexistent",
      bunx: BUNX,
    });
    const bound = startDualBind(door.fetch, port);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: "POST",
        headers: { Origin: "null", "Content-Type": "application/json" },
        body: JSON.stringify({ model: "claude" }),
      });
      expect(res.status).toBe(403);
    } finally {
      bound.stop();
    }
  });

  test("a Host outside the loopback set is refused, on a GET", async () => {
    const port = ephemeralPort();
    const door = createDoor(config({ listen_port: port }), {
      enginesRoot: "/nonexistent",
      bunx: BUNX,
    });
    const bound = startDualBind(door.fetch, port);
    try {
      const res = await rawRequest(port, "/v1/models", { Host: `evil.example:${port}` });
      expect(res.status).toBe(403);
    } finally {
      bound.stop();
    }
  });
});

describe("the door: dual-family bind", () => {
  test("both 127.0.0.1 and [::1] answer on the same configured port", async () => {
    const port = ephemeralPort();
    const door = createDoor(config({ listen_port: port }), {
      enginesRoot: "/nonexistent",
      bunx: BUNX,
    });
    const bound = startDualBind(door.fetch, port);
    try {
      const v4 = await fetch(`http://127.0.0.1:${port}/v1/models`);
      const v6 = await fetch(`http://[::1]:${port}/v1/models`);
      expect(v4.status).toBe(200);
      expect(v6.status).toBe(200);
    } finally {
      bound.stop();
    }
  });
});

describe("the door: SIGHUP reload", () => {
  const GOOD_CONFIG = `
[[engine]]
id = "claude"
egress = "remote"
kind = "agentic-cli"
base_url = "https://api.anthropic.com"
  [engine.secret]
  service = "s"
  username = "u"
  header = "x-api-key"
`;

  test("broken TOML on reload keeps the previous config serving and names the parse error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "engined-reload-"));
    const path = join(dir, "config.toml");
    writeFileSync(path, GOOD_CONFIG);

    const door = createDoor(loadConfig(path), { enginesRoot: "/nonexistent", bunx: BUNX });
    const before = (await (await door.fetch(new Request("http://engined/v1/engines"))).json()) as {
      engines: { id: string }[];
    };
    expect(before.engines.map((e) => e.id)).toEqual(["claude"]);

    writeFileSync(path, "not valid toml {{{");
    door.reload(path);

    expect(door.configError()).toBeDefined();
    const after = (await (await door.fetch(new Request("http://engined/v1/engines"))).json()) as {
      engines: { id: string }[];
      config_error: string;
    };
    // Previous config still serving: the same engine, not an empty list.
    expect(after.engines.map((e) => e.id)).toEqual(["claude"]);
    expect(after.config_error).toBeDefined();
    expect(after.config_error).toContain(path);
  });
});

describe("port-holder diagnosis", () => {
  /** `ss -ltnp "sport = :3003"`, captured on this box. */
  const REAL_SS_OUTPUT =
    "State  Recv-Q Send-Q Local Address:Port Peer Address:PortProcess                                       \n" +
    'LISTEN 0      511                *:3003            *:*    users:(("next-server (v1",pid=3451678,fd=24))\n';

  test("parses the holder's name and pid out of a real ss -ltnp line", () => {
    expect(parsePortHolder(REAL_SS_OUTPUT)).toEqual({ name: "next-server (v1", pid: 3_451_678 });
  });

  test("no listener line, no match", () => {
    const empty = "State  Recv-Q Send-Q Local Address:Port Peer Address:Port\n";
    expect(parsePortHolder(empty)).toBeUndefined();
  });
});

const LOCAL_LLAMA_SPEC = `
kind = "openai-http"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/v1/chat/completions", "/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`;

const CLAUDE_SPEC = `
kind = "agentic-cli"
serves = ["/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@{claude_version}", "-p"]
env = ["HOME"]
`;

/** Image present with one exposed port, a fresh host port per "port" lookup. */
function llamaExec(): Exec {
  let port = 41_000;
  return (args) => {
    let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "image" && args[1] === "inspect") {
      result = {
        stdout: '[{"Config":{"ExposedPorts":{"8080/tcp":{}}}}]',
        stderr: "",
        exitCode: 0,
      };
    } else if (args[0] === "port") {
      port += 1;
      result = { stdout: `127.0.0.1:${port}\n`, stderr: "", exitCode: 0 };
    }
    return Promise.resolve(result);
  };
}

const READY_200: Probe = () => Promise.resolve({ status: 200 });

/** `/models/load` and `/models/unload` answer immediately; every other call is recorded. */
function makeLlamaHttpClient(recorded: { body: string }[]): HttpClient {
  return (url: string, init?: RequestInit) => {
    if (url.endsWith("/models/load")) {
      // Real b10354 contract: an already-resident model 400s "already
      // running" -- that is the ready signal loadAndWait polls for.
      return Promise.resolve(
        Response.json(
          { error: { code: 400, message: "model is already running", type: "invalid_request_error" } },
          { status: 400 },
        ),
      );
    }
    if (url.endsWith("/models/unload")) {
      return Promise.resolve(Response.json({ status: "ok" }));
    }
    if (typeof init?.body === "string") {
      recorded.push({ body: init.body });
    }
    return Promise.resolve(
      Response.json({ id: "resp-1", choices: [{ message: { content: "hi" } }] }),
    );
  };
}

function llamaDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(tmpdir(), "engined-door-"));
  mkdirSync(join(root, "local-llama"), { recursive: true });
  writeFileSync(join(root, "local-llama", "spec.toml"), LOCAL_LLAMA_SPEC);
  const cfg = config({
    engines: [
      engine({ id: "local-llama", egress: "none", models_dir: "/data/gguf", models_max: 1 }),
    ],
    models: [model({ id: "ornith", engine: "local-llama", filename: "x.gguf", role: "chat" })],
  });
  return { cfg, root };
}

describe("the door: content routing", () => {
  test("a chat against a resolvable llama model reaches the router and returns its body", async () => {
    const { cfg, root } = llamaDoorConfig();
    const recorded: { body: string }[] = [];
    const lines: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, exec: llamaExec(), probe: READY_200 },
      {
        llamaHttpClient: makeLlamaHttpClient(recorded),
        write: (l) => lines.push(l),
        llamaPresetHostPath: join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini"),
      },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "ornith", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(body.choices[0]?.message.content).toBe("hi");
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? "{}") as { engine_used: string }).engine_used).toBe(
      "local-llama",
    );
  });

  test("workdir is stripped and reasoning_effort passes through to an openai-http hop", async () => {
    const { cfg, root } = llamaDoorConfig();
    const recorded: { body: string }[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, exec: llamaExec(), probe: READY_200 },
      {
        llamaHttpClient: makeLlamaHttpClient(recorded),
        llamaPresetHostPath: join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini"),
        write: () => undefined,
      },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "ornith",
          messages: [{ role: "user", content: "hi" }],
          workdir: "/should/not/reach/llama",
          reasoning_effort: "high",
        }),
      }),
    );
    // The response is a lazily-produced stream: reading it to completion is
    // what actually drives `runLease`'s upstream call, the same as a real
    // consumer would.
    await res.text();
    expect(recorded).toHaveLength(1);
    const forwarded = JSON.parse(recorded[0]?.body ?? "{}") as Record<string, unknown>;
    expect(forwarded.workdir).toBeUndefined();
    expect(forwarded.reasoning_effort).toBe("high");
  });
});

describe("the door: agentic and chain routing", () => {
  test("an agentic attempt without workdir is 400 and the spawn is never invoked", async () => {
    const root = mkdtempSync(join(tmpdir(), "engined-door-"));
    mkdirSync(join(root, "claude"), { recursive: true });
    writeFileSync(join(root, "claude", "spec.toml"), CLAUDE_SPEC);
    const cfg = config({
      engines: [engine({ id: "claude", egress: "remote", claude_version: "1.2.3" })],
    });
    const spawnCalls: unknown[] = [];
    const fakeSpawn: AgenticSpawn = (argv, opts) => {
      spawnCalls.push({ argv, opts });
      return Promise.resolve({ stdout: '{"result":"hi"}', stderr: "", exitCode: 0 });
    };
    const lines: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX },
      { agenticSpawn: fakeSpawn, write: (l) => lines.push(l) },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "claude", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(res.status).toBe(400);
    expect(spawnCalls).toHaveLength(0);
    expect(lines).toHaveLength(1);
  });
});

describe("the door: chain routing", () => {
  test("a chain whose first hop is dead completes on the second, and provenance names the second engine", async () => {
    const root = mkdtempSync(join(tmpdir(), "engined-door-"));
    for (const id of ["claude-a", "claude-b"]) {
      mkdirSync(join(root, id), { recursive: true });
      writeFileSync(join(root, id, "spec.toml"), CLAUDE_SPEC);
    }
    const cfg = config({
      engines: [
        engine({ id: "claude-a", egress: "remote", claude_version: "1.2.3" }),
        engine({ id: "claude-b", egress: "remote", claude_version: "1.2.3" }),
      ],
      chains: { "chain-x": ["@/claude-a/x", "@/claude-b/y"] },
    });
    // First call is claude-a: unparseable stdout, a dead hop that advances the
    // chain. Second is claude-b: a real envelope, the answer that wins.
    let calls = 0;
    const spawn: AgenticSpawn = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({ stdout: "not json", stderr: "", exitCode: 0 });
      }
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"second engine answered"}',
        stderr: "",
        exitCode: 0,
      });
    };
    const lines: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX },
      { agenticSpawn: spawn, write: (l) => lines.push(l) },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "chain-x",
          messages: [{ role: "user", content: "hi" }],
          workdir: "/tmp",
        }),
      }),
    );
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(res.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe("second engine answered");
    expect(calls).toBe(2);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as {
      engine_used: string;
      attempts: { engine: string; ok: boolean }[];
    };
    expect(record.engine_used).toBe("claude-b");
    expect(record.attempts).toHaveLength(2);
    expect(record.attempts[0]).toMatchObject({ engine: "claude-a", ok: false });
    expect(record.attempts[1]).toMatchObject({ engine: "claude-b", ok: true });
  });
});

const FAILOVER_DEAD_PORT = 46_001;
const FAILOVER_LIVE_PORT = 46_002;

/** One shared docker fake for two engines, distinguished by the container name docker.ts always passes. */
function twoEngineExec(): Exec {
  return (args) => {
    let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "image" && args[1] === "inspect") {
      result = {
        stdout: '[{"Config":{"ExposedPorts":{"8080/tcp":{}}}}]',
        stderr: "",
        exitCode: 0,
      };
    } else if (args[0] === "port") {
      const name = args[1] ?? "";
      const hostPort = name.includes("dead") ? FAILOVER_DEAD_PORT : FAILOVER_LIVE_PORT;
      result = { stdout: `127.0.0.1:${hostPort}\n`, stderr: "", exitCode: 0 };
    }
    return Promise.resolve(result);
  };
}

/** The "dead" upstream answers with `deadStatus`; the "live" one always succeeds. Each records its own calls. */
function makeSplitHttpClient(
  deadStatus: number,
  deadCalls: string[],
  liveCalls: string[],
): HttpClient {
  return (url: string) => {
    if (url.endsWith("/models/load")) {
      // Real b10354 contract: an already-resident model 400s "already
      // running" -- that is the ready signal loadAndWait polls for.
      return Promise.resolve(
        Response.json(
          { error: { code: 400, message: "model is already running", type: "invalid_request_error" } },
          { status: 400 },
        ),
      );
    }
    if (url.endsWith("/models/unload")) {
      return Promise.resolve(Response.json({ status: "ok" }));
    }
    const { port } = new URL(url);
    if (port === String(FAILOVER_DEAD_PORT)) {
      deadCalls.push(url);
      return Promise.resolve(Response.json({ error: "dead" }, { status: deadStatus }));
    }
    liveCalls.push(url);
    return Promise.resolve(
      Response.json({ id: "resp-live", choices: [{ message: { content: "live" } }] }),
    );
  };
}

function twoEngineDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(tmpdir(), "engined-door-"));
  for (const id of ["llama-dead", "llama-live"]) {
    mkdirSync(join(root, id), { recursive: true });
    writeFileSync(join(root, id, "spec.toml"), LOCAL_LLAMA_SPEC);
  }
  const cfg = config({
    engines: [
      engine({ id: "llama-dead", egress: "none", models_dir: "/data/dead", models_max: 1 }),
      engine({ id: "llama-live", egress: "none", models_dir: "/data/live", models_max: 1 }),
    ],
    models: [
      model({ id: "dead-model", engine: "llama-dead", filename: "d.gguf", role: "chat" }),
      model({ id: "live-model", engine: "llama-live", filename: "l.gguf", role: "chat" }),
    ],
    chains: { "chain-failover": ["@/llama-dead/dead-model", "@/llama-live/live-model"] },
  });
  return { cfg, root };
}

describe("the door: a llama hop's real status decides chain advance", () => {
  test("a 500 from the first hop advances: the second hop's upstream received a request", async () => {
    const { cfg, root } = twoEngineDoorConfig();
    const deadCalls: string[] = [];
    const liveCalls: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, exec: twoEngineExec(), probe: READY_200 },
      {
        llamaHttpClient: makeSplitHttpClient(500, deadCalls, liveCalls),
        llamaPresetHostPath: join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini"),
        write: () => undefined,
      },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "chain-failover",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(res.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe("live");
    expect(deadCalls.length).toBeGreaterThan(0);
    expect(liveCalls.length).toBeGreaterThan(0);
  });

  test("a 400 from the first hop does not advance: the second hop's upstream is never touched", async () => {
    const { cfg, root } = twoEngineDoorConfig();
    const deadCalls: string[] = [];
    const liveCalls: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, exec: twoEngineExec(), probe: READY_200 },
      {
        llamaHttpClient: makeSplitHttpClient(400, deadCalls, liveCalls),
        llamaPresetHostPath: join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini"),
        write: () => undefined,
      },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "chain-failover",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    );
    await res.text();
    expect(res.status).toBe(400);
    expect(deadCalls.length).toBeGreaterThan(0);
    expect(liveCalls).toHaveLength(0);
  });
});

describe("the door: extras injects the resident model for the right role", () => {
  test("with a vision model and a chat model both resident, an extras call injects the chat model", async () => {
    const { cfg, root } = llamaDoorConfig();
    const cfgWithVision: Config = {
      ...cfg,
      models: [
        ...cfg.models,
        model({ id: "vision-a", engine: "local-llama", filename: "v.gguf", role: "vision" }),
      ],
    };
    const recorded: { body: string }[] = [];
    const extrasCalls: string[] = [];
    const extrasClient: HttpClient = (_url: string, init?: RequestInit) => {
      extrasCalls.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(Response.json({ ok: true }));
    };
    const door = createDoor(
      cfgWithVision,
      { enginesRoot: root, bunx: BUNX, exec: llamaExec(), probe: READY_200 },
      {
        llamaHttpClient: makeLlamaHttpClient(recorded),
        extrasHttpClient: extrasClient,
        llamaPresetHostPath: join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini"),
        write: () => undefined,
      },
    );

    // Warm both roles: chat first, then vision *last* — a door-side "last
    // model proxied to this engine, any role" approximation would report
    // vision here, since it was the most recent call. Asking the router for
    // the chat role specifically must still report the chat model.
    await (
      await door.fetch(
        new Request("http://engined/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "ornith", messages: [{ role: "user", content: "hi" }] }),
        }),
      )
    ).text();
    await (
      await door.fetch(
        new Request("http://engined/v1/chat/completions", {
          method: "POST",
          body: JSON.stringify({ model: "vision-a", messages: [{ role: "user", content: "hi" }] }),
        }),
      )
    ).text();

    await door.fetch(
      new Request("http://engined/tokenize", {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      }),
    );

    expect(extrasCalls).toHaveLength(1);
    const forwarded = JSON.parse(extrasCalls[0] ?? "{}") as { model?: string };
    expect(forwarded.model).toBe("ornith");
  });
});

function fakeSecretExec(value: string | undefined): SecretExec {
  return (args) => {
    if (args[0] === "lookup" && value !== undefined) {
      return Promise.resolve({ stdout: value, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };
}

function kimiEngine(): EngineEntry {
  return engine({
    id: "claude-kimi",
    egress: "remote",
    kind: "agentic-cli",
    base_url: "https://api.kimi.com/coding/",
    secret: { service: "moonshot-api", username: "kimi-k2.7-code", header: "x-api-key" },
    claude_version: "1.2.3",
  });
}

/** The redirected engine has no spec of its own; it reuses the shipped claude directory. */
function redirectDoorRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "engined-door-"));
  mkdirSync(join(root, "claude"), { recursive: true });
  writeFileSync(join(root, "claude", "spec.toml"), CLAUDE_SPEC);
  return root;
}

describe("the door: remote-agentic redirect (claude-kimi-shaped engine)", () => {
  test("redirect variables and the resolved key reach the child env; ambient GITHUB_TOKEN does not; the full floor survives; the secret never appears in argv", async () => {
    const root = redirectDoorRoot();
    const cfg = config({
      engines: [kimiEngine()],
      models: [model({ id: "kimi-k3", engine: "claude-kimi" })],
    });
    const spawnCalls: { argv: string[]; env: Record<string, string> }[] = [];
    const spawn: AgenticSpawn = (spawnArgv, opts) => {
      spawnCalls.push({ argv: spawnArgv, env: opts.env });
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"answered via kimi"}',
        stderr: "",
        exitCode: 0,
      });
    };
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX },
      {
        agenticSpawn: spawn,
        secretExec: fakeSecretExec("kimi-secret-value"),
        agenticAmbientEnv: { HOME: "/home/test", GITHUB_TOKEN: "ghp_leaked_repo_scope" },
        write: () => undefined,
      },
    );
    const res = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "kimi-k3",
          messages: [{ role: "user", content: "hi" }],
          workdir: "/tmp/scratch",
        }),
      }),
    );
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    expect(res.status).toBe(200);
    expect(body.choices[0]?.message.content).toBe("answered via kimi");

    expect(spawnCalls).toHaveLength(1);
    const { env, argv } = spawnCalls[0] ?? { env: {}, argv: [] };

    // Redirect variables and the resolved key reach the child; ambient GITHUB_TOKEN does not.
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");
    expect(env.ANTHROPIC_API_KEY).toBe("kimi-secret-value");
    expect(env.ANTHROPIC_MODEL).toBe("kimi-k3");
    expect("GITHUB_TOKEN" in env).toBe(false);
    expect(Object.values(env)).not.toContain("ghp_leaked_repo_scope");

    // The full floor is still present in argv, all three flags individually.
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--strict-mcp-config");
    const toolsIdx = argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(argv[toolsIdx + 1]).toBe("Read,Grep,Glob");

    // The resolved secret appears nowhere in argv.
    expect(argv.some((a) => a.includes("kimi-secret-value"))).toBe(false);
  });
});

describe("the door: remote-agentic redirect, missing secret", () => {
  test("a missing secret's HopResult carries the secret-tool store command", async () => {
    // Direct: runChain's own exhaustion wrapper replaces a lone hop's body
    // with a generic "every engine in this chain failed" once it classifies
    // a 5xx as advance-and-nothing-left-to-advance-to (chain.ts is not this
    // worker's file to change), so the fix text is only observable on the
    // HopResult resolveRedirect itself produces, before runChain ever sees it.
    const redirect = await resolveRedirect(
      kimiEngine(),
      "kimi-k3",
      config(),
      fakeSecretExec(undefined),
    );
    expect(redirect.ok).toBe(false);
    if (redirect.ok) {
      throw new Error("expected resolveRedirect to fail for a missing secret");
    }
    expect(redirect.result.status).toBe(503);
    const failBody = redirect.result.body as { error: string };
    expect(failBody.error).toContain("secret-tool store");
    expect(failBody.error).toContain("moonshot-api");
  });
});

describe("the door: remote-agentic redirect, missing secret does not take down other engines", () => {
  test("the local engine still serves, and the kimi attempt is reported as a clean 503", async () => {
    const root = redirectDoorRoot();
    mkdirSync(join(root, "local-llama"), { recursive: true });
    writeFileSync(join(root, "local-llama", "spec.toml"), LOCAL_LLAMA_SPEC);
    const cfg = config({
      engines: [
        kimiEngine(),
        engine({ id: "local-llama", egress: "none", models_dir: "/data/gguf", models_max: 1 }),
      ],
      models: [
        model({ id: "kimi-k3", engine: "claude-kimi" }),
        model({ id: "ornith", engine: "local-llama", filename: "x.gguf", role: "chat" }),
      ],
    });
    const recorded: { body: string }[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, exec: llamaExec(), probe: READY_200 },
      {
        secretExec: fakeSecretExec(undefined),
        llamaHttpClient: makeLlamaHttpClient(recorded),
        llamaPresetHostPath: join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini"),
        write: () => undefined,
      },
    );

    const kimiRes = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({
          model: "kimi-k3",
          messages: [{ role: "user", content: "hi" }],
          workdir: "/tmp/scratch",
        }),
      }),
    );
    expect(kimiRes.status).toBe(503);

    const llamaRes = await door.fetch(
      new Request("http://engined/v1/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "ornith", messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(llamaRes.status).toBe(200);
  });
});
