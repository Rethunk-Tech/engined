import { comfyKey, liveBinding } from './comfyBindings.ts'
import { type ComfyProxy, jsonForward, withComfySlot } from './comfyProxy.ts'
import { queuedPromptIds, readComfyQueue } from './comfyQueue.ts'
import {
  CONTENT_TYPE,
  type HttpClient,
  JSON_CONTENT_TYPE,
  jsonError,
  readJsonBody,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
  STATUS_NOT_FOUND,
} from './http.ts'

/**
 * `POST /cancel {prompt_id}` -- the door's own verb for stopping a prompt it
 * bound, and the whole reason `/interrupt` is never forwarded on its own.
 * comfy can only interrupt "whatever is running", carrying no id to scope
 * it; the door supplies the scoping the container lacks by reading the queue
 * itself -- never handing that ledger out -- and interrupting only once it
 * has confirmed the running prompt is the caller's own. A prompt the queue
 * read found still pending is dropped from the queue instead, which needs no
 * interrupt as long as it really was still pending, and one that has already
 * finished is reported as such rather than interrupting whatever inherited
 * the GPU after it. Either way the answer reports what the container did:
 * a refusal comes back as comfy's own status, never as a cancel this door
 * did not perform.
 *
 * Two windows sit in this sequence, and each is closed by a different means.
 *
 * An unscoped `/interrupt` could otherwise stop whichever job inherited the
 * GPU from a prompt that finished between the queue read and the interrupt.
 * `POST /prompt` holds submissions until the container has drained, so
 * nothing is ever queued behind the running prompt to inherit anything: the
 * interrupt either stops the caller's own prompt or arrives late and stops
 * nothing at all.
 *
 * comfy answers 200 to a delete that removed nothing, so a pending prompt
 * that starts rendering between the queue read and the queue delete would be
 * reported "pending" while it holds the GPU. The delete is confirmed against
 * a second queue read instead, and a prompt that slipped into `queue_running`
 * is interrupted and reported as what it became.
 *
 * The gate is held across the whole sequence, so a submission cannot enter
 * the container between this read and the act on it.
 */
export async function proxyComfyCancel(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body instanceof Response) {
    return body
  }
  const promptId = body.prompt_id
  if (typeof promptId !== 'string') {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"prompt_id": string}')
  }
  if (liveBinding(ctx, comfyKey(engineId, origin, promptId)) === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown prompt_id "${promptId}"`)
  }
  return withComfySlot(ctx, engineId, async () => {
    const queue = await readComfyQueue(base, httpClient)
    if (queue === undefined) {
      return jsonError(STATUS_BAD_GATEWAY, 'comfy queue could not be read')
    }
    if (queuedPromptIds(queue.queue_running).includes(promptId)) {
      return interruptComfyRunning(base, httpClient, promptId)
    }
    if (queuedPromptIds(queue.queue_pending).includes(promptId)) {
      const dropped = await httpClient(`${base}/queue`, {
        method: 'POST',
        headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
        body: JSON.stringify({ delete: [promptId] }),
      })
      if (!dropped.ok) {
        return jsonError(
          STATUS_BAD_GATEWAY,
          `comfy refused to drop "${promptId}" from its queue (http ${dropped.status})`,
        )
      }
      // comfy answers 200 whether or not the delete removed anything, so the
      // reply it earns is decided by what the queue says afterwards, never by
      // that status. A prompt that started rendering in the window between the
      // read above and this delete is still holding the GPU and is stopped
      // here rather than reported dropped.
      const after = await readComfyQueue(base, httpClient)
      if (after === undefined) {
        return jsonError(STATUS_BAD_GATEWAY, 'comfy queue could not be read')
      }
      if (queuedPromptIds(after.queue_running).includes(promptId)) {
        return interruptComfyRunning(base, httpClient, promptId)
      }
      return Response.json({ prompt_id: promptId, cancelled: 'pending' })
    }
    return Response.json({ prompt_id: promptId, cancelled: 'finished' })
  })
}

/** The interrupt, and the one reply it earns. Safe to send unscoped because the submission gate keeps the container's pending queue empty: nothing can have inherited the GPU from the prompt named here. */
async function interruptComfyRunning(
  base: string,
  httpClient: HttpClient,
  promptId: string,
): Promise<Response> {
  const interrupted = await httpClient(`${base}/interrupt`, { method: 'POST' })
  if (!interrupted.ok) {
    return jsonError(
      STATUS_BAD_GATEWAY,
      `comfy refused to interrupt "${promptId}" (http ${interrupted.status})`,
    )
  }
  return Response.json({ prompt_id: promptId, cancelled: 'running' })
}

/** `POST /queue {delete:[promptId]}`, mediated: every id in the request must be one this door itself bound via `/prompt`, or nothing is forwarded -- the bare form is the container's global queue ledger, and even the delete form must not let a caller cancel a job it never submitted. */
export async function proxyComfyQueueDelete(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body instanceof Response) {
    return body
  }
  if (!(Array.isArray(body.delete) && body.delete.every((id) => typeof id === 'string'))) {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"delete": string[]}')
  }
  const ids = body.delete as string[]
  if (!ids.every((id) => liveBinding(ctx, comfyKey(engineId, origin, id)) !== undefined)) {
    return jsonError(STATUS_NOT_FOUND, 'one or more prompt ids are not known to this door')
  }
  const res = await httpClient(`${base}/queue`, {
    method: 'POST',
    headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
    body: JSON.stringify(body),
  })
  return jsonForward(res, await res.text())
}
