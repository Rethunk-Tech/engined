import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSpec } from "./spec.ts";
import type { EngineEntry } from "./types.ts";

const ENGINES_ROOT = join(import.meta.dir, "..", "engines");
const BUNX = "/home/x/.bun/bin/bunx";

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
    }
  });
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
