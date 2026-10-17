/** The `POST /engined/v1/engines/:id/<verb>` routes, so the door's router names them in one place. */
import { handleHold, handleRelease, handleStop, handleUnhold } from './control.ts'
import type { DoorContext } from './doorContext.ts'
import { jsonError, STATUS_NOT_FOUND } from './http.ts'
import { handleObtain } from './obtain.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

const VERB_RE = new RegExp(`^${ENGINED_ENGINES_PATH}/([^/]+)/(stop|release|hold|unhold|obtain)$`)

const UPSTREAM_REFRESH_RE = /^\/engined\/v1\/upstreams\/([^/]+)\/refresh$/

export function isEngineVerbPath(pathname: string): boolean {
  return VERB_RE.test(pathname) || UPSTREAM_REFRESH_RE.test(pathname)
}

/** `POST /engined/v1/upstreams/:id/refresh`: fetches that upstream's model list now and caches it. */
async function handleUpstreamRefresh(ctx: DoorContext, id: string): Promise<Response> {
  const upstream = ctx.getConfig().upstreams.find((u) => u.id === id)
  if (upstream === undefined) {
    return jsonError(STATUS_NOT_FOUND, `unknown upstream "${id}"`)
  }
  const lookup = await ctx.registry.inventory.refresh(upstream)
  return Response.json({ upstream: id, ids: lookup.ids.length, fetch_error: lookup.fetchError })
}

export function routeEngineVerb(
  ctx: DoorContext,
  req: Request,
  pathname: string,
): Response | Promise<Response> | undefined {
  const refresh = UPSTREAM_REFRESH_RE.exec(pathname)?.[1]
  if (refresh !== undefined) {
    return handleUpstreamRefresh(ctx, decodeURIComponent(refresh))
  }
  const match = VERB_RE.exec(pathname)
  const id = match?.[1]
  if (id === undefined) {
    return undefined
  }
  switch (match?.[2]) {
    case 'stop':
      return handleStop(ctx.registry, id)
    case 'release':
      return handleRelease(ctx.registry, id)
    case 'hold':
      return handleHold(ctx.registry, id, new URL(req.url))
    case 'unhold':
      return handleUnhold(ctx.registry, id)
    default:
      return handleObtain(ctx, req, id)
  }
}
