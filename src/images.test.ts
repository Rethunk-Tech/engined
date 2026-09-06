/**
 * `POST /openai/v1/images/generations`: the OpenAI-shaped image verb over a
 * comfy engine. The container is a stand-in dependency, injected through
 * `comfyHttpClient` exactly as the mediated proxy's own suite does — nothing
 * here reaches a real ComfyUI.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { buildComfySpec } from "./comfy.ts";
import type { HttpClient } from "./http.ts";
import { fillWorkflow } from "./images.ts";
import { createDoor } from "./main.ts";
import {
  BUNX,
  buildExec,
  config,
  engine,
  makeTestRoot,
  route,
  writeEngineSpec,
} from "./test-support.ts";

const TEST_ROOT = makeTestRoot("engined-images-");
const IMAGES_PATH = "/openai/v1/images/generations";
const COMFY_CONTAINER_PORT = 8188;

const COMFY_SPEC = `
kind = "comfy"
upstream = "self"
image = "engined/fakecomfy:local"
obtain = "build"
serves = ["/openai/v1/images/generations"]
command = []
images_workflow = "{spec_dir}/text-to-image.json"

[ready]
path = "/queue"
status = 200
`;

/** A miniature graph with one of every placeholder kind the real one uses. */
const WORKFLOW = {
  _comment: ["prose comfy would reject as a node"],
  "1": { class_type: "UNETLoader", inputs: { unet_name: "${unet}" } },
  "2": { class_type: "CLIPTextEncode", inputs: { text: "${prompt}", clip: ["1", 0] } },
  "3": {
    class_type: "EmptySD3LatentImage",
    inputs: { width: "${width}", height: "${height}", batch_size: "${batch}" },
  },
  "4": {
    class_type: "KSampler",
    inputs: {
      latent_image: ["3", 0],
      seed: "${seed}",
      steps: "${steps}",
      cfg: "${cfg}",
      sampler_name: "${sampler}",
      scheduler: "${scheduler}",
    },
  },
  "5": { class_type: "SaveImage", inputs: { images: ["4", 0], filename_prefix: "engined_images" } },
};

const CHECKPOINTS = {
  unet: "Chroma1-HD.safetensors",
  clip: "t5xxl_fp16.safetensors",
  clip_type: "chroma",
  vae: "ae.safetensors",
};

/** A one-pixel PNG, so the base64 in the answer is real bytes the door actually fetched. */
const PIXEL = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

async function imagesDoor(
  comfyHttpClient: HttpClient,
  routeArgs: Record<string, unknown> = CHECKPOINTS,
  opts: { write?: (line: string) => void; chatTimeoutSeconds?: number } = {},
) {
  process.env.XDG_STATE_HOME = mkdtempSync(join(TEST_ROOT, "state-"));
  const root = mkdtempSync(join(TEST_ROOT, "door-"));
  writeEngineSpec(root, "comfy", COMFY_SPEC);
  mkdirSync(join(root, "comfy"), { recursive: true });
  writeFileSync(join(root, "comfy", "text-to-image.json"), JSON.stringify(WORKFLOW));
  const cfg = config({
    engines: [engine({ id: "comfy", models_dir: "/data/comfy", idle_stop_seconds: 9999 })],
    routes: [route({ engine: "comfy", model: undefined, upstream: "local", args: routeArgs })],
    ...(opts.chatTimeoutSeconds === undefined
      ? {}
      : { chat_timeout_seconds: opts.chatTimeoutSeconds }),
  });
  const door = createDoor(
    cfg,
    {
      enginesRoot: root,
      bunx: BUNX,
      exec: buildExec({ port: 41_100, containerPort: COMFY_CONTAINER_PORT }),
      probe: () => Promise.resolve({ status: 200 }),
    },
    { comfyHttpClient, write: opts.write },
  );
  await door.registry.start("comfy");
  return door;
}

/** A container that renders instantly: idle queue, one prompt id, a finished history, and a pixel for /view. */
function rendersInstantly(submitted: string[] = []) {
  const client: HttpClient = (url, init) => {
    const target = String(url);
    if (target.includes("/queue") && init?.method !== "POST") {
      return Promise.resolve(Response.json({ queue_running: [], queue_pending: [] }));
    }
    if (target.includes("/prompt")) {
      submitted.push(String(init?.body ?? ""));
      return Promise.resolve(Response.json({ prompt_id: `job-${submitted.length}` }));
    }
    if (target.includes("/history/")) {
      const id = target.split("/history/")[1] as string;
      return Promise.resolve(
        Response.json({ [id]: { outputs: { "5": { images: [{ filename: `${id}.png` }] } } } }),
      );
    }
    return Promise.resolve(new Response(PIXEL, { headers: { "content-type": "image/png" } }));
  };
  return client;
}

function generate(door: Awaited<ReturnType<typeof imagesDoor>>, body: Record<string, unknown>) {
  return door.fetch(
    new Request(`http://engined${IMAGES_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

describe("the graph is filled, not templated", () => {
  test("a placeholder keeps the type of what replaces it, and prose is not sent as a node", () => {
    const filled = fillWorkflow(WORKFLOW, {
      ...CHECKPOINTS,
      prompt: "a red cube",
      width: 512,
      height: 768,
      batch: 1,
      seed: 7,
      steps: 20,
      cfg: 4.0,
      sampler: "euler",
      scheduler: "simple",
    }) as Record<string, { inputs: Record<string, unknown> }>;

    // A number substituted into JSON as a string is the whole reason this
    // walks the parsed object instead of the text: comfy rejects "512".
    expect(filled["3"]?.inputs.width).toBe(512);
    expect(filled["3"]?.inputs.height).toBe(768);
    expect(filled["1"]?.inputs.unet_name).toBe("Chroma1-HD.safetensors");
    expect(filled["2"]?.inputs.text).toBe("a red cube");
    // Node wiring is a tuple of [nodeId, slot] and must survive untouched.
    expect(filled["2"]?.inputs.clip).toEqual(["1", 0]);
    expect(filled._comment).toBeUndefined();
  });

  test("a placeholder the door does not supply is refused, not sent", () => {
    expect(() => fillWorkflow({ a: "${nonesuch}" }, {})).toThrow("nonesuch");
  });
});

describe("POST /openai/v1/images/generations", () => {
  test("renders and answers in the OpenAI envelope, with the image the door actually fetched", async () => {
    const submitted: string[] = [];
    const door = await imagesDoor(rendersInstantly(submitted));
    const res = await generate(door, {
      model: "@/comfy/local",
      prompt: "a red cube",
      size: "512x512",
    });
    const body = (await res.json()) as { created: number; data: { b64_json: string }[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]?.b64_json).toBe(Buffer.from(PIXEL).toString("base64"));
    expect(typeof body.created).toBe("number");

    // The prompt reached the container inside comfy's own envelope, with the
    // caller's text and size in it.
    const sent = JSON.parse(submitted[0] as string) as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(sent.prompt["2"]?.inputs.text).toBe("a red cube");
    expect(sent.prompt["3"]?.inputs.width).toBe(512);
  });

  test("n images are n renders, each with its own seed", async () => {
    const submitted: string[] = [];
    const door = await imagesDoor(rendersInstantly(submitted));
    const res = await generate(door, { model: "@/comfy/local", prompt: "a red cube", n: 3 });
    const body = (await res.json()) as { data: unknown[] };

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(3);
    expect(submitted).toHaveLength(3);
    // Same prompt, different seeds: three identical images would not be three
    // images.
    const seeds = submitted.map(
      (s) =>
        (JSON.parse(s) as { prompt: Record<string, { inputs: { seed?: number } }> }).prompt["4"]
          ?.inputs.seed,
    );
    expect(new Set(seeds).size).toBe(3);
  });

  test("an empty prompt, a bad size and an out-of-range n each name themselves", async () => {
    const door = await imagesDoor(rendersInstantly());
    const noPrompt = await generate(door, { model: "@/comfy/local" });
    const badSize = await generate(door, { model: "@/comfy/local", prompt: "x", size: "big" });
    const badN = await generate(door, { model: "@/comfy/local", prompt: "x", n: 0 });

    expect(noPrompt.status).toBe(400);
    expect(await noPrompt.text()).toContain("prompt");
    expect(badSize.status).toBe(400);
    expect(await badSize.text()).toContain("size");
    expect(badN.status).toBe(400);
    expect(await badN.text()).toContain("n");
  });

  // The checkpoints are the one install-specific half of the render. Left out,
  // comfy would load nothing and answer with a node error naming neither the
  // config nor the missing key.
  test("a route missing its checkpoint args is refused, naming which are missing", async () => {
    const door = await imagesDoor(rendersInstantly(), { unet: "Chroma1-HD.safetensors" });
    const res = await generate(door, { model: "@/comfy/local", prompt: "a red cube" });
    const text = await res.text();

    expect(res.status).toBe(400);
    expect(text).toContain("clip");
    expect(text).toContain("vae");
    expect(text).not.toContain("missing unet");
  });

  test("a chain is refused: a second engine's render is a different image, not a retry", async () => {
    const door = await imagesDoor(rendersInstantly());
    const res = await door.fetch(
      new Request(`http://engined${IMAGES_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "chain-x", prompt: "a red cube" }),
      }),
    );
    // Unknown rather than dispatched: this config declares no chain, and the
    // point is that the verb never walks one.
    expect(res.status).toBe(400);
  });
});

// The fixture above is not the artifact that ships. It said `images_workflow`
// before its `[ready]` table and the real spec said it after, where TOML reads
// a bare key as belonging to the table above it -- so the shipped engine
// parsed as `ready.images_workflow` and the verb reported it had no graph at
// all, with every test here still green.
describe("the shipped comfy engine", () => {
  test("resolves an images_workflow that exists, and the graph names only placeholders the door fills", () => {
    const spec = buildComfySpec(
      { id: "comfy", args: {}, models_dir: "/unused" },
      { enginesRoot: join(import.meta.dir, "..", "engines"), bunx: BUNX },
    );
    expect(spec.images_workflow).toBeDefined();
    expect(existsSync(spec.images_workflow as string)).toBe(true);

    // Every `${name}` the shipped graph carries has to be one the door
    // supplies, or the render throws at request time instead of here.
    const graph = JSON.parse(readFileSync(spec.images_workflow as string, "utf8")) as unknown;
    const supplied = {
      unet: "u",
      clip: "c",
      clip_type: "t",
      vae: "v",
      prompt: "p",
      negative: "",
      width: 1,
      height: 1,
      batch: 1,
      seed: 1,
      steps: 1,
      cfg: 1,
      sampler: "euler",
      scheduler: "simple",
    };
    expect(() => fillWorkflow(graph, supplied)).not.toThrow();
  });
});

interface ProvenanceLine {
  attempts: { engine: string; ok: boolean; failure?: string }[];
  engine_used: string | null;
  upstream_used: string | null;
}

/** The one line the call is entitled to, parsed back out of what the door wrote. */
function lastRecord(lines: string[]): ProvenanceLine {
  return JSON.parse(lines.at(-1) as string) as ProvenanceLine;
}

describe("the one line this call is entitled to", () => {
  test("a render answered is recorded as a success, naming the engine that answered", async () => {
    const lines: string[] = [];
    const door = await imagesDoor(rendersInstantly(), CHECKPOINTS, {
      write: (line) => lines.push(line),
    });
    const res = await generate(door, { model: "@/comfy/local", prompt: "a red cube" });
    const record = lastRecord(lines);

    expect(res.status).toBe(200);
    expect(record.attempts[0]?.ok).toBe(true);
    expect(record.attempts[0]?.failure).toBeUndefined();
    expect(record.engine_used).toBe("comfy");
  });

  // journald is the whole observability surface for this verb, and a failed
  // render indistinguishable from a rendered one is no surface at all.
  test("a container that refuses the prompt is recorded as a failure, in its own words", async () => {
    const lines: string[] = [];
    const refusesThePrompt: HttpClient = (url) =>
      Promise.resolve(
        String(url).includes("/prompt")
          ? Response.json({ error: "node 4 has no input named sampler" }, { status: 400 })
          : Response.json({ queue_running: [], queue_pending: [] }),
      );
    const door = await imagesDoor(refusesThePrompt, CHECKPOINTS, {
      write: (line) => lines.push(line),
    });
    const res = await generate(door, { model: "@/comfy/local", prompt: "a red cube" });
    const record = lastRecord(lines);

    expect(res.status).toBe(400);
    expect(record.attempts[0]?.ok).toBe(false);
    expect(record.attempts[0]?.failure).toContain("no input named sampler");
    // Nothing answered, so nothing is named as having answered.
    expect(record.engine_used).toBeNull();
    expect(record.upstream_used).toBeNull();
  });

  test("an image comfy will not serve is a failure, not an empty success", async () => {
    const lines: string[] = [];
    const rendersThenHides: HttpClient = (url, init) =>
      String(url).includes("/view")
        ? Promise.resolve(new Response("gone", { status: 404 }))
        : rendersInstantly()(url, init);
    const door = await imagesDoor(rendersThenHides, CHECKPOINTS, {
      write: (line) => lines.push(line),
    });
    const res = await generate(door, { model: "@/comfy/local", prompt: "a red cube" });
    const record = lastRecord(lines);

    expect(res.status).toBe(502);
    expect(record.attempts[0]?.ok).toBe(false);
    expect(record.attempts[0]?.failure).toContain("would not serve it");
  });
});

// The deadline is computed before the queue drain is waited through, so a
// budget already spent by the time the prompt is submitted must still buy one
// look at /history -- the render it asks about may have finished.
describe("collect asks before it gives up", () => {
  test("a deadline already passed is one probe, not none", async () => {
    const door = await imagesDoor(rendersInstantly(), CHECKPOINTS, { chatTimeoutSeconds: 0 });
    const res = await generate(door, { model: "@/comfy/local", prompt: "a red cube" });
    const body = (await res.json()) as { data: { b64_json: string }[] };

    expect(res.status).toBe(200);
    expect(body.data[0]?.b64_json).toBe(Buffer.from(PIXEL).toString("base64"));
  });
});
