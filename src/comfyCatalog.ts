/**
 * What a running ComfyUI can render and with which weights, read from its own
 * `/object_info`. The engines listing must never start comfy or wait on it, so
 * this is a cache the queue poll refills while the container runs and the
 * listing only reads: no entry means "not known yet", and the listing leaves
 * the fields out.
 */

import { discardBody } from './http.ts'
import { isRecord, MS_PER_MINUTE, MS_PER_SECOND, parseRecord } from './records.ts'
import type { ComfyOutput } from './responses.ts'

export interface ComfyCatalog {
  output: ComfyOutput[]
  checkpoints: { image: string[]; video: string[] }
}

/** Long enough that the fan-out below is not a steady load on a busy render box, short enough that a model dropped into `models_dir` shows up while someone is still looking. */
const CATALOG_MAX_AGE_MS = 5 * MS_PER_MINUTE

/** Under the queue poll's own timeout: a comfy that stops answering fails one refresh rather than stacking them. */
const CATALOG_FETCH_TIMEOUT_MS = 10 * MS_PER_SECOND

/** Loader node and the input that lists its weights. ComfyUI offers no per-modality listing, so image and video weights arrive in the same lists. */
const WEIGHT_LOADERS: readonly { node: string; input: string }[] = [
  { node: 'CheckpointLoaderSimple', input: 'ckpt_name' },
  { node: 'UNETLoader', input: 'unet_name' },
]

/** A node class present only on an install that can save that modality; ComfyUI answers `{}` for a class it does not have. */
const OUTPUT_NODES: readonly { node: string; output: ComfyOutput }[] = [
  { node: 'SaveImage', output: 'image' },
  { node: 'SaveVideo', output: 'video' },
  { node: 'VHS_VideoCombine', output: 'video' },
]

/** Known video model families by file name, since the loader lists carry no modality. A name matching none is an image model, which is the wrong answer for a video file named after nothing here; the field is a best reading, not a guarantee. */
const VIDEO_NAME_RE = /(^|[^a-z])(wan|ltxv?|svd|mochi|cogvideo|animatediff|video)([^a-z]|$)/i

async function nodeInfo(base: string, node: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${base}/object_info/${node}`, {
    signal: AbortSignal.timeout(CATALOG_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) {
    await discardBody(res)
    return undefined
  }
  const body = parseRecord(await res.text())
  const info = body?.[node]
  return isRecord(info) ? info : undefined
}

/** The option list of a combo input, in either shape ComfyUI has sent it: `[[names], {...}]`, or `["COMBO", {options: [names]}]`. */
function comboOptions(spec: unknown): string[] {
  if (!Array.isArray(spec)) {
    return []
  }
  const [first, extra] = spec
  let options: unknown
  if (Array.isArray(first)) {
    options = first
  } else if (isRecord(extra)) {
    options = extra.options
  }
  return Array.isArray(options) ? options.filter((o): o is string => typeof o === 'string') : []
}

function weightNames(info: Record<string, unknown> | undefined, input: string): string[] {
  const { input: inputs } = info ?? {}
  const required = isRecord(inputs) ? inputs.required : undefined
  return isRecord(required) ? comboOptions(required[input]) : []
}

/** Rejects when comfy answered nothing usable, so the caller keeps "not known" rather than caching an empty claim. */
export async function fetchComfyCatalog(base: string): Promise<ComfyCatalog> {
  const loaders = await Promise.all(WEIGHT_LOADERS.map((l) => nodeInfo(base, l.node)))
  const savers = await Promise.all(OUTPUT_NODES.map((o) => nodeInfo(base, o.node)))
  const output = OUTPUT_NODES.filter((_o, i) => savers[i] !== undefined)
    .map((o) => o.output)
    .filter((o, i, all) => all.indexOf(o) === i)
  if (output.length === 0) {
    throw new Error('comfy reported no output nodes')
  }
  const names = [
    ...new Set(WEIGHT_LOADERS.flatMap((l, i) => weightNames(loaders[i], l.input))),
  ].sort((a, b) => a.localeCompare(b))
  return {
    output,
    checkpoints: {
      image: names.filter((n) => !VIDEO_NAME_RE.test(n)),
      video: names.filter((n) => VIDEO_NAME_RE.test(n)),
    },
  }
}

export class ComfyCatalogCache {
  private readonly entries = new Map<string, { at: number; catalog: ComfyCatalog }>()
  /** Engines whose refresh has not settled; another is skipped rather than stacked. */
  private readonly refreshing = new Set<string>()

  private readonly fetchCatalog: (base: string) => Promise<ComfyCatalog>

  constructor(fetchCatalog: (base: string) => Promise<ComfyCatalog> = fetchComfyCatalog) {
    this.fetchCatalog = fetchCatalog
  }

  get(id: string): ComfyCatalog | undefined {
    return this.entries.get(id)?.catalog
  }

  /** The answer belongs to one run of the container, so a stop or start drops it. */
  forget(id: string): void {
    this.entries.delete(id)
  }

  /** Never throws and is not meant to be awaited by anything serving a request; a failure keeps whatever was cached. */
  async refresh(id: string, base: string): Promise<void> {
    const cached = this.entries.get(id)
    if (this.refreshing.has(id) || (cached && Date.now() - cached.at < CATALOG_MAX_AGE_MS)) {
      return
    }
    this.refreshing.add(id)
    try {
      this.entries.set(id, { at: Date.now(), catalog: await this.fetchCatalog(base) })
    } catch {
      // comfy not answering yet is the normal first minute of a start; the next poll asks again.
    } finally {
      this.refreshing.delete(id)
    }
  }
}
