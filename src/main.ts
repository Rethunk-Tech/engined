/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  type AgenticSpawn,
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  type RunAgenticResult,
  runAgentic,
} from "./agentic.ts";
import {
  type DoorResponse,
  type EngineStart,
  handleSpeech,
  handleTranscription,
  SPEECH_DOOR_KEYS,
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
import { type Dispatch, resolveModel, resolveQualified, routeEgress } from "./dispatch.ts";
import { DockerLifecycle, dockerExec } from "./docker.ts";
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
  type HttpClient,
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
  STATUS_PAYLOAD_TOO_LARGE,
  STATUS_UNAVAILABLE,
  TEXT_CONTENT_TYPE,
} from "./http.ts";
import { LlamaRouter, reportedModelFrom } from "./llama.ts";
import { configPath, installDir, stateDir } from "./paths.ts";
import { recordCall } from "./provenance.ts";
import { loadSpec } from "./spec.ts";
import {
  type AgenticSpec,
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  type Config,
  type Egress,
  type EngineEntry,
  type EngineKind,
  type EngineState,
  type EngineStatus,
  errMessage,
  FatalError,
  findModelOnEngine,
  isEgress,
  isRecord,
  type ModelCapabilities,
  type ModelRow,
  type ModelsResponse,
  MS_PER_SECOND,
  parseRecord,
  qualifiedSegments,
  type ResolvedRoute,
  type Role,
  routeForHop,
  routeServes,
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

const CONTENT_ENDPOINTS = new Set([
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
]);

/**
 * The door's OpenAI surface is prefixed; llama-server and every remote provider
 * serve those same paths unprefixed. Strip ours before forwarding, or the
 * upstream is asked for a path only this door knows about.
 */
const OPENAI_PREFIX = "/openai";
export function enginePath(doorPath: string): string {
  return doorPath.startsWith(`${OPENAI_PREFIX}/`) ? doorPath.slice(OPENAI_PREFIX.length) : doorPath;
}

/**
 * The launch-scoped door: `/openai/v1/<nonce>/...` dispatches exactly like
 * `/openai/v1/...`, with the request marked launch-scoped so a hop resolving
 * to an agentic engine can be refused. `<nonce>` is `crypto.randomUUID()`
 * with its dashes stripped -- 32 lowercase hex characters -- minted at the
 * `runAgentic` call site and never written anywhere durable.
 */
const LAUNCH_NONCE_RE = /^\/openai\/v1\/([0-9a-f]{32})(\/.*)$/;

function mintLaunchNonce(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

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
    const route = findModelOnEngine(config.routes, hop.engine, hop.model, hop.upstream);
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
 * Every JSON body this door reads, or the 400 to return instead. A table is
 * the only accepted shape: `null`, an array and a bare scalar all parse as
 * valid JSON and none of them has the fields a handler goes on to read, so
 * they are rejected here rather than at the first property access.
 */
async function readJsonBody(req: Request): Promise<Record<string, unknown> | Response> {
  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return jsonError(STATUS_BAD_REQUEST, "invalid JSON body");
  }
  return parseRecord(raw) ?? jsonError(STATUS_BAD_REQUEST, "invalid JSON body");
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

/**
 * The mediated comfy proxy. `private_url` is a funding bypass: every control
 * this project has -- call recording, egress ceilings, and later the
 * budgets that decide whose money pays -- lives at the door, and a consumer
 * holding a raw container address routes around all of it. This is comfy's
 * replacement: every real caller reaches ComfyUI's own paths through here,
 * by address, and never by a host:port this door handed out. The rule is
 * simple even where the mediation below is not: the door forwards content,
 * never a ledger and never control.
 */
const COMFY_PROXY_RE = /^\/engined\/v1\/comfy\/([^/]+)\/([^/]+)\/(.+)$/;
const COMFY_WS_SUFFIX = "ws";
/** Rewrites an `http(s)://` base to its `ws(s)://` twin for the comfy websocket bridge. */
const HTTP_SCHEME_RE = /^http/;
/** Enough of a UUID to keep two same-second uploads of one filename apart in comfy's shared input directory. */
const COMFY_UPLOAD_PREFIX_LEN = 12;

/** The three path segments `COMFY_PROXY_RE` captures. */
interface ComfyMatch {
  engineSeg: string;
  upstreamSeg: string;
  rest: string;
}

function matchComfyPath(pathname: string): ComfyMatch | undefined {
  const m = COMFY_PROXY_RE.exec(pathname);
  return m
    ? { engineSeg: m[1] as string, upstreamSeg: m[2] as string, rest: m[3] as string }
    : undefined;
}

/** One resolved comfy engine plus the client every forwarded call goes through. */
interface ComfyProxy {
  ctx: DoorContext;
  engineId: string;
  /** Who submitted the prompt: half the binding key, so no rekey is needed the day a call arrives from somewhere other than this box. */
  origin: string;
  base: string;
  httpClient: HttpClient;
}

/** `ServerWebSocket.data` for one comfy relay connection: where to reach the real container, the door-assigned clientId comfy filters frames by, and the live upstream socket once `open` has dialed it. */
interface ComfyWsData {
  upstreamUrl: string;
  clientId: string;
  upstream?: WebSocket;
}

/** `Bun.serve`'s own return type, parameterized on the one websocket payload this door ever mounts -- `bindDualFamily`'s real listeners and `Door.fetch`'s optional second argument must agree on it, or `server.upgrade`'s `data` stops typechecking. */
type EnginedServer = ReturnType<typeof Bun.serve<ComfyWsData>>;

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
type ComfyBindings = Map<string, string[]>;

/** Every caller reaching this door reached it directly, so far; a federated hop will supply its own origin instead of this constant. */
const COMFY_LOCAL_ORIGIN = "local";

/** NUL, so the composed key stays unambiguous and `startsWith` can scope a scan to one (engine, origin) pair: no engine id, origin or `prompt_id` can contain one. */
const COMFY_KEY_SEP = "\u0000";

function comfyKey(engineId: string, origin: string, promptId: string): string {
  return `${engineId}${COMFY_KEY_SEP}${origin}${COMFY_KEY_SEP}${promptId}`;
}

/**
 * The binding table on disk: ids and filenames only, never a request body --
 * a `prompt_id` is comfy's job handle, not the prompt that produced it.
 * It outlives the process because a restart that forgot a binding would
 * refuse a stored output to the very caller that created it.
 */
function comfyBindingsPath(): string {
  return join(stateDir(), "comfy-bindings.json");
}

function loadComfyBindings(): ComfyBindings {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(comfyBindingsPath(), "utf8"));
  } catch {
    // No table yet, or one this build cannot read. An empty table refuses
    // every stored output, which is the safe direction to fail.
    return new Map();
  }
  if (!isRecord(raw)) {
    return new Map();
  }
  return new Map(
    Object.entries(raw).flatMap(([key, names]): [string, string[]][] =>
      Array.isArray(names) ? [[key, names.filter((n) => typeof n === "string")]] : [],
    ),
  );
}

/**
 * How many bindings the table keeps. Count, not age: a `prompt_id` carries no
 * timestamp and adding one would mean a second on-disk shape to read back,
 * where `Map` iteration order already puts the oldest binding first.
 *
 * Evicting a binding is what makes `GET /view` refuse an output the door
 * itself produced, so this is set well above what a session plausibly
 * generates rather than as tight as the file could bear -- ~78 bytes per
 * binding measured, so the whole table stays under ~100 KB.
 */
const COMFY_BINDINGS_MAX = 1000;

// ponytail: the whole table is rewritten on every bind and every filename
// attach -- bounded work now that COMFY_BINDINGS_MAX bounds the table. An
// append log only earns its complexity if that cap is ever raised far enough
// for the rewrite to be felt.
/**
 * The eviction lands only once the write has. A full disk or an unwritable
 * state dir would otherwise shrink the table in memory while the file keeps
 * the larger set, and the door would refuse an output it can still see on
 * disk with nothing said. So a failed write leaves the table exactly as the
 * file still describes it, reports itself, and lets the call it belongs to
 * answer: the caller's own request succeeded, and nothing is lost until this
 * process restarts.
 */
function saveComfyBindings(bindings: ComfyBindings): void {
  // Oldest first: a binding is inserted when its prompt is queued and only
  // mutated in place afterwards, so insertion order is creation order.
  const entries = [...bindings];
  const evicted = entries.slice(0, Math.max(0, entries.length - COMFY_BINDINGS_MAX));
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(
      comfyBindingsPath(),
      JSON.stringify(Object.fromEntries(entries.slice(evicted.length))),
    );
  } catch (err) {
    process.stderr.write(`comfy bindings not persisted: ${errMessage(err)}\n`);
    return;
  }
  for (const [key] of evicted) {
    bindings.delete(key);
  }
}

interface ComfyTarget {
  engineId: string;
  /** `http://host:port`, this container's own address -- never handed to a caller, only used to build the door's own forwarded request. */
  base: string;
}

/** The engine+upstream segments of a comfy proxy path, resolved to a running comfy container -- `undefined` for anything that is not one: an unknown engine, a non-comfy kind, a route that does not exist, or a container that is not up. */
function resolveComfyTarget(
  ctx: DoorContext,
  engineSeg: string,
  upstreamSeg: string,
): ComfyTarget | undefined {
  const config = ctx.getConfig();
  if (!config.engines.some((e) => e.id === engineSeg)) {
    return undefined;
  }
  if (ctx.registry.get(engineSeg)?.kind !== "comfy") {
    return undefined;
  }
  const hasRoute = config.routes.some(
    (r) =>
      !r.disabled && r.engine === engineSeg && r.upstream === upstreamSeg && r.model === undefined,
  );
  if (!hasRoute) {
    return undefined;
  }
  const privateUrl = ctx.lifecycle.getStatus(engineSeg).private_url;
  return privateUrl === null ? undefined : { engineId: engineSeg, base: `http://${privateUrl}` };
}

function noSuchComfyEngine(engineSeg: string, upstreamSeg: string): Response {
  return jsonError(
    STATUS_UNAVAILABLE,
    `no running comfy engine at "@/${engineSeg}/${upstreamSeg}" -- start it first`,
  );
}

/** `GET /object_info/{nodeType}` and `GET /system_stats`: a static node schema and the container's own stats, nobody's data either way. */
async function forwardComfyGet(
  base: string,
  rest: string,
  search: string,
  httpClient: HttpClient,
): Promise<Response> {
  const res = await httpClient(`${base}/${rest}${search}`);
  return new Response(res.body, {
    status: res.status,
    headers: { [CONTENT_TYPE]: res.headers.get(CONTENT_TYPE) ?? JSON_CONTENT_TYPE },
  });
}

/** The `prompt_id` comfy answered `/prompt` with -- `undefined` for a body that is not JSON or carries none, which binds nothing. The caller still gets comfy's real body and status back either way. */
function comfyPromptId(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { prompt_id?: unknown };
    return typeof parsed.prompt_id === "string" ? parsed.prompt_id : undefined;
  } catch {
    return undefined;
  }
}

/** `POST /prompt`, forwarded, with the returned `prompt_id` bound to this engine's proxy state -- the only thing that makes the `/history` and `/queue` mediation below possible. */
async function proxyComfyPrompt(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await req.text();
  const res = await httpClient(`${base}/prompt`, {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body,
  });
  const text = await res.text();
  const promptId = res.ok ? comfyPromptId(text) : undefined;
  if (promptId !== undefined) {
    ctx.comfyBindings.set(comfyKey(engineId, origin, promptId), []);
    saveComfyBindings(ctx.comfyBindings);
  }
  return new Response(text, { status: res.status, headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE } });
}

/** `POST /upload/image`, forwarded with the stored filename namespaced -- comfy's input directory is shared across every caller, and two callers uploading "reference.png" the same second must not silently overwrite one another. */
async function proxyComfyUpload(
  base: string,
  req: Request,
  httpClient: HttpClient,
): Promise<Response> {
  const incoming = await req.formData();
  const image = incoming.get("image");
  if (!(image instanceof Blob)) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with an "image" part');
  }
  const originalName = image instanceof File ? image.name : "upload.png";
  const namespaced = `${crypto.randomUUID().replace(/-/g, "").slice(0, COMFY_UPLOAD_PREFIX_LEN)}-${originalName}`;
  const outgoing = new FormData();
  // A fresh `Blob`, not the caller's own `File`: `FormData.append`'s third
  // argument only renames a plain Blob -- handed an existing File, it keeps
  // that File's own name, and the caller's literal filename would leak into
  // comfy's shared input directory unrenamed.
  outgoing.append("image", new Blob([await image.arrayBuffer()], { type: image.type }), namespaced);
  for (const [key, value] of incoming.entries()) {
    if (key !== "image" && typeof value === "string") {
      outgoing.append(key, value);
    }
  }
  const res = await httpClient(`${base}/upload/image`, { method: "POST", body: outgoing });
  return new Response(await res.text(), {
    status: res.status,
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
  });
}

/**
 * Whether some prompt this origin submitted to this engine actually
 * produced `filename`. Scoped to the pair, never engine-wide: another
 * origin's `/history` read must not make its outputs viewable here.
 */
// ponytail: linear over the table, which COMFY_BINDINGS_MAX holds at a
// thousand entries; index by filename only if that cap is ever raised.
function comfyFilenameBound(
  ctx: DoorContext,
  engineId: string,
  origin: string,
  filename: string,
): boolean {
  const prefix = `${engineId}${COMFY_KEY_SEP}${origin}${COMFY_KEY_SEP}`;
  for (const [key, filenames] of ctx.comfyBindings) {
    if (key.startsWith(prefix) && filenames.includes(filename)) {
      return true;
    }
  }
  return false;
}

/** The one refusal `GET /view` ever answers with, for a filename this door never saw a completed job produce -- byte-identical whether that filename does not exist at all or simply was never surfaced to this caller, because this door checks its own known-filenames set and never comfy's disk either way. */
function comfyViewRefused(): Response {
  return jsonError(STATUS_NOT_FOUND, "unknown filename");
}

/**
 * `GET /view`, mediated: only a filename that a completed `/history` read
 * actually surfaced for THIS engine ever reaches comfy. The path-traversal
 * guard this delivery needs today, and the caller-ownership guard the
 * door's design is heading toward -- comfy's output directory is shared,
 * and a caller-supplied filename must never become a URL on its own say-so.
 */
async function proxyComfyView(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  params: URLSearchParams,
): Promise<Response> {
  const filename = params.get("filename");
  if (filename === null || !comfyFilenameBound(ctx, engineId, origin, filename)) {
    return comfyViewRefused();
  }
  const res = await httpClient(`${base}/view?${params.toString()}`);
  return new Response(res.body, {
    status: res.status,
    headers: { [CONTENT_TYPE]: res.headers.get(CONTENT_TYPE) ?? "application/octet-stream" },
  });
}

interface ComfyHistoryMedia {
  filename?: unknown;
}
interface ComfyHistoryOutput {
  images?: ComfyHistoryMedia[];
  gifs?: ComfyHistoryMedia[];
  video?: ComfyHistoryMedia[];
}
interface ComfyHistoryEntry {
  outputs?: Record<string, ComfyHistoryOutput>;
}

/** Every output filename a history entry names, across every node and every media kind comfy can emit one under. */
function filenamesIn(entry: ComfyHistoryEntry | undefined): string[] {
  const names: string[] = [];
  for (const output of Object.values(entry?.outputs ?? {})) {
    for (const media of [
      ...(output.images ?? []),
      ...(output.gifs ?? []),
      ...(output.video ?? []),
    ]) {
      if (typeof media.filename === "string") {
        names.push(media.filename);
      }
    }
  }
  return names;
}

/** This prompt's entry in comfy's `/history` answer -- `undefined` for a body that is not the shape expected, which teaches nothing new. */
function comfyHistoryEntry(text: string, promptId: string): ComfyHistoryEntry | undefined {
  try {
    return (JSON.parse(text) as Record<string, ComfyHistoryEntry>)[promptId];
  } catch {
    return undefined;
  }
}

/**
 * `GET /history/{promptId}`, mediated: refused outright for a `promptId`
 * this door never bound via `/prompt` -- the bare form is the container's
 * entire global ledger, and even the scoped form would otherwise answer
 * with any other caller's completed job for a real id it did not itself
 * submit. A successful read seeds `filenames` with whatever this job
 * actually produced, which is what makes `/view` servable at all.
 */
async function proxyComfyHistory(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  promptId: string,
): Promise<Response> {
  const bound = ctx.comfyBindings.get(comfyKey(engineId, origin, promptId));
  if (bound === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown prompt_id "${promptId}"`);
  }
  const res = await httpClient(`${base}/history/${encodeURIComponent(promptId)}`);
  const text = await res.text();
  if (res.ok) {
    for (const filename of filenamesIn(comfyHistoryEntry(text, promptId))) {
      if (!bound.includes(filename)) {
        bound.push(filename);
      }
    }
    saveComfyBindings(ctx.comfyBindings);
  }
  return new Response(text, { status: res.status, headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE } });
}

/** comfy's `GET /queue`: each entry is a positional tuple whose second slot is the `prompt_id`. */
interface ComfyQueue {
  queue_running?: unknown[][];
  queue_pending?: unknown[][];
}

const COMFY_QUEUE_PROMPT_ID_INDEX = 1;

function queuedPromptIds(entries: unknown[][] | undefined): string[] {
  return (entries ?? [])
    .map((entry) => entry[COMFY_QUEUE_PROMPT_ID_INDEX])
    .filter((id): id is string => typeof id === "string");
}

async function readComfyQueue(
  base: string,
  httpClient: HttpClient,
): Promise<ComfyQueue | undefined> {
  const res = await httpClient(`${base}/queue`);
  if (!res.ok) {
    return undefined;
  }
  try {
    return JSON.parse(await res.text()) as ComfyQueue;
  } catch {
    return undefined;
  }
}

/**
 * `POST /cancel {prompt_id}` -- the door's own verb for stopping a prompt it
 * bound, and the whole reason `/interrupt` is never forwarded on its own.
 * comfy can only interrupt "whatever is running", carrying no id to scope
 * it; the door supplies the scoping the container lacks by reading the queue
 * itself -- never handing that ledger out -- and interrupting only once it
 * has confirmed the running prompt is the caller's own. A prompt still
 * pending is dropped from the queue instead, which needs no interrupt at
 * all, and one that has already finished is reported as such rather than
 * interrupting whatever inherited the GPU after it.
 *
 * ponytail: the running check and the interrupt are two calls, so a prompt
 * that finishes between them yields to a successor this cancel then stops.
 * The window is one round trip against a local container and comfy offers
 * no id-scoped interrupt to close it; close it with a door-held execution
 * lease if that is ever observed to bite.
 */
async function proxyComfyCancel(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  const promptId = body.prompt_id;
  if (typeof promptId !== "string") {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"prompt_id": string}');
  }
  if (!ctx.comfyBindings.has(comfyKey(engineId, origin, promptId))) {
    return jsonError(STATUS_NOT_FOUND, `unknown prompt_id "${promptId}"`);
  }
  const queue = await readComfyQueue(base, httpClient);
  if (queue === undefined) {
    return jsonError(STATUS_BAD_GATEWAY, "comfy queue could not be read");
  }
  if (queuedPromptIds(queue.queue_running).includes(promptId)) {
    await httpClient(`${base}/interrupt`, { method: "POST" });
    return Response.json({ prompt_id: promptId, cancelled: "running" });
  }
  if (queuedPromptIds(queue.queue_pending).includes(promptId)) {
    await httpClient(`${base}/queue`, {
      method: "POST",
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ delete: [promptId] }),
    });
    return Response.json({ prompt_id: promptId, cancelled: "pending" });
  }
  return Response.json({ prompt_id: promptId, cancelled: "finished" });
}

/** `POST /queue {delete:[promptId]}`, mediated: every id in the request must be one this door itself bound via `/prompt`, or nothing is forwarded -- the bare form is the container's global queue ledger, and even the delete form must not let a caller cancel a job it never submitted. */
async function proxyComfyQueueDelete(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req);
  if (body instanceof Response) {
    return body;
  }
  if (!(Array.isArray(body.delete) && body.delete.every((id) => typeof id === "string"))) {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"delete": string[]}');
  }
  const ids = body.delete as string[];
  if (!ids.every((id) => ctx.comfyBindings.has(comfyKey(engineId, origin, id)))) {
    return jsonError(STATUS_NOT_FOUND, "one or more prompt ids are not known to this door");
  }
  const res = await httpClient(`${base}/queue`, {
    method: "POST",
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  });
  return new Response(await res.text(), {
    status: res.status,
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
  });
}

/**
 * Everything else the container answers, dispatched by method and
 * sub-path. Every real call is sub-pathed (`/history/{id}`,
 * `/object_info/{type}`); matching the bare form would match nothing a real
 * caller ever sends and would only invite one that shouldn't. `GET /queue`
 * bare, `POST /free` and `POST /interrupt` are never forwarded: `/free`
 * evicts loaded weights (`release` is the door's own verb for that, with
 * the lease check that belongs there), `/interrupt` stops whatever the
 * container is CURRENTLY processing with no scoping of its own, and a bare
 * `/queue` is the container's entire global ledger. `POST /cancel` is the
 * door's own verb for the one those two would otherwise be wanted for: it
 * reads that ledger and interrupts on the caller's behalf, but only for a
 * `prompt_id` this door bound to this caller. Anything this door has
 * not explicitly allowlisted is refused the same way: the safe default is
 * to forward nothing at all.
 */
function handleComfyProxy(
  ctx: DoorContext,
  req: Request,
  { engineSeg, upstreamSeg, rest }: ComfyMatch,
): Response | Promise<Response> {
  const target = resolveComfyTarget(ctx, engineSeg, upstreamSeg);
  if (target === undefined) {
    return noSuchComfyEngine(engineSeg, upstreamSeg);
  }
  const proxy: ComfyProxy = {
    ctx,
    engineId: target.engineId,
    origin: COMFY_LOCAL_ORIGIN,
    base: target.base,
    httpClient: ctx.doorOpts.comfyHttpClient ?? fetch,
  };

  if (rest === COMFY_WS_SUFFIX) {
    // A real upgrade never reaches here -- `fetch` intercepts it before
    // routing, using the live `Bun.serve` server it is handed. This is only
    // reached by a plain request against the ws path with no real socket
    // behind it (a unit test's direct `door.fetch` call), which cannot be
    // proxied at all.
    return jsonError(STATUS_BAD_REQUEST, "this path is a websocket upgrade, not a plain request");
  }
  let forwarded: Promise<Response> | undefined;
  if (req.method === "GET") {
    forwarded = comfyGet(proxy, rest, new URL(req.url));
  } else if (req.method === "POST") {
    forwarded = comfyPost(proxy, rest, req);
  }
  return forwarded ?? jsonError(STATUS_NOT_FOUND, `"${rest}" is not proxied by this door`);
}

function comfyGet(proxy: ComfyProxy, rest: string, url: URL): Promise<Response> | undefined {
  if (rest === "system_stats" || rest.startsWith("object_info/")) {
    return forwardComfyGet(proxy.base, rest, url.search, proxy.httpClient);
  }
  if (rest === "view") {
    return proxyComfyView(proxy, url.searchParams);
  }
  if (rest.startsWith("history/")) {
    return proxyComfyHistory(proxy, rest.slice("history/".length));
  }
  return undefined;
}

function comfyPost(proxy: ComfyProxy, rest: string, req: Request): Promise<Response> | undefined {
  if (rest === "prompt") {
    return proxyComfyPrompt(proxy, req);
  }
  if (rest === "upload/image") {
    return proxyComfyUpload(proxy.base, req, proxy.httpClient);
  }
  if (rest === "queue") {
    return proxyComfyQueueDelete(proxy, req);
  }
  if (rest === "cancel") {
    return proxyComfyCancel(proxy, req);
  }
  return undefined;
}

/**
 * `GET /ws?clientId=`, upgraded: the door mints its own `clientId` rather
 * than forwarding whatever the caller supplied -- comfy filters progress
 * frames by that id with no ownership check of its own, so a caller free to
 * choose it could subscribe to another caller's job. The assigned id is
 * announced back over the socket itself, as the first text frame
 * (`comfyWebSocketHandlers.open` below), because a websocket upgrade
 * response carries no body to hand it back any other way; a caller's later
 * `POST /prompt` must carry the same id as its own `client_id` for comfy to
 * correlate the two.
 */
function handleComfyWsUpgrade(
  ctx: DoorContext,
  req: Request,
  server: EnginedServer,
  { engineSeg, upstreamSeg }: ComfyMatch,
): Response | undefined {
  const target = resolveComfyTarget(ctx, engineSeg, upstreamSeg);
  if (target === undefined) {
    return noSuchComfyEngine(engineSeg, upstreamSeg);
  }
  const clientId = crypto.randomUUID().replace(/-/g, "");
  const upstreamWsUrl = `${target.base.replace(HTTP_SCHEME_RE, "ws")}/ws?clientId=${clientId}`;
  const data: ComfyWsData = { upstreamUrl: upstreamWsUrl, clientId };
  return server.upgrade(req, { data })
    ? undefined
    : jsonError(STATUS_BAD_REQUEST, "websocket upgrade failed");
}

/** What `comfyWebSocketHandlers.open` announces first, so the caller learns the door-assigned `clientId` before it ever needs one for `POST /prompt`. */
const CLIENT_ID_MESSAGE_TYPE = "client_id";

/**
 * Bridges the caller's own upgraded socket to a fresh outbound connection to
 * the real container, one per caller connection. Comfy's own protocol is
 * server-to-client only (progress and preview frames); nothing a caller
 * could legitimately send back ever reaches comfy through this, so
 * `message` is a deliberate no-op.
 */
const comfyWebSocketHandlers: Bun.WebSocketHandler<ComfyWsData> = {
  open(ws) {
    const upstream = new WebSocket(ws.data.upstreamUrl);
    upstream.binaryType = "arraybuffer";
    ws.data.upstream = upstream;
    upstream.addEventListener("open", () => {
      ws.send(
        JSON.stringify({ type: CLIENT_ID_MESSAGE_TYPE, data: { client_id: ws.data.clientId } }),
      );
    });
    upstream.addEventListener("message", (ev) => {
      if (typeof ev.data === "string") {
        ws.send(ev.data);
      } else {
        ws.send(new Uint8Array(ev.data as ArrayBuffer));
      }
    });
    upstream.addEventListener("close", () => ws.close());
    upstream.addEventListener("error", () => ws.close());
  },
  message() {
    // See the doc comment above: nothing a caller sends is ever forwarded.
  },
  close(ws) {
    ws.data.upstream?.close();
  },
};

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
  response_format: (v) => !isRecord(v) || v.type !== "text",
};

/** Which of those fields this body carries a demanding value for, in the order a caller would read them back. A caller's `null` unsets a wire default (`withoutCallerNulls`) rather than demanding anything. */
function unhonourableFields(body: Record<string, unknown>): string[] {
  return Object.entries(AGENTIC_UNHONOURABLE)
    .filter(([key, demands]) => {
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
  /**
   * Live launch-scoped nonces: minted at the `runAgentic` call site, deleted
   * the moment that call returns. A request naming one that is not in this
   * set -- expired, or never minted -- is refused outright, whether or not
   * it names an agentic engine: a leaked or reused URL is not a standing key.
   */
  launchNonces: Set<string>;
  /** Comfy proxy mediation state, reload-durable -- see `ComfyBindings`. */
  comfyBindings: ComfyBindings;
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
}

/**
 * The `openai-http` case: proxy through this engine's `LlamaRouter`, `workdir`
 * stripped. `req.signal` is `runOneHop`'s own per-hop timeout/caller-abort --
 * forwarded into `RequestInit` so a slow upstream is actually cut off at the
 * budget `chatTimeoutMs` picked, not just marked aborted after the fact.
 */
/** One `openai-http` hop, resolved: the engine answering it, the model segment it was addressed by, and the route (if any) that segment resolved to. */
interface HttpHop {
  engineEntry: EngineEntry;
  modelSeg: string;
  route: ResolvedRoute | undefined;
  req: HopRequest & { signal: AbortSignal };
}

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
  const route = findModelOnEngine(config.routes, engineId, modelSeg, upstream);
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
  modelSeg: string;
  workdir: string | undefined;
  extraEnv: Record<string, string> | undefined;
  req: AgenticHop["req"];
  /** Called when the answer is handed off as a stream that outlives the hop; `run` settles when the child exits. */
  onHandoff: (run: Promise<unknown>) => void;
}

async function launchAgentic(ctx: DoorContext, launch: AgenticLaunch): Promise<HopResult> {
  const { spec, engineEntry, agentVersion, doorUrl, modelSeg, workdir, extraEnv, req } = launch;
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
    // -- always on the launch-scoped URL, never the plain one. The model is
    // always the one this request itself resolved -- an agent with no
    // `configure` (claude) simply never reads this.
    upstream: { baseUrl: doorUrl, model: modelSeg },
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

// Both checks wait on a workdir, so a caller who left one out gets
// `runAgentic`'s 400 naming it: a request-shape rejection the caller owns
// fires before anything this engine cannot do for them.
async function preLaunchRefusal(
  ctx: DoorContext,
  engineId: string,
  req: AgenticHop["req"],
  workdir: string | undefined,
): Promise<HopResult | null> {
  if (workdir === undefined || workdir === "") {
    return null;
  }
  const refusal = unhonourableRefusal(engineId, req);
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
      modelSeg,
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
    return jsonError(STATUS_BAD_REQUEST, 'max_egress must be "none", "lan" or "remote"');
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

interface AudioCallInfo {
  engineId: string;
  /** The model segment of the resolved address, when the engine's routes carry one. Absent for a modelless engine. */
  model?: string;
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
  const { engineId, model, requested, result, startedAt } = info;
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
            // A modelless engine (every TTS route, most STT ones) has no
            // separate model id, so the engine id is the honest fill-in --
            // the same convention the chat path's own Attempt.model follows.
            model: model ?? engineId,
            ok,
            ...(failure === undefined ? {} : { failure }),
            duration_ms: Date.now() - startedAt,
          },
        ],
        engine_used: ok ? engineId : null,
        // Audio provenance does not resolve or track an upstream id today --
        // this is the chat/agentic path's field.
        upstream_used: null,
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
 * Both audio endpoints take an engine, and a model where the resolved
 * route carries one -- whisper's "small.en"/"medium.en", or ElevenLabs'
 * "scribe_v1" -- never a chain. Resolution and that refusal are one step.
 */
function resolveAudioEngine(
  ctx: DoorContext,
  rawModel: string | undefined,
  endpoint: string,
): { ok: true; engineId: string; model?: string } | { ok: false; response: Response } {
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
  return { ok: true, engineId: resolved.route.engine, model: resolved.route.model };
}

/**
 * The audio door's `EngineStart`. A remote engine is resolved to an address
 * and a header instead of started — there is no container to warm — and a
 * secret that will not resolve surfaces as a null `private_url` with no
 * `remote`, which the door reports as unavailable exactly like a container
 * that failed to come up. `EngineBusyError` (a model switch that would kill
 * a request in flight) surfaces as `conflict` rather than propagating, so
 * `handleSpeech`/`handleTranscription` can turn it into a 409 the same way
 * they already turn `unavailable` into a 503.
 */
/** The route an audio call resolves to; a modelless route has no model segment to look one up by, so it is found by engine id alone. */
function audioRoute(
  config: Config,
  id: string,
  model: string | undefined,
): ResolvedRoute | undefined {
  return model === undefined
    ? config.routes.find((r) => r.engine === id && r.model === undefined)
    : findModelOnEngine(config.routes, id, model);
}

async function remoteAudioStart(
  ctx: DoorContext,
  id: string,
  upstreamId: string,
): Promise<Awaited<ReturnType<EngineStart>>> {
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === upstreamId);
  if (upstream === undefined) {
    return { private_url: null, unavailable: `engine "${id}" has no resolvable upstream` };
  }
  const resolution = await resolveUpstream(upstream, ctx.doorOpts.secretExec);
  return resolution.ok
    ? { private_url: null, remote: resolution.endpoint }
    : { private_url: null, unavailable: resolution.error };
}

function audioStart(ctx: DoorContext): EngineStart {
  return async (id: string, model?: string) => {
    const engine = ctx.registry.entry(id);
    const route = audioRoute(ctx.getConfig(), id, model);
    const upstreamId = route?.upstream ?? null;
    if (engine && upstreamId !== null && upstreamId !== "local") {
      return remoteAudioStart(ctx, id, upstreamId);
    }
    try {
      await ctx.registry.start(id, model);
    } catch (err) {
      if (err instanceof EngineBusyError) {
        return { private_url: null, conflict: err.message };
      }
      throw err;
    }
    // Paired with the `armAudioIdleStop` every audio path runs on the way out.
    ctx.lifecycle.beginLease(id);
    // `EngineStatus` (the wire type `registry.start` returns) carries no
    // container address at all -- the internal runtime read is `lifecycle`'s
    // own, the same source the comfy proxy resolves against.
    return { private_url: ctx.lifecycle.getStatus(id).private_url };
  };
}

async function handleAudioSpeech(
  ctx: DoorContext,
  body: Record<string, unknown>,
): Promise<Response> {
  const rawModel = typeof body.model === "string" ? body.model : undefined;
  const audio = resolveAudioEngine(ctx, rawModel, CONTENT_ENDPOINT_SPEECH);
  if (!audio.ok) {
    return audio.response;
  }
  const { engineId } = audio;
  const start = audioStart(ctx);
  const extra = Object.fromEntries(
    Object.entries(body).filter(([key]) => !SPEECH_DOOR_KEYS.has(key)),
  );
  const speechReq: SpeechRequestBody = {
    engine: engineId,
    input: typeof body.input === "string" ? body.input : "",
    response_format: typeof body.response_format === "string" ? body.response_format : undefined,
    stream: body.stream === "ndjson" ? "ndjson" : body.stream === true,
    voice: typeof body.voice === "string" ? body.voice : undefined,
    speed: typeof body.speed === "number" ? body.speed : undefined,
    instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    ...(Object.keys(extra).length > 0 ? { extra } : {}),
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
  prompt: string | undefined;
}

/** `undefined` when the body is not multipart at all -- an empty POST, or a wrong content type. */
async function parseTranscriptionForm(req: Request): Promise<TranscriptionForm | undefined> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return undefined;
  }
  const rawModel = form.get("model");
  const file = form.get("file");
  const language = form.get("language");
  const responseFormat = form.get("response_format");
  const prompt = form.get("prompt");
  return {
    rawModel: typeof rawModel === "string" ? rawModel : null,
    file: file instanceof Blob ? new Uint8Array(await file.arrayBuffer()) : new Uint8Array(0),
    language: typeof language === "string" ? language : undefined,
    responseFormat: typeof responseFormat === "string" ? responseFormat : undefined,
    prompt: typeof prompt === "string" ? prompt : undefined,
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
  if (form === undefined) {
    return jsonError(STATUS_BAD_REQUEST, "expected a multipart form with a `file` part");
  }
  // Zero bytes reaches whisper as a valid-looking empty upload and comes back
  // as an empty transcript, which reads like silence rather than a bad request.
  if (form.file.byteLength === 0) {
    return jsonError(STATUS_BAD_REQUEST, "multipart form carried no `file` part");
  }
  if (form.file.byteLength > MAX_AUDIO_UPLOAD_BYTES) {
    return jsonError(
      STATUS_PAYLOAD_TOO_LARGE,
      `upload is ${form.file.byteLength} bytes; the limit is ${MAX_AUDIO_UPLOAD_BYTES}`,
    );
  }
  const audio = resolveAudioEngine(
    ctx,
    form.rawModel ?? undefined,
    CONTENT_ENDPOINT_TRANSCRIPTIONS,
  );
  if (!audio.ok) {
    return audio.response;
  }
  const { engineId, model } = audio;
  const start = audioStart(ctx);
  const transcriptionReq: TranscriptionRequestBody = {
    engine: engineId,
    model,
    file: form.file,
    language: form.language,
    response_format: form.responseFormat,
    prompt: form.prompt,
  };
  const startedAt = Date.now();
  const result = await handleTranscription(transcriptionReq, start);
  armAudioIdleStop(ctx, engineId);
  return doorResponseToResponse(
    recordAudioCall(ctx, { engineId, model, requested: form.rawModel ?? "", result, startedAt }),
  );
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

/** Whatever this route's own capability fields are -- undefined fields drop out of the JSON on their own, so a route naming an undeclared model reports empty capabilities with no special case. */
function routeCapabilities(route: ModelCapabilities): ModelCapabilities {
  return {
    input: route.input,
    output: route.output,
    context_in: route.context_in,
    context_out: route.context_out,
    reasoning: route.reasoning,
  };
}

/**
 * The addressable string for this route: the two-segment form when it is
 * the only route claiming this `(engine, model)` pair, else the fully
 * explicit three-segment form -- two sibling routes on one engine sharing a
 * model (different upstreams) would otherwise report the same `id` twice.
 */
function modelRowId(route: ResolvedRoute, siblingCount: number): string {
  if (route.model === undefined) {
    return `@/${route.engine}/${route.upstream}`;
  }
  if (siblingCount > 1 && route.upstream !== null) {
    return `@/${route.engine}/${route.upstream}/${route.model}`;
  }
  return `@/${route.engine}/${route.model}`;
}

/**
 * The engine-wide agentic proof (`EngineStatus.state`) only ever vouches for
 * the read-only floor -- a guarantee the pin carries regardless of which
 * upstream a route redirects to, so one proof legitimately covers every
 * route on the engine. A route's own resolvable-address question does not:
 * `@/claude/openrouter/sonnet-5` with no configured secret would otherwise
 * report `installed` right alongside a proven ambient route and fail on the
 * first real request. Checked here, per row, never folded into the shared
 * engine-wide state.
 */
async function agenticRouteState(
  ctx: DoorContext,
  route: ResolvedRoute,
  engineState: EngineState,
): Promise<EngineState> {
  if (
    engineState !== "installed" ||
    route.upstream === null ||
    route.upstream === "local" ||
    ctx.registry.get(route.engine)?.kind !== "agentic-cli"
  ) {
    return engineState;
  }
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === route.upstream);
  if (upstream === undefined) {
    return "unavailable";
  }
  const resolved = await resolveUpstreamSecret(upstream, ctx.doorOpts.secretExec);
  return resolved.ok ? engineState : "unavailable";
}

interface ModelRowOptions {
  route: ResolvedRoute;
  siblingCount: number;
  config: Config;
  statuses: ReadonlyMap<string, EngineStatus>;
}

async function modelRow(
  ctx: DoorContext,
  { route, siblingCount, config, statuses }: ModelRowOptions,
): Promise<ModelRow> {
  const status = statuses.get(route.engine);
  const state = await agenticRouteState(ctx, route, status?.state ?? "unavailable");
  return {
    id: modelRowId(route, siblingCount),
    engine: route.engine,
    upstream: route.upstream ?? undefined,
    model: route.model,
    egress: routeEgress(route, config),
    streaming: route.streaming ?? status?.streaming ?? false,
    tools: forwardsTools(status, route.role),
    serves: routeServes(route.role, status?.serves ?? []),
    state,
    capabilities: routeCapabilities(route),
  };
}

/**
 * Whether the door hands this route's upstream the request body it was
 * given, tool-calling fields and all. Only a chat-serving `openai-http`
 * route does: an agentic hop refuses the values that demand a tool call
 * (`unhonourableFields`), an embeddings route has no tool-call channel to
 * forward one down whatever its engine kind, and no other kind serves chat.
 * It says nothing about whether the upstream then honours them -- that
 * answer is the upstream's own.
 */
function forwardsTools(status: EngineStatus | undefined, role: Role | undefined): boolean {
  return (
    status?.kind === "openai-http" &&
    routeServes(role, status.serves).includes(CONTENT_ENDPOINT_CHAT)
  );
}

/** The same question for one `@/engine/model` hop, which carries its route's role only once resolved. Shared by the `models` menu and by the dispatch that decides whether refusing a tool call is terminal. */
function hopForwardsTools(
  hop: string,
  routes: Config["routes"],
  statusOf: (engineId: string) => EngineStatus | undefined,
): boolean {
  const { engine, upstream, model } = parseHop(hop);
  return forwardsTools(statusOf(engine), routeForHop(routes, engine, model, upstream)?.role);
}

/**
 * A chain is not any one engine's route, so it omits engine/upstream/model/
 * egress entirely. `streaming`, `state` and `capabilities` come from its
 * FIRST hop instead -- that is the hop that actually answers, the same rule
 * `classifyResult` uses to decide whether a chain keeps walking.
 *
 * `tools` is the exception, and takes EVERY hop: a fallback is precisely
 * when a tool call would otherwise land on an agent that cannot honour it,
 * so one such hop anywhere in the list makes the whole chain unsafe to send
 * a tool loop to.
 */
function chainRow(
  chainId: string,
  hops: readonly string[],
  config: Config,
  statuses: ReadonlyMap<string, EngineStatus>,
): ModelRow {
  const [firstHop] = hops;
  const hop = firstHop === undefined ? undefined : parseHop(firstHop);
  const route =
    hop === undefined
      ? undefined
      : findModelOnEngine(config.routes, hop.engine, hop.model, hop.upstream);
  const status = route === undefined ? undefined : statuses.get(route.engine);
  return {
    id: chainId,
    streaming: route?.streaming ?? status?.streaming ?? false,
    tools: hops.every((h) => hopForwardsTools(h, config.routes, (id) => statuses.get(id))),
    serves: [CONTENT_ENDPOINT_CHAT],
    state: status?.state ?? "unavailable",
    capabilities: route === undefined ? {} : routeCapabilities(route),
  };
}

/**
 * `GET /openai/v1/models`: every dispatchable address, as a row carrying its
 * own capabilities rather than a bare id -- async and authoritative, so
 * `state` reflects a real probe rather than the sync lifecycle cache.
 *
 * `comfy` is listed too, now that it has a real `serves` (the mediated
 * proxy's own paths, not a content endpoint): it is addressable like every
 * other engine, and this menu is the address book. `capabilities` is empty
 * for its row -- comfy has no `[[model]]` capability shape to report -- but
 * `serves` still tells a caller it does not speak chat, exactly as a
 * modelless audio engine's own `serves` (`/openai/v1/audio/speech`) does.
 */
async function modelsMenu(ctx: DoorContext): Promise<Response> {
  const config = ctx.getConfig();
  const { engines } = await ctx.registry.list();
  const statuses = new Map(engines.map((e) => [e.id, e]));
  const servedEngines = new Set(engines.filter((e) => e.serves.length > 0).map((e) => e.id));

  const rows: ModelRow[] = [];
  for (const route of config.routes) {
    if (route.disabled || !servedEngines.has(route.engine)) {
      continue;
    }
    const siblingCount =
      route.model === undefined
        ? 1
        : config.routes.filter(
            (r) => !r.disabled && r.engine === route.engine && r.model === route.model,
          ).length;
    rows.push(await modelRow(ctx, { route, siblingCount, config, statuses }));
  }
  for (const [chainId, hops] of Object.entries(config.chains)) {
    rows.push(chainRow(chainId, hops, config, statuses));
  }

  return Response.json({ object: "list", data: rows } satisfies ModelsResponse);
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
 */
function createDoorContext(
  getConfig: () => Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions,
): DoorContext {
  const lifecycle =
    registryOpts.lifecycle ??
    new DockerLifecycle(registryOpts.exec ?? dockerExec, registryOpts.probe);
  const registry = new EngineRegistry(getConfig(), {
    ...registryOpts,
    lifecycle,
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
    launchNonces: new Set(),
    comfyBindings: loadComfyBindings(),
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
