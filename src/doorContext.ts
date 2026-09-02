/**
 * The shapes every door handler is written against: what an installer or a
 * test may inject, the live state a handler reads, and the comfy mediation
 * table that state carries. They live here rather than in `src/main.ts`
 * because the door's verb modules are imported BY main -- a type declared
 * there could only reach them as an import cycle.
 */

import type { AgenticSpawn } from "./agentic.ts";
import type { DockerLifecycle } from "./docker.ts";
import type { EngineRegistry, RegistryOptions } from "./engines.ts";
import type { Exec as SecretExec } from "./exec.ts";
import type { HttpClient } from "./http.ts";
import type { LlamaRouter } from "./llama.ts";
import type { Config } from "./types.ts";

export interface DoorOptions {
  agenticSpawn?: AgenticSpawn;
  llamaHttpClient?: HttpClient;
  extrasHttpClient?: HttpClient;
  /** Defaults to the real `fetch`; a test overrides it so the comfy proxy never reaches a real container. */
  comfyHttpClient?: HttpClient;
  /** Injected so a test can capture the provenance line instead of reading real stdout. */
  write?: (line: string) => void;
  /** Reaches both the registry that writes the preset and the router that mounts it; a test overrides it so neither touches the real state dir. */
  llamaPresetHostPath?: string;
  /** Defaults to the real `secret-tool`; a test overrides it so a remote-agentic engine's keyring lookup never runs for real. */
  secretExec?: SecretExec;
  /** Defaults to the real `process.env`; a test overrides it so a planted ambient secret has somewhere deterministic to not leak from. */
  agenticAmbientEnv?: NodeJS.ProcessEnv;
}

/**
 * Everything a content handler needs, bundled so each handler stays a
 * top-level function instead of a deep closure. `getConfig` rather than a
 * captured `Config` because `reload` swaps it out from under an in-flight
 * request's later lookups.
 */
export interface DoorContext {
  getConfig: () => Config;
  registry: EngineRegistry;
  lifecycle: DockerLifecycle;
  registryOpts: RegistryOptions;
  doorOpts: DoorOptions;
  llamaRouters: Map<string, LlamaRouter>;
  /**
   * Engine ids whose cached router belongs to a config generation `reload`
   * has since superseded. Swapped for a fresh one lazily, on the first call
   * after its own outstanding leases drain to zero -- never mid-flight, so
   * a request that arrives after a reload but while an earlier one is still
   * reading from the container joins the SAME occupancy tracker instead of
   * getting a second one that has no idea what the first still has resident.
   */
  staleLlamaRouters: Set<string>;
  /**
   * Live launch-scoped nonces: minted at the `runAgentic` call site, deleted
   * the moment that call returns. A request naming one that is not in this
   * set -- expired, or never minted -- is refused outright, whether or not
   * it names an agentic engine: a leaked or reused URL is not a standing key.
   */
  launchNonces: Set<string>;
  /** Comfy proxy mediation state, reload-durable. */
  comfyBindings: ComfyBindings;
}

/**
 * What this door has actually seen pass through a comfy engine's proxy:
 * every `prompt_id` `POST /prompt` handed back, keyed on the origin that
 * submitted it as well as the engine, and under each one the output
 * filenames a completed `/history` read surfaced for THAT prompt. `GET
 * /view` and `POST /queue` are mediated against this table rather than
 * against anything the caller merely claims -- comfy's output directory is
 * shared, so a caller-supplied filename must never become a URL on its own
 * say-so, and one engine-wide filename set would hand every origin every
 * other origin's outputs.
 */
export type ComfyBindings = Map<string, string[]>;
