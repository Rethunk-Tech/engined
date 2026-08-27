/**
 * Resolves an OpenAI `model` string to an engine (and, where one applies, a
 * model on it) for one door endpoint. Pure over `Config` and the registry's
 * `get`/`serves` so it is testable without `Bun.serve` or docker.
 */

import { resolveLocalCandidates } from "./config.ts";
import type { EngineRegistry } from "./engines.ts";
import type { Config } from "./types.ts";

const QUALIFIED_RE = /^@\/([^/]+)\/([^/]+)$/;
/** Chains exist to route a chat prompt hop by hop; no other endpoint takes one. */
const CHAIN_ENDPOINT = "/v1/chat/completions";

export type Dispatch =
  | { ok: true; kind: "engine"; engine: string }
  | { ok: true; kind: "model"; engine: string; model: string }
  | { ok: true; kind: "chain"; chain: string; hops: readonly string[] }
  | { ok: false; error: string };

function fail(error: string): Dispatch {
  return { ok: false, error };
}

/** `local` is the one no-egress engine at least one `[[model]]` names -- config.ts's own rule, shared rather than re-derived so the two can never disagree. */
function resolveLocalEngine(config: Config): string | undefined {
  const candidates = resolveLocalCandidates(config.engines, config.models);
  return candidates.length === 1 ? candidates[0]?.id : undefined;
}

/** Exported so the door can resolve the same `local` alias for chain hops, extras and `egressOf`. */
export function resolveEngineSegment(seg: string, config: Config): string | undefined {
  if (seg === "local") {
    return resolveLocalEngine(config);
  }
  return config.engines.some((e) => e.id === seg) ? seg : undefined;
}

/** `engine.serves(endpoint)`, or the model-less form when `model` is `undefined`. */
function withEndpointCheck(
  engineId: string,
  modelId: string | undefined,
  endpoint: string,
  registry: EngineRegistry,
): Dispatch {
  if (!registry.serves(engineId).includes(endpoint)) {
    return fail(`engine "${engineId}" does not serve ${endpoint}`);
  }
  return modelId === undefined
    ? { ok: true, kind: "engine", engine: engineId }
    : { ok: true, kind: "model", engine: engineId, model: modelId };
}

function resolveQualified(
  match: RegExpExecArray,
  endpoint: string,
  config: Config,
  registry: EngineRegistry,
): Dispatch {
  const [, engineSeg, modelSeg] = match;
  if (engineSeg === undefined || modelSeg === undefined) {
    return fail("malformed @/<engine>/<model> form");
  }
  const engineId = resolveEngineSegment(engineSeg, config);
  if (engineId === undefined) {
    return fail(`"@/${engineSeg}/${modelSeg}": engine "${engineSeg}" does not exist`);
  }
  const found = config.models.find(
    (m) => m.engine === engineId && (m.id === modelSeg || m.aliases.includes(modelSeg)),
  );
  if (!found) {
    return fail(
      `"@/${engineSeg}/${modelSeg}": model "${modelSeg}" does not exist on "${engineId}"`,
    );
  }
  return withEndpointCheck(engineId, found.id, endpoint, registry);
}

/** A bare id or alias, valid only when exactly one `[[model]]` row claims it. */
function resolveBareModel(
  model: string,
  endpoint: string,
  config: Config,
  registry: EngineRegistry,
): Dispatch | undefined {
  const matches = config.models.filter((m) => m.id === model || m.aliases.includes(model));
  if (matches.length === 0) {
    return;
  }
  if (matches.length > 1) {
    const qualified = matches.map((m) => `@/${m.engine}/${m.id}`).join(", ");
    return fail(`"${model}" is ambiguous across engines; use one of: ${qualified}`);
  }
  const [only] = matches;
  if (!only) {
    return;
  }
  return withEndpointCheck(only.engine, only.id, endpoint, registry);
}

/** Kinds whose door takes no separate model id: agentic-cli picks its own model, tts/stt have none. */
const MODEL_LESS_KINDS = new Set(["agentic-cli", "tts", "stt"]);

/** An engine id bare, but only for a kind that answers without being told which model. */
function resolveBareEngine(
  model: string,
  endpoint: string,
  config: Config,
  registry: EngineRegistry,
): Dispatch | undefined {
  if (!config.engines.some((e) => e.id === model)) {
    return;
  }
  const kind = registry.get(model)?.kind;
  if (kind === undefined || !MODEL_LESS_KINDS.has(kind)) {
    return fail(`"${model}" is an engine that requires a model, not a bare selector`);
  }
  return withEndpointCheck(model, undefined, endpoint, registry);
}

function resolveChain(model: string, endpoint: string, config: Config): Dispatch | undefined {
  const hops = config.chains[model];
  if (hops === undefined) {
    return;
  }
  if (endpoint !== CHAIN_ENDPOINT) {
    return fail(`chain "${model}" only serves ${CHAIN_ENDPOINT}`);
  }
  return { ok: true, kind: "chain", chain: model, hops };
}

/**
 * `model` resolution for one door endpoint. A caller that has not said where
 * its prompt should run has not said whether it may leave the machine, so
 * absent or empty is fatal to the request rather than defaulted.
 */
export function resolveModel(
  model: string | undefined,
  endpoint: string,
  config: Config,
  registry: EngineRegistry,
): Dispatch {
  if (model === undefined || model === "") {
    return fail("model is required");
  }

  const qualified = QUALIFIED_RE.exec(model);
  if (qualified) {
    return resolveQualified(qualified, endpoint, config, registry);
  }

  return (
    resolveBareModel(model, endpoint, config, registry) ??
    resolveBareEngine(model, endpoint, config, registry) ??
    resolveChain(model, endpoint, config) ??
    fail(`unknown model "${model}"`)
  );
}
