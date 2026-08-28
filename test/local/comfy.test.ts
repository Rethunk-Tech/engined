import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import process from "node:process";
import { loadConfig } from "../../src/config.ts";
import { DockerLifecycle } from "../../src/docker.ts";
import { EngineRegistry } from "../../src/engines.ts";
import { LlamaRouter } from "../../src/llama.ts";
import { loadSpec } from "../../src/spec.ts";
import {
  type Config,
  type EngineEntry,
  isContainerSpec,
  type ModelEntry,
} from "../../src/types.ts";
import { requireDaemonStopped } from "./exclusive.ts";

/**
 * Two related local-tier gaps, one shared container pair: a chat GGUF and a
 * comfy container co-resident with no reload of either, and comfy's own
 * idle-stop driven purely by its `/queue` poll -- never by the other
 * engine's request traffic, which is the reason `EngineRegistry` polls
 * comfy at all rather than arming its lease from proxied requests the way
 * every other engine does.
 *
 * Image tags are read from the real engines/local-llama and engines/comfy
 * spec.toml via `loadSpec`, not hardcoded -- local-llama's tag already
 * drifted once within this session (sagaforge-llama-cpp:local ->
 * engined-llama-cpp:local), and the old tag is still a real image on this
 * box, so a hardcoded copy would run green against the wrong artifact
 * instead of failing loudly.
 */
const LOCAL = process.env.ENGINED_LOCAL === "1";
const ENGINES_ROOT = join(import.meta.dir, "..", "..", "engines");
const CONFIG_EXAMPLE = join(import.meta.dir, "..", "..", "config.example.toml");
const BUNX = process.env.ENGINED_BUNX ?? "bunx";
const READY_TIMEOUT_S = 240;
const LLAMA_IDLE_STOP_SECONDS = 900;
// Short enough to observe within the test's own timeout; comfy's real
// production value (config.example.toml's 1800s) would make this
// impractical to run as an automated check at all.
const COMFY_IDLE_STOP_SECONDS = 5;
const COMFY_POLL_INTERVAL_MS = 1000;
const IDLE_POLL_INTERVAL_MS = 500;
const IDLE_WAIT_BUDGET_MS = 30_000;
const TEST_TIMEOUT_MS = 300_000;
/** Stopping two real containers outruns bun's 5s default hook timeout. */
const SHUTDOWN_TIMEOUT_MS = 120_000;

function imageBuilt(image: string): boolean {
  return LOCAL && Bun.spawnSync(["docker", "image", "inspect", image]).exitCode === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** See llama.test.ts's identical helper: /unused + the real models_max satisfy the placeholders enough to read `.image` back. */
function specImage(engine: EngineEntry): string | undefined {
  try {
    const loaded = loadSpec(engine, {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
      presetIni: "/unused",
    });
    return isContainerSpec(loaded.spec) ? loaded.spec.image : undefined;
  } catch {
    // Spec parse failure, or an unresolved placeholder: undefined falls through to a clean skip.
  }
}

interface Fixture {
  config: Config;
  llamaEngine: EngineEntry;
  chatModel: ModelEntry;
  llamaImage?: string;
  comfyImage?: string;
}

/** Never throws: a stale or unreachable config.example.toml is a clean skip, not a crash before any test registers. */
function loadFixture(): Fixture | undefined {
  if (!LOCAL) {
    return;
  }
  try {
    const loaded = loadConfig(CONFIG_EXAMPLE);
    const llamaEngine = loaded.engines.find((e) => e.id === "local-llama");
    const comfyEngine = loaded.engines.find((e) => e.id === "comfy");
    const chatModel = loaded.models.find((m) => m.engine === "local-llama" && m.role === "chat");
    if (!(llamaEngine && comfyEngine && chatModel)) {
      return;
    }
    const config: Config = {
      ...loaded,
      engines: [llamaEngine, { ...comfyEngine, idle_stop_seconds: COMFY_IDLE_STOP_SECONDS }],
      models: [chatModel],
      chains: {},
    };
    return {
      config,
      llamaEngine,
      chatModel,
      llamaImage: specImage(llamaEngine),
      comfyImage: specImage(comfyEngine),
    };
  } catch {
    // No GGUF at the declared path, or any other parse failure: undefined falls through to a clean skip.
  }
}

const FIXTURE = loadFixture();
const HAVE_IMAGES =
  FIXTURE?.llamaImage !== undefined &&
  FIXTURE.comfyImage !== undefined &&
  imageBuilt(FIXTURE.llamaImage) &&
  imageBuilt(FIXTURE.comfyImage);

const READY = LOCAL && HAVE_IMAGES && FIXTURE !== undefined;

// See llama.test.ts: loud when this file would really drive containers.
if (READY) {
  requireDaemonStopped();
}

function skipReason(): string {
  if (FIXTURE === undefined) {
    return "config.example.toml is missing local-llama, comfy, or a local-llama chat model";
  }
  if (FIXTURE.llamaImage === undefined || FIXTURE.comfyImage === undefined) {
    return "a spec did not resolve an image -- check engines/local-llama and engines/comfy spec.toml";
  }
  return `${FIXTURE.llamaImage} and/or ${FIXTURE.comfyImage} are not built`;
}

async function comfyQueueReachable(privateUrl: string | null): Promise<boolean> {
  if (privateUrl === null) {
    return false;
  }
  const res = await fetch(`http://${privateUrl}/queue`);
  return res.status === 200;
}

/**
 * A real Comfy job with no checkpoint in it: `EmptyImage` -> `SaveImage`
 * exercises queue, execute and output exactly as a diffusion graph does,
 * without pinning this test to whichever weights happen to sit in the
 * operator's comfy model tree.
 */
function modelFreeWorkflow(): Record<string, unknown> {
  return {
    "1": {
      class_type: "EmptyImage",
      inputs: { width: 64, height: 64, batch_size: 1, color: 0 },
    },
    "2": {
      class_type: "SaveImage",
      inputs: { images: ["1", 0], filename_prefix: "engined_local_smoke" },
    },
  };
}

/** Submits the job and returns the output image filenames Comfy reports for it. */
async function runComfyJob(privateUrl: string, budgetMs: number): Promise<string[]> {
  const submit = await fetch(`http://${privateUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: modelFreeWorkflow() }),
  });
  if (submit.status !== 200) {
    throw new Error(`comfy /prompt returned ${submit.status}`);
  }
  const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string };

  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const res = await fetch(`http://${privateUrl}/history/${promptId}`);
    const history = (await res.json()) as Record<
      string,
      {
        status?: { completed?: boolean };
        outputs?: Record<string, { images?: { filename: string }[] }>;
      }
    >;
    const entry = history[promptId];
    if (entry?.status?.completed === true) {
      return Object.values(entry.outputs ?? {}).flatMap((o) =>
        (o.images ?? []).map((i) => i.filename),
      );
    }
    await sleep(IDLE_POLL_INTERVAL_MS);
  }
  throw new Error("comfy job did not complete within its budget");
}

async function chatCompletes(router: LlamaRouter, model: ModelEntry): Promise<boolean> {
  const res = await router.proxy(model, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: "Reply with the single word: hi" }],
      max_tokens: 4,
    }),
  });
  return res.status === 200;
}

/** Polls `check` until it returns true or the budget elapses; returns whether it settled true in time. */
async function waitUntil(
  check: () => boolean,
  budgetMs: number,
  intervalMs: number,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (check()) {
      return true;
    }
    await sleep(intervalMs);
  }
  return check();
}

interface Rig {
  lifecycle: DockerLifecycle;
  registry: EngineRegistry;
  router: LlamaRouter;
}

/**
 * Built in `beforeAll`, not the `describe` body: bun still calls a skipped
 * describe's own body to enumerate its tests (confirmed empirically -- only
 * `beforeAll`/`afterAll`/`test` bodies are actually skipped), and
 * `EngineRegistry`'s constructor loads every engine's spec eagerly, which
 * would throw on the `FIXTURE`-less path the moment this file is merely
 * collected, ENGINED_LOCAL or not.
 */
function buildRig(fixture: Fixture): Rig {
  const lifecycle = new DockerLifecycle();
  const registry = new EngineRegistry(fixture.config, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle,
    comfyPollIntervalMs: COMFY_POLL_INTERVAL_MS,
  });
  const router = new LlamaRouter(fixture.llamaEngine, [fixture.chatModel], lifecycle, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    idleStopSeconds: LLAMA_IDLE_STOP_SECONDS,
    readyTimeoutS: READY_TIMEOUT_S,
    presetHostPath: join(import.meta.dir, ".scratch-preset-comfy.ini"),
  });
  return { lifecycle, registry, router };
}

describe.skipIf(!READY)(
  READY
    ? "comfy + local-llama co-residency (local)"
    : `comfy + local-llama co-residency (local): SKIPPED -- ${skipReason()}`,
  () => {
    let rig: Rig | undefined;

    beforeAll(() => {
      rig = buildRig(FIXTURE as Fixture);
    });

    afterAll(async () => {
      await rig?.registry.shutdown();
      await rig?.lifecycle.shutdown();
    }, SHUTDOWN_TIMEOUT_MS);

    test(
      "a chat completion and a comfy start co-reside with no reload of either, and comfy idle-stops off its own /queue poll while llama stays running",
      async () => {
        if (!rig) {
          throw new Error("beforeAll did not run -- rig is unset");
        }
        const { registry, router } = rig;
        const { chatModel } = FIXTURE as Fixture;

        expect(await chatCompletes(router, chatModel)).toBe(true);
        const comfyStatus = await registry.start("comfy");
        expect(comfyStatus.state).toBe("running");
        expect(await comfyQueueReachable(comfyStatus.private_url)).toBe(true);

        // Co-residency, not a reload: the SAME chat completion still answers
        // with comfy now also running, through the identical router instance
        // -- a reload would have needed a fresh container.
        expect(await chatCompletes(router, chatModel)).toBe(true);
        expect(registry.get("local-llama")?.state).toBe("running");

        // Nothing submits a comfy job, so its own /queue poll should observe
        // emptiness and arm idle-stop -- request traffic to llama never
        // reaches comfy's lease, and no request went to comfy's own door
        // either, since comfy's idle timer must be driven by the poll alone.
        const comfyIdled = await waitUntil(
          () => registry.get("comfy")?.state === "installed",
          IDLE_WAIT_BUDGET_MS,
          IDLE_POLL_INTERVAL_MS,
        );
        expect(comfyIdled).toBe(true);

        // llama's own idle-stop (900s) never fired in this ~30s window, and
        // comfy idling never touched it.
        expect(registry.get("local-llama")?.state).toBe("running");
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * `comfy.test.ts` proved a *started* comfy co-resident with a chat GGUF;
 * nothing submitted a job. The reload question only really bites once Comfy
 * has executed something, so this drives a real one.
 */
describe.skipIf(!READY)(
  READY
    ? "comfy runs a real job beside a resident chat GGUF (local)"
    : `comfy runs a real job beside a resident chat GGUF (local): SKIPPED -- ${skipReason()}`,
  () => {
    let rig: Rig | undefined;

    beforeAll(() => {
      rig = buildRig(FIXTURE as Fixture);
    });

    afterAll(async () => {
      await rig?.registry.shutdown();
      await rig?.lifecycle.shutdown();
    }, SHUTDOWN_TIMEOUT_MS);

    test(
      "a comfy job produces an image while the chat model stays resident, and the chat after it pays no reload",
      async () => {
        if (!rig) {
          throw new Error("beforeAll did not run -- rig is unset");
        }
        const { registry, router } = rig;
        const { chatModel } = FIXTURE as Fixture;

        expect(await chatCompletes(router, chatModel)).toBe(true);
        const before = registry.get("local-llama")?.private_url;

        const comfy = await registry.start("comfy");
        expect(comfy.state).toBe("running");
        const images = await runComfyJob(comfy.private_url as string, TEST_TIMEOUT_MS / 2);
        expect(images.length).toBeGreaterThan(0);

        // Same container, same published port: a reload would have replaced
        // both, and engined proxied none of the job -- it went straight to the
        // private_url above.
        expect(await chatCompletes(router, chatModel)).toBe(true);
        expect(registry.get("local-llama")?.state).toBe("running");
        expect(registry.get("local-llama")?.private_url).toBe(before);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
