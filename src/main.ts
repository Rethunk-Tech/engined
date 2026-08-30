/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import process from "node:process";
import {
  type AgenticSpawn,
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  runAgentic,
} from "./agentic.ts";
import {
  type DoorResponse,
  type EngineStart,
  handleSpeech,
  handleTranscription,
  type SpeechRequestBody,
  type TranscriptionRequestBody,
} from "./audio.ts";
import {
  classifyResult,
  type HopExec,
  type HopResult,
  parseHop,
  runChain,
  wrapStream,
} from "./chain.ts";
import { loadConfig } from "./config.ts";
import { type Dispatch, resolveEngineSegment, resolveModel } from "./dispatch.ts";
import { DockerLifecycle, dockerExec } from "./docker.ts";
import {
  DEFAULT_IDLE_STOP_SECONDS,
  DEFAULT_READY_TIMEOUT_S,
  EngineRegistry,
  type RegistryOptions,
} from "./engines.ts";
import type { Exec as SecretExec } from "./exec.ts";
import { proxyExtras } from "./extras.ts";
import {
  CONTENT_TYPE,
  type HttpClient,
  JSON_CONTENT_TYPE,
  jsonError,
  jsonErrorBody,
  SSE_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_FORBIDDEN,
  STATUS_NOT_FOUND,
  STATUS_PAYLOAD_TOO_LARGE,
  STATUS_UNAVAILABLE,
  TEXT_CONTENT_TYPE,
} from "./http.ts";
import { LlamaRouter, reportedModelFrom } from "./llama.ts";
import { configPath, installDir } from "./paths.ts";
import { recordCall } from "./provenance.ts";
import {
  isRemote,
  noBaseUrlFix,
  remoteUrl,
  resolveRemote,
  resolveRemoteSecret,
  upstreamPath,
} from "./remote.ts";
import { loadSpec } from "./spec.ts";
import {
  type Config,
  type EngineEntry,
  type EngineKind,
  errMessage,
  FatalError,
  findModelOnEngine,
  isContainerSpec,
  isRecord,
  MS_PER_SECOND,
} from "./types.ts";

const CONTENT_ENDPOINTS = new Set([
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
]);

const START_RE = /^\/v1\/engines\/([^/]+)\/start$/;
const STOP_RE = /^\/v1\/engines\/([^/]+)\/stop$/;
const LOGS_RE = /^\/v1\/engines\/([^/]+)\/logs$/;
const RESOURCES_RE = /^\/v1\/engines\/([^/]+)\/resources$/;
const RELEASE_RE = /^\/v1\/engines\/([^/]+)\/release$/;
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
 * Warms the container, and — when the body names a model — that GGUF too, so
 * the first real request does not pay the cold load. An absent or empty body
 * is the original container-only behaviour, which every existing caller sends.
 *
 * The warm is a head start, not a pin: the lease is released immediately and
 * idle-stop is armed as usual. `keep_resident` in config is what survives.
 */
async function handleStart(ctx: DoorContext, id: string, req: Request): Promise<Response> {
  let modelSeg: string | undefined;
  try {
    const raw = (await req.json()) as unknown;
    if (isRecord(raw) && typeof raw.model === "string") {
      modelSeg = raw.model;
    }
  } catch {
    // No body, or not JSON: warming the container alone is the whole request.
  }
  let started: Awaited<ReturnType<EngineRegistry["start"]>>;
  try {
    started = await ctx.registry.start(id);
  } catch (err) {
    return jsonError(STATUS_NOT_FOUND, errMessage(err));
  }
  if (modelSeg === undefined) {
    return Response.json(started);
  }
  const engineEntry = ctx.registry.entry(id);
  const model =
    engineEntry === undefined ? undefined : findModelOnEngine(ctx.getConfig().models, id, modelSeg);
  if (engineEntry === undefined || model === undefined) {
    return jsonError(STATUS_BAD_GATEWAY, `model "${modelSeg}" not found on "${id}"`);
  }
  try {
    await getLlamaRouter(ctx, engineEntry).warm(model);
  } catch (err) {
    return jsonError(STATUS_BAD_GATEWAY, errMessage(err));
  }
  return Response.json(started);
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
const EXTRAS_EXACT = new Set([
  "/tokenize",
  "/detokenize",
  "/apply-template",
  "/slots",
  "/models/load",
  "/models/unload",
]);
const SLOTS_ID_RE = /^\/slots\/[^/]+$/;

function isExtrasPath(pathname: string): boolean {
  return EXTRAS_EXACT.has(pathname) || SLOTS_ID_RE.test(pathname);
}

/** A modelless engine (agentic bare selector) becomes a hop with no model segment at all. A chain never arrives here: it carries its own hops. */
function hopFromDispatch(
  dispatch: Exclude<Extract<Dispatch, { ok: true }>, { kind: "chain" }>,
): string {
  return dispatch.kind === "model"
    ? `@/${dispatch.engine}/${dispatch.model}`
    : `@/${dispatch.engine}`;
}

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
 * stripped as before; every other caller-supplied field passes through.
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

export interface DoorOptions {
  agenticSpawn?: AgenticSpawn;
  llamaHttpClient?: HttpClient;
  extrasHttpClient?: HttpClient;
  /** Injected so a test can capture the provenance line instead of reading real stdout. */
  write?: (line: string) => void;
  /** Reaches both the registry that writes the preset and the router that mounts it; a test overrides it so neither touches the real state dir. */
  llamaPresetHostPath?: string;
  /** Defaults to the real `secret-tool`; a test overrides it so a remote-agentic engine's keyring lookup never runs for real. */
  secretExec?: SecretExec;
  /** Defaults to the real `process.env`; a test overrides it so a planted ambient secret has somewhere deterministic to not leak from. */
  agenticAmbientEnv?: NodeJS.ProcessEnv;
}

export interface Door {
  fetch: (req: Request) => Response | Promise<Response>;
  /** Re-reads `path`. Invalid TOML keeps the running config and records the error. */
  reload: (path: string) => void;
  registry: EngineRegistry;
  configError: () => string | undefined;
}

/**
 * Everything a content handler needs, bundled so each handler stays a
 * top-level function instead of a deep closure. `getConfig` rather than a
 * captured `Config` because `reload` swaps it out from under an in-flight
 * request's later lookups.
 */
interface DoorContext {
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
}

function getLlamaRouter(ctx: DoorContext, engine: EngineEntry): LlamaRouter {
  const cached = ctx.llamaRouters.get(engine.id);
  if (cached && (!ctx.staleLlamaRouters.has(engine.id) || cached.hasOutstandingLeases())) {
    return cached;
  }
  ctx.staleLlamaRouters.delete(engine.id);
  const models = ctx.getConfig().models.filter((m) => m.engine === engine.id);
  const router = new LlamaRouter(engine, models, ctx.lifecycle, {
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
 * `EngineRegistry.get()` answers a different question — an `EngineStatus`
 * (whether it's running, its private_url) — never the configured
 * `EngineEntry` a caller here wants (secret, base_url, args), which is what
 * `EngineRegistry.entry` hands back. Local to this door because resolving the
 * segment to an id first is the door's own addressing rule, not the
 * registry's.
 */
function egressOf(ctx: DoorContext, seg: string): "none" | "remote" {
  const config = ctx.getConfig();
  const id = resolveEngineSegment(seg, config) ?? seg;
  return ctx.registry.entry(id)?.egress ?? "remote";
}

interface HopRequest {
  pathname: string;
  rawBody: Record<string, unknown>;
  setContentType: (ct: string) => void;
}

/**
 * The `openai-http` case: proxy through this engine's `LlamaRouter`, `workdir`
 * stripped. `req.signal` is `runOneHop`'s own per-hop timeout/caller-abort --
 * forwarded into `RequestInit` so a slow upstream is actually cut off at the
 * budget `chatTimeoutMs` picked, not just marked aborted after the fact.
 */
async function execLlama(
  ctx: DoorContext,
  engineEntry: EngineEntry,
  modelSeg: string,
  req: HopRequest & { signal: AbortSignal },
): Promise<HopResult> {
  const model = findModelOnEngine(ctx.getConfig().models, engineEntry.id, modelSeg);
  if (!model) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`model "${modelSeg}" not found on "${engineEntry.id}"`),
    };
  }
  const router = getLlamaRouter(ctx, engineEntry);
  // Both fetchBuffered and fetchStreamed take this same `init`, so
  // rewriting `model` once here fixes both proxy paths.
  const init = openAiRequestInit(req.rawBody, model.id, req.signal);
  // `modelResident` comes back with the hop, read under the same lease: from
  // the engine's own /v1/models — never the router's cached command
  // bookkeeping, and never model_reported: the two answer different questions
  // and one silently standing in for the other defeats provenance.
  const { response, modelResident } = await router.proxy(model, req.pathname, init);
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
 * A remote-address agentic engine has no spec directory of its own by
 * design (wave-1 rule: "a remote address launches nothing"). It launches
 * the identical shipped claude spec — same floor, same env allowlist —
 * per the operator ruling: Moonshot is "the same agentic kind as claude
 * with a different upstream and key, not a second protocol."
 */
const SHIPPED_CLAUDE_ID = "claude";

function loadAgenticSpec(ctx: DoorContext, engineEntry: EngineEntry) {
  const id = isRemote(engineEntry) ? SHIPPED_CLAUDE_ID : engineEntry.id;
  // spec_dir is not touched: config.ts's checkRemoteAddress already forbids
  // it wherever base_url is set, so it is undefined there by construction —
  // forcing it would only ever discard a *local* agentic engine's own
  // legitimate spec_dir override, which is a real per-engine feature and
  // not specific to the redirect case at all.
  return loadSpec(
    { ...engineEntry, id },
    { enginesRoot: ctx.registryOpts.enginesRoot, bunx: ctx.registryOpts.bunx },
  );
}

/**
 * `x-api-key` (`ANTHROPIC_API_KEY`) is Kimi's own coding endpoint's required
 * auth header; `ANTHROPIC_AUTH_TOKEN` 401s against it, so this is the
 * mechanism `secret.header` names, not a free choice. Keys minted for this
 * endpoint are further scoped to api.kimi.com/coding/ and are rejected
 * against the general api.moonshot.ai platform — a different service.
 *
 * Every model tier is pointed at the same `model`, so nothing silently
 * falls back to an Anthropic-named tier this endpoint does not serve. The
 * telemetry/agent-feature vars are cheap to carry and keep a read-only
 * completion from spawning machinery nobody asked for against a billing
 * account this call was never going to use.
 */
function redirectEnv(
  baseUrl: string,
  apiKey: string,
  model: string | undefined,
): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: apiKey,
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
  return {
    ...env,
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
  };
}

/**
 * The configured id verbatim — never invented, never stripped — resolved
 * through aliases the same way a chat model is. Shared by the agentic
 * redirect and the remote HTTP proxy: both hand a `[[model]]` id straight to
 * someone else's service, where a prettier local alias would simply 404.
 */
function resolveUpstreamModelId(
  config: Config,
  engineId: string,
  modelSeg: string,
): string | undefined {
  if (modelSeg === "") {
    return;
  }
  return findModelOnEngine(config.models, engineId, modelSeg)?.id ?? modelSeg;
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
 *
 * `engineEntry.id` doubles as the engine id everywhere here (`config.engines`
 * is keyed on it), so this needs no separate `ctx` — a `DoorContext` would
 * only ever contribute `secretExec`, and taking it directly makes this
 * testable without constructing one.
 */
export async function resolveRedirect(
  engineEntry: EngineEntry,
  modelSeg: string,
  config: Config,
  secretExec?: SecretExec,
): Promise<RedirectResolution> {
  const { base_url } = engineEntry;
  if (base_url === undefined) {
    // Config requires a secret alongside a base_url but not the converse, so
    // an address-less remote reaches here and must refuse rather than hand
    // the child an undefined upstream.
    return {
      ok: false,
      result: { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(noBaseUrlFix(engineEntry.id)) },
    };
  }
  const resolved = await resolveRemoteSecret(engineEntry, secretExec);
  if (!resolved.ok) {
    return { ok: false, result: { status: resolved.status, body: jsonErrorBody(resolved.error) } };
  }
  const model = resolveUpstreamModelId(config, engineEntry.id, modelSeg);
  return { ok: true, env: redirectEnv(base_url, resolved.value, model) };
}

/** `runAgentic`'s outcome, mapped to a hop's result. `version` is carried through either way -- a failed launch still ran a real, pinned process. */
function hopResultFromAgenticOutcome(outcome: Awaited<ReturnType<typeof runAgentic>>): HopResult {
  if (!outcome.ok) {
    return {
      status: outcome.status,
      body: jsonErrorBody(outcome.failure ?? "agentic call failed"),
      envelopeFailure: outcome.envelopeFailure,
      version: outcome.version,
    };
  }
  return {
    status: outcome.status,
    body: agenticEnvelope(outcome.result),
    version: outcome.version,
  };
}

/** The `agentic-cli` case. `runAgentic` itself enforces the workdir-required-400 rule. */
/**
 * The pin proof, and only once a workdir is in hand: the workdir-required 400
 * is a request-shape rejection the caller owns, and it fires before an
 * engine-availability check the server owns. `null` means nothing is wrong.
 */
async function proveAgenticPin(
  ctx: DoorContext,
  engineId: string,
  workdir: string | undefined,
): Promise<HopResult | null> {
  if (workdir === undefined || workdir === "") {
    return null;
  }
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
  };
}

async function execAgentic(
  ctx: DoorContext,
  engineId: string,
  modelSeg: string,
  req: { rawBody: Record<string, unknown>; signal: AbortSignal },
): Promise<HopResult> {
  const { rawBody, signal } = req;
  const config = ctx.getConfig();
  const engineEntry = ctx.registry.entry(engineId);
  if (!engineEntry) {
    return { status: STATUS_BAD_GATEWAY, body: jsonErrorBody(`unknown engine "${engineId}"`) };
  }
  if (engineEntry.agent_version === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineId}" has no agent_version configured`),
    };
  }

  let extraEnv: Record<string, string> | undefined;
  if (isRemote(engineEntry)) {
    const redirect = await resolveRedirect(engineEntry, modelSeg, config, ctx.doorOpts.secretExec);
    if (!redirect.ok) {
      return redirect.result;
    }
    extraEnv = redirect.env;
  }

  const loaded = loadAgenticSpec(ctx, engineEntry);
  if (isContainerSpec(loaded.spec)) {
    // Only reachable if an engine routed here carries a container spec, which
    // the kind check upstream already rules out -- but `agent` is what decides
    // the floor, so it is never read off a spec that has not proven it has one.
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineId}" is not an agentic-cli spec`),
    };
  }
  const workdir = typeof rawBody.workdir === "string" ? rawBody.workdir : undefined;
  const unproved = await proveAgenticPin(ctx, engineId, workdir);
  if (unproved !== null) {
    return unproved;
  }
  const outcome = await runAgentic({
    agent: loaded.spec.agent,
    agentVersion: engineEntry.agent_version,
    // An agent CLI reaches its model back through engined's own door, so an
    // opencode turn is dispatched, chained and accounted for like any other.
    upstream:
      engineEntry.agent_model === undefined
        ? undefined
        : {
            baseUrl: `http://127.0.0.1:${config.listen_port}/v1`,
            model: engineEntry.agent_model,
          },
    args: engineEntry.args,
    envAllowlist: loaded.spec.env,
    workdir,
    prompt: promptFromMessages(rawBody),
    spawn: ctx.doorOpts.agenticSpawn ?? defaultAgenticSpawn,
    bunx: ctx.registryOpts.bunx,
    ambientEnv: ctx.doorOpts.agenticAmbientEnv,
    extraEnv,
    signal,
  });
  return hopResultFromAgenticOutcome(outcome);
}

/**
 * The remote `openai-http` case: the same OpenAI body posted straight at a
 * configured address with the engine's secret in its one header. No router,
 * no occupancy and no `model_resident` — nothing is loaded here, so there is
 * no resident model to report, and inventing one would put a claim in the
 * provenance line that no read backs.
 *
 * `local_only` is stripped alongside `workdir`: both are engined's own door
 * fields, and a provider that validates its request body strictly rejects
 * the whole call over one it has never heard of.
 */
async function execRemoteHttp(
  ctx: DoorContext,
  engineEntry: EngineEntry,
  modelSeg: string,
  req: HopRequest & { signal: AbortSignal },
): Promise<HopResult> {
  const resolution = await resolveRemote(engineEntry, ctx.doorOpts.secretExec);
  if (!resolution.ok) {
    return { status: resolution.status, body: jsonErrorBody(resolution.error) };
  }
  const modelId = resolveUpstreamModelId(ctx.getConfig(), engineEntry.id, modelSeg);
  if (modelId === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineEntry.id}" requires a model, and none was named`),
    };
  }
  // [engine.args] are engine-level wire defaults (reasoning_effort, and
  // whatever else this upstream takes) -- the caller's own body wins, the same
  // way a [model.args] key wins over [engine.args] one layer down.
  const callerBody = stripField(req.rawBody, "local_only");
  const body = withoutCallerNulls({ ...resolution.endpoint.args, ...callerBody }, callerBody);
  const init = openAiRequestInit(body, modelId, req.signal);
  const response = await fetch(
    remoteUrl(resolution.endpoint.base_url, upstreamPath(req.pathname)),
    {
      ...init,
      headers: { ...(init.headers as Record<string, string>), ...resolution.endpoint.headers },
    },
  );
  const { stream, modelReported } = await readHopBody(response, req.setContentType);
  return { status: response.status, stream, modelReported };
}

function buildHopExec(ctx: DoorContext, req: HopRequest): HopExec {
  return async (hop, signal) => {
    const { engine: seg, model: modelSeg } = parseHop(hop);
    const engineId = resolveEngineSegment(seg, ctx.getConfig()) ?? seg;
    const kind = ctx.registry.get(engineId)?.kind;
    if (kind === "agentic-cli") {
      return await execAgentic(ctx, engineId, modelSeg, { rawBody: req.rawBody, signal });
    }
    const engineEntry = ctx.registry.entry(engineId);
    if (kind === "openai-http" && engineEntry && isRemote(engineEntry)) {
      return await execRemoteHttp(ctx, engineEntry, modelSeg, { ...req, signal });
    }
    if (kind === "openai-http" && engineEntry) {
      return await execLlama(ctx, engineEntry, modelSeg, { ...req, signal });
    }
    return {
      status: STATUS_BAD_GATEWAY,
      body: jsonErrorBody(`engine "${engineId}" of kind "${kind}" cannot serve this request`),
    };
  };
}

/**
 * The budget for one hop, keyed on THAT hop's own engine kind -- never on
 * whether the request happens to be a chain, and never on any other hop
 * sharing it. Both budgets are single top-level values, applied per attempt
 * according to the kind answering it; an all-local-llama chain must not
 * inherit the long agentic budget just because a chain is, in general,
 * allowed to contain agentic hops.
 */
export function timeoutSecondsForKind(kind: EngineKind | undefined, config: Config): number {
  return kind === "agentic-cli" ? config.agent_timeout_seconds : config.chat_timeout_seconds;
}

function chatTimeoutMs(ctx: DoorContext): (hop: string) => number {
  const config = ctx.getConfig();
  return (hop) => {
    const { engine: seg } = parseHop(hop);
    const engineId = resolveEngineSegment(seg, config) ?? seg;
    return timeoutSecondsForKind(ctx.registry.get(engineId)?.kind, config) * MS_PER_SECOND;
  };
}

interface ContentRequest {
  pathname: string;
  rawModel: string;
  body: Record<string, unknown>;
  /** The client's signal, carried this far so an abandoned chat stops the chain instead of running every hop to its full budget. */
  signal: AbortSignal;
}

/** Chat and embeddings: `chain`, `model` and `engine` dispatches all become one or more `@/engine/model` hops through `runChain`, which is also where the one provenance line per call is emitted. */
async function handleChatOrEmbeddings(
  ctx: DoorContext,
  resolved: Extract<Dispatch, { ok: true }>,
  content: ContentRequest,
): Promise<Response> {
  const { pathname, rawModel, body, signal } = content;
  const hops = resolved.kind === "chain" ? [...resolved.hops] : [hopFromDispatch(resolved)];
  const chainName = resolved.kind === "chain" ? resolved.chain : null;

  let contentType: string = JSON_CONTENT_TYPE;
  const result = await runChain(hops, {
    chain: chainName,
    requested: rawModel,
    localOnly: body.local_only === true,
    egressOf: (seg) => egressOf(ctx, seg),
    resolveEngine: (seg) => resolveEngineSegment(seg, ctx.getConfig()) ?? seg,
    timeoutMs: chatTimeoutMs(ctx),
    signal,
    exec: buildHopExec(ctx, {
      pathname,
      rawBody: body,
      setContentType: (ct) => {
        contentType = ct;
      },
    }),
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

interface AudioCallInfo {
  engineId: string;
  requested: string;
  result: DoorResponse;
  startedAt: number;
}

/**
 * Audio provenance is classified by the same rule a chain hop is: one place
 * decides ok-vs-failure, so a failed audio call records WHY it failed and a
 * 200 carrying no audio is not recorded as a success. A streamed call holds
 * no buffered `bytes`, so its line waits for the stream and reports the bytes
 * it actually forwarded -- a stream that ended having delivered audio is a
 * success, and one that died mid-body is not.
 */
function recordAudioCall(ctx: DoorContext, info: AudioCallInfo): DoorResponse {
  const { engineId, requested, result, startedAt } = info;
  const emit = (audioBytes: number, streamFailure?: string): void => {
    const verdict = classifyResult({
      status: result.status,
      body: audioBytes > 0 ? "audio" : result.body,
    });
    const ok = verdict.ok && streamFailure === undefined;
    const failure = streamFailure ?? verdict.failure;
    recordCall(
      {
        chain: null,
        requested,
        attempts: [
          {
            engine: engineId,
            model: engineId,
            ok,
            ...(failure === undefined ? {} : { failure }),
            duration_ms: Date.now() - startedAt,
          },
        ],
        engine_used: ok ? engineId : null,
      },
      ctx.doorOpts.write,
    );
  };
  if (!result.stream) {
    emit(result.bytes?.byteLength ?? 0);
    return result;
  }
  return {
    ...result,
    stream: wrapStream(result.stream, (ok, streamFailure, bytes) =>
      emit(bytes ?? 0, ok ? undefined : (streamFailure ?? "stream ended before completion")),
    ),
  };
}

function doorResponseToResponse(result: DoorResponse): Response {
  if (result.stream) {
    return new Response(result.stream, {
      status: result.status,
      headers: { [CONTENT_TYPE]: result.contentType },
    });
  }
  if (result.bytes) {
    // `Buffer.from` rather than the raw `Uint8Array`: DoorResponse.bytes is
    // typed as the generic `ArrayBufferLike` view, which Bun's `BodyInit`
    // does not accept directly.
    return new Response(Buffer.from(result.bytes), {
      status: result.status,
      headers: { [CONTENT_TYPE]: result.contentType },
    });
  }
  if (result.contentType === TEXT_CONTENT_TYPE) {
    return new Response(String(result.body), {
      status: result.status,
      headers: { [CONTENT_TYPE]: result.contentType },
    });
  }
  return Response.json(result.body, { status: result.status });
}

/**
 * The audio door proxies a single buffered request per call, with no
 * multi-lease concept like `LlamaRouter`'s roles: unlike Comfy, this is
 * request traffic engined does see, so idle-stop arms right here rather than
 * off a queue poll. A no-op if the start attempt never reached "running".
 */
function armAudioIdleStop(ctx: DoorContext, engineId: string): void {
  const engine = ctx.registry.entry(engineId);
  ctx.lifecycle.endLease(engineId, engine?.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
}

/**
 * Both audio endpoints take an engine, never a chain and never a model: the
 * door has no model concept here. Resolution and that refusal are one step.
 */
function resolveAudioEngine(
  ctx: DoorContext,
  rawModel: string | undefined,
  endpoint: string,
): { ok: true; engineId: string } | { ok: false; response: Response } {
  const resolved = resolveModel(rawModel, endpoint, ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return { ok: false, response: jsonError(STATUS_BAD_REQUEST, resolved.error) };
  }
  if (resolved.kind === "chain") {
    return {
      ok: false,
      response: jsonError(STATUS_BAD_REQUEST, "audio endpoints do not take a chain"),
    };
  }
  return { ok: true, engineId: resolved.engine };
}

/**
 * The audio door's `EngineStart`. A remote engine is resolved to an address
 * and a header instead of started — there is no container to warm — and a
 * secret that will not resolve surfaces as a null `private_url` with no
 * `remote`, which the door reports as unavailable exactly like a container
 * that failed to come up.
 */
function audioStart(ctx: DoorContext): EngineStart {
  return async (id: string) => {
    const engine = ctx.registry.entry(id);
    if (engine && isRemote(engine)) {
      const resolution = await resolveRemote(engine, ctx.doorOpts.secretExec);
      return resolution.ok
        ? { private_url: null, remote: resolution.endpoint }
        : { private_url: null, unavailable: resolution.error };
    }
    const status = await ctx.registry.start(id);
    // Paired with the `armAudioIdleStop` every audio path runs on the way out.
    ctx.lifecycle.beginLease(id);
    return { private_url: status.private_url };
  };
}

async function handleAudioSpeech(
  ctx: DoorContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const audio = resolveAudioEngine(ctx, rawModel, "/v1/audio/speech");
  if (!audio.ok) {
    return audio.response;
  }
  const { engineId } = audio;
  const start = audioStart(ctx);
  const speechReq: SpeechRequestBody = {
    model: engineId,
    input: typeof body.input === "string" ? body.input : "",
    response_format: typeof body.response_format === "string" ? body.response_format : undefined,
    stream: body.stream === true,
  };
  const startedAt = Date.now();
  const result = await handleSpeech(speechReq, start);
  armAudioIdleStop(ctx, engineId);
  return doorResponseToResponse(
    recordAudioCall(ctx, { engineId, requested: rawModel ?? "", result, startedAt }),
  );
}

interface TranscriptionForm {
  rawModel: string | null;
  file: Uint8Array<ArrayBuffer>;
  language: string | undefined;
  responseFormat: string | undefined;
}

async function parseTranscriptionForm(req: Request): Promise<TranscriptionForm> {
  const form = await req.formData();
  const rawModel = form.get("model");
  const file = form.get("file");
  const language = form.get("language");
  const responseFormat = form.get("response_format");
  return {
    rawModel: typeof rawModel === "string" ? rawModel : null,
    file: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0),
    language: typeof language === "string" ? language : undefined,
    responseFormat: typeof responseFormat === "string" ? responseFormat : undefined,
  };
}

/**
 * An upload is read into memory whole, so a request larger than this is
 * refused before it is read rather than after. Generous enough for any
 * recording a caller has reason to transcribe in one request; a longer one
 * belongs in segments, which is what every consumer already sends.
 */
const MAX_AUDIO_UPLOAD_BYTES = 268_435_456;

async function handleAudioTranscription(ctx: DoorContext, req: Request): Promise<Response> {
  const declared = Number(req.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > MAX_AUDIO_UPLOAD_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `upload is ${declared} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
    );
  }
  const form = await parseTranscriptionForm(req);
  if (form.file.byteLength > MAX_AUDIO_UPLOAD_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `upload is ${form.file.byteLength} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
    );
  }
  const audio = resolveAudioEngine(ctx, form.rawModel ?? undefined, "/v1/audio/transcriptions");
  if (!audio.ok) {
    return audio.response;
  }
  const { engineId } = audio;
  const start = audioStart(ctx);
  const transcriptionReq: TranscriptionRequestBody = {
    model: engineId,
    file: form.file,
    language: form.language,
    response_format: form.responseFormat,
  };
  const startedAt = Date.now();
  const result = await handleTranscription(transcriptionReq, start);
  armAudioIdleStop(ctx, engineId);
  return doorResponseToResponse(
    recordAudioCall(ctx, { engineId, requested: form.rawModel ?? "", result, startedAt }),
  );
}

/** Tokenize/apply-template/slots are chat tools; asking the router for any other role would inject the wrong model. */
const EXTRAS_ROLE = "chat";

async function handleExtras(ctx: DoorContext, req: Request): Promise<Response> {
  const config = ctx.getConfig();
  const engineId = resolveEngineSegment("local", config);
  const engineEntry = engineId === undefined ? undefined : ctx.registry.entry(engineId);
  if (engineId === undefined || !engineEntry) {
    return jsonError(STATUS_BAD_REQUEST, "no local llama engine configured");
  }
  const status = await ctx.registry.start(engineId);
  if (status.private_url === null) {
    return jsonError(STATUS_UNAVAILABLE, status.fix ?? `${engineId} is not available`);
  }
  const residentModel = getLlamaRouter(ctx, engineEntry).residentModel(EXTRAS_ROLE);
  return proxyExtras(
    req,
    `http://${status.private_url}`,
    residentModel,
    ctx.doorOpts.extrasHttpClient,
  );
}

async function handleContent(ctx: DoorContext, req: Request, pathname: string): Promise<Response> {
  if (pathname === "/v1/audio/transcriptions") {
    return handleAudioTranscription(ctx, req);
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return jsonError(STATUS_BAD_REQUEST, "invalid JSON body");
  }
  if (pathname === "/v1/audio/speech") {
    return handleAudioSpeech(ctx, body);
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
  });
}

/**
 * The state stream. engined idle-stops engines on its own, so without this a
 * consumer only discovers an engine went away when a call against it fails --
 * and the alternative to being told is polling `GET /v1/engines` forever.
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
  if (pathname === "/v1/models") {
    return modelsMenu(ctx.registry.models());
  }
  if (pathname === "/v1/engines") {
    return handleEngines(ctx, configErr);
  }
  if (pathname === "/v1/engines/events") {
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

/**
 * OpenAI's list envelope, because a bare array does not fail loudly against
 * a consumer -- it fails silently. Anything parsing the documented shape
 * reads `body.data`, which on an array is `undefined` and degrades to an
 * empty model list with no throw and no bad status: a consumer doing
 * `(body.data ?? []).map((m) => m.id)` sees no models at all while every
 * other endpoint works for it.
 *
 * `data[].id` carries every dispatchable `model` string: GGUF ids, aliases,
 * chain names and agentic engine ids. Most of those name something other than
 * a GGUF, which is why the per-entry metadata stays minimal -- `created` and
 * `owned_by` are here because strict clients require the fields, not because
 * they carry meaning.
 */
function modelsMenu(ids: readonly string[]): Response {
  const created = Math.floor(Date.now() / MS_PER_SECOND);
  return Response.json({
    object: "list",
    data: ids.map((id) => ({ id, object: "model", created, owned_by: "engined" })),
  });
}

function routePost(
  ctx: DoorContext,
  req: Request,
  pathname: string,
): Response | Promise<Response> | undefined {
  const startMatch = START_RE.exec(pathname)?.[1];
  if (startMatch !== undefined) {
    return handleStart(ctx, startMatch, req);
  }
  const stopMatch = STOP_RE.exec(pathname)?.[1];
  if (stopMatch !== undefined) {
    return handleStop(ctx.registry, stopMatch);
  }
  const releaseMatch = RELEASE_RE.exec(pathname)?.[1];
  if (releaseMatch !== undefined) {
    return handleRelease(ctx.registry, releaseMatch);
  }
  if (CONTENT_ENDPOINTS.has(pathname)) {
    return handleContent(ctx, req, pathname);
  }
}

function routeRequest(
  ctx: DoorContext,
  req: Request,
  configErr: string | undefined,
): Response | Promise<Response> {
  const url = new URL(req.url);
  const { pathname } = url;
  if (isExtrasPath(pathname)) {
    return handleExtras(ctx, req);
  }
  let matched: Response | Promise<Response> | undefined;
  if (req.method === "GET") {
    matched = routeGet(ctx, url, configErr, req.signal);
  } else if (req.method === "POST") {
    matched = routePost(ctx, req, pathname);
  }
  return matched ?? jsonError(STATUS_NOT_FOUND, "not found");
}

export function createDoor(
  initialConfig: Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions = {},
): Door {
  let config = initialConfig;
  let configErr: string | undefined;
  const lifecycle =
    registryOpts.lifecycle ??
    new DockerLifecycle(registryOpts.exec ?? dockerExec, registryOpts.probe);
  const registry = new EngineRegistry(config, {
    ...registryOpts,
    lifecycle,
    presetHostPath: doorOpts.llamaPresetHostPath,
  });

  // One LlamaRouter per llama-kind engine, sharing `lifecycle` with the
  // registry so idle-stop, port read-back and start-locking are never
  // tracked twice for the same container.
  const ctx: DoorContext = {
    getConfig: () => config,
    registry,
    lifecycle,
    registryOpts,
    doorOpts,
    llamaRouters: new Map(),
    staleLlamaRouters: new Set(),
  };

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

  function fetch(req: Request): Response | Promise<Response> {
    return checkOrigin(req, config.listen_port) ?? routeRequest(ctx, req, configErr);
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
): { v4: ReturnType<typeof Bun.serve>; v6: ReturnType<typeof Bun.serve> } {
  // `idleTimeout: 0` disables Bun's own socket timer, which defaults to 10s
  // and closes the connection with NO body -- indistinguishable from the
  // daemon being down, and reached by any cold start (a container plus a
  // 25 GB GGUF) or any answer slower than ten seconds. It cannot simply be
  // raised to match: Bun rejects an `idleTimeout` above 255, which is below
  // the default `chat_timeout_seconds` of 600. The request budget is
  // engined's own, per hop and per engine kind (`timeoutSecondsForKind`), so
  // a socket timer here could only ever cut that budget short.
  const serveOpts = { fetch, idleTimeout: 0 } as const;
  const v4 = Bun.serve({ hostname: "127.0.0.1", port, ...serveOpts });
  const v6 = Bun.serve({ hostname: "::1", port: v4.port, ...serveOpts });
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

if (import.meta.main) {
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
    door = createDoor(startupConfig, {
      enginesRoot: `${installDir()}/engines`,
      bunx,
      // Only production wiring: a real probe run is a real billed call to
      // Anthropic. `agenticStatus`'s version-proof gate is what keeps this
      // from firing per request or per status poll -- it only ever invokes
      // the runner when the configured pin differs from the one last proved.
      agenticProbeRunner: buildAgenticProbeRunner(
        bunx,
        `http://127.0.0.1:${startupConfig.listen_port}/v1`,
      ),
    });
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  let bound: { v4: ReturnType<typeof Bun.serve>; v6: ReturnType<typeof Bun.serve> };
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
