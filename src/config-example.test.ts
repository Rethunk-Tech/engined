import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.ts";
import { dataHome } from "./paths.ts";

/**
 * config.example.toml is the only committed, always-parsing reference for
 * how to configure this daemon -- this file is the only copy that is
 * pruning, not a promise it still parses. The real GGUFs it names are tens
 * of gigabytes each and live only on the box that downloaded them, so this
 * swaps local-llama's models_dir for a temp dir carrying empty placeholders
 * at the same relative paths (same pattern as config.test.ts's
 * `tempModelsDir`), rather than requiring a fresh clone to have real
 * weights on disk just to run the suite.
 */
const LOCAL_LLAMA_MODELS_DIR_RE = /models_dir\s*=\s*"~\/\.local\/share\/engined-models\/llm"/;

// Already alphabetised, so the assertion below can sort actual output the
// same way without needing a matching compare function here too.
const EXPECTED_ENGINE_IDS = [
  "chatterbox",
  "claude",
  "claude-kimi",
  "comfy",
  "elevenlabs",
  "kokoro",
  "local-llama",
  "openai",
  "piper",
  "whisper",
];

const EXPECTED_MODEL_IDS = ["embed", "gpt-5.4-mini", "k3", "ornith", "sonnet-5", "vision"];

/** Empty placeholders at the same relative paths the example config's GGUFs name, under a fresh scratch dir. */
function placeExampleModels(modelsDir: string): void {
  for (const rel of [
    "gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTPv2-25G-ICE.gguf",
    "Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf",
    "Qwen/Qwen3-VL-8B-Instruct-GGUF/Qwen3VL-8B-Instruct-Q8_0.gguf",
  ]) {
    const full = join(modelsDir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "");
  }
}

/** `raw` with local-llama's real models_dir swapped for the scratch one, written to a fresh config.toml. */
function writePatchedExampleConfig(raw: string, modelsDir: string): string {
  const patched = raw.replace(LOCAL_LLAMA_MODELS_DIR_RE, `models_dir = "${modelsDir}"`);
  const configDir = mkdtempSync(join(tmpdir(), "engined-example-config-"));
  const configPath = join(configDir, "config.toml");
  writeFileSync(configPath, patched);
  return configPath;
}

test("config.example.toml parses through the real loadConfig()", () => {
  const repoRoot = join(import.meta.dir, "..");
  const raw = readFileSync(join(repoRoot, "config.example.toml"), "utf8");
  expect(raw).toMatch(LOCAL_LLAMA_MODELS_DIR_RE);

  const modelsDir = mkdtempSync(join(tmpdir(), "engined-example-models-"));
  placeExampleModels(modelsDir);

  const configPath = writePatchedExampleConfig(raw, modelsDir);
  const config = loadConfig(configPath);

  const byName = (a: string, b: string) => a.localeCompare(b);
  expect(config.engines.map((e) => e.id).sort(byName)).toEqual(EXPECTED_ENGINE_IDS);
  expect(config.models.map((m) => m.id).sort(byName)).toEqual(EXPECTED_MODEL_IDS);
  expect(config.chains["chain-private"]).toEqual(["@/local/ornith"]);
  expect(config.chains["chain-public"]).toEqual([
    "@/local/ornith",
    "@/claude-kimi/k3",
    "@/claude/sonnet-5",
    "@/openai/gpt-5.4-mini",
  ]);

  // whisper's spec needs models_dir on the wire (its bind mount and
  // artifact-fetch commands both use it) -- the exact gap the operator's
  // real installed config was found missing before this file existed.
  const whisper = config.engines.find((e) => e.id === "whisper");
  // The rule, not the literal: `~/.local/share/` resolves through the same
  // XDG_DATA_HOME-aware dataHome() that engined's own install dir uses, so
  // this stays that directory's sibling under any XDG_DATA_HOME -- it is
  // never a plain $HOME expansion of the example's tilde text.
  expect(whisper?.models_dir).toBe(join(dataHome(), "engined-models/whisper"));

  // The remote STT engine's whole shape lives in this file -- it has no spec
  // directory to carry any of it. A `kind` lost to an edit would make it an
  // engine of no kind, and a lost `model_id` would send the door's own
  // engine id upstream as a model.
  const elevenlabs = config.engines.find((e) => e.id === "elevenlabs");
  expect(elevenlabs?.kind).toBe("stt");
  expect(elevenlabs?.egress).toBe("remote");
  expect(elevenlabs?.secret?.header).toBe("xi-api-key");
  expect(elevenlabs?.args.model_id).toBe("scribe_v1");
});
