import { describe, expect, test } from "bun:test";
import { resolveModel } from "./dispatch.ts";
import { EngineRegistry } from "./engines.ts";
import { BUNX, config, ENGINES_ROOT, engine, route } from "./test-support.ts";
import type { Config, EngineEntry, Role } from "./types.ts";
import {
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  routeForHop,
  routeServes,
} from "./types.ts";

const CHAT = "/openai/v1/chat/completions";
const SPEECH = "/openai/v1/audio/speech";
const TRANSCRIPTIONS = "/openai/v1/audio/transcriptions";
const EMBEDDINGS = "/openai/v1/embeddings";
const RERANK = "/openai/v1/rerank";

/**
 * A spec-less, model-bearing engine that serves chat. Stands in wherever a
 * test needs "some engine with a route on it" and does not care which kind
 * -- `openai-http` because, unlike `agentic-cli`, a spec-less engine of this
 * kind has a real built-in spec (an agentic-cli one has no built-in launch
 * to fall back to and refuses at registry construction).
 */
function remoteOpenaiHttp(id: string): EngineEntry {
  return engine({ id, kind: "openai-http" });
}

function remoteTts(id: string): EngineEntry {
  return engine({ id, kind: "tts" });
}

/** No engine in these fixtures is a container, so no docker exec is ever invoked. */
function registry(cfg: Config, enginesRoot = "/nonexistent"): EngineRegistry {
  return new EngineRegistry(cfg, { enginesRoot, bunx: BUNX });
}

describe("disabled engines", () => {
  // Config parse drops a disabled engine's routes and chain hops, so the
  // reachable route is a fully-qualified request naming it directly --
  // which resolves, and then must be refused as disabled rather than missing.
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
    });
    const result = resolveModel("@/off/whatever", CHAT, cfg, registry(cfg));
    expect(result.ok === false && result.error).toContain('engine "off" is disabled');
  });

  test("a disabled modelless engine is refused the same way", () => {
    const cfg = config({
      engines: [{ ...remoteTts("voice"), disabled: true }],
      routes: [route({ engine: "voice", model: undefined, upstream: "local" })],
    });
    const result = resolveModel("@/voice/local", SPEECH, cfg, registry(cfg));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('engine "voice" is disabled');
  });
});

describe("bare (unqualified) addressing is gone", () => {
  test("two engines serving the same model, bare, is 400 -- there is no bare form left", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("engineA"), remoteOpenaiHttp("engineB")],
      routes: [
        route({ engine: "engineA", model: "shared" }),
        route({ engine: "engineB", model: "shared" }),
      ],
    });
    const reg = registry(cfg);
    expect(resolveModel("shared", CHAT, cfg, reg).ok).toBe(false);
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
    expect(resolveModel("@/engineA/shared", CHAT, cfg, reg)).toEqual(
      modelResolution("engineA", "shared", "local"),
    );
  });

  test("a lone match does not resolve bare -- only through @/ or the one-segment form", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("solo")],
      routes: [route({ engine: "solo", model: "only" })],
    });
    const reg = registry(cfg);
    expect(resolveModel("only", CHAT, cfg, reg).ok).toBe(false);
    expect(resolveModel("@/only", CHAT, cfg, reg)).toEqual(
      modelResolution("solo", "only", "local"),
    );
    expect(resolveModel("@/solo/only", CHAT, cfg, reg)).toEqual(
      modelResolution("solo", "only", "local"),
    );
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

  test("a bare unrecognised string is 400", () => {
    const result = resolveModel("nonexistent-thing", CHAT, cfg, reg);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("nonexistent-thing");
  });

  test("a bare engine id is 400: the door takes no unqualified engine selector", () => {
    expect(resolveModel("claude", CHAT, cfg, reg).ok).toBe(false);
  });
});

describe("modelless engine addressing", () => {
  function modelless(id: string): Config {
    return config({
      engines: [remoteTts(id)],
      routes: [route({ engine: id, model: undefined, upstream: "local" })],
    });
  }

  test("its two-segment engine+upstream form resolves", () => {
    const cfg = modelless("chatterbox-multi");
    expect(resolveModel("@/chatterbox-multi/local", SPEECH, cfg, registry(cfg))).toEqual(
      modelResolution("chatterbox-multi", undefined, "local"),
    );
  });

  test("it has no one-segment form", () => {
    const cfg = modelless("chatterbox-multi");
    expect(resolveModel("chatterbox-multi", SPEECH, cfg, registry(cfg)).ok).toBe(false);
    expect(resolveModel("@/chatterbox-multi", SPEECH, cfg, registry(cfg)).ok).toBe(false);
  });

  test("a third segment is refused: there is no model to name", () => {
    const cfg = modelless("chatterbox-multi");
    const result = resolveModel("@/chatterbox-multi/local/x", SPEECH, cfg, registry(cfg));
    expect(result.ok).toBe(false);
  });

  test("a model-bearing engine's bare id is 400: it cannot answer without a model", () => {
    const cfg = config({ engines: [remoteOpenaiHttp("gguf-host")] });
    expect(resolveModel("gguf-host", CHAT, cfg, registry(cfg)).ok).toBe(false);
  });

  test("comfy's serves names no OpenAI endpoint: its route resolves but no content endpoint accepts it", () => {
    const cfg = config({
      engines: [engine({ id: "comfy" })],
      routes: [route({ engine: "comfy", model: undefined, upstream: "local" })],
    });
    const reg = registry(cfg, ENGINES_ROOT);
    // The route itself is found (a different failure than "no such route"
    // below would report), and only the endpoint gate refuses it -- comfy's
    // real `serves` is its own mediated proxy paths, none of them this
    // door's OpenAI-shaped chat endpoint.
    const result = resolveModel("@/comfy/local", CHAT, cfg, reg);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("does not serve");
  });

  test("@/comfy/local/x is refused: comfy has no model to name", () => {
    const cfg = config({
      engines: [engine({ id: "comfy" })],
      routes: [route({ engine: "comfy", model: undefined, upstream: "local" })],
    });
    const reg = registry(cfg, ENGINES_ROOT);
    const result = resolveModel("@/comfy/local/x", CHAT, cfg, reg);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).not.toContain("does not serve");
  });
});

/** The successful `resolveModel` reading for a model route. */
function modelResolution(engineId: string, model: string | undefined, upstream: string) {
  const fields =
    model === undefined ? { engine: engineId, upstream } : { engine: engineId, model, upstream };
  return { ok: true as const, kind: "model" as const, route: expect.objectContaining(fields) };
}

/** "ornith" served by both `engineA` and `engineB`, with no upstream to tell them apart. */
function ornithOnTwoEnginesConfig(): Config {
  return config({
    engines: [remoteOpenaiHttp("engineA"), remoteOpenaiHttp("engineB")],
    routes: [
      route({ engine: "engineA", model: "ornith" }),
      route({ engine: "engineB", model: "ornith" }),
    ],
  });
}

/** claude with an ambient sonnet route and a moonshot-routed k3 route. */
function claudeOnMoonshotConfig(): Config {
  return config({
    engines: [remoteOpenaiHttp("claude")],
    routes: [
      route({ engine: "claude", model: "sonnet-5", upstream: null }),
      route({ engine: "claude", model: "k3", upstream: "moonshot" }),
    ],
  });
}

/** "ornith" on a remote-egress `far` and a no-egress `near`, so a one-segment address must pick `near`. */
function farAndNearConfig(near: EngineEntry): Config {
  return config({
    engines: [remoteOpenaiHttp("far"), near],
    upstreams: [
      { id: "far-up", egress: "remote" },
      { id: "near-up", egress: "none" },
    ],
    routes: [
      route({ engine: "far", model: "ornith", upstream: "far-up" }),
      route({ engine: "near", model: "ornith", upstream: "near-up" }),
    ],
  });
}

/** One engine, one model id, two remote upstreams: the two-segment form cannot pick. */
function cursorOnTwoUpstreamsConfig(): Config {
  return config({
    engines: [remoteOpenaiHttp("cursor")],
    upstreams: [
      { id: "openrouter", egress: "remote" },
      { id: "anthropic", egress: "remote" },
    ],
    routes: [
      route({ engine: "cursor", model: "sonnet-5", upstream: "openrouter" }),
      route({ engine: "cursor", model: "sonnet-5", upstream: "anthropic" }),
    ],
  });
}

describe("segment count decides the reading", () => {
  test("a fully-explicit three-segment address resolves", () => {
    const cfg = claudeOnMoonshotConfig();
    expect(resolveModel("@/claude/moonshot/k3", CHAT, cfg, registry(cfg))).toEqual(
      modelResolution("claude", "k3", "moonshot"),
    );
  });

  test("the same model id on two engines resolves both ways", () => {
    const cfg = ornithOnTwoEnginesConfig();
    const reg = registry(cfg);
    const a = resolveModel("@/engineA/ornith", CHAT, cfg, reg);
    const b = resolveModel("@/engineB/ornith", CHAT, cfg, reg);
    expect(a.ok && a.kind === "model" && a.route.engine).toBe("engineA");
    expect(b.ok && b.kind === "model" && b.route.engine).toBe("engineB");
  });

  test("a one-segment address picks the lowest-egress route: local, then lan, then remote, then declaration order", () => {
    const cfg = farAndNearConfig(remoteOpenaiHttp("near"));
    expect(resolveModel("@/ornith", CHAT, cfg, registry(cfg))).toEqual(
      modelResolution("near", "ornith", "near-up"),
    );
  });

  test("a one-segment address resolves to exactly one route and does not walk on failure", () => {
    // "near" is the lowest-egress candidate but does not serve chat -- the
    // resolver commits to it and reports the endpoint mismatch rather than
    // falling through to "far", which does serve it.
    const cfg = farAndNearConfig(remoteTts("near"));
    const result = resolveModel("@/ornith", CHAT, cfg, registry(cfg));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain("does not serve");
  });

  test("a two-segment address ambiguous across upstreams demands the three-segment form", () => {
    const cfg = cursorOnTwoUpstreamsConfig();
    const reg = registry(cfg);
    const ambiguous = resolveModel("@/cursor/sonnet-5", CHAT, cfg, reg);
    expect(ambiguous.ok).toBe(false);
    expect(!ambiguous.ok && ambiguous.error).toContain("ambiguous");
    expect(resolveModel("@/cursor/openrouter/sonnet-5", CHAT, cfg, reg)).toEqual(
      modelResolution("cursor", "sonnet-5", "openrouter"),
    );
  });

  test("a hop naming a model that exists only on a different engine does not resolve", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("engineA"), remoteOpenaiHttp("engineB")],
      routes: [route({ engine: "engineA", model: "ornith" })],
    });
    const result = resolveModel("@/engineB/ornith", CHAT, cfg, registry(cfg));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toContain('"ornith"');
  });
});

describe("endpoint mismatch", () => {
  test("a chat-only engine's model posted to a different endpoint is 400", () => {
    const cfg = config({
      engines: [remoteOpenaiHttp("claude")],
      routes: [route({ engine: "claude", model: "sonnet" })],
    });
    const reg = registry(cfg);
    const result = resolveModel("@/claude/sonnet", SPEECH, cfg, reg);
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

  test("a chain resolves for speech and transcription, the endpoints fallback means something on", () => {
    const cfg = config({ chains: { "chain-private": ["@/claude/sonnet"] } });
    const reg = registry(cfg);
    expect(resolveModel("chain-private", SPEECH, cfg, reg).ok).toBe(true);
    expect(resolveModel("chain-private", TRANSCRIPTIONS, cfg, reg).ok).toBe(true);
  });

  test("a chain posted to embeddings is 400: a second engine's vector is not the first's", () => {
    const cfg = config({ chains: { "chain-private": ["@/claude/sonnet"] } });
    const reg = registry(cfg);
    expect(resolveModel("chain-private", EMBEDDINGS, cfg, reg).ok).toBe(false);
  });

  test("a chain posted to rerank is 400: nothing sends this verb through a fallback list", () => {
    const cfg = config({ chains: { "chain-private": ["@/claude/sonnet"] } });
    const reg = registry(cfg);
    expect(resolveModel("chain-private", RERANK, cfg, reg).ok).toBe(false);
  });
});

/**
 * A role that claims a door path answers it and nothing else, and every role
 * that claims none answers everything unclaimed. The pairs below are the
 * whole property: each claiming role refuses the other's path as well as
 * chat, which a two-way embedding-vs-everything split could not express.
 */
describe("a role's claimed endpoint", () => {
  const CLAIMED: readonly [Role, string][] = [
    ["embedding", EMBEDDINGS],
    ["rerank", RERANK],
  ];

  function withRole(role: Role): { cfg: Config; reg: EngineRegistry } {
    const cfg = config({
      engines: [remoteOpenaiHttp("e")],
      routes: [route({ engine: "e", model: "m", role })],
    });
    return { cfg, reg: registry(cfg) };
  }

  for (const [role, claimed] of CLAIMED) {
    test(`${role} serves ${claimed} and refuses every other path`, () => {
      const { cfg, reg } = withRole(role);
      expect(resolveModel("@/e/m", claimed, cfg, reg).ok).toBe(true);
      for (const other of [CHAT, ...CLAIMED.map(([, p]) => p).filter((p) => p !== claimed)]) {
        expect(resolveModel("@/e/m", other, cfg, reg).ok).toBe(false);
      }
    });
  }

  test("a chat route is refused on every claimed path, not only embeddings", () => {
    const { cfg, reg } = withRole("chat");
    expect(resolveModel("@/e/m", CHAT, cfg, reg).ok).toBe(true);
    for (const [, claimed] of CLAIMED) {
      expect(resolveModel("@/e/m", claimed, cfg, reg).ok).toBe(false);
    }
  });
});

/**
 * Translations is the one path a role cannot decide: whisper's own spec
 * offers it, and whether a given route may answer depends on the weights that
 * route names. Tested against `routeServes` directly because no spec-less
 * engine serves the path -- only whisper's shipped spec does, so a fixture
 * engine cannot express the question.
 */
describe("a route's translate declaration", () => {
  const WHISPER_SERVES = [CONTENT_ENDPOINT_TRANSCRIPTIONS, CONTENT_ENDPOINT_TRANSLATIONS];

  test("an undeclared route serves transcriptions and not translations", () => {
    expect(routeServes({}, WHISPER_SERVES)).toEqual([CONTENT_ENDPOINT_TRANSCRIPTIONS]);
  });

  // `translate = false` is a declaration that this model cannot, and must read
  // the same as saying nothing -- not as "the key is present, so allow it".
  test("translate = false is refused exactly as an absent key is", () => {
    expect(routeServes({ translate: false }, WHISPER_SERVES)).toEqual([
      CONTENT_ENDPOINT_TRANSCRIPTIONS,
    ]);
  });

  test("a declared route serves both, because one model answers both verbs", () => {
    expect(routeServes({ translate: true }, WHISPER_SERVES)).toEqual(WHISPER_SERVES);
  });

  // The gating is subtractive, so an engine that never offered the path is
  // not handed one by a route declaring the key.
  test("declaring it does not invent a path the engine's spec does not serve", () => {
    expect(routeServes({ translate: true }, [CONTENT_ENDPOINT_TRANSCRIPTIONS])).toEqual([
      CONTENT_ENDPOINT_TRANSCRIPTIONS,
    ]);
  });
});

describe("routeForHop", () => {
  const AMBIENT_OFF = { ...route({ engine: "e", model: "m", upstream: null }), disabled: true };
  const LOCAL_ON = route({ engine: "e", model: "m", upstream: "local" });

  test("a disabled route is never the resolved hop", () => {
    const routes = [AMBIENT_OFF, LOCAL_ON];
    // Ambient outranks local among served routes -- but this ambient one is
    // not served, so local is the whole served set.
    expect(routeForHop(routes, "e", "m")?.upstream).toBe("local");
    expect(routeForHop(routes, "e", "m", "local")?.upstream).toBe("local");
  });

  test("a hop whose only route is disabled resolves to nothing", () => {
    expect(routeForHop([AMBIENT_OFF], "e", "m")).toBeUndefined();
  });
});
