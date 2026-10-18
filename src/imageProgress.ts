/**
 * Progress frames Comfy already pushes down its websocket, reshaped as the
 * image verb's SSE events. The final render is a separate event; a preview
 * past a small JPEG is metadata only.
 */

import { HTTP_SCHEME_RE } from './comfyProxy.ts'
import { CONTENT_TYPE, SSE_CONTENT_TYPE } from './http.ts'
import { isRecord, parseRecord } from './records.ts'

/** Comfy's binary websocket types. Big-endian, matching `struct.pack(">I", ...)`. */
const PREVIEW_IMAGE = 1
const PREVIEW_IMAGE_WITH_METADATA = 4
const JPEG_PREVIEW = 1
const PNG_PREVIEW = 2
const U32_BYTES = 4
const KIBIBYTE = 1024
const PREVIEW_INLINE_KIB = 32
/**
 * A latent preview is a small JPEG already in hand. Past this the event keeps
 * the length and format only: the final `image` event already carries the render.
 */
const PREVIEW_INLINE_MAX_BYTES = PREVIEW_INLINE_KIB * KIBIBYTE

type ImageEvent = 'progress' | 'preview' | 'image' | 'error'
export type ImageEmit = (event: ImageEvent, data: unknown) => void

function u32be(bytes: Uint8Array, offset: number): number | undefined {
  if (offset < 0 || offset + U32_BYTES > bytes.byteLength) {
    return undefined
  }
  return new DataView(bytes.buffer, bytes.byteOffset + offset, U32_BYTES).getUint32(0, false)
}

function asBytes(data: unknown): Uint8Array | undefined {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data)
  }
  return data instanceof Uint8Array ? data : undefined
}

/** Sampler step fields comfy already sends as `{type:"progress"|"executing"}`. */
function progressFields(text: string): Record<string, unknown> | undefined {
  const parsed = parseRecord(text)
  if (parsed === null || (parsed.type !== 'progress' && parsed.type !== 'executing')) {
    return undefined
  }
  const data = isRecord(parsed.data) ? parsed.data : {}
  const event: Record<string, unknown> = {}
  if (typeof data.value === 'number') {
    event.value = data.value
  }
  if (typeof data.max === 'number') {
    event.max = data.max
  }
  if (typeof data.node === 'string' || data.node === null) {
    event.node = data.node
  }
  if (typeof data.prompt_id === 'string') {
    event.prompt_id = data.prompt_id
  }
  return Object.keys(event).length > 0 ? event : undefined
}

function previewPayload(
  image: Uint8Array,
  format: 'jpeg' | 'png' | undefined,
): Record<string, unknown> {
  const event: Record<string, unknown> = { bytes: image.byteLength }
  if (format !== undefined) {
    event.format = format
  }
  if (image.byteLength <= PREVIEW_INLINE_MAX_BYTES) {
    event.image = Buffer.from(image).toString('base64')
  }
  return event
}

function formatOf(typeNum: number | undefined): 'jpeg' | 'png' | undefined {
  if (typeNum === PNG_PREVIEW) {
    return 'png'
  }
  if (typeNum === JPEG_PREVIEW) {
    return 'jpeg'
  }
  return undefined
}

function formatFromMeta(imageType: unknown): 'jpeg' | 'png' | undefined {
  if (imageType === 'image/png') {
    return 'png'
  }
  if (imageType === 'image/jpeg') {
    return 'jpeg'
  }
  return undefined
}

function nodeFromMeta(parsed: Record<string, unknown> | null): string | undefined {
  if (typeof parsed?.node_id === 'string') {
    return parsed.node_id
  }
  if (typeof parsed?.display_node_id === 'string') {
    return parsed.display_node_id
  }
  return undefined
}

function previewWithMetadata(bytes: Uint8Array): Record<string, unknown> {
  const metaLen = u32be(bytes, U32_BYTES)
  if (metaLen === undefined || U32_BYTES * 2 + metaLen > bytes.byteLength) {
    return { bytes: bytes.byteLength }
  }
  const metaStart = U32_BYTES * 2
  const parsed = parseRecord(
    new TextDecoder().decode(bytes.subarray(metaStart, metaStart + metaLen)),
  )
  const promptId = typeof parsed?.prompt_id === 'string' ? parsed.prompt_id : undefined
  const node = nodeFromMeta(parsed)
  return {
    ...previewPayload(bytes.subarray(metaStart + metaLen), formatFromMeta(parsed?.image_type)),
    ...(node === undefined ? {} : { node }),
    ...(promptId === undefined ? {} : { prompt_id: promptId }),
  }
}

/** One binary preview frame, or its length when the type is not a preview image. */
function previewFields(bytes: Uint8Array): Record<string, unknown> {
  const eventType = u32be(bytes, 0)
  if (eventType === PREVIEW_IMAGE) {
    return previewPayload(bytes.subarray(U32_BYTES * 2), formatOf(u32be(bytes, U32_BYTES)))
  }
  if (eventType === PREVIEW_IMAGE_WITH_METADATA) {
    return previewWithMetadata(bytes)
  }
  return { bytes: bytes.byteLength }
}

function closedSocket(): () => void {
  return () => {
    // Nothing was opened.
  }
}

/**
 * Comfy's own progress socket for this render. Frames are whatever the
 * container already pushes down `/ws`; a socket that never opens leaves the
 * wait on `/history` alone.
 */
export function watchComfyProgress(
  base: string,
  clientId: string,
  emit: ImageEmit,
  signal?: AbortSignal,
): () => void {
  const url = `${base.replace(HTTP_SCHEME_RE, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`
  let ws: WebSocket
  try {
    ws = new WebSocket(url)
  } catch {
    return closedSocket()
  }
  ws.binaryType = 'arraybuffer'
  ws.onerror = () => {
    // Progress is optional. `/history` is what finishes the render.
  }
  let stopped = false
  const stop = (): void => {
    if (stopped) {
      return
    }
    stopped = true
    ws.onmessage = null
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close()
    }
  }
  const send = (event: ImageEvent, data: unknown): void => {
    try {
      emit(event, data)
    } catch {
      stop()
    }
  }
  ws.onmessage = (ev: MessageEvent) => {
    if (typeof ev.data === 'string') {
      const data = progressFields(ev.data)
      if (data !== undefined) {
        send('progress', data)
      }
      return
    }
    const bytes = asBytes(ev.data)
    if (bytes !== undefined) {
      send('preview', previewFields(bytes))
    }
  }
  signal?.addEventListener('abort', stop, { once: true })
  return stop
}

/** SSE response: `run` emits progress while it renders, and the caller reads events as they land. */
export function imageEventResponse(
  headers: Headers,
  request: Request,
  run: (emit: ImageEmit, signal: AbortSignal) => Promise<Response>,
): Response {
  const ac = new AbortController()
  const abort = (): void => ac.abort()
  request.signal.addEventListener('abort', abort)
  const encoder = new TextEncoder()
  headers.set(CONTENT_TYPE, SSE_CONTENT_TYPE)
  headers.set('cache-control', 'no-cache')
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit: ImageEmit = (event, data) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      }
      try {
        const rendered = await run(emit, ac.signal)
        await rendered.body?.cancel()
      } catch {
        ac.abort()
      } finally {
        request.signal.removeEventListener('abort', abort)
        try {
          controller.close()
        } catch {
          // The client already closed the stream.
        }
      }
    },
    cancel() {
      ac.abort()
    },
  })
  return new Response(stream, { headers })
}
