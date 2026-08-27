import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import process from "node:process";
import { loadConfig } from "../../src/config.ts";
import { DockerLifecycle } from "../../src/docker.ts";
import { EngineRegistry } from "../../src/engines.ts";
import { LlamaRouter } from "../../src/llama.ts";
import type { Config, EngineEntry, ModelEntry } from "../../src/types.ts";

/**
 * Two related local-tier gaps, one shared container pair: a chat GGUF and a
 * comfy container co-resident with no reload of either, and comfy's own
 * idle-stop driven purely by its `/queue` poll -- never by the other
 * engine's request traffic, which is the reason `EngineRegistry` polls
 * comfy at all rather than arming its lease from proxied requests the way
 * every other engine does.
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

function imageBuilt(image: string): boolean {
  return LOCAL && Bun.spawnSync(["docker", "image", "inspect", image]).exitCode === 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const LLAMA_IMAGE = "sagaforge-llama-cpp:local";
const COMFY_IMAGE = "sagaforge-comfyui:local";
const HAVE_IMAGES = imageBuilt(LLAMA_IMAGE) && imageBuilt(COMFY_IMAGE);

interface Fixture {
  config: Config;
  llamaEngine: EngineEntry;
  chatModel: ModelEntry;
}

/** Never throws: a stale or unreachable config.example.toml is a clean skip, not a crash before any test registers. */
function loadFixture(): Fixture | undefined {
  if (!(LOCAL && HAVE_IMAGES)) {
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
    return { config, llamaEngine, chatModel };
  } catch {
    // No GGUF at the declared path, or any other parse failure: undefined falls through to a clean skip.
  }
}

const FIXTURE = loadFixture();
const READY = LOCAL && HAVE_IMAGES && FIXTURE !== undefined;

function skipReason(): string {
  if (!HAVE_IMAGES) {
    return `${LLAMA_IMAGE} and/or ${COMFY_IMAGE} are not built`;
  }
  return "config.example.toml is missing local-llama, comfy, or a local-llama chat model";
}

async function comfyQueueReachable(privateUrl: string | null): Promise<boolean> {
  if (privateUrl === null) {
    return false;
  }
  const res = await fetch(`http://${privateUrl}/queue`);
  return res.status === 200;
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
    });

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
