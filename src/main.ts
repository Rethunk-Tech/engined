/** The door: dual-family `Bun.serve`, Origin/Host check, OpenAI-shaped routes. */

import { mkdirSync } from 'node:fs'
import process from 'node:process'
import { LAUNCH_NONCE_RE } from './agentic.ts'
import { buildAgenticProbeRunner } from './agenticProbeHarness.ts'
import { MAX_AUDIO_UPLOAD_BYTES } from './audioDoorTranscribe.ts'
import { loadComfyBindings } from './comfyBindings.ts'
import {
  COMFY_WS_SUFFIX,
  type ComfyWsData,
  type EnginedServer,
  matchComfyPath,
} from './comfyProxy.ts'
import { comfyWebSocketHandlers, handleComfyProxy, handleComfyWsUpgrade } from './comfyRoutes.ts'
import { loadConfig } from './config.ts'
import { handleContent, handleEngineEvents, handleExtras } from './content.ts'
import {
  handleEngines,
  handleHold,
  handleLogs,
  handleRelease,
  handleResources,
  handleStart,
  handleStop,
  handleUnhold,
} from './control.ts'
import { serveCursorAgent } from './cursorAgent.ts'
import { completeLocally } from './cursorChat.ts'
import { handleCursor, isCursorPath } from './cursorDoor.ts'
import { DockerLifecycle, dockerExec } from './docker.ts'
import type { DoorContext, DoorOptions } from './doorContext.ts'
import { EngineRegistry } from './engines.ts'
import { FatalError } from './errors/fatal.ts'
import {
  jsonError,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
} from './http.ts'
import { Inventory } from './inventory.ts'
import { modelsMenu } from './modelsMenu.ts'
import { configPath, installDir, voicesDir } from './paths.ts'
import { runProbes } from './probe.ts'
import { writeToStdout } from './provenance.ts'
import { errMessage } from './records.ts'
import type { RegistryOptions } from './registryOptions.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
  OPENAI_MODELS_PATH,
} from './routeServes.ts'
import { handleTokenizeRoute, TOKENIZE_PATH } from './tokenizeRoute.ts'
import type { Config } from './types.ts'
import { ENGINED_ENGINES_PATH, handleUsage, USAGE_PATH, UsageTracker } from './usage.ts'
import { handleVoiceUpload, VOICE_UPLOAD_PATH } from './voices.ts'

const CONTENT_ENDPOINTS = new Set([
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_EMBEDDINGS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_RERANK,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
])

/** The address-keyed start route. An engine id is not a place, so there is no per-engine sibling. */
const START_PATH = '/engined/v1/start'
/** `/engined/v1/engines/<id>/<verb>`. Capture 1 is the id; extras add a second. */
function engineVerbRe(verb: string): RegExp {
  return new RegExp(`^${ENGINED_ENGINES_PATH}/([^/]+)/${verb}$`)
}
const STOP_RE = engineVerbRe('stop')
const LOGS_RE = engineVerbRe('logs')
const RESOURCES_RE = engineVerbRe('resources')
const RELEASE_RE = engineVerbRe('release')
const HOLD_RE = engineVerbRe('hold')
const UNHOLD_RE = engineVerbRe('unhold')

/** As `URL#hostname` reports them: no port; an IPv6 literal keeps its brackets. */
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Origin/Host refusals are 403 and carry no engine detail: the caller failed the door, not an engine. */
function refuse(message: string): Response {
  return jsonError(STATUS_FORBIDDEN, message)
}

function isLoopbackHost(hostHeader: string, port: number): boolean {
  try {
    const url = new URL(`http://${hostHeader}`)
    const effectivePort = url.port === '' ? '80' : url.port
    return LOOPBACK_HOSTNAMES.has(url.hostname) && effectivePort === String(port)
  } catch {
    return false
  }
}

/** Any `Origin` is refused, including `"null"`. No Origin (CLI/server) is unaffected. */
function checkOrigin(req: Request, port: number): Response | null {
  if (req.headers.get('Origin') !== null) {
    return refuse('cross-origin requests are refused')
  }
  const host = req.headers.get('Host')
  if (host !== null && !isLoopbackHost(host, port)) {
    return refuse(`Host "${host}" is outside the loopback set`)
  }
  return null
}

/** The llama.cpp routes proxied straight through: always the one local llama engine. */
const EXTRAS_RE = engineVerbRe('(tokenize|apply-template)')

export interface Door {
  /** One-arg callers always get a `Response`; `server` is only for the comfy websocket upgrade. */
  fetch: {
    (req: Request): Response | Promise<Response>
    (req: Request, server: EnginedServer): Response | Promise<Response> | undefined
  }
  /** Re-reads `path`. Invalid TOML keeps the running config and records the error. */
  reload: (path: string) => void
  registry: EngineRegistry
  /** The live door state, so a sibling listener reads the same config a reload swapped in. */
  ctx: DoorContext
  configError: () => string | undefined
}

function routeGet(
  ctx: DoorContext,
  url: URL,
  configErr: string | undefined,
  signal: AbortSignal,
): Response | Promise<Response> | undefined {
  const { pathname } = url
  if (pathname === OPENAI_MODELS_PATH) {
    return modelsMenu(ctx)
  }
  if (pathname === ENGINED_ENGINES_PATH) {
    return handleEngines(ctx, configErr)
  }
  if (pathname === `${ENGINED_ENGINES_PATH}/events`) {
    return handleEngineEvents(ctx, signal)
  }
  if (pathname === USAGE_PATH) {
    return handleUsage(ctx, url)
  }
  const logsMatch = pathname.match(LOGS_RE)?.[1]
  if (logsMatch !== undefined) {
    return handleLogs(ctx.registry, logsMatch, url)
  }
  const resourcesMatch = pathname.match(RESOURCES_RE)?.[1]
  if (resourcesMatch !== undefined) {
    return handleResources(ctx.registry, resourcesMatch)
  }
  return undefined
}

function routePost(
  ctx: DoorContext,
  req: Request,
  pathname: string,
  launchScoped: boolean,
): Response | Promise<Response> | undefined {
  if (isCursorPath(pathname)) {
    return handleCursor(ctx, req, pathname)
  }
  if (pathname === START_PATH) {
    return handleStart(ctx, req)
  }
  if (pathname === TOKENIZE_PATH) {
    return handleTokenizeRoute(ctx, req)
  }
  const stopMatch = pathname.match(STOP_RE)?.[1]
  if (stopMatch !== undefined) {
    return handleStop(ctx.registry, stopMatch)
  }
  const releaseMatch = pathname.match(RELEASE_RE)?.[1]
  if (releaseMatch !== undefined) {
    return handleRelease(ctx.registry, releaseMatch)
  }
  const holdMatch = pathname.match(HOLD_RE)?.[1]
  if (holdMatch !== undefined) {
    return handleHold(ctx.registry, holdMatch, new URL(req.url))
  }
  const unholdMatch = pathname.match(UNHOLD_RE)?.[1]
  if (unholdMatch !== undefined) {
    return handleUnhold(ctx.registry, unholdMatch)
  }
  if (pathname === VOICE_UPLOAD_PATH) {
    return handleVoiceUpload(req)
  }
  if (CONTENT_ENDPOINTS.has(pathname)) {
    return handleContent(ctx, req, pathname, launchScoped)
  }
  const extras = pathname.match(EXTRAS_RE)
  if (extras?.[1] !== undefined && extras[2] !== undefined) {
    return handleExtras(ctx, req, extras[1], extras[2])
  }
  return undefined
}

/**
 * Launch-scoped `/openai/v1/<nonce>/...` matches the public door; `null` is an
 * unknown or expired nonce. The nonce is minted at launch and never durable.
 */
function stripLaunchNonce(
  ctx: DoorContext,
  pathname: string,
): { pathname: string; launchScoped: boolean } | null {
  const match: RegExpExecArray | null = LAUNCH_NONCE_RE.exec(pathname)
  if (!match) {
    return { pathname, launchScoped: false }
  }
  const [, nonce, rest] = match
  if (nonce === undefined || !ctx.launchNonces.has(nonce)) {
    return null
  }
  return { pathname: `/openai/v1${rest}`, launchScoped: true }
}

function routeRequest(
  ctx: DoorContext,
  req: Request,
  configErr: string | undefined,
): Response | Promise<Response> {
  const url = new URL(req.url)
  const stripped = stripLaunchNonce(ctx, url.pathname)
  if (stripped === null) {
    return refuse('this launch-scoped URL is unknown or has expired')
  }
  const { pathname, launchScoped } = stripped
  const comfyMatch = matchComfyPath(pathname)
  if (comfyMatch) {
    return handleComfyProxy(ctx, req, comfyMatch)
  }
  let matched: Response | Promise<Response> | undefined
  if (req.method === 'GET') {
    matched = routeGet(ctx, new URL(pathname + url.search, url), configErr, req.signal)
  } else if (req.method === 'POST') {
    matched = routePost(ctx, req, pathname, launchScoped)
  }
  return matched ?? jsonError(STATUS_NOT_FOUND, 'not found')
}

/** One LlamaRouter per llama engine, sharing this door's `lifecycle` and `launchNonces`. */
function createDoorContext(
  getConfig: () => Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions,
): DoorContext {
  const lifecycle =
    registryOpts.lifecycle ??
    new DockerLifecycle(registryOpts.exec ?? dockerExec, registryOpts.probe)
  const launchNonces = new Set<string>()
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
  })
  return {
    getConfig,
    registry,
    lifecycle,
    registryOpts,
    doorOpts,
    llamaRouters: new Map(),
    staleLlamaRouters: new Set(),
    launchNonces,
    agenticInFlight: 0,
    comfyBindings: loadComfyBindings(),
    comfySlots: new Map(),
    usage: new UsageTracker({ stateRoot: doorOpts.usageStateRoot, now: doorOpts.usageNow }),
  }
}

export function createDoor(
  initialConfig: Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions = {},
): Door {
  let config = initialConfig
  let configErr: string | undefined
  const ctx = createDoorContext(() => config, registryOpts, doorOpts)
  const { registry } = ctx

  function reload(path: string): void {
    try {
      const next = loadConfig(path)
      config = next
      configErr = undefined
      registry.reload(next)
      // Mark every cached router stale rather than dropping it: an
      // in-flight request already holds a direct reference to its old
      // instance regardless, but a NEW request must not get a second,
      // ignorant occupancy tracker over the same still-running container
      // while the old one still has a lease outstanding.
      for (const id of ctx.llamaRouters.keys()) {
        ctx.staleLlamaRouters.add(id)
      }
    } catch (err) {
      configErr = errMessage(err)
    }
  }

  // Two declared overloads plus a wider implementation signature: the
  // standard TS pattern for one function body that must expose a NARROWER
  // type to its one-argument callers (every test in this repo) than what it
  // is actually capable of returning when a real `server` is supplied.
  function fetch(req: Request): Response | Promise<Response>
  function fetch(req: Request, server: EnginedServer): Response | Promise<Response> | undefined
  function fetch(req: Request, server?: EnginedServer): Response | Promise<Response> | undefined {
    try {
      const refusal = checkOrigin(req, config.listen_port)
      if (refusal) {
        return refusal
      }
      // A real websocket upgrade is intercepted here, ahead of ordinary
      // routing: `server` exists only when bound through a real `Bun.serve`
      // (see `bindDualFamily`), which is the one thing a plain request/response
      // handler cannot do on its own.
      if (server !== undefined) {
        const wsMatch = matchComfyPath(new URL(req.url).pathname)
        if (wsMatch?.rest === COMFY_WS_SUFFIX) {
          const upgraded = handleComfyWsUpgrade(ctx, req, server, wsMatch)
          if (upgraded instanceof Promise) {
            return upgraded.catch((err: unknown) =>
              jsonError(STATUS_INTERNAL_SERVER_ERROR, errMessage(err)),
            )
          }
          return upgraded
        }
      }
      const routed = routeRequest(ctx, req, configErr)
      if (routed instanceof Promise) {
        return routed.catch((err: unknown) =>
          jsonError(STATUS_INTERNAL_SERVER_ERROR, errMessage(err)),
        )
      }
      return routed
    } catch (err) {
      return jsonError(STATUS_INTERNAL_SERVER_ERROR, errMessage(err))
    }
  }

  return { fetch, reload, registry, ctx, configError: () => configErr }
}

/**
 * The door's real listener setup: both loopback families bound to the same
 * port. Exported so a test can bind through this exact code rather than a
 * hand-rolled `Bun.serve` pair that would pass even if the `::1` listener
 * were deleted here.
 */
export function bindDualFamily(
  fetch: Door['fetch'],
  port: number,
): { v4: EnginedServer; v6: EnginedServer } {
  // `idleTimeout: 0`: Bun's default 10s timer closes with no body, and Bun
  // rejects a value above 255, below `chat_timeout_seconds`. The hop budget
  // is engined's. `websocket` is the comfy proxy upgrade only.
  const serveOpts = {
    fetch,
    error(err: Error) {
      return jsonError(STATUS_INTERNAL_SERVER_ERROR, errMessage(err))
    },
    idleTimeout: 0,
    maxRequestBodySize: MAX_AUDIO_UPLOAD_BYTES,
    websocket: comfyWebSocketHandlers,
  } as const
  const v4 = Bun.serve<ComfyWsData>({ hostname: '127.0.0.1', port, ...serveOpts })
  const v6 = Bun.serve<ComfyWsData>({ hostname: '::1', port: v4.port, ...serveOpts })
  return { v4, v6 }
}

/** Absolute bunx from `ENGINED_BUNX` or PATH, resolved at startup so a miss is fatal immediately. */
export function resolveBunx(
  env: NodeJS.ProcessEnv = process.env,
  which: (cmd: string) => string | null = Bun.which,
): string {
  const configured = env.ENGINED_BUNX
  if (configured !== undefined && configured !== '') {
    return configured
  }
  const onPath = which('bunx')
  if (onPath !== null) {
    return onPath
  }
  throw new FatalError(
    'ENGINED_BUNX is not set and no "bunx" was found on PATH -- the --user unit always sets ENGINED_BUNX (scripts/engined.service.in); a working-tree dev run needs bunx on PATH instead',
  )
}

/** `main.js --probe`: call the already-serving door; never bind a second one. */
async function probeExit(): Promise<number> {
  let port: number
  try {
    port = loadConfig().listen_port
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`)
    return FatalError.EXIT_CODE
  }
  const report = await runProbes(`http://127.0.0.1:${port}`)
  for (const line of report.lines) {
    writeToStdout(`${line.ok ? 'ok' : 'FAIL'} ${line.address}: ${line.detail}`)
  }
  return report.ok ? 0 : 1
}
if (import.meta.main) {
  // Before anything that binds or starts: this mode talks to the door that is
  // already running, so creating one here would take the port from it.
  if (process.argv.includes('--probe')) {
    process.exit(await probeExit())
  }
  let startupConfig: Config
  let door: Door
  // `createDoor` loads every engine spec eagerly, so a `ParseError` from an
  // unresolved placeholder lands here and not at the first request. It shares
  // the config path's exit code because a restart fixes neither, and escaping
  // this block uncaught would exit 1 and put the unit in a restart loop.
  // `resolveBunx` throwing lands here too, for the same reason.
  try {
    const bunx = resolveBunx()
    startupConfig = loadConfig()
    // The mount source a chatterbox spec names must exist before any
    // container starts: docker creates a missing bind source itself, owned by
    // root, and the door would then never be able to write an upload into it.
    mkdirSync(voicesDir(), { recursive: true })
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
    })
  } catch (err) {
    process.stderr.write(`${errMessage(err)}\n`)
    process.exit(FatalError.EXIT_CODE)
  }

  let bound: { v4: EnginedServer; v6: EnginedServer }
  try {
    bound = bindDualFamily(door.fetch, startupConfig.listen_port)
    door.registry.startInventoryRefresh()
  } catch (err) {
    const message = errMessage(err)
    process.stderr.write(`port ${startupConfig.listen_port} already in use: ${message}\n`)
    process.exit(FatalError.EXIT_CODE)
  }

  // Cursor's turn stream needs HTTP/2, so it listens beside the door.
  const cursorAgent = serveCursorAgent(startupConfig.cursor_port, {
    complete: (messages, on) => completeLocally(door.ctx, messages, on),
  })

  process.on('SIGHUP', () => door.reload(configPath()))

  process.on('SIGTERM', () => {
    door.registry
      .shutdown()
      .catch(() => undefined)
      .finally(() => {
        door.ctx.usage.shutdown()
        cursorAgent.stop()
        bound.v4.stop()
        bound.v6.stop()
        process.exit(0)
      })
  })
}
