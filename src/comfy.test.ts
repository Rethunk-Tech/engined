import { expect, test } from "bun:test";
import { buildComfySpec } from "./comfy.ts";
import { buildRunArgs } from "./dockerArgs.ts";
import { BUNX, engine as baseEngine, ENGINES_ROOT } from "./test-support.ts";
import { type EngineEntry, isContainerSpec } from "./types.ts";

const CONTAINER_PORT = 8188;
const RX_NO_MODELS_DIR = /has no models_dir/;

function engine(overrides: Partial<EngineEntry> = {}): EngineEntry {
  return baseEngine({ id: "comfy", models_dir: "/models-host/comfy", ...overrides });
}

// buildComfySpec's own return type is the wider ContainerSpec, though it
// always narrows to a runnable one internally before returning -- narrowed
// again here rather than in comfy.ts, which is not this file's to change.
function asRunnable(spec: ReturnType<typeof buildComfySpec>) {
  if (!isContainerSpec(spec)) {
    throw new Error("expected a runnable container spec");
  }
  return spec;
}

test("the run argv bind-mounts a host path ending in /comfy, never the old named volume, and it is not :ro", () => {
  const spec = asRunnable(buildComfySpec(engine(), { enginesRoot: ENGINES_ROOT, bunx: BUNX }));
  const argv = buildRunArgs("engined-comfy", spec, CONTAINER_PORT);

  const mountArgs = argv.filter((_, i) => argv[i - 1] === "-v");
  expect(mountArgs).toEqual(["/models-host/comfy:/opt/comfyui/models"]);
  expect(argv).not.toContain("engined-comfy-models:/opt/comfyui/models");
  expect(mountArgs.some((m) => m.endsWith(":ro"))).toBe(false);
});

test("a models_dir ending anywhere other than /comfy still mounts correctly -- the container path is what's fixed", () => {
  const spec = asRunnable(
    buildComfySpec(engine({ models_dir: "/elsewhere/comfy-models" }), {
      enginesRoot: ENGINES_ROOT,
      bunx: BUNX,
    }),
  );
  const argv = buildRunArgs("engined-comfy", spec, CONTAINER_PORT);
  expect(argv).toContain("/elsewhere/comfy-models:/opt/comfyui/models");
});

test("throws rather than silently starting with no models mount when models_dir is unset", () => {
  expect(() =>
    buildComfySpec(engine({ models_dir: undefined }), { enginesRoot: ENGINES_ROOT, bunx: BUNX }),
  ).toThrow(RX_NO_MODELS_DIR);
});
