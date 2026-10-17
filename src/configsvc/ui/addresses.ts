/** Every address a caller can put in `model`, and whether a chain hop would be served. */
import { qualifiedSegments } from '../../routeAddress.ts'
import { type Doc, routeAddress, type Table } from './model.ts'

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

/** The routes a hop's address can reach, by the segment count rules of `routeForHop`. */
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
  if (seg.length === 2) {
    return engine.filter((r) => r.model === b || (r.model === undefined && upstreamOf(r) === b))
  }
  return engine.filter((r) => r.model === c && upstreamOf(r) === b)
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

/** Every route address a hop can be chosen from; a wildcard route is a catalog, not one model to try. */
export const hopChoices = (doc: Doc, upstreamOf: UpstreamOf): string[] =>
  addressBook(doc, upstreamOf)
    .filter((row) => row.kind === 'route' && !row.address.endsWith('/*'))
    .map((row) => row.address)
