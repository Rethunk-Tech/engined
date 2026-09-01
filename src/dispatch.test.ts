import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { resolveModel } from "./dispatch.ts";
import { EngineRegistry } from "./engines.ts";
import { BUNX, config, engine, makeTestRoot, route, writeEngineSpec } from "./test-support.ts";
import type { Config, EngineEntry } from "./types.ts";

const CHAT = "/openai/v1/chat/completions";
const SPEECH = "/openai/v1/audio/speech";

const TEST_ROOT = makeTestRoot("engined-dispatch-test-");

/**
 * A spec-less, model-bearing engine that serves chat. Stands in wherever a
 * test needs "some engine with a route on it" and does not care which kind
 * -- `openai-http` because, unlike `agentic-cli`, a spec-less engine of this
 * kind has a real built-in spec (an agentic-cli one has no built-in launch
 * to fall back to and refuses at registry construction).
 */
function remoteOpenaiHttp(id: string): EngineEntry {
  return engine({
    id,
    egress: "remote",
    kind: "openai-http",
    base_url: `https://example.com/${id}`,
    secret: { service: id, username: "u", header: "x-api-key" },
  });
}

function remoteTts(id: string): EngineEntry {
  return engine({
    id,
    egress: "remote",
    kind: "tts",
    base_url: `https://example.com/${id}`,
    secret: { service: id, username: "u", header: "x-api-key" },
  });
}

/** No engine in these fixtures is a container, so no docker exec is ever invoked. */
function registry(cfg: Config, enginesRoot = "/nonexistent"): EngineRegistry {
  return new EngineRegistry(cfg, { enginesRoot, bunx: BUNX });
}

describe("disabled engines", () => {
  // Config parse drops a disabled engine's [[model]] rows and chain hops, so
  // the reachable route is a fully-qualified request naming it directly --
  // which resolves, and then must be refused as disabled rather than as
  // missing.
  test("a qualified request onto one is refused as disabled, not as nonexistent", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("engineA"), { ...remoteOpenaiHttp("off"), disabled: true }],
      routes: [route({ engine: "engineA", model: "m" }), route({ engine: "off", model: "gone" })],
    });
    const result = resolveModel("@/off/gone", CHAT, cfg, registry(cfg));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('engine "off" is disabled');
  });

  test("its models are gone, so a qualified request must not read as a missing model", () => {
    const cfg = config({
      engines: [{ ...remoteOpenaiHttp("off"), disabled: true }],
      models: [],
    });
    const result = resolveModel("@/off/whatever", CHAT, cfg, registry(cfg));
    expect(result.ok === false && result.error).toContain('engine "off" is disabled');
  });

  test("a bare model-less engine id is refused the same way", () => {
    const cfg = config({ engines: [{ ...remoteTts("voice"), disabled: true }] });
    const result = resolveModel("voice", SPEECH, cfg, registry(cfg));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('engine "voice" is disabled');
  });
});

describe("bare model ambiguity", () => {
  test("two engines serving the same bare id: 400 listing the qualified forms", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("engineA"), remoteOpenaiHttp("engineB")],
      routes: [
        route({ engine: "engineA", model: "shared" }),
        route({ engine: "engineB", model: "shared" }),
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
      engines: [remoteOpenaiHttp("engineA"), remoteOpenaiHttp("engineB")],
      routes: [
        route({ engine: "engineA", model: "shared" }),
        route({ engine: "engineB", model: "shared" }),
      ],
    });
    const reg = registry(cfg);
    const result = resolveModel("@/engineA/shared", CHAT, cfg, reg);
    expect(result).toEqual({ ok: true, kind: "model", engine: "engineA", model: "shared" });
  });

  test("a lone match resolves bare, no qualification needed", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("solo")],
      routes: [route({ engine: "solo", model: "only", aliases: ["nickname"] })],
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
  const cfg = config({ engines: [remoteOpenaiHttp("claude")] });
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

const AGENTIC_SPEC = `
kind = "agentic-cli"
upstream = "optional"
agent = "claude"
serves = ["${CHAT}"]
command = ["{bunx}", "@anthropic-ai/claude-code@{agent_version}", "-p"]
`;

describe("engine-id bare selector", () => {
  // A spec-less agentic-cli engine has no built-in launch and refuses at
  // registry construction, so this is the one fixture in this file needing
  // a real spec on disk rather than a `kind` in config.
  test("an agentic-cli engine resolves with no model", () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-dispatch-"));
    writeEngineSpec(root, "claude", AGENTIC_SPEC);
    const cfg = config({ engines: [engine({ id: "claude", agent_version: "1.0.0" })] });
    const reg = registry(cfg, root);
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

  test("a tts engine id bare resolves with no model: the audio door has no model concept", () => {
    const cfg = config({ engines: [remoteTts("chatterbox")] });
    const reg = registry(cfg);
    expect(resolveModel("chatterbox", SPEECH, cfg, reg)).toEqual({
      ok: true,
      kind: "engine",
      engine: "chatterbox",
    });
  });
});

describe("endpoint mismatch", () => {
  test("a chat-only engine's model posted to a different endpoint is 400", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("claude")],
      routes: [route({ engine: "claude", model: "sonnet" })],
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
      engines: [remoteOpenaiHttp("claude")],
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
upstream = "self"
image = "ghcr.io/example/llama@sha256:aaaa"
obtain = "pull"
serves = ["${CHAT}"]
command = ["--model", "x"]

[ready]
path = "/health"
status = 200
`;

  test("resolves to the sole no-egress, models_dir engine", () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-dispatch-"));
    writeEngineSpec(root, "local-llama", CONTAINER_SPEC);
    const cfg = config({
      engines: [engine({ id: "local-llama", egress: "none", models_dir: "/models" })],
      routes: [
        route({ engine: "local-llama", model: "ornith", filename: "ornith.gguf", role: "chat" }),
      ],
    });
    const reg = registry(cfg, root);
    expect(resolveModel("@/local/ornith", CHAT, cfg, reg)).toEqual({
      ok: true,
      kind: "model",
      engine: "local-llama",
      model: "ornith",
    });
  });

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

  /**
   * The worked config shape: comfy carries a `models_dir` for its
   * own bind mount, egress "none", and no model-bearing route -- the exact
   * config `models_dir !== undefined` (dispatch.ts's old rule) treats as a
   * second "local" candidate, making resolution ambiguous even though only
   * one engine actually hosts a model.
   */
  test("a comfy-shaped engine that also carries models_dir does not shadow the real local candidate", () => {
    const root = mkdtempSync(join(TEST_ROOT, "engined-dispatch-"));
    writeEngineSpec(root, "local-llama", CONTAINER_SPEC);
    writeEngineSpec(root, "comfy", COMFY_SPEC);
    const cfg = config({
      engines: [
        engine({ id: "local-llama", egress: "none", models_dir: "/models" }),
        engine({ id: "comfy", egress: "none", models_dir: "/models-comfy" }),
      ],
      routes: [
        route({ engine: "local-llama", model: "ornith", filename: "ornith.gguf", role: "chat" }),
      ],
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
