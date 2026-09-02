import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, join } from "node:path";
import process from "node:process";
import type { AgenticSpawn } from "./agentic.ts";
import { loadConfig } from "./config.ts";
import { DockerLifecycle, type Probe } from "./docker.ts";
import type { AgenticProbeRunner } from "./engines.ts";
import type { Exec, ExecResult } from "./exec.ts";
import type { HttpClient } from "./http.ts";
import {
  bindDualFamily,
  createDoor,
  type Door,
  type DoorOptions,
  resolveBunx,
  resolveRedirect,
  timeoutSecondsForKind,
} from "./main.ts";
import {
  assertReportedAndResident,
  BUNX,
  clearVerifiedVersion,
  config,
  containerRunning,
  engine,
  inspectSinglePort,
  llamaControlPlane,
  makeTestRoot,
  portResult,
  route,
  tempPresetPath,
  writeEngineSpec,
} from "./test-support.ts";
import type { Config, EngineEntry, Upstream } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-door-test-");
/** A plausible launch-scoped door URL for a `resolveRedirect` unit test that never touches the real door. */
const TEST_DOOR_URL = "http://127.0.0.1:29200/openai/v1/deadbeefdeadbeefdeadbeefdeadbeef";

const PASSING_PROBE: AgenticProbeRunner = () => Promise.resolve({ ok: true });

/** Every door test that posts a chat completion sends the same request shape; only the JSON body differs. */
function chatRequest(body: unknown): Request {
  return new Request("http://engined/openai/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Never 29200: a real workstation daemon may hold it. */
function ephemeralPort(): number {
  return 40_000 + Math.floor(Math.random() * 10_000);
}

/**
 * Binds the door on both loopback families on `port`, through `main.ts`'s
 * own `bindDualFamily` rather than a hand-rolled `Bun.serve` pair — a
 * substitute here would pass even with the real `::1` listener deleted. The
 * check needs `config.listen_port` to equal it, so the caller picks the port
 * first via `ephemeralPort()` and builds both the config and this bind from it.
 */
function startDualBind(fetch: Door["fetch"], port: number): { stop: () => void } {
  const { v4, v6 } = bindDualFamily(fetch, port);
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

/** Every Origin/Host/dual-bind check binds a real door on an ephemeral port for `fn`'s duration, then tears it down; only the config and the request/assertion differ. */
async function withBoundDoor<T>(cfg: Config, fn: (port: number) => Promise<T>): Promise<T> {
  const door = createDoor(cfg, { enginesRoot: "/nonexistent", bunx: BUNX });
  const bound = startDualBind(door.fetch, cfg.listen_port);
  try {
    return await fn(cfg.listen_port);
  } finally {
    bound.stop();
  }
}

describe("the door: Origin/Host check", () => {
  // The foreign-Origin, Origin:null and clean-request cases are covered by
  // integration.test.ts's own Origin guard test; `Host` is Fetch-forbidden,
  // so only this real-socket, raw `node:http` request can exercise it.
  test("a Host outside the loopback set is refused, on a GET", async () => {
    const port = ephemeralPort();
    await withBoundDoor(config({ listen_port: port }), async () => {
      const res = await rawRequest(port, "/openai/v1/models", { Host: `evil.example:${port}` });
      expect(res.status).toBe(403);
    });
  });
});

describe("the door: dual-family bind", () => {
  test("both 127.0.0.1 and [::1] answer on the same configured port", async () => {
    const port = ephemeralPort();
    await withBoundDoor(config({ listen_port: port }), async () => {
      const v4 = await fetch(`http://127.0.0.1:${port}/openai/v1/models`);
      const v6 = await fetch(`http://[::1]:${port}/openai/v1/models`);
      expect(v4.status).toBe(200);
      expect(v6.status).toBe(200);
    });
  });
});

describe("the door: SIGHUP reload", () => {
  // A spec-less kind (never reads a spec file, so "/nonexistent" below is
  // fine) with a modelless route: the parse-tier split already forbids
  // filename/role on it, so there is nothing left for the kind-dependent
  // registry check to gate.
  const GOOD_CONFIG = `
[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "claude"
kind = "stt"

[[route]]
engine = "claude"
upstream = "local"
`;

  test("broken TOML on reload keeps the previous config serving and names the parse error", async () => {
    const dir = mkdtempSync(join(TEST_ROOT, "engined-reload-"));
    const path = join(dir, "config.toml");
    writeFileSync(path, GOOD_CONFIG);

    const door = createDoor(loadConfig(path), {
      enginesRoot: "/nonexistent",
      bunx: BUNX,
    });
    const before = (await (
      await door.fetch(new Request("http://engined/engined/v1/engines"))
    ).json()) as {
      engines: { id: string }[];
    };
    expect(before.engines.map((e) => e.id)).toEqual(["claude"]);

    writeFileSync(path, "not valid toml {{{");
    door.reload(path);

    expect(door.configError()).toBeDefined();
    const after = (await (
      await door.fetch(new Request("http://engined/engined/v1/engines"))
    ).json()) as {
      engines: { id: string }[];
      config_error: string;
    };
    // Previous config still serving: the same engine, not an empty list.
    expect(after.engines.map((e) => e.id)).toEqual(["claude"]);
    expect(after.config_error).toBeDefined();
    expect(after.config_error).toContain(path);
  });
});

const LOCAL_LLAMA_SPEC = `
kind = "openai-http"
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/chat/completions", "/openai/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`;

const CLAUDE_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["/openai/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@{agent_version}", "-p"]
env = ["HOME"]
`;

const OPENCODE_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "opencode"
serves = ["/openai/v1/chat/completions"]
command = ["{bunx}", "opencode-ai@{agent_version}", "run"]
env = ["HOME"]
`;

/** models_dir for its own bind mount, zero `[[model]]` rows. */
const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "ghcr.io/example/comfy@sha256:bbbb"
obtain = "pull"
serves = []
command = []

[ready]
path = "/queue"
status = 200
`;

/** Image present with one exposed port, a fresh host port per "port" lookup. */
function llamaExec(): Exec {
  let port = 41_000;
  return (args) => {
    let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "image" && args[1] === "inspect") {
      result = inspectSinglePort(8080);
    } else if (args[0] === "port") {
      port += 1;
      result = portResult(port);
    } else if (args[0] === "inspect") {
      result = containerRunning();
    }
    return Promise.resolve(result);
  };
}

const READY_200: Probe = () => Promise.resolve({ status: 200 });

/** Every llama-routed door test shares this enginesRoot/bunx/probe/preset wiring; only the config, the http client, and the exec fake (a second engine's failover tests supply their own) vary. */
function createLlamaDoor(
  cfg: Config,
  root: string,
  doorOpts: DoorOptions = {},
  exec: Exec = llamaExec(),
): Door {
  return createDoor(
    cfg,
    { enginesRoot: root, bunx: BUNX, exec, probe: READY_200 },
    { llamaPresetHostPath: tempPresetPath(TEST_ROOT), ...doorOpts },
  );
}

/** `/models/load` and `/models/unload` answer immediately; every other call is recorded.
 * Real b10354 contract, probed live: `/models/load` accepts with `{success:true}` and
 * readiness is confirmed via `GET /openai/v1/models`'s per-model `status.value` reaching
 * "loaded" -- an already-resident model's 400 "already running" fires before the
 * child is actually able to serve, so it is not the signal `loadAndWait` trusts. */
function makeLlamaHttpClient(recorded: { body: string }[]): HttpClient {
  const control = llamaControlPlane();
  return (url: string, init?: RequestInit) => {
    const controlled = control(url, init);
    if (controlled) {
      return Promise.resolve(controlled);
    }
    if (typeof init?.body === "string") {
      recorded.push({ body: init.body });
    }
    return Promise.resolve(
      Response.json({ id: "resp-1", choices: [{ message: { content: "hi" } }] }),
    );
  };
}

/** A real `config.toml` on disk, for a test that must go through `door.reload(path)` -- not the in-memory `Config` shortcut `llamaDoorConfig` uses. */
function llamaTomlConfig(modelsDir: string): string {
  return `
[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "local-llama"
models_dir = "${modelsDir}"

[[route]]
engine = "local-llama"
upstream = "local"
model = "ornith"
filename = "x.gguf"
role = "chat"

[[route]]
engine = "local-llama"
upstream = "local"
model = "other"
filename = "y.gguf"
role = "chat"
`;
}

/** A fresh root/spec.toml plus an on-disk config.toml naming "ornith" and "other", both real files backing the same local-llama engine -- the reload-race test's own on-disk config, since it must go through `door.reload(path)`, not the in-memory `Config` shortcut. */
function setupReloadRaceConfig(): { root: string; configFilePath: string } {
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  writeEngineSpec(root, "local-llama", LOCAL_LLAMA_SPEC);
  const modelsDir = mkdtempSync(join(TEST_ROOT, "engined-models-"));
  writeFileSync(join(modelsDir, "x.gguf"), "");
  writeFileSync(join(modelsDir, "y.gguf"), "");
  const configDir = mkdtempSync(join(TEST_ROOT, "engined-config-"));
  const configFilePath = join(configDir, "config.toml");
  writeFileSync(configFilePath, llamaTomlConfig(modelsDir));
  return { root, configFilePath };
}

/**
 * Answers the real b10354 load/unload/`/openai/v1/models` contract by replaying
 * `calls`'s own load history, and gates the "ornith" chat call on `gate` so
 * the reload race has a window to land while that lease is still held.
 */
function makeReloadRaceClient(
  calls: string[],
  gate: Promise<void>,
  ornithStarted: () => void,
): HttpClient {
  return async (url, init) => {
    const body =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : undefined;
    if (url.endsWith("/models/load")) {
      calls.push(`load:${body?.model}`);
      return Response.json({ success: true });
    }
    if (url.endsWith("/models/unload")) {
      calls.push(`unload:${body?.model}`);
      return Response.json({ status: "ok" });
    }
    if (url.endsWith("/v1/models")) {
      const lastLoad = [...calls]
        .reverse()
        .find((c) => c.startsWith("load:"))
        ?.slice(5);
      return Response.json({
        data: lastLoad === undefined ? [] : [{ id: lastLoad, status: { value: "loaded" } }],
      });
    }
    // The chat completion call itself.
    if (body?.model === "ornith") {
      calls.push("chat-start:ornith");
      ornithStarted();
      await gate;
      calls.push("chat-end:ornith");
      return Response.json({ id: "r1", choices: [{ message: { content: "ornith-answer" } }] });
    }
    calls.push("chat:other");
    return Response.json({ id: "r2", choices: [{ message: { content: "other-answer" } }] });
  };
}

describe("the door: reload mid in-flight request", () => {
  /**
   * In-flight leases finish against the old engine list.
   * Reloading used to clear every cached `LlamaRouter` unconditionally
   * (main.ts's old `ctx.llamaRouters.clear()`), so a request that arrived
   * after the reload but while an earlier one was still mid-lease got a
   * brand-new router with empty occupancy bookkeeping -- a second, ignorant
   * tracker over the same container that could unload/load without ever
   * knowing the first request's model was still being read from. The fix
   * must keep routing new requests through the old router until its own
   * leases drain, so a same-role request for a different model still queues
   * behind the one in flight instead of racing it on a second tracker.
   */
  test("a same-role request for a different model still queues behind one already in flight, even after a reload lands between them", async () => {
    const { root, configFilePath } = setupReloadRaceConfig();

    const calls: string[] = [];
    let releaseOrnith: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      releaseOrnith = r;
    });
    let ornithStarted: () => void = () => undefined;
    const ornithStartedPromise = new Promise<void>((r) => {
      ornithStarted = r;
    });
    const client = makeReloadRaceClient(calls, gate, ornithStarted);
    const door = createLlamaDoor(loadConfig(configFilePath), root, {
      llamaHttpClient: client,
      write: () => undefined,
    });

    const ornithReq = door.fetch(
      chatRequest({ model: "@/local-llama/ornith", messages: [{ role: "user", content: "hi" }] }),
    );
    await ornithStartedPromise;

    // The reload lands while ornith's lease is still held -- same file,
    // content unchanged, only to exercise the router-cache swap itself.
    door.reload(configFilePath);

    const otherReq = door.fetch(
      chatRequest({ model: "@/local-llama/other", messages: [{ role: "user", content: "hi" }] }),
    );
    // Let the pump run as far as it can while ornith's lease is still held.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const otherTouchedWhileOrnithHeld = calls.some((c) => c.includes("other"));
    expect(otherTouchedWhileOrnithHeld).toBe(false);

    releaseOrnith();
    const ornithBody = (await (await ornithReq).json()) as {
      choices: { message: { content: string } }[];
    };
    const otherBody = (await (await otherReq).json()) as {
      choices: { message: { content: string } }[];
    };
    expect(ornithBody.choices[0]?.message.content).toBe("ornith-answer");
    expect(otherBody.choices[0]?.message.content).toBe("other-answer");

    // Whatever "other" activity happened, it is strictly after ornith's own
    // chat call ended -- a real, serialized swap, not a race against it.
    const chatEndIdx = calls.indexOf("chat-end:ornith");
    const otherActivityIdx = calls.findIndex((c) => c.includes("other"));
    expect(chatEndIdx).toBeGreaterThan(-1);
    expect(otherActivityIdx).toBeGreaterThan(chatEndIdx);
  });
});

describe("timeoutSecondsForKind: the budget follows the hop's own engine kind", () => {
  test("an agentic-cli hop gets agent_timeout_seconds", () => {
    const cfg = config({ chat_timeout_seconds: 30, agent_timeout_seconds: 3600 });
    expect(timeoutSecondsForKind("agentic-cli", cfg)).toBe(3600);
  });

  test("every other kind gets chat_timeout_seconds -- including inside a chain", () => {
    const cfg = config({ chat_timeout_seconds: 30, agent_timeout_seconds: 3600 });
    expect(timeoutSecondsForKind("openai-http", cfg)).toBe(30);
    expect(timeoutSecondsForKind("tts", cfg)).toBe(30);
    expect(timeoutSecondsForKind(undefined, cfg)).toBe(30);
  });
});

const RX_ENGINED_BUNX_UNSET = /ENGINED_BUNX is not set/;

describe("resolveBunx: the ENGINED_BUNX invariant", () => {
  const noBunxOnPath = () => null;

  test("ENGINED_BUNX set is used verbatim, PATH never consulted", () => {
    const which = (cmd: string) => {
      throw new Error(`which() must not be called when ENGINED_BUNX is set, got: ${cmd}`);
    };
    expect(resolveBunx({ ENGINED_BUNX: "/opt/engined/state/bunx" }, which)).toBe(
      "/opt/engined/state/bunx",
    );
  });

  test("ENGINED_BUNX unset falls back to PATH -- the legitimate working-tree dev-run path", () => {
    const which = (cmd: string) => (cmd === "bunx" ? "/home/dev/.bun/bin/bunx" : null);
    expect(resolveBunx({}, which)).toBe("/home/dev/.bun/bin/bunx");
  });

  test("ENGINED_BUNX empty string is treated the same as unset, not used verbatim", () => {
    const which = () => "/home/dev/.bun/bin/bunx";
    expect(resolveBunx({ ENGINED_BUNX: "" }, which)).toBe("/home/dev/.bun/bin/bunx");
  });

  /**
   * A bare `?? "bunx"` fallback is always a truthy string, so it can never be
   * fatal however unresolvable bunx actually is. This asserts the two halves
   * side by side: that expression against the exact env/PATH state that should
   * refuse, and `resolveBunx` refusing it.
   */
  test("neither ENGINED_BUNX nor a PATH bunx is fatal -- the old bare fallback would have silently produced a truthy string here", () => {
    const env: Record<string, string | undefined> = {};
    const oldFallback = env.ENGINED_BUNX ?? "bunx";
    expect(oldFallback).toBe("bunx"); // truthy: the old code never threw for this exact case.

    expect(() => resolveBunx({}, noBunxOnPath)).toThrow(RX_ENGINED_BUNX_UNSET);
  });
});

describe("the door: chain timeout follows the hop, not the chain", () => {
  /**
   * `chat_timeout_seconds` is scoped to "one engine," per
   * attempt. `chatTimeoutMs` used to pick `agent_timeout_seconds` for EVERY
   * hop of ANY chain (`chainName !== null`), even one with no agentic hop
   * anywhere in it -- an all-local-llama chain inherited the long agentic
   * budget it never needed. `chat_timeout_seconds` is set well under the
   * upstream's artificial delay and `agent_timeout_seconds` well over it, so
   * the outcome (timeout vs success) proves which budget actually applied.
   */
  test("a chain with no agentic hop times out on chat_timeout_seconds rather than surviving on agent_timeout_seconds", async () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
    writeEngineSpec(root, "local-llama", LOCAL_LLAMA_SPEC);
    const UPSTREAM_DELAY_MS = 150;
    const cfg = config({
      chat_timeout_seconds: 0.05,
      agent_timeout_seconds: 10,
      engines: [engine({ id: "local-llama", models_dir: "/data/gguf", models_max: 1 })],
      routes: [route({ engine: "local-llama", model: "ornith", filename: "x.gguf", role: "chat" })],
      chains: { "chain-x": ["@/local-llama/ornith"] },
    });
    const client: HttpClient = (url, init) => {
      if (url.endsWith("/models/load")) {
        return Promise.resolve(Response.json({ success: true }));
      }
      if (url.endsWith("/models/unload")) {
        return Promise.resolve(Response.json({ status: "ok" }));
      }
      if (url.endsWith("/v1/models")) {
        return Promise.resolve(
          Response.json({ data: [{ id: "ornith", status: { value: "loaded" } }] }),
        );
      }
      // The chat completion call itself: artificially slow, and it actually
      // honours cancellation -- the real thing the fix has to reach in order
      // to matter, not just the number chatTimeoutMs computes.
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve(Response.json({ id: "r1", choices: [{ message: { content: "hi" } }] })),
          UPSTREAM_DELAY_MS,
        );
        init?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        });
      });
    };
    const lines: string[] = [];
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: client,
      write: (l) => lines.push(l),
    });

    const res = await door.fetch(
      chatRequest({ model: "chain-x", messages: [{ role: "user", content: "hi" }] }),
    );
    await res.text();

    expect(res.status).toBe(503);
    const record = JSON.parse(lines[0] ?? "{}") as { attempts: { failure?: string }[] };
    expect(record.attempts[0]?.failure).toBe("timeout");
  });
});

function llamaDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  writeEngineSpec(root, "local-llama", LOCAL_LLAMA_SPEC);
  const cfg = config({
    engines: [engine({ id: "local-llama", models_dir: "/data/gguf", models_max: 1 })],
    routes: [route({ engine: "local-llama", model: "ornith", filename: "x.gguf", role: "chat" })],
  });
  return { cfg, root };
}

/** Same shape as `llamaDoorConfig`, plus a comfy engine alongside it -- a second no-egress, models_dir engine with no `[[model]]` naming it. */
function llamaDoorConfigWithComfy(): { cfg: Config; root: string } {
  const { cfg, root } = llamaDoorConfig();
  writeEngineSpec(root, "comfy", COMFY_SPEC);
  return {
    cfg: {
      ...cfg,
      engines: [...cfg.engines, engine({ id: "comfy", models_dir: "/data/comfy" })],
    },
    root,
  };
}

describe("the door: content routing", () => {
  test("a chat against a resolvable llama model reaches the router and returns its body", async () => {
    const { cfg, root } = llamaDoorConfig();
    const recorded: { body: string }[] = [];
    const lines: string[] = [];
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write: (l) => lines.push(l),
    });
    const res = await door.fetch(
      chatRequest({ model: "@/local-llama/ornith", messages: [{ role: "user", content: "hi" }] }),
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
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write: () => undefined,
    });
    const res = await door.fetch(
      chatRequest({
        model: "@/local-llama/ornith",
        messages: [{ role: "user", content: "hi" }],
        workdir: "/should/not/reach/llama",
        reasoning_effort: "high",
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

/**
 * `/models/load` and `/models/unload` always succeed; `/openai/v1/models` reports whichever id last
 * loaded: "ornith" while `loadAndWait` is still polling, so the proxy can
 * proceed, and "ornith-real" once the chat has answered -- standing in for the
 * GGUF that actually served it, read fresh per attempt rather than copied from
 * what the chat response echoed. `undefined` means the url is the chat call
 * itself, for the caller to answer.
 */
function llamaLifecycleResponse(url: string, chatAnswered: boolean): Response | undefined {
  if (url.endsWith("/models/load")) {
    return Response.json({ success: true });
  }
  if (url.endsWith("/models/unload")) {
    return Response.json({ status: "ok" });
  }
  if (url.endsWith("/v1/models")) {
    const id = chatAnswered ? "ornith-real" : "ornith";
    return Response.json({ data: [{ id, status: { value: "loaded" } }] });
  }
}

function makeStaleReportedHttpClient(): HttpClient {
  let chatAnswered = false;
  return (url: string) => {
    const lifecycle = llamaLifecycleResponse(url, chatAnswered);
    if (lifecycle) {
      return Promise.resolve(lifecycle);
    }
    chatAnswered = true;
    // The engine echoes the router id it was given back in `model` -- the
    // INI section name, never the GGUF that actually answered.
    return Promise.resolve(
      Response.json({ id: "resp-1", model: "ornith", choices: [{ message: { content: "hi" } }] }),
    );
  };
}

/**
 * Mirrors `makeStaleReportedHttpClient`, but the chat call answers as a
 * chunked SSE stream instead of one JSON body -- each element of `chunks` is
 * enqueued as its own `ReadableStream` write, so a frame split across chunk
 * boundaries is exercised the same way a real upstream would split it.
 */
function makeStreamingReportedHttpClient(chunks: string[]): HttpClient {
  let chatAnswered = false;
  return (url: string) => {
    const lifecycle = llamaLifecycleResponse(url, chatAnswered);
    if (lifecycle) {
      return Promise.resolve(lifecycle);
    }
    chatAnswered = true;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(chunk));
        }
        controller.close();
      },
    });
    return Promise.resolve(
      new Response(stream, { headers: { "content-type": "text/event-stream" } }),
    );
  };
}

/** Two models on one role, same shape as the provenance fixture above, so `model_reported` and `model_resident` are guaranteed to differ. */
function streamingDoorConfig(): { cfg: Config; root: string } {
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  writeEngineSpec(root, "local-llama", LOCAL_LLAMA_SPEC);
  const cfg = config({
    engines: [engine({ id: "local-llama", models_dir: "/data/gguf", models_max: 1 })],
    routes: [
      route({ engine: "local-llama", model: "ornith", filename: "ornith.gguf", role: "chat" }),
      route({
        engine: "local-llama",
        model: "ornith-real",
        filename: "ornith-real.gguf",
        role: "chat",
      }),
    ],
  });
  return { cfg, root };
}

const STREAM_REQUEST_BODY = JSON.stringify({
  model: "@/local-llama/ornith",
  messages: [{ role: "user", content: "hi" }],
  stream: true,
});

/** A fresh `LlamaRouter`'s first streaming call always emits this ahead of the real bytes -- see `emitWarming` in llama.ts. Asserted here, not worked around, so the byte-identity check covers it too. */
const WARMING_COMMENT = ": warming\n\n";

/** Every streaming-provenance test sends the same request through a fresh llama door; only the upstream chunks, the door's `write` sink and the assertion differ. */
function fetchStreamChat(cfg: Config, root: string, doorOpts: DoorOptions): Promise<Response> {
  return Promise.resolve(
    createLlamaDoor(cfg, root, doorOpts).fetch(
      new Request("http://engined/openai/v1/chat/completions", {
        method: "POST",
        body: STREAM_REQUEST_BODY,
      }),
    ),
  );
}

describe("the door: streaming provenance", () => {
  test("a streaming llama hop records model_reported from the first SSE frame, and it differs from model_resident", async () => {
    const { cfg, root } = streamingDoorConfig();
    const lines: string[] = [];
    const chunks = [
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write: (l) => lines.push(l),
    });
    await res.text();
    assertReportedAndResident(lines, "ornith", "ornith-real");
  });

  test("the caller's stream is byte-identical to what the upstream sent, tee in place", async () => {
    const { cfg, root } = streamingDoorConfig();
    const chunks = [
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"id":"1","model":"ornith","choices":[{"delta":{"content":"lo"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write: () => undefined,
    });
    const body = await res.text();
    expect(body).toBe(WARMING_COMMENT + chunks.join(""));
  });

  test("a stream whose frames carry no model id leaves model_reported absent, and the response still completes", async () => {
    const { cfg, root } = streamingDoorConfig();
    const lines: string[] = [];
    const chunks = [
      'data: {"id":"1","choices":[{"delta":{"content":"Hi"}}]}\n\n',
      "data: [DONE]\n\n",
    ];
    const res = await fetchStreamChat(cfg, root, {
      llamaHttpClient: makeStreamingReportedHttpClient(chunks),
      write: (l) => lines.push(l),
    });
    const body = await res.text();
    expect(body).toBe(WARMING_COMMENT + chunks.join(""));
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as {
      attempts: { model_reported?: string }[];
    };
    expect(record.attempts[0]?.model_reported).toBeUndefined();
  });
});

describe("the door: provenance model fields", () => {
  test("a completed llama hop carries model_reported and model_resident, and they differ", async () => {
    const { cfg, root } = streamingDoorConfig();
    const lines: string[] = [];
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeStaleReportedHttpClient(),
      write: (l) => lines.push(l),
    });
    const res = await door.fetch(
      chatRequest({ model: "@/local-llama/ornith", messages: [{ role: "user", content: "hi" }] }),
    );
    // Draining the body is what completes the underlying stream and fires
    // the deferred provenance line, same as a real consumer reading it.
    await res.json();
    assertReportedAndResident(lines, "ornith", "ornith-real");
  });
});

describe("the door: agentic and chain routing", () => {
  // The 400-without-workdir shape itself is covered by two survivors:
  // agentic.test.ts's "runAgentic: workdir absent is 400 and never spawns"
  // (the function, including the never-spawns assertion) and
  // integration.test.ts's "an agentic attempt with no workdir returns 400"
  // (the same rejection through a real door).

  test("an unproved agentic engine does not spawn", async () => {
    const id = "claude-unproved";
    clearVerifiedVersion(id);
    const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
    writeEngineSpec(root, id, CLAUDE_SPEC);
    const cfg = config({
      routes: [route({ engine: id, model: "assistant", upstream: null })],
      engines: [engine({ id, agent_version: "9.9.9" })],
    });
    const spawnCalls: unknown[] = [];
    const fakeSpawn: AgenticSpawn = (argv, opts) => {
      spawnCalls.push({ argv, opts });
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"hi"}',
        stderr: "",
        exitCode: 0,
      });
    };
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX },
      { agenticSpawn: fakeSpawn, write: () => undefined },
    );
    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: "user", content: "hi" }],
        workdir: "/tmp",
      }),
    );
    // A lone-hop dispatch that fails now advances like any other unavailable
    // engine (finding 1), so it lands in runChain's own generic "every
    // engine in this chain failed" exhaustion body -- the same wrapping the
    // secret-resolution path's equivalent 503 already goes through. The
    // per-engine fix text (naming `id` and "9.9.9") still exists, just on
    // the `HopResult` before runChain gets it; see `execAgentic`'s proof-gate
    // branch and the "missing secret" test below for that assertion.
    expect(res.status).toBe(503);
    expect(spawnCalls).toHaveLength(0);
  });
});

describe("the door: chain skips an engine that fails its version proof", () => {
  /**
   * A chain skips an unavailable engine. An engine that
   * cannot prove its agent_version pin is exactly "unavailable" -- the
   * same 503 the secret-resolution path already produces (`resolveRedirect`,
   * plain 503, no `envelopeFailure`) and the chain advances past that one.
   * The version-proof 503 used to set `envelopeFailure: true`, which
   * `classifyResult` treats as never-advancing regardless of status --
   * terminal at the first hop instead of skipped.
   */
  test("a chain whose first hop fails its version proof advances to the second hop", async () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
    for (const id of ["claude-unproved", "claude-b"]) {
      writeEngineSpec(root, id, CLAUDE_SPEC);
    }
    clearVerifiedVersion("claude-unproved");
    clearVerifiedVersion("claude-b");
    const cfg = config({
      engines: [
        engine({ id: "claude-unproved", agent_version: "1.2.3" }),
        engine({ id: "claude-b", agent_version: "4.5.6" }),
      ],
      chains: { "chain-x": ["@/claude-unproved/x", "@/claude-b/y"] },
    });
    // Only claude-b's pin is provable -- claude-unproved's proof always
    // fails, the same as the standalone "unproved agentic engine" test above.
    const probeRunner: AgenticProbeRunner = (probedEngine) =>
      Promise.resolve(
        probedEngine.id === "claude-b" ? { ok: true } : { ok: false, failedProbe: "boom" },
      );
    const hopBCalls: string[][] = [];
    const spawn: AgenticSpawn = (argv) => {
      hopBCalls.push(argv);
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"hi"}',
        stderr: "",
        exitCode: 0,
      });
    };
    const lines: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: probeRunner },
      { agenticSpawn: spawn, write: (l) => lines.push(l) },
    );
    const res = await door.fetch(
      chatRequest({
        model: "chain-x",
        messages: [{ role: "user", content: "hi" }],
        workdir: "/tmp",
      }),
    );
    expect(res.status).toBe(200);
    expect(hopBCalls).toHaveLength(1);
    expect(hopBCalls[0]).toContain("@anthropic-ai/claude-code@4.5.6");
    const record = JSON.parse(lines[0] ?? "{}") as { engine_used: string };
    expect(record.engine_used).toBe("claude-b");
    clearVerifiedVersion("claude-unproved");
    clearVerifiedVersion("claude-b");
  });
});

describe("the door: an agentic hop's own timeout actually aborts it", () => {
  /**
   * agent_timeout_seconds is computed, threaded through runOneHop's per-hop
   * timeout, and then reached a spawn that never listened for it -- so a
   * hung `claude -p` held its chain slot forever regardless of the budget.
   * This spawn double never resolves on its own, only on `opts.signal`
   * firing -- exactly what the real `defaultAgenticSpawn` now does, and
   * exactly what exposes whether the signal actually reaches it: with the
   * old, unwired `execAgentic`/`buildHopExec`, `opts.signal` is undefined
   * here and this promise never settles, so the request hangs until bun's
   * own test timeout fails it rather than the door's short budget.
   */
  test("a hung agentic spawn is aborted by agent_timeout_seconds instead of holding its slot forever", async () => {
    const id = "claude-hangs";
    clearVerifiedVersion(id);
    const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
    writeEngineSpec(root, id, CLAUDE_SPEC);
    const workdir = mkdtempSync(join(TEST_ROOT, "engined-workdir-"));
    const cfg = config({
      routes: [route({ engine: id, model: "assistant", upstream: null })],
      // Well under bun's own per-test timeout, so a correct fix resolves
      // fast and a regression fails this test rather than hanging the suite.
      agent_timeout_seconds: 0.05,
      engines: [engine({ id, agent_version: "1.2.3" })],
    });
    const spawn: AgenticSpawn = (_argv, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const lines: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { agenticSpawn: spawn, write: (l) => lines.push(l) },
    );

    const res = await door.fetch(
      chatRequest({
        model: `@/${id}/assistant`,
        messages: [{ role: "user", content: "hi" }],
        workdir,
      }),
    );
    await res.text();

    expect(res.status).toBe(503);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { attempts: { failure?: string }[] };
    expect(record.attempts[0]?.failure).toBe("timeout");
    clearVerifiedVersion(id);
  });
});

describe("the door: chain routing", () => {
  test("a chain whose first hop's envelope fails is terminal there: the second hop's own spawn log stays empty", async () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
    for (const id of ["claude-a", "claude-b"]) {
      writeEngineSpec(root, id, CLAUDE_SPEC);
    }
    clearVerifiedVersion("claude-a");
    clearVerifiedVersion("claude-b");
    // Distinct pins so one shared spawn can tell the hops apart by argv and
    // keep a separate call log per hop -- the discriminating assertion is
    // against the next hop's own log, not the response status.
    const cfg = config({
      engines: [
        engine({ id: "claude-a", agent_version: "1.2.3" }),
        engine({ id: "claude-b", agent_version: "4.5.6" }),
      ],
      chains: { "chain-x": ["@/claude-a/x", "@/claude-b/y"] },
    });
    const hopACalls: string[][] = [];
    const hopBCalls: string[][] = [];
    // claude-a's stdout fails to parse -- a proven envelope failure, terminal
    // regardless of status, never a transport error a retry might route around.
    const spawn: AgenticSpawn = (argv) => {
      (argv.includes("@anthropic-ai/claude-code@1.2.3") ? hopACalls : hopBCalls).push(argv);
      return Promise.resolve({ stdout: "not json", stderr: "", exitCode: 0 });
    };
    const lines: string[] = [];
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { agenticSpawn: spawn, write: (l) => lines.push(l) },
    );
    const res = await door.fetch(
      chatRequest({
        model: "chain-x",
        messages: [{ role: "user", content: "hi" }],
        workdir: "/tmp",
      }),
    );
    expect(res.status).toBe(502);
    expect(hopACalls).toHaveLength(1);
    expect(hopBCalls).toHaveLength(0);
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as {
      engine_used: string;
      attempts: { engine: string; ok: boolean }[];
    };
    expect(record.engine_used).toBe("claude-a");
    expect(record.attempts).toHaveLength(1);
    expect(record.attempts[0]).toMatchObject({ engine: "claude-a", ok: false });
    clearVerifiedVersion("claude-a");
    clearVerifiedVersion("claude-b");
  });
});

const FAILOVER_DEAD_PORT = 46_001;
const FAILOVER_LIVE_PORT = 46_002;

/** One shared docker fake for two engines, distinguished by the container name docker.ts always passes. */
function twoEngineExec(): Exec {
  return (args) => {
    let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "image" && args[1] === "inspect") {
      result = inspectSinglePort(8080);
    } else if (args[0] === "port") {
      const name = args[1] ?? "";
      const hostPort = name.includes("dead") ? FAILOVER_DEAD_PORT : FAILOVER_LIVE_PORT;
      result = portResult(hostPort);
    } else if (args[0] === "inspect") {
      result = containerRunning();
    }
    return Promise.resolve(result);
  };
}

/** The "dead" upstream answers with `deadStatus`; the "live" one always succeeds. Each
 * records its own calls. `/models/load` and `/openai/v1/models` mirror the real b10354
 * contract, probed live: accept, then report "loaded" -- the ready signal
 * `loadAndWait` actually polls for. */
function makeSplitHttpClient(
  deadStatus: number,
  deadCalls: string[],
  liveCalls: string[],
): HttpClient {
  const control = llamaControlPlane();
  return (url: string, init?: RequestInit) => {
    const controlled = control(url, init);
    if (controlled) {
      return Promise.resolve(controlled);
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
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  for (const id of ["llama-dead", "llama-live"]) {
    writeEngineSpec(root, id, LOCAL_LLAMA_SPEC);
  }
  const cfg = config({
    engines: [
      engine({ id: "llama-dead", models_dir: "/data/dead", models_max: 1 }),
      engine({ id: "llama-live", models_dir: "/data/live", models_max: 1 }),
    ],
    routes: [
      route({ engine: "llama-dead", model: "dead-model", filename: "d.gguf", role: "chat" }),
      route({ engine: "llama-live", model: "live-model", filename: "l.gguf", role: "chat" }),
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
    const door = createLlamaDoor(
      cfg,
      root,
      {
        llamaHttpClient: makeSplitHttpClient(500, deadCalls, liveCalls),
        write: () => undefined,
      },
      twoEngineExec(),
    );
    const res = await door.fetch(
      chatRequest({
        model: "chain-failover",
        messages: [{ role: "user", content: "hi" }],
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
    const door = createLlamaDoor(
      cfg,
      root,
      {
        llamaHttpClient: makeSplitHttpClient(400, deadCalls, liveCalls),
        write: () => undefined,
      },
      twoEngineExec(),
    );
    const res = await door.fetch(
      chatRequest({
        model: "chain-failover",
        messages: [{ role: "user", content: "hi" }],
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
      routes: [
        ...cfg.routes,
        route({ engine: "local-llama", model: "vision-a", filename: "v.gguf", role: "vision" }),
      ],
    };
    const recorded: { body: string }[] = [];
    const extrasCalls: string[] = [];
    const extrasClient: HttpClient = (_url: string, init?: RequestInit) => {
      extrasCalls.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(Response.json({ ok: true }));
    };
    const door = createLlamaDoor(cfgWithVision, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      extrasHttpClient: extrasClient,
      write: () => undefined,
    });

    // Warm both roles: chat first, then vision *last* — a door-side "last
    // model proxied to this engine, any role" approximation would report
    // vision here, since it was the most recent call. Asking the router for
    // the chat role specifically must still report the chat model.
    await (
      await door.fetch(
        chatRequest({ model: "@/local-llama/ornith", messages: [{ role: "user", content: "hi" }] }),
      )
    ).text();
    await (
      await door.fetch(
        chatRequest({
          model: "@/local-llama/vision-a",
          messages: [{ role: "user", content: "hi" }],
        }),
      )
    ).text();

    await door.fetch(
      new Request("http://engined/engined/v1/engines/local-llama/tokenize", {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      }),
    );

    expect(extrasCalls).toHaveLength(1);
    const forwarded = JSON.parse(extrasCalls[0] ?? "{}") as { model?: string };
    expect(forwarded.model).toBe("ornith");
  });
});

describe("the door: extras address one named engine, and refuse any other", () => {
  /**
   * `:id` is a raw engine id, so a comfy-shaped engine carrying `models_dir`
   * alongside local-llama is no longer an ambiguity -- it is simply a
   * different id. What matters is that naming it is refused rather than
   * starting that container and posting a chat body into it.
   */
  test("tokenize against the named llama engine reaches it, and against a comfy-shaped engine 400s", async () => {
    const { cfg, root } = llamaDoorConfigWithComfy();
    const recorded: { body: string }[] = [];
    const extrasCalls: string[] = [];
    const extrasClient: HttpClient = (_url: string, init?: RequestInit) => {
      extrasCalls.push(typeof init?.body === "string" ? init.body : "");
      return Promise.resolve(Response.json({ tokens: [1, 2, 3] }));
    };
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient(recorded),
      extrasHttpClient: extrasClient,
      write: () => undefined,
    });

    const res = await door.fetch(
      new Request("http://engined/engined/v1/engines/local-llama/tokenize", {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(extrasCalls).toHaveLength(1);

    // Naming the comfy-shaped engine is refused before its container is touched.
    const wrong = await door.fetch(
      new Request("http://engined/engined/v1/engines/comfy/tokenize", {
        method: "POST",
        body: JSON.stringify({ content: "hello" }),
      }),
    );
    expect(wrong.status).toBe(400);
    expect(extrasCalls).toHaveLength(1);
  });
});

function fakeExec(value: string | undefined): Exec {
  return (args) => {
    if (args[0] === "lookup" && value !== undefined) {
      return Promise.resolve({ stdout: value, stderr: "", exitCode: 0 });
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
  };
}

/** Moonshot serves an Anthropic-shaped endpoint, so claude's own launch redirects to it unchanged -- only its upstream differs. */
function moonshotUpstream(): Upstream {
  return {
    id: "moonshot",
    base_url: "https://api.kimi.com/coding/",
    secret: { service: "moonshot-api", username: "kimi-k2.7-code", header: "x-api-key" },
    egress: "remote",
    wire: "anthropic",
  };
}

function claudeEngine(): EngineEntry {
  return engine({ id: "claude", agent_version: "1.2.3" });
}

/** claude's real shipped spec, since the moonshot redirect is a route naming a different upstream on the same real agentic engine -- not a second, spec-less one. */
function redirectDoorRoot(): string {
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  writeEngineSpec(root, "claude", CLAUDE_SPEC);
  return root;
}

/** What a faked claude spawn prints when its kimi-routed launch answers. */
const KIMI_ANSWER: ExecResult = {
  stdout: '{"is_error":false,"result":"answered via kimi"}',
  stderr: "",
  exitCode: 0,
};

/** An agentic chat request: one user message, launched in a scratch workdir. */
function scratchChatRequest(model: string, content = "hi"): Request {
  return chatRequest({ model, messages: [{ role: "user", content }], workdir: "/tmp/scratch" });
}

/** The chat request every kimi-routed test posts: the moonshot-routed claude model. */
function kimiChatRequest(content = "hi"): Request {
  return scratchChatRequest("@/claude/kimi-k3", content);
}

/** claude routed to moonshot for kimi-k3, plus whatever other routes a test needs. */
function kimiRoutedConfig(...extraRoutes: ReturnType<typeof route>[]): Config {
  return config({
    engines: [claudeEngine()],
    upstreams: [moonshotUpstream()],
    routes: [route({ engine: "claude", upstream: "moonshot", model: "kimi-k3" }), ...extraRoutes],
  });
}

/** A door over claude whose spawn is faked and whose secret lookup resolves to `secret` (or is left real when absent). */
function createClaudeDoor(cfg: Config, root: string, spawn: AgenticSpawn, secret?: string): Door {
  return createDoor(
    cfg,
    { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
    {
      agenticSpawn: spawn,
      ...(secret === undefined ? {} : { secretExec: fakeExec(secret) }),
      write: () => undefined,
    },
  );
}

/** A real door over claude, routed to moonshot for one model, its resolved secret and every spawned argv/env recorded rather than actually launched. */
function createKimiDoor(ambientSibling = false): {
  door: Door;
  spawnCalls: { argv: string[]; env: Record<string, string> }[];
} {
  const root = redirectDoorRoot();
  const cfg = config({
    engines: [claudeEngine()],
    upstreams: [moonshotUpstream()],
    routes: [
      route({ engine: "claude", upstream: "moonshot", model: "kimi-k3" }),
      ...(ambientSibling ? [route({ engine: "claude", upstream: null, model: "kimi-k3" })] : []),
    ],
  });
  const spawnCalls: { argv: string[]; env: Record<string, string> }[] = [];
  const spawn: AgenticSpawn = (spawnArgv, opts) => {
    spawnCalls.push({ argv: spawnArgv, env: opts.env });
    return Promise.resolve(KIMI_ANSWER);
  };
  const door = createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      agenticProbeRunner: PASSING_PROBE,
    },
    {
      agenticSpawn: spawn,
      secretExec: fakeExec("kimi-secret-value"),
      agenticAmbientEnv: { HOME: "/home/test", GITHUB_TOKEN: "ghp_leaked_repo_scope" },
      write: () => undefined,
    },
  );
  return { door, spawnCalls };
}

/** The stream-json lines a claude CLI prints for a two-chunk "pong". */
const STREAMED_PONG_LINES = [
  '{"type":"system","subtype":"init"}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"po"}}}',
  '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"ng"}}}',
  '{"type":"result","subtype":"success","is_error":false,"result":"pong"}',
];

/** A spawn that prints `lines` to stdout as it goes, recording each argv it was launched with. */
function streamingSpawn(lines: string[], argvSeen: string[][]): AgenticSpawn {
  return (spawnArgv, opts) => {
    argvSeen.push(spawnArgv);
    for (const line of lines) {
      opts.onStdout?.(`${line}\n`);
    }
    return Promise.resolve({ stdout: `${lines.join("\n")}\n`, stderr: "", exitCode: 0 });
  };
}

describe("the door: remote-agentic redirect streams as the CLI prints", () => {
  test("stream: true on an agentic hop is SSE chunks as the CLI prints them, launched in its streamed format", async () => {
    clearVerifiedVersion("claude");
    const argvSeen: string[][] = [];
    const door = createClaudeDoor(
      kimiRoutedConfig(),
      redirectDoorRoot(),
      streamingSpawn(STREAMED_PONG_LINES, argvSeen),
      "k",
    );
    const res = await door.fetch(
      chatRequest({
        model: "@/claude/kimi-k3",
        messages: [{ role: "user", content: "ping" }],
        workdir: "/tmp/scratch",
        stream: true,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const text = await res.text();
    const contents = [...text.matchAll(/"content":"([^"]*)"/g)].map((m) => m[1]);
    expect(contents).toEqual(["po", "ng"]);
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(argvSeen[0]).toContain("stream-json");
    expect(argvSeen[0]).toContain("--include-partial-messages");
    expect(argvSeen[0]).not.toContain("json");
  });
});

describe("the door: remote-agentic redirect (claude routed to a moonshot upstream)", () => {
  test("the upstream segment picks the route: beside an ambient route on the same model, the three-segment address still redirects and the two-segment one runs ambient with the model in its env", async () => {
    clearVerifiedVersion("claude");
    const { door, spawnCalls } = createKimiDoor(true);
    const messages = [{ role: "user", content: "hi" }];
    const workdir = "/tmp/scratch";

    const redirected = await door.fetch(
      chatRequest({ model: "@/claude/moonshot/kimi-k3", messages, workdir }),
    );
    expect(redirected.status).toBe(200);
    expect(spawnCalls[0]?.env.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");

    const ambient = await door.fetch(chatRequest({ model: "@/claude/kimi-k3", messages, workdir }));
    expect(ambient.status).toBe(200);
    const env = spawnCalls[1]?.env ?? {};
    expect("ANTHROPIC_BASE_URL" in env).toBe(false);
    expect("ANTHROPIC_API_KEY" in env).toBe(false);
    expect(env.ANTHROPIC_MODEL).toBe("kimi-k3");
  });

  test("redirect variables and the resolved key reach the child env; ambient GITHUB_TOKEN does not; the full floor survives; the secret never appears in argv", async () => {
    clearVerifiedVersion("claude");
    const { door, spawnCalls } = createKimiDoor();
    const res = await door.fetch(kimiChatRequest());
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
    // secret.header "x-api-key": the Bearer variable is never set.
    expect("ANTHROPIC_AUTH_TOKEN" in env).toBe(false);

    // The full floor is still present in argv, all three flags individually.
    expect(argv).toContain("--safe-mode");
    expect(argv).toContain("--strict-mcp-config");
    const toolsIdx = argv.indexOf("--tools");
    expect(toolsIdx).toBeGreaterThan(-1);
    expect(argv[toolsIdx + 1]).toBe("Read,Grep,Glob");

    // The resolved secret appears nowhere in argv.
    expect(argv.some((a) => a.includes("kimi-secret-value"))).toBe(false);
    clearVerifiedVersion("claude");
  });
});

/**
 * An Anthropic-compatible Bearer gateway (OpenRouter-shaped): `secret.header`
 * is `authorization`, not `x-api-key`. Carries `secret.scheme = "Bearer"`,
 * same as the real config -- the CLI itself prepends "Bearer" to whatever
 * ANTHROPIC_AUTH_TOKEN carries, so the redirect must hand it the raw value.
 */
function bearerGatewayUpstream(): Upstream {
  return {
    id: "openrouter",
    base_url: "https://openrouter.ai/api/v1",
    secret: {
      service: "openrouter-api",
      username: "claude-code",
      header: "authorization",
      scheme: "Bearer",
    },
    egress: "remote",
    wire: "anthropic",
  };
}

describe("the door: remote-agentic redirect (claude routed to a Bearer-gateway upstream)", () => {
  test('secret.header "authorization" sets ANTHROPIC_AUTH_TOKEN to the RAW value even though secret.scheme is "Bearer" -- the CLI prepends its own, so redirectEnv must not double it', async () => {
    clearVerifiedVersion("claude");
    const root = redirectDoorRoot();
    const cfg = config({
      engines: [claudeEngine()],
      upstreams: [bearerGatewayUpstream()],
      routes: [route({ engine: "claude", upstream: "openrouter", model: "sonnet-5" })],
    });
    const spawnCalls: { argv: string[]; env: Record<string, string> }[] = [];
    const spawn: AgenticSpawn = (spawnArgv, opts) => {
      spawnCalls.push({ argv: spawnArgv, env: opts.env });
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"answered via openrouter"}',
        stderr: "",
        exitCode: 0,
      });
    };
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      {
        agenticSpawn: spawn,
        secretExec: fakeExec("or-secret-value"),
        write: () => undefined,
      },
    );
    const res = await door.fetch(
      chatRequest({
        model: "@/claude/sonnet-5",
        messages: [{ role: "user", content: "hi" }],
        workdir: "/tmp/scratch",
      }),
    );
    expect(res.status).toBe(200);
    expect(spawnCalls).toHaveLength(1);
    const { env } = spawnCalls[0] ?? { env: {} as Record<string, string> };

    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("or-secret-value");
    // Present and empty, not absent: an unset ANTHROPIC_API_KEY leaves the
    // CLI defaulting to x-api-key, which 401s against a Bearer-only gateway.
    expect("ANTHROPIC_API_KEY" in env).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBe("");
    clearVerifiedVersion("claude");
  });
});

describe("the door: remote-agentic redirect, unproved pin never reaches a spawn", () => {
  test("no agenticProbeRunner configured: the request is refused 503 and the spawn count stays zero", async () => {
    clearVerifiedVersion("claude");
    const root = redirectDoorRoot();
    const cfg = config({
      engines: [claudeEngine()],
      upstreams: [moonshotUpstream()],
      routes: [route({ engine: "claude", upstream: "moonshot", model: "kimi-k3" })],
    });
    const spawnCalls: { argv: string[]; env: Record<string, string> }[] = [];
    const spawn: AgenticSpawn = (spawnArgv, opts) => {
      spawnCalls.push({ argv: spawnArgv, env: opts.env });
      return Promise.resolve({
        stdout: '{"is_error":false,"result":"should never run"}',
        stderr: "",
        exitCode: 0,
      });
    };
    // No `agenticProbeRunner` in registryOpts: the pin has never been proved
    // and nothing can prove it, so the gate must refuse rather than serve.
    const door = createDoor(
      cfg,
      {
        enginesRoot: root,
        bunx: BUNX,
      },
      {
        agenticSpawn: spawn,
        secretExec: fakeExec("kimi-secret-value"),
        write: () => undefined,
      },
    );
    const res = await door.fetch(
      chatRequest({
        model: "@/claude/kimi-k3",
        messages: [{ role: "user", content: "hi" }],
        workdir: "/tmp/scratch",
      }),
    );

    expect(res.status).toBe(503);
    expect(spawnCalls).toHaveLength(0);
    clearVerifiedVersion("claude");
  });
});

/** `resolveRedirect` for claude's kimi-k3 route onto `upstream`, with the secret lookup faked to `secret`. */
function redirectKimi(upstream: Upstream, cfg: Config, secret: string | undefined) {
  return resolveRedirect({
    upstream,
    engineId: "claude",
    modelSeg: "kimi-k3",
    config: cfg,
    doorUrl: TEST_DOOR_URL,
    secretExec: fakeExec(secret),
  });
}

describe("the door: remote-agentic redirect, missing secret", () => {
  test("a missing secret's HopResult carries the secret-tool store command", async () => {
    // Direct: runChain's own exhaustion wrapper replaces a lone hop's body
    // with a generic "every engine in this chain failed" once it classifies
    // a 5xx as advance-and-nothing-left-to-advance-to, so the fix text is
    // only observable on the HopResult resolveRedirect itself produces,
    // before runChain ever sees it. resolveRedirect takes the upstream
    // directly -- an engine has no address of its own to substitute onto.
    const redirect = await redirectKimi(moonshotUpstream(), config(), undefined);
    expect(redirect.ok).toBe(false);
    if (redirect.ok) {
      throw new Error("expected resolveRedirect to fail for a missing secret");
    }
    expect(redirect.result.status).toBe(503);
    const failBody = redirect.result.body as { error: string };
    expect(failBody.error).toContain("secret-tool store");
    expect(failBody.error).toContain("moonshot-api");
  });

  test("an upstream with a secret but no base_url refuses instead of redirecting nowhere", async () => {
    // Config requires a base_url alongside a secret but not the converse, so
    // this shape is legal and must not reach the child as an undefined
    // upstream.
    const addressless: Upstream = { ...moonshotUpstream(), base_url: undefined };
    const redirect = await redirectKimi(addressless, config(), "k");
    expect(redirect.ok).toBe(false);
    if (redirect.ok) {
      throw new Error("expected resolveRedirect to fail without a base_url");
    }
    expect(redirect.result.status).toBe(502);
    expect((redirect.result.body as { error: string }).error).toContain("no configured base_url");
  });

  test("a route's wire_model reaches ANTHROPIC_MODEL, not the address segment", async () => {
    const cfg = config({
      routes: [
        route({
          engine: "claude",
          model: "kimi-k3",
          wire_model: "moonshot/kimi-k3-0905",
          upstream: "moonshot",
        }),
      ],
    });
    const redirect = await redirectKimi(moonshotUpstream(), cfg, "k");
    expect(redirect.ok).toBe(true);
    if (!redirect.ok) {
      throw new Error("expected resolveRedirect to succeed");
    }
    expect(redirect.env.ANTHROPIC_MODEL).toBe("moonshot/kimi-k3-0905");
  });
});

describe("the door: remote-agentic redirect, missing secret does not take down other engines", () => {
  test("the local engine still serves, and the kimi attempt is reported as a clean 503", async () => {
    const root = redirectDoorRoot();
    writeEngineSpec(root, "local-llama", LOCAL_LLAMA_SPEC);
    const cfg = config({
      engines: [
        claudeEngine(),
        engine({ id: "local-llama", models_dir: "/data/gguf", models_max: 1 }),
      ],
      upstreams: [moonshotUpstream()],
      routes: [
        route({ engine: "claude", upstream: "moonshot", model: "kimi-k3" }),
        route({ engine: "local-llama", model: "ornith", filename: "x.gguf", role: "chat" }),
      ],
    });
    const recorded: { body: string }[] = [];
    const door = createLlamaDoor(cfg, root, {
      secretExec: fakeExec(undefined),
      llamaHttpClient: makeLlamaHttpClient(recorded),
      write: () => undefined,
    });

    const kimiRes = await door.fetch(
      chatRequest({
        model: "@/claude/kimi-k3",
        messages: [{ role: "user", content: "hi" }],
        workdir: "/tmp/scratch",
      }),
    );
    expect(kimiRes.status).toBe(503);

    const llamaRes = await door.fetch(
      chatRequest({ model: "@/local-llama/ornith", messages: [{ role: "user", content: "hi" }] }),
    );
    expect(llamaRes.status).toBe(200);
  });
});

/** `${doorUrl}/chat/completions`, the request a launched child's own OpenAI-compatible traffic would make. */
function scopedChatRequest(doorUrl: string, body: unknown): Request {
  return new Request(`${doorUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** The URL `redirectEnv` hands a child: the door on loopback, scoped by a 32-hex launch nonce. */
const RX_LAUNCH_SCOPED_DOOR_URL = /^http:\/\/127\.0\.0\.1:\d+\/openai\/v1\/[0-9a-f]{32}$/;

/** What a faked opencode spawn prints when it answers. */
const OPENCODE_ANSWER: ExecResult = {
  stdout: '{"type":"text","part":{"text":"hi"}}\n{"type":"step_finish"}',
  stderr: "",
  exitCode: 0,
};

/** An engines root carrying opencode's spec, and a config with its one local route. */
function opencodeDoorConfig(): { cfg: Config; root: string } {
  const root = redirectDoorRoot();
  writeEngineSpec(root, "opencode", OPENCODE_SPEC);
  const cfg = config({
    engines: [engine({ id: "opencode", agent_version: "1.0.0" })],
    routes: [route({ engine: "opencode", model: "code", upstream: "local" })],
  });
  return { cfg, root };
}

/** The door URL `renderOpencodeConfig` wrote into the rendered file at `path`. */
function renderedOpencodeBaseUrl(path: string): string {
  const rendered = JSON.parse(readFileSync(path, "utf8")) as {
    provider: { engined: { options: { baseURL: string } } };
  };
  return rendered.provider.engined.options.baseURL;
}

/**
 * `agent.configure` -- `renderOpencodeConfig` -- runs before `runAgentic`'s
 * own `bwrap` gate, so the rendered file carries the scoped URL whether or
 * not this box has a real `bwrap` at all. `ENGINED_BWRAP` is pointed at
 * `/bin/true`, present on every POSIX box, purely so the spawn (faked
 * regardless) is reached deterministically in CI. State lands in a fresh
 * `XDG_STATE_HOME` so no launch reads a file another test left behind.
 */
async function withOpencodeLaunchEnv(body: () => Promise<void>): Promise<void> {
  const previous = {
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    ENGINED_BWRAP: process.env.ENGINED_BWRAP,
  };
  process.env.XDG_STATE_HOME = mkdtempSync(join(TEST_ROOT, "engined-state-"));
  process.env.ENGINED_BWRAP = "/bin/true";
  try {
    await body();
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe("the launch-scoped door", () => {
  /**
   * claude routed at moonshot: `redirectEnv`'s own path, and the one that
   * needs no `bwrap` (claude's floor is argv, not the sandbox) -- so this
   * exercises the real `resolveRedirect` -> `redirectEnv` wiring end to end
   * with nothing faked but the spawn.
   */
  test("redirectEnv's own output carries the launch-scoped door URL, and a child POSTing back to it naming an agentic engine is refused", async () => {
    const cfg = kimiRoutedConfig(route({ engine: "claude", model: "sonnet-5", upstream: null }));
    let capturedEnv: Record<string, string> = {};
    // The nonce lives only until runAgentic returns, so the recursive call
    // naming another agentic engine has to be made FROM INSIDE the fake
    // spawn, while the launch it belongs to is still in flight -- exactly
    // where a real child's own traffic would originate.
    let recursive: { status: number; body: string } | undefined;
    const spawn: AgenticSpawn = async (_argv, opts) => {
      capturedEnv = opts.env;
      const doorUrl = opts.env.ENGINED_DOOR_URL ?? "";
      // The refusal is keyed on the RESOLVED engine, not the literal
      // string -- a one-segment address that resolves to claude is the
      // same attack as naming "claude" outright.
      const res = await door.fetch(
        scopedChatRequest(doorUrl, {
          model: "@/claude/sonnet-5",
          messages: [{ role: "user", content: "escape" }],
        }),
      );
      recursive = { status: res.status, body: await res.text() };
      return KIMI_ANSWER;
    };
    const door = createClaudeDoor(cfg, redirectDoorRoot(), spawn, "kimi-secret-value");
    clearVerifiedVersion("claude");
    const res = await door.fetch(kimiChatRequest());
    expect(res.status).toBe(200);

    // redirectEnv's own output: the launch-scoped URL, not the plain door.
    expect(capturedEnv.ENGINED_DOOR_URL).toMatch(RX_LAUNCH_SCOPED_DOOR_URL);
    // The redirect itself is untouched by the door URL's addition.
    expect(capturedEnv.ANTHROPIC_BASE_URL).toBe("https://api.kimi.com/coding/");

    expect(recursive?.status).toBe(403);
    expect(recursive?.body).toContain("agentic");
    clearVerifiedVersion("claude");
  });

  test("the same address, off the launch-scoped prefix, is an ordinary request -- refused only on the scoped URL", async () => {
    const cfg = config({
      engines: [claudeEngine()],
      routes: [route({ engine: "claude", model: "sonnet-5", upstream: null })],
    });
    const spawn: AgenticSpawn = () =>
      Promise.resolve({ ...KIMI_ANSWER, stdout: '{"is_error":false,"result":"answered"}' });
    const door = createClaudeDoor(cfg, redirectDoorRoot(), spawn);
    clearVerifiedVersion("claude");
    const res = await door.fetch(scratchChatRequest("@/claude/sonnet-5"));
    expect(res.status).toBe(200);
    clearVerifiedVersion("claude");
  });
});

/** claude routed to moonshot beside a local llama, so a launched child has a non-agentic engine to call back to. */
function kimiBesideLlamaConfig(root: string): Config {
  writeEngineSpec(root, "local-llama", LOCAL_LLAMA_SPEC);
  return config({
    engines: [
      claudeEngine(),
      engine({ id: "local-llama", models_dir: "/data/gguf", models_max: 1 }),
    ],
    upstreams: [moonshotUpstream()],
    routes: [
      route({ engine: "claude", upstream: "moonshot", model: "kimi-k3" }),
      route({ engine: "local-llama", model: "ornith", filename: "x.gguf", role: "chat" }),
    ],
  });
}

describe("the launch-scoped door: what a child may call back to", () => {
  test("a non-agentic engine's request is served on the launch-scoped URL, and still recorded", async () => {
    const root = redirectDoorRoot();
    const cfg = kimiBesideLlamaConfig(root);
    const recorded: { body: string }[] = [];
    const lines: string[] = [];
    // The nonce lives only until `runAgentic` returns, so the recursive,
    // non-agentic request has to be made FROM INSIDE the fake spawn, while
    // the launch it belongs to is still in flight.
    let innerStatus: number | undefined;
    const spawn: AgenticSpawn = async (_argv, opts) => {
      const doorUrl = opts.env.ENGINED_DOOR_URL ?? "";
      const inner = await door.fetch(
        scopedChatRequest(doorUrl, {
          model: "@/local-llama/ornith",
          messages: [{ role: "user", content: "from the sandbox" }],
        }),
      );
      innerStatus = inner.status;
      // The response body is a stream even for a buffered JSON reply
      // (readHopBody), and its provenance line is not emitted until the
      // stream is actually drained -- consume it or the line never lands.
      await inner.text();
      return KIMI_ANSWER;
    };
    const door = createDoor(
      cfg,
      {
        enginesRoot: root,
        bunx: BUNX,
        exec: llamaExec(),
        probe: READY_200,
        agenticProbeRunner: PASSING_PROBE,
      },
      {
        agenticSpawn: spawn,
        secretExec: fakeExec("kimi-secret-value"),
        llamaHttpClient: makeLlamaHttpClient(recorded),
        llamaPresetHostPath: tempPresetPath(TEST_ROOT),
        write: (l) => lines.push(l),
      },
    );
    clearVerifiedVersion("claude");
    const outer = await door.fetch(kimiChatRequest());
    expect(outer.status).toBe(200);
    // The inner, non-agentic request succeeded (200) from inside the launch.
    expect(innerStatus).toBe(200);
    // Still recorded: the launch-scoped local-llama call left its own
    // provenance line, egress-checked and accounted for like any other.
    expect(lines.some((l) => JSON.parse(l).attempts?.[0]?.engine === "local-llama")).toBe(true);
    clearVerifiedVersion("claude");
  });
});

describe("the launch-scoped door: a nonce outlives nothing", () => {
  test("a request on a retired nonce is refused, regardless of which engine it names", async () => {
    let capturedDoorUrl = "";
    const spawn: AgenticSpawn = (_argv, opts) => {
      capturedDoorUrl = opts.env.ENGINED_DOOR_URL ?? "";
      return Promise.resolve(KIMI_ANSWER);
    };
    const door = createClaudeDoor(
      kimiRoutedConfig(),
      redirectDoorRoot(),
      spawn,
      "kimi-secret-value",
    );
    clearVerifiedVersion("claude");
    const res = await door.fetch(kimiChatRequest());
    expect(res.status).toBe(200);

    // The launch this nonce belonged to has already finished by the time
    // door.fetch() above resolved -- so it is retired here, before this
    // second, unrelated request ever names an engine at all.
    const stale = await door.fetch(
      scopedChatRequest(capturedDoorUrl, {
        model: "@/claude/kimi-k3",
        messages: [{ role: "user", content: "too late" }],
        workdir: "/tmp/scratch",
      }),
    );
    expect(stale.status).toBe(403);
    expect(JSON.stringify(await stale.json())).toContain("expired");
    clearVerifiedVersion("claude");
  });
});

describe("the launch-scoped door: opencode's rendered config", () => {
  /**
   * The path itself is read from `OPENCODE_CONFIG` rather than a fixed
   * `stateDir()` filename -- `renderOpencodeConfig` `mkdtemp`s a fresh
   * directory per call, precisely so two launches in flight together never
   * share one file. The read happens from inside the fake spawn, before
   * `runAgentic`'s `finally` deletes it -- that deletion is asserted
   * separately, once `door.fetch` has returned.
   */
  test("renderOpencodeConfig's own rendered file carries the launch-scoped door URL, and is gone once the call ends", () =>
    withOpencodeLaunchEnv(async () => {
      const { cfg, root } = opencodeDoorConfig();
      let renderedPath = "";
      let capturedBaseUrl = "";
      const spawn: AgenticSpawn = (_argv, opts) => {
        renderedPath = opts.env.OPENCODE_CONFIG ?? "";
        capturedBaseUrl = renderedOpencodeBaseUrl(renderedPath);
        return Promise.resolve(OPENCODE_ANSWER);
      };
      const door = createClaudeDoor(cfg, root, spawn);
      clearVerifiedVersion("opencode");
      const res = await door.fetch(scratchChatRequest("@/opencode/code"));
      expect(res.status).toBe(200);
      expect(capturedBaseUrl).toMatch(RX_LAUNCH_SCOPED_DOOR_URL);
      // `runAgentic`'s `finally` already ran by the time `door.fetch` above
      // resolved: neither the file nor its `mkdtemp` directory survive it.
      expect(existsSync(renderedPath)).toBe(false);
      expect(existsSync(dirname(renderedPath))).toBe(false);
      clearVerifiedVersion("opencode");
    }));

  /**
   * Two opencode calls in flight together sharing one fixed `stateDir()`
   * path would be last-writer-wins: whichever spawn read the file after the
   * other launch's own write would run against a door URL never minted for
   * it. Both fake spawns here overlap on purpose (each awaits a beat before
   * reading its file) so that race window is actually exercised, not just
   * assumed closed.
   */
  test("two concurrent opencode launches never read each other's rendered config", () =>
    withOpencodeLaunchEnv(async () => {
      const { cfg, root } = opencodeDoorConfig();
      const paths: string[] = [];
      const baseUrls: string[] = [];
      const spawn: AgenticSpawn = async (_argv, opts) => {
        const path = opts.env.OPENCODE_CONFIG ?? "";
        paths.push(path);
        // Overlaps the other launch's own write-then-read window rather
        // than racing to read immediately, which would pass by luck alone.
        await new Promise((resolve) => setTimeout(resolve, 50));
        baseUrls.push(renderedOpencodeBaseUrl(path));
        return OPENCODE_ANSWER;
      };
      const door = createClaudeDoor(cfg, root, spawn);
      clearVerifiedVersion("opencode");
      const results = await Promise.all(
        [1, 2].map((n) => door.fetch(scratchChatRequest("@/opencode/code", `hi ${n}`))),
      );
      expect(results.map((res) => res.status)).toEqual([200, 200]);
      // Each launch minted its own nonce, so a fixed shared file would have
      // shown the same door URL read back for both -- whichever write lost
      // the race. Two distinct paths and two distinct URLs is the proof
      // neither launch ever read the other's file.
      expect(paths[0]).not.toBe(paths[1]);
      expect(baseUrls[0]).not.toBe(baseUrls[1]);
      expect(existsSync(paths[0] as string)).toBe(false);
      expect(existsSync(paths[1] as string)).toBe(false);
      clearVerifiedVersion("opencode");
    }));
});

describe("GET /openai/v1/models: an agentic engine's per-route state factors in that route's own upstream secret", () => {
  test("the ambient route reports installed; the route keyed to an upstream with no configured secret reports unavailable", async () => {
    clearVerifiedVersion("claude");
    const root = redirectDoorRoot();
    const cfg = config({
      engines: [claudeEngine()],
      upstreams: [moonshotUpstream()],
      routes: [
        route({ engine: "claude", model: "sonnet-5", upstream: null }),
        route({ engine: "claude", model: "k3", upstream: "moonshot" }),
      ],
    });
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, agenticProbeRunner: PASSING_PROBE },
      { secretExec: fakeExec(undefined), write: () => undefined },
    );
    const res = await door.fetch(new Request("http://engined/openai/v1/models"));
    const body = (await res.json()) as { data: { id: string; state: string }[] };
    const ambient = body.data.find((r) => r.id === "@/claude/sonnet-5");
    // Different models on the one engine (not sibling routes on the SAME
    // model), so each keeps the plain two-segment id -- modelRowId only
    // reaches for the three-segment form when two routes share a model.
    const keyed = body.data.find((r) => r.id === "@/claude/k3");

    // The one proof this engine's pin carries -- the read-only floor -- is
    // upstream-independent, so both routes start from the same base state.
    // Only the keyed route's OWN secret resolution can pull it down from
    // there; the ambient probe passing does not vouch for it.
    expect(ambient?.state).toBe("installed");
    expect(keyed?.state).toBe("unavailable");
    clearVerifiedVersion("claude");
  });
});

/** Mirrors engines/whisper's real shape: a real "-m <path>" pair for `withModelFile` to rewrite. */
const STT_SPEC = `
kind = "stt"
upstream = "self"
image = "engined/fakestt:local"
obtain = "build"
serves = ["/openai/v1/audio/transcriptions"]
command = ["--host", "0.0.0.0", "-m", "/models/default.bin"]

[ready]
path = "/health"
status = 200
`;

/** Tracks `run -d` and `stop` separately, so a test can assert a container start happened -- or did not -- without conflating it with a docker `start` reconcile. */
function sttExec(runLog: string[][], stopLog: string[][]): Exec {
  let port = 52_000;
  return (args) => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve(inspectSinglePort(8080));
    }
    if (argv[0] === "run" && argv[1] === "-d") {
      runLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "stop") {
      stopLog.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve(portResult(++port));
    }
    if (argv[0] === "inspect") {
      return Promise.resolve(containerRunning());
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
}

/** Every URL the llama router's own HTTP client was asked to hit, alongside the real load/unload/models control-plane replies -- `urls` is what proves a warm actually reached llama-server rather than merely returning without error. */
function makeRecordingLlamaClient(): { client: HttpClient; urls: string[] } {
  const control = llamaControlPlane();
  const urls: string[] = [];
  const client: HttpClient = (url, init) => {
    urls.push(url);
    const controlled = control(url, init);
    if (controlled) {
      return Promise.resolve(controlled);
    }
    return Promise.resolve(
      Response.json({ id: "resp-1", choices: [{ message: { content: "hi" } }] }),
    );
  };
  return { client, urls };
}

function startRequest(model: string): Request {
  return new Request("http://engined/engined/v1/start", {
    method: "POST",
    body: JSON.stringify({ model }),
  });
}

const WHISPER_SMALL_ROUTE = route({
  engine: "whisper-like",
  upstream: "local",
  model: "small",
  filename: "small.bin",
});

/** A fresh engines root carrying whisper's spec, and a config with its `small` route plus `extraRoutes`. */
function whisperDoorConfig(...extraRoutes: ReturnType<typeof route>[]): {
  cfg: Config;
  root: string;
} {
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  writeEngineSpec(root, "whisper-like", STT_SPEC);
  const cfg = config({
    engines: [engine({ id: "whisper-like", models_dir: "/data/whisper" })],
    routes: [WHISPER_SMALL_ROUTE, ...extraRoutes],
  });
  return { cfg, root };
}

/** llama and whisper side by side, chained llama-first, so a start on the chain has a second hop it must NOT warm. */
function llamaThenWhisperChainConfig(): { cfg: Config; root: string } {
  const { root } = llamaDoorConfig();
  writeEngineSpec(root, "whisper-like", STT_SPEC);
  const cfg = config({
    engines: [
      engine({ id: "local-llama", models_dir: "/data/gguf", models_max: 1 }),
      engine({ id: "whisper-like", models_dir: "/data/whisper" }),
    ],
    routes: [
      route({ engine: "local-llama", model: "ornith", filename: "x.gguf", role: "chat" }),
      WHISPER_SMALL_ROUTE,
    ],
    chains: { "chain-x": ["@/local-llama/ornith", "@/whisper-like/small"] },
  });
  return { cfg, root };
}

/**
 * `started` names the call that actually launched the engine, not merely
 * whether it ends up running: the second call against an already-warm route
 * finds `state: "running"` too, but must report `started: false` so a caller
 * can stop polling `/openai/v1/models` to tell a cold start from a warm one.
 */
async function startedFlagsAcrossTwoCalls(): Promise<{
  firstState: unknown;
  firstStarted: unknown;
  secondState: unknown;
  secondStarted: unknown;
}> {
  const { cfg, root } = llamaDoorConfig();
  const { client } = makeRecordingLlamaClient();
  const door = createLlamaDoor(cfg, root, { llamaHttpClient: client });

  const first = await door.fetch(startRequest("@/local-llama/ornith"));
  const firstBody = (await first.json()) as { data: Record<string, unknown>[] };
  const second = await door.fetch(startRequest("@/local-llama/ornith"));
  const secondBody = (await second.json()) as { data: Record<string, unknown>[] };
  return {
    firstState: firstBody.data[0]?.state,
    firstStarted: firstBody.data[0]?.started,
    secondState: secondBody.data[0]?.state,
    secondStarted: secondBody.data[0]?.started,
  };
}

describe("POST /engined/v1/start", () => {
  test("an engine id is not a place: the old per-engine route is a 404", async () => {
    const { cfg, root } = llamaDoorConfig();
    const door = createLlamaDoor(cfg, root);
    const res = await door.fetch(
      new Request("http://engined/engined/v1/engines/local-llama/start", { method: "POST" }),
    );
    expect(res.status).toBe(404);
  });

  test("a chain name warms only its first hop's local engine, with no url in the response", async () => {
    const { cfg, root } = llamaThenWhisperChainConfig();
    const { client, urls } = makeRecordingLlamaClient();
    const runLog: string[][] = [];
    const door = createLlamaDoor(cfg, root, { llamaHttpClient: client }, sttExec(runLog, []));
    const res = await door.fetch(startRequest("chain-x"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { object: string; data: Record<string, unknown>[] };
    expect(body.data).toHaveLength(1);
    const [row] = body.data;
    expect(row?.engine).toBe("local-llama");
    expect(row?.state).toBe("running");
    expect(row).not.toHaveProperty("private_url");
    expect(row).not.toHaveProperty("url");
    expect(urls.some((u) => u.endsWith("/models/load"))).toBe(true);
    // The chain's second hop is whisper -- fan-out is the first hop's local
    // route only, so its container must never have been started.
    expect(runLog.some((argv) => argv.some((a) => a.includes("whisper-like")))).toBe(false);
  });

  test("an address whose upstream is not local is a no-op that reports state, not an error", async () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
    const cfg = config({
      upstreams: [
        { id: "openrouter", egress: "remote", base_url: "https://openrouter.example/v1" },
      ],
      engines: [engine({ id: "hosted", kind: "openai-http" })],
      routes: [route({ engine: "hosted", model: "gpt-x", upstream: "openrouter" })],
    });
    const door = createLlamaDoor(cfg, root);
    const res = await door.fetch(startRequest("@/hosted/gpt-x"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    const [row] = body.data;
    expect(row?.upstream).toBe("openrouter");
    expect(String(row?.fix)).toContain("not local");
    expect(row).not.toHaveProperty("private_url");
  });
});

describe("POST /engined/v1/start: a roleless model on a container engine", () => {
  test("a roleless model on a container engine takes the stop-and-restart path, not the llama router", async () => {
    const { cfg, root } = whisperDoorConfig();
    const { client, urls } = makeRecordingLlamaClient();
    const runLog: string[][] = [];
    const door = createLlamaDoor(cfg, root, { llamaHttpClient: client }, sttExec(runLog, []));
    const res = await door.fetch(startRequest("@/whisper-like/small"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Record<string, unknown>[] };
    expect(body.data[0]?.state).toBe("running");
    expect(runLog).toHaveLength(1);
    const argv = runLog[0] as string[];
    expect(argv[argv.indexOf("-m") + 1]).toBe("/models/small.bin");
    // The llama router's own HTTP client is never touched by an stt start.
    expect(urls).toHaveLength(0);
  });

  test("held leases return 409 and do not restart", async () => {
    const { cfg, root } = whisperDoorConfig(
      route({ engine: "whisper-like", upstream: "local", model: "big", filename: "big.bin" }),
    );
    const runLog: string[][] = [];
    const stopLog: string[][] = [];
    const lifecycle = new DockerLifecycle(sttExec(runLog, stopLog), READY_200);
    const door = createDoor(
      cfg,
      { enginesRoot: root, bunx: BUNX, lifecycle },
      { llamaPresetHostPath: tempPresetPath(TEST_ROOT) },
    );

    const started = await door.fetch(startRequest("@/whisper-like/small"));
    expect(started.status).toBe(200);
    expect(runLog).toHaveLength(1);
    lifecycle.beginLease("whisper-like");

    const res = await door.fetch(startRequest("@/whisper-like/big"));
    expect(res.status).toBe(409);
    expect(runLog).toHaveLength(1);
    expect(stopLog).toHaveLength(0);
  });
});

describe("no response ever carries a container address", () => {
  // Grepping the raw JSON text, not typed field access: a field the wire
  // TYPE no longer declares would still typecheck clean even if some call
  // site smuggled it back in through a spread -- only the actual bytes on
  // the wire prove it is gone.
  test("GET /engined/v1/engines, with a running llama and a running comfy, mentions no private_url anywhere", async () => {
    const { cfg: base, root } = llamaDoorConfigWithComfy();
    const cfg: Config = {
      ...base,
      routes: [...base.routes, route({ engine: "comfy", model: undefined, upstream: "local" })],
    };
    const door = createLlamaDoor(cfg, root, {
      llamaHttpClient: makeLlamaHttpClient([]),
    });
    await door.fetch(startRequest("@/local-llama/ornith"));
    await door.fetch(startRequest("@/comfy/local"));

    const res = await door.fetch(new Request("http://engined/engined/v1/engines"));
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("private_url");
  });

  test("POST /engined/v1/start's own response never mentions private_url", async () => {
    const { cfg, root } = llamaDoorConfig();
    const door = createLlamaDoor(cfg, root, { llamaHttpClient: makeLlamaHttpClient([]) });
    const res = await door.fetch(startRequest("@/local-llama/ornith"));
    expect(await res.text()).not.toContain("private_url");
  });
});

/** Stands in for `globalThis.fetch`, keeping the JSON body of the last outgoing request; `restore` puts the real one back. */
function captureOutgoingBody(): {
  body: () => { model?: string } | undefined;
  restore: () => void;
} {
  const originalFetch = globalThis.fetch;
  let captured: { model?: string } | undefined;
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    captured =
      typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : undefined;
    return Promise.resolve(
      Response.json({ id: "resp-1", choices: [{ message: { content: "ok" } }] }),
    );
  }) as typeof fetch;
  return {
    body: () => captured,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** A hosted openai-http engine behind an openrouter upstream, serving `hostedRoute`. */
function openrouterHostedConfig(hostedRoute: ReturnType<typeof route>): Config {
  return config({
    upstreams: [
      {
        id: "openrouter",
        egress: "remote",
        base_url: "https://openrouter.example/api/v1",
        secret: { service: "s", username: "u", header: "authorization" },
      },
    ],
    engines: [engine({ id: "hosted", kind: "openai-http" })],
    routes: [hostedRoute],
  });
}

/** Posts one chat message for `model` to a door over `cfg`, with upstream `fetch` captured; resolves to the door's status and the model id that went out. */
async function outgoingModelFor(
  cfg: Config,
  model: string,
): Promise<{ status: number; sent: string | undefined }> {
  const root = mkdtempSync(join(TEST_ROOT, "engined-door-"));
  const outgoing = captureOutgoingBody();
  try {
    const door = createLlamaDoor(cfg, root, { secretExec: fakeExec("secret-value") });
    const res = await door.fetch(
      chatRequest({ model, messages: [{ role: "user", content: "hi" }] }),
    );
    return { status: res.status, sent: outgoing.body()?.model };
  } finally {
    outgoing.restore();
  }
}

describe("wire_model: the id sent upstream can differ from the address segment", () => {
  test("the remote openai-http proxy sends wire_model in the outgoing request body, not the address segment", async () => {
    const cfg = openrouterHostedConfig(
      route({
        engine: "hosted",
        model: "glm-5.2:free",
        wire_model: "z-ai/glm-5.2:free",
        upstream: "openrouter",
      }),
    );
    const { status, sent } = await outgoingModelFor(cfg, "@/hosted/glm-5.2:free");
    expect(status).toBe(200);
    // The config's own address segment must never leak onto the wire once
    // a wire_model is configured -- the config-read trap this exists to
    // catch is a test that asserts the route's `model` field and calls it
    // proof of what was actually sent.
    expect(sent).toBe("z-ai/glm-5.2:free");
    expect(sent).not.toBe("glm-5.2:free");
  });

  test("with no wire_model configured, the remote openai-http proxy still sends the address segment verbatim", async () => {
    const cfg = openrouterHostedConfig(
      route({ engine: "hosted", model: "sonnet-5", upstream: "openrouter" }),
    );
    expect(await outgoingModelFor(cfg, "@/hosted/sonnet-5")).toEqual({
      status: 200,
      sent: "sonnet-5",
    });
  });
});
