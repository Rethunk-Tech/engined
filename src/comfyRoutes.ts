/**
 * The passthrough routes in front of a ComfyUI container: the narrow
 * allowlist a caller may reach, the cancel verb that scopes an interrupt to a
 * prompt this door bound, and the websocket upgrade its progress stream needs.
 */

import {
  COMFY_LOCAL_ORIGIN,
  COMFY_WS_SUFFIX,
  type ComfyMatch,
  type ComfyProxy,
  type ComfyWsData,
  type EnginedServer,
  forwardComfyGet,
  HTTP_SCHEME_RE,
  noSuchComfyEngine,
  proxyComfyCancel,
  proxyComfyHistory,
  proxyComfyPrompt,
  proxyComfyQueueDelete,
  proxyComfyUpload,
  proxyComfyView,
  resolveComfyTarget,
} from './comfyProxy.ts'
import type { DoorContext } from './doorContext.ts'
import { jsonError, STATUS_BAD_REQUEST, STATUS_NOT_FOUND } from './http.ts'

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
export function handleComfyProxy(
  ctx: DoorContext,
  req: Request,
  { engineSeg, upstreamSeg, rest }: ComfyMatch,
): Response | Promise<Response> {
  const target = resolveComfyTarget(ctx, engineSeg, upstreamSeg)
  if (target === undefined) {
    return noSuchComfyEngine(engineSeg, upstreamSeg)
  }
  const proxy: ComfyProxy = {
    ctx,
    engineId: target.engineId,
    origin: COMFY_LOCAL_ORIGIN,
    base: target.base,
    httpClient: ctx.doorOpts.comfyHttpClient ?? fetch,
  }

  if (rest === COMFY_WS_SUFFIX) {
    // A real upgrade never reaches here -- `fetch` intercepts it before
    // routing, using the live `Bun.serve` server it is handed. This is only
    // reached by a plain request against the ws path with no real socket
    // behind it (a unit test's direct `door.fetch` call), which cannot be
    // proxied at all.
    return jsonError(STATUS_BAD_REQUEST, 'this path is a websocket upgrade, not a plain request')
  }
  let forwarded: Promise<Response> | undefined
  if (req.method === 'GET') {
    forwarded = comfyGet(proxy, rest, new URL(req.url))
  } else if (req.method === 'POST') {
    forwarded = comfyPost(proxy, rest, req)
  }
  return forwarded ?? jsonError(STATUS_NOT_FOUND, `"${rest}" is not proxied by this door`)
}

function comfyGet(proxy: ComfyProxy, rest: string, url: URL): Promise<Response> | undefined {
  if (rest === 'system_stats' || rest.startsWith('object_info/')) {
    return forwardComfyGet(proxy.base, rest, url.search, proxy.httpClient)
  }
  if (rest === 'view') {
    return proxyComfyView(proxy, url.searchParams)
  }
  if (rest.startsWith('history/')) {
    return proxyComfyHistory(proxy, rest.slice('history/'.length))
  }
  return undefined
}

function comfyPost(proxy: ComfyProxy, rest: string, req: Request): Promise<Response> | undefined {
  if (rest === 'prompt') {
    return proxyComfyPrompt(proxy, req)
  }
  if (rest === 'upload/image') {
    return proxyComfyUpload(proxy.base, req, proxy.httpClient)
  }
  if (rest === 'queue') {
    return proxyComfyQueueDelete(proxy, req)
  }
  if (rest === 'cancel') {
    return proxyComfyCancel(proxy, req)
  }
  return undefined
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
export function handleComfyWsUpgrade(
  ctx: DoorContext,
  req: Request,
  server: EnginedServer,
  { engineSeg, upstreamSeg }: ComfyMatch,
): Response | undefined {
  const target = resolveComfyTarget(ctx, engineSeg, upstreamSeg)
  if (target === undefined) {
    return noSuchComfyEngine(engineSeg, upstreamSeg)
  }
  const clientId = crypto.randomUUID().replace(/-/g, '')
  const upstreamWsUrl = `${target.base.replace(HTTP_SCHEME_RE, 'ws')}/ws?clientId=${clientId}`
  const data: ComfyWsData = { upstreamUrl: upstreamWsUrl, clientId }
  return server.upgrade(req, { data })
    ? undefined
    : jsonError(STATUS_BAD_REQUEST, 'websocket upgrade failed')
}

/** What `comfyWebSocketHandlers.open` announces first, so the caller learns the door-assigned `clientId` before it ever needs one for `POST /prompt`. */
const CLIENT_ID_MESSAGE_TYPE = 'client_id'

/**
 * Bridges the caller's own upgraded socket to a fresh outbound connection to
 * the real container, one per caller connection. Comfy's own protocol is
 * server-to-client only (progress and preview frames); nothing a caller
 * could legitimately send back ever reaches comfy through this, so
 * `message` is a deliberate no-op.
 */
export const comfyWebSocketHandlers: Bun.WebSocketHandler<ComfyWsData> = {
  open(ws) {
    const upstream = new WebSocket(ws.data.upstreamUrl)
    upstream.binaryType = 'arraybuffer'
    ws.data.upstream = upstream
    upstream.addEventListener('open', () => {
      ws.send(
        JSON.stringify({ type: CLIENT_ID_MESSAGE_TYPE, data: { client_id: ws.data.clientId } }),
      )
    })
    upstream.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        ws.send(ev.data)
      } else {
        ws.send(new Uint8Array(ev.data as ArrayBuffer))
      }
    })
    upstream.addEventListener('close', () => ws.close())
    upstream.addEventListener('error', () => ws.close())
  },
  message() {
    // See the doc comment above: nothing a caller sends is ever forwarded.
  },
  close(ws) {
    ws.data.upstream?.close()
  },
}
