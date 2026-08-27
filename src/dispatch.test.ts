import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { resolveModel } from "./dispatch.ts";
import { EngineRegistry } from "./engines.ts";
import { createDoor, type Door, parsePortHolder } from "./main.ts";
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
