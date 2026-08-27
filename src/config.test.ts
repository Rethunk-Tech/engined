import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolveArgs } from "./config.ts";
import { ParseError } from "./types.ts";

function writeConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-config-"));
  const path = join(dir, "config.toml");
  Bun.write(path, toml);
  return path;
}

/** A real models_dir with the given files pre-created, for tests that must parse clean. */
function tempModelsDir(...files: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-models-"));
  for (const rel of files) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
  }
  return dir;
}

/** A minimal llama engine + one chat model whose GGUF actually exists. */
function llamaEngineAndModel(): string {
  const dir = tempModelsDir("ornith.gguf");
  return `
[[engine]]
id = "local-llama"
egress = "none"
models_dir = "${dir}"

[[model]]
id = "ornith"
engine = "local-llama"
filename = "ornith.gguf"
role = "chat"
`;
}

const LLAMA_ENGINE = `
[[engine]]
id = "local-llama"
egress = "none"
models_dir = "~/llm-models"
`;

const EXPECTED_ENGINE_COUNT = 7;
const EXPECTED_MODEL_COUNT = 3;
const DEFAULT_LISTEN_PORT = 29_200;
const DEFAULT_CHAT_TIMEOUT_SECONDS = 600;
const DEFAULT_AGENT_TIMEOUT_SECONDS = 3600;
const MODEL_CTX_SIZE = 32_768;

const RX_COLLISION =
  /"ornith" is declared twice: engine "ornith" and model "chat-model" alias "ornith"/;
const RX_NOT_QUALIFIED = /not a fully-qualified/;
const RX_UNKNOWN_ENGINE = /engine "nope" does not exist/;
const RX_UNKNOWN_MODEL = /model "nope" does not exist/;
const RX_NO_LOCAL_CANDIDATE = /candidates: none/;
const RX_TWO_LOCAL_CANDIDATES = /candidates: local-llama, other-local/;
const RX_MISSING_FILENAME = /is missing required "filename"/;
const RX_MUST_NOT_FILENAME = /must not declare "filename"/;
const RX_MUST_NOT_ROLE = /must not declare "role"/;
const RX_MISSING_EGRESS = /is missing required "egress"/;
const RX_MISSING_SECRET = /missing required "secret"/;
const RX_MUST_NOT_MODELS_DIR = /must not declare "models_dir"/;
const RX_UNRECOGNISED_ENGINE_KEY = /unrecognised key "models_dirs"/;
const RX_UNRECOGNISED_MODEL_KEY = /unrecognised key "rolee"/;
const RX_FILENAME_ESCAPE = /not under engine's "models_dir"/;
const RX_FILENAME_MISSING = /does not exist at/;
const RX_MODELS_MAX_ROLES = /below its 2 distinct configured roles/;
const RX_FORBIDDEN_FLAG = /dissolves the read-only floor/;
const RX_INVALID_TOML = /invalid TOML/;
const RX_ABSOLUTE_MODELS_DIR = /does not exist at "\/.*llm-models/;

// The worked config from TODO.md, with models_dir swapped for a temp dir whose
// files are pre-created -- the acceptance-level integration case.
function workedConfig(): string {
  const ornithFile = "gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTPv2-25G-ICE.gguf";
  const dir = tempModelsDir(ornithFile);
  return `
listen_port           = 29200
chat_timeout_seconds  = 600
agent_timeout_seconds = 3600

[[model]]
id       = "ornith"
engine   = "local-llama"
filename = "${ornithFile}"
role     = "chat"

  [model.args]
  spec-type        = "draft-mtp"
  spec-draft-p-min = 0.1
  spec-n-max       = 1
  ctx-size         = 32768

[[model]]
engine = "claude"
id     = "sonnet-5"

[[model]]
engine = "claude-kimi"
id     = "k3"

[[engine]]
id                = "local-llama"
egress            = "none"
models_dir        = "${dir}"
models_max        = 3
ready_timeout_s   = 180
idle_stop_seconds = 900

  [engine.args]
  parallel      = -1
  ctx-size      = 32768
  cache-type-k  = "q8_0"
  cache-type-v  = "q8_0"

[[engine]]
id             = "claude"
egress         = "remote"
claude_version = "2.1.247"

  [engine.args]
  output-format = "json"

[[engine]]
id             = "claude-kimi"
egress         = "remote"
claude_version = "2.1.247"
base_url       = "https://api.kimi.com/coding/"
secret         = { service = "moonshot-api", username = "kimi-k2.7-code", header = "x-api-key" }

[[engine]]
id                = "comfy"
egress            = "none"
idle_stop_seconds = 1800

[[engine]]
id                = "chatterbox"
egress            = "none"
idle_stop_seconds = 1800

[[engine]]
id                = "kokoro"
egress            = "none"
idle_stop_seconds = 1800

[[engine]]
id                = "whisper"
egress            = "none"
idle_stop_seconds = 1800

[chain]
chain-private = ["@/local/ornith"]
chain-public  = ["@/local/ornith", "@/claude-kimi/k3", "@/claude/sonnet-5"]
`;
}

test("the worked config from TODO.md parses clean", () => {
  const cfg = loadConfig(writeConfig(workedConfig()));
  expect(cfg.engines).toHaveLength(EXPECTED_ENGINE_COUNT);
  expect(cfg.models).toHaveLength(EXPECTED_MODEL_COUNT);
  expect(cfg.chains["chain-public"]).toEqual([
    "@/local/ornith",
    "@/claude-kimi/k3",
    "@/claude/sonnet-5",
  ]);
});

test("tilde in models_dir is expanded to an absolute path", () => {
  const toml = `${LLAMA_ENGINE}\n[[model]]\nid = "x"\nengine = "local-llama"\nfilename = "y.gguf"\nrole = "chat"\n`;
  // No file on disk -- the escape check passes (tilde expanded, still under
  // the dir) and the existence check is what should fire, naming an absolute
  // path rather than the literal "~".
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_ABSOLUTE_MODELS_DIR);
});

test("defaults apply when listen_port/chat_timeout/agent_timeout are absent", () => {
  const cfg = loadConfig(writeConfig(llamaEngineAndModel()));
  expect(cfg.listen_port).toBe(DEFAULT_LISTEN_PORT);
  expect(cfg.chat_timeout_seconds).toBe(DEFAULT_CHAT_TIMEOUT_SECONDS);
  expect(cfg.agent_timeout_seconds).toBe(DEFAULT_AGENT_TIMEOUT_SECONDS);
});

describe("namespace collisions", () => {
  test("an alias colliding with an engine id is fatal, naming both sites", () => {
    const toml = `
${LLAMA_ENGINE}
[[engine]]
id = "ornith"
egress = "none"

[[model]]
id = "chat-model"
engine = "local-llama"
filename = "f.gguf"
role = "chat"
aliases = ["ornith"]
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_COLLISION);
  });
});

describe("chain hops", () => {
  test("a bare model id is not a fully-qualified hop", () => {
    const toml = `${llamaEngineAndModel()}\n[chain]\nc = ["ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_NOT_QUALIFIED);
  });

  test("a qualified hop naming an unknown engine fails, naming the engine half", () => {
    const toml = `${llamaEngineAndModel()}\n[chain]\nc = ["@/nope/ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNKNOWN_ENGINE);
  });

  test("a qualified hop naming an unknown model fails, naming the model half", () => {
    const toml = `${llamaEngineAndModel()}\n[chain]\nc = ["@/local-llama/nope"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNKNOWN_MODEL);
  });

  test('"local" with zero candidate engines is fatal, listing none', () => {
    const toml = `
[[engine]]
id = "claude"
egress = "remote"

[[model]]
id = "sonnet-5"
engine = "claude"

[chain]
c = ["@/local/sonnet-5"]
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_NO_LOCAL_CANDIDATE);
  });

  test('an engine with egress "none" and a models_dir but no models does not shadow the real "local" candidate', () => {
    const toml = `${llamaEngineAndModel()}\n[[engine]]\nid = "comfy"\negress = "none"\nmodels_dir = "/no/model/names/this"\n\n[chain]\nc = ["@/local/ornith"]\n`;
    const cfg = loadConfig(writeConfig(toml));
    expect(cfg.chains.c).toEqual(["@/local/ornith"]);
  });

  test('two engines that both serve models and are both "local" candidates is fatal, listing both', () => {
    const otherDir = tempModelsDir("other.gguf");
    const toml = `${llamaEngineAndModel()}\n[[engine]]\nid = "other-local"\negress = "none"\nmodels_dir = "${otherDir}"\n\n[[model]]\nid = "y"\nengine = "other-local"\nfilename = "other.gguf"\nrole = "chat"\n\n[chain]\nc = ["@/local/ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_TWO_LOCAL_CANDIDATES);
  });

  test('an engine with egress "none" and a models_dir but no models is not a "local" candidate on its own', () => {
    const toml = `\n[[engine]]\nid = "comfy"\negress = "none"\nmodels_dir = "/no/model/names/this"\n\n[chain]\nc = ["@/local/ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_NO_LOCAL_CANDIDATE);
  });
});

describe("model required/forbidden fields", () => {
  test("a llama model missing filename is fatal", () => {
    const toml = `${LLAMA_ENGINE}\n[[model]]\nid = "x"\nengine = "local-llama"\nrole = "chat"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MISSING_FILENAME);
  });

  test("an agentic model must not declare filename", () => {
    const toml = `
[[engine]]
id = "claude"
egress = "remote"

[[model]]
id = "x"
engine = "claude"
filename = "should-not-be-here.gguf"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MUST_NOT_FILENAME);
  });

  test("an agentic model must not declare role", () => {
    const toml = `
[[engine]]
id = "claude"
egress = "remote"

[[model]]
id = "x"
engine = "claude"
role = "chat"
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MUST_NOT_ROLE);
  });
});

describe("engine required/forbidden fields", () => {
  test("every engine requires egress", () => {
    const toml = `[[engine]]\nid = "local-llama"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MISSING_EGRESS);
  });

  test("a remote-address engine requires secret", () => {
    const toml = `[[engine]]\nid = "claude-kimi"\negress = "remote"\nbase_url = "https://x"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MISSING_SECRET);
  });

  test("a remote-address engine must not declare models_dir", () => {
    const toml = `
[[engine]]
id = "claude-kimi"
egress = "remote"
base_url = "https://x"
models_dir = "~/models"
secret = { service = "s", username = "u", header = "h" }
`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MUST_NOT_MODELS_DIR);
  });

  test("an unrecognised top-level engine key is fatal", () => {
    const toml = `[[engine]]\nid = "local-llama"\negress = "none"\nmodels_dirs = "~/x"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNRECOGNISED_ENGINE_KEY);
  });

  test("an unrecognised top-level model key is fatal", () => {
    const toml = `${LLAMA_ENGINE}\n[[model]]\nid = "x"\nengine = "local-llama"\nfilename = "f.gguf"\nrole = "chat"\nrolee = "chat"\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNRECOGNISED_MODEL_KEY);
  });
});

test("a filename escaping the engine's models_dir is fatal", () => {
  const toml = `${LLAMA_ENGINE}\n[[model]]\nid = "x"\nengine = "local-llama"\nfilename = "../../etc/passwd"\nrole = "chat"\n`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FILENAME_ESCAPE);
});

test("a filename not present on disk under models_dir is fatal", () => {
  const dir = tempModelsDir();
  const toml = `[[engine]]\nid = "local-llama"\negress = "none"\nmodels_dir = "${dir}"\n\n[[model]]\nid = "x"\nengine = "local-llama"\nfilename = "missing.gguf"\nrole = "chat"\n`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FILENAME_MISSING);
});

test("models_max below the distinct configured roles is fatal", () => {
  const dir = tempModelsDir("ornith.gguf", "vis.gguf");
  const toml = `
[[engine]]
id = "local-llama"
egress = "none"
models_dir = "${dir}"
models_max = 1

[[model]]
id = "ornith"
engine = "local-llama"
filename = "ornith.gguf"
role = "chat"

[[model]]
id = "vis"
engine = "local-llama"
filename = "vis.gguf"
role = "vision"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_MODELS_MAX_ROLES);
});

test("a forbidden agentic flag in [engine.args] is fatal wherever it appears", () => {
  const toml = `
[[engine]]
id = "claude"
egress = "remote"

  [engine.args]
  add-dir = "/etc"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FORBIDDEN_FLAG);
});

test("a forbidden agentic flag in [model.args] is fatal, on an agentic model", () => {
  const toml = `
[[engine]]
id = "claude"
egress = "remote"

[[model]]
id = "sonnet-5"
engine = "claude"

  [model.args]
  add-dir = "/etc"
`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FORBIDDEN_FLAG);
});

test("resolveArgs: a model arg beats an engine arg naming the same key", () => {
  const merged = resolveArgs({ "ctx-size": 4096 }, { "ctx-size": MODEL_CTX_SIZE });
  expect(merged["ctx-size"]).toBe(MODEL_CTX_SIZE);
});

test("loadConfig throws ParseError, not a bare Error, on a fatal rule", () => {
  const toml = `[[engine]]\nid = "x"\n`;
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
