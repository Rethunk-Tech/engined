import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerLifecycle, type Exec, type ExecResult } from "./docker.ts";
import { EngineRegistry, type RegistryOptions } from "./engines.ts";
import type { Config, EngineEntry, ModelEntry } from "./types.ts";

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

/** `exitCode: 0` for every call: the tests that only need a registry to exist. */
function okExec(): Promise<ExecResult> {
  return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
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
