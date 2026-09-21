/**
 * The door: `Bun.serve` bound on both loopback families, the Origin/Host
 * check every request passes through first, and the OpenAI-shaped routes.
 * `createDoor` is the testable half — request handling and SIGHUP reload
 * with no socket involved; the `import.meta.main` block below is the actual
 * process: binds, signal handlers, and the fatal-at-startup exit.
 */

import { mkdirSync } from "node:fs";
import process from "node:process";
import { buildAgenticProbeRunner } from "./agenticProbeHarness.ts";
import { loadComfyBindings } from "./comfyBindings.ts";
import {
  COMFY_WS_SUFFIX,
  type ComfyWsData,
  type EnginedServer,
  matchComfyPath,
} from "./comfyProxy.ts";
import { comfyWebSocketHandlers, handleComfyProxy, handleComfyWsUpgrade } from "./comfyRoutes.ts";
import { loadConfig } from "./config.ts";
import { handleContent, handleEngineEvents, handleExtras } from "./content.ts";
import {
  handleEngines,
  handleHold,
  handleLogs,
  handleRelease,
  handleResources,
  handleStart,
  handleStop,
  handleUnhold,
} from "./control.ts";
import { serveCursorAgent } from "./cursorAgent.ts";
import { chatModels, handleCursor, isCursorPath } from "./cursorDoor.ts";
import { TOOL_SCHEMA } from "./cursorExec.ts";
import { DockerLifecycle, dockerExec } from "./docker.ts";
import type { DoorContext, DoorOptions } from "./doorContext.ts";
import { EngineRegistry, type RegistryOptions } from "./engines.ts";
import { FatalError } from "./errors/fatal.ts";
import { jsonError, STATUS_FORBIDDEN, STATUS_NOT_FOUND } from "./http.ts";
import { Inventory } from "./inventory.ts";
import { modelsMenu } from "./modelsMenu.ts";
import { configPath, installDir, voicesDir } from "./paths.ts";
import { runProbes } from "./probe.ts";
import { writeToStdout } from "./provenance.ts";
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  type Config,
  errMessage,
} from "./types.ts";
import { handleVoiceUpload, VOICE_UPLOAD_PATH } from "./voices.ts";

const CONTENT_ENDPOINTS = new Set([
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
]);

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
/**
 * `/engined/v1/engines/<id>/<verb>`, the shape every per-engine verb shares:
 * written once so a path that drifts drifts for all of them at once. The id
 * is capture 1; a `verb` carrying its own group (the extras route) adds a
 * second.
 */
function engineVerbRe(verb: string): RegExp {
  return new RegExp(`^/engined/v1/engines/([^/]+)/${verb}$`);
}
const STOP_RE = engineVerbRe("stop");
const LOGS_RE = engineVerbRe("logs");
const RESOURCES_RE = engineVerbRe("resources");
const RELEASE_RE = engineVerbRe("release");
const HOLD_RE = engineVerbRe("hold");
const UNHOLD_RE = engineVerbRe("unhold");

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

/** The llama.cpp routes proxied straight through: always the one local llama engine. */
const EXTRAS_RE = engineVerbRe("(tokenize|apply-template)");

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
  /** The live door state, so a sibling listener reads the same config a reload swapped in. */
  ctx: DoorContext;
  configError: () => string | undefined;
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
  const logsMatch = pathname.match(LOGS_RE)?.[1];
  if (logsMatch !== undefined) {
    return handleLogs(ctx.registry, logsMatch, url);
  }
  const resourcesMatch = pathname.match(RESOURCES_RE)?.[1];
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
  if (isCursorPath(pathname)) {
    return handleCursor(ctx, req, pathname);
  }
  if (pathname === START_PATH) {
    return handleStart(ctx, req);
  }
  const stopMatch = pathname.match(STOP_RE)?.[1];
  if (stopMatch !== undefined) {
    return handleStop(ctx.registry, stopMatch);
  }
  const releaseMatch = pathname.match(RELEASE_RE)?.[1];
  if (releaseMatch !== undefined) {
    return handleRelease(ctx.registry, releaseMatch);
  }
  const holdMatch = pathname.match(HOLD_RE)?.[1];
  if (holdMatch !== undefined) {
    return handleHold(ctx.registry, holdMatch, new URL(req.url));
  }
  const unholdMatch = pathname.match(UNHOLD_RE)?.[1];
  if (unholdMatch !== undefined) {
    return handleUnhold(ctx.registry, unholdMatch);
  }
  if (pathname === VOICE_UPLOAD_PATH) {
    return handleVoiceUpload(req);
  }
  if (CONTENT_ENDPOINTS.has(pathname)) {
    return handleContent(ctx, req, pathname, launchScoped);
  }
  const extras = pathname.match(EXTRAS_RE);
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
  const match: RegExpExecArray | null = LAUNCH_NONCE_RE.exec(pathname);
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
    inventory:
      registryOpts.inventory ??
      new Inventory({
        fetch: doorOpts.inventoryHttpClient,
        secretExec: doorOpts.secretExec,
      }),
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

  return { fetch, reload, registry, ctx, configError: () => configErr };
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
 * `main.js --probe`: a one-shot run of every acceptance probe against the
 * door this install is already serving, which is why it never
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
async function probeExit(): Promise<number> {
  let port: number;
  try {
    port = loadConfig().listen_port;
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`);
    return FatalError.EXIT_CODE;
  }
  const report = await runProbes(`http://127.0.0.1:${port}`);
  for (const line of report.lines) {
    writeToStdout(`${line.ok ? "ok" : "FAIL"} ${line.address}: ${line.detail}`);
  }
  return report.ok ? 0 : 1;
}
if (import.meta.main) {
  // Before anything that binds or starts: this mode talks to the door that is
  // already running, so creating one here would take the port from it.
  if (process.argv.includes("--probe")) {
    process.exit(await probeExit());
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
    door.registry.startInventoryRefresh();
  } catch (err) {
    const message = errMessage(err);
    process.stderr.write(`port ${startupConfig.listen_port} already in use: ${message}\n`);
    process.exit(FatalError.EXIT_CODE);
  }

  // The Cursor turn stream needs HTTP/2, so it listens beside the door
  // rather than on it. It dials the box's own chat route back through the
  // door's OpenAI surface, which is the same path every other consumer takes.
  const cursorAgent = serveCursorAgent(startupConfig.cursor_port, {
    complete: async (messages) => {
      const ctx = door.ctx;
      const model = chatModels(ctx)[0];
      if (model === undefined) {
        return { text: "engined: no llama chat route is configured", toolCalls: [] };
      }
      const res = await fetch(
        `http://127.0.0.1:${ctx.getConfig().listen_port}/openai/v1/chat/completions`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: `@/llama/${model}`, messages, tools: TOOL_SCHEMA }),
        },
      );
      if (!res.ok) {
        return { text: `engined: chat route ${model} answered ${res.status}`, toolCalls: [] };
      }
      const body = (await res.json()) as {
        choices?: {
          message?: {
            content?: string;
            reasoning_content?: string;
            tool_calls?: {
              id: string;
              type: "function";
              function: { name: string; arguments: string };
            }[];
          };
        }[];
        usage?: {
          prompt_tokens?: number;
          completion_tokens?: number;
          prompt_tokens_details?: { cached_tokens?: number };
        };
      };
      const choice = body.choices?.[0]?.message;
      const used = body.usage;
      return {
        text: choice?.content || choice?.reasoning_content || "",
        toolCalls: choice?.tool_calls ?? [],
        // The CLI reports a turn's cost from what this door tells it, so an
        // unreported round is a round that never happened as far as any
        // accounting downstream is concerned.
        usage: {
          input: used?.prompt_tokens ?? 0,
          output: used?.completion_tokens ?? 0,
          cacheRead: used?.prompt_tokens_details?.cached_tokens ?? 0,
        },
      };
    },
  });

  process.on("SIGHUP", () => door.reload(configPath()));

  process.on("SIGTERM", () => {
    door.registry
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        cursorAgent.stop();
        bound.v4.stop();
        bound.v6.stop();
        process.exit(0);
      });
  });
}
