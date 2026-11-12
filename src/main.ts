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
import { LAUNCH_NONCE_RE, LAUNCH_UPSTREAM_RE } from './launchNonce.ts'
import { forwardLaunchUpstream } from './launchUpstream.ts'
import { ModelDiscovery } from './modelDiscovery.ts'
import { modelById, modelsMenu } from './modelsMenu.ts'
import { DonorLedger } from './potluck.ts'
import { handleProbes, PROBES_PATH, ProbeStore } from './probeStore.ts'
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
import { allowOf, dispatch, exactPath, GET_HEAD, pathPattern, type Route } from './routeTable.ts'
import { refuseMovedPorts, type ServedPorts } from './servedPorts.ts'
import {
  DETOKENIZE_PATH,
  handleDetokenizeRoute,
  handleTokenizeRoute,
  TOKENIZE_PATH,
} from './tokenizeRoute.ts'
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
/** Origin refusals are 403 and carry no engine detail: the caller failed the door, not an engine. */
function refuse(message: string): Response {
  return jsonError(STATUS_FORBIDDEN, message)
}
/** Any `Origin` is refused, including `"null"`. A present `Sec-Fetch-Site` other than `none` is refused the same way: a no-cors GET carries no Origin, and the door serves no page of its own, so `same-origin` can only come from a page whose name was rebound to this host. No Origin and no Sec-Fetch-Site (CLI/server) is unaffected. */
function checkOrigin(req: Request): Response | null {
  const site = req.headers.get('Sec-Fetch-Site')
  if (req.headers.get('Origin') !== null || (site !== null && site !== 'none')) {
    return refuse('cross-origin requests are refused')
  }
  return null
}

/** The llama.cpp routes proxied straight through: always the one local llama engine. */
const EXTRAS_RE = engineVerbRe('(tokenize|apply-template)')

export type { Door }

interface GetArgs {
  ctx: DoorContext
  url: URL
  fault: ConfigFault | undefined
  signal: AbortSignal
}
interface PostArgs {
  ctx: DoorContext
  req: Request
  pathname: string
  launchScoped: boolean
}

const MODEL_PREFIX = `${OPENAI_MODELS_PATH}/`

const GET_ROUTES: Route<GetArgs>[] = [
  {
    methods: GET_HEAD,
    match: exactPath(OPENAI_MODELS_PATH),
    handle: (_, { ctx }) => modelsMenu(ctx),
  },
  {
    methods: GET_HEAD,
    match: (p) => (p.startsWith(MODEL_PREFIX) ? [p.slice(MODEL_PREFIX.length)] : undefined),
    handle: ([id = ''], { ctx }) => modelById(ctx, decodeURIComponent(id)),
  },
  {
    methods: GET_HEAD,
    match: exactPath(ENGINED_ENGINES_PATH),
    handle: (_, { ctx, fault }) => handleEngines(ctx, fault),
  },
  {
    methods: GET_HEAD,
    match: exactPath(`${ENGINED_ENGINES_PATH}/events`),
    handle: (_, { ctx, signal }) => handleEngineEvents(ctx, signal),
  },
  {
    methods: GET_HEAD,
    match: exactPath(USAGE_PATH),
    handle: (_, { ctx, url }) => handleUsage(ctx, url),
  },
  {
    methods: GET_HEAD,
    match: pathPattern(LOGS_RE),
    handle: ([id = ''], { ctx, url }) => handleLogs(ctx.registry, id, url),
  },
  {
    methods: GET_HEAD,
    match: pathPattern(RESOURCES_RE),
    handle: ([id = ''], { ctx }) => handleResources(ctx.registry, id),
  },
  {
    methods: GET_HEAD,
    match: pathPattern(IMAGE_GET_RE),
    handle: (_, { url }) => responseForImageGet(url.pathname),
  },
]

const POST_ROUTES: Route<PostArgs>[] = [
  {
    methods: ['POST'],
    match: (p) => (isCursorPath(p) ? [] : undefined),
    handle: (_, { ctx, pathname }) => handleCursor(ctx, pathname),
  },
  {
    methods: ['POST'],
    match: exactPath(START_PATH),
    handle: (_, { ctx, req }) => handleStart(ctx, req),
  },
  {
    methods: ['POST'],
    match: exactPath(PROBES_PATH),
    handle: (_, { ctx, req }) => handleProbes(ctx, req),
  },
  {
    methods: ['POST'],
    match: exactPath(TOKENIZE_PATH),
    handle: (_, { ctx, req }) => handleTokenizeRoute(ctx, req),
  },
  {
    methods: ['POST'],
    match: exactPath(DETOKENIZE_PATH),
    handle: (_, { ctx, req }) => handleDetokenizeRoute(ctx, req),
  },
  {
    methods: ['POST'],
    match: (p) => (isEngineVerbPath(p) ? [] : undefined),
    handle: (_, { ctx, req, pathname }) => routeEngineVerb(ctx, req, pathname),
  },
  {
    methods: ['POST'],
    match: exactPath(VOICE_UPLOAD_PATH),
    handle: (_, { req }) => handleVoiceUpload(req),
  },
  {
    methods: ['POST'],
    match: (p) => (CONTENT_ENDPOINTS.has(p) ? [] : undefined),
    handle: (_, { ctx, req, pathname, launchScoped }) =>
      handleContent(ctx, req, pathname, launchScoped),
  },
  {
    methods: ['POST'],
    match: pathPattern(EXTRAS_RE),
    handle: ([id, verb], { ctx, req }) =>
      id === undefined || verb === undefined ? undefined : handleExtras(ctx, req, id, verb),
  },
]

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
  const upstreamMatch = LAUNCH_UPSTREAM_RE.exec(url.pathname)
  if (upstreamMatch) {
    const [, nonce = '', rest = ''] = upstreamMatch
    return forwardLaunchUpstream(ctx, req, nonce, rest)
  }
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
    matched = dispatch(GET_ROUTES, req.method, pathname, {
      ctx,
      url: new URL(pathname + url.search, url),
      fault,
      signal: req.signal,
    })
  } else if (req.method === 'POST') {
    matched = dispatch(POST_ROUTES, req.method, pathname, { ctx, req, pathname, launchScoped })
  }
  if (matched !== undefined) {
    return req.method === 'HEAD' ? headOf(matched) : matched
  }
  const allow = [...allowOf(GET_ROUTES, pathname), ...allowOf(POST_ROUTES, pathname)]
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
    launchUpstreams: new Map(),
    agenticInFlight: 0,
    comfyBindings: loadComfyBindings(),
    comfySlots: new Map(),
    usage: new UsageTracker({ stateRoot: doorOpts.usageStateRoot }),
    probes: new ProbeStore(),
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
      const refusal = checkOrigin(req)
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
