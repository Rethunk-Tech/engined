import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { loadConfig, resolveArgs } from "./config.ts";
import { makeTestRoot } from "./test-support.ts";
import { ParseError } from "./types.ts";

const TEST_ROOT = makeTestRoot("engined-config-test-");

function writeConfig(toml: string): string {
  const dir = mkdtempSync(join(TEST_ROOT, "engined-config-"));
  const path = join(dir, "config.toml");
  Bun.write(path, toml);
  return path;
}

/** Every malformed/unresolvable-hop rule is a ParseError; this captures the message for a substring check the regex-only `.toThrow()` calls elsewhere can't do. */
function chainHopMessage(toml: string): string {
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
const EXPECTED_MODEL_COUNT = 5;
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

// The worked config from config.example.toml, with models_dir swapped for a temp dir whose
// files are pre-created -- the acceptance-level integration case.
function workedConfig(): string {
  const ornithFile = "gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTPv2-25G-ICE.gguf";
  const embedFile = "Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf";
  const visionFile = "Qwen/Qwen3-VL-8B-Instruct-GGUF/Qwen3VL-8B-Instruct-Q8_0.gguf";
  const dir = tempModelsDir(ornithFile, embedFile, visionFile);
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
  spec-draft-n-max = 1
  ctx-size         = 32768

[[model]]
engine   = "local-llama"
id       = "embed"
filename = "${embedFile}"
role     = "embedding"

[[model]]
engine   = "local-llama"
id       = "vision"
filename = "${visionFile}"
role     = "vision"

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

test("the worked config parses clean", () => {
  const cfg = loadConfig(writeConfig(workedConfig()));
  expect(cfg.engines).toHaveLength(EXPECTED_ENGINE_COUNT);
  expect(cfg.models).toHaveLength(EXPECTED_MODEL_COUNT);
  expect(cfg.chains["chain-public"]).toEqual([
    "@/local/ornith",
    "@/claude-kimi/k3",
    "@/claude/sonnet-5",
  ]);
});

const RX_LOCAL_AMBIGUOUS = /"local" must resolve to exactly one engine/;
const RX_DISABLED_UNKNOWN = /no engine or chain here/;

/** Top-level, so it must lead the file: a TOML key after the first table belongs to that table. */
function withDisabled(...names: string[]): string {
  return `disabled = [${names.map((n) => `"${n}"`).join(", ")}]\n${workedConfig()}`;
}

test("a disabled engine keeps its entry, marked, and loses its models and chain hops", () => {
  const cfg = loadConfig(writeConfig(withDisabled("claude", "claude-kimi")));
  // The entry survives so GET /v1/engines can report it as off.
  expect(cfg.engines.find((e) => e.id === "claude")?.disabled).toBe(true);
  expect(cfg.engines.find((e) => e.id === "local-llama")?.disabled).toBeUndefined();
  expect(cfg.models.map((m) => m.id)).not.toContain("sonnet-5");
  expect(cfg.chains["chain-public"]).toEqual(["@/local/ornith"]);
});

test("disabling a chain drops it while its engines stay served", () => {
  const cfg = loadConfig(writeConfig(withDisabled("chain-public")));
  expect(cfg.chains["chain-public"]).toBeUndefined();
  expect(cfg.chains["chain-private"]).toEqual(["@/local/ornith"]);
  expect(cfg.engines.find((e) => e.id === "claude")?.disabled).toBeUndefined();
});

test('disabling the local engine makes a chain\'s "local" hop fatal, not silently remote', () => {
  expect(() => loadConfig(writeConfig(withDisabled("local-llama")))).toThrow(RX_LOCAL_AMBIGUOUS);
});

test("disabled naming nothing that exists is fatal", () => {
  expect(() => loadConfig(writeConfig(withDisabled("claud")))).toThrow(RX_DISABLED_UNKNOWN);
});

test("tilde in models_dir is expanded to an absolute path", () => {
  const toml = `${LLAMA_ENGINE}\n[[model]]\nid = "x"\nengine = "local-llama"\nfilename = "y.gguf"\nrole = "chat"\n`;
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
egress = "none"
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
  test.each([
    ["a bare model id", `${llamaEngineAndModel()}\n[chain]\nc = ["ornith"]\n`, "ornith"],
    ["a bare engine id", `${llamaEngineAndModel()}\n[chain]\nc = ["local-llama"]\n`, "local-llama"],
    [
      "another chain's name",
      `${llamaEngineAndModel()}\n[chain]\nc = ["other"]\nother = ["@/local/ornith"]\n`,
      "other",
    ],
  ])("%s is not a fully-qualified hop, naming it", (_label, toml, hop) => {
    const message = chainHopMessage(toml);
    expect(message).toMatch(RX_NOT_QUALIFIED);
    expect(message).toContain(`"${hop}"`);
  });

  test("a qualified hop naming an unknown engine fails, naming the engine half and the hop", () => {
    const message = chainHopMessage(`${llamaEngineAndModel()}\n[chain]\nc = ["@/nope/ornith"]\n`);
    expect(message).toMatch(RX_UNKNOWN_ENGINE);
    expect(message).toContain('"@/nope/ornith"');
  });

  test("a qualified hop naming an unknown model fails, naming the model half and the hop", () => {
    const message = chainHopMessage(
      `${llamaEngineAndModel()}\n[chain]\nc = ["@/local-llama/nope"]\n`,
    );
    expect(message).toMatch(RX_UNKNOWN_MODEL);
    expect(message).toContain('"@/local-llama/nope"');
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

  // A remote openai-http engine can never carry a models_dir (checkRemoteAddress
  // forbids it structurally), so it still has no local file to check a
  // filename against -- but it is not agentic-cli, and the message must not
  // say it is. requiresFilenameAndRole used to key on models_dir alone, which
  // conflated "no local file" with "agentic" for every engine kind that
  // lacks one, comfy included.
  test("a remote openai-http model must not declare filename, and the message does not call it agentic", () => {
    const message = chainHopMessage(`
[[engine]]
id = "hosted-llama"
egress = "remote"
kind = "openai-http"
base_url = "https://x"
secret = { service = "s", username = "u", header = "h" }

[[model]]
id = "x"
engine = "hosted-llama"
filename = "should-not-be-here.gguf"
`);
    expect(message).toMatch(RX_MUST_NOT_FILENAME);
    expect(message).not.toContain("agentic");
  });

  // `[model.args]` reaches argv only via llama.ts's own preset-INI renderer
  // (`resolveArgs(engine.args, m.args)`), gated on the same
  // `requiresFilenameAndRole` boundary as filename/role. An agentic model's
  // args were parsed and forbidden-flag-checked but then simply never read
  // again anywhere -- the same accept-and-drop failure the closed key sets
  // exist to prevent.
  test("an agentic model's [model.args] is rejected -- nothing ever reads a non-llama model's own args", () => {
    const message = chainHopMessage(`
[[engine]]
id = "claude"
egress = "remote"

[[model]]
id = "x"
engine = "claude"

  [model.args]
  max-turns = 5
`);
    expect(message).toContain('model "x" on engine "claude"');
    expect(message).toContain("args");
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

  // A remote, non-agentic engine launches no process, so its [engine.args]
  // are wire parameters rather than process flags -- `remote.ts` hands them
  // to whichever dialect the door is speaking (ElevenLabs' `model_id` is the
  // first). They were rejected while nothing read them; the moment something
  // does, rejecting them would be the bug.
  test("a remote, non-agentic engine's [engine.args] parse and survive to the entry", () => {
    const toml = `
[[engine]]
id = "hosted-thing"
egress = "remote"
kind = "stt"
base_url = "https://x"
secret = { service = "s", username = "u", header = "h" }

  [engine.args]
  model_id = "scribe_v1"
`;
    const config = loadConfig(writeConfig(toml));
    const engine = config.engines.find((e) => e.id === "hosted-thing");
    expect(engine?.args.model_id).toBe("scribe_v1");
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

const RX_ENGINE_NOT_ARRAY = /"engine" must be an array of tables/;
const RX_MODEL_NOT_ARRAY = /"model" must be an array of tables/;

describe("a scalar where an array of tables belongs", () => {
  // A daemon that starts with zero engines is worse than one that refuses to
  // start: it serves 404s that read like a routing bug rather than a config one.
  test("engine as a scalar is fatal rather than zero engines", () => {
    expect(() => loadConfig(writeConfig('engine = "oops"\n'))).toThrow(RX_ENGINE_NOT_ARRAY);
  });

  test("model as a scalar is fatal", () => {
    expect(() => loadConfig(writeConfig("model = 3\n"))).toThrow(RX_MODEL_NOT_ARRAY);
  });

  test("an absent table is still an empty list", () => {
    const cfg = loadConfig(writeConfig(llamaEngineAndModel()));
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
      'egress = "remote"',
      'kind   = "agentic-cli"',
      "",
      "[engine.args]",
      '"dangerously-skip-permissions" = false',
    ].join("\n");
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_FLOOR_REFUSAL);
  });
});
