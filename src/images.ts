/**
 * `POST /openai/v1/images/generations`: the fifth modality, on the same
 * OpenAI shape as chat, embeddings, speech and transcription.
 *
 * It does not replace the mediated comfy proxy and is not meant to. A node
 * graph, a custom sampler, a video job -- none of those is expressible as an
 * OpenAI image request, and a consumer that needs them still speaks comfy
 * through `/engined/v1/comfy/...`. This is for the caller that wants a prompt
 * turned into an image and should not have to learn a workflow format to get
 * one.
 *
 * The graph is the engine's own (`images_workflow` in its spec), because its
 * wiring is what fails silently. Only the checkpoint filenames vary by
 * install, and those come from the comfy route's `[route.args]`.
 */

import { readFileSync } from "node:fs";
import { classifyResult } from "./chain.ts";
import { submitComfyPrompt } from "./comfyProxy.ts";
import { resolveModel } from "./dispatch.ts";
import type { DoorContext } from "./doorContext.ts";
import { DEFAULT_IDLE_STOP_SECONDS } from "./engines.ts";
import {
  discardBody,
  type HttpClient,
  jsonError,
  jsonErrorBody,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
} from "./http.ts";
import { recordCall } from "./provenance.ts";
import { isContainerSpec } from "./specTypes.ts";
import {
  CONTENT_ENDPOINT_IMAGES,
  errMessage,
  isRecord,
  MS_PER_SECOND,
  parseRecord,
  type ResolvedRoute,
} from "./types.ts";

/** How often the door asks whether the render has finished. A diffusion step is hundreds of milliseconds, so a tighter poll only costs round trips. */
const HISTORY_POLL_MS = 400;

/** Defaults for everything the OpenAI request does not carry, and the graph still needs. */
const DEFAULT_SIZE = "1024x1024";
const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 4.0;
const DEFAULT_SAMPLER = "euler";
const DEFAULT_SCHEDULER = "simple";
/** OpenAI's own cap on one request, and a sane one here: each image is a full pass through the sampler. */
export const MAX_N = 10;
export const SEED_MAX = 2 ** 31;

/** `${name}` exactly, and nothing else in the string: a placeholder is a whole value, never spliced into one, so a substituted number stays a number. */
const PLACEHOLDER = /^\$\{([a-z_]+)\}$/;

/** The size grammar OpenAI uses, which is also what the latent node takes. */
const SIZE = /^(\d{2,5})x(\d{2,5})$/;

/**
 * Replaces every `${name}` in the graph with `values[name]`, keeping the
 * value's own type -- `${width}` becomes a number, not `"512"`.
 *
 * A placeholder with no value throws rather than being sent: a graph edit that
 * names something the door does not supply is a broken render, and comfy
 * would answer for it with a shape error naming a node instead of the graph.
 */
export function fillWorkflow(node: unknown, values: Record<string, unknown>): unknown {
  if (typeof node === "string") {
    const placeholder: RegExpExecArray | null = PLACEHOLDER.exec(node);
    const name = placeholder?.[1];
    if (name === undefined) {
      return node;
    }
    if (!(name in values)) {
      throw new Error(`workflow names "\${${name}}", which this door does not supply`);
    }
    return values[name];
  }
  if (Array.isArray(node)) {
    return node.map((item) => fillWorkflow(item, values));
  }
  if (isRecord(node)) {
    return Object.fromEntries(
      // `_comment` is the graph's own prose. Sending it would have comfy
      // reject the whole prompt for an unknown node.
      Object.entries(node)
        .filter(([key]) => key !== "_comment")
        .map(([key, value]) => [key, fillWorkflow(value, values)]),
    );
  }
  return node;
}

/**
 * A refusal on its way out: the status and the words a `jsonError` will carry,
 * kept as data because provenance needs those words and a Response body reads
 * exactly once -- classifying by re-reading it would hand the caller a drained
 * body.
 */
export interface Refusal {
  status: number;
  error: string;
}

interface ImageRequest {
  prompt: string;
  negative: string;
  width: number;
  height: number;
  n: number;
  seed: number;
}

/** The OpenAI fields this verb reads, or the 400 that says which one is wrong. */
function parseImageRequest(body: Record<string, unknown>): ImageRequest | Response {
  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt === "") {
    return jsonError(STATUS_BAD_REQUEST, '"prompt" is required and must be a non-empty string');
  }
  const size = typeof body.size === "string" ? body.size : DEFAULT_SIZE;
  const dims: RegExpExecArray | null = SIZE.exec(size);
  if (dims === null) {
    return jsonError(STATUS_BAD_REQUEST, `"size" must be <width>x<height>, not "${size}"`);
  }
  const n = typeof body.n === "number" ? body.n : 1;
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) {
    return jsonError(STATUS_BAD_REQUEST, `"n" must be a whole number from 1 to ${MAX_N}`);
  }
  return {
    prompt,
    // Not an OpenAI field, and forwarded because a caller who knows they are
    // driving a diffusion model has no other way to say it.
    negative: typeof body.negative_prompt === "string" ? body.negative_prompt : "",
    width: Number(dims[1]),
    height: Number(dims[2]),
    n,
    // A fixed seed makes every request for one prompt the same image, which is
    // not what a caller asking twice wants. Honoured when given.
    seed: typeof body.seed === "number" ? body.seed : Math.floor(Math.random() * SEED_MAX),
  };
}

/** The checkpoint names this install loads, read off the route that pairs the engine with its upstream. */
function checkpointArgs(route: ResolvedRoute): Record<string, unknown> | Response {
  const required = ["unet", "clip", "clip_type", "vae"];
  const missing = required.filter((key) => typeof route.args[key] !== "string");
  if (missing.length > 0) {
    return jsonError(
      STATUS_BAD_REQUEST,
      `@/${route.engine}/${route.upstream} cannot render: its [route.args] is missing ${missing.join(", ")} -- these name the checkpoints on this box, so they belong in config, not the shipped graph`,
    );
  }
  return Object.fromEntries(required.map((key) => [key, route.args[key]]));
}

/**
 * The values every graph takes, whichever verb is rendering. The two differ
 * only in what they add: generations supplies the empty latent's dimensions,
 * edits the uploaded filename and how much of it to keep.
 */
export function commonValues(
  request: { prompt: string; negative: string; seed: number },
  checkpoints: Record<string, unknown>,
  index: number,
): Record<string, unknown> {
  return {
    ...checkpoints,
    prompt: request.prompt,
    negative: request.negative,
    seed: request.seed + index,
    steps: DEFAULT_STEPS,
    cfg: DEFAULT_CFG,
    sampler: DEFAULT_SAMPLER,
    scheduler: DEFAULT_SCHEDULER,
  };
}

/** The prompt ids comfy answered, one per image asked for. `values` is per image, because the seed walks. */
async function submitAll({
  ctx,
  route,
  base,
  httpClient,
  workflow,
  n,
  values,
}: {
  ctx: DoorContext;
  route: ResolvedRoute;
  base: string;
  httpClient: HttpClient;
  workflow: unknown;
  n: number;
  values: (index: number) => Record<string, unknown>;
}): Promise<string[] | Refusal> {
  const ids: string[] = [];
  for (let index = 0; index < n; index++) {
    // One prompt per image rather than a batch: the door submits one at a time
    // anyway, and a batch that fails half way answers with neither an image
    // nor a count a caller can act on.
    const filled = fillWorkflow(workflow, values(index));
    let promptId: string | undefined;
    const answered = await submitComfyPrompt({
      ctx,
      engineId: route.engine,
      base,
      httpClient,
      body: JSON.stringify({ prompt: filled }),
      onAnswered: (res, text) => {
        const id = parseRecord(text)?.prompt_id;
        if (res.ok && typeof id === "string") {
          promptId = id;
        }
        return new Response(text, { status: res.status });
      },
    });
    if (promptId === undefined) {
      return {
        status: answered.status === 200 ? STATUS_BAD_GATEWAY : answered.status,
        error: `@/${route.engine} refused the render: ${(await answered.text()).slice(0, 300)}`,
      };
    }
    ids.push(promptId);
  }
  return ids;
}

/** Every output filename comfy recorded for `promptId`, once it has finished. `undefined` while it is still running. */
function finishedFilenames(text: string, promptId: string): string[] | undefined {
  const entry = parseRecord(text)?.[promptId];
  if (!(isRecord(entry) && isRecord(entry.outputs))) {
    return undefined;
  }
  const names: string[] = [];
  for (const output of Object.values(entry.outputs)) {
    for (const image of isRecord(output) && Array.isArray(output.images) ? output.images : []) {
      if (isRecord(image) && typeof image.filename === "string") {
        names.push(image.filename);
      }
    }
  }
  return names.length > 0 ? names : undefined;
}

/** Every output comfy recorded, base64 -- or the refusal for the first one it will not hand back. */
async function fetchImages(
  base: string,
  httpClient: HttpClient,
  names: string[],
): Promise<string[] | Refusal> {
  const images: string[] = [];
  for (const filename of names) {
    const view = await httpClient(`${base}/view?filename=${encodeURIComponent(filename)}`);
    if (!view.ok) {
      await discardBody(view);
      return {
        status: STATUS_BAD_GATEWAY,
        error: `comfy produced "${filename}" but would not serve it`,
      };
    }
    images.push(Buffer.from(await view.arrayBuffer()).toString("base64"));
  }
  return images;
}

/** Waits for one render and returns its image bytes, base64. */
async function collect({
  base,
  httpClient,
  promptId,
  deadline,
  signal,
}: {
  base: string;
  httpClient: HttpClient;
  promptId: string;
  deadline: number;
  signal?: AbortSignal;
}): Promise<string[] | Refusal> {
  // Ask before the deadline is ever consulted, the order `pollUntil` documents:
  // the queue drain `submitAll` waits through can outlast this call's whole
  // budget, and a render comfy has already finished is still an answer.
  for (;;) {
    if (signal?.aborted === true) {
      return {
        status: STATUS_BAD_GATEWAY,
        error: "the caller hung up before the render finished",
      };
    }
    const history = await httpClient(`${base}/history/${encodeURIComponent(promptId)}`);
    const names = history.ok ? finishedFilenames(await history.text(), promptId) : undefined;
    if (names !== undefined) {
      return fetchImages(base, httpClient, names);
    }
    if (Date.now() >= deadline) {
      return {
        status: STATUS_BAD_GATEWAY,
        error: "the render did not finish before this call's deadline",
      };
    }
    await Bun.sleep(HISTORY_POLL_MS);
  }
}

/**
 * One render, whichever verb asked for it: lease the engine, submit `n`
 * prompts, wait for each, and write the one provenance line. A comfy engine
 * with no lease idle-stops out from under a job it is still running -- the
 * mediated proxy never had this problem, since a consumer polling `/history`
 * keeps touching the door.
 *
 * `plan` runs inside the lease and after the address is known, because an
 * edit has to upload its image to that container before it can name it in a
 * graph. It answers with the per-image values, or the refusal that ends the
 * call.
 */
export async function renderWith(
  ctx: DoorContext,
  job: {
    route: ResolvedRoute;
    rawModel: string | undefined;
    workflowPath: string;
    n: number;
    plan: (
      base: string,
      httpClient: HttpClient,
    ) => Promise<((index: number) => Record<string, unknown>) | Refusal>;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const { route, rawModel, workflowPath, n, plan, signal } = job;
  const entry = ctx.registry.entry(route.engine);
  const startedAt = Date.now();
  let leased = false;
  /**
   * Every failure return goes through `refuse`, so the line written below names
   * the same words the caller was given rather than reporting a render that
   * never happened as a success.
   */
  let refusal: Refusal | undefined;
  const refuse = (r: Refusal): Response => {
    refusal = r;
    return jsonError(r.status, r.error);
  };
  try {
    await ctx.registry.start(route.engine, undefined, { lease: true });
    leased = true;
    const privateUrl = ctx.lifecycle.getStatus(route.engine).private_url;
    if (privateUrl === null) {
      return refuse({
        status: STATUS_BAD_GATEWAY,
        error: `@/${route.engine} started but published no address`,
      });
    }
    const base = `http://${privateUrl}`;
    const httpClient = ctx.doorOpts.comfyHttpClient ?? fetch;
    const workflow = JSON.parse(readFileSync(workflowPath, "utf8")) as unknown;

    const values = await plan(base, httpClient);
    if (typeof values !== "function") {
      return refuse(values);
    }
    const ids = await submitAll({ ctx, route, base, httpClient, workflow, n, values });
    if (!Array.isArray(ids)) {
      return refuse(ids);
    }
    const deadline = Date.now() + ctx.getConfig().chat_timeout_seconds * MS_PER_SECOND;
    const data: { b64_json: string }[] = [];
    for (const id of ids) {
      const images = await collect({ base, httpClient, promptId: id, deadline, signal });
      if (!Array.isArray(images)) {
        return refuse(images);
      }
      data.push(...images.map((b64_json) => ({ b64_json })));
    }
    return Response.json({ created: Math.floor(startedAt / 1000), data });
  } catch (err) {
    return refuse({ status: STATUS_BAD_GATEWAY, error: errMessage(err) });
  } finally {
    if (leased) {
      ctx.lifecycle.endLease(route.engine, entry?.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
    }
    const ok = refusal === undefined;
    // One place words a failure, so an image refusal reads in journald exactly
    // as a chat hop's or an audio call's does.
    const failure =
      refusal === undefined
        ? undefined
        : (classifyResult({ status: refusal.status, body: jsonErrorBody(refusal.error) }).failure ??
          `http ${refusal.status}`);
    recordCall(
      {
        chain: null,
        requested: rawModel ?? "",
        attempts: [
          {
            engine: route.engine,
            // A comfy route is modelless, so the engine id is the whole
            // address a provenance reader can match on.
            model: route.engine,
            ok,
            ...(failure === undefined ? {} : { failure }),
            duration_ms: Date.now() - startedAt,
            upstream_used: route.upstream ?? undefined,
          },
        ],
        // The record's fields name what actually answered, so both are null
        // when nothing did; the attempt above keeps the resolved ids either way.
        engine_used: ok ? route.engine : null,
        upstream_used: ok ? (route.upstream ?? null) : null,
      },
      ctx.doorOpts.write,
    );
  }
}

/** The route and checkpoints an image verb renders through, or the 400 that says why it cannot. */
export function imageRoute(
  ctx: DoorContext,
  rawModel: string | undefined,
  endpoint: string,
): { route: ResolvedRoute; checkpoints: Record<string, unknown> } | Response {
  const resolved = resolveModel(rawModel, endpoint, ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error);
  }
  if (resolved.kind === "chain") {
    return jsonError(
      STATUS_BAD_REQUEST,
      "an image request cannot name a chain: a second engine's render is a different image, not a retry of the first",
    );
  }
  const checkpoints = checkpointArgs(resolved.route);
  return checkpoints instanceof Response ? checkpoints : { route: resolved.route, checkpoints };
}

/** The graph this engine ships for one verb, or the 400 naming the spec key it has no value for. */
export function workflowPathFor(
  ctx: DoorContext,
  engineId: string,
  key: "images_workflow" | "images_edit_workflow",
): string | Response {
  const spec = ctx.registry.specFor(engineId);
  const path = spec !== undefined && isContainerSpec(spec) ? spec[key] : undefined;
  return (
    path ??
    jsonError(STATUS_BAD_REQUEST, `@/${engineId} ships no "${key}", so it has no graph to render`)
  );
}

export async function handleImageGeneration(
  ctx: DoorContext,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const target = imageRoute(ctx, rawModel, CONTENT_ENDPOINT_IMAGES);
  if (target instanceof Response) {
    return target;
  }
  const request = parseImageRequest(body);
  if (request instanceof Response) {
    return request;
  }
  const path = workflowPathFor(ctx, target.route.engine, "images_workflow");
  if (path instanceof Response) {
    return path;
  }
  return await renderWith(ctx, {
    route: target.route,
    rawModel,
    workflowPath: path,
    n: request.n,
    plan: () =>
      Promise.resolve((index: number) => ({
        ...commonValues(request, target.checkpoints, index),
        width: request.width,
        height: request.height,
        batch: 1,
      })),
    signal,
  });
}
