/**
 * `POST /history {delete, uploads}`: erase a caller's own finished Comfy
 * prompt and the temp files this origin left behind.
 */

import { COMFY_TEMP_DIR, safeComfyTempName } from './comfy.ts'
import { comfyKey, liveBinding, saveComfyBindings } from './comfyBindings.ts'
import { type ComfyProxy, tempUploadKey } from './comfyProxy.ts'
import { COMFY_GATED_CALL_TIMEOUT_MS } from './comfyQueue.ts'
import { dockerExec, NAME_PREFIX } from './docker.ts'
import { removeContainerFile } from './dockerCommands.ts'
import {
  CONTENT_TYPE,
  JSON_CONTENT_TYPE,
  jsonError,
  readJsonBody,
  STATUS_BAD_REQUEST,
} from './http.ts'

const HISTORY_DELETE_KEYS = new Set(['delete', 'uploads'])

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/**
 * Mediated: only prompt ids this door bound for this (engine, origin), and
 * only names this origin uploaded as `type=temp`, ever reach the container.
 * Unbound ids and unknown names are dropped, not refused -- the answer names
 * what was actually erased.
 */
export async function proxyComfyHistoryDelete(
  { ctx, engineId, origin, base, httpClient }: ComfyProxy,
  req: Request,
): Promise<Response> {
  const body = await readJsonBody(req)
  if (body instanceof Response) {
    return body
  }
  if (
    Object.keys(body).some((key) => !HISTORY_DELETE_KEYS.has(key)) ||
    (body.delete !== undefined && !isStringArray(body.delete)) ||
    (body.uploads !== undefined && !isStringArray(body.uploads))
  ) {
    return jsonError(STATUS_BAD_REQUEST, 'expected {"delete": string[], "uploads": string[]}')
  }
  const requestedIds: string[] = isStringArray(body.delete) ? body.delete : []
  const requestedUploads: string[] = isStringArray(body.uploads) ? body.uploads : []
  const kept: string[] = []
  const tempViews = new Set<string>()
  for (const promptId of requestedIds) {
    const bound = liveBinding(ctx, comfyKey(engineId, origin, promptId))
    if (bound === undefined) {
      continue
    }
    kept.push(promptId)
    for (const view of bound.views) {
      if (view.type === 'temp' && safeComfyTempName(view.filename)) {
        tempViews.add(view.filename)
      }
    }
  }

  if (kept.length > 0) {
    await httpClient(`${base}/history`, {
      method: 'POST',
      headers: { [CONTENT_TYPE]: JSON_CONTENT_TYPE },
      body: JSON.stringify({ delete: kept }),
      signal: AbortSignal.timeout(COMFY_GATED_CALL_TIMEOUT_MS),
    })
    for (const promptId of kept) {
      ctx.comfyBindings.delete(comfyKey(engineId, origin, promptId))
    }
    saveComfyBindings(ctx.comfyBindings)
  }

  const recorded = ctx.comfyTempUploads.get(tempUploadKey(engineId, origin))
  const erasedUploads: string[] = []
  for (const name of requestedUploads) {
    if (recorded?.has(name) === true && safeComfyTempName(name)) {
      erasedUploads.push(name)
      recorded.delete(name)
    }
  }

  const exec = ctx.registryOpts.exec ?? dockerExec
  const container = `${NAME_PREFIX}${engineId}`
  for (const name of new Set([...tempViews, ...erasedUploads])) {
    await removeContainerFile(exec, container, `${COMFY_TEMP_DIR}/${name}`)
  }
  return Response.json({ deleted: kept, uploads: erasedUploads })
}
