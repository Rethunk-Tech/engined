/** The door: dual-family `Bun.serve`, Origin/Host check, OpenAI-shaped routes. */
import process from 'node:process'
import { resetSpeechCache } from './audioSpeech.ts'
import { loadComfyBindings } from './comfyBindings.ts'
import { COMFY_WS_SUFFIX, type EnginedServer, matchComfyPath } from './comfyProxy.ts'
import { handleComfyProxy, handleComfyWsUpgrade } from './comfyRoutes.ts'
import { loadConfig } from './config.ts'
import { configFilesSha256 } from './configSources.ts'
import { handleContent, handleEngineEvents, handleExtras } from './content.ts'
import {
  type ConfigFault,
  handleEngines,
  handleLogs,
  handleResources,
  handleStart,
} from './control.ts'
import { handleCursor, isCursorPath } from './cursorDoor.ts'
import { runDaemon } from './daemon.ts'
import { DockerLifecycle, dockerExec } from './docker.ts'
import { type Door, type DoorContext, type DoorOptions, retireLlamaRouters } from './doorContext.ts'
import { EngineRegistry } from './engines.ts'
import { isEngineVerbPath, routeEngineVerb } from './engineVerbs.ts'
import { ambientEnv } from './env.ts'
import { FatalError } from './errors/fatal.ts'
import { extraModeExit } from './extraModes.ts'
import {
  headOf,
  jsonError,
  methodNotAllowed,
  STATUS_FORBIDDEN,
  STATUS_INTERNAL_SERVER_ERROR,
  STATUS_NOT_FOUND,
  STATUS_UNAVAILABLE,
} from './http.ts'
import { IMAGE_GET_RE, responseForImageGet } from './imageStore.ts'
import { Inventory } from './inventory.ts'
import { LAUNCH_NONCE_RE } from './launchNonce.ts'
import { ModelDiscovery } from './modelDiscovery.ts'
import { modelById, modelsMenu } from './modelsMenu.ts'
import { DonorLedger } from './potluck.ts'
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
import { refuseMovedPorts, type ServedPorts } from './servedPorts.ts'
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
const START_PATH = '/engined/v1/start'
function engineVerbRe(verb: string): RegExp {
  return new RegExp(`^${ENGINED_ENGINES_PATH}/([^/]+)/${verb}$`)
}
const LOGS_RE = engineVerbRe('logs')
const RESOURCES_RE = engineVerbRe('resources')
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

/** Any `Origin` is refused, including `"null"`. A present `Sec-Fetch-Site` other than `none`/`same-origin` is refused the same way: a no-cors GET carries no Origin. No Origin and no Sec-Fetch-Site (CLI/server) is unaffected. */
function checkOrigin(req: Request, port: number): Response | null {
  const site = req.headers.get('Sec-Fetch-Site')
  if (
    req.headers.get('Origin') !== null ||
    (site !== null && site !== 'none' && site !== 'same-origin')
  ) {
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

export type { Door }

function routeGet(
  ctx: DoorContext,
  url: URL,
  fault: ConfigFault | undefined,
  signal: AbortSignal,
): Response | Promise<Response> | undefined {
  const { pathname } = url
  if (pathname === OPENAI_MODELS_PATH) {
    return modelsMenu(ctx)
  }
  if (pathname.startsWith(`${OPENAI_MODELS_PATH}/`)) {
    return modelById(ctx, decodeURIComponent(pathname.slice(OPENAI_MODELS_PATH.length + 1)))
  }
  if (pathname === ENGINED_ENGINES_PATH) {
    return handleEngines(ctx, fault)
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
  return responseForImageGet(pathname)
}

function routePost(
  ctx: DoorContext,
  req: Request,
  pathname: string,
  launchScoped: boolean,
): Response | Promise<Response> | undefined {
  if (isCursorPath(pathname)) {
    return handleCursor(ctx, pathname)
  }
  if (pathname === START_PATH) {
    return handleStart(ctx, req)
  }
  if (pathname === TOKENIZE_PATH) {
    return handleTokenizeRoute(ctx, req)
  }
  const verb = routeEngineVerb(ctx, req, pathname)
  if (verb !== undefined) {
    return verb
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

function allowFor(pathname: string): string[] {
  const get =
    pathname === OPENAI_MODELS_PATH ||
    pathname.startsWith(`${OPENAI_MODELS_PATH}/`) ||
    pathname === ENGINED_ENGINES_PATH ||
    pathname === `${ENGINED_ENGINES_PATH}/events` ||
    pathname === USAGE_PATH ||
    IMAGE_GET_RE.test(pathname) ||
    LOGS_RE.test(pathname) ||
    RESOURCES_RE.test(pathname)
  const post =
    isCursorPath(pathname) ||
    pathname === START_PATH ||
    pathname === TOKENIZE_PATH ||
    pathname === VOICE_UPLOAD_PATH ||
    CONTENT_ENDPOINTS.has(pathname) ||
    isEngineVerbPath(pathname) ||
    EXTRAS_RE.test(pathname)
  return [...(get ? ['GET', 'HEAD'] : []), ...(post ? ['POST'] : [])]
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
  fault: ConfigFault | undefined,
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
  if (req.method === 'GET' || req.method === 'HEAD') {
    matched = routeGet(ctx, new URL(pathname + url.search, url), fault, req.signal)
  } else if (req.method === 'POST') {
    matched = routePost(ctx, req, pathname, launchScoped)
  }
  if (matched !== undefined) {
    return req.method === 'HEAD' ? headOf(matched) : matched
  }
  const allow = allowFor(pathname)
  return allow.length === 0 ? jsonError(STATUS_NOT_FOUND, 'not found') : methodNotAllowed(allow)
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
    inventory: registryOpts.inventory ?? new Inventory({ secretExec: doorOpts.secretExec }),
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
    usage: new UsageTracker({ stateRoot: doorOpts.usageStateRoot }),
    donorSpend: new DonorLedger({ stateRoot: doorOpts.usageStateRoot }),
  }
}

export function createDoor(
  initialConfig: Config,
  registryOpts: RegistryOptions,
  doorOpts: DoorOptions = {},
): Door {
  let config = initialConfig
  let fault: ConfigFault | undefined =
    doorOpts.awaitingConfigError === undefined
      ? undefined
      : { message: doorOpts.awaitingConfigError, sha256: doorOpts.awaitingConfigSha256 }
  let live = fault === undefined
  const served: ServedPorts = { listen: initialConfig.listen_port }
  const pending = new Set<(res: Response) => void>()
  const discovery = doorOpts.discovery ?? new ModelDiscovery()
  const ctx = createDoorContext(() => discovery.apply(config), registryOpts, doorOpts)
  const { registry } = ctx

  function reload(path: string, rebind?: (next: Config) => void): void {
    let attempted: string | undefined
    try {
      const next = loadConfig(path)
      attempted = next.source_sha256
      if (rebind === undefined) {
        refuseMovedPorts(served, next)
      } else {
        rebind(next)
      }
      // registry.reload can still throw (a spec-less engine, a capability
      // route nothing serves) even though `next` parsed clean. Applying it
      // to the registry before swapping `config` keeps a failed reload
      // serving the old config, with only `fault` reporting the new one.
      registry.reload(next)
      config = next
      live = true
      fault = undefined
      resetSpeechCache()
      retireLlamaRouters(ctx, next)
    } catch (err) {
      fault = { message: errMessage(err), sha256: attempted ?? configFilesSha256(path) }
    }
  }

  function fetch(req: Request): Response | Promise<Response>
  function fetch(req: Request, server: EnginedServer): Response | Promise<Response> | undefined
  function fetch(req: Request, server?: EnginedServer): Response | Promise<Response> | undefined {
    try {
      const refusal = checkOrigin(req, served.listen)
      if (refusal) {
        return refusal
      }
      if (!(live || isEnginesList(req))) {
        return jsonError(STATUS_UNAVAILABLE, fault?.message ?? 'no valid config is loaded')
      }
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
      const routed = routeRequest(ctx, req, fault)
      if (routed instanceof Promise) {
        return interruptible(routed).catch((err: unknown) =>
          jsonError(STATUS_INTERNAL_SERVER_ERROR, errMessage(err)),
        )
      }
      return routed
    } catch (err) {
      return jsonError(STATUS_INTERNAL_SERVER_ERROR, errMessage(err))
    }
  }

  function interruptible(routed: Promise<Response>): Promise<Response> {
    return new Promise((resolve, reject) => {
      pending.add(resolve)
      routed.then(resolve, reject).finally(() => pending.delete(resolve))
    })
  }

  function interrupt(): void {
    for (const resolve of pending) {
      resolve(jsonError(STATUS_UNAVAILABLE, 'engined is reloading; retry shortly'))
    }
    pending.clear()
  }

  return {
    fetch,
    reload,
    live: () => live,
    served,
    interrupt,
    registry,
    ctx,
    discovery,
    configError: () => fault?.message,
  }
}

function isEnginesList(req: Request): boolean {
  return (
    (req.method === 'GET' || req.method === 'HEAD') &&
    new URL(req.url).pathname === ENGINED_ENGINES_PATH
  )
}

/** Absolute bunx from `ENGINED_BUNX` or PATH, resolved at startup so a miss is fatal immediately. */
export function resolveBunx(
  env: NodeJS.ProcessEnv = ambientEnv,
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

if (import.meta.main) {
  const extra = await extraModeExit(process.argv)
  if (extra !== undefined) {
    process.exit(extra)
  }
  runDaemon({ createDoor, resolveBunx })
}
