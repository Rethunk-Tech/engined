/**
 * The OpenAI-shaped content routes: chat, embeddings, rerank, and the
 * llama-only extras, plus the engine-event stream a caller watches a warm-up
 * on. Each resolves an address to a chain of hops and hands them to `runChain`.
 */

import { handleAudioSpeech } from './audioDoor.ts'
import { handleAudioTranscription } from './audioDoorTranscribe.ts'
import { parseHop, runChain } from './chain.ts'
import { handleCompletions } from './completions.ts'
import { attachLlamaRoles, engineWithLlamaRoles, routeAddress } from './control.ts'
import { type Dispatch, resolveOrRefuse } from './dispatch.ts'
import { type DoorContext, getLlamaRouter, recordDoorCall } from './doorContext.ts'
import { proxyExtras } from './extras.ts'
import { buildHopExec, egressOf, timeoutSecondsForKind } from './hop.ts'
import {
  CONTENT_TYPE,
  engineErrorStatus,
  JSON_CONTENT_TYPE,
  jsonError,
  readJsonBody,
  SSE_CONTENT_TYPE,
  STATUS_BAD_REQUEST,
  STATUS_UNAVAILABLE,
} from './http.ts'
import { handleImageEdit } from './imageEdits.ts'
import { handleImageGeneration } from './images.ts'
import { hopForwardsTools } from './modelsMenu.ts'
import type { Attempt } from './provenance.ts'
import { errMessage, MS_PER_SECOND } from './records.ts'
import { localRoutesOf } from './routeAddress.ts'
import {
  CONTENT_ENDPOINT_CHAT,
  CONTENT_ENDPOINT_COMPLETIONS,
  CONTENT_ENDPOINT_IMAGE_EDITS,
  CONTENT_ENDPOINT_IMAGES,
  CONTENT_ENDPOINT_SPEECH,
  CONTENT_ENDPOINT_TRANSCRIPTIONS,
  CONTENT_ENDPOINT_TRANSLATIONS,
} from './routeServes.ts'
import { type Config, EGRESS_RANK, type Egress, isEgress, type ResolvedRoute } from './types.ts'
import { bodyHasBridgeableImages, bridgeImages } from './visionBridge.ts'

/** Idle loopback connections do get dropped; a comment frame is the cheapest thing that keeps one alive. */
const SSE_KEEPALIVE_MS = 30_000

function chatTimeoutMs(ctx: DoorContext): (hop: string) => number {
  const config = ctx.getConfig()
  return (hop) => {
    const { engine: engineId } = parseHop(hop)
    return timeoutSecondsForKind(ctx.registry.get(engineId)?.kind, config) * MS_PER_SECOND
  }
}

interface ContentRequest {
  pathname: string
  rawModel: string
  body: Record<string, unknown>
  /** The client's signal, carried this far so an abandoned chat stops the chain instead of running every hop to its full budget. */
  signal: AbortSignal
  /** This request arrived on a launch-scoped `/openai/v1/<nonce>/...` URL. */
  launchScoped: boolean
}

/** `undefined` when the caller left it out (no ceiling); a legal `Egress` string when it named one. A value that is neither is the caller's own mistake, not a silent no-ceiling. */
function parseMaxEgress(raw: unknown): { ok: true; value: Egress | undefined } | { ok: false } {
  if (raw === undefined) {
    return { ok: true, value: undefined }
  }
  return isEgress(raw) ? { ok: true, value: raw } : { ok: false }
}

/** Every verb whose route comes from the body's own `model` string -- chat, embeddings, rerank. `chain`, `model` and `engine` dispatches all become one or more `@/engine/model` hops through `runChain`, which is also where the one provenance line per call is emitted. */
async function handleModelRouted(
  ctx: DoorContext,
  resolved: Extract<Dispatch, { ok: true }>,
  content: ContentRequest,
): Promise<Response> {
  let { pathname, rawModel, signal, launchScoped, body } = content
  const maxEgress = parseMaxEgress(body.max_egress)
  if (!maxEgress.ok) {
    return jsonError(
      STATUS_BAD_REQUEST,
      `max_egress must be one of: ${Object.keys(EGRESS_RANK).join(', ')}`,
    )
  }
  const chainName = resolved.kind === 'chain' ? resolved.chain : null

  // Only a single, directly-addressed chat route carries `vision_bridge` --
  // a chain has no one route to check, and nothing else in it wants images.
  let visionBridgeAttempts: Attempt[] | undefined
  if (
    pathname === CONTENT_ENDPOINT_CHAT &&
    resolved.kind === 'model' &&
    resolved.route.vision_bridge !== undefined &&
    bodyHasBridgeableImages(body)
  ) {
    const bridged = await bridgeImages(ctx, {
      bridgeAddress: resolved.route.vision_bridge,
      body,
      signal,
      launchScoped,
    })
    if (!bridged.ok) {
      const record = {
        chain: chainName,
        requested: rawModel,
        attempts: [],
        engine_used: null,
        upstream_used: null,
        vision_bridge: bridged.attempts,
      }
      recordDoorCall(ctx, record)
      return bridged.response
    }
    ;({ body, attempts: visionBridgeAttempts } = bridged)
  }

  const hops =
    resolved.kind === 'chain'
      ? [...resolved.hops]
      : [routeAddress(resolved.route, ctx.getConfig().routes)]

  let contentType: string = JSON_CONTENT_TYPE
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
          contentType = ct
        },
        toolsHonourableElsewhere: hops.some((hop) =>
          hopForwardsTools(hop, ctx.getConfig().routes, (id) => ctx.registry.get(id)),
        ),
        inChain: chainName !== null,
      },
      launchScoped,
    ),
    visionBridgeAttempts,
    record: (record) => recordDoorCall(ctx, record),
  })

  if (result.stream) {
    const headers = result.headers ?? new Headers()
    headers.set(CONTENT_TYPE, contentType)
    return new Response(result.stream, { status: result.status, headers })
  }
  return Response.json(result.body, { status: result.status, headers: result.headers })
}

/** Tokenize and apply-template are chat tools; asking the router for any other role would inject the wrong model. */
const EXTRAS_ROLE = 'chat'

/**
 * The GGUF extras inject when the body names none. A `keep_resident` chat
 * route is the operator's intended occupant; otherwise declaration order
 * among local chat routes on this engine.
 */
function extrasChatRoute(config: Config, engineId: string): ResolvedRoute | undefined {
  const locals = localRoutesOf(config.routes, engineId).filter(
    (r) => r.disabled !== true && r.role === EXTRAS_ROLE && r.model !== undefined,
  )
  return locals.find((r) => r.keep_resident === true) ?? locals[0]
}

export async function handleExtras(
  ctx: DoorContext,
  req: Request,
  engineId: string,
  verb: string,
): Promise<Response> {
  const engineEntry = ctx.registry.entry(engineId)
  if (!engineEntry) {
    return jsonError(STATUS_BAD_REQUEST, `unknown engine "${engineId}"`)
  }
  // Without this the router would happily start whisper and post a chat body into it.
  if (!ctx.registry.isLocalLlama(engineId)) {
    return jsonError(STATUS_BAD_REQUEST, `engine "${engineId}" does not serve ${verb}`)
  }
  try {
    const status = await ctx.registry.start(engineId)
    // `EngineStatus` carries no container address; the internal runtime read
    // is `lifecycle`'s own, the same source the comfy proxy resolves against.
    const privateUrl = ctx.lifecycle.getStatus(engineId).private_url
    if (privateUrl === null) {
      return jsonError(STATUS_UNAVAILABLE, status.fix ?? `${engineId} is not available`)
    }
    const router = getLlamaRouter(ctx, engineEntry)
    let residentModel = router.residentModel(EXTRAS_ROLE)
    if (residentModel === null) {
      const chatRoute = extrasChatRoute(ctx.getConfig(), engineId)
      if (chatRoute !== undefined) {
        try {
          await router.warm(chatRoute, req.signal)
        } catch (err) {
          return jsonError(engineErrorStatus(err), errMessage(err))
        }
        residentModel = router.residentModel(EXTRAS_ROLE)
      }
    }
    const modelId = residentModel ?? extrasChatRoute(ctx.getConfig(), engineId)?.model
    return await proxyExtras(
      req,
      {
        baseUrl: () => {
          const current = ctx.lifecycle.getStatus(engineId).private_url
          return current === null ? null : `http://${current}`
        },
        enginePath: `/${verb}`,
        hold:
          modelId === undefined
            ? undefined
            : (work) => router.withLease(EXTRAS_ROLE, modelId, req.signal, work),
      },
      residentModel,
      ctx.doorOpts.extrasHttpClient,
    )
  } catch (err) {
    return jsonError(engineErrorStatus(err), errMessage(err))
  }
}

export async function handleContent(
  ctx: DoorContext,
  req: Request,
  pathname: string,
  launchScoped: boolean,
): Promise<Response> {
  if (pathname === CONTENT_ENDPOINT_TRANSCRIPTIONS || pathname === CONTENT_ENDPOINT_TRANSLATIONS) {
    return handleAudioTranscription(ctx, req, pathname)
  }
  // Multipart like the audio verbs, and read before `readJsonBody` for the
  // same reason: the image is the request, not a field inside a JSON body.
  if (pathname === CONTENT_ENDPOINT_IMAGE_EDITS) {
    // The signal ends a render nobody is waiting for: a diffusion job holds the
    // GPU, and this door runs one at a time.
    return handleImageEdit(ctx, req, req.signal)
  }
  const body = await readJsonBody(req)
  if (body instanceof Response) {
    return body
  }
  if (pathname === CONTENT_ENDPOINT_SPEECH) {
    // The signal is what stops a speech chain advancing to a second engine for
    // an answer the caller is no longer there to receive.
    return handleAudioSpeech(ctx, body, req.signal)
  }
  if (pathname === CONTENT_ENDPOINT_IMAGES) {
    // The signal ends a render nobody is waiting for: a diffusion job holds the
    // GPU, and this door runs one at a time.
    return handleImageGeneration(ctx, body, req)
  }
  if (pathname === CONTENT_ENDPOINT_COMPLETIONS) {
    return handleCompletions(ctx, body, req.signal)
  }
  const rawModel = typeof body.model === 'string' ? body.model : undefined
  const resolved = resolveOrRefuse(ctx, rawModel, pathname, body)
  if (resolved instanceof Response) {
    return resolved
  }
  return handleModelRouted(ctx, resolved, {
    pathname,
    rawModel: rawModel ?? '',
    body,
    signal: req.signal,
    launchScoped,
  })
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
export function handleEngineEvents(ctx: DoorContext, signal: AbortSignal): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true
      const send = (event: string, data: unknown): void => {
        if (!open) {
          return
        }
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
        } catch {
          // The client went away between the abort check and the write.
          open = false
        }
      }

      const unwatch = ctx.registry.watch((status) => {
        send('engine', engineWithLlamaRoles(ctx, status))
      })
      const keepalive = setInterval(() => {
        if (open) {
          try {
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          } catch {
            open = false
          }
        }
      }, SSE_KEEPALIVE_MS)

      const close = (): void => {
        open = false
        clearInterval(keepalive)
        unwatch()
        try {
          controller.close()
        } catch {
          // Already closed by the client's disconnect.
        }
      }
      signal.addEventListener('abort', close, { once: true })

      ctx.registry
        .list()
        .then((listed) => {
          attachLlamaRoles(ctx, listed.engines)
          send('snapshot', listed)
        })
        .catch(() => {
          // A snapshot that cannot be built is not a reason to deny the
          // client the live frames it actually subscribed for.
        })
    },
  })

  return new Response(stream, {
    headers: {
      [CONTENT_TYPE]: SSE_CONTENT_TYPE,
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    },
  })
}
