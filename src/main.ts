/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import { type AgenticSpawn, defaultAgenticSpawn, runAgentic } from "./agentic.ts";
import {
  type DoorResponse,
  handleSpeech,
  handleTranscription,
  type SpeechRequestBody,
  type TranscriptionRequestBody,
} from "./audio.ts";
import { type HopExec, type HopResult, runChain } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { type Dispatch, resolveEngineSegment, resolveModel } from "./dispatch.ts";
import { DockerLifecycle, dockerExec } from "./docker.ts";
import { EngineRegistry, type RegistryOptions } from "./engines.ts";
import { proxyExtras } from "./extras.ts";
import { type HttpClient, LlamaRouter } from "./llama.ts";
import { configPath, installDir } from "./paths.ts";
import { recordCall } from "./provenance.ts";
import { loadSpec } from "./spec.ts";
import { type Config, type EngineEntry, FatalError } from "./types.ts";

const CONTENT_ENDPOINTS = new Set([
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/audio/speech",
  "/v1/audio/transcriptions",
]);

const START_RE = /^\/v1\/engines\/([^/]+)\/start$/;

/** As `URL#hostname` reports them: no port; an IPv6 literal keeps its brackets. */
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** `ss -ltnp`'s process column: `users:(("name",pid=1234,fd=56))`. */
const SS_HOLDER_RE = /users:\(\("([^"]+)",pid=(\d+)/;

function refuse(message: string): Response {
  return Response.json({ error: message }, { status: 403 });
}

/** First listener only — a port already bound has exactly one holder worth naming. */
export function parsePortHolder(ssOutput: string): { name: string; pid: number } | undefined {
  const match = SS_HOLDER_RE.exec(ssOutput);
  const name = match?.[1];
  const pidStr = match?.[2];
  if (name === undefined || pidStr === undefined) {
    return;
  }
  return { name, pid: Number(pidStr) };
}

/**
 * Best-effort: `ss` absent or unparsable falls through to `undefined` rather
 * than throwing — a failed diagnosis must not replace the bind-error
 * diagnosis itself.
 *
 * Confirmed empirically under this unit's own sandbox (ProtectSystem=strict,
 * ProtectHome=read-only and PrivateTmp=yes each independently reproduce it):
 * `ss -p` resolves a listener's process only by reading `/proc/<pid>/fd/*`
 * in the holder process, and the kernel denies that readlink across mount
 * namespaces even for the same uid — `ls -la /proc/<pid>/fd` lists the
 * entries but every one is "Permission denied" to read. Any of these three
 * directives puts engined in its own mount namespace, so in the real unit
 * the holder is almost never nameable; this only reliably resolves a holder
 * when engined itself runs unsandboxed (a plain dev invocation). There is no
 * unprivileged workaround that does not mean weakening the sandbox, so this
 * stays best-effort by design rather than something to keep chasing.
 */
function describePortHolder(port: number): string | undefined {
  const res = spawnSync("ss", ["-ltnp", `sport = :${port}`], { encoding: "utf8" });
  if (res.error || res.status !== 0) {
    return;
  }
  const holder = parsePortHolder(res.stdout);
  return holder ? `${holder.name} (pid ${holder.pid})` : undefined;
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

async function handleEngines(
  registry: EngineRegistry,
  configErr: string | undefined,
): Promise<Response> {
  const listed = await registry.list();
  listed.config_error = configErr;
  return Response.json(listed);
}

async function handleStart(registry: EngineRegistry, id: string): Promise<Response> {
  try {
    return Response.json(await registry.start(id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 404 });
  }
}

/** No lifecycle default is exported from engines.ts; duplicated here rather than reaching in. */
const DEFAULT_IDLE_STOP_SECONDS = 900;
const DEFAULT_READY_TIMEOUT_S = 60;

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

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `chain.ts`'s own hop format, `@/<engine>/<model>`; not exported, so mirrored rather than reached for. */
const HOP_PREFIX_RE = /^@\//;
function parseHopSegments(hop: string): { engine: string; model: string } {
  const [engine, ...rest] = hop.replace(HOP_PREFIX_RE, "").split("/");
  return { engine: engine ?? hop, model: rest.join("/") };
}

const MS_PER_SECOND = 1000;
/** Matches OpenAI's own convention: 4xx is the caller's fault, so a completed attempt reports it as `ok`. */
const HTTP_CLIENT_ERROR_MIN = 400;

/** A modelless engine (agentic bare selector) becomes a hop with no model segment at all. */
function hopFromDispatch(dispatch: Extract<Dispatch, { ok: true }>): string {
  if (dispatch.kind === "chain") {
    throw new Error("hopFromDispatch: a chain dispatch carries its own hops");
  }
  return dispatch.kind === "model"
    ? `@/${dispatch.engine}/${dispatch.model}`
    : `@/${dispatch.engine}`;
}

function stripField(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const rest = { ...body };
  delete rest[field];
  return rest;
}

/** `claude -p` takes one prompt on stdin; OpenAI's `messages` array has no such shape upstream to borrow. */
function promptFromMessages(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .map((m) => (isRecord(m) ? `${String(m.role ?? "user")}: ${String(m.content ?? "")}` : ""))
    .join("\n");
}

let agenticCallSeq = 0;

/** The minimal OpenAI chat-completion shape a caller expects back; nothing here builds `usage` or token counts. */
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
  audioFetch?: typeof fetch;
  extrasHttpClient?: HttpClient;
  /** Injected so a test can capture the provenance line instead of reading real stdout. */
  write?: (line: string) => void;
  llamaPollIntervalMs?: number;
  /** Defaults to `LlamaRouter`'s own default; a test overrides it so it never touches the real state dir. */
  llamaPresetHostPath?: string;
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
}

function getLlamaRouter(ctx: DoorContext, engine: EngineEntry): LlamaRouter {
  let router = ctx.llamaRouters.get(engine.id);
  if (router) {
    return router;
  }
  const models = ctx.getConfig().models.filter((m) => m.engine === engine.id);
  router = new LlamaRouter(engine, models, ctx.lifecycle, {
    enginesRoot: ctx.registryOpts.enginesRoot,
    bunx: ctx.registryOpts.bunx,
    idleStopSeconds: engine.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS,
    readyTimeoutS: engine.ready_timeout_s ?? DEFAULT_READY_TIMEOUT_S,
    httpClient: ctx.doorOpts.llamaHttpClient,
    pollIntervalMs: ctx.doorOpts.llamaPollIntervalMs,
    presetHostPath: ctx.doorOpts.llamaPresetHostPath,
  });
  ctx.llamaRouters.set(engine.id, router);
  return router;
}

function egressOf(ctx: DoorContext, seg: string): "none" | "remote" {
  const config = ctx.getConfig();
  const id = resolveEngineSegment(seg, config) ?? seg;
  return config.engines.find((e) => e.id === id)?.egress ?? "remote";
}

interface HopRequest {
  pathname: string;
  rawBody: Record<string, unknown>;
  setContentType: (ct: string) => void;
}

/** The `openai-http` case: proxy through this engine's `LlamaRouter`, `workdir` stripped. */
async function execLlama(
  ctx: DoorContext,
  engineEntry: EngineEntry,
  modelSeg: string,
  req: HopRequest,
): Promise<HopResult> {
  const model = ctx
    .getConfig()
    .models.find((m) => m.engine === engineEntry.id && m.id === modelSeg);
  if (!model) {
    return {
      status: 502,
      body: { error: `model "${modelSeg}" not found on "${engineEntry.id}"` },
      startedBytes: false,
    };
  }
  const router = getLlamaRouter(ctx, engineEntry);
  const init: RequestInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(stripField(req.rawBody, "workdir")),
  };
  const response = await router.proxy(model, req.pathname, init);
  req.setContentType(response.headers.get("content-type") ?? "application/json");
  return { status: response.status, stream: response.body ?? undefined, startedBytes: false };
}

/** The `agentic-cli` case. `runAgentic` itself enforces the workdir-required-400 rule. */
async function execAgentic(
  ctx: DoorContext,
  engineId: string,
  rawBody: Record<string, unknown>,
): Promise<HopResult> {
  const engineEntry = ctx.getConfig().engines.find((e) => e.id === engineId);
  if (!engineEntry) {
    return { status: 502, body: { error: `unknown engine "${engineId}"` }, startedBytes: false };
  }
  if (engineEntry.base_url !== undefined) {
    // No local spec directory, so no argv/env allowlist to launch a
    // subprocess with; direct HTTP proxying via SecretRef.header isn't
    // built anywhere yet. See the report's seam note.
    return {
      status: 501,
      body: { error: `engine "${engineId}" is a remote-address agentic engine; not wired yet` },
      startedBytes: false,
    };
  }
  if (engineEntry.claude_version === undefined) {
    return {
      status: 502,
      body: { error: `engine "${engineId}" has no claude_version configured` },
      startedBytes: false,
    };
  }
  const loaded = loadSpec(engineEntry, {
    enginesRoot: ctx.registryOpts.enginesRoot,
    bunx: ctx.registryOpts.bunx,
  });
  const workdir = typeof rawBody.workdir === "string" ? rawBody.workdir : undefined;
  const outcome = await runAgentic({
    claudeVersion: engineEntry.claude_version,
    args: engineEntry.args,
    envAllowlist: loaded.spec.env,
    workdir,
    prompt: promptFromMessages(rawBody),
    spawn: ctx.doorOpts.agenticSpawn ?? defaultAgenticSpawn,
    bunx: ctx.registryOpts.bunx,
  });
  if (!outcome.ok) {
    return {
      status: outcome.status,
      body: { error: outcome.failure ?? "agentic call failed" },
      startedBytes: false,
    };
  }
  return { status: outcome.status, body: agenticEnvelope(outcome.result), startedBytes: false };
}

function buildHopExec(ctx: DoorContext, req: HopRequest): HopExec {
  return async (hop) => {
    const { engine: seg, model: modelSeg } = parseHopSegments(hop);
    const engineId = resolveEngineSegment(seg, ctx.getConfig()) ?? seg;
    const kind = ctx.registry.get(engineId)?.kind;
    if (kind === "agentic-cli") {
      return await execAgentic(ctx, engineId, req.rawBody);
    }
    const engineEntry = ctx.getConfig().engines.find((e) => e.id === engineId);
    if (kind === "openai-http" && engineEntry) {
      return await execLlama(ctx, engineEntry, modelSeg, req);
    }
    return {
      status: 502,
      body: { error: `engine "${engineId}" of kind "${kind}" cannot serve this request` },
      startedBytes: false,
    };
  };
}

function chatTimeoutMs(
  ctx: DoorContext,
  chainName: string | null,
  resolved: Extract<Dispatch, { ok: true }>,
): number {
  const config = ctx.getConfig();
  const isAgenticSingle =
    resolved.kind !== "chain" && ctx.registry.get(resolved.engine)?.kind === "agentic-cli";
  const seconds =
    chainName !== null || isAgenticSingle
      ? config.agent_timeout_seconds
      : config.chat_timeout_seconds;
  return seconds * MS_PER_SECOND;
}

interface ContentRequest {
  pathname: string;
  rawModel: string;
  body: Record<string, unknown>;
}

/** Chat and embeddings: `chain`, `model` and `engine` dispatches all become one or more `@/engine/model` hops through `runChain`, which is also where the one provenance line per call is emitted. */
async function handleChatOrEmbeddings(
  ctx: DoorContext,
  resolved: Extract<Dispatch, { ok: true }>,
  content: ContentRequest,
): Promise<Response> {
  const { pathname, rawModel, body } = content;
  const hops = resolved.kind === "chain" ? [...resolved.hops] : [hopFromDispatch(resolved)];
  const chainName = resolved.kind === "chain" ? resolved.chain : null;

  let contentType = "application/json";
  const result = await runChain(hops, {
    chain: chainName,
    requested: rawModel,
    localOnly: body.local_only === true,
    egressOf: (seg) => egressOf(ctx, seg),
    timeoutMs: chatTimeoutMs(ctx, chainName, resolved),
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
      headers: { "content-type": contentType },
    });
  }
  return Response.json(result.body, { status: result.status });
}

interface AudioCallInfo {
  engineId: string;
  requested: string;
  status: number;
  startedAt: number;
}

function recordAudioCall(ctx: DoorContext, info: AudioCallInfo): void {
  const { engineId, requested, status, startedAt } = info;
  recordCall(
    {
      chain: null,
      requested,
      attempts: [
        {
          engine: engineId,
          model: engineId,
          ok: status < HTTP_CLIENT_ERROR_MIN,
          duration_ms: Date.now() - startedAt,
        },
      ],
      engine_used: status < HTTP_CLIENT_ERROR_MIN ? engineId : null,
    },
    ctx.doorOpts.write,
  );
}

function doorResponseToResponse(result: DoorResponse): Response {
  if (result.bytes) {
    // `Buffer.from` rather than the raw `Uint8Array`: DoorResponse.bytes is
    // typed as the generic `ArrayBufferLike` view, which Bun's `BodyInit`
    // does not accept directly.
    return new Response(Buffer.from(result.bytes), {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  }
  if (result.contentType === "text/plain") {
    return new Response(String(result.body), {
      status: result.status,
      headers: { "content-type": result.contentType },
    });
  }
  return Response.json(result.body, { status: result.status });
}

async function handleAudioSpeech(
  ctx: DoorContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const resolved = resolveModel(rawModel, "/v1/audio/speech", ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: 400 });
  }
  if (resolved.kind === "chain") {
    return Response.json({ error: "audio endpoints do not take a chain" }, { status: 400 });
  }
  const engineId = resolved.engine;
  const start = async (id: string) => {
    const status = await ctx.registry.start(id);
    return { private_url: status.private_url };
  };
  const speechReq: SpeechRequestBody = {
    model: engineId,
    input: typeof body.input === "string" ? body.input : "",
    response_format: typeof body.response_format === "string" ? body.response_format : undefined,
  };
  const startedAt = Date.now();
  const result = await handleSpeech(speechReq, start, ctx.doorOpts.audioFetch);
  recordAudioCall(ctx, { engineId, requested: rawModel ?? "", status: result.status, startedAt });
  return doorResponseToResponse(result);
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

async function handleAudioTranscription(ctx: DoorContext, req: Request): Promise<Response> {
  const form = await parseTranscriptionForm(req);
  const resolved = resolveModel(
    form.rawModel ?? undefined,
    "/v1/audio/transcriptions",
    ctx.getConfig(),
    ctx.registry,
  );
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: 400 });
  }
  if (resolved.kind === "chain") {
    return Response.json({ error: "audio endpoints do not take a chain" }, { status: 400 });
  }
  const engineId = resolved.engine;
  const start = async (id: string) => {
    const status = await ctx.registry.start(id);
    return { private_url: status.private_url };
  };
  const transcriptionReq: TranscriptionRequestBody = {
    model: engineId,
    file: form.file,
    language: form.language,
    response_format: form.responseFormat,
  };
  const startedAt = Date.now();
  const result = await handleTranscription(transcriptionReq, start, ctx.doorOpts.audioFetch);
  recordAudioCall(ctx, {
    engineId,
    requested: form.rawModel ?? "",
    status: result.status,
    startedAt,
  });
  return doorResponseToResponse(result);
}

/** `/tokenize`, `/detokenize`, `/apply-template`, `/slots(/:id)`, `/models/load`, `/models/unload` — always the one local llama engine. */
/** Tokenize/apply-template/slots are chat tools; asking the router for any other role would inject the wrong model. */
const EXTRAS_ROLE = "chat";

async function handleExtras(ctx: DoorContext, req: Request): Promise<Response> {
  const config = ctx.getConfig();
  const engineId = resolveEngineSegment("local", config);
  const engineEntry =
    engineId === undefined ? undefined : config.engines.find((e) => e.id === engineId);
  if (engineId === undefined || !engineEntry) {
    return Response.json({ error: "no local llama engine configured" }, { status: 400 });
  }
  const status = await ctx.registry.start(engineId);
  if (status.private_url === null) {
    return Response.json({ error: `${engineId} is not available` }, { status: 503 });
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
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (pathname === "/v1/audio/speech") {
    return handleAudioSpeech(ctx, body);
  }
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const resolved = resolveModel(rawModel, pathname, ctx.getConfig(), ctx.registry);
  if (!resolved.ok) {
    return Response.json({ error: resolved.error }, { status: 400 });
  }
  return handleChatOrEmbeddings(ctx, resolved, { pathname, rawModel: rawModel ?? "", body });
}

function routeGet(
  ctx: DoorContext,
  pathname: string,
  configErr: string | undefined,
): Response | Promise<Response> | undefined {
  if (pathname === "/v1/models") {
    return Response.json(ctx.registry.models());
  }
  if (pathname === "/v1/engines") {
    return handleEngines(ctx.registry, configErr);
  }
}

function routePost(
  ctx: DoorContext,
  req: Request,
  pathname: string,
): Response | Promise<Response> | undefined {
  const startMatch = START_RE.exec(pathname);
  if (startMatch) {
    const [, id] = startMatch;
    return id === undefined
      ? Response.json({ error: "not found" }, { status: 404 })
      : handleStart(ctx.registry, id);
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
  const { pathname } = new URL(req.url);
  if (isExtrasPath(pathname)) {
    return handleExtras(ctx, req);
  }
  let matched: Response | Promise<Response> | undefined;
  if (req.method === "GET") {
    matched = routeGet(ctx, pathname, configErr);
  } else if (req.method === "POST") {
    matched = routePost(ctx, req, pathname);
  }
  return matched ?? Response.json({ error: "not found" }, { status: 404 });
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
  const registry = new EngineRegistry(config, { ...registryOpts, lifecycle });

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
  };

  function reload(path: string): void {
    try {
      const next = loadConfig(path);
      config = next;
      configErr = undefined;
      registry.reload(next);
      ctx.llamaRouters.clear();
    } catch (err) {
      configErr = err instanceof Error ? err.message : String(err);
    }
  }

  function fetch(req: Request): Response | Promise<Response> {
    return checkOrigin(req, config.listen_port) ?? routeRequest(ctx, req, configErr);
  }

  return { fetch, reload, registry, configError: () => configErr };
}

if (import.meta.main) {
  let startupConfig: Config;
  try {
    startupConfig = loadConfig();
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  // Set by the --user unit; a bare `bunx` is only reached in a working-tree dev run.
  const bunx = process.env.ENGINED_BUNX ?? "bunx";
  const door = createDoor(startupConfig, {
    enginesRoot: `${installDir()}/engines`,
    bunx,
  });

  let v4: ReturnType<typeof Bun.serve>;
  let v6: ReturnType<typeof Bun.serve>;
  try {
    v4 = Bun.serve({ hostname: "127.0.0.1", port: startupConfig.listen_port, fetch: door.fetch });
    v6 = Bun.serve({ hostname: "::1", port: v4.port, fetch: door.fetch });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const holder = describePortHolder(startupConfig.listen_port);
    const detail = holder
      ? `port ${startupConfig.listen_port} already in use, held by ${holder}: ${message}`
      : `port ${startupConfig.listen_port} already in use: ${message}`;
    process.stderr.write(`${detail}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  process.on("SIGHUP", () => door.reload(configPath()));

  process.on("SIGTERM", () => {
    door.registry
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        v4.stop();
        v6.stop();
        process.exit(0);
      });
  });
}
