import {
  COMFY_KEY_SEP,
  comfyKey,
  expired,
  liveBinding,
  saveComfyBindings,
} from './comfyBindings.ts'
import { queuedPromptIds, readComfyQueue } from './comfyQueue.ts'
import type { DoorContext } from './doorContext.ts'
import {
  CONTENT_TYPE,
  type HttpClient,
  imageTooLarge,
  JSON_CONTENT_TYPE,
  jsonError,
  MAX_IMAGE_UPLOAD_BYTES,
  OCTET_STREAM_CONTENT_TYPE,
  readCappedForm,
  readCappedText,
  STATUS_BAD_REQUEST,
  STATUS_CLIENT_CLOSED,
  STATUS_NOT_FOUND,
  STATUS_UNAVAILABLE,
} from './http.ts'
import { isRecord, MS_PER_SECOND, parseRecord, pollUntil } from './records.ts'

const COMFY_PROXY_RE = /^\/engined\/v1\/comfy\/([^/]+)\/([^/]+)\/(.+)$/
export const COMFY_WS_SUFFIX = 'ws'
/** Rewrites an `http(s)://` base to its `ws(s)://` twin for the comfy websocket bridge. */
export const HTTP_SCHEME_RE = /^http/
/** Enough of a UUID to keep two same-second uploads of one filename apart in comfy's shared input directory. */
const COMFY_UPLOAD_PREFIX_LEN = 12

/** `original` with a short UUID prefix, so two uploads of the same filename in one second do not collide in comfy's shared input directory. */
export function namespacedComfyName(original: string): string {
  return `${crypto.randomUUID().replace(/-/g, '').slice(0, COMFY_UPLOAD_PREFIX_LEN)}-${original}`
}

/** The three path segments `COMFY_PROXY_RE` captures. */
export interface ComfyMatch {
  engineSeg: string
  upstreamSeg: string
  rest: string
}

export function matchComfyPath(pathname: string): ComfyMatch | undefined {
  const m: RegExpExecArray | null = COMFY_PROXY_RE.exec(pathname)
  return m
    ? { engineSeg: m[1] as string, upstreamSeg: m[2] as string, rest: m[3] as string }
    : undefined
}

/** One resolved comfy engine plus the client every forwarded call goes through. */
export interface ComfyProxy {
  ctx: DoorContext
  engineId: string
  /** Who submitted the prompt: half the binding key, so no rekey is needed the day a call arrives from somewhere other than this box. */
  origin: string
  base: string
  httpClient: HttpClient
}

/** `ServerWebSocket.data` for one comfy relay connection: where to reach the real container, the door-assigned clientId comfy filters frames by, and the live upstream socket once `open` has dialed it. */
export interface ComfyWsData {
  upstreamUrl: string
  clientId: string
  upstream?: WebSocket
}

/** `Bun.serve`'s own return type, parameterized on the one websocket payload this door ever mounts -- `bindDualFamily`'s real listeners and `Door.fetch`'s optional second argument must agree on it, or `server.upgrade`'s `data` stops typechecking. */
export type EnginedServer = ReturnType<typeof Bun.serve<ComfyWsData>>

/** Every caller reaching this door reached it directly, so far; a federated hop will supply its own origin instead of this constant. */
export const COMFY_LOCAL_ORIGIN = 'local'

interface ComfyTarget {
  engineId: string
  /** `http://host:port`, this container's own address -- never handed to a caller, only used to build the door's own forwarded request. */
  base: string
}

/** The engine+upstream segments of a comfy proxy path, resolved to a running comfy container -- `undefined` for anything that is not one: an unknown engine, a non-comfy kind, a route that does not exist, or a container that is not up. */
export function resolveComfyTarget(
  ctx: DoorContext,
  engineSeg: string,
  upstreamSeg: string,
): ComfyTarget | undefined {
  const config = ctx.getConfig()
  if (!config.engines.some((e) => e.id === engineSeg)) {
    return undefined
  }
  if (ctx.registry.get(engineSeg)?.kind !== 'comfy') {
    return undefined
  }
  const hasRoute = config.routes.some(
    (r) =>
      !r.disabled && r.engine === engineSeg && r.upstream === upstreamSeg && r.model === undefined,
  )
  if (!hasRoute) {
    return undefined
  }
  const privateUrl = ctx.lifecycle.getStatus(engineSeg).private_url
  return privateUrl === null ? undefined : { engineId: engineSeg, base: `http://${privateUrl}` }
}

export function noSuchComfyEngine(engineSeg: string, upstreamSeg: string): Response {
  return jsonError(
    STATUS_UNAVAILABLE,
    `no running comfy engine at "@/${engineSeg}/${upstreamSeg}" -- start it first`,
  )
}

/** comfy's own status and body handed straight back, re-declared as JSON: the body is already read, so nothing but the door's own content type is imposed on it. */
export function jsonForward(res: Response, text: string): Response {
  return new Response(text, { status: res.status, headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE } })
}

/** `GET /object_info/{nodeType}` and `GET /system_stats`: a static node schema and the container's own stats, nobody's data either way. */
export async function forwardComfyGet(
  base: string,
  rest: string,
  search: string,
  httpClient: HttpClient,
): Promise<Response> {
  const res = await httpClient(`${base}/${rest}${search}`)
  return new Response(res.body, {
    status: res.status,
    headers: { [CONTENT_TYPE]: res.headers.get(CONTENT_TYPE) ?? JSON_CONTENT_TYPE },
  })
}

/** The `prompt_id` comfy answered `/prompt` with -- `undefined` for a body that is not JSON or carries none, which binds nothing. The caller still gets comfy's real body and status back either way. */
export function comfyPromptId(text: string): string | undefined {
  const id = parseRecord(text)?.prompt_id
  return typeof id === 'string' ? id : undefined
}

/** How often a held submission re-asks the container whether it has drained. A render is seconds to minutes, so a tighter poll buys nothing and costs a round trip. */
const COMFY_DRAIN_POLL_MS = 500

/**
 * How long a submission waits for the container to drain when the engine does
 * not say. Not a render-length estimate: it is the ceiling that stops a wedged
 * container from parking every later submission on this door forever. A real
 * render that legitimately exceeds it answers 503 naming the engine and the
 * key to raise, which is recoverable; an unbounded wait is not.
 */
const COMFY_DRAIN_TIMEOUT_MS = 15 * 60 * MS_PER_SECOND

/** This engine's own ceiling, or the default above. */
function comfyDrainTimeoutMs(ctx: DoorContext, engineId: string): number {
  const seconds = ctx.getConfig().engines.find((e) => e.id === engineId)?.drain_timeout_seconds
  return seconds === undefined ? COMFY_DRAIN_TIMEOUT_MS : seconds * MS_PER_SECOND
}

/**
 * Runs `fn` with this engine's submission gate held, so the read-then-act
 * sequences that decide what the container is holding cannot interleave.
 *
 * The chain is kept alive across a rejection deliberately: a handler that
 * throws must not reject every later holder of the same gate.
 */
export function withComfySlot<T>(
  ctx: DoorContext,
  engineId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const settled = () => undefined
  const run = (ctx.comfySlots.get(engineId) ?? Promise.resolve()).then(fn, fn)
  ctx.comfySlots.set(engineId, run.then(settled, settled))
  return run
}

/** Whether the container is holding nothing at all -- neither running nor queued. */
async function comfyDrained(base: string, httpClient: HttpClient): Promise<boolean> {
  const queue = await readComfyQueue(base, httpClient)
  if (queue === undefined) {
    return false
  }
  return (
    queuedPromptIds(queue.queue_running).length === 0 &&
    queuedPromptIds(queue.queue_pending).length === 0
  )
}

/** `POST /prompt`, forwarded, with the returned `prompt_id` bound to this engine's proxy state -- the only thing that makes the `/history` and `/queue` mediation below possible. */
export async function proxyComfyPrompt(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readCappedText(req)
  if (body instanceof Response) {
    return body
  }
  return submitComfyPrompt({
    ctx,
    engineId,
    base,
    httpClient,
    body,
    onAnswered: (res, text) => {
      const promptId = res.ok ? comfyPromptId(text) : undefined
      if (promptId !== undefined) {
        ctx.comfyBindings.set(comfyKey(engineId, origin, promptId), {
          at: Date.now(),
          views: [],
        })
        saveComfyBindings(ctx.comfyBindings)
      }
      return jsonForward(res, text)
    },
    signal: req.signal,
  })
}

/**
 * Forwards one `/prompt` with this engine's submission gate held, and hands
 * `onAnswered` whatever the container said.
 *
 * Shared by the mediated proxy and the OpenAI image verb, so both go through
 * the one gate: it is per engine and not per surface, and a second submission
 * path that did not take it would put a prompt in the container beside a
 * running one and quietly reopen the race `POST /cancel` depends on being
 * closed.
 *
 * Compare-and-swap rather than one long hold: the gate is taken only for the
 * drain check and the forward that follows it, so a `/cancel` -- which is how
 * a caller ends the render this is waiting on -- is never queued behind a
 * submission waiting for that same render to end.
 */
export interface ComfyPromptSubmission {
  ctx: DoorContext
  engineId: string
  base: string
  httpClient: HttpClient
  body: string
  onAnswered: (res: Response, text: string) => Response
  signal?: AbortSignal
}

export async function submitComfyPrompt({
  ctx,
  engineId,
  base,
  httpClient,
  body,
  onAnswered,
  signal,
}: ComfyPromptSubmission): Promise<Response> {
  const timeoutMs = comfyDrainTimeoutMs(ctx, engineId)
  let forwarded: Response | undefined
  // `pollUntil`'s order is what makes the smallest legal budget still buy a
  // submission: attempt, then consult the deadline. Checking it first would
  // 503 an idle container that would have accepted immediately.
  await pollUntil(
    async () => {
      forwarded = await withComfySlot(ctx, engineId, async () => {
        if (signal?.aborted === true || !(await comfyDrained(base, httpClient))) {
          return
        }
        const res = await httpClient(`${base}/prompt`, {
          method: 'POST',
          headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
          body,
        })
        return onAnswered(res, await res.text())
      })
      return forwarded !== undefined
    },
    Date.now() + timeoutMs,
    COMFY_DRAIN_POLL_MS,
    signal,
  )
  if (forwarded !== undefined) {
    return forwarded
  }
  if (signal?.aborted === true) {
    return jsonError(STATUS_CLIENT_CLOSED, 'the caller hung up before the prompt was submitted')
  }
  return jsonError(
    STATUS_UNAVAILABLE,
    `"@/${engineId}" has not been free for ${timeoutMs / MS_PER_SECOND}s and this door submits one prompt at a time -- cancel the running prompt, restart the engine, or raise its "drain_timeout_seconds"`,
  )
}

/** `POST /upload/image`, forwarded with the stored filename namespaced -- comfy's input directory is shared across every caller, and two callers uploading "reference.png" the same second must not silently overwrite one another. */
export async function proxyComfyUpload(
  base: string,
  req: Request,
  httpClient: HttpClient,
): Promise<Response> {
  const incoming = await readCappedForm(req, MAX_IMAGE_UPLOAD_BYTES, imageTooLarge)
  if (incoming instanceof Response) {
    return incoming
  }
  if (incoming === undefined) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with an "image" part')
  }
  const image = incoming.get('image')
  if (!(image instanceof Blob)) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with an "image" part')
  }
  const originalName = image instanceof File ? image.name : 'upload.png'
  const namespaced = namespacedComfyName(originalName)
  const outgoing = new FormData()
  // Bun honours `FormData.append`'s third argument for a File as well as a
  // Blob; a File already named for storage keeps `File.name` and that
  // filename the same string.
  outgoing.append('image', new File([image], namespaced, { type: image.type }))
  for (const [key, value] of incoming.entries()) {
    if (key !== 'image' && typeof value === 'string') {
      outgoing.append(key, value)
    }
  }
  const res = await httpClient(`${base}/upload/image`, { method: 'POST', body: outgoing })
  return jsonForward(res, await res.text())
}

/**
 * Whether some prompt this origin submitted to this engine actually
 * produced `filename`. Scoped to the pair, never engine-wide: another
 * origin's `/history` read must not make its outputs viewable here.
 */
// ponytail: linear over the table, which COMFY_BINDINGS_MAX holds at a
// thousand entries; index by filename only if that cap is ever raised.
function comfyViewBound(
  ctx: DoorContext,
  engineId: string,
  origin: string,
  filename: string,
): { filename: string; subfolder: string; type: string } | undefined {
  const prefix = `${engineId}${COMFY_KEY_SEP}${origin}${COMFY_KEY_SEP}`
  const now = Date.now()
  for (const [key, bound] of ctx.comfyBindings) {
    if (!key.startsWith(prefix) || expired(bound.at, now)) {
      continue
    }
    const view = bound.views.find((v) => v.filename === filename)
    if (view !== undefined) {
      return view
    }
  }
  return undefined
}

/** The one refusal `GET /view` ever answers with, for a filename this door never saw a completed job produce -- byte-identical whether that filename does not exist at all or simply was never surfaced to this caller, because this door checks its own known-filenames set and never comfy's disk either way. */
function comfyViewRefused(): Response {
  return jsonError(STATUS_NOT_FOUND, 'unknown filename')
}

/**
 * `GET /view`, mediated: only a filename that a completed `/history` read
 * actually surfaced for THIS engine ever reaches comfy. The path-traversal
 * guard this delivery needs today, and the caller-ownership guard the
 * door's design is heading toward -- comfy's output directory is shared,
 * and a caller-supplied filename must never become a URL on its own say-so.
 */
export async function proxyComfyView(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  params: URLSearchParams,
): Promise<Response> {
  const filename = params.get('filename')
  const view = filename === null ? undefined : comfyViewBound(ctx, engineId, origin, filename)
  if (view === undefined) {
    return comfyViewRefused()
  }
  const q = new URLSearchParams()
  q.set('filename', view.filename)
  q.set('subfolder', view.subfolder)
  q.set('type', view.type)
  const res = await httpClient(`${base}/view?${q.toString()}`)
  return new Response(res.body, {
    status: res.status,
    headers: { [CONTENT_TYPE]: res.headers.get(CONTENT_TYPE) ?? OCTET_STREAM_CONTENT_TYPE },
  })
}

type ComfyHistoryEntry = Record<string, unknown>

/** The media kinds a comfy node can emit an output filename under. */
const COMFY_MEDIA_KEYS = ['images', 'gifs', 'video']

/** Every output filename one node emitted, across every media kind comfy can name one under. */
function viewsInOutput(output: unknown): { filename: string; subfolder: string; type: string }[] {
  if (!isRecord(output)) {
    return []
  }
  const views: { filename: string; subfolder: string; type: string }[] = []
  for (const key of COMFY_MEDIA_KEYS) {
    const media = output[key]
    for (const item of Array.isArray(media) ? media : []) {
      if (isRecord(item) && typeof item.filename === 'string') {
        views.push({
          filename: item.filename,
          subfolder: typeof item.subfolder === 'string' ? item.subfolder : '',
          type: typeof item.type === 'string' ? item.type : '',
        })
      }
    }
  }
  return views
}

/**
 * Every output filename a history entry names, across every node. `outputs`
 * is comfy's node-id table, so anything that is not one -- an array
 * included -- names nothing, and `/view` refuses what it never bound.
 */
export function filenamesIn(entry: ComfyHistoryEntry | undefined): string[] {
  return viewsIn(entry).map((v) => v.filename)
}

function viewsIn(
  entry: ComfyHistoryEntry | undefined,
): { filename: string; subfolder: string; type: string }[] {
  const outputs = entry?.outputs
  return Object.values(isRecord(outputs) ? outputs : {}).flatMap(viewsInOutput)
}

/** This prompt's entry in comfy's `/history` answer -- `undefined` for a body that is not the shape expected, which teaches nothing new. */
export function comfyHistoryEntry(text: string, promptId: string): ComfyHistoryEntry | undefined {
  const entry = parseRecord(text)?.[promptId]
  return isRecord(entry) ? entry : undefined
}

/**
 * `GET /history/{promptId}`, mediated: refused outright for a `promptId`
 * this door never bound via `/prompt` -- the bare form is the container's
 * entire global ledger, and even the scoped form would otherwise answer
 * with any other caller's completed job for a real id it did not itself
 * submit. A successful read seeds `views` with whatever this job
 * actually produced, which is what makes `/view` servable at all.
 */
export async function proxyComfyHistory(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  promptId: string,
): Promise<Response> {
  const bound = liveBinding(ctx, comfyKey(engineId, origin, promptId))
  if (bound === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown prompt_id "${promptId}"`)
  }
  const res = await httpClient(`${base}/history/${encodeURIComponent(promptId)}`)
  const text = await res.text()
  if (res.ok) {
    // A client polling a running prompt reads the same entry over and over,
    // so the whole table is only rewritten when this read taught it something.
    const found = viewsIn(comfyHistoryEntry(text, promptId))
    let changed = false
    for (const view of found) {
      if (
        !bound.views.some(
          (v) =>
            v.filename === view.filename && v.subfolder === view.subfolder && v.type === view.type,
        )
      ) {
        bound.views.push(view)
        changed = true
      }
    }
    if (changed) {
      saveComfyBindings(ctx.comfyBindings)
    }
  }
  return jsonForward(res, text)
}
