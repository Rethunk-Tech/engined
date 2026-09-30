/**
 * Bounded on-disk store for OpenAI image `response_format: "url"`: the door
 * names every file, so a caller string never becomes a path, and a GET that
 * does not match IMAGE_ID_RE is 404 rather than a traversal.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { comfyHistoryEntry, filenamesIn } from './comfyProxy.ts'
import {
  CONTENT_TYPE,
  discardBody,
  type HttpClient,
  jsonError,
  OCTET_STREAM_CONTENT_TYPE,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_NOT_FOUND,
} from './http.ts'
import { imagesDir } from './paths.ts'
import { errMessage, MS_PER_SECOND, pollUntil } from './records.ts'

/**
 * A refusal on its way out: the status and the words a `jsonError` will carry,
 * kept as data because provenance needs those words and a Response body reads
 * exactly once -- classifying by re-reading it would hand the caller a drained
 * body.
 */
export interface Refusal {
  status: number
  error: string
}

/** How often the door asks whether the render has finished. A diffusion step is hundreds of milliseconds, so a tighter poll only costs round trips. */
const HISTORY_POLL_MS = 400

/** 128 bits: the id is guessed, not enumerated, and is the only string joined onto imagesDir(). */
const IMAGE_ID_BYTES = 16

/** The whole stored name: hex id plus a short suffix this door itself chose. */
export const IMAGE_ID_RE = /^[0-9a-f]{32}\.(png|jpg|jpeg|webp|gif)$/

export const IMAGE_GET_RE = /^\/engined\/v1\/images\/([^/]+)$/

const IMAGE_KEEP = 64

const IMAGE_TTL_DAYS = 7
const HOURS_PER_DAY = 24
const MINUTES_PER_HOUR = 60
const SECONDS_PER_MINUTE = 60

/** Seven days from write, not from last GET: polling must not hold a URL open. */
export const IMAGE_TTL_MS =
  IMAGE_TTL_DAYS * HOURS_PER_DAY * MINUTES_PER_HOUR * SECONDS_PER_MINUTE * MS_PER_SECOND

const KIBIBYTE = 1024
const MEBIBYTE = KIBIBYTE * KIBIBYTE
const IMAGE_STORE_MAX_MEBIBYTES = 256

/** Cap on the directory, not one file: a busy box drops older renders first. */
const IMAGE_STORE_MAX_BYTES = IMAGE_STORE_MAX_MEBIBYTES * MEBIBYTE

const IMAGE_EXT_RE = /^(png|jpg|jpeg|webp|gif)$/

export type ImageResponseFormat = 'b64_json' | 'url'

export interface ImageStoreBounds {
  dir?: () => string
  now?: () => number
  keep?: number
  maxBytes?: number
  ttlMs?: number
}

function storeDir(bounds?: ImageStoreBounds): string {
  return bounds?.dir?.() ?? imagesDir()
}

function storeNow(bounds?: ImageStoreBounds): number {
  return bounds?.now?.() ?? Date.now()
}

function typeForExt(ext: string): string {
  if (ext === 'jpg' || ext === 'jpeg') {
    return 'image/jpeg'
  }
  if (ext === 'png' || ext === 'webp' || ext === 'gif') {
    return `image/${ext}`
  }
  return OCTET_STREAM_CONTENT_TYPE
}

function extOf(filename: string): string {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase()
  return IMAGE_EXT_RE.test(ext) ? ext : 'png'
}

/**
 * Absent means the historical default this verb already shipped: b64_json.
 * `"url"` is opt-in so a caller that never sent the field still gets bytes.
 */
export function parseImageResponseFormat(value: unknown): ImageResponseFormat | Response {
  if (value === undefined || value === null || value === '') {
    return 'b64_json'
  }
  if (value === 'b64_json' || value === 'url') {
    return value
  }
  return jsonError(
    STATUS_BAD_REQUEST,
    `"response_format" must be "url" or "b64_json", not ${JSON.stringify(value)}`,
  )
}

/** `Host` from the request, so a TLS bridge's public name is what the caller fetches. */
function imagePublicUrl(req: Request, id: string): string {
  const url = new URL(req.url)
  const host = req.headers.get('host')
  if (host !== null && host !== '') {
    url.host = host
  }
  const forwarded = req.headers.get('x-forwarded-proto')
  if (forwarded !== null && forwarded !== '') {
    url.protocol = `${forwarded}:`
  }
  url.pathname = `/engined/v1/images/${id}`
  url.search = ''
  url.hash = ''
  return url.href
}

function listedRenders(dir: string): { name: string; mtimeMs: number; size: number }[] {
  return readdirSync(dir)
    .filter((name) => IMAGE_ID_RE.test(name))
    .map((name) => {
      const st = statSync(join(dir, name))
      return { name, mtimeMs: st.mtimeMs, size: st.size }
    })
}

/**
 * Drops expired files first, then oldest-written until count and bytes fit.
 * Failure is reported and swallowed: the store that follows has already
 * succeeded, and refusing it afterwards would lose the caller's image.
 */
export function evictImages(bounds?: ImageStoreBounds): void {
  try {
    const dir = storeDir(bounds)
    const now = storeNow(bounds)
    const ttlMs = bounds?.ttlMs ?? IMAGE_TTL_MS
    const keep = bounds?.keep ?? IMAGE_KEEP
    const maxBytes = bounds?.maxBytes ?? IMAGE_STORE_MAX_BYTES
    const files = listedRenders(dir)
    for (const file of files) {
      if (now - file.mtimeMs > ttlMs) {
        rmSync(join(dir, file.name))
      }
    }
    const live = listedRenders(dir).sort((a, b) => a.mtimeMs - b.mtimeMs)
    let bytes = live.reduce((sum, file) => sum + file.size, 0)
    let count = live.length
    for (const file of live) {
      if (count <= keep && bytes <= maxBytes) {
        break
      }
      rmSync(join(dir, file.name))
      bytes -= file.size
      count -= 1
    }
  } catch (err) {
    process.stderr.write(`image store not trimmed: ${errMessage(err)}\n`)
  }
}

export function storeRenderedImage(
  bytes: Uint8Array,
  ext: string,
  bounds?: ImageStoreBounds,
): string {
  const suffix = IMAGE_EXT_RE.test(ext) ? ext : 'png'
  const id = `${randomBytes(IMAGE_ID_BYTES).toString('hex')}.${suffix}`
  const dir = storeDir(bounds)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, id), bytes)
  evictImages(bounds)
  return id
}

/**
 * Whole-store eviction (two directory listings plus a stat per file) stays
 * on `storeRenderedImage`; a GET only ever needs one file's own age, checked
 * against the same TTL, so it reads one `stat` rather than paying for a
 * sweep of the whole directory on every fetch.
 */
export function handleStoredImageGet(id: string, bounds?: ImageStoreBounds): Response {
  if (!IMAGE_ID_RE.test(id)) {
    return jsonError(STATUS_NOT_FOUND, 'unknown image')
  }
  const path = join(storeDir(bounds), id)
  try {
    const ttlMs = bounds?.ttlMs ?? IMAGE_TTL_MS
    if (storeNow(bounds) - statSync(path).mtimeMs > ttlMs) {
      return jsonError(STATUS_NOT_FOUND, 'unknown image')
    }
    const bytes = readFileSync(path)
    const ext = extOf(id)
    return new Response(bytes, { headers: { [CONTENT_TYPE]: typeForExt(ext) } })
  } catch {
    return jsonError(STATUS_NOT_FOUND, 'unknown image')
  }
}

export function responseForImageGet(pathname: string): Response | undefined {
  const id = pathname.match(IMAGE_GET_RE)?.[1]
  return id === undefined ? undefined : handleStoredImageGet(id)
}

export interface RenderedImage {
  bytes: Uint8Array
  ext: string
}

export function replyImageData(
  images: RenderedImage[],
  format: ImageResponseFormat,
  req: Request,
  bounds?: ImageStoreBounds,
): { b64_json: string }[] | { url: string }[] {
  if (format === 'b64_json') {
    return images.map((image) => ({ b64_json: Buffer.from(image.bytes).toString('base64') }))
  }
  return images.map((image) => ({
    url: imagePublicUrl(req, storeRenderedImage(image.bytes, image.ext, bounds)),
  }))
}

async function fetchImages(
  base: string,
  httpClient: HttpClient,
  names: string[],
): Promise<RenderedImage[] | Refusal> {
  const images: RenderedImage[] = []
  for (const filename of names) {
    const view = await httpClient(`${base}/view?filename=${encodeURIComponent(filename)}`)
    if (!view.ok) {
      await discardBody(view)
      return {
        status: STATUS_BAD_GATEWAY,
        error: `comfy produced "${filename}" but would not serve it`,
      }
    }
    images.push({ bytes: new Uint8Array(await view.arrayBuffer()), ext: extOf(filename) })
  }
  return images
}

function finishedFilenames(text: string, promptId: string): string[] | undefined {
  const names = filenamesIn(comfyHistoryEntry(text, promptId))
  return names.length > 0 ? names : undefined
}

/** Waits for one render and returns its image bytes. */
export async function collectRenderedImages({
  base,
  httpClient,
  promptId,
  deadline,
  signal,
}: {
  base: string
  httpClient: HttpClient
  promptId: string
  deadline: number
  signal?: AbortSignal
}): Promise<RenderedImage[] | Refusal> {
  let names: string[] | undefined
  const finished = await pollUntil(
    async () => {
      const history = await httpClient(`${base}/history/${encodeURIComponent(promptId)}`)
      names = history.ok ? finishedFilenames(await history.text(), promptId) : undefined
      return names !== undefined
    },
    deadline,
    HISTORY_POLL_MS,
    signal,
  )
  if (signal?.aborted === true) {
    return {
      status: STATUS_BAD_GATEWAY,
      error: 'the caller hung up before the render finished',
    }
  }
  if (!finished || names === undefined) {
    return {
      status: STATUS_BAD_GATEWAY,
      error: "the render did not finish before this call's deadline",
    }
  }
  return fetchImages(base, httpClient, names)
}
