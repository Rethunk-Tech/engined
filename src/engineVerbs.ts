/** The `POST /engined/v1/engines/:id/<verb>` routes, so the door's router names them in one place. */
import { handleHold, handleRelease, handleStop, handleUnhold } from './control.ts'
import type { DoorContext } from './doorContext.ts'
import { handleObtain } from './obtain.ts'
import { ENGINED_ENGINES_PATH } from './usage.ts'

const VERB_RE = new RegExp(`^${ENGINED_ENGINES_PATH}/([^/]+)/(stop|release|hold|unhold|obtain)$`)

export function isEngineVerbPath(pathname: string): boolean {
  return VERB_RE.test(pathname)
}

export function routeEngineVerb(
  ctx: DoorContext,
  req: Request,
  pathname: string,
): Response | Promise<Response> | undefined {
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
