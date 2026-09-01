import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadSpec } from "./spec.ts";
import {
  BUNX,
  engine as baseEngine,
  ENGINES_ROOT,
  makeTestRoot,
  writeEngineSpec,
} from "./test-support.ts";
import type { EngineEntry } from "./types.ts";

const RX_HOME_PATH = /\/home\/[^/"]+/;

const TEST_ROOT = makeTestRoot("engined-spec-test-");

/** Every shipped-spec test in this file resolves against the real `claude` engine unless told otherwise. */
function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return baseEngine({ id: "claude", ...overrides });
}

/** A fresh `<root>/<id>/spec.toml` written with `content`, root usable as `enginesRoot`. */
function specDir(id: string, content: string): string {
  const root = mkdtempSync(join(TEST_ROOT, "engined-spec-"));
  writeEngineSpec(root, id, content);
  return root;
}

const VALID_CONTAINER = `
kind = "stt"
upstream = "self"
image = "ghcr.io/example/whisper@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/audio/transcriptions"]
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
    const loaded = loadSpec(engine({ agent_version: "1.2.3" }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    });
    expect(loaded.spec.kind).toBe("agentic-cli");
    expect(loaded.spec.command).toEqual([BUNX, "@anthropic-ai/claude-code@1.2.3", "-p"]);
  });

  test("cursor resolves clean", () => {
    const loaded = loadSpec(engine({ id: "cursor", agent_version: "2026.08.28-50f0823" }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    });
    expect(loaded.spec.kind).toBe("agentic-cli");
    expect(loaded.spec.command).toEqual([BUNX, "cursor-agent@2026.08.28-50f0823", "-p"]);
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
      // medium.en by default; EngineRegistry.start (engines.ts) rewrites this
      // pair's second token per the route a caller actually names.
      const { command } = loaded.spec;
      expect(command[command.indexOf("-m") + 1]).toBe("/models/ggml-medium.en-q8_0.bin");
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
          path: "/models/ggml-medium.en-q8_0.bin",
          obtain:
            "curl -fL -o /data/models/ggml-medium.en-q8_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en-q8_0.bin",
        },
        {
          path: "/models/ggml-small.en-q8_0.bin",
          obtain:
            "curl -fL -o /data/models/ggml-small.en-q8_0.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q8_0.bin",
        },
        {
          path: "/models/ggml-silero-v6.2.0.bin",
          obtain:
            "curl -fL -o /data/models/ggml-silero-v6.2.0.bin https://huggingface.co/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin",
        },
      ]);
    }
  });

  /**
   * The four shipped TTS engines, against the real spec files: this is what
   * `GET /engined/v1/engines` advertises, and a wrong answer either costs a consumer
   * a 502 per streamed request or costs it streaming it could have had.
   */
  test.each([
    ["piper", true],
    ["kokoro", true],
    ["chatterbox-multi", true],
    ["chatterbox-en", true],
  ] as const)("the shipped %s spec declares streaming = %p", (id, streaming) => {
    const loaded = loadSpec(engine({ id }), { enginesRoot: ENGINES_ROOT, bunx: BUNX });
    expect(loaded.spec.streaming).toBe(streaming);
  });

  // The regression guard: a literal /home/<user>/... path in a shipped spec
  // leaks the operator's username into a file that ships. Assert against the
  // real committed files so a reintroduced literal fails here regardless of
  // what any loadSpec() call above happens to substitute.
  test.each(["whisper", "cursor"])(
    "the shipped %s spec.toml contains no absolute host path",
    (id) => {
      const raw = readFileSync(join(ENGINES_ROOT, id, "spec.toml"), "utf8");
      expect(raw).not.toMatch(RX_HOME_PATH);
    },
  );
});

test("volume.name and artifact.obtain placeholders resolve to the supplied values", () => {
  const root = specDir(
    "stt-engine",
    `
kind = "stt"
upstream = "self"
image = "ghcr.io/example/whisper@sha256:aaaa"
obtain = "pull"
serves = ["/openai/v1/audio/transcriptions"]
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

// volume.name and artifact.obtain both resolve through the same generic
// substituteDeep recursion proven above -- no per-field branching to cover
// beyond it. artifact.path is different (see the test below): it bypassed
// substituteDeep entirely, which is a real defect, not a generic case.
test("an unresolved placeholder in artifact.path is fatal, naming it", () => {
  // artifact.path was never scanned for placeholders: hostPathFor() prefix-matches
  // it against the already-substituted volume.path, so a literal placeholder here
  // silently downgrades the artifact check rather than failing loudly at parse.
  const root = specDir(
    "x",
    `kind = "stt"\nupstream = "self"\nimage = "img"\nobtain = "pull"\nserves = []\ncommand = ["-m", "x"]\n\n[ready]\npath = "/health"\nstatus = 200\n\n[[artifact]]\npath = "{nope}/x.bin"\nobtain = "curl -o /models/x.bin https://example.com/x.bin"\n`,
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
  const root = mkdtempSync(join(TEST_ROOT, "engined-spec-"));
  expect(() => loadSpec(engine({ id: "ghost" }), { enginesRoot: root, bunx: BUNX })).toThrow(
    "ghost/spec.toml",
  );
});

test("an unresolved placeholder is fatal, naming it", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nupstream = "optional"\nagent = "claude"\nserves = []\ncommand = ["{bunx}", "@anthropic-ai/claude-code@{agent_version}", "{nope}"]\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", agent_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("{nope}");
});

test("spec_dir override replaces wholesale: an omitted field is absent, not inherited", () => {
  const overrideRoot = specDir(
    "whisper",
    `kind = "stt"\nobtain = "pull"\nserves = ["/openai/v1/audio/transcriptions"]\ncommand = ["-m", "x"]\n\n[ready]\npath = "/health"\nstatus = 200\n`,
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
    `kind = "agentic-cli"\nagent = "claude"\nserves = []\ncommand = ["{bunx}"]\nport = 8080\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", agent_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("port");
});

test("a forbidden flag reintroduced by a spec_dir override is fatal", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nupstream = "optional"\nagent = "claude"\nserves = []\ncommand = ["{bunx}", "@anthropic-ai/claude-code@{agent_version}", "--dangerously-skip-permissions"]\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", agent_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("dissolves the read-only floor");
});

test("an agentic spec carrying a container-only key is fatal, naming the key", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nagent = "claude"\nserves = []\ncommand = ["{bunx}"]\nimage = "nope"\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", agent_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow('"image"');
});

test("streaming is valid on any kind now, not just tts", () => {
  const root = specDir(
    "x",
    `kind = "stt"\nupstream = "self"\nimage = "i"\nobtain = "pull"\nserves = []\ncommand = []\nstreaming = true\n\n[ready]\npath = "/health"\nstatus = 200\n`,
  );
  const loaded = loadSpec(engine({ id: "x" }), { enginesRoot: root, bunx: BUNX });
  if (loaded.spec.kind === "agentic-cli") {
    throw new Error("expected a container spec");
  }
  expect(loaded.spec.streaming).toBe(true);
});

test("command[0] redirected away from {bunx} is fatal", () => {
  const root = specDir(
    "x",
    `kind = "agentic-cli"\nagent = "claude"\nserves = []\ncommand = ["/usr/bin/evil"]\n`,
  );
  expect(() =>
    loadSpec(engine({ id: "x", agent_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow("{bunx}");
});

test.each([
  ["a container spec", `kind = "stt"\nimage = "i"\nobtain = "pull"\nserves = []\ncommand = []\n`],
  [
    "an agentic spec",
    `kind = "agentic-cli"\nagent = "claude"\nserves = []\ncommand = ["{bunx}", "@anthropic-ai/claude-code@{agent_version}", "-p"]\n`,
  ],
])("%s with no upstream trait is fatal", (_label, toml) => {
  const root = specDir("x", toml);
  expect(() =>
    loadSpec(engine({ id: "x", agent_version: "1.0.0" }), { enginesRoot: root, bunx: BUNX }),
  ).toThrow('needs "upstream"');
});

test("agent_version resolving to latest is fatal", () => {
  expect(() =>
    loadSpec(engine({ agent_version: "latest" }), { enginesRoot: ENGINES_ROOT, bunx: BUNX }),
  ).toThrow("latest");
});
