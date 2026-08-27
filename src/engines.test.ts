import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRunArgs, DockerLifecycle, type Exec, type ExecResult, type Probe } from "./docker.ts";
import { EngineRegistry, type QueueSnapshot, type RegistryOptions } from "./engines.ts";
import { loadSpec } from "./spec.ts";
import { type Config, type EngineEntry, isContainerSpec, type ModelEntry } from "./types.ts";

const BUNX = "/home/x/.bun/bin/bunx";

/** A fresh `<root>/<id>/spec.toml`, root usable as `enginesRoot`. Reuses one root across ids. */
function writeSpec(root: string, id: string, content: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.toml"), content);
}

function newEnginesRoot(): string {
  return mkdtempSync(join(tmpdir(), "engined-engines-"));
}

const PULLED_CONTAINER = `
kind = "openai-http"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["/v1/chat/completions"]
command = ["--model", "x"]

[ready]
path = "/health"
status = 200
`;

const BUILT_CONTAINER = `
kind = "tts"
image = "engined/kokoro:local"
obtain = "build"
serves = ["/v1/audio/speech"]
command = ["--serve"]

[ready]
path = "/health"
status = 200

[[artifact]]
path = "/models/kokoro.bin"
obtain = "docker run --rm -v engined-kokoro-models:/models curlimages/curl -fL -o /models/kokoro.bin https://example.com/kokoro.bin"
`;

const AGENTIC = `
kind = "agentic-cli"
serves = ["/v1/chat/completions"]
command = ["{bunx}", "@anthropic-ai/claude-code@{claude_version}", "-p"]
`;

const COMFY_CONTAINER = `
kind = "comfy"
image = "engined/comfy:local"
obtain = "build"
serves = []
command = ["--serve"]

[ready]
path = "/queue"
status = 200
`;

function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return { id: "e", egress: "none", args: {}, ...overrides };
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

/** Image present with one exposed port, no artifacts to fail: the tests that only need a registry to exist. */
function okExec(args: readonly string[]): Promise<ExecResult> {
  const result: ExecResult =
    args[0] === "image" && args[1] === "inspect"
      ? { stdout: '[{"Config":{"ExposedPorts":{"8000/tcp":{}}}}]', stderr: "", exitCode: 0 }
      : { stdout: "", stderr: "", exitCode: 0 };
  return Promise.resolve(result);
}

/** `docker image inspect` fails for everything, as it does with nothing pulled. */
function noImageExec(args: readonly string[]): Promise<ExecResult> {
  const result: ExecResult =
    args[0] === "image" && args[1] === "inspect"
      ? { stdout: "", stderr: "no such image", exitCode: 1 }
      : { stdout: "", stderr: "", exitCode: 0 };
  return Promise.resolve(result);
}

/** Image present, port exposed, but the one declared artifact is missing. */
function missingArtifactExec(args: readonly string[]): Promise<ExecResult> {
  let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
  if (args[0] === "image" && args[1] === "inspect") {
    result = { stdout: '[{"Config":{"ExposedPorts":{"8000/tcp":{}}}}]', stderr: "", exitCode: 0 };
  } else if (args[0] === "run") {
    result = { stdout: "", stderr: "", exitCode: 1 };
  }
  return Promise.resolve(result);
}

const OK_EXEC: Exec = okExec;
const NO_IMAGE_EXEC: Exec = noImageExec;
const MISSING_ARTIFACT_EXEC: Exec = missingArtifactExec;

function registry(
  cfg: Config,
  enginesRoot: string,
  extra: Partial<RegistryOptions> = {},
): EngineRegistry {
  return new EngineRegistry(cfg, { enginesRoot, bunx: BUNX, exec: OK_EXEC, ...extra });
}

describe("unavailable engines", () => {
  test("missing image is unavailable and names the pull command for a digest-pinned image", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root, {
      exec: NO_IMAGE_EXEC,
    });
    // get() is the sync accessor and does not probe docker cold; list() does.
    expect(reg.get("llama")?.state).toBe("installed");
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toBe("docker pull ghcr.io/example/llama@sha256:aaaa");
  });

  test("missing image names the build command for a locally-built image", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "kokoro", BUILT_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "kokoro" })] }), root, {
      exec: NO_IMAGE_EXEC,
    });
    const listed = (await reg.list()).engines.find((e) => e.id === "kokoro");
    expect(listed?.state).toBe("unavailable");
    expect(listed?.fix).toBe("docker build engined/kokoro:local");
  });

  test("missing artifact is unavailable and names the command that supplies it, via start()", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "kokoro", BUILT_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "kokoro" })] }), root, {
      exec: MISSING_ARTIFACT_EXEC,
    });
    const status = await reg.start("kokoro");
    expect(status.state).toBe("unavailable");
    expect(status.fix).toContain("curlimages/curl");
  });
});

describe("installed engines", () => {
  test("an engine merely stopped is installed with a null private_url, never reported as broken", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root);
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.state).toBe("installed");
    expect(listed?.private_url).toBeNull();
    expect(listed?.fix).toBeUndefined();
  });

  test("private_url is null before any start, from both get() and list()", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "llama", PULLED_CONTAINER);
    const lifecycle = new DockerLifecycle(OK_EXEC);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root, { lifecycle });
    expect(reg.get("llama")?.private_url).toBeNull();
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.private_url).toBeNull();
  });

  test("vram is absent, not zero, when it cannot be read", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root);
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.vram).toBeUndefined();
    expect(Object.hasOwn(listed ?? {}, "vram")).toBe(false);
    expect(listed?.disk).toBeUndefined();
  });
});

describe("remote-address engines", () => {
  const remoteEngine = engine({
    id: "claude-kimi",
    egress: "remote",
    base_url: "https://api.kimi.com/coding/",
    secret: { service: "moonshot-api", username: "kimi-k2.7-code", header: "x-api-key" },
  });

  test("installed when the secret resolves", () => {
    const reg = registry(config({ engines: [remoteEngine] }), newEnginesRoot(), {
      secretResolves: () => true,
    });
    expect(reg.get("claude-kimi")?.state).toBe("installed");
    expect(reg.get("claude-kimi")?.private_url).toBeNull();
  });

  test("unavailable naming the secret-tool store command when it does not", () => {
    const reg = registry(config({ engines: [remoteEngine] }), newEnginesRoot(), {
      secretResolves: () => false,
    });
    const status = reg.get("claude-kimi");
    expect(status?.state).toBe("unavailable");
    expect(status?.fix).toBe("secret-tool store moonshot-api kimi-k2.7-code");
  });
});

describe("GET /v1/models", () => {
  test("includes chain names, registered GGUF ids and aliases, and agentic engine ids; excludes comfy", () => {
    const root = newEnginesRoot();
    writeSpec(root, "claude", AGENTIC);
    writeSpec(root, "comfy", COMFY_CONTAINER);
    const cfg = config({
      engines: [
        engine({ id: "claude", egress: "remote", claude_version: "1.2.3" }),
        engine({ id: "comfy" }),
      ],
      models: [model({ id: "ornith", engine: "claude", aliases: ["bird"] })],
      chains: { "chain-private": ["@/local/ornith"] },
    });
    const reg = registry(cfg, root);
    const names = reg.models();
    expect(names).toContain("ornith");
    expect(names).toContain("bird");
    expect(names).toContain("claude");
    expect(names).toContain("chain-private");
    expect(names).not.toContain("comfy");
  });
});

describe("serves()", () => {
  test("returns the loaded spec's serves list for a container engine", () => {
    const root = newEnginesRoot();
    writeSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root);
    expect(reg.serves("llama")).toEqual(["/v1/chat/completions"]);
  });

  test("falls back to the kind-serves table for a remote-address engine with no spec", () => {
    const remoteEngine = engine({
      id: "claude-kimi",
      egress: "remote",
      kind: "agentic-cli",
      base_url: "https://api.kimi.com/coding/",
      secret: { service: "moonshot-api", username: "kimi-k2.7-code", header: "x-api-key" },
    });
    const reg = registry(config({ engines: [remoteEngine] }), newEnginesRoot());
    expect(reg.serves("claude-kimi")).toEqual(["/v1/chat/completions"]);
  });

  test("unknown id serves nothing rather than throwing", () => {
    const reg = registry(config({ engines: [] }), newEnginesRoot());
    expect(reg.serves("nope")).toEqual([]);
  });
});

describe("spec_source", () => {
  test("names the shipped directory when no spec_dir override is set", async () => {
    const root = newEnginesRoot();
    writeSpec(root, "llama", PULLED_CONTAINER);
    const reg = registry(config({ engines: [engine({ id: "llama" })] }), root);
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.spec_source).toBe(join(root, "llama"));
  });

  test("names the override directory when spec_dir wins", async () => {
    const root = newEnginesRoot();
    const overrideRoot = mkdtempSync(join(tmpdir(), "engined-override-"));
    writeFileSync(join(overrideRoot, "spec.toml"), PULLED_CONTAINER);
    const reg = registry(
      config({ engines: [engine({ id: "llama", spec_dir: overrideRoot })] }),
      root,
    );
    const listed = (await reg.list()).engines.find((e) => e.id === "llama");
    expect(listed?.spec_source).toBe(overrideRoot);
  });
});

const REPO_ENGINES_ROOT = join(import.meta.dir, "..", "engines");

describe("comfy: shipped spec", () => {
  test("the run argv takes GPU_FLAGS, label=disable and latent2rgb, and publishes to no wildcard interface", () => {
    const loaded = loadSpec(engine({ id: "comfy" }), {
      enginesRoot: REPO_ENGINES_ROOT,
      bunx: BUNX,
    });
    const { spec } = loaded;
    if (!isContainerSpec(spec)) {
      throw new Error("engines/comfy/spec.toml must be a container spec");
    }
    const argv = buildRunArgs("engined-comfy", spec, 8188);
    expect(argv).toContain("--preview-method");
    expect(argv).toContain("latent2rgb");
    expect(argv).toContain("/dev/kfd");
    expect(argv).toContain("/dev/dri");
    expect(argv).toContain("label=disable");
    expect(argv).not.toContain("-P");
    expect(argv.some((a) => a.startsWith("0.0.0.0::"))).toBe(false);
  });
});

/** Image present at container port 8188 (comfy's EXPOSE), a fresh host port on every "port" lookup. */
function comfyExec(): Exec {
  let port = 40_000;
  return (args) => {
    let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "image" && args[1] === "inspect") {
      result = { stdout: '[{"Config":{"ExposedPorts":{"8188/tcp":{}}}}]', stderr: "", exitCode: 0 };
    } else if (args[0] === "port") {
      port += 1;
      result = { stdout: `127.0.0.1:${port}\n`, stderr: "", exitCode: 0 };
    }
    return Promise.resolve(result);
  };
}

const READY_PROBE: Probe = () => Promise.resolve({ status: 200 });

const EMPTY_QUEUE: QueueSnapshot = { queue_running: [], queue_pending: [] };
const BUSY_QUEUE: QueueSnapshot = { queue_running: [{ id: "job-1" }], queue_pending: [] };

function comfyConfig(): Config {
  return config({
    engines: [engine({ id: "comfy", egress: "none", idle_stop_seconds: 0.05, ready_timeout_s: 5 })],
  });
}

describe("comfy: idle timer driven by /queue polling", () => {
  test("an empty queue advances the idle timer to a real stop", async () => {
    const lifecycle = new DockerLifecycle(comfyExec(), READY_PROBE);
    const reg = new EngineRegistry(comfyConfig(), {
      enginesRoot: REPO_ENGINES_ROOT,
      bunx: BUNX,
      lifecycle,
      queueFetch: () => Promise.resolve(EMPTY_QUEUE),
      comfyPollIntervalMs: 15,
    });
    try {
      const started = await reg.start("comfy");
      expect(started.state).toBe("running");
      expect(started.private_url).not.toBeNull();

      await new Promise((resolve) => setTimeout(resolve, 300));

      const after = reg.get("comfy");
      expect(after?.state).toBe("installed");
      expect(after?.private_url).toBeNull();
    } finally {
      await reg.shutdown();
    }
  });

  test("a non-empty queue never lets the idle timer fire", async () => {
    const lifecycle = new DockerLifecycle(comfyExec(), READY_PROBE);
    const reg = new EngineRegistry(comfyConfig(), {
      enginesRoot: REPO_ENGINES_ROOT,
      bunx: BUNX,
      lifecycle,
      queueFetch: () => Promise.resolve(BUSY_QUEUE),
      comfyPollIntervalMs: 15,
    });
    try {
      const started = await reg.start("comfy");
      expect(started.state).toBe("running");

      await new Promise((resolve) => setTimeout(resolve, 300));

      const after = reg.get("comfy");
      expect(after?.state).toBe("running");
      expect(after?.private_url).not.toBeNull();
    } finally {
      await reg.shutdown();
    }
  });
});

describe("comfy: resolved URL outlives its container by exactly nothing", () => {
  test("two successive starts yield two different private_url values", async () => {
    const lifecycle = new DockerLifecycle(comfyExec(), READY_PROBE);
    const reg = new EngineRegistry(comfyConfig(), {
      enginesRoot: REPO_ENGINES_ROOT,
      bunx: BUNX,
      lifecycle,
      queueFetch: () => Promise.resolve(EMPTY_QUEUE),
      comfyPollIntervalMs: 60_000,
    });
    try {
      const first = await reg.start("comfy");
      await lifecycle.removeEngine("comfy");
      const second = await reg.start("comfy");

      expect(first.private_url).not.toBeNull();
      expect(second.private_url).not.toBeNull();
      expect(second.private_url).not.toBe(first.private_url);
    } finally {
      await reg.shutdown();
    }
  });
});

/** Image present at `containerPort`, a fresh host port per "port" lookup, capturing every "run" argv. */
function capturingExec(containerPort: number, runArgvCalls: string[][]): Exec {
  let port = 50_000;
  return (args) => {
    const argv = [...args];
    let result: ExecResult = { stdout: "", stderr: "", exitCode: 0 };
    if (args[0] === "image" && args[1] === "inspect") {
      result = {
        stdout: `[{"Config":{"ExposedPorts":{"${containerPort}/tcp":{}}}}]`,
        stderr: "",
        exitCode: 0,
      };
    } else if (args[0] === "start") {
      result = { stdout: "", stderr: "", exitCode: 1 }; // never already created: fall through to "run"
    } else if (args[0] === "run") {
      runArgvCalls.push(argv);
      result = { stdout: "", stderr: "", exitCode: 0 };
    } else if (args[0] === "port") {
      port += 1;
      result = { stdout: `127.0.0.1:${port}\n`, stderr: "", exitCode: 0 };
    }
    return Promise.resolve(result);
  };
}

const READY_200: Probe = () => Promise.resolve({ status: 200 });

describe("spec construction is routed through the per-engine builder", () => {
  test("comfy started through the registry carries its models bind mount in the run argv", async () => {
    const runArgvCalls: string[][] = [];
    const reg = new EngineRegistry(
      config({
        engines: [
          engine({
            id: "comfy",
            egress: "none",
            models_dir: "/data/comfy-models",
            ready_timeout_s: 5,
          }),
        ],
      }),
      {
        enginesRoot: REPO_ENGINES_ROOT,
        bunx: BUNX,
        lifecycle: new DockerLifecycle(capturingExec(8188, runArgvCalls), READY_200),
      },
    );
    try {
      await reg.start("comfy");
      expect(runArgvCalls).toHaveLength(1);
      const [argv] = runArgvCalls;
      expect(argv).toContain("-v");
      expect(argv?.some((a) => a === "/data/comfy-models:/opt/comfyui/models")).toBe(true);
    } finally {
      await reg.shutdown();
    }
  });

  test("local-llama started through the registry carries --models-preset and its :ro mounts", async () => {
    const runArgvCalls: string[][] = [];
    const reg = new EngineRegistry(
      config({
        engines: [
          engine({
            id: "local-llama",
            egress: "none",
            models_dir: "/data/gguf",
            models_max: 3,
            ready_timeout_s: 5,
          }),
        ],
      }),
      {
        enginesRoot: REPO_ENGINES_ROOT,
        bunx: BUNX,
        lifecycle: new DockerLifecycle(capturingExec(8080, runArgvCalls), READY_200),
      },
    );
    try {
      await reg.start("local-llama");
      expect(runArgvCalls).toHaveLength(1);
      const [argv] = runArgvCalls;
      expect(argv).toContain("--models-preset");
      expect(argv?.some((a) => a === "/data/gguf:/models:ro")).toBe(true);
      expect(argv?.some((a) => a.includes("local-llama/preset.ini:/preset.ini:ro"))).toBe(true);
    } finally {
      await reg.shutdown();
    }
  });
});
