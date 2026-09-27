/**
 * `[[route]] model` sentinel that expands from a remote provider catalog.
 * It is never a served address: `@/engine/*` is a 400, not a dispatchable id.
 */
export const WILDCARD_MODEL = '*'

/** Reserved id of THIS box's own upstream — the one `config` refuses to let an operator name a remote. */
export const LOCAL_UPSTREAM = 'local'

/**
 * The qualified address form an operator or caller writes: `@/model` (one
 * segment), `@/engine/model` (two -- or `@/engine/upstream` for a modelless
 * engine), or `@/engine/upstream/model` (three, fully explicit). One regex
 * with two nested optional groups, so a three-segment match is only ever
 * reached through a present second segment -- never a shape a second regex
 * has to re-derive. Segment count alone decides the reading; that is
 * `qualifiedSegments`'s job, not this pattern's.
 */
const QUALIFIED_MODEL_RE = /^@\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/

/** `QUALIFIED_MODEL_RE`'s match, as the one, two or three non-empty segments it captured. `undefined` when `model` is not a qualified `@/...` address at all. */
export function qualifiedSegments(model: string): string[] | undefined {
  const match: RegExpExecArray | null = QUALIFIED_MODEL_RE.exec(model)
  if (!match) {
    return undefined
  }
  return [match[1], match[2], match[3]].filter((seg): seg is string => seg !== undefined)
}

/**
 * A route on one engine, by model id -- and, when `upstream` is given, on
 * that one upstream specifically. A modelless route (`model` absent) never
 * matches: `model` here is always a real string, and `undefined === model`
 * is never true.
 */
function findModelOnEngine<T extends { engine: string; model?: string; upstream: string | null }>(
  routes: readonly T[],
  engineId: string,
  model: string,
  upstream?: string,
): T | undefined {
  return routes.find(
    (r) =>
      r.engine === engineId &&
      r.model === model &&
      (upstream === undefined || r.upstream === upstream),
  )
}

/**
 * The one route a resolved `@/engine/[upstream/]model` hop names. Two
 * segments default the upstream the way the dispatcher does -- ambient, then
 * this box's own `local` -- never whichever matching route was declared
 * first, which would run an ambient dispatch on a keyed upstream. A disabled
 * route is configured but not served, so it is never the resolved hop. A
 * lookup this cannot express -- a modelless route has no model segment to
 * match on -- excludes the same set itself rather than serving a wider one.
 */
export function routeForHop<
  T extends { engine: string; model?: string; upstream: string | null; disabled?: boolean },
>(routes: readonly T[], engineId: string, model: string, upstream?: string): T | undefined {
  const served = routes.filter((r) => r.disabled !== true)
  if (upstream !== undefined) {
    return findModelOnEngine(served, engineId, model, upstream)
  }
  const matches = served.filter((r) => r.engine === engineId && r.model === model)
  return matches.length === 1 ? matches[0] : pickDefaultUpstream(matches)
}

/** Among routes sharing one `(engine, model)`, the default upstream: ambient first, then this box's own `local`. Anything else is a real ambiguity the caller must break with the three-segment form. */
function pickDefaultUpstream<T extends { upstream: string | null }>(
  matches: readonly T[],
): T | undefined {
  return (
    matches.find((r) => r.upstream === null) ?? matches.find((r) => r.upstream === LOCAL_UPSTREAM)
  )
}

/**
 * Sibling routes claiming this route's `(engine, model)` pair among `routes`
 * -- the ambiguity the three-segment address form exists to break. A disabled
 * route is never listed, so it is never a sibling either.
 */
export function siblingRouteCount<T extends { engine: string; model?: string; disabled?: boolean }>(
  route: Pick<T, 'engine' | 'model'>,
  routes: readonly T[],
): number {
  if (route.model === undefined) {
    return 1
  }
  return routes.filter(
    (r) => r.disabled !== true && r.engine === route.engine && r.model === route.model,
  ).length
}

/**
 * The addressable `@/...` string for this route: the two-segment form when
 * it is the only route claiming this `(engine, model)` pair (`siblingCount`),
 * else the fully explicit three-segment form -- two sibling routes on one
 * engine sharing a model (different upstreams) would otherwise be the same
 * address. The one function `GET /openai/v1/models` (`modelsMenu.ts`) and
 * every answering-route header (`answeringHeaders`) both build their address
 * from, so a caller can always put a header's value straight into `model` and
 * get back the same route the menu named.
 */
export function addressForRoute<
  T extends { engine: string; model?: string; upstream: string | null },
>(route: T, siblingCount: number): string {
  if (route.model === undefined) {
    return `@/${route.engine}/${route.upstream}`
  }
  if (siblingCount > 1 && route.upstream !== null) {
    return `@/${route.engine}/${route.upstream}/${route.model}`
  }
  return `@/${route.engine}/${route.model}`
}
