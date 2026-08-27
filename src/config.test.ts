import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveArgs } from "./config.ts";
import { ParseError } from "./types.ts";

function writeConfig(toml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "engined-config-"));
  const path = join(dir, "config.toml");
  Bun.write(path, toml);
  return path;
}

const LLAMA_ENGINE = `
[[engine]]
id = "local-llama"
egress = "none"
models_dir = "~/llm-models"
`;

const CHAT_MODEL = `
[[model]]
id = "ornith"
engine = "local-llama"
filename = "ornith.gguf"
role = "chat"
`;

const EXPECTED_ENGINE_COUNT = 7;
const EXPECTED_MODEL_COUNT = 4;
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
const RX_MISSING_FILENAME = /is missing required "filename"/;
const RX_MUST_NOT_FILENAME = /must not declare "filename"/;
const RX_MUST_NOT_ROLE = /must not declare "role"/;
const RX_MISSING_EGRESS = /is missing required "egress"/;
const RX_MISSING_SECRET = /missing required "secret"/;
const RX_MUST_NOT_MODELS_DIR = /must not declare "models_dir"/;
const RX_UNRECOGNISED_ENGINE_KEY = /unrecognised key "models_dirs"/;
const RX_UNRECOGNISED_MODEL_KEY = /unrecognised key "rolee"/;
const RX_FILENAME_ESCAPE = /not under engine's "models_dir"/;
const RX_MODELS_MAX_ROLES = /below its 2 distinct configured roles/;
const RX_FORBIDDEN_FLAG = /dissolves the read-only floor/;

// The worked config from TODO.md, verbatim -- the acceptance-level integration case.
const WORKED_CONFIG = `
listen_port           = 29200
chat_timeout_seconds  = 600
agent_timeout_seconds = 3600

[[model]]
id       = "ornith"
engine   = "local-llama"
filename = "gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTPv2-25G-ICE.gguf"
role     = "chat"

  [model.args]
  spec-type        = "draft-mtp"
  spec-draft-p-min = 0.1
  spec-n-max       = 1
  ctx-size         = 32768

[[model]]
engine   = "local-llama"
id       = "qwen36-q8"
filename = "llmfan46/Qwen3.6-35B-A3B-uncensored-heretic-GGUF/Qwen3.6-35B-A3B-uncensored-heretic-Q8_0.gguf"
aliases  = ["qwen3.6"]
role     = "chat"

  [model.args]
  ctx-size = 32768

[[model]]
engine = "claude"
id     = "sonnet-5"

[[model]]
engine = "claude-kimi"
id     = "kimi-k3"

[[engine]]
id                = "local-llama"
egress            = "none"
models_dir        = "~/llm-models"
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
chain-public  = ["@/local/ornith", "@/claude-kimi/kimi-k3", "@/claude/sonnet-5"]
`;

test("the worked config from TODO.md parses clean", () => {
  const cfg = loadConfig(writeConfig(WORKED_CONFIG));
  expect(cfg.engines).toHaveLength(EXPECTED_ENGINE_COUNT);
  expect(cfg.models).toHaveLength(EXPECTED_MODEL_COUNT);
  expect(cfg.chains["chain-public"]).toEqual([
    "@/local/ornith",
    "@/claude-kimi/kimi-k3",
    "@/claude/sonnet-5",
  ]);
  // Tilde expanded: a bind-mount needs the absolute path, not the literal tilde.
  const llama = cfg.engines.find((e) => e.id === "local-llama");
  expect(llama?.models_dir).toBe(join(homedir(), "llm-models"));
});

test("defaults apply when listen_port/chat_timeout/agent_timeout are absent", () => {
  const cfg = loadConfig(writeConfig(LLAMA_ENGINE + CHAT_MODEL));
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
    const toml = `${LLAMA_ENGINE}${CHAT_MODEL}\n[chain]\nc = ["ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_NOT_QUALIFIED);
  });

  test("a qualified hop naming an unknown engine fails, naming the engine half", () => {
    const toml = `${LLAMA_ENGINE}${CHAT_MODEL}\n[chain]\nc = ["@/nope/ornith"]\n`;
    expect(() => loadConfig(writeConfig(toml))).toThrow(RX_UNKNOWN_ENGINE);
  });

  test("a qualified hop naming an unknown model fails, naming the model half", () => {
    const toml = `${LLAMA_ENGINE}${CHAT_MODEL}\n[chain]\nc = ["@/local-llama/nope"]\n`;
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

test("models_max below the distinct configured roles is fatal", () => {
  const toml = `
[[engine]]
id = "local-llama"
egress = "none"
models_dir = "~/llm-models"
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

test("resolveArgs: a model arg beats an engine arg naming the same key", () => {
  const merged = resolveArgs({ "ctx-size": 4096 }, { "ctx-size": MODEL_CTX_SIZE });
  expect(merged["ctx-size"]).toBe(MODEL_CTX_SIZE);
});

test("loadConfig throws ParseError, not a bare Error, on a fatal rule", () => {
  const toml = `[[engine]]\nid = "x"\n`;
  expect(() => loadConfig(writeConfig(toml))).toThrow(ParseError);
});
