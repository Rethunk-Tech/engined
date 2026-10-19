import process from 'node:process'
import { MAX_AUDIO_UPLOAD_BYTES } from './audioDoorTranscribe.ts'
import type { ComfyWsData, EnginedServer } from './comfyProxy.ts'
import { comfyWebSocketHandlers } from './comfyRoutes.ts'
import { jsonError, STATUS_INTERNAL_SERVER_ERROR } from './http.ts'
import type { Door } from './main.ts'
import { errMessage } from './records.ts'

/**
 * The door's real listeners: every interface, both families, on one port.
 * Exported so a test binds through this exact code rather than a hand-rolled
 * `Bun.serve` that would pass even if a family were dropped here.
 */
export function bindDoor(
  fetch: Door['fetch'],
  port: number,
  serve: typeof Bun.serve = Bun.serve,
): EnginedServer[] {
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
  let v6: EnginedServer
  try {
    v6 = serve<ComfyWsData>({ hostname: '::', port, ...serveOpts })
  } catch (err) {
    if (!NO_IPV6.has(errorCode(err))) {
      throw err
    }
    process.stderr.write(`IPv6 unavailable, serving IPv4 only: ${errMessage(err)}\n`)
    return [serve<ComfyWsData>({ hostname: '0.0.0.0', port, ...serveOpts })]
  }
  try {
    // A dual-stack `::` already takes IPv4 and refuses this bind; only a host
    // with `bindv6only` set needs the second listener.
    return [v6, serve<ComfyWsData>({ hostname: '0.0.0.0', port: v6.port, ...serveOpts })]
  } catch (err) {
    if (errorCode(err) !== 'EADDRINUSE') {
      v6.stop(true)
      throw err
    }
    return [v6]
  }
}

const NO_IPV6 = new Set<unknown>(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])

export function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
}
