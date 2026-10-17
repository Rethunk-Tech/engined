/** Which route fields apply, and the cross-route cases the form must explain. Advisory: the server's validate decides. */
import { WILDCARD_FORBIDDEN_KEYS } from '../../configKeys.ts'
import { LOCAL_UPSTREAM, WILDCARD_MODEL } from '../../routeAddress.ts'
import type { Disposition, EngineKind } from '../../types.ts'
import { KIND_TRAITS } from '../../types.ts'
import type { Table } from './model.ts'

export type RouteField =
  | 'filename'
  | 'role'
  | 'vision'
  | 'vision_bridge'
  | 'wire_model'
  | 'translate'
  | 'fim'
  | 'keep_resident'
  | 'slot_long_threshold'
  | 'args'

export interface FieldPlan {
  disposition: Disposition
  /** Why a hidden or disabled field is so, shown beside it. */
  reason?: string
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)

/**
 * The rules, in the parser's own order: a wildcard hides its forbidden keys; `vision` only
 * exists on role = vision and `vision_bridge` only on role = chat; the local-file keys are
 * forbidden when the route has no model, is proxied away from this box, or sits on an
 * engine with no models_dir, and otherwise follow the kind's table.
 */
export function routePlan(input: {
  kind: EngineKind | undefined
  engine: Table
  route: Table
  /** The upstream the route resolves to (declared or defaulted). */
  upstream: string | null
}): Record<RouteField, FieldPlan> {
  const { kind, engine, route, upstream } = input
  const rules = kind === undefined ? undefined : KIND_TRAITS[kind].localFile
  const wildcard = route.model === WILDCARD_MODEL
  const role = str(route.role)
  const localReason =
    route.model === undefined
      ? 'there is no model whose weights they could describe'
      : upstream === LOCAL_UPSTREAM
        ? engine.models_dir === undefined
          ? `engine "${String(engine.id)}" has no local model store`
          : undefined
        : 'a route proxied elsewhere has no local file to describe'
  const local = (field: 'filename' | 'role' | 'translate' | 'fim' | 'args'): FieldPlan => {
    if (localReason !== undefined && field !== 'args') {
      return { disposition: 'forbidden', reason: localReason }
    }
    return { disposition: rules?.[field] ?? 'allowed' }
  }
  const plan: Record<RouteField, FieldPlan> = {
    filename: local('filename'),
    role: local('role'),
    translate: local('translate'),
    fim: local('fim'),
    args: kind === 'comfy' ? { disposition: 'allowed' } : local('args'),
    keep_resident: {
      disposition: role === undefined ? 'forbidden' : 'allowed',
      reason: 'needs a role',
    },
    slot_long_threshold: { disposition: 'allowed' },
    wire_model: { disposition: 'allowed' },
    vision:
      role === 'vision'
        ? { disposition: 'required' }
        : { disposition: 'forbidden', reason: 'only role = vision' },
    vision_bridge:
      role === 'chat'
        ? { disposition: 'allowed' }
        : { disposition: 'forbidden', reason: 'only role = chat' },
  }
  if (wildcard) {
    for (const key of WILDCARD_FORBIDDEN_KEYS) {
      plan[key] = { disposition: 'forbidden', reason: 'a wildcard route expands a whole catalog' }
    }
  }
  return plan
}

/** The other local route on the same engine and role holding keep_resident, which blocks this one (configRouteValidate.ts `validateKeepResident`). */
export function keepResidentHolder(routes: readonly Table[], route: Table): Table | undefined {
  const role = str(route.role)
  if (role === undefined) {
    return undefined
  }
  return routes.find(
    (other) =>
      other !== route &&
      other.engine === route.engine &&
      other.role === role &&
      other.keep_resident === true &&
      (str(other.upstream) ?? LOCAL_UPSTREAM) === LOCAL_UPSTREAM,
  )
}

const CTX_SIZE_KEYS = ['ctx-size', 'ctx_size', 'c']

/** The window a route asks for, from its args then its engine's. */
export function ctxSizeOf(route: Table, engine: Table): number | undefined {
  for (const args of [route.args, engine.args]) {
    if (typeof args === 'object' && args !== null) {
      for (const key of CTX_SIZE_KEYS) {
        const v = (args as Table)[key]
        if (typeof v === 'number') {
          return v
        }
      }
    }
  }
  return undefined
}

/** A warning when the route's ctx-size exceeds what the GGUF was trained for; `parallel` slots share one pool, so it is compared whole. */
export function ctxWarning(
  ctx: number | undefined,
  trained: number | undefined,
): string | undefined {
  return ctx !== undefined && trained !== undefined && ctx > trained
    ? `ctx-size ${ctx} is above the model's trained context ${trained}`
    : undefined
}
