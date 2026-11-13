import { randomUUID } from 'node:crypto'
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
  // Bun's default 10s timer closes with no body; it also rejects a value
  // above 255. 255s bounds a stalled header read; once a request reaches the
  // handler the timer is off for it, because a non-streaming hop may sit
  // silent for `chat_timeout_seconds` (default 600) and the hop budget is
  // engined's. `websocket` is the comfy proxy upgrade only.
  const serveOpts = {
    fetch: ((req, server) => {
      server?.timeout(req, 0)
      return fetch(req, server)
    }) as Door['fetch'],
    error: internalError,
    idleTimeout: 255,
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

const STACK_FRAME_RE = /^\s+at /

/**
 * An unhandled error's message can quote the request, so neither the caller
 * nor the journal sees it: the caller gets an id, the journal the id, the
 * error's name and its stack frames.
 */
function internalError(err: unknown): Response {
  const id = randomUUID()
  const name = err instanceof Error ? err.name : typeof err
  const header = String(err)
  const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : ''
  // The stack opens with `name: message`, and a message may hold newlines.
  const frames = (stack.startsWith(header) ? stack.slice(header.length) : stack)
    .split('\n')
    .filter((line) => STACK_FRAME_RE.test(line))
  process.stderr.write(`door: internal error ${id}: ${name}\n${frames.join('\n')}\n`)
  return jsonError(STATUS_INTERNAL_SERVER_ERROR, `internal error (id ${id})`)
}

const NO_IPV6 = new Set<unknown>(['EAFNOSUPPORT', 'EADDRNOTAVAIL'])

export function errorCode(err: unknown): unknown {
  return typeof err === 'object' && err !== null && 'code' in err ? err.code : undefined
}
