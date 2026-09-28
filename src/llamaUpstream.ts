/**
 * The llama router's side of the wire: every request it makes of the running
 * llama-server, the residency faults it reads back out of a failed answer,
 * and the pipe a streamed answer is handed to its caller through.
 */

import {
  CONTENT_TYPE,
  discardBody,
  ENGINE_ERROR_CHARS,
  type HttpClient,
  JSON_CONTENT_TYPE,
  STATUS_BAD_REQUEST,
  STATUS_INTERNAL_SERVER_ERROR,
} from './http.ts'
import { isRecord, MS_PER_SECOND, parseRecord, pollUntil } from './records.ts'

/**
 * The message bodies llama-server SENDS: the statuses they ride on are the
 * registry's in `http.ts`, only the wording is llama-server's own, so only
 * the wording is named here. This one is llama-server's answer once its own
 * residency disagrees with this router's.
 */
const MODEL_NOT_LOADED_MESSAGE = 'model is not loaded'
/** The router proxying to a child it has already begun stopping: accepted the unload, has not finished it. */
const PROXY_UNREACHABLE_MESSAGE = 'Could not establish connection'

/** Not an upstream status like the group above: the bytes this door writes while a cold swap is still waiting. */
const WARMING_COMMENT = new TextEncoder().encode(': warming\n\n')

/** One entry of llama-server's `GET /v1/models`, in the only shape this router reads. */
interface ListedModel {
  id: string
  status?: { value?: string }
}

/**
 * The consumer-driven half of `fetchStreamed`: chunks piped from the already
 * open upstream reader, and `release` called on whichever terminus arrives --
 * drain, error, the client cancelling, or the client stalling. The lease is
 * entirely `release`'s business.
 *
 * A stall is a chunk left unread for `stallMs`: a client that holds the
 * socket open but stops reading reaches no other terminus, and the door
 * listens with no idle timeout, so without this its lease is held forever.
 */
export function pipeUpstream(
  reader: ReadableStreamDefaultReader<Uint8Array> | undefined,
  emitWarming: boolean,
  release: () => void,
  stallMs: number,
): ReadableStream<Uint8Array> {
  let stall: ReturnType<typeof setTimeout> | undefined
  const settle = () => {
    clearTimeout(stall)
    release()
  }
  const push = (controller: ReadableStreamDefaultController<Uint8Array>, chunk: Uint8Array) => {
    controller.enqueue(chunk)
    // A full queue is a chunk the client has not taken; a read clears this in `pull`.
    if ((controller.desiredSize ?? 0) <= 0) {
      stall = setTimeout(() => {
        const err = new Error(`client stalled: read nothing for ${stallMs / MS_PER_SECOND}s`)
        controller.error(err)
        settle()
        reader?.cancel(err).catch(() => undefined)
      }, stallMs)
    }
  }
  return new ReadableStream<Uint8Array>({
    start: (controller) => {
      if (emitWarming) {
        push(controller, WARMING_COMMENT)
      }
      if (!reader) {
        controller.close()
        settle()
      }
    },
    pull: async (controller) => {
      clearTimeout(stall)
      if (!reader) {
        return
      }
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          settle()
          return
        }
        push(controller, value)
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error(String(err)))
        settle()
      }
    },
    cancel: (reason) => {
      settle()
      // A client disconnecting mid-stream cancels this ReadableStream, but
      // that alone leaves the upstream llama-server connection open (and its
      // reader pending) until GC -- cancel it too so the socket closes now,
      // not eventually.
      reader?.cancel(reason).catch(() => undefined)
    },
  })
}

export interface LlamaUpstreamOptions {
  engineId: string
  lifecycle: {
    getStatus: (engineId: string) => { private_url: string | null }
    reconcile: (engineId: string) => Promise<{ state: string }>
  }
  httpClient: HttpClient
  readyTimeoutS: number
  pollIntervalMs: number
  /** The router's own start, shared with every caller in flight; a fetch that finds the container gone restarts through it. */
  ensureStarted: () => Promise<void>
}

export class LlamaUpstream {
  private readonly engineId: string
  private readonly lifecycle: LlamaUpstreamOptions['lifecycle']
  private readonly httpClient: HttpClient
  private readonly readyTimeoutS: number
  private readonly pollIntervalMs: number
  private readonly ensureStarted: () => Promise<void>

  constructor(opts: LlamaUpstreamOptions) {
    this.engineId = opts.engineId
    this.lifecycle = opts.lifecycle
    this.httpClient = opts.httpClient
    this.readyTimeoutS = opts.readyTimeoutS
    this.pollIntervalMs = opts.pollIntervalMs
    this.ensureStarted = opts.ensureStarted
  }

  /** `private_url` from `getStatus` carries no scheme -- `docker.ts`'s own readiness poll prepends one too. */
  private baseUrl(): string {
    const url = this.lifecycle.getStatus(this.engineId).private_url
    if (url === null) {
      throw new Error(`${this.engineId}: no private_url; container is not running`)
    }
    return `http://${url}`
  }

  /**
   * A refused unload is the one failure a swap must not ride past: the caller
   * would load the incoming GGUF beside a ~25 GB one the child still holds,
   * and `admitAfterSwap` would record the newcomer as the resident either way.
   * Throwing fails only the request that asked for the swap and leaves the
   * role's belief matching what the child actually holds.
   */
  async unload(modelId: string): Promise<void> {
    const res = await this.fetchOnce('/models/unload', {
      method: 'POST',
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ model: modelId }),
    })
    if (!res.ok) {
      throw new Error(
        `${modelId}: unload failed: ${res.status} ${(await res.text()).slice(0, ENGINE_ERROR_CHARS)}`,
      )
    }
    await discardBody(res)
  }

  /**
   * `/models/load` is asynchronous, but not the way it looks from the docs,
   * and its own response is not the ready signal either -- both probed live
   * against b10354. It never returns `{"status":"loaded"}`: a not-yet-
   * resident model answers `{"success":true}` (accepted) and a call for an
   * already-resident one 400s `{"error":{"message":"model is already
   * running"}}`. That 400 looked like readiness and is not: on a 23 GB GGUF
   * it fired ~0.25s after the trigger call, while the child was still on
   * `text_model` stage 0 of its load, and a request proxied at that point
   * 503'd. The real signal is `GET /v1/models`'s per-model
   * `data[].status.value`, which transitions `unloaded -> loading -> loaded`
   * and only reaches `loaded` once the child is actually able to serve --
   * confirmed against the same GGUF, ~8s cold. Bounded by `readyTimeoutS` --
   * the same per-engine budget the container readiness poll uses, since both
   * are "wait for the engine to become able to serve." A load that never
   * reaches `loaded` within it throws, so the caller's lease request rejects
   * instead of wedging the role's pump forever.
   */
  async loadAndWait(modelId: string): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutS * MS_PER_SECOND
    const triggerRes = await this.fetchOnce('/models/load', {
      method: 'POST',
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ model: modelId }),
    })
    if (triggerRes.status === STATUS_BAD_REQUEST) {
      const text = await triggerRes.text()
      const error = parseRecord(text)?.error
      const message = isRecord(error) && typeof error.message === 'string' ? error.message : text
      if (message !== 'model is already running') {
        throw new Error(`${modelId}: load failed: ${message.slice(0, ENGINE_ERROR_CHARS) || '400'}`)
      }
      // Already running by another caller's race -- fall through to confirm
      // real readiness via /v1/models rather than trusting this 400 alone.
    } else if (triggerRes.ok) {
      await discardBody(triggerRes)
    } else {
      throw new Error(
        `${modelId}: load failed: ${triggerRes.status} ${(await triggerRes.text()).slice(0, ENGINE_ERROR_CHARS)}`,
      )
    }
    const resident = await pollUntil(
      async () => (await this.modelStatus(modelId)) === 'loaded',
      deadline,
      this.pollIntervalMs,
    )
    if (!resident) {
      throw new Error(
        `${modelId}: did not become resident within readyTimeoutS=${this.readyTimeoutS}s`,
      )
    }
  }

  /** The engine's own view of what it holds. Both callers below read it fresh; neither caches. */
  async listedModels(): Promise<ListedModel[]> {
    const res = await this.fetchOnce('/v1/models', { method: 'GET' })
    const body = (await res.json()) as { data?: ListedModel[] }
    return body.data ?? []
  }

  /** One model's readiness field: `unloaded | loading | loaded`, from `GET /v1/models`. */
  private async modelStatus(modelId: string): Promise<string | undefined> {
    const listed = await this.listedModels()
    return listed.find((m) => m.id === modelId)?.status?.value
  }

  /**
   * A container killed from outside engined leaves `state: running` and a
   * `private_url` nothing listens on. Nothing else ever asks docker about an
   * `openai-http` engine between starts -- `DockerLifecycle.start` returns
   * early while it believes the engine is up -- so without this the router
   * proxies to a dead port for the rest of the process's life, and only a
   * restart clears it.
   *
   * Reconciling here costs a `docker inspect` only once a request has already
   * failed; doing it before every request would tax every healthy one. Docker
   * decides, so a genuine upstream error against a live container rethrows
   * untouched rather than provoking a pointless restart.
   *
   * The retry re-sends `init` as given, which every caller builds with a
   * string body (`main.ts` stringifies the JSON it forwards). A streamed
   * request body would already be consumed and must not be retried here.
   */
  async fetchOnce(path: string, init: RequestInit): Promise<Response> {
    try {
      return await this.httpClient(`${this.baseUrl()}${path}`, init)
    } catch (err) {
      // A cancelled request is the door's own timeout budget expiring, not a
      // container that went away: retrying it would outlive the budget that
      // just fired, and turn a chain's 503 into a late 200.
      if (init.signal?.aborted === true) {
        throw err
      }
      const reconciled = await this.lifecycle.reconcile(this.engineId)
      if (reconciled.state === 'running') {
        throw err
      }
      await this.ensureStarted()
      return await this.httpClient(`${this.baseUrl()}${path}`, init)
    }
  }

  /**
   * `activeModelId` records what this router last commanded, not what the
   * engine actually holds, and the two come apart whenever anything unloads
   * behind it -- an operator poking `/models/unload`, or a router-side
   * eviction. The lease layer then sees its own belief satisfied, skips the
   * swap, and proxies to a child that answers 400 "model is not loaded" for
   * the rest of the process's life: the role never reloads, because nothing
   * in the request path ever asks the engine who is resident.
   *
   * So the 400 is the trigger to reconcile, exactly as a transport failure is
   * the trigger to reconcile the container in `fetchOnce`. Both pay
   * only once a request has already failed rather than taxing healthy ones,
   * and both re-send `init` as given -- safe because every caller builds it
   * with a string body, and a consumed stream must never be retried here.
   *
   * `loadAndWait` is the whole repair: the belief is already correct about
   * WHICH model belongs here, so nothing needs unloading first, and its
   * `/v1/models` poll is what makes the retry wait for real readiness
   * instead of racing the child's load.
   */
  async fetch(path: string, init: RequestInit, modelId?: string): Promise<Response> {
    const res = await this.fetchOnce(path, init)
    if (modelId === undefined) {
      return res
    }
    const fault = await this.residencyFault(res)
    if (fault === 'none') {
      return res
    }
    // An unreachable child is one the router is still advertising as loaded,
    // so reloading first would be a no-op and the retry would land on the same
    // dying process. Waiting for the router to admit the instance is gone is
    // what makes the reload real.
    if (fault === 'unreachable') {
      await this.awaitInstanceGone(modelId)
    }
    await this.loadAndWait(modelId)
    return await this.fetchOnce(path, init)
  }

  /**
   * Both faults mean "the child that should serve this is not there", and
   * both are reached only after a request has already failed. They are kept
   * apart because they need different repairs, and because neither may be
   * widened into "retry any 5xx": re-sending a request a live child genuinely
   * failed turns one bad answer into two. Reads a clone so the caller still
   * owns an unconsumed body on every path.
   */
  private async residencyFault(res: Response): Promise<'none' | 'not-loaded' | 'unreachable'> {
    if (res.ok) {
      return 'none'
    }
    let body: string
    try {
      body = await res.clone().text()
    } catch {
      return 'none'
    }
    // The router writes this one as plain text, not as its JSON error shape.
    if (res.status === STATUS_INTERNAL_SERVER_ERROR && body.includes(PROXY_UNREACHABLE_MESSAGE)) {
      return 'unreachable'
    }
    const error = parseRecord(body)?.error
    return isRecord(error) && error.message === MODEL_NOT_LOADED_MESSAGE ? 'not-loaded' : 'none'
  }

  /**
   * Bounded by the same `readyTimeoutS` every other "wait for the engine to be
   * able to serve" uses. Giving up returns rather than throws: the reload and
   * its own poll follow, and they are better placed to fail with a real reason
   * than a timeout here would be.
   */
  private async awaitInstanceGone(modelId: string): Promise<void> {
    await pollUntil(
      async () => (await this.modelStatus(modelId)) !== 'loaded',
      Date.now() + this.readyTimeoutS * MS_PER_SECOND,
      this.pollIntervalMs,
    )
  }
}
