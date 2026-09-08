/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import { mkdirSync } from "node:fs";
import process from "node:process";
import {
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  mintLaunchNonce,
  type RunAgenticResult,
  runAgentic,
} from "./agentic.ts";
import {
  handleAudioSpeech,
  handleAudioTranscription,
  handleVoiceUpload,
  VOICE_UPLOAD_PATH,
} from "./audioDoor.ts";
import { type HopExec, type HopResult, parseHop, runChain } from "./chain.ts";
import {
  COMFY_WS_SUFFIX,
  type ComfyWsData,
  comfyWebSocketHandlers,
  type EnginedServer,
  handleComfyProxy,
  handleComfyWsUpgrade,
  loadComfyBindings,
  matchComfyPath,
} from "./comfyProxy.ts";
import { loadConfig } from "./config.ts";
import { type Dispatch, resolveModel, resolveQualified, routeEgress } from "./dispatch.ts";
import { DockerLifecycle, dockerExec } from "./docker.ts";
import type { DoorContext, DoorOptions } from "./doorContext.ts";
import {
  DEFAULT_IDLE_STOP_SECONDS,
  DEFAULT_READY_TIMEOUT_S,
  EngineBusyError,
  EngineRegistry,
  type RegistryOptions,
} from "./engines.ts";
import type { Exec as SecretExec } from "./exec.ts";
import { proxyExtras } from "./extras.ts";
import {
  CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  jsonError,
  jsonErrorBody,
  SSE_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_CONFLICT,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_OK,
  STATUS_UNAVAILABLE,
} from "./http.ts";
import { handleImageGeneration } from "./images.ts";
import { LlamaRouter, reportedModelFrom } from "./llama.ts";
import { hopForwardsTools, modelsMenu } from "./modelsMenu.ts";
import { configPath, installDir, voicesDir } from "./paths.ts";
import { readJsonBody } from "./requestBody.ts";
import { loadSpec } from "./spec.ts";
import {
  type AgenticSpec,
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  type Config,
  EGRESS_RANK,
  type Egress,
  type EngineEntry,
  type EngineKind,
  errMessage,
  FatalError,
  isEgress,
  isRecord,
  MS_PER_SECOND,
  qualifiedSegments,
  type ResolvedRoute,
  routeForHop,
  type StartResponse,
  type StartRow,
  type Upstream,
} from "./types.ts";
import {
  noBaseUrlFix,
  resolveUpstream,
  resolveUpstreamSecret,
  upstreamPath,
  upstreamUrl,
} from "./upstream.ts";
import { runVisionProbe } from "./visionProbe.ts";

const CONTENT_ENDPOINTS = new Set([
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
]);

/**
 * The door's OpenAI surface is prefixed; llama-server and every remote provider
 * serve those same paths unprefixed. Strip ours before forwarding, or the
 * upstream is asked for a path only this door knows about.
 */
const OPENAI_PREFIX = "/openai";
function enginePath(doorPath: string): string {
  return doorPath.startsWith(`${OPENAI_PREFIX}/`) ? doorPath.slice(OPENAI_PREFIX.length) : doorPath;
}

/**
 * The launch-scoped door: `/openai/v1/<nonce>/...` dispatches exactly like
 * `/openai/v1/...`, with the request marked launch-scoped so a hop resolving
 * to an agentic engine can be refused. `<nonce>` is `mintLaunchNonce`'s 32
 * lowercase hex characters, minted at each of the two launch sites -- this
 * door's own dispatch and the registry's round-trip probe -- and never
 * written anywhere durable.
 */
const LAUNCH_NONCE_RE = /^\/openai\/v1\/([0-9a-f]{32})(\/.*)$/;

/** The address-keyed start route. An engine id is not a place, so there is no per-engine sibling. */
const START_PATH = "/engined/v1/start";
const STOP_RE = /^\/engined\/v1\/engines\/([^/]+)\/stop$/;
const LOGS_RE = /^\/engined\/v1\/engines\/([^/]+)\/logs$/;
const RESOURCES_RE = /^\/engined\/v1\/engines\/([^/]+)\/resources$/;
const RELEASE_RE = /^\/engined\/v1\/engines\/([^/]+)\/release$/;
/** Idle loopback connections do get dropped; a comment frame is the cheapest thing that keeps one alive. */
const SSE_KEEPALIVE_MS = 30_000;
/** Enough to see a crash's stack without streaming a whole boot log by default. */
const DEFAULT_LOG_TAIL = 200;
const MAX_LOG_TAIL = 5000;

/** As `URL#hostname` reports them: no port; an IPv6 literal keeps its brackets. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Origin/Host refusals are 403 and carry no engine detail: the caller failed the door, not an engine. */
function refuse(message: string): Response {
  return jsonError(STATUS_FORBIDDEN, message);
}

function isLoopbackHost(hostHeader: string, port: number): boolean {
  try {
    const url = new URL(`http://${hostHeader}`);
    const effectivePort = url.port === "" ? "80" : url.port;
    return LOOPBACK_HOSTNAMES.has(url.hostname) && effectivePort === String(port);
  } catch {
    return false;
  }
}

/**
 * Every endpoint including reads, before routing. Any `Origin` header at all
 * is refused — including the literal string `"null"` — because engined never
 * allowlists a consumer's origin: the one browser consumer (sagaforge's
 * settings page) reaches engined through the daemon it already talks to, and
 * a request with no `Origin` (every CLI and server consumer) is unaffected.
 */
function checkOrigin(req: Request, port: number): Response | null {
  if (req.headers.get("Origin") !== null) {
    return refuse("cross-origin requests are refused");
  }
  const host = req.headers.get("Host");
  if (host !== null && !isLoopbackHost(host, port)) {
    return refuse(`Host "${host}" is outside the loopback set`);
  }
  return null;
}

/**
 * Contention comes from the routers, which the door owns and the registry has
 * never heard of -- so it is added here rather than by giving `EngineRegistry`
 * a back-reference to the door. An engine no request has touched yet has no
 * router, and so reports no roles, which is the honest answer.
 */
async function handleEngines(ctx: DoorContext, configErr: string | undefined): Promise<Response> {
  const listed = await ctx.registry.list();
  for (const engine of listed.engines) {
    const busy = ctx.llamaRouters.get(engine.id)?.contention();
    if (busy !== undefined && busy.length > 0) {
      engine.roles = busy;
    }
  }
  listed.config_error = configErr;
  return Response.json(listed);
}

/**
 * `/engined/v1/start`'s target: a chain name resolves to its FIRST hop only
 * (warming exists to avoid a cold first turn; starting every hop spins up
 * containers for requests the first hop will answer), a bare `@/<model>`
 * resolves to every route offering it -- one address can name more than one
 * engine, unlike the single-winner pick a chat dispatch makes -- and the
 * two/three-segment forms are already engine-specific.
 */
function resolveStartRoutes(
  model: string,
  ctx: DoorContext,
): { ok: true; routes: readonly ResolvedRoute[] } | { ok: false; error: string } {
  const config = ctx.getConfig();
  const chainHops = config.chains[model];
  if (chainHops !== undefined) {
    const [first] = chainHops;
    if (first === undefined) {
      return { ok: false, error: `chain "${model}" has no hops` };
    }
    const hop = parseHop(first);
    const route = routeForHop(config.routes, hop.engine, hop.model, hop.upstream);
    return route === undefined
      ? { ok: false, error: `chain "${model}"'s first hop "${first}" does not resolve to a route` }
      : { ok: true, routes: [route] };
  }
  const segments = qualifiedSegments(model);
  if (segments === undefined) {
    return { ok: false, error: `unknown model "${model}"` };
  }
  if (segments.length === 1) {
    const modelId = segments[0] as string;
    const candidates = config.routes.filter((r) => !r.disabled && r.model === modelId);
    return candidates.length === 0
      ? { ok: false, error: `model "${modelId}" does not exist` }
      : { ok: true, routes: candidates };
  }
  const resolved = resolveQualified(segments, { config, registry: ctx.registry });
  return resolved.ok ? { ok: true, routes: [resolved.route] } : resolved;
}

/** The canonical `@/...` a route answers for -- always the fully explicit form, never a URL. A start row reports it; a chat dispatch walks it as the one hop `runChain` takes. */
function routeAddress(route: ResolvedRoute): string {
  const upstreamPart = route.upstream === null ? "" : `/${route.upstream}`;
  const modelPart = route.model === undefined ? "" : `/${route.model}`;
  return `@/${route.engine}${upstreamPart}${modelPart}`;
}

/**
 * One resolved route's action, by engine class:
 *  - the local llama router: `warm`, the only start path there is now.
 *  - a container engine with a per-model route (whisper): the stop-and-restart
 *    already in `EngineRegistry.start`, `model` carried through so its own
 *    409-on-held-leases applies.
 *  - anything else local (comfy, a container-less agentic-cli route): the
 *    same `EngineRegistry.start` call, which is already a plain availability
 *    check with nothing to start for a spec that runs no container.
 *  - a route whose upstream is not `"local"` at all: a no-op that says so,
 *    never an error -- warming a peer or provider is not this delivery's job.
 * Never routes a non-llama engine through `getLlamaRouter`: a whisper route
 * carries `filename` and no `role`, and `warm` throws on a roleless model.
 */
async function startRoute(ctx: DoorContext, route: ResolvedRoute): Promise<StartRow> {
  const address = routeAddress(route);
  const { engine: engineId, upstream } = route;
  if (upstream !== "local") {
    const status = ctx.registry.get(engineId);
    const row = {
      address,
      engine: engineId,
      upstream,
      state: status?.state ?? "unavailable",
      fix: `upstream "${upstream ?? "ambient"}" is not local; nothing to start here`,
      started: false,
    };
    return row;
  }
  if (ctx.registry.isLocalLlama(engineId)) {
    const engineEntry = ctx.registry.entry(engineId);
    if (engineEntry === undefined) {
      const row = {
        address,
        engine: engineId,
        upstream,
        state: "unavailable" as const,
        fix: `unknown engine "${engineId}"`,
        started: false,
      };
      return row;
    }
    // `warm` reports whether this call is the one that swapped the resident
    // -- its own lease queue already knows, computed per caller -- so two
    // concurrent starts on one cold model never both claim they started it.
    const started = await getLlamaRouter(ctx, engineEntry).warm(route);
    const status = ctx.registry.get(engineId);
    const row = {
      address,
      engine: engineId,
      upstream,
      state: status?.state ?? "unavailable",
      fix: status?.fix,
      started,
    };
    return row;
  }
  const status = await ctx.registry.start(engineId, route.model);
  const row = {
    address,
    engine: engineId,
    upstream,
    state: status.state,
    fix: status.fix,
    started: status.launched,
  };
  return row;
}

/**
 * `POST /engined/v1/start`: a model address or a chain name, resolved to the
 * route(s) it names and started where "started" means something. Never hands
 * back a `url` -- reaching the engine is a separate request, to the door, by
 * address; this verb only answers what state it is in.
 */
async function handleStart(ctx: DoorContext, req: Request): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  const model = typeof body.model === "string" ? body.model : "";
  if (model === "") {
    return jsonError(STATUS_BAD_REQUEST, "model is required");
  }
  const resolved = resolveStartRoutes(model, ctx);
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error);
  }
  try {
    const data = await Promise.all(resolved.routes.map((route) => startRoute(ctx, route)));
    return Response.json({ object: "list", data } satisfies StartResponse);
  } catch (err) {
    if (err instanceof EngineBusyError) {
      return jsonError(STATUS_CONFLICT, err.message);
    }
    return jsonError(STATUS_BAD_GATEWAY, errMessage(err));
  }
}

async function handleStop(registry: EngineRegistry, id: string): Promise<Response> {
  try {
    return Response.json(await registry.stop(id));
  } catch (err) {
    return jsonError(STATUS_NOT_FOUND, errMessage(err));
  }
}

/**
 * `?tail=` is clamped rather than rejected: a consumer asking for more lines
 * than the door will serve wants as many as it can get, not a 400.
 */
async function handleLogs(registry: EngineRegistry, id: string, url: URL): Promise<Response> {
  const asked = Number(url.searchParams.get("tail") ?? DEFAULT_LOG_TAIL);
  const tail = Number.isFinite(asked)
    ? Math.min(Math.max(1, Math.trunc(asked)), MAX_LOG_TAIL)
    : DEFAULT_LOG_TAIL;
  const res = await registry.logs(id, tail);
  return "error" in res ? jsonError(STATUS_NOT_FOUND, res.error) : Response.json(res);
}

async function handleRelease(registry: EngineRegistry, id: string): Promise<Response> {
  const res = await registry.release(id);
  return "error" in res ? jsonError(STATUS_BAD_REQUEST, res.error) : Response.json(res);
}

async function handleResources(registry: EngineRegistry, id: string): Promise<Response> {
  const res = await registry.resources(id);
  return "error" in res ? jsonError(STATUS_NOT_FOUND, res.error) : Response.json(res);
}

/** The llama.cpp routes proxied straight through: always the one local llama engine. */
const EXTRAS_RE = /^\/engined\/v1\/engines\/([^/]+)\/(tokenize|apply-template)$/;

/**
 * An explicit `null` from the caller unsets a wire default rather than being
 * forwarded as a null. Without this a caller can override an `[engine.args]`
 * key but never remove one, and a vendor that answers 400 for a parameter is
 * unrecoverable: the caller drops the field from its retry, and engined puts
 * the configured value straight back.
 *
 * Only the caller's own nulls count. A null in `[engine.args]` is the operator
 * saying to send one, which is a different instruction.
 */
function withoutCallerNulls(
  merged: Record<string, unknown>,
  caller: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...merged };
  for (const [key, value] of Object.entries(caller)) {
    if (value === null) {
      delete out[key];
    }
  }
  return out;
}

function stripField(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const rest = { ...body };
  delete rest[field];
  return rest;
}

/**
 * `rawBody.model` is whatever the caller's own request named -- a chain
 * name, an alias, anything -- never necessarily this hop's resolved model
 * id, so it is overwritten rather than forwarded verbatim. `workdir` is
 * stripped; every other caller-supplied field passes through.
 *
 * Shared by the local llama proxy and the remote HTTP proxy: both speak the
 * same OpenAI body, and the only thing that differs is where it is posted
 * and what proves the caller may post it.
 */
function openAiRequestInit(
  rawBody: Record<string, unknown>,
  resolvedModelId: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify({ ...stripField(rawBody, "workdir"), model: resolvedModelId }),
    signal,
  };
}

/** `claude -p` takes one prompt on stdin; OpenAI's `messages` array has no such shape upstream to borrow. */
function promptFromMessages(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .map((m) => (isRecord(m) ? `${String(m.role ?? "user")}: ${String(m.content ?? "")}` : ""))
    .join("\n");
}

/**
 * Whether a field's VALUE demands something no agent CLI has a channel for:
 * `agents.ts`'s whole contract is a prompt string in and answer text out
 * (`parse` yields a `result` string, `delta` an answer fragment), and an
 * agent's own `tools` are engined's read-only floor rather than the
 * caller's. So neither half of a tool loop can cross the boundary in either
 * direction, and dropping such a field silently hands a caller's tool loop
 * prose it will parse as an answer.
 *
 * Both spellings are here: a client sending OpenAI's original
 * `functions`/`function_call` pair asks for exactly what `tools`/
 * `tool_choice` asks for, so covering only the newer names leaves the same
 * tool loop reading prose under a different key.
 *
 * Keyed on the value and not the key, because the values that ask for
 * nothing are exactly what an agent already does: an empty `tools` offers
 * none, `tool_choice: "none"` forbids them outright, `"auto"` permits prose,
 * and `response_format: {type: "text"}` IS prose. Several
 * OpenAI-compatible clients send those unconditionally, and refusing them
 * would refuse traffic that wants nothing.
 *
 * `parallel_tool_calls` is absent: it constrains how tool calls are issued,
 * never that any are, so a body carrying it either also carries a `tools`
 * that demands them or asks for nothing at all.
 */
const AGENTIC_UNHONOURABLE: Record<string, (value: unknown) => boolean> = {
  tools: (v) => !Array.isArray(v) || v.length > 0,
  tool_choice: (v) => v !== "none" && v !== "auto",
  functions: (v) => !Array.isArray(v) || v.length > 0,
  function_call: (v) => v !== "none" && v !== "auto",
  response_format: (v) => !isRecord(v) || v.type !== "text",
};

/** The two list-of-tools fields, which a `"none"` choice cancels however long the list is. */
const AGENTIC_TOOL_LISTS = new Set(["tools", "functions"]);

/**
 * Which of those fields this body carries a demanding value for, in the
 * order a caller would read them back. A caller's `null` unsets a wire
 * default (`withoutCallerNulls`) rather than demanding anything.
 *
 * A `"none"` choice is read across fields, not just on its own: it is the
 * caller asking for prose outright, so the tool list it accompanies demands
 * nothing either -- and a client that sends `"none"` is by definition one
 * carrying a list, which is the very shape this refusal exists to let
 * through.
 */
function unhonourableFields(body: Record<string, unknown>): string[] {
  const noneChosen = body.tool_choice === "none" || body.function_call === "none";
  return Object.entries(AGENTIC_UNHONOURABLE)
    .filter(([key, demands]) => {
      if (noneChosen && AGENTIC_TOOL_LISTS.has(key)) {
        return false;
      }
      const value = body[key];
      return value !== undefined && value !== null && demands(value);
    })
    .map(([key]) => key);
}

let agenticCallSeq = 0;

/**
 * The minimal OpenAI chat-completion shape a caller expects back. `usage` is
 * absent rather than zeroed: an agentic CLI reports no token counts, and a
 * fabricated zero reads as a real measurement. A consumer that needs usage
 * needs the CLI to report it first.
 */
function agenticEnvelope(text: string | undefined): Record<string, unknown> {
  agenticCallSeq += 1;
  return {
    id: `agentic-${Date.now()}-${agenticCallSeq}`,
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content: text ?? "" }, finish_reason: "stop" },
    ],
  };
}

export interface Door {
  /**
   * Two call shapes, not one loosely-typed signature: every existing caller
   * -- every test in this repo included -- calls this with one argument and
   * must keep getting a real `Response` back, never `undefined`. Only
   * `bindDualFamily`'s real `Bun.serve` wiring ever supplies `server`, and
   * only then can a websocket upgrade actually happen -- the one case this
   * can answer with nothing at all, because the connection itself became
   * the answer.
   */
  fetch: {
    (req: Request): Response | Promise<Response>;
    (req: Request, server: EnginedServer): Response | Promise<Response> | undefined;
  };
  /** Re-reads `path`. Invalid TOML keeps the running config and records the error. */
  reload: (path: string) => void;
  registry: EngineRegistry;
  configError: () => string | undefined;
}

function getLlamaRouter(ctx: DoorContext, engine: EngineEntry): LlamaRouter {
  const cached = ctx.llamaRouters.get(engine.id);
  if (cached && (!ctx.staleLlamaRouters.has(engine.id) || cached.hasOutstandingLeases())) {
    return cached;
  }
  ctx.staleLlamaRouters.delete(engine.id);
  const routes = ctx
    .getConfig()
    .routes.filter((r) => r.engine === engine.id && r.upstream === "local");
  const router = new LlamaRouter(engine, routes, ctx.lifecycle, {
    enginesRoot: ctx.registryOpts.enginesRoot,
    bunx: ctx.registryOpts.bunx,
    idleStopSeconds: engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
    readyTimeoutS: engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
    httpClient: ctx.doorOpts.llamaHttpClient,
    presetHostPath: ctx.doorOpts.llamaPresetHostPath,
  });
  ctx.llamaRouters.set(engine.id, router);
  return router;
}

/**
 * An engine has no address of its own, so a hop's egress is whichever
 * upstream ITS OWN resolved route names -- never the engine id alone, which
 * a two-upstream engine (`@/claude/anthropic/sonnet-5` and
 * `@/claude/local/ornith`) cannot answer for on its own. Fail-closed
 * `"remote"` when the hop cannot be resolved to a route at all, the same
 * rule every other unresolvable-address case follows.
 */
function egressOf(ctx: DoorContext, hop: string): Egress {
  const config = ctx.getConfig();
  const { engine: engineId, upstream: upstreamSeg, model } = parseHop(hop);
  const route = routeForHop(config.routes, engineId, model, upstreamSeg);
  return route === undefined ? "remote" : routeEgress(route, config);
}

interface HopRequest {
  pathname: string;
  rawBody: Record<string, unknown>;
  setContentType: (ct: string) => void;
  /** Whether ANY hop of the chain this one belongs to forwards tool-calling fields, which is what makes an agentic hop's refusal advance rather than terminate. */
  toolsHonourableElsewhere: boolean;
  /** Whether the caller addressed a chain rather than one engine. Nothing in the hops themselves answers this, and a chain caller owns none of the omissions a single hop's own shape needs. */
  inChain: boolean;
}

/** One `openai-http` hop, resolved: the engine answering it, the model segment it was addressed by, and the route (if any) that segment resolved to. */
interface HttpHop {
  engineEntry: EngineEntry;
  modelSeg: string;
  route: ResolvedRoute | undefined;
  req: HopRequest & { signal: AbortSignal };
}

/**
 * The `openai-http` case: proxy through this engine's `LlamaRouter`, `workdir`
 * stripped. `req.signal` is `runOneHop`'s own per-hop timeout/caller-abort --
 * forwarded into `RequestInit` so a slow upstream is actually cut off at the
 * budget `chatTimeoutMs` picked, not just marked aborted after the fact.
 */
async function execLlama(
  ctx: DoorContext,
  { engineEntry, modelSeg, route, req }: HttpHop,
): Promise<HopResult> {
  if (!route) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`model "${modelSeg}" not found on "${engineEntry.id}"`),
    };
  }
  const router = getLlamaRouter(ctx, engineEntry);
  // Both fetchBuffered and fetchStreamed take this same `init`, so
  // rewriting `model` once here fixes both proxy paths.
  const init = openAiRequestInit(req.rawBody, route.model ?? modelSeg, req.signal);
  // `modelResident` comes back with the hop, read under the same lease: from
  // the engine's own /v1/models — never the router's cached command
  // bookkeeping, and never model_reported: the two answer different questions
  // and one silently standing in for the other defeats provenance.
  const { response, modelResident } = await router.proxy(route, enginePath(req.pathname), init);
  const { stream, modelReported } = await readHopBody(response, req.setContentType);
  return {
    status: response.status,
    stream,
    modelReported,
    modelResident,
  };
}

/**
 * The half of a hop's response handling that has nothing to do with which
 * kind of engine answered: pick the content type, hand the caller its bytes
 * untouched, and learn the model the upstream says it used.
 *
 * A buffered JSON response is parsed from a clone, so the caller's own read
 * stays untouched. An SSE body cannot be buffered the same way — those bytes
 * are already owed to the caller as they arrive — so it is teed instead: one
 * branch goes back to the caller unread, the other is sniffed only far
 * enough to find the first `data:` frame's model id.
 */
async function readHopBody(
  response: Response,
  setContentType: (ct: string) => void,
): Promise<{ stream: ReadableStream<Uint8Array> | undefined; modelReported: string | undefined }> {
  const contentType = response.headers.get(CONTENT_TYPE) ?? JSON_CONTENT_TYPE;
  setContentType(contentType);
  if (contentType.includes(JSON_CONTENT_TYPE)) {
    // `.clone()` before `.body` is ever touched: reading the getter first
    // disturbs the body Bun's clone() then tees from.
    const modelReported = reportedModelFrom(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    );
    return { stream: response.body ?? undefined, modelReported };
  }
  if (contentType.includes(SSE_CONTENT_TYPE) && response.body) {
    const [forCaller, forSniff] = response.body.tee();
    return { stream: forCaller, modelReported: await firstReportedModel(forSniff) };
  }
  return { stream: response.body ?? undefined, modelReported: undefined };
}

const SSE_FRAME_BOUNDARY = "\n\n";

/** The first `data:` line in one SSE frame that parses to an object carrying `model`, if any. */
function reportedModelFromFrame(frame: string): string | undefined {
  for (const line of frame.split("\n")) {
    if (!line.startsWith("data:")) {
      continue;
    }
    const data = line.slice("data:".length).trim();
    if (data === "" || data === "[DONE]") {
      continue;
    }
    try {
      const model = reportedModelFrom(JSON.parse(data));
      if (model !== undefined) {
        return model;
      }
    } catch {
      // Not JSON -- the next frame might still carry it.
    }
  }
}

/**
 * Reads only as far as the first `data:` frame that parses to an object with
 * a `model` field, then cancels its reader — the tee's other branch keeps
 * flowing to the caller regardless of how much of this one was drained. A
 * stream that never carries one, ends first, or errors mid-read resolves
 * `undefined`: an absent field is honest, a guessed one is not.
 */
async function firstReportedModel(sniff: ReadableStream<Uint8Array>): Promise<string | undefined> {
  const reader = sniff.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value) {
        buffered += decoder.decode(value, { stream: true });
      }
      const frames = buffered.split(SSE_FRAME_BOUNDARY);
      buffered = frames.pop() ?? "";
      for (const frame of frames) {
        const model = reportedModelFromFrame(frame);
        if (model !== undefined) {
          return model;
        }
      }
      if (done) {
        return;
      }
    }
  } catch {
    // A sniff-read failure is not the caller's failure: the tee's other
    // branch shares the same underlying source and reports it independently.
  } finally {
    reader.cancel().catch(() => undefined);
  }
}

/**
 * An engine has no address of its own -- claude routed at Moonshot is still
 * the engine "claude", loading `engines/claude/spec.toml` exactly like the
 * ambient route does. Only its resolved upstream differs.
 */
function loadAgenticSpec(ctx: DoorContext, engineEntry: EngineEntry) {
  return loadSpec(engineEntry, {
    enginesRoot: ctx.registryOpts.enginesRoot,
    bunx: ctx.registryOpts.bunx,
  });
}

/**
 * `secret.header` is what actually decides which env var carries the key --
 * not a free choice, and not always `ANTHROPIC_API_KEY`. `x-api-key` (Kimi's
 * own coding endpoint's required header) is `ANTHROPIC_API_KEY` verbatim, the
 * CLI's own default. `authorization` (an Anthropic-compatible Bearer gateway,
 * e.g. OpenRouter) is `ANTHROPIC_AUTH_TOKEN` -- and `ANTHROPIC_API_KEY` must
 * still be set, to the EMPTY STRING, because an unset var and an empty one
 * behave differently: unset, the CLI falls back to sending `x-api-key` and
 * the gateway 401s every request. Measured against `~/.local/bin/claude-openrouter`
 * on this box.
 *
 * Every model tier is pointed at the same `model`, so nothing silently
 * falls back to an Anthropic-named tier this endpoint does not serve. The
 * telemetry/agent-feature vars are cheap to carry and keep a read-only
 * completion from spawning machinery nobody asked for against a billing
 * account this call was never going to use.
 */
function redirectEnv(
  baseUrl: string,
  secretHeader: string,
  apiKey: string,
  model: string | undefined,
  doorUrl: string,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ...(secretHeader === "authorization"
      ? { ANTHROPIC_AUTH_TOKEN: apiKey, ANTHROPIC_API_KEY: "" }
      : { ANTHROPIC_API_KEY: apiKey }),
    // The launch-scoped door: closes the recursion hazard this agent's own
    // network reach into engined otherwise opens. Carried alongside the
    // real redirect rather than in place of it -- this agent's own
    // inference still goes straight to `baseUrl`, never through here.
    ENGINED_DOOR_URL: doorUrl,
    DISABLE_AUTOUPDATER: "1",
    DISABLE_TELEMETRY: "1",
    DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_AGENT_VIEW: "1",
    CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: "1",
    CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: "1",
    ENABLE_TOOL_SEARCH: "false",
  };
  if (model === undefined) {
    return env;
  }
  return { ...env, ...claudeModelEnv(model) };
}

/** Every variable claude reads a model from, so the address segment wins over any tier default. */
function claudeModelEnv(model: string): Record<string, string> {
  return {
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/**
 * The id an upstream actually knows this model by: a route's own
 * `wire_model` when it declared one (an address segment that cannot spell
 * the real id, e.g. an `org/model` slug), else the address segment itself.
 * Shared by the agentic redirect and the remote HTTP proxy: both hand this
 * id straight to someone else's service, where the address a caller dialed
 * would simply 404.
 */
function resolveUpstreamModelId(
  config: Config,
  engineId: string,
  modelSeg: string,
  upstream?: string,
): string | undefined {
  if (modelSeg === "") {
    return;
  }
  const route = routeForHop(config.routes, engineId, modelSeg, upstream);
  return route?.wire_model ?? route?.model ?? modelSeg;
}

type RedirectResolution =
  | { ok: true; env: Record<string, string> }
  | { ok: false; result: HopResult };

/**
 * A failed secret is a 5xx: `runChain` advances past a dead engine rather
 * than failing every consumer of the chain for one unconfigured remote key,
 * and a lone request to just this engine surfaces the fix command directly.
 * The resolved value only ever reaches the child's environment below --
 * never a log line, an error body, or anything this function returns.
 */
interface RedirectOptions {
  upstream: Upstream;
  engineId: string;
  modelSeg: string;
  config: Config;
  doorUrl: string;
  secretExec?: SecretExec;
}

export async function resolveRedirect({
  upstream,
  engineId,
  modelSeg,
  config,
  doorUrl,
  secretExec,
}: RedirectOptions): Promise<RedirectResolution> {
  const { base_url } = upstream;
  if (base_url === undefined) {
    // Config requires a secret alongside a base_url but not the converse, so
    // an address-less upstream reaches here and must refuse rather than hand
    // the child an undefined upstream.
    return {
      ok: false,
      result: { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(noBaseUrlFix(upstream.id)) },
    };
  }
  const resolved = await resolveUpstreamSecret(upstream, secretExec);
  if (!resolved.ok) {
    return { ok: false, result: { status: resolved.status, body: jsonErrorBody(resolved.error) } };
  }
  const model = resolveUpstreamModelId(config, engineId, modelSeg, upstream.id);
  return {
    ok: true,
    env: redirectEnv(base_url, resolved.header, resolved.value, model, doorUrl),
  };
}

/** `runAgentic`'s outcome, mapped to a hop's result. `version` is carried through either way -- a failed launch still ran a real, pinned process. */
function hopResultFromAgenticOutcome(outcome: Awaited<ReturnType<typeof runAgentic>>): HopResult {
  if (!outcome.ok) {
    return {
      status: outcome.status,
      body: jsonErrorBody(outcome.failure ?? "agentic call failed"),
      envelopeFailure: outcome.envelopeFailure,
      // An envelope failure's text is the child's own parsed stdout; every
      // other agentic failure here is engined's sentence about the launch.
      bodyCarriesAgentOutput: outcome.envelopeFailure,
      version: outcome.version,
    };
  }
  return {
    status: outcome.status,
    body: agenticEnvelope(outcome.result),
    version: outcome.version,
  };
}

/** The pin proof, which `runAgentic`'s own workdir-required 400 comes before. `null` means nothing is wrong. */
async function proveAgenticPin(ctx: DoorContext, engineId: string): Promise<HopResult | null> {
  const proof = await ctx.registry.start(engineId);
  if (proof.state === "installed") {
    return null;
  }
  // A plain 503, matching resolveRedirect's own secret-resolution failure: an
  // engine that cannot prove its pin is unavailable, not a proven envelope
  // failure, so a chain skips it (the same rule) rather than treating it as
  // terminal.
  return {
    status: STATUS_UNAVAILABLE,
    body: jsonErrorBody(proof.fix ?? `engine "${engineId}" is not installed`),
    // A probe's fix quotes what the child printed -- its parsed stdout and a
    // tail of its stderr -- so this body answers the caller but stays out of
    // the recorded failure.
    bodyCarriesAgentOutput: true,
  };
}

interface AgenticHop {
  engineId: string;
  modelSeg: string;
  route: ResolvedRoute | undefined;
  req: {
    rawBody: Record<string, unknown>;
    signal: AbortSignal;
    setContentType: (ct: string) => void;
    toolsHonourableElsewhere: boolean;
    inChain: boolean;
  };
}

interface RouteRedirectOptions {
  engineId: string;
  modelSeg: string;
  route: ResolvedRoute | undefined;
  doorUrl: string;
}

type RouteRedirect =
  | { ok: true; env: Record<string, string> | undefined }
  | { ok: false; result: HopResult };

/**
 * A route naming a real upstream (not ambient, not this box's own `local`)
 * redirects to it: the engine's own launch is identical either way, only
 * its resolved upstream differs. `env: undefined` is the ambient case.
 */
function resolveRouteRedirect(
  ctx: DoorContext,
  { engineId, modelSeg, route, doorUrl }: RouteRedirectOptions,
): RouteRedirect | Promise<RouteRedirect> {
  const upstreamId = route?.upstream ?? null;
  if (upstreamId === null || upstreamId === "local") {
    return { ok: true, env: undefined };
  }
  const config = ctx.getConfig();
  const upstream = config.upstreams.find((u) => u.id === upstreamId);
  if (upstream === undefined) {
    return {
      ok: false,
      result: {
        status: STATUS_BAD_GATEWAY,
        body: jsonErrorBody(`engine "${engineId}" names unknown upstream "${upstreamId}"`),
      },
    };
  }
  return resolveRedirect({
    upstream,
    engineId,
    modelSeg,
    config,
    doorUrl,
    secretExec: ctx.doorOpts.secretExec,
  });
}

/**
 * Ambient claude has no upstream to redirect to, but the model segment
 * still has to reach the CLI -- otherwise `@/claude/sonnet-5` and
 * `@/claude/opus-4` launch the same process.
 */
function ambientAgentEnv(
  agent: string,
  modelSeg: string,
  route: ResolvedRoute | undefined,
): Record<string, string> | undefined {
  const ambientModel =
    route?.wire_model ?? route?.model ?? (modelSeg === "" ? undefined : modelSeg);
  return agent === "claude" && ambientModel !== undefined
    ? claudeModelEnv(ambientModel)
    : undefined;
}

interface AgenticLaunch {
  spec: AgenticSpec;
  engineEntry: EngineEntry;
  agentVersion: string;
  doorUrl: string;
  /**
   * The model id this agent is told to dial back through the door -- its
   * route's `wire_model` when it declared one, else the address segment.
   * NOT the address a caller used: `@/opencode/code` names the opencode
   * route, and handing that route's own segment back to the child points it
   * at itself, so the name has to resolve to a model on its own. A
   * slash-bearing address cannot be a `model` segment (`config.ts` refuses
   * one), which is exactly why `wire_model` is where it goes.
   */
  dialModel: string;
  workdir: string | undefined;
  extraEnv: Record<string, string> | undefined;
  req: AgenticHop["req"];
  /** Called when the answer is handed off as a stream that outlives the hop; `run` settles when the child exits. */
  onHandoff: (run: Promise<unknown>) => void;
}

async function launchAgentic(ctx: DoorContext, launch: AgenticLaunch): Promise<HopResult> {
  const { spec, engineEntry, agentVersion, doorUrl, dialModel, workdir, extraEnv, req } = launch;
  const { rawBody, signal } = req;
  const wantsStream = rawBody.stream === true;
  const deltas: string[] = [];
  let pump: (() => void) | undefined;
  let first: (arrived: "delta" | "done") => void = () => undefined;
  const firstSignal = new Promise<"delta" | "done">((resolve) => {
    first = resolve;
  });
  const run = runAgentic({
    agent: spec.agent,
    agentVersion,
    // An agent CLI reaches its model back through engined's own door, so an
    // opencode turn is dispatched, chained and accounted for like any other
    // -- always on the launch-scoped URL, never the plain one. An agent with
    // no `configure` (claude) simply never reads this.
    upstream: { baseUrl: doorUrl, model: dialModel },
    args: engineEntry.args,
    envAllowlist: spec.env,
    workdir,
    prompt: promptFromMessages(rawBody),
    spawn: ctx.doorOpts.agenticSpawn ?? defaultAgenticSpawn,
    bunx: ctx.registryOpts.bunx,
    ambientEnv: ctx.doorOpts.agenticAmbientEnv,
    extraEnv,
    signal,
    onDelta: wantsStream
      ? (text) => {
          deltas.push(text);
          pump?.();
          first("delta");
        }
      : undefined,
  });
  run.then(
    () => first("done"),
    () => first("done"),
  );
  // Commit to a stream only once the CLI has printed answer text: every
  // pre-spawn refusal (400 workdir, floor, secret) and an envelope that
  // fails before its first delta still land as a plain status.
  if (wantsStream && (await firstSignal) === "delta") {
    launch.onHandoff(run);
    req.setContentType(SSE_CONTENT_TYPE);
    return {
      status: STATUS_OK,
      stream: agenticSse(run, deltas, (p) => {
        pump = p;
      }),
      version: agentVersion,
    };
  }
  return hopResultFromAgenticOutcome(await run);
}

type AgenticEntry =
  | { ok: true; engineEntry: EngineEntry; agentVersion: string }
  | { ok: false; result: HopResult };

function agenticRefusal(message: string): AgenticEntry {
  return { ok: false, result: { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(message) } };
}

/** The engine and the pin it launches at -- or the refusal for one missing either. */
function agenticEntry(ctx: DoorContext, engineId: string): AgenticEntry {
  const engineEntry = ctx.registry.entry(engineId);
  if (!engineEntry) {
    return agenticRefusal(`unknown engine "${engineId}"`);
  }
  const agentVersion = engineEntry.agent_version;
  if (agentVersion === undefined) {
    return agenticRefusal(`engine "${engineId}" has no agent_version configured`);
  }
  return { ok: true, engineEntry, agentVersion };
}

/**
 * Only reachable if an engine routed here carries a non-agentic spec, which
 * the kind check upstream already rules out -- but `agent` is what decides the
 * floor, so it is never read off a spec that has not proven it has one.
 */
function agenticSpecOf(ctx: DoorContext, engineEntry: EngineEntry): AgenticSpec | HopResult {
  const { spec } = loadAgenticSpec(ctx, engineEntry);
  if (spec.kind !== "agentic-cli") {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineEntry.id}" is not an agentic-cli spec`),
    };
  }
  return spec;
}

/**
 * A 502 only while a later hop could still forward these: the refusal is
 * then about this engine's shape rather than the caller's request, the same
 * reason a credential-shaped status advances. With no such hop anywhere in
 * the chain nothing downstream can fix it, so the answer is a terminal 400
 * naming the fields -- which `tools` on the `/openai/v1/models` row also
 * says, discoverable before the first call rather than after it.
 */
function unhonourableRefusal(engineId: string, req: AgenticHop["req"]): HopResult | null {
  const unhonourable = unhonourableFields(req.rawBody);
  if (unhonourable.length === 0) {
    return null;
  }
  return {
    status: req.toolsHonourableElsewhere ? STATUS_BAD_GATEWAY : STATUS_BAD_REQUEST,
    body: jsonErrorBody(
      `engine "${engineId}" is agentic and cannot honour ${unhonourable.join(", ")} -- an agent CLI answers in prose, never in tool calls`,
    ),
  };
}

/**
 * `workdir` is meaningful to an agentic hop and to nothing else, so a caller
 * who addressed a chain had no reason to send one and does not own its
 * absence: there it is this hop's own shape that cannot be satisfied, which
 * advances like any other, and a chain nothing can answer still exhausts to
 * its own 503. A caller who named this engine directly does own the
 * omission and gets `runAgentic`'s terminal 400 naming it, the mistake that
 * is actually theirs, before anything this engine cannot do for them.
 *
 * A field this engine cannot honour is settled first for a chain caller,
 * because `unhonourableRefusal` has already decided it either way -- 502
 * while a later hop can still honour it, terminal 400 when none can. Letting
 * the missing workdir advance ahead of that turns the terminal answer into an
 * exhausted 503 blaming the engine for the one mistake the caller can fix.
 */
async function preLaunchRefusal(
  ctx: DoorContext,
  engineId: string,
  req: AgenticHop["req"],
  workdir: string | undefined,
): Promise<HopResult | null> {
  const refusal = unhonourableRefusal(engineId, req);
  if (refusal !== null && req.inChain) {
    return refusal;
  }
  if (workdir === undefined || workdir === "") {
    return req.inChain
      ? {
          status: STATUS_BAD_GATEWAY,
          body: jsonErrorBody(`engine "${engineId}" is agentic and this call carried no workdir`),
        }
      : null;
  }
  if (refusal !== null) {
    return refusal;
  }
  return await proveAgenticPin(ctx, engineId);
}

async function execAgentic(
  ctx: DoorContext,
  { engineId, modelSeg, route, req }: AgenticHop,
): Promise<HopResult> {
  const config = ctx.getConfig();
  const entry = agenticEntry(ctx, engineId);
  if (!entry.ok) {
    return entry.result;
  }
  const { engineEntry, agentVersion } = entry;

  // Minted once per launch and revoked the instant this call returns --
  // the only door URL ever handed to this child, and it dies with the
  // process it was handed to. `runAgentic` (inside `launchAgentic`) is what
  // actually spawns; everything between here and the `finally` is still
  // before that, but the nonce is live for the whole window on the same
  // reasoning `resolveRedirect` never caches a secret: cheaper to mint one
  // that goes unused than to widen the window where a real launch could be
  // missing one.
  const nonce = mintLaunchNonce();
  ctx.launchNonces.add(nonce);
  // A streamed launch outlives this call, so its nonce is released when the
  // child exits rather than here.
  let handedOff = false;
  try {
    const doorUrl = `http://127.0.0.1:${config.listen_port}/openai/v1/${nonce}`;
    const redirect = await resolveRouteRedirect(ctx, { engineId, modelSeg, route, doorUrl });
    if (!redirect.ok) {
      return redirect.result;
    }
    // After the redirect, so a misrouted engine is refused for its route first.
    const spec = agenticSpecOf(ctx, engineEntry);
    if (!("agent" in spec)) {
      return spec;
    }
    const extraEnv = redirect.env ?? ambientAgentEnv(spec.agent, modelSeg, route);
    const workdir = typeof req.rawBody.workdir === "string" ? req.rawBody.workdir : undefined;
    const blocked = await preLaunchRefusal(ctx, engineId, req, workdir);
    if (blocked !== null) {
      return blocked;
    }
    return await launchAgentic(ctx, {
      spec,
      engineEntry,
      agentVersion,
      doorUrl,
      dialModel: route?.wire_model ?? modelSeg,
      workdir,
      extraEnv,
      req,
      onHandoff: (run) => {
        handedOff = true;
        run.finally(() => ctx.launchNonces.delete(nonce));
      },
    });
  } finally {
    if (!handedOff) {
      ctx.launchNonces.delete(nonce);
    }
  }
}

/**
 * OpenAI chunk framing for an answer the CLI is still producing: one
 * `chat.completion.chunk` per text delta, a terminal stop chunk, then
 * `[DONE]`. A CLI that fails after its first delta errors the stream, which
 * `chain.ts` records as that attempt's failure rather than a success.
 */
function agenticSse(
  run: Promise<RunAgenticResult>,
  deltas: string[],
  attach: (pump: () => void) => void,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  agenticCallSeq += 1;
  const id = `agentic-${Date.now()}-${agenticCallSeq}`;
  const chunk = (delta: Record<string, unknown>, finish: string | null): Uint8Array =>
    encoder.encode(
      `data: ${JSON.stringify({
        id,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`,
    );
  return new ReadableStream({
    start(controller) {
      const pump = (): void => {
        while (deltas.length > 0) {
          controller.enqueue(chunk({ role: "assistant", content: deltas.shift() }, null));
        }
      };
      attach(pump);
      pump();
      run.then(
        (outcome) => {
          pump();
          if (!outcome.ok) {
            controller.error(new Error(outcome.failure ?? "agentic call failed"));
            return;
          }
          controller.enqueue(chunk({}, "stop"));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
        (err: unknown) => controller.error(err),
      );
    },
  });
}

/**
 * The remote `openai-http` case: the same OpenAI body posted straight at a
 * configured address with the engine's secret in its one header. No router,
 * no occupancy and no `model_resident` — nothing is loaded here, so there is
 * no resident model to report, and inventing one would put a claim in the
 * provenance line that no read backs.
 *
 * `max_egress` is stripped alongside `workdir`: both are engined's own door
 * fields, and a provider that validates its request body strictly rejects
 * the whole call over one it has never heard of.
 */
async function execRemoteHttp(
  ctx: DoorContext,
  { engineEntry, modelSeg, route, req }: HttpHop,
): Promise<HopResult> {
  const config = ctx.getConfig();
  // The route's own upstream carries the address and secret; the engine
  // itself has none of its own.
  const upstream =
    route?.upstream === undefined || route.upstream === null
      ? undefined
      : config.upstreams.find((u) => u.id === route.upstream);
  if (upstream === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineEntry.id}" has no resolvable upstream`),
    };
  }
  const resolution = await resolveUpstream(upstream, ctx.doorOpts.secretExec);
  if (!resolution.ok) {
    return { status: resolution.status, body: jsonErrorBody(resolution.error) };
  }
  const modelId = resolveUpstreamModelId(config, engineEntry.id, modelSeg, upstream.id);
  if (modelId === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineEntry.id}" requires a model, and none was named`),
    };
  }
  // [engine.args] are engine-level wire defaults (reasoning_effort, and
  // whatever else this upstream takes) -- the caller's own body wins, the same
  // way a [model.args] key wins over [engine.args] one layer down.
  const callerBody = stripField(req.rawBody, "max_egress");
  const body = withoutCallerNulls({ ...engineEntry.args, ...callerBody }, callerBody);
  const init = openAiRequestInit(body, modelId, req.signal);
  const response = await fetch(
    upstreamUrl(resolution.endpoint.base_url, upstreamPath(req.pathname)),
    {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...resolution.endpoint.headers },
    },
  );
  const { stream, modelReported } = await readHopBody(response, req.setContentType);
  return { status: response.status, stream, modelReported };
}

function buildHopExec(ctx: DoorContext, req: HopRequest, launchScoped: boolean): HopExec {
  return async (hop, signal) => {
    const { engine: engineId, upstream: upstreamSeg, model: modelSeg } = parseHop(hop);
    const kind = ctx.registry.get(engineId)?.kind;
    // Which of the two openai-http proxies applies is the resolved route's
    // question, not the engine's: `upstream === "local"` is this box's own
    // llama-server, anything else is proxied elsewhere with no local router.
    // Also this hop's provenance `upstream_used` -- absent for an ambient
    // route, which named no upstream at all.
    const route = routeForHop(ctx.getConfig().routes, engineId, modelSeg, upstreamSeg);
    const upstreamUsed = route?.upstream ?? undefined;
    const result = await execHop(ctx, req, {
      engineId,
      modelSeg,
      kind,
      route,
      launchScoped,
      signal,
    });
    return { ...result, upstreamUsed };
  };
}

interface HopDispatch {
  engineId: string;
  modelSeg: string;
  kind: EngineKind | undefined;
  route: ResolvedRoute | undefined;
  launchScoped: boolean;
  signal: AbortSignal;
}

async function execHop(ctx: DoorContext, req: HopRequest, d: HopDispatch): Promise<HopResult> {
  const { engineId, modelSeg, kind, route, launchScoped, signal } = d;
  // Keyed on the RESOLVED engine, never the caller's literal model string:
  // a one-segment address that resolves to an agentic route is the same
  // attack as naming that engine outright, and refusing only the literal
  // spelling would miss it. `envelopeFailure: true` is what keeps this a
  // clean terminal refusal rather than advancing: 403 is otherwise one of
  // the credential-shaped statuses `classifyResult` advances past, and this
  // is a proven refusal, not a transport hiccup a next hop might route
  // around.
  if (launchScoped && kind === "agentic-cli") {
    return {
      status: STATUS_FORBIDDEN,
      envelopeFailure: true,
      body: jsonErrorBody(
        `engine "${engineId}" is agentic and cannot be reached from a launch-scoped door`,
      ),
    };
  }
  if (kind === "agentic-cli") {
    return await execAgentic(ctx, {
      engineId,
      modelSeg,
      route,
      req: {
        rawBody: req.rawBody,
        signal,
        setContentType: req.setContentType,
        toolsHonourableElsewhere: req.toolsHonourableElsewhere,
        inChain: req.inChain,
      },
    });
  }
  const engineEntry = ctx.registry.entry(engineId);
  if (kind === "openai-http" && engineEntry && route !== undefined && route.upstream !== "local") {
    return await execRemoteHttp(ctx, { engineEntry, modelSeg, route, req: { ...req, signal } });
  }
  if (kind === "openai-http" && engineEntry) {
    return await execLlama(ctx, { engineEntry, modelSeg, route, req: { ...req, signal } });
  }
  return {
    status: STATUS_BAD_GATEWAY,
    body: jsonErrorBody(`engine "${engineId}" of kind "${kind}" cannot serve this request`),
  };
}

/**
 * The budget for one hop, keyed on THAT hop's own engine kind -- never on
 * whether the request happens to be a chain, and never on any other hop
 * sharing it. Both budgets are single top-level values, applied per attempt
 * according to the kind answering it; an all-llama chain must not
 * inherit the long agentic budget just because a chain is, in general,
 * allowed to contain agentic hops.
 */
export function timeoutSecondsForKind(kind: EngineKind | undefined, config: Config): number {
  return kind === "agentic-cli" ? config.agent_timeout_seconds : config.chat_timeout_seconds;
}

function chatTimeoutMs(ctx: DoorContext): (hop: string) => number {
  const config = ctx.getConfig();
  return (hop) => {
    const { engine: engineId } = parseHop(hop);
    return timeoutSecondsForKind(ctx.registry.get(engineId)?.kind, config) * MS_PER_SECOND;
  };
}

interface ContentRequest {
  pathname: string;
  rawModel: string;
  body: Record<string, unknown>;
  /** The client's signal, carried this far so an abandoned chat stops the chain instead of running every hop to its full budget. */
  signal: AbortSignal;
  /** This request arrived on a launch-scoped `/openai/v1/<nonce>/...` URL. */
  launchScoped: boolean;
}

/** `undefined` when the caller left it out (no ceiling); a legal `Egress` string when it named one. A value that is neither is the caller's own mistake, not a silent no-ceiling. */
function parseMaxEgress(raw: unknown): { ok: true; value: Egress | undefined } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, value: undefined };
  }
  return isEgress(raw) ? { ok: true, value: raw } : { ok: false };
}

/** Chat and embeddings: `chain`, `model` and `engine` dispatches all become one or more `@/engine/model` hops through `runChain`, which is also where the one provenance line per call is emitted. */
async function handleChatOrEmbeddings(
  ctx: DoorContext,
  resolved: Extract<Dispatch, { ok: true }>,
  content: ContentRequest,
): Promise<Response> {
  const { pathname, rawModel, body, signal, launchScoped } = content;
  const maxEgress = parseMaxEgress(body.max_egress);
  if (!maxEgress.ok) {
    return jsonError(
      STATUS_BAD_REQUEST,
      `max_egress must be one of: ${Object.keys(EGRESS_RANK).join(", ")}`,
    );
  }
  const hops = resolved.kind === "chain" ? [...resolved.hops] : [routeAddress(resolved.route)];
  const chainName = resolved.kind === "chain" ? resolved.chain : null;

  let contentType: string = JSON_CONTENT_TYPE;
  const result = await runChain(hops, {
    chain: chainName,
    requested: rawModel,
    maxEgress: maxEgress.value,
    egressOf: (hop) => egressOf(ctx, hop),
    timeoutMs: chatTimeoutMs(ctx),
    signal,
    exec: buildHopExec(
      ctx,
      {
        pathname,
        rawBody: body,
        setContentType: (ct) => {
          contentType = ct;
        },
        toolsHonourableElsewhere: hops.some((hop) =>
          hopForwardsTools(hop, ctx.getConfig().routes, (id) => ctx.registry.get(id)),
        ),
        inChain: chainName !== null,
      },
      launchScoped,
    ),
    write: ctx.doorOpts.write,
  });

  if (result.stream) {
    return new Response(result.stream, {
      status: result.status,
      headers: { [CONTENT_TYPE]: contentType },
    });
  }
  return Response.json(result.body, { status: result.status });
}

/** Tokenize and apply-template are chat tools; asking the router for any other role would inject the wrong model. */
const EXTRAS_ROLE = "chat";

async function handleExtras(
  ctx: DoorContext,
  req: Request,
  engineId: string,
  verb: string,
): Promise<Response> {
  const engineEntry = ctx.registry.entry(engineId);
  if (!engineEntry) {
    return jsonError(STATUS_BAD_REQUEST, `unknown engine "${engineId}"`);
  }
  // Without this the router would happily start whisper and post a chat body into it.
  if (!ctx.registry.isLocalLlama(engineId)) {
    return jsonError(STATUS_BAD_REQUEST, `engine "${engineId}" does not serve ${verb}`);
  }
  const status = await ctx.registry.start(engineId);
  // `EngineStatus` carries no container address; the internal runtime read
  // is `lifecycle`'s own, the same source the comfy proxy resolves against.
  const privateUrl = ctx.lifecycle.getStatus(engineId).private_url;
  if (privateUrl === null) {
    return jsonError(STATUS_UNAVAILABLE, status.fix ?? `${engineId} is not available`);
  }
  const residentModel = getLlamaRouter(ctx, engineEntry).residentModel(EXTRAS_ROLE);
  return proxyExtras(
    req,
    { baseUrl: `http://${privateUrl}`, enginePath: `/${verb}` },
    residentModel,
    ctx.doorOpts.extrasHttpClient,
  );
}

async function handleContent(
  ctx: DoorContext,
  req: Request,
  pathname: string,
  launchScoped: boolean,
): Promise<Response> {
  if (pathname === CONTENT_ENDPOINT_TRANSCRIPTIONS) {
    return handleAudioTranscription(ctx, req);
  }
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  if (pathname === CONTENT_ENDPOINT_SPEECH) {
    // The signal is what stops a speech chain advancing to a second engine for
    // an answer the caller is no longer there to receive.
    return handleAudioSpeech(ctx, body, req.signal);
  }
  if (pathname === CONTENT_ENDPOINT_IMAGES) {
    // The signal ends a render nobody is waiting for: a diffusion job holds the
    // GPU, and this door runs one at a time.
    return handleImageGeneration(ctx, body, req.signal);
  }
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const resolved = resolveModel(rawModel, pathname, ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error);
  }
  return handleChatOrEmbeddings(ctx, resolved, {
    pathname,
    rawModel: rawModel ?? "",
    body,
    signal: req.signal,
    launchScoped,
  });
}

/**
 * The state stream. engined idle-stops engines on its own, so without this a
 * consumer only discovers an engine went away when a call against it fails --
 * and the alternative to being told is polling `GET /engined/v1/engines` forever.
 *
 * A snapshot goes out before the live frames, because a client that connects
 * between two transitions would otherwise sit blind until the next one and
 * have to poll once anyway to find out where it stands.
 */
function handleEngineEvents(ctx: DoorContext, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (event: string, data: unknown): void => {
        if (!open) {
          return;
        }
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          // The client went away between the abort check and the write.
          open = false;
        }
      };

      const unwatch = ctx.registry.watch((status) => {
        send("engine", status);
      });
      const keepalive = setInterval(() => {
        if (open) {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            open = false;
          }
        }
      }, SSE_KEEPALIVE_MS);

      const close = (): void => {
        open = false;
        clearInterval(keepalive);
        unwatch();
        try {
          controller.close();
        } catch {
          // Already closed by the client's disconnect.
        }
      };
      signal.addEventListener("abort", close, { once: true });

      ctx.registry
        .list()
        .then((listed) => {
          send("snapshot", listed);
        })
        .catch(() => {
          // A snapshot that cannot be built is not a reason to deny the
          // client the live frames it actually subscribed for.
        });
    },
  });

  return new Response(stream, {
    headers: {
      [CONTENT_TYPE]: SSE_CONTENT_TYPE,
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function routeGet(
  ctx: DoorContext,
  url: URL,
  configErr: string | undefined,
  signal: AbortSignal,
): Response | Promise<Response> | undefined {
  const { pathname } = url;
  if (pathname === "/openai/v1/models") {
    return modelsMenu(ctx);
  }
  if (pathname === "/engined/v1/engines") {
    return handleEngines(ctx, configErr);
  }
  if (pathname === "/engined/v1/engines/events") {
    return handleEngineEvents(ctx, signal);
  }
  const logsMatch = LOGS_RE.exec(pathname)?.[1];
  if (logsMatch !== undefined) {
    return handleLogs(ctx.registry, logsMatch, url);
  }
  const resourcesMatch = RESOURCES_RE.exec(pathname)?.[1];
  if (resourcesMatch !== undefined) {
    return handleResources(ctx.registry, resourcesMatch);
  }
}

function routePost(
  ctx: DoorContext,
  req: Request,
  pathname: string,
  launchScoped: boolean,
): Response | Promise<Response> | undefined {
  if (pathname === START_PATH) {
    return handleStart(ctx, req);
  }
  const stopMatch = STOP_RE.exec(pathname)?.[1];
  if (stopMatch !== undefined) {
    return handleStop(ctx.registry, stopMatch);
  }
  const releaseMatch = RELEASE_RE.exec(pathname)?.[1];
  if (releaseMatch !== undefined) {
    return handleRelease(ctx.registry, releaseMatch);
  }
  if (pathname === VOICE_UPLOAD_PATH) {
    return handleVoiceUpload(req);
  }
  if (CONTENT_ENDPOINTS.has(pathname)) {
    return handleContent(ctx, req, pathname, launchScoped);
  }
  const extras = EXTRAS_RE.exec(pathname);
  if (extras?.[1] !== undefined && extras[2] !== undefined) {
    return handleExtras(ctx, req, extras[1], extras[2]);
  }
}

/**
 * `null` means the path named a launch-scoped nonce that is not (or is no
 * longer) live -- expired with the child that minted it, or never minted at
 * all. Every OTHER path, launch-scoped or not, passes through with its
 * `/openai/v1/...` shape unchanged, which is what every downstream matcher
 * already expects.
 */
function stripLaunchNonce(
  ctx: DoorContext,
  pathname: string,
): { pathname: string; launchScoped: boolean } | null {
  const match = LAUNCH_NONCE_RE.exec(pathname);
  if (!match) {
    return { pathname, launchScoped: false };
  }
  const [, nonce, rest] = match;
  if (nonce === undefined || !ctx.launchNonces.has(nonce)) {
    return null;
  }
  return { pathname: `/openai/v1${rest}`, launchScoped: true };
}

function routeRequest(
  ctx: DoorContext,
  req: Request,
  configErr: string | undefined,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const stripped = stripLaunchNonce(ctx, url.pathname);
  if (stripped === null) {
    return refuse("this launch-scoped URL is unknown or has expired");
  }
  const { pathname, launchScoped } = stripped;
  const comfyMatch = matchComfyPath(pathname);
  if (comfyMatch) {
    return handleComfyProxy(ctx, req, comfyMatch);
  }
  let matched: Response | Promise<Response> | undefined;
  if (req.method === "GET") {
    matched = routeGet(ctx, new URL(pathname + url.search, url), configErr, req.signal);
  } else if (req.method === "POST") {
    matched = routePost(ctx, req, pathname, launchScoped);
  }
  return matched ?? jsonError(STATUS_NOT_FOUND, "not found");
}

/**
 * One LlamaRouter per llama-kind engine, sharing `lifecycle` with the
 * registry so idle-stop, port read-back and start-locking are never
 * tracked twice for the same container.
 *
 * The registry shares this door's own `launchNonces` for the same reason it
 * shares `lifecycle`: its round-trip probe launches an agent that calls back
 * here, and a nonce minted into a second set is one this door would refuse as
 * unknown.
 */
function createDoorContext(
  getConfig: () => Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions,
): DoorContext {
  const lifecycle =
    registryOpts.lifecycle ??
    new DockerLifecycle(registryOpts.exec ?? dockerExec, registryOpts.probe);
  const launchNonces = new Set<string>();
  const registry = new EngineRegistry(getConfig(), {
    ...registryOpts,
    lifecycle,
    launchNonces,
    presetHostPath: doorOpts.llamaPresetHostPath,
  });
  return {
    getConfig,
    registry,
    lifecycle,
    registryOpts,
    doorOpts,
    llamaRouters: new Map(),
    staleLlamaRouters: new Set(),
    launchNonces,
    comfyBindings: loadComfyBindings(),
    comfySlots: new Map(),
  };
}

export function createDoor(
  initialConfig: Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions = {},
): Door {
  let config = initialConfig;
  let configErr: string | undefined;
  const ctx = createDoorContext(() => config, registryOpts, doorOpts);
  const { registry } = ctx;

  function reload(path: string): void {
    try {
      const next = loadConfig(path);
      config = next;
      configErr = undefined;
      registry.reload(next);
      // Mark every cached router stale rather than dropping it: an
      // in-flight request already holds a direct reference to its old
      // instance regardless, but a NEW request must not get a second,
      // ignorant occupancy tracker over the same still-running container
      // while the old one still has a lease outstanding.
      for (const id of ctx.llamaRouters.keys()) {
        ctx.staleLlamaRouters.add(id);
      }
    } catch (err) {
      configErr = errMessage(err);
    }
  }

  // Two declared overloads plus a wider implementation signature: the
  // standard TS pattern for one function body that must expose a NARROWER
  // type to its one-argument callers (every test in this repo) than what it
  // is actually capable of returning when a real `server` is supplied.
  function fetch(req: Request): Response | Promise<Response>;
  function fetch(req: Request, server: EnginedServer): Response | Promise<Response> | undefined;
  function fetch(req: Request, server?: EnginedServer): Response | Promise<Response> | undefined {
    const refusal = checkOrigin(req, config.listen_port);
    if (refusal) {
      return refusal;
    }
    // A real websocket upgrade is intercepted here, ahead of ordinary
    // routing: `server` exists only when bound through a real `Bun.serve`
    // (see `bindDualFamily`), which is the one thing a plain request/response
    // handler cannot do on its own.
    if (server !== undefined) {
      const wsMatch = matchComfyPath(new URL(req.url).pathname);
      if (wsMatch?.rest === COMFY_WS_SUFFIX) {
        return handleComfyWsUpgrade(ctx, req, server, wsMatch);
      }
    }
    return routeRequest(ctx, req, configErr);
  }

  return { fetch, reload, registry, configError: () => configErr };
}

/**
 * The door's real listener setup: both loopback families bound to the same
 * port. Exported so a test can bind through this exact code rather than a
 * hand-rolled `Bun.serve` pair that would pass even if the `::1` listener
 * were deleted here.
 */
export function bindDualFamily(
  fetch: Door["fetch"],
  port: number,
): { v4: EnginedServer; v6: EnginedServer } {
  // `idleTimeout: 0` disables Bun's own socket timer, which defaults to 10s
  // and closes the connection with NO body -- indistinguishable from the
  // daemon being down, and reached by any cold start (a container plus a
  // 25 GB GGUF) or any answer slower than ten seconds. It cannot simply be
  // raised to match: Bun rejects an `idleTimeout` above 255, which is below
  // the default `chat_timeout_seconds` of 600. The request budget is
  // engined's own, per hop and per engine kind (`timeoutSecondsForKind`), so
  // a socket timer here could only ever cut that budget short.
  //
  // `websocket` mounts the one payload this door ever upgrades: a comfy
  // proxy connection, bridged to the real container in `comfyWebSocketHandlers`.
  const serveOpts = { fetch, idleTimeout: 0, websocket: comfyWebSocketHandlers } as const;
  const v4 = Bun.serve<ComfyWsData>({ hostname: "127.0.0.1", port, ...serveOpts });
  const v6 = Bun.serve<ComfyWsData>({ hostname: "::1", port: v4.port, ...serveOpts });
  return { v4, v6 };
}

/**
 * `ENGINED_BUNX` is what the `--user` unit always sets (`scripts/engined.service.in`)
 * so `{bunx}` in a spec.toml command, and every agentic launch, resolve to an
 * absolute path rather than a bare `bunx` a sandboxed unit's PATH may not
 * carry at all. Resolving here, at startup, is what makes a lost env var
 * fail loudly and immediately rather than late, at exec inside a spawned
 * child.
 *
 * The legitimate case this must not break is a plain working-tree dev run
 * with no unit and no `ENGINED_BUNX` at all: resolving off PATH (real,
 * right now, at startup) rather than assuming a bare `"bunx"` will resolve
 * later is what covers it, since a developer's shell always has one. Only a
 * box with genuinely neither the env var nor `bunx` on PATH is fatal.
 */
export function resolveBunx(
  env: NodeJS.ProcessEnv = process.env,
  which: (cmd: string) => string | null = Bun.which,
): string {
  const configured = env.ENGINED_BUNX;
  if (configured !== undefined && configured !== "") {
    return configured;
  }
  const onPath = which("bunx");
  if (onPath !== null) {
    return onPath;
  }
  throw new FatalError(
    'ENGINED_BUNX is not set and no "bunx" was found on PATH -- the --user unit always sets ENGINED_BUNX (scripts/engined.service.in); a working-tree dev run needs bunx on PATH instead',
  );
}

/**
 * `main.js --vision-probe`: a one-shot run of the vision-fidelity probe
 * against the door this install is already serving, which is why it never
 * builds a `Door` of its own -- it is an ordinary caller on loopback, and the
 * container it needs starts on demand the same way any other request starts
 * one. The port comes from the config the daemon itself read, so the probe
 * writes down no port the invariant does not already allow.
 *
 * Shipped as a mode of the daemon bundle rather than a second script because
 * `install.sh` already syncs that bundle: a separate artifact would be one
 * more thing to keep in step with the install, for a check that is one
 * request long.
 */
async function visionProbeExit(): Promise<number> {
  let port: number;
  try {
    port = loadConfig().listen_port;
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return FatalError.EXIT_CODE;
  }
  const report = await runVisionProbe(`http://127.0.0.1:${port}`);
  for (const line of report.lines) {
    process.stdout.write(`${line.ok ? "ok" : "FAIL"} ${line.address}: ${line.detail}\n`);
  }
  return report.ok ? 0 : 1;
}
if (import.meta.main) {
  // Before anything that binds or starts: this mode talks to the door that is
  // already running, so creating one here would take the port from it.
  if (process.argv.includes("--vision-probe")) {
    process.exit(await visionProbeExit());
  }
  let startupConfig: Config;
  let door: Door;
  // `createDoor` loads every engine spec eagerly, so a `ParseError` from an
  // unresolved placeholder lands here and not at the first request. It shares
  // the config path's exit code because a restart fixes neither, and escaping
  // this block uncaught would exit 1 and put the unit in a restart loop.
  // `resolveBunx` throwing lands here too, for the same reason.
  try {
    const bunx = resolveBunx();
    startupConfig = loadConfig();
    // The mount source a chatterbox spec names must exist before any
    // container starts: docker creates a missing bind source itself, owned by
    // root, and the door would then never be able to write an upload into it.
    mkdirSync(voicesDir(), { recursive: true });
    door = createDoor(startupConfig, {
      enginesRoot: `${installDir()}/engines`,
      bunx,
      // Only production wiring: a real probe run is a real billed call to
      // Anthropic for claude, and a real spawn (free -- this box's own GPU)
      // for opencode. `agenticStatus`'s version-proof gate is what keeps
      // this from firing per request or per status poll -- it only ever
      // invokes the runner when the configured pin differs from the one
      // last proved.
      agenticProbeRunner: buildAgenticProbeRunner(bunx),
    });
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  let bound: { v4: EnginedServer; v6: EnginedServer };
  try {
    bound = bindDualFamily(door.fetch, startupConfig.listen_port);
  } catch (err) {
    const message = errMessage(err);
    process.stderr.write(`port ${startupConfig.listen_port} already in use: ${message}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  process.on("SIGHUP", () => door.reload(configPath()));

  process.on("SIGTERM", () => {
    door.registry
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        bound.v4.stop();
        bound.v6.stop();
        process.exit(0);
      });
  });
}
