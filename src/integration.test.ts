/**
 * Cross-module acceptance: a real door (`createDoor`, called in-process — no
 * socket, so 29200 is never bound) over a real `EngineRegistry`, against
 * real `Bun.serve` fake upstreams standing in for engine containers. Each
 * fake upstream's own request log is what proves an engine was never
 * reached; a status code alone never is.
 */

import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Exec, ExecResult } from "./docker.ts";
import { createDoor } from "./main.ts";
import type { Config, EngineEntry } from "./types.ts";

/** Never 29200 — a real daemon may be installed on this box. This is only ever compared against a header, never bound. */
const TEST_LISTEN_PORT = 39_217;

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    listen_port: TEST_LISTEN_PORT,
    chat_timeout_seconds: 30,
    agent_timeout_seconds: 60,
    models: [],
    engines: [],
    chains: {},
    ...overrides,
  };
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
  const dir = mkdtempSync(join(tmpdir(), "engined-integration-"));
  writeFileSync(join(dir, "spec.toml"), toml);
  return dir;
}

/** LlamaRouter's default preset path is the real state dir; every test that reaches ensureStarted() redirects it here instead. */
function tempPresetPath(): string {
  return join(mkdtempSync(join(tmpdir(), "engined-preset-")), "preset.ini");
}

const OPENAI_SPEC = `
kind = "openai-http"
image = "test-openai:local"
obtain = "pull"
serves = ["/v1/chat/completions", "/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`;

const AGENTIC_SPEC = `
kind = "agentic-cli"
serves = ["/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@1.0.0", "-p"]
`;

const COMFY_SPEC = `
kind = "comfy"
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
    egress: "none",
    args: {},
    spec_dir: specDirFor(toml),
    models_dir: "/models-host",
    ...overrides,
  };
}

test("GET /v1/models is a menu: GGUF ids and aliases, chain names, agentic engine ids -- never comfy, never an unregistered model", async () => {
  const config = baseConfig({
    models: [{ id: "ornith", engine: "local", aliases: ["default-chat"], args: {} }],
    engines: [
      containerEngine("local", OPENAI_SPEC),
      containerEngine("claude", AGENTIC_SPEC, { egress: "remote" }),
      containerEngine("comfy", COMFY_SPEC),
    ],
    chains: { "chain-x": ["@/local/ornith"] },
  });
  const door = createDoor(config, { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx" });

  try {
    const res = await door.fetch(req("GET", "/v1/models"));
    const body = (await res.json()) as string[];

    expect(new Set(body)).toEqual(new Set(["ornith", "default-chat", "claude", "chain-x"]));
    expect(body).not.toContain("comfy");
    expect(body).not.toContain("vision");
    expect(body).not.toContain("embed");
  } finally {
    await door.registry.shutdown();
  }
});

test("GET /v1/engines carries top-level contract and commit", async () => {
  const config = baseConfig({ engines: [containerEngine("local", OPENAI_SPEC)] });
  const exec: Exec = async () => ({ stdout: "", stderr: "", exitCode: 1 });
  const door = createDoor(config, {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
    exec,
  });

  try {
    const res = await door.fetch(req("GET", "/v1/engines"));
    const body = (await res.json()) as { contract: unknown; commit: unknown };

    expect(typeof body.contract).toBe("number");
    expect(typeof body.commit).toBe("string");
  } finally {
    await door.registry.shutdown();
  }
});

test("GET /v1/engines answers 200 even when every engine is unavailable", async () => {
  const config = baseConfig({ engines: [containerEngine("local", OPENAI_SPEC)] });
  // Every "image inspect" fails: no image ever resolves on this box.
  const exec: Exec = async (): Promise<ExecResult> => ({ stdout: "", stderr: "", exitCode: 1 });
  const door = createDoor(config, {
    enginesRoot: "/nonexistent/engines",
    bunx: "/opt/test/bunx",
    exec,
  });

  try {
    const res = await door.fetch(req("GET", "/v1/engines"));
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
    const foreign = await door.fetch(req("GET", "/v1/models", { origin: "https://evil.example" }));
    expect(foreign.status).toBe(403);

    const nullOrigin = await door.fetch(req("GET", "/v1/models", { origin: "null" }));
    expect(nullOrigin.status).toBe(403);

    const badHost = await door.fetch(req("GET", "/v1/models", { host: "evil.example" }));
    expect(badHost.status).toBe(403);

    const clean = await door.fetch(req("GET", "/v1/models"));
    expect(clean.status).toBe(200);
  } finally {
    await door.registry.shutdown();
  }
});

// --- POST /v1/chat/completions, actually proxied: chain failover,
// local_only truncation, chain exhaustion, and the agentic workdir rule.

const SINGLE_PORT_INSPECT = JSON.stringify([{ Config: { ExposedPorts: { "80/tcp": {} } } }]);

function openaiSpec(image = "test-openai:local"): string {
  return `
kind = "openai-http"
image = "${image}"
obtain = "pull"
serves = ["/v1/chat/completions", "/v1/embeddings"]
command = []

[ready]
path = "/health"
status = 200
`;
}

/** A port nothing listens on: bind an ephemeral one and close it immediately. */
function deadPort(): number {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const { port } = probe;
  probe.stop(true);
  if (port === undefined) {
    throw new Error("Bun.serve did not report a port");
  }
  return port;
}

/** A real `Bun.serve` fake engine; `requestLog` is the only thing that proves it was never reached. */
function startFakeUpstream(fetchImpl: (req: Request) => Response | Promise<Response>): {
  base: string;
  requestLog: string[];
  stop: () => void;
} {
  const requestLog: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      requestLog.push(new URL(request.url).pathname);
      return fetchImpl(request);
    },
  });
  return { base: `127.0.0.1:${server.port}`, requestLog, stop: () => server.stop(true) };
}

interface BuildExecOptions {
  missingImages?: Set<string>;
  portByContainer?: Record<string, number>;
  runLog?: string[][];
}

function execImageInspect(argv: string[], opts: BuildExecOptions): ExecResult {
  const [, , image] = argv;
  if (image !== undefined && opts.missingImages?.has(image)) {
    return { stdout: "", stderr: "", exitCode: 1 };
  }
  return { stdout: SINGLE_PORT_INSPECT, stderr: "", exitCode: 0 };
}

function execPort(argv: string[], opts: BuildExecOptions): ExecResult {
  const [, containerName] = argv;
  const port = containerName === undefined ? undefined : opts.portByContainer?.[containerName];
  return port === undefined
    ? { stdout: "", stderr: "", exitCode: 1 }
    : { stdout: `127.0.0.1:${port}`, stderr: "", exitCode: 0 };
}

/** One `Exec` shared by every container-spec engine in a test: dispatches on the image tag and the container name. */
function buildExec(opts: BuildExecOptions): Exec {
  return (args): Promise<ExecResult> => {
    const argv = [...args];
    if (argv[0] === "image" && argv[1] === "inspect") {
      return Promise.resolve(execImageInspect(argv, opts));
    }
    if (argv[0] === "start") {
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 1 });
    }
    if (argv[0] === "run" && argv[1] === "-d") {
      opts.runLog?.push(argv);
      return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
    }
    if (argv[0] === "port") {
      return Promise.resolve(execPort(argv, opts));
    }
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  };
}

test("a chain whose first hop is dead completes on the second, and provenance names the second engine", async () => {
  const good = startFakeUpstream((request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/health") {
      return new Response("", { status: 200 });
    }
    // LlamaRouter.loadAndWait polls /models/load until it sees "loaded" --
    // with no deadline of its own, any other shape here loops forever.
    if (pathname === "/models/load" || pathname === "/models/unload") {
      return Response.json({ status: "loaded" });
    }
    return Response.json({ choices: [{ message: { content: "answered by good" } }] });
  });
  const [, goodPort] = good.base.split(":");
  const dead = deadPort();

  const exec = buildExec({
    portByContainer: { "engined-dead": dead, "engined-good": Number(goodPort) },
  });
  const config = baseConfig({
    models: [
      { id: "m", engine: "dead", role: "chat", aliases: [], args: {} },
      { id: "m", engine: "good", role: "chat", aliases: [], args: {} },
    ],
    engines: [
      // Short readiness timeout: nothing listens on `dead`, so the poll
      // must give up fast rather than spend the 60s default finding out.
      containerEngine("dead", openaiSpec(), { ready_timeout_s: 0.1 }),
      containerEngine("good", openaiSpec()),
    ],
    chains: { "chain-x": ["@/dead/m", "@/good/m"] },
  });
  const lines: string[] = [];
  const door = createDoor(
    config,
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx", exec },
    { write: (line) => lines.push(line), llamaPresetHostPath: tempPresetPath() },
  );

  try {
    const res = await door.fetch(
      req("POST", "/v1/chat/completions", {
        body: { model: "chain-x", messages: [{ role: "user", content: "hi" }] },
      }),
    );
    const body = await res.text();

    expect(res.status).toBe(200);
    expect(body).toContain("answered by good");

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] ?? "{}") as { engine_used: string };
    expect(record.engine_used).toBe("good");
  } finally {
    good.stop();
    await door.registry.shutdown();
  }
});

test("local_only: true against a public chain never reaches a remote hop, even when the local hop cannot serve", async () => {
  const remote = startFakeUpstream(() => Response.json({ ok: true }));
  const MISSING_LOCAL_IMAGE = "local-image-that-does-not-resolve:local";

  const exec = buildExec({ missingImages: new Set([MISSING_LOCAL_IMAGE]) });
  const config = baseConfig({
    models: [
      { id: "m", engine: "local", role: "chat", aliases: [], args: {} },
      { id: "m", engine: "remote", role: "chat", aliases: [], args: {} },
    ],
    engines: [
      containerEngine("local", openaiSpec(MISSING_LOCAL_IMAGE)),
      containerEngine("remote", openaiSpec(), { egress: "remote" }),
    ],
    chains: { "chain-public": ["@/local/m", "@/remote/m"] },
  });
  const door = createDoor(
    config,
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx", exec },
    { llamaPresetHostPath: tempPresetPath() },
  );

  try {
    const res = await door.fetch(
      req("POST", "/v1/chat/completions", {
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
  } finally {
    remote.stop();
    await door.registry.shutdown();
  }
});

test("every engine in a chain unavailable returns 503 listing each attempt", async () => {
  const exec = buildExec({ missingImages: new Set(["missing-e1:local", "missing-e2:local"]) });
  const config = baseConfig({
    models: [
      { id: "m", engine: "e1", role: "chat", aliases: [], args: {} },
      { id: "m", engine: "e2", role: "chat", aliases: [], args: {} },
    ],
    engines: [
      containerEngine("e1", openaiSpec("missing-e1:local")),
      containerEngine("e2", openaiSpec("missing-e2:local")),
    ],
    chains: { "chain-z": ["@/e1/m", "@/e2/m"] },
  });
  const door = createDoor(
    config,
    { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx", exec },
    { llamaPresetHostPath: tempPresetPath() },
  );

  try {
    const res = await door.fetch(
      req("POST", "/v1/chat/completions", {
        body: { model: "chain-z", messages: [{ role: "user", content: "hi" }] },
      }),
    );
    const body = (await res.json()) as { attempts: unknown[] };

    expect(res.status).toBe(503);
    expect(body.attempts).toHaveLength(2);
  } finally {
    await door.registry.shutdown();
  }
});

test("an agentic attempt with no workdir returns 400", async () => {
  const config = baseConfig({
    // claude_version drives buildArgv directly (not the loaded spec's own
    // command array, which agentic.ts never reads) -- required for
    // execAgentic to reach the workdir check at all.
    engines: [
      containerEngine("claude", AGENTIC_SPEC, { egress: "remote", claude_version: "1.0.0" }),
    ],
  });
  const door = createDoor(config, { enginesRoot: "/nonexistent/engines", bunx: "/opt/test/bunx" });

  try {
    const res = await door.fetch(
      req("POST", "/v1/chat/completions", {
        body: { model: "claude", messages: [{ role: "user", content: "hi" }] },
      }),
    );

    expect(res.status).toBe(400);
    // "and the chain does not advance": this request is a bare engine id, not
    // a chain hop, so there is nothing here to advance to. Revisit once an
    // agentic hop's @/<engine>/<model> form inside a chain is settled -- it
    // needs a [[model]] row for the agentic engine (filename/role absent) to
    // be addressable that way at all.
  } finally {
    await door.registry.shutdown();
  }
});
