/**
 * `POST /engined/v1/tokenize`: a token count for a route's model, answered
 * from the GGUF's own vocab (`bpeVocab.ts`/`bpeTokenize.ts`) rather than by
 * asking llama-server, which in router mode has to load the model's weights
 * just to count. Only reachable for a local route whose vocab this door can
 * read without a container -- `ggufPathFor` is the same check `modelsMenu.ts`
 * runs to decide whether to advertise this path in `serves`.
 */

import { resolve as resolvePath } from 'node:path'
import { bpeTokenIds } from './bpeTokenize.ts'
import { loadBpeVocab, UnsupportedVocabError } from './bpeVocab.ts'
import { resolveQualified } from './dispatch.ts'
import type { DoorContext } from './doorContext.ts'
import { jsonError, readJsonBody, STATUS_BAD_GATEWAY, STATUS_BAD_REQUEST } from './http.ts'
import { errMessage } from './records.ts'
import { LOCAL_UPSTREAM, qualifiedSegments } from './routeAddress.ts'
import type { Config, ResolvedRoute } from './types.ts'

export const TOKENIZE_PATH = '/engined/v1/tokenize'

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

/** `true` when `route`'s GGUF can be counted against without loading its weights -- cached after the first read, same as the route itself. */
export async function supportsVocabTokenize(
  route: ResolvedRoute,
  config: Config,
): Promise<boolean> {
  const path = ggufPathFor(route, config)
  if (path === undefined) {
    return false
  }
  try {
    await loadBpeVocab(path)
    return true
  } catch {
    return false
  }
}

export async function handleTokenizeRoute(ctx: DoorContext, req: Request): Promise<Response> {
  const body = await readJsonBody(req)
  if (body instanceof Response) {
    return body
  }
  const model = typeof body.model === 'string' ? body.model : ''
  if (model === '') {
    return jsonError(STATUS_BAD_REQUEST, 'model is required')
  }
  const content = typeof body.content === 'string' ? body.content : undefined
  if (content === undefined) {
    return jsonError(STATUS_BAD_REQUEST, 'content is required')
  }
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
    const vocab = await loadBpeVocab(path)
    const ids = bpeTokenIds(vocab, content)
    return Response.json({ tokens: ids.length })
  } catch (err) {
    if (err instanceof UnsupportedVocabError) {
      return jsonError(STATUS_BAD_REQUEST, errMessage(err))
    }
    return jsonError(STATUS_BAD_GATEWAY, errMessage(err))
  }
}
