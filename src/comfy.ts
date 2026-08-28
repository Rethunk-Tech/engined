/**
 * The Comfy engine's own spec assembly. Comfy has no router mode and no
 * presets INI, so the only gap `loadSpec` can't close on its own is the
 * models mount -- a host bind mount at the engine's own `models_dir`,
 * injected at run time exactly the way `buildLlamaSpec` does it for llama's
 * model store. A docker-managed named volume would start Comfy against an
 * empty store instead of the operator's real models.
 */
import { loadSpec } from "./spec.ts";
import type { ContainerSpec, EngineEntry } from "./types.ts";
import { argvFromArgs, isContainerSpec } from "./types.ts";

const MODELS_CONTAINER_PATH = "/opt/comfyui/models";

export interface ComfyBuildOptions {
  enginesRoot: string;
  bunx: string;
}

/**
 * Mounted read-write, not `:ro`: unlike llama's GGUF store, ComfyUI writes
 * caches beneath its models directory. Tightening this needs evidence it
 * still starts clean, not an assumption.
 */
export function buildComfySpec(engine: EngineEntry, opts: ComfyBuildOptions): ContainerSpec {
  const loaded = loadSpec(engine, { enginesRoot: opts.enginesRoot, bunx: opts.bunx });
  if (!isContainerSpec(loaded.spec)) {
    throw new Error(`engine "${engine.id}": comfy spec must be a container spec`);
  }
  if (engine.models_dir === undefined) {
    throw new Error(`engine "${engine.id}": comfy engine has no models_dir`);
  }
  const { spec } = loaded;
  spec.volumes = [...spec.volumes, { name: engine.models_dir, path: MODELS_CONTAINER_PATH }];
  spec.command = [...spec.command, ...argvFromArgs(engine.args)];
  return spec;
}
