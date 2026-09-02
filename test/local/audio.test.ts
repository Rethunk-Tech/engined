import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleSpeech, handleTranscription } from "../../src/audio.ts";
import { loadConfig } from "../../src/config.ts";
import { DockerLifecycle, dockerExec } from "../../src/docker.ts";
import { loadSpec } from "../../src/spec.ts";
import { type EngineEntry, isContainerSpec } from "../../src/types.ts";
import {
  BUNX,
  CONFIG_EXAMPLE,
  ENGINES_ROOT,
  imageBuilt,
  LOCAL,
  requireNoResidentEngine,
  specImage,
  TEST_NAME_PREFIX,
} from "./exclusive.ts";
import { skipTitle } from "./fixtures.ts";

/**
 * Drives `handleSpeech` (audio.ts) against the real chatterbox-multi container
 * rather than the fake `Bun.serve` double `src/audio.test.ts` uses, and
 * drives `DockerLifecycle.probe` against real docker for whisper's
 * artifact-missing status (the non-local suite already proves that same
 * logic path, but entirely against a fake `Exec`). Closes local-tier gaps:
 * nothing until this file proved the chatterbox-multi door against a real
 * NDJSON-speaking process, or proved the "unavailable, naming the artifact's
 * obtain command" status against a real image.
 */
const READY_TIMEOUT_S = 120;
const IDLE_STOP_SECONDS = 60;
const TEST_TIMEOUT_MS = 180_000;
/** Two cold containers and a large-v3 load, back to back. */
const ROUND_TRIP_TIMEOUT_MS = 600_000;

/**
 * whisper's real weights, read from `config.example.toml` against the repo's
 * own `engines/` tree -- the same file and root every sibling suite reads, and
 * the same reason `llama.test.ts` loads it as-is: it is this operator's own
 * configuration, so a clean read here is also a live check that the example
 * still matches the model tree on disk.
 *
 * A failure degrades to a named skip rather than a throw, because `loadConfig`
 * validates the whole file: a route on llama naming a GGUF this box does not
 * hold fails first, and no engine in this suite speaks to llama. `ParseError`
 * carries only a message and a file, so a broken spec and an absent unrelated
 * weight arrive indistinguishable -- the message is carried into the skip
 * title verbatim, so which one it was is still readable at a glance. What is
 * never done is fall back to a directory holding no models, which is green and
 * proves nothing.
 */
function whisperModelsDir(): { dir?: string; error?: string } {
  if (!LOCAL) {
    return { error: 'ENGINED_LOCAL is not "1"' };
  }
  try {
    const dir = loadConfig(CONFIG_EXAMPLE, ENGINES_ROOT).engines.find(
      (e) => e.id === "whisper",
    )?.models_dir;
    return dir === undefined
      ? { error: `${CONFIG_EXAMPLE}: no whisper engine declaring a models_dir` }
      : { dir };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const WHISPER_MODELS = whisperModelsDir();

/** `models_dir: "/unused"` only satisfies whisper's `{models_dir}` placeholder enough to substitute cleanly; chatterbox-multi's spec has no such placeholder. */
function ttsEngine(id: string): EngineEntry {
  return { id, args: {}, models_dir: "/unused" };
}

const KOKORO_IMAGE = LOCAL ? specImage(ttsEngine("kokoro")) : undefined;
const PIPER_IMAGE = LOCAL ? specImage(ttsEngine("piper")) : undefined;
const CHATTERBOX_IMAGE = LOCAL ? specImage(ttsEngine("chatterbox-multi")) : undefined;
const WHISPER_IMAGE = LOCAL ? specImage(ttsEngine("whisper")) : undefined;
const HAVE_CHATTERBOX = CHATTERBOX_IMAGE !== undefined && imageBuilt(CHATTERBOX_IMAGE);
const HAVE_KOKORO = KOKORO_IMAGE !== undefined && imageBuilt(KOKORO_IMAGE);
const HAVE_WHISPER = WHISPER_IMAGE !== undefined && imageBuilt(WHISPER_IMAGE);
const HAVE_PIPER = PIPER_IMAGE !== undefined && imageBuilt(PIPER_IMAGE);

// See llama.test.ts: chatterbox-multi's test starts the very container the unit owns.
if (HAVE_CHATTERBOX || HAVE_WHISPER || HAVE_KOKORO || HAVE_PIPER) {
  requireNoResidentEngine();
}

describe.skipIf(!HAVE_CHATTERBOX)(
  skipTitle(
    "chatterbox-multi speech door (local)",
    HAVE_CHATTERBOX,
    CHATTERBOX_IMAGE === undefined
      ? "chatterbox-multi's spec.toml did not resolve an image"
      : `${CHATTERBOX_IMAGE} is not built`,
  ),
  () => {
    const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);
    const engine: EngineEntry = { id: "chatterbox-multi", args: {} };
    const loaded = loadSpec(engine, { enginesRoot: ENGINES_ROOT, bunx: BUNX });
    if (!isContainerSpec(loaded.spec)) {
      throw new Error("chatterbox-multi spec.toml did not parse as a container spec");
    }
    const { spec } = loaded;

    afterAll(async () => {
      await lifecycle.shutdown();
    });

    test(
      "a real chatterbox-multi container starts on demand and its NDJSON is translated into real WAV bytes",
      async () => {
        const start = async (id: string) => {
          const status = await lifecycle.start(id, spec, {
            idleStopSeconds: IDLE_STOP_SECONDS,
            readyTimeoutS: READY_TIMEOUT_S,
            specSource: loaded.source,
          });
          return { private_url: status.private_url };
        };

        const result = await handleSpeech(
          { engine: "chatterbox-multi", input: "hello there" },
          start,
        );

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
  skipTitle(
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
        const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);
        const engine: EngineEntry = {
          id: "whisper",
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

/**
 * Nothing in this tier touched kokoro before this block, and whisper was only
 * ever proved *unavailable* against an empty models_dir -- never transcribing.
 * Each TTS engine is exercised as a round trip on purpose: its own words
 * coming back out of whisper is a stronger claim than either engine
 * answering 200, and it needs no committed audio fixture.
 *
 * Run per TTS engine rather than once over a list of them, because the whole
 * tier is serial against this box's single GPU: piper is the CPU engine and
 * would otherwise be skipped wholesale whenever kokoro's image is missing.
 */
const TTS_ROUND_TRIPS: { id: string; ready: boolean }[] = [
  { id: "kokoro", ready: HAVE_KOKORO },
  { id: "piper", ready: HAVE_PIPER },
];

/** Which of the two preconditions failed, so a skipped round trip never reads as "some image is missing" when the real cause is the example config. */
function roundTripSkipReason(id: string, ready: boolean): string {
  return ready && HAVE_WHISPER
    ? `whisper's models_dir did not resolve: ${WHISPER_MODELS.error}`
    : `${id} or whisper is not built`;
}

for (const tts of TTS_ROUND_TRIPS) {
  const roundTripReady = tts.ready && HAVE_WHISPER && WHISPER_MODELS.dir !== undefined;
  describe.skipIf(!roundTripReady)(
    skipTitle(
      `${tts.id} -> whisper round trip (local)`,
      roundTripReady,
      roundTripSkipReason(tts.id, tts.ready),
    ),
    () => {
      const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);

      function startFor(id: string) {
        const engine: EngineEntry = {
          id,
          args: {},
          models_dir: WHISPER_MODELS.dir,
        };
        const loaded = loadSpec(engine, { enginesRoot: ENGINES_ROOT, bunx: BUNX });
        if (!isContainerSpec(loaded.spec)) {
          throw new Error(`${id} spec.toml did not parse as a container spec`);
        }
        const { spec } = loaded;
        return async (requested: string) => {
          const status = await lifecycle.start(requested, spec, {
            idleStopSeconds: IDLE_STOP_SECONDS,
            readyTimeoutS: READY_TIMEOUT_S,
            specSource: loaded.source,
          });
          return { private_url: status.private_url };
        };
      }

      afterAll(async () => {
        await lifecycle.shutdown();
      });

      test(
        `${tts.id} speaks a phrase and whisper reads that same phrase back`,
        async () => {
          const spoken = await handleSpeech(
            { engine: tts.id, input: "The quick brown fox." },
            startFor(tts.id),
          );
          expect(spoken.status).toBe(200);
          const wav = spoken.bytes as Uint8Array;
          // RIFF, not merely non-empty: a door forwarding the engine's raw
          // NDJSON envelope would also produce bytes.
          expect(Buffer.from(wav.slice(0, 4)).toString("ascii")).toBe("RIFF");

          const heard = await handleTranscription(
            {
              engine: "whisper",
              model: "medium.en",
              file: wav as Uint8Array<ArrayBuffer>,
              response_format: "text",
            },
            startFor("whisper"),
          );
          expect(heard.status).toBe(200);
          // `text` must come back as bare text, not a JSON envelope: a consumer
          // that asks for text stores this body verbatim as the transcript.
          expect(typeof heard.body).toBe("string");
          expect(String(heard.body).toLowerCase()).toContain("quick brown fox");
        },
        ROUND_TRIP_TIMEOUT_MS,
      );
    },
  );
}
