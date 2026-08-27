/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  type AgenticSpawn,
  buildAgenticProbeRunner,
  defaultAgenticSpawn,
  runAgentic,
} from "./agentic.ts";
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
import { type HttpClient, LlamaRouter, reportedModelFrom } from "./llama.ts";
import { configPath, installDir } from "./paths.ts";
import { recordCall } from "./provenance.ts";
import { resolveSecret, type Exec as SecretExec } from "./secrets.ts";
import { loadSpec } from "./spec.ts";
import { type Config, type EngineEntry, type EngineKind, FatalError } from "./types.ts";

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

/**
 * `rawBody.model` is whatever the caller's own request named -- a chain
 * name, an alias, anything -- never necessarily this hop's resolved model
 * id, so it is overwritten rather than forwarded verbatim. `workdir` is
 * stripped as before; every other caller-supplied field passes through.
 */
function llamaRequestInit(
  rawBody: Record<string, unknown>,
  resolvedModelId: string,
  signal: AbortSignal,
): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
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
  const model = ctx
    .getConfig()
    .models.find((m) => m.engine === engineEntry.id && m.id === modelSeg);
  if (!model) {
    return {
      status: 502,
      body: { error: `model "${modelSeg}" not found on "${engineEntry.id}"` },
    };
  }
  const router = getLlamaRouter(ctx, engineEntry);
  // Both fetchBuffered and fetchStreamed take this same `init`, so
  // rewriting `model` once here fixes both proxy paths.
  const init = llamaRequestInit(req.rawBody, model.id, req.signal);
  const response = await router.proxy(model, req.pathname, init);
  const contentType = response.headers.get("content-type") ?? "application/json";
  req.setContentType(contentType);
  // A buffered JSON response is parsed from a clone, so the caller's own read
  // stays untouched. An SSE body cannot be buffered the same way — those
  // bytes are already owed to the caller as they arrive — so it is teed
  // instead: one branch goes back to the caller unread, the other is sniffed
  // only far enough to find the first `data:` frame's model id.
  let callerStream: ReadableStream<Uint8Array> | undefined;
  let modelReported: string | undefined;
  if (contentType.includes("application/json")) {
    // `.clone()` before `.body` is ever touched: reading the getter first
    // disturbs the body Bun's clone() then tees from.
    modelReported = reportedModelFrom(
      await response
        .clone()
        .json()
        .catch(() => undefined),
    );
    callerStream = response.body ?? undefined;
  } else if (contentType.includes("text/event-stream") && response.body) {
    const [forCaller, forSniff] = response.body.tee();
    callerStream = forCaller;
    modelReported = await firstReportedModel(forSniff);
  } else {
    callerStream = response.body ?? undefined;
  }
  // Per attempt, from the engine's own /v1/models — never the router's cached
  // command bookkeeping, and never model_reported: the two answer different
  // questions and one silently standing in for the other defeats provenance.
  const modelResident =
    model.role === undefined ? undefined : await router.residentModelId(model.role);
  return {
    status: response.status,
    stream: callerStream,
    modelReported,
    modelResident,
  };
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
  const id = engineEntry.base_url === undefined ? engineEntry.id : SHIPPED_CLAUDE_ID;
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

/** The configured id verbatim — never invented, never stripped — resolved through aliases the same way a chat model is. */
function resolveAgenticModelId(
  config: Config,
  engineId: string,
  modelSeg: string,
): string | undefined {
  if (modelSeg === "") {
    return;
  }
  const found = config.models.find(
    (m) => m.engine === engineId && (m.id === modelSeg || m.aliases.includes(modelSeg)),
  );
  return found?.id ?? modelSeg;
}

export type RedirectResolution =
  | { ok: true; env: Record<string, string> }
  | { ok: false; result: HopResult };

/**
 * Resolved per request, never cached — a `--user` unit boots before the
 * login keyring unlocks, and this engine must recover at the operator's
 * next sign-in without a reload. A failure is a 5xx: `runChain` advances
 * past a dead engine rather than failing every consumer of the chain for
 * one unconfigured remote key, and a lone request to just this engine
 * surfaces the fix command directly. The resolved value only ever reaches
 * the child's environment below — never a log line, an error body, or
 * anything this function returns.
 */
/**
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
  if (!engineEntry.secret) {
    return {
      ok: false,
      result: {
        status: 502,
        body: { error: `engine "${engineEntry.id}" is a remote address with no configured secret` },
      },
    };
  }
  const outcome = await resolveSecret(engineEntry.secret, secretExec);
  if (!outcome.ok) {
    return {
      ok: false,
      result: { status: 503, body: { error: outcome.fix } },
    };
  }
  const model = resolveAgenticModelId(config, engineEntry.id, modelSeg);
  return { ok: true, env: redirectEnv(engineEntry.base_url as string, outcome.value, model) };
}

/** `runAgentic`'s outcome, mapped to a hop's result. `version` is carried through either way -- a failed launch still ran a real, pinned process. */
function hopResultFromAgenticOutcome(outcome: Awaited<ReturnType<typeof runAgentic>>): HopResult {
  if (!outcome.ok) {
    return {
      status: outcome.status,
      body: { error: outcome.failure ?? "agentic call failed" },
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
async function execAgentic(
  ctx: DoorContext,
  engineId: string,
  modelSeg: string,
  req: { rawBody: Record<string, unknown>; signal: AbortSignal },
): Promise<HopResult> {
  const { rawBody, signal } = req;
  const config = ctx.getConfig();
  const engineEntry = config.engines.find((e) => e.id === engineId);
  if (!engineEntry) {
    return { status: 502, body: { error: `unknown engine "${engineId}"` } };
  }
  if (engineEntry.claude_version === undefined) {
    return {
      status: 502,
      body: { error: `engine "${engineId}" has no claude_version configured` },
    };
  }

  let extraEnv: Record<string, string> | undefined;
  if (engineEntry.base_url !== undefined) {
    const redirect = await resolveRedirect(engineEntry, modelSeg, config, ctx.doorOpts.secretExec);
    if (!redirect.ok) {
      return redirect.result;
    }
    extraEnv = redirect.env;
  }

  const loaded = loadAgenticSpec(ctx, engineEntry);
  const workdir = typeof rawBody.workdir === "string" ? rawBody.workdir : undefined;
  // The workdir-required 400 is a request-shape rejection the caller owns;
  // it fires before an engine-availability check the server owns.
  if (workdir !== undefined && workdir !== "") {
    const proof = await ctx.registry.start(engineId);
    if (proof.state !== "installed") {
      // A plain 503, matching resolveRedirect's own secret-resolution
      // failure above: an engine that cannot prove its pin is unavailable,
      // not a proven envelope failure, so a chain skips it (TODO.md's own
      // rule) rather than treating it as terminal.
      return {
        status: 503,
        body: { error: proof.fix ?? `engine "${engineId}" is not installed` },
      };
    }
  }
  const outcome = await runAgentic({
    claudeVersion: engineEntry.claude_version,
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

function buildHopExec(ctx: DoorContext, req: HopRequest): HopExec {
  return async (hop, signal) => {
    const { engine: seg, model: modelSeg } = parseHopSegments(hop);
    const engineId = resolveEngineSegment(seg, ctx.getConfig()) ?? seg;
    const kind = ctx.registry.get(engineId)?.kind;
    if (kind === "agentic-cli") {
      return await execAgentic(ctx, engineId, modelSeg, { rawBody: req.rawBody, signal });
    }
    const engineEntry = ctx.getConfig().engines.find((e) => e.id === engineId);
    if (kind === "openai-http" && engineEntry) {
      return await execLlama(ctx, engineEntry, modelSeg, { ...req, signal });
    }
    return {
      status: 502,
      body: { error: `engine "${engineId}" of kind "${kind}" cannot serve this request` },
    };
  };
}

/**
 * The budget for one hop, keyed on THAT hop's own engine kind -- never on
 * whether the request happens to be a chain, and never on any other hop
 * sharing it. `chat_timeout_seconds` is scoped to one engine,
 * per attempt; an all-local-llama chain must not inherit the long agentic
 * budget just because a chain is, in general, allowed to contain agentic
 * hops.
 */
export function timeoutSecondsForKind(kind: EngineKind | undefined, config: Config): number {
  return kind === "agentic-cli" ? config.agent_timeout_seconds : config.chat_timeout_seconds;
}

function chatTimeoutMs(ctx: DoorContext): (hop: string) => number {
  const config = ctx.getConfig();
  return (hop) => {
    const { engine: seg } = parseHopSegments(hop);
    const engineId = resolveEngineSegment(seg, config) ?? seg;
    return timeoutSecondsForKind(ctx.registry.get(engineId)?.kind, config) * MS_PER_SECOND;
  };
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
    timeoutMs: chatTimeoutMs(ctx),
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

/**
 * The audio door proxies a single buffered request per call, with no
 * multi-lease concept like `LlamaRouter`'s roles: unlike Comfy, this is
 * request traffic engined does see, so idle-stop arms right here rather than
 * off a queue poll. A no-op if the start attempt never reached "running".
 */
function armAudioIdleStop(ctx: DoorContext, engineId: string): void {
  const engine = ctx.getConfig().engines.find((e) => e.id === engineId);
  ctx.lifecycle.endLease(engineId, engine?.idle_stop_seconds ?? DEFAULT_IDLE_STOP_SECONDS);
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
  armAudioIdleStop(ctx, engineId);
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
  armAudioIdleStop(ctx, engineId);
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
      configErr = err instanceof Error ? err.message : String(err);
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
 * carry at all. A bare-string fallback here used to be silently truthy no
 * matter what, which made `agentic.ts:117`'s own "bunx is unresolved" guard
 * dead code in production -- a unit that lost the env var failed late, at
 * exec inside a spawned child, instead of loudly at startup.
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
      agenticProbeRunner: buildAgenticProbeRunner(bunx),
    });
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  let bound: { v4: ReturnType<typeof Bun.serve>; v6: ReturnType<typeof Bun.serve> };
  try {
    bound = bindDualFamily(door.fetch, startupConfig.listen_port);
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
        bound.v4.stop();
        bound.v6.stop();
        process.exit(0);
      });
  });
}
