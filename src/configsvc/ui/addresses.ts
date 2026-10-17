/** Every address a caller can put in `model`, and whether a chain hop would be served. */
import { encodeAddressSegment, qualifiedSegments, WILDCARD_MODEL } from '../../routeAddress.ts'
import { type Doc, isTable, routeAddress, type Table } from './model.ts'

export type HopState = 'ok' | 'dropped' | 'unresolved'

type UpstreamOf = (route: Table) => string | null

const byId = (tables: Table[], id: unknown): Table | undefined => tables.find((t) => t.id === id)

function routeOff(doc: Doc, route: Table, upstreamOf: UpstreamOf): boolean {
  const up = upstreamOf(route)
  return (
    route.disable === true ||
    byId(doc.engine, route.engine)?.disable === true ||
    (up !== null && byId(doc.upstream, up)?.disable === true)
  )
}

/**
 * The routes a hop's address can reach, by the segment count rules of `routeForHop`. An
 * undeclared model on an engine (and upstream) with an enabled wildcard resolves to that
 * wildcard, as engined parses it: a catalog id served once the inventory holds it.
 */
export function candidates(doc: Doc, hop: string, upstreamOf: UpstreamOf): Table[] {
  const seg = qualifiedSegments(hop)
  if (seg === undefined) {
    return []
  }
  const [a, b, c] = seg
  if (seg.length === 1) {
    return doc.route.filter((r) => r.model === a)
  }
  const engine = doc.route.filter((r) => r.engine === a)
  const declared =
    seg.length === 2
      ? engine.filter((r) => r.model === b || (r.model === undefined && upstreamOf(r) === b))
      : engine.filter((r) => r.model === c && upstreamOf(r) === b)
  if (declared.length > 0) {
    return declared
  }
  return engine.filter(
    (r) =>
      r.model === WILDCARD_MODEL &&
      (seg.length === 2 || upstreamOf(r) === b) &&
      !routeOff(doc, r, upstreamOf),
  )
}

/** `dropped` is a hop whose every candidate route is disabled: the chain skips it silently. */
export function hopState(doc: Doc, hop: string, upstreamOf: UpstreamOf): HopState {
  const found = candidates(doc, hop, upstreamOf)
  if (found.length === 0) {
    return 'unresolved'
  }
  return found.every((r) => routeOff(doc, r, upstreamOf)) ? 'dropped' : 'ok'
}

export interface AddressRow {
  address: string
  kind: 'route' | 'chain'
  disabled: boolean
}

/** The addresses to hand a consumer: each route as the door lists it, and each chain by its id. */
export function addressBook(doc: Doc, upstreamOf: UpstreamOf): AddressRow[] {
  const routes = doc.route.flatMap((route): AddressRow[] => {
    const address = routeAddress(doc, route)
    return address === undefined
      ? []
      : [{ address, kind: 'route', disabled: routeOff(doc, route, upstreamOf) }]
  })
  const chains = doc.chain.flatMap((chain): AddressRow[] =>
    typeof chain.id === 'string'
      ? [{ address: `@/${chain.id}`, kind: 'chain', disabled: chain.disable === true }]
      : [],
  )
  return [...routes, ...chains].sort((x, y) => x.address.localeCompare(y.address))
}

/**
 * Every address a hop can be chosen from: each declared route, and each id in the cached
 * catalog of an enabled wildcard route. The wildcard itself is a catalog, not one model to try.
 */
export function hopChoices(
  doc: Doc,
  upstreamOf: UpstreamOf,
  inventories: Record<string, unknown>,
): string[] {
  const declared = addressBook(doc, upstreamOf)
    .filter((row) => row.kind === 'route' && !row.address.endsWith('/*'))
    .map((row) => row.address)
  const catalog = doc.route.flatMap((r) => {
    const up = upstreamOf(r)
    if (r.model !== WILDCARD_MODEL || up === null || routeOff(doc, r, upstreamOf)) {
      return []
    }
    const cached = inventories[up]
    const ids = isTable(cached) && Array.isArray(cached.ids) ? cached.ids : []
    const named = new Set(
      doc.route.filter((d) => d.engine === r.engine && upstreamOf(d) === up).map((d) => d.model),
    )
    return ids.flatMap((id) => {
      const segment = typeof id === 'string' ? encodeAddressSegment(id) : undefined
      return segment === undefined || named.has(id)
        ? []
        : [`@/${String(r.engine)}/${up}/${segment}`]
    })
  })
  return [...new Set([...declared, ...catalog])]
}
