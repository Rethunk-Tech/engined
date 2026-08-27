import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { handleSpeech } from "../../src/audio.ts";
import { DockerLifecycle } from "../../src/docker.ts";
import { loadSpec } from "../../src/spec.ts";
import type { EngineEntry } from "../../src/types.ts";
import { isContainerSpec } from "../../src/types.ts";

/**
 * Drives `handleSpeech` (audio.ts) against the real chatterbox container
 * rather than the fake `Bun.serve` double `src/audio.test.ts` uses, and
 * drives `DockerLifecycle.probe` against real docker for whisper's
 * artifact-missing status (the non-local suite already proves that same
 * logic path, but entirely against a fake `Exec`). Closes local-tier gaps:
 * nothing until this file proved the chatterbox door against a real
 * NDJSON-speaking process, or proved the "unavailable, naming the artifact's
 * obtain command" status against a real image.
 */
const LOCAL = process.env.ENGINED_LOCAL === "1";
const ENGINES_ROOT = join(import.meta.dir, "..", "..", "engines");
const BUNX = process.env.ENGINED_BUNX ?? "bunx";
const READY_TIMEOUT_S = 120;
const IDLE_STOP_SECONDS = 60;
const TEST_TIMEOUT_MS = 180_000;

function imageBuilt(image: string): boolean {
  return LOCAL && Bun.spawnSync(["docker", "image", "inspect", image]).exitCode === 0;
}

/**
 * Read from the real spec.toml rather than hardcoded -- local-llama's own
 * image tag drifted mid-session (see llama.test.ts), and a hardcoded copy
 * here would be exactly the same risk for chatterbox/whisper the next time
 * either gets its own vendored Dockerfile and a fresh tag. `models_dir:
 * "/unused"` only satisfies whisper's `{models_dir}` placeholder enough to
 * substitute cleanly; chatterbox's spec has no such placeholder.
 */
function specImage(id: string): string | undefined {
  try {
    const loaded = loadSpec(
      { id, egress: "none", args: {}, models_dir: "/unused" },
      { enginesRoot: ENGINES_ROOT, bunx: BUNX },
    );
    return isContainerSpec(loaded.spec) ? loaded.spec.image : undefined;
  } catch {
    // Spec parse failure, or an unresolved placeholder: undefined falls through to a clean skip.
  }
}

const CHATTERBOX_IMAGE = LOCAL ? specImage("chatterbox") : undefined;
const WHISPER_IMAGE = LOCAL ? specImage("whisper") : undefined;
const HAVE_CHATTERBOX = CHATTERBOX_IMAGE !== undefined && imageBuilt(CHATTERBOX_IMAGE);
const HAVE_WHISPER = WHISPER_IMAGE !== undefined && imageBuilt(WHISPER_IMAGE);

function describeTitle(base: string, ready: boolean, reason: string): string {
  return ready ? base : `${base}: SKIPPED -- ${reason}`;
}

describe.skipIf(!HAVE_CHATTERBOX)(
  describeTitle(
    "chatterbox speech door (local)",
    HAVE_CHATTERBOX,
    CHATTERBOX_IMAGE === undefined
      ? "chatterbox's spec.toml did not resolve an image"
      : `${CHATTERBOX_IMAGE} is not built`,
  ),
  () => {
    const lifecycle = new DockerLifecycle();
    const engine: EngineEntry = { id: "chatterbox", egress: "none", args: {} };
    const loaded = loadSpec(engine, { enginesRoot: ENGINES_ROOT, bunx: BUNX });
    if (!isContainerSpec(loaded.spec)) {
      throw new Error("chatterbox spec.toml did not parse as a container spec");
    }
    const { spec } = loaded;

    afterAll(async () => {
      await lifecycle.shutdown();
    });

    test(
      "a real chatterbox container starts on demand and its NDJSON is translated into real WAV bytes",
      async () => {
        const start = async (id: string) => {
          const status = await lifecycle.start(id, spec, {
            idleStopSeconds: IDLE_STOP_SECONDS,
            readyTimeoutS: READY_TIMEOUT_S,
            specSource: loaded.source,
          });
          return { private_url: status.private_url };
        };

        const result = await handleSpeech({ model: "chatterbox", input: "hello there" }, start);

        expect(result.status).toBe(200);
        expect(result.bytes).toBeDefined();
        const bytes = result.bytes as Uint8Array;
        // The WAV RIFF magic, not just "some bytes came back" -- a door
        // that forwarded the raw NDJSON envelope unparsed would also
        // produce a non-empty byte array.
        expect(Buffer.from(bytes.slice(0, 4)).toString("ascii")).toBe("RIFF");
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * A scratch, empty `models_dir` keeps this from ever touching the
 * operator's real installed whisper model files -- the image is real, only
 * the "no artifact here" fact is manufactured, not the operator's actual
 * installed state.
 */
describe.skipIf(!HAVE_WHISPER)(
  describeTitle(
    "whisper unavailable status against real docker (local)",
    HAVE_WHISPER,
    WHISPER_IMAGE === undefined
      ? "whisper's spec.toml did not resolve an image"
      : `${WHISPER_IMAGE} is not built`,
  ),
  () => {
    const scratchModelsDir = HAVE_WHISPER
      ? mkdtempSync(join(tmpdir(), "engined-whisper-empty-"))
      : "";

    afterAll(() => {
      if (scratchModelsDir !== "") {
        rmSync(scratchModelsDir, { recursive: true, force: true });
      }
    });

    test(
      "an empty models_dir reports unavailable naming the artifact's own obtain command, via real image inspection",
      async () => {
        const lifecycle = new DockerLifecycle();
        const engine: EngineEntry = {
          id: "whisper",
          egress: "none",
          args: {},
          models_dir: scratchModelsDir,
        };
        const loaded = loadSpec(engine, { enginesRoot: ENGINES_ROOT, bunx: BUNX });
        if (!isContainerSpec(loaded.spec)) {
          throw new Error("whisper spec.toml did not parse as a container spec");
        }

        const status = await lifecycle.probe("whisper", loaded.spec, loaded.source);

        expect(status.state).toBe("unavailable");
        expect(status.state).not.toBe("installed");
        // Never a container that starts and dies: the image itself must
        // have been found (otherwise fix would be a "docker build"
        // command, not this artifact's own obtain line).
        expect(status.fix).toBe(loaded.spec.artifacts[0]?.obtain);
        expect(status.fix).toContain("curl");
      },
      TEST_TIMEOUT_MS,
    );
  },
);
