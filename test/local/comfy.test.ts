import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DockerLifecycle, dockerExec } from "../../src/docker.ts";
import { EngineRegistry } from "../../src/engines.ts";
import { LlamaRouter } from "../../src/llama.ts";
import { type Config, type EngineEntry, pollUntil } from "../../src/types.ts";
import {
  BUNX,
  ENGINES_ROOT,
  imageBuilt,
  LOCAL,
  requireMemoryFor,
  specImage,
  TEST_NAME_PREFIX,
} from "./exclusive.ts";
import { type ChatRoute, isChatRoute, loadLocalConfig, skipTitle } from "./fixtures.ts";

/**
 * Two related local-tier gaps, one shared container pair: a chat GGUF and a
 * comfy container co-resident with no reload of either, and comfy's own
 * idle-stop driven purely by its `/queue` poll -- never by the other
 * engine's request traffic, which is the reason `EngineRegistry` polls
 * comfy at all rather than arming its lease from proxied requests the way
 * every other engine does.
 *
 * Image tags are read from the real engines/llama and engines/comfy
 * spec.toml via `loadSpec`, not hardcoded -- llama's tag already
 * drifted once within this session (sagaforge-llama-cpp:local ->
 * engined-llama-cpp:local), and the old tag is still a real image on this
 * box, so a hardcoded copy would run green against the wrong artifact
 * instead of failing loudly.
 */
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

/**
 * The weights the checkpoint render needs. Chroma1-HD is a UNET-only file --
 * `CheckpointLoaderSimple` returns no CLIP for it -- so the text encoder and
 * the VAE are named separately, and the CLIP type is what selects Chroma's
 * T5-only conditioning. Any of the three missing is a skip, never a failure:
 * this suite still must not be pinned to whichever weights an operator keeps.
 */
const RENDER_UNET = "Chroma1-HD.safetensors";
const RENDER_CLIP = "t5xxl_fp16.safetensors";
const RENDER_CLIP_TYPE = "chroma";
const RENDER_VAE = "ae.safetensors";
const RENDER_WIDTH = 512;
const RENDER_HEIGHT = 512;
/** Twelve resolves a clean image in well under a minute; four decodes only a blur. */
const RENDER_STEPS = 12;
/**
 * A flat 512x512 PNG -- what the model-free job above produces -- compresses
 * to a couple of KB. A real render is two orders larger, so this is what
 * separates "the diffusion path ran" from "an image-shaped file appeared".
 */
const MIN_RENDERED_PNG_BYTES = 20_000;
/** Cold, this loads ~27 GB of weights before it samples anything. */
const RENDER_BUDGET_MS = 600_000;
const RENDER_TIMEOUT_MS = 900_000;

interface Fixture {
  config: Config;
  llamaEngine: EngineEntry;
  chatRoute: ChatRoute;
  llamaImage?: string;
  comfyImage?: string;
  comfyModelsDir?: string;
}

/** Never throws: a stale or unreachable config.example.toml is a clean skip, not a crash before any test registers. */
function loadFixture(): Fixture | undefined {
  const { config: loaded } = loadLocalConfig();
  if (!loaded) {
    return;
  }
  const llamaEngine = loaded.engines.find((e) => e.id === "llama");
  const comfyEngine = loaded.engines.find((e) => e.id === "comfy");
  const chatRoute = loaded.routes.find(isChatRoute);
  if (!(llamaEngine && comfyEngine && chatRoute)) {
    return;
  }
  const config: Config = {
    ...loaded,
    engines: [llamaEngine, { ...comfyEngine, idle_stop_seconds: COMFY_IDLE_STOP_SECONDS }],
    routes: [chatRoute],
    chains: {},
  };
  return {
    config,
    llamaEngine,
    chatRoute,
    llamaImage: specImage(llamaEngine),
    comfyImage: specImage(comfyEngine),
    comfyModelsDir: comfyEngine.models_dir,
  };
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
  requireMemoryFor("comfy", "llama");
}

function skipReason(): string {
  if (FIXTURE === undefined) {
    return "config.example.toml is missing llama, comfy, or a llama chat model";
  }
  if (FIXTURE.llamaImage === undefined || FIXTURE.comfyImage === undefined) {
    return "a spec did not resolve an image -- check engines/llama and engines/comfy spec.toml";
  }
  return `${FIXTURE.llamaImage} and/or ${FIXTURE.comfyImage} are not built`;
}

/** Comfy resolves each of these from its own bind-mounted model tree. */
function renderWeightPaths(modelsDir: string): string[] {
  return [
    join(modelsDir, "diffusion_models", RENDER_UNET),
    join(modelsDir, "text_encoders", RENDER_CLIP),
    join(modelsDir, "vae", RENDER_VAE),
  ];
}

const MISSING_WEIGHTS =
  FIXTURE?.comfyModelsDir === undefined
    ? []
    : renderWeightPaths(FIXTURE.comfyModelsDir).filter((path) => !existsSync(path));
const CAN_RENDER = READY && FIXTURE?.comfyModelsDir !== undefined && MISSING_WEIGHTS.length === 0;

function renderSkipReason(): string {
  if (!READY) {
    return skipReason();
  }
  if (FIXTURE?.comfyModelsDir === undefined) {
    return "the comfy engine declares no models_dir";
  }
  return `absent from the comfy model tree: ${MISSING_WEIGHTS.join(", ")}`;
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
async function runComfyJob(
  privateUrl: string,
  budgetMs: number,
  workflow: Record<string, unknown>,
): Promise<string[]> {
  const submit = await fetch(`http://${privateUrl}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: workflow }),
  });
  if (submit.status !== 200) {
    throw new Error(`comfy /prompt returned ${submit.status}`);
  }
  const { prompt_id: promptId } = (await submit.json()) as { prompt_id: string };

  let images: string[] | undefined;
  const completed = await pollUntil(
    async () => {
      const res = await fetch(`http://${privateUrl}/history/${promptId}`);
      const history = (await res.json()) as Record<
        string,
        {
          status?: { completed?: boolean };
          outputs?: Record<string, { images?: { filename: string }[] }>;
        }
      >;
      const entry = history[promptId];
      if (entry?.status?.completed !== true) {
        return false;
      }
      images = Object.values(entry.outputs ?? {}).flatMap((o) =>
        (o.images ?? []).map((i) => i.filename),
      );
      return true;
    },
    Date.now() + budgetMs,
    IDLE_POLL_INTERVAL_MS,
  );
  if (!(completed && images)) {
    throw new Error("comfy job did not complete within its budget");
  }
  return images;
}

/**
 * The real diffusion graph: load the UNET, T5 and VAE separately, condition on
 * a prompt, sample, decode, save. Unlike `modelFreeWorkflow` this actually
 * puts weights on the GPU and runs the sampler.
 */
function diffusionWorkflow(): Record<string, unknown> {
  return {
    "1": {
      class_type: "UNETLoader",
      inputs: { unet_name: RENDER_UNET, weight_dtype: "default" },
    },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: RENDER_CLIP, type: RENDER_CLIP_TYPE },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: RENDER_VAE } },
    "4": {
      class_type: "CLIPTextEncode",
      inputs: { text: "a red cube on a white table", clip: ["2", 0] },
    },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } },
    "6": {
      class_type: "EmptySD3LatentImage",
      inputs: { width: RENDER_WIDTH, height: RENDER_HEIGHT, batch_size: 1 },
    },
    "7": {
      class_type: "KSampler",
      inputs: {
        model: ["1", 0],
        positive: ["4", 0],
        negative: ["5", 0],
        latent_image: ["6", 0],
        seed: 7,
        steps: RENDER_STEPS,
        cfg: 4.0,
        sampler_name: "euler",
        scheduler: "simple",
        denoise: 1.0,
      },
    },
    "8": { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } },
    "9": {
      class_type: "SaveImage",
      inputs: { images: ["8", 0], filename_prefix: "engined_local_checkpoint" },
    },
  };
}

async function fetchOutputImage(privateUrl: string, filename: string): Promise<Uint8Array> {
  const res = await fetch(
    `http://${privateUrl}/view?filename=${encodeURIComponent(filename)}&type=output`,
  );
  if (res.status !== 200) {
    throw new Error(`comfy /view returned ${res.status}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((byte, i) => bytes[i] === byte);
}

/** IHDR is always the first chunk, so width and height are big-endian u32 at 16 and 20. */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

async function chatCompletes(router: LlamaRouter, route: ChatRoute): Promise<boolean> {
  const { response: res } = await router.proxy(route, "/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: route.model,
      messages: [{ role: "user", content: "Reply with the single word: hi" }],
      max_tokens: 4,
    }),
  });
  return res.status === 200;
}

interface Rig {
  lifecycle: DockerLifecycle;
  registry: EngineRegistry;
  router: LlamaRouter;
  fixture: Fixture;
}

/** The lifecycle, registry and router one describe block drives, all sharing the one `DockerLifecycle`. */
function buildRig(fixture: Fixture): Rig {
  const lifecycle = new DockerLifecycle(dockerExec, undefined, TEST_NAME_PREFIX);
  const registry = new EngineRegistry(fixture.config, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    lifecycle,
    comfyPollIntervalMs: COMFY_POLL_INTERVAL_MS,
  });
  const router = new LlamaRouter(fixture.llamaEngine, [fixture.chatRoute], lifecycle, {
    enginesRoot: ENGINES_ROOT,
    bunx: BUNX,
    idleStopSeconds: LLAMA_IDLE_STOP_SECONDS,
    readyTimeoutS: READY_TIMEOUT_S,
    presetHostPath: join(import.meta.dir, ".scratch-preset-comfy.ini"),
  });
  return { lifecycle, registry, router, fixture };
}

/**
 * One rig per describe block, built and torn down with it, reached through
 * the returned accessor.
 *
 * Built in `beforeAll`, never in the `describe` body: bun still calls a
 * skipped describe's own body to enumerate its tests (confirmed empirically
 * -- only `beforeAll`/`afterAll`/`test` bodies are actually skipped), and
 * `EngineRegistry`'s constructor loads every engine's spec eagerly, which
 * would throw on the `FIXTURE`-less path the moment this file is merely
 * collected, ENGINED_LOCAL or not.
 *
 * The accessor throws rather than handing back `undefined`, so a `beforeAll`
 * that never ran surfaces as itself instead of as a property access on
 * nothing; narrowing `FIXTURE` here, once, is what lets every test body below
 * read it as a plain `Fixture`.
 */
function withRig(): () => Rig {
  let rig: Rig | undefined;

  beforeAll(() => {
    if (!FIXTURE) {
      throw new Error("this suite registered without a fixture -- its readiness gate is broken");
    }
    rig = buildRig(FIXTURE);
  });

  afterAll(async () => {
    await rig?.registry.shutdown();
    await rig?.lifecycle.shutdown();
  }, SHUTDOWN_TIMEOUT_MS);

  return () => {
    if (!rig) {
      throw new Error("beforeAll did not run -- rig is unset");
    }
    return rig;
  };
}

describe.skipIf(!READY)(
  skipTitle("comfy + llama co-residency (local)", READY, skipReason()),
  () => {
    const useRig = withRig();

    test(
      "a chat completion and a comfy start co-reside with no reload of either, and comfy idle-stops off its own /queue poll while llama stays running",
      async () => {
        const { registry, router, lifecycle, fixture } = useRig();

        expect(await chatCompletes(router, fixture.chatRoute)).toBe(true);
        const comfyStatus = await registry.start("comfy");
        expect(comfyStatus.state).toBe("running");
        expect(await comfyQueueReachable(lifecycle.getStatus("comfy").private_url)).toBe(true);

        // Co-residency, not a reload: the SAME chat completion still answers
        // with comfy now also running, through the identical router instance
        // -- a reload would have needed a fresh container.
        expect(await chatCompletes(router, fixture.chatRoute)).toBe(true);
        expect(registry.get("llama")?.state).toBe("running");

        // Nothing submits a comfy job, so its own /queue poll should observe
        // emptiness and arm idle-stop -- request traffic to llama never
        // reaches comfy's lease, and no request went to comfy's own door
        // either, since comfy's idle timer must be driven by the poll alone.
        const comfyIdled = await pollUntil(
          async () => registry.get("comfy")?.state === "installed",
          Date.now() + IDLE_WAIT_BUDGET_MS,
          IDLE_POLL_INTERVAL_MS,
        );
        expect(comfyIdled).toBe(true);

        // llama's own idle-stop (900s) never fired in this ~30s window, and
        // comfy idling never touched it.
        expect(registry.get("llama")?.state).toBe("running");
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
  skipTitle("comfy runs a real job beside a resident chat GGUF (local)", READY, skipReason()),
  () => {
    const useRig = withRig();

    test(
      "a comfy job produces an image while the chat model stays resident, and the chat after it pays no reload",
      async () => {
        const { registry, router, lifecycle, fixture } = useRig();

        expect(await chatCompletes(router, fixture.chatRoute)).toBe(true);
        const before = lifecycle.getStatus("llama").private_url;

        const comfy = await registry.start("comfy");
        expect(comfy.state).toBe("running");
        const images = await runComfyJob(
          lifecycle.getStatus("comfy").private_url as string,
          TEST_TIMEOUT_MS / 2,
          modelFreeWorkflow(),
        );
        expect(images.length).toBeGreaterThan(0);

        // Same container, same published port: a reload would have replaced
        // both, and engined proxied none of the job -- it went straight to the
        // private_url above.
        expect(await chatCompletes(router, fixture.chatRoute)).toBe(true);
        expect(registry.get("llama")?.state).toBe("running");
        expect(lifecycle.getStatus("llama").private_url).toBe(before);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

/**
 * The last hand-proof-only claim: `modelFreeWorkflow` deliberately loads no
 * weights, so queue/execute/output were guarded while the diffusion path
 * itself -- weights on the GPU, sampler, VAE decode -- was not. This drives a
 * real checkpoint and skips when the weights are absent, so the suite gains
 * the guard without becoming pinned to them.
 */
describe.skipIf(!CAN_RENDER)(
  skipTitle("comfy renders through a real checkpoint (local)", CAN_RENDER, renderSkipReason()),
  () => {
    const useRig = withRig();

    test(
      "a prompted checkpoint render decodes a real 512x512 PNG, not a flat image",
      async () => {
        const rig = useRig();
        const comfy = await rig.registry.start("comfy");
        expect(comfy.state).toBe("running");
        const comfyUrl = rig.lifecycle.getStatus("comfy").private_url as string;

        const images = await runComfyJob(comfyUrl, RENDER_BUDGET_MS, diffusionWorkflow());
        expect(images.length).toBe(1);

        const png = await fetchOutputImage(comfyUrl, images[0] as string);
        expect(isPng(png)).toBe(true);
        expect(pngDimensions(png)).toEqual({ width: RENDER_WIDTH, height: RENDER_HEIGHT });
        expect(png.byteLength).toBeGreaterThan(MIN_RENDERED_PNG_BYTES);
      },
      RENDER_TIMEOUT_MS,
    );
  },
);
