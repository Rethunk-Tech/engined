import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { loadConfig } from "./config.ts";
import { makeTestRoot } from "./test-support.ts";
import { ParseError } from "./types.ts";

const RESERVED_FOR_THIS_BOX = /reserved for this box/;

const TEST_ROOT = makeTestRoot("engined-config-test-");

function writeConfig(toml: string): string {
  const dir = mkdtempSync(join(TEST_ROOT, "engined-config-"));
  const path = join(dir, "config.toml");
  Bun.write(path, toml);
  return path;
}

/** Every malformed/unresolvable-hop rule is a ParseError; this captures the message for a substring check the regex-only `.toThrow()` calls elsewhere can't do. */
function parseMessage(toml: string): string {
  try {
    loadConfig(writeConfig(toml));
    throw new Error("expected loadConfig to throw");
  } catch (err) {
    if (!(err instanceof Error)) {
      throw err;
    }
    return err.message;
  }
}

/** A real models_dir with the given files pre-created, for tests that must parse clean. */
function tempModelsDir(...files: string[]): string {
  const dir = mkdtempSync(join(TEST_ROOT, "engined-models-"));
  for (const rel of files) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
  }
  return dir;
}

/**
 * A minimal llama-shaped engine + one chat route whose GGUF actually exists.
 * `kind = "openai-http"` makes the engine spec-less, so `loadConfig` never
 * reads a spec file off disk to learn its upstream trait -- these tests are
 * about the five tables, not about what happens to be installed.
 */
function llamaEngineAndRoute(): string {
  const dir = tempModelsDir("ornith.gguf");
  return `
[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "${dir}"

[[route]]
engine = "local-llama"
upstream = "local"
model = "ornith"
filename = "ornith.gguf"
role = "chat"
`;
}

const LOCAL_UPSTREAM = `
[[upstream]]
id = "local"
egress = "none"
`;

const LLAMA_ENGINE = `
${LOCAL_UPSTREAM}
[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "~/llm-models"
`;

const EXPECTED_ENGINE_COUNT = 6;
const EXPECTED_ROUTE_COUNT = 9;
const DEFAULT_LISTEN_PORT = 29_200;
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600;

const RX_NOT_QUALIFIED = /not a fully-qualified/;
const RX_NON_SCALAR_ARG = /must be a string, number or boolean/;
const RX_TWO_PINNED = /only one model per role can be resident/;
const RX_PINNED_NO_ROLE = /declares "keep_resident" but has no "role"/;
const RX_UNKNOWN_ENGINE = /engine "nope" does not exist/;
const RX_UNKNOWN_MODEL = /model "nope" does not exist/;
const RX_MISSING_FILENAME_UNDER_DIR = /"filename" does not exist at/;
const RX_UNKNOWN_ENGINE_LOCAL = /engine "local" does not exist/;
const RX_MUST_NOT_FILENAME = /must not declare "filename"/;
const RX_MUST_NOT_ROLE = /must not declare "role"/;
const RX_MISSING_EGRESS = /is missing required "egress"/;
const RX_STREAMING_KEY = /"streaming"/;
const RX_UNRECOGNISED_ENGINE_KEY = /unrecognised key "models_dirs"/;
const RX_UNRECOGNISED_ROUTE_KEY = /unrecognised key "rolee"/;
const RX_FILENAME_ESCAPE = /not under engine's "models_dir"/;
const RX_MODELS_MAX_ROLES = /below its 2 distinct configured roles/;
const RX_FORBIDDEN_FLAG = /dissolves the read-only floor/;
const RX_INVALID_TOML = /invalid TOML/;
const RX_ABSOLUTE_MODELS_DIR = /does not exist at "\/.*llm-models/;
const RX_UNKNOWN_UPSTREAM = /names unknown upstream "nope"/;
const RX_DUP_DECLARED_TWICE = /"dup" is declared twice/;
const RX_MIXED_MODELLESS = /carries both a modelless route and a model-bearing route/;
const RX_NO_UPSTREAM_TRAIT = /spec is missing required "upstream"/;
const RX_REQUIRED_NO_DEFAULT = /is "required" to have exactly one across its routes/;
const RX_UNRECOGNISED_SECRET_KEY = /"secret" has unrecognised key "schema"/;
const RX_UNRECOGNISED_WIRE_MODEL_KEY = /unrecognised key "wire_modell"/;

/** Hops that are not `@/<engine>/<model>`: [label, config, the hop text the error must quote]. */
const NOT_QUALIFIED_HOPS: [string, string, string][] = [
  [
    "a bare model id",
    `${llamaEngineAndRoute()}\n[[chain]]\nid = "c"\nhops = ["ornith"]\n`,
    "ornith",
  ],
  [
    "a bare engine id",
    `${llamaEngineAndRoute()}\n[[chain]]\nid = "c"\nhops = ["local-llama"]\n`,
    "local-llama",
  ],
  [
    "another chain's name",
    `${llamaEngineAndRoute()}\n[[chain]]\nid = "c"\nhops = ["other"]\n[[chain]]\nid = "other"\nhops = ["@/local-llama/ornith"]\n`,
    "other",
  ],
];

const COMFY_SPEC_SELF_UPSTREAM = [
  'kind = "comfy"',
  'upstream = "self"',
  'image = "x"',
  'obtain = "pull"',
  "serves = []",
  "command = []",
  "",
  "[ready]",
  'path = "/queue"',
  "status = 200",
];
const COMFY_SPEC_NO_UPSTREAM = [
  'kind = "comfy"',
  'image = "x"',
  'obtain = "pull"',
  "serves = []",
  "command = []",
];

/** A scratch spec dir holding a `spec.toml` made of `lines`. */
function writeSpecDir(lines: readonly string[]): string {
  const specDir = mkdtempSync(join(TEST_ROOT, "engined-spec-"));
  writeFileSync(join(specDir, "spec.toml"), lines.join("\n"));
  return specDir;
}

/**
 * The worked config, five tables: an [[upstream]] a route names explicitly
 * ("local"), a second upstream a route redirects to ("moonshot"), every
 * shipped-shape engine given `kind` so parsing never reads a spec file off
 * disk, and both chains config.example.toml carries.
 */
function workedConfig(): string {
  const ornithFile = "gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTPv2-25G-ICE.gguf";
  const embedFile = "Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
  const visionFile = "Qwen/Qwen3-VL-8B-Instruct-GGUF/Qwen3VL-8B-Instruct-Q8_0.gguf";
  const dir = tempModelsDir(ornithFile, embedFile, visionFile);
  return `
listen_port           = 29200
chat_timeout_seconds  = 600
agent_timeout_seconds = 3600

[[upstream]]
id     = "local"
egress = "none"

[[upstream]]
id       = "moonshot"
base_url = "https://api.kimi.com/coding/"
secret   = { service = "moonshot-api", username = "kimi-k2.7-code", header = "x-api-key" }
egress   = "remote"
wire     = "anthropic"

[[model]]
id     = "ornith"
input  = ["text"]
output = ["text"]

[[engine]]
id                = "local-llama"
kind              = "openai-http"
models_dir        = "${dir}"
models_max        = 3
ready_timeout_s   = 180
idle_stop_seconds = 900

  [engine.args]
  parallel     = -1
  ctx-size     = 32768
  cache-type-k = "q8_0"
  cache-type-v = "q8_0"

[[route]]
engine   = "local-llama"
upstream = "local"
model    = "ornith"
filename = "${ornithFile}"
role     = "chat"

  [route.args]
  spec-type        = "draft-mtp"
  spec-draft-p-min = 0.1
  spec-draft-n-max = 1
  ctx-size         = 32768

[[route]]
engine   = "local-llama"
upstream = "local"
model    = "embed"
filename = "${embedFile}"
role     = "embedding"

[[route]]
engine   = "local-llama"
upstream = "local"
model    = "vision"
filename = "${visionFile}"
role     = "vision"

[[engine]]
id            = "claude"
kind          = "agentic-cli"
agent_version = "2.1.247"

  [engine.args]
  output-format = "json"

[[route]]
engine = "claude"
model  = "sonnet-5"

[[route]]
engine   = "claude"
upstream = "moonshot"
model    = "k3"

[[engine]]
id                = "comfy"
kind              = "comfy"
idle_stop_seconds = 1800

[[route]]
engine   = "comfy"
upstream = "local"

[[engine]]
id                = "chatterbox-multi"
kind              = "tts"
idle_stop_seconds = 1800

[[route]]
engine   = "chatterbox-multi"
upstream = "local"

[[engine]]
id                = "kokoro"
kind              = "tts"
idle_stop_seconds = 1800

[[route]]
engine   = "kokoro"
upstream = "local"

[[engine]]
id                = "whisper"
kind              = "stt"
idle_stop_seconds = 1800

[[route]]
engine   = "whisper"
upstream = "local"

[[chain]]
id   = "chain-private"
hops = ["@/local-llama/ornith"]

[[chain]]
id   = "chain-public"
hops = ["@/local-llama/ornith", "@/claude/k3", "@/claude/sonnet-5"]
`;
}

test("the worked config parses clean", () => {
  const cfg = loadConfig(writeConfig(workedConfig()));
  expect(cfg.engines).toHaveLength(EXPECTED_ENGINE_COUNT);
  expect(cfg.routes).toHaveLength(EXPECTED_ROUTE_COUNT);
  expect(cfg.upstreams.map((u) => u.id)).toEqual(["local", "moonshot"]);
  expect(cfg.models).toHaveLength(1);
  expect(cfg.chains["chain-public"]).toEqual([
    "@/local-llama/ornith",
    "@/claude/k3",
    "@/claude/sonnet-5",
  ]);
});

test("a route with no capability fields of its own inherits the [[model]] row it names", () => {
  const toml = `
${workedConfig()}
`;
  const cfg = loadConfig(writeConfig(toml));
  const ornithRoute = cfg.routes.find((r) => r.model === "ornith");
  expect(ornithRoute?.input).toEqual(["text"]);
  expect(ornithRoute?.output).toEqual(["text"]);
});

test("a route's own capability field wins over the [[model]] row's, field by field -- an undeclared field still falls through", () => {
  const dir = tempModelsDir("ornith.gguf");
  const toml = `
[[upstream]]
id     = "local"
egress = "none"

[[model]]
id          = "ornith"
input       = ["text"]
output      = ["text"]
context_in  = 4096
context_out = 1024

[[engine]]
id         = "local-llama"
kind       = "openai-http"
models_dir = "${dir}"

[[route]]
engine     = "local-llama"
model      = "ornith"
upstream   = "local"
filename   = "ornith.gguf"
role       = "chat"
output     = ["text", "image"]
context_in = 8192
`;
  const cfg = loadConfig(writeConfig(toml));
  const ornithRoute = cfg.routes.find((r) => r.model === "ornith");
  // The route's own "output" and "context_in" win over the model row's.
  expect(ornithRoute?.output).toEqual(["text", "image"]);
  expect(ornithRoute?.context_in).toBe(8192);
  // Fields the route left undeclared still fall through to the model row.
  expect(ornithRoute?.input).toEqual(["text"]);
  expect(ornithRoute?.context_out).toBe(1024);
});

test('a secret\'s own "scheme" parses through onto the upstream, and stays absent where undeclared', () => {
  const toml = `
${workedConfig()}
`;
  const cfg = loadConfig(writeConfig(toml));
  // "moonshot" (x-api-key) declares no scheme in workedConfig() -- absent means raw.
  expect(cfg.upstreams.find((u) => u.id === "moonshot")?.secret?.scheme).toBeUndefined();
});

test('a secret\'s own "scheme" parses through as declared', () => {
  const toml = `
[[upstream]]
id       = "hosted"
base_url = "https://x"
secret   = { service = "s", username = "u", header = "authorization", scheme = "Bearer" }
egress   = "remote"

[[engine]]
id   = "hosted-llama"
kind = "openai-http"

[[route]]
engine   = "hosted-llama"
upstream = "hosted"
model    = "x"
`;
  const cfg = loadConfig(writeConfig(toml));
  expect(cfg.upstreams.find((u) => u.id === "hosted")?.secret?.scheme).toBe("Bearer");
});

test("a secret table rejects an unrecognised key rather than dropping it silently", () => {
  const toml = `
[[upstream]]
id       = "hosted"
base_url = "https://x"
secret   = { service = "s", username = "u", header = "h", schema = "Bearer" }
egress   = "remote"

[[engine]]
id   = "hosted-llama"
kind = "openai-http"

[[route]]
engine   = "hosted-llama"
upstream = "hosted"
model    = "x"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNRECOGNISED_SECRET_KEY);
});

test("a disabled engine keeps its entry, marked, and its routes drop", () => {
  const toml = workedConfig().replace(
    'id            = "claude"\nkind          = "agentic-cli"',
    'id            = "claude"\nkind          = "agentic-cli"\ndisable       = true',
  );
  const cfg = loadConfig(writeConfig(toml));
  expect(cfg.engines.find((e) => e.id === "claude")?.disabled).toBe(true);
  expect(cfg.engines.find((e) => e.id === "local-llama")?.disabled).toBeUndefined();
  expect(cfg.routes.find((r) => r.model === "sonnet-5")?.disabled).toBe(true);
  expect(cfg.chains["chain-public"]).toEqual(["@/local-llama/ornith"]);
});

test("a disabled upstream drops every route naming it, and only those", () => {
  const toml = workedConfig().replace(
    'id       = "moonshot"',
    'id       = "moonshot"\ndisable  = true',
  );
  const cfg = loadConfig(writeConfig(toml));
  expect(cfg.upstreams.find((u) => u.id === "moonshot")?.disabled).toBe(true);
  expect(cfg.routes.find((r) => r.model === "k3")?.disabled).toBe(true);
  expect(cfg.routes.find((r) => r.model === "sonnet-5")?.disabled).toBeUndefined();
});

test("a disabled route drops just that pairing; siblings on the same engine survive", () => {
  const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "${tempModelsDir("a.gguf", "b.gguf")}"

[[route]]
engine = "local-llama"
upstream = "local"
model = "a"
filename = "a.gguf"
role = "chat"
disable = true

[[route]]
engine = "local-llama"
upstream = "local"
model = "b"
filename = "b.gguf"
role = "vision"
`;
  const cfg = loadConfig(writeConfig(toml));
  expect(cfg.routes.find((r) => r.model === "a")?.disabled).toBe(true);
  expect(cfg.routes.find((r) => r.model === "b")?.disabled).toBeUndefined();
});

test("a disabled chain drops it while its engines and routes stay served", () => {
  const toml = workedConfig().replace(
    'id   = "chain-public"',
    'id      = "chain-public"\ndisable = true',
  );
  const cfg = loadConfig(writeConfig(toml));
  expect(cfg.chains["chain-public"]).toBeUndefined();
  expect(cfg.chains["chain-private"]).toEqual(["@/local-llama/ornith"]);
  expect(cfg.engines.find((e) => e.id === "claude")?.disabled).toBeUndefined();
});

test("tilde in a route's filename is expanded to an absolute path", () => {
  const toml = `${LLAMA_ENGINE}\n[[route]]\nengine = "local-llama"\nupstream = "local"\nmodel = "x"\nfilename = "y.gguf"\nrole = "chat"\n`;
  // No file on disk -- the escape check passes (tilde expanded, still under
  // the dir) and the existence check is what should fire, naming an absolute
  // path rather than the literal "~".
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_ABSOLUTE_MODELS_DIR);
});

test("~/.local/share/ in models_dir resolves through XDG_DATA_HOME, not a bare home expansion", () => {
  const prior = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = mkdtempSync(join(TEST_ROOT, "engined-xdg-data-"));
  try {
    const toml = `
[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "~/.local/share/engined-models/llm"
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.engines[0]?.models_dir).toBe(join(process.env.XDG_DATA_HOME, "engined-models/llm"));
  } finally {
    if (prior === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = prior;
    }
  }
});

test("defaults apply when listen_port/chat_timeout/agent_timeout are absent", () => {
  const cfg = loadConfig(writeConfig(llamaEngineAndRoute()));
  expect(cfg.listen_port).toBe(DEFAULT_LISTEN_PORT);
  expect(cfg.chat_timeout_seconds).toBe(DEFAULT_CHAT_TIMEOUT_SECONDS);
  expect(cfg.agent_timeout_seconds).toBe(DEFAULT_AGENT_TIMEOUT_SECONDS);
});

describe("namespace collisions: four separate maps", () => {
  test("two engines sharing an id is fatal, naming both sites", () => {
    const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "dup"
kind = "comfy"

[[engine]]
id = "dup"
kind = "tts"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_DUP_DECLARED_TWICE);
  });

  test("two upstreams sharing an id is fatal", () => {
    const toml = `
[[upstream]]
id = "dup"
egress = "none"

[[upstream]]
id = "dup"
egress = "remote"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_DUP_DECLARED_TWICE);
  });

  test("two [[model]] rows sharing an id is fatal", () => {
    const toml = `
[[model]]
id = "dup"

[[model]]
id = "dup"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_DUP_DECLARED_TWICE);
  });

  test("two [[chain]] rows sharing an id is fatal", () => {
    const toml = `
${llamaEngineAndRoute()}
[[chain]]
id = "dup"
hops = ["@/local-llama/ornith"]

[[chain]]
id = "dup"
hops = ["@/local-llama/ornith"]
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_DUP_DECLARED_TWICE);
  });

  test('an engine and an upstream sharing the id "local" is not a collision -- separate namespaces', () => {
    const toml = `
[[upstream]]
id = "local"
egress = "none"

[[engine]]
id = "local"
kind = "comfy"

[[route]]
engine = "local"
upstream = "local"
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.engines.map((e) => e.id)).toEqual(["local"]);
    expect(cfg.upstreams.map((u) => u.id)).toEqual(["local"]);
  });
});

describe("chain hops", () => {
  test.each(NOT_QUALIFIED_HOPS)(
    "%s is not a fully-qualified hop, naming it",
    (_label, toml, hop) => {
      const message = parseMessage(toml);
      expect(message).toMatch(RX_NOT_QUALIFIED);
      expect(message).toContain(`"${hop}"`);
    },
  );

  test("a qualified hop naming an unknown engine fails, naming the engine half and the hop", () => {
    const message = parseMessage(
      `${llamaEngineAndRoute()}\n[[chain]]\nid = "c"\nhops = ["@/nope/ornith"]\n`,
    );
    expect(message).toMatch(RX_UNKNOWN_ENGINE);
    expect(message).toContain('"@/nope/ornith"');
  });

  test("a qualified hop naming an unknown model fails, naming the model half and the hop", () => {
    const message = parseMessage(
      `${llamaEngineAndRoute()}\n[[chain]]\nid = "c"\nhops = ["@/local-llama/nope"]\n`,
    );
    expect(message).toMatch(RX_UNKNOWN_MODEL);
    expect(message).toContain('"@/local-llama/nope"');
  });

  test("a hop naming a model that exists only on a different engine fails at parse, not silently at the wrong engine's default", () => {
    // "ornith" is real -- just not on "claude". A flat model-name check
    // would have let this hop through clean and run claude's default model
    // at runtime; the pair check refuses it here instead.
    const message = parseMessage(
      `${llamaEngineAndRoute()}\n[[engine]]\nid = "claude"\nkind = "agentic-cli"\n\n[[chain]]\nid = "c"\nhops = ["@/claude/ornith"]\n`,
    );
    expect(message).toContain('model "ornith" does not exist on "claude"');
    expect(message).toContain('"@/claude/ornith"');
  });

  test("a three-segment hop resolves by (engine, upstream, model), not just the last two", () => {
    const toml = `
${LOCAL_UPSTREAM}
[[upstream]]
id = "moonshot"
egress = "remote"

[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "sonnet-5"

[[route]]
engine = "claude"
upstream = "moonshot"
model = "k3"

[[chain]]
id = "c"
hops = ["@/claude/moonshot/k3"]
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.chains.c).toEqual(["@/claude/moonshot/k3"]);
  });

  test('"local" is a real upstream id, never a discovered engine alias: a hop naming it as the engine segment is just an unknown engine', () => {
    const toml = `${llamaEngineAndRoute()}\n[[chain]]\nid = "c"\nhops = ["@/local/ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNKNOWN_ENGINE_LOCAL);
  });

  test('an engine literally id = "local" is addressed directly, same as any other id', () => {
    const dir = tempModelsDir("ornith.gguf");
    const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "local"
kind = "openai-http"
models_dir = "${dir}"

[[route]]
engine = "local"
upstream = "local"
model = "ornith"
filename = "ornith.gguf"
role = "chat"

[[chain]]
id = "c"
hops = ["@/local/ornith"]
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.chains.c).toEqual(["@/local/ornith"]);
  });
});

describe("route required/forbidden fields (parse tier)", () => {
  test("a modelless route must not declare filename", () => {
    const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "comfy"
kind = "comfy"

[[route]]
engine = "comfy"
upstream = "local"
filename = "should-not-be-here.gguf"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MUST_NOT_FILENAME);
  });

  test("a route on an engine with no models_dir must not declare filename", () => {
    const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "x"
filename = "should-not-be-here.gguf"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MUST_NOT_FILENAME);
  });

  test("a route on an engine with no models_dir must not declare role", () => {
    const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "x"
role = "chat"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MUST_NOT_ROLE);
  });

  // A route proxied to a real upstream (not this box's "local") has no local
  // file to describe, whatever kind its engine is -- the message must not
  // guess at a reason that assumes agentic.
  test("a route proxied to a real upstream must not declare filename, and the message does not call it agentic", () => {
    const message = parseMessage(`
[[upstream]]
id = "hosted"
base_url = "https://x"
secret = { service = "s", username = "u", header = "h" }
egress = "remote"

[[engine]]
id = "hosted-llama"
kind = "openai-http"

[[route]]
engine = "hosted-llama"
upstream = "hosted"
model = "x"
filename = "should-not-be-here.gguf"
`);
    expect(message).toMatch(RX_MUST_NOT_FILENAME);
    expect(message).not.toContain("agentic");
  });

  // [route.args] reaches argv only via llama.ts's preset-INI renderer, gated
  // on the same parse-tier boundary as filename/role. A route on an engine
  // with no local model store had its args parsed and forbidden-flag-checked
  // but then simply never read again -- the same accept-and-drop failure the
  // closed key sets exist to prevent.
  test("[route.args] on an engine with no models_dir is rejected -- nothing ever reads it", () => {
    const message = parseMessage(`
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "x"

  [route.args]
  max-turns = 5
`);
    expect(message).toContain('route[0] on engine "claude" model "x"');
    expect(message).toContain("args");
  });

  test("an engine may not carry both a modelless route and a model-bearing route", () => {
    const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "mixed"
kind = "comfy"

[[route]]
engine = "mixed"
upstream = "local"

[[route]]
engine = "mixed"
upstream = "local"
model = "x"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MIXED_MODELLESS);
  });
});

describe("a role implies modalities", () => {
  test("vision takes text and image, chat takes text, an embedding route says nothing", () => {
    const cfg = loadConfig(writeConfig(workedConfig()));
    const byModel = (model: string) => cfg.routes.find((r) => r.model === model);
    expect(byModel("vision")?.input).toEqual(["text", "image"]);
    expect(byModel("vision")?.output).toEqual(["text"]);
    expect(byModel("ornith")?.input).toEqual(["text"]);
    expect(byModel("embed")?.input).toBeUndefined();
  });
});

describe("streaming on a route overrides the engine's own", () => {
  test("a boolean parses and survives; anything else is a parse error", () => {
    const base = `
[[engine]]
id = "claude"
agent_version = "1.0.0"

[[route]]
engine = "claude"
model = "sonnet-5"
`;
    const cfg = loadConfig(writeConfig(`${base}streaming = false\n`));
    expect(cfg.routes[0]?.streaming).toBe(false);
    expect(loadConfig(writeConfig(base)).routes[0]?.streaming).toBeUndefined();
    expect(() => loadConfig(writeConfig(`${base}streaming = "yes"\n`))).toThrow(RX_STREAMING_KEY);
  });
});

describe("wire_model: the address segment vs. the id the upstream knows", () => {
  test('a "model" containing "/" is a ParseError naming the offending route', () => {
    const message = parseMessage(`
[[upstream]]
id = "hosted"
base_url = "https://x"
egress = "remote"

[[engine]]
id = "openrouter"
kind = "openai-http"

[[route]]
engine = "openrouter"
upstream = "hosted"
model = "z-ai/glm-5.2:free"
`);
    expect(message).toContain('route[0] on engine "openrouter"');
    expect(message).toContain("/");
    expect(message).toContain("wire_model");
  });

  test('"wire_model" survives parsing distinct from "model", and is absent when not configured', () => {
    const toml = `
[[upstream]]
id = "hosted"
base_url = "https://x"
egress = "remote"

[[engine]]
id = "openrouter"
kind = "openai-http"

[[route]]
engine = "openrouter"
upstream = "hosted"
model = "glm-5.2:free"
wire_model = "z-ai/glm-5.2:free"

[[route]]
engine = "openrouter"
upstream = "hosted"
model = "plain"
`;
    const cfg = loadConfig(writeConfig(toml));
    const withWire = cfg.routes.find((r) => r.model === "glm-5.2:free");
    expect(withWire?.wire_model).toBe("z-ai/glm-5.2:free");
    const plain = cfg.routes.find((r) => r.model === "plain");
    expect(plain?.wire_model).toBeUndefined();
  });

  test('an unrecognised route key is still rejected -- "wire_model" did not widen the closed set', () => {
    const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "x"
wire_modell = "y"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNRECOGNISED_WIRE_MODEL_KEY);
  });
});

describe("upstream defaulting by trait", () => {
  test('a route naming no upstream on an "optional"-trait (agentic-cli) engine is ambient', () => {
    const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "sonnet-5"
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.routes[0]?.upstream).toBeNull();
  });

  test('a route naming no upstream on a "self"-trait engine defaults to "local"', () => {
    const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "comfy"
kind = "comfy"

[[route]]
engine = "comfy"
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.routes[0]?.upstream).toBe("local");
  });

  test('a route naming no upstream on a "required"-trait engine defaults to its one sibling-declared upstream', () => {
    const toml = `
[[upstream]]
id = "openrouter"
base_url = "https://openrouter.ai/api/v1"
egress = "remote"

[[engine]]
id = "proxy"
kind = "openai-http"

[[route]]
engine = "proxy"
upstream = "openrouter"
model = "a"

[[route]]
engine = "proxy"
model = "b"
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.routes.find((r) => r.model === "b")?.upstream).toBe("openrouter");
  });

  test('a "required"-trait engine with no upstream anywhere on it is fatal', () => {
    const toml = `
[[engine]]
id = "proxy"
kind = "openai-http"

[[route]]
engine = "proxy"
model = "a"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_REQUIRED_NO_DEFAULT);
  });

  test('a "required"-trait engine whose sibling routes disagree on upstream is fatal', () => {
    const toml = `
[[upstream]]
id = "a-up"
egress = "remote"

[[upstream]]
id = "b-up"
egress = "remote"

[[engine]]
id = "proxy"
kind = "openai-http"

[[route]]
engine = "proxy"
upstream = "a-up"
model = "a"

[[route]]
engine = "proxy"
upstream = "b-up"
model = "b"

[[route]]
engine = "proxy"
model = "c"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_REQUIRED_NO_DEFAULT);
  });

  test("a route naming an unknown upstream is fatal", () => {
    const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
upstream = "nope"
model = "x"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNKNOWN_UPSTREAM);
  });

  test("a spec-full engine's trait is read from its own spec.toml", () => {
    const specDir = writeSpecDir(COMFY_SPEC_SELF_UPSTREAM);
    const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "comfy"
spec_dir = "${specDir}"

[[route]]
engine = "comfy"
`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.routes[0]?.upstream).toBe("local");
  });

  test("a spec-full engine whose spec omits upstream is fatal", () => {
    const specDir = writeSpecDir(COMFY_SPEC_NO_UPSTREAM);
    const toml = `
[[engine]]
id = "comfy"
spec_dir = "${specDir}"

[[route]]
engine = "comfy"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_NO_UPSTREAM_TRAIT);
  });
});

describe("engine/upstream required/forbidden fields", () => {
  test("every upstream requires egress", () => {
    const toml = `[[upstream]]\nid = "x"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MISSING_EGRESS);
  });

  // The list is rendered from EGRESS_RANK rather than written out, so an
  // added egress level reaches the operator's error without a second edit --
  // asserting the literal is what proves the rendering, not the intent.
  test("an egress that is not one refuses at parse, naming every value that is", () => {
    const toml = `[[upstream]]\nid = "x"\negress = "internet"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(
      /upstream "x" "egress" must be one of: none, lan, remote/,
    );
  });

  /**
   * `local` names this box everywhere it appears -- `defaultUpstreamFor`
   * and `localFileForbiddenReason` both read it as such. A config that
   * pointed it off-machine would make both of them lie, so the refusal is
   * at parse, before route defaulting ever reads the literal.
   */
  test("the reserved id local cannot carry a base_url or a secret", () => {
    const withUrl = `[[upstream]]\nid = "local"\negress = "none"\nbase_url = "https://elsewhere"\n`;
    const withSecret = `[[upstream]]\nid = "local"\negress = "remote"\n\n  [upstream.secret]\n  keyring = "x"\n`;
    expect(() => loadConfig(writeConfig(withUrl))).toThrow(RESERVED_FOR_THIS_BOX);
    expect(() => loadConfig(writeConfig(withSecret))).toThrow(RESERVED_FOR_THIS_BOX);
    expect(() =>
      loadConfig(writeConfig(`[[upstream]]\nid = "local"\negress = "none"\n`)),
    ).not.toThrow();
  });

  // A remote, non-agentic engine's [engine.args] are wire parameters rather
  // than process flags -- remote.ts hands them to whichever dialect the door
  // is speaking (ElevenLabs' model_id is the first). They parse and survive
  // regardless of whether the engine's own routes proxy anywhere.
  test("an engine's [engine.args] parse and survive to the entry", () => {
    const toml = `
[[engine]]
id = "hosted-thing"
kind = "stt"

  [engine.args]
  model_id = "scribe_v1"
`;
    const config = loadConfig(writeConfig(toml));
    const engine = config.engines.find((e) => e.id === "hosted-thing");
    expect(engine?.args.model_id).toBe("scribe_v1");
  });

  test("an unrecognised top-level engine key is fatal", () => {
    const toml = `[[engine]]\nid = "local-llama"\nkind = "openai-http"\nmodels_dirs = "~/x"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNRECOGNISED_ENGINE_KEY);
  });

  test("an unrecognised top-level route key is fatal", () => {
    const toml = `${LLAMA_ENGINE}\n[[route]]\nengine = "local-llama"\nupstream = "local"\nmodel = "x"\nfilename = "f.gguf"\nrole = "chat"\nrolee = "chat"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNRECOGNISED_ROUTE_KEY);
  });
});

test("a filename escaping the engine's models_dir is fatal", () => {
  const toml = `${LLAMA_ENGINE}\n[[route]]\nengine = "local-llama"\nupstream = "local"\nmodel = "x"\nfilename = "../../etc/passwd"\nrole = "chat"\n`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FILENAME_ESCAPE);
});

test("a filename not present on disk under models_dir is fatal", () => {
  const dir = tempModelsDir();
  const toml = `${LOCAL_UPSTREAM}\n[[engine]]\nid = "local-llama"\nkind = "openai-http"\nmodels_dir = "${dir}"\n\n[[route]]\nengine = "local-llama"\nupstream = "local"\nmodel = "x"\nfilename = "missing.gguf"\nrole = "chat"\n`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MISSING_FILENAME_UNDER_DIR);
});

test("models_max below the distinct local roles is fatal", () => {
  const dir = tempModelsDir("ornith.gguf", "vis.gguf");
  const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "${dir}"
models_max = 1

[[route]]
engine = "local-llama"
upstream = "local"
model = "ornith"
filename = "ornith.gguf"
role = "chat"

[[route]]
engine = "local-llama"
upstream = "local"
model = "vis"
filename = "vis.gguf"
role = "vision"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MODELS_MAX_ROLES);
});

test("a forbidden agentic flag in [engine.args] is fatal wherever it appears", () => {
  const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

  [engine.args]
  add-dir = "/etc"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FORBIDDEN_FLAG);
});

test("a forbidden agentic flag in [route.args] is fatal, on an ambient agentic route", () => {
  const toml = `
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
model = "sonnet-5"

  [route.args]
  add-dir = "/etc"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FORBIDDEN_FLAG);
});

test("loadConfig throws ParseError, not a bare Error, on a fatal rule", () => {
  const toml = `[[upstream]]\nid = "x"\n`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(ParseError);
});

test("malformed TOML is a ParseError naming the file, with the syntax error as cause", () => {
  const path = writeConfig("listen_port = ");
  try {
    loadConfig(path);
    throw new Error("expected loadConfig to throw");
  } catch (err) {
    expect(err).toBeInstanceOf(ParseError);
    const parseErr = err as ParseError;
    expect(parseErr.message).toContain(path);
    expect(parseErr.message).toMatch(RX_INVALID_TOML);
    expect(parseErr.cause).toBeDefined();
  }
});

const RX_ENGINE_NOT_ARRAY = /"engine" must be an array of tables/;
const RX_ROUTE_NOT_ARRAY = /"route" must be an array of tables/;

describe("a scalar where an array of tables belongs", () => {
  // A daemon that starts with zero engines is worse than one that refuses to
  // start: it serves 404s that read like a routing bug rather than a config one.
  test("engine as a scalar is fatal rather than zero engines", () => {
    expect(() => loadConfig(writeConfig('engine = "oops"\n'))).toThrow(RX_ENGINE_NOT_ARRAY);
  });

  test("route as a scalar is fatal", () => {
    expect(() => loadConfig(writeConfig("route = 3\n"))).toThrow(RX_ROUTE_NOT_ARRAY);
  });

  test("an absent table is still an empty list", () => {
    const cfg = loadConfig(writeConfig(llamaEngineAndRoute()));
    expect(cfg.engines.length).toBeGreaterThan(0);
  });
});

const RX_FLOOR_REFUSAL = /dangerously-skip-permissions/;

describe("the read-only floor is checked by key, not by rendered value", () => {
  // A forbidden flag is refused because the config may not decide it at all.
  // Writing it `= false` is still the config deciding it, so it stays fatal
  // even though a false-valued arg renders to no argv token at run time.
  test("a forbidden flag written false is still fatal at parse", () => {
    const toml = [
      "listen_port = 39218",
      "",
      "[[engine]]",
      'id     = "claude"',
      'kind   = "agentic-cli"',
      "",
      "[engine.args]",
      '"dangerously-skip-permissions" = false',
    ].join("\n");
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FLOOR_REFUSAL);
  });
});

test("a nested table under [engine.args] is fatal, not stringified into the argv", () => {
  const dir = tempModelsDir("ornith.gguf");
  const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "${dir}"

[[route]]
engine = "local-llama"
upstream = "local"
model = "ornith"
filename = "ornith.gguf"
role = "chat"

  [engine.args.sampler]
  top-k = 40
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_NON_SCALAR_ARG);
});

test("two keep_resident routes on one role is fatal: only one can be resident", () => {
  const dir = tempModelsDir("a.gguf", "b.gguf");
  const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "local-llama"
kind = "openai-http"
models_dir = "${dir}"

[[route]]
engine = "local-llama"
upstream = "local"
model = "a"
filename = "a.gguf"
role = "chat"
keep_resident = true

[[route]]
engine = "local-llama"
upstream = "local"
model = "b"
filename = "b.gguf"
role = "chat"
keep_resident = true
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_TWO_PINNED);
});

test("keep_resident on a roleless route is fatal: nothing would hold it resident", () => {
  const toml = `
${LOCAL_UPSTREAM}
[[engine]]
id = "claude"
kind = "agentic-cli"

[[route]]
engine = "claude"
upstream = "local"
model = "sonnet"
keep_resident = true
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_PINNED_NO_ROLE);
});
