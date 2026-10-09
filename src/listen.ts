import process from 'node:process'
import { MAX_AUDIO_UPLOAD_BYTES } from './audioDoorTranscribe.ts'
import type { ComfyWsData, EnginedServer } from './comfyProxy.ts'
import { comfyWebSocketHandlers } from './comfyRoutes.ts'
import { jsonError, STATUS_INTERNAL_SERVER_ERROR } from './http.ts'
import type { Door } from './main.ts'
import { errMessage } from './records.ts'

/**
 * The door's real listener setup: both loopback families bound to the same
 * port. Exported so a test can bind through this exact code rather than a
 * hand-rolled `Bun.serve` pair that would pass even if the `::1` listener
 * were deleted here.
 */
export function bindDualFamily(
  fetch: Door['fetch'],
  port: number,
  serve: typeof Bun.serve = Bun.serve,
): { v4: EnginedServer; v6: EnginedServer | undefined } {
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
  const v4 = serve<ComfyWsData>({ hostname: '127.0.0.1', port, ...serveOpts })
  try {
    return { v4, v6: serve<ComfyWsData>({ hostname: '::1', port: v4.port, ...serveOpts }) }
  } catch (err) {
    // A host with IPv6 off on loopback has no `::1` to bind; v4 alone serves it.
    if (errorCode(err) !== 'EADDRNOTAVAIL') {
      v4.stop(true)
      throw err
    }
    process.stderr.write(`::1 unavailable, serving 127.0.0.1 only: ${errMessage(err)}\n`)
    return { v4, v6: undefined }
  }
}

export function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
}
