import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec } from "./spec.ts";
import type { EngineEntry } from "./types.ts";

const ENGINES_ROOT = join(import.meta.dir, "..", "engines");
const BUNX = "/home/x/.bun/bin/bunx";
const RX_HOME_PATH = /\/home\/[^/"]+/;

function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return { id: "claude", egress: "none", args: {}, ...overrides };
}

/** A fresh `<root>/<id>/spec.toml` written with `content`, root usable as `enginesRoot`. */
function specDir(id: string, content: string): string {
  const root = mkdtempSync(join(tmpdir(), "engined-spec-"));
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "spec.toml"), content);
  return root;
}

const VALID_CONTAINER = `
kind = "stt"
image = "ghcr.io/example/whisper@sha256:aaaa"
obtain = "pull"
serves = ["/v1/audio/transcriptions"]
command = ["-m", "{models_dir}/model.bin"]

[ready]
path = "/health"
status = 200

[[volume]]
name = "engined-whisper-models"
path = "/models"
`;

describe("shipped specs", () => {
  test("claude resolves clean", () => {
    const loaded = loadSpec(engine({ claude_version: "1.2.3" }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    });
    expect(loaded.spec.kind).toBe("agentic-cli");
    expect(loaded.overridden).toBe(false);
    expect(loaded.spec.command).toEqual([BUNX, "@anthropic-ai/claude-code@1.2.3", "-p"]);
  });

  test("whisper as shipped resolves clean, and keeps its POST probe and accept range", () => {
    // A probe declared in a spec and dropped by the loader is the silent
    // failure this field exists to prevent, so assert the parsed values rather
    // than that loading succeeded.
    const loaded = loadSpec(engine({ id: "whisper", models_dir: "/data/models" }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    });
    expect(loaded.spec.kind).toBe("stt");
    if (loaded.spec.kind !== "agentic-cli") {
      expect(loaded.spec.ready.path).toBe("/v1/audio/transcriptions");
      expect(loaded.spec.ready.method).toBe("POST");
      expect(loaded.spec.ready.accept).toEqual({ min: 200, max: 499 });
      // {models_dir} and {spec_dir} must resolve to the supplied engine
      // config and the installed spec directory, not survive as literals.
      const specDirPath = join(ENGINES_ROOT, "whisper");
      expect(loaded.spec.volumes).toEqual([
        { name: "/data/models", path: "/models", read_only: true },
        { name: specDirPath, path: "/spec", read_only: true },
      ]);
      expect(loaded.spec.artifacts).toEqual([
        {
          path: "/models/ggml-large-v3-turbo-q8_0.bin",
          obtain:
            "curl -fL -o /data/models/ggml-large-v3-turbo-q8_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q8_0.bin",
        },
        {
          path: "/models/ggml-silero-v6.2.0.bin",
          obtain:
            "curl -fL -o /data/models/ggml-silero-v6.2.0.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
        },
      ]);
    }
  });

  // The regression guard: the earlier literal /home/<user>/... paths leaked
  // the operator's username into a file that ships. Assert against the real
  // committed file so a reintroduced literal fails here regardless of what
  // any loadSpec() call above happens to substitute.
  test("the shipped whisper spec.toml contains no absolute host path", () => {
    const raw = readFileSync(join(ENGINES_ROOT, "whisper", "spec.toml"), "utf8");
    expect(raw).not.toMatch(RX_HOME_PATH);
  });
});

test("volume.name and artifact.obtain placeholders resolve to the supplied values", () => {
  const root = specDir(
    "stt-engine",
    `
kind = "stt"
image = "ghcr.io/example/whisper@sha256:aaaa"
obtain = "pull"
serves = ["/v1/audio/transcriptions"]
command = ["-m", "{models_dir}/model.bin"]

[ready]
path = "/health"
status = 200

[[volume]]
name = "{models_dir}"
path = "/models"

[[artifact]]
path = "/models/model.bin"
obtain = "curl -fL -o {models_dir}/model.bin --config {spec_dir}/fetch.conf https://example.com/model.bin"
`,
  );
  const loaded = loadSpec(engine({ id: "stt-engine", models_dir: "/data/models" }), {
    enginesRoot: root,
    bunx: BUNX,
  });
  if (loaded.spec.kind === "agentic-cli") {
    throw new Error("expected a container spec");
  }
  const specDirPath = join(root, "stt-engine");
  expect(loaded.spec.volumes).toEqual([{ name: "/data/models", path: "/models" }]);
  expect(loaded.spec.artifacts).toEqual([
    {
      path: "/models/model.bin",
      obtain: `curl -fL -o /data/models/model.bin --config ${specDirPath}/fetch.conf https://example.com/model.bin`,
    },
  ]);
});

test("an unresolved placeholder in volume.name is fatal, naming it", () => {
  const root = specDir(
    "x",
    `kind = "stt"\nimage = "img"\nobtain = "pull"\nserves = []\ncommand = ["-m", "x"]\n\n[ready]\npath = "/health"\nstatus = 200\n\n[[volume]]\nname = "{nope}"\npath = "/models"\n`,
  );
  expect(() => loadSpec(engine({ id: "x" }), { enginesRoot: root, bunx: BUNX })).toThrow("{nope}");
});

test("an unresolved placeholder in artifact.obtain is fatal, naming it", () => {
  const root = specDir(
    "x",
    `kind = "stt"\nimage = "img"\nobtain = "pull"\nserves = []\ncommand = ["-m", "x"]\n\n[ready]\npath = "/health"\nstatus = 200\n\n[[artifact]]\npath = "/models/x.bin"\nobtain = "curl -o {nope}/x.bin https://example.com/x.bin"\n`,
  );
  expect(() => loadSpec(engine({ id: "x" }), { enginesRoot: root, bunx: BUNX })).toThrow("{nope}");
});

test("a container spec with a full round trip resolves clean", () => {
  const root = specDir("stt-engine", VALID_CONTAINER);
  const loaded = loadSpec(engine({ id: "stt-engine", models_dir: "/data/models" }), {
    enginesRoot: root,
    bunx: BUNX,
  });
  expect(loaded.spec.kind).toBe("stt");
  if (loaded.spec.kind !== "agentic-cli") {
    expect(loaded.spec.command).toEqual(["-m", "/data/models/model.bin"]);
    expect(loaded.spec.ready).toEqual({ path: "/health", status: 200 });
    expect(loaded.spec.volumes).toEqual([{ name: "engined-whisper-models", path: "/models" }]);
  }
});

test("missing spec directory is fatal, naming the file", () => {
  const root = mkdtempSync(join(tmpdir(), "engined-spec-"));
  expect(() => loadSpec(engine({ id: "ghost" }), { enginesRoot: root, bunx: BUNX })).toThrow(
    "ghost/spec.toml",
  );
});

test("an unresolved placeholder is fatal, naming it", () => {
  const root = specDir("x", `kind = "agentic-cli"\nserves = []\ncommand = ["{bunx}", "{nope}"]\n`);
  expect(() =>
    loadSpec(engine({ id: "x", claude_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("{nope}");
});

test("spec_dir override replaces wholesale: an omitted field is absent, not inherited", () => {
  const overrideRoot = specDir(
    "whisper",
    `kind = "stt"\nobtain = "pull"\nserves = ["/v1/audio/transcriptions"]\ncommand = ["-m", "x"]\n\n[ready]\npath = "/health"\nstatus = 200\n`,
  );
  // The override omits "image", which the shipped spec carries; it must not
  // fall back to it.
  expect(() =>
    loadSpec(engine({ id: "whisper", spec_dir: join(overrideRoot, "whisper") }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    }),
  ).toThrow("image");
});

test("a port key anywhere in a spec is fatal, naming it", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nserves = []\ncommand = ["{bunx}"]\nport = 8080\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", claude_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("port");
});

test("a forbidden flag reintroduced by a spec_dir override is fatal", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nserves = []\ncommand = ["{bunx}", "--dangerously-skip-permissions"]\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", claude_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("dissolves the read-only floor");
});

test("an agentic spec carrying a container-only key is fatal, naming the key", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nserves = []\ncommand = ["{bunx}"]\nimage = "nope"\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", claude_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow('"image"');
});

test("command[0] redirected away from {bunx} is fatal", () => {
  const root = specDir("x", `kind = "agentic-cli"\nserves = []\ncommand = ["/usr/bin/evil"]\n`);
  expect(() =>
    loadSpec(engine({ id: "x", claude_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("{bunx}");
});

test("claude_version resolving to latest is fatal", () => {
  expect(() =>
    loadSpec(engine({ claude_version: "latest" }), { enginesRoot: ENGINES_ROOT, bunx: BUNX }),
  ).toThrow("latest");
});
