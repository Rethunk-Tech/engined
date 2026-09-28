/**
 * The image-edit endpoint: a multipart upload, its mask, and the ComfyUI
 * workflow that redraws the parts the mask names. Separate from generation
 * because the request arrives as a form rather than JSON and carries pixels.
 */

import { namespacedComfyName } from './comfyProxy.ts'
import type { DoorContext } from './doorContext.ts'
import {
  declaredOverLimit,
  ENGINE_ERROR_CHARS,
  type HttpClient,
  imageTooLarge,
  jsonError,
  MAX_IMAGE_UPLOAD_BYTES,
  STATUS_BAD_GATEWAY,
  STATUS_BAD_REQUEST,
} from './http.ts'
import { parseImageResponseFormat, type Refusal } from './imageStore.ts'
import { commonValues, imageRoute, MAX_N, renderWith, SEED_MAX, workflowPathFor } from './images.ts'
import { parseRecord } from './records.ts'
import { CONTENT_ENDPOINT_IMAGE_EDITS } from './routeServes.ts'

/**
 * The default an img2img caller gets when they say nothing.
 *
 * 0.9, not the 0.75 this shipped with, because 0.75 was picked by convention
 * and measured wrong. Against Chroma1-HD through this door, one 512x512 image
 * of a red cube and the prompt "a deep blue cube on a white table":
 *
 *   denoise 0.6   -- cube still red, prompt had no visible effect
 *   denoise 0.75  -- cube still red, same
 *   denoise 0.9   -- blue cube, composition still recognisably the input's
 *
 * A caller who sends a prompt expects it to do something, so the default has
 * to be a value where it does. Subtlety is the value a caller lowers it to,
 * which is the direction that fails safe: a weak edit is obvious, while a
 * prompt silently ignored looks like the door dropped it.
 *
 * The ladder is this model's. A different checkpoint may honour a prompt at a
 * lower denoise, and 0.8-0.85 is simply unmeasured here rather than known to
 * be too low.
 */
const DEFAULT_DENOISE = 0.9

interface EditRequest {
  prompt: string
  negative: string
  n: number
  seed: number
  /** How much of the input the sampler discards: 1.0 would keep none of it, which is the other verb. */
  denoise: number
  image: Blob
}

/** What `Request.formData()` resolves to; Bun types it apart from the global `FormData` an outgoing form is built with. */
type RequestForm = Awaited<ReturnType<Request['formData']>>

/** One numeric multipart field, or the 400 naming it. A form field is a string, so the whole point is refusing what does not parse rather than letting `Number()` produce a NaN nothing checks. */
function numberField(form: RequestForm, key: string): number | undefined | Response {
  const raw = form.get(key)
  if (raw === null) {
    return undefined
  }
  const value = typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : jsonError(STATUS_BAD_REQUEST, `"${key}" must be a number`)
}

/** The `image` part, or the 400 for a form that carries none, an empty one, or one too large to hold in memory. */
function editImage(form: RequestForm): Blob | Response {
  const image = form.get('image')
  if (!(image instanceof Blob) || image.size === 0) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with an "image" part')
  }
  if (image.size > MAX_IMAGE_UPLOAD_BYTES) {
    return imageTooLarge(image.size)
  }
  return image
}

/** The multipart fields the edits verb reads, or the 400 that says which one is wrong. */
function parseEditRequest(form: RequestForm): EditRequest | Response {
  const image = editImage(form)
  if (image instanceof Response) {
    return image
  }
  const rawPrompt = form.get('prompt')
  const prompt = typeof rawPrompt === 'string' ? rawPrompt.trim() : ''
  if (prompt === '') {
    return jsonError(STATUS_BAD_REQUEST, '"prompt" is required and must be a non-empty string')
  }
  const n = numberField(form, 'n')
  if (n instanceof Response) {
    return n
  }
  if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > MAX_N)) {
    return jsonError(STATUS_BAD_REQUEST, `"n" must be a whole number from 1 to ${MAX_N}`)
  }
  const seed = numberField(form, 'seed')
  if (seed instanceof Response) {
    return seed
  }
  const denoise = numberField(form, 'denoise')
  if (denoise instanceof Response) {
    return denoise
  }
  // 0 would answer with the image it was handed, which is a request the door
  // can satisfy without a GPU and a caller never means. 1.0 keeps none of the
  // input, which is what /images/generations already is.
  if (denoise !== undefined && (denoise <= 0 || denoise > 1)) {
    return jsonError(STATUS_BAD_REQUEST, '"denoise" must be greater than 0 and at most 1')
  }
  const negative = form.get('negative_prompt')
  return {
    prompt,
    negative: typeof negative === 'string' ? negative : '',
    n: n ?? 1,
    seed: seed ?? Math.floor(Math.random() * SEED_MAX),
    denoise: denoise ?? DEFAULT_DENOISE,
    image,
  }
}

/**
 * Puts the caller's image inside the container's own input directory and
 * answers with the name a `LoadImage` node can reach it by. A container reads
 * only what was handed to it, so a path from the caller would name nothing --
 * the upload is what makes the graph's `${image}` mean anything.
 */
async function uploadInputImage(
  base: string,
  httpClient: HttpClient,
  image: Blob,
): Promise<string | Refusal> {
  const form = new FormData()
  const original = image instanceof File ? image.name : 'upload.png'
  const namespaced = namespacedComfyName(original)
  form.append('image', new File([image], namespaced, { type: image.type }))
  const res = await httpClient(`${base}/upload/image`, { method: 'POST', body: form })
  const text = await res.text()
  const record = res.ok ? parseRecord(text) : undefined
  const name = record?.name
  if (typeof name !== 'string') {
    return {
      status: STATUS_BAD_GATEWAY,
      error: `comfy would not accept the uploaded image: ${text.slice(0, ENGINE_ERROR_CHARS)}`,
    }
  }
  const subfolder = typeof record?.subfolder === 'string' ? record.subfolder : ''
  return subfolder === '' ? name : `${subfolder}/${name}`
}

/**
 * `POST /openai/v1/images/edits`: the same render with the caller's own image
 * as the starting latent. Multipart rather than JSON, because the image is
 * the request -- base64 in a JSON body would be a third of it again in
 * transfer, held twice in memory to decode.
 *
 * No `size`: the input's own dimensions are the output's. Scaling here would
 * silently resize what a caller handed over, and a caller who wants another
 * size can send another image.
 */
export async function handleImageEdit(
  ctx: DoorContext,
  req: Request,
  signal?: AbortSignal,
): Promise<Response> {
  const declared = declaredOverLimit(req, MAX_IMAGE_UPLOAD_BYTES)
  if (declared !== undefined) {
    return imageTooLarge(declared)
  }
  const form = await req.formData().catch(() => undefined)
  if (form === undefined) {
    return jsonError(STATUS_BAD_REQUEST, 'expected a multipart form with an "image" part')
  }
  const rawModel = form.get('model')
  const target = imageRoute(
    ctx,
    typeof rawModel === 'string' ? rawModel : undefined,
    CONTENT_ENDPOINT_IMAGE_EDITS,
  )
  if (target instanceof Response) {
    return target
  }
  const request = parseEditRequest(form)
  if (request instanceof Response) {
    return request
  }
  const path = workflowPathFor(ctx, target.route.engine, 'images_edit_workflow')
  if (path instanceof Response) {
    return path
  }
  const format = parseImageResponseFormat(form.get('response_format'))
  if (format instanceof Response) {
    return format
  }
  return await renderWith(ctx, {
    route: target.route,
    rawModel: typeof rawModel === 'string' ? rawModel : undefined,
    workflowPath: path,
    n: request.n,
    format,
    request: req,
    plan: async (base, httpClient) => {
      const image = await uploadInputImage(base, httpClient, request.image)
      if (typeof image !== 'string') {
        return image
      }
      return (index: number) => ({
        ...commonValues(request, target.checkpoints, index),
        image,
        denoise: request.denoise,
      })
    },
    signal,
  })
}
