import { LOCAL_UPSTREAM } from './routeAddress.ts'
import type { ResolvedRoute } from './types.ts'

/** This engine's routes that resolve to THIS box's own upstream. */
export function localRoutesOf(routes: readonly ResolvedRoute[], engineId: string): ResolvedRoute[] {
  return routes.filter((r) => r.engine === engineId && r.upstream === LOCAL_UPSTREAM)
}
