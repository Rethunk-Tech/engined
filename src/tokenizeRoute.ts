/**
 * `POST /engined/v1/tokenize` and `/engined/v1/detokenize`: a token count or
 * the inverse join, answered from the GGUF's own vocab (`bpeVocab.ts` /
 * `bpeTokenize.ts`) rather than by asking llama-server, which in router mode
 * has to load the model's weights just to count. Only reachable for a local
 * route whose vocab this door can read without a container -- `ggufPathFor`
 * is the same check `modelsMenu.ts` runs to decide whether to advertise these
 * paths in `serves`.
 */

import { stat } from 'node:fs/promises'
import { resolve as resolvePath } from 'node:path'
import { bpeDetokenize, bpeTokenIds } from './bpeTokenize.ts'
import { type BpeVocab, loadBpeVocab, UnsupportedVocabError } from './bpeVocab.ts'
import { resolveQualified } from './dispatch.ts'
import type { DoorContext } from './doorContext.ts'
import { readGgufMetadata } from './ggufMetadata.ts'
import {
  engineErrorStatus,
  jsonError,
  readModelBody,
  STATUS_BAD_REQUEST,
  STATUS_PAYLOAD_TOO_LARGE,
} from './http.ts'
import { errMessage } from './records.ts'
import { LOCAL_UPSTREAM, qualifiedSegments } from './routeAddress.ts'
import type { Config, ResolvedRoute } from './types.ts'

export const TOKENIZE_PATH = '/engined/v1/tokenize'
export const DETOKENIZE_PATH = '/engined/v1/detokenize'

/** Characters of `content` this verb will tokenize; past this the BPE scan is not worth the RAM. */
const TOKENIZE_CONTENT_LIMIT_MEBICHARS = 4
const KIBICHAR = 1024
const MEBICHAR = KIBICHAR * KIBICHAR
export const MAX_TOKENIZE_CONTENT_CHARS = TOKENIZE_CONTENT_LIMIT_MEBICHARS * MEBICHAR

/** The on-disk GGUF `route` points at, given that engine's `models_dir` -- `undefined` when the route is remote, has no `filename`, or `modelsDir` is unset. */
export function ggufPath(route: ResolvedRoute, modelsDir: string | undefined): string | undefined {
  if (
    route.upstream !== LOCAL_UPSTREAM ||
    route.filename === undefined ||
    modelsDir === undefined
  ) {
    return undefined
  }
  return resolvePath(modelsDir, route.filename)
}

/** The on-disk GGUF `route` points at, or `undefined` when it has none to read -- a remote route, or a local one with no `filename`/`models_dir`. */
function ggufPathFor(route: ResolvedRoute, config: Config): string | undefined {
  const engine = config.engines.find((e) => e.id === route.engine)
  return ggufPath(route, engine?.models_dir)
}

const SUPPORTED_TOKENIZER_MODEL = 'gpt2'

const tokenizeSupportCache = new Map<string, Promise<boolean>>()

/** `true` when `route`'s GGUF can be counted against without loading its weights -- `tokenizer.ggml.model`/`pre` only, memoised per path and mtime. */
export async function supportsVocabTokenize(
  route: ResolvedRoute,
  config: Config,
  {
    statFile = stat,
    readMeta = readGgufMetadata,
  }: {
    statFile?: (p: string) => Promise<{ mtimeMs: number }>
    readMeta?: (
      p: string,
    ) => Promise<{ tokenizerModel?: string | undefined; tokenizerPre?: string | undefined }>
  } = {},
): Promise<boolean> {
  const path = ggufPathFor(route, config)
  if (path === undefined) {
    return false
  }
  try {
    const { mtimeMs } = await statFile(path)
    const key = `${path}:${mtimeMs}`
    let cached = tokenizeSupportCache.get(key)
    if (cached === undefined) {
      cached = readMeta(path).then(
        (meta) =>
          meta.tokenizerModel === SUPPORTED_TOKENIZER_MODEL && meta.tokenizerPre !== undefined,
      )
      tokenizeSupportCache.set(key, cached)
      cached.catch(() => {
        tokenizeSupportCache.delete(key)
      })
    }
    return await cached
  } catch {
    return false
  }
}

async function vocabForModel(ctx: DoorContext, model: string): Promise<BpeVocab | Response> {
  const segments = qualifiedSegments(model)
  if (segments === undefined) {
    return jsonError(STATUS_BAD_REQUEST, `unknown model "${model}"`)
  }
  const config = ctx.getConfig()
  const resolved = resolveQualified(segments, { config, registry: ctx.registry })
  if (!resolved.ok) {
    return jsonError(STATUS_BAD_REQUEST, resolved.error)
  }
  const path = ggufPathFor(resolved.route, config)
  if (path === undefined) {
    return jsonError(STATUS_BAD_REQUEST, `"${model}" has no local GGUF to tokenize against`)
  }
  try {
    return await loadBpeVocab(path)
  } catch (err) {
    if (err instanceof UnsupportedVocabError) {
      return jsonError(STATUS_BAD_REQUEST, errMessage(err))
    }
    return jsonError(engineErrorStatus(err), errMessage(err))
  }
}

function vocabError(err: unknown): Response {
  if (err instanceof UnsupportedVocabError) {
    return jsonError(STATUS_BAD_REQUEST, errMessage(err))
  }
  return jsonError(engineErrorStatus(err), errMessage(err))
}

export async function handleTokenizeRoute(ctx: DoorContext, req: Request): Promise<Response> {
  const parsed = await readModelBody(req)
  if (parsed instanceof Response) {
    return parsed
  }
  const { body, model } = parsed
  const content = typeof body.content === 'string' ? body.content : undefined
  if (content === undefined) {
    return jsonError(STATUS_BAD_REQUEST, 'content is required')
  }
  if (content.length > MAX_TOKENIZE_CONTENT_CHARS) {
    return jsonError(STATUS_PAYLOAD_TOO_LARGE, 'content too large')
  }
  const vocab = await vocabForModel(ctx, model)
  if (vocab instanceof Response) {
    return vocab
  }
  try {
    const ids = bpeTokenIds(vocab, content)
    return Response.json({ tokens: ids.length })
  } catch (err) {
    return vocabError(err)
  }
}

function tokenIdsOf(body: Record<string, unknown>): number[] | Response {
  const raw = body.tokens
  if (!Array.isArray(raw)) {
    return jsonError(STATUS_BAD_REQUEST, 'tokens is required')
  }
  if (raw.length > MAX_TOKENIZE_CONTENT_CHARS) {
    return jsonError(STATUS_PAYLOAD_TOO_LARGE, 'tokens too large')
  }
  const ids: number[] = []
  for (const item of raw) {
    if (typeof item !== 'number' || !Number.isInteger(item)) {
      return jsonError(STATUS_BAD_REQUEST, 'tokens is required')
    }
    ids.push(item)
  }
  return ids
}

export async function handleDetokenizeRoute(ctx: DoorContext, req: Request): Promise<Response> {
  const parsed = await readModelBody(req)
  if (parsed instanceof Response) {
    return parsed
  }
  const { body, model } = parsed
  const ids = tokenIdsOf(body)
  if (ids instanceof Response) {
    return ids
  }
  const vocab = await vocabForModel(ctx, model)
  if (vocab instanceof Response) {
    return vocab
  }
  try {
    return Response.json({ content: bpeDetokenize(vocab, ids) })
  } catch (err) {
    return vocabError(err)
  }
}
