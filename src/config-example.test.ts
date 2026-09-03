import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { EngineRegistry } from "./engines.ts";
import { dataHome } from "./paths.ts";
import { BUNX, ENGINES_ROOT, makeTestRoot } from "./test-support.ts";
import { type Config, FatalError } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-example-");

/**
 * config.example.toml is the only committed, always-parsing reference for
 * how to configure this daemon -- this file is the only copy that is
 * pruning, not a promise it still parses. The real GGUFs it names are tens
 * of gigabytes each and live only on the box that downloaded them, so this
 * swaps llama's models_dir for a temp dir carrying empty placeholders
 * at the same relative paths (same pattern as config.test.ts's
 * `tempModelsDir`), rather than requiring a fresh clone to have real
 * weights on disk just to run the suite.
 */
const LLAMA_MODELS_DIR_RE = /models_dir\s*=\s*"~\/\.local\/share\/engined-models\/llm"/;
const WIRE_MISMATCH_RE = /wire "anthropic".*speaks "openai"/;

// Already alphabetised, so the assertion below can sort actual output the
// same way without needing a matching compare function here too.
// A disabled engine keeps its entry -- that is what lets GET /engined/v1/engines
// report it as off -- so the list here is every engine the file declares.
const EXPECTED_ENGINE_IDS = [
  "chatterbox-en",
  "chatterbox-multi",
  "claude",
  "comfy",
  "cursor",
  "elevenlabs",
  "kokoro",
  "llama",
  "openai",
  "opencode",
  "openrouter",
  "piper",
  "whisper",
];

// The example ships every off-box engine disabled, and a disabled engine's
// routes are dropped: nothing here can be dispatched to.
const EXPECTED_DISABLED_IDS = ["claude", "cursor", "elevenlabs", "openai"];

// The example declares no [[model]] capability rows -- every model id below
// comes from a route naming one, disabled or not. Every id here is the
// address segment ("model"), never "wire_model" -- this list answers what a
// caller dials, not what reaches an upstream.
// "sonnet-5" appears twice: the ambient claude route and the claude route
// onto openrouter-anthropic. The openrouter engine's own openai-wire route
// addresses a different model ("north-mini-code:free") than either.
// "ornith" appears twice for a different reason: the llama route that serves
// it, and the opencode route that names the brain it thinks with. Those are
// distinct addresses (`@/llama/ornith`, `@/opencode/ornith`) on distinct
// engines, so neither shadows the other.
const EXPECTED_ROUTE_MODEL_IDS = [
  "composer-2.5",
  "embed",
  "gpt-5.4",
  "gpt-5.4-mini",
  "k3",
  "medium.en",
  "north-mini-code:free",
  "ocr",
  "ornith",
  "ornith",
  "scribe_v1",
  "small.en",
  "sonnet-5",
  "sonnet-5",
  "vision",
];

/** Empty placeholders at the same relative paths the example config's GGUFs name, under a fresh scratch dir. */
function placeExampleModels(modelsDir: string): void {
  for (const rel of [
    "gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTPv2-25G-ICE.gguf",
    "Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    "Qwen/Qwen3-VL-8B-Instruct-GGUF/Qwen3VL-8B-Instruct-Q8_0.gguf",
    "PaddlePaddle/PaddleOCR-VL-1.6-GGUF/PaddleOCR-VL-1.6-GGUF.gguf",
  ]) {
    const full = join(modelsDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
  }
}

/** `raw` with llama's real models_dir swapped for the scratch one, written to a fresh config.toml. */
function writePatchedExampleConfig(raw: string, modelsDir: string): string {
  const patched = raw.replace(LLAMA_MODELS_DIR_RE, `models_dir = "${modelsDir}"`);
  const configDir = mkdtempSync(join(TEST_ROOT, "config-"));
  const configPath = join(configDir, "config.toml");
  writeFileSync(configPath, patched);
  return configPath;
}

function byName(a: string, b: string): number {
  return a.localeCompare(b);
}

/** `pick` may return `undefined` (a modelless route's `model`) -- those drop rather than sorting in as a literal "undefined". */
function sortedIds<T>(items: readonly T[], pick: (item: T) => string | undefined): string[] {
  return items
    .map(pick)
    .filter((v): v is string => v !== undefined)
    .sort(byName);
}

/** The example config through the real `loadConfig()`, with `append` tacked onto its end. `raw` is the unpatched file text. */
function loadExample(append = ""): { raw: string; config: Config } {
  const raw = readFileSync(join(import.meta.dir, "..", "config.example.toml"), "utf8");
  const modelsDir = mkdtempSync(join(TEST_ROOT, "models-"));
  placeExampleModels(modelsDir);
  const configPath = writePatchedExampleConfig(raw + append, modelsDir);
  return { raw, config: loadConfig(configPath, ENGINES_ROOT) };
}

test("config.example.toml parses through the real loadConfig()", () => {
  const { raw, config } = loadExample();
  expect(raw).toMatch(LLAMA_MODELS_DIR_RE);

  expect(sortedIds(config.engines, (e) => e.id)).toEqual(EXPECTED_ENGINE_IDS);
  expect(config.models.map((m) => m.id)).toEqual(["sonnet-5"]);
  expect(sortedIds(config.routes, (r) => r.model)).toEqual(EXPECTED_ROUTE_MODEL_IDS);
  expect(
    sortedIds(
      config.engines.filter((e) => e.disabled),
      (e) => e.id,
    ),
  ).toEqual(EXPECTED_DISABLED_IDS);

  expect(config.chains["chain-private"]).toEqual(["@/llama/ornith"]);
  // Written with three remote/agentic hops after the local one; claude and
  // openai are both disabled, so what survives parse is the local hop alone.
  expect(config.chains["chain-public"]).toEqual(["@/llama/ornith"]);

  // whisper's spec needs models_dir on the wire (its bind mount and
  // artifact-fetch commands both use it) -- the exact gap the operator's
  // real installed config was found missing before this file existed.
  const whisper = config.engines.find((e) => e.id === "whisper");
  // The rule, not the literal: `~/.local/share/` resolves through the same
  // XDG_DATA_HOME-aware dataHome() that engined's own install dir uses, so
  // this stays that directory's sibling under any XDG_DATA_HOME -- it is
  // never a plain $HOME expansion of the example's tilde text.
  expect(whisper?.models_dir).toBe(join(dataHome(), "engined-models/whisper"));
});

// The [[model]] row's capabilities reach the route naming it, and inserting
// that [[model]] row ahead of llama's own routes did not silently migrate
// [route.args] onto the wrong one: TOML attaches a bare [route.args] to
// whichever [[route]] was declared most recently, so ornith's own draft-MTP
// args must still be ornith's.
test("a [[model]] row reaches the route naming it without stealing a neighbour's [route.args]", () => {
  const { config } = loadExample();
  const sonnet5 = config.routes.find((r) => r.engine === "claude" && r.model === "sonnet-5");
  expect(sonnet5?.context_in).toBe(200_000);
  expect(sonnet5?.reasoning).toEqual(["none", "low", "high"]);
  const ornith = config.routes.find((r) => r.engine === "llama" && r.model === "ornith");
  expect(ornith?.args["spec-type"]).toBe("draft-mtp");
});

// A positive `parallel` turns off llama.cpp's kv_unified and divides
// `ctx-size` across slots, so a route stating one without also stating the
// ctx-size being divided silently serves a fraction of the engine-level
// floor it was sized against. The door never needs that: `capacityFor` caps
// an auto role at llama.cpp's own slot count regardless. This file is what
// consumers copy, so the trap is worth pinning here.
test("no llama route splits an inherited ctx-size by stating parallel without its own ctx-size", () => {
  const { config } = loadExample();
  const llamaRoutes = config.routes.filter((r) => r.engine === "llama");
  expect(llamaRoutes.length).toBeGreaterThan(0);
  // Compared as a model list rather than per route, so a failure names every
  // shrunk role instead of only the first one found.
  const split = llamaRoutes.filter(
    (r) =>
      typeof r.args.parallel === "number" &&
      r.args.parallel > 0 &&
      r.args["ctx-size"] === undefined,
  );
  expect(split.map((r) => r.model)).toEqual([]);
});

// The remote STT engine's whole shape spans an engine, an upstream and a
// route, none of which has a spec directory to carry any of it. A `kind`
// lost to an edit would make it an engine of no kind, a lost route "model"
// would send the door's own engine id upstream as a model, and a lost
// secret would leave the upstream unable to authenticate at all.
test("the spec-less remote STT engine keeps its kind, route model and secret header", () => {
  const { config } = loadExample();
  const elevenlabs = config.engines.find((e) => e.id === "elevenlabs");
  expect(elevenlabs?.kind).toBe("stt");
  const elevenlabsRoute = config.routes.find((r) => r.engine === "elevenlabs");
  expect(elevenlabsRoute?.model).toBe("scribe_v1");
  const elevenlabsUpstream = config.upstreams.find((u) => u.id === "elevenlabs");
  expect(elevenlabsUpstream?.egress).toBe("remote");
  expect(elevenlabsUpstream?.secret?.header).toBe("xi-api-key");
});

// One provider, two wires, two upstreams -- the OpenAI-shaped one proven
// live and on, the Anthropic gateway still off. The engine's own route
// stays two-segment because it is the only route on "openrouter" (see the
// config's own comment on that route).
test("openrouter's openai wire is on and its anthropic wire is off, each with its own upstream", () => {
  const { config } = loadExample();
  const orOpenai = config.upstreams.find((u) => u.id === "openrouter");
  const orAnthropic = config.upstreams.find((u) => u.id === "openrouter-anthropic");
  expect(orOpenai?.disabled).toBeUndefined();
  expect(orOpenai?.wire).toBe("openai");
  expect(orOpenai?.base_url).toBe("https://openrouter.ai/api/v1");
  expect(orAnthropic?.disabled).toBe(true);
  expect(orAnthropic?.wire).toBe("anthropic");
  expect(orAnthropic?.base_url).toBe("https://openrouter.ai/api");
  const orEngine = config.engines.find((e) => e.id === "openrouter");
  expect(orEngine?.kind).toBe("openai-http");
  expect(orEngine?.disabled).toBeUndefined();
  const orDirectRoute = config.routes.find(
    (r) => r.engine === "openrouter" && r.upstream === "openrouter",
  );
  // The address segment is slash-free; the real OpenRouter id lives in
  // wire_model, sent on the wire in its place.
  expect(orDirectRoute?.model).toBe("north-mini-code:free");
  expect(orDirectRoute?.wire_model).toBe("cohere/north-mini-code:free");
  expect(orDirectRoute?.disabled).toBeUndefined();
  // "claude" itself is disabled (EXPECTED_DISABLED_IDS), so every route on
  // it -- ambient, moonshot, and this one -- is disabled regardless of its
  // own upstream's flag.
  const orClaudeRoute = config.routes.find(
    (r) => r.engine === "claude" && r.upstream === "openrouter-anthropic",
  );
  expect(orClaudeRoute?.disabled).toBe(true);
});

/**
 * The pairing this example deliberately does NOT declare: "opencode" speaks
 * openai wire natively, and forwards it to whatever upstream a route names
 * unchanged (no translation) -- pointed at "openrouter-anthropic" that is a
 * mismatch no request could ever survive. Caught at registry construction
 * (engines.ts's checkAgenticWire), not at loadConfig() parse, because the
 * agent's own wire comes from its spec, loaded a step later. Asked of an
 * ENABLED engine: the example's "claude" is disabled, and a disabled engine
 * is not held to checks it can never reach a request through.
 */
test("opencode routed at an anthropic-wire upstream is refused at registry construction", () => {
  const { config } = loadExample(`
[[route]]
engine   = "opencode"
upstream = "openrouter-anthropic"
model    = "openrouter-mismatch"
`);

  const build = () => new EngineRegistry(config, { enginesRoot: ENGINES_ROOT, bunx: BUNX });
  expect(build).toThrow(FatalError);
  expect(build).toThrow(WIRE_MISMATCH_RE);
});
